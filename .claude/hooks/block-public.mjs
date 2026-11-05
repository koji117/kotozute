#!/usr/bin/env node
// PreToolUse hook：実行時に使ってはいけない公開サービスのホスト名を含む書き込み・取得を止める。
// 判定はホスト名で行う。止めた記録は logs/hook-blocks.jsonl に1行ずつ追記する（動画で使う）。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

const BLOCKED = [
  ['google.com', 'Google の公開サービス'],
  ['googleapis.com', 'Google の公開API（地図・フォント）'],
  ['gstatic.com', 'Google の公開CDN（フォント）'],
  ['tile.openstreetmap.org', 'OSM の公開タイル（タイル利用方針で業務利用は不可）'],
  ['nominatim.openstreetmap.org', 'OSM の公開ジオコーダー（自前の abr-geocoder を使う）'],
  ['overpass-api.de', '公開 Overpass（自前の Overpass を使う）'],
  ['router.project-osrm.org', '公開ルーター（自前の Valhalla を使う）'],
  ['protomaps.github.io', 'Protomaps の公開アセット（自前で配信する）'],
  ['unpkg.com', '公開CDN（npm でバンドルする）'],
  ['cdn.jsdelivr.net', '公開CDN（npm でバンドルする）'],
  ['cdnjs.cloudflare.com', '公開CDN（npm でバンドルする）'],
];
// 対象外：絵コンテ（docs/storyboard/）と、この hook 自身（止める一覧を持つため）
const EXEMPT = ['docs/storyboard/', '.claude/hooks/'];

export function findBlocked(text) {
  const hosts = text.toLowerCase().match(/(?:[a-z0-9-]+\.)+[a-z]{2,}/g) ?? [];
  for (const h of hosts) {
    const hit = BLOCKED.find(([b]) => h === b || h.endsWith('.' + b));
    if (hit) return { host: h, reason: hit[1] };
  }
  return null;
}

// 記録に残すパス：プロジェクトの外のファイルは名前だけにする（ユーザー名や作業用の場所を公開の記録に残さない）
export function logPath(cwd, filePath) {
  const rel = relative(cwd, filePath);
  return rel.startsWith('..') || isAbsolute(rel) ? `(outside)/${basename(filePath)}` : rel;
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const { tool_name: tool, tool_input: ti = {} } = input;
  // 会話の作業ディレクトリは変わるので、基準はプロジェクトの直下にする
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const file = ti.file_path ? logPath(cwd, ti.file_path) : undefined;
  if (file && EXEMPT.some(p => file.startsWith(p))) return;
  const text = [ti.content, ti.new_string, ti.command, ti.url].filter(Boolean).join('\n');
  const hit = findBlocked(text);
  if (!hit) return;
  const log = join(cwd, 'logs', 'hook-blocks.jsonl');
  mkdirSync(join(cwd, 'logs'), { recursive: true });
  appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), tool, file, host: hit.host, reason: hit.reason }) + '\n');
  process.stderr.write(`止めました：${hit.host} は${hit.reason}。ことづては実行時に公開サービスを呼ばない決まりです（CLAUDE.md「実行時に絶対に守るルール」）。\n`);
  process.exit(2);
}

if (process.argv[2] === '--test') {
  const ok = (t, want) => { if (!!findBlocked(t) !== want) { console.error('FAIL', t); process.exit(1); } };
  ok('https://a.tile.openstreetmap.org/{z}/{x}/{y}.png', true);
  ok('fetch("https://maps.googleapis.com/maps/api")', true);
  ok('<link href="https://fonts.googleapis.com/css2">', true);
  ok('https://unpkg.com/maplibre-gl', true);
  ok('https://www.openstreetmap.org/copyright', false);
  ok('https://www.openstreetmap.org/note/new#map=18/35.6/139.7', false);
  ok('curl -LO https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf', false);
  ok('pmtiles extract https://build.protomaps.com/20261104.pmtiles', false);
  ok('git clone https://github.com/digital-go-jp/abr-geocoder.git', false);
  ok('notgoogle.com.example', false);
  if (logPath('/p/proj', '/tmp/x-user/scratch/a.html') !== '(outside)/a.html' || logPath('/p/proj', '/p/proj/src/a.ts') !== 'src/a.ts') { console.error('FAIL logPath'); process.exit(1); }
  console.log('block-public: all tests passed');
} else {
  main();
}
