"use strict";

const fs = require("node:fs");
const path = require("node:path");
require("../../ai-core.js");
const engine = global.AICore;
const { ACTION_TYPES, hydrateModel, rankCandidates } = require("./policy-model.js");

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, rawValue = "true"] = argument.slice(2).split("=");
    values[key] = rawValue;
  }
  return values;
}

function readRecords(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function key(cell) {
  return `${cell.x},${cell.y}`;
}

function recallFor(model, record, actionType) {
  const positives = actionType === "wall"
    ? record.solution.walls
    : actionType === "single"
      ? record.solution.singles
      : record.solution.special
        ? [record.solution.special]
        : [];
  if (!positives.length) return null;
  const positiveKeys = new Set(positives.map(key));
  const multiplier = actionType === "special" ? 8 : 2;
  const top = rankCandidates(model, record, actionType).slice(0, Math.max(1, positives.length * multiplier));
  return top.filter((cell) => positiveKeys.has(key(cell))).length / positives.length;
}

function constructLayout(model, record) {
  const grid = engine.cloneGrid(record.baseGrid);
  let walls = 0;
  for (const cell of rankCandidates(model, record, "wall")) {
    if (walls >= record.budgets.walls) break;
    if (!engine.canPlaceBlock(grid, cell.x, cell.y)) continue;
    engine.placeBlock(grid, cell.x, cell.y, engine.cells.PLAYER);
    engine.ensureOpenings(grid);
    if (!engine.hasPath(grid)) {
      engine.clearBlock(grid, cell.x, cell.y);
      engine.ensureOpenings(grid);
      continue;
    }
    walls++;
  }
  let singles = 0;
  for (const cell of rankCandidates(model, record, "single")) {
    if (singles >= record.budgets.singles) break;
    if (!engine.canPlaceSingle(grid, cell.x, cell.y)) continue;
    grid[cell.y][cell.x] = engine.cells.SINGLE;
    engine.ensureOpenings(grid);
    if (!engine.hasPath(grid)) {
      grid[cell.y][cell.x] = engine.cells.EMPTY;
      engine.ensureOpenings(grid);
      continue;
    }
    singles++;
  }
  const hazardCell = rankCandidates(model, record, "special").find((cell) => {
    if (!engine.isCellAvailableForSpecial(grid, cell.x, cell.y)) return false;
    grid[cell.y][cell.x] = engine.cells.SPECIAL;
    engine.ensureOpenings(grid);
    const valid = engine.hasPath(grid);
    grid[cell.y][cell.x] = engine.cells.EMPTY;
    engine.ensureOpenings(grid);
    return valid;
  });
  if (!hazardCell) return null;
  grid[hazardCell.y][hazardCell.x] = engine.cells.SPECIAL;
  const special = engine.createSpecialTemplate(record.specialType);
  special.placed = true;
  special.cell = { x: hazardCell.x, y: hazardCell.y };
  const score = engine.simulateRunnerTime(grid, special, record.neutralSpecial ? [record.neutralSpecial] : []);
  return { score, walls, singles };
}

const args = parseArguments(process.argv.slice(2));
if (!args.model || !args.input) throw new Error("Use --model=... --input=...");
const model = hydrateModel(JSON.parse(fs.readFileSync(path.resolve(args.model), "utf8")));
const records = readRecords(path.resolve(args.input));
const rows = records.map((record) => {
  const layout = constructLayout(model, record);
  return {
    seed: record.seed,
    teacher: record.solution.score,
    learned: layout?.score ?? 0,
    ratio: layout?.score ? layout.score / record.solution.score : 0,
    wallRecall: recallFor(model, record, "wall"),
    singleRecall: recallFor(model, record, "single"),
    hazardRecall: recallFor(model, record, "special")
  };
});
console.table(
  rows.map((row) => ({
    seed: row.seed,
    teacher: row.teacher.toFixed(2),
    learned: row.learned.toFixed(2),
    ratio: `${(row.ratio * 100).toFixed(1)}%`,
    wallRecall: row.wallRecall == null ? "-" : `${(row.wallRecall * 100).toFixed(0)}%`,
    singleRecall: row.singleRecall == null ? "-" : `${(row.singleRecall * 100).toFixed(0)}%`,
    hazardRecall: row.hazardRecall == null ? "-" : `${(row.hazardRecall * 100).toFixed(0)}%`
  }))
);
const mean = (field) => rows.reduce((sum, row) => sum + (row[field] || 0), 0) / rows.length;
console.log({
  seeds: rows.length,
  meanTeacherTime: Number(mean("teacher").toFixed(2)),
  meanLearnedTime: Number(mean("learned").toFixed(2)),
  meanTeacherRatio: `${(mean("ratio") * 100).toFixed(1)}%`
});
