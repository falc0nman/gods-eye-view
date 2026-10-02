/**
 * Velocity dealiasing and storm-relative velocity (GW-72) — SERVER-SIDE.
 *
 * Doppler velocity is measured modulo the Nyquist interval [−Vn, +Vn], so a
 * 30 m/s outbound wind seen with Vn = 24 m/s reads −18 m/s ("folded").
 *
 * Region-based unfolding, after the method in Py-ART's `dealias_region_based`
 * (Helmus & Collis 2016):
 *
 *   1. Split the Nyquist interval into a few bins and label connected gates
 *      (along the radial and between adjacent radials, wrapping in azimuth
 *      for a full sweep) whose folded velocities share a bin.
 *   2. For every pair of touching regions, sum the velocity differences
 *      across their shared boundary.
 *   3. Repeatedly take the pair with the longest shared boundary and shift
 *      the smaller region by the whole number of Nyquist intervals (2·Vn)
 *      that best closes the mean difference across it, then merge them.
 *   4. Each remaining connected echo is shifted, as a whole, by the number
 *      of intervals that best matches a reference field (the previous
 *      dealiased sweep at that tilt) where one overlaps it; otherwise so
 *      that its mean velocity lies inside [−Vn, +Vn].
 *
 * Without a reference, step 4 is the method's known limit: an echo whose
 * true mean velocity lies outside the Nyquist interval (a partial sweep
 * looking down a strong wind, an isolated cell) stays one interval off,
 * because nothing in the sweep says otherwise.
 * Pure: plain arrays in, plain arrays out.
 */

const DEFAULT_INTERVAL_SPLITS = 3;
const KT_PER_MS = 1.943844;

/** A binary max-heap of [count, a, b], ordered by count. */
function createHeap() {
  const items = [];
  const up = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (items[p][0] >= items[i][0]) break;
      [items[p], items[i]] = [items[i], items[p]];
      i = p;
    }
  };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < items.length && items[l][0] > items[m][0]) m = l;
      if (r < items.length && items[r][0] > items[m][0]) m = r;
      if (m === i) return;
      [items[m], items[i]] = [items[i], items[m]];
      i = m;
    }
  };
  return {
    push(item) {
      items.push(item);
      up(items.length - 1);
    },
    pop() {
      const top = items[0];
      const last = items.pop();
      if (items.length) {
        items[0] = last;
        down(0);
      }
      return top;
    },
    get size() {
      return items.length;
    },
  };
}

/**
 * Dealias one sweep.
 *
 * @param {object} sweep
 * @param {number} sweep.radials - radial count (rows), in azimuth order.
 * @param {number} sweep.gates - gates per radial (columns).
 * @param {Float32Array|number[]} sweep.velocity - folded m/s, row-major; NaN = no data.
 * @param {number} sweep.nyquist - Nyquist velocity, m/s.
 * @param {boolean} [sweep.wrap] - first and last radials are neighbours (full 360°).
 * @param {Float32Array|number[]} [sweep.reference] - dealiased m/s on the same
 *   grid (NaN where unknown), used to place each echo in the right interval.
 * @param {object} [options]
 * @param {number} [options.intervalSplits]
 * @returns {{velocity: Float32Array, unfolded: number, regions: number, referenced: number}}
 *   velocity is dealiased m/s (NaN where there was no data); unfolded counts
 *   gates moved by at least one Nyquist interval.
 */
export function dealiasSweep(
  { radials, gates, velocity, nyquist, wrap = false, reference = null },
  { intervalSplits = DEFAULT_INTERVAL_SPLITS, minReferenceGates = 20 } = {},
) {
  const n = radials * gates;
  const out = new Float32Array(n);
  if (!(nyquist > 0)) {
    for (let i = 0; i < n; i += 1) out[i] = velocity[i];
    return { velocity: out, unfolded: 0, regions: 0, referenced: 0 };
  }
  const interval = 2 * nyquist;
  const binWidth = interval / intervalSplits;
  const bin = (v) =>
    Math.min(
      intervalSplits - 1,
      Math.max(0, Math.floor((v + nyquist) / binWidth)),
    );

  // 1. Label connected same-bin gates (iterative flood fill).
  const label = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = new Int32Array(n);
  let regionCount = 0;
  // Neighbour in one direction (0: next gate, 1: previous gate, 2: next
  // radial, 3: previous radial), or −1. A single missing gate is bridged so
  // speckle does not cut an echo into fragments that unfold independently.
  const wraps = wrap && radials > 2;
  const step = (i, dir) => {
    const r = (i / gates) | 0;
    const g = i - r * gates;
    if (dir === 0) return g < gates - 1 ? i + 1 : -1;
    if (dir === 1) return g > 0 ? i - 1 : -1;
    if (dir === 2) return r < radials - 1 ? i + gates : wraps ? g : -1;
    return r > 0 ? i - gates : wraps ? (radials - 1) * gates + g : -1;
  };
  const near = (i, dir) => {
    const j = step(i, dir);
    if (j < 0 || !Number.isNaN(velocity[j])) return j;
    const k = step(j, dir);
    return k >= 0 && k !== i && !Number.isNaN(velocity[k]) ? k : -1;
  };
  const neighbours = (i, visit) => {
    for (let dir = 0; dir < 4; dir += 1) {
      const j = near(i, dir);
      if (j >= 0) visit(j);
    }
  };
  for (let start = 0; start < n; start += 1) {
    if (label[start] !== -1 || Number.isNaN(velocity[start])) continue;
    const id = regionCount;
    regionCount += 1;
    const b = bin(velocity[start]);
    let top = 0;
    let size = 0;
    stack[top++] = start;
    label[start] = id;
    while (top) {
      const i = stack[--top];
      size += 1;
      neighbours(i, (j) => {
        if (label[j] !== -1 || Number.isNaN(velocity[j])) return;
        if (bin(velocity[j]) !== b) return;
        label[j] = id;
        stack[top++] = j;
      });
    }
    sizes.push(size);
  }

  // 2. Boundary sums between touching regions: adj[a].get(b) = Σ(v_b − v_a).
  const adj = Array.from({ length: regionCount }, () => new Map());
  const addEdge = (a, b, diff) => {
    let e = adj[a].get(b);
    if (!e) {
      e = { sum: 0, count: 0 };
      adj[a].set(b, e);
    }
    e.sum += diff;
    e.count += 1;
  };
  for (let i = 0; i < n; i += 1) {
    const a = label[i];
    if (a < 0) continue;
    // Each undirected neighbour pair once: the next gate and the next radial.
    const pair = (j) => {
      const b = label[j];
      if (b < 0 || b === a) return;
      const diff = velocity[j] - velocity[i];
      addEdge(a, b, diff);
      addEdge(b, a, -diff);
    };
    // Forward directions only, so each neighbour pair is counted once.
    for (const dir of [0, 2]) {
      const j = near(i, dir);
      if (j >= 0) pair(j);
    }
  }

  // 3. Merge along the longest boundaries first.
  const shift = new Int32Array(regionCount); // Nyquist intervals per label
  const members = Array.from({ length: regionCount }, (_, k) => [k]);
  const alive = new Uint8Array(regionCount).fill(1);
  const heap = createHeap();
  for (let a = 0; a < regionCount; a += 1)
    for (const [b, e] of adj[a]) if (a < b) heap.push([e.count, a, b]);
  while (heap.size) {
    const [count, x, y] = heap.pop();
    if (!alive[x] || !alive[y]) continue;
    const edge = adj[x].get(y);
    if (!edge || edge.count !== count) continue; // stale entry
    // Shift the smaller region onto the larger.
    const [keep, move] = sizes[x] >= sizes[y] ? [x, y] : [y, x];
    const meanDiff = adj[keep].get(move).sum / count; // v_move − v_keep
    const k = Math.round(-meanDiff / interval);
    if (k !== 0) {
      for (const label of members[move]) shift[label] += k;
      // v_move rises by k·2Vn: Σ(v_c − v_move) falls, Σ(v_move − v_c) rises.
      for (const [c, e] of adj[move]) {
        e.sum -= k * interval * e.count;
        adj[c].get(move).sum += k * interval * e.count;
      }
    }
    // Fold `move`'s boundaries into `keep`.
    for (const [c, e] of adj[move]) {
      adj[c].delete(move);
      if (c === keep) continue;
      let ke = adj[keep].get(c);
      if (!ke) {
        ke = { sum: 0, count: 0 };
        adj[keep].set(c, ke);
      }
      ke.sum += e.sum;
      ke.count += e.count;
      let ce = adj[c].get(keep);
      if (!ce) {
        ce = { sum: 0, count: 0 };
        adj[c].set(keep, ce);
      }
      ce.sum -= e.sum;
      ce.count += e.count;
      heap.push([ke.count, Math.min(keep, c), Math.max(keep, c)]);
    }
    adj[keep].delete(move);
    adj[move].clear();
    alive[move] = 0;
    sizes[keep] += sizes[move];
    for (const label of members[move]) members[keep].push(label);
    members[move] = [];
  }

  // 4. Centre each remaining echo on the Nyquist interval.
  const rootOf = new Int32Array(regionCount);
  let regions = 0;
  for (let root = 0; root < regionCount; root += 1) {
    if (!alive[root]) continue;
    regions += 1;
    for (const l of members[root]) rootOf[l] = root;
  }
  const rootSum = new Float64Array(regionCount);
  const rootCount = new Float64Array(regionCount);
  const refSum = new Float64Array(regionCount);
  const refCount = new Float64Array(regionCount);
  for (let i = 0; i < n; i += 1) {
    const l = label[i];
    if (l < 0) continue;
    const v = velocity[i] + shift[l] * interval;
    rootSum[rootOf[l]] += v;
    rootCount[rootOf[l]] += 1;
    const ref = reference ? reference[i] : NaN;
    if (Number.isFinite(ref)) {
      refSum[rootOf[l]] += v - ref;
      refCount[rootOf[l]] += 1;
    }
  }
  let referenced = 0;
  for (let root = 0; root < regionCount; root += 1) {
    if (!alive[root] || !rootCount[root]) continue;
    const useReference = refCount[root] >= minReferenceGates;
    if (useReference) referenced += 1;
    const offset = useReference
      ? refSum[root] / refCount[root]
      : rootSum[root] / rootCount[root];
    const k = Math.round(-offset / interval);
    if (k !== 0) for (const l of members[root]) shift[l] += k;
  }

  let unfolded = 0;
  for (let i = 0; i < n; i += 1) {
    const l = label[i];
    if (l < 0) {
      out[i] = NaN;
      continue;
    }
    out[i] = velocity[i] + shift[l] * interval;
    if (shift[l] !== 0) unfolded += 1;
  }
  return { velocity: out, unfolded, regions, referenced };
}

/**
 * Storm motion as given by a forecaster or a warning: direction the storm
 * moves FROM (meteorological degrees) and speed in knots.
 */
export function parseStormMotion(text) {
  const m = /^\s*(\d{1,3}(?:\.\d+)?)\s*\/\s*(\d{1,3}(?:\.\d+)?)\s*$/.exec(
    String(text ?? ''),
  );
  if (!m) return null;
  const fromDeg = Number(m[1]);
  const speedKt = Number(m[2]);
  if (fromDeg > 360 || speedKt > 150) return null;
  return { fromDeg: fromDeg % 360, speedKt };
}

/**
 * The storm motion's component along a radar beam, m/s, positive away from
 * the radar (the Doppler sign convention).
 */
export function stormRadialComponent({ fromDeg, speedKt }, azimuthDeg) {
  const towardRad = (((fromDeg + 180) % 360) * Math.PI) / 180;
  return (
    (speedKt / KT_PER_MS) * Math.cos((azimuthDeg * Math.PI) / 180 - towardRad)
  );
}

/** Storm-relative velocity of one dealiased gate. */
export function stormRelative(velocity, motion, azimuthDeg) {
  return velocity - stormRadialComponent(motion, azimuthDeg);
}
