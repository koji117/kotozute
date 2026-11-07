// 受け付ける範囲（設計書 §7 の 4）：都道府県の境界を、OSM の pbf から osmium と Node だけで作る（Overpass なし）。
// 元は ~/kotozute-setup-lab/region/boundary.mjs（東京で作り直すと、今の tokyo-boundary.json と 2000点中2000点一致）。
// 島の規則：外側の輪どうしの最短の距離が gapKm 以内なら1つのまとまり。県庁所在地（relation の admin_centre）の輪を含むまとまりを残す
// （islands=all なら全部）。輪の面積は使わない（OSM では島の輪が大きな海の多角形のことがある。東京の伊豆の輪は本土より大きい）。
// 出力は県ごとの輪のまとまり（src/services/region.ts の { groups }）。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BBox, LngLat } from '../../src/ops/types';
import type { Log, Osmium } from './tools';

type Ring = LngLat[];

/** osmium を回して標準出力を返す。okCodes 以外の終了コードなら stderr の最後をつけて止める */
function exec(osmium: Osmium, args: string[], okCodes = [0]): Promise<string> {
  const p = osmium(args);
  const out: Buffer[] = [];
  let err = '';
  p.stdout!.on('data', (d: Buffer) => out.push(d));
  p.stderr!.on('data', (d) => (err = (err + d).slice(-2000)));
  return new Promise((res, rej) => {
    p.on('error', (e) => rej(new Error(`osmium を起動できません：${e.message}`)));
    p.on('close', (code) => (okCodes.includes(code ?? -1) ? res(Buffer.concat(out).toString()) : rej(new Error(`osmium ${args[0]} が失敗しました（終了コード ${code}）：${err.trim()}`))));
  });
}

// ===== 形の計算（平面近似。県の大きさなら十分） =====
export const bboxOf = (pts: LngLat[]): BBox =>
  pts.reduce<BBox>(([w, s, e, n], [x, y]) => [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)], [Infinity, Infinity, -Infinity, -Infinity]);
/** 偶奇規則（src/services/region.ts と同じ） */
export function inRings(rings: Ring[], [x, y]: LngLat): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
function ringKm2(r: Ring): number {
  const lat0 = r.reduce((s, p) => s + p[1], 0) / r.length;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * kx * (r[i][1] * ky) - r[i][0] * kx * (r[j][1] * ky);
  return Math.abs(a) / 2;
}
export function km([x1, y1]: LngLat, [x2, y2]: LngLat): number {
  const kx = 111.32 * Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
  return Math.hypot((x2 - x1) * kx, (y2 - y1) * 110.57);
}
function segKm(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = 111.32 * Math.cos((p[1] * Math.PI) / 180), ky = 110.57;
  const [px, py, ax, ay, bx, by] = [p[0] * kx, p[1] * ky, a[0] * kx, a[1] * ky, b[0] * kx, b[1] * ky];
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
/** Douglas-Peucker（度のまま。scripts/build-tokyo-boundary.ts と同じ許容の意味） */
function simplify(pts: Ring, tol: number): Ring {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [a, b] = [pts[s], pts[e]];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    let max = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [x, y] = pts[i];
      const d = L ? Math.abs(dy * x - dx * y + b[0] * a[1] - b[1] * a[0]) / L : Math.hypot(x - a[0], y - a[1]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** 閉じた輪は半分に分けて間引く（両端が残るように。リポジトリのスクリプトと同じ） */
const simplifyRing = (r: Ring, tol: number): Ring => {
  const h = r.length >> 1;
  return [...simplify(r.slice(0, h + 1), tol).slice(0, -1), ...simplify(r.slice(h), tol)];
};

// ===== OPL を読む =====
const unesc = (s: string) => s.replace(/%([0-9a-f]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
interface Rel { id: string; tags: Record<string, string>; members: { ref: string; role: string }[] }
function parseRel(line: string): Rel {
  const tok = Object.fromEntries(line.split(' ').map((t) => [t[0], t.slice(1)]));
  const tags = Object.fromEntries((tok.T ?? '').split(',').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return [unesc(kv.slice(0, i)), unesc(kv.slice(i + 1))]; }));
  const members = tok.M ? tok.M.split(',').map((m) => { const [ref, role = ''] = m.split('@'); return { ref, role }; }) : [];
  return { id: tok.r, tags, members };
}

interface Node { id: string; p: LngLat }
/** way を端の点の番号でつないで輪にする。pbf の外にある部品で開いたままの鎖は、いちばん近い端へ直線で閉じる */
function assemble(lines: Node[][]): { rings: Ring[]; open: number; maxGapKm: number } {
  const byEnd = new Map<string, number[]>();
  lines.forEach((l, i) => { for (const n of [l[0].id, l.at(-1)!.id]) byEnd.set(n, [...(byEnd.get(n) ?? []), i]); });
  const used = new Uint8Array(lines.length), rings: Ring[] = [], chains: Ring[] = [];
  for (let s = 0; s < lines.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const ring = [...lines[s]];
    while (ring[0].id !== ring.at(-1)!.id) {
      const end = ring.at(-1)!.id;
      const i = (byEnd.get(end) ?? []).find((k) => !used[k]);
      if (i === undefined) break;
      used[i] = 1;
      const l = lines[i];
      ring.push(...(l[0].id === end ? l : [...l].reverse()).slice(1));
    }
    (ring[0].id === ring.at(-1)!.id ? rings : chains).push(ring.map((n) => n.p));
  }
  // 例：九州の pbf の福岡県は、関門・響灘の海の way が1本 pbf の外にある。
  // ponytail: 足りない way を直線で置き換える。海の境なら十分。長い隙間は記録に出すので気づける
  const gaps: number[] = [];
  while (chains.length) {
    let c = chains.shift()!;
    for (;;) {
      const end = c.at(-1)!;
      let best = { d: km(end, c[0]), k: -1, rev: false };
      chains.forEach((o, k) => { for (const rev of [false, true]) { const d = km(end, rev ? o.at(-1)! : o[0]); if (d < best.d) best = { d, k, rev }; } });
      gaps.push(best.d);
      if (best.k < 0) { rings.push([...c, c[0]]); break; }
      const [o] = chains.splice(best.k, 1);
      c = [...c, ...(best.rev ? [...o].reverse() : o)];
    }
  }
  return { rings, open: gaps.length, maxGapKm: gaps.length ? Math.max(...gaps) : 0 };
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * prefs（JIS の2桁、例 '13'）の境界を作る。work は作業の場所（終わったら消す。コンテナの osmium のときは osmium のフォルダの中）。
 * dropped：島のまとまりを1つでも外したか（地域の名前に「（島しょ部を除く）」を付けるため）
 */
export async function buildBoundary(o: { pbf: string; prefs: string[]; islands: 'main' | 'all'; work: string; osmium: Osmium; log: Log; gapKm?: number; tol?: number }):
  Promise<{ groups: Ring[][]; bbox: BBox; dropped: boolean }> {
  const GAP_KM = o.gapKm ?? 5, TOL = o.tol ?? 0.0002, ALL = o.islands === 'all';
  const isos = o.prefs.map((p) => `JP-${p.padStart(2, '0')}`);

  // 1. 都道府県の relation（admin_level=4、ISO3166-2=JP-nn）。-R：参照する way は出さない
  const opl = await exec(o.osmium, ['tags-filter', '-R', o.pbf, `r/ISO3166-2=${isos.join(',')}`, '-f', 'opl', '-o', '-']);
  const rels = opl.split('\n').filter((l) => l.startsWith('r')).map(parseRel).filter((r) => r.tags.admin_level === '4' && r.tags.boundary === 'administrative');
  const byIso = new Map(rels.map((r) => [r.tags['ISO3166-2'], r]));
  const lost = isos.filter((i) => !byIso.has(i));
  if (lost.length) throw new Error(`都道府県の境界（${lost.join('、')}）が OSM データにありません。地域と OSM データの組み合わせを確かめてください`);

  // 2. 部品の way（点の位置つき）と、県庁所在地の点を1回で抜き出す
  const wanted = (r: Rel) => r.members.filter((m) => m.ref[0] === 'w' && (m.role === 'outer' || m.role === 'inner' || m.role === ''));
  const centreRef = (r: Rel) => (r.members.find((m) => m.role === 'admin_centre') ?? r.members.find((m) => m.role === 'label'))?.ref;
  mkdirSync(o.work, { recursive: true });
  const ids = [...new Set(rels.flatMap((r) => [...wanted(r).map((m) => m.ref), centreRef(r)].filter((x): x is string => !!x)))];
  writeFileSync(join(o.work, 'ids'), ids.join('\n') + '\n');
  try {
    // getid は pbf にない番号があると 1 で終わる（Geofabrik の切り出しの外の部品）。それは想定どおり
    await exec(o.osmium, ['getid', '-r', '-O', o.pbf, '-i', join(o.work, 'ids'), '-o', join(o.work, 'w.osm.pbf')], [0, 1]);
    const located = await exec(o.osmium, ['add-locations-to-ways', '--ignore-missing-nodes', join(o.work, 'w.osm.pbf'), '-f', 'opl', '-o', '-']);
    const ways = new Map<string, Node[]>(), nodes = new Map<string, LngLat>();
    for (const l of located.split('\n')) {
      if (l[0] === 'n') {
        const x = / x([-\d.]+)/.exec(l), y = / y([-\d.]+)/.exec(l);
        if (x && y) nodes.set(l.slice(0, l.indexOf(' ')), [Number(x[1]), Number(y[1])]);
      } else if (l[0] === 'w') {
        const ns = l.slice(l.lastIndexOf(' N') + 2).split(',').map((n) => {
          const m = /^n(\d+)x([-\d.]+)y([-\d.]+)$/.exec(n);
          return m ? { id: m[1], p: [Number(m[2]), Number(m[3])] as LngLat } : null;
        });
        if (ns.every(Boolean)) ways.set(l.slice(0, l.indexOf(' ')), ns as Node[]);
      }
    }

    // 3. 県ごとに輪を組み、島のまとまりを決める
    let dropped = false;
    const groups = isos.map((iso) => {
      const rel = byIso.get(iso)!;
      const w = wanted(rel);
      const outer = assemble(w.filter((m) => m.role !== 'inner' && ways.has(m.ref)).map((m) => ways.get(m.ref)!));
      const inner = assemble(w.filter((m) => m.role === 'inner' && ways.has(m.ref)).map((m) => ways.get(m.ref)!));
      const R = outer.rings.map((raw) => { const s = simplifyRing(raw, TOL); return { raw, s, km2: ringKm2(raw), bb: bboxOf(s) }; });
      const bbGap = (a: BBox, b: BBox) => km([Math.max(a[0], Math.min(b[0], a[2])), Math.max(a[1], Math.min(b[1], a[3]))], [Math.max(b[0], Math.min(a[0], b[2])), Math.max(b[1], Math.min(a[1], b[3]))]);
      const gap = (a: (typeof R)[0], b: (typeof R)[0]) => {
        if (bbGap(a.bb, b.bb) > GAP_KM) return Infinity;
        const [p, q] = a.s.length < b.s.length ? [a.s, b.s] : [b.s, a.s];
        let m = Infinity;
        for (const pt of p) for (let i = 1; i < q.length && m > 0; i++) m = Math.min(m, segKm(pt, q[i - 1], q[i]));
        return m;
      };
      // ponytail: まとまりは輪の組を全部比べる（O(n²)）。日本全国の島の多い県でも数秒。遅ければ格子で近い輪だけ比べる
      const parent = R.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      const order = R.map((_, i) => i).sort((a, b) => R[b].km2 - R[a].km2);
      for (let x = 0; x < order.length; x++) for (let y = x + 1; y < order.length; y++) {
        const [i, j] = [order[x], order[y]];
        if (find(i) !== find(j) && gap(R[i], R[j]) <= GAP_KM) parent[find(j)] = find(i);
      }
      const ref = centreRef(rel), centre = ref ? nodes.get(ref) : undefined;
      const centreRing = centre ? R.findIndex((r) => inRings([r.raw], centre)) : -1;
      const main = find(centreRing >= 0 ? centreRing : order[0]);
      const keptIdx = R.map((_, i) => i).filter((i) => ALL || find(i) === main);
      if (keptIdx.length < R.length) dropped = true;
      const keptBB = keptIdx.map((i) => R[i].bb);
      const inn = inner.rings.map((r) => simplifyRing(r, TOL)).filter((r) => { const b = bboxOf(r); return keptBB.some((k) => b[0] >= k[0] && b[2] <= k[2] && b[1] >= k[1] && b[3] <= k[3]); });
      o.log(`境界：${rel.tags.name ?? iso}（relation/${rel.id}）外側の輪 ${outer.rings.length}（直線で閉じた隙間 ${outer.open}、最大 ${outer.maxGapKm.toFixed(2)} km）、残した輪 ${keptIdx.length}${centreRing < 0 ? '、県庁所在地の輪が見つからないので最大の輪を基準にした' : ''}`);
      return [...keptIdx.map((i) => R[i].s), ...inn].map((r) => r.map(([x, y]) => [r5(x), r5(y)] as LngLat));
    });
    const b = bboxOf(groups.flat(2));
    const bbox = b.map((v, k) => Math.round(v * 1e4 + (k < 2 ? -0.5 : 0.5)) / 1e4) as BBox;
    return { groups, bbox, dropped };
  } finally {
    rmSync(o.work, { recursive: true, force: true });
  }
}

/** 地図の動かせる範囲：境界の範囲＋2km を 0.01 度で外へ丸める */
export function mapBBox([w, s, e, n]: BBox, marginKm = 2): BBox {
  const lat = (s + n) / 2;
  const dx = marginKm / (111.32 * Math.cos((lat * Math.PI) / 180)), dy = marginKm / 110.57;
  const out = (v: number, up: boolean) => (up ? Math.ceil(v * 100) : Math.floor(v * 100)) / 100;
  return [out(w - dx, false), out(s - dy, false), out(e + dx, true), out(n + dy, true)];
}
