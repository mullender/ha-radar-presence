// Zone export / import: move a radar's zones between Home Assistant instances
// (or back up and restore them). Coordinates are millimetres, like storage.
import { validatePolygon } from './engine.js';
import { newZoneId } from './util.js';

export const FORMAT = 'radar_zone_presence/zones';
export const VERSION = 1;

const FILTER_DEFAULTS = { on_delay_s: 0, off_delay_s: 0, edge_margin_mm: 0, hold_until_exit: false, hold_max_s: 0 };
const FILTER_LIMITS = { on_delay_s: 3600, off_delay_s: 3600, edge_margin_mm: 2000, hold_max_s: 86400 };

/** Serialisable document for one radar's zones and settings. */
export function exportZones(radar, zones, settings = {}) {
  return {
    format: FORMAT,
    version: VERSION,
    exported_at: new Date().toISOString(),
    radar: { title: radar.title, profile: radar.profile ?? null },
    settings: { reconnect_grace_s: Number(settings.reconnect_grace_s) || 0 },
    zones: zones.map(z => ({
      id: z.id, name: z.name, kind: z.kind,
      polygon: z.polygon.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]),
      filters: { ...FILTER_DEFAULTS, ...(z.filters || {}) },
      area_id: z.area_id ?? null,
    })),
  };
}

export const exportFilename = radar =>
  `radar-zones-${(radar.title || 'radar').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;

function cleanFilters(raw = {}) {
  const f = { ...FILTER_DEFAULTS };
  for (const [k, max] of Object.entries(FILTER_LIMITS)) {
    if (raw[k] === undefined) continue;
    const v = Number(raw[k]);
    if (!Number.isFinite(v) || v < 0 || v > max) throw new Error(`${k} must be between 0 and ${max}`);
    f[k] = v;
  }
  if (raw.hold_until_exit !== undefined) f.hold_until_exit = !!raw.hold_until_exit;
  return f;
}

/**
 * Parse and validate an export. Throws with a readable message on bad input.
 * Returns { radar, settings, zones } with zones normalised (not yet merged).
 */
export function parseImport(text) {
  let doc;
  try { doc = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('Not a JSON file'); }
  if (!doc || doc.format !== FORMAT) throw new Error('Not a Radar Zone Presence zones export');
  if (doc.version > VERSION) throw new Error(`Export version ${doc.version} is newer than this integration understands`);
  if (!Array.isArray(doc.zones)) throw new Error('Export has no zones');
  const zones = doc.zones.map((z, i) => {
    const label = `zone ${i + 1}${z?.name ? ` (${z.name})` : ''}`;
    if (!z || typeof z.name !== 'string' || !z.name.trim()) throw new Error(`${label}: missing name`);
    if (z.kind !== 'include' && z.kind !== 'exclude') throw new Error(`${label}: kind must be include or exclude`);
    if (!Array.isArray(z.polygon) || !z.polygon.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) {
      throw new Error(`${label}: polygon must be a list of [x, y] points`);
    }
    const err = validatePolygon(z.polygon);
    if (err) throw new Error(`${label}: ${err}`);
    let filters;
    try { filters = cleanFilters(z.filters); } catch (e) { throw new Error(`${label}: ${e.message}`); }
    return {
      id: typeof z.id === 'string' && z.id ? z.id : null,
      name: z.name.trim().slice(0, 100), kind: z.kind,
      polygon: z.polygon.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]),
      filters, area_id: typeof z.area_id === 'string' ? z.area_id : null,
    };
  });
  const grace = Number(doc.settings?.reconnect_grace_s);
  return {
    radar: doc.radar || {},
    settings: Number.isFinite(grace) && grace >= 0 && grace <= 600 ? { reconnect_grace_s: grace } : {},
    zones,
  };
}

/**
 * Merge imported zones into the current ones. A zone with the same id, or else
 * the same name and kind, is replaced in place and keeps the current id (so its
 * entity survives); the rest are added. Area overrides that do not exist here
 * fall back to inheriting the radar's area.
 */
export function mergeZones(current, imported, { areaIds = null } = {}) {
  const out = current.map(z => ({ ...z }));
  const used = new Set(out.map(z => z.id));
  let replaced = 0;
  let added = 0;
  for (const z of imported) {
    const area_id = z.area_id && (!areaIds || areaIds.has(z.area_id)) ? z.area_id : null;
    let i = z.id ? out.findIndex(q => q.id === z.id) : -1;
    if (i < 0) i = out.findIndex(q => q.name.trim().toLowerCase() === z.name.toLowerCase() && q.kind === z.kind);
    if (i >= 0) {
      out[i] = { ...z, id: out[i].id, area_id };
      replaced++;
    } else {
      const id = z.id && !used.has(z.id) ? z.id : newZoneId();
      used.add(id);
      out.push({ ...z, id, area_id });
      added++;
    }
  }
  return { zones: out, replaced, added };
}
