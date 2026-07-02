import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
// Tauri expects a fixed dev port; `base: './'` keeps asset paths relative so the
// built bundle loads from the app's file:// (tauri://) origin.
export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: {
    port: 5199,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2021',
  },
});
