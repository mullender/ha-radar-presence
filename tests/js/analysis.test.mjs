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

test('edge through a sitting spot is reported as flapping', async () => {
  const { flappingEdges } = await import('../../custom_components/radar_zone_presence/frontend/analysis.js');
  seed = 3;
  // Someone sits at x ~ 0 jittering +-60 mm; the zone's right edge is x = 0.
  const track = [];
  for (let i = 0; i < 2000; i++) track.push([rnd() * 120, 3000 + rnd() * 120]);
  const hist = pack(framesOf([track]));
  const box = [[-1000, 2500], [0, 2500], [0, 3500], [-1000, 3500]];
  const st = trailStats(hist, box, { hysteresis: 0 });
  const flaps = flappingEdges(st, box);
  assert.equal(flaps[0].i, 1); // edge [0,2500] -> [0,3500]
  assert.ok(flaps[0].count > 100);
  // An edge margin (hysteresis) larger than the jitter removes the flapping.
  assert.equal(flappingEdges(trailStats(hist, box, { hysteresis: 150 }), box).length, 0);
});

test('door events locate the door: positions at open/close, stray targets dropped', async () => {
  const { doorEvents, doorIntervals, doorPositions, placeExit } = await import('../../custom_components/radar_zone_presence/frontend/analysis.js');
  // Door at (-1200, 1700). Someone stands there for each open and close; a second
  // person sits at (1500, 3000) the whole time; one event has nobody at the door.
  const frames = [];
  const rows = [[0, 'off']];
  for (let k = 0; k < 10; k++) {
    const t = 100 + k * 60;
    for (let s = -3; s <= 3; s += 0.5) {
      const targets = [[2, 1500 + rnd() * 100, 3000 + rnd() * 100]];
      if (k < 9) targets.push([1, -1200 + rnd() * 300, 1700 + rnd() * 300]);
      frames.push([t + s, targets]);
      frames.push([t + 10 + s, k < 9 ? [[1, -1200 + rnd() * 300, 1700 + rnd() * 300]] : [[2, 1500, 3000]]]);
    }
    rows.push([t, 'on'], [t + 10, 'off']);
  }
  frames.sort((a, b) => a[0] - b[0]);
  const hist = pack(frames);
  const evs = doorEvents(rows);
  assert.equal(evs.length, 20);
  assert.deepEqual(doorIntervals([[0, 'off'], [5, 'on'], [9, 'off'], [12, 'on']], 20), [[5, 9], [12, 20]]);
  const pos = doorPositions(hist, evs);
  assert.equal(pos.events, 20);
  assert.equal(pos.hits, 20, 'every event has someone in view (the sitter counts too)');
  const poly = placeExit(pos.points);
  assert.ok(pointInPolygon(-1200, 1700, poly), 'exit covers the door');
  assert.ok(!pointInPolygon(1500, 3000, poly), 'the sitter elsewhere is not part of the exit');
  assert.ok(poly.length <= 8);
  assert.ok(Math.abs(polygonArea(poly)) < 2.5e6, 'a small area, not the room');
});

test('two radars seeing the same person: rotation, offset and handedness are recovered', async () => {
  const { pairDetections, registerRigid, viewToMatch } = await import('../../custom_components/radar_zone_presence/frontend/analysis.js');
  for (const truth of [{ ang: -156, reflect: false, t: [2300, 5450] }, { ang: 62, reflect: true, t: [-1500, 3000] }]) {
    const a = (truth.ang * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const toA = ([x, y]) => { const u = truth.reflect ? -x : x; return [c * u - s * y + truth.t[0], s * u + c * y + truth.t[1]]; };
    const fa = [], fb = [];
    for (let k = 0; k < 600; k++) {
      const t = k * 0.6;
      const q = [rnd() * 5000, 600 + (rnd() + 0.5) * 4000];
      const p = k % 10 < 3 ? [rnd() * 6000, 3000 + rnd() * 3000] : toA(q); // 30% the radars see different people
      fa.push([t, [[1, p[0] + rnd() * 150, p[1] + rnd() * 150]]]);
      fb.push([t + 0.05, [[1, q[0] + rnd() * 150, q[1] + rnd() * 150]]]);
    }
    const pairs = pairDetections(pack(fa), pack(fb));
    assert.ok(pairs.length > 500);
    const reg = registerRigid(pairs);
    assert.equal(reg.reflect, truth.reflect);
    assert.ok(Math.abs(((reg.angleDeg - truth.ang + 540) % 360) - 180) < 2, `angle ${reg.angleDeg} vs ${truth.ang}`);
    assert.ok(Math.hypot(reg.t[0] - truth.t[0], reg.t[1] - truth.t[1]) < 150);
    assert.ok(reg.inliers / reg.n > 0.6 && reg.rms < 250);
    // B's view then shows a direction the same way A's view does.
    const refDisplay = { rotation: 30, mirror: true };
    const view = viewToMatch(refDisplay, reg);
    const disp = (d, [x, y]) => { const u = d.mirror ? -x : x; const r = (d.rotation * Math.PI) / 180; return [u * Math.cos(r) - y * Math.sin(r), u * Math.sin(r) + y * Math.cos(r)]; };
    const q0 = [0, 0], q1 = [1000, 2000];
    const pa = [toA(q0), toA(q1)].map(p => disp(refDisplay, p));
    const pb = [q0, q1].map(q => disp(view, q));
    const da = [pa[1][0] - pa[0][0], pa[1][1] - pa[0][1]], db = [pb[1][0] - pb[0][0], pb[1][1] - pb[0][1]];
    assert.ok(Math.hypot(da[0] - db[0], da[1] - db[1]) < 60, `views agree: ${da} vs ${db}`);
  }
});
