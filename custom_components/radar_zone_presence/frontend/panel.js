// Radar Zones sidebar panel: zone editor, history point cloud, preview and
// replay scrubber for one radar at a time.

import './plot.js';
import './timeline.js';
import { fovPolygon, replayHistory, summarize, validatePolygon, pointInPolygon } from './engine.js';
import {
  EXCLUDE_COLOR, ZONE_COLORS, clone, el, fmtDateTime, fmtDuration, fmtTime, makeUnits, newZoneId, slotColor,
} from './util.js';

const DOMAIN = 'radar_zone_presence';
const RANGES = [
  ['15m', 900], ['1h', 3600], ['6h', 21600], ['24h', 86400], ['48h', 172800], ['7d', 604800],
];
const SPEEDS = [0.25, 1, 4, 16, 64];

const css = `
:host { display: block; height: 100%; background: var(--primary-background-color, #fafafa); color: var(--primary-text-color, #222);
  font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); font-size: 14px; }
* { box-sizing: border-box; }
.app { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
header { display: flex; align-items: center; gap: 10px; padding: 0 12px; height: 56px; background: var(--app-header-background-color, var(--primary-color, #03a9f4));
  color: var(--app-header-text-color, #fff); }
header h1 { font-size: 20px; font-weight: 400; margin: 0 12px 0 0; white-space: nowrap; }
header select, header button { font: inherit; }
header select { background: rgba(255,255,255,.15); color: inherit; border: 1px solid rgba(255,255,255,.35); border-radius: 4px; padding: 5px 6px; max-width: 280px; }
header select option { color: #222; }
header .spacer { flex: 1; }
header .dirty { font-size: 12px; opacity: .9; }
.menu { background: none; border: 0; color: inherit; font-size: 22px; cursor: pointer; padding: 4px 8px; display: none; }
:host([narrow]) .menu { display: block; }
button.hbtn { background: rgba(255,255,255,.18); color: inherit; border: 1px solid rgba(255,255,255,.4); border-radius: 4px; padding: 6px 12px; cursor: pointer; }
button.hbtn.primary { background: #fff; color: var(--primary-color, #03a9f4); font-weight: 600; }
button.hbtn:disabled { opacity: .45; cursor: default; }
.body { display: grid; grid-template-columns: 1fr 340px; min-height: 0; }
:host([narrow]) .body { grid-template-columns: 1fr; grid-template-rows: minmax(420px, 70vh) auto; overflow: auto; }
.main { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--divider-color, #ddd); }
.toolbar, .transport { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; padding: 6px 8px; background: var(--card-background-color, #fff);
  border-bottom: 1px solid var(--divider-color, #ddd); }
.transport { border-top: 1px solid var(--divider-color, #ddd); border-bottom: 0; }
.group { display: flex; align-items: center; gap: 2px; padding-right: 8px; margin-right: 2px; border-right: 1px solid var(--divider-color, #ddd); }
.group:last-child { border-right: 0; }
.tb { border: 1px solid transparent; background: none; color: var(--primary-text-color, #222); border-radius: 4px; padding: 4px 8px; cursor: pointer; font: inherit; font-size: 13px; white-space: nowrap; }
.tb:hover { background: var(--secondary-background-color, #eee); }
.tb.on { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
.tb:disabled { opacity: .4; cursor: default; }
.toolbar select, .transport select, .side select, .side input { font: inherit; font-size: 13px; padding: 3px 4px; border: 1px solid var(--divider-color, #ccc); border-radius: 4px;
  background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); }
.toolbar label, .transport label { font-size: 12px; color: var(--secondary-text-color, #666); display: flex; align-items: center; gap: 3px; }
rzp-plot { flex: 1; min-height: 300px; }
.timeline-wrap { background: var(--card-background-color, #fff); border-top: 1px solid var(--divider-color, #ddd); padding: 2px 0; }
.status { display: flex; gap: 16px; font-size: 12px; color: var(--secondary-text-color, #666); padding: 3px 10px; background: var(--card-background-color, #fff);
  border-top: 1px solid var(--divider-color, #ddd); min-height: 22px; }
.status .hint { margin-left: auto; }
.side { overflow-y: auto; overflow-x: hidden; min-width: 0; background: var(--card-background-color, #fff); }
.section { padding: 10px 12px; border-bottom: 1px solid var(--divider-color, #ddd); }
.section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color, #666); display: flex; align-items: center; }
.section h3 .grow { flex: 1; }
.zone-row { display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 6px 6px; border-radius: 6px; cursor: pointer; }
.zone-row:hover { background: var(--secondary-background-color, #f2f2f2); }
.zone-row.sel { background: rgba(3,169,244,.12); outline: 1px solid var(--primary-color, #03a9f4); }
.swatch { width: 14px; height: 14px; border-radius: 3px; }
.zone-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zone-meta { font-size: 11px; color: var(--secondary-text-color, #777); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--secondary-background-color, #eee); color: var(--secondary-text-color, #555); white-space: nowrap; }
.badge.on { background: #43a047; color: #fff; }
.form { display: grid; grid-template-columns: 110px 1fr; gap: 6px 8px; align-items: center; font-size: 13px; }
.form input, .form select { width: 100%; }
.form .full { grid-column: 1 / -1; }
.help { overflow-wrap: anywhere; font-size: 11px; color: var(--secondary-text-color, #777); line-height: 1.35; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.btn { border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); border-radius: 4px; padding: 5px 10px; cursor: pointer; font: inherit; font-size: 13px; }
.btn:hover { background: var(--secondary-background-color, #f0f0f0); }
.btn.danger { color: var(--error-color, #c62828); border-color: var(--error-color, #c62828); }
.btn.primary { background: var(--primary-color, #03a9f4); color: #fff; border-color: transparent; }
table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 2px 4px; border-bottom: 1px solid var(--divider-color, #eee); }
th:first-child, td:first-child { text-align: left; }
td input { width: 70px; text-align: right; }
.vtable td { padding: 1px 2px; }
.triggers { max-height: 160px; overflow: auto; font-size: 12px; }
.triggers div { padding: 2px 4px; cursor: pointer; border-radius: 3px; display: flex; justify-content: space-between; }
.triggers div:hover { background: var(--secondary-background-color, #eee); }
.stat { display: flex; justify-content: space-between; font-size: 13px; padding: 2px 0; }
.stat b { font-variant-numeric: tabular-nums; }
.frames { max-height: 220px; overflow: auto; background: var(--card-background-color, #fff); border-top: 1px solid var(--divider-color, #ddd); }
.frames tr.cur { background: rgba(229,57,53,.12); }
.frames td.in { color: #43a047; font-weight: 600; }
.frames td.ex { color: ${EXCLUDE_COLOR}; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #323232; color: #fff; padding: 10px 16px; border-radius: 4px; z-index: 10; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
.toast.error { background: var(--error-color, #c62828); }
.empty { padding: 40px; text-align: center; color: var(--secondary-text-color, #666); line-height: 1.6; }
.loading { position: absolute; right: 12px; top: 8px; font-size: 12px; color: var(--secondary-text-color, #666); background: var(--card-background-color, #fff); padding: 2px 8px; border-radius: 10px; }
.plot-wrap { position: relative; flex: 1; display: flex; min-height: 0; }
`;

class RadarZonePresencePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._started = false;
    this.radars = [];
    this.unconfigured = [];
    this.entryId = null;
    this.config = null;
    this.units = makeUnits('in');
    this.zones = [];
    this.saved = '[]';
    this.settings = { reconnect_grace_s: 0, display: { rotation: 0, mirror: false } };
    this.savedSettings = JSON.stringify(this.settings);
    this.undoStack = [];
    this.redoStack = [];
    this.selectedId = null;
    this.selectedVertex = null;
    this.tool = 'select';
    this.drawKind = 'include';
    this.snap = { angle: true, grid: false, vertex: true, gridStep: 50.8 };
    this.showMeasurements = true;
    this.colorMode = 0;
    this.rangeS = 86400;
    this.hist = null;
    this.frameIdx = null;
    this.actual = {};
    this.preview = null;
    this.mode = 'cloud';
    this.cursor = null;
    this.playing = false;
    this.speed = 1;
    this.trailSeconds = 20;
    this.trailLabels = false;
    this.showFrames = false;
    this.live = true;
    this.liveTargets = [];
    this.liveTrails = new Map();
    this.liveStates = {};
    this.brush = null;
    this._unsubLive = null;
    this._previewTimer = 0;
    this._loadingHistory = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._started) { this._started = true; this._start(); }
    else if (this.config) this._refreshLiveBadges();
  }
  get hass() { return this._hass; }

  set narrow(v) { this.toggleAttribute('narrow', !!v); }
  set panel(p) { this._panel = p; }

  disconnectedCallback() {
    this._unsubscribeLive();
    this.playing = false;
    window.removeEventListener('keydown', this._keyHandler);
  }

  connectedCallback() {
    this._keyHandler = this._keyHandler || (e => this._onKey(e));
    window.addEventListener('keydown', this._keyHandler);
  }

  // ----------------------------------------------------------- bootstrap

  async _start() {
    this._buildShell();
    await this._loadRadars();
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('entry');
    const stored = localStorage.getItem('rzp.entry');
    const pick = [fromHash, stored].find(id => this.radars.some(r => r.entry_id === id)) || this.radars[0]?.entry_id;
    if (pick) await this._selectRadar(pick);
    else this._renderEmpty();
  }

  async _loadRadars() {
    const res = await this.hass.callWS({ type: `${DOMAIN}/list` });
    this.radars = res.radars;
    this.unconfigured = res.unconfigured;
    this._renderHeader();
  }

  async _selectRadar(entryId) {
    if (this._dirty() && !confirm('Discard unsaved zone changes?')) { this._renderHeader(); return; }
    this.entryId = entryId;
    localStorage.setItem('rzp.entry', entryId);
    history.replaceState(null, '', `#entry=${entryId}`);
    this.selectedId = null;
    this.selectedVertex = null;
    this.mode = 'cloud';
    this.cursor = null;
    this.playing = false;
    this.brush = null;
    this.undoStack = [];
    this.redoStack = [];
    await this._loadConfig();
    this._subscribeLive();
    await this._loadHistory();
  }

  async _loadConfig() {
    const cfg = await this.hass.callWS({ type: `${DOMAIN}/config`, entry_id: this.entryId });
    this.config = cfg;
    this.units = makeUnits(cfg.target_unit, this.hass);
    this.snap.gridStep = this.units.snapSteps[1];
    this.zones = cfg.zones.map(z => this._editable(z));
    this.saved = JSON.stringify(this.zones);
    this.settings = {
      reconnect_grace_s: cfg.settings.reconnect_grace_s || 0,
      display: { rotation: 0, mirror: false, ...(cfg.settings.display || {}) },
    };
    this.savedSettings = JSON.stringify(this.settings);
    this._renderAll();
    this.plot.fit();
  }

  _editable(z) {
    return {
      id: z.id, name: z.name, kind: z.kind, polygon: z.polygon.map(p => [p[0], p[1]]),
      filters: { on_delay_s: 0, off_delay_s: 0, edge_margin_mm: 0, ...(z.filters || {}) },
      area_id: z.area_id ?? null,
    };
  }

  // ---------------------------------------------------------------- live

  _unsubscribeLive() {
    if (this._unsubLive) { this._unsubLive.then(u => u()).catch(() => {}); this._unsubLive = null; }
  }

  _subscribeLive() {
    this._unsubscribeLive();
    this.liveTrails = new Map();
    this.liveTargets = [];
    const entryId = this.entryId;
    this._unsubLive = this.hass.connection.subscribeMessage(ev => {
      if (entryId !== this.entryId) return;
      if (ev.closed) {
        // Entry reloaded (zones saved): reconnect shortly.
        this._unsubLive = null;
        setTimeout(() => { if (entryId === this.entryId) { this._loadConfigKeepView(); this._subscribeLive(); } }, 800);
        return;
      }
      this._onLiveFrame(ev);
    }, { type: `${DOMAIN}/frames/subscribe`, entry_id: entryId });
    this._unsubLive.catch(err => this._toast(`Live updates failed: ${err.message || err.code}`, true));
  }

  async _loadConfigKeepView() {
    const cfg = await this.hass.callWS({ type: `${DOMAIN}/config`, entry_id: this.entryId });
    this.config = cfg;
    // Keep the draft if the user kept editing; otherwise sync ids/entity ids from the server.
    if (!this._dirty()) {
      this.zones = cfg.zones.map(z => this._editable(z));
      this.saved = JSON.stringify(this.zones);
    }
    this._renderSide();
    this._updatePlot();
  }

  _onLiveFrame(ev) {
    const now = ev.t;
    this.liveTargets = ev.targets;
    this.liveStates = Object.fromEntries(Object.entries(ev.zones).map(([k, v]) => [k, v[0]]));
    for (const [slot, x, y] of ev.targets) {
      if (!this.liveTrails.has(slot)) this.liveTrails.set(slot, []);
      this.liveTrails.get(slot).push({ x, y, t: now });
    }
    for (const [slot, pts] of this.liveTrails) {
      while (pts.length && pts[0].t < now - this.trailSeconds) pts.shift();
      if (!pts.length) this.liveTrails.delete(slot);
    }
    if (this.mode === 'cloud') this._updatePlot();
    this._renderLiveBadges();
  }

  // ------------------------------------------------------------- history

  async _loadHistory() {
    if (!this.entryId) return;
    this._loadingHistory = true;
    this._renderLoading();
    const end = new Date();
    const start = new Date(end.getTime() - this.rangeS * 1000);
    try {
      const [hist, events] = await Promise.all([
        this.hass.callWS({ type: `${DOMAIN}/frames/history`, entry_id: this.entryId, start: start.toISOString(), end: end.toISOString() }),
        this.hass.callWS({ type: `${DOMAIN}/zone_events`, entry_id: this.entryId, start: start.toISOString(), end: end.toISOString() }),
      ]);
      this._setHistory(hist);
      this.actual = {};
      for (const [zid, rows] of Object.entries(events.zones)) {
        const iv = [];
        let on = null;
        for (const [t, s] of rows) {
          if (s === 'on' && on === null) on = t;
          else if (s !== 'on' && on !== null) { iv.push([on, t]); on = null; }
        }
        if (on !== null) iv.push([on, events.end]);
        this.actual[zid] = iv;
      }
    } catch (err) {
      this._toast(`History unavailable: ${err.message || err.code}`, true);
      this.hist = null;
    }
    this._loadingHistory = false;
    this._renderLoading();
    this._recomputePreview(true);
  }

  _setHistory(hist) {
    this.hist = hist;
    const nT = hist.x.length;
    const pos = new Float32Array(nT * 2);
    const t = new Float32Array(nT);
    const slot = new Float32Array(nT);
    // frameOf[k] = frame index of target k; frameStart[i] = first target index of frame i
    const nF = hist.frame_t.length;
    const frameStart = new Uint32Array(nF + 1);
    let k = 0;
    for (let i = 0; i < nF; i++) {
      frameStart[i] = k;
      for (let j = 0; j < hist.frame_n[i]; j++, k++) {
        pos[2 * k] = hist.x[k];
        pos[2 * k + 1] = hist.y[k];
        t[k] = hist.frame_t[i];
        slot[k] = hist.slot[k];
      }
    }
    frameStart[nF] = k;
    this.frameIdx = { frameStart, frameT: Float64Array.from(hist.frame_t) };
    this.plot.setHistory({ pos, t, slot });
    if (hist.truncated) this._toast('History truncated: pick a shorter range for the full point cloud.');
    this._renderStatus();
  }

  // ------------------------------------------------------------- preview

  _recomputePreview(immediate = false) {
    clearTimeout(this._previewTimer);
    const run = () => {
      if (!this.hist) { this.preview = null; this._renderTimeline(); this._renderSide(); return; }
      const zones = this.zones.filter(z => !validatePolygon(z.polygon));
      const res = replayHistory(this.hist, zones, this.settings.reconnect_grace_s, { perFrameStates: true });
      const keys = [...zones.filter(z => z.kind !== 'exclude').map(z => z.id), 'presence'];
      // Same zones without filters, to show what the filters remove.
      const unfiltered = replayHistory(this.hist, zones.map(z => ({ ...z, filters: {} })), 0);
      this.preview = {
        perFrame: res.perFrame,
        summary: summarize(res.transitions, keys, this.hist.start, this.hist.end),
        unfiltered: summarize(unfiltered.transitions, keys, this.hist.start, this.hist.end),
      };
      this._renderTimeline();
      this._renderSideStats();
      this._updateFlags();
      this._updatePlot();
    };
    if (immediate) run();
    else this._previewTimer = setTimeout(run, 150);
  }

  _updateFlags() {
    const sel = this.zones.find(z => z.id === this.selectedId);
    const excl = this.zones.filter(z => z.kind === 'exclude');
    if (this.colorMode === 1) this.plot.updateFlags(sel && sel.kind !== 'exclude' ? sel : null, excl);
  }

  // -------------------------------------------------------------- replay

  _frameAt(tRel) {
    const ft = this.frameIdx.frameT;
    let lo = 0, hi = ft.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ft[mid] <= tRel) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  _targetsOfFrame(i) {
    const out = [];
    const { frameStart } = this.frameIdx;
    for (let k = frameStart[i]; k < frameStart[i + 1]; k++) out.push([this.hist.slot[k], this.hist.x[k], this.hist.y[k]]);
    return out;
  }

  _replayState() {
    const hist = this.hist;
    const tRel = this.cursor - hist.start;
    const i = this._frameAt(tRel);
    const trails = new Map();
    let targets = [];
    const states = {};
    if (i >= 0) {
      for (let j = i; j >= 0 && hist.frame_t[j] >= tRel - this.trailSeconds; j--) {
        for (const [slot, x, y] of this._targetsOfFrame(j)) {
          if (!trails.has(slot)) trails.set(slot, []);
          trails.get(slot).unshift({ x, y, t: hist.start + hist.frame_t[j] });
        }
      }
      if (tRel - hist.frame_t[i] < 2) targets = this._targetsOfFrame(i);
      if (this.preview?.perFrame) for (const [k, arr] of Object.entries(this.preview.perFrame)) states[k] = !!arr[i];
    }
    return { trails, targets, states, frame: i };
  }

  _seek(t) {
    if (!this.hist) return;
    this.mode = 'replay';
    this.cursor = Math.max(this.hist.start, Math.min(this.hist.end, t));
    this._updatePlot();
    this._renderTransport();
    this.timeline.set({ cursor: this.cursor });
    if (this.showFrames) this._renderFrames();
  }

  _exitReplay() {
    this.mode = 'cloud';
    this.cursor = null;
    this.playing = false;
    this.timeline.set({ cursor: null });
    this._updatePlot();
    this._renderTransport();
    this._renderFrames();
  }

  _togglePlay() {
    if (!this.hist) return;
    if (this.playing) { this.playing = false; this._renderTransport(); return; }
    if (this.mode !== 'replay' || this.cursor >= this.hist.end - 0.5) {
      this._seek(this.brush ? this.brush.t0 : Math.max(this.hist.start, this.hist.end - 600));
    }
    this.playing = true;
    this._renderTransport();
    let last = performance.now();
    const step = now => {
      if (!this.playing) return;
      const dt = (now - last) / 1000;
      last = now;
      // Skip quiet stretches at high speed so playback stays interesting.
      let next = this.cursor + dt * this.speed;
      if (this.speed >= 16) {
        const i = this._frameAt(next - this.hist.start);
        const nt = this.hist.frame_t[i + 1];
        if (nt !== undefined && this.hist.start + nt - next > 60) next = this.hist.start + nt - 1;
      }
      if (next >= this.hist.end) { next = this.hist.end; this.playing = false; }
      this._seek(next);
      if (this.playing) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _stepFrame(dir) {
    if (!this.hist) return;
    const tRel = (this.cursor ?? this.hist.end) - this.hist.start;
    let i = this._frameAt(tRel);
    i = Math.max(0, Math.min(this.hist.frame_t.length - 1, i + dir + (dir < 0 && this.hist.frame_t[i] < tRel ? 1 : 0)));
    this._seek(this.hist.start + this.hist.frame_t[i]);
  }

  _jumpTo(t, zoneId) {
    this.playing = false;
    this._seek(t);
    this.timeline.focus(t - 30, t + 30);
    if (zoneId && zoneId !== 'presence') this._select(zoneId, null);
  }

  // ---------------------------------------------------------------- edits

  _dirty() {
    if (!this.config) return false;
    return JSON.stringify(this.zones) !== this.saved || JSON.stringify(this.settings) !== this.savedSettings;
  }

  _pushUndo(prev) {
    this.undoStack.push(prev);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  _setZones(zones, { commit = true, prev = null } = {}) {
    if (commit) this._pushUndo(prev ?? JSON.stringify(this.zones));
    this.zones = zones;
    this._updatePlot();
    this._recomputePreview();
    this._renderHeader();
  }

  _undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.zones));
    this.zones = JSON.parse(this.undoStack.pop());
    if (!this.zones.some(z => z.id === this.selectedId)) this.selectedId = null;
    this.selectedVertex = null;
    this._afterStructural();
  }

  _redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.zones));
    this.zones = JSON.parse(this.redoStack.pop());
    this._afterStructural();
  }

  _afterStructural() {
    this._updatePlot();
    this._recomputePreview();
    this._renderSide();
    this._renderHeader();
  }

  _addZone(polygon, kind = 'include', name = null) {
    const n = this.zones.filter(z => z.kind === kind).length + 1;
    const zone = {
      id: newZoneId(), name: name || (kind === 'exclude' ? `Exclusion ${n}` : `Zone ${n}`), kind,
      polygon: polygon.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]),
      filters: { on_delay_s: 0, off_delay_s: 0, edge_margin_mm: 0 }, area_id: null,
    };
    const prev = JSON.stringify(this.zones);
    this.selectedId = zone.id;
    this.selectedVertex = null;
    this._setZones([...this.zones, zone], { prev });
    this._renderSide();
    this._updateFlags();
  }

  _deleteZone(id) {
    const z = this.zones.find(q => q.id === id);
    if (!z) return;
    this.selectedId = null;
    this._setZones(this.zones.filter(q => q.id !== id));
    this._renderSide();
  }

  _patchZone(id, patch, { commit = true, renderSide = false } = {}) {
    const prev = JSON.stringify(this.zones);
    this._setZones(this.zones.map(z => (z.id === id ? { ...z, ...patch } : z)), { commit, prev });
    if (renderSide) this._renderSide();
  }

  _select(zoneId, vertex) {
    this.selectedId = zoneId;
    this.selectedVertex = vertex;
    this._updatePlot();
    this._updateFlags();
    this._renderSide();
  }

  async _save() {
    for (const z of this.zones) {
      const err = validatePolygon(z.polygon);
      if (err) { this._toast(`${z.name}: ${err}`, true); this._select(z.id, null); return; }
      if (!z.name.trim()) { this._toast('Every zone needs a name', true); this._select(z.id, null); return; }
    }
    try {
      const res = await this.hass.callWS({
        type: `${DOMAIN}/zones/save`, entry_id: this.entryId, zones: this.zones,
        settings: { reconnect_grace_s: Number(this.settings.reconnect_grace_s) || 0, display: this.settings.display },
      });
      this.zones = res.zones.map(z => this._editable(z));
      this.saved = JSON.stringify(this.zones);
      this.savedSettings = JSON.stringify(this.settings);
      this._toast('Zones saved');
      this._renderHeader();
      this._renderSide();
      await this._loadRadars();
    } catch (err) {
      this._toast(`Save failed: ${err.message || err.code}`, true);
    }
  }

  _revert() {
    if (!confirm('Discard all unsaved changes?')) return;
    this.zones = JSON.parse(this.saved);
    this.settings = JSON.parse(this.savedSettings);
    this.selectedId = null;
    this.undoStack = [];
    this.redoStack = [];
    this._renderAll();
    this._recomputePreview();
  }

  // ------------------------------------------------------------ keyboard

  _onKey(e) {
    if (!this.isConnected || !this.config) return;
    const path = e.composedPath();
    const inInput = path.some(n => n instanceof HTMLElement && (n.tagName === 'INPUT' || n.tagName === 'SELECT' || n.tagName === 'TEXTAREA'));
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (this._dirty()) this._save(); return; }
    if (inInput) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this._redo() : this._undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this._redo(); return; }
    if (mod) return;
    const k = e.key.toLowerCase();
    if (k === 'v') this._setTool('select');
    else if (k === 'd') this._setTool('draw');
    else if (k === 'r') this._setTool('rect');
    else if (k === 'm') this._setTool('measure');
    else if (k === ' ') { e.preventDefault(); this._togglePlay(); }
    else if (k === ',' ) this._stepFrame(-1);
    else if (k === '.') this._stepFrame(1);
    else if (k === 'f') this.plot.fit();
  }

  _setTool(tool) {
    this.tool = tool;
    this.plot.cancelDraft();
    this._updatePlot();
    this._renderToolbar();
    this._renderStatus();
  }

  // ------------------------------------------------------------ rendering

  _buildShell() {
    const root = this.shadowRoot;
    root.innerHTML = '';
    root.append(el('style', {}, css));
    this.header = el('header');
    this.toolbar = el('div', { class: 'toolbar' });
    this.plot = document.createElement('rzp-plot');
    this.loadingEl = el('div', { class: 'loading', style: { display: 'none' } }, 'Loading history…');
    this.transport = el('div', { class: 'transport' });
    this.timeline = document.createElement('rzp-timeline');
    this.framesEl = el('div', { class: 'frames', style: { display: 'none' } });
    this.statusEl = el('div', { class: 'status' });
    this.side = el('div', { class: 'side' });
    const main = el('div', { class: 'main' },
      this.toolbar,
      el('div', { class: 'plot-wrap' }, this.plot, this.loadingEl),
      this.transport,
      el('div', { class: 'timeline-wrap' }, this.timeline),
      this.framesEl,
      this.statusEl);
    this.bodyEl = el('div', { class: 'body' }, main, this.side);
    root.append(el('div', { class: 'app' }, this.header, this.bodyEl));

    this.plot.addEventListener('zones-change', e => {
      if (e.detail.commit) {
        this._setZones(e.detail.zones, { prev: this._dragPrev ?? JSON.stringify(this.zones) });
        this._dragPrev = null;
        this._renderSide();
      } else {
        if (this._dragPrev == null) this._dragPrev = JSON.stringify(this.zones);
        this.zones = e.detail.zones;
        this._recomputePreview();
        this._renderVertexTable();
        this._renderHeader();
      }
    });
    this.plot.addEventListener('select', e => this._select(e.detail.zoneId, e.detail.vertex));
    this.plot.addEventListener('zone-drawn', e => { this._addZone(e.detail.polygon, e.detail.kind); this._setTool('select'); });
    this.plot.addEventListener('tool', e => this._setTool(e.detail.tool));
    this.plot.addEventListener('pointer-world', e => { this._pointer = e.detail; this._renderPointer(); });
    this.timeline.addEventListener('seek', e => { this.playing = false; this._seek(e.detail.t); });
    this.timeline.addEventListener('trigger', e => this._jumpTo(e.detail.t, e.detail.zoneId));
    this.timeline.addEventListener('window', e => { this.brush = e.detail.brush; this._updatePlot(); });
  }

  _renderAll() {
    this._renderHeader();
    this._renderToolbar();
    this._renderTransport();
    this._renderSide();
    this._renderStatus();
    this._updatePlot();
    this._renderTimeline();
  }

  _renderEmpty() {
    this._renderHeader();
    this.bodyEl.replaceChildren(el('div', { class: 'empty' },
      el('h2', {}, 'No radar sensors configured'),
      el('p', {}, this.unconfigured.length
        ? `Found ${this.unconfigured.length} radar sensor(s) with target coordinates: ${this.unconfigured.map(u => u.name).join(', ')}.`
        : 'No devices with per-target X/Y sensors were found.'),
      el('p', {}, 'Add one under Settings → Devices & services → Add integration → Radar Zone Presence.'),
      el('a', { href: '/config/integrations/dashboard/add?domain=radar_zone_presence', class: 'btn primary' }, 'Add radar')));
  }

  _renderHeader() {
    const h = this.header;
    if (!h) return;
    const dirty = this._dirty();
    const sel = el('select', { onchange: e => this._selectRadar(e.target.value), title: 'Radar sensor' },
      this.radars.map(r => el('option', { value: r.entry_id, selected: r.entry_id === this.entryId }, `${r.title}${r.area ? ` · ${r.area}` : ''}`)));
    const range = el('select', { onchange: e => { this.rangeS = +e.target.value; this._exitReplay(); this._loadHistory(); }, title: 'History range' },
      RANGES.map(([label, s]) => el('option', { value: s, selected: s === this.rangeS }, `Last ${label}`)));
    h.replaceChildren(
      el('button', { class: 'menu', title: 'Menu', onclick: () => this.dispatchEvent(new Event('hass-toggle-menu', { bubbles: true, composed: true })) }, '☰'),
      el('h1', {}, 'Radar Zones'),
      this.radars.length ? sel : '',
      this.radars.length ? range : '',
      this.radars.length ? el('button', { class: 'hbtn', title: 'Reload history', onclick: () => this._loadHistory() }, '⟳') : '',
      el('div', { class: 'spacer' }),
      dirty ? el('span', { class: 'dirty' }, 'Unsaved changes') : '',
      el('button', { class: 'hbtn', disabled: !dirty, onclick: () => this._revert() }, 'Revert'),
      el('button', { class: 'hbtn primary', disabled: !dirty, onclick: () => this._save(), title: 'Save (Ctrl+S)' }, 'Save'),
    );
  }

  _tb(label, on, onclick, title, disabled = false) {
    return el('button', { class: `tb${on ? ' on' : ''}`, onclick, title: title || label, disabled }, label);
  }

  _renderToolbar() {
    const t = this.toolbar;
    const s = this.snap;
    const gridOpts = this.units.snapSteps.map(v => el('option', { value: v, selected: Math.abs(v - s.gridStep) < 0.01 }, this.units.fmtLong(v)));
    t.replaceChildren(
      el('div', { class: 'group' },
        this._tb('Select', this.tool === 'select', () => this._setTool('select'), 'Select / edit (V)'),
        this._tb('Polygon', this.tool === 'draw', () => this._setTool('draw'), 'Draw polygon (D): click vertices, click the first vertex or press Enter to close'),
        this._tb('Rectangle', this.tool === 'rect', () => this._setTool('rect'), 'Draw rectangle (R): drag'),
        this._tb('Measure', this.tool === 'measure', () => this._setTool('measure'), 'Measure distance and angle (M)')),
      el('div', { class: 'group' },
        this._tb('Include', this.drawKind === 'include', () => { this.drawKind = 'include'; this._updatePlot(); this._renderToolbar(); }, 'New shapes are include zones'),
        this._tb('Exclude', this.drawKind === 'exclude', () => { this.drawKind = 'exclude'; this._updatePlot(); this._renderToolbar(); }, 'New shapes are exclusion zones')),
      el('div', { class: 'group' },
        this._tb('∠ Angles', s.angle, () => { s.angle = !s.angle; this._updatePlot(); this._renderToolbar(); }, 'Snap edges to 45°/90°, relative to the previous edge (hold Shift to disable)'),
        this._tb('◦ Vertices', s.vertex, () => { s.vertex = !s.vertex; this._updatePlot(); this._renderToolbar(); }, 'Snap to existing vertices'),
        this._tb('# Grid', s.grid, () => { s.grid = !s.grid; this._updatePlot(); this._renderToolbar(); }, 'Snap to grid'),
        el('select', { onchange: e => { s.gridStep = +e.target.value; this._updatePlot(); }, title: 'Grid step' }, gridOpts),
        this._tb('📏', this.showMeasurements, () => { this.showMeasurements = !this.showMeasurements; this._updatePlot(); this._renderToolbar(); }, 'Show edge lengths and angles')),
      el('div', { class: 'group' },
        el('label', {}, 'Colour',
          el('select', { onchange: e => { this.colorMode = +e.target.value; this._updateFlags(); this._updatePlot(); } },
            el('option', { value: 0, selected: this.colorMode === 0 }, 'by target'),
            el('option', { value: 1, selected: this.colorMode === 1 }, 'selected zone'),
            el('option', { value: 2, selected: this.colorMode === 2 }, 'by age')))),
      el('div', { class: 'group' },
        this._tb('Fit', false, () => this.plot.fit(), 'Fit view (F)'),
        this._tb('⟲', false, () => this._rotate(-90), 'Rotate view'),
        this._tb('⟳', false, () => this._rotate(90), 'Rotate view'),
        this._tb('⇋', this.settings.display.mirror, () => { this.settings.display = { ...this.settings.display, mirror: !this.settings.display.mirror }; this._updatePlot(); this.plot.fit(); this._renderToolbar(); this._renderHeader(); }, 'Mirror view (display only)'),
        this._tb('Live', this.live, () => { this.live = !this.live; this._updatePlot(); this._renderToolbar(); }, 'Show live targets')),
    );
  }

  _rotate(d) {
    const r = (((this.settings.display.rotation || 0) + d) % 360 + 360) % 360;
    this.settings.display = { ...this.settings.display, rotation: r };
    this._updatePlot();
    this.plot.fit();
    this._renderHeader();
  }

  _renderTransport() {
    const t = this.transport;
    if (!t) return;
    const replay = this.mode === 'replay';
    t.replaceChildren(
      el('div', { class: 'group' },
        this._tb('⏮', false, () => this._stepFrame(-1), 'Previous frame (,)', !this.hist),
        this._tb(this.playing ? '⏸' : '▶', this.playing, () => this._togglePlay(), 'Play / pause (Space)', !this.hist),
        this._tb('⏭', false, () => this._stepFrame(1), 'Next frame (.)', !this.hist),
        el('select', { onchange: e => { this.speed = +e.target.value; }, title: 'Playback speed' },
          SPEEDS.map(s => el('option', { value: s, selected: s === this.speed }, `${s}×`)))),
      el('div', { class: 'group' },
        el('label', {}, 'Trail',
          el('select', { onchange: e => { this.trailSeconds = +e.target.value; this._updatePlot(); } },
            [5, 10, 20, 30, 60, 120, 300].map(s => el('option', { value: s, selected: s === this.trailSeconds }, `${s} s`)))),
        this._tb('Timestamps', this.trailLabels, () => { this.trailLabels = !this.trailLabels; this._updatePlot(); this._renderTransport(); }, 'Label trail points with their time'),
        this._tb('Frames', this.showFrames, () => { this.showFrames = !this.showFrames; this._renderFrames(); this._renderTransport(); }, 'Show the frame table around the cursor')),
      el('div', { class: 'group' },
        replay
          ? el('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `Replay ${fmtDateTime(this.cursor)}.${String(Math.floor((this.cursor % 1) * 1000)).padStart(3, '0')}`)
          : el('span', { class: 'help' }, this.hist ? 'Timeline: coloured bars = draft preview ▼ · dark line = recorded by HA ▲ · click to replay, wheel to zoom, drag the activity strip to window the cloud' : ''),
        replay ? this._tb('Exit replay', false, () => this._exitReplay(), 'Back to point cloud + live view') : ''),
    );
  }

  _renderTimeline() {
    if (!this.timeline) return;
    const rows = [];
    const sum = this.preview?.summary || {};
    this.zones.forEach((z, i) => {
      if (z.kind === 'exclude') return;
      rows.push({ id: z.id, name: z.name, color: ZONE_COLORS[i % ZONE_COLORS.length], predicted: sum[z.id]?.intervals || [], actual: this.actual[z.id] || [], triggers: sum[z.id]?.triggers || [], actualTriggers: (this.actual[z.id] || []).map(v => v[0]) });
    });
    rows.push({ id: 'presence', name: 'Any (not excluded)', color: '#607d8b', predicted: sum.presence?.intervals || [], actual: this.actual.presence || [], triggers: [], actualTriggers: (this.actual.presence || []).map(v => v[0]) });
    this.timeline.set({
      range: this.hist ? { start: this.hist.start, end: this.hist.end } : null,
      frames: this.hist ? { start: this.hist.start, t: this.hist.frame_t, n: this.hist.frame_n } : null,
      rows,
      cursor: this.cursor,
      brush: this.brush,
    });
  }

  _updatePlot() {
    if (!this.plot || !this.config) return;
    let targets = [], trails = new Map(), states = {};
    let window = { t0: 0, t1: Infinity };
    let cursor = -1;
    if (this.mode === 'replay' && this.hist) {
      const r = this._replayState();
      targets = r.targets;
      trails = r.trails;
      states = r.states;
      cursor = this.cursor - this.hist.start;
    } else {
      if (this.live) { targets = this.liveTargets; trails = this.liveTrails; states = this.liveStates; }
      if (this.brush && this.hist) window = { t0: this.brush.t0 - this.hist.start, t1: this.brush.t1 - this.hist.start };
    }
    this.plot.set({
      units: this.units,
      fov: this.config.fov,
      deviceZones: this.config.device_zones,
      zones: this.zones,
      zoneStates: states,
      selectedId: this.selectedId,
      selectedVertex: this.selectedVertex,
      display: this.settings.display,
      tool: this.tool,
      drawKind: this.drawKind,
      snap: this.snap,
      showMeasurements: this.showMeasurements,
      colorMode: this.colorMode,
      window,
      cursor,
      trailSeconds: this.trailSeconds,
      targets,
      trails,
      trailLabels: this.trailLabels,
    });
  }

  _renderLoading() {
    if (this.loadingEl) this.loadingEl.style.display = this._loadingHistory ? '' : 'none';
  }

  _renderStatus() {
    if (!this.statusEl) return;
    const hints = {
      select: 'Drag vertices · drag an edge to move it parallel · drag ▫ to insert · double-click vertex to delete · drag inside to move · Shift = free',
      draw: 'Click to add vertices · click first vertex / Enter to close · Backspace removes last · Esc cancels',
      rect: 'Drag to draw a rectangle',
      measure: 'Drag to measure distance and angle',
    };
    const h = this.hist;
    this.statusEl.replaceChildren(
      el('span', { class: 'pointer' }),
      h ? el('span', {}, `${h.frame_t.length.toLocaleString()} frames · ${h.x.length.toLocaleString()} points`) : '',
      el('span', { class: 'hint' }, hints[this.tool]),
    );
    this._renderPointer();
  }

  _renderPointer() {
    const span = this.statusEl?.querySelector('.pointer');
    if (!span || !this._pointer) return;
    const { x, y } = this._pointer;
    const r = Math.hypot(x, y), a = (Math.atan2(x, y) * 180) / Math.PI;
    span.textContent = `x ${this.units.fmtLong(x)}  y ${this.units.fmtLong(y)}  ·  ${this.units.fmtLong(r)} @ ${a.toFixed(0)}°`;
  }

  _zoneColor(z) {
    const i = this.zones.indexOf(z);
    return z.kind === 'exclude' ? EXCLUDE_COLOR : ZONE_COLORS[i % ZONE_COLORS.length];
  }

  _renderSide() {
    const s = this.side;
    if (!s || !this.config) return;
    const cfg = this.config;
    const zoneRows = this.zones.map(z => {
      const saved = cfg.zones.find(q => q.id === z.id);
      const eid = saved?.entity_id;
      return el('div', { class: `zone-row${z.id === this.selectedId ? ' sel' : ''}`, onclick: () => this._select(z.id, null), 'data-zone': z.id },
        el('div', { class: 'swatch', style: { background: this._zoneColor(z), opacity: z.kind === 'exclude' ? 0.6 : 1 } }),
        el('div', {},
          el('div', { class: 'zone-name' }, z.name),
          el('div', { class: 'zone-meta' }, z.kind === 'exclude' ? 'exclusion · ignored by all zones' : (eid || 'new — save to create entity'))),
        el('span', { class: 'badge', 'data-live': z.id }, z.kind === 'exclude' ? 'exclude' : '—'));
    });
    const legacy = (cfg.legacy_polygons || []).filter(lp => !this.zones.some(z => JSON.stringify(z.polygon) === JSON.stringify(lp.polygon)));
    const sensor = el('div', { class: 'section' },
      el('h3', {}, el('span', { class: 'grow' }, cfg.title)),
      el('div', { class: 'help' }, `${cfg.targets.length} targets · ${cfg.profile.replace(/_/g, ' ')} · range ${this.units.fmtLong(cfg.fov.max_distance_mm)}`),
      cfg.presence_entity_id ? el('div', { class: 'stat' }, el('span', {}, 'Any target (not excluded)'), el('span', { class: 'badge', 'data-live': 'presence' }, '—')) : '',
      el('div', { class: 'stat' }, el('span', { class: 'help' }, cfg.presence_entity_id || ''), ''),
    );
    const zonesSec = el('div', { class: 'section' },
      el('h3', {}, el('span', { class: 'grow' }, `Zones (${this.zones.length})`)),
      zoneRows.length ? zoneRows : el('div', { class: 'help' }, 'No zones yet. Draw one with the Polygon or Rectangle tool.'),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', onclick: () => { this.drawKind = 'include'; this._setTool('draw'); } }, '+ Zone'),
        el('button', { class: 'btn', onclick: () => { this.drawKind = 'exclude'; this._setTool('draw'); } }, '+ Exclusion'),
        el('button', { class: 'btn', title: 'Zone covering the whole field of view', onclick: () => this._addZone(fovPolygon(cfg.fov.max_distance_mm, cfg.fov.half_angle_deg, 12), 'include', 'Whole room') }, 'Fill detection area'),
        legacy.length ? el('button', { class: 'btn', title: legacy.map(l => l.entity_id).join('\n'), onclick: () => legacy.forEach(lp => this._addZone(lp.polygon, 'include', `Polygon ${lp.n}`)) }, `Import ${legacy.length} legacy polygon(s)`) : ''));
    s.replaceChildren(sensor, zonesSec, this._zoneEditor() || '', this._settingsSection());
    this._renderLiveBadges();
    this._renderSideStats();
  }

  _zoneEditor() {
    const z = this.zones.find(q => q.id === this.selectedId);
    if (!z) return null;
    const u = this.units;
    const areas = Object.values(this.hass.areas || {}).sort((a, b) => a.name.localeCompare(b.name));
    const deviceArea = this.hass.areas?.[this.config.device_area_id]?.name;
    const num = (value, onchange, attrs = {}) => el('input', { type: 'number', value, step: 'any', min: 0, ...attrs, onchange });
    const f = z.filters;
    const editor = el('div', { class: 'section' },
      el('h3', {}, el('span', { class: 'grow' }, z.kind === 'exclude' ? 'Exclusion zone' : 'Zone'),
        el('button', { class: 'btn danger', onclick: () => this._deleteZone(z.id) }, 'Delete')),
      el('div', { class: 'form' },
        el('label', {}, 'Name'),
        el('input', { type: 'text', value: z.name, onfocus: () => { this._namePrev = JSON.stringify(this.zones); }, oninput: e => { this.zones = this.zones.map(q => (q.id === z.id ? { ...q, name: e.target.value } : q)); this._updatePlot(); this._renderHeader(); this._renderTimeline(); }, onchange: () => { if (this._namePrev) this._pushUndo(this._namePrev); this._namePrev = null; this._renderSide(); } }),
        el('label', {}, 'Type'),
        el('select', { onchange: e => this._patchZone(z.id, { kind: e.target.value }, { renderSide: true }) },
          el('option', { value: 'include', selected: z.kind === 'include' }, 'Include (presence entity)'),
          el('option', { value: 'exclude', selected: z.kind === 'exclude' }, 'Exclude (ignored everywhere)')),
        z.kind === 'include' ? [
          el('label', {}, 'Area'),
          el('select', { onchange: e => this._patchZone(z.id, { area_id: e.target.value || null }) },
            el('option', { value: '', selected: !z.area_id }, `Inherit from device${deviceArea ? ` (${deviceArea})` : ''}`),
            areas.map(a => el('option', { value: a.area_id, selected: a.area_id === z.area_id }, a.name))),
          el('label', {}, 'On delay (s)'),
          num(f.on_delay_s, e => this._patchZone(z.id, { filters: { ...f, on_delay_s: Math.max(0, +e.target.value || 0) } })),
          el('label', {}, 'Off delay (s)'),
          num(f.off_delay_s, e => this._patchZone(z.id, { filters: { ...f, off_delay_s: Math.max(0, +e.target.value || 0) } })),
          el('label', {}, `Edge margin (${u.label})`),
          num(Math.round(u.toDisplay(f.edge_margin_mm) * 10) / 10, e => this._patchZone(z.id, { filters: { ...f, edge_margin_mm: Math.max(0, u.fromDisplay(+e.target.value || 0)) } })),
          el('div', { class: 'help full' }, 'On delay ignores short blips (ghosts are often < 2 s). Edge margin adds hysteresis: a target must be this far inside to enter and this far outside to leave.'),
        ] : el('div', { class: 'help full' }, 'Targets inside an exclusion are dropped before any include zone or the sensor-wide presence is evaluated.'),
      ),
      el('div', { class: 'zone-stats' }),
      el('details', { open: z.polygon.length <= 8 },
        el('summary', { class: 'help', style: { cursor: 'pointer', marginTop: '8px' } }, `Vertices (${z.polygon.length}) — ${u.label}`),
        el('div', { class: 'vwrap' })),
    );
    queueMicrotask(() => this._renderVertexTable());
    return editor;
  }

  _renderVertexTable() {
    const wrap = this.side?.querySelector('.vwrap');
    const z = this.zones.find(q => q.id === this.selectedId);
    if (!wrap || !z) return;
    if (wrap.contains(this.shadowRoot.activeElement)) return; // don't fight the user's typing
    const u = this.units;
    const rnd = v => Math.round(u.toDisplay(v) * 10) / 10;
    const set = (i, axis, v) => {
      const poly = z.polygon.map((p, k) => (k === i ? (axis === 0 ? [u.fromDisplay(v), p[1]] : [p[0], u.fromDisplay(v)]) : p));
      this._patchZone(z.id, { polygon: poly });
    };
    wrap.replaceChildren(el('table', { class: 'vtable' },
      el('tr', {}, el('th', {}, '#'), el('th', {}, 'x'), el('th', {}, 'y'), el('th', {}, '')),
      z.polygon.map((p, i) => el('tr', { style: i === this.selectedVertex ? { background: 'rgba(3,169,244,.12)' } : {} },
        el('td', {}, String(i + 1)),
        el('td', {}, el('input', { type: 'number', step: 'any', value: rnd(p[0]), onchange: e => set(i, 0, +e.target.value) })),
        el('td', {}, el('input', { type: 'number', step: 'any', value: rnd(p[1]), onchange: e => set(i, 1, +e.target.value) })),
        el('td', {}, z.polygon.length > 3 ? el('button', { class: 'tb', title: 'Delete vertex', onclick: () => this._patchZone(z.id, { polygon: z.polygon.filter((_, k) => k !== i) }, { renderSide: true }) }, '✕') : '')))));
  }

  _renderSideStats() {
    const box = this.side?.querySelector('.zone-stats');
    const z = this.zones.find(q => q.id === this.selectedId);
    if (!box || !z) return;
    if (!this.hist || !this.preview) { box.replaceChildren(el('div', { class: 'help' }, 'Load history to preview this zone.')); return; }
    if (z.kind === 'exclude') {
      let n = 0;
      for (let k = 0; k < this.hist.x.length; k++) if (pointInPolygon(this.hist.x[k], this.hist.y[k], z.polygon)) n++;
      box.replaceChildren(el('div', { class: 'section', style: { padding: '8px 0 0', border: 0 } },
        el('div', { class: 'stat' }, el('span', {}, 'Points removed in range'), el('b', {}, `${n.toLocaleString()} (${((100 * n) / Math.max(1, this.hist.x.length)).toFixed(1)}%)`))));
      return;
    }
    const s = this.preview.summary[z.id];
    const raw = this.preview.unfiltered[z.id];
    const actual = this.actual[z.id];
    if (!s) { box.replaceChildren(el('div', { class: 'help' }, 'Polygon is invalid: fix crossing edges to preview.')); return; }
    const filtered = raw && raw.triggers.length !== s.triggers.length;
    box.replaceChildren(el('div', { style: { marginTop: '10px' } },
      el('h3', {}, `Preview · last ${RANGES.find(r => r[1] === this.rangeS)?.[0] || ''}`),
      el('div', { class: 'stat' }, el('span', {}, 'Would have turned on'), el('b', {}, `${s.triggers.length}×`)),
      filtered ? el('div', { class: 'stat' }, el('span', { class: 'help' }, 'without filters'), el('b', { class: 'help' }, `${raw.triggers.length}×`)) : '',
      el('div', { class: 'stat' }, el('span', {}, 'Occupied'), el('b', {}, fmtDuration(s.occupied))),
      actual ? el('div', { class: 'stat' }, el('span', { class: 'help' }, 'Recorded by HA (saved zone)'), el('b', { class: 'help' }, `${actual.length}× on`)) : '',
      actual?.length ? el('details', {},
        el('summary', { class: 'help', style: { cursor: 'pointer' } }, 'Recent recorded triggers — what actually happened'),
        el('div', { class: 'triggers' }, actual.slice(-50).reverse().map(([a, b]) => el('div', { onclick: () => this._jumpTo(a, z.id), title: 'Replay this recorded trigger' },
          el('span', {}, fmtDateTime(a)), el('span', { class: 'help' }, fmtDuration(b - a)))))) : '',
      el('div', { class: 'help', style: { marginTop: '6px' } }, 'Preview triggers (draft zone):'),
      el('div', { class: 'triggers' }, s.triggers.slice(-200).reverse().map((t, i) => {
        const iv = s.intervals.find(v => v[0] === t);
        return el('div', { onclick: () => this._jumpTo(t, z.id), title: 'Replay this trigger' },
          el('span', {}, fmtDateTime(t)), el('span', { class: 'help' }, iv ? fmtDuration(iv[1] - iv[0]) : ''));
      }))));
  }

  _settingsSection() {
    return el('div', { class: 'section' },
      el('h3', {}, 'Sensor settings'),
      el('div', { class: 'form' },
        el('label', {}, 'Reconnect grace (s)'),
        el('input', { type: 'number', min: 0, step: 1, value: this.settings.reconnect_grace_s, onchange: e => { this.settings = { ...this.settings, reconnect_grace_s: Math.max(0, +e.target.value || 0) }; this._renderHeader(); this._recomputePreview(); } }),
        el('div', { class: 'help full' }, 'Ignore detections for this long after the radar comes back from unavailable (ghosts often appear right after a reconnect).'),
        el('label', {}, 'View'),
        el('span', { class: 'help' }, `rotated ${this.settings.display.rotation || 0}°${this.settings.display.mirror ? ', mirrored' : ''} (saved with zones)`)));
  }

  _renderLiveBadges() {
    if (!this.side) return;
    for (const b of this.side.querySelectorAll('[data-live]')) {
      const id = b.dataset.live;
      const z = this.zones.find(q => q.id === id);
      if (z?.kind === 'exclude') continue;
      const on = this.liveStates[id];
      if (on === undefined) { b.textContent = id === 'presence' ? '—' : 'not saved'; b.classList.remove('on'); continue; }
      b.textContent = on ? 'occupied' : 'clear';
      b.classList.toggle('on', !!on);
    }
  }

  _refreshLiveBadges() { /* hass state updates: live badges come from the frame subscription */ }

  _renderFrames() {
    const box = this.framesEl;
    if (!box) return;
    box.style.display = this.showFrames ? '' : 'none';
    if (!this.showFrames || !this.hist || this.mode !== 'replay') {
      box.replaceChildren(this.showFrames ? el('div', { class: 'help', style: { padding: '8px' } }, 'Click the timeline to replay; frames around the cursor show here.') : '');
      return;
    }
    const tRel = this.cursor - this.hist.start;
    const i = this._frameAt(tRel);
    const inc = this.zones.filter(z => z.kind !== 'exclude' && !validatePolygon(z.polygon));
    const exc = this.zones.filter(z => z.kind === 'exclude');
    const rows = [];
    for (let j = Math.max(0, i - 12); j <= Math.min(this.hist.frame_t.length - 1, i + 6); j++) {
      const t = this.hist.start + this.hist.frame_t[j];
      const tg = this._targetsOfFrame(j);
      const states = inc.map(z => (this.preview?.perFrame?.[z.id]?.[j] ? 'on' : 'off'));
      if (!tg.length) {
        rows.push(el('tr', { class: j === i ? 'cur' : '', onclick: () => this._seek(t) }, el('td', {}, fmtTime(t, true, true)), el('td', {}, '—'), el('td', {}, ''), el('td', {}, ''),
          inc.map((z, k) => el('td', {}, states[k]))));
      }
      tg.forEach(([slot, x, y], n) => {
        const excluded = exc.some(z => pointInPolygon(x, y, z.polygon));
        rows.push(el('tr', { class: j === i ? 'cur' : '', onclick: () => this._seek(t) },
          el('td', {}, n === 0 ? fmtTime(t, true, true) : ''),
          el('td', { style: { color: slotColor(slot) } }, `T${slot}${excluded ? ' (excl)' : ''}`),
          el('td', {}, this.units.fmtLong(x)),
          el('td', {}, this.units.fmtLong(y)),
          inc.map((z, k) => {
            const inside = !excluded && pointInPolygon(x, y, z.polygon);
            return el('td', { class: excluded ? 'ex' : inside ? 'in' : '' }, `${inside ? 'in' : '·'} / ${states[k]}`);
          })));
      });
    }
    queueMicrotask(() => box.querySelector('tr.cur')?.scrollIntoView({ block: 'center' }));
    box.replaceChildren(el('table', {},
      el('tr', {}, el('th', {}, 'time'), el('th', {}, 'target'), el('th', {}, 'x'), el('th', {}, 'y'), inc.map(z => el('th', {}, `${z.name} (inside / state)`))),
      rows));
  }

  _toast(msg, error = false) {
    const t = el('div', { class: `toast${error ? ' error' : ''}` }, msg);
    this.shadowRoot.append(t);
    setTimeout(() => t.remove(), error ? 6000 : 2500);
  }
}

customElements.get('radar-zone-presence-panel') || customElements.define('radar-zone-presence-panel', RadarZonePresencePanel);
