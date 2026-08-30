// Frame cost split the way the frame loop is split, behind ?perf=1.
//
// §13.2 says to cut particles when 16 ms is blown. On a city the size of San Francisco a
// dropped framerate is acceptable and cutting the main visual silently is not, so this says
// which of the four phases spent the time instead of deciding anything.

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
        {perf.dots.toLocaleString()} dots · z{perf.zoom.toFixed(1)}
      </span>
    </div>
  );
}
