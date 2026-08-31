# Model validation

This document records what Bottleneck is checked against, which targets were fixed before a
model run, what passed, and what did not. A target that misses remains visible; changing it
after seeing a result would be calibration, not validation.

The principal real-event source is:

Maranghides, Link, Mell, Hawks, Brown, and Walton, *A Case Study of the Camp Fire —
Notification, Evacuation, Traffic, and Temporary Refuge Areas (NETTRA)*, NIST Technical Note
2252, July 2023. <https://doi.org/10.6028/NIST.TN.2252>

References such as "TN 2252 §7.7" point to that report.

## 1. Validation scope

Bottleneck is checked for:

- order of magnitude of clearance time;
- total vehicle demand;
- capacity and topology of the exit network;
- qualitative queue and spillback locations;
- deterministic behaviour and physical invariants.

It is not validated for individual vehicle trajectories, the exact minute when one junction
fails, human behaviour, casualties, or hazard spread. It models transport demand under a given
road-closure scenario, not the hazard that creates the scenario.

The intended use is screening and comparison, not an operational forecast.

## 2. Camp Fire, 8 November 2018

Paradise is the only built-in case with a detailed official reconstruction of a real evacuation.
It provides both network facts and an observed time scale.

### 2.1 Event timeline

Model time zero is 08:00, the beginning of the main evacuation window used by NIST.

| Time | Event | TN 2252 |
|---|---|---|
| 06:20 | Ignition near Camp Creek Road | §4 |
| 07:46 | Evacuation requested for zones along the Pentz Road corridor | §6.3 |
| 07:49 | First spot fire recorded inside Paradise | §7 |
| 08:01 | Additional zones ordered to evacuate | §6.3 |
| 08:03 | Town-wide evacuation order | §6.3 |
| 08:15 | Heavy traffic already obstructs evacuation | §7.6 |
| 08:45 | Burnover closes Pentz Road | §7 |
| 09:45 | Skyway closes northbound near Old Magalia | §7.6 |
| 10:00 | Burnover on Clark Road | §7 |
| 12:30 | Burnover on Neal Road | §7 |
| 13:00 | Clark Road reopens and traffic improves | §7.6 |
| 14:00 | Most civilians have left Paradise | §10.4 |
| 08:00–14:15 | Main evacuation window | TF-ET 2 |

The application scenario uses the documented chronology above. It does not claim to reproduce
the per-artery fifteen-minute schedule in Table 29, which would require a separate manual
transcription from the report.

### 2.2 Demand

| Quantity | Documented value | TN 2252 |
|---|---:|---|
| Paradise population | about 26,500 | §10.4.2 |
| Occupied housing units in Paradise | 11,118 | Table 6 |
| Paradise and Magalia population | about 39,000 | §6 |
| Occupied housing units in Paradise and Magalia | 16,172 | Table 6 |
| Evacuated from Concow, Paradise, and Magalia | more than 40,000 people | §4 |

At occupancy 2.2, 26,500 people correspond to about 12,045 vehicle trips. The independent
housing-unit count makes this a useful demand check.

### 2.3 Exit network

Table 6 gives unusually direct capacity evidence.

| Area | Occupied homes | Exit arteries | Lanes used | Homes per lane |
|---|---:|---:|---:|---:|
| Concow | 327 | 1 | 1 | 327 |
| Magalia | 5,054 | 2 | 2 | 2,527 |
| Paradise | 11,118 | 4 | 7 | 1,588 |
| Paradise and Magalia | 16,172 | 5 | 8 | 2,022 |

Paradise used Skyway, Clark Road, Neal Road, and Pentz Road. The seven-lane count includes
contraflow: Skyway southbound had four lanes, while the other three arteries had one each.
Without contraflow, the same network has five outbound lanes.

At least two of the four arteries were closed simultaneously for 68% of the 08:00–14:15
window. Only one artery was open in 24% of the fifteen-minute intervals. These closures are
the main reason an always-open network is not a valid historical comparison.

### 2.4 Local queue evidence

At 08:40, police dashcam video on Merrill Road shows 36 vehicles in one lane waiting to enter
Pentz Road, with the queue growing by about eight vehicles per minute (TN 2252 §7.4). This is
used as a qualitative local check, not as a city-wide calibration target.

### 2.5 Population outside the vehicle model

TN 2252 reports 85 civilian deaths, 87% of victims found at home, and only 19 of 85 attempting
to evacuate when they died. The average and median age were 72, and at least 42% had a recorded
mobility or medical limitation. Some lacked access to a vehicle or could not drive (§11).

These facts do not validate vehicle traffic. They establish a boundary: a car-only model does
not represent many people at greatest risk. Census-based no-car fields quantify excluded demand
when data is available; they do not simulate bus or pedestrian evacuation.

## 3. Paradise targets

The `paradise-2018` scenario is checked against targets fixed before evaluation.

### 3.1 Static checks

| ID | Quantity | Target |
|---|---|---|
| V1 | `totalVeh` at occupancy 2.2 | 9,500–12,800 |
| V2 | Baseline max flow with the documented lane interpretation | 5,940 veh/h without contraflow; 6,000–14,000 veh/h with it |
| V3 | Exit nodes | four: Skyway, Clark, Neal, and Pentz |
| V4 | Minimum cut | exit arteries rather than residential blocks |

### 3.2 Dynamic checks

| ID | Run | Target |
|---|---|---|
| V5 | Open network `t90` | 2–4.5 h |
| V6 | Closure schedule `t90` | 4.5–7.5 h |
| V7 | Closures versus open network | closures strictly increase `t90` |
| V8 | Remove Skyway contraflow | `t90` increases |
| V9 | First severe queues | Pentz Road and its residential approaches |
| V10 | Merrill Road near 08:40 | queue on the order of tens of vehicles |
| V11 | Spillback | congestion reaches otherwise free residential streets |
| V12 | Full observed-cost routing | faster than free-flow-only routing |

A Paradise result below 1.5 h or above 12 h is treated as a falsification signal. It must be
explained before model parameters are adjusted.

## 4. Known Paradise gaps

The validation case has limits that the model cannot remove by tuning:

- The boundary ends at Paradise. Congestion on Durham-Pentz Road and CA-99 near Chico is
  outside the graph.
- Magalia traffic also used Skyway but is outside the model demand.
- Fire is represented by scheduled closures, not by a spreading hazard.
- The closure schedule is a simplified chronology, not the complete Table 29 transcription.
- More than 230 abandoned vehicles affected real roads; the model has no breakdown mechanism.
- At least 1,222 people used temporary refuge areas and were not continuously travelling to an
  exit.
- Zone-by-zone mobilisation cannot be reproduced without a documented geographic zone map.

These effects generally make simulated clearance optimistic. Details and exceptions are in
[LIMITATIONS.md](LIMITATIONS.md).

## 5. Evaluation method

The application preset files are the source of scenario inputs. `test/validation.test.ts`
checks Paradise targets, `test/sf.test.ts` checks the San Francisco graph and capacity, and
`npm run validate:sf` runs the slower San Francisco clearance comparison.

Expected misses use explicit failing tests with the reason recorded. A test becomes red if an
expected miss starts passing, forcing the result and its explanation to be reviewed.

Results below use:

- preprocessed files shipped in `public/cities`;
- scenarios shipped in `public/scenarios`;
- the same core and parameters used by the browser;
- deterministic seeds and traversal order.

## 6. Paradise results

The graph covers the Paradise town boundary and contains 1,969 vertices, 4,332 directed edges,
1,944 demand sources, four exits, and population 26,500.

### 6.1 Result table

| ID | Target | Result | Status |
|---|---|---|---|
| V1 | 9,500–12,800 trips | **12,045** | Pass |
| V2 | 5,940 veh/h without contraflow | **5,940** | Pass |
| V2 with contraflow | 6,000–14,000 veh/h | **8,460** | Pass |
| V3 | four named exits | **4** | Pass |
| V4 | cut on exit arteries | Skyway, Clark, Neal, and Pentz | Pass |
| V5 | open-network `t90` 2–4.5 h | **3 h 08 min** | Pass |
| V6 | closure `t90` 4.5–7.5 h | **3 h 27 min** | Miss, low |
| V7 | closures increase `t90` | 3 h 27 min > 3 h 08 min | Pass |
| V8 | no contraflow is slower | **4 h 00 min**, +33 min | Pass |
| V9 | Pentz first | Clark and Pentz congest first | Partial |
| V10 | tens of vehicles on Merrill | **1 vehicle** | Miss |
| V11 | residential spillback | 35 residential edges above 0.9 load | Pass |
| V12 | observed-cost routing faster | **2 h 52 min** versus 3 h 27 min | Pass |

### 6.2 Interpretation of misses

**V6:** the closure scenario clears too early. It uses five high-level events instead of the
full fifteen-minute artery schedule. A closure removes the artery's final exit edge and lets the
remaining graph reroute immediately; a real burnover disrupted the road and vehicles already
using it. The result is provisional and intentionally remains outside the target.

**V9 and V10:** both misses follow from missing staged demand. Pentz zones received orders
before the town-wide order, while the model releases the whole town with one Rayleigh curve.
The mechanism for staged demand exists, but assigning sources to undocumented zones would
invent input data.

### 6.3 Confirmed behaviour

- OSM-derived lane counts independently reproduce the four arteries and their five baseline
  outbound lanes.
- Contraflow adds 33 minutes of benefit after other exits close.
- Observed-cost routing reduces `t90` by 35 minutes in this network.
- Spillback reaches residential approaches rather than remaining at the boundary.

## 7. San Francisco

No documented evacuation outcome exists for San Francisco, so this section validates scale,
corridor capacity, graph structure, and directional response rather than historical clearance.

### 7.1 Inputs and targets

Population is 830,235 from U.S. Census Bureau ACS 2024 five-year table B01003 for San
Francisco County. Vehicle access uses table B08201 when reporting people outside the car model.

| ID | Check | Target |
|---|---|---|
| S1 | Exit count | 4–20 |
| S2 | Cut corridors | both bridges and both southern freeways represented |
| S3 | Open-network max flow | 20,000–60,000 veh/h |
| S4 | Vehicle trips | 340,000–420,000 |
| S5 | Open-network `t90` | 6–24 h |
| S6 | Close the Bay Bridge | `t90` and capacity increase/decrease in the expected directions |

### 7.2 Results

The graph contains 14,149 vertices, 33,798 directed edges, 9,233 demand sources, and 12 exits.

| ID | Result | Status |
|---|---|---|
| S1 | **12 exits** | Pass |
| S2 | all 15 cut edges are boundary exits; bridge approaches, US-101, and I-280 are present | Pass |
| S3 | **54,810 veh/h** | Pass |
| S4 | **377,380 trips** | Pass |
| S5 | **10 h 14 min** at `informed = 0.33` | Pass |
| S6 | Bay Bridge closure: **12 h 19 min**, +2 h 05 min | Pass |

Routing assumptions dominate this redundant network: `t90` is 22 h 41 min at
`informed = 0` and 7 h 40 min at `informed = 1`. The baseline value should therefore be
read as a scenario result, not a precise forecast.

The bridge decks may lie outside the retained component. Exit-edge names can therefore be the
last city-side approaches, such as Presidio Parkway, rather than the bridge name itself.

## 8. Florida Keys

The Florida Keys case tests a long, nearly linear graph rather than a documented evacuation
outcome. Hurricane Irma provides context, but no sufficiently detailed observed clearance
timeline is used here.

### 8.1 External planning reference

Florida planning rules require a resident evacuation clearance time on the order of 24 hours,
measured to the US-1/Florida Turnpike connection in Homestead. Bottleneck ends at northern Key
Largo, about 60 km earlier, so its result is a lower-bound comparison rather than a direct test
of the rule.

### 8.2 Targets

| ID | Check | Target |
|---|---|---|
| K1 | Exit count | 2–6 |
| K2 | Vertices after connectivity pruning | 3,000–7,000 |
| K3 | Max flow | 1,500–6,000 veh/h |
| K4 | Open-network `t90` hypothesis | more than 24 h |
| K5 | Completion before hard horizon | `t90 < 48 h` |
| K6 | Stranded demand | approximately zero |

### 8.3 Demand

The permanent population is 82,874 from the 2020 U.S. Census for Monroe County. At occupancy
2.2 this produces 37,670 trips. Visitors are not included, although peak visitor population can
be comparable with permanent population. This omission makes clearance time optimistic by an
unknown amount.

### 8.4 Results

The graph contains 5,904 vertices, 13,515 directed edges, 5,162 demand sources, and two exits.

| ID | Result | Status |
|---|---|---|
| K1 | **2 exits** | Pass |
| K2 | **5,904 vertices**, 163 removed | Pass |
| K3 | **4,680 veh/h** | Pass |
| K4 | **20 h 14 min** | Miss |
| K5 | completes before 48 h | Pass |
| K6 | **0 stranded** | Pass |

K4 remains a miss. The result is below 24 hours because visitors are absent, the graph ends
before Homestead, and the target was a planning hypothesis rather than an observed outcome.

### 8.5 Additional findings

Departure timing changes queue length much more than clearance time:

| Mobilisation half time | `t90` | Peak outflow | Maximum queue |
|---:|---:|---:|---:|
| 30 min | 20 h 02 min | 1,903 veh/h | 72 km |
| 90 min | 20 h 14 min | 1,775 veh/h | 61 km |
| 180 min | 20 h 38 min | 1,743 veh/h | 44 km |
| 360 min | 21 h 31 min | 1,727 veh/h | 32 km |

The second exit receives little free-flow traffic because one route is one second more expensive
at a Key Largo split. Strict descent in [CONTRACTS.md §6.2](CONTRACTS.md#62-split-shares)
turns that small difference into a zero share. Full observed-cost routing sends vehicles toward
the alternative and back again, increasing `t90` to 21 h 21 min.

Peak outflow is only 38% of the static max-flow ceiling. About 131.6 km of the farthest
187.8 km route is single lane, whose dynamic throughput is about 1,710 veh/h. The boundary
cut is wider than the long road feeding it. Closing the second exit changes `t90` by only
four minutes, which confirms that the chain itself is the controlling constraint.

## Sources

1. Maranghides A., Link E. D., Mell W., Hawks S., Brown C., and Walton W. D.
   *A Case Study of the Camp Fire — Notification, Evacuation, Traffic, and Temporary Refuge
   Areas (NETTRA).* NIST Technical Note 2252, July 2023.
   <https://doi.org/10.6028/NIST.TN.2252>
2. NIST ESCAPE, *Camp Fire Egress Artery Closure with Time.*
   <https://escape.nist.gov/evacuation3AddressingFailuresEgresslearnmore1>
3. Metropolitan Transportation Commission, toll-bridge traffic statistics.
   <https://mtc.ca.gov/news/toll-bridge-traffic-starts-climb-after-shelter-place-spurs-steep-drop>
4. Golden Gate Bridge, Highway and Transportation District,
   *Traffic Engineering and Analysis Report.*
   <https://www.goldengate.org/assets/1/6/traffic_engineering_and_analysis_ggb_mmb.pdf>
5. U.S. Census Bureau, ACS 2024 five-year tables B01003 and B08201,
   San Francisco County.
6. Florida Administrative Code R. 28-20.140, Monroe County Comprehensive Plan.
   <https://www.law.cornell.edu/regulations/florida/Fla-Admin-Code-Ann-R-28-20-140>
7. U.S. Census Bureau, 2020 Decennial Census, Monroe County, Florida.
