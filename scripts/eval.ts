// 評価：eval/set.jsonl の依頼を本物の Claude に渡し、選んだ操作と結果を採点する。採点の決まりは eval/README.md。
// 実行：npx tsx scripts/eval.ts [--only a01,b03] [--group a] [--label メモ] [--set 別の問題ファイル]
// 自社の Overpass・Valhalla・ABR と .env の ANTHROPIC_API_KEY が要る。結果は eval/runs/<日時>.json。
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== Claude API の使用量を数える（応答の usage を読むだけ。中身は変えない） =====
const usage = { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await realFetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url).hostname === 'api.anthropic.com') {
    res.clone().json().then((j: any) => {
      if (!j?.usage) return;
      usage.calls++;
      usage.input += j.usage.input_tokens ?? 0;
      usage.output += j.usage.output_tokens ?? 0;
      usage.cache_read += j.usage.cache_read_input_tokens ?? 0;
      usage.cache_write += j.usage.cache_creation_input_tokens ?? 0;
    }).catch(() => {});
  }
  return res;
}) as typeof fetch;
// claude-sonnet-5-5 の料金（ドル / 100万トークン）。cache_write は5分のキャッシュ
const PRICE = { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 };
const dollars = (u: typeof usage) => (u.input * PRICE.input + u.output * PRICE.output + u.cache_read * PRICE.cache_read + u.cache_write * PRICE.cache_write) / 1e6;

process.env.OPLOG_FILE = join(tmpdir(), `kotozute-eval-ops-${process.pid}.jsonl`);
const { app } = await import('../src/server/main.ts');
const { runOp } = await import('../src/ops/registry.ts');
const { getSession } = await import('../src/server/session.ts');
const { DICT } = await import('../src/ops/dict.ts');
const { distM } = await import('../src/services/region.ts');
type Session = import('../src/ops/types.ts').Session;

type LngLat = [number, number];
interface Near { near: LngLat; within_m: number }
interface Case {
  id: string; group: string; text: string; note: string;
  setup?: { view?: { bbox: number[]; zoom: number }; here?: { coord: LngLat; accuracy_m: number } | null; clicks?: LngLat[]; ops?: { op: string; input: unknown }[] };
  expect: Record<string, any>;
}
interface Step { op: string; ok: boolean; input: any; output?: any; error?: { code: string; message: string } }

const DEFAULT_VIEW = { bbox: [139.715, 35.645, 139.789, 35.691], zoom: 13.5 };
const COORD_RE = /\d{2,3}\.\d{3,}/;
const MOVES = ['set_view', 'route', 'plan_course'];

// ===== 引数 =====
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const only = arg('--only')?.split(',');
const group = arg('--group');
const label = arg('--label') ?? '';

const all: Case[] = readFileSync(arg('--set') ?? 'eval/set.jsonl', 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const cases = all.filter((c) => (!only || only.includes(c.id)) && (!group || c.group === group));
if (!cases.length) throw new Error('対象の問題がありません');

// ===== 採点 =====
const kindOf = (ref: string) => (ref === 'view:' || ref === 'here:' ? ref : ref.split(':')[0]);
const near = (c: LngLat | undefined, n: Near) => !!c && distM(c, n.near) <= n.within_m;
const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

function grade(c: Case, steps: Step[], session: Session): string[] {
  const e = c.expect;
  const okSteps = steps.filter((s) => s.ok);
  const last = (op: string) => okSteps.filter((s) => s.op === op).at(-1);
  const fail: string[] = [];
  const need = (cond: boolean, why: string) => { if (!cond) fail.push(why); };

  if (e.calls) {
    let i = 0;
    for (const s of okSteps) if (s.op === e.calls[i]) i++;
    need(i === e.calls.length, `calls: ${e.calls.join('→')} が順に成功していない`);
  }
  for (const op of e.not_calls ?? []) need(!last(op), `not_calls: ${op} が成功した`);
  if (e.geocode) {
    const s = last('geocode_address');
    need(near(s?.output?.place?.coord, e.geocode), `geocode: ${e.geocode.within_m}m 以内にない（${s ? Math.round(distM(s.output.place.coord, e.geocode.near)) + 'm' : 'なし'}）`);
  }
  if (e.search) {
    const items = last('search_place')?.output?.items?.slice(0, 5) ?? [];
    need(items.some((p: any) => (e.search.osm && p.osm === e.search.osm) || (e.search.near && near(p.coord, e.search))), 'search: 先頭5件に正解がない');
  }
  if (e.features) {
    // 言葉ごとに分けて呼んでもよい。言葉は成功した呼び出しすべての和で比べ、範囲と半径はどの呼び出しでも合っていること
    const fs = okSteps.filter((s) => s.op === 'find_features');
    const words = [...new Set(fs.flatMap((s) => s.input.words as string[]))];
    need(fs.length > 0 && sameSet(words, e.features.words), `features.words: ${JSON.stringify(words)} ≠ ${JSON.stringify(e.features.words)}`);
    if (e.features.area) need(fs.length > 0 && fs.every((s) => kindOf(s.input.area) === e.features.area), `features.area: ${fs.map((s) => s.input.area)} ≠ ${e.features.area}`);
    if (e.features.radius_m != null) need(fs.length > 0 && fs.every((s) => s.input.radius_m === e.features.radius_m), `features.radius_m: ${fs.map((s) => s.input.radius_m)} ≠ ${e.features.radius_m}`);
  }
  if (e.route) {
    const s = last('route');
    const end = (want: any, got: any, inp: string, k: string) => need(!!s && (want === 'here:' ? inp === 'here:' : near(got?.coord, want)), `route.${k}: 違う場所`);
    if (!s) fail.push('route: 成功していない');
    else {
      if (e.route.from) end(e.route.from, s.output.from, s.input.from, 'from');
      if (e.route.to) end(e.route.to, s.output.to, s.input.to, 'to');
      const kinds: string[] = s.output.stops.map((x: any) => x.chosen.kind);
      if (e.route.stops) need(JSON.stringify(kinds) === JSON.stringify(e.route.stops), `route.stops: ${kinds} ≠ ${e.route.stops}`);
      if (e.route.stops_any_order) need(JSON.stringify([...kinds].sort()) === JSON.stringify([...e.route.stops_any_order].sort()), `route.stops_any_order: ${kinds} ≠ ${e.route.stops_any_order}`);
      for (const k of ['avoid_highways', 'keep_order']) if (e.route[k] != null) need(s.input[k] === e.route[k], `route.${k}: ${s.input[k]} ≠ ${e.route[k]}`);
    }
  }
  for (const [k, op] of [['course', 'plan_course'], ['check', 'check_route']] as const) {
    if (!e[k]) continue;
    const s = last(op);
    if (!s) { fail.push(`${k}: ${op} が成功していない`); continue; }
    for (const f of ['tunnels', 'max_minutes', 'avoid_highways']) if (f in e[k]) need(s.input[f] === e[k][f], `${k}.${f}: ${s.input[f]} ≠ ${e[k][f]}`);
    if (e[k].start) need(near(s.output?.start?.coord, e[k].start), `${k}.start: 違う場所`);
  }
  if (e.view) {
    // 移動と表示の切り替えを別の呼び出しに分けてもよい。表示は依頼のあとの地図の状態で、場所は最後に動かした set_view で見る
    const views = okSteps.filter((s) => s.op === 'set_view');
    const moved = views.filter((s) => s.output.target !== null).at(-1);
    if (!views.length) fail.push('view: set_view が成功していない');
    else {
      for (const w of e.view.show ?? []) need((session.layers as Record<string, { visible: boolean } | undefined>)[w]?.visible === true, `view.show: ${w} が表示されていない`);
      for (const w of e.view.hide ?? []) need((session.layers as Record<string, { visible: boolean } | undefined>)[w]?.visible === false, `view.hide: ${w} が隠れていない`);
      if (e.view.target === null) need(!moved, 'view.target: 動かさないはずが動いた');
      else if (e.view.target) need(near(moved?.output.target?.coord, e.view.target), 'view.target: 違う場所');
    }
  }
  if (e.share) need(!!last('make_share_link'), 'share: make_share_link が成功していない');
  if (e.pins != null) need(okSteps.filter((s) => s.op === 'add_pin').length === e.pins, `pins: ${okSteps.filter((s) => s.op === 'add_pin').length} ≠ ${e.pins}`);
  if (e.export) {
    const ok = e.export === 'png' ? !!last('export_png') : last('export_route')?.input.format === e.export;
    need(ok, `export: ${e.export} が成功していない`);
  }
  if (e.note_draft) need(last('draft_osm_note')?.input.issue === e.note_draft.issue, `note_draft: issue ≠ ${e.note_draft.issue}`);
  if (e.outcome) need(outcome(e.outcome, c.text, steps), `outcome: ${JSON.stringify(e.outcome)} にならない`);
  return fail;
}

function outcome(o: any, text: string, steps: Step[]): boolean {
  const zeroSearch = (s: Step) => s.ok && (s.op === 'search_place' && s.output?.total === 0);
  const firstMiss = (codes: string[]) => steps.findIndex((s) => (!s.ok && codes.includes(s.error!.code)) || zeroSearch(s));
  const movedAfter = (i: number) => steps.slice(i + 1).some((s) => s.ok && MOVES.includes(s.op));
  if (o === 'out_of_area' || o === 'not_found') {
    const i = firstMiss(o === 'out_of_area' ? ['out_of_area', 'not_found'] : ['not_found']);
    return i >= 0 && !movedAfter(i);
  }
  if (o === 'no_coords') return !steps.some((s) => s.ok && COORD_RE.test(JSON.stringify(s.input)));
  if (o === 'zero') return steps.some((s) => s.ok && s.op === 'find_features' && s.output.groups.some((g: any) => g.count === 0));
  if (o?.unknown_words) {
    const got: string[] = steps.filter((s) => s.ok && s.op === 'unknown_words').flatMap((s) => s.output.words);
    // 依頼文に出てこない辞書の言葉で探したら、言い換えとみなす
    const swapped = steps.some((s) => s.ok && s.op === 'find_features' && s.input.words.some((w: keyof typeof DICT) => ![DICT[w].label, ...DICT[w].aliases].some((a) => text.includes(a))));
    return o.unknown_words.every((w: string) => got.includes(w)) && !swapped;
  }
  return false;
}

function fabrications(text: string, steps: Step[]): number {
  let n = 0;
  for (const s of steps) {
    if (!s.ok) continue;
    if (COORD_RE.test(JSON.stringify(s.input))) n++;
    if (s.op === 'unknown_words') n += s.output.words.filter((w: string) => !text.includes(w)).length;
  }
  return n;
}

// ===== 実行 =====
const post = async (path: string, body: unknown) => {
  const res = await app.request(path, { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};

const started = new Date();
const rows: any[] = [];
for (const c of cases) {
  const sid = `eval-${c.id}-${started.getTime()}`;
  const view = c.setup?.view ?? DEFAULT_VIEW;
  const u0 = { ...usage };
  const t0 = Date.now();
  let steps: Step[] = [], stop = 'error', error: string | undefined, setupError: string | undefined;
  try {
    await post('/api/context', { sessionId: sid, view, here: c.setup?.here ?? null });
    for (const click of c.setup?.clicks ?? []) await post('/api/context', { sessionId: sid, click });
    for (const s of c.setup?.ops ?? []) {
      const r = await runOp(s.op, { session: getSession(sid), source: 'direct' }, s.input);
      if (!r.ok) { setupError = `${s.op}: ${r.error.code} ${r.error.message}`; break; }
    }
    if (!setupError) {
      const r = await post('/api/chat', { sessionId: sid, text: c.text, view: getSession(sid).view ?? view });
      if (r.status !== 200) error = `HTTP ${r.status} ${JSON.stringify(r.json)}`;
      steps = r.json.steps ?? [];
      stop = r.json.stop ?? 'error';
      error ??= r.json.error;
    }
  } catch (e) {
    error = String(e);
  }
  await new Promise((r) => setTimeout(r, 300)); // usage の読み取りを待つ
  const failures = setupError ? [`setup: ${setupError}`] : grade(c, steps, getSession(sid));
  if (error && !failures.length && !c.expect.outcome) failures.push(`error: ${error}`);
  const row = {
    id: c.id, group: c.group, text: c.text, pass: failures.length === 0, failures, stop, error,
    ms: Date.now() - t0,
    claude_calls: usage.calls - u0.calls,
    fabrications: fabrications(c.text, steps),
    steps: steps.map((s) => ({ op: s.op, ok: s.ok, input: s.input, ...(s.ok ? {} : { error: s.error }) })),
  };
  rows.push(row);
  console.log(`${row.pass ? 'ok  ' : 'NG  '}${c.id} ${(row.ms / 1000).toFixed(1)}s ${steps.map((s) => s.op + (s.ok ? '' : '✗')).join('→') || '（操作なし）'}${failures.length ? '\n      ' + failures.join('\n      ') : ''}`);
}

// ===== 集計 =====
const by = (g: string) => rows.filter((r) => r.group === g);
const groups = [...new Set(rows.map((r) => r.group))];
const summary = {
  total: rows.length,
  passed: rows.filter((r) => r.pass).length,
  rate: Math.round((rows.filter((r) => r.pass).length / rows.length) * 1000) / 10,
  by_group: Object.fromEntries(groups.map((g) => [g, `${by(g).filter((r) => r.pass).length}/${by(g).length}`])),
  fabrications: rows.reduce((s, r) => s + r.fabrications, 0),
  claude_calls: usage.calls,
  usage,
  cost_usd: Math.round(dollars(usage) * 100) / 100,
  minutes: Math.round((Date.now() - started.getTime()) / 6000) / 10,
};
const out = {
  started_at: started.toISOString(), label, model: 'claude-sonnet-5-5', filter: { only, group },
  commit: (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return null; } })(),
  summary, rows,
};
mkdirSync('eval/runs', { recursive: true });
const file = `eval/runs/${started.toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`\n正答 ${summary.passed}/${summary.total}（${summary.rate}%） ${JSON.stringify(summary.by_group)} 捏造 ${summary.fabrications} 回`);
console.log(`Claude ${usage.calls} 回、約 $${summary.cost_usd}、${summary.minutes} 分 → ${file}`);
