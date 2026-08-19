const assert = require("node:assert/strict");
const test = require("node:test");
const WebSocket = require("ws");
const { createOutmazeServer, normalizeRoomCode, validateMazePayload } = require("../server.js");

function emptyGrid(marker = null) {
  const grid = Array.from({ length: 21 }, () => Array(21).fill(0));
  if (marker) grid[marker.y][marker.x] = marker.value;
  return grid;
}

function createClient(url, options = {}) {
  const ws = new WebSocket(url, options);
  const inbox = [];
  const waiters = [];

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

  host.send({ type: "rematch", choice: "same" });
  guest.send({ type: "rematch", choice: "same" });
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
