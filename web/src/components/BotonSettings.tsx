import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AccessLevel, Bot, BrowserJournalEntry, BrowserStatus, BotonCapabilities, BotonLook, ProviderSwitchPreview, SpendingView, UpdateBotRequest } from '../../../shared/types.ts';
import { BROWSER_CONNECTOR } from '../../../shared/util.ts';
import { ApiError, api } from '../api.ts';
import { shownEffort } from '../effort.ts';
import { attempt, errorText, showToast } from '../feedback.ts';
import { addPending, changed, changeText, cleanSite, type LivePatch, overlay, type Pending, serial, settle, sitesSummary, toggled, undoPatch } from '../live-settings.ts';
import { answerWebAccess, suggestsWebAccess, unavailableLine, WEB_ACCESS_QUESTION, webAccessAnswered, withAnySite } from '../browser-access.ts';
import { pendingFor } from '../skills.ts';
import { actions, useStore } from '../state.ts';
import { clip, cx, isValidTimezone, relative, timezones } from '../util.ts';
import { BotonAvatar } from './Avatar.tsx';
import { EffortField } from './BotFields.tsx';
import { BotonBuilder } from './BotonBuilder.tsx';
import { BrainWarning } from './BrainWarning.tsx';
import { takeover, useTakeover } from '../takeover.ts';
import type { PanelTab } from './Chat.tsx';
import { ConnectorNotices } from './Connectors.tsx';
import { DuplicateDialog, SaveTemplateDialog } from './Copies.tsx';
import { ConfirmDialog, Dialog } from './Dialog.tsx';
import { ChevronIcon, CloseIcon, CopyIcon, EditIcon, TrashIcon } from './Icons.tsx';
import { LinkRow, More, Row, Section, Toggle, useDraft } from './SettingRows.tsx';
import { LoadError, useLoad } from './Load.tsx';
import { useSkills } from './SkillPicker.tsx';
import { SwitchDialog } from './SwitchDialog.tsx';

/** Resolves true once the change is saved (or there was none); false if it was refused or waits on a confirmation. */
type Apply = (patch: LivePatch | ((shown: Bot) => LivePatch), undo?: boolean) => Promise<boolean>;

/**
 * A Boton's settings, grouped by what the owner wants to do. Each change applies at once and offers Undo; changing to
 * Full computer access, and a move to another brain that ends a session, ask first. Deleting asks first.
 */
export function SettingsTab({ bot, onDeleted, onOpenBot, onTab }: { bot: Bot; onDeleted: () => void; onOpenBot: (id: string) => void; onTab: (t: PanelTab) => void }) {
  const providers = useStore((s) => s.providers);
  const catalog = useStore((s) => s.connectors);
  const [pending, setPending] = useState<Pending>({});
  const shown = overlay(bot, pending);
  const latest = useRef(shown);
  latest.current = shown;
  const queue = useMemo(() => serial(), []);
  const seq = useRef(0);
  // Undo in a toast runs after later renders, or after the panel closed: it uses the page as it is then.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  const applyRef = useRef<Apply>(async () => false);
  const undo = (back: LivePatch) => () => {
    if (mounted.current) return void applyRef.current(back, true);
    // Closed: a change that would ask first (Full computer, or a brain move that ends a session) waits for the page.
    if (back.access === 'host') return showToast({ kind: 'error', text: `Open ${bot.name}'s settings to give full computer access again.` }, 8000);
    void attempt('undo that', () => actions.updateBot(bot.id, back));
  };
  const [hostAsk, setHostAsk] = useState<{ patch: LivePatch; undo: boolean } | null>(null);
  const [switching, setSwitching] = useState<{ preview: ProviderSwitchPreview; patch: LivePatch; undo: boolean } | null>(null);

  useEffect(() => {
    if (!catalog) void actions.loadConnectors().catch(() => {});
  }, [catalog]);
  const names = (id: string) => (id === BROWSER_CONNECTOR ? 'Web browsing' : (catalog?.connectors.find((c) => c.id === id)?.name ?? id));

  /** Sends a change (after the ones before it) and shows it meanwhile; throws what the server said. */
  const commit = async (diff: LivePatch, isUndo: boolean, extra: Pick<UpdateBotRequest, 'switchConfirmation' | 'switchSummary'> = {}) => {
    const before = latest.current;
    const back = undoPatch(before, diff);
    const n = ++seq.current;
    setPending((p) => addPending(p, diff, n));
    try {
      await queue(() => actions.updateBot(bot.id, { ...diff, ...extra }));
    } finally {
      setPending((p) => settle(p, diff, n));
    }
    if (!isUndo) showToast({ kind: 'info', text: changeText(before, diff, names), action: { label: 'Undo', run: undo(back) } });
  };

  const save = (diff: LivePatch, undo: boolean) =>
    commit(diff, undo).then(
      () => true,
      (e) => {
        showToast({ kind: 'error', text: `Couldn't save: ${errorText(e)}` }, 8000);
        return false;
      },
    );

  const preview = (p: LivePatch) => api.switchPreview(bot.id, { provider: p.provider!, model: p.model, effort: p.effort, connections: p.connections });

  const moveBrain = async (diff: LivePatch, undo: boolean) => {
    try {
      const pre = await preview(diff);
      if (pre.required) return setSwitching({ preview: pre, patch: diff, undo });
      try {
        await commit(diff, undo);
      } catch (e) {
        // Something changed since the preview (a turn started, say), and the move now ends a session: show it.
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        const again = await preview(diff);
        if (!again.required) throw e;
        setSwitching({ preview: again, patch: diff, undo });
      }
    } catch (e) {
      showToast({ kind: 'error', text: `Couldn't change the brain: ${errorText(e)}` }, 8000);
    }
  };

  const apply: Apply = async (patch, undo = false) => {
    const diff = changed(latest.current, typeof patch === 'function' ? patch(latest.current) : patch);
    if (!Object.keys(diff).length) return true;
    if (diff.access === 'host') {
      setHostAsk({ patch: diff, undo });
      return false;
    }
    if (diff.provider !== undefined) {
      await moveBrain(diff, undo);
      return false;
    }
    return save(diff, undo);
  };
  applyRef.current = apply;

  /**
   * Web browsing off: the kill switch. It goes in the queue like any change, so a change made before it (turning it
   * on, say) can't be saved after it and turn it back on; later changes start from it off.
   */
  const stopBrowsing = async () => {
    const diff: LivePatch = { connections: toggled(latest.current.connections, BROWSER_CONNECTOR, false) };
    const n = ++seq.current;
    setPending((p) => addPending(p, diff, n));
    try {
      return await queue(() => api.stopBrowser(bot.id));
    } finally {
      setPending((p) => settle(p, diff, n));
    }
  };

  const confirmSwitch = async (summary: boolean) => {
    if (!switching) return;
    try {
      const confirmation = summary ? switching.preview.summary.confirmation : switching.preview.confirmation;
      await commit(switching.patch, switching.undo, { switchConfirmation: confirmation ?? undefined, ...(summary ? { switchSummary: true } : {}) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setSwitching({ ...switching, preview: await preview(switching.patch) });
      throw e;
    }
  };

  const routines = useStore((s) => s.routines[bot.id]);
  useEffect(() => {
    if (!routines) void actions.loadRoutines(bot.id).catch(() => {});
  }, [bot.id, !routines]);
  const brain = providers.find((p) => p.id === shown.provider);
  const usable = catalog?.connectors.filter((c) => c.providers.includes(shown.provider)) ?? [];
  const browserUsable = usable.some((c) => c.id === BROWSER_CONNECTOR);

  return (
    <div className="tab-body boton-settings">
      <Section title="Identity">
        <IdentityRows bot={shown} apply={apply} />
      </Section>

      <Section title="Brain">
        <BrainRows bot={shown} apply={apply} />
        <BrainWarning providers={providers} provider={shown.provider} />
        <More label="Advanced">
          <EffortField
            provider={brain}
            model={shown.model}
            value={shownEffort(brain, shown.model, shown.effort)}
            onChange={(effort) => apply({ effort })}
          />
        </More>
      </Section>

      <Section title="What it can do">
        <AccessRow bot={shown} problem={brain?.workspaceProblem} apply={apply} />
        <WebBrowsing bot={bot} shown={shown} apply={apply} stop={stopBrowsing} brainCan={!catalog || browserUsable} />
        <ConnectorRows bot={bot} shown={shown} apply={apply} browserUsable={!catalog || browserUsable} />
        <SkillRows shown={shown} apply={apply} />
        <More label="Advanced">
          <AskFirstField bot={shown} apply={apply} askFirst={!!brain?.askFirst} />
          <AlwaysAllowed bot={shown} apply={apply} />
          <Capabilities bot={bot} />
          <p className="set-help">
            Its folder: <code>{bot.workspace}</code>
          </p>
        </More>
      </Section>

      <Section title="Schedule and routines">
        <TimezoneRow bot={shown} apply={apply} />
        <LinkRow label="Routines" value={routinesText(routines)} onClick={() => onTab('routines')} />
      </Section>

      <Section title="Usage and spending">
        <LinkRow label="Usage" value="Tokens and runs" onClick={() => onTab('usage')} />
        <Spending bot={bot} apiBrain={brain?.kind === 'api' && bot.provider !== 'mock'} />
      </Section>

      <Section title="Manage">
        <ManageRows bot={bot} onDeleted={onDeleted} onOpenBot={onOpenBot} />
      </Section>

      {hostAsk && (
        <ConfirmDialog
          title={`Give ${bot.name} full computer access?`}
          confirmLabel="Give full access"
          what="give full computer access"
          danger
          onConfirm={() => commit(hostAsk.patch, hostAsk.undo)}
          onClose={() => setHostAsk(null)}
        >
          <p>It will run commands as the server's user: it can read and change any file that user can, your keys and logins included.</p>
        </ConfirmDialog>
      )}
      {switching && <SwitchDialog name={bot.name} preview={switching.preview} onConfirm={confirmSwitch} onClose={() => setSwitching(null)} />}
    </div>
  );
}

const routinesText = (list: { enabled: boolean }[] | undefined) => {
  if (!list) return 'Open';
  if (!list.length) return 'None yet';
  const on = list.filter((r) => r.enabled).length;
  return `${list.length} routine${list.length === 1 ? '' : 's'}${on < list.length ? `, ${on} on` : ''}`;
};

// ——— Identity

function IdentityRows({ bot, apply }: { bot: Bot; apply: Apply }) {
  const id = useId();
  const [looking, setLooking] = useState(false);
  const name = useDraft(bot.name, (v) => apply({ name: v.trim() }), (v) => !!v.trim());
  const title = useDraft(bot.title, (v) => apply({ title: v.trim() }));
  const instructions = useDraft(bot.instructions, (v) => apply({ instructions: v }));
  const layoutGroups = useStore((s) => s.sidebar?.groups);
  const groups = layoutGroups?.map((g) => ({ id: g.id, name: g.name })) ?? (bot.groupId ? [{ id: bot.groupId, name: bot.group }] : []);
  return (
    <>
      <div className="set-identity">
        <button type="button" className="set-avatar" aria-label="Change look" title="Change look" onClick={() => setLooking(true)}>
          <BotonAvatar look={bot.look} size={64} still />
          <span className="set-avatar-edit" aria-hidden>
            <EditIcon size={12} />
          </span>
        </button>
        <div className="set-identity-fields">
          <input aria-label="Name" className="set-name" maxLength={60} required {...name} />
          <input aria-label="Role" placeholder="Role, e.g. Inbox triage" maxLength={80} {...title} />
        </div>
      </div>
      <div className="set-row set-stack">
        <label className="set-label" htmlFor={`${id}-i`}>
          Personality and instructions
        </label>
        <textarea id={`${id}-i`} rows={4} placeholder="What it owns, how you like the work done, and what it should never do." {...instructions} />
      </div>
      <Row
        label="Group"
        htmlFor={`${id}-g`}
        control={
          <select id={`${id}-g`} value={bot.groupId ?? ''} onChange={(e) => apply({ groupId: e.target.value || null })}>
            <option value="">None</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        }
      />
      <Row label="Pin to the top" control={<Toggle label="Pin to the top" on={bot.pinned} onChange={(pinned) => apply({ pinned })} />} />
      {looking && <LookDialog look={bot.look} name={bot.name} onSave={(look) => apply({ look })} onClose={() => setLooking(false)} />}
    </>
  );
}

function LookDialog({ look, name, onSave, onClose }: { look: BotonLook; name: string; onSave: (l: BotonLook) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(look);
  return (
    <Dialog title={`${name}'s look`} onClose={onClose} wide>
      <BotonBuilder look={draft} onChange={setDraft} />
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          data-autofocus
          onClick={() => {
            onSave(draft);
            onClose();
          }}
        >
          Done
        </button>
      </div>
    </Dialog>
  );
}

// ——— Brain

function BrainRows({ bot, apply }: { bot: Bot; apply: Apply }) {
  const id = useId();
  const providers = useStore((s) => s.providers);
  const current = providers.find((p) => p.id === bot.provider);
  const known = !bot.model.trim() || (current?.models.some((m) => m.id === bot.model) ?? false);
  const [custom, setCustom] = useState(!known);
  const model = useDraft(bot.model.trim(), (v) => apply({ model: v.trim() }));
  return (
    <>
      <Row
        label="Brain"
        htmlFor={`${id}-p`}
        control={
          <select
            id={`${id}-p`}
            value={bot.provider}
            onChange={(e) => {
              const next = providers.find((p) => p.id === e.target.value);
              setCustom(false);
              apply({ provider: e.target.value, model: next?.defaultModel ?? '' });
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.available ? '' : ' (not set up)'}
              </option>
            ))}
          </select>
        }
      />
      {!current?.models.length ? (
        <Row label="Model" htmlFor={`${id}-m`}>
          <input id={`${id}-m`} className="set-wide" placeholder="Its default" {...model} />
        </Row>
      ) : (
      <Row
        label="Model"
        htmlFor={`${id}-m`}
        control={
          <select
            id={`${id}-m`}
            value={known && !custom ? bot.model : '__custom'}
            onChange={(e) => {
              if (e.target.value === '__custom') return setCustom(true);
              setCustom(false);
              apply({ model: e.target.value });
            }}
          >
            {!bot.model.trim() && !current?.models.some((m) => !m.id) && <option value="">Default</option>}
            {current?.models.map((m) => (
              <option key={m.id || '__default'} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value="__custom">Other…</option>
          </select>
        }
      >
        {(custom || !known) && <input className="set-wide" aria-label="Model id" placeholder="Model id, e.g. claude-opus-5-5" {...model} />}
      </Row>
      )}
    </>
  );
}

// ——— What it can do

function AccessRow({ bot, problem, apply }: { bot: Bot; problem?: string | null; apply: Apply }) {
  const set = (access: AccessLevel) => apply({ access });
  return (
    <Row
      label="Computer access"
      help={bot.access === 'workspace' ? "Changes only its own folder. Can't see your keys or logins." : 'Runs commands as the server user.'}
    >
      <div className="segmented set-wide" role="radiogroup" aria-label="Computer access">
        <button type="button" role="radio" aria-checked={bot.access === 'workspace'} className={cx(bot.access === 'workspace' && 'on')} disabled={!!problem && bot.access !== 'workspace'} onClick={() => set('workspace')}>
          Workspace
        </button>
        <button type="button" role="radio" aria-checked={bot.access === 'host'} className={cx(bot.access === 'host' && 'on')} onClick={() => set('host')}>
          Full computer
        </button>
      </div>
      {problem && (
        <More label="Why isn't Workspace available?">
          <p className="set-help">{problem}</p>
        </More>
      )}
    </Row>
  );
}

/**
 * The Boton's managed browser in one row: on or off, the sites it may read, and the owner's sign-in. Off is the kill
 * switch (it closes the browser now). The server checks every value; the rules are under Details.
 */
function WebBrowsing({ bot, shown, apply, stop, brainCan }: { bot: Bot; shown: Bot; apply: Apply; stop: () => Promise<BrowserStatus>; brainCan: boolean }) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  // The live view over everything: when it closes, how the browser stands now.
  const viewing = useTakeover() === bot.id;
  useEffect(() => {
    if (!viewing) void api.browser(bot.id).then(setStatus, () => {});
  }, [viewing, bot.id]);
  const [journal, setJournal] = useState<BrowserJournalEntry[] | null>(null);
  const { error, retry } = useLoad(() => api.browser(bot.id).then(setStatus), `${bot.id}:${bot.access}:${bot.connections.join(',')}`);
  // Kept for a brain that can't use it (it comes back on a brain that can), but off here.
  const on = shown.connections.includes(BROWSER_CONNECTOR) && brainCan && status?.available !== false;
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    const ok = await attempt(what, fn);
    setBusy(false);
    return ok;
  };
  const turn = async (next: boolean) => {
    if (next) return apply((s) => ({ connections: toggled(s.connections, BROWSER_CONNECTOR, true) }));
    if (await run('turn web browsing off', async () => setStatus(await stop())))
      showToast({ kind: 'info', text: 'Web browsing off', action: { label: 'Undo', run: () => apply((s) => ({ connections: toggled(s.connections, BROWSER_CONNECTOR, true) }), true) } });
  };
  const signIn = () => takeover.open(bot.id);
  // Once per Boton on this device: an existing Boton whose browser doesn't reach every public site is offered it.
  const [answered, setAnswered] = useState(() => webAccessAnswered(bot.id));
  const answer = () => {
    answerWebAccess(bot.id);
    setAnswered(true);
  };
  const turnOnWeb = () =>
    run('turn on web access', async () => {
      const next = status && withAnySite(status.policy.sites);
      if (!next) return;
      setStatus(await api.setBrowser(bot.id, { sites: next }));
      // Answered only once it is on: a refused change leaves the question for next time.
      if (await apply((s) => ({ connections: toggled(s.connections, BROWSER_CONNECTOR, true) }))) answer();
    });
  const p = status?.policy;
  const available = status?.available ?? true;
  const handover = status?.handover;
  return (
    <Row
      label="Web browsing"
      help={!available ? unavailableLine(status?.why ?? null) : !brainCan && !on ? 'Not available with this brain.' : on ? 'Asks you before submitting anything.' : 'Lets it read websites for you.'}
      control={<Toggle label="Web browsing" on={on} disabled={busy || (!on && (!available || !brainCan))} onChange={(v) => void turn(v)} />}
    >
      {error && <LoadError what="web browsing" error={error} onRetry={retry} />}
      {status && suggestsWebAccess(status, brainCan, answered) && (
        <div className="browser-suggestion" role="group" aria-label="Suggestion">
          <span>{WEB_ACCESS_QUESTION}</span>
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void turnOnWeb()}>
            Turn on
          </button>
          <button type="button" className="btn small ghost" disabled={busy} onClick={answer}>
            Not now
          </button>
        </div>
      )}
      {on && status && p && available && (
        <div className="set-actions">
          <button type="button" className="chip-btn" onClick={() => setEditing(true)}>
            {sitesSummary(p.sites)} <ChevronIcon size={12} />
          </button>
          {!handover && p.sites.length > 0 && (
            <button type="button" className="link-btn" disabled={busy} onClick={signIn}>
              Open its browser…
            </button>
          )}
          {handover?.byThisDevice && (
            <button type="button" className="link-btn" onClick={signIn}>
              Back to its browser
            </button>
          )}
          {handover && !handover.byThisDevice && (
            <span className="set-help">
              {handover.deviceLabel} has its browser.{' '}
              <button type="button" className="link-btn" disabled={busy} onClick={() => void run('end the sign-in', async () => setStatus(await api.finishHandover(bot.id, handover.id)))}>
                End it
              </button>
            </span>
          )}
        </div>
      )}
      {status?.available && brainCan && (
        <More label="Details" onOpen={() => void api.browserJournal(bot.id).then(setJournal, () => setJournal([]))}>
          <ul className="set-help set-bullets">
            <li>Opens and reads pages on its sites.</li>
            <li>Clicks and types, never into password, code or card fields.</li>
            <li>Anything it submits on a page waits for your OK.</li>
            <li>Never signs in itself: it asks you in the chat to take over.</li>
            <li>No downloads or uploads, and off in runs a webhook starts.</li>
          </ul>
          {status.available && !status.sandbox && <p className="set-help">Chromium's own sandbox is off on this server (BOTONS_BROWSER_SANDBOX=0).</p>}
          {journal && journal.length > 0 && <span className="set-label">Recent steps</span>}
          {journal && journal.length > 0 && (
            <ul className="browser-journal">
              {journal
                .slice(-30)
                .reverse()
                .map((j, i) => (
                  <li key={`${j.at}-${i}`}>
                    <span className="hint">{relative(j.at)}</span> {j.action}
                    {j.url && <code>{clip(j.url, 80)}</code>} {j.outcome !== 'done' && <strong>{j.outcome}</strong>} <span className="hint">{clip(j.detail, 160)}</span>
                  </li>
                ))}
            </ul>
          )}
        </More>
      )}
      {editing && status && <SitesDialog bot={shown} status={status} onStatus={setStatus} onClose={() => setEditing(false)} />}
    </Row>
  );
}

/** The sites the browser may read: chips, and a switch for every public site (a Full computer Boton only). */
function SitesDialog({ bot, status, onStatus, onClose }: { bot: Bot; status: BrowserStatus; onStatus: (s: BrowserStatus) => void; onClose: () => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sites = status.policy.sites;
  const any = sites.includes('*');
  const named = sites.filter((s) => s !== '*');
  // "*" takes the place of the names it covers, so it fits a full list (withAnySite); null when even that doesn't.
  const withAny = withAnySite(sites);
  const save = async (next: string[], undoable?: { text: string; back: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      onStatus(await api.setBrowser(bot.id, { sites: next }));
      if (undoable) showToast({ kind: 'info', text: undoable.text, action: { label: 'Undo', run: () => attempt('put the sites back', async () => onStatus(await api.setBrowser(bot.id, { sites: undoable.back }))) } });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const site = cleanSite(text);
    if (!site) return;
    if (sites.includes(site)) return setText('');
    if (await save([...sites, site], { text: `Added ${site}`, back: sites })) setText('');
  };
  return (
    <Dialog title={`Sites ${bot.name} can read`} onClose={onClose}>
      <div className="set-card">
        <Row
          label="All public sites"
          help={any || withAny ? 'Any site on the internet; never this computer or your network.' : 'The list is full: remove an address with a port first.'}
          control={<Toggle label="All public sites" on={any} disabled={busy || (!any && !withAny)} onChange={(v) => void (v ? withAny && save(withAny, { text: 'All public sites on', back: sites }) : save(named, { text: 'All public sites off', back: sites }))} />}
        />
      </div>
      {named.length > 0 && (
        <ul className="chip-list" aria-label="Sites">
          {named.map((s) => (
            <li key={s} className="template-chip">
              <span>{s}</span>
              <button type="button" className="template-remove" aria-label={`Remove ${s}`} disabled={busy} onClick={() => void save(sites.filter((x) => x !== s), { text: `Removed ${s}`, back: sites })}>
                <CloseIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="memory-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input id={`${id}-add`} value={text} onChange={(e) => setText(e.target.value)} placeholder="example.com" aria-label="Add a site" autoComplete="off" spellCheck={false} autoCapitalize="none" inputMode="url" data-autofocus />
        <button className="btn small" type="submit" disabled={busy || !cleanSite(text)}>
          Add
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <p className="set-help">A site covers its subdomains. Use host:port for this computer or your network.</p>
      <div className="form-actions">
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}

/** Each service the owner connected in Settings, with a switch. Problems show in one line; nothing about MCP. */
function ConnectorRows({ bot, shown, apply, browserUsable }: { bot: Bot; shown: Bot; apply: Apply; browserUsable: boolean }) {
  const catalog = useStore((s) => s.connectors);
  if (!catalog) return null;
  const usable = catalog.connectors.filter((c) => c.providers.includes(shown.provider) && !c.managed);
  const missing = shown.connections.filter((id) => id !== BROWSER_CONNECTOR && !catalog.connectors.some((c) => c.id === id && c.providers.includes(shown.provider)));
  const turn = (id: string, on: boolean) => apply((s) => ({ connections: toggled(s.connections, id, on) }));
  return (
    <>
      <ConnectorNotices botId={bot.id} value={shown.connections} onChange={(ids) => apply({ connections: ids })} skip={browserUsable ? [] : [BROWSER_CONNECTOR]} />
      {usable.map((c) => {
        const on = shown.connections.includes(c.id);
        const problem = !c.enabled
          ? 'Turned off in Settings → Connectors.'
          : c.status === 'needs-auth'
            ? 'Needs sign-in in Settings → Connectors.'
            : c.lastTest?.outcome === 'failed'
              ? `Last test failed: ${clip(c.lastTest.problem ?? '', 80)}`
              : null;
        return <Row key={c.id} label={c.name} help={problem && <span className="warn">{problem}</span>} control={<Toggle label={c.name} on={on} onChange={(v) => turn(c.id, v)} />} />;
      })}
      {missing.map((id) => (
        <Row key={id} label={id} help="Not found any more: its turns go without it." control={<Toggle label={id} on onChange={() => turn(id, false)} />} />
      ))}
      {!usable.length && !missing.length && <Row label="Connected services" help="None yet. Add Slack, GitHub and more in Settings → Connectors." />}
    </>
  );
}

function SkillRows({ shown, apply }: { shown: Bot; apply: Apply }) {
  const id = useId();
  const { skills, error } = useSkills();
  const value = shown.skills;
  const list = value ?? [];
  const missing = list.filter((n) => skills && !skills.some((s) => s.name === n));
  if (skills && !skills.length && value === null) return null;
  return (
    <Row
      label="Skills"
      htmlFor={`${id}-s`}
      control={
        <select id={`${id}-s`} value={value === null ? 'all' : 'some'} onChange={(e) => apply({ skills: e.target.value === 'all' ? null : (skills?.map((s) => s.name) ?? []) })}>
          <option value="all">All skills</option>
          <option value="some">Only some</option>
        </select>
      }
    >
      {error && <p className="form-error">{error}</p>}
      {value !== null && (
        <div className="set-sublist">
          {skills?.map((s) => (
            <Row
              key={s.name}
              label={s.name}
              help={pendingFor(s) ? `Waiting for your approval` : clip(s.description, 90)}
              control={<Toggle label={s.name} on={list.includes(s.name)} onChange={(v) => apply((b) => ({ skills: toggled(b.skills ?? [], s.name, v) }))} />}
            />
          ))}
          {missing.map((n) => (
            <Row key={n} label={n} help="Not in the library any more." control={<Toggle label={n} on onChange={() => apply((b) => ({ skills: toggled(b.skills ?? [], n, false) }))} />} />
          ))}
        </div>
      )}
    </Row>
  );
}

const rulesOf = (text: string) => [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];

function AskFirstField({ bot, apply, askFirst }: { bot: Bot; apply: Apply; askFirst: boolean }) {
  const id = useId();
  const rules = useDraft(bot.askFirst.join('\n'), (v) => apply({ askFirst: rulesOf(v) }));
  return (
    <div className="set-row set-stack">
      <label className="set-label" htmlFor={id}>
        Ask me first
      </label>
      <span className="set-help">{askFirst ? 'Claude Code permission rules, one per line. A matching step waits for your OK.' : 'Only a Claude brain uses these rules.'}</span>
      <textarea id={id} className="rules-input" rows={Math.min(Math.max(bot.askFirst.length + 1, 2), 8)} spellCheck={false} placeholder={'Bash(git push:*)\nmcp__slack__send_message'} {...rules} />
    </div>
  );
}

function AlwaysAllowed({ bot, apply }: { bot: Bot; apply: Apply }) {
  if (!bot.alwaysAllow.length) return null;
  return (
    <div className="set-row set-stack">
      <span className="set-label">Always allowed</span>
      <span className="set-help">Done without asking, except in webhook runs. Remove one to be asked again.</span>
      <ul className="chip-list">
        {bot.alwaysAllow.map((a) => (
          <li key={a} className="template-chip always-chip">
            <code>{a}</code>
            <button type="button" className="template-remove" aria-label={`Ask again before “${a}”`} title="Ask me again" onClick={() => apply((b) => ({ alwaysAllow: b.alwaysAllow.filter((x) => x !== a) }))}>
              <CloseIcon size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the saved settings let this Boton do, worded by the server from what it enforces. */
function Capabilities({ bot }: { bot: Bot }) {
  const [caps, setCaps] = useState<BotonCapabilities | null>(null);
  const { error, retry } = useLoad(() => api.capabilities(bot.id).then(setCaps), `${bot.id}:${bot.updatedAt}`);
  return (
    <div className="set-row set-stack capabilities">
      <span className="set-label">What {bot.name} can do now</span>
      {error && <LoadError what="what it can do" error={error} onRetry={retry} />}
      {caps && (
        <ul>
          {caps.summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ——— Schedule

function TimezoneRow({ bot, apply }: { bot: Bot; apply: Apply }) {
  const id = useId();
  const zones = useMemo(() => timezones().map((z) => <option key={z} value={z} />), []);
  const tz = useDraft(bot.timezone, (v) => apply({ timezone: v.trim() }), (v) => isValidTimezone(v.trim()));
  const bad = !isValidTimezone(tz.value.trim());
  return (
    <Row label="Timezone" htmlFor={id} help={bad ? <span className="field-error">Not a timezone; it goes back when you leave the field.</span> : 'For its schedules and times.'}>
      <input id={id} className="set-wide" list={`${id}-zones`} autoComplete="off" spellCheck={false} aria-invalid={bad} {...tz} />
      <datalist id={`${id}-zones`}>{zones}</datalist>
    </Row>
  );
}

// ——— Usage and spending

const usd = (v: number) => `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
/** A cap as typed: "" is no cap; anything else must be dollars. */
const capOf = (text: string): number | null | undefined => {
  const t = text.trim().replace(/^\$/, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const capText = (v: number | null) => (v === null ? '' : String(v));

/** Spending caps on its API-key turns, each saved when the owner leaves the field. Hidden on a CLI brain with no cap. */
function Spending({ bot, apiBrain }: { bot: Bot; apiBrain: boolean }) {
  const [view, setView] = useState<SpendingView | null>(null);
  const { error, retry } = useLoad(() => api.spending(bot.id).then(setView), `${bot.id}:${bot.updatedAt}`);
  if (error) return <LoadError what="its spending" error={error} onRetry={retry} />;
  if (!view) return null;
  const anyCap = view.dailyCapUsd !== null || view.routines.some((r) => r.perRunCapUsd !== null);
  if (!apiBrain && !anyCap) return null;
  const set = async (input: { dailyCapUsd?: number | null; routines?: Record<string, number | null> }, back: typeof input) => {
    const ok = await attempt('save the cap', async () => setView(await api.setSpending(bot.id, input)));
    if (ok) showToast({ kind: 'info', text: 'Cap saved', action: { label: 'Undo', run: () => attempt('put the cap back', async () => setView(await api.setSpending(bot.id, back))) } });
  };
  return (
    <div className="spending">
      <CapRow
        name="spending-daily"
        label="Daily spending cap"
        help={`${apiBrain ? '' : 'For when it runs on an API key. '}Today: about ${usd(view.spentTodayUsd)}${view.unpricedToday ? ` + ${view.unpricedToday} unpriced` : ''}.`}
        value={view.dailyCapUsd}
        onSave={(v) => void set({ dailyCapUsd: v }, { dailyCapUsd: view.dailyCapUsd })}
      />
      <More label={view.routines.length ? 'Caps per routine run' : 'How caps work'}>
        {view.routines.map((r) => (
          <CapRow
            key={r.id}
            name={`spending-routine-${r.id}`}
            label={r.name}
            value={r.perRunCapUsd}
            onSave={(v) => void set({ routines: { [r.id]: v } }, { routines: { [r.id]: r.perRunCapUsd } })}
          />
        ))}
        <p className="set-help">{view.rules}</p>
      </More>
    </div>
  );
}

function CapRow({ name, label, help, value, onSave }: { name: string; label: string; help?: string; value: number | null; onSave: (v: number | null) => void }) {
  const id = useId();
  const field = useDraft(capText(value), (t) => onSave(capOf(t) as number | null), (t) => capOf(t) !== undefined);
  const bad = capOf(field.value) === undefined;
  return (
    <Row
      label={label}
      htmlFor={id}
      help={bad ? <span className="field-error">Dollars, or empty for no cap.</span> : help}
      control={
        <span className="cap-input">
          <span aria-hidden>$</span>
          <input id={id} name={name} inputMode="decimal" placeholder="No cap" aria-invalid={bad} {...field} />
        </span>
      }
    />
  );
}

// ——— Manage

function ManageRows({ bot, onDeleted, onOpenBot }: { bot: Bot; onDeleted: () => void; onOpenBot: (id: string) => void }) {
  const primary = useStore((s) => s.settings?.primaryBotId ?? null);
  const isPrimary = primary === bot.id;
  const [confirming, setConfirming] = useState<'reset' | 'delete' | 'duplicate' | 'template' | null>(null);
  const setPrimary = (on: boolean, undo = false) =>
    void attempt(on ? `make ${bot.name} primary` : `stop ${bot.name} being primary`, async () => {
      const before = primary;
      await actions.updateSettings({ primaryBotId: on ? bot.id : null });
      if (!undo) showToast({ kind: 'info', text: on ? `${bot.name} is your primary Boton` : `${bot.name} is no longer primary`, action: { label: 'Undo', run: () => void attempt('undo that', () => actions.updateSettings({ primaryBotId: before })) } });
    });
  const pause = (paused: boolean, undo = false) =>
    void attempt(paused ? `pause ${bot.name}` : `resume ${bot.name}`, async () => {
      await actions.pauseBot(bot.id, paused);
      if (!undo) showToast({ kind: 'info', text: paused ? `${bot.name} paused` : `${bot.name} resumed`, action: { label: 'Undo', run: () => pause(!paused, true) } });
    });
  return (
    <>
      <Row label="Primary Boton" help="Opens first and can hand work to the others." control={<Toggle label="Primary Boton" on={isPrimary} onChange={(v) => setPrimary(v)} />} />
      <Row
        label="Paused"
        help={bot.paused ? 'Nothing runs; messages wait until you resume.' : 'Stops everything it is doing until you resume.'}
        control={<Toggle label="Paused" on={bot.paused} onChange={(v) => pause(v)} />}
      />
      <Row
        label="Copies"
        control={
          <span className="set-buttons nowrap">
            <button type="button" className="btn small" onClick={() => setConfirming('duplicate')}>
              <CopyIcon size={14} /> Duplicate
            </button>
            <button type="button" className="btn small" onClick={() => setConfirming('template')}>
              Template
            </button>
          </span>
        }
      />
      <Row
        label="Start fresh"
        help="Forgets this chat's context. Memories and routines stay."
        control={
          <button type="button" className="btn small" onClick={() => setConfirming('reset')}>
            Start fresh
          </button>
        }
      />
      <Row
        label={`Delete ${bot.name}`}
        control={
          <button type="button" className="btn small danger" onClick={() => setConfirming('delete')}>
            <TrashIcon size={14} /> Delete
          </button>
        }
      />
      {confirming === 'duplicate' && <DuplicateDialog bot={bot} onClose={() => setConfirming(null)} onCreated={(copy) => onOpenBot(copy.id)} />}
      {confirming === 'template' && <SaveTemplateDialog bot={bot} onClose={() => setConfirming(null)} />}
      {confirming === 'reset' && (
        <ConfirmDialog title={`Start a fresh conversation with ${bot.name}?`} confirmLabel="Start fresh" what="start a fresh conversation" onConfirm={() => api.resetBot(bot.id)} onClose={() => setConfirming(null)}>
          <p>{bot.name} forgets the context of this chat and starts a new session. The messages stay visible here, and its memories and routines are kept.</p>
        </ConfirmDialog>
      )}
      {confirming === 'delete' && (
        <ConfirmDialog
          title={`Delete ${bot.name}?`}
          confirmLabel={`Delete ${bot.name}`}
          what={`delete ${bot.name}`}
          danger
          onConfirm={async () => {
            await actions.deleteBot(bot.id);
            onDeleted();
          }}
          onClose={() => setConfirming(null)}
        >
          <p>
            This deletes {bot.name}'s chat, routines, run history and memories, and stops anything it is doing. Its webhooks stop working: callers will get 401.
            This can't be undone.
          </p>
          <p className="hint">
            The workspace folder stays on disk: <code>{bot.workspace}</code>
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
