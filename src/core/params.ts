// Defaults and derived formulas from docs/CONTRACTS.md §2.
// This is the single canonical statement of the formulas; do not restate them elsewhere.

export const DEFAULTS = {
  satFlowPerLane: 1800,
  jamSpacingM: 7.5,
  occupancy: 2.2,
  participation: 1.0,
  mobilizationHalfMin: 90,
  informed: 0.33,
  reoptSec: 300,
  logitTheta: 0.15,
  splitEpsilon: 0.01,
  ttSmoothing: 0.3,
  srcInjectLanes: 1,
  spillbackLoadThreshold: 0.9,
  busSeats: 40,
  horizonSec: 172800,
} as const;

// Index is the class code, which is also bits 5-7 of the flags byte (§3.2).
// §11 defines the metrics, not the model, so these are not scenario parameters and do not
// belong in DEFAULTS. They are here because src/core/sim.ts and src/core/metrics.ts both need
// them and the window has to be the same number in both: one sizes the ring, the other divides
// by it.
export const OUTFLOW_WINDOW_SEC = 300;
export const GRIDLOCK_LOAD = 0.95;

export const HIGHWAY_CLASSES = [
  { name: 'motorway', lanes: 2, factor: 1.0, speedKmh: 100 },
  { name: 'trunk', lanes: 2, factor: 0.95, speedKmh: 80 },
  { name: 'primary', lanes: 2, factor: 0.85, speedKmh: 60 },
  { name: 'secondary', lanes: 1, factor: 0.7, speedKmh: 50 },
  { name: 'tertiary', lanes: 1, factor: 0.6, speedKmh: 40 },
  { name: 'residential', lanes: 1, factor: 0.35, speedKmh: 30 },
  { name: 'unclassified', lanes: 1, factor: 0.35, speedKmh: 30 },
  { name: 'link', lanes: 1, factor: 0.7, speedKmh: 30 },
] as const;

export type HighwayClassName = (typeof HIGHWAY_CLASSES)[number]['name'];

export const CLASS_CODE = Object.fromEntries(HIGHWAY_CLASSES.map((c, i) => [c.name, i])) as Record<
  HighwayClassName,
  number
>;

export function capVehS(lanes: number, code: number, satFlowPerLane: number = DEFAULTS.satFlowPerLane): number {
  return (lanes * satFlowPerLane * HIGHWAY_CLASSES[code].factor) / 3600;
}

export function storageVeh(lenM: number, lanes: number, jamSpacingM: number = DEFAULTS.jamSpacingM): number {
  return Math.max(1, Math.floor((lenM * lanes) / jamSpacingM));
}

export function ttSec(lenM: number, speedKmh: number): number {
  return Math.max(1, Math.round(lenM / ((speedKmh * 1000) / 3600)));
}

export function srcInjectCapVehS(srcInjectLanes: number, satFlowPerLane: number): number {
  return (srcInjectLanes * satFlowPerLane) / 3600;
}
