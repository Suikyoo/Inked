import { defineConfig } from 'vite';

// The sandboxed diagram renderer: its own build, served by the server under /frame/ with its own CSP.
export default defineConfig({
  base: '/frame/',
  publicDir: false, // the main build's public/ (semantic model files) must not be copied here
  build: {
    outDir: 'dist/frame',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: { input: 'frame.html' },
  },
});
