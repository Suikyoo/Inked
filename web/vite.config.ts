import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Dev only: the server serves these pages by path in production; Vite needs the same mapping.
function openboardDevRewrites(): Plugin {
  return {
    name: 'openboard-dev-rewrites',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const pathname = (req.url ?? '').split('?')[0]!;
          if (pathname === '/ob' || pathname.startsWith('/ob/')) req.url = '/openboard.html';
          else if (pathname === '/openboard' || pathname.startsWith('/openboard/')) req.url = '/openboard-editor.html';
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), openboardDevRewrites()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: { main: 'index.html', openboard: 'openboard.html', 'openboard-editor': 'openboard-editor.html' },
    },
    // Everything is self-hosted; keep fonts and wasm as separate files rather than data: URLs.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/frame': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    testTimeout: 20000,
  },
});
