// The numbers §11 says to show, including the ones that are uncomfortable.

import { useStore } from '../main/state.ts';

/**
 * T50 / T90 / T100 read off the curve while the run is still going. The exact values arrive
 * with the `done` message (§8.2); until then this is accurate to the curve's sampling step,
 * which beats showing a dash for six simulated hours.
 */
function crossing(curve: number[], target: number): number | null {
  for (let i = 0; i < curve.length; i += 2) if (curve[i + 1] >= target) return curve[i];
  return null;
}

function carlessText(people: number, busRuns: number): string {
  return `${Math.round(people).toLocaleString()} people · ${busRuns} bus runs`;
}

function hours(sec: number | null): string {
  if (sec === null) return '—';
  // Round to minutes first: rounding the remainder on its own prints "3h 60m".
  const total = Math.round(sec / 60);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

export function MetricsPanel(): React.ReactElement {
  const metrics = useStore((s) => s.metrics);
  const ready = useStore((s) => s.ready);
  const clock = useStore((s) => s.clock);
  const probe = useStore((s) => s.probe);
  const curve = useStore((s) => s.curve);
  const baselineT90 = useStore((s) => s.baselineT90);
  const edited = useStore((s) => (s.scenario?.edits.length ?? 0) > 0);

  const live = metrics === null;
  const carless = metrics
    ? metrics.carlessPeople
    : ready
      ? (ready.meta.carlessPeople ?? 0)
      : null;
  const busRuns = metrics ? metrics.busRunsNeeded : Math.ceil((carless ?? 0) / 40);
  const t50 = metrics ? metrics.t50Sec : crossing(curve, 0.5);
  const t90 = metrics ? metrics.t90Sec : crossing(curve, 0.9);
  const t100 = metrics ? metrics.t100Sec : crossing(curve, 0.999999);

  return (
    <div className="metrics">
      <div className="big">
        <span className="label">clearance T90</span>
        <span className="value">{hours(t90)}</span>
        {live && t90 !== null && <span className="muted">approx</span>}
        {/* The number an intervention is argued with: what it cost or bought against the
            same city with nothing done to it. */}
        {edited && baselineT90 !== null && t90 !== null && (
          <span className={t90 > baselineT90 ? 'delta worse' : 'delta better'}>
            {t90 > baselineT90 ? '+' : '−'}
            {hours(Math.abs(t90 - baselineT90))} vs untouched
          </span>
        )}
      </div>

      <div className="headline">
        <span>
          {ready ? Math.round(ready.totalVeh).toLocaleString() : '—'} <em>vehicles</em>
        </span>
        <span>
          {ready ? `${ready.maxFlowVehH.toLocaleString()}` : '—'} <em>veh/h out, at best</em>
        </span>
      </div>

      {/* §11: with no census data the honest answer is "no data", never a zero. */}
      <div className="equity-line">
        no car of their own:{' '}
        {carless === null ? '—' : carless === 0 ? 'no data' : carlessText(carless, busRuns)}
      </div>

      <details className="numbers">
        <summary>all the numbers</summary>
      <table>
        <tbody>
          <tr>
            <td>vehicles</td>
            <td>{ready ? Math.round(ready.totalVeh).toLocaleString() : '—'}</td>
          </tr>
          <tr>
            <td>on the road</td>
            <td>{Math.round(clock.enRoute).toLocaleString()}</td>
          </tr>
          <tr>
            <td>not departed</td>
            <td>{Math.round(clock.notDeparted).toLocaleString()}</td>
          </tr>
          <tr>
            <td>T50 / T100</td>
            <td>
              {hours(t50)} / {hours(t100)}
            </td>
          </tr>
          <tr>
            <td>peak outflow</td>
            <td>{metrics ? `${Math.round(metrics.peakOutflowVehH).toLocaleString()} veh/h` : '—'}</td>
          </tr>
          <tr>
            <td>max-flow ceiling</td>
            <td>
              {ready ? `${ready.maxFlowVehH.toLocaleString()} veh/h` : '—'}
              {metrics && metrics.efficiency > 0 && (
                <span className="muted"> · {(metrics.efficiency * 100).toFixed(0)}% used</span>
              )}
            </td>
          </tr>
          <tr>
            <td>longest jam</td>
            <td>{metrics ? `${(metrics.maxSpillbackM / 1000).toFixed(1)} km` : '—'}</td>
          </tr>
          <tr>
            <td>mean travel</td>
            <td>
              {metrics ? hours(metrics.meanTravelSec) : '—'}
              {/* §11: with vehicles left behind the mean is biased high, and saying so is
                  cheaper than being asked. */}
              {metrics && metrics.stranded > 1 && <span className="warn"> · biased, some stranded</span>}
            </td>
          </tr>
          <tr>
            <td>min cut</td>
            <td>{ready ? `${ready.cutEdges.length} road${ready.cutEdges.length === 1 ? '' : 's'}` : '—'}</td>
          </tr>
        </tbody>
      </table>
      </details>

      {probe && (
        <div className="probe">
          <div className="name">{probe.name || 'unnamed road'}</div>
          <div className="muted">
            {probe.lanes} lane{probe.lanes === 1 ? '' : 's'} · {probe.capVehH.toLocaleString()} veh/h
            · {Math.round(probe.n)} of {Math.round(probe.storage)} · load{' '}
            {(probe.load * 100).toFixed(0)}%
          </div>
        </div>
      )}
    </div>
  );
}
