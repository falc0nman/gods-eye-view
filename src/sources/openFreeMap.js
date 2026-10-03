import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { createVectorTileSource } from './vectorTiles.js';
import { tileToBBox } from '../data/tomtomTiles.js';

const ROAD_TYPES = Object.freeze({
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'residential',
});

/**
 * Surface traffic uses public motor-road classes only. Untyped service ways
 * include car parks and grounds access, so none are used as through traffic.
 * OpenMapTiles folds private access into `no`. Tunnels cannot be placed on
 * the surface above them; ramps/bridges remain valid only on a motor road.
 */
export function isDrivableOpenMapRoad(properties = {}) {
  return (
    Object.hasOwn(ROAD_TYPES, properties.class) &&
    !properties.subclass &&
    !properties.service &&
    ![
      'no',
      'private',
      'destination',
      'customers',
      'delivery',
      'agricultural',
      'forestry',
    ].includes(properties.access) &&
    properties.brunnel !== 'tunnel' &&
    !properties.indoor
  );
}

/** Translate public motor roads; reverse negative one-way geometry. */
export function openMapRoad(coordinates, properties = {}) {
  const type = ROAD_TYPES[properties.class];
  if (!isDrivableOpenMapRoad(properties) || coordinates.length < 2) return null;
  const reverse = Number(properties.oneway) === -1;
  return {
    coordinates: reverse ? coordinates.slice().reverse() : coordinates,
    type,
    drivable: true,
    roadClass: properties.class,
    roadProperties: { ...properties },
    oneway: reverse || Number(properties.oneway) === 1 ? 1 : 0,
    ramp: properties.ramp === 1,
    brunnel: properties.brunnel || null,
  };
}

/** Clip a line to its tile core so buffered copies never animate duplicate dots. */
export function clipTileLine(coords, box) {
  const lines = [];
  let line = [];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1],
      b = coords[i];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    let lo = 0,
      hi = 1;
    const p = [-dx, dx, -dy, dy],
      q = [
        a[0] - box.west,
        box.east - a[0],
        a[1] - box.south,
        box.north - a[1],
      ];
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) hi = -1;
      } else if (p[k] < 0) lo = Math.max(lo, q[k] / p[k]);
      else hi = Math.min(hi, q[k] / p[k]);
    }
    if (lo > hi) {
      if (line.length > 1) lines.push(line);
      line = [];
      continue;
    }
    const start = [a[0] + lo * dx, a[1] + lo * dy],
      end = [a[0] + hi * dx, a[1] + hi * dy];
    const last = line.at(-1);
    if (
      !last ||
      Math.abs(last[0] - start[0]) + Math.abs(last[1] - start[1]) > 1e-10
    ) {
      if (line.length > 1) lines.push(line);
      line = [start];
    }
    line.push(end);
  }
  if (line.length > 1) lines.push(line);
  return lines.filter((points) => {
    let metres = 0;
    for (let i = 1; i < points.length; i++)
      metres +=
        Math.hypot(
          (points[i][0] - points[i - 1][0]) *
            Math.cos((points[i][1] * Math.PI) / 180),
          points[i][1] - points[i - 1][1],
        ) * 111320;
    return metres >= 12;
  });
}

/** Decode drivable road lines from an OpenMapTiles tile. */
export function decodeOpenFreeMapTile(bytes, z, x, y) {
  const tile = new VectorTile(new PbfReader(bytes));
  const roads = [];
  const box = tileToBBox(z, x, y);
  const layer = tile.layers.transportation;
  if (layer) {
    if (layer.length > 40_000)
      throw new Error('Vector tile feature limit exceeded');
    for (let i = 0; i < layer.length; i++) {
      const props = layer.feature(i).properties;
      if (!isDrivableOpenMapRoad(props)) continue;
      const geometry = layer.feature(i).toGeoJSON(x, y, z).geometry;
      const lines =
        geometry.type === 'LineString'
          ? [geometry.coordinates]
          : geometry.type === 'MultiLineString'
            ? geometry.coordinates
            : [];
      for (const coords of lines)
        for (const clipped of clipTileLine(coords, box))
          roads.push(openMapRoad(clipped, props));
    }
  }
  return { roads };
}
/** Construct an immutable-version road tile source without starting I/O. */
export function createOpenFreeMapSource(options = {}) {
  return createVectorTileSource({
    tileJsonUrl: 'https://tiles.openfreemap.org/planet',
    allowedOrigin: 'https://tiles.openfreemap.org',
    decode: decodeOpenFreeMapTile,
    maxEntries: 192,
    maxCacheBytes: 64 * 1024 * 1024,
    ...options,
  });
}
