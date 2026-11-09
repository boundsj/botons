import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class DataDirInUseError extends Error {
  name = 'DataDirInUseError';
  constructor(home: string, pid: number | null) {
    super(
      `Botons data dir in use: another Botons server${pid ? ` (pid ${pid})` : ''} is using ${home}. ` +
        'Stop it first, or set BOTONS_HOME to another folder. Nothing was changed.',
    );
  }
}

export interface DataDirLock {
  release(): void;
}

function livePid(pidFile: string): number | null {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile, 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // EPERM: it exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

/** Each held lock's connection, so dropping a lock's handle can't let GC close it and free the data dir. */
const heldLocks = new Set<DatabaseSync>();

/**
 * Only one server may open the database. The lock is an open EXCLUSIVE
 * transaction on `<home>/server.lock`: the kernel drops its fcntl lock when the
 * process dies however it dies, so it never goes stale. server.pid only names
 * the holder in the error.
 */
export function lockDataDir(home: string): DataDirLock {
  const lockFile = join(home, 'server.lock');
  const pidFile = join(home, 'server.pid');
  const db = new DatabaseSync(lockFile, { timeout: 0 });
  try {
    // Journal in memory, so no server.lock-journal appears.
    db.exec('pragma journal_mode = memory; begin exclusive');
  } catch (err) {
    db.close();
    // SQLITE_BUSY (5), possibly as an extended code.
    if ((((err as { errcode?: number }).errcode ?? 0) & 0xff) === 5) throw new DataDirInUseError(home, livePid(pidFile));
    throw err;
  }
  heldLocks.add(db);
  try {
    writeFileSync(pidFile, `${process.pid}\n`);
  } catch {}
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      // While still holding the lock, so it never removes the next holder's pid file.
      try {
        if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) rmSync(pidFile, { force: true });
      } catch {}
      heldLocks.delete(db);
      db.close();
    },
  };
}
