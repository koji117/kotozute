// 地物の絞り込み：業務の言葉（辞書）と範囲から、自社の Overpass で地物を探して地図に印を出す。
import { z } from 'zod';
import { DICT } from './dict';
import { defineOp, Ref, Word, type BBox, type FeatureGroup, type FindFeaturesOutput } from './types';
import { addResult, resolveRef } from '../server/session';
import { featureQuery, LIMITS, overpass, toPlace, type Area } from '../services/overpass';
import { bboxKm2, distM, inTokyo } from '../services/region';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export const findFeatures = defineOp({
  name: 'find_features',
  title: '地物の絞り込み',
  description:
    '業務の言葉（郵便局、手土産、コンビニなど）で地物を OSM から探し、地図に印を出す。' +
    'area が view: なら画面の範囲、公園など半径の円より広い場所ならその範囲、それ以外（建物、住所、現在地など）はその場所から半径 radius_m の中を探す。' +
    '見つかった地物は result:N の参照で返る。0件は「OSM上で0件」で、現地にないとは限らない。',
  input: z.object({
    words: z.array(Word).min(1).max(5).describe('探す業務の言葉（辞書のキー）。1〜5個'),
    area: Ref.describe('探す範囲の参照。view: は画面の範囲'),
    radius_m: z.literal([300, 500, 1000, 2000]).describe('場所の周りを探すときの半径（m）。view: と、半径の円より広い場所では使わない'),
  }),
  direct: true,
  async run({ session }, input): Promise<FindFeaturesOutput> {
    const place = resolveRef(session, input.area);
    // 建物のように円より狭い範囲しかない場所は、その中ではなく周りを半径で探す
    const circle = circleBBox(place.coord, input.radius_m);
    const bbox = place.bbox && (input.area === 'view:' || bboxKm2(place.bbox) > bboxKm2(circle)) ? place.bbox : undefined;
    const area: Area = bbox ? { bbox } : { around: { points: [place.coord], radius_m: input.radius_m } };
    const groups: FeatureGroup[] = [];
    // ponytail: 言葉ごとに順に問い合わせる（最大5回）。遅ければ並列にする
    for (const word of [...new Set(input.words)]) {
      const { elements } = await overpass(featureQuery(word, area));
      const items = elements
        .map((e) => toPlace(e, word))
        .filter((p) => inTokyo(p.coord))
        .sort((a, b) => distM(a.coord, place.coord) - distM(b.coord, place.coord))
        .slice(0, LIMITS.max_items)
        .map((p) => addResult(session, p));
      session.layers[word] = { word, refs: items.map((p) => p.ref), visible: true };
      const d = DICT[word];
      groups.push({ word, label: d.label, interpretation: d.interpretation, count: items.length, items, truncated: elements.length > LIMITS.max_items });
    }
    return { area: { ref: input.area, label: place.name ?? '名前のない場所', bbox: bbox ?? circle }, groups };
  },
  llm: (out) => ({
    area: out.area.label,
    groups: out.groups.map((g) => ({
      word: g.word, label: g.label, count: g.count, truncated: g.truncated,
      items: g.items.slice(0, 20).map((p) => ({ ref: p.ref, name: p.name })),
    })),
  }),
});

/** 点と半径を囲む bbox（平面近似） */
function circleBBox([lng, lat]: [number, number], r: number): BBox {
  const dx = r / (111320 * Math.cos((lat * Math.PI) / 180)), dy = r / 110570;
  return [r6(lng - dx), r6(lat - dy), r6(lng + dx), r6(lat + dy)];
}
