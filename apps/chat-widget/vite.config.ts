import { defineConfig } from 'vite';

// Builds dist/tms-chat.js: a single IIFE that defines window.TMSChat.
// `pnpm dev` serves index.html with the widget on http://localhost:5174.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/widget.ts',
      name: 'TMSChat',
      formats: ['iife'],
      fileName: () => 'tms-chat.js',
    },
    target: 'es2020',
  },
  server: {
    port: 5174,
    proxy: { '/socket.io': { target: 'http://localhost:3000', ws: true } },
  },
});
