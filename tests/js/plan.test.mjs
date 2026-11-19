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
