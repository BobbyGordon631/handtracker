import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works from any static host / sub-path.
  base: './',
  server: { open: true },
  // three.js + MediaPipe are large; one chunk is fine for a single-page toy.
  build: { chunkSizeWarningLimit: 1500 },
});
