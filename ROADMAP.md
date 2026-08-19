# Outmaze roadmap

## Product rules

- The objective is to maximise the runner's escape time. The longest time wins.
- The runner deliberately chooses the shortest geometric route and does not account for hazards.
- Route previews and estimated times remain hidden; learning to predict the runner is part of play.
- Players may start at any time with walls, singles, or their assigned hazard left unspent.
- Slow and hazard effects stack fully.
- Both builders receive the same varied seed, generated walls, pads, hazard type, and build resources.
- The central opening corridor remains part of seed generation.
- A round can contain at most one lightning hazard.

## Pass 1 — single-player experience

- [x] Rename the game to Outmaze.
- [x] Clarify the objective and shortest-route runner behavior.
- [x] Use a full-size single board during construction.
- [x] Reveal the opponent board before releasing the runners.
- [x] Add Start Now and permit unspent walls and singles.
- [x] Rework the control hierarchy, tool cards, tutorial, and seed-specific notable elements.
- [x] Add keyboard controls, live announcements, reduced-motion support, and clearer non-color labels.
- [x] Replace the browser Quit action with a reusable How to Play screen.
- [x] Reframe Gravity Well as Pressure Field, remove visual pulling, and expand its proximity slow.
- [x] Prevent neutral and assigned lightning hazards from appearing together.

## Pass 2 — canonical rules engine and tests

- [x] Extract grid generation, pathfinding, placement validation, effects, and runner simulation from UI code.
- [x] Make the live game and AI use exactly one simulation implementation.
- [x] Add deterministic seed fixtures and tests for every pad and hazard interaction.
- [x] Add build, race, retry, timeout, and invalid-placement regression tests.
- [x] Add performance instrumentation that reports real timings.
- [x] Remove duplicated and shadowed functions from `main.js` and `ai-core.js`.

## Pass 3 — AI replacement

- [x] Replace the current weighted greedy/branch system.
- [x] Generate candidates from routes, choke points, existing barriers, and hazard lanes.
- [x] Jointly plan walls, singles, and the assigned hazard.
- [x] Use a deterministic bounded search with caching and a firm generation-time budget.
- [x] Evaluate finalists with the canonical exact simulation.
- [x] Benchmark quality, hazard use, structure use, and latency over a fixed seed suite.
- [x] Add tactical portfolios for diagonal wall chains, slow-pad corridors, and reverse-pad lane reuse.
- [x] Track actual pad triggers and benchmark reported human runs without relying on legacy-AI scores.
- [x] Use the strongest Hard search as the single AI opponent, with no difficulty selector.
- [x] Add deterministic pad-specific specialists, exact pad diagnostics, and safe coordinated pair refinement.
- [x] Reduce pad-aware search tail latency and enable it in the universal live AI.

## Pass 4 — multiplayer

- [x] Restore and test the two-player local lobby and WebSocket flow.
- [x] Use the single-board build view and opponent reveal transition for both players.
- [x] Validate shared seeds, private maze submission, rematches, early starts, and disconnect recovery locally.
- [x] Separate production hosting and deployment from local multiplayer implementation.
- [x] Require one persistent Google-backed name and emoji across online modes.
- [x] Add 2–8 player Party Mode with host-selected rounds, synchronized private builds, placement points, and an all-maze race gallery.
- [x] Add a UTC Daily Challenge with a hidden AI maze, public AI benchmark, unlimited edits, server-verified results, and a global best-time leaderboard.
- [ ] Add reconnect grace periods and move live room state out of the single Cloud Run instance before scaling horizontally.

## Later modes

- [ ] Streak mode: derive a sequence of rounds from one seed and continue until the player loses.
- [ ] Score a streak using combined runner time, rewarding both round optimisation and endurance.
