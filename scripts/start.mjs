#!/usr/bin/env node
// npm start：セットアップで作ったもの（data/region.json）で、住所の道具（abrg）とアプリのサーバを起こす。Docker は使わない。
//   abrg：127.0.0.1 の空いたポートで待ち受ける。サーバには ABR_URL で渡す
//   サーバ：ルートは組み込みの Valhalla（VALHALLA_MODE=embedded）、検索は data/region.json の osm_backend
// サーバが終わったら abrg も止める。ポートは PORT（既定 8787）。地域の設定の読み方は Mac のアプリと同じ（src/launch.mjs）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrgServe, regionLaunch, waitHttp } from '../src/launch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(resolve(ROOT, 'data/region.json'))) {
  console.error('地域の設定（data/region.json）がありません。先に「npm run setup -- --region=tokyo」を回してください');
  process.exit(1);
}
const launch = regionLaunch(ROOT);

const children = [];
const stopAll = (code) => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  process.exitCode = code;
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0));

const env = { ...process.env, ...launch.env };
if (launch.abrg) {
  const port = await new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const a = abrgServe({ ...launch.abrg, port });
  const p = spawn(a.cmd, a.args, { env: a.env, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(p);
  p.on('error', (e) => { console.error(`住所の道具（abrg）を起動できません：${e.message}`); stopAll(1); });
  p.on('exit', (code) => { if (code !== null && code !== 0) { console.error(`住所の道具（abrg）が止まりました（終了コード ${code}）`); stopAll(1); } });
  env.ABR_URL = `http://127.0.0.1:${port}`;
  // 住所が答えるまで待ってからサーバを起こす（待たないと、セットアップの動作確認の住所が「接続できません」になった。2026-11-06）
  try {
    await waitHttp(`${env.ABR_URL}/health`, 30_000);
  } catch (e) {
    console.error(`住所の道具（abrg）が答えません：${e.message}`);
    stopAll(1);
    process.exit(1);
  }
} else if (!env.ABR_URL) console.warn('住所のデータ（abr_cache、abrg_bin）が地域の設定にないので、住所の検索は使えません');

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/server/main.ts'], { cwd: ROOT, env, stdio: 'inherit' });
children.push(server);
server.on('exit', (code) => stopAll(code ?? 0));
