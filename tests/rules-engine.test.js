const test = require("node:test");
const assert = require("node:assert/strict");

require("../ai-core.js");

const engine = global.AICore;
const cells = engine.cells;

function emptyGrid() {
  return engine.createEmptyGrid();
}

function placedHazard(type, x = 10, y = 10) {
  return {
    type,
    placed: true,
    cell: { x, y },
    effectTimer: 0,
    cooldown: 0,
    flashTimer: 0
  };
}

function simulatedWithPad(cellType, y = 17) {
  const grid = emptyGrid();
  grid[y][10] = cellType;
  return engine.simulateRunnerTime(grid, null, []);
}

test("canonical engine exposes a versioned rules surface", () => {
  assert.equal(engine.rulesVersion, "2.0.0");
  assert.equal(engine.constants.GRID_SIZE, 21);
  assert.equal(engine.constants.GRAVITY_MIN_MULT, 0.15);
  assert.equal(engine.constants.GRAVITY_MAX_MULT, 0.85);
});

test("deterministic seed fixtures remain stable", () => {
  const fixtures = [
    ["fixture-alpha", 14, 1, "gravity", null, 11],
    ["fixture-beta", 11, 1, "gravity", null, 9],
    ["fixture-gamma", 19, 1, "row", "column", 14]
  ];

  for (const [seed, coins, singles, hazard, neutral, staticBlocks] of fixtures) {
    const first = engine.createRound(seed);
    const second = engine.createRound(seed);
    assert.deepEqual(first.baseGrid, second.baseGrid);
    assert.equal(first.coinBudget, coins);
    assert.equal(first.singleBudget, singles);
    assert.equal(first.specialTemplate.type, hazard);
    assert.equal(first.neutralSpecial?.type ?? null, neutral);
    assert.equal(engine.countBlocks(first.baseGrid, cells.STATIC), staticBlocks);
    assert.ok(engine.hasPath(first.baseGrid));
  }
});

test("generated rounds never contain two lightning hazards", () => {
  for (let index = 0; index < 300; index++) {
    const round = engine.createRound(`lightning-constraint-${index}`);
    const lightningCount =
      Number(round.specialTemplate.type === "lightning") + Number(round.neutralSpecial?.type === "lightning");
    assert.ok(lightningCount <= 1, `seed ${round.seed} produced ${lightningCount} lightning hazards`);
  }
});

test("every pad changes an exact straight-line simulation in the expected direction", () => {
  const baseline = engine.simulateRunnerTime(emptyGrid(), null, []);
  assert.ok(simulatedWithPad(cells.SPEED) < baseline);
  assert.ok(simulatedWithPad(cells.SLOW) > baseline);
  assert.ok(simulatedWithPad(cells.DETOUR) > baseline);
  assert.ok(simulatedWithPad(cells.STONE) > baseline);
  assert.ok(simulatedWithPad(cells.REWIND) > baseline);
});

test("repeated slow pads stack instead of refreshing one shared effect", () => {
  const baseline = engine.simulateRunnerTime(emptyGrid(), null, []);
  const one = simulatedWithPad(cells.SLOW);
  const grid = emptyGrid();
  grid[17][10] = cells.SLOW;
  grid[16][10] = cells.SLOW;
  const two = engine.simulateRunnerTime(grid, null, []);
  assert.ok(one > baseline);
  assert.ok(two > one);
});

test("exact outcomes expose temporal pad diagnostics", () => {
  const slowGrid = emptyGrid();
  slowGrid[17][10] = cells.SLOW;
  slowGrid[16][10] = cells.SLOW;
  const slow = engine.simulateRunnerOutcome(slowGrid, placedHazard("column"), []);
  assert.ok(slow.diagnostics.slowActiveTime > 0);
  assert.ok(slow.diagnostics.slowStackTime > 0);
  assert.ok(slow.diagnostics.slowHazardOverlapTime > 0);

  const speedGrid = emptyGrid();
  speedGrid[17][10] = cells.SPEED;
  speedGrid[16][10] = cells.SPEED;
  const speed = engine.simulateRunnerOutcome(speedGrid, null, []);
  assert.ok(speed.diagnostics.fastActiveTime > 0);
  assert.ok(speed.diagnostics.fastStackTime > 0);

  const stoneGrid = emptyGrid();
  stoneGrid[17][10] = cells.STONE;
  const stone = engine.simulateRunnerOutcome(stoneGrid, null, []);
  assert.ok(stone.diagnostics.stoneActiveDistance > 0);

  const rewindGrid = emptyGrid();
  rewindGrid[10][10] = cells.REWIND;
  const rewind = engine.simulateRunnerOutcome(rewindGrid, null, []);
  assert.ok(rewind.diagnostics.rewindPrefixTime > 0);

  const detourGrid = emptyGrid();
  detourGrid[17][10] = cells.DETOUR;
  const detour = engine.simulateRunnerOutcome(detourGrid, null, []);
  assert.ok(detour.diagnostics.detourReverseDistance > 0);
});

test("pad opportunity analysis separates pad-specific construction modes", () => {
  const grid = emptyGrid();
  grid[17][10] = cells.STONE;
  grid[12][10] = cells.REWIND;
  grid[8][10] = cells.SPEED;
  const analysis = engine.analyzePadOpportunities(grid);
  assert.deepEqual(new Set(analysis.modes.map((entry) => entry.mode)), new Set(["rewind", "stone", "speed"]));
  assert.ok(analysis.pads.find((pad) => pad.type === "rewind").prefixDistance > 0);
  assert.ok(analysis.pads.find((pad) => pad.type === "stone").bestRay.continuation > 0);
});

test("every hazard increases escape time when placed on the straight route", () => {
  const baseline = engine.simulateRunnerTime(emptyGrid(), null, []);
  for (const type of ["radius", "row", "column", "gravity", "lightning"]) {
    const result = engine.simulateRunnerTime(emptyGrid(), placedHazard(type), []);
    assert.ok(result > baseline, `${type} should increase escape time`);
  }
});

test("pressure field uses the documented nonlinear proximity curve", () => {
  assert.equal(engine.pressureFieldMultiplier(0), 0.15);
  assert.ok(Math.abs(engine.pressureFieldMultiplier(3) - 0.351) < 0.002);
  assert.equal(engine.pressureFieldMultiplier(6), 0.85);
});

test("placement validation rejects overlap and maze-closing placements", () => {
  const grid = emptyGrid();
  assert.equal(engine.canPlaceBlock(grid, 0, 0), true);
  engine.placeBlock(grid, 0, 0, cells.PLAYER);
  assert.equal(engine.canPlaceBlock(grid, 0, 0), false);
  assert.equal(engine.canPlaceSingle(grid, 0, 0), false);

  const choke = emptyGrid();
  for (let x = 0; x < engine.constants.GRID_SIZE; x++) {
    if (x !== engine.constants.ENTRANCE_X) choke[10][x] = cells.STATIC;
  }
  assert.ok(engine.hasPath(choke));
  choke[10][engine.constants.ENTRANCE_X] = cells.SINGLE;
  assert.equal(engine.hasPath(choke), false);
});

test("retry reset restores every one-use pad without mutating the seed definition", () => {
  const grid = emptyGrid();
  const used = [cells.SPEED_USED, cells.SLOW_USED, cells.DETOUR_USED, cells.STONE_USED, cells.REWIND_USED];
  used.forEach((value, index) => {
    grid[index][0] = value;
  });
  engine.resetPadStates(grid);
  assert.deepEqual(
    used.map((_, index) => grid[index][0]),
    [cells.SPEED, cells.SLOW, cells.DETOUR, cells.STONE, cells.REWIND]
  );

  const raceGrid = emptyGrid();
  raceGrid[17][10] = cells.SLOW;
  engine.simulateRunnerTime(raceGrid, null, []);
  assert.equal(raceGrid[17][10], cells.SLOW);
});

test("build timeout reaches a stable expired state", () => {
  assert.deepEqual(engine.advanceBuildClock(1, 0.25), { timeLeft: 0.75, expired: false });
  assert.deepEqual(engine.advanceBuildClock(0.2, 0.5), { timeLeft: 0, expired: true });
  assert.deepEqual(engine.advanceBuildClock(0, 0.5), { timeLeft: 0, expired: true });
});

test("incremental live stepping matches the exact headless simulation", () => {
  const grid = emptyGrid();
  grid[17][10] = cells.SLOW;
  const expected = engine.simulateRunnerTime(grid, placedHazard("row"), []);
  const runner = engine.createRunner("test", engine.cloneGrid(grid), placedHazard("row"), []);
  let steps = 0;
  while (!runner.finished && steps < 100000) {
    engine.advanceRunnerSimulation(runner, engine.constants.FIXED_TIMESTEP);
    steps++;
  }
  assert.ok(runner.finished);
  assert.ok(Math.abs(runner.resultTime - expected) < 1e-9);
});

test("AI and generation profiles report real non-negative timings", () => {
  const round = engine.createRound("performance-fixture");
  assert.ok(round.metrics.generationMs >= 0);
  const layout = engine.buildAiLayoutFromSnapshot({
    baseGrid: round.baseGrid,
    baseNeutralSpecials: round.neutralSpecial ? [round.neutralSpecial] : [],
    specialTemplate: round.specialTemplate,
    coinBudget: 1,
    singleBudget: 0,
    rngSeed: engine.hashSeed("performance-fixture-ai")
  });
  assert.ok(layout.profile.totalMs >= 0);
  assert.ok(layout.profile.reclaimMs >= 0);
  assert.ok(layout.profile.simulationMs >= 0);
  assert.ok(layout.profile.secondaryMs >= 0);
  assert.ok(layout.profile.work.pathSearches > 0);
  assert.ok(layout.profile.work.pathNodesExpanded > 0);
  assert.ok(layout.profile.work.simulations > 0);
  assert.ok(layout.profile.work.simulationSteps > 0);
  assert.ok(layout.profile.work.gridClones > 0);
});
