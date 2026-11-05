#!/usr/bin/env node
// Stop hook：型チェックが通るまで作業を終わらせない。
// ponytail: 簡易評価（eval）はまだないので型チェックだけ。評価セットができたらここに足す。
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
if (input.stop_hook_active) process.exit(0); // 2回続けて止めない（無限ループ防止）
try {
  // 会話の作業ディレクトリは変わるので、プロジェクトの直下で実行する
  execSync('npm run -s typecheck', { cwd: process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd(), stdio: 'pipe' });
} catch (e) {
  process.stderr.write('型チェックが通っていません。直してから終えてください。\n' + String(e.stdout ?? '').slice(-2000));
  process.exit(2);
}
