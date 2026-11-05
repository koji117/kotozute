// 東京都（島しょ部を除く）の境界を、自社の Overpass の OSM データから作る。地域の判定（src/services/region.ts）が使う。
// 実行：npx tsx scripts/build-tokyo-boundary.ts → src/services/tokyo-boundary.json
// 東京都の行政界（relation 1543125）の outer の way をつないで輪にし、本土側の輪だけを残して間引く。
// データ：© OpenStreetMap contributors（ODbL）
import { writeFileSync } from 'node:fs';

type P = [number, number];
const URL_ = `${process.env.OVERPASS_URL ?? 'http://127.0.0.1:12345/api/interpreter'}`;
const TOLERANCE = 0.0002; // 間引きの許容（度）。約20m
const MAINLAND_S = 35.4; // これより南に全部ある輪は島しょ部

const res = await fetch(URL_, { method: 'POST', body: new URLSearchParams({ data: '[out:json][timeout:120];relation(1543125);way(r:"outer");out geom;' }) });
const j = (await res.json()) as { osm3s: { timestamp_osm_base: string }; elements: { type: string; geometry: { lat: number; lon: number }[] }[] };
const lines: P[][] = j.elements.filter((e) => e.type === 'way').map((w) => w.geometry.map((g): P => [g.lon, g.lat]));

// way の端どうしをつないで輪にする
const key = (p: P) => `${p[0]},${p[1]}`;
const rings: P[][] = [];
const left = new Set(lines.keys());
while (left.size) {
  const first = left.values().next().value!;
  left.delete(first);
  const ring = [...lines[first]];
  let grew = true;
  while (key(ring[0]) !== key(ring.at(-1)!) && grew) {
    grew = false;
    for (const i of left) {
      const l = lines[i];
      const end = key(ring.at(-1)!);
      if (key(l[0]) === end) ring.push(...l.slice(1));
      else if (key(l.at(-1)!) === end) ring.push(...[...l].reverse().slice(1));
      else continue;
      left.delete(i);
      grew = true;
      break;
    }
  }
  if (key(ring[0]) !== key(ring.at(-1)!)) throw new Error(`輪が閉じない（${ring.length}点）`);
  rings.push(ring);
}

// Douglas-Peucker で間引く（平面近似）
function simplify(pts: P[]): P[] {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts.at(-1)!];
  let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const d = dx || dy ? Math.abs(dy * x - dx * y + b[0] * a[1] - b[1] * a[0]) / Math.hypot(dx, dy) : Math.hypot(x - a[0], y - a[1]);
    if (d > max) { max = d; idx = i; }
  }
  return max > TOLERANCE ? [...simplify(pts.slice(0, idx + 1)).slice(0, -1), ...simplify(pts.slice(idx))] : [a, b];
}
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const mainland = rings
  .filter((r) => r.some(([, lat]) => lat > MAINLAND_S))
  // 輪は閉じているので、始点と終点を分けて間引く
  .map((r) => { const h = r.length >> 1; return [...simplify(r.slice(0, h + 1)).slice(0, -1), ...simplify(r.slice(h))]; })
  .map((r) => r.map(([x, y]): P => [r5(x), r5(y)]));

const out = {
  source: '© OpenStreetMap contributors（ODbL）。東京都の行政界 relation/1543125 の outer を本土側だけ残して間引いたもの',
  osm_as_of: j.osm3s.timestamp_osm_base,
  tolerance_deg: TOLERANCE,
  rings: mainland,
};
writeFileSync('src/services/tokyo-boundary.json', JSON.stringify(out) + '\n');
console.log(`輪 ${rings.length} → 本土側 ${mainland.length}、点 ${mainland.reduce((s, r) => s + r.length, 0)}（元 ${lines.reduce((s, l) => s + l.length, 0)}）`);
