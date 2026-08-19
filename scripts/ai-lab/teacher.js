"use strict";

require("../../ai-core.js");

const engine = global.AICore;
const TEACHER_VERSION = "teacher-evolution-v1";
const DEFAULT_CONFIG = Object.freeze({
  evaluations: 5000,
  population: 32,
  elitePool: 12,
  maxMutationMoves: 4,
  crossoverRate: 0.22,
  hazardSweepInterval: 900,
  hazardSweepCandidates: 72,
  coordinatePasses: 1,
  includeLegacySeed: true,
  includeProductionSeed: true
});

function normalizeConfig(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  config.evaluations = Math.max(100, config.evaluations | 0);
  config.population = Math.max(4, config.population | 0);
  config.elitePool = Math.max(2, Math.min(config.population, config.elitePool | 0));
  config.maxMutationMoves = Math.max(1, Math.min(12, config.maxMutationMoves | 0));
  config.crossoverRate = Math.max(0, Math.min(1, Number(config.crossoverRate)));
  config.hazardSweepInterval = Math.max(0, config.hazardSweepInterval | 0);
  config.hazardSweepCandidates = Math.max(0, config.hazardSweepCandidates | 0);
  config.coordinatePasses = Math.max(0, Math.min(8, config.coordinatePasses | 0));
  config.includeLegacySeed = config.includeLegacySeed !== false;
  config.includeProductionSeed = config.includeProductionSeed !== false;
  return config;
}

function configFingerprint(config) {
  const stable = Object.keys(config)
    .sort()
    .map((key) => `${key}:${config[key]}`)
    .join("|");
  return engine.hashSeed(`${TEACHER_VERSION}|${engine.rulesVersion}|${stable}`).toString(16).padStart(8, "0");
}

function seedForSplit(split, index) {
  const safeSplit = String(split || "train").toLowerCase();
  if (!new Set(["train", "validation", "test"]).has(safeSplit)) {
    throw new Error(`Unknown split '${split}'. Use train, validation, or test.`);
  }
  return `outmaze-${safeSplit}-v1-${String(index).padStart(7, "0")}`;
}

function makeSnapshot(round, seed) {
  return {
    baseGrid: round.baseGrid,
    baseNeutralSpecials: round.neutralSpecial ? [round.neutralSpecial] : [],
    specialTemplate: round.specialTemplate,
    coinBudget: round.coinBudget,
    singleBudget: round.singleBudget,
    rngSeed: engine.hashSeed(`${seed}:ai`)
  };
}

function shuffle(values, rng) {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function coordinatePool(kind) {
  const values = [];
  const maximum = kind === "wall" ? engine.constants.GRID_SIZE - 1 : engine.constants.GRID_SIZE;
  for (let y = 0; y < maximum; y++) {
    for (let x = 0; x < maximum; x++) values.push({ x, y });
  }
  return values;
}

const WALL_COORDINATES = coordinatePool("wall");
const CELL_COORDINATES = coordinatePool("cell");

function cloneGenome(genome) {
  return {
    walls: (genome.walls || []).map((cell) => ({ ...cell })),
    singles: (genome.singles || []).map((cell) => ({ ...cell })),
    special: genome.special ? { ...genome.special } : null
  };
}

function genomeSignature(genome) {
  const walls = genome.walls
    .map((cell) => `${cell.x},${cell.y}`)
    .sort()
    .join(";");
  const singles = genome.singles
    .map((cell) => `${cell.x},${cell.y}`)
    .sort()
    .join(";");
  const special = genome.special ? `${genome.special.x},${genome.special.y}` : "none";
  return `w:${walls}|s:${singles}|h:${special}`;
}

function extractGenome(layout) {
  return {
    walls: engine.listAiWallOrigins(layout.grid).map(({ x, y }) => ({ x, y })),
    singles: engine.listAiSingleCells(layout.grid).map(({ x, y }) => ({ x, y })),
    special: layout.special?.cell ? { ...layout.special.cell } : null
  };
}

function repairGenome(round, sourceGenome, rng) {
  const grid = engine.cloneGrid(round.baseGrid);
  const walls = [];
  const wallProposals = sourceGenome.walls || [];
  for (const cell of wallProposals) {
    if (walls.length >= round.coinBudget) break;
    if (!engine.canPlaceBlock(grid, cell.x, cell.y)) continue;
    engine.placeBlock(grid, cell.x, cell.y, engine.cells.PLAYER);
    engine.ensureOpenings(grid);
    if (!engine.hasPath(grid)) {
      engine.clearBlock(grid, cell.x, cell.y);
      engine.ensureOpenings(grid);
      continue;
    }
    walls.push({ x: cell.x, y: cell.y });
  }
  const singles = [];
  for (const cell of sourceGenome.singles || []) {
    if (singles.length >= round.singleBudget) break;
    if (!engine.canPlaceSingle(grid, cell.x, cell.y)) continue;
    grid[cell.y][cell.x] = engine.cells.SINGLE;
    engine.ensureOpenings(grid);
    if (!engine.hasPath(grid)) {
      grid[cell.y][cell.x] = engine.cells.EMPTY;
      engine.ensureOpenings(grid);
      continue;
    }
    singles.push({ x: cell.x, y: cell.y });
  }
  let special = sourceGenome.special ? { ...sourceGenome.special } : null;
  if (!special || !engine.isCellAvailableForSpecial(grid, special.x, special.y)) {
    const available = CELL_COORDINATES.filter((cell) => engine.isCellAvailableForSpecial(grid, cell.x, cell.y));
    if (!available.length) return null;
    special = available[Math.floor(rng() * available.length)];
  }
  grid[special.y][special.x] = engine.cells.SPECIAL;
  engine.ensureOpenings(grid);
  if (!engine.hasPath(grid)) return null;
  const placedSpecial = engine.createSpecialTemplate(round.specialTemplate.type);
  placedSpecial.placed = true;
  placedSpecial.cell = { ...special };
  return { grid, special: placedSpecial, genome: { walls, singles, special: { ...special } } };
}

function evaluateRepaired(round, repaired) {
  if (!repaired) return null;
  const neutralSpecials = round.neutralSpecial ? [round.neutralSpecial] : [];
  const outcome = engine.simulateRunnerOutcome(repaired.grid, repaired.special, neutralSpecials);
  if (!outcome || !Number.isFinite(outcome.time)) return null;
  return {
    ...repaired,
    score: outcome.time,
    outcome,
    signature: genomeSignature(repaired.genome)
  };
}

function randomGenome(round, rng) {
  const wallTarget = Math.floor(round.coinBudget * (0.65 + rng() * 0.36));
  const singleTarget = Math.floor(round.singleBudget * (0.5 + rng() * 0.51));
  return {
    walls: shuffle(WALL_COORDINATES, rng).slice(0, wallTarget * 5 + 8),
    singles: shuffle(CELL_COORDINATES, rng).slice(0, singleTarget * 5 + 4),
    special: { ...CELL_COORDINATES[Math.floor(rng() * CELL_COORDINATES.length)] }
  };
}

function mutateGenome(parent, otherParent, round, rng, config) {
  let genome;
  if (otherParent && rng() < config.crossoverRate) {
    genome = {
      walls: shuffle(parent.genome.walls.concat(otherParent.genome.walls), rng).slice(0, round.coinBudget),
      singles: shuffle(parent.genome.singles.concat(otherParent.genome.singles), rng).slice(0, round.singleBudget),
      special: rng() < 0.5 ? { ...parent.genome.special } : { ...otherParent.genome.special }
    };
  } else {
    genome = cloneGenome(parent.genome);
  }
  const moveCount = 1 + Math.floor(rng() * config.maxMutationMoves);
  for (let move = 0; move < moveCount; move++) {
    const operation = Math.floor(rng() * 5);
    if (operation <= 1) {
      if (genome.walls.length && rng() < 0.82) {
        const index = Math.floor(rng() * genome.walls.length);
        genome.walls[index] = { ...WALL_COORDINATES[Math.floor(rng() * WALL_COORDINATES.length)] };
      } else if (genome.walls.length < round.coinBudget) {
        genome.walls.push({ ...WALL_COORDINATES[Math.floor(rng() * WALL_COORDINATES.length)] });
      }
    } else if (operation === 2) {
      if (genome.walls.length && rng() < 0.55) genome.walls.splice(Math.floor(rng() * genome.walls.length), 1);
      else if (genome.walls.length < round.coinBudget) {
        genome.walls.push({ ...WALL_COORDINATES[Math.floor(rng() * WALL_COORDINATES.length)] });
      }
    } else if (operation === 3) {
      if (genome.singles.length && rng() < 0.75) {
        genome.singles[Math.floor(rng() * genome.singles.length)] = {
          ...CELL_COORDINATES[Math.floor(rng() * CELL_COORDINATES.length)]
        };
      } else if (genome.singles.length < round.singleBudget) {
        genome.singles.push({ ...CELL_COORDINATES[Math.floor(rng() * CELL_COORDINATES.length)] });
      }
    } else {
      genome.special = { ...CELL_COORDINATES[Math.floor(rng() * CELL_COORDINATES.length)] };
    }
  }
  return genome;
}

function compareSolutions(a, b) {
  const scoreDelta = b.score - a.score;
  if (Math.abs(scoreDelta) > 1e-9) return scoreDelta;
  return a.signature.localeCompare(b.signature);
}

function insertPopulation(population, solution, maximum) {
  if (!solution || population.some((entry) => entry.signature === solution.signature)) return;
  population.push(solution);
  population.sort(compareSolutions);
  if (population.length > maximum) population.length = maximum;
}

function hazardSweep(round, solution, rng, candidateCount, remainingBudget) {
  if (!solution || remainingBudget <= 0 || candidateCount <= 0) return { best: solution, evaluations: 0 };
  const rawGrid = engine.cloneGrid(solution.grid);
  if (solution.special?.cell) rawGrid[solution.special.cell.y][solution.special.cell.x] = engine.cells.EMPTY;
  engine.ensureOpenings(rawGrid);
  const available = shuffle(
    CELL_COORDINATES.filter((cell) => engine.isCellAvailableForSpecial(rawGrid, cell.x, cell.y)),
    rng
  ).slice(0, Math.min(candidateCount, remainingBudget));
  let best = solution;
  let evaluations = 0;
  for (const cell of available) {
    const genome = cloneGenome(solution.genome);
    genome.special = { ...cell };
    const evaluated = evaluateRepaired(round, repairGenome(round, genome, rng));
    evaluations++;
    if (evaluated && compareSolutions(evaluated, best) < 0) best = evaluated;
  }
  return { best, evaluations };
}

function coordinateRefinement(round, initial, rng, passes, remainingBudget) {
  let best = initial;
  let evaluations = 0;
  for (let pass = 0; pass < passes && evaluations < remainingBudget; pass++) {
    let passChanged = false;
    const wallCount = best.genome.walls.length;
    for (let wallIndex = 0; wallIndex < wallCount && evaluations < remainingBudget; wallIndex++) {
      let coordinateBest = best;
      for (const cell of WALL_COORDINATES) {
        if (evaluations >= remainingBudget) break;
        const genome = cloneGenome(best.genome);
        genome.walls[wallIndex] = { ...cell };
        const candidate = evaluateRepaired(round, repairGenome(round, genome, rng));
        evaluations++;
        if (
          candidate &&
          candidate.genome.walls.length === best.genome.walls.length &&
          compareSolutions(candidate, coordinateBest) < 0
        ) {
          coordinateBest = candidate;
        }
      }
      if (coordinateBest.signature !== best.signature) {
        best = coordinateBest;
        passChanged = true;
      }
    }
    const singleCount = best.genome.singles.length;
    for (let singleIndex = 0; singleIndex < singleCount && evaluations < remainingBudget; singleIndex++) {
      let coordinateBest = best;
      for (const cell of CELL_COORDINATES) {
        if (evaluations >= remainingBudget) break;
        const genome = cloneGenome(best.genome);
        genome.singles[singleIndex] = { ...cell };
        const candidate = evaluateRepaired(round, repairGenome(round, genome, rng));
        evaluations++;
        if (
          candidate &&
          candidate.genome.singles.length === best.genome.singles.length &&
          compareSolutions(candidate, coordinateBest) < 0
        ) {
          coordinateBest = candidate;
        }
      }
      if (coordinateBest.signature !== best.signature) {
        best = coordinateBest;
        passChanged = true;
      }
    }
    const hazardResult = hazardSweep(round, best, rng, CELL_COORDINATES.length, remainingBudget - evaluations);
    evaluations += hazardResult.evaluations;
    if (hazardResult.best.signature !== best.signature) {
      best = hazardResult.best;
      passChanged = true;
    }
    if (!passChanged) break;
  }
  return { best, evaluations };
}

function solveSeed(seed, overrides = {}, onProgress = null) {
  const config = normalizeConfig(overrides);
  const fingerprint = configFingerprint(config);
  const round = engine.createRound(seed);
  const rng = engine.mulberry32(engine.hashSeed(`${TEACHER_VERSION}:${fingerprint}:${seed}`));
  const population = [];
  let evaluations = 0;
  let legacyTime = null;
  let legacyBuildMs = null;
  let productionTime = null;
  let productionBuildMs = null;
  const startedAt = performance.now();

  if (config.includeLegacySeed) {
    const legacyStartedAt = performance.now();
    const legacy = engine.buildLegacyAiLayoutFromSnapshot(makeSnapshot(round, seed));
    legacyBuildMs = performance.now() - legacyStartedAt;
    const seeded = evaluateRepaired(round, repairGenome(round, extractGenome(legacy), rng));
    evaluations++;
    if (seeded) {
      legacyTime = seeded.score;
      insertPopulation(population, seeded, config.population);
    }
  }

  if (config.includeProductionSeed && evaluations < config.evaluations) {
    const productionStartedAt = performance.now();
    const production = engine.buildAiLayoutFromSnapshot({
      ...makeSnapshot(round, seed),
      deterministicBudget: true
    });
    productionBuildMs = performance.now() - productionStartedAt;
    const seeded = evaluateRepaired(round, repairGenome(round, extractGenome(production), rng));
    evaluations++;
    if (seeded) {
      productionTime = seeded.score;
      insertPopulation(population, seeded, config.population);
    }
  }

  const empty = evaluateRepaired(round, repairGenome(round, { walls: [], singles: [], special: null }, rng));
  evaluations++;
  insertPopulation(population, empty, config.population);

  while (population.length < config.population && evaluations < config.evaluations) {
    const candidate = evaluateRepaired(round, repairGenome(round, randomGenome(round, rng), rng));
    evaluations++;
    insertPopulation(population, candidate, config.population);
  }

  if (config.coordinatePasses > 0 && population.length && evaluations < config.evaluations) {
    const refined = coordinateRefinement(
      round,
      population[0],
      rng,
      config.coordinatePasses,
      config.evaluations - evaluations
    );
    evaluations += refined.evaluations;
    insertPopulation(population, refined.best, config.population);
  }

  let nextSweepAt = config.hazardSweepInterval > 0 ? config.hazardSweepInterval : Infinity;
  while (evaluations < config.evaluations) {
    if (evaluations >= nextSweepAt && population.length) {
      const sweep = hazardSweep(
        round,
        population[0],
        rng,
        config.hazardSweepCandidates,
        config.evaluations - evaluations
      );
      evaluations += sweep.evaluations;
      insertPopulation(population, sweep.best, config.population);
      nextSweepAt += config.hazardSweepInterval;
      continue;
    }
    const parentLimit = Math.min(config.elitePool, population.length);
    const parent = population[Math.min(parentLimit - 1, Math.floor(rng() * rng() * parentLimit))];
    const other = population[Math.floor(rng() * parentLimit)];
    const genome = mutateGenome(parent, other, round, rng, config);
    const candidate = evaluateRepaired(round, repairGenome(round, genome, rng));
    evaluations++;
    insertPopulation(population, candidate, config.population);
    if (onProgress && evaluations % 500 === 0) onProgress({ evaluations, best: population[0]?.score || 0 });
  }

  const best = population[0];
  if (!best) throw new Error(`Teacher failed to construct a valid layout for seed ${seed}.`);
  return {
    schemaVersion: 1,
    teacherVersion: TEACHER_VERSION,
    rulesVersion: engine.rulesVersion,
    config,
    configFingerprint: fingerprint,
    seed,
    budgets: { walls: round.coinBudget, singles: round.singleBudget },
    specialType: round.specialTemplate.type,
    neutralSpecial: round.neutralSpecial || null,
    baseGrid: round.baseGrid,
    solution: {
      score: best.score,
      walls: best.genome.walls,
      singles: best.genome.singles,
      special: best.genome.special,
      triggeredPads: best.outcome.triggeredPads,
      signature: best.signature
    },
    baselines: { legacyTime, legacyBuildMs, productionTime, productionBuildMs },
    metrics: {
      evaluations,
      elapsedMs: performance.now() - startedAt,
      populationSize: population.length,
      improvementOverLegacy: legacyTime == null ? null : best.score - legacyTime,
      improvementOverProduction: productionTime == null ? null : best.score - productionTime
    },
    trainingSamples: population.map((entry) => ({
      score: entry.score,
      walls: entry.genome.walls,
      singles: entry.genome.singles,
      special: entry.genome.special,
      triggeredPads: entry.outcome.triggeredPads,
      signature: entry.signature
    }))
  };
}

module.exports = {
  TEACHER_VERSION,
  DEFAULT_CONFIG,
  normalizeConfig,
  configFingerprint,
  seedForSplit,
  solveSeed
};
