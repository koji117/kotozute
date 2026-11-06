import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';
import { REGION } from './src/region.ts';

const api = 'http://127.0.0.1:8787';
// 画面は地域の設定（src/region.ts）を build のときに埋め込む。ブラウザでは data/region.json を読めないため。設定を変えたら build をやり直す
const regionModule = normalizePath(fileURLToPath(new URL('./src/region.ts', import.meta.url)));
export default defineConfig({
  root: 'src/web',
  build: { outDir: '../../dist', emptyOutDir: true, assetsDir: 'static' },
  server: { port: 5173, proxy: { '/tiles': api, '/assets': api, '/api': api } },
  plugins: [{ name: 'kotozute-region', enforce: 'pre', load: (id) => (id === regionModule ? `export const REGION = ${JSON.stringify(REGION)};` : undefined) }],
});
