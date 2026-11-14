// <rzp-timeline>: activity density, per-zone on/off bands (preview vs.
// recorded), trigger markers and a scrub cursor. Wheel zooms, drag scrubs,
// drag on the density strip selects the cloud window.

import { fmtTime } from './util.js';

const AXIS_H = 18;
const DENSITY_H = 26;
const ROW_H = 16;
const LABEL_W = 120;

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
    if (props.range && (!this.range || props.range.start !== this.range.start || props.range.end !== this.range.end)) {
      this.view = { v0: props.range.start, v1: props.range.end };
    }
    Object.assign(this, props);
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

  _down(e) {
    if (!this.range) return;
    const [x, y] = this._local(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (x < LABEL_W) return;
    const hit = this._hitTrigger(x, y);
    if (hit) { this._emit('trigger', { zoneId: hit.row.id, t: hit.t }); return; }
    if (e.shiftKey || e.button === 1) { this._drag = { kind: 'pan', x, view: { ...this.view } }; return; }
    if (y >= AXIS_H && y < AXIS_H + DENSITY_H) { this._drag = { kind: 'brush', t0: this._t(x) }; return; }
    this._drag = { kind: 'scrub' };
    this._emit('seek', { t: this._clamp(this._t(x)) });
  }

  _clamp(t) { return Math.max(this.range.start, Math.min(this.range.end, t)); }

  _move(e) {
    if (!this.range) return;
    const [x, y] = this._local(e);
    this.canvas.style.cursor = this._hitTrigger(x, y) ? 'pointer' : y < AXIS_H + DENSITY_H && y >= AXIS_H ? 'col-resize' : 'crosshair';
    const d = this._drag;
    if (!d) return;
    if (d.kind === 'scrub') this._emit('seek', { t: this._clamp(this._t(x)) });
    else if (d.kind === 'brush') {
      const t1 = this._clamp(this._t(x));
      this.brush = { t0: Math.min(d.t0, t1), t1: Math.max(d.t0, t1) };
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

  _up() {
    const d = this._drag;
    this._drag = null;
    if (d?.kind === 'brush') {
      if (this.brush && this.brush.t1 - this.brush.t0 < (this.view.v1 - this.view.v0) / 500) this.brush = null;
      this._emit('window', { brush: this.brush });
      this.requestRender();
    }
  }

  _dbl(e) {
    const [, y] = this._local(e);
    if (y < AXIS_H + DENSITY_H) {
      this.brush = null;
      this._emit('window', { brush: null });
    } else {
      this.view = { v0: this.range.start, v1: this.range.end };
    }
    this.requestRender();
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
    const primary = style.getPropertyValue('--primary-color') || '#03a9f4';
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
    ctx.fillStyle = sub;
    ctx.fillText('activity', 4, y0 + 16);
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
      ctx.fillStyle = primary;
      ctx.globalAlpha = 0.55;
      for (let i = 0; i < n && max; i++) {
        if (!buckets[i]) continue;
        const bh = Math.max(1.5, (buckets[i] / max) * (DENSITY_H - 4));
        ctx.fillRect(LABEL_W + i * ((w - LABEL_W) / n), y0 + DENSITY_H - 2 - bh, Math.max(1, (w - LABEL_W) / n - 0.5), bh);
      }
      ctx.globalAlpha = 1;
    }
    if (this.brush) {
      ctx.fillStyle = primary;
      ctx.globalAlpha = 0.15;
      ctx.fillRect(xa(this.brush.t0), y0, xa(this.brush.t1) - xa(this.brush.t0), h - y0);
      ctx.globalAlpha = 1;
    }

    // Zone rows
    let ry = AXIS_H + DENSITY_H;
    for (const row of this.rows) {
      ctx.fillStyle = text;
      ctx.fillText(row.name.length > 18 ? row.name.slice(0, 17) + '…' : row.name, 4, ry + 12);
      ctx.fillStyle = row.color;
      for (const [a, b] of row.predicted || []) {
        if (b < this.view.v0 || a > this.view.v1) continue;
        ctx.fillRect(xa(a), ry + 2, Math.max(1.5, xa(b) - xa(a)), ROW_H - 7);
      }
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

    // Cursor
    if (this.cursor !== null && this.cursor >= this.view.v0 && this.cursor <= this.view.v1) {
      const x = xa(this.cursor);
      ctx.strokeStyle = '#e53935';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.lineWidth = 1;
      const label = fmtTime(this.cursor, true, true);
      const tw = ctx.measureText(label).width + 6;
      const lx = Math.min(w - tw, x + 3);
      ctx.fillStyle = '#e53935';
      ctx.fillRect(lx, 0, tw, 14);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx + 3, 11);
    }
  }
}

customElements.get('rzp-timeline') || customElements.define('rzp-timeline', RzpTimeline);
