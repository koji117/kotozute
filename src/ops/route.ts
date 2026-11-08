// ルート：出発地から目的地まで、寄り道（場所の参照か業務の言葉）をはさんで自社の Valhalla で引く。
// 言葉の寄り道は、寄り道なしのルートの近く（300 m 以内）の候補から、合計時間が最小の組み合わせを選ぶ。
import { z } from 'zod';
import { DICT, type DictKey } from './dict';
import { defineOp, OpError, Ref, Word, type Leg, type LngLat, type Place, type RouteOutput, type StopChoice } from './types';
import { toSteps } from './steps';
import { addResult, resolveRef } from '../server/session';
import { features } from '../services/osm';
import { toPlace } from '../services/overpass';
import { distM, inTokyo } from '../services/region';
import { valhallaRoute, type VRoute } from '../services/valhalla';
import { OUT_OF_AREA, STOP_SEARCH_ERROR } from '../region-text';

const CORRIDOR_M = 300; // ルートからこの距離までを候補にする
const THIN_M = 100; // 検索文を短くするため、ルートの形をこの間隔に間引く
const KEEP = 4; // 言葉ごとに残す候補の数
const MAX_CALLS = 30; // Valhalla を呼ぶ回数の上限（寄り道なしの1回を含む）

const min1 = (sec: number) => Math.round(sec / 6) / 10;
const km2 = (km: number) => Math.round(km * 100) / 100;

/** 点と折れ線の距離（m、平面近似） */
function distToLine([x, y]: LngLat, line: LngLat[]): number {
  const kx = 111320 * Math.cos((y * Math.PI) / 180), ky = 110570;
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

/** 前に残した点から THIN_M 以上離れた点だけ残す（最後の点は必ず残す） */
function thin(line: LngLat[]): LngLat[] {
  const out = [line[0]];
  for (const p of line.slice(1, -1)) if (distM(out[out.length - 1], p) >= THIN_M) out.push(p);
  out.push(line[line.length - 1]);
  return out;
}

/** 並べ方の全部 */
const perms = (xs: number[]): number[][] =>
  xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

/** 候補の組み合わせの全部（候補の番号の並び） */
const product = (ns: number[]): number[][] =>
  ns.reduce<number[][]>((acc, n) => acc.flatMap((a) => Array.from({ length: n }, (_, j) => [...a, j])), [[]]);

type Cand = Omit<Place, 'ref'> & { ref?: string };

/**
 * 寄り道先で過ごす時間の合計と、着きたい時刻から逆算した出発の時刻（運転＋過ごす時間。渋滞は含まない）。
 * 出発の時刻は分を切り捨てる（遅れない側）。日をまたぐときは 24時間で回す
 */
export function arrival(sec: number, stops: { stay_min: number | null }[], arrive_by: string | null) {
  const stay_min = stops.reduce((n, s) => n + (s.stay_min ?? 0), 0);
  if (!arrive_by) return { stay_min, arrive_by: null, depart_by: null };
  const [h, m] = arrive_by.split(':').map(Number);
  const t = (((Math.floor(h * 60 + m - sec / 60 - stay_min)) % 1440) + 1440) % 1440;
  return { stay_min, arrive_by: `${h}:${String(m).padStart(2, '0')}`, depart_by: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` };
}
const nameOf = (p: Cand) => p.name ?? (p.kind in DICT ? DICT[p.kind as DictKey].label : p.ref ?? '');

export const route = defineOp({
  name: 'route',
  title: 'ルート',
  description:
    '自動車のルートを引く（自社の Valhalla）。出発地と目的地は場所の参照。寄り道（最大3つ）は、決まった場所なら ref、' +
    '「郵便局」のような種類なら word（業務の言葉）のどちらか1つを指定する。word の寄り道は、寄り道なしのルートから 300 m 以内の候補から' +
    '合計時間が最小になるものを選ぶ。keep_order が true なら寄り道は指定の順に回る。avoid_highways が true なら高速道路を通らない。' +
    'arrive_by は依頼に着きたい時刻があるときだけ入れ、出発の時刻を逆算する。stay_min は依頼に寄り道先で過ごす時間が書いてあるときだけ入れる（なければ null。推測で入れない）。',
  input: z.object({
    from: Ref.describe('出発地の参照。現在地なら here:。view: は使えない'),
    to: Ref.describe('目的地の参照。view: は使えない'),
    stops: z.array(z.object({
      ref: Ref.nullable().describe('決まった場所の寄り道。word を使うときは null'),
      word: Word.nullable().describe('種類で指定する寄り道（例：post_office）。ref を使うときは null'),
      stay_min: z.number().int().min(0).max(240).nullable().default(null).describe('その寄り道先で過ごす時間（分）。依頼に書いてあるときだけ。なければ null'),
    })).max(3).describe('寄り道。なければ空の配列'),
    arrive_by: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).nullable().default(null).describe('着きたい時刻（24時間制の H:MM。例：15:20）。依頼にあるときだけ。なければ null'),
    keep_order: z.boolean().describe('寄り道を指定の順に回るなら true'),
    avoid_highways: z.boolean().describe('高速道路を通らないなら true'),
  }),
  direct: true,
  async run({ session }, input): Promise<RouteOutput> {
    const { avoid_highways, keep_order } = input;
    for (const st of input.stops) {
      if ((st.ref == null) === (st.word == null)) throw new OpError('bad_input', '寄り道は、場所の参照か業務の言葉のどちらか1つで指定してください');
    }
    // view: は範囲なので地点にしない（中心に引くと、画面や東京都の真ん中へのルートになる）
    const point = (ref: string) => {
      if (ref === 'view:') throw new OpError('bad_ref', '「view:」は画面の範囲なので、ルートの地点には使えません。地図をクリックするか、場所を検索してください');
      const p = resolveRef(session, ref);
      if (!inTokyo(p.coord)) throw new OpError('out_of_area', OUT_OF_AREA);
      return p;
    };
    const from = point(input.from);
    const to = point(input.to);
    const refStops = input.stops.map((st) => (st.ref ? point(st.ref) : null));

    // 1. 寄り道なし
    const direct = await valhallaRoute([from.coord, to.coord], { avoid_highways });
    const line = direct.legs[0].shape;

    // 2. 寄り道ごとの候補（言葉はルートの近くを Overpass で探し、近い順に KEEP 件）。同じ言葉は1回だけ探す
    const found = new Map<DictKey, Cand[]>();
    for (const { word } of input.stops) {
      if (!word || found.has(word)) continue;
      // Overpass は同じ検索文が短い間に続くと JSON でない応答（duplicate_query）を返すので、OpError にする
      const { elements } = await features(word, { around: { points: thin(line), radius_m: CORRIDOR_M } }).catch((e) => {
        throw e instanceof OpError ? e : new OpError('service', STOP_SEARCH_ERROR);
      });
      // ponytail: Overpass は上限 +1 件で切るので、長いルートで件数が多いと近い順が崩れる。道路につながらない候補は組み合わせで落ちるだけで、次の候補で埋めない
      const near = elements
        .map((e) => toPlace(e, word))
        .map((p) => ({ p, d: distToLine(p.coord, line) }))
        .filter(({ p, d }) => d <= CORRIDOR_M && inTokyo(p.coord))
        .sort((a, b) => a.d - b.d)
        .slice(0, KEEP)
        .map(({ p }) => p);
      if (!near.length) throw new OpError('not_found', `ルートの近く（${CORRIDOR_M} m 以内）に${DICT[word].label}がOSM上で見つかりません（現地にないとは限らない）`);
      found.set(word, near);
    }
    const lists: Cand[][] = input.stops.map((st, i) => (st.word ? [...found.get(st.word)!] : [refStops[i]!]));

    // 3. 組み合わせを作る。上限を超えるなら、候補のいちばん多い寄り道から遠い候補を減らす
    const idx = input.stops.map((_, i) => i);
    const orders = keep_order ? [idx] : perms(idx);
    const count = () => orders.length * lists.reduce((n, l) => n * l.length, 1);
    while (count() > MAX_CALLS - 1) lists.reduce((a, b) => (b.length > a.length ? b : a)).pop();
    // 言葉で選んだ候補が、ほかの寄り道と同じ場所になる組み合わせ（同じ言葉を2つ頼まれたときなど）は試さない
    const twice = (picks: number[]) => {
      const ps = picks.map((j, i) => lists[i][j]);
      return ps.some((p, i) => !p.ref && ps.some((q, k) => k !== i && q.osm === p.osm));
    };
    const combos = orders.flatMap((order) => product(lists.map((l) => l.length)).filter((p) => !twice(p)).map((picks) => ({ order, picks })));
    const key = (order: number[], picks: number[]) => `${order.join()}|${picks.join()}`;

    // 4. 全部引いて合計時間が最小のものを選ぶ（寄り道がなければ寄り道なしのルートをそのまま使う）
    const routes = new Map<string, VRoute>();
    await Promise.all(combos.map(async ({ order, picks }) => {
      if (!order.length) { routes.set(key(order, picks), direct); return; }
      const pts = [from.coord, ...order.map((i) => lists[i][picks[i]].coord), to.coord];
      try {
        routes.set(key(order, picks), await valhallaRoute(pts, { avoid_highways }));
      } catch (e) {
        if (!(e instanceof OpError && e.code === 'not_found')) throw e; // 引けない組み合わせは飛ばす
      }
    }));
    let best: { order: number[]; picks: number[]; r: VRoute } | null = null;
    for (const c of combos) {
      const r = routes.get(key(c.order, c.picks));
      if (r && (!best || r.sec < best.r.sec)) best = { ...c, r };
    }
    if (!best) throw new OpError('not_found', '寄り道を入れたルートが見つかりませんでした');

    // 5. 選んだ候補と、ほかの候補（その1か所だけ入れ替えたときの追加時間）。地物は result:N で参照できるようにする
    const reg = (p: Cand): Place => (p.ref ? (p as Place) : (p.osm && session.places.get(`osm:${p.osm}`)) || addResult(session, p));
    const b = best;
    const stops: StopChoice[] = b.order.map((i) => {
      const st = input.stops[i];
      const alternatives = lists[i].flatMap((c, j) => {
        if (j === b.picks[i]) return [];
        const r = routes.get(key(b.order, b.picks.map((x, k) => (k === i ? j : x))));
        return r ? [{ place: reg(c), extra_min: min1(r.sec - b.r.sec) }] : [];
      });
      return { requested: st.word ? DICT[st.word].label : nameOf(refStops[i]!), chosen: reg(lists[i][b.picks[i]]), alternatives, stay_min: st.stay_min };
    });

    // 6. 区間
    const names = [nameOf(from), ...stops.map((s) => nameOf(s.chosen)), nameOf(to)];
    const legs: Leg[] = b.r.legs.map((l, i) => ({
      from: names[i], to: names[i + 1], minutes: min1(l.sec), km: km2(l.km), shape: l.shape, steps: toSteps(l.maneuvers, i > 0),
    }));
    const out: RouteOutput = {
      from, to, stops, legs,
      total: { minutes: min1(b.r.sec), km: km2(b.r.km) },
      direct: { minutes: min1(direct.sec), km: km2(direct.km) },
      extra_min: min1(b.r.sec - direct.sec),
      avoid_highways, keep_order, tried: combos.length,
      ...arrival(b.r.sec, stops, input.arrive_by),
    };
    session.route = out;
    return out;
  },
  llm: (o) => ({
    from: o.legs[0]?.from, to: o.legs[o.legs.length - 1]?.to,
    stops: o.stops.map((s) => ({ ref: s.chosen.ref, name: s.chosen.name, requested: s.requested, alternatives: s.alternatives.length })),
    total: o.total, direct_minutes: o.direct.minutes, extra_min: o.extra_min,
    stay_min: o.stay_min, arrive_by: o.arrive_by, depart_by: o.depart_by,
    avoid_highways: o.avoid_highways, tried: o.tried,
    legs: o.legs.map((l) => ({ from: l.from, to: l.to, minutes: l.minutes, km: l.km })),
  }),
});
