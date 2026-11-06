// 本物の録画がまだないときの確かめ用：ffmpeg の testsrc でダミーの録画と events.json を作る（~/kotozute-video/dummy/）。
// 結果の数字は 11/6 の記録（docs/plan.md §7）をまねた架空のもの。demo.html は events.dummy のとき画面に「ダミー」と出す。
// 使い方（docs/storyboard で）：node dummy-events.js → EVENTS=~/kotozute-video/dummy/events.json node render.js preview
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(process.env.HOME, 'kotozute-video', 'dummy');
fs.mkdirSync(DIR, { recursive: true });
const net = (self, anthropic) => ({ hosts: { '127.0.0.1': self, ...(anthropic ? { 'api.anthropic.com': anthropic } : {}) }, self, anthropic, other: 0 });
let refN = 1; // 参照はセッションの中で重ならない（品川は result:1）
const place = (name, kind, osm) => ({ ref: name === '品川' ? 'result:1' : `result:${++refN}`, name, coord: [139.74, 35.63], kind, ...(osm ? { osm } : {}) });
const check = (verdict, tunnels, minutes, km) => ({
  verdict, minutes, km, ways: 120, missing: 0, snapped: false, tunnels: [], lanes: { tagged_share: 0.9, untagged_runs: 0 },
  rows: [{ kind: 'tunnels', want: 2, got: tunnels, result: tunnels >= 2 ? 'pass' : 'fail' }, { kind: 'no_highways', want: null, got: 0, result: 'pass' }, { kind: 'minutes', want: 60, got: minutes, result: 'pass' }],
});
const step = (op, title, input, output, source = 'ai') => ({ op, title, source, input, ok: true, output });
const route = {
  from: place(null, 'here'), to: { ...place('東京都港区芝公園4丁目2', 'address'), ref: 'abr:1' }, legs: [],
  stops: [{ requested: 'post_office', chosen: place('泉岳寺駅前郵便局', 'post_office', 'node/1'), alternatives: [] },
    { requested: 'souvenir', chosen: place('文銭堂', 'souvenir', 'node/2'), alternatives: [] }],
  total: { minutes: 7.3, km: 3.65 }, direct: { minutes: 7.3, km: 3.65 }, extra_min: 0, avoid_highways: false, keep_order: true, tried: 16,
};
const results = {
  's1-chips': { ...step('find_features', '地物の絞り込み', { words: ['post_office'], area: 'view:' }, { area: { ref: 'view:', label: 'この画面の範囲', bbox: [139.72, 35.64, 139.77, 35.67], radius_m: null }, groups: [{ word: 'post_office', label: '郵便局', interpretation: '郵便局＝amenity=post_office', count: 43, items: [], truncated: false }] }, 'direct'), net: net(1, 0) },
  's2-view': { steps: [step('set_view', '地図の表示', { target: 'osm:way/1', show: ['post_office'], hide: ['souvenir'] }, { target: place('芝公園', 'park'), bbox: [139.74, 35.65, 139.76, 35.66], shown: ['post_office'], hidden: ['souvenir'] })], stop: 'done', net: net(2, 2) },
  's3-ex1': { steps: [
    step('geocode_address', '住所', { address: '港区芝公園4-2-8' }, { place: { ...place('東京都港区芝公園4丁目2', 'address'), ref: 'abr:1' }, input: '港区芝公園4-2-8', matched: '東京都港区芝公園4丁目2', unmatched: '-8', level: 'rsdtdsp_blk', precision: '街区の代表点' }),
    step('route', 'ルート', { from: 'here:', to: 'abr:1', stops: [{ ref: null, word: 'post_office' }, { ref: null, word: 'souvenir' }], keep_order: true, avoid_highways: false }, route),
    step('make_share_link', '共有リンク', {}, { id: 'dummy', url: 'http://127.0.0.1:8787/?s=dummy', includes_here: true }),
  ], stop: 'done', net: net(19, 4) },
  's4-feat': [
    { ...step('find_features', '地物の絞り込み', { words: ['level_crossing'], area: 'view:' }, { area: { ref: 'view:', label: 'この画面の範囲', bbox: [139.7312, 35.616, 139.7478, 35.625], radius_m: null }, groups: [{ word: 'level_crossing', label: '踏切', interpretation: '', count: 3, points: 8, items: [], truncated: false }] }, 'direct'), net: net(1, 0) },
    { ...step('find_features', '地物の絞り込み', { words: ['tunnel'], area: 'view:' }, { area: { ref: 'view:', label: 'この画面の範囲', bbox: [139.7312, 35.616, 139.7478, 35.625], radius_m: null }, groups: [{ word: 'tunnel', label: 'トンネル', interpretation: '', count: 3, items: [], truncated: false }] }, 'direct'), net: net(1, 0) },
  ],
  's4-ex2': { steps: [
    step('search_place', '場所の検索', { name: '品川駅', area: 'view:' }, { query: '品川駅', items: [place('品川', 'station', 'node/3')], total: 1, truncated: false, capped: false, widened: false }),
    step('plan_course', '試走コース', { start: 'result:1', tunnels: 2, max_minutes: 60, avoid_highways: true }, {
      start: place('品川', 'station', 'node/3'), conditions: { tunnels: 2, max_minutes: 60, avoid_highways: true }, radius_m: 5000, candidates: 12, excluded: 30,
      attempts: [
        { via: [{ ref: 'osm:way/10', name: '仙台坂トンネル', osm: 'way/10' }], minutes: 13.1, km: 6.1, check: check('fail', 1, 13.1, 6.1) },
        { via: [{ ref: 'osm:way/11', name: 'ふたばトンネル', osm: 'way/11' }, { ref: 'osm:way/10', name: '仙台坂トンネル', osm: 'way/10' }], minutes: 21.2, km: 9.75, check: check('pass', 2, 21.2, 9.75) },
      ], chosen: 1, stopped_by: null, routes: 2, course: route,
    }),
  ], stop: 'done', net: net(9, 3) },
  's4b-png': { ...step('export_png', '資料用の画像', {}, { mode: 'client' }, 'direct'), net: net(0, 0) },
  's5-recipe': { steps: [step('search_place', '場所の検索', {}, {}, 'recipe'), step('plan_course', '試走コース', {}, {}, 'recipe')], recipe: { id: 'dummy' }, net: net(8, 0) },
};
results['s5-adv'] = results['s4-ex2'];

// [id, 長さ（秒）, 印]
const CLIPS = [
  ['s1-chips', 6, { start: 0, sent: 1, answered: 1.6, done: 5.5 }],
  ['s2-view', 12, { start: 0, typed: 2.5, sent: 3, answered: 7.5, done: 11 }],
  ['s3-ex1', 34, { start: 0, typed: 9, sent: 9.5, answered: 16.5, done: 32 }],
  ['s3b-share', 8, { start: 0, done: 7 }],
  ['s4-feat', 10, { start: 0, done: 9 }],
  ['s4-ex2', 40, { start: 0, typed: 6, sent: 6.5, answered: 18, done: 36 }],
  ['s4b-png', 6, { start: 0, done: 5.5 }],
  ['s5-adv', 6, { start: 0, done: 5.5 }],
  ['s5-recipe', 10, { start: 0, sent: 2, answered: 4, done: 9 }],
  ['s6-app', 12, { start: 0, done: 11 }],
];
const clips = CLIPS.map(([id, dur, marks], i) => {
  const file = `${id}.webm`;
  // testsrc は経過秒を数字で描く。場面ごとに色の帯を変えて見分ける
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=1280x640:rate=25:duration=${dur}`,
    '-vf', `drawbox=x=0:y=560:w=1280:h=80:color=0x${['E4572E', '17BEBB', 'FFC914', '76B041', '2E282A', 'A23B72', 'F18F01', '3B1F2B', '6A4C93', '1982C4'][i]}:t=fill`,
    '-c:v', 'libvpx', '-b:v', '1M', path.join(DIR, file)]);
  return { id, file, duration_s: dur, marks: Object.entries(marks).map(([name, t]) => ({ name, t })) };
});
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1600x900:rate=1:duration=1', '-frames:v', '1', path.join(DIR, 's4b-png.png')]);
const events = { dummy: true, base: 'http://127.0.0.1:8787', recorded_at: new Date().toISOString(), viewport: { width: 1280, height: 640 }, clips, results };
fs.writeFileSync(path.join(DIR, 'events.json'), JSON.stringify(events, null, 1));
console.log('wrote', path.join(DIR, 'events.json'));
