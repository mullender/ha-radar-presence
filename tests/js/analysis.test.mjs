// Synthetic checks for frontend/analysis.js (dwell spots, hulls, ghost vs spot).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convexHull, offsetConvex, reduceConvex, findDwellSpots, fitHull, trailStats, classify, suggestHold,
} from '../../custom_components/radar_zone_presence/frontend/analysis.js';
import { polygonArea, pointInPolygon } from '../../custom_components/radar_zone_presence/frontend/engine.js';

/** Build a packed history from frames [[t, [[slot, x, y], ...]], ...]. */
function pack(frames) {
  const h = { start: 0, end: frames.at(-1)[0], frame_t: [], frame_n: [], frame_available: [], slot: [], x: [], y: [] };
  for (const [t, targets] of frames) {
    h.frame_t.push(t); h.frame_n.push(targets.length); h.frame_available.push(1);
    for (const [s, x, y] of targets) { h.slot.push(s); h.x.push(x); h.y.push(y); }
  }
  return h;
}

let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;

/** Timeline of one slot on a 0.5 s grid: array index = step, value = [x, y] or null. */
function personTrack(visits, sitS, vanishEvery = 2) {
  const out = [];
  const walk = (a, b) => { for (let k = 0; k <= 20; k++) out.push([a[0] + (b[0] - a[0]) * k / 20, a[1] + (b[1] - a[1]) * k / 20]); };
  for (let v = 0; v < visits; v++) {
    walk([2000, 500], [-1500, 3000]); // from the door to the desk
    const steps = sitS * 2;
    for (let s = 0; s < steps; s++) {
      // Sitting still: the radar sometimes loses the target for a while.
      const lost = v % vanishEvery === 0 && s > steps / 3 && s < (2 * steps) / 3;
      out.push(lost ? null : [-1500 + rnd() * 150, 3000 + rnd() * 150]);
    }
    walk([-1500, 3000], [2000, 500]);
    for (let s = 0; s < 60; s++) out.push(null); // out of the room
  }
  return out;
}

/** A ghost blinks in and out of existence at a fixed spot with no trail. */
function ghostTrack(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < 40; s++) out.push([1500 + rnd() * 100, 4000 + rnd() * 100]);
    for (let s = 0; s < 120; s++) out.push(null);
  }
  return out;
}

/** Merge slot tracks into frames (every step lists all present targets). */
function framesOf(tracks) {
  const len = Math.max(...tracks.map(t => t.length));
  const frames = [];
  for (let i = 0; i < len; i++) {
    const targets = [];
    tracks.forEach((tr, k) => { const p = tr[i]; if (p) targets.push([k + 1, p[0], p[1]]); });
    frames.push([i * 0.5, targets]);
  }
  return frames;
}

test('convex hull and offset', () => {
  const sq = convexHull([[0, 0], [100, 0], [100, 100], [0, 100], [50, 50]]);
  assert.equal(sq.length, 4);
  const grown = offsetConvex(sq, 10);
  assert.ok(Math.abs(polygonArea(grown) - 120 * 120) < 1);
  const shrunk = offsetConvex(sq, -20);
  assert.ok(Math.abs(polygonArea(shrunk) - 60 * 60) < 1);
  assert.equal(offsetConvex(sq, -60), null); // collapses
});

test('inward offset drops vanishing edges instead of self-intersecting', () => {
  // A long thin hexagon with two short end edges.
  const hex = [[0, 0], [1000, 0], [1020, 50], [1000, 100], [0, 100], [-20, 50]];
  const shrunk = offsetConvex(hex, -40);
  assert.ok(shrunk && shrunk.length >= 3);
  assert.ok(polygonArea(shrunk) > 0);
  for (const p of shrunk) assert.ok(pointInPolygon(p[0], p[1], hex) || p[1] >= 0);
});

test('reduceConvex keeps containment', () => {
  const circle = Array.from({ length: 24 }, (_, i) => [1000 * Math.cos((i * Math.PI) / 12), 1000 * Math.sin((i * Math.PI) / 12)]);
  const r = reduceConvex(circle, 8);
  assert.equal(r.length, 8);
  for (const p of circle) assert.ok(pointInPolygon(p[0] * 0.999, p[1] * 0.999, r));
});

test('desk visited by walking in is a dwell spot; blinking ghost is a ghost', () => {
  seed = 7;
  const frames = framesOf([personTrack(6, 120), ghostTrack(12)]);
  const hist = pack(frames);
  const spots = findDwellSpots(hist, { minCellS: 3 });
  assert.ok(spots.length >= 2, `found ${spots.length} spots`);
  const desk = spots.find(s => Math.hypot(s.centroid[0] + 1500, s.centroid[1] - 3000) < 300);
  const gh = spots.find(s => Math.hypot(s.centroid[0] - 1500, s.centroid[1] - 4000) < 300);
  assert.ok(desk && gh);
  const deskStats = trailStats(hist, offsetConvex(desk.hull, 300));
  const ghostStats = trailStats(hist, offsetConvex(gh.hull, 300));
  assert.equal(classify(deskStats).kind, 'spot');
  assert.equal(classify(ghostStats).kind, 'ghost');
  assert.equal(deskStats.startWalk, 6, JSON.stringify({ ...deskStats, stillGaps: deskStats.stillGaps.length }));
  assert.equal(deskStats.endWalk, 6);
  // Went still three times; a ghost appearing elsewhere can release a held occupant early.
  assert.equal(deskStats.vanishIn, 3);
  assert.equal(deskStats.reappearIn + deskStats.reappearOut, 3);
  const alone = pack(framesOf([personTrack(6, 120)]));
  const aloneStats = trailStats(alone, offsetConvex(desk.hull, 300));
  assert.equal(aloneStats.reappearIn, 3);
  assert.ok(suggestHold(aloneStats));
  // Fit to points: a loose hand-drawn box around the desk shrinks to the cloud + margin.
  const loose = [[-3000, 2000], [0, 2000], [0, 4000], [-3000, 4000]];
  const fitted = fitHull(hist, loose, 100);
  assert.ok(Math.abs(polygonArea(fitted)) < Math.abs(polygonArea(loose)) / 4);
  assert.ok(pointInPolygon(-1500, 3000, fitted));
});
