import { logoSvg } from '../shared/brand.ts';
import { botonSvg, type BotonOptions } from '../shared/boton.ts';
import { DEFAULT_LOOK } from '../shared/look.ts';
import type { BotonLook } from '../shared/types.ts';
import { CONTACT, COPY, INSTALL_COMMAND, OS_LINE, REPO_URL } from './content.ts';

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const inline = (svg: string) => svg.replace(' xmlns="http://www.w3.org/2000/svg"', '');
const brand: BotonLook = { ...DEFAULT_LOOK, arms: 'none', backdrop: 'grid' };
const crew: BotonLook[] = [
  { ...DEFAULT_LOOK, shape: 'key', shell: 'signal', glow: 'amber', eyes: 'bars', mouth: 'grin', top: 'none', ears: 'bolts', panel: 'holes', cheeks: false },
  { ...DEFAULT_LOOK, shape: 'pill', shell: 'cobalt', glow: 'ice', eyes: 'rings', brows: 'soft', top: 'dish', ears: 'pods' },
  { ...DEFAULT_LOOK, shell: 'teal', glow: 'lime', eyes: 'happy', top: 'coil', panel: 'leds' },
  brand,
  { ...DEFAULT_LOOK, shape: 'key', shell: 'graphite', glow: 'cyan', brows: 'straight', mouth: 'calm', top: 'beacon', visor: 'goggles', panel: 'dial', cheeks: false },
  { ...DEFAULT_LOOK, shell: 'violet', glow: 'pink', eyes: 'wink', mouth: 'smirk', top: 'halo' },
  { ...DEFAULT_LOOK, shape: 'pill', shell: 'sun', glow: 'violet', eyes: 'lidded', mouth: 'wave', top: 'twin', ears: 'knobs', panel: 'switch', cheeks: false },
];

function bot(look: BotonLook, uid: string, size: number, options: BotonOptions = {}): string {
  return inline(botonSvg({ ...look, backdrop: 'grid' }, { uid, size, frame: 'none', still: false, ...options }))
    .replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
}
function logo(uid: string): string {
  return inline(logoSvg({ uid, ink: 'currentColor' })).replace('<svg ', '<svg aria-hidden="true" focusable="false" ')
    .replace(' role="img" aria-label="Botons"', '');
}
function command(compact = false): string {
  return `<div class="command${compact ? ' command-small' : ''}"><span class="command-text"><span class="prompt" aria-hidden="true">$ </span><code>${esc(INSTALL_COMMAND)}</code></span><button type="button" class="copy-button" hidden data-copied="${esc(COPY.copied)}" data-success="${esc(COPY.copiedAnnouncement)}" data-select="${esc(COPY.selectAnnouncement)}">${esc(COPY.copy)}</button></div>`;
}
function actions(): string {
  return `<div class="actions">${command()}<a class="button" href="${REPO_URL}">${esc(COPY.viewGithub)}</a></div>`;
}
const paths = [
  '<path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8M8 12h5"/>',
  '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2M5 3v3M19 3v3"/>',
  '<path d="M12 20V5M9 7a3 3 0 0 0-5 2 3 3 0 0 0 0 5 3 3 0 0 0 5 3M15 7a3 3 0 0 1 5 2 3 3 0 0 1 0 5 3 3 0 0 1-5 3M8 11h4m4 3h-4"/>',
  '<path d="M3 6h7l2 2h9v10H3z"/><path d="M3 9h18"/>',
  '<path d="M8 7H5a3 3 0 0 0 0 6h3m8-6h3a3 3 0 0 1 0 6h-3M8 10h8M12 13v6m-3-3 3 3 3-3"/>',
  '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M3 8h18M8 21h8m-4-4v4M6 6h.01M9 6h.01"/>',
  '<path d="M12 3 4 6v5c0 5 3.4 8 8 10 4.6-2 8-5 8-10V6z"/><path d="m9 12 2 2 4-4"/>',
  '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3 2.5-5 6-5s6 2 6 5M15 15c3 0 5 1.5 5 4"/>',
];
function floor(): string {
  const rays = Array.from({ length: 23 }, (_, i) => { const x = (i - 11) * 120; return `M${720 + x * .08} 0L${720 + x} 200`; }).join('');
  const lines = [0, 10, 24, 44, 72, 110, 160].map(y => `M0 ${y}H1440`).join('');
  return `<svg class="floor" viewBox="0 0 1440 200" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="floor-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0f19" stop-opacity="0"/><stop offset="1" stop-color="#0b0f19"/></linearGradient><radialGradient id="floor-pool" cx=".5" cy=".1" r=".5"><stop offset="0" stop-color="#3ee6ff" stop-opacity=".22"/><stop offset="1" stop-color="#3ee6ff" stop-opacity="0"/></radialGradient></defs><rect width="1440" height="200" fill="url(#floor-pool)"/><path d="${lines}${rays}" stroke="#3ee6ff" stroke-opacity=".3" fill="none"/><rect width="1440" height="200" fill="url(#floor-fade)" opacity=".85"/></svg>`;
}
/** The shared illustration is also used by the social image generator. */
export function renderCrew(): string {
  const sizes = [130, 150, 160, 230, 160, 150, 130];
  return `<div class="stage" role="img" aria-label="${esc(COPY.hero.crewLabel)}">${floor()}<div class="crew">${crew.map((look, i) => `<div class="crew-member crew-${i}">${bot(look, `crew${i}`, sizes[i], { state: i === 2 ? 'working' : 'idle' })}${COPY.hero.roles[i] ? `<span class="role-tag">${esc(COPY.hero.roles[i])}</span>` : ''}</div>`).join('')}</div></div>`;
}

export function renderPage({ siteUrl }: { siteUrl: string }): string {
  const base = new URL(siteUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Site URL must use HTTP or HTTPS');
  base.search = ''; base.hash = ''; base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  const canonical = esc(base.href);
  const ogImage = esc(new URL('og.png', base).href);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(COPY.title)}</title><meta name="description" content="${esc(COPY.description)}">
<link rel="canonical" href="${canonical}"><meta property="og:type" content="website"><meta property="og:title" content="${esc(COPY.title)}"><meta property="og:description" content="${esc(COPY.description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${ogImage}"><meta name="twitter:card" content="summary_large_image"><meta name="theme-color" content="#0b0f19">
<link rel="icon" href="./favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="./apple-touch-icon.png"><link rel="stylesheet" href="./styles.css"><script src="./site.js" defer></script>
</head>
<body>
<a class="skip-link" href="#main">${esc(COPY.skip)}</a>
<header class="site-header"><nav class="nav wrap" aria-label="${esc(COPY.navLabel)}"><a class="logo" href="./" aria-label="${esc(COPY.brandName)}">${logo('navlogo')}</a><div class="nav-links"><a href="#features">${esc(COPY.nav.features)}</a><a href="#compare">${esc(COPY.nav.compare)}</a><a href="#install">${esc(COPY.nav.install)}</a></div><a class="button nav-github" href="${REPO_URL}">${esc(COPY.nav.github)}</a></nav></header>
<main id="main">
<section class="hero"><div class="hero-copy"><p class="eyebrow">${esc(COPY.hero.eyebrow)}</p><h1><span>${esc(COPY.hero.headingFirst)}</span> <span>${esc(COPY.hero.headingSecond)}</span></h1><p class="hero-lede">${esc(COPY.description)}</p>${actions()}<p class="meta">${esc(OS_LINE)}</p></div>${renderCrew()}</section>
<section id="features" class="section"><div class="wrap section-grid"><div class="section-head"><p class="eyebrow">${esc(COPY.features.eyebrow)}</p><h2>${esc(COPY.features.heading)}</h2><p class="lede">${esc(COPY.features.lede)}</p></div><div class="features">${COPY.features.tiles.map(([title, text], i) => `<article class="tile"><span class="feature-icon"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[i]}</svg></span><h3>${esc(title)}</h3><p>${esc(text)}</p></article>`).join('')}</div></div></section>
<section id="brains" class="section band"><div class="wrap split"><div class="section-copy"><p class="eyebrow">${esc(COPY.brains.eyebrow)}</p><h2>${esc(COPY.brains.heading)}</h2><p class="lede">${esc(COPY.brains.lede)}</p><div class="brain-list">${COPY.brains.rows.map(([name, note], i) => `<div class="brain-row${i === 0 ? ' brain-lit' : ''}"><strong>${esc(name)}</strong><span>${esc(note)}</span></div>`).join('')}</div></div><div class="brain-art" aria-hidden="true"><div class="brain-asleep">${bot(brand, 'sleep', 120, { state: 'asleep' })}</div><span class="brain-arrow">→</span><div class="brain-awake">${bot(brand, 'awake', 200)}</div></div></div></section>
<section id="phone" class="section"><div class="wrap split"><div class="section-copy"><p class="eyebrow">${esc(COPY.phone.eyebrow)}</p><h2>${esc(COPY.phone.heading)}</h2><ul class="ticks">${COPY.phone.bullets.map(line => `<li>${esc(line)}</li>`).join('')}</ul></div><div class="phone-art" aria-hidden="true"><div class="phone"><div class="phone-header">${bot(crew[1], 'phone', 28, { frame: 'circle', still: true })}<strong>${esc(COPY.phone.name)}</strong></div><div class="phone-message">${esc(COPY.phone.message)}</div><div class="approval"><strong>${esc(COPY.phone.question)}</strong><span>${esc(COPY.phone.domain)}</span><div class="approval-actions"><span>${esc(COPY.phone.allow)}</span><span>${esc(COPY.phone.deny)}</span></div></div></div></div></div></section>
<section id="install" class="section band"><div class="wrap section-grid"><div class="section-head"><p class="eyebrow">${esc(COPY.install.eyebrow)}</p><h2>${esc(COPY.install.heading)}</h2><p class="lede">${esc(COPY.install.lede)}</p></div><ol class="steps">${COPY.install.steps.map(([title, text], i) => `<li class="step"><span class="step-number" aria-hidden="true">${i + 1}</span><div class="step-content"><h3>${esc(title)}</h3>${i === 0 ? command(true) : `<p>${esc(text)}</p>`}</div></li>`).join('')}</ol><p class="install-note">${esc(COPY.install.noteBefore)}<a href="${REPO_URL}/blob/main/docs/DOCKER.md">${esc(COPY.install.noteLink)}</a></p></div></section>
<section id="compare" class="section"><div class="wrap section-grid"><div class="section-head"><p class="eyebrow">${esc(COPY.compare.eyebrow)}</p><h2>${esc(COPY.compare.heading)}</h2></div><div class="table-scroll" role="region" aria-label="${esc(COPY.compare.scrollLabel)}" tabindex="0"><table><caption class="sr-only">${esc(COPY.compare.caption)}</caption><thead><tr>${COPY.compare.columns.map((col, i) => `<th scope="col"${i === 1 ? ' class="ours"' : ''}>${esc(col)}</th>`).join('')}</tr></thead><tbody>${COPY.compare.rows.map(row => `<tr><th scope="row">${esc(row[0])}</th>${row.slice(1).map((cell, i) => `<td${i === 0 ? ' class="ours"' : ''}>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="gaps"><strong>${esc(COPY.compare.notYet)}</strong>${COPY.compare.gaps.map(gap => `<span>${esc(gap)}</span>`).join('')}</div></div></section>
<section class="section final-cta"><div class="wrap cta-inner"><p class="eyebrow">${esc(COPY.cta.eyebrow)}</p><h2>${esc(COPY.cta.heading)}</h2>${actions()}<div class="mini-crew" aria-hidden="true">${[brand, ...crew.filter((_, i) => i !== 3).slice(0, 5)].map((look, i) => bot(look, `mini${i}`, 48)).join('')}</div></div></section>
</main>
<footer class="footer"><div class="wrap footer-inner"><a class="footer-logo" href="./" aria-label="${esc(COPY.brandName)}">${logo('footerlogo')}</a><p><a href="${REPO_URL}/blob/main/LICENSE">${esc(COPY.footer.license)}</a> <span aria-hidden="true">·</span> ${esc(COPY.footer.independent)}</p><div class="footer-links"><a href="${REPO_URL}">${esc(COPY.nav.github)}</a><a href="mailto:${CONTACT}">${esc(CONTACT)}</a></div></div></footer>
<div class="sr-only" aria-live="polite" id="copy-status"></div>
</body></html>`;
}
