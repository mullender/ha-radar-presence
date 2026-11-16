// <rzp-headcount>: the head count's view in the Radar Zones panel. The floors
// side by side, each tracked space a box with the people believed in it (solid:
// a radar sees them; hollow: unseen; dashed: in doubt while an exit door is in
// use; faint: not confirmed yet). Under it the scrubber: people per space, doors
// open, evidence; and the decision log, each change with what caused it. Built
// from the integration's decision log (`headcount/history` + `headcount/subscribe`).

import './timeline.js';
import { el, fmtTime, fmtDateTime } from './util.js';

const DOMAIN = 'radar_zone_presence';
const RANGES = [['1 hour', 3600], ['6 hours', 21600], ['24 hours', 86400], ['3 days', 259200]];
const COLORS = ['#1e88e5', '#43a047', '#8e24aa', '#f4511e', '#00897b', '#6d4c41', '#3949ab', '#c0ca33', '#d81b60'];
const KINDS = {
  moved: ['→', 'moved'], arrived: ['⇥', 'arrived'], left: ['⇤', 'left'], unknown: ['?', 'in doubt'], back: ['✓', 'back'],
  unexplained: ['+', 'appeared'], confirmed: ['✓', 'confirmed'], 'not a person': ['✕', 'not a person'], ghost: ['·', 'ghost track'],
  restored: ['↺', 'restored'], bootstrap: ['+', 'counted at start'], evidence: ['☞', 'evidence'], door: ['🚪', 'door'],
  signal: ['☞', 'used by hand'], ignored: ['∅', 'ignored'],
};
const CROSS_S = 30; // a doorway glows this long after someone crossed it

const css = `
:host { display: flex; flex-direction: column; min-height: 0; height: 100%; color: var(--primary-text-color, #222); }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 6px 10px; background: var(--card-background-color, #fff);
  border-bottom: 1px solid var(--divider-color, #ddd); font-size: 13px; }
.bar select, .bar button { font: inherit; font-size: 13px; padding: 3px 8px; border: 1px solid var(--divider-color, #ccc); border-radius: 4px;
  background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); cursor: pointer; }
.bar button.on { background: var(--error-color, #db4437); color: #fff; border-color: transparent; }
.bar .when { font-weight: 500; }
.bar .home { margin-left: auto; font-size: 15px; }
.bar .home b { font-size: 20px; }
.scroll { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: minmax(0, 1fr) 360px; }
:host([narrow]) .scroll { grid-template-columns: 1fr; }
.house { position: relative; padding: 14px; min-width: 0; }
.floors { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(180px, 1fr); gap: 56px; z-index: 1; }
.floor h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color, #666);
  display: flex; gap: 8px; align-items: baseline; }
.floor h2 .n { margin-left: auto; font-size: 15px; color: var(--primary-text-color, #222); text-transform: none; }
.floor.doubt h2 .n { color: var(--warning-color, #f9a825); }
.space { background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, #ddd); border-radius: 8px; padding: 8px 10px; margin-bottom: 14px;
  min-height: 74px; transition: box-shadow .2s; }
.space.blind { border-style: dashed; }
.space.hit { box-shadow: 0 0 0 2px var(--primary-color, #03a9f4); }
.space .top { display: flex; align-items: baseline; gap: 6px; }
.space .name { font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.space .count { font-size: 22px; font-weight: 500; }
.space .meta { font-size: 11px; color: var(--secondary-text-color, #777); }
.dots { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; min-height: 22px; }
.dot { font-size: 11px; min-width: 26px; height: 22px; padding: 0 5px; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center;
  border: 2px solid var(--c); color: var(--c); cursor: pointer; }
.dot.v { background: var(--c); color: #fff; }
.dot.u { border-style: dashed; }
.dot.p { opacity: .45; }
.dot.sel { outline: 2px solid var(--primary-text-color, #222); outline-offset: 1px; }
.doors { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.chip { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--secondary-background-color, #eee); color: var(--secondary-text-color, #555); }
.chip.open { background: #fb8c00; color: #fff; }
svg.links { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; overflow: visible; }
svg.links path { fill: none; stroke: var(--divider-color, #bbb); stroke-width: 2; }
svg.links path.door { stroke-dasharray: 5 4; }
svg.links path.hot { stroke: var(--primary-color, #03a9f4); stroke-width: 4; }
.timeline-wrap { grid-column: 1 / -1; background: var(--card-background-color, #fff); border-top: 1px solid var(--divider-color, #ddd); padding: 2px 0; }
.log { border-left: 1px solid var(--divider-color, #ddd); background: var(--card-background-color, #fff); overflow-y: auto; max-height: 70vh; font-size: 12px; }
:host([narrow]) .log { border-left: 0; max-height: 40vh; }
.log h3 { position: sticky; top: 0; margin: 0; padding: 8px 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color, #666);
  background: var(--card-background-color, #fff); border-bottom: 1px solid var(--divider-color, #ddd); display: flex; gap: 8px; }
.log h3 label { margin-left: auto; text-transform: none; letter-spacing: 0; display: flex; gap: 4px; align-items: center; }
.row { display: grid; grid-template-columns: 58px 18px minmax(0, 1fr); gap: 4px; padding: 4px 10px; border-bottom: 1px solid var(--divider-color, #eee); cursor: pointer; }
.row:hover { background: var(--secondary-background-color, #f4f4f4); }
.row.at { background: rgba(3,169,244,.12); }
.row.after { opacity: .45; }
.row .t { color: var(--secondary-text-color, #777); font-variant-numeric: tabular-nums; }
.row .k { text-align: center; }
.row .why { color: var(--secondary-text-color, #777); }
.row.ignored { color: var(--secondary-text-color, #888); }
.empty { padding: 30px; color: var(--secondary-text-color, #777); }
.story { padding: 8px 10px; border-bottom: 1px solid var(--divider-color, #ddd); background: var(--secondary-background-color, #f7f7f7); }
.story b { display: block; margin-bottom: 4px; }
`;

export class RzpHeadcount extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${css}</style>`;
    this.barEl = el('div', { class: 'bar' });
    this.houseEl = el('div', { class: 'house' });
    this.logEl = el('div', { class: 'log' });
    this.timeline = document.createElement('rzp-timeline');
    root.append(this.barEl, el('div', { class: 'scroll' }, this.houseEl, this.logEl, el('div', { class: 'timeline-wrap' }, this.timeline)));
    this.rangeS = 21600;
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
    if (fit && fit[1] !== this.rangeS) { this.rangeS = fit[1]; await this.load(); }
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

  async load() {
    this._unsubscribe();
    const start = Date.now() / 1000 - this.rangeS;
    try {
      this.data = await this.hass.callWS({ type: `${DOMAIN}/headcount/history`, start });
    } catch (err) {
      this.data = null;
      this.houseEl.replaceChildren(el('div', { class: 'empty' }, `No head count: ${err.message || err.code}`));
      return;
    }
    this.start = start;
    this.entries = this.data.log;
    this._index();
    this._subscribe();
    this.timeline.set({ range: { start, end: Date.now() / 1000 }, resetView: true });
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
    this.areas = new Map(); // area id -> {id, name, level, observed, regions}
    for (const sp of d.spaces) {
      this.regionArea[sp.id] = sp.area_id;
      const a = this.areas.get(sp.area_id) || { id: sp.area_id, name: sp.name, level: sp.level, observed: false, regions: [] };
      a.observed ||= sp.observed;
      a.regions.push(sp.id);
      this.areas.set(sp.area_id, a);
    }
    const levels = [...new Set([...this.areas.values()].map(a => a.level))].sort((x, y) => x - y);
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
    const range = el('select', { onchange: e => { this.rangeS = +e.target.value; this.cursor = null; this.load(); } },
      RANGES.map(([label, s]) => el('option', { value: s, selected: s === this.rangeS }, `Last ${label}`)));
    const live = this.cursor === null;
    this.barEl.replaceChildren(
      range,
      el('button', { class: live ? 'on' : '', title: 'Follow now', onclick: () => { this.cursor = null; this.render(); } }, live ? '● Live' : 'Go live'),
      el('span', { class: 'when' }, live ? `Now, ${fmtTime(Date.now() / 1000)}` : fmtDateTime(this.cursor)),
      this.data.log_start && this.start < this.data.log_start ? el('span', { class: 'meta' }, `(log starts ${fmtDateTime(this.data.log_start)})`) : '',
      el('span', { class: 'home' }, 'Home ', el('b', {}, unknownFloors.size ? `≥${total}` : String(total)), doubt ? ` (+${doubt} in doubt)` : ''),
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
      return el('div', { class: `floor${doubt ? ' doubt' : ''}` },
        el('h2', {}, f.name, el('span', { class: 'n', title: doubt ? 'An exit door is in use: unknown who left' : '' }, doubt ? `≥${n}` : String(n))),
        f.areas.map(a => {
          const doors = Object.entries(this.data.doors).filter(([, rs]) => rs.some(r => this.regionArea[r] === a.id));
          const box = el('div', { class: `space${a.observed ? '' : ' blind'}${hit.has(a.id) ? ' hit' : ''}` },
            el('div', { class: 'top' }, el('span', { class: 'name', title: a.name }, a.name), el('span', { class: 'count' }, doubt ? `${per.get(a.id) || 0}?` : String(per.get(a.id) || 0))),
            el('div', { class: 'meta' }, a.observed ? 'radar' : 'no radar: through its doorways'),
            el('div', { class: 'dots' }, (byArea.get(a.id) || []).sort((x, y) => x[0] - y[0]).map(([id, flags]) => this._dot(id, flags))),
            doors.length ? el('div', { class: 'doors' }, doors.map(([e]) => {
              const st = this._doorAt(e, t);
              const open = ['on', 'open', 'opening', 'closing', 'unlocked'].includes(st);
              return el('span', { class: `chip${open ? ' open' : ''}`, title: `${e}: ${st}` }, `🚪 ${this._entityName(e)}: ${st}`);
            })) : '',
          );
          this.boxes.set(a.id, box);
          return box;
        }));
    });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'links');
    this.floorsEl = el('div', { class: 'floors' }, floors);
    this.houseEl.replaceChildren(this.svg, this.floorsEl, this._story());
    this._hot = hot;
    requestAnimationFrame(() => this._drawLinks());
  }

  _dot(id, flags) {
    const tips = [flags.includes('v') ? 'seen by a radar' : 'unseen, believed here'];
    if (flags.includes('u')) tips.push('in doubt: an exit door is in use');
    if (flags.includes('p')) tips.push('not confirmed yet');
    const dot = el('span', {
      class: `dot ${flags.split('').join(' ')}${this.selected === id ? ' sel' : ''}`,
      title: `#${id}: ${tips.join(', ')}. Click for its story.`,
      onclick: () => { this.selected = this.selected === id ? null : id; this.render(); },
    }, `#${id}`);
    dot.style.setProperty('--c', COLORS[id % COLORS.length]);
    return dot;
  }

  /** A person's story: every log line about them up to the cursor. */
  _story() {
    if (this.selected === null) return '';
    const t = this.cursor ?? Infinity;
    const lines = this.entries.filter(e => e.token === this.selected && e.t <= t).slice(-12);
    return el('div', { class: 'story' }, el('b', {}, `#${this.selected}`),
      lines.length ? lines.map(e => el('div', {}, `${fmtTime(e.t)}  ${this._describe(e)}`)) : 'No changes in this range.');
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
    const paths = [];
    for (const { a, b, door } of this.links) {
      const p = r(a), q = r(b);
      if (!p || !q) continue;
      let d;
      if (Math.abs(p.l - q.l) < 5) { // same floor: a bracket on the right
        const x = p.r, y1 = (p.t + p.b) / 2, y2 = (q.t + q.b) / 2;
        d = `M${x},${y1} C${x + 26},${y1} ${x + 26},${y2} ${x},${y2}`;
      } else {
        const [L, R] = p.l < q.l ? [p, q] : [q, p];
        const y1 = (L.t + L.b) / 2, y2 = (R.t + R.b) / 2, mx = (L.r + R.l) / 2;
        d = `M${L.r},${y1} C${mx},${y1} ${mx},${y2} ${R.l},${y2}`;
      }
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', `${door ? 'door' : ''} ${this._hot?.has([a, b].sort().join('|')) ? 'hot' : ''}`);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${this.areas.get(a)?.name} ↔ ${this.areas.get(b)?.name}${door ? ` (door: ${this._entityName(door)})` : ''}`;
      path.append(title);
      paths.push(path);
    }
    this.svg.replaceChildren(...paths);
  }

  _describe(e) {
    const name = s => s.replace(/\b[a-z0-9_]+\b/g, w => (this.regionArea[w] !== undefined ? this._name(w) : w))
      .replace(/\b(binary_sensor|cover|lock|light|switch|fan|event|input_boolean)\.[a-z0-9_]+/g, x => this._entityName(x));
    const [, label] = KINDS[e.kind] || ['', e.kind];
    if (e.kind === 'door') return `${this._entityName(e.entity)}: ${e.detail}`;
    if (e.kind === 'signal') return `${this._entityName(e.entity)}: ${e.detail} by hand (${this._name(e.region)})`;
    if (e.kind === 'ignored') return `${this._entityName(e.entity)} ignored: ${e.detail}`;
    const who = e.token ? `#${e.token} ` : '';
    return `${who}${label} ${this._name(e.region)}${e.detail ? ` · ${name(e.detail)}` : ''}`;
  }

  _renderLog(t) {
    const v = this.timeline.view;
    const lo = v ? v.v0 : this.start, hi = v ? v.v1 : Infinity;
    const rows = this.entries.filter(e => (this.showSeen || e.kind !== 'seen') && e.t >= lo && e.t <= hi).slice(-400);
    const at = t === null ? rows.length - 1 : rows.findLastIndex(e => e.t <= t);
    const list = rows.map((e, i) => {
      const [icon] = KINDS[e.kind] || ['·'];
      return el('div', {
        class: `row ${e.kind === 'ignored' ? 'ignored' : ''} ${i === at ? 'at' : ''} ${t !== null && e.t > t ? 'after' : ''}`,
        onclick: () => { this.cursor = e.t; this.render(); },
      }, el('span', { class: 't' }, fmtTime(e.t)), el('span', { class: 'k' }, icon), el('span', {}, this._describe(e)));
    });
    this.logEl.replaceChildren(
      el('h3', {}, 'Decisions', el('label', {}, el('input', { type: 'checkbox', checked: this.showSeen, onchange: e => { this.showSeen = e.target.checked; this.render(); } }), 'radar sightings')),
      ...(list.length ? list : [el('div', { class: 'empty' }, 'Nothing in this window.')]));
    this.logEl.querySelector('.row.at')?.scrollIntoView({ block: 'nearest' });
  }

  _renderTimeline() {
    if (!this.data) return;
    const end = Date.now() / 1000;
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
