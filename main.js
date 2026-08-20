const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const GRID_SIZE = 21;
const CELL_SIZE = 30;
const GRID_OFFSET_Y = CELL_SIZE;
const VIEW_WIDTH = GRID_SIZE * CELL_SIZE;
const VIEW_BORDER = CELL_SIZE;
const VIEW_HEIGHT = (GRID_SIZE + 2) * CELL_SIZE;
const VIEW_RENDER_WIDTH = VIEW_WIDTH + VIEW_BORDER * 2;
const VIEW_GAP = 0;
const CANVAS_WIDTH = VIEW_RENDER_WIDTH * 2 + VIEW_GAP;
const CANVAS_HEIGHT = VIEW_HEIGHT;
const BUILD_DURATION = 60 * 1000; // ms
const REVEAL_DURATION = 2.6;
const NPC_SPEED = 3;
const NPC_RADIUS = 0.35;
const PAD_PULSE_PERIOD = 3.5;
const ENTRANCE_X = Math.floor(GRID_SIZE / 2);
const FIXED_TIMESTEP = 1 / 120;
// Preserve real elapsed time through ordinary slow frames so the visible race
// duration matches its deterministic result on both fast and busy devices.
// A gap this large indicates that the browser/app was suspended, so it should
// not make the race jump forward when the player returns.
const SUSPENDED_FRAME_DELTA = 5;

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

const SPECIAL_TYPES = ["radius", "row", "column", "gravity", "lightning"];
const SPECIAL_RADIUS = 4;
const SPECIAL_LINGER = 3;
const FREEZING_BUILDUP = 10;
const SPECIAL_SLOW_MULT = 0.7;
const FREEZING_MIN_MULT = 0.3;
const LIGHTNING_STUN = 1.5;
const LIGHTNING_COOLDOWN = 3.25;
const PANEL_SLOW_MULT = 0.55;
const PANEL_FAST_MULT = 1.5;
const MEDUSA_SLOW_MULT = 0.3;
const PANEL_EFFECT_DURATION = 5;
const GRAVITY_RADIUS = 6;
const GRAVITY_MIN_MULT = 0.15;
const GRAVITY_MAX_MULT = 0.85;
const GRAVITY_CURVE_EXPONENT = 1.8;
const PAD_AI_SCORES = {
  speed: -3,
  slow: 3,
  detour: 4,
  stone: 3,
  rewind: 8
};
const SPECIAL_RADIUS_WEIGHT = 1.5;
const SPECIAL_BEAM_WEIGHT = 1.2;
const SPECIAL_GRAVITY_WEIGHT = 0.9;
const SPECIAL_LIGHTNING_WEIGHT = 2.5;
const AI_PATH_WEIGHT = 12;
const COMBO_POOL_LIMIT = 3;
const COMBO_LOOKAHEAD_DEPTH = 2;
const MIN_BLOCK_RECLAIM_DELTA = 0.4;
const RECLAIM_RUNTIME_THRESHOLD = 0.4;
const RECLAIM_MAX_PASSES = 1;
const PAD_SLOW_EXTRA_TIME = PANEL_EFFECT_DURATION * (1 / PANEL_SLOW_MULT - 1);
const PAD_SPEED_TIME_DELTA = PANEL_EFFECT_DURATION * (1 - 1 / PANEL_FAST_MULT);
const PAD_STONE_EXTRA_TIME = 2 * (1 / MEDUSA_SLOW_MULT - 1);
const PAD_TIME_TO_DISTANCE = NPC_SPEED;
const PREDICT_SLOW_SCALE = 0.82;
const SPECIAL_PLACEMENT_BONUS = 1.8;
const SPECIAL_HOTSPOT_LIMIT = 5;
const SPECIAL_HOTSPOT_TOLERANCE = 35;
const SPECIAL_PATH_GAIN_THRESHOLD = 10;
const SPECIAL_RADIUS_TIME_PER_TILE =
  (FREEZING_BUILDUP / 2) * (1 / ((SPECIAL_SLOW_MULT + FREEZING_MIN_MULT) / 2) - 1);
const SPECIAL_BEAM_TIME_PER_TILE = SPECIAL_LINGER * (1 / SPECIAL_SLOW_MULT - 1);
const BEAM_LINGER_CAP = 1.5;
const TOUCH_RIGHT_CLICK_DELAY = 450;
const TOUCH_MOVE_CANCEL_DISTANCE = 10;
const SPECIAL_GRAVITY_TIME_PER_TILE =
  SPECIAL_LINGER * (1 / pressureFieldMultiplier(GRAVITY_RADIUS / 2) - 1);
const SPECIAL_LIGHTNING_TIME = LIGHTNING_STUN;
const SPECIAL_PAD_SYNERGY_TIME = PANEL_EFFECT_DURATION * (1 / PANEL_SLOW_MULT - 1);
const SPECIAL_PAD_SYNERGY_STRONG_TIME = SPECIAL_PAD_SYNERGY_TIME * 1.25;
const SPECIAL_NEUTRAL_OVERLAP_TIME = SPECIAL_LINGER * (1 / SPECIAL_SLOW_MULT - 1) * 0.75;
const BENEFICIAL_PAD_TYPES = ["slow", "detour", "stone", "rewind"];
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
  beamCrossings: 2.5
};
const aiWeights = { ...AI_WEIGHT_DEFAULTS };
const LIGHTNING_EFFECT_RADIUS = 4;
const EARLY_PATH_CELLS = 35;
const SPEED_DIVERSION_RADIUS = 3;
const QUICK_REVIEW_TRIGGER = 4;
const PLACEMENT_LOOKAHEAD_COUNT = 3;
const LOOKAHEAD_BUDGET = 0;
const LOOKAHEAD_INTERVAL = 1;
const LOOKAHEAD_TRIGGER_THRESHOLD = 0.02;
const PLACEMENT_LOOKAHEAD_WEIGHT = 0.2;
let aiLookaheadBudgetOverride = null;
const {
  evaluateGridForAi: coreEvaluateGridForAi,
  evaluateSpecialCandidate: coreEvaluateSpecialCandidate,
  findTopAiWallCandidates: coreFindTopAiWallCandidates,
  findTopAiSingleCandidates: coreFindTopAiSingleCandidates,
  findBestAiPlacement: coreFindBestAiPlacement,
  collectSpeedPadSteerCells: coreCollectSpeedPadSteerCells,
  evaluateCandidateWithLookahead: coreEvaluateCandidateWithLookahead,
  findFallbackAiCandidates: coreFindFallbackAiCandidates,
  generateRandomSingleCandidates: coreGenerateRandomSingleCandidates,
  reduceMandatorySpeedPads: coreReduceMandatorySpeedPads,
  collectMandatorySpeedPads: coreCollectMandatorySpeedPads,
  getDiversionCandidates: coreGetDiversionCandidates,
  tryDivertSpeedPad: coreTryDivertSpeedPad,
  estimatePredictedRunTime: coreEstimatePredictedRunTime,
  collectAiTimeComponents: coreCollectAiTimeComponents,
  computeSpecialUsageTimes: coreComputeSpecialUsageTimes,
  computePadSlowTime: coreComputePadSlowTime,
  computeSlowStackTime: coreComputeSlowStackTime,
  computeLightningPadPenalty: coreComputeLightningPadPenalty,
  estimateSpecialPadSynergyTime: coreEstimateSpecialPadSynergyTime,
  estimateSpecialOverlapTime: coreEstimateSpecialOverlapTime,
  computeBlockUsageScore: coreComputeBlockUsageScore,
  simulateRunnerTime: coreSimulateRunnerTime,
  createRunner: coreCreateRunner,
  advanceRunnerSimulation: coreAdvanceRunnerSimulation,
  computeSegmentLengths: coreComputeSegmentLengths
} = AICore;
function makeAiSnapshot() {
  return {
    baseGrid: state.baseGrid,
    baseNeutralSpecials: state.baseNeutralSpecials,
    specialTemplate: state.specialTemplate,
    coinBudget: state.coinBudget,
    singleBudget: state.singleBudget,
    rngSeed: hashSeed(state.seed || Date.now().toString()),
    aiWeights: { ...aiWeights },
    deterministicBudget: true,
    padAwareTactics: true
  };
}
const { mulberry32, hashSeed } = AICore;
const CARDINAL_NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];
const BUILD_MODE_ORDER = ["normal", "single", "special"];
let aiWorker = null;
let aiWorkerJobCounter = 0;
let aiBuildToken = 0;
let raceStartToken = 0;
let touchHoldTimeout = null;
let touchHoldStart = null;
let touchHoldTriggered = false;
let suppressClickAfterTouch = false;

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

const PAD_VISUALS = {
  speed: {
    color: { r: 255, g: 110, b: 110 },
    idleAlpha: 0.28,
    activeAlpha: 0.62,
    baseBrightness: 0.46,
    pulseRange: 0.32,
    iconChar: "»",
    charOffset: { x: 0, y: -0.60 },
    charScale: 0.95
  },
  slow: {
    color: { r: 120, g: 170, b: 255 },
    idleAlpha: 0.3,
    activeAlpha: 0.64,
    baseBrightness: 0.48,
    pulseRange: 0.3,
    iconChar: "≈",
    charOffset: { x: 0, y: 0.6 }
  },
  detour: {
    color: { r: 70, g: 210, b: 205 },
    idleAlpha: 0.24,
    activeAlpha: 0.55,
    baseBrightness: 0.55,
    pulseRange: 0.22,
    iconChar: "↶",
    charOffset: { x: -0.4, y: 1.8 },
    charScale: 0.83
  },
  stone: {
    color: { r: 185, g: 180, b: 168 },
    idleAlpha: 0.28,
    activeAlpha: 0.54,
    baseBrightness: 0.45,
    pulseRange: 0.18,
    iconChar: "◈",
    charOffset: { x: -0.4, y: 1 }
  },
  rewind: {
    color: { r: 255, g: 210, b: 140 },
    idleAlpha: 0.26,
    activeAlpha: 0.6,
    baseBrightness: 0.52,
    pulseRange: 0.2,
    iconChar: "↺",
    charOffset: { x: -0.4, y: 0.5 },
    charScale: 0.75
  }
};

const CATALOGUE_ITEMS = [
  {
    id: "start",
    icon: "gate-start",
    name: "Start Gate (S)",
    description: "Runner spawns here and must climb straight into the maze before steering."
  },
  {
    id: "finish",
    icon: "gate-finish",
    name: "Finish Gate (F)",
    description: "Timer stops only when the runner reaches this exit."
  },
  {
    id: "seedWall",
    icon: "wall-static",
    name: "Fixed Structure (2×2)",
    description: "A pre-placed structure. It cannot be moved or removed by either builder."
  },
  {
    id: "playerWall",
    icon: "wall-player",
    name: "Wall (2×2)",
    description: "A user-placed structure that shapes how the runner moves through the maze."
  },
  {
    id: "single",
    icon: "wall-single",
    name: "Single Wall (1×1)",
    description: "A precise user-placed wall for closing gaps and creating exact choke points."
  },
  {
    id: "speedPad",
    icon: "pad-speed",
    name: "Speed Pad",
    description: () => `Increases runner speed by ${formatSpeedIncrease(PANEL_FAST_MULT)} for ${PANEL_EFFECT_DURATION}s.`
  },
  {
    id: "slowPad",
    icon: "pad-slow",
    name: "Slow Pad",
    description: () => `Slows the runner by ${formatSlowPercent(PANEL_SLOW_MULT)} for ${PANEL_EFFECT_DURATION}s.`
  },
  {
    id: "detourPad",
    icon: "pad-detour",
    name: "Detour Pad",
    description: "Reverses the runner along its current heading until a wall or boundary is reached, then reroutes."
  },
  {
    id: "stonePad",
    icon: "pad-stone",
    name: "Stone Pad",
    description: () => `Medusa effect: slows the runner by ${formatSlowPercent(MEDUSA_SLOW_MULT)} until it changes direction.`
  },
  {
    id: "rewindPad",
    icon: "pad-rewind",
    name: "Rewind Pad",
    description: "Teleports the runner to the start gate and forces a full re-path."
  },
  {
    id: "freeze",
    icon: "special-freeze",
    name: "Freezing Field",
    description: () =>
      `Slows by ${formatSlowPercent(SPECIAL_SLOW_MULT)} on entry, building to a ${formatSlowPercent(
        FREEZING_MIN_MULT
      )} slow over ${FREEZING_BUILDUP}s. Leaving clears the effect over ${SPECIAL_LINGER}s.`
  },
  {
    id: "beamRow",
    icon: "special-row",
    name: "Horizontal Slow Beam",
    description: () =>
      `Slows every runner crossing that row by ${formatSlowPercent(SPECIAL_SLOW_MULT)} for ${SPECIAL_LINGER}s.`
  },
  {
    id: "beamColumn",
    icon: "special-column",
    name: "Vertical Slow Beam",
    description: () =>
      `Slows every runner crossing that column by ${formatSlowPercent(SPECIAL_SLOW_MULT)} for ${SPECIAL_LINGER}s.`
  },
  {
    id: "gravity",
    icon: "special-gravity",
    name: "Pressure Field",
    description: () =>
      `Slows based on proximity to the tile: a ${formatSlowPercent(GRAVITY_MAX_MULT)} slow at the outer edge, ramping to an ${formatSlowPercent(
        GRAVITY_MIN_MULT
      )} slow when adjacent.`
  },
  {
    id: "lightning",
    icon: "special-lightning",
    name: "Lightning Strike",
    description: () =>
      `Zaps runners within ${SPECIAL_RADIUS} tiles, stunning them for ${LIGHTNING_STUN}s before recharging for ${LIGHTNING_COOLDOWN}s.`
  }
];

function formatSlowPercent(multiplier) {
  return `${Math.round((1 - multiplier) * 100)}%`;
}

function formatSpeedIncrease(multiplier) {
  return `${Math.round((multiplier - 1) * 100)}%`;
}

function pressureFieldMultiplier(distance) {
  const ratio = Math.max(0, Math.min(1, distance / GRAVITY_RADIUS));
  const curvedRatio = Math.pow(ratio, GRAVITY_CURVE_EXPONENT);
  return GRAVITY_MIN_MULT + (GRAVITY_MAX_MULT - GRAVITY_MIN_MULT) * curvedRatio;
}

function specialSummary(type) {
  if (type === "radius") return `Slows by ${formatSlowPercent(SPECIAL_SLOW_MULT)} on entry, building to ${formatSlowPercent(FREEZING_MIN_MULT)} while the runner remains in its field.`;
  if (type === "row") return `Slows the runner by ${formatSlowPercent(SPECIAL_SLOW_MULT)} while crossing its row, then lingers for ${SPECIAL_LINGER}s.`;
  if (type === "column") return `Slows the runner by ${formatSlowPercent(SPECIAL_SLOW_MULT)} while crossing its column, then lingers for ${SPECIAL_LINGER}s.`;
  if (type === "gravity") {
    return `Slows based on proximity to the tile: a ${formatSlowPercent(GRAVITY_MAX_MULT)} slow at the outer edge, ramping to an ${formatSlowPercent(
      GRAVITY_MIN_MULT
    )} slow when adjacent.`;
  }
  if (type === "lightning") return `Stuns for ${LIGHTNING_STUN}s inside a 4-tile radius, then recharges.`;
  return "Shape the route through this hazard to increase your runner's escape time.";
}

function padSummary(type) {
  if (type === "speed") {
    return `Increases runner speed by ${formatSpeedIncrease(PANEL_FAST_MULT)} for ${PANEL_EFFECT_DURATION}s. Active speed-pad effects stack.`;
  }
  if (type === "slow") {
    return `Slows the runner by ${formatSlowPercent(PANEL_SLOW_MULT)} for ${PANEL_EFFECT_DURATION}s. Active slow-pad effects stack.`;
  }
  if (type === "detour") {
    return "Sends the runner backwards along its current heading until a wall or boundary forces a new route.";
  }
  if (type === "stone") {
    return `Slows the runner by ${formatSlowPercent(MEDUSA_SLOW_MULT)} until it changes direction.`;
  }
  if (type === "rewind") {
    return "Returns the runner to the start gate and makes it calculate the remaining route again.";
  }
  return "A one-use pad that changes the runner's movement.";
}

function padDisplayName(type) {
  if (type === "speed") return "Speed Pad";
  if (type === "slow") return "Slow Pad";
  if (type === "detour") return "Detour Pad";
  if (type === "stone") return "Stone Pad";
  if (type === "rewind") return "Rewind Pad";
  return "Pad";
}

function specialIconName(type) {
  if (type === "radius") return "special-freeze";
  if (type === "row") return "special-row";
  if (type === "column") return "special-column";
  if (type === "gravity") return "special-gravity";
  if (type === "lightning") return "special-lightning";
  return "special-freeze";
}

function updateToolDetail() {
  if (!toolDetailTitle || !toolDetailBody) return;
  if (state.buildMode === "single") {
    toolDetailTitle.textContent = "Single block";
    toolDetailBody.textContent =
      "Place a precise 1×1 blocker. Singles are strongest when they close a diagonal gap or force one exact tile.";
  } else if (state.buildMode === "special") {
    const type = state.playerSpecial?.type;
    toolDetailTitle.textContent = getSpecialTypeName(type);
    toolDetailBody.textContent = specialSummary(type);
  } else {
    toolDetailTitle.textContent = "2×2 walls";
    toolDetailBody.textContent =
      "Place a broad 2×2 barrier. Use existing obstacles as part of your structure and right-click or long-press to refund.";
  }
}

function updateSeedIntel() {
  if (!notableList || !state.baseGrid) return;
  if (seedLabel) {
    seedLabel.textContent = state.seed || "--";
    seedLabel.title = state.seed || "";
  }
  const staticWalls = Math.floor(countCells(state.baseGrid, CELL_STATIC) / 4);
  const padCounts = [
    ["speed", countCells(state.baseGrid, CELL_SPEED)],
    ["slow", countCells(state.baseGrid, CELL_SLOW)],
    ["detour", countCells(state.baseGrid, CELL_DETOUR)],
    ["stone", countCells(state.baseGrid, CELL_STONE)],
    ["rewind", countCells(state.baseGrid, CELL_REWIND)]
  ].filter(([, count]) => count > 0);
  const neutral = state.baseNeutralSpecials?.[0] || null;
  const items = [
    {
      icon: "wall-player-2x2",
      title: `${state.coinBudget} 2×2 Wall${state.coinBudget === 1 ? "" : "s"}`,
      body: "User-placed structures that shape how the runner moves through the maze."
    },
    {
      icon: "wall-single",
      title: `${state.singleBudget} 1×1 Wall${state.singleBudget === 1 ? "" : "s"}`,
      body: "Precise user-placed walls for closing gaps and creating exact choke points."
    },
    {
      icon: "wall-static-2x2",
      title: `${staticWalls} Fixed Structure${staticWalls === 1 ? "" : "s"}`,
      body: "Pre-placed 2×2 structures that cannot be moved or removed."
    },
    {
      icon: specialIconName(state.playerSpecial?.type),
      title: `${getSpecialTypeName(state.playerSpecial?.type)} Hazard`,
      body: `Your movable hazard. ${specialSummary(state.playerSpecial?.type)}`
    }
  ];
  if (neutral) {
    items.push({
      icon: specialIconName(neutral.type),
      dimmed: true,
      title: `Fixed ${getSpecialTypeName(neutral.type)}`,
      body: `A pre-placed hazard that affects both runners and cannot be moved or removed. ${specialSummary(neutral.type)}`
    });
  }
  padCounts.forEach(([type, count]) => {
    items.push({
      icon: `pad-${type}`,
      title: `${count} ${padDisplayName(type)}${count === 1 ? "" : "s"}`,
      body: padSummary(type)
    });
  });
  notableList.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      const icon = document.createElement("canvas");
      icon.width = 42;
      icon.height = 42;
      icon.className = "notable-icon";
      icon.setAttribute("aria-hidden", "true");
      drawNotableIcon(icon, item.icon, item.dimmed);
      const copy = document.createElement("span");
      copy.className = "notable-copy";
      const title = document.createElement("strong");
      title.textContent = item.title;
      const body = document.createElement("small");
      body.textContent = item.body;
      copy.append(title, body);
      li.append(icon, copy);
      return li;
    })
  );
}

function drawNotableIcon(canvasEl, iconName, dimmed = false) {
  const iconCtx = canvasEl.getContext("2d");
  iconCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  iconCtx.fillStyle = "#050505";
  iconCtx.fillRect(0, 0, canvasEl.width, canvasEl.height);
  if (iconName === "wall-player-2x2" || iconName === "wall-static-2x2") {
    const drawTile = iconName === "wall-player-2x2" ? drawPlayerBlockSprite : drawStaticBlockSprite;
    const scale = 0.58;
    const size = CELL_SIZE * 2 * scale;
    iconCtx.save();
    iconCtx.translate((canvasEl.width - size) / 2, (canvasEl.height - size) / 2);
    iconCtx.scale(scale, scale);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) drawTile(x, y, iconCtx, 0);
    }
    iconCtx.restore();
  } else {
    drawCatalogueIcon(iconCtx, iconName);
  }
  if (dimmed) {
    iconCtx.fillStyle = "rgba(5, 9, 8, 0.52)";
    iconCtx.fillRect(0, 0, canvasEl.width, canvasEl.height);
  }
}

function updateStartRaceControl() {
  if (!startRaceBtn) return;
  const canStart = state.mode === "game" && state.building && !state.vs.active && !state.party.active;
  startRaceBtn.disabled = !canStart;
  startRaceBtn.textContent = "Start now";
}

function setCanvasPresentation(mode) {
  const raceMode = mode === "race" || mode === "solo-race";
  const dualRaceMode = mode === "race";
  const width = mode === "race" ? CANVAS_WIDTH : VIEW_RENDER_WIDTH;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== CANVAS_HEIGHT) canvas.height = CANVAS_HEIGHT;
  canvasWrapper?.classList.toggle("build-view", !dualRaceMode);
  canvasWrapper?.classList.toggle("race-view", dualRaceMode);
  document.body.classList.toggle("race-active", raceMode);
  resourceToolbar?.classList.toggle("hidden", raceMode || state.mode !== "game");
  canvas.setAttribute(
    "aria-label",
    mode === "race"
      ? "Outmaze race showing your maze and the opponent maze"
      : mode === "solo-race"
        ? "Outmaze Daily runner on your maze"
        : "Interactive Outmaze construction grid"
  );
}

function revealProgress() {
  if (!state.reveal?.active) return 1;
  return Math.max(0, Math.min(1, state.reveal.elapsed / Math.max(0.001, state.reveal.duration)));
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function announce(message) {
  if (!gameAnnouncer || !message) return;
  gameAnnouncer.textContent = "";
  requestAnimationFrame(() => {
    gameAnnouncer.textContent = message;
  });
}

function tutorialWasSeen() {
  try {
    return localStorage.getItem("outmaze-tutorial-seen") === "1";
  } catch (_) {
    return false;
  }
}

function markTutorialSeen() {
  try {
    localStorage.setItem("outmaze-tutorial-seen", "1");
  } catch (_) {}
}

function requestSinglePlayerStart() {
  if (tutorialWasSeen()) {
    startFromMenu();
  } else {
    openTutorial(true);
  }
}

function openTutorial(startsGame = false) {
  if (!tutorialOverlay) return;
  tutorialStartsGame = startsGame;
  tutorialOverlay.classList.remove("hidden");
  if (tutorialStartBtn) tutorialStartBtn.textContent = startsGame ? "Start first maze" : "Got it";
  if (state.mode === "game") state.paused = true;
  tutorialStartBtn?.focus();
}

function closeTutorial() {
  if (!tutorialOverlay) return;
  tutorialOverlay.classList.add("hidden");
  tutorialStartsGame = false;
  if (state.mode === "game" && pauseOverlay?.classList.contains("hidden")) state.paused = false;
}

function completeTutorial() {
  const shouldStart = tutorialStartsGame;
  markTutorialSeen();
  closeTutorial();
  if (shouldStart) startFromMenu();
}

function requestStartRace() {
  if (!state.building || state.vs.active || state.party.active) return;
  announce("Maze locked. Preparing the reveal.");
  startRace();
}

function isTypingTarget(target) {
  const tag = target?.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || target?.isContentEditable;
}

function eventForGridCell(cell) {
  const rect = canvas.getBoundingClientRect();
  const logicalX = VIEW_BORDER + (cell.x + 0.5) * CELL_SIZE;
  const logicalY = GRID_OFFSET_Y + (cell.y + 0.5) * CELL_SIZE;
  return {
    clientX: rect.left + (logicalX / canvas.width) * rect.width,
    clientY: rect.top + (logicalY / canvas.height) * rect.height,
    preventDefault() {}
  };
}

function handleCanvasKeyDown(evt) {
  if (!state.building) return;
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[evt.key]) {
    evt.preventDefault();
    const [dx, dy] = arrows[evt.key];
    const current = state.hoverCell || { x: ENTRANCE_X, y: GRID_SIZE - 2 };
    state.hoverCell = {
      x: Math.max(0, Math.min(GRID_SIZE - 1, current.x + dx)),
      y: Math.max(0, Math.min(GRID_SIZE - 1, current.y + dy))
    };
    return;
  }
  if ((evt.key === "Enter" || evt.key === " ") && state.hoverCell) {
    evt.preventDefault();
    handleCanvasClick(eventForGridCell(state.hoverCell));
    return;
  }
  if ((evt.key === "Delete" || evt.key === "Backspace") && state.hoverCell) {
    evt.preventDefault();
    handleRightClick(eventForGridCell(state.hoverCell));
  }
}

canvas.width = VIEW_RENDER_WIDTH;
canvas.height = CANVAS_HEIGHT;

const seedInput = document.getElementById("seedInput");
const newGameBtn = document.getElementById("newGame");
const randomSeedBtn = document.getElementById("randomSeed");
const setSeedBtn = document.getElementById("setSeed");
const editRetryBtn = document.getElementById("editRetry");
const timerEl = document.getElementById("timer");
const timerStatusEl = document.getElementById("timerStatus");
const statusBoard = document.getElementById("statusBoard");
const wallsCard = document.getElementById("wallsCard");
const singleCard = document.getElementById("singleCard");
const specialCard = document.getElementById("specialCard");
const wallsValueEl = document.getElementById("wallsValue");
const singleValueEl = document.getElementById("singleValue");
const specialValueEl = document.getElementById("specialValue");
const specialPreviewCanvas = document.getElementById("specialPreview");
const specialPreviewCtx = specialPreviewCanvas?.getContext("2d");
const scoreEl = document.getElementById("score");
const phaseEl = document.getElementById("phase");
const specialInfoEl = document.getElementById("specialInfo");
const phaseHintEl = document.getElementById("phaseHint");
const menuOverlay = document.getElementById("menuOverlay");
const pauseOverlay = document.getElementById("pauseOverlay");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingText = document.getElementById("loadingText");
const hud = document.getElementById("gameHud");
const menuSingleBtn = document.getElementById("menuSingle");
const menuHowToBtn = document.getElementById("menuHowTo");
const resumeBtn = document.getElementById("resumeBtn");
const pauseMenuBtn = document.getElementById("pauseMenuBtn");
const menuButton = document.getElementById("menuButton");
const catalogueButton = document.getElementById("catalogueButton");
const catalogueOverlay = document.getElementById("catalogueOverlay");
const closeCatalogueBtn = document.getElementById("closeCatalogue");
const catalogueListEl = document.getElementById("catalogueList");
const gameHeader = document.getElementById("gameHeader");
const gameBody = document.getElementById("gameBody");
const resourceToolbar = document.getElementById("resourceToolbar");
const canvasWrapper = document.getElementById("canvasWrapper");
const revealBanner = document.getElementById("revealBanner");
const startRaceBtn = document.getElementById("startRace");
const specialCardName = document.getElementById("specialCardName");
const specialCardEffect = document.getElementById("specialCardEffect");
const toolDetailTitle = document.getElementById("toolDetailTitle");
const toolDetailBody = document.getElementById("toolDetailBody");
const notableList = document.getElementById("notableList");
const seedLabel = document.getElementById("seedLabel");
const tutorialOverlay = document.getElementById("tutorialOverlay");
const closeTutorialBtn = document.getElementById("closeTutorial");
const tutorialStartBtn = document.getElementById("tutorialStart");
const helpButton = document.getElementById("helpButton");
const brandHome = document.getElementById("brandHome");
const gameAnnouncer = document.getElementById("gameAnnouncer");
const resultPopup = document.getElementById("resultPopup");
const resultCard = resultPopup?.querySelector(".result-card");
const popupMessageEl = document.getElementById("popupMessage");
const popupEmojiEl = document.getElementById("popupEmoji");
const popupEyebrowEl = document.getElementById("popupEyebrow");
const popupCloseBtn = document.getElementById("closePopup");
const shareResultBtn = document.getElementById("shareResult");
let currentPopupMode = null;
const menuVsBtn = document.getElementById("menuVs");
const vsPanel = document.getElementById("vsPanel");
const vsPanelTitle = document.getElementById("vsPanelTitle");
const vsCreateBtn = document.getElementById("vsCreate");
const vsJoinBtn = document.getElementById("vsJoin");
const vsRoomInput = document.getElementById("vsRoomInput");
const vsRoomField = vsRoomInput?.closest(".vs-room-field");
const vsDivider = vsPanel?.querySelector(".vs-divider");
const vsReadyBtn = document.getElementById("vsReadyBtn");
const vsCopyRoomBtn = document.getElementById("vsCopyRoom");
const vsRoomCodeEl = document.getElementById("vsRoomCode");
const vsSeedBadge = document.getElementById("vsSeedBadge");
const vsSeedCode = document.getElementById("vsSeedCode");
const vsLobbyActions = document.getElementById("vsLobbyActions");
const vsMatchActions = document.getElementById("vsMatchActions");
const vsRematchActions = document.getElementById("vsRematchActions");
const vsLeaveBtn = document.getElementById("vsLeave");
const vsStatusEl = document.getElementById("vsStatus");
const vsTryAgainBtn = document.getElementById("vsTryAgain");
const vsNewGameBtn = document.getElementById("vsNewGame");
const vsTryAgainDetail = document.getElementById("vsTryAgainDetail");
const vsNewGameDetail = document.getElementById("vsNewGameDetail");
const vsChoiceStatus = document.getElementById("vsChoiceStatus");
const vsEarlyStartBtn = document.getElementById("vsEarlyStartBtn");
const vsPlayerStates = document.getElementById("vsPlayerStates");
const vsSelfState = document.getElementById("vsSelfState");
const vsPeerState = document.getElementById("vsPeerState");
const vsSelfStateLabel = document.getElementById("vsSelfStateLabel");
const vsPeerStateLabel = document.getElementById("vsPeerStateLabel");
const vsSelfStateText = document.getElementById("vsSelfStateText");
const vsPeerStateText = document.getElementById("vsPeerStateText");
const seedControls = [
  document.querySelector(".seed-field"),
  document.getElementById("setSeed"),
  document.getElementById("randomSeed"),
  document.getElementById("newGame"),
  document.getElementById("editRetry")
];
const vsUiControls = [vsPanel];
function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

const state = {
  rng: mulberry32(1),
  seed: "",
  building: true,
  buildTimeLeft: 0,
  coins: 0,
  coinBudget: 0,
  singleBlocks: 0,
  singleBudget: 0,
  playerBlocks: [],
  playerSingles: [],
  playerGrid: createEmptyGrid(),
  baseGrid: null,
  baseStaticCount: 0,
  aiGrid: null,
  aiWalls: [],
  aiSingles: [],
  aiPlacementOrder: [],
  aiProfile: null,
  aiProfileSource: null,
  aiBuildPromise: null,
  aiJobId: 0,
  aiPendingSeed: "",
  hoverCell: null,
  floatingTexts: [],
  buildMode: "normal",
  specialTemplate: null,
  playerSpecial: null,
  aiSpecial: null,
  baseNeutralSpecials: [],
  neutralSpecials: [],
  race: null,
  reveal: null,
  results: { player: null, ai: null, winner: null },
  performance: { generationMs: 0, aiBuildMs: 0, simulationMs: 0 },
  mode: "menu",
  paused: false,
  waitingForSpecial: false,
  catalogueOpen: false,
  vs: {
    active: false,
    room: null,
    connected: false,
    ready: false,
    players: 0,
    readyCount: 0,
    members: [],
    phase: "disconnected",
    roundId: null,
    mazeSubmitted: false,
    locked: false,
    startsAt: null,
    timerId: null,
    opponentMaze: null,
    role: null,
    selfLabel: "You",
    oppLabel: "Opponent",
    selfShort: "You",
    oppShort: "P2",
    buildStartsAt: null,
    buildEndsAt: null,
    waitingForStart: false,
    choiceSelf: null,
    choicePeer: null,
    lastSeed: "",
    rematchMode: null,
    earlyStartSelf: false,
    earlyStartPeer: false,
    earlyStartTriggered: false
  },
  party: {
    active: false,
    room: null,
    phase: "idle",
    roundId: null,
    round: 0,
    rounds: 3,
    buildEndsAt: null,
    locked: false,
    preparing: false,
    submitted: false,
    members: [],
    results: null,
    liveScores: null,
    nextRoundAt: null
  },
  daily: {
    active: false,
    challenge: null,
    submitting: false,
    attemptComplete: false
  }
};
let padPulseTimer = 0;
let cataloguePrevPaused = false;
let tutorialStartsGame = false;

function generateSeedString() {
  return Math.floor(Math.random() * 1e9).toString();
}

seedInput.value = generateSeedString();
setupListeners();
prewarmAiWorker();
showMainMenu();
let lastFrame = performance.now();
let accumulator = 0;
requestAnimationFrame(loop);

function setupListeners() {
  newGameBtn.addEventListener("click", () => startGame(seedInput.value.trim()));
  randomSeedBtn.addEventListener("click", () => {
    seedInput.value = generateSeedString();
    startGame(seedInput.value);
  });
  setSeedBtn.addEventListener("click", () => {
    let value = seedInput.value.trim();
    if (!value) {
      value = generateSeedString();
      seedInput.value = value;
    }
    startGame(value);
  });
  editRetryBtn?.addEventListener("click", editAndRetry);
  wallsCard?.addEventListener("click", () => {
    if (!state.building || state.coins <= 0) return;
    setBuildMode("normal");
  });
  specialCard?.addEventListener("click", () => {
    if (!state.building || state.playerSpecial.placed) return;
    setBuildMode("special");
  });
  singleCard?.addEventListener("click", () => {
    if (!state.building || state.singleBlocks <= 0) return;
    setBuildMode("single");
  });
  canvas.addEventListener("click", handleCanvasClick);
  canvas.addEventListener("contextmenu", handleRightClick);
  canvas.addEventListener("touchstart", handleTouchStart, { passive: false });
  canvas.addEventListener("touchmove", handleTouchMove, { passive: false });
  canvas.addEventListener("touchend", handleTouchEnd);
  canvas.addEventListener("touchcancel", handleTouchEnd);
  canvas.addEventListener("mousemove", handleMouseMove);
  canvas.addEventListener("mouseleave", () => (state.hoverCell = null));
  canvas.addEventListener("keydown", handleCanvasKeyDown);
  popupCloseBtn.addEventListener("click", hidePopup);
  menuSingleBtn.addEventListener("click", requestSinglePlayerStart);
  menuVsBtn?.addEventListener("click", startVsFromMenu);
  menuHowToBtn?.addEventListener("click", () => openTutorial(false));
  helpButton?.addEventListener("click", () => openTutorial(false));
  closeTutorialBtn?.addEventListener("click", closeTutorial);
  tutorialStartBtn?.addEventListener("click", completeTutorial);
  startRaceBtn?.addEventListener("click", requestStartRace);
  brandHome?.addEventListener("click", (evt) => {
    evt.preventDefault();
    if (state.vs.active) {
      const ok = window.confirm("Leaving will exit the room. Continue?");
      if (!ok) return;
      leaveVsMode();
    }
    showMainMenu();
  });
  menuButton.addEventListener("click", () => {
    if (state.vs.active) {
      const ok = window.confirm("Leaving will exit the lobby. Continue?");
      if (!ok) return;
      leaveVsMode();
    }
    showMainMenu();
  });
  resumeBtn.addEventListener("click", resumeGame);
  pauseMenuBtn.addEventListener("click", () => {
    showMainMenu();
    hidePause();
  });
  catalogueButton?.addEventListener("click", openCatalogue);
  closeCatalogueBtn?.addEventListener("click", closeCatalogue);
  catalogueOverlay?.addEventListener("click", (evt) => {
    if (evt.target === catalogueOverlay) closeCatalogue();
  });
  shareResultBtn?.addEventListener("click", handleShareResult);
  setShareButtonVisible(false);
  vsCreateBtn?.addEventListener("click", () => connectVs("create"));
  vsJoinBtn?.addEventListener("click", () => connectVs("join", vsRoomInput?.value?.trim()));
  vsReadyBtn?.addEventListener("click", () => sendVsReady());
  vsCopyRoomBtn?.addEventListener("click", copyVsRoomCode);
  vsEarlyStartBtn?.addEventListener("click", toggleEarlyStartVote);
  vsLeaveBtn?.addEventListener("click", () => {
    leaveVsMode();
    showMainMenu();
  });
  vsRoomInput?.addEventListener("input", () => {
    vsRoomInput.value = vsRoomInput.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 5);
  });
  vsRoomInput?.addEventListener("keydown", (evt) => {
    if (evt.key !== "Enter") return;
    evt.preventDefault();
    connectVs("join", vsRoomInput.value);
  });
  vsTryAgainBtn?.addEventListener("click", () => setVsChoice("same"));
  vsNewGameBtn?.addEventListener("click", () => setVsChoice("new"));
  document.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && tutorialOverlay && !tutorialOverlay.classList.contains("hidden")) {
      closeTutorial();
      return;
    }
    if (evt.key === "Escape" && state.catalogueOpen) {
      closeCatalogue();
      return;
    }
    if (evt.key === "Escape" && state.mode === "game") {
      if (state.vs.active) return;
      if (state.paused) resumeGame();
      else showPause();
    }
    if (state.mode === "game" && state.building && !isTypingTarget(evt.target)) {
      if (evt.key === "1") setBuildMode("normal");
      else if (evt.key === "2") setBuildMode("single");
      else if (evt.key === "3") setBuildMode("special");
    }
  });
}

function startGame(seedText) {
  raceStartToken++;
  applyVsVisibility(state.vs.active);
  resetVsEarlyStartVotes();
  const safeSeed = seedText?.trim() || generateSeedString();
  const previousSeed = state.seed;
  const sameSeed = safeSeed === previousSeed;
  if (!sameSeed) {
    cancelAiBuild({ terminateWorker: true });
  }
  state.seed = safeSeed;
  seedInput.value = safeSeed;
  const round = AICore.createRound(safeSeed);
  state.rng = round.rng;
  closeCatalogue();

  state.baseGrid = round.baseGrid;
  state.baseStaticCount = countCells(state.baseGrid, CELL_STATIC);
  state.baseNeutralSpecials = round.neutralSpecial ? [round.neutralSpecial] : [];
  state.neutralSpecials = state.baseNeutralSpecials.map(cloneSpecial);
  state.playerGrid = cloneGrid(state.baseGrid);
  if (!sameSeed) {
    state.aiGrid = null;
    state.aiSpecial = null;
    state.aiBuildPromise = null;
    state.aiJobId = 0;
    state.aiProfile = null;
    state.aiProfileSource = null;
    state.aiLookaheadUsed = 0;
    state.aiPlacementOrder = [];
  } else {
    resetPadStates(state.aiGrid);
    if (state.aiSpecial) {
      state.aiSpecial.effectTimer = 0;
      state.aiSpecial.cooldown = 0;
      state.aiSpecial.flashTimer = 0;
    }
  }
  state.aiWalls = [];
  state.aiSingles = [];
  state.vs.opponentMaze = null;
  state.vs.startsAt = null;
  state.coins = round.coinBudget;
  state.coinBudget = state.coins;
  const singleCount = round.singleBudget;
  state.singleBlocks = singleCount;
  state.singleBudget = singleCount;
  state.playerBlocks = [];
  state.playerSingles = [];
  const specialType = round.specialTemplate.type;
  state.specialTemplate = cloneSpecial(round.specialTemplate);
  state.playerSpecial = cloneSpecial(round.specialTemplate);
  state.performance = { generationMs: round.metrics.generationMs, aiBuildMs: 0, simulationMs: 0 };
  state.building = true;
  state.buildMode = "normal";
  state.buildTimeLeft = BUILD_DURATION / 1000;
  state.hoverCell = null;
  state.floatingTexts = [];
  state.race = null;
  state.reveal = null;
  state.results = {
    player: null,
    ai: state.daily.active ? Number(state.daily.challenge?.aiTime || 0) : null,
    winner: null
  };
  state.waitingForSpecial = false;
  setBuildMode("normal");
  updateSpecialInfo();
  const phaseHint = state.vs.active
    ? "Keep your runner trapped longer than your opponent."
    : state.party.active
      ? "Build privately; every party member is shaping the same seed."
      : state.daily.active
        ? `Try to beat today’s ${Number(state.daily.challenge?.aiTime || 0).toFixed(2)}s AI benchmark.`
        : "Keep your runner trapped longer than the AI.";
  updatePhaseLabel(
    "Build your maze",
    phaseHint
  );
  hidePopup();
  state.mode = "game";
  state.paused = false;
  hud.classList.remove("hidden");
  canvas.classList.remove("vs-waiting");
  setCanvasPresentation("build");
  updateSeedIntel();
  updateStartRaceControl();
  announce(`Seed ${safeSeed}. ${state.coinBudget} walls, ${state.singleBudget} single wall${state.singleBudget === 1 ? "" : "s"}, and a ${getSpecialTypeName(specialType)} hazard.`);
  const needsAiOpponent = !state.vs.active && !state.party.active && !state.daily.active;
  setSeedUiVisible(needsAiOpponent);
  setVsUiVisible(state.vs.active);
  // Kick off AI generation only for the ordinary single-player opponent.
  if (needsAiOpponent) {
    if (!sameSeed) {
      state.aiPendingSeed = safeSeed;
      const buildToken = ++aiBuildToken;
      state.aiBuildPromise = buildAiLayoutViaWorker()
        .catch((err) => {
          console.warn("AI worker failed; falling back to main thread", err);
          return buildAiLayoutAsync();
        })
        .then((aiLayout) => {
          if (buildToken !== aiBuildToken) return null;
          if (!aiLayout) return null;
          state.aiGrid = aiLayout.grid;
          state.aiSpecial = aiLayout.special;
          state.aiLookaheadUsed = aiLayout.lookaheadUsed || 0;
          state.aiPlacementOrder = aiLayout.placementOrder || [];
          state.aiProfile = aiLayout.profile || null;
          state.performance.aiBuildMs = Number(aiLayout.profile?.totalMs || 0);
          return {
            ...aiLayout,
            branchId: aiLayout.branchId ?? aiLayout.branch,
            branchTotal: aiLayout.branchTotal ?? null
          };
        })
        .finally(() => {
          if (buildToken !== aiBuildToken) return;
        });
    }
  } else {
    state.aiBuildPromise = null;
    state.aiGrid = null;
    state.aiSpecial = null;
  }
}

function connectVs(mode, roomCode = "") {
  state.vs.active = true;
  vsPanel?.classList.remove("hidden");
  applyVsVisibility(true);
  vsConnect(handleVsEvent);
  if (mode === "create") {
    updateVsStatus("Creating a private room…");
    vsCreateRoom();
  } else if (mode === "join") {
    const normalized = String(roomCode || "")
      .trim()
      .toUpperCase();
    if (normalized.length !== 5) {
      updateVsStatus("Enter the five-character room code.");
      return;
    }
    updateVsStatus(`Joining room ${normalized}…`);
    vsJoinRoom(normalized);
  } else if (!state.vs.connected) {
    updateVsStatus("Connecting to the Outmaze server…");
  }
  updateVsPanelState();
}

function sendVsReady() {
  if (!state.vs.room) return;
  state.vs.ready = true;
  vsReady(state.vs.room);
  updateVsStatus("Ready. Waiting for your opponent…");
  updateVsPanelState();
}

function updateVsMemberLabels(members = []) {
  if (!Array.isArray(members)) return;
  state.vs.members = members;
  const ownUid = window.OutmazeAccount?.profile?.uid;
  const self = members.find((member) => member.uid === ownUid) || members.find((member) => member.slot === (state.vs.role === "guest" ? 2 : 1));
  const peer = members.find((member) => member !== self);
  if (self) {
    state.vs.selfLabel = `You · ${self.emoji} ${self.name}`;
    state.vs.selfShort = `${self.emoji} ${self.name}`;
  }
  if (peer) {
    state.vs.oppLabel = `${peer.emoji} ${peer.name}`;
    state.vs.oppShort = `${peer.emoji} ${peer.name}`;
  } else {
    state.vs.oppLabel = "Opponent";
    state.vs.oppShort = "Opponent";
  }
}

function handleVsEvent(evt) {
  if (state.party.active && ["connected", "disconnected", "error", "profile-required"].includes(evt.type)) {
    window.OutmazeOnline?.handleServerEvent?.(evt);
    return;
  }
  if (String(evt.type || "").startsWith("party-")) {
    window.OutmazeOnline?.handleServerEvent?.(evt);
    return;
  }
  if (evt.type === "connected") {
    state.vs.connected = true;
    state.vs.phase = state.vs.room ? "lobby" : "connected";
    if (!state.vs.room) updateVsStatus("Connected. Create a room or enter a friend's code.");
    setVsWaitingTimer();
    updateVsPanelState();
    return;
  }
  if (evt.type === "disconnected") {
    state.vs.connected = false;
    state.vs.phase = "disconnected";
    stopVsCountdown();
    updateVsStatus(
      evt.reason === "idle-timeout"
        ? "This room closed after 10 minutes without activity. Return to the menu to create or join another."
        : evt.reason === "authentication-timeout"
          ? "The connection closed because sign-in did not finish in time. Return to the menu and try again."
          : "Disconnected from the Outmaze server. Leave and reopen multiplayer to reconnect."
    );
    resetVsEarlyStartVotes();
    updateVsPanelState();
    return;
  }
  if (evt.type === "created") {
    state.vs.room = evt.room;
    state.vs.phase = "lobby";
    state.vs.players = 1;
    state.vs.ready = false;
    state.vs.readyCount = 0;
    updateVsStatus(`Room ${evt.room} created. Share the code with your opponent.`);
    if (vsRoomInput) vsRoomInput.value = evt.room;
    setVsWaitingTimer();
    state.vs.role = "host";
    state.vs.selfLabel = "You";
    state.vs.oppLabel = "Opponent";
    state.vs.selfShort = "P1";
    state.vs.oppShort = "P2";
    updateVsPanelState();
    return;
  }
  if (evt.type === "joined") {
    state.vs.room = evt.room;
    state.vs.phase = "lobby";
    state.vs.players = 2;
    state.vs.ready = false;
    state.vs.readyCount = 0;
    updateVsStatus(`Joined room ${evt.room}. Ready up when you're set.`);
    setVsWaitingTimer();
    state.vs.role = "guest";
    state.vs.selfLabel = "You";
    state.vs.oppLabel = "Opponent";
    state.vs.selfShort = "P2";
    state.vs.oppShort = "P1";
    updateVsPanelState();
    return;
  }
  if (evt.type === "peer-joined") {
    state.vs.players = 2;
    updateVsStatus("Your opponent joined. Both players can ready up.");
    setVsWaitingTimer();
    updateVsPanelState();
    return;
  }
  if (evt.type === "peer-left") {
    raceStartToken++;
    stopVsCountdown();
    state.building = false;
    state.race = null;
    state.reveal = null;
    revealBanner?.classList.add("hidden");
    setCanvasPresentation("build");
    canvas.classList.add("vs-waiting");
    state.vs.phase = "lobby";
    state.vs.players = 1;
    state.vs.ready = false;
    state.vs.readyCount = 0;
    state.vs.waitingForStart = true;
    state.vs.opponentMaze = null;
    state.vs.mazeSubmitted = false;
    state.vs.locked = false;
    resetVsEarlyStartVotes();
    updatePhaseLabel("Opponent disconnected", "The room is still open. Share the code with another player.");
    updateVsStatus("Your opponent left. The room is still open for another player.");
    updateVsPanelState();
    return;
  }
  if (evt.type === "room-state") {
    state.vs.players = Number(evt.players || 0);
    state.vs.readyCount = Number(evt.ready || 0);
    state.vs.phase = evt.phase || state.vs.phase;
    updateVsMemberLabels(evt.members);
    if (state.vs.phase === "lobby" && state.vs.players === 2 && !state.vs.ready) {
      updateVsStatus("Both players are here. Press Ready when you're set.");
    }
    updateVsPanelState();
    return;
  }
  if (evt.type === "start") {
    const useSeed = evt.seed || Date.now().toString();
    const reuseMaze = Boolean(evt.reuseMaze && state.seed === useSeed && state.playerGrid);
    state.vs.rematchMode = reuseMaze ? "same" : "new";
    state.vs.choiceSelf = null;
    state.vs.choicePeer = null;
    state.vs.roundId = evt.roundId;
    state.vs.mazeSubmitted = false;
    state.vs.locked = false;
    state.vs.opponentMaze = null;
    state.vs.phase = "building";
    state.vs.ready = false;
    state.vs.readyCount = 0;
    state.vs.lastSeed = useSeed;
    resetVsEarlyStartVotes();
    if (reuseMaze) {
      editAndRetry();
    } else {
      startGame(useSeed);
    }
    state.vs.startsAt = evt.startsAt;
    state.vs.buildStartsAt = evt.startsAt;
    state.vs.buildEndsAt = evt.buildEndsAt || evt.startsAt + (evt.buildSeconds || 60) * 1000;
    state.vs.waitingForStart = false;
    canvas.classList.remove("vs-waiting");
    startVsCountdown(state.vs.buildStartsAt, state.vs.buildEndsAt);
    updatePhaseLabel(
      reuseMaze ? "Refine your maze" : "Build your maze",
      "Your design stays private until both mazes are locked."
    );
    updateVsStatus("Build in private. Both players have the same seed and deadline.");
    updateVsPanelState();
    return;
  }
  if (evt.type === "lock" && evt.roundId === state.vs.roundId) {
    lockAndSubmitVsMaze(evt.reason);
    return;
  }
  if (evt.type === "maze-accepted" && evt.roundId === state.vs.roundId) {
    updateVsStatus(
      evt.submitted >= evt.required ? "Both mazes received. Preparing the reveal…" : "Maze received. Waiting for your opponent…"
    );
    updateVsPanelState();
    return;
  }
  if (evt.type === "reveal" && evt.roundId === state.vs.roundId) {
    state.vs.opponentMaze = evt.payload;
    state.vs.phase = "racing";
    updateVsStatus("Both mazes received. Revealing your opponent…");
    maybeStartVsRace();
    return;
  }
  if (evt.type === "early-start-state" && evt.roundId === state.vs.roundId) {
    state.vs.earlyStartSelf = Boolean(evt.self);
    state.vs.earlyStartPeer = Boolean(evt.peer);
    updateEarlyStartControls();
    return;
  }
  if (evt.type === "rematch-state") {
    state.vs.choiceSelf = evt.self || null;
    state.vs.choicePeer = evt.peer || null;
    updateVsChoiceStatus();
    updateVsPanelState();
    return;
  }
  if (evt.type === "error") {
    if (evt.code === "room-not-found") state.vs.room = null;
    updateVsStatus(evt.error || "The multiplayer server rejected that request.");
    updateVsPanelState();
    return;
  }
}

function updateVsStatus(text) {
  if (vsStatusEl) vsStatusEl.textContent = text;
}

function updateVsPanelState() {
  const inRoom = Boolean(state.vs.room);
  const lobby = inRoom && state.vs.phase === "lobby";
  const building = inRoom && state.vs.phase === "building";
  const racing = inRoom && state.vs.phase === "racing";
  const raceComplete = racing && Boolean(state.race?.finished);
  const showRematch = racing;
  vsPanel?.classList.toggle("hidden", !state.vs.active);
  if (state.vs.active) {
    resourceToolbar?.classList.toggle("hidden", !building || state.vs.mazeSubmitted);
    gameBody?.classList.toggle("hidden", !building && !state.race);
  }
  vsCopyRoomBtn?.classList.toggle("hidden", !inRoom);
  vsLeaveBtn?.classList.toggle("hidden", !inRoom);
  if (vsRoomCodeEl) vsRoomCodeEl.textContent = state.vs.room || "-----";
  const showSeed = inRoom && Boolean(state.seed);
  vsSeedBadge?.classList.toggle("hidden", !showSeed);
  if (vsSeedCode) {
    vsSeedCode.textContent = state.seed || "--";
    vsSeedCode.title = state.seed || "";
  }
  vsLobbyActions?.classList.toggle("hidden", inRoom && !lobby);
  vsCreateBtn?.classList.toggle("hidden", inRoom);
  vsJoinBtn?.classList.toggle("hidden", inRoom);
  vsRoomField?.classList.toggle("hidden", inRoom);
  vsDivider?.classList.toggle("hidden", inRoom);
  vsReadyBtn?.classList.toggle("hidden", !lobby);
  if (vsReadyBtn) {
    vsReadyBtn.disabled = state.vs.ready;
    vsReadyBtn.textContent = state.vs.ready ? "Ready" : "Ready up";
    vsReadyBtn.classList.toggle("is-selected", state.vs.ready);
    vsReadyBtn.setAttribute("aria-pressed", String(state.vs.ready));
  }
  vsMatchActions?.classList.toggle("hidden", !building || state.vs.mazeSubmitted);
  vsRematchActions?.classList.toggle("hidden", !showRematch);
  vsRematchActions?.setAttribute(
    "aria-label",
    raceComplete ? "Choose the next round" : "Stop the current race and choose what comes next"
  );

  if (vsPanelTitle) {
    if (!state.vs.connected) vsPanelTitle.textContent = "Connecting to multiplayer";
    else if (!inRoom) vsPanelTitle.textContent = "Create or join a private room";
    else if (lobby && state.vs.players < 2) vsPanelTitle.textContent = "Waiting for an opponent";
    else if (lobby) vsPanelTitle.textContent = "Both players are here";
    else if (building && state.vs.mazeSubmitted) vsPanelTitle.textContent = "Maze locked";
    else if (building) vsPanelTitle.textContent = "Build in private";
    else if (raceComplete) vsPanelTitle.textContent = "Choose the next round";
    else if (racing) vsPanelTitle.textContent = "Race in progress";
    else vsPanelTitle.textContent = "Opponent maze revealed";
  }
  updateEarlyStartControls();
  updateVsChoiceStatus();
  updateVsPlayerStates();
}

function stopVsCountdown() {
  if (!state.vs.timerId) return;
  clearInterval(state.vs.timerId);
  state.vs.timerId = null;
}

function startVsCountdown(startsAt, buildEndsAt) {
  stopVsCountdown();
  state.vs.buildStartsAt = startsAt;
  state.vs.buildEndsAt = buildEndsAt;
  state.vs.waitingForStart = false;
  const tick = () => {
    const remaining = Math.max(0, (buildEndsAt - Date.now()) / 1000);
    state.buildTimeLeft = remaining;
    if (remaining <= 0) {
      stopVsCountdown();
      lockPlayerBuild();
      updatePhaseLabel("Maze locked", "Sending both private mazes to the reveal.");
      return false;
    }
    return true;
  };
  if (tick()) state.vs.timerId = setInterval(tick, 200);
}

function lockPlayerBuild() {
  state.building = false;
}

function sendVsMaze() {
  if (!state.vs.room || state.vs.mazeSubmitted || state.vs.roundId == null) return;
  state.vs.mazeSubmitted = true;
  state.vs.lastSeed = state.seed;
  const payload = {
    grid: cloneGrid(state.playerGrid),
    special: cloneSpecial(state.playerSpecial)
  };
  vsSendMaze(state.vs.room, state.vs.roundId, payload);
  updateVsStatus("Maze locked and sent. Waiting for your opponent…");
  updateVsPanelState();
}

function lockAndSubmitVsMaze(reason = "timer") {
  if (state.vs.mazeSubmitted) return;
  state.vs.locked = true;
  stopVsCountdown();
  lockPlayerBuild();
  state.buildTimeLeft = 0;
  updatePhaseLabel(
    "Maze locked",
    reason === "early" ? "Both players agreed to start. Preparing the reveal." : "Time is up. Preparing the reveal."
  );
  sendVsMaze();
}

function maybeStartVsRace() {
  if (!state.vs.mazeSubmitted || !state.vs.opponentMaze) return;
  state.aiGrid = cloneGrid(state.vs.opponentMaze.grid || state.vs.opponentMaze);
  state.aiSpecial = state.vs.opponentMaze.special ? cloneSpecial(state.vs.opponentMaze.special) : null;
  state.aiBuildPromise = Promise.resolve();
  startRace(true);
  updateVsStatus("Mazes revealed. The runners are about to start.");
  updateVsPanelState();
}

function editAndRetry() {
  if (!state.seed) return;
  raceStartToken++;
  state.building = true;
  state.buildTimeLeft = BUILD_DURATION / 1000;
  state.waitingForSpecial = false;
  state.race = null;
  state.reveal = null;
  revealBanner?.classList.add("hidden");
  state.results = {
    player: null,
    ai: state.daily.active ? Number(state.daily.challenge?.aiTime || 0) : null,
    winner: null
  };
  resetPadStates(state.playerGrid);
  resetPadStates(state.aiGrid);
  if (state.playerSpecial) state.playerSpecial.effectTimer = 0;
  if (state.aiSpecial) state.aiSpecial.effectTimer = 0;
  state.neutralSpecials = state.baseNeutralSpecials.map(cloneSpecial);
  setCanvasPresentation("build");
  if (state.daily.active) {
    state.daily.attemptComplete = false;
    updatePhaseLabel("Refine today’s maze", "Make any changes you like, then run another verified attempt.");
  } else {
    updatePhaseLabel("Refine your maze", "Adjust your design, then start another run on the same seed.");
  }
  hidePopup();
  resetVsEarlyStartVotes();
  updateHud();
  updateStartRaceControl();
  announce(state.daily.active ? "Daily maze ready for another attempt." : "Edit and retry. Your previous maze is ready to refine.");
}

function resetPadStates(grid) {
  return AICore.resetPadStates(grid);
}

function startFromMenu() {
  showLoadingOverlay("Preparing...");
  requestAnimationFrame(() => {
    window.OutmazeOnline?.deactivateModes?.({ closeSocket: true });
    state.vs.active = false;
    setVsUiVisible(false);
    cancelAiBuild();
    clearCurrentGameState();
    applyVsVisibility(false);
    startGame(seedInput.value);
    hideLoadingOverlay();
    hideMainMenu();
  });
}

async function startVsFromMenu() {
  const profile = await window.OutmazeAccount?.requireProfile?.();
  if (!profile) return;
  showLoadingOverlay("Opening multiplayer…");
  requestAnimationFrame(() => {
    window.OutmazeOnline?.deactivateModes?.({ closeSocket: false });
    cancelAiBuild();
    clearCurrentGameState();
    state.vs.active = true;
    state.vs.room = null;
    state.vs.connected = false;
    state.vs.ready = false;
    state.vs.players = 0;
    state.vs.readyCount = 0;
    state.vs.phase = "disconnected";
    state.vs.roundId = null;
    state.vs.mazeSubmitted = false;
    state.vs.locked = false;
    state.vs.opponentMaze = null;
    state.vs.startsAt = null;
    state.vs.waitingForStart = true;
    state.vs.choiceSelf = null;
    state.vs.choicePeer = null;
    state.vs.rematchMode = null;
    state.vs.buildStartsAt = null;
    state.vs.buildEndsAt = null;
    resetVsEarlyStartVotes();
    hideMainMenu();
    canvas.classList.add("vs-waiting");
    setSeedUiVisible(false);
    setVsUiVisible(true);
    applyVsVisibility(true);
    setVsWaitingTimer();
    updatePhaseLabel("Two-player lobby", "Create a room or join your opponent before the shared seed begins.");
    updateSpecialInfo();
    updateHud();
    updateVsPanelState();
    connectVs();
    hideLoadingOverlay();
  });
}

function hasBuildResources() {
  return (state.coins || 0) > 0 || (state.singleBlocks || 0) > 0;
}

function allStructuresPlaced() {
  return (state.coins || 0) <= 0 && (state.singleBlocks || 0) <= 0 && Boolean(state.playerSpecial?.placed);
}

function handlePlacementComplete(evt) {
  updateResourceCards();
  if (state.vs.active) return;
  if (allStructuresPlaced()) {
    announce("All structures placed. Start the race whenever you are ready.");
  }
  updateStartRaceControl();
}

function releaseSpecialWaitIfResources(prevWalls, prevSingles) {
  if (!state.waitingForSpecial) return;
  if ((prevWalls === 0 && state.coins > 0) || (prevSingles === 0 && state.singleBlocks > 0)) {
    state.waitingForSpecial = false;
  }
}

function handleCanvasClick(evt) {
  if (suppressClickAfterTouch) {
    suppressClickAfterTouch = false;
    evt.preventDefault?.();
    return;
  }
  if (!state.building) return;
  const cell = pointerToGrid(evt);
  if (!cell) return;

  if (state.buildMode === "special") {
    if (state.playerSpecial.placed) {
      addFloatingText("Hazard already placed", evt);
      return;
    }
    if (tryPlaceSpecial(state.playerGrid, cell.x, cell.y, state.playerSpecial)) {
      autoSelectNextBuildMode("special", state.playerSpecial?.placed);
      updateSpecialInfo();
      updateStartRaceControl();
      announce(`${getSpecialTypeName(state.playerSpecial.type)} placed. You can start now or keep building.`);
    } else {
      addFloatingText("Can't place hazard there", evt);
    }
    return;
  }

  if (state.buildMode === "single") {
    if (state.singleBlocks <= 0) {
      addFloatingText("No single blocks left!", evt, "#ff9c6b");
      if (state.coins > 0) setBuildMode("normal");
      return;
    }
    if (!tryPlaceSingleBlock(state.playerGrid, cell.x, cell.y)) {
      addFloatingText("Invalid placement", evt);
      return;
    }
    state.playerSingles.push({ x: cell.x, y: cell.y });
    state.singleBlocks -= 1;
    autoSelectNextBuildMode("single", state.singleBlocks <= 0);
    handlePlacementComplete(evt);
    return;
  }

  if (state.coins <= 0) {
    if (state.singleBlocks > 0) {
      addFloatingText("No walls left! Switch to the single block card.", evt, "#ffb36b");
      setBuildMode("single");
    } else if (!state.playerSpecial.placed) {
      addFloatingText("Structures placed! Your hazard is still available.", evt, "#99ff99");
      setBuildMode("special");
    }
    return;
  }

  if (!tryPlaceBlock(state.playerGrid, cell.x, cell.y)) {
    addFloatingText("Invalid placement", evt);
    return;
  }
  state.playerBlocks.push({ x: cell.x, y: cell.y });
  state.coins -= 1;
  autoSelectNextBuildMode("normal", state.coins <= 0);
  handlePlacementComplete(evt);
}

function handleRightClick(evt) {
  evt.preventDefault();
  if (!state.building) return;
  const cell = pointerToGrid(evt);
  if (!cell) return;

  if (state.playerSpecial.placed && cell.x === state.playerSpecial.cell.x && cell.y === state.playerSpecial.cell.y) {
    state.playerGrid[cell.y][cell.x] = CELL_EMPTY;
    state.playerSpecial = createSpecialTemplate(state.specialTemplate.type);
    setBuildMode("normal");
    updateSpecialInfo();
    updateStartRaceControl();
    return;
  }

  const idx = state.playerBlocks.findIndex(
    (block) => cell.x >= block.x && cell.x <= block.x + 1 && cell.y >= block.y && cell.y <= block.y + 1
  );
  if (idx !== -1) {
    clearBlock(state.playerGrid, state.playerBlocks[idx].x, state.playerBlocks[idx].y);
    state.playerBlocks.splice(idx, 1);
    const prevCoins = state.coins;
    state.coins = Math.min(state.coins + 1, state.coinBudget);
    releaseSpecialWaitIfResources(prevCoins, state.singleBlocks);
    updateResourceCards();
    updateStartRaceControl();
    return;
  }

  const singleIdx = state.playerSingles.findIndex((block) => cell.x === block.x && cell.y === block.y);
  if (singleIdx === -1) return;
  if (state.playerGrid[cell.y][cell.x] === CELL_SINGLE) {
    state.playerGrid[cell.y][cell.x] = CELL_EMPTY;
  }
  state.playerSingles.splice(singleIdx, 1);
  const prevSingles = state.singleBlocks;
  state.singleBlocks = Math.min(state.singleBlocks + 1, state.singleBudget);
  releaseSpecialWaitIfResources(state.coins, prevSingles);
  updateResourceCards();
  updateStartRaceControl();
}

function handleTouchStart(evt) {
  if (evt.touches.length !== 1) return;
  const touch = evt.touches[0];
  touchHoldStart = { x: touch.clientX, y: touch.clientY };
  touchHoldTriggered = false;
  clearTimeout(touchHoldTimeout);
  touchHoldTimeout = setTimeout(() => {
    touchHoldTriggered = true;
    suppressClickAfterTouch = true;
    handleRightClick({
      clientX: touchHoldStart.x,
      clientY: touchHoldStart.y,
      preventDefault: () => evt.preventDefault()
    });
  }, TOUCH_RIGHT_CLICK_DELAY);
}

function handleTouchMove(evt) {
  if (!touchHoldStart) return;
  if (evt.touches.length !== 1) {
    cancelTouchHold();
    return;
  }
  const touch = evt.touches[0];
  const dx = Math.abs(touch.clientX - touchHoldStart.x);
  const dy = Math.abs(touch.clientY - touchHoldStart.y);
  if (dx > TOUCH_MOVE_CANCEL_DISTANCE || dy > TOUCH_MOVE_CANCEL_DISTANCE) {
    cancelTouchHold();
  }
}

function handleTouchEnd(evt) {
  if (touchHoldTriggered) {
    evt.preventDefault();
    setTimeout(() => {
      suppressClickAfterTouch = false;
    }, 400);
  }
  cancelTouchHold();
}

function cancelTouchHold() {
  clearTimeout(touchHoldTimeout);
  touchHoldTimeout = null;
  touchHoldStart = null;
  touchHoldTriggered = false;
}

function handleMouseMove(evt) {
  if (!state.building) {
    state.hoverCell = null;
    return;
  }
  const cell = pointerToGrid(evt);
  state.hoverCell = cell;
}

function setBuildMode(mode = "normal") {
  if (!state.building) {
    mode = "normal";
  } else if (mode === "special" && state.playerSpecial?.placed) {
    mode = "normal";
  }
  if (mode === "normal" && state.coins <= 0) {
    if (state.singleBlocks > 0) mode = "single";
    else if (!state.playerSpecial?.placed) mode = "special";
  }
  if (mode === "single" && state.singleBlocks <= 0) {
    if (state.coins > 0) mode = "normal";
    else if (!state.playerSpecial?.placed) mode = "special";
    else mode = "normal";
  }
  state.buildMode = mode;
  updateCurrencySelection();
  updateToolDetail();
}

function isModeAvailable(mode) {
  if (!state.building) return false;
  if (mode === "normal") return state.coins > 0;
  if (mode === "single") return state.singleBlocks > 0;
  if (mode === "special") return state.playerSpecial && !state.playerSpecial.placed;
  return false;
}

function autoSelectNextBuildMode(currentMode, shouldSwitch = true) {
  if (!state.building || !shouldSwitch) return false;
  const startIndex = BUILD_MODE_ORDER.indexOf(currentMode ?? state.buildMode);
  const baseIndex = startIndex >= 0 ? startIndex : BUILD_MODE_ORDER.indexOf(state.buildMode);
  for (let i = 1; i <= BUILD_MODE_ORDER.length; i++) {
    const idx = ((baseIndex >= 0 ? baseIndex : -1) + i + BUILD_MODE_ORDER.length) % BUILD_MODE_ORDER.length;
    const nextMode = BUILD_MODE_ORDER[idx];
    if (!isModeAvailable(nextMode) || nextMode === state.buildMode) continue;
    setBuildMode(nextMode);
    showModeSwitchMessage(nextMode);
    return true;
  }
  return false;
}

function buildModeLabel(mode) {
  if (mode === "normal") return "Walls";
  if (mode === "single") return "Singles";
  if (mode === "special") return "Hazard";
  return "Build";
}

function showModeSwitchMessage(mode) {
  if (state.mode !== "game") return;
  const label = buildModeLabel(mode);
  state.floatingTexts.push({
    text: `Switched to ${label}`,
    x: canvas.width / 2,
    y: 70,
    life: 1.2,
    color: "#9cffaf"
  });
}

function renderSpecialPreview() {
  if (!specialPreviewCtx || !specialPreviewCanvas) return;
  const ctxPreview = specialPreviewCtx;
  ctxPreview.clearRect(0, 0, specialPreviewCanvas.width, specialPreviewCanvas.height);
  if (!state.playerSpecial) return;
  const previewSpecial = { ...state.playerSpecial, placed: true, cell: { x: 0, y: 0 } };
  const palette = specialPaletteForCell(previewSpecial, 0, 0);
  if (!palette) return;
  drawSpecialBlockSprite(0, 0, palette, ctxPreview, 0);
}

function tryPlaceBlock(grid, gx, gy) {
  if (!canPlaceBlock(grid, gx, gy)) return false;
  placeBlock(grid, gx, gy, CELL_PLAYER);
  ensureOpenings(grid);
  if (!hasPath(grid)) {
    clearBlock(grid, gx, gy);
    ensureOpenings(grid);
    return false;
  }
  return true;
}

function tryPlaceSingleBlock(grid, gx, gy) {
  if (!canPlaceSingle(grid, gx, gy)) return false;
  grid[gy][gx] = CELL_SINGLE;
  ensureOpenings(grid);
  if (!hasPath(grid)) {
    grid[gy][gx] = CELL_EMPTY;
    ensureOpenings(grid);
    return false;
  }
  return true;
}

function tryPlaceSpecial(grid, gx, gy, special) {
  if (!isCellAvailableForSpecial(grid, gx, gy)) return false;
  grid[gy][gx] = CELL_SPECIAL;
  ensureOpenings(grid);
  if (!hasPath(grid)) {
    grid[gy][gx] = CELL_EMPTY;
    ensureOpenings(grid);
    return false;
  }
  special.cell = { x: gx, y: gy };
  special.placed = true;
  special.effectTimer = 0;
  return true;
}

async function startRace(forceStart = false) {
  if (state.vs.active) {
    if (!forceStart && !state.vs.opponentMaze) return;
  } else if (!state.building && !forceStart) return;
  const startToken = ++raceStartToken;
  state.waitingForSpecial = false;
  state.building = false;
  state.buildTimeLeft = 0;
  state.hoverCell = null;
  setBuildMode("normal");
  if (!state.vs.active) {
    updatePhaseLabel("Maze locked", "Finishing the AI design before the reveal.");
  }
  updateHud();

  const playerGrid = cloneGrid(state.playerGrid);
  const playerSpecial = cloneSpecial(state.playerSpecial);

  if (state.daily.active) {
    if (startToken !== raceStartToken || state.building) return;
    const playerRunner = coreCreateRunner("You", playerGrid, playerSpecial, state.baseNeutralSpecials);
    state.race = {
      runners: [playerRunner],
      finished: false,
      started: false,
      elapsed: null,
      elapsedTime: 0,
      simulationComputeMs: 0
    };
    state.reveal = {
      active: true,
      elapsed: 0,
      duration: prefersReducedMotion() ? 0.2 : 0.65
    };
    state.daily.attemptComplete = false;
    state.results = { player: null, ai: Number(state.daily.challenge?.aiTime || 0), winner: null };
    setCanvasPresentation("solo-race");
    const revealTitle = revealBanner?.querySelector("strong");
    if (revealTitle) revealTitle.textContent = "Releasing your runner";
    revealBanner?.classList.remove("hidden");
    updatePhaseLabel("Daily run", "Your runner is the only maze revealed; the AI benchmark remains a time only.");
    window.OutmazeOnline?.updateDailyPanel?.();
    announce("Daily runner ready. The attempt begins shortly.");
    return;
  }

  if (!state.aiGrid || !state.aiSpecial) {
    if (state.vs.active && state.vs.opponentMaze) {
      state.aiGrid = cloneGrid(state.vs.opponentMaze.grid || state.vs.opponentMaze);
      state.aiSpecial = state.vs.opponentMaze.special ? cloneSpecial(state.vs.opponentMaze.special) : null;
      state.aiBuildPromise = Promise.resolve();
    } else {
      if (state.aiBuildPromise) {
        showAiBuildPopup();
        try {
          const aiLayout = await state.aiBuildPromise;
          if (aiLayout) {
            state.aiGrid = aiLayout.grid;
            state.aiSpecial = aiLayout.special;
            state.aiLookaheadUsed = aiLayout.lookaheadUsed || 0;
            state.aiPlacementOrder = aiLayout.placementOrder || [];
            state.aiProfile = aiLayout.profile || null;
            state.aiProfileSource = aiLayout.profile?.source || "unknown";
            state.performance.aiBuildMs = Number(aiLayout.profile?.totalMs || 0);
          }
        } catch (err) {
          console.error("AI build failed, falling back to sync build", err);
        } finally {
          hideAiBuildPopup();
        }
      }
      if (!state.aiGrid || !state.aiSpecial) {
        const aiLayout = buildAiLayout();
        state.aiGrid = aiLayout.grid;
        state.aiSpecial = aiLayout.special;
        state.aiLookaheadUsed = aiLayout.lookaheadUsed || 0;
        state.aiPlacementOrder = aiLayout.placementOrder || [];
        state.aiProfile = aiLayout.profile || null;
        state.aiProfileSource = aiLayout.profile?.source || "sync-fallback";
        state.performance.aiBuildMs = Number(aiLayout.profile?.totalMs || 0);
      }
    }
  }

  if (startToken !== raceStartToken || state.building) return;

  const playerLabel = state.vs.active ? state.vs.selfLabel || "You" : "You";
  const playerRunner = coreCreateRunner(playerLabel, playerGrid, playerSpecial, state.baseNeutralSpecials);
  const aiLabel = state.vs.active ? state.vs.oppLabel || "Opponent" : "AI";
  const aiRunner = coreCreateRunner(aiLabel, cloneGrid(state.aiGrid), cloneSpecial(state.aiSpecial), state.baseNeutralSpecials);

  if (!playerRunner.path.length || !aiRunner.path.length) {
    const fallbackPath = [
      { x: ENTRANCE_X, y: GRID_SIZE },
      { x: ENTRANCE_X, y: GRID_SIZE + 1 },
      { x: ENTRANCE_X, y: GRID_SIZE + 2 },
      { x: ENTRANCE_X, y: GRID_SIZE + 3 },
      { x: ENTRANCE_X, y: GRID_SIZE + 4 },
      { x: ENTRANCE_X, y: 0 },
      { x: ENTRANCE_X, y: -1 }
    ];
    if (!playerRunner.path.length) {
      playerRunner.path = fallbackPath.slice();
      playerRunner.segmentIndex = 0;
      playerRunner.segmentProgress = 0;
      playerRunner.segmentLengths = coreComputeSegmentLengths(playerRunner.path);
    }
    if (!aiRunner.path.length) {
      aiRunner.path = fallbackPath.slice();
      aiRunner.segmentIndex = 0;
      aiRunner.segmentProgress = 0;
      aiRunner.segmentLengths = coreComputeSegmentLengths(aiRunner.path);
    }
  }

  state.race = {
    runners: [playerRunner, aiRunner],
    finished: false,
    started: false,
    elapsed: null,
    elapsedTime: 0,
    simulationComputeMs: 0
  };
  state.reveal = {
    active: true,
    elapsed: 0,
    duration: prefersReducedMotion() ? 0.35 : REVEAL_DURATION
  };
  state.results = { player: null, ai: null, winner: null };
  setCanvasPresentation("race");
  const revealTitle = revealBanner?.querySelector("strong");
  if (revealTitle) revealTitle.textContent = state.vs.active ? "Revealing your opponent" : "Revealing the AI";
  revealBanner?.classList.remove("hidden");
  updatePhaseLabel("Maze reveal", "Study both designs before the runners are released.");
  announce(`${getOpponentLabel()} maze revealed. Runners will start shortly.`);
}

function currentLookaheadBudget() {
  return aiLookaheadBudgetOverride != null
    ? Math.max(0, aiLookaheadBudgetOverride | 0)
    : LOOKAHEAD_BUDGET;
}

function buildAiLayout() {
  const result = AICore.buildAiLayoutFromSnapshot(makeAiSnapshot());
  state.aiProfile = result.profile || null;
  state.aiProfileSource = result.profile?.source || "ai-core";
  const branch = normalizeBranch(result);
  return {
    grid: result.grid,
    special: result.special,
    lookaheadUsed: result.lookaheadUsed || 0,
    placementOrder: result.placementOrder || [],
    profile: result.profile || null,
    branch,
    branchId: result.branchId || null,
    branchTotal: result.branchTotal || null
  };
}


function setSeedUiVisible(show) {
  seedControls.forEach((el) => {
    if (!el) return;
    if (show) el.classList.remove("hidden");
    else el.classList.add("hidden");
  });
}

function setVsUiVisible(show) {
  vsUiControls.forEach((el) => {
    if (!el) return;
    if (show) el.classList.remove("hidden");
    else el.classList.add("hidden");
  });
  if (show) updateVsPanelState();
  else updateEarlyStartControls();
}

function applyVsVisibility(active) {
  if (typeof document !== "undefined") {
    document.body.classList.toggle("vs-mode", active);
  }
  if (!active) {
    vsPanel?.classList.add("hidden");
  }
}

function setVsWaitingTimer() {
  const timerEl = document.getElementById("timer");
  const statusEl = document.getElementById("timerStatus");
  if (statusEl) statusEl.textContent = "Waiting for other player";
  if (timerEl) timerEl.textContent = "--";
  if (vsChoiceStatus) vsChoiceStatus.textContent = "";
}

function leaveVsMode() {
  if (state.vs.room) vsSend({ type: "leave" });
  stopVsCountdown();
  state.vs.active = false;
  state.vs.room = null;
  state.vs.connected = false;
  state.vs.ready = false;
  state.vs.players = 0;
  state.vs.readyCount = 0;
  state.vs.phase = "disconnected";
  state.vs.roundId = null;
  state.vs.mazeSubmitted = false;
  state.vs.locked = false;
  state.vs.opponentMaze = null;
  state.vs.startsAt = null;
  state.vs.waitingForStart = false;
  state.vs.choiceSelf = null;
  state.vs.choicePeer = null;
  state.vs.buildEndsAt = null;
  resetVsEarlyStartVotes();
  canvas.classList.remove("vs-waiting");
  setSeedUiVisible(true);
  setVsUiVisible(false);
  applyVsVisibility(false);
  versusClient.pending.length = 0;
  versusClient.onEvent = null;
  if (versusClient.ws) {
    try {
      versusClient.ws.close();
    } catch (_) {}
  }
  versusClient.ws = null;
  versusClient.authenticated = false;
  updateVsStatus("Disconnected.");
}

function copyVsRoomCode() {
  if (!state.vs.room) return;
  const copied = () => updateVsStatus(`Room ${state.vs.room} copied. Send it to your opponent.`);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(state.vs.room).then(copied).catch(() => fallbackShare(state.vs.room));
  } else {
    fallbackShare(state.vs.room);
    copied();
  }
}

function clearCurrentGameState() {
  raceStartToken++;
  state.building = false;
  state.waitingForSpecial = false;
  state.coins = 0;
  state.coinBudget = 0;
  state.singleBlocks = 0;
  state.singleBudget = 0;
  state.playerBlocks = [];
  state.playerSingles = [];
  state.playerGrid = createEmptyGrid();
  state.baseGrid = createEmptyGrid();
  state.baseNeutralSpecials = [];
  state.neutralSpecials = [];
  state.baseStaticCount = 0;
  state.playerSpecial = null;
  state.aiSpecial = null;
  state.specialTemplate = null;
  state.aiGrid = createEmptyGrid();
  state.aiPlacementOrder = [];
  state.aiProfile = null;
  state.aiProfileSource = null;
  state.aiBuildPromise = null;
  state.aiLookaheadUsed = 0;
  state.aiJobId = 0;
  state.aiPendingSeed = "";
  state.aiWalls = [];
  state.aiSingles = [];
  state.results = { player: null, ai: null, winner: null };
  state.race = null;
  state.reveal = null;
  state.buildTimeLeft = 0;
  state.hoverCell = null;
  state.floatingTexts = [];
  state.seed = "";
  if (seedInput) seedInput.value = "";
  updateHud();
  clearCanvas();
}

function toggleEarlyStartVote() {
  if (
    !state.vs.active ||
    state.vs.phase !== "building" ||
    state.vs.locked ||
    state.vs.mazeSubmitted ||
    state.vs.roundId == null
  ) {
    return;
  }
  const request = !state.vs.earlyStartSelf;
  state.vs.earlyStartSelf = request;
  sendEarlyStartVote(request);
  updateEarlyStartControls();
}

function sendEarlyStartVote(vote) {
  if (!state.vs.room || state.vs.roundId == null) return;
  vsSend({
    type: "early-start",
    room: state.vs.room,
    roundId: state.vs.roundId,
    vote: Boolean(vote)
  });
}

function updateEarlyStartControls() {
  if (!vsEarlyStartBtn) return;
  const available =
    state.vs.active &&
    state.vs.phase === "building" &&
    !state.vs.locked &&
    !state.vs.mazeSubmitted;
  vsEarlyStartBtn.disabled = !available;
  vsEarlyStartBtn.textContent = state.vs.earlyStartSelf ? "Keep building" : "Ready to start early";
  vsEarlyStartBtn.classList.toggle("is-selected", state.vs.earlyStartSelf);
  vsEarlyStartBtn.setAttribute("aria-pressed", String(state.vs.earlyStartSelf));
  updateVsPlayerStates();
}

function resetVsEarlyStartVotes() {
  state.vs.earlyStartSelf = false;
  state.vs.earlyStartPeer = false;
  state.vs.earlyStartTriggered = false;
  updateEarlyStartControls();
}

function setVsChoice(choice) {
  resetVsEarlyStartVotes();
  state.vs.choiceSelf = choice;
  vsSendRematch(choice);
  updateVsChoiceStatus();
  updateVsPanelState();
}

function updateVsChoiceStatus() {
  if (!vsChoiceStatus) return;
  const raceInProgress = state.vs.phase === "racing" && !state.race?.finished;
  const mismatch = state.vs.choiceSelf && state.vs.choicePeer && state.vs.choiceSelf !== state.vs.choicePeer;
  const matched = state.vs.choiceSelf && state.vs.choiceSelf === state.vs.choicePeer;
  if (!state.vs.choiceSelf) {
    vsChoiceStatus.textContent = raceInProgress
      ? "Both players must agree to stop the current race."
      : "Choose how you want the room to continue.";
  } else if (!state.vs.choicePeer) {
    vsChoiceStatus.textContent = raceInProgress
      ? "Stop request saved. The race continues while you wait…"
      : "Choice saved. Waiting for your opponent…";
  }
  else if (mismatch) vsChoiceStatus.textContent = "Choose the same option to continue together.";
  else if (matched) vsChoiceStatus.textContent = "Choices match. Preparing the next round…";
  else vsChoiceStatus.textContent = "";

  if (vsTryAgainDetail) vsTryAgainDetail.textContent = raceInProgress ? "Stop race & edit" : "Keep this seed";
  if (vsNewGameDetail) vsNewGameDetail.textContent = raceInProgress ? "Stop race & reset" : "Fresh environment";

  const updateChoiceButton = (button, selected) => {
    if (!button) return;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  };
  updateChoiceButton(vsTryAgainBtn, state.vs.choiceSelf === "same");
  updateChoiceButton(vsNewGameBtn, state.vs.choiceSelf === "new");
  vsRematchActions?.classList.toggle("has-mismatch", Boolean(mismatch));
  updateVsPlayerStates();
}

function setVsPlayerState(card, labelEl, textEl, label, text, visualState) {
  if (!card || !labelEl || !textEl) return;
  labelEl.textContent = label;
  textEl.textContent = text;
  card.dataset.state = visualState;
  card.setAttribute("aria-label", `${label}: ${text}`);
}

function updateVsPlayerStates() {
  if (!vsPlayerStates) return;
  const inRoom = Boolean(state.vs.room);
  const lobby = inRoom && state.vs.phase === "lobby";
  const building = inRoom && state.vs.phase === "building" && !state.vs.mazeSubmitted;
  const racing = inRoom && state.vs.phase === "racing";
  const visible = lobby || building || racing;
  vsPlayerStates.classList.toggle("hidden", !visible);
  if (!visible) return;

  let selfText = "Waiting";
  let peerText = state.vs.players < 2 ? "Waiting to join" : "Not ready";
  let selfVisual = "waiting";
  let peerVisual = state.vs.players < 2 ? "offline" : "waiting";

  if (lobby) {
    const peerReady = state.vs.readyCount > (state.vs.ready ? 1 : 0);
    selfText = state.vs.ready ? "Ready" : "Not ready";
    selfVisual = state.vs.ready ? "ready" : "waiting";
    if (state.vs.players >= 2) {
      peerText = peerReady ? "Ready" : "Not ready";
      peerVisual = peerReady ? "ready" : "waiting";
    }
  } else if (building) {
    selfText = state.vs.earlyStartSelf ? "Ready to start" : "Building";
    peerText = state.vs.earlyStartPeer ? "Ready to start" : "Building";
    selfVisual = state.vs.earlyStartSelf ? "ready" : "active";
    peerVisual = state.vs.earlyStartPeer ? "ready" : "active";
  } else if (racing) {
    const raceComplete = Boolean(state.race?.finished);
    const choiceLabel = (choice) =>
      choice === "same" ? "Modify maze" : choice === "new" ? "New seed" : raceComplete ? "Choosing…" : "Runner active";
    const mismatch = state.vs.choiceSelf && state.vs.choicePeer && state.vs.choiceSelf !== state.vs.choicePeer;
    const matched = state.vs.choiceSelf && state.vs.choiceSelf === state.vs.choicePeer;
    selfText = choiceLabel(state.vs.choiceSelf);
    peerText = choiceLabel(state.vs.choicePeer);
    selfVisual = mismatch ? "warning" : matched ? "ready" : state.vs.choiceSelf ? "selected" : raceComplete ? "waiting" : "active";
    peerVisual = mismatch ? "warning" : matched ? "ready" : state.vs.choicePeer ? "selected" : raceComplete ? "waiting" : "active";
  }

  const selfLabel = state.vs.selfShort && state.vs.selfShort !== "You" ? `${state.vs.selfShort} (You)` : "You";
  const peerLabel = state.vs.oppShort || "Opponent";
  setVsPlayerState(vsSelfState, vsSelfStateLabel, vsSelfStateText, selfLabel, selfText, selfVisual);
  setVsPlayerState(vsPeerState, vsPeerStateLabel, vsPeerStateText, peerLabel, peerText, peerVisual);
}

const AI_ASYNC_YIELD_BUDGET = 1;
const PUBLIC_VS_WS_URL = "wss://outmaze-73wvux7ama-ts.a.run.app";
const VS_WS_URL =
  typeof location !== "undefined"
    ? location.protocol === "http:"
      ? `ws://${location.host}`
      : PUBLIC_VS_WS_URL
    : "";

async function buildAiLayoutAsync() {
  const result = AICore.buildAiLayoutFromSnapshot(makeAiSnapshot());
  state.aiProfile = result.profile || null;
  state.aiProfileSource = result.profile?.source || "ai-core";
  return {
    grid: result.grid,
    special: result.special,
    lookaheadUsed: result.lookaheadUsed || 0,
    placementOrder: result.placementOrder || [],
    profile: result.profile || null
  };
}

function prewarmAiWorker() {
  // Best-effort worker spin-up during load; failures fall back to main thread.
  ensureAiWorker();
}

function ensureAiWorker() {
  if (aiWorker) return aiWorker;
  if (typeof Worker === "undefined") return null;
  try {
    aiWorker = new Worker("ai-worker.js");
    return aiWorker;
  } catch (err) {
    console.warn("AI worker failed to start; falling back to main thread", err);
    aiWorker = null;
    return null;
  }
}

function cancelAiBuild(options = {}) {
  const { terminateWorker = false } = options;
  aiBuildToken++;
  if (terminateWorker) {
    terminateAiWorker();
    hideAiBuildPopup();
    state.aiPendingSeed = "";
  }
  state.aiBuildPromise = null;
}

function buildAiLayoutViaWorker() {
  return new Promise((resolve, reject) => {
    const worker = ensureAiWorker();
    if (!worker) {
      buildAiLayoutAsync().then(resolve).catch(reject);
      return;
    }
    const jobId = ++aiWorkerJobCounter;
    const snapshot = makeAiSnapshot();
    const handleMessage = (evt) => {
      const data = evt.data || {};
      if (data.jobId !== jobId) return;
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      if (data.ok) {
        resolve({
          grid: data.grid,
          special: data.special,
          placementOrder: data.placementOrder,
          profile: { ...(data.profile || {}), source: "worker" },
          lookaheadUsed: data.lookaheadUsed
        });
      } else {
        reject(new Error(data.error || "AI worker failed"));
      }
    };
    const handleError = (err) => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      reject(err instanceof Error ? err : new Error("AI worker error"));
    };
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({ jobId, snapshot });
  });
}

function terminateAiWorker() {
  if (!aiWorker) return;
  try {
    aiWorker.terminate();
  } catch (err) {
    console.warn("AI worker termination failed", err);
  }
  aiWorker = null;
  aiWorkerJobCounter = 0;
}

// ---------------------------------------------------------------------------
// Two-player WebSocket transport
// ---------------------------------------------------------------------------
const versusClient = {
  ws: null,
  room: null,
  onEvent: null,
  pending: [],
  authenticated: false
};

function vsConnect(onEvent = null) {
  if (!VS_WS_URL) throw new Error("VS_WS_URL not set");
  if (onEvent) versusClient.onEvent = onEvent;
  if (
    versusClient.ws &&
    (versusClient.ws.readyState === WebSocket.OPEN || versusClient.ws.readyState === WebSocket.CONNECTING)
  ) {
    return versusClient.ws;
  }
  const ws = new WebSocket(VS_WS_URL);
  ws.onopen = async () => {
    try {
      const token = await window.OutmazeAccount?.getIdToken?.();
      if (!token) throw new Error("Sign in to continue");
      ws.send(JSON.stringify({ type: "auth", token }));
    } catch (error) {
      emitVsEvent({ type: "error", code: "sign-in-required", error: error.message });
      ws.close();
    }
  };
  ws.onclose = (event) => {
    if (versusClient.ws === ws) versusClient.ws = null;
    versusClient.authenticated = false;
    emitVsEvent({ type: "disconnected", code: event.code, reason: event.reason || "" });
  };
  ws.onerror = () => emitVsEvent({ type: "error", error: "Could not connect to the multiplayer server" });
  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.type === "authenticated") {
        versusClient.authenticated = true;
        const queued = versusClient.pending.splice(0);
        queued.forEach((message) => ws.send(JSON.stringify(message)));
        emitVsEvent({ type: "connected", profile: data.profile });
        return;
      }
      emitVsEvent(data);
    } catch (err) {
      emitVsEvent({ type: "error", error: "bad message" });
    }
  };
  versusClient.ws = ws;
  return ws;
}

function emitVsEvent(evt) {
  if (typeof versusClient.onEvent === "function") versusClient.onEvent(evt);
}

function vsSend(data) {
  if (versusClient.ws?.readyState === WebSocket.OPEN && versusClient.authenticated) {
    versusClient.ws.send(JSON.stringify(data));
    return true;
  }
  versusClient.pending.push(data);
  if (!versusClient.ws || versusClient.ws.readyState > WebSocket.OPEN) vsConnect(handleVsEvent);
  return false;
}

function vsSendRematch(choice) {
  if (!state.vs.room) return;
  vsSend({ type: "rematch", room: state.vs.room, roundId: state.vs.roundId, choice });
}

function vsCreateRoom() {
  vsSend({ type: "create" });
}

function vsJoinRoom(room) {
  vsSend({ type: "join", room });
}

function vsReady(room) {
  vsSend({ type: "ready", room });
}

function vsSendMaze(room, roundId, payload) {
  vsSend({ type: "maze", room, roundId, payload });
}

function findBestAiPlacement(
  grid,
  currentScore,
  special,
  neutralSpecials,
  pathInfoOverride = null,
  lookaheadState = null,
  budgetInfo = null,
  allowWalls = true,
  allowSingles = true,
  forcedSingleCells = null
) {
  return coreFindBestAiPlacement(
    grid,
    currentScore,
    special,
    neutralSpecials,
    pathInfoOverride,
    lookaheadState,
    budgetInfo,
    allowWalls,
    allowSingles,
    forcedSingleCells,
    aiWeights,
    state.baseGrid,
    state.rng
  );
}

function generateRandomCandidates(grid, count) {
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push({
      x: randomInt(state.rng, 0, GRID_SIZE - 2),
      y: randomInt(state.rng, 1, GRID_SIZE - 3)
    });
  }
  return results;
}

function findTopAiWallCandidates(grid, special, neutralSpecials, limit = 1) {
  return coreFindTopAiWallCandidates(grid, special, neutralSpecials, limit, aiWeights, state.baseGrid);
}

function findTopAiSingleCandidates(
  grid,
  special,
  neutralSpecials,
  forcedCells = null,
  limit = 1
) {
  return coreFindTopAiSingleCandidates(grid, special, neutralSpecials, forcedCells, limit, aiWeights, state.baseGrid);
}

function generateRandomSingleCandidates(count) {
  return coreGenerateRandomSingleCandidates(count, state.rng);
}

function findFallbackAiCandidates(grid, special, neutralSpecials, allowWalls, allowSingles) {
  return coreFindFallbackAiCandidates(
    grid,
    special,
    neutralSpecials,
    allowWalls,
    allowSingles,
    state.rng,
    aiWeights,
    state.baseGrid
  );
}

function collectSpeedPadSteerCells(grid) {
  return coreCollectSpeedPadSteerCells(grid);
}

function evaluateCandidateWithLookahead(grid, special, neutralSpecials, candidate) {
  return coreEvaluateCandidateWithLookahead(grid, special, neutralSpecials, candidate, aiWeights, state.baseGrid);
}

function evaluatePlacementSequences(
  grid,
  special,
  neutralSpecials,
  wallPool,
  singlePool,
  budgetInfo
) {
  if (!budgetInfo) return null;
  const wallsLeft = budgetInfo.wallsLeft || 0;
  const singlesLeft = budgetInfo.singlesLeft || 0;
  const specialHotspots = budgetInfo.specialHotspots || [];
  const pools = {
    walls: wallPool.slice(0, COMBO_POOL_LIMIT),
    singles: singlePool.slice(0, COMBO_POOL_LIMIT),
    specials: !special.placed ? specialHotspots.slice(0, COMBO_POOL_LIMIT) : []
  };
  if (!pools.walls.length && !pools.singles.length && !pools.specials.length) return null;

  let best = null;
  const maxDepth = Math.max(1, Math.min(COMBO_LOOKAHEAD_DEPTH, wallsLeft + singlesLeft + (special.placed ? 0 : 1)));

  function dfs(currentGrid, currentSpecial, wLeft, sLeft, depth, firstMoveUsed, usedSpecial) {
    const score = evaluateGridForAi(currentGrid, currentSpecial, neutralSpecials);
    if (depth === 0 || (!wLeft && !sLeft && (usedSpecial || currentSpecial?.placed))) {
      if (!best || score > best.score) {
        best = { score, candidate: firstMoveUsed };
      }
      return;
    }
    // walls
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
    // singles
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
    // special
    if (!usedSpecial && pools.specials.length && currentSpecial && !currentSpecial.placed) {
      pools.specials.forEach((spot) => {
        const [sx, sy] = [spot.x, spot.y];
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
  dfs(startGrid, startSpecial, wallsLeft, singlesLeft, maxDepth, null, !!special?.placed);
  return best;
}

function applyPlacementCandidate(grid, candidate) {
  if (candidate.type === "wall") {
    placeBlock(grid, candidate.x, candidate.y, CELL_PLAYER);
  } else {
    candidate.previous = grid[candidate.y][candidate.x];
    grid[candidate.y][candidate.x] = CELL_SINGLE;
  }
  ensureOpenings(grid);
}

function revertPlacementCandidate(grid, candidate) {
  if (candidate.type === "wall") {
    clearBlock(grid, candidate.x, candidate.y);
  } else {
    const prev = candidate.previous != null ? candidate.previous : CELL_EMPTY;
    grid[candidate.y][candidate.x] = prev;
    candidate.previous = null;
  }
  ensureOpenings(grid);
}

function restoreBlock(grid, entry) {
  const x = entry.column != null ? entry.column - 1 : entry.x;
  const y = entry.row != null ? entry.row - 1 : entry.y;
  if (x == null || y == null) return;
  if (entry.type === "wall") {
    placeBlock(grid, x, y, CELL_PLAYER);
  } else if (entry.type === "single") {
    grid[y][x] = CELL_SINGLE;
  }
}

function insertCandidate(list, candidate, limit) {
  if (!candidate) return;
  list.push(candidate);
  list.sort((a, b) => b.score - a.score);
  if (list.length > limit) {
    list.length = limit;
  }
}

function refineAiLayout(grid, special, neutralSpecials, currentScore) {
  let score = currentScore;
  score = runStructureRefinement(grid, special, neutralSpecials, score);
  score = reduceMandatorySpeedPads(grid, special, neutralSpecials, score);
  return score;
}

function runStructureRefinement(grid, special, neutralSpecials, currentScore) {
  let score = currentScore;
  const iterations = 4;
  for (let i = 0; i < iterations; i++) {
    const pathInfo = analyzePath(grid);
    const earlySet = buildEarlyPathSet(pathInfo?.path);
    const wallResult = tryRepositionAiWall(
      grid,
      special,
      neutralSpecials,
      score,
      earlySet,
      state.aiWalls
    );
    if (wallResult.changed) score = wallResult.score;
    const singleResult = tryRepositionAiSingle(
      grid,
      special,
      neutralSpecials,
      score,
      earlySet,
      state.aiSingles
    );
    if (singleResult.changed) score = singleResult.score;
  }
  return score;
}

function quickPlacementReview(grid, special, neutralSpecials, currentScore) {
  const pathInfo = analyzePath(grid);
  if (!pathInfo?.path?.length) return currentScore;
  const earlySet = buildEarlyPathSet(pathInfo.path);
  const wallResult = tryRepositionAiWall(
    grid,
    special,
    neutralSpecials,
    currentScore,
    earlySet,
    state.aiWalls
  );
  let score = wallResult.changed ? wallResult.score : currentScore;
  const singleResult = tryRepositionAiSingle(
    grid,
    special,
    neutralSpecials,
    score,
    earlySet,
    state.aiSingles
  );
  if (singleResult.changed) score = singleResult.score;
  return score;
}

function buildEarlyPathSet(path) {
  if (!path?.length) return null;
  const limit = Math.min(path.length, EARLY_PATH_CELLS);
  const set = new Set();
  for (let i = 0; i < limit; i++) {
    const node = path[i];
    set.add(keyFor(node.x, node.y));
  }
  return set;
}

function tryRepositionAiWall(grid, special, neutralSpecials, currentScore, preferredCells) {
  const walls = listAiWallOrigins(grid, preferredCells);
  if (!walls.length) return { changed: false, score: currentScore };
  const idx = randomInt(state.rng, 0, walls.length - 1);
  const { x, y } = walls[idx];
  clearBlock(grid, x, y);
  ensureOpenings(grid);
  if (!hasPath(grid)) {
    placeBlock(grid, x, y, CELL_PLAYER);
    ensureOpenings(grid);
    return { changed: false, score: currentScore };
  }
  const placement = findBestAiPlacement(
    grid,
    currentScore,
    special,
    neutralSpecials,
    null,
    null,
    null,
    true,
    false
  );
  if (placement && placement.type === "wall" && placement.score > currentScore) {
    placeBlock(grid, placement.x, placement.y, CELL_PLAYER);
    ensureOpenings(grid);
    return { changed: true, score: placement.score };
  }
  placeBlock(grid, x, y, CELL_PLAYER);
  ensureOpenings(grid);
  return { changed: false, score: currentScore };
}

function tryRepositionAiSingle(grid, special, neutralSpecials, currentScore, preferredCells) {
  const singles = listAiSingleCells(grid, preferredCells);
  if (!singles.length) return { changed: false, score: currentScore };
  const idx = randomInt(state.rng, 0, singles.length - 1);
  const { x, y } = singles[idx];
  grid[y][x] = CELL_EMPTY;
  ensureOpenings(grid);
  if (!hasPath(grid)) {
    grid[y][x] = CELL_SINGLE;
    ensureOpenings(grid);
    return { changed: false, score: currentScore };
  }
  const placement = findBestAiPlacement(
    grid,
    currentScore,
    special,
    neutralSpecials,
    false,
    true,
    null,
    null
  );
  if (placement && placement.type === "single" && placement.score > currentScore) {
    grid[placement.y][placement.x] = CELL_SINGLE;
    ensureOpenings(grid);
    return { changed: true, score: placement.score };
  }
  grid[y][x] = CELL_SINGLE;
  ensureOpenings(grid);
  return { changed: false, score: currentScore };
}

function listAiWallOrigins(grid, preferredCells) {
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

function listAiSingleCells(grid, preferredCells) {
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

function reduceMandatorySpeedPads(grid, special, neutralSpecials, currentScore) {
  return coreReduceMandatorySpeedPads(grid, special, neutralSpecials, currentScore, aiWeights, state.baseGrid);
}

function collectMandatorySpeedPads(grid) {
  return coreCollectMandatorySpeedPads(grid);
}

function tryDivertSpeedPad(grid, special, neutralSpecials, currentScore, pad) {
  return coreTryDivertSpeedPad(grid, special, neutralSpecials, currentScore, pad);
}

function buildDiversionPreferenceSet(pad) {
  const set = new Set();
  for (let dy = -SPEED_DIVERSION_RADIUS; dy <= SPEED_DIVERSION_RADIUS; dy++) {
    for (let dx = -SPEED_DIVERSION_RADIUS; dx <= SPEED_DIVERSION_RADIUS; dx++) {
      const x = pad.x + dx;
      const y = pad.y + dy;
      if (!isInsideGrid(x, y)) continue;
      set.add(keyFor(x, y));
    }
  }
  return set;
}

function getDiversionCandidates(grid, px, py) {
  return coreGetDiversionCandidates(grid, px, py);
}

function computeSpecialHotspots(grid, special, neutralSpecials, limit = SPECIAL_HOTSPOT_LIMIT) {
  const basePath = computePath(grid);
  if (!basePath.length) return [];
  const baselineInfo = analyzePath(grid);
  const baselineMandatory = countMandatorySpeedPads(grid, baselineInfo?.path);
  const candidates = new Set();
  basePath.forEach((node) => {
    if (node.x >= 0 && node.x < GRID_SIZE && node.y >= 0 && node.y < GRID_SIZE) {
      candidates.add(key(node.x, node.y));
    }
    MOVES.forEach((move) => {
      const nx = node.x + move.dx;
      const ny = node.y + move.dy;
      if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
        candidates.add(key(nx, ny));
      }
    });
  });
  for (let i = 0; i < 120; i++) {
    const gx = randomInt(state.rng, 0, GRID_SIZE - 1);
    const gy = randomInt(state.rng, 1, GRID_SIZE - 2);
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

function placeAiSpecial(grid, special, neutralSpecials, preferredCells = []) {
  const basePath = computePath(grid);
  if (!basePath.length) return;
  const baselineInfo = analyzePath(grid);
  if (!baselineInfo) return;
  const baselineMandatory = countMandatorySpeedPads(grid, baselineInfo.path);
  const candidates = new Set();
  basePath.forEach((node) => {
    if (node.x >= 0 && node.x < GRID_SIZE && node.y >= 0 && node.y < GRID_SIZE) {
      candidates.add(key(node.x, node.y));
    }
    MOVES.forEach((move) => {
      const nx = node.x + move.dx;
      const ny = node.y + move.dy;
      if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
        candidates.add(key(nx, ny));
      }
    });
  });
  for (let i = 0; i < 120; i++) {
    const gx = randomInt(state.rng, 0, GRID_SIZE - 1);
    const gy = randomInt(state.rng, 1, GRID_SIZE - 2);
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
      bestGeneral &&
      (bestGeneral.pathGain >= SPECIAL_PATH_GAIN_THRESHOLD || bestGeneral.avoidsSpeedPad);
    if (generalException) {
      best = bestGeneral;
    } else {
      best = bestPreferred;
    }
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

function evaluateSpecialCandidate(
  grid,
  special,
  neutralSpecials,
  x,
  y,
  baselineInfo,
  baselineMandatorySpeedCount
) {
  return coreEvaluateSpecialCandidate(
    grid,
    special,
    neutralSpecials,
    x,
    y,
    baselineInfo,
    baselineMandatorySpeedCount
  );
}

function evaluateAiSeed(seed, runs = 1, silentOrOptions = false, additionalOptions = {}) {
  let config = {};
  if (typeof silentOrOptions === "boolean" || silentOrOptions == null) {
    config = { ...(additionalOptions || {}) };
    if (silentOrOptions) config.silent = true;
  } else if (typeof silentOrOptions === "object") {
    config = { ...silentOrOptions };
  } else {
    config = { ...(additionalOptions || {}) };
  }
  const silent = !!config.silent;
  const lookaheadOverride =
    config.lookaheadBudget != null ? Number(config.lookaheadBudget) : null;
  const snapshot = snapshotAiContext();
  const previousLookaheadOverride = aiLookaheadBudgetOverride;
  if (Number.isFinite(lookaheadOverride)) {
    aiLookaheadBudgetOverride = Math.max(0, Math.floor(lookaheadOverride));
  }
  const iterations = Math.max(1, runs | 0);
  const results = [];
  for (let i = 0; i < iterations; i++) {
    const simSeed = i === 0 ? `${seed}` : `${seed}-${i}`;
    const round = AICore.createRound(simSeed);
    state.rng = round.rng;
    state.seed = simSeed;
    state.baseGrid = round.baseGrid;
    state.baseNeutralSpecials = round.neutralSpecial ? [round.neutralSpecial] : [];
    state.neutralSpecials = state.baseNeutralSpecials.map(cloneSpecial);
    state.coinBudget = round.coinBudget;
    state.coins = state.coinBudget;
    const singleCount = round.singleBudget;
    state.singleBudget = singleCount;
    state.singleBlocks = singleCount;
    state.specialTemplate = cloneSpecial(round.specialTemplate);
    state.aiGrid = null;
    state.aiSpecial = null;
    const layout = buildAiLayout();
    const pathInfo = analyzePath(layout.grid);
    const metrics = summarizeAiMetrics(simSeed, layout, pathInfo);
    results.push(metrics);
  }
  restoreAiContext(snapshot);
  aiLookaheadBudgetOverride = previousLookaheadOverride;
  if (!silent && typeof console !== "undefined" && console.table) {
    console.table(results);
  }
  return results;
}

function evaluateSeedBatch(seedList, runs = 1) {
  const seeds = Array.isArray(seedList)
    ? seedList
    : typeof seedList === "string"
    ? seedList
        .split(/[\s,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  if (!seeds.length) return [];
  const summaries = seeds.map((seed) => {
    const results = evaluateAiSeed(seed, runs, true);
    if (!results.length) {
      return { seed, predictedAvg: 0, simulatedAvg: 0, bestSimulated: 0, runs: 0 };
    }
    const predictedAvg =
      results.reduce((sum, entry) => sum + (entry.predictedTime || 0), 0) / results.length;
    const simulatedAvg =
      results.reduce((sum, entry) => sum + (entry.simulatedTime || 0), 0) / results.length;
    const bestSimulated = Math.max(...results.map((entry) => entry.simulatedTime || 0));
      const bestResult = results.reduce((prev, entry) => {
        const prevSim = prev?.simulatedTime || 0;
        const entrySim = entry?.simulatedTime || 0;
      return entrySim > prevSim ? entry : prev;
    }, results[0] || {});
    return {
      seed,
      runs: results.length,
      predictedAvg: Number(predictedAvg.toFixed(2)),
      simulatedAvg: Number(simulatedAvg.toFixed(2)),
      bestSimulated: Number(bestSimulated.toFixed(2)),
      branch: bestResult?.branch ?? null
    };
  });
  if (typeof console !== "undefined" && console.table) {
    console.table(summaries);
  }
  return summaries;
}

function setAiWeights(overrides = {}) {
  Object.keys(AI_WEIGHT_DEFAULTS).forEach((key) => {
    aiWeights[key] =
      overrides[key] != null ? Number(overrides[key]) : Number(AI_WEIGHT_DEFAULTS[key]);
  });
  return { ...aiWeights };
}

function resetAiWeights() {
  return setAiWeights({});
}

function sweepAiWeights(seed, samples = 50, options = {}) {
  const runs = options.runs != null ? Math.max(1, options.runs | 0) : 1;
  const weightKeys = Object.keys(AI_WEIGHT_DEFAULTS);
  const ranges = {
    pathTime: 1.5,
    pathTurns: 1.5,
    specialTime: 1.5,
    neutralSpecialTime: 1.5,
    slowTime: 1.5,
    slowStack: 1.5,
    slowInteraction: 1.5,
    blockUsage: 1.5,
    lightningPadPenalty: 1.5,
    beamCrossings: 1.5,
    ...options.ranges
  };
  let varySet = null;
  if (options.varyOnly) {
    const list = Array.isArray(options.varyOnly) ? options.varyOnly : [options.varyOnly];
    varySet = new Set(list.filter((key) => weightKeys.includes(key)));
    if (!varySet.size) varySet = null;
  }
  const snapshot = { ...aiWeights };
  const report = [];
  for (let i = 0; i < samples; i++) {
    const overrides = {};
    weightKeys.forEach((key) => {
      if (varySet && !varySet.has(key)) {
        overrides[key] = Number(AI_WEIGHT_DEFAULTS[key]);
      } else {
        const range = ranges[key] != null ? ranges[key] : 1.5;
        overrides[key] = sampleWeight(AI_WEIGHT_DEFAULTS[key], range);
      }
    });
    setAiWeights(overrides);
    const results = evaluateAiSeed(seed, runs, true);
    if (!results.length) continue;
    const predictedAvg =
      results.reduce((sum, entry) => sum + (entry.predictedTime || 0), 0) / results.length;
    const simulatedAvg =
      results.reduce((sum, entry) => sum + (entry.simulatedTime || 0), 0) / results.length;
    const slowAvg =
      results.reduce((sum, entry) => sum + (entry.slowTime || 0), 0) / results.length;
    const bestSimulated = Math.max(...results.map((entry) => entry.simulatedTime || 0));
    report.push({
      sample: i + 1,
      pathTime: Number(aiWeights.pathTime.toFixed(3)),
      specialTime: Number(aiWeights.specialTime.toFixed(3)),
      neutralSpecialTime: Number(aiWeights.neutralSpecialTime.toFixed(3)),
      slowTime: Number(aiWeights.slowTime.toFixed(3)),
      slowStack: Number(aiWeights.slowStack.toFixed(3)),
      slowInteraction: Number(aiWeights.slowInteraction.toFixed(3)),
      blockUsage: Number(aiWeights.blockUsage.toFixed(3)),
      lightningPadPenalty: Number(aiWeights.lightningPadPenalty.toFixed(3)),
      beamCrossings: Number(aiWeights.beamCrossings.toFixed(3)),
      predictedAvg: Number(predictedAvg.toFixed(2)),
      simulatedAvg: Number(simulatedAvg.toFixed(2)),
      slowAvg: Number(slowAvg.toFixed(2)),
      bestSimulated: Number(bestSimulated.toFixed(2))
    });
  }
  Object.assign(aiWeights, snapshot);
  if (typeof console !== "undefined" && console.table) {
    console.table(report);
    const ranking = rankSweepReport(report, options);
    if (ranking.length) {
      console.log("Top by simulated/objective:", ranking.slice(0, 5));
    }
  }
  return report;
}

function tuneAiWeights(seed, samples = 8, options = {}) {
  const weightKeys = Object.keys(AI_WEIGHT_DEFAULTS);
  const baseline = { ...aiWeights };
  const range = options.range != null ? Number(options.range) : 1.1;
  const gapWeight = options.gapWeight != null ? Number(options.gapWeight) : 0;
  const apply = options.apply !== false;
  let best = { score: -Infinity, weights: baseline, result: null };
  const candidates = [baseline];
  for (let i = 1; i < samples; i++) {
    const candidate = {};
    weightKeys.forEach((key) => {
      candidate[key] = sampleWeight(AI_WEIGHT_DEFAULTS[key], range);
    });
    candidates.push(candidate);
  }
  candidates.forEach((weights, idx) => {
    setAiWeights(weights);
    const results = evaluateAiSeed(seed, 1, true);
    const res = results[0] || {};
    const predicted = res.predictedTime || 0;
    const simulated = res.simulatedTime || 0;
    const gap = Math.abs(simulated - predicted);
    const score = simulated - gapWeight * gap;
    if (score > best.score) {
      best = { score, weights: { ...weights }, result: res, idx };
    }
  });
  if (apply) {
    setAiWeights(best.weights);
  }
  if (typeof console !== "undefined") {
    console.log("tuneAiWeights best", { ...best, applied: apply });
  }
  return { weights: { ...best.weights }, result: best.result, score: best.score };
}

function tuneAiWeightsForSeeds(seeds, samples = 8, options = {}) {
  const seedList = Array.isArray(seeds)
    ? seeds
    : typeof seeds === "string"
    ? seeds
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (!seedList.length) return null;
  const runs = options.runs != null ? Math.max(1, options.runs | 0) : 1;
  const minWeight = options.minWeight != null ? Number(options.minWeight) : 0.4;
  let best = null;
  for (let i = 0; i < samples; i++) {
    const weights =
      i === 0 && options.includeCurrent !== false
        ? { ...aiWeights }
        : sampleWeightsVariant(options.range || 1.0);
    setAiWeights(weights);
    let total = 0;
    let worst = Infinity;
    seedList.forEach((seed) => {
      const result = evaluateAiSeed(seed, runs, true)[0] || {};
      const sim = result.simulatedTime || 0;
      total += sim;
      worst = Math.min(worst, sim);
    });
    const avg = total / seedList.length;
    const score = minWeight * worst + (1 - minWeight) * avg;
    if (!best || score > best.score) {
      best = { score, avg, worst, weights: { ...weights } };
    }
  }
  if (best) setAiWeights(best.weights);
  if (typeof console !== "undefined") {
    console.log("tuneAiWeightsForSeeds best", best);
  }
  return best;
}

function sampleWeightsVariant(range = 1.0) {
  const variant = {};
  Object.keys(AI_WEIGHT_DEFAULTS).forEach((key) => {
    variant[key] = sampleWeight(AI_WEIGHT_DEFAULTS[key], range);
  });
  return variant;
}

function rankSweepReport(report, options = {}) {
  const mode = options.rankBy || "objective";
  const gapWeight = Number.isFinite(options.gapWeight) ? Number(options.gapWeight) : 0.6;
  const bestWeight = Number.isFinite(options.bestSimWeight) ? Number(options.bestSimWeight) : 0.25;
  const sorted = [...report];
  const scorer = (entry) => {
    const sim = entry.simulatedAvg || 0;
    const best = entry.bestSimulated || sim;
    const predicted = entry.predictedAvg || sim;
    const gap = Math.abs(sim - predicted);
    if (mode === "simulated") return sim;
    if (mode === "bestSimulated") return best;
    return sim + bestWeight * (best - sim) - gapWeight * gap;
  };
  sorted.sort((a, b) => scorer(b) - scorer(a));
  return sorted;
}

function sampleWeight(base, range = 0.25) {
  const span = Math.max(0, Number(range));
  const delta = (Math.random() * 2 - 1) * span;
  return Math.max(0, base * (1 + delta));
}

function mapBranchIndex(branchId, branchTotal) {
  if (branchId == null || branchTotal == null) return null;
  if (branchId <= 3) return branchId;
  if (branchTotal - branchId === 2) return -3;
  if (branchTotal - branchId === 1) return -2;
  if (branchTotal - branchId === 0) return -1;
  return null;
}

function normalizeBranch(layout) {
  if (!layout) return null;
  if (layout.branchPlacementIndex != null) return layout.branchPlacementIndex;
  return mapBranchIndex(layout.branchId, layout.branchTotal);
}

function summarizeAiMetrics(seed, layout, pathInfo) {
  if (!pathInfo) {
    return {
      seed,
      distance: 0,
      predictedTime: 0,
      simulatedTime: null,
      padHits: {},
      mandatorySpeeds: 0,
      slowTime: 0,
      slowStack: 0,
      lookaheadUsed: layout?.lookaheadUsed || 0
    };
  }
  const padHits = {};
  pathInfo.path.forEach((node) => {
    if (!isInsideGrid(node.x, node.y)) return;
    const padType = padTypeFromCell(layout.grid[node.y]?.[node.x]);
    if (!padType) return;
    padHits[padType] = (padHits[padType] || 0) + 1;
  });
  const mandatorySpeeds = countMandatorySpeedPads(layout.grid, pathInfo.path);
  const prediction = estimatePredictedRunTime(
    layout.grid,
    pathInfo,
    layout.special,
    state.baseNeutralSpecials
  );
  const components = prediction.components || {
    slowTime: 0,
    slowStackTime: 0,
    specialOwnedTime: 0,
    specialNeutralTime: 0
  };
  const simulated = simulateRunnerTime(layout.grid, layout.special, state.baseNeutralSpecials);
  const blockUsage = computeBlockUsageScore(layout.grid, pathInfo.path);
  const specialInfo = layout.special?.cell
    ? `${layout.special.type}@(${layout.special.cell.x + 1},${layout.special.cell.y + 1})`
    : "none";
  const branchValue = normalizeBranch(layout);
  return {
    seed,
    gridString: JSON.stringify(layout.grid),
    distance: Number(pathInfo.totalDistance.toFixed(0)),
    predictedTime: Number(prediction.time.toFixed(2)),
    simulatedTime: simulated != null ? Number(simulated.toFixed(2)) : null,
    mandatorySpeeds,
    padHits,
    slowTime: Number((components.slowTime || 0).toFixed(2)),
    slowStack: Number((components.slowStackTime || 0).toFixed(2)),
    blockUsage: Number(blockUsage.toFixed(3)),
    special: specialInfo,
    branch: branchValue,
    branchId: layout.branchId || null,
    branchTotal: layout.branchTotal || null
  };
}

function snapshotAiContext() {
  return {
    baseGrid: state.baseGrid ? cloneGrid(state.baseGrid) : null,
    baseNeutralSpecials: state.baseNeutralSpecials?.map(cloneSpecial) || [],
    neutralSpecials: state.neutralSpecials?.map(cloneSpecial) || [],
    coinBudget: state.coinBudget,
    singleBudget: state.singleBudget,
    coins: state.coins,
    singleBlocks: state.singleBlocks,
    specialTemplate: state.specialTemplate ? cloneSpecial(state.specialTemplate) : null,
    aiGrid: state.aiGrid ? cloneGrid(state.aiGrid) : null,
    aiSpecial: state.aiSpecial ? cloneSpecial(state.aiSpecial) : null,
    rng: state.rng,
    seed: state.seed
  };
}

function restoreAiContext(snapshot) {
  if (!snapshot) return;
  state.baseGrid = snapshot.baseGrid ? cloneGrid(snapshot.baseGrid) : null;
  state.baseNeutralSpecials = snapshot.baseNeutralSpecials.map(cloneSpecial);
  state.neutralSpecials = snapshot.neutralSpecials.map(cloneSpecial);
  state.coinBudget = snapshot.coinBudget;
  state.singleBudget = snapshot.singleBudget;
  state.coins = snapshot.coins;
  state.singleBlocks = snapshot.singleBlocks;
  state.specialTemplate = snapshot.specialTemplate ? cloneSpecial(snapshot.specialTemplate) : null;
  state.aiGrid = snapshot.aiGrid ? cloneGrid(snapshot.aiGrid) : null;
  state.aiSpecial = snapshot.aiSpecial ? cloneSpecial(snapshot.aiSpecial) : null;
  state.rng = snapshot.rng;
  state.seed = snapshot.seed;
}

if (typeof window !== "undefined") {
  window.evaluateAiSeed = evaluateAiSeed;
  window.evaluateSeedBatch = evaluateSeedBatch;
  window.setAiWeights = setAiWeights;
  window.resetAiWeights = resetAiWeights;
  window.sweepAiWeights = sweepAiWeights;
  window.tuneAiWeights = tuneAiWeights;
  window.tuneAiWeightsForSeeds = tuneAiWeightsForSeeds;
  window.sampleWeightsVariant = sampleWeightsVariant;
  window.getAiWeights = () => ({ ...aiWeights });
  window.previewGridMetrics = previewGridMetrics;
  window.getAiProfile = () => state.aiProfile || null;
  window.getOutmazePerformance = () => ({
    ...state.performance,
    aiProfile: state.aiProfile ? { ...state.aiProfile } : null,
    rulesVersion: AICore.rulesVersion
  });
  window.vsConnect = vsConnect;
  window.vsCreateRoom = vsCreateRoom;
  window.vsJoinRoom = vsJoinRoom;
  window.vsReady = vsReady;
  window.vsSendMaze = vsSendMaze;
}

function previewGridMetrics(gridArray, specialSpec = null, neutralSpecials = null) {
  const grid = cloneGrid(gridArray);
  const special =
    specialSpec && specialSpec.type && specialSpec.x != null && specialSpec.y != null
      ? {
          type: specialSpec.type,
          placed: true,
          cell: { x: Number(specialSpec.x), y: Number(specialSpec.y) },
          effectTimer: 0,
          cooldown: 0,
          flashTimer: 0
        }
      : null;
  const neutrals =
    neutralSpecials != null
      ? neutralSpecials.map((ns) => (ns ? cloneSpecial(ns) : null)).filter(Boolean)
      : state.baseNeutralSpecials;
  const pathInfo = analyzePath(grid);
  const score = evaluateGridForAi(grid, special, neutrals, pathInfo);
  const prediction = estimatePredictedRunTime(grid, pathInfo, special, neutrals);
  const simulatedTime = simulateRunnerTime(grid, special, neutrals);
  return {
    score,
    predictedTime: prediction.time || 0,
    baseTime: prediction.baseTime || 0,
    slowTime: prediction.components?.slowTime || 0,
    slowStack: prediction.components?.slowStackTime || 0,
    specialOwned: prediction.components?.specialOwnedTime || 0,
    specialNeutral: prediction.components?.specialNeutralTime || 0,
    lightningPenalty: prediction.lightningPenalty || 0,
    pathDistance: pathInfo?.totalDistance || 0,
    special: special ? `${special.type}@(${special.cell.x + 1},${special.cell.y + 1})` : "none",
    simulatedTime
  };
}

function updateRace(delta) {
  if (!state.race) return;
  const computeStartedAt = performance.now();
  state.race.elapsedTime += delta;
  state.race.runners.forEach((runner) => {
    if (runner.finished) return;
    if (!runner.path.length) {
      runner.finished = true;
      recordResult(runner, null);
      return;
    }
    coreAdvanceRunnerSimulation(runner, delta);
    if (runner.finished) recordResult(runner, runner.resultTime);
  });
  state.race.simulationComputeMs += performance.now() - computeStartedAt;
  if (state.race.finished) return;
  const allFinished = state.race.runners.every((runner) => runner.finished);
  if (allFinished) {
    state.race.finished = true;
    const playerTime = state.results.player ?? 0;
    const aiTime = state.results.ai ?? 0;
    state.race.elapsed = Math.max(playerTime, aiTime);
    state.race.elapsedTime = state.race.elapsed;
    state.performance.simulationMs = state.race.simulationComputeMs;
    if (state.daily.active) {
      finishDailyAttempt();
    } else {
      decideWinner();
      updatePhaseLabel("Round complete", "Compare the escape times, then refine this seed or begin another.");
    }
  }
}

async function finishDailyAttempt() {
  if (!state.daily.active || state.daily.submitting) return;
  state.daily.submitting = true;
  window.OutmazeOnline?.updateDailyPanel?.();
  updatePhaseLabel("Verifying Daily time", "Checking this maze with the shared server rules.");
  try {
    const result = await window.OutmazeOnline?.completeDailyAttempt?.({
      grid: cloneGrid(state.playerGrid),
      special: cloneSpecial(state.playerSpecial)
    });
    if (!result) throw new Error("The Daily result could not be verified");
    state.results.player = Number(result.submittedTime);
    state.results.ai = Number(state.daily.challenge?.aiTime || result.aiTime || 0);
    const player = state.results.player;
    const ai = state.results.ai;
    state.results.winner = player > ai ? "You win!" : player < ai ? `${getOpponentLabel()} wins!` : "Tie!";
    state.race.elapsed = player;
    state.race.elapsedTime = player;
    state.daily.attemptComplete = true;
    updatePhaseLabel("Daily attempt complete", "Modify this maze and try again—your best verified time is saved.");
    showResultPopup();
  } catch (error) {
    state.results.winner = "Verification failed";
    updatePhaseLabel("Daily result not saved", error.message || "Please try this attempt again.");
    window.OutmazeOnline?.showDailyError?.(error);
  } finally {
    state.daily.submitting = false;
    window.OutmazeOnline?.updateDailyPanel?.();
  }
}

function recordResult(runner, time) {
  const isSelf = runner.label === "You" || runner.label.startsWith("You ·");
  if (isSelf) {
    state.results.player = time;
  } else {
    state.results.ai = time;
  }
}

function decideWinner() {
  const player = state.results.player;
  const ai = state.results.ai;
  const oppLabel = getOpponentLabel();
  if (player == null && ai == null) {
    state.results.winner = "No valid runs";
  } else if (player == null) {
    state.results.winner = `${oppLabel} wins!`;
  } else if (ai == null) {
    state.results.winner = "You win!";
  } else if (player > ai) {
    state.results.winner = "You win!";
  } else if (player < ai) {
    state.results.winner = `${oppLabel} wins!`;
  } else {
    state.results.winner = "Tie!";
  }
  resetVsEarlyStartVotes();
  if (state.vs.active) updateVsStatus("Round complete. Choose how both players should continue.");
  updateVsPanelState();
  showResultPopup();
}

function updateState(delta) {
  padPulseTimer = (padPulseTimer + delta) % PAD_PULSE_PERIOD;
  if (state.building) {
    if (!state.paused) {
      if (state.party.active && state.party.buildEndsAt) {
        state.buildTimeLeft = Math.max(0, (state.party.buildEndsAt - Date.now()) / 1000);
      } else if (!state.vs.active) {
        const clock = AICore.advanceBuildClock(state.buildTimeLeft, delta);
        state.buildTimeLeft = clock.timeLeft;
        if (clock.expired) {
          startRace(true);
        }
      } else if (state.vs.buildEndsAt) {
        const now = Date.now();
        state.buildTimeLeft = Math.max(0, (state.vs.buildEndsAt - now) / 1000);
      }
    }
  } else if (state.reveal?.active && !state.paused) {
    state.reveal.elapsed = Math.min(state.reveal.duration, state.reveal.elapsed + delta);
    if (state.reveal.elapsed >= state.reveal.duration) {
      state.reveal.active = false;
      if (state.race) state.race.started = true;
      revealBanner?.classList.add("hidden");
      updatePhaseLabel(
        state.daily.active ? "Daily run in progress" : "Race in progress",
        state.daily.active ? "Push this maze beyond the hidden AI design’s benchmark time." : "The longest escape time wins."
      );
      if (state.vs.active) updateVsStatus("Race in progress. The longest escape time wins.");
      announce(state.daily.active ? "Daily runner released." : "Runners released.");
    }
  } else if (state.race && !state.paused && !state.race.finished) {
    updateRace(delta);
  }
  updateFloatingTexts(delta);
  updateHud();
}
function updateHud() {
  if (state.mode === "menu") {
    timerEl.textContent = "--";
    timerStatusEl.textContent = "Awaiting run";
    if (scoreEl) scoreEl.textContent = "Score: --";
    updateResourceCards();
    return;
  }

  if (state.party.active && ["connecting", "connected", "lobby"].includes(state.party.phase)) {
    timerEl.textContent = "--";
    timerStatusEl.textContent = "Waiting for party";
    if (scoreEl) scoreEl.textContent = formatScoreText();
    updateResourceCards();
    return;
  }

  if (state.party.active && state.party.phase === "results") {
    timerEl.textContent = "--";
    timerStatusEl.textContent = "Party results";
    if (scoreEl) scoreEl.textContent = formatScoreText();
    updateResourceCards();
    return;
  }

  if (state.vs.active && state.vs.waitingForStart) {
    timerEl.textContent = "--";
    timerStatusEl.textContent = "Waiting for other player";
    if (scoreEl) scoreEl.textContent = "Score: --";
    updateResourceCards();
    return;
  }

  if (state.paused) {
    timerEl.textContent = "--";
    timerStatusEl.textContent = "Paused";
  } else if (state.building) {
    if (state.party.active && state.party.buildEndsAt) {
      state.buildTimeLeft = Math.max(0, (state.party.buildEndsAt - Date.now()) / 1000);
    } else if (state.vs.active && state.vs.buildEndsAt) {
      const now = Date.now();
      const remaining = Math.max(0, (state.vs.buildEndsAt - now) / 1000);
      state.buildTimeLeft = remaining;
    }
    timerEl.textContent = `${Math.max(0, state.buildTimeLeft).toFixed(1)}s`;
    timerStatusEl.textContent = state.party.active ? "Party build phase" : state.vs.active ? "VS build phase" : state.daily.active ? "Daily build phase" : "Build phase";
  } else if (state.reveal?.active) {
    timerEl.textContent = "--";
    timerStatusEl.textContent = "Revealing mazes";
  } else if (!state.building && !state.race && !state.vs.active) {
    timerEl.textContent = "--";
    timerStatusEl.textContent = "Preparing reveal";
  } else if (state.race && !state.race.finished) {
    const elapsed = state.race.elapsedTime || 0;
    timerEl.textContent = `${elapsed.toFixed(1)}s`;
    timerStatusEl.textContent = state.vs.active ? "VS race in progress" : state.daily.active ? "Daily run in progress" : "Race in progress";
  } else if (state.race && state.race.finished && state.race.elapsed !== null) {
    timerEl.textContent = `${state.race.elapsed.toFixed(1)}s`;
    timerStatusEl.textContent = state.vs.active ? "VS race complete" : state.daily.active ? "Daily attempt complete" : "Race complete";
  } else {
    timerEl.textContent = "--";
    timerStatusEl.textContent = "Ready";
  }
  timerEl.classList.toggle("timer-warning", state.building && state.buildTimeLeft <= 20);
  if (scoreEl) scoreEl.textContent = formatScoreText();
  updateResourceCards();
}

function updateResourceCards() {
  if (!wallsValueEl || !specialValueEl) return;
  if (state.mode === "menu") {
    wallsValueEl.textContent = "--";
    if (singleValueEl) singleValueEl.textContent = "--";
    specialValueEl.textContent = "--";
    updateCurrencySelection(true);
    return;
  }
  wallsValueEl.textContent = state.coins != null ? state.coins : "--";
  if (singleValueEl) {
    singleValueEl.textContent = state.singleBlocks != null ? state.singleBlocks : "--";
  }
  const specialsRemaining = state.playerSpecial?.placed ? 0 : 1;
  specialValueEl.textContent = specialsRemaining.toString();
  updateCurrencySelection();
}

function updateCurrencySelection(forceDisabled = false) {
  if (wallsCard) {
    const canUseWalls = !forceDisabled && state.building && state.coins > 0;
    wallsCard.classList.toggle("disabled", !canUseWalls);
    wallsCard.classList.toggle("active", state.building && state.buildMode === "normal" && canUseWalls);
    wallsCard.disabled = !canUseWalls;
    wallsCard.setAttribute("aria-pressed", String(state.building && state.buildMode === "normal" && canUseWalls));
  }
  if (singleCard) {
    const canUseSingle = !forceDisabled && state.building && state.singleBlocks > 0;
    const isActive = state.building && state.buildMode === "single" && canUseSingle;
    singleCard.classList.toggle("disabled", !canUseSingle);
    singleCard.classList.toggle("active", isActive);
    singleCard.disabled = !canUseSingle;
    singleCard.setAttribute("aria-pressed", String(isActive));
  }
  if (specialCard) {
    const canUseSpecial = !forceDisabled && state.building && !state.playerSpecial?.placed;
    const isActive = state.building && state.buildMode === "special" && canUseSpecial;
    specialCard.classList.toggle("disabled", !canUseSpecial);
    specialCard.classList.toggle("active", isActive);
    specialCard.disabled = !canUseSpecial;
    specialCard.setAttribute("aria-pressed", String(isActive));
  }
  updateStartRaceControl();
}

function getOpponentLabel() {
  if (state.daily.active) return "Daily AI";
  return state.vs.active ? state.vs.oppLabel || "Opponent" : "AI";
}

function formatScoreText() {
  if (state.party.active) {
    const uid = window.OutmazeAccount?.profile?.uid;
    const self = state.party.members.find((member) => member.uid === uid);
    const score = Number(state.party.liveScores?.[uid] ?? self?.score ?? 0);
    return `Placement points: ${score.toFixed(score % 1 ? 1 : 0)}`;
  }
  const finished = !!(state.race && state.race.finished);
  const formatVal = (val) => {
    if (val == null) return finished ? "DNF" : "--";
    return `${val.toFixed(2)}s`;
  };
  const playerText = formatVal(state.results.player);
  const foeText = formatVal(state.results.ai);
  const oppLabel = getOpponentLabel();
  if (state.daily.active) return `Score: You ${playerText} | AI benchmark ${foeText}`;
  return `Score: You ${playerText} | ${oppLabel} ${foeText}`;
}

function formatLabelScore(label) {
  const finished = !!(state.race && state.race.finished);
  const valFor = (val) => {
    if (val == null) return finished ? " (DNF)" : " (--)";
    return ` (${val.toFixed(2)}s)`;
  };
  if (label.startsWith("You")) {
    return valFor(state.results.player);
  }
  if (label.startsWith("AI") || label.startsWith("Foe") || label.startsWith("Opponent")) {
    return valFor(state.results.ai);
  }
  return "";
}


function draw() {
  if (state.party.active && state.party.phase === "results") return;
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const views = getViewsForRender();
  views.forEach((view, index) => {
    const offsetX = index === 0 ? 0 : VIEW_RENDER_WIDTH + VIEW_GAP;
    if (state.reveal?.active && index === 1) {
      const progress = revealProgress();
      const eased = 1 - Math.pow(1 - progress, 3);
      ctx.save();
      ctx.globalAlpha = eased;
      ctx.translate((1 - eased) * 80, 0);
      drawView(view, offsetX);
      ctx.restore();
    } else {
      drawView(view, offsetX);
    }
  });
  if (state.building) {
    drawHoverPreview();
  }
  drawFloatingTexts();
}

function getViewsForRender() {
  if (state.building) {
    return [
      {
        label: "You",
        grid: state.playerGrid,
        special: state.playerSpecial,
        runner: null,
        overlay: null,
        neutralSpecials: state.neutralSpecials
      }
    ];
  }
  if (state.race) {
    return state.race.runners.map((runner) => ({
      label: runner.label,
      grid: runner.grid,
      special: runner.special,
      runner,
      neutralSpecials: runner.neutralSpecials || state.neutralSpecials
    }));
  }
  return [
    {
      label: "You",
      grid: state.playerGrid,
      special: state.playerSpecial,
      runner: null,
      neutralSpecials: state.neutralSpecials
    },
    {
      label: "AI",
      grid: state.aiGrid || state.baseGrid,
      special: state.aiSpecial,
      runner: null,
      neutralSpecials: state.neutralSpecials
    }
  ];
}

function drawView(view, offsetX, options = {}) {
  ctx.save();
  ctx.translate(offsetX != null ? offsetX : view.offset || 0, 0);
  ctx.fillStyle = "#0b0b0b";
  ctx.fillRect(0, 0, VIEW_RENDER_WIDTH, VIEW_HEIGHT);

  ctx.save();
  ctx.translate(VIEW_BORDER, 0);
  if (view.grid) {
    drawGridFrame();
    ctx.save();
    ctx.beginPath();
    ctx.rect(1, GRID_OFFSET_Y - CELL_SIZE + 1, VIEW_WIDTH - 2, (GRID_SIZE + 2) * CELL_SIZE - 2);
    ctx.clip();
    const neutralSpecials = view.neutralSpecials || [];
    neutralSpecials.forEach((spec) => drawSpecialOverlay({ ...spec, dimmed: true }));
    if (view.special?.placed) {
      drawSpecialOverlay(view.special);
    }
    drawCells(view.grid, view.special, neutralSpecials);
    drawEntrances();
    drawGridLines();
    if (view.runner && view.runner.worldPos) {
      const pos = view.runner.worldPos;
      ctx.fillStyle = view.runner.label === "You" ? "#ffcc00" : "#f19d38";
      ctx.beginPath();
      ctx.arc(pos.x * CELL_SIZE, GRID_OFFSET_Y + pos.y * CELL_SIZE, CELL_SIZE * NPC_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    drawGridOutline();
  }
  ctx.restore();

  if (view.overlay) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillRect(0, 0, VIEW_RENDER_WIDTH, VIEW_HEIGHT);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = "14px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(view.overlay, VIEW_RENDER_WIDTH / 2, VIEW_HEIGHT - 40);
    ctx.textAlign = "left";
  }

  if (!options.hideLabel && !state.building && view.label.startsWith("AI")) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
    ctx.fillRect(0, 0, VIEW_RENDER_WIDTH, VIEW_HEIGHT);
  }

  if (!options.hideLabel) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "16px system-ui";
    ctx.textBaseline = "top";
    ctx.fillText(`${view.label}${formatLabelScore(view.label)}`, VIEW_BORDER + 10, 8);
  }

  ctx.restore();
}

let renderingCompactPreview = false;

function renderMazePreview(targetContext, view) {
  if (!targetContext?.canvas || !view?.grid) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, VIEW_RENDER_WIDTH, VIEW_HEIGHT);
  renderingCompactPreview = true;
  try {
    drawView({
      label: "",
      grid: view.grid,
      special: view.special,
      runner: view.runner || null,
      neutralSpecials: view.neutralSpecials || []
    }, 0, { hideLabel: true });
  } finally {
    renderingCompactPreview = false;
  }
  ctx.restore();

  targetContext.save();
  targetContext.setTransform(1, 0, 0, 1, 0, 0);
  targetContext.clearRect(0, 0, targetContext.canvas.width, targetContext.canvas.height);
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = "high";
  targetContext.drawImage(
    canvas,
    0,
    0,
    VIEW_RENDER_WIDTH,
    VIEW_HEIGHT,
    0,
    0,
    targetContext.canvas.width,
    targetContext.canvas.height
  );
  targetContext.restore();
}

window.OutmazeRendering = Object.freeze({ renderMazePreview });

function drawSpecialOverlay(special) {
  ctx.save();
  if (special.dimmed) {
    ctx.globalAlpha *= 0.6;
  }
  if (special.type === "radius") {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, GRID_OFFSET_Y, VIEW_WIDTH, GRID_SIZE * CELL_SIZE);
    ctx.clip();
    const centerX = (special.cell.x + 0.5) * CELL_SIZE;
    const centerY = GRID_OFFSET_Y + (special.cell.y + 0.5) * CELL_SIZE;
    const radius = (SPECIAL_RADIUS + 0.5) * CELL_SIZE;
    const innerRadius = radius - 6;
    const outerRingGrad = ctx.createRadialGradient(centerX, centerY, innerRadius, centerX, centerY, radius);
    outerRingGrad.addColorStop(0, "rgba(255,255,255,0.015)");
    outerRingGrad.addColorStop(1, "rgba(120, 190, 255, 0.14)");
    ctx.fillStyle = outerRingGrad;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2, true);
    ctx.fill();

    const innerGlow = ctx.createRadialGradient(centerX, centerY, innerRadius * 0.2, centerX, centerY, innerRadius * 0.9);
    innerGlow.addColorStop(0, "rgba(200, 235, 255, 0.08)");
    innerGlow.addColorStop(1, "rgba(200, 235, 255, 0)");
    ctx.fillStyle = innerGlow;
    ctx.beginPath();
    ctx.arc(centerX, centerY, innerRadius * 0.9, 0, Math.PI * 2);
    ctx.fill();
    drawSnowflake(centerX, centerY, innerRadius * 0.8);
    drawIcyArrows(centerX, centerY, innerRadius);
    ctx.restore();
  } else if (special.type === "gravity") {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, GRID_OFFSET_Y, VIEW_WIDTH, GRID_SIZE * CELL_SIZE);
    ctx.clip();
    const centerX = (special.cell.x + 0.5) * CELL_SIZE;
    const centerY = GRID_OFFSET_Y + (special.cell.y + 0.5) * CELL_SIZE;
    const radius = GRAVITY_RADIUS * CELL_SIZE;
    const grad = ctx.createRadialGradient(centerX, centerY, radius * 0.2, centerX, centerY, radius);
    grad.addColorStop(0, "rgba(150, 90, 220, 0.35)");
    grad.addColorStop(1, "rgba(60, 20, 80, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (special.type === "lightning") {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, GRID_OFFSET_Y, VIEW_WIDTH, GRID_SIZE * CELL_SIZE);
    ctx.clip();
    const centerX = (special.cell.x + 0.5) * CELL_SIZE;
    const centerY = GRID_OFFSET_Y + (special.cell.y + 0.5) * CELL_SIZE;
    const ratio = 1 - Math.min(1, (special.cooldown || 0) / LIGHTNING_COOLDOWN);
    const radius = LIGHTNING_EFFECT_RADIUS * CELL_SIZE;
    const ready = (special.cooldown || 0) <= 0;
    const colorReady = "rgba(255,215,130,0.15)";
    const colorInactive = "rgba(140,140,160,0.05)";
    ctx.shadowColor = ready ? "rgba(255,230,150,0.35)" : "rgba(200,210,250,0.15)";
    ctx.shadowBlur = ready ? 18 : 8;
    ctx.strokeStyle = ready ? colorReady : colorInactive;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();
    if (!ready) {
      const spokes = 10;
      for (let i = 0; i < spokes; i++) {
        const angle = (Math.PI * 2 * i) / spokes;
        const len = radius * ratio;
        // grey guide
        ctx.strokeStyle = "rgba(120,120,140,0.02)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius);
        ctx.stroke();
        if (len > 0) {
          // gold fill growing outward from center
          ctx.shadowColor = "rgba(255,230,160,0.3)";
          ctx.shadowBlur = 16;
          ctx.strokeStyle = "rgba(255,215,130,0.12)";
          ctx.beginPath();
          ctx.moveTo(centerX, centerY);
          ctx.lineTo(centerX + Math.cos(angle) * len, centerY + Math.sin(angle) * len);
          ctx.stroke();
          ctx.shadowBlur = ready ? 18 : 8;
          ctx.shadowColor = ready ? "rgba(255,230,150,0.35)" : "rgba(200,210,250,0.15)";
        }
      }
    }
    if (ready || (special.flashTimer || 0) > 0) {
      drawLightningBolts(centerX, centerY, radius, ratio, (special.flashTimer || 0) > 0);
      if ((special.flashTimer || 0) > 0) {
        drawElectricStun(centerX, centerY, radius * 0.5, ratio);
      }
    }
    ctx.restore();
  } else if (special.type === "row") {
    const y = GRID_OFFSET_Y + special.cell.y * CELL_SIZE;
    const innerY = y + CELL_SIZE * 0.25;
    const innerH = CELL_SIZE * 0.5;
    const grad = ctx.createLinearGradient(0, innerY, 0, innerY + innerH);
    grad.addColorStop(0, "rgba(150, 110, 220, 0.14)");
    grad.addColorStop(0.5, "rgba(210, 160, 255, 0.28)");
    grad.addColorStop(1, "rgba(150, 110, 220, 0.14)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, innerY, VIEW_WIDTH, innerH);
  } else if (special.type === "column") {
    const x = special.cell.x * CELL_SIZE;
    const innerX = x + CELL_SIZE * 0.25;
    const innerW = CELL_SIZE * 0.5;
    const grad = ctx.createLinearGradient(innerX, 0, innerX + innerW, 0);
    grad.addColorStop(0, "rgba(150, 110, 220, 0.14)");
    grad.addColorStop(0.5, "rgba(210, 160, 255, 0.28)");
    grad.addColorStop(1, "rgba(150, 110, 220, 0.14)");
    ctx.fillStyle = grad;
    ctx.fillRect(innerX, GRID_OFFSET_Y, innerW, GRID_SIZE * CELL_SIZE);
  }
  ctx.restore();
}

function drawCells(grid, specialForGrid, neutralSpecials = []) {
  if (!grid) return;
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const cell = grid[y][x];
      if (cell === CELL_EMPTY) continue;
      if (cell === CELL_STATIC) {
        drawStaticBlockSprite(x, y);
        continue;
      }
      if (cell === CELL_PLAYER) {
        drawPlayerBlockSprite(x, y);
        continue;
      }
      if (cell === CELL_SINGLE) {
        drawSingleBlockSprite(x, y);
        continue;
      }
      if (cell === CELL_SPECIAL) {
        const palette = specialPaletteForCell(specialForGrid, x, y);
        drawSpecialBlockSprite(x, y, palette);
        continue;
      }
      if (cell === CELL_STATIC_SPECIAL) {
        const palette = neutralPaletteForCell(neutralSpecials, x, y);
        drawSpecialBlockSprite(x, y, palette);
        continue;
      }
      if (isPadCell(cell)) {
        drawPadPlate(cell, x, y);
        continue;
      }
      ctx.fillStyle = cellColor(cell);
      ctx.fillRect(x * CELL_SIZE, GRID_OFFSET_Y + y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }
  }
}

function specialPaletteForCell(special, x, y) {
  if (!special?.placed || !special.cell) return null;
  if (special.cell.x !== x || special.cell.y !== y) return null;
  if (special.type === "radius") {
    return {
      outer: "#1c2f4f",
      inner: "#8ad0ff",
      border: "#1c4f8c",
      highlight: "rgba(255,255,255,0.25)",
      glyph: "✶",
      glyphScale: 1.5,
      glyphOffsetPx: { x: 0, y: 0.8 }
    };
  }
  if (special.type === "row" || special.type === "column") {
    return {
      outer: "#4e2a74",
      inner: "#b98cff",
      border: "#110517",
      highlight: "rgba(255,255,255,0.2)",
      arrow: special.type === "row" ? "horizontal" : "vertical"
    };
  }
  if (special.type === "gravity") {
    return {
      outer: "#2a0b3f",
      inner: "#9059d6",
      border: "#120620",
      highlight: "rgba(255,255,255,0.15)",
      glyph: "⊙",
      glyphScale: 0.88,
      glyphOffsetPx: { x: -0.6, y: 0.8 }
    };
  }
  if (special.type === "lightning") {
    return {
      outer: "#5a3b04",
      inner: "#ffcb64",
      border: "#1e1100",
      highlight: "rgba(255,255,255,0.22)",
      glyph: "Ψ",
      glyphScale: 1,
      glyphOffsetPx: { x: 0, y: 1.2 }
    };
  }
  return null;
}

function neutralPaletteForCell(neutralSpecials, x, y) {
  const target = findNeutralSpecial(neutralSpecials, x, y);
  if (!target)
    return {
      outer: "#2c2c2c",
      inner: "#5a5a5a",
      border: "#101010",
      highlight: "rgba(255,255,255,0.08)",
      glyph: "?"
    };
  if (target.type === "row" || target.type === "column") {
    return {
      outer: "#392048",
      inner: "#7a5a9e",
      border: "#110517",
      highlight: "rgba(255,255,255,0.12)",
      arrow: target.type === "row" ? "horizontal" : "vertical"
    };
  }
  if (target.type === "lightning") {
    return {
      outer: "#5a4a1c",
      inner: "#c7a956",
      border: "#1f1604",
      highlight: "rgba(255,255,255,0.12)",
      glyph: "Ψ",
      glyphOffsetPx: { x: 0, y: 2 }
    };
  }
  return {
    outer: "#2c2c2c",
    inner: "#5a5a5a",
    border: "#101010",
    highlight: "rgba(255,255,255,0.08)",
    glyph: "?",
    glyphColor: "#f5f5f5"
  };
}

function cellColor(cell) {
  switch (cell) {
    case CELL_STATIC:
      return "#6a6a6a";
    case CELL_PLAYER:
      return "#2ba84a";
    case CELL_SINGLE:
      return "#8a8a8a";
    case CELL_SPEED:
      return "rgba(240, 80, 80, 0.95)";
    case CELL_SLOW:
      return "rgba(80, 140, 255, 0.95)";
    case CELL_SPEED_USED:
      return "rgba(240, 80, 80, 0.25)";
    case CELL_SLOW_USED:
      return "rgba(80, 140, 255, 0.25)";
    case CELL_SPECIAL:
      return "#f5d06b";
    default:
      return "#777";
  }
}

function drawEntrances() {
  drawEntranceCell(ENTRANCE_X, -1, "F");
  drawEntranceCell(ENTRANCE_X, GRID_SIZE, "S");
}

function drawEntranceCell(gridX, gridY, label) {
  const baseX = gridX * CELL_SIZE;
  const baseY = GRID_OFFSET_Y + gridY * CELL_SIZE;
  ctx.fillStyle = "#090909";
  ctx.fillRect(baseX, baseY, CELL_SIZE, CELL_SIZE);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.strokeRect(baseX + 0.5, baseY + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
  ctx.fillStyle = "#f1f1f1";
  ctx.font = "bold 15px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, baseX + CELL_SIZE / 2, baseY + CELL_SIZE / 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawGridFrame() {
  ctx.fillStyle = "#000000";
  ctx.fillRect(-VIEW_BORDER, GRID_OFFSET_Y - CELL_SIZE, VIEW_WIDTH + VIEW_BORDER * 2, CELL_SIZE);
  ctx.fillRect(-VIEW_BORDER, GRID_OFFSET_Y + GRID_SIZE * CELL_SIZE, VIEW_WIDTH + VIEW_BORDER * 2, CELL_SIZE);
  ctx.fillRect(-VIEW_BORDER, GRID_OFFSET_Y - CELL_SIZE, VIEW_BORDER, (GRID_SIZE + 2) * CELL_SIZE);
  ctx.fillRect(VIEW_WIDTH, GRID_OFFSET_Y - CELL_SIZE, VIEW_BORDER, (GRID_SIZE + 2) * CELL_SIZE);
}

function drawGridOutline() {
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 2;
  const left = 0.5;
  const right = VIEW_WIDTH - 0.5;
  const top = GRID_OFFSET_Y + 0.5;
  const bottom = GRID_OFFSET_Y + GRID_SIZE * CELL_SIZE - 0.5;
  const bumpTop = top - CELL_SIZE;
  const bumpBottom = bottom + CELL_SIZE;
  const entryLeft = ENTRANCE_X * CELL_SIZE + 0.5;
  const entryRight = (ENTRANCE_X + 1) * CELL_SIZE - 0.5;

  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(entryLeft, top);
  ctx.lineTo(entryLeft, bumpTop);
  ctx.lineTo(entryRight, bumpTop);
  ctx.lineTo(entryRight, top);
  ctx.lineTo(right, top);
  ctx.lineTo(right, bottom);
  ctx.lineTo(entryRight, bottom);
  ctx.lineTo(entryRight, bumpBottom);
  ctx.lineTo(entryLeft, bumpBottom);
  ctx.lineTo(entryLeft, bottom);
  ctx.lineTo(left, bottom);
  ctx.closePath();
  ctx.stroke();
}

function drawGridLines() {
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= GRID_SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(0, GRID_OFFSET_Y + i * CELL_SIZE);
    ctx.lineTo(VIEW_WIDTH, GRID_OFFSET_Y + i * CELL_SIZE);
    ctx.stroke();
  }
  for (let i = 0; i <= GRID_SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL_SIZE, GRID_OFFSET_Y);
    ctx.lineTo(i * CELL_SIZE, GRID_OFFSET_Y + GRID_SIZE * CELL_SIZE);
    ctx.stroke();
  }
}

function drawHoverPreview() {
  if (!state.hoverCell) return;
  ctx.save();
  ctx.translate(VIEW_BORDER, 0);
  ctx.beginPath();
  ctx.rect(1, GRID_OFFSET_Y - CELL_SIZE + 1, VIEW_WIDTH - 2, (GRID_SIZE + 2) * CELL_SIZE - 2);
  ctx.clip();
  const { x, y } = state.hoverCell;
  if (state.buildMode === "special") {
    if (!state.playerSpecial || state.playerSpecial.placed || !isCellAvailableForSpecial(state.playerGrid, x, y)) {
      ctx.restore();
      return;
    }
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillRect(x * CELL_SIZE, GRID_OFFSET_Y + y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    drawSpecialOverlay({ type: state.playerSpecial.type, cell: { x, y } });
  } else if (state.buildMode === "single") {
    if (!canPlaceSingle(state.playerGrid, x, y)) {
      ctx.restore();
      return;
    }
    const out = state.singleBlocks <= 0;
    ctx.fillStyle = out ? "rgba(255, 80, 80, 0.35)" : "rgba(255,255,255,0.15)";
    ctx.fillRect(x * CELL_SIZE, GRID_OFFSET_Y + y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
  } else {
    if (!canPlaceBlock(state.playerGrid, x, y)) {
      ctx.restore();
      return;
    }
    const outOfWalls = state.coins <= 0;
    ctx.fillStyle = outOfWalls ? "rgba(255, 80, 80, 0.4)" : "rgba(255,255,255,0.15)";
    ctx.fillRect(x * CELL_SIZE, GRID_OFFSET_Y + y * CELL_SIZE, CELL_SIZE * 2, CELL_SIZE * 2);
  }
  ctx.restore();
}

function drawFloatingTexts() {
  ctx.font = "16px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  state.floatingTexts.forEach((t) => {
    ctx.fillStyle = applyAlpha(t.color || "#ff9999", Math.min(1, t.life));
    ctx.fillText(t.text, t.x, t.y);
  });
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function pointerToGrid(evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const px = (evt.clientX - rect.left) * scaleX;
  const py = (evt.clientY - rect.top) * scaleY;
  if (px < VIEW_BORDER || px > VIEW_BORDER + VIEW_WIDTH) return null;
  const gridX = Math.floor((px - VIEW_BORDER) / CELL_SIZE);
  const gridY = Math.floor((py - GRID_OFFSET_Y) / CELL_SIZE);
  if (gridX < 0 || gridX >= GRID_SIZE) return null;
  if (gridY < 0 || gridY >= GRID_SIZE) return null;
  return { x: gridX, y: gridY };
}

function updateFloatingTexts(delta) {
  state.floatingTexts = state.floatingTexts
    .map((t) => ({ ...t, life: t.life - delta, y: t.y - delta * 40 }))
    .filter((t) => t.life > 0);
}

function addFloatingText(text, evt, color) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (evt.clientX - rect.left) * scaleX;
  const y = (evt.clientY - rect.top) * scaleY;
  state.floatingTexts.push({ text, x, y, life: 1.2, color });
}

function getSpecialTypeName(type) {
  if (type === "radius") return "Freezing Field";
  if (type === "row") return "Horizontal Slow Beam";
  if (type === "column") return "Vertical Slow Beam";
  if (type === "gravity") return "Pressure Field";
  if (type === "lightning") return "Lightning Strike";
  return "Unknown Hazard";
}


function updateSpecialInfo() {
  if (!state.playerSpecial) {
    if (specialCardName) specialCardName.textContent = "Hazard";
    if (specialCardEffect) specialCardEffect.textContent = "Signature disruption";
    updateResourceCards();
    renderSpecialPreview();
    return;
  }
  if (specialCardName) specialCardName.textContent = getSpecialTypeName(state.playerSpecial.type);
  if (specialCardEffect) {
    const labels = {
      radius: "Accumulating freeze",
      row: "Horizontal slow beam",
      column: "Vertical slow beam",
      gravity: "Proximity pressure",
      lightning: "Area stun"
    };
    specialCardEffect.textContent = labels[state.playerSpecial.type] || "Signature disruption";
  }
  updateResourceCards();
  renderSpecialPreview();
  updateToolDetail();
  updateStartRaceControl();
}

function updatePhaseLabel(text, hint = null) {
  if (phaseEl) phaseEl.textContent = text;
  if (phaseHintEl && hint != null) phaseHintEl.textContent = hint;
}

function showPopupContent({ mode, emoji, message }) {
  currentPopupMode = mode;
  if (popupEyebrowEl) popupEyebrowEl.textContent = mode === "result" ? "Round complete" : "Opponent building";
  popupEmojiEl.textContent = emoji;
  popupMessageEl.innerHTML = message;
  resultPopup.classList.remove("hidden");
  document.addEventListener("mousedown", handlePopupBackdrop, true);
  setShareButtonVisible(mode === "result");
}

function hidePopup() {
  if (!currentPopupMode) return;
  resultPopup.classList.add("hidden");
  document.removeEventListener("mousedown", handlePopupBackdrop, true);
  currentPopupMode = null;
  setShareButtonVisible(false);
}

function showResultPopup() {
  if (!state.results.winner) return;
  const { player, ai, winner } = state.results;
  const oppLabel = getOpponentLabel();
  let emoji = "😐";
  if (winner === "You win!") emoji = "😄";
  else if (winner === `${oppLabel} wins!`) emoji = "😞";
  let detail = "";
  if (player != null && ai != null) {
    const diff = Math.abs(player - ai).toFixed(2);
    detail = `${winner} by ${diff}s`;
  } else {
    detail = winner;
  }
  const html = `${detail}<br><span class="popup-detail">You: ${
    player == null ? "DNF" : player.toFixed(2)
  }s &nbsp;|&nbsp; ${oppLabel}: ${ai == null ? "DNF" : ai.toFixed(2)}s</span>`;
  showPopupContent({ mode: "result", emoji, message: html });
}

function hideResultPopup() {
  if (currentPopupMode === "result") {
    hidePopup();
  }
}

function showAiBuildPopup() {
  if (currentPopupMode) return;
  const html = `Finishing the AI maze for this seed…<br><span class="popup-detail">The reveal will begin automatically when the opponent is ready.</span>`;
  showPopupContent({ mode: "aiBuild", emoji: "⋯", message: html });
}

function hideAiBuildPopup() {
  if (currentPopupMode === "aiBuild") {
    hidePopup();
  }
}

function setShareButtonVisible(visible) {
  if (!shareResultBtn) return;
  shareResultBtn.style.display = visible ? "" : "none";
}

function handlePopupBackdrop(evt) {
  if (!resultCard) return;
  if (!resultCard.contains(evt.target)) {
    hidePopup();
  }
}

function handleShareResult() {
  const shareText = buildShareText();
  if (!shareText) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(shareText).catch(() => fallbackShare(shareText));
  } else {
    fallbackShare(shareText);
  }
}

function buildShareText() {
  const player = state.results.player;
  const ai = state.results.ai;
  if (player == null || ai == null) return `Outmaze · Seed: ${state.seed || "unknown"}`;
  const diff = player - ai;
  const margin = `${diff >= 0 ? "+" : ""}${diff.toFixed(2)}s`;
  return `Outmaze · ${margin} vs ${getOpponentLabel()} · Seed: ${state.seed || "unknown"}`;
}

function fallbackShare(text) {
  const temp = document.createElement("textarea");
  temp.value = text;
  temp.setAttribute("readonly", "");
  temp.style.position = "absolute";
  temp.style.left = "-9999px";
  document.body.appendChild(temp);
  temp.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(temp);
  }
}

function notifySpecialNeeded() {
  const x = canvas.width / 2;
  const y = 50;
  state.floatingTexts.push({
    text: "Your hazard is still available.",
    x,
    y,
    life: 1.5,
    color: "#ffdd66"
  });
}

function showMainMenu() {
  if (state.party.active || state.daily.active) window.OutmazeOnline?.deactivateModes?.({ closeSocket: true });
  closeCatalogue();
  state.mode = "menu";
  state.paused = true;
  hud.classList.add("hidden");
  gameHeader?.classList.add("hidden");
  statusBoard?.classList.add("hidden");
  resourceToolbar?.classList.add("hidden");
  gameBody?.classList.add("hidden");
  menuOverlay.classList.remove("hidden");
  pauseOverlay.classList.add("hidden");
  updateHud();
  setSeedUiVisible(true);
  setVsUiVisible(false);
  applyVsVisibility(false);
  resetVsEarlyStartVotes();
  cancelAiBuild({ terminateWorker: true });
  clearCurrentGameState();
  setCanvasPresentation("build");
  revealBanner?.classList.add("hidden");
}

function hideMainMenu() {
  state.mode = "game";
  hud.classList.remove("hidden");
  gameHeader?.classList.remove("hidden");
  statusBoard?.classList.remove("hidden");
  resourceToolbar?.classList.remove("hidden");
  gameBody?.classList.remove("hidden");
  menuOverlay.classList.add("hidden");
  updateHud();
}

function showLoadingOverlay(message = "Preparing...") {
  loadingText.textContent = message;
  loadingOverlay.classList.remove("hidden");
}

function hideLoadingOverlay() {
  loadingOverlay.classList.add("hidden");
}

function showPause() {
  if (state.vs.active) return;
  state.paused = true;
  pauseOverlay.classList.remove("hidden");
  updateHud();
}

function hidePause() {
  state.paused = false;
  pauseOverlay.classList.add("hidden");
  updateHud();
}

function resumeGame() {
  hidePause();
  state.mode = "game";
}

function openCatalogue() {
  if (!catalogueOverlay || state.catalogueOpen) return;
  state.catalogueOpen = true;
  cataloguePrevPaused = state.paused;
  state.paused = true;
  populateCatalogueList();
  catalogueOverlay.classList.remove("hidden");
}

function closeCatalogue() {
  if (!catalogueOverlay || !state.catalogueOpen) return;
  state.catalogueOpen = false;
  state.paused = cataloguePrevPaused;
  catalogueOverlay.classList.add("hidden");
}

function populateCatalogueList() {
  if (!catalogueListEl) return;
  catalogueListEl.innerHTML = "";
  CATALOGUE_ITEMS.forEach((item) => {
    const entry = document.createElement("div");
    entry.className = "catalogue-item";
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    canvas.className = "catalogue-icon";
    const ctxIcon = canvas.getContext("2d");
    drawCatalogueIcon(ctxIcon, item.icon);
    const textWrap = document.createElement("div");
    textWrap.className = "catalogue-text";
    const title = document.createElement("h3");
    title.textContent = item.name;
    const body = document.createElement("p");
    const description = typeof item.description === "function" ? item.description() : item.description;
    body.textContent = description;
    textWrap.appendChild(title);
    textWrap.appendChild(body);
    entry.appendChild(canvas);
    entry.appendChild(textWrap);
    catalogueListEl.appendChild(entry);
  });
}

function drawCatalogueIcon(ctx, icon) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, w, h);
  switch (icon) {
    case "gate-start":
      drawCatalogueGateIcon(ctx, "S");
      break;
    case "gate-finish":
      drawCatalogueGateIcon(ctx, "F");
      break;
    case "wall-static":
      renderCatalogueSprite(ctx, (localCtx) => drawStaticBlockSprite(0, 0, localCtx, 0));
      break;
    case "wall-player":
      renderCatalogueSprite(ctx, (localCtx) => drawPlayerBlockSprite(0, 0, localCtx, 0));
      break;
    case "wall-single":
      renderCatalogueSprite(ctx, (localCtx) => drawSingleBlockSprite(0, 0, localCtx, 0));
      break;
    case "pad-speed":
      renderCatalogueSprite(ctx, (localCtx) => drawPadPlate(CELL_SPEED, 0, 0, localCtx, 0));
      break;
    case "pad-slow":
      renderCatalogueSprite(ctx, (localCtx) => drawPadPlate(CELL_SLOW, 0, 0, localCtx, 0));
      break;
    case "pad-detour":
      renderCatalogueSprite(ctx, (localCtx) => drawPadPlate(CELL_DETOUR, 0, 0, localCtx, 0));
      break;
    case "pad-stone":
      renderCatalogueSprite(ctx, (localCtx) => drawPadPlate(CELL_STONE, 0, 0, localCtx, 0));
      break;
    case "pad-rewind":
      renderCatalogueSprite(ctx, (localCtx) => drawPadPlate(CELL_REWIND, 0, 0, localCtx, 0));
      break;
    case "special-freeze":
      renderSpecialCatalogueSprite(ctx, "radius");
      break;
    case "special-row":
      renderSpecialCatalogueSprite(ctx, "row");
      break;
    case "special-column":
      renderSpecialCatalogueSprite(ctx, "column");
      break;
    case "special-gravity":
      renderSpecialCatalogueSprite(ctx, "gravity");
      break;
    case "special-lightning":
      renderSpecialCatalogueSprite(ctx, "lightning");
      break;
    default:
      drawCatalogueBlockIcon(ctx, "#2a2a2a", "#4a4a4a");
  }
}

function renderCatalogueSprite(ctx, drawFn) {
  const padX = (ctx.canvas.width - CELL_SIZE) / 2;
  const padY = (ctx.canvas.height - CELL_SIZE) / 2;
  ctx.save();
  ctx.translate(padX, padY);
  drawFn(ctx);
  ctx.restore();
}

function renderSpecialCatalogueSprite(ctx, type) {
  renderCatalogueSprite(ctx, (localCtx) => {
    const previewSpecial = { type, placed: true, cell: { x: 0, y: 0 } };
    const palette = specialPaletteForCell(previewSpecial, 0, 0);
    if (!palette) return;
    drawSpecialBlockSprite(0, 0, palette, localCtx, 0);
  });
}

function drawCatalogueGateIcon(ctx, label) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = "#090909";
  ctx.fillRect(6, 6, w - 12, h - 12);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 2;
  ctx.strokeRect(7, 7, w - 14, h - 14);
  ctx.fillStyle = "#f5f5f5";
  ctx.font = "bold 20px 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, w / 2, h / 2);
}

function drawCatalogueBlockIcon(ctx, outer, inner) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = outer;
  ctx.fillRect(5, 5, w - 10, h - 10);
  ctx.fillStyle = inner;
  ctx.fillRect(10, 10, w - 20, h - 20);
}

function loop(timestamp) {
  let delta = (timestamp - lastFrame) / 1000;
  lastFrame = timestamp;
  if (delta > SUSPENDED_FRAME_DELTA) delta = 0;

  if (state.mode === "menu" || state.paused) {
    accumulator = 0;
    requestAnimationFrame(loop);
    return;
  }

  accumulator += delta;
  while (accumulator >= FIXED_TIMESTEP) {
    updateState(FIXED_TIMESTEP);
    accumulator -= FIXED_TIMESTEP;
  }
  draw();
  requestAnimationFrame(loop);
}
// GRID HELPERS ------------------------------------------------------------

function createEmptyGrid() {
  return AICore.createEmptyGrid();
}

function cloneGrid(grid) {
  return grid ? AICore.cloneGrid(grid) : AICore.createEmptyGrid();
}

function ensureOpenings(grid) {
  return AICore.ensureOpenings(grid);
}

function isInsideGrid(x, y) {
  return AICore.isInsideGrid(x, y);
}

function canPlaceBlock(grid, gx, gy) {
  return AICore.canPlaceBlock(grid, gx, gy);
}

function canPlaceSingle(grid, gx, gy) {
  return AICore.canPlaceSingle(grid, gx, gy);
}

function placeBlock(grid, gx, gy, type) {
  return AICore.placeBlock(grid, gx, gy, type);
}

function clearBlock(grid, gx, gy) {
  return AICore.clearBlock(grid, gx, gy);
}

function countBlocks(grid, type) {
  return AICore.countBlocks(grid, type);
}

function countCells(grid, value) {
  return AICore.countCells(grid, value);
}

function isCellAvailableForSpecial(grid, gx, gy) {
  return AICore.isCellAvailableForSpecial(grid, gx, gy);
}

// PATHFINDING ---------------------------------------------------------------

function computePath(grid) {
  return AICore.computePath(grid);
}

function hasPath(grid) {
  return AICore.hasPath(grid);
}

function key(x, y) {
  return `${x},${y}`;
}

function evaluateGridForAi(grid, special = null, neutralSpecials = [], pathInfoOverride = null) {
  return coreEvaluateGridForAi(grid, special, neutralSpecials, pathInfoOverride, aiWeights, state.baseGrid);
}

function analyzePath(grid) {
  return AICore.analyzePath(grid);
}

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
    const key = keyFor(node.x, node.y);
    if (checked.has(key)) return;
    checked.add(key);
    const value = grid[node.y]?.[node.x];
    if (padTypeFromCell(value) === "speed" && padIsMandatory(grid, node.x, node.y)) {
      count++;
    }
  });
  return count;
}

function keyFor(x, y) {
  return `${x},${y}`;
}

function optimizeBlockReallocation(grid, special, neutralSpecials, specialHotspots = []) {
  return AICore.optimizeBlockReallocation(
    grid,
    special,
    neutralSpecials,
    specialHotspots,
    aiWeights,
    state.baseGrid,
    state.rng
  );
}

// Overrides to delegate AI helpers to shared core (ensure these shadow earlier definitions).
function reclaimAndReallocateBlocks(grid, special, neutralSpecials, placementOrder = []) {
  return AICore.reclaimAndReallocateBlocks(grid, special, neutralSpecials, placementOrder);
}

function annotatePlacementImpacts(grid, special, neutralSpecials, placementOrder = []) {
  return AICore.annotatePlacementImpacts(grid, special, neutralSpecials, placementOrder);
}

function estimatePredictedRunTime(grid, pathInfo, special, neutralSpecials = []) {
  return coreEstimatePredictedRunTime(grid, pathInfo, special, neutralSpecials);
}

function collectAiTimeComponents(grid, pathInfo, special, neutralSpecials = []) {
  return coreCollectAiTimeComponents(grid, pathInfo, special, neutralSpecials);
}

function computeSpecialUsageTimes(grid, pathInfo, special, neutralSpecials = []) {
  return coreComputeSpecialUsageTimes(grid, pathInfo, special, neutralSpecials);
}

function computePadSlowTime(grid, pathInfo) {
  return coreComputePadSlowTime(grid, pathInfo);
}

function computeSlowStackTime(grid, pathInfo, special, neutralSpecials = []) {
  return coreComputeSlowStackTime(grid, pathInfo, special, neutralSpecials);
}

function estimateSpecialPadSynergyTime(grid, path, special) {
  return coreEstimateSpecialPadSynergyTime(grid, path, special);
}

function estimateSpecialOverlapTime(path, special, neutralSpecials = []) {
  return coreEstimateSpecialOverlapTime(path, special, neutralSpecials);
}

function computeLightningPadPenalty(grid, pathInfo, special) {
  return coreComputeLightningPadPenalty(grid, pathInfo, special);
}

function computeBlockUsageScore(grid, path) {
  return coreComputeBlockUsageScore(grid, path, state.baseGrid);
}

function simulateRunnerTime(grid, special, neutralSpecials = []) {
  return coreSimulateRunnerTime(grid, special, neutralSpecials);
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
  if (!path || index == null || index >= path.length - 1 || index < 0) return null;
  const start = path[index];
  const end = path[index + 1];
  return { x: Math.sign(end.x - start.x), y: Math.sign(end.y - start.y) };
}

function centerOf(node) {
  return { x: node.x + 0.5, y: node.y + 0.5 };
}

function scoreSpecialPlacement(pathInfo, specialType, cell) {
  const special = { type: specialType, placed: true, cell };
  const positions = pathInfo.path;
  switch (specialType) {
    case "radius":
      return scoreRadiusPlacement(positions, special) * SPECIAL_RADIUS_WEIGHT;
    case "row":
    case "column":
      return scoreBeamPlacement(positions, special) * SPECIAL_BEAM_WEIGHT;
    case "gravity":
      return scoreGravityPlacement(positions, special) * SPECIAL_GRAVITY_WEIGHT;
    case "lightning":
      return scoreLightningPlacement(positions, special) * SPECIAL_LIGHTNING_WEIGHT;
    default:
      return 0;
  }
}

function scoreRadiusPlacement(pathNodes, special) {
  let coverage = 0;
  pathNodes.forEach((node) => {
    if (node.x < 0 || node.x >= GRID_SIZE || node.y < 0 || node.y >= GRID_SIZE) return;
    const pos = { x: node.x + 0.5, y: node.y + 0.5 };
    if (isPointInsideSpecial(pos, special)) coverage++;
  });
  return coverage;
}

function scoreBeamPlacement(pathNodes, special) {
  let coverage = 0;
  pathNodes.forEach((node) => {
    const pos = { x: node.x + 0.5, y: node.y + 0.5 };
    if (isPointInsideSpecial(pos, special)) coverage++;
  });
  return coverage;
}

function scoreGravityPlacement(pathNodes, special) {
  let total = 0;
  const centerX = special.cell.x + 0.5;
  const centerY = special.cell.y + 0.5;
  pathNodes.forEach((node) => {
    const pos = { x: node.x + 0.5, y: node.y + 0.5 };
    const dx = pos.x - centerX;
    const dy = pos.y - centerY;
    const dist = Math.hypot(dx, dy);
    if (dist <= GRAVITY_RADIUS) {
      total += (GRAVITY_RADIUS - dist) / GRAVITY_RADIUS;
    }
  });
  return total;
}

function scoreLightningPlacement(pathNodes, special) {
  let hits = 0;
  let inside = false;
  pathNodes.forEach((node) => {
    const pos = { x: node.x + 0.5, y: node.y + 0.5 };
    const nowInside = isPointInsideSpecial(pos, special);
    if (nowInside && !inside) hits++;
    inside = nowInside;
  });
  return hits;
}

function drawPadPlate(cell, gridX, gridY, context = ctx, offsetY = GRID_OFFSET_Y) {
  const renderCtx = context;
  const type = padTypeFromCell(cell);
  if (!type) return;
  const config = PAD_VISUALS[type] || PAD_VISUALS.speed;
  const isActive = isPadActiveCell(cell);
  const color = config.color;
  let inset = config.inset ?? 10;
  let alpha = config.idleAlpha ?? 0.3;
  const baseBrightness = config.baseBrightness ?? 0.48;
  const pulseRange = config.pulseRange ?? 0.25;
  let brightness = isActive ? baseBrightness : baseBrightness * 0.85;
  if (isActive) {
    const phase = (padPulseTimer / PAD_PULSE_PERIOD) * Math.PI * 2;
    const normalized = (Math.sin(phase) + 1) / 2;
    inset = inset - normalized * 2;
    brightness = baseBrightness + normalized * pulseRange;
    const activeAlpha = config.activeAlpha ?? alpha + 0.25;
    alpha = alpha + normalized * (activeAlpha - alpha);
  } else {
    alpha *= 0.6;
  }
  const r = Math.min(255, Math.round(color.r * brightness));
  const g = Math.min(255, Math.round(color.g * brightness));
  const b = Math.min(255, Math.round(color.b * brightness));
  renderCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  const x = gridX * CELL_SIZE + inset;
  const y = offsetY + gridY * CELL_SIZE + inset;
  renderCtx.fillRect(x, y, CELL_SIZE - inset * 2, CELL_SIZE - inset * 2);
  if (config.iconChar) {
    drawPadGlyph(config, gridX, gridY, color, isActive, renderCtx, offsetY);
  }
}

function drawPadGlyph(config, gridX, gridY, baseColor, isActive, context = ctx, offsetY = GRID_OFFSET_Y) {
  const renderCtx = context;
  const cx = gridX * CELL_SIZE + CELL_SIZE / 2;
  const cy = offsetY + gridY * CELL_SIZE + CELL_SIZE / 2;
  const fontSize = Math.floor(CELL_SIZE * 0.62 * (config.charScale ?? 1));
  const color = config.charColor
    ? config.charColor
    : `rgba(${Math.min(255, Math.round(baseColor.r * 0.85))}, ${Math.min(255, Math.round(baseColor.g * 0.85))}, ${Math.min(255, Math.round(
        baseColor.b * 0.85
      ))}, ${isActive ? 0.95 : 0.65})`;
  const step = CELL_SIZE * 0.05;
  const offsetX = (config.charOffset?.x ?? 0) * step;
  const offsetYChar = (config.charOffset?.y ?? 0) * step;
  renderCtx.save();
  renderCtx.font = `bold ${fontSize}px "Courier New", monospace`;
  renderCtx.textAlign = "center";
  renderCtx.textBaseline = "middle";
  renderCtx.fillStyle = color;
  renderCtx.fillText(config.iconChar, cx + offsetX, cy + offsetYChar);
  renderCtx.restore();
}

function isPadActiveCell(cell) {
  return (
    cell === CELL_SPEED ||
    cell === CELL_SLOW ||
    cell === CELL_DETOUR ||
    cell === CELL_STONE ||
    cell === CELL_REWIND
  );
}

function isPadUsedCell(cell) {
  return (
    cell === CELL_SPEED_USED ||
    cell === CELL_SLOW_USED ||
    cell === CELL_DETOUR_USED ||
    cell === CELL_STONE_USED ||
    cell === CELL_REWIND_USED
  );
}

function isPadCell(cell) {
  return isPadActiveCell(cell) || isPadUsedCell(cell);
}

function padTypeFromCell(cell) {
  switch (cell) {
    case CELL_SPEED:
    case CELL_SPEED_USED:
      return "speed";
    case CELL_SLOW:
    case CELL_SLOW_USED:
      return "slow";
    case CELL_DETOUR:
    case CELL_DETOUR_USED:
      return "detour";
    case CELL_STONE:
    case CELL_STONE_USED:
      return "stone";
    case CELL_REWIND:
    case CELL_REWIND_USED:
      return "rewind";
    default:
      return null;
  }
}

function padUsedVariant(cell) {
  switch (cell) {
    case CELL_SPEED:
      return CELL_SPEED_USED;
    case CELL_SLOW:
      return CELL_SLOW_USED;
    case CELL_DETOUR:
      return CELL_DETOUR_USED;
    case CELL_STONE:
      return CELL_STONE_USED;
    case CELL_REWIND:
      return CELL_REWIND_USED;
    default:
      return cell;
  }
}

function findNeutralSpecial(list, x, y) {
  if (!list) return null;
  return list.find((special) => special?.cell && special.cell.x === x && special.cell.y === y) || null;
}

function drawStaticBlockSprite(gridX, gridY, context = ctx, offsetY = GRID_OFFSET_Y) {
  const baseX = gridX * CELL_SIZE;
  const baseY = offsetY + gridY * CELL_SIZE;
  drawFlatResourceTile(baseX, baseY, {
    fill: "#283a33",
    border: "#526a60",
    inset: "#18241f",
    insetWidth: 3
  }, context);
}

function drawPlayerBlockSprite(gridX, gridY, context = ctx, offsetY = GRID_OFFSET_Y) {
  const baseX = gridX * CELL_SIZE;
  const baseY = offsetY + gridY * CELL_SIZE;
  drawFlatResourceTile(baseX, baseY, {
    fill: "#245b42",
    border: "#6cc58f",
    inset: "rgba(0, 0, 0, 0.3)",
    insetWidth: 3
  }, context);
}

function drawSingleBlockSprite(gridX, gridY, context = ctx, offsetY = GRID_OFFSET_Y) {
  const baseX = gridX * CELL_SIZE;
  const baseY = offsetY + gridY * CELL_SIZE;
  drawFlatResourceTile(baseX, baseY, {
    fill: "#747f79",
    border: "#c9d1cd",
    inset: "#4d5752",
    insetWidth: 5
  }, context);
}

function drawFlatResourceTile(baseX, baseY, palette, context = ctx) {
  if (renderingCompactPreview) {
    context.save();
    context.fillStyle = palette.fill;
    context.fillRect(baseX, baseY, CELL_SIZE, CELL_SIZE);
    context.restore();
    return;
  }
  const edge = 1.5;
  const size = CELL_SIZE - edge * 2;
  context.save();
  context.fillStyle = palette.fill;
  context.fillRect(baseX + edge, baseY + edge, size, size);
  context.strokeStyle = palette.border;
  context.lineWidth = 1;
  context.strokeRect(baseX + edge, baseY + edge, size, size);
  context.strokeStyle = palette.inset;
  context.lineWidth = palette.insetWidth || 3;
  const inset = edge + (palette.insetWidth || 3) / 2 + 1;
  context.strokeRect(baseX + inset, baseY + inset, CELL_SIZE - inset * 2, CELL_SIZE - inset * 2);
  context.restore();
}

function drawSpecialBlockSprite(gridX, gridY, paletteOverride, context = ctx, offsetY = GRID_OFFSET_Y) {
  const baseX = gridX * CELL_SIZE;
  const baseY = offsetY + gridY * CELL_SIZE;
  const palette =
    paletteOverride || {
      outer: "#f3cf63",
      inner: "#ffeaa2",
      border: "#3b2f10",
      highlight: "rgba(255,255,255,0.2)",
      arrow: null,
      glyph: "?"
    };
  const { arrow, ...tilePalette } = palette;
  context.save();
  drawFlatResourceTile(baseX, baseY, {
    fill: tilePalette.outer,
    border: tilePalette.inner,
    inset: tilePalette.border,
    insetWidth: 4
  }, context);
  if (arrow) {
    drawBlockLine(baseX, baseY, arrow, context);
  }
  if (palette.glyph) {
    drawSpecialGlyph(baseX, baseY, palette, context);
  }
  context.restore();
}

function drawBlockLine(baseX, baseY, direction, context = ctx) {
  context.save();
  context.fillStyle = "#16091f";
  const inset = 8;
  const thickness = 5;
  if (direction === "horizontal") {
    const midY = baseY + CELL_SIZE / 2 - thickness / 2;
    context.fillRect(baseX + inset, midY, CELL_SIZE - inset * 2, thickness);
  } else {
    const midX = baseX + CELL_SIZE / 2 - thickness / 2;
    context.fillRect(midX, baseY + inset, thickness, CELL_SIZE - inset * 2);
  }
  context.restore();
}

function drawSpecialGlyph(baseX, baseY, palette, context = ctx) {
  const glyph = palette.glyph;
  if (!glyph) return;
  const color = palette.glyphColor || palette.inner || "#fff";
  const scale = palette.glyphScale ?? 1;
  const step = CELL_SIZE * 0.05;
  const offsetX = (palette.glyphOffset?.x ?? 0) * step + (palette.glyphOffsetPx?.x ?? 0);
  const offsetY = (palette.glyphOffset?.y ?? 0) * step + (palette.glyphOffsetPx?.y ?? 0);
  context.save();
  const fontSize = Math.floor(CELL_SIZE * 0.55 * scale);
  context.font = `bold ${fontSize}px "Courier New", monospace`;
  context.fillStyle = color;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(glyph, baseX + CELL_SIZE / 2 + offsetX, baseY + CELL_SIZE / 2 + offsetY);
  context.restore();
}

function drawSnowflake(cx, cy, radius) {
  ctx.save();
  ctx.strokeStyle = "rgba(190, 230, 255, 0.14)";
  ctx.lineWidth = 1.3;
  const arms = 6;
  for (let i = 0; i < arms; i++) {
    const angle = (Math.PI * 2 * i) / arms;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
    const branchAngle1 = angle + Math.PI / 6;
    const branchAngle2 = angle - Math.PI / 6;
    const branchLen = radius * 0.35;
    const bx1 = x - Math.cos(angle) * branchLen + Math.cos(branchAngle1) * branchLen;
    const by1 = y - Math.sin(angle) * branchLen + Math.sin(branchAngle1) * branchLen;
    const bx2 = x - Math.cos(angle) * branchLen + Math.cos(branchAngle2) * branchLen;
    const by2 = y - Math.sin(angle) * branchLen + Math.sin(branchAngle2) * branchLen;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(bx1, by1);
    ctx.moveTo(x, y);
    ctx.lineTo(bx2, by2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawIcyArrows(cx, cy, radius) {
  const outer = "rgba(130, 195, 255, 0.14)";
  const inner = "rgba(150, 210, 255, 0.14)";
  drawRadialArrows(cx, cy, radius * 0.95, radius * 0.35, 6, 0, outer);
  drawRadialArrows(cx, cy, radius * 0.65, radius * 0.25, 6, Math.PI / 6, inner);
}

function drawRadialArrows(cx, cy, outerLen, innerLen, count, offset, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  for (let i = 0; i < count; i++) {
    const angle = offset + (Math.PI * 2 * i) / count;
    const innerX = cx + Math.cos(angle) * innerLen;
    const innerY = cy + Math.sin(angle) * innerLen;
    const outerX = cx + Math.cos(angle) * outerLen;
    const outerY = cy + Math.sin(angle) * outerLen;
    ctx.beginPath();
    ctx.moveTo(innerX, innerY);
    ctx.lineTo(outerX, outerY);
    ctx.stroke();
    const headAngle1 = angle + Math.PI / 6;
    const headAngle2 = angle - Math.PI / 6;
    const headSize = 6;
    ctx.beginPath();
    ctx.moveTo(outerX, outerY);
    ctx.lineTo(outerX - Math.cos(headAngle1) * headSize, outerY - Math.sin(headAngle1) * headSize);
    ctx.lineTo(outerX - Math.cos(headAngle2) * headSize, outerY - Math.sin(headAngle2) * headSize);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawLightningBolts(cx, cy, radius, ratio, flashing) {
  const bolts = 6;
  ctx.save();
  for (let i = 0; i < bolts; i++) {
    const angle = (Math.PI * 2 * i) / bolts + (ratio * Math.PI) / 3;
    const length = radius * (0.6 + 0.2 * Math.random());
    const points = [];
    const segments = 4;
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const r = length * t;
      const wobble = (Math.random() - 0.5) * radius * 0.15 * (1 - t);
      const px = cx + Math.cos(angle) * r + Math.cos(angle + Math.PI / 2) * wobble;
      const py = cy + Math.sin(angle) * r + Math.sin(angle + Math.PI / 2) * wobble;
      points.push({ x: px, y: py });
    }
    ctx.strokeStyle = flashing ? "rgba(255,255,255,0.45)" : "rgba(255,215,130,0.5)";
    ctx.lineWidth = flashing ? 2.5 : 1.6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    points.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.stroke();
  }
  ctx.restore();
}

function drawElectricStun(cx, cy, radius, intensity) {
  ctx.save();
  const sparks = 12;
  for (let i = 0; i < sparks; i++) {
    const angle = (Math.PI * 2 * i) / sparks;
    const len = radius * (0.6 + 0.3 * Math.random());
    const wobble = (Math.random() - 0.5) * radius * 0.2;
    const color = `rgba(255, 255, 255, ${0.25 + 0.2 * intensity})`;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * len + Math.cos(angle + Math.PI / 2) * wobble, cy + Math.sin(angle) * len + Math.sin(angle + Math.PI / 2) * wobble);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBeveledTile(baseX, baseY, palette, context = ctx) {
  const bevel = Math.max(3, Math.floor(CELL_SIZE * 0.18));
  const innerInset = 4;
  context.beginPath();
  context.moveTo(baseX + bevel, baseY);
  context.lineTo(baseX + CELL_SIZE - bevel, baseY);
  context.lineTo(baseX + CELL_SIZE, baseY + bevel);
  context.lineTo(baseX + CELL_SIZE, baseY + CELL_SIZE - bevel);
  context.lineTo(baseX + CELL_SIZE - bevel, baseY + CELL_SIZE);
  context.lineTo(baseX + bevel, baseY + CELL_SIZE);
  context.lineTo(baseX, baseY + CELL_SIZE - bevel);
  context.lineTo(baseX, baseY + bevel);
  context.closePath();

  context.fillStyle = palette.outer;
  context.fill();
  context.lineWidth = 2;
  context.setLineDash([]);
  context.strokeStyle = palette.border || "#050505";
  context.stroke();

  context.beginPath();
  context.moveTo(baseX + bevel + innerInset, baseY + innerInset);
  context.lineTo(baseX + CELL_SIZE - bevel - innerInset, baseY + innerInset);
  context.lineTo(baseX + CELL_SIZE - innerInset, baseY + bevel + innerInset);
  context.lineTo(baseX + CELL_SIZE - innerInset, baseY + CELL_SIZE - bevel - innerInset);
  context.lineTo(baseX + CELL_SIZE - bevel - innerInset, baseY + CELL_SIZE - innerInset);
  context.lineTo(baseX + bevel + innerInset, baseY + CELL_SIZE - innerInset);
  context.lineTo(baseX + innerInset, baseY + CELL_SIZE - bevel - innerInset);
  context.lineTo(baseX + innerInset, baseY + bevel + innerInset);
  context.closePath();
  context.fillStyle = palette.inner || "#3a3a3a";
  context.fill();

  if (!renderingCompactPreview) {
    context.strokeStyle = palette.highlight || "rgba(255,255,255,0.1)";
    context.lineWidth = 1;
    context.setLineDash([2, 3]);
    context.stroke();
  }
}

// SPECIALS -----------------------------------------------------------------

function createSpecialTemplate(type) {
  return AICore.createSpecialTemplate(type || "radius");
}

function cloneSpecial(special) {
  return AICore.cloneSpecial(special);
}

function cloneNeutralSpecials(list) {
  return AICore.cloneNeutralSpecials(list);
}

function isPointInsideSpecial(pos, special) {
  return AICore.isPointInsideSpecial(pos, special);
}

// RANDOM HELPERS -----------------------------------------------------------

function randomInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function applyAlpha(color, alpha) {
  if (!color) {
    return `rgba(255, 120, 120, ${alpha})`;
  }
  if (!color.startsWith("#")) {
    return color;
  }
  const rgb = hexToRgb(color);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const bigint = parseInt(normalized, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255
  };
}

function decayGravityOffset(offset, delta) {
  if (!offset) return null;
  const decay = Math.pow(0.5, delta / 2); // ~2s half-life
  const next = { x: offset.x * decay, y: offset.y * decay };
  if (Math.abs(next.x) < 0.001 && Math.abs(next.y) < 0.001) {
    return null;
  }
  return next;
}
