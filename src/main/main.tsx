// biome-ignore lint/correctness/noUnresolvedImports: false positive -- @types/react declares StrictMode as a const inside the React namespace, which the resolver does not follow; tsc resolves it and it exists at runtime
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App.tsx';
import { boot, reportError } from './app.ts';
import '../ui/styles.css';

const host = document.getElementById('root');
if (!host) throw new Error('no #root in the document');
// Double-invoked effects in development are the only check there is that the map, the deck
// instance and the renderer sink are torn down as completely as they are built.
createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
boot().catch(reportError);
