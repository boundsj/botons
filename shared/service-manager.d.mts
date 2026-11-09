import type { SpawnSyncReturns } from 'node:child_process';
export interface ServiceManagerOptions { platform?: string; home?: string; configHome?: string; name?: string; uid?: number; }
export interface ServiceManager { platform: string; dir: string; files: string[]; serviceFile: string; backupFile: string; label: string; backupLabel: string; target: string; backupTarget: string; domain: string; }
export function serviceManager(options?: ServiceManagerOptions): ServiceManager;
export function serviceCommands(action: string, options?: ServiceManagerOptions, kind?: 'server' | 'backup'): [string, string[]][];
export function runService(action: string, options?: ServiceManagerOptions, kind?: 'server' | 'backup', execute?: (cmd: string, args: string[]) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>, timing?: { now?: () => number; pause?: (ms: number) => void }): Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'> | undefined;
