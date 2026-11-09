import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTACT, INSTALL_COMMAND, OS_LINE, REPO_URL } from '../../site/content.ts';
import { renderPage } from '../../site/page.ts';

test('marketing page has portable assets, honest copy and social metadata', () => {
  const base = 'https://example.com/x/';
  const html = renderPage({ siteUrl: base });
  assert.ok(html.includes('runs your own Claude Code or Codex'));
  assert.ok(html.includes(INSTALL_COMMAND));
  assert.ok(html.includes(`${REPO_URL}/blob/main/docs/install.md`), 'Get started links to the full install guide');
  assert.ok(html.includes(OS_LINE));
  assert.equal(OS_LINE, 'Node 20+ · MIT licensed');
  assert.doesNotMatch(html, /unlimited|24\/7|instead of the API|subscription|always[- ]on/i);
  assert.doesNotMatch(html, /\b(linux|macos|mac os|windows|ubuntu|debian|unix|freebsd|wsl|ios|android|raspberry)\b/i);
  assert.doesNotMatch(html, /(?:href|src)="\//i);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc="https?:|<link\b(?=[^>]*\brel="stylesheet")(?=[^>]*\bhref="https?:)/i);
  for (const url of html.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    assert.ok(url.startsWith(REPO_URL) || url.startsWith(base), `unexpected URL: ${url}`);
  }
  assert.deepEqual([...new Set(html.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi))], [CONTACT]);
  assert.match(html, /<html lang="en">/);
  assert.equal((html.match(/<h1(?:\s|>)/g) ?? []).length, 1);
  assert.match(html, /<title>.+<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]+"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/x\/"/);
  for (const property of ['title', 'description', 'image', 'url']) assert.match(html, new RegExp(`<meta property="og:${property}" content="[^"]+"`));
  assert.match(html, /<meta property="og:image" content="https:\/\/example\.com\/x\/og\.png"/);
  assert.match(html, /<meta property="og:url" content="https:\/\/example\.com\/x\/"/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
  assert.match(html, /<meta name="theme-color" content="#[0-9a-f]+"/i);
  assert.match(html, /<link rel="icon" href="\.\/favicon\.svg"/);
});
