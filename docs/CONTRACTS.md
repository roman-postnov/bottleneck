# Bottleneck technical contracts

This document describes the invariants shared by the data pipeline, simulation core, worker,
renderer, and tests. The implementation and this document should agree. User-facing claims,
validation evidence, and known limits live in [VALIDATION.md](VALIDATION.md) and
[LIMITATIONS.md](LIMITATIONS.md).

## 0. System overview

Bottleneck is a browser-based vehicle evacuation simulator built from OpenStreetMap road data.
It uses a mesoscopic traffic model: queues live on directed road edges and a Daganzo-style node
model transfers flow through merges and diverges.

~~~text
.osm.pbf -> offline preprocessing -> city.bin -> Web Worker simulation -> frames -> map and UI
                 tools/synth.ts -------^
~~~

The deployed application is static. The browser downloads a preprocessed city, runs the model
in a Web Worker, and renders it with deck.gl over MapLibre.

## 1. Units

Values are converted once when a city or scenario is loaded. Runtime code uses the units below.

| Quantity | Unit | Representation |
|---|---|---|
| Binary coordinates | degrees multiplied by 1e7 | `Int32` |
| API coordinates | degrees | `number` |
| Edge length | metres | `Uint16` |
| Free-flow speed | kilometres per hour | `Uint8` in `city.bin` |
| Runtime capacity | vehicles per second | `Float32` |
| Max-flow capacity | whole vehicles per hour | `Int32` |
| Simulation time | seconds from the start | `number` |
| Population | people | `Float32` |
| Runtime demand | vehicles | `Float32` |

Unit-bearing variables use suffixes such as `lenM`, `speedKmh`, `capVehS`, `capVehH`,
`tSec`, and `tMin`. One tick is exactly one simulated second. Acceleration changes how many
whole ticks run between frames; it never changes the tick duration.

### 1.1 Acceleration and frames

`ticksPerFrame` is a target rate. The worker may send frames less often when a large graph
cannot run the requested number of ticks inside the frame budget. It continues to execute every
tick and reports achieved acceleration from simulated time divided by wall time.

### 1.2 Deterministic traversal

Within a tick, nodes are visited in ascending index order and outgoing edges stay in CSR order.
This makes floating-point accumulation reproducible. Correctness must not depend on that order;
the tests check reproducibility and order independence separately.

## 2. Model defaults

| Parameter | Default | Meaning |
|---|---:|---|
| `satFlowPerLane` | 1800 veh/h/lane | Base saturated flow |
| `jamSpacingM` | 7.5 m | Vehicle length plus stopped gap |
| `occupancy` | 2.2 people/vehicle | Demand conversion |
| `participation` | 1.0 | Share of the population that departs |
| `mobilizationHalfMin` | 90 min | Rayleigh half-departure time |
| `informed` | 0.33 | Share routed on observed rather than free-flow cost |
| `reoptSec` | 300 s | Observed-route update interval |
| `logitTheta` | 0.15 | Route-choice concentration |
| `splitEpsilon` | 0.01 | Smallest retained split share |
| `ttSmoothing` | 0.3 | Observed-cost EMA weight |
| `srcInjectLanes` | 1 | Virtual driveway entry lanes |
| `spillbackLoadThreshold` | 0.9 | Spillback reporting threshold |
| `busSeats` | 40 | Seats used by the accessibility summary |
| `horizonSec` | 172800 s | Hard simulation horizon |

Road-class defaults are defined once in `src/core/params.ts`.

| Class | Code | Default lanes | Capacity factor | Speed km/h |
|---|---:|---:|---:|---:|
| motorway | 0 | 2 | 1.00 | 100 |
| trunk | 1 | 2 | 0.95 | 80 |
| primary | 2 | 2 | 0.85 | 60 |
| secondary | 3 | 1 | 0.70 | 50 |
| tertiary | 4 | 1 | 0.60 | 40 |
| residential | 5 | 1 | 0.35 | 30 |
| unclassified | 6 | 1 | 0.35 | 30 |
| link | 7 | 1 | 0.70 | 30 |

Canonical derived formulas:

~~~text
capVehS[e]       = lanes[e] * satFlowPerLane * classFactor[e] / 3600
storageVeh[e]    = max(1, floor(lenM[e] * lanes[e] / jamSpacingM))
ttSec[e]         = max(1, round(lenM[e] / (speedKmh[e] * 1000 / 3600)))
ringLen[e]       = ttSec[e]
srcInjectCapVehS = srcInjectLanes * satFlowPerLane / 3600
~~~

## 3. The `city.bin` format

The current binary format version is **2**. Files are little-endian, all sections are aligned to
four bytes, and typed-array sections are planar so the loader can create zero-copy views.

### 3.1 Header

The header is 128 bytes.

| Offset | Type | Field |
|---:|---|---|
| 0 | `char[4]` | Magic `BNCK` |
| 4 | `Uint16` | Format version |
| 6 | `Uint16` | Reserved flags |
| 8 | `Uint32` | Vertex count `V` |
| 12 | `Uint32` | Directed edge count `E` |
| 16 | `Uint32` | Source count `S` |
| 20 | `Uint32` | Exit count `X` |
| 24 | `Uint32` | Intermediate geometry point count `G` |
| 28 | `Uint32` | Name-table byte length `NS` |
| 32 | `Int32[4]` | Bounding box, coordinates multiplied by 1e7 |
| 48 | `Uint32[20]` | Section byte offsets; zero means absent |

The building sections are optional. Their count is derived as `B = BLD_OFF[V]`. A file without
building sections remains valid.

### 3.2 Sections and flags

| # | Name | Type | Length |
|---:|---|---|---:|
| 1 | `NODE_LAT` | `Int32` | `V` |
| 2 | `NODE_LON` | `Int32` | `V` |
| 3 | `CSR_OFF` | `Uint32` | `V + 1` |
| 4 | `EDGE_TO` | `Uint32` | `E` |
| 5 | `EDGE_LEN` | `Uint16` | `E` |
| 6 | `EDGE_LANES` | `Uint8` | `E` |
| 7 | `EDGE_SPEED` | `Uint8` | `E` |
| 8 | `EDGE_FLAGS` | `Uint8` | `E` |
| 9 | `EDGE_TWIN` | `Uint32` | `E` |
| 10 | `GEOM_OFF` | `Uint32` | `E + 1` |
| 11 | `GEOM_PTS` | `Int16` | `G * 2` |
| 12 | `SRC_NODE` | `Uint32` | `S` |
| 13 | `SRC_POP` | `Float32` | `S` |
| 14 | `SRC_NOCAR` | `Float32` | `S` |
| 15 | `SRC_ZONE` | `Uint8` | `S` |
| 16 | `EXIT` | `Uint32` | `X` |
| 17 | `NAME_ID` | `Uint16` | `E` |
| 18 | `NAME_BLOB` | `Uint8` | `NS` |
| 19 | `BLD_OFF` | `Uint32` | `V + 1` |
| 20 | `BLD_PTS` | `Int16` | `B * 2` |

`EDGE_FLAGS` stores one-way, bridge, tunnel, motorway-class, exit-edge, and road-class bits.
`EDGE_TWIN` is `0xFFFFFFFF` when no opposite directed edge exists.

Geometry points are delta encoded in units of 1e-6 degrees. Long deltas are densified with
intermediate geometry points without changing graph topology. Building points are centroids
stored as deltas from their owning demand node. Buildings affect only parked-car placement,
not demand or road capacity.

### 3.3 Validity invariants

A city is invalid when any of these conditions fails:

1. `CSR_OFF[0] === 0` and `CSR_OFF[V] === E`.
2. `CSR_OFF` is monotonically non-decreasing.
3. Every edge target is below `V`.
4. `GEOM_OFF[0] === 0`, `GEOM_OFF[E] === G`, and offsets are monotonic.
5. A twin points back to the original edge.
6. Every edge has at least one lane and speed at least 5 km/h.
7. Every edge length is at most 60,000 m; longer edges are split, never clamped.
8. After exit nodes are made absorbing, all sources belong to the retained strongly connected
   component and every exit is reachable from it.
9. Every source can reach at least one exit.
10. Source population is positive; `0 <= SRC_NOCAR[i] <= SRC_POP[i]`.
11. Sources and exits are in range and are disjoint.
12. Runtime `ringLen[e] === ttSec[e]` for every edge.
13. Building offsets are monotonic and end at the building-point count.

The preprocessor enforces connectivity before population is distributed. A disconnected graph
must fail instead of silently producing a clearance curve that never completes.

## 4. Offline preprocessing

`tools/osm_extract.py` reads an OSM PBF into intermediate JSON. `tools/preprocess.ts`
turns that JSON into `city.bin` and metadata. Graph construction and binary writing remain in
TypeScript and share `tools/cityBuilder.ts` with the synthetic generator.

The pipeline:

1. Keep supported drivable highway classes and reject private or area ways.
2. Collapse intermediate OSM geometry points; retain intersections, shared nodes, and endpoints
   as graph vertices.
3. Build directed edges from one-way and roundabout rules.
4. Read directional lanes and speeds. When lanes are missing, use the median tagged value from
   segments with the same road name and class, then fall back to the class default.
5. Measure full polyline length with the haversine formula.
6. Split topological edges longer than 60,000 m. Densify geometry separately.
7. Find boundary exits automatically by major-road class or explicitly by road name.
8. Distribute documented population either from a raster or by residential-road length.
8bis. Attach allowed OSM building centroids to the nearest demand node within 300 m.
9. Write no-car population only when a documented source exists; otherwise record zero and a
   metadata note.
10. Assign staging zones from documented polygons; unmatched sources use zone zero.
11. Retain the largest valid component with absorbing exits and remap indices.
12. Write binary and metadata, run all §3.3 checks, and fail on any error.

The road-length population mode preserves the city total but smooths local density. Building
coverage is also uneven. Both effects are documented in [LIMITATIONS.md](LIMITATIONS.md).

### 4bis. Synthetic cities

`tools/synth.ts` writes valid files in the same format without OSM. Grid, line, single-edge,
and island fixtures exercise the complete loader, worker, model, and renderer path. Fixture
geometry is deterministic, population is distributed predictably, and every fixture passes the
same validator as a real city.

## 5. Loaded graph

`src/core/city.ts` exposes planar typed arrays plus derived incoming CSR arrays, `edgeFrom`,
`isExit`, and maximum degrees. Binary sections remain views on the source `ArrayBuffer`.
Derived arrays are built once in `O(V + E)`.

No object, `Array`, or `Map` is created per graph element. External code refers to stable
edge IDs; dense edge indices are internal to the current runtime graph.

## 6. Routing field

`src/core/routing.ts` runs reverse Dijkstra from all exits. A `Field` contains free-flow and
observed node costs plus one split share per directed edge.

### 6.1 Costs

Free-flow cost comes from `ttSec`. Observed cost adds queue delay and is smoothed before each
recalculation. Buffers are reused because route fields may be rebuilt repeatedly during a run.

### 6.2 Split shares

For each vertex, candidate edges must be open and descend strictly along one mixed-cost
potential. This strict descent makes the used-edge graph acyclic.

~~~text
edgeMix = (1 - informed) * edgeCostFree + informed * edgeCostObserved
gate    = reverseDijkstra(edgeMix)

candidate(o) iff !blocked[o] and gate[to[o]] < gate[v]
~~~

Free-flow and observed multinomial-logit weights are computed over the same candidate set and
then blended by `informed`. Shares below `splitEpsilon` are dropped and the rest are
renormalised. A vertex with no valid candidate receives all-zero shares.

The gate is built from blended edge costs rather than by blending two independently directed
fields. Blending fields can create opposing arcs and deadlock the FIFO node model.

### 6.3 Implementation rules

Dijkstra uses a reusable typed-array binary heap. For every vertex, split shares sum to one or
zero, no retained share is below `splitEpsilon`, and the used-edge graph is acyclic. Routing
must not allocate per edge during recalculation.

## 7. Simulation core

`src/core/sim.ts` owns road state, source demand, route fields, statistics, and all scratch
arrays. `tick()` advances exactly one second and allocates nothing.

### 7.1 State and mass balance

`n[e]` includes vehicles that reached the end of the edge and wait in `ready[e]`.

~~~text
0 <= ready[e] <= n[e] <= storage[e]

notDeparted = sum(waiting[v])
enRoute     = sum(n[e]) + sum(queued[v])
notDeparted + enRoute + evacuated = totalVeh
~~~

`queued[v]` is an unbounded virtual driveway queue. Entry speed is limited by
`srcInjectCapVehS`.

### 7.2 Public API

~~~ts
createSim(city, params, edits?)
tick(sim)
applyEdits(sim, edits)
metrics(sim)
snapshot(sim, buffers)
~~~

### 7.3 Tick phases

Each tick runs in this order:

1. Mobilise demand from `waiting` to `queued`.
2. Mature vehicles whose free-flow edge time has elapsed.
3. Compute edge demand from ready vehicles and capacity.
4. Compute edge supply from capacity and remaining storage.
5. Run the node model into scratch output arrays.
6. Apply all edge and source movements.
7. Absorb flow reaching exit nodes.
8. Update statistics and advance time.

Demand and supply read the state from the start of the tick; movement is applied only after all
nodes have been evaluated. The arrival ring length equals the edge travel time, and its slot is
cleared before new arrivals are scheduled.

### 7.4 Daganzo-style node model

Each node combines incoming road demand and one virtual driveway input. If the node is an exit,
it absorbs all available demand. Otherwise:

- active outgoing edges are those with positive split and available capacity;
- FIFO limits total node flow by the tightest required outgoing supply;
- constrained incoming flow is allocated by capacity-weighted proportional allocation with
  saturation;
- the result is written to scratch arrays and applied after every node has run.

A blocked outgoing direction can therefore hold back the shared approach, producing spillback.
The saturation loop must either finish or deactivate at least one participant per iteration.

### 7.5 Mobilisation

Demand follows a Rayleigh cumulative curve:

~~~text
departedShare(t) = 1 - exp(-t^2 / (2 * sigma^2))
sigma = halfTimeSec / sqrt(2 * ln(2))
~~~

The implementation evaluates the absolute remaining demand each tick to avoid accumulated
drift. Zone staging offsets the local time by `releaseAtMin`. A half time of zero releases all
demand immediately.

## 8. Worker protocol

`src/worker/protocol.ts` is a discriminated union imported by both sides. Large arrays use
transferable buffers. Frame buffers are recycled; if none is available, the worker skips a frame
but continues ticking.

Main-to-worker messages initialise and configure a city, control playback and speed, apply
edits, recycle buffers, and request edge details or names. Worker-to-main messages provide:

- ready-state metadata, road geometry, graph arrays, capacity analysis, and tracer inputs;
- frames with road occupancy, edge outflow deltas, driveway departure deltas, and summaries;
- evacuation curves, completed metrics, edge details, and errors;
- updated network arrays after a hot edit.

React receives only throttled summaries. High-frequency frames go directly to the renderer.

## 9. Scenario, permalink, and edits

`src/core/scenario.ts` normalises and serialises a complete run: city, seed, demand, supply,
routing, exits, edits, and reporting thresholds. Presets and permalink payloads use the same
shape, so one URL can reproduce the same scenario.

### 9.1 Edits

Supported edits are road closure, lane count, contraflow, and added road. An optional
`atMin` schedules a hot edit at simulated time. Edits with equal timestamps keep scenario
order.

### 9.2 Stable edge IDs

Base edges use their original dense index as a stable ID. Added roads use IDs at or above
`1_000_000_000`. The runtime maintains maps between stable IDs and current dense indices.
Permalinks and UI state never store a dense index for an added road.

### 9.3 Hot application

Closure, lane changes, and contraflow update capacity, storage, blocked state, max-flow, and
routing without discarding vehicles. Vehicles already on a newly closed edge remain there.
Contraflow requires a valid opposite edge, closes one direction, and adds its lanes to the other.
Topology changes require a full reset.

## 10. Determinism

The core uses seeded xorshift128+ and never calls `Math.random`. Identical city data,
scenario, and traversal order must reproduce model arrays and metrics bit for bit. Renderer
tracer routes derive from model counters and the scenario seed; their wall-clock birth frame is
not part of the simulation contract.

## 11. Metrics

The model reports total demand, evacuated, not departed, en route, queued, stranded,
`t50`, `t90`, `t95`, `t100`, mean travel time, peak outflow, maximum spillback,
gridlocked edges, max-flow capacity, and the ratio of peak outflow to max-flow.

Threshold times are recorded once when cumulative evacuated demand crosses each fraction.
Peak outflow uses a rolling five-minute window. Max spillback sums lengths of highly loaded
connected approaches. Metrics preserve the same mass balance as §7.1.

## 12. Max-flow and minimum cut

`src/core/maxflow.ts` builds a super-source connected to demand nodes and a super-sink
connected from exits. Dinic runs with whole vehicles per hour. Road edits affect the capacity
graph used for the current scenario.

The result is a static upper bound. It ignores travel time, mobilisation, storage, and spillback.
The source-side residual reachability set identifies one minimum cut. Other minimum cuts may
exist, so cut membership alone does not prove that an edge belongs to every optimal cut.

## 13. Rendering

MapLibre draws the basemap and deck.gl draws the road network, cars, selected routes, and
overlays. Renderer modules consume worker data and do not import the simulation core.

### 13.1 Binary road layer

Road polylines use one stable binary `PathLayer` data object. Geometry is flattened into
`positions` with `startIndices` and is rebuilt only when the network geometry changes.
Directed twins receive opposite metre offsets so both directions remain visible and pickable.

### 13.2 Vehicle tracers

The renderer places one tracer per whole vehicle represented by model counts. Cumulative edge
outflow and source-departure deltas advance tracers through the graph. Newell cumulative-count
trajectories interpolate position on an edge and put queued vehicles near its downstream end.

A parked tracer uses a nearby OSM building centroid when available, with a cap per building;
otherwise it falls back to a deterministic point near the source road. Tracers use metre offsets
relative to the city centre to keep per-frame GPU buffers compact.

The model is continuous, so fractional vehicles cannot be shown. Edge membership and counts
come from the model; exact within-edge position is a visual interpolation. See
[LIMITATIONS.md §7bis](LIMITATIONS.md#7bis-reading-the-map).

## 14. Required checks

The automated suite covers:

1. mass conservation on every tick;
2. an empty network remaining empty;
3. exact single-edge discharge capacity;
4. merge, diverge, and mixed node-model cases;
5. queue growth and spillback;
6. closure and contraflow effects;
7. deterministic repeat runs;
8. an island network clearing within a broad physical range;
9. peak outflow not exceeding max-flow capacity;
10. deterministic results under stable traversal;
11. a closed exit producing stranded demand;
12. order independence of the node model;
13. exact arrival-ring timing;
14. binary format and graph invariants;
15. real-city validation ranges documented in [VALIDATION.md](VALIDATION.md).

## 15. Repository boundaries

~~~text
src/core      Pure graph, routing, simulation, and metrics
src/shared    Small dependency-free primitives shared across boundaries
src/worker    Simulation lifecycle and browser messaging
src/main      Application state and worker coordination
src/render    MapLibre/deck.gl rendering; no core imports
src/ui        React controls and summaries
tools         Offline extraction, preprocessing, and fixture generation
test          Unit, invariant, integration, and real-city checks
~~~

`src/core` has no DOM, React, deck.gl, network, or tool dependencies. `src/render` receives
model data through the worker/main boundary rather than importing `src/core`. Import
restrictions are enforced in `biome.jsonc` and `test/boundaries.test.ts`.

## 16. Engineering conventions

These rules protect model correctness and browser performance.

### 16.1 Data representation

Use typed arrays for graph-scale numeric data. Avoid per-node and per-edge objects in hot or
large paths. Keep units in variable names.

### 16.2 Ownership

One module owns each formula, binary layout, protocol type, and random-number implementation.
Tests should compare consumers with the owner rather than duplicate the same logic.

### 16.3 Dependencies

Browser code must stay inside the layer boundaries in §15. Offline tools may use filesystem and
OSM-processing dependencies but never ship in the application bundle.

### 16.4 Errors

Invalid city data, unsupported topology edits, and protocol failures must produce explicit
errors. Do not silently clamp malformed data or invent missing demographic values.

### 16.5 Hot paths

`tick()`, the node model, Dijkstra, frame production, and tracer updates avoid per-element
allocation, iterator protocols, and logging. Scratch arrays are created at configuration time
and reused.

### 16.6 Public APIs

A module declares its public exports near the top or in its type module. Internal refactors must
not silently change scenario, worker, or binary-format contracts.

## 17. Built-in scenarios

The shipped catalogue includes:

- San Francisco with the full network;
- San Francisco with the Bay Bridge closed;
- Mercer Island baseline;
- Florida Keys baseline;
- Paradise with the documented closure schedule;
- Paradise with the network kept open;
- Paradise without contraflow;
- Paradise with one additional outbound lane.

Scenario files are ordinary normalised scenario objects. Adding a preset must not introduce a
special branch in the simulation core.
