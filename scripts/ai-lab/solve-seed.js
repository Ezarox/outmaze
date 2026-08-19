"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { solveSeed, normalizeConfig } = require("./teacher.js");

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, rawValue = "true"] = argument.slice(2).split("=");
    values[key] = rawValue;
  }
  return values;
}
function numeric(values, key, fallback) {
  const result = Number(values[key] == null ? fallback : values[key]);
  if (!Number.isFinite(result)) throw new Error(`--${key} must be numeric.`);
  return result;
}

const args = parseArguments(process.argv.slice(2));
if (!args.seed) throw new Error("Use --seed=YOUR_SEED");
const config = normalizeConfig({
  evaluations: numeric(args, "evaluations", 6000),
  population: numeric(args, "population", 32),
  elitePool: numeric(args, "elite-pool", 12),
  maxMutationMoves: numeric(args, "mutation-moves", 4),
  crossoverRate: numeric(args, "crossover-rate", 0.22),
  hazardSweepInterval: numeric(args, "hazard-interval", 900),
  hazardSweepCandidates: numeric(args, "hazard-candidates", 72),
  coordinatePasses: numeric(args, "coordinate-passes", 1),
  includeLegacySeed: args["legacy-seed"] !== "false",
  includeProductionSeed: args["production-seed"] !== "false"
});
console.log(`Solving seed ${args.seed} with exactly ${config.evaluations} canonical simulations.`);
const result = solveSeed(args.seed, config, ({ evaluations, best }) => {
  console.log(`  ${evaluations}/${config.evaluations}: best ${best.toFixed(2)}s`);
});
console.table([
  {
    seed: result.seed,
    legacy: result.baselines.legacyTime == null ? "-" : result.baselines.legacyTime.toFixed(2),
    production: result.baselines.productionTime == null ? "-" : result.baselines.productionTime.toFixed(2),
    teacher: result.solution.score.toFixed(2),
    gainVsProduction:
      result.metrics.improvementOverProduction == null
        ? "-"
        : `${result.metrics.improvementOverProduction >= 0 ? "+" : ""}${result.metrics.improvementOverProduction.toFixed(2)}`,
    elapsed: `${(result.metrics.elapsedMs / 1000).toFixed(1)}s`,
    signature: result.solution.signature
  }
]);
if (args.output) {
  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result) + "\n");
  console.log(`Full record written to ${output}`);
}
