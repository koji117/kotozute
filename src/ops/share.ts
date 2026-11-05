// 共有リンク：いま地図に出ているもの（表示中の印、ルート、住所とピン）を保存して、リンクの ID を返す。
import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { defineOp, type BBox, type Layer, type Place, type RouteOutput, type Session, type ShareOutput, type ShareState } from './types';
import { OSM_DATA_AS_OF } from '../attribution';
import { resolveRef } from '../server/session';

const DIR = 'data/shares'; // data/ は .gitignore 済み
export const ID = /^[0-9A-Za-z]{10}$/; // レシピの ID も同じ形
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const newId = () => Array.from({ length: 10 }, () => B62[randomInt(62)]).join('');
// ponytail: メモリとファイルの両方に置く。ファイルは消さない。増えすぎたら期限で消す
const shares = new Map<string, ShareState>();

export const makeShareLink = defineOp({
  name: 'make_share_link',
  title: '共有リンク',
  description: 'いま地図に出ているもの（表示中の印、ルート、住所のピン）を保存して共有リンクを作る。「共有して」「リンクを送りたい」と頼まれたときに使う。',
  input: z.object({}),
  direct: true,
  async run({ session }): Promise<ShareOutput> {
    const visible = Object.values(session.layers).filter((l): l is Layer => !!l?.visible);
    const state: ShareState = {
      id: newId(),
      created_at: new Date().toISOString(),
      layers: visible.map((l) => ({ word: l.word, items: l.refs.map((r) => resolveRef(session, r)) })),
      osm_as_of: OSM_DATA_AS_OF,
      ...(session.route ? { route: sharedRoute(session.route) } : {}),
      pins: sharedPins(session),
      bbox: session.route ? routeBBox(session.route) : (session.view?.bbox ?? null),
    };
    mkdirSync(DIR, { recursive: true });
    writeFileSync(`${DIR}/${state.id}.json`, JSON.stringify(state));
    shares.set(state.id, state);
    return { id: state.id, url: `/?s=${state.id}`, includes_here: (!!session.route && hasHere(session.route)) || session.pins.some((p) => p.kind === 'here') };
  },
  llm: (out) => out,
});

/** GET /api/share/:id。形が違う ID と、ない ID は null */
export function loadShare(id: string): ShareState | null {
  if (!ID.test(id)) return null;
  const hit = shares.get(id);
  if (hit) return hit;
  try {
    const state = JSON.parse(readFileSync(`${DIR}/${id}.json`, 'utf8')) as ShareState;
    shares.set(id, state);
    return state;
  } catch {
    return null;
  }
}

// 開いた人には「現在地」ではなく、共有した人の現在地だと分かる名前で見せる（点は経路の端として残る）
const HERE_SHARED = '出発地（共有した人の現在地）';
export const hasHere = (r: RouteOutput) => [r.from, r.to, ...r.stops.map((s) => s.chosen)].some((p) => p.kind === 'here');
const relabel = (p: Place, name = HERE_SHARED): Place => (p.kind === 'here' ? { ...p, name, kind: 'place' } : p);
/** 住所の結果と add_pin のピン（同じ参照は1つ） */
function sharedPins(session: Session): Place[] {
  const pins = [...session.places].filter(([k]) => k.startsWith('abr:')).map(([, p]) => p);
  for (const p of session.pins) if (!pins.some((q) => q.ref === p.ref)) pins.push(relabel(p, '共有した人の現在地'));
  return pins;
}
function sharedRoute(r: RouteOutput): RouteOutput {
  return {
    ...r, from: relabel(r.from), to: relabel(r.to),
    stops: r.stops.map((s) => ({ ...s, chosen: relabel(s.chosen) })),
    legs: r.legs.map((l) => ({ ...l, from: l.from === '現在地' ? HERE_SHARED : l.from, to: l.to === '現在地' ? HERE_SHARED : l.to })),
  };
}

function routeBBox(r: RouteOutput): BBox {
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of [r.from.coord, r.to.coord, ...r.legs.flatMap((l) => l.shape)]) {
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
  }
  return b;
}
