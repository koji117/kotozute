// 検索データ（osm.db）を OSM の pbf から作る。Overpass の代わりに src/services/osm-sqlite.ts が読む。
// 辞書（src/ops/dict.ts）の条件を読んで、どの言葉に当たるかを作るときに決める。辞書を変えたら作り直す。
// pbf は ./pbf.ts で読む（osmium も Python も Docker も使わない）。書くのは node:sqlite。
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { DICT, type DictKey } from '../../src/ops/dict';
import { DETAIL_KEYS } from '../../src/poi';
import { dictSignature, SEP } from '../../src/services/osm-sqlite';
import { ALL, NODE, Pbf, RELATION, WAY, type Tags } from './pbf';
import type { Log } from './tools';

type T = 'n' | 'w' | 'r';

export const NAME_KEYS = ['name', 'name:ja', 'alt_name', 'official_name'];
/** 道（highway の way）に残すキー：ルートの判定（check_route）と試走コース（plan_course）が読むもの */
export const HW_KEYS = ['highway', 'tunnel', 'tunnel:name', 'name', 'name:ja', 'toll', 'motorroad', 'access', 'motor_vehicle', 'maxheight', 'lanes', 'layer', 'oneway'];
/** 地物に残すキー：名前（toPlace、名前の検索）、railway（「品川駅」を駅として探す）、地点の詳細 */
export const FEAT_KEYS = [...new Set([...NAME_KEYS, 'railway', ...DETAIL_KEYS])];
const FEAT_HW_KEYS = [...new Set([...FEAT_KEYS, ...HW_KEYS])];
/** 試走コースとトンネルのまとめに要る、点の番号を残す way（辞書の tunnel と同じ道路の種類） */
const TUNNEL_HW = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$/;

// ===== 辞書の条件（Overpass QL の ["k"="v"]、!=、~、!~、,i だけ）を読む =====
const COND = /\["([^"]+)"(=|!=|~|!~)"((?:[^"\\]|\\.)*)"(,i)?\]/g;
interface Cond { k: string; op: string; v: string; i: boolean }
const conds = (filter: string): Cond[] => {
  const cs = [...filter.matchAll(COND)];
  // 読めない書き方（キーだけの [shop] など）を黙って飛ばすと、答えが Overpass と変わる。ここで止める
  if (cs.map((m) => m[0]).join('') !== filter) throw new Error(`辞書の条件を読めません：${filter}`);
  return cs.map(([, k, op, v, i]) => ({ k, op, v: v.replace(/\\(.)/g, '$1'), i: !!i }));
};
/** Overpass と同じ：!= と !~ はキーのない要素も通す */
const test = ({ k, op, v, i }: Cond): ((t: Tags) => boolean) => {
  if (op === '=') return (t) => t[k] === v;
  if (op === '!=') return (t) => t[k] !== v;
  const re = new RegExp(v, i ? 'i' : '');
  return op === '~' ? (t) => k in t && re.test(t[k]) : (t) => !(k in t) || !re.test(t[k]);
};
const typesOf = (e: 'node' | 'way' | 'nwr'): T[] => (e === 'nwr' ? ['n', 'w', 'r'] : [e[0] as T]);

/** 番号を足していく Float64Array（大きくなったら倍にする） */
class Ids {
  a = new Float64Array(1 << 20);
  n = 0;
  push(x: number) {
    if (this.n === this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x;
  }
  /** 並べて重なりを除いたもの */
  sorted(): Float64Array {
    const a = this.a.subarray(0, this.n).sort();
    let m = 0;
    for (let i = 0; i < a.length; i++) if (i === 0 || a[i] !== a[m - 1]) a[m++] = a[i];
    return a.slice(0, m);
  }
}

export async function buildOsmIndex(o: { pbf: string; out: string; log: Log }): Promise<{ rows: Record<string, number>; bytes: number }> {
  const { pbf, out, log } = o;
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  const t0 = Date.now();
  const lap = (m: string) => log(`検索データ：${m}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);

  const WORDS = Object.keys(DICT) as DictKey[];
  if (WORDS.length > 32) throw new Error('辞書の言葉が32を超えました。word_rtree の番号の付け方（fid*32+言葉）を広げてください');
  const compiled = WORDS.map((w) => DICT[w].queries.map((q) => ({ types: typesOf(q.elements), tests: conds(q.filter).map(test) })));
  const wordsOf = (type: T, tags: Tags) => WORDS.flatMap((_, i) => (compiled[i].some((q) => q.types.includes(type) && q.tests.every((c) => c(tags))) ? [i] : []));
  const named = (t: Tags) => NAME_KEYS.some((k) => k in t);

  const rows = { feat: 0, word_rows: 0, named: 0, hw: 0, rel_no_bounds: 0 };
  const file = new Pbf(pbf);
  try {
    // 1. relation の部品：範囲と形（bbox の判定）に要る way と点を覚える。
    //    全部の blob をここで1回読み、種類（点・線・relation）と、いちばん新しい要素の時刻（データ時点）も分かる
    const relWays = new Set<number>(), relNodes = new Set<number>();
    const maxTs = await file.read(ALL, {
      relation: (_, members, tags) => {
        if (!named(tags) && !wordsOf('r', tags).length) return;
        for (const m of members) if (m.type === 'w') relWays.add(m.ref); else if (m.type === 'n') relNodes.add(m.ref);
      },
    });
    // データ時点：osmium fileinfo の data.timestamp.last と同じ書き方（今の Overpass の osm_base と同じ値になる）
    const asOf = maxTs ? new Date(maxTs * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : '';
    lap(`relation の部品（way ${relWays.size}、点 ${relNodes.size}）`);

    rmSync(tmp, { force: true });
    const db = new DatabaseSync(tmp);
    db.exec(`
      PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
      CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE words(i INTEGER PRIMARY KEY, word TEXT);
      -- type：0 node、1 way、2 relation。geom：経度・緯度の 1e-7 の Int32 の組。部品の区切りは (SEP, SEP)。
      -- way の geom はその線、relation の geom は部品の点（1点ずつ区切る）。ways：relation の部品の way の番号（Float64。形は wgeom）。
      -- nodes：点の番号（Float64、トンネルの way だけ）
      CREATE TABLE feat(fid INTEGER PRIMARY KEY, type INT, osm_id INT, minx REAL, miny REAL, maxx REAL, maxy REAL, tags TEXT, geom BLOB, nodes BLOB, ways BLOB);
      CREATE TABLE wgeom(id INTEGER PRIMARY KEY, geom BLOB); -- relation の部品の way の形（relation どうしで1つを共有する）
      CREATE VIRTUAL TABLE word_rtree USING rtree(id, minx, maxx, miny, maxy); -- id = fid*32 + 言葉の番号
      CREATE TABLE name_exact(v TEXT, fid INT, PRIMARY KEY(v, fid)) WITHOUT ROWID;
      CREATE VIRTUAL TABLE name_fts USING fts5(name, name_ja, tokenize='trigram');
      CREATE TABLE hw(id INTEGER PRIMARY KEY, t TEXT);
    `);
    const insWord = db.prepare('INSERT INTO words VALUES (?, ?)');
    WORDS.forEach((w, i) => insWord.run(i, w));
    const insFeat = db.prepare('INSERT INTO feat(type, osm_id, minx, miny, maxx, maxy, tags, geom, nodes, ways) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const insWgeom = db.prepare('INSERT INTO wgeom VALUES (?, ?)');
    const insRt = db.prepare('INSERT INTO word_rtree VALUES (?,?,?,?,?)');
    const insExact = db.prepare('INSERT OR IGNORE INTO name_exact VALUES (?, ?)');
    const insFts = db.prepare('INSERT INTO name_fts(rowid, name, name_ja) VALUES (?,?,?)');
    const insHw = db.prepare('INSERT INTO hw VALUES (?, ?)');
    db.exec('BEGIN');

    const TYPE = { n: 0, w: 1, r: 2 };
    // 座標は 1e-7 度の整数のまま持つ。範囲（REAL）は度にする
    const enc = (coords: number[]) => new Uint8Array(Int32Array.from(coords).buffer);
    const f64 = (ids: number[]) => new Uint8Array(Float64Array.from(ids).buffer);
    const pick = (t: Tags, keys: string[]) => { const o: Tags = {}; for (const k of keys) if (k in t) o[k] = t[k]; return o; };
    type Box = [number, number, number, number];
    const grow = (b: Box, x0: number, y0: number, x1: number, y1: number) => {
      b[0] = Math.min(b[0], x0); b[1] = Math.min(b[1], y0); b[2] = Math.max(b[2], x1); b[3] = Math.max(b[3], y1);
    };
    // 名前だけの way と relation にも形を持つ。名前の検索の bbox も Overpass と同じく形で判定する（範囲の重なりでは広すぎる）
    function addFeat(type: T, id: number, b: Box, tags: Tags, words: number[], geom: number[] | null, nodes: number[] | null, ways: number[] | null = null) {
      const isNamed = named(tags);
      if (!isNamed && !words.length) return;
      const [x0, y0, x1, y1] = b.map((v) => v / 1e7);
      const keep = pick(tags, type === 'w' && tags.highway ? FEAT_HW_KEYS : FEAT_KEYS);
      const { lastInsertRowid } = insFeat.run(TYPE[type], id, x0, y0, x1, y1, JSON.stringify(keep), geom?.length ? enc(geom) : null, nodes ? f64(nodes) : null, ways?.length ? f64(ways) : null);
      const fid = Number(lastInsertRowid);
      rows.feat++;
      for (const w of words) { insRt.run(fid * 32 + w, x0, x1, y0, y1); rows.word_rows++; }
      if (isNamed) {
        rows.named++;
        for (const k of NAME_KEYS) if (tags[k]) insExact.run(tags[k], fid);
        if (tags.name || tags['name:ja']) insFts.run(fid, tags.name ?? null, tags['name:ja'] ?? null);
      }
    }

    // 2. 道の way のタグ（ルートの判定用）と、位置の要る点の番号（地物の way と relation の部品の way の点、relation の部品の点）
    const want = new Ids();
    for (const id of relNodes) want.push(id);
    await file.read(WAY, {
      way: (id, refs, tags) => {
        if ('highway' in tags) { insHw.run(id, JSON.stringify(pick(tags, HW_KEYS))); rows.hw++; }
        if (relWays.has(id) || named(tags) || wordsOf('w', tags).length) for (const r of refs) want.push(r);
      },
    });
    const ids = want.sorted();
    lap(`道 ${rows.hw}、位置の要る点 ${ids.length}`);

    // 3. 点：地物を入れ、要る点の位置を覚える（pbf の点は番号順なので、並べた番号と突き合わせる）
    const lon = new Int32Array(ids.length), lat = new Int32Array(ids.length), has = new Uint8Array(ids.length);
    let j = 0, last = -Infinity;
    await file.read(NODE, {
      node: (id, x, y, tags) => {
        if (id <= last) throw new Error('pbf の点が番号順に並んでいません。番号順に並べた pbf を使ってください（Geofabrik の pbf は並んでいます）');
        last = id;
        while (j < ids.length && ids[j] < id) j++;
        if (ids[j] === id) { lon[j] = x; lat[j] = y; has[j] = 1; }
        if (tags) addFeat('n', id, [x, y, x, y], tags, wordsOf('n', tags), null, null);
      },
    });
    /** 位置のある点なら ids の中の場所、なければ -1 */
    const at = (id: number) => {
      let lo = 0, hi = ids.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (ids[mid] < id) lo = mid + 1; else if (ids[mid] > id) hi = mid - 1; else return has[mid] ? mid : -1;
      }
      return -1;
    };

    // 4. 線（点の位置つき）。relation の部品の way は範囲と形を覚える
    const wayBox = new Map<number, Box>();
    await file.read(WAY, {
      way: (id, refs, tags) => {
        const inRel = relWays.has(id), words = wordsOf('w', tags);
        if (!inRel && !named(tags) && !words.length) return;
        const coords: number[] = [];
        const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
        for (const r of refs) {
          const i = at(r);
          if (i < 0) continue; // 位置のない点
          coords.push(lon[i], lat[i]);
          grow(b, lon[i], lat[i], lon[i], lat[i]);
        }
        if (inRel) { wayBox.set(id, b); if (coords.length) insWgeom.run(id, enc(coords)); }
        if (!coords.length) return;
        const tunnel = tags.tunnel === 'yes' && TUNNEL_HW.test(tags.highway ?? '');
        addFeat('w', id, b, tags, words, coords, tunnel ? refs : null);
      },
    });

    // 5. relation
    await file.read(RELATION, {
      relation: (id, members, tags) => {
        const words = wordsOf('r', tags);
        if (!named(tags) && !words.length) return;
        // Overpass の relation の範囲（out bb）と bbox・around の判定：部品の点と way から（部品の relation は見ない）
        const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
        const geom: number[] = [], ways = new Set<number>();
        for (const m of members) {
          if (m.type === 'n') {
            const i = at(m.ref);
            if (i < 0) continue;
            grow(b, lon[i], lat[i], lon[i], lat[i]);
            if (geom.length) geom.push(SEP, SEP);
            geom.push(lon[i], lat[i]);
          } else if (m.type === 'w') {
            const mb = wayBox.get(m.ref);
            if (!mb || !Number.isFinite(mb[0])) continue;
            grow(b, ...mb);
            ways.add(m.ref);
          }
        }
        // 部品が relation だけのもの（route_master など）は範囲がないので入れない
        if (!Number.isFinite(b[0])) { rows.rel_no_bounds++; return; }
        addFeat('r', id, b, tags, words, geom, null, [...ways]);
      },
    });
    lap(`地物 ${rows.feat}（名前つき ${rows.named}、言葉 ${rows.word_rows}）`);

    const insMeta = db.prepare('INSERT INTO meta VALUES (?, ?)');
    insMeta.run('osm_as_of', asOf);
    insMeta.run('dict', dictSignature());
    db.exec('COMMIT');
    db.exec('CREATE INDEX feat_osm ON feat(type, osm_id)');
    db.exec("INSERT INTO name_fts(name_fts) VALUES('optimize')");
    db.close();
  } finally {
    file.close();
  }
  renameSync(tmp, out);
  const bytes = statSync(out).size;
  lap(`できあがり ${(bytes / 1e6).toFixed(0)} MB`);
  return { rows, bytes };
}
