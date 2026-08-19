const test = require("node:test");
const assert = require("node:assert/strict");

require("../ai-core.js");

const engine = global.AICore;

function snapshotFor(seed, overrides = {}) {
  const round = engine.createRound(seed);
  return {
    round,
    snapshot: {
      baseGrid: round.baseGrid,
      baseNeutralSpecials: round.neutralSpecial ? [round.neutralSpecial] : [],
      specialTemplate: round.specialTemplate,
      coinBudget: round.coinBudget,
      singleBudget: round.singleBudget,
      rngSeed: engine.hashSeed(`${seed}:ai`),
      ...overrides
    }
  };
}

function placementSummary(layout) {
  return (layout.placementOrder || []).map(({ type, row, column }) => ({ type, row, column }));
}

test("AI exposes one universal Hard bounded-search profile", () => {
  assert.equal(engine.aiVersion, "3.4.0");
  const profile = engine.resolveAiSearchProfile();
  assert.equal(profile.name, "hard");
  assert.equal(profile.candidateBudget, 1300);
  assert.equal(profile.finalistLimit, 12);
});

test("Hard explores reverse-pad plans and closes the reported 1327684 weakness", () => {
  const { snapshot } = snapshotFor("1327684");
  const hard = engine.buildAiLayoutFromSnapshot(snapshot);
  assert.equal(hard.profile.padAwareTactics, true);
  assert.ok(hard.simulatedTime >= 40, `Hard only reached ${hard.simulatedTime.toFixed(2)}s`);
  assert.equal(hard.profile.chosenCandidate, "tactical-reverse");
  assert.ok(hard.profile.tacticalTargetLayouts > 0);
  assert.ok(hard.profile.quality.hazardImpact > 20);
  assert.ok(hard.profile.totalMs < 5000, `Hard took ${hard.profile.totalMs.toFixed(1)}ms`);
});

test("AI layout is deterministic when the candidate budget is allowed to finish", () => {
  const { snapshot } = snapshotFor("ai-determinism", {
    aiSearchLimits: { maxBuildMs: 5000 }
  });
  const first = engine.buildAiLayoutFromSnapshot(snapshot);
  const second = engine.buildAiLayoutFromSnapshot(snapshot);
  assert.deepEqual(first.grid, second.grid);
  assert.deepEqual(first.special, second.special);
  assert.deepEqual(placementSummary(first), placementSummary(second));
  assert.equal(first.simulatedTime, second.simulatedTime);
});

test("Hard staged-hazard search solves reported weak seed 793141185", () => {
  const { snapshot } = snapshotFor("793141185");
  const hard = engine.buildAiLayoutFromSnapshot(snapshot);
  assert.ok(hard.simulatedTime >= 35);
  assert.ok(hard.profile.quality.hazardImpact > 10);
  assert.ok(hard.profile.quality.existingStructureContacts >= 10);
  assert.ok(hard.profile.totalMs < 5000, `Hard took ${hard.profile.totalMs.toFixed(1)}ms`);
});

test("every assigned hazard is deliberately placed and produces positive escape-time impact", () => {
  const baseGrid = engine.createEmptyGrid();
  for (const type of ["radius", "row", "column", "gravity", "lightning"]) {
    const layout = engine.buildAiLayoutFromSnapshot({
      baseGrid,
      baseNeutralSpecials: [],
      specialTemplate: engine.createSpecialTemplate(type),
      coinBudget: 4,
      singleBudget: 1,
      rngSeed: engine.hashSeed(`hazard-plan:${type}`),
      aiSearchLimits: {
        beamWidth: 3,
        candidatesPerState: 10,
        candidateBudget: 240,
        finalistLimit: 5,
        maxBuildMs: 2000
      }
    });
    assert.equal(layout.special.type, type);
    assert.ok(layout.special.placed, `${type} was not placed`);
    assert.ok(layout.profile.quality.hazardImpact > 0.1, `${type} did not improve escape time`);
    assert.ok(engine.hasPath(layout.grid), `${type} layout has no valid path`);
  }
});

test("fixed benchmark seeds produce valid, stronger mazes within the universal Hard latency ceiling", () => {
  for (const seed of ["pass-3-benchmark-1", "pass-3-benchmark-2", "pass-3-benchmark-3", "pass-3-benchmark-4"]) {
    const { round, snapshot } = snapshotFor(seed);
    const baseline = engine.buildAiLayoutFromSnapshot({
      ...snapshot,
      coinBudget: 0,
      singleBudget: 0,
      aiSearchLimits: { candidateBudget: 80, finalistLimit: 2, maxBuildMs: 1000 }
    });
    const layout = engine.buildAiLayoutFromSnapshot(snapshot);
    const wallsUsed = placementSummary(layout).filter((entry) => entry.type === "wall").length;
    const singlesUsed = placementSummary(layout).filter((entry) => entry.type === "single").length;
    assert.ok(engine.hasPath(layout.grid));
    assert.ok(layout.simulatedTime >= baseline.simulatedTime);
    assert.ok(layout.profile.quality.hazardImpact > 0);
    assert.ok(layout.profile.quality.existingStructureContacts > 0);
    assert.ok(wallsUsed <= round.coinBudget);
    assert.ok(singlesUsed <= round.singleBudget);
    assert.ok(layout.profile.totalMs < 3000, `${seed} took ${layout.profile.totalMs.toFixed(1)}ms`);
    assert.equal(layout.profile.strategy, "bounded-route-search");
  }
});
