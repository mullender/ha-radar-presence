// Replays tests/vectors through frontend/engine.js and compares with the
// transitions recorded from the Python engine. Run: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayHistory, validatePolygon, pointInPolygon, fovPolygon } from '../../custom_components/radar_zone_presence/frontend/engine.js';

const dir = new URL('../vectors/', import.meta.url).pathname;

for (const file of readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('group_'))) {
  const vec = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  for (const [name, c] of Object.entries(vec.cases)) {
    test(`${file} :: ${name}`, () => {
      const zones = c.zones.map(z => ({ ...z, filters: z.filters ?? {} }));
      const { transitions } = replayHistory(vec.frames, zones, vec.reconnect_grace_s);
      assert.equal(transitions.length, c.transitions.length, 'transition count');
      transitions.forEach(([t, k, v], i) => {
        const [et, ek, ev] = c.transitions[i];
        assert.ok(Math.abs(t - et) < 1e-5, `t[${i}] ${t} vs ${et}`);
        assert.equal(k, ek);
        assert.equal(v, ev);
      });
    });
  }
}

test('geometry helpers', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.ok(pointInPolygon(5, 5, sq));
  assert.equal(validatePolygon(sq), null);
  assert.equal(validatePolygon([[0, 0], [10, 10], [10, 0], [0, 10]]), 'polygon edges cross each other');
  assert.ok(pointInPolygon(0, 3000, fovPolygon(6000)));
});
