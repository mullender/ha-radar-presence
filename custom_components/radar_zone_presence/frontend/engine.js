// Port of engine/zones.py + engine/geometry.py for the editor preview.
// Keep in lock-step with the Python engine: tests/vectors/*.json are checked
// by both test suites (pytest + node --test).

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function signedDistance(x, y, poly) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[(i + poly.length - 1) % poly.length], b = poly[i];
    d = Math.min(d, distToSegment(x, y, a[0], a[1], b[0], b[1]));
  }
  return pointInPolygon(x, y, poly) ? d : -d;
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[(i + poly.length - 1) % poly.length], q = poly[i];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function segmentsIntersect(p1, p2, p3, p4) {
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function validatePolygon(poly) {
  if (poly.length < 3) return 'polygon needs at least 3 vertices';
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === (i + 1) % n || (j + 1) % n === i) continue;
      if (segmentsIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return 'polygon edges cross each other';
    }
  }
  if (Math.abs(polygonArea(poly)) < 1) return 'polygon has no area';
  return null;
}

export function fovPolygon(maxDistance, halfAngleDeg = 60, segments = 24) {
  const pts = [[0, 0]];
  for (let k = 0; k <= segments; k++) {
    const a = ((-halfAngleDeg + (2 * halfAngleDeg * k) / segments) * Math.PI) / 180;
    pts.push([Math.round(maxDistance * Math.sin(a) * 10) / 10, Math.round(maxDistance * Math.cos(a) * 10) / 10]);
  }
  return pts;
}

const EPS = 1e-6;

/**
 * ZoneEngine: same semantics as the Python engine.
 * zones: [{id, kind, polygon, filters: {on_delay_s, off_delay_s, edge_margin_mm}}]
 */
export class ZoneEngine {
  constructor(zones, reconnectGraceS = 0) {
    this.include = zones.filter(z => (z.kind || 'include') === 'include'); // exits only mark doorways
    this.exclude = zones.filter(z => z.kind === 'exclude');
    this.exits = zones.filter(z => z.kind === 'exit');
    this.grace = reconnectGraceS;
    this.rt = new Map(this.include.map(z => [z.id, { raw: false, state: false, since: 0, count: 0, slots: [], prevInside: new Map(), prevExit: new Set(), heldSince: [] }]));
    this.presence = { raw: false, state: false, since: 0 };
    this.available = true;
    this.graceUntil = -Infinity;
    this.lastT = 0;
    this.targetCount = 0;
    this.excludedCount = 0;
  }

  excluded(x, y) {
    for (const z of this.exclude) if (pointInPolygon(x, y, z.polygon)) return true;
    return false;
  }

  /**
   * targets: array of [slot, x, y]. `gone`: slots that disappeared because they
   * merged into another target (multi-radar fusion), not because they vanished.
   * Returns nothing; read snapshot().
   */
  process(t, targets, available = true, gone = null) {
    this.advance(t);
    if (available && !this.available) this.graceUntil = t + this.grace;
    this.available = available;
    const live = t < this.graceUntil ? [] : targets;
    const kept = live.filter(tg => !this.excluded(tg[1], tg[2]));
    const exitSlots = new Set(kept.filter(tg => this.exits.some(e => pointInPolygon(tg[1], tg[2], e.polygon))).map(tg => tg[0]));
    this.targetCount = kept.length;
    this.excludedCount = t >= this.graceUntil ? targets.length - kept.length : 0;
    for (const z of this.include) {
      const rt = this.rt.get(z.id);
      const m = z.filters?.edge_margin_mm || 0;
      let inside;
      if (m > 0) {
        const threshold = rt.raw ? -m : m;
        inside = kept.filter(tg => signedDistance(tg[1], tg[2], z.polygon) >= threshold);
      } else {
        inside = kept.filter(tg => pointInPolygon(tg[1], tg[2], z.polygon));
      }
      rt.slots = inside.map(tg => tg[0]);
      const hold = !!z.filters?.hold_until_exit;
      if (hold && t >= this.graceUntil) this._updateHold(rt, kept, new Set(rt.slots), exitSlots, t, gone);
      else if (!hold) rt.heldSince.length = 0;
      rt.count = inside.length + rt.heldSince.length;
      this._setRaw(rt, inside.length > 0 || rt.heldSince.length > 0, t, z.filters);
    }
    this._setRaw(this.presence, kept.length > 0, t, null);
    this.lastT = t;
  }

  _updateHold(rt, kept, insideSlots, exitSlots, t, gone = null) {
    const cur = new Map(kept.map(tg => [tg[0], insideSlots.has(tg[0])]));
    for (const [slot, wasInside] of rt.prevInside) {
      if (wasInside && !cur.has(slot) && !rt.prevExit.has(slot) && !gone?.includes(slot)) rt.heldSince.push(t);
    }
    for (const slot of cur.keys()) if (!rt.prevInside.has(slot) && rt.heldSince.length && !exitSlots.has(slot)) rt.heldSince.shift();
    rt.prevInside = cur;
    rt.prevExit = exitSlots;
  }

  _expireHolds(rt, t, f) {
    const max = f?.hold_max_s || 0;
    if (max <= 0) return;
    while (rt.heldSince.length && rt.heldSince[0] + max <= t + EPS) {
      const expiredAt = rt.heldSince.shift() + max;
      rt.count -= 1;
      const raw = rt.slots.length > 0 || rt.heldSince.length > 0;
      if (raw !== rt.raw) { rt.raw = raw; rt.since = expiredAt; }
    }
  }

  advance(t) {
    for (const z of this.include) {
      const rt = this.rt.get(z.id);
      this._expireHolds(rt, t, z.filters);
      this._applyDelay(rt, t, z.filters);
    }
    this.lastT = Math.max(this.lastT, t);
  }

  nextDeadline() {
    let best = null;
    for (const z of this.include) {
      const rt = this.rt.get(z.id);
      if (rt.raw !== rt.state) {
        const d = rt.since + (rt.raw ? z.filters?.on_delay_s || 0 : z.filters?.off_delay_s || 0);
        best = best === null ? d : Math.min(best, d);
      }
      const max = z.filters?.hold_max_s || 0;
      if (rt.heldSince.length && max > 0) {
        const d = rt.heldSince[0] + max;
        best = best === null ? d : Math.min(best, d);
      }
    }
    return best;
  }

  _setRaw(rt, raw, t, f) {
    if (raw !== rt.raw) { rt.raw = raw; rt.since = t; }
    this._applyDelay(rt, t, f);
  }

  _applyDelay(rt, t, f) {
    if (rt.raw === rt.state) return;
    const delay = rt.raw ? f?.on_delay_s || 0 : f?.off_delay_s || 0;
    if (t - rt.since >= delay - EPS) rt.state = rt.raw;
  }

  states() {
    const out = { presence: this.presence.state };
    for (const [id, rt] of this.rt) out[id] = rt.state;
    return out;
  }
}

/**
 * Replay packed history (frames/history payload) through an engine.
 * Returns {transitions: [[t, key, state]], perFrame?: Uint8Array per zone}.
 * Times are absolute epoch seconds.
 */
export function replayHistory(hist, zones, reconnectGraceS = 0, { perFrameStates = false } = {}) {
  const eng = new ZoneEngine(zones, reconnectGraceS);
  const keys = [...eng.include.map(z => z.id), 'presence']; // same order as Python
  const prev = Object.fromEntries(keys.map(k => [k, false]));
  const transitions = [];
  const per = perFrameStates ? Object.fromEntries(keys.map(k => [k, new Uint8Array(hist.frame_t.length)])) : null;
  const emit = t => {
    const s = eng.states();
    for (const k of keys) if (s[k] !== prev[k]) { transitions.push([t, k, s[k]]); prev[k] = s[k]; }
  };
  let p = 0;
  const targets = [];
  for (let i = 0; i < hist.frame_t.length; i++) {
    const t = hist.start + hist.frame_t[i];
    let d;
    while ((d = eng.nextDeadline()) !== null && d <= t) { eng.advance(d); emit(d); }
    targets.length = 0;
    for (let k = 0; k < hist.frame_n[i]; k++, p++) targets.push([hist.slot[p], hist.x[p], hist.y[p]]);
    eng.process(t, targets, hist.frame_available ? hist.frame_available[i] === 1 : true);
    emit(t);
    if (per) { const s = eng.states(); for (const k of keys) per[k][i] = s[k] ? 1 : 0; }
  }
  let d;
  while ((d = eng.nextDeadline()) !== null) { eng.advance(d); emit(d); }
  return { transitions, perFrame: per };
}

/** Summarise transitions per key: trigger count, on-intervals, occupied seconds. */
export function summarize(transitions, keys, start, end) {
  const out = Object.fromEntries(keys.map(k => [k, { triggers: [], intervals: [], occupied: 0 }]));
  const onSince = {};
  for (const [t, k, v] of transitions) {
    const s = out[k];
    if (!s) continue;
    if (v) { onSince[k] = t; s.triggers.push(t); }
    else if (onSince[k] !== undefined) { s.intervals.push([onSince[k], t]); s.occupied += t - onSince[k]; delete onSince[k]; }
  }
  for (const [k, t] of Object.entries(onSince)) { out[k].intervals.push([t, end]); out[k].occupied += end - t; }
  return out;
}
