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

test('door geometry: "in" swings towards the radar, hinge end flips', async () => {
  const { doorGeometry } = await import('../../custom_components/radar_zone_presence/frontend/util.js');
  const threshold = [[-500, 2000], [500, 2000], [500, 2100], [-500, 2100]]; // 1 m door, 3 m out
  const g = doorGeometry(threshold, { swing: 'in', hinge_end: 0 });
  assert.deepEqual(g.hinge, [-500, 2000]);
  assert.deepEqual(g.open.map(Math.round), [-500, 1000], 'opens 90 deg towards the radar');
  assert.equal(g.arc.length, 17);
  const out = doorGeometry(threshold, { swing: 'out', hinge_end: 1 });
  assert.deepEqual(out.hinge, [500, 2100]);
  assert.deepEqual(out.open.map(Math.round), [500, 3100], 'opens away from the radar');
  assert.equal(doorGeometry(threshold, { swing: 'none' }).arc, undefined);
  assert.equal(doorGeometry([[0, 0], [1000, 100], [900, 600], [-100, 500]], null).rect.length, 4);
});

test('radar transforms chain through alignments in either direction', async () => {
  const { radarTransforms, affineApply, alignmentAffine } = await import('../../custom_components/radar_zone_presence/frontend/util.js');
  // kitchen -> living, island -> living (both saved on the non-reference radar)
  const kitchen = { entry_id: 'k', aligned_to: { entry_id: 'l', angle_deg: -155.1, reflect: false, offset_mm: [2300, 5445] } };
  const island = { entry_id: 'b', aligned_to: { entry_id: 'l', angle_deg: -104.3, reflect: true, offset_mm: [1646, 2758] } };
  const living = { entry_id: 'l' };
  const radars = [living, kitchen, island];
  const p = [500, 2500]; // a point in the island radar's frame
  const inLiving = affineApply(alignmentAffine(island.aligned_to), p);
  const fromKitchen = radarTransforms('k', radars);
  const inKitchen = affineApply(fromKitchen.get('b'), p); // island -> living -> kitchen
  const back = affineApply(alignmentAffine(kitchen.aligned_to), inKitchen); // kitchen -> living
  assert.ok(Math.hypot(back[0] - inLiving[0], back[1] - inLiving[1]) < 1e-6);
  assert.equal(radarTransforms('l', radars).size, 2);
  assert.equal(radarTransforms('x', [...radars, { entry_id: 'x' }]).size, 0, 'unaligned radar: nothing connected');
});
