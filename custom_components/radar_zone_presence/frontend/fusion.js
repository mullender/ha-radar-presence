// Multi-radar target fusion: line-by-line port of engine/fusion.py (see there
// for the rules). Observations are [radar index, slot, x, y] in the group's
// frame; fused targets are [track id, x, y] for the zone engine.
import { ZoneEngine, pointInPolygon } from './engine.js';
import { affineApply } from './util.js';

export const MERGE_MM = 600;
export const SPLIT_MM = 1200;
export const JUMP_MM = 800;
const FIRST_FREE_ID = 1000;

const key = (r, s) => `${r}:${s}`;
const mean = (obs, i) => obs.reduce((a, o) => a + o[i], 0) / obs.length;

export class Fuser {
  constructor() {
    this.tracks = new Map(); // id -> {id, seq, members: [[radar, slot]], x, y}
    this.seq = 0;
  }

  _newId(radar, slot, used) {
    let tid = 10 * radar + slot;
    if (used.has(tid) || tid >= FIRST_FREE_ID) {
      tid = FIRST_FREE_ID;
      while (used.has(tid)) tid++;
    }
    return tid;
  }

  /** observations: [[radar, slot, x, y]]. Returns {targets: [[id, x, y]], gone: [id], radars: Map id -> Set}. */
  fuse(observations) {
    const owner = new Map();
    for (const tr of this.tracks.values()) for (const [r, s] of tr.members) owner.set(key(r, s), tr.id);
    const assigned = new Map();
    let unassigned = [];
    for (const o of observations) {
      const tid = owner.get(key(o[0], o[1]));
      if (tid === undefined) unassigned.push(o);
      else { if (!assigned.has(tid)) assigned.set(tid, []); assigned.get(tid).push(o); }
    }

    for (const [tid, obs] of assigned) {
      if (obs.length < 2) continue;
      const members = this.tracks.get(tid).members;
      const order = new Map(members.map((m, i) => [key(m[0], m[1]), i]));
      obs.sort((a, b) => (order.get(key(a[0], a[1])) ?? order.size) - (order.get(key(b[0], b[1])) ?? order.size));
      const keep = [obs[0]];
      for (const o of obs.slice(1)) {
        if (Math.hypot(o[2] - obs[0][2], o[3] - obs[0][3]) > SPLIT_MM) unassigned.push(o);
        else keep.push(o);
      }
      assigned.set(tid, keep);
    }

    for (const tid of [...assigned.keys()]) {
      const old = this.tracks.get(tid), obs = assigned.get(tid);
      const lost = new Set(obs.map(o => o[0])).size < new Set(old.members.map(m => m[0])).size;
      if (lost && Math.hypot(mean(obs, 2) - old.x, mean(obs, 3) - old.y) > JUMP_MM) {
        unassigned.push(...obs);
        assigned.delete(tid);
      }
    }

    const tracks = new Map();
    for (const [tid, obs] of assigned) {
      const old = this.tracks.get(tid);
      tracks.set(tid, { id: tid, seq: old.seq, members: old.members.filter(m => obs.some(o => o[0] === m[0] && o[1] === m[1])), x: 0, y: 0 });
    }
    const place = (tr, obs) => { tr.x = mean(obs, 2); tr.y = mean(obs, 3); };
    for (const [tid, obs] of assigned) place(tracks.get(tid), obs);

    unassigned = unassigned.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const o of unassigned) {
      let best = null, bestD = MERGE_MM;
      for (const tr of tracks.values()) {
        if (tr.members.some(m => m[0] === o[0])) continue;
        const d = Math.hypot(tr.x - o[2], tr.y - o[3]);
        if (d <= bestD) { best = tr; bestD = d; }
      }
      if (best) {
        if (!assigned.has(best.id)) assigned.set(best.id, []);
        const obs = assigned.get(best.id);
        obs.push(o);
        best.members.push([o[0], o[1]]);
        place(best, obs);
      } else {
        const tid = this._newId(o[0], o[1], new Set([...tracks.keys(), ...this.tracks.keys()]));
        this.seq++;
        tracks.set(tid, { id: tid, seq: this.seq, members: [[o[0], o[1]]], x: o[2], y: o[3] });
        assigned.set(tid, [o]);
      }
    }

    const gone = [];
    let merged = true;
    while (merged) {
      merged = false;
      const live = [...tracks.values()].sort((a, b) => a.seq - b.seq);
      outer: for (let i = 0; i < live.length; i++) {
        const a = live[i];
        const ra = new Set(a.members.map(m => m[0]));
        for (const b of live.slice(i + 1)) {
          if (b.members.some(m => ra.has(m[0]))) continue;
          if (Math.hypot(a.x - b.x, a.y - b.y) <= MERGE_MM) {
            a.members.push(...b.members);
            assigned.get(a.id).push(...assigned.get(b.id));
            assigned.delete(b.id);
            place(a, assigned.get(a.id));
            tracks.delete(b.id);
            if (this.tracks.has(b.id)) gone.push(b.id);
            merged = true;
            break outer;
          }
        }
      }
    }

    this.tracks = tracks;
    const ordered = [...tracks.values()].sort((a, b) => a.id - b.id);
    return {
      targets: ordered.map(tr => [tr.id, tr.x, tr.y]),
      gone: gone.sort((a, b) => a - b),
      radars: new Map(ordered.map(tr => [tr.id, new Set(tr.members.map(m => m[0]))])),
    };
  }
}

/**
 * Preview of a radar's zones as the home evaluates them: this radar's frames
 * plus those of the radars aligned with it, each with its own exclusions and
 * reconnect grace, fused in this radar's frame. Per-frame states are indexed
 * by this radar's frames, like replayHistory.
 *
 * own: {hist, zones}; peers: [{hist, zones, T}] with T mapping the peer's
 * frame into this radar's. Exits of every radar count; include zones are this
 * radar's. Returns {transitions, perFrame}.
 */
export function replayGroup(own, peers, reconnectGraceS = 0, { perFrameStates = false } = {}) {
  const radars = [{ hist: own.hist, zones: own.zones, T: null }, ...peers];
  const include = own.zones.filter(z => z.kind === 'include');
  const exits = radars.flatMap((r, k) => r.zones.filter(z => z.kind === 'exit')
    .map(z => ({ ...z, id: `${k}:${z.id}`, polygon: r.T ? z.polygon.map(p => affineApply(r.T, p)) : z.polygon })));
  const eng = new ZoneEngine([...include, ...exits], 0);
  const fuser = new Fuser();
  const keys = [...include.map(z => z.id), 'presence'];
  const prev = Object.fromEntries(keys.map(k => [k, false]));
  const transitions = [];
  const nOwn = own.hist.frame_t.length;
  const per = perFrameStates ? Object.fromEntries(keys.map(k => [k, new Uint8Array(nOwn)])) : null;
  const feeds = radars.map(r => {
    const starts = [0];
    for (const n of r.hist.frame_n) starts.push(starts[starts.length - 1] + n);
    return { ...r, starts, i: 0, kept: [], available: true, graceUntil: -Infinity, exclude: r.zones.filter(z => z.kind === 'exclude') };
  });
  let presence = false;
  const states = () => ({ ...eng.states(), presence });
  const emit = t => {
    const s = states();
    for (const k of keys) if (s[k] !== prev[k]) { transitions.push([t, k, s[k]]); prev[k] = s[k]; }
  };
  for (;;) {
    // Next frame across all radars (ties: this radar first, like the live order is arbitrary).
    let best = -1, bestT = Infinity;
    for (let k = 0; k < feeds.length; k++) {
      const f = feeds[k];
      if (f.i < f.hist.frame_t.length) {
        const t = f.hist.start + f.hist.frame_t[f.i];
        if (t < bestT) { bestT = t; best = k; }
      }
    }
    if (best < 0) break;
    const f = feeds[best];
    const t = bestT, i = f.i++;
    const available = f.hist.frame_available ? f.hist.frame_available[i] === 1 : true;
    if (available && !f.available) f.graceUntil = t + reconnectGraceS;
    f.available = available;
    f.kept = [];
    if (t >= f.graceUntil) {
      for (let p = f.starts[i]; p < f.starts[i + 1]; p++) {
        const x = f.hist.x[p], y = f.hist.y[p];
        if (f.exclude.some(z => pointInPolygon(x, y, z.polygon))) continue;
        const [gx, gy] = f.T ? affineApply(f.T, [x, y]) : [x, y];
        f.kept.push([best, f.hist.slot[p], gx, gy]);
      }
    }
    if (best === 0) presence = f.kept.length > 0;
    let d;
    while ((d = eng.nextDeadline()) !== null && d <= t) { eng.advance(d); emit(d); }
    const fused = fuser.fuse(feeds.flatMap(q => q.kept));
    eng.process(t, fused.targets, feeds.some(q => q.available), fused.gone);
    emit(t);
    if (per && best === 0) { const s = states(); for (const k of keys) per[k][i] = s[k] ? 1 : 0; }
  }
  let d;
  while ((d = eng.nextDeadline()) !== null) { eng.advance(d); emit(d); }
  return { transitions, perFrame: per };
}
