// Shared helpers: units, colours, small geometry utilities.

export const SLOT_COLORS = ['#1e88e5', '#43a047', '#f4511e', '#8e24aa', '#00acc1', '#fdd835'];
export const ZONE_COLORS = ['#3f51b5', '#009688', '#ff9800', '#9c27b0', '#e91e63', '#4caf50', '#795548', '#00bcd4'];
export const EXCLUDE_COLOR = '#757575';

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
