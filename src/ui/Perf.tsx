// Frame cost split the way the frame loop is split, behind ?perf=1.
//
// §13.2 says a dropped framerate on a big city is acceptable and cutting the main visual
// silently is not, so this says which phase spent the time instead of deciding anything.
// Cutting is no longer even available: the dots ARE the count now, so drawing fewer would be
// a lie rather than a saving.
//
// `err` is the one number worth watching: max |dots on an edge - n[e]|. It should stay around
// a car. If it drifts, the Newell placement is wired wrong and the map is lying about density.

import { useStore } from '../main/state.ts';

const ms = (x: number): string => x.toFixed(2);

export function Perf(): React.ReactElement | null {
  const perf = useStore((s) => s.perf);
  if (!perf) return null;
  return (
    <div className="perf">
      <b>{ms(perf.total)} ms/frame</b>
      <span>colour {ms(perf.paint)}</span>
      <span>advance {ms(perf.step)}</span>
      <span>place {ms(perf.place)}</span>
      <span>upload {ms(perf.upload)}</span>
      <span>
        {perf.dots.toLocaleString()} moving · {perf.parked.toLocaleString()} parked
        {perf.stuck > 0 && ` · ${perf.stuck.toLocaleString()} stranded`}
      </span>
      <span>
        err {perf.dotErr.toFixed(1)} · z{perf.zoom.toFixed(1)}
      </span>
    </div>
  );
}
