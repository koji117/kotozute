// 地図タイル（設計書 §7 の 9、§8.4）：Protomaps の日ごとのビルドから、地域の範囲を pmtiles extract で切り出す。
// 東京は今の bbox のまま（今の tokyo.pmtiles と同じ切り方）。都道府県は境界の範囲＋2km、地方と日本全国は Geofabrik の形（.poly）。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { PMTiles, type Source } from 'pmtiles';
import type { BBox, LngLat } from '../../src/ops/types';
import { download, head } from './download';
import { pmtilesAsset } from './prereq';
import type { Log } from './tools';

type Ring = LngLat[];

/** 手元の .pmtiles を npm の pmtiles で読む（CLI は要らない） */
class FileSource implements Source {
  constructor(private file: string) {}
  getKey() { return this.file; }
  async getBytes(offset: number, length: number) {
    const fh = await open(this.file);
    try {
      const b = Buffer.alloc(length);
      const { bytesRead } = await fh.read(b, 0, length, offset);
      return { data: b.buffer.slice(b.byteOffset, b.byteOffset + bytesRead) as ArrayBuffer };
    } finally { await fh.close(); }
  }
}

/** データ時点（planetiler:osm:osmosisreplicationtime。src/attribution.ts の MAP_TILES_AS_OF と同じ欄）と版。file は手元のパスか URL */
export async function tilesInfo(file: string): Promise<{ asOf: string | null; version: string | null; maxZoom: number }> {
  const p = new PMTiles(/^https?:/.test(file) ? file : new FileSource(file));
  const [h, m] = await Promise.all([p.getHeader(), p.getMetadata() as Promise<Record<string, unknown>>]);
  const s = (k: string) => (typeof m?.[k] === 'string' ? (m[k] as string) : null);
  return { asOf: s('planetiler:osm:osmosisreplicationtime'), version: s('version'), maxZoom: h.maxZoom };
}

/** 最新のビルド：一覧はないので、今日から8日前まで日付ごとに HEAD で聞き、最初にあったもの（ビルドは約6日で消える）。版が 4. か確かめる */
export async function latestBuild(log: Log, now = new Date()): Promise<string> {
  for (let d = 0; d <= 8; d++) {
    const day = new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
    const url = `https://build.protomaps.com/${day}.pmtiles`;
    if (!(await head(url)).ok) continue;
    const { version } = await tilesInfo(url);
    if (!version?.startsWith('4.')) throw new Error(`地図のビルド（${day}）の版が ${version} です。この画面は版 4 の地図に合わせてあります`);
    log(`地図のビルド：${day}（版 ${version}）`);
    return url;
  }
  throw new Error('build.protomaps.com に、この8日の地図のビルドが見つかりません。少し待ってからもう一度回すか、--tiles-file=<手元の .pmtiles> を渡してください');
}

/** pmtiles extract。<out> の横に .part で作ってから rename（途中で止まっても壊れたファイルを使わない） */
export async function extract(o: { bin: string; src: string; out: string; bbox?: BBox; region?: string; maxzoom: number; log: Log }): Promise<void> {
  const part = o.out.replace(/\.pmtiles$/, '') + '.part.pmtiles';
  rmSync(part, { force: true });
  const args = ['extract', o.src, part, o.region ? `--region=${o.region}` : `--bbox=${o.bbox!.join(',')}`, `--maxzoom=${o.maxzoom}`];
  o.log(`地図を切り出します：pmtiles ${args.join(' ')}`);
  await new Promise<void>((res, rej) => {
    const p = spawn(o.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stdout.on('data', (d) => o.log(String(d).trim()));
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', (e) => rej(new Error(`pmtiles を起動できません：${e.message}`)));
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`pmtiles extract が失敗しました（終了コード ${c}）：${err.trim()}`))));
  });
  renameSync(part, o.out);
}

/** pmtiles の CLI：手元のもの（'pmtiles'）か、固定した版を GitHub のリリースから dir に取る（sha256 を確かめる） */
export async function pmtilesBin(found: 'host' | 'download', dir: string, log: Log): Promise<string> {
  if (found === 'host') return 'pmtiles';
  const a = pmtilesAsset();
  if (!a) throw new Error(`この機械（${process.platform} ${process.arch}）用の pmtiles を用意していません`);
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, a.name);
  await download({ url: a.url, dest: archive, log });
  const h = createHash('sha256');
  for await (const c of createReadStream(archive)) h.update(c);
  if (h.digest('hex') !== a.sha256) { rmSync(archive); throw new Error(`pmtiles の sha256 が固定した値と違います（${a.name}）。消したので、もう一度回してください`); }
  // Mac の tar（bsdtar）は zip も読める。Linux は tar.gz
  await new Promise<void>((res, rej) => spawn('tar', ['-xf', archive, '-C', dir], { stdio: 'inherit' }).on('close', (c) => (c === 0 ? res() : rej(new Error('pmtiles を展開できません')))));
  return join(dir, 'pmtiles');
}

/** Geofabrik の .poly を GeoJSON の MultiPolygon にする（'!' の節は直前の外側の輪の穴）。pmtiles extract --region に渡す */
export function poly2geojson(text: string): { type: 'Feature'; properties: object; geometry: { type: 'MultiPolygon'; coordinates: Ring[][] } } {
  const lines = text.split(/\r?\n/).map((s) => s.trim());
  const polys: Ring[][] = [];
  let i = 1; // 1行目はファイルの名前
  while (i < lines.length && lines[i] !== 'END') {
    if (!lines[i]) { i++; continue; }
    const hole = lines[i].startsWith('!');
    i++;
    const ring: Ring = [];
    while (i < lines.length && lines[i] !== 'END') { const [x, y] = lines[i].split(/\s+/).map(Number); ring.push([x, y]); i++; }
    i++;
    if (ring.length && (ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1])) ring.push(ring[0]);
    if (hole && polys.length) polys.at(-1)!.push(ring); else polys.push([ring]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polys } };
}
