// 試走コース：出発地を出て出発地に戻る周回コースを探す。経由地（道路トンネル）の候補は AI ではなくプログラムが作る。
// 1案目はいちばんよい候補1本を経由して引き、合否表で判定する。合格しなければ次の候補を足して引き直す（最大5案、ルート計算は最大10回）。
import { z } from 'zod';
import { judge, llmCheck, MIN_TUNNEL_M, TUNNEL_NAME } from './check_route';
import { toSteps } from './steps';
import { defineOp, OpError, Ref, type CourseAttempt, type CourseOutput, type LngLat, type Place, type RouteOutput } from './types';
import { resolveRef } from '../server/session';
import { courseTunnels } from '../services/osm';
import { COURSE_RADIUS_M, LIMITS } from '../services/overpass';
import { distM, inTokyo, lineM, midOf } from '../services/region';
import { valhallaRoute, type VRoute } from '../services/valhalla';
import { noCourseTunnels, OUT_OF_AREA } from '../region-text';

const MAX_ATTEMPTS = 5;
const MAX_ROUTES = 10;
const ROADS = 'trunk|primary|secondary|tertiary|unclassified|residential'; // motorway と *_link は検索の段階で外す

const min1 = (sec: number) => Math.round(sec / 6) / 10;
const km2 = (km: number) => Math.round(km * 100) / 100;

interface Cand { id: number; name: string; named: boolean; m: number; mid: LngLat; heading?: number; layer: number }

/** 経由地にしない道路トンネル：有料、自動車専用・高速の扱いの trunk、車の通行不可、高さ 2.1m 未満 */
function excluded(t: Record<string, string>): boolean {
  if (t.toll === 'yes') return true;
  if (t.highway === 'trunk' && (t.motorroad === 'yes' || /首都高|高速|自動車道/.test(`${t.name ?? ''}${t['tunnel:name'] ?? ''}`))) return true;
  if (/^(no|private)$/.test(t.motor_vehicle ?? '') || (/^(no|private)$/.test(t.access ?? '') && t.motor_vehicle !== 'yes')) return true;
  return parseFloat(t.maxheight) < 2.1;
}

/** 出発地から 6km 以内の、地域の中の、名前があり 50m 以上の道路トンネル。順番はトンネルの名前がある → 出発地に近い（真ん中まで）。同じ名前（反対車線や続きの way）は1つだけ */
async function candidates(start: LngLat): Promise<{ cands: Cand[]; excluded: number }> {
  const { elements } = await courseTunnels(start, COURSE_RADIUS_M, ROADS);
  // 切った残りで選ぶと、候補が id の順で抜け落ちる。上限を超えたら止める
  if (elements.length > LIMITS.max_items) throw new OpError('limit', '出発地のまわりのトンネルが多すぎて、候補を選べません');
  let ex = 0;
  const all = elements.flatMap((w): Cand[] => {
    const t = w.tags ?? {};
    if (excluded(t)) { ex++; return []; }
    const line = (w.geometry ?? []).map((g): LngLat => [g.lon, g.lat]);
    const name = t['tunnel:name'] ?? t.name;
    const m = lineM(line);
    const { coord, heading } = midOf(line);
    if (!name || m < MIN_TUNNEL_M || !inTokyo(coord)) return [];
    const layer = parseInt(t.layer ?? '', 10);
    return [{
      id: w.id, name, named: !!t['tunnel:name'] || TUNNEL_NAME.test(t.name ?? ''), m, mid: coord, layer: Number.isNaN(layer) ? -1 : layer,
      // 一方通行は通れる向きで寄せる。両方向なら向きは Valhalla に任せる
      heading: t.oneway === 'yes' ? heading : t.oneway === '-1' ? (heading + 180) % 360 : undefined,
    }];
  });
  all.sort((a, b) => Number(b.named) - Number(a.named) || distM(a.mid, start) - distM(b.mid, start));
  const seen = new Set<string>();
  return { cands: all.filter((c) => !seen.has(c.name) && !!seen.add(c.name)), excluded: ex };
}

const viaPlace = (c: Cand): Place => ({ ref: `osm:way/${c.id}`, name: c.name, coord: c.mid, kind: 'tunnel', osm: `way/${c.id}` });

export const planCourse = defineOp({
  name: 'plan_course',
  title: '試走コース',
  description:
    '出発地を出て出発地に戻る周回の試走コースを作り、合否表をつける。経由地にする道路トンネルの候補はプログラムが作る' +
    '（出発地から 6km 以内の名前のある道路トンネル。有料・自動車専用・車両通行不可・高さ 2.1m 未満は除く）。' +
    '1案目はいちばんよい候補1本を経由し、合格しなければ次の候補を足して引き直す（最大5案、ルート計算は最大10回）。' +
    'トンネルは連続する tunnel=yes を1本と数え、50m 未満は数えない。avoid_highways が true なら高速道路と有料道路を除外して引く。',
  input: z.object({
    start: Ref.describe('出発地（＝到着地）の参照。現在地なら here:。view: は使えない'),
    tunnels: z.number().int().min(0).max(4).nullable().describe('通るトンネルの本数（1〜4）。指定がなければ null'),
    max_minutes: z.number().min(5).max(180).nullable().describe('時間の上限（分、5〜180）。「1時間半」は 90。指定がなければ null'),
    avoid_highways: z.boolean().describe('高速道路と有料道路を使わないなら true'),
  }),
  direct: true,
  async run({ session }, input): Promise<CourseOutput> {
    if (input.start === 'view:') throw new OpError('bad_ref', '「view:」は画面の範囲なので、出発地には使えません。地図をクリックするか、場所を検索してください');
    const start = resolveRef(session, input.start);
    if (!inTokyo(start.coord)) throw new OpError('out_of_area', OUT_OF_AREA);
    if (!input.tunnels) throw new OpError('bad_input', '通るトンネルの本数（1〜4本）を指定してください。試走コースはトンネルを経由地にして作ります');
    const { tunnels, max_minutes, avoid_highways } = input;
    const { cands, excluded: ex } = await candidates(start.coord);
    if (!cands.length) throw new OpError('not_found', noCourseTunnels(COURSE_RADIUS_M / 1000));

    // 経由地は出発地から見た向きの順に回る（行ったり来たりしない）
    // ponytail: 回る向きは1通りだけ試す。一方通行のトンネルで遠回りになるなら、逆回りも試す
    const angle = (c: Cand) => Math.atan2(c.mid[1] - start.coord[1], (c.mid[0] - start.coord[0]) * Math.cos((start.coord[1] * Math.PI) / 180));
    const tried: { vias: Cand[]; r: VRoute; a: CourseAttempt }[] = [];
    const kept: Cand[] = [];
    let next = 0, routes = 0, chosen: number | null = null;
    let stopped: CourseOutput['stopped_by'] = null;
    while (chosen == null) {
      if (tried.length >= MAX_ATTEMPTS) { stopped = 'attempts'; break; }
      if (routes >= MAX_ROUTES) { stopped = 'routes'; break; }
      if (next >= cands.length) { stopped = 'candidates'; break; }
      const add = cands[next++];
      const vias = [...kept, add].sort((a, b) => angle(a) - angle(b));
      routes++;
      const r = await valhallaRoute(
        [start.coord, ...vias.map((v) => ({ coord: v.mid, type: 'break_through' as const, heading: v.heading, layer: v.layer })), start.coord],
        { avoid_highways },
      ).catch((e) => { if (e instanceof OpError && e.code === 'not_found') return null; throw e; });
      if (!r) continue; // 道がつながらない候補は飛ばす
      const total = { minutes: min1(r.sec), km: km2(r.km) };
      const check = await judge(r.legs.map((l) => l.shape), total, input);
      tried.push({ vias, r, a: { via: vias.map((v) => ({ ref: `osm:way/${v.id}`, name: v.name, osm: `way/${v.id}` })), ...total, check } });
      if (check.verdict === 'pass') { chosen = tried.length - 1; break; }
      const row = (k: string) => check.rows.find((x) => x.kind === k)?.result;
      // 時間で落ちたら、足した候補を外して次を試す。トンネルが足りなければ、足した候補を通れていれば残して次を足す
      if (row('minutes') === 'fail') continue;
      if (row('tunnels') !== 'fail') { stopped = 'other'; break; } // 足しても直らない（高速を通る、判定不能など）
      if (check.tunnels.some((t) => !t.skip && t.ways.includes(`way/${add.id}`))) kept.push(add); // 2回目と数えた候補は残さない
    }
    const last = tried[chosen ?? tried.length - 1];
    if (!last) throw new OpError('not_found', 'コースを引けませんでした（経由地のトンネルまで道がつながりません）');

    // 地図・共有リンク・書き出しは、合格した案（なければ最後の案）をルートとして使う。経由地のトンネルは osm:way/… で参照できる
    const vias = last.vias.map(viaPlace);
    for (const v of vias) session.places.set(v.ref, v);
    const startName = start.name ?? '名前のない場所';
    const names = [startName, ...vias.map((v) => v.name ?? ''), startName];
    const course: RouteOutput = {
      from: start, to: start,
      stops: vias.map((v) => ({ requested: 'トンネル', chosen: v, alternatives: [] })),
      legs: last.r.legs.map((l, i) => ({ from: names[i], to: names[i + 1], minutes: min1(l.sec), km: km2(l.km), shape: l.shape, steps: toSteps(l.maneuvers, i > 0) })),
      total: { minutes: last.a.minutes, km: last.a.km },
      direct: { minutes: last.a.minutes, km: last.a.km }, // 周回なので寄り道なしの比べ先はない
      extra_min: 0,
      avoid_highways, keep_order: true, tried: routes,
    };
    session.route = course;
    return {
      start, conditions: { tunnels, max_minutes, avoid_highways }, radius_m: COURSE_RADIUS_M, candidates: cands.length, excluded: ex,
      attempts: tried.map((t) => t.a), chosen, stopped_by: chosen == null ? stopped : null, routes, course,
    };
  },
  llm: (o) => ({
    start: o.start.name, conditions: o.conditions, candidates: o.candidates, routes: o.routes, stopped_by: o.stopped_by,
    chosen_attempt: o.chosen == null ? null : o.chosen + 1,
    attempts: o.attempts.map((a, i) => ({ n: i + 1, via: a.via.map((v) => ({ ref: v.ref, name: v.name })), minutes: a.minutes, km: a.km, verdict: a.check.verdict })),
    result: llmCheck(o.attempts[o.chosen ?? o.attempts.length - 1].check),
  }),
});
