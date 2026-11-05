// 辞書（src/ops/dict.ts）の言葉ごとに、関東の OSM データに当てはまる要素がいくつあるかを自社の Overpass で数える。
// アプリと同じ検索部分（featureParts）を out count で数えるので、画面で探すものと同じものを数える。
// 実行：npx tsx scripts/tag-audit.ts（Overpass が localhost:12345 で動いていること）。結果は logs/tag-audit.json。
// 0件の言葉があれば終了コード 1。
import { mkdirSync, writeFileSync } from 'node:fs';
import { DICT, DICT_KEYS } from '../src/ops/dict';
import type { BBox } from '../src/ops/types';
import { featureParts, LIMITS, overpass } from '../src/services/overpass';
import { TOKYO_BBOX } from '../src/services/region';

// 関東のデータの範囲（kanto-latest.osm.pbf の osmium fileinfo の Bounding boxes。小笠原・沖ノ鳥島まで入る）
const KANTO_BBOX: BBox = [134.045154, 18.625054, 155.605818, 37.15988];
const LOW = 10; // 東京でこれより少なければ「少ない」の印

const clause = ([w, s, e, n]: BBox) => `(${s},${w},${n},${e})`;
async function count(word: keyof typeof DICT, bbox: BBox) {
  // ponytail: 関東全体も timeout は画面の検索と同じ 25秒。足りなくなったら別の上限にする
  const { elements, osm_base } = await overpass(`[out:json][timeout:${LIMITS.timeout_s}];(${featureParts(word, clause(bbox))});out count;`);
  return { n: Number(elements[0]?.tags?.total ?? NaN), osm_base };
}

// 同じ検索文を続けて送らない（Overpass が同じ問い合わせの繰り返しを断るため）。1つずつ順に送る
// ponytail: 言葉ごとの合計だけ数える。queries が2つ以上の言葉ができたら式ごとにも数える
const rows = [];
let osmBase: string | undefined;
for (const word of DICT_KEYS) {
  const tokyo = await count(word, TOKYO_BBOX);
  const kanto = await count(word, KANTO_BBOX);
  osmBase = kanto.osm_base;
  const flag = tokyo.n === 0 || kanto.n === 0 ? 'zero' : tokyo.n < LOW ? 'low' : null;
  rows.push({ word, label: DICT[word].label, interpretation: DICT[word].interpretation, tokyo: tokyo.n, kanto: kanto.n, flag });
}

console.log(['言葉', '名前', '東京', '関東', '印'].join('\t'));
for (const r of rows) console.log([r.word, r.label, r.tokyo, r.kanto, r.flag === 'zero' ? '0件' : r.flag === 'low' ? `少ない（東京 ${LOW}件未満）` : ''].join('\t'));
mkdirSync('logs', { recursive: true });
writeFileSync('logs/tag-audit.json', JSON.stringify({ at: new Date().toISOString(), osm_base: osmBase, bbox: { tokyo: TOKYO_BBOX, kanto: KANTO_BBOX }, low_below: LOW, rows }, null, 1) + '\n');
const zero = rows.filter((r) => r.flag === 'zero');
console.log(`\n${rows.length}語、0件 ${zero.length}語、少ない ${rows.filter((r) => r.flag === 'low').length}語（データ時点 ${osmBase}）→ logs/tag-audit.json`);
if (zero.length) {
  console.error(`0件の言葉：${zero.map((r) => r.word).join(', ')}`);
  process.exit(1);
}
