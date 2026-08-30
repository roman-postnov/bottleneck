// Transport controls and the parameters a run is actually argued over.

import { pause, play, reset, selectCity, selectPreset, setSpeed, updateScenario } from '../main/app.ts';
import { setState, useStore } from '../main/state.ts';
import type { CityMeta } from '../core/types.ts';

const SPEEDS = [1, 10, 60, 120, 300, 600];

/** Elapsed, not a wall clock: `22:41` was being read as twenty to eleven at night. */
function elapsed(sec: number): string {
  const total = Math.round(sec / 60);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

/** The catalogue carries the test fixtures alongside the cities; `synth.ts` wrote their notes. */
const isFixture = (c: CityMeta): boolean => (c.notes ?? '').startsWith('synth.ts');

export function Controls(): React.ReactElement {
  const cities = useStore((s) => s.cities);
  const cityId = useStore((s) => s.cityId);
  const presets = useStore((s) => s.presets);
  const presetId = useStore((s) => s.presetId);
  const status = useStore((s) => s.status);
  const clock = useStore((s) => s.clock);
  const speedX = useStore((s) => s.speedX);
  const scenario = useStore((s) => s.scenario);
  const ready = useStore((s) => s.ready);
  const showCut = useStore((s) => s.showCut);
  const particles = useStore((s) => s.particles);
  const showParked = useStore((s) => s.showParked);

  const running = status === 'running';
  const pct = ready && ready.totalVeh > 0 ? clock.evacuated / ready.totalVeh : 0;
  const real = cities.filter((c) => !isFixture(c));
  const fixtures = cities.filter(isFixture);

  return (
    <div className="controls">
      <select
        value={presetId ?? ''}
        onChange={(e) => {
          if (e.target.value) void selectPreset(e.target.value);
        }}
      >
        <option value="">— pick a run —</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      <select
        value={cityId ?? ''}
        onChange={(e) => {
          void selectCity(e.target.value);
        }}
      >
        {real.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        {fixtures.length > 0 && (
          <optgroup label="test fixtures">
            {fixtures.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      <div className="row">
        <button className="primary" onClick={running ? pause : play} disabled={status === 'loading'}>
          {running ? 'Pause' : 'Play'}
        </button>
        <button onClick={reset}>Reset</button>
        <span className="clock">{elapsed(clock.t)}</span>
      </div>

      <div className="bar">
        <div className="fill" style={{ width: `${(pct * 100).toFixed(1)}%` }} />
        <span>{(pct * 100).toFixed(1)}% evacuated</span>
      </div>

      <label className="check strong">
        <input
          type="checkbox"
          checked={showCut}
          onChange={(e) => setState({ showCut: e.target.checked })}
        />
        show the bottleneck — every car has to pass here
      </label>

      <div className="row">
        <label>Speed</label>
        <select value={speedX} onChange={(e) => setSpeed(Number(e.target.value))}>
          {SPEEDS.map((x) => (
            <option key={x} value={x}>
              ×{x}
            </option>
          ))}
        </select>
        <span className="muted">
          actual ×{clock.actualX < 10 ? clock.actualX.toFixed(1) : clock.actualX.toFixed(0)}
        </span>
      </div>
      {clock.actualX > 0 && clock.actualX < speedX * 0.9 && (
        // §1.1: the worker computes every tick and drops frames, so this is how fast the
        // picture moves, not how much of the simulation was skipped.
        <p className="note muted">
          Every tick is computed; frames are dropped to keep up. Nothing is being skipped.
        </p>
      )}

      {scenario && (
        <>
          <Slider
            label="See traffic"
            value={Math.round(scenario.routing.informed * 100)}
            min={0}
            max={100}
            step={1}
            suffix="% of drivers"
            onChange={(v) =>
              updateScenario((s) => ({ ...s, routing: { ...s.routing, informed: v / 100 } }))
            }
          />
          <p className="note muted">
            At 0% everyone drives the map and nobody knows where the jams are; at 100% everyone
            reroutes around them. Both ends are wrong for a real town.
          </p>

          <Slider
            label="Occupancy"
            value={scenario.demand.occupancy}
            min={1}
            max={4}
            step={0.1}
            suffix=" ppl/car"
            onChange={(v) =>
              updateScenario((s) => ({ ...s, demand: { ...s.demand, occupancy: v } }))
            }
          />
          <Slider
            label="Half depart"
            value={scenario.demand.mobilizationHalfMin}
            min={0}
            max={240}
            step={5}
            suffix=" min"
            onChange={(v) =>
              updateScenario((s) => ({ ...s, demand: { ...s.demand, mobilizationHalfMin: v } }))
            }
          />
          <Slider
            label="Saturation"
            value={scenario.supply.satFlowPerLane}
            min={1000}
            max={2200}
            step={50}
            suffix=" veh/h/lane"
            onChange={(v) =>
              updateScenario((s) => ({ ...s, supply: { ...s.supply, satFlowPerLane: v } }))
            }
          />

          <label className="check">
            <input
              type="checkbox"
              checked={particles}
              onChange={(e) => setState({ particles: e.target.checked })}
            />
            show traffic
          </label>
          {particles && (
            <label className="check">
              <input
                type="checkbox"
                checked={showParked}
                onChange={(e) => setState({ showParked: e.target.checked })}
              />
              cars still in driveways
            </label>
          )}
        </>
      )}
    </div>
  );
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (v: number) => void;
}): React.ReactElement {
  return (
    <div className="row slider">
      <label>{props.label}</label>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="muted">
        {props.value}
        {props.suffix}
      </span>
    </div>
  );
}
