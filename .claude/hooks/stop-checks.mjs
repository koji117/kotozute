#!/usr/bin/env node
// Stop hook：型チェックと速い検査（scripts/check-quick.ts）が通るまで作業を終わらせない。
// check-quick は評価セットの形、書き出しの出典表示、辞書の色を見る（ネットワークなし、1秒ほど）。
// ponytail: 本物の評価（scripts/eval.ts）は Claude API を約150回呼んでお金がかかるので、ここでは回さない
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
if (input.stop_hook_active) process.exit(0); // 2回続けて止めない（無限ループ防止）
// 会話の作業ディレクトリは変わるので、プロジェクトの直下で実行する
const cwd = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
for (const [cmd, what] of [['npm run -s typecheck', '型チェック'], ['npx tsx scripts/check-quick.ts', '速い検査（scripts/check-quick.ts）']]) {
  try {
    execSync(cmd, { cwd, stdio: 'pipe' });
  } catch (e) {
    process.stderr.write(`${what}が通っていません。直してから終えてください。\n` + (String(e.stdout ?? '') + String(e.stderr ?? '')).slice(-2000));
    process.exit(2);
  }
}
