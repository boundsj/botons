import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { faviconSvg } from '../shared/brand.ts';
import { renderPage } from './page.ts';

const siteDir = dirname(fileURLToPath(import.meta.url));
const dist = join(siteDir, 'dist');
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'index.html'), renderPage({ siteUrl: process.env.SITE_URL || 'https://getbotons.com/' }));
writeFileSync(join(dist, 'favicon.svg'), faviconSvg());
for (const name of ['styles.css', 'site.js', 'og.png']) copyFileSync(join(siteDir, name), join(dist, name));
copyFileSync(join(siteDir, '../web/public/apple-touch-icon.png'), join(dist, 'apple-touch-icon.png'));
console.log('Built site/dist');

if (process.argv.includes('--serve')) {
  const index = process.argv.indexOf('--serve');
  const port = Number(process.argv[index + 1] ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected a port from 1 to 65535');
  const files: Record<string, string> = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/site.js': 'site.js', '/favicon.svg': 'favicon.svg', '/apple-touch-icon.png': 'apple-touch-icon.png', '/og.png': 'og.png' };
  const types: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', png: 'image/png' };
  createServer((req, res) => {
    const name = files[new URL(req.url || '/', 'http://localhost').pathname];
    if (!name) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[name.split('.').at(-1)!] });
    res.end(readFileSync(join(dist, name)));
  }).listen(port, '127.0.0.1', () => console.log(`Preview at http://127.0.0.1:${port}/`));
}
