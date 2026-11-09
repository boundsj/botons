// `npm run dev`: the API server (restarting on change) and Vite, apart from the live server (see dev-env.ts).
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devEnv } from './dev-env.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = devEnv(process.env, root);
console.log(`dev: data in ${env.BOTONS_HOME}, API on ${env.BOTONS_API}${env.BOTONS_ENABLE_MOCK === '1' ? ', mock provider on' : ''}`);

const procs = [
  { name: 'server', color: 33, cmd: process.execPath, args: ['--watch-path=server/src', '--watch-path=shared', 'server/src/index.ts'] },
  { name: 'web', color: 36, cmd: 'npm', args: ['run', 'dev', '-w', 'web'] },
];

const children = procs.map((p) => {
  const child = spawn(p.cmd, p.args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env });
  const prefix = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout!, process.stdout);
  pipe(child.stderr!, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited (${code})`);
    shutdown(code ?? 0);
  });
  return child;
});

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

if ((env.BOTONS_AUTH ?? '').trim().toLowerCase() !== 'off') void printPairingHelp();

async function printPairingHelp() {
  const prefix = '\x1b[35m[pair]\x1b[0m ';
  for (let tries = 0; ; tries++) {
    if (stopping) return;
    try {
      // Any answer means it is up, 503 included.
      await fetch(`${env.BOTONS_API}/api/health`);
      break;
    } catch {}
    if (tries > 200) return console.log(`${prefix}the server did not come up`);
    await new Promise((r) => setTimeout(r, 300));
  }
  const web = `http://${process.env.BOTONS_WEB_HOST && process.env.BOTONS_WEB_HOST !== '0.0.0.0' ? process.env.BOTONS_WEB_HOST : '127.0.0.1'}:${process.env.BOTONS_WEB_PORT || 5173}`;
  console.log(`${prefix}not paired yet? Open ${web}: it shows a code. Approve it with \`BOTONS_HOME=${env.BOTONS_HOME} npm run pair -- --approve <code>\``);
}
