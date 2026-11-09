import { VERSION } from '../../../shared/app-version.mjs';
// `botons`: what a Boton runs from its shell. $BOTON_TOKEN is issued for one turn and reaches only this Boton's own things.
// Its deprecated names run it too, from server/bin/legacy (see shared/legacy-names.mjs).
import '../env-init.ts';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Approval, ApprovalRequestResult, AskResult, ConnectorRequestResult, Memory, Message, BotonConnector, NotifyResult, Routine, RoutineRun, ShareResult, Skill, TeamMember, WebhookFilter } from '../../../shared/types.ts';
import { durationText, isPastOneOff } from '../../../shared/util.ts';
import { fmtTime } from '../util.ts';
import { serveApprovals } from './approve-mcp.ts';
import { serveBrowser } from './browser-mcp.ts';
import { readWorkspaceFile, WorkspaceFileError } from './workspace-file.ts';

const API = (process.env.BOTONS_API ?? 'http://127.0.0.1:7777').replace(/\/$/, '');
const BOT = process.env.BOTON_BOT_ID ?? '';
const TOKEN = process.env.BOTON_TOKEN ?? '';
const WORKSPACE = process.env.BOTON_WORKSPACE ?? '';

const HELP = `botons — manage your routines and memory, use skills, notify your owner, share files, react to your owner's messages, ask your owner for approval, and ask the other Botons

  botons routine list
  botons routine show <id>
  botons routine create --name <name> --instruction <text> [--schedule <when>] [--webhook] [--paused] [--timezone <tz>]
                        [--notify auto|always|failures|never] [--source <sender>] [--filter <filter>] [--skill <name>]
                        [--model <id>] [--effort <level>] [--session chat|own] [--time-limit <duration>]
  botons routine update <id> [--name ..] [--instruction ..] [--schedule <when> | --no-schedule]
                             [--pause | --resume] [--webhook | --no-webhook] [--rotate-key] [--timezone <tz>]
                             [--notify auto|always|failures|never] [--source <sender>] [--filter <filter> | --no-filter]
                             [--skill <name> | --no-skill] [--model <id> | --no-model]
                             [--effort <level> | --no-effort] [--session chat|own]
                             [--time-limit <duration> | --no-time-limit]
  botons routine delete <id>
  botons routine run <id>
  botons routine test <id> [--payload <json> | --payload @<file>]
  botons memory list
  botons memory add <text>
  botons memory forget <id>
  botons skill list
  botons skill show <name>
  botons skill create --name <name> --description <text> (--body <text> | --file <SKILL.md>)
  botons skill update <name> [--description <text>] [--body <text> | --file <SKILL.md>]
  botons notify <text> [--priority high]
  botons share <path> [--title <text>]
  botons react <message-id> <emoji>
  botons unreact <message-id>
  botons approval request --title <text> [--details <text>] [--then <text>] [--action <kind>] [--expires <duration>]
  botons approval list [--pending]
  botons approval show <id>
  botons approval cancel <id>
  botons connector list
  botons connector request <id>
  botons card post (--card <json> | --file <card.json>) [--expires <duration>]
  botons card show <id>
  botons team
  botons ask <name or id> <text>

Schedules: cron ("0 8 * * 1-5"), "every 30m", "every 2h", "daily at 8:00", "weekdays at 7:30am",
"in 20m", or "at 2026-11-05 09:00".
--notify: which runs push to your owner's phone. auto (default): failures and \`botons notify\`;
always: also every result that isn't [quiet]; failures: only failures; never: nothing.
--source: who calls the webhook: generic (callers send the key; the default), github, linear, slack
or sentry (each delivery must carry the sender's signature; your owner saves Linear's, Slack's and
Sentry's signing secrets in the app, and GitHub uses the key as its secret).
\`routine test\` runs it as its webhook would, with a sample payload (JSON or text, or @file to read
one from your workspace), as a dry run: it doesn't change the routine's last status and pushes nothing.
--filter: run only for some deliveries, e.g. "header:X-GitHub-Event=push,pull_request" or
"field:action=opened" (a JSON body field, dot path); others are skipped.
--model: the model the routine's runs use (e.g. haiku for a frequent, simple check); --no-model (or
--model "") goes back to your own model.
--effort: how hard the routine's runs think (e.g. low for a frequent, simple check). The levels are your
provider's (Claude Code: low, medium, high, xhigh, max; Codex: the ones its model lists, such as low,
medium, high, xhigh); another one is refused with the list. --no-effort (or --effort "") goes back to
your own effort. Your context block says what this turn runs on.
--session: chat (default) runs it in your conversation with your owner; own runs it in a session of
its own, so frequent runs and their payloads stay out of the chat's context (your chat turns still see
its latest results). Its results are posted in the chat either way.
--time-limit: how long one run may take once it starts (e.g. 10m, 1h, 90s) before it is stopped and
fails as timed out (not tried again by itself); at most the server's limit, which is also the default.
--no-time-limit goes back to the server's limit.
\`botons notify\` posts a chip in your chat and pushes the text (keep it to one short line) to your
owner's phone. \`botons share\` posts a chip in your chat that opens a file from your workspace
(a report, a chart, an export); the path is relative to the current folder, or absolute.
\`botons react\` puts one emoji on one of your owner's own messages in your chat (your context block lists
the ids of the messages your turn answers); \`unreact\` takes yours off. One reaction per message at most,
never on your own messages, and never in place of an answer a question or request needs. A reaction pushes
nothing and is never an approval.
\`botons ask\` posts your message in another Boton's chat, signed as you, and returns at once;
its reply comes back to you later as a new message.
Skills are procedures in the library your owner shares with every Boton. Save one when you have
worked out how to do something that will come up again: a name like weekly-report (lowercase words
and hyphens), a description that says what it does and when to use it, and the steps as Markdown.
--file reads a SKILL.md in your workspace (name and description can come from its frontmatter).
A skill you save is yours: only you can use it until your owner approves it for the other Botons,
and you can change it until then. --skill on a routine makes every run follow that skill.
\`botons approval request\` asks your owner before you do something risky: they get a card in your
chat (and a push) to allow or deny it. Don't wait for the answer and don't do the thing: end your
turn. You get a new turn with the decision and your --then text (what to do once allowed; write it
so it stands on its own). --action names the kind of action ("git push"), so your owner can always
allow it; then such a request is allowed at once and you go ahead in the same turn. --expires: how
long it waits (default 24h, at most 7d).
\`botons connector list\` shows your connectors and the ones your owner lets you ask for; \`request\`
asks for one by id: it is yours from your next turn, at once or once your owner allows it.
\`botons card post\` shows your owner a card in the chat: data only, drawn by the app as plain text.
The card is JSON: {"v":1,"title":"…","blocks":[…]} with up to 20 blocks, each one of
  {"type":"text","text":"…"}  {"type":"status","tone":"info|success|warning|error|working","text":"…"}
  {"type":"progress","label":"…","value":3,"max":10}  {"type":"table","columns":["…"],"rows":[["…",1]]}
  {"type":"file","path":"<a file in your workspace>"}  {"type":"link","url":"https://…","label":"…"}
and at most one question: {"type":"choice","id":"pick","prompt":"…","options":[{"id":"a","label":"…"},…]},
{"type":"form","id":"f","fields":[{"id":"name","label":"…","kind":"text|textarea|number|select|checkbox"}]}
or {"type":"connector","connectorId":"<one from \`botons connector list\` you may ask for>"}. No HTML,
Markdown or scripts; unknown fields are refused. Never ask for a password, key, token or code on a card:
its answer goes into the chat. Don't wait for the answer: end your turn. You get a new turn with it
(a connector card: with the connector, if your owner gives it). --expires: default 24h, at most 7d.
Add --json to any command for JSON output.`;

class CliError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new CliError(`Can't reach the Botons server at ${API}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (res.status === 401) {
    throw new CliError('The Botons server did not accept this turn\'s token. It only works during the turn it was issued for; run `botons` from within a turn.');
  }
  if (!res.ok) throw new CliError(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

const when = (iso: string | null, tz: string) => (iso ? fmtTime(iso, tz) : '—');

function routineLine(r: Routine): string {
  const done = !r.enabled && isPastOneOff(r.schedule);
  const bits = [r.scheduleText ?? 'no schedule', done ? 'done' : r.enabled ? 'active' : 'paused'];
  if (r.enabled && r.nextRunAt) bits.push(`next ${when(r.nextRunAt, r.timezone)}`);
  if (r.webhook) bits.push(r.webhook.source === 'generic' ? 'webhook' : `webhook from ${r.webhook.source}`);
  if (r.notify !== 'auto') bits.push(`notify ${r.notify}`);
  if (r.skill) bits.push(`skill ${r.skill}`);
  if (r.model) bits.push(`model ${r.model}`);
  if (r.effort) bits.push(`effort ${r.effort}`);
  if (r.session === 'own') bits.push('own session');
  if (r.timeLimitMs) bits.push(`time limit ${durationText(r.timeLimitMs)}`);
  if (r.lastStatus) bits.push(`last ${r.lastStatus}`);
  return `${r.id}  ${r.name}  (${bits.join(', ')})`;
}

/** "90s", "10m", "1.5h" (a bare number is minutes), in ms. */
function parseTimeLimit(raw: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?\s*$/i.exec(raw);
  if (!m) throw new CliError('--time-limit must be a duration such as 10m, 1h or 90s.');
  const unit = (m[2] ?? 'm')[0].toLowerCase();
  return Math.round(Number(m[1]) * (unit === 's' ? 1000 : unit === 'h' ? 3_600_000 : 60_000));
}

function parseFilterFlag(raw: string): WebhookFilter {
  const m = /^\s*(header|field)\s*:\s*([^=]+?)\s*=\s*(.+)$/.exec(raw);
  if (!m) throw new CliError('--filter must look like "header:X-GitHub-Event=push,pull_request" or "field:action=opened".');
  return { kind: m[1] as WebhookFilter['kind'], name: m[2], values: m[3].split(',').map((v) => v.trim()).filter(Boolean) };
}

function filterLine(f: WebhookFilter): string {
  return `  Runs only when ${f.kind === 'header' ? `header ${f.name}` : `body field ${f.name}`} is ${f.values.join(' or ')}; other deliveries are skipped.`;
}

async function ownRoutine(id: string): Promise<Routine> {
  const r = await call<Routine>('GET', `/api/routines/${encodeURIComponent(id)}`);
  if (r.botId !== BOT) throw new CliError(`Routine ${id} belongs to another boton`);
  return r;
}

async function main(argv: string[]): Promise<string | object> {
  if (argv.length === 1 && argv[0] === '--version') return VERSION;
  const { values: o, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      instruction: { type: 'string' },
      prompt: { type: 'string' },
      schedule: { type: 'string' },
      'no-schedule': { type: 'boolean' },
      timezone: { type: 'string' },
      webhook: { type: 'boolean' },
      'no-webhook': { type: 'boolean' },
      'rotate-key': { type: 'boolean' },
      pause: { type: 'boolean' },
      paused: { type: 'boolean' },
      resume: { type: 'boolean' },
      notify: { type: 'string' },
      source: { type: 'string' },
      filter: { type: 'string' },
      'no-filter': { type: 'boolean' },
      payload: { type: 'string' },
      model: { type: 'string' },
      'no-model': { type: 'boolean' },
      effort: { type: 'string' },
      'no-effort': { type: 'boolean' },
      session: { type: 'string' },
      'time-limit': { type: 'string' },
      'no-time-limit': { type: 'boolean' },
      priority: { type: 'string' },
      title: { type: 'string' },
      skill: { type: 'string' },
      'no-skill': { type: 'boolean' },
      description: { type: 'string' },
      body: { type: 'string' },
      file: { type: 'string' },
      details: { type: 'string' },
      then: { type: 'string' },
      action: { type: 'string' },
      expires: { type: 'string' },
      card: { type: 'string' },
      pending: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [area, action, ...rest] = pos;
  if (o.help || !area || area === 'help') return HELP;
  if (!BOT || !TOKEN) throw new CliError('BOTON_BOT_ID or BOTON_TOKEN is not set; this tool is meant to be run by a Boton, during a turn.');
  const instruction = o.instruction ?? o.prompt;
  const skillFile = () => {
    if (o.file === undefined) return null;
    const file = parseSkillFile(readWorkspaceFile(o.file, WORKSPACE));
    if (o.body !== undefined) throw new CliError('Give --body or --file, not both.');
    return file;
  };

  if (area === 'routine' || area === 'routines') {
    switch (action ?? 'list') {
      case 'list': {
        const list = await call<Routine[]>('GET', `/api/bots/${BOT}/routines`);
        if (o.json) return list;
        return list.length ? list.map(routineLine).join('\n') : 'No routines yet.';
      }
      case 'show': {
        const r = await ownRoutine(need(rest[0], 'routine id'));
        const runs = await call<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`);
        if (o.json) return { ...r, runs };
        const lines = [routineLine(r), '', 'Instruction:', r.instruction];
        if (r.webhook) {
          // The server leaves the key out during a sandboxed webhook run.
          const { source } = r.webhook;
          const key = r.webhook.key || '(key hidden during a webhook run)';
          if (source === 'generic') lines.push('', 'Webhook:', `  POST ${r.webhook.url}`, `  Authorization: Bearer ${key}`);
          else {
            lines.push('', `Webhook (sent by ${source}; only deliveries with a valid ${source} signature run):`, `  POST ${r.webhook.url}`, `  Key: ${key}`);
            if (source === 'github') lines.push(r.webhook.hasSecret ? '  GitHub signs with the signing secret your owner saved.' : '  GitHub signs with the key: paste it into the webhook\'s Secret field.');
            else if (!r.webhook.hasSecret) lines.push(`  No ${source} signing secret is saved yet, so deliveries are refused: your owner adds it in the app (routine editor).`);
          }
          if (r.webhook.filter) lines.push(filterLine(r.webhook.filter));
          if (r.webhook.callbackUrl) lines.push(`  Each finished run's result is POSTed to ${r.webhook.callbackUrl}, signed with the key (X-Boton-Signature).`);
          lines.push(r.webhookWorkspace ? '  Its runs get Workspace access (sandboxed), whatever your own access is.' : '  Its runs get your own access.');
          if (r.webhook.key && source === 'generic') lines.push(`  curl -X POST '${r.webhook.url}' -H 'Authorization: Bearer ${r.webhook.key}' -H 'Content-Type: application/json' -d '{"hello":"world"}'`);
        }
        lines.push('', 'Recent runs:');
        if (!runs.length) lines.push('  none');
        for (const run of runs.slice(0, 5)) {
          const status = run.quiet ? 'quiet' : run.status;
          const said = run.error ?? (run.quiet ? run.reply : null);
          lines.push(`  ${run.id} ${run.trigger} ${status} ${when(run.startedAt, r.timezone)}${said ? ` — ${said}` : ''}`);
        }
        return lines.join('\n');
      }
      case 'create':
      case 'add': {
        const r = await call<Routine>('POST', `/api/bots/${BOT}/routines`, {
          name: need(o.name, '--name'),
          instruction: need(instruction, '--instruction'),
          schedule: o.schedule ?? null,
          timezone: o.timezone,
          webhook: !!o.webhook,
          enabled: !(o.paused || o.pause),
          notify: o.notify,
          webhookSource: o.source,
          webhookFilter: o.filter === undefined ? undefined : parseFilterFlag(o.filter),
          skill: o.skill,
          model: o['no-model'] ? null : o.model,
          effort: o['no-effort'] ? null : o.effort,
          session: o.session,
          timeLimitMs: o['time-limit'] === undefined ? undefined : parseTimeLimit(o['time-limit']),
        });
        if (o.json) return r;
        let out = `Created ${routineLine(r)}`;
        if (r.webhook) out += `\nWebhook: POST ${r.webhook.url}  (Authorization: Bearer ${r.webhook.key})`;
        if (!r.schedule && !r.webhook) out += '\nNote: no schedule or webhook, so it only runs when triggered with `botons routine run`.';
        return out;
      }
      case 'update':
      case 'edit': {
        const r0 = await ownRoutine(need(rest[0], 'routine id'));
        const patch: Record<string, unknown> = {};
        if (o.name !== undefined) patch.name = o.name;
        if (instruction !== undefined) patch.instruction = instruction;
        if (o.schedule !== undefined) patch.schedule = o.schedule;
        if (o['no-schedule']) patch.schedule = null;
        if (o.timezone !== undefined) patch.timezone = o.timezone;
        if (o.pause || o.paused) patch.enabled = false;
        if (o.resume) patch.enabled = true;
        if (o.webhook) patch.webhook = true;
        if (o['no-webhook']) patch.webhook = false;
        if (o['rotate-key']) patch.rotateKey = true;
        if (o.notify !== undefined) patch.notify = o.notify;
        if (o.source !== undefined) patch.webhookSource = o.source;
        if (o.filter !== undefined) patch.webhookFilter = parseFilterFlag(o.filter);
        if (o['no-filter']) patch.webhookFilter = null;
        if (o.skill !== undefined) patch.skill = o.skill;
        if (o['no-skill']) patch.skill = null;
        if (o.model !== undefined) patch.model = o.model.trim() || null;
        if (o['no-model']) patch.model = null;
        if (o.effort !== undefined) patch.effort = o.effort.trim() || null;
        if (o['no-effort']) patch.effort = null;
        if (o.session !== undefined) patch.session = o.session;
        if (o['time-limit'] !== undefined) patch.timeLimitMs = parseTimeLimit(o['time-limit']);
        if (o['no-time-limit']) patch.timeLimitMs = null;
        if (!Object.keys(patch).length) throw new CliError('Nothing to update. See `botons help`.');
        const r = await call<Routine>('PATCH', `/api/routines/${r0.id}`, patch);
        if (o.json) return r;
        let out = `Updated ${routineLine(r)}`;
        if (r.webhook && (o.webhook || o['rotate-key'])) out += `\nWebhook: POST ${r.webhook.url}  (Authorization: Bearer ${r.webhook.key})`;
        return out;
      }
      case 'delete':
      case 'remove':
      case 'rm': {
        const r = await ownRoutine(need(rest[0], 'routine id'));
        await call('DELETE', `/api/routines/${r.id}`);
        return o.json ? { ok: true } : `Deleted ${r.id} (${r.name}).`;
      }
      case 'run': {
        const r = await ownRoutine(need(rest[0], 'routine id'));
        const run = await call<RoutineRun>('POST', `/api/routines/${r.id}/run`);
        return o.json ? run : `Queued run ${run.id} of "${r.name}". It starts after your current reply and its result is posted in the chat.`;
      }
      case 'test': {
        const r = await ownRoutine(need(rest[0], 'routine id'));
        // At most 1 MiB, as a webhook's; read from the workspace only, since a test run shows the Boton its payload.
        const payload = o.payload?.startsWith('@')
          ? readWorkspaceFile(o.payload.slice(1), WORKSPACE, 1024 * 1024, { flag: '--payload @file', instead: 'pass the payload itself with --payload' })
          : o.payload;
        const run = await call<RoutineRun>('POST', `/api/routines/${r.id}/run`, { test: true, ...(payload === undefined ? {} : { payload }) });
        if (o.json) return run;
        return `Queued test run ${run.id} of "${r.name}"${run.payloadBytes ? ` with a ${run.payloadBytes}-byte payload` : ''}. It starts after your current reply; it runs as a dry run, and its result is posted in the chat.`;
      }
      default:
        throw new CliError(`Unknown routine command "${action}". See \`botons help\`.`);
    }
  }

  if (area === 'memory' || area === 'memories') {
    switch (action ?? 'list') {
      case 'list': {
        const list = await call<Memory[]>('GET', `/api/bots/${BOT}/memories`);
        if (o.json) return list;
        return list.length ? list.map((m) => `${m.id}  ${m.text}`).join('\n') : 'No memories yet.';
      }
      case 'add':
      case 'save': {
        const text = need(rest.join(' ').trim() || undefined, 'memory text');
        const m = await call<Memory>('POST', `/api/bots/${BOT}/memories`, { text });
        return o.json ? m : `Saved ${m.id}.`;
      }
      case 'forget':
      case 'delete':
      case 'rm': {
        const id = need(rest[0], 'memory id');
        await call('DELETE', `/api/memories/${encodeURIComponent(id)}`);
        return o.json ? { ok: true } : `Forgot ${id}.`;
      }
      default:
        throw new CliError(`Unknown memory command "${action}". See \`botons help\`.`);
    }
  }
  if (area === 'skill' || area === 'skills') {
    switch (action ?? 'list') {
      case 'list': {
        const list = await call<Skill[]>('GET', `/api/bots/${BOT}/skills`);
        if (o.json) return list;
        const by = (s: Skill) => (s.pending ? '  (yours; only you can use it until your owner approves it)' : s.createdBy.kind === 'boton' ? `  (written by ${s.createdBy.name})` : '');
        return list.length ? list.map((s) => `${s.name}  ${s.description}${by(s)}`).join('\n') : 'No skills yet.';
      }
      case 'show':
      case 'read': {
        const s = await call<Skill>('GET', `/api/bots/${BOT}/skills/${encodeURIComponent(need(rest[0], 'skill name'))}`);
        if (o.json) return s;
        return `# ${s.name}\n${s.description}\n\n${s.body}`;
      }
      case 'create':
      case 'add':
      case 'save': {
        const file = skillFile();
        const s = await call<Skill>('POST', `/api/bots/${BOT}/skills`, {
          name: need(o.name ?? file?.name, '--name'),
          description: need(o.description ?? file?.description, '--description'),
          body: need(o.body ?? file?.body, '--body or --file'),
        });
        return o.json ? s : `Saved the skill ${s.name}. Only you can use it until your owner approves it for the other Botons.`;
      }
      case 'update':
      case 'edit': {
        const name = need(rest[0], 'skill name');
        const file = skillFile();
        const patch: Record<string, unknown> = {};
        if (o.description !== undefined) patch.description = o.description;
        else if (file?.description) patch.description = file.description;
        if (o.body !== undefined) patch.body = o.body;
        else if (file) patch.body = file.body;
        if (!Object.keys(patch).length) throw new CliError('Nothing to update. See `botons help`.');
        const s = await call<Skill>('PATCH', `/api/bots/${BOT}/skills/${encodeURIComponent(name)}`, patch);
        return o.json ? s : `Updated the skill ${s.name}.`;
      }
      default:
        throw new CliError(`Unknown skill command "${action}". See \`botons help\`.`);
    }
  }
  if (area === 'notify') {
    const text = need(pos.slice(1).join(' ').trim() || undefined, 'notification text');
    const priority = o.priority ?? 'default';
    if (priority !== 'default' && priority !== 'high') throw new CliError('--priority must be "high" (or "default").');
    const out = await call<NotifyResult>('POST', `/api/bots/${BOT}/notify`, { text, priority });
    if (o.json) return out;
    const failed = out.deliveries.filter((d) => !d.ok);
    if (out.skipped) return `Posted in your chat; no push sent: ${out.skipped}.`;
    if (!failed.length) return 'Sent. Your owner got a push, and it is posted in your chat.';
    return `Posted in your chat, but the push failed (${failed.map((d) => d.error).join('; ')}).`;
  }
  if (area === 'share') {
    const path = need(action, 'file path');
    if (rest.length) throw new CliError('Share one file at a time (quote a path with spaces). See `botons help`.');
    const out = await call<ShareResult>('POST', `/api/bots/${BOT}/share`, { path: resolve(process.cwd(), path), title: o.title });
    if (o.json) return out;
    return `Shared ${out.file.path}. Your owner sees a chip in the chat that opens it.`;
  }
  if (area === 'react') {
    const id = need(action, 'message id');
    const emoji = need(rest.join(' ').trim() || undefined, 'emoji');
    const out = await call<Message>('POST', `/api/bots/${BOT}/messages/${encodeURIComponent(id)}/reactions`, { emoji });
    if (o.json) return out;
    return `Reacted ${out.reactions?.find((r) => r.by === 'boton')?.emoji ?? emoji} to ${id}. Your owner sees it on their message (no push).`;
  }
  if (area === 'unreact') {
    const id = need(action, 'message id');
    if (rest.length) throw new CliError('Unreact takes only the message id: you have one reaction per message at most.');
    const out = await call<Message>('DELETE', `/api/bots/${BOT}/messages/${encodeURIComponent(id)}/reactions`);
    return o.json ? out : `Took your reaction off ${id}.`;
  }
  if (area === 'approval' || area === 'approvals') {
    switch (action ?? 'list') {
      case 'request':
      case 'ask': {
        const out = await call<ApprovalRequestResult>('POST', `/api/bots/${BOT}/approvals`, {
          title: need(o.title ?? (rest.join(' ').trim() || undefined), '--title'),
          details: o.details,
          followUp: o.then,
          action: o.action,
          expiresIn: o.expires,
        });
        if (o.json) return out;
        const a = out.approval;
        if (a.status === 'allowed') return `Allowed at once (${a.id}): your owner always allows "${a.action}". Go ahead now, in this turn.`;
        const again = out.duplicate ? 'You already asked this; it is still waiting. ' : '';
        return `${again}Asked your owner to approve "${a.title}" (${a.id}); it expires ${when(a.expiresAt, Intl.DateTimeFormat().resolvedOptions().timeZone)}. Don't do it now: end your turn. You get a new turn with the decision${a.followUp ? ' and your --then text' : ''}.`;
      }
      case 'list': {
        const list = await call<Approval[]>('GET', `/api/bots/${BOT}/approvals?status=${o.pending ? 'pending' : 'all'}`);
        if (o.json) return list;
        return list.length ? list.slice(0, 30).map(approvalLine).join('\n') : o.pending ? 'No approval requests waiting.' : 'No approval requests yet.';
      }
      case 'show': {
        const a = await call<Approval>('GET', `/api/approvals/${encodeURIComponent(need(rest[0], 'approval id'))}`);
        if (o.json) return a;
        const lines = [approvalLine(a)];
        if (a.details) lines.push('', 'Details:', a.details);
        if (a.followUp) lines.push('', 'Then:', a.followUp);
        if (a.note) lines.push('', `Your owner's note: ${a.note}`);
        return lines.join('\n');
      }
      case 'cancel':
      case 'withdraw': {
        const a = await call<Approval>('POST', `/api/approvals/${encodeURIComponent(need(rest[0], 'approval id'))}/cancel`);
        return o.json ? a : `Withdrew ${a.id} ("${a.title}").`;
      }
      default:
        throw new CliError(`Unknown approval command "${action}". See \`botons help\`.`);
    }
  }
  if (area === 'card' || area === 'cards') {
    switch (action) {
      case 'post': {
        if ((o.card === undefined) === (o.file === undefined)) throw new CliError('Give the card as --card <json> or --file <card.json> (a file in your workspace). See `botons help`.');
        const raw = o.card ?? readWorkspaceFile(o.file!, WORKSPACE, 64 * 1024, { flag: '--file', instead: 'pass the card itself with --card' });
        let card: unknown;
        try {
          card = JSON.parse(raw);
        } catch (e) {
          throw new CliError(`The card is not valid JSON: ${(e as Error).message}`);
        }
        const out = await call<{ message: Message; duplicate: boolean }>('POST', `/api/bots/${BOT}/cards`, { card, ...(o.expires ? { expiresIn: o.expires } : {}) });
        if (o.json) return out;
        const c = out.message.meta?.card;
        if (c?.status === 'shown') return `Posted the card "${c.descriptor.title}" (${out.message.id}) in your chat.`;
        const again = out.duplicate ? 'You already posted this card; it is still waiting. ' : '';
        return `${again}Posted the card "${c?.descriptor.title}" (${out.message.id}); it waits for your owner until ${when(c?.expiresAt ?? null, Intl.DateTimeFormat().resolvedOptions().timeZone)}. Don't wait for it: end your turn. You get a new turn with the answer.`;
      }
      case 'show': {
        const m = await call<Message>('GET', `/api/cards/${encodeURIComponent(need(rest[0], 'card id'))}`);
        if (o.json) return m;
        const c = m.meta?.card;
        if (!c) throw new CliError('That is not a card.');
        const lines = [`${m.id}  ${c.descriptor.title}  (${c.status})`];
        if (c.reason) lines.push(`Closed: ${c.reason}`);
        if (c.answer) lines.push(`Answered ${c.answer.at}: ${c.answer.action}${c.answer.option ? ` ${c.answer.option.label}` : ''}${c.answer.result ? ` (${c.answer.result})` : ''}`);
        return lines.join('\n');
      }
      default:
        throw new CliError(`Unknown card command "${action ?? ''}". See \`botons help\`.`);
    }
  }
  if (area === 'connector' || area === 'connectors') {
    switch (action ?? 'list') {
      case 'list': {
        const list = await call<BotonConnector[]>('GET', `/api/bots/${BOT}/connectors`);
        if (o.json) return list;
        if (!list.length) return 'You have no connectors, and none are available on request.';
        return list
          .map((c) => `${c.id}  ${c.name}  (${c.state === 'yours' ? `yours${c.off ? ', turned off by your owner' : c.usable ? '' : ', not working now'}` : `ask for it: ${c.grant === 'immediate' ? 'granted at once' : 'your owner approves'}`})`)
          .join('\n');
      }
      case 'request':
      case 'ask': {
        const out = await call<ConnectorRequestResult>('POST', `/api/bots/${BOT}/connector-requests`, { connector: need(rest[0], 'connector id (see `botons connector list`)') });
        if (o.json) return out;
        if (out.outcome === 'already') return `${out.connector.name} is already one of your connectors.`;
        if (out.outcome === 'granted') return `${out.connector.name} is yours now; its tools come with your next turn, which starts after this one. End this turn, and carry on with it then.`;
        return `Asked your owner for ${out.connector.name} (${out.approval?.id}). Don't wait for it: end your turn. You get a new turn with the decision.`;
      }
      default:
        throw new CliError(`Unknown connector command "${action}". See \`botons help\`.`);
    }
  }
  if (area === 'team') {
    const team = await call<TeamMember[]>('GET', `/api/bots/${BOT}/team`);
    if (o.json) return team;
    return team.map(teamLine).join('\n');
  }
  if (area === 'ask') {
    const who = need(action, 'who to ask (a name from `botons team`)');
    const text = need(rest.join(' ').trim() || undefined, 'what to ask');
    const target = pick(await call<TeamMember[]>('GET', `/api/bots/${BOT}/team`), who);
    if (target.self) throw new CliError("You can't ask yourself. Do the work in this turn instead.");
    const out = await call<AskResult>('POST', `/api/bots/${encodeURIComponent(target.id)}/asks`, { text });
    if (o.json) return out;
    const later = target.paused ? `${target.name} is paused, so it answers once it is resumed` : `${target.name} answers when it gets to it`;
    return `Asked ${target.name}. ${later}; the reply comes back to you as a new message. Don't wait for it: finish your turn.`;
  }
  throw new CliError(`Unknown command "${area}". See \`botons help\`.`);
}

function approvalLine(a: Approval): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const status =
    a.status === 'pending'
      ? `waiting, expires ${when(a.expiresAt, tz)}`
      : a.auto
        ? `allowed at once (always allows "${a.action}")`
        : `${a.status === 'cancelled' ? 'withdrawn' : a.status}${a.always ? ` (always allows "${a.action}")` : ''} ${when(a.decidedAt, tz)}`;
  return `${a.id}  ${a.title}  (${status})`;
}

function teamLine(t: TeamMember): string {
  const bits = [t.state === 'idle' ? 'idle' : t.state === 'queued' ? 'up next' : 'working'];
  if (t.paused) bits.push('paused');
  if (t.primary) bits.push('primary');
  if (t.self) bits.push('you');
  return `${t.id}  ${t.name}${t.title ? ` — ${t.title}` : ''}  (${bits.join(', ')})`;
}

function pick(team: TeamMember[], who: string): TeamMember {
  const byId = team.find((t) => t.id === who);
  if (byId) return byId;
  const named = team.filter((t) => t.name.toLowerCase() === who.trim().toLowerCase());
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new CliError(`More than one Boton is called ${who}; use an id:\n${named.map(teamLine).join('\n')}`);
  throw new CliError(`No Boton called ${who}. The team:\n${team.map(teamLine).join('\n')}`);
}

/** A SKILL.md: optional frontmatter with name: and description: lines, then the body. */
function parseSkillFile(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ''));
  if (!m) return { body: text.trim() };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { name: fields.name || undefined, description: fields.description || undefined, body: m[2].trim() };
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === '') throw new CliError(`Missing ${what}. See \`botons help\`.`);
  return v;
}

if (process.argv[2] === 'mcp') {
  // Claude Code runs this for a turn with Ask first rules; stdout is the MCP channel.
  await serveApprovals({ api: API, bot: BOT, token: TOKEN, pollMs: Number(process.env.BOTON_APPROVAL_POLL_MS) || undefined });
} else if (process.argv[2] === 'browser-mcp') {
  // Both CLIs start this for a Boton that has the Botons browser connector; stdout is the MCP channel.
  await serveBrowser({ api: API, bot: BOT, token: TOKEN });
} else {
  try {
    const out = await main(process.argv.slice(2));
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(`botons: ${e instanceof CliError || e instanceof WorkspaceFileError ? e.message : (e as Error).stack}`);
    process.exit(1);
  }
}
