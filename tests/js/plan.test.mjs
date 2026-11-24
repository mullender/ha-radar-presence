import test from 'node:test';
import assert from 'node:assert/strict';
import { centroid, planFor } from '../../custom_components/radar_zone_presence/frontend/plan.js';

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
