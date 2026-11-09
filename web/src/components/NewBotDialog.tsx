import { useEffect, useState } from 'react';
import { randomLook } from '../../../shared/look.ts';
import type { AccessLevel, Bot, BotTemplate, TemplateReview } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { errorText } from '../feedback.ts';
import { actions, useStore } from '../state.ts';
import { cx } from '../util.ts';
import { AccessPicker, BrainPicker } from './BotFields.tsx';
import { BotonBuilder } from './BotonBuilder.tsx';
import { ConfirmDialog, Dialog } from './Dialog.tsx';
import { ClockIcon, CloseIcon, WebhookIcon } from './Icons.tsx';
import { ConnectServiceDialog } from './Connectors.tsx';
import { type Slots, StarterReview, StarterSetup } from './StarterSetup.tsx';
import { shownEffort } from '../effort.ts';

// Generic given names for a new Boton's placeholder, chosen to stay clear of film and game characters.
const NAMES = ['Juniper', 'Rowan', 'Wren', 'Marlow', 'Hazel', 'Odile', 'Tamsin', 'Ines', 'Sorrel', 'Linden', 'Indigo', 'Fennel', 'Kestrel', 'Juno', 'Pax', 'Teo'];

/** `groupId`: made from that sidebar group's menu, it goes last there (unless the group is gone by then). */
export function NewBotDialog({ groupId, onClose, onCreated }: { groupId?: string; onClose: () => void; onCreated: (b: Bot) => void }) {
  const providers = useStore((s) => s.providers);
  const group = useStore((s) => (groupId ? s.sidebar?.groups.find((g) => g.id === groupId) : undefined));
  const firstAvailable = providers.find((p) => p.available && p.id !== 'mock') ?? providers.find(p => p.available) ?? providers[0];
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [look, setLook] = useState(randomLook);
  const [provider, setProvider] = useState(firstAvailable?.id ?? 'claude-cli');
  const [model, setModel] = useState(firstAvailable?.defaultModel ?? '');
  const [effort, setEffort] = useState('');
  const [access, setAccess] = useState<AccessLevel>('workspace');
  const workspaceProblem = providers.find(p => p.id === provider)?.workspaceProblem;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placeholder] = useState(() => NAMES[Math.floor(Math.random() * NAMES.length)]);
  const [templates, setTemplates] = useState<BotTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [template, setTemplate] = useState<BotTemplate | null>(null);
  const [startRoutines, setStartRoutines] = useState(false);
  const [deleting, setDeleting] = useState<BotTemplate | null>(null);
  // A starter: the slots the owner filled, the review shown, and once installed, the Boton being set up.
  const [slots, setSlots] = useState<Slots>({});
  const [review, setReview] = useState<TemplateReview | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [installed, setInstalled] = useState<Bot | null>(null);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => { if (workspaceProblem) setAccess('host'); }, [workspaceProblem, provider, template]);
  const starter = !!template?.needs;
  useEffect(() => {
    actions.loadProviders().catch(() => {});
    api
      .templates()
      .then(setTemplates)
      .catch((e) => setTemplatesError(errorText(e)));
  }, []);

  const pick = (t: BotTemplate | null) => {
    setTemplate(t);
    setError(null);
    setName(t?.bot.name ?? '');
    setTitle(t?.bot.title ?? '');
    setInstructions(t?.bot.instructions ?? '');
    setLook(t?.bot.look ?? randomLook());
    const brain = t?.bot.provider ? providers.find((p) => p.id === t.bot.provider) : undefined;
    setProvider(brain?.id ?? firstAvailable?.id ?? 'claude-cli');
    setModel(brain ? t!.bot.model : (firstAvailable?.defaultModel ?? ''));
    setEffort(brain ? (t!.bot.effort ?? '') : '');
    setAccess((brain ?? firstAvailable)?.workspaceProblem ? 'host' : (t?.needs?.access ?? t?.bot.access ?? 'workspace'));
    setSlots(Object.fromEntries((t?.needs?.connectors ?? []).map((c) => [c.slot, null])));
    setReview(null);
    // A saved Boton's routines may already run on that Boton, so they start paused unless asked; a starter's always do.
    setStartRoutines(false);
  };

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const fields = { name: name.trim() || placeholder, title, instructions, look, provider, model: model.trim(), effort: shownEffort(providers.find((p) => p.id === provider), model, effort), access };
      if (template?.needs) {
        if (!review || review.blocked.length) throw new Error('Review what it grants first');
        const bot = await actions.createBot({
          ...fields,
          ...(group ? { groupId: group.id } : {}),
          templateId: template.id,
          starterConnectors: slots,
          reviewKey: review.reviewKey,
        });
        setInstalled(bot);
        setSaving(false);
        return;
      }
      const bot = await actions.createBot(
        template
          ? {
              ...fields,
              // The group it is made from wins over the template's.
              ...(group ? { groupId: group.id } : template.bot.group ? { group: template.bot.group } : {}),
              ...(template.bot.timezone ? { timezone: template.bot.timezone } : {}),
              templateId: template.id,
              startRoutines,
            }
          : { ...fields, ...(group && { groupId: group.id }) },
      );
      onCreated(bot);
    } catch (e) {
      setError((e as Error).message);
      // Stale: what it grants changed since the review shown; show the new one, for the owner to confirm again.
      if (e instanceof ApiError && e.status === 409) setRefresh((x) => x + 1);
      setSaving(false);
    }
  };

  if (installed && template) {
    return (
      <Dialog title={`Set up ${installed.name}`} onClose={() => onCreated(installed)} wide>
        <StarterSetup bot={installed} template={template} onDone={() => onCreated(installed)} />
      </Dialog>
    );
  }

  return (
    <Dialog title="New Boton" onClose={onClose} wide>
      <form
        className="new-bot"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="template-picker" role="group" aria-label="Start from">
          <span className="field-label">Start from</span>
          <div className="template-chips">
            <button type="button" className={cx('template-chip', !template && 'on')} aria-pressed={!template} onClick={() => pick(null)}>
              Blank
            </button>
            {templates?.map((t) => (
              <span key={t.id} className={cx('template-chip', template?.id === t.id && 'on')}>
                <button type="button" aria-pressed={template?.id === t.id} title={t.description} onClick={() => pick(t)}>
                  {t.name}
                </button>
                {!t.builtin && (
                  <button type="button" className="template-remove" aria-label={`Delete template ${t.name}`} title="Delete template" onClick={() => setDeleting(t)}>
                    <CloseIcon size={12} />
                  </button>
                )}
              </span>
            ))}
            {!templates && !templatesError && <span className="hint">Loading templates…</span>}
            {templatesError && <span className="hint warn">Couldn't load templates: {templatesError}</span>}
          </div>
          {template && <p className="hint">{template.description}</p>}
        </div>
        <BotonBuilder look={look} onChange={setLook} />
        <div className="look-row two">
          <label>
            <span className="field-label">Name</span>
            <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={60} />
          </label>
          <label>
            <span className="field-label">Role</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Morning briefer" maxLength={80} />
          </label>
        </div>
        <label>
          <span className="field-label">Instructions (optional)</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={4}
            placeholder="What should this Boton own? You can also just tell it in the chat."
          />
        </label>
        <BrainPicker
          providers={providers}
          provider={provider}
          model={model}
          effort={effort}
          onChange={(p, m) => {
            setProvider(p);
            setModel(m);
          }}
          onEffort={setEffort}
        />
        <AccessPicker problem={workspaceProblem} value={access} onChange={setAccess} />
        {starter && template && (
          <StarterReview template={template} provider={provider} access={access} slots={slots} onSlots={setSlots} onReview={setReview} refresh={refresh} onConnect={() => setConnecting(true)} />
        )}
        {template && !starter && template.routines.length > 0 && (
          <div className="template-routines">
            <span className="field-label">Routines from the template</span>
            <ul>
              {template.routines.map((r, i) => (
                // Names needn't be unique; the list never changes order.
                <li key={`${i}-${r.name}`}>
                  <ClockIcon size={14} />
                  <span>{r.name}</span>
                  <span className="hint">
                    {r.scheduleText ?? 'No schedule'}
                    {r.webhook && (
                      <>
                        {' · '}
                        <WebhookIcon size={12} /> {r.webhookSource === 'generic' ? 'webhook' : `webhook from ${r.webhookSource}`} (a new URL and key
                        {r.webhookSource !== 'generic' && r.webhookSource !== 'github' ? '; save its signing secret again' : ''})
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <label className="check">
              <input type="checkbox" checked={startRoutines} onChange={(e) => setStartRoutines(e.target.checked)} />
              <span>Turn them on now (otherwise they start paused)</span>
            </label>
          </div>
        )}
        {group && (
          <p className="hint">
            It goes in the group <strong>{group.name}</strong>.
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {starter ? (
            <button type="submit" className="btn primary" disabled={saving || !review || review.blocked.length > 0}>
              {saving ? 'Installing…' : `Install ${name.trim() || placeholder}, paused`}
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? 'Creating…' : `Create ${name.trim() || placeholder}`}
            </button>
          )}
        </div>
      </form>
      {connecting && (
        <ConnectServiceDialog
          onClose={() => {
            setConnecting(false);
            setRefresh((x) => x + 1);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete the template “${deleting.name}”?`}
          confirmLabel="Delete template"
          what="delete the template"
          danger
          onConfirm={async () => {
            await api.deleteTemplate(deleting.id);
            setTemplates((list) => list?.filter((t) => t.id !== deleting.id) ?? null);
            if (template?.id === deleting.id) pick(null);
          }}
          onClose={() => setDeleting(null)}
        >
          <p>New Botons can no longer start from it. Botons already made from it are not affected.</p>
        </ConfirmDialog>
      )}
    </Dialog>
  );
}
