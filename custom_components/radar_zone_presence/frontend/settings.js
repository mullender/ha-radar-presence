// <rzp-settings>: the home's settings (replaces the long options form). Each
// section says what the setting does in a sentence, lists what is chosen (with
// its room), and suggests likely entities inline. Changes save right away; the
// home reloads (a second or two).

import { el } from './util.js';

const DOMAIN = 'radar_zone_presence';

const css = `
:host { display: block; height: 100%; overflow: auto; background: var(--primary-background-color, #fafafa); color: var(--primary-text-color, #222); font-size: 14px; }
.wrap { max-width: 820px; margin: 0 auto; padding: 18px 20px 40px; display: flex; flex-direction: column; gap: 14px; }
.card { background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, #e0e0e0); border-radius: 12px; padding: 14px 18px; }
.card h2 { margin: 0 0 4px; font-size: 16px; font-weight: 500; }
.why { color: var(--secondary-text-color, #666); line-height: 1.45; margin-bottom: 10px; font-size: 13px; }
.row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.row + .row { border-top: 1px solid var(--divider-color, #eee); }
.row .name { flex: 1; min-width: 0; }
.row .name small { display: block; color: var(--secondary-text-color, #888); font-size: 12px; }
.row select { font: inherit; font-size: 12px; padding: 2px 4px; }
.x { border: 0; background: none; color: var(--secondary-text-color, #888); font-size: 16px; cursor: pointer; padding: 2px 6px; }
.x:hover { color: #c62828; }
.none { color: var(--secondary-text-color, #888); font-size: 13px; padding: 4px 0; }
.sugg { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: rgba(3, 169, 244, .05); border: 1px solid rgba(3, 169, 244, .15); }
.sugg .lbl { font-size: 12px; color: var(--secondary-text-color, #666); margin-bottom: 4px; }
.add { border: 1px solid var(--primary-color, #03a9f4); color: var(--primary-color, #03a9f4); background: none; border-radius: 14px; padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer; }
.picker { display: flex; gap: 8px; margin-top: 8px; }
.picker input { flex: 1; font: inherit; font-size: 13px; padding: 4px 8px; border: 1px solid var(--divider-color, #ccc); border-radius: 6px; background: var(--card-background-color, #fff); color: inherit; }
.more { border: 0; background: none; color: var(--primary-color, #03a9f4); font: inherit; font-size: 12px; cursor: pointer; padding: 4px 0; }
input.num { width: 70px; font: inherit; padding: 3px 6px; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #323232; color: #fff; padding: 10px 16px; border-radius: 6px; z-index: 30; }
`;

const SECTIONS = [
  {
    key: 'outside_doors', title: 'Outside doors',
    why: 'Doors, garage doors and locks to outside that no radar watches. Someone coming in through one is counted in its room. Doors on a radar doorway are already known.',
    domains: ['binary_sensor', 'cover', 'lock'],
  },
  {
    key: 'hints', title: 'Activity hints',
    why: 'Lights, switches and inner doors that mean someone is in that room when they are used by hand at the switch (not by an automation, the app, a remote or voice). They count people in rooms without a radar, and keep people who sit still counted. In a room with a radar they only count when it saw someone there just now.',
    domains: ['binary_sensor', 'switch', 'light', 'fan', 'event', 'input_boolean'],
  },
  {
    key: 'occupancy', title: 'Occupancy sensors',
    why: 'Sensors that stay on while someone is there, like a bed sensor. While one is on, at least one person is in its room. A bed’s two sides count as one sign.',
    domains: ['binary_sensor', 'input_boolean'],
  },
  {
    key: 'vacuums', title: 'Robot vacuums',
    why: 'A robot vacuum moves like a person to a radar. While one cleans, the count ignores the radars in the room it reports.',
    domains: ['vacuum'],
  },
];

export class RzpSettings extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>${css}</style><div class="wrap"></div>`;
    this.wrap = this.shadowRoot.querySelector('.wrap');
    this.settings = null;
    this.showAll = new Set();
    this.picking = null;
  }

  set hass(h) { this._hass = h; }
  get hass() { return this._hass; }

  async activate() {
    try {
      const [settings, list] = await Promise.all([
        this.hass.callWS({ type: `${DOMAIN}/settings` }),
        this.hass.callWS({ type: `${DOMAIN}/list` }),
      ]);
      this.settings = settings;
      this.radars = list.radars;
      const cfgs = await Promise.all(list.radars.map(r => this.hass.callWS({ type: `${DOMAIN}/config`, radar_id: r.radar_id }).catch(() => null)));
      this.doorwayDoors = new Set(cfgs.flatMap(c => (c?.zones || []).map(z => z.door_entity_id).filter(Boolean)));
      this.radarAreas = new Set(list.radars.map(r => r.area_id).filter(Boolean));
      this.radarDevices = new Set(list.radars.map(r => r.device_id));
    } catch (err) {
      this.wrap.replaceChildren(el('div', { class: 'card' }, `Could not load the settings: ${err.message || err.code}`));
      return;
    }
    this.render();
  }

  // ------------------------------------------------------------ entities

  _area(id) {
    const e = this.hass.entities?.[id];
    return e?.area_id || this.hass.devices?.[e?.device_id]?.area_id || null;
  }

  _areaName(a) { return a ? this.hass.areas?.[a]?.name || a : null; }

  _name(id) { return this.hass.states[id]?.attributes.friendly_name || id; }

  /** Not worth suggesting: our own entities, config/diagnostic entities, and the radars' own (the radar is already used). */
  _ours(id, sec) {
    const e = this.hass.entities?.[id];
    return e?.platform === DOMAIN || !!e?.entity_category || e?.hidden || (sec.key !== 'outside_doors' && this.radarDevices.has(e?.device_id));
  }

  /** Candidates for a section, best first, each with a reason. */
  _suggest(sec, chosen) {
    const st = Object.values(this.hass.states).filter(s => sec.domains.includes(s.entity_id.split('.')[0]) && !chosen.has(s.entity_id) && !this._ours(s.entity_id, sec));
    const dc = s => s.attributes.device_class;
    const noRadar = id => { const a = this._area(id); return a && !this.radarAreas.has(a); };
    const out = [];
    for (const s of st) {
      const id = s.entity_id, d = id.split('.')[0], name = this._name(id);
      let score = 0, why = '';
      if (sec.key === 'outside_doors') {
        if (this.doorwayDoors.has(id) || /closet|wardrobe|pantry|cabinet|cupboard|fridge|freezer|mailbox/i.test(name)) continue;
        if (d === 'cover' && dc(s) !== 'garage' && dc(s) !== 'door' && dc(s) !== 'gate') continue;
        if (d === 'binary_sensor' && !['door', 'garage_door', 'opening'].includes(dc(s))) continue;
        score = (d === 'lock' ? 1 : 2) + (/garage|front|back|patio|outside|entry/i.test(name) ? 2 : 0) + (noRadar(id) ? 2 : 0);
        why = noRadar(id) ? `No radar in the ${this._areaName(this._area(id)).toLowerCase()}` : d === 'lock' ? 'A lock' : 'A door';
      } else if (sec.key === 'hints') {
        if (d === 'binary_sensor' && !['door', 'opening'].includes(dc(s))) continue;
        if (!this._area(id) || this.doorwayDoors.has(id)) continue;
        score = (noRadar(id) ? 3 : 1) + (d === 'light' ? 1 : 0) + (/closet|wardrobe|pantry/i.test(name) ? 2 : 0);
        why = noRadar(id) ? `Counts the ${this._areaName(this._area(id)).toLowerCase()}, which has no radar` : `In the ${this._areaName(this._area(id)).toLowerCase()}`;
      } else if (sec.key === 'occupancy') {
        if (d === 'binary_sensor' && !['occupancy', 'presence'].includes(dc(s))) continue;
        if (d === 'input_boolean' && !/bed|sleep|seat|chair|couch/i.test(name)) continue;
        score = (/bed|sleep|seat|chair|couch|mattress/i.test(name) ? 4 : 1) + (this._area(id) ? 1 : 0);
        why = /bed|sleep|mattress/i.test(name) ? 'A bed sensor' : 'Stays on while someone is there';
      } else if (sec.key === 'vacuums') {
        score = 1;
        why = this._area(id) ? `In the ${this._areaName(this._area(id)).toLowerCase()}` : 'A robot vacuum';
      }
      out.push({ id, score, why });
    }
    return out.sort((a, b) => b.score - a.score || this._name(a.id).localeCompare(this._name(b.id)));
  }

  /** Chosen entity ids of a section ("hints" is two options: any change, or switched on only). */
  _chosen(key) {
    const s = this.settings;
    if (key === 'hints') return [...s.evidence.map(id => [id, 'any']), ...s.evidence_on.map(id => [id, 'on'])];
    return s[key].map(id => [id, null]);
  }

  // ------------------------------------------------------------ render

  render() {
    if (!this.settings) return;
    this.wrap.replaceChildren(...SECTIONS.map(sec => this._section(sec)), this._advanced());
  }

  _section(sec) {
    const chosen = this._chosen(sec.key);
    const ids = new Set(chosen.map(([id]) => id));
    const sugg = this._suggest(sec, ids);
    const n = this.showAll.has(sec.key) ? sugg.length : 4;
    const row = (id, extra, action) => el('div', { class: 'row' },
      el('div', { class: 'name' }, this._name(id), el('small', {}, [this._areaName(this._area(id)), extra].filter(Boolean).join(' · ') || id)), ...action);
    return el('div', { class: 'card' },
      el('h2', {}, sec.title),
      el('div', { class: 'why' }, sec.why),
      chosen.length ? chosen.map(([id, mode]) => row(id, this.hass.states[id] ? '' : 'not found', [
        sec.key !== 'hints' ? '' : el('select', { title: 'Which changes count', onchange: e => this._setMode(id, e.target.value) },
          el('option', { value: 'any', selected: mode === 'any' }, 'On or off'), el('option', { value: 'on', selected: mode === 'on' }, 'Switched on only')),
        el('button', { class: 'x', title: 'Remove', onclick: () => this._remove(sec.key, id) }, '✕'),
      ])) : el('div', { class: 'none' }, 'None yet.'),
      sugg.length ? el('div', { class: 'sugg' },
        el('div', { class: 'lbl' }, 'Suggestions'),
        sugg.slice(0, n).map(s => row(s.id, s.why, [el('button', { class: 'add', onclick: () => this._add(sec.key, s.id) }, '+ Add')])),
        sugg.length > n ? el('button', { class: 'more', onclick: () => { this.showAll.add(sec.key); this.render(); } }, `Show all ${sugg.length}`) : '') : '',
      this.picking === sec.key ? this._picker(sec, ids) : el('button', { class: 'more', onclick: () => { this.picking = sec.key; this.render(); this.shadowRoot.querySelector('.picker input')?.focus(); } }, '+ Add another…'));
  }

  _picker(sec, ids) {
    const listId = `pick-${sec.key}`;
    const options = Object.values(this.hass.states).filter(s => sec.domains.includes(s.entity_id.split('.')[0]) && !ids.has(s.entity_id))
      .map(s => el('option', { value: s.entity_id }, this._name(s.entity_id)));
    const input = el('input', { list: listId, placeholder: `Entity (${sec.domains.join(', ')})` });
    const add = () => { const id = input.value.trim(); if (this.hass.states[id] && sec.domains.includes(id.split('.')[0])) { this.picking = null; this._add(sec.key, id); } else input.setCustomValidity('Pick an entity from the list'), input.reportValidity(); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); if (e.key === 'Escape') { this.picking = null; this.render(); } });
    return el('div', { class: 'picker' }, input, el('datalist', { id: listId }, options),
      el('button', { class: 'add', onclick: add }, 'Add'), el('button', { class: 'x', title: 'Cancel', onclick: () => { this.picking = null; this.render(); } }, '✕'));
  }

  _advanced() {
    const v = this.settings.reconnect_grace_s;
    return el('div', { class: 'card' },
      el('h2', {}, 'Advanced'),
      el('div', { class: 'row' },
        el('div', { class: 'name' }, 'Ignore after reconnect', el('small', {}, 'Seconds to ignore a radar after it comes back from unavailable. Ghosts often appear right after a reconnect.')),
        el('input', { class: 'num', type: 'number', min: 0, max: 600, step: 1, value: v, onchange: e => this._save({ reconnect_grace_s: Math.max(0, Math.min(600, +e.target.value || 0)) }) }), 's'));
  }

  // ------------------------------------------------------------ changes

  _add(key, id) {
    const s = this.settings;
    if (key === 'hints') return this._save({ evidence: [...s.evidence, id] });
    return this._save({ [key]: [...s[key], id] });
  }

  _remove(key, id) {
    const s = this.settings;
    if (key === 'hints') return this._save({ evidence: s.evidence.filter(e => e !== id), evidence_on: s.evidence_on.filter(e => e !== id) });
    return this._save({ [key]: s[key].filter(e => e !== id) });
  }

  _setMode(id, mode) {
    const s = this.settings;
    const any = s.evidence.filter(e => e !== id), on = s.evidence_on.filter(e => e !== id);
    return this._save(mode === 'on' ? { evidence: any, evidence_on: [...on, id] } : { evidence: [...any, id], evidence_on: on });
  }

  async _save(changes) {
    const before = this.settings;
    this.settings = { ...before, ...changes };
    this.render();
    try {
      await this.hass.callWS({ type: `${DOMAIN}/settings/save`, ...changes });
      this._toast('Saved. Presence restarts with the new settings.');
    } catch (err) {
      this.settings = before;
      this.render();
      this._toast(`Could not save: ${err.message || err.code}`);
    }
  }

  _toast(msg) {
    this.shadowRoot.querySelector('.toast')?.remove();
    const t = el('div', { class: 'toast' }, msg);
    this.shadowRoot.append(t);
    setTimeout(() => t.remove(), 4000);
  }
}

customElements.get('rzp-settings') || customElements.define('rzp-settings', RzpSettings);
