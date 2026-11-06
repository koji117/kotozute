// 比べる確認（golden）：Claude を呼ばずに、保存したレシピ、評価の第3回で Claude が呼んだ操作、デモの場面を同じ順に回し、
// 操作ごとの入力と結果を1つの JSON に書く。作りを変える前と後で回し、2つのファイルの diff が空なら同じ。
// 実行：npx tsx scripts/golden.ts --out <ファイル> [--recipes data/recipes]
// 自社の Overpass・Valhalla・ABR が要る。API キーは要らない。Overpass は同じ検索文を別のプロセスから約30秒以内に送ると断るので、続けて回さない。
// 失敗にする条件：第3回で成功した操作かデモの操作が失敗した、どこかの操作が limit で失敗した（何も試さずに通るのを防ぐ）。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

process.env.OPLOG_FILE = join(tmpdir(), `kotozute-golden-ops-${process.pid}.jsonl`); // logs/ops.jsonl に書かない
const { findOp, runOp } = await import('../src/ops/registry.ts');
const { runRecipe } = await import('../src/server/recipe.ts');
const { getSession } = await import('../src/server/session.ts');
type OpResult = import('../src/ops/types.ts').OpResult;
type Recipe = import('../src/ops/types.ts').Recipe;
type Session = import('../src/ops/types.ts').Session;
type LngLat = import('../src/ops/types.ts').LngLat;

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const OUT = arg('--out');
if (!OUT) { console.error('使い方：npx tsx scripts/golden.ts --out <ファイル> [--recipes data/recipes]'); process.exit(1); }
const RECIPES = arg('--recipes') ?? 'data/recipes';
const EVAL_SET = 'eval/set.jsonl';
const EVAL_RUN = 'eval/runs/2026-11-05T13-51-03-359Z.json'; // 評価の第3回（50/50）

const DEFAULT_VIEW = { bbox: [139.715, 35.645, 139.789, 35.691], zoom: 13.5 } as Session['view']; // scripts/eval.ts と同じ
const HERE = { coord: [139.7379847, 35.6288086] as LngLat, accuracy_m: 30 }; // 撮影の現在地（品川駅 高輪口 node/265050703）

// ===== 1件を回す（limit で断られたら60秒待って、新しいセッションで1回だけやり直す） =====
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, OpResult[]> = {};
const failures: string[] = [];

/** want[i]：i 番目の操作が成功するはずか */
async function runCase(key: string, want: boolean[], run: (sid: string) => Promise<OpResult[]>) {
  const sid = `golden-${key.replace(/[^\w-]/g, '-')}`;
  let steps = await run(sid);
  if (steps.some((s) => !s.ok && s.error.code === 'limit')) {
    console.log(`${key}：limit で断られたので、60秒待ってやり直します`);
    await sleep(60_000);
    steps = await run(sid);
  }
  steps.forEach((s, i) => {
    if (s.ok) return;
    if (s.error.code === 'limit') failures.push(`${key} ${i + 1}番目 ${s.op}：limit（${s.error.message}）`);
    else if (want[i]) failures.push(`${key} ${i + 1}番目 ${s.op}：前は成功、今は失敗（${s.error.code} ${s.error.message}）`);
  });
  if (steps.length !== want.length) failures.push(`${key}：操作の数が違う（${steps.length} ≠ ${want.length}）`);
  results[key] = steps;
  console.log(`${steps.every((s, i) => s.ok || !want[i]) ? 'ok  ' : 'NG  '}${key} ${steps.map((s) => s.op + (s.ok ? '' : '✗')).join('→')}`);
}

/** 新しいセッションに画面の状態を入れ、操作を順に呼ぶ（/api/context のあと /api/chat で Claude が呼んだのと同じ順） */
async function replay(sid: string, ctx: { view?: Session['view']; here?: Session['here'] | null; clicks?: LngLat[] },
  ops: { op: string; input: unknown; source: 'direct' | 'ai' }[]): Promise<OpResult[]> {
  const s = getSession(sid, true);
  s.view = structuredClone(ctx.view ?? DEFAULT_VIEW);
  if (ctx.here) s.here = structuredClone(ctx.here);
  s.clicks = structuredClone(ctx.clicks ?? []);
  const steps: OpResult[] = [];
  for (const o of ops) steps.push(await runOp(o.op, { session: s, source: o.source }, structuredClone(o.input)));
  return steps;
}

// ===== 1. 保存したレシピ（全部。runRecipe がセッションを作り直す） =====
// 成功は求めない：レシピの再実行のあとに保存したレシピは現在地を持たず、here: の操作が毎回失敗する（例 FLPoy7HHpE）。違いは diff で見る
if (!existsSync(RECIPES)) { console.error(`レシピのフォルダがありません：${RECIPES}（--recipes で指定）`); process.exit(1); }
for (const f of readdirSync(RECIPES).filter((f) => f.endsWith('.json')).sort()) {
  const recipe = JSON.parse(readFileSync(join(RECIPES, f), 'utf8')) as Recipe;
  await runCase(`recipe:${basename(f, '.json')}`, recipe.steps.map(() => false), (sid) => runRecipe(sid, recipe));
}

// ===== 2. 評価の第3回の50問：準備の操作のあと、第3回で Claude が呼んだ操作を同じ順に =====
interface Case { id: string; setup?: { view?: Session['view']; here?: Session['here'] | null; clicks?: LngLat[]; ops?: { op: string; input: unknown }[] } }
const set = new Map(readFileSync(EVAL_SET, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { const c = JSON.parse(l) as Case; return [c.id, c]; }));
const run3 = JSON.parse(readFileSync(EVAL_RUN, 'utf8')) as { rows: { id: string; steps: { op: string; ok: boolean; input: unknown }[] }[] };
for (const row of run3.rows) {
  const c = set.get(row.id);
  if (!c) { failures.push(`eval:${row.id}：評価セットにない`); continue; }
  const setupOps = (c.setup?.ops ?? []).map((o) => ({ ...o, source: 'direct' as const }));
  const want = [...setupOps.map(() => true), ...row.steps.map((s) => s.ok)];
  await runCase(`eval:${row.id}`, want, (sid) => replay(sid, c.setup ?? {}, [...setupOps, ...row.steps.map((s) => ({ op: s.op, input: s.input, source: 'ai' as const }))]));
}

// ===== 3. デモの場面（docs/plan.md §7。入力は 11/6 の通しで Claude が呼んだもの） =====
const ai = (op: string, input: unknown) => ({ op, input, source: 'ai' as const });
const EX1 = [
  ai('geocode_address', { address: '東京都港区芝公園4-2-8' }),
  ai('route', { from: 'here:', to: 'abr:1', stops: [{ ref: null, word: 'post_office' }, { ref: null, word: 'souvenir' }], keep_order: true, avoid_highways: false }),
  ai('make_share_link', {}),
];
await runCase('demo:ex1', EX1.map(() => true), (sid) => replay(sid, { here: HERE }, EX1));
const COURSE = { tunnels: 2, max_minutes: 60, avoid_highways: true };
const EX2 = [
  ai('search_place', { name: '品川駅', area: 'here:' }),
  ai('plan_course', { start: 'result:1', ...COURSE }),
  ai('check_route', COURSE),
];
await runCase('demo:ex2', EX2.map(() => true), (sid) => replay(sid, { here: HERE }, EX2));

// ===== 書き出し：キーを並べ替え、回すたびに変わる値（共有リンクの ID、書き出しの時刻）を置き換える =====
const shareIds = Object.values(results).flat().flatMap((s) => (s.ok && s.op === 'make_share_link' ? [(s.output as { id: string }).id] : []));
const scrub = (t: string) => shareIds.reduce((x, id) => x.replaceAll(id, '<id>'), t)
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>') // GPX の <time>（データ時点はミリ秒がないので残る）
  .replace(/(kotozute-route-)\d{12}/g, '$1<time>');
const norm = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(norm)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
  : typeof v === 'string' ? scrub(v) : v;
const record = (s: OpResult) => s.ok
  ? { op: s.op, input: s.input, ok: true, output: s.output, llm: findOp(s.op)!.llm(s.output) }
  : { op: s.op, input: s.input, ok: false, error: s.error };

const coverage: Record<string, { ok: number; fail: number }> = {};
for (const s of Object.values(results).flat()) {
  coverage[s.op] ??= { ok: 0, fail: 0 };
  coverage[s.op][s.ok ? 'ok' : 'fail']++;
}
const cases = Object.fromEntries(Object.entries(results).map(([k, steps]) => [k, steps.map(record)]));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(norm(JSON.parse(JSON.stringify({ coverage, cases }))), null, 1) + '\n');
rmSync(process.env.OPLOG_FILE, { force: true });

// ===== 終わりの報告 =====
console.log('\n操作ごとの成功／失敗：');
for (const op of Object.keys(coverage).sort()) console.log(`  ${op} ${coverage[op].ok}／${coverage[op].fail}`);
const r1 = results['demo:ex1']?.[1];
if (r1?.ok) {
  const o = r1.output as { total: { minutes: number; km: number }; stops: { chosen: { name: string | null } }[]; tried: number };
  console.log(`例1：${o.total.minutes}分・${o.total.km}km、寄り先 ${o.stops.map((s) => s.chosen.name).join(' → ')}、試した組み合わせ ${o.tried}`);
}
// 例2 は2つ：評価 c07（品川駅を画面の範囲で探す）と、撮影の現在地から探す場面（出発の点が違うことがある）
for (const k of ['eval:c07', 'demo:ex2']) {
  const r = results[k]?.find((s) => s.op === 'plan_course');
  if (!r?.ok) continue;
  const o = r.output as { start: { name: string | null; osm?: string }; attempts: { via: { name: string | null }[]; minutes: number; check: { verdict: string } }[] };
  console.log(`例2（${k}、出発 ${o.start.name} ${o.start.osm}）：${o.attempts.map((a, i) => `${i + 1}回目 ${a.via.map((v) => v.name).join('＋')} ${a.minutes}分 ${a.check.verdict}`).join(' → ')}`);
}
console.log(`${Object.keys(results).length}件 → ${OUT}`);
if (failures.length) {
  console.log(`\n失敗 ${failures.length}件：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('golden: ok');
process.exit(0);
