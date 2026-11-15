// frontend/tracker.js against the Python tracker: the shared vectors
// (tests/vectors/group_*.json and tracked_*.json from engine.tracker.replay_group)
// plus the basic tracking behaviours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Tracker, replayGroup } from '../../custom_components/radar_zone_presence/frontend/tracker.js';
import { alignmentAffine } from '../../custom_components/radar_zone_presence/frontend/util.js';

const dir = new URL('../vectors/', import.meta.url);
const norm = zones => zones.map(z => ({ ...z, filters: z.filters ?? {} }));

function sameTransitions(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: transition count`);
  actual.forEach(([t, k, v], i) => {
    const [et, ek, ev] = expected[i];
    assert.ok(Math.abs(t - et) < 1e-5, `${label} t[${i}] ${t} vs ${et}`);
    assert.equal(k, ek, `${label} key[${i}]`);
    assert.equal(v, ev, `${label} value[${i}]`);
  });
}

test('consistent slots keep their numbers as ids', () => {
  const f = new Tracker();
  [[[1, 0, 1000], [3, 500, 2000]], [[3, 520, 2010]], [[1, 10, 900], [2, -800, 1500]]].forEach((frame, i) => {
    const out = f.fuse(frame.map(([s, x, y]) => [0, s, x, y]), i * 0.3);
    assert.deepEqual(out.targets, [...frame].sort((a, b) => a[0] - b[0]));
  });
});

test('a renumbered slot keeps both people apart; a lost person is re-found nearby', () => {
  const f = new Tracker();
  f.fuse([[0, 1, -2300, 4700], [0, 2, 2500, 3600]], 0);
  let out = f.fuse([[0, 1, 2450, 3620]], 0.3);
  assert.deepEqual(out.targets.map(t => t[0]), [2]);
  assert.deepEqual(f.lost.map(([id, , , settled]) => [id, settled]), [[1, true]]);
  out = f.fuse([[0, 1, 2450, 3620], [0, 2, -2000, 4300]], 20);
  assert.deepEqual(out.targets.map(t => t[0]), [1, 2]);
  assert.deepEqual(out.born, []);
});

test('hand-over keeps the track id; converging tracks merge', () => {
  const f = new Tracker();
  f.fuse([[0, 1, 0, 2000]], 0);
  let out = f.fuse([[0, 1, 50, 2000], [1, 2, 250, 2100]], 0.3);
  assert.deepEqual(out.targets.map(t => t[0]), [1]);
  out = f.fuse([[1, 2, 400, 2200]], 0.6);
  assert.deepEqual(out.targets.map(t => t[0]), [1]);
  const g = new Tracker();
  g.fuse([[0, 1, 0, 2000], [1, 1, 1500, 2000]], 0);
  out = g.fuse([[0, 1, 0, 2000], [1, 1, 400, 2000]], 0.3);
  assert.deepEqual(out.targets.map(t => t[0]), [1]);
  assert.deepEqual(out.gone, [11]);
});

test('group replay matches the Python vector', () => {
  const vec = JSON.parse(readFileSync(new URL('group_252dd0_b3b6c4.json', dir), 'utf8'));
  const { transitions } = replayGroup(
    { hist: vec.own.frames, zones: norm(vec.own.zones) },
    vec.peers.map(p => ({ hist: p.frames, zones: norm(p.zones), T: alignmentAffine(p.aligned_to) })),
    vec.reconnect_grace_s,
  );
  sameTransitions(transitions, vec.transitions, 'group');
});

for (const file of readdirSync(dir).filter(f => f.startsWith('tracked_'))) {
  const vec = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  for (const [name, c] of Object.entries(vec.cases)) {
    test(`${file} / ${name}`, () => {
      const { transitions } = replayGroup({ hist: vec.frames, zones: norm(c.zones) }, [], vec.reconnect_grace_s);
      sameTransitions(transitions, c.transitions, name);
    });
  }
}
