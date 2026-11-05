// 自前の地図（tokyo.pmtiles）を MapLibre で描き、PNG に書き出す。絵コンテの背景に使う。
// 使い方（docs/storyboard で）：node mapshot.js spec.json
//   kotozute のサーバ（:8787、タイルとフォントを配信）が動いていること。
// spec.json：{ "shots": [ { "out": "x.png", "width": 1280, "height": 640, "dpr": 2,
//   "center": [lng, lat], "zoom": 14, "bearing": 0, "flavor": "light", "flavorOverrides": {},
//   "sources": { id: GeoJSON }, "layers": [ MapLibre のレイヤ ], "project": { 名前: [lng, lat] } } ] }
// 出力：PNG と、project に書いた点の画面上の位置（CSS ピクセル）を <out>.json に書く。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ORIGIN = 'http://localhost:8787';
const NM = path.resolve(__dirname, '../../node_modules');
const LIB = {
  '/__lib/ml/': path.join(NM, 'maplibre-gl/dist/'),
  '/__lib/pmtiles.js': path.join(NM, 'pmtiles/dist/pmtiles.js'),
  '/__lib/basemaps.js': path.join(NM, '@protomaps/basemaps/dist/basemaps.js'),
};
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/__lib/ml/maplibre-gl.css">
<style>html,body,#map{margin:0;width:100%;height:100%}</style>
<script src="/__lib/pmtiles.js"></script><script src="/__lib/basemaps.js"></script></head>
<body><div id="map"></div><script type="module">
import * as maplibregl from '/__lib/ml/maplibre-gl.mjs';
window.maplibregl = maplibregl; window.ready = true;
</script></body></html>`;

async function shoot(browser, s) {
  const page = await browser.newPage({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.dpr ?? 2 });
  await page.route(`${ORIGIN}/__shot.html`, r => r.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.route(`${ORIGIN}/__lib/**`, r => {
    const p = new URL(r.request().url()).pathname;
    const key = Object.keys(LIB).find(k => p.startsWith(k));
    const file = key.endsWith('/') ? path.join(LIB[key], p.slice(key.length)) : LIB[key];
    const type = file.endsWith('.css') ? 'text/css' : 'text/javascript';
    r.fulfill({ contentType: type, body: fs.readFileSync(file) });
  });
  await page.goto(`${ORIGIN}/__shot.html`);
  await page.waitForFunction(() => window.ready);
  const res = await page.evaluate(async (s) => {
    const { layers, namedFlavor } = window.basemaps;
    const ml = window.maplibregl;
    ml.addProtocol('pmtiles', new window.pmtiles.Protocol().tile);
    const flavorName = s.flavor ?? 'light';
    const flavor = { ...namedFlavor(flavorName), ...(s.flavorOverrides ?? {}) };
    const o = location.origin;
    const map = new ml.Map({
      container: 'map', center: s.center, zoom: s.zoom, bearing: s.bearing ?? 0, pitch: s.pitch ?? 0,
      attributionControl: false, interactive: false, fadeDuration: 0,
      canvasContextAttributes: { preserveDrawingBuffer: true },
      style: {
        version: 8,
        glyphs: `${o}/assets/fonts/{fontstack}/{range}.pbf`,
        sprite: `${o}/assets/sprites/v4/${['light', 'dark', 'white', 'grayscale', 'black'].includes(flavorName) ? flavorName : 'light'}`,
        sources: { protomaps: { type: 'vector', url: `pmtiles://${o}/tiles/tokyo.pmtiles` }, ...Object.fromEntries(Object.entries(s.sources ?? {}).map(([k, d]) => [k, { type: 'geojson', data: d }])) },
        layers: [...layers('protomaps', flavor, { lang: 'ja' }).filter(l => !('source-layer' in l && l['source-layer'] === 'landcover')), ...(s.layers ?? [])],
      },
    });
    await new Promise(r => map.once('load', r));
    // fit：{ bounds: [[西,南],[東,北]], padding: {top,right,bottom,left}, maxZoom } で範囲に合わせる
    if (s.fit) map.fitBounds(s.fit.bounds, { padding: s.fit.padding ?? 40, maxZoom: s.fit.maxZoom ?? 17, bearing: s.bearing ?? 0, duration: 0 });
    // fitPoints：{ points: [[lng,lat],...], padding: {top,right,bottom,left} }。回した地図でも、画面上の点の広がりで合わせる
    if (s.fitPoints) {
      const P = s.fitPoints.padding, W = s.width, H = s.height;
      const pts = s.fitPoints.points;
      map.jumpTo({ center: [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length], bearing: s.bearing ?? 0 });
      for (let i = 0; i < 3; i++) {
        const xy = pts.map(p => map.project(p));
        const [x0, x1, y0, y1] = [Math.min(...xy.map(p => p.x)), Math.max(...xy.map(p => p.x)), Math.min(...xy.map(p => p.y)), Math.max(...xy.map(p => p.y))];
        const k = Math.min((W - P.left - P.right) / Math.max(1, x1 - x0), (H - P.top - P.bottom) / Math.max(1, y1 - y0));
        // 点の広がりの中心を、余白を除いた枠の中心に持ってくる
        const want = [P.left + (W - P.left - P.right) / 2, P.top + (H - P.top - P.bottom) / 2];
        const c = map.unproject([W / 2 + ((x0 + x1) / 2 - want[0]), H / 2 + ((y0 + y1) / 2 - want[1])]);
        map.jumpTo({ center: c, zoom: Math.min(s.fitPoints.maxZoom ?? 17, map.getZoom() + Math.log2(k)) });
      }
    }
    await new Promise(r => map.once('idle', r));
    const points = Object.fromEntries(Object.entries(s.project ?? {}).map(([k, ll]) => { const p = map.project(ll); return [k, [Math.round(p.x), Math.round(p.y)]]; }));
    const c = map.getCenter();
    return { png: map.getCanvas().toDataURL('image/png'), points, view: { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing() } };
  }, s);
  fs.writeFileSync(s.out, Buffer.from(res.png.split(',')[1], 'base64'));
  fs.writeFileSync(s.out.replace(/\.png$/, '.json'), JSON.stringify({ width: s.width, height: s.height, view: res.view, points: res.points }, null, 1));
  await page.close();
  console.log('wrote', s.out);
}

(async () => {
  const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const s of spec.shots) await shoot(browser, s);
  await browser.close();
})();
