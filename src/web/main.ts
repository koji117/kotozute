import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { attributionHtml } from '../attribution';

maplibregl.addProtocol('pmtiles', new Protocol().tile);
const origin = location.origin;

export const map = new maplibregl.Map({
  container: 'map',
  center: [139.767, 35.681],
  zoom: 11,
  maxBounds: [[138.9, 35.48], [139.95, 35.92]], // tokyo.pmtiles の切り出し範囲
  attributionControl: false,
  canvasContextAttributes: { preserveDrawingBuffer: true }, // 画像の書き出しに必要
  style: {
    version: 8,
    glyphs: `${origin}/assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/assets/sprites/v4/light`,
    sources: { protomaps: { type: 'vector', url: `pmtiles://${origin}/tiles/tokyo.pmtiles` } },
    // landcover は ESA WorldCover（CC BY 4.0）由来なので外す
    layers: layers('protomaps', namedFlavor('light'), { lang: 'ja' })
      .filter(l => !('source-layer' in l && l['source-layer'] === 'landcover')),
  },
});
map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: attributionHtml() }));
map.addControl(new maplibregl.NavigationControl(), 'top-right');
