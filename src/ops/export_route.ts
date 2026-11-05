// ルートの書き出し：いま地図にあるルートを GPX 1.1 か GeoJSON にする。社内確認用で、出典・ライセンス・データ時点を中に入れる。
import { z } from 'zod';
import { defineOp, OpError, type ExportRouteOutput, type Place, type RouteOutput } from './types';
import { ATTRIBUTION, attributionParts, ODBL, OSM_DATA_AS_OF } from '../attribution';

export const ROUTE_EXPORT_WARNING = '社内確認用。社外に渡すときは ODbL の条件（出典の表示、改変したデータベースの共有）に注意してください';

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const exportRoute = defineOp({
  name: 'export_route',
  title: 'ルートの書き出し',
  description:
    'いま地図にあるルートを GPX か GeoJSON のファイルに書き出す（社内確認用。出典とライセンスの注意つき）。' +
    '「GPXで」「ファイルで欲しい」と頼まれたときに使う。ルートがなければ先に route で引く。',
  input: z.object({
    format: z.enum(['gpx', 'geojson']).describe('ファイルの形式'),
  }),
  direct: true,
  async run({ session }, { format }): Promise<ExportRouteOutput> {
    const r = session.route;
    if (!r) throw new OpError('not_found', '書き出すルートがありません。先にルートを引いてください');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const content = format === 'gpx' ? gpx(r) : geojson(r);
    return {
      filename: `kotozute-route-${stamp}.${format}`,
      mime: format === 'gpx' ? 'application/gpx+xml' : 'application/geo+json',
      content,
      warning: ROUTE_EXPORT_WARNING,
    };
  },
  llm: (o) => ({ filename: o.filename, size: Buffer.byteLength(o.content) }),
});

/** 出発・寄り道・目的地の場所と名前（名前は区間の名前と同じもの） */
function points(r: RouteOutput) {
  const places: Place[] = [r.from, ...r.stops.map((s) => s.chosen), r.to];
  const names = [r.legs[0].from, ...r.legs.map((l) => l.to)];
  const roles = places.map((_, i) => (i === 0 ? '出発' : i === places.length - 1 ? '目的地' : `寄り道${i}`));
  return places.map((p, i) => ({ coord: p.coord, name: names[i], role: roles[i] }));
}

/** 地図のタイル（Protomaps）は入らないので除く。住所の座標を使ったときは ABR も入れる */
function credits(r: RouteOutput) {
  const address = [r.from, r.to, ...r.stops.map((s) => s.chosen)].some((p) => p.kind === 'address');
  return attributionParts({ route: true, address }).filter((p) => p !== ATTRIBUTION.protomaps);
}

const title = (pts: ReturnType<typeof points>) => `ルート：${pts[0].name} → ${pts[pts.length - 1].name}`;

function gpx(r: RouteOutput): string {
  const pts = points(r);
  const desc = [...credits(r).map((p) => p.text), ODBL.text, `OSMデータ時点：${OSM_DATA_AS_OF}`, ROUTE_EXPORT_WARNING].join(' | ');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="kotozute" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${xml(title(pts))}</name><desc>${xml(desc)}</desc>`,
    `<copyright author="OpenStreetMap contributors"><year>${OSM_DATA_AS_OF.slice(0, 4)}</year><license>${ODBL.url}</license></copyright>`,
    `<link href="${ATTRIBUTION.osm.url}"><text>${xml(ATTRIBUTION.osm.text)}</text></link>`,
    `<time>${new Date().toISOString()}</time></metadata>`,
    ...pts.map((p) => `<wpt lat="${p.coord[1]}" lon="${p.coord[0]}"><name>${xml(p.name)}</name><type>${p.role}</type></wpt>`),
    `<trk><name>${xml(title(pts))}</name>`,
    ...r.legs.map((l) => `<trkseg>${l.shape.map(([x, y]) => `<trkpt lat="${y}" lon="${x}"/>`).join('')}</trkseg>`),
    '</trk>',
    '</gpx>',
    '',
  ].join('\n');
}

function geojson(r: RouteOutput): string {
  const pts = points(r);
  return JSON.stringify({
    type: 'FeatureCollection',
    name: title(pts),
    attribution: credits(r).map((p) => p.text).join(' | '),
    attribution_url: ATTRIBUTION.osm.url,
    license: ODBL.id,
    license_url: ODBL.url,
    osm_data_as_of: OSM_DATA_AS_OF,
    warning: ROUTE_EXPORT_WARNING,
    features: [
      ...r.legs.map((l, i) => ({
        type: 'Feature', properties: { kind: 'leg', leg: i + 1, from: l.from, to: l.to, minutes: l.minutes, km: l.km },
        geometry: { type: 'LineString', coordinates: l.shape },
      })),
      ...pts.map((p) => ({ type: 'Feature', properties: { kind: p.role, name: p.name }, geometry: { type: 'Point', coordinates: p.coord } })),
    ],
  });
}
