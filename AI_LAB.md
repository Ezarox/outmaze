# Outmaze AI laboratory

The laboratory is separate from the opponent currently used by the game. It has five jobs:

1. Generate strong teacher mazes offline using the canonical runner simulation.
2. Compare them with frozen algorithm families such as the legacy and current production AI.
3. Train a small sequential policy from teacher layouts.
4. Combine learned proposals with a fixed deterministic search through partial mazes.
5. Evaluate the learned search only on held-out seeds.

The teacher has no rule saying that diagonals, pads, corridors, or any named tactic are good. Its only objective is the exact simulated escape time. It searches using a population, crossover, multi-placement mutations, resource removal, exact hazard relocation, and block-coordinate refinement.

## Determinism

Every teacher result is determined by:

- the seed;
- rules-engine and teacher versions;
- the complete teacher configuration;
- a fixed exact-simulation budget.

It never stops because a number of milliseconds elapsed. Worker count changes completion speed, not the result. Generated records include the configuration fingerprint, exact evaluation count, maze signature, rules version, and teacher version.

The generator checkpoints every completed seed. Running the same command again skips completed seeds, even if an earlier run was interrupted. It refuses to append a different configuration to an existing dataset. Training sorts records by seed, so worker completion order cannot change the model.

## 1. Quick verification

From the Outmaze directory, run:

```powershell
npm.cmd run ai:teacher -- --split=test --count=2 --evaluations=500 --population=10 --coordinate-passes=0 --legacy-seed=false --production-seed=false --output=ai-data/quick-check.jsonl
```

This is only a pipeline check, not useful training data.

To examine one familiar seed before starting a dataset run:

```powershell
npm.cmd run ai:solve -- --seed=1327684 --evaluations=6000 --population=12 --elite-pool=6 --coordinate-passes=1 --hazard-interval=0 --hazard-candidates=0 --output=ai-data/seed-1327684.jsonl
```

On the development machine, this fixed-budget configuration improved the current production result from 41.55s to 45.88s. More evaluations are not guaranteed to improve every configuration, so compare settings across validation seeds rather than repeatedly tuning one familiar seed.

## 2. Generate a pilot dataset

These three commands create disjoint training, validation, and test sets:

```powershell
npm.cmd run ai:teacher -- --split=train --count=100 --evaluations=6000 --workers=4 --output=ai-data/teacher-train-pilot.jsonl

npm.cmd run ai:teacher -- --split=validation --count=25 --evaluations=6000 --workers=4 --output=ai-data/teacher-validation-pilot.jsonl

npm.cmd run ai:teacher -- --split=test --count=25 --evaluations=6000 --workers=4 --output=ai-data/teacher-test-pilot.jsonl
```

`--workers=4` is a reasonable starting point. Lower it if the computer becomes uncomfortable to use. Increasing or decreasing it cannot change the mazes.

The default teacher includes deterministic layouts from both the legacy and current production algorithm families as starting hypotheses. It then improves them using exact-only optimisation. Disable either with `--legacy-seed=false` or `--production-seed=false` when conducting an ablation experiment.

Important quality knobs:

- `--evaluations`: total exact runner simulations per seed. This is the main strength/runtime control.
- `--population`: number of diverse complete mazes retained.
- `--elite-pool`: number of leading mazes allowed to produce mutations.
- `--mutation-moves`: maximum coordinated placements changed in one mutation.
- `--coordinate-passes`: systematic exact relocation passes over every resource.
- `--hazard-interval` and `--hazard-candidates`: periodic exact hazard searches.

Start with 6,000 evaluations. Once the reports show that more evaluations continue to add value, a serious run can use 15,000–30,000 evaluations and a larger seed count.

## 3. Inspect teacher quality

```powershell
npm.cmd run ai:report -- --input=ai-data/teacher-validation-pilot.jsonl
```

The important result is gain over production on unseen validation seeds. Do not tune against the test split. Reserve it for occasional milestone comparisons.

## 4. Historical independent-placement baseline

```powershell
npm.cmd run ai:train -- --input=ai-data/teacher-train-pilot.jsonl --output=ai-models/policy-pilot.json --epochs=16 --hidden=64 --negatives=3
```

This first prototype judged every placement against the untouched board. It is retained as a reproducible baseline, but its independent placements recover too little teacher performance for use in the game.

## 5. Evaluate without contaminating training

```powershell
npm.cmd run ai:evaluate -- --model=ai-models/policy-pilot.json --input=ai-data/teacher-validation-pilot.jsonl
```

This reports teacher time, learned-policy time, teacher-score recovery, and placement recall. Evaluate on validation while changing model and search settings. Use the test dataset only after choosing a candidate model.

## 6. Train the sequential learned search

```powershell
npm.cmd run ai:train-sequential -- --input=ai-data/teacher-train-pilot.jsonl --output=ai-models/sequential-policy-v3-diverse.json --epochs=12 --hidden=48 --negatives=2 --samples-per-seed=4 --learning-rate=0.006
```

Unlike the historical prototype, this model sees the board after every placement. Its inputs include the current route, nearby structures and pads, remaining resources, and the pathfinder's counterfactual result after a proposed move. The counterfactual features describe general consequences such as route distance, turns, and pads encountered; they do not encode named maze patterns.

At inference time, a cheap learned screening pass examines the whole board. The full counterfactual path analysis is then applied to only a fixed number of promising cells. A small beam preserves several coherent partial mazes, and the canonical exact runner simulation chooses among a fixed number of finalists.

Evaluate it on validation with:

```powershell
npm.cmd run ai:evaluate-sequential -- --model=ai-models/sequential-policy-v3-diverse.json --input=ai-data/teacher-validation-pilot.jsonl --summary-only=true --check-repeatability=true --causal=36
```

The principal runtime/quality controls are `--beam`, `--branches`, `--causal`, `--hazards`, and `--exact`. They are fixed work counts, never elapsed-time cutoffs, so the same model and seed produce the same maze on every machine.

The 300-seed model is a research checkpoint, not the browser opponent. It materially outperforms the independent-placement prototype, but it must beat or safely augment the production AI across a much larger validation set before integration.

## 7. Complete-maze value learning

The expanded validation revealed that evolutionary genomes do not contain a meaningful construction order. Treating their internal array order as an expert demonstration caused compounding errors as wall counts increased.

The replacement pipeline learns the value of complete mazes instead:

```powershell
npm.cmd run ai:train-value -- --input=ai-data/teacher-train-pilot.jsonl --output=ai-models/complete-value-v1-1800.json --epochs=8 --hidden=24 --samples-per-seed=12

npm.cmd run ai:evaluate-value -- --model=ai-models/complete-value-v1-1800.json --input=ai-data/teacher-validation-pilot.jsonl
```

Teacher populations provide direct exact labels for strong and weak complete layouts. The value model ranks candidates without relying on wall order. On the 200-seed validation set, exact-simulating only the four highest-ranked layouts recovered the population winner with 0.22 seconds mean regret in the first experiment; later on-policy training reduced this to 0.16 seconds.

The proposal model is also trained only on near-best layouts and uses a canonical greedy route-consequence ordering rather than mutation order. Complete-layout mutation search then uses the value model to screen hundreds of coordinated candidates and exact-simulates a small fixed set per generation.

## 8. On-policy value training

Generate exact labels for mazes the learned search actually visits:

```powershell
npm.cmd run ai:generate-rollouts -- --input=ai-data/teacher-train-pilot.jsonl --value=ai-models/complete-value-v1-1800.json --proposal=ai-models/sequential-policy-v3-quality.json --count=400 --workers=4 --generations=8 --proposals=320 --exact=16 --elites=12 --population=24 --output=ai-data/complete-rollouts-v1.jsonl
```

Then mix those records with the teacher population:

```powershell
npm.cmd run ai:train-value -- --input=ai-data/teacher-train-pilot.jsonl,ai-data/complete-rollouts-v1.jsonl --output=ai-models/complete-value-v2-on-policy.json --epochs=10 --hidden=32 --samples-per-seed=16 --learning-rate=0.0022
```

Rollout generation is deterministic, parallel, checkpointed per seed, and resumable. A second on-policy iteration was tested but did not improve self-generated validation performance, so `complete-value-v2-on-policy.json` remains the selected model.

## 9. Current complete-search benchmark

```powershell
npm.cmd run ai:evaluate-complete -- --value=ai-models/complete-value-v2-on-policy.json --proposal=ai-models/sequential-policy-v3-quality.json --input=ai-data/teacher-validation-pilot.jsonl --summary-only=true --generations=12 --proposals=320 --exact=16 --elites=12 --population=24 --check-repeatability=true
```

Across 200 held-out validation seeds, the learned-only profile recorded 103 wins and 97 losses versus production, +0.08 seconds mean gain, +0.37 seconds median gain, 92.2% mean teacher recovery, and 2.21 seconds mean runtime. This is a major improvement over the earlier sequential model's 60 wins, 140 losses, and -5.55 seconds mean gain.

Adding a deterministic 500-candidate bounded production seed improved the portfolio to 135 wins, 5 ties, 60 losses, +1.67 seconds mean gain, +1.36 seconds median gain, and 96.2% teacher recovery, at 3.17 seconds mean runtime. However, the worst remaining validation loss was -20.19 seconds. This profile is therefore a research candidate, not the deployed Hard opponent.

The untouched test split must remain untouched until the validation candidate is clearly stronger, has acceptable tail risk, and has a production-ready browser runtime.

## 10. Pair and route-interdiction search experiment

The deterministic search laboratory also contains four non-learned construction methods:

- `single`: a diverse beam that commits one wall and replans all alternate routes;
- `pair`: joint evaluation of legal two-wall placements before either placement is committed;
- `pair-rollout`: pair search whose branches are ranked by a deterministic greedy completion and exact runner simulation;
- `interdiction`: variable two-to-five-wall bundles aimed at several penalised alternate routes, with a structural bonus for placements that bridge nearby existing wall components.

All methods use fixed work budgets, preserve multiple route signatures, place singles and hazards after wall construction, and exact-simulate their finalists. They never use the player's result or an elapsed-time cutoff. Run the comparison with:

```powershell
npm.cmd run ai:benchmark-interdiction -- --count=50 --summary-only=true --output=ai-data/interdiction-methods-50.json
```

On the first 50 validation seeds, compared with the deployed production result stored in each teacher record:

| Method | W-L | Mean gain | Median gain | Teacher recovery | Mean build | p95 build | Worst gain |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Single wall | 15-35 | -4.93s | -4.19s | 81.8% | 0.94s | 1.47s | -38.54s |
| Wall pairs | 24-26 | -1.83s | -0.27s | 89.0% | 1.82s | 2.48s | -44.18s |
| Pairs with rollouts | 19-31 | -1.70s | -0.82s | 87.8% | 2.00s | 2.66s | -18.98s |
| Route interdiction | 15-35 | -4.79s | -3.08s | 82.2% | 1.51s | 2.43s | -38.13s |

Every method produced a complete legal layout on all 50 seeds. Pair search materially improves typical performance over single-wall search, confirming that useful changes can require coordinated placements. Completed rollouts reduce catastrophic tail risk, but do not improve the median. Larger interdiction bundles are not automatically better: preserving lanes for different bundle sizes helped, but frequent replanning remains more valuable than early commitment on this benchmark.

The methods are complementary. Exact-selecting the better of only `pair` and `pair-rollout` would score 30 wins and 20 losses, +1.04 seconds mean gain, +1.67 seconds median gain, and a -18.98 second worst case. Running both independently costs about 3.82 seconds on average, however. Exact-selecting the best of all four would average +2.43 seconds, but costs about 6.28 seconds sequentially and still has a -18.98 second worst case. These are diagnostic portfolios, not deployable profiles.

The conclusion is not that multi-placement search has failed. It exposes the next engineering target: share pair expansion work while retaining two genuinely independent beams, or learn a cheap seed-state selector whose decisions are validated on a separate validation slice. Neither should enter the browser until it beats production without the current tail losses. The test split remains untouched.

## 11. Pad-aware exact search experiment

The canonical simulator now reports exact temporal pad diagnostics rather than only counting which pads were touched. These include active and stacked slow/fast time, distance travelled under Stone, Rewind prefix time, Detour reverse distance, hazard exposure, and pad/hazard overlap. A deterministic pad analysis then constructs separate opportunities for:

- extending a straight Stone approach and exit lane;
- making the route to Rewind expensive before it is replayed;
- increasing the distance reversed by Detour;
- stacking slow pads with each other and the assigned hazard;
- removing avoidable speed-pad exposure.

The universal AI includes three exact pad specialists. Their small beam searches pad-specific cells and occasional coordinated wall pairs, then exact-simulates the completed maze and hazard. A second safe refinement removes two weak walls and exact-tests coordinated replacements around the best opportunity. The established production finalist and the best specialist are refined independently; the portfolio keeps the higher exact score, and the pair refinement accepts only improvements. This makes score regressions impossible relative to the established finalist for the same search run.

Run the experiment with:

```powershell
npm.cmd run benchmark:pads -- --count=50 --summary-only=true --output=ai-data/pad-aware-50.json
```

On the first 50 validation seeds, the safe portfolio produced:

| Profile | Improved | Tied | Regressed | Mean gain | Median gain | Maximum gain | Mean build | p95 build |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Established Hard | — | — | — | baseline | baseline | baseline | 4.03s | — |
| Pad-aware Hard | 25 | 25 | 0 | +2.05s | +0.03s | +27.01s | 5.44s | 10.17s |

This was the pre-optimization result. The extra search improved 25 of 50 seeds without a regression, but its 10.17-second tail was initially too slow for the live Start Now flow.

## 12. Live AI efficiency pass

The live AI now has one deterministic profile: the strongest bounded search plus the safe pad-aware portfolio above. The difficulty selector and its stored setting have been removed. Search effort is fixed by default, so the same version and seed produce the same layout independently of machine speed or player performance.

The efficiency pass keeps that work and its decisions intact while reducing the cost of executing it. It replaces allocation-heavy pathfinding with reusable fixed-grid buffers, reuses known routes between scoring stages, provides a diagnostics-free exact-simulation path for search, updates effect stacks in place, and removes duplicate validation, annotation, and refinement work. Generation profiles now also report path searches, expanded path nodes, simulations, simulation steps, diagnostic simulations, and grid clones.

Frozen before/after benchmarks produced:

| Search | Seeds | Mean before | Mean after | Mean reduction | p95 before | p95 after | Score/source changes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Core bounded search | 20 | 4.57s | 1.61s | 64.7% | 9.76s | 3.55s | 0 |
| Full pad-aware portfolio | 50 | 5.44s | 2.09s | 61.7% | 10.17s | 3.94s | 0 |

The optimized full portfolio retains the earlier quality result: 25 improved seeds, 25 ties, no regressions, and a +2.05-second mean score gain over the core finalist. With its p95 reduced below four seconds on the fixed 50-seed validation sample, it is now the universal browser opponent rather than an opt-in experiment.

Two expanded rare-pad samples confirmed that the result was not confined to the first mixed sample:

| Required pad | Seeds | Improved | Tied | Regressed | Mean gain | Median gain | Maximum gain |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Stone | 22 | 15 | 7 | 0 | +3.67s | +0.54s | +37.11s |
| Rewind | 17 | 7 | 10 | 0 | +4.34s | 0.00s | +27.01s |

The diagnostic changes across the mixed 50-seed sample explain where the gain came from. Mean speed-pad active time fell from 1.86 to 1.40 seconds, stacked slow time rose from 0.05 to 0.11 seconds, Rewind prefix time rose from 3.11 to 3.77 seconds per seed, and assigned-hazard exposure rose from 14.80 to 16.43 seconds. Speed/hazard overlap also fell from 0.42 to 0.18 seconds, while Stone/hazard overlap rose from 0.65 to 0.85 seconds.

The limitations are equally useful. Stone-active travel distance did not rise in aggregate, and Detour reverse distance was unchanged. Stone seeds still gained through safer route construction and better hazard overlap, but the specific straight-line objective needs more work. The strongest general mechanisms in this pass are speed avoidance, longer Rewind prefixes, exact hazard replanning, and coordinated pair repair—not every named pad heuristic.

## Recommended progression

1. Run the 100/25/25 pilot above.
2. Share the three report outputs and the validation policy evaluation.
3. Adjust teacher budgets or model capacity based on measured regret.
4. Generate a larger training set, keeping the validation and test seed definitions unchanged.
5. Train and evaluate the sequential search on the expanded validation set.
6. Only after unseen-seed results are strong and repeatable, integrate the frozen quantised model into the browser AI.

Generated datasets and model files are ignored by Git because they can become large. Back them up separately if a long run is valuable.

## Overnight expansion

After completing and reviewing the pilot, run:

```powershell
npm.cmd run ai:overnight
```

On the pilot machine this is estimated at approximately 4.5-5.75 hours with four workers. It expands the 6,000-evaluation training set to 1,800 seeds, expands the matching validation set to 200 seeds, and generates a matched 12,000-evaluation validation set so breadth and teacher depth can be compared statistically. It then trains the sequential model and evaluates it on the expanded held-out validation set automatically.

Preview the work without starting it with:

```powershell
npm.cmd run ai:overnight -- --dry-run=true
```

The process is resumable. If it is interrupted, run `npm.cmd run ai:overnight` again. Completed seeds are skipped after their batch has been safely written.
