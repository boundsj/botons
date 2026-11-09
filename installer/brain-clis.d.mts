export interface CliInstallPlan { provider: string; prefix: string; bin: string; command: string; args: string[]; display: string }
export function cliInstallPlan(root: string, node: string, provider: string, prefix?: string): CliInstallPlan;
export function installCli(plan: CliInstallPlan, options: { consent(message: string, yes?: boolean): Promise<void>; yes?: boolean; env?: NodeJS.ProcessEnv; run?: (cmd: string, args: string[], options: {stdio: string; timeout: number; env: NodeJS.ProcessEnv}) => { status: number | null; error?: unknown } }): Promise<void>;
export function cliPresent(bin: string, env?: NodeJS.ProcessEnv): boolean;
