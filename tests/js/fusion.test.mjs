// frontend/fusion.js against the Python fuser: identity for one radar, and the
// shared group vector (tests/vectors/group_*.json from engine.fusion.replay_group).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Fuser, replayGroup } from '../../custom_components/radar_zone_presence/frontend/fusion.js';
import { alignmentAffine } from '../../custom_components/radar_zone_presence/frontend/util.js';

test('one radar: slots pass through unchanged', () => {
  const f = new Fuser();
  for (const frame of [[[1, 0, 1000], [3, 500, 2000]], [[3, 520, 2010]], [[1, 10, 900], [2, -800, 1500]]]) {
    const out = f.fuse(frame.map(([s, x, y]) => [0, s, x, y]));
    assert.deepEqual(out.targets, [...frame].sort((a, b) => a[0] - b[0]));
    assert.deepEqual(out.gone, []);
  }
});

test('hand-over keeps the track id; converging tracks merge', () => {
  const f = new Fuser();
  f.fuse([[0, 1, 0, 2000]]);
  let out = f.fuse([[0, 1, 50, 2000], [1, 2, 250, 2100]]);
  assert.deepEqual(out.targets.map(t => t[0]), [1]);
  out = f.fuse([[1, 2, 400, 2200]]);
  assert.deepEqual(out.targets.map(t => t[0]), [1]);
  const g = new Fuser();
  g.fuse([[0, 1, 0, 2000], [1, 1, 1500, 2000]]);
  out = g.fuse([[0, 1, 0, 2000], [1, 1, 400, 2000]]);
  assert.deepEqual(out.targets.map(t => t[0]), [1]);
  assert.deepEqual(out.gone, [11]);
});

test('group replay matches the Python vector', () => {
  const vec = JSON.parse(readFileSync(new URL('../vectors/group_252dd0_b3b6c4.json', import.meta.url), 'utf8'));
  const norm = zones => zones.map(z => ({ ...z, filters: z.filters ?? {} }));
  const { transitions } = replayGroup(
    { hist: vec.own.frames, zones: norm(vec.own.zones) },
    vec.peers.map(p => ({ hist: p.frames, zones: norm(p.zones), T: alignmentAffine(p.aligned_to) })),
    vec.reconnect_grace_s,
  );
  assert.equal(transitions.length, vec.transitions.length, 'transition count');
  transitions.forEach(([t, k, v], i) => {
    const [et, ek, ev] = vec.transitions[i];
    assert.ok(Math.abs(t - et) < 1e-5, `t[${i}] ${t} vs ${et}`);
    assert.equal(k, ek, `key[${i}]`);
    assert.equal(v, ev, `value[${i}]`);
  });
});
