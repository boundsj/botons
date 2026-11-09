import { Logo } from './Brand.tsx';
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { attempt, showToast } from '../feedback.ts';
import { actions, getState, useStore } from '../state.ts';
import { cleanupText } from '../files.ts';
import { serial } from '../live-settings.ts';
import { cx, isValidTimezone, timezones } from '../util.ts';
import { ApiKeys } from './ApiKeys.tsx';
import { AvatarMotionSetting } from './Avatar.tsx';
import { BrainSettings } from './BrainSettings.tsx';
import { ConfigTransfer } from './ConfigTransfer.tsx';
import { ConnectService, ConnectorRequests, McpLibrary, OAuthConnectors } from './Connectors.tsx';
import { Devices } from './Devices.tsx';
import { Dialog } from './Dialog.tsx';
import { BackIcon, ChevronIcon } from './Icons.tsx';
import { HealthAndBackups } from './Operations.tsx';
import { PushSettings } from './PushSettings.tsx';
import { ReactionSettings } from './ReactionSettings.tsx';
import { RunsToCheck } from './Routines.tsx';
import { ServerLog } from './ServerLog.tsx';
import { PageActive } from './PageActive.ts';
import { Row, Section, Toggle, useDraft } from './SettingRows.tsx';
import { StorageSettings } from './StorageSettings.tsx';
import { AccessSettings, AuditLog } from './Setup.tsx';
import { ThemeSetting } from './ThemeSetting.tsx';

export type SettingsPage = 'you' | 'brains' | 'api-keys' | 'connectors' | 'access' | 'devices' | 'storage' | 'notifications' | 'health' | 'appearance' | 'advanced';

/** The server's settings as a list of pages, grouped by what the owner wants to do. */
const GROUPS: { title: string; pages: { id: SettingsPage; label: string }[] }[] = [
  { title: 'You', pages: [{ id: 'you', label: 'Your name and timezone' }, { id: 'appearance', label: 'Appearance' }, { id: 'notifications', label: 'Notifications' }] },
  { title: 'Botons', pages: [{ id: 'brains', label: 'Brains' }, { id: 'api-keys', label: 'API keys' }, { id: 'connectors', label: 'Connectors' }] },
  { title: 'This server', pages: [{ id: 'access', label: 'Who can connect' }, { id: 'devices', label: 'Devices' }, { id: 'storage', label: 'Storage' }, { id: 'health', label: 'Health and backups' }] },
  { title: 'More', pages: [{ id: 'advanced', label: 'Advanced' }] },
];
const LABELS = Object.fromEntries(GROUPS.flatMap((g) => g.pages.map((p) => [p.id, p.label]))) as Record<SettingsPage, string>;

const WIDE = '(min-width: 760px)';
const subscribeWide = (l: () => void) => {
  const m = matchMedia(WIDE);
  m.addEventListener('change', l);
  return () => m.removeEventListener('change', l);
};

/** `onOpenBot`: close Settings and open that Boton's own settings (where its brain is picked). */
export function SettingsDialog({ onClose, onOpenBot }: { onClose: () => void; onOpenBot?: (id: string) => void }) {
  const wide = useSyncExternalStore(subscribeWide, () => matchMedia(WIDE).matches, () => true);
  const [picked, setPicked] = useState<SettingsPage | null>(null);
  // Wide, a page is always open beside the list; narrow, the list is its own screen.
  const page = picked ?? (wide ? 'you' : null);
  // Pages stay as they were once opened (a half-filled form, a pasted key), only hidden, until Settings closes.
  const [opened, setOpened] = useState<SettingsPage[]>([]);
  if (page && !opened.includes(page)) setOpened([...opened, page]);
  // Narrow, opening a page takes focus to its title, and going back takes it to the page's row.
  const shell = useRef<HTMLDivElement>(null);
  const [back, setBack] = useState<SettingsPage | null>(null);
  const moved = useRef(false);
  const focusPlace = () => {
    const target = page
      ? shell.current?.querySelector<HTMLElement>(`[data-page="${page}"] .settings-page-title`)
      : (shell.current?.querySelector<HTMLElement>(`.settings-nav [data-section="${back}"]`) ?? shell.current?.querySelector<HTMLElement>('.settings-nav [data-section]'));
    target?.focus();
  };
  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    focusPlace();
  }, [page, back]);
  // The layout changing (a window resized, a phone turned) can take away what had focus: put it where the owner is.
  const wasWide = useRef(wide);
  useLayoutEffect(() => {
    if (wasWide.current === wide) return;
    wasWide.current = wide;
    const now = document.activeElement;
    if (now instanceof HTMLElement && now !== document.body && shell.current?.closest('dialog')?.contains(now) && !now.closest('[hidden]')) return;
    focusPlace();
  }, [wide]);
  const pick = (p: SettingsPage | null) => {
    if (!wide) moved.current = true;
    if (!p) setBack(page);
    setPicked(p);
  };
  useEffect(() => {
    void actions.loadSetup().catch(() => {});
    void actions.loadConnectors().catch(() => {});
    void actions.loadApiKeys().catch(() => {});
  }, []);
  return (
    <Dialog title="Settings" onClose={onClose} className="settings-dialog">
      <div ref={shell} className={cx('settings-shell', page ? 'has-page' : 'no-page')}>
        {(wide || !page) && <SettingsNav current={wide ? page : null} onPick={pick} />}
        <div className="settings-page" hidden={!page}>
          {page && !wide && (
            <button type="button" className="link-btn settings-back" onClick={() => pick(null)}>
              <BackIcon size={14} /> All settings
            </button>
          )}
          {opened.map((p) => (
            <div key={p} className="settings-page-body" data-page={p} hidden={p !== page}>
              <h3 className="settings-page-title" tabIndex={-1}>
                {LABELS[p]}
              </h3>
              <PageActive.Provider value={p === page}>
                <PageBody page={p} onPage={pick} onOpenBot={onOpenBot} />
              </PageActive.Provider>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function SettingsNav({ current, onPick }: { current: SettingsPage | null; onPick: (p: SettingsPage) => void }) {
  const summary = useSummaries();
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {GROUPS.map((g) => (
        <Section key={g.title} title={g.title}>
          {g.pages.map((p) => (
            <button key={p.id} type="button" className={cx('set-row set-link', current === p.id && 'on')} data-section={p.id} aria-current={current === p.id ? 'page' : undefined} onClick={() => onPick(p.id)}>
              <span className="set-label">{p.label}</span>
              <span className="set-value">
                <span className="settings-summary">{summary[p.id]}</span> <ChevronIcon size={14} />
              </span>
            </button>
          ))}
        </Section>
      ))}
      <PauseAll />
    </nav>
  );
}

/** One short value per page in the list, from what is loaded already: nothing when it isn't. */
function useSummaries(): Partial<Record<SettingsPage, string>> {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const keys = useStore((s) => s.apiKeys);
  const catalog = useStore((s) => s.connectors);
  const setup = useStore((s) => s.setup);
  const ready = providers.filter((p) => p.readiness.state === 'ready' && p.id !== 'mock');
  const saved = keys?.providers.filter((k) => k.source !== 'none').length;
  const services = catalog?.connectors.filter((c) => !c.managed).length;
  const devices = setup?.owner.devices;
  return {
    you: settings?.ownerName || undefined,
    brains: providers.length ? (ready.length ? `${ready.map((p) => p.label.replace(/ \(.*\)$/, '')).join(', ')} ready` : 'None ready') : undefined,
    'api-keys': saved === undefined ? undefined : saved ? `${saved} in use` : 'None',
    connectors: services === undefined ? undefined : services ? `${services} service${services === 1 ? '' : 's'}` : 'None yet',
    access: setup?.modes.find((m) => m.mode === setup.accessMode)?.label,
    devices: devices === undefined ? undefined : `${devices} paired`,
    storage: settings ? cleanupText(settings.inboxCleanupDays) : undefined,
  };
}

function PauseAll() {
  const paused = useStore((s) => s.settings?.paused ?? false);
  const turn = (next: boolean, undo = false) =>
    void attempt(next ? 'pause all Botons' : 'resume all Botons', async () => {
      await actions.pauseAll(next);
      if (!undo) showToast({ kind: 'info', text: next ? 'All Botons paused' : 'All Botons resumed', action: { label: 'Undo', run: () => turn(!next, true) } });
    });
  return (
    <div className="set-card settings-pause">
      <Row
        label="Pause all Botons"
        help={paused ? 'Nothing runs until you resume, even after a restart.' : 'Stops every running turn and holds all work.'}
        control={<Toggle label="Pause all Botons" on={paused} onChange={(v) => turn(v)} />}
      />
    </div>
  );
}

function PageBody({ page, onPage, onOpenBot }: { page: SettingsPage; onPage: (p: SettingsPage) => void; onOpenBot?: (id: string) => void }) {
  switch (page) {
    case 'you':
      return <YouPage />;
    case 'appearance':
      return (
        <Parts>
          <div className="set-card">
            <div className="set-row">
              <ThemeSetting />
            </div>
          </div>
          <AvatarMotionSetting />
          <ReactionSettings />
        </Parts>
      );
    case 'notifications':
      return <PushSettings />;
    case 'brains':
      return <BrainSettings onPage={onPage} onOpenBot={onOpenBot} />;
    case 'api-keys':
      return <ApiKeys />;
    case 'connectors':
      return (
        <Parts>
          <ConnectService />
          <OAuthConnectors />
          <McpLibrary />
          <ConnectorRequests />
        </Parts>
      );
    case 'access':
      return <AccessSettings />;
    case 'devices':
      return <Devices />;
    case 'storage':
      return <StorageSettings />;
    case 'health':
      return (
        <Parts>
          <HealthAndBackups />
          <RunsToCheck />
          <ServerLog />
        </Parts>
      );
    case 'advanced':
      return (
        <Parts>
          <ServerInfo />
          <ConfigTransfer />
          <AuditLog />
        </Parts>
      );
  }
}

function Parts({ children }: { children: ReactNode }) {
  return <div className="settings-parts">{children}</div>;
}

type YouField = 'ownerName' | 'timezone';

function YouPage() {
  const settings = useStore((s) => s.settings);
  const id = useId();
  const zones = useMemo(() => timezones().map((z) => <option key={z} value={z} />), []);
  // Saves go one at a time. Each one's Undo puts back the value saved just before it ran: never one that failed, or
  // one sent but not yet saved.
  const queue = useMemo(() => serial(), []);
  const save = (field: YouField, value: string, isUndo = false) =>
    void attempt('save that', async () => {
      const before = await queue(async () => {
        const saved = getState().settings?.[field] ?? '';
        await actions.updateSettings({ [field]: value });
        return saved;
      });
      if (!isUndo && before !== value) showToast({ kind: 'info', text: field === 'ownerName' ? 'Name saved' : 'Timezone saved', action: { label: 'Undo', run: () => save(field, before, true) } });
    });
  const name = useDraft(settings?.ownerName ?? '', (v) => save('ownerName', v.trim()), (v) => !!v.trim());
  const tz = useDraft(settings?.timezone ?? '', (v) => save('timezone', v.trim()), (v) => isValidTimezone(v.trim()));
  const badTz = !isValidTimezone(tz.value.trim());
  return (
    <div className="set-card settings-form">
      <Row label="Your name" htmlFor={`${id}-n`} help="Botons use it when they talk about you.">
        <input id={`${id}-n`} className="set-wide" maxLength={60} autoComplete="name" {...name} />
      </Row>
      <Row label="Timezone for new Botons" htmlFor={`${id}-t`} help={badTz ? <span className="field-error">Not a timezone; it goes back when you leave the field.</span> : 'Each Boton can have its own.'}>
        <input id={`${id}-t`} className="set-wide" list={`${id}-zones`} autoComplete="off" spellCheck={false} aria-invalid={badTz} {...tz} />
        <datalist id={`${id}-zones`}>{zones}</datalist>
      </Row>
    </div>
  );
}

function ServerInfo() {
  const info = useStore((s) => s.info);
  if (!info) return null;
  return (
    <section className="server-info">
      <h4>About</h4>
      <Logo height={30} />
      <p>Botons {info.version}</p>
      <p className="hint">Build {info.build?.slice(0, 12) || 'development'}</p>
      <p><a href="https://github.com/boundsj/botons/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT license</a> · <a href="https://github.com/boundsj/botons" target="_blank" rel="noreferrer">Project</a></p>
      <p><a href="https://github.com/boundsj/botons/security/advisories" target="_blank" rel="noreferrer">Report a security issue</a></p>
      <h4>This server</h4>
      <p className="hint">
        {info.hostname} · v{info.version}
      </p>
      <ul>
        {info.urls.map((u) => (
          <li key={u}>
            <code>{u}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
