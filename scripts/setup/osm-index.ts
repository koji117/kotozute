// 検索データ（osm.db）を OSM の pbf から作る。Overpass の代わりに src/services/osm-sqlite.ts が読む。
// 辞書（src/ops/dict.ts）の条件を読んで、どの言葉に当たるかを作るときに決める。辞書を変えたら作り直す。
// 使う道具は osmium（tags-filter、add-locations-to-ways、cat、fileinfo）と node:sqlite だけ。
import { DETAIL_KEYS } from '../../src/poi';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DICT, type DictKey } from '../../src/ops/dict';
import { dictSignature, SEP } from '../../src/services/osm-sqlite';
import type { Log, Osmium } from './tools';

type Tags = Record<string, string>;
type T = 'n' | 'w' | 'r';

const NAME_KEYS = ['name', 'name:ja', 'alt_name', 'official_name'];
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

/** osmium tags-filter の式：条件のうち1つ（= を先に）。広めに取り、正しい判定は作るときに wordsOf でする */
function filterExpr(elements: 'node' | 'way' | 'nwr', filter: string): string {
  const cs = conds(filter);
  const c = cs.find((x) => x.op === '=') ?? cs.find((x) => x.op === '~');
  if (!c) throw new Error(`辞書の条件に = か ~ がありません：${filter}`);
  const t = typesOf(elements).join('');
  if (c.op === '=') return `${t}/${c.k}=${c.v}`;
  const m = !c.i && /^\^(?:\(([\w:|]+)\)|([\w:]+))\$$/.exec(c.v); // ^(a|b)$ と ^a$ は値の一覧にできる
  return m ? `${t}/${c.k}=${(m[1] ?? m[2]).split('|').join(',')}` : `${t}/${c.k}`;
}

// ===== OPL（osmium の1行1要素の書き方）を読む =====
const unesc = (s: string) => (s.includes('%') ? s.replace(/%([0-9a-f]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16))) : s);
function parseTags(f: string): Tags {
  const t: Tags = {};
  if (f.length > 1) for (const kv of f.slice(1).split(',')) { const i = kv.indexOf('='); t[unesc(kv.slice(0, i))] = unesc(kv.slice(i + 1)); }
  return t;
}
function fields(line: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of line.split(' ')) o[f[0]] = f;
  return o;
}

/** osmium を回して、終わるのを待つ。失敗したら stderr の最後をつけて止める */
function done(p: ReturnType<Osmium>, args: string[]): Promise<void> {
  let err = '';
  p.stderr!.on('data', (d) => (err = (err + d).slice(-2000)));
  return new Promise((res, rej) => {
    p.on('error', (e) => rej(new Error(`osmium を起動できません：${e.message}`)));
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`osmium ${args[0]} が失敗しました（終了コード ${code}）：${err.trim()}`))));
  });
}
async function run(osmium: Osmium, args: string[]): Promise<string> {
  const p = osmium(args);
  let out = '';
  p.stdout!.on('data', (d) => (out += d));
  await done(p, args);
  return out.trim();
}
async function* lines(osmium: Osmium, args: string[]): AsyncGenerator<string> {
  const p = osmium(args);
  const end = done(p, args);
  end.catch(() => {}); // 読み終わる前に失敗しても、下の await で受ける
  yield* createInterface({ input: p.stdout!, crlfDelay: Infinity });
  await end;
}

export async function buildOsmIndex(o: { pbf: string; out: string; osmium: Osmium; log: Log }): Promise<{ rows: Record<string, number>; bytes: number }> {
  const { pbf, out, osmium, log } = o;
  const dir = dirname(out);
  mkdirSync(dir, { recursive: true });
  const sel = join(dir, 'sel.pbf'), hw = join(dir, 'hw.pbf'), tmp = `${out}.tmp`;
  const t0 = Date.now();
  const lap = (m: string) => log(`検索データ：${m}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);

  const WORDS = Object.keys(DICT) as DictKey[];
  if (WORDS.length > 32) throw new Error('辞書の言葉が32を超えました。word_rtree の番号の付け方（fid*32+言葉）を広げてください');
  const compiled = WORDS.map((w) => DICT[w].queries.map((q) => ({ types: typesOf(q.elements), tests: conds(q.filter).map(test) })));
  const wordsOf = (type: T, tags: Tags) => WORDS.flatMap((_, i) => (compiled[i].some((q) => q.types.includes(type) && q.tests.every((c) => c(tags))) ? [i] : []));

  // 1. pbf から、辞書の言葉・名前のある要素（参照する点と線つき）と、道の way（参照なし）を抜き出す
  const exprs = [...new Set([...WORDS.flatMap((w) => DICT[w].queries.map((q) => filterExpr(q.elements, q.filter))), ...NAME_KEYS.map((k) => `nwr/${k}`)])];
  await run(osmium, ['tags-filter', pbf, ...exprs, '-o', sel, '--overwrite']);
  await run(osmium, ['tags-filter', pbf, 'w/highway', '-R', '-o', hw, '--overwrite']);
  // データ時点：いちばん新しい要素の時刻（今の Overpass の osm_base と同じ値になる）
  const asOf = await run(osmium, ['fileinfo', '-e', '-g', 'data.timestamp.last', pbf]);
  lap(`抜き出し（${exprs.length} 個の条件）`);

  // 2. relation の部品：範囲を出すのに要る way と点を覚える
  const relWays = new Set<number>(), relNodes = new Set<number>();
  const named = (t: Tags) => NAME_KEYS.some((k) => k in t);
  for await (const line of lines(osmium, ['cat', sel, '-t', 'relation', '-f', 'opl,add_metadata=false'])) {
    const f = fields(line);
    const tags = parseTags(f.T ?? 'T');
    if (!named(tags) && !wordsOf('r', tags).length) continue;
    for (const m of (f.M ?? 'M').slice(1).split(',')) {
      if (!m) continue;
      const id = Number(m.slice(1, m.indexOf('@')));
      if (m[0] === 'w') relWays.add(id); else if (m[0] === 'n') relNodes.add(id);
    }
  }

  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  db.exec(`
    PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE words(i INTEGER PRIMARY KEY, word TEXT);
    -- type：0 node、1 way、2 relation。geom：経度・緯度の 1e-7 の Int32 の組。部品の区切りは (SEP, SEP)。nodes：点の番号（Float64、トンネルの way だけ）
    CREATE TABLE feat(fid INTEGER PRIMARY KEY, type INT, osm_id INT, minx REAL, miny REAL, maxx REAL, maxy REAL, tags TEXT, geom BLOB, nodes BLOB);
    CREATE VIRTUAL TABLE word_rtree USING rtree(id, minx, maxx, miny, maxy); -- id = fid*32 + 言葉の番号
    CREATE TABLE name_exact(v TEXT, fid INT, PRIMARY KEY(v, fid)) WITHOUT ROWID;
    CREATE VIRTUAL TABLE name_fts USING fts5(name, name_ja, tokenize='trigram');
    CREATE TABLE hw(id INTEGER PRIMARY KEY, t TEXT);
  `);
  const insWord = db.prepare('INSERT INTO words VALUES (?, ?)');
  WORDS.forEach((w, i) => insWord.run(i, w));
  const insFeat = db.prepare('INSERT INTO feat(type, osm_id, minx, miny, maxx, maxy, tags, geom, nodes) VALUES (?,?,?,?,?,?,?,?,?)');
  const insRt = db.prepare('INSERT INTO word_rtree VALUES (?,?,?,?,?)');
  const insExact = db.prepare('INSERT OR IGNORE INTO name_exact VALUES (?, ?)');
  const insFts = db.prepare('INSERT INTO name_fts(rowid, name, name_ja) VALUES (?,?,?)');
  db.exec('BEGIN');

  const rows = { feat: 0, word_rows: 0, named: 0, hw: 0, rel_no_bounds: 0 };
  const TYPE = { n: 0, w: 1, r: 2 };
  const enc = (coords: number[]) => new Uint8Array(Int32Array.from(coords, (c) => Math.round(c * 1e7)).buffer);
  const pick = (t: Tags, keys: string[]) => { const o: Tags = {}; for (const k of keys) if (k in t) o[k] = t[k]; return o; };
  type Box = [number, number, number, number];
  function addFeat(type: T, id: number, b: Box, tags: Tags, words: number[], geom: number[] | null, nodes: number[] | null) {
    const isNamed = named(tags);
    if (!isNamed && !words.length) return;
    const keep = pick(tags, type === 'w' && tags.highway ? FEAT_HW_KEYS : FEAT_KEYS);
    const { lastInsertRowid } = insFeat.run(TYPE[type], id, b[0], b[1], b[2], b[3], JSON.stringify(keep), words.length && geom ? enc(geom) : null, nodes ? new Uint8Array(Float64Array.from(nodes).buffer) : null);
    const fid = Number(lastInsertRowid);
    rows.feat++;
    for (const w of words) { insRt.run(fid * 32 + w, b[0], b[2], b[1], b[3]); rows.word_rows++; }
    if (isNamed) {
      rows.named++;
      for (const k of NAME_KEYS) if (tags[k]) insExact.run(tags[k], fid);
      if (tags.name || tags['name:ja']) insFts.run(fid, tags.name ?? null, tags['name:ja'] ?? null);
    }
  }

  // 3. 点、線（点の位置つき）、relation を順に入れる
  const nodeLoc = new Map<number, [number, number]>(), wayBox = new Map<number, Box>(), wayGeom = new Map<number, number[]>();
  for await (const line of lines(osmium, ['add-locations-to-ways', sel, '-n', '-f', 'opl,add_metadata=false', '-o', '-'])) {
    const f = fields(line);
    if (line[0] === 'n') {
      const id = Number(f.n.slice(1));
      if (f.T.length === 1 && !relNodes.has(id)) continue;
      const x = Number(f.x.slice(1)), y = Number(f.y.slice(1));
      if (relNodes.has(id)) nodeLoc.set(id, [x, y]);
      if (f.T.length > 1) { const tags = parseTags(f.T); addFeat('n', id, [x, y, x, y], tags, wordsOf('n', tags), null, null); }
    } else if (line[0] === 'w') {
      const id = Number(f.w.slice(1));
      const tags = parseTags(f.T);
      const coords: number[] = [], ids: number[] = [];
      const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
      for (const nd of f.N.slice(1).split(',')) {
        if (!nd) continue;
        const xi = nd.indexOf('x'), yi = nd.indexOf('y');
        ids.push(Number(nd.slice(1, xi < 0 ? undefined : xi)));
        if (xi < 0 || yi === xi + 1) continue; // 位置のない点
        const x = Number(nd.slice(xi + 1, yi)), y = Number(nd.slice(yi + 1));
        coords.push(x, y);
        b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
      }
      if (relWays.has(id)) { wayBox.set(id, b); wayGeom.set(id, coords); }
      if (!coords.length) continue;
      const tunnel = tags.tunnel === 'yes' && TUNNEL_HW.test(tags.highway ?? '');
      addFeat('w', id, b, tags, wordsOf('w', tags), coords, tunnel ? ids : null);
    } else if (line[0] === 'r') {
      const id = Number(f.r.slice(1));
      const tags = parseTags(f.T);
      const words = wordsOf('r', tags);
      if (!named(tags) && !words.length) continue;
      // Overpass の relation の範囲（out bb）：部品の点と way から（部品の relation は見ない）
      const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
      const geom: number[] = [];
      for (const m of (f.M ?? 'M').slice(1).split(',')) {
        if (!m) continue;
        const mid = Number(m.slice(1, m.indexOf('@')));
        const p = m[0] === 'n' ? nodeLoc.get(mid) : undefined;
        const mb = m[0] === 'w' ? wayBox.get(mid) : p ? [p[0], p[1], p[0], p[1]] : undefined;
        if (!mb || !Number.isFinite(mb[0])) continue;
        b[0] = Math.min(b[0], mb[0]); b[1] = Math.min(b[1], mb[1]); b[2] = Math.max(b[2], mb[2]); b[3] = Math.max(b[3], mb[3]);
        if (words.length) { if (geom.length) geom.push(SEP / 1e7, SEP / 1e7); geom.push(...(m[0] === 'w' ? wayGeom.get(mid)! : p!)); }
      }
      // 部品が relation だけのもの（route_master など）は範囲がないので入れない
      if (!Number.isFinite(b[0])) { rows.rel_no_bounds++; continue; }
      addFeat('r', id, b, tags, words, geom, null);
    }
  }
  lap(`地物 ${rows.feat}（名前つき ${rows.named}、言葉 ${rows.word_rows}）`);

  // 4. 道の way のタグ（ルートの判定用）
  const insHw = db.prepare('INSERT INTO hw VALUES (?, ?)');
  for await (const line of lines(osmium, ['cat', hw, '-f', 'opl,add_metadata=false'])) {
    const f = fields(line);
    insHw.run(Number(f.w.slice(1)), JSON.stringify(pick(parseTags(f.T), HW_KEYS)));
    rows.hw++;
  }
  lap(`道 ${rows.hw}`);

  const insMeta = db.prepare('INSERT INTO meta VALUES (?, ?)');
  insMeta.run('osm_as_of', asOf);
  insMeta.run('dict', dictSignature());
  db.exec('COMMIT');
  db.exec('CREATE INDEX feat_osm ON feat(type, osm_id)');
  db.exec("INSERT INTO name_fts(name_fts) VALUES('optimize')");
  db.close();
  renameSync(tmp, out);
  rmSync(sel, { force: true });
  rmSync(hw, { force: true });
  const bytes = statSync(out).size;
  lap(`できあがり ${(bytes / 1e6).toFixed(0)} MB`);
  return { rows, bytes };
}
