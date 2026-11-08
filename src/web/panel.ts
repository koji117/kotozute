// 結果パネルの文章。すべて操作の結果（OpResult）からテンプレートで作る。Claude の文章は出さない。
import { ATTRIBUTION, OSM_DATA_AS_OF } from '../attribution';
import { DICT, type DictKey } from '../ops/dict';
import type {
  AddPinOutput, ChatResponse, CheckOutput, CheckRouteOutput, CheckRow, CourseOutput, ExportPngOutput, Mode, ExportRouteOutput, FindFeaturesOutput,
  GeocodeOutput, NetLog, OpResult, Place, RecipeRunResponse, RecipeSaved, RouteOutput, SearchPlaceOutput, SetViewOutput, ShareOutput,
  UnknownWordsOutput, Verdict,
} from '../ops/types';
import type { NoteDraftOutput } from '../ops/draft_osm_note';
import { ISSUES, type Issue } from '../ops/note_rules';
import { CHIP_SOURCE, courseCandidates, WIDENED_NOTE } from '../region-text';

// ===== 差し込み。OSM の名前などはすべてエスケープする（Raw だけそのまま） =====
export class Raw { constructor(readonly s: string) {} }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const val = (v: unknown): string =>
  v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v == null || v === false ? '' : esc(String(v));
export const html = (s: TemplateStringsArray, ...v: unknown[]) =>
  new Raw(s.reduce((a, x, i) => a + x + (i < v.length ? val(v[i]) : ''), ''));
const raw = (s: string) => new Raw(s);

/** 結果のカード。adv は「詳細」の欄に入れる技術的な情報（OSM のタグ、数え方、内訳、ID、ファイル名）。画面の本体は要点だけにする */
export interface Card { main: Raw; adv?: Raw }
const card = (main: Raw, adv?: Raw | ''): Card => ({ main, adv: adv || undefined });
const advItem = (title: string, body: Raw) => html`<div class="adv-item"><h4>${title}</h4>${body}</div>`;

/** 言葉ごとの印の色（案E の色） */
export const COLOR: Record<DictKey, string> = {
  post_office: '#0B6E78', souvenir: '#8A5A00', convenience: '#18703E', cafe: '#734700', parking: '#085862', fuel: '#B3261E',
  toilets: '#5A646B', park: '#18703E', station: '#12343B', hospital: '#B3261E', level_crossing: '#B3261E', foot_crossing: '#734700', tunnel: '#12343B',
};

const svg16 = (d: string) => `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
/** 札のアイコン（自前の線画） */
export const CHIP_ICON: Partial<Record<DictKey, string>> = {
  post_office: svg16('M3.5 3.5h9a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11V5a1.5 1.5 0 0 1 1.5-1.5zM2.5 4.5L8 9l5.5-4.5'),
  souvenir: svg16('M2.5 6.5h11v7h-11zM2 4.5h12v2H2zM8 4.5v9M8 4.5C6 1.5 4 3 5.5 4.5M8 4.5c2-3 4-1.5 2.5 0'),
  convenience: svg16('M3 6h10l-.8 7.5H3.8zM5.5 6V4.5a2.5 2.5 0 0 1 5 0V6'),
  cafe: svg16('M3 6.5h8v3.5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM11 7.5h1.2a1.6 1.6 0 0 1 0 3.2H11M5.5 2.5v2M8.5 2.5v2'),
  parking: svg16('M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5zM6.5 11.5v-7h2.3a2 2 0 0 1 0 4H6.5'),
  fuel: svg16('M3 13.5v-10a1 1 0 0 1 1-1h4.5a1 1 0 0 1 1 1v10M2 13.5h8.5M4.5 5.5h3.5M9.5 7h1.5a1 1 0 0 1 1 1v3a1 1 0 0 0 2 0V6l-1.5-2'),
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
const svg20 = (body: string) => raw(`<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`);
const line20 = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
/** 移動の手段のアイコン（自前の線画）と名前。名前は types.ts の MODES と同じ並び（zod を画面に入れないため、ここに書く） */
const MODE_ICON: Record<Mode, Raw> = {
  car: svg20('<path d="M4 12l1.6-4.4A2 2 0 0 1 7.5 6.2h5a2 2 0 0 1 1.9 1.4L16 12v3.5H4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.8" cy="13" r="1" fill="currentColor"/><circle cx="13.2" cy="13" r="1" fill="currentColor"/>'),
  walk: svg20(`<circle cx="10.5" cy="3.8" r="1.6" fill="currentColor"/><path d="M10 6.8L9 11.5l2.6 2.4.6 3.6M9 11.5l-1.6 5.5M9.6 8.2L7 10.2M10.2 7.6l2.8 2" ${line20}/>`),
  bicycle: svg20(`<circle cx="5" cy="13.2" r="3.2" ${line20}/><circle cx="15" cy="13.2" r="3.2" ${line20}/><path d="M5 13.2l3.4-5.6h4.4L15 13.2M8.4 7.6l2.2 5.6 2.2-5.6M7.2 5.8h2.4M12.2 5.4l.6 2.2" ${line20}/>`),
};
const MODE_JA: Record<Mode, string> = { car: '車', walk: '徒歩', bicycle: '自転車' };

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
  stops: '寄り道先', ref: '場所', word: '種類', target: '場所', show: '残す', hide: '隠す', avoid_highways: '高速を使わない', keep_order: '頼んだ順に寄る', stay_min: '過ごす時間（分）', arrive_by: '着く時刻',
  mode: '移動の手段', start: '出発・到着', tunnels: 'トンネル（本）', max_minutes: '時間の上限（分）',
  format: '形式',
  issue: '問題の種類',
};
function inVal(k: string, v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => inVal(k, x)).join('、');
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  if (typeof v === 'string' && k === 'issue' && Object.hasOwn(ISSUES, v)) return ISSUES[v as Issue].label;
  if (typeof v === 'string' && k === 'mode') return v === 'transit' ? '電車・バス' : Object.hasOwn(MODE_JA, v) ? MODE_JA[v as Mode] : '';
  if (typeof v === 'string') return isWord(v) ? DICT[v].label : refName(v); // OSM のタグでの解釈は「詳細」に出す
  // 寄り道先は「カフェ（30分）」。「種類：カフェ、過ごす時間（分）：30」とは出さない
  if (k === 'stops' && v && typeof v === 'object' && 'stay_min' in v) {
    const st = v as { ref: string | null; word: string | null; stay_min: number | null };
    return `${inVal(k, st.word ?? st.ref)}${st.stay_min ? `（${st.stay_min}分）` : ''}`;
  }
  if (v && typeof v === 'object') return pairs(v, '、');
  return String(v);
}
/** 出す項目：null（使わない項目）、空の配列、「いいえ」（頼まれていない条件）は出さない */
const shown = (o: object) => Object.entries(o).filter(([, v]) => v != null && v !== false && !(Array.isArray(v) && !v.length));
/** 入力の「名前：値」。項目が1つだけなら値だけ（例：寄り先の「種類：郵便局」は「郵便局」、住所は住所だけ） */
const pairs = (o: object, sep: string) => {
  const e = shown(o);
  return e.length === 1 ? inVal(e[0][0], e[0][1]) : e.map(([k, v]) => `${KEY[k] ?? k}：${inVal(k, v)}`).join(sep);
};
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
  return card(html`<div class="card">
    <div class="t"><span class="dotn">住</span><h3>${o.matched}</h3></div>
    <div class="badges"><span class="badge b-acc">座標の精度：${o.precision}</span>
      ${o.unmatched ? html`<span class="badge b-unk">一致しなかった部分：${o.unmatched}</span>` : ''}</div></div>`,
  html`<div class="note">${ATTRIBUTION.abr.text}</div>`);
}

function features(o: FindFeaturesOutput) {
  return card(html`<div class="card">
    <div class="od">範囲：${o.area.label}${o.area.radius_m != null ? `（半径${o.area.radius_m}m）` : ''}</div>
    ${o.groups.map((g) => html`
      <div class="sec"><span class="sw" style="background:${COLOR[g.word]}"></span>${g.label} ${g.count}${g.word === 'tunnel' ? '本' : g.points != null ? 'か所' : '件'}${g.truncated ? '以上' : ''}</div>
      ${g.count === 0 ? html`<div class="zero">OSM上で0件（現地にないとは限らない）</div>` : html`
        ${g.truncated ? html`<div class="note">上限の${g.items.length}件で切りました（全部ではありません）</div>` : ''}
        <details ${g.count <= 8 ? 'open' : ''}><summary>名前の一覧</summary>
          <ol class="names">${g.items.map((p) => html`<li>${nm(p)}</li>`)}</ol></details>`}`)}
  </div>`,
  html`${o.groups.map((g) => html`<div class="note">${g.interpretation}</div>
    ${g.points != null && g.points !== g.count ? html`<div class="note">${g.label}：OSM の点 ${g.points}個を、40m以内か同じ名前（200m以内）の点どうしでまとめて ${g.count}か所</div>` : ''}`)}`);
}

function search(o: SearchPlaceOutput) {
  return card(html`<div class="card">
    <h3>「${o.query}」 ${o.items.length ? `${o.total}件${o.capped ? '以上' : ''}` : ''}</h3>
    ${o.widened ? html`<div class="note">${WIDENED_NOTE}</div>` : ''}
    ${o.items.length === 0 ? html`<div class="zero">OSM上で見つかりません（現地にないとは限らない）</div>` : html`
      ${o.truncated ? html`<div class="note">多いので近い${o.items.length}件だけ${o.capped ? '（上限で切ったので、近い順は一部の中で）' : ''}</div>` : ''}
      <ol class="names">${o.items.map((p) => html`<li>${nm(p)}</li>`)}</ol>`}
  </div>`);
}

function route(r: RouteOutput, hereAcc?: number) {
  const nStops = r.stops.length;
  const stay = r.stay_min ?? 0; // 11/8 より前の共有リンクとレシピにはない
  const mode = r.mode ?? 'car'; // 試走コースと、11/8 より前の共有リンクとレシピは車
  const move = mode === 'car' ? '運転' : '移動';
  const legs = r.legs.map((leg, i) => {
    const last = leg.steps.at(-1);
    const side = last?.type === 5 ? '右側' : last?.type === 6 ? '左側' : '';
    const stop = i < nStops ? r.stops[i].chosen : r.to;
    return html`
      ${leg.steps.filter((s) => s.type < 4 || s.type > 6).map((s) => html`<div class="stp">${turnIcon(s.type)}<span>${s.text}</span><small>${dist(s.km)}</small></div>`)}
      <div class="stp stop"><span class="dotn">${i < nStops ? i + 1 : '終'}</span><b>${nm(stop)}</b><small>${i < nStops ? side : ['到着', side].filter(Boolean).join('・')}</small></div>`;
  });
  return card(html`<div class="card">
    <div class="pts">
      ${r.from.kind === 'here'
        ? html`<div class="pt"><span class="dot here"></span><span>現在地</span><small>${hereAcc != null ? `半径${hereAcc}m` : ''}</small></div>`
        : html`<div class="pt"><span class="dotn">出</span><span>${nm(r.from)}</span><small>出発</small></div>`}
      ${r.stops.map((s, i) => html`<div class="pt"><span class="dotn">${i + 1}</span><span>${nm(s.chosen)}</span><small>${label(s.requested)}${s.stay_min ? `・${s.stay_min}分` : ''}</small></div>`)}
      <div class="pt"><span class="dotn">終</span><span>${nm(r.to)}</span><small>目的地</small></div>
    </div>
    <div class="ph-h" style="margin-top:12px">${MODE_ICON[mode]}<h2>${MODE_JA[mode]}</h2><span class="big">${min(r.total.minutes)}</span><span class="od">${km(r.total.km)}</span>
      ${nStops ? html`<span class="badge b-acc" style="margin-left:auto">寄り道で +${min(r.extra_min + stay)}</span>` : ''}</div>
    ${nStops ? html`<div class="od">寄らない場合 ${min(r.direct.minutes)}・${km(r.direct.km)}${stay ? `。増える時間は、${move} +${min(r.extra_min)}と、寄り道先で過ごす ${stay}分` : ''}</div>` : ''}
    ${r.depart_by ? html`<div class="arr">${CLOCK}<span><b>${r.arrive_by}</b> に着くには <b>${r.depart_by}</b> までに出発</span></div>
      <div class="od">${move} ${min(r.total.minutes)}${stay ? `＋寄り道先で過ごす ${stay}分` : ''}から逆算${mode === 'car' ? '（渋滞は含まない）' : ''}</div>` : ''}
    ${r.avoid_highways ? html`<div class="badges"><span class="badge b-acc">高速を使わない</span></div>` : ''}
    <div class="steps">${legs}</div></div>`,
  html`${r.legs.length > 1 ? html`<div class="note">区間ごと：${r.legs.map((l) => min(l.minutes)).join('／')}</div>` : ''}
    ${nStops ? html`<div class="note">寄り道先の候補の組み合わせを ${r.tried}通り試しました</div>` : ''}`);
}

function setView(o: SetViewOutput) {
  return card(html`<div class="card"><div class="kv" style="margin-top:0">
    <div><b>場所</b><span>${o.target ? nm(o.target) : '画面の範囲'}</span></div>
    <div><b>表示</b><span>${o.target ? 'その場所が入る大きさに動かしました' : '地図は動かしていません'}</span></div>
    ${o.shown.length ? html`<div><b>残す</b><span>${o.shown.map(label).join('、')}</span></div>` : ''}
    ${o.hidden.length ? html`<div><b>隠す</b><span>${o.hidden.map(label).join('、')}</span></div>` : ''}
  </div></div>`);
}

// ===== 条件の確認（plan_course、check_route） =====
// 印の中の線（◯・×）は --ic-mark の色。塗りの札（.verdict）では札の色にして抜く
const icon = (d: string) => raw(`<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">${d}</svg>`);
const V_ICON: Record<Verdict, Raw> = {
  pass: icon('<circle cx="10" cy="10" r="9" fill="currentColor"/><circle cx="10" cy="10" r="4.4" fill="none" style="stroke:var(--ic-mark)" stroke-width="2.2"/>'),
  fail: icon('<rect x="1.5" y="1.5" width="17" height="17" rx="3" fill="currentColor"/><path d="M6.5 6.5l7 7M13.5 6.5l-7 7" style="stroke:var(--ic-mark)" stroke-width="2.2" stroke-linecap="round"/>'),
  unknown: icon('<circle cx="10" cy="10" r="8.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.6 2"/><path d="M7.6 7.7a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.6" r="1.1" fill="currentColor"/>'),
};
const CLOCK = icon('<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6v4.3l2.8 1.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>');
/** 条件の行と案ごとの言葉 */
const V_TEXT: Record<Verdict, string> = { pass: '合う', fail: '合わない', unknown: '分からない（データなし）' };
/** 表全体の言葉（右上の札） */
const V_ALL: Record<Verdict, string> = { pass: 'すべて合う', fail: '合わない条件あり', unknown: '分からない条件あり' };
const V_BADGE: Record<Verdict, string> = { pass: 'b-ok', fail: 'b-ng', unknown: 'b-unk' };
const judged = (v: Verdict) => html`<span class="badge ${V_BADGE[v]}">${V_ICON[v]}${V_TEXT[v]}</span>`;
const verdictTag = (v: Verdict) => html`<span class="verdict v-${v}">${V_ICON[v]}${V_ALL[v]}</span>`;

function checkRow(r: CheckRow) {
  const [c, v] =
    r.kind === 'tunnels' ? [html`<i class="sw-tun"></i>${r.want ? `トンネル ${r.want}本` : 'トンネルを通らない'}`, html`${r.got}${r.want ? `/${r.want}` : ''}<small>本</small>`]
    : r.kind === 'minutes' ? [html`${CLOCK}${r.want}分以内`, html`${r.got}<small>分</small>`]
    : [html`<i class="sw-route"></i>高速を使わない`, r.got ? html`${r.got}<small>km 通る</small>` : html`<span class="muted">通らない</span>`];
  return html`<div class="c">${c}</div><div class="v">${v}</div><div class="j">${judged(r.result)}</div>`;
}

/** 条件の確認。車線数（参考、確認に使わない）と数え方の内訳は「詳細」へ */
function checkTable(c: CheckOutput): Card {
  const n = c.lanes.untagged_runs;
  const counted = c.tunnels.filter((t) => !t.skip), skipped = c.tunnels.filter((t) => t.skip);
  const tname = (t: CheckOutput['tunnels'][number]) => t.name ?? '名前なし';
  return card(html`<div class="vt">${c.rows.map(checkRow)}</div>`,
    html`<div class="note">車線数（参考）：${n ? html`タグのない ${n}区間は ${judged('unknown')}` : 'すべてタグあり'}。車線数のタグ（lanes）があるのはコースの ${Math.round(c.lanes.tagged_share * 100)}%（車線数は条件の確認に使いません）</div>
    <div class="note">トンネルの数え方：連続する tunnel=yes を1本、50m未満は数えない。同じトンネルを2回通ったら（上下線など）1本</div>
    ${counted.length ? html`<div class="note">数えたトンネル：${counted.map((t) => `${tname(t)}（${dist(t.m / 1000)}）`).join('、')}</div>` : ''}
    ${skipped.length ? html`<div class="note">数えなかったもの：${skipped.map((t) => `${tname(t)}（${t.skip === 'short' ? `${t.m} m・50m未満` : '2回目'}）`).join('、')}</div>` : ''}
    ${c.missing ? html`<div class="note">OSM のタグを取り直せなかった道が ${c.missing}本あります</div>` : ''}`);
}

const STOPPED: Record<NonNullable<CourseOutput['stopped_by']>, string> = {
  attempts: '案の上限（5案）まで試しました', routes: 'ルート計算の上限（10回）まで試しました',
  candidates: '経由地にできるトンネルの候補を使い切りました', other: 'トンネルを足しても直らない条件があります',
};

function course(o: CourseOutput) {
  const i = o.chosen ?? o.attempts.length - 1, a = o.attempts[i], v = a.check.verdict;
  const start = nm(o.start);
  const t = checkTable(a.check);
  return card(html`<div class="card">
    <div class="ph-h"><h2>条件の確認</h2>${verdictTag(v)}
      <span class="chipline">${o.attempts.map((x, k) => html`<span class="${k === i ? 'on' : ''}">${k + 1}回目${k === i ? '' : ` ${V_TEXT[x.check.verdict]}`}</span>`)}</span></div>
    <div class="od" style="margin-top:6px">${start} 発着（周回）・${min(a.minutes)}・${km(a.km)}・経由：${a.via.map((x) => x.name ?? '名前なし').join('、')}</div>
    ${t.main}
    ${o.chosen == null ? html`<div class="zero">条件を満たすコースは見つかりませんでした（${STOPPED[o.stopped_by ?? 'other']}）。地図には最後の案を出しています</div>` : ''}
  </div>`,
  html`<div class="note">解釈：トンネル＝道路の tunnel=yes（連続する区間は1本）${o.conditions.avoid_highways ? '／高速＝高速道路と有料道路を除外して計算' : ''}／${start}から${start}へ（周回）</div>
    ${t.adv}
    <div class="note">経由地の候補はプログラムが作りました：${courseCandidates(o.radius_m / 1000)} ${o.candidates}本（有料・自動車専用・車両通行不可・高さ2.1m未満の ${o.excluded}本は除外）。ルート計算 ${o.routes}回</div>`);
}

function checkCard(o: CheckRouteOutput) {
  const t = checkTable(o);
  return card(html`<div class="card">
    <div class="ph-h"><h2>条件の確認</h2>${verdictTag(o.verdict)}</div>
    <div class="od" style="margin-top:6px">いま地図にあるルート：${o.from} → ${o.to}・${min(o.minutes)}・${km(o.km)}</div>
    ${t.main}
  </div>`, t.adv);
}

export function shareCard(o: ShareOutput) {
  return card(html`<div class="card"><h3>共有リンク</h3>
    <div class="share"><input readonly value="${location.origin + o.url}" aria-label="共有リンク"><button class="btn" type="button" data-act="copy">コピー</button></div>
    <div class="note">開いた人は、同じ地図を読み取りだけで見られます</div>
    ${o.includes_here ? html`<div class="note warn">このリンクには、あなたの現在地が入っています</div>` : ''}</div>`);
}

function pin(o: AddPinOutput) {
  return card(html`<div class="card"><div class="t"><span class="dotn pin" aria-hidden="true"></span><h3>${nm(o.pin)}</h3></div>
    <div class="note">ピンを立てました（全部で${o.count}本）。共有リンクと画像に入ります</div></div>`);
}

function png(o: ExportPngOutput) {
  return card(html`<div class="card"><h3>資料用の画像</h3>
    <div class="note">地図を画像にしました。出典（${ATTRIBUTION.osm.text} ほか）とデータ時点を画像の下に焼き込んであります</div></div>`,
  o.mode === 'file' ? html`<div class="note">保存先：${o.path}</div>` : '');
}

function routeFile(o: ExportRouteOutput) {
  return card(html`<div class="card"><h3>${o.filename.endsWith('.gpx') ? 'GPX' : 'GeoJSON'}（社内用）を書き出しました</h3>
    <div class="note warn">${o.warning}</div>
    ${o.includes_here ? html`<div class="note warn">このファイルには、あなたの現在地が入っています</div>` : ''}</div>`,
  html`<div class="note">ファイル名：${o.filename}</div>`);
}

export function recipeCard(o: RecipeSaved): Card {
  return card(html`<div class="card recipe"><h3>レシピ</h3>
    <div class="share"><a class="btn primary" href="${o.url}" target="_blank" rel="noopener">再実行</a></div>
    <div class="note">Claude を使わずに、同じ操作を同じ順にやり直します（いまの OSM のデータで）</div>
    ${o.includes_here ? html`<div class="note warn">このレシピには、あなたの現在地が入っています</div>` : ''}</div>`,
  advItem('レシピ', html`<div class="note">ID <span class="mono">${o.id}</span>・操作 ${o.steps.length}回</div>`));
}

const NOT_OTHER = ['localhost', '127.0.0.1', '[::1]', 'api.anthropic.com']; // src/server/netlog.ts の分け方と同じ
const count = (n: number, bad = false) => html`<b class="${n === 0 ? 'ok' : bad ? 'ng' : ''}">${n}<small>件</small></b>`;
/** 外部通信の記録（この操作の間にサーバが出した要求の数） */
export function netCard(n?: NetLog) {
  if (!n) return '';
  const others = Object.keys(n.hosts).filter((h) => !NOT_OTHER.includes(h));
  return html`<div class="card net"><div class="t"><svg width="16" height="16" aria-hidden="true"><use href="#i-shield"/></svg><h3>外部通信の記録（この操作の間）</h3></div>
    <div class="row"><span>自社のサービス（地図・検索・ルート・住所）</span>${count(n.self)}</div>
    <div class="row"><span class="mono">api.anthropic.com</span>${count(n.anthropic)}</div>
    <div class="row"><span>その他の外部${others.length ? html`：<span class="mono">${others.join('、')}</span>` : ''}</span>${count(n.other, true)}</div>
    <div class="note">このサーバが外へ出した要求の数です。画面（ブラウザ）はこのサーバとだけ通信します</div></div>`;
}

// 確認方法は本人が選ぶ（AI は選ばない）。コピーは、選んだうえで止める語がないときだけ（main.ts の noteCheck）
let noteN = 0;
function note(o: NoteDraftOutput) {
  const id = `note${++noteN}`;
  return card(html`<div class="card ncard">
    <h3>OSMノートの下書き</h3>
    <div class="od">アプリはOSMと通信しない。投稿は現地を見た本人</div>
    <div class="kv">
      <div><b>何が</b><span>${o.issue_label}：${o.what}</span></div>
      <div><b>どこで</b><span>${nm(o.target)}</span></div>
    </div>
    <fieldset class="meth"><legend>確認方法（ご自身で選んでください）</legend>
      ${o.methods.map((m) => html`<label${m.allowed ? '' : raw(' class="off"')}><input type="radio" name="${id}" value="${m.label}"${m.allowed ? '' : raw(' disabled')}>${m.label}${m.reason ? html`<small>選べません：${m.reason}</small>` : ''}</label>`)}
    </fieldset>
    <label class="sr" for="${id}-t">ノートの下書き</label>
    <textarea id="${id}-t" rows="5" maxlength="2000">${o.draft}</textarea>
    <div class="badges"><span class="badge b-unk">社名・「試走」など、会社や仕事が分かる語は入れない</span></div>
    <div class="nwarn" role="alert" hidden></div>
    <div class="nact"><button class="btn" type="button" data-act="note-copy" disabled>下書きをコピー</button>
      <a class="btn primary" href="${o.note_url}" target="_blank" rel="noopener">OSMのノート画面へ</a></div>
  </div>`, o.target.osm ? html`<div class="note">OSM要素：${o.target.osm}</div>` : '');
}

/** 操作の結果のカード。「詳細」に入れるものは、操作の名前を見出しにつける */
export function stepHtml(s: OpResult, hereAcc?: number): Card {
  const c = opCard(s, hereAcc);
  return c.adv ? { main: c.main, adv: advItem(s.title, c.adv) } : c;
}
function opCard(s: OpResult, hereAcc?: number): Card {
  if (!s.ok) return card(html`<div class="card err"><h3>${s.title}</h3><div>${s.error.message}</div></div>`);
  switch (s.op) {
    case 'geocode_address': return geocode(s.output as GeocodeOutput);
    case 'find_features': return features(s.output as FindFeaturesOutput);
    case 'search_place': return search(s.output as SearchPlaceOutput);
    case 'route': return route(s.output as RouteOutput, hereAcc);
    case 'set_view': return setView(s.output as SetViewOutput);
    case 'make_share_link': return shareCard(s.output as ShareOutput);
    case 'plan_course': return course(s.output as CourseOutput);
    case 'check_route': return checkCard(s.output as CheckRouteOutput);
    case 'add_pin': return pin(s.output as AddPinOutput);
    case 'export_png': return png(s.output as ExportPngOutput);
    case 'export_route': return routeFile(s.output as ExportRouteOutput);
    case 'draft_osm_note': return note(s.output as NoteDraftOutput);
    case 'unknown_words': return card(html`<div class="card"><div>辞書にない言葉：${(s.output as UnknownWordsOutput).words.join('、')}（地物の検索には使えません）</div></div>`);
    default: return card(html`<div class="card"><h3>${s.title}</h3></div>`);
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
  <button class="btn" type="button" data-act="png"><svg width="18" height="18" aria-hidden="true"><use href="#i-dl"/></svg>画像</button>
  <button class="btn" type="button" data-act="gpx"><svg width="18" height="18" aria-hidden="true"><use href="#i-dl"/></svg>GPX（社内用）</button>
  <button class="btn" type="button" data-act="recipe"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 9a5.5 5.5 0 1 0 1.6-3.9M3.5 2.8v2.6h2.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>レシピ</button></div>`);

/** 操作ごとの「名前：入力」 */
const opsList = (steps: OpResult[], h2: string, od: string) => steps.length
  ? html`<div class="ph-h" style="margin-top:10px"><h2>${h2}</h2><span class="od">${od}</span></div>
    <div class="kv">${steps.map((s, i) => html`<div><b><span class="dotn sm">${i + 1}</span>${s.title}</b><span>${shownInput(s)}</span></div>`)}</div>` : '';

/** 「詳細」の欄（技術的な情報と外部通信の記録）。閉じておく。中身がなければ CSS で隠す。開いたかどうかは main.ts が覚える */
const advSection = (items: (Raw | undefined)[], net?: NetLog) =>
  html`<details class="adv"><summary>詳細</summary><div class="adv-body">${items}${netCard(net)}</div></details>`;

/** 日本語の依頼の結果：依頼、解釈（操作と入力）、操作ごとのカード、止まった理由、詳細 */
export function renderChat(text: string, res: ChatResponse, hereAcc?: number) {
  res.steps.forEach((s) => s.ok && remember(s.output));
  const cards = res.steps.map((s) => stepHtml(s, hereAcc));
  const stop = STOP[res.stop];
  return html`${close}<div class="req"><b>依頼</b>　${text}</div>
    ${opsList(res.steps, '解釈', '頼まれた言葉をこう受け取りました')}
    ${cards.map((c) => c.main)}
    ${stop ? html`<div class="card err"><div>${stop}${res.stop === 'error' && res.error ? `：${res.error}` : ''}</div></div>` : ''}
    ${foot}${advSection(cards.map((c) => c.adv), res.net)}`;
}

/** レシピの再実行（/?r=<id>）の結果。日本語の依頼の結果と同じ形で、Claude を使っていないことを見出しに出す。
 *  保存した人の現在地は「レシピを保存した人の現在地」という場所で返る（見ている人の現在地ではないので、精度も出さない） */
export function renderRecipe(res: RecipeRunResponse) {
  res.steps.forEach((s) => s.ok && remember(s.output));
  const r = res.recipe;
  const cards = res.steps.map((s) => stepHtml(s));
  return html`${close}<div class="ph-h"><h2>レシピ</h2><span class="badge b-ok">Claude を使わずに再実行</span></div>
    ${r.osm_as_of !== OSM_DATA_AS_OF ? html`<div class="od">いまのデータで実行したので、保存したときと結果が違うことがあります</div>` : ''}
    ${opsList(res.steps, '手順', '保存した操作を同じ順にやり直しました')}
    ${cards.map((c) => c.main)}
    ${foot}${advSection([advItem('レシピ', html`<div class="note">ID <span class="mono">${r.id}</span>・保存 ${r.created_at.slice(0, 10)}・保存したときの OSM ${r.osm_as_of.slice(0, 10)}</div>`), ...cards.map((c) => c.adv)], res.net)}`;
}

/** 札（AI を通さない）の結果 */
export function renderDirect(steps: OpResult[]) {
  steps.forEach((s) => s.ok && remember(s.output));
  const cards = steps.map((s) => stepHtml(s));
  return html`${close}<div class="ph-h"><h2>この画面の範囲</h2><span class="badge b-ok">AIを通さない</span></div>
    ${cards.map((c) => c.main)}
    ${foot}${advSection([html`<div class="note">${CHIP_SOURCE}</div>`, ...cards.map((c) => c.adv)], (steps.at(-1) as { net?: NetLog } | undefined)?.net)}`;
}

export const renderError = (msg: string) => html`${close}<div class="card err" style="margin-top:0"><div>${msg}</div></div>${foot}${advSection([])}`;
export const renderWait = () => html`<div class="wait">ことづてが地図を操作しています…</div>`;
