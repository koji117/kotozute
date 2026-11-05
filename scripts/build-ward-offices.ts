// 一括処理のデモ用データ：23区の区役所の住所一覧（docs/demo/ward-offices.csv）を、自社の Overpass の OSM データから作る。
// どの住所も自社の ABR で街区以上まで一致し、ABR の点が OSM の位置から 200m 以内であることを確かめてから書く。
// 実行：npx tsx scripts/build-ward-offices.ts（Overpass :12345、ABR :3002 が動いていること）
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { geocode, precisionOf } from '../src/services/abr';
import { overpass, toPlace, type OsmElement } from '../src/services/overpass';
import { distM } from '../src/services/region';

const WARDS = ['千代田', '中央', '港', '新宿', '文京', '台東', '墨田', '江東', '品川', '目黒', '大田', '世田谷', '渋谷', '中野', '杉並', '豊島', '北', '荒川', '板橋', '練馬', '足立', '葛飾', '江戸川'];
const MAX_M = 200;
// 23区がすべて入る範囲（区役所の検索だけに使う）
const BBOX = '(35.52,139.56,35.82,139.92)';

// OSM に住所のタグがない（または崩れている）区は、区の公式サイトのトップページにある本庁舎の所在地を使う（2026-11-05 に確認。書いてあるとおり）
const OFFICIAL: Record<string, { address: string; url: string }> = {
  千代田: { address: '東京都千代田区九段南1-2-1', url: 'https://www.city.chiyoda.lg.jp/' },
  文京: { address: '東京都文京区春日1-16-21', url: 'https://www.city.bunkyo.lg.jp/' },
  墨田: { address: '東京都墨田区吾妻橋一丁目23番20号', url: 'https://www.city.sumida.lg.jp/' },
  品川: { address: '東京都品川区広町2-1-36', url: 'https://www.city.shinagawa.tokyo.jp/' },
  大田: { address: '東京都大田区蒲田五丁目13番14号', url: 'https://www.city.ota.tokyo.jp/' },
  渋谷: { address: '東京都渋谷区宇田川町1-1', url: 'https://www.city.shibuya.tokyo.jp/' }, // OSM は addr:neighbourhood=１丁目（宇田川町に丁目はない）で ABR が区までしか一致しない
  中野: { address: '東京都中野区中野四丁目11番19号', url: 'https://www.city.tokyo-nakano.lg.jp/' },
  杉並: { address: '東京都杉並区阿佐谷南1丁目15番1号', url: 'https://www.city.suginami.tokyo.jp/' },
  // OSM は旧庁舎の住所（東池袋一丁目18-1）のままで、ABR の点が OSM の位置から約700m。公式サイトの表記に「東京都」を足した
  豊島: { address: '東京都豊島区南池袋2-45-1', url: 'https://www.city.toshima.lg.jp/' },
};

const names = `^(${WARDS.join('|')})区役所$`;
// 区役所（amenity=townhall）、同じ名前の建物、住所の全文に「◯◯区役所」と書かれた要素
const { elements, osm_base } = await overpass(
  `[out:json][timeout:25];(nwr["amenity"="townhall"]["name"~"${names}"]${BBOX};nwr["building"]["name"~"${names}"]${BBOX};nwr["addr:full"~"区役所"]${BBOX};);out bb tags;`,
);

/** OSM の住所タグをつなぐ（例：東京都港区芝公園一丁目5-25）。住居番号がなければ null */
function tagAddress(t: Record<string, string> = {}): string | null {
  if (t['addr:full']) return t['addr:full'].replace(/(\d)[^\d-]*区役所.*$/, '$1'); // 「…1-1-1中央区役所4階」の階や館名は落とす
  if (!t['addr:housenumber'] || !t['addr:city']) return null;
  const block = t['addr:block_number'] ? `${t['addr:block_number']}-` : '';
  return `${t['addr:province'] ?? ''}${t['addr:city']}${t['addr:quarter'] ?? ''}${t['addr:neighbourhood'] ?? ''}${block}${t['addr:housenumber']}`;
}

const id = (e: OsmElement) => `${e.type}/${e.id}`;
const rows: string[][] = [];
const report: string[] = [];
for (const ward of WARDS) {
  const name = `${ward}区役所`;
  const same = elements.filter((e) => e.tags?.name === name);
  // 位置：区役所（townhall）を優先し、なければ同じ名前の建物。住所タグを持つものを先に
  const pos = [...same].sort((a, b) => rank(b) - rank(a))[0];
  assert.ok(pos, `${name} が OSM にない`);
  let address: string, source: string;
  if (OFFICIAL[ward]) [address, source] = [OFFICIAL[ward].address, `区の公式サイト（${OFFICIAL[ward].url}）`];
  else {
    const withTags = [pos, ...same, ...elements.filter((e) => e.tags?.['addr:full']?.includes(name))].find((e) => tagAddress(e.tags));
    assert.ok(withTags, `${name} の住所タグが OSM にない。OFFICIAL に足す`);
    address = tagAddress(withTags.tags)!;
    source = withTags === pos ? 'OSM（同じ要素）' : `OSM（${id(withTags)} の${withTags.tags!['addr:full'] ? ' addr:full' : '住所タグ'}）`;
  }
  const m = await geocode(address);
  assert.ok(m && ['rsdtdsp_blk', 'rsdtdsp_rsdt'].includes(m.match_level), `${name}：ABR が街区まで一致しない（${address} → ${m?.matched}）`);
  const d = Math.round(distM(m.coord, toPlace(pos, 'place').coord));
  assert.ok(d <= MAX_M, `${name}：ABR の点が OSM の位置から ${d}m`);
  rows.push([`${ward}区`, name, address]);
  report.push(`| ${ward}区 | ${id(pos)} | ${address} | ${source} | ${precisionOf(m.level)} | ${d}m |`);
}

function rank(e: OsmElement) {
  return (e.tags?.amenity === 'townhall' ? 2 : 0) + (tagAddress(e.tags) ? 1 : 0);
}

writeFileSync('docs/demo/ward-offices.csv', ['区,名称,住所', ...rows.map((r) => r.join(','))].join('\n') + '\n');
console.log(`OSM のデータ時点：${osm_base}`);
console.log('| 区 | OSM の要素（位置） | 住所 | 住所の出どころ | ABR の精度 | OSM の位置との距離 |\n|---|---|---|---|---|---|');
console.log(report.join('\n'));
