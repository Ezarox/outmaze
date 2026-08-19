"use strict";

const fs = require("node:fs");
const path = require("node:path");
require("../../ai-core.js");
const engine = global.AICore;
const {
  MODEL_VERSION,
  candidateFeatures,
  createState,
  cloneState,
  createModel,
  serializeModel,
  predict,
  legalCandidates,
  applyPlacement
} = require("./sequential-policy.js");

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, rawValue = "true"] = argument.slice(2).split("=");
    values[key] = rawValue;
  }
  return values;
}

function readRecords(files) {
  const records = [];
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) records.push(JSON.parse(line));
  }
  return records.sort((a, b) => a.seed.localeCompare(b.seed));
}

function cellKey(cell) {
  return `${cell.x},${cell.y}`;
}

function shuffled(values, rng) {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function chooseNegatives(candidates, excluded, positive, count, rng) {
  const available = candidates.filter((cell) => !excluded.has(cellKey(cell)));
  const selected = [];
  if (positive && available.length) {
    const nearby = available
      .slice()
      .sort(
        (a, b) =>
          Math.abs(a.x - positive.x) + Math.abs(a.y - positive.y) -
            (Math.abs(b.x - positive.x) + Math.abs(b.y - positive.y)) ||
          a.y - b.y ||
          a.x - b.x
      );
    selected.push(nearby[0]);
  }
  const selectedKeys = new Set(selected.map(cellKey));
  for (const cell of shuffled(available, rng)) {
    if (selected.length >= count) break;
    if (selectedKeys.has(cellKey(cell))) continue;
    selected.push(cell);
    selectedKeys.add(cellKey(cell));
  }
  return selected.slice(0, count);
}

function pathDistance(grid) {
  const path = engine.computePath(grid);
  let distance = 0;
  for (let index = 1; index < path.length; index++) {
    distance += Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y);
  }
  return distance;
}

function chooseCausalTarget(state, actionType, remaining) {
  let best = null;
  for (const cell of remaining) {
    const candidate = cloneState(state);
    if (!applyPlacement(candidate, actionType, cell)) continue;
    const routeDistance = pathDistance(candidate.grid);
    const candidateKey = cellKey(cell);
    if (!best || routeDistance > best.routeDistance + 1e-9 || (Math.abs(routeDistance - best.routeDistance) <= 1e-9 && candidateKey < best.key)) {
      best = { cell, routeDistance, key: candidateKey };
    }
  }
  return best?.cell || remaining.slice().sort((a, b) => cellKey(a).localeCompare(cellKey(b)))[0];
}

function addSequenceExamples(examples, record, solution, negativeRatio, sequenceName, trainingSeed, sampleWeight) {
  const state = createState(record);
  const rng = engine.mulberry32(engine.hashSeed(`${MODEL_VERSION}:${trainingSeed}:${record.seed}:${sequenceName}`));
  for (const actionType of ["wall", "single"]) {
    const targets = actionType === "wall" ? solution.walls || [] : solution.singles || [];
    const remaining = targets.map((cell) => ({ ...cell }));
    const targetKeys = new Set(targets.map(cellKey));
    for (let index = 0; index < targets.length; index++) {
      const positive = chooseCausalTarget(state, actionType, remaining);
      remaining.splice(remaining.findIndex((cell) => cellKey(cell) === cellKey(positive)), 1);
      examples.push({ features: candidateFeatures(state, actionType, positive.x, positive.y), label: 1, weight: sampleWeight });
      examples.push({ features: candidateFeatures(state, `stop-${actionType}`), label: 0, weight: 0.45 * sampleWeight });
      const negatives = chooseNegatives(legalCandidates(state, actionType), targetKeys, positive, negativeRatio, rng);
      for (const negative of negatives) {
        examples.push({ features: candidateFeatures(state, actionType, negative.x, negative.y), label: 0, weight: sampleWeight });
      }
      if (!applyPlacement(state, actionType, positive)) {
        throw new Error(`Teacher sequence became illegal for ${record.seed} (${actionType} ${positive.x},${positive.y}).`);
      }
    }
    examples.push({ features: candidateFeatures(state, `stop-${actionType}`), label: 1, weight: 3 * sampleWeight });
  }

  if (solution.special) {
    const positive = solution.special;
    examples.push({ features: candidateFeatures(state, "special", positive.x, positive.y), label: 1, weight: 1.5 * sampleWeight });
    const excluded = new Set([cellKey(positive)]);
    const negatives = chooseNegatives(legalCandidates(state, "special"), excluded, positive, negativeRatio * 2, rng);
    for (const negative of negatives) {
      examples.push({ features: candidateFeatures(state, "special", negative.x, negative.y), label: 0, weight: sampleWeight });
    }
  }
}

function buildExamples(records, negativeRatio, trainingSeed, samplesPerSeed, maxRegret) {
  const examples = [];
  for (const record of records) {
    const samples = [{ sample: record.solution, weight: 1 }];
    const scoreFloor = Math.max(Number(record.baselines.productionTime), Number(record.solution.score) - maxRegret);
    for (const sample of record.trainingSamples || []) {
      if (samples.length >= samplesPerSeed) break;
      if (sample.signature === record.solution.signature || Number(sample.score) < scoreFloor - 1e-6) continue;
      const regret = Math.max(0, Number(record.solution.score) - Number(sample.score));
      samples.push({ sample, weight: Math.max(0.2, Math.exp(-regret / Math.max(1, maxRegret))) });
    }
    samples.forEach((entry, index) =>
      addSequenceExamples(examples, record, entry.sample, negativeRatio, `sample-${index}`, trainingSeed, entry.weight)
    );
  }
  return examples;
}

function shuffleExamples(examples, rng) {
  for (let index = examples.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [examples[index], examples[other]] = [examples[other], examples[index]];
  }
}

function trainEpoch(model, examples, learningRate, l2) {
  let loss = 0;
  let correct = 0;
  let totalWeight = 0;
  const hidden = new Float64Array(model.hiddenSize);
  const hiddenDelta = new Float64Array(model.hiddenSize);
  for (const example of examples) {
    const result = predict(model, example.features, hidden);
    const probability = Math.max(1e-7, Math.min(1 - 1e-7, result.probability));
    const weight = example.weight || 1;
    loss += weight * -(example.label * Math.log(probability) + (1 - example.label) * Math.log(1 - probability));
    correct += weight * Number((probability >= 0.5) === Boolean(example.label));
    totalWeight += weight;
    const outputDelta = weight * (probability - example.label);
    for (let unit = 0; unit < model.hiddenSize; unit++) {
      const oldOutputWeight = model.outputWeights[unit];
      hiddenDelta[unit] = hidden[unit] > 0 ? outputDelta * oldOutputWeight : 0;
      model.outputWeights[unit] -= learningRate * (outputDelta * hidden[unit] + l2 * oldOutputWeight);
    }
    model.outputBias -= learningRate * outputDelta;
    for (let unit = 0; unit < model.hiddenSize; unit++) {
      const delta = hiddenDelta[unit];
      model.hiddenBias[unit] -= learningRate * delta;
      const offset = unit * model.inputSize;
      for (const index of example.features) {
        const weightIndex = offset + index;
        const oldWeight = model.inputWeights[weightIndex];
        model.inputWeights[weightIndex] -= learningRate * (delta + l2 * oldWeight);
      }
    }
  }
  return { loss: loss / totalWeight, accuracy: correct / totalWeight };
}

const args = parseArguments(process.argv.slice(2));
if (!args.input) throw new Error("Pass one or more comma-separated teacher files with --input=...");
const inputFiles = args.input.split(",").map((file) => path.resolve(file));
const output = path.resolve(args.output || path.join("ai-models", `${MODEL_VERSION}.json`));
const epochs = Math.max(1, Number(args.epochs || 10) | 0);
const hiddenSize = Math.max(8, Number(args.hidden || 32) | 0);
const negativeRatio = Math.max(1, Number(args.negatives || 2) | 0);
const samplesPerSeed = Math.max(1, Math.min(4, Number(args["samples-per-seed"] || 1) | 0));
const maxRegret = Math.max(0.25, Number(args["max-regret"] || 2));
const initialLearningRate = Number(args["learning-rate"] || 0.008);
const l2 = Number(args.l2 || 0.00001);
const trainingSeed = args.seed || "outmaze-sequential-training-v3";
const records = readRecords(inputFiles);
if (!records.length) throw new Error("No teacher records found.");
const examples = buildExamples(records, negativeRatio, trainingSeed, samplesPerSeed, maxRegret);
const model = createModel(hiddenSize, trainingSeed);
const rng = engine.mulberry32(engine.hashSeed(`${MODEL_VERSION}:shuffle:${trainingSeed}`));
console.log(`Training ${MODEL_VERSION} on ${records.length} seeds and ${examples.length} sequential examples.`);
for (let epoch = 0; epoch < epochs; epoch++) {
  shuffleExamples(examples, rng);
  const learningRate = initialLearningRate * Math.pow(0.86, epoch);
  const metrics = trainEpoch(model, examples, learningRate, l2);
  console.log(
    `Epoch ${String(epoch + 1).padStart(2, "0")}/${epochs}: loss=${metrics.loss.toFixed(4)} accuracy=${(
      metrics.accuracy * 100
    ).toFixed(1)}% lr=${learningRate.toFixed(5)}`
  );
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  JSON.stringify(
    serializeModel(model, {
      trainingSeed,
      trainingFiles: inputFiles,
      teacherConfigFingerprints: Array.from(new Set(records.map((record) => record.configFingerprint))),
      records: records.length,
      examples: examples.length,
      epochs,
      negativeRatio,
      samplesPerSeed,
      maxRegret,
      causalOrdering: "greedy-route-distance-v1"
    })
  ) + "\n"
);
console.log(`Model written to ${output}`);
