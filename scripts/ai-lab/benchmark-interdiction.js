"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { METHODS, SEARCH_VERSION, search } = require("./interdiction-search.js");

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

function numericOptions(args) {
  const mappings = {
    beam: "beamWidth",
    candidates: "candidatePool",
    branches: "branchesPerState",
    routes: "alternativePaths",
    "bundle-size": "maxBundleSize",
    finalists: "finalistLayouts",
    "hazard-exact": "hazardExactCandidates",
    "path-budget": "maxPathEvaluations"
  };
  const options = {};
  for (const [argument, option] of Object.entries(mappings)) {
    if (args[argument] != null) options[option] = Number(args[argument]);
  }
  return options;
}

function summarize(rows) {
  const gains = rows.map((row) => row.gainVsProduction);
  const teacherGaps = rows.map((row) => row.score - row.teacher);
  const runtimes = rows.map((row) => row.elapsedMs);
  return {
    seeds: rows.length,
    winsVsProduction: gains.filter((gain) => gain > 1e-6).length,
    tiesVsProduction: gains.filter((gain) => Math.abs(gain) <= 1e-6).length,
    lossesVsProduction: gains.filter((gain) => gain < -1e-6).length,
    meanGainVsProduction: Number(mean(gains).toFixed(3)),
    medianGainVsProduction: Number(median(gains).toFixed(3)),
    worstGainVsProduction: Number(Math.min(...gains).toFixed(3)),
    meanGapToTeacher: Number(mean(teacherGaps).toFixed(3)),
    meanTeacherRecovery: Number((mean(rows.map((row) => row.recovery)) * 100).toFixed(2)),
    meanRuntimeMs: Number(mean(runtimes).toFixed(1)),
    medianRuntimeMs: Number(median(runtimes).toFixed(1)),
    p95RuntimeMs: Number(percentile(runtimes, 0.95).toFixed(1)),
    maxRuntimeMs: Number(Math.max(...runtimes).toFixed(1)),
    meanPathEvaluations: Number(mean(rows.map((row) => row.pathEvaluations)).toFixed(1)),
    meanExactSimulations: Number(mean(rows.map((row) => row.exactSimulations)).toFixed(1)),
    fullWallLayouts: rows.filter((row) => row.wallsUsed === row.wallBudget).length,
    fullSingleLayouts: rows.filter((row) => row.singlesUsed === row.singleBudget).length
  };
}

const args = parseArguments(process.argv.slice(2));
const input = path.resolve(args.input || "ai-data/teacher-validation-pilot.jsonl");
const count = Math.max(1, Number(args.count || 50) | 0);
const start = Math.max(0, Number(args.start || 0) | 0);
const requestedMethods = String(args.methods || METHODS.join(","))
  .split(",")
  .map((method) => method.trim())
  .filter(Boolean);
for (const method of requestedMethods) {
  if (!METHODS.includes(method)) throw new Error(`Unknown method '${method}'. Use ${METHODS.join(", ")}.`);
}
const records = fs
  .readFileSync(input, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .sort((a, b) => a.seed.localeCompare(b.seed))
  .slice(start, start + count);
if (!records.length) throw new Error(`No records selected from ${input}.`);

const options = numericOptions(args);
const rows = [];
const total = records.length * requestedMethods.length;
let completed = 0;
for (const record of records) {
  for (const method of requestedMethods) {
    const result = search(method, record, options);
    const score = result.best?.score || 0;
    const state = result.best?.state;
    const row = {
      seed: record.seed,
      method,
      score,
      production: record.baselines.productionTime,
      teacher: record.solution.score,
      gainVsProduction: score - record.baselines.productionTime,
      recovery: record.solution.score > 0 ? score / record.solution.score : 0,
      elapsedMs: result.elapsedMs,
      pathEvaluations: result.profile.pathEvaluations,
      exactSimulations: result.profile.exactSimulations,
      expansions: result.profile.expansions,
      wallsUsed: state?.walls.length || 0,
      wallBudget: record.budgets.walls,
      singlesUsed: state?.singles.length || 0,
      singleBudget: record.budgets.singles,
      signature: result.best?.signature || "none"
    };
    rows.push(row);
    completed++;
    if (args["summary-only"] !== "true") {
      console.log(
        `[${completed}/${total}] ${record.seed} ${method}: ${score.toFixed(2)}s ` +
          `(${row.gainVsProduction >= 0 ? "+" : ""}${row.gainVsProduction.toFixed(2)} vs production), ` +
          `${row.elapsedMs.toFixed(0)}ms, walls ${row.wallsUsed}/${row.wallBudget}`
      );
    }
  }
}

const summary = {};
for (const method of requestedMethods) summary[method] = summarize(rows.filter((row) => row.method === method));
const productionRuntimes = records.map((record) => record.baselines.productionBuildMs).filter(Number.isFinite);
const report = {
  schemaVersion: 1,
  searchVersion: SEARCH_VERSION,
  generatedAt: new Date().toISOString(),
  input,
  range: { start, count: records.length },
  options,
  productionRuntimeReference: productionRuntimes.length
    ? {
        meanMs: Number(mean(productionRuntimes).toFixed(1)),
        p95Ms: Number(percentile(productionRuntimes, 0.95).toFixed(1))
      }
    : null,
  summary,
  rows
};
console.table(
  requestedMethods.map((method) => ({
    method,
    W: summary[method].winsVsProduction,
    T: summary[method].tiesVsProduction,
    L: summary[method].lossesVsProduction,
    meanGain: summary[method].meanGainVsProduction,
    medianGain: summary[method].medianGainVsProduction,
    teacherRecovery: `${summary[method].meanTeacherRecovery}%`,
    meanMs: summary[method].meanRuntimeMs,
    p95Ms: summary[method].p95RuntimeMs,
    fullWalls: `${summary[method].fullWallLayouts}/${summary[method].seeds}`
  }))
);
if (args.output) {
  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Benchmark written to ${output}`);
}
