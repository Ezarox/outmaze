"use strict";

const fs = require("node:fs");
const path = require("node:path");
require("../../ai-core.js");
const engine = global.AICore;
const {
  MODEL_VERSION,
  ACTION_TYPES,
  candidateFeatures,
  createModel,
  serializeModel,
  predict,
  legalCandidates
} = require("./policy-model.js");

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

function buildExamples(records, negativeRatio, seed) {
  const examples = [];
  for (const record of records) {
    for (const actionType of ACTION_TYPES) {
      const positives = actionType === "wall"
        ? record.solution.walls
        : actionType === "single"
          ? record.solution.singles
          : record.solution.special
            ? [record.solution.special]
            : [];
      const positiveKeys = new Set(positives.map(cellKey));
      for (const cell of positives) {
        examples.push({ features: candidateFeatures(record, actionType, cell.x, cell.y), label: 1 });
      }
      const negatives = legalCandidates(record, actionType).filter((cell) => !positiveKeys.has(cellKey(cell)));
      const rng = engine.mulberry32(engine.hashSeed(`${MODEL_VERSION}:${seed}:${record.seed}:${actionType}`));
      for (let index = negatives.length - 1; index > 0; index--) {
        const other = Math.floor(rng() * (index + 1));
        [negatives[index], negatives[other]] = [negatives[other], negatives[index]];
      }
      const wanted = Math.min(negatives.length, Math.max(1, positives.length) * negativeRatio);
      for (const cell of negatives.slice(0, wanted)) {
        examples.push({ features: candidateFeatures(record, actionType, cell.x, cell.y), label: 0 });
      }
    }
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
  const hidden = new Float64Array(model.hiddenSize);
  const hiddenDelta = new Float64Array(model.hiddenSize);
  for (const example of examples) {
    const result = predict(model, example.features, hidden);
    const probability = Math.max(1e-7, Math.min(1 - 1e-7, result.probability));
    loss += -(example.label * Math.log(probability) + (1 - example.label) * Math.log(1 - probability));
    correct += Number((probability >= 0.5) === Boolean(example.label));
    const outputDelta = probability - example.label;
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
  return { loss: loss / examples.length, accuracy: correct / examples.length };
}

const args = parseArguments(process.argv.slice(2));
if (!args.input) throw new Error("Pass one or more comma-separated teacher files with --input=...");
const inputFiles = args.input.split(",").map((file) => path.resolve(file));
const output = path.resolve(args.output || path.join("ai-models", `${MODEL_VERSION}.json`));
const epochs = Math.max(1, Number(args.epochs || 12) | 0);
const hiddenSize = Math.max(8, Number(args.hidden || 48) | 0);
const negativeRatio = Math.max(1, Number(args.negatives || 3) | 0);
const initialLearningRate = Number(args["learning-rate"] || 0.012);
const l2 = Number(args.l2 || 0.00001);
const trainingSeed = args.seed || "outmaze-policy-training-v1";
const records = readRecords(inputFiles);
if (!records.length) throw new Error("No teacher records found.");
const examples = buildExamples(records, negativeRatio, trainingSeed);
const model = createModel(hiddenSize, trainingSeed);
const rng = engine.mulberry32(engine.hashSeed(`${MODEL_VERSION}:shuffle:${trainingSeed}`));
console.log(`Training ${MODEL_VERSION} on ${records.length} seeds and ${examples.length} examples.`);
for (let epoch = 0; epoch < epochs; epoch++) {
  shuffleExamples(examples, rng);
  const learningRate = initialLearningRate * Math.pow(0.88, epoch);
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
      negativeRatio
    })
  ) + "\n"
);
console.log(`Model written to ${output}`);
