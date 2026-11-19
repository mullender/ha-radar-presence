// <rzp-todo>: the To do tab. One question at a time, grouped by room, with
// progress. Each answer makes exactly one change, saved right away (with Undo),
// and is remembered on the server so another browser does not ask again.
//
// Questions come from the last day of every radar's history (places where
// something stays, ignore areas people walk through, door sensors that line up
// with a radar) and from the home's layout (rooms nobody can get into, rooms
// without a radar, radars in one room that are not lined up).

import { fovPolygon, pointInPolygon, summarize, validatePolygon } from './engine.js';
import { replayGroup } from './tracker.js';
import { classify, crossCheck, doorEvents, doorPositions, findDwellSpots, offsetConvex, placeExit, spotTimes, suggestMaxHold, trailStats } from './analysis.js';
import { KIND_STYLE, el, fmtDuration, fmtTime, glyphSvg, kindTone, newZoneId } from './util.js';

const DOMAIN = 'radar_zone_presence';
const DAY = 86400;

const css = `
:host { display: block; height: 100%; overflow: auto; background: var(--primary-background-color, #fafafa); color: var(--primary-text-color, #222); font-size: 14px; }
.wrap { max-width: 880px; margin: 0 auto; padding: 18px 20px 40px; }
.head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.head b { font-size: 16px; font-weight: 500; }
.head .muted { color: var(--secondary-text-color, #777); font-size: 13px; }
.head a { margin-left: auto; color: var(--primary-color, #03a9f4); cursor: pointer; font-size: 13px; }
.bar { height: 4px; border-radius: 2px; background: var(--divider-color, #e0e0e0); margin-bottom: 14px; overflow: hidden; }
.bar div { height: 100%; background: var(--primary-color, #03a9f4); }
.card { background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, #e0e0e0); border-radius: 12px; padding: 16px 18px; }
.card h2 { margin: 0 0 6px; font-size: 17px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.card .why { color: var(--secondary-text-color, #666); line-height: 1.45; margin-bottom: 12px; }
.card .q { font-weight: 500; margin: 10px 0 8px; }
.ans { display: flex; flex-direction: column; gap: 8px; }
.ans button { display: flex; align-items: center; gap: 10px; text-align: left; font: inherit; padding: 10px 12px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--divider-color, #ddd); background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); }
.ans button:hover { border-color: var(--primary-color, #03a9f4); }
.ans button.rec { border-color: #0d9488; }
.ans button .tag { font-size: 11px; color: #0d9488; border: 1px solid #0d9488; border-radius: 8px; padding: 0 6px; }
.impact { margin-top: 12px; padding: 8px 10px; border-radius: 8px; background: var(--secondary-background-color, #f4f4f4); font-size: 13px; line-height: 1.4; }
.acts { display: flex; gap: 8px; margin-top: 12px; }
.acts button { font: inherit; font-size: 13px; border: 1px solid var(--divider-color, #ccc); background: none; color: var(--primary-color, #03a9f4); border-radius: 16px; padding: 5px 12px; cursor: pointer; }
.next { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; margin-top: 14px; }
.next div { background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, #e0e0e0); border-radius: 10px; padding: 10px 12px; font-size: 13px; }
.next b { font-weight: 500; display: block; margin-bottom: 2px; }
.next span { color: var(--secondary-text-color, #777); }
.empty { text-align: center; color: var(--secondary-text-color, #666); padding: 50px 20px; line-height: 1.6; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #323232; color: #fff; padding: 10px 16px; border-radius: 6px; z-index: 30;
  display: flex; gap: 14px; align-items: center; }
.toast button { background: none; border: 0; color: #80d8ff; font: inherit; font-weight: 500; cursor: pointer; }
input.name { font: inherit; font-size: 13px; padding: 3px 6px; border: 1px solid var(--divider-color, #ccc); border-radius: 6px; width: 120px; margin-left: auto; }
`;

export class RzpTodo extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>${css}</style><div class="wrap"></div>`;
    this.wrap = this.shadowRoot.querySelector('.wrap');
    this.items = null;
    this.answers = {};
    this.skipped = new Set();
  }

  set hass(h) { this._hass = h; }
  get hass() { return this._hass; }

  /** Number of open questions (for the tab's badge), once built. */
  get count() { return this.items ? this.items.filter(i => !this._done(i)).length : null; }

  async activate({ rebuild = false } = {}) {
    if (this.items && !rebuild) { this.render(); return; }
    if (this._building) return;
    this._building = true;
    this.wrap.replaceChildren(el('div', { class: 'empty' }, 'Looking at the last day of every radar…'));
    try {
      await this.build();
    } catch (err) {
      this.wrap.replaceChildren(el('div', { class: 'empty' }, `Could not build the list: ${err.message || err.code}`));
    }
    this._building = false;
    this.render();
    this.dispatchEvent(new CustomEvent('count', { detail: { count: this.count } }));
  }

  // ------------------------------------------------------------ building

  async build() {
    const hass = this.hass;
    const [{ answers }, list, home] = await Promise.all([
      hass.callWS({ type: `${DOMAIN}/todo/answers` }),
      hass.callWS({ type: `${DOMAIN}/list` }),
      hass.callWS({ type: `${DOMAIN}/headcount/history`, start: Date.now() / 1000 }).catch(() => null),
    ]);
    this.answers = answers;
    this.radars = list.radars;
    this.home = home;
    const end = new Date(), start = new Date(end.getTime() - DAY * 1000);
    const range = { start: start.toISOString(), end: end.toISOString() };
    const items = [];
    this.cfgs = new Map();
    const doors = Object.values(hass.states).filter(s => s.entity_id.startsWith('binary_sensor.') && ['door', 'garage_door', 'opening'].includes(s.attributes.device_class)).map(s => s.entity_id);
    let doorRows = {};
    if (doors.length) {
      const res = await hass.callWS({ type: 'history/history_during_period', entity_ids: doors, minimal_response: true, no_attributes: true, significant_changes_only: false, start_time: range.start, end_time: range.end }).catch(() => ({}));
      for (const id of doors) doorRows[id] = (res[id] || []).map(r => [r.lu ?? r.last_updated, r.s ?? r.state]);
    }
    for (const r of this.radars) {
      this.wrap.replaceChildren(el('div', { class: 'empty' }, `Looking at ${r.area || r.title}…`));
      const [cfg, hist] = await Promise.all([
        hass.callWS({ type: `${DOMAIN}/config`, radar_id: r.radar_id }),
        hass.callWS({ type: `${DOMAIN}/frames/history`, radar_id: r.radar_id, ...range }).catch(() => null),
      ]);
      this.cfgs.set(r.radar_id, cfg);
      if (!hist || !hist.frame_t.length) continue;
      items.push(...this._radarQuestions(r, cfg, hist, doorRows));
    }
    items.push(...this._layoutQuestions());
    this.items = items;
  }

  _room(r) { return r.area || r.title; }

  _radarQuestions(r, cfg, hist, doorRows) {
    const out = [];
    const valid = cfg.zones.filter(z => !validatePolygon(z.polygon));
    const exclusions = valid.filter(z => z.kind === 'exclude');
    const rooms = valid.filter(z => z.kind === 'include' && !z.spot);
    const spots = valid.filter(z => z.kind === 'linger' || (z.kind === 'include' && z.spot));
    // Places where something stays, not covered by a spot or an ignore area yet.
    for (const sp of findDwellSpots(hist, { exclusions })) {
      const [cx, cy] = sp.centroid;
      if (spots.some(z => pointInPolygon(cx, cy, z.polygon))) continue;
      const key = `${r.radar_id}:spot:${Math.round(cx / 300)},${Math.round(cy / 300)}`;
      const polygon = offsetConvex(sp.hull, 300) || sp.hull;
      const stats = trailStats(hist, polygon, { exclusions });
      const cls = classify(stats);
      const times = spotTimes(hist, polygon, { exclusions });
      out.push({ key, type: 'spot', radar: r, cfg, hist, sp, polygon, stats, cls, times, room: rooms.find(z => pointInPolygon(cx, cy, z.polygon)) });
    }
    // Ignore areas people walk through.
    for (const z of exclusions) {
      const st = trailStats(hist, z.polygon, { exclusions: exclusions.filter(q => q !== z) });
      if (st.walkIn >= 10 && st.walkOut >= st.walkIn / 2) out.push({ key: `${r.radar_id}:walked:${z.id}`, type: 'walked', radar: r, cfg, zone: z, walkIn: st.walkIn });
    }
    // Door sensors that line up with this radar and are not a doorway yet.
    const linked = new Set(valid.filter(z => z.kind === 'exit').map(z => z.door_entity_id).filter(Boolean));
    for (const [id, rows] of Object.entries(doorRows)) {
      if (linked.has(id) || rows.length < 4) continue;
      const pos = doorPositions(hist, doorEvents(rows), { exclusions });
      if (!pos.events || pos.hits / pos.events < 0.5 || pos.events < 3 || !pos.points.length) continue;
      out.push({ key: `${r.radar_id}:door:${id}`, type: 'door', radar: r, cfg, door: id, pos });
    }
    return out;
  }

  _layoutQuestions() {
    const out = [];
    const h = this.home;
    if (!h) return out;
    const areas = this.hass.areas || {};
    const name = a => areas[a]?.name || a;
    const linked = new Set(h.connections.flatMap(([a, b]) => [a, b]));
    const outside = new Set(Object.values(h.doors || {}).flat());
    for (const sp of h.spaces) {
      if (sp.id !== sp.area_id) continue;
      const exits = sp.exits?.length || 0;
      if (!sp.observed) out.push({ key: `layout:no-radar:${sp.area_id}`, type: 'noradar', area: sp.area_id, title: name(sp.area_id), linkedTo: linked.has(sp.id) });
      else if (!linked.has(sp.id) && !exits && !outside.has(sp.id)) out.push({ key: `layout:no-doorway:${sp.area_id}`, type: 'nodoor', area: sp.area_id, title: name(sp.area_id) });
    }
    // Radars in one room that are not lined up.
    const byArea = new Map();
    for (const r of this.radars || []) if (r.area_id) byArea.set(r.area_id, [...(byArea.get(r.area_id) || []), r]);
    for (const [area, rs] of byArea) {
      if (rs.length < 2) continue;
      const cfgs = rs.map(r => this.cfgs.get(r.radar_id));
      const ids = new Set(rs.map(r => r.radar_id));
      const aligned = cfgs.some(c => (c?.group?.members || []).filter(id => ids.has(id)).length > 1);
      if (!aligned) out.push({ key: `layout:unlinked:${area}`, type: 'unlinked', area, title: name(area), radars: rs });
    }
    return out;
  }

  _done(i) { return !!this.answers[i.key] || this.skipped.has(i.key); }

  // ------------------------------------------------------------ rendering

  render() {
    if (!this.items) return;
    const open = this.items.filter(i => !this._done(i));
    if (!open.length) {
      this.wrap.replaceChildren(el('div', { class: 'empty' },
        el('div', { style: { fontSize: '17px', marginBottom: '6px' } }, 'Nothing to do'),
        'Suggestions show up here as the radars learn your home: places where people stay, ghosts, doors and rooms without a way in.',
        el('div', { style: { marginTop: '12px' } }, el('button', { class: 'pill', style: { font: 'inherit' }, onclick: () => { this.skipped.clear(); this.activate({ rebuild: true }); } }, 'Look again'))));
      return;
    }
    const item = open[0];
    const group = this._group(item);
    const inGroup = this.items.filter(i => this._group(i) === group);
    const doneInGroup = inGroup.filter(i => this._done(i)).length;
    const n = doneInGroup + 1;
    this.wrap.replaceChildren(
      el('div', { class: 'head' }, el('b', {}, group), el('span', { class: 'muted' }, `${n} of ${inGroup.length}${open.length > 1 ? ` · ${open.length} open in all` : ''}`),
        el('a', { onclick: () => { this.skipped.add(item.key); this.render(); this._emitCount(); } }, 'Skip for now')),
      el('div', { class: 'bar' }, el('div', { style: { width: `${(100 * doneInGroup) / inGroup.length}%` } })),
      this._card(item),
      open.length > 1 ? el('div', { class: 'next' }, open.slice(1, 4).map((i, k) => el('div', {}, el('b', {}, `${k ? 'Then' : 'Next'} · ${this._short(i)}`), el('span', {}, this._hint(i))))) : '');
  }

  _emitCount() { this.dispatchEvent(new CustomEvent('count', { detail: { count: this.count } })); }

  _group(i) { return i.radar ? this._room(i.radar) : i.title || 'House'; }

  _short(i) {
    return { spot: i.cls?.kind === 'ghost' ? 'Something still?' : 'A place people stay?', walked: 'An ignore area people walk through', door: 'A doorway?', noradar: `${i.title}`, nodoor: `${i.title}`, unlinked: `${i.title}: two radars` }[i.type];
  }

  _hint(i) {
    if (i.type === 'spot') return `${fmtDuration(i.sp.dwell)} in the last day, ${this._room(i.radar)}.`;
    if (i.type === 'walked') return `${i.zone.name}: walked into ${i.walkIn}× in a day.`;
    if (i.type === 'door') return `${this._entityName(i.door)} lines up with ${this._room(i.radar)}.`;
    if (i.type === 'noradar') return 'No radar. Mark its doorway so it can be counted.';
    if (i.type === 'nodoor') return 'How do people get in?';
    if (i.type === 'unlinked') return 'Seen by 2 radars that are not lined up.';
    return '';
  }

  _entityName(id) {
    const n = this.hass.states[id]?.attributes.friendly_name || id;
    return n.replace(/\b(contact|sensor)\b/gi, ' ').replace(/\s+/g, ' ').trim().replace(/\b(\w+)\s+\1$/i, '$1');
  }

  _card(i) {
    const show = (radar, t) => el('button', { onclick: () => this.dispatchEvent(new CustomEvent('open-radar', { detail: { radar, t } })) }, '▶ Show me');
    const acts = [];
    let body;
    if (i.type === 'spot') {
      const st = i.stats, ghost = i.cls.kind === 'ghost';
      const walked = st.startWalk, starts = st.startWalk + st.startAppear;
      const peak = i.times?.peak != null ? i.hist.start + i.times.peak : null;
      const name = el('input', { class: 'name', value: 'Spot', title: 'Name of the spot', onclick: e => e.stopPropagation() });
      body = [
        el('h2', {}, ghost ? 'Something sits still here' : 'Someone sits here'),
        el('div', { class: 'why' },
          `About ${fmtDuration(i.sp.dwell)} in the last day${peak ? `, most around ${fmtTime(peak, false)}` : ''}. `,
          !starts ? '' : walked ? `People walked in ${walked} of ${starts} times, so it looks like a real seat.` : 'It appeared in place every time: nobody walked in.',
          st.stillGaps.length ? ` The radar lost them ${st.stillGaps.length}× while they sat still.` : ''),
        el('div', { class: 'q' }, 'What is here?'),
        el('div', { class: 'ans' },
          el('button', { class: ghost ? '' : 'rec', onclick: () => this._answer(i, 'spot', () => this._addSpot(i, name.value)) },
            glyphSvg('spot', kindTone('linger'), 16), 'A seat or bed: make it a spot', ghost ? '' : el('span', { class: 'tag' }, 'likely'), name),
          el('button', { class: ghost ? 'rec' : '', onclick: () => this._answer(i, 'ignore', () => this._addZone(i.radar.radar_id, { kind: 'exclude', name: 'Ignore (fan, plant)', polygon: offsetConvex(i.sp.hull, 150) || i.polygon })) },
            glyphSvg('ignore', kindTone('exclude'), 16), "Nobody: it's a fan, plant or curtain", ghost ? el('span', { class: 'tag' }, 'likely') : ''),
          el('button', { onclick: () => this._answer(i, 'nothing') }, el('span', { style: { width: '16px', textAlign: 'center' } }, '–'), 'Nothing special')),
        this._impactEl(i),
      ];
      if (peak) acts.push(show(i.radar.radar_id, peak));
    } else if (i.type === 'walked') {
      body = [
        el('h2', {}, glyphSvg('ignore', kindTone('exclude'), 18), `People walk through “${i.zone.name}”`),
        el('div', { class: 'why' }, `Trails walked into this ignore area ${i.walkIn} times in the last day and walked out again. If people really are there (not behind a wall or glass), it hides them.`),
        el('div', { class: 'ans' },
          el('button', { onclick: () => this._answer(i, 'removed', () => this._removeZone(i.radar.radar_id, i.zone.id)) }, 'Remove it'),
          el('button', { onclick: () => this._answer(i, 'keep') }, 'It is meant to be there (a reflection)')),
      ];
    } else if (i.type === 'door') {
      const name = this._entityName(i.door);
      body = [
        el('h2', {}, glyphSvg('door', kindTone('exit'), 18), `Is the ${name.toLowerCase()} in view of this radar?`),
        el('div', { class: 'why' }, `Someone was in view ${i.pos.hits} of the ${i.pos.events} times it opened or closed in the last day. As a doorway, it tells the count who came in and who left.`),
        el('div', { class: 'ans' },
          el('button', { class: 'rec', onclick: () => this._answer(i, 'doorway', () => this._addZone(i.radar.radar_id, { kind: 'exit', name, polygon: placeExit(i.pos.points), door_entity_id: i.door })) },
            glyphSvg('door', kindTone('exit'), 16), 'Yes: mark it as a doorway', el('span', { class: 'tag' }, 'likely')),
          el('button', { onclick: () => this._answer(i, 'no') }, 'No, it is somewhere else')),
      ];
    } else if (i.type === 'noradar' || i.type === 'nodoor') {
      body = [
        el('h2', {}, glyphSvg('room', kindTone('include'), 18), i.type === 'noradar' ? `${i.title} has no radar` : `How do people get into ${i.title.toLowerCase()}?`),
        el('div', { class: 'why' }, i.type === 'noradar'
          ? `Without a radar, ${i.title.toLowerCase()} is counted at its doorways: whoever goes in stays counted there until they come out.${i.linkedTo ? '' : ' None of its doorways is marked yet.'}`
          : `No doorway leads into ${i.title.toLowerCase()} yet, so people seen there can only appear from nowhere.`),
        el('div', { class: 'ans' },
          el('button', { class: 'rec', onclick: () => { this._answer(i, 'mark'); this.dispatchEvent(new CustomEvent('mark-doorway', { detail: { area: i.area } })); } }, glyphSvg('door', kindTone('exit'), 16), 'Mark its doorway (opens the editor)'),
          el('button', { onclick: () => this._answer(i, 'unused') }, i.type === 'noradar' ? 'Not a room people use' : 'People do not go there')),
      ];
    } else if (i.type === 'unlinked') {
      body = [
        el('h2', {}, `${i.title} is seen by ${i.radars.length} radars that aren't lined up`),
        el('div', { class: 'why' }, 'Lined up, they share their shapes and the same person seen by both counts once.'),
        el('div', { class: 'ans' },
          el('button', { class: 'rec', onclick: () => { this._answer(i, 'line-up'); this.dispatchEvent(new CustomEvent('line-up', { detail: { radar: i.radars[0].radar_id } })); } }, 'Line them up'),
          el('button', { onclick: () => { this.skipped.add(i.key); this.render(); } }, 'Later')),
      ];
    }
    return el('div', { class: 'card' }, ...body, acts.length ? el('div', { class: 'acts' }, ...acts) : '');
  }

  /** "If you'd had this spot last day": how often the room went clear with and without it (and remembering people). */
  _impactEl(i) {
    const room = i.room;
    if (i.cls.kind === 'ghost') return '';
    if (!room) return el('div', { class: 'impact' }, `It is outside the room shapes of this radar, so as a spot it keeps the head count steady while someone sits there but does not hold a room's lights.`);
    const box = el('div', { class: 'impact' }, 'Working out what this spot would have changed…');
    setTimeout(() => {
      try {
        const base = i.cfg.zones.filter(z => !validatePolygon(z.polygon)).map(z => ({ ...z, filters: z.filters || {} }));
        const withSpot = [...base.map(z => (z.id === room.id ? { ...z, filters: { ...z.filters, hold_until_exit: true, hold_max_s: z.filters.hold_max_s || suggestMaxHold(i.stats) } } : z)),
          { id: 'todo-spot', name: 'Spot', kind: 'linger', polygon: i.polygon, filters: {} }];
        const count = zones => summarize(replayGroup({ hist: i.hist, zones }, [], 0).transitions, [room.id], i.hist.start, i.hist.end)[room.id];
        const a = count(base), b = count(withSpot);
        const gone = a.intervals.length - b.intervals.length;
        box.replaceChildren(el('b', {}, '▶ The last day with this spot: '),
          gone > 0 ? `${room.name.toLowerCase()} would have gone clear ${gone} time${gone === 1 ? '' : 's'} less while someone sat still (occupied ${fmtDuration(b.occupied)} instead of ${fmtDuration(a.occupied)}).`
            : `${room.name.toLowerCase()} would have behaved the same: it did not lose anyone here.`);
      } catch (err) {
        box.replaceChildren(`(Could not replay: ${err.message})`);
      }
    }, 30);
    return box;
  }

  // ------------------------------------------------------------ changes

  async _answer(i, answer, change = null) {
    let undo = null;
    try {
      if (change) undo = await change();
      await this.hass.callWS({ type: `${DOMAIN}/todo/answer`, key: i.key, answer });
      this.answers[i.key] = { answer, t: Date.now() / 1000 };
    } catch (err) {
      this._toast(`Could not save: ${err.message || err.code}`);
      return;
    }
    this.render();
    this._emitCount();
    if (undo) this._toast('Saved.', async () => { await undo(); await this.hass.callWS({ type: `${DOMAIN}/todo/answer`, key: i.key, answer: null }); delete this.answers[i.key]; this.render(); this._emitCount(); });
  }

  /** Save a radar's zones as they are plus a change; returns an undo. */
  async _saveZones(radarId, edit) {
    const cfg = await this.hass.callWS({ type: `${DOMAIN}/config`, radar_id: radarId });
    const before = cfg.zones.map(z => ({ ...z }));
    const after = edit(cfg.zones.map(z => ({ ...z })));
    await this.hass.callWS({ type: `${DOMAIN}/zones/save`, radar_id: radarId, zones: after });
    return () => this.hass.callWS({ type: `${DOMAIN}/zones/save`, radar_id: radarId, zones: before });
  }

  _addZone(radarId, zone) {
    const z = { id: newZoneId(), filters: {}, area_id: null, ...zone, polygon: zone.polygon.map(p => [Math.round(p[0]), Math.round(p[1])]) };
    return this._saveZones(radarId, zones => [...zones, z]);
  }

  _removeZone(radarId, id) {
    return this._saveZones(radarId, zones => zones.filter(z => z.id !== id));
  }

  /** A spot keeps its room occupied while someone sits still: add it, and remember people who sit still in its room. */
  _addSpot(i, name) {
    const spot = { id: newZoneId(), kind: 'linger', name: (name || 'Spot').trim() || 'Spot', polygon: i.polygon.map(p => [Math.round(p[0]), Math.round(p[1])]), filters: {}, area_id: null };
    const maxHold = suggestMaxHold(i.stats);
    return this._saveZones(i.radar.radar_id, zones => [
      ...zones.map(z => (i.room && z.id === i.room.id && !z.filters?.hold_until_exit ? { ...z, filters: { ...(z.filters || {}), hold_until_exit: true, hold_max_s: maxHold } } : z)),
      spot,
    ]);
  }

  _toast(msg, undo = null) {
    this.shadowRoot.querySelector('.toast')?.remove();
    const t = el('div', { class: 'toast' }, msg, undo ? el('button', { onclick: () => { t.remove(); undo(); } }, 'Undo') : '');
    this.shadowRoot.append(t);
    setTimeout(() => t.remove(), 6000);
  }
}

void KIND_STYLE; void crossCheck; void fovPolygon;
customElements.get('rzp-todo') || customElements.define('rzp-todo', RzpTodo);
