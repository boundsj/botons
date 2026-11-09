export function parse(args: string[]): Record<string, string | boolean>;
export function verified(bytes: Uint8Array, sums: string, filename: string): void;
export function publicSettings(text: string, value: string): string;

export function packageCommands(osRelease: string): string[][];

export function sourceVersion(input: string): string;

export function dependencyProblems(probe?: (cmd: string, args: string[]) => {status: number | null; stdout?: string}, host?: string): string[];

export function nodeArchive(version: string, host?: string, cpu?: string): { filename: string; extract: string };
