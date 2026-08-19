"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
require("../../ai-core.js");
const engine = global.AICore;
const { hydrateModel: hydrateValue } = require("./complete-value-model.js");
const { hydrateModel: hydrateProposal } = require("./sequential-policy.js");
const { search, normalizeOptions } = require("./complete-search.js");

const ROLLOUT_VERSION = "complete-rollout-v1";

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, rawValue = "true"] = argument.slice(2).split("=");
    values[key] = rawValue;
  }
  return values;
}

function fingerprint(valueModel, proposalModel, options) {
  const stable = JSON.stringify({
    rolloutVersion: ROLLOUT_VERSION,
    valueVersion: valueModel.modelVersion,
    valueTrainingSeed: valueModel.metadata?.trainingSeed,
    valueRecords: valueModel.metadata?.records,
    valueExamples: valueModel.metadata?.examples,
    valueTrainingFiles: valueModel.metadata?.trainingFiles,
    valueOutputBias: valueModel.outputBias,
    proposalVersion: proposalModel.modelVersion,
    proposalTrainingSeed: proposalModel.metadata?.trainingSeed,
    proposalCausalOrdering: proposalModel.metadata?.causalOrdering,
    proposalExamples: proposalModel.metadata?.examples,
    proposalMaxRegret: proposalModel.metadata?.maxRegret,
    options
  });
  return engine.hashSeed(stable).toString(16).padStart(8, "0");
}

function solve(record, valueData, proposalData, options, configFingerprint) {
  const valueModel = hydrateValue(valueData);
  const proposalModel = hydrateProposal(proposalData);
  const result = search(valueModel, proposalModel, record, options);
  if (!result.best) throw new Error(`Complete search failed for ${record.seed}.`);
  return {
    schemaVersion: 1,
    rolloutVersion: ROLLOUT_VERSION,
    rulesVersion: engine.rulesVersion,
    configFingerprint,
    seed: record.seed,
    budgets: record.budgets,
    specialType: record.specialType,
    neutralSpecial: record.neutralSpecial || null,
    baseGrid: record.baseGrid,
    solution: result.evaluatedSamples.find((sample) => sample.signature === result.best.signature),
    baselines: record.baselines,
    metrics: {
      elapsedMs: result.elapsedMs,
      exactEvaluations: result.exactEvaluations,
      candidates: result.evaluatedSamples.length,
      improvementOverProduction: result.best.score - record.baselines.productionTime
    },
    trainingSamples: result.evaluatedSamples
  };
}

if (!isMainThread) {
  const result = solve(
    workerData.record,
    JSON.parse(fs.readFileSync(workerData.valuePath, "utf8")),
    JSON.parse(fs.readFileSync(workerData.proposalPath, "utf8")),
    workerData.options,
    workerData.configFingerprint
  );
  parentPort.postMessage({ index: workerData.index, result });
} else {
  const args = parseArguments(process.argv.slice(2));
  if (!args.input || !args.value || !args.proposal) {
    throw new Error("Use --input=... --value=... --proposal=...");
  }
  const input = path.resolve(args.input);
  const output = path.resolve(args.output || path.join("ai-data", `${ROLLOUT_VERSION}.jsonl`));
  const start = Math.max(0, Number(args.start || 0) | 0);
  const count = Math.max(1, Number(args.count || 100) | 0);
  const workers = Math.max(1, Math.min(12, Number(args.workers || 4) | 0));
  const options = normalizeOptions({
    generations: args.generations || 8,
    proposals: args.proposals || 320,
    exactPerGeneration: args.exact || 16,
    eliteParents: args.elites || 12,
    exactPopulation: args.population || 24,
    sequentialSeeds: args.seeds || 8,
    causalPool: args.causal || 24,
    includeProduction: false
  });
  const valuePath = path.resolve(args.value);
  const proposalPath = path.resolve(args.proposal);
  const valueData = JSON.parse(fs.readFileSync(valuePath, "utf8"));
  const proposalData = JSON.parse(fs.readFileSync(proposalPath, "utf8"));
  const configFingerprint = fingerprint(valueData, proposalData, options);
  const sourceRecords = fs
    .readFileSync(input, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .sort((a, b) => a.seed.localeCompare(b.seed))
    .slice(start, start + count);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const completed = new Set();
  if (fs.existsSync(output)) {
    for (const line of fs.readFileSync(output, "utf8").split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.configFingerprint !== configFingerprint) {
        throw new Error(
          `Existing rollouts use config ${record.configFingerprint}; this run uses ${configFingerprint}. Choose another output.`
        );
      }
      completed.add(record.seed);
    }
  }
  const tasks = sourceRecords
    .map((record, index) => ({ record, index: start + index }))
    .filter((task) => !completed.has(task.record.seed));
  console.log(
    `${ROLLOUT_VERSION} | requested=${sourceRecords.length} | remaining=${tasks.length} | workers=${workers} | config=${configFingerprint}`
  );
  console.log(`Output: ${output}`);
  if (!tasks.length) process.exit(0);
  let cursor = 0;
  let finished = 0;
  const startedAt = performance.now();

  function launchNext() {
    if (cursor >= tasks.length) return;
    const task = tasks[cursor++];
    const worker = new Worker(__filename, {
      workerData: { ...task, valuePath, proposalPath, options, configFingerprint }
    });
    worker.on("message", ({ result }) => {
      fs.appendFileSync(output, `${JSON.stringify(result)}\n`);
      finished++;
      console.log(
        `[${finished}/${tasks.length}] ${result.seed}: ${result.solution.score.toFixed(2)}s | ` +
          `${result.trainingSamples.length} exact candidates | ${(result.metrics.elapsedMs / 1000).toFixed(1)}s`
      );
      if (cursor < tasks.length) launchNext();
      else if (finished === tasks.length) finish();
    });
    worker.on("error", (error) => {
      console.error(`Worker failed for ${task.record.seed}:`, error);
      process.exitCode = 1;
    });
  }

  function finish() {
    fs.writeFileSync(
      `${output}.meta.json`,
      JSON.stringify(
        {
          rolloutVersion: ROLLOUT_VERSION,
          configFingerprint,
          options,
          source: input,
          lastRun: { start, count, generated: finished },
          logicalCpus: os.cpus().length
        },
        null,
        2
      ) + "\n"
    );
    console.log(`Completed ${finished} seeds in ${((performance.now() - startedAt) / 1000).toFixed(1)}s.`);
  }

  for (let index = 0; index < Math.min(workers, tasks.length); index++) launchNext();
}
