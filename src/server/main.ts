import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { chat } from './claude';
import { installNetlog, withNetlog } from './netlog';
import { DEMO_HERE, LIMIT_TEXT, limitsFromEnv } from './limits';
import { loadRecipe, runRecipe, saveRecipe } from './recipe';
import { getSession } from './session';
import { findOp, runOp } from '../ops/registry';
import { loadShare } from '../ops/share';
import { blockedWords, envBlockWords } from '../ops/note_rules';
import { OpError, type ChatResponse, type ContextResponse, type RecipeRunResponse, type Session } from '../ops/types';
import { inTokyo } from '../services/region';
import { elementTags } from '../services/osm';
import { pickDetails, type PoiResponse } from '../poi';
import { OSM_DATA_AS_OF } from '../attribution';
import { REGION, webRegion } from '../region';
import { OUTSIDE_POINT } from '../region-text';

const ASSETS = 'data/basemaps-assets-src/basemaps-assets-main';
export const app = new Hono();
installNetlog(); // 外部通信の記録（サーバが出す fetch を数える）

// ===== 画面とのやりとり（型は src/ops/types.ts） =====
const SessionId = z.string().regex(/^[\w-]{8,64}$/);
const LngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const View = z.object({
  bbox: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
    .refine(([w, s, e, n]) => w < e && s < n, '範囲の形が正しくありません'),
  zoom: z.number().min(0).max(24),
});
const Here = z.object({ coord: LngLat, accuracy_m: z.number().min(0).max(100_000) });
const ContextReq = z.object({
  sessionId: SessionId,
  here: Here.nullable().optional(),
  view: View.optional(),
  click: LngLat.optional(),
  /** 公開版だけ：試用の現在地を使う（座標はサーバが持つ） */
  demoHere: z.literal(true).optional(),
});
const OpReq = z.object({ sessionId: SessionId, input: z.unknown(), view: View.optional() });
// here・demoHere：画面が持っている現在地。依頼のたびに送る（サーバを動かし直すとセッションが消え、画面には現在地が出たままでも here: が使えなくなるため）
const ChatReq = z.object({
  sessionId: SessionId, text: z.string().trim().min(1, '依頼が空です').max(300, '依頼は300文字までにしてください'), view: View.optional(),
  here: Here.optional(), demoHere: z.literal(true).optional(),
});

/** 画面の現在地をセッションに置く（/api/context と /api/chat）。地域の外は断る */
function setHere(s: Session, req: { here?: Session['here'] | null; demoHere?: true }) {
  if (req.here && !inTokyo(req.here.coord)) throw new OpError('out_of_area', OUTSIDE_POINT);
  if (req.here !== undefined) delete s.hereLabel; // 見ている人の現在地（または無し）が、レシピを保存した人の現在地に代わる
  if (req.here === null) delete s.here;
  else if (req.here) s.here = req.here;
  if (req.demoHere) {
    if (!LIMITS) throw new HTTPException(400, { message: '試用の現在地は公開版だけで使えます' });
    s.here = { coord: DEMO_HERE.coord, accuracy_m: DEMO_HERE.accuracy_m };
    s.hereLabel = DEMO_HERE.label; // ルートなどでは、この名前の場所として出る（session.ts の resolveRef）
  }
}

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

// Host が手元か、ALLOWED_HOSTS（カンマ区切り。tailscale serve の名前など）のときだけ API を受ける
const ALLOWED = new Set(['127.0.0.1', 'localhost', ...(process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)]);
app.use('/api/*', async (c, next) => {
  const host = (c.req.header('host') ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!ALLOWED.has(host)) return c.json({ error: 'この名前からは使えません（ALLOWED_HOSTS）' }, 403);
  await next();
});
app.use('/api/*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: '送られたデータが大きすぎます' }, 413) }));
// 公開版（KOTOZUTE_PUBLIC=1）だけの回数の上限（src/server/limits.ts）。IP は Cloudflare のトンネルが付ける CF-Connecting-IP
const LIMITS = limitsFromEnv();
const ipOf = (c: Context) => c.req.header('cf-connecting-ip') ?? 'local';
app.use('/api/*', async (c, next) => {
  if (LIMITS && !LIMITS.hit(ipOf(c))) return c.json({ error: LIMIT_TEXT.minute }, 429);
  await next();
});

// 現在地・画面の範囲・クリックを伝える。座標はここで受けてセッションに置き、LLM には参照名だけを渡す
app.post('/api/context', async (c) => {
  const req = await body(c, ContextReq);
  // 地域の外の点は、セッションを変える前に断る。文は画面にそのまま出す（「送られたデータが正しくありません」で包まない）
  if ([req.here?.coord, req.click].some((p) => p && !inTokyo(p))) throw new OpError('out_of_area', OUTSIDE_POINT);
  const s = withView(req.sessionId, req.view);
  setHere(s, req);
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
  if (LIMITS && op.name === 'make_share_link' && !LIMITS.save()) return c.json({ error: LIMIT_TEXT.save }, 429);
  const req = await body(c, OpReq);
  const [r, net] = await withNetlog(() => runOp(op.name, { session: withView(req.sessionId, req.view), source: 'direct' }, req.input));
  return c.json({ ...r, net });
});

app.post('/api/chat', async (c) => {
  const req = await body(c, ChatReq);
  const lim = LIMITS?.chat(ipOf(c));
  if (lim && lim !== 'ok') return c.json({ error: LIMIT_TEXT[lim] }, 429);
  const s = withView(req.sessionId, req.view);
  setHere(s, req);
  const [res, net] = await withNetlog(() => chat(s, req.text));
  return c.json({ ...res, net } satisfies ChatResponse);
});

// レシピ：このセッションで成功した操作の並びを保存する。再実行は Claude を使わない
const SessionReq = z.object({ sessionId: SessionId });
app.post('/api/recipe', async (c) => {
  const req = await body(c, SessionReq);
  if (LIMITS && !LIMITS.save()) return c.json({ error: LIMIT_TEXT.save }, 429);
  return c.json(saveRecipe(getSession(req.sessionId)));
});
app.get('/api/recipe/:id', (c) => {
  const r = loadRecipe(c.req.param('id'));
  return r ? c.json(r) : c.json({ error: 'レシピが見つかりません' }, 404);
});
app.post('/api/recipe/:id/run', async (c) => {
  const recipe = loadRecipe(c.req.param('id'));
  if (!recipe) return c.json({ error: 'レシピが見つかりません' }, 404);
  const req = await body(c, SessionReq);
  // 再実行の中の共有リンクも、保存の上限に数える（数えないと、再実行で上限を超えて保存できる）
  const shares = recipe.steps.filter((s) => s.op === 'make_share_link').length;
  if (LIMITS) for (let i = 0; i < shares; i++) if (!LIMITS.save()) return c.json({ error: LIMIT_TEXT.save }, 429);
  const [steps, net] = await withNetlog(() => runRecipe(req.sessionId, recipe));
  return c.json({ steps, recipe, net } satisfies RecipeRunResponse);
});

// OSM ノートの下書きに入れてはいけない語。NOTE_BLOCK_WORDS（社名など。.env か、Mac のアプリでは note-block-words.txt）も使う。見つかった語だけ返す
// 公開版では NOTE_BLOCK_WORDS を使わない（外から語を送って当たりを見れば、登録した社名などが分かってしまうため）
app.post('/api/note/check', async (c) => {
  const { text } = await body(c, z.object({ text: z.string().max(2000, 'ノートは2000文字までにしてください') }));
  return c.json({ blocked: blockedWords(text, LIMITS ? [] : envBlockWords()) });
});

// 地点の詳細（地図の印をクリックしたときのカード）。AI を通さず、OSM のタグから決まったものだけを返す
app.get('/api/poi/:type/:id', async (c) => {
  const type = c.req.param('type'), id = c.req.param('id');
  if (!/^(node|way|relation)$/.test(type) || !/^[1-9]\d{0,11}$/.test(id)) return c.json({ error: '地点の指定が正しくありません' }, 400);
  const osm = `${type}/${id}`;
  const tags = await elementTags(osm);
  if (!tags) return c.json({ error: 'OSM上で見つかりません' }, 404);
  return c.json({ osm, tags: pickDetails(tags), osm_as_of: OSM_DATA_AS_OF } satisfies PoiResponse);
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
// path は根からの相対でも絶対パスでもよい（serveStatic は root '' と join するので、絶対パスはそのまま。アプリのデータは絶対パス）
app.get(`/tiles/${basename(REGION.tiles)}`, serveStatic({ path: REGION.tiles })); // 画面は同じ名前で読む（src/web/main.ts）
// 画面（index.html）には今の地域の値（データ時点など）を入れて返す。dist は build のときの値を持ち、それを上書きする（vite.config.ts）
const regionTag = `<script type="application/json" id="kz-region">${JSON.stringify(webRegion(REGION)).replace(/</g, '\\u003c')}</script>`;
// 公開版だけ：試用の現在地を画面に渡す（src/web/main.ts の DEMO_HERE）
const publicTag = LIMITS ? `<script type="application/json" id="kz-public">${JSON.stringify({ demoHere: DEMO_HERE }).replace(/</g, '\\u003c')}</script>` : '';
const page = async (c: Context, next: () => Promise<void>) => {
  if (!existsSync('dist/index.html')) return next();
  return c.html(readFileSync('dist/index.html', 'utf8').replace('</head>', () => `${regionTag}${publicTag}</head>`));
};
app.get('/', page);
app.get('/index.html', page);
app.use('/assets/*', serveStatic({ root: ASSETS, rewriteRequestPath: p => decodeURIComponent(p.replace(/^\/assets/, '')) }));
app.use('/*', serveStatic({ root: 'dist' })); // vite build の出力

// 直接起動したときだけ待ち受ける（確認用のスクリプトは app だけを読む）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }); // 手元だけ。外から使うときは tailscale serve を前に置く
  console.log(`kotozute server http://localhost:${port}${LIMITS ? '（公開版：回数の上限あり）' : ''}`);
  // Mac のアプリ（KOTOZUTE_DATA_DIR）は止める語を note-block-words.txt から渡す（desktop/main.mjs）。語そのものは出さない
  const dataDir = process.env.KOTOZUTE_DATA_DIR;
  if (!envBlockWords().length) {
    console.warn(dataDir ? `OSM ノートで止める語が ${join(dataDir, 'note-block-words.txt')} にありません（メニュー「OSM ノートで止める語…」）。社名はOSMノートの確認で止まりません`
      : 'NOTE_BLOCK_WORDS が .env にありません。社名はOSMノートの確認で止まりません');
  }
  // Mac のアプリから起こされたときは、標準入力が閉じたら（アプリが強制終了で止まったときも）終わる。子として残らない
  if (dataDir) process.stdin.on('end', () => process.exit(0)).resume();
}
