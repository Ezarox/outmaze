const assert = require("node:assert/strict");
const test = require("node:test");
const {
  AICore,
  createAuthService,
  createDailyService,
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
