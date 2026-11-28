// Plan mode for the House view: a floor drawn from its room shapes, in the frame
// of the linked radars that see it (one map per alignment group). The geometry
// only; headcount.js puts the room labels (count, people, ±) on top.

import { fovPolygon, pointInPolygon, polygonArea, signedDistance, validatePolygon } from './engine.js';
import { KIND_STYLE, SVGNS, affineApply, radarTransforms, slotColor } from './util.js';
import { convexHull } from './analysis.js';

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
    // A radar without a shape for its own room: the engine counts a person there in that room wherever this
    // radar is the nearest one that sees them (engine/rooms.py). Draw that part of its view, so the room is on
    // the map (and a floor with it can be a plan).
    for (const { radar, cfg } of radars) {
      const area = cfg.device_area_id;
      if (!area || shapes.some(s => s.kind === 'include' && s.area === area)) continue;
      const own = ownRoom(radar.radar_id, cones, shapes.filter(s => s.kind === 'include'), ignores.map(g => ({ polygon: g.polygon.map(at(g.radar)) })));
      if (own) shapes.push({ id: `own:${radar.radar_id}`, radar: radar.radar_id, kind: 'include', implicit: true, name: radar.area || area, area, polygon: own.polygon, labelAt: own.label, leads_to: [] });
    }
    const display = radars.find(x => x.radar.radar_id === anchor)?.cfg.settings?.display || {};
    const toAnchor = new Map(radars.map(({ radar }) => [radar.radar_id, at(radar.radar_id)]));
    const names = new Map(radars.map(({ radar }) => [radar.radar_id, radar.area || radar.title]));
    return { anchor, radars: radars.map(x => x.radar.radar_id), shapes, cones, ignores, toAnchor, display, names };
  });
}

/**
 * The part of radar `id`'s view that is its own room (anchor frame): the points where it is the nearest radar
 * that sees them, outside other rooms' shapes and ignore areas. {polygon (convex hull), label (centre of the
 * points)} or null when too little is left. Sampled on a grid, as engine/rooms.py decides per point.
 */
export function ownRoom(id, cones, rooms, ignores = [], step = 150) {
  const mine = cones.find(c => c.radar === id);
  if (!mine) return null;
  const xs = mine.polygon.map(p => p[0]), ys = mine.polygon.map(p => p[1]);
  const kept = [];
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += step) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += step) {
      if (!pointInPolygon(x, y, mine.polygon)) continue;
      if (rooms.some(r => pointInPolygon(x, y, r.polygon)) || ignores.some(g => pointInPolygon(x, y, g.polygon))) continue;
      const d = Math.hypot(x - mine.origin[0], y - mine.origin[1]);
      if (cones.some(c => c !== mine && pointInPolygon(x, y, c.polygon) && Math.hypot(x - c.origin[0], y - c.origin[1]) < d)) continue;
      kept.push([x, y]);
    }
  }
  if (kept.length * step * step < 1e6) return null; // under 1 m²
  const label = [kept.reduce((s, p) => s + p[0], 0) / kept.length, kept.reduce((s, p) => s + p[1], 0) / kept.length];
  return { polygon: convexHull(kept), label };
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

/** Image pixel (u, v) -> floor-frame mm, for an image placed at (x, y) with `scale` mm/px, rotated clockwise,
 *  flipped left-right first when `mirror` (the other half of a duplex). */
export function imageToPlan(bg, [u0, v]) {
  const u = bg.mirror ? bg.w - u0 : u0;
  const r = ((bg.rotation || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [bg.x + bg.scale * (u * c - v * s), bg.y - bg.scale * (u * s + v * c)];
}

/** Floor-frame mm -> image pixel (the inverse of imageToPlan). */
export function planToImage(bg, [px, py]) {
  const r = ((bg.rotation || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = (px - bg.x) / bg.scale, dy = (bg.y - py) / bg.scale;
  const u = dx * c + dy * s;
  return [bg.mirror ? bg.w - u : u, -dx * s + dy * c];
}

/** A map's display transform (its anchor frame -> how it is shown: the map's own rotation and mirror). */
export function toDisplay(map) {
  const d = map.display || {};
  const r = ((d.rotation || 0) * Math.PI) / 180, m = d.mirror ? -1 : 1;
  return ([x, y]) => [Math.cos(r) * m * x - Math.sin(r) * y, Math.sin(r) * m * x + Math.cos(r) * y];
}

/**
 * Where a map sits on its floor: its display frame (mm, y up) -> the floor frame, turned `rotation` degrees
 * clockwise and flipped left-right first when `mirror`. No placement: the floor frame is this map's own.
 */
export function placeOnFloor(place, [x, y]) {
  if (!place) return [x, y];
  const r = ((place.rotation || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), m = place.mirror ? -1 : 1;
  return [place.x + c * m * x + s * y, place.y - s * m * x + c * y];
}

/** The inverse of placeOnFloor. */
export function floorToMap(place, [X, Y]) {
  if (!place) return [X, Y];
  const r = ((place.rotation || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), m = place.mirror ? -1 : 1;
  const dx = X - place.x, dy = Y - place.y;
  return [m * (c * dx - s * dy), s * dx + c * dy];
}

/**
 * Line a map up on the floor: pairs of [point in the map's display frame, where it is on the floor]. One pair moves
 * it; two also turn it (no scaling: a radar's millimetres are real). Keeps `mirror`.
 */
export function fitPlacement(place, pairs) {
  let out = { x: 0, y: 0, rotation: 0, mirror: false, ...place };
  if (pairs.length >= 2) {
    const [[m1, f1], [m2, f2]] = pairs.slice(-2);
    const a = placeOnFloor({ ...out, x: 0, y: 0, rotation: 0 }, [m2[0] - m1[0], m2[1] - m1[1]]); // mirrored, unturned
    const b = [f2[0] - f1[0], f2[1] - f1[1]];
    if (Math.hypot(...a) > 1 && Math.hypot(...b) > 1) {
      const turn = Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]); // clockwise, as rotation
      out = { ...out, rotation: (((turn * 180) / Math.PI) % 360 + 360) % 360 };
    }
  }
  const [[mp, fp]] = pairs.slice(-1);
  const now = placeOnFloor(out, mp);
  return { ...out, x: out.x + fp[0] - now[0], y: out.y + fp[1] - now[1] };
}

/** Where a radar is in its map's display frame (its origin, through its alignment to the map's anchor). */
export function radarOrigin(map, radar) {
  const f = map.toAnchor.get(radar);
  return f ? toDisplay(map)(f([0, 0])) : null;
}

/**
 * Radars pinned to where they hang on the floor image (`plan.pins`: radar -> image pixel) place the image and the
 * maps. The frame map's pinned radars move the image (one pin) or also size and turn it (two: the radars' real
 * distance, from their alignment, sets the image's scale). Other maps are moved (one pin) or also turned (two) so
 * their radars land on their pins. Returns the new {image, maps}.
 */
export function solvePins(plan, maps) {
  const pins = plan.pins || {};
  let image = plan.image;
  const placed = { ...(plan.maps || {}) };
  if (!image) return { image, maps: placed };
  const primary = maps.find(m => m.anchor === plan.primary);
  if (primary) {
    const own = primary.radars.filter(r => pins[r] && radarOrigin(primary, r));
    if (own.length) image = fitBackground(image, own.slice(-2).map(r => [pins[r], radarOrigin(primary, r)]));
  }
  for (const m of maps) {
    if (m === primary) continue;
    const own = m.radars.filter(r => pins[r] && radarOrigin(m, r));
    if (!own.length) continue;
    placed[m.anchor] = fitPlacement(placed[m.anchor] || {}, own.slice(-2).map(r => [radarOrigin(m, r), imageToPlan(image, pins[r])]));
  }
  return { image, maps: placed };
}

/**
 * A floor drawn as a plan: the saved floor plan (one map as the frame, others placed on it, an image, devices) or,
 * without one, the map holding most of the floor's rooms. {map (the frame), parts: [{map, areas, place}], areas,
 * background, items, unplaced (maps with rooms on this floor not on the plan yet), saved} or null.
 */
export function floorPlan(maps, areaIds, saved = null) {
  const onFloor = m => new Set(m.shapes.filter(s => s.kind === 'include' && areaIds.has(s.area)).map(s => s.area));
  const primary = saved?.primary && maps.find(m => m.anchor === saved.primary);
  if (!primary) {
    // Not drawn yet: the map with most of the floor's rooms, and the floor's other maps side by side to its right
    // (top-aligned, a metre apart) until they are lined up in the editor.
    const withRooms = maps.map(m => ({ m, areas: onFloor(m) })).filter(x => x.areas.size).sort((a, b) => b.areas.size - a.areas.size);
    const all = new Set(withRooms.flatMap(x => [...x.areas]));
    if (all.size < 2) return null;
    const box = (m, areas) => {
      const disp = toDisplay(m);
      const pts = m.shapes.filter(sh => sh.kind === 'include' && areas.has(sh.area)).flatMap(sh => sh.polygon.map(disp));
      return { x0: Math.min(...pts.map(q => q[0])), x1: Math.max(...pts.map(q => q[0])), y1: Math.max(...pts.map(q => q[1])) };
    };
    const first = box(withRooms[0].m, withRooms[0].areas);
    let right = first.x1;
    const parts = withRooms.map(({ m, areas }, i) => {
      if (!i) return { map: m, areas, place: null };
      const b = box(m, areas);
      const place = { x: right + 1000 - b.x0, y: first.y1 - b.y1, rotation: 0, mirror: false };
      right += 1000 + b.x1 - b.x0;
      return { map: m, areas, place };
    });
    return { map: parts[0].map, areas: all, parts, background: null, items: [], unplaced: [], saved: null };
  }
  const parts = [{ map: primary, areas: onFloor(primary), place: null }];
  for (const [anchor, place] of Object.entries(saved.maps || {})) {
    const m = maps.find(x => x.anchor === anchor);
    if (m && m !== primary) parts.push({ map: m, areas: onFloor(m), place });
  }
  const areas = new Set(parts.flatMap(p => [...p.areas]));
  const unplaced = maps.filter(m => !parts.some(p => p.map === m) && onFloor(m).size);
  return { map: primary, areas, parts, background: saved.image || null, items: saved.items || [], unplaced, saved };
}

/**
 * Two image points and where they belong on the plan -> the placement that puts them there (scale, rotation, position).
 * pairs: [[[u, v], [px, py]], [[u, v], [px, py]]]. Keeps `bg`'s other fields. One pair only moves the image.
 */
export function fitBackground(bg, pairs) {
  if (pairs.length === 1) {
    const [[img, at]] = pairs, now = imageToPlan(bg, img);
    return { ...bg, x: bg.x + at[0] - now[0], y: bg.y + at[1] - now[1] };
  }
  const [[i1, p1], [i2, p2]] = pairs;
  // Display frame with y down (as the image), so rotation is the same sense as the image's.
  const a = [(bg.mirror ? -1 : 1) * (i2[0] - i1[0]), i2[1] - i1[1]], b = [p2[0] - p1[0], -(p2[1] - p1[1])];
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  if (la < 1 || lb < 1) return bg;
  const rotation = (((Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0])) * 180) / Math.PI + 360) % 360;
  const out = { ...bg, scale: lb / la, rotation };
  const now = imageToPlan(out, i1);
  return { ...out, x: out.x + p1[0] - now[0], y: out.y + p1[1] - now[1] };
}

/**
 * Draw a floor plan. `occupied(area)` -> count. Returns {svg, place(area) -> [x%, y%] of the room's label, size}.
 * A plan is one map or several placed on one floor (floorPlan). Rooms of other floors on a map are left out;
 * doorways and spots are kept when they touch a room drawn. Everything is drawn in the floor frame (mm, y up).
 */
export function drawPlan(plan, { occupied = () => 0, dark = false, onRoom = null, background = plan.background ?? plan.map.background } = {}) {
  const parts = (plan.parts || [{ map: plan.map, areas: plan.areas, place: null }]).map(part => {
    const display = toDisplay(part.map);
    return { ...part, F: p => placeOnFloor(part.place, display(p)) }; // anchor frame -> floor frame
  });
  const rooms = parts.flatMap(part => part.map.shapes.filter(s => s.kind === 'include' && part.areas.has(s.area))
    .map(s => ({ ...s, anchor: part.map.anchor, fp: s.polygon.map(part.F), label: s.labelAt ? part.F(s.labelAt) : null })));
  // The floor-plan image counts towards the extent: it shows the whole floor, also what no radar sees.
  const bgPts = background ? [[0, 0], [background.w, 0], [background.w, background.h], [0, background.h]].map(p => imageToPlan(background, p)) : [];
  const roomPts = [...rooms.flatMap(s => s.fp), ...bgPts];
  const xs = roomPts.map(p => p[0]), ys = roomPts.map(p => p[1]);
  const pad = 400;
  const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  const W = x1 - x0, H = y1 - y0;
  const sx = ([x, y]) => [x - x0, y1 - y]; // floor frame -> svg
  const inBox = fp => fp.some(p => { const [x, y] = sx(p); return x >= 0 && y >= 0 && x <= W && y <= H; });
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W.toFixed(0)} ${H.toFixed(0)}`);
  svg.setAttribute('class', 'plan-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const add = (tag, attrs, parent = svg) => { const n = document.createElementNS(SVGNS, tag); for (const [a, v] of Object.entries(attrs)) n.setAttribute(a, v); parent.append(n); return n; };
  const pts = fp => fp.map(p => sx(p).map(v => v.toFixed(0)).join(',')).join(' ');
  const tone = k => KIND_STYLE[k][dark ? 'dark' : 'light'];
  // The floor-plan image, under everything. Placed in the floor frame, so svg = (x - x0, y1 - y).
  const bgEl = add('image', { preserveAspectRatio: 'none', class: 'plan-bg' });
  const setBackground = bg => {
    if (!bg) { bgEl.setAttribute('display', 'none'); return; }
    bgEl.removeAttribute('display');
    bgEl.setAttribute('href', bg.image);
    bgEl.setAttribute('width', bg.w);
    bgEl.setAttribute('height', bg.h);
    bgEl.setAttribute('opacity', bg.opacity ?? 0.6);
    bgEl.setAttribute('transform', `translate(${(bg.x - x0).toFixed(1)},${(y1 - bg.y).toFixed(1)}) rotate(${(bg.rotation || 0).toFixed(2)}) scale(${bg.scale})${bg.mirror ? ` translate(${bg.w},0) scale(-1,1)` : ''}`);
  };
  setBackground(background);
  /** A pointer position -> floor-frame mm (for dragging and picking points on the plan). */
  const toPlan = (clientX, clientY) => {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const q = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return [q.x + x0, y1 - q.y];
  };
  /** Floor-frame mm -> where it is in the map element, as fractions (for markers over the plan). */
  const toFrac = ([px, py]) => [(px - x0) / W, (y1 - py) / H];
  // Each map in its own group, so the floor editor can drag one around before it is redrawn.
  const groups = new Map(parts.map(part => [part.map.anchor, add('g', { class: 'plan-part' })]));
  // What the radars see: a soft wash.
  for (const part of parts) for (const c of part.map.cones) add('polygon', { points: pts(c.polygon.map(part.F)), fill: 'currentColor', 'fill-opacity': 0.035 }, groups.get(part.map.anchor));
  for (const s of [...rooms].sort((a, b) => !!b.implicit - !!a.implicit)) { // a room without a shape (a radar's own view) underneath
    const n = occupied(s.area);
    const g = add('polygon', {
      points: pts(s.fp), fill: tone('include'), 'fill-opacity': n ? 0.26 : 0.08, stroke: tone('include'), 'stroke-opacity': 0.55, 'stroke-width': W / 300,
      ...(s.implicit ? { 'stroke-dasharray': `${W / 80} ${W / 120}` } : {}),
      class: onRoom ? 'room link' : 'room',
    }, groups.get(s.anchor));
    if (s.implicit) add('title', {}, g).textContent = `${s.name} has no room shape: this is the part of its radar's view counted as ${s.name}. Draw the room in that radar's Edit mode to fit it to the walls.`;
    if (onRoom) g.addEventListener('click', () => onRoom(s));
  }
  for (const part of parts) {
    for (const s of part.map.shapes) {
      const fp = s.polygon.map(part.F);
      if (s.kind === 'include' || !inBox(fp)) continue;
      add('polygon', { points: pts(fp), fill: tone(s.kind), 'fill-opacity': s.kind === 'exit' ? 0.45 : 0.25, stroke: tone(s.kind), 'stroke-opacity': 0.7, 'stroke-width': W / 500 }, groups.get(part.map.anchor));
    }
    for (const c of part.map.cones) {
      const [x, y] = sx(part.F(c.origin));
      if (x >= 0 && y >= 0 && x <= W && y <= H) add('circle', { cx: x.toFixed(0), cy: y.toFixed(0), r: W / 120, fill: 'currentColor', 'fill-opacity': 0.6 }, groups.get(part.map.anchor));
    }
  }
  // Label position per area: the biggest shape's centre.
  const label = new Map();
  for (const s of rooms) {
    const [cx, cy] = sx(s.label || centroid(s.fp));
    const sz = Math.abs(polygonArea(s.fp)) * (s.implicit ? 0.01 : 1); // a drawn shape wins
    if (!label.has(s.area) || sz > label.get(s.area).sz) label.set(s.area, { x: (100 * cx) / W, y: (100 * cy) / H, sz });
  }
  // Which part of the plan a radar is on (its map), and its own coordinates -> the floor frame.
  const radarTo = new Map();
  for (const part of parts) for (const [radar, f] of part.map.toAnchor) radarTo.set(radar, { part, f: p => part.F(f(p)) });
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
      const on = radarTo.get(radar);
      if (!on) continue;
      const ignored = (x, y) => on.part.map.ignores.some(g => g.radar === radar && pointInPolygon(x, y, g.polygon));
      ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const [slot, tpts] of trails) {
        if (tpts.length < 2) continue;
        ctx.strokeStyle = slotColor(slot); ctx.globalAlpha = 0.45;
        ctx.beginPath();
        tpts.forEach((p, i) => { const [x, y] = px(on.f([p.x, p.y])); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const [slot, x, y] of targets) {
        const [cx, cy] = px(on.f([x, y]));
        const off = ignored(x, y);
        ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        if (off) { ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.5; ctx.stroke(); } // ignored: hollow, as in the room view
        else { ctx.fillStyle = slotColor(slot); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
    }
  };
  /** A radar's own coordinates -> floor-frame mm ("where I stand" when lining up). */
  const fromRadar = (radar, p) => radarTo.get(radar)?.f(p) ?? null;
  /** Drag one map's drawing by (dx, dy) floor mm, until the plan is redrawn. */
  const nudge = (anchor, dx, dy) => groups.get(anchor)?.setAttribute('transform', `translate(${dx.toFixed(0)},${(-dy).toFixed(0)})`);
  return { svg, overlay, place: a => label.get(a), aspect: H / W, setLive, setBackground, toPlan, toFrac, fromRadar, nudge, extent: { x0, x1, y0, y1 } };
}
