const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const DEFAULT_PORT = Number(process.env.PORT || 8080);
const DEFAULT_BUILD_SECONDS = 60;
const DEFAULT_START_DELAY_MS = 0;
const GRID_SIZE = 21;
const MAX_CELL_VALUE = 15;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SPECIAL_TYPES = new Set(["radius", "row", "column", "gravity", "lightning"]);
const DEFAULT_PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || "https://ezarox.github.io/outmaze/";
const PUBLIC_FILES = new Set(["index.html", "style.css", "ai-core.js", "ai-worker.js", "main.js"]);

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

function createHttpHandler({ publicSiteUrl = DEFAULT_PUBLIC_SITE_URL, rootDirectory = __dirname, serveStatic = false }) {
  const root = path.resolve(rootDirectory);
  return (req, res) => {
    const requestPath = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
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
  const server = http.createServer(createHttpHandler({ publicSiteUrl, rootDirectory, serveStatic }));
  const websocketOptions = { server, maxPayload: 256 * 1024 };
  if (allowedOrigins.size > 0) {
    websocketOptions.verifyClient = ({ origin }) => allowedOrigins.has(normalizeOrigin(origin));
  }
  const wss = new WebSocket.Server(websocketOptions);
  const rooms = new Map();
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

  function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function broadcast(room, message) {
    room.players.forEach((player) => send(player.ws, message));
  }

  function roomState(room) {
    return {
      type: "room-state",
      room: room.code,
      players: room.players.length,
      ready: room.ready.size,
      phase: room.phase,
      roundId: room.roundId || null
    };
  }

  function broadcastRoomState(room) {
    broadcast(room, roomState(room));
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
    if (!room.lockTimer) return;
    clearTimeout(room.lockTimer);
    room.lockTimer = null;
  }

  function resetRoundState(room) {
    clearRoomTimer(room);
    room.ready.clear();
    room.submissions.clear();
    room.earlyVotes.clear();
    room.rematchChoices.clear();
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
    room.players.splice(playerIndex, 1);
    resetRoundState(room);
    room.phase = "lobby";
    if (!room.players.length) {
      rooms.delete(room.code);
      return;
    }
    if (notify) broadcast(room, { type: "peer-left" });
    broadcastRoomState(room);
  }

  wss.on("connection", (ws) => {
    let currentRoom = null;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    function leaveCurrentRoom(notify = true) {
      if (!currentRoom) return;
      const room = rooms.get(currentRoom);
      if (room) detachPlayer(room, ws, notify);
      currentRoom = null;
    }

    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (_) {
        send(ws, { type: "error", code: "invalid-json", error: "Invalid message" });
        return;
      }

      const type = message?.type;
      if (type === "create") {
        leaveCurrentRoom();
        const code = makeRoomCode();
        const room = {
          code,
          players: [{ ws, slot: 1 }],
          ready: new Set(),
          submissions: new Map(),
          earlyVotes: new Set(),
          rematchChoices: new Map(),
          phase: "lobby",
          roundId: 0,
          seed: "",
          locked: false,
          lockTimer: null
        };
        rooms.set(code, room);
        currentRoom = code;
        send(ws, { type: "created", room: code, slot: 1 });
        broadcastRoomState(room);
        return;
      }

      if (type === "join") {
        const code = normalizeRoomCode(message.room);
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: "error", code: "room-not-found", error: "Room not found" });
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
        room.players.push({ ws, slot: 2 });
        currentRoom = code;
        send(ws, { type: "joined", room: code, slot: 2 });
        room.players.forEach((player) => {
          if (player.ws !== ws) send(player.ws, { type: "peer-joined" });
        });
        broadcastRoomState(room);
        return;
      }

      const room = currentRoom ? rooms.get(currentRoom) : null;
      const player = room ? getPlayer(room, ws) : null;
      if (!room || !player) {
        send(ws, { type: "error", code: "not-in-room", error: "Create or join a room first" });
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
        if (room.phase !== "racing") return;
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

      if (type === "leave") {
        leaveCurrentRoom();
        return;
      }

      send(ws, { type: "error", code: "unknown-message", error: "Unknown message type" });
    });

    ws.on("close", () => leaveCurrentRoom());
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
  const app = createOutmazeServer();
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
