"use strict";

const fs = require("node:fs");
const path = require("node:path");

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
if (!args.input) throw new Error("Use --input=file.jsonl or a comma-separated list of files.");
const records = [];
for (const file of args.input.split(",")) {
  records.push(
    ...fs
      .readFileSync(path.resolve(file), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
}
if (args["summary-only"] !== "true") {
  console.table(
    records.map((record) => ({
      seed: record.seed,
      legacy: record.baselines.legacyTime == null ? "-" : record.baselines.legacyTime.toFixed(2),
      production: record.baselines.productionTime == null ? "-" : record.baselines.productionTime.toFixed(2),
      teacher: record.solution.score.toFixed(2),
      gain:
        record.metrics.improvementOverProduction == null
          ? "-"
          : `${record.metrics.improvementOverProduction >= 0 ? "+" : ""}${record.metrics.improvementOverProduction.toFixed(2)}`,
      evaluations: record.metrics.evaluations,
      elapsed: `${(record.metrics.elapsedMs / 1000).toFixed(1)}s`
    }))
  );
}
const withProduction = records.filter((record) => record.baselines.productionTime != null);
const gains = withProduction.map((record) => record.solution.score - record.baselines.productionTime);
console.log({
  seeds: records.length,
  teacherVersion: Array.from(new Set(records.map((record) => record.teacherVersion))),
  configurations: Array.from(new Set(records.map((record) => record.configFingerprint))),
  teacherWins: gains.filter((gain) => gain > 1e-6).length,
  ties: gains.filter((gain) => Math.abs(gain) <= 1e-6).length,
  losses: gains.filter((gain) => gain < -1e-6).length,
  meanGainVsProduction: gains.length ? Number((gains.reduce((sum, gain) => sum + gain, 0) / gains.length).toFixed(2)) : null,
  medianGainVsProduction: gains.length ? Number(median(gains).toFixed(2)) : null,
  worstGainVsProduction: gains.length ? Number(Math.min(...gains).toFixed(2)) : null,
  totalCpuMinutes: Number((records.reduce((sum, record) => sum + record.metrics.elapsedMs, 0) / 60000).toFixed(1))
});
