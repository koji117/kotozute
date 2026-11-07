// 途中で止まっても続きから取れるダウンロード（Range と If-Range）。md5 か sha256 を確かめてから本当の名前にする。
// 書きかけは <dest>.part。確かめ終わったものだけが dest になるので、もう一度回しても壊れたファイルを使わない。
// <dest>.part.src に書きかけの元（転送をたどった先と ETag）を覚え、今の元と違えば続きにせず最初から取る（Geofabrik の latest は毎日、別の日付のファイルを指す）。
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { basename, dirname } from 'node:path';
import type { Log } from './tools';

// fetch は IPv6 と IPv4 を順に試し、1つの試みを既定 250 ms（Electron 44 の Node 24）で打ち切る。日本から Geofabrik（ドイツ）までは
// TCP の接続に約 290 ms かかるので、全部の試みが打ち切られて「fetch failed」になる（作った Mac のアプリで毎回起きた。11/7）。
// このプロセスはダウンロードのためのものなので、全体の既定を長くする。
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const MiB = (n: number) => `${(n / 2 ** 20).toFixed(0)} MiB`;

/** ネットにつながらないとき（fetch が投げる。fetch failed、時間切れ）の文。取る先の名前を入れる（英語の「fetch failed」だけを出さない） */
export const netError = (url: string, e: Error) =>
  new Error(`ネットにつながっていないか、${new URL(url).host} に届きません。つながってから、もう一度ためしてください。途中まで取ったものは続きから取ります（${e.message}）`);
const get = (url: string, init?: RequestInit) => fetch(url, init).catch((e: Error) => { throw netError(url, e); });

/** HEAD（転送をたどる）。latest のような URL は、日付つきの本当のファイル（url）に固定して使う */
export async function head(url: string): Promise<{ ok: boolean; status: number; url: string; bytes: number; etag: string | null }> {
  const r = await get(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  return { ok: r.ok, status: r.status, url: r.url, bytes: Number(r.headers.get('content-length') ?? NaN), etag: r.headers.get('etag') };
}

const hashOf = async (file: string, alg: 'md5' | 'sha256') => {
  const h = createHash(alg);
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest('hex');
};

/**
 * url を dest に取る。dest がもうあれば何もしない。md5（16進）か md5Url（Geofabrik の .md5 のように1語目が値）か sha256 があれば確かめる。
 * revalidate：dest があっても、元（転送をたどった先の URL と ETag）が取ったときと同じときだけ使い、違えば取り直す（<dest>.etag に覚える）。
 *   アプリの「最新にする」で、前の回に取って残った古い latest を使わないため。途中の .part も、元が同じときだけ続きから取る（.part.src）。
 * progress は取った量と全体（分からなければ 0）を、塊ごとに呼ぶ（間引くのは呼ぶ側）。
 * 戻り値の url は転送をたどった先（日付つきのファイル名が分かる）
 */
export async function download(o: {
  url: string; dest: string; md5?: string; md5Url?: string | true; sha256?: string; revalidate?: boolean; log: Log; progress?: (got: number, total: number) => void;
}): Promise<{ url: string; bytes: number }> {
  const { dest, log } = o;
  if (existsSync(dest) && !o.revalidate) return { url: o.url, bytes: statSync(dest).size };
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const tag = `${dest}.etag`;
  const h = await head(o.url);
  if (!h.ok) throw Object.assign(new Error(`ダウンロードできません（HTTP ${h.status}）：${o.url}`), { status: h.status });
  // 元の印。URL の ? 以降は見ない（GitHub の Releases は、毎回ちがう署名つきの URL に転送する）
  const id = `${h.url.split('?')[0]} ${h.etag}`;
  if (existsSync(dest)) {
    if (h.etag && existsSync(tag) && readFileSync(tag, 'utf8') === id) return { url: h.url, bytes: statSync(dest).size };
    rmSync(dest);
    log(`前に取った ${basename(dest)} は今の ${h.url} と違うので、取り直します`);
  }
  const src = `${part}.src`;
  let have = existsSync(part) ? statSync(part).size : 0;
  // 書きかけの元が分からないか今と違う（latest が新しい日付のファイルになった）、または今より大きいときは、捨てて最初から取る
  if (have > 0 && ((existsSync(src) ? readFileSync(src, 'utf8') : '') !== id || (Number.isFinite(h.bytes) && have > h.bytes))) {
    rmSync(part);
    rmSync(src, { force: true });
    have = 0;
    log(`書きかけの ${basename(part)} は今の ${h.url.split('?')[0]} と違うので、最初から取ります`);
  }
  const left = (Number.isFinite(h.bytes) ? h.bytes : 0) - have;
  const s = statfsSync(dirname(dest));
  if (s.bavail * s.bsize < left * 1.1) throw new Error(`空きディスクが足りません（${dirname(dest)} に、あと ${MiB(left * 1.1)} 要ります）。ファイルを消して空きを作ってから、もう一度回してください`);

  // .part を取り終えたあと、確かめる前に止まった回（md5 のファイルが取れない、Ctrl-C など）は、取らずに確かめへ進む
  let got = have;
  // If-Range の ETag は .part.src のものと同じ（上で確かめた）
  const res = have > 0 && have === h.bytes ? null : await get(h.url, { headers: have ? { range: `bytes=${have}-`, ...(h.etag ? { 'if-range': h.etag } : {}) } : {} });
  if (res?.status === 416 && have > 0) await res.body?.cancel(); // 続きがない＝取り終えている（大きさが分からないとき）
  else if (res) {
    // If-Range：途中のファイルが変わっていたら（latest が新しくなった）、サーバは全部を 200 で返す。そのときは最初から書く
    if (!res.ok || !res.body) throw new Error(`ダウンロードに失敗しました（HTTP ${res.status}）：${h.url}`);
    const resume = have > 0 && res.status === 206;
    got = resume ? have : 0;
    log(`取得：${h.url}（${Number.isFinite(h.bytes) ? MiB(h.bytes) : '大きさ不明'}${resume ? `、${MiB(have)} から続き` : ''}）`);
    if (!resume) writeFileSync(src, id);
    const out = createWriteStream(part, { flags: resume ? 'a' : 'w' });
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        got += chunk.length;
        o.progress?.(got, Number.isFinite(h.bytes) ? h.bytes : 0);
      }
    } catch (e) {
      throw new Error(`ダウンロードが途中で切れました（${MiB(got)}）。もう一度回すと続きから取ります（${(e as Error).message}）`);
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (Number.isFinite(h.bytes) && got !== h.bytes) throw new Error(`ダウンロードの大きさが合いません（${got} / ${h.bytes} バイト）。もう一度回すと続きから取ります`);
  }

  let want = o.md5 ?? null;
  if (!want && o.md5Url) {
    const r = await get(o.md5Url === true ? `${h.url}.md5` : o.md5Url);
    if (!r.ok) throw new Error(`md5 のファイルを取れません（HTTP ${r.status}）。もう一度回してください：${r.url}`);
    want = (await r.text()).split(/\s+/)[0];
  }
  if (want && (await hashOf(part, 'md5')) !== want) {
    rmSync(part); // 壊れたものを続きに使わない
    rmSync(src, { force: true });
    throw new Error(`ダウンロードしたファイルの md5 が合いません。消したので、もう一度回すと最初から取ります：${h.url}`);
  }
  if (o.sha256 && (await hashOf(part, 'sha256')) !== o.sha256) {
    rmSync(part);
    rmSync(src, { force: true });
    throw new Error(`ダウンロードしたファイルの sha256 が固定した値と違います。消したので、もう一度回すと最初から取ります：${h.url}`);
  }
  renameSync(part, dest);
  rmSync(src, { force: true });
  if (o.revalidate) writeFileSync(tag, id);
  log(`取得しました：${dest}（${MiB(got)}）`);
  return { url: h.url, bytes: got };
}
