// `npm run check:public [-- --commits <range>] [-- --text <ENV_VAR>]...`: fails (exit 1) if the repo holds
// what must never be published, and exits 2 if it could not check. It reads every file in the repo (tracked,
// or new and not ignored: names and contents; binary files are flagged for a look), with --commits the
// messages and added lines of each commit in <range>, and with --text the value of each named environment
// variable (CI passes a pull request's title and description that way). It also fails on the product's earlier
// names in any file but the few that must still name them (oldNames).
// Generic rules catch the shapes of real email addresses, tailnet names and addresses, home folders, private
// share links, account ids and secrets. Names, hosts, employers and the like are caught only by the private
// terms list: one case-insensitive regex per line (# comments) in $PRIVATE_TERMS_FILE, default
// ~/.config/private-terms/botons.txt, kept outside the repo so the list itself is never committed.
import { FORMERLY, OLD_WORD } from '../shared/legacy-names.mjs';
import { PRIVATE_TERMS_FILES } from '../shared/legacy-names.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export interface Problem {
  where: string;
  rule: string;
  match: string;
}

// Placeholders that are fine to publish: RFC 2606 names and a few service no-reply addresses.
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const PLACEHOLDER_DOMAIN = /(^|\.)example\.(com|org|net)$|\.(test|example|invalid|localhost)$/i;
const NOT_PERSONAL = /^hello@getbotons\.com$|^no-?reply@(anthropic\.com|github\.com)$|^git@(github\.com|gitlab\.com|bitbucket\.org)$|@\d+x\.(png|jpe?g|webp|gif|avif|svg)$/i;
const TAILNET = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b/gi;
const PLACEHOLDER_TAILNET = /(^|\.)(example-tailnet|your-tailnet)\.ts\.net$/i;
const TAILNET_IP6 = /\bfd7a:115c:a1e0:[0-9a-f:]*[0-9a-f]{3,4}\b/gi;
// /home/<name> (not a URL path), C:\Users\<name> (also JSON-escaped), and the -home-<name>- form agent CLIs use for project folders.
const HOME = /(?<![\w-]\.[a-z]{2,}(?::\d+)?)\/(?:home|Users)\/([A-Za-z0-9._-]+)|\b[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9._-]+)|(?<![A-Za-z0-9])-(?:home|Users)-([A-Za-z0-9]+)-/g;
// Placeholders, CI's runner, macOS's shared folder, and the user of the official Node container image.
const PLACEHOLDER_HOMES = new Set(['you', 'u', 'user', 'me', 'someone', 'runner', 'Shared', 'node']);
const PRIVATE_LINK = /\bhttps?:\/\/(?:www\.)?(?:notion\.so|(?:[\w-]+\.)?notion\.(?:site|com)|linear\.app|[\w-]+\.slack\.com|docs\.google\.com|drive\.google\.com|[\w-]+\.atlassian\.net|[\w-]+\.sharepoint\.com)\/\S*/gi;
const ACCOUNT_ID = /\b(?:org_?id|organization_?uuid|account_?uuid|account_?id)\\?"\s*:\s*\\?"(?!0{8}-0{4}-0{4}-0{4}-0{12}\\?")[^"\\]{6,}/gi;
const SECRETS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bgl(?:pat|dt|rt)-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bxox[abposre]-[A-Za-z0-9-]{10,}/,
  /\bxapp-\d-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\btskey-[a-z]+-[A-Za-z0-9-]{20,}/,
  /\btk_[a-z0-9]{29}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/,
];
// Binary files that were checked by hand and may be published: the brand board's images, which
// docs/brand/board/capture.ts draws from the board's own placeholder content, and the app's home-screen icons, which
// scripts/icons.ts draws from the brand marks, and the site social image drawn from the same renderers
// (no real install, names or data in any of them).
const BINARY_OK: RegExp[] = [/^docs\/brand\/img\/[a-z0-9-]+\.png$/, /^web\/public\/(apple-touch-icon|icon-\d+)\.png$/, /^site\/og\.png$/, /^docs\/assets\/[a-z0-9-]+\.gif$/];

/**
 * The product's earlier names (shared/legacy-names.mjs) appear only where something still has to read or move them:
 * the legacy-names module and what it alone drives, its tests and the files they migrate (each listed here), and
 * one line of the changelog that says what the product was called before. Anywhere else (a file's name or text, or
 * a part of a word: camelCase, snake_case, a path) one is a problem, so they can't creep back.
 */
const OLD_NAME_FILES: RegExp[] = [
  /^shared\/legacy-names\.(mjs|d\.mts)$/, // the module itself
  /^docker\/legacy-names\.sh$/, // its Compose move
  /^server\/bin\/legacy\/[a-z]+$/, // the command's deprecated names, for one release
  /^server\/test\/legacy-(names|upgrade)\.test\.ts$/, // its tests
  /^server\/test\/fixtures\/schema-\d+\.sql$/, // schemas before the rename, which the upgrade tests start from
  /^server\/test\/fixtures\/portable-config-\d+\.json$/, // configuration exports made under an earlier name
];
/** Said once, where it may be: the changelog's line on what the product was called before. A second one is a problem. */
const OLD_NAME_ONCE: { file: RegExp; phrase: RegExp }[] = [{ file: /^CHANGELOG\.md$/, phrase: FORMERLY }];

/** Each earlier name in `text`, as a word or a part of one. */
export function oldNames(text: string, where: string, file = where): Problem[] {
  if (OLD_NAME_FILES.some((re) => re.test(file))) return [];
  const out: Problem[] = [];
  // The first time only: the phrase's own words are blanked, the rest of its line is checked like any other.
  for (const x of OLD_NAME_ONCE) if (x.file.test(file)) text = text.replace(x.phrase, (m) => ' '.repeat(m.length));
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/[A-Za-z0-9]+/g)) {
      // The word as a whole, in any case, or one of its parts (camelCase, snake_case, kebab-case).
      const parts = m[0].match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [];
      if (OLD_WORD.test(m[0]) || parts.some((w) => OLD_WORD.test(w))) out.push({ where: `${where}:${i + 1}`, rule: 'earlier name', match: m[0] });
    }
  });
  return out;
}

export function parseTerms(text: string, source = 'private terms'): RegExp[] {
  return text.split('\n').flatMap((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith('#')) return [];
    try {
      return [new RegExp(l, 'i')];
    } catch {
      throw new Error(`${source} line ${i + 1} is not a valid regex`);
    }
  });
}

export function scan(text: string, where: string, terms: RegExp[] = []): Problem[] {
  const out: Problem[] = [];
  text.split('\n').forEach((line, i) => {
    if ((where === 'LICENSE' || /^commit [a-f0-9]+ LICENSE$/.test(where)) && line === ['Copyright (c) 2026', 'Jes' + 'se', 'Bounds'].join(' ')) return;
    const add = (rule: string, match: string) => out.push({ where: `${where}:${i + 1}`, rule, match });
    for (const m of line.matchAll(EMAIL)) if (!PLACEHOLDER_DOMAIN.test(m[1]) && !NOT_PERSONAL.test(m[0])) add('email', `…@${m[1]}`);
    for (const m of line.matchAll(TAILNET)) if (!PLACEHOLDER_TAILNET.test(m[0])) add('tailnet', m[0]);
    for (const m of line.matchAll(TAILNET_IP6)) add('tailnet address', m[0]);
    for (const m of line.matchAll(HOME)) if (!PLACEHOLDER_HOMES.has(m[1] ?? m[2] ?? m[3])) add('home folder', m[0]);
    for (const m of line.matchAll(PRIVATE_LINK)) add('private link', m[0]);
    for (const m of line.matchAll(ACCOUNT_ID)) add('account id', m[0]);
    for (const re of SECRETS) {
      const m = re.exec(line);
      if (m) add('secret', `${m[0].slice(0, 8)}…`);
    }
    // The owner explicitly requires the future public reporting destination in these policies.
    const privateLine = /^(SECURITY\.md|docs\/release-checklist\.md)$/.test(where)
      ? line.replace(/(?<=repos\/|github\.com\/)[A-Za-z0-9-]+\/botons\b/g, 'public/repo') : line;
    // Public repository links are safe in any file or commit message; other owner references are not.
    const publicLine = privateLine.replace(/(?:git\+)?(?:https?:\/\/)?github\.com\/bounds[j]\/botons(?:\.git)?(?=[/#\s`"'<>),;\]}]|$)/gi, 'https://github.com/public/project');
    for (const re of terms) {
      const m = re.exec(publicLine);
      if (m) add('private term', m[0]);
    }
  });
  return out;
}

function main(): number {
  const { values } = parseArgs({ options: { strict: { type: 'boolean' }, commits: { type: 'string' }, text: { type: 'string', multiple: true } } });
  const termsDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'private-terms');
  // Or the list under its deprecated name, while the owner's copy still has it (shared/legacy-names.mjs).
  const defaultTerms = [join(termsDir, 'botons.txt'), ...PRIVATE_TERMS_FILES.map((f) => join(termsDir, f))].find((f) => existsSync(f)) ?? join(termsDir, 'botons.txt');
  const termsFile = resolve(process.env.PRIVATE_TERMS_FILE || defaultTerms);
  const terms = existsSync(termsFile) ? parseTerms(readFileSync(termsFile, 'utf8'), termsFile) : [];
  if (values.strict && !terms.length) throw new Error('strict mode requires a nonempty private terms file');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const root = git('rev-parse', '--show-toplevel').trim();
  const binaryOk = (path: string) => BINARY_OK.some((re) => re.test(path));

  const problems: Problem[] = [];
  const files = git('-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  for (const f of files) {
    problems.push(...scan(f, `${f} (name)`, terms), ...oldNames(f, `${f} (name)`, f));
    const st = lstatSync(join(root, f), { throwIfNoEntry: false });
    if (!st?.isFile()) continue; // deleted, a symlink, or a submodule
    const buf = readFileSync(join(root, f));
    if (buf.includes(0)) {
      if (!binaryOk(f)) problems.push({ where: f, rule: 'binary file', match: 'check it holds no real data, then add it to BINARY_OK' });
      continue;
    }
    problems.push(...scan(buf.toString('utf8'), f, terms), ...oldNames(buf.toString('utf8'), f));
  }

  let commits = 0;
  const identities = new Map<string, number>();
  if (values.commits) {
    let log: string;
    let patch: string;
    try {
      log = git('-C', root, 'log', '--format=%h%x00%an <%ae>%x00%cn <%ce>%x00%B%x01', '--end-of-options', values.commits);
      patch = git('-C', root, 'log', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--format=%x01%h', '--end-of-options', values.commits);
    } catch {
      throw new Error(`cannot read the commits in ${values.commits} (is the base fetched?)`);
    }
    for (const entry of log.split('\x01')) {
      const [sha, author, committer, message] = entry.trim().split('\0');
      if (!sha) continue;
      commits++;
      problems.push(...scan(message ?? '', `commit ${sha}`, terms));
      for (const who of new Set([author, committer])) {
        const email = /<([^>]*)>$/.exec(who ?? '')?.[1] ?? '';
        if (!/@users\.noreply\.github\.com$/i.test(email) && !NOT_PERSONAL.test(email) && !PLACEHOLDER_DOMAIN.test(email.split('@')[1] ?? '')) {
          identities.set(who!, (identities.get(who!) ?? 0) + 1);
        }
      }
    }
    let at = '';
    let sha = '';
    for (const line of patch.split('\n')) {
      if (line.startsWith('\x01')) at = sha = `commit ${line.slice(1)}`;
      else if (line.startsWith('diff --git ')) at = `${sha} ${line.slice(line.lastIndexOf(' b/') + 3)}`;
      else if (line.startsWith('+') && !line.startsWith('+++ ')) problems.push(...scan(line.slice(1), at, terms).map((p) => ({ ...p, where: at })));
      else {
        const bin = /^Binary files .* and b\/(.+) differ$/.exec(line);
        if (bin && !binaryOk(bin[1])) problems.push({ where: at, rule: 'binary file', match: 'check it holds no real data, then add it to BINARY_OK' });
      }
    }
  }
  for (const name of values.text ?? []) problems.push(...scan(process.env[name] ?? '', name, terms));

  for (const p of problems) console.error(`${p.where}: ${p.rule}: ${p.match}`);
  for (const [who, n] of identities) {
    console.warn(`note: ${n} commit${n === 1 ? '' : 's'} by ${who.replace(/<[^@>]*@/, '<…@')}: this identity is published with this history (a no-reply address avoids that)`);
  }
  const checked = `${files.length} files${values.commits ? ` and ${commits} commits` : ''}${values.text?.length ? ` and ${values.text.join(', ')}` : ''}`;
  const list = terms.length ? `${terms.length} private terms from ${termsFile}` : `no private terms (${termsFile} not found)`;
  if (problems.length) {
    console.error(`check:public: ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${checked} (${list}). Replace them with placeholders (see AGENTS.md).`);
    return 1;
  }
  console.log(`check:public: ${checked} clean (${list}).`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`check:public: could not check: ${(err as Error).message.split('\n')[0]}`);
    process.exitCode = 2;
  }
}
