// 自社の Overpass（Docker、関東の OSM データ）への問い合わせ。公開の Overpass は使わない。
// 検索文は辞書（src/ops/dict.ts）の filter と範囲から、ここでプログラムが組み立てる。LLM には書かせない。
import { DICT, type DictKey } from '../ops/dict';
import { OpError, type BBox, type LngLat, type Place } from '../ops/types';
import { bboxKm2 } from './region';

const URL_ = process.env.OVERPASS_URL ?? 'http://localhost:12345/api/interpreter';

/** 1回の問い合わせの上限 */
export const LIMITS = { timeout_s: 25, max_items: 200, max_bbox_km2: 400, max_radius_m: 3000 } as const;

export type Area =
  | { bbox: BBox }
  | { around: { points: LngLat[]; radius_m: number } };

export interface OsmElement {
  type: 'node' | 'way' | 'relation'; id: number;
  lat?: number; lon?: number; center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  tags?: Record<string, string>;
  /** way の点（out body geom のときだけ） */
  nodes?: number[]; geometry?: { lat: number; lon: number }[];
}

/** 範囲の書き方。上限を超えたら OpError('limit') */
export function areaClause(area: Area): string {
  if ('bbox' in area) {
    const [w, s, e, n] = area.bbox;
    if (bboxKm2(area.bbox) > LIMITS.max_bbox_km2) throw new OpError('limit', `範囲が広すぎます（上限 ${LIMITS.max_bbox_km2} km²）。地図を拡大してから試してください`);
    return `(${s},${w},${n},${e})`;
  }
  const { points, radius_m } = area.around;
  if (radius_m > LIMITS.max_radius_m) throw new OpError('limit', `半径が大きすぎます（上限 ${LIMITS.max_radius_m} m）`);
  // ponytail: 長い経路でも点を全部渡す。重ければ間引く
  return `(around:${Math.round(radius_m)},${points.map(([lng, lat]) => `${lat.toFixed(6)},${lng.toFixed(6)}`).join(',')})`;
}

/**
 * 辞書の言葉と範囲から検索文を作る。件数は上限 +1 まで取り、超えたら truncated にする。
 * `out bb`：点は lat/lon、線と面は範囲（bounds）が付く。Overpass の center は範囲の中心と同じなので、toPlace で範囲から作る
 * geom：way の点と形も取る（つながった way をまとめるとき）
 */
export function featureQuery(word: DictKey, area: Area, geom = false): string {
  return `[out:json][timeout:${LIMITS.timeout_s}];(${featureParts(word, areaClause(area))});out ${geom ? 'body geom' : 'bb tags'} ${LIMITS.max_items + 1};`;
}

/** way の生のタグを取り直す（ルートの判定用）。同じ道の組なら同じ検索文になるよう番号を並べる */
export async function wayTags(ids: number[]): Promise<Map<number, Record<string, string>>> {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (!sorted.length) return new Map();
  const { elements } = await overpass(`[out:json][timeout:${LIMITS.timeout_s}];way(id:${sorted.join(',')});out tags;`);
  return new Map(elements.map((e) => [e.id, e.tags ?? {}]));
}

/** 言葉の検索部分（範囲の書き方 a つき）。scripts/tag-audit.ts も同じものを数える */
export const featureParts = (word: DictKey, a: string) => DICT[word].queries.map((q) => `${q.elements}${q.filter}${a};`).join('');

// 同じ検索文の結果を少しのあいだ覚える。札を2回押したときなどに同じ問い合わせを送らない
// （自社の Overpass は同じ問い合わせが続くと duplicate_query で断る設定のため）
// ponytail: メモリだけ、件数の上限は簡易。重くなったら LRU にする
const CACHE_MS = 120_000;
const cache = new Map<string, { at: number; value: { elements: OsmElement[]; osm_base?: string } }>();

export async function overpass(ql: string): Promise<{ elements: OsmElement[]; osm_base?: string }> {
  const hit = cache.get(ql);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fetchOverpass(ql);
  if (cache.size > 500) cache.clear();
  cache.set(ql, { at: Date.now(), value });
  return value;
}

async function fetchOverpass(ql: string): Promise<{ elements: OsmElement[]; osm_base?: string }> {
  let res: Response;
  try {
    res = await fetch(URL_, { method: 'POST', body: new URLSearchParams({ data: ql }), signal: AbortSignal.timeout((LIMITS.timeout_s + 5) * 1000) });
  } catch {
    throw new OpError('service', '地物の検索（自社の Overpass）に接続できません');
  }
  if (res.status === 429 || res.status === 504) throw new OpError('limit', '地物の検索が混んでいるか、時間がかかりすぎました。範囲を狭めて試してください');
  if (!res.ok) throw new OpError('service', `地物の検索（自社の Overpass）がエラーを返しました（${res.status}）`);
  // 混んでいるときや同じ問い合わせが続いたときは、HTTP 200 で HTML の説明が返る
  const text = await res.text();
  let j: { elements?: OsmElement[]; remark?: string; osm3s?: { timestamp_osm_base?: string } };
  try { j = JSON.parse(text); } catch {
    throw new OpError('limit', '地物の検索が混んでいます。1分ほど待ってから試してください');
  }
  // 時間切れやメモリ切れは remark に書かれ、結果は途中まで。0件と見分けるため失敗にする
  if (j.remark?.includes('runtime error')) throw new OpError('limit', '地物の検索が時間内に終わりませんでした。範囲を狭めて試してください');
  return { elements: j.elements ?? [], osm_base: j.osm3s?.timestamp_osm_base };
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * OSM の要素を Place にする。持つタグは name だけ（description・note・fixme などの自由文は持たない）。
 * ref は呼び出し側で付ける。
 */
export function toPlace(e: OsmElement, kind: Place['kind']): Omit<Place, 'ref'> {
  const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
  const b = e.bounds;
  const coord: LngLat = lat != null && lon != null ? [r6(lon), r6(lat)] : b ? [r6((b.minlon + b.maxlon) / 2), r6((b.minlat + b.maxlat) / 2)] : [NaN, NaN];
  return {
    name: e.tags?.['name:ja'] ?? e.tags?.name ?? null,
    coord, kind, osm: `${e.type}/${e.id}`,
    ...(b && e.type !== 'node' ? { bbox: [r6(b.minlon), r6(b.minlat), r6(b.maxlon), r6(b.maxlat)] as BBox } : {}),
  };
}
