const test = require("node:test");
const assert = require("node:assert/strict");

const teacher = require("../scripts/ai-lab/teacher.js");
const policy = require("../scripts/ai-lab/policy-model.js");
const sequential = require("../scripts/ai-lab/sequential-policy.js");
const sequentialSearch = require("../scripts/ai-lab/sequential-search.js");
const completeLayout = require("../scripts/ai-lab/complete-layout.js");
const completeValue = require("../scripts/ai-lab/complete-value-model.js");
const completeSearch = require("../scripts/ai-lab/complete-search.js");
const interdictionSearch = require("../scripts/ai-lab/interdiction-search.js");

const smokeConfig = {
  evaluations: 180,
  population: 6,
  elitePool: 3,
  coordinatePasses: 0,
  hazardSweepInterval: 90,
  hazardSweepCandidates: 8,
  includeLegacySeed: false,
  includeProductionSeed: false
};

test("AI-lab seed splits are stable and disjoint", () => {
  assert.equal(teacher.seedForSplit("train", 12), "outmaze-train-v1-0000012");
  assert.notEqual(teacher.seedForSplit("train", 12), teacher.seedForSplit("validation", 12));
  assert.notEqual(teacher.seedForSplit("validation", 12), teacher.seedForSplit("test", 12));
});

test("fixed teacher budgets produce identical scores and layouts", () => {
  const first = teacher.solveSeed("teacher-repeatability", smokeConfig);
  const second = teacher.solveSeed("teacher-repeatability", smokeConfig);
  assert.equal(first.metrics.evaluations, smokeConfig.evaluations);
  assert.equal(second.metrics.evaluations, smokeConfig.evaluations);
  assert.equal(first.solution.score, second.solution.score);
  assert.equal(first.solution.signature, second.solution.signature);
});

test("serialized spatial policy preserves deterministic predictions", () => {
  const model = policy.createModel(12, "serialization-test");
  const record = teacher.solveSeed("policy-feature-fixture", smokeConfig);
  const features = policy.candidateFeatures(record, "wall", 4, 7);
  const before = policy.predict(model, features).probability;
  const hydrated = policy.hydrateModel(policy.serializeModel(model));
  const after = policy.predict(hydrated, features).probability;
  assert.ok(Math.abs(before - after) < 1e-7);
});

test("sequential policy features change after a placement", () => {
  const record = teacher.solveSeed("sequential-state-fixture", smokeConfig);
  const state = sequential.createState(record);
  const before = sequential.candidateFeatures(state, "wall", 6, 6);
  const placement = sequential.legalCandidates(state, "wall").find((cell) => {
    const candidate = sequential.cloneState(state);
    return sequential.applyPlacement(candidate, "wall", cell);
  });
  assert.ok(placement);
  assert.ok(sequential.applyPlacement(state, "wall", placement));
  const after = sequential.candidateFeatures(state, "wall", 6, 6);
  assert.notDeepEqual(after, before);
});

test("serialized sequential policy preserves deterministic search", () => {
  const record = teacher.solveSeed("sequential-search-fixture", smokeConfig);
  const model = sequential.createModel(8, "sequential-serialization-test");
  const hydrated = sequential.hydrateModel(sequential.serializeModel(model));
  const options = { beamWidth: 2, branchFactor: 1, candidatePool: 8, stoppedLayouts: 1, hazardCandidates: 2 };
  const first = sequentialSearch.search(hydrated, record, options);
  const second = sequentialSearch.search(hydrated, record, options);
  assert.ok(first.best);
  assert.equal(first.best.score, second.best.score);
  assert.equal(first.best.signature, second.best.signature);
});

test("complete-maze value serialization preserves deterministic predictions", () => {
  const record = teacher.solveSeed("complete-value-fixture", smokeConfig);
  const layout = completeLayout.layoutFromGenome(record, record.solution);
  assert.ok(layout);
  const model = completeValue.createModel(8, "complete-value-serialization", 20, 10);
  const features = completeValue.featureIndices(record, layout);
  const before = completeValue.predictScore(model, features).score;
  const hydrated = completeValue.hydrateModel(completeValue.serializeModel(model));
  const after = completeValue.predictScore(hydrated, features).score;
  assert.ok(Math.abs(before - after) < 1e-5);
});

test("complete-layout learned search is fixed-budget and repeatable", () => {
  const record = teacher.solveSeed("complete-search-fixture", smokeConfig);
  const valueModel = completeValue.createModel(8, "complete-search-value", 20, 10);
  const proposalModel = sequential.createModel(8, "complete-search-proposal");
  const options = {
    generations: 1,
    proposals: 12,
    exactPerGeneration: 2,
    eliteParents: 2,
    exactPopulation: 4,
    sequentialSeeds: 2,
    causalPool: 8
  };
  const first = completeSearch.search(valueModel, proposalModel, record, options);
  const second = completeSearch.search(valueModel, proposalModel, record, options);
  assert.ok(first.best);
  assert.equal(first.exactEvaluations, second.exactEvaluations);
  assert.equal(first.best.score, second.best.score);
  assert.equal(first.best.signature, second.best.signature);
});

test("complete-search safety portfolio cannot score below its bounded baseline", () => {
  const record = teacher.solveSeed("complete-safety-fixture", smokeConfig);
  const valueModel = completeValue.createModel(8, "complete-safety-value", 20, 10);
  const proposalModel = sequential.createModel(8, "complete-safety-proposal");
  const result = completeSearch.search(valueModel, proposalModel, record, {
    generations: 1,
    proposals: 8,
    exactPerGeneration: 2,
    eliteParents: 2,
    exactPopulation: 4,
    sequentialSeeds: 0,
    includeProduction: true,
    productionBudget: 100
  });
  const baseline = result.evaluatedSamples.find((sample) => sample.source === "production");
  assert.ok(baseline);
  assert.ok(result.best.score >= baseline.score);
});

test("interdiction search methods build complete deterministic legal layouts", () => {
  const generated = teacher.solveSeed("interdiction-search-fixture", smokeConfig);
  const record = {
    ...generated,
    budgets: { walls: 4, singles: 1 }
  };
  const options = {
    beamWidth: 2,
    candidatePool: 8,
    branchesPerState: 3,
    alternativePaths: 3,
    maxBundleSize: 3,
    finalistLayouts: 2,
    hazardHeuristicCandidates: 12,
    hazardExactCandidates: 2,
    rolloutCandidatePool: 3,
    maxPathEvaluations: 1200
  };
  for (const method of interdictionSearch.METHODS) {
    const result = interdictionSearch.search(method, record, options);
    assert.ok(result.best, `${method} should produce a finalist`);
    assert.equal(result.best.state.walls.length, record.budgets.walls, `${method} should spend the wall budget`);
    assert.equal(result.best.state.singles.length, record.budgets.singles, `${method} should spend the single budget`);
    assert.ok(Number.isFinite(result.best.score), `${method} should have a simulated time`);
    assert.ok(global.AICore.hasPath(result.best.grid), `${method} should preserve an escape route`);
  }
  const first = interdictionSearch.search("pair-rollout", record, options);
  const second = interdictionSearch.search("pair-rollout", record, options);
  assert.equal(first.best.score, second.best.score);
  assert.equal(first.best.signature, second.best.signature);
});
