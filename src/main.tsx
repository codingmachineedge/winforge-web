import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './styles/global.css';
import './styles/a11y.css';
import { initTheme } from './state/theme';
import { initPwa } from './pwa';
import { App } from './App';

// Apply the persisted theme before first paint to avoid a wrong-theme flash.
initTheme();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the browser PWA service worker (no-op in Tauri / non-http contexts).
initPwa();
