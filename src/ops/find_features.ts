// 地物の絞り込み：業務の言葉（辞書）と範囲から、自社の Overpass で地物を探して地図に印を出す。
import { z } from 'zod';
import { DICT, type DictKey } from './dict';
import { MIN_TUNNEL_M, SAME_TUNNEL_M } from './check_route';
import { defineOp, Ref, Word, type BBox, type FeatureGroup, type FindFeaturesOutput, type LngLat, type Place } from './types';
import { addResult, resolveRef } from '../server/session';
import { features } from '../services/osm';
import { LIMITS, toPlace, type Area, type OsmElement } from '../services/overpass';
import { bboxKm2, distM, inTokyo, lineM, midOf } from '../services/region';

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
    // 先に全部の言葉を問い合わせ、全部成功してからセッションを変える（途中で失敗しても result:N の番号と印の表示がずれない）
    // ponytail: 言葉ごとに順に問い合わせる（最大5回）。遅ければ並列にする
    const fetched: { word: DictKey; elements: OsmElement[] }[] = [];
    for (const word of [...new Set(input.words)]) fetched.push({ word, elements: (await features(word, area, word === 'tunnel')).elements });
    for (const { word, elements } of fetched) {
      const tunnel = word === 'tunnel', crossing = CROSSINGS.has(word);
      const items = (tunnel ? mergeTunnels(elements) : crossing ? mergeCrossings(elements, word) : elements.map((e) => toPlace(e, word)))
        .filter((p) => inTokyo(p.coord))
        .sort((a, b) => distM(a.coord, place.coord) - distM(b.coord, place.coord))
        .slice(0, LIMITS.max_items)
        .map((p) => addResult(session, p));
      session.layers[word] = { word, refs: items.map((p) => p.ref), visible: true };
      const d = DICT[word];
      groups.push({ word, label: d.label, interpretation: d.interpretation, count: items.length, items, truncated: elements.length > LIMITS.max_items, ...(crossing ? { points: elements.length } : {}) });
    }
    return { area: { ref: input.area, label: place.name ?? '名前のない場所', bbox: bbox ?? circle, radius_m: bbox ? null : input.radius_m }, groups };
  },
  llm: (out) => ({
    area: out.area.label,
    groups: out.groups.map((g) => ({
      word: g.word, label: g.label, count: g.count, truncated: g.truncated,
      items: g.items.slice(0, 20).map((p) => ({ ref: p.ref, name: p.name })),
    })),
  }),
});

/**
 * トンネルの way を、点を共有するものどうし（続きの way、合流する way）で1本にまとめる。50m 未満は数えない。
 * 点を共有しない上下線は1本にする（合否表の数え方と同じ近さ 100m）。名前が同じなら、どこかが 100m 未満まで近づけば1本
 * （山手トンネルのような長いトンネルは、上下線の真ん中どうしが離れるため）。片方が名前なしなら、真ん中どうしが 100m 未満で1本。
 * 名前は tunnel:name か name（いちばん長い way から）、位置はいちばん長い way の真ん中
 */
export function mergeTunnels(ways: OsmElement[]): Omit<Place, 'ref'>[] {
  const byNode = new Map<number, OsmElement[]>();
  const groups = new Set<OsmElement[]>();
  for (const w of ways) {
    const hit = new Set((w.nodes ?? []).map((n) => byNode.get(n)).filter((g) => !!g));
    const g = [w, ...[...hit].flat()];
    hit.forEach((h) => groups.delete(h));
    groups.add(g);
    for (const x of g) for (const n of x.nodes ?? []) byNode.set(n, g);
  }
  const tunnel = (g: OsmElement[]) => {
    const lines = g.map((w) => ({ w, line: (w.geometry ?? []).map((p): LngLat => [p.lon, p.lat]) })).map((x) => ({ ...x, m: lineM(x.line) }));
    lines.sort((a, b) => b.m - a.m);
    const t = lines.map(({ w }) => w.tags ?? {});
    const name = t.map((x) => x['tunnel:name']).find(Boolean) ?? t.map((x) => x['name:ja'] ?? x.name).find(Boolean) ?? null;
    return { g, lines, name, mid: midOf(lines[0].line).coord, m: lines.reduce((s, x) => s + x.m, 0) };
  };
  type T = ReturnType<typeof tunnel>;
  // ponytail: 頂点どうしの総当たり。範囲の中のトンネルは数十本までなので足りる。遅ければ bbox で先にふるう
  const closest = (a: T, b: T) => {
    let d = Infinity;
    for (const { line: la } of a.lines) for (const p of la) for (const { line: lb } of b.lines) for (const q of lb) d = Math.min(d, distM(p, q));
    return d;
  };
  const same = (x: T, y: T) => (x.name && x.name === y.name ? closest(x, y) : (!x.name || !y.name) ? distM(y.mid, x.mid) : Infinity) < SAME_TUNNEL_M;
  const merged: T[] = [];
  for (const x of [...groups].map(tunnel)) {
    if (x.m < MIN_TUNNEL_M) continue;
    const i = merged.findIndex((y) => same(x, y));
    if (i < 0) merged.push(x);
    else merged[i] = tunnel([...merged[i].g, ...x.g]);
  }
  return merged.map(({ lines, name, mid }) => {
    const b = lines.flatMap(({ line }) => line);
    return {
      name, coord: mid, kind: 'tunnel' as const, osm: `way/${lines[0].w.id}`,
      bbox: [r6(Math.min(...b.map((c) => c[0]))), r6(Math.min(...b.map((c) => c[1]))), r6(Math.max(...b.map((c) => c[0]))), r6(Math.max(...b.map((c) => c[1])))] as BBox,
    };
  });
}

const CROSSINGS = new Set<DictKey>(['level_crossing', 'foot_crossing']);
/** 同じ踏切とみなす近さ（m）。名前が同じなら少し離れていても（複線の幅）1か所 */
export const SAME_CROSSING_M = 40, SAME_NAME_CROSSING_M = 200;

/**
 * 踏切：1つの踏切が、線路や車線の数だけ OSM の点に分かれている。
 * 40m 以内（名前が同じか、片方が名前なし）か、同じ名前で 200m 以内の点を1か所にまとめる。位置は点の平均、ID は最初の点
 */
export function mergeCrossings(nodes: OsmElement[], kind: Place['kind']): Omit<Place, 'ref'>[] {
  const same = (a: Omit<Place, 'ref'>, b: Omit<Place, 'ref'>) => {
    const d = distM(a.coord, b.coord);
    return (d < SAME_CROSSING_M && (!a.name || !b.name || a.name === b.name)) || (!!a.name && a.name === b.name && d < SAME_NAME_CROSSING_M);
  };
  let groups: Omit<Place, 'ref'>[][] = [];
  for (const p of nodes.map((e) => toPlace(e, kind))) {
    const hit = groups.filter((g) => g.some((q) => same(p, q))); // 2つのまとまりをつなぐ点なら、まとまりどうしも1つにする
    groups = [...groups.filter((g) => !hit.includes(g)), [...hit.flat(), p]];
  }
  return groups.map((g) => ({
    ...g[0],
    name: g.find((p) => p.name)?.name ?? null,
    coord: [r6(g.reduce((s, p) => s + p.coord[0], 0) / g.length), r6(g.reduce((s, p) => s + p.coord[1], 0) / g.length)] as LngLat,
  }));
}

/** 点と半径を囲む bbox（平面近似） */
function circleBBox([lng, lat]: [number, number], r: number): BBox {
  const dx = r / (111320 * Math.cos((lat * Math.PI) / 180)), dy = r / 110570;
  return [r6(lng - dx), r6(lat - dy), r6(lng + dx), r6(lat + dy)];
}
