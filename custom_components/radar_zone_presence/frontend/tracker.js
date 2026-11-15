// People tracking by position across frames and aligned radars: line-by-line
// port of engine/tracker.py (see there for the rules). Observations are
// [radar index, slot, x, y] in the group's frame; targets are [track id, x, y]
// for the zone engine.
import { ZoneEngine, pointInPolygon } from './engine.js';
import { affineApply, affineInvert } from './util.js';

export const NOISE_MM = 500;
export const VMAX_MM_S = 2500;
export const MAX_STEP_MM = 1500;
export const REVIVE_MM = 1500;
export const MERGE_MM = 600;
export const SPLIT_MM = 1200;
export const EDGE_MM = 600;
export const FOV_HALF_ANGLE_DEG = 60;
export const MAX_LOST = 32;
export const TRANSIENT_TTL_S = 20;
export const SETTLED_TTL_S = 12 * 3600;
const FIRST_FREE_ID = 1000;
const SPOT_KINDS = ['exit', 'linger', 'transient'];

const key = (r, s) => `${r}:${s}`;
const mean = obs => [obs.reduce((a, o) => a + o[2], 0) / obs.length, obs.reduce((a, o) => a + o[3], 0) / obs.length];
const reach = (cap, dt) => NOISE_MM + Math.min(VMAX_MM_S * Math.max(dt, 0), cap);
const cmpTuple = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
const expires = lo => lo.t + (lo.settled ? SETTLED_TTL_S : TRANSIENT_TTL_S);

/** Distance (mm, radar frame) to the nearer side (±60°) of the field of view; negative outside. */
export function sideMargin(x, y) {
  const a = Math.abs(Math.atan2(x, y));
  const half = (FOV_HALF_ANGLE_DEG * Math.PI) / 180;
  return a < half ? Math.hypot(x, y) * Math.sin(half - a) : -1;
}

export class Tracker {
  /** spots: exit / linger / transient zones (group frame); toRadar: per radar index, group frame -> radar frame. */
  constructor(spots = [], toRadar = []) {
    this.tracks = new Map(); // id -> {id, seq, members: [[radar, slot]], x, y, t}
    this.lostMap = new Map(); // id -> {id, seq, x, y, t, settled}
    this.seq = 0;
    this.linger = spots.filter(z => z.kind === 'linger').map(z => z.polygon);
    this.transient = spots.filter(z => z.kind === 'transient' || z.kind === 'exit').map(z => z.polygon);
    this.toRadar = [...toRadar];
  }

  get lost() { return [...this.lostMap.values()].map(lo => [lo.id, lo.x, lo.y, lo.settled]); }

  nextDeadline() {
    let best = null;
    for (const lo of this.lostMap.values()) { const e = expires(lo); if (best === null || e < best) best = e; }
    return best;
  }

  expire(t) {
    const out = [...this.lostMap.values()].filter(lo => expires(lo) <= t + 1e-6).map(lo => lo.id).sort((a, b) => a - b);
    for (const i of out) this.lostMap.delete(i);
    return out;
  }

  _settled(tr) {
    if (this.transient.some(p => pointInPolygon(tr.x, tr.y, p))) return false;
    if (this.linger.some(p => pointInPolygon(tr.x, tr.y, p))) return true;
    const views = [...new Set(tr.members.map(m => m[0]))].sort((a, b) => a - b)
      .filter(k => k < this.toRadar.length).map(k => this.toRadar[k]);
    return !views.length || views.some(A => { const [x, y] = affineApply(A, [tr.x, tr.y]); return sideMargin(x, y) >= EDGE_MM; });
  }

  _newId(radar, slot, used) {
    let tid = 10 * radar + slot;
    if (used.has(tid) || tid >= FIRST_FREE_ID) {
      tid = FIRST_FREE_ID;
      while (used.has(tid)) tid++;
    }
    return tid;
  }

  /** observations: [[radar, slot, x, y]]. Returns {targets: [[id, x, y]], gone, radars: Map id -> Set, born, dropped}. */
  fuse(observations, t) {
    let dropped = this.expire(t);
    const prev = this.tracks;
    const owner = new Map();
    for (const tr of prev.values()) for (const [r, s] of tr.members) owner.set(key(r, s), tr.id);
    const assigned = new Map();
    const push = (tid, o) => { if (!assigned.has(tid)) assigned.set(tid, []); assigned.get(tid).push(o); };
    let unassigned = [];
    for (const o of observations) {
      const tid = owner.get(key(o[0], o[1]));
      if (tid !== undefined && Math.hypot(o[2] - prev.get(tid).x, o[3] - prev.get(tid).y) <= reach(MAX_STEP_MM, t - prev.get(tid).t)) push(tid, o);
      else unassigned.push(o);
    }

    for (const [tid, obs] of assigned) {
      if (obs.length < 2) continue;
      const members = prev.get(tid).members;
      const order = new Map(members.map((m, i) => [key(m[0], m[1]), i]));
      obs.sort((a, b) => (order.get(key(a[0], a[1])) ?? order.size) - (order.get(key(b[0], b[1])) ?? order.size));
      const keep = [obs[0]];
      for (const o of obs.slice(1)) {
        if (Math.hypot(o[2] - obs[0][2], o[3] - obs[0][3]) > SPLIT_MM) unassigned.push(o);
        else keep.push(o);
      }
      assigned.set(tid, keep);
    }

    const pairs = [];
    unassigned.forEach((o, i) => {
      for (const tr of prev.values()) {
        const had = tr.members.some(m => m[0] === o[0]);
        const limit = had ? reach(MAX_STEP_MM, t - tr.t) : MERGE_MM;
        const d = Math.hypot(o[2] - tr.x, o[3] - tr.y);
        if (d <= limit) pairs.push([d, o[0], o[1], 0, tr.id, i]);
      }
      for (const lo of this.lostMap.values()) {
        const d = Math.hypot(o[2] - lo.x, o[3] - lo.y);
        if (d <= reach(REVIVE_MM, t - lo.t)) pairs.push([d, o[0], o[1], 1, lo.id, i]);
      }
    });
    pairs.sort(cmpTuple);
    const taken = new Set();
    const revive = new Map();
    for (const [, radar, , lost, tid, i] of pairs) {
      if (taken.has(i)) continue;
      if (lost) {
        if (revive.has(tid)) continue;
        revive.set(tid, unassigned[i]);
      } else if ((assigned.get(tid) || []).some(o => o[0] === radar)) continue;
      else push(tid, unassigned[i]);
      taken.add(i);
    }
    unassigned = unassigned.filter((_, i) => !taken.has(i));

    const tracks = new Map();
    for (const [tid, obs] of assigned) {
      const old = prev.get(tid);
      const members = old.members.filter(m => obs.some(o => o[0] === m[0] && o[1] === m[1]));
      for (const o of obs) if (!members.some(m => m[0] === o[0] && m[1] === o[1])) members.push([o[0], o[1]]);
      const [x, y] = mean(obs);
      tracks.set(tid, { id: tid, seq: old.seq, members, x, y, t });
    }
    for (const [tid, o] of revive) {
      const lo = this.lostMap.get(tid);
      this.lostMap.delete(tid);
      tracks.set(tid, { id: tid, seq: lo.seq, members: [[o[0], o[1]]], x: o[2], y: o[3], t });
      assigned.set(tid, [o]);
    }
    const revived = new Set(revive.keys());

    for (const [tid, tr] of prev) {
      if (!tracks.has(tid)) this.lostMap.set(tid, { id: tid, seq: tr.seq, x: tr.x, y: tr.y, t: tr.t, settled: this._settled(tr) });
    }
    while (this.lostMap.size > MAX_LOST) {
      let oldest = null;
      for (const lo of this.lostMap.values()) if (oldest === null || lo.t < oldest.t || (lo.t === oldest.t && lo.id < oldest.id)) oldest = lo;
      this.lostMap.delete(oldest.id);
      dropped = [...dropped, oldest.id];
    }

    unassigned = unassigned.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const born = [];
    unassigned.forEach(o => {
      let best = null, bestD = MERGE_MM;
      for (const tr of tracks.values()) {
        if (tr.members.some(m => m[0] === o[0])) continue;
        const d = Math.hypot(tr.x - o[2], tr.y - o[3]);
        if (d <= bestD) { best = tr; bestD = d; }
      }
      if (best) {
        const obs = assigned.get(best.id);
        obs.push(o);
        best.members.push([o[0], o[1]]);
        [best.x, best.y] = mean(obs);
        return;
      }
      const tid = this._newId(o[0], o[1], new Set([...tracks.keys(), ...prev.keys(), ...this.lostMap.keys()]));
      this.seq++;
      tracks.set(tid, { id: tid, seq: this.seq, members: [[o[0], o[1]]], x: o[2], y: o[3], t });
      assigned.set(tid, [o]);
      born.push(tid);
    });

    const gone = [];
    const released = [...dropped];
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
            [a.x, a.y] = mean(assigned.get(a.id));
            tracks.delete(b.id);
            const bi = born.indexOf(b.id);
            if (bi >= 0) born.splice(bi, 1);
            else if (revived.has(b.id)) released.push(b.id);
            else gone.push(b.id);
            merged = true;
            break outer;
          }
        }
      }
    }

    this.tracks = tracks;
    const ordered = [...tracks.values()].sort((a, b) => a.id - b.id);
    const num = (a, b) => a - b;
    return {
      targets: ordered.map(tr => [tr.id, tr.x, tr.y]),
      gone: gone.sort(num),
      radars: new Map(ordered.map(tr => [tr.id, new Set(tr.members.map(m => m[0]))])),
      born: born.sort(num),
      dropped: released.sort(num),
    };
  }
}

/**
 * Preview of a radar's zones as the home evaluates them: this radar's frames
 * plus those of the radars aligned with it (none for a lone radar), each with
 * its own exclusions and reconnect grace, tracked in this radar's frame.
 * Per-frame states are indexed by this radar's frames, like replayHistory.
 *
 * own: {hist, zones}; peers: [{hist, zones, T}] with T mapping the peer's
 * frame into this radar's.
 * Include zones are this radar's; exits and spots of every radar count.
 * Returns {transitions, perFrame}.
 */
export function replayGroup(own, peers = [], reconnectGraceS = 0, { perFrameStates = false } = {}) {
  const radars = [{ hist: own.hist, zones: own.zones, T: null }, ...peers];
  const include = own.zones.filter(z => (z.kind || 'include') === 'include');
  const groupZones = radars.flatMap((r, k) => r.zones.filter(z => SPOT_KINDS.includes(z.kind))
    .map(z => ({ ...z, id: `${k}:${z.id}`, polygon: r.T ? z.polygon.map(p => affineApply(r.T, p)) : z.polygon })));
  const eng = new ZoneEngine([...include, ...groupZones.filter(z => z.kind === 'exit')], 0);
  const identity = [[1, 0, 0], [0, 1, 0]];
  const tracker = new Tracker(groupZones, radars.map(r => affineInvert(r.T || identity)));
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
  const nextDeadline = () => {
    const a = eng.nextDeadline(), b = tracker.nextDeadline();
    return a === null ? b : b === null ? a : Math.min(a, b);
  };
  const catchUp = t => {
    let d;
    while ((d = nextDeadline()) !== null && d <= t) {
      const dropped = tracker.expire(d);
      if (dropped.length) eng.release(d, dropped);
      eng.advance(d);
      emit(d);
    }
  };
  for (;;) {
    // Next frame across all radars (ties: lowest radar index first, like heapq.merge on (t, k)).
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
    catchUp(t);
    const fused = tracker.fuse(feeds.flatMap(q => q.kept), t);
    eng.process(t, fused.targets, feeds.some(q => q.available), fused.gone, fused.dropped);
    emit(t);
    if (per && best === 0) { const s = states(); for (const k of keys) per[k][i] = s[k] ? 1 : 0; }
  }
  catchUp(Infinity);
  return { transitions, perFrame: per };
}
