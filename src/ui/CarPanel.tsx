// The car being followed. One dot is one car (§13.2), so this can name where it started, when
// it left and how long it has been going -- and it keeps saying so after the car has left the
// city, because a slot is never reused and its route survives to the end of the run.

import { useRef } from 'react';
import { useStore } from '../main/state.ts';

/** Elapsed, not a wall clock: `22:41` was being read as twenty to eleven at night. */
function elapsed(sec: number): string {
  const total = Math.round(sec / 60);
  return total < 60 ? `${total}m` : `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

export function CarPanel(): React.ReactElement | null {
  const car = useStore((s) => s.followed);
  const names = useStore((s) => s.edgeNames);
  // Road names come back from the worker asynchronously, and a moving car changes roads faster
  // than the round trip. Falling through to "unnamed" makes a named street flicker; the last
  // road we could name is a better answer than none.
  const lastRoad = useRef<{ slot: number; name: string } | null>(null);
  if (!car) return null;

  const origin = car.originEdgeId >= 0 ? names[car.originEdgeId] : undefined;
  let current = car.currentEdgeId >= 0 ? names[car.currentEdgeId] : undefined;
  if (lastRoad.current?.slot !== car.slot) lastRoad.current = null;
  if (current) lastRoad.current = { slot: car.slot, name: current };
  else current = lastRoad.current?.name;

  return (
    <div className="probe">
      <div className="name">
        {car.state === 'parked' && 'waiting in a driveway'}
        {car.state === 'moving' && (current || 'on an unnamed road')}
        {car.state === 'arrived' && 'out of the city'}
        {car.state === 'stuck' && 'no way out from here'}
      </div>
      <div className="muted">
        {car.state === 'parked' ? (
          <>has not left yet</>
        ) : (
          <>
            left {origin || 'an unnamed road'} at {elapsed(car.departedAt)} ·{' '}
            {car.state === 'arrived' ? 'took ' : 'going '}
            {elapsed(car.elapsed)} · {car.hops} road{car.hops === 1 ? '' : 's'}
            {car.routeTruncated ? ' (route clipped)' : null}
          </>
        )}
      </div>
      <div className="muted">car #{car.slot.toLocaleString()}</div>
    </div>
  );
}
