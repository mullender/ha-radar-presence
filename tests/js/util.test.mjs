// View orientation defaults (frontend/util.js normalizeDisplay).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDisplay } from '../../custom_components/radar_zone_presence/frontend/util.js';

test('mounting defaults to the device: upside-down sensors are drawn flipped', () => {
  assert.deepEqual(normalizeDisplay({}, { upsideDown: true }), { rotation: 0, mirror: true, v: 2 });
  assert.deepEqual(normalizeDisplay({}, {}), { rotation: 0, mirror: false, v: 2 });
});

test('settings saved before v2 never chose a mounting and take the device default', () => {
  assert.equal(normalizeDisplay({ rotation: 90, mirror: false }, { upsideDown: true }).mirror, true);
  assert.equal(normalizeDisplay({ rotation: 90, mirror: false }, { upsideDown: true }).rotation, 90);
});

test('an explicit v2 choice wins over the device', () => {
  assert.equal(normalizeDisplay({ mirror: false, v: 2 }, { upsideDown: true }).mirror, false);
  assert.equal(normalizeDisplay({ mirror: true, v: 2 }, {}).mirror, true);
});

test('rotation is any angle, normalised to [0, 360)', () => {
  assert.equal(normalizeDisplay({ rotation: -45, v: 2 }).rotation, 315);
  assert.equal(normalizeDisplay({ rotation: 405, v: 2 }).rotation, 45);
});
