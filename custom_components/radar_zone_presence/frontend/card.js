// Lovelace card: live view of one radar with its zones and targets.
//
//   type: custom:radar-zone-presence-card
//   radar_id: <radar id>          # picked in the card editor
//   title: Living room            # optional
//   height: 320                   # optional, px
//   trail: 10                     # optional, seconds of live trail

import './plot.js';
import './headcount-card.js';
import { makeUnits, normalizeDisplay } from './util.js';

const DOMAIN = 'radar_zone_presence';

class RadarZonePresenceCard extends HTMLElement {
  setConfig(config) {
    this._config = { height: 320, trail: 10, ...config };
    this._built = false;
    if (this._hass) this._init();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first && this._config) this._init();
  }

  getCardSize() { return Math.ceil((this._config?.height || 320) / 50) + 1; }

  static getConfigElement() { return document.createElement('radar-zone-presence-card-editor'); }

  static async getStubConfig(hass) {
    try {
      const res = await hass.callWS({ type: `${DOMAIN}/list` });
      return { radar_id: res.radars[0]?.radar_id || '' };
    } catch {
      return { radar_id: '' };
    }
  }

  disconnectedCallback() { this._unsub?.then(u => u()).catch(() => {}); this._unsub = null; this._built = false; }
  connectedCallback() { if (this._hass && this._config && !this._built) this._init(); }

  async _init() {
    if (this._built || !this.isConnected) return;
    this._built = true;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const c = this._config;
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { overflow: hidden; }
        .head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px 4px; }
        .title { font-size: 16px; font-weight: 500; }
        a { color: var(--primary-color); font-size: 13px; text-decoration: none; }
        rzp-plot { display: block; height: ${Number(c.height) || 320}px; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px 12px; }
        .chip { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: var(--secondary-background-color, #eee); }
        .chip.on { background: #43a047; color: #fff; }
        .err { padding: 16px; color: var(--error-color, #c00); }
      </style>
      <ha-card><div class="head"><span class="title"></span><a href="/radar-zones#radar=${c.radar_id}">Edit zones</a></div>
      <rzp-plot></rzp-plot><div class="chips"></div></ha-card>`;
    if (!c.radar_id) { this.shadowRoot.querySelector('ha-card').innerHTML = '<div class="err">Pick a radar in the card editor.</div>'; return; }
    this.plot = this.shadowRoot.querySelector('rzp-plot');
    try {
      this.cfg = await this._hass.callWS({ type: `${DOMAIN}/config`, radar_id: c.radar_id });
    } catch (err) {
      this.shadowRoot.querySelector('ha-card').innerHTML = `<div class="err">Radar unavailable: ${err.message || err.code}</div>`;
      return;
    }
    this.shadowRoot.querySelector('.title').textContent = c.title || this.cfg.title;
    this.trails = new Map();
    this.plot.set({
      readonly: true,
      units: makeUnits(this.cfg.target_unit, this._hass),
      fov: this.cfg.fov,
      deviceZones: [],
      zones: this.cfg.zones,
      display: normalizeDisplay(this.cfg.settings.display || {}, { upsideDown: this.cfg.device_mounting?.upside_down }),
      showMeasurements: false,
      trailSeconds: Number(c.trail) || 10,
    });
    this.plot.fit();
    this._renderChips({});
    this._unsub = this._hass.connection.subscribeMessage(ev => this._onFrame(ev), { type: `${DOMAIN}/frames/subscribe`, radar_id: c.radar_id });
  }

  _onFrame(ev) {
    if (ev.closed) { this._built = false; setTimeout(() => this._init(), 1000); return; }
    const trail = Number(this._config.trail) || 10;
    for (const [slot, x, y] of ev.targets) {
      if (!this.trails.has(slot)) this.trails.set(slot, []);
      this.trails.get(slot).push({ x, y, t: ev.t });
    }
    for (const [slot, pts] of this.trails) {
      while (pts.length && pts[0].t < ev.t - trail) pts.shift();
      if (!pts.length) this.trails.delete(slot);
    }
    const states = Object.fromEntries(Object.entries(ev.zones).map(([k, v]) => [k, v[0]]));
    this.plot.set({ targets: ev.targets, trails: this.trails, zoneStates: states });
    this._renderChips(states);
  }

  _renderChips(states) {
    const box = this.shadowRoot.querySelector('.chips');
    box.replaceChildren(...this.cfg.zones.filter(z => (z.kind || 'include') === 'include').map(z => {
      const chip = document.createElement('span');
      chip.className = `chip${states[z.id] ? ' on' : ''}`;
      chip.textContent = z.name;
      return chip;
    }));
  }
}

class RadarZonePresenceCardEditor extends HTMLElement {
  setConfig(config) { this._config = config; this._render(); }
  set hass(hass) { const first = !this._hass; this._hass = hass; if (first) this._load(); }

  async _load() {
    try { this._radars = (await this._hass.callWS({ type: `${DOMAIN}/list` })).radars; } catch { this._radars = []; }
    this._render();
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const r = this._radars || [];
    this.shadowRoot.innerHTML = `
      <style>label { display: block; margin: 8px 0 4px; font-size: 13px; } select, input { width: 100%; padding: 6px; box-sizing: border-box; }</style>
      <label>Radar</label>
      <select id="entry">${r.map(x => `<option value="${x.radar_id}" ${x.radar_id === this._config.radar_id ? 'selected' : ''}>${x.title}${x.area ? ` · ${x.area}` : ''}</option>`).join('')}</select>
      <label>Title (optional)</label><input id="title" value="${this._config.title || ''}">
      <label>Height (px)</label><input id="height" type="number" value="${this._config.height || 320}">
      <label>Trail (s)</label><input id="trail" type="number" value="${this._config.trail || 10}">`;
    for (const id of ['entry', 'title', 'height', 'trail']) {
      this.shadowRoot.getElementById(id).addEventListener('change', e => {
        const key = id === 'entry' ? 'radar_id' : id;
        const value = id === 'height' || id === 'trail' ? Number(e.target.value) : e.target.value;
        this._config = { ...this._config, [key]: value };
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
      });
    }
  }
}

customElements.get('radar-zone-presence-card') || customElements.define('radar-zone-presence-card', RadarZonePresenceCard);
customElements.get('radar-zone-presence-card-editor') || customElements.define('radar-zone-presence-card-editor', RadarZonePresenceCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === 'radar-zone-presence-card')) {
  window.customCards.push({
    type: 'radar-zone-presence-card',
    name: 'Radar Zone Presence',
    description: 'Live radar targets and presence zones',
    preview: false,
  });
}
