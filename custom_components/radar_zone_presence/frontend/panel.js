// Presence sidebar panel: the house (occupants, Activity) and, per radar, the
// map of rooms, spots, doorways and ignore areas with history and playback.

import './plot.js';
import './timeline.js';
import './headcount.js';
import { fovPolygon, summarize, validatePolygon, pointInPolygon } from './engine.js';
import { replayGroup } from './tracker.js';
import {
  classify, crossCheck, crossGhost, doorEvents, explainOn, convexHull, doorIntervals, doorPositions, findDwellSpots, fitHull, flappingEdges, offsetConvex, pairDetections, percentile,
  placeExit, registerRigid, spotTimes, suggestHold, suggestMaxHold, trailStats, viewToMatch,
} from './analysis.js';
import {
  EXCLUDE_COLOR, EXIT_COLOR, KIND_STYLE, ZONE_COLORS, affineApply, glyphSvg, kindTone, styleKind, isSpot, kindColor, doorGeometry, radarTransforms, clone, el, normalizeDisplay, fmtDateTime, fmtDuration, fmtTime, makeUnits, newZoneId, slotColor,
} from './util.js';
import { exportFilename, exportZones, mergeZones, parseImport } from './transfer.js';
import { openReportDialog } from './report.js';

const DOMAIN = 'radar_zone_presence';
const PANEL_PATH = 'radar-zones';
const RANGES = [
  ['15m', 900], ['1h', 3600], ['6h', 21600], ['24h', 86400], ['48h', 172800], ['7d', 604800],
];
const SPEEDS = [0.25, 1, 4, 16, 64];

const css = `
.replay-label.live { color: var(--error-color, #db4437); font-weight: 500; }
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
.tabs { display: flex; gap: 2px; background: rgba(255,255,255,.12); border-radius: 6px; padding: 2px; }
.tabs .tab { background: none; border: 0; color: inherit; padding: 5px 12px; border-radius: 4px; cursor: pointer; opacity: .8; }
.tabs .tab.on { background: rgba(255,255,255,.25); opacity: 1; font-weight: 500; }
.app > rzp-headcount { min-height: 0; }
header .dirty { font-size: 12px; opacity: .9; }
header.edit { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
header.edit h1 { font-size: 18px; }
header.edit h1 b { font-weight: 500; }
header .ibtn { background: none; border: 0; color: inherit; font-size: 20px; cursor: pointer; padding: 4px 8px; border-radius: 50%; }
header .ibtn:disabled { opacity: .4; cursor: default; }
header .ibtn:hover:not(:disabled) { background: rgba(127,127,127,.15); }
header .pill-btn { border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); color: var(--primary-color, #03a9f4);
  border-radius: 18px; padding: 5px 14px; cursor: pointer; font: inherit; font-weight: 500; }
header.edit .text-btn { background: none; border: 0; color: inherit; font: inherit; font-weight: 500; padding: 6px 12px; cursor: pointer; }
header.edit .save-btn { background: #fff; color: var(--primary-color, #03a9f4); border: 0; border-radius: 18px; padding: 6px 16px; font: inherit; font-weight: 600; cursor: pointer; }
header.edit .save-btn:disabled { opacity: .6; cursor: default; }
.menu-pop { position: fixed; z-index: 20; min-width: 220px; background: var(--card-background-color, #fff); color: var(--primary-text-color, #222);
  border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.25); padding: 6px 0; }
.menu-pop button { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 9px 16px; font: inherit; color: inherit; cursor: pointer; }
.menu-pop button:hover { background: var(--secondary-background-color, #f0f0f0); }
.at-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; }
.at-row .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.at-row .st { color: var(--secondary-text-color, #777); font-size: 12px; }
.at-row .st.on { color: var(--primary-text-color, #222); font-weight: 500; }
.fit-btn { position: absolute; right: 12px; top: 10px; border: 0; border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 16px;
  background: var(--card-background-color, #fff); color: var(--primary-text-color, #222); box-shadow: 0 1px 3px rgba(0,0,0,.2); }
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
.guide.section { background: #fff8e1; border-left: 3px solid #f9a825; }
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
.frames tr.peer { background: rgba(126,87,194,.06); }
.frames td.in { color: #43a047; font-weight: 600; }
.frames td.ex { color: ${EXCLUDE_COLOR}; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #323232; color: #fff; padding: 10px 16px; border-radius: 4px; z-index: 10; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
.toast.error { background: var(--error-color, #c62828); }
.empty { padding: 40px; text-align: center; color: var(--secondary-text-color, #666); line-height: 1.6; }
.loading { position: absolute; right: 12px; top: 8px; font-size: 12px; color: var(--secondary-text-color, #666); background: var(--card-background-color, #fff); padding: 2px 8px; border-radius: 10px; }
.spot-row { padding: 6px; border-radius: 6px; margin: 0 -6px; }
.spot-row:hover { background: var(--secondary-background-color, #f2f2f2); }
.spot-head { display: flex; gap: 8px; align-items: baseline; }
.spot-head .badge { margin-left: auto; }
.check { display: flex; gap: 6px; align-items: flex-start; font-size: 13px; }
.check input { width: auto; margin-top: 2px; }
.trail { margin-top: 10px; }
.plot-wrap { position: relative; flex: 1; display: flex; min-height: 0; }
.bar-pop { position: fixed; z-index: 20; width: 330px; background: var(--card-background-color, #fff); color: var(--primary-text-color, #222);
  border-radius: 10px; box-shadow: 0 4px 18px rgba(0,0,0,.25); padding: 12px 14px; font-size: 13px; }
.bar-pop .bp-h { font-weight: 500; margin-bottom: 4px; }
.bar-pop .bp-say { color: var(--secondary-text-color, #555); line-height: 1.4; margin-bottom: 10px; }
.bar-pop .bp-acts { display: flex; flex-wrap: wrap; gap: 6px; }
.pchip { font: inherit; font-size: 12px; border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); color: var(--primary-color, #03a9f4);
  border-radius: 14px; padding: 4px 10px; cursor: pointer; }
.legend { position: absolute; right: 12px; bottom: 10px; display: flex; gap: 10px; padding: 4px 10px; border-radius: 14px; font-size: 12px;
  background: var(--card-background-color, #fff); box-shadow: 0 1px 3px rgba(0,0,0,.15); color: var(--primary-text-color, #222); pointer-events: none; }
.legend .chip { display: flex; align-items: center; gap: 4px; }
.legend .sw { width: 10px; height: 10px; border-radius: 2px; }
input.density { width: 80px; vertical-align: middle; }
`;

class RadarZonePresencePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._started = false;
    this.radars = [];
    this.unconfigured = [];
    this.radarId = null;
    this.config = null;
    this.units = makeUnits('in');
    this.zones = [];
    this.saved = '[]';
    this.settings = { reconnect_grace_s: 0, display: normalizeDisplay() };
    this.savedSettings = JSON.stringify(this.settings);
    this.undoStack = [];
    this.redoStack = [];
    this.selectedId = null;
    this.selectedVertex = null;
    this.tool = 'select';
    this.drawKind = 'include';
    this.snap = { angle: true, grid: false, vertex: true, gridStep: 50.8 };
    this.showMeasurements = true;
    this.colorMode = 3; // 3: detections in ink, ignored ones hollow; 0 by track, 1 selected shape, 2 by age
    this.detOpacity = Number(localStorage.getItem('rzp.detOpacity')) || 1;
    this.rangeS = 900; // the room view opens on the last 15 minutes
    this.details = localStorage.getItem('rzp.details') === '1'; // per user (HA user data); technical detail, off by default
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
    this.showContext = true;
    this.live = true;
    this.liveTargets = [];
    this.liveTrails = new Map();
    this.liveStates = {};
    this.doors = {}; // door contact entity -> {rows: [[t, state]], events, pos}
    this.peers = new Map(); // other radars: radar_id -> {title, cfg, live}
    this.showPeers = false; // other radars' views: dashed outlines, for lining up (their coverage always lightens the room fill)
    this._peerUnsubs = [];
    this.livePresence = false;
    this.preferLive = true; // open in live playback; false once the user picks the plain point cloud
    this.windowEnd = 'now'; // the loaded window ends at "now" and keeps growing (absolute ends: future time picker)
    this._nowTimer = 0;
    this.brush = null;
    this._unsubLive = null;
    this._previewTimer = 0;
    this._loadingHistory = false;
    this.spots = null; // dwell-spot suggestions from the loaded history
    this.spotMargin = null; // mm, signed; null = unit default (12 in / 30 cm)
    this.hoverSpot = null;
    this.showSpots = true;
    this.fitPreview = null; // polygon previewed by hovering 'Fit to points'
    this.tab = 'radars'; // 'radars' | 'headcount'
    this.editing = false; // review (default) or edit: tools, property panel, undo, Save / Cancel
  }

  set hass(hass) {
    this._hass = hass;
    if (this.hcEl) this.hcEl.hass = hass;
    if (!this._started) { this._started = true; this._start(); }
    else if (this.config) { this._refreshLiveBadges(); this._updateDoorStates(); }
  }
  get hass() { return this._hass; }

  /** People who aren't admins get the panel read-only: review only, no Edit, suggestions, Details or setup. */
  get admin() { return this._hass?.user?.is_admin !== false; }

  set narrow(v) { this.toggleAttribute('narrow', !!v); this.hcEl?.toggleAttribute('narrow', !!v); }
  set panel(p) { this._panel = p; }

  disconnectedCallback() {
    this.hcEl?.deactivate();
    this._unsubscribeLive();
    this._stopNowTimer();
    this.playing = false;
    window.removeEventListener('keydown', this._keyHandler);
    window.removeEventListener('location-changed', this._hashHandler);
    window.removeEventListener('hashchange', this._hashHandler);
  }

  connectedCallback() {
    this._keyHandler = this._keyHandler || (e => this._onKey(e));
    window.addEventListener('keydown', this._keyHandler);
    // "Visit" on a zone device links to #radar=...&zone=...; HA keeps this element
    // alive between visits, so follow the hash whenever HA navigates here.
    this._hashHandler = this._hashHandler || (() => { if (location.pathname.endsWith(`/${PANEL_PATH}`)) this._applyHash(); });
    window.addEventListener('location-changed', this._hashHandler);
    window.addEventListener('hashchange', this._hashHandler);
    if (this.radars) this._applyHash();
    if (this.hist) this._startNowTimer();
  }

  // ----------------------------------------------------------- bootstrap

  async _start() {
    if (!this.admin) this.details = false;
    this._buildShell();
    if (this.admin) this.hass.callWS({ type: 'frontend/get_user_data', key: 'radar_presence' })
      .then(r => { if (r?.value && 'details' in r.value && !!r.value.details !== this.details) this._setDetails(!!r.value.details, false); })
      .catch(() => {});
    await this._loadRadars();
    const q0 = new URLSearchParams(location.hash.slice(1));
    if (q0.get('view') === 'headcount') {
      await this._setTab('headcount');
      if (q0.get('t')) this.hcEl.showTime(+q0.get('t'), +q0.get('span') || 600);
      return;
    }
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('radar');
    if (!fromHash && this.home && this.radars.length) { await this._setTab('headcount'); return; } // the House is the home screen
    const stored = localStorage.getItem('rzp.radar');
    const pick = [fromHash, stored].find(id => this.radars.some(r => r.radar_id === id)) || this.radars[0]?.radar_id;
    if (pick) {
      const q = new URLSearchParams(location.hash.slice(1)); // before the hash is rewritten
      const zoneId = q.get('zone'), at = this._rangeFor(q.get('t'));
      await this._selectRadar(pick);
      if (zoneId && this.zones.some(z => z.id === zoneId)) this._select(zoneId, null);
      if (at != null) this._showTime(at, +q.get('span') || 600);
    }
    else this._renderEmpty();
  }

  async _applyHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    if (q.get('view') === 'headcount') {
      await this._setTab('headcount');
      if (q.get('t')) this.hcEl.showTime(+q.get('t'), +q.get('span') || 600);
      return;
    }
    const entry = q.get('radar'), zone = q.get('zone');
    if (!entry || !this.radars?.some(r => r.radar_id === entry)) return;
    const range = this.rangeS, at = this._rangeFor(q.get('t'));
    if (entry !== this.radarId) await this._selectRadar(entry);
    else if (at != null && this.rangeS !== range) { this._renderHeader(); await this._loadHistory(); }
    if (zone && this.zones.some(z => z.id === zone)) this._select(zone, null);
    if (at != null) this._showTime(at, +q.get('span') || 600);
  }

  /** Deep link `#radar=…&t=<epoch s>`: pick the shortest history range that holds t. Returns t, or null. */
  _rangeFor(tParam) {
    const t = Number(tParam);
    if (!tParam || !Number.isFinite(t)) return null;
    const ago = Date.now() / 1000 - t;
    this.rangeS = (RANGES.find(([, s]) => s >= ago + 600) || RANGES[RANGES.length - 1])[1];
    return t;
  }

  /** Replay at t, the timeline zoomed to `span` seconds around it. */
  _showTime(t, span = 600) {
    if (!this.hist) return;
    this.preferLive = false;
    this.timeline.focus(t - span / 2, t + span / 2);
    this._seek(t);
  }

  /** From the head count log: this radar's view, replaying the moment `t` (a minute around it). */
  async _openRadarAt(radarId, t, span = 60) {
    if (!this.radars?.some(r => r.radar_id === radarId)) return;
    await this._setTab('radars', { pick: false });
    const range = this.rangeS;
    this._rangeFor(String(t));
    if (radarId !== this.radarId) await this._selectRadar(radarId);
    else if (this.rangeS !== range || !this.hist || t < this.hist.start) { this._renderHeader(); await this._loadHistory(); }
    this._showTime(t, span);
    history.replaceState(null, '', `#radar=${radarId}&t=${t.toFixed(1)}&span=${span}`);
  }

  /** Switch between the radar editor and the head count view. */
  async _setTab(tab, { pick = true } = {}) {
    if (tab === this.tab && (tab !== 'headcount' || this.hcEl._active)) return;
    this.tab = tab;
    const hc = tab === 'headcount';
    this.bodyEl.style.display = hc ? 'none' : '';
    this.hcEl.style.display = hc ? '' : 'none';
    this._renderHeader();
    if (hc) {
      history.replaceState(null, '', '#view=headcount');
      await this.hcEl.activate();
    } else {
      this.hcEl.deactivate();
      if (this.radarId) history.replaceState(null, '', `#radar=${this.radarId}`);
      else if (pick && this.radars.length) await this._selectRadar(this.radars[0].radar_id);
    }
  }

  async _copyHeadcountLink() {
    const q = new URLSearchParams(this.hcEl.linkParams());
    const url = `${location.origin}${location.pathname}#${q}`;
    try {
      await navigator.clipboard.writeText(url);
      this._toast(`Link copied: ${fmtDateTime(+q.get('t'))}`);
    } catch {
      window.prompt('Copy this link', url);
    }
  }

  /** Copy a link to this radar, cursor and timeline zoom (`#radar=…&t=…&span=…[&zone=…]`). */
  async _copyLink() {
    const v = this.timeline?.view;
    const t = this.cursor ?? (v ? (v.v0 + v.v1) / 2 : this.hist.end);
    const q = new URLSearchParams({ radar: this.radarId, t: t.toFixed(1) });
    if (v) q.set('span', Math.round(v.v1 - v.v0));
    if (this.selectedId) q.set('zone', this.selectedId);
    const url = `${location.origin}${location.pathname}#${q}`;
    try {
      await navigator.clipboard.writeText(url);
      this._toast(`Link copied: ${fmtDateTime(t)}`);
    } catch {
      window.prompt('Copy this link', url); // no clipboard outside https / localhost
    }
  }

  async _loadRadars() {
    const res = await this.hass.callWS({ type: `${DOMAIN}/list` });
    this.home = res.home;
    this.radars = res.radars;
    this.unconfigured = res.unconfigured;
    this._renderHeader();
  }

  async _selectRadar(radarId) {
    if (this._dirty() && !confirm('Discard unsaved changes?')) { this._renderHeader(); return; }
    this.radarId = radarId;
    localStorage.setItem('rzp.radar', radarId);
    history.replaceState(null, '', `#radar=${radarId}`);
    this.selectedId = null;
    this.selectedVertex = null;
    this._stopNowTimer();
    this.mode = 'cloud';
    this.cursor = null;
    this.playing = false;
    this.brush = null;
    this.undoStack = [];
    this.redoStack = [];
    await this._loadConfig();
    this._subscribeLive();
    this._loadPeers();
    await this._loadHistory();
  }

  async _loadConfig() {
    const cfg = await this.hass.callWS({ type: `${DOMAIN}/config`, radar_id: this.radarId });
    this.config = cfg;
    this.units = makeUnits(cfg.target_unit, this.hass);
    this.snap.gridStep = this.units.snapSteps[1];
    this.zones = cfg.zones.map(z => this._editable(z));
    this.saved = JSON.stringify(this.zones);
    this.settings = {
      reconnect_grace_s: cfg.settings.reconnect_grace_s || 0,
      display: normalizeDisplay(cfg.settings.display || {}, { upsideDown: cfg.device_mounting?.upside_down }),
      headcount: cfg.settings.headcount !== false,
    };
    this.savedSettings = JSON.stringify(this.settings);
    this._renderAll();
    this.plot.fit();
  }

  _editable(z) {
    return {
      id: z.id, name: z.name, kind: z.kind, polygon: z.polygon.map(p => [p[0], p[1]]),
      filters: { on_delay_s: 0, off_delay_s: 0, edge_margin_mm: 0, hold_until_exit: false, hold_max_s: 0, ...(z.filters || {}) },
      area_id: z.area_id ?? z.registry_area_id ?? null,
      door_entity_id: z.door_entity_id ?? null,
      door: z.door ?? null,
      leads_to: Array.isArray(z.leads_to) ? [...z.leads_to] : [],
      spot: z.kind === 'include' && !!z.spot, // a spot with its own occupancy sensor
    };
  }

  // ---------------------------------------------------------------- live

  _unsubscribeLive() {
    if (this._unsubLive) { this._unsubLive.then(u => u()).catch(() => {}); this._unsubLive = null; }
    for (const u of this._peerUnsubs) u.then(f => f()).catch(() => {});
    this._peerUnsubs = [];
  }

  // ------------------------------------------------------- other radars

  /** Configs of the other radars; live frames of those connected to this one through alignments. */
  async _loadPeers() {
    const radarId = this.radarId;
    const others = this.radars.filter(r => r.radar_id !== radarId);
    const cfgs = await Promise.all(others.map(r => this.hass.callWS({ type: `${DOMAIN}/config`, radar_id: r.radar_id }).catch(() => null)));
    if (radarId !== this.radarId) return;
    this.peers = new Map();
    others.forEach((r, i) => { if (cfgs[i]) this.peers.set(r.radar_id, { title: r.title, cfg: cfgs[i], live: [] }); });
    for (const u of this._peerUnsubs) u.then(f => f()).catch(() => {});
    this._peerUnsubs = [];
    for (const id of this._peerTransforms().keys()) {
      const sub = this.hass.connection.subscribeMessage(ev => {
        const peer = this.peers.get(id);
        if (!peer || ev.closed || !ev.targets || radarId !== this.radarId) return;
        peer.live = ev.targets;
        const h = this.peerHist?.get(id);
        if (h && ev.t - h.start > (h.frame_t[h.frame_t.length - 1] ?? -1)) {
          h.frame_t.push(ev.t - h.start);
          h.frame_n.push(ev.targets.length);
          h.frame_available?.push(ev.available === false ? 0 : 1);
          for (const [slot, x, y] of ev.targets) { h.slot.push(slot); h.x.push(x); h.y.push(y); }
        }
        if (this.showPeers && this.mode !== 'replay') this._updatePlot();
      }, { type: `${DOMAIN}/frames/subscribe`, radar_id: id });
      sub.catch(() => {});
      this._peerUnsubs.push(sub);
    }
    this._renderToolbar();
    this._updatePlot();
    if (this.peerHist?.size) this._recomputePreview();
  }

  _peerTransforms() {
    const radars = [{ radar_id: this.radarId, aligned_to: this.settings.display.aligned_to },
      ...[...this.peers].map(([id, p]) => ({ radar_id: id, aligned_to: p.cfg.settings?.display?.aligned_to }))];
    return radarTransforms(this.radarId, radars);
  }

  /** Other aligned radars drawn in this radar's frame: field of view, zones, live targets. */
  _peerOverlays() {
    if (!this.showPeers || !this.peers.size) return [];
    const COLORS = ['#7e57c2', '#26a69a', '#ef6c00', '#5c6bc0', '#c2185b'];
    const out = [];
    let i = 0;
    for (const [id, T] of this._peerTransforms()) {
      const peer = this.peers.get(id);
      if (!peer) continue;
      const map = poly => poly.map(p => affineApply(T, p));
      const fov = peer.cfg.fov;
      out.push({
        title: peer.title.replace(/^(Everything Presence Lite|Human Sensor 2A)\s*/, ''), color: COLORS[i++ % COLORS.length],
        origin: affineApply(T, [0, 0]),
        fov: map(fovPolygon(fov.max_distance_mm, fov.half_angle_deg, 16)),
        zones: peer.cfg.zones.filter(z => z.kind !== 'exclude').map(z => ({ name: z.name, kind: z.kind, polygon: map(z.polygon) })),
        ...(this.mode === 'replay' ? this._peerReplay(id, T) : { targets: (peer.live || []).map(([, x, y]) => affineApply(T, [x, y])), trail: [] }),
      });
    }
    return out;
  }

  /** A peer's frame index at absolute time t (last frame at or before it; -1 if none), and its targets' offsets. */
  _peerFrames(hist, t) {
    const n = hist.frame_n.length;
    if (hist._starts?.length !== n + 1) { // (the history grows while live)
      const st = new Int32Array(n + 1);
      for (let i = 0; i < n; i++) st[i + 1] = st[i] + hist.frame_n[i];
      hist._starts = st;
    }
    const ft = hist.frame_t, tRel = t - hist.start;
    let lo = 0, hi = n - 1, i = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ft[mid] <= tRel) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    return { i, starts: hist._starts };
  }

  /** What an aligned radar saw at the replay cursor (in this radar's frame): its targets now and its trail. */
  _peerReplay(id, T) {
    const hist = this.peerHist?.get(id);
    if (!hist || this.cursor == null) return { targets: [], trail: [] };
    const { i, starts } = this._peerFrames(hist, this.cursor);
    const at = k => affineApply(T, [hist.x[k], hist.y[k]]);
    const targets = [], trail = [];
    if (i >= 0 && this.cursor - hist.start - hist.frame_t[i] < 2) for (let k = starts[i]; k < starts[i + 1]; k++) targets.push(at(k));
    for (let j = i; j >= 0 && hist.frame_t[j] >= this.cursor - hist.start - this.trailSeconds && trail.length < 4000; j--) {
      for (let k = starts[j]; k < starts[j + 1]; k++) trail.push(at(k));
    }
    return { targets, trail };
  }

  _subscribeLive() {
    this._unsubscribeLive();
    this.liveTrails = new Map();
    this.liveTargets = [];
    const radarId = this.radarId;
    this._unsubLive = this.hass.connection.subscribeMessage(ev => {
      if (radarId !== this.radarId) return;
      if (ev.closed) {
        // Entry reloaded (zones saved): reconnect shortly.
        this._unsubLive = null;
        setTimeout(() => { if (radarId === this.radarId) { this._loadConfigKeepView(); this._subscribeLive(); } }, 800);
        return;
      }
      this._onLiveFrame(ev);
    }, { type: `${DOMAIN}/frames/subscribe`, radar_id: radarId });
    this._unsubLive.catch(err => this._toast(`Live updates failed: ${err.message || err.code}`, true));
  }

  async _loadConfigKeepView() {
    const cfg = await this.hass.callWS({ type: `${DOMAIN}/config`, radar_id: this.radarId });
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
    this.liveStates = Object.fromEntries(Object.entries(ev.zones).map(([k, v]) => [k, v[0]]));
    this.livePresence = !!ev.presence;
    if (!ev.targets) { // only zone states changed (another radar of the group, or a delay ran out)
      if (this.mode !== 'replay') this._updatePlot();
      this._renderLiveBadges();
      return;
    }
    this.liveTargets = ev.targets;
    this._appendLiveFrame(ev);
    for (const [slot, x, y] of ev.targets) {
      if (!this.liveTrails.has(slot)) this.liveTrails.set(slot, []);
      this.liveTrails.get(slot).push({ x, y, t: now });
    }
    for (const [slot, pts] of this.liveTrails) {
      while (pts.length && pts[0].t < now - this.trailSeconds) pts.shift();
      if (!pts.length) this.liveTrails.delete(slot);
    }
    if (this.mode === 'cloud') this._updatePlot();
    else if (this.mode === 'live') {
      this.cursor = Math.max(this.cursor ?? now, now);
      this._updatePlot();
      this._renderFramesThrottled();
    }
    this._renderLiveBadges();
  }

  /** Grow the loaded history with live frames, so live playback can be paused and scrubbed back. */
  _appendLiveFrame(ev) {
    const h = this.hist;
    if (!h || !this.frameIdx) return;
    const tRel = ev.t - h.start;
    if (h.frame_t.length && tRel <= h.frame_t[h.frame_t.length - 1]) return;
    h.frame_t.push(tRel);
    h.frame_n.push(ev.targets.length);
    h.frame_available?.push(ev.available === false ? 0 : 1);
    for (const [slot, x, y] of ev.targets) { h.slot.push(slot); h.x.push(x); h.y.push(y); }
    this.frameIdx.frameStart.push(h.x.length);
    h.end = Math.max(h.end, ev.t);
    this._cloudDirty = true;
    this._histGrew = true;
  }

  // ---------------------------------------------------------------- live

  /** Live playback: the playhead follows now; pause or seek to drop into replay. */
  _goLive({ width = null } = {}) {
    if (!this.hist) return;
    this.preferLive = true;
    this.playing = false;
    this.mode = 'live';
    this._tick();
    const v = this.timeline.view;
    const w = width ?? (v ? v.v1 - v.v0 : 900);
    this.timeline.focus(this.cursor - w, this.cursor);
    this._updatePlot();
    this._renderTransport();
    this._renderFrames();
  }

  // While the window ends at "now", a 1 s ticker grows it to the right in every
  // mode (live, replay, point cloud) and drops data that slides off the left.
  _startNowTimer() {
    this._stopNowTimer();
    if (this.windowEnd === 'now' && this.hist) this._nowTimer = setInterval(() => this._tick(), 1000);
  }

  _stopNowTimer() {
    clearInterval(this._nowTimer);
    this._nowTimer = 0;
  }

  _tick() {
    const h = this.hist;
    if (!h || this.windowEnd !== 'now') return;
    const now = Date.now() / 1000;
    const prevEnd = h.end;
    h.end = Math.max(h.end, now);
    // A trim that reaches the end keeps reaching it.
    if (this.brush && this.brush.t1 >= prevEnd - 1) this.brush = { ...this.brush, t1: h.end };
    // Recorded bands: extend what is on now.
    const states = { ...this.liveStates, presence: this.livePresence };
    for (const [zid, on] of Object.entries(states)) {
      if (!on) continue;
      const iv = (this.actual[zid] ||= []);
      const last = iv[iv.length - 1];
      if (last && last[1] >= (this._lastTick ?? now) - 1.5) last[1] = now;
      else iv.push([now, now]);
    }
    this._lastTick = now;
    this._trimLeft(now);
    if (this._cloudDirty && now - (this._cloudAt || 0) > 10) {
      this._cloudAt = now;
      this._cloudDirty = false;
      this._uploadCloud();
    }
    if (this.mode === 'live') {
      this.cursor = h.end;
      this._updateReplayLabel();
      this._updatePlot(); // age the trails
      this._renderFramesThrottled();
    }
    this._renderTimeline();
  }

  /** Keep the window at "last <range>": drop frames older than that, in batches. */
  _trimLeft(now) {
    const h = this.hist;
    const keepFrom = now - this.rangeS;
    const excess = keepFrom - h.start;
    if (excess < Math.max(60, this.rangeS / 100)) return;
    const ft = h.frame_t;
    let lo = 0, hi = ft.length; // first frame at or after keepFrom
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ft[mid] < excess) lo = mid + 1; else hi = mid; }
    const m = this.frameIdx.frameStart[lo];
    ft.splice(0, lo);
    h.frame_n.splice(0, lo);
    h.frame_available?.splice(0, lo);
    h.slot.splice(0, m);
    h.x.splice(0, m);
    h.y.splice(0, m);
    for (let i = 0; i < ft.length; i++) ft[i] -= excess;
    h.start = keepFrom;
    if (this.cursor != null && this.cursor < h.start) this.cursor = h.start;
    if (this.brush) {
      const t0 = Math.max(this.brush.t0, h.start);
      this.brush = this.brush.t1 - t0 >= 1 ? { ...this.brush, t0 } : null;
    }
    for (const iv of Object.values(this.actual)) while (iv.length && iv[0][1] < h.start) iv.shift();
    this._cloudDirty = false;
    this._uploadCloud();
    this._recomputePreview(true); // per-frame results are indexed by frame
  }

  _renderFramesThrottled() {
    if (!this.showFrames) return;
    const t = performance.now();
    if (t - (this._framesAt || 0) > 250) { this._framesAt = t; this._renderFrames(); }
  }

  // ------------------------------------------------------------- history

  async _loadHistory() {
    if (!this.radarId) return;
    this._stopNowTimer();
    this._loadingHistory = true;
    this._renderLoading();
    const end = new Date();
    const start = new Date(end.getTime() - this.rangeS * 1000);
    try {
      const range = { start: start.toISOString(), end: end.toISOString() };
      // Radars aligned with this one evaluate its zones too: the preview needs their frames.
      const groupPeers = (this.config?.group?.members || []).filter(id => id !== this.radarId);
      const [hist, events, ...peerHists] = await Promise.all([
        this.hass.callWS({ type: `${DOMAIN}/frames/history`, radar_id: this.radarId, ...range }),
        this.hass.callWS({ type: `${DOMAIN}/zone_events`, radar_id: this.radarId, ...range }),
        ...groupPeers.map(id => this.hass.callWS({ type: `${DOMAIN}/frames/history`, radar_id: id, ...range }).catch(() => null)),
      ]);
      this.peerHist = new Map(groupPeers.map((id, i) => [id, peerHists[i]]).filter(([, h]) => h));
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
    this._renderTransport(); // enable play/step now that history is loaded
    this._recomputePreview(true);
    if (this.hist) {
      this._lastTick = this.hist.end;
      this._startNowTimer();
      if (this.preferLive && this.mode === 'cloud') this._goLive({ width: 900 });
      this._loadDoors();
    }
  }

  _setHistory(hist) {
    this.hist = hist;
    this._resetTimelineView = true;
    this._uploadCloud();
    if (hist.truncated) this._toast('History truncated: pick a shorter range for the full point cloud.');
    this._renderStatus();
  }

  /** (Re)build the frame index and the WebGL point cloud from this.hist. */
  _uploadCloud() {
    const hist = this.hist;
    const nT = hist.x.length;
    const pos = new Float32Array(nT * 2);
    const t = new Float32Array(nT);
    const slot = new Float32Array(nT);
    // frameOf[k] = frame index of target k; frameStart[i] = first target index of frame i
    const nF = hist.frame_t.length;
    const frameStart = new Array(nF + 1);
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
    this.frameIdx = { frameStart, frameT: hist.frame_t };
    this.plot.setHistory({ pos, t, slot });
    this._updateFlags();
    this._renderStatus();
  }

  // ------------------------------------------------------------- preview

  _recomputePreview(immediate = false) {
    clearTimeout(this._previewTimer);
    const run = () => {
      if (!this.hist) { this.preview = null; this._renderTimeline(); this._renderSide(); return; }
      const zones = this.zones.filter(z => !validatePolygon(z.polygon));
      const peers = this._groupPeers();
      // Like the home: tracked (one radar or several aligned ones), then the zone engine.
      const replay = (zs, grace, opts) => replayGroup({ hist: this.hist, zones: zs }, peers, grace, opts);
      const res = replay(zones, this.settings.reconnect_grace_s, { perFrameStates: true });
      const keys = [...zones.filter(z => z.kind === 'include').map(z => z.id), 'presence'];
      // Same zones without filters, to show what the filters remove.
      const unfiltered = replay(zones.map(z => ({ ...z, filters: {} })), 0);
      this.preview = {
        radars: peers.length + 1,
        perFrame: res.perFrame,
        summary: summarize(res.transitions, keys, this.hist.start, this.hist.end),
        unfiltered: summarize(unfiltered.transitions, keys, this.hist.start, this.hist.end),
      };
      this._computeSpots();
      this._renderTimeline();
      this._renderSideStats();
      this._renderSpots();
      this._updateFlags();
      this._updatePlot();
    };
    if (immediate) run();
    else this._previewTimer = setTimeout(run, 150);
  }

  /** Aligned radars whose history is loaded, as replayGroup peers (frames, own exclusions/exits, transform into this frame). */
  _groupPeers() {
    if (!this.peerHist?.size || !this.peers?.size) return [];
    const T = this._peerTransforms();
    const out = [];
    for (const [id, hist] of this.peerHist) {
      const peer = this.peers.get(id);
      if (!peer || !T.has(id)) continue;
      const zones = peer.cfg.zones.filter(z => z.kind !== 'include' && !validatePolygon(z.polygon))
        .map(z => ({ ...z, filters: z.filters || {} }));
      out.push({ hist, zones, T: T.get(id) });
    }
    return out;
  }

  _updateFlags() {
    const sel = this.zones.find(z => z.id === this.selectedId);
    const excl = this.zones.filter(z => z.kind === 'exclude');
    this.plot.updateFlags(this.colorMode === 1 && sel && sel.kind !== 'exclude' ? sel : null, excl); // ignored detections are drawn hollow
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
    }
    // Zone states at the cursor, from the whole group (an aligned radar may be the one that saw someone).
    for (const k of Object.keys(this.preview?.summary || {})) states[k] = this._zoneOnAt(k, this.cursor);
    return { trails, targets, states, frame: i };
  }

  /** Was this zone (or 'presence') on at absolute time t in the replay preview? */
  _zoneOnAt(key, t) {
    const iv = this.preview?.summary?.[key]?.intervals || [];
    let lo = 0, hi = iv.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (iv[mid][1] <= t) lo = mid + 1;
      else if (iv[mid][0] > t) hi = mid - 1;
      else return true;
    }
    return false;
  }

  _seek(t) {
    if (!this.hist) return;
    if (this._cloudDirty) { this._cloudDirty = false; this._uploadCloud(); }
    if (this._histGrew) { this._histGrew = false; this._recomputePreview(); } // preview the frames that arrived live
    this.mode = 'replay';
    this.cursor = Math.max(this.hist.start, Math.min(this.hist.end, t));
    this._updatePlot();
    // Rebuilding the transport every animation frame would swallow clicks on
    // its buttons (the element under the pointer is replaced between mousedown
    // and mouseup), so only rebuild when mode / play state change.
    if (this._transportKey !== `${this.mode}|${this.playing}`) this._renderTransport();
    else this._updateReplayLabel();
    this.timeline.set({ cursor: this.cursor });
    if (this.showFrames) {
      const now = performance.now();
      if (!this.playing || now - (this._framesAt || 0) > 200) { this._framesAt = now; this._renderFrames(); }
    }
  }

  _replayLabelText() {
    if (this.mode === 'live') return `● Live ${fmtTime(this.cursor)}`;
    return `Replay ${fmtDateTime(this.cursor)}.${String(Math.floor((this.cursor % 1) * 1000)).padStart(3, '0')}`;
  }

  _updateReplayLabel() {
    const label = this.transport?.querySelector('.replay-label');
    if (label) label.textContent = this._replayLabelText();
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
    if (this.mode === 'live') { this._seek(this.cursor); return; } // pause = freeze at now
    if (this.playing) { this.playing = false; this._renderTransport(); return; }
    const t0 = this.brush ? this.brush.t0 : this.hist.start;
    const t1 = this.brush ? this.brush.t1 : this.hist.end;
    if (this.mode !== 'replay' || this.cursor < t0 || this.cursor >= t1 - 0.5) {
      this._seek(this.brush ? t0 : Math.max(this.hist.start, this.hist.end - 600));
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
      const stopAt = this.brush ? this.brush.t1 : this.hist.end;
      if (next >= stopAt && !this.brush && this.speed <= 1) { this._goLive(); return; } // caught up with now
      if (next >= stopAt) { next = stopAt; this.playing = false; }
      this._seek(next); // re-renders the transport when playing flipped to false
      if (this.playing) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _stepFrame(dir) {
    if (!this.hist) return;
    const tRel = (this.cursor ?? (this.brush ? this.brush.t1 : this.hist.end)) - this.hist.start;
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
    if (!this.editing) this._enterEdit(); // a change (a suggestion taken, a fix) is reviewed and saved in edit mode
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

  _addZone(polygon, kind = 'include', name = null, filters = {}, { door_entity_id = null } = {}) {
    const n = this.zones.filter(z => z.kind === kind).length + 1;
    const zone = {
      door_entity_id,
      id: newZoneId(), name: name || ({ exclude: `Ignore ${n}`, exit: `Doorway ${n}`, linger: `Spot ${n}`, transient: `Walkway ${n}` }[kind] || `Room ${n}`), kind,
      polygon: polygon.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]),
      filters: { on_delay_s: 0, off_delay_s: 0, edge_margin_mm: 0, hold_until_exit: false, hold_max_s: 0, ...filters }, area_id: null,
    };
    const prev = JSON.stringify(this.zones);
    this.selectedId = zone.id;
    this.selectedVertex = null;
    this._setZones([...this.zones, zone], { prev });
    this._renderSide();
    this._updateFlags();
  }

  /** The radar's own (firmware) exclusion zones: it still reports targets inside them, so offer them as ours. */
  _firmwareSection() {
    const fw = (this.config?.device_zones || []).filter(z => z.kind === 'exclude');
    if (!fw.length) return '';
    const same = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1 && Math.abs(p[1] - b[i][1]) < 1);
    return el('div', { class: 'section' },
      el('h3', {}, 'Zones saved on the radar'),
      el('div', { class: 'help' }, 'Saved on the radar itself. The radar still reports detections inside them, so they have no effect here until imported as ignore areas. After that only your shapes count; later changes on the device are ignored.'),
      fw.map(z => {
        const imported = this.zones.some(q => q.kind === 'exclude' && same(q.polygon, z.polygon));
        const [[x0, y0], , [x1, y1]] = z.polygon;
        return el('div', { class: 'zone-row' },
          el('div', { class: 'swatch', style: { background: EXCLUDE_COLOR, opacity: 0.6 } }),
          el('div', {}, el('div', { class: 'zone-name' }, z.key), el('div', { class: 'zone-meta' },
            `${this.units.fmtLong(Math.abs(x1 - x0))} × ${this.units.fmtLong(Math.abs(y1 - y0))}${z.enabled === false ? ' · switched off on the device' : ''}`)),
          imported ? el('span', { class: 'badge' }, 'imported')
            : el('button', { class: 'btn', title: 'Add as an ignore area (then Save)', onclick: e => { e.stopPropagation(); this._addZone(z.polygon, 'exclude', `${z.key} (from the radar)`); } }, 'Import'));
      }));
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
    this._linkedSel = null;
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
      if (!z.name.trim()) { this._toast('Every shape needs a name', true); this._select(z.id, null); return; }
    }
    try {
      const res = await this.hass.callWS({
        type: `${DOMAIN}/zones/save`, radar_id: this.radarId, zones: this.zones,
        settings: { reconnect_grace_s: Number(this.settings.reconnect_grace_s) || 0, display: this.settings.display, headcount: this.settings.headcount !== false },
      });
      this.zones = res.zones.map(z => this._editable(z));
      this.saved = JSON.stringify(this.zones);
      this.savedSettings = JSON.stringify(this.settings);
      this._toast('Saved');
      this.editing = false;
      this.tool = 'select';
      this._renderToolbar();
      this._updatePlot();
      this._renderStatus();
      this._renderHeader();
      this._renderSide();
      await this._loadRadars();
    } catch (err) {
      this._toast(`Save failed: ${err.message || err.code}`, true);
    }
  }

  _exportZones() {
    const doc = exportZones(this.config, this.zones, this.settings);
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' }));
    const a = el('a', { href: url, download: exportFilename(this.config) });
    this.shadowRoot.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  _importZones() {
    const input = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (file) this._applyImport(await file.text());
    });
    this.shadowRoot.appendChild(input);
    input.click();
  }

  /** Merge an export into the draft (unsaved). Exposed for testing as panel._applyImport(text). */
  _applyImport(text) {
    let doc;
    try { doc = parseImport(text); } catch (err) { this._toast(`Import failed: ${err.message}`, true); return; }
    if (doc.radar.title && doc.radar.title !== this.config.title
      && !confirm(`This file was exported from "${doc.radar.title}". Import its shapes into "${this.config.title}" anyway?`)) return;
    const { zones, replaced, added } = mergeZones(this.zones, doc.zones, { areaIds: new Set(Object.keys(this.hass.areas || {})) });
    if (doc.settings.reconnect_grace_s !== undefined) this.settings = { ...this.settings, reconnect_grace_s: doc.settings.reconnect_grace_s };
    this.selectedId = null;
    this.selectedVertex = null;
    this._setZones(zones);
    this._renderSide();
    this._toast(`Imported ${added} new and ${replaced} replaced shape(s). Review, then Save.`);
  }

  _enterEdit() {
    if (this.editing || !this.config || !this.admin) return;
    this.editing = true;
    this._renderHeader();
    this._renderToolbar();
    this._renderSide();
    this._renderStatus();
    this._updatePlot();
  }

  /** Cancel: back to review, dropping unsaved changes (after asking). */
  _cancelEdit() {
    if (this._dirty()) { this._revert(); if (this._dirty()) return; }
    this.editing = false;
    this.tool = 'select';
    this.plot.cancelDraft();
    this._renderHeader();
    this._renderToolbar();
    this._renderSide();
    this._renderStatus();
    this._updatePlot();
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
    if (inInput || e.defaultPrevented) return; // e.g. the plot used the arrows to nudge a vertex
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && this.hist && !mod) {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      this.playing = false;
      // ←/→ jump 10 s, Shift+←/→ jump 1 min (frame steps: , and .)
      this._seek((this.cursor ?? (this.brush ? this.brush.t1 : this.hist.end)) + dir * (e.shiftKey ? 60 : 10));
      return;
    }
    if (mod && e.key.toLowerCase() === 'z' && this.editing) { e.preventDefault(); e.shiftKey ? this._redo() : this._undo(); return; }
    if (mod && e.key.toLowerCase() === 'y' && this.editing) { e.preventDefault(); this._redo(); return; }
    if (mod) return;
    const k = e.key.toLowerCase();
    if (this.tab !== 'radars') return;
    if (k === 'e' && !this.editing) this._enterEdit();
    else if (this.editing && k === 'v') this._setTool('select');
    else if (this.editing && k === 'd') this._setTool('draw');
    else if (this.editing && k === 'r') this._setTool('rect');
    else if (this.editing && k === 'm') this._setTool('measure');
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
    this.legendEl = el('div', { class: 'legend', style: { display: 'none' } });
    this.transport = el('div', { class: 'transport' });
    this.timeline = document.createElement('rzp-timeline');
    this.framesEl = el('div', { class: 'frames', style: { display: 'none' } });
    this.statusEl = el('div', { class: 'status' });
    this.side = el('div', { class: 'side' });
    const main = el('div', { class: 'main' },
      this.toolbar,
      el('div', { class: 'plot-wrap' }, this.plot, this.loadingEl, this.legendEl, el('button', { class: 'fit-btn', title: 'Fit the view (F)', onclick: () => this.plot.fit() }, '⤢')),
      this.transport,
      el('div', { class: 'timeline-wrap' }, this.timeline),
      this.framesEl,
      this.statusEl);
    this.bodyEl = el('div', { class: 'body' }, main, this.side);
    this.hcEl = document.createElement('rzp-headcount');
    this.hcEl.hass = this._hass;
    this.hcEl.details = this.details;
    this.hcEl.admin = this.admin;
    this.hcEl.style.display = 'none';
    this.hcEl.addEventListener('open-radar', e => this._openRadarAt(e.detail.radar, e.detail.t));
    this.hcEl.addEventListener('report', e => this._report(e.detail.t, e.detail.symptom));
    root.append(el('div', { class: 'app' }, this.header, this.bodyEl, this.hcEl));

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
    this.plot.addEventListener('linked', e => this._openLinked(e.detail.radarId, e.detail.zoneId));
    this.plot.addEventListener('zone-drawn', e => { this._addZone(e.detail.polygon, e.detail.kind); this._setTool('select'); });
    this.plot.addEventListener('tool', e => this._setTool(e.detail.tool));
    this.plot.addEventListener('pointer-world', e => { this._pointer = e.detail; this._renderPointer(); });
    this.timeline.addEventListener('seek', e => { this.playing = false; this._seek(e.detail.t); });
    this.timeline.addEventListener('trigger', e => this._jumpTo(e.detail.t, e.detail.zoneId));
    this.timeline.addEventListener('bar', e => this._barPopover(e.detail));
    this.timeline.addEventListener('window', e => {
      const had = !!this.brush;
      this.brush = e.detail.brush;
      this._scheduleAnalysis();
      this._updatePlot();
      if (had !== !!this.brush) this._renderTransport();
    });
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
      this.home
        ? el('p', {}, 'Add one on the Radar Presence integration page: Add radar.')
        : el('p', {}, 'Set up the integration under Settings → Devices & services → Add integration → Radar Presence; it then asks for the first radar.'),
      el('a', { href: this.home ? '/config/integrations/integration/radar_zone_presence' : '/config/integrations/dashboard/add?domain=radar_zone_presence', class: 'btn primary' },
        this.home ? 'Add radar' : 'Set up')));
  }

  _renderHeader() {
    const h = this.header;
    if (!h) return;
    const dirty = this._dirty();
    // Radars grouped by HA floor (highest level first, like HA's own area lists), then floorless.
    const floors = new Map();
    for (const r of this.radars) {
      const key = r.floor_id || '';
      if (!floors.has(key)) floors.set(key, { name: r.floor || 'No floor', level: r.floor_level ?? -Infinity, radars: [] });
      floors.get(key).radars.push(r);
    }
    const option = r => el('option', { value: r.radar_id, selected: r.radar_id === this.radarId }, `${r.title}${r.area ? ` · ${r.area}` : ''}`);
    const grouped = [...floors.values()].sort((a, b) => b.level - a.level);
    const sel = el('select', { onchange: e => this._selectRadar(e.target.value), title: 'Radar sensor' },
      grouped.length > 1 || grouped[0]?.name !== 'No floor'
        ? grouped.map(f => el('optgroup', { label: f.name }, f.radars.map(option)))
        : this.radars.map(option));
    const range = el('select', { onchange: e => { this.rangeS = +e.target.value; this._exitReplay(); this._loadHistory(); }, title: 'History range' },
      RANGES.map(([label, s]) => el('option', { value: s, selected: s === this.rangeS }, `Last ${label}`)));
    const tabs = el('div', { class: 'tabs' },
      el('button', { class: `tab${this.tab === 'headcount' ? ' on' : ''}`, onclick: () => this._setTab('headcount') }, 'House'),
      el('button', { class: `tab${this.tab === 'radars' ? ' on' : ''}`, onclick: () => this._setTab('radars') }, 'Radars'));
    h.classList.toggle('edit', this.editing && this.tab !== 'headcount');
    if (this.tab === 'headcount') {
      h.replaceChildren(
        el('button', { class: 'menu', title: 'Menu', onclick: () => this.dispatchEvent(new Event('hass-toggle-menu', { bubbles: true, composed: true })) }, '☰'),
        el('h1', {}, 'Presence'), tabs, el('div', { class: 'spacer' }),
        el('button', { class: 'ibtn', title: 'Copy a link to this moment', onclick: () => this._copyHeadcountLink() }, '🔗'),
        !this.admin ? '' : el('button', { class: 'ibtn', title: 'Report a problem…', onclick: () => this._report(this.hcEl.cursor ?? Date.now() / 1000) }, '⚑'),
        !this.admin ? '' : el('button', { class: 'ibtn', title: this.details ? 'Hide details' : 'Show details: radar sightings, ignored tracks', onclick: () => { this._setDetails(!this.details); this._renderHeader(); } }, this.details ? '◉' : '◎'));
      return;
    }
    if (this.editing) {
      h.replaceChildren(
        el('h1', {}, 'Editing ', el('b', {}, this.config?.title || '')),
        el('div', { class: 'spacer' }),
        dirty ? el('span', { class: 'dirty' }, 'Unsaved changes') : '',
        el('button', { class: 'ibtn', title: 'Undo (Ctrl+Z)', disabled: !this.undoStack.length, onclick: () => this._undo() }, '↶'),
        el('button', { class: 'ibtn', title: 'Redo (Ctrl+Shift+Z)', disabled: !this.redoStack.length, onclick: () => this._redo() }, '↷'),
        el('button', { class: 'text-btn', onclick: () => this._cancelEdit() }, 'Cancel'),
        el('button', { class: 'save-btn', disabled: !dirty, onclick: () => this._save(), title: 'Save (Ctrl+S)' }, 'Save'));
      return;
    }
    h.replaceChildren(
      el('button', { class: 'menu', title: 'Menu', onclick: () => this.dispatchEvent(new Event('hass-toggle-menu', { bubbles: true, composed: true })) }, '☰'),
      el('h1', {}, 'Presence'),
      tabs,
      this.radars.length ? sel : '',
      this.radars.length ? range : '',
      this.radars.length ? el('button', { class: 'ibtn', title: 'Reload history', onclick: () => this._loadHistory() }, '⟳') : '',
      el('div', { class: 'spacer' }),
      this.config && this.admin ? el('button', { class: 'pill-btn', title: 'Edit the shapes and settings of this radar (E)', onclick: () => this._enterEdit() }, '✎ Edit') : '',
      this.config ? el('button', { class: 'ibtn', title: 'More', onclick: e => this._openMenu(e.currentTarget) }, '⋮') : '',
    );
  }

  /** Details: coordinates, track numbers, raw readings, technical Activity. A per-user switch. */
  _setDetails(on, persist = true) {
    this.details = on;
    localStorage.setItem('rzp.details', on ? '1' : '0');
    if (persist) this.hass.callWS({ type: 'frontend/set_user_data', key: 'radar_presence', value: { details: on } }).catch(() => {});
    if (!on) { this.showFrames = false; this.trailLabels = false; if (this.colorMode !== 3) { this.colorMode = 3; this._updateFlags(); } }
    if (this.hcEl) { this.hcEl.details = on; if (this.hcEl._active) this.hcEl.render(); }
    if (this.config) this._renderAll();
    this._renderFrames();
  }

  /** A timeline bar was clicked: what happened, in words, with the obvious fix for the cause we found. */
  _barPopover({ zoneId, a, b, x, y }) {
    this._pop?.remove();
    const z = this.zones.find(q => q.id === zoneId);
    if (!z || !this.hist) return;
    const iv = this.preview?.summary?.[zoneId]?.intervals || [];
    const next = iv.find(v => v[0] > b + 0.01)?.[0] ?? null;
    const exclusions = this.zones.filter(q => q.kind === 'exclude' && !validatePolygon(q.polygon));
    const ex = explainOn(this.hist, z.polygon, a, b, { exclusions, next, hold: !!z.filters.hold_until_exit });
    const room = z.name;
    const say = {
      still: 'Something appeared here and vanished without moving. That usually means a curtain, a plant or a fan.',
      blip: `On for only ${fmtDuration(ex.duration)}: someone brushed past the edge, or a short ghost.`,
      lost: `It went clear for ${fmtDuration(ex.gap)} with nobody seen leaving: the radar loses people who sit still.`,
      walked: `Someone walked in and it stayed on for ${fmtDuration(ex.duration)}.`,
    }[ex.cause];
    const close = () => { pop.remove(); this._pop = null; removeEventListener('pointerdown', away, true); };
    const away = e => { if (!e.composedPath().includes(pop)) close(); };
    const fix = (label, fn) => this.admin ? el('button', { class: 'pchip', onclick: () => { close(); fn(); } }, label) : '';
    const f = z.filters;
    const fixes = [];
    if (ex.cause === 'still' && ex.points.length) {
      fixes.push(fix('Ignore that spot', () => {
        const poly = offsetConvex(convexHull(ex.points), 250);
        if (poly) { this._addZone(poly, 'exclude', `Ignore near ${room}`); this._toast('Added an ignore area: check it, then Save.'); }
      }));
    }
    if ((ex.cause === 'still' || ex.cause === 'blip') && z.kind === 'include' && (f.on_delay_s || 0) < 3) {
      fixes.push(fix('Turn on after 3 s', () => { this._select(z.id, null); this._patchZone(z.id, { filters: { ...f, on_delay_s: 3 } }, { renderSide: true }); }));
    }
    if (ex.cause === 'lost' && z.kind === 'include') {
      fixes.push(fix('Remember people who sit still', () => { this._select(z.id, null); this._patchZone(z.id, { filters: { ...f, hold_until_exit: true, hold_max_s: f.hold_max_s || this._suggestedMaxHold(z) } }, { renderSide: true }); }));
    }
    const pop = el('div', { class: 'bar-pop', style: { left: `${Math.min(innerWidth - 340, Math.max(8, x - 160))}px`, top: `${Math.max(8, y - 190)}px` } },
      el('div', { class: 'bp-h' }, `${room} · on ${fmtTime(a)} – ${fmtTime(b)} (${fmtDuration(ex.duration)})`),
      el('div', { class: 'bp-say' }, say),
      el('div', { class: 'bp-acts' },
        el('button', { class: 'pchip', onclick: () => { close(); this._showTime(a, Math.max(60, (b - a) * 3)); this._seek(Math.max(this.hist.start, a - 3)); this._togglePlay(); } }, '▶ Play this moment'),
        ...fixes,
        el('button', { class: 'pchip', onclick: close }, ex.cause === 'walked' ? 'Close' : 'It was real'),
        this.admin ? el('button', { class: 'pchip', onclick: () => { close(); this._report(a, z.kind === 'include' ? 'light_on_by_itself' : 'other'); } }, 'It was wrong…') : ''));
    addEventListener('pointerdown', away, true);
    this.shadowRoot.append(pop);
    this._pop = pop;
  }

  /** A shape drawn on a linked radar was clicked: say so, and offer to open it there. */
  _openLinked(radarId, zoneId) {
    const peer = this.peers.get(radarId);
    const z = peer?.cfg.zones.find(q => q.id === zoneId);
    if (!z) return;
    this.selectedId = null;
    this._linkedSel = { radarId, zoneId };
    this._renderSide();
  }

  /** Report a problem around t: an anonymized file to attach to an issue. */
  _report(t, symptom = null) {
    if (!this.admin) return;
    openReportDialog({ hass: this.hass, root: this.shadowRoot, t, symptom, radars: this.radars.length });
  }

  /** The ⋮ menu of the radar view. */
  _openMenu(anchor) {
    this._menu?.remove();
    const r = anchor.getBoundingClientRect();
    const item = (label, fn, disabled = false) => el('button', { disabled, onclick: () => { close(); fn(); } }, label);
    const menu = el('div', { class: 'menu-pop', style: { top: `${r.bottom + 4}px`, right: `${Math.max(8, innerWidth - r.right)}px` } },
      item('Copy a link to this moment', () => this._copyLink(), !this.hist),
      !this.admin ? '' : item('Line up with another radar…', () => { this._enterEdit(); this.selectedId = null; this._renderSide(); this.side.querySelector('.align-anchor')?.scrollIntoView({ block: 'center' }); }, this.radars.length < 2),
      !this.admin ? '' : item('Export shapes…', () => this._exportZones(), !this.zones.length),
      !this.admin ? '' : item('Import shapes…', () => this._importZones()),
      !this.admin ? '' : item(`${this.details ? '✓ ' : ''}Show details`, () => this._setDetails(!this.details)),
      !this.admin ? '' : item('Report a problem…', () => this._report(this.cursor ?? Date.now() / 1000)));
    const close = () => { menu.remove(); this._menu = null; removeEventListener('pointerdown', away, true); };
    const away = e => { if (!e.composedPath().includes(menu)) close(); };
    addEventListener('pointerdown', away, true);
    this.shadowRoot.append(menu);
    this._menu = menu;
  }

  _tb(label, on, onclick, title, disabled = false) {
    return el('button', { class: `tb${on ? ' on' : ''}`, onclick, title: title || label, disabled }, label);
  }

  _renderToolbar() {
    const t = this.toolbar;
    t.style.display = this.editing ? '' : 'none'; // review mode has no tools
    const s = this.snap;
    const gridOpts = this.units.snapSteps.map(v => el('option', { value: v, selected: Math.abs(v - s.gridStep) < 0.01 }, this.units.fmtLong(v)));
    t.replaceChildren(
      el('div', { class: 'group' },
        this._tb('Select', this.tool === 'select', () => this._setTool('select'), 'Select / edit (V)'),
        this._tb('Polygon', this.tool === 'draw', () => this._setTool('draw'), 'Draw polygon (D): click vertices, click the first vertex or press Enter to close'),
        this._tb('Rectangle', this.tool === 'rect', () => this._setTool('rect'), 'Draw rectangle (R): drag'),
        this._tb('Measure', this.tool === 'measure', () => this._setTool('measure'), 'Measure distance and angle (M)')),
      el('div', { class: 'group' },
        this._tb('Room', this.drawKind === 'include', () => { this.drawKind = 'include'; this._updatePlot(); this._renderToolbar(); }, 'New shapes are rooms (or a part of one with its own occupancy)'),
        this._tb('Ignore', this.drawKind === 'exclude', () => { this.drawKind = 'exclude'; this._updatePlot(); this._renderToolbar(); }, 'New shapes are ignore areas (a fan, a plant, a reflection)'),
        this._tb('Doorway', this.drawKind === 'exit', () => { this.drawKind = 'exit'; this._updatePlot(); this._renderToolbar(); }, 'New shapes are doorways (a door, an opening, the top of the stairs)'),
        this._tb('Spot', this.drawKind === 'linger', () => { this.drawKind = 'linger'; this._updatePlot(); this._renderToolbar(); }, 'New shapes are spots, places people stay (bed, sofa, desk chair): someone the radar loses here is still there'),
        this._tb(this.drawKind === 'transient' ? 'Walkway' : '⋯', this.drawKind === 'transient', () => { this.drawKind = 'transient'; this._updatePlot(); this._renderToolbar(); }, 'More: walkway, where people only pass through (someone the radar loses here has moved on)')),
      el('div', { class: 'group' },
        this._tb('∠ Angles', s.angle, () => { s.angle = !s.angle; this._updatePlot(); this._renderToolbar(); }, 'Snap edges to 45°/90°, relative to the previous edge (hold Shift to disable)'),
        this._tb('◦ Vertices', s.vertex, () => { s.vertex = !s.vertex; this._updatePlot(); this._renderToolbar(); }, 'Snap to existing vertices'),
        this._tb('# Grid', s.grid, () => { s.grid = !s.grid; this._updatePlot(); this._renderToolbar(); }, 'Snap to grid'),
        el('select', { onchange: e => { s.gridStep = +e.target.value; this._updatePlot(); }, title: 'Grid step' }, gridOpts),
        this._tb('📏', this.showMeasurements, () => { this.showMeasurements = !this.showMeasurements; this._updatePlot(); this._renderToolbar(); }, 'Show edge lengths and angles')),
      !this.details ? '' : el('div', { class: 'group' },
        el('label', {}, 'Colour',
          el('select', { onchange: e => { this.colorMode = +e.target.value; this._updateFlags(); this._updatePlot(); } },
            el('option', { value: 3, selected: this.colorMode === 3 }, 'detections'),
            el('option', { value: 0, selected: this.colorMode === 0 }, 'by track'),
            el('option', { value: 1, selected: this.colorMode === 1 }, 'selected shape'),
            el('option', { value: 2, selected: this.colorMode === 2 }, 'by age')))),
      el('div', { class: 'group' },
        this._tb('Fit', false, () => this.plot.fit(), 'Fit view (F)'),
        this._tb('⟲', false, () => this._rotate(-90), 'Rotate view'),
        this._tb('⟳', false, () => this._rotate(90), 'Rotate view'),
        this._tb('⇋', this.settings.display.mirror, () => this._setDisplay({ mirror: !this.settings.display.mirror }), 'Flip left / right (view only; zones are not moved)'),
        this._tb('Live', this.live, () => { this.live = !this.live; this._updatePlot(); this._renderToolbar(); }, 'Show live targets'),
        this.peers?.size && this._peerTransforms().size ? this._tb('Others', this.showPeers, () => { this.showPeers = !this.showPeers; this._updatePlot(); this._renderToolbar(); }, 'Show the linked radars: their view, shapes and live detections') : ''),
    );
  }

  _rotate(d) {
    this._setDisplay({ rotation: (this.settings.display.rotation || 0) + d });
  }

  _renderTransport() {
    const t = this.transport;
    if (!t) return;
    this._transportKey = `${this.mode}|${this.playing}`;
    const replay = this.mode === 'replay' || this.mode === 'live';
    const live = this.mode === 'live';
    t.replaceChildren(
      el('div', { class: 'group' },
        this._tb('⏮', false, () => this._stepFrame(-1), 'Previous frame (,) · ← jumps 10 s, Shift+← 1 min', !this.hist),
        this._tb(this.playing || live ? '⏸' : '▶', this.playing || live, () => this._togglePlay(), live ? 'Pause: freeze at this moment (Space)' : 'Play / pause (Space)', !this.hist),
        this._tb('⏭', false, () => this._stepFrame(1), 'Next frame (.) · → jumps 10 s, Shift+→ 1 min', !this.hist),
        el('select', { onchange: e => { this.speed = +e.target.value; }, title: 'Playback speed' },
          SPEEDS.map(s => el('option', { value: s, selected: s === this.speed }, `${s}×`)))),
      el('div', { class: 'group' },
        el('label', {}, 'Trail',
          el('select', { onchange: e => { this.trailSeconds = +e.target.value; this._updatePlot(); } },
            [5, 10, 20, 30, 60, 120, 300].map(s => el('option', { value: s, selected: s === this.trailSeconds }, `${s} s`)))),
        this._tb('Detections', this.showContext, () => { this.showContext = !this.showContext; this._updatePlot(); this._renderTransport(); }, 'Keep all detections in the range visible, faded, behind the trail'),
        el('input', { type: 'range', class: 'density', min: 0.2, max: 3, step: 0.1, value: this.detOpacity, title: 'Detection density: how strongly detections are drawn',
          oninput: e => { this.detOpacity = +e.target.value; localStorage.setItem('rzp.detOpacity', this.detOpacity); this._updatePlot(); } }),
        !this.details ? '' : this._tb('Timestamps', this.trailLabels, () => { this.trailLabels = !this.trailLabels; this._updatePlot(); this._renderTransport(); }, 'Label trail points with their time'),
        !this.details ? '' : this._tb('Raw readings', this.showFrames, () => { this.showFrames = !this.showFrames; this._renderFrames(); this._renderTransport(); }, 'Show the raw readings around the playhead')),
      el('div', { class: 'group' },
        replay
          ? el('span', { class: `replay-label${live ? ' live' : ''}`, style: { fontVariantNumeric: 'tabular-nums' } }, this._replayLabelText())
          : el('span', { class: 'help' }, this.hist ? 'Drag the yellow handles to trim the range (point cloud + playback) · drag the red playhead · ←/→ 10 s, Shift 1 min, ,/. one frame · wheel zooms · bars = preview of your edits ▼, dark line = recorded ▲' : ''),
        !live && this.hist ? this._tb('● Live', false, () => this._goLive(), 'Follow what the radar sees right now') : '',
        replay ? this._tb('All detections', false, () => { this.preferLive = false; this._exitReplay(); }, 'Show every detection in the range (for drawing), with live detections on top') : '',
        this.brush ? this._tb('Zoom to trim', false, () => this.timeline.zoomToTrim(), 'Zoom the timeline to the trimmed range') : '',
        this.hist ? this._tb('🔗 Link', false, () => this._copyLink(), 'Copy a link to this radar at this moment (cursor and timeline zoom), to share') : '',
        this.brush ? this._tb('Clear trim', false, () => { this.brush = null; this.timeline.set({ brush: null }); this._scheduleAnalysis(); this._updatePlot(); this._renderTransport(); }, 'Use the whole loaded range') : ''),
    );
  }

  _renderTimeline() {
    if (!this.timeline) return;
    const rows = [];
    const sum = this.preview?.summary || {};
    this.zones.forEach((z, i) => {
      if (z.kind === 'exclude' || isSpot(z.kind)) return;
      if (z.kind === 'exit') {
        const d = z.door_entity_id && this.doors[z.door_entity_id];
        if (!d || !this.hist) return;
        const iv = doorIntervals(d.rows, this.hist.end);
        rows.push({ id: z.id, name: `🚪 ${z.name}`, color: EXIT_COLOR, predicted: [], actual: iv, triggers: [], actualTriggers: iv.map(v => v[0]) });
        return;
      }
      rows.push({ id: z.id, popover: true, name: z.name, color: kindTone(styleKind(z)), predicted: sum[z.id]?.intervals || [], actual: this.actual[z.id] || [], triggers: sum[z.id]?.triggers || [], actualTriggers: (this.actual[z.id] || []).map(v => v[0]) });
    });
    rows.push({ id: 'presence', name: 'Anyone (not ignored)', color: '#607d8b', predicted: sum.presence?.intervals || [], actual: this.actual.presence || [], triggers: [], actualTriggers: (this.actual.presence || []).map(v => v[0]) });
    this.timeline.set({
      range: this.hist ? { start: this.hist.start, end: this.hist.end } : null,
      frames: this.hist ? { start: this.hist.start, t: this.hist.frame_t, n: this.hist.frame_n } : null,
      rows,
      cursor: this.cursor,
      brush: this.brush,
      follow: this.mode === 'live',
      resetView: !!this._resetTimelineView,
    });
    this._resetTimelineView = false;
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
      if (this.brush) window = { t0: this.brush.t0 - this.hist.start, t1: this.brush.t1 - this.hist.start };
    } else if (this.mode === 'live' && this.hist) {
      targets = this.liveTargets;
      trails = this.liveTrails;
      states = this.liveStates;
      cursor = this.cursor - this.hist.start;
      if (this.brush) window = { t0: this.brush.t0 - this.hist.start, t1: this.brush.t1 - this.hist.start };
    } else {
      if (this.live) { targets = this.liveTargets; trails = this.liveTrails; states = this.liveStates; }
      if (this.brush && this.hist) window = { t0: this.brush.t0 - this.hist.start, t1: this.brush.t1 - this.hist.start };
    }
    const exits = this.zones.filter(z => z.kind === 'exit' && z.door_entity_id);
    if (exits.length) {
      states = { ...states };
      const at = this.mode === 'replay' ? this.cursor : null;
      for (const z of exits) states[z.id] = this._doorOpenAt(z.door_entity_id, at);
    }
    this.plot.set({
      dark: !!this.hass?.themes?.darkMode,
      labels: this._shapeLabels(),
      coverage: this._coverage(),
      linked: this._linkedShapes(),
      showGrid: this.editing && this.snap.grid,
      editing: this.editing,
      opacity: this.detOpacity,
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
      trackNumbers: this.details,
      showContext: this.showContext,
      suggestions: this._suggestionOverlays(),
      edgeWarnings: this.selectedId ? this.edgeWarnings || [] : [],
      markers: this._doorMarkers(),
      peers: this._peerOverlays(),
    });
    this._renderLegend();
    if (!this.editing) this._renderAt();
  }

  /** Doorway pills say where they lead: "→ Kitchen", "↑ Bedroom" (another floor), "Outside". */
  _shapeLabels() {
    const out = {};
    const floors = this.hass?.floors || {}, areas = this.hass?.areas || {};
    const level = id => floors[areas[id]?.floor_id]?.level;
    const here = level(this.config?.device_area_id);
    for (const z of this.zones) {
      if (z.kind !== 'exit' || !z.leads_to?.length) continue;
      if (z.leads_to.includes('outside')) { out[z.id] = { glyph: 'outside', text: 'Outside' }; continue; }
      const names = z.leads_to.map(id => areas[id]?.name || id).join(', ');
      const lv = level(z.leads_to[0]);
      const arrow = here == null || lv == null || lv === here ? '→' : lv > here ? '↑' : '↓';
      out[z.id] = { glyph: arrow === '→' ? 'door' : 'stairs', text: `${arrow} ${names}` };
    }
    return out;
  }

  /** Shapes drawn on linked radars, in this radar's frame: one room view with several cones. */
  _linkedShapes() {
    const out = [];
    for (const [id, T] of this._peerTransforms()) {
      const peer = this.peers.get(id);
      if (!peer) continue;
      for (const z of peer.cfg.zones) {
        if (validatePolygon(z.polygon)) continue;
        out.push({ radarId: id, radarTitle: peer.title, zone: { ...this._editable(z), polygon: z.polygon.map(p => affineApply(T, p)) } });
      }
    }
    return out;
  }

  /** What the radars see, in this radar's frame (its view and linked radars'): rooms are lighter outside it. */
  _coverage() {
    if (!this.config) return null;
    const out = [fovPolygon(this.config.fov.max_distance_mm, this.config.fov.half_angle_deg, 32)];
    for (const [id, T] of this._peerTransforms()) {
      const fov = this.peers.get(id)?.cfg?.fov;
      if (fov) out.push(fovPolygon(fov.max_distance_mm, fov.half_angle_deg, 32).map(p => affineApply(T, p)));
    }
    return out;
  }

  /** The legend: one chip per kind on the map (fill swatch + glyph). */
  _renderLegend() {
    if (!this.legendEl) return;
    const kinds = ['include', 'linger', 'transient', 'exit', 'exclude'].filter(k => this.zones.some(z => styleKind(z) === k));
    const dark = !!this.hass?.themes?.darkMode;
    const key = `${kinds}|${dark}`;
    if (key === this._legendKey) return;
    this._legendKey = key;
    this.legendEl.style.display = kinds.length ? '' : 'none';
    this.legendEl.replaceChildren(...kinds.map(k => {
      const st = KIND_STYLE[k], c = dark ? st.dark : st.light;
      return el('span', { class: 'chip' }, el('span', { class: 'sw', style: { background: c, opacity: Math.max(0.35, st.fill * 2.5) } }), glyphSvg(st.glyph, c, 12), st.label);
    }));
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
    this.statusEl.style.display = this.details || this.editing ? '' : 'none';
    this.statusEl.replaceChildren(
      this.details ? el('span', { class: 'pointer' }) : '',
      this.details && h ? el('span', {}, `${h.frame_t.length.toLocaleString()} readings · ${h.x.length.toLocaleString()} detections`) : '',
      this.editing ? el('span', { class: 'hint' }, hints[this.tool]) : '',
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
    return kindTone(styleKind(z), !!this.hass?.themes?.darkMode);
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
          el('div', { class: 'zone-meta' }, z.kind === 'exclude' ? 'ignore area'
            : z.kind === 'exit' ? `doorway${z.door_entity_id ? ` · ${this._doorName(z.door_entity_id)}` : ''}`
              : z.kind === 'linger' ? 'spot · people stay here'
                : z.kind === 'transient' ? 'walkway · people pass through'
                  : eid ? (this.details ? eid : `${z.spot ? 'spot' : 'room'} · has an occupancy entity`) : 'new: saving creates its occupancy entity')),
        el('span', { class: 'badge', 'data-live': z.id }, z.kind === 'exclude' ? 'ignore' : z.kind === 'linger' ? 'spot' : z.kind === 'transient' ? 'walkway' : '—'));
    });
    const sensor = el('div', { class: 'section' },
      el('h3', {}, el('span', { class: 'grow' }, cfg.title)),
      el('div', { class: 'help' }, `Tracks ${cfg.targets.length} people · ${cfg.profile.replace(/_/g, ' ')} · range ${this.units.fmtLong(cfg.fov.max_distance_mm)}`),
      el('div', { class: 'stat' }, el('span', {}, 'Anyone (not ignored)'), el('span', { class: 'badge', 'data-live': 'presence' }, '—')),
    );
    const zonesSec = el('div', { class: 'section' },
      el('h3', {}, el('span', { class: 'grow' }, `Shapes (${this.zones.length})`)),
      zoneRows.length ? zoneRows : el('div', { class: 'help' }, 'Nothing drawn yet. Draw a room with the Polygon or Rectangle tool.'),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', onclick: () => { this.drawKind = 'include'; this._setTool('draw'); } }, '+ Room'),
        el('button', { class: 'btn', onclick: () => { this.drawKind = 'exclude'; this._setTool('draw'); } }, '+ Ignore area'),
        el('button', { class: 'btn', title: 'A room covering everything the radar sees', onclick: () => this._addZone(fovPolygon(cfg.fov.max_distance_mm, cfg.fov.half_angle_deg, 12), 'include', 'Whole room') }, 'Room = whole view')),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', title: 'Download these shapes (as saved, plus unsaved edits) as a JSON file', disabled: !this.zones.length, onclick: () => this._exportZones() }, 'Export…'),
        el('button', { class: 'btn', title: 'Load shapes from an exported JSON file. Shapes with the same name are replaced; nothing is saved until you press Save.', onclick: () => this._importZones() }, 'Import…')));
    if (!this.editing) {
      // Review: what is on at the playhead, the selected shape's preview, then suggestions.
      s.replaceChildren(el('div', { class: 'guide' }), el('div', { class: 'section at' }), this._shapeSummary() || '',
        ...(this.admin ? [el('div', { class: 'section spots' }), this._doorsSection()] : []));
      this._atKey = null;
      this._renderAt();
    } else {
      const z = this.zones.find(q => q.id === this.selectedId);
      s.replaceChildren(el('div', { class: 'guide' }), zonesSec, z ? this._zoneEditor() : [sensor, this._settingsSection(), this._firmwareSection()], el('div', { class: 'section spots' }), this._doorsSection());
    }
    this._renderLiveBadges();
    this._renderSideStats();
    this._renderSpots();
  }

  /** Review: the selected shape in words, with its preview and recorded history. */
  _shapeSummary() {
    const z = this.zones.find(q => q.id === this.selectedId);
    const ls = this._linkedSel;
    if (!z && ls) {
      const peer = this.peers.get(ls.radarId), lz = peer?.cfg.zones.find(q => q.id === ls.zoneId);
      if (!lz) return null;
      const st = KIND_STYLE[styleKind(this._editable(lz))] || KIND_STYLE.include;
      return el('div', { class: 'section' },
        el('h3', {}, glyphSvg(st.glyph, kindTone(styleKind(this._editable(lz))), 14), el('span', { class: 'grow', style: { marginLeft: '6px' } }, lz.name)),
        el('div', { class: 'help' }, `${st.label} · drawn on ${peer.title}, a linked radar. Its state shows here; it is edited there.`),
        el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: () => { this._linkedSel = null; this._selectRadar(ls.radarId).then(() => this._select(ls.zoneId, null)); } }, `Open ${peer.title.replace(/^(Everything Presence Lite|Human Sensor 2A)\s*/, '')}`)));
    }
    if (!z) return null;
    const st = KIND_STYLE[styleKind(z)] || KIND_STYLE.include;
    const saved = this.config.zones.find(q => q.id === z.id);
    return el('div', { class: 'section' },
      el('h3', {}, glyphSvg(st.glyph, this._zoneColor(z), 14), el('span', { class: 'grow', style: { marginLeft: '6px' } }, z.name),
        this.admin ? el('button', { class: 'btn', title: 'Edit this shape', onclick: () => this._enterEdit() }, '✎ Edit') : ''),
      el('div', { class: 'help' }, `${st.label}${saved?.device_id ? ' · ' : ''}`,
        saved?.device_id ? el('a', { href: `/config/devices/device/${saved.device_id}` }, 'its device ↗') : ''),
      el('div', { class: 'trail' }),
      el('div', { class: 'zone-stats' }));
  }

  /** Review: the state of each room, spot and door at the playhead (or now), in words. */
  _renderAt() {
    const box = this.side?.querySelector('.section.at');
    if (!box || !this.config) return;
    const replay = this.mode === 'replay' && this.hist;
    const states = replay ? this._replayState().states : this.liveStates;
    const at = replay || this.mode === 'live' ? this.cursor : null;
    const rows = [];
    for (const z of this.zones) {
      if (z.kind === 'include') rows.push([z, states[z.id] ? 'Occupied' : states[z.id] === undefined ? 'not saved yet' : 'Clear', !!states[z.id]]);
      else if (z.kind === 'exit' && z.door_entity_id) { const o = this._doorOpenAt(z.door_entity_id, replay ? this.cursor : null); rows.push([z, o ? 'Open' : 'Closed', o]); }
    }
    if (!replay) { // linked radars' rooms: their state arrives with this group's live updates
      for (const { zone: z, radarTitle } of this._linkedShapes()) {
        if (z.kind === 'include' && states[z.id] !== undefined) rows.push([z, states[z.id] ? 'Occupied' : 'Clear', !!states[z.id], radarTitle.replace(/^(Everything Presence Lite|Human Sensor 2A)\s*/, '')]);
      }
    }
    const anyone = replay ? this._zoneOnAt('presence', this.cursor) : this.livePresence;
    const key = JSON.stringify([at == null ? null : Math.floor(at), rows.map(r => r[1]), anyone, this.selectedId]);
    if (key === this._atKey) return;
    this._atKey = key;
    box.replaceChildren(
      el('h3', {}, at == null ? 'Now' : `${this.mode === 'live' ? 'Live' : 'At'} ${fmtTime(at)}`),
      ...rows.map(([z, label, on, via]) => el('div', { class: 'at-row', style: { cursor: 'pointer' }, onclick: () => (this.zones.some(q => q.id === z.id) ? this._select(z.id, null) : this._openLinked(this._linkedShapes().find(l => l.zone.id === z.id)?.radarId, z.id)) },
        glyphSvg((KIND_STYLE[styleKind(z)] || KIND_STYLE.include).glyph, this._zoneColor(z), 14),
        el('span', { class: 'nm' }, z.name, via ? el('span', { class: 'help' }, ` · ${via}`) : ''), el('span', { class: `st${on ? ' on' : ''}` }, label))),
      el('div', { class: 'at-row' }, el('span', { class: 'nm help' }, 'Anyone in view (not ignored)'), el('span', { class: `st${anyone ? ' on' : ''}` }, anyone ? 'Yes' : 'No')),
      rows.length ? '' : el('div', { class: 'help' }, 'No rooms on this radar yet. Press Edit to draw one.'));
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
      el('h3', {}, el('span', { class: 'grow' }, KIND_STYLE[styleKind(z)]?.label === 'Ignored' ? 'Ignore area' : KIND_STYLE[styleKind(z)]?.label || 'Room'),
        el('button', { class: 'btn danger', onclick: () => this._deleteZone(z.id) }, 'Delete')),
      el('div', { class: 'form' },
        el('label', {}, 'Name'),
        el('input', { type: 'text', value: z.name, onfocus: () => { this._namePrev = JSON.stringify(this.zones); }, oninput: e => { this.zones = this.zones.map(q => (q.id === z.id ? { ...q, name: e.target.value } : q)); this._updatePlot(); this._renderHeader(); this._renderTimeline(); }, onchange: () => { if (this._namePrev) this._pushUndo(this._namePrev); this._namePrev = null; this._renderSide(); } }),
        el('label', {}, 'Type'),
        el('select', { onchange: e => this._setKind(z, e.target.value) },
          el('option', { value: 'include', selected: styleKind(z) === 'include' }, 'Room'),
          el('option', { value: 'linger', selected: styleKind(z) === 'linger' }, 'Spot (bed, sofa, desk chair)'),
          el('option', { value: 'exit', selected: z.kind === 'exit' }, 'Doorway (door, opening, stairs)'),
          el('option', { value: 'exclude', selected: z.kind === 'exclude' }, 'Ignore area (a fan, a plant)'),
          el('option', { value: 'transient', selected: z.kind === 'transient' }, 'Walkway (passing through)')),
        styleKind(z) === 'linger' ? this._spotSensorToggle(z) : '',
        z.kind === 'include' ? [
          el('label', {}, 'Device'),
          (() => {
            const saved = this.config.zones.find(q => q.id === z.id);
            const name = z.name.trim();
            return saved?.device_id
              ? el('a', { href: `/config/devices/device/${saved.device_id}`, title: 'Open its device in Home Assistant' }, `${name} ↗`)
              : el('span', { class: 'help' }, `${name} (created when you save)`);
          })(),
          ...(() => {
            const seen = this.config.zones.find(q => q.id === z.id)?.seen_by || [];
            return seen.length > 1 ? [el('label', {}, 'Seen by'),
              el('span', { class: 'help', title: 'Linked radars whose view covers part of this room. Each has a "Seen by" diagnostic sensor on the device.' },
                seen.map(t => t.replace(/^(Everything Presence Lite|Human Sensor 2A)\s*/, '')).join(', '))] : [];
          })(),
          el('label', {}, 'Area'),
          el('select', { onchange: e => this._patchZone(z.id, { area_id: e.target.value || null }) },
            el('option', { value: '', selected: !z.area_id }, `Same as the radar${deviceArea ? ` (${deviceArea})` : ''}`),
            areas.map(a => el('option', { value: a.area_id, selected: a.area_id === z.area_id }, a.name))),
          el('label', {}, 'Turn on after (s)'),
          num(f.on_delay_s, e => this._patchZone(z.id, { filters: { ...f, on_delay_s: Math.max(0, +e.target.value || 0) } })),
          el('label', {}, 'Turn off after (s)'),
          num(f.off_delay_s, e => this._patchZone(z.id, { filters: { ...f, off_delay_s: Math.max(0, +e.target.value || 0) } })),
          el('label', {}, `Edge buffer (${u.label})`),
          num(Math.round(u.toDisplay(f.edge_margin_mm) * 10) / 10, e => this._patchZone(z.id, { filters: { ...f, edge_margin_mm: Math.max(0, u.fromDisplay(+e.target.value || 0)) } })),
          el('div', { class: 'help full' }, 'Turn on after ignores short blips (ghosts are often under 2 s). The edge buffer stops flicker at the edge: someone must be this far inside to enter and this far outside to leave.'),
          el('label', { class: 'check full' },
            el('input', { type: 'checkbox', checked: !!f.hold_until_exit, onchange: e => this._patchZone(z.id, { filters: { ...f, hold_until_exit: e.target.checked, hold_max_s: e.target.checked && !f.hold_max_s ? this._suggestedMaxHold(z) : f.hold_max_s || 0 } }, { renderSide: true }) }),
            el('span', {}, 'Remember people who sit still',
              el('div', { class: 'help' }, 'Stays occupied until the person is seen leaving. Radars lose people who sit still; with this on, someone who disappears inside keeps it occupied until they are seen again, walking out or turning up near where they disappeared. People lost at the side of the radar\'s view or in a walkway are dropped after 20 s.',
                this.zones.some(q => q.kind === 'exit')
                  ? ` Doorways count: disappearing in one (${this.zones.filter(q => q.kind === 'exit').map(q => q.name).join(', ')}) means they left, and someone appearing in one has just arrived.`
                  : ' Mark the doorways (doors, stairs) to make this work for a whole room.'))),
          f.hold_until_exit ? [
            el('label', {}, 'Hold limit (min)'),
            num(Math.round((f.hold_max_s || 0) / 6) / 10, e => this._patchZone(z.id, { filters: { ...f, hold_max_s: Math.max(0, Math.round((+e.target.value || 0) * 60)) } }), { title: '0 = hold until seen leaving, however long' }),
            el('div', { class: 'help full' }, 'In case someone slips out unseen: a remembered person is forgotten after this long (0 = never).'),
          ] : '',
        ] : z.kind === 'exit' ? this._exitEditor(z)
          : z.kind === 'linger' ? el('div', { class: 'help full' }, 'A place people stay (a bed, a sofa, a desk chair). Someone the radar loses here is remembered as still being here, so their room stays occupied. Use it where the edge of the radar\'s view would otherwise suggest they left.')
            : z.kind === 'transient' ? el('div', { class: 'help full' }, 'Where people only pass through (a hallway strip, behind a corner). Someone the radar loses here has most likely moved on: they are forgotten after 20 s.')
              : el('div', { class: 'help full' }, 'Detections inside an ignore area are dropped before anything else looks at them: a fan, a plant, a curtain, a reflection.'),
      ),
      this.hist && z.kind !== 'exit' ? el('div', { class: 'actions' },
        el('button', {
          class: 'btn', title: 'Replace this polygon with a hull around where targets dwelt inside it, plus the margin',
          onmouseenter: () => { this.fitPreview = this._fitZone(z); this._updatePlot(); },
          onmouseleave: () => { this.fitPreview = null; this._updatePlot(); },
          onclick: () => {
            const poly = this._fitZone(z);
            this.fitPreview = null;
            if (!poly) { this._toast('Nothing to fit: nobody stayed inside this shape (or the inward margin collapses it).', true); return; }
            this._patchZone(z.id, { polygon: poly }, { renderSide: true });
          },
        }, 'Fit to points'),
        el('span', { class: 'help', style: { alignSelf: 'center' } }, `margin (${u.label})`),
        this._marginInput(() => this._renderSide())) : '',
      el('div', { class: 'trail' }),
      el('div', { class: 'zone-stats' }),
      !this.details ? '' : el('details', { open: z.polygon.length <= 8 },
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

  /** Kind from the type picker. A spot keeps its sensor when it already has one (a room becoming a spot keeps its entity). */
  _setKind(z, kind) {
    const patch = kind === 'linger'
      ? (z.kind === 'include' ? { spot: true } : { kind: 'linger', spot: false })
      : { kind, spot: false };
    this._patchZone(z.id, patch, { renderSide: true });
  }

  /** A spot's own occupancy sensor: optional, off by default. On, it is saved as a zone with a Spot device. */
  _spotSensorToggle(z) {
    const on = z.kind === 'include';
    const f = z.filters;
    return el('label', { class: 'check full', style: { marginTop: '4px' } },
      el('input', { type: 'checkbox', checked: on, onchange: e => this._patchZone(z.id, e.target.checked
        ? { kind: 'include', spot: true, filters: { ...f, hold_until_exit: true, hold_max_s: f.hold_max_s || this._suggestedMaxHold(z), edge_margin_mm: f.edge_margin_mm || 150 } }
        : { kind: 'linger', spot: false }, { renderSide: true }) }),
      el('span', {}, 'Occupancy sensor',
        el('div', { class: 'help' }, on
          ? 'On: saving gives this spot its own device and occupancy entity for automations. It still keeps its room occupied.'
          : 'Off: the spot keeps its room occupied while someone sits here. Turn on to use the spot itself in automations, like a desk lamp.')));
  }

  _suggestedMaxHold(z) {
    if (!this.hist || validatePolygon(z.polygon)) return 1800;
    const exclusions = this.zones.filter(q => q.kind === 'exclude' && !validatePolygon(q.polygon));
    return suggestMaxHold(trailStats(this.hist, z.polygon, { exclusions }));
  }

  _fitZone(z) {
    const exclusions = this.zones.filter(q => q.kind === 'exclude' && q.id !== z.id && !validatePolygon(q.polygon));
    if (validatePolygon(z.polygon)) return null;
    return fitHull(this.hist, z.polygon, this._margin(), { exclusions, window: this._analysisWindow() });
  }

  _renderTrail(z) {
    const box = this.side?.querySelector('.trail');
    if (!box) return;
    const prevWarn = JSON.stringify(this.edgeWarnings || []);
    this.edgeWarnings = [];
    if (!this.hist || validatePolygon(z.polygon)) { box.replaceChildren(); if (prevWarn !== '[]') this._updatePlot(); return; }
    const exclusions = this.zones.filter(q => q.kind === 'exclude' && q.id !== z.id && !validatePolygon(q.polygon));
    const st = trailStats(this.hist, z.polygon, { exclusions, window: this._analysisWindow() });
    const cls = classify(st);
    const row = (k, v) => el('div', { class: 'stat' }, el('span', {}, k), el('b', {}, v));
    const notes = [];
    if (z.kind === 'exclude' && cls.kind === 'spot') notes.push('Careful: people walk in and out of this ignore area; it looks like a real place people stay, not a ghost.');
    if (z.kind === 'include' && cls.kind === 'ghost') notes.push('Most occupancy here starts with a detection appearing in place: likely a ghost. Consider an ignore area.');
    if (z.kind === 'include' && !z.filters.hold_until_exit && suggestHold(st)) notes.push('People often go still in here and are seen again later: consider "Remember people who sit still".');
    // Edge jitter, evaluated the way the engine sees the zone (its own edge margin).
    const margin = z.kind === 'include' ? z.filters.edge_margin_mm || 0 : 0;
    const edgeStats = trailStats(this.hist, z.polygon, { exclusions, window: this._analysisWindow(), hysteresis: margin });
    const flaps = flappingEdges(edgeStats, z.polygon);
    this.edgeWarnings = flaps.map(e => ({ a: e.a, b: e.b, label: `${e.count} flaps` }));
    if (flaps.length) notes.push(`${edgeStats.bounces} times a target crossed out and back in within 3 s (red edges). An edge runs through a spot where people stay: move it, use Fit to points, or add an edge margin.`);
    if (JSON.stringify(this.edgeWarnings) !== prevWarn) queueMicrotask(() => this._updatePlot());
    const exitsUnseen = st.endOther;
    if (!this.details) { box.replaceChildren(...notes.map(n => el('div', { class: 'help', style: { color: 'var(--warning-color, #e65100)', marginTop: '4px' } }, n))); return; }
    box.replaceChildren(
      el('h3', {}, `Trails · ${cls.label}`),
      row('Visits', `${st.startWalk + st.startAppear}`),
      row('…began walking in', `${st.startWalk}`),
      row('…began appearing inside', `${st.startAppear}`),
      row('…ended walking out', `${st.endWalk}`),
      exitsUnseen ? row('…ended unseen', `${exitsUnseen}`) : '',
      st.stillGaps.length ? row('Went still inside', `${st.stillGaps.length}× · p50 ${fmtDuration(percentile(st.stillGaps, 0.5))} · p90 ${fmtDuration(percentile(st.stillGaps, 0.9))}`) : '',
      ...notes.map(n => el('div', { class: 'help', style: { color: 'var(--warning-color, #e65100)', marginTop: '4px' } }, n)));
  }

  _renderSideStats() {
    const box = this.side?.querySelector('.zone-stats');
    const z = this.zones.find(q => q.id === this.selectedId);
    if (!box || !z) return;
    if (z.kind === 'exit') {
      this.side.querySelector('.trail')?.replaceChildren();
      box.replaceChildren();
      if (this.edgeWarnings?.length) { this.edgeWarnings = []; this._updatePlot(); }
      return;
    }
    this._renderTrail(z);
    if (!this.hist || !this.preview) { box.replaceChildren(el('div', { class: 'help' }, 'Load history to preview this shape.')); return; }
    if (z.kind === 'exclude') {
      let n = 0;
      for (let k = 0; k < this.hist.x.length; k++) if (pointInPolygon(this.hist.x[k], this.hist.y[k], z.polygon)) n++;
      box.replaceChildren(el('div', { class: 'section', style: { padding: '8px 0 0', border: 0 } },
        el('div', { class: 'stat' }, el('span', {}, 'Detections ignored in range'), el('b', {}, `${n.toLocaleString()} (${((100 * n) / Math.max(1, this.hist.x.length)).toFixed(1)}%)`))));
      return;
    }
    const s = this.preview.summary[z.id];
    const raw = this.preview.unfiltered[z.id];
    const actual = this.actual[z.id];
    if (!s) { box.replaceChildren(el('div', { class: 'help' }, validatePolygon(z.polygon) ? 'The shape is invalid: fix crossing edges to preview.' : 'Computing preview…')); return; }
    const filtered = raw && raw.triggers.length !== s.triggers.length;
    box.replaceChildren(el('div', { style: { marginTop: '10px' } },
      el('h3', {}, `Preview · last ${RANGES.find(r => r[1] === this.rangeS)?.[0] || ''}`),
      this.preview.radars > 1 ? el('div', { class: 'help', style: { marginBottom: '4px' } },
        `Combines this radar with ${this.preview.radars - 1} linked radar${this.preview.radars > 2 ? 's' : ''}, like Home Assistant does: the same person seen by two radars counts once.`) : '',
      el('div', { class: 'stat' }, el('span', {}, 'Would have turned on'), el('b', {}, `${s.triggers.length}×`)),
      filtered ? el('div', { class: 'stat' }, el('span', { class: 'help' }, 'without filters'), el('b', { class: 'help' }, `${raw.triggers.length}×`)) : '',
      el('div', { class: 'stat' }, el('span', {}, 'Occupied'), el('b', {}, fmtDuration(s.occupied))),
      actual ? el('div', { class: 'stat' }, el('span', { class: 'help' }, 'Recorded by Home Assistant (as saved)'), el('b', { class: 'help' }, `${actual.length}× on`)) : '',
      actual?.length ? el('details', {},
        el('summary', { class: 'help', style: { cursor: 'pointer' } }, 'Recent recorded triggers — what actually happened'),
        el('div', { class: 'triggers' }, actual.slice(-50).reverse().map(([a, b]) => el('div', { onclick: () => this._jumpTo(a, z.id), title: 'Replay this recorded trigger' },
          el('span', {}, fmtDateTime(a)), el('span', { class: 'help' }, fmtDuration(b - a)))))) : '',
      el('div', { class: 'help', style: { marginTop: '6px' } }, 'Would have turned on (your edits):'),
      el('div', { class: 'triggers' }, s.triggers.slice(-200).reverse().map((t, i) => {
        const iv = s.intervals.find(v => v[0] === t);
        return el('div', { onclick: () => this._jumpTo(t, z.id), title: 'Replay this trigger' },
          el('span', {}, fmtDateTime(t)), el('span', { class: 'help' }, iv ? fmtDuration(iv[1] - iv[0]) : ''));
      }))));
  }

  // ------------------------------------------------------------ analysis

  /** Trim selection as history-relative seconds (analysis follows the trimmer). */
  _analysisWindow() {
    if (!this.brush || !this.hist) return undefined;
    return { t0: this.brush.t0 - this.hist.start, t1: this.brush.t1 - this.hist.start };
  }

  _margin() {
    return this.spotMargin ?? (this.units.imperial ? 304.8 : 300);
  }

  _scheduleAnalysis() {
    clearTimeout(this._analysisTimer);
    this._analysisTimer = setTimeout(() => {
      this._computeSpots();
      this._renderSpots();
      this._renderSideStats();
      this._updatePlot();
    }, 250);
  }

  _computeSpots() {
    if (!this.hist) { this.spots = null; return; }
    const exclusions = this.zones.filter(z => z.kind === 'exclude' && !validatePolygon(z.polygon));
    const includes = this.zones.filter(z => z.kind === 'include' && !validatePolygon(z.polygon));
    const window = this._analysisWindow();
    const margin = this._margin();
    const peers = this._crossPeers();
    this.spots = findDwellSpots(this.hist, { exclusions, window }).map((sp, i) => {
      const polygon = offsetConvex(sp.hull, margin) || sp.hull;
      const stats = trailStats(this.hist, polygon, { exclusions, window });
      const covered = includes.find(z => pointInPolygon(sp.centroid[0], sp.centroid[1], z.polygon));
      // Aligned radars that see into the spot: do they see what this radar sees there?
      const cross = peers.length ? crossCheck(this.hist, polygon, peers, { exclusions, window }) : [];
      const ghostBy = crossGhost(cross);
      const cls = ghostBy ? { ...classify(stats), kind: 'ghost', label: 'Likely ghost' } : classify(stats);
      const times = spotTimes(this.hist, polygon, { exclusions, window });
      return { ...sp, n: i + 1, polygon, stats, cls, times, hold: !ghostBy && suggestHold(stats), covered, cross, ghostBy };
    });
  }

  /** Aligned radars with loaded history, for cross-checking spots: [{name, hist, T, exclusions, maxDistance}]. */
  _crossPeers() {
    if (!this.peerHist?.size || !this.peers?.size) return [];
    const T = this._peerTransforms();
    const out = [];
    for (const [id, hist] of this.peerHist) {
      const peer = this.peers.get(id);
      if (!peer || !T.has(id)) continue;
      out.push({
        name: peer.cfg.title.replace(/^(Everything Presence Lite|Human Sensor 2A)\s*/, ''),
        hist, T: T.get(id), maxDistance: peer.cfg.fov.max_distance_mm,
        exclusions: peer.cfg.zones.filter(z => z.kind === 'exclude' && !validatePolygon(z.polygon)),
      });
    }
    return out;
  }

  _suggestionOverlays() {
    const out = [];
    if (this.showSpots && this.spots) {
      this.spots.forEach((sp, i) => {
        if (sp.covered && this.hoverSpot !== i) return;
        out.push({ polygon: sp.polygon, kind: sp.cls.kind, label: this.hoverSpot === i || !sp.covered ? `Suggestion ${sp.n}` : '', active: this.hoverSpot === i });
      });
    }
    if (this.fitPreview) out.push({ polygon: this.fitPreview, kind: 'fit', label: 'fitted', active: true });
    return out;
  }

  _marginInput(onchange) {
    const u = this.units;
    return el('input', {
      type: 'number', step: u.imperial ? 1 : 5, value: Math.round(u.toDisplay(this._margin()) * 10) / 10, style: { width: '80px' },
      title: 'Positive grows the hull outward; negative shrinks it so only the core of the spot counts',
      onchange: e => { this.spotMargin = u.fromDisplay(+e.target.value || 0); onchange(); },
    });
  }

  _trailSummary(st) {
    const starts = st.startWalk + st.startAppear;
    const p90 = percentile(st.stillGaps, 0.9);
    return [
      starts ? `walked in ${st.startWalk} of ${starts} times` : 'no visits',
      st.stillGaps.length ? `still up to ${fmtDuration(p90)} (p90)` : '',
    ].filter(Boolean).join(' · ');
  }

  /** A dwell spot as a zone of `kind` (include, linger, exclude), with an edge margin; holds when people go still there. */
  _spotToZone(sp, kind) {
    const poly = offsetConvex(sp.hull, kind === 'exclude' ? Math.max(this._margin(), 150) : this._margin());
    if (!poly) { this._toast('Margin too negative: the spot collapses. Use a smaller inward margin.', true); return false; }
    const hold = kind === 'include' && sp.hold;
    this.hoverSpot = null;
    const maxHold = suggestMaxHold(sp.stats);
    // Edge margin: without it, position jitter at the edge reads as walking out and back in.
    const name = { exclude: `Ignore ${sp.n}`, linger: `Spot ${sp.n}` }[kind] || `Room ${sp.n}`;
    this._addZone(poly, kind, name, hold ? { hold_until_exit: true, hold_max_s: maxHold, edge_margin_mm: 150 } : {});
    if (hold) this._toast(`People go still here: "Remember people who sit still" is on (limit ${Math.round(maxHold / 60)} min).`);
    else this._toast(`Added ${kind === 'exclude' ? 'an ignore area' : kind === 'linger' ? 'a spot' : 'a room'}: press Save to keep it.`);
    return true;
  }

  _spotKey(sp) { return `${Math.round(sp.centroid[0] / 300)},${Math.round(sp.centroid[1] / 300)}`; }

  /** Answers to "what is here?" for this radar's hot spots, and tidy-up suggestions waved off: {key: answer}. */
  _guideAnswers() {
    const store = `rzp.guide.${this.radarId}`;
    const answers = JSON.parse(localStorage.getItem(store) || '{}');
    for (const k of JSON.parse(localStorage.getItem(`rzp.notGhost.${this.radarId}`) || '[]')) answers[k] ??= 'people'; // (before)
    return { answers, save: () => localStorage.setItem(store, JSON.stringify(answers)) };
  }

  /**
   * Guided setup, one question at a time. First new hot spots (where targets dwell, not in a zone yet): the facts,
   * and "what is here?" (we do not decide machine or person; the answer picks the zone). Then zones that may no
   * longer be needed: exclusions people walk through, exclusions nothing was seen in for a week, zones nobody was
   * in for a week that no automation uses.
   */
  _renderGuide() {
    const box = this.side?.querySelector('.guide');
    if (!box) return;
    if (!this.admin) { box.replaceChildren(); box.className = 'guide'; return; }
    const { answers, save } = this._guideAnswers();
    const items = [
      ...(this.spots || []).filter(sp => !sp.covered && !answers[this._spotKey(sp)]).map(sp => ({ spot: sp })),
      ...this._tidySuggestions().filter(s => !answers[`${s.z.id}:${s.kind}`]),
    ];
    if (!items.length) { box.replaceChildren(); box.className = 'guide'; return; }
    const item = items[0];
    const more = items.length > 1 ? el('span', { class: 'help', style: { fontWeight: 400 } }, ` · ${items.length - 1} more`) : '';
    const answer = (key, value) => { answers[key] = value; save(); this._renderGuide(); };
    box.className = 'guide section';
    box.replaceChildren(...(item.spot ? this._hotSpotQuestion(item.spot, more, answer) : this._tidyQuestion(item, more, answer)));
  }

  _hotSpotQuestion(sp, more, answer) {
    const u = this.units, st = sp.stats, i = this.spots.indexOf(sp);
    const starts = st.startWalk + st.startAppear;
    const times = sp.times;
    const facts = [
      st.spread !== null && st.spread <= 150
        ? `All of it within ${u.fmtLong(st.spread)} of one point (someone sitting still spreads ${u.fmtLong(120)}–${u.fmtLong(500)}).`
        : st.spread !== null ? `Spread over ${u.fmtLong(st.spread)} around its centre.` : '',
      !starts ? '' : st.startWalk ? `A trail walked into it ${st.startWalk} of ${starts} times.` : `It appeared in place all ${starts} times: nobody walked in.`,
      times?.peak != null ? `Busiest around ${fmtDateTime(this.hist.start + times.peak)}; seen in ${times.hours} different hour${times.hours === 1 ? '' : 's'} of the day.` : '',
    ].filter(Boolean);
    const show = () => {
      this.showSpots = true; this.hoverSpot = i; this._updatePlot();
      if (times?.peak != null) this._showTime(this.hist.start + times.peak, 1800);
    };
    return [
      el('div', { style: { fontWeight: 500, marginBottom: '4px' } }, `📍 Something stays here`, more),
      el('div', { class: 'help', style: { marginBottom: '4px' } },
        `Suggestion ${sp.n}, ${u.fmtLong(Math.hypot(...sp.centroid))} away: the radar saw something here for ${fmtDuration(sp.dwell)} in this range.`),
      ...facts.map(f => el('div', { class: 'help' }, `• ${f}`)),
      el('div', { style: { margin: '8px 0 6px', fontWeight: 500 } }, 'What is here?'),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', title: 'A fan, heater, plant, curtain or machine, even behind a wall: ignore it (an ignore area)', onclick: () => this._spotToZone(sp, 'exclude') }, 'Something fixed (fan, plant)'),
        el('button', { class: 'btn', title: 'A desk, bed, couch or chair: a zone with its own presence sensor', onclick: () => this._spotToZone(sp, 'include') }, 'A place people stay'),
        el('button', { class: 'btn', title: 'People pass or stand here, nothing to set up: stop asking about this spot', onclick: () => answer(this._spotKey(sp), 'nothing') }, 'Nothing special'),
        el('button', { class: 'btn', onmouseenter: () => { this.hoverSpot = i; this._updatePlot(); }, onmouseleave: () => { this.hoverSpot = null; this._updatePlot(); }, onclick: show }, 'Show me')),
    ];
  }

  _tidyQuestion(item, more, answer) {
    const { z, kind } = item;
    const key = `${z.id}:${kind}`;
    const remove = () => { this._deleteZone(z.id); this._toast(`Removed “${z.name}”: press Save to keep it that way.`); };
    const text = {
      walked: `Trails walked into “${z.name}” ${item.walkIn} times in this range${item.seen ? `, and ${item.seen.name} saw someone there ${Math.round(item.share * 100)}% of those times` : ''}. If people really are there (not behind a wall or glass), this ignore area hides them: shrink or remove it.`,
      walkedPart: `Trails walked into “${z.name}” ${item.walkIn} times in this range. ${item.seen?.name} saw someone there only ${Math.round(item.share * 100)}% of those times: most of it is rightly excluded (a reflection), but part of it, probably an edge, is real people. Shrink it?`,
      empty: `Nothing was seen inside “${z.name}” in the last ${item.days} days. If what it hid is gone, it can go. (A heater off for the season is not gone.)`,
      unused: `Nobody was in “${z.name}” in the last ${item.days} days, and no automation, script or scene uses ${item.entity}.`,
    }[kind];
    return [
      el('div', { style: { fontWeight: 500, marginBottom: '4px' } }, kind.startsWith('walked') ? '🚶 An ignore area people walk through?' : '🧹 Still needed?', more),
      el('div', { class: 'help', style: { marginBottom: '8px' } }, text),
      el('div', { class: 'actions' },
        kind.startsWith('walked') ? el('button', { class: 'btn', onclick: () => this._select(z.id, null) }, 'Edit it') : '',
        kind === 'walkedPart' ? '' : el('button', { class: 'btn', onclick: remove }, 'Remove it'),
        el('button', { class: 'btn', title: 'Stop suggesting this', onclick: () => answer(key, 'keep') }, kind.startsWith('walked') ? 'That is intended' : 'Keep it')),
    ];
  }

  /** Zones that may no longer be needed (see _renderGuide). Only from enough history to tell. */
  _tidySuggestions() {
    if (!this.hist) return [];
    const span = this.hist.end - this.hist.start, days = Math.floor(span / 86400 + 0.1);
    const excl = this.zones.filter(z => z.kind === 'exclude' && !validatePolygon(z.polygon));
    const out = [];
    const peers = this._crossPeers();
    for (const z of excl) {
      const others = excl.filter(q => q !== z);
      const st = trailStats(this.hist, z.polygon, { exclusions: others });
      if (st.walkIn >= Math.max(10, span / 7200) && st.walkOut >= st.walkIn / 2) {
        // An aligned radar that sees into it decides: trails it does not see are a reflection (rightly excluded).
        const seen = (peers.length ? crossCheck(this.hist, z.polygon, peers, { exclusions: others }) : [])
          .filter(c => c.visits >= 5).sort((a, b) => b.confirmed / b.visits - a.confirmed / a.visits)[0];
        const share = seen ? seen.confirmed / seen.visits : null;
        if (share === null || share >= 0.6) out.push({ z, kind: 'walked', walkIn: st.walkIn, seen, share });
        else if (share >= 0.2) out.push({ z, kind: 'walkedPart', walkIn: st.walkIn, seen, share });
      } else if (!st.points && days >= 6) out.push({ z, kind: 'empty', days });
    }
    if (days >= 6) {
      for (const z of this.zones.filter(q => q.kind === 'include')) {
        const entity = this.config.zones.find(q => q.id === z.id)?.entity_id;
        if (!entity || (this.actual[z.id] || []).length || this.hass.states[entity]?.state === 'on') continue;
        const used = (this._zoneUse ||= new Map()).get(entity);
        if (used === undefined) {
          this._zoneUse.set(entity, null); // asking
          this.hass.callWS({ type: 'search/related', item_type: 'entity', item_id: entity })
            .then(r => { this._zoneUse.set(entity, ['automation', 'script', 'scene'].some(k => r?.[k]?.length)); this._renderGuide(); })
            .catch(() => this._zoneUse.set(entity, true));
        } else if (used === false) out.push({ z, kind: 'unused', days, entity });
      }
    }
    return out;
  }

  _renderSpots() {
    this._renderGuide();
    const box = this.side?.querySelector('.spots');
    if (!box) return;
    const none = !this.hist || !(this.spots || []).length;
    box.style.display = none && !this.editing ? 'none' : ''; // review: only when there is something to suggest
    const head = el('h3', {}, el('span', { class: 'grow' }, 'Suggestions'),
      el('label', { class: 'help', style: { textTransform: 'none', letterSpacing: 0, display: 'flex', gap: '4px', alignItems: 'center' } },
        el('input', { type: 'checkbox', checked: this.showSpots, onchange: e => { this.showSpots = e.target.checked; this._updatePlot(); } }), 'on map'));
    if (!this.hist) { box.replaceChildren(head, el('div', { class: 'help' }, 'Load history to find the spots where people spend time.')); return; }
    const u = this.units;
    const rows = (this.spots || []).map((sp, i) => {
      const badgeColor = sp.cls.kind === 'ghost' ? EXCLUDE_COLOR : sp.cls.kind === 'spot' ? '#43a047' : '#f9a825';
      const create = kind => this._spotToZone(sp, kind);
      return el('div', {
        class: 'spot-row', onmouseenter: () => { this.hoverSpot = i; this._updatePlot(); }, onmouseleave: () => { this.hoverSpot = null; this._updatePlot(); },
      },
        el('div', { class: 'spot-head' },
          el('b', {}, `Suggestion ${sp.n}`),
          el('span', { class: 'help' }, `${fmtDuration(sp.dwell)} · ${u.fmtLong(Math.hypot(...sp.centroid))} away`),
          el('span', { class: 'badge', style: { background: badgeColor, color: '#fff' }, title: sp.cls.share === null ? '' : `${Math.round(sp.cls.share * 100)}% of visits began with a trail walking in` }, sp.cls.label)),
        el('div', { class: 'help' }, this._trailSummary(sp.stats)),
        ...(this.details ? sp.cross : []).map(c => el('div', { class: 'help', title: 'Visits to this spot that the other radar also saw (a target within 60 cm at the same time), and how often it sees people here by itself' },
          `${c.name} saw ${c.confirmed} of ${c.visits} visits (sees ${c.peerVisits} of its own here)${sp.ghostBy === c ? ' — this radar\'s ghost' : ''}`)),
        sp.covered ? el('div', { class: 'help' }, `inside “${sp.covered.name}”`) : '',
        el('div', { class: 'actions', style: { marginTop: '4px' } },
          el('button', { class: 'btn', onclick: () => create('include') }, '+ Room'),
          el('button', {
            class: sp.hold && sp.cls.kind !== 'ghost' ? 'btn primary' : 'btn',
            title: 'A place people stay: someone the radar loses here is still here, so the room stays occupied',
            onclick: () => create('linger'),
          }, '+ Spot'),
          el('button', { class: sp.cls.kind === 'ghost' ? 'btn primary' : 'btn', onclick: () => create('exclude') }, '+ Ignore')));
    });
    box.replaceChildren(head,
      el('div', { class: 'help' }, `Where detections stayed${this.brush ? ' in the trimmed range' : ''}. A real place (desk, chair) has trails walking in and out; a ghost (plant, fan, reflection) appears and vanishes in place, or stays within a few centimetres of one point.`),
      !(this.editing || this.details) ? '' : el('div', { class: 'form', style: { margin: '8px 0' } },
        el('label', {}, `Margin (${u.label})`),
        this._marginInput(() => { this._computeSpots(); this._renderSpots(); this._updatePlot(); })),
      ...(rows.length ? rows : [el('div', { class: 'help' }, 'No dwell spots in this range.')]));
  }

  _settingsSection() {
    return el('div', { class: 'section' },
      el('h3', {}, 'Radar'),
      el('div', { class: 'form' },
        el('label', {}, 'Ignore after reconnect (s)'),
        el('input', { type: 'number', min: 0, step: 1, value: this.settings.reconnect_grace_s, onchange: e => { this.settings = { ...this.settings, reconnect_grace_s: Math.max(0, +e.target.value || 0) }; this._renderHeader(); this._recomputePreview(); } }),
        el('div', { class: 'help full' }, 'Ignore detections for this long after the radar comes back from unavailable (ghosts often appear right after a reconnect).'),
        el('label', { class: 'check full' },
          el('input', { type: 'checkbox', checked: this.settings.headcount !== false, onchange: e => { this.settings = { ...this.settings, headcount: e.target.checked }; this._renderHeader(); } }),
          el('span', {}, 'Use to count occupants',
            el('div', { class: 'help' }, 'Count occupants in this radar\'s area (home, per floor, per room). Turn off for a radar that mostly sees ghosts (through a glass door, say): its area is then counted at its doors, like a room without a radar.'))),
      ),
      this._orientationSection());
  }

  _setDisplay(patch) {
    if (!this.editing) this._enterEdit();
    this.settings = { ...this.settings, display: normalizeDisplay({ ...this.settings.display, ...patch }) };
    this._updatePlot();
    this.plot.fit();
    this._renderToolbar();
    this._renderHeader();
    this._renderSide();
  }

  /** How the map is drawn relative to the room. View only: zones stay in the sensor's frame. */
  _orientationSection() {
    const d = this.settings.display;
    const dev = this.config.device_mounting || {};
    const fw = [];
    if (dev.upside_down !== undefined) fw.push(`upside-down mounting ${dev.upside_down ? 'on' : 'off'}`);
    if (dev.installation_angle_deg !== undefined) fw.push(`installation angle ${dev.installation_angle_deg}° (not used here)`);
    return el('div', { class: 'form', style: { marginTop: '10px' } },
      el('label', {}, 'Mounting'),
      el('select', { onchange: e => this._setDisplay({ mirror: e.target.value === '1' }) },
        el('option', { value: '0', selected: !d.mirror }, 'Upright'),
        el('option', { value: '1', selected: d.mirror }, 'Upside down (left ↔ right)')),
      el('label', {}, 'Rotate view (°)'),
      el('input', { type: 'number', step: 5, value: d.rotation, title: 'Any angle, e.g. 45 for a sensor mounted in a corner', onchange: e => this._setDisplay({ rotation: +e.target.value || 0 }) }),
      el('div', { class: 'help full' },
        'Check: stand behind the sensor and walk to your right; your dot should move right on the map (sensor at the bottom). If it moves left, switch this. ',
        'Only the view changes; shapes stay where they are relative to the sensor. Saved with the shapes.'),
      fw.length ? el('div', { class: 'help full' }, `Device: ${fw.join(', ')}. Mounting defaults to the device's upside-down setting; the rotation here is this panel's own.`) : '',
      ...this._alignControls());
  }

  /** Align this radar's view with another radar that sees part of the same space. */
  _alignControls() {
    const others = this.radars.filter(r => r.radar_id !== this.radarId);
    if (!others.length) return [];
    const a = this._align?.radarId === this.radarId ? this._align : null;
    const saved = this.settings.display.aligned_to;
    this._alignRef ||= saved?.radar_id && others.some(r => r.radar_id === saved.radar_id) ? saved.radar_id : others[0].radar_id;
    let status = '';
    if (a?.busy) status = `Matching against ${a.title}…`;
    else if (a?.error) status = a.error;
    else if (saved) {
      status = `Linked with ${saved.title}: ${saved.agree} of ${saved.pairs} moments when both saw one person agree. `
        + `This radar is turned ${Math.abs(saved.angle_deg).toFixed(0)}° relative to it`
        + `${saved.offset_mm ? `, about ${(Math.hypot(...saved.offset_mm) / 1000).toFixed(1)} m away` : ''}.`;
    }
    return [
      el('label', { class: 'align-anchor' }, 'Line up with'),
      el('div', { style: { display: 'flex', gap: '6px' } },
        el('select', { style: { flex: 1, minWidth: 0 }, onchange: e => { this._alignRef = e.target.value; } },
          others.map(r => el('option', { value: r.radar_id, selected: r.radar_id === this._alignRef }, r.title))),
        el('button', { class: 'btn', disabled: !this.hist || a?.busy, title: 'Rotate this view to match the other radar, from moments when both radars saw the same person', onclick: () => this._alignWith(this._alignRef) }, 'Line up')),
      el('div', { class: 'help full' }, 'For radars that overlap (one sees into the other\'s room): finds the rotation from the times both saw the same person, and lines this view up with the other radar\'s. Linked radars share their shapes.', status ? el('div', { style: { marginTop: '4px', color: a?.error ? 'var(--error-color, #db4437)' : '' } }, status) : ''),
    ];
  }

  async _alignWith(refId) {
    const ref = this.radars.find(r => r.radar_id === refId);
    if (!this.hist || !ref) return;
    const radarId = this.radarId;
    this._align = { radarId, busy: true, title: ref.title };
    this._renderSide();
    try {
      const range = { start: new Date(this.hist.start * 1000).toISOString(), end: new Date(this.hist.end * 1000).toISOString() };
      const [cfg, refHist] = await Promise.all([
        this.hass.callWS({ type: `${DOMAIN}/config`, radar_id: refId }),
        this.hass.callWS({ type: `${DOMAIN}/frames/history`, radar_id: refId, ...range }),
      ]);
      if (radarId !== this.radarId) return;
      const reg = registerRigid(pairDetections(refHist, this.hist));
      if (!reg || reg.inliers < 30 || reg.inliers / reg.n < 0.3) {
        this._align = { radarId, error: reg
          ? `Not enough overlap with ${ref.title}: only ${reg.inliers} of ${reg.n} moments agree. Try a longer history range.`
          : `${ref.title} and this radar rarely see one person at the same time in this range.` };
        this._renderSide();
        return;
      }
      const refDisplay = normalizeDisplay(cfg.settings.display || {}, { upsideDown: cfg.device_mounting?.upside_down });
      this._align = { radarId };
      this._setDisplay({
        ...viewToMatch(refDisplay, reg),
        aligned_to: {
          radar_id: refId, title: ref.title, angle_deg: Math.round(reg.angleDeg * 10) / 10, reflect: reg.reflect,
          offset_mm: reg.t.map(Math.round), pairs: reg.n, agree: reg.inliers, rms_mm: Math.round(reg.rms),
        },
      });
      this._loadPeers();
    } catch (err) {
      this._align = { radarId, error: `Alignment failed: ${err.message || err.code}` };
      this._renderSide();
    }
  }

  // ---------------------------------------------------------------- doors

  /** Door contacts in Home Assistant (device class door / garage door / opening). */
  _doorCandidates() {
    return Object.values(this.hass.states)
      .filter(st => st.entity_id.startsWith('binary_sensor.') && ['door', 'garage_door', 'opening'].includes(st.attributes.device_class))
      .map(st => st.entity_id);
  }

  /** 'Garage Entry Door Sensor Door' -> 'Garage Entry Door'. */
  _exitNameFor(id) {
    return this._doorName(id).replace(/\b(contact|sensor)\b/gi, ' ').replace(/\s+/g, ' ').trim().replace(/\b(\w+)\s+\1$/i, '$1');
  }

  _doorName(id) {
    return this.hass.states[id]?.attributes.friendly_name || id;
  }

  /** History of every door contact over the loaded window, and how each lines up with this radar. */
  async _loadDoors() {
    const ids = [...new Set([...this._doorCandidates(), ...this.zones.map(z => z.door_entity_id).filter(Boolean)])];
    const radarId = this.radarId;
    this.doors = {};
    if (!ids.length || !this.hist) return;
    try {
      const res = await this.hass.callWS({
        type: 'history/history_during_period', entity_ids: ids, minimal_response: true, no_attributes: true,
        significant_changes_only: false, start_time: new Date(this.hist.start * 1000).toISOString(), end_time: new Date().toISOString(),
      });
      if (radarId !== this.radarId) return;
      for (const id of ids) this.doors[id] = { rows: (res[id] || []).map(r => [r.lu ?? r.last_updated ?? this.hist.start, r.s ?? r.state]) };
    } catch (err) {
      this._toast(`Door history unavailable: ${err.message || err.code}`, true);
      return;
    }
    this._analyseDoors();
    this._renderTimeline();
    this._renderSide();
    this._updatePlot();
  }

  _analyseDoors() {
    if (!this.hist) return;
    const exclusions = this.zones.filter(z => z.kind === 'exclude' && !validatePolygon(z.polygon));
    for (const d of Object.values(this.doors)) {
      d.events = doorEvents(d.rows);
      d.pos = doorPositions(this.hist, d.events, { exclusions });
    }
  }

  /** Live door changes (hass state updates) extend the door history. */
  _updateDoorStates() {
    let changed = false;
    for (const [id, d] of Object.entries(this.doors || {})) {
      const st = this.hass.states[id]?.state;
      const last = d.rows[d.rows.length - 1];
      if (st && (!last || last[1] !== st)) { d.rows.push([Date.now() / 1000, st]); changed = true; }
    }
    if (changed) { this._renderTimeline(); this._updatePlot(); this._renderLiveBadges(); }
  }

  /** Door open at epoch t (from its history), or now (null: current state). */
  _doorOpenAt(id, t) {
    if (t == null) return this.hass.states[id]?.state === 'on';
    const rows = this.doors[id]?.rows || [];
    let lo = 0, hi = rows.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid][0] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans >= 0 && rows[ans][1] === 'on';
  }

  _doorStats(id) {
    const pos = this.doors[id]?.pos;
    if (!pos || !pos.events) return null;
    return { events: pos.events, hits: pos.hits, share: pos.hits / pos.events };
  }

  /** Place (or re-place) an exit from where people stood when its door opened or closed. */
  _placeFromDoor(id) {
    const pos = this.doors[id]?.pos;
    return pos && pos.points.length ? placeExit(pos.points) : null;
  }

  /** With an exit selected: where people stood when its door opened or closed. */
  _doorMarkers() {
    const z = this.zones.find(q => q.id === this.selectedId);
    const pts = z?.kind === 'exit' && z.door_entity_id ? this.doors[z.door_entity_id]?.pos?.points : null;
    return pts ? pts.map(([x, y]) => ({ x, y, color: EXIT_COLOR })) : [];
  }

  /** HA areas for "Leads to", by floor (highest first), plus outside. */
  _areaOptions() {
    const floors = this.hass.floors || {};
    const areas = Object.values(this.hass.areas || {});
    const level = a => floors[a.floor_id]?.level ?? -999;
    return areas
      .sort((a, b) => level(b) - level(a) || a.name.localeCompare(b.name))
      .map(a => ({ id: a.area_id, name: a.name, floor: floors[a.floor_id]?.name || '' }));
  }

  _leadsToEditor(z) {
    const sel = new Set(z.leads_to || []);
    const toggle = (id, on) => {
      const next = new Set(sel);
      if (on) next.add(id); else next.delete(id);
      this._patchZone(z.id, { leads_to: [...next] }, { renderSide: true });
    };
    const myArea = this.config?.device_area_id;
    const box = (id, label, sub) => el('label', { class: 'check', style: { display: 'flex', gap: '6px', alignItems: 'baseline' } },
      el('input', { type: 'checkbox', checked: sel.has(id), onchange: e => toggle(id, e.target.checked) }),
      el('span', {}, label, sub ? el('span', { class: 'help' }, ` · ${sub}`) : ''));
    return [
      el('label', {}, 'Leads to'),
      el('div', { style: { maxHeight: '140px', overflowY: 'auto', border: '1px solid var(--divider-color, #ddd)', borderRadius: '4px', padding: '4px 6px' } },
        box('outside', 'Outside', 'a door out of the home'),
        this._areaOptions().filter(a => a.id !== myArea).map(a => box(a.id, a.name, a.floor))),
      el('div', { class: 'help full' },
        'Where people go through this doorway: another room (the stairs to the floor above, a bedroom without a radar) or outside. Counting uses it to tell who a person appearing here is, and that nobody appears without a door. ',
        sel.size ? '' : 'Not set: occupant counting ignores this doorway.'),
    ];
  }

  _exitEditor(z) {
    const cands = Object.keys(this.doors).length ? Object.keys(this.doors) : this._doorCandidates();
    const ranked = cands
      .map(id => ({ id, st: this._doorStats(id) }))
      .sort((a, b) => (b.st?.share || 0) - (a.st?.share || 0) || this._doorName(a.id).localeCompare(this._doorName(b.id)));
    const st = z.door_entity_id ? this._doorStats(z.door_entity_id) : null;
    return [
      ...this._leadsToEditor(z),
      el('label', {}, 'Door sensor'),
      el('select', { onchange: e => this._patchZone(z.id, { door_entity_id: e.target.value || null }, { renderSide: true }) },
        el('option', { value: '', selected: !z.door_entity_id }, 'None (an open doorway or stairs)'),
        ranked.map(({ id, st: s }) => el('option', { value: id, selected: id === z.door_entity_id },
          `${this._doorName(id)}${s && s.events ? ` · seen at ${Math.round(s.share * 100)}% of ${s.events}` : ''}`))),
      el('div', { class: 'help full' },
        'A doorway: where people come into and leave the room. With a door sensor, its openings show on the timeline and the map. ',
        st ? `Someone was in view at ${st.hits} of the ${st.events} times this door opened or closed in the loaded range.` : ''),
      el('label', {}, 'Door'),
      el('select', { onchange: e => this._patchZone(z.id, { door: e.target.value ? { swing: e.target.value, hinge_end: z.door?.hinge_end || 0 } : null }, { renderSide: true }) },
        el('option', { value: '', selected: !z.door }, 'None (open doorway, stairs)'),
        el('option', { value: 'none', selected: z.door?.swing === 'none' }, 'Door without swing (sliding, pocket)'),
        el('option', { value: 'in', selected: z.door?.swing === 'in' }, 'Swings into this room'),
        el('option', { value: 'out', selected: z.door?.swing === 'out' }, 'Swings out of this room')),
      z.door ? el('div', { class: 'actions full' },
        z.door.swing !== 'none' ? el('button', { class: 'btn', title: 'Move the hinge to the other end of the threshold', onclick: () => this._patchZone(z.id, { door: { ...z.door, hinge_end: z.door.hinge_end ? 0 : 1 } }, { renderSide: true }) }, 'Flip hinge') : '',
        z.polygon.length !== 4 ? el('button', { class: 'btn', title: 'Replace the outline with its bounding rectangle along the longest edge: the threshold', onclick: () => this._patchZone(z.id, { polygon: doorGeometry(z.polygon, null).rect.map(p => [Math.round(p[0]), Math.round(p[1])]) }, { renderSide: true }) }, 'Make rectangle') : '',
        el('div', { class: 'help', style: { width: '100%' } }, 'Draw the doorway as the threshold rectangle; the leaf hinges on one end and swings over the side you pick. People pulling a door towards them stand clear of the swing; pushing it, they stand right at it.')) : '',
      z.door_entity_id && this.hist ? el('div', { class: 'actions full' },
        el('button', {
          class: 'btn', title: 'Redraw this doorway around where people stood when the door opened or closed',
          onmouseenter: () => { this.fitPreview = this._placeFromDoor(z.door_entity_id); this._updatePlot(); },
          onmouseleave: () => { this.fitPreview = null; this._updatePlot(); },
          onclick: () => {
            const poly = this._placeFromDoor(z.door_entity_id);
            this.fitPreview = null;
            if (!poly) { this._toast('Nobody was in view when this door opened or closed in the loaded range.', true); return; }
            this._patchZone(z.id, { polygon: poly }, { renderSide: true });
          },
        }, 'Place from door events')) : '',
    ];
  }

  /** Door contacts that line up with this radar: someone in view when they open or close. */
  _doorsSection() {
    const linked = new Map(this.zones.filter(z => z.kind === 'exit' && z.door_entity_id).map(z => [z.door_entity_id, z]));
    const rows = Object.keys(this.doors)
      .map(id => ({ id, st: this._doorStats(id) }))
      .filter(r => r.st && r.st.events >= 2 && r.st.share >= 0.5)
      .sort((a, b) => b.st.share - a.st.share || b.st.events - a.st.events);
    if (!rows.length && !linked.size) return '';
    return el('div', { class: 'section' },
      el('h3', {}, 'Doors'),
      el('div', { class: 'help' }, 'Door sensors that line up with this radar: someone is in view when they open or close. Add one as a doorway; it is placed where people stand at the door.'),
      rows.map(({ id, st }) => {
        const z = linked.get(id);
        return el('div', { class: 'spot-row' },
          el('div', { class: 'spot-head' }, el('b', {}, this._doorName(id))),
          el('div', { class: 'help' }, `seen at ${st.hits} of ${st.events} openings/closings (${Math.round(st.share * 100)}%)`),
          z ? el('div', { class: 'help' }, `doorway “${z.name}”`)
            : el('div', { class: 'actions' },
              el('button', {
                class: 'btn',
                onmouseenter: () => { this.fitPreview = this._placeFromDoor(id); this._updatePlot(); },
                onmouseleave: () => { this.fitPreview = null; this._updatePlot(); },
                onclick: () => {
                  const poly = this._placeFromDoor(id);
                  this.fitPreview = null;
                  if (poly) this._addZone(poly, 'exit', this._exitNameFor(id), {}, { door_entity_id: id });
                },
              }, '+ Doorway')));
      }));
  }

  _renderLiveBadges() {
    if (!this.side) return;
    for (const b of this.side.querySelectorAll('[data-live]')) {
      const id = b.dataset.live;
      const z = this.zones.find(q => q.id === id);
      if (z?.kind === 'exclude' || isSpot(z?.kind)) continue;
      if (z?.kind === 'exit') {
        const st = z.door_entity_id ? this.hass.states[z.door_entity_id]?.state : null;
        b.textContent = st === 'on' ? 'open' : st === 'off' ? 'closed' : 'doorway';
        b.classList.toggle('on', st === 'on');
        continue;
      }
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
    if (!this.showFrames || !this.hist || (this.mode !== 'replay' && this.mode !== 'live')) {
      box.replaceChildren(this.showFrames ? el('div', { class: 'help', style: { padding: '8px' } }, 'Click the timeline to play back; raw readings around the playhead show here.') : '');
      return;
    }
    const i = this._frameAt(this.cursor - this.hist.start);
    const inc = this.zones.filter(z => z.kind !== 'exclude' && !validatePolygon(z.polygon));
    const exc = this.zones.filter(z => z.kind === 'exclude');
    // This radar's frames around the cursor, and the aligned radars' frames with someone in them (in this frame):
    // they are fused with this radar's, so they can turn its zones on too.
    const frames = []; // {t, own, j?, targets: [[label, color, x, y, excluded]]}
    for (let j = Math.max(0, i - 40); j <= Math.min(this.hist.frame_t.length - 1, i + 40); j++) {
      frames.push({ t: this.hist.start + this.hist.frame_t[j], own: true, j,
        targets: this._targetsOfFrame(j).map(([slot, x, y]) => [`T${slot}`, slotColor(slot), x, y, exc.some(z => pointInPolygon(x, y, z.polygon))]) });
    }
    const overlays = this._peerOverlays();
    [...(this.peerHist || new Map()).keys()].filter(id => this._peerTransforms().has(id)).forEach((id, n) => {
      const hist = this.peerHist.get(id), peer = this.peers.get(id), T = this._peerTransforms().get(id);
      if (!peer || !T) return;
      const name = peer.title.replace(/^(Everything Presence Lite|Human Sensor 2A)\s*/, '');
      const color = overlays.find(o => o.title === name)?.color || '#7e57c2';
      const pexc = peer.cfg.zones.filter(z => z.kind === 'exclude' && !validatePolygon(z.polygon));
      const { i: pi, starts } = this._peerFrames(hist, this.cursor);
      for (let j = Math.max(0, pi - 40); j <= Math.min(hist.frame_t.length - 1, pi + 40); j++) {
        if (!hist.frame_n[j]) continue;
        const targets = [];
        for (let k = starts[j]; k < starts[j + 1]; k++) {
          const [x, y] = affineApply(T, [hist.x[k], hist.y[k]]);
          targets.push([`${name} T${hist.slot[k]}`, color, x, y, pexc.some(z => pointInPolygon(hist.x[k], hist.y[k], z.polygon))]);
        }
        frames.push({ t: hist.start + hist.frame_t[j], own: false, targets });
      }
    });
    frames.sort((p, q) => p.t - q.t || q.own - p.own);
    let at = -1;
    for (let k = 0; k < frames.length; k++) if (frames[k].t <= this.cursor + 1e-6) at = k;
    const rows = [];
    for (let k = Math.max(0, at - 12); k <= Math.min(frames.length - 1, at + 6); k++) {
      const f = frames[k];
      const states = inc.map(z => (this._zoneOnAt(z.id, f.t) ? 'on' : 'off'));
      const cls = k === at ? 'cur' : f.own ? '' : 'peer';
      if (!f.targets.length) {
        rows.push(el('tr', { class: cls, onclick: () => this._seek(f.t) }, el('td', {}, fmtTime(f.t, true, true)), el('td', {}, '—'), el('td', {}, ''), el('td', {}, ''),
          inc.map((z, n) => el('td', {}, states[n]))));
      }
      f.targets.forEach(([label, color, x, y, excluded], n) => {
        rows.push(el('tr', { class: cls, onclick: () => this._seek(f.t) },
          el('td', {}, n === 0 ? fmtTime(f.t, true, true) : ''),
          el('td', { style: { color } }, `${label}${excluded ? ' (excl)' : ''}`),
          el('td', {}, this.units.fmtLong(x)),
          el('td', {}, this.units.fmtLong(y)),
          inc.map((z, m) => {
            const inside = !excluded && pointInPolygon(x, y, z.polygon);
            return el('td', { class: excluded ? 'ex' : inside ? 'in' : '' }, `${inside ? 'in' : '·'} / ${states[m]}`);
          })));
      });
    }
    queueMicrotask(() => box.querySelector('tr.cur')?.scrollIntoView({ block: 'center' }));
    box.replaceChildren(el('table', {},
      el('tr', {}, el('th', {}, 'time'), el('th', {}, 'track'), el('th', {}, 'x'), el('th', {}, 'y'), inc.map(z => el('th', {}, `${z.name} (inside / on)`))),
      rows));
  }

  _toast(msg, error = false) {
    const t = el('div', { class: `toast${error ? ' error' : ''}` }, msg);
    this.shadowRoot.append(t);
    setTimeout(() => t.remove(), error ? 6000 : 2500);
  }
}

customElements.get('radar-zone-presence-panel') || customElements.define('radar-zone-presence-panel', RadarZonePresencePanel);
