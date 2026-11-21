# Sokoban Solver — make.fun entry

Push-optimal Sokoban solver for the
[sokoban-solver-01-run-20261121](https://make.fun/c/sokoban-solver-01-run-20261121)
competition ("Build the best Sokoban solver").

![Competition](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)
![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/top234/sokoban-solver-01-run-20261121-entry-v1/rank.svg)
![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/top234/sokoban-solver-01-run-20261121-entry-v1/reward.svg)

## How it works

Every level is a 1-wide hallway with 1–4 small rooms off it, and a box
pushed out of a room can never come back, so the rooms are independent
problems joined only by the player's walk. The solver:

1. Finds the rooms by connectivity (floor components off the hallway row).
2. Solves each room on its own with a push-based A*: state = sorted box
   positions + canonical player region, heuristic = min-cost box→goal
   assignment (Manhattan), pruned by dead squares (flood + wall-line
   runs) and frozen 2×2 blocks.
3. Falls back to a plain push BFS if A* exhausts its state budget, so a
   room still gets solved (suboptimally) instead of scoring 0.
4. Stitches the rooms together with BFS walks along the hallway.

Deterministic: every budget is a count of expanded states, never the
clock; tie-breaking is by insertion order; neighbour order is fixed.
No randomness, no clock reads.

## Results (local, kit scorer)

- Practice set: **1,000,000** — all 5 instances solved in exactly P*
  pushes (13/16/29/47/60), ~0.4 s for the whole set.
- 8 extra sets drawn from the kit generator (different seeds): **1,000,000**
  on every set, each under 0.6 s.
- Two runs produce byte-identical outputs.

## Run locally

```sh
INPUT_DIR=<kit>/practice/input OUTPUT_DIR=out node main.ts
```

`INPUT_DIR` / `OUTPUT_DIR` (or the starter's `MAKEFUN_INPUT_DIR` /
`MAKEFUN_OUTPUT_DIR`) override the `/input` and `/output` defaults the
grader uses.
