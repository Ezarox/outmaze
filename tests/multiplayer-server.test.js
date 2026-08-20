const assert = require("node:assert/strict");
const test = require("node:test");
const WebSocket = require("ws");
const { createOutmazeServer, normalizeRoomCode, validateMazePayload } = require("../server.js");
const { AICore, createMemoryStore } = require("../online-services.js");

function emptyGrid(marker = null) {
  const grid = Array.from({ length: 21 }, () => Array(21).fill(0));
  if (marker) grid[marker.y][marker.x] = marker.value;
  return grid;
}

function createClient(url, options = {}) {
  const ws = new WebSocket(url, options);
  const inbox = [];
  const waiters = [];
  const closed = new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      inbox.push(message);
    }
  });

  function next(predicate, timeoutMs = 1000) {
    const existingIndex = inbox.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(inbox.splice(existingIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("Timed out waiting for multiplayer message"));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  return {
    ws,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    closed,
    next,
    send(message) {
      ws.send(JSON.stringify(message));
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  };
}

function rejectedConnectionStatus(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once("open", () => reject(new Error("Rejected WebSocket connection unexpectedly opened")));
    ws.once("unexpected-response", (_request, response) => {
      const statusCode = response.statusCode;
      response.resume();
      resolve(statusCode);
    });
    ws.once("error", reject);
  });
}

test("room codes and submitted mazes are normalized and validated", () => {
  assert.equal(normalizeRoomCode(" ab-c2! "), "ABC2");
  assert.equal(normalizeRoomCode("abcdef"), "ABCDE");
  assert.match(validateMazePayload({ grid: [] }).error, /21 by 21/);
  assert.match(validateMazePayload({ grid: emptyGrid({ x: 2, y: 3, value: 99 }) }).error, /invalid cell/);
  const valid = validateMazePayload({
    grid: emptyGrid({ x: 2, y: 3, value: 14 }),
    special: { type: "row", placed: true, cell: { x: 4, y: 5 } }
  });
  assert.equal(valid.error, undefined);
  assert.equal(valid.value.grid[3][2], 14);
  assert.deepEqual(valid.value.special.cell, { x: 4, y: 5 });
});

test("public backend redirects visitors and only accepts configured browser origins", async (t) => {
  const allowedOrigin = "https://ezarox.github.io";
  const publicSiteUrl = `${allowedOrigin}/outmaze/`;
  const app = createOutmazeServer({ port: 0, allowedOrigins: [allowedOrigin], publicSiteUrl, serveStatic: false });
  const address = await app.listen();
  const httpUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}`;
  t.after(() => app.close());

  const landingResponse = await fetch(httpUrl, { redirect: "manual" });
  assert.equal(landingResponse.status, 302);
  assert.equal(landingResponse.headers.get("location"), publicSiteUrl);

  const accepted = createClient(wsUrl, { origin: allowedOrigin });
  t.after(() => accepted.close());
  await accepted.opened;

  assert.equal(await rejectedConnectionStatus(wsUrl, { origin: "https://example.com" }), 401);
  assert.equal(await rejectedConnectionStatus(wsUrl), 401);
});

test("server closes connections that do not authenticate promptly", async (t) => {
  const app = createOutmazeServer({ port: 0, requireProfiles: true, authTimeoutMs: 25 });
  const address = await app.listen();
  const client = createClient(`ws://127.0.0.1:${address.port}`);
  t.after(() => app.close());
  await client.opened;
  const closed = await client.closed;
  assert.equal(closed.code, 4401);
  assert.equal(closed.reason, "authentication-timeout");
});

test("authenticated players have time to create a missing profile", async (t) => {
  const app = createOutmazeServer({
    port: 0,
    requireProfiles: true,
    authTimeoutMs: 25,
    authService: { verify: async () => ({ uid: "new-player" }) },
    store: createMemoryStore()
  });
  const address = await app.listen();
  const client = createClient(`ws://127.0.0.1:${address.port}`);
  t.after(() => app.close());
  t.after(() => client.close());
  await client.opened;
  client.send({ type: "auth", token: "valid-token" });
  await client.next((message) => message.type === "profile-required");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(client.ws.readyState, WebSocket.OPEN);
});

test("server expires abandoned rooms and closes their active sockets", async (t) => {
  const app = createOutmazeServer({
    port: 0,
    roomIdleTimeoutMs: 30,
    cleanupIntervalMs: 10
  });
  const address = await app.listen();
  const client = createClient(`ws://127.0.0.1:${address.port}`);
  t.after(() => app.close());
  await client.opened;
  client.send({ type: "create" });
  const created = await client.next((message) => message.type === "created");
  assert.equal(app.rooms.has(created.room), true);
  const expired = await client.next((message) => message.type === "room-expired");
  assert.equal(expired.reason, "idle-timeout");
  const closed = await client.closed;
  assert.equal(closed.code, 4000);
  assert.equal(closed.reason, "idle-timeout");
  assert.equal(app.rooms.has(created.room), false);
});

test("server synchronizes a private two-player build before revealing either maze", async (t) => {
  const app = createOutmazeServer({ port: 0, buildSeconds: 30, startDelayMs: 10, random: () => 0.25 });
  const address = await app.listen();
  const url = `ws://127.0.0.1:${address.port}`;
  const healthResponse = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: "ok" });

  const publicHealthResponse = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.equal(publicHealthResponse.status, 200);
  assert.deepEqual(await publicHealthResponse.json(), { status: "ok" });
  const privateSourceResponse = await fetch(`http://127.0.0.1:${address.port}/server.js`);
  assert.equal(privateSourceResponse.status, 404);
  const host = createClient(url);
  const guest = createClient(url);
  t.after(async () => {
    host.close();
    guest.close();
    await app.close();
  });
  await Promise.all([host.opened, guest.opened]);

  host.send({ type: "create" });
  const created = await host.next((message) => message.type === "created");
  assert.equal(created.room.length, 5);

  guest.send({ type: "join", room: created.room.toLowerCase() });
  const joined = await guest.next((message) => message.type === "joined");
  assert.equal(joined.room, created.room);
  await host.next((message) => message.type === "peer-joined");

  host.send({ type: "ready" });
  guest.send({ type: "ready" });
  const [hostStart, guestStart] = await Promise.all([
    host.next((message) => message.type === "start"),
    guest.next((message) => message.type === "start")
  ]);
  assert.equal(hostStart.seed, guestStart.seed);
  assert.equal(hostStart.roundId, guestStart.roundId);
  assert.equal(hostStart.reuseMaze, false);

  host.send({
    type: "maze",
    roundId: hostStart.roundId,
    payload: { grid: emptyGrid({ x: 1, y: 1, value: 14 }), special: null }
  });
  const earlySubmissionError = await host.next((message) => message.code === "maze-not-expected");
  assert.match(earlySubmissionError.error, /not accepting/);

  host.send({ type: "early-start", roundId: hostStart.roundId, vote: true });
  const hostVote = await host.next((message) => message.type === "early-start-state" && message.self === true);
  const guestViewOfVote = await guest.next(
    (message) => message.type === "early-start-state" && message.peer === true
  );
  assert.equal(hostVote.peer, false);
  assert.equal(guestViewOfVote.self, false);

  guest.send({ type: "early-start", roundId: guestStart.roundId, vote: true });
  const [hostLock, guestLock] = await Promise.all([
    host.next((message) => message.type === "lock"),
    guest.next((message) => message.type === "lock")
  ]);
  assert.equal(hostLock.reason, "early");
  assert.equal(guestLock.roundId, hostStart.roundId);

  const hostMaze = { grid: emptyGrid({ x: 1, y: 1, value: 14 }), special: null };
  const guestMaze = {
    grid: emptyGrid({ x: 2, y: 2, value: 7 }),
    special: { type: "gravity", placed: true, cell: { x: 2, y: 2 } }
  };
  host.send({ type: "maze", roundId: hostStart.roundId, payload: hostMaze });
  await host.next((message) => message.type === "maze-accepted");
  await assert.rejects(guest.next((message) => message.type === "reveal", 60), /Timed out/);

  guest.send({ type: "maze", roundId: guestStart.roundId, payload: guestMaze });
  const [hostReveal, guestReveal] = await Promise.all([
    host.next((message) => message.type === "reveal"),
    guest.next((message) => message.type === "reveal")
  ]);
  assert.equal(hostReveal.payload.grid[2][2], 7);
  assert.equal(hostReveal.payload.special.type, "gravity");
  assert.equal(guestReveal.payload.grid[1][1], 14);

  host.send({ type: "rematch", roundId: hostStart.roundId, choice: "same" });
  guest.send({ type: "rematch", roundId: guestStart.roundId, choice: "same" });
  const [hostRematch, guestRematch] = await Promise.all([
    host.next((message) => message.type === "start" && message.roundId === hostStart.roundId + 1),
    guest.next((message) => message.type === "start" && message.roundId === guestStart.roundId + 1)
  ]);
  assert.equal(hostRematch.reuseMaze, true);
  assert.equal(hostRematch.seed, hostStart.seed);
  assert.equal(guestRematch.seed, guestStart.seed);

  guest.close();
  const peerLeft = await host.next((message) => message.type === "peer-left");
  assert.equal(peerLeft.type, "peer-left");
  const onePlayerState = await host.next(
    (message) => message.type === "room-state" && message.players === 1
  );
  assert.equal(onePlayerState.phase, "lobby");
});

test("server locks both builders at the shared deadline", async (t) => {
  const app = createOutmazeServer({ port: 0, buildSeconds: 0.04, startDelayMs: 0 });
  const address = await app.listen();
  const url = `ws://127.0.0.1:${address.port}`;
  const host = createClient(url);
  const guest = createClient(url);
  t.after(async () => {
    host.close();
    guest.close();
    await app.close();
  });
  await Promise.all([host.opened, guest.opened]);

  host.send({ type: "create" });
  const created = await host.next((message) => message.type === "created");
  guest.send({ type: "join", room: created.room });
  await guest.next((message) => message.type === "joined");
  host.send({ type: "ready" });
  guest.send({ type: "ready" });

  const [hostStart, guestStart] = await Promise.all([
    host.next((message) => message.type === "start"),
    guest.next((message) => message.type === "start")
  ]);
  assert.equal(hostStart.buildEndsAt, guestStart.buildEndsAt);
  const [hostLock, guestLock] = await Promise.all([
    host.next((message) => message.type === "lock", 500),
    guest.next((message) => message.type === "lock", 500)
  ]);
  assert.equal(hostLock.reason, "timer");
  assert.equal(guestLock.roundId, guestStart.roundId);
});

test("party rooms synchronize three builders, award points, and automatically start the next round", async (t) => {
  const app = createOutmazeServer({
    port: 0,
    buildSeconds: 30,
    random: () => 0.42,
    partyIntermissionMs: 20,
    partyPlaybackScale: 0
  });
  const address = await app.listen();
  const url = `ws://127.0.0.1:${address.port}`;
  const players = [createClient(url), createClient(url), createClient(url)];
  t.after(async () => {
    players.forEach((player) => player.close());
    await app.close();
  });
  await Promise.all(players.map((player) => player.opened));

  players[0].send({ type: "party-create", rounds: 3 });
  const created = await players[0].next((message) => message.type === "party-created");
  players[1].send({ type: "party-join", room: created.room });
  players[2].send({ type: "party-join", room: created.room });
  await Promise.all([
    players[1].next((message) => message.type === "party-joined"),
    players[2].next((message) => message.type === "party-joined")
  ]);
  for (const player of players) player.send({ type: "party-ready", ready: true });
  await players[0].next(
    (message) => message.type === "party-state" && message.members.length === 3 && message.members.every((member) => member.ready)
  );
  players[0].send({ type: "party-start" });
  const starts = await Promise.all(players.map((player) => player.next((message) => message.type === "party-start")));
  assert.equal(new Set(starts.map((message) => message.seed)).size, 1);
  assert.equal(starts[0].round, 1);
  assert.equal(starts[0].rounds, 3);

  for (const player of players) {
    player.send({ type: "party-early-start", roundId: starts[0].roundId, vote: true });
  }
  await Promise.all(players.map((player) => player.next((message) => message.type === "party-lock")));
  const round = AICore.createRound(starts[0].seed);
  const payload = { grid: AICore.cloneGrid(round.baseGrid), special: AICore.cloneSpecial(round.specialTemplate) };
  players.forEach((player) => player.send({ type: "party-maze", roundId: starts[0].roundId, payload }));
  const results = await Promise.all(players.map((player) => player.next((message) => message.type === "party-results")));
  assert.equal(results[0].entries.length, 3);
  assert.equal(results[0].entries.every((entry) => entry.rank === 1 && entry.points === 2), true);
  assert.equal(results[0].entries.every((entry) => entry.totalTime === entry.time), true);
  assert.deepEqual(results[0].entries.map((entry) => entry.slot).sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(results[0].finalRound, false);
  assert.equal(results[0].nextRoundAt > Date.now(), true);
  const nextStarts = await Promise.all(players.map((player) => player.next((message) => message.type === "party-start", 1000)));
  assert.equal(nextStarts.every((message) => message.round === 2), true);
  assert.equal(new Set(nextStarts.map((message) => message.roundId)).size, 1);
});

test("party host can add and remove ready AI players one at a time and play without another human", async (t) => {
  const partyAiBuilder = ({ seed, variant }) => {
    const round = AICore.createRound(seed);
    return {
      grid: AICore.cloneGrid(round.baseGrid),
      special: AICore.cloneSpecial(round.specialTemplate),
      signature: `test-bot-${variant}`
    };
  };
  const app = createOutmazeServer({
    port: 0,
    buildSeconds: 30,
    random: () => 0.31,
    partyAiBuilder
  });
  const address = await app.listen();
  const host = createClient(`ws://127.0.0.1:${address.port}`);
  t.after(async () => {
    host.close();
    await app.close();
  });
  await host.opened;

  host.send({ type: "party-create", rounds: 2 });
  await host.next((message) => message.type === "party-created");
  let filled;
  for (let memberCount = 2; memberCount <= 8; memberCount++) {
    host.send({ type: "party-ai-adjust", delta: 1 });
    filled = await host.next(
      (message) => message.type === "party-state" && message.members.length === memberCount
    );
  }
  assert.equal(filled.members.filter((member) => member.bot).length, 7);
  assert.equal(filled.members.filter((member) => member.bot).every((member) => member.ready), true);
  assert.equal(new Set(filled.members.map((member) => member.uid)).size, 8);

  host.send({ type: "party-ai-adjust", delta: -1 });
  const reduced = await host.next(
    (message) => message.type === "party-state" && message.members.length === 7
  );
  assert.equal(reduced.members.filter((member) => member.bot).length, 6);
  host.send({ type: "party-ai-adjust", delta: 1 });
  filled = await host.next((message) => message.type === "party-state" && message.members.length === 8);

  host.send({ type: "party-ready", ready: true });
  await host.next((message) => message.type === "party-state" && message.members.every((member) => member.ready));
  host.send({ type: "party-start" });
  const preparing = await host.next((message) => message.type === "party-preparing");
  assert.equal(preparing.bots, 7);
  const start = await host.next((message) => message.type === "party-start", 3000);

  host.send({ type: "party-early-start", roundId: start.roundId, vote: true });
  await host.next((message) => message.type === "party-lock");
  const round = AICore.createRound(start.seed);
  host.send({
    type: "party-maze",
    roundId: start.roundId,
    payload: { grid: AICore.cloneGrid(round.baseGrid), special: AICore.cloneSpecial(round.specialTemplate) }
  });
  const results = await host.next((message) => message.type === "party-results", 3000);
  assert.equal(results.entries.length, 8);
  assert.equal(results.entries.filter((entry) => entry.uid.startsWith("bot-")).length, 7);
  assert.deepEqual(results.entries.map((entry) => entry.slot).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("a human joining a full AI-filled lobby replaces one bot", async (t) => {
  const app = createOutmazeServer({ port: 0, random: () => 0.19 });
  const address = await app.listen();
  const url = `ws://127.0.0.1:${address.port}`;
  const host = createClient(url);
  const guest = createClient(url);
  t.after(async () => {
    host.close();
    guest.close();
    await app.close();
  });
  await Promise.all([host.opened, guest.opened]);
  host.send({ type: "party-create", rounds: 1 });
  const created = await host.next((message) => message.type === "party-created");
  host.send({ type: "party-fill-ai", enabled: true });
  await host.next((message) => message.type === "party-state" && message.members.length === 8);
  guest.send({ type: "party-join", room: created.room });
  await guest.next((message) => message.type === "party-joined");
  const replaced = await host.next(
    (message) => message.type === "party-state" && message.members.some((member) => member.uid === "anonymous-2")
  );
  assert.equal(replaced.members.length, 8);
  assert.equal(replaced.members.filter((member) => member.bot).length, 6);
});

test("profile and daily HTTP APIs require identity and retain the best verified score", async (t) => {
  const store = createMemoryStore();
  const authService = { async verify(token) { return { uid: String(token) }; } };
  const dailyService = {
    async get(uid, day) {
      return { day: day || "2026-08-20", seed: "daily", aiTime: 10, leaderboard: [], uid };
    },
    async submit(uid) {
      return { submittedTime: 12, personalBest: 12, attempts: 1, rank: 1, uid };
    }
  };
  const app = createOutmazeServer({ port: 0, store, authService, dailyService });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => app.close());

  const unauthorized = await fetch(`${base}/api/profile`);
  assert.equal(unauthorized.status, 401);
  const saved = await fetch(`${base}/api/profile`, {
    method: "POST",
    headers: { Authorization: "Bearer profile-user", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Profile Fox", emoji: "🦊", recoveryPin: "246810" })
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).profile.name, "Profile Fox");
  const daily = await fetch(`${base}/api/daily?day=2026-08-19`, { headers: { Authorization: "Bearer profile-user" } });
  const dailyBody = await daily.json();
  assert.equal(dailyBody.uid, "profile-user");
  assert.equal(dailyBody.day, "2026-08-19");
  const submitted = await fetch(`${base}/api/daily/submit`, {
    method: "POST",
    headers: { Authorization: "Bearer profile-user", "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal((await submitted.json()).rank, 1);
});

test("profile HTTP API recovers an identity with its private PIN", async (t) => {
  const store = createMemoryStore();
  const authService = { async verify(token) { return { uid: String(token) }; } };
  const app = createOutmazeServer({ port: 0, store, authService });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => app.close());

  const created = await fetch(`${base}/api/profile`, {
    method: "POST",
    headers: { Authorization: "Bearer old-browser", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Recoverable Fox", emoji: "🦊", recoveryPin: "135790" })
  });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).profile.recoveryReady, true);

  const rejected = await fetch(`${base}/api/profile/recover`, {
    method: "POST",
    headers: { Authorization: "Bearer new-browser", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Recoverable Fox", emoji: "🦊", recoveryPin: "000000" })
  });
  assert.equal(rejected.status, 403);

  const recovered = await fetch(`${base}/api/profile/recover`, {
    method: "POST",
    headers: { Authorization: "Bearer new-browser", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Recoverable Fox", emoji: "🦊", recoveryPin: "135790" })
  });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).profile.uid, "new-browser");
  assert.equal(await store.getProfile("old-browser"), null);
});
