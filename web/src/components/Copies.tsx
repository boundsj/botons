import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Bot } from '../../../shared/types.ts';
import { copyName } from '../../../shared/util.ts';
import { api } from '../api.ts';
import { showToast } from '../feedback.ts';
import { actions, useStore } from '../state.ts';
import { Dialog } from './Dialog.tsx';

function FormDialog(props: { title: string; submitLabel: string; busyLabel: string; onSubmit: () => Promise<void>; onClose: () => void; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  // In <body>: it is opened from the settings form, and forms can't nest.
  return createPortal(
    <Dialog title={props.title} onClose={() => !busy && props.onClose()}>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {props.children}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={props.onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? props.busyLabel : props.submitLabel}
          </button>
        </div>
      </form>
    </Dialog>,
    document.body,
  );
}

export function DuplicateDialog({ bot, onClose, onCreated }: { bot: Bot; onClose: () => void; onCreated: (b: Bot) => void }) {
  const bots = useStore((s) => s.bots);
  const [placeholder] = useState(() => copyName(bot.name, new Set(bots.map((b) => b.name.toLowerCase()))));
  const [name, setName] = useState('');
  const [withRoutines, setWithRoutines] = useState(true);
  const [withMemories, setWithMemories] = useState(false);
  return (
    <FormDialog
      title={`Duplicate ${bot.name}`}
      submitLabel={`Create ${name.trim() || placeholder}`}
      busyLabel="Duplicating…"
      onSubmit={async () => onCreated(await actions.duplicateBot(bot.id, { name: name.trim() || undefined, withRoutines, withMemories }))}
      onClose={onClose}
    >
      <p className="hint">
        The copy gets {bot.name}'s look, role, instructions, brain, access, group, timezone, connectors and skills, and a new workspace. Not its chat or conversation.
      </p>
      <label>
        <span className="field-label">Name</span>
        <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={60} />
      </label>
      <label className="check">
        <input type="checkbox" checked={withRoutines} onChange={(e) => setWithRoutines(e.target.checked)} />
        <span>Copy its routines (paused, with new webhook URLs and keys)</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={withMemories} onChange={(e) => setWithMemories(e.target.checked)} />
        <span>Copy its memories</span>
      </label>
    </FormDialog>
  );
}

export function SaveTemplateDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <FormDialog
      title="Save as template"
      submitLabel="Save template"
      busyLabel="Saving…"
      onSubmit={async () => {
        const t = await api.saveTemplate({ fromBotId: bot.id, name: name.trim() || undefined, description: description.trim() || undefined });
        showToast({ kind: 'info', text: `Saved template “${t.name}”. Pick it under New Boton.` });
        onClose();
      }}
      onClose={onClose}
    >
      <p className="hint">
        Saves {bot.name}'s look, role, instructions, brain, access, group, timezone, connectors, skill choice and routines, so a new Boton can start from
        them. Not its chat, memories, workspace, webhook keys, signing secrets or callback URLs.
      </p>
      <label>
        <span className="field-label">Template name</span>
        <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder={bot.name} maxLength={60} />
      </label>
      <label>
        <span className="field-label">Description (optional)</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={bot.title ? `${bot.title}, saved from ${bot.name}.` : `Saved from ${bot.name}.`} maxLength={300} />
      </label>
    </FormDialog>
  );
}
