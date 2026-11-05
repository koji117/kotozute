// 例2：試走コース「来週の客先試走。品川駅を出て、トンネルを2本通り、高速は使わず60分以内。」
// 絵コンテ用の実データを作る。使い方（docs/storyboard で）：node data/build-ex2.js → data/ex2.json
// 使うのは手元のサービスだけ：Overpass（:12345）と Valhalla（:8002）。
const fs = require('fs');
const path = require('path');

const OVERPASS = 'http://localhost:12345/api/interpreter';
const VALHALLA = 'http://localhost:8002';
const PROMPT = '来週の客先試走。品川駅を出て、トンネルを2本通り、高速は使わず60分以内。';
const START = [139.7385, 35.6290]; // 品川駅 高輪口の前。ここから出てここに戻る（周回）
const RADIUS_M = 6000;             // トンネルを探す半径
const MAX_MIN = 60;
const MIN_TUNNEL_M = 50;           // これより短いトンネルは経由地の候補にしない
const MERGE_GAP_M = 50;            // lanes なしの区間の間が 50m 未満なら1つにまとめる
const SCENE_BBOX = [139.7312, 35.6160, 139.7478, 35.6250]; // (b) の場面：京急 北品川〜新馬場（西,南,東,北）約1.5km×1km
const COSTING = { auto: { exclude_highways: true, exclude_tolls: true } }; // 高速と有料道路はハード除外
const ROADS = 'trunk|primary|secondary|tertiary|unclassified|residential';
const FOOT_ONLY = /^(footway|path|pedestrian|steps|cycleway|bridleway|corridor)$/;
const notes = [];
const fact = t => notes.push({ type: 'fact', text: t });
const choice = t => notes.push({ type: 'choice', text: t });

// ---- 小さな道具 ----
const r6 = v => Math.round(v * 1e6) / 1e6;
const pt = (lng, lat) => [r6(lng), r6(lat)];
const km2 = m => Math.round(m / 10) / 100;          // m → km（小数2桁）
const min1 = s => Math.round(s / 6) / 10;           // 秒 → 分（小数1桁）
function dist(a, b) { // [lng,lat] 2点の距離（m）
  const R = 6371e3, r = Math.PI / 180;
  const x = (b[0] - a[0]) * r * Math.cos((a[1] + b[1]) / 2 * r), y = (b[1] - a[1]) * r;
  return R * Math.hypot(x, y);
}
const lineLen = cs => cs.slice(1).reduce((s, c, i) => s + dist(cs[i], c), 0);
function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function midOf(cs) { // 線の長さの真ん中の点と、そこでの向き
  let half = lineLen(cs) / 2;
  for (let i = 1; i < cs.length; i++) {
    const d = dist(cs[i - 1], cs[i]);
    if (d >= half) { const t = d ? half / d : 0; return { coord: pt(cs[i - 1][0] + (cs[i][0] - cs[i - 1][0]) * t, cs[i - 1][1] + (cs[i][1] - cs[i - 1][1]) * t), heading: Math.round(bearing(cs[i - 1], cs[i])) }; }
    half -= d;
  }
  return { coord: pt(...cs[0]), heading: 0 };
}
function decode6(s) { // polyline6 → [[lng,lat]]
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < s.length) {
    for (const k of [0, 1]) {
      let sh = 0, res = 0, b;
      do { b = s.charCodeAt(i++) - 63; res |= (b & 31) << sh; sh += 5; } while (b >= 32);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push([r6(lng / 1e6), r6(lat / 1e6)]);
  }
  return out;
}
const inBox = (c, b) => c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3];
const uniq = a => [...new Set(a.filter(Boolean))];

async function overpass(q) {
  const r = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }) });
  if (!r.ok) throw new Error('Overpass ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return r.json();
}
async function valhalla(p, body) {
  const r = await fetch(VALHALLA + p, { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error('Valhalla ' + p + ' ' + JSON.stringify(j)), { j });
  return j;
}
const wayGeom = w => w.geometry.map(g => pt(g.lon, g.lat));
const tunnelName = t => t['tunnel:name'] || t.name || null;
const tunnelNamed = t => !!t['tunnel:name'] || /トンネル|隧道|地下道/.test(t.name || '');

// ---- ルートを引き、trace_attributes で辺ごとの属性を取る ----
let usedSnapFallback = false;
async function traceLeg(enc) {
  const body = {
    encoded_polyline: enc, shape_format: 'polyline6', costing: 'auto', costing_options: COSTING, shape_match: 'edge_walk',
    filters: { action: 'include', attributes: ['shape', 'edge.tunnel', 'edge.way_id', 'edge.names', 'edge.length', 'edge.road_class', 'edge.toll', 'edge.lane_count', 'edge.begin_shape_index', 'edge.end_shape_index'] },
  };
  try { return await valhalla('/trace_attributes', body); }
  catch { usedSnapFallback = true; return valhalla('/trace_attributes', { ...body, shape_match: 'walk_or_snap' }); }
}
// vias：[{ coord, heading, layer }]。経由地は break_through（区間を分けるが U ターンはしない）
async function course(vias) {
  const loc = (c, type) => ({ lon: c[0], lat: c[1], type });
  const locations = [loc(START, 'break'), ...vias.map(v => ({ ...loc(v.coord, 'break_through'), heading: v.heading, heading_tolerance: 45, preferred_layer: v.layer })), loc(START, 'break')];
  const r = await valhalla('/route', { locations, costing: 'auto', costing_options: COSTING, directions_type: 'none', shape_format: 'polyline6' });
  const coords = [], edges = [];
  for (const leg of r.trip.legs) { // 区間をつなぐ。前の区間の終点＝次の区間の始点なので1点落とす
    const t = await traceLeg(leg.shape);
    const sh = decode6(t.shape);
    const off = coords.length ? coords.length - 1 : 0;
    coords.push(...(coords.length ? sh.slice(1) : sh));
    for (const e of t.edges) edges.push({ ...e, b: e.begin_shape_index + off, e: e.end_shape_index + off, m: e.length * 1000 });
  }
  return { r, coords, edges, minutes: min1(r.trip.summary.time), km: Math.round(r.trip.summary.length * 100) / 100, tunnelRuns: runsBy(edges, e => e.tunnel) };
}
function runsBy(edges, pred) { // 条件を満たす辺が続く区間（連）
  const runs = []; let cur = null;
  edges.forEach((e, i) => { if (pred(e)) { if (!cur) runs.push(cur = []); cur.push(i); } else cur = null; });
  return runs;
}
// 目当てのトンネル（way）が、それぞれ別の連に1つずつ入っていて、連の数も同じなら合格
function hits(c, targets) {
  if (c.tunnelRuns.length !== targets.length) return false;
  const runOf = id => c.tunnelRuns.findIndex(run => run.some(i => c.edges[i].way_id === id));
  const idx = targets.map(t => runOf(t.osm));
  return idx.every(i => i >= 0) && new Set(idx).size === idx.length;
}
const viasOf = cand => cand.headings.map(h => ({ coord: cand.mid, heading: h, layer: cand.layer, cand }));

(async () => {
  const t0 = Date.now();
  // ---- 1. 出発地（JR 品川駅）----
  const st = await overpass(`[out:json][timeout:25];node(around:400,${START[1]},${START[0]})[railway=station][name="品川"][operator="東日本旅客鉄道"];out body;`);
  const dataTime = st.osm3s.timestamp_osm_base;
  const stn = st.elements[0];
  const snap = (await valhalla('/locate', { locations: [{ lon: START[0], lat: START[1] }], costing: 'auto', verbose: true }))[0].edges[0];
  const status = await (await fetch(VALHALLA + '/status')).json();

  // ---- 2. 品川駅から 6km 以内の道路トンネル ----
  const tq = await overpass(`[out:json][timeout:60];way(around:${RADIUS_M},${START[1]},${START[0]})[tunnel=yes][highway~"^(${ROADS})$"];out tags geom;`);
  const excluded = [];
  const tunnels = [];
  for (const w of tq.elements) {
    const t = w.tags, cs = wayGeom(w), len = lineLen(cs);
    const id = 'way/' + w.id;
    const why = t.toll === 'yes' ? '有料（toll=yes）'
      : t.highway === 'trunk' && (t.motorroad === 'yes' || /首都高|高速|自動車道/.test((t.name || '') + (t['tunnel:name'] || ''))) ? 'trunk だが自動車専用・高速の扱い'
      : ['no', 'private'].includes(t.motor_vehicle) || (['no', 'private'].includes(t.access) && t.motor_vehicle !== 'yes') ? '車は通行不可'
      : parseFloat(t.maxheight) < 2.1 ? `高さ制限 ${t.maxheight}m`
      : null;
    if (why) { excluded.push({ id, name: tunnelName(t), highway: t.highway, reason: why }); continue; }
    const m = midOf(cs);
    const oneway = t.oneway === 'yes' ? 1 : t.oneway === '-1' ? -1 : 0;
    tunnels.push({
      id, osm: w.id, name: t.name || null, tunnel_name: t['tunnel:name'] || null, highway: t.highway, ref: t.ref || null,
      length_km: km2(len), lanes: t.lanes || null, oneway: t.oneway || null, maxheight: t.maxheight || null,
      distance_km: km2(dist(START, m.coord)), mid: m.coord, layer: parseInt(t.layer || '-1', 10),
      headings: oneway === 1 ? [m.heading] : oneway === -1 ? [(m.heading + 180) % 360] : [m.heading, (m.heading + 180) % 360],
      named: tunnelNamed(t), coordinates: cs, _len: len, _t: t,
    });
  }
  // 候補の順番：トンネル名がある → 長い
  const cands = tunnels.filter(c => (c.name || c.tunnel_name) && c._len >= MIN_TUNNEL_M)
    .sort((a, b) => (b.named - a.named) || (b._len - a._len));
  fact(`Overpass（データ時点 ${dataTime}）：品川駅から半径${RADIUS_M / 1000}km、tunnel=yes かつ highway=${ROADS.replace(/\|/g, '/')} の way は ${tq.elements.length} 本。除外 ${excluded.length} 本、残り ${tunnels.length} 本。`);
  choice(`motorway・motorway_link・*_link は検索の段階で外した。trunk は toll=yes・motorroad=yes・名前に「首都高/高速/自動車道」があれば外す（国道357号の東京港トンネル一般部は toll なし・motorroad なしなので残る）。高さ制限 2.1m 未満と車両通行不可も外す。`);
  choice(`経由地の候補は、名前（name か tunnel:name）があり ${MIN_TUNNEL_M}m 以上の way ${cands.length} 本。順番は「トンネル名（tunnel:name か名前に トンネル/隧道/地下道）がある」→「長い」。`);

  // ---- 3. 試行1：トンネル1本だけを通る周回 ----
  let a1 = null;
  for (const c of cands) {
    for (const v of viasOf(c)) {
      const k = await course([v]).catch(() => null);
      if (k && hits(k, [c]) && k.minutes <= MAX_MIN) { a1 = { k, vias: [v], targets: [c] }; break; }
    }
    if (a1) break;
  }
  if (!a1) throw new Error('試行1：トンネル1本だけの周回が見つからない');
  const t1 = a1.targets[0];
  choice(`試行1のトンネルは候補の順番で最初に「トンネルがちょうど1本」になった ${tunnelName(t1._t)}（${t1.id}、${t1.headings.length === 1 ? '一方通行の向き' : '向きは試した中で最初に通ったもの'}）。経由地は way の長さの真ん中、heading ±45°、layer=${t1.layer} で寄せた。`);

  // ---- 4. 試行2：2本目を足して60分以内 ----
  const ok2 = [];
  let tried = 0;
  for (const c of cands) {
    if (tunnelName(c._t) === tunnelName(t1._t) || dist(c.mid, t1.mid) < 500) continue; // 同じトンネルの反対車線は数えない
    for (const v of viasOf(c)) for (const order of [[a1.vias[0], v], [v, a1.vias[0]]]) {
      tried++;
      const k = await course(order).catch(() => null);
      if (k && k.minutes <= MAX_MIN && hits(k, [t1, c])) ok2.push({ k, vias: order, targets: order.map(o => o.cand), c });
    }
  }
  ok2.sort((a, b) => (b.c.named - a.c.named) || (a.k.minutes - b.k.minutes));
  if (!ok2.length) throw new Error('試行2：条件を満たすコースがない');
  const a2 = ok2[0];
  choice(`試行2は2本目の候補を全部試した（${tried} 通り、経由の順番と向きを含む）。条件（トンネルの連がちょうど2つで目当ての2本、高速・有料なし、${MAX_MIN}分以内）を満たしたのは ${ok2.length} 通り。その中で「トンネル名がある」→「所要時間が短い」で選んだ。`);

  // ---- 5. 辺の way の生のタグを Overpass で取り直す ----
  const wayIds = uniq([...a1.k.edges, ...a2.k.edges].map(e => e.way_id));
  const wq = await overpass(`[out:json][timeout:60];way(id:${wayIds.join(',')});out tags;`);
  const tags = new Map(wq.elements.map(w => [w.id, w.tags]));

  const runOut = (k, run) => {
    const es = run.map(i => k.edges[i]);
    const ids = uniq(es.map(e => e.way_id));
    return {
      way_ids: ids.map(i => 'way/' + i),
      names: uniq(ids.map(i => tunnelName(tags.get(i) || {}))),
      road_names: uniq(ids.map(i => (tags.get(i) || {}).name)),
      length_km: km2(es.reduce((s, e) => s + e.m, 0)),
      from_start_km: km2(k.edges.slice(0, run[0]).reduce((s, e) => s + e.m, 0)),
      coordinates: k.coords.slice(es[0].b, es[es.length - 1].e + 1),
    };
  };
  const roadsOf = k => { // 通る道の名前の並び（同じ名前が続けば1つ、0.2km 未満は省く）
    const seq = [];
    for (const e of k.edges) {
      const n = (tags.get(e.way_id) || {}).name || null;
      const last = seq[seq.length - 1];
      if (last && last.name === n) last.m += e.m; else seq.push({ name: n, m: e.m });
    }
    return seq.filter(x => x.name && x.m >= 200).map(x => ({ name: x.name, km: km2(x.m) }));
  };
  const attemptOut = (label, a) => {
    const runs = a.k.tunnelRuns.map(run => runOut(a.k, run));
    return {
      label,
      via: a.vias.map(v => ({ tunnel: v.cand.id, name: tunnelName(v.cand._t), coord: v.coord, heading: v.heading })),
      minutes: a.k.minutes, km: a.k.km,
      tunnel_count: runs.length,
      meets: { tunnels_2: runs.length === 2, within_60min: a.k.minutes <= MAX_MIN, no_motorway: !a.k.edges.some(e => e.road_class === 'motorway'), no_toll: !a.k.edges.some(e => e.toll) },
      tunnel_runs: runs,
      roads: roadsOf(a.k),
      shape: a.k.coords,
    };
  };
  for (const [label, a] of [['試行1', a1], ['試行2', a2]]) { // Valhalla の tunnel と生の tunnel タグの食い違い
    const off = a.k.edges.filter(e => !e.tunnel && (tags.get(e.way_id) || {}).tunnel);
    const on = a.k.edges.filter(e => e.tunnel && !(tags.get(e.way_id) || {}).tunnel);
    fact(`${label}：生のタグに tunnel があるのに edge.tunnel=false の辺 ${off.length}（${uniq(off.map(e => 'way/' + e.way_id + ' tunnel=' + tags.get(e.way_id).tunnel)).join('、') || 'なし'}）、逆は ${on.length}。`);
  }
  const att1 = attemptOut('試行1：トンネル1本', a1);
  const att2 = attemptOut('試行2：トンネル2本', a2);
  const seen = new Set([tunnelName(a2.c._t)]); // 別解は2本目のトンネルごとに一番速いものだけ
  att2.alternatives = ok2.filter(o => !seen.has(tunnelName(o.c._t)) && seen.add(tunnelName(o.c._t))).slice(0, 3).map(o => ({ second_tunnel: o.c.id, name: tunnelName(o.c._t), order: o.vias.map(v => tunnelName(v.cand._t)), minutes: o.k.minutes, km: o.k.km }));

  // ---- 6. 車線数の判定（試行2）：lanes タグがない way が続く区間 ----
  const k2 = a2.k;
  const hasLanes = e => 'lanes' in (tags.get(e.way_id) || {});
  let noRuns = runsBy(k2.edges, e => !hasLanes(e));
  const runLen = (a, b) => k2.edges.slice(a, b + 1).reduce((s, e) => s + e.m, 0);
  const merged = [];
  for (const r of noRuns) { // 間の lanes ありの区間が 50m 未満ならつなぐ
    const prev = merged[merged.length - 1];
    if (prev && runLen(prev[prev.length - 1] + 1, r[0] - 1) < MERGE_GAP_M) for (let i = prev[prev.length - 1] + 1; i <= r[r.length - 1]; i++) prev.push(i);
    else merged.push([...r]);
  }
  const total = k2.edges.reduce((s, e) => s + e.m, 0);
  const tagged = k2.edges.filter(hasLanes).reduce((s, e) => s + e.m, 0);
  const valhallaFilled = k2.edges.filter(e => !hasLanes(e) && e.lane_count != null);
  const lanesCheck = {
    route: att2.label,
    no_lanes_runs_raw: noRuns.length,
    no_lanes_runs: merged.length,
    merge_gap_m: MERGE_GAP_M,
    lanes_tagged_km: km2(tagged), total_km: km2(total),
    lanes_tagged_share: Math.round(tagged / total * 1000) / 1000,
    no_lanes_km: km2(total - tagged),
    valhalla_lane_count_without_tag: { edges: valhallaFilled.length, km: km2(valhallaFilled.reduce((s, e) => s + e.m, 0)) },
    runs: merged.map(run => runOut(k2, run)),
  };
  fact(`試行2の ${k2.edges.length} 辺（way ${uniq(k2.edges.map(e => e.way_id)).length} 本）の生のタグを Overpass で取り直した。lanes タグがある区間は ${lanesCheck.lanes_tagged_km}km / ${lanesCheck.total_km}km（${Math.round(lanesCheck.lanes_tagged_share * 1000) / 10}%）。`);
  fact(`lanes タグがない辺が続く区間は ${noRuns.length} か所、間が ${MERGE_GAP_M}m 未満のものをまとめると ${merged.length} か所（＝判定不能）。そのうち Valhalla の lane_count には値が入っている辺が ${valhallaFilled.length} 辺ある（タグがなくても値が入る）。`);
  choice(`「lanes がある」は way に lanes キーがあること（lanes:forward などだけの way は「ない」扱い）。まとめるのは「間の短い区間」だけで、短い lanes なし区間そのものは消していない。`);

  // ---- 7. (b) の場面：踏切と道路トンネル ----
  const [W, S, E, N] = SCENE_BBOX;
  const sq = await overpass(`[out:json][timeout:60];node(${S},${W},${N},${E})[railway~"^(level_crossing|crossing)$"]->.x;.x out body;way(bn.x);out body;way(${S},${W},${N},${E})[tunnel=yes][highway~"^(${ROADS})(_link)?$"];out body geom;`);
  const xs = sq.elements.filter(e => e.type === 'node');
  const parents = sq.elements.filter(e => e.type === 'way' && !e.geometry); // 踏切を通る way（座標なし）
  const sceneTunnels = sq.elements.filter(e => e.type === 'way' && e.geometry);
  const crossings = [], crossingsEx = [];
  for (const n of xs) {
    const roads = parents.filter(w => w.tags.highway && w.nodes.includes(n.id));
    const rail = parents.find(w => w.tags.railway && w.nodes.includes(n.id));
    const o = { id: 'node/' + n.id, name: n.tags.name || null, coord: pt(n.lon, n.lat), railway: n.tags.railway, line: rail ? rail.tags.name || null : null, roads: roads.map(w => ({ id: 'way/' + w.id, highway: w.tags.highway, name: w.tags.name || null })), barrier: n.tags['crossing:barrier'] || null };
    const why = n.tags.railway === 'crossing' ? 'railway=crossing（歩行者用の踏切）'
      : roads.length && roads.every(w => FOOT_ONLY.test(w.tags.highway)) ? '通る道が歩行者・自転車用だけ'
      : n.tags.motor_vehicle === 'no' || n.tags.vehicle === 'no' ? '車両通行不可のタグ' : null;
    (why ? crossingsEx : crossings).push(why ? { ...o, reason: why } : o);
  }
  // 1つの踏切が線路と車線の数だけ点に分かれているので、名前（なければ 40m 以内）でまとめる
  const groups = [];
  for (const c of crossings) {
    const g = groups.find(g => (c.name && g.name === c.name) || (!c.name && !g.name && dist(g.coord, c.coord) < 40));
    if (g) g.nodes.push(c.id); else groups.push({ name: c.name, coord: c.coord, line: c.line, nodes: [c.id] });
  }
  // 端点を共有する way は同じトンネルの続きとみなしてまとめる
  const tGroups = [];
  for (const w of sceneTunnels) {
    const ends = [w.nodes[0], w.nodes[w.nodes.length - 1]];
    const hit = tGroups.filter(g => ends.some(n => g.ends.has(n)));
    const g = { ways: ['way/' + w.id], names: [tunnelName(w.tags)], ends: new Set(ends) };
    for (const h of hit) { g.ways.push(...h.ways); g.names.push(...h.names); h.ends.forEach(n => g.ends.add(n)); tGroups.splice(tGroups.indexOf(h), 1); }
    tGroups.push(g);
  }
  const tunOut = sceneTunnels.map(w => ({ id: 'way/' + w.id, name: tunnelName(w.tags), road_name: w.tags.name || null, highway: w.tags.highway, length_km: km2(lineLen(wayGeom(w))), lanes: w.tags.lanes || null, coordinates: wayGeom(w) }));
  const scene = {
    bbox: SCENE_BBOX,
    size_km: [km2(dist([W, (S + N) / 2], [E, (S + N) / 2])), km2(dist([W, S], [W, N]))],
    level_crossings: crossings, level_crossing_nodes: crossings.length,
    level_crossing_groups: groups, level_crossing_count: groups.length,
    excluded_crossings: crossingsEx,
    road_tunnels: tunOut, road_tunnel_ways: tunOut.length,
    road_tunnel_groups: tGroups.map(g => ({ ways: g.ways, names: uniq(g.names) })), road_tunnel_count: tGroups.length,
    course2_passes_bbox: k2.coords.some(c => inBox(c, SCENE_BBOX)),
    course2_km_in_bbox: km2(k2.edges.filter(e => inBox(k2.coords[e.b], SCENE_BBOX) && inBox(k2.coords[e.e], SCENE_BBOX)).reduce((s, e) => s + e.m, 0)),
  };
  choice(`(b) の場面の範囲は京急 北品川〜新馬場の線路沿い（品川駅のすぐ南）。踏切はノード（railway=level_crossing と railway=crossing）を取り、歩行者用を除いた。道路トンネルは highway=${ROADS.replace(/\|/g, '/')} とその *_link（motorway は入れない）。`);
  fact(`(b) の範囲：踏切ノード ${crossings.length} 点（踏切としては ${groups.length} か所：${groups.map(g => g.name || '名前なし').join('、')}）、除外 ${crossingsEx.length} 点。道路トンネルの way ${tunOut.length} 本（端点でつながるものをまとめると ${tGroups.length} か所）。試行2のコースはこの範囲を${scene.course2_passes_bbox ? `通る（${scene.course2_km_in_bbox}km）` : '通らない'}。`);

  // ---- 8. まとめと出力 ----
  const all = [START, ...att1.shape, ...att2.shape, [W, S], [E, N]];
  const pad = 0.003;
  const bbox = [r6(Math.min(...all.map(c => c[0])) - pad), r6(Math.min(...all.map(c => c[1])) - pad), r6(Math.max(...all.map(c => c[0])) + pad), r6(Math.max(...all.map(c => c[1])) + pad)];
  fact(`Valhalla ${status.version}：試行1 ${att1.minutes}分・${att1.km}km・トンネル ${att1.tunnel_count} 本（${att1.tunnel_runs.map(r => r.names.join('/')).join('、')}）。試行2 ${att2.minutes}分・${att2.km}km・トンネル ${att2.tunnel_count} 本（${att2.tunnel_runs.map(r => r.names.join('/')).join('、')}）。どちらも motorway と有料の辺は 0。`);
  fact('トンネルは trace_attributes の edge.tunnel が true の辺が続く区間を1本と数えた。時間は Valhalla の推定（このビルドに渋滞データが入っているかは未確認）。');
  fact(`出発・到着点 ${JSON.stringify(START)} は Valhalla で ${(snap.edge_info.names || []).join('/')}（way/${snap.edge_info.way_id}）に ${Math.round(snap.distance)}m 寄せられた。周回（品川駅に戻る）で条件を満たせた。`);
  if (usedSnapFallback) fact('一部の区間で edge_walk が失敗し、walk_or_snap で取り直した。');
  choice('周回だと trace_attributes の edge_walk が失敗したので、経由地を break_through にして区間ごとに取り、つなぎ直した。');

  const out = {
    key: 'ex2', prompt: PROMPT, generated_at: new Date().toISOString(), data_time: dataTime, generated_by: 'data/build-ex2.js',
    services: { overpass: OVERPASS, valhalla: VALHALLA, valhalla_version: status.version },
    conditions: { tunnels: 2, exclude_highways: true, exclude_tolls: true, max_minutes: MAX_MIN, loop: true },
    start: {
      station: { id: 'node/' + stn.id, name: stn.tags.name, operator: stn.tags.operator, coord: pt(stn.lon, stn.lat) },
      route_point: START,
      snapped: { coord: pt(snap.correlated_lon, snap.correlated_lat), way: 'way/' + snap.edge_info.way_id, names: snap.edge_info.names || [] },
    },
    tunnel_candidates: tunnels.sort((a, b) => a._len - b._len).reverse().map(({ osm, _len, _t, headings, layer, named, coordinates, ...c }) => c),
    excluded_tunnels: excluded,
    attempts: [att1, att2],
    lanes_check: lanesCheck,
    scene_b: scene,
    bbox,
    notes,
  };
  fs.writeFileSync(path.join(__dirname, 'ex2.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ sec: Math.round((Date.now() - t0) / 1000), a1: [att1.minutes, att1.km, att1.tunnel_runs.map(r => r.names)], a2: [att2.minutes, att2.km, att2.tunnel_runs.map(r => r.names)], alts: att2.alternatives, lanes: [lanesCheck.no_lanes_runs_raw, lanesCheck.no_lanes_runs, lanesCheck.lanes_tagged_share], scene: [groups.length, crossings.length, crossingsEx.length, tunOut.length, tGroups.length, scene.course2_passes_bbox] }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
