"use strict";

require("../../ai-core.js");

const engine = global.AICore;
const MODEL_VERSION = "spatial-policy-v1";
const ACTION_TYPES = ["wall", "single", "special"];
const SPECIAL_TYPES = ["radius", "row", "column", "gravity", "lightning"];
const PATCH_RADIUS = 2;
const PATCH_SIZE = PATCH_RADIUS * 2 + 1;
const CELL_CATEGORIES = 9;
const OFFSETS = Object.freeze({
  patch: 0,
  action: PATCH_SIZE * PATCH_SIZE * CELL_CATEGORIES,
  special: PATCH_SIZE * PATCH_SIZE * CELL_CATEGORIES + ACTION_TYPES.length,
  x: PATCH_SIZE * PATCH_SIZE * CELL_CATEGORIES + ACTION_TYPES.length + SPECIAL_TYPES.length,
  y: PATCH_SIZE * PATCH_SIZE * CELL_CATEGORIES + ACTION_TYPES.length + SPECIAL_TYPES.length + engine.constants.GRID_SIZE,
  walls:
    PATCH_SIZE * PATCH_SIZE * CELL_CATEGORIES +
    ACTION_TYPES.length +
    SPECIAL_TYPES.length +
    engine.constants.GRID_SIZE * 2,
  singles:
    PATCH_SIZE * PATCH_SIZE * CELL_CATEGORIES +
    ACTION_TYPES.length +
    SPECIAL_TYPES.length +
    engine.constants.GRID_SIZE * 3
});
const INPUT_SIZE = OFFSETS.singles + 4;

function cellCategory(value) {
  if (value === engine.cells.EMPTY) return 0;
  if (value === engine.cells.STATIC) return 1;
  if (value === engine.cells.SPEED || value === engine.cells.SPEED_USED) return 2;
  if (value === engine.cells.SLOW || value === engine.cells.SLOW_USED) return 3;
  if (value === engine.cells.DETOUR || value === engine.cells.DETOUR_USED) return 4;
  if (value === engine.cells.STONE || value === engine.cells.STONE_USED) return 5;
  if (value === engine.cells.REWIND || value === engine.cells.REWIND_USED) return 6;
  if (value === engine.cells.STATIC_SPECIAL) return 7;
  return 8;
}

function candidateFeatures(record, actionType, x, y) {
  const indices = [];
  let patchIndex = 0;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      const gx = x + dx;
      const gy = y + dy;
      const category = engine.isInsideGrid(gx, gy) ? cellCategory(record.baseGrid[gy][gx]) : 8;
      indices.push(OFFSETS.patch + patchIndex * CELL_CATEGORIES + category);
      patchIndex++;
    }
  }
  indices.push(OFFSETS.action + Math.max(0, ACTION_TYPES.indexOf(actionType)));
  indices.push(OFFSETS.special + Math.max(0, SPECIAL_TYPES.indexOf(record.specialType)));
  indices.push(OFFSETS.x + Math.max(0, Math.min(engine.constants.GRID_SIZE - 1, x)));
  indices.push(OFFSETS.y + Math.max(0, Math.min(engine.constants.GRID_SIZE - 1, y)));
  indices.push(OFFSETS.walls + Math.max(0, Math.min(engine.constants.GRID_SIZE - 1, record.budgets.walls)));
  indices.push(OFFSETS.singles + Math.max(0, Math.min(3, record.budgets.singles)));
  return indices;
}

function createModel(hiddenSize, seed) {
  const rng = engine.mulberry32(engine.hashSeed(`${MODEL_VERSION}:${seed}`));
  const scale = Math.sqrt(6 / (INPUT_SIZE + hiddenSize));
  const inputWeights = new Float64Array(INPUT_SIZE * hiddenSize);
  const outputWeights = new Float64Array(hiddenSize);
  for (let index = 0; index < inputWeights.length; index++) inputWeights[index] = (rng() * 2 - 1) * scale;
  for (let index = 0; index < outputWeights.length; index++) outputWeights[index] = (rng() * 2 - 1) * scale;
  return {
    modelVersion: MODEL_VERSION,
    inputSize: INPUT_SIZE,
    hiddenSize,
    inputWeights,
    hiddenBias: new Float64Array(hiddenSize),
    outputWeights,
    outputBias: 0
  };
}

function hydrateModel(data) {
  return {
    ...data,
    inputWeights: Float64Array.from(data.inputWeights),
    hiddenBias: Float64Array.from(data.hiddenBias),
    outputWeights: Float64Array.from(data.outputWeights)
  };
}

function serializeModel(model, metadata = {}) {
  return {
    modelVersion: model.modelVersion,
    inputSize: model.inputSize,
    hiddenSize: model.hiddenSize,
    inputWeights: Array.from(model.inputWeights, (value) => Number(value.toFixed(8))),
    hiddenBias: Array.from(model.hiddenBias, (value) => Number(value.toFixed(8))),
    outputWeights: Array.from(model.outputWeights, (value) => Number(value.toFixed(8))),
    outputBias: Number(model.outputBias.toFixed(8)),
    metadata
  };
}

function predict(model, activeIndices, hiddenBuffer = null) {
  const hidden = hiddenBuffer || new Float64Array(model.hiddenSize);
  for (let unit = 0; unit < model.hiddenSize; unit++) {
    let value = model.hiddenBias[unit];
    const offset = unit * model.inputSize;
    for (const index of activeIndices) value += model.inputWeights[offset + index];
    hidden[unit] = value > 0 ? value : 0;
  }
  let logit = model.outputBias;
  for (let unit = 0; unit < model.hiddenSize; unit++) logit += hidden[unit] * model.outputWeights[unit];
  const probability = logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
  return { probability, hidden };
}

function legalCandidates(record, actionType) {
  const grid = engine.cloneGrid(record.baseGrid);
  const candidates = [];
  const maximum = actionType === "wall" ? engine.constants.GRID_SIZE - 1 : engine.constants.GRID_SIZE;
  for (let y = 0; y < maximum; y++) {
    for (let x = 0; x < maximum; x++) {
      if (actionType === "wall" && engine.canPlaceBlock(grid, x, y)) candidates.push({ x, y });
      else if (actionType === "single" && engine.canPlaceSingle(grid, x, y)) candidates.push({ x, y });
      else if (actionType === "special" && engine.isCellAvailableForSpecial(grid, x, y)) candidates.push({ x, y });
    }
  }
  return candidates;
}

function rankCandidates(model, record, actionType) {
  return legalCandidates(record, actionType)
    .map((cell) => ({
      ...cell,
      probability: predict(model, candidateFeatures(record, actionType, cell.x, cell.y)).probability
    }))
    .sort((a, b) => b.probability - a.probability || a.y - b.y || a.x - b.x);
}

module.exports = {
  MODEL_VERSION,
  ACTION_TYPES,
  INPUT_SIZE,
  candidateFeatures,
  createModel,
  hydrateModel,
  serializeModel,
  predict,
  legalCandidates,
  rankCandidates
};
