// Draws the README's hero GIF, docs/assets/botons-team.gif: four Botons light up one by one, pass a task along, finish
// it together and go back to rest, so the loop is seamless. Run it by hand after changing the Botons' look; CI never
// does. It needs the development dependencies (Playwright's Chromium, or CHROMIUM_PATH) and ffmpeg on PATH.
//
//   node scripts/make-readme-gif.ts [--frames <folder>]   (--frames keeps the PNG frames there to look at)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { botonInner } from '../shared/boton.ts';
import { DEFAULT_LOOK, GLOWS } from '../shared/look.ts';
import type { AvatarState, BotonLook } from '../shared/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs/assets/botons-team.gif');
const W = 960, H = 340, FPS = 25, SECONDS = 6, SCALE = 2;
const BG = '#0b0f19', CYAN = '#3ee6ff', SURFACE = '#131a28', HAIRLINE = '#1d2638', MUTED = '#a8b3c7', TEXT = '#edf2fa';
const MONO = `'JetBrains Mono', 'DejaVu Sans Mono', 'Liberation Mono', ui-monospace, monospace`;

// The team, from the site's crew: each with a role, left to right in the order the task reaches them.
const team: { role: string; look: BotonLook }[] = [
  { role: 'Inbox', look: { ...DEFAULT_LOOK, shape: 'key', shell: 'signal', glow: 'amber', eyes: 'bars', mouth: 'grin', top: 'none', ears: 'bolts', panel: 'holes', cheeks: false } },
  { role: 'Research', look: { ...DEFAULT_LOOK, shape: 'pill', shell: 'cobalt', glow: 'ice', eyes: 'rings', brows: 'soft', top: 'dish', ears: 'pods' } },
  { role: 'Writer', look: { ...DEFAULT_LOOK, shell: 'violet', glow: 'pink', eyes: 'wink', mouth: 'smirk', top: 'halo' } },
  { role: 'Review', look: { ...DEFAULT_LOOK, shape: 'key', shell: 'graphite', glow: 'cyan', brows: 'straight', mouth: 'calm', top: 'beacon', visor: 'goggles', panel: 'dial', cheeks: false } },
];
const SIZE = 150, TOP = 108, X = [180, 380, 580, 780];

// The timeline, in seconds.
const LIGHT = [0.3, 0.55, 0.8, 1.05];   // each Boton's brain comes on
const FADE = 0.25;
const ARRIVE = 1.3, HOP = 0.35, WORK = 0.5;
const at = (i: number) => ARRIVE + HOP + i * (WORK + HOP);   // the task reaches Boton i
const DONE = at(3) + WORK;                                   // Review signs it off
const REST = 5.35;                                           // everyone goes back to rest

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const ramp = (t: number, start: number, length: number) => clamp((t - start) / length);
const ease = (v: number) => v * v * (3 - 2 * v);
const easeOut = (v: number) => 1 - (1 - v) ** 3;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** One Boton drawn at time t, its motion (blink, the busy ring, the z) set by hand so each frame is exact. */
function bot(look: BotonLook, state: AvatarState, uid: string, t: number, blinkAt: number): string {
  const blink = state === 'idle' && ((t - blinkAt) % 3 + 3) % 3 < 0.12 ? 0.12 : 1;
  return botonInner({ ...look, backdrop: 'grid' }, { state, uid, size: SIZE, frame: 'none', still: false })
    .replace(/ class="av-spin" style="([^"]*)"/, (_, style) => ` style="${style};transform-box:view-box;transform:rotate(${r1((t * 200) % 360)}deg)"`)
    .replace(/ class="av-blink"/, ` style="transform-box:fill-box;transform-origin:50% 50%;transform:scaleY(${blink})"`)
    .replace(/ class="av-zzz"/, ` transform="translate(0 ${r1(-1.2 - Math.sin(t * Math.PI) * 1.2)})" opacity="${r1(0.8 + Math.sin(t * Math.PI) * 0.2)}"`)
    .replace(/ class="[^"]*"/g, '');
}

function floor(): string {
  const rays = Array.from({ length: 23 }, (_, i) => { const x = (i - 11) * 120; return `M${720 + x * 0.08} 0L${720 + x} 200`; }).join('');
  const lines = [0, 10, 24, 44, 72, 110, 160].map((y) => `M0 ${y}H1440`).join('');
  return `<svg x="0" y="${H - 150}" width="${W}" height="150" viewBox="0 0 1440 200" preserveAspectRatio="none"><defs><linearGradient id="ff" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BG}" stop-opacity="0"/><stop offset="1" stop-color="${BG}"/></linearGradient><radialGradient id="fp" cx=".5" cy=".1" r=".5"><stop offset="0" stop-color="${CYAN}" stop-opacity=".2"/><stop offset="1" stop-color="${CYAN}" stop-opacity="0"/></radialGradient></defs><rect width="1440" height="200" fill="url(#fp)"/><path d="${lines}${rays}" stroke="${CYAN}" stroke-opacity=".28" fill="none"/><rect width="1440" height="200" fill="url(#ff)" opacity=".85"/></svg>`;
}

/** Where the task is: above a Boton's head while it works, flying in an arc between them. */
function taskAt(t: number): { x: number; y: number; holder: number } | null {
  const rest = (i: number) => ({ x: X[i], y: TOP - 16 + Math.sin(t * 5) * 2, holder: i });
  if (t < ARRIVE || t >= REST + 0.25) return null;
  if (t < at(0)) { const p = easeOut(ramp(t, ARRIVE, HOP)); return { x: -40 + (X[0] + 40) * p, y: TOP - 40 + 24 * p, holder: -1 }; }
  for (let i = 0; i < 3; i++) {
    const leave = at(i) + WORK;
    if (t < leave) return rest(i);
    if (t < at(i + 1)) { const p = ease(ramp(t, leave, HOP)); return { x: X[i] + (X[i + 1] - X[i]) * p, y: TOP - 16 - Math.sin(p * Math.PI) * 40, holder: -1 }; }
  }
  return rest(3);
}

function card(x: number, y: number, lines: number, opacity: number, color: string): string {
  const bars = [0, 1, 2].map((i) => `<rect x="-14" y="${-8 + i * 7}" width="${i === 2 ? 18 : 28}" height="3" rx="1.5" fill="${i < lines ? color : '#2a3550'}"/>`).join('');
  return `<g transform="translate(${r1(x)} ${r1(y)})" opacity="${r1(opacity * 100) / 100}"><rect x="-22" y="-16" width="44" height="32" rx="7" fill="${SURFACE}" stroke="${color}" stroke-width="1.6"/><rect x="-22" y="-16" width="44" height="32" rx="7" fill="none" stroke="${color}" stroke-opacity=".25" stroke-width="6"/>${bars}</g>`;
}

function frame(t: number): string {
  let s = `<rect width="${W}" height="${H}" fill="${BG}"/>${floor()}`;
  const done = ramp(t, DONE, 0.25);
  const sleep = ease(ramp(t, REST, 0.4));
  team.forEach(({ role, look }, i) => {
    const glow = GLOWS[look.glow];
    const on = ease(ramp(t, LIGHT[i], FADE)) * (1 - sleep);
    const working = t >= at(i) && t < at(i) + WORK;
    const happy = done > 0 && sleep < 1;
    const bounce = happy ? Math.sin(Math.min(1, (t - DONE - i * 0.06) / 0.45) * Math.PI) * 7 * (t > DONE + i * 0.06 ? 1 : 0) : 0;
    const x = X[i] - SIZE / 2, y = TOP - bounce;
    // A pool of light on the floor under a Boton with a brain.
    s += `<ellipse cx="${X[i]}" cy="${TOP + SIZE * 0.93}" rx="${SIZE * 0.36}" ry="9" fill="${glow}" opacity="${r1(on * 18) / 100}"/>`;
    const wrap = (inner: string, opacity: number) => opacity <= 0 ? '' : `<g transform="translate(${x} ${r1(y)}) scale(${SIZE / 100})" opacity="${r1(opacity * 100) / 100}">${inner}</g>`;
    const awakeLook = happy ? { ...look, eyes: 'happy' as const, mouth: 'grin' as const } : look;
    s += wrap(bot(look, 'asleep', `s${i}`, t, 0), 1 - on);
    s += wrap(bot(awakeLook, working ? 'working' : 'idle', `a${i}`, t, LIGHT[i] + 0.9 + i * 0.45), on);
    // The moment its brain comes on: a ring of light.
    const pulse = ramp(t, LIGHT[i], 0.6);
    if (pulse > 0 && pulse < 1) s += `<circle cx="${X[i]}" cy="${TOP + SIZE * 0.55}" r="${r1(40 + easeOut(pulse) * 52)}" fill="none" stroke="${glow}" stroke-width="2.5" opacity="${r1((1 - pulse) * 70) / 100}"/>`;
    // Its role, lit with it.
    const tagW = role.length * 8.4 + 22, tagY = TOP + SIZE + 6;
    s += `<g transform="translate(${X[i] - tagW / 2} ${tagY})"><rect width="${r1(tagW)}" height="24" rx="12" fill="${SURFACE}" stroke="${HAIRLINE}"/><rect width="${r1(tagW)}" height="24" rx="12" fill="none" stroke="${glow}" stroke-opacity="${r1(on * 70) / 100}"/><text x="${r1(tagW / 2)}" y="16.2" text-anchor="middle" font-family="${MONO}" font-size="11" font-weight="600" letter-spacing="1.1" fill="${on > 0.5 ? TEXT : MUTED}">${role.toUpperCase()}</text></g>`;
  });
  // The task, gaining a line with each Boton, then signed off with a check.
  const task = taskAt(t);
  if (task) {
    const lines = [0, 1, 2].filter((i) => t >= at(i) + WORK).length;
    const color = task.holder >= 0 ? GLOWS[team[task.holder].look.glow] : CYAN;
    const fadeOut = 1 - ramp(t, REST, 0.25);
    for (const lag of [0.06, 0.03]) {
      const ghost = taskAt(t - lag);
      if (ghost && task.holder < 0 && ghost.holder < 0) s += card(ghost.x, ghost.y, lines, lag === 0.06 ? 0.15 : 0.3, CYAN);
    }
    s += card(task.x, task.y, lines, fadeOut, done > 0 ? CYAN : color);
    if (done > 0) {
      const pop = easeOut(done), cx = task.x + 20, cy = task.y - 14;
      s += `<g opacity="${r1(fadeOut * 100) / 100}">`;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2, d0 = 14 + pop * 10, d1 = d0 + 7 * (1 - pop);
        if (pop < 1) s += `<path d="M${r1(cx + Math.cos(a) * d0)} ${r1(cy + Math.sin(a) * d0)}L${r1(cx + Math.cos(a) * d1)} ${r1(cy + Math.sin(a) * d1)}" stroke="${CYAN}" stroke-width="2" stroke-linecap="round" opacity="${r1((1 - pop) * 100) / 100}"/>`;
      }
      s += `<g transform="translate(${r1(cx)} ${r1(cy)}) scale(${r1((0.6 + 0.4 * pop) * 100) / 100})"><circle r="11" fill="${CYAN}" stroke="${BG}" stroke-width="2"/><path d="M-4.6 0.2l3.1 3.1 6-6.2" stroke="#04121a" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g></g>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${s}</svg>`;
}

const keep = process.argv.indexOf('--frames');
const framesDir = keep > 0 ? process.argv[keep + 1] : mkdtempSync(join(tmpdir(), 'botons-gif-'));
mkdirSync(framesDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:${BG}"><div id="f"></div></body></html>`);
  const total = FPS * SECONDS;
  for (let n = 0; n < total; n++) {
    await page.evaluate((svg) => { document.getElementById('f')!.innerHTML = svg; }, frame(n / FPS));
    await page.screenshot({ path: join(framesDir, `f${String(n).padStart(4, '0')}.png`), clip: { x: 0, y: 0, width: W, height: H } });
  }
} finally {
  await browser.close();
}
mkdirSync(dirname(out), { recursive: true });
// One palette for the whole loop, and only the changed part of each frame stored.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', join(framesDir, 'f%04d.png'), '-vf',
  `scale=${W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
  '-loop', '0', out], { stdio: 'inherit' });
if (keep < 0) rmSync(framesDir, { recursive: true, force: true });
console.log(`Wrote ${out} (${Math.round(statSync(out).size / 1024)} KB)`);
