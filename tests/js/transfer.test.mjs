// Zone export / import round trip and merge rules (frontend/transfer.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportZones, exportFilename, parseImport, mergeZones } from '../../custom_components/radar_zone_presence/frontend/transfer.js';

const square = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];
const zone = (id, name, kind = 'include', filters = {}) => ({ id, name, kind, polygon: square, filters, area_id: null });

test('export → import round trip keeps zones, filters and settings', () => {
  const doc = exportZones({ title: 'Everything Presence Lite 252dd0', profile: 'everything_presence_lite' },
    [zone('zdesk', 'Desk', 'include', { hold_until_exit: true, hold_max_s: 1500, edge_margin_mm: 150 }), zone('zex', 'Fan', 'exclude')],
    { reconnect_grace_s: 3 });
  const parsed = parseImport(JSON.stringify(doc));
  assert.equal(parsed.zones.length, 2);
  assert.deepEqual(parsed.settings, { reconnect_grace_s: 3 });
  assert.deepEqual(parsed.zones[0].filters, { on_delay_s: 0, off_delay_s: 0, edge_margin_mm: 150, hold_until_exit: true, hold_max_s: 1500 });
  assert.equal(parsed.zones[1].kind, 'exclude');
  assert.equal(exportFilename({ title: 'Everything Presence Lite 252dd0' }), 'radar-zones-everything-presence-lite-252dd0.json');
});

test('import rejects foreign files and bad zones', () => {
  assert.throws(() => parseImport('nope'), /Not a JSON file/);
  assert.throws(() => parseImport('{"zones": []}'), /Not a Radar Zone Presence/);
  const base = { format: 'radar_zone_presence/zones', version: 1 };
  assert.throws(() => parseImport({ ...base, version: 99, zones: [] }), /newer/);
  assert.throws(() => parseImport({ ...base, zones: [{ name: 'X', kind: 'include', polygon: [[0, 0], [1, 1]] }] }), /zone 1 \(X\): polygon needs at least 3/);
  const bowtie = [[0, 0], [1000, 1000], [1000, 0], [0, 1000]];
  assert.throws(() => parseImport({ ...base, zones: [{ name: 'X', kind: 'include', polygon: bowtie }] }), /cross/);
  assert.throws(() => parseImport({ ...base, zones: [{ name: 'X', kind: 'other', polygon: square }] }), /kind/);
  assert.throws(() => parseImport({ ...base, zones: [{ name: 'X', kind: 'include', polygon: square, filters: { off_delay_s: -1 } }] }), /off_delay_s/);
});

test('merge replaces by id, then by name and kind, and adds the rest', () => {
  const current = [zone('zkeep', 'Desk'), zone('zold', 'Couch'), zone('zex', 'Couch', 'exclude')];
  const imported = parseImport({
    format: 'radar_zone_presence/zones', version: 1,
    zones: [
      { id: 'zfrom-dev', name: 'desk', kind: 'include', polygon: square, filters: { hold_until_exit: true } }, // name match
      { id: 'zold', name: 'Sofa', kind: 'include', polygon: square }, // id match (renamed)
      { id: 'zkeep', name: 'Bed', kind: 'include', polygon: square, area_id: 'bedroom' }, // id match wins over the earlier name match
      { name: 'Kitchen', kind: 'include', polygon: square, area_id: 'nowhere' },
    ],
  }).zones;
  const { zones, replaced, added } = mergeZones(current, imported, { areaIds: new Set(['bedroom']) });
  assert.equal(replaced, 3);
  assert.equal(added, 1);
  // 'desk' replaced zkeep by name first, then 'Bed' (id zkeep) replaced it again by id.
  assert.equal(zones.find(z => z.id === 'zkeep').name, 'Bed');
  assert.equal(zones.find(z => z.id === 'zkeep').area_id, 'bedroom');
  assert.equal(zones.find(z => z.id === 'zold').name, 'Sofa');
  assert.equal(zones.find(z => z.id === 'zex').kind, 'exclude');
  const kitchen = zones.find(z => z.name === 'Kitchen');
  assert.match(kitchen.id, /^z[0-9a-f]{10}$/);
  assert.equal(kitchen.area_id, null, 'unknown area falls back to inherit');
});

test('imported ids that are free are kept, so re-importing the same file replaces instead of duplicating', () => {
  const doc = parseImport({ format: 'radar_zone_presence/zones', version: 1,
    zones: [{ id: 'zdesk', name: 'Desk', kind: 'include', polygon: square }] });
  const once = mergeZones([], doc.zones);
  assert.equal(once.zones[0].id, 'zdesk');
  const twice = mergeZones(once.zones, doc.zones);
  assert.equal(twice.zones.length, 1);
  assert.equal(twice.replaced, 1);
});

test('exits round-trip with their door sensor', () => {
  const doc = exportZones({ title: 'Entry' }, [{ id: 'zx', name: 'Garage door', kind: 'exit', polygon: square, filters: {}, area_id: null, door_entity_id: 'binary_sensor.garage_door' }]);
  const { zones } = parseImport(JSON.stringify(doc));
  assert.equal(zones[0].kind, 'exit');
  assert.equal(zones[0].door_entity_id, 'binary_sensor.garage_door');
});

test('exits keep where they lead; unknown areas are dropped on import', () => {
  const doc = exportZones({ title: 'Entry' }, [{ id: 'zs', name: 'Stairs', kind: 'exit', polygon: square, filters: {}, area_id: null, leads_to: ['living_room', 'outside', 'attic'] }]);
  const { zones } = parseImport(JSON.stringify(doc));
  assert.deepEqual(zones[0].leads_to, ['living_room', 'outside', 'attic']);
  const merged = mergeZones([], zones, { areaIds: new Set(['living_room']) });
  assert.deepEqual(merged.zones[0].leads_to, ['living_room', 'outside']);
});
