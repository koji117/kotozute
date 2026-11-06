// Stop hook 用の速い検査（ネットワークなし、10秒以内）。
//   1. 評価セット（eval/set.jsonl）の形が eval/README.md の決まりどおりか
//   2. 書き出し（画像、GPX、GeoJSON）をするファイルが、出典とデータ時点の定数（src/attribution.ts）を使っているか
//   3. 辞書の言葉ごとに印の色（src/web/panel.ts の COLOR）があるか
//   4. 踏切の点とトンネルの上下線のまとめ方（src/ops/find_features.ts の mergeCrossings、mergeTunnels）
//   5. Claude に渡る文が、記録した東京の文（scripts/fixtures/claude-text-tokyo.txt）と1バイトも違わないか
// 実行：npx tsx scripts/check-quick.ts。問題があれば一覧を出して終了コード 1。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { DICT, DICT_KEYS } from '../src/ops/dict';
import { mergeCrossings, mergeTunnels } from '../src/ops/find_features';
import type { OsmElement } from '../src/services/overpass';
import { COLOR } from '../src/web/panel';
import { renderClaudeText } from './claude-text';

const bad: string[] = [];
const isWord = (w: unknown) => typeof w === 'string' && Object.hasOwn(DICT, w);

// ===== 1. 評価セット =====
const SET = 'eval/set.jsonl';
const GROUPS: Record<string, number> = { a: 10, b: 10, c: 10, d: 10, trap: 10 };
const EXPECT_KEYS = new Set(['calls', 'not_calls', 'geocode', 'search', 'features', 'route', 'course', 'check', 'view', 'share', 'pins', 'export', 'note_draft', 'outcome']);
// eval/README.md「評価が前提にする操作」（まだない操作も含む）
const OP_NAMES = new Set(['search_place', 'geocode_address', 'find_features', 'route', 'plan_course', 'check_route', 'set_view', 'add_pin', 'make_share_link', 'export_png', 'export_route', 'draft_osm_note', 'unknown_words']);
const MAX_TEXT = 300; // src/server/main.ts の ChatReq と同じ

if (!existsSync(SET)) console.log(`${SET} がないので、評価セットの検査は飛ばします`);
else {
  const ids = new Set<string>();
  const n: Record<string, number> = {};
  readFileSync(SET, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const at = `${SET}:${i + 1}`;
    let c: any;
    try { c = JSON.parse(line); } catch { return bad.push(`${at} JSON として読めない`); }
    const need = (ok: unknown, why: string) => { if (!ok) bad.push(`${at}（${c.id}）${why}`); };
    need(typeof c.id === 'string' && !ids.has(c.id), 'id がないか、重なっている');
    ids.add(c.id);
    n[c.group] = (n[c.group] ?? 0) + 1;
    need(typeof c.text === 'string' && c.text.trim().length > 0 && c.text.trim().length <= MAX_TEXT, `text は1〜${MAX_TEXT}文字`);
    need(typeof c.note === 'string' && c.note.trim(), 'note（正解の根拠）がない');
    const e = c.expect ?? {};
    need(Object.keys(e).length > 0, 'expect が空（何もしなくても合格になる）');
    for (const k of Object.keys(e)) need(EXPECT_KEYS.has(k), `expect の知らないキー ${k}`);
    const ops = [...(e.calls ?? []), ...(e.not_calls ?? []), ...(c.setup?.ops ?? []).map((s: any) => s.op)];
    for (const op of ops) need(OP_NAMES.has(op), `知らない操作 ${op}`);
    // 辞書の言葉を消したり名前を変えたりすると、評価が採点できなくなる
    const words = [
      ...(e.features?.words ?? []), ...(e.route?.stops ?? []), ...(e.route?.stops_any_order ?? []), ...(e.view?.show ?? []), ...(e.view?.hide ?? []),
      ...(c.setup?.ops ?? []).flatMap((s: any) => [...(s.input?.words ?? []), ...(s.input?.stops ?? []).map((x: any) => x.word).filter((w: unknown) => w != null)]),
    ];
    for (const w of words) need(isWord(w), `辞書にない言葉 ${w}`);
  });
  for (const g of new Set([...Object.keys(GROUPS), ...Object.keys(n)])) {
    if (n[g] !== GROUPS[g]) bad.push(`${SET} group ${g} が ${n[g] ?? 0}問（決まりは ${GROUPS[g] ?? 0}問）`);
  }
}

// ===== 2. 書き出しの出典表示（CLAUDE.md：書き出しに出典表示がないと通さない） =====
// ponytail: ファイル単位で名前を探すだけ。本当に画像やファイルに書き込んでいるかまでは見ない
const EXPORTS = /toBlob\(|toDataURL\(|\.download\s*=|<gpx\b|\.(gpx|geojson)\b|gpx\+xml|geo\+json/;
const ATTR = /\b(ATTRIBUTION|attributionParts|attributionHtml)\b/;
const AS_OF = /\b(dataAsOfText|OSM_DATA_AS_OF)\b/;
for (const f of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
  if (!/\.(ts|mjs|js|html)$/.test(f) || f === 'attribution.ts') continue;
  const s = readFileSync(`src/${f}`, 'utf8');
  if (!EXPORTS.test(s)) continue;
  if (!ATTR.test(s)) bad.push(`src/${f} は書き出しをするのに、出典（src/attribution.ts の ATTRIBUTION か attributionParts）を使っていない`);
  if (!AS_OF.test(s)) bad.push(`src/${f} は書き出しをするのに、データ時点（dataAsOfText か OSM_DATA_AS_OF）を使っていない`);
}

// ===== 3. 辞書と印の色 =====
for (const k of DICT_KEYS) {
  if (!/^#[0-9A-Fa-f]{6}$/.test((COLOR as Record<string, string>)[k] ?? '')) bad.push(`辞書の言葉 ${k} に印の色（src/web/panel.ts の COLOR）がない`);
  if (!DICT[k].interpretation.trim()) bad.push(`辞書の言葉 ${k} に解釈（interpretation）がない`);
}

// ===== 4. 踏切のまとめ方 =====
// 北緯35.62度で経度 0.0001度 ≒ 9m。1・2 は同じ名前で18m、3・4 は名前なしで18m、5 は 4 から18m（名前なしとは合う）で 2 と同じ名前で90m なので、1〜5 が1か所になる。
// 6 は同じ名前でも900m離れているので別。7・8 は14mでも名前が違うので別。全部で4か所
{
  const node = (id: number, lon: number, name?: string): OsmElement => ({ type: 'node', id, lon, lat: 35.62, tags: { railway: 'level_crossing', ...(name ? { name } : {}) } });
  const got = mergeCrossings([node(1, 139.74, '北品川踏切'), node(2, 139.7402, '北品川踏切'), node(3, 139.7408), node(4, 139.741), node(5, 139.7412, '北品川踏切'),
    node(6, 139.75, '北品川踏切'), node(7, 139.76, '甲踏切'), node(8, 139.76015, '乙踏切')], 'level_crossing');
  const first = got.find((p) => p.osm === 'node/1');
  if (got.length !== 4 || first?.name !== '北品川踏切') bad.push(`踏切のまとめ方が違う：${got.length}か所（4か所のはず）、${JSON.stringify(got.map((p) => [p.osm, p.name]))}`);
}

// 同じ名前の長いトンネルの上下線（点を共有しない。30m 離れて平行、半分ずれている）は1本。名前の違うトンネルは近くても別
{
  let id = 0;
  const way = (name: string, lon0: number, lat: number): OsmElement => {
    const geometry = Array.from({ length: 21 }, (_, i) => ({ lon: lon0 + i * 0.001, lat }));
    return { type: 'way', id: ++id, nodes: geometry.map(() => ++id), geometry, tags: { highway: 'motorway', tunnel: 'yes', name } };
  };
  const got = mergeTunnels([way('山手トンネル', 139.74, 35.62), way('山手トンネル', 139.75, 35.62027), way('別トンネル', 139.74, 35.6205)]);
  if (got.length !== 2) bad.push(`トンネルのまとめ方が違う：${got.length}本（2本のはず）、${JSON.stringify(got.map((p) => p.name))}`);
}

// ===== 5. Claude に渡る文（東京では1バイトも変えない。評価は回し直せないため） =====
{
  const want = readFileSync('scripts/fixtures/claude-text-tokyo.txt', 'utf8'), got = renderClaudeText();
  if (got !== want) {
    const a = want.split('\n'), b = got.split('\n');
    const i = a.findIndex((l, k) => l !== b[k]);
    bad.push(`Claude に渡る文が記録と違います（${i + 1}行目）\n  記録：${a[i] ?? '（なし）'}\n  今　：${b[i] ?? '（なし）'}`);
  }
}

if (bad.length) {
  console.error(`check-quick：${bad.length}件\n- ${bad.join('\n- ')}`);
  process.exit(1);
}
console.log('check-quick: ok');
