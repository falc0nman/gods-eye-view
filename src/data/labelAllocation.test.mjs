import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAllocationStrategy } from './labelAllocation.js';

test('allocation strategy defaults safely to Elastic', () => {
  assert.equal(normalizeAllocationStrategy('weighted'), 'WEIGHTED');
  assert.equal(normalizeAllocationStrategy('elastic'), 'ELASTIC');
  assert.equal(normalizeAllocationStrategy('unknown'), 'ELASTIC');
});
