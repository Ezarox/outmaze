"use strict";

const fs = require("node:fs");
const path = require("node:path");

require("../ai-core.js");
const engine = global.AICore;

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, rawValue = "true"] = argument.slice(2).split("=");
    values[key] = rawValue;
  }
  return values;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function snapshot(record, overrides = {}) {
  return {
    baseGrid: record.baseGrid,
    baseNeutralSpecials: record.neutralSpecial ? [record.neutralSpecial] : [],
    specialTemplate: engine.createSpecialTemplate(record.specialType),
    coinBudget: record.budgets.walls,
    singleBudget: record.budgets.singles,
    rngSeed: engine.hashSeed(`${record.seed}:ai`),
    deterministicBudget: true,
    ...overrides
  };
}

function presentPads(grid) {
  const pads = { speed: 0, slow: 0, detour: 0, stone: 0, rewind: 0 };
  for (const row of grid) {
    for (const cell of row) {
      const type = engine.padTypeFromCell(cell);
      if (type) pads[type]++;
    }
  }
  return pads;
}

function summarize(rows) {
  const gains = rows.map((row) => row.gain);
  const runtimes = rows.map((row) => row.newRuntimeMs);
  const oldRuntimes = rows.map((row) => row.oldRuntimeMs).filter(Number.isFinite);
  return {
    seeds: rows.length,
    improved: gains.filter((gain) => gain > 1e-6).length,
    tied: gains.filter((gain) => Math.abs(gain) <= 1e-6).length,
    regressed: gains.filter((gain) => gain < -1e-6).length,
    meanGain: Number(mean(gains).toFixed(3)),
    medianGain: Number(median(gains).toFixed(3)),
    maxGain: Number(Math.max(...gains).toFixed(3)),
    worstGain: Number(Math.min(...gains).toFixed(3)),
    oldMeanRuntimeMs: oldRuntimes.length ? Number(mean(oldRuntimes).toFixed(1)) : null,
    newMeanRuntimeMs: Number(mean(runtimes).toFixed(1)),
    newP95RuntimeMs: Number(percentile(runtimes, 0.95).toFixed(1)),
    meanRuntimeDeltaMs: oldRuntimes.length
      ? Number(mean(rows.map((row) => row.newRuntimeMs - row.oldRuntimeMs)).toFixed(1))
      : null
  };
}

const args = parseArguments(process.argv.slice(2));
const input = path.resolve(args.input || "ai-data/teacher-validation-pilot.jsonl");
const start = Math.max(0, Number(args.start || 0) | 0);
const count = Math.max(1, Number(args.count || 50) | 0);
const rebuildBaseline = args["rebuild-baseline"] === "true";
const specialists = Math.max(0, Number(args.specialists ?? 3) | 0);
const refinement = args.refinement !== "false";
let records = fs
  .readFileSync(input, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .sort((a, b) => a.seed.localeCompare(b.seed));
if (args.pad) records = records.filter((record) => presentPads(record.baseGrid)[args.pad] > 0);
records = records.slice(start, start + count);
const rows = [];
for (let index = 0; index < records.length; index++) {
  const record = records[index];
  let oldScore = record.baselines.productionTime;
  let oldRuntimeMs = record.baselines.productionBuildMs;
  let oldPads = null;
  let oldDiagnostics = null;
  if (rebuildBaseline) {
    const old = engine.buildAiLayoutFromSnapshot(snapshot(record, { padAwareTactics: false }));
    oldScore = old.simulatedTime;
    oldRuntimeMs = old.profile.totalMs;
    oldPads = old.profile.quality.triggeredPads;
    oldDiagnostics = old.profile.quality.padDiagnostics;
  }
  const improved = engine.buildAiLayoutFromSnapshot(
    snapshot(record, {
      padAwareTactics: true,
      padSpecialistLimit: specialists,
      padAwareRefinement: refinement
    })
  );
  const row = {
    seed: record.seed,
    oldScore,
    newScore: improved.simulatedTime,
    gain: improved.simulatedTime - oldScore,
    oldRuntimeMs,
    newRuntimeMs: improved.profile.totalMs,
    runtimeDeltaMs: improved.profile.totalMs - oldRuntimeMs,
    chosenCandidate: improved.profile.chosenCandidate,
    presentPads: presentPads(record.baseGrid),
    oldPads,
    newPads: improved.profile.quality.triggeredPads,
    oldDiagnostics,
    newDiagnostics: improved.profile.quality.padDiagnostics,
    opportunities: improved.profile.padOpportunities,
    specialists: improved.profile.padSpecialists,
    padRefinements: improved.profile.padRefinements,
    padRefinementEvaluations: improved.profile.padRefinementEvaluations
  };
  rows.push(row);
  if (args["summary-only"] !== "true") {
    console.log(
      `[${index + 1}/${records.length}] ${record.seed}: ${oldScore.toFixed(2)} -> ${improved.simulatedTime.toFixed(2)} ` +
        `(${row.gain >= 0 ? "+" : ""}${row.gain.toFixed(2)}s), ${improved.profile.totalMs.toFixed(0)}ms, ` +
        `${row.chosenCandidate}`
    );
  }
}

const byPad = {};
for (const type of ["speed", "slow", "detour", "stone", "rewind"]) {
  byPad[type] = summarize(rows.filter((row) => row.presentPads[type] > 0));
}
const summary = summarize(rows);
summary.byPad = byPad;
summary.winnerSources = rows.reduce(
  (counts, row) => ({ ...counts, [row.chosenCandidate]: (counts[row.chosenCandidate] || 0) + 1 }),
  {}
);
const report = {
  schemaVersion: 1,
  aiVersion: engine.aiVersion,
  generatedAt: new Date().toISOString(),
  input,
  range: { start, count: rows.length, pad: args.pad || null },
  configuration: { rebuildBaseline, specialists, refinement },
  summary,
  rows
};
console.dir(summary, { depth: 4 });
if (args.output) {
  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Pad benchmark written to ${output}`);
}
