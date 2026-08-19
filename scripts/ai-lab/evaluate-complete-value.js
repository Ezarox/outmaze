"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { layoutFromGenome } = require("./complete-layout.js");
const { hydrateModel, featureIndices, predictScore } = require("./complete-value-model.js");

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, rawValue = "true"] = argument.slice(2).split("=");
    values[key] = rawValue;
  }
  return values;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const args = parseArguments(process.argv.slice(2));
if (!args.model || !args.input) throw new Error("Use --model=... --input=...");
const model = hydrateModel(JSON.parse(fs.readFileSync(path.resolve(args.model), "utf8")));
const records = fs
  .readFileSync(path.resolve(args.input), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .sort((a, b) => a.seed.localeCompare(b.seed));
const errors = [];
const regrets = [];
const selectedGains = [];
const topK = [1, 2, 4, 8];
const topKResults = Object.fromEntries(topK.map((count) => [count, { regrets: [], gains: [] }]));
let exactBestSelections = 0;
for (const record of records) {
  const candidates = [];
  for (const sample of record.trainingSamples || []) {
    const layout = layoutFromGenome(record, sample);
    if (!layout) continue;
    const predicted = predictScore(model, featureIndices(record, layout)).score;
    const actual = Number(sample.score);
    errors.push(Math.abs(predicted - actual));
    candidates.push({ actual, predicted, signature: sample.signature });
  }
  candidates.sort((a, b) => b.predicted - a.predicted || a.signature.localeCompare(b.signature));
  const bestActual = Math.max(...candidates.map((candidate) => candidate.actual));
  const selected = candidates[0];
  const regret = bestActual - selected.actual;
  regrets.push(regret);
  selectedGains.push(selected.actual - record.baselines.productionTime);
  if (regret <= 1e-6) exactBestSelections++;
  for (const count of topK) {
    const exactSelected = candidates.slice(0, count).sort((a, b) => b.actual - a.actual || a.signature.localeCompare(b.signature))[0];
    topKResults[count].regrets.push(bestActual - exactSelected.actual);
    topKResults[count].gains.push(exactSelected.actual - record.baselines.productionTime);
  }
}
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
console.log({
  seeds: records.length,
  candidateMazes: errors.length,
  meanAbsoluteErrorSeconds: Number(mean(errors).toFixed(2)),
  medianAbsoluteErrorSeconds: Number(median(errors).toFixed(2)),
  exactBestSelections,
  meanSelectionRegretSeconds: Number(mean(regrets).toFixed(2)),
  medianSelectionRegretSeconds: Number(median(regrets).toFixed(2)),
  selectedWinsVsProduction: selectedGains.filter((gain) => gain > 1e-6).length,
  selectedTiesVsProduction: selectedGains.filter((gain) => Math.abs(gain) <= 1e-6).length,
  selectedLossesVsProduction: selectedGains.filter((gain) => gain < -1e-6).length,
  meanSelectedGainVsProduction: Number(mean(selectedGains).toFixed(2))
});
console.table(
  topK.map((count) => {
    const result = topKResults[count];
    return {
      exactFinalists: count,
      meanRegretSeconds: Number(mean(result.regrets).toFixed(2)),
      medianRegretSeconds: Number(median(result.regrets).toFixed(2)),
      winsVsProduction: result.gains.filter((gain) => gain > 1e-6).length,
      tiesVsProduction: result.gains.filter((gain) => Math.abs(gain) <= 1e-6).length,
      lossesVsProduction: result.gains.filter((gain) => gain < -1e-6).length,
      meanGainVsProduction: Number(mean(result.gains).toFixed(2))
    };
  })
);
