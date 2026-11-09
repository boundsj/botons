import './env-init.ts';
import { log, setLogLevel } from './log.ts';
import { type App, createApp } from './app.ts';
import { VERSION } from './api.ts';
import { type Config, ConfigError, DataDirError, formatDuration, loadConfig } from './config.ts';
import { NameUpgradeError, upgradeDataFolder } from './legacy-upgrade.ts';
import { DataDirInUseError } from './lock.ts';
import { SchemaError } from './schema.ts';
import { approveCommand } from './setup.ts';

// Node's own warnings as JSON log lines too, so `journalctl ... | jq .` parses every line.
process.removeAllListeners('warning');
process.on('warning', (w) => log.warn(w.message, { warning: w.name, code: (w as NodeJS.ErrnoException).code }));

let app: App | null = null;
// The process is in an unknown state: stop the agent processes and let systemd restart a clean server.
process.on('uncaughtException', (err, origin) => {
  log.error(`fatal ${origin}: stopping running turns and exiting`, { origin, err });
  try {
    app?.engine.stopAll();
  } catch (stopErr) {
    log.error('could not stop running turns', { err: stopErr });
  }
  process.exit(1);
});
// Log and keep serving (instead of Node's default: an uncaught exception).
process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', { err: reason });
});

function config(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof DataDirError) {
      // EX_CONFIG: restarting cannot fix it (systemd: RestartPreventExitStatus=78).
      log.error(`Botons cannot start: ${err.message}`);
      process.exit(78);
    }
    if (!(err instanceof ConfigError)) throw err;
    // EX_CONFIG: restarting cannot fix it, so systemd does not retry (RestartPreventExitStatus=78).
    log.error(`Botons cannot start: fix these settings (environment variables) first: ${err.errors.join('; ')}`, { errors: err.errors });
    process.exit(78);
  }
}
// A data folder or database still under a deprecated name moves to its current one first (legacy-upgrade.ts).
try {
  for (const line of upgradeDataFolder().lines) log.info(line);
} catch (err) {
  if (err instanceof DataDirInUseError) {
    // Not EX_CONFIG: the folder frees up when the other server stops, so a retry can succeed.
    log.error(err.message);
    process.exit(1);
  }
  // A setting problem is reported by config() below; anything else leaves the data where it is, still in use.
  if (!(err instanceof ConfigError)) log.warn(`the data folder keeps its deprecated name for now: ${(err as Error).message}`, { err: err instanceof NameUpgradeError ? undefined : err });
}
const cfg = config();
setLogLevel(cfg.logLevel);
for (const n of cfg.envNotices) {
  if (n.conflict) log.warn('a setting is set under both its name and a deprecated name, to different values: its name is used', { setting: n.name, deprecated: n.old });
  else log.warn('a setting uses a deprecated name, which works for this release only', { setting: n.name, deprecated: n.old });
}

async function open(): Promise<App> {
  try {
    return createApp(cfg, undefined, { releaseChecks: true });
  } catch (err) {
    if (err instanceof DataDirInUseError) {
      // Not EX_CONFIG: the folder frees up when the other server stops, so a retry can succeed.
      log.error(err.message);
      process.exit(1);
    }
    if (!(err instanceof SchemaError)) throw err;
    // EX_CONFIG: restarting cannot fix it (systemd: RestartPreventExitStatus=78).
    log.error(`Botons cannot open ${cfg.dbPath}: ${err.message}`);
    process.exit(78);
  }
}
app = await open();
const running = app;

try {
  await running.listen();
} catch (err) {
  log.error(`Could not start Botons on port ${cfg.port} (${cfg.hosts.join(', ')}): ${(err as Error).message}`, { err });
  process.exit(1);
}

// SIGHUP too: its default (the terminal running `npm start` closed) would skip the drain and leave agent CLIs running.
let signals = 0;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    signals++;
    if (signals === 2) {
      log.info(`shutdown: ${sig} again: stopping running turns now`);
      running.engine.interruptAll();
      return;
    }
    if (signals > 2) process.exit(1);
    log.info(`shutdown: ${sig}: taking no new work; giving running turns up to ${formatDuration(cfg.drainMs)} to finish (${sig} again stops them now)`);
    running.close({ drainMs: cfg.drainMs }).then(
      ({ interrupted }) => {
        log.info(
          interrupted
            ? `shutdown: stopped ${interrupted} turn${interrupted === 1 ? '' : 's'} that had not finished; the next start answers cut-off chat messages again (with a note) and marks cut-off routine runs as interrupted`
            : 'shutdown: done',
          { interrupted },
        );
        process.exit(0);
      },
      (err) => {
        log.error('shutdown failed', { err });
        process.exit(1);
      },
    );
  });
}

const providers = await running.providers.infos();
log.info(`Botons ${VERSION}${cfg.build ? ` (${cfg.build.slice(0, 12)})` : ''} is running at ${cfg.urls.join(', ')}`, {
  version: VERSION,
  build: cfg.build,
  urls: cfg.urls,
  home: cfg.home,
  logLevel: cfg.logLevel,
  providers: providers.map((p) => ({ provider: p.id, available: p.available, version: p.version ?? undefined, loggedIn: p.loggedIn ?? undefined })),
});
for (const p of providers) {
  if (p.available) continue;
  // A CLI that is not installed may simply be unused.
  (p.installed ? log.warn : log.info)(`${p.label} can't run turns: ${p.reason}`, { provider: p.id, installed: p.installed, loggedIn: p.loggedIn });
}
if (!cfg.authEnabled) log.warn('auth is OFF (BOTONS_AUTH=off): anyone who can reach this server can use it, Botons included.');
else if (!running.auth.claimed()) {
  log.info(`No owner yet: open ${cfg.publicUrl}, which shows a code, and claim this server by approving it with \`${approveCommand(cfg)}\` on this machine (or with one click from your own Tailscale device).`);
} else if (!running.auth.devices(null).length) {
  log.info(`No device is paired. Open ${cfg.publicUrl}, which shows a code, and approve it here with \`${approveCommand(cfg)}\`.`);
}
