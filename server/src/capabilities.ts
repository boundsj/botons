import type { Bot, BotonCapabilities, BotonConnector, Routine } from '../../shared/types.ts';
import { splitRules } from './ask-rules.ts';

/** The Boton's brain, as far as Ask first goes: the engine only hands rules to a provider that enforces them. */
export interface BrainSupport {
  label: string;
  askFirst: boolean;
  /** Botons runs its tools itself (an API key brain): its own sandbox, not a CLI's. */
  serverTools?: boolean;
}

/**
 * What a Boton may do, worded for its owner. It reads the same fields the
 * engine enforces (access, connectors, skills, Ask first and Always allow
 * rules, routines), so it never grants anything itself. Ask first rules are
 * split the way the engine splits them: only a brain that pauses on them gets
 * any, and the ones "Always allow" covers don't pause (except in webhook runs).
 */
export function botonCapabilities(bot: Bot, connectors: BotonConnector[], routines: Routine[], ownerName: string, brain: BrainSupport, browser: { enabled: boolean; sites: string[] } | null = null): BotonCapabilities {
  const owner = ownerName || 'you';
  const mine = connectors.filter((c) => c.state === 'yours');
  const requestable = connectors.filter((c) => c.state === 'available');
  const hooks = routines.filter((r) => r.webhook);
  const fullHooks = hooks.filter((r) => !r.webhookWorkspace);
  const callbacks = hooks.filter((r) => r.webhook?.callbackUrl);
  const summary: string[] = [];
  if (bot.access === 'host') {
    summary.push(`Full computer access: it runs as the server's user and can read and change everything that user can, including the database, every workspace, the CLI logins and the server's environment.`);
  } else {
    summary.push(`Workspace access: it works in its own folder (and the shared one) inside ${brain.serverTools ? 'its sandbox' : "the CLI's sandbox"}, and can't read other workspaces, the data folder, the CLI logins or common credential folders.`);
  }
  if (brain.serverTools) {
    summary.push(
      `Its brain is an API key (${brain.label}): Botons runs its tools itself.${bot.access === 'host' ? ' With Full computer access they run as the server’s user, outside any sandbox.' : ' Its commands and file edits run in the OS sandbox (bubblewrap, with a filter that refuses Unix sockets) with no network; where that sandbox can’t be made, its turns don’t run.'} Its \`botons\` commands reach the Botons server as the CLIs' do. Botons’ tool loop has no step that pauses for ${owner}, so Ask first rules don’t apply to it. Each request’s tokens and estimated cost are counted, and its spending caps apply.`,
    );
  }
  if (fullHooks.length) {
    summary.push(`Webhooks can start ${fullHooks.length === 1 ? `"${fullHooks[0].name}"` : `${fullHooks.length} routines`} with Full computer access, on a payload from outside.`);
  } else if (hooks.length) {
    summary.push(`Webhooks can start ${hooks.length === 1 ? `"${hooks[0].name}"` : `${hooks.length} routines`}; those runs are held to Workspace access.`);
  }
  if (callbacks.length) summary.push(`${callbacks.length === 1 ? 'One routine sends' : `${callbacks.length} routines send`} run results to a callback URL you set.`);
  if (browser?.enabled && browser.sites.length) {
    summary.push(
      `Browser: its own managed browser, reaching ${browser.sites.join(', ')}. It reads on its own (it opens and reads pages and takes screenshots) and clicks and types, but sends nothing a page would send (a form, a POST) unless you allow that exact request on a card, once; it never types passwords, codes or card numbers, signs in itself (you can sign its browser in yourself, by taking it over), downloads or uploads. No access to this computer's screen or your own browser profile. Not in webhook runs.`,
    );
  } else if (browser?.enabled) summary.push('Browser: on, but no site is listed yet, so it reaches nothing.');
  const on = mine.filter((c) => !c.off);
  const off = mine.filter((c) => c.off);
  if (on.length) summary.push(`Connectors: ${on.map((c) => c.name).join(', ')}.`);
  if (off.length) summary.push(`Turned off by ${owner}, so its turns go without ${off.length === 1 ? 'it' : 'them'} until ${off.length === 1 ? "it is" : 'they are'} on again (still granted): ${off.map((c) => c.name).join(', ')}.`);
  if (!mine.length) summary.push('No connectors.');
  if (requestable.length) {
    const now = requestable.filter((c) => c.grant === 'immediate');
    summary.push(
      `It may ask for ${requestable.map((c) => c.name).join(', ')}${now.length ? `; ${now.map((c) => c.name).join(', ')} ${now.length === 1 ? 'is' : 'are'} granted without a card (except to webhook runs)` : `; ${owner} approves each request on a card`}.`,
    );
  }
  const split = splitRules(bot.askFirst, bot.alwaysAllow, false);
  const askFirst = brain.askFirst ? { enforced: split.ask, alwaysAllowed: split.allow, inactive: [] as string[] } : { enforced: [], alwaysAllowed: [], inactive: bot.askFirst };
  if (askFirst.enforced.length) summary.push(`Asks ${owner} first before: ${askFirst.enforced.join(', ')}.`);
  if (askFirst.alwaysAllowed.length) summary.push(`Ask first rules ${owner} always allows, so they pause only webhook runs: ${askFirst.alwaysAllowed.join(', ')}.`);
  if (askFirst.inactive.length) {
    summary.push(`Not enforced: its brain (${brain.label}) doesn't pause on Ask first rules, so these saved rules do nothing until it runs on Claude Code (the local CLI): ${askFirst.inactive.join(', ')}.`);
  }
  if (bot.alwaysAllow.length) summary.push(`Always allowed without asking: ${bot.alwaysAllow.join(', ')}.`);
  summary.push(bot.skills === null ? 'Can use every skill in the library.' : bot.skills.length ? `Skills: ${bot.skills.join(', ')}.` : 'No skills.');
  summary.push(`It can message other Botons (rate limited), notify ${owner}, and ask ${owner} for approval; it can never approve its own requests or pair a device.`);
  if (bot.paused) summary.unshift('Paused: it runs nothing until resumed.');
  return {
    botId: bot.id,
    access: bot.access,
    paused: bot.paused,
    summary,
    connectors: mine.map((c) => ({ id: c.id, name: c.name, usable: c.usable, off: c.off })),
    requestable: requestable.map((c) => ({ id: c.id, name: c.name, grant: c.grant ?? 'approval' })),
    skills: bot.skills,
    askFirst,
    alwaysAllow: bot.alwaysAllow,
    routines: routines.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      schedule: r.schedule !== null,
      webhook: r.webhook !== null,
      webhookFullAccess: r.webhook !== null && !r.webhookWorkspace,
      callback: !!r.webhook?.callbackUrl,
    })),
  };
}
