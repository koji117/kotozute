#!/usr/bin/env node
// npm start：セットアップで作ったもの（data/region.json）で、住所の道具（abrg）とアプリのサーバを起こす。Docker は使わない。
//   abrg：127.0.0.1 の空いたポートで待ち受ける。サーバには ABR_URL で渡す
//   サーバ：ルートは組み込みの Valhalla（VALHALLA_MODE=embedded）、検索は data/region.json の osm_backend
// サーバが終わったら abrg も止める。ポートは PORT（既定 8787）。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const file = resolve(ROOT, 'data/region.json');
if (!existsSync(file)) {
  console.error('地域の設定（data/region.json）がありません。先に「npm run setup -- --region=tokyo」を回してください');
  process.exit(1);
}
const region = JSON.parse(readFileSync(file, 'utf8'));
const abs = (p) => resolve(ROOT, p);

const children = [];
const stopAll = (code) => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  process.exitCode = code;
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0));

const env = { ...process.env };
if (region.abrg_bin && region.abr_cache) {
  register(); // abrg の起こし方は Task 4b の部品（TypeScript）を使う
  const { abr } = await import('./setup/external.ts');
  const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const a = await abr().then((m) => m.abrgServe({ bin: abs(region.abrg_bin), cache: abs(region.abr_cache), port }), (e) => { console.error(e.message); process.exit(1); });
  const p = spawn(a.cmd, a.args, { env: a.env, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(p);
  p.on('error', (e) => { console.error(`住所の道具（abrg）を起動できません：${e.message}`); stopAll(1); });
  p.on('exit', (code) => { if (code !== null && code !== 0) { console.error(`住所の道具（abrg）が止まりました（終了コード ${code}）`); stopAll(1); } });
  env.ABR_URL = `http://127.0.0.1:${port}`;
} else console.warn('住所のデータ（abr_cache、abrg_bin）が地域の設定にないので、住所の検索は使えません');

if (region.valhalla_config) Object.assign(env, { VALHALLA_MODE: 'embedded', VALHALLA_CONFIG: abs(region.valhalla_config) });
if (region.osm_backend && !env.OSM_BACKEND) env.OSM_BACKEND = region.osm_backend;

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/server/main.ts'], { cwd: ROOT, env, stdio: 'inherit' });
children.push(server);
server.on('exit', (code) => stopAll(code ?? 0));
