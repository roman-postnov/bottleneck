<h1 align="center"><a href="https://roman-postnov.github.io/bottleneck/">🚀 OPEN THE LIVE DEMO</a></h1>

# Bottleneck

<p align="center">
  <strong>Find the roads that decide whether a city clears.</strong><br>
  An interactive evacuation simulator built on real road networks.
</p>

<p align="center">
  <a href="https://github.com/roman-postnov/bottleneck/actions/workflows/ci.yml"><img alt="CI and deploy" src="https://github.com/roman-postnov/bottleneck/actions/workflows/ci.yml/badge.svg"></a>
  ·
  <a href="LICENSE">MIT License</a>
</p>

> **Max-flow gives the ceiling. The simulation shows the traffic. The minimum cut names the roads that matter.**

Bottleneck turns a city's road network, population, and closure schedule into an explorable
decision. It answers three questions that a static evacuation map cannot:

- How quickly can this city move its vehicles out?
- Where does the queue form when capacity is exceeded?
- Which specific road, bridge, or corridor changes the outcome?

The result is not another animated map. It is a way to connect a city-wide number to the
small set of roads that controls it.

<p align="center">
  <img src="docs/preview.png" alt="Bottleneck running a San Francisco evacuation scenario" width="100%">
</p>

## See it in 60 seconds

1. Open the [live demo](https://roman-postnov.github.io/bottleneck/).
2. Choose **Paradise, 8 Nov 2018 — as it happened**.
3. Press **Play** and enable **show the bottleneck**.
4. Click a road, then try **Close**, **+1 lane**, or **Contraflow**.
5. Watch the clearance time, queue, outbound flow, and highlighted bottleneck change together.
6. Use **Copy link** to share the exact scenario.

The change is applied at the simulated minute when it happens, so an intervention can be tested
as part of the event rather than only before it starts.

## What the demo makes visible

| Question | What Bottleneck shows |
|---|---|
| Where does the city fail? | The minimum cut highlights every road that all successful routes must cross. |
| What does failure look like? | Queues, storage limits, spillback, and individual vehicles evolve on the map. |
| Can an intervention help? | Road closures, extra lanes, and contraflow can be introduced during the run. |
| Does driver behaviour matter? | Routing information, occupancy, mobilisation, and road saturation are adjustable. |
| Who is missing from a car-only model? | People without access to a car are reported separately instead of disappearing silently. |

## Real places, real questions

| Case | Why it matters |
|---|---|
| **Paradise, California** | The Camp Fire case: timed closures, four arterial exits, and a direct comparison with NIST's evacuation study. |
| **Mercer Island, Washington** | An island network where I-90 is the decisive way out. |
| **Florida Keys** | A long, linear chain of islands where a dominant highway controls the result. |
| **San Francisco, California** | A large network with alternative corridors, bridges, and non-obvious spare capacity. |

A few results from the built-in scenarios:

- In **Paradise**, the minimum cut identifies the four escape arteries and gives the network a
  5,940 vehicles-per-hour ceiling under the documented scenario.
- In **San Francisco**, the baseline run reaches T90 in 10 h 14 min; closing the Bay Bridge
  adds 2 h 05 min.
- In the **Florida Keys**, the model makes the fragility of a long, nearly linear network
  visible without hiding the assumptions behind it.

These are scenario results, not emergency forecasts. The project keeps its assumptions and
known misses explicit instead of presenting one run as a prediction.

## How it works

~~~mermaid
flowchart LR
  A[Real road data] --> B[City network]
  B --> C[Traffic simulation]
  C --> D[Live queues and vehicles]
  C --> E[Clearance curve]
  B --> F[Max-flow and min-cut]
  F --> G[Critical roads]
~~~

The core is a mesoscopic traffic model: roads have capacity and storage, nodes handle merges
and diverges, and spillback emerges from those constraints. This keeps the model fast enough
for a browser while preserving the behaviour that makes evacuation planning difficult.

The engineering choices support the explanation:

- **Explainable capacity:** max-flow computes the theoretical outbound ceiling, while the
  minimum cut maps that ceiling back to real roads.
- **Traffic, not just throughput:** route choice, mobilization, queues, and time-stamped edits
  turn a single capacity number into a visible process.
- **Deterministic scenarios:** the same inputs produce the same run, making comparisons and
  shared links reproducible.
- **Browser-native performance:** TypeScript, React, Vite, Web Workers, typed arrays, deck.gl,
  and MapLibre run the simulation as a static site with no application server.
- **Honest boundaries:** the interface exposes assumptions instead of presenting a precise-looking
  number as a prediction.

## Run locally

The repository includes four real city networks and ready-to-run scenarios. No data download is
needed for the demo.

Requires Node.js 24, the version used by CI:

~~~sh
npm ci
npm run dev
~~~

To build and preview the production bundle:

~~~sh
npm run build
npm run preview
~~~

For development checks:

~~~sh
npm run check
~~~

<details>
<summary>Rebuild a city from raw OpenStreetMap data</summary>

The offline pipeline downloads Geofabrik extracts, converts them to intermediate data, and
builds the binary city network used by the browser:

~~~sh
python3 -m venv tools/.venv
tools/.venv/bin/pip install -r tools/requirements.txt
data/raw/fetch.sh
npm run extract -- <cityId>
npm run preprocess -- <cityId>
~~~

The prebuilt networks remain available, so this step is only needed when changing the source
data or preprocessing rules.

</details>

## Scope and limitations

Bottleneck is a screening and discussion tool, not an operational emergency model. It simulates
vehicle evacuation inside a selected boundary and treats crossing that boundary as success.

It does not model fire spread, pedestrians, public transport, household-level decisions,
neighbouring traffic outside the boundary, or the route to a safe destination. Its results are
deliberately idealised and optimistic; compare scenarios and interventions rather than treating
one run as a forecast.

The model's assumptions and the direction in which they can move the result are part of the
interpretation of every run.

## Data and attribution

- Road geometry and building footprints come from [OpenStreetMap](https://www.openstreetmap.org/copyright)
  extracts downloaded through [Geofabrik](https://download.geofabrik.de/).
- Population inputs come from the documented NIST and U.S. Census sources for each case.
- The basemap is provided by MapLibre and CARTO; attribution is shown in the application.
- Preprocessed city networks are shipped as static assets with the Pages deployment; the
  simulation itself runs in the browser.

Code is available under the [MIT License](LICENSE).
