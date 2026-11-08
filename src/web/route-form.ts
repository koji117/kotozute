// ルートのフォーム（AI を通さない）。出発・経由地・目的地を選んで、自社の Valhalla でルートを引く。
// サーバに渡すのは参照（here:、click:N、result:N、abr:N、osm:…）だけ。貼った座標も click:N にしてから使う。
import type { GeocodeOutput, LngLat, Mode, OpResult, Place, SearchPlaceOutput } from '../ops/types';
import { WIDENED_NOTE } from '../region-text';
import { parseCoord } from './jpcoord';
import { html, MODE_ICON, MODE_JA, nm, Raw, renderRouteForm } from './panel';

export interface RouteFormDeps {
  op(name: string, input: object): Promise<OpResult>;
  apply(steps: OpResult[]): LngLat[];
  fit(cs: LngLat[]): void;
  show(c: Raw, mode: string): void;
  addClick(at: LngLat): Promise<string | undefined>;
  /** 現在地を取る（公開版は試用の現在地）。使えなければ理由 */
  locate(): Promise<string | null>;
  /** いまの現在地の名前と添え書きと位置。なければ null */
  here(): { label: string; note: string; acc?: number; at: LngLat } | null;
  /** 画面の範囲 [西, 南, 東, 北] */
  bbox(): number[];
  /** 候補の印を、選んだもの（と住所）だけにする */
  keepPin(ref: string): void;
  toast(msg: string): void;
  zone?: number;
}

interface Field { text: string; ref?: string; note?: string; cands?: Place[]; wide?: boolean; more?: boolean; from?: [string, LngLat]; msg?: string; busy?: boolean }

/** 住所らしい文（「芝公園4-2-8」「港区芝公園四丁目」）。地名の後ろに 丁目・番・号 か 数字-数字 */
const ADDR = /^[^0-9０-９]+[0-9０-９一二三四五六七八九十]+\s*(丁目|番|号|[-－‐−ー][0-9０-９])/;
const ZERO = 'OSM上で見つかりません（現地にないとは限らない）';
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const MODES = Object.keys(MODE_JA) as Mode[]; // types.ts の MODES と同じ並び（zod を画面に入れないため、値は types.ts から読まない）
/** 2点の距離（m）。東京のあたりの近似 */
const meters = (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * 90000, (a[1] - b[1]) * 111000);
/** 範囲の中か。pad は広げる度数（0.0005 で約50m） */
const inBox = (c: LngLat, b?: number[], pad = 0) => !!b && c[0] >= b[0] - pad && c[0] <= b[2] + pad && c[1] >= b[1] - pad && c[1] <= b[3] + pad;
/** 1つの地物の面と点（東京タワーの面と、すぐそばのバス停など）か */
// ponytail: 同じ名前で 30 m 以内か、面から約50m以内なら同じ場所とみなす。並んだ同じ名前の店（ローソンなど）は残る
const same = (p: Place, q: Place) => p.name === q.name && (meters(p.coord, q.coord) < 30 || inBox(p.coord, q.bbox, 0.0005) || inBox(q.coord, p.bbox, 0.0005));
const dedupe = (ps: Place[]) => ps.filter((p, k) => !ps.slice(0, k).some((q) => same(p, q)));
/** 候補の見分け：「現在地から北に600m」 */
const DIRS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
function hint([o, a]: [string, LngLat], c: LngLat) {
  const m = meters(a, c), k = Math.round((Math.atan2((c[0] - a[0]) * 90000, (c[1] - a[1]) * 111000) * 180) / Math.PI / 45);
  return m < 20 ? `${o}のすぐ近く` : `${o}から${DIRS[(k + 8) % 8]}に${m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`}`;
}
const svg = (d: string, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const I_FIND = svg('M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.6 10.6L14 14');
const I_X = svg('M4 4l8 8M12 4l-8 8');
const I_SWAP = svg('M5 2.5v11M2.5 5L5 2.5 7.5 5M11 13.5v-11M8.5 11l2.5 2.5 2.5-2.5', 18);
const raw = (s: string) => new Raw(s); // 定数の線画だけ

export function routeForm(panel: HTMLElement, d: RouteFormDeps) {
  const f = { mode: 'car' as Mode, avoid: false, pts: [{ text: '' }, { text: '' }] as Field[], picking: null as Field | null, done: false, busy: false };
  const last = () => f.pts.length - 1;
  const role = (i: number) => (i === 0 ? '出発' : i === last() ? '目的地' : `経由地${i}`);
  const mark = (i: number) => (i === 0 ? '出' : i === last() ? '終' : String(i)); // 地図の印と同じ
  const isOpen = () => !panel.hidden && panel.dataset.mode === 'route' && !!panel.querySelector('#rf');
  const ready = () => !!f.pts[0].ref && !!f.pts[last()].ref && f.pts.every((p) => p.ref || !p.text.trim());

  // ===== 描く =====
  const extra = (p: Field) => html`
    ${p.busy ? html`<div class="note">探しています…</div>` : ''}
    ${p.msg ? html`<div class="zero" role="alert">${p.msg}</div>` : ''}
    ${p.ref && p.note ? html`<div class="note">${p.note}</div>` : ''}
    ${p.cands ? html`${p.wide ? html`<div class="note">${WIDENED_NOTE}</div>` : ''}<ol class="rf-cands" aria-label="候補">${p.cands.map((c, k) => html`
      <li><button type="button" data-rf="cand" data-k="${k}"><span class="dotn sm">${k + 1}</span><span>${nm(c)}</span>${p.from ? html`<small>${hint(p.from, c.coord)}</small>` : ''}</button></li>`)}</ol>
      ${p.more ? html`<div class="note">ほかにもあります。地図を拡大して探すと絞れます</div>` : ''}` : ''}`;
  const field = (p: Field, i: number) => html`
    <div class="rf-f${p.ref ? ' set' : ''}" data-i="${i}">
      <span class="dotn">${mark(i)}</span>
      <label for="rf-${i}">${role(i)}</label>
      <div class="rf-in">
        <input id="rf-${i}" value="${p.text}" maxlength="100" autocomplete="off" enterkeyhint="search" placeholder="場所の名前・住所・座標">
        <button type="button" data-rf="find" aria-label="${role(i)}を探す">${raw(I_FIND)}</button>
        ${i > 0 && i < last() ? html`<button type="button" data-rf="del" aria-label="${role(i)}を外す">${raw(I_X)}</button>` : ''}
      </div>
      <div class="rf-x">${extra(p)}</div>
      <div class="rf-sub">
        <button type="button" class="rf-lnk" data-rf="here">現在地</button>
        <button type="button" class="rf-lnk" data-rf="pick" aria-pressed="${String(f.picking === p)}">地図で選ぶ</button>
      </div>
    </div>`;
  const modes = () => html`<div class="rf-modes" role="group" aria-label="移動の手段">${MODES.map((m) => html`
    <button type="button" class="rf-mode" data-rf="mode" data-m="${m}" aria-pressed="${String(f.mode === m)}">${MODE_ICON[m]}<span>${MODE_JA[m]}</span></button>`)}</div>`;
  const form = () => html`<div id="rf"><div class="ph-h"><h2>ルート</h2><span class="badge b-ok">AIを通さない</span></div>
    ${modes()}
    ${f.done ? html`${f.busy ? html`<div class="note">ルートを探しています…</div>` : ''}<div class="rf-act"><button type="button" class="btn" data-rf="edit">出発・目的地を変える</button></div>` : html`
      <div class="rf-pts">${f.pts.map(field)}
        <button type="button" class="rf-swap" data-rf="swap" aria-label="出発と目的地を入れ替える">${raw(I_SWAP)}</button></div>
      ${f.pts.length < 5 ? html`<button type="button" class="rf-lnk rf-add" data-rf="add">＋ 経由地を足す</button>` : ''}
      ${f.mode === 'car' ? html`<label class="rf-chk"><input type="checkbox" data-rf="avoid"${f.avoid ? raw(' checked') : ''}>高速を使わない</label>` : ''}
      <div class="rf-act"><button type="button" class="btn primary" data-rf="go"${ready() && !f.busy ? '' : raw(' disabled')}>${f.busy ? 'ルートを探しています…' : 'ルートを検索'}</button></div>`}</div>`;

  /** 描き直す。押していたボタンにフォーカスを戻す（キーボードで使う人が、ページの先頭に戻されないように） */
  function refocus(paint: () => void) {
    const a = document.activeElement as HTMLElement | null;
    const k = a && panel.contains(a) ? a.dataset.rf : undefined, m = a?.dataset.m;
    paint();
    if (k) panel.querySelector<HTMLElement>(`#rf [data-rf="${k}"]${m ? `[data-m="${m}"]` : ''}`)?.focus();
  }
  /** フォームだけ描き直す（下のルートのカードと、あとから足した共有リンクなどは残す） */
  function redraw() {
    refocus(() => { const el = panel.querySelector('#rf'); if (el) el.outerHTML = form().s; });
  }
  const syncPick = () => panel.querySelectorAll('[data-rf=pick]').forEach((x) => x.setAttribute('aria-pressed', String(fieldOf(x) === f.picking)));
  /** 1つの欄の下だけ描き直す（入力中の文字と変換を壊さない） */
  function redrawField(p: Field) {
    const i = f.pts.indexOf(p), el = panel.querySelector<HTMLElement>(`.rf-f[data-i="${i}"]`);
    if (i < 0 || !el) return;
    el.classList.toggle('set', !!p.ref);
    const input = el.querySelector('input')!;
    if (input.value !== p.text) input.value = p.text;
    el.querySelector('.rf-x')!.innerHTML = extra(p).s;
    const go = panel.querySelector<HTMLButtonElement>('[data-rf=go]');
    if (go) go.disabled = !ready() || f.busy;
    syncPick();
  }
  const focusField = (i: number) => panel.querySelector<HTMLInputElement>(`#rf-${i}`)?.focus();
  /** 次の空いている欄へ。なければ検索のボタンへ */
  const focusNext = () => {
    const i = f.pts.findIndex((p) => !p.ref);
    if (i >= 0) focusField(i); else panel.querySelector<HTMLButtonElement>('[data-rf=go]')?.focus();
  };

  function open() {
    // 現在地が分かっていれば、出発は現在地にしておく
    const h = d.here(), p0 = f.pts[0];
    if (h && !p0.ref && !p0.text) Object.assign(p0, { ref: 'here:', text: h.label, note: h.note });
    f.done = false;
    d.show(renderRouteForm(form()), 'route');
    focusNext();
  }
  function choose(p: Field, ref: string, text: string, note = '') {
    Object.assign(p, { ref, text, note, cands: undefined, msg: undefined, wide: undefined, more: undefined });
    if (f.picking === p) f.picking = null;
    if (isOpen()) redrawField(p); // 閉じたあとに届いた結果では、ほかのパネルの上にフォームを開かない（次に開いたときに出る）
  }

  // ===== 欄に入れた文を場所にする：座標 → クリックした点、住所 → ABR、それ以外 → 名前の検索（画面の範囲） =====
  async function find(p: Field) {
    const text = p.text.trim();
    if (!text || p.busy) return;
    Object.assign(p, { busy: true, msg: undefined, cands: undefined, ref: undefined });
    redrawField(p);
    let got: [string, string, string] | undefined; // 決まった場所（参照、欄の文、添え書き）
    try {
      const c = parseCoord(text, d.zone);
      if (c && 'error' in c) p.msg = c.error;
      else if (c) {
        const at: LngLat = [r6(c.at[0]), r6(c.at[1])];
        const n = await d.addClick(at);
        if (n) { if (isOpen()) d.fit([at]); got = [`click:${n}`, `クリック${n}`, `${c.how}の点`]; }
      } else {
        const a = ADDR.test(text) ? await d.op('geocode_address', { address: text }) : null;
        if (a?.ok) {
          const o = a.output as GeocodeOutput;
          if (isOpen()) d.fit(d.apply([a]));
          got = [o.place.ref, nm(o.place), `住所・座標の精度：${o.precision}${o.unmatched ? `（一致しなかった部分：${o.unmatched}）` : ''}`];
        } else {
          // 住所として引けなければ、名前でも探す（「芝公園3丁目店」のような店の名前もあるので）
          // 候補の見分けの起点：現在地が画面の中なら現在地、でなければ探したときの地図の中心
          const h = d.here(), bb = d.bbox();
          const from: [string, LngLat] = h && inBox(h.at, bb) ? [h.label.replace(/（.*/, ''), h.at] : ['地図の中心', [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]];
          const s = await d.op('search_place', { name: text.slice(0, 40), area: 'view:' });
          if (!s.ok) p.msg = s.error.message;
          else {
            const o = s.output as SearchPlaceOutput, all = dedupe(o.items), items = all.slice(0, 5);
            // 住所の形なのに引けなかった。区市町村がないと ABR は町名から先を読めない
            if (!items.length) p.msg = a && !a.ok ? `${a.error.message}。住所は区市町村から入れてください（例：港区芝公園4-2-8）` : ZERO;
            else {
              if (isOpen()) d.fit(d.apply([{ ...s, output: { ...o, items } }])); // 地図にも候補の番号を出す
              Object.assign(p, { cands: items, wide: o.widened, more: o.truncated || all.length > 5, from });
            }
          }
        }
      }
    } catch (err) { p.msg = (err as Error).message; }
    p.busy = false;
    if (got) choose(p, ...got); else redrawField(p);
  }

  async function useHere(p: Field) {
    const why = d.here() ? null : await d.locate();
    const h = d.here();
    if (why || !h) { p.msg = why ?? '位置情報が使えません'; return redrawField(p); }
    choose(p, 'here:', h.label, h.note);
  }

  async function go() {
    if (!ready() || f.busy) return;
    f.busy = true;
    redraw();
    const [from, ...rest] = f.pts.filter((p) => p.ref);
    const to = rest.pop()!;
    const input = {
      from: from.ref, to: to.ref, stops: rest.map((p) => ({ ref: p.ref, word: null, stay_min: null })),
      arrive_by: null, keep_order: true, avoid_highways: f.mode === 'car' && f.avoid, mode: f.mode,
    };
    let r: OpResult;
    try { r = await d.op('route', input); } catch (err) {
      r = { op: 'route', title: 'ルート', source: 'direct', input, ok: false, error: { code: 'service', message: (err as Error).message } };
    }
    f.busy = false;
    if (!isOpen()) return; // 待つあいだに閉じた、ほかの札や依頼に替えた。ルートは描かない
    f.done = r.ok;
    const cam = r.ok ? d.apply([r]) : [];
    refocus(() => d.show(renderRouteForm(form(), r, d.here()?.acc), 'route'));
    d.fit(cam);
  }

  // ===== 操作 =====
  const fieldOf = (el: Element) => f.pts[Number(el.closest<HTMLElement>('.rf-f')?.dataset.i ?? -1)];
  panel.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-rf]');
    if (!b || !panel.querySelector('#rf')?.contains(b)) return;
    const p = fieldOf(b), act = b.dataset.rf;
    if (act === 'mode') {
      if (f.busy) return; // 引いている途中は替えない（押した印とルートのカードが食い違うので）
      f.mode = b.dataset.m as Mode;
      if (f.done) go(); else redraw(); // ルートを出したあとなら、すぐ引き直す
    }
    if (act === 'edit') { f.done = false; redraw(); focusField(0); }
    if (act === 'swap') { f.pts.reverse(); redraw(); }
    if (act === 'add') { f.pts.splice(last(), 0, { text: '' }); redraw(); focusField(last() - 1); }
    if (act === 'del' && p) { const i = f.pts.indexOf(p); f.pts.splice(i, 1); redraw(); focusField(i - 1); }
    if (act === 'find' && p) find(p);
    if (act === 'here' && p) useHere(p);
    if (act === 'pick' && p) {
      f.picking = f.picking === p ? null : p;
      syncPick();
      if (f.picking) d.toast(`地図をクリックして、${role(f.pts.indexOf(p))}を選んでください`);
    }
    if (act === 'cand' && p?.cands) {
      const c = p.cands[Number(b.dataset.k)];
      d.keepPin(c.ref);
      choose(p, c.ref, nm(c));
      focusNext();
    }
    if (act === 'go') go();
  });
  panel.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.rf === 'avoid') f.avoid = t.checked;
  });
  panel.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const p = t.id.startsWith('rf-') ? fieldOf(t) : undefined;
    if (!p) return;
    // 書き換えたら、選んだ場所はいったん外す（下の欄だけ描き直す。入力の要素は替えない）
    Object.assign(p, { text: t.value, ref: undefined, cands: undefined, msg: undefined });
    redrawField(p);
  });
  panel.addEventListener('keydown', (e) => {
    const t = e.target as HTMLInputElement;
    const p = t.id?.startsWith('rf-') ? fieldOf(t) : undefined;
    if (!p) return;
    if (e.key === 'ArrowDown' && p.cands) { e.preventDefault(); t.closest('.rf-f')?.querySelector<HTMLButtonElement>('[data-rf=cand]')?.focus(); }
    // 日本語入力の変換確定の Enter では探さない（main.ts の検索の欄と同じ）
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (!p.ref) find(p); else if (ready()) go(); else focusNext();
  });

  return {
    open,
    /** 「地図で選ぶ」の途中なら、クリックした点をその欄に入れて true */
    async click(at: LngLat): Promise<boolean> {
      const p = f.picking;
      f.picking = null;
      syncPick();
      if (!p || !isOpen()) return false; // フォームを閉じたら、選ぶのもやめる
      const n = await d.addClick(at);
      if (n && f.pts.includes(p)) choose(p, `click:${n}`, `クリック${n}`, '地図で選んだ点');
      return true;
    },
    /** 地点のカードの「ここから出発」「ここへ行く」。ref がない地図の地点（タイルには名前しかない）は、
     *  近くの同じ名前の OSM の地点（result:N）にする。ルートのカードや共有リンクに名前が出るように。なければクリックした点 */
    async put(which: 'from' | 'to', at: LngLat, ref?: string, name?: string) {
      if (!ref && name) {
        const s = await d.op('search_place', { name: name.slice(0, 40), area: 'view:' }).catch(() => null);
        ref = s?.ok ? (s.output as SearchPlaceOutput).items.find((q) => meters(q.coord, at) < 50 || inBox(at, q.bbox))?.ref : undefined;
      }
      if (!ref) {
        const n = await d.addClick(at);
        if (!n) return;
        [ref, name] = [`click:${n}`, name ?? `クリック${n}`];
      }
      if (!isOpen()) open();
      else if (f.done) { f.done = false; redraw(); }
      choose(f.pts[which === 'from' ? 0 : last()], ref, name ?? ref);
      focusNext();
    },
  };
}
