// Lovelace card: the head count as a nested list (home, floors, rooms with
// people), with + / − on every line to correct it.
//
//   type: custom:radar-zone-presence-headcount-card
//   title: Occupants         # optional
//   show_empty_rooms: false  # optional: list rooms with nobody in them too
//
// + on a room adds a person there; + on a floor (or home) asks which room.
// − on a room removes one; − on a floor removes from its only occupied room,
// or asks which; − on home removes whoever has gone unseen longest.

const DOMAIN = 'radar_zone_presence';

const css = `
ha-card { padding: 8px 0 10px; }
.title { font-size: 18px; font-weight: 500; padding: 6px 16px 4px; }
.line { display: grid; grid-template-columns: 1fr auto auto auto; align-items: center; gap: 6px; padding: 4px 12px 4px calc(16px + var(--indent, 0px)); min-height: 36px; }
.line.home { font-size: 17px; font-weight: 500; }
.line.floor { font-weight: 500; }
.line.room { color: var(--secondary-text-color); }
.line.room .name { color: var(--primary-text-color); }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.n { min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; font-size: 16px; }
.n.doubt { color: var(--warning-color, #f9a825); }
button.pm { width: 30px; height: 30px; border-radius: 15px; border: 1px solid var(--divider-color, #ccc); background: none; color: var(--primary-text-color);
  font-size: 17px; line-height: 1; cursor: pointer; padding: 0; }
button.pm:hover { border-color: var(--primary-color); color: var(--primary-color); }
button.pm:disabled { opacity: .3; cursor: default; }
.pick { margin: 2px 12px 6px calc(16px + var(--indent, 0px)); padding: 8px 10px; border-radius: 10px; background: var(--secondary-background-color, #f3f3f3); }
.pick .q { font-size: 13px; color: var(--secondary-text-color); margin-bottom: 6px; display: flex; }
.pick .q a { margin-left: auto; cursor: pointer; color: var(--primary-color); }
.pick .opts { display: flex; flex-wrap: wrap; gap: 6px; }
.pick .grp { font-size: 12px; color: var(--secondary-text-color); width: 100%; margin-top: 4px; }
.pick button { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 14px; border: 1px solid var(--divider-color, #ccc);
  background: var(--card-background-color, #fff); color: var(--primary-text-color); cursor: pointer; }
.pick button:hover { border-color: var(--primary-color); }
.note { font-size: 12px; color: var(--secondary-text-color); padding: 2px 16px 0; }
.err { color: var(--error-color, #db4437); padding: 8px 16px; font-size: 13px; }
`;

class RadarZonePresenceHeadcountCard extends HTMLElement {
  setConfig(config) {
    this._config = { show_empty_rooms: false, ...config };
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
  }

  getCardSize() { return 4; }

  static getStubConfig() { return { title: 'People' }; }

  connectedCallback() { if (this._hass && !this._unsub) this._load(); }

  disconnectedCallback() {
    this._unsub?.then(u => u()).catch(() => {});
    this._unsub = null;
  }

  async _load() {
    try {
      const h = await this._hass.callWS({ type: `${DOMAIN}/headcount/history`, start: Date.now() / 1000 });
      this._floorNames = Object.fromEntries((h.floors || []).map(f => [f.level, f.name]));
      await this._refresh();
      if (!this._unsub) {
        this._unsub = this._hass.connection.subscribeMessage(msg => {
          if (msg.closed) { setTimeout(() => this._load(), 3000); return; }
          if (msg.log?.some(e => e.kind !== 'seen')) this._refresh();
        }, { type: `${DOMAIN}/headcount/subscribe` });
        this._unsub.catch(() => { this._unsub = null; });
      }
    } catch (err) {
      this._error = err.message || err.code || String(err);
      this._render();
    }
  }

  async _refresh() {
    const d = await this._hass.callWS({ type: `${DOMAIN}/headcount` });
    const unknown = new Set(d.unknown_floors || []);
    const floors = new Map();
    for (const sp of d.spaces) {
      if (sp.id !== sp.area_id) continue; // an area seen by several radar groups: its own line counts them all
      if (!floors.has(sp.level)) floors.set(sp.level, { level: sp.level, name: this._floorNames?.[sp.level] || `Floor ${sp.level}`, rooms: [], doubt: unknown.has(sp.level) });
      floors.get(sp.level).rooms.push({ id: sp.id, name: sp.name, n: sp.count ?? 0 });
    }
    const inDoubt = d.tokens.filter(t => t.unknown).length;
    this._model = { home: d.known, homeDoubt: d.home === null, inDoubt, floors: [...floors.values()].sort((a, b) => a.level - b.level) };
    this._error = null;
    this._render();
  }

  async _correct(space, count) {
    try {
      await this._hass.callWS({ type: `${DOMAIN}/headcount/correct`, ...(space ? { space } : {}), count });
      this._pick = null;
      await this._refresh();
    } catch (err) {
      this._error = `Could not correct: ${err.message || err.code}`;
      this._render();
    }
  }

  _floorMinus(f) {
    const occupied = f.rooms.filter(r => r.n > 0);
    if (occupied.length === 1) this._correct(occupied[0].id, occupied[0].n - 1);
    else { this._pick = { kind: 'minus', level: f.level }; this._render(); }
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const root = this.shadowRoot;
    root.innerHTML = `<style>${css}</style>`;
    const card = document.createElement('ha-card');
    root.append(card);
    if (this._config.title) card.append(this._el('div', 'title', this._config.title));
    if (this._error) card.append(this._el('div', 'err', this._error));
    const m = this._model;
    if (!m) { card.append(this._el('div', 'note', 'Loading…')); return; }

    const line = (cls, indent, name, n, doubt, onMinus, onPlus, minusDisabled) => {
      const row = this._el('div', `line ${cls}`);
      row.style.setProperty('--indent', `${indent}px`);
      row.append(this._el('span', 'name', name), this._el('span', `n${doubt ? ' doubt' : ''}`, doubt ? `≥${n}` : String(n)));
      const minus = this._el('button', 'pm', '−');
      minus.title = 'One person fewer';
      minus.disabled = minusDisabled;
      minus.onclick = onMinus;
      const plus = this._el('button', 'pm', '+');
      plus.title = 'One person more';
      plus.onclick = onPlus;
      row.append(minus, plus);
      return row;
    };

    card.append(line('home', 0, 'Home', m.home, m.homeDoubt, () => this._correct(null, m.home - 1),
      () => { this._pick = this._pick?.kind === 'plus' && this._pick.level === null ? null : { kind: 'plus', level: null }; this._render(); }, !m.home));
    if (this._pick?.level === null) card.append(this._picker(m.floors, 16));
    for (const f of m.floors) {
      const fn = f.rooms.reduce((a, r) => a + r.n, 0);
      card.append(line('floor', 16, f.name, fn, f.doubt, () => this._floorMinus(f),
        () => { this._pick = this._pick?.kind === 'plus' && this._pick.level === f.level ? null : { kind: 'plus', level: f.level }; this._render(); }, !fn));
      if (this._pick && this._pick.level === f.level) card.append(this._picker([f], 32));
      for (const r of f.rooms) {
        if (!r.n && !this._config.show_empty_rooms) continue;
        card.append(line('room', 32, r.name, r.n, false, () => this._correct(r.id, r.n - 1), () => this._correct(r.id, r.n + 1), !r.n));
      }
    }
    if (m.inDoubt) card.append(this._el('div', 'note', `Settling: ${m.inDoubt} may have left while a door to outside was in use.`));
  }

  /** "Which room?" for + (all rooms of these floors) or − (occupied rooms of the floor). */
  _picker(floors, indent) {
    const minus = this._pick.kind === 'minus';
    const box = this._el('div', 'pick');
    box.style.setProperty('--indent', `${indent}px`);
    const q = this._el('div', 'q', minus ? 'Remove from which room?' : 'Add to which room?');
    const cancel = this._el('a', '', 'Cancel');
    cancel.onclick = () => { this._pick = null; this._render(); };
    q.append(cancel);
    const opts = this._el('div', 'opts');
    for (const f of floors) {
      const rooms = f.rooms.filter(r => !minus || r.n > 0);
      if (floors.length > 1 && rooms.length) opts.append(this._el('div', 'grp', f.name));
      for (const r of rooms) {
        const b = this._el('button', '', r.name);
        b.onclick = () => this._correct(r.id, r.n + (minus ? -1 : 1));
        opts.append(b);
      }
    }
    box.append(q, opts);
    return box;
  }

  _el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
}

customElements.get('radar-zone-presence-headcount-card') || customElements.define('radar-zone-presence-headcount-card', RadarZonePresenceHeadcountCard);
window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === 'radar-zone-presence-headcount-card')) {
  window.customCards.push({
    type: 'radar-zone-presence-headcount-card',
    name: 'Radar Presence: occupants',
    description: 'Occupants at home, per floor and room, with + / − to correct the count.',
  });
}
