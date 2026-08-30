import { MapView } from './MapView.tsx';
import { Controls } from './Controls.tsx';
import { EvacCurve } from './EvacCurve.tsx';
import { MetricsPanel } from './MetricsPanel.tsx';
import { Interventions } from './Interventions.tsx';
import { useStore } from '../main/state.ts';

export function App(): React.ReactElement {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const meta = useStore((s) => s.ready?.meta ?? null);

  return (
    <div className="app">
      <MapView />
      <aside className="panel">
        <header>
          <h1>Bottleneck</h1>
          <p className="muted">{meta?.blurb ?? 'evacuation capacity of a city'}</p>
        </header>
        {error && <div className="error">{error}</div>}
        <Controls />
        <EvacCurve />
        <MetricsPanel />
        <Interventions />
        <footer className="muted">
          {status === 'loading' ? 'loading…' : status}
          {' · '}
          upper bound on an ideal dispatch; reality is worse
        </footer>
      </aside>
    </div>
  );
}
