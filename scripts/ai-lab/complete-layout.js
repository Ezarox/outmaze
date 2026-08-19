"use strict";

require("../../ai-core.js");
const engine = global.AICore;

function cloneGenome(genome) {
  return {
    walls: (genome.walls || []).map((cell) => ({ x: cell.x, y: cell.y })),
    singles: (genome.singles || []).map((cell) => ({ x: cell.x, y: cell.y })),
    special: genome.special ? { x: genome.special.x, y: genome.special.y } : null
  };
}

function genomeSignature(genome) {
  const walls = (genome.walls || []).map((cell) => `${cell.x},${cell.y}`).sort().join(";");
  const singles = (genome.singles || []).map((cell) => `${cell.x},${cell.y}`).sort().join(";");
  const special = genome.special ? `${genome.special.x},${genome.special.y}` : "none";
  return `w:${walls}|s:${singles}|h:${special}`;
}

function layoutFromGenome(record, sourceGenome) {
  const grid = engine.cloneGrid(record.baseGrid);
  const genome = { walls: [], singles: [], special: null };
  const seenWalls = new Set();
  for (const cell of sourceGenome.walls || []) {
    if (genome.walls.length >= record.budgets.walls) break;
    const cellKey = `${cell.x},${cell.y}`;
    if (seenWalls.has(cellKey) || !engine.canPlaceBlock(grid, cell.x, cell.y)) continue;
    engine.placeBlock(grid, cell.x, cell.y, engine.cells.PLAYER);
    seenWalls.add(cellKey);
    genome.walls.push({ x: cell.x, y: cell.y });
  }
  const seenSingles = new Set();
  for (const cell of sourceGenome.singles || []) {
    if (genome.singles.length >= record.budgets.singles) break;
    const cellKey = `${cell.x},${cell.y}`;
    if (seenSingles.has(cellKey) || !engine.canPlaceSingle(grid, cell.x, cell.y)) continue;
    grid[cell.y][cell.x] = engine.cells.SINGLE;
    seenSingles.add(cellKey);
    genome.singles.push({ x: cell.x, y: cell.y });
  }
  const specialCell = sourceGenome.special;
  if (!specialCell || !engine.isCellAvailableForSpecial(grid, specialCell.x, specialCell.y)) return null;
  grid[specialCell.y][specialCell.x] = engine.cells.SPECIAL;
  engine.ensureOpenings(grid);
  if (!engine.hasPath(grid)) return null;
  genome.special = { x: specialCell.x, y: specialCell.y };
  const special = engine.createSpecialTemplate(record.specialType);
  special.placed = true;
  special.cell = { ...genome.special };
  return { grid, special, genome, signature: genomeSignature(genome) };
}

function scoreLayout(record, layout) {
  const neutralSpecials = record.neutralSpecial ? [record.neutralSpecial] : [];
  const outcome = engine.simulateRunnerOutcome(layout.grid, layout.special, neutralSpecials);
  if (!outcome || !Number.isFinite(outcome.time)) return null;
  return { ...layout, score: outcome.time, outcome };
}

function scoredLayoutFromGenome(record, genome) {
  const layout = layoutFromGenome(record, genome);
  return layout ? scoreLayout(record, layout) : null;
}

function recordFromRound(round, seed) {
  return {
    seed,
    budgets: { walls: round.coinBudget, singles: round.singleBudget },
    specialType: round.specialTemplate.type,
    neutralSpecial: round.neutralSpecial || null,
    baseGrid: round.baseGrid
  };
}

module.exports = {
  cloneGenome,
  genomeSignature,
  layoutFromGenome,
  scoreLayout,
  scoredLayoutFromGenome,
  recordFromRound
};
