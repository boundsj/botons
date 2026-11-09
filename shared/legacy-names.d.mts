// Types for legacy-names.mjs (see there).
export interface LegacyEnvNotice {
  /** The earlier name that is set. */
  old: string;
  /** Its current name. */
  name: string;
  /** Both are set, to different values: `name`'s is used. */
  conflict: boolean;
}
export const ENV_PREFIXES: readonly (readonly [old: string, now: string])[];
export function currentEnvName(name: string): string | null;
export function earlierEnvNames(name: string): string[];
export function applyLegacyEnv(env: Record<string, string | undefined>): LegacyEnvNotice[];
export function legacyEnvNoticeText(n: LegacyEnvNotice): string;
export function isLegacySetting(name: string): boolean;
export function withLegacyTurnNames(env: Record<string, string>): Record<string, string>;
export function rewriteEnvText(text: string, moves?: readonly (readonly [from: string, to: string])[]): string;
export const DATA_DIRS: readonly string[];
export const CONFIG_DIRS: readonly string[];
export const SHARE_DIRS: readonly string[];
export const DB_FILE: string;
export const UNITS: readonly { readonly service: string; readonly backup: string }[];
export const CLI_NAMES: readonly string[];
export const IMAGE_CLI_NAMES: readonly string[];
export const PATH_BLOCK_NAMES: readonly string[];
export const RENAMED: Readonly<Record<string, string>>;
export function earlierName(now: string): string | null;
export function currentName(value: string): string;
export function storedValue(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, key: string): string | null;
export function currentPortable<T>(file: T): T;
export const PRIVATE_TERMS_FILES: readonly string[];
export function earlierStorageKey(key: string): string | null;
export const OLD_TEXT: RegExp;
export const OLD_WORD: RegExp;
export const FORMERLY: RegExp;
