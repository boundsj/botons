import { useLayoutEffect, useRef, useState } from 'react';
import type { Bot, Memory } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { attempt, showToast } from '../feedback.ts';
import { actions, useStore } from '../state.ts';
import { clip, cx, relative } from '../util.ts';
import type { PanelTab } from './Chat.tsx';
import { FilesTab } from './Files.tsx';
import { CloseIcon, TrashIcon } from './Icons.tsx';
import { LoadError, useLoad } from './Load.tsx';
import { ActivityTab } from './Activity.tsx';
import { RoutinesTab } from './Routines.tsx';
import { SettingsTab } from './BotonSettings.tsx';
import { UsageTab } from './Usage.tsx';

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'routines', label: 'Routines' },
  { id: 'activity', label: 'Activity' },
  { id: 'memory', label: 'Memory' },
  { id: 'files', label: 'Files' },
  { id: 'usage', label: 'Usage' },
  { id: 'settings', label: 'Settings' },
];

export function Panel(props: {
  bot: Bot;
  tab: PanelTab;
  focus: string | null;
  focusAt: number;
  onTab: (t: PanelTab, focus?: string) => void;
  onClose: () => void;
  onDeleted: () => void;
  onOpenBot: (id: string) => void;
}) {
  // Closed, focus goes back to what opened it, but never to a text box: on a phone that brings the keyboard up.
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body && !active.closest('input, textarea, select, [contenteditable="true"]') ? active : null;
    const panel = ref.current;
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && !panel?.contains(opener) && (!active || active === document.body || panel?.contains(active))) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <aside className="panel" ref={ref} aria-label={`${props.bot.name} details`}>
      <header className="panel-header">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={props.tab === t.id} className={cx('tab', props.tab === t.id && 'on')} onClick={() => props.onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <button className="icon-btn round" aria-label="Close panel" onClick={props.onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="panel-scroll">
        {props.tab === 'routines' && <RoutinesTab bot={props.bot} focusId={props.focus} />}
        {props.tab === 'activity' && <ActivityTab bot={props.bot} onOpenRoutine={(id) => props.onTab('routines', id)} />}
        {props.tab === 'memory' && <MemoryTab bot={props.bot} />}
        {props.tab === 'files' && <FilesTab key={props.bot.id} bot={props.bot} focus={props.focus} focusAt={props.focusAt} />}
        {props.tab === 'usage' && <UsageTab bot={props.bot} />}
        {props.tab === 'settings' && <SettingsTab key={props.bot.id} bot={props.bot} onDeleted={props.onDeleted} onOpenBot={props.onOpenBot} onTab={props.onTab} />}
      </div>
    </aside>
  );
}

function MemoryTab({ bot }: { bot: Bot }) {
  const memories = useStore((s) => s.memories[bot.id]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useLoad(() => actions.loadMemories(bot.id), bot.id);

  const forget = async (m: Memory) => {
    if (!(await attempt('forget that', () => actions.forgetMemory(m)))) return;
    showToast({
      kind: 'info',
      text: `Forgot “${clip(m.text, 60)}”`,
      action: { label: 'Undo', run: () => attempt('put that memory back', () => api.addMemory(m.botId, m.text)) },
    });
  };

  return (
    <div className="tab-body">
      <p className="muted">
        Things {bot.name} remembers between conversations. It saves these itself when it learns something durable; you can add or remove them here.
      </p>
      <form
        className="memory-add"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setError(null);
          try {
            await api.addMemory(bot.id, text);
            setText('');
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. I prefer bullet points over paragraphs" aria-label="New memory" />
        <button className="btn small" type="submit" disabled={!text.trim()}>
          Add
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      {memories === undefined && (load.error ? <LoadError what="memories" error={load.error} onRetry={load.retry} /> : <p className="muted">Loading…</p>)}
      {memories?.length === 0 && <p className="empty-note">Nothing remembered yet.</p>}
      <ul className="memory-list">
        {memories?.map((m) => (
          <li key={m.id}>
            <span>{m.text}</span>
            <span className="memory-age">{relative(m.createdAt)}</span>
            <button className="icon-btn small" aria-label="Forget" title="Forget" onClick={() => void forget(m)}>
              <TrashIcon size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
