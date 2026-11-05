// 例1の前の場面「いつもの操作＋日本語」の地図データを作る。
// 札（郵便局・手土産）を押したときに出す地物と、「芝公園のあたりを大きく」の芝公園。
// 使い方（docs/storyboard で）：node data/build-nl.js  → data/nl.json
// 使うのは手元の Overpass（:12345）だけ。
const fs = require('fs');

const OVERPASS = 'http://localhost:12345/api/interpreter';
const BBOX = '35.615,139.715,35.675,139.765'; // 例1の地図の範囲より広め。画面に入るかは scenes.js で数える
const r6 = (x) => Math.round(x * 1e6) / 1e6;

async function overpass(q) {
  const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }) });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  return res.json();
}
const items = (j) => j.elements.map((e) => ({ id: `${e.type}/${e.id}`, name: e.tags?.name ?? null, coord: [r6(e.lon ?? e.center.lon), r6(e.lat ?? e.center.lat)] }));

(async () => {
  // 辞書と同じタグ：郵便局 = amenity=post_office、手土産 = shop=confectionery|pastry
  const po = items(await overpass(`[out:json][timeout:25];nwr["amenity"="post_office"](${BBOX});out center tags;`));
  const sv = items(await overpass(`[out:json][timeout:25];nwr["shop"~"^(confectionery|pastry)$"](${BBOX});out center tags;`));
  const pk = await overpass(`[out:json][timeout:25];nwr["leisure"="park"]["name"="芝公園"](${BBOX});out center bb tags;`);
  // 芝公園は OSM では何本かの way に分かれている。まとめた範囲を「芝公園のあたり」とする
  const parts = pk.elements.map((e) => ({ id: `${e.type}/${e.id}`, bounds: [[r6(e.bounds.minlon), r6(e.bounds.minlat)], [r6(e.bounds.maxlon), r6(e.bounds.maxlat)]] }));
  const b = [[Math.min(...parts.map((p) => p.bounds[0][0])), Math.min(...parts.map((p) => p.bounds[0][1]))], [Math.max(...parts.map((p) => p.bounds[1][0])), Math.max(...parts.map((p) => p.bounds[1][1]))]];
  const parks = { parts, bounds: b, center: [r6((b[0][0] + b[1][0]) / 2), r6((b[0][1] + b[1][1]) / 2)] };
  const osmBase = (await overpass('[out:json];out meta;')).osm3s?.timestamp_osm_base;
  const out = { prompt: '芝公園のあたりを大きく。郵便局だけ残して', bbox: BBOX, osm_base: osmBase, post_office: po, souvenir: sv, shiba_park: parks };
  fs.writeFileSync('data/nl.json', JSON.stringify(out, null, 1));
  console.log('post_office', po.length, 'souvenir', sv.length, 'parks', JSON.stringify(parks));
})();
