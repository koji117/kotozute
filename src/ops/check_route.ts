// 合否表：いま地図にあるルート（route か plan_course で引いたもの）を、通った道の生の OSM タグで判定する。
// 通った way は Valhalla の trace_attributes で取り、タグは Overpass で取り直す。Valhalla の値（edge.tunnel、lane_count など）では判定しない
// （lane_count は lanes タグがなくても値が入る）。
import { z } from 'zod';
import { defineOp, OpError, type CheckOutput, type CheckRouteOutput, type CheckRow, type CourseConditions, type LngLat, type TunnelRun, type Verdict } from './types';
import { wayTags } from '../services/overpass';
import { distM, midOf } from '../services/region';
import { valhallaTrace } from '../services/valhalla';

export const MIN_TUNNEL_M = 50; // これより短い tunnel=yes の区間は1本と数えない
export const SAME_TUNNEL_M = 100; // 真ん中どうしがこれより近いトンネルは同じトンネル（上下線）とみなす
/** name がトンネルの名前か。道路の名前（昭和通りなど）は別々のトンネルにも付くので、同じトンネルかの判定に使わない */
export const TUNNEL_NAME = /トンネル|隧道|地下道/;
const MERGE_GAP_M = 50; // lanes タグのない区間どうしの間がこれより短ければ1つにまとめる
const MAX_WAYS = 3000; // 生のタグを取り直す way の上限

const km2 = (m: number) => Math.round(m / 10) / 100;

interface Edge { way_id: number; m: number; line: LngLat[] }

/** 条件を満たす辺が続く区間（[始め, 終わり] の番号） */
function runsOf(edges: Edge[], pred: (e: Edge) => boolean): [number, number][] {
  const runs: [number, number][] = [];
  edges.forEach((e, i) => {
    if (!pred(e)) return;
    const last = runs.at(-1);
    if (last && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  });
  return runs;
}
const sumM = (es: Edge[]) => es.reduce((s, e) => s + e.m, 0);

/** ルートの区間ごとの形と、所要時間・距離（Valhalla の推定）から合否表を作る */
export async function judge(legs: LngLat[][], total: { minutes: number; km: number }, c: CourseConditions): Promise<CheckOutput> {
  // 1. 区間ごとに道へ重ねて、通った辺をつなぐ（周回を1本で重ねると edge_walk が失敗するため）
  const edges: Edge[] = [];
  let snapped = false;
  for (const shape of legs) {
    const t = await valhallaTrace(shape);
    snapped ||= t.snapped;
    for (const e of t.edges) edges.push({ way_id: e.way_id, m: e.m, line: t.shape.slice(e.from, e.to + 1) });
  }
  // 2. 通った way の生のタグを取り直す。見つからない way（way_id が 0 のつなぎの辺など）は判定に使えない
  const ids = [...new Set(edges.map((e) => e.way_id))];
  if (ids.length > MAX_WAYS) throw new OpError('limit', 'ルートが長すぎて判定できません');
  const tags = await wayTags(ids.filter((id) => id > 0));
  const tag = (e: Edge) => tags.get(e.way_id);
  const missing = ids.filter((id) => !tags.has(id)).length;

  // 3. トンネル：連続する tunnel=yes を1本、50m 未満は数えない（建物の通り抜け building_passage と暗渠 culvert は tunnel=yes ではない）。
  //    同じトンネルを2回通ったら（行きと帰りで上下線を通るなど）、2回目は数えない。
  //    同じトンネル＝同じトンネルの名前（tunnel:name か、name に「トンネル」など。道路の名前は使わない）か、真ん中どうしが 100m 以内
  // ponytail: 上下線を真ん中の近さで見分ける。名前のない別のトンネルが 100m 以内に並ぶと1本に数える
  const counted: { key: string | null; mid: LngLat }[] = [];
  const tunnels: TunnelRun[] = runsOf(edges, (e) => tag(e)?.tunnel === 'yes').map(([a, b]) => {
    const es = edges.slice(a, b + 1);
    const line = es.flatMap((e, i) => (i ? e.line.slice(1) : e.line));
    const ways = [...new Set(es.map((e) => e.way_id))];
    const ts = ways.map((id) => tags.get(id)!);
    const name = ts.map((t) => t['tunnel:name'] ?? t.name).find(Boolean) ?? null;
    const key = ts.map((t) => t['tunnel:name'] ?? (TUNNEL_NAME.test(t.name ?? '') ? t.name : undefined)).find(Boolean) ?? null;
    const m = sumM(es), mid = midOf(line).coord;
    const again = counted.some((t) => (key && t.key === key) || distM(t.mid, mid) < SAME_TUNNEL_M);
    const run: TunnelRun = { name, ways: ways.map((id) => `way/${id}`), m: Math.round(m), skip: m < MIN_TUNNEL_M ? 'short' : again ? 'repeat' : null, mid, line };
    if (!run.skip) counted.push({ key, mid });
    return run;
  });
  const count = counted.length;

  const rows: CheckRow[] = [];
  if (c.tunnels != null) {
    // 0本は「通らない」。1本以上は頼んだ本数以上で合格。見つからない way があって決められないときは判定不能
    const result: Verdict = c.tunnels === 0
      ? (count ? 'fail' : missing ? 'unknown' : 'pass')
      : (count >= c.tunnels ? 'pass' : missing ? 'unknown' : 'fail');
    rows.push({ kind: 'tunnels', want: c.tunnels, got: count, result });
  }
  if (c.avoid_highways) {
    const bad = edges.filter((e) => { const t = tag(e); return !!t && (/^motorway(_link)?$/.test(t.highway ?? '') || t.toll === 'yes'); });
    rows.push({ kind: 'no_highways', want: null, got: km2(sumM(bad)), result: bad.length ? 'fail' : missing ? 'unknown' : 'pass' });
  }
  if (c.max_minutes != null) rows.push({ kind: 'minutes', want: c.max_minutes, got: total.minutes, result: total.minutes <= c.max_minutes ? 'pass' : 'fail' });

  // 4. 車線数（参考。合否には使わない）：lanes キーがある way の距離の割合と、ない区間の数（間が 50m 未満ならまとめる）
  const hasLanes = (e: Edge) => 'lanes' in (tag(e) ?? {});
  const untagged: [number, number][] = [];
  for (const r of runsOf(edges, (e) => !hasLanes(e))) {
    const last = untagged.at(-1);
    if (last && sumM(edges.slice(last[1] + 1, r[0])) < MERGE_GAP_M) last[1] = r[1];
    else untagged.push(r);
  }
  const all = sumM(edges);

  const verdict: Verdict = rows.some((r) => r.result === 'fail') ? 'fail' : rows.some((r) => r.result === 'unknown') ? 'unknown' : 'pass';
  return {
    verdict, rows, tunnels,
    lanes: { tagged_share: all ? Math.round((sumM(edges.filter(hasLanes)) / all) * 1000) / 1000 : 0, untagged_runs: untagged.length },
    minutes: total.minutes, km: total.km, ways: ids.length, missing, snapped,
  };
}

/** LLM に返す合否表。座標は入れない */
export const llmCheck = (o: CheckOutput) => ({
  verdict: o.verdict, rows: o.rows, minutes: o.minutes, km: o.km,
  tunnels: o.tunnels.map((t) => ({ name: t.name, m: t.m, counted: !t.skip, ...(t.skip ? { not_counted: t.skip === 'short' ? '50m未満' : '同じトンネルの2回目' } : {}) })),
  lanes_reference: o.lanes, missing_ways: o.missing,
});

export const checkRoute = defineOp({
  name: 'check_route',
  title: '合否表',
  description:
    'いま地図にあるルート（route か plan_course で引いたもの）が条件に合うかを判定し、合否表を返す。新しいルートは引かない。' +
    '通った道の生の OSM タグで判定する：トンネルは連続する tunnel=yes を1本（50m 未満と、同じトンネルの2回目は数えない。0本は「通らない」）、' +
    '高速を使わないは highway=motorway・motorway_link と toll=yes の道を通らないこと、時間は Valhalla の推定。' +
    'タグがなくて決められない条件は判定不能。車線数は参考として lanes タグのある割合を返す（合否には使わない）。',
  input: z.object({
    tunnels: z.number().int().min(0).max(4).nullable().describe('通るトンネルの本数（0〜4）。見ないなら null'),
    max_minutes: z.number().min(5).max(180).nullable().describe('時間の上限（分、5〜180）。見ないなら null'),
    avoid_highways: z.boolean().describe('高速道路と有料道路を使っていないかを見るなら true'),
  }),
  direct: true,
  async run({ session }, input): Promise<CheckRouteOutput> {
    const r = session.route;
    if (!r) throw new OpError('not_found', 'いま地図にルートがありません。先にルートか試走コースを引いてください');
    if (input.tunnels == null && input.max_minutes == null && !input.avoid_highways) {
      throw new OpError('bad_input', '確かめる条件（トンネルの本数、時間の上限、高速を使わない）を1つ以上指定してください');
    }
    const check = await judge(r.legs.map((l) => l.shape), r.total, input);
    return { ...check, from: r.legs[0]?.from ?? '', to: r.legs.at(-1)?.to ?? '' };
  },
  llm: (o) => ({ from: o.from, to: o.to, ...llmCheck(o) }),
});
