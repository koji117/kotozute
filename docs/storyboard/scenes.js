// 絵コンテの地図の場面を、data/ex1.json・data/ex2.json から自前の地図で描く。
// 使い方（docs/storyboard で）：node scenes.js  → maps/*.png と maps/pos.js
//   kotozute のサーバ（:8787）が動いていること。デザインは案E（design/option-e.html）に合わせる。
const fs = require('fs');
const { execFileSync } = require('child_process');

const ex1 = JSON.parse(fs.readFileSync('data/ex1.json', 'utf8'));
const ex2 = JSON.parse(fs.readFileSync('data/ex2.json', 'utf8'));
// 地図の色：地図アプリでよく使われる配色（青い水、緑の公園、白い道、暖色の幹線）。特定の会社の配色はまねない
const FLAVOR = {
  background: '#F2F1EE', earth: '#F2F1EE', water: '#AAD3F2', buildings: '#E4E1DB', other: '#F6F5F2', pedestrian: '#F7F6F3',
  park_a: '#CFEBC2', park_b: '#C2E4B3', wood_a: '#CFEBC2', wood_b: '#C2E4B3', scrub_a: '#D6EDCB', scrub_b: '#CBE6BE', zoo: '#CFEBC2',
  hospital: '#F6E4E4', school: '#F1EBDD', industrial: '#ECEAE6', military: '#ECEAE6', aerodrome: '#E9ECEF', sand: '#F1ECDD', beach: '#F1ECDD',
  minor_a: '#FFFFFF', minor_b: '#FFFFFF', minor_service: '#FFFFFF', link: '#FFF1BF', major: '#FFFFFF', highway: '#FFD877',
  minor_casing: '#DCD9D2', minor_service_casing: '#DCD9D2', link_casing: '#E8CF86', major_casing_early: '#D6D2CA', major_casing_late: '#D6D2CA',
  highway_casing_early: '#E2B24C', highway_casing_late: '#E2B24C', railway: '#A3A6AA', boundaries: '#B7B4AE',
  city_label: '#3B4146', city_label_halo: '#FFFFFF', subplace_label: '#6B7177', subplace_label_halo: '#FFFFFF',
  roads_label_major: '#5E656B', roads_label_major_halo: '#FFFFFF', roads_label_minor: '#737A80', roads_label_minor_halo: '#FFFFFF',
  address_label: '#7A8187', address_label_halo: '#FFFFFF', ocean_label: '#4F7FA8',
};
fs.mkdirSync('maps', { recursive: true });

// 案E の色（design/option-e.html の :root と同じ）
const C = { teal: '#0B6E78', sumi: '#12343B', white: '#FFFFFF', unk: '#E2A52E', gray: '#7D868C', ng: '#B3261E' };
const line = (coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } });
const points = (list) => ({ type: 'FeatureCollection', features: list.map(([c, p = {}]) => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: c } })) });
const mid = (cs) => cs[Math.floor(cs.length / 2)];
// 半径 r m の円（精度の円）
const circle = ([lng, lat], r) => {
  const k = r / 111320, ring = [];
  for (let i = 0; i <= 48; i++) { const a = (i / 48) * 2 * Math.PI; ring.push([lng + (k * Math.cos(a)) / Math.cos((lat * Math.PI) / 180), lat + k * Math.sin(a)]); }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
};
const bounds = (cs) => [[Math.min(...cs.map((c) => c[0])), Math.min(...cs.map((c) => c[1]))], [Math.max(...cs.map((c) => c[0])), Math.max(...cs.map((c) => c[1]))]];

// レイヤの部品
const routeLayers = (id, color = C.teal, w = 6) => [
  { id: `${id}-shadow`, type: 'line', source: id, paint: { 'line-color': '#0A1419', 'line-opacity': 0.12, 'line-width': w + 10, 'line-blur': 4 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
  { id: `${id}-casing`, type: 'line', source: id, paint: { 'line-color': C.white, 'line-width': w + 4 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
  { id: `${id}-line`, type: 'line', source: id, paint: { 'line-color': color, 'line-width': w }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
];
const tunnelLayers = (id) => [
  { id: `${id}-tube`, type: 'line', source: id, paint: { 'line-color': C.sumi, 'line-width': 12 }, layout: { 'line-cap': 'round' } },
  { id: `${id}-core`, type: 'line', source: id, paint: { 'line-color': C.white, 'line-width': 3, 'line-dasharray': [1.2, 1.2] }, layout: { 'line-cap': 'butt' } },
];
const dotLayer = (id, color, r = 7, stroke = C.white) => ({ id, type: 'circle', source: id, paint: { 'circle-radius': r, 'circle-color': color, 'circle-stroke-color': stroke, 'circle-stroke-width': 3 } });
const numLayers = (id, color) => [
  { id: `${id}-c`, type: 'circle', source: id, paint: { 'circle-radius': 12, 'circle-color': color, 'circle-stroke-color': C.white, 'circle-stroke-width': 2.5 } },
  { id: `${id}-t`, type: 'symbol', source: id, layout: { 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Medium'], 'text-size': 14, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': C.white } },
];
// 下の地図の地名が札の下に隠れないよう、見えない文字で場所を取る
const blocker = (id, size = 34) => ({ id: `${id}-blk`, type: 'symbol', source: id, layout: { 'text-field': 'MMMM', 'text-font': ['Noto Sans Medium'], 'text-size': size, 'text-allow-overlap': true }, paint: { 'text-opacity': 0 } });

const shots = [];
const shot = (name, o) => shots.push({ out: `maps/${name}.png`, width: o.width ?? 1280, height: o.height ?? 640, dpr: 2, flavor: 'light', flavorOverrides: FLAVOR, center: [139.74, 35.64], zoom: 13, ...o });

// ===== 例1：現在地 → 郵便局 → 手土産の店 → 客先 =====
const here = ex1.here.coord, dest = ex1.destination.pin;
const stops = ex1.chosen.stops ?? [];
const legs = ex1.route.legs;
const routeCs = legs.flatMap((l, i) => (i ? l.shape.coordinates.slice(1) : l.shape.coordinates));
const po = ex1.candidates.post_office.slice(0, 4), sv = ex1.candidates.souvenir.slice(0, 4); // 候補は寄り道の時間が少ない順に4件ずつ見せる
const stopCs = legs.slice(0, -1).map((l) => l.shape.coordinates[l.shape.coordinates.length - 1]);
const ex1All = [here, dest, ...routeCs, ...po.map((c) => c.coord), ...sv.map((c) => c.coord)];
// 全画面で見たときに収まるように描く。シートが上がる場面では、絵コンテ側で地図を上へ寄せて縮める（data-cam）
// 左に結果のパネル（幅 440px）があるので、地図はその右側と上下に収める
const BAND = { top: 86, bottom: 70, left: 500, right: 70 };
const ex1Cam = { bearing: -80, fitPoints: { points: ex1All, padding: BAND } };
const ex1Proj = { here, dest, s1: stopCs[0], s2: stopCs[1], ...Object.fromEntries(po.map((c, i) => [`po${i}`, c.coord])), ...Object.fromEntries(sv.map((c, i) => [`sv${i}`, c.coord])),
  l0: mid(legs[0].shape.coordinates), l1: mid(legs[1].shape.coordinates), l2: mid(legs[2].shape.coordinates) };
const hereSrc = { here: points([[here]]), acc: circle(here, ex1.here.accuracy_m) };
const hereLayers = [
  { id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': C.teal, 'fill-opacity': 0.14 } },
  { id: 'acc-line', type: 'line', source: 'acc', paint: { 'line-color': C.teal, 'line-width': 1.5, 'line-opacity': 0.6 } },
  dotLayer('here', C.teal, 8), blocker('here'),
];
const destSrc = { dest: points([[dest]]) };
const destLayers = [dotLayer('dest', C.sumi, 9), blocker('dest')];
shot('ex1-1-here', { ...ex1Cam, sources: { ...hereSrc }, layers: [...hereLayers], project: ex1Proj });
shot('ex1-2-dest', { ...ex1Cam, sources: { ...hereSrc, ...destSrc }, layers: [...hereLayers, ...destLayers], project: ex1Proj });
shot('ex1-3-cand', { ...ex1Cam,
  sources: { ...hereSrc, ...destSrc, direct: line(ex1.direct.shape.coordinates), cpo: points(po.map((c, i) => [c.coord, { n: String(i + 1) }])), csv: points(sv.map((c, i) => [c.coord, { n: String(i + 1) }])) },
  layers: [{ id: 'direct', type: 'line', source: 'direct', paint: { 'line-color': C.gray, 'line-width': 3, 'line-dasharray': [2, 1.5] }, layout: { 'line-cap': 'round' } },
    ...hereLayers, ...destLayers, ...numLayers('cpo', C.teal), ...numLayers('csv', '#8A5A00')], project: ex1Proj });
shot('ex1-4-route', { ...ex1Cam,
  sources: { ...hereSrc, ...destSrc, route: line(routeCs), stops: points(stopCs.map((c, i) => [c, { n: String(i + 1) }])) },
  layers: [...routeLayers('route'), ...hereLayers, ...destLayers, ...numLayers('stops', C.sumi), blocker('stops')], project: ex1Proj });
// 共有リンクを別のブラウザで開いたところ（北が上、小さめ）
shot('ex1-5-share', { width: 640, height: 400, fit: { bounds: bounds([here, dest, ...routeCs]), padding: 36 },
  sources: { ...hereSrc, ...destSrc, route: line(routeCs), stops: points(stopCs.map((c, i) => [c, { n: String(i + 1) }])) },
  layers: [...routeLayers('route', C.teal, 5), ...hereLayers, ...destLayers, ...numLayers('stops', C.sumi)], project: { here, dest, s1: stopCs[0], s2: stopCs[1] } });

// ===== 例1の前：いつもの操作（札を押す）＋日本語（「芝公園のあたりを大きく。郵便局だけ残して」） =====
// 例1と同じ範囲・向き。札で出す地物は辞書と同じタグ（data/build-nl.js）
const nl = JSON.parse(fs.readFileSync('data/nl.json', 'utf8'));
const pk = nl.shiba_park;
const nlPo = points(nl.post_office.map((p) => [p.coord])), nlSv = points(nl.souvenir.map((p) => [p.coord]));
const nlProj = { pk: pk.center, ...Object.fromEntries(nl.post_office.map((p, i) => [`po${i}`, p.coord])), ...Object.fromEntries(nl.souvenir.map((p, i) => [`sv${i}`, p.coord])) };
const poL = (r) => dotLayer('npo', C.teal, r), svL = (r) => dotLayer('nsv', '#8A5A00', r);
shot('nl-0-base', { ...ex1Cam, project: nlProj });
shot('nl-0-po', { ...ex1Cam, sources: { npo: nlPo }, layers: [poL(5)] });
shot('nl-0-all', { ...ex1Cam, sources: { npo: nlPo, nsv: nlSv }, layers: [svL(5), poL(5)] });
const [[w0, s0], [e0, n0]] = pk.bounds;
shot('nl-1-zoom', { bearing: -80, fitPoints: { points: [[w0, s0], [w0, n0], [e0, s0], [e0, n0]], padding: { top: 130, bottom: 110, left: 560, right: 130 }, maxZoom: 16 },
  sources: { npo: nlPo }, layers: [poL(8)], project: nlProj });

// ===== 例2：試走コース =====
const sb = ex2.scene_b;
const [a1, a2] = ex2.attempts;
const start = ex2.start.snapped?.coord ?? ex2.start.route_point;
const BAND2 = BAND;
const featFit = { points: [...sb.level_crossing_groups.map((g) => g.coord), ...sb.road_tunnels.flatMap((t) => t.coordinates)], padding: BAND2, maxZoom: 16.5 };
shot('ex2-0-base', { fitPoints: featFit, sources: {}, layers: [] }); // 結果を出す前の同じ範囲
shot('ex2-1-feat', { fitPoints: featFit,
  sources: { tun: { type: 'FeatureCollection', features: sb.road_tunnels.map((t) => line(t.coordinates)) },
    xing: points(sb.level_crossing_groups.map((g) => [g.coord])), xped: points(sb.excluded_crossings.map((g) => [g.coord])) },
  layers: [...tunnelLayers('tun'), dotLayer('xped', '#9AA3A9', 5), dotLayer('xing', C.ng, 9), blocker('xing', 28)],
  project: { ...Object.fromEntries(sb.level_crossing_groups.map((g, i) => [`x${i}`, g.coord])), ...Object.fromEntries(sb.road_tunnels.map((t, i) => [`t${i}`, mid(t.coordinates)])) } });
const ex2Cam = { bearing: 0, fitPoints: { points: [...a1.shape, ...a2.shape], padding: BAND2 } };
const runs = ex2.lanes_check.runs;
const ex2Proj = { start, a1t0: mid(a1.tunnel_runs[0].coordinates), a2t0: mid(a2.tunnel_runs[0].coordinates), a2t1: mid(a2.tunnel_runs[1].coordinates), ...Object.fromEntries(runs.map((r, i) => [`u${i}`, mid(r.coordinates)])) };
const startSrc = { start: points([[start]]) };
const startLayers = [dotLayer('start', C.white, 9, C.sumi), blocker('start')];
shot('ex2-2-base', { ...ex2Cam, sources: { ...startSrc }, layers: [...startLayers], project: ex2Proj });
shot('ex2-2-try1', { ...ex2Cam, sources: { r: line(a1.shape), t: { type: 'FeatureCollection', features: a1.tunnel_runs.map((t) => line(t.coordinates)) }, ...startSrc },
  layers: [...routeLayers('r', C.teal, 5), ...tunnelLayers('t'), ...startLayers], project: ex2Proj });
shot('ex2-3-try2', { ...ex2Cam, sources: { u: { type: 'FeatureCollection', features: runs.map((r) => line(r.coordinates)) }, r: line(a2.shape), t: { type: 'FeatureCollection', features: a2.tunnel_runs.map((t) => line(t.coordinates)) }, ...startSrc },
  layers: [{ id: 'u-halo', type: 'line', source: 'u', paint: { 'line-color': C.unk, 'line-width': 16, 'line-opacity': 0.75 }, layout: { 'line-cap': 'round' } }, ...routeLayers('r', C.teal, 5), ...tunnelLayers('t'), ...startLayers], project: ex2Proj });
// 書き出す画像の地図部分（北が上）
shot('ex2-4-export', { width: 760, height: 430, fitPoints: { points: a2.shape, padding: { top: 84, bottom: 74, left: 40, right: 40 } }, // 題の札と出典の帯の分を空ける
  sources: { r: line(a2.shape), t: { type: 'FeatureCollection', features: a2.tunnel_runs.map((t) => line(t.coordinates)) }, ...startSrc },
  layers: [...routeLayers('r', C.teal, 5), ...tunnelLayers('t'), ...startLayers], project: { start, a2t0: ex2Proj.a2t0, a2t1: ex2Proj.a2t1 } });

fs.writeFileSync('maps/spec.json', JSON.stringify({ shots }));
execFileSync('node', ['mapshot.js', 'maps/spec.json'], { stdio: 'inherit' });
const pos = Object.fromEntries(shots.map((s) => { const j = JSON.parse(fs.readFileSync(s.out.replace(/\.png$/, '.json'), 'utf8')); return [s.out.slice(5, -4), j.points]; }));
fs.writeFileSync('maps/pos.js', `// scenes.js が書く。地図の上の札の位置（CSS px）\nwindow.POS = ${JSON.stringify(pos)};\n`);
console.log('wrote maps/pos.js');
