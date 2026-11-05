// 例1のルートの曲がり方（右左折の案内）を、自前の Valhalla から日本語で取る → data/ex1-steps.json
// 使い方（docs/storyboard で）：node data/build-ex1-steps.js（先に build-ex1.js を実行しておく）
const fs = require('fs');
const ex1 = JSON.parse(fs.readFileSync('data/ex1.json', 'utf8'));
const pts = [ex1.here.coord, ...ex1.chosen.stops.map((s) => s.coord), ex1.destination.pin];
(async () => {
  const body = { locations: pts.map(([lon, lat]) => ({ lat, lon })), costing: 'auto', language: 'ja-JP', units: 'kilometers' };
  const r = await (await fetch('http://localhost:8002/route', { method: 'POST', body: JSON.stringify(body) })).json();
  if (!r.trip) throw new Error(JSON.stringify(r));
  const legs = r.trip.legs.map((l) => ({
    minutes: Math.round(l.summary.time / 6) / 10, km: Math.round(l.summary.length * 100) / 100,
    steps: l.maneuvers.map((m) => ({ type: m.type, instruction: m.instruction, street: m.street_names ?? [], km: Math.round(m.length * 100) / 100, minutes: Math.round(m.time / 6) / 10 })),
  }));
  const out = { generated_at: new Date().toISOString(), language: 'ja-JP', source: 'Valhalla /route（自前、:8002）', legs };
  fs.writeFileSync('data/ex1-steps.json', JSON.stringify(out, null, 1));
  for (const [i, l] of legs.entries()) { console.log(`--- 区間${i + 1} ${l.minutes}分 ${l.km}km`); for (const s of l.steps) console.log(`  [${s.type}] ${s.instruction} (${s.km}km) ${s.street.join('/')}`); }
})();
