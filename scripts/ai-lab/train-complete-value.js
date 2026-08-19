"use strict";

const fs = require("node:fs");
const path = require("node:path");
require("../../ai-core.js");
const engine = global.AICore;
const { layoutFromGenome } = require("./complete-layout.js");
const {
  MODEL_VERSION,
  featureIndices,
  createModel,
  serializeModel,
  predictNormalized
} = require("./complete-value-model.js");

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

function stratifiedSamples(record, count) {
  const samples = record.trainingSamples || [];
  if (samples.length <= count) return samples;
  const selected = [];
  const used = new Set();
  for (let index = 0; index < count; index++) {
    const sampleIndex = Math.round((index * (samples.length - 1)) / Math.max(1, count - 1));
    if (!used.has(sampleIndex)) {
      used.add(sampleIndex);
      selected.push(samples[sampleIndex]);
    }
  }
  return selected;
}

function buildExamples(records, samplesPerSeed) {
  const raw = [];
  for (const record of records) {
    for (const sample of stratifiedSamples(record, samplesPerSeed)) {
      const layout = layoutFromGenome(record, sample);
      if (!layout) continue;
      raw.push({ seed: record.seed, features: featureIndices(record, layout), score: Number(sample.score) });
    }
  }
  const mean = raw.reduce((sum, example) => sum + example.score, 0) / raw.length;
  const variance = raw.reduce((sum, example) => sum + Math.pow(example.score - mean, 2), 0) / raw.length;
  const std = Math.sqrt(variance) || 1;
  return { examples: raw.map((example) => ({ ...example, target: (example.score - mean) / std })), mean, std };
}

function shuffleExamples(examples, rng) {
  for (let index = examples.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [examples[index], examples[other]] = [examples[other], examples[index]];
  }
}

function trainEpoch(model, examples, learningRate, l2) {
  const hidden = new Float32Array(model.hiddenSize);
  const hiddenDelta = new Float32Array(model.hiddenSize);
  let squaredError = 0;
  let absoluteError = 0;
  for (const example of examples) {
    const prediction = predictNormalized(model, example.features, hidden);
    const rawError = prediction.value - example.target;
    const delta = Math.max(-2, Math.min(2, rawError));
    squaredError += rawError * rawError;
    absoluteError += Math.abs(rawError);
    for (let unit = 0; unit < model.hiddenSize; unit++) {
      const oldOutputWeight = model.outputWeights[unit];
      hiddenDelta[unit] = hidden[unit] > 0 ? delta * oldOutputWeight : 0;
      model.outputWeights[unit] -= learningRate * (delta * hidden[unit] + l2 * oldOutputWeight);
    }
    model.outputBias -= learningRate * delta;
    for (let unit = 0; unit < model.hiddenSize; unit++) {
      const unitDelta = hiddenDelta[unit];
      model.hiddenBias[unit] -= learningRate * unitDelta;
      const offset = unit * model.inputSize;
      for (const index of example.features) {
        const weightIndex = offset + index;
        const oldWeight = model.inputWeights[weightIndex];
        model.inputWeights[weightIndex] -= learningRate * (unitDelta + l2 * oldWeight);
      }
    }
  }
  return {
    rmse: Math.sqrt(squaredError / examples.length) * model.targetStd,
    mae: (absoluteError / examples.length) * model.targetStd
  };
}

const args = parseArguments(process.argv.slice(2));
if (!args.input) throw new Error("Pass one or more comma-separated teacher files with --input=...");
const inputFiles = args.input.split(",").map((file) => path.resolve(file));
const output = path.resolve(args.output || path.join("ai-models", `${MODEL_VERSION}.json`));
const epochs = Math.max(1, Number(args.epochs || 8) | 0);
const hiddenSize = Math.max(8, Number(args.hidden || 24) | 0);
const samplesPerSeed = Math.max(4, Math.min(32, Number(args["samples-per-seed"] || 12) | 0));
const initialLearningRate = Number(args["learning-rate"] || 0.0025);
const l2 = Number(args.l2 || 0.000002);
const trainingSeed = args.seed || "outmaze-complete-value-v1";
const records = readRecords(inputFiles);
if (!records.length) throw new Error("No teacher records found.");
console.log(`Preparing stratified complete-maze examples from ${records.length} seeds.`);
const dataset = buildExamples(records, samplesPerSeed);
const model = createModel(hiddenSize, trainingSeed, dataset.mean, dataset.std);
const rng = engine.mulberry32(engine.hashSeed(`${MODEL_VERSION}:shuffle:${trainingSeed}`));
console.log(
  `Training ${MODEL_VERSION} on ${dataset.examples.length} complete mazes ` +
    `(target mean ${dataset.mean.toFixed(2)}s, std ${dataset.std.toFixed(2)}s).`
);
for (let epoch = 0; epoch < epochs; epoch++) {
  shuffleExamples(dataset.examples, rng);
  const learningRate = initialLearningRate * Math.pow(0.84, epoch);
  const metrics = trainEpoch(model, dataset.examples, learningRate, l2);
  console.log(
    `Epoch ${String(epoch + 1).padStart(2, "0")}/${epochs}: ` +
      `rmse=${metrics.rmse.toFixed(2)}s mae=${metrics.mae.toFixed(2)}s lr=${learningRate.toFixed(6)}`
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
      examples: dataset.examples.length,
      epochs,
      samplesPerSeed
    })
  ) + "\n"
);
console.log(`Model written to ${output}`);
