// セットアップの道具：ログの書き方と、osmium の呼び方（手元に入っているものか、コンテナの中のもの）。
import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

export type Log = (msg: string) => void;
/** osmium を引数つきで起こす。stdout と stderr は pipe（読むのは呼ぶ側） */
export type Osmium = (args: string[]) => ChildProcess;

/** 手元に osmium がないときに使うイメージ（今の Overpass と同じ wiktorn/overpass-api。中の osmium は 1.15.0） */
export const OSMIUM_IMAGE = 'wiktorn/overpass-api@sha256:9bb5f4a9b54cd225bf828c04c67e7f4010650ff4d70b72157a9473a9ba02d93c';

/**
 * host：手元の osmium を dataDir で起こす。
 * container：dataDir を /data に載せたコンテナで起こす。引数の中の絶対パスは dataDir からの相対に直す
 * （dataDir の外のパスはコンテナから見えないので止める）。
 */
export function osmiumFor(mode: 'host' | 'container', dataDir: string): Osmium {
  const dir = resolve(dataDir);
  if (mode === 'host') return (args) => spawn('osmium', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const inData = (a: string) => {
    if (!isAbsolute(a)) return a;
    const r = relative(dir, a);
    if (r.startsWith('..') || isAbsolute(r)) throw new Error(`コンテナの osmium からは ${dataDir} の外のファイルを読めません：${a}`);
    return r.split(sep).join(posix.sep) || '.';
  };
  // Linux ではコンテナが root で書くと、あとで消せなくなる。自分の uid で動かす
  const user = process.platform === 'linux' ? ['--user', `${process.getuid!()}:${process.getgid!()}`] : [];
  return (args) => {
    const a = args.map(inData);
    return spawn('docker', ['run', '--rm', ...user, '-v', `${dir}:/data`, '-w', '/data', '--entrypoint', 'osmium', OSMIUM_IMAGE, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
}
