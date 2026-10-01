import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Bind-mounted source inside Docker Desktop (especially on Windows) may not emit
// file-change events, so VITE_USE_POLLING opts into polling.
const usePolling = process.env.VITE_USE_POLLING === 'true';
// Where the dev server sends API calls; set it to run against an API on another port.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3000';
const proxy = {
  '/api': apiTarget,
  '/socket.io': { target: apiTarget, ws: true },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Compile @tms/shared from source: its published build is CommonJS for Node.
    alias: {
      '@tms/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5175,
    strictPort: true,
    watch: usePolling ? { usePolling: true, interval: 300 } : undefined,
    proxy,
  },
  preview: {
    host: true,
    port: 4175,
    proxy,
  },
});
