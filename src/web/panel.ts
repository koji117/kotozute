// 結果パネルの文章。すべて操作の結果（OpResult）からテンプレートで作る。Claude の文章は出さない。
import { ATTRIBUTION, OSM_DATA_AS_OF } from '../attribution';
import { DICT, type DictKey } from '../ops/dict';
import type {
  AddPinOutput, ChatResponse, CheckOutput, CheckRouteOutput, CheckRow, CourseOutput, ExportPngOutput, ExportRouteOutput, FindFeaturesOutput,
  GeocodeOutput, NetLog, OpResult, Place, RecipeRunResponse, RecipeSaved, RouteOutput, SearchPlaceOutput, SetViewOutput, ShareOutput,
  UnknownWordsOutput, Verdict,
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
  toilets: '#5A646B', park: '#18703E', station: '#12343B', hospital: '#B3261E', level_crossing: '#B3261E', foot_crossing: '#734700', tunnel: '#12343B',
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
  start: '出発・到着', tunnels: 'トンネル（本）', max_minutes: '時間の上限（分）',
  format: '形式',
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
      <div class="sec"><span class="sw" style="background:${COLOR[g.word]}"></span>${g.label} ${g.count}${g.word === 'tunnel' ? '本' : '件'}${g.truncated ? '以上' : ''}</div>
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
    ${o.widened ? html`<div class="note">画面の中になかったので、東京都全体から探しました</div>` : ''}
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

// ===== 合否表（plan_course、check_route） =====
// 印の中の線（✓・×）は --ic-mark の色。塗りの札（.verdict）では札の色にして抜く
const icon = (d: string) => raw(`<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">${d}</svg>`);
const V_ICON: Record<Verdict, Raw> = {
  pass: icon('<circle cx="10" cy="10" r="9" fill="currentColor"/><path d="M5.6 10.2l3 3 5.8-6.2" fill="none" style="stroke:var(--ic-mark)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  fail: icon('<rect x="1.5" y="1.5" width="17" height="17" rx="3" fill="currentColor"/><path d="M6.5 6.5l7 7M13.5 6.5l-7 7" style="stroke:var(--ic-mark)" stroke-width="2.2" stroke-linecap="round"/>'),
  unknown: icon('<circle cx="10" cy="10" r="8.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.6 2"/><path d="M7.6 7.7a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.6" r="1.1" fill="currentColor"/>'),
};
const CLOCK = icon('<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6v4.3l2.8 1.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>');
const V_TEXT: Record<Verdict, string> = { pass: '合格', fail: '不合格', unknown: '判定不能' };
const V_BADGE: Record<Verdict, string> = { pass: 'b-ok', fail: 'b-ng', unknown: 'b-unk' };
const judged = (v: Verdict) => html`<span class="badge ${V_BADGE[v]}">${V_ICON[v]}${V_TEXT[v]}</span>`;
const verdictTag = (v: Verdict) => html`<span class="verdict v-${v}">${V_ICON[v]}${V_TEXT[v]}</span>`;

function checkRow(r: CheckRow) {
  const [c, v] =
    r.kind === 'tunnels' ? [html`<i class="sw-tun"></i>${r.want ? `トンネル ${r.want}本` : 'トンネルを通らない'}`, html`${r.got}${r.want ? `/${r.want}` : ''}<small>本</small>`]
    : r.kind === 'minutes' ? [html`${CLOCK}${r.want}分以内`, html`${r.got}<small>分</small>`]
    : [html`<i class="sw-route"></i>高速を使わない`, r.got ? html`${r.got}<small>km 通る</small>` : html`<span class="muted">通らない</span>`];
  return html`<div class="c">${c}</div><div class="v">${v}</div><div class="j">${judged(r.result)}</div>`;
}

/** 合否表。車線数は参考の行（合否に使わない） */
function checkTable(c: CheckOutput) {
  const n = c.lanes.untagged_runs, u = n ? 'u' : '';
  const counted = c.tunnels.filter((t) => !t.skip), skipped = c.tunnels.filter((t) => t.skip);
  const tname = (t: CheckOutput['tunnels'][number]) => t.name ?? '名前なし';
  return html`<div class="vt">
      ${c.rows.map(checkRow)}
      <div class="c ${u}"><i class="sw-unk"></i>車線数（参考）</div>
      <div class="v ${u}">${n ? html`${n}<small>区間</small>` : html`<span class="muted">すべてタグあり</span>`}</div>
      <div class="j ${u}">${n ? judged('unknown') : ''}</div>
    </div>
    <div class="od" style="margin-top:6px">車線数のタグ（lanes）があるのはコースの ${Math.round(c.lanes.tagged_share * 100)}%${n ? `。タグのない ${n}区間は判定不能` : ''}（車線数は合否に使いません）</div>
    <div class="note">トンネルの数え方：連続する tunnel=yes を1本、50m未満は数えない。同じトンネルを2回通ったら（上下線など）1本</div>
    ${counted.length ? html`<div class="note">数えたトンネル：${counted.map((t) => `${tname(t)}（${dist(t.m / 1000)}）`).join('、')}</div>` : ''}
    ${skipped.length ? html`<div class="note">数えなかったもの：${skipped.map((t) => `${tname(t)}（${t.skip === 'short' ? `${t.m} m・50m未満` : '2回目'}）`).join('、')}</div>` : ''}
    ${c.missing ? html`<div class="note">OSM のタグを取り直せなかった道が ${c.missing}本あります</div>` : ''}`;
}

const STOPPED: Record<NonNullable<CourseOutput['stopped_by']>, string> = {
  attempts: '案の上限（5案）まで試しました', routes: 'ルート計算の上限（10回）まで試しました',
  candidates: '経由地にできるトンネルの候補を使い切りました', other: 'トンネルを足しても直らない条件があります',
};

function course(o: CourseOutput) {
  const i = o.chosen ?? o.attempts.length - 1, a = o.attempts[i], v = a.check.verdict;
  const start = nm(o.start);
  return html`<div class="card">
    <div class="ph-h"><h2>合否表</h2>${verdictTag(v)}
      <span class="chipline">${o.attempts.map((x, k) => html`<span class="${k === i ? 'on' : ''}">${k + 1}回目${k === i ? '' : ` ${V_TEXT[x.check.verdict]}`}</span>`)}</span></div>
    <div class="od" style="margin-top:6px">${start} 発着（周回）・${min(a.minutes)}・${km(a.km)}・経由：${a.via.map((x) => x.name ?? '名前なし').join('、')}</div>
    <div class="kv"><div><b>解釈</b><span>トンネル＝道路の tunnel=yes（連続する区間は1本）${o.conditions.avoid_highways ? '／高速＝高速道路と有料道路を除外して計算' : ''}／${start}から${start}へ（周回）</span></div></div>
    ${checkTable(a.check)}
    <div class="note">経由地の候補はプログラムが作りました：出発地から${o.radius_m / 1000}km以内の名前のある道路トンネル ${o.candidates}本（有料・自動車専用・車両通行不可・高さ2.1m未満の ${o.excluded}本は除外）。ルート計算 ${o.routes}回</div>
    ${o.chosen == null ? html`<div class="zero">条件を満たすコースは見つかりませんでした（${STOPPED[o.stopped_by ?? 'other']}）。地図には最後の案を出しています</div>` : ''}
  </div>`;
}

function checkCard(o: CheckRouteOutput) {
  return html`<div class="card">
    <div class="ph-h"><h2>合否表</h2>${verdictTag(o.verdict)}</div>
    <div class="od" style="margin-top:6px">いま地図にあるルート：${o.from} → ${o.to}・${min(o.minutes)}・${km(o.km)}</div>
    ${checkTable(o)}
  </div>`;
}

export function shareCard(o: ShareOutput) {
  return html`<div class="card"><h3>共有リンク</h3>
    <div class="share"><input readonly value="${location.origin + o.url}" aria-label="共有リンク"><button class="btn" type="button" data-act="copy">コピー</button></div>
    <div class="note">開いた人は、同じ地図を読み取りだけで見られます</div>
    ${o.includes_here ? html`<div class="note warn">このリンクには、あなたの現在地が入っています</div>` : ''}</div>`;
}

function pin(o: AddPinOutput) {
  return html`<div class="card"><div class="t"><span class="dotn pin" aria-hidden="true"></span><h3>${nm(o.pin)}</h3></div>
    <div class="note">ピンを立てました（全部で${o.count}本）。共有リンクと画像に入ります</div></div>`;
}

function png(o: ExportPngOutput) {
  return html`<div class="card"><h3>資料用の画像</h3>
    <div class="note">${o.mode === 'file' ? `保存しました：${o.path}` : '地図を画像にしました'}。出典（${ATTRIBUTION.osm.text} ほか）とデータ時点を画像の下に焼き込んであります</div></div>`;
}

function routeFile(o: ExportRouteOutput) {
  return html`<div class="card"><h3>${o.filename.endsWith('.gpx') ? 'GPX' : 'GeoJSON'}（社内用）を書き出しました</h3>
    <div class="note">${o.filename}</div><div class="note warn">${o.warning}</div></div>`;
}

export function recipeCard(o: RecipeSaved) {
  return html`<div class="card recipe"><h3>レシピ</h3>
    <div class="od">ID <span class="mono">${o.id}</span>・操作 ${o.steps.length}回</div>
    <div class="share"><a class="btn primary" href="${o.url}" target="_blank" rel="noopener">再実行</a></div>
    <div class="note">Claude を使わずに、同じ操作を同じ順にやり直します（いまの OSM のデータで）</div>
    ${o.includes_here ? html`<div class="note warn">このレシピには、あなたの現在地が入っています</div>` : ''}</div>`;
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

export function stepHtml(s: OpResult, hereAcc?: number): Raw {
  if (!s.ok) return html`<div class="card err"><h3>${s.title}</h3><div>${s.error.message}</div></div>`;
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
  <button class="btn" type="button" data-act="png"><svg width="18" height="18" aria-hidden="true"><use href="#i-dl"/></svg>画像</button>
  <button class="btn" type="button" data-act="gpx"><svg width="18" height="18" aria-hidden="true"><use href="#i-dl"/></svg>GPX（社内用）</button>
  <button class="btn" type="button" data-act="recipe"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 9a5.5 5.5 0 1 0 1.6-3.9M3.5 2.8v2.6h2.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>レシピ</button></div>`);

/** 操作ごとの「名前：入力」と、結果のカード */
const opsHtml = (steps: OpResult[], hereAcc: number | undefined, h2: string, od: string) => html`
  ${steps.length ? html`<div class="ph-h" style="margin-top:10px"><h2>${h2}</h2><span class="od">${od}</span></div>
    <div class="kv">${steps.map((s) => html`<div><b>${s.title}</b><span>${shownInput(s)}</span></div>`)}</div>` : ''}
  ${steps.map((s) => stepHtml(s, hereAcc))}`;

/** 日本語の依頼の結果：依頼、解釈（操作と入力）、操作ごとのカード、止まった理由 */
export function renderChat(text: string, res: ChatResponse, hereAcc?: number) {
  res.steps.forEach((s) => s.ok && remember(s.output));
  const stop = STOP[res.stop];
  return html`${close}<div class="req"><b>依頼</b>　${text}</div>
    ${opsHtml(res.steps, hereAcc, '解釈', '頼まれた言葉をこう受け取りました')}
    ${stop ? html`<div class="card err"><div>${stop}${res.stop === 'error' && res.error ? `：${res.error}` : ''}</div></div>` : ''}
    ${foot}${netCard(res.net)}`;
}

/** レシピの再実行（/?r=<id>）の結果。日本語の依頼の結果と同じ形で、Claude を使っていないことを見出しに出す */
export function renderRecipe(res: RecipeRunResponse, hereAcc?: number) {
  res.steps.forEach((s) => s.ok && remember(s.output));
  const r = res.recipe;
  return html`${close}<div class="ph-h"><h2>レシピ</h2><span class="badge b-ok">Claude を使わずに再実行</span></div>
    <div class="od">ID <span class="mono">${r.id}</span>・保存 ${r.created_at.slice(0, 10)}・保存したときの OSM ${r.osm_as_of.slice(0, 10)}${
      r.osm_as_of !== OSM_DATA_AS_OF ? '（いまのデータで実行したので、結果が違うことがあります）' : ''}</div>
    ${opsHtml(res.steps, hereAcc, '手順', '保存した操作を同じ順にやり直しました')}
    ${foot}${netCard(res.net)}`;
}

/** 札（AI を通さない）の結果 */
export function renderDirect(steps: OpResult[]) {
  steps.forEach((s) => s.ok && remember(s.output));
  return html`${close}<div class="ph-h"><h2>この画面の範囲</h2><span class="badge b-ok">AIを通さない</span></div>
    ${steps.map((s) => stepHtml(s))}
    <div class="note">札は AI を通さずに、自社の Overpass へ直接たずねます</div>
    ${foot}${netCard((steps.at(-1) as { net?: NetLog } | undefined)?.net)}`;
}

export const renderError = (msg: string) => html`${close}<div class="card err" style="margin-top:0"><div>${msg}</div></div>${foot}`;
export const renderWait = () => html`<div class="wait">ことづてが地図を操作しています…</div>`;
