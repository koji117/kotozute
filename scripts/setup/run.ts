// セットアップの手順が使う小さな道具：記録の関数と、子のプロセスの回し方。
// 統合のときに scripts/setup/tools.ts（Task 3）の Log とまとめる。
import { spawn } from 'node:child_process';

export type Log = (msg: string) => void;

/**
 * 子のプロセスを回し、出力を1行ずつ log へ流す（out を渡せば標準出力はそちらへ集める）。
 * 0 以外で終われば「<name> が失敗しました」。コマンドがなければ missing の文（なければ「<cmd> が見つかりません」）
 */
export function run(name: string, cmd: string, args: string[], o: { log: Log; env?: NodeJS.ProcessEnv; cwd?: string; out?: string[]; missing?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: o.env, cwd: o.cwd });
    const lines = (b: Buffer) => String(b).split('\n').filter(Boolean).forEach((l) => o.log(l));
    p.stdout.on('data', (b: Buffer) => (o.out ? o.out.push(String(b)) : lines(b)));
    p.stderr.on('data', lines);
    p.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new Error(o.missing ?? `${cmd} が見つかりません`) : e));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} が失敗しました（終了コード ${code}）`))));
  });
}
