import { useEffect } from 'react';
import { MapView } from './MapView.tsx';
import { Controls } from './Controls.tsx';
import { EvacCurve } from './EvacCurve.tsx';
import { MetricsPanel } from './MetricsPanel.tsx';
import { Interventions } from './Interventions.tsx';
import { Legend } from './Legend.tsx';
import { Perf } from './Perf.tsx';
import { setState, useStore } from '../main/state.ts';

const showPerf = new URLSearchParams(location.search).get('perf') === '1';

export function App(): React.ReactElement {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const theme = useStore((s) => s.theme);
  const meta = useStore((s) => s.ready?.meta ?? null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="app">
      <div className="stage">
        <MapView />
        <Legend />
        {showPerf && <Perf />}
      </div>
      <aside className="panel">
        <header>
          <div className="row title">
            <h1>Bottleneck</h1>
            <button
              className="ghost"
              title="switch theme"
              onClick={() => setState({ theme: theme === 'light' ? 'dark' : 'light' })}
            >
              {theme === 'light' ? 'dark' : 'light'}
            </button>
          </div>
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
