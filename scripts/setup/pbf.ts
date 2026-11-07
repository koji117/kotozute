// OSM の pbf を読む。依存はなし（node:fs、node:zlib と、手で書いた protobuf の読み方）。
// 形式は fileformat.proto と osmformat.proto（https://wiki.openstreetmap.org/wiki/PBF_Format）。
// 座標は osmium と同じ 1e-7 度の整数、時刻は秒で返す。
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { promisify } from 'node:util';
import { inflate, inflateSync } from 'node:zlib';

export type Tags = Record<string, string>;
export interface Member { type: 'n' | 'w' | 'r'; ref: number; role: string }
/** 要素の種類（blob に入っている種類の印にも使う） */
export const NODE = 1, WAY = 2, RELATION = 4, ALL = 7;
/** 読む要素ごとに呼ぶ。ない種類は中を読まない（時刻だけを見る） */
export interface Visitor {
  /** tags：タグのない点は null */
  node?: (id: number, lon: number, lat: number, tags: Tags | null) => void;
  way?: (id: number, refs: number[], tags: Tags) => void;
  relation?: (id: number, members: Member[], tags: Tags) => void;
}
export interface PbfHeader {
  /** osmosis_replication_timestamp（秒）。ないときは null */
  replicationTimestamp: number | null;
  required: string[];
  optional: string[];
}
/** OSMData の blob の場所と、入っている要素の種類（0 はまだ読んでいない） */
interface BlobRef { pos: number; size: number; kinds: number }

/** 読める必須の機能。ほか（HistoricalInformation など）は止める */
const SUPPORTED = new Set(['OsmSchema-V0.6', 'DenseNodes']);
const inflateAsync = promisify(inflate);
/** 先に展開しておく blob の数（展開は libuv のスレッドで並ぶ） */
const AHEAD = 16;

/** protobuf の読み手。b の [p, end) を読む */
class Pb {
  constructor(public b: Uint8Array, public p = 0, public end = b.length) {}
  uint(): number {
    const b = this.b;
    let x = b[this.p++];
    if (x < 0x80) return x;
    let v = x & 0x7f;
    x = b[this.p++]; v |= (x & 0x7f) << 7; if (x < 0x80) return v;
    x = b[this.p++]; v |= (x & 0x7f) << 14; if (x < 0x80) return v;
    x = b[this.p++]; v |= (x & 0x7f) << 21; if (x < 0x80) return v;
    // 28 ビットを超える分は掛け算で足す（ビット演算は 32 ビットまで）
    let m = 2 ** 28;
    do { x = b[this.p++]; v += (x & 0x7f) * m; m *= 0x80; } while (x >= 0x80);
    return v;
  }
  /** sint32、sint64（zigzag） */
  sint(): number { const v = this.uint(); return v % 2 ? -(v + 1) / 2 : v / 2; }
  /** int64（負の値は 10 バイト） */
  int64(): number { const v = this.uint(); return v >= 2 ** 63 ? v - 2 ** 64 : v; }
  /** 長さつきの中身を、別の読み手として切り出す */
  sub(): Pb { const n = this.uint(); const r = new Pb(this.b, this.p, this.p + n); this.p += n; return r; }
  skip(wt: number) {
    if (wt === 0) this.uint();
    else if (wt === 2) { const n = this.uint(); this.p += n; } // 先に長さを読む（this.p += this.uint() だと読んだ分が消える）
    else if (wt === 1) this.p += 8;
    else if (wt === 5) this.p += 4;
    else throw new Error(`pbf を読めません（protobuf の型 ${wt}）`);
  }
}
/** repeated の数値は packed だけを読む（osmium も osmosis も packed で書く） */
function packed(r: Pb, wt: number, what: string): Pb {
  if (wt !== 2) throw new Error(`pbf を読めません（${what} が packed ではありません）`);
  return r.sub();
}

/** ブロックの文字の表。使うときに1つずつ文字にする */
class Strings {
  private at: number[] = [];
  private cache: (string | undefined)[] = [];
  constructor(private buf: Buffer, r: Pb | null) {
    if (!r) return;
    while (r.p < r.end) {
      const tag = r.uint();
      if (tag >>> 3 === 1 && (tag & 7) === 2) { const n = r.uint(); this.at.push(r.p, r.p + n); r.p += n; }
      else r.skip(tag & 7);
    }
  }
  get(i: number): string {
    const s = this.cache[i];
    if (s !== undefined) return s;
    if (2 * i + 1 >= this.at.length) throw new Error(`pbf を読めません（文字の表に ${i} 番がありません）`);
    return (this.cache[i] = this.buf.toString('utf8', this.at[2 * i], this.at[2 * i + 1]));
  }
}

function tagsOf(s: Strings, keys: Pb | null, vals: Pb | null): Tags {
  const t: Tags = {};
  if (keys && vals) while (keys.p < keys.end) t[s.get(keys.uint())] = s.get(vals.uint());
  return t;
}
/** Info の時刻（秒の素の値。date_granularity は呼ぶ側で掛ける） */
function infoTs(r: Pb): number {
  let ts = 0;
  while (r.p < r.end) {
    const tag = r.uint();
    if (tag === (2 << 3)) ts = r.int64(); else r.skip(tag & 7);
  }
  return ts;
}

/**
 * 1つのブロック（PrimitiveBlock）を読む。返すのは、入っていた要素の種類（NODE|WAY|RELATION）と、
 * いちばん新しい要素の時刻（秒。時刻がなければ 0）
 */
export function decodeBlock(data: Buffer, v: Visitor): { kinds: number; maxTs: number } {
  const r = new Pb(data);
  let st: Pb | null = null;
  const groups: Pb[] = [];
  let gran = 100, latOff = 0, lonOff = 0, dateGran = 1000;
  while (r.p < r.end) {
    const tag = r.uint(), f = tag >>> 3, wt = tag & 7;
    if (f === 1 && wt === 2) st = r.sub();
    else if (f === 2 && wt === 2) groups.push(r.sub());
    else if (f === 17 && wt === 0) gran = r.uint();
    else if (f === 18 && wt === 0) dateGran = r.uint();
    else if (f === 19 && wt === 0) latOff = r.int64();
    else if (f === 20 && wt === 0) lonOff = r.int64();
    else r.skip(wt);
  }
  const s = new Strings(data, st);
  // osmium と同じ：(offset + granularity × 値) / 100 を 0 の方向に切る（ナノ度 → 1e-7 度）
  const plain = gran === 100 && latOff === 0 && lonOff === 0;
  const lonOf = (x: number) => (plain ? x : Math.trunc((lonOff + gran * x) / 100));
  const latOf = (y: number) => (plain ? y : Math.trunc((latOff + gran * y) / 100));
  const tsFactor = Math.trunc(dateGran / 1000); // osmium と同じ整数の割り算
  let kinds = 0, maxTs = 0;
  const seen = (t: number) => { if (t * tsFactor > maxTs) maxTs = t * tsFactor; };

  for (const g of groups) {
    while (g.p < g.end) {
      const tag = g.uint(), f = tag >>> 3, wt = tag & 7;
      if (wt !== 2) { g.skip(wt); continue; }
      const m = g.sub();
      if (f === 1) { kinds |= NODE; node(m); }
      else if (f === 2) { kinds |= NODE; dense(m); }
      else if (f === 3) { kinds |= WAY; way(m); }
      else if (f === 4) { kinds |= RELATION; relation(m); }
      // 5（changeset）は読まない
    }
  }
  return { kinds, maxTs };

  function node(m: Pb) {
    let id = 0, lat = 0, lon = 0;
    let keys: Pb | null = null, vals: Pb | null = null;
    while (m.p < m.end) {
      const tag = m.uint(), f = tag >>> 3, wt = tag & 7;
      if (f === 1) id = m.sint();
      else if (f === 2) keys = packed(m, wt, 'Node.keys');
      else if (f === 3) vals = packed(m, wt, 'Node.vals');
      else if (f === 4 && wt === 2) seen(infoTs(m.sub()));
      else if (f === 8) lat = m.sint();
      else if (f === 9) lon = m.sint();
      else m.skip(wt);
    }
    if (v.node) v.node(id, lonOf(lon), latOf(lat), keys && keys.p < keys.end ? tagsOf(s, keys, vals) : null);
  }

  function dense(m: Pb) {
    let ids: Pb | null = null, lats: Pb | null = null, lons: Pb | null = null, kv: Pb | null = null;
    while (m.p < m.end) {
      const tag = m.uint(), f = tag >>> 3, wt = tag & 7;
      if (f === 1) ids = packed(m, wt, 'DenseNodes.id');
      else if (f === 5 && wt === 2) {
        const info = m.sub();
        while (info.p < info.end) {
          const t2 = info.uint();
          if (t2 >>> 3 !== 2) { info.skip(t2 & 7); continue; }
          const ts = packed(info, t2 & 7, 'DenseInfo.timestamp');
          for (let t = 0; ts.p < ts.end;) seen((t += ts.sint()));
        }
      }
      else if (f === 8) lats = packed(m, wt, 'DenseNodes.lat');
      else if (f === 9) lons = packed(m, wt, 'DenseNodes.lon');
      else if (f === 10) kv = packed(m, wt, 'DenseNodes.keys_vals');
      else m.skip(wt);
    }
    if (!v.node || !ids || !lats || !lons) return;
    let id = 0, lat = 0, lon = 0;
    while (ids.p < ids.end) {
      id += ids.sint(); lat += lats.sint(); lon += lons.sint();
      let tags: Tags | null = null;
      // keys_vals：点ごとに「キー 値 … 0」。どの点にもタグがないブロックでは欄がない
      if (kv) {
        for (let k = kv.uint(); k !== 0; k = kv.uint()) (tags ??= {})[s.get(k)] = s.get(kv.uint());
      }
      v.node(id, lonOf(lon), latOf(lat), tags);
    }
  }

  function way(m: Pb) {
    let id = 0;
    let keys: Pb | null = null, vals: Pb | null = null, refs: Pb | null = null;
    while (m.p < m.end) {
      const tag = m.uint(), f = tag >>> 3, wt = tag & 7;
      if (f === 1) id = m.int64();
      else if (f === 2) keys = packed(m, wt, 'Way.keys');
      else if (f === 3) vals = packed(m, wt, 'Way.vals');
      else if (f === 4 && wt === 2) seen(infoTs(m.sub()));
      else if (f === 8) refs = packed(m, wt, 'Way.refs');
      else m.skip(wt);
    }
    if (!v.way) return;
    const ids: number[] = [];
    if (refs) for (let ref = 0; refs.p < refs.end;) ids.push((ref += refs.sint()));
    v.way(id, ids, tagsOf(s, keys, vals));
  }

  function relation(m: Pb) {
    let id = 0;
    let keys: Pb | null = null, vals: Pb | null = null, roles: Pb | null = null, memids: Pb | null = null, types: Pb | null = null;
    while (m.p < m.end) {
      const tag = m.uint(), f = tag >>> 3, wt = tag & 7;
      if (f === 1) id = m.int64();
      else if (f === 2) keys = packed(m, wt, 'Relation.keys');
      else if (f === 3) vals = packed(m, wt, 'Relation.vals');
      else if (f === 4 && wt === 2) seen(infoTs(m.sub()));
      else if (f === 8) roles = packed(m, wt, 'Relation.roles_sid');
      else if (f === 9) memids = packed(m, wt, 'Relation.memids');
      else if (f === 10) types = packed(m, wt, 'Relation.types');
      else m.skip(wt);
    }
    if (!v.relation) return;
    const members: Member[] = [];
    if (memids && types && roles) {
      for (let ref = 0; memids.p < memids.end;) {
        const t = types.uint();
        if (t > 2) throw new Error(`pbf を読めません（relation ${id} の部品の種類 ${t}）`);
        members.push({ type: 'nwr'[t] as Member['type'], ref: (ref += memids.sint()), role: s.get(roles.uint()) });
      }
    }
    v.relation(id, members, tagsOf(s, keys, vals));
  }
}

const COMPRESSION: Record<number, string> = { 4: 'lzma', 5: 'bzip2', 6: 'lz4', 7: 'zstd' };
/** Blob から中身を取り出す（無圧縮と zlib だけ） */
function unpack(blob: Buffer, sync = false): Buffer | Promise<Buffer> {
  const r = new Pb(blob);
  while (r.p < r.end) {
    const tag = r.uint(), f = tag >>> 3, wt = tag & 7;
    if ((f === 1 || f === 3) && wt === 2) {
      const n = r.uint(), body = blob.subarray(r.p, r.p + n);
      return f === 1 ? body : sync ? inflateSync(body) : inflateAsync(body);
    }
    if (COMPRESSION[f]) throw new Error(`この pbf は ${COMPRESSION[f]} で圧縮されていて読めません。zlib か無圧縮の pbf を使ってください（Geofabrik の pbf は zlib です）`);
    r.skip(wt);
  }
  throw new Error('pbf を読めません（blob に中身がありません）');
}

/** pbf のファイル。開くと blob の場所を全部数え、ヘッダを読む */
export class Pbf {
  readonly header: PbfHeader;
  private fd: number;
  private blobs: BlobRef[] = [];

  constructor(readonly path: string) {
    this.fd = openSync(path, 'r');
    try {
      const size = fstatSync(this.fd).size;
      const len = Buffer.alloc(4);
      let header: Buffer | null = null;
      for (let pos = 0; pos < size;) {
        if (readSync(this.fd, len, 0, 4, pos) !== 4) throw new Error('pbf が途中で切れています');
        const hlen = len.readUInt32BE(0);
        if (hlen > 64 * 1024) throw new Error('pbf を読めません（BlobHeader が大きすぎます。pbf ではないファイルかもしれません）');
        const h = this.bytes(pos + 4, hlen);
        let type = '', dsize = -1;
        for (const r = new Pb(h); r.p < r.end;) {
          const tag = r.uint();
          if (tag === ((1 << 3) | 2)) { const n = r.uint(); type = h.toString('utf8', r.p, r.p + n); r.p += n; }
          else if (tag === (3 << 3)) dsize = r.uint();
          else r.skip(tag & 7);
        }
        if (dsize < 0) throw new Error('pbf を読めません（BlobHeader に datasize がありません）');
        const at = pos + 4 + hlen;
        if (at + dsize > size) throw new Error('pbf が途中で切れています');
        if (type === 'OSMHeader' && !header) header = this.bytes(at, dsize);
        else if (type === 'OSMData') this.blobs.push({ pos: at, size: dsize, kinds: 0 });
        pos = at + dsize;
      }
      if (!header) throw new Error('pbf を読めません（OSMHeader がありません）');
      this.header = parseHeader(header);
    } catch (e) {
      closeSync(this.fd);
      throw e;
    }
  }

  private bytes(pos: number, n: number): Buffer {
    const b = Buffer.allocUnsafe(n);
    if (readSync(this.fd, b, 0, n, pos) !== n) throw new Error('pbf が途中で切れています');
    return b;
  }

  /**
   * kinds（NODE|WAY|RELATION）の要素が入っている blob を、ファイルの順に読む。返すのは読んだ要素のいちばん新しい時刻（秒）。
   * 1回目に読んだ blob の種類を覚え、次からは要らない blob を展開しない（最初は ALL で全部を読むと、次から速い）
   */
  async read(kinds: number, v: Visitor): Promise<number> {
    const todo = this.blobs.filter((b) => !b.kinds || b.kinds & kinds);
    const q: { b: BlobRef; data: Buffer | Promise<Buffer> }[] = [];
    let next = 0, maxTs = 0;
    const more = () => { if (next < todo.length) { const b = todo[next++]; q.push({ b, data: unpack(this.bytes(b.pos, b.size)) }); } };
    for (let i = 0; i < AHEAD; i++) more();
    while (q.length) {
      const { b, data } = q.shift()!;
      more();
      const r = decodeBlock(await data, v);
      b.kinds = r.kinds || 8; // 空のブロックは 8（どの種類にも当たらない）
      if (r.maxTs > maxTs) maxTs = r.maxTs;
    }
    return maxTs;
  }

  close() { closeSync(this.fd); }
}

function parseHeader(blob: Buffer): PbfHeader {
  const data = unpack(blob, true) as Buffer; // ヘッダは小さいので同じスレッドで展開する
  const h: PbfHeader = { replicationTimestamp: null, required: [], optional: [] };
  for (const r = new Pb(data); r.p < r.end;) {
    const tag = r.uint(), f = tag >>> 3, wt = tag & 7;
    if ((f === 4 || f === 5) && wt === 2) { const n = r.uint(); (f === 4 ? h.required : h.optional).push(data.toString('utf8', r.p, r.p + n)); r.p += n; }
    else if (f === 32 && wt === 0) h.replicationTimestamp = r.int64();
    else r.skip(wt);
  }
  const bad = h.required.filter((x) => !SUPPORTED.has(x));
  if (bad.length) throw new Error(`この pbf は読めない機能を使っています：${bad.join('、')}`);
  return h;
}
/** ヘッダだけを読む（osmosis_replication_timestamp と必須の機能） */
export function readPbfHeader(path: string): PbfHeader {
  const f = new Pbf(path);
  f.close();
  return f.header;
}
