import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';
import { REGION, webRegion } from './src/region.ts';

const api = 'http://127.0.0.1:8787';
// 画面は地域の設定（src/region.ts）を build のときに埋め込む。ブラウザでは data/region.json を読めないため。
// サーバが画面（index.html）に今の値（<script type="application/json" id="kz-region">）を入れていれば、そちらで上書きする（src/server/main.ts）。
// vite の開発サーバの画面には入らないので、埋め込んだ値のまま。サーバだけが使うパスは画面に入れない（webRegion）
const regionModule = normalizePath(fileURLToPath(new URL('./src/region.ts', import.meta.url)));
const REGION_JS = `const baked = ${JSON.stringify(webRegion(REGION))};
const live = document.getElementById('kz-region');
export const REGION = live ? { ...baked, ...JSON.parse(live.textContent) } : baked;`;
export default defineConfig({
  root: 'src/web',
  build: { outDir: '../../dist', emptyOutDir: true, assetsDir: 'static' },
  server: { port: 5173, proxy: { '/tiles': api, '/assets': api, '/api': api } },
  plugins: [{ name: 'kotozute-region', enforce: 'pre', load: (id) => (id === regionModule ? REGION_JS : undefined) }],
});
