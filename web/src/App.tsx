import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { DEFAULT_LOOK } from '../../shared/look.ts';
import { BotonAvatar } from './components/Avatar.tsx';
import { BrandMark } from './components/Brand.tsx';
import { Chat, type PanelTab } from './components/Chat.tsx';
import { PlusIcon } from './components/Icons.tsx';
import { deferred, DeferredDialog, DeferredPanel, DeferredScreen } from './components/Deferred.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Toasts } from './components/Toasts.tsx';
import { TakeoverHost } from './components/BrowserTakeover.tsx';
import { showToast } from './feedback.ts';
import { actions, useStore } from './state.ts';
import { cx } from './util.ts';

// Opened now and then, so their code (and the modules only they use) loads when they first open.
const newBotPart = deferred(() => import('./components/NewBotDialog.tsx'));
const pairPart = deferred(() => import('./components/PairScreen.tsx'));
const panelPart = deferred(() => import('./components/Panel.tsx'));
const settingsPart = deferred(() => import('./components/SettingsDialog.tsx'));
const setupPart = deferred(() => import('./components/Setup.tsx'));
const skillsPart = deferred(() => import('./components/Skills.tsx'));

function readHash(): string | null {
  const m = /^#\/m\/([\w-]+)/.exec(location.hash);
  return m ? m[1] : null;
}

// Below this width the open panel (styles.css) hides at least half of the chat, so the chat doesn't count as read.
const PANEL_COVERS_CHAT = '(max-width: 1119px)';

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (l: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', l);
      return () => mq.removeEventListener('change', l);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

export function App() {
  const ready = useStore((s) => s.ready);
  const loadError = useStore((s) => s.loadError);
  const pairing = useStore((s) => s.pairing);
  const connected = useStore((s) => s.connected);
  const updated = useStore((s) => s.updated);
  const bots = useStore((s) => s.bots);
  const setupDone = useStore((s) => s.setup?.completed ?? true);
  const [selectedId, setSelectedId] = useState<string | null>(readHash);
  /** `at`: when it was asked for, so asking for the same focus again works. */
  const [panel, setPanel] = useState<{ tab: PanelTab; focus: string | null; at: number } | null>(null);
  const [dialog, setDialog] = useState<'new' | 'settings' | 'skills' | null>(null);
  /** The sidebar group a new Boton is made from. */
  const [newIn, setNewIn] = useState<string | undefined>(undefined);
  const panelCoversChat = useMediaQuery(PANEL_COVERS_CHAT);

  // Back from an OAuth sign-in: say how it went, then take the marker off the address.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const name = q.get('connector');
    const result = q.get('signin');
    if (!name || !result) return;
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
    showToast(result === 'connected' ? { kind: 'info', text: `${name} is connected.` } : { kind: 'error', text: `Signing in to ${name} didn't complete. Try again in Settings.` }, 8000);
    setDialog('settings');
  }, []);

  useEffect(() => {
    const onHash = () => setSelectedId(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = useCallback((id: string | null) => {
    location.hash = id ? `/m/${id}` : '';
    setSelectedId(id);
  }, []);

  // Back to the list closes the panel; so does another Boton where the panel covers the chat.
  const [panelFor, setPanelFor] = useState(selectedId);
  if (panelFor !== selectedId) {
    setPanelFor(selectedId);
    if (panel && (!selectedId || panelCoversChat)) setPanel(null);
  }

  // Escape closes the panel, unless a dialog is open or a field has focus (it must not drop unsaved edits).
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (document.querySelector('dialog[open]')) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      setPanel(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panel]);

  const openBot = (id: string | null) => {
    setPanel(null);
    select(id);
  };
  // From Settings → Brains: that Boton's own settings, where its brain is picked.
  const openBotSettings = (id: string) => {
    setDialog(null);
    select(id);
    setPanelFor(id);
    setPanel({ tab: 'settings', focus: null, at: Date.now() });
  };

  const bot = bots.find((b) => b.id === selectedId) ?? null;

  const primaryId = useStore((s) => s.settings?.primaryBotId ?? null);
  // On wide screens, open the primary Boton (else the most recent one) when none is selected.
  useEffect(() => {
    if (ready && !bot && bots.length && window.matchMedia('(min-width: 800px)').matches) {
      select(bots.find((b) => b.id === primaryId)?.id ?? bots[0].id);
    }
  }, [ready, bot, bots, primaryId, select]);

  const unread = bots.reduce((n, b) => n + b.unread, 0);
  const botName = bot?.name;
  useEffect(() => {
    document.title = `${unread ? `(${unread}) ` : ''}${botName ? `${botName} · ` : ''}Botons`;
  }, [unread, botName]);

  if (pairing) return <DeferredScreen part={pairPart} what="the pairing screen">{(m) => <m.PairScreen status={pairing} />}</DeferredScreen>;
  if (loadError) {
    return (
      <div className="boot">
        <BrandMark size={48} />
        <p>Couldn't load Botons: {loadError}</p>
        <button className="btn primary" onClick={() => actions.init()}>
          Retry
        </button>
      </div>
    );
  }
  if (!ready)
    return (
      <div className="boot muted" role="status">
        <BrandMark size={48} />
        Loading…
      </div>
    );
  if (!setupDone) return <DeferredScreen part={setupPart} what="setup">{(m) => <m.SetupWizard onDone={(id) => id && select(id)} />}</DeferredScreen>;

  return (
    <div className={cx('app', bot && 'has-bot', panel && bot && 'has-panel')}>
      {!connected && <div className="offline">Reconnecting to the server…</div>}
      {connected && updated && (
        <div className="offline updated" role="status">
          Botons was updated.{' '}
          <button className="link-btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}
      <Sidebar selectedId={selectedId} onSelect={select} onNew={(groupId) => (setNewIn(groupId), setDialog('new'))} onSettings={() => setDialog('settings')} onSkills={() => setDialog('skills')} />
      {bot ? (
        <Chat
          bot={bot}
          covered={!!panel && panelCoversChat}
          onOpenPanel={(tab, focus) => setPanel({ tab, focus: focus ?? null, at: Date.now() })}
          onOpenBot={openBot}
          onBack={() => select(null)}
        />
      ) : (
        <main className="chat empty-main">
          <div className="welcome">
            <div className="welcome-crowd">
              {bots.length ? bots.slice(0, 5).map((b) => <BotonAvatar key={b.id} look={b.look} size={64} seed={b.id} />) : <BotonAvatar look={DEFAULT_LOOK} size={96} seed="empty" />}
            </div>
            <h1>{bots.length ? 'Pick a Boton' : 'Meet your Botons'}</h1>
            <p className="welcome-copy">
              {bots.length ? 'Each Boton is an agent with its own chat, routines and memory, running on this computer.' : 'No Botons yet. Make your first one and give it a job.'}
            </p>
            <button className="btn primary" onClick={() => (setNewIn(undefined), setDialog('new'))}>
              <PlusIcon size={16} /> New Boton
            </button>
          </div>
        </main>
      )}
      {bot && panel && (
        <DeferredPanel part={panelPart} label={`${bot.name} details`} onClose={() => setPanel(null)}>
          {(m) => (
            <m.Panel
              bot={bot}
              tab={panel.tab}
              focus={panel.focus}
              focusAt={panel.at}
              onTab={(tab, focus) => setPanel({ tab, focus: focus ?? null, at: Date.now() })}
              onClose={() => setPanel(null)}
              onOpenBot={openBot}
              onDeleted={() => openBot(null)}
            />
          )}
        </DeferredPanel>
      )}
      {dialog === 'new' && (
        <DeferredDialog part={newBotPart} title="New Boton" onClose={() => setDialog(null)}>
          {(m) => (
            <m.NewBotDialog
              groupId={newIn}
              onClose={() => setDialog(null)}
              onCreated={(b) => {
                setDialog(null);
                openBot(b.id);
              }}
            />
          )}
        </DeferredDialog>
      )}
      {dialog === 'settings' && (
        <DeferredDialog part={settingsPart} title="Settings" onClose={() => setDialog(null)}>
          {(m) => <m.SettingsDialog onClose={() => setDialog(null)} onOpenBot={openBotSettings} />}
        </DeferredDialog>
      )}
      {dialog === 'skills' && (
        <DeferredDialog part={skillsPart} title="Skills" onClose={() => setDialog(null)}>
          {(m) => <m.SkillsDialog onClose={() => setDialog(null)} />}
        </DeferredDialog>
      )}
      <TakeoverHost />
      <Toasts page />
    </div>
  );
}
