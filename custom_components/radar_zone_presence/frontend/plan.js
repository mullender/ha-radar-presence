// Plan mode for the House view: a floor drawn from its room shapes, in the frame
// of the linked radars that see it (one map per alignment group). The geometry
// only; headcount.js puts the room labels (count, people, ±) on top.

import { fovPolygon, pointInPolygon, polygonArea, signedDistance, validatePolygon } from './engine.js';
import { KIND_STYLE, SVGNS, affineApply, radarTransforms, slotColor } from './util.js';

const DOMAIN = 'radar_zone_presence';
const SPOT_MAX_MM2 = 6e6;

/**
 * Room shapes that are spots in all but name (older spots were drawn as rooms, "Desk"): inside another room shape,
 * or small (under 6 m²), in the same area as a room shape more than twice as big, and touching no room shape
 * (a strip that extends a room overlaps it; a desk drawn on its own doesn't). A Set of zone ids. (learning.py: same rule.)
 */
export function spotLike(zones) {
  const rooms = zones.filter(z => z.kind === 'include' && !z.spot && !validatePolygon(z.polygon));
  const size = z => Math.abs(polygonArea(z.polygon));
  // Corners within `tol` mm of b (or inside it): shapes drawn with snapping share edges exactly.
  const near = (a, b, tol) => a.polygon.filter(([x, y]) => signedDistance(x, y, b.polygon) >= -tol).length;
  const nested = z => rooms.some(o => o !== z && size(o) > size(z) && near(z, o, 50) >= 0.75 * z.polygon.length);
  const touches = (a, b) => near(a, b, 150) > 0 || near(b, a, 150) > 0;
  const alone = z => size(z) < SPOT_MAX_MM2 && rooms.some(o => o !== z && (o.area_id || null) === (z.area_id || null) && size(o) > 2 * size(z))
    && !rooms.some(o => o !== z && touches(z, o));
  return new Set(rooms.filter(z => nested(z) || alone(z)).map(z => z.id));
}

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
    const shapes = [], cones = [], ignores = [];
    for (const { radar, cfg } of radars) {
      const f = at(radar.radar_id);
      cones.push({ radar: radar.radar_id, polygon: fovPolygon(cfg.fov.max_distance_mm, cfg.fov.half_angle_deg, 24).map(f), origin: f([0, 0]) });
      const spots = spotLike(cfg.zones);
      for (const z of cfg.zones) {
        if (validatePolygon(z.polygon) || z.kind === 'transient') continue;
        if (z.kind === 'exclude') { ignores.push({ radar: radar.radar_id, polygon: z.polygon }); continue; } // radar frame: for hollow points
        const kind = z.kind === 'include' && (z.spot || spots.has(z.id)) ? 'linger' : z.kind;
        shapes.push({ id: z.id, radar: radar.radar_id, kind, name: z.name, area: kind === 'include' ? z.area_id || cfg.device_area_id : null, polygon: z.polygon.map(f), leads_to: z.leads_to || [] });
      }
    }
    const display = radars.find(x => x.radar.radar_id === anchor)?.cfg.settings?.display || {};
    const toAnchor = new Map(radars.map(({ radar }) => [radar.radar_id, at(radar.radar_id)]));
    return { anchor, radars: radars.map(x => x.radar.radar_id), shapes, cones, ignores, toAnchor, display };
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
  // Live detections (or those at the playhead), like the room view: a dot per target, a fading trail, hollow when ignored.
  // Detections go on their own layer above the room labels (headcount.js puts it last), so a label never hides a person.
  // A canvas: it is redrawn many times a second, and SVG updates there did not repaint reliably.
  const overlay = document.createElement('canvas');
  overlay.className = 'plan-overlay';
  let last = new Map();
  const setLive = (byRadar = last) => {
    last = byRadar;
    const dpr = devicePixelRatio || 1;
    const cw = overlay.clientWidth, ch = overlay.clientHeight;
    if (!cw || !ch) { requestAnimationFrame(() => overlay.isConnected && setLive()); return; } // not laid out yet
    if (overlay.width !== Math.round(cw * dpr) || overlay.height !== Math.round(ch * dpr)) { overlay.width = Math.round(cw * dpr); overlay.height = Math.round(ch * dpr); }
    const ctx = overlay.getContext('2d');
    const k = Math.min(cw / W, ch / H), ox = (cw - W * k) / 2, oy = (ch - H * k) / 2; // as the SVG's "meet"
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const px = p => { const [x, y] = sx(p); return [ox + x * k, oy + y * k]; };
    for (const [radar, { targets = [], trails = new Map() }] of byRadar) {
      const f = map.toAnchor.get(radar);
      if (!f) continue;
      const ignored = (x, y) => map.ignores.some(g => g.radar === radar && pointInPolygon(x, y, g.polygon));
      ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const [slot, pts] of trails) {
        if (pts.length < 2) continue;
        ctx.strokeStyle = slotColor(slot); ctx.globalAlpha = 0.45;
        ctx.beginPath();
        pts.forEach((p, i) => { const [x, y] = px(f([p.x, p.y])); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const [slot, x, y] of targets) {
        const [cx, cy] = px(f([x, y]));
        const off = ignored(x, y);
        ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        if (off) { ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.5; ctx.stroke(); } // ignored: hollow, as in the room view
        else { ctx.fillStyle = slotColor(slot); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
    }
  };
  return { svg, overlay, place: a => label.get(a), aspect: H / W, setLive };
}
