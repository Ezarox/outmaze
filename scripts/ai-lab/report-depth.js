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

function load(file) {
  return fs.readFileSync(path.resolve(file), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const args = parseArguments(process.argv.slice(2));
if (!args.shallow || !args.deep) throw new Error("Use --shallow=... --deep=...");
const shallow = new Map(load(args.shallow).map((record) => [record.seed, record]));
const deep = load(args.deep);
const rows = deep
  .filter((record) => shallow.has(record.seed))
  .map((record) => {
    const base = shallow.get(record.seed);
    return {
      seed: record.seed,
      shallow: base.solution.score,
      deep: record.solution.score,
      gain: record.solution.score - base.solution.score,
      shallowCpu: base.metrics.elapsedMs,
      deepCpu: record.metrics.elapsedMs
    };
  });
if (!rows.length) throw new Error("The supplied datasets do not contain matching seeds.");
if (args["summary-only"] !== "true") {
  console.table(
    rows.map((row) => ({
      seed: row.seed,
      shallow: row.shallow.toFixed(2),
      deep: row.deep.toFixed(2),
      gain: `${row.gain >= 0 ? "+" : ""}${row.gain.toFixed(2)}`,
      shallowCpu: `${(row.shallowCpu / 1000).toFixed(1)}s`,
      deepCpu: `${(row.deepCpu / 1000).toFixed(1)}s`
    }))
  );
}
const gains = rows.map((row) => row.gain);
console.log({
  matchedSeeds: rows.length,
  deeperWins: gains.filter((gain) => gain > 1e-6).length,
  ties: gains.filter((gain) => Math.abs(gain) <= 1e-6).length,
  deeperLosses: gains.filter((gain) => gain < -1e-6).length,
  meanGain: Number((gains.reduce((sum, gain) => sum + gain, 0) / gains.length).toFixed(2)),
  medianGain: Number(median(gains).toFixed(2)),
  maximumGain: Number(Math.max(...gains).toFixed(2)),
  cpuRatio: Number(
    (rows.reduce((sum, row) => sum + row.deepCpu, 0) / rows.reduce((sum, row) => sum + row.shallowCpu, 0)).toFixed(2)
  )
});
