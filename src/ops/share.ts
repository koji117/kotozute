// 共有リンク：いま地図に出ているもの（表示中の印、ルート、住所のピン）を保存して、リンクの ID を返す。
import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { defineOp, type BBox, type Layer, type RouteOutput, type ShareOutput, type ShareState } from './types';
import { resolveRef } from '../server/session';

const DIR = 'data/shares'; // data/ は .gitignore 済み
const ID = /^[0-9A-Za-z]{10}$/;
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
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
      id: Array.from({ length: 10 }, () => B62[randomInt(62)]).join(''),
      created_at: new Date().toISOString(),
      layers: visible.map((l) => ({ word: l.word, items: l.refs.map((r) => resolveRef(session, r)) })),
      ...(session.route ? { route: session.route } : {}),
      pins: [...session.places].filter(([k]) => k.startsWith('abr:')).map(([, p]) => p),
      bbox: session.route ? routeBBox(session.route) : (session.view?.bbox ?? null),
    };
    mkdirSync(DIR, { recursive: true });
    writeFileSync(`${DIR}/${state.id}.json`, JSON.stringify(state));
    shares.set(state.id, state);
    return { id: state.id, url: `/?s=${state.id}` };
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

function routeBBox(r: RouteOutput): BBox {
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of [r.from.coord, r.to.coord, ...r.legs.flatMap((l) => l.shape)]) {
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
  }
  return b;
}
