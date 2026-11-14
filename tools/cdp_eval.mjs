// Read-only helper: evaluate JS against production HA open in the CDP browser (localhost:9224).
// Usage: node tools/cdp_eval.mjs '<expression using hass, may return a promise>'
const page = (await (await fetch('http://localhost:9224/json/list')).json())
  .find(p => p.type === 'page' && (process.env.PROD_HA_HOST ? p.url.includes(process.env.PROD_HA_HOST) : !p.url.includes('localhost')));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
  expression: `(async () => { const hass = document.querySelector('home-assistant').hass; return JSON.stringify(await (${process.argv[2]})); })()`,
  awaitPromise: true, returnByValue: true } }));
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id !== 1) return;
  const r = m.result;
  if (r.exceptionDetails) console.error(JSON.stringify(r.exceptionDetails, null, 1));
  else console.log(r.result.value);
  ws.close();
});
