import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { chat } from './claude';
import { getSession } from './session';
import { findOp, runOp } from '../ops/registry';
import { loadShare } from '../ops/share';
import { OpError, type ChatResponse, type ContextResponse, type Session } from '../ops/types';
import { inTokyo } from '../services/region';

const ASSETS = 'data/basemaps-assets-src/basemaps-assets-main';
export const app = new Hono();

// ===== 画面とのやりとり（型は src/ops/types.ts） =====
const SessionId = z.string().regex(/^[\w-]{8,64}$/);
const LngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const InTokyo = LngLat.refine(inTokyo, '対応する地域（東京都）の外です');
const View = z.object({
  bbox: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
    .refine(([w, s, e, n]) => w < e && s < n, '範囲の形が正しくありません'),
  zoom: z.number().min(0).max(24),
});
const ContextReq = z.object({
  sessionId: SessionId,
  here: z.object({ coord: InTokyo, accuracy_m: z.number().min(0).max(100_000) }).nullable().optional(),
  view: View.optional(),
  click: InTokyo.optional(),
});
const OpReq = z.object({ sessionId: SessionId, input: z.unknown(), view: View.optional() });
const ChatReq = z.object({ sessionId: SessionId, text: z.string().trim().min(1, '依頼が空です').max(300, '依頼は300文字までにしてください'), view: View.optional() });

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  // JSON だけ受ける。ほかのサイトから送らせない（JSON は事前確認が要り、CORS は開けていないので通らない）
  if (!c.req.header('content-type')?.startsWith('application/json')) throw new HTTPException(415, { message: '送られたデータの形式が JSON ではありません' });
  const p = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!p.success) throw new HTTPException(400, { message: `送られたデータが正しくありません（${p.error.issues[0]?.message ?? ''}）` });
  return p.data;
}

function withView(id: string, view: Session['view']) {
  const s = getSession(id);
  if (view) s.view = view;
  return s;
}

app.use('/api/*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: '送られたデータが大きすぎます' }, 413) }));

// 現在地・画面の範囲・クリックを伝える。座標はここで受けてセッションに置き、LLM には参照名だけを渡す
app.post('/api/context', async (c) => {
  const req = await body(c, ContextReq);
  const s = withView(req.sessionId, req.view);
  if (req.here === null) delete s.here;
  else if (req.here) s.here = req.here;
  const res: ContextResponse = {};
  if (req.click) {
    if (s.clicks.length >= 9999) throw new OpError('limit', 'クリックした点が多すぎます。画面を読み込み直してください');
    s.clicks.push(req.click);
    res.clickRef = `click:${s.clicks.length}`;
  }
  return c.json(res);
});

// 画面の札やボタンから AI を通さずに呼ぶ（direct: true の操作だけ）
app.post('/api/op/:name', async (c) => {
  const op = findOp(c.req.param('name'));
  if (!op?.direct) return c.json({ error: 'その操作はありません' }, 404);
  const req = await body(c, OpReq);
  return c.json(await runOp(op.name, { session: withView(req.sessionId, req.view), source: 'direct' }, req.input));
});

app.post('/api/chat', async (c) => {
  const req = await body(c, ChatReq);
  const res: ChatResponse = await chat(withView(req.sessionId, req.view), req.text);
  return c.json(res);
});

app.get('/api/share/:id', (c) => {
  const state = loadShare(c.req.param('id'));
  return state ? c.json(state) : c.json({ error: '共有リンクが見つかりません' }, 404);
});

app.onError((e, c) => {
  if (e instanceof HTTPException) return c.json({ error: e.message }, e.status);
  if (e instanceof OpError) return c.json({ error: e.message, code: e.code }, 400);
  console.error('[server]', e);
  return c.json({ error: 'サーバでエラーが起きました' }, 500);
});

// 地図ファイル（Range 対応）とフォント・アイコンはすべて自前で配信する。公開CDNは使わない。
app.get('/tiles/tokyo.pmtiles', serveStatic({ path: 'tokyo.pmtiles' }));
app.use('/assets/*', serveStatic({ root: ASSETS, rewriteRequestPath: p => decodeURIComponent(p.replace(/^\/assets/, '')) }));
app.use('/*', serveStatic({ root: 'dist' })); // vite build の出力

// 直接起動したときだけ待ち受ける（確認用のスクリプトは app だけを読む）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }); // 手元だけ。外から使うときは tailscale serve を前に置く
  console.log(`kotozute server http://localhost:${port}`);
}
