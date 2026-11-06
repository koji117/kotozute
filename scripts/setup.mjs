#!/usr/bin/env node
// npm run setup -- --region=<地域>：セットアップの入口（設計書 §6）。
// Node の版を先に確かめ、tsx がなければ npm ci を回してから、scripts/setup/main.ts を回す。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(`Node ${process.versions.node} は古すぎます。Node 24 以上を入れてください（nvm なら「nvm install」で .nvmrc の版が入ります）`);
  process.exit(1);
}
const root = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(join(root, 'node_modules/tsx'))) {
  console.log('npm ci を回します（はじめの1回だけ）');
  const r = spawnSync('npm', ['ci'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(root, 'scripts/setup/main.ts'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
