// 対応する地域：東京都（島しょ部を除く）。判定は都の境界（OSM の行政界）で行う。
import type { BBox, LngLat } from '../ops/types';
import boundary from './tokyo-boundary.json' with { type: 'json' };

/** 地図ファイル（tokyo.pmtiles）の切り出し範囲。埼玉・神奈川・千葉の端も入るので、地域の判定には使わない */
export const TOKYO_BBOX: BBox = [138.9, 35.48, 139.95, 35.92];
export const REGION_LABEL = '東京都（島しょ部を除く）';

// 都の境界：scripts/build-tokyo-boundary.ts で作る（約20mの許容で間引いた輪。境界のすぐ近くは判定がずれうる）
const RINGS = boundary.rings as LngLat[][];
/** 点が輪の中か（偶奇規則。輪が複数でも、どれかの中なら中） */
function inRings([x, y]: LngLat): boolean {
  let inside = false;
  for (const r of RINGS) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export const inTokyo = (p: LngLat) =>
  p[0] >= TOKYO_BBOX[0] && p[0] <= TOKYO_BBOX[2] && p[1] >= TOKYO_BBOX[1] && p[1] <= TOKYO_BBOX[3] && inRings(p);

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
