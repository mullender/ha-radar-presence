// Setting up a radar, steps 2 and 3 (step 1, picking the radar, is HA's "Add radar"):
// a mounting check with the live dot on the map ("walk to your right"), and the
// zones saved on the radar as a starting point. A card floating over the radar
// view, so the map and its live dot stay visible. Finish saves; the radar is
// then marked as set up (display.checked) and the card does not come back.

import { el } from './util.js';

const css = `
.su { position: absolute; right: 16px; top: 16px; width: 330px; max-width: calc(100% - 32px); z-index: 20; background: var(--card-background-color, #fff);
  color: var(--primary-text-color, #222); border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.25); padding: 14px 16px; font-size: 14px; }
.su h3 { margin: 0 0 2px; font-size: 16px; font-weight: 500; display: flex; align-items: baseline; gap: 8px; }
.su h3 small { color: var(--secondary-text-color, #888); font-weight: 400; font-size: 12px; }
.su h3 button { margin-left: auto; border: 0; background: none; color: inherit; font-size: 16px; cursor: pointer; }
.su p { margin: 6px 0 10px; line-height: 1.45; color: var(--secondary-text-color, #555); }
.su .big { font-size: 15px; color: var(--primary-text-color, #222); }
.su .opts { display: flex; flex-direction: column; gap: 6px; }
.su .opts button { text-align: left; font: inherit; padding: 8px 10px; border-radius: 8px; cursor: pointer; border: 1px solid var(--divider-color, #ddd);
  background: none; color: inherit; display: flex; align-items: center; gap: 8px; }
.su .opts button.seen { border-color: #0d9488; background: rgba(13,148,136,.07); }
.su .opts button .tag { margin-left: auto; font-size: 11px; color: #0d9488; }
.su .live { font-size: 12px; color: var(--secondary-text-color, #888); margin-bottom: 8px; }
.su .zrow { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.su .zrow span { flex: 1; }
.su .zrow select { font: inherit; font-size: 13px; padding: 2px 4px; }
.su .acts { display: flex; justify-content: space-between; margin-top: 12px; gap: 8px; }
.su .acts button { font: inherit; font-weight: 500; border-radius: 16px; padding: 6px 14px; cursor: pointer; border: 1px solid var(--divider-color, #ccc); background: none; color: var(--primary-color, #03a9f4); }
.su .acts button.primary { background: var(--primary-color, #03a9f4); color: #fff; border-color: transparent; }
`;

/** The way the live dots moved on screen over the last few seconds: 'right' | 'left' | 'up' | 'down' | null. */
export function screenDirection(trails, matrix, minPx = 40) {
  let best = null;
  for (const pts of trails.values()) {
    if (pts.length < 3) continue;
    const a = pts[0], b = pts[pts.length - 1];
    const dx = matrix[0] * (b.x - a.x) + matrix[2] * (b.y - a.y);
    const dy = matrix[1] * (b.x - a.x) + matrix[3] * (b.y - a.y);
    const len = Math.hypot(dx, dy);
    if (len >= minPx && (!best || len > best.len)) best = { dx, dy, len };
  }
  if (!best) return null;
  return Math.abs(best.dx) >= Math.abs(best.dy) ? (best.dx > 0 ? 'right' : 'left') : (best.dy < 0 ? 'up' : 'down');
}

/** The display change that makes a walk to the right show as moving right. */
export function fixFor(direction, display) {
  const r = display.rotation || 0;
  if (direction === 'left') return { mirror: !display.mirror, rotation: (360 - r) % 360 };
  if (direction === 'up') return { rotation: (r + 270) % 360 };
  if (direction === 'down') return { rotation: (r + 90) % 360 };
  return {};
}

/** Open the card over panel `p` (a radar view). */
export function openSetup(p) {
  const host = p.shadowRoot.querySelector('.plot-wrap');
  host.querySelector('.su')?.remove();
  const deviceZones = p.config?.device_zones || [];
  const state = { step: 'mount', tries: 0, seen: null, picks: Object.fromEntries(deviceZones.map(z => [z.key, z.kind === 'exclude' ? 'exclude' : 'linger'])) };
  const box = el('div', { class: 'su' });
  const area = p.hass.areas?.[p.config?.device_area_id]?.name || null;
  let timer = 0;
  const close = () => { clearInterval(timer); box.remove(); p._setupOpen = false; p.plot.showDeviceZones = false; p._updatePlot(); };
  p._setupOpen = true;
  if (p.mode !== 'live') p._goLive?.({ width: 60 });

  const render = () => {
    const steps = deviceZones.length ? 2 : 1;
    if (state.step === 'mount') {
      const opt = (dir, label) => el('button', { class: state.seen === dir ? 'seen' : '', onclick: () => answer(dir) }, label, state.seen === dir ? el('span', { class: 'tag' }, 'seen') : '');
      box.replaceChildren(el('style', {}, css),
        el('h3', {}, 'Mounting check', steps > 1 ? el('small', {}, `1 of ${steps}`) : '', el('button', { title: 'Close (ask again next time)', onclick: close }, '✕')),
        el('p', { class: 'big' }, state.tries ? 'Walk to your right once more.' : 'Stand in the room with your back to the radar and walk a few steps to your right.'),
        el('div', { class: 'live' }, p.liveTargets?.length ? `${p.liveTargets.length === 1 ? 'Your dot is' : `${p.liveTargets.length} dots are`} on the map.` : 'Waiting for the radar to see someone…'),
        el('div', { class: 'opts' },
          opt('right', '✓ It moved right'), opt('left', '↔ It moved left'), opt('up', '↑ It moved up'), opt('down', '↓ It moved down')),
        el('p', {}, 'We flip or rotate the view for you. Only the view changes.'));
    } else {
      box.replaceChildren(el('style', {}, css),
        el('h3', {}, 'Zones saved on the radar', el('small', {}, `2 of ${steps}`), el('button', { title: 'Close (ask again next time)', onclick: close }, '✕')),
        el('p', {}, `This radar has ${deviceZones.length} zone${deviceZones.length === 1 ? '' : 's'} of its own. Use ${deviceZones.length === 1 ? 'it' : 'them'} as a starting point? They won't be shown after this.`),
        ...deviceZones.map(z => el('div', { class: 'zrow' }, el('span', {}, z.key + (z.enabled === false ? ' (off on the device)' : '')),
          el('select', { onchange: e => { state.picks[z.key] = e.target.value; } },
            [['include', 'Room'], ['linger', 'Spot'], ['exclude', 'Ignore'], ['', 'Skip']].map(([v, l]) => el('option', { value: v, selected: state.picks[z.key] === v }, l))))),
        el('div', { class: 'acts' }, el('button', { onclick: () => { for (const k in state.picks) state.picks[k] = ''; finish(); } }, 'Skip'), el('button', { class: 'primary', onclick: finish }, 'Finish')));
    }
  };

  const answer = dir => {
    if (dir !== 'right') {
      p._setDisplay(fixFor(dir, p.settings.display));
      state.tries++;
      state.seen = null;
      p.liveTrails?.clear();
      render();
      return;
    }
    if (deviceZones.length) { state.step = 'zones'; p.plot.showDeviceZones = true; p._updatePlot(); render(); } else finish();
  };

  const finish = async () => {
    clearInterval(timer);
    const names = { include: area || 'Room', linger: 'Spot', exclude: 'Ignore' };
    for (const z of deviceZones) {
      const kind = state.picks[z.key];
      if (kind) p._addZone(z.polygon, kind, `${kind === 'include' ? names.include : z.key} (from the radar)`);
    }
    p._setDisplay({ checked: true });
    await p._save();
    close();
    p._toast(`${area || p.config?.title || 'This radar'}: presence is on. We'll learn for a few days and suggest what to set up in To do.`, false, 8000);
  };

  // Highlight the way the dot moved, so the answer is one tap.
  timer = setInterval(() => {
    if (!box.isConnected || state.step !== 'mount') return;
    const seen = screenDirection(p.liveTrails || new Map(), p.plot._matrix());
    const n = p.liveTargets?.length || 0;
    if (seen !== state.seen || n !== state.n) { state.seen = seen; state.n = n; render(); }
  }, 500);
  render();
  host.append(box);
}
