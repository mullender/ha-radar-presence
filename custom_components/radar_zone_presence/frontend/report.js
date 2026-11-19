// "Report a problem": one time window, anonymized by the integration, downloaded
// as a .rpreport.json.gz to attach to a GitHub issue by hand. Nothing is sent
// anywhere. Admins only (the websocket command enforces it).

import { el, fmtTime } from './util.js';

const DOMAIN = 'radar_zone_presence';
const ISSUES = 'https://github.com/mullender/ha-radar-presence/issues/new';
const SYMPTOMS = [
  ['count_wrong', 'The count was wrong'],
  ['light_on_by_itself', 'A light turned on by itself'],
  ['stayed_occupied', 'A room stayed occupied'],
  ['went_clear', 'A room went clear with someone there'],
  ['other', 'Something else'],
];
const WINDOWS = [[300, '±5 min'], [600, '±10 min'], [900, '±15 min']];

const css = `
.rp-back { position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 40; display: flex; align-items: center; justify-content: center; }
.rp { width: min(520px, calc(100% - 32px)); max-height: calc(100% - 48px); overflow: auto; background: var(--card-background-color, #fff); color: var(--primary-text-color, #222);
  border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.3); padding: 18px 20px; font: 14px Roboto, sans-serif; }
.rp h2 { margin: 0 0 12px; font-size: 18px; font-weight: 500; display: flex; }
.rp h2 button { margin-left: auto; border: 0; background: none; font-size: 18px; cursor: pointer; color: inherit; }
.rp .lbl { font-weight: 500; margin: 12px 0 6px; }
.rp .chips { display: flex; flex-wrap: wrap; gap: 6px; }
.rp .chip { font: inherit; font-size: 13px; border: 1px solid var(--divider-color, #ccc); background: none; color: var(--primary-text-color, #222); border-radius: 16px; padding: 5px 12px; cursor: pointer; }
.rp .chip.on { background: var(--primary-color, #03a9f4); color: #fff; border-color: transparent; }
.rp textarea { width: 100%; box-sizing: border-box; font: inherit; min-height: 54px; padding: 6px 8px; border: 1px solid var(--divider-color, #ccc); border-radius: 6px;
  background: var(--card-background-color, #fff); color: inherit; }
.rp select { font: inherit; padding: 3px 6px; }
.rp .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; font-size: 13px; }
.rp .cols div div { margin: 2px 0; }
.rp .muted { color: var(--secondary-text-color, #666); font-size: 12px; line-height: 1.4; }
.rp .acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
.rp .acts button { font: inherit; font-weight: 500; border-radius: 18px; padding: 7px 16px; cursor: pointer; border: 1px solid var(--divider-color, #ccc); background: none; color: var(--primary-color, #03a9f4); }
.rp .acts button.primary { background: var(--primary-color, #03a9f4); color: #fff; border-color: transparent; }
.rp .acts button:disabled { opacity: .5; cursor: default; }
`;

/** Open the dialog in `root` (a shadow root) around time t (epoch s). */
export function openReportDialog({ hass, root, t = Date.now() / 1000, symptom = null, radars = 0 }) {
  root.querySelector('.rp-back')?.remove();
  const state = { symptom, expected: '', half: 300, keepTime: false, busy: false, size: null };
  const back = el('div', { class: 'rp-back' });
  const close = () => back.remove();
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  const render = () => {
    const now = Date.now() / 1000;
    const a = t - state.half, b = Math.min(now, t + state.half);
    back.replaceChildren(el('style', {}, css), el('div', { class: 'rp' },
      el('h2', {}, 'Report a problem', el('button', { title: 'Close', onclick: close }, '✕')),
      el('div', { class: 'lbl' }, 'What went wrong?'),
      el('div', { class: 'chips' }, SYMPTOMS.map(([key, label]) => el('button', { class: `chip${state.symptom === key ? ' on' : ''}`, onclick: () => { state.symptom = key; render(); } }, label))),
      el('div', { class: 'lbl' }, 'What did you expect? (optional)'),
      el('textarea', { placeholder: 'Two people were home, it said three after 07:50.', oninput: e => { state.expected = e.target.value; } }, state.expected),
      el('div', { class: 'lbl' }, 'Window'),
      el('div', {}, `${fmtTime(a, false)} – ${fmtTime(b, false)} (around ${fmtTime(t, false)}) `,
        el('select', { onchange: e => { state.half = +e.target.value; render(); } }, WINDOWS.map(([s, l]) => el('option', { value: s, selected: s === state.half }, l)))),
      el('div', { class: 'cols' },
        el('div', {}, el('b', {}, 'Included'),
          el('div', {}, `✓ Radar readings${radars ? `, ${radars} radar${radars === 1 ? '' : 's'}` : ''}`),
          el('div', {}, '✓ Shapes, links, doors, floors'), el('div', {}, '✓ Activity and corrections'), el('div', {}, '✓ Versions and settings')),
        el('div', {}, el('b', {}, 'Removed'),
          el('div', {}, '✕ Names → Room A, Radar 1, Door 1'), el('div', {}, '✕ The date (moved to 2000-01-01)'),
          el('label', {}, el('input', { type: 'checkbox', checked: !state.keepTime, onchange: e => { state.keepTime = !e.target.checked; } }), ' ✕ Time of day'))),
      el('p', { class: 'muted' }, 'Nothing is sent anywhere. You download the file and choose where to attach it. It still holds the shape of some rooms and a few minutes of movement.'),
      el('div', { class: 'acts' },
        el('button', { disabled: !state.symptom, onclick: () => openIssue(state) }, 'Open GitHub issue ↗'),
        el('button', { class: 'primary', disabled: !state.symptom || state.busy, onclick: () => download(hass, state, a, b, render) },
          state.busy ? 'Preparing…' : state.size ? `Downloaded (${state.size})` : 'Download'))));
  };
  render();
  root.append(back);
  return close;
}

async function download(hass, state, a, b, render) {
  state.busy = true;
  render();
  try {
    const report = await hass.callWS({ type: `${DOMAIN}/report/build`, start: a, end: b, symptom: state.symptom, expected: state.expected, keep_time_of_day: state.keepTime });
    const json = new Blob([JSON.stringify(report)], { type: 'application/json' });
    const gz = typeof CompressionStream === 'function' ? await new Response(json.stream().pipeThrough(new CompressionStream('gzip'))).blob() : json;
    const url = URL.createObjectURL(gz);
    const link = el('a', { href: url, download: `radar-presence-${state.symptom.replace(/_/g, '-')}.rpreport.json${gz === json ? '' : '.gz'}` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    state.size = gz.size > 1e6 ? `${(gz.size / 1e6).toFixed(1)} MB` : `${Math.round(gz.size / 1e3)} KB`;
  } catch (err) {
    alert(`Could not build the report: ${err.message || err.code}`);
  }
  state.busy = false;
  render();
}

function openIssue(state) {
  const label = SYMPTOMS.find(s => s[0] === state.symptom)?.[1] || 'A problem';
  const body = [
    `**What went wrong:** ${label}`, '', `**What I expected:** ${state.expected || '(not given)'}`, '',
    '**Report file:** drag the downloaded `.rpreport.json.gz` here (GitHub cannot attach it through a link).', '',
    `Panel: ${navigator.userAgent.includes('Mobile') ? 'mobile' : 'desktop'}`,
  ].join('\n');
  window.open(`${ISSUES}?${new URLSearchParams({ title: label, body, labels: 'report' })}`, '_blank', 'noopener');
}
