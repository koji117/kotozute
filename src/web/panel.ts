// 結果パネルの文章。すべて操作の結果（OpResult）からテンプレートで作る。Claude の文章は出さない。
import { ATTRIBUTION } from '../attribution';
import { DICT, type DictKey } from '../ops/dict';
import type {
  ChatResponse, FindFeaturesOutput, GeocodeOutput, OpResult, Place, RouteOutput,
  SearchPlaceOutput, SetViewOutput, ShareOutput, UnknownWordsOutput,
} from '../ops/types';

// ===== 差し込み。OSM の名前などはすべてエスケープする（Raw だけそのまま） =====
export class Raw { constructor(readonly s: string) {} }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const val = (v: unknown): string =>
  v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v == null || v === false ? '' : esc(String(v));
export const html = (s: TemplateStringsArray, ...v: unknown[]) =>
  new Raw(s.reduce((a, x, i) => a + x + (i < v.length ? val(v[i]) : ''), ''));
const raw = (s: string) => new Raw(s);

/** 言葉ごとの印の色（案E の色） */
export const COLOR: Record<DictKey, string> = {
  post_office: '#0B6E78', souvenir: '#8A5A00', convenience: '#18703E', cafe: '#734700', parking: '#085862', fuel: '#B3261E',
  toilets: '#5A646B', park: '#18703E', station: '#12343B', hospital: '#B3261E', level_crossing: '#B3261E', tunnel: '#12343B',
};

const svg16 = (d: string) => `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
/** 札のアイコン（自前の線画） */
export const CHIP_ICON: Partial<Record<DictKey, string>> = {
  post_office: svg16('M3.5 3.5h9a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11V5a1.5 1.5 0 0 1 1.5-1.5zM2.5 4.5L8 9l5.5-4.5'),
  souvenir: svg16('M2.5 6.5h11v7h-11zM2 4.5h12v2H2zM8 4.5v9M8 4.5C6 1.5 4 3 5.5 4.5M8 4.5c2-3 4-1.5 2.5 0'),
  convenience: svg16('M3 6h10l-.8 7.5H3.8zM5.5 6V4.5a2.5 2.5 0 0 1 5 0V6'),
  level_crossing: svg16('M3 3l10 10M13 3L3 13'),
  tunnel: svg16('M2 13V8a6 6 0 0 1 12 0v5'),
};

// 曲がり方のアイコン（Valhalla の maneuver type から選ぶ）
const TURN = {
  straight: svg16('M8 13V3M4 7l4-4 4 4'),
  slightRight: svg16('M5 13V9l6-6M7 3h4v4'),
  right: svg16('M4 13V8a3 3 0 0 1 3-3h6M10 2l3 3-3 3'),
  slightLeft: svg16('M11 13V9L5 3M9 3H5v4'),
  left: svg16('M12 13V8a3 3 0 0 0-3-3H3M6 2L3 5l3 3'),
  uturn: svg16('M5 13V6a3 3 0 0 1 6 0v3M8 7l3 3 3-3'),
};
const turnIcon = (t: number) => raw(
  [9, 18, 20, 23].includes(t) ? TURN.slightRight : [10, 11].includes(t) ? TURN.right
  : [16, 19, 21, 24].includes(t) ? TURN.slightLeft : [14, 15].includes(t) ? TURN.left
  : [12, 13].includes(t) ? TURN.uturn : TURN.straight);
const CAR = raw('<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 12l1.6-4.4A2 2 0 0 1 7.5 6.2h5a2 2 0 0 1 1.9 1.4L16 12v3.5H4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.8" cy="13" r="1" fill="currentColor"/><circle cx="13.2" cy="13" r="1" fill="currentColor"/></svg>');

// ===== 参照の名前。結果に出た場所だけ名前で出し、知らない参照はそのまま出す =====
const names = new Map<string, string>([['here:', '現在地'], ['view:', '画面の範囲']]);
export const nm = (p: Place) => p.name ?? '名前なし';
const LOOKS_REF = /^(here:|view:|click:\d+|result:\d+|abr:\d+|osm:\w+\/\d+)$/; // types.ts の REF_PATTERN と同じ形（zod を画面に入れないため写す）
export function refName(ref: string): string {
  const c = ref.match(/^click:(\d+)$/);
  // 参照の形なのに結果にないものは、LLM が作った文字列を出さない。住所や名前などの文字はそのまま
  return names.get(ref) ?? (c ? `クリック${c[1]}` : LOOKS_REF.test(ref) ? '（結果にない参照）' : ref);
}
/** 結果の中の場所（ref と coord を持つもの）をすべて覚える */
function remember(v: unknown) {
  if (Array.isArray(v)) return v.forEach(remember);
  if (!v || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  if (typeof o.ref === 'string' && Array.isArray(o.coord)) {
    names.set(o.ref, nm(o as unknown as Place));
    if (typeof o.osm === 'string') names.set(`osm:${o.osm}`, nm(o as unknown as Place));
  }
  Object.values(o).forEach(remember);
}

const isWord = (s: string): s is DictKey => Object.hasOwn(DICT, s);
const label = (s: string) => (isWord(s) ? DICT[s].label : s);
const KEY: Record<string, string> = {
  words: '探すもの', area: '範囲', radius_m: '半径（m）', name: '名前', address: '住所', from: '出発', to: '目的地',
  stops: '寄り先', ref: '場所', word: '種類', target: '場所', show: '残す', hide: '隠す', avoid_highways: '高速を使わない', keep_order: '頼んだ順に寄る',
};
function inVal(k: string, v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => inVal(k, x)).join('、');
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  if (typeof v === 'string') return isWord(v) ? (k === 'words' ? DICT[v].interpretation : DICT[v].label) : refName(v);
  if (v && typeof v === 'object') return pairs(v, '、');
  return String(v);
}
/** 入力の「名前：値」。null（使わない項目）と空の配列は出さない */
const pairs = (o: object, sep: string) => Object.entries(o)
  .filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))
  .map(([k, v]) => `${KEY[k] ?? k}：${inVal(k, v)}`).join(sep);
/** 検証に落ちた入力（bad_input）は LLM が書いたままなので出さない。座標や結果にない言葉が入りうる */
const shownInput = (s: OpResult) => {
  if (!s.ok && s.error.code === 'bad_input') return '（入力が正しくないため表示しません）';
  if (!s.input || typeof s.input !== 'object') return '';
  // 範囲（画面や公園）で探したときは半径を使っていないので出さない
  const input = s.ok && s.op === 'find_features' && (s.output as FindFeaturesOutput).area.radius_m == null
    ? Object.fromEntries(Object.entries(s.input).filter(([k]) => k !== 'radius_m')) : s.input;
  return pairs(input, '／');
};

// ===== 数の書き方 =====
const min = (m: number) => `${Math.round(m * 10) / 10}分`;
const km = (k: number) => `${Math.round(k * 100) / 100}km`;
const dist = (k: number) => (k < 1 ? `${Math.round(k * 1000)} m` : `${Math.round(k * 10) / 10} km`);

// ===== 操作ごとのカード =====
function geocode(o: GeocodeOutput) {
  return html`<div class="card">
    <div class="t"><span class="dotn">住</span><h3>${o.matched}</h3></div>
    <div class="badges"><span class="badge b-acc">座標の精度：${o.precision}</span>
      ${o.unmatched ? html`<span class="badge b-unk">一致しなかった部分：${o.unmatched}</span>` : ''}</div>
    <div class="note">${ATTRIBUTION.abr.text}</div></div>`;
}

function features(o: FindFeaturesOutput) {
  return html`<div class="card">
    <div class="od">範囲：${o.area.label}${o.area.radius_m != null ? `（半径${o.area.radius_m}m）` : ''}</div>
    ${o.groups.map((g) => html`
      <div class="sec"><span class="sw" style="background:${COLOR[g.word]}"></span>${g.label} ${g.count}件${g.truncated ? '以上' : ''}</div>
      <div class="interp">${g.interpretation}</div>
      ${g.count === 0 ? html`<div class="zero">OSM上で0件（現地にないとは限らない）</div>` : html`
        ${g.truncated ? html`<div class="note">上限の${g.items.length}件で切りました（全部ではありません）</div>` : ''}
        <details ${g.count <= 8 ? 'open' : ''}><summary>名前の一覧</summary>
          <ol class="names">${g.items.map((p) => html`<li>${nm(p)}</li>`)}</ol></details>`}`)}
  </div>`;
}

function search(o: SearchPlaceOutput) {
  return html`<div class="card">
    <h3>「${o.query}」 ${o.items.length ? `${o.total}件${o.capped ? '以上' : ''}` : ''}</h3>
    ${o.items.length === 0 ? html`<div class="zero">OSM上で見つかりません（現地にないとは限らない）</div>` : html`
      ${o.truncated ? html`<div class="note">多いので近い${o.items.length}件だけ${o.capped ? '（上限で切ったので、近い順は一部の中で）' : ''}</div>` : ''}
      <ol class="names">${o.items.map((p) => html`<li>${nm(p)}</li>`)}</ol>`}
  </div>`;
}

function route(r: RouteOutput, hereAcc?: number) {
  const nStops = r.stops.length;
  const legs = r.legs.map((leg, i) => {
    const last = leg.steps.at(-1);
    const side = last?.type === 5 ? '右側' : last?.type === 6 ? '左側' : '';
    const stop = i < nStops ? r.stops[i].chosen : r.to;
    return html`
      ${leg.steps.filter((s) => s.type < 4 || s.type > 6).map((s) => html`<div class="stp">${turnIcon(s.type)}<span>${s.text}</span><small>${dist(s.km)}</small></div>`)}
      <div class="stp stop"><span class="dotn">${i < nStops ? i + 1 : '終'}</span><b>${nm(stop)}</b><small>${i < nStops ? side : ['到着', side].filter(Boolean).join('・')}</small></div>`;
  });
  return html`<div class="card">
    <div class="pts">
      ${r.from.kind === 'here'
        ? html`<div class="pt"><span class="dot here"></span><span>現在地</span><small>${hereAcc != null ? `半径${hereAcc}m` : ''}</small></div>`
        : html`<div class="pt"><span class="dotn">出</span><span>${nm(r.from)}</span><small>出発</small></div>`}
      ${r.stops.map((s, i) => html`<div class="pt"><span class="dotn">${i + 1}</span><span>${nm(s.chosen)}</span><small>${label(s.requested)}</small></div>`)}
      <div class="pt"><span class="dotn">終</span><span>${nm(r.to)}</span><small>目的地</small></div>
    </div>
    <div class="ph-h" style="margin-top:12px">${CAR}<h2>車</h2><span class="big">${min(r.total.minutes)}</span><span class="od">${km(r.total.km)}</span>
      ${nStops ? html`<span class="badge b-acc" style="margin-left:auto">寄り道で +${min(r.extra_min)}</span>` : ''}</div>
    ${nStops ? html`<div class="od">寄らない場合 ${min(r.direct.minutes)}・${km(r.direct.km)}${r.legs.length > 1 ? `（区間ごと ${r.legs.map((l) => min(l.minutes)).join('／')}）` : ''}</div>` : ''}
    <div class="badges">
      ${r.avoid_highways ? html`<span class="badge b-acc">高速を使わない</span>` : ''}
      ${nStops ? html`<span class="badge b-acc">試した組み合わせ ${r.tried}通り</span>` : ''}
    </div>
    <div class="steps">${legs}</div></div>`;
}

function setView(o: SetViewOutput) {
  return html`<div class="card"><div class="kv" style="margin-top:0">
    <div><b>場所</b><span>${o.target ? nm(o.target) : '画面の範囲'}</span></div>
    <div><b>表示</b><span>${o.target ? 'その場所が入る大きさに動かしました' : '地図は動かしていません'}</span></div>
    ${o.shown.length ? html`<div><b>残す</b><span>${o.shown.map(label).join('、')}</span></div>` : ''}
    ${o.hidden.length ? html`<div><b>隠す</b><span>${o.hidden.map(label).join('、')}</span></div>` : ''}
  </div></div>`;
}

export function shareCard(o: ShareOutput) {
  return html`<div class="card"><h3>共有リンク</h3>
    <div class="share"><input readonly value="${location.origin + o.url}" aria-label="共有リンク"><button class="btn" type="button" data-act="copy">コピー</button></div>
    <div class="note">開いた人は、同じ地図を読み取りだけで見られます</div>
    ${o.includes_here ? html`<div class="note warn">このリンクには、出発地としてあなたの現在地が入っています</div>` : ''}</div>`;
}

export function stepHtml(s: OpResult, hereAcc?: number): Raw {
  if (!s.ok) return html`<div class="card err"><h3>${s.title}</h3><div>${s.error.message}</div></div>`;
  switch (s.op) {
    case 'geocode_address': return geocode(s.output as GeocodeOutput);
    case 'find_features': return features(s.output as FindFeaturesOutput);
    case 'search_place': return search(s.output as SearchPlaceOutput);
    case 'route': return route(s.output as RouteOutput, hereAcc);
    case 'set_view': return setView(s.output as SetViewOutput);
    case 'make_share_link': return shareCard(s.output as ShareOutput);
    case 'unknown_words': return html`<div class="card"><div>辞書にない言葉：${(s.output as UnknownWordsOutput).words.join('、')}（地物の検索には使えません）</div></div>`;
    default: return html`<div class="card"><h3>${s.title}</h3></div>`;
  }
}

const STOP: Record<ChatResponse['stop'], string> = {
  done: '',
  max_steps: '手順が多すぎるので、途中で止めました。頼み方を分けてください',
  no_tool: '地図の操作に結びつけられませんでした。場所や探すものを入れて頼んでください',
  refusal: 'この依頼には応じられません',
  error: 'エラーが起きました',
};

const close = raw('<button class="x" type="button" data-act="close" aria-label="結果を閉じる">×</button>');
const foot = raw(`<div class="foot">
  <button class="btn primary" type="button" data-act="share"><svg width="18" height="18" aria-hidden="true"><use href="#i-link"/></svg>共有リンク</button>
  <button class="btn" type="button" data-act="png"><svg width="18" height="18" aria-hidden="true"><use href="#i-dl"/></svg>画像</button></div>`);

/** 日本語の依頼の結果：依頼、解釈（操作と入力）、操作ごとのカード、止まった理由 */
export function renderChat(text: string, res: ChatResponse, hereAcc?: number) {
  res.steps.forEach((s) => s.ok && remember(s.output));
  const stop = STOP[res.stop];
  return html`${close}<div class="req"><b>依頼</b>　${text}</div>
    ${res.steps.length ? html`<div class="ph-h" style="margin-top:10px"><h2>解釈</h2><span class="od">頼まれた言葉をこう受け取りました</span></div>
      <div class="kv">${res.steps.map((s) => html`<div><b>${s.title}</b><span>${shownInput(s)}</span></div>`)}</div>` : ''}
    ${res.steps.map((s) => stepHtml(s, hereAcc))}
    ${stop ? html`<div class="card err"><div>${stop}${res.stop === 'error' && res.error ? `：${res.error}` : ''}</div></div>` : ''}
    ${foot}`;
}

/** 札（AI を通さない）の結果 */
export function renderDirect(steps: OpResult[]) {
  steps.forEach((s) => s.ok && remember(s.output));
  return html`${close}<div class="ph-h"><h2>この画面の範囲</h2><span class="badge b-ok">AIを通さない</span></div>
    ${steps.map((s) => stepHtml(s))}
    <div class="note">札は AI を通さずに、自社の Overpass へ直接たずねます</div>
    ${foot}`;
}

export const renderError = (msg: string) => html`${close}<div class="card err" style="margin-top:0"><div>${msg}</div></div>${foot}`;
export const renderWait = () => html`<div class="wait">ことづてが地図を操作しています…</div>`;
