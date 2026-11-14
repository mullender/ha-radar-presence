// History analysis that guides zone drawing:
//  * dwell spots: where targets spend time (dwell grid -> clusters -> hull)
//  * trail analysis: do targets walk in and out of a spot (a person at a
//    desk) or appear and vanish in place (a plant, a fan, a reflection)?
//  * hull fitting with a signed margin (grow outward or shrink inward).
// Pure functions over the packed history payload (frames/history), no DOM.

import { pointInPolygon, signedDistance, polygonArea } from './engine.js';
import { lineIntersection } from './util.js';

const MAX_GAP_S = 5; // a target's dwell is the time to the next frame, capped
const BOUNCE_S = 3; // out and back in this fast = jitter across the edge, not a real exit

/** Index i of the edge poly[i] -> poly[i+1] closest to (x, y). */
export function nearestEdge(poly, x, y) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2));
    const d = Math.hypot(x - a[0] - k * dx, y - a[1] - k * dy);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Iterate frames: cb(i, t, targets[[slot,x,y]], available). Skips excluded targets. */
function forEachFrame(hist, exclusions, cb, { t0 = -Infinity, t1 = Infinity } = {}) {
  let p = 0;
  const targets = [];
  for (let i = 0; i < hist.frame_t.length; i++) {
    const n = hist.frame_n[i];
    const t = hist.frame_t[i];
    if (t < t0 || t > t1) { p += n; continue; }
    targets.length = 0;
    for (let k = 0; k < n; k++, p++) {
      const x = hist.x[p], y = hist.y[p];
      if (exclusions.some(z => pointInPolygon(x, y, z.polygon))) continue;
      targets.push([hist.slot[p], x, y]);
    }
    cb(i, t, targets, hist.frame_available ? hist.frame_available[i] === 1 : true);
  }
}

/** Seconds each 'cell'-sized square was occupied. Map key "cx,cy" -> seconds. */
export function dwellGrid(hist, { cell = 100, exclusions = [], window, inside = null } = {}) {
  const grid = new Map();
  const ft = hist.frame_t;
  forEachFrame(hist, exclusions, (i, t, targets, avail) => {
    if (!avail || !targets.length) return;
    const dt = Math.min((i + 1 < ft.length ? ft[i + 1] : t) - t, MAX_GAP_S);
    if (dt <= 0) return;
    for (const [, x, y] of targets) {
      if (inside && !pointInPolygon(x, y, inside)) continue;
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      grid.set(key, (grid.get(key) || 0) + dt);
    }
  }, window);
  return grid;
}

/** Andrew's monotone chain. Returns CCW hull without repeating the first point. */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Drop vertices whose turn is below minTurnDeg (nearly collinear). */
export function simplifyConvex(poly, minTurnDeg = 12) {
  let out = poly.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    let best = -1, bestTurn = Infinity;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
      const turn = Math.abs(((((a2 - a1) * 180) / Math.PI) + 540) % 360 - 180);
      if (turn < bestTurn) { bestTurn = turn; best = i; }
    }
    if (bestTurn < minTurnDeg) { out.splice(best, 1); changed = true; }
  }
  return out;
}

/**
 * Offset a convex polygon by `margin` mm (positive grows, negative shrinks).
 * Edges that vanish while shrinking are dropped; returns null if the polygon
 * collapses entirely.
 */
export function offsetConvex(poly, margin) {
  let pts = polygonArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
  if (pts.length < 3) return null;
  if (!margin) return pts.map(p => [Math.round(p[0]), Math.round(p[1])]);
  // Each edge as a line shifted along its outward normal (CCW: normal = (dy, -dx)).
  let lines = pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const n = [dy / len, -dx / len];
    return { p: [a[0] + n[0] * margin, a[1] + n[1] * margin], d: [dx / len, dy / len] };
  });
  for (let guard = 0; guard < 64; guard++) {
    if (lines.length < 3) return null;
    const verts = lines.map((l, i) => lineIntersection(lines[(i + lines.length - 1) % lines.length].p, lines[(i + lines.length - 1) % lines.length].d, l.p, l.d));
    if (verts.some(v => !v)) return null;
    // Edge i runs from verts[i] to verts[i+1] along lines[i]; flipped => vanished.
    const flipped = lines.map((l, i) => {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      return (b[0] - a[0]) * l.d[0] + (b[1] - a[1]) * l.d[1] < 0;
    });
    if (!flipped.some(Boolean)) {
      const out = verts.map(v => [Math.round(v[0]), Math.round(v[1])]);
      return polygonArea(out) > 1 ? out : null;
    }
    lines = lines.filter((_, i) => !flipped[i]);
  }
  return null;
}

/**
 * Reduce a convex polygon to at most maxVerts vertices by dropping edges and
 * extending their neighbours until they meet (the result still contains the
 * original). Picks the edge whose removal adds the least area each time.
 */
export function reduceConvex(poly, maxVerts = 8) {
  let pts = polygonArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
  while (pts.length > maxVerts) {
    const n = pts.length;
    let best = null;
    for (let i = 0; i < n; i++) {
      // Edge i = pts[i] -> pts[i+1]; extend edges i-1 and i+1 to meet.
      const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n], d = pts[(i + 2) % n];
      const v = lineIntersection(a, [b[0] - a[0], b[1] - a[1]], d, [c[0] - d[0], c[1] - d[1]]);
      if (!v) continue;
      // Must lie beyond b along a->b and beyond c along d->c (else the edges diverge).
      if ((v[0] - b[0]) * (b[0] - a[0]) + (v[1] - b[1]) * (b[1] - a[1]) < 0) continue;
      if ((v[0] - c[0]) * (c[0] - d[0]) + (v[1] - c[1]) * (c[1] - d[1]) < 0) continue;
      const added = Math.abs(polygonArea([b, v, c]));
      if (!best || added < best.added) best = { i, v, added };
    }
    if (!best) break;
    const { i, v } = best;
    const next = pts.slice();
    if (i + 1 < n) next.splice(i, 2, v);
    else { next.splice(i, 1, v); next.shift(); }
    pts = next;
  }
  return pts;
}

/** Hull around the dense cells of a grid, simplified. */
function hullOfCells(cells, cell) {
  const corners = [];
  for (const [cx, cy] of cells) {
    corners.push([cx * cell, cy * cell], [(cx + 1) * cell, cy * cell], [cx * cell, (cy + 1) * cell], [(cx + 1) * cell, (cy + 1) * cell]);
  }
  return reduceConvex(simplifyConvex(convexHull(corners)), 8);
}

/**
 * Dwell spots: 8-connected groups of cells where targets spent at least
 * minCellS seconds. Returns [{hull, dwell, cells, centroid}] by dwell desc.
 */
export function findDwellSpots(hist, { cell = 100, minCellS = null, exclusions = [], window, max = 6 } = {}) {
  const span = window ? Math.min(window.t1, hist.end - hist.start) - Math.max(0, window.t0) : hist.end - hist.start;
  const thr = minCellS ?? Math.max(3, Math.min(30, span / 5760)); // 48 h -> 30 s, 24 h -> 15 s, <= 5 h -> 3 s
  const grid = dwellGrid(hist, { cell, exclusions, window });
  const dense = new Map();
  for (const [k, v] of grid) if (v >= thr) dense.set(k, v);
  const seen = new Set();
  const spots = [];
  for (const start of dense.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [start], cells = [];
    let dwell = 0, sx = 0, sy = 0;
    while (stack.length) {
      const k = stack.pop();
      const [cx, cy] = k.split(',').map(Number);
      const w = dense.get(k);
      cells.push([cx, cy]);
      dwell += w; sx += (cx + 0.5) * cell * w; sy += (cy + 0.5) * cell * w;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const nk = `${cx + dx},${cy + dy}`;
        if (dense.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    if (cells.length < 3 || dwell < 10 * thr) continue;
    spots.push({ cells, dwell, centroid: [sx / dwell, sy / dwell], hull: hullOfCells(cells, cell) });
  }
  spots.sort((a, b) => b.dwell - a.dwell);
  return spots.slice(0, max);
}

/**
 * Hull around where targets dwelt inside `region` (e.g. a hand-drawn zone),
 * grown/shrunk by margin. Cells with < minCellS of dwell are ignored so a
 * single stray point does not stretch the hull.
 */
export function fitHull(hist, region, margin, { cell = 100, exclusions = [], window, minCellS = 2 } = {}) {
  const grid = dwellGrid(hist, { cell, exclusions, window, inside: region });
  const cells = [];
  for (const [k, v] of grid) if (v >= minCellS) cells.push(k.split(',').map(Number));
  if (cells.length < 1) return null;
  const hull = hullOfCells(cells, cell);
  return hull.length >= 3 ? offsetConvex(hull, margin) : null;
}

/**
 * How do targets come and go in a polygon? Follows each slot frame to frame
 * (with `hysteresis` mm so edge jitter is not a crossing) and groups activity
 * into occupancy episodes, linking a target that vanished inside to the next
 * one that appears (same logic as the engine's 'stay occupied until seen
 * leaving').
 */
export function trailStats(hist, poly, { exclusions = [], window, hysteresis = 100 } = {}) {
  const s = {
    walkIn: 0, walkOut: 0, appearIn: 0, vanishIn: 0,
    episodes: 0, startWalk: 0, startAppear: 0, endWalk: 0, endOther: 0,
    reappearIn: 0, reappearOut: 0, stillGaps: [],
    bounces: 0, edgeBounces: new Array(poly.length).fill(0), // out and back in within BOUNCE_S
  };
  const lastOut = new Map(); // slot -> {t, edge}
  let prev = new Map(); // slot -> inside
  let held = 0;
  let heldSince = [];
  let occupied = null; // unknown until the first frame
  forEachFrame(hist, exclusions, (i, t, targets, avail) => {
    if (!avail) { prev = new Map(); held = 0; heldSince = []; occupied = null; return; }
    const cur = new Map();
    let walkedIn = false, walkedOut = false;
    for (const [slot, x, y] of targets) {
      const was = prev.get(slot);
      let ins = pointInPolygon(x, y, poly);
      if (!ins && was && hysteresis > 0) ins = signedDistance(x, y, poly) > -hysteresis;
      cur.set(slot, ins);
      if (was === undefined) {
        if (held > 0) {
          held--;
          s.stillGaps.push(t - heldSince.shift());
          if (ins) s.reappearIn++; else s.reappearOut++;
        } else if (ins) s.appearIn++;
      } else if (ins !== was) {
        if (ins) {
          s.walkIn++; walkedIn = true;
          const lo = lastOut.get(slot);
          if (lo && t - lo.t <= BOUNCE_S) { s.bounces++; s.edgeBounces[lo.edge]++; }
        } else {
          s.walkOut++; walkedOut = true;
          lastOut.set(slot, { t, edge: nearestEdge(poly, x, y) });
        }
      }
    }
    for (const [slot, was] of prev) {
      if (!cur.has(slot) && was) { s.vanishIn++; held++; heldSince.push(t); }
    }
    prev = cur;
    let n = held;
    for (const v of cur.values()) if (v) n++;
    const occ = n > 0;
    if (occupied !== null && occ !== occupied) {
      if (occ) { s.episodes++; if (walkedIn) s.startWalk++; else s.startAppear++; }
      else if (walkedOut) s.endWalk++;
      else s.endOther++;
    }
    occupied = occ;
  }, window);
  return s;
}

/**
 * Real dwell spot vs ghost. People walk into a spot before they sit still in
 * it; a ghost (plant, fan, reflection) appears and vanishes in place.
 */
export function classify(stats) {
  const starts = stats.startWalk + stats.startAppear;
  if (starts < 3) return { kind: 'unknown', label: 'Not enough activity', share: null };
  const share = stats.startWalk / starts;
  if (share >= 0.5) return { kind: 'spot', label: 'Dwell spot', share };
  if (share <= 0.15) return { kind: 'ghost', label: 'Likely ghost', share };
  return { kind: 'mixed', label: 'Mixed', share };
}

/** Suggest 'stay occupied until seen leaving' when people often go still inside. */
export function suggestHold(stats) {
  const visits = stats.walkIn + stats.appearIn;
  if (visits < 5) return false;
  return stats.vanishIn / visits >= 0.2 && stats.reappearIn >= 2 * stats.reappearOut;
}

/**
 * A safe 'max hold' for a zone: 1.5x the longest time someone went still
 * there, rounded up to 5 min, between 15 min and 4 h.
 */
export function suggestMaxHold(stats) {
  const longest = stats.stillGaps.length ? Math.max(...stats.stillGaps) : 0;
  return Math.min(4 * 3600, Math.max(15 * 60, Math.ceil((1.5 * longest) / 300) * 300));
}

/** Edges where targets flap across (jitter): [{i, a, b, count}] worst first. */
export function flappingEdges(stats, poly, { min = 10, share = 0.05 } = {}) {
  const visits = stats.startWalk + stats.startAppear;
  const thr = Math.max(min, share * visits);
  return stats.edgeBounces
    .map((count, i) => ({ i, a: poly[i], b: poly[(i + 1) % poly.length], count }))
    .filter(e => e.count >= thr)
    .sort((x, y) => y.count - x.count);
}

export function percentile(values, q) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(q * v.length))];
}

// ------------------------------------------------------------------ doors

/** Door contact history rows ([[epoch_s, 'on'|'off'], ...]) -> state changes [{t, open}]. */
export function doorEvents(rows) {
  const out = [];
  let prev = null;
  for (const [t, s] of rows) {
    if (s !== 'on' && s !== 'off') { prev = null; continue; }
    if (prev !== null && s !== prev) out.push({ t, open: s === 'on' });
    prev = s;
  }
  return out;
}

/** [[open_t, close_t], ...] intervals for the timeline (epoch s), open at the end runs to `end`. */
export function doorIntervals(rows, end) {
  const iv = [];
  let open = null;
  for (const [t, s] of rows) {
    if (s === 'on' && open === null) open = t;
    else if (s !== 'on' && open !== null) { iv.push([open, t]); open = null; }
  }
  if (open !== null) iv.push([open, end]);
  return iv;
}

/**
 * Where targets are when a door opens or closes: the targets of the frame
 * nearest each event (within `tol` s). Whoever works a door stands at it, so
 * these points locate the door in the radar's frame, and the share of events
 * with someone there says whether the door is in view at all.
 * Returns {events, hits, points: [[x, y]]}.
 */
export function doorPositions(hist, events, { tol = 1.5, exclusions = [] } = {}) {
  const ft = hist.frame_t;
  const starts = new Array(ft.length + 1);
  let p = 0;
  for (let i = 0; i < ft.length; i++) { starts[i] = p; p += hist.frame_n[i]; }
  starts[ft.length] = p;
  let hits = 0;
  let considered = 0;
  const points = [];
  for (const ev of events) {
    const tRel = ev.t - hist.start;
    if (tRel < -tol || tRel > (hist.end - hist.start) + tol) continue;
    considered++;
    let lo = 0, hi = ft.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ft[mid] < tRel) lo = mid + 1; else hi = mid; }
    let best = -1;
    for (const j of [lo - 1, lo]) {
      if (j < 0 || j >= ft.length || Math.abs(ft[j] - tRel) > tol || !hist.frame_n[j]) continue;
      if (best < 0 || Math.abs(ft[j] - tRel) < Math.abs(ft[best] - tRel)) best = j;
    }
    if (best < 0) continue;
    const pts = [];
    for (let k = starts[best]; k < starts[best + 1]; k++) {
      const x = hist.x[k], y = hist.y[k];
      if (!exclusions.some(z => pointInPolygon(x, y, z.polygon))) pts.push([x, y]);
    }
    if (pts.length) { hits++; points.push(...pts); }
  }
  return { events: considered, hits, points };
}

/**
 * A small exit area around where people stand at a door: centred on the
 * densest spot of the door-event positions (people walking up from elsewhere
 * spread out, the door itself does not), keeping points within `radius`,
 * hulled and grown by `margin`; a `minSize` square when there is too little.
 */
export function placeExit(points, { margin = 150, minSize = 600, radius = 700, cell = 200, maxVerts = 8 } = {}) {
  if (!points.length) return null;
  const grid = new Map();
  const key = (i, j) => `${i},${j}`;
  for (const [x, y] of points) {
    const k = key(Math.floor(x / cell), Math.floor(y / cell));
    grid.set(k, (grid.get(k) || 0) + 1);
  }
  let best = null, bestN = -1;
  for (const k of grid.keys()) {
    const [i, j] = k.split(',').map(Number);
    let n = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) n += grid.get(key(i + di, j + dj)) || 0;
    if (n > bestN) { bestN = n; best = [i, j]; }
  }
  const block = points.filter(([x, y]) => Math.abs(Math.floor(x / cell) - best[0]) <= 1 && Math.abs(Math.floor(y / cell) - best[1]) <= 1);
  const med = a => percentile(a, 0.5);
  let cx = med(block.map(p => p[0])), cy = med(block.map(p => p[1]));
  const kept = points.filter(p => Math.hypot(p[0] - cx, p[1] - cy) <= radius);
  cx = med(kept.map(p => p[0])); cy = med(kept.map(p => p[1]));
  const square = () => {
    const h = minSize / 2;
    return [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
  };
  if (kept.length < 3) return square();
  const hull = convexHull(kept);
  if (hull.length < 3) return square();
  const small = Math.abs(polygonArea(hull)) < (minSize * minSize) / 4;
  const grown = offsetConvex(hull, small ? Math.max(margin, minSize / 3) : margin);
  return grown ? reduceConvex(simplifyConvex(grown), maxVerts) : square();
}
