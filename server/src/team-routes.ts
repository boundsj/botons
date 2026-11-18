import type { Ctx, Router } from './http.ts';
import type { RouteAccess } from './auth.ts';
import { HttpError } from './store.ts';
import type { TeamActorRef, Teams } from './teams.ts';

/*
 * Teams' HTTP routes. The owner's (paired devices only, the default access) read and steer every team; a Boton's
 * (turn tokens, never a sandboxed turn's: a webhook payload must not travel through a team) act only as the token's
 * Boton, and Teams checks its seat and role on every call.
 */
export function teamRoutes(r: Router, deps: { teams: Teams }): void {
  const { teams } = deps;
  // Its own Boton's token only, and never a sandboxed turn's (the default for a route not marked sandboxed).
  const ownBot: RouteAccess = { boton: (p) => p.id };
  /** The calling Boton, from its token: a device acts on teams through the owner's routes instead. */
  const boton = (c: Ctx): TeamActorRef => {
    if (c.principal?.kind !== 'boton') throw new HttpError(400, 'Only a Boton uses this route (with `botons team`, during its turn). The owner uses /api/teams and /api/team-items.');
    return { owner: false, botId: c.principal.botId };
  };
  const owner = (c: Ctx): TeamActorRef => ({ owner: true, by: c.principal });

  // ---------------------------------------------------------------- the owner's
  r.on('GET', '/api/teams', () => teams.list());
  r.on('POST', '/api/teams', async (c) => c.json(201, teams.create(await c.body<unknown>(), c.principal)));
  r.on('GET', '/api/teams/attention', () => teams.attention());
  r.on('GET', '/api/teams/search', (c) => {
    const q = c.url.searchParams;
    return teams.search(q.get('q'), { team: q.get('team'), limit: Number(q.get('limit') ?? 50) || 50 });
  });
  r.on('GET', '/api/teams/:id', (c) => teams.detail(c.params.id));
  r.on('PATCH', '/api/teams/:id', async (c) => teams.update(c.params.id, await c.body<unknown>(), c.principal));
  r.on('PUT', '/api/teams/:id/members', async (c) => teams.setMembers(c.params.id, await c.body<unknown>(), c.principal));
  r.on('POST', '/api/teams/:id/state', async (c) => teams.setState(c.params.id, await c.body<unknown>(), c.principal));
  r.on('POST', '/api/teams/:id/review', (c) => teams.review(c.params.id, c.principal));
  r.on('DELETE', '/api/teams/:id', (c) => {
    teams.remove(c.params.id, c.principal);
    return { ok: true };
  });
  r.on('POST', '/api/teams/:id/items', async (c) => c.json(201, teams.addItem(c.params.id, await c.body<unknown>(), owner(c))));
  r.on('GET', '/api/team-items/:id', (c) => teams.item(c.params.id));
  r.on('POST', '/api/team-items/:id/actions', async (c) => teams.act(c.params.id, await c.body<unknown>(), owner(c)));
  r.on('GET', '/api/team-threads', (c) => {
    const q = c.url.searchParams;
    return teams.threads({ team: q.get('team'), item: q.get('item'), bot: q.get('bot'), q: q.get('q'), before: Number(q.get('before') ?? 0) || undefined, limit: Number(q.get('limit') ?? 50) || 50 });
  });
  r.on('GET', '/api/team-threads/:id', (c) => teams.threadDetail(c.params.id));
  r.on('GET', '/api/team-threads/:id/messages', (c) => {
    const q = c.url.searchParams;
    teams.threadDetail(c.params.id);
    return teams.messagesOf(c.params.id, { before: Number(q.get('before') ?? 0) || undefined, after: Number(q.get('after') ?? 0) || undefined, limit: Number(q.get('limit') ?? 100) || 100 });
  });
  r.on('POST', '/api/team-threads/:id/read', async (c) => teams.markThreadRead(c.params.id, (await c.body<{ upTo?: unknown }>()).upTo));

  // ---------------------------------------------------------------- a Boton's
  r.on('GET', '/api/bots/:id/teams', (c) => (boton(c), teams.botView(c.params.id)), ownBot);
  r.on('GET', '/api/bots/:id/teams/:teamId', (c) => (boton(c), teams.boardFor(c.params.id, c.params.teamId)), ownBot);
  r.on('POST', '/api/bots/:id/teams/:teamId/items', async (c) => c.json(201, teams.addItem(c.params.teamId, await c.body<unknown>(), boton(c))), ownBot);
  r.on('GET', '/api/bots/:id/team-items/:itemId', (c) => (boton(c), teams.itemFor(c.params.id, c.params.itemId)), ownBot);
  r.on('POST', '/api/bots/:id/team-items/:itemId/actions', async (c) => teams.act(c.params.itemId, await c.body<unknown>(), boton(c)), ownBot);
  r.on('POST', '/api/bots/:id/team-items/:itemId/escalations', async (c) => {
    const me = boton(c);
    return c.json(201, teams.escalate(c.params.itemId, await c.body<unknown>(), me.owner ? '' : me.botId));
  }, ownBot);
  r.on('GET', '/api/bots/:id/team-threads/:threadId', (c) => (boton(c), teams.threadFor(c.params.id, c.params.threadId)), ownBot);
  r.on('POST', '/api/bots/:id/teams/:teamId/done', async (c) => {
    const me = boton(c);
    return teams.finish(c.params.teamId, await c.body<unknown>(), me.owner ? '' : me.botId);
  }, ownBot);
}
