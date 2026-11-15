// Export raw target-coordinate history from production HA (read-only) via the
// CDP browser on localhost:9224.
//
// Usage: node tools/export_history.mjs [--hours 48] [--end ISO] [--out dev/data]
// (CDP_PAGE_ID=<target id> picks a specific tab, e.g. a separate one opened for this.)
//
// Writes one gzipped JSON file per radar device that exposes per-target X/Y
// sensors (EP Lite `target_<n>_x`, Screek 2A `target<n>_x`). Raw state changes
// are kept as recorded ([last_updated_epoch_s, state] pairs, unconverted), so
// the frame assembler and the dev simulator see the real update pattern.
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const hours = Number(arg('hours', '48'));
const end = arg('end', new Date().toISOString());
const outDir = arg('out', 'dev/data');

const page = (await (await fetch('http://localhost:9224/json/list')).json())
  .find(p => p.type === 'page' && (process.env.CDP_PAGE_ID ? p.id === process.env.CDP_PAGE_ID
    : process.env.PROD_HA_HOST ? p.url.includes(process.env.PROD_HA_HOST) : !p.url.includes('localhost')));
if (!page) throw new Error('No production HA tab found on localhost:9224');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
function evaluate(fnSource, ...args) {
  const id = nextId++;
  const expression = `(async () => { const hass = document.querySelector('home-assistant').hass;
    return JSON.stringify(await (${fnSource})(hass, ...${JSON.stringify(args)})); })()`;
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  return new Promise((resolve, reject) => {
    const onMsg = e => {
      const m = JSON.parse(e.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (m.result.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails)));
      else resolve(JSON.parse(m.result.result.value));
    };
    ws.addEventListener('message', onMsg);
  });
}

// Discover radar devices and their relevant entities.
const devices = await evaluate(async hass => {
  const [ents, devs] = await Promise.all([
    hass.callWS({ type: 'config/entity_registry/list' }),
    hass.callWS({ type: 'config/device_registry/list' }),
  ]);
  const out = {};
  for (const e of ents) {
    if (!e.device_id || e.disabled_by) continue;
    const m = e.entity_id.match(/^sensor\.(.+?)_target_?(\d)_(x|y)$/);
    const isCount = /^sensor\..+_all_target_counts$/.test(e.entity_id);
    if (!m && !isCount) continue;
    const d = (out[e.device_id] ??= { device_id: e.device_id, entities: [] });
    d.entities.push(e.entity_id);
    if (m) d.slug = m[1];
  }
  for (const d of Object.values(out)) {
    const dev = devs.find(x => x.id === d.device_id);
    Object.assign(d, { name: dev.name_by_user || dev.name, manufacturer: dev.manufacturer,
      model: dev.model, sw_version: dev.sw_version, area_id: dev.area_id });
    d.profile = d.entities.some(id => /_target_\d_x$/.test(id)) ? 'everything_presence' : 'screek_2a';
    // Context for comparing against the current hand-rolled setup.
    d.polygons = Object.fromEntries(Object.entries(hass.states)
      .filter(([id]) => id.startsWith(`input_text.${d.slug}_zone_polygon_`)).map(([id, s]) => [id, s.state]));
    d.legacy_presence = Object.keys(hass.states)
      .filter(id => id.startsWith(`binary_sensor.${d.slug}_zone_polygon_`));
    d.units = Object.fromEntries(d.entities.map(id => [id, hass.states[id]?.attributes.unit_of_measurement ?? null]));
    // Device settings the integration reads (mounting, range), as current state.
    d.extra_states = Object.fromEntries(ents
      .filter(e => e.device_id === d.device_id && !e.disabled_by && /_(upside_down_mounting|installation_angle|max_distance)$/.test(e.entity_id))
      .map(e => [e.entity_id, hass.states[e.entity_id]?.state]).filter(([, v]) => v !== undefined));
  }
  return Object.values(out).filter(d => d.slug);
});

mkdirSync(outDir, { recursive: true });
const start = new Date(new Date(end) - hours * 3600e3).toISOString();
for (const d of devices) {
  const ids = [...d.entities, ...d.legacy_presence];
  const history = await evaluate(async (hass, start, end, ids) => {
    const r = await hass.callWS({ type: 'history/history_during_period', start_time: start, end_time: end,
      entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false });
    return Object.fromEntries(Object.entries(r).map(([id, v]) => [id, v.map(x => [x.lu, x.s])]));
  }, start, end, ids);
  const doc = { meta: { ...d, start, end, exported_at: new Date().toISOString() }, history };
  const file = join(outDir, `${d.slug}.json.gz`);
  writeFileSync(file, gzipSync(JSON.stringify(doc)));
  const n = Object.values(history).reduce((a, v) => a + v.length, 0);
  console.log(`${file}  ${d.profile}  ${d.area_id}  ${n} state changes`);
}
ws.close();
