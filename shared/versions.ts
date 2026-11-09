/** Stable registry releases only. CLI output may prepend its product name. */
export function stableVersion(text: string | null): number[] | null {
  const m = /^(?:codex-cli |Claude Code )?(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?$/.exec(text?.trim() ?? '');
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
export function newerRelease(installed: string | null, latest: string | null): boolean {
  const a = stableVersion(installed), b = stableVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i]! > a[i]!;
  return false;
}


/** "0.167.0" from a CLI's `--version` ("codex-cli 0.167.0", "2.1.3 (Claude Code)"); null in any other shape. */
export function cliVersion(text: string | null): string | null {
  return stableVersion(text)?.join('.') ?? null;
}

/** Which copy of a CLI Botons runs: its own (Settings → Brains or the installer put it there) or the system's. */
export interface CliCopy { managed: boolean; terminal: string | null }

const product = (id: string) => (id === 'codex-cli' ? 'Codex' : 'Claude Code');

/** One line for an installed CLI's copy: "Botons' own copy 0.167.0" or "System copy 2.1.3"; null without a version. */
export function copyLine(version: string | null, copy: CliCopy | undefined): string | null {
  const v = cliVersion(version);
  return copy && v ? `${copy.managed ? "Botons' own copy" : 'System copy'} ${v}` : null;
}

/** What a successful Update now did, in one line. */
export function updatedLine(id: string, version: string | null): string {
  const v = cliVersion(version);
  return `Botons now uses its own ${product(id)}${v ? ` ${v}` : ''}.`;
}

/** A note when a terminal on this machine runs an older copy than the one Botons uses; null otherwise. */
export function terminalNote(id: string, version: string | null, copy: CliCopy | undefined): string | null {
  const t = cliVersion(copy?.terminal ?? null), v = cliVersion(version);
  if (!copy?.managed || !t || !v || !newerRelease(t, v)) return null;
  const cmd = id === 'codex-cli' ? 'codex' : 'claude';
  return `Your terminal’s ${cmd} is still ${t}. Run ${cmd} update there if you want it updated too.`;
}
