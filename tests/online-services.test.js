const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  AICore,
  buildPartyAiMaze,
  createAuthService,
  createDailyService,
  createLocalFileStore,
  createMemoryStore,
  dailySeed,
  scorePartyPlacements,
  validateMazeForSeed
} = require("../online-services.js");

function basePayload(seed) {
  const round = AICore.createRound(seed);
  return {
    grid: AICore.cloneGrid(round.baseGrid),
    special: AICore.cloneSpecial(round.specialTemplate)
  };
}

test("profiles normalize names, reserve them globally, and require an allowed emoji", async () => {
  const store = createMemoryStore();
  const first = await store.saveProfile("one", { name: "  Maze   Fox ", emoji: "🦊" });
  assert.equal(first.name, "Maze Fox");
  await assert.rejects(
    store.saveProfile("two", { name: "maze fox", emoji: "🐸" }),
    (error) => error.code === "name-taken"
  );
  await assert.rejects(
    store.saveProfile("two", { name: "Valid Name", emoji: "💣" }),
    (error) => error.code === "invalid-emoji"
  );
});

test("local development identities are deterministic and do not accept empty ids", async () => {
  const auth = createAuthService({ firebase: false, allowDevTokens: true });
  assert.equal((await auth.verify("dev:player-one")).uid, "player-one");
  await assert.rejects(auth.verify("dev:"), (error) => error.code === "invalid-token");
});

test("local file storage retains profiles, Daily challenges, and scores across server restarts", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "outmaze-local-store-"));
  const file = path.join(directory, "data.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = createLocalFileStore(file);
  await first.saveProfile("returning-player", { name: "Returning Fox", emoji: "🦊" });
  await first.saveDailyChallenge("2026-08-20", {
    day: "2026-08-20",
    seed: "fixed-daily-seed",
    aiTime: 19.25,
    version: "daily-v1"
  });
  await first.saveDailyScore("2026-08-20", "returning-player", 25_000);

  const second = createLocalFileStore(file);
  assert.equal((await second.getProfile("returning-player")).name, "Returning Fox");
  assert.equal((await second.getDailyChallenge("2026-08-20")).seed, "fixed-daily-seed");
  assert.equal((await second.getDailyScore("2026-08-20", "returning-player")).bestMs, 25_000);
});

test("server maze validation accepts the exact seed and rejects mutations to fixed elements", () => {
  const seed = "server-validation-seed";
  const valid = validateMazeForSeed(seed, basePayload(seed));
  assert.equal(valid.seed, seed);
  assert.equal(AICore.hasPath(valid.grid), true);

  const mutated = basePayload(seed);
  let changed = false;
  for (let y = 0; y < 21 && !changed; y++) {
    for (let x = 0; x < 21 && !changed; x++) {
      if (mutated.grid[y][x] !== AICore.cells.EMPTY) {
        mutated.grid[y][x] = AICore.cells.EMPTY;
        changed = true;
      }
    }
  }
  assert.equal(changed, true);
  assert.throws(() => validateMazeForSeed(seed, mutated), (error) => error.code === "invalid-maze");
});

test("party placement points descend with rank and split tied positions", () => {
  const scored = scorePartyPlacements([
    { uid: "a", time: 20 },
    { uid: "b", time: 20 },
    { uid: "c", time: 10 },
    { uid: "d", time: 5 }
  ]);
  assert.deepEqual(
    scored.map(({ uid, rank, points }) => ({ uid, rank, points })),
    [
      { uid: "a", rank: 1, points: 3.5 },
      { uid: "b", rank: 1, points: 3.5 },
      { uid: "c", rank: 3, points: 2 },
      { uid: "d", rank: 4, points: 1 }
    ]
  );
});

test("party AI variants build distinct legal mazes for the same shared seed", () => {
  const seed = "party-ai-variants";
  const signatures = new Set();
  for (let variant = 0; variant < 3; variant++) {
    const layout = buildPartyAiMaze(seed, variant, signatures);
    const validated = validateMazeForSeed(seed, layout);
    assert.equal(AICore.hasPath(validated.grid), true);
    assert.equal(signatures.has(layout.signature), false);
    signatures.add(layout.signature);
  }
  assert.equal(signatures.size, 3);
});

test("daily challenge exposes only the AI time and keeps each profile's best verified result", async () => {
  const store = createMemoryStore();
  await store.saveProfile("daily-player", { name: "Daily Fox", emoji: "🦊" });
  const day = "2026-08-20";
  const service = createDailyService({
    store,
    now: () => new Date(`${day}T12:00:00Z`),
    aiBuilder: () => ({ simulatedTime: 12.345 })
  });
  const challenge = await service.get("daily-player");
  assert.equal(challenge.day, day);
  assert.equal(challenge.seed, dailySeed(day));
  assert.equal(challenge.aiTime, 12.345);
  assert.equal("maze" in challenge, false);

  const payload = basePayload(challenge.seed);
  const first = await service.submit("daily-player", payload);
  const second = await service.submit("daily-player", payload);
  assert.equal(first.submittedTime, second.submittedTime);
  assert.equal(second.personalBest, first.personalBest);
  assert.equal(second.attempts, 2);
  assert.equal(second.leaderboard[0].name, "Daily Fox");
});

test("daily progress remains visible when a player falls outside the top 100", async () => {
  const store = createMemoryStore();
  const day = "2026-08-20";
  await store.saveDailyChallenge(day, {
    day,
    seed: dailySeed(day),
    aiTime: 12.345,
    version: "daily-v1",
    rulesVersion: AICore.rulesVersion,
    aiVersion: AICore.aiVersion
  });
  await store.saveDailyScore(day, "outside", 1_000);
  for (let index = 0; index < 100; index++) {
    await store.saveDailyScore(day, `leader-${index}`, 2_000 + index);
  }
  const service = createDailyService({ store, now: () => new Date(`${day}T12:00:00Z`) });
  const challenge = await service.get("outside");
  assert.equal(challenge.leaderboard.length, 100);
  assert.equal(challenge.leaderboard.some((row) => row.uid === "outside"), false);
  assert.equal(challenge.personalBest, 1);
  assert.equal(challenge.attempts, 1);
});

test("an existing Daily challenge remains immutable across rules and AI releases", async () => {
  const store = createMemoryStore();
  const day = "2026-08-20";
  await store.saveDailyChallenge(day, {
    day,
    seed: "historic-seed-that-must-not-change",
    aiTime: 31.5,
    version: "an-older-daily-release",
    rulesVersion: "older-rules",
    aiVersion: "older-ai"
  });
  let builds = 0;
  const service = createDailyService({
    store,
    now: () => new Date(`${day}T12:00:00Z`),
    aiBuilder: () => {
      builds += 1;
      return { simulatedTime: 99 };
    }
  });

  const challenge = await service.get();
  assert.equal(challenge.seed, "historic-seed-that-must-not-change");
  assert.equal(challenge.aiTime, 31.5);
  assert.equal(challenge.version, "an-older-daily-release");
  assert.equal(builds, 0);
});

test("daily archive generates deterministic historical seeds and keeps each date's leaderboard separate", async () => {
  const store = createMemoryStore();
  await store.saveProfile("archive-player", { name: "Archive Fox", emoji: "🦊" });
  const service = createDailyService({
    store,
    now: () => new Date("2026-08-20T12:00:00Z"),
    aiBuilder: () => ({ simulatedTime: 15 })
  });

  const today = await service.get("archive-player");
  const archived = await service.get("archive-player", "2026-08-19");
  assert.equal(today.today, "2026-08-20");
  assert.equal(today.archiveStart, "2026-07-22");
  assert.equal(archived.day, "2026-08-19");
  assert.equal(archived.seed, dailySeed("2026-08-19"));
  assert.notEqual(archived.seed, today.seed);

  const result = await service.submit("archive-player", {
    ...basePayload(archived.seed),
    day: archived.day
  });
  assert.equal(result.day, archived.day);
  assert.equal(result.attempts, 1);
  assert.equal((await service.get("archive-player")).attempts, 0);

  await assert.rejects(service.get(null, "2026-08-21"), (error) => error.code === "daily-in-future");
  await assert.rejects(service.get(null, "2026-07-21"), (error) => error.code === "daily-out-of-range");
  await assert.rejects(service.get(null, "not-a-date"), (error) => error.code === "invalid-daily-day");
});
