// Talk to the dev Home Assistant (dev/run.sh) over its websocket API.
// Logs in as dev/dev, then sends each JSON message given on the command line
// and prints the results.
//
//   node tools/dev_ws.mjs '{"type":"radar_zone_presence/list"}'
//   HA_URL=http://localhost:8124 node tools/dev_ws.mjs ...
const base = process.env.HA_URL ?? 'http://localhost:8124';
const clientId = `${base}/`;

async function token() {
  let r = await fetch(`${base}/auth/login_flow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, handler: ['homeassistant', null], redirect_uri: clientId }),
  });
  const flow = await r.json();
  r = await fetch(`${base}/auth/login_flow/${flow.flow_id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, username: 'dev', password: 'dev' }),
  });
  const done = await r.json();
  r = await fetch(`${base}/auth/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code: done.result, client_id: clientId }),
  });
  return (await r.json()).access_token;
}

export async function connect() {
  const access = await token();
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/websocket');
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  await new Promise((resolve, reject) => {
    ws.addEventListener('message', function onAuth(e) {
      const m = JSON.parse(e.data);
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: access }));
      else if (m.type === 'auth_ok') { ws.removeEventListener('message', onAuth); resolve(); }
      else if (m.type === 'auth_invalid') reject(new Error(m.message));
    });
  });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.type === 'event' && listeners.has(m.id)) listeners.get(m.id)(m.event);
    else if (m.type === 'result' && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return {
    access,
    send(msg) {
      const mid = ++id;
      ws.send(JSON.stringify({ ...msg, id: mid }));
      return new Promise(resolve => pending.set(mid, resolve));
    },
    subscribe(msg, cb) {
      const mid = ++id;
      listeners.set(mid, cb);
      ws.send(JSON.stringify({ ...msg, id: mid }));
      return mid;
    },
    close() { ws.close(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = await connect();
  for (const arg of process.argv.slice(2)) {
    const res = await c.send(JSON.parse(arg));
    console.log(JSON.stringify(res, null, 1));
  }
  c.close();
}
