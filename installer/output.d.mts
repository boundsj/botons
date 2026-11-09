export function plan(command: string, brain?: string): string;
export function summary(options: { command?: string; url: string; running?: boolean; bootReady?: boolean; bootFix?: string }): string;
export function installOutput(path: string, verbose?: boolean): { fd: number; stdio: ['inherit', number, number]; detail(message: string): void; done(message: string): void; replay(): void; failure(): string };
