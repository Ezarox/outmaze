"use strict";

require("../../ai-core.js");
const engine = global.AICore;
const { search: sequentialSearch } = require("./sequential-search.js");
const { featureIndices, predictScore } = require("./complete-value-model.js");
const {
  cloneGenome,
  genomeSignature,
  layoutFromGenome,
  scoreLayout
} = require("./complete-layout.js");

const DEFAULT_OPTIONS = Object.freeze({
  generations: 3,
  proposals: 160,
  exactPerGeneration: 10,
  eliteParents: 8,
  exactPopulation: 16,
  sequentialSeeds: 8,
  includeProduction: false,
  productionBudget: 0,
  causalPool: 24
});

const WALL_COORDINATES = [];
const CELL_COORDINATES = [];
for (let y = 0; y < engine.constants.GRID_SIZE; y++) {
  for (let x = 0; x < engine.constants.GRID_SIZE; x++) {
    CELL_COORDINATES.push({ x, y });
    if (x < engine.constants.GRID_SIZE - 1 && y < engine.constants.GRID_SIZE - 1) WALL_COORDINATES.push({ x, y });
  }
}

function normalizeOptions(overrides = {}) {
  return {
    generations: Math.max(0, Math.min(12, Number(overrides.generations ?? DEFAULT_OPTIONS.generations) | 0)),
    proposals: Math.max(8, Math.min(1000, Number(overrides.proposals || DEFAULT_OPTIONS.proposals) | 0)),
    exactPerGeneration: Math.max(
      1,
      Math.min(64, Number(overrides.exactPerGeneration || DEFAULT_OPTIONS.exactPerGeneration) | 0)
    ),
    eliteParents: Math.max(1, Math.min(32, Number(overrides.eliteParents || DEFAULT_OPTIONS.eliteParents) | 0)),
    exactPopulation: Math.max(2, Math.min(64, Number(overrides.exactPopulation || DEFAULT_OPTIONS.exactPopulation) | 0)),
    sequentialSeeds: Math.max(
      0,
      Math.min(32, Number(overrides.sequentialSeeds ?? DEFAULT_OPTIONS.sequentialSeeds) | 0)
    ),
    includeProduction: overrides.includeProduction === true,
    productionBudget: Math.max(0, Math.min(4000, Number(overrides.productionBudget || 0) | 0)),
    causalPool: Math.max(0, Math.min(128, Number(overrides.causalPool || DEFAULT_OPTIONS.causalPool) | 0))
  };
}

function compareExact(a, b) {
  return b.score - a.score || a.signature.localeCompare(b.signature);
}

function insertExact(population, candidate, maximum) {
  if (!candidate || population.some((entry) => entry.signature === candidate.signature)) return;
  population.push(candidate);
  population.sort(compareExact);
  if (population.length > maximum) population.length = maximum;
}

function trainingSample(candidate) {
  return {
    score: candidate.score,
    walls: candidate.genome.walls.map((cell) => ({ ...cell })),
    singles: candidate.genome.singles.map((cell) => ({ ...cell })),
    special: candidate.genome.special ? { ...candidate.genome.special } : null,
    triggeredPads: candidate.outcome?.triggeredPads || [],
    signature: candidate.signature,
    source: candidate.source || "unknown"
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

function randomWall(rng) {
  return { ...WALL_COORDINATES[Math.floor(rng() * WALL_COORDINATES.length)] };
}

function randomCell(rng) {
  return { ...CELL_COORDINATES[Math.floor(rng() * CELL_COORDINATES.length)] };
}

function localCell(cell, rng, wall) {
  const maximum = wall ? engine.constants.GRID_SIZE - 2 : engine.constants.GRID_SIZE - 1;
  const radius = 1 + Math.floor(rng() * 5);
  return {
    x: Math.max(0, Math.min(maximum, cell.x + Math.floor(rng() * (radius * 2 + 1)) - radius)),
    y: Math.max(0, Math.min(maximum, cell.y + Math.floor(rng() * (radius * 2 + 1)) - radius))
  };
}

function mutateGenome(parent, other, record, rng) {
  let genome = cloneGenome(parent.genome);
  const operation = Math.floor(rng() * 9);
  if (operation === 0 && other) {
    genome = {
      walls: shuffle(genome.walls.concat(other.genome.walls), rng).slice(0, record.budgets.walls),
      singles: shuffle(genome.singles.concat(other.genome.singles), rng).slice(0, record.budgets.singles),
      special: rng() < 0.5 ? { ...genome.special } : { ...other.genome.special }
    };
  } else if (operation <= 2 && genome.walls.length) {
    const index = Math.floor(rng() * genome.walls.length);
    genome.walls[index] = operation === 1 ? localCell(genome.walls[index], rng, true) : randomWall(rng);
  } else if (operation === 3 && genome.walls.length) {
    const moves = Math.min(genome.walls.length, 2 + Math.floor(rng() * 3));
    for (let move = 0; move < moves; move++) genome.walls[Math.floor(rng() * genome.walls.length)] = randomWall(rng);
  } else if (operation === 4) {
    genome.special = randomCell(rng);
  } else if (operation === 5 && genome.special) {
    genome.special = localCell(genome.special, rng, false);
  } else if (operation === 6 && genome.singles.length) {
    genome.singles[Math.floor(rng() * genome.singles.length)] = randomCell(rng);
  } else if (operation === 7 && genome.singles.length) {
    const index = Math.floor(rng() * genome.singles.length);
    genome.singles[index] = localCell(genome.singles[index], rng, false);
  } else if (genome.walls.length) {
    genome.walls.splice(Math.floor(rng() * genome.walls.length), 1);
  }
  while (genome.walls.length < record.budgets.walls) genome.walls.push(randomWall(rng));
  for (let index = 0; index < 8; index++) genome.walls.push(randomWall(rng));
  while (genome.singles.length < record.budgets.singles) genome.singles.push(randomCell(rng));
  for (let index = 0; index < 3; index++) genome.singles.push(randomCell(rng));
  return genome;
}

function candidateFromSequential(solution) {
  return {
    walls: solution.walls.map((cell) => ({ ...cell })),
    singles: solution.singles.map((cell) => ({ ...cell })),
    special: solution.special?.cell ? { ...solution.special.cell } : null
  };
}

function productionCandidate(record, candidateBudget = 0) {
  const snapshot = {
    baseGrid: record.baseGrid,
    baseNeutralSpecials: record.neutralSpecial ? [record.neutralSpecial] : [],
    specialTemplate: engine.createSpecialTemplate(record.specialType),
    coinBudget: record.budgets.walls,
    singleBudget: record.budgets.singles,
    rngSeed: engine.hashSeed(`${record.seed}:ai`),
    deterministicBudget: true
  };
  if (candidateBudget) {
    snapshot.aiSearchLimits = {
      candidateBudget,
      finalistLimit: 4,
      hazardCandidates: 8
    };
  }
  const layout = engine.buildAiLayoutFromSnapshot(snapshot);
  return {
    walls: engine.listAiWallOrigins(layout.grid).map(({ x, y }) => ({ x, y })),
    singles: engine.listAiSingleCells(layout.grid).map(({ x, y }) => ({ x, y })),
    special: layout.special?.cell ? { ...layout.special.cell } : null
  };
}

function search(valueModel, proposalModel, record, overrides = {}) {
  const options = normalizeOptions(overrides);
  const startedAt = performance.now();
  const rng = engine.mulberry32(engine.hashSeed(`complete-search-v1:${record.seed}`));
  const exactPopulation = [];
  const evaluatedCandidates = new Map();
  let sequentialEvaluations = 0;
  if (options.sequentialSeeds > 0) {
    const sequential = sequentialSearch(proposalModel, record, { causalPool: options.causalPool });
    sequentialEvaluations = sequential.candidatesEvaluated;
    for (const solution of sequential.finalists) {
      const layout = layoutFromGenome(record, candidateFromSequential(solution));
      if (!layout) continue;
      const candidate = {
        ...layout,
        score: solution.score,
        outcome: { triggeredPads: solution.triggeredPads },
        source: "sequential"
      };
      evaluatedCandidates.set(candidate.signature, trainingSample(candidate));
      if (exactPopulation.length < options.sequentialSeeds || solution === sequential.best) {
        insertExact(exactPopulation, candidate, options.exactPopulation);
      }
    }
  }
  let exactEvaluations = sequentialEvaluations;

  let productionBuildMs = 0;
  if (options.includeProduction) {
    const productionStartedAt = performance.now();
    const genome = productionCandidate(record, options.productionBudget);
    productionBuildMs = performance.now() - productionStartedAt;
    const layout = layoutFromGenome(record, genome);
    const scored = layout ? scoreLayout(record, layout) : null;
    exactEvaluations += Number(Boolean(scored));
    if (scored) {
      const candidate = { ...scored, source: "production" };
      evaluatedCandidates.set(candidate.signature, trainingSample(candidate));
      insertExact(exactPopulation, candidate, options.exactPopulation);
    }
  }

  const generationMetrics = [];
  for (let generation = 0; generation < options.generations && exactPopulation.length; generation++) {
    const proposed = new Map();
    let attempts = 0;
    while (proposed.size < options.proposals && attempts < options.proposals * 8) {
      attempts++;
      const parentLimit = Math.min(options.eliteParents, exactPopulation.length);
      const parent = exactPopulation[Math.floor(rng() * rng() * parentLimit)];
      const other = exactPopulation[Math.floor(rng() * parentLimit)];
      const genome = mutateGenome(parent, other, record, rng);
      const layout = layoutFromGenome(record, genome);
      if (!layout || proposed.has(layout.signature) || exactPopulation.some((entry) => entry.signature === layout.signature)) continue;
      const predictedScore = predictScore(valueModel, featureIndices(record, layout)).score;
      proposed.set(layout.signature, { ...layout, predictedScore });
    }
    const ranked = Array.from(proposed.values()).sort(
      (a, b) => b.predictedScore - a.predictedScore || a.signature.localeCompare(b.signature)
    );
    let evaluated = 0;
    const before = exactPopulation[0].score;
    for (const candidate of ranked.slice(0, options.exactPerGeneration)) {
      const scored = scoreLayout(record, candidate);
      exactEvaluations++;
      evaluated++;
      if (scored) {
        const exactCandidate = { ...scored, source: `mutation-${generation + 1}` };
        evaluatedCandidates.set(exactCandidate.signature, trainingSample(exactCandidate));
        insertExact(exactPopulation, exactCandidate, options.exactPopulation);
      }
    }
    generationMetrics.push({
      generation: generation + 1,
      proposals: proposed.size,
      evaluated,
      improvement: exactPopulation[0].score - before
    });
  }

  return {
    best: exactPopulation[0] || null,
    population: exactPopulation,
    evaluatedSamples: Array.from(evaluatedCandidates.values()).sort((a, b) => b.score - a.score || a.signature.localeCompare(b.signature)),
    exactEvaluations,
    sequentialEvaluations,
    generationMetrics,
    productionBuildMs,
    elapsedMs: performance.now() - startedAt,
    options
  };
}

module.exports = { DEFAULT_OPTIONS, normalizeOptions, mutateGenome, search };
