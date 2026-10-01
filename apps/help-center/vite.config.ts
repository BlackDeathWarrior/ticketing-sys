import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served under /help/ by the web container, next to the chat widget (/widget/).
// `pnpm dev` serves it on http://localhost:5176/help/.
// Where the dev server sends API calls; set it to run against an API on another port.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  base: '/help/',
  plugins: [react()],
  resolve: {
    // Compile @tms/shared from source: its published build is CommonJS for Node.
    alias: {
      '@tms/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5176,
    proxy: {
      '/api': apiTarget,
      '/widget': process.env.VITE_WIDGET_TARGET ?? 'http://localhost:8080',
      '/socket.io': { target: apiTarget, ws: true },
    },
  },
});
