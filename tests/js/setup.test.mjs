import test from 'node:test';
import assert from 'node:assert/strict';
import { fixFor, screenDirection } from '../../custom_components/radar_zone_presence/frontend/setup.js';

// plot.js _matrix() with scale 1, no pan.
const matrix = ({ rotation = 0, mirror = false }) => {
  const r = (rotation * Math.PI) / 180, m = mirror ? -1 : 1;
  return [Math.cos(r) * m, -Math.sin(r) * m, -Math.sin(r), -Math.cos(r), 0, 0];
};
const walk = (dx, dy) => new Map([[1, [0, 1, 2, 3].map(i => ({ x: i * dx, y: 1000 + i * dy, t: i }))]]);

test('screenDirection: a walk along the radar x axis, drawn upright, moves right', () => {
  assert.equal(screenDirection(walk(300, 0), matrix({})), 'right');
  assert.equal(screenDirection(walk(-300, 0), matrix({})), 'left');
  assert.equal(screenDirection(walk(0, 300), matrix({})), 'up'); // away from the radar
  assert.equal(screenDirection(walk(5, 0), matrix({})), null); // standing still
});

test('fixFor: one answer makes the walk move right, whatever the view and the mounting', () => {
  for (const rotation of [0, 90, 180, 270]) {
    for (const mirror of [false, true]) {
      for (const [dx, dy] of [[300, 0], [-300, 0], [0, 300], [0, -300]]) {
        const display = { rotation, mirror };
        const seen = screenDirection(walk(dx, dy), matrix(display));
        const fixed = { ...display, ...fixFor(seen, display) };
        assert.equal(screenDirection(walk(dx, dy), matrix(fixed)), 'right', JSON.stringify({ display, dx, dy, seen, fixed }));
      }
    }
  }
});
