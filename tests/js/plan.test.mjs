import test from 'node:test';
import assert from 'node:assert/strict';
import { centroid, planFor, ownRoom } from '../../custom_components/radar_zone_presence/frontend/plan.js';

test('centroid: the centre of an L-shaped room lies by its area, not its corner count', () => {
  assert.deepEqual(centroid([[0, 0], [2, 0], [2, 2], [0, 2]]), [1, 1]);
  const [x, y] = centroid([[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]);
  assert.ok(Math.abs(x - y) < 1e-9 && x > 1 && x < 1.5);
});

test('planFor: the map holding most of a floor’s rooms, and only with two or more', () => {
  const room = area => ({ kind: 'include', area, polygon: [] });
  const a = { anchor: 'a', shapes: [room('kitchen'), room('living'), room('living'), { kind: 'exit', area: null }] };
  const b = { anchor: 'b', shapes: [room('hall')] };
  const p = planFor([a, b], new Set(['kitchen', 'living', 'hall']));
  assert.equal(p.map.anchor, 'a');
  assert.deepEqual([...p.areas].sort(), ['kitchen', 'living']);
  assert.equal(planFor([b], new Set(['hall'])), null);
  assert.equal(planFor([a], new Set(['bedroom'])), null);
});

test('spotLike: a small room shape inside a room is a spot in all but name', async () => {
  const { spotLike } = await import('../../custom_components/radar_zone_presence/frontend/plan.js');
  const room = { id: 'room', kind: 'include', polygon: [[-3000, 0], [3000, 0], [3000, 5000], [-3000, 5000]] };
  const desk = { id: 'desk', kind: 'include', polygon: [[0, 1000], [1000, 1000], [1000, 2000], [0, 2000]] };
  const kitchen = { id: 'kitchen', kind: 'include', polygon: [[4000, 0], [8000, 0], [8000, 4000], [4000, 4000]] };
  assert.deepEqual([...spotLike([room, desk, kitchen])], ['desk']);
  assert.deepEqual([...spotLike([room, kitchen])], []); // two rooms side by side
  const strip = { id: 'strip', kind: 'include', polygon: [[2500, -1000], [3500, -1000], [3500, 1000], [2500, 1000]] }; // extends the room
  const apart = { id: 'apart', kind: 'include', polygon: [[-1000, 6000], [0, 6000], [0, 7000], [-1000, 7000]] }; // a desk drawn on its own
  assert.deepEqual([...spotLike([room, strip, apart])], ['apart']);
  const edge = { id: 'edge', kind: 'include', polygon: [[-1000, -1000], [1000, -1000], [1000, 0], [-1000, 0]] }; // shares the room's edge exactly
  assert.deepEqual([...spotLike([room, edge])], []);
});

test('fitBackground: two image points and where they belong give the placement back', async () => {
  const { fitBackground, imageToPlan, planToImage } = await import('../../custom_components/radar_zone_presence/frontend/plan.js');
  const truth = { image: '/local/p.png', w: 1000, h: 600, x: -3000, y: 7000, scale: 9.5, rotation: 30, opacity: 0.6 };
  const a = [100, 120], b = [880, 450];
  const start = { ...truth, x: 0, y: 0, scale: 5, rotation: 0 };
  const fit = fitBackground(start, [[a, imageToPlan(truth, a)], [b, imageToPlan(truth, b)]]);
  for (const k of ['x', 'y', 'scale', 'rotation']) assert.ok(Math.abs(fit[k] - truth[k]) < 1e-6, `${k}: ${fit[k]} vs ${truth[k]}`);
  const back = planToImage(truth, imageToPlan(truth, [321, 77]));
  assert.ok(Math.abs(back[0] - 321) < 1e-9 && Math.abs(back[1] - 77) < 1e-9);
  const moved = fitBackground(start, [[a, [500, 500]]]); // one pair: only moves
  assert.deepEqual(imageToPlan(moved, a).map(Math.round), [500, 500]);
  assert.equal(moved.scale, 5);
});

test('ownRoom: the part of a radar view where it is the nearest radar, outside other rooms', () => {
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  // Two radars 6 m apart facing each other along x; each sees a 6 m x 4 m box.
  const cones = [
    { radar: 'a', origin: [0, 0], polygon: sq(0, -2000, 6000, 2000) },
    { radar: 'b', origin: [6000, 0], polygon: sq(0, -2000, 6000, 2000) },
  ];
  const own = ownRoom('a', cones, []);
  const xs = own.polygon.map(p => p[0]);
  assert.ok(Math.max(...xs) <= 3000 && Math.max(...xs) > 2700, 'cut halfway between the radars');
  assert.ok(own.label[0] > 1000 && own.label[0] < 2000);
  // A room shape over the near half leaves nothing worth drawing.
  assert.equal(ownRoom('a', cones, [{ polygon: sq(-100, -2100, 3100, 2100) }]), null);
  // Where the other radar does not look, it stays ours.
  const lone = ownRoom('a', [cones[0], { radar: 'b', origin: [6000, 0], polygon: sq(5000, -500, 6000, 500) }], []);
  assert.ok(Math.max(...lone.polygon.map(p => p[0])) > 5500);
});

test('placeOnFloor / floorToMap round trip, and fitPlacement lines a map up without scaling it', async () => {
  const { placeOnFloor, floorToMap, fitPlacement } = await import('../../custom_components/radar_zone_presence/frontend/plan.js');
  const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps, `${a} vs ${b}`);
  const place = { x: 1000, y: -500, rotation: 30, mirror: true };
  for (const p of [[0, 0], [1200, 300], [-400, 2500]]) near(floorToMap(place, placeOnFloor(place, p)), p);
  near(placeOnFloor({ x: 0, y: 0, rotation: 90 }, [1000, 0]), [0, -1000]); // a quarter turn clockwise
  near(placeOnFloor({ x: 0, y: 0, rotation: 0, mirror: true }, [1000, 0]), [-1000, 0]);
  // Two map points and where they are on the floor: turned and moved, never scaled.
  const truth = { x: 3000, y: 2000, rotation: 75, mirror: false };
  const a = [500, 800], b = [4200, 1300];
  const fit = fitPlacement({}, [[a, placeOnFloor(truth, a)], [b, placeOnFloor(truth, b)]]);
  near([fit.x, fit.y], [truth.x, truth.y], 1e-3);
  assert.ok(Math.abs(fit.rotation - 75) < 1e-6);
  // Mirrored maps keep their mirror.
  const mt = { ...truth, mirror: true };
  const fm = fitPlacement({ mirror: true }, [[a, placeOnFloor(mt, a)], [b, placeOnFloor(mt, b)]]);
  near(placeOnFloor(fm, [0, 0]), placeOnFloor(mt, [0, 0]), 1e-3);
});

test('a mirrored image: imageToPlan / planToImage invert, fitBackground honours the mirror', async () => {
  const { imageToPlan, planToImage, fitBackground } = await import('../../custom_components/radar_zone_presence/frontend/plan.js');
  const bg = { w: 800, h: 500, x: 100, y: 900, scale: 4, rotation: 20, mirror: true };
  const p = imageToPlan(bg, [120, 40]);
  const back = planToImage(bg, p);
  assert.ok(Math.abs(back[0] - 120) < 1e-6 && Math.abs(back[1] - 40) < 1e-6);
  assert.ok(Math.abs(imageToPlan(bg, [800, 0])[0] - 100) < 1e-9); // the right edge is now where the left was
  const goal = { ...bg, x: -300, y: 50, scale: 6, rotation: 300 };
  const i1 = [10, 10], i2 = [700, 450];
  const fit = fitBackground({ ...bg }, [[i1, imageToPlan(goal, i1)], [i2, imageToPlan(goal, i2)]]);
  for (const k of ['x', 'y', 'scale', 'rotation']) assert.ok(Math.abs(fit[k] - goal[k]) < 1e-6, k);
});

test('floorPlan: a saved floor puts several maps on one plan; without one, the best map', async () => {
  const { floorPlan } = await import('../../custom_components/radar_zone_presence/frontend/plan.js');
  const room = (id, area) => ({ id, kind: 'include', area, polygon: [[0, 0], [3000, 0], [3000, 3000], [0, 3000]] });
  const maps = [
    { anchor: 'entry', shapes: [room('e', 'entry')], cones: [], toAnchor: new Map() },
    { anchor: 'garage', shapes: [room('g', 'garage')], cones: [], toAnchor: new Map() },
  ];
  const areas = new Set(['entry', 'garage']);
  assert.equal(floorPlan(maps, areas), null); // one room per map: no plan on its own
  const saved = { primary: 'entry', maps: { garage: { x: 0, y: -4000, rotation: 0 } }, image: null, items: [{ id: 'i1', entity_id: 'lock.front', x: 10, y: 20 }] };
  const plan = floorPlan(maps, areas, saved);
  assert.deepEqual([...plan.areas].sort(), ['entry', 'garage']);
  assert.equal(plan.parts.length, 2);
  assert.equal(plan.items.length, 1);
  assert.deepEqual(plan.unplaced, []);
  const partial = floorPlan(maps, areas, { primary: 'entry', maps: {} });
  assert.deepEqual(partial.unplaced.map(m => m.anchor), ['garage']);
});
