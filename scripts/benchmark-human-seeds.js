"use strict";

require("../ai-core.js");

const engine = global.AICore;
const cases = [
  { seed: "378559475", humanTime: 49.41, note: "diagonal slalom + two slow pads" },
  { seed: "331577479", humanTime: 30.1, note: "route crossed two speed pads" },
  { seed: "1327684", humanTime: 53.21, note: "pressure field + detour-pad lane reuse" }
];

function snapshotFor(seed) {
  const round = engine.createRound(seed);
  return {
    round,
    snapshot: {
      baseGrid: round.baseGrid,
      baseNeutralSpecials: round.neutralSpecial ? [round.neutralSpecial] : [],
      specialTemplate: round.specialTemplate,
      coinBudget: round.coinBudget,
      singleBudget: round.singleBudget,
      rngSeed: engine.hashSeed(`${seed}:ai`)
    }
  };
}

const rows = cases.map(({ seed, humanTime, note }) => {
  const { snapshot } = snapshotFor(seed);
  const startedAt = performance.now();
  const layout = engine.buildAiLayoutFromSnapshot(snapshot);
  const elapsedMs = performance.now() - startedAt;
  const pads = layout.profile?.quality?.triggeredPads || {};
  return {
    seed,
    human: humanTime.toFixed(2),
    hardAi: layout.simulatedTime.toFixed(2),
    humanGap: (humanTime - layout.simulatedTime).toFixed(2),
    buildMs: elapsedMs.toFixed(0),
    candidate: layout.profile?.chosenCandidate || "unknown",
    speedPads: pads.speed || 0,
    slowPads: pads.slow || 0,
    reversePads: (pads.detour || 0) + (pads.rewind || 0),
    hazardGain: (layout.profile?.quality?.hazardImpact || 0).toFixed(2),
    note
  };
});

console.table(rows);
