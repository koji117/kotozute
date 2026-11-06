// セットアップの印（済んだ手順）、ロック（2つ同時に回さない）、記録（data/setup/logs/）。
import { appendFileSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Log } from './tools';

/** 記録とコンソールに出す前に、KEY・TOKEN・SECRET・PASSWORD を含む名前の値を伏せる */
export const mask = (s: string) =>
  s.replace(/(\b[\w.-]*(?:KEY|TOKEN|SECRET|PASSWORD)[\w.-]*"?\s*[=:]\s*"?)[^\s"',]+/gi, '$1***');

/** 記録のファイル（data/setup/logs/setup-<時刻>.log）とコンソールの両方に書く。tail は失敗したときに最後の行を出すため */
export function openLog(dir: string): { log: Log; file: string; tail: (n: number) => string[] } {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `setup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`);
  const last: string[] = [];
  const log: Log = (msg) => {
    const m = mask(msg);
    console.log(m);
    appendFileSync(file, `${new Date().toISOString()} ${m}\n`);
    last.push(...m.split('\n'));
    if (last.length > 200) last.splice(0, last.length - 200);
  };
  return { log, file, tail: (n) => last.slice(-n) };
}

/** 同じフォルダでセットアップを2つ同時に回さない。前の回が落ちて残ったロックは、その pid が生きていなければ取り直す */
export function lock(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      const release = () => rmSync(file, { force: true });
      process.once('exit', release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(file, 'utf8'));
      if (pid && alive(pid)) throw new Error(`別のセットアップが動いています（pid ${pid}）。終わるのを待つか、止めてからもう一度回してください`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`ロック（${file}）を取れません`);
}
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * 手順の印：data/setup/state/<手順>.json に、そのときの入力と結果を残す。
 * 入力が同じで、できるはずのファイルが全部あれば、その手順は済み（飛ばす）。入力が違えば、やり直す。
 */
export interface Mark { inputs: unknown; result: Record<string, unknown>; at: string }
export class Marks {
  constructor(private dir: string) {}
  private file = (step: string) => join(this.dir, `${step}.json`);
  get(step: string): Mark | null {
    try { return JSON.parse(readFileSync(this.file(step), 'utf8')); } catch { return null; }
  }
  done(step: string, inputs: unknown, outputs: string[] = []): boolean {
    const m = this.get(step);
    return !!m && inputs !== null && JSON.stringify(m.inputs) === JSON.stringify(inputs) && outputs.every((f) => existsSync(f));
  }
  set(step: string, inputs: unknown, result: Record<string, unknown> = {}): void {
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.file(step), JSON.stringify({ inputs, result, at: new Date().toISOString() } satisfies Mark, null, 1) + '\n');
  }
  clear(step: string): void {
    rmSync(this.file(step), { force: true });
  }
}

/** 書きかけのファイルを残さない：.tmp に書いてから rename */
export function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

/** 2つのパスが同じファイルか（シンボリックリンクをたどって比べる）。どちらかがなければ false */
export function sameFile(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** .env がなければ .env.example から作る（キーは空）。あれば何もしない（中身は読まない・表示しない）。作ったら true */
export function ensureEnv(root: string): boolean {
  const env = join(root, '.env'), example = join(root, '.env.example');
  if (existsSync(env) || !existsSync(example)) return false;
  copyFileSync(example, env, constants.COPYFILE_EXCL); // 同時に作られても上書きしない
  return true;
}
