// Shared helpers: units, colours, small geometry utilities.

export const SLOT_COLORS = ['#1e88e5', '#43a047', '#f4511e', '#8e24aa', '#00acc1', '#fdd835'];
export const ZONE_COLORS = ['#3f51b5', '#009688', '#ff9800', '#9c27b0', '#e91e63', '#4caf50', '#795548', '#00bcd4'];
export const EXCLUDE_COLOR = '#757575';
export const EXIT_COLOR = '#8d6e63';
export const LINGER_COLOR = '#5c6bc0';
export const TRANSIENT_COLOR = '#ffa726';
/** Colour of a non-include zone kind, else null. */
export const kindColor = kind => ({ exclude: EXCLUDE_COLOR, exit: EXIT_COLOR, linger: LINGER_COLOR, transient: TRANSIENT_COLOR }[kind] || null);
/** Dash pattern per kind (include: solid). */
export const kindDash = kind => ({ exclude: '6 3', exit: '2 3', linger: '1 3', transient: '8 2 1 2' }[kind] || null);
/** Spots only guide the tracker; they have no state and no entity. */
export const isSpot = kind => kind === 'linger' || kind === 'transient';

export const slotColor = slot => SLOT_COLORS[(slot - 1) % SLOT_COLORS.length];

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Display units: inches/feet when the radar reports inches or HA is imperial, else cm/m. */
export function makeUnits(targetUnit, hass) {
  const imperial = targetUnit === 'in' || targetUnit === 'ft' || (!targetUnit && hass?.config?.unit_system?.length === 'mi');
  if (imperial) {
    return {
      imperial: true,
      label: 'in',
      perMm: 1 / 25.4,
      toDisplay: mm => mm / 25.4,
      fromDisplay: v => v * 25.4,
      fmt: mm => `${Math.round(mm / 25.4)}″`,
      fmtLong: mm => {
        const inches = Math.round(Math.abs(mm) / 25.4);
        const s = mm < 0 ? '−' : '';
        if (inches < 12) return `${s}${inches}″`;
        return inches % 12 ? `${s}${Math.floor(inches / 12)}′ ${inches % 12}″` : `${s}${inches / 12}′`;
      },
      gridSteps: [25.4, 50.8, 152.4, 304.8, 609.6, 1219.2], // 1in 2in 6in 1ft 2ft 4ft
      snapSteps: [25.4, 50.8, 76.2, 152.4],
    };
  }
  return {
    imperial: false,
    label: 'cm',
    perMm: 0.1,
    toDisplay: mm => mm / 10,
    fromDisplay: v => v * 10,
    fmt: mm => `${Math.round(mm / 10)} cm`,
    fmtLong: mm => (Math.abs(mm) >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm / 10)} cm`),
    gridSteps: [10, 50, 100, 250, 500, 1000],
    snapSteps: [10, 50, 100, 250],
  };
}

export function fmtTime(epochS, withSeconds = true, withMs = false) {
  const d = new Date(epochS * 1000);
  const p = n => String(n).padStart(2, '0');
  let s = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (withSeconds) s += `:${p(d.getSeconds())}`;
  if (withMs) s += `.${String(d.getMilliseconds()).padStart(3, '0')}`;
  return s;
}

export function fmtDateTime(epochS) {
  const d = new Date(epochS * 1000);
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} ${fmtTime(epochS)}`;
}

export function fmtDuration(s) {
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Angle of vector a->b in degrees, 0 = +x, CCW positive. */
export const angleDeg = (a, b) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;

/** Interior angle at vertex i of a polygon, degrees (0..360). */
export function interiorAngle(poly, i) {
  const n = poly.length;
  const prev = poly[(i + n - 1) % n], cur = poly[i], next = poly[(i + 1) % n];
  const a1 = Math.atan2(prev[1] - cur[1], prev[0] - cur[0]);
  const a2 = Math.atan2(next[1] - cur[1], next[0] - cur[0]);
  let d = ((a1 - a2) * 180) / Math.PI;
  d = ((d % 360) + 360) % 360;
  // Orientation: make it the interior angle for either winding.
  let area = 0;
  for (let k = 0; k < n; k++) {
    const p = poly[(k + n - 1) % n], q = poly[k];
    area += p[0] * q[1] - q[0] * p[1];
  }
  return area > 0 ? d : 360 - d;
}

/**
 * Snap a candidate point relative to an anchor so the segment anchor->p is at
 * a multiple of `stepDeg`, either absolute or relative to `refAngle` (the
 * previous edge). Returns {point, snapped, label}.
 */
export function snapAngle(anchor, p, refAngle, stepDeg = 45, toleranceDeg = 6) {
  const len = dist(anchor, p);
  if (len < 1) return { point: p, snapped: false };
  const ang = angleDeg(anchor, p);
  const candidates = [];
  for (let a = -180; a <= 180; a += stepDeg) candidates.push({ a, rel: false });
  if (refAngle !== null && refAngle !== undefined) {
    for (let a = -180; a <= 180; a += stepDeg) candidates.push({ a: refAngle + a, rel: true, relA: a });
  }
  let best = null;
  for (const c of candidates) {
    let d = Math.abs((((ang - c.a) % 360) + 540) % 360 - 180);
    // Prefer right angles to the previous edge on near-ties.
    if (c.rel && Math.abs(Math.abs(c.relA) - 90) < 1e-9) d -= 0.5;
    if (d <= toleranceDeg && (!best || d < best.d)) best = { ...c, d };
  }
  if (!best) return { point: p, snapped: false };
  const rad = (best.a * Math.PI) / 180;
  return {
    point: [anchor[0] + len * Math.cos(rad), anchor[1] + len * Math.sin(rad)],
    snapped: true,
    label: best.rel ? `${Math.round(Math.abs(best.relA))}° to edge` : `${Math.round(((best.a % 360) + 360) % 360)}°`,
  };
}

/** Intersection of two infinite lines (p1 + t*d1, p2 + s*d2), or null if parallel. */
export function lineIntersection(p1, d1, p2, d2) {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
  return [p1[0] + t * d1[0], p1[1] + t * d1[1]];
}

export const snapGrid = (p, step) => [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step];

export function newZoneId() {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return 'z' + [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const clone = v => JSON.parse(JSON.stringify(v));

/**
 * View orientation for a radar. `mirror` = the sensor is mounted upside down,
 * which swaps left and right (checked on two upside-down EP Lites, 2026-11);
 * the default follows the device's own `upside_down_mounting` switch when it
 * has one. `rotation` turns the view (any angle, e.g. 45 for a corner mount).
 * View only: zones stay in the sensor's frame, so they flip with the data.
 *
 * Settings saved before v2 never chose a mounting and take the device default.
 */
export function normalizeDisplay(display = {}, { upsideDown = false } = {}) {
  const d = { rotation: 0, mirror: !!upsideDown, ...display };
  if (!display.v) d.mirror = !!upsideDown;
  d.v = 2;
  d.mirror = !!d.mirror;
  d.rotation = ((Number(d.rotation) || 0) % 360 + 360) % 360;
  return d;
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export const SVGNS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
  for (const c of children.flat(Infinity)) if (c) e.append(c);
  return e;
}

/**
 * A door in an exit's threshold rectangle. The width runs along the polygon's
 * longest edge; "in" swings towards `origin` (the radar's side of the
 * threshold), "out" away from it; the hinge sits at end 0 or 1 of the face on
 * the swing side. Returns the bounding rectangle, leaf and swing arc (world
 * mm), or {rect} only for no swing.
 */
export function doorGeometry(poly, door, origin = [0, 0]) {
  let best = 0, u = [1, 0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) { best = l; u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }
  }
  const v = [-u[1], u[0]];
  const dot = (p, d) => p[0] * d[0] + p[1] * d[1];
  const us = poly.map(p => dot(p, u)), vs = poly.map(p => dot(p, v));
  const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
  const P = (a, b) => [u[0] * a + v[0] * b, u[1] * a + v[1] * b];
  const rect = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
  const width = u1 - u0;
  const inSign = dot(origin, v) >= (v0 + v1) / 2 ? 1 : -1;
  if (!door || door.swing === 'none' || !(width > 0)) return { rect, width, inSign };
  const side = door.swing === 'in' ? inSign : -inSign;
  const face = side > 0 ? v1 : v0;
  const hu = door.hinge_end ? u1 : u0, ou = door.hinge_end ? u0 : u1;
  const hinge = P(hu, face), closed = P(ou, face), open = P(hu, face + side * width);
  const arc = [];
  for (let k = 0; k <= 16; k++) {
    const t = (k / 16) * (Math.PI / 2);
    arc.push([hinge[0] + Math.cos(t) * (closed[0] - hinge[0]) + Math.sin(t) * (open[0] - hinge[0]),
      hinge[1] + Math.cos(t) * (closed[1] - hinge[1]) + Math.sin(t) * (open[1] - hinge[1])]);
  }
  return { rect, width, inSign, side, hinge, closed, open, arc };
}

// 2-D affine transforms [[a, b, tx], [c, d, ty]] between radar frames.
export const affineApply = (A, [x, y]) => [A[0][0] * x + A[0][1] * y + A[0][2], A[1][0] * x + A[1][1] * y + A[1][2]];
export const affineMul = (A, B) => [ // A after B
  [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1], A[0][0] * B[0][2] + A[0][1] * B[1][2] + A[0][2]],
  [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1], A[1][0] * B[0][2] + A[1][1] * B[1][2] + A[1][2]],
];
export function affineInvert(A) {
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  const a = A[1][1] / det, b = -A[0][1] / det, c = -A[1][0] / det, d = A[0][0] / det;
  return [[a, b, -(a * A[0][2] + b * A[1][2])], [c, d, -(c * A[0][2] + d * A[1][2])]];
}
/** A radar's saved alignment (display.aligned_to) as the transform from its frame to the reference radar's. */
export function alignmentAffine(al) {
  const r = (al.angle_deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), f = al.reflect ? -1 : 1;
  return [[c * f, -s, al.offset_mm[0]], [s * f, c, al.offset_mm[1]]];
}
/**
 * Transforms from every radar connected to `fromId` through saved alignments
 * into `fromId`'s frame. `radars`: [{radar_id, aligned_to}]. Returns Map id -> affine.
 */
export function radarTransforms(fromId, radars) {
  const edges = new Map(radars.map(r => [r.radar_id, []]));
  for (const r of radars) {
    const al = r.aligned_to;
    if (!al || !edges.has(al.radar_id) || !al.offset_mm) continue;
    const A = alignmentAffine(al); // r -> ref
    edges.get(r.radar_id).push([al.radar_id, A]);
    edges.get(al.radar_id).push([r.radar_id, affineInvert(A)]); // ref -> r
  }
  // BFS: T[id] maps id's frame into fromId's frame.
  const T = new Map([[fromId, [[1, 0, 0], [0, 1, 0]]]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift();
    for (const [next, A] of edges.get(cur) || []) {
      // A maps cur -> next; we need next -> fromId = T[cur] · inverse(A)
      if (T.has(next)) continue;
      T.set(next, affineMul(T.get(cur), affineInvert(A)));
      queue.push(next);
    }
  }
  T.delete(fromId);
  return T;
}
