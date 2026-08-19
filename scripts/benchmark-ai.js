"use strict";

require("../ai-core.js");

const engine = global.AICore;
const quick = process.argv.includes("--quick");
const newOnly = process.argv.includes("--new-only");
const seeds = Array.from({ length: quick ? 6 : 20 }, (_, index) => `pass-3-benchmark-${index + 1}`);

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function placementCount(layout, type) {
  return (layout.placementOrder || []).filter((entry) => entry.type === type).length;
}

function benchmarkBuilder(label, builder) {
  const rows = [];
  for (const seed of seeds) {
    const round = engine.createRound(seed);
    const startedAt = performance.now();
    const layout = builder({
      baseGrid: round.baseGrid,
      baseNeutralSpecials: round.neutralSpecial ? [round.neutralSpecial] : [],
      specialTemplate: round.specialTemplate,
      coinBudget: round.coinBudget,
      singleBudget: round.singleBudget,
      rngSeed: engine.hashSeed(`${seed}:ai`)
    });
    const elapsedMs = performance.now() - startedAt;
    rows.push({
      seed,
      elapsedMs,
      runnerTime: layout.simulatedTime ?? engine.simulateRunnerTime(layout.grid, layout.special, round.neutralSpecial ? [round.neutralSpecial] : []),
      valid: engine.hasPath(layout.grid),
      hazardPlaced: Boolean(layout.special?.placed),
      walls: placementCount(layout, "wall"),
      singles: placementCount(layout, "single"),
      contacts: layout.profile?.quality?.structureContacts ?? null,
      existingContacts: layout.profile?.quality?.existingStructureContacts ?? null,
      hazardImpact: layout.profile?.quality?.hazardImpact ?? null
    });
  }
  return {
    label,
    rows,
    medianMs: median(rows.map((row) => row.elapsedMs)),
    maximumMs: Math.max(...rows.map((row) => row.elapsedMs)),
    meanRunnerTime: rows.reduce((sum, row) => sum + row.runnerTime, 0) / rows.length,
    invalid: rows.filter((row) => !row.valid).length,
    hazardsMissed: rows.filter((row) => !row.hazardPlaced).length,
    meanHazardImpact: rows.reduce((sum, row) => sum + (row.hazardImpact || 0), 0) / rows.length,
    meanExistingContacts: rows.reduce((sum, row) => sum + (row.existingContacts || 0), 0) / rows.length
  };
}

const modern = benchmarkBuilder("bounded route search", engine.buildAiLayoutFromSnapshot);
if (newOnly) {
  console.table(modern.rows);
  console.log({
    seeds: seeds.length,
    difficulty: "hard",
    newAi: {
      medianMs: Number(modern.medianMs.toFixed(1)),
      maximumMs: Number(modern.maximumMs.toFixed(1)),
      meanRunnerTime: Number(modern.meanRunnerTime.toFixed(2)),
      invalid: modern.invalid,
      hazardsMissed: modern.hazardsMissed,
      meanHazardImpact: Number(modern.meanHazardImpact.toFixed(2)),
      meanExistingContacts: Number(modern.meanExistingContacts.toFixed(2))
    }
  });
  process.exit(0);
}
const legacy = benchmarkBuilder("legacy greedy branches", engine.buildLegacyAiLayoutFromSnapshot);
const wins = modern.rows.filter((row, index) => row.runnerTime > legacy.rows[index].runnerTime + 1e-6).length;
const ties = modern.rows.filter((row, index) => Math.abs(row.runnerTime - legacy.rows[index].runnerTime) <= 1e-6).length;

console.table(
  seeds.map((seed, index) => ({
    seed,
    newMs: modern.rows[index].elapsedMs.toFixed(1),
    oldMs: legacy.rows[index].elapsedMs.toFixed(1),
    newTime: modern.rows[index].runnerTime.toFixed(2),
    oldTime: legacy.rows[index].runnerTime.toFixed(2),
    result: modern.rows[index].runnerTime > legacy.rows[index].runnerTime ? "new" : modern.rows[index].runnerTime < legacy.rows[index].runnerTime ? "old" : "tie",
    hazard: modern.rows[index].hazardPlaced ? "yes" : "no",
    walls: modern.rows[index].walls,
    singles: modern.rows[index].singles,
    contacts: modern.rows[index].contacts ?? "-",
    existing: modern.rows[index].existingContacts ?? "-",
    hazardGain: modern.rows[index].hazardImpact == null ? "-" : modern.rows[index].hazardImpact.toFixed(2)
  }))
);

console.log({
  seeds: seeds.length,
  difficulty: "hard",
  quality: { wins, ties, losses: seeds.length - wins - ties },
  newAi: {
    medianMs: Number(modern.medianMs.toFixed(1)),
    maximumMs: Number(modern.maximumMs.toFixed(1)),
    meanRunnerTime: Number(modern.meanRunnerTime.toFixed(2)),
    invalid: modern.invalid,
    hazardsMissed: modern.hazardsMissed,
    meanHazardImpact: Number(modern.meanHazardImpact.toFixed(2)),
    meanExistingContacts: Number(modern.meanExistingContacts.toFixed(2))
  },
  legacyAi: {
    medianMs: Number(legacy.medianMs.toFixed(1)),
    maximumMs: Number(legacy.maximumMs.toFixed(1)),
    meanRunnerTime: Number(legacy.meanRunnerTime.toFixed(2)),
    invalid: legacy.invalid,
    hazardsMissed: legacy.hazardsMissed
  }
});
