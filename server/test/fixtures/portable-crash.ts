// A server that stops dead at one point of a configuration import, for portable-durability.test.ts: it imports
// the request in argv[3] (a JSON file of { file, choices, fingerprint }) on the data folder argv[2], as the paired
// device whose token is argv[4], and at argv[5] it prints "AT <point>" and blocks, so the test SIGKILLs this very
// process there:
//   before-commit: the import's transaction is written but not committed
//   after-commit:  committed, nothing published after it yet (no event, no template in place)
//   mid-publish:   committed, and the first of its templates renamed into place, not the rest
import fs, { mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';

const [home, requestFile, token, point, port] = process.argv.slice(2);
const stop = () => {
  writeSync(1, `AT ${point}\n`);
  // Blocks the event loop exactly here until the test kills this process.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const cfg = loadConfig({
  BOTONS_HOME: home,
  BOTONS_HOST: '127.0.0.1',
  BOTONS_PORT: port,
  BOTONS_ENABLE_MOCK: '1',
  BOTONS_NO_TAILSCALE: '1',
  BOTONS_CLAUDE_BIN: join(home, 'no-claude'),
  BOTONS_CODEX_BIN: join(home, 'no-codex'),
});
cfg.webDist = join(home, 'web-dist');
mkdirSync(cfg.webDist, { recursive: true });
writeFileSync(join(cfg.webDist, 'index.html'), '<h1>Botons test</h1>');
const app = createApp(cfg, undefined, { tailnet: null, apiKeys: { env: {} } });

const db = app.store.db;
const exec = db.exec.bind(db);
db.exec = (sql: string) => {
  if (sql === 'commit' && point === 'before-commit') stop();
  exec(sql);
  if (sql === 'commit' && point === 'after-commit') stop();
};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (point === 'mid-publish' && String(from).endsWith('.staged')) stop();
};
syncBuiltinESMExports();

await app.listen();
writeSync(1, 'READY\n');
const res = await fetch(`http://127.0.0.1:${port}/api/config/import`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: readFileSync(requestFile, 'utf8'),
});
writeSync(1, `DONE ${res.status} ${await res.text()}\n`);
process.exit(3);
