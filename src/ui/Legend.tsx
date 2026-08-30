// What the colours mean. Without it the map is a pretty picture with no reading.

import { PALETTE, LUT_SIZE } from '../render/palette.ts';
import { useStore } from '../main/state.ts';

function gradient(theme: 'dark' | 'light'): string {
  const lut = PALETTE[theme].load;
  const stops: string[] = [];
  for (const x of [0, 0.25, 0.5, 0.7, 0.85, 1]) {
    const i = ((x * (LUT_SIZE - 1)) | 0) * 3;
    stops.push(`rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]}) ${(x * 100).toFixed(0)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(',')})`;
}

export function Legend(): React.ReactElement | null {
  const theme = useStore((s) => s.theme);
  const showCut = useStore((s) => s.showCut);
  const particles = useStore((s) => s.particles);
  const showParked = useStore((s) => s.showParked);
  const stranded = useStore((s) => s.perf?.stuck ?? 0);
  const ready = useStore((s) => s.ready);
  if (!ready) return null;

  const cut = PALETTE[theme].cut;
  const dot = PALETTE[theme].particle;
  const parked = PALETTE[theme].parked;
  const stuck = PALETTE[theme].stuck;

  return (
    <div className="legend">
      <div className="ramp" style={{ background: gradient(theme) }} />
      <div className="ramp-labels">
        <span>empty</span>
        <span>full</span>
        <span>stopped</span>
      </div>
      {particles && (
        <>
          <div className="key">
            <i className="dot" style={{ background: `rgb(${dot[0]},${dot[1]},${dot[2]})` }} />
            one dot is one car — click it to follow its route
          </div>
          {showParked && (
            <div className="key">
              <i
                className="dot"
                style={{ background: `rgba(${parked[0]},${parked[1]},${parked[2]},0.7)` }}
              />
              still in the driveway
            </div>
          )}
          {stranded > 0 && (
            <div className="key">
              <i className="dot" style={{ background: `rgb(${stuck[0]},${stuck[1]},${stuck[2]})` }} />
              no way out from where they stand — {stranded.toLocaleString()}
            </div>
          )}
        </>
      )}
      {showCut && (
        <div className="key">
          <i className="dash" style={{ borderColor: `rgb(${cut[0]},${cut[1]},${cut[2]})` }} />
          the bottleneck — {ready.cutEdges.length} road
          {ready.cutEdges.length === 1 ? '' : 's'}, {ready.maxFlowVehH.toLocaleString()} veh/h
        </div>
      )}
      <div className="key muted">each direction of travel is its own line</div>
    </div>
  );
}
