# Model limitations

Bottleneck is a first-pass screening and comparison tool, not a replacement for a detailed
transport study. Its assumptions should be read together with every result.

Most omissions make clearance look faster than a real emergency. That broad direction has
important exceptions: on a redundant network, free-flow routing can leave useful capacity idle
and make a run pessimistic. The tables use these symbols:

- **↑**: optimistic; simulated clearance is too fast;
- **↓**: pessimistic; simulated clearance is too slow;
- **↔**: direction depends on the network or scenario.

## 1. Traffic flow

Bottleneck uses a mesoscopic model: continuous queues on edges and a Daganzo-style node model
at intersections. It preserves capacity, storage, FIFO, and spillback without simulating the
motion of every physical vehicle.

| ID | Simplification | Bias | Consequence |
|---|---|---|---|
| 1.1 | Vehicles are continuous flow | ↔ | Fractional vehicles are valid at city scale but not for a three-car junction |
| 1.2 | No car following, lane changing, acceleration, or braking | ↑ | A lane can discharge at saturated flow whenever downstream space exists |
| 1.3 | Edge travel time stays at free-flow time | ↑ | Delay appears at the downstream queue, not throughout dense moving traffic |
| 1.4 | Backward congestion waves cross an edge immediately | ↔ | A whole edge becomes one cell; error grows on long uninterrupted roads |
| 1.5 | No traffic-signal phases | ↑ | Class capacity factors approximate but do not reproduce signal timing |
| 1.6 | No independent intersection capacity | ↑ | The model constrains edges, not the physical conflict area of a junction |
| 1.7 | Split shares depend on the node, not the incoming movement | ↔ | A left-turn queue cannot block through traffic as a separate movement |
| 1.8 | Source queues have unlimited storage | ↑ | Driveways can hold any number of released vehicles; only their entry rate is limited |
| 1.9 | A scenario produces one deterministic outcome | — | Uncertainty requires explicit alternative scenarios rather than a confidence interval |

The 60 km edge-splitting threshold protects the `Uint16` binary length field. It is not a
traffic-accuracy threshold. A long bridge or rural segment can therefore behave as one cell,
which makes within-edge spillback timing unrealistic.

## 2. Routing and behaviour

| ID | Simplification | Bias | Consequence |
|---|---|---|---|
| 2.1 | Drivers optimise time to a model exit | ↑ | Familiar routes, schools, relatives, and destinations outside the area are absent |
| 2.2 | `informed` is one city-wide share | ↔ | Access to live traffic information varies by person and place |
| 2.2bis | Information is a share of flow, not named drivers | ↔ | Intermediate values mix two cost fields; they do not identify a fixed group of cars |
| 2.3 | One logit parameter represents route preference | ↑ | Driver heterogeneity is compressed into one number |
| 2.4 | One Rayleigh mobilisation curve serves the city | ↑ | Notification, age, animals, preparation, and repeat trips are omitted |
| 2.4bis | Staged orders need external zone polygons | ↓ for early local queues | Without documented polygons, all sources use the same release curve |
| 2.5 | Drivers do not turn around or reconsider a destination | ↑ | Bidirectional emergency movement seen during the Camp Fire is absent |
| 2.6 | Used edges must strictly reduce cost to an exit | ↔ | The rule prevents route cycles but can reject a nearly equal detour |
| 2.7 | The moving demand is vehicle-only | ↑↓ | Pedestrians, public transport, ride sharing, and assisted evacuation are not simulated |

`informed` is especially influential on a redundant graph. San Francisco gives
`t90 = 22 h 41 min` at `informed = 0`, `10 h 14 min` at `0.33`, and
`7 h 40 min` at `1`. Those values are scenario bounds, not a calibrated behavioural
estimate.

Strict descent in [CONTRACTS.md §6.2](CONTRACTS.md#62-split-shares) creates a separate issue.
At a Florida Keys junction, two exits differ by one second, yet the slightly worse first step
gets no free-flow share. A tolerance around nearly equal costs could fix this, but it would
change routing and require all city results to be validated again.

## 3. Data

| ID | Limitation | Bias | Consequence |
|---|---|---|---|
| 3.1 | OSM lane and speed tags are incomplete | ↔ | Missing lanes use a same-road median and then a class default |
| 3.2 | Population can be distributed by residential-road length | ↔ | The city total is preserved without a density raster |
| 3.3 | Road-length allocation smooths local density | ↓ for local peaks | Apartment blocks and detached-house streets receive demand by road length |
| 3.4 | Only the retained connected graph receives demand | ↔ | Disconnected road fragments are removed before population allocation |
| 3.5 | Occupancy 2.2 is an assumption | ↔ | Vehicle demand changes directly with this UI parameter |
| 3.6 | Saturated flow is 1,800 veh/h/lane before class factors | ↑ | Emergency driving and intersection friction often lower real throughput |
| 3.7 | No-car data is used only when a documented source exists | — | Missing data is recorded as zero with a metadata note, not estimated |
| 3.7bis | One no-car share is applied across a whole city | ↔ city-wide, ↑↓ locally | The total can be credible while neighbourhood distribution is not |
| 3.7ter | Household share is not people share | ↑ if confused | Applying a household percentage to population overstates excluded people |
| 3.8 | Connectivity pruning removes part of the clipped network | ↔ | Metadata records removed vertices and residential-road length |
| 3.9 | The model area is a configured bounding box | ↑ | Boundary placement changes what counts as a successful exit |

Building centroids improve parked-car placement but not demand allocation. OSM often does not
say whether `building=yes` is residential, building relations are not extracted, centroids are
not driveways, and coverage varies greatly. Cars without a usable building fall back to a
deterministic point near the source road.

## 4. People outside the model

The simulation demand consists of vehicle trips. A person without a vehicle never enters the
traffic model, does not join a queue, and does not affect clearance time.

This boundary matters in the Camp Fire record. TN 2252 reports that 87% of victims were found
at home, only 22% were attempting to evacuate when they died, the average and median age were
72, and many had mobility or medical limitations. Some lacked access to a vehicle or could not
drive.

`SRC_NOCAR`, `carlessPeople`, and `busRunsNeeded` can quantify people excluded from the
car model when census data exists. They do not model an actual bus service, pickups, schedules,
or walking routes.

## 5. Model boundary and hazards

### 5.1 Crossing the boundary counts as success

Everything beyond the configured area is absent. In the Camp Fire, congestion on
Durham-Pentz Road and CA-99 near Chico affected Paradise traffic more than 15 km from town.
A Paradise-only graph cannot reproduce it.

The result is time to leave the model area, not time to reach a genuinely safe destination.

### 5.1bis Exit placement follows retained connectivity

A divided highway may leave the retained component before the visual bounding-box crossing.
The exit is placed where a vehicle can no longer return to the retained city graph. This keeps
capacity but can omit the last minutes on a bridge or approach.

### 5.1ter All exits are equally safe

The routing objective ends at the boundary, so it has no preference for what an exit connects
to outside the model. Paradise traffic spreads over four exits more evenly than the documented
evacuation, which relied heavily on Skyway. This can overstate the benefit of secondary exits.

### 5.1quater Redundant networks expose routing assumptions

On San Francisco, free-flow routing saturates some surface exits while leaving freeway capacity
unused. Full observed-cost routing uses much more of the theoretical ceiling. The difference
can dominate every other modelling assumption.

### 5.2 Neighbouring demand is absent

A clipped city does not include traffic from nearby communities using the same roads. Magalia
used Skyway during the Camp Fire, but a Paradise-only demand model does not include those
households.

### 5.3 A hazard is a schedule, not physics

Fire, flood, smoke, and debris are not simulated. A scenario supplies road closures at specific
model times. Bottleneck answers "what happens if this road closes," not "which road will the
hazard close."

### 5.3bis A closure affects the selected edge

The historical Paradise scenario closes the final exit edge of an artery. Removing an entire
artery would also cut unaffected approaches. The selected representation lets the graph reroute
more cleanly than a real burnover, so the result is optimistic.

### 5.3ter Vehicles on a closed edge remain

Deleting them would violate mass conservation. They neither vanish nor complete the trip, so
`t100` can remain null and the run can continue to its hard horizon even when `t90` has
already been reached.

### 5.4 No incidents or abandoned vehicles

Crashes, breakdowns, and more than 230 abandoned vehicles documented during the Camp Fire are
not modelled. A scheduled closure represents these effects only coarsely.

### 5.5 No temporary refuge

At least 1,222 people used temporary refuge areas during the Camp Fire. The model instead sends
all vehicle demand toward an exit. That can increase modelled road demand while still
overstating the speed of reaching safety.

## 6. Max-flow interpretation

`maxFlowVehH` is a static upper bound under ideal flow allocation. It has no travel time,
mobilisation, storage, queue, or spillback state. The ratio
`peakOutflowVehH / maxFlowVehH` measures utilisation of that bound, not physical efficiency.

The residual source-side reachability set returns one minimum cut. Multiple equal cuts may
exist. An edge in the reported cut is not necessarily present in every minimum cut.

The bound can be loose on a long network. Florida Keys reaches about 1,775 veh/h against a
4,680 veh/h max-flow value because more than 130 km of the longest route is single lane before
the wide boundary exits. Static alternative streets preserve graph capacity but do not carry
the same dynamic flow under spillback.

## 7. Questions the model does not answer

Bottleneck does not determine:

- who will be injured or killed;
- the exact route of a real named person;
- the exact minute a particular intersection will fail;
- whether staff, communication, or enforcement can implement an evacuation plan;
- the cost, feasibility, or fairness of a proposed road change;
- which intervention should be chosen without a user-defined objective.

A tracer route is one possible path through the continuous flow field, not a prediction for an
individual driver.

## 7bis. Reading the map

### One dot represents one whole vehicle

The renderer aims to match model edge counts to whole tracers, but several qualifications
remain:

- the continuous model can hold a fractional vehicle while the renderer must show zero or one;
- edge membership comes from model counts, while within-edge position is interpolated with a
  Newell cumulative-count trajectory;
- source departures are dithered to whole tracers, so a small tail can lag the continuous
  demand counters before converging;
- a parked car is shown near an OSM building, not at a verified home or driveway;
- building coverage varies, and overflow cars fall back to positions near the road;
- the model is bitwise deterministic, but the exact wall-clock frame in which a tracer appears
  is not part of that guarantee.

### Colour represents a chosen visual scale

Road colour maps load to a palette designed to remain visible over the basemap. It is useful
within one run, but apparent intensity is not a physical measurement and should not be compared
across themes. Numerical metrics are the comparison record.

### Nearly equal alternatives can split sharply

The strict potential descent described in §2.6 can turn a one-second cost difference into a
100/0 free-flow split. This is a known routing limitation rather than evidence that the second
road has no capacity.

## 8. Improvement paths

| Limitation | Possible improvement | Cost or tradeoff |
|---|---|---|
| 1.4 Long-edge spillback | Split long roads into shorter cells or model backward-wave speed | Larger graph and different validated results |
| 1.5 Signals | Apply green-time factors at signalised approaches | Requires reliable OSM signal data |
| 1.6 Junction capacity | Split each node into in/out vertices with an internal capacity edge | Roughly doubles graph topology |
| 2.4bis Staged orders | Import documented evacuation-zone polygons | Requires authoritative geographic data |
| 2.6 Nearly equal alternatives | Add a cost tolerance or logit across close options | Changes routing in every city |
| 3.3 Smoothed population | Weight demand with buildings, addresses, or a population raster | Requires complete data and revalidation |
| 5.1 External congestion | Extend the area to downstream highway merges | Larger data and simulation cost |
| 5.2 Neighbouring demand | Add demand at boundary or neighbouring sources | Requires compatible population and timing data |
| 7bis Fractional vehicles | Use an agent-based model | Much higher memory and runtime cost |

## 9. Summary

Bottleneck estimates vehicle clearance within a defined area under a specified road scenario.
It is strongest for comparing runs made with the same boundary and assumptions. Real
evacuation can be slower because of hazards, behaviour, external congestion, missing modes,
and operational constraints; redundant networks can also make a free-flow-routed run
artificially slow.
