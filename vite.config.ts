import { defineConfig } from 'vite';

const api = 'http://localhost:8787';
export default defineConfig({
  root: 'src/web',
  build: { outDir: '../../dist', emptyOutDir: true, assetsDir: 'static' },
  server: { port: 5173, proxy: { '/tiles': api, '/assets': api, '/api': api } },
});
