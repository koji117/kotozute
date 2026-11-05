// 例1「今いる場所から、郵便局と手土産の店に寄って、港区芝公園4-2-8へ。ルートを共有リンクで」の地図データを作る。
// 使い方（docs/storyboard で）：node data/build-ex1.js  → data/ex1.json
// 使うのは手元のサービスだけ（Overpass :12345、Valhalla :8002、ABR :3001）。
const fs = require('fs');
const path = require('path');

const OVERPASS = 'http://localhost:12345/api/interpreter';
const VALHALLA = 'http://localhost:8002';
const ABR = 'http://localhost:3001/geocode';

const PROMPT = '今いる場所から、郵便局で書類を出して、手土産を買ってから、港区芝公園4-2-8へ。ルートを共有リンクで';
const ADDRESS = '東京都港区芝公園4-2-8';
// 現在地は架空（品川駅 高輪口の出入口 node/265050703 の位置）。精度の円も架空の値。
const HERE = { coord: [139.737985, 35.628809], accuracy_m: 30, near: 'node/265050703' };
const CORRIDOR_M = 300; // ルートからこの距離までを候補にする
const KEEP = 6;         // 種類ごとに残す候補の数

// 丸め
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const pt = ([lng, lat]) => [r6(lng), r6(lat)];
const min1 = (sec) => Math.round(sec / 6) / 10;
const km2 = (km) => Math.round(km * 100) / 100;

// polyline6 を [lng, lat] の配列に戻す
function decode6(str) {
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, res = 0, b;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push([r6(lng / 1e6), r6(lat / 1e6)]);
  }
  return out;
}

// 点と折れ線の距離（m）。狭い範囲なので平面近似で足りる。
function distToLine([x, y], line) {
  const kx = 111320 * Math.cos((y * Math.PI) / 180), ky = 110540;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][0] - x) * kx, ay = (line[i - 1][1] - y) * ky;
    const bx = (line[i][0] - x) * kx, by = (line[i][1] - y) * ky;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

async function overpass(q) {
  const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }) });
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${await res.text()}`);
  return res.json();
}

// Valhalla の自動車ルート。stops は [lng, lat] の配列。
async function route(stops) {
  const body = {
    locations: stops.map(([lon, lat]) => ({ lat, lon })),
    costing: 'auto', units: 'kilometers', directions_type: 'none',
  };
  const res = await fetch(`${VALHALLA}/route`, { method: 'POST', body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(`Valhalla ${res.status}: ${JSON.stringify(j)}`);
  const legs = j.trip.legs.map((l) => ({ sec: l.summary.time, km: l.summary.length, shape: decode6(l.shape) }));
  return { sec: j.trip.summary.time, km: j.trip.summary.length, legs };
}

// 各脚の形を1本につなぐ（つなぎ目の重複点は落とす）
const joinShapes = (legs) => legs.flatMap((l, i) => (i ? l.shape.slice(1) : l.shape));

const center = (e) => pt(e.center ? [e.center.lon, e.center.lat] : [e.lon, e.lat]);
const tagsOf = (e) => ({ name: e.tags?.name ?? null, brand: e.tags?.brand ?? null, branch: e.tags?.branch ?? null });

async function main() {
  const facts = [], choices = [];

  // 1. 目的地の住所（ABR）
  const abrRes = await (await fetch(`${ABR}?address=${encodeURIComponent(ADDRESS)}`)).json();
  const f = abrRes.features[0];
  const abr = {
    query: ADDRESS,
    matched_address: f.properties.matched_address,
    unmatched_address: f.properties.unmatched_address,
    match_level: f.properties.match_level,
    coordinates_level: f.properties.coordinates_level,
    coord: pt(f.geometry.coordinates),
    versions: { api: abrRes.result_info.api_version, db: abrRes.result_info.db_version },
  };
  facts.push(`ABR は「${abr.matched_address}」まで一致（coordinates_level=${abr.coordinates_level}）。残り「${abr.unmatched_address.join('')}」は一致せず、座標は町字の代表点 ${abr.coord.join(', ')}。`);

  // 2. 町字までしか出ないので、東京タワーの OSM の位置も取る
  const tt = await overpass('[out:json][timeout:25];nwr["name"="東京タワー"]["man_made"="tower"](35.65,139.74,35.665,139.75);out center tags;');
  const osmBase = tt.osm3s.timestamp_osm_base;
  const tower = tt.elements[0];
  const towerPt = { id: `${tower.type}/${tower.id}`, ...tagsOf(tower), official_name: tower.tags.official_name ?? null, coord: center(tower) };
  facts.push(`OSM の東京タワーは ${towerPt.id}（man_made=tower）。center は ${towerPt.coord.join(', ')}。`);
  const destPt = towerPt.coord;
  const abrToTower = Math.round(distToLine(abr.coord, [destPt, destPt]));
  facts.push(`ABR の町字代表点と東京タワーの center の距離は約 ${abrToTower} m。`);
  choices.push('ABR が住居番号まで一致しなかったので、目的地のピンとルートの終点は東京タワー（OSM）の center にした。画面では「住所は町字まで一致」と出す前提。');
  choices.push(`現在地は架空。品川駅 高輪口の出入口（${HERE.near}）の位置を使い、精度の円は ${HERE.accuracy_m} m とした（実測ではない）。`);

  // 3. 寄り道なしのルート
  const direct = await route([HERE.coord, destPt]);
  const directLine = direct.legs[0].shape;
  facts.push(`寄り道なし：${min1(direct.sec)} 分、${km2(direct.km)} km（Valhalla auto、除外なし）。`);

  // 4. ルートから 300 m 以内の郵便局と手土産の店（折れ線の around）
  const lineArg = directLine.map(([lng, lat]) => `${lat},${lng}`).join(',');
  const kinds = { post_office: '["amenity"="post_office"]', souvenir: '["shop"~"^(confectionery|pastry)$"]' /* 手土産＝和菓子・洋菓子の店（辞書） */ };
  const candidates = {}, counts = {};
  for (const [kind, filter] of Object.entries(kinds)) {
    const j = await overpass(`[out:json][timeout:25];nwr${filter}(around:${CORRIDOR_M},${lineArg});out center tags;`);
    const list = [];
    for (const e of j.elements) {
      const coord = center(e);
      const dist = distToLine(coord, directLine);
      if (dist > CORRIDOR_M) continue; // way の center が 300 m を超えるものは外す
      let via;
      try { via = await route([HERE.coord, coord, destPt]); } catch (err) { continue; }
      list.push({ id: `${e.type}/${e.id}`, ...tagsOf(e), coord, dist_from_route_m: Math.round(dist),
        extra_minutes: min1(via.sec - direct.sec), extra_sec: via.sec - direct.sec });
    }
    list.sort((a, b) => a.extra_sec - b.extra_sec);
    counts[kind] = { overpass: j.elements.length, within_corridor_routable: list.length };
    candidates[kind] = list.slice(0, KEEP);
    facts.push(`${kind}：Overpass ${j.elements.length} 件、center がルートから ${CORRIDOR_M} m 以内でルートが引けたもの ${list.length} 件。上位 ${candidates[kind].length} 件を残した。`);
  }

  // 5. 郵便局と手土産の店の組み合わせ × 2つの順番を全部試し、合計時間が最小のものを選ぶ
  const tried = [];
  for (const p of candidates.post_office) for (const c of candidates.souvenir) {
    for (const order of [[p, c]]) { // 依頼の順（郵便局 → 手土産）を守る
      try {
        const r = await route([HERE.coord, order[0].coord, order[1].coord, destPt]);
        tried.push({ order: order.map((o) => o.id), sec: r.sec, r });
      } catch (err) { /* ルートが引けない組み合わせは飛ばす */ }
    }
  }
  tried.sort((a, b) => a.sec - b.sec);
  const best = tried[0];
  const byId = Object.fromEntries([...candidates.post_office, ...candidates.souvenir].map((c) => [c.id, c]));
  const stops = best.order.map((id) => byId[id]);
  choices.push(`郵便局 ${candidates.post_office.length} 件 × 手土産の店 ${candidates.souvenir.length} 件 = ${tried.length} 通り（依頼の順：郵便局 → 手土産）を Valhalla で引き、合計時間が最小の「${stops.map((s) => s.name ?? s.id).join(' → ')}」を選んだ。`);
  choices.push(`組み合わせは、1か所ずつ寄ったときの追加時間の上位 ${KEEP} 件どうしに限った（それ以外の組み合わせは試していない）。`);

  // 6. 選んだルート（現在地 → 寄り道1 → 寄り道2 → 目的地）
  const names = ['現在地', stops[0].name, stops[1].name, '東京タワー'];
  const legs = best.r.legs.map((l, i) => ({ from: names[i], to: names[i + 1], minutes: min1(l.sec), km: km2(l.km),
    shape: { type: 'LineString', coordinates: l.shape } }));
  const full = joinShapes(best.r.legs);
  const extra = min1(best.r.sec - direct.sec);
  facts.push(`寄り道ありのルート：${min1(best.r.sec)} 分、${km2(best.r.km)} km。寄り道なしより ${extra} 分、${km2(best.r.km - direct.km)} km 多い。`);
  facts.push('Valhalla の時間は走る時間だけで、店に止まる時間は入っていない。追加 0 分は、寄り道先が寄り道なしのルートの道沿いにあるという意味。');

  // 7. 全部が入る範囲（少し余白をつける）
  const all = [HERE.coord, destPt, abr.coord, ...directLine, ...full,
    ...candidates.post_office.map((c) => c.coord), ...candidates.souvenir.map((c) => c.coord)];
  const m = 0.002;
  const bbox = [Math.min(...all.map((p) => p[0])) - m, Math.min(...all.map((p) => p[1])) - m,
    Math.max(...all.map((p) => p[0])) + m, Math.max(...all.map((p) => p[1])) + m].map(r6);

  const status = await (await fetch(`${VALHALLA}/status`)).json();
  const out = {
    key: 'ex1',
    prompt: PROMPT,
    generated_at: new Date().toISOString(),
    data_time: { osm_base: osmBase, valhalla_tileset_last_modified: new Date(status.tileset_last_modified * 1000).toISOString(),
      valhalla_version: status.version, abr: abr.versions },
    here: { coord: HERE.coord, accuracy_m: HERE.accuracy_m, fictional: true, near: HERE.near, label: '現在地（品川駅 高輪口付近）' },
    destination: { address_query: ADDRESS, abr, osm: towerPt, pin: destPt, pin_source: towerPt.id },
    direct: { minutes: min1(direct.sec), km: km2(direct.km), shape: { type: 'LineString', coordinates: directLine } },
    candidates: { corridor_m: CORRIDOR_M, counts,
      post_office: candidates.post_office.map(({ extra_sec, ...c }) => c),
      souvenir: candidates.souvenir.map(({ extra_sec, ...c }) => c) },
    chosen: { order: stops.map((s) => (s.id in Object.fromEntries(candidates.post_office.map((c) => [c.id, 1])) ? 'post_office' : 'souvenir')),
      stops: stops.map(({ extra_sec, ...s }) => s), combos_tried: tried.length,
      top5: tried.slice(0, 5).map((t) => ({ order: t.order, minutes: min1(t.sec), extra_minutes: min1(t.sec - direct.sec) })) },
    route: { minutes: min1(best.r.sec), km: km2(best.r.km), extra_minutes: extra, extra_km: km2(best.r.km - direct.km),
      legs, shape: { type: 'LineString', coordinates: full } },
    bbox,
    notes: [...facts.map((text) => ({ type: 'fact', text })), ...choices.map((text) => ({ type: 'choice', text }))],
  };
  fs.writeFileSync(path.join(__dirname, 'ex1.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ direct: out.direct.minutes, route: out.route.minutes, extra, stops: stops.map((s) => [s.id, s.name]), counts, bbox }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
