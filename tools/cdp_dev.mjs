// Drive a dedicated tab (dev HA on localhost:8124) in the CDP browser on :9224.
// Never touches other tabs. The tab id is kept in /tmp/rzp_dev_tab.
//
//   node tools/cdp_dev.mjs open /radar-zones        # (re)open tab, logged in as dev/dev
//   node tools/cdp_dev.mjs eval 'document.title'
//   node tools/cdp_dev.mjs shot /tmp/x.png [selector-in-panel]
//   node tools/cdp_dev.mjs mouse down|move|up x y [shift]
//   node tools/cdp_dev.mjs click x y | dblclick x y | key Enter | type text | wheel x y dy
//   node tools/cdp_dev.mjs close
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

const CDP = 'http://localhost:9224';
const DEV = process.env.HA_URL ?? 'http://localhost:8124';
const TAB_FILE = '/tmp/rzp_dev_tab';

async function tokens() {
  const clientId = `${DEV}/`;
  let r = await fetch(`${DEV}/auth/login_flow`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, handler: ['homeassistant', null], redirect_uri: clientId }) });
  const flow = await r.json();
  r = await fetch(`${DEV}/auth/login_flow/${flow.flow_id}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, username: 'dev', password: 'dev' }) });
  const done = await r.json();
  r = await fetch(`${DEV}/auth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: done.result, client_id: clientId }) });
  const t = await r.json();
  return { ...t, hassUrl: DEV, clientId, expires: Date.now() + t.expires_in * 1000 };
}

async function tab() {
  if (!existsSync(TAB_FILE)) throw new Error('no dev tab: run open first');
  const id = readFileSync(TAB_FILE, 'utf8').trim();
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const t = list.find(p => p.id === id);
  if (!t || !t.url.startsWith(DEV)) throw new Error('dev tab gone: run open first');
  return t;
}

async function session(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    const on = e => {
      const m = JSON.parse(e.data);
      if (m.id !== mid) return;
      ws.removeEventListener('message', on);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { send, close: () => ws.close() };
}

const evalIn = async (s, expression) => {
  const r = await s.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'open') {
  const path = args[0] || '/radar-zones';
  let t;
  try { t = await tab(); } catch {
    // Own window: background tabs do not render, so screenshots would hang.
    const ver = await (await fetch(`${CDP}/json/version`)).json();
    const b = await session({ webSocketDebuggerUrl: ver.webSocketDebuggerUrl });
    const { targetId } = await b.send('Target.createTarget', { url: DEV + '/', newWindow: true, width: 1500, height: 1000 });
    b.close();
    writeFileSync(TAB_FILE, targetId);
    await new Promise(r => setTimeout(r, 2000));
    t = await tab();
  }
  const s = await session(t);
  // Always load the latest frontend files (HA's service worker caches panel modules).
  await s.send('Network.enable');
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });
  await s.send('Network.setBypassServiceWorker', { bypass: true });
  await s.send('Page.enable');
  s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
  const tok = await tokens();
  await s.send('Page.navigate', { url: DEV + '/' });
  for (let k = 0; k < 40; k++) { await new Promise(r => setTimeout(r, 250)); try { if (await evalIn(s, 'location.origin') === DEV) break; } catch {} }
  await evalIn(s, `localStorage.setItem('hassTokens', ${JSON.stringify(JSON.stringify(tok))}); 1`);
  await s.send('Page.navigate', { url: DEV + path });
  await new Promise(r => setTimeout(r, 4000));
  console.log(await evalIn(s, 'location.href'));
  s.close();
} else if (cmd === 'close') {
  try { const t = await tab(); await fetch(`${CDP}/json/close/${t.id}`); } catch (e) { console.log(String(e)); }
  if (existsSync(TAB_FILE)) unlinkSync(TAB_FILE);
} else {
  const t = await tab();
  const s = await session(t);
  const mods = args.includes('shift') ? 8 : 0;
  if (cmd === 'eval') console.log(JSON.stringify(await evalIn(s, args[0]), null, 1));
  else if (cmd === 'dialog') {
    await s.send('Page.handleJavaScriptDialog', { accept: args[0] !== 'dismiss' }).catch(e => console.log(String(e)));
  } else if (cmd === 'shot') {
    const r = await s.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(args[0], Buffer.from(r.data, 'base64'));
    console.log(args[0]);
  } else if (cmd === 'mouse') {
    const type = { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased' }[args[0]];
    await s.send('Input.dispatchMouseEvent', { type, x: +args[1], y: +args[2], button: 'left', buttons: args[0] === 'up' ? 0 : 1, clickCount: 1, modifiers: mods });
  } else if (cmd === 'click' || cmd === 'dblclick') {
    const n = cmd === 'click' ? 1 : 2;
    for (let c = 1; c <= n; c++) {
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: +args[0], y: +args[1], button: 'left', buttons: 1, clickCount: c, modifiers: mods });
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: +args[0], y: +args[1], button: 'left', buttons: 0, clickCount: c, modifiers: mods });
    }
  } else if (cmd === 'drag') {
    const [x0, y0, x1, y1] = args.map(Number);
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
    for (let k = 1; k <= 10; k++) await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * k) / 10, y: y0 + ((y1 - y0) * k) / 10, button: 'left', buttons: 1 });
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 });
  } else if (cmd === 'wheel') {
    await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: +args[0], y: +args[1], deltaX: 0, deltaY: +args[2] });
  } else if (cmd === 'key') {
    const key = args[0];
    const codes = { Enter: 13, Escape: 27, Backspace: 8, Delete: 46, ' ': 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
    for (const type of ['keyDown', 'keyUp']) await s.send('Input.dispatchKeyEvent', { type, key, windowsVirtualKeyCode: codes[key] || key.toUpperCase().charCodeAt(0), modifiers: args.includes('ctrl') ? 2 : args.includes('meta') ? 4 : args.includes('shift') ? 8 : 0, code: key.startsWith('Arrow') ? key : undefined });
  } else if (cmd === 'type') {
    await s.send('Input.insertText', { text: args[0] });
  } else console.log('unknown command');
  s.close();
}
