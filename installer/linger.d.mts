export function lingerCommand(user?: string): string;
export function configureLinger(
  options: { yes?: boolean; noSudo?: boolean },
  ask: (message: string, yes?: boolean) => Promise<void>,
  hooks?: {
    user?: string;
    log?: (message: string) => void;
    execute?: (cmd: string, args: string[]) => {
      status: number | null;
      stdout?: string;
      stderr?: string;
      error?: Error;
    };
  },
): Promise<boolean>;
