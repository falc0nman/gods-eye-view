/**
 * @module labelAllocation
 * @description Label-allocation strategies for the shared world-overlay label
 * arbiter.
 */

export const ALLOCATION_ELASTIC = 'ELASTIC';
export const ALLOCATION_WEIGHTED = 'WEIGHTED';
export const ALLOCATION_STRATEGIES = Object.freeze([
  ALLOCATION_ELASTIC,
  ALLOCATION_WEIGHTED,
]);

/** Normalize the user-selectable layer allocation strategy. */
export function normalizeAllocationStrategy(
  strategy,
  fallback = ALLOCATION_ELASTIC,
) {
  const raw = String(strategy || '')
    .trim()
    .toUpperCase();
  if (ALLOCATION_STRATEGIES.includes(raw)) return raw;
  const normalizedFallback = String(fallback || '')
    .trim()
    .toUpperCase();
  return ALLOCATION_STRATEGIES.includes(normalizedFallback)
    ? normalizedFallback
    : ALLOCATION_ELASTIC;
}
