import '../server/src/env-init.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import type { AccessMode } from '../shared/types.ts';
import { type AuditEntry, HOST_ACTOR, recordAudit } from '../server/src/audit.ts';
import { approvePairingRequest, deleteAllDevices, deleteDevice, listDevices, pendingPairingRequests } from '../server/src/auth.ts';
import { type Config, loadConfig, botonsHome } from '../server/src/config.ts';
import { ACCESS_MODES, accessModeProblem, approveCommand, isAccessMode, readAccessMode, writeAccessMode } from '../server/src/setup.ts';
import { dbFileIn } from '../server/src/backup.ts';
import { serverEnv } from './install-service.ts';

const USAGE = `Usage:
  npm run pair                          how to pair a device, and the requests waiting now
  npm run pair -- --approve <code>      approve the device that shows this code (it signs in at once)
  npm run pair -- --approve <code> --label "Work iPad"
                                        the same, and name the device
  npm run pair -- --list                list paired devices
  npm run pair -- --revoke <id>         revoke one device
  npm run pair -- --revoke-all          revoke every device
  npm run pair -- --access-mode <mode>  which networks may connect: local, tailscale, lan, public,
                                        or none (only the listeners decide); takes effect at once

To pair a device, open Botons on it: it shows a code. Approve only a code you
are reading off the screen of the device you want to pair. A Boton can ask to
pair too, so never approve a code that reached you in a chat or a message.

Uses the data folder in BOTONS_HOME if it is set; otherwise the one the
service's environment file sets (--env-path, default ~/.config/botons/env);
otherwise ~/.botons.`;

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

let args;
try {
  args = parseArgs({
    allowPositionals: false,
    options: {
      label: { type: 'string' },
      approve: { type: 'string' },
      list: { type: 'boolean' },
      revoke: { type: 'string' },
      'revoke-all': { type: 'boolean' },
      'access-mode': { type: 'string' },
      'env-path': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }).values;
} catch (err) {
  fail(`${(err as Error).message}\n\n${USAGE}`, 2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

let env: NodeJS.ProcessEnv;
let from: string | null;
try {
  ({ env, from } = serverEnv(args['env-path']));
} catch (err) {
  fail((err as Error).message);
}

let home: string;
try {
  home = botonsHome(env);
} catch (err) {
  fail((err as Error).message);
}
const dbPath = dbFileIn(home);
if (!existsSync(dbPath)) {
  fail(
    `There is no Botons database at ${dbPath}${from ? ` (BOTONS_HOME as ${from} sets it, or the default)` : ''}. Start the server once (it creates it), or set BOTONS_HOME to the data folder it uses.`,
  );
}
const db = new DatabaseSync(dbPath);
db.exec('pragma busy_timeout = 5000; pragma foreign_keys = on;');

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');
// Someone at this machine, with the data folder: the owner. A database the server hasn't upgraded yet has no audit log.
const audit = (entry: AuditEntry) => {
  if (db.prepare("select 1 from sqlite_master where type = 'table' and name = 'audit_events'").get()) recordAudit(db, HOST_ACTOR, entry);
};
const hasRequests = () => !!db.prepare("select 1 from sqlite_master where type = 'table' and name = 'pairing_requests'").get();
const config = (): Config | null => {
  try {
    return loadConfig(env, undefined, { create: false });
  } catch (err) {
    console.warn(`(Could not read the server's settings: ${(err as Error).message})`);
    return null;
  }
};

try {
  if (args.list) {
    const devices = listDevices(db);
    if (!devices.length) console.log('No paired devices. Open Botons on a device and approve the code it shows with `npm run pair -- --approve <code>`.');
    for (const d of devices) console.log(`${d.id}  ${d.label}  (paired ${when(d.createdAt)}, last used ${when(d.lastUsedAt)})`);
  } else if (args['access-mode'] !== undefined) {
    const raw = args['access-mode'].trim().toLowerCase();
    const to: AccessMode | null = raw === 'none' ? null : isAccessMode(raw) ? raw : fail(`--access-mode must be one of ${ACCESS_MODES.join(', ')} or none; got "${raw}"`, 2);
    const cfg = to === 'lan' || to === 'public' ? config() : null;
    if (to === 'lan' || to === 'public') {
      if (!cfg) fail(`Fix the server's settings before choosing ${to}.`);
      const problem = accessModeProblem(to, cfg);
      if (problem) fail(problem);
    }
    const from = readAccessMode(db);
    writeAccessMode(db, to);
    if (from !== to) audit({ action: 'access_mode.changed', details: { from, to } });
    console.log(to === null ? 'No access mode: only the listeners (BOTONS_HOST, the published port) decide who connects.' : `Access mode: ${to}. A running server applies it to its next request.`);
  } else if (args.revoke !== undefined) {
    const device = listDevices(db).find((d) => d.id === args.revoke);
    if (!device || !deleteDevice(db, device.id)) fail(`No paired device with id ${args.revoke}. \`npm run pair -- --list\` shows them.`);
    audit({ action: 'device.revoked', target: { kind: 'device', id: device.id, label: device.label } });
    console.log(`Revoked ${device.id} (${device.label}). Its next request is refused, and an open web app on it is signed out within half a minute.`);
  } else if (args['revoke-all']) {
    const n = deleteAllDevices(db);
    audit({ action: 'devices.revoked_all', details: { count: n } });
    console.log(`Revoked ${n} device${n === 1 ? '' : 's'}. To pair one again, open Botons on it and approve the code it shows with \`npm run pair -- --approve <code>\`.`);
  } else if (args.approve !== undefined) {
    if (!hasRequests()) fail('This database has no pairing requests yet: start the server once (it upgrades the database), then open Botons on the device.');
    const approved = approvePairingRequest(db, args.approve, args.label ?? '');
    if (!approved) {
      fail(
        'No device is waiting with that code. Check it against the device\'s screen: a code lasts 15 minutes, works once, and belongs to the Botons server with its data in ' +
          `${home}.`,
      );
    }
    audit({ action: 'pairing_request.approved', details: { label: approved.label, requestedAt: approved.createdAt } });
    console.log(`Approved "${approved.label}" (asked ${when(approved.createdAt)}). It signs in within a few seconds.`);
  } else {
    if (args.label !== undefined) fail('--label names the device you approve: use it with --approve <code>.', 2);
    // Only for the URLs to show: a bad setting elsewhere must not stop you getting back in.
    let urls: string[] = [];
    try {
      const cfg = loadConfig(env, undefined, { create: false });
      // BOTONS_PUBLIC_URL first: in a container or behind a proxy it is the only address a device can open.
      urls = [...new Set([cfg.publicUrl, ...cfg.urls])];
    } catch (err) {
      console.warn(`(Not listing the server's URLs: ${(err as Error).message})`);
    }
    console.log(`\n  To pair a device with the Botons server whose data is in ${home}:`);
    console.log('  1. Open Botons on that device. It shows a code:');
    for (const u of urls) console.log(`       ${u}`);
    console.log(`  2. Approve that code here:  ${approveCommand({ container: env.BOTONS_CONTAINER === '1' })}`);
    console.log('\n  Approve only a code you read off the screen of the device you are pairing. A Boton');
    console.log('  can ask to pair too, so never approve a code that reached you in a chat or a message.\n');
    const waiting = hasRequests() ? pendingPairingRequests(db).filter((r) => !r.approved) : [];
    if (waiting.length) {
      console.log(`  Waiting now (newest last; codes show only on the devices):`);
      for (const r of waiting) console.log(`    ${r.label || 'Unnamed device'}  (asked ${when(r.createdAt)})`);
      console.log('');
    }
  }
} finally {
  db.close();
}
