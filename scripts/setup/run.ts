// セットアップの手順が使う小さな道具：記録の関数と、子のプロセスの回し方。
// 統合のときに scripts/setup/tools.ts（Task 3）の Log とまとめる。
import { spawn } from 'node:child_process';

export type Log = (msg: string) => void;

/** 子のプロセスに渡す環境。KEY・TOKEN・SECRET・PASSWORD を名前に含むもの（ANTHROPIC_API_KEY など）は渡さない */
export const childEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(k)));

/**
 * 子のプロセスを回し、出力を1行ずつ log へ流す（out を渡せば標準出力はそちらへ集める）。env の既定は childEnv()。
 * 0 以外で終われば（シグナルで落ちても）「<name> が失敗しました」。コマンドがなければ missing の文（なければ「<cmd> が見つかりません」）
 */
export function run(name: string, cmd: string, args: string[], o: { log: Log; env?: NodeJS.ProcessEnv; cwd?: string; out?: string[]; missing?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: o.env ?? childEnv(), cwd: o.cwd });
    const lines = (b: Buffer) => String(b).split('\n').filter(Boolean).forEach((l) => o.log(l));
    p.stdout.on('data', (b: Buffer) => (o.out ? o.out.push(String(b)) : lines(b)));
    p.stderr.on('data', lines);
    p.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new Error(o.missing ?? `${cmd} が見つかりません`) : e));
    p.on('close', (code, sig) => (code === 0 ? resolve() : reject(new Error(`${name} が失敗しました（${sig ? `シグナル ${sig}` : `終了コード ${code}`}）`))));
  });
}
