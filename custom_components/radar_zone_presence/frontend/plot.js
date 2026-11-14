// <rzp-plot>: radar plane with a WebGL point layer and an SVG vector layer
// (grid, field of view, zones, editing handles, targets and trails).
//
// World coordinates are millimetres in the sensor frame (+y out of the
// sensor). The display transform (rotation / mirror / pan / zoom) never
// changes stored geometry.

import { PointLayer } from './points.js';
import {
  EXCLUDE_COLOR, ZONE_COLORS, angleDeg, dist, interiorAngle, lineIntersection, slotColor, snapAngle, snapGrid, svg, fmtTime,
} from './util.js';
import { fovPolygon, pointInPolygon } from './engine.js';

const HANDLE_R = 6;
const SNAP_PX = 10;

const css = `
:host { display: block; position: relative; overflow: hidden; background: var(--rzp-plot-bg, var(--card-background-color, #fff));
  touch-action: none; user-select: none; -webkit-user-select: none; }
canvas, svg { position: absolute; inset: 0; width: 100%; height: 100%; }
svg { overflow: hidden; }
.grid line { stroke: var(--divider-color, #ddd); stroke-width: 1; }
.grid line.major { stroke: var(--secondary-text-color, #999); stroke-opacity: .35; }
.grid text, .ring text { fill: var(--secondary-text-color, #777); font: 11px sans-serif; }
.flip-info { cursor: pointer; pointer-events: all; }
.flip-popover { position: absolute; width: 280px; box-sizing: border-box; padding: 10px 12px; font: 13px/1.4 sans-serif; z-index: 2;
  background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0,0,0,.25); }
.flip-popover p { margin: 6px 0 0; color: var(--secondary-text-color, #555); }
.flip-popover .close { position: absolute; top: 4px; right: 6px; border: 0; background: none; font-size: 18px; cursor: pointer; color: inherit; }
.flip-info circle { fill: var(--card-background-color, #fff); stroke: var(--primary-color, #03a9f4); stroke-width: 1.5; }
.flip-info text { fill: var(--primary-color, #03a9f4); font: italic bold 11px serif; pointer-events: none; }
.fov { fill: var(--primary-color, #03a9f4); fill-opacity: .03; stroke: var(--secondary-text-color, #888); stroke-dasharray: 4 4; stroke-opacity: .6; }
.ring circle { fill: none; stroke: var(--secondary-text-color, #999); stroke-opacity: .25; stroke-dasharray: 2 4; }
.devzone { fill: none; stroke: var(--secondary-text-color, #888); stroke-dasharray: 6 4; stroke-opacity: .8; }
.devzone-label { fill: var(--secondary-text-color, #888); font: 10px sans-serif; }
.zone { cursor: pointer; }
.zone-label { font: 600 12px sans-serif; paint-order: stroke; stroke: var(--card-background-color, #fff); stroke-width: 3px; pointer-events: none; }
.vertex { fill: var(--card-background-color, #fff); stroke-width: 2; cursor: grab; }
.vertex.sel { fill: currentColor; }
.edge-hit { stroke: transparent; stroke-width: 12; cursor: move; }
.edge-hit:hover { stroke: currentColor; stroke-opacity: .25; }
.mid { fill: var(--card-background-color, #fff); stroke-width: 1.5; cursor: copy; opacity: .85; }
.measure-label { font: 11px sans-serif; fill: var(--primary-text-color, #222); paint-order: stroke; stroke: var(--card-background-color, #fff); stroke-width: 3px; pointer-events: none; }
.draft { fill: none; stroke: var(--primary-color, #03a9f4); stroke-width: 2; stroke-dasharray: 5 3; }
.rubber { stroke: var(--primary-color, #03a9f4); stroke-width: 1.5; stroke-dasharray: 3 3; }
.snap-hint { fill: var(--primary-color, #03a9f4); font: 11px sans-serif; paint-order: stroke; stroke: var(--card-background-color, #fff); stroke-width: 3px; }
.target text { font: bold 10px sans-serif; fill: #fff; pointer-events: none; }
.trail-label { font: 10px sans-serif; fill: var(--primary-text-color, #222); paint-order: stroke; stroke: var(--card-background-color, #fff); stroke-width: 3px; pointer-events: none; }
.sensor { fill: var(--primary-text-color, #333); }
.nowebgl { position: absolute; left: 8px; bottom: 8px; font: 12px sans-serif; color: var(--error-color, #c00); }
`;

/** 2D affine: [a, b, c, d, e, f] maps (x, y) -> (a x + c y + e, b x + d y + f). */
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export class RzpPlot extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${css}</style><canvas></canvas><svg tabindex="0"></svg>`;
    this.canvas = root.querySelector('canvas');
    this.svgEl = root.querySelector('svg');
    try {
      this.points = new PointLayer(this.canvas);
    } catch (err) {
      console.error('radar-zone-presence: WebGL init failed', err);
      this.points = { ok: false, setPoints() {}, setFlags() {}, draw() {} };
    }
    if (!this.points.ok) root.append(Object.assign(document.createElement('div'), { className: 'nowebgl', textContent: 'WebGL2 unavailable: point cloud disabled' }));

    // Inputs
    this.units = null;
    this.fov = { max_distance_mm: 6000, half_angle_deg: 60 };
    this.deviceZones = [];
    this.zones = [];
    this.zoneStates = {};
    this.selectedId = null;
    this.selectedVertex = null;
    this.display = { rotation: 0, mirror: false };
    this.tool = 'select';
    this.drawKind = 'include';
    this.snap = { angle: true, grid: false, vertex: true, gridStep: 50.8 };
    this.showMeasurements = true;
    this.window = { t0: 0, t1: Infinity };
    this.cursor = -1;
    this.trailSeconds = 30;
    this.colorMode = 0;
    this.targets = []; // [[slot, x, y]]
    this.trails = new Map(); // slot -> [{x, y, t}]
    this.trailLabels = false;
    this.readonly = false; // dashboard card: no editing, no wheel capture
    this.showContext = true; // faded full cloud behind the replay trail
    this.suggestions = []; // [{polygon, kind: 'spot'|'ghost'|..., label, active}] dashed overlays
    this.edgeWarnings = []; // [{a, b, label}] zone edges that targets flap across

    // View
    this.scale = 0.08; // px per mm
    this.pan = [0, 2500]; // display-space centre (mm)
    this._fitted = false;

    // Interaction state
    this._drag = null;
    this._draft = null; // polygon being drawn
    this._hover = null; // world point under cursor (snapped)
    this._hint = null;
    this._measure = null;
    this._raf = 0;

    this.svgEl.addEventListener('pointerdown', e => this._onDown(e));
    this.svgEl.addEventListener('pointermove', e => this._onMove(e));
    this.svgEl.addEventListener('pointerup', e => this._onUp(e));
    this.svgEl.addEventListener('pointercancel', e => this._onUp(e));
    this.svgEl.addEventListener('lostpointercapture', e => { if (this._drag) this._onUp(e); });
    this.svgEl.addEventListener('dblclick', e => this._onDbl(e));
    this.svgEl.addEventListener('wheel', e => this._onWheel(e), { passive: false });
    this.svgEl.addEventListener('keydown', e => this._onKey(e));
    this.svgEl.addEventListener('pointerleave', () => { this._hover = null; this.requestRender(); });
    this._ro = new ResizeObserver(() => { if (!this._userView) this.fit(); this.requestRender(); });
  }

  connectedCallback() { this._ro.observe(this); this.requestRender(); }
  disconnectedCallback() { this._ro.disconnect(); cancelAnimationFrame(this._raf); }

  // ------------------------------------------------------------ public API

  set(props) {
    Object.assign(this, props);
    if (!this._fitted && this.clientWidth) this.fit();
    this.requestRender();
  }

  setHistory(points) {
    this.points.setPoints(points);
    this._pointData = points;
    this.requestRender();
  }

  /** Recompute per-point highlight flags for the selected zone (0 outside, 1 inside, 2 excluded). */
  updateFlags(zone, excludeZones) {
    const pts = this._pointData;
    if (!pts) return;
    const n = pts.t.length;
    const flags = new Float32Array(n);
    const pos = pts.pos;
    for (let i = 0; i < n; i++) {
      const x = pos[2 * i], y = pos[2 * i + 1];
      let excluded = false;
      for (const ez of excludeZones) if (pointInPolygon(x, y, ez.polygon)) { excluded = true; break; }
      flags[i] = excluded ? 2 : zone && pointInPolygon(x, y, zone.polygon) ? 1 : 0;
    }
    this.points.setFlags(flags);
    this.requestRender();
  }

  fit() {
    const w = this.clientWidth, h = this.clientHeight;
    if (!w || !h) return;
    const pts = fovPolygon(this.fov.max_distance_mm, this.fov.half_angle_deg, 12);
    for (const z of this.zones) pts.push(...z.polygon);
    const disp = pts.map(p => this._toDisplay(p));
    const xs = disp.map(p => p[0]), ys = disp.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const margin = 36;
    this.scale = Math.min((w - 2 * margin) / Math.max(1, maxX - minX), (h - 2 * margin) / Math.max(1, maxY - minY));
    this.pan = [(minX + maxX) / 2, (minY + maxY) / 2];
    this._fitted = true;
    this._userView = false;
    this.requestRender();
  }

  zoomBy(f) {
    this.scale = Math.max(0.005, Math.min(5, this.scale * f));
    this.requestRender();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  // --------------------------------------------------------------- geometry

  _toDisplay(p) {
    let [u, v] = p;
    if (this.display.mirror) u = -u;
    const r = ((this.display.rotation || 0) * Math.PI) / 180;
    return [u * Math.cos(r) - v * Math.sin(r), u * Math.sin(r) + v * Math.cos(r)];
  }

  /** world -> screen affine */
  _matrix() {
    const r = ((this.display.rotation || 0) * Math.PI) / 180;
    const m = this.display.mirror ? -1 : 1;
    const s = this.scale;
    const cx = this.clientWidth / 2, cy = this.clientHeight / 2;
    // display = R * diag(m, 1) * world; screen = (cx + s (dx - panx), cy - s (dy - pany))
    const a = s * Math.cos(r) * m, c = -s * Math.sin(r);
    const b = -s * Math.sin(r) * m, d = -s * Math.cos(r);
    return [a, b, c, d, cx - s * this.pan[0], cy + s * this.pan[1]];
  }

  _s(p) { return apply(this._mat, p); }
  _w(sx, sy) { return apply(invert(this._mat), [sx, sy]); }

  _eventWorld(e) {
    const r = this.svgEl.getBoundingClientRect();
    return this._w(e.clientX - r.left, e.clientY - r.top);
  }

  _pxToMm(px) { return px / this.scale; }

  // --------------------------------------------------------------- snapping

  _allVertices(excludeZoneId, excludeIndex) {
    const out = [[0, 0]];
    for (const z of this.zones) z.polygon.forEach((p, i) => { if (!(z.id === excludeZoneId && i === excludeIndex)) out.push(p); });
    for (const dz of this.deviceZones) out.push(...dz.polygon);
    return out;
  }

  _snapVertex(p, excludeZoneId, excludeIndex) {
    let best = null, bestD = this._pxToMm(SNAP_PX);
    for (const v of this._allVertices(excludeZoneId, excludeIndex)) {
      const d = dist(p, v);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  /** Snap a point for drawing: vertex > angle (relative to previous edge) > grid. */
  _snapDraw(p, e) {
    this._hint = null;
    if (e?.shiftKey) return p;
    if (this.snap.vertex) {
      const v = this._snapVertex(p);
      if (v) { this._hint = { at: v, text: 'vertex' }; return [...v]; }
    }
    const pts = this._draft?.points || [];
    if (this.snap.angle && pts.length) {
      const last = pts[pts.length - 1];
      const ref = pts.length >= 2 ? angleDeg(pts[pts.length - 2], last) : null;
      let q = p;
      if (this.snap.grid) q = snapGrid(p, this.snap.gridStep);
      const r = snapAngle(last, q, ref, 45, 6);
      if (r.snapped) {
        // Also try to land on a right angle with the first edge when closing the shape.
        if (pts.length >= 2) {
          const first = pts[0];
          const r2 = snapAngle(first, r.point, angleDeg(pts[1], first), 90, 6);
          if (r2.snapped) {
            const d1 = [r.point[0] - last[0], r.point[1] - last[1]];
            const d2 = [r2.point[0] - first[0], r2.point[1] - first[1]];
            const x = lineIntersection(last, d1, first, d2);
            if (x && dist(x, p) < this._pxToMm(SNAP_PX * 2)) {
              this._hint = { at: x, text: `${r.label} · square to start` };
              return x;
            }
          }
        }
        this._hint = { at: r.point, text: r.label };
        return r.point;
      }
    }
    if (this.snap.grid) return snapGrid(p, this.snap.gridStep);
    return p;
  }

  /** Snap a dragged vertex using both neighbours' edges. */
  _snapDragVertex(zone, idx, p, e) {
    this._hint = null;
    if (e?.shiftKey) return p;
    if (this.snap.vertex) {
      const v = this._snapVertex(p, zone.id, idx);
      if (v) { this._hint = { at: v, text: 'vertex' }; return [...v]; }
    }
    const poly = zone.polygon, n = poly.length;
    if (this.snap.grid) p = snapGrid(p, this.snap.gridStep);
    if (!this.snap.angle || n < 3) return p;
    const prev = poly[(idx + n - 1) % n], prev2 = poly[(idx + n - 2) % n];
    const next = poly[(idx + 1) % n], next2 = poly[(idx + 2) % n];
    const a = snapAngle(prev, p, angleDeg(prev2, prev), 45, 6);
    const b = snapAngle(next, p, angleDeg(next2, next), 45, 6);
    if (a.snapped && b.snapped) {
      const x = lineIntersection(prev, [a.point[0] - prev[0], a.point[1] - prev[1]], next, [b.point[0] - next[0], b.point[1] - next[1]]);
      if (x && dist(x, p) < this._pxToMm(SNAP_PX * 2)) { this._hint = { at: x, text: `${a.label} · ${b.label}` }; return x; }
    }
    const best = [a, b].filter(r => r.snapped).sort((r1, r2) => dist(r1.point, p) - dist(r2.point, p))[0];
    if (best) { this._hint = { at: best.point, text: best.label }; return best.point; }
    return p;
  }

  // ----------------------------------------------------------- interaction

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true })); }

  _zone(id) { return this.zones.find(z => z.id === id); }

  _changeZones(zones, commit) { this.zones = zones; this._emit('zones-change', { zones, commit }); this.requestRender(); }

  _onDown(e) {
    if (e.target.closest?.('.flip-info')) { e.stopPropagation(); this._toggleFlipInfo(); return; }
    if (this._flipPopover) this._toggleFlipInfo(false);
    if (this.readonly) return;
    this.svgEl.focus();
    const w = this._eventWorld(e);
    const t = e.target;
    const role = t.dataset?.role;
    this.svgEl.setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && e.altKey)) { this._drag = { kind: 'pan', start: [e.clientX, e.clientY], pan: [...this.pan] }; return; }

    if (this.tool === 'draw') {
      const p = this._snapDraw(w, e);
      if (!this._draft) this._draft = { points: [] };
      const pts = this._draft.points;
      if (pts.length >= 3 && dist(this._s(p), this._s(pts[0])) <= SNAP_PX) { this._finishDraft(); return; }
      pts.push(p);
      this.requestRender();
      return;
    }
    if (this.tool === 'rect') { const p = this._snapDraw(w, e); this._drag = { kind: 'rect', start: p, end: p }; return; }
    if (this.tool === 'measure') { const p = this._snapDraw(w, e); this._measure = { a: p, b: p }; this._drag = { kind: 'measure' }; return; }

    if (role === 'vertex') {
      const zone = this._zone(t.dataset.zone);
      const idx = +t.dataset.idx;
      this.selectedId = zone.id;
      this.selectedVertex = idx;
      this._emit('select', { zoneId: zone.id, vertex: idx });
      this._drag = { kind: 'vertex', zoneId: zone.id, idx, moved: false };
      return;
    }
    if (role === 'edge') {
      const zone = this._zone(t.dataset.zone);
      const idx = +t.dataset.idx;
      this.selectedVertex = null;
      this._drag = { kind: 'edge', zoneId: zone.id, idx, start: w, orig: zone.polygon.map(p => [...p]), moved: false };
      return;
    }
    if (role === 'mid') {
      const zone = this._zone(t.dataset.zone);
      const idx = +t.dataset.idx; // insert after idx
      const zones = this.zones.map(z => (z.id === zone.id ? { ...z, polygon: [...z.polygon.slice(0, idx + 1), w, ...z.polygon.slice(idx + 1)] } : z));
      this._changeZones(zones, false);
      this.selectedVertex = idx + 1;
      this._emit('select', { zoneId: zone.id, vertex: idx + 1 });
      this._drag = { kind: 'vertex', zoneId: zone.id, idx: idx + 1, moved: true };
      return;
    }
    if (role === 'zone') {
      const id = t.dataset.zone;
      const wasSelected = this.selectedId === id;
      this.selectedId = id;
      this.selectedVertex = null;
      this._emit('select', { zoneId: id, vertex: null });
      this._drag = wasSelected
        ? { kind: 'move', zoneId: id, start: w, orig: this._zone(id).polygon.map(p => [...p]), moved: false }
        : { kind: 'pan', start: [e.clientX, e.clientY], pan: [...this.pan], click: true };
      this.requestRender();
      return;
    }
    // Background: deselect on click, pan on drag.
    this._drag = { kind: 'pan', start: [e.clientX, e.clientY], pan: [...this.pan], click: true, deselect: true };
  }

  _onMove(e) {
    const w = this._eventWorld(e);
    this._emit('pointer-world', { x: w[0], y: w[1] });
    const d = this._drag;
    if (!d) {
      if (this.tool === 'draw' || this.tool === 'rect' || this.tool === 'measure') { this._hover = this._snapDraw(w, e); this.requestRender(); }
      return;
    }
    if (d.kind === 'pan') {
      const dx = e.clientX - d.start[0], dy = e.clientY - d.start[1];
      if (Math.hypot(dx, dy) > 3) d.click = false;
      // Screen delta -> display delta (display y is up).
      this.pan = [d.pan[0] - dx / this.scale, d.pan[1] + dy / this.scale];
      if (!d.click) this._userView = true;
      this.requestRender();
    } else if (d.kind === 'vertex') {
      const zone = this._zone(d.zoneId);
      const p = this._snapDragVertex(zone, d.idx, w, e);
      d.moved = true;
      this._changeZones(this.zones.map(z => (z.id === d.zoneId ? { ...z, polygon: z.polygon.map((q, i) => (i === d.idx ? p : q)) } : z)), false);
    } else if (d.kind === 'edge') {
      // Move the edge parallel to itself (both endpoints), keeping neighbouring angles' edges' directions.
      const n = d.orig.length, a = d.orig[d.idx], b = d.orig[(d.idx + 1) % n];
      let dx = w[0] - d.start[0], dy = w[1] - d.start[1];
      if (!e.shiftKey) {
        const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey) || 1;
        const nx = -ey / len, ny = ex / len;
        let k = dx * nx + dy * ny;
        if (this.snap.grid) k = Math.round(k / this.snap.gridStep) * this.snap.gridStep;
        dx = k * nx; dy = k * ny;
        this._hint = { at: w, text: `moved ${this.units ? this.units.fmtLong(Math.abs(k)) : Math.round(k)}` };
      }
      d.moved = true;
      const i1 = d.idx, i2 = (d.idx + 1) % n;
      this._changeZones(this.zones.map(z => (z.id === d.zoneId ? { ...z, polygon: d.orig.map((p, i) => (i === i1 || i === i2 ? [p[0] + dx, p[1] + dy] : p)) } : z)), false);
    } else if (d.kind === 'move') {
      let dx = w[0] - d.start[0], dy = w[1] - d.start[1];
      if (this.snap.grid && !e.shiftKey) [dx, dy] = snapGrid([dx, dy], this.snap.gridStep);
      d.moved = true;
      this._changeZones(this.zones.map(z => (z.id === d.zoneId ? { ...z, polygon: d.orig.map(p => [p[0] + dx, p[1] + dy]) } : z)), false);
    } else if (d.kind === 'rect') {
      d.end = e.shiftKey ? w : this.snap.grid ? snapGrid(w, this.snap.gridStep) : w;
      this.requestRender();
    } else if (d.kind === 'measure') {
      this._measure.b = this._snapDraw(w, e);
      this.requestRender();
    }
  }

  _onUp(e) {
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    if (d.kind === 'pan' && d.click && d.deselect) {
      this.selectedId = null;
      this.selectedVertex = null;
      this._emit('select', { zoneId: null, vertex: null });
    }
    if ((d.kind === 'vertex' || d.kind === 'move' || d.kind === 'edge') && d.moved) this._changeZones(this.zones, true);
    if (d.kind === 'rect') {
      const [x0, y0] = d.start, [x1, y1] = d.end;
      if (Math.abs(x1 - x0) > this._pxToMm(4) && Math.abs(y1 - y0) > this._pxToMm(4)) {
        this._emit('zone-drawn', { polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], kind: this.drawKind });
      }
    }
    this._hint = null;
    this.requestRender();
  }

  _onDbl(e) {
    if (this.readonly) return;
    const t = e.target;
    if (this.tool === 'draw') { this._finishDraft(); return; }
    if (t.dataset?.role === 'vertex') {
      const zone = this._zone(t.dataset.zone);
      if (zone.polygon.length <= 3) return;
      const idx = +t.dataset.idx;
      this.selectedVertex = null;
      this._changeZones(this.zones.map(z => (z.id === zone.id ? { ...z, polygon: z.polygon.filter((_, i) => i !== idx) } : z)), true);
    }
  }

  _onWheel(e) {
    if (this.readonly) return;
    e.preventDefault();
    const r = this.svgEl.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const before = this._toDisplay(this._w(sx, sy));
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    this.scale = Math.max(0.005, Math.min(5, this.scale * f));
    this._userView = true;
    // Keep the point under the cursor fixed.
    const cx = this.clientWidth / 2, cy = this.clientHeight / 2;
    this.pan = [before[0] - (sx - cx) / this.scale, before[1] + (sy - cy) / this.scale];
    this.requestRender();
  }

  _onKey(e) {
    if (this.tool === 'draw' && this._draft) {
      if (e.key === 'Enter') { this._finishDraft(); e.preventDefault(); }
      else if (e.key === 'Escape') { this._draft = null; this.requestRender(); }
      else if (e.key === 'Backspace') { this._draft.points.pop(); if (!this._draft.points.length) this._draft = null; this.requestRender(); e.preventDefault(); }
      return;
    }
    if (e.key === 'Escape') {
      if (this.tool !== 'select') this._emit('tool', { tool: 'select' });
      this.selectedVertex = null;
      this._measure = null;
      this.requestRender();
      return;
    }
    const zone = this._zone(this.selectedId);
    if (!zone || this.selectedVertex === null || this.selectedVertex === undefined) return;
    const idx = this.selectedVertex;
    if ((e.key === 'Delete' || e.key === 'Backspace') && zone.polygon.length > 3) {
      this.selectedVertex = null;
      this._changeZones(this.zones.map(z => (z.id === zone.id ? { ...z, polygon: z.polygon.filter((_, i) => i !== idx) } : z)), true);
      e.preventDefault();
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (arrows[e.key]) {
      // Nudge in screen directions, converted to world.
      const step = (e.shiftKey ? 10 : 1) * (this.units?.imperial ? 25.4 : 10);
      const [dx, dy] = arrows[e.key];
      const p = zone.polygon[idx];
      const sp = this._s(p);
      const unit = this._w(sp[0] + dx, sp[1] - dy);
      const dir = [unit[0] - p[0], unit[1] - p[1]];
      const len = Math.hypot(...dir) || 1;
      const q = [p[0] + (dir[0] / len) * step, p[1] + (dir[1] / len) * step];
      this._changeZones(this.zones.map(z => (z.id === zone.id ? { ...z, polygon: z.polygon.map((v, i) => (i === idx ? q : v)) } : z)), true);
      e.preventDefault();
    }
  }

  _finishDraft() {
    const pts = this._draft?.points || [];
    this._draft = null;
    this._hint = null;
    if (pts.length >= 3) this._emit('zone-drawn', { polygon: pts, kind: this.drawKind });
    this.requestRender();
  }

  cancelDraft() { this._draft = null; this._measure = null; this.requestRender(); }

  // ---------------------------------------------------------------- render

  _viewMatrixGL() {
    // clip = C * M, column-major mat3
    const m = this._mat, w = this.clientWidth, h = this.clientHeight;
    const a = (2 / w) * m[0], b = (-2 / h) * m[1], c = (2 / w) * m[2], d = (-2 / h) * m[3];
    const e = (2 / w) * m[4] - 1, f = 1 - (2 / h) * m[5];
    return new Float32Array([a, b, 0, c, d, 0, e, f, 1]);
  }

  _render() {
    const w = this.clientWidth, h = this.clientHeight;
    if (!w || !h) return;
    this._mat = this._matrix();
    this.points.draw({ view: this._viewMatrixGL(), window: this.window, cursor: this.cursor, trail: this.trailSeconds, colorMode: this.colorMode, context: this.showContext });

    const root = this.svgEl;
    root.replaceChildren();
    root.append(this._defs());
    root.append(this._grid(w, h));
    root.append(this._fovLayer());
    root.append(this._deviceZoneLayer());
    root.append(this._suggestionLayer());
    root.append(this._zoneLayer());
    root.append(this._trailLayer());
    root.append(this._sensor());
    root.append(this._toolLayer());
  }

  _defs() {
    return svg('defs', {},
      svg('pattern', { id: 'hatch', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        svg('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: EXCLUDE_COLOR, 'stroke-width': 2, 'stroke-opacity': 0.45 })));
  }

  _grid(w, h) {
    const g = svg('g', { class: 'grid' });
    const steps = this.units?.gridSteps || [10, 50, 100, 250, 500, 1000];
    const step = steps.find(s => s * this.scale >= 28) || steps[steps.length - 1] * Math.ceil(28 / (steps[steps.length - 1] * this.scale));
    const majorEvery = this.units?.imperial ? Math.round(304.8 / step) || 1 : Math.round(1000 / step) || 1;
    // Bounds of the visible area in world coordinates.
    const corners = [this._w(0, 0), this._w(w, 0), this._w(0, h), this._w(w, h)];
    const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
    const x0 = Math.floor(Math.min(...xs) / step), x1 = Math.ceil(Math.max(...xs) / step);
    const y0 = Math.floor(Math.min(...ys) / step), y1 = Math.ceil(Math.max(...ys) / step);
    if ((x1 - x0) + (y1 - y0) > 600) return g;
    const label = mm => (this.units ? this.units.fmtLong(mm) : `${mm}`);
    for (let i = x0; i <= x1; i++) {
      const a = this._s([i * step, y0 * step]), b = this._s([i * step, y1 * step]);
      const major = i % majorEvery === 0;
      g.append(svg('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: major ? 'major' : '' }));
    }
    for (let j = y0; j <= y1; j++) {
      const a = this._s([x0 * step, j * step]), b = this._s([x1 * step, j * step]);
      const major = j % majorEvery === 0;
      g.append(svg('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: major ? 'major' : '' }));
    }
    // Axis labels along the sensor's x and y axes (major lines only).
    for (let i = x0; i <= x1; i++) {
      if (i % majorEvery || i === 0) continue;
      const p = this._s([i * step, 0]);
      if (p[0] > 0 && p[0] < w && p[1] > 0 && p[1] < h) g.append(svg('text', { x: p[0] + 2, y: p[1] + 12 }, document.createTextNode(label(i * step))));
    }
    for (let j = y0; j <= y1; j++) {
      if (j % majorEvery || j === 0) continue;
      const p = this._s([0, j * step]);
      if (p[0] > 0 && p[0] < w && p[1] > 0 && p[1] < h) g.append(svg('text', { x: p[0] + 3, y: p[1] - 3 }, document.createTextNode(label(j * step))));
    }
    if (this.display.mirror) g.append(this._flipInfo(x0, x1, step, w, h));
    else if (this._flipPopover) this._toggleFlipInfo(false);
    return g;
  }

  /** ⓘ on the X axis of a flipped view, explaining why its values count up to the left. */
  _flipInfo(x0, x1, step, w, h) {
    let best = null;
    for (let i = x0; i <= x1; i++) {
      const p = this._s([i * step, 0]);
      if (p[0] > 16 && p[0] < w - 16 && p[1] > 16 && p[1] < h - 16 && (!best || p[0] > best[0])) best = p;
    }
    const g = svg('g', { class: 'flip-info' });
    if (!best) return g;
    const [cx, cy] = [best[0] - 4, best[1] - 14];
    this._flipInfoAt = [cx, cy];
    if (this._flipPopover) this._placeFlipPopover();
    g.append(
      svg('title', {}, document.createTextNode('Sensor mounted upside down: click for details')),
      svg('circle', { cx, cy, r: 7 }),
      svg('text', { x: cx, y: cy + 3.5, 'text-anchor': 'middle' }, document.createTextNode('i')));
    return g;
  }

  /** Click on the ⓘ: a small popover explaining the flipped axis. */
  _toggleFlipInfo(open = !this._flipPopover) {
    if (!open) { this._flipPopover?.remove(); this._flipPopover = null; return; }
    const box = document.createElement('div');
    box.className = 'flip-popover';
    box.innerHTML = `<button class="close" title="Close">×</button><b>Sensor mounted upside down</b>
      <p>Left and right are swapped, so the map shows the room as seen from behind the sensor.</p>
      <p>The X axis keeps the sensor's own coordinates, so its values count up to the left. Zones are not affected.</p>
      <p>Set under Sensor settings → Mounting (it follows the device's own upside-down setting by default).</p>`;
    box.addEventListener('pointerdown', e => e.stopPropagation());
    box.querySelector('.close').addEventListener('click', () => this._toggleFlipInfo(false));
    this.shadowRoot.append(box);
    this._flipPopover = box;
    this._placeFlipPopover();
  }

  _placeFlipPopover() {
    const box = this._flipPopover;
    if (!box || !this._flipInfoAt) return;
    const [cx, cy] = this._flipInfoAt;
    const w = 280;
    box.style.left = `${Math.max(8, Math.min(this.clientWidth - w - 8, cx - w + 20))}px`;
    box.style.bottom = `${Math.max(8, this.clientHeight - cy + 12)}px`;
  }

  _path(poly, close = true) {
    if (!poly.length) return '';
    return poly.map((p, i) => { const s = this._s(p); return `${i ? 'L' : 'M'}${s[0].toFixed(1)},${s[1].toFixed(1)}`; }).join('') + (close ? 'Z' : '');
  }

  _fovLayer() {
    const g = svg('g');
    g.append(svg('path', { class: 'fov', d: this._path(fovPolygon(this.fov.max_distance_mm, this.fov.half_angle_deg, 48)) }));
    const rings = svg('g', { class: 'ring' });
    const step = this.units?.imperial ? 1219.2 : 1000; // 4 ft / 1 m
    const o = this._s([0, 0]);
    for (let r = step; r <= this.fov.max_distance_mm + 1; r += step) {
      rings.append(svg('circle', { cx: o[0], cy: o[1], r: r * this.scale }));
      const lp = this._s([0, r]);
      rings.append(svg('text', { x: lp[0] + 3, y: lp[1] - 3 }, document.createTextNode(this.units ? this.units.fmtLong(r) : `${r}`)));
    }
    g.append(rings);
    return g;
  }

  _deviceZoneLayer() {
    const g = svg('g');
    for (const dz of this.deviceZones) {
      g.append(svg('path', { class: 'devzone', d: this._path(dz.polygon) }));
      const s = this._s(dz.polygon[3]);
      g.append(svg('text', { class: 'devzone-label', x: s[0] + 3, y: s[1] + 11 }, document.createTextNode(`device ${dz.key.replace(/_/g, ' ')}`)));
    }
    return g;
  }

  _suggestionLayer() {
    const g = svg('g', { style: 'pointer-events:none' });
    for (const sg of this.suggestions || []) {
      if (!sg.polygon || sg.polygon.length < 3) continue;
      const color = sg.kind === 'ghost' ? EXCLUDE_COLOR : sg.kind === 'fit' ? 'var(--primary-color, #03a9f4)' : '#f9a825';
      g.append(svg('path', {
        d: this._path(sg.polygon), fill: color, 'fill-opacity': sg.active ? 0.18 : 0.05,
        stroke: color, 'stroke-width': sg.active ? 2.5 : 1.5, 'stroke-dasharray': '5 4',
      }));
      if (sg.label && sg.polygon) {
        const top = sg.polygon.reduce((a, p) => (this._s(p)[1] < this._s(a)[1] ? p : a), sg.polygon[0]);
        const s = this._s(top);
        g.append(svg('text', { class: 'zone-label', x: s[0], y: s[1] - 6, 'text-anchor': 'middle', fill: color }, document.createTextNode(sg.label)));
      }
    }
    for (const w of this.edgeWarnings || []) {
      const a = this._s(w.a), b = this._s(w.b);
      g.append(svg('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: '#e53935', 'stroke-width': 7, 'stroke-opacity': 0.45, 'stroke-linecap': 'round' }));
      g.append(svg('text', { class: 'zone-label', x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 - 8, 'text-anchor': 'middle', fill: '#e53935' }, document.createTextNode(w.label)));
    }
    return g;
  }

  _zoneColor(z, i) {
    return z.kind === 'exclude' ? EXCLUDE_COLOR : ZONE_COLORS[i % ZONE_COLORS.length];
  }

  _zoneLayer() {
    const g = svg('g');
    const selected = [];
    this.zones.forEach((z, i) => {
      const color = this._zoneColor(z, i);
      const on = !!this.zoneStates[z.id];
      const isSel = z.id === this.selectedId;
      const attrs = {
        class: 'zone', d: this._path(z.polygon), 'data-role': 'zone', 'data-zone': z.id,
        stroke: color, 'stroke-width': isSel ? 2.5 : 1.5,
        fill: z.kind === 'exclude' ? 'url(#hatch)' : color,
        'fill-opacity': z.kind === 'exclude' ? 1 : on ? 0.35 : 0.1,
        'stroke-dasharray': z.kind === 'exclude' ? '6 3' : null,
      };
      g.append(svg('path', attrs));
      // Label at the centroid of the vertices.
      const c = z.polygon.reduce((a, p) => [a[0] + p[0] / z.polygon.length, a[1] + p[1] / z.polygon.length], [0, 0]);
      const s = this._s(c);
      g.append(svg('text', { class: 'zone-label', x: s[0], y: s[1], 'text-anchor': 'middle', fill: color },
        document.createTextNode(`${z.name}${z.kind === 'include' && on ? ' ●' : ''}`)));
      if (isSel) selected.push([z, color]);
    });
    for (const [z, color] of selected) g.append(this._handles(z, color));
    return g;
  }

  _handles(z, color) {
    const g = svg('g', { style: `color:${color}` });
    const n = z.polygon.length;
    const units = this.units;
    z.polygon.forEach((p, i) => {
      const q = z.polygon[(i + 1) % n];
      const a = this._s(p), b = this._s(q);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if (this.showMeasurements && units) {
        // Edge length, offset perpendicular to the edge.
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
        if (len > 40) g.append(svg('text', { class: 'measure-label', x: mx + nx * 12, y: my + ny * 12 + 4, 'text-anchor': 'middle' }, document.createTextNode(units.fmtLong(dist(p, q)))));
      }
      g.append(svg('line', { class: 'edge-hit', x1: a[0], y1: a[1], x2: b[0], y2: b[1], 'data-role': 'edge', 'data-zone': z.id, 'data-idx': i }));
      g.append(svg('rect', { class: 'mid', x: mx - 4, y: my - 4, width: 8, height: 8, stroke: color, 'data-role': 'mid', 'data-zone': z.id, 'data-idx': i }));
    });
    z.polygon.forEach((p, i) => {
      const s = this._s(p);
      if (this.showMeasurements) {
        const ang = interiorAngle(z.polygon, i);
        const c = z.polygon.reduce((acc, v) => [acc[0] + v[0] / n, acc[1] + v[1] / n], [0, 0]);
        const sc = this._s(c);
        const dx = sc[0] - s[0], dy = sc[1] - s[1], l = Math.hypot(dx, dy) || 1;
        const txt = Math.abs(ang - 90) < 0.5 || Math.abs(ang - 270) < 0.5 ? `${Math.round(ang)}° ⟂` : `${ang.toFixed(1)}°`;
        g.append(svg('text', { class: 'measure-label', x: s[0] + (dx / l) * 22, y: s[1] + (dy / l) * 22 + 4, 'text-anchor': 'middle' }, document.createTextNode(txt)));
      }
      g.append(svg('circle', { class: `vertex${i === this.selectedVertex ? ' sel' : ''}`, cx: s[0], cy: s[1], r: HANDLE_R, stroke: color, 'data-role': 'vertex', 'data-zone': z.id, 'data-idx': i }));
    });
    return g;
  }

  _trailLayer() {
    const g = svg('g', { 'pointer-events': 'none' });
    const tNow = this.cursor >= 0 ? null : Date.now() / 1000;
    for (const [slot, pts] of this.trails) {
      if (pts.length < 2) continue;
      const color = slotColor(slot);
      const tEnd = pts[pts.length - 1].t;
      for (let i = 1; i < pts.length; i++) {
        const age = tEnd - pts[i].t;
        const k = Math.max(0.08, 1 - age / this.trailSeconds);
        const a = this._s([pts[i - 1].x, pts[i - 1].y]), b = this._s([pts[i].x, pts[i].y]);
        if (pts[i].t - pts[i - 1].t > 3) continue; // gap in detection
        g.append(svg('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: color, 'stroke-width': 1 + 2 * k, 'stroke-opacity': k, 'stroke-linecap': 'round' }));
      }
      // Arrowhead on the newest segment shows the direction of travel.
      {
        const a = pts[pts.length - 2], b = pts[pts.length - 1];
        const sa = this._s([a.x, a.y]), sb = this._s([b.x, b.y]);
        const len = Math.hypot(sb[0] - sa[0], sb[1] - sa[1]);
        if (len > 2 && b.t - a.t < 3) {
          const ux = (sb[0] - sa[0]) / len, uy = (sb[1] - sa[1]) / len;
          const tip = [sb[0] + ux * 14, sb[1] + uy * 14];
          const l = [tip[0] - ux * 8 - uy * 5, tip[1] - uy * 8 + ux * 5], r = [tip[0] - ux * 8 + uy * 5, tip[1] - uy * 8 - ux * 5];
          g.append(svg('polygon', { points: `${tip.join(',')} ${l.join(',')} ${r.join(',')}`, fill: color }));
        }
      }
      if (this.trailLabels) {
        let last = null;
        for (let k = pts.length - 1; k >= 0; k--) {
          const p = pts[k];
          const s = this._s([p.x, p.y]);
          if (last && Math.hypot(s[0] - last[0], s[1] - last[1]) < 28) continue;
          last = s;
          g.append(svg('circle', { cx: s[0], cy: s[1], r: 2.5, fill: color }));
          g.append(svg('text', { class: 'trail-label', x: s[0] + 5, y: s[1] - 5 }, document.createTextNode(fmtTime(p.t, true, true).slice(3))));
        }
      }
    }
    void tNow;
    for (const [slot, x, y] of this.targets) {
      const s = this._s([x, y]);
      const tg = svg('g', { class: 'target' });
      tg.append(svg('circle', { cx: s[0], cy: s[1], r: 9, fill: slotColor(slot), stroke: '#fff', 'stroke-width': 2 }));
      tg.append(svg('text', { x: s[0], y: s[1] + 3.5, 'text-anchor': 'middle' }, document.createTextNode(String(slot))));
      g.append(tg);
    }
    return g;
  }

  _sensor() {
    const o = this._s([0, 0]);
    const f = this._s([0, this._pxToMm(14)]);
    const ang = Math.atan2(f[1] - o[1], f[0] - o[0]);
    const pt = (r, a) => `${o[0] + r * Math.cos(a)},${o[1] + r * Math.sin(a)}`;
    return svg('polygon', { class: 'sensor', points: [pt(12, ang), pt(8, ang + 2.4), pt(8, ang - 2.4)].join(' ') });
  }

  _toolLayer() {
    const g = svg('g', { 'pointer-events': 'none' });
    const units = this.units;
    const drawTip = (from, to) => {
      if (!units) return;
      const a = this._s(from), b = this._s(to);
      const ang = ((angleDeg(from, to) % 360) + 360) % 360;
      g.append(svg('text', { class: 'measure-label', x: (a[0] + b[0]) / 2 + 8, y: (a[1] + b[1]) / 2 - 8 }, document.createTextNode(`${units.fmtLong(dist(from, to))} · ${ang.toFixed(0)}°`)));
    };
    if (this._draft?.points.length) {
      const pts = this._draft.points;
      g.append(svg('path', { class: 'draft', d: this._path(pts, false) }));
      for (const p of pts) { const s = this._s(p); g.append(svg('circle', { cx: s[0], cy: s[1], r: 4, fill: 'var(--primary-color, #03a9f4)' })); }
      if (this._hover) {
        const a = this._s(pts[pts.length - 1]), b = this._s(this._hover);
        g.append(svg('line', { class: 'rubber', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }));
        drawTip(pts[pts.length - 1], this._hover);
        if (pts.length >= 3 && dist(b, this._s(pts[0])) <= SNAP_PX) {
          const s0 = this._s(pts[0]);
          g.append(svg('circle', { cx: s0[0], cy: s0[1], r: 9, fill: 'none', stroke: 'var(--primary-color, #03a9f4)', 'stroke-width': 2 }));
        }
      }
    } else if (this._hover && (this.tool === 'draw' || this.tool === 'rect' || this.tool === 'measure') && !this._drag) {
      const s = this._s(this._hover);
      g.append(svg('circle', { cx: s[0], cy: s[1], r: 3, fill: 'var(--primary-color, #03a9f4)' }));
    }
    if (this._drag?.kind === 'rect') {
      const [x0, y0] = this._drag.start, [x1, y1] = this._drag.end;
      g.append(svg('path', { class: 'draft', d: this._path([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) }));
      if (units) {
        const s = this._s([x1, y1]);
        g.append(svg('text', { class: 'measure-label', x: s[0] + 8, y: s[1] - 8 }, document.createTextNode(`${units.fmtLong(Math.abs(x1 - x0))} × ${units.fmtLong(Math.abs(y1 - y0))}`)));
      }
    }
    if (this._measure) {
      const a = this._s(this._measure.a), b = this._s(this._measure.b);
      g.append(svg('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: 'var(--accent-color, #ff9800)', 'stroke-width': 2 }));
      drawTip(this._measure.a, this._measure.b);
    }
    if (this._hint) {
      const s = this._s(this._hint.at);
      g.append(svg('text', { class: 'snap-hint', x: s[0] + 10, y: s[1] + 16 }, document.createTextNode(this._hint.text)));
    }
    return g;
  }
}

customElements.get('rzp-plot') || customElements.define('rzp-plot', RzpPlot);
