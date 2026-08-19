"use strict";

require("../../ai-core.js");

const engine = global.AICore;
const MODEL_VERSION = "sequential-policy-v3";
const ACTION_TYPES = ["wall", "single", "special", "stop-wall", "stop-single"];
const SPECIAL_TYPES = ["radius", "row", "column", "gravity", "lightning"];
const PATCH_RADIUS = 3;
const PATCH_SIZE = PATCH_RADIUS * 2 + 1;
const CELL_CATEGORIES = 11;
const PATH_DISTANCE_BUCKETS = 10;
const PATH_PROGRESS_BUCKETS = 12;
const PATH_LENGTH_BUCKETS = 16;
const PAD_DISTANCE_BUCKETS = 10;
const PAD_TYPES = ["speed", "slow", "detour", "stone", "rewind"];

let cursor = 0;
const OFFSETS = {};
function reserve(name, size) {
  OFFSETS[name] = cursor;
  cursor += size;
}

reserve("patch", PATCH_SIZE * PATCH_SIZE * CELL_CATEGORIES);
reserve("pathPatch", PATCH_SIZE * PATCH_SIZE);
reserve("action", ACTION_TYPES.length);
reserve("specialType", SPECIAL_TYPES.length);
reserve("x", engine.constants.GRID_SIZE);
reserve("y", engine.constants.GRID_SIZE);
reserve("diagonalSum", engine.constants.GRID_SIZE * 2 - 1);
reserve("diagonalDifference", engine.constants.GRID_SIZE * 2 - 1);
reserve("wallsRemaining", 22);
reserve("singlesRemaining", 3);
reserve("wallsPlaced", 22);
reserve("singlesPlaced", 3);
reserve("pathDistance", PATH_DISTANCE_BUCKETS);
reserve("pathProgress", PATH_PROGRESS_BUCKETS);
reserve("pathLength", PATH_LENGTH_BUCKETS);
reserve("padDistance", PAD_TYPES.length * PAD_DISTANCE_BUCKETS);
reserve("neutralDistance", PAD_DISTANCE_BUCKETS);
reserve("properties", 18);
reserve("futurePathDelta", 21);
reserve("futurePathLength", PATH_LENGTH_BUCKETS);
reserve("futureTurnDelta", 17);
reserve("futurePathPads", PAD_TYPES.length * 4);
reserve("counterfactualProperties", 8);
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

function createState(record) {
  return {
    record,
    grid: engine.cloneGrid(record.baseGrid),
    walls: [],
    singles: [],
    analysis: null
  };
}

function cloneState(state) {
  return {
    record: state.record,
    grid: engine.cloneGrid(state.grid),
    walls: state.walls.map((cell) => ({ ...cell })),
    singles: state.singles.map((cell) => ({ ...cell })),
    analysis: null
  };
}

function key(x, y) {
  return `${x},${y}`;
}

function analyzeState(state) {
  if (state.analysis) return state.analysis;
  const path = engine.computePath(state.grid);
  const pathIndex = new Map();
  for (let index = 0; index < path.length; index++) {
    const cellKey = key(path[index].x, path[index].y);
    if (!pathIndex.has(cellKey)) pathIndex.set(cellKey, index);
  }
  const pads = Object.fromEntries(PAD_TYPES.map((type) => [type, []]));
  for (let y = 0; y < engine.constants.GRID_SIZE; y++) {
    for (let x = 0; x < engine.constants.GRID_SIZE; x++) {
      const type = padType(state.grid[y][x]);
      if (type) pads[type].push({ x, y });
    }
  }
  const pathPads = Object.fromEntries(PAD_TYPES.map((type) => [type, 0]));
  const countedPads = new Set();
  for (const cell of path) {
    if (!engine.isInsideGrid(cell.x, cell.y) || countedPads.has(key(cell.x, cell.y))) continue;
    countedPads.add(key(cell.x, cell.y));
    const type = padType(state.grid[cell.y][cell.x]);
    if (type) pathPads[type]++;
  }
  state.analysis = { path, pathIndex, pads, pathPads, turns: countTurns(path) };
  return state.analysis;
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

function counterfactualPath(state, actionType, x, y) {
  const grid = engine.cloneGrid(state.grid);
  if (actionType === "wall") {
    if (!engine.canPlaceBlock(grid, x, y)) return null;
    engine.placeBlock(grid, x, y, engine.cells.PLAYER);
  } else if (actionType === "single") {
    if (!engine.canPlaceSingle(grid, x, y)) return null;
    grid[y][x] = engine.cells.SINGLE;
  } else if (actionType === "special") {
    if (!engine.isCellAvailableForSpecial(grid, x, y)) return null;
    grid[y][x] = engine.cells.SPECIAL;
  } else {
    return null;
  }
  engine.ensureOpenings(grid);
  const path = engine.computePath(grid);
  if (!path.length) return { path, turns: 0, pathPads: Object.fromEntries(PAD_TYPES.map((type) => [type, 0])) };
  const pathPads = Object.fromEntries(PAD_TYPES.map((type) => [type, 0]));
  const countedPads = new Set();
  for (const cell of path) {
    if (!engine.isInsideGrid(cell.x, cell.y) || countedPads.has(key(cell.x, cell.y))) continue;
    countedPads.add(key(cell.x, cell.y));
    const type = padType(grid[cell.y][cell.x]);
    if (type) pathPads[type]++;
  }
  return { path, turns: countTurns(path), pathPads };
}

function distanceBucket(distance, maximum = PAD_DISTANCE_BUCKETS) {
  return Math.max(0, Math.min(maximum - 1, Math.floor(distance)));
}

function nearestManhattan(cells, x, y, fallback = PAD_DISTANCE_BUCKETS - 1) {
  let best = Infinity;
  for (const cell of cells) best = Math.min(best, Math.abs(cell.x - x) + Math.abs(cell.y - y));
  return Number.isFinite(best) ? best : fallback;
}

function footprint(actionType, x, y) {
  if (actionType === "wall") {
    return [
      { x, y },
      { x: x + 1, y },
      { x, y: y + 1 },
      { x: x + 1, y: y + 1 }
    ];
  }
  return [{ x, y }];
}

function candidateFeatures(state, actionType, x = null, y = null, options = {}) {
  const analysis = analyzeState(state);
  const isStop = actionType.startsWith("stop-");
  const cx = isStop ? engine.constants.ENTRANCE_X : Math.max(0, Math.min(engine.constants.GRID_SIZE - 1, x | 0));
  const cy = isStop ? Math.floor(engine.constants.GRID_SIZE / 2) : Math.max(0, Math.min(engine.constants.GRID_SIZE - 1, y | 0));
  const indices = [];
  let patchIndex = 0;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      const gx = cx + dx;
      const gy = cy + dy;
      const category = engine.isInsideGrid(gx, gy) ? cellCategory(state.grid[gy][gx]) : 10;
      indices.push(OFFSETS.patch + patchIndex * CELL_CATEGORIES + category);
      if (analysis.pathIndex.has(key(gx, gy))) indices.push(OFFSETS.pathPatch + patchIndex);
      patchIndex++;
    }
  }
  indices.push(OFFSETS.action + Math.max(0, ACTION_TYPES.indexOf(actionType)));
  indices.push(OFFSETS.specialType + Math.max(0, SPECIAL_TYPES.indexOf(state.record.specialType)));
  indices.push(OFFSETS.wallsRemaining + Math.max(0, Math.min(21, state.record.budgets.walls - state.walls.length)));
  indices.push(OFFSETS.singlesRemaining + Math.max(0, Math.min(2, state.record.budgets.singles - state.singles.length)));
  indices.push(OFFSETS.wallsPlaced + Math.max(0, Math.min(21, state.walls.length)));
  indices.push(OFFSETS.singlesPlaced + Math.max(0, Math.min(2, state.singles.length)));
  indices.push(OFFSETS.pathLength + Math.max(0, Math.min(PATH_LENGTH_BUCKETS - 1, Math.floor(analysis.path.length / 5))));

  if (isStop) {
    indices.push(OFFSETS.properties + 0);
    return indices;
  }

  indices.push(OFFSETS.x + cx);
  indices.push(OFFSETS.y + cy);
  indices.push(OFFSETS.diagonalSum + Math.max(0, Math.min(40, cx + cy)));
  indices.push(OFFSETS.diagonalDifference + Math.max(0, Math.min(40, cx - cy + 20)));

  let nearestPathDistance = Infinity;
  let nearestPathIndex = 0;
  for (const cell of footprint(actionType, cx, cy)) {
    for (let index = 0; index < analysis.path.length; index++) {
      const pathCell = analysis.path[index];
      const distance = Math.abs(pathCell.x - cell.x) + Math.abs(pathCell.y - cell.y);
      if (distance < nearestPathDistance) {
        nearestPathDistance = distance;
        nearestPathIndex = index;
      }
    }
  }
  if (!Number.isFinite(nearestPathDistance)) nearestPathDistance = PATH_DISTANCE_BUCKETS - 1;
  indices.push(OFFSETS.pathDistance + distanceBucket(nearestPathDistance, PATH_DISTANCE_BUCKETS));
  const pathProgress = analysis.path.length > 1 ? nearestPathIndex / (analysis.path.length - 1) : 0;
  indices.push(OFFSETS.pathProgress + Math.max(0, Math.min(PATH_PROGRESS_BUCKETS - 1, Math.floor(pathProgress * PATH_PROGRESS_BUCKETS))));

  for (let index = 0; index < PAD_TYPES.length; index++) {
    const distance = nearestManhattan(analysis.pads[PAD_TYPES[index]], cx, cy);
    indices.push(OFFSETS.padDistance + index * PAD_DISTANCE_BUCKETS + distanceBucket(distance));
  }
  const neutralCell = state.record.neutralSpecial?.cell;
  const neutralDistance = neutralCell ? Math.abs(neutralCell.x - cx) + Math.abs(neutralCell.y - cy) : PAD_DISTANCE_BUCKETS - 1;
  indices.push(OFFSETS.neutralDistance + distanceBucket(neutralDistance));

  const propertyOffset = OFFSETS.properties;
  if (nearestPathDistance === 0) indices.push(propertyOffset + 1);
  if (nearestPathDistance === 1) indices.push(propertyOffset + 2);
  if (pathProgress < 0.34) indices.push(propertyOffset + 3);
  else if (pathProgress < 0.67) indices.push(propertyOffset + 4);
  else indices.push(propertyOffset + 5);
  if (cy < engine.constants.GRID_SIZE / 2) indices.push(propertyOffset + 6);
  else indices.push(propertyOffset + 7);
  if (actionType === "wall") indices.push(propertyOffset + 8);
  else if (actionType === "single") indices.push(propertyOffset + 9);
  else indices.push(propertyOffset + 10);

  let touchesPlayer = false;
  let touchesStatic = false;
  let touchesSpeed = false;
  let touchesSlow = false;
  let touchesOtherPad = false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx;
      const gy = cy + dy;
      if (!engine.isInsideGrid(gx, gy)) continue;
      const value = state.grid[gy][gx];
      touchesPlayer ||= value === engine.cells.PLAYER || value === engine.cells.SINGLE;
      touchesStatic ||= value === engine.cells.STATIC || value === engine.cells.STATIC_SPECIAL;
      touchesSpeed ||= value === engine.cells.SPEED || value === engine.cells.SPEED_USED;
      touchesSlow ||= value === engine.cells.SLOW || value === engine.cells.SLOW_USED;
      const nearbyPadType = padType(value);
      touchesOtherPad ||= Boolean(nearbyPadType && nearbyPadType !== "speed" && nearbyPadType !== "slow");
    }
  }
  if (touchesPlayer) indices.push(propertyOffset + 11);
  if (touchesStatic) indices.push(propertyOffset + 12);
  if (touchesSpeed) indices.push(propertyOffset + 13);
  if (touchesSlow) indices.push(propertyOffset + 14);
  if (touchesOtherPad) indices.push(propertyOffset + 15);
  if (cx <= 2 || cx >= engine.constants.GRID_SIZE - 3) indices.push(propertyOffset + 16);
  if (cy <= 2 || cy >= engine.constants.GRID_SIZE - 3) indices.push(propertyOffset + 17);

  if (options.counterfactual === false) return indices;

  const future = counterfactualPath(state, actionType, cx, cy);
  const counterfactualOffset = OFFSETS.counterfactualProperties;
  if (!future || !future.path.length) {
    indices.push(OFFSETS.futurePathDelta + 0);
    indices.push(OFFSETS.futurePathLength + 0);
    indices.push(OFFSETS.futureTurnDelta + 0);
    for (let index = 0; index < PAD_TYPES.length; index++) indices.push(OFFSETS.futurePathPads + index * 4);
    indices.push(counterfactualOffset + 7);
    return indices;
  }
  const pathDelta = future.path.length - analysis.path.length;
  indices.push(OFFSETS.futurePathDelta + Math.max(0, Math.min(20, Math.floor(pathDelta / 2) + 10)));
  indices.push(OFFSETS.futurePathLength + Math.max(0, Math.min(PATH_LENGTH_BUCKETS - 1, Math.floor(future.path.length / 5))));
  const turnDelta = future.turns - analysis.turns;
  indices.push(OFFSETS.futureTurnDelta + Math.max(0, Math.min(16, turnDelta + 8)));
  for (let index = 0; index < PAD_TYPES.length; index++) {
    indices.push(OFFSETS.futurePathPads + index * 4 + Math.max(0, Math.min(3, future.pathPads[PAD_TYPES[index]])));
  }
  indices.push(counterfactualOffset + 0);
  if (pathDelta > 0) indices.push(counterfactualOffset + 1);
  else if (pathDelta < 0) indices.push(counterfactualOffset + 2);
  if (future.pathPads.speed < analysis.pathPads.speed) indices.push(counterfactualOffset + 3);
  if (future.pathPads.slow > analysis.pathPads.slow) indices.push(counterfactualOffset + 4);
  if (future.pathPads.detour > analysis.pathPads.detour) indices.push(counterfactualOffset + 5);
  if (future.pathPads.rewind > analysis.pathPads.rewind) indices.push(counterfactualOffset + 6);
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
  if (data.modelVersion !== MODEL_VERSION) throw new Error(`Expected ${MODEL_VERSION}, received ${data.modelVersion}.`);
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
  return { probability, logit, hidden };
}

function legalCandidates(state, actionType) {
  const candidates = [];
  const maximum = actionType === "wall" ? engine.constants.GRID_SIZE - 1 : engine.constants.GRID_SIZE;
  for (let y = 0; y < maximum; y++) {
    for (let x = 0; x < maximum; x++) {
      if (actionType === "wall" && engine.canPlaceBlock(state.grid, x, y)) candidates.push({ x, y });
      else if (actionType === "single" && engine.canPlaceSingle(state.grid, x, y)) candidates.push({ x, y });
      else if (actionType === "special" && engine.isCellAvailableForSpecial(state.grid, x, y)) candidates.push({ x, y });
    }
  }
  return candidates;
}

function rankCandidates(model, state, actionType, options = {}) {
  analyzeState(state);
  let candidates = legalCandidates(state, actionType);
  const causalPool = Math.max(0, Number(options.causalPool || 0) | 0);
  if (causalPool > 0 && candidates.length > causalPool) {
    candidates = candidates
      .map((cell) => {
        const prediction = predict(model, candidateFeatures(state, actionType, cell.x, cell.y, { counterfactual: false }));
        return { ...cell, screeningLogit: prediction.logit };
      })
      .sort((a, b) => b.screeningLogit - a.screeningLogit || a.y - b.y || a.x - b.x)
      .slice(0, causalPool);
  }
  return candidates
    .map((cell) => {
      const prediction = predict(model, candidateFeatures(state, actionType, cell.x, cell.y));
      return { ...cell, probability: prediction.probability, logit: prediction.logit };
    })
    .sort((a, b) => b.logit - a.logit || a.y - b.y || a.x - b.x);
}

function applyPlacement(state, actionType, cell) {
  if (actionType === "wall") {
    if (!engine.canPlaceBlock(state.grid, cell.x, cell.y)) return false;
    engine.placeBlock(state.grid, cell.x, cell.y, engine.cells.PLAYER);
    engine.ensureOpenings(state.grid);
    if (!engine.hasPath(state.grid)) {
      engine.clearBlock(state.grid, cell.x, cell.y);
      engine.ensureOpenings(state.grid);
      return false;
    }
    state.walls.push({ x: cell.x, y: cell.y });
  } else if (actionType === "single") {
    if (!engine.canPlaceSingle(state.grid, cell.x, cell.y)) return false;
    state.grid[cell.y][cell.x] = engine.cells.SINGLE;
    engine.ensureOpenings(state.grid);
    if (!engine.hasPath(state.grid)) {
      state.grid[cell.y][cell.x] = engine.cells.EMPTY;
      engine.ensureOpenings(state.grid);
      return false;
    }
    state.singles.push({ x: cell.x, y: cell.y });
  } else {
    return false;
  }
  state.analysis = null;
  return true;
}

module.exports = {
  MODEL_VERSION,
  ACTION_TYPES,
  INPUT_SIZE,
  createState,
  cloneState,
  analyzeState,
  candidateFeatures,
  createModel,
  hydrateModel,
  serializeModel,
  predict,
  legalCandidates,
  rankCandidates,
  applyPlacement
};
