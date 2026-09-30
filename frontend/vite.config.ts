import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Bind-mounted source inside Docker Desktop (especially on Windows) may not emit
// file-change events, so the dev container opts into polling via VITE_USE_POLLING.
const usePolling = process.env.VITE_USE_POLLING === 'true';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    watch: usePolling ? { usePolling: true, interval: 300 } : undefined,
  },
  preview: {
    host: true,
    port: 4173,
  },
});
