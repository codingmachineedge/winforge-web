import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
// Shell fonts: Material Symbols (rail/drawer/chips icons), Roboto Flex (M3 type
// scale), Roboto Mono (kbd badges, tags). All bundled locally — never a CDN.
import 'material-symbols/outlined.css';
import '@fontsource-variable/roboto-flex';
import '@fontsource/roboto-mono/400.css';
import '@fontsource/roboto-mono/500.css';
import './styles/global.css';
import './styles/a11y.css';
// Material 3 design tokens + shell chrome — must come after global.css so the
// M3 restyles win the cascade.
import './styles/m3.css';
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
