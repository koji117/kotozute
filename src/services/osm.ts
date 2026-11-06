// OSM の地物の検索の入口。操作（find_features、search_place、route、plan_course、check_route）はここの5つの関数だけを使う。
// 中身は2つ：自社の Overpass（検索文は辞書と範囲からプログラムが組み立てる。LLM には書かせない）と、
// 手元の検索データ（SQLite の osm.db。npm run setup で作る。src/services/osm-sqlite.ts）。どちらも同じ答えを返す。
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DictKey } from '../ops/dict';
import { OpError, type BBox, type LngLat } from '../ops/types';
import { areaClause, featureQuery, LIMITS, overpass, wayTags as overpassWayTags, type Area, type OsmElement } from './overpass';
import type { OsmIndex } from './osm-sqlite';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_INDEX = 'data/setup/osm/kanto-261103/osm.db';

/**
 * どちらの中身を使うか。OSM_BACKEND（overpass か sqlite。既定は overpass）と OSM_INDEX（osm.db のパス。リポジトリの根からの相対か絶対）。
 * ponytail: 地域の設定（data/region.json の osm_backend、osm_index）ができたら、そちらから読む
 */
export function osmSource(): { backend: 'overpass' | 'sqlite'; index: string } {
  const b = process.env.OSM_BACKEND || 'overpass';
  if (b !== 'overpass' && b !== 'sqlite') throw new OpError('service', `OSM_BACKEND は overpass か sqlite です（${b}）`);
  return { backend: b, index: resolve(ROOT, process.env.OSM_INDEX || DEFAULT_INDEX) };
}

// 検索データは最初に使うときに開く（import しただけでは開かない。ないときも読み込みでは落ちない）
let opened: { path: string; index: OsmIndex } | undefined;
async function sqlite(path: string): Promise<OsmIndex> {
  if (opened?.path !== path) {
    const { openOsmIndex } = await import('./osm-sqlite');
    opened = { path, index: openOsmIndex(path) };
  }
  return opened.index;
}
const LIMIT = LIMITS.max_items + 1; // 上限 +1 件まで取り、超えたら呼ぶ側が truncated にする

/** 辞書の言葉に当たる地物。範囲の上限（areaClause）はどちらの中身でも先に確かめる。geom：way の点と形も返す */
export async function features(word: DictKey, area: Area, geom = false): Promise<{ elements: OsmElement[] }> {
  const s = osmSource();
  if (s.backend === 'overpass') return overpass(featureQuery(word, area, geom));
  areaClause(area);
  return (await sqlite(s.index)).features(word, area, geom, LIMIT);
}

/** 名前で探す。exact は完全一致、そうでなければ name / name:ja の部分一致（大文字小文字を区別しない） */
export async function names(name: string, bbox: BBox, exact: boolean): Promise<{ elements: OsmElement[] }> {
  const s = osmSource();
  if (s.backend === 'overpass') return overpass(nameQuery(name, bbox, exact));
  return (await sqlite(s.index)).names(name, bbox, exact, LIMIT);
}

/** way の生のタグ（ルートの判定用）。見つからない way は Map に入らない */
export async function wayTags(ids: number[]): Promise<Map<number, Record<string, string>>> {
  const s = osmSource();
  if (s.backend === 'overpass') return overpassWayTags(ids);
  return (await sqlite(s.index)).wayTags(ids);
}

/** 試走コースの経由地の候補：出発地から radiusM の中の、roads（highway の値を | でつないだもの）の道路トンネル。形つき */
export async function courseTunnels([lng, lat]: LngLat, radiusM: number, roads: string): Promise<{ elements: OsmElement[] }> {
  const s = osmSource();
  if (s.backend === 'overpass') {
    return overpass(`[out:json][timeout:${LIMITS.timeout_s}];way(around:${radiusM},${lat.toFixed(6)},${lng.toFixed(6)})[tunnel=yes][highway~"^(${roads})$"];out tags geom ${LIMIT};`);
  }
  return (await sqlite(s.index)).courseTunnels([lng, lat], radiusM, roads, LIMIT);
}

/** 地点の詳細用の、1つの要素のタグ（'node/123' の形）。見つからなければ null */
export async function elementTags(osm: string): Promise<Record<string, string> | null> {
  const m = /^(node|way|relation)\/(\d{1,12})$/.exec(osm);
  if (!m) throw new OpError('bad_input', 'OSM の要素の書き方が違います（node/123 の形）');
  const [, type, id] = m as unknown as [string, OsmElement['type'], string];
  const s = osmSource();
  if (s.backend === 'overpass') {
    const { elements } = await overpass(`[out:json][timeout:${LIMITS.timeout_s}];${type}(${id});out tags;`);
    return elements[0] ? (elements[0].tags ?? {}) : null;
  }
  return (await sqlite(s.index)).elementTags(type, Number(id));
}

/** QL の文字列リテラル（"…"）の中身。ここが利用者の文字の注入の境目 */
const qlStr = (s: string) => s.replace(/[\\"]/g, '\\$&');
/** 正規表現の記号を文字そのものにする（Overpass の ~ は POSIX ERE） */
const reLit = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 名前で探す検索文。exact は完全一致、そうでなければ name / name:ja の部分一致（大文字小文字を区別しない） */
function nameQuery(name: string, bbox: BBox, exact: boolean): string {
  const [w, s, e, n] = bbox;
  const b = `(${s},${w},${n},${e})`;
  const v = qlStr(name);
  let parts: string;
  if (exact) {
    parts = ['name', 'name:ja', 'alt_name', 'official_name'].map((k) => `nwr["${k}"="${v}"]${b};`).join('');
    // 「品川駅」は OSM では駅の name が「品川」なので、駅として探し直す
    const st = name.match(/^(.+)駅$/);
    if (st) parts += `nwr["railway"="station"]["name"="${qlStr(st[1])}"]${b};`;
  } else {
    const re = qlStr(reLit(name));
    parts = `nwr["name"~"${re}",i]${b};nwr["name:ja"~"${re}",i]${b};`;
  }
  return `[out:json][timeout:${LIMITS.timeout_s}];(${parts});out bb tags ${LIMIT};`;
}
