// 案D（会話型）の地図 spec を作る。使い方（docs/storyboard で）：
//   node design/make-spec-d.js && node mapshot.js design/spec-d.json
// ルートは design/route.geojson（Valhalla）。トンネル・判定不能の区間は案Aと同じ絵コンテ用の切り出し。
const fs = require('fs');
const path = require('path');
const D = __dirname;
const route = JSON.parse(fs.readFileSync(path.join(D, 'route.geojson'), 'utf8'));
const a = require('./spec-a.json').shots[0];

// 地図の色：灰色の地図の上で、柿色のルートと菫色の判定不能だけが目立つようにする
const C = {
  accent: '#D9560F',      // ルート（--c-accent-map）
  accentDeep: '#7C2D0A',  // ルートの縁・トンネル区間（--c-accent-deep）
  unk: '#7B55B5',         // 判定不能の区間（--c-unk-map）
  ink: '#1B1E23',         // 到着の点（--c-ink）
};
const flavorOverrides = {
  background: '#E9E9E6', earth: '#EFEFEC',
  park_a: '#E1E4DD', park_b: '#D7DCD2', wood_a: '#E1E4DD', wood_b: '#D7DCD2', scrub_a: '#E1E4DD', scrub_b: '#D7DCD2',
  water: '#CBD3D9', buildings: '#E2E2DE',
};
const routeLayers = [
  { id: 'unk-halo', type: 'line', source: 'unknown', paint: { 'line-color': C.unk, 'line-opacity': 0.30, 'line-width': 22 }, layout: { 'line-cap': 'round', 'line-join': 'round' } },
  { id: 'route-casing', type: 'line', source: 'route', paint: { 'line-color': '#FFFFFF', 'line-width': 11 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
  { id: 'route-edge', type: 'line', source: 'route', paint: { 'line-color': C.accentDeep, 'line-width': 7.5 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
  { id: 'route', type: 'line', source: 'route', paint: { 'line-color': C.accent, 'line-width': 5 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
  { id: 'tunnel-base', type: 'line', source: 'tunnels', paint: { 'line-color': C.accentDeep, 'line-width': 7.5 } },
  { id: 'tunnel-core', type: 'line', source: 'tunnels', paint: { 'line-color': '#FFFFFF', 'line-width': 2.2, 'line-dasharray': [1.4, 1.2] } },
  { id: 'start', type: 'circle', source: 'ends', filter: ['==', ['get', 'k'], 's'], paint: { 'circle-radius': 7, 'circle-color': '#FFFFFF', 'circle-stroke-color': C.ink, 'circle-stroke-width': 3.5 } },
  { id: 'goal', type: 'circle', source: 'ends', filter: ['==', ['get', 'k'], 'g'], paint: { 'circle-radius': 9, 'circle-color': C.ink, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 3 } },
  { id: 'goal-dot', type: 'circle', source: 'ends', filter: ['==', ['get', 'k'], 'g'], paint: { 'circle-radius': 3, 'circle-color': '#FFFFFF' } },
  // 見えない記号：出発・到着の点の下に地図の文字が来ないよう、ここを空ける（上のレイヤが先に置かれる）
  { id: 'ends-block', type: 'symbol', source: 'ends', layout: { 'text-field': 'O', 'text-font': ['Noto Sans Regular'], 'text-size': 26, 'text-allow-overlap': true }, paint: { 'text-opacity': 0 } },
];
const base = { dpr: 2, center: [139.742, 35.644], zoom: 14, flavor: 'grayscale', flavorOverrides };
// ルートから、点 p の前後 m メートルを切り出す（判定不能の区間を、ルートの上にぴったり重ねるため）
const R = route.geometry.coordinates;
const dist = (p, q) => Math.hypot((p[0] - q[0]) * 90400, (p[1] - q[1]) * 111000); // 東京付近の度→m
function slice(p, m) {
  let i0 = 0; R.forEach((c, i) => { if (dist(c, p) < dist(R[i0], p)) i0 = i; });
  let a0 = i0, b0 = i0, d = 0;
  while (a0 > 0 && d < m) { d += dist(R[a0], R[a0 - 1]); a0--; }
  d = 0; while (b0 < R.length - 1 && d < m) { d += dist(R[b0], R[b0 + 1]); b0++; }
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: R.slice(a0, b0 + 1) } };
}
const unknown = { type: 'FeatureCollection', features: ['u1', 'u2', 'u3'].map(k => slice(a.project[k], 130)) };
const routeSources = { route, tunnels: a.sources.tunnels, unknown, ends: a.sources.ends };
const pt = (lng, lat, k) => ({ type: 'Feature', properties: { k }, geometry: { type: 'Point', coordinates: [lng, lat] } });
const TOWER = [139.74543, 35.65858]; // 東京タワー付近（港区芝公園4-2-8 の絵コンテ用の位置）

const shots = [
  { ...base, out: 'design/map-d.png', width: 1280, height: 640,
    fit: { bounds: [[139.7372, 35.628], [139.7472, 35.6596]], padding: { top: 70, right: 476 + 262, bottom: 62, left: 158 } },
    sources: routeSources, layers: routeLayers, project: a.project },
  // パネル表：住所の結果（ピンは上寄せ。下に出典を重ねるため）
  { ...base, out: 'design/crop-d-addr.png', width: 450, height: 132, center: [139.74543, 35.65834], zoom: 16,
    sources: { pin: pt(...TOWER, 'p') },
    layers: [
      { id: 'pin-ring', type: 'circle', source: 'pin', paint: { 'circle-radius': 20, 'circle-color': C.accent, 'circle-opacity': 0.14, 'circle-stroke-color': C.accent, 'circle-stroke-width': 1.5 } },
      { id: 'pin', type: 'circle', source: 'pin', paint: { 'circle-radius': 7, 'circle-color': C.accent, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 3 } },
    ], project: { pin: TOWER } },
  // パネル表：地物の絞り込み（北品川の辺り）。印は、タイルで高架でも地下でもない線路と道路が交わる所・道路のトンネル
  { ...base, out: 'design/crop-d-filter.png', width: 450, height: 204, center: [139.7363, 35.622624], zoom: 14.75,
    flavorOverrides: { ...flavorOverrides, railway: '#8E8E89' },
    sources: { range: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[139.7373, 35.62155], [139.7413, 35.62155], [139.7413, 35.62465], [139.7373, 35.62465], [139.7373, 35.62155]]] } } },
    layers: [
      { id: 'range-fill', type: 'fill', source: 'range', paint: { 'fill-color': C.accent, 'fill-opacity': 0.05 } },
      { id: 'range-line', type: 'line', source: 'range', paint: { 'line-color': C.accentDeep, 'line-width': 1.5, 'line-dasharray': [3, 2] } },
    ],
    project: { rl: [139.7373, 35.62465], x1: [139.739485, 35.621747], x2: [139.739189, 35.623538], x3: [139.739122, 35.624305], t1: [139.739528, 35.62405], t2: [139.739013, 35.623845], t3: [139.73817, 35.623684] } },
  // パネル表：書き出しのプレビュー・共有リンクの画面
  { ...base, out: 'design/crop-d-export.png', width: 434, height: 132, sources: routeSources, layers: routeLayers.filter(l => !l.id.startsWith('unk')),
    fit: { bounds: [[139.7372, 35.628], [139.7472, 35.6596]], padding: { top: 10, right: 20, bottom: 10, left: 20 } }, project: a.project },
  { ...base, out: 'design/crop-d-share.png', width: 254, height: 248, sources: routeSources, layers: routeLayers.filter(l => !l.id.startsWith('unk')),
    fit: { bounds: [[139.7372, 35.628], [139.7472, 35.6596]], padding: { top: 40, right: 32, bottom: 86, left: 8 } }, project: a.project },
];
fs.writeFileSync(path.join(D, 'spec-d.json'), JSON.stringify({ shots }));
console.log('wrote design/spec-d.json');
