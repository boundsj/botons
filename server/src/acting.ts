import { AsyncLocalStorage } from 'node:async_hooks';

// The turn a Boton's request to the server came from, while the server handles it: so what the request posts in the
// chat (a memory saved, a file shared...) is known to be that turn's. Set only for a Boton's own token, from the turn
// the engine is running for it, never from anything in the request.
const acting = new AsyncLocalStorage<{ botId: string; turnId: string }>();

export function asTurn<T>(botId: string, turnId: string | null | undefined, fn: () => T): T {
  return turnId ? acting.run({ botId, turnId }, fn) : fn();
}

/** The turn of the Boton's request being handled, if it is `botId`'s: else null (the owner, the server). */
export function actingTurn(botId: string): string | null {
  const a = acting.getStore();
  return a && a.botId === botId ? a.turnId : null;
}
