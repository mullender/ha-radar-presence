// <rzp-timeline>: activity density, per-zone on/off bands (preview vs.
// recorded), trigger markers and a playhead. Apple-Photos-style trimmer:
// yellow handles at both ends of the loaded range trim the window used for
// the point cloud and for playback. Click/drag elsewhere scrubs the playhead,
// wheel zooms, Shift-drag pans, double-click resets zoom.

import { GLYPHS, fmtTime } from './util.js';

const AXIS_H = 18;
const DENSITY_H = 26;
const ROW_H = 18;
const LABEL_W = 120;
const HANDLE_W = 10;
const TRIM_COLOR = '#f9a825';
const PLAYHEAD_W = 16; // slide-rule style cursor: wide grab band, hairline in the middle
const PLAYHEAD_COLOR = '33,150,243'; // HA's blue, as in the proposal

const css = `
:host { display: block; position: relative; user-select: none; -webkit-user-select: none; }
canvas { display: block; width: 100%; cursor: crosshair; }
`;

export class RzpTimeline extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${css}</style><canvas></canvas>`;
    this.canvas = root.querySelector('canvas');
    this.range = null; // {start, end} epoch s
    this.view = null; // {v0, v1}
    this.frames = null; // {start, t: frame offsets (s), n: targets per frame}
    this.rows = []; // [{id, name, color, predicted: [[a,b]], actual: [[a,b]], triggers: [t]}]
    this.cursor = null;
    this.brush = null; // {t0, t1}
    this.follow = false; // slide a zoomed view along as the range grows (live)
    this.marks = false; // recorded states and trigger markers (Details on, or editing)
    this._drag = null;
    this._raf = 0;
    this.canvas.addEventListener('pointerdown', e => this._down(e));
    this.canvas.addEventListener('pointermove', e => this._move(e));
    this.canvas.addEventListener('pointerup', e => this._up(e));
    this.canvas.addEventListener('wheel', e => this._wheel(e), { passive: false });
    this.canvas.addEventListener('dblclick', e => this._dbl(e));
    this._ro = new ResizeObserver(() => this.requestRender());
  }

  connectedCallback() { this._ro.observe(this); }
  disconnectedCallback() { this._ro.disconnect(); }

  set(props) {
    const { resetView = false, ...rest } = props;
    const old = this.range;
    const r = rest.range;
    if (r && (!old || !this.view || resetView)) {
      this.view = { v0: r.start, v1: r.end };
    } else if (r && (r.start !== old.start || r.end !== old.end)) {
      // The window slides with "now". A full-width view keeps showing all of
      // it; a zoomed view slides along only while following (live), else stays.
      const eps = 1e-3;
      let { v0, v1 } = this.view;
      const atStart = v0 <= old.start + eps;
      const atEnd = v1 >= old.end - eps;
      if (atStart && atEnd) { v0 = r.start; v1 = r.end; }
      else if (atEnd && (rest.follow ?? this.follow)) { v0 += r.end - v1; v1 = r.end; }
      v0 = Math.max(r.start, v0);
      v1 = Math.min(r.end, Math.max(v1, v0 + 1));
      this.view = { v0, v1 };
    }
    Object.assign(this, rest);
    this.requestRender();
  }

  /** Zoom the view to [a, b] (clamped to range). */
  focus(a, b) {
    if (!this.range) return;
    this.view = { v0: Math.max(this.range.start, a), v1: Math.min(this.range.end, b) };
    this.requestRender();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  get _height() { return AXIS_H + DENSITY_H + Math.max(1, this.rows.length) * ROW_H + 6; }

  _x(t) {
    const w = this.clientWidth - LABEL_W;
    return LABEL_W + ((t - this.view.v0) / (this.view.v1 - this.view.v0)) * w;
  }

  _t(x) {
    const w = this.clientWidth - LABEL_W;
    return this.view.v0 + ((x - LABEL_W) / w) * (this.view.v1 - this.view.v0);
  }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true })); }

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _hitTrigger(x, y) {
    let rowY = AXIS_H + DENSITY_H;
    for (const row of this.rows) {
      if (y >= rowY && y < rowY + ROW_H) {
        for (const t of row.triggers || []) if (Math.abs(this._x(t) - x) <= 4 && y < rowY + ROW_H / 2) return { row, t };
        for (const t of row.actualTriggers || []) if (Math.abs(this._x(t) - x) <= 4) return { row, t };
      }
      rowY += ROW_H;
    }
    return null;
  }

  /** A predicted on-interval under the pointer: {row, a, b}. */
  _hitBar(x, y) {
    let rowY = AXIS_H + DENSITY_H;
    const t = this._t(x), slack = 3 / Math.max(1e-9, this._x(1) - this._x(0)); // 3 px in seconds
    for (const row of this.rows) {
      if (y >= rowY && y < rowY + ROW_H && row.popover) {
        for (const [a, b] of row.predicted || []) if (t >= a - slack && t <= b + slack) return { row, a, b };
      }
      rowY += ROW_H;
    }
    return null;
  }

  get _trim() {
    return this.brush || { t0: this.range.start, t1: this.range.end };
  }

  /** Left edges of the two handles, kept inside the plot area so they stay grabbable. */
  _handleXs() {
    const { t0, t1 } = this._trim;
    const w = this.clientWidth;
    return [Math.max(LABEL_W - HANDLE_W, this._x(t0) - HANDLE_W), Math.min(w - HANDLE_W, this._x(t1))];
  }

  /** Playhead x: the replay cursor, or (idle) the end of the trimmed range. */
  _playheadX() {
    const w = this.clientWidth;
    const t = this.cursor ?? this._trim.t1;
    if (t < this.view.v0 || t > this.view.v1) return null;
    const lo = LABEL_W + PLAYHEAD_W / 2, hi = w - HANDLE_W - PLAYHEAD_W / 2 - 1;
    return Math.max(lo, Math.min(hi, this._x(t)));
  }

  _hitPlayhead(x) {
    const px = this._playheadX();
    return px !== null && Math.abs(x - px) <= PLAYHEAD_W / 2 + 2;
  }

  _hitHandle(x) {
    const [h0, h1] = this._handleXs();
    if (x >= h0 - 3 && x <= h0 + HANDLE_W + 3) return 't0';
    if (x >= h1 - 3 && x <= h1 + HANDLE_W + 3) return 't1';
    return null;
  }

  _down(e) {
    if (!this.range) return;
    const [x, y] = this._local(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (this._hitPlayhead(x)) {
      // Grab keeps the offset between pointer and hairline, so the cursor doesn't jump.
      this._drag = { kind: 'playhead', offset: x - this._playheadX(), moved: false };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    const handle = this._hitHandle(x);
    if (handle) { this._drag = { kind: 'trim', handle }; return; }
    if (x < LABEL_W) return;
    const hit = this._hitTrigger(x, y);
    if (hit) { this._emit('trigger', { zoneId: hit.row.id, t: hit.t }); return; }
    const bar = this._hitBar(x, y);
    if (bar) { this._emit('bar', { zoneId: bar.row.id, a: bar.a, b: bar.b, x: e.clientX, y: e.clientY }); this._emit('seek', { t: this._clamp(bar.a) }); return; }
    if (e.shiftKey || e.button === 1) { this._drag = { kind: 'pan', x, view: { ...this.view } }; return; }
    this._drag = { kind: 'scrub' };
    this._emit('seek', { t: this._clamp(this._t(x)) });
  }

  _clamp(t) { return Math.max(this.range.start, Math.min(this.range.end, t)); }

  _move(e) {
    if (!this.range) return;
    const [x, y] = this._local(e);
    const d = this._drag;
    this.canvas.style.cursor = d?.kind === 'playhead' ? 'grabbing'
      : d?.kind === 'trim' ? 'ew-resize'
      : this._hitPlayhead(x) ? 'grab'
      : this._hitHandle(x) ? 'ew-resize'
      : this._hitTrigger(x, y) ? 'pointer' : 'crosshair';
    if (!d) return;
    if (d.kind === 'scrub') this._emit('seek', { t: this._clamp(this._t(x)) });
    else if (d.kind === 'playhead') {
      d.moved = true;
      this._emit('seek', { t: this._clamp(this._t(x - d.offset)) });
    }
    else if (d.kind === 'trim') {
      const trim = { ...this._trim };
      const minSpan = Math.max(1, (this.view.v1 - this.view.v0) / 400);
      const t = this._clamp(this._t(x));
      if (d.handle === 't0') trim.t0 = Math.min(t, trim.t1 - minSpan);
      else trim.t1 = Math.max(t, trim.t0 + minSpan);
      const full = trim.t0 <= this.range.start + 0.001 && trim.t1 >= this.range.end - 0.001;
      this.brush = full ? null : trim;
      this._emit('window', { brush: this.brush });
      this.requestRender();
    } else if (d.kind === 'pan') {
      const dt = ((x - d.x) / (this.clientWidth - LABEL_W)) * (d.view.v1 - d.view.v0);
      let v0 = d.view.v0 - dt, v1 = d.view.v1 - dt;
      if (v0 < this.range.start) { v1 += this.range.start - v0; v0 = this.range.start; }
      if (v1 > this.range.end) { v0 -= v1 - this.range.end; v1 = this.range.end; }
      this.view = { v0, v1 };
      this.requestRender();
    }
  }

  _up(e) {
    const d = this._drag;
    this._drag = null;
    // Clicking the idle playhead (no drag) starts replay at its position.
    if (d?.kind === 'playhead' && !d.moved && this.cursor === null) {
      this._emit('seek', { t: this._clamp(this._t(this._playheadX())) });
    }
    if (e) this._move(e);
  }

  _dbl(e) {
    const [x] = this._local(e);
    if (this._hitHandle(x)) {
      this.brush = null; // double-click a handle: reset the trim
      this._emit('window', { brush: null });
    } else {
      this.view = { v0: this.range.start, v1: this.range.end };
    }
    this.requestRender();
  }

  /** Zoom the view to the trimmed range (with a little margin). */
  zoomToTrim() {
    if (!this.range) return;
    const { t0, t1 } = this._trim;
    const m = (t1 - t0) * 0.05;
    this.focus(t0 - m, t1 + m);
  }

  _wheel(e) {
    if (!this.range) return;
    e.preventDefault();
    const [x] = this._local(e);
    const t = this._t(Math.max(LABEL_W, x));
    const f = Math.exp(e.deltaY * 0.002);
    const minSpan = 5;
    let span = Math.max(minSpan, Math.min(this.range.end - this.range.start, (this.view.v1 - this.view.v0) * f));
    const k = (t - this.view.v0) / (this.view.v1 - this.view.v0);
    let v0 = t - k * span, v1 = v0 + span;
    if (v0 < this.range.start) { v0 = this.range.start; v1 = v0 + span; }
    if (v1 > this.range.end) { v1 = this.range.end; v0 = v1 - span; }
    this.view = { v0, v1 };
    this.requestRender();
  }

  _ticks() {
    const span = this.view.v1 - this.view.v0;
    const w = this.clientWidth - LABEL_W;
    const target = span / Math.max(2, w / 90);
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
    const step = steps.find(s => s >= target) || 86400;
    const tz = new Date().getTimezoneOffset() * 60;
    const first = Math.ceil((this.view.v0 - tz) / step) * step + tz;
    const out = [];
    for (let t = first; t <= this.view.v1; t += step) out.push(t);
    return { out, step };
  }

  _render() {
    const dpr = devicePixelRatio || 1;
    const w = this.clientWidth, h = this._height;
    this.canvas.style.height = `${h}px`;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) { this.canvas.width = w * dpr; this.canvas.height = h * dpr; }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(this);
    const text = style.getPropertyValue('--primary-text-color') || '#222';
    const sub = style.getPropertyValue('--secondary-text-color') || '#777';
    const div = style.getPropertyValue('--divider-color') || '#ddd';
    ctx.font = '11px sans-serif';
    if (!this.range || !this.view) {
      ctx.fillStyle = sub;
      ctx.fillText('No history loaded', LABEL_W, 30);
      return;
    }
    const xa = t => this._x(t);

    // Axis
    const { out, step } = this._ticks();
    ctx.strokeStyle = div;
    ctx.fillStyle = sub;
    for (const t of out) {
      const x = xa(t);
      ctx.beginPath(); ctx.moveTo(x, AXIS_H - 4); ctx.lineTo(x, h); ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillText(fmtTime(t, step < 60), x + 2, AXIS_H - 6);
    }

    // Density
    const y0 = AXIS_H;
    if (this.frames?.t?.length) {
      // Histogram of targets per bucket over the visible view (recomputed per render).
      const n = Math.max(20, Math.floor((w - LABEL_W) / 3));
      const bw = (this.view.v1 - this.view.v0) / n;
      const buckets = new Float32Array(n);
      const ft = this.frames.t, fn = this.frames.n, base = this.frames.start;
      let lo = 0, hi = ft.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (base + ft[mid] < this.view.v0) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < ft.length && base + ft[i] <= this.view.v1; i++) {
        if (fn[i]) buckets[Math.min(n - 1, Math.floor((base + ft[i] - this.view.v0) / bw))] += fn[i];
      }
      let max = 0;
      for (const b of buckets) max = Math.max(max, b);
      ctx.fillStyle = sub;
      ctx.globalAlpha = 0.45;
      for (let i = 0; i < n && max; i++) {
        if (!buckets[i]) continue;
        const bh = Math.max(1.5, (buckets[i] / max) * (DENSITY_H - 4));
        ctx.fillRect(LABEL_W + i * ((w - LABEL_W) / n), y0 + DENSITY_H - 2 - bh, Math.max(1, (w - LABEL_W) / n - 0.5), bh);
      }
      ctx.globalAlpha = 1;
    }

    // Zone rows
    let ry = AXIS_H + DENSITY_H;
    for (const row of this.rows) {
      // Lane label: the kind's glyph in its colour, then the name (truncated; the full name is the tooltip).
      let lx = 4;
      if (row.glyph && GLYPHS[row.glyph]) {
        ctx.save();
        ctx.translate(4, ry + 3); ctx.scale(1.05, 1.05);
        ctx.strokeStyle = row.color; ctx.lineWidth = 1.3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.stroke(new Path2D(GLYPHS[row.glyph]));
        ctx.restore();
        lx = 20;
      }
      ctx.fillStyle = text;
      ctx.font = '12px sans-serif';
      let name = row.name;
      while (name.length > 3 && ctx.measureText(name).width > LABEL_W - lx - 6) name = name.slice(0, -2) + '…';
      ctx.fillText(name, lx, ry + 13);
      ctx.font = '11px sans-serif';
      for (const [a, b, n, label] of row.steps || []) { // a level per interval (a people count): shade + number
        if (b < this.view.v0 || a > this.view.v1 || !n) continue;
        const x0 = Math.max(LABEL_W, xa(a)), x1 = Math.min(w, xa(b));
        ctx.fillStyle = row.color;
        ctx.globalAlpha = Math.min(0.85, 0.3 + 0.18 * n);
        ctx.fillRect(x0, ry + 2, Math.max(1.5, x1 - x0), ROW_H - 4);
        ctx.globalAlpha = 1;
        const txt = label ?? String(n);
        if (x1 - x0 > ctx.measureText(txt).width + 6) { ctx.fillStyle = '#fff'; ctx.fillText(txt, x0 + 3, ry + 12); }
      }
      ctx.fillStyle = row.color;
      ctx.globalAlpha = 0.5;
      for (const [a, b] of row.predicted || []) {
        if (b < this.view.v0 || a > this.view.v1) continue;
        const bx = Math.max(LABEL_W, xa(a)), bw = Math.max(2, Math.min(w, xa(b)) - bx);
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(bx, ry + 3, bw, ROW_H - (this.marks ? 9 : 6), 3) : ctx.rect(bx, ry + 3, bw, ROW_H - 6);
        ctx.fill();
        if (row.popover && b - a < 3) { // short blips get a marker: the usual cause of "why did the light turn on?"
          const x = xa((a + b) / 2);
          ctx.globalAlpha = 1;
          ctx.beginPath(); ctx.moveTo(x, ry + 1.5); ctx.lineTo(x - 3, ry - 2.5); ctx.lineTo(x + 3, ry - 2.5); ctx.closePath(); ctx.fill();
          ctx.globalAlpha = 0.5;
        }
      }
      ctx.globalAlpha = 1;
      if (!this.marks) { ry += ROW_H; continue; }
      ctx.fillStyle = text;
      ctx.globalAlpha = 0.6;
      for (const [a, b] of row.actual || []) {
        if (b < this.view.v0 || a > this.view.v1) continue;
        ctx.fillRect(xa(a), ry + ROW_H - 4, Math.max(1.5, xa(b) - xa(a)), 2);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = row.color;
      for (const t of row.triggers || []) {
        if (t < this.view.v0 || t > this.view.v1) continue;
        const x = xa(t);
        ctx.beginPath(); ctx.moveTo(x, ry + 1); ctx.lineTo(x - 3.5, ry - 4); ctx.lineTo(x + 3.5, ry - 4); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = text;
      for (const t of row.actualTriggers || []) {
        if (t < this.view.v0 || t > this.view.v1) continue;
        const x = xa(t);
        ctx.beginPath(); ctx.moveTo(x, ry + ROW_H - 5); ctx.lineTo(x - 3, ry + ROW_H); ctx.lineTo(x + 3, ry + ROW_H); ctx.closePath(); ctx.fill();
      }
      ry += ROW_H;
    }

    // Trimmer: dim outside the trimmed range, yellow frame + handles around it.
    {
      const { t0, t1 } = this._trim;
      const xL = Math.max(LABEL_W, xa(t0)), xR = Math.min(w, xa(t1));
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      if (xL > LABEL_W) ctx.fillRect(LABEL_W, AXIS_H, xL - LABEL_W, h - AXIS_H);
      if (xR < w) ctx.fillRect(xR, AXIS_H, w - xR, h - AXIS_H);
      const trimmed = !!this.brush;
      if (trimmed) {
        ctx.strokeStyle = TRIM_COLOR;
        ctx.lineWidth = 2;
        ctx.strokeRect(xa(t0), AXIS_H + 1, xa(t1) - xa(t0), h - AXIS_H - 2);
        ctx.lineWidth = 1;
      }
      const [h0, h1] = this._handleXs();
      for (const [hx, side] of [[h0, -1], [h1, 1]]) {
        if (!trimmed) { // untrimmed: quiet grips at the ends, still grabbable
          ctx.fillStyle = div;
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(hx + (side < 0 ? HANDLE_W - 4 : 0), AXIS_H + 4, 4, h - AXIS_H - 8, 2) : ctx.rect(hx, AXIS_H + 4, 4, h - AXIS_H - 8);
          ctx.fill();
          continue;
        }
        ctx.fillStyle = TRIM_COLOR;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(hx, AXIS_H, HANDLE_W, h - AXIS_H, side < 0 ? [5, 0, 0, 5] : [0, 5, 5, 0]) : ctx.rect(hx, AXIS_H, HANDLE_W, h - AXIS_H);
        ctx.fill();
        // chevron grip
        ctx.strokeStyle = '#5d4037';
        ctx.lineWidth = 1.5;
        const cx = hx + HANDLE_W / 2, cy = AXIS_H + (h - AXIS_H) / 2;
        ctx.beginPath(); ctx.moveTo(cx + side * -1.5, cy - 5); ctx.lineTo(cx + side * 1.5, cy); ctx.lineTo(cx + side * -1.5, cy + 5); ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // Playhead: slide-rule cursor (translucent band + hairline + grip tab).
    const px = this._playheadX();
    if (px !== null) {
      const idle = this.cursor === null;
      const a = idle ? 0.45 : 1;
      const top = 2, bottom = h - 1, half = PLAYHEAD_W / 2;
      void half;
      // Hairline
      ctx.strokeStyle = `rgba(${PLAYHEAD_COLOR},${a})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, AXIS_H - 1); ctx.lineTo(px, bottom); ctx.stroke();
      ctx.lineWidth = 1;
      // Time label beside the tab
      const t = this.cursor ?? this._trim.t1;
      const label = idle ? `${fmtTime(t)} · drag to replay` : fmtTime(t, true, this.view.v1 - this.view.v0 < 60);
      // Time pill centred on the playhead (kept inside the lane area); it is also the grip.
      const tw = ctx.measureText(label).width + 14;
      const lx = Math.max(LABEL_W, Math.min(w - tw, px - tw / 2));
      ctx.fillStyle = `rgba(${PLAYHEAD_COLOR},${0.95 * a})`;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(lx, top, tw, AXIS_H - 3, 8) : ctx.rect(lx, top, tw, AXIS_H - 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx + 7, AXIS_H - 6);
    }
  }
}

customElements.get('rzp-timeline') || customElements.define('rzp-timeline', RzpTimeline);
