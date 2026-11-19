// Plan mode for the House view: a floor drawn from its room shapes, in the frame
// of the linked radars that see it (one map per alignment group). The geometry
// only; headcount.js puts the room labels (count, people, ±) on top.

import { fovPolygon, polygonArea, validatePolygon } from './engine.js';
import { KIND_STYLE, SVGNS, affineApply, radarTransforms } from './util.js';

const DOMAIN = 'radar_zone_presence';

/** Every radar's config, grouped by the map (alignment group) it is drawn on. */
export async function loadMaps(hass) {
  const list = await hass.callWS({ type: `${DOMAIN}/list` });
  const cfgs = await Promise.all(list.radars.map(r => hass.callWS({ type: `${DOMAIN}/config`, radar_id: r.radar_id }).catch(() => null)));
  const maps = new Map(); // anchor -> [{radar, cfg}]
  list.radars.forEach((r, i) => {
    const cfg = cfgs[i];
    if (!cfg) return;
    const anchor = cfg.group?.anchor || r.radar_id;
    if (!maps.has(anchor)) maps.set(anchor, []);
    maps.get(anchor).push({ radar: r, cfg });
  });
  return [...maps.entries()].map(([anchor, radars]) => {
    const T = radarTransforms(anchor, radars.map(({ radar, cfg }) => ({ radar_id: radar.radar_id, aligned_to: cfg.settings?.display?.aligned_to })));
    const at = id => (id === anchor ? p => p : p => affineApply(T.get(id) || [[1, 0, 0], [0, 1, 0]], p));
    const shapes = [], cones = [];
    for (const { radar, cfg } of radars) {
      const f = at(radar.radar_id);
      cones.push({ radar: radar.radar_id, polygon: fovPolygon(cfg.fov.max_distance_mm, cfg.fov.half_angle_deg, 24).map(f), origin: f([0, 0]) });
      for (const z of cfg.zones) {
        if (validatePolygon(z.polygon) || z.kind === 'exclude' || z.kind === 'transient') continue;
        const kind = z.kind === 'include' && z.spot ? 'linger' : z.kind;
        shapes.push({ id: z.id, radar: radar.radar_id, kind, name: z.name, area: kind === 'include' ? z.area_id || cfg.device_area_id : null, polygon: z.polygon.map(f), leads_to: z.leads_to || [] });
      }
    }
    const display = radars.find(x => x.radar.radar_id === anchor)?.cfg.settings?.display || {};
    return { anchor, radars: radars.map(x => x.radar.radar_id), shapes, cones, display };
  });
}

/** The best map for a floor: the one holding most of its rooms (at least two). {map, areas: Set} or null. */
export function planFor(maps, areaIds) {
  let best = null;
  for (const m of maps) {
    const areas = new Set(m.shapes.filter(s => s.kind === 'include' && areaIds.has(s.area)).map(s => s.area));
    if (areas.size >= 2 && (!best || areas.size > best.areas.size)) best = { map: m, areas };
  }
  return best;
}

/** Centre of a polygon's area (falls back to the vertex mean for degenerate shapes). */
export function centroid(poly) {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    const c = x0 * y1 - x1 * y0;
    a += c; x += (x0 + x1) * c; y += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-6) return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  return [x / (3 * a), y / (3 * a)];
}

/**
 * Draw a floor plan. `occupied(area)` -> count. Returns {svg, place(area) -> [x%, y%] of the room's label, size}.
 * Rooms of other floors on the same map are left out; doorways and spots are kept when they touch a room drawn.
 */
export function drawPlan(plan, { occupied = () => 0, dark = false, onRoom = null } = {}) {
  const { map, areas } = plan;
  const d = map.display || {};
  const r = ((d.rotation || 0) * Math.PI) / 180, m = d.mirror ? -1 : 1;
  const tf = ([x, y]) => [Math.cos(r) * m * x - Math.sin(r) * y, Math.sin(r) * m * x + Math.cos(r) * y];
  const rooms = map.shapes.filter(s => s.kind === 'include' && areas.has(s.area));
  const roomPts = rooms.flatMap(s => s.polygon.map(tf));
  const xs = roomPts.map(p => p[0]), ys = roomPts.map(p => p[1]);
  const pad = 400;
  const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  const W = x1 - x0, H = y1 - y0;
  const sx = p => { const [x, y] = tf(p); return [x - x0, y1 - y]; };
  const inBox = s => s.polygon.some(p => { const [x, y] = sx(p); return x >= 0 && y >= 0 && x <= W && y <= H; });
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W.toFixed(0)} ${H.toFixed(0)}`);
  svg.setAttribute('class', 'plan-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const add = (tag, attrs, parent = svg) => { const n = document.createElementNS(SVGNS, tag); for (const [a, v] of Object.entries(attrs)) n.setAttribute(a, v); parent.append(n); return n; };
  const pts = poly => poly.map(p => sx(p).map(v => v.toFixed(0)).join(',')).join(' ');
  const tone = k => KIND_STYLE[k][dark ? 'dark' : 'light'];
  // What the radars see: a soft wash.
  for (const c of map.cones) add('polygon', { points: pts(c.polygon), fill: 'currentColor', 'fill-opacity': 0.035 });
  for (const s of rooms) {
    const n = occupied(s.area);
    const g = add('polygon', {
      points: pts(s.polygon), fill: tone('include'), 'fill-opacity': n ? 0.26 : 0.08, stroke: tone('include'), 'stroke-opacity': 0.55, 'stroke-width': W / 300,
      class: onRoom ? 'room link' : 'room',
    });
    if (onRoom) g.addEventListener('click', () => onRoom(s));
  }
  for (const s of map.shapes) {
    if (s.kind === 'include' || !inBox(s)) continue;
    add('polygon', { points: pts(s.polygon), fill: tone(s.kind), 'fill-opacity': s.kind === 'exit' ? 0.45 : 0.25, stroke: tone(s.kind), 'stroke-opacity': 0.7, 'stroke-width': W / 500 });
  }
  for (const c of map.cones) {
    const [x, y] = sx(c.origin);
    if (x >= 0 && y >= 0 && x <= W && y <= H) add('circle', { cx: x.toFixed(0), cy: y.toFixed(0), r: W / 120, fill: 'currentColor', 'fill-opacity': 0.6 });
  }
  // Label position per area: the biggest shape's centre.
  const label = new Map();
  for (const s of rooms) {
    const [cx, cy] = sx(centroid(s.polygon));
    const sz = Math.abs(polygonArea(s.polygon));
    if (!label.has(s.area) || sz > label.get(s.area).sz) label.set(s.area, { x: (100 * cx) / W, y: (100 * cy) / H, sz });
  }
  return { svg, place: a => label.get(a), aspect: H / W };
}
