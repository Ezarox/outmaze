"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { hydrateModel: hydrateValue } = require("./complete-value-model.js");
const { hydrateModel: hydrateProposal } = require("./sequential-policy.js");
const { search } = require("./complete-search.js");

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
if (!args.value || !args.proposal || !args.input) throw new Error("Use --value=... --proposal=... --input=...");
const valueModel = hydrateValue(JSON.parse(fs.readFileSync(path.resolve(args.value), "utf8")));
const proposalModel = hydrateProposal(JSON.parse(fs.readFileSync(path.resolve(args.proposal), "utf8")));
let records = fs
  .readFileSync(path.resolve(args.input), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .sort((a, b) => a.seed.localeCompare(b.seed));
if (args.limit) records = records.slice(0, Math.max(1, Number(args.limit) | 0));
const options = {
  generations: args.generations,
  proposals: args.proposals,
  exactPerGeneration: args.exact,
  eliteParents: args.elites,
  exactPopulation: args.population,
  sequentialSeeds: args.seeds,
  includeProduction: args.production === "true",
  productionBudget: args["production-budget"],
  causalPool: args.causal
};
const rows = [];
for (const record of records) {
  const result = search(valueModel, proposalModel, record, options);
  const score = result.best?.score || 0;
  const gain = score - record.baselines.productionTime;
  rows.push({
    seed: record.seed,
    score,
    production: record.baselines.productionTime,
    teacher: record.solution.score,
    gain,
    recovery: score / record.solution.score,
    elapsedMs: result.elapsedMs,
    exactEvaluations: result.exactEvaluations,
    source: result.best?.source || "none",
    signature: result.best?.signature || "none"
  });
  if (args["summary-only"] !== "true") {
    const row = rows[rows.length - 1];
    console.log(
      `${row.seed}: production=${row.production.toFixed(2)} complete=${row.score.toFixed(2)} ` +
        `gain=${row.gain >= 0 ? "+" : ""}${row.gain.toFixed(2)} teacher=${row.teacher.toFixed(2)} ` +
        `runtime=${row.elapsedMs.toFixed(0)}ms source=${row.source}`
    );
  }
}
const gains = rows.map((row) => row.gain);
const runtimes = rows.map((row) => row.elapsedMs).sort((a, b) => a - b);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const summary = {
  seeds: rows.length,
  winsVsProduction: gains.filter((gain) => gain > 1e-6).length,
  tiesVsProduction: gains.filter((gain) => Math.abs(gain) <= 1e-6).length,
  lossesVsProduction: gains.filter((gain) => gain < -1e-6).length,
  meanGainVsProduction: Number(mean(gains).toFixed(2)),
  medianGainVsProduction: Number(median(gains).toFixed(2)),
  meanTeacherRecovery: `${(mean(rows.map((row) => row.recovery)) * 100).toFixed(1)}%`,
  meanRuntimeMs: Number(mean(runtimes).toFixed(1)),
  p95RuntimeMs: Number(runtimes[Math.min(runtimes.length - 1, Math.floor(runtimes.length * 0.95))].toFixed(1)),
  meanExactEvaluations: Number(mean(rows.map((row) => row.exactEvaluations)).toFixed(1)),
  winnerSources: rows.reduce((counts, row) => ({ ...counts, [row.source]: (counts[row.source] || 0) + 1 }), {})
};
console.log(summary);
if (args.output) {
  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ summary, rows }, null, 2) + "\n");
  console.log(`Evaluation written to ${output}`);
}
if (args["check-repeatability"] === "true" && records.length) {
  const first = search(valueModel, proposalModel, records[0], options);
  const second = search(valueModel, proposalModel, records[0], options);
  if (first.best?.signature !== second.best?.signature || first.best?.score !== second.best?.score) {
    throw new Error("Complete-search repeatability check failed.");
  }
  console.log("Repeatability check passed.");
}
