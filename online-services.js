"use strict";

require("./ai-core.js");

const AICore = globalThis.AICore;
const PROFILE_EMOJIS = Object.freeze([
  "😀", "😎", "🤓", "🥳", "🤠", "👻", "🤖", "👽",
  "🐸", "🐱", "🐶", "🦊", "🐼", "🐙", "🦄", "🐲",
  "⚡", "🔥", "🌙", "⭐", "🍀", "🍕", "🎯", "🧩"
]);
const DAILY_VERSION = "daily-v1";

function createServiceError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeDisplayName(value) {
  const name = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 18) {
    throw createServiceError("invalid-name", "Names must contain between 2 and 18 characters");
  }
  if (!/^[\p{L}\p{N} _'’-]+$/u.test(name)) {
    throw createServiceError("invalid-name", "Names can use letters, numbers, spaces, apostrophes, underscores, and hyphens");
  }
  return name;
}

function profileNameKey(value) {
  return normalizeDisplayName(value).toLocaleLowerCase("en-US");
}

function normalizeEmoji(value) {
  const emoji = String(value || "");
  if (!PROFILE_EMOJIS.includes(emoji)) {
    throw createServiceError("invalid-emoji", "Choose one of the available profile emojis");
  }
  return emoji;
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    uid: profile.uid,
    name: profile.name,
    emoji: profile.emoji
  };
}

function createMemoryStore() {
  const profiles = new Map();
  const names = new Map();
  const dailyChallenges = new Map();
  const dailyScores = new Map();

  return {
    kind: "memory",
    async getProfile(uid) {
      return profiles.get(uid) || null;
    },
    async saveProfile(uid, value) {
      const name = normalizeDisplayName(value.name);
      const emoji = normalizeEmoji(value.emoji);
      const key = profileNameKey(name);
      const owner = names.get(key);
      if (owner && owner !== uid) throw createServiceError("name-taken", "That name is already in use", 409);
      const previous = profiles.get(uid);
      if (previous?.nameKey && previous.nameKey !== key) names.delete(previous.nameKey);
      names.set(key, uid);
      const profile = {
        uid,
        name,
        nameKey: key,
        emoji,
        createdAt: previous?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      profiles.set(uid, profile);
      return profile;
    },
    async getDailyChallenge(day) {
      return dailyChallenges.get(day) || null;
    },
    async saveDailyChallenge(day, challenge) {
      const existing = dailyChallenges.get(day);
      if (existing) return existing;
      dailyChallenges.set(day, { ...challenge });
      return challenge;
    },
    async saveDailyScore(day, uid, timeMs) {
      let scores = dailyScores.get(day);
      if (!scores) {
        scores = new Map();
        dailyScores.set(day, scores);
      }
      const previous = scores.get(uid);
      const next = {
        uid,
        bestMs: Math.max(Number(previous?.bestMs || 0), timeMs),
        attempts: Number(previous?.attempts || 0) + 1,
        updatedAt: Date.now()
      };
      scores.set(uid, next);
      return next;
    },
    async getDailyScore(day, uid) {
      return dailyScores.get(day)?.get(uid) || null;
    },
    async getDailyScores(day, limit = 100) {
      const scores = [...(dailyScores.get(day)?.values() || [])]
        .sort((a, b) => b.bestMs - a.bestMs || a.updatedAt - b.updatedAt)
        .slice(0, limit);
      return Promise.all(
        scores.map(async (score) => ({ ...score, profile: publicProfile(await this.getProfile(score.uid)) }))
      );
    }
  };
}

function createFirestoreStore(options = {}) {
  const { initializeApp, getApps, applicationDefault } = require("firebase-admin/app");
  const { getFirestore, FieldValue } = require("firebase-admin/firestore");
  if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: options.projectId });
  const db = getFirestore();

  return {
    kind: "firestore",
    async getProfile(uid) {
      const snapshot = await db.collection("profiles").doc(uid).get();
      return snapshot.exists ? { uid, ...snapshot.data() } : null;
    },
    async saveProfile(uid, value) {
      const name = normalizeDisplayName(value.name);
      const emoji = normalizeEmoji(value.emoji);
      const nameKey = profileNameKey(name);
      const profileRef = db.collection("profiles").doc(uid);
      const nameRef = db.collection("profileNames").doc(encodeURIComponent(nameKey));
      await db.runTransaction(async (transaction) => {
        const [profileSnapshot, nameSnapshot] = await Promise.all([
          transaction.get(profileRef),
          transaction.get(nameRef)
        ]);
        if (nameSnapshot.exists && nameSnapshot.data().uid !== uid) {
          throw createServiceError("name-taken", "That name is already in use", 409);
        }
        const previous = profileSnapshot.exists ? profileSnapshot.data() : null;
        if (previous?.nameKey && previous.nameKey !== nameKey) {
          transaction.delete(db.collection("profileNames").doc(encodeURIComponent(previous.nameKey)));
        }
        transaction.set(nameRef, { uid, updatedAt: FieldValue.serverTimestamp() });
        transaction.set(
          profileRef,
          {
            name,
            nameKey,
            emoji,
            createdAt: previous?.createdAt || FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      });
      return { uid, name, nameKey, emoji };
    },
    async getDailyChallenge(day) {
      const snapshot = await db.collection("dailyChallenges").doc(day).get();
      return snapshot.exists ? snapshot.data() : null;
    },
    async saveDailyChallenge(day, challenge) {
      const ref = db.collection("dailyChallenges").doc(day);
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) transaction.create(ref, { ...challenge, createdAt: FieldValue.serverTimestamp() });
      });
      return (await ref.get()).data();
    },
    async saveDailyScore(day, uid, timeMs) {
      const ref = db.collection("dailyChallenges").doc(day).collection("scores").doc(uid);
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const previous = snapshot.exists ? snapshot.data() : null;
        transaction.set(
          ref,
          {
            uid,
            bestMs: Math.max(Number(previous?.bestMs || 0), timeMs),
            attempts: Number(previous?.attempts || 0) + 1,
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      });
      const saved = await ref.get();
      return saved.data();
    },
    async getDailyScore(day, uid) {
      const snapshot = await db
        .collection("dailyChallenges")
        .doc(day)
        .collection("scores")
        .doc(uid)
        .get();
      return snapshot.exists ? { uid, ...snapshot.data() } : null;
    },
    async getDailyScores(day, limit = 100) {
      const snapshot = await db
        .collection("dailyChallenges")
        .doc(day)
        .collection("scores")
        .orderBy("bestMs", "desc")
        .limit(limit)
        .get();
      const rows = snapshot.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));
      const profileSnapshots = rows.length
        ? await db.getAll(...rows.map((row) => db.collection("profiles").doc(row.uid)))
        : [];
      return rows.map((row, index) => ({
        ...row,
        profile: profileSnapshots[index]?.exists
          ? publicProfile({ uid: row.uid, ...profileSnapshots[index].data() })
          : null
      }));
    }
  };
}

function createAuthService(options = {}) {
  const allowDevTokens = options.allowDevTokens !== false;
  let firebaseAuth = options.firebaseAuth || null;
  if (!firebaseAuth && options.firebase !== false) {
    try {
      const { initializeApp, getApps, applicationDefault } = require("firebase-admin/app");
      const { getAuth } = require("firebase-admin/auth");
      if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: options.projectId });
      firebaseAuth = getAuth();
    } catch (error) {
      if (!allowDevTokens) throw error;
    }
  }

  return {
    async verify(token) {
      const safeToken = String(token || "");
      if (allowDevTokens && safeToken.startsWith("dev:")) {
        const uid = safeToken.slice(4).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
        if (!uid) throw createServiceError("invalid-token", "Invalid local profile token", 401);
        return { uid, email: `${uid}@local.outmaze`, name: uid };
      }
      if (!firebaseAuth) throw createServiceError("auth-unavailable", "Google sign-in is not configured", 503);
      try {
        return await firebaseAuth.verifyIdToken(safeToken, true);
      } catch (_) {
        throw createServiceError("invalid-token", "Your sign-in expired. Please sign in again", 401);
      }
    }
  };
}

function utcDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

function dailySeed(day) {
  return `outmaze-${DAILY_VERSION}-${day}`;
}

function makeAiSnapshot(round, seed) {
  return {
    seed,
    baseGrid: AICore.cloneGrid(round.baseGrid),
    baseNeutralSpecials: round.neutralSpecial ? [AICore.cloneSpecial(round.neutralSpecial)] : [],
    coinBudget: round.coinBudget,
    singleBudget: round.singleBudget,
    specialTemplate: AICore.cloneSpecial(round.specialTemplate),
    rngSeed: AICore.hashSeed(`${seed}:daily-ai`),
    deterministicBudget: true
  };
}

function consumeWallCells(grid, baseGrid, cells, budget) {
  let count = 0;
  while (cells.size) {
    let anchor = null;
    for (const key of cells) {
      const [x, y] = key.split(",").map(Number);
      if (!anchor || y < anchor.y || (y === anchor.y && x < anchor.x)) anchor = { x, y };
    }
    const required = [
      `${anchor.x},${anchor.y}`,
      `${anchor.x + 1},${anchor.y}`,
      `${anchor.x},${anchor.y + 1}`,
      `${anchor.x + 1},${anchor.y + 1}`
    ];
    if (!required.every((key) => cells.has(key)) || !AICore.canPlaceBlock(grid, anchor.x, anchor.y)) {
      throw createServiceError("invalid-maze", "Player walls must be complete legal 2×2 placements");
    }
    AICore.placeBlock(grid, anchor.x, anchor.y, AICore.cells.PLAYER);
    required.forEach((key) => cells.delete(key));
    count++;
    if (count > budget) throw createServiceError("invalid-maze", "Maze uses too many 2×2 walls");
  }
  return count;
}

function validateMazeForSeed(seed, payload) {
  if (!payload || !Array.isArray(payload.grid) || payload.grid.length !== AICore.constants.GRID_SIZE) {
    throw createServiceError("invalid-maze", "Maze grid must be 21 by 21");
  }
  const round = AICore.createRound(seed);
  const grid = payload.grid.map((row) => {
    if (!Array.isArray(row) || row.length !== AICore.constants.GRID_SIZE) {
      throw createServiceError("invalid-maze", "Maze grid must be 21 by 21");
    }
    return row.map((cell) => {
      if (!Number.isInteger(cell) || cell < 0 || cell > AICore.cells.STATIC_SPECIAL) {
        throw createServiceError("invalid-maze", "Maze contains an invalid cell");
      }
      return cell;
    });
  });
  const reconstruction = AICore.cloneGrid(round.baseGrid);
  const wallCells = new Set();
  const singleCells = [];
  const specialCells = [];
  for (let y = 0; y < AICore.constants.GRID_SIZE; y++) {
    for (let x = 0; x < AICore.constants.GRID_SIZE; x++) {
      const base = round.baseGrid[y][x];
      const submitted = grid[y][x];
      if (base !== AICore.cells.EMPTY) {
        if (submitted !== base) throw createServiceError("invalid-maze", "Maze changes a fixed seed element");
        continue;
      }
      if (submitted === AICore.cells.EMPTY) continue;
      if (submitted === AICore.cells.PLAYER) wallCells.add(`${x},${y}`);
      else if (submitted === AICore.cells.SINGLE) singleCells.push({ x, y });
      else if (submitted === AICore.cells.SPECIAL) specialCells.push({ x, y });
      else throw createServiceError("invalid-maze", "Maze adds an element that is not available in this seed");
    }
  }

  consumeWallCells(reconstruction, round.baseGrid, wallCells, round.coinBudget);
  if (singleCells.length > round.singleBudget) throw createServiceError("invalid-maze", "Maze uses too many single walls");
  for (const cell of singleCells) {
    if (!AICore.canPlaceSingle(reconstruction, cell.x, cell.y)) {
      throw createServiceError("invalid-maze", "Maze contains an illegal single wall");
    }
    reconstruction[cell.y][cell.x] = AICore.cells.SINGLE;
  }

  const special = payload.special ? AICore.cloneSpecial(payload.special) : AICore.cloneSpecial(round.specialTemplate);
  if (special.type !== round.specialTemplate.type) {
    throw createServiceError("invalid-maze", "Maze uses the wrong hazard for this seed");
  }
  if (special.placed) {
    const x = Number(special.cell?.x);
    const y = Number(special.cell?.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || specialCells.length !== 1 || specialCells[0].x !== x || specialCells[0].y !== y) {
      throw createServiceError("invalid-maze", "Maze hazard does not match its placed tile");
    }
    if (!AICore.isCellAvailableForSpecial(reconstruction, x, y)) {
      throw createServiceError("invalid-maze", "Maze hazard is placed illegally");
    }
    reconstruction[y][x] = AICore.cells.SPECIAL;
  } else if (specialCells.length) {
    throw createServiceError("invalid-maze", "Maze contains an unassigned hazard tile");
  }
  AICore.ensureOpenings(reconstruction);
  if (!AICore.hasPath(reconstruction)) throw createServiceError("invalid-maze", "Maze blocks the runner's route");

  for (let y = 0; y < AICore.constants.GRID_SIZE; y++) {
    for (let x = 0; x < AICore.constants.GRID_SIZE; x++) {
      if (reconstruction[y][x] !== grid[y][x]) {
        throw createServiceError("invalid-maze", "Maze could not be reconstructed from legal placements");
      }
    }
  }
  return {
    seed: `${seed}`,
    grid,
    special,
    neutralSpecials: round.neutralSpecial ? [AICore.cloneSpecial(round.neutralSpecial)] : [],
    round
  };
}

function simulateValidatedMaze(validated) {
  const time = AICore.simulateRunnerTime(validated.grid, validated.special?.placed ? validated.special : null, validated.neutralSpecials);
  if (!Number.isFinite(time) || time <= 0) throw createServiceError("invalid-maze", "Runner could not complete this maze");
  return time;
}

function formatLeaderboard(rows) {
  return rows.map((row, index) => ({
    rank: index + 1,
    uid: row.uid,
    name: row.profile?.name || "Former player",
    emoji: row.profile?.emoji || "👤",
    time: Number(row.bestMs || 0) / 1000,
    attempts: Number(row.attempts || 0)
  }));
}

function createDailyService({ store, now = () => new Date(), aiBuilder = AICore.buildAiLayoutFromSnapshot } = {}) {
  const pending = new Map();
  async function challengeForDay(day = utcDay(now())) {
    const existing = await store.getDailyChallenge(day);
    if (existing?.version === DAILY_VERSION && Number(existing.aiTime) > 0) return existing;
    if (pending.has(day)) return pending.get(day);
    const promise = Promise.resolve().then(async () => {
      const seed = dailySeed(day);
      const round = AICore.createRound(seed);
      const ai = aiBuilder(makeAiSnapshot(round, seed));
      const aiTime = Number(ai?.simulatedTime) || AICore.simulateRunnerTime(
        ai.grid,
        ai.special,
        round.neutralSpecial ? [round.neutralSpecial] : []
      );
      if (!Number.isFinite(aiTime)) throw createServiceError("daily-unavailable", "Daily AI benchmark could not be generated", 503);
      return store.saveDailyChallenge(day, {
        day,
        seed,
        aiTime,
        version: DAILY_VERSION,
        rulesVersion: AICore.rulesVersion,
        aiVersion: AICore.aiVersion
      });
    }).finally(() => pending.delete(day));
    pending.set(day, promise);
    return promise;
  }

  return {
    async get(uid = null) {
      const challenge = await challengeForDay();
      const [scores, own] = await Promise.all([
        store.getDailyScores(challenge.day, 100),
        uid ? store.getDailyScore(challenge.day, uid) : null
      ]);
      return {
        day: challenge.day,
        seed: challenge.seed,
        aiTime: Number(challenge.aiTime),
        version: challenge.version,
        rulesVersion: challenge.rulesVersion,
        leaderboard: formatLeaderboard(scores),
        personalBest: own ? Number(own.bestMs) / 1000 : null,
        attempts: Number(own?.attempts || 0)
      };
    },
    async submit(uid, payload) {
      const challenge = await challengeForDay();
      const validated = validateMazeForSeed(challenge.seed, payload);
      const time = simulateValidatedMaze(validated);
      const timeMs = Math.round(time * 1000);
      const saved = await store.saveDailyScore(challenge.day, uid, timeMs);
      const result = await this.get(uid);
      const rank = result.leaderboard.find((row) => row.uid === uid)?.rank || null;
      return {
        ...result,
        submittedTime: timeMs / 1000,
        personalBest: Number(saved.bestMs) / 1000,
        attempts: Number(saved.attempts || 0),
        rank
      };
    }
  };
}

function scorePartyPlacements(entries) {
  const sorted = entries
    .map((entry) => ({ ...entry, timeMs: Math.round(Number(entry.time) * 1000) }))
    .sort((a, b) => b.timeMs - a.timeMs || String(a.uid).localeCompare(String(b.uid)));
  let index = 0;
  while (index < sorted.length) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].timeMs === sorted[index].timeMs) end++;
    let pointsTotal = 0;
    for (let position = index + 1; position <= end; position++) pointsTotal += sorted.length - position + 1;
    const points = pointsTotal / (end - index);
    for (let cursor = index; cursor < end; cursor++) {
      sorted[cursor].rank = index + 1;
      sorted[cursor].points = points;
    }
    index = end;
  }
  return sorted;
}

module.exports = {
  AICore,
  DAILY_VERSION,
  PROFILE_EMOJIS,
  createAuthService,
  createDailyService,
  createFirestoreStore,
  createMemoryStore,
  createServiceError,
  dailySeed,
  normalizeDisplayName,
  normalizeEmoji,
  profileNameKey,
  publicProfile,
  scorePartyPlacements,
  simulateValidatedMaze,
  utcDay,
  validateMazeForSeed
};
