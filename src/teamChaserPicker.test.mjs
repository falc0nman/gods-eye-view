import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickerErrorText, selectionPayload } from './teamChaserPicker.js';

const ROSTER = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('everyone ticked saves "everyone", so later joiners show automatically', () => {
  assert.deepEqual(selectionPayload(ROSTER, new Set(['a', 'b', 'c'])), { ids: [] });
});

test('a partial pick saves exactly those ids; nobody ticked saves nothing', () => {
  assert.deepEqual(selectionPayload(ROSTER, new Set(['c', 'a', 'stale'])), { ids: ['a', 'c'] });
  assert.equal(selectionPayload(ROSTER, new Set()), null);
});

test('errors read as instructions, not status codes', () => {
  assert.match(pickerErrorText(403, { error: 'x' }), /machine running the server/);
  assert.match(pickerErrorText(200, { configured: false }), /LIFE360_TOKEN/);
  assert.equal(pickerErrorText(409, { error: 'No roster yet' }), 'No roster yet');
});
