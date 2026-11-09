import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PATH_BLOCK_NAMES } from '../shared/legacy-names.mjs';

const blockOf = (name) => `\n# >>> ${name} PATH >>>\ncase ":$PATH:" in\n  *":$HOME/.local/bin:"*) ;;\n  *) export PATH="$HOME/.local/bin:$PATH" ;;\nesac\n# <<< ${name} PATH <<<\n`;
const block = blockOf('botons');
// The block under its deprecated names counts as there, and goes on uninstall (shared/legacy-names.mjs).
const markers = ['botons', ...PATH_BLOCK_NAMES].map(name => `# >>> ${name} PATH >>>`);
const blocks = [block, ...PATH_BLOCK_NAMES.map(blockOf)];
const files = ['.bashrc', '.zshrc', '.profile'];
export function onPath(home, path = '') {
  return path.split(':').some(entry => entry && resolve(entry) === join(home, '.local/bin'));
}
export function profileAddsPath(home, shell = '') {
  const kind = basename(shell);
  const candidates = kind === 'bash' ? ['.bash_profile', '.bash_login', '.profile'] : kind === 'zsh' ? ['.zprofile', '.zlogin'] : ['.profile'];
  for (const name of candidates) {
    const path = join(home, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const adds = text.split('\n').filter(line => !/^\s*#/.test(line)).some(line => /^\s*(?:export\s+)?PATH=/.test(line) && (/(?:\$HOME|\$\{HOME\}|~)\/\.local\/bin/.test(line) || line.includes(join(home, ".local/bin"))));
    if (adds) return true;
    // Bash only reads the first existing login profile. Follow its explicit .profile inclusion.
    if (kind === 'bash') {
      if (name !== '.profile' && /(?:source|\.)\s+["']?(?:\$HOME|~)\/\.profile["']?(?:\s|$)/m.test(text)) {
        return profileAddsPath(home, '/bin/sh');
      }
      return false;
    }
  }
  return false;
}
export async function configurePath({ home, shell, path, yes }, ask, log = console.log) {
  if (onPath(home, path)) return true;
  try {
    if (!profileAddsPath(home, shell)) {
      const kind = basename(shell || '');
      const rc = join(home, kind === 'bash' ? '.bashrc' : kind === 'zsh' ? '.zshrc' : '.profile');
      const text = existsSync(rc) ? readFileSync(rc, 'utf8') : '';
      if (!markers.some(m => text.includes(m))) {
        await ask(`Append the marked Botons PATH block to ${rc} so new shells find ~/.local/bin/botons`, yes);
        // The owner may edit the file while answering. Preserve those edits and recheck the marker.
        const latest = existsSync(rc) ? readFileSync(rc, 'utf8') : '';
        if (!markers.some(m => latest.includes(m)) && !profileAddsPath(home, shell)) {
          mkdirSync(dirname(rc), { recursive: true });
          appendFileSync(rc, block);
        }
      }
    }
  } catch (error) { log(`PATH setup skipped: ${error.message}. Use ~/.local/bin/botons until your shell PATH is configured.`); }

  return false;
}
export function removePathBlock(home, log = console.log) {
  for (const name of files) {
    const path = join(home, name);
    try {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      const cleaned = blocks.reduce((t, b) => t.replaceAll(b, ''), text);
      if (cleaned !== text) writeFileSync(path, cleaned);
    } catch (error) {
      log(`WARNING: Could not remove the Botons PATH block from ${path}: ${error.message}. Remove the marked block manually if present.`);
    }
  }
}
