import { useEffect, useId, useState } from 'react';
import { formatSize, INBOX_CLEANUP_CHOICES, INBOX_WARN_BYTES } from '../../../shared/files.ts';
import type { StorageUsage } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { attempt, errorText, showToast } from '../feedback.ts';
import { cleanupText, storageTotals } from '../files.ts';
import { actions, useStore } from '../state.ts';
import { More, Row } from './SettingRows.tsx';

/** Settings → Storage: what the files take, and the daily inbox cleanup (saved at once, with Undo). */
export function StorageSettings() {
  const id = useId();
  const days = useStore((s) => s.settings?.inboxCleanupDays);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api.storage().then(
      (u) => live && setUsage(u),
      (e) => live && setError(`Couldn't count the files: ${errorText(e)}`),
    );
    return () => {
      live = false;
    };
  }, []);

  const save = async (next: number | null, undo?: number | null) => {
    setSaving(true);
    const ok = await attempt('save the inbox cleanup', () => actions.updateSettings({ inboxCleanupDays: next }));
    setSaving(false);
    if (ok && undo !== undefined) showToast({ kind: 'info', text: cleanupText(next), action: { label: 'Undo', run: () => void save(undo) } });
  };

  const totals = usage && storageTotals(usage);
  const at = usage?.partial ? 'at least ' : '';
  return (
    <div className="settings-parts storage-settings">
      <div className="set-card">
        <Row
          label="Clean up old inbox files"
          htmlFor={`${id}-c`}
          help="Untouched inbox files go to the trash. Files you keep stay."
          control={
            <select
              id={`${id}-c`}
              value={days === null ? 'off' : String(days ?? 30)}
              disabled={saving || days === undefined}
              onChange={(e) => void save(e.target.value === 'off' ? null : Number(e.target.value), days ?? null)}
            >
              <option value="off">Off</option>
              {INBOX_CLEANUP_CHOICES.map((d) => (
                <option key={d} value={d}>
                  After {d} days
                </option>
              ))}
            </select>
          }
        >
          <More label="Details">
            <p className="set-help">
              It runs once a day. Workspaces, the shared folder and anything a Boton moved out of its inbox are never cleaned up. The trash keeps everything{' '}
              {usage?.trashKeepDays ?? 30} days.
            </p>
          </More>
        </Row>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!usage || !totals ? (
        !error && <p className="muted">Counting…</p>
      ) : (
        <div className="set-card">
          <Row
            label="All files"
            help={totals.big ? <span className="warn">That's a lot: Clear inbox and Empty trash in a Boton's Files.</span> : undefined}
            control={<span className="set-value">{at + formatSize(totals.total)}</span>}
          />
          <Row label="Shared folder" control={<span className="set-value">{formatSize(usage.sharedBytes)}</span>} />
          <Row label="Trash" control={<span className="set-value">{formatSize(usage.trashBytes)}</span>} />
          {usage.bots.map((b) => (
            <Row
              key={b.botId}
              label={b.name}
              help={<span className={b.inboxBytes > INBOX_WARN_BYTES ? 'warn' : undefined}>Inbox {formatSize(b.inboxBytes)} · Trash {formatSize(b.trashBytes)}</span>}
              control={<span className="set-value">Workspace {formatSize(b.workspaceBytes)}</span>}
            />
          ))}
        </div>
      )}
    </div>
  );
}
