import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { constants, closeSync, existsSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Download } from 'playwright-core';

const LIMIT = 8192;
const GRANT_LIFE = 10 * 60_000;
const INTENT_LIFE = 30_000;
type Result = 'saved' | 'refused' | 'failed';
type Grant = { kind: 'apns'; botId: string; actor: 'agent' | 'owner'; session: string; origin: string; keyId: string; expiresAt: string };
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const origin = (raw: string) => { try { return new URL(raw).origin; } catch { return ''; } };

/** A single, operator-issued credential import. It never exports a download to a client or workspace. */
export class BrowserKeyDownload {
  readonly staging: string;
  readonly session = randomBytes(16).toString('hex');
  #root: string;
  #botId: string;
  #actor: Grant['actor'];
  #alive: () => boolean;
  #closed = false;
  #intent: { grant: Grant; hash: string; until: number } | null = null;
  #wait: Promise<Result> | null = null;
  #answer: ((result: Result) => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #download: Download | null = null;
  #sessionFile: string;

  constructor(root: string, forbidden: string[], botId: string, actor: Grant['actor'], alive: () => boolean) {
    this.#root = resolve(root);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(botId)) throw new Error('Invalid browser identity.');
    if (forbidden.some(p => this.#root === resolve(p) || this.#root.startsWith(resolve(p) + sep))) throw new Error('Private browser downloads must be outside data and source folders.');
    const s = lstatSync(this.#root);
    if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(this.#root) !== this.#root || (s.mode & 0o077) || s.uid !== process.getuid?.()) throw new Error('The private download directory must be owned by this user, mode 0700, without links.');
    this.#botId = botId; this.#actor = actor; this.#alive = alive;
    this.staging = mkdtempSync(join(this.#root, '.browser-'));
    this.#sessionFile = join(this.#root, `session-${botId}-${actor}.json`);
    const temp = join(this.staging, 'session.json');
    writeFileSync(temp, JSON.stringify({ botId, actor, session: this.session }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, this.#sessionFile);
  }

  #grantFile = () => join(this.#root, 'allow-once.json');
  #target = (g: Grant) => join(this.#root, `AuthKey_${g.keyId}.p8`);
  #occupied(g: Grant): boolean {
    try { lstatSync(this.#target(g)); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /** Called only for an authenticated click/release/Enter, not page loading, typing, hovering or scrolling. */
  intent(pageUrl: string): boolean {
    if (this.#closed || !this.#alive() || this.#download || this.#answer) return false;
    try {
      const file = this.#grantFile();
      const s = lstatSync(file);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 2048 || (s.mode & 0o077) || s.uid !== process.getuid?.()) return false;
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try { bytes = readFileSync(fd); } finally { closeSync(fd); }
      const g = JSON.parse(bytes.toString('utf8')) as Grant;
      const end = Date.parse(g.expiresAt);
      const u = new URL(g.origin);
      if (g.kind !== 'apns' || g.botId !== this.#botId || g.actor !== this.#actor || g.session !== this.session) return false;
      if (typeof g.keyId !== 'string' || typeof g.expiresAt !== 'string' || !/^[A-Z0-9]{10}$/.test(g.keyId)) return false;
      if (u.protocol !== 'https:' || u.username || u.password || u.origin !== g.origin || origin(pageUrl) !== g.origin) return false;
      if (!Number.isFinite(end) || end <= Date.now() || end > Date.now() + GRANT_LIFE || this.#occupied(g)) return false;
      this.#intent = { grant: g, hash: digest(bytes), until: Math.min(end, Date.now() + INTENT_LIFE) };
      this.#wait = new Promise(resolve => { this.#answer = resolve; });
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.#done('failed'), INTENT_LIFE);
      return true;
    } catch { return false; }
  }

  #done(result: Result): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null; this.#intent = null;
    this.#answer?.(result); this.#answer = null;
  }

  async finish(): Promise<Result | null> {
    const wait = this.#wait;
    if (!wait) return null;
    try { return await wait; } finally { if (this.#wait === wait) this.#wait = null; }
  }

  /** Download bytes remain in private staging/import memory, never a result, journal, log or browser DOM. */
  async capture(download: Download, pageUrl: string): Promise<Result> {
    const intent = this.#intent;
    const live = () => !this.#closed && this.#alive() && intent !== null && Date.now() < intent.until;
    if (!intent || this.#download || !live() || origin(pageUrl) !== intent.grant.origin || origin(download.url()) !== intent.grant.origin || download.suggestedFilename() !== `AuthKey_${intent.grant.keyId}.p8`) {
      await download.cancel().catch(() => {});
      await download.delete().catch(() => {});
      if (intent && !this.#download) this.#done('refused');
      return 'refused';
    }
    this.#download = download;
    const claimed = join(this.#root, `.claimed-${randomBytes(12).toString('hex')}.json`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let pem: Buffer | null = null;
    const chunks: Buffer[] = [];
    let pending: string | null = null;
    try {
      // rename claims this exact grant across contexts/processes; nobody can spend it again.
      renameSync(this.#grantFile(), claimed);
      if (digest(readFileSync(claimed)) !== intent.hash || !live()) throw new Error('Grant changed.');
      const read = async () => {
        const stream = await download.createReadStream();
        let size = 0;
        for await (const chunk of stream) {
          const b = Buffer.from(chunk); size += b.length;
          if (size > LIMIT || expired || !live()) { b.fill(0); stream.destroy(); throw new Error('Import refused.'); }
          chunks.push(b);
        }
        return Buffer.concat(chunks);
      };
      pem = await Promise.race([read(), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { expired = true; void download.cancel().catch(() => {}); reject(new Error('Import timed out.')); }, 10_000);
      })]);
      const label = 'PRIVATE KEY';
      const begin = `-----BEGIN ${label}-----`;
      const end = `-----END ${label}-----`;
      const text = pem.toString('ascii').trim();
      if (!live() || expired || !text.startsWith(begin) || !text.endsWith(end) || !/^[A-Za-z0-9+/=\s]+$/.test(text.slice(begin.length, -end.length))) throw new Error('Invalid private key.');
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Invalid private key.');
      // Fully validated recovery copy stays private if publication fails; never overwrite an existing credential.
      const dir = mkdtempSync(join(this.#root, '.capture-'));
      pending = join(dir, `AuthKey_${intent.grant.keyId}.p8`);
      const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); writeFileSync(fd, pem); fsyncSync(fd); } finally { closeSync(fd); }
      if (!live()) { rmSync(dir, { recursive: true, force: true }); pending = null; throw new Error('Session ended.'); }
      linkSync(pending, this.#target(intent.grant));
      unlinkSync(pending); rmSync(dir, { recursive: true }); pending = null;
      this.#receipt('saved', intent.grant.keyId);
      this.#done('saved');
      return 'saved';
    } catch {
      if (pending || !existsSync(this.#target(intent.grant))) this.#receipt(pending ? 'private-recovery-needed' : 'failed', intent.grant.keyId);
      this.#done('failed');
      return 'failed';
    } finally {
      if (timeout) clearTimeout(timeout);
      pem?.fill(0); for (const b of chunks) b.fill(0);
      try { rmSync(claimed, { force: true }); } catch {}
      await download.cancel().catch(() => {});
      await download.delete().catch(() => {});
      this.#download = null;
    }
  }

  #receipt(status: string, keyId: string): void {
    // Metadata only. Do not include site text, URLs, file contents or exception messages.
    const temp = join(this.#root, `.receipt-${randomBytes(12).toString('hex')}.json`);
    try {
      writeFileSync(temp, JSON.stringify({ status, keyId, at: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temp, join(this.#root, 'download-receipt.json'));
    } catch { rmSync(temp, { force: true }); }
  }

  close(): void {
    this.#closed = true; this.#done('failed');
    void this.#download?.cancel().catch(() => {});
    try { if (JSON.parse(readFileSync(this.#sessionFile, 'utf8')).session === this.session) unlinkSync(this.#sessionFile); } catch {}
    rmSync(this.staging, { recursive: true, force: true });
  }
}
