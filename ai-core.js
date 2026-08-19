/* AI core logic shared between main thread and worker.
 * DOM-free helpers and AI builder used by both main.js and ai-worker.js.
 */
(function (global) {
  "use strict";

  // RNG / hashing
  function mulberry32(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Runner simulation helpers (full fidelity, headless)
  function createRunner(label, grid, special, neutralSpecials = [], options = {}) {
    const path = options.path || options.pathInfo?.path || computePath(grid);
    const segmentMetadata = computeSegmentMetadata(path);
    const collectDiagnostics = options.diagnostics !== false;
    return {
      label,
      grid,
      special,
      neutralSpecials: neutralSpecials.map((ns) => (ns ? { ...ns } : null)).filter(Boolean),
      path,
      initialPath: path,
      segmentIndex: 0,
      segmentProgress: 0,
      segmentLengths: segmentMetadata.lengths,
      segmentDirections: segmentMetadata.directions,
      segmentSteps: segmentMetadata.steps,
      finished: !path.length,
      resultTime: null,
      worldPos: null,
      elapsedTime: 0,
      diagnostics: collectDiagnostics ? {
        padEvents: [],
        slowActiveTime: 0,
        slowStackTime: 0,
        fastActiveTime: 0,
        fastStackTime: 0,
        stoneActiveTime: 0,
        stoneActiveDistance: 0,
        ownedHazardTime: 0,
        slowHazardOverlapTime: 0,
        stoneHazardOverlapTime: 0,
        speedHazardOverlapTime: 0,
        detourReverseDistance: 0,
        rewindPrefixTime: 0
      } : null,
      effects: {
        slowTimer: 0,
        fastTimer: 0,
        slowTimers: [],
        fastTimers: [],
        areaTimer: 0,
        speedMultiplier: 1,
        gravityActive: false,
        gravityPull: null,
        gravityOffset: null,
        stunTimer: 0,
        medusaActive: false,
        medusaDir: null,
        lastDir: null,
        lastStep: null,
        neutralSlowTimer: 0
      }
    };
  }

  function advanceRunnerSimulation(runner, delta) {
    if (runner.finished) return;
    if (!runner.path.length) {
      runner.finished = true;
      runner.resultTime = runner.elapsedTime || 0;
      return;
    }
    updateRunnerEffects(runner, delta);
    const activeSlowCount = runner.effects.slowTimers.length;
    const activeFastCount = runner.effects.fastTimers.length;
    const activeStone = runner.effects.medusaActive;
    const speed = NPC_SPEED * runner.effects.speedMultiplier;
    let remainingDistance = speed * delta;
    let timeConsumed = 0;
    let distanceMoved = 0;
    while (remainingDistance > 0 && runner.segmentIndex < runner.segmentLengths.length) {
      const dirVector = runner.segmentDirections[runner.segmentIndex] || null;
      const dirStep = runner.segmentSteps[runner.segmentIndex] || null;
      if (dirVector) {
        runner.effects.lastDir = dirVector;
        runner.effects.lastStep = dirStep;
      }
      const segmentLength = runner.segmentLengths[runner.segmentIndex] || 0;
      if (segmentLength === 0) {
        runner.segmentIndex++;
        runner.segmentProgress = 0;
        continue;
      }
      const segmentRemaining = segmentLength - runner.segmentProgress;
      if (remainingDistance < segmentRemaining) {
        runner.segmentProgress += remainingDistance;
        timeConsumed += remainingDistance / speed;
        distanceMoved += remainingDistance;
        remainingDistance = 0;
      } else {
        remainingDistance -= segmentRemaining;
        timeConsumed += segmentRemaining / speed;
        distanceMoved += segmentRemaining;
        runner.segmentIndex++;
        runner.segmentProgress = 0;
        triggerPanelForRunner(runner);
      }
    }
    runner.worldPos = runnerWorldPosition(runner);
    checkPanelUnderRunner(runner);
    if (runner.special?.placed) updateSpecialArea(runner, delta);
    if (runner.neutralSpecials?.length) updateNeutralSpecialEffects(runner, delta);
    const finishedThisFrame = runner.segmentIndex >= runner.segmentLengths.length;
    const frameContribution = finishedThisFrame ? Math.min(timeConsumed, delta) : delta;
    runner.elapsedTime += frameContribution;
    const diagnostics = runner.diagnostics;
    if (diagnostics && frameContribution > 0) {
      if (activeSlowCount > 0) diagnostics.slowActiveTime += frameContribution;
      if (activeSlowCount > 1) diagnostics.slowStackTime += frameContribution;
      if (activeFastCount > 0) diagnostics.fastActiveTime += frameContribution;
      if (activeFastCount > 1) diagnostics.fastStackTime += frameContribution;
      if (activeStone) {
        diagnostics.stoneActiveTime += frameContribution;
        diagnostics.stoneActiveDistance += distanceMoved;
      }
      const position = runner.worldPos || runnerWorldPosition(runner);
      const insideOwned = runner.special?.placed && isPointInsideSpecial(position, runner.special);
      if (insideOwned) {
        diagnostics.ownedHazardTime += frameContribution;
        if (activeSlowCount > 0) diagnostics.slowHazardOverlapTime += frameContribution;
        if (activeFastCount > 0) diagnostics.speedHazardOverlapTime += frameContribution;
        if (activeStone) diagnostics.stoneHazardOverlapTime += frameContribution;
      }
    }
    updatePadEffectStates(runner);
    if (finishedThisFrame) {
      runner.finished = true;
      runner.resultTime = runner.elapsedTime;
    }
  }

  function segmentDirectionVector(path, index) {
    if (!path || index == null || index >= path.length - 1 || index < 0) return null;
    const start = centerOf(path[index]);
    const end = centerOf(path[index + 1]);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    return { x: dx / len, y: dy / len };
  }

  function segmentStep(path, index) {
    const dir = segmentDirectionVector(path, index);
    if (!dir) return null;
    return {
      x: dir.x > 0.1 ? 1 : dir.x < -0.1 ? -1 : 0,
      y: dir.y > 0.1 ? 1 : dir.y < -0.1 ? -1 : 0
    };
  }

  function runnerWorldPosition(runner) {
    if (!runner.path.length) return { x: ENTRANCE_X + 0.5, y: GRID_SIZE - 0.5 };
    if (runner.segmentIndex >= runner.path.length - 1) {
      return centerOf(runner.path[runner.path.length - 1]);
    }
    const start = runner.path[runner.segmentIndex];
    const end = runner.path[runner.segmentIndex + 1];
    const startCenter = centerOf(start);
    const endCenter = centerOf(end);
    const segmentLength = runner.segmentLengths[runner.segmentIndex] || 1;
    const t = Math.min(1, runner.segmentProgress / segmentLength);
    const pos = {
      x: startCenter.x + (endCenter.x - startCenter.x) * t,
      y: startCenter.y + (endCenter.y - startCenter.y) * t
    };
    if (runner.effects.gravityOffset) {
      pos.x += runner.effects.gravityOffset.x;
      pos.y += runner.effects.gravityOffset.y;
    }
    return pos;
  }

  function updateRunnerEffects(runner, delta) {
    const effects = runner.effects;
    if (!effects.slowTimers.length && effects.slowTimer > 0) effects.slowTimers.push(effects.slowTimer);
    let writeIndex = 0;
    for (let index = 0; index < effects.slowTimers.length; index++) {
      const timer = Math.max(0, effects.slowTimers[index] - delta);
      if (timer > 0) effects.slowTimers[writeIndex++] = timer;
    }
    effects.slowTimers.length = writeIndex;
    if (!effects.fastTimers.length && effects.fastTimer > 0) effects.fastTimers.push(effects.fastTimer);
    writeIndex = 0;
    for (let index = 0; index < effects.fastTimers.length; index++) {
      const timer = Math.max(0, effects.fastTimers[index] - delta);
      if (timer > 0) effects.fastTimers[writeIndex++] = timer;
    }
    effects.fastTimers.length = writeIndex;
    effects.slowTimer = effects.slowTimers.length ? Math.max(...effects.slowTimers) : 0;
    effects.fastTimer = effects.fastTimers.length ? Math.max(...effects.fastTimers) : 0;
    if (effects.stunTimer > 0) effects.stunTimer = Math.max(0, effects.stunTimer - delta);
    if (effects.neutralSlowTimer > 0) effects.neutralSlowTimer = Math.max(0, effects.neutralSlowTimer - delta);
    if (effects.stunTimer > 0) {
      runner.effects.speedMultiplier = 0;
      return;
    }
    const specialType = runner.special?.type;
    if (effects.areaTimer > 0 && specialType !== "radius") {
      effects.areaTimer = Math.max(0, effects.areaTimer - delta);
    }
    let mult = 1;
    if (effects.slowTimers.length) mult *= Math.pow(PANEL_SLOW_MULT, effects.slowTimers.length);
    if (specialType === "radius") {
      if (effects.areaTimer > 0) {
        const ratio = Math.min(1, effects.areaTimer / FREEZING_BUILDUP);
        const auraMult = SPECIAL_SLOW_MULT - (SPECIAL_SLOW_MULT - FREEZING_MIN_MULT) * ratio;
        mult *= auraMult;
      }
    } else if (effects.areaTimer > 0) {
      mult *= SPECIAL_SLOW_MULT;
    }
    if (effects.neutralSlowTimer > 0) mult *= SPECIAL_SLOW_MULT;
    if (effects.fastTimers.length) mult *= Math.pow(PANEL_FAST_MULT, effects.fastTimers.length);
    if (effects.medusaActive) mult *= MEDUSA_SLOW_MULT;
    if (effects.gravityActive && effects.gravityPull) {
      mult *= pressureFieldMultiplier(effects.gravityPull.distance);
    }
    runner.effects.speedMultiplier = mult;
  }

  function isPadActiveCell(value) {
    return (
      value === CELL_SPEED ||
      value === CELL_SLOW ||
      value === CELL_DETOUR ||
      value === CELL_STONE ||
      value === CELL_REWIND
    );
  }

  function padUsedVariant(value) {
    if (value === CELL_SPEED) return CELL_SPEED_USED;
    if (value === CELL_SLOW) return CELL_SLOW_USED;
    if (value === CELL_DETOUR) return CELL_DETOUR_USED;
    if (value === CELL_STONE) return CELL_STONE_USED;
    if (value === CELL_REWIND) return CELL_REWIND_USED;
    return value;
  }

  function triggerPanelForRunner(runner) {
    const node = runner.path[runner.segmentIndex];
    if (!node) return;
    const value = runner.grid[node.y]?.[node.x];
    if (isPadActiveCell(value)) {
      applyPanelEffect(runner, node.x, node.y, value);
    }
  }

  function checkPanelUnderRunner(runner) {
    const pos = runner.worldPos || runnerWorldPosition(runner);
    const radius = 0.35;
    const minX = Math.max(0, Math.floor(pos.x - radius));
    const maxX = Math.min(GRID_SIZE - 1, Math.floor(pos.x + radius));
    const minY = Math.max(0, Math.floor(pos.y - radius));
    const maxY = Math.min(GRID_SIZE - 1, Math.floor(pos.y + radius));
    for (let gy = minY; gy <= maxY; gy++) {
      for (let gx = minX; gx <= maxX; gx++) {
        const value = runner.grid[gy][gx];
        if (isPadActiveCell(value)) applyPanelEffect(runner, gx, gy, value);
      }
    }
  }

  function applyPanelEffect(runner, x, y, value) {
    if (!isPadActiveCell(value)) return;
    const padType = padTypeFromCell(value);
    runner.grid[y][x] = padUsedVariant(value);
    const event = { type: padType, x, y, time: runner.elapsedTime };
    runner.diagnostics?.padEvents.push(event);
    if (padType === "speed") {
      runner.effects.fastTimers.push(PANEL_EFFECT_DURATION);
      runner.effects.fastTimer = PANEL_EFFECT_DURATION;
    } else if (padType === "slow") {
      runner.effects.slowTimers.push(PANEL_EFFECT_DURATION);
      runner.effects.slowTimer = PANEL_EFFECT_DURATION;
    } else if (padType === "detour") {
      event.reverseDistance = triggerDetourPad(runner, x, y);
      if (runner.diagnostics) runner.diagnostics.detourReverseDistance += event.reverseDistance || 0;
    } else if (padType === "stone") {
      triggerStonePad(runner);
      event.direction = runner.effects.medusaDir ? { ...runner.effects.medusaDir } : null;
    } else if (padType === "rewind") {
      event.prefixTime = runner.elapsedTime;
      if (runner.diagnostics) runner.diagnostics.rewindPrefixTime += runner.elapsedTime;
      triggerRewindPad(runner);
    }
    updateRunnerEffects(runner, 0);
  }

  function updatePadEffectStates(runner) {
    if (runner.effects.medusaActive) {
      const dir = runner.effects.lastDir;
      if (dir) {
        const dot = runner.effects.medusaDir
          ? runner.effects.medusaDir.x * dir.x + runner.effects.medusaDir.y * dir.y
          : 1;
        if (dot < 0.98) {
          runner.effects.medusaActive = false;
          runner.effects.medusaDir = null;
        }
      }
    }
  }

  function applyRunnerPath(runner, newPath) {
    if (!newPath.length) return;
    runner.path = newPath;
    const segmentMetadata = computeSegmentMetadata(newPath);
    runner.segmentLengths = segmentMetadata.lengths;
    runner.segmentDirections = segmentMetadata.directions;
    runner.segmentSteps = segmentMetadata.steps;
    runner.segmentIndex = 0;
    runner.segmentProgress = 0;
    runner.worldPos = runnerWorldPosition(runner);
    runner.finished = false;
    runner.resultTime = null;
    runner.effects.lastDir = null;
    runner.effects.lastStep = null;
    runner.effects.gravityOffset = null;
    runner.effects.gravityActive = false;
    runner.effects.gravityPull = null;
    runner.effects.neutralSlowTimer = 0;
  }

  function triggerDetourPad(runner, x, y) {
    const lastStep = runner.effects.lastStep || segmentStep(runner.path, runner.segmentIndex);
    if (!lastStep) return 0;
    const stepX = -lastStep.x;
    const stepY = -lastStep.y;
    if (stepX === 0 && stepY === 0) return 0;
    const forced = [{ x, y }];
    let currentX = x;
    let currentY = y;
    while (true) {
      const nextX = currentX + stepX;
      const nextY = currentY + stepY;
      if (!isInsideGrid(nextX, nextY)) break;
      if (!isWalkableCell(runner.grid, nextX, nextY)) break;
      forced.push({ x: nextX, y: nextY });
      currentX = nextX;
      currentY = nextY;
    }
    if (forced.length < 2) return 0;
    const finalCell = forced[forced.length - 1];
    const onward = computePathFromCell(runner.grid, finalCell);
    if (!onward.length) return 0;
    const tail = onward.slice(1);
    const newPath = forced.concat(tail);
    applyRunnerPath(runner, newPath);
    return forced.length - 1;
  }

  function triggerStonePad(runner) {
    runner.effects.medusaActive = true;
    runner.effects.medusaDir = runner.effects.lastDir ? { ...runner.effects.lastDir } : null;
  }

  function triggerRewindPad(runner) {
    const restart = computePath(runner.grid);
    if (!restart.length) return;
    applyRunnerPath(runner, restart);
    runner.effects.fastTimer = 0;
    runner.effects.slowTimer = 0;
    runner.effects.fastTimers = [];
    runner.effects.slowTimers = [];
    runner.effects.neutralSlowTimer = 0;
    runner.effects.areaTimer = 0;
    runner.effects.medusaActive = false;
    runner.effects.medusaDir = null;
  }

  function updateSpecialArea(runner, delta) {
    const special = runner.special;
    if (!special?.placed || !special.cell) {
      runner.effects.areaTimer = 0;
      runner.effects.gravityActive = false;
      runner.effects.gravityPull = null;
      runner.effects.gravityOffset = null;
      return;
    }
    const pos = runner.worldPos || runnerWorldPosition(runner);
    if (special.type === "gravity") {
      const centerX = special.cell.x + 0.5;
      const centerY = special.cell.y + 0.5;
      const dx = centerX - pos.x;
      const dy = centerY - pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= GRAVITY_RADIUS) {
        runner.effects.gravityActive = true;
        runner.effects.gravityPull = { distance: dist };
        runner.effects.gravityOffset = null;
      } else {
        runner.effects.gravityActive = false;
        runner.effects.gravityPull = null;
        runner.effects.gravityOffset = null;
      }
      runner.effects.areaTimer = 0;
      return;
    }
    runner.effects.gravityActive = false;
    runner.effects.gravityPull = null;
    runner.effects.gravityOffset = null;
    if (special.type === "radius") {
      if (isPointInsideSpecial(pos, special)) {
        runner.effects.areaTimer = Math.min(FREEZING_BUILDUP, runner.effects.areaTimer + delta);
      } else {
        const decayRate = FREEZING_BUILDUP / SPECIAL_EFFECT_DURATION;
        runner.effects.areaTimer = Math.max(0, runner.effects.areaTimer - decayRate * delta);
      }
      return;
    }
    if (special.type === "lightning") {
      special.cooldown = Math.max(0, (special.cooldown || 0) - delta);
      special.flashTimer = Math.max(0, (special.flashTimer || 0) - delta);
      const centerX = special.cell.x + 0.5;
      const centerY = special.cell.y + 0.5;
      const dist = Math.hypot(centerX - pos.x, centerY - pos.y);
      if (dist <= LIGHTNING_EFFECT_RADIUS + 0.35 && special.cooldown <= 0 && runner.effects.stunTimer <= 0) {
        runner.effects.stunTimer = LIGHTNING_STUN;
        special.cooldown = LIGHTNING_COOLDOWN;
        special.flashTimer = 0.3;
      }
      runner.effects.areaTimer = 0;
      return;
    }
    if (isPointInsideSpecial(pos, special)) {
      special.effectTimer = SPECIAL_EFFECT_DURATION;
    } else if (special.effectTimer > 0) {
      special.effectTimer = Math.max(0, special.effectTimer - delta);
    }
    runner.effects.areaTimer = special.effectTimer;
  }

  function updateNeutralSpecialEffects(runner, delta) {
    const list = runner.neutralSpecials;
    if (!list?.length) return;
    const pos = runner.worldPos || runnerWorldPosition(runner);
    list.forEach((special) => {
      special.cooldown = Math.max(0, (special.cooldown || 0) - delta);
      special.flashTimer = Math.max(0, (special.flashTimer || 0) - delta);
      if (special.effectTimer > 0) special.effectTimer = Math.max(0, special.effectTimer - delta);
      if (!special.cell) return;
      if (special.type === "lightning") {
        if (special.cooldown <= 0 && isPointInsideSpecial(pos, special) && runner.effects.stunTimer <= 0) {
          runner.effects.stunTimer = LIGHTNING_STUN;
          special.cooldown = LIGHTNING_COOLDOWN;
          special.flashTimer = 0.3;
        }
        return;
      }
      if (special.type === "row" || special.type === "column") {
        if (isPointInsideSpecial(pos, special)) {
          runner.effects.neutralSlowTimer = SPECIAL_LINGER;
        }
      }
    });
  }

  function isPointInsideSpecial(pos, special) {
    if (!special?.placed || !special.cell) return false;
    const { x, y } = special.cell;
    if (special.type === "radius" || special.type === "gravity" || special.type === "lightning") {
      const dx = pos.x - (x + 0.5);
      const dy = pos.y - (y + 0.5);
      const radius = special.type === "gravity" ? GRAVITY_RADIUS : SPECIAL_RADIUS;
      return dx * dx + dy * dy <= radius * radius;
    }
    if (special.type === "row") return pos.y >= y && pos.y <= y + 1;
    if (special.type === "column") return pos.x >= x && pos.x <= x + 1;
    return false;
  }

  function cloneSpecial(special) {
    if (!special) return null;
    return {
      type: special.type,
      cell: special.cell ? { ...special.cell } : null,
      placed: special.placed,
      effectTimer: 0,
      cooldown: special.cooldown || 0,
      flashTimer: 0,
      neutral: !!special.neutral
    };
  }

  function cloneNeutralSpecials(list) {
    if (!list) return [];
    return list.map((special) => cloneSpecial(special));
  }

  function computePathFromCell(grid, startCell) {
    if (!startCell) return [];
    const goal = { x: ENTRANCE_X, y: 0 };
    const path = findPath(grid, { x: startCell.x, y: startCell.y }, goal);
    if (!path.length) return [];
    path.push({ x: ENTRANCE_X, y: -1 });
    return path;
  }

  function hashSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return h >>> 0;
  }

  // Constants
  const GRID_SIZE = 21;
  const ENTRANCE_X = Math.floor(GRID_SIZE / 2);
  const NPC_SPEED = 3;
  const NPC_RADIUS = 0.35;
  const FIXED_TIMESTEP = 1 / 120;
  const PANEL_EFFECT_DURATION = 5;
  const PANEL_SLOW_MULT = 0.55;
  const PANEL_FAST_MULT = 1.5;
  const MEDUSA_SLOW_MULT = 0.3;
  const SPECIAL_RADIUS = 4;
  const GRAVITY_RADIUS = 6;
  const SPECIAL_LINGER = 3;
  const SPECIAL_SLOW_MULT = 0.7;
  const FREEZING_BUILDUP = 10;
  const FREEZING_MIN_MULT = 0.3;
  const LIGHTNING_STUN = 1.5;
  const LIGHTNING_COOLDOWN = 3.25;
  const LIGHTNING_EFFECT_RADIUS = 4;
  const GRAVITY_MIN_MULT = 0.15;
  const GRAVITY_MAX_MULT = 0.85;
  const GRAVITY_CURVE_EXPONENT = 1.8;

  function pressureFieldMultiplier(distance) {
    const ratio = Math.max(0, Math.min(1, distance / GRAVITY_RADIUS));
    const curvedRatio = Math.pow(ratio, GRAVITY_CURVE_EXPONENT);
    return GRAVITY_MIN_MULT + (GRAVITY_MAX_MULT - GRAVITY_MIN_MULT) * curvedRatio;
  }

  function nowMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }
  const AI_PATH_WEIGHT = 12;
  const PAD_SLOW_EXTRA_TIME = PANEL_EFFECT_DURATION * (1 / PANEL_SLOW_MULT - 1);
  const PAD_SPEED_TIME_DELTA = PANEL_EFFECT_DURATION * (1 - 1 / PANEL_FAST_MULT);
  const PAD_STONE_EXTRA_TIME = 2 * (1 / MEDUSA_SLOW_MULT - 1);
  const PREDICT_SLOW_SCALE = 0.82;
  const SPECIAL_PAD_SYNERGY_TIME = PANEL_EFFECT_DURATION * (1 / PANEL_SLOW_MULT - 1);
  const SPECIAL_PAD_SYNERGY_STRONG_TIME = SPECIAL_PAD_SYNERGY_TIME * 1.25;
  const SPECIAL_NEUTRAL_OVERLAP_TIME = SPECIAL_LINGER * (1 / SPECIAL_SLOW_MULT - 1) * 0.75;
  const SPECIAL_EFFECT_DURATION = SPECIAL_LINGER;
  const BEAM_LINGER_CAP = 1.5;
  const MIN_BLOCK_RECLAIM_DELTA = 0.4;
  const RECLAIM_RUNTIME_THRESHOLD = 0.4;
  const RECLAIM_MAX_PASSES = 1;
  const COMBO_POOL_LIMIT = 3;
  const COMBO_LOOKAHEAD_DEPTH = 2;
  const SPECIAL_HOTSPOT_LIMIT = 5;
  const SPECIAL_HOTSPOT_TOLERANCE = 35;
  const SPECIAL_PATH_GAIN_THRESHOLD = 10;
  const MOVES = [
    { dx: 1, dy: 0, cost: 1, diagonal: false },
    { dx: -1, dy: 0, cost: 1, diagonal: false },
    { dx: 0, dy: 1, cost: 1, diagonal: false },
    { dx: 0, dy: -1, cost: 1, diagonal: false },
    { dx: 1, dy: 1, cost: Math.SQRT2, diagonal: true },
    { dx: -1, dy: 1, cost: Math.SQRT2, diagonal: true },
    { dx: 1, dy: -1, cost: Math.SQRT2, diagonal: true },
    { dx: -1, dy: -1, cost: Math.SQRT2, diagonal: true }
  ];

  const CELL_EMPTY = 0;
  const CELL_STATIC = 1;
  const CELL_PLAYER = 2;
  const CELL_SPEED = 3;
  const CELL_SLOW = 4;
  const CELL_SPEED_USED = 5;
  const CELL_SLOW_USED = 6;
  const CELL_SPECIAL = 7;
  const CELL_DETOUR = 8;
  const CELL_STONE = 9;
  const CELL_REWIND = 10;
  const CELL_DETOUR_USED = 11;
  const CELL_STONE_USED = 12;
  const CELL_REWIND_USED = 13;
  const CELL_SINGLE = 14;
  const CELL_STATIC_SPECIAL = 15;

  const PAD_AI_SCORES = {
    speed: -3,
    slow: 3,
    detour: 4,
    stone: 3,
    rewind: 8
  };

  const AI_WEIGHT_DEFAULTS = {
    pathTime: 2,
    pathTurns: 0.3,
    specialTime: 2,
    neutralSpecialTime: 1,
    slowTime: 1.75,
    slowStack: 1,
    slowInteraction: 0.05,
    blockUsage: 3,
    lightningPadPenalty: 1.5,
    beamCrossings: 2.5,
    speedExposure: 0
  };
  let activeGenerationMetrics = null;

  // Utility helpers
  const CARDINAL_NEIGHBORS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];

  function key(x, y) {
    return `${x},${y}`;
  }

  function keyFor(x, y) {
    return `${x},${y}`;
  }

  function cloneGrid(grid) {
    if (activeGenerationMetrics) activeGenerationMetrics.gridClones++;
    return grid.map((row) => row.slice());
  }

  function createEmptyGrid() {
    return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(CELL_EMPTY));
  }

  function randomInt(rng, min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
  }

  function isInsideGrid(x, y) {
    return x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE;
  }

  function centerOf(cell) {
    return { x: cell.x + 0.5, y: cell.y + 0.5 };
  }

  function padTypeFromCell(value) {
    if (value === CELL_SPEED || value === CELL_SPEED_USED) return "speed";
    if (value === CELL_SLOW || value === CELL_SLOW_USED) return "slow";
    if (value === CELL_DETOUR || value === CELL_DETOUR_USED) return "detour";
    if (value === CELL_STONE || value === CELL_STONE_USED) return "stone";
    if (value === CELL_REWIND || value === CELL_REWIND_USED) return "rewind";
    return null;
  }

  function isPadCell(value) {
    return Boolean(padTypeFromCell(value));
  }

  function isWalkableCell(grid, x, y) {
    const value = grid[y][x];
    return (
      value === CELL_EMPTY ||
      value === CELL_SPEED ||
      value === CELL_SLOW ||
      value === CELL_DETOUR ||
      value === CELL_STONE ||
      value === CELL_REWIND ||
      value === CELL_SPEED_USED ||
      value === CELL_SLOW_USED ||
      value === CELL_DETOUR_USED ||
      value === CELL_STONE_USED ||
      value === CELL_REWIND_USED
    );
  }

  function canPassDiagonal(grid, x, y, dx, dy) {
    const hx = x + dx;
    const vy = y + dy;
    if (!isWalkableCell(grid, hx, y)) return false;
    if (!isWalkableCell(grid, x, vy)) return false;
    return true;
  }

  function heuristic(x, y, gx, gy) {
    return Math.hypot(gx - x, gy - y);
  }

  const PATH_CELL_COUNT = GRID_SIZE * GRID_SIZE;
  const PATH_HEAP_CAPACITY = PATH_CELL_COUNT * MOVES.length * 2 + 1;
  const pathGScore = new Float64Array(PATH_CELL_COUNT);
  const pathParents = new Int16Array(PATH_CELL_COUNT);
  const pathClosed = new Uint8Array(PATH_CELL_COUNT);
  const pathHeapIds = new Int16Array(PATH_HEAP_CAPACITY);
  const pathHeapG = new Float64Array(PATH_HEAP_CAPACITY);
  const pathHeapF = new Float64Array(PATH_HEAP_CAPACITY);
  const pathHeapOrder = new Uint32Array(PATH_HEAP_CAPACITY);
  const pathExitHeuristic = new Float64Array(PATH_CELL_COUNT);
  for (let id = 0; id < PATH_CELL_COUNT; id++) {
    const x = id % GRID_SIZE;
    const y = Math.floor(id / GRID_SIZE);
    pathExitHeuristic[id] = heuristic(x, y, ENTRANCE_X, 0);
  }

  function runPathSearch(grid, start, goal, reconstruct = true) {
    if (activeGenerationMetrics) activeGenerationMetrics.pathSearches++;
    pathGScore.fill(Infinity);
    pathParents.fill(-1);
    pathClosed.fill(0);
    let heapSize = 0;
    let insertionOrder = 0;
    let poppedId = -1;
    let poppedG = 0;

    function comesBefore(left, right) {
      return (
        pathHeapF[left] < pathHeapF[right] ||
        (pathHeapF[left] === pathHeapF[right] && pathHeapOrder[left] < pathHeapOrder[right])
      );
    }

    function swapHeap(left, right) {
      let integer = pathHeapIds[left];
      pathHeapIds[left] = pathHeapIds[right];
      pathHeapIds[right] = integer;
      let number = pathHeapG[left];
      pathHeapG[left] = pathHeapG[right];
      pathHeapG[right] = number;
      number = pathHeapF[left];
      pathHeapF[left] = pathHeapF[right];
      pathHeapF[right] = number;
      integer = pathHeapOrder[left];
      pathHeapOrder[left] = pathHeapOrder[right];
      pathHeapOrder[right] = integer;
    }

    function pushOpen(id, g, f) {
      if (heapSize >= PATH_HEAP_CAPACITY) return false;
      let index = heapSize++;
      pathHeapIds[index] = id;
      pathHeapG[index] = g;
      pathHeapF[index] = f;
      pathHeapOrder[index] = insertionOrder++;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (!comesBefore(index, parent)) break;
        swapHeap(index, parent);
        index = parent;
      }
      return true;
    }

    function popOpen() {
      poppedId = pathHeapIds[0];
      poppedG = pathHeapG[0];
      heapSize--;
      if (heapSize > 0) {
        pathHeapIds[0] = pathHeapIds[heapSize];
        pathHeapG[0] = pathHeapG[heapSize];
        pathHeapF[0] = pathHeapF[heapSize];
        pathHeapOrder[0] = pathHeapOrder[heapSize];
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < heapSize && comesBefore(left, smallest)) smallest = left;
          if (right < heapSize && comesBefore(right, smallest)) smallest = right;
          if (smallest === index) break;
          swapHeap(index, smallest);
          index = smallest;
        }
      }
    }

    const startId = start.y * GRID_SIZE + start.x;
    const goalId = goal.y * GRID_SIZE + goal.x;
    const usesExitHeuristic = goal.x === ENTRANCE_X && goal.y === 0;
    pathGScore[startId] = 0;
    pushOpen(
      startId,
      0,
      usesExitHeuristic ? pathExitHeuristic[startId] : heuristic(start.x, start.y, goal.x, goal.y)
    );

    while (heapSize > 0) {
      popOpen();
      if (pathClosed[poppedId]) continue;
      pathClosed[poppedId] = 1;
      if (activeGenerationMetrics) activeGenerationMetrics.pathNodesExpanded++;
      if (poppedId === goalId) {
        if (!reconstruct) return true;
        const path = [];
        let id = goalId;
        while (id >= 0) {
          path.push({ x: id % GRID_SIZE, y: Math.floor(id / GRID_SIZE) });
          id = pathParents[id];
        }
        path.reverse();
        return path;
      }
      const currentX = poppedId % GRID_SIZE;
      const currentY = Math.floor(poppedId / GRID_SIZE);
      for (const move of MOVES) {
        const nx = currentX + move.dx;
        const ny = currentY + move.dy;
        if (!isInsideGrid(nx, ny) || !isWalkableCell(grid, nx, ny)) continue;
        if (move.diagonal && !canPassDiagonal(grid, currentX, currentY, move.dx, move.dy)) continue;
        const nextId = ny * GRID_SIZE + nx;
        const tentativeG = poppedG + move.cost;
        if (tentativeG >= pathGScore[nextId]) continue;
        pathParents[nextId] = poppedId;
        pathGScore[nextId] = tentativeG;
        const remaining = usesExitHeuristic ? pathExitHeuristic[nextId] : heuristic(nx, ny, goal.x, goal.y);
        if (!pushOpen(nextId, tentativeG, tentativeG + remaining)) return null;
      }
    }
    return reconstruct ? [] : false;
  }

  function findPath(grid, start, goal) {
    const path = runPathSearch(grid, start, goal, true);
    return Array.isArray(path) ? path : [];
  }

  function extendWithEntrances(path) {
    const extended = path.slice();
    extended.unshift({ x: ENTRANCE_X, y: GRID_SIZE });
    extended.push({ x: ENTRANCE_X, y: -1 });
    return extended;
  }

  function computePath(grid) {
    const start = { x: ENTRANCE_X, y: GRID_SIZE - 1 };
    const goal = { x: ENTRANCE_X, y: 0 };
    const raw = findPath(grid, start, goal);
    if (!raw.length) return [];
    return extendWithEntrances(raw);
  }

  function ensureOpenings(grid) {
    clearBlockingAt(grid, ENTRANCE_X, 0);
    clearBlockingAt(grid, ENTRANCE_X, GRID_SIZE - 1);
    grid[GRID_SIZE - 1][ENTRANCE_X] =
      grid[GRID_SIZE - 1][ENTRANCE_X] === CELL_STATIC ? CELL_STATIC : CELL_EMPTY;
    grid[0][ENTRANCE_X] = grid[0][ENTRANCE_X] === CELL_STATIC ? CELL_STATIC : CELL_EMPTY;
  }

  function hasPath(grid) {
    const start = { x: ENTRANCE_X, y: GRID_SIZE - 1 };
    const goal = { x: ENTRANCE_X, y: 0 };
    return runPathSearch(grid, start, goal, false) === true;
  }

  function computeSegmentLengths(path) {
    const lengths = [];
    for (let index = 0; index < path.length - 1; index++) {
      lengths.push(Math.hypot(path[index + 1].x - path[index].x, path[index + 1].y - path[index].y));
    }
    return lengths;
  }

  function computeSegmentMetadata(path) {
    const lengths = [];
    const directions = [];
    const steps = [];
    for (let i = 0; i < path.length - 1; i++) {
      const dx = path[i + 1].x - path[i].x;
      const dy = path[i + 1].y - path[i].y;
      const length = Math.hypot(dx, dy);
      lengths.push(length);
      directions.push(length > 0 ? { x: dx / length, y: dy / length } : null);
      steps.push(length > 0 ? { x: Math.sign(dx), y: Math.sign(dy) } : null);
    }
    return { lengths, directions, steps };
  }

  function computePadScore(grid, path) {
    let score = 0;
    const visited = new Set();
    for (const node of path) {
      if (!isInsideGrid(node.x, node.y)) continue;
      const k = key(node.x, node.y);
      if (visited.has(k)) continue;
      visited.add(k);
      const value = grid[node.y][node.x];
      const padType = padTypeFromCell(value);
      if (padType && PAD_AI_SCORES[padType]) score += PAD_AI_SCORES[padType];
    }
    return score;
  }

  function analyzePath(grid) {
    const path = computePath(grid);
    if (!path.length) return null;
    const lengths = computeSegmentLengths(path);
    const totalDistance = lengths.reduce((a, b) => a + b, 0);
    const padScore = computePadScore(grid, path);
    return { path, lengths, totalDistance, padScore };
  }

  function computePathTurnCount(path) {
    if (!path || path.length < 3) return 0;
    let turns = 0;
    let prevDx = Math.sign(path[1].x - path[0].x);
    let prevDy = Math.sign(path[1].y - path[0].y);
    for (let i = 2; i < path.length; i++) {
      const dx = Math.sign(path[i].x - path[i - 1].x);
      const dy = Math.sign(path[i].y - path[i - 1].y);
      if (dx !== prevDx || dy !== prevDy) turns++;
      prevDx = dx;
      prevDy = dy;
    }
    return turns;
  }

  function evaluateGridForAi(
    grid,
    special = null,
    neutralSpecials = [],
    pathInfoOverride = null,
    aiWeights = AI_WEIGHT_DEFAULTS,
    baseGridForUsage = null
  ) {
    const info = pathInfoOverride || analyzePath(grid);
    if (!info) return -Infinity;
    const predicted = estimatePredictedRunTime(grid, info, special, neutralSpecials);
    const components = predicted.components || {
      slowTime: 0,
      slowStackTime: 0,
      specialOwnedTime: 0,
      specialNeutralTime: 0
    };
    const pathContribution = (info.totalDistance / NPC_SPEED) * aiWeights.pathTime;
    const turnContribution = computePathTurnCount(info.path) * aiWeights.pathTurns;
    const slowContribution = (components.slowTime || 0) * aiWeights.slowTime;
    const slowStackContribution = (components.slowStackTime || 0) * aiWeights.slowStack;
    const specialContribution = (components.specialOwnedTime || 0) * aiWeights.specialTime;
    const neutralSpecialContribution = (components.specialNeutralTime || 0) * aiWeights.neutralSpecialTime;
    const lightningPenalty = (predicted.lightningPenalty || 0) * aiWeights.lightningPadPenalty;
    const beamCross = computeBeamCrossings(info.path, special) * aiWeights.beamCrossings;
    const blockUsage = computeBlockUsageScore(grid, info.path, baseGridForUsage) * aiWeights.blockUsage;
    const detourDistance = computeDetourDistance(grid, info) * aiWeights.slowInteraction;
    const speedExposurePenalty = computeSpeedExposurePenalty(grid, info) * (aiWeights.speedExposure || 0);

    return (
      info.totalDistance * AI_PATH_WEIGHT +
      info.padScore +
      pathContribution +
      turnContribution +
      slowContribution +
      slowStackContribution +
      specialContribution +
      neutralSpecialContribution +
      lightningPenalty +
      beamCross +
      blockUsage +
      detourDistance -
      speedExposurePenalty
    );
  }

  // Placement helpers
  function canPlaceBlock(grid, gx, gy) {
    if (gx < 0 || gy < 0 || gx + 1 >= GRID_SIZE || gy + 1 >= GRID_SIZE) return false;
    for (let y = gy; y <= gy + 1; y++) {
      for (let x = gx; x <= gx + 1; x++) {
        const v = grid[y][x];
        if (v !== CELL_EMPTY) return false;
        if ((y === 0 || y === GRID_SIZE - 1) && x === ENTRANCE_X) return false;
      }
    }
    return true;
  }

  function placeBlock(grid, gx, gy, value) {
    grid[gy][gx] = value;
    grid[gy + 1][gx] = value;
    grid[gy][gx + 1] = value;
    grid[gy + 1][gx + 1] = value;
  }

  function clearBlock(grid, gx, gy) {
    grid[gy][gx] = CELL_EMPTY;
    grid[gy + 1][gx] = CELL_EMPTY;
    grid[gy][gx + 1] = CELL_EMPTY;
    grid[gy + 1][gx + 1] = CELL_EMPTY;
  }

  function clearBlockingAt(grid, x, y) {
    const val = grid[y]?.[x];
    if (val === CELL_PLAYER) {
      const anchorX = grid[y][x - 1] === CELL_PLAYER ? x - 1 : x;
      const anchorY = grid[y - 1]?.[x] === CELL_PLAYER ? y - 1 : y;
      clearBlock(grid, anchorX, anchorY);
    } else if (val === CELL_SINGLE) {
      grid[y][x] = CELL_EMPTY;
    }
  }

  function restoreBlock(grid, entry) {
    const x = entry.column != null ? entry.column - 1 : entry.x;
    const y = entry.row != null ? entry.row - 1 : entry.y;
    if (entry.type === "wall") {
      placeBlock(grid, x, y, CELL_PLAYER);
    } else if (entry.type === "single") {
      grid[y][x] = CELL_SINGLE;
    } else if (entry.type === "special" && entry.specialCell) {
      grid[entry.specialCell.y][entry.specialCell.x] = CELL_SPECIAL;
    }
  }

  function listAiWallOrigins(grid, preferredCells = null) {
    const walls = [];
    const preferred = preferredCells || null;
    for (let y = 0; y < GRID_SIZE - 1; y++) {
      for (let x = 0; x < GRID_SIZE - 1; x++) {
        if (
          grid[y][x] === CELL_PLAYER &&
          grid[y + 1][x] === CELL_PLAYER &&
          grid[y][x + 1] === CELL_PLAYER &&
          grid[y + 1][x + 1] === CELL_PLAYER
        ) {
          const cellKey = keyFor(x, y);
          if (!preferred || preferred.has(cellKey)) {
            walls.push({ x, y });
          }
        }
      }
    }
    if (!walls.length && preferred) {
      return listAiWallOrigins(grid, null);
    }
    return walls;
  }

  function listAiSingleCells(grid, preferredCells = null) {
    const singles = [];
    const preferred = preferredCells || null;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (grid[y][x] === CELL_SINGLE) {
          if (!preferred || preferred.has(keyFor(x, y))) {
            singles.push({ x, y });
          }
        }
      }
    }
    if (!singles.length && preferred) {
      return listAiSingleCells(grid, null);
    }
    return singles;
  }

  function canPlaceSingle(grid, gx, gy) {
    if (!isInsideGrid(gx, gy)) return false;
    const v = grid[gy][gx];
    if (v !== CELL_EMPTY) return false;
    if ((gy === 0 || gy === GRID_SIZE - 1) && gx === ENTRANCE_X) return false;
    return true;
  }

  function isCellAvailableForSpecial(grid, gx, gy) {
    if (!isInsideGrid(gx, gy)) return false;
    if ((gy === 0 || gy === GRID_SIZE - 1) && gx === ENTRANCE_X) return false;
    const value = grid[gy][gx];
    if (
      value === CELL_STATIC ||
      value === CELL_STATIC_SPECIAL ||
      value === CELL_PLAYER ||
      value === CELL_SPECIAL ||
      value === CELL_SINGLE
    ) {
      return false;
    }
    return !isPadCell(value);
  }

  function applyPlacementCandidate(grid, candidate) {
    if (!candidate) return;
    if (candidate.type === "wall") {
      placeBlock(grid, candidate.x, candidate.y, CELL_PLAYER);
    } else if (candidate.type === "single") {
      candidate.previous = grid[candidate.y][candidate.x];
      grid[candidate.y][candidate.x] = CELL_SINGLE;
    }
    ensureOpenings(grid);
  }

  function revertPlacementCandidate(grid, candidate) {
    if (!candidate) return;
    if (candidate.type === "wall") {
      clearBlock(grid, candidate.x, candidate.y);
    } else if (candidate.type === "single") {
      const prev = candidate.previous != null ? candidate.previous : CELL_EMPTY;
      grid[candidate.y][candidate.x] = prev;
      candidate.previous = null;
    }
    ensureOpenings(grid);
  }

  function generateRandomCandidates(rng, count) {
    const results = [];
    for (let i = 0; i < count; i++) {
      results.push({
        x: Math.floor(rng() * (GRID_SIZE - 1)),
        y: 1 + Math.floor(rng() * (GRID_SIZE - 2))
      });
    }
    return results;
  }

  function insertCandidate(list, candidate, limit) {
    list.push(candidate);
    list.sort((a, b) => b.score - a.score);
    if (list.length > limit) list.length = limit;
  }

  // Speed pad handling
  function padIsMandatory(grid, x, y) {
    if (!isInsideGrid(x, y)) return false;
    const value = grid[y][x];
    if (padTypeFromCell(value) !== "speed") return false;
    const testGrid = cloneGrid(grid);
    testGrid[y][x] = CELL_PLAYER;
    ensureOpenings(testGrid);
    return !hasPath(testGrid);
  }

  function countMandatorySpeedPads(grid, path) {
    if (!path?.length) return 0;
    let count = 0;
    const checked = new Set();
    path.forEach((node) => {
      if (!isInsideGrid(node.x, node.y)) return;
      const k = keyFor(node.x, node.y);
      if (checked.has(k)) return;
      checked.add(k);
      const value = grid[node.y]?.[node.x];
      if (padTypeFromCell(value) === "speed" && padIsMandatory(grid, node.x, node.y)) {
        count++;
      }
    });
    return count;
  }

  function collectMandatorySpeedPads(grid) {
    const info = analyzePath(grid);
    if (!info?.path?.length) return [];
    const pads = [];
    info.path.forEach((node) => {
      if (!isInsideGrid(node.x, node.y)) return;
      const value = grid[node.y]?.[node.x];
      if (padTypeFromCell(value) === "speed" && padIsMandatory(grid, node.x, node.y)) {
        pads.push({ x: node.x, y: node.y });
      }
    });
    return pads;
  }

  function getDiversionCandidates(grid, px, py) {
    const cells = [];
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (!isInsideGrid(x, y)) continue;
        if (Math.abs(dx) + Math.abs(dy) === 0) continue;
        if (grid[y][x] === CELL_EMPTY) cells.push({ x, y });
      }
    }
    return cells;
  }

  function tryDivertSpeedPad(
    grid,
    special,
    neutralSpecials,
    currentScore,
    pad,
    aiWeights = AI_WEIGHT_DEFAULTS,
    baseGrid = null
  ) {
    const forcedCells = getDiversionCandidates(grid, pad.x, pad.y);
    if (!forcedCells.length) return { changed: false, score: currentScore };
    const singles = findTopAiSingleCandidates(grid, special, neutralSpecials, forcedCells, 3, aiWeights, baseGrid);
    if (!singles.length) return { changed: false, score: currentScore };
    const best = singles[0];
    if (best.score > currentScore) {
      grid[best.y][best.x] = CELL_SINGLE;
      ensureOpenings(grid);
      return { changed: true, score: best.score };
    }
    return { changed: false, score: currentScore };
  }

  function reduceMandatorySpeedPads(
    grid,
    special,
    neutralSpecials,
    currentScore,
    aiWeights = AI_WEIGHT_DEFAULTS,
    baseGrid = null
  ) {
    let score = currentScore;
    const mandatoryPads = collectMandatorySpeedPads(grid);
    mandatoryPads.forEach((pad) => {
      const result = tryDivertSpeedPad(grid, special, neutralSpecials, score, pad, aiWeights, baseGrid);
      if (result.changed) score = result.score;
    });
    return score;
  }

  // Candidate search
  function collectSpeedPadSteerCells(grid, pathOverride = null) {
    const path = pathOverride || computePath(grid);
    if (!path.length) return [];
    const cells = new Set();
    path.forEach((node) => {
      if (grid[node.y]?.[node.x] !== CELL_SPEED) return;
      CARDINAL_NEIGHBORS.forEach(([dx, dy]) => {
        const nx = node.x + dx;
        const ny = node.y + dy;
        if (!isInsideGrid(nx, ny)) return;
        if (!canPlaceSingle(grid, nx, ny)) return;
        cells.add(key(nx, ny));
      });
    });
    return Array.from(cells).map((entry) => {
      const [x, y] = entry.split(",").map(Number);
      return { x, y };
    });
  }

  function findTopAiWallCandidates(
    grid,
    special,
    neutralSpecials,
    limit = COMBO_POOL_LIMIT,
    aiWeights = AI_WEIGHT_DEFAULTS,
    baseGrid = null,
    rng = null,
    pathInfoOverride = null
  ) {
    const results = [];
    const basePath = pathInfoOverride?.path || computePath(grid);
    if (!basePath.length) return results;
    const candidateKeys = new Set();
    basePath.forEach((node) => {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          candidateKeys.add(key(node.x + dx, node.y + dy));
        }
      }
    });
    const targeted = Array.from(candidateKeys).map((entry) => {
      const [x, y] = entry.split(",").map(Number);
      return { x, y };
    });
    const wallCandidates = targeted.length
      ? targeted
      : generateRandomCandidates(rng || mulberry32(hashSeed("wall")), 80);
    wallCandidates.forEach((cand) => {
      if (!canPlaceBlock(grid, cand.x, cand.y)) return;
      placeBlock(grid, cand.x, cand.y, CELL_PLAYER);
      ensureOpenings(grid);
      const score = evaluateGridForAi(grid, special, neutralSpecials, null, aiWeights, baseGrid);
      clearBlock(grid, cand.x, cand.y);
      ensureOpenings(grid);
      if (!Number.isFinite(score)) return;
      insertCandidate(results, { type: "wall", x: cand.x, y: cand.y, score }, limit);
    });
    return results;
  }

  function findTopAiSingleCandidates(
    grid,
    special,
    neutralSpecials,
    forcedCells = null,
    limit = COMBO_POOL_LIMIT,
    aiWeights = AI_WEIGHT_DEFAULTS,
    baseGrid = null,
    pathInfoOverride = null
  ) {
    const basePath = pathInfoOverride?.path || computePath(grid);
    if (!basePath.length) return [];
    const singleCandidates = new Set();
    function addSingle(x, y) {
      if (isInsideGrid(x, y)) singleCandidates.add(key(x, y));
    }
    basePath.forEach((node) => {
      addSingle(node.x, node.y);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          addSingle(node.x + dx, node.y + dy);
        }
      }
    });
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const value = grid[y][x];
        if (value !== CELL_PLAYER && value !== CELL_SINGLE) continue;
        for (let dx = -2; dx <= 2; dx++) {
          for (let dy = -2; dy <= 2; dy++) {
            addSingle(x + dx, y + dy);
          }
        }
      }
    }
    if (forcedCells?.length) {
      forcedCells.forEach((cell) => {
        if (cell && isInsideGrid(cell.x, cell.y)) singleCandidates.add(key(cell.x, cell.y));
      });
    }
    const results = [];
    for (const entry of singleCandidates) {
      const [cx, cy] = entry.split(",").map(Number);
      if (!canPlaceSingle(grid, cx, cy)) continue;
      const previous = grid[cy][cx];
      grid[cy][cx] = CELL_SINGLE;
      ensureOpenings(grid);
      const score = evaluateGridForAi(grid, special, neutralSpecials, null, aiWeights, baseGrid);
      grid[cy][cx] = previous;
      ensureOpenings(grid);
      if (!Number.isFinite(score)) continue;
      insertCandidate(results, { type: "single", x: cx, y: cy, score }, limit);
    }
    return results;
  }

  function generateRandomSingleCandidates(count, rng = mulberry32(1)) {
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push({
        x: Math.floor(rng() * (GRID_SIZE - 1)),
        y: 1 + Math.floor(rng() * (GRID_SIZE - 2))
      });
    }
    return out;
  }

  function evaluatePlacementSequences(
    grid,
    special,
    neutralSpecials,
    wallPool,
    singlePool,
    budgetInfo,
    aiWeights = AI_WEIGHT_DEFAULTS,
    baseGrid = null,
    pathInfoOverride = null,
    currentScore = null
  ) {
    if (!budgetInfo) return null;
    const wallsLeft = budgetInfo.wallsLeft || 0;
    const singlesLeft = budgetInfo.singlesLeft || 0;
    const specialHotspots = budgetInfo.specialHotspots || [];
    const pools = {
      walls: wallPool.slice(0, COMBO_POOL_LIMIT),
      singles: singlePool.slice(0, COMBO_POOL_LIMIT),
      specials: !special?.placed ? specialHotspots.slice(0, COMBO_POOL_LIMIT) : []
    };
    if (!pools.walls.length && !pools.singles.length && !pools.specials.length) return null;

    let best = null;
    const maxDepth = Math.max(
      1,
      Math.min(COMBO_LOOKAHEAD_DEPTH, wallsLeft + singlesLeft + (special?.placed ? 0 : 1))
    );

    function dfs(currentGrid, currentSpecial, wLeft, sLeft, depth, firstMoveUsed, usedSpecial, knownScore = null) {
      const score = Number.isFinite(knownScore)
        ? knownScore
        : evaluateGridForAi(currentGrid, currentSpecial, neutralSpecials, null, aiWeights, baseGrid);
      if (depth === 0 || (!wLeft && !sLeft && (usedSpecial || currentSpecial?.placed))) {
        if (!best || score > best.score) {
          best = { score, candidate: firstMoveUsed };
        }
        return;
      }
      if (wLeft > 0) {
        pools.walls.forEach((wall) => {
          const nextGrid = cloneGrid(currentGrid);
          placeBlock(nextGrid, wall.x, wall.y, CELL_PLAYER);
          ensureOpenings(nextGrid);
          if (!hasPath(nextGrid)) return;
          const nextSpecial = currentSpecial ? cloneSpecial(currentSpecial) : null;
          const move = firstMoveUsed || wall;
          dfs(nextGrid, nextSpecial, wLeft - 1, sLeft, depth - 1, move, usedSpecial);
        });
      }
      if (sLeft > 0) {
        pools.singles.forEach((single) => {
          const nextGrid = cloneGrid(currentGrid);
          if (!canPlaceSingle(nextGrid, single.x, single.y)) return;
          const prev = nextGrid[single.y][single.x];
          nextGrid[single.y][single.x] = CELL_SINGLE;
          ensureOpenings(nextGrid);
          if (!hasPath(nextGrid)) {
            nextGrid[single.y][single.x] = prev;
            return;
          }
          const nextSpecial = currentSpecial ? cloneSpecial(currentSpecial) : null;
          const move = firstMoveUsed || single;
          dfs(nextGrid, nextSpecial, wLeft, sLeft - 1, depth - 1, move, usedSpecial);
        });
      }
      if (!usedSpecial && pools.specials.length && currentSpecial && !currentSpecial.placed) {
        pools.specials.forEach((spot) => {
          const sx = spot.x;
          const sy = spot.y;
          if (!isCellAvailableForSpecial(currentGrid, sx, sy)) return;
          const nextGrid = cloneGrid(currentGrid);
          nextGrid[sy][sx] = CELL_SPECIAL;
          ensureOpenings(nextGrid);
          if (!hasPath(nextGrid)) return;
          const nextSpecial = currentSpecial ? cloneSpecial(currentSpecial) : null;
          nextSpecial.cell = { x: sx, y: sy };
          nextSpecial.placed = true;
          nextSpecial.effectTimer = 0;
          nextSpecial.cooldown = 0;
          nextSpecial.flashTimer = 0;
          const move = firstMoveUsed || { type: "special", x: sx, y: sy, score: spot.score || 0 };
          dfs(nextGrid, nextSpecial, wLeft, sLeft, depth - 1, move, true);
        });
      }
    }

    const startGrid = cloneGrid(grid);
    const startSpecial = special ? cloneSpecial(special) : { placed: false };
    const initialScore = Number.isFinite(currentScore)
      ? currentScore
      : pathInfoOverride
        ? evaluateGridForAi(startGrid, startSpecial, neutralSpecials, pathInfoOverride, aiWeights, baseGrid)
        : null;
    dfs(startGrid, startSpecial, wallsLeft, singlesLeft, maxDepth, null, !!special?.placed, initialScore);
    return best;
  }

  function findFallbackAiCandidates(
    grid,
    special,
    neutralSpecials,
    allowWalls,
    allowSingles,
    rng = mulberry32(1),
    aiWeights = AI_WEIGHT_DEFAULTS,
    baseGrid = null
  ) {
    const pool = [];
    const tries = 140;
    if (allowWalls) {
      for (let i = 0; i < tries; i++) {
        const x = Math.floor(rng() * (GRID_SIZE - 2));
        const y = 1 + Math.floor(rng() * (GRID_SIZE - 3));
        if (!canPlaceBlock(grid, x, y)) continue;
        placeBlock(grid, x, y, CELL_PLAYER);
        ensureOpenings(grid);
        const score = evaluateGridForAi(grid, special, neutralSpecials, null, aiWeights, baseGrid);
        clearBlock(grid, x, y);
        ensureOpenings(grid);
        if (!Number.isFinite(score)) continue;
        insertCandidate(pool, { type: "wall", x, y, score }, 3);
      }
    }
    if (allowSingles) {
      for (let i = 0; i < tries; i++) {
        const x = Math.floor(rng() * (GRID_SIZE - 1));
        const y = 1 + Math.floor(rng() * (GRID_SIZE - 2));
        if (!canPlaceSingle(grid, x, y)) continue;
        const prev = grid[y][x];
        grid[y][x] = CELL_SINGLE;
        ensureOpenings(grid);
        const score = evaluateGridForAi(grid, special, neutralSpecials, null, aiWeights, baseGrid);
        grid[y][x] = prev;
        ensureOpenings(grid);
        if (!Number.isFinite(score)) continue;
        insertCandidate(pool, { type: "single", x, y, score }, 3);
      }
    }
    return pool;
  }

  function findBestAiPlacement(
    grid,
    currentScore,
    special,
    neutralSpecials,
    pathInfoOverride = null,
    budgetInfo = null,
    allowWalls = true,
    allowSingles = true,
    forcedSingleCells = null,
    aiWeights = AI_WEIGHT_DEFAULTS,
    baseGrid = null,
    fallbackRng = null
  ) {
    const candidateLimit = COMBO_POOL_LIMIT;
    const wallPool = allowWalls
      ? findTopAiWallCandidates(
          grid,
          special,
          neutralSpecials,
          candidateLimit,
          aiWeights,
          baseGrid,
          fallbackRng,
          pathInfoOverride
        )
      : [];
    const steerCells = collectSpeedPadSteerCells(grid, pathInfoOverride?.path);
    const forced = forcedSingleCells && forcedSingleCells.length ? forcedSingleCells.concat(steerCells) : steerCells;
    const singlePool = allowSingles
      ? findTopAiSingleCandidates(
          grid,
          special,
          neutralSpecials,
          forced,
          candidateLimit,
          aiWeights,
          baseGrid,
          pathInfoOverride
        )
      : [];
    let candidates = wallPool.concat(singlePool);
    if (!candidates.length) {
      const fallbackRandom = fallbackRng || mulberry32(hashSeed("fallback"));
      candidates = findFallbackAiCandidates(
        grid,
        special,
        neutralSpecials,
        allowWalls,
        allowSingles,
        fallbackRandom,
        aiWeights,
        baseGrid
      );
      if (!candidates.length) return null;
    }
    candidates.sort((a, b) => b.score - a.score);
    const effectiveBudget = budgetInfo || {
      wallsLeft: allowWalls ? 1 : 0,
      singlesLeft: allowSingles ? 1 : 0,
      specialHotspots: []
    };
    const seq = evaluatePlacementSequences(
      grid,
      special,
      neutralSpecials,
      wallPool,
      singlePool,
      effectiveBudget,
      aiWeights,
      baseGrid,
      pathInfoOverride,
      currentScore
    );
    if (seq?.candidate) return seq.candidate;
    return candidates[0] || null;
  }

  // Special handling
  function computeSpecialHotspots(grid, special, neutralSpecials, limit = SPECIAL_HOTSPOT_LIMIT, rng = Math.random) {
    const basePath = computePath(grid);
    if (!basePath.length) return [];
    const baselineInfo = analyzePath(grid);
    const baselineMandatory = countMandatorySpeedPads(grid, baselineInfo?.path);
    const candidates = new Set();
    basePath.forEach((node) => {
      if (isInsideGrid(node.x, node.y)) {
        candidates.add(key(node.x, node.y));
      }
      MOVES.forEach((move) => {
        const nx = node.x + move.dx;
        const ny = node.y + move.dy;
        if (isInsideGrid(nx, ny)) {
          candidates.add(key(nx, ny));
        }
      });
    });
    for (let i = 0; i < 120; i++) {
      const gx = randomInt(rng, 0, GRID_SIZE - 1);
      const gy = randomInt(rng, 1, GRID_SIZE - 2);
      candidates.add(key(gx, gy));
    }
    const hotspots = [];
    for (const entry of candidates) {
      const [x, y] = entry.split(",").map(Number);
      const placement = evaluateSpecialCandidate(
        grid,
        special,
        neutralSpecials,
        x,
        y,
        baselineInfo,
        baselineMandatory
      );
      if (!placement) continue;
      hotspots.push({ x: placement.x, y: placement.y, score: placement.score });
    }
    hotspots.sort((a, b) => b.score - a.score);
    return hotspots.slice(0, limit);
  }

  function evaluateSpecialCandidate(
    grid,
    special,
    neutralSpecials,
    x,
    y,
    baselineInfo,
    baselineMandatorySpeedCount
  ) {
    if (!isCellAvailableForSpecial(grid, x, y)) return null;
    const original = grid[y][x];
    grid[y][x] = CELL_SPECIAL;
    ensureOpenings(grid);
    const candidateSpecial = { ...special, cell: { x, y }, placed: true };
    const pathInfo = analyzePath(grid);
    if (!pathInfo) {
      grid[y][x] = original;
      ensureOpenings(grid);
      return null;
    }
    const score = evaluateGridForAi(grid, candidateSpecial, neutralSpecials, pathInfo);
    const mandatorySpeedCount = countMandatorySpeedPads(grid, pathInfo.path);
    const baseDistance = baselineInfo?.totalDistance ?? 0;
    const pathGain = pathInfo.totalDistance - baseDistance;
    const avoidsSpeedPad =
      typeof baselineMandatorySpeedCount === "number" && mandatorySpeedCount < baselineMandatorySpeedCount;
    grid[y][x] = original;
    ensureOpenings(grid);
    if (!Number.isFinite(score)) return null;
    return { x, y, score, pathGain, avoidsSpeedPad };
  }

  function placeAiSpecial(grid, special, neutralSpecials, preferredCells = [], rng = Math.random) {
    if (special.placed) return;
    const basePath = computePath(grid);
    if (!basePath.length) return;
    const baselineInfo = analyzePath(grid);
    if (!baselineInfo) return;
    const baselineMandatory = countMandatorySpeedPads(grid, baselineInfo.path);
    const candidates = new Set();
    basePath.forEach((node) => {
      if (isInsideGrid(node.x, node.y)) candidates.add(key(node.x, node.y));
      MOVES.forEach((move) => {
        const nx = node.x + move.dx;
        const ny = node.y + move.dy;
        if (isInsideGrid(nx, ny)) {
          candidates.add(key(nx, ny));
        }
      });
    });
    for (let i = 0; i < 120; i++) {
      const gx = randomInt(rng, 0, GRID_SIZE - 1);
      const gy = randomInt(rng, 1, GRID_SIZE - 2);
      candidates.add(key(gx, gy));
    }
    const preferredList = (preferredCells || [])
      .map((cell) => (cell ? { x: cell.x, y: cell.y } : null))
      .filter(Boolean);
    const preferredSet = new Set(preferredList.map((cell) => key(cell.x, cell.y)));
    let bestPreferred = null;
    preferredList.forEach((cell) => {
      const placement = evaluateSpecialCandidate(
        grid,
        special,
        neutralSpecials,
        cell.x,
        cell.y,
        baselineInfo,
        baselineMandatory
      );
      if (placement && (!bestPreferred || placement.score > bestPreferred.score)) {
        bestPreferred = placement;
      }
    });
    let bestGeneral = null;
    for (const entry of candidates) {
      if (preferredSet.has(entry)) continue;
      const [x, y] = entry.split(",").map(Number);
      const placement = evaluateSpecialCandidate(
        grid,
        special,
        neutralSpecials,
        x,
        y,
        baselineInfo,
        baselineMandatory
      );
      if (!placement) continue;
      if (!bestGeneral || placement.score > bestGeneral.score) {
        bestGeneral = placement;
      }
    }
    let best = null;
    if (bestPreferred) {
      const generalException =
        bestGeneral && (bestGeneral.pathGain >= SPECIAL_PATH_GAIN_THRESHOLD || bestGeneral.avoidsSpeedPad);
      best = generalException ? bestGeneral : bestPreferred;
    } else {
      best = bestGeneral;
    }
    if (!best) return;
    grid[best.y][best.x] = CELL_SPECIAL;
    special.cell = { x: best.x, y: best.y };
    special.placed = true;
    special.effectTimer = 0;
    special.cooldown = 0;
    special.flashTimer = 0;
  }

  // Deterministic round generation
  function createNeutralSpecial(type, cell) {
    return {
      type,
      placed: true,
      cell: { ...cell },
      effectTimer: 0,
      cooldown: 0,
      flashTimer: 0,
      neutral: true
    };
  }

  function pickSpecialType(rng, excludedTypes = []) {
    const excluded = new Set(excludedTypes);
    const weighted = [
      ["radius", 0.25],
      ["lightning", 0.25],
      ["gravity", 0.25],
      ["row", 0.125],
      ["column", 0.125]
    ].filter(([type]) => !excluded.has(type));
    const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = rng() * total;
    for (const [type, weight] of weighted) {
      roll -= weight;
      if (roll <= 0) return type;
    }
    return weighted[weighted.length - 1]?.[0] || "radius";
  }

  function shuffleWithRng(items, rng) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  function countBlocks(grid, type) {
    let total = 0;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (grid[y][x] === type) total++;
      }
    }
    return Math.floor(total / 4);
  }

  function countCells(grid, type) {
    if (!grid) return 0;
    let total = 0;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (grid[y][x] === type) total++;
      }
    }
    return total;
  }

  function placeStaticBlocks(grid, rng) {
    const blockCount = randomInt(rng, 8, 18);
    let attempts = 0;
    while (attempts < blockCount * 6 && countBlocks(grid, CELL_STATIC) < blockCount) {
      const x = randomInt(rng, 0, GRID_SIZE - 2);
      const y = randomInt(rng, 2, GRID_SIZE - 4);
      if (Math.abs(x - ENTRANCE_X) <= 2) {
        attempts++;
        continue;
      }
      if (canPlaceBlock(grid, x, y)) placeBlock(grid, x, y, CELL_STATIC);
      attempts++;
    }
  }

  function maybeUpgradePad(grid, cell, rng, baseType) {
    const chance = baseType === "slow" ? 0.15 : 0.01;
    if (rng() > chance) return;
    const options = [CELL_DETOUR, CELL_STONE, CELL_REWIND];
    grid[cell.y][cell.x] = options[Math.floor(rng() * options.length)];
  }

  function placePowerPanels(grid, rng) {
    const candidates = [];
    for (let y = 1; y < GRID_SIZE - 1; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (grid[y][x] === CELL_EMPTY && Math.abs(x - ENTRANCE_X) > 1) candidates.push({ x, y });
      }
    }
    shuffleWithRng(candidates, rng);
    for (let i = 0; i < 4 && candidates.length; i++) {
      const cell = candidates.shift();
      grid[cell.y][cell.x] = CELL_SPEED;
      maybeUpgradePad(grid, cell, rng, "speed");
    }
    for (let i = 0; i < 2 && candidates.length; i++) {
      const cell = candidates.shift();
      grid[cell.y][cell.x] = CELL_SLOW;
      maybeUpgradePad(grid, cell, rng, "slow");
    }
  }

  function placeNeutralSpecial(grid, rng) {
    const roll = rng();
    if (roll < 0.25) return null;
    const type = roll < 0.5 ? "lightning" : roll < 0.75 ? "row" : "column";
    const cells = [];
    for (let y = 1; y < GRID_SIZE - 1; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (grid[y][x] === CELL_EMPTY && Math.abs(x - ENTRANCE_X) > 1) cells.push({ x, y });
      }
    }
    shuffleWithRng(cells, rng);
    for (const cell of cells) {
      grid[cell.y][cell.x] = CELL_STATIC_SPECIAL;
      ensureOpenings(grid);
      if (hasPath(grid)) return createNeutralSpecial(type, cell);
      grid[cell.y][cell.x] = CELL_EMPTY;
    }
    return null;
  }

  function generateBaseGrid(rng) {
    let attempts = 0;
    while (attempts < 200) {
      const grid = createEmptyGrid();
      placeStaticBlocks(grid, rng);
      placePowerPanels(grid, rng);
      ensureOpenings(grid);
      const neutralSpecial = placeNeutralSpecial(grid, rng);
      if (hasPath(grid)) return { grid, neutralSpecial };
      attempts++;
    }
    const grid = createEmptyGrid();
    ensureOpenings(grid);
    return { grid, neutralSpecial: null };
  }

  function createRound(seed) {
    const startedAt = nowMs();
    const safeSeed = `${seed ?? ""}`.trim() || "0";
    const rng = mulberry32(hashSeed(safeSeed));
    const base = generateBaseGrid(rng);
    const coinBudget = randomInt(rng, 10, 21);
    const singleBudget = rng() < 0.1 ? 2 : 1;
    const hasNeutralLightning = base.neutralSpecial?.type === "lightning";
    const specialType = pickSpecialType(rng, hasNeutralLightning ? ["lightning"] : []);
    return {
      seed: safeSeed,
      rng,
      baseGrid: base.grid,
      neutralSpecial: base.neutralSpecial,
      coinBudget,
      singleBudget,
      specialTemplate: createSpecialTemplate(specialType),
      metrics: { generationMs: nowMs() - startedAt }
    };
  }

  function resetPadStates(grid) {
    if (!grid) return grid;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const value = grid[y][x];
        if (value === CELL_SPEED_USED) grid[y][x] = CELL_SPEED;
        else if (value === CELL_SLOW_USED) grid[y][x] = CELL_SLOW;
        else if (value === CELL_DETOUR_USED) grid[y][x] = CELL_DETOUR;
        else if (value === CELL_STONE_USED) grid[y][x] = CELL_STONE;
        else if (value === CELL_REWIND_USED) grid[y][x] = CELL_REWIND;
      }
    }
    return grid;
  }

  function advanceBuildClock(timeLeft, delta) {
    const remaining = Math.max(0, Number(timeLeft || 0) - Math.max(0, Number(delta || 0)));
    return { timeLeft: remaining, expired: remaining <= 0 };
  }

  // AI build
  function createSpecialTemplate(type) {
    return {
      type,
      placed: false,
      cell: null,
      effectTimer: 0,
      cooldown: 0,
      flashTimer: 0
    };
  }

  const AI_VERSION = "3.4.0";
  const AI_SEARCH_PROFILE = Object.freeze({
    name: "hard",
    beamWidth: 4,
    candidatesPerState: 12,
    hazardCandidates: 12,
    candidateBudget: 1300,
    finalistLimit: 12,
    maxBuildMs: 2200,
    finalistRank: 0
  });

  function resolveAiSearchProfile(snapshot = {}) {
    const base = AI_SEARCH_PROFILE;
    const overrides = snapshot.aiSearchLimits || {};
    return {
      ...base,
      beamWidth: Math.max(1, Math.min(10, overrides.beamWidth ?? base.beamWidth)),
      candidatesPerState: Math.max(4, Math.min(32, overrides.candidatesPerState ?? base.candidatesPerState)),
      hazardCandidates: Math.max(4, Math.min(30, overrides.hazardCandidates ?? base.hazardCandidates)),
      candidateBudget: Math.max(40, Math.min(4000, overrides.candidateBudget ?? base.candidateBudget)),
      finalistLimit: Math.max(1, Math.min(16, overrides.finalistLimit ?? base.finalistLimit)),
      maxBuildMs: Math.max(100, Math.min(5000, overrides.maxBuildMs ?? base.maxBuildMs))
    };
  }

  function gridSearchSignature(grid) {
    return grid.map((row) => row.map((value) => value.toString(16)).join("")).join("");
  }

  function compareSearchEntries(a, b) {
    const scoreDelta = (b?.score ?? -Infinity) - (a?.score ?? -Infinity);
    if (Math.abs(scoreDelta) > 1e-9) return scoreDelta;
    return String(a?.signature || "").localeCompare(String(b?.signature || ""));
  }

  function addHazardCandidate(candidates, grid, x, y) {
    if (!isInsideGrid(x, y) || !isCellAvailableForSpecial(grid, x, y)) return;
    candidates.set(keyFor(x, y), { x, y });
  }

  function hazardCoverageScore(type, cell, path, grid, neutralSpecials) {
    let coverage = 0;
    let blocksRoute = 0;
    for (const node of path || []) {
      if (!isInsideGrid(node.x, node.y)) continue;
      const dx = Math.abs(node.x - cell.x);
      const dy = Math.abs(node.y - cell.y);
      const distance = Math.hypot(dx, dy);
      if (dx === 0 && dy === 0) blocksRoute = 1;
      if (type === "row" && node.y === cell.y) coverage += 1;
      else if (type === "column" && node.x === cell.x) coverage += 1;
      else if (type === "gravity" && distance <= GRAVITY_RADIUS + 1) {
        coverage += Math.pow(1 - Math.min(1, distance / (GRAVITY_RADIUS + 1)), 1.35);
      } else if ((type === "radius" || type === "lightning") && distance <= SPECIAL_RADIUS + 1) {
        coverage += 1 - Math.min(1, distance / (SPECIAL_RADIUS + 1));
      }
    }
    let padSynergy = 0;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const padType = padTypeFromCell(grid[y][x]);
        if (padType !== "slow" && padType !== "stone" && padType !== "rewind") continue;
        const distance = Math.hypot(x - cell.x, y - cell.y);
        if (distance <= (type === "gravity" ? GRAVITY_RADIUS : SPECIAL_RADIUS) + 1) {
          padSynergy += 1 / (1 + distance);
        }
      }
    }
    let overlap = 0;
    for (const neutral of neutralSpecials || []) {
      if (!neutral?.cell) continue;
      const distance = Math.hypot(neutral.cell.x - cell.x, neutral.cell.y - cell.y);
      if (distance <= SPECIAL_RADIUS * 1.5) overlap += 1 / (1 + distance);
    }
    return coverage * 10 + padSynergy * 6 + overlap * 5 + blocksRoute * 3;
  }

  function collectHazardCandidateCells(grid, pathInfo, specialType, neutralSpecials, limit) {
    const candidates = new Map();
    const path = pathInfo?.path || [];
    for (const node of path) {
      if (!isInsideGrid(node.x, node.y)) continue;
      addHazardCandidate(candidates, grid, node.x, node.y);
      for (const move of MOVES) {
        addHazardCandidate(candidates, grid, node.x + move.dx, node.y + move.dy);
      }
    }
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const padType = padTypeFromCell(grid[y][x]);
        if (padType !== "slow" && padType !== "stone" && padType !== "rewind") continue;
        for (const [dx, dy] of CARDINAL_NEIGHBORS) {
          addHazardCandidate(candidates, grid, x + dx, y + dy);
        }
      }
    }
    for (const neutral of neutralSpecials || []) {
      if (!neutral?.cell) continue;
      for (const move of MOVES) {
        addHazardCandidate(candidates, grid, neutral.cell.x + move.dx, neutral.cell.y + move.dy);
      }
    }
    if (!candidates.size) {
      for (let y = 1; y < GRID_SIZE - 1; y++) {
        for (let x = 0; x < GRID_SIZE; x++) addHazardCandidate(candidates, grid, x, y);
      }
    }
    return Array.from(candidates.values())
      .map((cell) => ({
        ...cell,
        preliminary: hazardCoverageScore(specialType, cell, path, grid, neutralSpecials),
        key: keyFor(cell.x, cell.y)
      }))
      .sort((a, b) => b.preliminary - a.preliminary || a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  function routeBarrierContact(grid, path) {
    if (!path?.length) return 0;
    let contact = 0;
    const seen = new Set();
    for (const node of path) {
      if (!isInsideGrid(node.x, node.y)) continue;
      for (const [dx, dy] of CARDINAL_NEIGHBORS) {
        const x = node.x + dx;
        const y = node.y + dy;
        if (!isInsideGrid(x, y)) continue;
        const value = grid[y][x];
        if (value !== CELL_STATIC && value !== CELL_PLAYER && value !== CELL_SINGLE) continue;
        const entry = keyFor(x, y);
        if (seen.has(entry)) continue;
        seen.add(entry);
        contact++;
      }
    }
    return contact;
  }

  function existingStructureContact(baseGrid, path) {
    if (!baseGrid || !path?.length) return 0;
    let contact = 0;
    const seen = new Set();
    for (const node of path) {
      if (!isInsideGrid(node.x, node.y)) continue;
      for (const [dx, dy] of CARDINAL_NEIGHBORS) {
        const x = node.x + dx;
        const y = node.y + dy;
        if (!isInsideGrid(x, y) || baseGrid[y][x] !== CELL_STATIC) continue;
        const entry = keyFor(x, y);
        if (seen.has(entry)) continue;
        seen.add(entry);
        contact++;
      }
    }
    return contact;
  }

  function evaluateHazardPlan(grid, specialType, neutralSpecials, cell, baseGrid, aiWeights) {
    if (!cell || !isCellAvailableForSpecial(grid, cell.x, cell.y)) return null;
    const plannedGrid = cloneGrid(grid);
    plannedGrid[cell.y][cell.x] = CELL_SPECIAL;
    ensureOpenings(plannedGrid);
    const pathInfo = analyzePath(plannedGrid);
    if (!pathInfo) return null;
    const special = createSpecialTemplate(specialType);
    special.placed = true;
    special.cell = { x: cell.x, y: cell.y };
    const predicted = estimatePredictedRunTime(plannedGrid, pathInfo, special, neutralSpecials);
    const contact = routeBarrierContact(plannedGrid, pathInfo.path);
    const weightedScore = evaluateGridForAi(plannedGrid, special, neutralSpecials, pathInfo, aiWeights, baseGrid);
    const score = predicted.time * 100 + contact * 0.45 + weightedScore * 0.002;
    return { grid: plannedGrid, special, pathInfo, predicted, contact, score };
  }

  function findBestHazardPlan(grid, specialType, neutralSpecials, baseGrid, aiWeights, limit, profile) {
    const openPath = analyzePath(grid);
    if (!openPath) return null;
    const candidates = collectHazardCandidateCells(grid, openPath, specialType, neutralSpecials, limit);
    let best = null;
    for (const cell of candidates) {
      const evaluated = evaluateHazardPlan(grid, specialType, neutralSpecials, cell, baseGrid, aiWeights);
      profile.hazardEvaluations++;
      if (!evaluated) continue;
      evaluated.signature = keyFor(cell.x, cell.y);
      if (!best || compareSearchEntries(evaluated, best) < 0) best = evaluated;
    }
    return best;
  }

  function candidateTouchesCell(candidate, cell) {
    if (!cell) return false;
    if (candidate.type === "single") return candidate.x === cell.x && candidate.y === cell.y;
    return cell.x >= candidate.x && cell.x <= candidate.x + 1 && cell.y >= candidate.y && cell.y <= candidate.y + 1;
  }

  function candidateBarrierAdjacency(grid, candidate) {
    const cells = candidate.type === "wall"
      ? [
          [candidate.x, candidate.y],
          [candidate.x + 1, candidate.y],
          [candidate.x, candidate.y + 1],
          [candidate.x + 1, candidate.y + 1]
        ]
      : [[candidate.x, candidate.y]];
    const own = new Set(cells.map(([x, y]) => keyFor(x, y)));
    const seen = new Set();
    for (const [cx, cy] of cells) {
      for (const [dx, dy] of CARDINAL_NEIGHBORS) {
        const x = cx + dx;
        const y = cy + dy;
        if (!isInsideGrid(x, y) || own.has(keyFor(x, y))) continue;
        const value = grid[y][x];
        if (value !== CELL_STATIC && value !== CELL_PLAYER && value !== CELL_SINGLE) continue;
        seen.add(keyFor(x, y));
      }
    }
    return seen.size;
  }

  function minimumCandidatePathDistance(candidate, path) {
    let best = Infinity;
    const cx = candidate.type === "wall" ? candidate.x + 0.5 : candidate.x;
    const cy = candidate.type === "wall" ? candidate.y + 0.5 : candidate.y;
    for (const node of path || []) {
      if (!isInsideGrid(node.x, node.y)) continue;
      best = Math.min(best, Math.hypot(node.x - cx, node.y - cy));
    }
    return best;
  }

  function placementPreliminaryScore(grid, candidate, path, reservedSpecial) {
    if (candidateTouchesCell(candidate, reservedSpecial?.cell)) return -Infinity;
    let blocksPath = 0;
    for (const node of path || []) {
      if (!isInsideGrid(node.x, node.y)) continue;
      if (candidate.type === "single") {
        if (node.x === candidate.x && node.y === candidate.y) blocksPath++;
      } else if (
        node.x >= candidate.x &&
        node.x <= candidate.x + 1 &&
        node.y >= candidate.y &&
        node.y <= candidate.y + 1
      ) {
        blocksPath++;
      }
    }
    const pathDistance = minimumCandidatePathDistance(candidate, path);
    const adjacency = candidateBarrierAdjacency(grid, candidate);
    const centreBias = 1 - Math.abs(candidate.y - (GRID_SIZE - 1) / 2) / GRID_SIZE;
    return blocksPath * 80 + adjacency * 8 + 12 / (1 + pathDistance) + centreBias;
  }

  function candidateFocusBonus(candidate, focusCells) {
    if (!focusCells?.length) return 0;
    const cx = candidate.type === "wall" ? candidate.x + 0.5 : candidate.x;
    const cy = candidate.type === "wall" ? candidate.y + 0.5 : candidate.y;
    let distance = Infinity;
    for (const cell of focusCells) distance = Math.min(distance, Math.hypot(cell.x - cx, cell.y - cy));
    return 40 / (1 + distance);
  }

  function collectPlacementCandidates(grid, pathInfo, reservedSpecial, wallsLeft, singlesLeft, limit, focusCells = []) {
    const path = pathInfo?.path || [];
    const wallKeys = new Set();
    const singleKeys = new Set();
    for (const node of path) {
      if (!isInsideGrid(node.x, node.y)) continue;
      for (let dy = -2; dy <= 1; dy++) {
        for (let dx = -2; dx <= 1; dx++) wallKeys.add(keyFor(node.x + dx, node.y + dy));
      }
      singleKeys.add(keyFor(node.x, node.y));
      for (const [dx, dy] of CARDINAL_NEIGHBORS) singleKeys.add(keyFor(node.x + dx, node.y + dy));
    }
    for (const focus of focusCells) {
      for (let dy = -3; dy <= 2; dy++) {
        for (let dx = -3; dx <= 2; dx++) wallKeys.add(keyFor(focus.x + dx, focus.y + dy));
      }
      singleKeys.add(keyFor(focus.x, focus.y));
      for (const move of MOVES) singleKeys.add(keyFor(focus.x + move.dx, focus.y + move.dy));
    }
    const walls = [];
    if (wallsLeft > 0) {
      for (const entry of wallKeys) {
        const [x, y] = entry.split(",").map(Number);
        if (!canPlaceBlock(grid, x, y)) continue;
        const candidate = { type: "wall", x, y, key: `w:${entry}` };
        candidate.preliminary =
          placementPreliminaryScore(grid, candidate, path, reservedSpecial) + candidateFocusBonus(candidate, focusCells);
        if (Number.isFinite(candidate.preliminary)) walls.push(candidate);
      }
      walls.sort((a, b) => b.preliminary - a.preliminary || a.key.localeCompare(b.key));
    }
    const singles = [];
    if (singlesLeft > 0) {
      for (const entry of singleKeys) {
        const [x, y] = entry.split(",").map(Number);
        if (!canPlaceSingle(grid, x, y)) continue;
        const candidate = { type: "single", x, y, key: `s:${entry}` };
        candidate.preliminary =
          placementPreliminaryScore(grid, candidate, path, reservedSpecial) + candidateFocusBonus(candidate, focusCells);
        if (Number.isFinite(candidate.preliminary)) singles.push(candidate);
      }
      singles.sort((a, b) => b.preliminary - a.preliminary || a.key.localeCompare(b.key));
    }
    const singleSlots = singlesLeft > 0 ? Math.max(2, Math.floor(limit * 0.28)) : 0;
    const wallSlots = wallsLeft > 0 ? Math.max(0, limit - Math.min(singleSlots, singles.length)) : 0;
    return walls.slice(0, wallSlots).concat(singles.slice(0, singleSlots));
  }

  function applySearchPlacement(grid, candidate) {
    if (candidate.type === "wall") placeBlock(grid, candidate.x, candidate.y, CELL_PLAYER);
    else grid[candidate.y][candidate.x] = CELL_SINGLE;
    ensureOpenings(grid);
  }

  function makePlacementOrderEntry(candidate) {
    return { type: candidate.type, row: candidate.y + 1, column: candidate.x + 1, specialHotspots: [] };
  }

  function evaluateSearchGrid(grid, context, preferredSpecial, replan) {
    const signature = gridSearchSignature(grid);
    const preferredKey = preferredSpecial?.cell ? keyFor(preferredSpecial.cell.x, preferredSpecial.cell.y) : "none";
    const cacheKey = `${signature}|${replan ? "plan" : preferredKey}`;
    if (context.cache.has(cacheKey)) {
      context.profile.cacheHits++;
      return context.cache.get(cacheKey);
    }
    let evaluation = null;
    if (!replan && preferredSpecial?.cell) {
      evaluation = evaluateHazardPlan(
        grid,
        context.specialType,
        context.neutralSpecials,
        preferredSpecial.cell,
        context.baseGrid,
        context.aiWeights
      );
      context.profile.hazardEvaluations++;
    }
    if (!evaluation) {
      evaluation = findBestHazardPlan(
        grid,
        context.specialType,
        context.neutralSpecials,
        context.baseGrid,
        context.aiWeights,
        context.limits.hazardCandidates,
        context.profile
      );
    }
    if (evaluation) {
      evaluation.signature = signature;
      context.cache.set(cacheKey, evaluation);
    }
    return evaluation;
  }

  function addSearchArchive(archive, state) {
    if (!state?.evaluation) return;
    const keyValue = state.signature;
    const existing = archive.get(keyValue);
    if (!existing || state.score > existing.score) archive.set(keyValue, state);
  }

  function materializeSearchFinalist(state, context) {
    const planned = findBestHazardPlan(
      state.grid,
      context.specialType,
      context.neutralSpecials,
      context.baseGrid,
      context.aiWeights,
      Math.min(30, context.limits.hazardCandidates + 6),
      context.profile
    );
    if (!planned) return null;
    const simulationStarted = nowMs();
    const simulatedTime = simulateRunnerTime(planned.grid, planned.special, context.neutralSpecials, {
      pathInfo: planned.pathInfo
    });
    context.profile.simulationMs += nowMs() - simulationStarted;
    context.profile.exactSimulations++;
    if (!Number.isFinite(simulatedTime)) return null;
    const placementOrder = state.placementOrder.map((entry) => ({ ...entry }));
    placementOrder.push({
      type: "special",
      row: planned.special.cell.y + 1,
      column: planned.special.cell.x + 1,
      specialCell: { ...planned.special.cell },
      specialHotspots: []
    });
    return {
      grid: planned.grid,
      special: planned.special,
      placementOrder,
      simulatedTime,
      heuristicScore: state.score,
      structureContacts: planned.contact,
      existingStructureContacts: existingStructureContact(context.baseGrid, planned.pathInfo.path),
      wallsUsed: state.wallsUsed,
      singlesUsed: state.singlesUsed
    };
  }

  function removeSearchPlacement(grid, entry) {
    const x = entry.column - 1;
    const y = entry.row - 1;
    if (entry.type === "wall") clearBlock(grid, x, y);
    else if (entry.type === "single") grid[y][x] = CELL_EMPTY;
    ensureOpenings(grid);
  }

  function refineFinalLayout(best, context) {
    const maxPasses = context.limits.name === "hard" ? 4 : 2;
    let changed = 0;
    let evaluations = 0;
    annotatePlacementImpacts(best.grid, best.special, context.neutralSpecials, best.placementOrder);
    for (let pass = 0; pass < maxPasses; pass++) {
      const weakestPlacements = best.placementOrder
        .filter((entry) => entry.type === "wall" || entry.type === "single")
        .sort((a, b) => (a.impactDelta ?? 0) - (b.impactDelta ?? 0))
        .slice(0, 3);
      if (!weakestPlacements.length) break;
      let replacement = null;
      for (const weakest of weakestPlacements) {
        const withoutWeakest = cloneGrid(best.grid);
        removeSearchPlacement(withoutWeakest, weakest);
        const pathInfo = analyzePath(withoutWeakest);
        if (!pathInfo) continue;
        const candidates = collectPlacementCandidates(
          withoutWeakest,
          pathInfo,
          best.special,
          Number(weakest.type === "wall"),
          Number(weakest.type === "single"),
          context.limits.name === "hard" ? 18 : 12
        ).filter((candidate) => candidate.type === weakest.type);
        for (const candidate of candidates) {
          const nextGrid = cloneGrid(withoutWeakest);
          applySearchPlacement(nextGrid, candidate);
          const simulatedTime = simulateRunnerTime(nextGrid, best.special, context.neutralSpecials);
          evaluations++;
          if (!Number.isFinite(simulatedTime) || simulatedTime <= best.simulatedTime + 0.025) continue;
          if (!replacement || simulatedTime > replacement.simulatedTime) {
            replacement = { candidate, grid: nextGrid, simulatedTime, entry: weakest };
          }
        }
      }
      if (!replacement) break;
      best.grid = replacement.grid;
      best.simulatedTime = replacement.simulatedTime;
      replacement.entry.row = replacement.candidate.y + 1;
      replacement.entry.column = replacement.candidate.x + 1;
      replacement.entry.impactDelta = null;
      changed++;
      annotatePlacementImpacts(best.grid, best.special, context.neutralSpecials, best.placementOrder);
    }
    const pathInfo = analyzePath(best.grid);
    if (pathInfo) {
      best.structureContacts = routeBarrierContact(best.grid, pathInfo.path);
      best.existingStructureContacts = existingStructureContact(context.baseGrid, pathInfo.path);
    }
    return { changed, evaluations };
  }

  function padRefinementFocusCells(analysis) {
    const cells = [];
    const seen = new Set();
    function add(x, y) {
      if (!isInsideGrid(x, y)) return;
      const signature = keyFor(x, y);
      if (seen.has(signature)) return;
      seen.add(signature);
      cells.push({ x, y });
    }
    for (const opportunity of analysis.modes.slice(0, 3)) {
      for (const target of opportunity.targets) {
        add(target.x, target.y);
        if ((opportunity.mode === "stone" || opportunity.mode === "detour") && target.bestRay) {
          const direction = opportunity.mode === "stone"
            ? { dx: target.bestRay.dx, dy: target.bestRay.dy }
            : { dx: -target.bestRay.dx, dy: -target.bestRay.dy };
          for (let step = 1; step <= 5; step++) add(target.x + direction.dx * step, target.y + direction.dy * step);
        }
      }
    }
    return cells;
  }

  function refinePadAwareLayout(best, context, analysis) {
    const weakestWalls = best.placementOrder
      .filter((entry) => entry.type === "wall")
      .sort((a, b) => (a.impactDelta ?? 0) - (b.impactDelta ?? 0))
      .slice(0, 3);
    const focusCells = padRefinementFocusCells(analysis);
    let replacement = null;
    let evaluations = 0;
    for (let firstIndex = 0; firstIndex < weakestWalls.length; firstIndex++) {
      for (let secondIndex = firstIndex + 1; secondIndex < weakestWalls.length; secondIndex++) {
        const firstEntry = weakestWalls[firstIndex];
        const secondEntry = weakestWalls[secondIndex];
        const reducedGrid = cloneGrid(best.grid);
        removeSearchPlacement(reducedGrid, firstEntry);
        removeSearchPlacement(reducedGrid, secondEntry);
        const reducedPath = analyzePath(reducedGrid);
        if (!reducedPath) continue;
        const firstCandidates = collectPlacementCandidates(
          reducedGrid,
          reducedPath,
          best.special,
          2,
          0,
          10,
          focusCells
        )
          .filter((candidate) => candidate.type === "wall")
          .slice(0, 5);
        for (const firstCandidate of firstCandidates) {
          const firstGrid = cloneGrid(reducedGrid);
          applySearchPlacement(firstGrid, firstCandidate);
          const firstPath = analyzePath(firstGrid);
          if (!firstPath) continue;
          const secondCandidates = collectPlacementCandidates(
            firstGrid,
            firstPath,
            best.special,
            1,
            0,
            7,
            focusCells
          )
            .filter((candidate) => candidate.type === "wall")
            .slice(0, 3);
          for (const secondCandidate of secondCandidates) {
            const grid = cloneGrid(firstGrid);
            applySearchPlacement(grid, secondCandidate);
            const outcome = simulateRunnerOutcome(grid, best.special, context.neutralSpecials);
            evaluations++;
            if (!outcome || outcome.time <= best.simulatedTime + 0.025) continue;
            if (!replacement || outcome.time > replacement.simulatedTime + 1e-9) {
              replacement = {
                grid,
                simulatedTime: outcome.time,
                diagnostics: outcome.diagnostics,
                firstEntry,
                secondEntry,
                firstCandidate,
                secondCandidate
              };
            }
          }
        }
      }
    }
    let changed = 0;
    if (replacement) {
      best.grid = replacement.grid;
      best.simulatedTime = replacement.simulatedTime;
      replacement.firstEntry.row = replacement.firstCandidate.y + 1;
      replacement.firstEntry.column = replacement.firstCandidate.x + 1;
      replacement.firstEntry.impactDelta = null;
      replacement.secondEntry.row = replacement.secondCandidate.y + 1;
      replacement.secondEntry.column = replacement.secondCandidate.x + 1;
      replacement.secondEntry.impactDelta = null;
      changed++;
    }
    const rawGrid = cloneGrid(best.grid);
    if (best.special?.cell) rawGrid[best.special.cell.y][best.special.cell.x] = CELL_EMPTY;
    ensureOpenings(rawGrid);
    const hazardPlan = findBestExactHazardPlan(
      rawGrid,
      context.specialType,
      context.neutralSpecials,
      context.baseGrid,
      24,
      context.profile
    );
    if (hazardPlan) {
      evaluations += 24;
      if (hazardPlan.simulatedTime > best.simulatedTime + 0.025) {
        best.grid = hazardPlan.grid;
        best.special = hazardPlan.special;
        best.simulatedTime = hazardPlan.simulatedTime;
        const specialEntry = best.placementOrder.find((entry) => entry.type === "special");
        if (specialEntry) {
          specialEntry.row = hazardPlan.special.cell.y + 1;
          specialEntry.column = hazardPlan.special.cell.x + 1;
          specialEntry.specialCell = { ...hazardPlan.special.cell };
        }
        changed++;
      }
    }
    annotatePlacementImpacts(best.grid, best.special, context.neutralSpecials, best.placementOrder);
    const pathInfo = analyzePath(best.grid);
    if (pathInfo) {
      best.structureContacts = routeBarrierContact(best.grid, pathInfo.path);
      best.existingStructureContacts = existingStructureContact(context.baseGrid, pathInfo.path);
    }
    return { changed, evaluations };
  }

  function buildRouteRolloutFromSnapshot(snapshot, options = {}) {
    const startedAt = nowMs();
    const maxBuildMs = Math.max(100, options.maxBuildMs || 1800);
    const deterministicBudget = options.deterministicBudget === true;
    const specialPlacementDepth = Math.max(0, options.specialPlacementDepth ?? 0);
    const relocateAtEnd = options.relocateAtEnd !== false;
    const aiWeights = { ...AI_WEIGHT_DEFAULTS, ...(snapshot.aiWeights || {}) };
    const baseGrid = cloneGrid(snapshot.baseGrid);
    const neutralSpecials = cloneNeutralSpecials(snapshot.baseNeutralSpecials || []);
    const profile = { hazardEvaluations: 0 };
    let grid = baseGrid;
    let special = createSpecialTemplate(snapshot.specialTemplate?.type || "radius");
    let wallsLeft = Math.max(0, snapshot.coinBudget | 0);
    let singlesLeft = Math.max(0, snapshot.singleBudget | 0);
    const placementOrder = [];
    const rng = mulberry32(snapshot.rngSeed >>> 0);
    let placementsMade = 0;
    function placePlannedSpecial(candidateLimit = 12) {
      if (special.placed) return true;
      const plan = findBestHazardPlan(
        grid,
        special.type,
        neutralSpecials,
        snapshot.baseGrid,
        aiWeights,
        candidateLimit,
        profile
      );
      if (!plan) return false;
      grid = plan.grid;
      special = plan.special;
      return true;
    }
    if (specialPlacementDepth === 0 && !placePlannedSpecial()) return null;
    while (
      (wallsLeft > 0 || singlesLeft > 0) &&
      (deterministicBudget || nowMs() - startedAt < maxBuildMs)
    ) {
      if (!special.placed && placementsMade >= specialPlacementDepth && !placePlannedSpecial()) break;
      const pathInfo = analyzePath(grid);
      if (!pathInfo) break;
      const chosen = findBestAiPlacement(
        grid,
        evaluateGridForAi(grid, special, neutralSpecials, pathInfo, aiWeights, snapshot.baseGrid),
        special,
        neutralSpecials,
        pathInfo,
        { wallsLeft, singlesLeft, specialHotspots: [] },
        wallsLeft > 0,
        singlesLeft > 0,
        null,
        aiWeights,
        snapshot.baseGrid,
        rng
      );
      if (!chosen || chosen.type === "special") break;
      applySearchPlacement(grid, chosen);
      placementOrder.push(makePlacementOrderEntry(chosen));
      if (chosen.type === "wall") wallsLeft--;
      else singlesLeft--;
      placementsMade++;
    }
    if (!special.placed && !placePlannedSpecial(18)) return null;
    let finalPlan = { grid, special };
    if (relocateAtEnd) {
      const rawGrid = cloneGrid(grid);
      if (special.cell) rawGrid[special.cell.y][special.cell.x] = CELL_EMPTY;
      ensureOpenings(rawGrid);
      finalPlan = findBestHazardPlan(
        rawGrid,
        special.type,
        neutralSpecials,
        snapshot.baseGrid,
        aiWeights,
        18,
        profile
      );
      if (!finalPlan) return null;
    }
    const simulatedTime = simulateRunnerTime(finalPlan.grid, finalPlan.special, neutralSpecials, {
      pathInfo: finalPlan.pathInfo
    });
    placementOrder.push({
      type: "special",
      row: finalPlan.special.cell.y + 1,
      column: finalPlan.special.cell.x + 1,
      specialCell: { ...finalPlan.special.cell },
      specialHotspots: []
    });
    return {
      grid: finalPlan.grid,
      special: finalPlan.special,
      placementOrder,
      simulatedTime,
      totalMs: nowMs() - startedAt,
      wallsUsed: (snapshot.coinBudget | 0) - wallsLeft,
      singlesUsed: (snapshot.singleBudget | 0) - singlesLeft,
      deadlineHit: wallsLeft > 0 || singlesLeft > 0
    };
  }

  function collectTacticalPadTargets(grid, mode) {
    const targets = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const type = padTypeFromCell(grid[y][x]);
        if (mode === "reverse" && (type === "detour" || type === "rewind")) {
          const target = { x, y, type };
          if (type === "detour") {
            let bestCorridor = null;
            for (const move of MOVES) {
              let corridor = 0;
              let cx = x;
              let cy = y;
              while (true) {
                cx += move.dx;
                cy += move.dy;
                if (!isInsideGrid(cx, cy) || !isWalkableCell(grid, cx, cy)) break;
                corridor++;
              }
              if (!bestCorridor || corridor > bestCorridor.length) {
                bestCorridor = { dx: move.dx, dy: move.dy, length: corridor };
              }
            }
            if (bestCorridor?.length) {
              target.approach = { x: x + bestCorridor.dx, y: y + bestCorridor.dy };
              target.openCorridor = bestCorridor.length;
            }
          }
          targets.push(target);
        }
        if (mode === "slow" && (type === "slow" || type === "stone")) targets.push({ x, y, type });
      }
    }
    return targets;
  }

  function pathDistance(path) {
    return computeSegmentLengths(path || []).reduce((sum, value) => sum + value, 0);
  }

  function openRayLength(grid, x, y, dx, dy) {
    let length = 0;
    let cx = x;
    let cy = y;
    while (dx !== 0 || dy !== 0) {
      cx += dx;
      cy += dy;
      if (!isInsideGrid(cx, cy) || !isWalkableCell(grid, cx, cy)) break;
      length++;
    }
    return length;
  }

  function analyzePadOpportunities(grid) {
    const basePath = computePath(grid);
    const basePathDistance = pathDistance(basePath);
    const start = { x: ENTRANCE_X, y: GRID_SIZE - 1 };
    const pads = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const type = padTypeFromCell(grid[y][x]);
        if (!type) continue;
        const pathIndex = basePath.findIndex((node) => node.x === x && node.y === y);
        const prefixPath = findPath(grid, start, { x, y });
        const suffixPath = computePathFromCell(grid, { x, y });
        const prefixDistance = pathDistance(prefixPath);
        const viaDistance =
          prefixPath.length && suffixPath.length
            ? prefixDistance + pathDistance(suffixPath)
            : Infinity;
        const blocked = cloneGrid(grid);
        blocked[y][x] = CELL_PLAYER;
        ensureOpenings(blocked);
        const bypassPath = computePath(blocked);
        const bypassDistance = bypassPath.length ? pathDistance(bypassPath) : Infinity;
        let bestRay = null;
        for (const move of MOVES) {
          const approach = openRayLength(grid, x, y, -move.dx, -move.dy);
          const continuation = openRayLength(grid, x, y, move.dx, move.dy);
          const candidate = { dx: move.dx, dy: move.dy, approach, continuation };
          if (
            !bestRay ||
            candidate.continuation > bestRay.continuation ||
            (candidate.continuation === bestRay.continuation && candidate.approach > bestRay.approach)
          ) {
            bestRay = candidate;
          }
        }
        pads.push({
          x,
          y,
          type,
          onBasePath: pathIndex >= 0,
          pathIndex,
          prefixDistance,
          viaDistance,
          bypassDistance,
          mandatory: !Number.isFinite(bypassDistance),
          cleanRouteMargin: Number.isFinite(bypassDistance) ? bypassDistance - basePathDistance : Infinity,
          bestRay
        });
      }
    }
    const modeScores = new Map();
    const byType = (type) => pads.filter((pad) => pad.type === type);
    const rewindPads = byType("rewind");
    if (rewindPads.length) {
      modeScores.set(
        "rewind",
        18 + Math.max(...rewindPads.map((pad) => (Number.isFinite(pad.prefixDistance) ? pad.prefixDistance / NPC_SPEED : 0)))
      );
    }
    const stonePads = byType("stone");
    if (stonePads.length) {
      modeScores.set("stone", 12 + Math.max(...stonePads.map((pad) => pad.bestRay?.continuation || 0)) * 0.8);
    }
    const detourPads = byType("detour");
    if (detourPads.length) {
      modeScores.set("detour", 9 + Math.max(...detourPads.map((pad) => pad.bestRay?.approach || 0)) * 0.5);
    }
    const slowPads = byType("slow");
    if (slowPads.length) modeScores.set("slow", 5 + Math.min(5, slowPads.length) * 1.25);
    const speedPads = byType("speed");
    const speedOnPath = speedPads.filter((pad) => pad.onBasePath).length;
    if (speedPads.length) modeScores.set("speed", 4 + speedOnPath * 3 + speedPads.filter((pad) => !pad.mandatory).length * 0.2);
    const targetMap = {
      rewind: rewindPads
        .slice()
        .sort((a, b) => b.prefixDistance - a.prefixDistance || a.y - b.y || a.x - b.x)
        .slice(0, 2),
      stone: stonePads
        .slice()
        .sort(
          (a, b) =>
            (b.bestRay?.continuation || 0) - (a.bestRay?.continuation || 0) ||
            a.y - b.y ||
            a.x - b.x
        )
        .slice(0, 2),
      detour: detourPads
        .slice()
        .sort(
          (a, b) =>
            (b.bestRay?.approach || 0) - (a.bestRay?.approach || 0) ||
            a.y - b.y ||
            a.x - b.x
        )
        .slice(0, 2),
      slow: slowPads
        .slice()
        .sort((a, b) => Number(b.onBasePath) - Number(a.onBasePath) || a.pathIndex - b.pathIndex || a.y - b.y || a.x - b.x)
        .slice(0, 4),
      speed: speedPads
        .slice()
        .sort(
          (a, b) =>
            Number(b.onBasePath) - Number(a.onBasePath) ||
            Number(a.mandatory) - Number(b.mandatory) ||
            a.cleanRouteMargin - b.cleanRouteMargin ||
            a.y - b.y ||
            a.x - b.x
        )
        .slice(0, 4)
    };
    const modes = Array.from(modeScores, ([mode, score]) => ({ mode, score, targets: targetMap[mode] || [] })).sort(
      (a, b) => b.score - a.score || a.mode.localeCompare(b.mode)
    );
    return { basePath, basePathDistance, pads, modes };
  }

  function pathStep(path, index) {
    if (!path?.[index] || !path[index + 1]) return null;
    return {
      x: Math.sign(path[index + 1].x - path[index].x),
      y: Math.sign(path[index + 1].y - path[index].y)
    };
  }

  function padTacticalPathPotential(grid, path, targets, mode) {
    if (!path?.length) return -Infinity;
    let potential = 0;
    let speedPads = 0;
    for (const node of path) {
      if (padTypeFromCell(grid[node.y]?.[node.x]) === "speed") speedPads++;
    }
    for (const target of targets || []) {
      const index = path.findIndex((node) => node.x === target.x && node.y === target.y);
      let nearest = Infinity;
      for (const node of path) nearest = Math.min(nearest, Math.hypot(node.x - target.x, node.y - target.y));
      if (index < 0) {
        if (mode !== "speed") potential += 1.5 / (1 + nearest);
        continue;
      }
      if (mode === "rewind") {
        potential += 5 + pathDistance(path.slice(0, index + 1)) / NPC_SPEED * 0.12;
      } else if (mode === "stone") {
        const incoming = index > 0 ? pathStep(path, index - 1) : null;
        let straight = 0;
        if (incoming) {
          for (let cursor = index; cursor < path.length - 1; cursor++) {
            const next = pathStep(path, cursor);
            if (!next || next.x !== incoming.x || next.y !== incoming.y) break;
            straight += Math.hypot(next.x, next.y);
          }
        }
        potential += 3 + Math.min(4, straight * 0.18);
      } else if (mode === "detour") {
        const previous = index > 0 ? path[index - 1] : null;
        potential += 3 + estimateDetourForcedDistance(grid, target, previous) / NPC_SPEED * 0.25;
      } else if (mode === "slow") {
        potential += 1.5;
      }
    }
    if (mode === "speed") potential += Math.max(0, 4 - speedPads * 2);
    else potential -= speedPads * 0.25;
    return potential;
  }

  function padDiagnosticGuide(outcome, mode) {
    const diagnostics = outcome?.diagnostics || {};
    if (mode === "stone") {
      return Math.min(4, (diagnostics.stoneActiveDistance || 0) * 0.12) +
        Math.min(2, (diagnostics.stoneHazardOverlapTime || 0) * 0.2);
    }
    if (mode === "rewind") return Math.min(5, (diagnostics.rewindPrefixTime || 0) * 0.12);
    if (mode === "detour") return Math.min(4, (diagnostics.detourReverseDistance || 0) / NPC_SPEED * 0.3);
    if (mode === "slow") {
      return Math.min(4, (diagnostics.slowStackTime || 0) * 0.35) +
        Math.min(2, (diagnostics.slowHazardOverlapTime || 0) * 0.2);
    }
    if (mode === "speed") {
      return -Math.min(5, (diagnostics.fastActiveTime || 0) * 0.35 + (diagnostics.fastStackTime || 0) * 0.8);
    }
    return 0;
  }

  function tacticalPathPotential(grid, path, targets, mode) {
    if (!path?.length || !targets?.length) return 0;
    let potential = 0;
    const pathCells = new Set();
    for (const node of path) {
      if (isInsideGrid(node.x, node.y)) pathCells.add(keyFor(node.x, node.y));
    }
    for (const target of targets) {
      let distance = Infinity;
      for (const node of path) {
        if (!isInsideGrid(node.x, node.y)) continue;
        distance = Math.min(distance, Math.hypot(node.x - target.x, node.y - target.y));
      }
      const reached = pathCells.has(keyFor(target.x, target.y));
      const weight = mode === "reverse" ? 13 : target.type === "stone" ? 6 : 4.5;
      potential += reached ? weight : weight / (1 + distance);
      if (mode === "reverse" && target.type === "detour" && target.approach) {
        const startToApproach = findPath(
          grid,
          { x: ENTRANCE_X, y: GRID_SIZE - 1 },
          { x: target.approach.x, y: target.approach.y }
        );
        const targetToFinish = computePathFromCell(grid, target);
        if (startToApproach.length && targetToFinish.length) {
          const directed = startToApproach.concat(targetToFinish);
          const directedDistance = computeSegmentLengths(directed).reduce((sum, value) => sum + value, 0);
          const shortestDistance = computeSegmentLengths(path).reduce((sum, value) => sum + value, 0);
          const gap = Math.max(0, directedDistance - shortestDistance);
          potential -= gap * 12;
        }
      }
      if (mode === "reverse" && reached && target.type === "detour") {
        const index = path.findIndex((node) => node.x === target.x && node.y === target.y);
        const previous = index > 0 ? path[index - 1] : null;
        if (previous) {
          const reverseX = -Math.sign(target.x - previous.x);
          const reverseY = -Math.sign(target.y - previous.y);
          let corridor = 0;
          let x = target.x;
          let y = target.y;
          while (reverseX !== 0 || reverseY !== 0) {
            x += reverseX;
            y += reverseY;
            if (!isInsideGrid(x, y) || !isWalkableCell(grid, x, y)) break;
            corridor++;
          }
          const preferredApproach =
            target.approach && previous.x === target.approach.x && previous.y === target.approach.y;
          potential += corridor * (preferredApproach ? 8 : 2);
          if (preferredApproach) potential += 80;
        }
      }
    }
    let speedPads = 0;
    for (const node of path) {
      if (isInsideGrid(node.x, node.y) && padTypeFromCell(grid[node.y][node.x]) === "speed") speedPads++;
    }
    return potential - speedPads * 1.5;
  }

  function findBestExactHazardPlan(grid, specialType, neutralSpecials, baseGrid, limit, profile) {
    const pathInfo = analyzePath(grid);
    if (!pathInfo) return null;
    const candidates = collectHazardCandidateCells(grid, pathInfo, specialType, neutralSpecials, limit);
    let best = null;
    for (const cell of candidates) {
      const planned = evaluateHazardPlan(grid, specialType, neutralSpecials, cell, baseGrid, AI_WEIGHT_DEFAULTS);
      profile.hazardEvaluations++;
      if (!planned) continue;
      const simulatedTime = simulateRunnerTime(planned.grid, planned.special, neutralSpecials, {
        pathInfo: planned.pathInfo
      });
      profile.exactSimulations++;
      if (!Number.isFinite(simulatedTime)) continue;
      const candidate = { ...planned, simulatedTime, signature: keyFor(cell.x, cell.y) };
      if (
        !best ||
        candidate.simulatedTime > best.simulatedTime + 1e-9 ||
        (Math.abs(candidate.simulatedTime - best.simulatedTime) <= 1e-9 &&
          candidate.signature.localeCompare(best.signature) < 0)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  function buildExactTacticalRollout(snapshot, options = {}) {
    const startedAt = nowMs();
    const mode = options.mode || "reverse";
    const maxBuildMs = Math.max(300, options.maxBuildMs || 2600);
    const deterministicBudget = options.deterministicBudget === true;
    const candidateLimit = Math.max(8, options.candidateLimit || 18);
    const specialPlacementDepth = Math.max(0, options.specialPlacementDepth ?? 3);
    const neutralSpecials = cloneNeutralSpecials(snapshot.baseNeutralSpecials || []);
    const targets = collectTacticalPadTargets(snapshot.baseGrid, mode);
    if (!targets.length) return null;
    const focusCells = targets.flatMap((target) => (target.approach ? [target, target.approach] : [target]));
    let grid = cloneGrid(snapshot.baseGrid);
    let special = createSpecialTemplate(snapshot.specialTemplate?.type || "radius");
    let wallsLeft = Math.max(0, snapshot.coinBudget | 0);
    let singlesLeft = Math.max(0, snapshot.singleBudget | 0);
    const placementOrder = [];
    const profile = { exactSimulations: 0, hazardEvaluations: 0 };
    let placementsMade = 0;
    let lastHazardPlan = null;
    function planHazard(limit = 24) {
      const plan = findBestExactHazardPlan(
        grid,
        special.type,
        neutralSpecials,
        snapshot.baseGrid,
        limit,
        profile
      );
      if (!plan) return false;
      lastHazardPlan = plan;
      grid = plan.grid;
      special = plan.special;
      return true;
    }
    while (
      (wallsLeft > 0 || singlesLeft > 0) &&
      (deterministicBudget || nowMs() - startedAt < maxBuildMs)
    ) {
      if (!special.placed && placementsMade >= specialPlacementDepth && !planHazard()) break;
      const pathInfo = analyzePath(grid);
      if (!pathInfo) break;
      const candidates = collectPlacementCandidates(
        grid,
        pathInfo,
        special,
        wallsLeft,
        singlesLeft,
        candidateLimit,
        focusCells
      );
      let best = null;
      for (const candidate of candidates) {
        if (!deterministicBudget && nowMs() - startedAt >= maxBuildMs) break;
        const nextGrid = cloneGrid(grid);
        applySearchPlacement(nextGrid, candidate);
        const outcome = simulateRunnerOutcome(nextGrid, special.placed ? special : null, neutralSpecials, {
          diagnostics: false
        });
        profile.exactSimulations++;
        if (!outcome || !Number.isFinite(outcome.time)) continue;
        const guide = tacticalPathPotential(nextGrid, outcome.path, targets, mode);
        const score = outcome.time + guide;
        const signature = `${candidate.type}:${candidate.x},${candidate.y}`;
        if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && signature < best.signature)) {
          best = { candidate, grid: nextGrid, score, signature };
        }
      }
      if (!best) break;
      grid = best.grid;
      placementOrder.push(makePlacementOrderEntry(best.candidate));
      if (best.candidate.type === "wall") wallsLeft--;
      else singlesLeft--;
      placementsMade++;
    }
    const rawGrid = cloneGrid(grid);
    if (special.cell) rawGrid[special.cell.y][special.cell.x] = CELL_EMPTY;
    ensureOpenings(rawGrid);
    grid = rawGrid;
    special = createSpecialTemplate(snapshot.specialTemplate?.type || "radius");
    if (!planHazard(30)) return null;
    const simulatedTime = lastHazardPlan?.simulatedTime;
    if (!Number.isFinite(simulatedTime)) return null;
    placementOrder.push({
      type: "special",
      row: special.cell.y + 1,
      column: special.cell.x + 1,
      specialCell: { ...special.cell },
      specialHotspots: []
    });
    return {
      grid,
      special,
      placementOrder,
      simulatedTime,
      totalMs: nowMs() - startedAt,
      wallsUsed: (snapshot.coinBudget | 0) - wallsLeft,
      singlesUsed: (snapshot.singleBudget | 0) - singlesLeft,
      deadlineHit: wallsLeft > 0 || singlesLeft > 0,
      tacticalMode: mode,
      tacticalTargets: targets,
      profile
    };
  }

  function buildTacticalBeamRollout(snapshot, options = {}) {
    const startedAt = nowMs();
    const mode = options.mode || "reverse";
    const maxBuildMs = Math.max(500, options.maxBuildMs || 3000);
    const deterministicBudget = options.deterministicBudget === true;
    const candidateLimit = Math.max(8, options.candidateLimit || 18);
    const beamWidth = Math.max(2, options.beamWidth || 4);
    const neutralSpecials = cloneNeutralSpecials(snapshot.baseNeutralSpecials || []);
    const targets = collectTacticalPadTargets(snapshot.baseGrid, mode);
    if (!targets.length) return null;
    const focusCells = targets.flatMap((target) => (target.approach ? [target, target.approach] : [target]));
    let beam = [
      {
        grid: cloneGrid(snapshot.baseGrid),
        wallsLeft: Math.max(0, snapshot.coinBudget | 0),
        singlesLeft: Math.max(0, snapshot.singleBudget | 0),
        placementOrder: [],
        score: -Infinity,
        signature: gridSearchSignature(snapshot.baseGrid)
      }
    ];
    const totalDepth = beam[0].wallsLeft + beam[0].singlesLeft;
    const profile = { exactSimulations: 0, hazardEvaluations: 0 };
    for (
      let depth = 0;
      depth < totalDepth && beam.length && (deterministicBudget || nowMs() - startedAt < maxBuildMs);
      depth++
    ) {
      const children = [];
      for (const state of beam) {
        const pathInfo = analyzePath(state.grid);
        if (!pathInfo) continue;
        const candidates = collectPlacementCandidates(
          state.grid,
          pathInfo,
          null,
          state.wallsLeft,
          state.singlesLeft,
          candidateLimit,
          focusCells
        );
        for (const candidate of candidates) {
          if (!deterministicBudget && nowMs() - startedAt >= maxBuildMs) break;
          const grid = cloneGrid(state.grid);
          applySearchPlacement(grid, candidate);
          const outcome = simulateRunnerOutcome(grid, null, neutralSpecials, { diagnostics: false });
          profile.exactSimulations++;
          if (!outcome || !Number.isFinite(outcome.time)) continue;
          const guide = tacticalPathPotential(grid, outcome.path, targets, mode);
          const signature = gridSearchSignature(grid);
          children.push({
            grid,
            wallsLeft: state.wallsLeft - Number(candidate.type === "wall"),
            singlesLeft: state.singlesLeft - Number(candidate.type === "single"),
            placementOrder: state.placementOrder.concat(makePlacementOrderEntry(candidate)),
            score: outcome.time + guide,
            signature
          });
        }
      }
      children.sort(compareSearchEntries);
      const unique = [];
      const seen = new Set();
      for (const child of children) {
        if (seen.has(child.signature)) continue;
        seen.add(child.signature);
        unique.push(child);
        if (unique.length >= beamWidth) break;
      }
      if (!unique.length) break;
      beam = unique;
    }
    const finalists = [];
    for (const state of beam) {
      const plan = findBestExactHazardPlan(
        state.grid,
        snapshot.specialTemplate?.type || "radius",
        neutralSpecials,
        snapshot.baseGrid,
        30,
        profile
      );
      if (!plan) continue;
      const placementOrder = state.placementOrder.concat({
        type: "special",
        row: plan.special.cell.y + 1,
        column: plan.special.cell.x + 1,
        specialCell: { ...plan.special.cell },
        specialHotspots: []
      });
      finalists.push({
        grid: plan.grid,
        special: plan.special,
        placementOrder,
        simulatedTime: plan.simulatedTime,
        wallsUsed: (snapshot.coinBudget | 0) - state.wallsLeft,
        singlesUsed: (snapshot.singleBudget | 0) - state.singlesLeft,
        signature: state.signature
      });
    }
    finalists.sort((a, b) => b.simulatedTime - a.simulatedTime || a.signature.localeCompare(b.signature));
    const best = finalists[0];
    if (!best) return null;
    return {
      ...best,
      totalMs: nowMs() - startedAt,
      deadlineHit: best.wallsUsed < (snapshot.coinBudget | 0) || best.singlesUsed < (snapshot.singleBudget | 0),
      tacticalMode: mode,
      tacticalTargets: targets,
      profile
    };
  }

  function buildPadTacticalBeam(snapshot, options = {}) {
    const startedAt = nowMs();
    const mode = options.mode || "speed";
    const maxBuildMs = Math.max(500, options.maxBuildMs || 1500);
    const deterministicBudget = options.deterministicBudget === true;
    const candidateLimit = Math.max(6, options.candidateLimit || 10);
    const beamWidth = Math.max(2, options.beamWidth || 3);
    const neutralSpecials = cloneNeutralSpecials(snapshot.baseNeutralSpecials || []);
    const analysis = options.analysis || analyzePadOpportunities(snapshot.baseGrid);
    const opportunity = analysis.modes.find((entry) => entry.mode === mode);
    if (!opportunity?.targets?.length) return null;
    const targets = opportunity.targets;
    const focusCells = [];
    const focusKeys = new Set();
    function addFocus(x, y) {
      if (!isInsideGrid(x, y)) return;
      const signature = keyFor(x, y);
      if (focusKeys.has(signature)) return;
      focusKeys.add(signature);
      focusCells.push({ x, y });
    }
    for (const target of targets) {
      addFocus(target.x, target.y);
      if ((mode === "stone" || mode === "detour") && target.bestRay) {
        const direction = mode === "stone"
          ? { dx: target.bestRay.dx, dy: target.bestRay.dy }
          : { dx: -target.bestRay.dx, dy: -target.bestRay.dy };
        for (let step = 1; step <= 5; step++) {
          addFocus(target.x + direction.dx * step, target.y + direction.dy * step);
        }
      }
    }
    let beam = [
      {
        grid: cloneGrid(snapshot.baseGrid),
        wallsLeft: Math.max(0, snapshot.coinBudget | 0),
        singlesLeft: Math.max(0, snapshot.singleBudget | 0),
        placementOrder: [],
        score: -Infinity,
        signature: gridSearchSignature(snapshot.baseGrid),
        diagnostics: null
      }
    ];
    const totalDepth = beam[0].wallsLeft + beam[0].singlesLeft;
    const profile = {
      exactSimulations: 0,
      hazardEvaluations: 0,
      mode,
      opportunityScore: opportunity.score,
      targetCount: targets.length
    };
    for (
      let depth = 0;
      depth < totalDepth && beam.length && (deterministicBudget || nowMs() - startedAt < maxBuildMs);
      depth++
    ) {
      const children = [];
      for (const state of beam) {
        const pathInfo = analyzePath(state.grid);
        if (!pathInfo) continue;
        const candidates = collectPlacementCandidates(
          state.grid,
          pathInfo,
          null,
          state.wallsLeft,
          state.singlesLeft,
          candidateLimit,
          focusCells
        );
        for (const candidate of candidates) {
          if (!deterministicBudget && nowMs() - startedAt >= maxBuildMs) break;
          const grid = cloneGrid(state.grid);
          applySearchPlacement(grid, candidate);
          const outcome = simulateRunnerOutcome(grid, null, neutralSpecials);
          profile.exactSimulations++;
          if (!outcome || !Number.isFinite(outcome.time)) continue;
          const pathGuide = padTacticalPathPotential(grid, outcome.path, targets, mode);
          const diagnosticGuide = padDiagnosticGuide(outcome, mode);
          const signature = gridSearchSignature(grid);
          children.push({
            grid,
            wallsLeft: state.wallsLeft - Number(candidate.type === "wall"),
            singlesLeft: state.singlesLeft - Number(candidate.type === "single"),
            placementOrder: state.placementOrder.concat(makePlacementOrderEntry(candidate)),
            score: outcome.time + pathGuide + diagnosticGuide,
            exactTime: outcome.time,
            diagnostics: outcome.diagnostics,
            signature
          });
        }
        if (state.wallsLeft >= 2 && depth % 3 === 0) {
          const firstWalls = candidates.filter((candidate) => candidate.type === "wall").slice(0, 3);
          for (const first of firstWalls) {
            const firstGrid = cloneGrid(state.grid);
            applySearchPlacement(firstGrid, first);
            const firstPath = analyzePath(firstGrid);
            if (!firstPath) continue;
            const secondWalls = collectPlacementCandidates(
              firstGrid,
              firstPath,
              null,
              state.wallsLeft - 1,
              0,
              6,
              focusCells
            )
              .filter((candidate) => candidate.type === "wall")
              .slice(0, 2);
            for (const second of secondWalls) {
              const grid = cloneGrid(firstGrid);
              applySearchPlacement(grid, second);
              const outcome = simulateRunnerOutcome(grid, null, neutralSpecials);
              profile.exactSimulations++;
              if (!outcome || !Number.isFinite(outcome.time)) continue;
              const pathGuide = padTacticalPathPotential(grid, outcome.path, targets, mode);
              const diagnosticGuide = padDiagnosticGuide(outcome, mode);
              const signature = gridSearchSignature(grid);
              children.push({
                grid,
                wallsLeft: state.wallsLeft - 2,
                singlesLeft: state.singlesLeft,
                placementOrder: state.placementOrder.concat(
                  makePlacementOrderEntry(first),
                  makePlacementOrderEntry(second)
                ),
                score: outcome.time + pathGuide + diagnosticGuide,
                exactTime: outcome.time,
                diagnostics: outcome.diagnostics,
                signature
              });
            }
          }
        }
      }
      children.sort(compareSearchEntries);
      const unique = [];
      const seen = new Set();
      for (const child of children) {
        if (seen.has(child.signature)) continue;
        seen.add(child.signature);
        unique.push(child);
        if (unique.length >= beamWidth) break;
      }
      if (!unique.length) break;
      beam = unique;
    }
    const finalists = [];
    for (const state of beam) {
      const plan = findBestExactHazardPlan(
        state.grid,
        snapshot.specialTemplate?.type || "radius",
        neutralSpecials,
        snapshot.baseGrid,
        24,
        profile
      );
      if (!plan) continue;
      const outcome = simulateRunnerOutcome(plan.grid, plan.special, neutralSpecials);
      profile.exactSimulations++;
      if (!outcome || !Number.isFinite(outcome.time)) continue;
      finalists.push({
        grid: plan.grid,
        special: plan.special,
        placementOrder: state.placementOrder.concat({
          type: "special",
          row: plan.special.cell.y + 1,
          column: plan.special.cell.x + 1,
          specialCell: { ...plan.special.cell },
          specialHotspots: []
        }),
        simulatedTime: outcome.time,
        wallsUsed: (snapshot.coinBudget | 0) - state.wallsLeft,
        singlesUsed: (snapshot.singleBudget | 0) - state.singlesLeft,
        signature: state.signature,
        padDiagnostics: outcome.diagnostics,
        padGuide: padDiagnosticGuide(outcome, mode),
        targetReached: outcome.diagnostics.padEvents.some((event) => event.type === mode)
      });
    }
    finalists.sort((a, b) => b.simulatedTime - a.simulatedTime || b.padGuide - a.padGuide || a.signature.localeCompare(b.signature));
    const best = finalists[0];
    if (!best) return null;
    profile.targetLayouts = finalists.filter((entry) => entry.targetReached).length;
    return {
      ...best,
      totalMs: nowMs() - startedAt,
      deadlineHit: best.wallsUsed < (snapshot.coinBudget | 0) || best.singlesUsed < (snapshot.singleBudget | 0),
      tacticalMode: mode,
      tacticalTargets: targets,
      opportunity,
      profile
    };
  }

  function collectTwoByTwoOrigins(grid, value) {
    const origins = [];
    for (let y = 0; y < GRID_SIZE - 1; y++) {
      for (let x = 0; x < GRID_SIZE - 1; x++) {
        if (
          grid[y][x] === value &&
          grid[y][x + 1] === value &&
          grid[y + 1][x] === value &&
          grid[y + 1][x + 1] === value
        ) {
          origins.push({ x, y });
        }
      }
    }
    return origins;
  }

  function wallOriginsFromPlacementOrder(placementOrder) {
    return (placementOrder || [])
      .filter((entry) => entry.type === "wall")
      .map((entry) => ({ x: entry.column - 1, y: entry.row - 1 }));
  }

  function isDiagonalWallLink(a, b) {
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    return (dx === 3 && dy >= 2 && dy <= 4) || (dy === 3 && dx >= 2 && dx <= 4);
  }

  function diagonalMotifValue(placementOrder, staticOrigins) {
    const playerOrigins = wallOriginsFromPlacementOrder(placementOrder);
    let links = 0;
    for (let index = 0; index < playerOrigins.length; index++) {
      for (let other = index + 1; other < playerOrigins.length; other++) {
        if (isDiagonalWallLink(playerOrigins[index], playerOrigins[other])) links += 1;
      }
      if ((staticOrigins || []).some((origin) => isDiagonalWallLink(playerOrigins[index], origin))) links += 0.35;
    }
    return links;
  }

  function collectMotifPlacementCandidates(
    grid,
    pathInfo,
    wallsLeft,
    singlesLeft,
    placementOrder,
    staticOrigins,
    focusCells,
    limit
  ) {
    const motifSlots = wallsLeft > 0 ? Math.max(3, Math.floor(limit * 0.35)) : 0;
    const baseline = collectPlacementCandidates(
      grid,
      pathInfo,
      null,
      wallsLeft,
      singlesLeft,
      Math.max(8, limit - motifSlots),
      focusCells
    );
    const baselineKeys = new Set(baseline.map((candidate) => candidate.key));
    const motifCandidates = new Map();
    if (wallsLeft > 0) {
      const anchors = wallOriginsFromPlacementOrder(placementOrder).concat(staticOrigins || []);
      for (const anchor of anchors) {
        for (const dx of [-3, -2, 2, 3]) {
          for (const dy of [-3, -2, 2, 3]) {
            if (Math.abs(dx) !== 3 && Math.abs(dy) !== 3) continue;
            const x = anchor.x + dx;
            const y = anchor.y + dy;
            if (!canPlaceBlock(grid, x, y)) continue;
            const candidate = { type: "wall", x, y, key: `w:${keyFor(x, y)}` };
            const linkCount = anchors.reduce((sum, origin) => sum + Number(isDiagonalWallLink(candidate, origin)), 0);
            candidate.preliminary =
              placementPreliminaryScore(grid, candidate, pathInfo?.path, null) +
              candidateFocusBonus(candidate, focusCells) +
              linkCount * 95;
            if (baselineKeys.has(candidate.key)) continue;
            const existing = motifCandidates.get(candidate.key);
            if (!existing || candidate.preliminary > existing.preliminary) motifCandidates.set(candidate.key, candidate);
          }
        }
      }
    }
    const extensions = Array.from(motifCandidates.values())
      .sort((a, b) => b.preliminary - a.preliminary || a.key.localeCompare(b.key))
      .slice(0, motifSlots);
    return baseline.concat(extensions).slice(0, limit);
  }

  function buildMotifBeamRollout(snapshot, options = {}) {
    const startedAt = nowMs();
    const mode = options.mode || "route";
    const maxBuildMs = Math.max(600, options.maxBuildMs || 2600);
    const deterministicBudget = options.deterministicBudget === true;
    const candidateLimit = Math.max(8, options.candidateLimit || 16);
    const beamWidth = Math.max(2, options.beamWidth || 4);
    const motifWeight = Math.max(0, options.motifWeight ?? 0.45);
    const tacticalWeight = Math.max(
      0,
      options.tacticalWeight ?? (mode === "reverse" ? 0.18 : mode === "slow" ? 0.35 : 0)
    );
    const neutralSpecials = cloneNeutralSpecials(snapshot.baseNeutralSpecials || []);
    const targets = mode === "route" ? [] : collectTacticalPadTargets(snapshot.baseGrid, mode);
    if (mode !== "route" && !targets.length) return null;
    const focusCells = targets.flatMap((target) => (target.approach ? [target, target.approach] : [target]));
    const staticOrigins = collectTwoByTwoOrigins(snapshot.baseGrid, CELL_STATIC);
    let beam = [
      {
        grid: cloneGrid(snapshot.baseGrid),
        wallsLeft: Math.max(0, snapshot.coinBudget | 0),
        singlesLeft: Math.max(0, snapshot.singleBudget | 0),
        placementOrder: [],
        score: -Infinity,
        signature: gridSearchSignature(snapshot.baseGrid)
      }
    ];
    const totalDepth = beam[0].wallsLeft + beam[0].singlesLeft;
    const profile = { exactSimulations: 0, hazardEvaluations: 0 };
    for (
      let depth = 0;
      depth < totalDepth && beam.length && (deterministicBudget || nowMs() - startedAt < maxBuildMs);
      depth++
    ) {
      const children = [];
      for (const state of beam) {
        const pathInfo = analyzePath(state.grid);
        if (!pathInfo) continue;
        const candidates = collectMotifPlacementCandidates(
          state.grid,
          pathInfo,
          state.wallsLeft,
          state.singlesLeft,
          state.placementOrder,
          staticOrigins,
          focusCells,
          candidateLimit
        );
        for (const candidate of candidates) {
          if (!deterministicBudget && nowMs() - startedAt >= maxBuildMs) break;
          const grid = cloneGrid(state.grid);
          applySearchPlacement(grid, candidate);
          const outcome = simulateRunnerOutcome(grid, null, neutralSpecials, { diagnostics: false });
          profile.exactSimulations++;
          if (!outcome || !Number.isFinite(outcome.time)) continue;
          const placementOrder = state.placementOrder.concat(makePlacementOrderEntry(candidate));
          const motifGuide = diagonalMotifValue(placementOrder, staticOrigins) * motifWeight;
          const tacticalGuide = targets.length
            ? tacticalPathPotential(grid, outcome.path, targets, mode) * tacticalWeight
            : 0;
          const signature = gridSearchSignature(grid);
          children.push({
            grid,
            wallsLeft: state.wallsLeft - Number(candidate.type === "wall"),
            singlesLeft: state.singlesLeft - Number(candidate.type === "single"),
            placementOrder,
            score: outcome.time + motifGuide + tacticalGuide,
            signature
          });
        }
      }
      children.sort(compareSearchEntries);
      const unique = [];
      const seen = new Set();
      for (const child of children) {
        if (seen.has(child.signature)) continue;
        seen.add(child.signature);
        unique.push(child);
        if (unique.length >= beamWidth) break;
      }
      beam = unique;
    }
    const finalists = [];
    for (const state of beam) {
      const plan = findBestExactHazardPlan(
        state.grid,
        snapshot.specialTemplate?.type || "radius",
        neutralSpecials,
        snapshot.baseGrid,
        30,
        profile
      );
      if (!plan) continue;
      finalists.push({
        grid: plan.grid,
        special: plan.special,
        placementOrder: state.placementOrder.concat({
          type: "special",
          row: plan.special.cell.y + 1,
          column: plan.special.cell.x + 1,
          specialCell: { ...plan.special.cell },
          specialHotspots: []
        }),
        simulatedTime: plan.simulatedTime,
        wallsUsed: (snapshot.coinBudget | 0) - state.wallsLeft,
        singlesUsed: (snapshot.singleBudget | 0) - state.singlesLeft,
        signature: state.signature,
        motifValue: diagonalMotifValue(state.placementOrder, staticOrigins)
      });
    }
    finalists.sort((a, b) => b.simulatedTime - a.simulatedTime || a.signature.localeCompare(b.signature));
    const best = finalists[0];
    if (!best) return null;
    return {
      ...best,
      totalMs: nowMs() - startedAt,
      deadlineHit: best.wallsUsed < (snapshot.coinBudget | 0) || best.singlesUsed < (snapshot.singleBudget | 0),
      tacticalMode: mode,
      tacticalTargets: targets,
      profile
    };
  }

  function buildTacticalPortfolioRollout(snapshot, options = {}) {
    const startedAt = nowMs();
    const mode = options.mode || "reverse";
    const maxBuildMs = Math.max(600, options.maxBuildMs || 2600);
    const deterministicBudget = options.deterministicBudget === true;
    const candidateLimit = Math.max(6, options.candidateLimit || 11);
    const rolloutLimit = Math.max(4, options.rolloutLimit || 24);
    const tacticalWeight = Math.max(0, options.tacticalWeight ?? (mode === "reverse" ? 0.15 : 0.3));
    const motifWeight = Math.max(0, options.motifWeight ?? 0.12);
    const randomChoicePool = Math.max(2, options.randomChoicePool || 6);
    const neutralSpecials = cloneNeutralSpecials(snapshot.baseNeutralSpecials || []);
    const targets = collectTacticalPadTargets(snapshot.baseGrid, mode);
    if (!targets.length) return null;
    const focusCells = targets.flatMap((target) => (target.approach ? [target, target.approach] : [target]));
    const staticOrigins = collectTwoByTwoOrigins(snapshot.baseGrid, CELL_STATIC);
    const portfolioSalt = options.portfolioIndex
      ? `tactical-portfolio:${mode}:${options.portfolioIndex}`
      : `tactical-portfolio:${mode}`;
    const rng = mulberry32(((snapshot.rngSeed || 0) ^ hashSeed(portfolioSalt)) >>> 0);
    const profile = { exactSimulations: 0, hazardEvaluations: 0, rollouts: 0 };
    const completed = [];
    for (
      let rolloutIndex = 0;
      rolloutIndex < rolloutLimit && (deterministicBudget || nowMs() - startedAt < maxBuildMs);
      rolloutIndex++
    ) {
      const rolloutTacticalWeight =
        mode === "reverse" && rolloutIndex % 4 === 0 ? Math.max(tacticalWeight, 0.6) : tacticalWeight;
      let grid = cloneGrid(snapshot.baseGrid);
      let wallsLeft = Math.max(0, snapshot.coinBudget | 0);
      let singlesLeft = Math.max(0, snapshot.singleBudget | 0);
      const placementOrder = [];
      while (
        (wallsLeft > 0 || singlesLeft > 0) &&
        (deterministicBudget || nowMs() - startedAt < maxBuildMs)
      ) {
        const pathInfo = analyzePath(grid);
        if (!pathInfo) break;
        const candidates = collectMotifPlacementCandidates(
          grid,
          pathInfo,
          wallsLeft,
          singlesLeft,
          placementOrder,
          staticOrigins,
          focusCells,
          candidateLimit
        );
        const ranked = [];
        for (const candidate of candidates) {
          if (!deterministicBudget && nowMs() - startedAt >= maxBuildMs) break;
          const nextGrid = cloneGrid(grid);
          applySearchPlacement(nextGrid, candidate);
          const outcome = simulateRunnerOutcome(nextGrid, null, neutralSpecials, { diagnostics: false });
          profile.exactSimulations++;
          if (!outcome || !Number.isFinite(outcome.time)) continue;
          const nextOrder = placementOrder.concat(makePlacementOrderEntry(candidate));
          const guide =
            tacticalPathPotential(nextGrid, outcome.path, targets, mode) * rolloutTacticalWeight +
            diagonalMotifValue(nextOrder, staticOrigins) * motifWeight;
          ranked.push({ candidate, grid: nextGrid, score: outcome.time + guide, exactTime: outcome.time });
        }
        ranked.sort((a, b) => b.score - a.score || a.candidate.key.localeCompare(b.candidate.key));
        if (!ranked.length) break;
        const choicePool = Math.min(ranked.length, rolloutIndex === 0 ? 1 : randomChoicePool);
        const choiceIndex = rolloutIndex === 0 ? 0 : Math.min(choicePool - 1, Math.floor(rng() * rng() * choicePool));
        const chosen = ranked[choiceIndex];
        grid = chosen.grid;
        placementOrder.push(makePlacementOrderEntry(chosen.candidate));
        if (chosen.candidate.type === "wall") wallsLeft--;
        else singlesLeft--;
      }
      const outcome = simulateRunnerOutcome(grid, null, neutralSpecials, { diagnostics: false });
      profile.exactSimulations++;
      if (outcome && Number.isFinite(outcome.time)) {
        const targetReached = targets.some((target) =>
          outcome.path.some((node) => node.x === target.x && node.y === target.y)
        );
        completed.push({
          grid,
          wallsLeft,
          singlesLeft,
          placementOrder,
          exactTime: outcome.time,
          targetReached,
          tacticalPotential: tacticalPathPotential(grid, outcome.path, targets, mode),
          signature: gridSearchSignature(grid)
        });
      }
      profile.rollouts++;
    }
    profile.targetLayouts = completed.filter((state) => state.targetReached).length;
    completed.sort((a, b) => b.exactTime - a.exactTime || a.signature.localeCompare(b.signature));
    const finalistStates = completed
      .slice(0, 3)
      .concat(
        completed
          .filter((state) => state.targetReached)
          .sort((a, b) => b.exactTime - a.exactTime || b.tacticalPotential - a.tacticalPotential)
          .slice(0, 5)
      );
    const finalists = [];
    const seen = new Set();
    for (const state of finalistStates) {
      if (seen.has(state.signature)) continue;
      seen.add(state.signature);
      const plan = findBestExactHazardPlan(
        state.grid,
        snapshot.specialTemplate?.type || "radius",
        neutralSpecials,
        snapshot.baseGrid,
        30,
        profile
      );
      if (plan) {
        finalists.push({
          grid: plan.grid,
          special: plan.special,
          placementOrder: state.placementOrder.concat({
            type: "special",
            row: plan.special.cell.y + 1,
            column: plan.special.cell.x + 1,
            specialCell: { ...plan.special.cell },
            specialHotspots: []
          }),
          simulatedTime: plan.simulatedTime,
          wallsUsed: (snapshot.coinBudget | 0) - state.wallsLeft,
          singlesUsed: (snapshot.singleBudget | 0) - state.singlesLeft,
          signature: state.signature,
          targetReached: state.targetReached
        });
      }
      if (finalists.length >= 5 || (!deterministicBudget && nowMs() - startedAt >= maxBuildMs + 900)) break;
    }
    finalists.sort((a, b) => b.simulatedTime - a.simulatedTime || a.signature.localeCompare(b.signature));
    const best = finalists[0];
    if (!best) return null;
    return {
      ...best,
      totalMs: nowMs() - startedAt,
      deadlineHit: best.wallsUsed < (snapshot.coinBudget | 0) || best.singlesUsed < (snapshot.singleBudget | 0),
      tacticalMode: mode,
      tacticalTargets: targets,
      targetReached: best.targetReached,
      profile
    };
  }

  function buildAiLayoutFromSnapshot(snapshot) {
    const buildStartedAt = nowMs();
    const limits = resolveAiSearchProfile(snapshot);
    const deterministicBudget = snapshot.deterministicBudget !== false;
    const previousGenerationMetrics = activeGenerationMetrics;
    const workMetrics = {
      pathSearches: 0,
      pathNodesExpanded: 0,
      simulations: 0,
      simulationSteps: 0,
      diagnosticSimulations: 0,
      gridClones: 0
    };
    activeGenerationMetrics = workMetrics;
    function finishBuild(result) {
      if (result?.profile) result.profile.work = { ...workMetrics };
      activeGenerationMetrics = previousGenerationMetrics;
      return result;
    }
    // The optimized pad-aware portfolio is the universal opponent. Research
    // benchmarks can still disable it explicitly to compare the core search.
    const padAwareTactics = snapshot.padAwareTactics !== false;
    const deadline = deterministicBudget ? Infinity : buildStartedAt + limits.maxBuildMs;
    const aiWeights = { ...AI_WEIGHT_DEFAULTS, ...(snapshot.aiWeights || {}) };
    const specialType = snapshot.specialTemplate?.type || "radius";
    const baseGrid = cloneGrid(snapshot.baseGrid);
    const neutralSpecials = cloneNeutralSpecials(snapshot.baseNeutralSpecials || []);
    const profile = {
      totalMs: 0,
      placementMs: 0,
      specialMs: 0,
      reclaimMs: 0,
      simulationMs: 0,
      lookaheadUsed: 0,
      placements: 0,
      source: "ai-core",
      strategy: "bounded-route-search",
      aiVersion: AI_VERSION,
      difficulty: limits.name,
      candidateBudget: limits.candidateBudget,
      candidatesEvaluated: 0,
      hazardEvaluations: 0,
      cacheHits: 0,
      exactSimulations: 0,
      exactSearchSimulations: 0,
      finalists: 0,
      refinementMs: 0,
      refinementEvaluations: 0,
      refinements: 0,
      deadlineHit: false,
      budgetHit: false
    };
    profile.padAwareTactics = padAwareTactics;
    const context = {
      limits,
      deadline,
      profile,
      aiWeights,
      specialType,
      baseGrid: snapshot.baseGrid,
      neutralSpecials,
      cache: new Map()
    };
    const initialEvaluation = evaluateSearchGrid(baseGrid, context, null, true);
    if (!initialEvaluation) {
      return finishBuild(buildLegacyAiLayoutFromSnapshot(snapshot));
    }
    const initialState = {
      grid: baseGrid,
      wallsLeft: Math.max(0, snapshot.coinBudget | 0),
      singlesLeft: Math.max(0, snapshot.singleBudget | 0),
      wallsUsed: 0,
      singlesUsed: 0,
      placementOrder: [],
      depth: 0,
      evaluation: initialEvaluation,
      score: initialEvaluation.score,
      signature: gridSearchSignature(baseGrid)
    };
    let beam = [initialState];
    const archive = new Map();
    addSearchArchive(archive, initialState);
    const totalDepth = initialState.wallsLeft + initialState.singlesLeft;
    const placementStartedAt = nowMs();
    for (let depth = 0; depth < totalDepth && beam.length; depth++) {
      if (profile.candidatesEvaluated >= limits.candidateBudget) {
        profile.budgetHit = true;
        break;
      }
      if (nowMs() >= deadline) {
        profile.deadlineHit = true;
        break;
      }
      const children = [];
      for (const state of beam) {
        const candidates = collectPlacementCandidates(
          state.grid,
          state.evaluation.pathInfo,
          state.evaluation.special,
          state.wallsLeft,
          state.singlesLeft,
          limits.candidatesPerState
        );
        for (const candidate of candidates) {
          if (profile.candidatesEvaluated >= limits.candidateBudget || nowMs() >= deadline) break;
          if (candidate.type === "wall" && state.wallsLeft <= 0) continue;
          if (candidate.type === "single" && state.singlesLeft <= 0) continue;
          const nextGrid = cloneGrid(state.grid);
          applySearchPlacement(nextGrid, candidate);
          profile.candidatesEvaluated++;
          const replanHazard = (depth + 1) % 3 === 0;
          const evaluation = evaluateSearchGrid(nextGrid, context, state.evaluation.special, replanHazard);
          if (!evaluation) continue;
          const signature = gridSearchSignature(nextGrid);
          children.push({
            grid: nextGrid,
            wallsLeft: state.wallsLeft - Number(candidate.type === "wall"),
            singlesLeft: state.singlesLeft - Number(candidate.type === "single"),
            wallsUsed: state.wallsUsed + Number(candidate.type === "wall"),
            singlesUsed: state.singlesUsed + Number(candidate.type === "single"),
            placementOrder: state.placementOrder.concat(makePlacementOrderEntry(candidate)),
            depth: state.depth + 1,
            evaluation,
            score: evaluation.score,
            signature
          });
        }
      }
      if (!children.length) break;
      children.sort(compareSearchEntries);
      let unique = [];
      const seen = new Set();
      for (const child of children) {
        if (seen.has(child.signature)) continue;
        seen.add(child.signature);
        unique.push(child);
        addSearchArchive(archive, child);
        if (unique.length >= limits.beamWidth * 2) break;
      }
      if ((depth + 1) % 4 === 0) {
        const exactStartedAt = nowMs();
        for (const candidate of unique) {
          const exactTime = simulateRunnerTime(
            candidate.evaluation.grid,
            candidate.evaluation.special,
            neutralSpecials,
            { pathInfo: candidate.evaluation.pathInfo }
          );
          profile.exactSearchSimulations++;
          if (Number.isFinite(exactTime)) {
            candidate.exactSearchTime = exactTime;
            candidate.score = exactTime * 100 + candidate.score * 0.002;
          }
        }
        profile.simulationMs += nowMs() - exactStartedAt;
        unique.sort(compareSearchEntries);
      }
      beam = unique.slice(0, limits.beamWidth);
    }
    profile.placementMs = nowMs() - placementStartedAt;
    profile.lookaheadUsed = profile.candidatesEvaluated;

    const archivedStates = Array.from(archive.values());
    const heuristicFinalists = archivedStates.slice().sort(compareSearchEntries).slice(0, Math.ceil(limits.finalistLimit / 2));
    const deepestFinalists = archivedStates
      .slice()
      .sort((a, b) => b.depth - a.depth || compareSearchEntries(a, b))
      .slice(0, Math.ceil(limits.finalistLimit / 2));
    const finalistStates = [];
    const finalistKeys = new Set();
    for (const state of heuristicFinalists.concat(deepestFinalists)) {
      if (finalistKeys.has(state.signature)) continue;
      finalistKeys.add(state.signature);
      finalistStates.push(state);
      if (finalistStates.length >= limits.finalistLimit) break;
    }
    const finalists = [];
    for (const state of finalistStates) {
      const finalist = materializeSearchFinalist(state, context);
      if (finalist) finalists.push(finalist);
    }
    const totalResources = Math.max(0, snapshot.coinBudget | 0) + Math.max(0, snapshot.singleBudget | 0);
    const rolloutPlans = limits.name === "hard"
      ? [
          { specialPlacementDepth: 0, relocateAtEnd: true },
          { specialPlacementDepth: 3, relocateAtEnd: true },
          { specialPlacementDepth: totalResources, relocateAtEnd: true }
        ]
      : [{ specialPlacementDepth: 0, relocateAtEnd: true }];
    const rolloutBudget = limits.name === "hard" ? 900 : 1800;
    profile.rolloutMs = 0;
    profile.rolloutUsed = false;
    profile.rolloutCount = 0;
    profile.rolloutDeadlineHit = false;
    for (const rolloutPlan of rolloutPlans) {
      const rolloutStartedAt = nowMs();
      const rollout = buildRouteRolloutFromSnapshot(snapshot, {
        maxBuildMs: rolloutBudget,
        deterministicBudget,
        ...rolloutPlan
      });
      profile.rolloutMs += nowMs() - rolloutStartedAt;
      if (rollout && Number.isFinite(rollout.simulatedTime)) {
        const rolloutPath = analyzePath(rollout.grid);
        finalists.push({
          ...rollout,
          candidateSource: `route-rollout-${rolloutPlan.specialPlacementDepth}`,
          heuristicScore: 0,
          structureContacts: routeBarrierContact(rollout.grid, rolloutPath?.path),
          existingStructureContacts: existingStructureContact(context.baseGrid, rolloutPath?.path)
        });
        profile.rolloutUsed = true;
        profile.rolloutCount++;
        profile.rolloutDeadlineHit ||= rollout.deadlineHit;
      }
    }
    profile.tacticalMs = 0;
    profile.tacticalCount = 0;
    profile.tacticalTargetLayouts = 0;
    profile.padOpportunities = [];
    profile.padSpecialists = [];
    if (limits.name === "hard") {
      for (const tacticalMode of ["reverse", "slow"]) {
        const tacticalStartedAt = nowMs();
        const tactical = tacticalMode === "reverse"
          ? buildTacticalPortfolioRollout(snapshot, {
              mode: tacticalMode,
              maxBuildMs: 1800,
              candidateLimit: 8,
              rolloutLimit: 20,
              deterministicBudget
            })
          : buildExactTacticalRollout(snapshot, {
              mode: tacticalMode,
              maxBuildMs: 1800,
              candidateLimit: 16,
              specialPlacementDepth: 3,
              deterministicBudget
            });
        profile.tacticalMs += nowMs() - tacticalStartedAt;
        if (!tactical || !Number.isFinite(tactical.simulatedTime)) continue;
        const tacticalPath = analyzePath(tactical.grid);
        finalists.push({
          ...tactical,
          candidateSource: `tactical-${tacticalMode}`,
          heuristicScore: 0,
          structureContacts: routeBarrierContact(tactical.grid, tacticalPath?.path),
          existingStructureContacts: existingStructureContact(context.baseGrid, tacticalPath?.path)
        });
        profile.tacticalCount++;
        profile.tacticalTargetLayouts += tactical.profile?.targetLayouts || 0;
      }
      if (padAwareTactics) {
        const padAnalysis = analyzePadOpportunities(snapshot.baseGrid);
        const specialistLimit = Math.max(0, Math.min(4, snapshot.padSpecialistLimit ?? 3));
        const selectedOpportunities = padAnalysis.modes.slice(0, specialistLimit);
        profile.padOpportunities = padAnalysis.modes.map((entry) => ({
          mode: entry.mode,
          score: entry.score,
          targets: entry.targets.length
        }));
        for (const opportunity of selectedOpportunities) {
          const tacticalStartedAt = nowMs();
          const tactical = buildPadTacticalBeam(snapshot, {
            mode: opportunity.mode,
            analysis: padAnalysis,
            maxBuildMs: 1500,
            candidateLimit: 10,
            beamWidth: 3,
            deterministicBudget
          });
          profile.tacticalMs += nowMs() - tacticalStartedAt;
          profile.padSpecialists.push({
            mode: opportunity.mode,
            opportunityScore: opportunity.score,
            elapsedMs: nowMs() - tacticalStartedAt,
            score: tactical?.simulatedTime ?? null,
            targetLayouts: tactical?.profile?.targetLayouts || 0
          });
          if (!tactical || !Number.isFinite(tactical.simulatedTime)) continue;
          const tacticalPath = analyzePath(tactical.grid);
          finalists.push({
            ...tactical,
            candidateSource: `pad-${opportunity.mode}`,
            heuristicScore: 0,
            structureContacts: routeBarrierContact(tactical.grid, tacticalPath?.path),
            existingStructureContacts: existingStructureContact(context.baseGrid, tacticalPath?.path)
          });
          profile.tacticalCount++;
          profile.tacticalTargetLayouts += tactical.profile?.targetLayouts || 0;
        }
      }
    }
    finalists.sort((a, b) => b.simulatedTime - a.simulatedTime || b.heuristicScore - a.heuristicScore);
    profile.finalists = finalists.length;
    let chosenIndex = limits.finalistRank || 0;
    if (chosenIndex >= finalists.length) chosenIndex = 0;
    const refinementStartedAt = nowMs();
    const refinementCandidates = [];
    const established = finalists.find((candidate) => !String(candidate.candidateSource || "").startsWith("pad-"));
    if (established) refinementCandidates.push(established);
    if (padAwareTactics) {
      const specialist = finalists.find((candidate) => String(candidate.candidateSource || "").startsWith("pad-"));
      if (specialist && specialist !== established) refinementCandidates.push(specialist);
    }
    if (!refinementCandidates.length) {
      const fallback = finalists[chosenIndex] || materializeSearchFinalist(initialState, context);
      if (fallback) refinementCandidates.push(fallback);
    }
    let refinementEvaluations = 0;
    let refinements = 0;
    for (const candidate of refinementCandidates) {
      const refinement = refineFinalLayout(candidate, context);
      refinementEvaluations += refinement.evaluations;
      refinements += refinement.changed;
    }
    finalists.sort((a, b) => b.simulatedTime - a.simulatedTime || b.heuristicScore - a.heuristicScore);
    const best = finalists[chosenIndex] || refinementCandidates[0];
    if (!best) return finishBuild(buildLegacyAiLayoutFromSnapshot(snapshot));
    profile.chosenCandidate = best.candidateSource || "bounded-search";
    profile.refinementMs = nowMs() - refinementStartedAt;
    profile.refinementEvaluations = refinementEvaluations;
    profile.refinements = refinements;
    profile.padRefinementMs = 0;
    profile.padRefinementEvaluations = 0;
    profile.padRefinements = 0;
    if (padAwareTactics && snapshot.padAwareRefinement !== false && limits.name === "hard") {
      const padRefinementStartedAt = nowMs();
      const padRefinement = refinePadAwareLayout(best, context, analyzePadOpportunities(context.baseGrid));
      profile.padRefinementMs = nowMs() - padRefinementStartedAt;
      profile.padRefinementEvaluations = padRefinement.evaluations;
      profile.padRefinements = padRefinement.changed;
    }
    const withoutHazardGrid = cloneGrid(best.grid);
    if (best.special?.cell) withoutHazardGrid[best.special.cell.y][best.special.cell.x] = CELL_EMPTY;
    ensureOpenings(withoutHazardGrid);
    const withoutHazardStartedAt = nowMs();
    const withoutHazardTime = simulateRunnerTime(withoutHazardGrid, null, neutralSpecials);
    profile.simulationMs += nowMs() - withoutHazardStartedAt;
    const outcomeStartedAt = nowMs();
    const simulatedOutcome = simulateRunnerOutcome(best.grid, best.special, neutralSpecials);
    profile.simulationMs += nowMs() - outcomeStartedAt;
    profile.placements = best.placementOrder.length;
    profile.totalMs = nowMs() - buildStartedAt;
    profile.secondaryMs =
      (profile.rolloutMs || 0) +
      (profile.tacticalMs || 0) +
      (profile.refinementMs || 0) +
      (profile.padRefinementMs || 0);
    profile.specialMs = Math.max(0, profile.totalMs - profile.placementMs - profile.simulationMs);
    profile.quality = {
      simulatedTime: best.simulatedTime,
      hazardPlaced: !!best.special?.placed,
      hazardImpact: Number.isFinite(withoutHazardTime) ? best.simulatedTime - withoutHazardTime : 0,
      structureContacts: best.structureContacts,
      existingStructureContacts: best.existingStructureContacts,
      triggeredPads: simulatedOutcome?.triggeredPads || { speed: 0, slow: 0, detour: 0, stone: 0, rewind: 0 },
      padDiagnostics: simulatedOutcome?.diagnostics || null,
      wallsUsed: best.wallsUsed,
      singlesUsed: best.singlesUsed
    };
    return finishBuild({
      grid: best.grid,
      special: best.special,
      placementOrder: best.placementOrder,
      profile,
      simulatedTime: best.simulatedTime,
      branchId: null,
      branch: null,
      branchPlacementIndex: null,
      branchTotal: 1,
      lookaheadUsed: profile.lookaheadUsed
    });
  }

  function buildLegacyAiLayoutFromSnapshot(snapshot) {
    const buildStartedAt = nowMs();
    const aiWeights = { ...AI_WEIGHT_DEFAULTS, ...(snapshot.aiWeights || {}) };
    const rng = snapshot.rng || mulberry32(snapshot.rngSeed >>> 0);
    const baseState = {
      grid: cloneGrid(snapshot.baseGrid),
      special: createSpecialTemplate(snapshot.specialTemplate?.type || "radius"),
      neutralSpecials: snapshot.baseNeutralSpecials || [],
      wallsLeft: snapshot.coinBudget | 0,
      singlesLeft: snapshot.singleBudget | 0,
      initialPlacements: (snapshot.coinBudget | 0) + (snapshot.singleBudget | 0),
      placementsMade: 0,
      aiWeights,
      baseGrid: snapshot.baseGrid,
      rng,
      placementOrder: [],
      specialsOverride: snapshot.specialHotspotsOverride || null,
      branchPlacementIndex: null,
      branchCounter: { value: 0 }
    };
    const layouts = branchBuild(baseState);
    const best = layouts
      .filter(Boolean)
      .sort((a, b) => (b.simulatedTime ?? -Infinity) - (a.simulatedTime ?? -Infinity))[0];
    const result = best || finalizeLayout(baseState);
    if (result) {
      result.profile = {
        ...(result.profile || {}),
        totalMs: nowMs() - buildStartedAt,
        source: "ai-core"
      };
    }
    return result;
  }

  function computeBranchPlacementIndex(state) {
    if (!state) return null;
    const placementsMade = state.placementsMade || 0;
    if (placementsMade > 0 && placementsMade <= 3) {
      return placementsMade;
    }
    const totalPlacements = state.initialPlacements || 0;
    const placementsRemaining = Math.max(0, totalPlacements - placementsMade);
    if (placementsRemaining >= 1 && placementsRemaining <= 3) {
      return -placementsRemaining;
    }
    return null;
  }

  function branchBuild(state) {
    if (!state) return [];
    if (state.wallsLeft <= 0 && state.singlesLeft <= 0) {
      return [finalizeLayout(state)];
    }
    const pathInfo = analyzePath(state.grid);
    if (!pathInfo) {
      return [finalizeLayout(state)];
    }
    const chosen = chooseBlockPlacement(state, pathInfo);
    if (!chosen) {
      return [finalizeLayout(state)];
    }
    const nextState = cloneState(state);
    applyBlockPlacement(nextState, chosen);
    const specialHotspots =
      !nextState.special?.placed && nextState.specialsOverride
        ? nextState.specialsOverride
        : !nextState.special?.placed
        ? computeSpecialHotspots(nextState.grid, nextState.special, nextState.neutralSpecials, SPECIAL_HOTSPOT_LIMIT, nextState.rng)
        : [];
    const hotspotSnapshot = specialHotspots.map((spot) => ({
      x: spot.x,
      y: spot.y,
      score: spot.score
    }));
    const lastEntry = nextState.placementOrder[nextState.placementOrder.length - 1];
    if (lastEntry) {
      lastEntry.specialHotspots = hotspotSnapshot;
    }
    const branchPlacementIndex = computeBranchPlacementIndex(nextState);
    const results = [];
    const placementsRemaining = (nextState.initialPlacements || 0) - (nextState.placementsMade || 0);
    const shouldBranch =
      (!nextState.special?.placed &&
        specialHotspots.length &&
        ((nextState.placementsMade || 0) <= 3 || placementsRemaining <= 3));
    if (shouldBranch) {
      const specialState = cloneState(nextState);
      if (branchPlacementIndex != null) {
        specialState.branchPlacementIndex = branchPlacementIndex;
      }
      applySpecialBranch(specialState, specialHotspots[0], hotspotSnapshot);
      results.push(...branchBuild(specialState));
    }
    results.push(...branchBuild(nextState));
    return results;
  }

  function chooseBlockPlacement(state, pathInfo) {
    const placement = findBestAiPlacement(
      state.grid,
      evaluateGridForAi(state.grid, state.special, state.neutralSpecials),
      state.special,
      state.neutralSpecials,
      pathInfo,
      { wallsLeft: state.wallsLeft, singlesLeft: state.singlesLeft, specialHotspots: [] },
      state.wallsLeft > 0,
      state.singlesLeft > 0,
      null,
      state.aiWeights,
      state.baseGrid,
      state.rng
    );
    if (placement) return placement;
    return fallbackPlacement(state);
  }

  function fallbackPlacement(state) {
    const tries = 200;
    for (let t = 0; t < tries; t++) {
      const wallTry = state.wallsLeft > 0;
      const singleTry = state.singlesLeft > 0;
      if (!wallTry && !singleTry) break;
      const isWall = wallTry && (!singleTry || state.rng() > 0.5);
      if (isWall) {
        const x = Math.floor(state.rng() * (GRID_SIZE - 1));
        const y = 1 + Math.floor(state.rng() * (GRID_SIZE - 2));
        if (!canPlaceBlock(state.grid, x, y)) continue;
        placeBlock(state.grid, x, y, CELL_PLAYER);
        ensureOpenings(state.grid);
        if (hasPath(state.grid)) {
          const score = evaluateGridForAi(state.grid, state.special, state.neutralSpecials, null, state.aiWeights, state.baseGrid);
          clearBlock(state.grid, x, y);
          ensureOpenings(state.grid);
          return { type: "wall", x, y, score };
        }
        clearBlock(state.grid, x, y);
        ensureOpenings(state.grid);
      } else {
        const x = Math.floor(state.rng() * GRID_SIZE);
        const y = 1 + Math.floor(state.rng() * (GRID_SIZE - 2));
        if (!canPlaceSingle(state.grid, x, y)) continue;
        const prev = state.grid[y][x];
        state.grid[y][x] = CELL_SINGLE;
        ensureOpenings(state.grid);
        if (hasPath(state.grid)) {
          const score = evaluateGridForAi(state.grid, state.special, state.neutralSpecials, null, state.aiWeights, state.baseGrid);
          state.grid[y][x] = prev;
          ensureOpenings(state.grid);
          return { type: "single", x, y, score };
        }
        state.grid[y][x] = prev;
        ensureOpenings(state.grid);
      }
    }
    return null;
  }

  function applyBlockPlacement(state, chosen) {
    const { x, y } = chosen;
    if (chosen.type === "wall") {
      placeBlock(state.grid, x, y, CELL_PLAYER);
      state.wallsLeft = Math.max(0, state.wallsLeft - 1);
    } else if (chosen.type === "single") {
      state.grid[y][x] = CELL_SINGLE;
      state.singlesLeft = Math.max(0, state.singlesLeft - 1);
    }
    ensureOpenings(state.grid);
    state.placementOrder.push({
      type: chosen.type,
      row: y + 1,
      column: x + 1,
      specialHotspots: []
    });
    state.placementsMade = (state.placementsMade || 0) + 1;
  }

  function applySpecialBranch(state, hotspot, hotspotSnapshot) {
    const { x, y } = hotspot;
    state.grid[y][x] = CELL_SPECIAL;
    ensureOpenings(state.grid);
    state.special.cell = { x, y };
    state.special.placed = true;
    state.special.effectTimer = 0;
    state.special.cooldown = 0;
    state.special.flashTimer = 0;
    state.placementOrder.push({
      type: "special",
      row: y + 1,
      column: x + 1,
      specialHotspots: hotspotSnapshot
    });
    return state;
  }

  let branchCounter = 0;

  function finalizeLayout(state) {
    if (!state) return null;
    const finalizeStartedAt = nowMs();
    ensureOpenings(state.grid);
    const reclaimStartedAt = nowMs();
    reduceMandatorySpeedPads(state.grid, state.special, state.neutralSpecials, 0, state.aiWeights, state.baseGrid);
    const reclaimStats = reclaimAndReallocateBlocks(state.grid, state.special, state.neutralSpecials, state.placementOrder, state.aiWeights, state.baseGrid, state.rng);
    const reclaimMs = nowMs() - reclaimStartedAt;
    state.placementOrder.reallocations = reclaimStats.reallocated || 0;
    state.placementOrder.reallocationPasses = reclaimStats.passes || 0;
    annotatePlacementImpacts(state.grid, state.special, state.neutralSpecials, state.placementOrder);
    const counter = state.branchCounter || { value: 0 };
    const branchId = ++counter.value;
    state.branchCounter = counter;
    const branchPlacementIndex = state.branchPlacementIndex ?? null;
    const profile = {
      totalMs: 0,
      placementMs: 0,
      specialMs: 0,
      reclaimMs,
      simulationMs: 0,
      lookaheadUsed: 0,
      branch: branchPlacementIndex ?? null,
      placements: state.placementOrder.length,
      source: "ai-core"
    };
    const simulationStartedAt = nowMs();
    const simulatedTime = simulateRunnerTime(state.grid, state.special, state.neutralSpecials);
    profile.simulationMs = nowMs() - simulationStartedAt;
    profile.totalMs = nowMs() - finalizeStartedAt;
    profile.placementMs = Math.max(0, profile.totalMs - profile.reclaimMs - profile.simulationMs);
    const lookaheadUsed = profile.lookaheadUsed || 0;
    return {
      grid: state.grid,
      special: state.special,
      placementOrder: state.placementOrder,
      profile,
      simulatedTime,
      branchId,
      branch: branchPlacementIndex ?? null,
      branchPlacementIndex,
      branchTotal: counter.value,
      lookaheadUsed
    };
  }

  function cloneState(state) {
    if (!state) return null;
    return {
      grid: cloneGrid(state.grid),
      special: cloneSpecial(state.special),
      neutralSpecials: cloneNeutralSpecials(state.neutralSpecials),
      wallsLeft: state.wallsLeft,
      singlesLeft: state.singlesLeft,
      aiWeights: state.aiWeights,
      baseGrid: state.baseGrid,
      rng: state.rng,
      placementOrder: state.placementOrder.map((entry) => ({ ...entry })),
      specialsOverride: state.specialsOverride,
      branchPlacementIndex: state.branchPlacementIndex,
      branchCounter: state.branchCounter
      ,
      initialPlacements: state.initialPlacements,
      placementsMade: state.placementsMade
    };
  }

  // Timing / prediction
  function iteratePathSegments(pathInfo, callback) {
    const path = pathInfo?.path;
    if (!path?.length) return;
    for (let i = 1; i < path.length; i++) {
      const cell = path[i];
      const baseTime = (pathInfo.lengths[i - 1] || 0) / NPC_SPEED;
      callback(cell, baseTime, i);
    }
  }

  function estimateDetourForcedDistance(grid, current, previous) {
    if (!previous) return 0;
    const stepX = Math.sign(previous.x - current.x);
    const stepY = Math.sign(previous.y - current.y);
    if (stepX === 0 && stepY === 0) return 0;
    let distance = 0;
    let x = current.x;
    let y = current.y;
    while (true) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (!isInsideGrid(nextX, nextY)) break;
      if (!isWalkableCell(grid, nextX, nextY)) break;
      distance++;
      x = nextX;
      y = nextY;
    }
    return distance;
  }

  function computeSpeedExposurePenalty(grid, pathInfo) {
    if (!pathInfo?.path?.length) return 0;
    const hits = [];
    const seen = new Set();
    let distance = 0;
    for (let index = 0; index < pathInfo.path.length; index++) {
      if (index > 0) distance += pathInfo.lengths[index - 1] || 0;
      const cell = pathInfo.path[index];
      if (padTypeFromCell(grid[cell.y]?.[cell.x]) !== "speed") continue;
      const signature = keyFor(cell.x, cell.y);
      if (seen.has(signature)) continue;
      seen.add(signature);
      hits.push(distance / NPC_SPEED);
    }
    let penalty = hits.length * PANEL_EFFECT_DURATION * (PANEL_FAST_MULT - 1);
    for (let index = 1; index < hits.length; index++) {
      const separation = hits[index] - hits[index - 1];
      if (separation < PANEL_EFFECT_DURATION) {
        penalty += (PANEL_EFFECT_DURATION - Math.max(0, separation)) * (PANEL_FAST_MULT - 1);
      }
    }
    return penalty;
  }

  function computePadSlowTime(grid, pathInfo) {
    if (!pathInfo?.path?.length) return 0;
    let total = 0;
    const visited = new Set();
    let distanceSoFar = 0;
    for (let i = 0; i < pathInfo.path.length; i++) {
      if (i > 0) {
        distanceSoFar += pathInfo.lengths[i - 1] || 0;
      }
      const cell = pathInfo.path[i];
      if (!isInsideGrid(cell.x, cell.y)) continue;
      const padType = padTypeFromCell(grid[cell.y]?.[cell.x]);
      if (!padType) continue;
      const key = keyFor(cell.x, cell.y);
      if (visited.has(key)) continue;
      visited.add(key);
      if (padType === "slow") {
        total += PAD_SLOW_EXTRA_TIME;
      } else if (padType === "stone") {
        total += PAD_STONE_EXTRA_TIME;
      } else if (padType === "detour") {
        const forced = estimateDetourForcedDistance(grid, cell, pathInfo.path[i - 1]);
        if (forced > 0) total += forced / NPC_SPEED;
      } else if (padType === "rewind") {
        total += distanceSoFar / NPC_SPEED;
      } else if (padType === "speed") {
        total -= PAD_SPEED_TIME_DELTA;
      }
    }
    return total;
  }

  function computeDetourDistance(grid, pathInfo) {
    if (!pathInfo?.path?.length) return 0;
    let distance = 0;
    for (let i = 0; i < pathInfo.path.length; i++) {
      const cell = pathInfo.path[i];
      const prev = pathInfo.path[i - 1];
      if (!isInsideGrid(cell.x, cell.y)) continue;
      const padType = padTypeFromCell(grid[cell.y]?.[cell.x]);
      if (padType === "detour") {
        distance += estimateDetourForcedDistance(grid, cell, prev);
      }
    }
    return distance;
  }

  function computeSlowPadProximityReward(grid, pathInfo) {
    if (!pathInfo?.path?.length) return 0;
    const slowPads = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (grid[y][x] === CELL_SLOW) slowPads.push({ x, y });
      }
    }
    if (!slowPads.length) return 0;
    let totalReward = 0;
    slowPads.forEach((pad) => {
      let minDist = Infinity;
      pathInfo.path.forEach((node) => {
        if (!isInsideGrid(node.x, node.y)) return;
        const dx = pad.x - node.x;
        const dy = pad.y - node.y;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist < minDist) minDist = dist;
      });
      const reward = 1 / (1 + minDist);
      totalReward += reward;
    });
    return totalReward / slowPads.length;
  }

  function computePathCoverage(grid, path) {
    if (!path?.length) return 0;
    let placed = 0;
    let onPath = 0;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const val = grid[y][x];
        if (val === CELL_PLAYER || val === CELL_SINGLE) placed++;
      }
    }
    const seen = new Set();
    path.forEach((node) => {
      if (!isInsideGrid(node.x, node.y)) return;
      const k = keyFor(node.x, node.y);
      if (seen.has(k)) return;
      seen.add(k);
      const val = grid[node.y]?.[node.x];
      if (val === CELL_PLAYER || val === CELL_SINGLE) onPath++;
    });
    if (!placed) return 0;
    return onPath / placed;
  }

  function computeBlockUsageScore(grid, path, baseGrid) {
    if (!path?.length || !baseGrid) return 0;
    let totalStatic = 0;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (baseGrid[y]?.[x] === CELL_STATIC) totalStatic++;
      }
    }
    if (!totalStatic) return 0;
    let used = 0;
    const seen = new Set();
    path.forEach((node) => {
      if (!isInsideGrid(node.x, node.y)) return;
      const k = keyFor(node.x, node.y);
      if (seen.has(k)) return;
      seen.add(k);
      if (baseGrid[node.y]?.[node.x] === CELL_STATIC) used++;
    });
    return used / Math.max(1, totalStatic);
  }

  function computeLightningPadPenalty(grid, pathInfo, special) {
    if (!special?.placed || special.type !== "lightning") return 0;
    let penalty = 0;
    const zapWindow = LIGHTNING_COOLDOWN + LIGHTNING_STUN;
    iteratePathSegments(pathInfo, (cell, baseTime) => {
      if (!isInsideGrid(cell.x, cell.y)) return;
      const padType = padTypeFromCell(grid[cell.y]?.[cell.x]);
      if (padType !== "slow") return;
      const center = centerOf(cell);
      const dist = Math.hypot(special.cell.x + 0.5 - center.x, special.cell.y + 0.5 - center.y);
      const overlap =
        dist <= SPECIAL_RADIUS + NPC_RADIUS
          ? Math.max(0, SPECIAL_RADIUS + NPC_RADIUS - dist) / (SPECIAL_RADIUS + NPC_RADIUS)
          : 0;
      if (overlap <= 0) return;
      const hitChance = Math.min(1, (baseTime / zapWindow) * overlap);
      const expectedStun = LIGHTNING_STUN * hitChance;
      penalty += expectedStun * 0.7;
    });
    return penalty;
  }

  function computeBeamCrossings(path, special) {
    if (!special?.placed) return 0;
    if (special.type !== "row" && special.type !== "column") return 0;
    let crossings = 0;
    let inside = false;
    path.forEach((node) => {
      if (!isInsideGrid(node.x, node.y)) return;
      const posInside = special.type === "row" ? node.y === special.cell.y : node.x === special.cell.x;
      if (posInside && !inside) crossings++;
      inside = posInside;
    });
    return crossings;
  }

  function computeLightningHits(pathInfo, special) {
    if (!special?.placed || special.type !== "lightning") return 0;
    let cooldown = 0;
    let hits = 0;
    iteratePathSegments(pathInfo, (cell, baseTime) => {
      const center = centerOf(cell);
      const dist = Math.hypot(special.cell.x + 0.5 - center.x, special.cell.y + 0.5 - center.y);
      const inside = dist <= LIGHTNING_EFFECT_RADIUS + NPC_RADIUS;
      if (inside && cooldown <= 0) {
        hits++;
        cooldown = LIGHTNING_COOLDOWN;
      }
      cooldown = Math.max(0, cooldown - baseTime);
    });
    return hits;
  }

  function computeSpecialUsageTimes(grid, pathInfo, special, neutralSpecials = []) {
    const owned = estimateTimeForSpecial(grid, pathInfo, special);
    let neutral = 0;
    if (neutralSpecials?.length) {
      neutralSpecials.forEach((ns) => {
        if (!ns?.placed || !ns.cell) return;
        neutral += estimateTimeForSpecial(grid, pathInfo, ns);
      });
    }
    const padSynergy = special?.placed ? estimateSpecialPadSynergyTime(grid, pathInfo.path, special) : 0;
    const overlap = special?.placed ? estimateSpecialOverlapTime(pathInfo.path, special, neutralSpecials) : 0;
    return { owned: owned + padSynergy + overlap, neutral };
  }

  function estimateTimeForSpecial(grid, pathInfo, special) {
    if (!special?.placed || !special.cell || !pathInfo?.path?.length) return 0;
    switch (special.type) {
      case "radius":
        return estimateRadiusSlowTime(pathInfo, special);
      case "row":
        return estimateBeamSlowTime(pathInfo, special, "row");
      case "column":
        return estimateBeamSlowTime(pathInfo, special, "column");
      case "gravity":
        return estimateGravitySlowTime(pathInfo, special);
      case "lightning":
        return estimateLightningSlowTime(pathInfo, special);
      default:
        return 0;
    }
  }

  function estimateRadiusSlowTime(pathInfo, special) {
    const decayRate = FREEZING_BUILDUP / SPECIAL_LINGER;
    let timer = 0;
    let total = 0;
    iteratePathSegments(pathInfo, (cell, baseTime) => {
      const inside = isPointInsideSpecial(centerOf(cell), special);
      if (inside) {
        timer = Math.min(FREEZING_BUILDUP, timer + baseTime);
      } else if (timer > 0) {
        timer = Math.max(0, timer - decayRate * baseTime);
      }
      if (timer > 0) {
        const ratio = Math.min(1, timer / FREEZING_BUILDUP);
        const auraMult = SPECIAL_SLOW_MULT - (SPECIAL_SLOW_MULT - FREEZING_MIN_MULT) * ratio;
        total += baseTime * (1 / auraMult - 1);
      }
    });
    return total;
  }

  function estimateBeamSlowTime(pathInfo, special, orientation) {
    let linger = 0;
    let total = 0;
    iteratePathSegments(pathInfo, (cell, baseTime) => {
      const inside = orientation === "row" ? cell.y === special.cell.y : cell.x === special.cell.x;
      if (inside) {
        linger = BEAM_LINGER_CAP;
      }
      const active = inside ? Math.min(baseTime, SPECIAL_LINGER) : Math.min(baseTime, linger);
      if (inside || linger > 0) {
        total += active * (1 / SPECIAL_SLOW_MULT - 1);
      }
      if (!inside && linger > 0) {
        linger = Math.max(0, linger - baseTime);
      }
    });
    return total;
  }

  function estimateGravitySlowTime(pathInfo, special) {
    let total = 0;
    iteratePathSegments(pathInfo, (cell, baseTime) => {
      const center = centerOf(cell);
      const dx = special.cell.x + 0.5 - center.x;
      const dy = special.cell.y + 0.5 - center.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= GRAVITY_RADIUS) {
        const target = pressureFieldMultiplier(dist);
        total += baseTime * (1 / target - 1);
      }
    });
    return total;
  }

  function estimateLightningSlowTime(pathInfo, special) {
    let cooldown = 0;
    let total = 0;
    iteratePathSegments(pathInfo, (cell, baseTime) => {
      const center = centerOf(cell);
      const dist = Math.hypot(special.cell.x + 0.5 - center.x, special.cell.y + 0.5 - center.y);
      const inside = dist <= LIGHTNING_EFFECT_RADIUS + NPC_RADIUS;
      if (inside && cooldown <= 0) {
        total += LIGHTNING_STUN;
        cooldown = LIGHTNING_COOLDOWN;
      }
      cooldown = Math.max(0, cooldown - baseTime);
    });
    return total;
  }

  function computeSlowStackTime(grid, pathInfo, special, neutralSpecials = []) {
    if (!pathInfo?.path?.length) return 0;
    let total = 0;
    iteratePathSegments(pathInfo, (cell, baseTime) => {
      if (!isInsideGrid(cell.x, cell.y)) return;
      const slows = [];
      const padType = padTypeFromCell(grid[cell.y]?.[cell.x]);
      if (padType === "slow" || padType === "stone") slows.push(1);
      const pos = centerOf(cell);
      if (special?.placed && isPointInsideSpecial(pos, special)) slows.push(1);
      neutralSpecials?.forEach((ns) => {
        if (!ns?.placed) return;
        if (isPointInsideSpecial(pos, ns)) slows.push(1);
      });
      if (slows.length >= 2) {
        total += baseTime * (slows.length - 1);
      }
    });
    return total;
  }

  function estimateSpecialPadSynergyTime(grid, path, special) {
    if (!path?.length) return 0;
    let time = 0;
    path.forEach((node) => {
      if (!isInsideGrid(node.x, node.y)) return;
      const pos = centerOf(node);
      if (!isPointInsideSpecial(pos, special)) return;
      const padType = padTypeFromCell(grid[node.y]?.[node.x]);
      if (!padType) return;
      if (padType === "slow" || padType === "stone") {
        time += SPECIAL_PAD_SYNERGY_TIME;
      } else if (padType === "detour" || padType === "rewind") {
        time += SPECIAL_PAD_SYNERGY_STRONG_TIME;
      }
    });
    return time;
  }

  function estimateSpecialOverlapTime(path, special, neutralSpecials = []) {
    if (!path?.length || !neutralSpecials?.length) return 0;
    let total = 0;
    neutralSpecials.forEach((neutral) => {
      if (!neutral?.placed || !neutral.cell) return;
      let overlap = 0;
      path.forEach((node) => {
        const pos = centerOf(node);
        if (isPointInsideSpecial(pos, special) && isPointInsideSpecial(pos, neutral)) {
          overlap++;
        }
      });
      if (overlap > 0) {
        total += overlap * SPECIAL_NEUTRAL_OVERLAP_TIME;
      }
    });
    return total;
  }

  function collectAiTimeComponents(grid, pathInfo, special, neutralSpecials = []) {
    const specialUsage = computeSpecialUsageTimes(grid, pathInfo, special, neutralSpecials);
    const padSlow = computePadSlowTime(grid, pathInfo);
    const slowTime = Math.max(0, padSlow + specialUsage.owned + specialUsage.neutral);
    const slowStackTime = computeSlowStackTime(grid, pathInfo, special, neutralSpecials);
    return {
      slowTime,
      slowStackTime,
      specialOwnedTime: specialUsage.owned,
      specialNeutralTime: specialUsage.neutral
    };
  }

  function estimatePredictedRunTime(grid, pathInfo, special, neutralSpecials = []) {
    if (!pathInfo) {
      return { time: 0, baseTime: 0, lightningPenalty: 0, components: null };
    }
    const components = collectAiTimeComponents(grid, pathInfo, special, neutralSpecials);
    const baseTime = pathInfo.totalDistance / NPC_SPEED;
    const lightningPenalty = computeLightningPadPenalty(grid, pathInfo, special);
    const predictedTime =
      baseTime + PREDICT_SLOW_SCALE * (components.slowTime + components.slowStackTime + lightningPenalty);
    return { time: predictedTime, baseTime, lightningPenalty, components };
  }

  function simulateRunnerOutcome(grid, special, neutralSpecials = [], options = {}) {
    if (!grid) return null;
    if (activeGenerationMetrics) {
      activeGenerationMetrics.simulations++;
      if (options.diagnostics !== false) activeGenerationMetrics.diagnosticSimulations++;
    }
    const simGrid = cloneGrid(grid);
    ensureOpenings(simGrid);
    const collectDiagnostics = options.diagnostics !== false;
    const runner = createRunner(
      "AI",
      simGrid,
      special ? cloneSpecial(special) : null,
      cloneNeutralSpecials(neutralSpecials),
      {
        path: options.path || options.pathInfo?.path || null,
        diagnostics: collectDiagnostics
      }
    );
    if (!runner.path.length) return null;
    const dt = FIXED_TIMESTEP;
    const maxTime = 600;
    const maxSteps = Math.ceil(maxTime / dt) + 100;
    let steps = 0;
    while (!runner.finished && steps < maxSteps) {
      advanceRunnerSimulation(runner, dt);
      steps++;
    }
    if (activeGenerationMetrics) activeGenerationMetrics.simulationSteps += steps;
    if (!runner.finished) return null;
    let triggeredPads = null;
    let diagnostics = null;
    if (collectDiagnostics) {
      triggeredPads = { speed: 0, slow: 0, detour: 0, stone: 0, rewind: 0 };
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          if (!isPadActiveCell(grid[y][x]) || isPadActiveCell(simGrid[y][x])) continue;
          const type = padTypeFromCell(grid[y][x]);
          if (type && Object.prototype.hasOwnProperty.call(triggeredPads, type)) triggeredPads[type]++;
        }
      }
      diagnostics = {
        ...runner.diagnostics,
        padEvents: runner.diagnostics.padEvents.map((event) => ({ ...event }))
      };
    }
    return {
      time: runner.resultTime ?? runner.elapsedTime ?? steps * dt,
      triggeredPads,
      diagnostics,
      path: runner.initialPath
    };
  }

  function simulateRunnerTime(grid, special, neutralSpecials = [], options = {}) {
    return simulateRunnerOutcome(grid, special, neutralSpecials, { ...options, diagnostics: false })?.time ?? null;
  }

  // Legacy reclaim/annotate helpers used only by the comparison builder.
  function reclaimAndReallocateBlocks(
    grid,
    special,
    neutralSpecials,
    placementOrder = [],
    aiWeights = AI_WEIGHT_DEFAULTS,
    baseGrid = null,
    rng = null
  ) {
    if (!grid) return { reallocated: 0, passes: 0 };
    if (!placementOrder || placementOrder.length < 8) {
      return { reallocated: 0, passes: 0 };
    }
    let reallocated = 0;
    let passes = 0;
    for (let pass = 0; pass < RECLAIM_MAX_PASSES; pass++) {
      passes++;
      const baseline = simulateRunnerTime(grid, special, neutralSpecials);
      if (baseline == null) break;
      const remaining = [];
      let reclaimedWalls = 0;
      let reclaimedSingles = 0;
      let reclaimedSpecial = false;
      let reclaimedAny = false;
      for (const entry of placementOrder) {
        if (entry.type === "special") {
          if (!special?.placed || !special.cell) continue;
          const sx = special.cell.x;
          const sy = special.cell.y;
          grid[sy][sx] = CELL_EMPTY;
          ensureOpenings(grid);
          if (!hasPath(grid)) {
            grid[sy][sx] = CELL_SPECIAL;
            continue;
          }
          const sim = simulateRunnerTime(grid, null, neutralSpecials);
          if (sim != null && baseline - sim < RECLAIM_RUNTIME_THRESHOLD) {
            special.placed = false;
            special.cell = null;
            reclaimedSpecial = true;
            reclaimedAny = true;
          } else {
            grid[sy][sx] = CELL_SPECIAL;
            remaining.push(entry);
            ensureOpenings(grid);
          }
          continue;
        }
        const x = entry.column != null ? entry.column - 1 : entry.x;
        const y = entry.row != null ? entry.row - 1 : entry.y;
        if (entry.type === "wall") {
          clearBlock(grid, x, y);
        } else {
          if (grid[y]?.[x] !== CELL_SINGLE) {
            remaining.push(entry);
            continue;
          }
          grid[y][x] = CELL_EMPTY;
        }
        ensureOpenings(grid);
        if (!hasPath(grid)) {
          restoreBlock(grid, entry);
          remaining.push(entry);
          ensureOpenings(grid);
          continue;
        }
        const sim = simulateRunnerTime(grid, special, neutralSpecials);
        if (sim != null && baseline - sim < RECLAIM_RUNTIME_THRESHOLD) {
          if (entry.type === "wall") reclaimedWalls++;
          else reclaimedSingles++;
          reclaimedAny = true;
        } else {
          restoreBlock(grid, entry);
          ensureOpenings(grid);
          remaining.push(entry);
        }
      }
      placementOrder.length = 0;
      placementOrder.push(...remaining);
      if (!reclaimedWalls && !reclaimedSingles && !reclaimedSpecial) break;

      let currentSim = simulateRunnerTime(grid, special, neutralSpecials);
      const rejectedWalls = new Set();
      const rejectedSingles = new Set();
      let attempts = reclaimedWalls + reclaimedSingles + 10;
      while ((reclaimedWalls > 0 || reclaimedSingles > 0) && attempts-- > 0) {
        const comboBudget = {
          wallsLeft: reclaimedWalls,
          singlesLeft: reclaimedSingles,
          specialHotspots: []
        };
        const placement = findBestAiPlacement(
          grid,
          evaluateGridForAi(grid, special, neutralSpecials, null, aiWeights, baseGrid),
          special,
          neutralSpecials,
          null,
          comboBudget,
          reclaimedWalls > 0,
          reclaimedSingles > 0,
          null,
          aiWeights,
          baseGrid,
          rng
        );
        if (!placement) break;
        const keyCell = keyFor(placement.x, placement.y);
        if (placement.type === "wall" && rejectedWalls.has(keyCell)) {
          attempts--;
          continue;
        }
        if (placement.type === "single" && rejectedSingles.has(keyCell)) {
          attempts--;
          continue;
        }
        const prevSim = currentSim;
        let accepted = false;
        if (placement.type === "wall" && reclaimedWalls > 0) {
          placeBlock(grid, placement.x, placement.y, CELL_PLAYER);
          ensureOpenings(grid);
          const sim = simulateRunnerTime(grid, special, neutralSpecials);
          if (sim != null && (prevSim == null || sim - prevSim >= RECLAIM_RUNTIME_THRESHOLD)) {
            placementOrder.push({ type: "wall", row: placement.y + 1, column: placement.x + 1 });
            reclaimedWalls--;
            reallocated++;
            currentSim = sim != null ? sim : prevSim;
            accepted = true;
          } else {
            clearBlock(grid, placement.x, placement.y);
            ensureOpenings(grid);
            rejectedWalls.add(keyCell);
          }
        } else if (placement.type === "single" && reclaimedSingles > 0) {
          grid[placement.y][placement.x] = CELL_SINGLE;
          ensureOpenings(grid);
          const sim = simulateRunnerTime(grid, special, neutralSpecials);
          if (sim != null && (prevSim == null || sim - prevSim >= RECLAIM_RUNTIME_THRESHOLD)) {
            placementOrder.push({ type: "single", row: placement.y + 1, column: placement.x + 1 });
            reclaimedSingles--;
            reallocated++;
            currentSim = sim != null ? sim : prevSim;
            accepted = true;
          } else {
            grid[placement.y][placement.x] = CELL_EMPTY;
            ensureOpenings(grid);
            rejectedSingles.add(keyCell);
          }
        } else {
          break;
        }
        if (!accepted) continue;
      }

      let fallbackAttempts = reclaimedWalls + reclaimedSingles + 20;
      while ((reclaimedWalls > 0 || reclaimedSingles > 0) && fallbackAttempts-- > 0) {
        const comboBudget = {
          wallsLeft: reclaimedWalls,
          singlesLeft: reclaimedSingles,
          specialHotspots: []
        };
        const placement = findBestAiPlacement(
          grid,
          evaluateGridForAi(grid, special, neutralSpecials, null, aiWeights, baseGrid),
          special,
          neutralSpecials,
          null,
          comboBudget,
          reclaimedWalls > 0,
          reclaimedSingles > 0,
          null,
          aiWeights,
          baseGrid,
          rng
        );
        if (!placement) break;
        const prevSim = currentSim;
        if (placement.type === "wall" && reclaimedWalls > 0) {
          placeBlock(grid, placement.x, placement.y, CELL_PLAYER);
          ensureOpenings(grid);
          const sim = simulateRunnerTime(grid, special, neutralSpecials);
          if (sim != null && (prevSim == null || sim - prevSim >= 0)) {
            placementOrder.push({ type: "wall", row: placement.y + 1, column: placement.x + 1 });
            reclaimedWalls--;
            reallocated++;
            currentSim = sim != null ? sim : prevSim;
          } else {
            clearBlock(grid, placement.x, placement.y);
            ensureOpenings(grid);
          }
        } else if (placement.type === "single" && reclaimedSingles > 0) {
          grid[placement.y][placement.x] = CELL_SINGLE;
          ensureOpenings(grid);
          const sim = simulateRunnerTime(grid, special, neutralSpecials);
          if (sim != null && (prevSim == null || sim - prevSim >= 0)) {
            placementOrder.push({ type: "single", row: placement.y + 1, column: placement.x + 1 });
            reclaimedSingles--;
            reallocated++;
            currentSim = sim != null ? sim : prevSim;
          } else {
            grid[placement.y][placement.x] = CELL_EMPTY;
            ensureOpenings(grid);
          }
        } else {
          break;
        }
      }
      if (reclaimedSpecial && !special.placed) {
        const hotspots = computeSpecialHotspots(grid, special, neutralSpecials, SPECIAL_HOTSPOT_LIMIT, rng || Math.random);
        placeAiSpecial(grid, special, neutralSpecials, hotspots, rng || Math.random);
        if (special?.cell) {
          placementOrder.push({
            type: "special",
            row: special.cell.y + 1,
            column: special.cell.x + 1,
            specialCell: { ...special.cell }
          });
        }
      }
      if (!reclaimedAny && !reclaimedSpecial) break;
    }
    return { reallocated, passes };
  }

  function annotatePlacementImpacts(grid, special, neutralSpecials, placementOrder = []) {
    if (!grid || !placementOrder?.length) return;
    const baseline = simulateRunnerTime(grid, special, neutralSpecials);
    if (baseline == null) return;
    placementOrder.forEach((entry) => {
      const x = entry.column != null ? entry.column - 1 : entry.x;
      const y = entry.row != null ? entry.row - 1 : entry.y;
      let sim = baseline;
      if (entry.type === "wall") {
        if (
          grid[y]?.[x] !== CELL_PLAYER ||
          grid[y + 1]?.[x] !== CELL_PLAYER ||
          grid[y]?.[x + 1] !== CELL_PLAYER ||
          grid[y + 1]?.[x + 1] !== CELL_PLAYER
        ) {
          entry.impactDelta = 0;
          return;
        }
        const testGrid = cloneGrid(grid);
        clearBlock(testGrid, x, y);
        ensureOpenings(testGrid);
        sim = simulateRunnerTime(testGrid, special, neutralSpecials);
      } else if (entry.type === "single") {
        if (grid[y]?.[x] !== CELL_SINGLE) {
          entry.impactDelta = 0;
          return;
        }
        const testGrid = cloneGrid(grid);
        testGrid[y][x] = CELL_EMPTY;
        ensureOpenings(testGrid);
        sim = simulateRunnerTime(testGrid, special, neutralSpecials);
      } else if (entry.type === "special") {
        if (!special?.placed || special.cell == null) {
          entry.impactDelta = 0;
          return;
        }
        const testGrid = cloneGrid(grid);
        const testSpecial = { ...special, cell: special.cell ? { ...special.cell } : null, placed: false };
        const sx = special.cell.x;
        const sy = special.cell.y;
        testGrid[sy][sx] = CELL_EMPTY;
        ensureOpenings(testGrid);
        sim = simulateRunnerTime(testGrid, testSpecial, neutralSpecials);
      }
      entry.impactDelta = baseline - (sim ?? baseline);
    });
    return placementOrder;
  }

  function optimizeBlockReallocation(
    grid,
    special,
    neutralSpecials,
    specialHotspots = [],
    aiWeights = AI_WEIGHT_DEFAULTS,
    baseGrid = null,
    rng = null
  ) {
    void specialHotspots;
    const baselineScore = simulateRunnerTime(grid, special, neutralSpecials);
    let weakest = null;

    const walls = listAiWallOrigins(grid);
    walls.forEach(({ x, y }) => {
      clearBlock(grid, x, y);
      ensureOpenings(grid);
      if (!hasPath(grid)) {
        placeBlock(grid, x, y, CELL_PLAYER);
        ensureOpenings(grid);
        return;
      }
      const score = simulateRunnerTime(grid, special, neutralSpecials);
      const contribution = baselineScore - score;
      if (!weakest || contribution < weakest.contribution) {
        weakest = { type: "wall", x, y, contribution };
      }
      placeBlock(grid, x, y, CELL_PLAYER);
      ensureOpenings(grid);
    });

    const singles = listAiSingleCells(grid);
    singles.forEach(({ x, y }) => {
      const prev = grid[y][x];
      grid[y][x] = CELL_EMPTY;
      ensureOpenings(grid);
      if (!hasPath(grid)) {
        grid[y][x] = prev;
        ensureOpenings(grid);
        return;
      }
      const score = simulateRunnerTime(grid, special, neutralSpecials);
      const contribution = baselineScore - score;
      if (!weakest || contribution < weakest.contribution) {
        weakest = { type: "single", x, y, contribution, prev };
      }
      grid[y][x] = prev;
      ensureOpenings(grid);
    });

    if (!weakest || weakest.contribution >= MIN_BLOCK_RECLAIM_DELTA) {
      return { changed: false, score: baselineScore };
    }

    if (weakest.type === "wall") clearBlock(grid, weakest.x, weakest.y);
    else grid[weakest.y][weakest.x] = CELL_EMPTY;
    ensureOpenings(grid);
    if (!hasPath(grid)) {
      if (weakest.type === "wall") placeBlock(grid, weakest.x, weakest.y, CELL_PLAYER);
      else grid[weakest.y][weakest.x] = weakest.prev;
      ensureOpenings(grid);
      return { changed: false, score: baselineScore };
    }

    const wallsLeft = weakest.type === "wall" ? 1 : 0;
    const singlesLeft = weakest.type === "single" ? 1 : 0;
    const placement = findBestAiPlacement(
      grid,
      baselineScore,
      special,
      neutralSpecials,
      null,
      { wallsLeft, singlesLeft, specialHotspots: [] },
      wallsLeft > 0,
      singlesLeft > 0,
      null,
      aiWeights,
      baseGrid,
      rng
    );
    if (!placement) {
      if (weakest.type === "wall") placeBlock(grid, weakest.x, weakest.y, CELL_PLAYER);
      else grid[weakest.y][weakest.x] = weakest.prev;
      ensureOpenings(grid);
      return { changed: false, score: baselineScore };
    }
    if (placement.type === "wall") placeBlock(grid, placement.x, placement.y, CELL_PLAYER);
    else grid[placement.y][placement.x] = CELL_SINGLE;
    ensureOpenings(grid);
    const newScore = simulateRunnerTime(grid, special, neutralSpecials);
    if (newScore > baselineScore) {
      return { changed: true, score: newScore };
    }
    if (placement.type === "wall") clearBlock(grid, placement.x, placement.y);
    else grid[placement.y][placement.x] = CELL_EMPTY;
    if (weakest.type === "wall") placeBlock(grid, weakest.x, weakest.y, CELL_PLAYER);
    else grid[weakest.y][weakest.x] = weakest.prev;
    ensureOpenings(grid);
    return { changed: false, score: baselineScore };
  }

  // Export
  global.AICore = {
    rulesVersion: "2.0.0",
    aiVersion: AI_VERSION,
    constants: Object.freeze({
      GRID_SIZE,
      ENTRANCE_X,
      NPC_SPEED,
      NPC_RADIUS,
      FIXED_TIMESTEP,
      PANEL_EFFECT_DURATION,
      PANEL_SLOW_MULT,
      PANEL_FAST_MULT,
      MEDUSA_SLOW_MULT,
      SPECIAL_RADIUS,
      GRAVITY_RADIUS,
      SPECIAL_LINGER,
      SPECIAL_SLOW_MULT,
      FREEZING_BUILDUP,
      FREEZING_MIN_MULT,
      LIGHTNING_STUN,
      LIGHTNING_COOLDOWN,
      LIGHTNING_EFFECT_RADIUS,
      GRAVITY_MIN_MULT,
      GRAVITY_MAX_MULT,
      GRAVITY_CURVE_EXPONENT
    }),
    cells: Object.freeze({
      EMPTY: CELL_EMPTY,
      STATIC: CELL_STATIC,
      PLAYER: CELL_PLAYER,
      SPEED: CELL_SPEED,
      SLOW: CELL_SLOW,
      SPEED_USED: CELL_SPEED_USED,
      SLOW_USED: CELL_SLOW_USED,
      SPECIAL: CELL_SPECIAL,
      DETOUR: CELL_DETOUR,
      STONE: CELL_STONE,
      REWIND: CELL_REWIND,
      DETOUR_USED: CELL_DETOUR_USED,
      STONE_USED: CELL_STONE_USED,
      REWIND_USED: CELL_REWIND_USED,
      SINGLE: CELL_SINGLE,
      STATIC_SPECIAL: CELL_STATIC_SPECIAL
    }),
    buildAiLayoutFromSnapshot,
    buildLegacyAiLayoutFromSnapshot,
    buildRouteRolloutFromSnapshot,
    buildExactTacticalRollout,
    buildTacticalBeamRollout,
    buildPadTacticalBeam,
    buildMotifBeamRollout,
    buildTacticalPortfolioRollout,
    resolveAiSearchProfile,
    createRound,
    generateBaseGrid,
    createEmptyGrid,
    createSpecialTemplate,
    createNeutralSpecial,
    pickSpecialType,
    pressureFieldMultiplier,
    advanceBuildClock,
    resetPadStates,
    createRunner,
    advanceRunnerSimulation,
    updateRunnerEffects,
    mulberry32,
    hashSeed,
    randomInt,
    cloneGrid,
    cloneSpecial,
    cloneNeutralSpecials,
    computePath,
    computePathFromCell,
    findPath,
    hasPath,
    analyzePath,
    computeSegmentLengths,
    ensureOpenings,
    isInsideGrid,
    isWalkableCell,
    canPlaceBlock,
    canPlaceSingle,
    placeBlock,
    clearBlock,
    countBlocks,
    countCells,
    isCellAvailableForSpecial,
    isPadCell,
    padTypeFromCell,
    isPointInsideSpecial,
    padIsMandatory,
    countMandatorySpeedPads,
    keyFor,
    evaluateGridForAi,
    evaluateSpecialCandidate,
    findTopAiWallCandidates,
    findTopAiSingleCandidates,
    findBestAiPlacement,
    collectSpeedPadSteerCells,
    findFallbackAiCandidates,
    generateRandomSingleCandidates,
    reduceMandatorySpeedPads,
    collectMandatorySpeedPads,
    analyzePadOpportunities,
    getDiversionCandidates,
    tryDivertSpeedPad,
    listAiWallOrigins,
    listAiSingleCells,
    estimatePredictedRunTime,
    collectAiTimeComponents,
    computeSpecialUsageTimes,
    computePadSlowTime,
    computeSpeedExposurePenalty,
    computeSlowStackTime,
    computeDetourDistance,
    computeSlowPadProximityReward,
    computePathCoverage,
    computeBlockUsageScore,
    computeLightningPadPenalty,
    computeBeamCrossings,
    computeLightningHits,
    estimateSpecialPadSynergyTime,
    estimateSpecialOverlapTime,
    simulateRunnerTime,
    simulateRunnerOutcome,
    reclaimAndReallocateBlocks,
    annotatePlacementImpacts,
    optimizeBlockReallocation
  };
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);

