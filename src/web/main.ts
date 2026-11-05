// 画面：地図アプリでおなじみの配置（左上の検索、カテゴリの札、左の結果パネル、右下の地図ボタン）。
// 地図の上の印はすべて GeoJSON レイヤで描く（DOM のマーカーは画像の書き出しに写らない）。
// フォントは自前で配信する（@fontsource を vite が同梱する）。
import '@fontsource/m-plus-1/400.css';
import '@fontsource/m-plus-1/500.css';
import '@fontsource/m-plus-1/700.css';
import '@fontsource/m-plus-1/800.css';
import '@fontsource/noto-sans-mono/400.css';
import '@fontsource/noto-sans-mono/500.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';
import type { Feature as F } from 'geojson';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { ATTRIBUTION, attributionParts, dataAsOfText } from '../attribution';
import { CHIPS, DICT, type DictKey } from '../ops/dict';
import type {
  AddPinOutput, BBox, ChatResponse, CheckRouteOutput, ContextResponse, CourseOutput, ExportRouteOutput, FindFeaturesOutput, GeocodeOutput,
  LngLat, OpResult, Place, RecipeRunResponse, RecipeSaved, RouteOutput, SearchPlaceOutput, Session, SetViewOutput, ShareState, TunnelRun,
} from '../ops/types';
import type { NoteDraftOutput } from '../ops/draft_osm_note';
import {
  CHIP_ICON, COLOR, html, nm, type Raw, recipeCard, renderChat, renderDirect, renderError, renderRecipe, renderWait, stepHtml,
} from './panel';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const C = { teal: '#0B6E78', sumi: '#12343B', white: '#FFFFFF', gray: '#7D868C', text: '#161B1F', pin: '#B3261E' };

// 地図の配色（docs/storyboard/scenes.js の FLAVOR）：青い水、緑の公園、白い道、暖色の幹線
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

// ===== 状態（画面に出しているもの） =====
const st = {
  feat: new Map<DictKey, Place[]>(),
  visible: new Set<DictKey>(),
  route: undefined as RouteOutput | undefined,
  tunnels: [] as TunnelRun[], // 合否表で数えたトンネル（地図に名前を出す）
  pins: [] as { place: Place; n: string }[], // 住所と場所の検索の結果
  pinned: [] as Place[], // add_pin で立てたピン（サーバの session.pins と同じ並び）。新しい依頼でも消さない
  here: undefined as Session['here'],
  clicks: [] as { coord: LngLat; n: string }[],
};
/** 札で出した結果（言葉ごと）。パネルにまとめて出す */
const chipSteps = new Map<DictKey, OpResult>();
const shareId = new URLSearchParams(location.search).get('s');
/** ?png=1：export_png（MCP）がサーバから headless で開き、出典を焼き込んだ画像を window.kotozutePng で受け取る */
const pngMode = new URLSearchParams(location.search).get('png') === '1';
/** /?r=<id>：保存したレシピを、この画面の新しいセッションで再実行する */
const recipeId = new URLSearchParams(location.search).get('r');
/** 共有リンクを作ったときの OSM のデータ時点（共有の画面だけ） */
let shareOsmAsOf: string | undefined;
/** レシピの再実行の途中。結果の番号（result:N）がずれないよう、そのあいだは札・検索・クリック・現在地を受けない */
let replaying = false;

// 読み込むたびに新しいセッションにする。前の画面の結果が共有リンクに混ざらないように
const sessionId = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// ===== 地図 =====
// MapLibre 6 は既定だと自分の隣の maplibre-gl-worker.mjs を読むが、vite の同梱ではそこに置かれない。vite に worker として束ねさせる
maplibregl.setWorkerUrl(workerUrl);
maplibregl.addProtocol('pmtiles', new Protocol().tile);
const origin = location.origin;
const map = new maplibregl.Map({
  container: 'map',
  // 始めは都心（札で探せる広さ。範囲の上限は LIMITS.max_bbox_km2）
  center: [139.752, 35.668],
  zoom: 13.5,
  maxBounds: [[138.9, 35.48], [139.95, 35.92]], // tokyo.pmtiles の切り出し範囲
  attributionControl: false, // 出典は右下に自前で出し、書き出す画像にも描き込む
  canvasContextAttributes: { preserveDrawingBuffer: true }, // 画像の書き出しに必要
  style: {
    version: 8,
    glyphs: `${origin}/assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/assets/sprites/v4/light`,
    sources: { protomaps: { type: 'vector', url: `pmtiles://${origin}/tiles/tokyo.pmtiles` } },
    // landcover は ESA WorldCover（CC BY 4.0）由来なので外す
    layers: layers('protomaps', { ...namedFlavor('light'), ...FLAVOR }, { lang: 'ja' })
      .filter((l) => !('source-layer' in l && l['source-layer'] === 'landcover')),
  },
});
Object.assign(window, { map, sessionId }); // 確認用（scripts/check-web.mjs）

const pt = (c: LngLat, p: Record<string, string> = {}): F => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: c } });
/** 半径 r m の円（現在地の精度） */
function circle([lng, lat]: LngLat, r: number): F {
  const k = r / 111320, ring: LngLat[] = [];
  for (let i = 0; i <= 48; i++) { const a = (i / 48) * 2 * Math.PI; ring.push([lng + (k * Math.cos(a)) / Math.cos((lat * Math.PI) / 180), lat + k * Math.sin(a)]); }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/** 名前の札の背景（角の丸い四角。icon-text-fit で文字に合わせて伸ばす） */
function pill(color: string): ImageData {
  const g = document.createElement('canvas').getContext('2d')!;
  g.canvas.width = g.canvas.height = 32;
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(0, 0, 32, 32, 12);
  g.fill();
  return g.getImageData(0, 0, 32, 32);
}

const halo = { 'text-color': C.text, 'text-halo-color': C.white, 'text-halo-width': 1.6 };
const OVERLAY: maplibregl.LayerSpecification[] = [
  { id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': C.teal, 'fill-opacity': 0.14 } },
  { id: 'acc-line', type: 'line', source: 'acc', paint: { 'line-color': C.teal, 'line-width': 1.5, 'line-opacity': 0.6 } },
  { id: 'route-casing', type: 'line', source: 'route', paint: { 'line-color': C.white, 'line-width': 10 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
  { id: 'route-line', type: 'line', source: 'route', paint: { 'line-color': C.teal, 'line-width': 6 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
  // 数えたトンネル：ルートの上に縞の線と名前
  { id: 'tun-line', type: 'line', source: 'tun', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': C.sumi, 'line-width': 10 }, layout: { 'line-join': 'round' } },
  { id: 'tun-dash', type: 'line', source: 'tun', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': C.white, 'line-width': 3, 'line-dasharray': [1.5, 1.5] } },
  { id: 'tun-t', type: 'symbol', source: 'tun', filter: ['==', ['geometry-type'], 'Point'], layout: {
    'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-anchor': 'left', 'text-offset': [1.4, 0], 'text-allow-overlap': true,
    'icon-image': 'pill', 'icon-text-fit': 'both', 'icon-text-fit-padding': [3, 8, 3, 8], 'icon-allow-overlap': true,
  }, paint: { 'text-color': '#F2F5F6' } },
  { id: 'feat-c', type: 'circle', source: 'feat', paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': C.white, 'circle-stroke-width': 2 } },
  { id: 'feat-t', type: 'symbol', source: 'feat', minzoom: 14, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, 0.8], 'text-optional': true }, paint: halo },
  { id: 'marks-c', type: 'circle', source: 'marks', paint: { 'circle-radius': 12, 'circle-color': ['get', 'color'], 'circle-stroke-color': C.white, 'circle-stroke-width': 2.5 } },
  { id: 'marks-n', type: 'symbol', source: 'marks', layout: { 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Medium'], 'text-size': 13, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': C.white } },
  { id: 'marks-t', type: 'symbol', source: 'marks', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Medium'], 'text-size': 13, 'text-anchor': 'left', 'text-offset': [1.3, 0], 'text-optional': true }, paint: halo },
  { id: 'here-c', type: 'circle', source: 'here', paint: { 'circle-radius': 8, 'circle-color': C.teal, 'circle-stroke-color': C.white, 'circle-stroke-width': 3 } },
  { id: 'here-t', type: 'symbol', source: 'here', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Medium'], 'text-size': 13, 'text-anchor': 'bottom', 'text-offset': [0, -1.2], 'text-allow-overlap': true }, paint: { ...halo, 'text-color': '#085862' } },
];
let loaded = false;
map.on('load', () => {
  for (const id of ['acc', 'route', 'tun', 'feat', 'marks', 'here']) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addImage('pill', pill(C.sumi), { pixelRatio: 2, stretchX: [[12, 20]], stretchY: [[12, 20]], content: [8, 8, 24, 24] });
  OVERLAY.forEach((l) => map.addLayer(l));
  loaded = true;
  draw();
  if (shareId) {
    const opened = loadShare(shareId);
    if (pngMode) Object.assign(window, { kotozutePng: opened.then(async (ok) => {
      if (!ok) throw new Error('共有された地図を開けません');
      await idle();
      return (await pngCanvas()).toDataURL('image/png');
    }) });
  }
  else if (recipeId) runRecipe(recipeId); // セッションは再実行が作り直す
  // 読み込み直した画面には現在地を出していないので、サーバに残った現在地も消す
  else api('/api/context', { sessionId, here: null, view: viewNow() }).catch(() => {});
});

const usedAttribution = () => {
  const r = st.route;
  const places = [...st.pins.map((p) => p.place), ...st.pinned, ...(r ? [r.from, r.to, ...r.stops.map((s) => s.chosen)] : [])];
  return { route: !!r, address: places.some((p) => p.kind === 'address') };
};

/** 状態を地図のレイヤと出典に写す */
function draw() {
  renderAttr();
  document.body.classList.toggle('has-route', !!st.route); // パネルの「GPX（社内用）」はルートがあるときだけ
  for (const b of $('#chips').querySelectorAll<HTMLButtonElement>('.chip')) b.setAttribute('aria-pressed', String(st.visible.has(b.dataset.word as DictKey)));
  if (!loaded) return;
  const set = (id: string, features: F[]) => (map.getSource(id) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features });
  set('feat', [...st.visible].flatMap((w) => (st.feat.get(w) ?? []).map((p) => pt(p.coord, { color: COLOR[w], name: p.name ?? '' }))));
  const r = st.route;
  set('route', r ? r.legs.map((l): F => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l.shape } })) : []);
  set('tun', st.tunnels.flatMap((t): F[] => [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: t.line } },
    pt(t.mid, { name: t.name ?? 'トンネル' }),
  ]));
  const marks: F[] = [];
  if (r) {
    const loop = r.from.ref === r.to.ref; // 試走コース（出発地に戻る）は印を1つにする
    if (!loop && (r.from.kind !== 'here' || !st.here)) marks.push(pt(r.from.coord, { n: '出', label: nm(r.from), color: C.sumi }));
    // 経由地のトンネルの名前は、トンネルの札（tun-t）に出すので重ねない
    r.stops.forEach((s, i) => marks.push(pt(s.chosen.coord, { n: String(i + 1), label: s.chosen.kind === 'tunnel' && st.tunnels.length ? '' : nm(s.chosen), color: C.sumi })));
    marks.push(pt(r.to.coord, loop ? { n: '発', label: `${nm(r.to)}（出発・到着）`, color: C.sumi } : { n: '終', label: nm(r.to), color: C.sumi }));
  }
  const onRoute = new Set(r ? [r.from, r.to, ...r.stops.map((s) => s.chosen)].map((p) => p.ref) : []);
  const pinned = new Set(st.pinned.map((p) => p.ref));
  for (const { place, n } of st.pins) if (!onRoute.has(place.ref) && !pinned.has(place.ref)) marks.push(pt(place.coord, { n, label: nm(place), color: place.kind === 'address' ? C.sumi : C.teal }));
  for (const p of st.pinned) if (!onRoute.has(p.ref)) marks.push(pt(p.coord, { n: '', label: nm(p), color: C.pin })); // 自前のフォントに ★ などの記号がないので、赤い丸だけ
  for (const c of st.clicks) marks.push(pt(c.coord, { n: c.n, label: `クリック${c.n}`, color: C.gray }));
  set('marks', marks);
  set('here', st.here ? [pt(st.here.coord, { label: `現在地 半径${st.here.accuracy_m}m` })] : []);
  set('acc', st.here ? [circle(st.here.coord, st.here.accuracy_m)] : []);
}

function renderAttr() {
  const parts = attributionParts(usedAttribution());
  $('#attr').innerHTML = html`${parts.map((p, i) => html`${i ? html`<span class="sep">｜</span>` : ''}<a href="${p.url}" target="_blank" rel="noopener">${p.text}</a>`)}<br>${dataAsOfText(shareOsmAsOf)}`.s;
}

// ===== カメラ =====
const mobile = () => matchMedia('(max-width: 767px)').matches;
function fit(cs: LngLat[]) {
  if (!cs.length) return;
  const b = new maplibregl.LngLatBounds(cs[0], cs[0]);
  cs.forEach((c) => b.extend(c));
  const panel = $('#panel');
  const padding = mobile()
    ? { top: 150, right: 40, bottom: (panel.hidden ? 0 : panel.offsetHeight) + 40, left: 40 }
    : { top: 110, right: 80, bottom: 140, left: shareId ? 80 : 16 + 440 + 40 }; // 下は右下の札と出典の分
  map.fitBounds(b, { padding, maxZoom: 16, duration: 700 });
}
const boxPts = ([w, s, e, n]: BBox): LngLat[] => [[w, s], [e, n]];

/** 操作の結果を状態に入れる。最後に動かすべき範囲を返す */
function apply(steps: OpResult[]): LngLat[] {
  let cam: LngLat[] = [];
  for (const s of steps) {
    if (!s.ok) continue;
    if (s.op === 'geocode_address') {
      const o = s.output as GeocodeOutput;
      st.pins.push({ place: o.place, n: '住' });
      cam = [o.place.coord];
    } else if (s.op === 'find_features') {
      const o = s.output as FindFeaturesOutput;
      for (const g of o.groups) { st.feat.set(g.word, g.items); st.visible.add(g.word); }
      if (o.area.ref !== 'view:') cam = boxPts(o.area.bbox);
    } else if (s.op === 'search_place') {
      const o = s.output as SearchPlaceOutput;
      st.pins = st.pins.filter((p) => p.place.kind === 'address');
      o.items.forEach((p, i) => st.pins.push({ place: p, n: String(i + 1) }));
      if (o.items.length) cam = o.items.map((p) => p.coord);
    } else if (s.op === 'route') {
      st.route = s.output as RouteOutput;
      st.tunnels = [];
      cam = st.route.legs.flatMap((l) => l.shape);
    } else if (s.op === 'plan_course') {
      const o = s.output as CourseOutput;
      st.route = o.course;
      st.tunnels = o.attempts[o.chosen ?? o.attempts.length - 1].check.tunnels.filter((t) => !t.skip);
      cam = o.course.legs.flatMap((l) => l.shape);
    } else if (s.op === 'check_route') {
      st.tunnels = (s.output as CheckRouteOutput).tunnels.filter((t) => !t.skip);
      cam = st.route?.legs.flatMap((l) => l.shape) ?? [];
    } else if (s.op === 'add_pin') {
      const o = s.output as AddPinOutput;
      if (!st.pinned.some((p) => p.ref === o.pin.ref)) st.pinned.push(o.pin);
      cam = [o.pin.coord];
    } else if (s.op === 'set_view') {
      const o = s.output as SetViewOutput;
      o.shown.forEach((w) => st.visible.add(w));
      o.hidden.forEach((w) => st.visible.delete(w));
      if (o.target) cam = boxPts(o.bbox); // target が view:（null）なら地図は動かさない
    } else if (s.op === 'draft_osm_note') {
      cam = [(s.output as NoteDraftOutput).target.coord];
    }
  }
  draw();
  return cam;
}

// ===== サーバとのやりとり =====
async function api<T>(path: string, body?: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  } catch { throw new Error('サーバに接続できません'); }
  const j = await res.json().catch(() => null);
  // 操作の失敗（ok:false）やチャットの結果は、HTTP の状態にかかわらずそのまま返す
  if (!res.ok && !(j && (j.op || j.steps))) {
    const m = j?.error?.message ?? j?.error;
    throw new Error(typeof m === 'string' ? m : 'サーバに接続できません');
  }
  return j as T;
}
const viewNow = (): Session['view'] => {
  const b = map.getBounds();
  return { bbox: [r6(b.getWest()), r6(b.getSouth()), r6(b.getEast()), r6(b.getNorth())], zoom: Math.round(map.getZoom() * 100) / 100 };
};
const sendView = () => api('/api/context', { sessionId, view: viewNow() }).catch(() => {});
let viewTimer = 0;
map.on('moveend', () => {
  if (shareId) return;
  clearTimeout(viewTimer);
  viewTimer = window.setTimeout(sendView, 400);
});

// ===== パネル =====
const panel = $('#panel');
function show(content: Raw, mode = '') {
  panel.innerHTML = content.s;
  panel.dataset.mode = mode; // 'direct' は札の結果
  panel.hidden = false;
  panel.scrollTop = 0;
  panel.querySelectorAll<HTMLElement>('.ncard').forEach((c) => noteCheck(c)); // 場所の名前に止める語があれば、すぐ出す
}
// スマホでは下部シートの高さだけ、右下の札とボタンを上げる
new ResizeObserver(() => document.documentElement.style.setProperty('--sheet-h', `${panel.hidden ? 0 : panel.offsetHeight}px`)).observe(panel);

let toastTimer = 0;
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 5000);
}

panel.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'close') panel.hidden = true;
  if (b.dataset.act === 'png') exportPng();
  if (b.dataset.act === 'share') shareLink(b);
  if (b.dataset.act === 'gpx') gpxFile(b);
  if (b.dataset.act === 'recipe') saveRecipe(b);
  if (b.dataset.act === 'copy') copy(b.parentElement!.querySelector('input')!);
  if (b.dataset.act === 'note-copy') noteCopy(b.closest('.ncard')!);
});

async function shareLink(b: HTMLButtonElement) {
  b.disabled = true;
  try {
    const r = await api<OpResult>('/api/op/make_share_link', { sessionId, input: {}, view: viewNow() });
    panel.querySelector('.foot')?.insertAdjacentHTML('beforebegin', stepHtml(r).s); // 待つ間にパネルが替わっていたら出さない
    [...panel.querySelectorAll('.share input')].at(-1)?.scrollIntoView({ block: 'nearest' });
  } catch (err) { toast((err as Error).message); }
  b.disabled = false;
}

async function gpxFile(b: HTMLButtonElement) {
  b.disabled = true;
  try {
    const r = await api<OpResult>('/api/op/export_route', { sessionId, input: { format: 'gpx' } });
    if (r.ok) saveRoute(r.output as ExportRouteOutput);
    panel.querySelector('.foot')?.insertAdjacentHTML('beforebegin', stepHtml(r).s); // 注意（ODbL）のカード
  } catch (err) { toast((err as Error).message); }
  b.disabled = false;
}
const saveRoute = (o: ExportRouteOutput) => save(new Blob([o.content], { type: o.mime }), o.filename);
function save(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
/** 書き出しは画面で行う（ルートのファイルは Blob で保存、画像は地図が落ち着いてから作る） */
async function saveExports(steps: OpResult[]) {
  for (const s of steps) if (s.ok && s.op === 'export_route') saveRoute(s.output as ExportRouteOutput);
  if (steps.some((s) => s.ok && s.op === 'export_png')) { await idle(); await exportPng(); }
}
/** 地図の描画が落ち着くまで待つ（印の反映や、動いている途中の地図を画像に写さない） */
const idle = () => new Promise((r) => { map.once('idle', r); map.triggerRepaint(); });
// ===== レシピ：この画面で成功した操作の並びを保存する。再実行は Claude を使わない =====
async function saveRecipe(b: HTMLButtonElement) {
  b.disabled = true;
  try {
    const r = await api<RecipeSaved>('/api/recipe', { sessionId });
    panel.querySelector('.foot')?.insertAdjacentHTML('beforebegin', recipeCard(r).s);
    [...panel.querySelectorAll('.recipe')].at(-1)?.scrollIntoView({ block: 'nearest' });
  } catch (err) { toast((err as Error).message); }
  b.disabled = false;
}
async function runRecipe(id: string) {
  show(renderWait());
  replaying = true;
  try {
    const res = await api<RecipeRunResponse>(`/api/recipe/${encodeURIComponent(id)}/run`, { sessionId });
    st.clicks = res.recipe.context.clicks.map((coord, i) => ({ coord, n: String(i + 1) })); // click:N の番号どおり
    let cam = apply(res.steps);
    // 地図を動かす手順がなければ（画面の範囲で探しただけなど）、最後の手順のときの画面へ
    if (!cam.length) { const v = res.recipe.steps.findLast((s) => s.view)?.view; if (v) cam = boxPts(v.bbox); }
    show(renderRecipe(res));
    fit(cam);
    await saveExports(res.steps); // 書き出しの手順も同じようにやり直す（カードの「画像にしました」と合わせる）
  } catch (err) { show(renderError(`レシピを再実行できません：${(err as Error).message}`)); }
  replaying = false;
}

async function copy(input: HTMLInputElement | HTMLTextAreaElement, what = '共有リンク') {
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    if (!document.execCommand('copy')) return toast(`コピーできませんでした。${what}を選んでコピーしてください`);
  }
  toast(`${what}をコピーしました`);
}

// ===== OSM ノートの下書き：確認方法は本人が選ぶ。止める語（社名・「試走」など）はサーバの一覧で確かめる =====
panel.addEventListener('change', (e) => {
  const r = e.target as HTMLInputElement;
  const card = r.closest<HTMLElement>('.ncard');
  if (r.type !== 'radio' || !card) return;
  const ta = card.querySelector('textarea')!, line = `確認方法：${r.value}`, re = /^確認方法：.*$/m;
  ta.value = re.test(ta.value) ? ta.value.replace(re, () => line) : `${ta.value.trimEnd()}\n${line}`;
  noteCheck(card);
});
panel.addEventListener('input', (e) => {
  const card = (e.target as Element).closest<HTMLElement>('.ncard');
  if (card) noteCheck(card, 400);
});
const noteTimers = new WeakMap<Element, number>();
/** 確かめ終わるまでコピーは押せない。通ったときの文を覚え、コピーの前に同じ文か確かめる */
function noteCheck(card: HTMLElement, wait = 0) {
  const ta = card.querySelector('textarea')!, btn = card.querySelector<HTMLButtonElement>('[data-act=note-copy]')!, warn = card.querySelector<HTMLElement>('.nwarn')!;
  btn.disabled = true;
  delete card.dataset.ok;
  clearTimeout(noteTimers.get(card));
  noteTimers.set(card, window.setTimeout(async () => {
    const text = ta.value;
    const blocked = await api<{ blocked: string[] }>('/api/note/check', { text }).then((r) => r.blocked, () => null);
    if (ta.value !== text) return; // 待つ間に書き換わった（次の確認が動く）
    warn.hidden = !!blocked && !blocked.length;
    warn.textContent = blocked ? `入れてはいけない語があります：${blocked.join('、')}。消してからコピーしてください` : '語の確認ができません（サーバに接続できません）';
    if (!blocked || blocked.length || !card.querySelector('input:checked')) return;
    card.dataset.ok = text;
    btn.disabled = false;
  }, wait));
}
function noteCopy(card: HTMLElement) {
  const ta = card.querySelector('textarea')!;
  if (card.dataset.ok !== ta.value) return noteCheck(card);
  copy(ta, '下書き');
}

// ===== 検索（日本語の依頼 → Claude） =====
const form = $<HTMLFormElement>('#search');
const q = $<HTMLTextAreaElement>('#q');
q.addEventListener('keydown', (e) => {
  // 日本語入力の変換確定の Enter では送らない
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); form.requestSubmit(); }
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = q.value.trim();
  const send = form.querySelector('button')!;
  if (!text || send.disabled || replaying) return;
  send.disabled = true;
  show(renderWait());
  try {
    const res = await api<ChatResponse>('/api/chat', { sessionId, text, view: viewNow() });
    // 住所のピンは残す（共有リンクはサーバにある住所の結果をすべて入れるので、画面と合わせる）
    st.pins = st.pins.filter((p) => p.place.kind === 'address');
    const cam = apply(res.steps);
    show(renderChat(text, res, st.here?.accuracy_m));
    fit(cam);
    q.value = '';
    await saveExports(res.steps);
  } catch (err) { show(renderError((err as Error).message)); }
  send.disabled = false;
});

// ===== カテゴリの札（AI を通さない） =====
for (const w of CHIPS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.dataset.word = w;
  b.setAttribute('aria-pressed', 'false');
  b.innerHTML = `${CHIP_ICON[w] ?? ''}<span>${DICT[w].label}</span>`; // 辞書の定数だけ
  b.addEventListener('click', () => chip(w, b));
  $('#chips').append(b);
}
async function chip(w: DictKey, b: HTMLButtonElement) {
  if (b.getAttribute('aria-busy') === 'true' || replaying) return;
  if (st.visible.has(w)) { // もう一度押したら、その印を隠すだけ（Overpass には聞き直さない）
    st.visible.delete(w);
    const wasChip = chipSteps.delete(w);
    draw();
    if (chipSteps.size) show(renderDirect([...chipSteps.values()]), 'direct');
    else if (wasChip && panel.dataset.mode === 'direct') panel.hidden = true;
    // 共有リンクに隠した印が入らないよう、サーバの表示の状態も合わせる（地図は動かさない）
    api('/api/op/set_view', { sessionId, input: { target: 'view:', show: [], hide: [w] }, view: viewNow() }).catch(() => {});
    return;
  }
  b.setAttribute('aria-busy', 'true');
  try {
    const r = await api<OpResult>('/api/op/find_features', { sessionId, input: { words: [w], area: 'view:', radius_m: 500 }, view: viewNow() });
    chipSteps.set(w, r);
    apply([r]);
    show(renderDirect([...chipSteps.values()]), 'direct');
  } catch (err) { show(renderError((err as Error).message)); }
  b.removeAttribute('aria-busy');
}

// ===== 地図のボタンとクリック =====
$('#zin').addEventListener('click', () => map.zoomIn());
$('#zout').addEventListener('click', () => map.zoomOut());
const NO_GEO = '位置情報が使えません。地図をクリックして場所を指定できます';
$('#locate').addEventListener('click', () => {
  if (replaying) return;
  if (!navigator.geolocation) return toast(NO_GEO);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const here: Session['here'] = { coord: [r6(pos.coords.longitude), r6(pos.coords.latitude)], accuracy_m: Math.max(1, Math.round(pos.coords.accuracy)) };
    // サーバが受けた（東京都の中で、here: として使える）ときだけ地図に出す
    try { await api<ContextResponse>('/api/context', { sessionId, here }); } catch (err) { return toast((err as Error).message); }
    st.here = here;
    draw();
    map.flyTo({ center: here.coord, zoom: Math.max(map.getZoom(), 15) });
  }, () => toast(NO_GEO), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
});
map.on('click', async (e) => {
  if (shareId || replaying) return;
  const click: LngLat = [r6(e.lngLat.lng), r6(e.lngLat.lat)];
  try {
    const r = await api<ContextResponse>('/api/context', { sessionId, click });
    const n = r.clickRef?.match(/^click:(\d+)$/)?.[1]; // 番号はサーバの参照に合わせる
    if (n) { st.clicks.push({ coord: click, n }); draw(); }
  } catch (err) { toast((err as Error).message); }
});

// ===== 資料用の画像：地図に出典とデータ時点を描き込んで PNG にする =====
async function exportPng() {
  const out = await pngCanvas();
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
  if (!blob) return toast('画像を作れませんでした');
  save(blob, `kotozute-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.png`);
}
async function pngCanvas() {
  const src = map.getCanvas();
  const k = src.width / src.clientWidth;
  // 画像ではリンクを押せないので、OSM は著作権のページの URL も書く
  const parts = [...attributionParts(usedAttribution()).map((p) => (p === ATTRIBUTION.osm ? `${p.text}（${p.url.replace(/^https:\/\/www\./, '')}）` : p.text)), dataAsOfText(shareOsmAsOf)];
  const size = 13 * k, pad = 10 * k, lh = size * 1.5;
  const font = (px: number) => `500 ${px}px "M PLUS 1", sans-serif`;
  await document.fonts.load(font(size), parts.join('')).catch(() => {});
  const out = document.createElement('canvas');
  out.width = src.width;
  const g = out.getContext('2d')!;
  const max = out.width - pad * 2;
  // 幅に入るだけ「｜」でつなぎ、入らなければ次の行にする（狭い画面でも読める大きさのまま）
  g.font = font(size);
  const lines: string[] = [];
  for (const t of parts) {
    const last = lines.at(-1);
    if (last != null && g.measureText(`${last}｜${t}`).width <= max) lines[lines.length - 1] = `${last}｜${t}`;
    else lines.push(t);
  }
  out.height = src.height + Math.ceil(pad * 2 + lh * lines.length); // ここで描画の設定は初期化される
  g.drawImage(src, 0, 0);
  g.fillStyle = C.white;
  g.fillRect(0, src.height, out.width, out.height - src.height);
  g.fillStyle = '#434C53';
  g.textAlign = 'right';
  g.textBaseline = 'top';
  lines.forEach((t, i) => {
    g.font = font(size);
    const w = g.measureText(t).width;
    if (w > max) g.font = font((size * max) / w); // 1つでも幅より長いときだけ縮める
    g.fillText(t, out.width - pad, src.height + pad + i * lh);
  });
  return out;
}

// ===== 共有リンクの画面（読み取りのみ） =====
async function loadShare(id: string): Promise<boolean> {
  const banner = $('#banner');
  banner.hidden = false;
  try {
    const s = await api<ShareState>(`/api/share/${encodeURIComponent(id)}`);
    shareOsmAsOf = s.osm_as_of;
    for (const l of s.layers) { st.feat.set(l.word, l.items); st.visible.add(l.word); }
    st.route = s.route;
    // 住所は「住」、それ以外は add_pin のピン
    st.pins = s.pins.filter((p) => p.kind === 'address').map((p) => ({ place: p, n: '住' }));
    st.pinned = s.pins.filter((p) => p.kind !== 'address');
    draw();
    const cam = s.bbox ? boxPts(s.bbox) : [...s.layers.flatMap((l) => l.items.map((p) => p.coord)), ...s.pins.map((p) => p.coord), ...(s.route?.legs.flatMap((l) => l.shape) ?? [])];
    fit(cam);
    return true;
  } catch (err) {
    banner.textContent = `共有された地図を開けません：${(err as Error).message}`;
    return false;
  }
}
if (shareId) document.body.classList.add('share-view');
