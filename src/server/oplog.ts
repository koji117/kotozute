// 操作ログ：操作を1回呼ぶごとに1行の JSON を logs/ops.jsonl に足す（.gitignore 済み）。
// 現在地とクリックの座標は書かない。操作の入力は参照（here:、click:N など）だけなので、そのまま書いてよい。
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OpResult, Session } from '../ops/types';

// 確認用のスクリプトは別のファイルに書く（OPLOG_FILE）。Mac のアプリは KOTOZUTE_DATA_DIR の logs/ に書く
const FILE = process.env.OPLOG_FILE ?? join(process.env.KOTOZUTE_DATA_DIR ?? '.', 'logs/ops.jsonl');

export function logOp(session: Session, r: OpResult) {
  const line = {
    at: new Date().toISOString(),
    session: session.id.slice(0, 8),
    source: r.source,
    op: r.op,
    input: r.input,
    ok: r.ok,
    ...(r.ok ? { counts: counts(r.output) } : { error: r.error.code }),
  };
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    appendFileSync(FILE, JSON.stringify(line) + '\n');
  } catch (e) {
    console.error('[oplog]', e);
  }
}

/** 出力の配列は件数、数は値だけを残す（座標や名前は書かない） */
function counts(o: unknown): Record<string, number> {
  if (!o || typeof o !== 'object') return {};
  return Object.fromEntries(Object.entries(o).flatMap(([k, v]) =>
    Array.isArray(v) ? [[k, v.length]] : typeof v === 'number' ? [[k, v]] : []));
}
