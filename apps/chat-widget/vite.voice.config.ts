import { defineConfig } from 'vite';

// Builds dist/tms-voice.js next to tms-chat.js: a single IIFE that defines
// window.TMSVoice. It runs after the chat build, so it must not empty dist
// or copy the public folder again.
export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/voice.ts',
      name: 'TMSVoice',
      formats: ['iife'],
      fileName: () => 'tms-voice.js',
    },
    target: 'es2020',
  },
});
