// 手元の検索データ（osm.db。scripts/setup/osm-index.ts が OSM の pbf から作る）から、自社の Overpass と同じ答えを返す。
// 要素の形（type、id、lat/lon か bounds、tags、nodes、geometry）、順（種類、ID）、件数の上限での切り方を Overpass に合わせる。
// 中身の選び方と範囲の上限の確認は src/services/osm.ts でする。node:sqlite は読み込むと警告が出るので、osm.ts から必要なときだけ読む。
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DICT, type DictKey } from '../ops/dict';
import { OpError, type BBox, type LngLat } from '../ops/types';
import type { Area, OsmElement } from './overpass';

/** geom の部品の区切り（経度・緯度の両方にこの値） */
export const SEP = -2147483648;
/** 検索データの形の版。作り方（表や列）を変えたら上げる */
const FORMAT = 2;
/** 作ったときの形の版と辞書の条件。読むときに今のものと比べ、違えば作り直してもらう */
export const dictSignature = () => JSON.stringify([FORMAT, Object.entries(DICT).map(([w, d]) => [w, d.queries])]);

const TYPES = ['node', 'way', 'relation'] as const;
/** Overpass の距離：子午線の4分の1が 10,000km の球（1度 = 1e7/90 m）。半径 6371km だと評価の b05 で駐車場が1件ずれる */
const M_PER_DEG = 1e7 / 90;

interface Row { fid: number; type: number; osm_id: number; minx: number; miny: number; maxx: number; maxy: number; tags: string; geom: Uint8Array | null; nodes: Uint8Array | null; ways: Uint8Array | null }
type Line = LngLat[];

/** geom の BLOB を部品ごとの折れ線にする */
function parts(blob: Uint8Array): Line[] {
  const a = new Int32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  const out: Line[] = [[]];
  for (let i = 0; i < a.length; i += 2) {
    if (a[i] === SEP) { out.push([]); continue; }
    out[out.length - 1].push([a[i] / 1e7, a[i + 1] / 1e7]);
  }
  return out;
}
/** 点や way の番号の BLOB（Float64） */
const f64 = (blob: Uint8Array) => [...new Float64Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))];

// ===== 形の判定（その場の平面近似、m） =====
const kxOf = (lat: number) => M_PER_DEG * Math.cos((lat * Math.PI) / 180);
function ptSeg(p: LngLat, a: LngLat, b: LngLat, kx: number): number {
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * M_PER_DEG, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * M_PER_DEG;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
const cross = (o: LngLat, a: LngLat, b: LngLat) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const segsCross = (a: LngLat, b: LngLat, c: LngLat, d: LngLat) => cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
const segs = (line: Line): [LngLat, LngLat][] => (line.length === 1 ? [[line[0], line[0]]] : line.slice(1).map((p, i) => [line[i], p]));
/** 地物の部品と、問い合わせの折れ線（Overpass の around の点の並び）とのいちばん近い距離（m） */
function distTo(fparts: Line[], poly: Line, kx: number): number {
  let d = Infinity;
  const qs = segs(poly);
  for (const part of fparts) for (const [a, b] of segs(part)) for (const [c, e] of qs) {
    if (segsCross(a, b, c, e)) return 0;
    d = Math.min(d, ptSeg(a, c, e, kx), ptSeg(b, c, e, kx), ptSeg(c, a, b, kx), ptSeg(e, a, b, kx));
  }
  return d;
}
/**
 * Overpass の bbox の判定：頂点が中にあるか、線が枠を横切る。relation は部品の点か部品の way のどれかがそうなら当たる
 * （範囲が重なるだけでは当たらない。閉じた way や multipolygon の内側だけの枠も当たらない。11/6 に自社の Overpass で確認）。
 * shape は範囲が枠に収まりきらないときだけ呼ぶ
 */
function inBox(r: Row, [w, s, e, n]: BBox, shape: (r: Row) => Line[]): boolean {
  if (r.maxx < w || r.minx > e || r.maxy < s || r.miny > n) return false;
  if (r.minx >= w && r.maxx <= e && r.miny >= s && r.maxy <= n) return true; // node はここまでで決まる
  const inside = ([x, y]: LngLat) => x >= w && x <= e && y >= s && y <= n;
  const edges: [LngLat, LngLat][] = [[[w, s], [e, s]], [[e, s], [e, n]], [[e, n], [w, n]], [[w, n], [w, s]]];
  return shape(r).some((part) => part.some(inside) || segs(part).some(([a, b]) => edges.some(([c, d]) => segsCross(a, b, c, d))));
}

/** Overpass の JSON の形。geom：way の形（out geom）、nodes：way の点の番号（out body） */
function element(r: Row, geom: boolean, nodes: boolean): OsmElement {
  const e: OsmElement = { type: TYPES[r.type], id: r.osm_id };
  if (r.type === 0) Object.assign(e, { lat: r.miny, lon: r.minx });
  else e.bounds = { minlat: r.miny, minlon: r.minx, maxlat: r.maxy, maxlon: r.maxx };
  if (r.type === 1 && nodes && r.nodes) e.nodes = f64(r.nodes);
  if (r.type === 1 && geom && r.geom) e.geometry = parts(r.geom)[0].map(([lon, lat]) => ({ lat, lon }));
  e.tags = JSON.parse(r.tags);
  return e;
}
/** Overpass の出力の順（種類、ID）に並べて、上限で切る */
const finish = (rows: Row[], limit: number, geom = false, nodes = false) =>
  rows.sort((a, b) => a.type - b.type || a.osm_id - b.osm_id).slice(0, limit).map((r) => element(r, geom, nodes));
/** QL には緯度経度を小数6桁で書くので、同じ値にそろえる */
const r6 = ([x, y]: LngLat): LngLat => [Number(x.toFixed(6)), Number(y.toFixed(6))];

export type OsmIndex = ReturnType<typeof openOsmIndex>;

export function openOsmIndex(path: string) {
  // セットアップの前の clone や、別のフォルダから起こした MCP でも、最初に使ったときにこう出す
  if (!existsSync(path)) throw new OpError('service', '検索データがありません。npm run setup を回してください');
  const db = new DatabaseSync(path, { readOnly: true });
  const meta = (k: string) => (db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v;
  if (meta('dict') !== dictSignature()) {
    db.close();
    throw new OpError('service', '検索データが古い形か、今の辞書と合いません。npm run setup で作り直してください');
  }
  const words = Object.fromEntries(db.prepare('SELECT word, i FROM words').all().map((r) => [r.word as string, r.i as number]));
  const q = {
    rt: db.prepare('SELECT id FROM word_rtree WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?'),
    feat: db.prepare('SELECT * FROM feat WHERE fid = ?'),
    byOsm: db.prepare('SELECT tags FROM feat WHERE type = ? AND osm_id = ?'),
    exact: db.prepare('SELECT fid FROM name_exact WHERE v = ?'),
    fts: db.prepare('SELECT rowid AS fid FROM name_fts WHERE name_fts MATCH ?'),
    like: db.prepare('SELECT rowid AS fid FROM name_fts WHERE name LIKE ? OR name_ja LIKE ?'),
    hw: db.prepare('SELECT id, t FROM hw WHERE id IN (SELECT value FROM json_each(?))'),
    wgeom: db.prepare('SELECT geom FROM wgeom WHERE id = ?'),
  };
  const row = (fid: number) => q.feat.get(fid) as unknown as Row;
  /** Overpass の bbox と around が見る形：node は点、way は線、relation は部品の点（geom）と部品の way の線（ways → wgeom） */
  function shape(r: Row): Line[] {
    if (r.type === 0) return [[[r.minx, r.miny]]];
    const out = r.geom ? parts(r.geom) : [];
    if (r.ways) for (const id of f64(r.ways)) out.push(...parts((q.wgeom.get(id) as { geom: Uint8Array }).geom));
    return out;
  }
  const fids = (rs: unknown[]) => rs.map((r) => (r as { fid: number }).fid);

  /** 言葉に当たる地物のうち、どれかの枠に範囲が重なるもの（重なりは1回だけ） */
  function wordRows(word: DictKey, boxes: BBox[]): Row[] {
    const wi = words[word];
    const seen = new Map<number, Row>();
    for (const [w, s, e, n] of boxes) for (const r of q.rt.all(e, w, n, s)) {
      const id = r.id as number;
      if (id % 32 === wi && !seen.has(id)) seen.set(id, row(Math.floor(id / 32)));
    }
    return [...seen.values()];
  }
  /** Overpass の around：折れ線（点が1つなら点）から radius の中 */
  function around(word: DictKey, pts: LngLat[], radius: number): Row[] {
    const points = pts.map(r6), R = Math.round(radius);
    const kx = kxOf(points[0][1]);
    const dx = R / kx, dy = R / M_PER_DEG;
    const boxes = segs(points).map(([a, b]): BBox => [Math.min(a[0], b[0]) - dx, Math.min(a[1], b[1]) - dy, Math.max(a[0], b[0]) + dx, Math.max(a[1], b[1]) + dy]);
    return wordRows(word, boxes).filter((r) => distTo(shape(r), points, kx) <= R);
  }

  return {
    /** 辞書の言葉（overpass.ts の featureQuery と同じ。geom なら out body geom、でなければ out bb tags） */
    features(word: DictKey, area: Area, geom: boolean, limit: number): { elements: OsmElement[] } {
      const rows = 'bbox' in area ? wordRows(word, [area.bbox]).filter((r) => inBox(r, area.bbox, shape)) : around(word, area.around.points, area.around.radius_m);
      return { elements: finish(rows, limit, geom, geom) };
    },
    /** 名前（osm.ts の nameQuery と同じ）。exact は4つの名前のキーの完全一致と「〜駅」の駅。でなければ name / name:ja の部分一致（大文字小文字を区別しない） */
    names(name: string, bbox: BBox, exact: boolean, limit: number): { elements: OsmElement[] } {
      if (exact) {
        const ids = new Set(fids(q.exact.all(name)));
        const rows = [...ids].map(row);
        const st = name.match(/^(.+)駅$/);
        if (st) for (const fid of fids(q.exact.all(st[1]))) {
          const t = JSON.parse(row(fid).tags);
          if (!ids.has(fid) && t.name === st[1] && t.railway === 'station') { ids.add(fid); rows.push(row(fid)); }
        }
        return { elements: finish(rows.filter((r) => inBox(r, bbox, shape)), limit) };
      }
      // 名前は SQL にパラメータで渡す。3文字以上は trigram の索引（"…" の句。中の " は "" にする）、2文字以下は全部を見る。
      // どちらも候補を広めに取り、下の includes で絞る（LIKE の % と _ も、ここで文字どおりに比べ直す）
      const lower = name.toLowerCase();
      const cand = [...name].length >= 3 ? q.fts.all(`"${name.replace(/"/g, '""')}"`) : q.like.all(`%${name}%`, `%${name}%`);
      const rows = fids(cand).map(row).filter((r) => {
        const t = JSON.parse(r.tags);
        return [t.name, t['name:ja']].some((v) => v != null && v.toLowerCase().includes(lower)) && inBox(r, bbox, shape);
      });
      return { elements: finish(rows, limit) };
    },
    /** 道の way のタグ（ルートの判定に使うキーだけ）。ない way は Map に入らない */
    wayTags(ids: number[]): Map<number, Record<string, string>> {
      return new Map(q.hw.all(JSON.stringify([...new Set(ids)])).map((r) => [r.id as number, JSON.parse(r.t as string)]));
    },
    /** 試走コースの経由地の候補（plan_course の検索文と同じ。out tags geom）。道路の種類は上限で切る前に絞る。
     * ponytail: 辞書の tunnel に当たる way から選ぶ。辞書の tunnel から道路の種類を外すと、ここの候補からも消える */
    courseTunnels(start: LngLat, radiusM: number, roads: string, limit: number): { elements: OsmElement[] } {
      const re = new RegExp(`^(${roads})$`);
      const rows = around('tunnel', [start], radiusM).filter((r) => re.test(JSON.parse(r.tags).highway ?? ''));
      return { elements: finish(rows, limit, true, false) };
    },
    /** 地点の詳細のタグ。検索データにない要素は null */
    elementTags(type: OsmElement['type'], id: number): Record<string, string> | null {
      const r = q.byOsm.get(TYPES.indexOf(type), id) as { tags: string } | undefined;
      return r ? JSON.parse(r.tags) : null;
    },
    close: () => db.close(),
  };
}
