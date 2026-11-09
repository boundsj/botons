export function onPath(home: string, path?: string): boolean;
export function profileAddsPath(home: string, shell?: string): boolean;
export function configurePath(options: {home: string; shell?: string; path?: string; yes?: boolean}, ask: (message: string, yes?: boolean) => Promise<void>, log?: (message: string) => void): Promise<boolean>;
export function removePathBlock(home: string, log?: (message: string) => void): void;
