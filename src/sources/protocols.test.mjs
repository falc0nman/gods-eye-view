import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeedType, isVideoFeedType } from './cctvTypes.js';
import { isValidTileCoord } from '../data/tomtomTiles.js';

test('camera aliases remain separate from player support decisions', () => {
  for (const [input, expected] of [
    ['JPEG', 'image'],
    ['mjpg', 'mjpeg'],
    ['video', 'mp4'],
    ['stream', 'hls'],
    ['', 'image'],
    ['other', 'other'],
  ]) {
    assert.equal(normalizeFeedType(input), expected);
  }
  assert.equal(isVideoFeedType('mjpeg'), false);
  assert.equal(isVideoFeedType('hls'), true);
});

test('XYZ math preserves traffic bounds while allowing explicit source bounds', () => {
  assert.equal(isValidTileCoord(7, 0, 0), false);
  assert.equal(isValidTileCoord(17, 0, 0), false);
  assert.equal(isValidTileCoord(8, 255, 255), true);
  assert.equal(isValidTileCoord(8, 256, 0), false);
  const bounds = { minZoom: 0, maxZoom: 22 };
  assert.equal(isValidTileCoord(0, 0, 0, bounds), true);
  assert.equal(isValidTileCoord(22, 2 ** 22 - 1, 0, bounds), true);
  assert.equal(isValidTileCoord(23, 0, 0, bounds), false);
  assert.equal(isValidTileCoord(4, 1.5, 0, bounds), false);
  assert.equal(isValidTileCoord(4, 0, 0, { minZoom: 5, maxZoom: 2 }), false);
});
