"use strict";

require("../../ai-core.js");
const engine = global.AICore;
const MODEL_VERSION = "complete-value-v1";
const SPECIAL_TYPES = ["radius", "row", "column", "gravity", "lightning"];
const PAD_TYPES = ["speed", "slow", "detour", "stone", "rewind"];
const CELL_CATEGORIES = 11;
const PATH_PROGRESS_BUCKETS = 8;
const HAZARD_DISTANCE_BUCKETS = 10;

let cursor = 0;
const OFFSETS = {};
function reserve(name, size) {
  OFFSETS[name] = cursor;
  cursor += size;
}

const cellCount = engine.constants.GRID_SIZE * engine.constants.GRID_SIZE;
reserve("cells", cellCount * CELL_CATEGORIES);
reserve("pathProgress", cellCount * PATH_PROGRESS_BUCKETS);
reserve("pathHazardDistance", cellCount * HAZARD_DISTANCE_BUCKETS);
reserve("specialType", SPECIAL_TYPES.length);
reserve("specialX", engine.constants.GRID_SIZE);
reserve("specialY", engine.constants.GRID_SIZE);
reserve("walls", 22);
reserve("wallBudget", 22);
reserve("singles", 3);
reserve("singleBudget", 3);
reserve("pathLength", 32);
reserve("pathTurns", 32);
reserve("pathPads", PAD_TYPES.length * 5);
reserve("hazardPathDistance", HAZARD_DISTANCE_BUCKETS);
reserve("hazardCoverage", 24);
reserve("properties", 12);
const INPUT_SIZE = cursor;

function cellCategory(value) {
  if (value === engine.cells.EMPTY) return 0;
  if (value === engine.cells.STATIC) return 1;
  if (value === engine.cells.PLAYER) return 2;
  if (value === engine.cells.SINGLE) return 3;
  if (value === engine.cells.SPEED || value === engine.cells.SPEED_USED) return 4;
  if (value === engine.cells.SLOW || value === engine.cells.SLOW_USED) return 5;
  if (value === engine.cells.DETOUR || value === engine.cells.DETOUR_USED) return 6;
  if (value === engine.cells.STONE || value === engine.cells.STONE_USED) return 7;
  if (value === engine.cells.REWIND || value === engine.cells.REWIND_USED) return 8;
  if (value === engine.cells.SPECIAL || value === engine.cells.STATIC_SPECIAL) return 9;
  return 10;
}

function padType(value) {
  if (value === engine.cells.SPEED || value === engine.cells.SPEED_USED) return "speed";
  if (value === engine.cells.SLOW || value === engine.cells.SLOW_USED) return "slow";
  if (value === engine.cells.DETOUR || value === engine.cells.DETOUR_USED) return "detour";
  if (value === engine.cells.STONE || value === engine.cells.STONE_USED) return "stone";
  if (value === engine.cells.REWIND || value === engine.cells.REWIND_USED) return "rewind";
  return null;
}

function countTurns(path) {
  if (!path || path.length < 3) return 0;
  let turns = 0;
  let previousX = Math.sign(path[1].x - path[0].x);
  let previousY = Math.sign(path[1].y - path[0].y);
  for (let index = 2; index < path.length; index++) {
    const dx = Math.sign(path[index].x - path[index - 1].x);
    const dy = Math.sign(path[index].y - path[index - 1].y);
    if (dx !== previousX || dy !== previousY) turns++;
    previousX = dx;
    previousY = dy;
  }
  return turns;
}

function featureIndices(record, layout) {
  const indices = [];
  const size = engine.constants.GRID_SIZE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const position = y * size + x;
      indices.push(OFFSETS.cells + position * CELL_CATEGORIES + cellCategory(layout.grid[y][x]));
    }
  }

  const path = engine.computePath(layout.grid);
  const specialCell = layout.special?.cell || layout.genome?.special || { x: engine.constants.ENTRANCE_X, y: 0 };
  const pathPads = Object.fromEntries(PAD_TYPES.map((type) => [type, 0]));
  const countedPads = new Set();
  let nearestHazard = Infinity;
  let hazardCoverage = 0;
  for (let index = 0; index < path.length; index++) {
    const cell = path[index];
    if (!engine.isInsideGrid(cell.x, cell.y)) continue;
    const position = cell.y * size + cell.x;
    const progress = path.length > 1 ? index / (path.length - 1) : 0;
    indices.push(
      OFFSETS.pathProgress +
        position * PATH_PROGRESS_BUCKETS +
        Math.max(0, Math.min(PATH_PROGRESS_BUCKETS - 1, Math.floor(progress * PATH_PROGRESS_BUCKETS)))
    );
    const distance = Math.hypot(cell.x - specialCell.x, cell.y - specialCell.y);
    nearestHazard = Math.min(nearestHazard, distance);
    const distanceBucket = Math.max(0, Math.min(HAZARD_DISTANCE_BUCKETS - 1, Math.floor(distance)));
    indices.push(OFFSETS.pathHazardDistance + position * HAZARD_DISTANCE_BUCKETS + distanceBucket);
    if (distance <= engine.constants.GRAVITY_RADIUS) hazardCoverage++;
    const padKey = `${cell.x},${cell.y}`;
    if (!countedPads.has(padKey)) {
      countedPads.add(padKey);
      const type = padType(layout.grid[cell.y][cell.x]);
      if (type) pathPads[type]++;
    }
  }

  indices.push(OFFSETS.specialType + Math.max(0, SPECIAL_TYPES.indexOf(record.specialType)));
  indices.push(OFFSETS.specialX + Math.max(0, Math.min(size - 1, specialCell.x)));
  indices.push(OFFSETS.specialY + Math.max(0, Math.min(size - 1, specialCell.y)));
  indices.push(OFFSETS.walls + Math.max(0, Math.min(21, layout.genome?.walls?.length || 0)));
  indices.push(OFFSETS.wallBudget + Math.max(0, Math.min(21, record.budgets.walls)));
  indices.push(OFFSETS.singles + Math.max(0, Math.min(2, layout.genome?.singles?.length || 0)));
  indices.push(OFFSETS.singleBudget + Math.max(0, Math.min(2, record.budgets.singles)));
  indices.push(OFFSETS.pathLength + Math.max(0, Math.min(31, Math.floor(path.length / 4))));
  indices.push(OFFSETS.pathTurns + Math.max(0, Math.min(31, countTurns(path))));
  for (let index = 0; index < PAD_TYPES.length; index++) {
    indices.push(OFFSETS.pathPads + index * 5 + Math.max(0, Math.min(4, pathPads[PAD_TYPES[index]])));
  }
  indices.push(
    OFFSETS.hazardPathDistance +
      Math.max(0, Math.min(HAZARD_DISTANCE_BUCKETS - 1, Number.isFinite(nearestHazard) ? Math.floor(nearestHazard) : 9))
  );
  indices.push(OFFSETS.hazardCoverage + Math.max(0, Math.min(23, Math.floor(hazardCoverage / 2))));
  const propertyOffset = OFFSETS.properties;
  if (pathPads.speed) indices.push(propertyOffset + 0);
  if (pathPads.slow) indices.push(propertyOffset + 1);
  if (pathPads.detour) indices.push(propertyOffset + 2);
  if (pathPads.stone) indices.push(propertyOffset + 3);
  if (pathPads.rewind) indices.push(propertyOffset + 4);
  if (nearestHazard <= 1.5) indices.push(propertyOffset + 5);
  if (hazardCoverage >= 8) indices.push(propertyOffset + 6);
  if (path.length >= 60) indices.push(propertyOffset + 7);
  if (countTurns(path) >= 12) indices.push(propertyOffset + 8);
  if ((layout.genome?.walls?.length || 0) >= record.budgets.walls) indices.push(propertyOffset + 9);
  if ((layout.genome?.singles?.length || 0) >= record.budgets.singles) indices.push(propertyOffset + 10);
  if (record.neutralSpecial) indices.push(propertyOffset + 11);
  return Uint16Array.from(indices);
}

function createModel(hiddenSize, seed, targetMean = 0, targetStd = 1) {
  const rng = engine.mulberry32(engine.hashSeed(`${MODEL_VERSION}:${seed}`));
  const scale = Math.sqrt(6 / (INPUT_SIZE + hiddenSize));
  const inputWeights = new Float32Array(INPUT_SIZE * hiddenSize);
  const outputWeights = new Float32Array(hiddenSize);
  for (let index = 0; index < inputWeights.length; index++) inputWeights[index] = (rng() * 2 - 1) * scale;
  for (let index = 0; index < outputWeights.length; index++) outputWeights[index] = (rng() * 2 - 1) * scale;
  return {
    modelVersion: MODEL_VERSION,
    inputSize: INPUT_SIZE,
    hiddenSize,
    inputWeights,
    hiddenBias: new Float32Array(hiddenSize),
    outputWeights,
    outputBias: 0,
    targetMean,
    targetStd: Math.max(1e-6, targetStd)
  };
}

function hydrateModel(data) {
  if (data.modelVersion !== MODEL_VERSION) throw new Error(`Expected ${MODEL_VERSION}, received ${data.modelVersion}.`);
  return {
    ...data,
    inputWeights: Float32Array.from(data.inputWeights),
    hiddenBias: Float32Array.from(data.hiddenBias),
    outputWeights: Float32Array.from(data.outputWeights)
  };
}

function serializeModel(model, metadata = {}) {
  return {
    modelVersion: model.modelVersion,
    inputSize: model.inputSize,
    hiddenSize: model.hiddenSize,
    inputWeights: Array.from(model.inputWeights, (value) => Number(value.toFixed(7))),
    hiddenBias: Array.from(model.hiddenBias, (value) => Number(value.toFixed(7))),
    outputWeights: Array.from(model.outputWeights, (value) => Number(value.toFixed(7))),
    outputBias: Number(model.outputBias.toFixed(7)),
    targetMean: model.targetMean,
    targetStd: model.targetStd,
    metadata
  };
}

function predictNormalized(model, activeIndices, hiddenBuffer = null) {
  const hidden = hiddenBuffer || new Float32Array(model.hiddenSize);
  for (let unit = 0; unit < model.hiddenSize; unit++) {
    let value = model.hiddenBias[unit];
    const offset = unit * model.inputSize;
    for (const index of activeIndices) value += model.inputWeights[offset + index];
    hidden[unit] = value > 0 ? value : 0;
  }
  let value = model.outputBias;
  for (let unit = 0; unit < model.hiddenSize; unit++) value += hidden[unit] * model.outputWeights[unit];
  return { value, hidden };
}

function predictScore(model, activeIndices, hiddenBuffer = null) {
  const prediction = predictNormalized(model, activeIndices, hiddenBuffer);
  return { score: prediction.value * model.targetStd + model.targetMean, normalized: prediction.value, hidden: prediction.hidden };
}

module.exports = {
  MODEL_VERSION,
  INPUT_SIZE,
  featureIndices,
  createModel,
  hydrateModel,
  serializeModel,
  predictNormalized,
  predictScore
};
