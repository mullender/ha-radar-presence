// <rzp-todo>: the To do tab. One question at a time, grouped by room, with
// progress. Each answer makes exactly one change, saved right away (with Undo),
// and is remembered on the server so another browser does not ask again.
//
// Questions come from the last day of every radar's history (places where
// something stays, ignore areas people walk through, door sensors that line up
// with a radar) and from the home's layout (rooms nobody can get into, rooms
// without a radar, radars in one room that are not lined up).

import { pointInPolygon, summarize, validatePolygon } from './engine.js';
import { replayGroup } from './tracker.js';
import { appearVanishSpots, classify, doorEvents, doorPositions, findDwellSpots, offsetConvex, placeExit, spotTimes, suggestHold, suggestMaxHold, trailStats } from './analysis.js';
import { KIND_STYLE, SVGNS, el, fmtDuration, fmtTime, glyphSvg, kindTone, newZoneId } from './util.js';

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
.cols { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 16px; align-items: start; }
.ev { width: 150px; height: 150px; border-radius: 10px; background: var(--secondary-background-color, #f3f4f6); color: var(--primary-text-color, #222); }
@media (max-width: 560px) { .wrap { padding: 12px 10px 30px; } .cols { grid-template-columns: minmax(0, 1fr); } .ev { width: 100%; height: auto; max-width: 240px; } }
.ans { display: flex; flex-direction: column; gap: 8px; }
.ans button { display: flex; align-items: center; gap: 10px; text-align: left; font: inherit; padding: 10px 12px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--divider-color, #ddd); background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); }
.ans button:hover { border-color: var(--primary-color, #03a9f4); }
.ans button.rec { border-color: #0d9488; }
.ans button .tag { font-size: 11px; color: #0d9488; border: 1px solid #0d9488; border-radius: 8px; padding: 0 6px; }
.picks { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 10px; }
.picks small { color: var(--secondary-text-color, #888); }
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
    if (this.items && !rebuild) {
      try { this.answers = (await this.hass.callWS({ type: `${DOMAIN}/todo/answers` })).answers; } catch { /* keep what we had */ }
      this.render();
      this._emitCount();
      return;
    }
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
    items.push(...await this._hintQuestions(range));
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
    // Rooms: short blips that turn them on, and people who sit still and are lost.
    if (rooms.length) {
      const base = this._replay(hist, valid, rooms.map(z => z.id));
      const names = rooms.map(z => this._zoneName(z, r));
      for (const [k, z] of rooms.entries()) {
        const name = names.filter(n => n === names[k]).length > 1 && names[k] !== z.name ? `${names[k]} (${z.name})` : names[k];
        const blips = base[z.id].intervals.filter(([a, b]) => b - a < 3).length;
        if (blips >= 5 && !(z.filters?.on_delay_s > 0)) out.push({ key: `${r.radar_id}:blips:${z.id}`, type: 'blips', radar: r, cfg, hist, zone: z, name, blips, turnedOn: base[z.id].intervals.length });
        const st = trailStats(hist, z.polygon, { exclusions });
        if (!z.filters?.hold_until_exit && suggestHold(st)) out.push({ key: `${r.radar_id}:hold:${z.id}`, type: 'hold', radar: r, cfg, hist, zone: z, name, stats: st, clear: base[z.id].intervals.length });
      }
    }
    // Places where people appear and vanish (walking): a doorway not marked yet, or the edge of the view.
    const skip = valid.filter(z => ['exit', 'linger', 'transient'].includes(z.kind) || z.spot).map(z => z.polygon);
    for (const c of appearVanishSpots(hist, { exclusions, skip })) {
      const polygon = placeExit(c.points);
      if (!polygon) continue;
      const [cx, cy] = c.centroid;
      const times = spotTimes(hist, polygon, { exclusions });
      out.push({ key: `${r.radar_id}:appear:${Math.round(cx / 300)},${Math.round(cy / 300)}`, type: 'appear', radar: r, cfg, hist, c, polygon,
        peak: times?.peak != null ? hist.start + times.peak : null, room: rooms.find(z => pointInPolygon(cx, cy, z.polygon)) });
    }
    // Ignore areas people walk through.
    for (const z of exclusions) {
      const st = trailStats(hist, z.polygon, { exclusions: exclusions.filter(q => q !== z) });
      if (st.walkIn >= 10 && st.walkOut >= st.walkIn / 2) out.push({ key: `${r.radar_id}:walked:${z.id}`, type: 'walked', radar: r, cfg, hist, zone: z, walkIn: st.walkIn });
    }
    // Door sensors that line up with this radar and are not a doorway yet.
    const linked = new Set(valid.filter(z => z.kind === 'exit').map(z => z.door_entity_id).filter(Boolean));
    for (const [id, rows] of Object.entries(doorRows)) {
      if (linked.has(id) || rows.length < 4) continue;
      const pos = doorPositions(hist, doorEvents(rows), { exclusions });
      if (!pos.events || pos.hits / pos.events < 0.5 || pos.events < 3 || !pos.points.length) continue;
      out.push({ key: `${r.radar_id}:door:${id}`, type: 'door', radar: r, cfg, hist, door: id, pos });
    }
    return out;
  }

  /** Replay a radar's day with these zones: {zoneId: {intervals, occupied}} for `ids`. */
  _replay(hist, zones, ids) {
    const zs = zones.map(z => ({ ...z, filters: z.filters || {} }));
    return summarize(replayGroup({ hist, zones: zs }, [], 0).transitions, ids, hist.start, hist.end);
  }

  /** A room's name: its area's when the shape still has a default name ("Polygon 1"). */
  _zoneName(z, r = null) {
    const area = this.hass.areas?.[z.area_id]?.name || r?.area;
    return area && /^(polygon|zone|room)\b/i.test(z.name) ? area : z.name;
  }

  /** Change one zone's filters; returns an undo. */
  _setFilters(radarId, zoneId, filters) {
    return this._saveZones(radarId, zones => zones.map(z => (z.id === zoneId ? { ...z, filters: { ...(z.filters || {}), ...filters } } : z)));
  }

  /** An impact line worked out after the card is shown (replays take a moment). */
  _later(fn) {
    const box = el('div', { class: 'impact' }, 'Replaying the last day…');
    setTimeout(() => { try { box.replaceChildren(...fn()); } catch (err) { box.replaceChildren(`(Could not replay: ${err.message})`); } }, 30);
    return box;
  }

  /** Lights and switches used by hand (no app, automation or script behind the change) that aren't hints yet. */
  async _hintQuestions(range) {
    const hass = this.hass;
    const settings = await hass.callWS({ type: `${DOMAIN}/settings` }).catch(() => null);
    if (!settings) return [];
    const used = new Set([...settings.evidence, ...settings.evidence_on]);
    const areaOf = id => { const e = hass.entities?.[id]; return e?.area_id || hass.devices?.[e?.device_id]?.area_id || null; };
    const ids = Object.keys(hass.states).filter(id => /^(light|switch)\./.test(id) && !used.has(id) && areaOf(id)
      && !hass.entities?.[id]?.entity_category && !hass.entities?.[id]?.hidden && hass.entities?.[id]?.platform !== DOMAIN);
    if (!ids.length) return [];
    const events = await hass.callWS({ type: 'logbook/get_events', start_time: range.start, end_time: range.end, entity_ids: ids }).catch(() => []);
    const byHand = new Map();
    for (const e of events) {
      if (!e.entity_id || !['on', 'off'].includes(e.state)) continue;
      if (e.context_user_id || e.context_event_type || e.context_domain || e.context_service) continue;
      byHand.set(e.entity_id, (byHand.get(e.entity_id) || 0) + 1);
    }
    const picks = [...byHand].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, n]) => ({ id, n, area: areaOf(id) }));
    if (!picks.length) return [];
    return [{ key: `hints:${picks.map(p => p.id).sort().join(',')}`, type: 'hints', title: 'House', picks, settings }];
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
    return { hints: 'Switches as hints?', appear: 'A doorway?', blips: `Short blips in the ${i.name?.toLowerCase()}`, hold: `People sit still in the ${i.name?.toLowerCase()}`, spot: i.cls?.kind === 'ghost' ? 'Something still?' : 'A place people stay?', walked: 'An ignore area people walk through', door: 'A doorway?', noradar: `${i.title}`, nodoor: `${i.title}`, unlinked: `${i.title}: two radars` }[i.type];
  }

  _hint(i) {
    if (i.type === 'spot') return `${fmtDuration(i.sp.dwell)} in the last day, ${this._room(i.radar)}.`;
    if (i.type === 'hints') return `${i.picks.length} switched by hand in the last day.`;
    if (i.type === 'appear') return `People appear and vanish here ${i.c.births + i.c.deaths}× a day.`;
    if (i.type === 'blips') return `Turned on for under 3 s ${i.blips}× in a day.`;
    if (i.type === 'hold') return 'Goes clear while someone sits still.';
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
    } else if (i.type === 'blips') {
      const room = i.name.toLowerCase();
      body = [
        el('h2', {}, glyphSvg('room', kindTone('include'), 18), `Short blips turn the ${room} on`),
        el('div', { class: 'why' }, `It turned on for less than 3 seconds ${i.blips} times in the last day (of ${i.turnedOn}). That is usually a ghost at the edge of the view or someone passing a corner, and it is the usual answer to “why did the light turn on?”.`),
        el('div', { class: 'ans' },
          el('button', { class: 'rec', onclick: () => this._answer(i, 'on-delay', () => this._setFilters(i.radar.radar_id, i.zone.id, { on_delay_s: 2 })) }, 'Turn on after 2 s', el('span', { class: 'tag' }, 'likely')),
          el('button', { onclick: () => this._answer(i, 'leave') }, 'Leave it')),
        this._later(() => {
          const zones = i.cfg.zones.filter(z => !validatePolygon(z.polygon)).map(z => (z.id === i.zone.id ? { ...z, filters: { ...(z.filters || {}), on_delay_s: 2 } } : z));
          const n = this._replay(i.hist, zones, [i.zone.id])[i.zone.id].intervals.length;
          return [el('b', {}, '▶ The last day with 2 s: '), `the ${room} would have turned on ${n} times instead of ${i.turnedOn}. Real arrivals turn it on 2 s later.`];
        }),
      ];
    } else if (i.type === 'hold') {
      const room = i.name.toLowerCase(), st = i.stats, visits = st.walkIn + st.appearIn;
      const maxHold = suggestMaxHold(st);
      body = [
        el('h2', {}, glyphSvg('room', kindTone('include'), 18), `People sit still in the ${room} and it goes clear`),
        el('div', { class: 'why' }, `Someone vanished inside ${st.vanishIn} of ${visits} times in the last day and was seen again inside ${st.reappearIn} times: the radar lost them while they sat still.`),
        el('div', { class: 'ans' },
          el('button', { class: 'rec', onclick: () => this._answer(i, 'hold', () => this._setFilters(i.radar.radar_id, i.zone.id, { hold_until_exit: true, hold_max_s: maxHold })) },
            `Remember people who sit still (up to ${Math.round(maxHold / 60)} min)`, el('span', { class: 'tag' }, 'likely')),
          el('button', { onclick: () => this._answer(i, 'leave') }, 'Leave it')),
        this._later(() => {
          const zones = i.cfg.zones.filter(z => !validatePolygon(z.polygon)).map(z => (z.id === i.zone.id ? { ...z, filters: { ...(z.filters || {}), hold_until_exit: true, hold_max_s: maxHold } } : z));
          const n = this._replay(i.hist, zones, [i.zone.id])[i.zone.id].intervals.length;
          return [el('b', {}, '▶ The last day remembering them: '), n < i.clear ? `the ${room} would have gone clear ${i.clear - n} time${i.clear - n === 1 ? '' : 's'} less.` : `the ${room} would have gone clear just as often.`];
        }),
      ];
    } else if (i.type === 'appear') {
      const where = i.room ? this._zoneName(i.room, i.radar).toLowerCase() : this._room(i.radar).toLowerCase();
      const own = i.radar.area_id;
      const areas = Object.values(this.hass.areas || {}).filter(a => a.area_id !== own).sort((a, b) => a.name.localeCompare(b.name));
      const to = el('select', { onclick: e => e.stopPropagation(), title: 'Where it leads' },
        el('option', { value: '' }, 'somewhere (pick later)'), el('option', { value: 'outside' }, 'Outside'), areas.map(a => el('option', { value: a.area_id }, a.name)));
      body = [
        el('h2', {}, glyphSvg('door', kindTone('exit'), 18), `People appear and vanish here`),
        el('div', { class: 'why' }, `In the last day ${i.c.births} walks began here and ${i.c.deaths} ended here, in the ${where}. That is what a doorway looks like, or the edge of what the radar sees.`),
        el('div', { class: 'ans' },
          el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            el('button', { class: 'rec', style: { flex: 1 }, onclick: () => this._answer(i, 'doorway', () => this._addZone(i.radar.radar_id, { kind: 'exit', name: to.value ? `To ${to.selectedOptions[0].textContent.toLowerCase()}` : 'Doorway', polygon: i.polygon, leads_to: to.value ? [to.value] : [] })) },
              glyphSvg('door', kindTone('exit'), 16), 'A doorway, to', el('span', { class: 'tag' }, 'likely')), to),
          el('button', { onclick: () => this._answer(i, 'nothing') }, 'Nothing: the edge of the view')),
      ];
      if (i.peak) acts.push(show(i.radar.radar_id, i.peak));
    } else if (i.type === 'hints') {
      const on = new Set(i.picks.map(p => p.id));
      const total = i.picks.reduce((s, p) => s + p.n, 0);
      const areas = [...new Set(i.picks.map(p => this.hass.areas?.[p.area]?.name).filter(Boolean))];
      const save = ids => () => this._saveHints(i, ids);
      body = [
        el('h2', {}, i.picks.length === 1 ? 'Use this switch as a hint?' : `Use these ${i.picks.length} switches as hints?`),
        el('div', { class: 'why' }, `${areas.length ? areas.join(', ') : 'They'}: switched by hand ${total} times in the last day. Someone switching a light by hand is in that room, which keeps people who sit still counted and counts rooms without a radar.`),
        el('div', { class: 'picks' }, i.picks.map(pk => el('label', {},
          el('input', { type: 'checkbox', checked: true, onchange: e => { if (e.target.checked) on.add(pk.id); else on.delete(pk.id); } }),
          ` ${this.hass.states[pk.id]?.attributes.friendly_name || pk.id}`, el('small', {}, ` · ${pk.n}× by hand`)))),
        el('div', { class: 'ans' },
          el('button', { class: 'rec', onclick: () => this._answer(i, 'hints', save([...on])) }, 'Use the ticked ones', el('span', { class: 'tag' }, 'likely')),
          el('button', { onclick: () => this._answer(i, 'no') }, 'No')),
      ];
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
    const main = [...body, acts.length ? el('div', { class: 'acts' }, ...acts) : ''];
    const ev = this._evidence(i);
    return el('div', { class: 'card' }, ev ? el('div', { class: 'cols' }, ev, el('div', {}, ...main)) : main);
  }

  /** What the card is about, as a cropped map: the last day's detections around it and the shapes involved. */
  _evidence(i) {
    const shapes = {
      spot: () => [[i.polygon, i.cls?.kind === 'ghost' ? 'exclude' : 'linger', true], i.room && [i.room.polygon, 'include']],
      appear: () => [[i.polygon, 'exit', true], i.room && [i.room.polygon, 'include']],
      door: () => [[placeExit(i.pos.points), 'exit', true]],
      walked: () => [[i.zone.polygon, 'exclude', true]],
      blips: () => [[i.zone.polygon, 'include', true]],
      hold: () => [[i.zone.polygon, 'include', true]],
    }[i.type]?.().filter(s => s && s[0]);
    const hist = i.hist || this._hist?.get(i.radar?.radar_id);
    if (!shapes?.length || !hist) return null;
    const d = i.cfg?.settings?.display || {};
    const r = ((d.rotation || 0) * Math.PI) / 180, m = d.mirror ? -1 : 1;
    const tf = ([x, y]) => [Math.cos(r) * m * x - Math.sin(r) * y, Math.sin(r) * m * x + Math.cos(r) * y]; // as the radar view draws it
    const focus = shapes.find(s => s[2])[0].map(tf);
    const xs = focus.map(p => p[0]), ys = focus.map(p => p[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1000) + 2400;
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const S = 150, k = S / span;
    const sx = ([x, y]) => [S / 2 + (x - cx) * k, S / 2 - (y - cy) * k];
    const g = document.createElementNS(SVGNS, 'svg');
    g.setAttribute('viewBox', `0 0 ${S} ${S}`);
    g.setAttribute('class', 'ev');
    const add = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const [a, v] of Object.entries(attrs)) n.setAttribute(a, v); g.append(n); return n; };
    for (const [poly, kind, main] of shapes.filter(s => !s[2]).concat(shapes.filter(s => s[2]))) {
      const st = KIND_STYLE[kind];
      add('polygon', { points: poly.map(p => sx(tf(p)).join(',')).join(' '), fill: st.light, 'fill-opacity': main ? st.fill * 1.6 : st.fill, stroke: st.light, 'stroke-width': main ? 1.5 : 0.8, 'stroke-opacity': main ? 0.9 : 0.4 });
    }
    const n = hist.x.length, stride = Math.max(1, Math.floor(n / 20000));
    let shown = 0;
    for (let p = 0; p < n && shown < 1500; p += stride) {
      const [x, y] = sx(tf([hist.x[p], hist.y[p]]));
      if (x < 0 || y < 0 || x > S || y > S) continue;
      add('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 0.9, fill: 'currentColor', 'fill-opacity': 0.35 });
      shown++;
    }
    const [rx, ry] = sx([0, 0]);
    if (rx >= 0 && ry >= 0 && rx <= S && ry <= S) add('circle', { cx: rx, cy: ry, r: 3, fill: 'currentColor' });
    const scale = 1000 * k;
    add('line', { x1: 8, y1: S - 8, x2: 8 + scale, y2: S - 8, stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-opacity': 0.6 });
    return g;
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

  /** Add activity hints (Settings); returns an undo. */
  async _saveHints(i, ids) {
    const before = await this.hass.callWS({ type: `${DOMAIN}/settings` });
    await this.hass.callWS({ type: `${DOMAIN}/settings/save`, evidence: [...new Set([...before.evidence, ...ids])] });
    return () => this.hass.callWS({ type: `${DOMAIN}/settings/save`, evidence: before.evidence });
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

customElements.get('rzp-todo') || customElements.define('rzp-todo', RzpTodo);
