"use strict";

require("../../ai-core.js");
const engine = global.AICore;
const {
  createState,
  cloneState,
  candidateFeatures,
  predict,
  rankCandidates,
  applyPlacement
} = require("./sequential-policy.js");

const DEFAULT_SEARCH = Object.freeze({
  beamWidth: 4,
  branchFactor: 3,
  candidatePool: 18,
  stoppedLayouts: 3,
  hazardCandidates: 6,
  exactCandidates: 64,
  partialExact: true,
  causalPool: 36
});

function normalizeOptions(overrides = {}) {
  return {
    beamWidth: Math.max(1, Math.min(12, Number(overrides.beamWidth || DEFAULT_SEARCH.beamWidth) | 0)),
    branchFactor: Math.max(1, Math.min(8, Number(overrides.branchFactor || DEFAULT_SEARCH.branchFactor) | 0)),
    candidatePool: Math.max(4, Math.min(64, Number(overrides.candidatePool || DEFAULT_SEARCH.candidatePool) | 0)),
    stoppedLayouts: Math.max(0, Math.min(12, Number(overrides.stoppedLayouts ?? DEFAULT_SEARCH.stoppedLayouts) | 0)),
    hazardCandidates: Math.max(1, Math.min(24, Number(overrides.hazardCandidates || DEFAULT_SEARCH.hazardCandidates) | 0)),
    exactCandidates: Math.max(1, Math.min(256, Number(overrides.exactCandidates || DEFAULT_SEARCH.exactCandidates) | 0)),
    partialExact: overrides.partialExact !== false,
    causalPool: Math.max(0, Math.min(128, Number(overrides.causalPool || DEFAULT_SEARCH.causalPool) | 0))
  };
}

function stateSignature(state) {
  const walls = state.walls.map((cell) => `${cell.x},${cell.y}`).sort().join(";");
  const singles = state.singles.map((cell) => `${cell.x},${cell.y}`).sort().join(";");
  return `w:${walls}|s:${singles}`;
}

function compareBeam(a, b) {
  return b.searchScore - a.searchScore || b.policyScore - a.policyScore || stateSignature(a.state).localeCompare(stateSignature(b.state));
}

function pruneBeam(entries, maximum) {
  const unique = new Map();
  for (const entry of entries.sort(compareBeam)) {
    const signature = stateSignature(entry.state);
    if (!unique.has(signature)) unique.set(signature, entry);
    if (unique.size >= maximum) break;
  }
  return Array.from(unique.values());
}

function partialExactScore(state) {
  const neutralSpecials = state.record.neutralSpecial ? [state.record.neutralSpecial] : [];
  return engine.simulateRunnerTime(state.grid, null, neutralSpecials);
}

function scoredEntry(state, policyScore, options) {
  const partialScore = options.partialExact ? partialExactScore(state) : 0;
  return { state, policyScore, partialScore, searchScore: partialScore + policyScore * 0.02 };
}

function expandPhase(model, initialEntries, actionType, budget, options) {
  let beam = initialEntries;
  let stopped = [];
  for (let step = 0; step < budget && beam.length; step++) {
    const expanded = [];
    for (const entry of beam) {
      const stop = predict(model, candidateFeatures(entry.state, `stop-${actionType}`));
      stopped.push(scoredEntry(cloneState(entry.state), entry.policyScore + stop.logit, options));
      let accepted = 0;
      for (const candidate of rankCandidates(model, entry.state, actionType, { causalPool: options.causalPool }).slice(0, options.candidatePool)) {
        const state = cloneState(entry.state);
        if (!applyPlacement(state, actionType, candidate)) continue;
        expanded.push(scoredEntry(state, entry.policyScore + candidate.logit, options));
        accepted++;
        if (accepted >= options.branchFactor) break;
      }
    }
    beam = pruneBeam(expanded, options.beamWidth);
    stopped = pruneBeam(stopped, Math.max(options.stoppedLayouts, options.beamWidth));
  }
  return pruneBeam(beam.concat(stopped.slice(0, options.stoppedLayouts)), options.beamWidth + options.stoppedLayouts);
}

function candidateSignature(entry) {
  return `${stateSignature(entry.state)}|h:${entry.special.x},${entry.special.y}`;
}

function hazardMaintainsPath(state, cell) {
  if (!engine.isCellAvailableForSpecial(state.grid, cell.x, cell.y)) return false;
  const grid = engine.cloneGrid(state.grid);
  grid[cell.y][cell.x] = engine.cells.SPECIAL;
  engine.ensureOpenings(grid);
  return engine.hasPath(grid);
}

function evaluateCandidate(record, entry) {
  const grid = engine.cloneGrid(entry.state.grid);
  if (!engine.isCellAvailableForSpecial(grid, entry.special.x, entry.special.y)) return null;
  grid[entry.special.y][entry.special.x] = engine.cells.SPECIAL;
  engine.ensureOpenings(grid);
  if (!engine.hasPath(grid)) return null;
  const special = engine.createSpecialTemplate(record.specialType);
  special.placed = true;
  special.cell = { ...entry.special };
  const neutralSpecials = record.neutralSpecial ? [record.neutralSpecial] : [];
  const outcome = engine.simulateRunnerOutcome(grid, special, neutralSpecials);
  if (!outcome || !Number.isFinite(outcome.time)) return null;
  return {
    score: outcome.time,
    grid,
    special,
    walls: entry.state.walls.map((cell) => ({ ...cell })),
    singles: entry.state.singles.map((cell) => ({ ...cell })),
    triggeredPads: outcome.triggeredPads,
    signature: candidateSignature(entry),
    policyScore: entry.policyScore
  };
}

function compareSolutions(a, b) {
  return b.score - a.score || a.signature.localeCompare(b.signature);
}

function search(model, record, overrides = {}) {
  const options = normalizeOptions(overrides);
  const startedAt = performance.now();
  const initialState = createState(record);
  let beam = [scoredEntry(initialState, 0, options)];
  beam = expandPhase(model, beam, "wall", record.budgets.walls, options);
  beam = expandPhase(model, beam, "single", record.budgets.singles, options);

  const rawCandidates = [];
  for (const entry of beam) {
    let accepted = 0;
    for (const hazard of rankCandidates(model, entry.state, "special", { causalPool: options.causalPool }).slice(0, options.candidatePool)) {
      if (!hazardMaintainsPath(entry.state, hazard)) continue;
      const policyScore = entry.policyScore + hazard.logit;
      rawCandidates.push({ state: entry.state, special: { x: hazard.x, y: hazard.y }, policyScore });
      accepted++;
      if (accepted >= options.hazardCandidates) break;
    }
  }
  const unique = new Map();
  for (const candidate of rawCandidates.sort((a, b) => b.policyScore - a.policyScore || candidateSignature(a).localeCompare(candidateSignature(b)))) {
    const signature = candidateSignature(candidate);
    if (!unique.has(signature)) unique.set(signature, candidate);
    if (unique.size >= options.exactCandidates) break;
  }
  const solutions = [];
  for (const candidate of unique.values()) {
    const solution = evaluateCandidate(record, candidate);
    if (solution) solutions.push(solution);
  }
  solutions.sort(compareSolutions);
  return {
    best: solutions[0] || null,
    finalists: solutions,
    candidatesEvaluated: solutions.length,
    elapsedMs: performance.now() - startedAt,
    options
  };
}

module.exports = { DEFAULT_SEARCH, normalizeOptions, search };
