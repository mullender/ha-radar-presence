// <rzp-headcount>: the occupants view (House) in the Presence panel. The floors
// side by side, each tracked space a box with the people believed in it (solid:
// a radar sees them; hollow: unseen; dashed: settling while an outside door is in
// use; faint: not confirmed yet). Under it the scrubber: people per space, doors
// open, evidence; and the decision log, each change with what caused it. Built
// from the integration's decision log (`headcount/history` + `headcount/subscribe`).

import './timeline.js';
import { drawPlan, loadMaps, planFor } from './plan.js';
import { el, fmtTime, fmtDateTime, fmtDuration, correctionFollowUp, timeChip, TIME_CHIP_CSS } from './util.js';

const DOMAIN = 'radar_zone_presence';
const RANGES = [['15m', 900], ['1h', 3600], ['6h', 21600], ['24h', 86400], ['3d', 259200]];
const COLORS = ['#1e88e5', '#43a047', '#8e24aa', '#f4511e', '#00897b', '#6d4c41', '#3949ab', '#c0ca33', '#d81b60'];
const KINDS = {
  moved: ['→', 'moved'], arrived: ['⇥', 'arrived'], left: ['⇤', 'left'], unknown: ['?', 'settling'], back: ['✓', 'back'],
  unexplained: ['+', 'appeared'], confirmed: ['✓', 'confirmed'], 'not a person': ['✕', 'not a person'], ghost: ['·', 'ghost track'],
  restored: ['↺', 'restored'], corrected: ['✎', 'corrected by hand'], bootstrap: ['+', 'counted at start'], evidence: ['☞', 'evidence'], door: ['🚪', 'door'],
  signal: ['☞', 'used by hand'], ignored: ['∅', 'ignored'],
};
const CROSS_S = 30; // a doorway glows this long after someone crossed it

const css = `
${TIME_CHIP_CSS}
:host { display: flex; flex-direction: column; min-height: 0; height: 100%; color: var(--primary-text-color, #222); }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 6px 10px; background: var(--card-background-color, #fff);
  border-bottom: 1px solid var(--divider-color, #ddd); font-size: 13px; }
.bar select, .bar button { font: inherit; font-size: 13px; padding: 3px 8px; border: 1px solid var(--divider-color, #ccc); border-radius: 4px;
  background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); cursor: pointer; }
.bar button.on { background: var(--error-color, #db4437); color: #fff; border-color: transparent; }
.bar .live-pill { border: 0; border-radius: 16px; padding: 5px 12px; font-weight: 500; background: var(--secondary-background-color, #eef0f2); font-variant-numeric: tabular-nums; }
.bar .live-pill.live { background: rgba(229,57,53,.12); color: #d32f2f; }
.bar .time-pop { left: 0; right: auto; }
.bar .time-chip button { border: 0; background: none; border-radius: 16px; padding: 5px 8px; }
.bar .time-chip .time-pop button { border: 1px solid var(--divider-color, #ccc); border-radius: 14px; padding: 3px 10px; }
.bar .time-chip .time-pop button.on { background: var(--primary-color, #03a9f4); color: #fff; border-color: transparent; }
.bar select.range { border: 0; border-radius: 16px; padding: 5px 10px; background: var(--secondary-background-color, #eef0f2); }
.bar .when { font-weight: 500; }
.bar .home { margin-left: auto; font-size: 15px; }
.bar .home b { font-size: 20px; }
.bar .home { display: flex; align-items: center; gap: 6px; }
.bar .home .minus { width: 26px; padding: 3px 0; }
.bar .home.settling b, .bar .home .settle { color: var(--warning-color, #d97706); }
.bar .home .settle { font-size: 13px; animation: settle 2.4s ease-in-out infinite; }
@keyframes settle { 50% { opacity: .45; } }
.scroll { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: minmax(0, 1fr) 360px; grid-template-rows: auto 1fr; }
:host([narrow]) .scroll { grid-template-columns: 1fr; grid-template-rows: none; }
.scroll > .side { grid-column: 2; grid-row: 1 / span 2; }
:host([narrow]) .scroll > .side { grid-column: auto; grid-row: auto; }
.house { position: relative; padding: 14px; min-width: 0; }
.floors { position: relative; display: flex; flex-direction: column; gap: 26px; z-index: 1; }
.floor { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 12px; align-items: center; }
.floor .rooms { display: flex; flex-wrap: wrap; gap: 14px 46px; padding: 12px; border: 1px solid var(--divider-color, #e0e0e0); border-radius: 12px; background: var(--card-background-color, #fff); }
.floor .plan { padding: 12px; border: 1px solid var(--divider-color, #e0e0e0); border-radius: 12px; background: var(--card-background-color, #fff); }
.floor .plan .rooms { border: 0; padding: 0; }
.floor h2 { margin: 0; font-size: 13px; font-weight: 400; color: var(--secondary-text-color, #666); display: flex; flex-direction: column; gap: 0; }
@media (max-width: 600px) { .floor { grid-template-columns: minmax(0, 1fr); gap: 6px; } .floor h2 { flex-direction: row; align-items: baseline; gap: 8px; } .floor .seg { margin-top: 0; margin-left: auto; } .house { padding: 10px; } }
.floor h2 .n { font-size: 26px; font-weight: 500; color: var(--primary-text-color, #222); line-height: 1.2; }
.floor.doubt h2 .n { color: var(--warning-color, #f9a825); }
.space { background: var(--card-background-color, #fff); border: 1px solid transparent; border-radius: 10px; padding: 8px 12px;
  flex: 1 1 150px; max-width: 280px; min-height: 76px; transition: box-shadow .2s, background .2s; }
.space.occ { background: color-mix(in srgb, #3b82f6 13%, var(--card-background-color, #fff)); }
.space.blind { border: 1.5px dashed var(--divider-color, #ccc); }
.space.link { cursor: pointer; }
.space.link:hover { box-shadow: 0 1px 6px rgba(0,0,0,.15); }
.space.hit { box-shadow: 0 0 0 2px var(--primary-color, #03a9f4); }
.space .top { display: flex; align-items: baseline; gap: 6px; }
.space .name { font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.space .count { font-size: 22px; font-weight: 500; }
.space .fix { display: none; gap: 2px; }
.space:hover .fix { display: inline-flex; }
.space .fix button { font: inherit; font-size: 13px; width: 22px; height: 22px; padding: 0; border-radius: 11px; border: 1px solid var(--divider-color, #ccc);
  background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); cursor: pointer; }
.space .meta { font-size: 12px; color: var(--secondary-text-color, #777); }
.space .meta .open { color: #d97706; font-weight: 500; }
.seam { position: absolute; transform: translate(-50%, -50%); font-size: 11px; padding: 1px 7px; border-radius: 9px; z-index: 2; pointer-events: auto; white-space: nowrap;
  background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, #ccc); color: var(--secondary-text-color, #666); }
.seam.hot { border-color: var(--primary-color, #03a9f4); color: var(--primary-color, #03a9f4); }
.seam.open { border-color: #d97706; color: #d97706; }
.seam.stairs { border: 0; background: none; padding: 0; }
.plan { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.plan-map { position: relative; width: 100%; max-width: 760px; max-height: 70vh; overflow: hidden; }
.plan-svg { position: absolute; inset: 0; width: 100%; height: 100%; color: var(--primary-text-color, #222); overflow: hidden; }
.plan-svg .room.link { cursor: pointer; }
.plan-svg .room.link:hover { fill-opacity: .18; }
.space.mini { position: absolute; transform: translate(-50%, -50%); min-width: 0; min-height: 0; width: auto; max-width: 160px; padding: 3px 8px; border-radius: 8px;
  background: color-mix(in srgb, var(--card-background-color, #fff) 88%, transparent); box-shadow: 0 1px 3px rgba(0,0,0,.12); z-index: 2; }
.space.mini .count { font-size: 15px; }
.space.mini .meta, .space.mini .doors { display: none; }
.space.mini .dots { margin-top: 2px; }
.space.mini .dots:empty { display: none; }
.seg { display: inline-flex; margin-top: 8px; border: 1px solid var(--divider-color, #ccc); border-radius: 12px; overflow: hidden; width: max-content; }
.seg button { font: inherit; font-size: 11px; border: 0; background: none; color: var(--secondary-text-color, #666); padding: 2px 8px; cursor: pointer; }
.seg button.on { background: var(--primary-color, #03a9f4); color: #fff; }
.dots { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; min-height: 22px; }
.dot { font-size: 11px; font-weight: 600; min-width: 22px; height: 22px; padding: 0 4px; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center;
  border: 2px solid var(--c); color: var(--c); cursor: pointer; }
.dot.v { background: var(--c); color: #fff; }
.dot.u { border-style: dotted; }
.dot.p { opacity: .45; }
.dot.sel { outline: 2px solid var(--primary-text-color, #222); outline-offset: 1px; }
.doors { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.chip { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--secondary-background-color, #eee); color: var(--secondary-text-color, #555); }
.chip.open { background: #d97706; color: #fff; }
svg.links { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; overflow: visible; }
svg.links path { fill: none; stroke: var(--divider-color, #bbb); stroke-width: 1; opacity: .7; }
svg.links path.door { stroke-dasharray: 3 3; }
svg.links path.hot { stroke: var(--primary-color, #03a9f4); stroke-width: 4; }
.timeline-wrap { grid-column: 1; background: var(--card-background-color, #fff); border-top: 1px solid var(--divider-color, #ddd); padding: 2px 0; }
.log { border-left: 1px solid var(--divider-color, #ddd); background: var(--card-background-color, #fff); overflow-y: auto; height: 100%; font-size: 12px; box-sizing: border-box; }
.scroll > .side { position: relative; }
.scroll > .side .log { position: absolute; inset: 0; }
:host([narrow]) .scroll > .side .log { position: static; }
:host([narrow]) .log { border-left: 0; max-height: 40vh; }
.log h3 { position: sticky; top: 0; margin: 0; padding: 8px 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color, #666);
  background: var(--card-background-color, #fff); border-bottom: 1px solid var(--divider-color, #ddd); display: flex; gap: 8px; }
.log h3 label { margin-left: auto; text-transform: none; letter-spacing: 0; display: flex; gap: 4px; align-items: center; }
.row { padding: 0; border-bottom: 1px solid var(--divider-color, #eee); }
.row .line { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 8px; padding: 8px 12px; cursor: pointer; font-size: 13px; line-height: 1.35; }
.row .delta { color: var(--secondary-text-color, #777); font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 12px; }
.how { padding: 0 12px 10px 64px; font-size: 12px; color: var(--secondary-text-color, #666); }
.how-h { font-weight: 500; color: var(--primary-text-color, #222); margin-bottom: 2px; }
.how ul { margin: 0 0 6px; padding-left: 16px; }
.how .links { display: flex; gap: 6px; flex-wrap: wrap; }
.how .links button, .fchip { font: inherit; font-size: 12px; border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff);
  color: var(--primary-color, #03a9f4); border-radius: 14px; padding: 3px 10px; cursor: pointer; }
.fchip { color: var(--secondary-text-color, #666); text-transform: none; letter-spacing: 0; }
.fchip.on { background: var(--primary-color, #03a9f4); color: #fff; border-color: transparent; }
.log h3 .chips { display: flex; gap: 4px; margin-left: 8px; }
.row .line:hover { background: var(--secondary-background-color, #f4f4f4); }
.row.at { background: rgba(3,169,244,.12); }
.row.after { opacity: .45; }
.row .t { color: var(--secondary-text-color, #777); font-variant-numeric: tabular-nums; }
.row .k { text-align: center; }
.row button.radar { border: 0; background: none; cursor: pointer; padding: 0 2px; font-size: 13px; opacity: .55; }
.row button.radar:hover { opacity: 1; }
.row .why { color: var(--secondary-text-color, #777); }
.row.ignored { color: var(--secondary-text-color, #888); }
.empty { padding: 30px; color: var(--secondary-text-color, #777); }
.side { position: relative; min-width: 0; }
.sheet-wrap { position: absolute; inset: 0; background: var(--card-background-color, #fff); border-left: 1px solid var(--divider-color, #ddd);
  box-shadow: -2px 0 8px rgba(0,0,0,.08); overflow-y: auto; z-index: 3; }
.sheet { padding: 12px 14px; font-size: 13px; }
.sheet-h { display: flex; align-items: center; gap: 8px; }
.sheet-h b { font-size: 15px; font-weight: 500; }
.sheet-h .x { margin-left: auto; border: 0; background: none; font-size: 16px; cursor: pointer; color: inherit; }
.sheet .sum { margin: 10px 0; line-height: 1.45; }
.route { border-left: 2px solid var(--divider-color, #ddd); margin-left: 6px; padding-left: 12px; }
.step { position: relative; display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 6px; align-items: center; padding: 4px 0; }
.step .pin { position: absolute; left: -18px; top: 9px; width: 10px; height: 10px; border-radius: 50%; background: var(--primary-color, #03a9f4); }
.step.inferred .pin { background: var(--card-background-color, #fff); border: 2px solid var(--primary-color, #03a9f4); width: 6px; height: 6px; }
.step .st-t { color: var(--secondary-text-color, #777); font-variant-numeric: tabular-nums; }
.step .play { border: 0; background: none; color: var(--primary-color, #03a9f4); cursor: pointer; }
.fold summary { cursor: pointer; color: var(--secondary-text-color, #666); padding: 4px 0; }
.help { color: var(--secondary-text-color, #777); font-size: 12px; }
`;

export class RzpHeadcount extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${css}</style>`;
    this.barEl = el('div', { class: 'bar' });
    this.houseEl = el('div', { class: 'house' });
    this.logEl = el('div', { class: 'log' });
    this.sheetEl = el('div', { class: 'sheet-wrap', style: { display: 'none' } });
    this.timeline = document.createElement('rzp-timeline');
    root.append(this.barEl, el('div', { class: 'scroll' }, this.houseEl, el('div', { class: 'side' }, this.logEl, this.sheetEl), el('div', { class: 'timeline-wrap' }, this.timeline)));
    this.rangeS = 21600;
    this.windowEnd = null; // null: the window ends now and follows; else an epoch (s) from the time chip
    this.data = null;
    this.entries = [];
    this.cursor = null; // null: now (live)
    this.selected = null; // token id whose story is shown
    this.showSeen = false;
    this._unsub = null;
    this._timer = 0;
    this.timeline.addEventListener('seek', e => { this.cursor = e.detail.t; this.render(); });
    this._ro = new ResizeObserver(() => this._drawLinks());
    this._ro.observe(this.houseEl);
  }

  set hass(h) { this._hass = h; }
  get hass() { return this._hass; }

  /** The tab is shown: load and follow. */
  async activate() {
    if (this._active) return;
    this._active = true;
    await this.load();
    this._timer = setInterval(() => { if (this.cursor === null) this.render(); else this._renderTimeline(); }, 5000);
  }

  deactivate() {
    this._active = false;
    clearInterval(this._timer);
    this._unsubscribe();
  }

  /** Show time t, the scrubber zoomed to `span` s around it (deep links). */
  async showTime(t, span = 600) {
    const ago = Date.now() / 1000 - t;
    const fit = RANGES.find(([, s]) => s >= ago + span / 2);
    if (fit && (fit[1] !== this.rangeS || this.windowEnd)) { this.rangeS = fit[1]; this.windowEnd = null; await this.load(); }
    else if (!fit) { this.rangeS = 86400; this.windowEnd = Math.min(Date.now() / 1000, t + span); await this.load(); } // older: a day ending just after it
    this.cursor = t;
    this.timeline.focus(t - span / 2, t + span / 2);
    this.render();
  }

  linkParams() {
    const v = this.timeline.view;
    const t = this.cursor ?? Date.now() / 1000;
    const q = { view: 'headcount', t: t.toFixed(1) };
    if (v) q.span = Math.round(v.v1 - v.v0);
    return q;
  }

  /** The end of the loaded window: now, or the past moment picked in the time chip. */
  _end() { return this.windowEnd ?? Date.now() / 1000; }

  async load() {
    this._unsubscribe();
    const start = this._end() - this.rangeS;
    try {
      this.data = await this.hass.callWS({ type: `${DOMAIN}/headcount/history`, start, ...(this.windowEnd ? { end: this.windowEnd } : {}) });
    } catch (err) {
      this.data = null;
      this.houseEl.replaceChildren(el('div', { class: 'empty' }, `No occupant count: ${err.message || err.code}`));
      return;
    }
    this.start = start;
    this.maps = await loadMaps(this.hass).catch(() => []); // room shapes, for floors drawn as a plan
    this.entries = this.data.log;
    this._letters = new Map(); // tokens get letters A, B, C… in the order they show up in this range
    this._index();
    if (this.windowEnd) this.cursor ??= this.windowEnd; // a past window: show its end, and don't follow
    else this._subscribe();
    this.timeline.set({ range: { start, end: this._end() }, resetView: true });
    this.render();
  }

  async _subscribe() {
    try {
      this._unsub = await this.hass.connection.subscribeMessage(msg => {
        if (msg.closed) { setTimeout(() => this._active && this.load(), 3000); return; } // the home reloaded
        this.entries.push(...msg.log);
        this.data.now = { t: msg.log[msg.log.length - 1].t, tokens: msg.log[msg.log.length - 1].tokens, unknown_floors: msg.log[msg.log.length - 1].unknown_floors };
        if (this.cursor === null) this.render(); else this._renderTimeline();
      }, { type: `${DOMAIN}/headcount/subscribe` });
    } catch { /* an older integration: no live updates */ }
  }

  _unsubscribe() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  // ------------------------------------------------------------ model

  _index() {
    const d = this.data;
    this.regionArea = {};
    this.regionRadars = {}; // region -> radars that see it, its own first (to open the radar view)
    this.areas = new Map(); // area id -> {id, name, level, observed, regions}
    for (const sp of d.spaces) {
      this.regionArea[sp.id] = sp.area_id;
      this.regionRadars[sp.id] = sp.radars || [];
      const a = this.areas.get(sp.area_id) || { id: sp.area_id, name: sp.name, level: sp.level, observed: false, regions: [] };
      a.observed ||= sp.observed;
      a.regions.push(sp.id);
      this.areas.set(sp.area_id, a);
    }
    const levels = [...new Set([...this.areas.values()].map(a => a.level))].sort((x, y) => y - x); // upstairs on top
    const floorName = lv => d.floors.find(f => f.level === lv)?.name || `Floor ${lv}`;
    this.floors = levels.map(lv => ({ level: lv, name: floorName(lv), areas: [...this.areas.values()].filter(a => a.level === lv) }));
    this.links = [];
    const seen = new Set();
    for (const [a, b, door] of d.connections) {
      const [x, y] = [this.regionArea[a], this.regionArea[b]];
      const key = [x, y].sort().join('|');
      if (x === y || seen.has(key)) continue;
      seen.add(key);
      this.links.push({ a: x, b: y, door });
    }
  }

  /** 'Garage Entry Door Sensor Door' -> 'Garage entry door'. */
  _doorLabel(e) {
    const n = this._entityName(e).replace(/\b(contact|sensor)\b/gi, ' ').replace(/\s+/g, ' ').trim().replace(/\b(\w+)\s+\1$/i, '$1');
    return n.charAt(0) + n.slice(1).toLowerCase();
  }

  _doorWord(st) {
    return { on: 'open', off: 'closed', open: 'open', closed: 'closed', opening: 'opening', closing: 'closing', locked: 'locked', unlocked: 'unlocked' }[st] || st;
  }

  _name(region) { return this.areas.get(this.regionArea[region] ?? region)?.name ?? region; }
  _entityName(e) { return this.hass.states[e]?.attributes.friendly_name || e; }

  /** Who was where at t (null: now): the last log entry at or before t. */
  _stateAt(t) {
    if (t === null) return this.data.now || this.entries[this.entries.length - 1] || this.data.before;
    let lo = 0, hi = this.entries.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.entries[m].t <= t) lo = m + 1; else hi = m; }
    return lo ? this.entries[lo - 1] : this.data.before;
  }

  _doorAt(entity, t) {
    let state = null;
    for (const e of this.entries) {
      if (e.kind !== 'door' || e.entity !== entity) continue;
      if (t !== null && e.t > t) { if (state === null) state = ['on', 'open', 'opening', 'unlocked'].includes(e.detail) ? 'closed' : 'open'; break; }
      state = e.detail;
    }
    return state ?? this.hass.states[entity]?.state ?? '?';
  }

  _counts(snap) {
    const per = new Map(), unknownFloors = new Set(snap?.unknown_floors || []);
    for (const [, region, flags] of snap?.tokens || []) {
      if (flags.includes('u') || flags.includes('p')) continue;
      const a = this.regionArea[region] ?? region;
      per.set(a, (per.get(a) || 0) + 1);
    }
    return { per, unknownFloors };
  }

  // ------------------------------------------------------------ render

  render() {
    if (!this.data) return;
    const t = this.cursor;
    const snap = this._stateAt(t);
    this._renderBar(snap);
    this._renderHouse(snap, t);
    this._renderLog(t);
    this._renderTimeline();
  }

  _renderBar(snap) {
    const { per, unknownFloors } = this._counts(snap);
    const total = [...per.values()].reduce((x, y) => x + y, 0);
    const doubt = (snap?.tokens || []).filter(([, , f]) => f.includes('u')).length;
    const range = timeChip({
      end: this._end(), len: this.rangeS, past: !!this.windowEnd, ranges: RANGES, state: this, rerender: () => this._renderBar(this._stateAt(this.cursor)),
      go: (endAt, len) => { this.rangeS = len; this.windowEnd = endAt; this.cursor = endAt; this.load(); },
    });
    const live = this.cursor === null;
    this.barEl.replaceChildren(
      range,
      el('button', { class: `live-pill${live ? ' live' : ''}`, title: live ? 'Following now' : 'Back to now',
        onclick: () => { this.cursor = null; if (this.windowEnd) { this.windowEnd = null; this.load(); } else this.render(); } },
        live ? '● Live' : `History · ${fmtTime(this.cursor)}`),
      this.data.log_start && this.start < this.data.log_start ? el('span', { class: 'meta' }, `(log starts ${fmtDateTime(this.data.log_start)})`) : '',
      el('span', { class: `home${unknownFloors.size || doubt ? ' settling' : ''}` }, 'Home ', el('b', {}, unknownFloors.size || doubt ? `${total}+` : String(total)),
        unknownFloors.size || doubt ? el('span', { class: 'settle', title: 'A door to outside is in use: not sure yet who went out' }, 'settling') : '',
        live && total ? el('button', { class: 'minus', title: 'Correct: one person fewer home (removes whoever has gone unseen longest)', onclick: () => this._correctHome(total - 1) }, '−') : '',
        live ? el('button', { title: 'Everyone is out: set the home to 0', onclick: () => this._correctHome(0) }, 'Nobody home') : ''),
    );
  }

  _renderHouse(snap, t) {
    const { per, unknownFloors } = this._counts(snap);
    const byArea = new Map();
    for (const [id, region, flags] of snap?.tokens || []) {
      const a = this.regionArea[region] ?? region;
      if (!byArea.has(a)) byArea.set(a, []);
      byArea.get(a).push([id, flags]);
    }
    const hot = this._recentCrossings(t);
    const hit = new Set(); // spaces where something happened in the last few seconds
    const now = t ?? Date.now() / 1000;
    for (const e of this.entries) if (e.t <= now && e.t > now - CROSS_S && e.region && e.kind !== 'seen') hit.add(this.regionArea[e.region] ?? e.region);
    this.boxes = new Map();
    const floors = this.floors.map(f => {
      const doubt = unknownFloors.has(f.level);
      const n = f.areas.reduce((x, a) => x + (per.get(a.id) || 0), 0);
      const plan = planFor(this.maps || [], new Set(f.areas.map(a => a.id)));
      const mode = plan ? localStorage.getItem(`rzp.plan.${f.level}`) || (innerWidth > 700 ? 'plan' : 'diagram') : 'diagram';
      const box = (a, mini = false) => {
          const doors = Object.entries(this.data.doors).filter(([, rs]) => rs.some(r => this.regionArea[r] === a.id));
          const radar = a.regions.map(r => this.regionRadars[r]?.[0]).find(Boolean);
          const count = per.get(a.id) || 0;
          const tile = el('div', {
            class: `space${a.observed ? '' : ' blind'}${hit.has(a.id) ? ' hit' : ''}${count ? ' occ' : ''}${radar ? ' link' : ''}`,
            title: radar ? `Open ${a.name} at this moment` : '',
            onclick: e => { if (radar && !e.composedPath().some(n => n.tagName === 'BUTTON' || n.classList?.contains('dot'))) this.dispatchEvent(new CustomEvent('open-radar', { detail: { radar, t: t ?? Date.now() / 1000 } })); },
          },
            el('div', { class: 'top' }, el('span', { class: 'name', title: a.name }, a.name),
              t === null ? el('span', { class: 'fix' },
                el('button', { title: 'Correct: one person fewer here', onclick: () => this._correct(a.id, (per.get(a.id) || 0) - 1) }, '−'),
                el('button', { title: 'Correct: one more person here', onclick: () => this._correct(a.id, (per.get(a.id) || 0) + 1) }, '+')) : '',
              el('span', { class: 'count' }, doubt ? `${per.get(a.id) || 0}?` : String(per.get(a.id) || 0))),
            // "radar · ⇥ Front door closed": how the room is counted, then its outside doors.
            el('div', { class: 'meta' }, a.observed ? 'radar' : 'no radar · counted at its doors',
              ...doors.flatMap(([e]) => {
                const st = this._doorAt(e, t);
                const open = ['on', 'open', 'opening', 'closing', 'unlocked'].includes(st);
                return [' · ', el('span', { class: open ? 'open' : '', title: `${this._entityName(e)}: ${st}` }, `⇥ ${this._doorLabel(e)} ${this._doorWord(st)}`)];
              })),
            el('div', { class: 'dots' }, (byArea.get(a.id) || []).sort((x, y) => x[0] - y[0]).map(([id, flags]) => this._dot(id, flags))),
          );
          if (!mini) this.boxes.set(a.id, tile);
          return tile;
      };
      const toggle = !plan ? '' : el('div', { class: 'seg' },
        ['plan', 'diagram'].map(m => el('button', { class: mode === m ? 'on' : '', onclick: () => { localStorage.setItem(`rzp.plan.${f.level}`, m); this.render(); } }, m === 'plan' ? 'Plan' : 'Diagram')));
      let rooms;
      if (mode === 'plan') {
        const dark = !!this.hass?.themes?.darkMode;
        const radarOf = s => s.radar;
        const drawn = drawPlan(plan, { occupied: a => per.get(a) || 0, dark, onRoom: s => this.dispatchEvent(new CustomEvent('open-radar', { detail: { radar: radarOf(s), t: t ?? Date.now() / 1000 } })) });
        const labels = [...plan.areas].map(id => this.areas.get(id)).filter(Boolean).map(a => {
          const at = drawn.place(a.id);
          const b = box(a, true);
          b.classList.add('mini');
          Object.assign(b.style, { left: `${at.x}%`, top: `${at.y}%` });
          return b;
        });
        const others = f.areas.filter(a => !plan.areas.has(a.id));
        rooms = el('div', { class: 'plan' },
          el('div', { class: 'plan-map', style: { aspectRatio: `${1 / drawn.aspect}` } }, drawn.svg, ...labels),
          others.length ? el('div', { class: 'rooms' }, others.map(a => { const b = box(a); b.querySelector('.meta').textContent ||= 'not on this map'; return b; })) : '');
      } else rooms = el('div', { class: 'rooms' }, f.areas.map(a => box(a)));
      return el('div', { class: `floor${doubt ? ' doubt' : ''}` },
        el('h2', {}, f.name, el('span', { class: 'n', title: doubt ? 'Settling: a door to outside is in use, so it is not sure yet who left' : '' }, doubt ? `${n}+` : String(n)), toggle),
        rooms);
    });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'links');
    this.floorsEl = el('div', { class: 'floors' }, floors);
    this.houseEl.replaceChildren(this.svg, this.floorsEl);
    this.sheetEl.replaceChildren(this._story() || '');
    this.sheetEl.style.display = this.selected === null ? 'none' : '';
    this._hot = hot;
    requestAnimationFrame(() => this._drawLinks());
  }

  async _correctHome(n) {
    const from = this._total(this._stateAt(null));
    try {
      const r = await this.hass.callWS({ type: `${DOMAIN}/headcount/correct`, count: n });
      this._followUp(r?.t, from, n);
    } catch (err) {
      alert(`Could not correct: ${err.message || err.code}`);
    }
  }

  /** A correction from someone who knows: this space holds n people now. */
  async _correct(space, n) {
    if (n < 0) return;
    const from = this._total(this._stateAt(null));
    try {
      const r = await this.hass.callWS({ type: `${DOMAIN}/headcount/correct`, space, count: n });
      this._followUp(r?.t, from, from - (this._counts(this._stateAt(null)).per.get(space) || 0) + n);
    } catch (err) {
      alert(`Could not correct: ${err.message || err.code}`);
    }
  }

  /** "Corrected from 3 to 2. What happened?" (optional, never blocking). */
  _followUp(t, from, to) {
    if (t == null) return;
    this.shadowRoot.querySelector('.rzp-followup')?.remove();
    this.shadowRoot.append(correctionFollowUp({ hass: this.hass, t, from, to, floors: this.floors.map(f => f.name),
      onReport: this.admin ? () => this.dispatchEvent(new CustomEvent('report', { detail: { t, symptom: 'count_wrong' } })) : null }));
  }

  /** Person A, B, C…: lettered per loaded range, so they never read as identities. */
  _letter(id) {
    const m = (this._letters ||= new Map());
    if (!m.has(id)) {
      let n = m.size, s = '';
      do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
      m.set(id, s);
    }
    return m.get(id);
  }

  _dot(id, flags) {
    const tips = [flags.includes('v') ? 'seen by a radar' : 'unseen, believed here'];
    if (flags.includes('u')) tips.push('settling: a door to outside is in use');
    if (flags.includes('p')) tips.push('not confirmed yet');
    const dot = el('span', {
      class: `dot ${flags.split('').join(' ')}${this.selected === id ? ' sel' : ''}`,
      title: `Person ${this._letter(id)}: ${tips.join(', ')}. Click to follow.`,
      onclick: () => { this.selected = this.selected === id ? null : id; this.render(); },
    }, this._letter(id));
    dot.style.setProperty('--c', COLORS[id % COLORS.length]);
    return dot;
  }

  /** A person's story, as a side sheet: a summary sentence, then the route (solid: seen; hollow: inferred). */
  _story() {
    if (this.selected === null) return '';
    const id = this.selected;
    const t = this.cursor ?? Infinity;
    const mine = this.entries.filter(e => e.token === id && e.t <= t && ['moved', 'arrived', 'bootstrap', 'restored', 'back', 'confirmed', 'corrected', 'evidence', 'unexplained'].includes(e.kind));
    // Steps: a room and when they got there; a stay in the same room continues the step.
    const steps = [];
    for (const e of mine) {
      const last = steps[steps.length - 1];
      if (last && last.region === e.region) continue;
      steps.push({ region: e.region, t: e.t, seen: e.kind !== 'moved' || !/\(unseen\)/.test(e.detail || ''), kind: e.kind });
    }
    const end = Math.min(t, Date.now() / 1000);
    steps.forEach((st, i) => { st.until = steps[i + 1]?.t ?? end; });
    // Passing through for a few seconds is not a step: fold it into the next one.
    for (let i = steps.length - 2; i >= 0; i--) {
      if (steps[i].until - steps[i].t < 5) { steps[i + 1].t = steps[i].t; steps.splice(i, 1); }
    }
    for (let i = steps.length - 1; i > 0; i--) {
      if (steps[i].region === steps[i - 1].region) { steps[i - 1].until = steps[i].until; steps[i - 1].seen &&= steps[i].seen; steps.splice(i, 1); }
    }
    const close = () => { this.selected = null; this.render(); };
    if (!steps.length) {
      return el('div', { class: 'sheet' }, el('div', { class: 'sheet-h' }, this._dotEl(id), el('b', {}, `Person ${this._letter(id)}`), el('button', { class: 'x', onclick: close }, '✕')),
        el('div', { class: 'help' }, 'Nothing about this person in this time range.'));
    }
    const rooms = [];
    for (const st of steps) if (rooms[rooms.length - 1] !== st.region) rooms.push(st.region);
    const lastStep = steps[steps.length - 1];
    const named = [...new Set(rooms.slice(0, -1).reverse())].slice(0, 3).reverse().map(r => `the ${this._room(r)}`);
    const summary = rooms.length === 1
      ? `In the ${this._room(rooms[0])} since ${fmtTime(steps[0].t, false)}.`
      : `Was in ${named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}` : named[0]} until ${fmtTime(lastStep.t, false)}, then went into the ${this._room(lastStep.region)}.`;
    // Collapse back-and-forth between two rooms (3+ steps) into one expandable line.
    const items = [];
    for (let i = 0; i < steps.length;) {
      let j = i;
      while (j + 2 < steps.length && steps[j + 2].region === steps[j].region && steps[j + 1].region === steps[i + 1]?.region) j += 2;
      if (j - i >= 4) { items.push({ fold: steps.slice(i, j + 1) }); i = j + 1; } else { items.push(steps[i]); i++; }
    }
    const radarOf = r => this.regionRadars?.[r]?.[0];
    const stepEl = st => el('div', { class: `step${st.seen ? '' : ' inferred'}` },
      el('span', { class: 'pin' }), el('span', { class: 'st-t' }, fmtTime(st.t, false)),
      el('span', { class: 'st-r' }, `${this._name(st.region)}`, el('span', { class: 'help' }, ` · ${fmtDuration(Math.max(0, st.until - st.t))}${st.seen ? '' : ' · inferred'}`)),
      radarOf(st.region) ? el('button', { class: 'play', title: 'Play this moment', onclick: () => this.dispatchEvent(new CustomEvent('open-radar', { detail: { radar: radarOf(st.region), t: st.t } })) }, '▶') : '');
    return el('div', { class: 'sheet' },
      el('div', { class: 'sheet-h' }, this._dotEl(id), el('b', {}, `Person ${this._letter(id)}`),
        el('span', { class: 'help' }, `${fmtTime(steps[0].t, false)} – ${fmtTime(end, false)}`), el('button', { class: 'x', title: 'Close', onclick: close }, '✕')),
      el('p', { class: 'sum' }, summary),
      el('div', { class: 'route' }, items.map(it => it.fold
        ? el('details', { class: 'fold' }, el('summary', {}, `${it.fold.length} more steps (${this._room(it.fold[0].region)} ↔ ${this._room(it.fold[1].region)}, ${fmtTime(it.fold[0].t, false)} – ${fmtTime(it.fold[it.fold.length - 1].until, false)})`), it.fold.map(stepEl))
        : stepEl(it))),
      el('div', { class: 'help', style: { marginTop: '8px' } }, 'Letters are given per time range: they are not identities.'));
  }

  _dotEl(id) {
    const d = el('span', { class: 'dot v' }, this._letter(id));
    d.style.setProperty('--c', COLORS[id % COLORS.length]);
    return d;
  }

  /** Doorways someone crossed in the CROSS_S before t: "a|b" keys. */
  _recentCrossings(t) {
    const now = t ?? Date.now() / 1000, out = new Set();
    for (const e of this.entries) {
      if (e.t > now) break;
      if (e.t < now - CROSS_S || e.kind !== 'moved') continue;
      const m = /^from (\S+)/.exec(e.detail || '');
      if (m) out.add([this.regionArea[m[1]] ?? m[1], this.regionArea[e.region] ?? e.region].sort().join('|'));
    }
    return out;
  }

  _drawLinks() {
    if (!this.svg || !this.boxes) return;
    const base = this.houseEl.getBoundingClientRect();
    const r = id => { const b = this.boxes.get(id)?.getBoundingClientRect(); return b && { l: b.left - base.left, r: b.right - base.left, t: b.top - base.top, b: b.bottom - base.top }; };
    const paths = [], chips = [];
    for (const { a, b, door } of this.links) {
      const p = r(a), q = r(b);
      if (!p || !q) continue;
      let d;
      if (Math.abs(p.t - q.t) < 5) { // same row: across the seam between the tiles
        const [L, R] = p.l < q.l ? [p, q] : [q, p];
        const y = (L.t + L.b) / 2;
        d = `M${L.r},${y} L${R.l},${y}`;
      } else { // between floors: from the bottom of the upper tile to the top of the lower one
        const [U, D] = p.t < q.t ? [p, q] : [q, p];
        const x1 = (U.l + U.r) / 2, x2 = (D.l + D.r) / 2, my = (U.b + D.t) / 2;
        d = `M${x1},${U.b} C${x1},${my} ${x2},${my} ${x2},${D.t}`;
      }
      const hot = this._hot?.has([a, b].sort().join('|'));
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', `${door ? 'door' : ''} ${hot ? 'hot' : ''}`);
      paths.push(path);
      // A chip on the seam says what joins the rooms: a door (with its state), an opening, or stairs.
      const sameRow = Math.abs(p.t - q.t) < 5;
      const upper = p.t < q.t ? p : q, lower = p.t < q.t ? q : p;
      const at = sameRow ? [(Math.min(p.r, q.r) + Math.max(p.l, q.l)) / 2, (p.t + p.b) / 2]
        : [(lower.l + lower.r) / 2, lower.t - 25]; // stairs: in the gap above the lower floor's band
      const crossFloor = this.areas.get(a)?.level !== this.areas.get(b)?.level;
      const st = door ? this._doorAt(door, this.cursor) : null;
      const open = st && ['on', 'open', 'opening', 'closing', 'unlocked'].includes(st);
      const chip = el('span', {
        class: `seam${crossFloor ? ' stairs' : ''}${hot ? ' hot' : ''}${open ? ' open' : ''}`,
        style: { left: `${at[0]}px`, top: `${at[1]}px` },
        title: `${this.areas.get(a)?.name} ↔ ${this.areas.get(b)?.name}${door ? ` (door: ${this._entityName(door)}, ${this._doorWord(st)})` : ''}`,
      }, crossFloor ? '↕ stairs' : door ? (open ? 'open' : 'door') : 'opening');
      chips.push(chip);
    }
    this.svg.replaceChildren(...paths);
    this.seamsEl?.remove();
    this.seamsEl = el('div', { class: 'seams' }, chips);
    this.houseEl.append(this.seamsEl);
  }

  _describe(e) {
    const name = s => s.replace(/\b[a-z0-9_]+\b/g, w => (this.regionArea[w] !== undefined ? this._name(w) : w))
      .replace(/\b(binary_sensor|cover|lock|light|switch|fan|event|input_boolean)\.[a-z0-9_]+/g, x => this._entityName(x));
    const [, label] = KINDS[e.kind] || ['', e.kind];
    if (e.kind === 'door') return `${this._entityName(e.entity)}: ${e.detail}`;
    if (e.kind === 'signal') return `${this._entityName(e.entity)}: ${e.detail} by hand (${this._name(e.region)})`;
    if (e.kind === 'ignored') return `${this._entityName(e.entity)} ignored: ${e.detail}`;
    const who = e.token ? `${this._letter(e.token)} ` : '';
    return `${who}${label} ${this._name(e.region)}${e.detail ? ` · ${name(e.detail)}` : ''}`;
  }

  /** A decision made from what a radar saw: a button that opens that radar's view at that moment. */
  _radarLink(e) {
    if (!e.region || ['seen', 'door', 'signal', 'ignored', 'corrected', 'restored'].includes(e.kind)) return '';
    const radar = this.regionRadars?.[e.region]?.[0];
    if (!radar) return '';
    return el('button', {
      class: 'radar', title: 'Open this radar at this moment, to see the detection',
      onclick: ev => { ev.stopPropagation(); this.dispatchEvent(new CustomEvent('open-radar', { detail: { radar, t: e.t } })); },
    }, '📡');
  }

  /** Home count in a snapshot: people who are neither settling nor unconfirmed. */
  _total(snap) {
    return (snap?.tokens || []).filter(([, , f]) => !f.includes('u') && !f.includes('p')).length;
  }

  _who(e) { return e.token ? `Person ${this._letter(e.token)}` : 'Someone'; }
  _room(region) { const n = this._name(region); return n ? n.toLowerCase() : 'somewhere'; }

  /** The door used around t (the latest door change in the `within` s before, or just after), as 'the garage door'. */
  _doorNear(t, within = 120) {
    let best = null;
    for (const e of this.entries) {
      if (e.kind !== 'door') continue;
      if (e.t > t + 5) break;
      if (e.t >= t - within) best = e;
    }
    return best ? `the ${this._doorLabel(best.entity).toLowerCase()}` : null;
  }

  /** "from <region>" in a moved entry's detail. */
  _from(e) { return /^from (\S+)/.exec(e.detail || '')?.[1]; }

  /** One Activity entry as a sentence. */
  _sentence(e, group = [e]) {
    const who = group.length > 1 ? group.map(g => this._letter(g.token)).join(', ') : this._who(e);
    const room = this._room(e.region);
    switch (e.kind) {
      case 'arrived': { const d = this._doorNear(e.t); return `Someone came home${d ? ` through ${d}` : ` into the ${room}`}`; }
      case 'left': { const d = this._doorNear(e.t, 600); return `${group.length > 1 ? `${group.length} people` : 'Someone'} left${d ? ` by ${d}` : ''}`; }
      case 'unknown': { const d = this._doorNear(e.t); return `Settling: ${d ? `${d} is in use, ` : ''}not sure yet who went out`; }
      case 'back': return group.length > 1 || /still here/.test(e.detail || '') ? `Settled: nobody left${this._doorNear(e.t, 300) ? ` when ${this._doorNear(e.t, 300)} opened` : ''}` : `${who} is still home`;
      case 'moved': {
        const from = this._from(e);
        return `${who} went from the ${this._room(from)} ${/\(unseen\)/.test(e.detail || '') ? 'to' : 'into'} the ${room}`;
      }
      case 'unexplained': return `Something turned up in the ${room}`;
      case 'confirmed': return `Someone turned up in the ${room} without coming through a door`;
      case 'not a person': return `What turned up in the ${room} was not a person`;
      case 'ghost': return `Ignored a detection in the ${room} that never moved (a fan?)`;
      case 'corrected': {
        const why = { left_unseen: 'someone left unseen', pet: 'a pet', visitor: 'a visitor came and went', not_sure: 'not sure why' }[e.answer];
        return `You corrected the count${group.length > 1 ? '' : ` (${room})`}${why ? `: ${why}` : ''}`;
      }
      case 'restored': return 'Restored after a restart';
      case 'bootstrap': return `Counted ${who.toLowerCase() === 'someone' ? 'someone' : who} in the ${room} at the start`;
      case 'evidence': return `${who} is in the ${room}: ${(e.detail || 'a sensor says so').replace(/\b(binary_sensor|input_boolean|switch|light)\.[a-z0-9_]+/g, x => this._entityName(x))}`;
      case 'door': return `${this._doorLabel(e.entity)} ${this._doorWord(e.detail)}`;
      case 'signal': return `${this._entityName(e.entity)} ${e.detail} by hand (${room})`;
      case 'ignored': return `${this._entityName(e.entity)} ignored: ${e.detail}`;
      default: return this._describe(e);
    }
  }

  /** "How we know": 1–4 plain bullets from what the log recorded. */
  _howWeKnow(e) {
    const out = [];
    const d = this._doorNear(e.t, e.kind === 'left' ? 600 : 120);
    if (e.kind === 'moved') {
      const m = /after (\d+)s/.exec(e.detail || '');
      out.push(`Last seen in the ${this._room(this._from(e))}${m ? ` ${m[1]} s before` : ''}`);
      out.push(/\(unseen\)/.test(e.detail || '') ? 'Not seen on the way: lost at a doorway that leads there' : `Then seen in the ${this._room(e.region)}`);
      out.push('Nobody else could have been that person');
    } else if (e.kind === 'arrived') {
      if (d) out.push(`${d.charAt(0).toUpperCase() + d.slice(1)} opened just before`);
      out.push(`A new person appeared in the ${this._room(e.region)}, by the door`);
      out.push('Nobody already inside was near it');
    } else if (e.kind === 'left') {
      if (d) out.push(`${d.charAt(0).toUpperCase() + d.slice(1)} was in use`);
      out.push('They were near it and were not seen again after it closed');
    } else if (e.kind === 'unknown') {
      out.push('A door to outside opened while people were on this floor');
      out.push('Everyone near it counts as settling until they are seen again');
    } else if (e.kind === 'back') {
      out.push('Seen inside again after the door closed');
    } else if (e.kind === 'confirmed') {
      out.push('Not seen coming in through a door');
      out.push('Walked on or stayed long enough to be a person, not a reflection');
    } else if (e.kind === 'corrected') {
      out.push('Set by hand from the panel or a dashboard');
    } else if (e.kind === 'evidence' && e.detail) {
      out.push(e.detail);
    }
    if (this.details) out.push(`${e.kind}${e.token ? ` #${e.token}` : ''} ${e.region || ''} ${e.detail || ''}`.trim());
    return out;
  }

  _renderLog(t) {
    const v = this.timeline.view;
    const lo = v ? v.v0 : this.start, hi = v ? v.v1 : Infinity;
    const technical = new Set(['seen', 'ghost', 'not a person', 'ignored']); // only with Details on
    const counting = new Set(['unknown', 'back', 'corrected', 'arrived', 'left']);
    this.filter ||= 'count';
    // Count before each entry, to say "1 → 2" and to pick the count changes.
    let prev = this._total(this.data.before);
    const rows = [];
    for (const e of this.entries) {
      const n = e.kind === 'door' || e.kind === 'signal' ? prev : this._total(e);
      const changed = n !== prev;
      const before = prev;
      prev = n;
      if (e.t < lo || e.t > hi) continue;
      if (technical.has(e.kind) && !(this.details && (this.showSeen || e.kind !== 'seen'))) continue;
      if (this.filter === 'count' && !changed && !counting.has(e.kind)) continue;
      // One line for the same thing happening to several people at once (settling, restored after a restart).
      const last = rows[rows.length - 1];
      if (last && last.e.kind === e.kind && Math.abs(last.e.t - e.t) < 1 && ['unknown', 'back', 'restored', 'bootstrap', 'left', 'corrected'].includes(e.kind)) {
        last.group.push(e); last.after = n; continue;
      }
      rows.push({ e, group: [e], before, after: n });
    }
    const shown = rows.slice(-300).reverse(); // newest first
    const at = t === null ? 0 : shown.findIndex(r => r.e.t <= t);
    const list = shown.map((r, i) => {
      const { e } = r;
      const open = this._openEntry === e.t + e.kind + e.token;
      const radar = e.region ? this.regionRadars?.[e.region]?.[0] : null;
      const delta = r.before !== r.after ? `${r.before} → ${r.after}` : e.kind === 'moved' ? 'moved' : '';
      return el('div', { class: `row${i === at ? ' at' : ''}${t !== null && e.t > t ? ' after' : ''}${technical.has(e.kind) ? ' ignored' : ''}` },
        el('div', { class: 'line', onclick: () => { this._openEntry = open ? null : e.t + e.kind + e.token; this.cursor = e.t; this.render(); } },
          el('span', { class: 't' }, fmtTime(e.t, false)), el('span', { class: 'say' }, this._sentence(e, r.group)), el('span', { class: 'delta' }, delta)),
        open ? el('div', { class: 'how' },
          el('div', { class: 'how-h' }, 'How we know'),
          el('ul', {}, this._howWeKnow(e).map(b => el('li', {}, b))),
          el('div', { class: 'links' },
            e.token ? el('button', { onclick: () => { this.selected = e.token; this.render(); } }, `Follow person ${this._letter(e.token)}`) : '',
            radar ? el('button', { onclick: () => this.dispatchEvent(new CustomEvent('open-radar', { detail: { radar, t: e.t } })) }, `▶ Play in the ${this._room(e.region)}`) : '',
            this.admin ? el('button', { onclick: () => this.dispatchEvent(new CustomEvent('report', { detail: { t: e.t, symptom: 'count_wrong' } })) }, 'Report a problem with this') : '')) : '');
    });
    const chip = (key, label) => el('button', { class: `fchip${this.filter === key ? ' on' : ''}`, onclick: () => { this.filter = key; this.render(); } }, label);
    this.logEl.replaceChildren(
      el('h3', {}, 'Activity', el('span', { class: 'chips' }, chip('count', 'Count changes'), chip('all', 'All movement')),
        this.details ? el('label', {}, el('input', { type: 'checkbox', checked: this.showSeen, onchange: e => { this.showSeen = e.target.checked; this.render(); } }), 'sightings') : ''),
      ...(list.length ? list : [el('div', { class: 'empty' }, this.filter === 'count' ? 'The count did not change in this window.' : 'Nothing in this window.')]));
    if (t !== null) this.logEl.querySelector('.row.at')?.scrollIntoView({ block: 'nearest' });
  }

  _renderTimeline() {
    if (!this.data) return;
    const end = this._end();
    const snaps = [this.data.before, ...this.entries].filter(Boolean);
    const step = fn => { // [[a, b, n, label]] of fn(snapshot) over the range
      const out = [];
      let cur = null;
      for (const s of snaps) {
        const [n, label] = fn(s);
        const a = Math.max(s.t ?? this.start, this.start);
        if (cur && cur[2] === n && cur[3] === label) continue;
        if (cur) cur[1] = a;
        cur = [a, end, n, label];
        out.push(cur);
      }
      return out;
    };
    const rows = [{
      id: 'home', name: 'Home', color: '#455a64',
      steps: step(s => { const { per, unknownFloors } = this._counts(s); const n = [...per.values()].reduce((x, y) => x + y, 0); return [n, unknownFloors.size ? `≥${n}` : undefined]; }),
    }];
    let k = 0;
    for (const f of [...this.floors].reverse()) {
      for (const a of f.areas) {
        rows.push({
          id: a.id, name: a.name, color: COLORS[k++ % COLORS.length],
          steps: step(s => { const { per, unknownFloors } = this._counts(s); const n = per.get(a.id) || 0; return [n, unknownFloors.has(a.level) ? `${n}?` : undefined]; }),
          triggers: this.entries.filter(e => e.kind !== 'seen' && e.kind !== 'door' && (this.regionArea[e.region] ?? e.region) === a.id).map(e => e.t),
        });
      }
    }
    for (const door of Object.keys(this.data.doors)) {
      const bands = [];
      let open = null;
      for (const e of this.entries) {
        if (e.kind !== 'door' || e.entity !== door) continue;
        const isOpen = ['on', 'open', 'opening', 'closing', 'unlocked'].includes(e.detail);
        if (isOpen && open === null) open = e.t;
        if (!isOpen && open !== null) { bands.push([open, e.t]); open = null; }
        if (e.kind === 'door' && door.startsWith('lock.')) bands.push([e.t - 5, e.t + 5]);
      }
      if (open !== null) bands.push([open, end]);
      rows.push({ id: door, name: `🚪 ${this._entityName(door)}`, color: '#fb8c00', predicted: bands });
    }
    rows.push({
      id: 'evidence', name: '☞ by hand', color: '#7cb342',
      triggers: this.entries.filter(e => e.kind === 'signal').map(e => e.t),
      actualTriggers: this.entries.filter(e => e.kind === 'ignored').map(e => e.t),
    });
    const changes = this.entries.filter(e => e.kind !== 'seen' && e.kind !== 'door' && e.kind !== 'ignored');
    this.timeline.set({
      range: { start: this.start, end },
      rows,
      frames: { start: this.start, t: changes.map(e => e.t - this.start), n: changes.map(() => 1) },
      cursor: this.cursor,
      follow: this.cursor === null,
    });
  }
}

customElements.get('rzp-headcount') || customElements.define('rzp-headcount', RzpHeadcount);
