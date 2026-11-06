// Claude に渡る文（システムプロンプト、ツールの定義、画面の状態の文）を1つの文字列にする。
// 東京の文が1バイトも変わっていないことを check-quick で確かめるため（評価は3回を使い切り、回し直せない）。
// 実行：npx tsx scripts/claude-text.ts > scripts/fixtures/claude-text-tokyo.txt（作業の前に1回だけ）
import { pathToFileURL } from 'node:url';
import { contextBlock, SYSTEM } from '../src/server/claude';
import { toolDefs } from '../src/ops/registry';
import type { Session } from '../src/ops/types';

const session = (view?: Session['view']): Session => ({
  id: 'claude-text', clicks: [], places: new Map(), nextResult: 1, nextAbr: 1, layers: {}, pins: [], history: [], ...(view ? { view } : {}),
});

export function renderClaudeText(): string {
  return [
    '===== SYSTEM', SYSTEM,
    '===== TOOLS', JSON.stringify(toolDefs(), null, 1),
    '===== CONTEXT（画面の範囲なし）', contextBlock(session()),
    '===== CONTEXT（画面の範囲あり）', contextBlock(session({ bbox: [139.715, 35.645, 139.789, 35.691], zoom: 13.5 })),
    '',
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.stdout.write(renderClaudeText());
