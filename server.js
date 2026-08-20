const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const {
  AICore,
  PROFILE_EMOJIS,
  buildPartyAiMaze,
  createAuthService,
  createDailyService,
  createFirestoreStore,
  createLocalFileStore,
  createMemoryStore,
  publicProfile,
  scorePartyPlacements,
  simulateValidatedMaze,
  validateMazeForSeed
} = require("./online-services.js");

const DEFAULT_PORT = Number(process.env.PORT || 8080);
const DEFAULT_BUILD_SECONDS = 60;
const DEFAULT_START_DELAY_MS = 0;
const DEFAULT_AUTH_TIMEOUT_MS = 10 * 1000;
const DEFAULT_IDLE_CONNECTION_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ROOM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 30 * 1000;
const DEFAULT_PARTY_INTERMISSION_MS = 10 * 1000;
const PROFILE_RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const PROFILE_RECOVERY_ATTEMPTS = 5;
const GRID_SIZE = 21;
const MAX_CELL_VALUE = 15;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SPECIAL_TYPES = new Set(["radius", "row", "column", "gravity", "lightning"]);
const PARTY_BOT_NAMES = Object.freeze([
  "Moss", "Pixel", "Nova", "Orbit", "Echo", "Rune", "Comet", "Sprout",
  "Marble", "Tangle", "Circuit", "Ziggy", "Noodle", "Pebble", "Quill", "Bramble"
]);
const DEFAULT_PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || "https://ezarox.github.io/outmaze/";
const PUBLIC_FILES = new Set([
  "index.html",
  "style.css",
  "ai-core.js",
  "ai-worker.js",
  "firebase-config.js",
  "account.js",
  "online-modes.js",
  "main.js"
]);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

function normalizeOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function parseAllowedOrigins(value) {
  const candidates = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(candidates.map(normalizeOrigin).filter(Boolean))];
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function accountProfile(profile) {
  const visible = publicProfile(profile);
  return visible ? { ...visible, recoveryReady: Boolean(profile.recoveryHash) } : null;
}

function readJsonBody(req, maxBytes = 300 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("Request is too large"), { code: "payload-too-large", status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (_) {
        reject(Object.assign(new Error("Request body must be valid JSON"), { code: "invalid-json", status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function createHttpHandler({
  publicSiteUrl = DEFAULT_PUBLIC_SITE_URL,
  rootDirectory = __dirname,
  serveStatic = false,
  apiHandler = null,
  allowedOrigins = new Set()
}) {
  const root = path.resolve(rootDirectory);
  return async (req, res) => {
    const requestPath = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    if (requestPath.startsWith("/api/") && requestPath !== "/api/health" && apiHandler) {
      const origin = normalizeOrigin(req.headers.origin);
      const corsHeaders = origin && allowedOrigins.has(origin)
        ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
        : {};
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          ...corsHeaders,
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
          "Access-Control-Max-Age": "3600"
        });
        res.end();
        return;
      }
      try {
        await apiHandler(req, res, requestPath, corsHeaders);
      } catch (error) {
        sendJson(res, Number(error.status || 500), {
          error: error.message || "Unexpected server error",
          code: error.code || "server-error"
        }, corsHeaders);
      }
      return;
    }
    if (requestPath === "/healthz" || requestPath === "/api/health") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end('{"status":"ok"}');
      return;
    }
    if (!serveStatic && requestPath === "/") {
      res.writeHead(302, {
        Location: publicSiteUrl,
        "Cache-Control": "no-store"
      });
      res.end();
      return;
    }
    if (serveStatic) {
      const relativePath = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
      if (!PUBLIC_FILES.has(relativePath)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      const filePath = path.resolve(root, relativePath);
      if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      fs.readFile(filePath, (error, content) => {
        if (error) {
          res.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-cache",
          "Referrer-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY"
        });
        res.end(content);
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  };
}

function normalizeRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
}

function validateMazePayload(payload) {
  if (!payload || !Array.isArray(payload.grid) || payload.grid.length !== GRID_SIZE) {
    return { error: "Maze grid must be 21 by 21" };
  }
  const grid = [];
  for (const row of payload.grid) {
    if (!Array.isArray(row) || row.length !== GRID_SIZE) {
      return { error: "Maze grid must be 21 by 21" };
    }
    const nextRow = [];
    for (const cell of row) {
      if (!Number.isInteger(cell) || cell < 0 || cell > MAX_CELL_VALUE) {
        return { error: "Maze contains an invalid cell" };
      }
      nextRow.push(cell);
    }
    grid.push(nextRow);
  }

  let special = null;
  if (payload.special != null) {
    const source = payload.special;
    if (!SPECIAL_TYPES.has(source.type)) return { error: "Maze contains an invalid hazard" };
    if (source.placed) {
      const x = Number(source.cell?.x);
      const y = Number(source.cell?.y);
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) {
        return { error: "Maze hazard is outside the grid" };
      }
    }
    special = JSON.parse(JSON.stringify(source));
  }

  return { value: { grid, special } };
}

function createOutmazeServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host;
  const buildSeconds = Number(options.buildSeconds ?? DEFAULT_BUILD_SECONDS);
  const startDelayMs = Number(options.startDelayMs ?? DEFAULT_START_DELAY_MS);
  const random = options.random || Math.random;
  const now = options.now || Date.now;
  const publicSiteUrl = options.publicSiteUrl || DEFAULT_PUBLIC_SITE_URL;
  const rootDirectory = options.rootDirectory || __dirname;
  const serveStatic = options.serveStatic ?? process.env.NODE_ENV !== "production";
  const allowedOrigins = new Set(
    parseAllowedOrigins(options.allowedOrigins === undefined ? process.env.ALLOWED_ORIGINS : options.allowedOrigins)
  );
  const projectId = options.projectId || process.env.OUTMAZE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  const useFirestore = options.useFirestore ?? process.env.FIRESTORE_ENABLED === "true";
  const store = options.store || (useFirestore
    ? createFirestoreStore({ projectId })
    : createMemoryStore());
  const allowDevTokens = options.allowDevTokens ?? process.env.NODE_ENV !== "production";
  const authService = options.authService || createAuthService({
    projectId,
    firebase: options.firebaseAuth ?? process.env.NODE_ENV === "production",
    allowDevTokens
  });
  const dailyService = options.dailyService || createDailyService({ store });
  const partyAiBuilder = options.partyAiBuilder || (({ seed, variant, usedSignatures }) =>
    buildPartyAiMaze(seed, variant, usedSignatures));
  const requireProfiles = options.requireProfiles ?? process.env.REQUIRE_PROFILES === "true";
  const authTimeoutMs = Number(options.authTimeoutMs ?? process.env.AUTH_TIMEOUT_MS ?? DEFAULT_AUTH_TIMEOUT_MS);
  const idleConnectionTimeoutMs = Number(
    options.idleConnectionTimeoutMs ?? process.env.IDLE_CONNECTION_TIMEOUT_MS ?? DEFAULT_IDLE_CONNECTION_TIMEOUT_MS
  );
  const roomIdleTimeoutMs = Number(options.roomIdleTimeoutMs ?? process.env.ROOM_IDLE_TIMEOUT_MS ?? DEFAULT_ROOM_IDLE_TIMEOUT_MS);
  const cleanupIntervalMs = Number(options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS);
  const partyIntermissionMs = Math.max(0, Number(options.partyIntermissionMs ?? DEFAULT_PARTY_INTERMISSION_MS));
  const partyPlaybackScale = Math.max(0, Number(options.partyPlaybackScale ?? 1));
  const recoveryAttempts = new Map();

  function recoveryAttemptKey(req, name) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return `${forwarded || req.socket.remoteAddress || "unknown"}:${String(name || "").trim().toLocaleLowerCase("en-US")}`;
  }

  function allowRecoveryAttempt(req, name) {
    const key = recoveryAttemptKey(req, name);
    const timestamp = now();
    const recent = (recoveryAttempts.get(key) || []).filter((attempt) => timestamp - attempt < PROFILE_RECOVERY_WINDOW_MS);
    if (recent.length >= PROFILE_RECOVERY_ATTEMPTS) {
      throw Object.assign(new Error("Too many recovery attempts. Try again in 15 minutes"), {
        code: "recovery-rate-limited",
        status: 429
      });
    }
    recent.push(timestamp);
    recoveryAttempts.set(key, recent);
    return () => recoveryAttempts.delete(key);
  }

  async function authenticateRequest(req, required = true) {
    const authorization = String(req.headers.authorization || "");
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token) {
      if (!required) return null;
      throw Object.assign(new Error("Sign in to continue"), { code: "sign-in-required", status: 401 });
    }
    return authService.verify(token);
  }

  async function apiHandler(req, res, requestPath, corsHeaders) {
    if (requestPath === "/api/profile" && req.method === "GET") {
      const identity = await authenticateRequest(req);
      sendJson(res, 200, { profile: accountProfile(await store.getProfile(identity.uid)) }, corsHeaders);
      return;
    }
    if (requestPath === "/api/profile" && (req.method === "POST" || req.method === "PUT")) {
      const identity = await authenticateRequest(req);
      const body = await readJsonBody(req, 16 * 1024);
      const previous = await store.getProfile(identity.uid);
      if (!previous && !body.recoveryPin) {
        throw Object.assign(new Error("Choose a 6-digit recovery PIN"), { code: "recovery-pin-required", status: 400 });
      }
      const profile = await store.saveProfile(identity.uid, body);
      sendJson(res, 200, { profile: accountProfile(profile) }, corsHeaders);
      return;
    }
    if (requestPath === "/api/profile/recover" && req.method === "POST") {
      const identity = await authenticateRequest(req);
      const body = await readJsonBody(req, 16 * 1024);
      const clearAttempts = allowRecoveryAttempt(req, body.name);
      const profile = await store.recoverProfile(identity.uid, body);
      clearAttempts();
      sendJson(res, 200, { profile: accountProfile(profile) }, corsHeaders);
      return;
    }
    if (requestPath === "/api/daily" && req.method === "GET") {
      const identity = await authenticateRequest(req, false);
      const requestedDay = new URL(req.url, "http://outmaze.local").searchParams.get("day");
      sendJson(res, 200, await dailyService.get(identity?.uid || null, requestedDay), corsHeaders);
      return;
    }
    if (requestPath === "/api/daily/submit" && req.method === "POST") {
      const identity = await authenticateRequest(req);
      const profile = await store.getProfile(identity.uid);
      if (!profile) throw Object.assign(new Error("Create your Outmaze profile first"), { code: "profile-required", status: 403 });
      const body = await readJsonBody(req);
      sendJson(res, 200, await dailyService.submit(identity.uid, body), corsHeaders);
      return;
    }
    sendJson(res, 404, { error: "Not found", code: "not-found" }, corsHeaders);
  }

  const server = http.createServer(
    createHttpHandler({ publicSiteUrl, rootDirectory, serveStatic, apiHandler, allowedOrigins })
  );
  const websocketOptions = { server, maxPayload: 256 * 1024 };
  if (allowedOrigins.size > 0) {
    websocketOptions.verifyClient = ({ origin }) => allowedOrigins.has(normalizeOrigin(origin));
  }
  const wss = new WebSocket.Server(websocketOptions);
  const rooms = new Map();
  let anonymousCounter = 0;
  const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.isAlive === false) {
        client.terminate();
        return;
      }
      client.isAlive = false;
      client.ping();
    });
  }, 30000);
  heartbeatTimer.unref?.();

  const cleanupTimer = setInterval(() => {
    const timestamp = now();
    rooms.forEach((room) => {
      if (timestamp - Number(room.lastActivityAt || timestamp) < roomIdleTimeoutMs) return;
      clearRoomTimer(room);
      rooms.delete(room.code);
      room.players.forEach((player) => {
        send(player.ws, { type: "room-expired", room: room.code, reason: "idle-timeout" });
        player.ws.close(4000, "idle-timeout");
      });
    });
    wss.clients.forEach((client) => {
      if (!client.outmazeAuthenticated || client.outmazeRoom) return;
      if (timestamp - Number(client.outmazeLastActivityAt || timestamp) >= idleConnectionTimeoutMs) {
        client.close(4000, "idle-timeout");
      }
    });
  }, Math.max(10, cleanupIntervalMs));
  cleanupTimer.unref?.();

  function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function broadcast(room, message) {
    room.players.forEach((player) => send(player.ws, message));
  }

  function playerUid(player) {
    return player.identity?.uid || `anonymous-${player.slot}`;
  }

  function partyParticipants(room) {
    return room.players.concat(room.bots || []);
  }

  function partySubmissionKey(player) {
    return player.bot ? playerUid(player) : player.ws;
  }

  function resequenceParty(room) {
    partyParticipants(room).forEach((player, index) => {
      player.slot = index + 1;
    });
  }

  function memberState(room, player) {
    const uid = playerUid(player);
    return {
      uid,
      slot: player.slot,
      name: player.profile?.name || `Player ${player.slot}`,
      emoji: player.profile?.emoji || "👤",
      bot: Boolean(player.bot),
      host: !player.bot && room.players[0] === player,
      ready: Boolean(player.bot) || room.ready.has(player.ws),
      early: Boolean(player.bot) || room.earlyVotes.has(player.ws),
      score: Number(room.scores?.get(uid) || 0),
      totalTime: Number(room.totalTimes?.get(uid) || 0)
    };
  }

  function roomState(room) {
    if (room.mode === "party") {
      return {
        type: "party-state",
        room: room.code,
        phase: room.phase,
        roundId: room.roundId || null,
        round: room.roundNumber || 0,
        rounds: room.roundsTotal,
        seed: room.seed || "",
        locked: room.locked,
        preparing: Boolean(room.preparingBots),
        nextRoundAt: room.nextRoundAt || null,
        members: partyParticipants(room).map((player) => memberState(room, player))
      };
    }
    return {
      type: "room-state",
      room: room.code,
      players: room.players.length,
      ready: room.ready.size,
      phase: room.phase,
      roundId: room.roundId || null,
      members: room.players.map((player) => memberState(room, player))
    };
  }

  function broadcastRoomState(room) {
    broadcast(room, roomState(room));
  }

  function touchRoom(room) {
    if (room) room.lastActivityAt = now();
  }

  function makeRoomCode() {
    let code = "";
    do {
      code = "";
      for (let index = 0; index < 5; index++) {
        code += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)];
      }
    } while (rooms.has(code));
    return code;
  }

  function clearRoomTimer(room) {
    if (room.lockTimer) {
      clearTimeout(room.lockTimer);
      room.lockTimer = null;
    }
    if (room.nextRoundTimer) {
      clearTimeout(room.nextRoundTimer);
      room.nextRoundTimer = null;
    }
    room.nextRoundAt = null;
  }

  function resetRoundState(room) {
    clearRoomTimer(room);
    room.ready.clear();
    room.submissions.clear();
    room.earlyVotes.clear();
    room.rematchChoices?.clear();
    room.locked = false;
  }

  function getPlayer(room, ws) {
    return room.players.find((player) => player.ws === ws) || null;
  }

  function sendEarlyStartState(room) {
    room.players.forEach((player) => {
      const peer = room.players.find((candidate) => candidate !== player);
      send(player.ws, {
        type: "early-start-state",
        roundId: room.roundId,
        self: room.earlyVotes.has(player.ws),
        peer: Boolean(peer && room.earlyVotes.has(peer.ws))
      });
    });
  }

  function sendRematchState(room) {
    room.players.forEach((player) => {
      const peer = room.players.find((candidate) => candidate !== player);
      send(player.ws, {
        type: "rematch-state",
        self: room.rematchChoices.get(player.ws) || null,
        peer: peer ? room.rematchChoices.get(peer.ws) || null : null
      });
    });
  }

  function lockRound(room, reason) {
    if (room.phase !== "building" || room.locked) return;
    room.locked = true;
    clearRoomTimer(room);
    broadcast(room, { type: "lock", roundId: room.roundId, reason });
  }

  function startRound(room, reuseMaze = false) {
    if (room.players.length !== 2) return;
    touchRoom(room);
    resetRoundState(room);
    room.phase = "building";
    room.roundId += 1;
    if (!reuseMaze || !room.seed) room.seed = Math.floor(random() * 1e9).toString();
    const startsAt = now() + startDelayMs;
    const buildEndsAt = startsAt + buildSeconds * 1000;
    broadcast(room, {
      type: "start",
      room: room.code,
      roundId: room.roundId,
      seed: room.seed,
      startsAt,
      buildEndsAt,
      buildSeconds,
      reuseMaze
    });
    room.lockTimer = setTimeout(() => lockRound(room, "timer"), Math.max(0, buildEndsAt - now()));
    broadcastRoomState(room);
  }

  function normalizeRoundCount(value) {
    return Math.max(1, Math.min(10, Number(value) | 0 || 3));
  }

  function createPartyBot(room) {
    const usedNames = new Set(partyParticipants(room).map((member) => member.profile?.name));
    const startIndex = Math.floor(random() * PARTY_BOT_NAMES.length);
    let name = PARTY_BOT_NAMES[(startIndex + room.botCounter) % PARTY_BOT_NAMES.length];
    for (let offset = 0; offset < PARTY_BOT_NAMES.length && usedNames.has(name); offset++) {
      name = PARTY_BOT_NAMES[(startIndex + room.botCounter + offset + 1) % PARTY_BOT_NAMES.length];
    }
    const counter = ++room.botCounter;
    const uid = `bot-${room.code.toLowerCase()}-${counter}`;
    return {
      bot: true,
      slot: partyParticipants(room).length + 1,
      identity: { uid },
      profile: {
        uid,
        name,
        emoji: PROFILE_EMOJIS[(Math.floor(random() * PROFILE_EMOJIS.length) + counter) % PROFILE_EMOJIS.length]
      },
      variant: counter - 1
    };
  }

  function fillPartyWithBots(room) {
    while (partyParticipants(room).length < 8) room.bots.push(createPartyBot(room));
    resequenceParty(room);
  }

  function adjustPartyBots(room, delta) {
    if (delta > 0 && partyParticipants(room).length < 8) room.bots.push(createPartyBot(room));
    if (delta < 0 && room.bots.length) room.bots.pop();
    resequenceParty(room);
  }

  async function preparePartyBotSubmissions(room) {
    const usedSignatures = new Set();
    for (const bot of room.bots) {
      let layout;
      let validated;
      try {
        layout = await partyAiBuilder({
          seed: room.seed,
          variant: bot.variant,
          usedSignatures
        });
        if (layout?.grid) validated = validateMazeForSeed(room.seed, layout);
      } catch (_) {
        layout = null;
      }
      if (!validated) {
        const round = AICore.createRound(room.seed);
        layout = {
          grid: AICore.cloneGrid(round.baseGrid),
          special: AICore.cloneSpecial(round.specialTemplate)
        };
        validated = validateMazeForSeed(room.seed, layout);
      }
      const payload = { grid: validated.grid, special: validated.special };
      const signature = layout.signature || JSON.stringify(payload);
      usedSignatures.add(signature);
      room.submissions.set(partySubmissionKey(bot), {
        payload,
        time: simulateValidatedMaze(validated)
      });
    }
  }

  function lockPartyRound(room, reason) {
    if (room.mode !== "party" || room.phase !== "building" || room.locked) return;
    room.locked = true;
    clearRoomTimer(room);
    broadcast(room, { type: "party-lock", roundId: room.roundId, reason });
    broadcastRoomState(room);
  }

  async function startPartyRound(room, resetMatch = false) {
    if (room.mode !== "party" || partyParticipants(room).length < 2 || room.preparingBots) return;
    room.preparingBots = true;
    broadcast(room, { type: "party-preparing", bots: room.bots.length });
    try {
      touchRoom(room);
      resetRoundState(room);
      if (resetMatch) {
        room.roundNumber = 0;
        room.scores.clear();
        room.totalTimes.clear();
      }
      room.phase = "building";
      room.roundId += 1;
      room.roundNumber += 1;
      room.seed = Math.floor(random() * 1e9).toString();
      await preparePartyBotSubmissions(room);
      const startsAt = now() + startDelayMs;
      const buildEndsAt = startsAt + buildSeconds * 1000;
      broadcast(room, {
        type: "party-start",
        room: room.code,
        roundId: room.roundId,
        round: room.roundNumber,
        rounds: room.roundsTotal,
        seed: room.seed,
        startsAt,
        buildEndsAt,
        buildSeconds
      });
      room.lockTimer = setTimeout(() => lockPartyRound(room, "timer"), Math.max(0, buildEndsAt - now()));
    } finally {
      room.preparingBots = false;
      broadcastRoomState(room);
    }
  }

  function revealPartyIfReady(room) {
    const participants = partyParticipants(room);
    if (room.mode !== "party" || participants.length < 2 || room.submissions.size !== participants.length) return;
    room.phase = "results";
    const placements = scorePartyPlacements(
      participants.map((player) => {
        const submission = room.submissions.get(partySubmissionKey(player));
        const member = memberState(room, player);
        return {
          uid: member.uid,
          slot: member.slot,
          profile: { uid: member.uid, name: member.name, emoji: member.emoji },
          time: submission.time,
          maze: submission.payload
        };
      })
    );
    placements.forEach((entry) => {
      room.scores.set(entry.uid, Number(room.scores.get(entry.uid) || 0) + entry.points);
      room.totalTimes.set(entry.uid, Number(room.totalTimes.get(entry.uid) || 0) + Number(entry.time || 0));
      entry.totalPoints = room.scores.get(entry.uid);
      entry.totalTime = room.totalTimes.get(entry.uid);
    });
    const finalRound = room.roundNumber >= room.roundsTotal;
    const longestTime = placements.reduce((longest, entry) => Math.max(longest, Number(entry.time) || 0), 0);
    const racePlaybackMs = Math.ceil(longestTime * 1000 * partyPlaybackScale);
    const nextRoundAt = finalRound ? null : now() + racePlaybackMs + partyIntermissionMs;
    room.nextRoundAt = nextRoundAt;
    broadcast(room, {
      type: "party-results",
      room: room.code,
      roundId: room.roundId,
      round: room.roundNumber,
      rounds: room.roundsTotal,
      finalRound,
      nextRoundAt,
      entries: placements
    });
    broadcastRoomState(room);
    if (!finalRound) {
      const expectedRoundId = room.roundId;
      room.nextRoundTimer = setTimeout(() => {
        room.nextRoundTimer = null;
        room.nextRoundAt = null;
        if (rooms.get(room.code) !== room || room.phase !== "results" || room.roundId !== expectedRoundId) return;
        startPartyRound(room, false).catch(() => {
          room.preparingBots = false;
          broadcast(room, { type: "error", code: "party-round-failed", error: "The next party round could not be prepared" });
          broadcastRoomState(room);
        });
      }, Math.max(0, nextRoundAt - now()));
      room.nextRoundTimer.unref?.();
    }
  }

  function revealMazesIfReady(room) {
    if (room.submissions.size !== 2 || room.players.length !== 2) return;
    room.phase = "racing";
    const [first, second] = room.players;
    send(first.ws, {
      type: "reveal",
      roundId: room.roundId,
      payload: room.submissions.get(second.ws)
    });
    send(second.ws, {
      type: "reveal",
      roundId: room.roundId,
      payload: room.submissions.get(first.ws)
    });
    broadcastRoomState(room);
  }

  function detachPlayer(room, ws, notify = true) {
    const playerIndex = room.players.findIndex((player) => player.ws === ws);
    if (playerIndex < 0) return;
    const [departed] = room.players.splice(playerIndex, 1);
    ws.outmazeRoom = null;
    ws.outmazeLastActivityAt = now();
    room.ready.delete(ws);
    room.earlyVotes.delete(ws);
    room.submissions.delete(ws);
    room.rematchChoices?.delete(ws);
    room.scores?.delete(playerUid(departed));
    room.totalTimes?.delete(playerUid(departed));
    if (room.mode === "party") {
      if (!room.players.length) {
        clearRoomTimer(room);
        rooms.delete(room.code);
        return;
      }
      touchRoom(room);
      room.players.forEach((player, index) => {
        player.slot = index + 1;
      });
      resequenceParty(room);
      if (partyParticipants(room).length < 2 && room.phase !== "lobby") {
        resetRoundState(room);
        room.phase = "lobby";
        room.roundNumber = 0;
        room.scores.clear();
        room.totalTimes.clear();
      } else if (room.phase === "building" && room.locked) {
        revealPartyIfReady(room);
      } else if (room.phase === "building" && room.earlyVotes.size === room.players.length) {
        lockPartyRound(room, "early");
      }
      if (notify) broadcast(room, { type: "party-player-left", uid: playerUid(departed) });
      broadcastRoomState(room);
      return;
    }
    resetRoundState(room);
    room.phase = "lobby";
    if (!room.players.length) {
      rooms.delete(room.code);
      return;
    }
    touchRoom(room);
    if (notify) broadcast(room, { type: "peer-left" });
    broadcastRoomState(room);
  }

  wss.on("connection", (ws) => {
    let currentRoom = null;
    let identity = null;
    let profile = null;
    ws.isAlive = true;
    ws.outmazeAuthenticated = false;
    ws.outmazeRoom = null;
    ws.outmazeLastActivityAt = now();
    const authTimer = setTimeout(() => {
      if (!ws.outmazeAuthenticated && ws.readyState === WebSocket.OPEN) ws.close(4401, "authentication-timeout");
    }, Math.max(1, authTimeoutMs));
    authTimer.unref?.();
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    function leaveCurrentRoom(notify = true) {
      if (!currentRoom) return;
      const room = rooms.get(currentRoom);
      if (room) detachPlayer(room, ws, notify);
      currentRoom = null;
      ws.outmazeRoom = null;
      ws.outmazeLastActivityAt = now();
    }

    async function ensureOnlineProfile() {
      if (!identity && !requireProfiles) {
        const id = `anonymous-${++anonymousCounter}`;
        identity = { uid: id };
        profile = { uid: id, name: `Player ${anonymousCounter}`, emoji: "👤" };
        ws.outmazeAuthenticated = true;
        clearTimeout(authTimer);
      }
      if (!identity) throw Object.assign(new Error("Sign in to continue"), { code: "sign-in-required", status: 401 });
      if (!profile) throw Object.assign(new Error("Create your Outmaze profile first"), { code: "profile-required", status: 403 });
    }

    function makePlayer(slot) {
      return { ws, slot, identity, profile: publicProfile(profile) };
    }

    function makeBaseRoom(code, mode) {
      return {
        code,
        mode,
        players: [makePlayer(1)],
        bots: [],
        botCounter: 0,
        preparingBots: false,
        ready: new Set(),
        submissions: new Map(),
        earlyVotes: new Set(),
        rematchChoices: new Map(),
        scores: new Map(),
        totalTimes: new Map(),
        phase: "lobby",
        roundId: 0,
        seed: "",
        locked: false,
        lockTimer: null,
        nextRoundTimer: null,
        nextRoundAt: null,
        lastActivityAt: now()
      };
    }

    ws.on("message", async (data) => {
      try {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch (_) {
          send(ws, { type: "error", code: "invalid-json", error: "Invalid message" });
          return;
        }

        const type = message?.type;
        if (type === "auth") {
          if (currentRoom) throw Object.assign(new Error("Leave the current room before changing account"), { code: "room-active" });
          identity = await authService.verify(message.token);
          ws.outmazeAuthenticated = true;
          ws.outmazeLastActivityAt = now();
          clearTimeout(authTimer);
          profile = await store.getProfile(identity.uid);
          if (!profile) {
            send(ws, { type: "profile-required" });
            return;
          }
          send(ws, { type: "authenticated", profile: publicProfile(profile) });
          return;
        }

        if (type === "leave" || type === "party-leave") {
          leaveCurrentRoom();
          return;
        }

        await ensureOnlineProfile();

        if (type === "create") {
          leaveCurrentRoom();
          const code = makeRoomCode();
          const room = makeBaseRoom(code, "friend");
          rooms.set(code, room);
          currentRoom = code;
          ws.outmazeRoom = code;
          ws.outmazeLastActivityAt = now();
          send(ws, { type: "created", room: code, slot: 1, profile: publicProfile(profile) });
          broadcastRoomState(room);
          return;
        }

        if (type === "join") {
          const code = normalizeRoomCode(message.room);
          const room = rooms.get(code);
          if (!room || room.mode !== "friend") {
            send(ws, { type: "error", code: "room-not-found", error: "Friend room not found" });
            return;
          }
          if (room.players.some((candidate) => playerUid(candidate) === identity.uid)) {
            send(ws, { type: "error", code: "same-account", error: "This profile is already in that room" });
            return;
          }
          if (room.players.length >= 2) {
            send(ws, { type: "error", code: "room-full", error: "Room is full" });
            return;
          }
          if (room.phase !== "lobby") {
            send(ws, { type: "error", code: "round-active", error: "That room is already playing" });
            return;
          }
          leaveCurrentRoom();
          room.players.push(makePlayer(2));
          touchRoom(room);
          currentRoom = code;
          ws.outmazeRoom = code;
          ws.outmazeLastActivityAt = now();
          send(ws, { type: "joined", room: code, slot: 2, profile: publicProfile(profile) });
          room.players.forEach((candidate) => {
            if (candidate.ws !== ws) send(candidate.ws, { type: "peer-joined", profile: publicProfile(profile) });
          });
          broadcastRoomState(room);
          return;
        }

        if (type === "party-create") {
          leaveCurrentRoom();
          const code = makeRoomCode();
          const room = makeBaseRoom(code, "party");
          room.roundsTotal = normalizeRoundCount(message.rounds);
          room.roundNumber = 0;
          rooms.set(code, room);
          currentRoom = code;
          ws.outmazeRoom = code;
          ws.outmazeLastActivityAt = now();
          send(ws, { type: "party-created", room: code, profile: publicProfile(profile) });
          broadcastRoomState(room);
          return;
        }

        if (type === "party-join") {
          const code = normalizeRoomCode(message.room);
          const room = rooms.get(code);
          if (!room || room.mode !== "party") {
            send(ws, { type: "error", code: "room-not-found", error: "Party room not found" });
            return;
          }
          if (room.players.some((candidate) => playerUid(candidate) === identity.uid)) {
            send(ws, { type: "error", code: "same-account", error: "This profile is already in that party" });
            return;
          }
          if (room.phase !== "lobby") {
            send(ws, { type: "error", code: "round-active", error: "That party has already started" });
            return;
          }
          if (partyParticipants(room).length >= 8) {
            if (room.bots.length) room.bots.pop();
            else {
              send(ws, { type: "error", code: "room-full", error: "This party already has eight players" });
              return;
            }
          }
          leaveCurrentRoom();
          room.players.push(makePlayer(room.players.length + 1));
          resequenceParty(room);
          touchRoom(room);
          currentRoom = code;
          ws.outmazeRoom = code;
          ws.outmazeLastActivityAt = now();
          send(ws, { type: "party-joined", room: code, profile: publicProfile(profile) });
          broadcast(room, { type: "party-player-joined", profile: publicProfile(profile) });
          broadcastRoomState(room);
          return;
        }

        const room = currentRoom ? rooms.get(currentRoom) : null;
        const player = room ? getPlayer(room, ws) : null;
        if (!room || !player) {
          send(ws, { type: "error", code: "not-in-room", error: "Create or join a room first" });
          return;
        }
        touchRoom(room);
        ws.outmazeLastActivityAt = now();

        if (room.mode === "party") {
          if (type === "party-settings") {
            if (room.players[0] !== player || room.phase !== "lobby") return;
            room.roundsTotal = normalizeRoundCount(message.rounds);
            broadcastRoomState(room);
            return;
          }
          if (type === "party-fill-ai") {
            if (room.players[0] !== player || room.phase !== "lobby" || room.preparingBots) return;
            if (message.enabled === false) room.bots.length = 0;
            else fillPartyWithBots(room);
            resequenceParty(room);
            broadcastRoomState(room);
            return;
          }
          if (type === "party-ai-adjust") {
            if (room.players[0] !== player || room.phase !== "lobby" || room.preparingBots) return;
            adjustPartyBots(room, Math.sign(Number(message.delta) || 0));
            broadcastRoomState(room);
            return;
          }
          if (type === "party-ready") {
            if (room.phase !== "lobby") return;
            if (message.ready) room.ready.add(ws);
            else room.ready.delete(ws);
            broadcastRoomState(room);
            return;
          }
          if (type === "party-start") {
            if (room.players[0] !== player || room.phase !== "lobby") return;
            if (partyParticipants(room).length < 2 || room.ready.size !== room.players.length) {
              send(ws, { type: "error", code: "party-not-ready", error: "Every player must be ready before the party starts" });
              return;
            }
            await startPartyRound(room, true);
            return;
          }
          if (type === "party-early-start") {
            if (room.phase !== "building" || room.locked || message.roundId !== room.roundId) return;
            if (message.vote) room.earlyVotes.add(ws);
            else room.earlyVotes.delete(ws);
            broadcastRoomState(room);
            if (room.earlyVotes.size === room.players.length) lockPartyRound(room, "early");
            return;
          }
          if (type === "party-maze") {
            if (room.phase !== "building" || !room.locked || message.roundId !== room.roundId) {
              send(ws, { type: "error", code: "maze-not-expected", error: "That party round is not accepting mazes" });
              return;
            }
            if (!room.submissions.has(ws)) {
              const validated = validateMazeForSeed(room.seed, message.payload);
              const payload = { grid: validated.grid, special: validated.special };
              room.submissions.set(ws, { payload, time: simulateValidatedMaze(validated) });
            }
            send(ws, {
              type: "party-maze-accepted",
              roundId: room.roundId,
              submitted: room.submissions.size,
              required: partyParticipants(room).length
            });
            revealPartyIfReady(room);
            return;
          }
          if (type === "party-next") {
            if (room.players[0] !== player || room.phase !== "results") return;
            const complete = room.roundNumber >= room.roundsTotal;
            if (!complete || !message.restart) return;
            await startPartyRound(room, true);
            return;
          }
          send(ws, { type: "error", code: "unknown-message", error: "Unknown party message type" });
          return;
        }

        if (type === "ready") {
          if (room.phase !== "lobby") return;
          room.ready.add(ws);
          broadcastRoomState(room);
          if (room.players.length === 2 && room.ready.size === 2) startRound(room, false);
          return;
        }

        if (type === "early-start") {
          if (room.phase !== "building" || room.locked || message.roundId !== room.roundId) return;
          if (message.vote) room.earlyVotes.add(ws);
          else room.earlyVotes.delete(ws);
          sendEarlyStartState(room);
          if (room.earlyVotes.size === 2) lockRound(room, "early");
          return;
        }

        if (type === "maze") {
          if (room.phase !== "building" || !room.locked || message.roundId !== room.roundId) {
            send(ws, { type: "error", code: "maze-not-expected", error: "That round is not accepting mazes" });
            return;
          }
          const validated = validateMazePayload(message.payload);
          if (validated.error) {
            send(ws, { type: "error", code: "invalid-maze", error: validated.error });
            return;
          }
          if (!room.submissions.has(ws)) room.submissions.set(ws, validated.value);
          send(ws, {
            type: "maze-accepted",
            roundId: room.roundId,
            submitted: room.submissions.size,
            required: 2
          });
          revealMazesIfReady(room);
          return;
        }

        if (type === "rematch") {
          if (room.phase !== "racing" || message.roundId !== room.roundId) return;
          const choice = message.choice === "same" || message.choice === "new" ? message.choice : null;
          if (!choice) return;
          room.rematchChoices.set(ws, choice);
          sendRematchState(room);
          if (room.rematchChoices.size === 2) {
            const choices = [...room.rematchChoices.values()];
            if (choices[0] === choices[1]) startRound(room, choices[0] === "same");
          }
          return;
        }

        send(ws, { type: "error", code: "unknown-message", error: "Unknown message type" });
      } catch (error) {
        send(ws, {
          type: "error",
          code: error.code || "server-error",
          error: error.message || "Unexpected server error"
        });
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      leaveCurrentRoom();
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      const handleError = (error) => {
        server.off("listening", handleListening);
        reject(error);
      };
      const handleListening = () => {
        server.off("error", handleError);
        resolve(server.address());
      };
      server.once("error", handleError);
      server.once("listening", handleListening);
      server.listen(port, host);
    });
  }

  function close() {
    clearInterval(heartbeatTimer);
    clearInterval(cleanupTimer);
    rooms.forEach(clearRoomTimer);
    rooms.clear();
    wss.clients.forEach((client) => client.terminate());
    return new Promise((resolve) => {
      wss.close(() => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      });
    });
  }

  return { server, wss, rooms, listen, close };
}

if (require.main === module) {
  const usePersistentLocalStore = process.env.NODE_ENV !== "production" && process.env.FIRESTORE_ENABLED !== "true";
  const app = createOutmazeServer({
    store: usePersistentLocalStore
      ? createLocalFileStore(path.join(__dirname, ".outmaze-local-data.json"))
      : undefined
  });
  app
    .listen()
    .then(() => console.log(`Outmaze server listening at http://localhost:${DEFAULT_PORT}`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  const shutdown = () => {
    app.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

module.exports = {
  createOutmazeServer,
  normalizeOrigin,
  parseAllowedOrigins,
  normalizeRoomCode,
  validateMazePayload
};
