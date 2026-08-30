// Transport controls and the parameters a run is actually argued over.

import { pause, play, reset, selectCity, setSpeed, updateScenario } from '../main/app.ts';
import { setState, useStore } from '../main/state.ts';

const SPEEDS = [1, 10, 60, 120, 300, 600];

function hms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

export function Controls(): React.ReactElement {
  const cities = useStore((s) => s.cities);
  const cityId = useStore((s) => s.cityId);
  const status = useStore((s) => s.status);
  const clock = useStore((s) => s.clock);
  const speedX = useStore((s) => s.speedX);
  const scenario = useStore((s) => s.scenario);
  const ready = useStore((s) => s.ready);
  const showCut = useStore((s) => s.showCut);

  const running = status === 'running';
  const pct = ready && ready.totalVeh > 0 ? clock.evacuated / ready.totalVeh : 0;

  return (
    <div className="controls">
      <select
        value={cityId ?? ''}
        onChange={(e) => {
          void selectCity(e.target.value);
        }}
      >
        {cities.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <div className="row">
        <button onClick={running ? pause : play} disabled={status === 'loading'}>
          {running ? 'Pause' : 'Play'}
        </button>
        <button onClick={reset}>Reset</button>
        <span className="clock">{hms(clock.t)}</span>
      </div>

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

      <div className="bar">
        <div className="fill" style={{ width: `${(pct * 100).toFixed(1)}%` }} />
        <span>{(pct * 100).toFixed(1)}% evacuated</span>
      </div>

      {scenario && (
        <>
          <div className="row">
            <label>Routing</label>
            <select
              value={scenario.routing.mode}
              onChange={(e) =>
                updateScenario((s) => ({
                  ...s,
                  routing: { ...s.routing, mode: e.target.value as 'static' | 'reactive' },
                }))
              }
            >
              <option value="static">drivers blind to jams</option>
              <option value="reactive">drivers see traffic</option>
            </select>
          </div>

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
              checked={showCut}
              onChange={(e) => setState({ showCut: e.target.checked })}
            />
            highlight the minimum cut
          </label>
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
