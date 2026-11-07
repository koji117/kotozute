// 対応する地域（src/region.ts の REGION。既定は東京都（島しょ部を除く））。判定は地域の境界（OSM の行政界）で行う。
// 名前（TOKYO_BBOX、inTokyo）は東京だけだったときのまま。中身は地域の設定
import { readFileSync } from 'node:fs';
import type { BBox, LngLat } from '../ops/types';
import { fromRoot, REGION } from '../region';

/** 地図ファイルの切り出し範囲。地域の外（東京なら埼玉・神奈川・千葉の端）も入るので、これだけでは地域の判定に使わない */
export const TOKYO_BBOX: BBox = REGION.bbox;

// 境界：{ rings }（1つのまとまり）か { groups: rings[] }（県ごとのまとまり）。東京は scripts/build-tokyo-boundary.ts で作る（約20mの許容で間引いた輪。境界のすぐ近くは判定がずれうる）
const boundary = JSON.parse(readFileSync(fromRoot(REGION.boundary), 'utf8')) as { rings?: LngLat[][]; groups?: LngLat[][][] };
const GROUPS = boundary.groups ?? [boundary.rings ?? []];
/** 点がまとまりの輪の中か（偶奇規則。輪が複数でも、どれかの中なら中） */
function inRings([x, y]: LngLat, rings: LngLat[][]): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** 地域の中か：どれかのまとまりの中（複数の県で、境の細い隙間が外にならないように、県ごとに判定する） */
export const inTokyo = (p: LngLat) =>
  p[0] >= TOKYO_BBOX[0] && p[0] <= TOKYO_BBOX[2] && p[1] >= TOKYO_BBOX[1] && p[1] <= TOKYO_BBOX[3] && GROUPS.some((g) => inRings(p, g));

/** bbox の面積（km²、平面近似） */
export const bboxKm2 = ([w, s, e, n]: BBox) => {
  const kx = 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180);
  return Math.abs(e - w) * kx * Math.abs(n - s) * 110.57;
};

/** 2点の距離（m、平面近似。狭い範囲用） */
export const distM = ([x1, y1]: LngLat, [x2, y2]: LngLat) => {
  const kx = 111320 * Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
  return Math.hypot((x2 - x1) * kx, (y2 - y1) * 110570);
};

/** 折れ線の長さ（m） */
export const lineM = (cs: LngLat[]) => cs.slice(1).reduce((s, c, i) => s + distM(cs[i], c), 0);

/** 折れ線の長さの真ん中の点と、そこでの向き（度。北が0で時計回り、平面近似） */
export function midOf(cs: LngLat[]): { coord: LngLat; heading: number } {
  let half = lineM(cs) / 2;
  for (let i = 1; i < cs.length; i++) {
    const [a, b] = [cs[i - 1], cs[i]], d = distM(a, b);
    if (d < half) { half -= d; continue; }
    const t = d ? half / d : 0;
    const kx = Math.cos((a[1] * Math.PI) / 180);
    const heading = Math.round(((Math.atan2((b[0] - a[0]) * kx, b[1] - a[1]) * 180) / Math.PI + 360) % 360);
    return { coord: [Math.round((a[0] + (b[0] - a[0]) * t) * 1e6) / 1e6, Math.round((a[1] + (b[1] - a[1]) * t) * 1e6) / 1e6], heading };
  }
  return { coord: cs[0], heading: 0 };
}
