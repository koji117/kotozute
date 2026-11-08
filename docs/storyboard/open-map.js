// 冒頭の「いつもの地図アプリ」の地図。例1の録画のルート（events.json）を自前の地図で描く → ~/kotozute-video/open-map.png
// 使い方（docs/storyboard で）：node open-map.js。kotozute のサーバ（:8787）が動いていること（mapshot.js と同じ）。make.sh が render の前に回す
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const FLAVOR = require('./flavor.js');

const OUT = process.env.VIDEO_OUT ?? path.join(os.homedir(), 'kotozute-video');
const E = JSON.parse(fs.readFileSync(process.env.EVENTS ?? path.join(OUT, 'events.json'), 'utf8'));
const r = E.results['s3-ex1'].steps.find((s) => s.op === 'route' && s.ok).output;
const C = { teal: '#0B6E78', sumi: '#12343B', white: '#FFFFFF' }; // 案E の色
const line = r.legs.flatMap((l, i) => (i ? l.shape.slice(1) : l.shape));
const pts = (list) => ({ type: 'FeatureCollection', features: list.map(([c, p]) => ({ type: 'Feature', properties: p ?? {}, geometry: { type: 'Point', coordinates: c } })) });
const spec = { shots: [{
  out: path.join(OUT, 'open-map.png'), width: 1280, height: 640, dpr: 1.5, flavor: 'light', flavorOverrides: FLAVOR, center: [139.74, 35.64], zoom: 13,
  // 左は予定のパネル（幅 420px）、上は検索の欄
  fitPoints: { points: line, padding: { top: 70, bottom: 50, left: 520, right: 90 } },
  sources: {
    route: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } },
    here: pts([[r.from.coord]]), dest: pts([[r.to.coord, { name: r.to.name ?? '' }]]),
    stops: pts(r.stops.map((s, i) => [s.chosen.coord, { n: String(i + 1) }])),
  },
  layers: [
    { id: 'route-casing', type: 'line', source: 'route', paint: { 'line-color': C.white, 'line-width': 10 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
    { id: 'route-line', type: 'line', source: 'route', paint: { 'line-color': C.teal, 'line-width': 6 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
    { id: 'here', type: 'circle', source: 'here', paint: { 'circle-radius': 8, 'circle-color': C.teal, 'circle-stroke-color': C.white, 'circle-stroke-width': 3 } },
    { id: 'dest', type: 'circle', source: 'dest', paint: { 'circle-radius': 10, 'circle-color': C.sumi, 'circle-stroke-color': C.white, 'circle-stroke-width': 3 } },
    { id: 'dest-t', type: 'symbol', source: 'dest', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 16, 'text-anchor': 'left', 'text-offset': [1.1, 0], 'text-allow-overlap': true }, paint: { 'text-color': C.sumi, 'text-halo-color': C.white, 'text-halo-width': 2 } },
    { id: 'stops-c', type: 'circle', source: 'stops', paint: { 'circle-radius': 11, 'circle-color': C.sumi, 'circle-stroke-color': C.white, 'circle-stroke-width': 2.5 } },
    { id: 'stops-t', type: 'symbol', source: 'stops', layout: { 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Medium'], 'text-size': 13, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': C.white } },
  ],
}] };
const f = path.join(OUT, 'open-map.spec.json');
fs.writeFileSync(f, JSON.stringify(spec));
execFileSync(process.execPath, [path.join(__dirname, 'mapshot.js'), f], { stdio: 'inherit', cwd: __dirname });
