// The three interventions of §9.1, aimed at whichever road was last clicked on the map.
//
// Every one of them is stamped with the minute it was made and written into the scenario, so
// the link in "copy link" reproduces the run that was on screen rather than one where the
// road was shut from the start.

import { applyEdit, copyLink, removeEdit } from '../main/app.ts';
import { useStore } from '../main/state.ts';
import type { Edit } from '../core/types.ts';

const NO_TWIN = 0xffffffff;

function what(edit: Edit): string {
  if (edit.op === 'addRoad') return 'added';
  if (edit.op === 'close') return 'closed';
  if (edit.op === 'contraflow') return 'contraflow';
  return `${edit.lanes} lane${edit.lanes === 1 ? '' : 's'}`;
}

function when(edit: Edit): string {
  return edit.op !== 'addRoad' && edit.atMin !== undefined ? `at ${edit.atMin} min` : 'from the start';
}

type Group = { from: number; to: number; text: string };

/**
 * One line per intervention, not per edge. A contraflow written out along a corridor is a
 * hundred and twenty-six edits doing one thing at one moment, and listing them individually
 * buries the four that matter -- the closures the fire caused.
 */
function group(edits: Edit[], names: Record<number, string>): Group[] {
  const out: Group[] = [];
  for (let i = 0; i < edits.length; ) {
    const key = `${what(edits[i])}|${when(edits[i])}`;
    let j = i;
    while (j + 1 < edits.length && `${what(edits[j + 1])}|${when(edits[j + 1])}` === key) j++;
    const n = j - i + 1;
    const first = edits[i];
    const road =
      n > 1
        ? `${n} roads`
        : first.op === 'addRoad'
          ? `road #${first.id}`
          : names[first.edgeId] || `road #${first.edgeId}`;
    out.push({ from: i, to: j, text: `${road} — ${what(first)}, ${when(first)}` });
    i = j + 1;
  }
  return out;
}

export function Interventions(): React.ReactElement | null {
  const probe = useStore((s) => s.probe);
  const scenario = useStore((s) => s.scenario);
  const names = useStore((s) => s.edgeNames);
  const link = useStore((s) => s.link);
  if (!scenario) return null;

  const edits = scenario.edits;

  return (
    <div className="interventions">
      <h2>Interventions</h2>

      {probe === null ? (
        <p className="muted">Click a road on the map to act on it.</p>
      ) : (
        <>
          <div className="target">
            {probe.name || 'unnamed road'}
            <span className="muted">
              {' '}
              · {probe.lanes} lane{probe.lanes === 1 ? '' : 's'}
              {probe.blocked && ' · closed'}
            </span>
          </div>
          <div className="row">
            <button
              disabled={probe.blocked}
              onClick={() => applyEdit({ op: 'close', edgeId: probe.edgeId })}
            >
              Close
            </button>
            <button
              disabled={probe.twin === NO_TWIN}
              // §9.3 ignores a contraflow with no twin, so the button says so instead of
              // pretending to work. A divided highway lands here: its two carriageways are
              // separate roads, not twins.
              title={probe.twin === NO_TWIN ? 'this road has no opposite direction to take' : ''}
              onClick={() => applyEdit({ op: 'contraflow', edgeId: probe.edgeId })}
            >
              Contraflow
            </button>
            <button
              onClick={() => applyEdit({ op: 'lanes', edgeId: probe.edgeId, lanes: probe.lanes + 1 })}
            >
              +1 lane
            </button>
          </div>
        </>
      )}

      {edits.length > 0 && (
        <ul className="edits">
          {group(edits, names).map((g) => (
            <li key={g.from}>
              <span>{g.text}</span>
              <button
                className="drop"
                title="removing an edit rebuilds the network and restarts the run"
                onClick={() => removeEdit(g.from, g.to)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="row">
        <button onClick={() => void copyLink()}>Copy link</button>
        {link && <span className="muted">copied</span>}
      </div>
    </div>
  );
}
