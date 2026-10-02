import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNwsWarningsLayer,
  formatStormMotion,
  normalizeWarnings,
  parseStormMotion,
  vtecEventKey,
  warningAnchor,
  warningLabel,
} from './nwsWarnings.js';

const NOW = Date.parse('2026-10-02T00:30:00Z');
const RING = [[-97.9, 28.1], [-97.6, 28.1], [-97.6, 27.8], [-97.9, 27.8], [-97.9, 28.1]];

function warning({
  event = 'Severe Thunderstorm Warning',
  vtec = '/O.NEW.KCRP.SV.W.0077.261002T0021Z-261002T0115Z/',
  sent = '2026-10-02T00:21:00Z',
  ends = '2026-10-02T01:15:00Z',
  messageType = 'Alert',
  geometry = { type: 'Polygon', coordinates: [RING] },
  parameters = {},
} = {}) {
  return {
    id: `https://api.weather.gov/alerts/${vtec}${sent}`,
    geometry,
    properties: {
      event, sent, ends, expires: ends, messageType,
      senderName: 'NWS Corpus Christi TX',
      parameters: { VTEC: [vtec], ...parameters },
    },
  };
}

test('VTEC key identifies the event across issuance and continuation', () => {
  assert.equal(vtecEventKey('/O.NEW.KCRP.SV.W.0077.261002T0021Z-261002T0115Z/'), 'KCRP.SV.W.0077');
  assert.equal(vtecEventKey('/O.CON.KCRP.SV.W.0077.000000T0000Z-261002T0115Z/'), 'KCRP.SV.W.0077');
  assert.equal(vtecEventKey('garbage'), null);
});

test('storm motion parses the TIME...MOT...LOC line; direction is FROM', () => {
  const motion = parseStormMotion('2026-10-02T00:20:00-00:00...storm...253DEG...23KT...28.05,-97.87 27.93,-97.79');
  assert.equal(motion.fromDeg, 253);
  assert.equal(motion.speedKt, 23);
  assert.deepEqual(motion.points, [{ lat: 28.05, lon: -97.87 }, { lat: 27.93, lon: -97.79 }]);
  assert.equal(formatStormMotion(motion), '→ ENE 26 mph');
  assert.equal(formatStormMotion({ fromDeg: 0, speedKt: 0 }), 'stationary');
  assert.equal(parseStormMotion('nonsense'), null);
});

test('only supported, polygon-bearing, unexpired, uncancelled warnings survive', () => {
  const out = normalizeWarnings({
    features: [
      warning(),
      warning({ event: 'Tornado Watch', vtec: '/O.NEW.KWNS.TO.A.0500.261002T0000Z-261002T0600Z/' }),
      warning({ vtec: '/O.NEW.KCRP.SV.W.0078.x/', geometry: null }),
      warning({ vtec: '/O.NEW.KCRP.SV.W.0079.x/', ends: '2026-10-02T00:10:00Z' }),
      warning({ vtec: '/O.CAN.KCRP.SV.W.0080.x/', messageType: 'Cancel' }),
    ],
  }, NOW);
  assert.deepEqual(out.map((w) => w.key), ['KCRP.SV.W.0077']);
});

test('the newest message per event wins, so an updated polygon replaces the old one', () => {
  const shrunk = [[-97.8, 28.0], [-97.7, 28.0], [-97.7, 27.9], [-97.8, 28.0]];
  const out = normalizeWarnings({
    features: [
      warning({ vtec: '/O.CON.KCRP.SV.W.0077.x/', sent: '2026-10-02T00:40:00Z', geometry: { type: 'Polygon', coordinates: [shrunk] } }),
      warning(),
    ],
  }, NOW);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].rings[0], shrunk);
});

test('tornado emergencies outrank tornadoes, which outrank severe and flood warnings', () => {
  const out = normalizeWarnings({
    features: [
      warning({ event: 'Flash Flood Warning', vtec: '/O.NEW.KFWD.FF.W.0001.x/' }),
      warning(),
      warning({ event: 'Tornado Warning', vtec: '/O.NEW.KOUN.TO.W.0010.x/', parameters: { tornadoDetection: ['RADAR INDICATED'] } }),
      warning({
        event: 'Tornado Warning',
        vtec: '/O.NEW.KOUN.TO.W.0011.x/',
        parameters: { tornadoDetection: ['OBSERVED'], tornadoDamageThreat: ['CATASTROPHIC'] },
      }),
    ],
  }, NOW);
  assert.deepEqual(out.map((w) => w.code), ['TOR', 'TOR', 'SVR', 'FFW']);
  assert.equal(out[0].emergency, true);
  assert.deepEqual(out[0].tags, ['OBSERVED', 'TORNADO EMERGENCY']);
});

test('label carries threats, motion and expiry; anchor is the storm position', () => {
  const [w] = normalizeWarnings({
    features: [warning({
      parameters: {
        maxWindGust: ['70 MPH'],
        maxHailSize: ['1.75'],
        thunderstormDamageThreat: ['CONSIDERABLE'],
        eventMotionDescription: ['2026-10-02T00:20:00-00:00...storm...253DEG...23KT...28.05,-97.87'],
      },
    })],
  }, NOW);
  assert.deepEqual(warningLabel(w), {
    title: 'SVR',
    details: ['70 mph · 1.75" hail · CONSIDERABLE · → ENE 26 mph · until 01:15Z'],
  });
  assert.deepEqual(warningAnchor(w), { lat: 28.05, lon: -97.87 });
});

test('anchor falls back to the polygon centre when no storm position is given', () => {
  const [w] = normalizeWarnings({ features: [warning()] }, NOW);
  const anchor = warningAnchor(w);
  assert.ok(Math.abs(anchor.lon - -97.75) < 1e-9 && Math.abs(anchor.lat - 27.95) < 1e-9);
});

test('a quiet day reads as a normal empty state, a failed fetch as an error', async () => {
  let response = { ok: true, status: 200, json: async () => ({ features: [] }) };
  const layer = createNwsWarningsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    fetchImpl: async () => response,
    now: () => NOW,
  });
  const viewer = { dataSources: { add() {}, remove() {} } };
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.equal(layer.getStats().status, 'empty');
  assert.equal(layer.getStats().loadingLabel, 'no warnings in force');

  response = { ok: false, status: 503, json: async () => null };
  assert.equal(await layer.update(viewer), false);
  assert.equal(layer.getStats().error, 'NWS HTTP 503');
});
