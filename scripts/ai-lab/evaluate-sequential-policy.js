"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { hydrateModel } = require("./sequential-policy.js");
const { search } = require("./sequential-search.js");

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, rawValue = "true"] = argument.slice(2).split("=");
    values[key] = rawValue;
  }
  return values;
}

function readRecords(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .sort((a, b) => a.seed.localeCompare(b.seed));
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const args = parseArguments(process.argv.slice(2));
if (!args.model || !args.input) throw new Error("Use --model=... --input=...");
const model = hydrateModel(JSON.parse(fs.readFileSync(path.resolve(args.model), "utf8")));
let records = readRecords(path.resolve(args.input));
if (args.limit) records = records.slice(0, Math.max(1, Number(args.limit) | 0));
const searchOptions = {
  beamWidth: args.beam,
  branchFactor: args.branches,
  candidatePool: args.pool,
  stoppedLayouts: args.stopped,
  hazardCandidates: args.hazards,
  exactCandidates: args.exact,
  partialExact: args["partial-exact"] === "false" ? false : undefined,
  causalPool: args.causal
};
const rows = [];
for (const record of records) {
  const result = search(model, record, searchOptions);
  const learned = result.best?.score || 0;
  rows.push({
    seed: record.seed,
    teacher: record.solution.score,
    production: record.baselines.productionTime,
    learned,
    gain: learned - record.baselines.productionTime,
    ratio: learned / record.solution.score,
    elapsedMs: result.elapsedMs,
    candidates: result.candidatesEvaluated,
    signature: result.best?.signature || "none"
  });
  if (args["summary-only"] !== "true") {
    const row = rows[rows.length - 1];
    console.log(
      `${row.seed}: production=${row.production.toFixed(2)} learned=${row.learned.toFixed(2)} ` +
        `gain=${row.gain >= 0 ? "+" : ""}${row.gain.toFixed(2)} teacher=${row.teacher.toFixed(2)} ` +
        `runtime=${row.elapsedMs.toFixed(0)}ms`
    );
  }
}

const gains = rows.map((row) => row.gain);
const runtimes = rows.map((row) => row.elapsedMs).sort((a, b) => a - b);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const summary = {
  seeds: rows.length,
  winsVsProduction: gains.filter((gain) => gain > 1e-6).length,
  tiesVsProduction: gains.filter((gain) => Math.abs(gain) <= 1e-6).length,
  lossesVsProduction: gains.filter((gain) => gain < -1e-6).length,
  meanGainVsProduction: Number(mean(gains).toFixed(2)),
  medianGainVsProduction: Number(median(gains).toFixed(2)),
  meanTeacherRecovery: `${(mean(rows.map((row) => row.ratio)) * 100).toFixed(1)}%`,
  meanRuntimeMs: Number(mean(runtimes).toFixed(1)),
  p95RuntimeMs: Number(runtimes[Math.min(runtimes.length - 1, Math.floor(runtimes.length * 0.95))].toFixed(1)),
  meanExactCandidates: Number(mean(rows.map((row) => row.candidates)).toFixed(1))
};
console.log(summary);

if (args["check-repeatability"] === "true" && records.length) {
  const first = search(model, records[0], searchOptions);
  const second = search(model, records[0], searchOptions);
  if (first.best?.signature !== second.best?.signature || first.best?.score !== second.best?.score) {
    throw new Error("Sequential search repeatability check failed.");
  }
  console.log("Repeatability check passed.");
}
