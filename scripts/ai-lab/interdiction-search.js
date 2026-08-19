"use strict";

require("../../ai-core.js");
const engine = global.AICore;

const SEARCH_VERSION = "interdiction-search-v1";
const METHODS = Object.freeze(["single", "pair", "pair-rollout", "interdiction"]);
const MOVES = Object.freeze([
  { dx: 1, dy: 0, cost: 1 },
  { dx: -1, dy: 0, cost: 1 },
  { dx: 0, dy: 1, cost: 1 },
  { dx: 0, dy: -1, cost: 1 },
  { dx: 1, dy: 1, cost: Math.SQRT2, diagonal: true },
  { dx: -1, dy: 1, cost: Math.SQRT2, diagonal: true },
  { dx: 1, dy: -1, cost: Math.SQRT2, diagonal: true },
  { dx: -1, dy: -1, cost: Math.SQRT2, diagonal: true }
]);

const DEFAULT_OPTIONS = Object.freeze({
  beamWidth: 6,
  candidatePool: 16,
  branchesPerState: 8,
  alternativePaths: 7,
  maxBundleSize: 5,
  interdictionSeeds: 5,
  interdictionBranching: 2,
  finalistLayouts: 6,
  hazardHeuristicCandidates: 36,
  hazardExactCandidates: 8,
  rolloutCandidatePool: 7,
  rolloutBranchesPerState: 3,
  rolloutAlternativePaths: 2,
  interdictionExactCandidates: 8,
  maxPathEvaluations: 9000
});

function normalizeOptions(overrides = {}) {
  return {
    beamWidth: Math.max(1, Math.min(16, Number(overrides.beamWidth || DEFAULT_OPTIONS.beamWidth) | 0)),
    candidatePool: Math.max(6, Math.min(40, Number(overrides.candidatePool || DEFAULT_OPTIONS.candidatePool) | 0)),
    branchesPerState: Math.max(
      2,
      Math.min(32, Number(overrides.branchesPerState || DEFAULT_OPTIONS.branchesPerState) | 0)
    ),
    alternativePaths: Math.max(
      1,
      Math.min(16, Number(overrides.alternativePaths || DEFAULT_OPTIONS.alternativePaths) | 0)
    ),
    maxBundleSize: Math.max(2, Math.min(6, Number(overrides.maxBundleSize || DEFAULT_OPTIONS.maxBundleSize) | 0)),
    interdictionSeeds: Math.max(
      2,
      Math.min(12, Number(overrides.interdictionSeeds || DEFAULT_OPTIONS.interdictionSeeds) | 0)
    ),
    interdictionBranching: Math.max(
      1,
      Math.min(4, Number(overrides.interdictionBranching || DEFAULT_OPTIONS.interdictionBranching) | 0)
    ),
    finalistLayouts: Math.max(
      1,
      Math.min(16, Number(overrides.finalistLayouts || DEFAULT_OPTIONS.finalistLayouts) | 0)
    ),
    hazardHeuristicCandidates: Math.max(
      8,
      Math.min(120, Number(overrides.hazardHeuristicCandidates || DEFAULT_OPTIONS.hazardHeuristicCandidates) | 0)
    ),
    hazardExactCandidates: Math.max(
      1,
      Math.min(24, Number(overrides.hazardExactCandidates || DEFAULT_OPTIONS.hazardExactCandidates) | 0)
    ),
    rolloutCandidatePool: Math.max(
      2,
      Math.min(16, Number(overrides.rolloutCandidatePool || DEFAULT_OPTIONS.rolloutCandidatePool) | 0)
    ),
    rolloutBranchesPerState: Math.max(
      1,
      Math.min(8, Number(overrides.rolloutBranchesPerState || DEFAULT_OPTIONS.rolloutBranchesPerState) | 0)
    ),
    rolloutAlternativePaths: Math.max(
      1,
      Math.min(5, Number(overrides.rolloutAlternativePaths || DEFAULT_OPTIONS.rolloutAlternativePaths) | 0)
    ),
    interdictionExactCandidates: Math.max(
      1,
      Math.min(24, Number(overrides.interdictionExactCandidates || DEFAULT_OPTIONS.interdictionExactCandidates) | 0)
    ),
    maxPathEvaluations: Math.max(
      100,
      Math.min(100000, Number(overrides.maxPathEvaluations || DEFAULT_OPTIONS.maxPathEvaluations) | 0)
    )
  };
}

function key(x, y) {
  return `${x},${y}`;
}

function cloneState(state) {
  return {
    grid: engine.cloneGrid(state.grid),
    walls: state.walls.map((cell) => ({ ...cell })),
    singles: state.singles.map((cell) => ({ ...cell })),
    score: state.score,
    rolloutScore: state.rolloutScore,
    pathSignature: state.pathSignature,
    signature: state.signature
  };
}

function wallSignature(walls) {
  return walls.map((cell) => `${cell.x},${cell.y}`).sort().join(";");
}

function stateSignature(state) {
  const singles = state.singles.map((cell) => `${cell.x},${cell.y}`).sort().join(";");
  return `w:${wallSignature(state.walls)}|s:${singles}`;
}

function pathSignature(path) {
  if (!path?.length) return "none";
  return path
    .filter((cell, index) => index % 3 === 0 || index === path.length - 1)
    .map((cell) => `${cell.x},${cell.y}`)
    .join(";");
}

function isDiagonalPassable(grid, x, y, move) {
  return !move.diagonal || (engine.isWalkableCell(grid, x + move.dx, y) && engine.isWalkableCell(grid, x, y + move.dy));
}

function findPenalizedPath(grid, penalties) {
  const size = engine.constants.GRID_SIZE;
  const start = { x: engine.constants.ENTRANCE_X, y: size - 1 };
  const goal = { x: engine.constants.ENTRANCE_X, y: 0 };
  const total = size * size;
  const distances = new Float64Array(total);
  distances.fill(Infinity);
  const previous = new Int32Array(total);
  previous.fill(-1);
  const startIndex = start.y * size + start.x;
  const goalIndex = goal.y * size + goal.x;
  distances[startIndex] = 0;
  const heap = [{ index: startIndex, distance: 0 }];
  const push = (entry) => {
    heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heap[parent].distance <= entry.distance) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = entry;
  };
  const pop = () => {
    const root = heap[0];
    const tail = heap.pop();
    if (heap.length && tail) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && heap[right].distance < heap[left].distance ? right : left;
        if (heap[child].distance >= tail.distance) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = tail;
    }
    return root;
  };
  while (heap.length) {
    const currentEntry = pop();
    const current = currentEntry.index;
    const currentDistance = currentEntry.distance;
    if (currentDistance > distances[current] + 1e-9) continue;
    if (current === goalIndex) break;
    const x = current % size;
    const y = Math.floor(current / size);
    for (const move of MOVES) {
      const nx = x + move.dx;
      const ny = y + move.dy;
      if (!engine.isInsideGrid(nx, ny) || !engine.isWalkableCell(grid, nx, ny)) continue;
      if (!isDiagonalPassable(grid, x, y, move)) continue;
      const next = ny * size + nx;
      const cost = move.cost + (penalties[next] || 0);
      const candidate = currentDistance + cost;
      if (candidate + 1e-9 >= distances[next]) continue;
      distances[next] = candidate;
      previous[next] = current;
      push({ index: next, distance: candidate });
    }
  }
  if (!Number.isFinite(distances[goalIndex])) return [];
  const path = [];
  for (let index = goalIndex; index >= 0; index = previous[index]) {
    path.push({ x: index % size, y: Math.floor(index / size) });
    if (index === startIndex) break;
  }
  path.reverse();
  return path;
}

function alternativeRoutes(grid, count, profile) {
  const size = engine.constants.GRID_SIZE;
  const penalties = new Float64Array(size * size);
  const routes = [];
  const seen = new Set();
  for (let index = 0; index < count; index++) {
    const path = findPenalizedPath(grid, penalties);
    profile.pathEvaluations++;
    if (!path.length) break;
    const signature = path.map((cell) => key(cell.x, cell.y)).join(";");
    if (!seen.has(signature)) {
      seen.add(signature);
      routes.push(path);
    }
    const penalty = 0.42 + index * 0.08;
    for (let pathIndex = 1; pathIndex < path.length - 1; pathIndex++) {
      const cell = path[pathIndex];
      penalties[cell.y * size + cell.x] += penalty;
    }
  }
  return routes;
}

function blockedComponents(grid) {
  const size = engine.constants.GRID_SIZE;
  const labels = new Int16Array(size * size);
  labels.fill(-1);
  let component = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      if (labels[index] >= 0 || engine.isWalkableCell(grid, x, y)) continue;
      const queue = [{ x, y }];
      labels[index] = component;
      while (queue.length) {
        const current = queue.pop();
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1]
        ]) {
          const nx = current.x + dx;
          const ny = current.y + dy;
          if (!engine.isInsideGrid(nx, ny) || engine.isWalkableCell(grid, nx, ny)) continue;
          const next = ny * size + nx;
          if (labels[next] >= 0) continue;
          labels[next] = component;
          queue.push({ x: nx, y: ny });
        }
      }
      component++;
    }
  }
  return labels;
}

function footprint(cell) {
  return [
    { x: cell.x, y: cell.y },
    { x: cell.x + 1, y: cell.y },
    { x: cell.x, y: cell.y + 1 },
    { x: cell.x + 1, y: cell.y + 1 }
  ];
}

function candidateRouteCoverage(cell, routeSets) {
  const cells = footprint(cell);
  let coverage = 0;
  let primary = false;
  for (let index = 0; index < routeSets.length; index++) {
    if (!cells.some((entry) => routeSets[index].has(key(entry.x, entry.y)))) continue;
    coverage += index === 0 ? 4 : 1;
    primary ||= index === 0;
  }
  return { coverage, primary };
}

function candidateStructureScore(cell, labels) {
  const size = engine.constants.GRID_SIZE;
  const components = new Set();
  let contacts = 0;
  for (let y = cell.y - 2; y <= cell.y + 3; y++) {
    for (let x = cell.x - 2; x <= cell.x + 3; x++) {
      if (!engine.isInsideGrid(x, y)) continue;
      const label = labels[y * size + x];
      if (label < 0) continue;
      const dx = x < cell.x ? cell.x - x : x > cell.x + 1 ? x - (cell.x + 1) : 0;
      const dy = y < cell.y ? cell.y - y : y > cell.y + 1 ? y - (cell.y + 1) : 0;
      const distance = dx + dy;
      if (distance <= 2) {
        components.add(label);
        contacts += distance === 1 ? 2 : 1;
      }
    }
  }
  return contacts + Math.max(0, components.size - 1) * 7;
}

function collectWallCandidates(grid, options, profile, limit = options.candidatePool) {
  if (profile.pathEvaluations >= options.maxPathEvaluations) return [];
  const routes = alternativeRoutes(grid, options.alternativePaths, profile);
  if (!routes.length) return [];
  const routeSets = routes.map((path) => new Set(path.map((cell) => key(cell.x, cell.y))));
  const labels = blockedComponents(grid);
  const primary = routes[0];
  const candidates = [];
  for (let y = 0; y < engine.constants.GRID_SIZE - 1; y++) {
    for (let x = 0; x < engine.constants.GRID_SIZE - 1; x++) {
      if (!engine.canPlaceBlock(grid, x, y)) continue;
      const cell = { x, y };
      const route = candidateRouteCoverage(cell, routeSets);
      let nearest = Infinity;
      for (const pathCell of primary) {
        nearest = Math.min(nearest, Math.abs(pathCell.x - x) + Math.abs(pathCell.y - y));
      }
      const structure = candidateStructureScore(cell, labels);
      const staticScore = route.coverage * 9 + structure * 2.2 - Math.min(8, nearest) * 0.65;
      if (route.coverage > 0 || structure >= 4 || nearest <= 3) {
        candidates.push({ x, y, staticScore, routeCoverage: route.coverage, structure });
      }
    }
  }
  candidates.sort((a, b) => b.staticScore - a.staticScore || a.y - b.y || a.x - b.x);
  return candidates.slice(0, Math.max(limit, 6));
}

function applyWall(grid, cell) {
  if (!engine.canPlaceBlock(grid, cell.x, cell.y)) return false;
  engine.placeBlock(grid, cell.x, cell.y, engine.cells.PLAYER);
  engine.ensureOpenings(grid);
  return true;
}

function applyBundle(state, bundle, profile) {
  const next = cloneState(state);
  for (const cell of bundle) {
    if (!applyWall(next.grid, cell)) return null;
    next.walls.push({ x: cell.x, y: cell.y });
  }
  const path = engine.computePath(next.grid);
  profile.pathEvaluations++;
  if (!path.length) return null;
  next.signature = stateSignature(next);
  next.pathSignature = pathSignature(path);
  return next;
}

function quickScore(record, state, profile) {
  if (profile.pathEvaluations >= profile.maxPathEvaluations) return -Infinity;
  const info = engine.analyzePath(state.grid);
  profile.pathEvaluations++;
  if (!info) return -Infinity;
  state.pathSignature = pathSignature(info.path);
  state.signature = stateSignature(state);
  const neutralSpecials = record.neutralSpecial ? [record.neutralSpecial] : [];
  const score = engine.evaluateGridForAi(state.grid, null, neutralSpecials, info, undefined, record.baseGrid);
  state.score = score;
  return score;
}

function compareStates(a, b, useRollout = false) {
  const aScore = useRollout ? a.rolloutScore : a.score;
  const bScore = useRollout ? b.rolloutScore : b.score;
  return (bScore ?? -Infinity) - (aScore ?? -Infinity) || a.signature.localeCompare(b.signature);
}

function selectDiverseBeam(states, width, useRollout = false) {
  const sorted = states.slice().sort((a, b) => compareStates(a, b, useRollout));
  const selected = [];
  const routes = new Set();
  const signatures = new Set();
  for (const state of sorted) {
    if (signatures.has(state.signature) || routes.has(state.pathSignature)) continue;
    selected.push(state);
    signatures.add(state.signature);
    routes.add(state.pathSignature);
    if (selected.length >= width) return selected;
  }
  for (const state of sorted) {
    if (signatures.has(state.signature)) continue;
    selected.push(state);
    signatures.add(state.signature);
    if (selected.length >= width) break;
  }
  return selected;
}

function selectInterdictionBeam(states, width) {
  const groups = new Map();
  for (const state of states) {
    const spent = state.walls.length;
    if (!groups.has(spent)) groups.set(spent, []);
    groups.get(spent).push(state);
  }
  const orderedGroups = Array.from(groups.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, entries]) => selectDiverseBeam(entries, width));
  const selected = [];
  const signatures = new Set();
  const routes = new Set();
  for (let rank = 0; selected.length < width; rank++) {
    let added = false;
    for (const group of orderedGroups) {
      const state = group[rank];
      if (!state || signatures.has(state.signature)) continue;
      if (routes.has(state.pathSignature) && selected.length + 1 < width) continue;
      selected.push(state);
      signatures.add(state.signature);
      routes.add(state.pathSignature);
      added = true;
      if (selected.length >= width) break;
    }
    if (!added) break;
  }
  if (selected.length < width) {
    for (const state of states.slice().sort((a, b) => compareStates(a, b))) {
      if (signatures.has(state.signature)) continue;
      selected.push(state);
      signatures.add(state.signature);
      if (selected.length >= width) break;
    }
  }
  return selected;
}

function singleBundles(state, remaining, options, profile) {
  if (remaining <= 0) return [];
  return collectWallCandidates(state.grid, options, profile)
    .slice(0, options.branchesPerState)
    .map((cell) => [cell]);
}

function pairBundles(record, state, remaining, options, profile) {
  if (remaining < 2) return singleBundles(state, remaining, options, profile);
  const candidates = collectWallCandidates(state.grid, options, profile);
  const bundles = [];
  for (let first = 0; first < candidates.length; first++) {
    for (let second = first + 1; second < candidates.length; second++) {
      const bundle = [candidates[first], candidates[second]];
      const candidate = applyBundle(state, bundle, profile);
      if (!candidate) continue;
      const pairScore = quickScore(record, candidate, profile);
      if (!Number.isFinite(pairScore)) continue;
      bundles.push({ bundle, score: pairScore, signature: candidate.signature });
      if (profile.pathEvaluations >= options.maxPathEvaluations) break;
    }
    if (profile.pathEvaluations >= options.maxPathEvaluations) break;
  }
  bundles.sort((a, b) => b.score - a.score || a.signature.localeCompare(b.signature));
  return bundles.slice(0, options.branchesPerState).map((entry) => entry.bundle);
}

function greedyRollout(record, initial, options, profile) {
  let state = cloneState(initial);
  const rolloutOptions = {
    ...options,
    candidatePool: options.rolloutCandidatePool,
    alternativePaths: options.rolloutAlternativePaths
  };
  while (state.walls.length < record.budgets.walls && profile.pathEvaluations < options.maxPathEvaluations) {
    const candidates = collectWallCandidates(state.grid, rolloutOptions, profile, options.rolloutCandidatePool).slice(
      0,
      options.rolloutCandidatePool
    );
    let best = null;
    for (const cell of candidates) {
      const candidate = applyBundle(state, [cell], profile);
      if (!candidate) continue;
      quickScore(record, candidate, profile);
      if (!best || compareStates(candidate, best) < 0) best = candidate;
      if (profile.pathEvaluations >= options.maxPathEvaluations) break;
    }
    if (!best) break;
    state = best;
  }
  return state;
}

function completeWallsGreedy(record, initial, options, profile) {
  let state = cloneState(initial);
  const savedLimit = profile.maxPathEvaluations;
  profile.maxPathEvaluations = Infinity;
  const completionOptions = {
    ...options,
    alternativePaths: Math.min(2, options.alternativePaths),
    candidatePool: Math.min(8, options.candidatePool),
    maxPathEvaluations: Infinity
  };
  while (state.walls.length < record.budgets.walls) {
    const candidates = collectWallCandidates(state.grid, completionOptions, profile, completionOptions.candidatePool);
    let best = null;
    for (const cell of candidates) {
      const candidate = applyBundle(state, [cell], profile);
      if (!candidate) continue;
      quickScore(record, candidate, profile);
      if (!best || compareStates(candidate, best) < 0) best = candidate;
    }
    if (!best) {
      outer: for (let y = 0; y < engine.constants.GRID_SIZE - 1; y++) {
        for (let x = 0; x < engine.constants.GRID_SIZE - 1; x++) {
          const candidate = applyBundle(state, [{ x, y }], profile);
          if (!candidate) continue;
          quickScore(record, candidate, profile);
          best = candidate;
          break outer;
        }
      }
    }
    if (!best) break;
    state = best;
  }
  profile.maxPathEvaluations = savedLimit;
  return state;
}

function generateInterdictionBundles(record, state, remaining, options, profile) {
  const maximum = Math.min(options.maxBundleSize, remaining);
  if (maximum < 2) return singleBundles(state, remaining, options, profile);
  const rootPool = collectWallCandidates(state.grid, options, profile, options.candidatePool * 2);
  const roots = rootPool
    .slice(0, options.interdictionSeeds)
    .map((cell) => ({ state: applyBundle(state, [cell], profile), bundle: [cell] }))
    .filter((entry) => entry.state);
  const completed = [];
  let frontier = roots;
  for (let depth = 2; depth <= maximum && frontier.length; depth++) {
    const nextFrontier = [];
    for (const entry of frontier) {
      const globalCandidates = collectWallCandidates(entry.state.grid, options, profile).slice(
        0,
        options.interdictionBranching
      );
      const candidates = Array.from(
        new Map(globalCandidates.map((cell) => [key(cell.x, cell.y), cell])).values()
      )
        .map((cell) => ({
          state: applyBundle(entry.state, [cell], profile),
          bundle: entry.bundle.concat(cell)
        }))
        .filter((candidate) => candidate.state);
      for (const candidate of candidates) {
        quickScore(record, candidate.state, profile);
        completed.push(candidate);
        nextFrontier.push(candidate);
      }
      if (profile.pathEvaluations >= options.maxPathEvaluations) break;
    }
    frontier = selectDiverseBeam(
      nextFrontier.map((entry) => entry.state),
      options.interdictionSeeds * options.interdictionBranching
    ).map((selected) => nextFrontier.find((entry) => entry.state.signature === selected.signature));
    if (profile.pathEvaluations >= options.maxPathEvaluations) break;
  }
  completed.sort((a, b) => compareStates(a.state, b.state));
  const neutralSpecials = record.neutralSpecial ? [record.neutralSpecial] : [];
  const byBundleSize = new Map();
  for (const entry of completed) {
    if (!byBundleSize.has(entry.bundle.length)) byBundleSize.set(entry.bundle.length, []);
    byBundleSize.get(entry.bundle.length).push(entry);
  }
  const groupCount = Math.max(1, byBundleSize.size);
  const exactPerSize = Math.max(1, Math.ceil(options.interdictionExactCandidates / groupCount));
  const exactShortlist = Array.from(byBundleSize.entries())
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, entries]) => entries.slice(0, exactPerSize));
  for (const entry of exactShortlist) {
    entry.exactScore = engine.simulateRunnerTime(entry.state.grid, null, neutralSpecials);
    profile.exactSimulations++;
  }
  for (const entries of byBundleSize.values()) {
    entries.sort(
      (a, b) =>
        (b.exactScore ?? -Infinity) - (a.exactScore ?? -Infinity) ||
        compareStates(a.state, b.state)
    );
  }
  const selected = [];
  const routeSignatures = new Set();
  const orderedGroups = Array.from(byBundleSize.entries()).sort((a, b) => a[0] - b[0]);
  for (let rank = 0; selected.length < options.branchesPerState; rank++) {
    let added = false;
    for (const [, entries] of orderedGroups) {
      const entry = entries[rank];
      if (!entry || routeSignatures.has(entry.state.pathSignature)) continue;
      selected.push(entry.bundle);
      routeSignatures.add(entry.state.pathSignature);
      added = true;
      if (selected.length >= options.branchesPerState) break;
    }
    if (!added) break;
  }
  return selected.length ? selected : pairBundles(record, state, remaining, options, profile);
}

function addSingles(record, beam, options, profile) {
  for (let singleIndex = 0; singleIndex < record.budgets.singles; singleIndex++) {
    const expanded = [];
    for (const state of beam) {
      const path = engine.computePath(state.grid);
      profile.pathEvaluations++;
      const keys = new Set();
      for (const cell of path) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) keys.add(key(cell.x + dx, cell.y + dy));
        }
      }
      const candidates = [];
      for (const entry of keys) {
        const [x, y] = entry.split(",").map(Number);
        if (!engine.canPlaceSingle(state.grid, x, y)) continue;
        const next = cloneState(state);
        next.grid[y][x] = engine.cells.SINGLE;
        engine.ensureOpenings(next.grid);
        const nextPath = engine.computePath(next.grid);
        profile.pathEvaluations++;
        if (!nextPath.length) continue;
        next.singles.push({ x, y });
        quickScore(record, next, profile);
        candidates.push(next);
      }
      candidates.sort((a, b) => compareStates(a, b));
      expanded.push(...candidates.slice(0, Math.max(2, Math.floor(options.branchesPerState / 2))));
    }
    if (!expanded.length) break;
    beam = selectDiverseBeam(expanded, options.beamWidth);
  }
  return beam;
}

function hazardCandidateCells(grid) {
  const path = engine.computePath(grid);
  const cells = new Set();
  for (const node of path) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = node.x + dx;
        const y = node.y + dy;
        if (engine.isInsideGrid(x, y)) cells.add(key(x, y));
      }
    }
  }
  for (let y = 0; y < engine.constants.GRID_SIZE; y += 3) {
    for (let x = 0; x < engine.constants.GRID_SIZE; x += 3) cells.add(key(x, y));
  }
  return Array.from(cells)
    .map((entry) => {
      const [x, y] = entry.split(",").map(Number);
      return { x, y };
    })
    .filter((cell) => engine.isCellAvailableForSpecial(grid, cell.x, cell.y));
}

function optimizeHazard(record, state, options, profile) {
  const specialTemplate = engine.createSpecialTemplate(record.specialType);
  const neutralSpecials = record.neutralSpecial ? [record.neutralSpecial] : [];
  const baselineInfo = engine.analyzePath(state.grid);
  profile.pathEvaluations++;
  if (!baselineInfo) return null;
  const baselineMandatory = engine.countMandatorySpeedPads(state.grid, baselineInfo.path);
  const ranked = [];
  for (const cell of hazardCandidateCells(state.grid)) {
    const evaluated = engine.evaluateSpecialCandidate(
      state.grid,
      specialTemplate,
      neutralSpecials,
      cell.x,
      cell.y,
      baselineInfo,
      baselineMandatory
    );
    profile.pathEvaluations++;
    profile.hazardHeuristicEvaluations++;
    if (evaluated) ranked.push(evaluated);
  }
  ranked.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  const heuristicPool = ranked.slice(0, options.hazardHeuristicCandidates);
  let best = null;
  for (const cell of heuristicPool.slice(0, options.hazardExactCandidates)) {
    const grid = engine.cloneGrid(state.grid);
    if (!engine.isCellAvailableForSpecial(grid, cell.x, cell.y)) continue;
    grid[cell.y][cell.x] = engine.cells.SPECIAL;
    engine.ensureOpenings(grid);
    if (!engine.hasPath(grid)) continue;
    const special = engine.createSpecialTemplate(record.specialType);
    special.placed = true;
    special.cell = { x: cell.x, y: cell.y };
    const score = engine.simulateRunnerTime(grid, special, neutralSpecials);
    profile.exactSimulations++;
    if (!Number.isFinite(score)) continue;
    const signature = `${state.signature}|h:${cell.x},${cell.y}`;
    const candidate = { grid, special, score, state, signature };
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && signature < best.signature)) {
      best = candidate;
    }
  }
  return best;
}

function search(method, record, overrides = {}) {
  if (!METHODS.includes(method)) throw new Error(`Unknown interdiction method '${method}'.`);
  const options = normalizeOptions(overrides);
  const startedAt = performance.now();
  const profile = {
    method,
    pathEvaluations: 0,
    exactSimulations: 0,
    hazardHeuristicEvaluations: 0,
    expansions: 0,
    maxPathEvaluations: options.maxPathEvaluations
  };
  const initial = {
    grid: engine.cloneGrid(record.baseGrid),
    walls: [],
    singles: [],
    score: 0,
    rolloutScore: null,
    pathSignature: "",
    signature: "w:|s:"
  };
  initial.record = record;
  quickScore(record, initial, profile);
  let beam = [initial];
  const finished = [];
  while (beam.length && profile.pathEvaluations < options.maxPathEvaluations) {
    const expanded = [];
    for (const state of beam) {
      const remaining = record.budgets.walls - state.walls.length;
      if (remaining <= 0) {
        finished.push(state);
        continue;
      }
      let bundles;
      if (method === "single") bundles = singleBundles(state, remaining, options, profile);
      else if (method === "pair" || method === "pair-rollout") {
        bundles = pairBundles(record, state, remaining, options, profile);
      }
      else bundles = generateInterdictionBundles(record, state, remaining, options, profile);
      if (method === "pair-rollout") bundles = bundles.slice(0, options.rolloutBranchesPerState);
      for (const bundle of bundles) {
        if (bundle.length > remaining) continue;
        const candidate = applyBundle(state, bundle, profile);
        if (!candidate) continue;
        quickScore(record, candidate, profile);
        if (method === "pair-rollout") {
          const rollout = greedyRollout(record, candidate, options, profile);
          const neutralSpecials = record.neutralSpecial ? [record.neutralSpecial] : [];
          candidate.rolloutScore = engine.simulateRunnerTime(rollout.grid, null, neutralSpecials);
          profile.exactSimulations++;
        }
        if (candidate.walls.length >= record.budgets.walls) finished.push(candidate);
        else expanded.push(candidate);
        profile.expansions++;
        if (profile.pathEvaluations >= options.maxPathEvaluations) break;
      }
      if (profile.pathEvaluations >= options.maxPathEvaluations) break;
    }
    if (!expanded.length) break;
    beam =
      method === "interdiction"
        ? selectInterdictionBeam(expanded, options.beamWidth)
        : selectDiverseBeam(expanded, options.beamWidth, method === "pair-rollout");
  }
  if (finished.length) {
    beam = selectDiverseBeam(finished, Math.max(options.beamWidth, options.finalistLayouts));
  } else {
    beam = beam.map((state) => completeWallsGreedy(record, state, options, profile));
  }
  beam = addSingles(record, beam, options, profile);
  beam.sort((a, b) => compareStates(a, b));
  let best = null;
  for (const state of beam.slice(0, options.finalistLayouts)) {
    const candidate = optimizeHazard(record, state, options, profile);
    if (!candidate) continue;
    if (!best || candidate.score > best.score + 1e-9 || (Math.abs(candidate.score - best.score) <= 1e-9 && candidate.signature < best.signature)) {
      best = candidate;
    }
  }
  return {
    method,
    best,
    elapsedMs: performance.now() - startedAt,
    options,
    profile,
    completedLayouts: beam.length
  };
}

module.exports = {
  SEARCH_VERSION,
  METHODS,
  DEFAULT_OPTIONS,
  normalizeOptions,
  findPenalizedPath,
  alternativeRoutes,
  collectWallCandidates,
  search
};
