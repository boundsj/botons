import { createHash } from 'node:crypto';
import { CLI_NAMES } from '../../shared/legacy-names.mjs';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import type { DiffLine } from '../../shared/types.ts';

/*
 * Skill packages: folders the owner puts in BOTONS_HOME/skill-packages, each holding a SKILL.md (frontmatter with
 * name and description, then the procedure). Only SKILL.md's text is read, and only as text: nothing in a folder is
 * run, unpacked or followed. A Workspace Boton can't read or write BOTONS_HOME, but what is in a folder is still
 * treated as untrusted: it installs only after the owner reviews exactly that text (skills.ts).
 *
 * No link is followed, even one swapped in while a folder is read: the packages folder and each package folder are
 * opened once (a package folder without following a link), and everything in them is then looked up through that
 * open folder, by /proc/self/fd/<fd>/<name>, never by its path again. Renaming or replacing a folder meanwhile
 * changes nothing: what is read is in the folder that was opened. Where there is no /proc/self/fd to look up
 * through, packages are listed but none can be read.
 */

export const SKILL_MD = 'SKILL.md';
/** Bytes of a SKILL.md: room for the longest description and procedure a skill takes, and its frontmatter. */
export const SKILL_MD_MAX = 64 * 1024;
const MAX_PACKAGES = 200;
const MAX_LISTED_FILES = 50;
const MAX_WALKED = 500;
const MAX_DEPTH = 6;
const FIELD_MAX = 300;
const ARCHIVE = /\.(zip|skill|tar|tgz|gz|bz2|xz|zst|7z|rar|jar)$/i;
/** Fields that describe a package without asking for anything: shown, not counted as asks. */
const DESCRIPTIVE = new Set(['license', 'author', 'authors', 'homepage', 'repository', 'tags', 'keywords', 'metadata', 'compatibility']);
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** What a package folder holds, read and checked. `problems` empty: it can be installed. */
export interface PackageRead {
  folder: string;
  problems: string[];
  name: string | null;
  description: string | null;
  body: string | null;
  label: string | null;
  fields: Record<string, string>;
  otherFiles: string[];
  /** Full parsed metadata, hashed before any display formatting. */
  metadataHash: string | null;
}

/** Called once a folder is open and before anything in it is read: null for the packages folder, else the package's name. Tests swap folders here. */
export type Pinned = (folder: string | null) => void;

const empty = (folder: string, problems: string[]): PackageRead => ({ folder, problems, name: null, description: null, body: null, label: null, fields: {}, otherFiles: [], metadataHash: null });

const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).message;

/** `name` in the folder open as `fd`, wherever that folder is now. `name` is one entry: never a path. */
const at = (fd: number, name?: string) => (name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`);

let lookups: boolean | undefined;
/** Whether names can be looked up through an open folder here (Linux's /proc/self/fd). */
function canPin(): boolean {
  if (lookups !== undefined) return lookups;
  let fd: number | undefined;
  try {
    fd = openSync('/', DIR);
    const a = fstatSync(fd);
    const b = lstatSync(`${at(fd)}/.`);
    lookups = a.dev === b.dev && a.ino === b.ino;
  } catch {
    lookups = false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return lookups;
}

const UNPINNED = "Installing skill packages needs Linux folders held open safely; this system cannot provide that protection. Create a skill by pasting its text instead.";

/** The packages folder, opened; null if there is no such folder. */
function openRoot(dir: string): number | null {
  try {
    return openSync(realpathSync(dir), DIR);
  } catch {
    return null;
  }
}

/** The packages in `dir`, sorted by folder; null if there is no such folder. Plain files and links there are listed with why they aren't packages. */
export function listPackages(dir: string, nameOk: (name: string) => boolean, pinned?: Pinned): PackageRead[] | null {
  const root = openRoot(dir);
  if (root === null) return null;
  try {
    if (!canPin()) {
      return readdirSync(realpathSync(dir))
        .filter((n) => !n.startsWith('.'))
        .sort()
        .slice(0, MAX_PACKAGES)
        .map((n) => empty(n, [UNPINNED]));
    }
    pinned?.(null);
    const names = readdirSync(at(root))
      .filter((n) => !n.startsWith('.'))
      .sort();
    return names.slice(0, MAX_PACKAGES).map((n) => readEntry(root, n, nameOk, pinned));
  } finally {
    closeSync(root);
  }
}

/** One package by its folder's name; null if there is no entry with that name. */
export function readPackage(dir: string, folder: string, nameOk: (name: string) => boolean, pinned?: Pinned): PackageRead | null {
  if (!nameOk(folder)) return null;
  const root = openRoot(dir);
  if (root === null) return null;
  try {
    if (!canPin()) return empty(folder, [UNPINNED]);
    pinned?.(null);
    try {
      lstatSync(at(root, folder));
    } catch {
      return null;
    }
    return readEntry(root, folder, nameOk, pinned);
  } finally {
    closeSync(root);
  }
}

const LINK = 'It is a link. Botons reads only real folders here: copy the package in instead.';
const NOT_FOLDER = 'It is not a folder. Each package is a folder holding a SKILL.md.';

function readEntry(root: number, folder: string, nameOk: (name: string) => boolean, pinned?: Pinned): PackageRead {
  let st;
  try {
    st = lstatSync(at(root, folder));
  } catch (e) {
    return empty(folder, [`Can't read it: ${code(e)}`]);
  }
  if (st.isSymbolicLink()) return empty(folder, [LINK]);
  if (st.isFile() && ARCHIVE.test(folder)) return empty(folder, ['It is an archive. Botons doesn\'t unpack archives: check it and unpack it into a folder here yourself.']);
  if (!st.isDirectory()) return empty(folder, [NOT_FOLDER]);
  if (!nameOk(folder)) return empty(folder, ['Its name is not a skill name: lowercase letters and digits in words joined by single hyphens (like weekly-report).']);

  // Open without following a link: one swapped in since the lstat fails here, and what is read from now on is in this folder.
  let fd: number;
  try {
    fd = openSync(at(root, folder), DIR);
  } catch (e) {
    const c = code(e);
    return empty(folder, [c === 'ELOOP' ? LINK : c === 'ENOTDIR' ? NOT_FOLDER : `Can't read it: ${c}`]);
  }
  try {
    pinned?.(folder);
    const otherFiles = walk(fd);
    let text: string;
    try {
      text = readSkillMd(fd);
    } catch (e) {
      return { ...empty(folder, [(e as Error).message]), otherFiles };
    }
    const parsed = parseSkillMd(text);
    if ('problem' in parsed) return { ...empty(folder, [parsed.problem]), otherFiles };
    const problems: string[] = [];
    const { name, description, label, fields, body, metadataHash } = parsed;
    if (!name) problems.push('SKILL.md has no name.');
    else if (name !== folder) problems.push(`SKILL.md is named ${name}, but its folder is ${folder}: they must be the same.`);
    if (!description) problems.push('SKILL.md has no description.');
    if (!body) problems.push('SKILL.md has no procedure after its frontmatter.');
    return { folder, problems, name, description, body, label, fields, otherFiles, metadataHash };
  } finally {
    closeSync(fd);
  }
}

/**
 * SKILL.md's text from the open package folder: a regular file there, opened without following a link, with no
 * other hard links, at most SKILL_MD_MAX bytes, valid UTF-8. What was checked is what is read: the same open file.
 */
function readSkillMd(folder: number): string {
  let fd: number;
  try {
    fd = openSync(at(folder, SKILL_MD), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const c = code(e);
    if (c === 'ENOENT') throw new Error('It has no SKILL.md.');
    if (c === 'ELOOP') throw new Error('Its SKILL.md is a link. Botons reads only a real file: copy it in instead.');
    throw new Error(`Can't read its SKILL.md: ${c}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('Its SKILL.md is not a regular file.');
    if (st.nlink > 1) throw new Error('Its SKILL.md has other hard links. Copy it to a new file instead.');
    const tooLarge = (n: number) => new Error(`Its SKILL.md is too large (${n} bytes; at most ${SKILL_MD_MAX}).`);
    if (st.size > SKILL_MD_MAX) throw tooLarge(st.size);
    const buf = Buffer.alloc(SKILL_MD_MAX + 1);
    let n = 0;
    for (let got = 1; got > 0 && n < buf.length; n += got) got = readSync(fd, buf, n, buf.length - n, null);
    if (n > SKILL_MD_MAX) throw tooLarge(n);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n));
    } catch {
      throw new Error('Its SKILL.md is not UTF-8 text.');
    }
    if (text.includes('\0')) throw new Error('Its SKILL.md is not text (it holds a NUL byte).');
    return text;
  } finally {
    closeSync(fd);
  }
}

/** Everything in the open package folder besides SKILL.md, as relative paths, without following links or reading any file. */
function walk(folder: number): string[] {
  const out: string[] = [];
  let seen = 0;
  const visit = (dir: number, rel: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(at(dir)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (++seen > MAX_WALKED) return;
      const r = rel ? `${rel}/${n}` : n;
      if (!rel && n === SKILL_MD) continue;
      let st;
      try {
        st = lstatSync(at(dir, n));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) out.push(`${r} (a link, not followed)`);
      else if (st.isDirectory()) {
        if (n === '.git' || depth >= MAX_DEPTH) {
          out.push(`${r}/ (not looked into)`);
          continue;
        }
        let sub: number;
        try {
          sub = openSync(at(dir, n), DIR);
        } catch (e) {
          out.push(code(e) === 'ELOOP' ? `${r} (a link, not followed)` : `${r}/ (not looked into)`);
          continue;
        }
        try {
          visit(sub, r, depth + 1);
        } finally {
          closeSync(sub);
        }
      } else out.push(r);
    }
  };
  visit(folder, '', 0);
  if (seen > MAX_WALKED) out.push('… and more');
  return out.length > MAX_LISTED_FILES ? [...out.slice(0, MAX_LISTED_FILES), `… and ${out.length - MAX_LISTED_FILES} more`] : out;
}

type Parsed = { name: string | null; description: string | null; label: string | null; fields: Record<string, string>; body: string; metadataHash: string } | { problem: string };

const unquote = (v: string) => {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
  if (m) return m[1].replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
  const s = /^'((?:[^']|'')*)'$/.exec(v);
  return s ? s[1].replace(/''/g, "'") : v;
};

/**
 * SKILL.md: `---`, frontmatter lines (`key: value`, a quoted value, or `>`/`|` with indented lines after it), `---`,
 * then the procedure. Only the subset skills use is read; a key with nested lines is kept as its text.
 */
export function parseSkillMd(raw: string): Parsed {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { problem: 'SKILL.md has no frontmatter: it must start with a --- line, then name: and description:, then another --- line.' };
  const entries: [string, string[]][] = [];
  for (const line of m[1].split('\n')) {
    const k = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (k) entries.push([k[1], [k[2]]]);
    else if (!line.trim() || line.trim().startsWith('#')) entries.at(-1)?.[1].push('');
    else if (/^[ \t]/.test(line) && entries.length) entries.at(-1)![1].push(line);
    else return { problem: `SKILL.md's frontmatter has a line Botons can't read: ${line.slice(0, 80)}` };
  }
  const values: Record<string, string> = Object.create(null);
  for (const [key, [first, ...rest]] of entries) {
    if (Object.hasOwn(values, key)) return { problem: `SKILL.md's frontmatter has ${key} twice.` };
    const lines = rest.map((l) => l.trim());
    while (lines.at(-1) === '') lines.pop();
    let value: string;
    if (/^[>|][+-]?$/.test(first.trim())) value = first.trim().startsWith('|') ? lines.join('\n') : lines.join(' ').replace(/ {2,}/g, ' ');
    else value = unquote([first.trim(), ...lines].filter(Boolean).join(' '));
    values[key] = value.trim();
  }
  const metadataHash = createHash('sha256').update(JSON.stringify(Object.keys(values).sort().map((key) => [key, values[key]]))).digest('hex');
  const { name = null, description = null, version = null, ...fields } = values;
  for (const k of Object.keys(fields)) fields[k] = clip(fields[k], FIELD_MAX);
  return { name: name || null, description: description || null, label: version ? clip(version, 64) : null, fields, body: m[2].trim(), metadataHash };
}

/** A value cut to `max`, ending in a hash of all of it: a change past the cut still shows. Authorization separately binds the complete parsed metadata. */
const clip = (v: string, max: number) => (v.length > max ? `${v.slice(0, max)}… (${createHash('sha256').update(v).digest('hex')})` : v);

/**
 * Everything a package says besides its description and procedure, one line each, in a fixed order: its version
 * label, every other SKILL.md field, and the other files in its folder. Shown against the installed skill's, and
 * part of what the owner reviews: a change here alone is an update.
 */
export function packageDetails(p: { label: string | null; fields: Record<string, string>; otherFiles: string[] }): string {
  const one = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  const lines = [
    ...(p.label !== null ? [`version: ${one(p.label)}`] : []),
    ...Object.keys(p.fields)
      .sort()
      .map((k) => `${k}: ${one(p.fields[k])}`),
    ...p.otherFiles.map((f) => `other file: ${one(f)}`),
  ];
  return lines.join('\n');
}

/** What a skill asks for or points at, one line each, sorted: fields Botons doesn't grant, sites it links to, Boton commands it runs. */
export function asksOf(text: { description: string; body: string; fields: Record<string, string> }): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(text.fields)) if (!DESCRIPTIVE.has(k.toLowerCase())) out.add(`asks for ${k}: ${v}`);
  const all = `${text.description}\n${text.body}`;
  for (const u of all.matchAll(/\b(?:https?|wss?|ftp):\/\/([^\s/?#"'<>)\]`]+)/gi)) {
    const host = u[1].replace(/^[^@]*@/, '').toLowerCase();
    if (host) out.add(`links to ${host}`);
  }
  // The command, or one of its deprecated names (shared/legacy-names.mjs).
  for (const c of all.matchAll(new RegExp(`\\b(?:${['botons', ...CLI_NAMES].join('|')})\\s+([a-z][a-z-]*)`, 'g'))) out.add(`runs botons ${c[1]}`);
  return [...out].sort();
}

/** Line by line, what turns `a` into `b`: the longest common run kept, the rest removed then added. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a ? a.split('\n') : [];
  const y = b ? b.split('\n') : [];
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
  const xs = x.slice(start, x.length - end);
  const ys = y.slice(start, y.length - end);
  const head: DiffLine[] = x.slice(0, start).map((text) => ({ op: 'same', text }));
  const tail: DiffLine[] = x.slice(x.length - end).map((text) => ({ op: 'same', text }));
  // Too many lines to compare cheaply: all of one out, all of the other in.
  if (xs.length * ys.length > 4_000_000) return [...head, ...xs.map((text): DiffLine => ({ op: 'remove', text })), ...ys.map((text): DiffLine => ({ op: 'add', text })), ...tail];
  const n = xs.length;
  const m = ys.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = xs[i] === ys[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (xs[i] === ys[j]) {
      mid.push({ op: 'same', text: xs[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) mid.push({ op: 'remove', text: xs[i++] });
    else mid.push({ op: 'add', text: ys[j++] });
  }
  while (i < n) mid.push({ op: 'remove', text: xs[i++] });
  while (j < m) mid.push({ op: 'add', text: ys[j++] });
  return [...head, ...mid, ...tail];
}
