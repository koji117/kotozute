import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

const ASSETS = 'data/basemaps-assets-src/basemaps-assets-main';
const app = new Hono();

// 地図ファイル（Range 対応）とフォント・アイコンはすべて自前で配信する。公開CDNは使わない。
app.get('/tiles/tokyo.pmtiles', serveStatic({ path: 'tokyo.pmtiles' }));
app.use('/assets/*', serveStatic({ root: ASSETS, rewriteRequestPath: p => decodeURIComponent(p.replace(/^\/assets/, '')) }));
app.use('/*', serveStatic({ root: 'dist' })); // vite build の出力

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`kotozute server http://localhost:${port}`);
