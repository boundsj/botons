import { statfsSync, statSync } from 'node:fs';
import type { StorageStatus } from '../../shared/types.ts';

/** Below this much free space the owner is told, before chats, runs and backups start failing to write. */
export const STORAGE_LOW_BYTES = 1024 ** 3;
const STORAGE_LOW_SHARE = 0.05;

type Statfs = (path: string) => { bavail: number | bigint; blocks: number | bigint; bsize: number | bigint };

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Free space on the disk holding BOTONS_HOME, and the database's size. Never throws; carries no paths or error text. */
export function storageStatus(opts: { home: string; dbPath: string; statfs?: Statfs }): StorageStatus {
  const databaseBytes = size(opts.dbPath) + size(`${opts.dbPath}-wal`);
  try {
    const st = (opts.statfs ?? statfsSync)(opts.home);
    const bsize = Number(st.bsize);
    const freeBytes = Number(st.bavail) * bsize;
    const totalBytes = Number(st.blocks) * bsize;
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) throw new Error('no sizes');
    const low = freeBytes < STORAGE_LOW_BYTES || freeBytes < totalBytes * STORAGE_LOW_SHARE;
    return { unreadable: false, freeBytes, totalBytes, databaseBytes, low, lowBelowBytes: STORAGE_LOW_BYTES };
  } catch {
    return { unreadable: true, freeBytes: 0, totalBytes: 0, databaseBytes, low: false, lowBelowBytes: STORAGE_LOW_BYTES };
  }
}
