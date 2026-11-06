// 途中で止まっても続きから取れるダウンロード（Range と If-Range）。md5 を確かめてから本当の名前にする。
// 書きかけは <dest>.part。確かめ終わったものだけが dest になるので、もう一度回しても壊れたファイルを使わない。
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Log } from './tools';

const MiB = (n: number) => `${(n / 2 ** 20).toFixed(0)} MiB`;

/** HEAD（転送をたどる）。latest のような URL は、日付つきの本当のファイル（url）に固定して使う */
export async function head(url: string): Promise<{ ok: boolean; status: number; url: string; bytes: number; etag: string | null }> {
  const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  return { ok: r.ok, status: r.status, url: r.url, bytes: Number(r.headers.get('content-length') ?? NaN), etag: r.headers.get('etag') };
}

const md5Of = async (file: string) => {
  const h = createHash('md5');
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest('hex');
};

/**
 * url を dest に取る。dest がもうあれば何もしない。md5（16進）か md5Url（Geofabrik の .md5 のように1語目が値）があれば確かめる。
 * 戻り値の url は転送をたどった先（日付つきのファイル名が分かる）
 */
export async function download(o: { url: string; dest: string; md5?: string; md5Url?: string | true; log: Log }): Promise<{ url: string; bytes: number }> {
  const { dest, log } = o;
  if (existsSync(dest)) return { url: o.url, bytes: statSync(dest).size };
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const h = await head(o.url);
  if (!h.ok) throw Object.assign(new Error(`ダウンロードできません（HTTP ${h.status}）：${o.url}`), { status: h.status });
  let have = existsSync(part) ? statSync(part).size : 0;
  if (Number.isFinite(h.bytes) && have > h.bytes) { rmSync(part); have = 0; }
  const left = (Number.isFinite(h.bytes) ? h.bytes : 0) - have;
  const s = statfsSync(dirname(dest));
  if (s.bavail * s.bsize < left * 1.1) throw new Error(`空きディスクが足りません（${dirname(dest)} に、あと ${MiB(left * 1.1)} 要ります）。ファイルを消して空きを作ってから、もう一度回してください`);

  // If-Range：途中のファイルが変わっていたら（latest が新しくなった）、サーバは全部を 200 で返す。そのときは最初から書く
  const res = await fetch(h.url, { headers: have ? { range: `bytes=${have}-`, ...(h.etag ? { 'if-range': h.etag } : {}) } : {} });
  if (!res.ok || !res.body) throw new Error(`ダウンロードに失敗しました（HTTP ${res.status}）：${h.url}`);
  const resume = have > 0 && res.status === 206;
  let got = resume ? have : 0;
  log(`取得：${h.url}（${Number.isFinite(h.bytes) ? MiB(h.bytes) : '大きさ不明'}${resume ? `、${MiB(have)} から続き` : ''}）`);
  const out = createWriteStream(part, { flags: resume ? 'a' : 'w' });
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      got += chunk.length;
    }
  } catch (e) {
    throw new Error(`ダウンロードが途中で切れました（${MiB(got)}）。もう一度回すと続きから取ります（${(e as Error).message}）`);
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (Number.isFinite(h.bytes) && got !== h.bytes) throw new Error(`ダウンロードの大きさが合いません（${got} / ${h.bytes} バイト）。もう一度回すと続きから取ります`);

  const want = o.md5 ?? (o.md5Url ? (await (await fetch(o.md5Url === true ? `${h.url}.md5` : o.md5Url)).text()).split(/\s+/)[0] : null);
  if (want && (await md5Of(part)) !== want) {
    rmSync(part); // 壊れたものを続きに使わない
    throw new Error(`ダウンロードしたファイルの md5 が合いません。消したので、もう一度回すと最初から取ります：${h.url}`);
  }
  renameSync(part, dest);
  log(`取得しました：${dest}（${MiB(got)}）`);
  return { url: h.url, bytes: got };
}
