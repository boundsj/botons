import { botSvg, CAST, STATES, PARTS, SHELL, GLOW, GLASS, DEFAULT_LOOK } from './bot.js';
import { logoA, logoB, logoC, appIcon, favicon } from './marks.js';

let uidN = 0;
const T = (look, o = {}) => botSvg(look, { uid: `u${uidN++}`, size: 48, ...o });
const byName = Object.fromEntries(CAST.map((c) => [c.name, c.look]));
const STATE_NAMES = { idle: 'Idle', working: 'Thinking', approval: 'Needs you', error: 'Error', asleep: 'No brain' };

const I = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 0 0-5.9.6A3 3 0 0 0 4 11a3 3 0 0 0 1 5.2A3 3 0 0 0 12 18z"/><path d="M12 5a3 3 0 0 1 5.9.6A3 3 0 0 1 20 11a3 3 0 0 1-1 5.2A3 3 0 0 1 12 18z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  panel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  clip: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  dice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><g fill="currentColor" stroke="none"><circle cx="8" cy="8" r="1.5"/><circle cx="16" cy="16" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="16" cy="8" r="1.5"/><circle cx="8" cy="16" r="1.5"/></g></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
};
const sideLogo = (ink) => `<div style="height:26px;width:136px">${logoA({ ink, uid: `sl${uidN++}` })}</div>`;
const ICON = (k, s = 16) => I[k].replace('<svg', `<svg width="${s}" height="${s}"`);

// ------------------------------------------------------------------ sections
const S = [];

S.push(`<section class="frame cover" id="cover">
  <div>
    <div class="eyebrow">Botons brand board</div>
    <div style="width:360px">${logoA({ ink: '#edf2fa', uid: 'cv' })}</div>
    <h1>A Boton is the body.<br><em>You bring the brains.</em></h1>
    <p>Botons are small, always-on helpers that live on your computer. Each one is a little button-bot: a body, a lit face and a few parts, with no brains of its own. You give it one by connecting Claude, Codex or an API key. The brand glows where it helps (the Botons, the primary action, focus) and stays calm and readable where the work happens.</p>
  </div>
  <div class="cast">${CAST.map((c) => `<div>${T(c.look, { size: 104 })}<div class="who">${c.name}</div></div>`).join('')}</div>
</section>`);

S.push(`<section class="frame" id="concept">
  <div class="eyebrow">The idea</div>
  <h2>Bring the brains</h2>
  <p class="lede">The metaphor runs through the product, and the button-bot makes it literal: a new Boton arrives with its display dark and a small standby light on. Setup's Brains step and Settings → Brains are where you give your Botons their brains. Once one is connected, the display lights up.</p>
  <div class="concept">
    <div class="step">${T({ ...DEFAULT_LOOK }, { size: 150, state: 'asleep' })}<h3>A Boton, no brain yet</h3><p>Display dark, standby light on. Nothing runs, nothing is spent.</p></div>
    <div class="arrow">→</div>
    <div class="step"><div class="brains"><span class="brain-chip">${ICON('user')} Claude or ChatGPT plan</span><span class="brain-chip">${ICON('key')} Anthropic or OpenAI key</span><span class="brain-chip">${ICON('brain')} Claude Code · Codex CLI</span></div><h3>You bring the brains</h3><p>Any one is enough. You can add more later.</p></div>
    <div class="arrow">→</div>
    <div class="step">${T({ ...DEFAULT_LOOK }, { size: 150, state: 'working' })}<h3>Lit and on it</h3><p>The ring around the button means it's thinking, and the words say so too.</p></div>
  </div>
  <div class="namecard">
    <div><b>Botons</b>The product, and the helpers in plural. Said like "buttons". The pun is in the name, so the copy doesn't have to keep making it.</div>
    <div><b>a Boton</b>One helper, in sentences: "Make a Boton", "Juniper is a Boton". Capitalized, like the product; lowercase "boton" is fine informally.</div>
    <div><b>botons</b>The lowercase wordmark is the logo only, and the command is <code style="font-family:var(--font-mono)">botons</code>.</div>
  </div>
</section>`);

// directions
const DIRS = [
  { key: 'lit', name: 'A · Lit', rec: true, blurb: 'A colored button shell with a little depth, a dark glass display with the face lit on it, and a thin rim of light around the button. The neon lives on the Boton, not behind the interface.', pros: ['Works in both themes: the display is dark glass everywhere, so the lit face always has contrast', 'Shells give each Boton its own color; the glow gives it its light', 'Reads as a button at 16 px (a disc with two lit eyes)'], cons: ['More drawing than C: shell gradient, rim and halos need the detail levels by size', 'The glass display is always dark, even in light mode (on purpose)'] },
  { key: 'line', name: 'B · Neon line', blurb: 'Bodies drawn only in glowing lines on dark: the most "light-cycle grid" option.', pros: ['The strongest Tron feel', 'Very light markup'], cons: ['In light mode every Boton becomes a dark blob with a colored outline', 'Every body is the same dark; only the line color tells them apart', 'Halos smear at 16–24 px and get tiring in a long sidebar'] },
  { key: 'toy', name: 'C · Soft toy', blurb: 'Matte vinyl shells and a pale LCD face drawn in ink, like a pocket gadget. No glow at all.', pros: ['Calmest next to dense settings', 'Very legible in light mode'], cons: ['Loses the neon and grid character the name asks for', 'The LCD face reads retro rather than electric'] },
];
S.push(`<section class="frame" id="directions">
  <div class="eyebrow">Character</div>
  <h2>Three directions for the Boton</h2>
  <p class="lede">The same eight Botons and parts in three drawing styles, on light and dark, at the sizes the app uses (16 px favicon to 220 px builder), and in each state. A is recommended.</p>
  <div style="display:grid;gap:20px">${DIRS.map((d) => `<div class="dir ${d.rec ? 'rec' : ''}" id="dir-${d.key}">
    <header><h3>${d.name}</h3>${d.rec ? '<span class="tag rec">Recommended</span>' : '<span class="tag arch">Option</span>'}</header>
    <div class="strip dk"><span class="lbl">Dark</span>${CAST.map((c) => T(c.look, { size: 72, style: d.key })).join('')}<span style="width:16px"></span>${[16, 24, 32, 48].map((s) => T(CAST[0].look, { size: s, style: d.key })).join('')}</div>
    <div class="strip lt"><span class="lbl">Light</span>${CAST.map((c) => T(c.look, { size: 72, style: d.key })).join('')}<span style="width:16px"></span>${[16, 24, 32, 48].map((s) => T(CAST[0].look, { size: s, style: d.key })).join('')}</div>
    <div class="strip dk"><span class="lbl">States</span>${STATES.map((s) => `<div class="statecell">${T(CAST[0].look, { size: 64, style: d.key, state: s })}${STATE_NAMES[s]}</div>`).join('')}<span style="width:16px"></span>${STATES.map((s) => `<div class="statecell">${T(CAST[1].look, { size: 28, style: d.key, state: s })}</div>`).join('')}</div>
    <div class="body note"><div><b>Pros</b><ul>${d.pros.map((p) => `<li>${p}</li>`).join('')}</ul></div><div><b>Cons</b><ul>${d.cons.map((p) => `<li>${p}</li>`).join('')}</ul></div></div>
    <div class="note" style="padding:0 20px 18px">${d.blurb}</div>
  </div>`).join('')}</div>
</section>`);

// part sheet
const partBase = { ...DEFAULT_LOOK, arms: 'none', backdrop: 'night' };
function partSheet(style) {
  const rows = [
    ['shape', 'Shape', 'the button'],
    ['shell', 'Shell', 'body color'],
    ['glow', 'Glow', 'face and rim light'],
    ['eyes', 'Eyes', 'resting look'],
    ['brows', 'Brows', 'resting look'],
    ['mouth', 'Mouth', 'resting look'],
    ['top', 'Top', 'antennas and more'],
    ['ears', 'Ears', 'sides'],
    ['visor', 'Visor', 'over the display'],
    ['panel', 'Panel', 'under the display'],
    ['arms', 'Arms', 'pose'],
    ['backdrop', 'Backdrop', ''],
  ];
  const sample = (k, v) => T({ ...partBase, [k]: v, ...(k === 'top' ? {} : { top: 'none' }) }, { size: 72, style, still: true });
  return `<div class="parts">${rows.map(([k, label, sub]) => `<div class="partrow"><h4>${label}${sub ? `<small>${sub}</small>` : ''}</h4><div class="opts">${Object.entries(PARTS[k]).map(([v, name]) => `<div class="opt">${sample(k, v)}${name}</div>`).join('')}</div></div>`).join('')}
  <div class="partrow"><h4>Cheeks<small>on or off</small></h4><div class="opts"><div class="opt">${T({ ...partBase, top: 'none', cheeks: true }, { size: 72, style, still: true })}On</div><div class="opt">${T({ ...partBase, top: 'none', cheeks: false }, { size: 72, style, still: true })}Off</div></div></div></div>`;
}
const combos = Object.values(PARTS).reduce((n, p) => n * Object.keys(p).length, 2);
S.push(`<section class="frame" id="parts">
  <div class="eyebrow">Character · direction A</div>
  <h2>Part sheet</h2>
  <p class="lede">The builder and the parts model stay as they are: every part is one of a fixed set of names, stored as data on the Boton and drawn as layered SVG (arms, top, ears, the button's skirt and cap, rim light, display, face, visor, panel, then state cues). A state replaces the resting eyes, brows and mouth, so mood always shows. ${(combos / 1e9).toFixed(1)} billion combinations from about 70 small drawings.</p>
  ${partSheet('lit')}
</section>`);

// palette
const TOKENS = [
  ['--bg', 'Background', 'chat, dialogs'],
  ['--bg-side', 'Side', 'sidebar, stages'],
  ['--surface', 'Surface', 'bubbles, fields'],
  ['--surface-2', 'Surface 2', 'hover, code'],
  ['--text', 'Text', ''],
  ['--muted', 'Muted', 'secondary text'],
  ['--faint', 'Faint', 'hints, times'],
  ['--border', 'Border', 'inputs, 3:1'],
  ['--accent', 'Accent', 'primary, focus'],
  ['--accent-text', 'Accent text', 'links, active'],
  ['--user', 'Your bubble', ''],
  ['--danger', 'Danger', 'errors only'],
];
S.push(`<section class="frame" id="palette">
  <div class="eyebrow">Color</div>
  <h2>Palette</h2>
  <p class="lede">Dark first: deep blue-black neutrals with an electric cyan for the primary action, focus and the active row. Light keeps the same system on white, with a deeper cyan for text. Cyan is a fill or a light, never small text on white: links and active labels use Accent text (Volt 700 in light, Volt 300 in dark). Text pairs are 7:1 or better, secondary text 4.5:1, borders 3:1, in both themes.</p>
  <div class="brandscale">${[['--volt-100', 'Volt 100'], ['--volt-200', 'Volt 200'], ['--volt-300', 'Volt 300'], ['--volt-400', 'Boton cyan 400'], ['--volt-500', 'Volt 500'], ['--volt-600', 'Volt 600'], ['--volt-700', 'Volt 700'], ['--pulse-400', 'Pulse 400'], ['--grid-800', 'Grid 800'], ['--grid-900', 'Glass 900'], ['--void-950', 'Void 950']].map(([v, n], i) => `<div style="background:var(${v});color:${i < 6 || i === 7 ? '#04121a' : '#e3fbff'}"><b>${n}</b><span data-hex="${v}"></span></div>`).join('')}</div>
  <div class="grid2">${['dark', 'light'].map((th) => `<div class="pal ${th}" style="background:var(--bg);color:var(--text);border:1px solid var(--hairline)">
    <h3>${th === 'light' ? 'Light' : 'Dark (default)'}</h3>
    <div class="chips">${TOKENS.map(([v, n, d]) => `<div class="chipc" style="background:var(${v});color:${['--text', '--muted', '--faint', '--border', '--accent-text', '--danger'].includes(v) ? 'var(--bg)' : 'var(--text)'}${v === '--accent' ? ';color:var(--accent-ink)' : ''}${v === '--user' ? ';color:var(--user-ink)' : ''}"><b>${n}</b><span>${d}<br><span data-hex="${v}"></span></span></div>`).join('')}</div>
    <div class="ratios" data-ratios></div>
  </div>`).join('')}</div>
  <div class="note" style="margin-top:18px">Glow colors (the face and rim): ${Object.entries(GLOW).map(([k, v]) => `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:12px"><span class="swatch" style="width:18px;height:18px;border-radius:6px;background:${v};box-shadow:0 0 8px ${v}"></span>${PARTS.glow[k]}</span>`).join('')}<br>Shells: ${Object.entries(SHELL).map(([k, v]) => `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:12px"><span class="swatch" style="width:18px;height:18px;border-radius:999px;background:${v}"></span>${PARTS.shell[k]}</span>`).join('')}<br>Every glow is 7:1 or better on the display glass (${GLASS}), so the face reads on every Boton in both themes. The skirt or the rim light keeps every shell at 3:1 against every backdrop.</div>
</section>`);

S.push(`<section class="frame" id="motifs">
  <div class="eyebrow">Light, grid and circuit</div>
  <h2>Where the neon goes</h2>
  <p class="lede">Neon is an accent and a character, not a background. Four motifs, each with a fixed place. Glow is never the only signal: every state also has words, an icon or a badge, and motion stops under reduced motion and with Settings → "Animate Botons" off.</p>
  <div class="motifs">
    <div class="motif"><div class="art" style="background:#0b0f19"><span class="btn primary" style="--accent:#3ee6ff;--accent-ink:#04121a;--accent-edge:#3ee6ff;box-shadow:inset 0 0 0 1px #3ee6ff,0 0 16px #3ee6ff55">Continue</span></div><footer><b>Lit edge</b>Primary buttons, the send button, focus rings and the selected choice. One glowing thing per view.</footer></div>
    <div class="motif"><div class="art grid-bg" style="background-color:#080b13">${T({ ...DEFAULT_LOOK, backdrop: 'grid' }, { size: 96 })}</div><footer><b>Grid</b>A faint grid behind setup, the builder's stage, empty states and the claim page. Never behind the chat or settings.</footer></div>
    <div class="motif"><div class="art" style="background:#0b0f19"><svg width="200" height="90" viewBox="0 0 200 90" fill="none" stroke="#3ee6ff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><g stroke-opacity=".25" stroke-width="5"><path d="M0 70H50L70 50H120L135 35H200"/></g><path d="M0 70H50L70 50H120L135 35H200"/><path d="M0 22H40L52 34H96" stroke-opacity=".6"/><circle cx="96" cy="34" r="3.5" fill="#0b0f19"/><circle cx="120" cy="50" r="3.5" fill="#3ee6ff"/><path d="M150 80H180L190 70" stroke-opacity=".6"/><circle cx="190" cy="70" r="3" fill="#0b0f19"/></svg></div><footer><b>Circuit trace</b>A single line that joins steps: setup's progress, the brain linking to a Boton, the marketing site. Decorative, hidden from screen readers.</footer></div>
    <div class="motif"><div class="art" style="background:#0b0f19;gap:8px;display:flex;justify-content:center;align-items:center">${['idle', 'working', 'approval', 'error', 'asleep'].map((s) => T(CAST[0].look, { size: 44, state: s })).join('')}</div><footer><b>The Botons</b>The only place many colors glow at once. Their light is on their own display, so it never sits behind text.</footer></div>
  </div>
</section>`);

S.push(`<section class="frame" id="type">
  <div class="eyebrow">Type</div>
  <h2>Typography</h2>
  <p class="lede">No web fonts to download. The interface keeps the system UI stack (Inter where installed), with heavier, tighter display settings for setup titles and empty states. Small uppercase labels use the system monospace for a quiet instrument-panel feel. The wordmark is drawn, not typeset.</p>
  <div class="typespec"><div>
    <div class="specrow"><span>Display · UI 760 / −2.5%</span><span class="d1">Bring the brains</span></div>
    <div class="specrow"><span>Title · UI 700</span><span class="d2">Your first Boton</span></div>
    <div class="specrow"><span>Heading · UI 600</span><span class="t1">Who can connect</span></div>
    <div class="specrow"><span>Body · UI 400 / 15</span><span class="b1">Volt checked the build and posted the results. Two tests failed on the payments service; it's looking into the first one now.</span></div>
    <div class="specrow"><span>Caption · UI 400 / 12.5</span><span class="c1">Today, 9:41 AM · Runs every weekday at 8:00</span></div>
    <div class="specrow"><span>Label · mono 600 / 12</span><span class="e1">Pinned · Home · Brains</span></div>
    <div class="specrow"><span>Mono · 13.5</span><span class="m1">botons routine create --every weekday --at 08:00</span></div>
  </div><div class="note">
    <b>Rules</b>
    <ul>
      <li>Display weight only at 22 px and up, and never for body text, settings or warnings.</li>
      <li>Mono labels are short and uppercase: group names, section labels, eyebrows. Never sentences.</li>
      <li>Sentence case everywhere else, including buttons and titles.</li>
      <li>Chat text stays at 15 px with 1.5 line height and no glow; density comes from spacing, not smaller type.</li>
      <li>Numbers that change in place (costs, counts, times) use tabular figures.</li>
      <li>"Botons" is the product and the plural, "Boton" one helper. The lowercase "botons" is the wordmark only.</li>
    </ul>
  </div></div>
</section>`);

S.push(`<section class="frame" id="logos">
  <div class="eyebrow">Identity</div>
  <h2>Logo and wordmark options</h2>
  <p class="lede">A rounded monoline wordmark drawn with strokes: a few hundred bytes, no font, crisp at any size. A is recommended.</p>
  <div class="logos">
    <div class="logo rec"><div class="dk"><div style="width:280px">${logoA({ ink: '#edf2fa', uid: 'lgad' })}</div></div><div class="lt"><div style="width:280px">${logoA({ uid: 'lga' })}</div></div><footer><span class="tag rec">Recommended</span> <b>A · Boton and wordmark.</b> The brand Boton is the app icon, the favicon and the sidebar mark; the wordmark joins it when there's room.</footer></div>
    <div class="logo"><div class="dk"><div style="width:230px">${logoB({ ink: '#edf2fa' })}</div></div><div class="lt"><div style="width:230px">${logoB()}</div></div><footer><span class="tag arch">Option</span> <b>B · Face o.</b> The o is a lit display with a face. Memorable in one word, but the face alone is a small icon with little character.</footer></div>
    <div class="logo"><div class="dk"><div style="width:250px">${logoC({ ink: '#0b0f19', fill: '#edf2fa' })}</div></div><div class="lt"><div style="width:250px">${logoC()}</div></div><footer><span class="tag arch">Option</span> <b>C · The button.</b> The name on a pill button with a lit edge. The pun at its most literal, but it reads as a UI control, not a mark.</footer></div>
  </div>
  <div class="icons">
    <div>${appIcon('ic1', { size: 180 })}<div class="cap">App icon · PWA 512 / 180</div></div>
    <div>${appIcon('ic2', { size: 64 })}<div class="cap">64</div></div>
    <div>${appIcon('ic3', { size: 40 })}<div class="cap">40</div></div>
    <div>${favicon(64)}<div class="cap">Favicon 64</div></div>
    <div>${favicon(32)}<div class="cap">32</div></div>
    <div>${favicon(16)}<div class="cap">16</div></div>
    <div style="margin-left:24px;padding:14px 18px;border-radius:14px;background:#f4f6fa">${favicon(32)} ${favicon(16)}<div class="cap" style="color:#59647d">On a light tab bar</div></div>
  </div>
</section>`);

S.push(`<section class="frame" id="voice">
  <div class="eyebrow">Voice</div>
  <h2>Voice and copy</h2>
  <p class="lede">Plain, calm and brief. Botons talks like a capable friend who knows computers: what happened, what it means for you, what to do next. The characters carry the charm, so the words don't need to.</p>
  <div class="voice"><div>
    <h3>Principles</h3>
    <div class="note"><ul>
      <li><b>Say what's true, then what to do.</b> "Claude isn't signed in. Sign in, then try again."</li>
      <li><b>Name things the same way everywhere:</b> Boton, brain, routine, Workspace, Full computer.</li>
      <li><b>You and it.</b> The owner is "you"; a Boton is "it", and it has a name.</li>
      <li><b>Short labels, sentence case,</b> verbs on buttons ("Connect", "Create Boton", not "OK").</li>
      <li><b>Pun budget: one per screen at most,</b> only in welcome, empty and success moments.</li>
      <li><b>Never</b> a pun, joke or cute tone in errors, security, access, keys, spending, data loss or anything destructive.</li>
    </ul></div>
    <h3 style="margin-top:18px">Where the wink goes</h3>
    <div class="note"><ul>
      <li>Setup: "Bring the brains" (the Brains step title).</li>
      <li>A Boton with no brain: "No brain yet. Connect one in Settings → Brains."</li>
      <li>Empty sidebar: "No Botons yet. Make your first one and give it a job."</li>
      <li>Setup's last step, once: "Lights on." (its display lights up for the first time).</li>
    </ul></div>
  </div><div>
    <h3>Examples</h3>
    <div class="say">
      <div class="do">Bring the brains</div><div class="dont">Configure model providers</div>
      <div class="do">Juniper needs you to approve a command.</div><div class="dont">Juniper is pushing your buttons!</div>
      <div class="do">Couldn't reach Claude. Check that it's signed in, then try again.</div><div class="dont">Uh oh, short circuit! ⚡</div>
      <div class="do">Full computer runs commands as the server user, with no sandbox.</div><div class="dont">Unleash your Boton!</div>
      <div class="do">Thinking…</div><div class="dont">Computing… beep boop</div>
      <div class="do">Delete Volt? Its chat, routines and memory are removed.</div><div class="dont">Power down Volt forever?</div>
      <div class="do">No Botons yet. Make your first one and give it a job.</div><div class="dont">Press any button to begin! 🤖</div>
    </div>
  </div></div>
</section>`);

// ------------------------------------------------------------------ mockups
const bots = [
  { name: 'Juniper', look: byName.Juniper, state: 'working', preview: 'Thinking…', time: 'now', think: true },
  { name: 'Volt', look: byName.Volt, state: 'approval', preview: 'Wants to run npm test', time: '2m', badge: '1' },
  { name: 'Scout', look: byName.Scout, state: 'idle', preview: 'Inbox is clear. 3 newsletters archived.', time: '9:12' },
  { name: 'Clover', look: byName.Clover, state: 'idle', preview: 'Watered the plants routine ran fine', time: '8:00' },
  { name: 'Ledger', look: byName.Ledger, state: 'error', preview: 'Couldn\'t reach the Codex CLI', time: 'Tue', err: true },
  { name: 'Pip', look: byName.Pip, state: 'asleep', preview: 'No brain yet', time: '' },
  { name: 'Ziggy', look: byName.Ziggy, state: 'idle', preview: 'Playlist for the drive is ready', time: 'Mon' },
];

function sidebar(ink, active = 'Juniper', n = 7) {
  return `<aside class="side">
    <div class="side-head">${sideLogo(ink)}<span class="sp"></span><span class="ib">${I.search}</span><span class="ib">${I.plus}</span></div>
    <div></div>
    <div class="list"><div class="group" style="font-family:var(--font-mono)">Pinned</div>${bots.slice(0, n).map((t, i) => `${i === 2 ? '<div class="group" style="font-family:var(--font-mono)">Home</div>' : ''}<div class="item ${t.name === active ? 'on' : ''}">${T(t.look, { size: 44, state: t.state })}<div style="min-width:0"><div class="nm">${t.name}</div><div class="pv ${t.think ? 'think' : ''}">${t.preview}</div></div><div class="meta">${t.time}${t.badge ? `<span class="badge">${t.badge}</span>` : ''}${t.err ? '<span class="badge err">!</span>' : ''}</div></div>`).join('')}</div>
    <div class="side-foot"><span class="who">Sam's server</span><span class="ib">${I.clock}</span><span class="ib">${I.gear}</span></div>
  </aside>`;
}
function chatMain(phone = false) {
  const j = byName.Juniper;
  return `<section class="main">
    <div class="chat-head">${phone ? `<span class="ib">${I.back}</span>` : ''}<span class="pill">${T(j, { size: 30, state: 'working' })}Juniper <small>· Claude</small></span><span class="sp"></span>${phone ? '' : `<span class="ib">${I.clock}</span><span class="ib">${I.brain}</span><span class="ib">${I.folder}</span>`}<span class="ib">${I.panel}</span></div>
    <div class="msgs">
      <div class="day">Today</div>
      <div class="msg me">Can you check why the nightly backup was slow, and tell me if anything needs doing?</div>
      <div class="msg bot">${T(j, { size: 32 })}<div class="bub"><p>It took 41 minutes instead of the usual 6. The photo library grew by 38 GB on Tuesday, and the backup copies new files in full.</p>${phone ? '' : '<pre>du -sh ~/Pictures/Library   # 212G, up from 174G</pre>'}<p>Nothing is broken. If you'd like, I can exclude the <code>Cache</code> folder, which is 9 GB and rebuilds on its own.</p></div></div>
      <div class="msg me">Yes, exclude it. And run it again tonight.</div>
      <div><span class="chip-run">${ICON('clock', 14)} Updated routine Nightly backup</span></div>
      <div class="thinking">${T(j, { size: 32, state: 'working' })}<span><b>Juniper</b> is thinking… <span style="color:var(--faint)">Running du -sh ~/Pictures</span></span></div>
    </div>
    <div class="composer ${phone ? '' : 'focus'}">${I.clip}<span>Message Juniper</span><span class="send">${I.send}</span></div>
  </section>`;
}
function desk(theme) {
  const ink = theme === 'dark' ? '#edf2fa' : '#0d1322';
  return `<div class="mock desk ${theme}">${sidebar(ink)}${chatMain()}</div>`;
}
S.push(`<section class="frame" id="m-chat-dark"><div class="eyebrow">Mockup · desktop · dark (default)</div><h2>Sidebar and chat</h2><p class="lede">States show in the avatar and in words: a lit ring and "Thinking…" for Juniper, a raised arm and an amber badge for Volt, a red marker and a worried face for Ledger, and Pip's dark display with "No brain yet". The chat stays quiet: flat neutral bubbles, no glow behind text, cyan only on the active row's edge, the focused composer and the send button.</p>${desk('dark')}</section>`);
S.push(`<section class="frame light-frame" id="m-chat-light"><div class="eyebrow">Mockup · desktop · light</div><h2>Sidebar and chat, light</h2><p class="lede">The same system on white. The Botons keep their dark glass displays, so their faces glow in light mode too; the interface uses the deeper cyan for text and edges, and glow drops to a soft halo.</p>${desk('light')}</section>`);

function setupBrains(theme, connected, phone = false) {
  const look = { ...DEFAULT_LOOK };
  return `<div class="setup"><div class="col">
    <div class="steps"><i class="done"></i><i class="done"></i><i class="done"></i><i></i><i></i></div>
    <div class="hero">${T(look, { size: phone ? 112 : 132, state: connected ? 'idle' : 'asleep', label: connected ? 'Your Boton, lit up' : 'Your Boton, display dark: no brain yet' })}${connected ? '' : '<span class="nobrain">No brain yet</span>'}</div>
    <h1>Bring the brains</h1>
    <p class="sub">Botons are the bodies. The thinking comes from a model you already use. You need just one; add others later in Settings → Brains.</p>
    <div class="choice ${connected ? 'on' : ''}"><span class="ic">${I.user}</span><span><b>Use my Claude or ChatGPT plan</b><span>Sign in to your account. Your plan's limits apply.</span></span>${connected ? `<span style="color:var(--ok)">${I.check}</span>` : ''}</div>
    <div class="choice"><span class="ic">${I.key}</span><span><b>Use an API key</b><span>Pay per use, with an optional daily spending cap.</span></span></div>
    ${connected ? `<div class="status ok">${I.check}<span><b>Claude is connected.</b> <span style="color:var(--muted)">Your Botons can think now.</span></span></div>` : ''}
    <div class="actions"><span class="btn ghost">Back</span><span class="btn primary" style="${connected ? '' : 'opacity:.5;box-shadow:none'}">Continue</span></div>
    <div class="skip">Skip setup</div>
  </div></div>`;
}
S.push(`<section class="frame" id="m-setup"><div class="eyebrow">Mockup · setup · desktop</div><h2>The Brains step</h2><p class="lede">The Boton on top has a dark display and a standby light until a brain is connected; then its face lights up. The options and their facts don't change. Dark before, light after.</p>
  <div class="grid2"><div class="mock dark" style="height:760px">${setupBrains('dark', false)}</div><div class="mock light" style="height:760px">${setupBrains('light', true)}</div></div></section>`);

function builder(phone = false) {
  const look = byName.Volt;
  const opts = Object.entries(PARTS.top).map(([v, n]) => `<div class="ocell ${v === 'none' ? 'on' : ''}">${T({ ...look, top: v, arms: 'none' }, { size: phone ? 52 : 64, still: true })}${n}</div>`).join('');
  return `<div class="builder">
    <div class="stage">${T(look, { size: phone ? 104 : 220, label: 'Volt' })}<div style="display:grid;gap:10px;justify-items:${phone ? 'start' : 'center'}">
      ${phone ? '<div style="font:700 22px var(--font-display)">Volt</div>' : ''}
      ${phone ? '' : `<div class="states">${['Idle', 'Thinking', 'Needs you', 'Error', 'No brain'].map((s, i) => `<span class="seg ${i === 0 ? 'on' : ''}">${s}</span>`).join('')}</div>`}
      <div style="display:flex;gap:6px"><span class="btn">${I.dice} Surprise me</span>${phone ? '' : `<span class="btn ghost">${I.undo} Reset</span>`}</div></div>
      ${phone ? `<div class="states" style="grid-column:1/-1;flex-wrap:nowrap;overflow:hidden;justify-content:start">${['Idle', 'Thinking', 'Needs you', 'Error', 'No brain'].map((s, i) => `<span class="seg ${i === 0 ? 'on' : ''}" style="white-space:nowrap">${s}</span>`).join('')}</div>` : ''}</div>
    <div class="picker">
      ${phone ? '' : '<div class="field"><label>Name</label><div class="input">Volt</div></div>'}
      <div class="tabs"><span>Face</span><span class="on">Parts</span><span>Extras</span><span>Colors</span></div>
      <div style="display:grid;gap:12px;align-content:start;overflow:hidden">
        <div class="sect">Top</div><div class="ogrid">${opts}</div>
        ${phone ? '' : `<div class="sect">Ears</div><div class="ogrid">${Object.entries(PARTS.ears).map(([v, n]) => `<div class="ocell ${v === 'bolts' ? 'on' : ''}">${T({ ...look, ears: v, arms: 'none' }, { size: 64, still: true })}${n}</div>`).join('')}</div>`}
        <div class="sect">Glow</div><div class="colors">${Object.entries(GLOW).map(([k, v]) => `<span class="dot ${k === 'amber' ? 'on' : ''}" style="background:${v}" title="${k}"></span>`).join('')}</div>
      </div>
      <div class="foot"><span class="btn ghost">Cancel</span><span class="btn primary">${phone ? 'Done' : 'Save look'}</span></div>
    </div>
  </div>`;
}
S.push(`<section class="frame" id="m-builder"><div class="eyebrow">Mockup · Boton builder · desktop</div><h2>The Boton builder</h2><p class="lede">The same one editor wherever a Boton is made or changed: setup's first Boton, New Boton, its settings and templates. A random look is ready before anyone opens it; "Surprise me" draws another. The preview shows every state. The stage sits on a faint grid; every choice is a labelled button with a live thumbnail, reachable by keyboard.</p>
  <div style="display:grid;gap:24px"><div class="mock dark" style="height:600px;width:1100px;justify-self:center">${builder()}</div><div class="mock light" style="height:600px;width:1100px;justify-self:center">${builder()}</div></div></section>`);

function phone(theme, inner) {
  return `<div class="phone"><div class="scr ${theme}" style="background:var(--bg)"><div class="sbar"><span>9:41</span><span>●●● ▮</span></div>${inner}</div></div>`;
}
S.push(`<section class="frame" id="m-phone"><div class="eyebrow">Mockup · phone</div><h2>On a phone</h2><p class="lede">Same layout and density as today's phone views: the sidebar and chat are full-screen views, the builder becomes a sheet with the preview on top.</p>
<div class="phones">
  ${phone('dark', `<div style="grid-row: span 3; display:grid; grid-template-rows:minmax(0,1fr);min-height:0">${chatMain(true).replace('<section class="main">', '<section class="main" style="min-height:0;height:100%">')}</div>`)}
  ${phone('light', `<div style="grid-row: span 3;display:grid;min-height:0">${sidebar('#0d1322', '', 7).replace('<aside class="side">', '<aside class="side" style="border:0">')}</div>`)}
  ${phone('dark', `<div style="grid-row: span 3;overflow:hidden">${setupBrains('dark', false, true)}</div>`)}
  ${phone('light', `<div style="grid-row: span 3;display:grid;min-height:0">${builder(true)}</div>`)}
</div></section>`);

S.push(`<section class="frame" id="m-more"><div class="eyebrow">Mockup · other screens</div><h2>Claim, empty and error</h2><p class="lede">The same calm voice everywhere. Characters appear where they help (welcome, empty, waiting) and the copy stays plain where trust matters.</p>
<div class="mini">
  <div class="mock dark"><div class="center setup" style="padding:28px"><div style="width:190px">${logoA({ ink: '#edf2fa', uid: 'cl' })}</div><h2>Claim this server</h2><p>This Botons server has no owner yet. Approve this device on myhost to prove it's yours; the code lasts 15 minutes.</p><div class="code">K7Q-42M</div><p style="font-size:13px"><code style="font-family:var(--font-mono)">botons pair --approve K7Q-42M</code></p></div></div>
  <div class="mock light"><div class="center setup" style="padding:28px">${T({ ...DEFAULT_LOOK, top: 'coil', backdrop: 'ice' }, { size: 120, state: 'asleep' })}<h2>No Botons yet</h2><p>Make your first one and give it a job: a morning brief, a watch on a folder, a weekly tidy.</p><span class="btn primary">${I.plus} New Boton</span></div></div>
  <div class="mock dark"><div class="center">${T({ ...DEFAULT_LOOK }, { size: 120, state: 'error' })}<h2>Something went wrong</h2><p>The page hit an error it couldn't recover from. Your Botons keep running on the server.</p><div style="display:flex;gap:8px"><span class="btn primary">Reload</span><span class="btn">Copy details</span></div></div></div>
</div></section>`);

document.getElementById('sheet').innerHTML = S.join('');

// Fill in hex values and contrast ratios from the live tokens.
const lum = (c) => {
  const m = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const read = (el, v) => { const s = document.createElement('span'); s.style.color = `var(${v})`; el.append(s); const c = getComputedStyle(s).color; s.remove(); return c; };
const toHex = (c) => '#' + c.match(/[\d.]+/g).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('');
for (const el of document.querySelectorAll('[data-hex]')) el.textContent = toHex(read(el.parentElement, el.dataset.hex));
for (const box of document.querySelectorAll('[data-ratios]')) {
  const pal = box.closest('.pal');
  const pairs = [['--text', '--bg', 7], ['--text', '--bg-side', 7], ['--text', '--surface', 7], ['--muted', '--bg', 4.5], ['--muted', '--surface', 4.5], ['--faint', '--bg-side', 4.5], ['--accent-text', '--bg', 4.5], ['--accent-ink', '--accent', 7], ['--user-ink', '--user', 7], ['--danger', '--bg', 4.5], ['--border', '--bg', 3], ['--accent-edge', '--bg', 3], ['--focus', '--bg', 3], ['--ok', '--bg', 4.5]];
  box.innerHTML = pairs.map(([f, b, min]) => { const r = ratio(read(pal, f), read(pal, b)); return `<span>${f.slice(2)} on ${b.slice(2)} <b class="${r >= min ? 'ok' : ''}" data-ratio="${r.toFixed(2)}" data-min="${min}">${r.toFixed(1)}:1</b></span>`; }).join('');
}
document.body.dataset.ready = '1';
