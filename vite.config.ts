import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json';

// https://vite.dev/config/
// Tauri expects a fixed dev port; `base: './'` keeps asset paths relative so the
// built bundle loads from the app's file:// (tauri://) origin.
//
// VitePWA makes the BROWSER build installable + offline-capable. It is inert inside
// the Tauri desktop app: the service-worker registration in src/pwa.ts bails out
// under the tauri:// origin, and Tauri ships its own icons/manifest, so the extra
// manifest.webmanifest + sw.js in dist are simply never requested there.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registration is driven manually from src/pwa.ts (guarded for Tauri/non-http).
      injectRegister: null,
      devOptions: {
        // Do not run the SW in dev — keep the running dev server on 5199 untouched.
        enabled: false,
      },
      workbox: {
        // Precache every built asset (fully static app). Raise the size cap so the
        // large lazy chunk (~1.7MB, e.g. the reactor simulator) is precached too.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'WinForge Web',
        short_name: 'WinForge',
        description: pkg.description,
        theme_color: '#1b1b1f',
        background_color: '#1b1b1f',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'icons/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  base: './',
  clearScreen: false,
  server: {
    port: 5199,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      ignored: ['**/src-tauri/target/**', '**/node_modules/**', '**/dist/**'],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2021',
  },
});
