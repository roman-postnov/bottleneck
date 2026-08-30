<h1 align="center"><a href="https://roman-postnov.github.io/bottleneck/">🚀 LIVE DEMO</a></h1>

# Bottleneck

**How fast can a city empty itself by car, and which roads decide the answer?**

A browser evacuation-capacity simulator on real OpenStreetMap data. Max-flow gives you a
number; the minimum cut gives you an address — the specific roads every car has to pass
through. Four cities ship ready to run, including Paradise, California, on the morning of the
Camp Fire.

<!-- Add a screenshot here once one exists: ![](docs/screenshot.png) -->

## Run it

```sh
npm i
npm run dev
```

Four cities are prebuilt in `public/cities/`, so nothing has to be downloaded or preprocessed:

| city | nodes | edges | people | ways out |
|---|---:|---:|---:|---:|
| Paradise, CA | 1 969 | 4 332 | 26 500 | 4 |
| Mercer Island, WA | 1 210 | 2 701 | 25 720 | 3 |
| Florida Keys, FL | 5 904 | 13 515 | 82 874 | 2 |
| San Francisco, CA | 14 149 | 33 798 | 830 235 | 12 |

Click a road to probe it; close it, add a lane or reverse it, and the run restarts with the
change stamped at the minute you made it. "Copy link" packs the whole scenario into the URL.

To rebuild a city from scratch: `data/raw/fetch.sh` (Geofabrik extracts) → `npm run extract`
(Python + pyosmium) → `npm run preprocess`.

`npm run check` is the gate: typecheck, lint, 222 tests.

## What's inside

The model is mesoscopic — queues on edges with a capacity and a storage limit — which is the
level where spillback appears as a consequence of the physics rather than as a drawn effect.

- **Dinic max-flow and the minimum cut** — `src/core/maxflow.ts:55`. Integer capacities in
  whole veh/h, so max-flow/min-cut equality is exact with no tuned epsilon, and an iterative
  blocking flow because a road network's level graph is deeper than the JS stack.
- **Daganzo node model** — `src/core/nodeModel.ts:55`. Capacity-weighted proportional
  allocation with saturation. The result does not depend on the order the nodes are walked in,
  and that is proved by a test, not asserted.
- **Route choice** — `src/core/routing.ts:160`. Reverse Dijkstra from the exits over an indexed
  binary heap, multinomial logit over the descent set (`:118`), and three potentials: one
  priced on free-flow time for the uninformed share, one on observed time for the informed
  share, and a third on the blend that decides which directions are allowed at all. Mixing the
  shares of two potentials instead deadlocks the network.
- **Graph preparation** — Tarjan SCC keeps the largest component and relocates the exits onto
  its frontier (`src/core/graph.ts:28`); missing lane counts are filled from the median of
  other segments of the same named road (`tools/preprocess.ts:170`), which is what stops
  Paradise's Skyway from leaving town as a single lane.
- **Departure** — a Rayleigh mobilization curve evaluated in closed form
  (`src/core/mobilization.ts:8`), so the departure count cannot drift away from the mass balance.
- **Determinism** — a hand-written xorshift128+ seeded through splitmix32
  (`src/core/rng.ts:22`). `Math.random` is banned in the model and in the worker, and the ban
  is a test. Two runs of the same scenario agree bit for bit.
- **One dot is one car** — `src/render/tracers.ts:699`. A dot's position is Newell's
  cumulative-count solution in closed form, so the number of dots on an edge equals the model's
  own `n[e]` by construction, and a car's whole route replays from 4-bit CSR decisions
  (`:602`). `dotError` (`:879`) reports the largest disagreement between what is drawn and what
  is simulated; it is asserted to stay at most 2 cars.
- **The honest metric** — `efficiency` in `src/core/metrics.ts:96` is peak outflow divided by
  the theoretical max-flow: the simulation measured against its own ceiling.

## Architecture

```
  src/core     pure model over typed arrays -- no DOM, no deck.gl, no React.
     |         Runs headless in node under vitest.
     v
  src/worker   the only place the model meets postMessage.
     |
     v
  src/main     store, worker client, wiring. Frames never pass through React;
     |  \      only a 200 ms-throttled summary reaches the UI.
     v   v
  src/ui   src/render   deck.gl layers, and a tracer state machine that itself
                        imports no deck.gl -- which is what lets it be tested.

  src/shared   a leaf under everything: the splitmix32 mixer and the metre projection,
               which both sides of the render boundary need and neither may reach across
               for. It imports nothing, which is the only thing that makes that sound.

  tools/       offline pipeline: .pbf -> intermediate JSON -> city.bin. Never imported from src.
```

Those arrows are enforced, not documented. Imports are checked by the linter: `biome.jsonc`
gives `src/core`, `src/render`, `src/worker` and `src/shared` a rule each, naming both the
packages and the sibling directories none of them may reach for — so `src/core` importing
`../ui/` is a build failure and not a matter of taste. The bans a linter cannot express are
checked by `test/boundaries.test.ts`, which reads the sources: `Math.random` in the model,
`postMessage` outside the worker, `console.log` in the tick, and any platform global in
`src/core` apart from the permalink codec, whose exemption is named and has its own test that
goes red the day the codec stops needing it.

The binary city format has one reader and one writer, and the writer imports the reader's
constants, because two independent statements of a layout drift apart silently. The worker
protocol is a discriminated union both sides import, so protocol drift is a compile error.
Units are in the names — `lenM`, `speedKmh`, `capVehS`, `ttSec` — everywhere but `SimState`'s
own clock and capacity fields (`t`, `cap`), which the tick touches on every edge and which no
rule enforces. There is no `any` in the codebase and no non-null assertion under `src/`.

One invariant lives in a comment rather than a type, and it is worth knowing before reading
`src/core/sim.ts`: `SimState` is a struct of arrays sized once, and the accumulators
`outAccum` and `depAccum` are drained by whoever ships a frame — `src/worker/sim.worker.ts`
clears them after a post that is definitely going out. The core only ever adds to them.

## Validation

Target ranges were written down **before** the model was run, because a range chosen afterwards
is fitting, not validation. Misses are recorded as misses.

- **Paradise / Camp Fire, 8 Nov 2018**, against NIST Technical Note 2252: 8 of 12 checks pass.
  The minimum cut landed on exactly the four arteries in a 2/1/1/1 lane split — 5 940 veh/h —
  matching the report's implied five lanes to the unit, with the lane counts coming from OSM
  and never from the report.
- **San Francisco**: 6 of 6. `t90` 10 h 14 min; closing the Bay Bridge costs 2 h 05 min.
- **Florida Keys**: 5 of 6. K4 missed — `t90` came out at 20 h 14 min against a claimed "more
  than a day", and the target was kept rather than moved.
- Failing checks are marked `it.fails` with a named reason, so the build turns red the day they
  start passing.

## Limitations

The model gives a **lower bound** on clearance time, for the **car-owning** part of the
population, inside the **given boundary**, under the **given schedule of closures**. Reality is
worse on all four axes at once — which is the point: it is the ceiling of what the network can
do, and nothing will beat it.
