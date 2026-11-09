import { useId, useState } from 'react';
import type { Bot, Skill, SkillAuthor } from '../../../shared/types.ts';
import { attempt, errorText } from '../feedback.ts';
import { actions, useStore } from '../state.ts';
import { cx, relative } from '../util.ts';
import { ConfirmDialog, Dialog } from './Dialog.tsx';
import { CheckIcon, EditIcon, PlusIcon, TrashIcon } from './Icons.tsx';
import { pendingFor } from '../skills.ts';
import { useSkills } from './SkillPicker.tsx';
import { SkillManage, SkillPackages } from './SkillPackages.tsx';

const who = (a: SkillAuthor, owner: string) => (a.kind === 'boton' ? a.name : owner);

// "Written by Juniper (a Boton) · approved by Sam 2 days ago". Editing a Boton's skill approves it too.
function attribution(s: Skill, owner: string): string {
  const created = who(s.createdBy, owner);
  const updated = who(s.updatedBy, owner);
  const edited = s.updatedAt !== s.createdAt;
  const by = s.createdBy.kind === 'boton' ? `Written by ${created} (a Boton)` : `Written by ${created}`;
  if (!edited) return `${by} ${relative(s.createdAt)}`;
  const what = s.createdBy.kind === 'boton' && s.updatedBy.kind === 'owner' ? `approved by ${updated}` : updated === created && s.updatedBy.kind === s.createdBy.kind ? 'edited' : `edited by ${updated}`;
  return `${by} · ${what} ${relative(s.updatedAt)}`;
}

function parseSkillMd(text: string): { name?: string; description?: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'mi').exec(m[1])?.[1].trim().replace(/^(["'])(.*)\1$/, '$2') || undefined;
  return { name: field('name'), description: field('description'), body: m[2].trim() };
}

export function SkillsDialog({ onClose }: { onClose: () => void }) {
  const { skills, error } = useSkills();
  const owner = useStore((s) => s.settings?.ownerName ?? 'you');
  const [editing, setEditing] = useState<Skill | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const [packages, setPackages] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);

  return (
    <Dialog title="Skills" onClose={onClose} wide>
      <div className="skills-screen">
        <p className="hint">
          Procedures you write once and Botons follow: each Boton sees the name and description of the skills enabled for it (in its settings), reads one
          when it fits, follows it when you send <code>/name</code> in its chat, and every run of a routine with that skill follows it. Botons can save
          their own; only the Boton that wrote one can use it until you approve it (or edit it). Skills from a package install only after you review
          exactly what changes and who gets it.
        </p>
        {error && <p className="form-error">{error}</p>}
        {editing === 'new' ? (
          <SkillForm onDone={() => setEditing(null)} />
        ) : packages ? (
          <SkillPackages onDone={() => setPackages(false)} />
        ) : (
          <div className="skills-add">
            <button type="button" className="btn small" onClick={() => setEditing('new')} data-autofocus>
              <PlusIcon size={14} /> New skill
            </button>
            <button type="button" className="btn ghost small" onClick={() => setPackages(true)}>
              Install from a package
            </button>
          </div>
        )}
        {skills?.length === 0 && editing !== 'new' && <p className="empty-note">No skills yet.</p>}
        <ul className="skill-list">
          {skills?.map((s) =>
            editing !== 'new' && editing?.name === s.name ? (
              <li key={s.name}>
                <SkillForm skill={s} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={s.name} className={cx('skill-item', s.updatedBy.kind === 'boton' && 'by-boton')}>
                <div className="skill-head">
                  <code className="skill-name">/{s.name}</code>
                  {s.updatedBy.kind === 'boton' && <span className="badge">by {s.updatedBy.name}</span>}
                  {s.pending && <span className="badge warn-badge">waiting for approval</span>}
                  {s.disabled && <span className="badge muted-badge">off</span>}
                  {s.source && (
                    <span className="badge muted-badge" title={`Installed from the package ${s.source.folder}`}>
                      package{s.source.label ? ` ${s.source.label}` : ''}
                      {s.source.installed !== s.version ? ', changed here' : ''}
                    </span>
                  )}
                  <span className="skill-actions">
                    {s.pending && (
                      <button
                        type="button"
                        className="icon-btn small"
                        aria-label={`Approve ${s.name}`}
                        title="Approve: let every Boton it is enabled for use it"
                        onClick={() => void attempt(`approve ${s.name}`, () => actions.approveSkill(s.name, s.version))}
                      >
                        <CheckIcon size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn ghost small"
                      aria-expanded={managing === s.name}
                      aria-label={`Details of ${s.name}: who can use it, on or off, earlier texts`}
                      onClick={() => setManaging(managing === s.name ? null : s.name)}
                    >
                      Details
                    </button>
                    <button type="button" className="icon-btn small" aria-label={`Edit ${s.name}`} title="Edit" onClick={() => setEditing(s)}>
                      <EditIcon size={14} />
                    </button>
                    <button type="button" className="icon-btn small" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => setDeleting(s)}>
                      <TrashIcon size={14} />
                    </button>
                  </span>
                </div>
                <p className="skill-description">{s.description}</p>
                {s.pending && (
                  <details className="skill-procedure">
                    <summary>Read the procedure</summary>
                    <pre className="file-text">{s.body}</pre>
                  </details>
                )}
                {managing === s.name && <SkillManage name={s.name} onDone={() => setManaging(null)} />}
                <span className="hint">
                  {attribution(s, owner)}
                  {s.pending && s.updatedBy.kind === 'boton' && ` · only ${s.updatedBy.name} can use it until you approve it`}
                </span>
              </li>
            ),
          )}
        </ul>
      </div>
      {deleting && (
        <ConfirmDialog
          title={`Delete the skill ${deleting.name}?`}
          confirmLabel="Delete"
          what={`delete ${deleting.name}`}
          danger
          onConfirm={() => actions.deleteSkill(deleting.name)}
          onClose={() => setDeleting(null)}
        >
          <p>Botons stop seeing it from their next turn on, and /{deleting.name} becomes plain text. A skill that a routine follows can't be deleted; change the routine first.</p>
        </ConfirmDialog>
      )}
    </Dialog>
  );
}

function SkillForm({ skill, onDone }: { skill?: Skill; onDone: () => void }) {
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onBody = (text: string) => {
    const md = parseSkillMd(text);
    if (!md) return setBody(text);
    if (!skill && md.name && !name) setName(md.name);
    if (md.description && !description) setDescription(md.description);
    setBody(md.body);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await actions.saveSkill(skill?.name ?? null, { name: name.trim(), description, body });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="skill-form">
      {!skill && (
        <label>
          <span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="weekly-report" maxLength={64} autoComplete="off" spellCheck={false} />
          <span className="hint">Lowercase words joined by hyphens. You run it with /{name.trim() || 'name'}.</span>
        </label>
      )}
      <label>
        <span className="field-label">Description</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1024} placeholder="What it does and when to use it, e.g. Write the weekly report for a repository." />
      </label>
      <label>
        <span className="field-label">Procedure</span>
        <textarea className="skill-body" value={body} onChange={(e) => onBody(e.target.value)} rows={12} placeholder={'The steps, in Markdown. Pasting a SKILL.md fills in the name and description too.'} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy || !description.trim() || !body.trim() || (!skill && !name.trim())} onClick={() => void save()}>
          {busy ? 'Saving…' : skill ? 'Save' : 'Add skill'}
        </button>
      </div>
    </div>
  );
}

export function SkillsField({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
  const { skills, error } = useSkills();
  const id = useId();
  const list = value ?? [];
  const missing = list.filter((n) => skills && !skills.some((s) => s.name === n));
  return (
    <fieldset className="connections">
      <legend className="field-label">Skills</legend>
      <p className="hint">Which skills from the library this Boton sees and may follow. Changing them keeps its conversation.</p>
      <label className="check">
        <input type="radio" name={`${id}-skills`} checked={value === null} onChange={() => onChange(null)} />
        <span>Every skill, including new ones</span>
      </label>
      <label className="check">
        <input type="radio" name={`${id}-skills`} checked={value !== null} onChange={() => onChange(value ?? [])} />
        <span>Only these</span>
      </label>
      {value !== null && (
        <div className="connections-group">
          {skills?.length === 0 && <p className="empty-note">No skills in the library yet.</p>}
          {skills?.map((s) => (
            <label key={s.name} className="check connector">
              <input type="checkbox" checked={list.includes(s.name)} onChange={(e) => onChange(e.target.checked ? [...list, s.name] : list.filter((n) => n !== s.name))} />
              <span className="connector-text">
                <span className="connector-name">{s.name}</span>
                <span className="connector-target">{s.description}</span>
                {pendingFor(s) && <span className="hint">Waiting for your approval: until then only {pendingFor(s)!.name} can use it</span>}
              </span>
            </label>
          ))}
          {missing.map((n) => (
            <label key={n} className="check connector">
              <input type="checkbox" checked onChange={() => onChange(list.filter((x) => x !== n))} />
              <span className="connector-text">
                <span className="connector-name">{n}</span>
                <span className="hint">Not in the library any more</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </fieldset>
  );
}
