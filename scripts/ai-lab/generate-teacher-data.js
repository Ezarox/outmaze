"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { seedForSplit, solveSeed, normalizeConfig, configFingerprint, TEACHER_VERSION } = require("./teacher.js");

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, rawValue = "true"] = argument.slice(2).split("=");
    values[key] = rawValue;
  }
  return values;
}

function numberArgument(values, key, fallback) {
  const value = values[key] == null ? fallback : Number(values[key]);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number.`);
  return value;
}

function buildOptions(values) {
  const split = values.split || "train";
  const start = Math.max(0, numberArgument(values, "start", 0) | 0);
  const count = Math.max(1, numberArgument(values, "count", 10) | 0);
  const workers = Math.max(1, Math.min(32, numberArgument(values, "workers", 1) | 0));
  const config = normalizeConfig({
    evaluations: numberArgument(values, "evaluations", 5000),
    population: numberArgument(values, "population", 32),
    elitePool: numberArgument(values, "elite-pool", 12),
    maxMutationMoves: numberArgument(values, "mutation-moves", 4),
    crossoverRate: numberArgument(values, "crossover-rate", 0.22),
    hazardSweepInterval: numberArgument(values, "hazard-interval", 900),
    hazardSweepCandidates: numberArgument(values, "hazard-candidates", 72),
    coordinatePasses: numberArgument(values, "coordinate-passes", 1),
    includeLegacySeed: values["legacy-seed"] !== "false",
    includeProductionSeed: values["production-seed"] !== "false"
  });
  const output = path.resolve(values.output || path.join("ai-data", `${TEACHER_VERSION}-${split}.jsonl`));
  return { split, start, count, workers, config, output };
}

if (!isMainThread) {
  const result = solveSeed(workerData.seed, workerData.config);
  parentPort.postMessage({ index: workerData.index, result });
} else {
  const options = buildOptions(parseArguments(process.argv.slice(2)));
  const fingerprint = configFingerprint(options.config);
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  const completed = new Set();
  if (fs.existsSync(options.output)) {
    const lines = fs.readFileSync(options.output, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const record = JSON.parse(line);
      if (record.configFingerprint !== fingerprint) {
        throw new Error(
          `Existing output uses config ${record.configFingerprint}, but this run uses ${fingerprint}. Choose another --output or reuse the same settings.`
        );
      }
      completed.add(record.seed);
    }
  }
  const tasks = [];
  for (let offset = 0; offset < options.count; offset++) {
    const index = options.start + offset;
    const seed = seedForSplit(options.split, index);
    if (!completed.has(seed)) tasks.push({ index, seed });
  }
  console.log(
    `Teacher ${TEACHER_VERSION} | split=${options.split} | requested=${options.count} | remaining=${tasks.length} | workers=${options.workers}`
  );
  console.log(`Fixed budget: ${options.config.evaluations} exact simulations per seed | config=${fingerprint}`);
  console.log(`Output: ${options.output}`);
  if (!tasks.length) process.exit(0);

  let cursor = 0;
  let finished = 0;
  const results = new Map();
  const startedAt = performance.now();

  function launchNext() {
    if (cursor >= tasks.length) return null;
    const task = tasks[cursor++];
    const worker = new Worker(__filename, { workerData: { ...task, config: options.config } });
    worker.on("message", ({ index, result }) => {
      results.set(index, result);
      fs.appendFileSync(options.output, `${JSON.stringify(result)}\n`);
      completed.add(result.seed);
      finished++;
      console.log(
        `[${finished}/${tasks.length}] ${result.seed}: ${result.solution.score.toFixed(2)}s` +
          (result.metrics.improvementOverLegacy == null
            ? ""
            : ` (${result.metrics.improvementOverLegacy >= 0 ? "+" : ""}${result.metrics.improvementOverLegacy.toFixed(2)}s vs legacy)`) +
          ` in ${(result.metrics.elapsedMs / 1000).toFixed(1)}s`
      );
      const next = launchNext();
      if (!next && finished === tasks.length) finish();
    });
    worker.on("error", (error) => {
      console.error(`Worker failed for ${task.seed}:`, error);
      process.exitCode = 1;
    });
    return worker;
  }

  function finish() {
    const metaPath = `${options.output}.meta.json`;
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          teacherVersion: TEACHER_VERSION,
          configFingerprint: fingerprint,
          config: options.config,
          split: options.split,
          lastRun: { start: options.start, count: options.count, generated: results.size },
          logicalCpus: os.cpus().length
        },
        null,
        2
      ) + "\n"
    );
    console.log(`Completed ${results.size} seeds in ${((performance.now() - startedAt) / 1000).toFixed(1)}s.`);
  }

  for (let index = 0; index < Math.min(options.workers, tasks.length); index++) launchNext();
}
