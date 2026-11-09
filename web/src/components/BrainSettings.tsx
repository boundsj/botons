import { useEffect, useId, useRef, useState } from 'react';
import type { ApiKeyState, Bot, ProviderInfo, SpendingView } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { BRAIN_ROWS, brainSetUp, brainUsers, brainView, loginCommand, signInFinished, usd, usedByText } from '../brains.ts';
import { actions, useStore } from '../state.ts';
import { cx, relative } from '../util.ts';
import { OUTCOME, sourceText } from './ApiKeys.tsx';
import { BrainCliActions } from './BrainCliActions.tsx';
import { Copy } from './Brains.tsx';
import { CheckAgain, withCode } from './BrainWarning.tsx';
import { ChevronIcon } from './Icons.tsx';
import { useActiveRef } from './PageActive.ts';

/** A row's own message: what the owner just did to that brain, and only there. */
type Note = { text: string; ok: boolean } | null;
type SetNote = (note: Note) => void;
type Homes = { codex: boolean; claude: boolean };

interface Brain {
  id: string;
  name: string;
  blurb: string;
  p: ProviderInfo | undefined;
  /** For an API key brain: its key (undefined until loaded). */
  k: ApiKeyState | undefined;
  apiKey: boolean;
  users: Bot[];
  setUp: boolean;
}

/** A success message goes by itself after this; an error stays until the next try. */
const NOTE_MS = 8000;
const SPEND_MS = 30_000;

/**
 * Settings → Brains: the brains set up on this server (ready or not, which Botons use each, today's API spending), and
 * the ones to add. Each row opens to its own sign-in or key controls. Adding a brain moves no Boton: each picks its own.
 */
export function BrainSettings({ onOpenBot, onPage }: { onOpenBot?: (id: string) => void; onPage?: (page: 'api-keys') => void }) {
  const providers = useStore((s) => s.providers);
  const bots = useStore((s) => s.bots);
  const keys = useStore((s) => s.apiKeys);
  const container = useStore((s) => s.setup?.exposure.container ?? false);
  const [open, setOpen] = useState<string[]>([]);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [homes, setHomes] = useState<Homes>({ codex: false, claude: false });
  const [spend, setSpend] = useState<Record<string, SpendingView>>({});
  const active = useActiveRef();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const note = (id: string, next: Note) => {
    clearTimeout(timers.current.get(id));
    setNotes((all) => ({ ...all, [id]: next }));
    if (next?.ok)
      timers.current.set(
        id,
        setTimeout(() => setNotes((all) => (all[id] === next ? { ...all, [id]: null } : all)), NOTE_MS),
      );
  };
  const toggle = (id: string) => {
    if (open.includes(id)) {
      setOpen(open.filter((o) => o !== id));
      note(id, null);
    } else setOpen([...open, id]);
  };
  const refreshHomes = () =>
    api
      .brainHomes()
      .then(setHomes)
      .catch(() => {});

  useEffect(() => {
    let live = true;
    const refresh = () => {
      void actions.loadProviders(true).catch(() => {});
      void api
        .brainHomes()
        .then((h) => live && setHomes(h))
        .catch(() => {});
    };
    void actions.loadApiKeys().catch(() => {});
    refresh();
    const timer = setInterval(() => active.current && refresh(), 5000);
    const all = timers.current;
    return () => {
      live = false;
      clearInterval(timer);
      for (const t of all.values()) clearTimeout(t);
    };
  }, []);

  // Today's spending, for the Botons on an API key.
  const onKeys = bots.filter((b) => BRAIN_ROWS.some((r) => r.key && r.id === b.provider)).map((b) => b.id);
  const spendKey = onKeys.join(',');
  useEffect(() => {
    if (!onKeys.length) return;
    let live = true;
    const load = () =>
      void Promise.allSettled(onKeys.map((id) => api.spending(id))).then((all) => {
        if (!live) return;
        const next: Record<string, SpendingView> = {};
        for (const r of all) if (r.status === 'fulfilled') next[r.value.botId] = r.value;
        setSpend(next);
      });
    load();
    const timer = setInterval(() => active.current && load(), SPEND_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [spendKey]);

  // A CLI that comes to be signed in says so on its own row.
  const was = useRef(new Map<string, boolean>());
  useEffect(() => {
    for (const p of providers) {
      if (p.kind !== 'cli') continue;
      const setUp = brainSetUp(p, undefined);
      if (was.current.get(p.id) === false && setUp && p.readiness.state === 'ready') note(p.id, { ok: true, text: '✓ Signed in.' });
      was.current.set(p.id, setUp);
    }
  }, [providers]);

  if (!providers.length) return <p className="hint">Checking brains…</p>;

  const brains: Brain[] = BRAIN_ROWS.map((r) => {
    const p = providers.find((x) => x.id === r.id);
    const k = r.key ? keys?.providers.find((x) => x.provider === r.key) : undefined;
    return {
      id: r.id,
      name: r.name,
      blurb: r.blurb,
      p,
      k,
      apiKey: !!r.key,
      users: brainUsers(r.id, bots),
      setUp: brainSetUp(p, k),
    };
  });
  // Any other brain the server has (the mock one in development) is listed only once it is ready or in use.
  for (const p of providers) {
    if (BRAIN_ROWS.some((r) => r.id === p.id)) continue;
    const users = brainUsers(p.id, bots);
    if (p.readiness.state === 'ready' || users.length)
      brains.push({
        id: p.id,
        name: p.label,
        blurb: '',
        p,
        k: undefined,
        apiKey: false,
        users,
        setUp: true,
      });
  }
  const mine = brains.filter((b) => b.setUp || b.users.length);
  const rest = brains.filter((b) => !mine.includes(b));

  const row = (b: Brain, adding: boolean) => (
    <BrainRow
      key={b.id}
      b={b}
      adding={adding}
      open={open.includes(b.id)}
      onToggle={() => toggle(b.id)}
      note={notes[b.id] ?? null}
      setNote={(n) => note(b.id, n)}
      homes={homes}
      refreshHomes={refreshHomes}
      container={container}
      spend={spend}
      onOpenBot={onOpenBot}
      onPage={onPage}
    />
  );
  return (
    <div className="brains brain-settings">
      <p className="hint">Each Boton picks its brain in its own settings. Adding a brain doesn't change existing Botons.</p>
      <h4>Your brains</h4>
      {mine.length ? <ul className="brain-list">{mine.map((b) => row(b, false))}</ul> : <p className="hint">None yet. Add one below.</p>}
      {rest.length > 0 && (
        <>
          <h4>Add a brain</h4>
          <ul className="brain-list">{rest.map((b) => row(b, true))}</ul>
        </>
      )}
    </div>
  );
}

interface RowProps {
  b: Brain;
  adding: boolean;
  open: boolean;
  onToggle: () => void;
  note: Note;
  setNote: SetNote;
  homes: Homes;
  refreshHomes: () => Promise<void>;
  container: boolean;
  spend: Record<string, SpendingView>;
  onOpenBot?: (id: string) => void;
  onPage?: (page: 'api-keys') => void;
}

function BrainRow({ b, adding, open, onToggle, note, setNote, homes, refreshHomes, container, spend, onOpenBot, onPage }: RowProps) {
  const body = useId();
  const view = b.p ? brainView(b.p, { container }) : null;
  // A Boton on an API brain with no key can't think, whatever the last check said.
  const noKey = b.apiKey && b.k?.source === 'none';
  const status = !b.p
    ? 'Not on this server'
    : adding
      ? b.p.readiness.state === 'not-installed'
        ? 'Not installed'
        : 'Not set up'
      : noKey
        ? 'No key'
        : view!.status;
  const tone = !b.p ? 'bad' : adding ? 'unknown' : noKey ? 'bad' : view!.tone;
  const spent = b.apiKey ? spendLine(b.users, spend) : null;
  return (
    <li className="brain-card" data-brain={b.id} data-state={b.p?.readiness.state}>
      <button type="button" className="brain-card-head" aria-expanded={open} aria-controls={open ? body : undefined} onClick={onToggle}>
        <span className="brain-card-name">{b.name}</span>
        <span className={cx('brain-status', tone)}>{status}</span>
        <ChevronIcon size={14} className={cx('brain-card-chevron', open && 'on')} />
      </button>
      {adding ? (
        <p className="hint brain-card-meta">{b.blurb}</p>
      ) : (
        <p className="hint brain-card-meta">
          {onOpenBot && b.users.length ? (
            <>
              Used by{' '}
              {b.users.map((u, i) => (
                <span key={u.id}>
                  {i > 0 && ', '}
                  <button type="button" className="link-btn" title={`Open ${u.name}'s settings`} onClick={() => onOpenBot(u.id)}>
                    {u.name}
                  </button>
                  {u.paused && ' (paused)'}
                </span>
              ))}
            </>
          ) : (
            usedByText(b.users)
          )}
          {spent && <> · {spent}</>}
        </p>
      )}
      {note && (
        <p role="status" className={cx('brain-card-note', note.ok ? 'ok' : 'form-error')}>
          {note.text}
        </p>
      )}
      {open && (
        <div id={body} className="brain-card-body">
          {b.apiKey ? (
            b.k ? (
              <KeyBody k={b.k} users={b.users} setNote={setNote} onPage={onPage} />
            ) : (
              <p className="hint">Loading…</p>
            )
          ) : b.p && (b.p.id === 'claude-cli' || b.p.id === 'codex-cli') ? (
            <CliBody
              p={b.p}
              setUp={b.setUp}
              pending={b.p.id === 'codex-cli' ? homes.codex : homes.claude}
              refreshHomes={refreshHomes}
              setNote={setNote}
              container={container}
            />
          ) : (
            view && <Why view={view} />
          )}
        </div>
      )}
    </li>
  );
}

/** "Today about $0.42 of $5.00 cap" for one Boton (Botons' own estimate, with requests it can't price); for several, each by name. */
function spendLine(users: Bot[], spend: Record<string, SpendingView>): string | null {
  const seen = users.filter((u) => spend[u.id]);
  if (!seen.length) return null;
  const one = (v: SpendingView) =>
    `about ${usd(v.spentTodayUsd)}${v.unpricedToday ? ` + ${v.unpricedToday} unpriced` : ''}${v.dailyCapUsd !== null ? ` of ${usd(v.dailyCapUsd)} cap` : ''}`;
  if (users.length === 1) return `Today ${one(spend[seen[0].id])}`;
  return `Today: ${seen.map((u) => `${u.name} ${one(spend[u.id])}`).join(', ')}`;
}

/** Why a brain isn't ready and what to do on the server; nothing when it is. */
function Why({ view, skipFix }: { view: ReturnType<typeof brainView>; skipFix?: boolean }) {
  if (!view.why && !view.fix) return null;
  return (
    <>
      {view.why && <p className="hint">{withCode(view.why)}</p>}
      {view.fix && !skipFix && (
        <p className="hint">
          {withCode(view.fix.text)}
          {view.fix.command && (
            <>
              {' '}
              <code>{view.fix.command}</code> <Copy text={view.fix.command} />
            </>
          )}
        </p>
      )}
    </>
  );
}

function CliBody({
  p,
  setUp,
  pending,
  refreshHomes,
  setNote,
  container,
}: {
  p: ProviderInfo;
  setUp: boolean;
  pending: boolean;
  refreshHomes: () => Promise<void>;
  setNote: SetNote;
  container: boolean;
}) {
  const codex = p.id === 'codex-cli';
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const view = brainView(p, { container });
  const ready = p.readiness.state === 'ready';
  const failed = p.lastError && (!p.lastSuccessAt || p.lastError.at > p.lastSuccessAt) ? p.lastError : null;
  const command = loginCommand(p.id, container) ?? '';
  const signIn = signing || (!setUp && !pending);
  const copyExisting = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.importCodexSignIn();
      await refreshHomes();
      await actions.loadProviders(true);
      setNote({ ok: true, text: '✓ Botons now has its own Codex sign-in.' });
    } catch {
      setNote({
        ok: false,
        text: 'Could not copy the sign-in. Try signing in just for Botons.',
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {!ready && <Why view={view} skipFix={p.readiness.state === 'signed-out'} />}
      {failed && <p className="hint warn">Last turn failed: {failed.message}</p>}
      <BrainCliActions provider={p.id as 'codex-cli' | 'claude-cli'} />
      {signIn ? (
        codex ? (
          <CodexSignIn command={command} setNote={setNote} onDone={() => setSigning(false)} />
        ) : (
          <div className="brain-signin">
            <p className="hint">Claude signs in from a terminal on this server. Run:</p>
            <p>
              <code>{command}</code> <Copy text={command} />
            </p>
            <p className="hint">Leave this page open; it checks by itself.</p>
          </div>
        )
      ) : pending && codex ? (
        <div className="brain-signin">
          <p className="hint">It uses your existing Codex sign-in. Give Botons its own copy, or sign in just for Botons.</p>
          <div className="form-actions">
            <button type="button" className="btn small" disabled={busy} onClick={() => void copyExisting()}>
              Use existing sign-in
            </button>
            <button type="button" className="btn small" disabled={busy} onClick={() => setSigning(true)}>
              Sign in just for Botons
            </button>
          </div>
          <p className="hint">Copies only the Codex sign-in file, never your instructions, skills or settings.</p>
        </div>
      ) : pending ? (
        <p className="hint">
          It uses your existing Claude sign-in. To sign in just for Botons, run <code>{command}</code> <Copy text={command} /> on the server.
        </p>
      ) : (
        <div className="form-actions">
          <button type="button" className="btn small ghost" onClick={() => setSigning(true)}>
            Change sign-in
          </button>
        </div>
      )}
      {!ready && view.fix && <CheckAgain />}
    </>
  );
}

type Login = Awaited<ReturnType<typeof api.brainLogin>>;

/** ChatGPT's sign-in in the browser (a code to approve), or the terminal command. */
function CodexSignIn({ command, setNote, onDone }: { command: string; setNote: SetNote; onDone: () => void }) {
  const [login, setLogin] = useState<Login | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useActiveRef();
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const poll = () =>
      void api
        .brainLogin()
        .then((l) => live && setLogin(l))
        .catch(() => {});
    poll();
    const timer = setInterval(() => active.current && poll(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (signInFinished(last.current, login?.state)) {
      setNote({ ok: true, text: '✓ Signed in.' });
      void actions.loadProviders(true).catch(() => {});
      onDone();
    }
    last.current = login?.state;
  }, [login?.state]);
  const run = async (fn: () => Promise<Login>) => {
    setBusy(true);
    setNote(null);
    try {
      setLogin(await fn());
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const waiting = login?.state === 'waiting';
  return (
    <div className="brain-signin">
      {waiting ? (
        <div role="status">
          <p className="hint">Waiting for you to approve sign-in…</p>
          {login.url && login.code && (
            <p>
              <code>{login.code}</code> <Copy text={login.code} />{' '}
              <a href={login.url} target="_blank" rel="noreferrer">
                Open sign-in page
              </a>
            </p>
          )}
          <button type="button" className="btn small" disabled={busy} onClick={() => void run(() => api.cancelBrainLogin())}>
            Cancel sign-in
          </button>
        </div>
      ) : (
        <div className="form-actions">
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void run(() => api.startBrainLogin())}>
            Sign in to ChatGPT
          </button>
        </div>
      )}
      {login && ['fallback', 'timed-out'].includes(login.state) && (
        <p className="hint warn">Browser sign-in could not finish. Try again, or use the terminal.</p>
      )}
      <p className="hint">
        Or on the server: <code>{command}</code> <Copy text={command} />
      </p>
    </div>
  );
}

function KeyBody({ k, users, setNote, onPage }: { k: ApiKeyState; users: Bot[]; setNote: SetNote; onPage?: (page: 'api-keys') => void }) {
  // The pasted key lives only here, in memory, until it is saved; then it is cleared. It is never stored in the page.
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const run = async (what: 'save' | 'test' | 'remove', fn: () => Promise<string | null>) => {
    setBusy(what);
    setNote(null);
    try {
      const text = await fn();
      if (text) setNote({ ok: true, text });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const test = k.test;
  const fieldId = useId();
  return (
    <>
      {k.source !== 'none' && (
        <p className="hint">
          {sourceText(k)}
          {k.savedAt && ` · saved ${relative(k.savedAt)}`}
        </p>
      )}
      {k.testing ? (
        <p className="hint">Testing…</p>
      ) : (
        test && (
          <p className={cx('hint', test.outcome !== 'ok' && 'warn')}>
            {test.outcome === 'ok' ? `✓ ${OUTCOME.ok}` : OUTCOME[test.outcome]} · tested {relative(test.checkedAt)}
          </p>
        )
      )}
      {!k.brain.available && k.brain.reason && (users.length > 0 || k.source !== 'none') && <p className="hint warn">{k.brain.reason}</p>}
      <form
        className="api-key-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run('save', async () => {
            const next = await api.saveApiKey(k.provider, key, k.generation);
            setKey('');
            actions.apiKeyChanged(next);
            await actions.loadProviders(true);
            return `✓ Key ${k.saved ? 'replaced' : 'saved'}. ${users.length ? 'Botons already on this brain use it now; no Boton changes brain.' : 'A Boton uses it once you pick it in its settings.'}`;
          });
        }}
      >
        <label htmlFor={fieldId}>
          <span className="field-label">{k.saved ? 'Replace the key' : 'API key'}</span>
        </label>
        <span className="topic-row">
          <input
            id={fieldId}
            type="password"
            name={`brain-key-${k.provider}`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={k.saved ? 'Paste a new key' : k.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
          />
          <button type="submit" className="btn small primary" disabled={!!busy || !key.trim()}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </span>
      </form>
      <div className="form-actions">
        {k.source !== 'none' && (
          <button
            type="button"
            className="btn small"
            disabled={!!busy || k.testing}
            onClick={() =>
              void run('test', async () => {
                await api.testApiKey(k.provider);
                await actions.loadApiKeys();
                return null;
              })
            }
          >
            {busy === 'test' ? 'Testing…' : 'Test key'}
          </button>
        )}
        {k.saved && !confirming && (
          <button type="button" className="btn small ghost" disabled={!!busy} onClick={() => setConfirming(true)}>
            Remove key
          </button>
        )}
        {onPage && k.source !== 'none' && (
          <button type="button" className="link-btn" onClick={() => onPage('api-keys')}>
            Key details
          </button>
        )}
      </div>
      {confirming && (
        <div className="api-key-confirm" role="group" aria-label={`Remove the saved ${k.label} key`}>
          <p className="hint warn">
            {k.environment
              ? `Remove the saved key? Botons then uses ${k.envVar} from the server's environment.`
              : `Remove the saved key?${users.length ? ` ${users.length === 1 ? users[0].name : 'Its Botons'} can't think until there is a key again.` : ''}`}{' '}
            If it may have leaked, revoke it with the provider too.
          </p>
          <div className="form-actions">
            <button type="button" className="btn small ghost" onClick={() => setConfirming(false)}>
              Keep it
            </button>
            <button
              type="button"
              className="btn small danger"
              disabled={!!busy}
              onClick={() =>
                void run('remove', async () => {
                  const next = await api.removeApiKey(k.provider, k.generation);
                  setConfirming(false);
                  actions.apiKeyChanged(next);
                  await actions.loadProviders(true);
                  return next.source === 'environment' ? `✓ Removed. Now using ${next.envVar} from the server's environment.` : '✓ Key removed.';
                })
              }
            >
              {busy === 'remove' ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      )}
      <p className="hint">Each Boton on it sets its own model and daily cap.</p>
    </>
  );
}
