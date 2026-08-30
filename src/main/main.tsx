import { createRoot } from 'react-dom/client';
import { App } from '../ui/App.tsx';
import { boot, reportError } from './app.ts';
import '../ui/styles.css';

const host = document.getElementById('root');
if (!host) throw new Error('no #root in the document');
createRoot(host).render(<App />);
boot().catch(reportError);
