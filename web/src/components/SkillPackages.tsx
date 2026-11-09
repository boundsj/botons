import { useEffect, useState } from 'react';
import type { DiffLine, Skill, SkillDetails, SkillBotonAccess, SkillPackage, SkillPackageReview, SkillPackagesList } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { errorText } from '../feedback.ts';
import { actions } from '../state.ts';
import { relative } from '../util.ts';
import { ACTIONS, detailText } from './Setup.tsx';

const STATE_TEXT: Record<SkillPackage['state'], string> = {
  new: 'not installed',
  current: 'installed, up to date',
  update: 'update available',
  changed: 'changed here since installing',
  conflict: 'name taken',
  invalid: "can't be installed",
};

const is409 = (e: unknown) => (e as { status?: number }).status === 409;
const names = (list: SkillBotonAccess[]) => list.map((m) => m.name).join(', ');

/** Unchanged runs longer than this fold to their first and last lines. */
const CONTEXT = 2;

function Diff({ lines, label }: { lines: DiffLine[]; label: string }) {
  const changed = lines.some((l) => l.op !== 'same');
  const rows: (DiffLine | { op: 'fold'; count: number })[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].op !== 'same') {
      rows.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].op === 'same') j++;
    // An unchanged run keeps a few lines next to each change and folds the rest.
    const keepHead = i === 0 ? 0 : CONTEXT;
    const keepTail = j === lines.length ? 0 : CONTEXT;
    const folded = j - i - keepHead - keepTail;
    if (changed && folded > 1) rows.push(...lines.slice(i, i + keepHead), { op: 'fold', count: folded }, ...lines.slice(j - keepTail, j));
    else rows.push(...lines.slice(i, j));
    i = j;
  }
  return (
    <figure className="skill-diff">
      <figcaption className="field-label">
        {label} {!changed && <span className="badge muted-badge">unchanged</span>}
      </figcaption>
      <pre aria-label={`${label}: lines removed start with a minus, lines added with a plus`}>
        {rows.map((r, i) =>
          r.op === 'fold' ? (
            <span key={i} className="diff-fold">
              {`  … ${r.count} unchanged line${r.count === 1 ? '' : 's'}\n`}
            </span>
          ) : (
            <span key={i} className={`diff-${r.op}`}>
              {`${r.op === 'add' ? '+' : r.op === 'remove' ? '−' : ' '} ${r.text}\n`}
            </span>
          ),
        )}
      </pre>
    </figure>
  );
}

/** Checkboxes for exactly which Botons have a skill; what each one's change means is said next to it. */
function BotonChecks(props: { botons: SkillBotonAccess[]; draft: ReadonlySet<string>; onToggle: (id: string, on: boolean) => void; busy: boolean; skill: string }) {
  if (!props.botons.length) return <p className="empty-note">No Botons yet.</p>;
  return (
    <ul className="connector-access-list">
      {props.botons.map((m) => {
        const want = props.draft.has(m.botId);
        return (
          <li key={m.botId}>
            <label className="check connector">
              <input type="checkbox" checked={want} disabled={props.busy} onChange={(e) => props.onToggle(m.botId, e.target.checked)} />
              <span className="connector-text">
                <span className="connector-name">
                  {m.name}{' '}
                  {m.has && !want ? (
                    <span className="badge warn-badge">loses it</span>
                  ) : !m.has && want ? (
                    <span className="badge">gets it</span>
                  ) : m.has ? (
                    <span className="badge">has it</span>
                  ) : null}
                </span>
                {m.every && (
                  <span className={want ? 'hint' : 'hint warn'}>
                    {want ? 'Uses every skill, including new ones.' : `Uses every skill now: without ${props.skill} it gets a list of every other skill, and no new ones unless you give them.`}
                  </span>
                )}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

const toggle = (set: (f: (d: Set<string>) => Set<string>) => void) => (id: string, on: boolean) =>
  set((d) => {
    const next = new Set(d);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });

const holders = (botons: SkillBotonAccess[]) => new Set(botons.filter((m) => m.has).map((m) => m.botId));

/** The packages folder: each package with where it stands, and a review before anything installs. */
export function SkillPackages({ onDone }: { onDone: () => void }) {
  const [list, setList] = useState<SkillPackagesList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try {
      setList(await api.skillPackages());
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => void load(), []);

  if (reviewing) return <PackageReview folder={reviewing} onBack={() => (setReviewing(null), void load())} />;
  return (
    <section className="skill-form skill-packages" aria-labelledby="skill-packages-title">
      <div className="skill-head">
        <h3 id="skill-packages-title" className="field-label">
          Install from a package
        </h3>
        <span className="skill-actions">
          <button type="button" className="btn ghost small" onClick={() => void load()}>
            Look again
          </button>
          <button type="button" className="btn ghost small" onClick={onDone}>
            Close
          </button>
        </span>
      </div>
      <p className="hint">
        Put each package in its own folder on the server, holding a SKILL.md: <code className="path">{list?.dir ?? '…'}</code>. Botons reads only SKILL.md's text: it
        never runs, unpacks or follows anything there, and installs nothing until you review exactly what changes and who gets it.
      </p>
      {error && <p className="form-error">{error}</p>}
      {list && !list.exists && <p className="empty-note">That folder doesn't exist yet. Make it, put a package folder in it, then look again.</p>}
      {list?.exists && list.packages.length === 0 && <p className="empty-note">No packages there yet.</p>}
      {list && list.packages.length > 0 && (
        <ul className="skill-list">
          {list.packages.map((p) => (
            <li key={p.folder} className="skill-item">
              <div className="skill-head">
                <code className="skill-name">{p.folder}</code>
                {p.label && <span className="badge muted-badge">{p.label}</span>}
                <span className={p.state === 'invalid' || p.state === 'conflict' ? 'badge warn-badge' : p.state === 'current' ? 'badge muted-badge' : 'badge'}>{STATE_TEXT[p.state]}</span>
                <span className="skill-actions">
                  {p.state !== 'invalid' && (
                    <button type="button" className="btn small" onClick={() => setReviewing(p.folder)} aria-label={`Review ${p.folder}`}>
                      Review
                    </button>
                  )}
                </span>
              </div>
              {p.description && <p className="skill-description">{p.description}</p>}
              {p.problems.map((x) => (
                <p key={x} className="hint warn">
                  {x}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PackageReview({ folder, onBack }: { folder: string; onBack: () => void }) {
  const [review, setReview] = useState<SkillPackageReview | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState<Skill | null>(null);
  const load = async () => {
    setError(null);
    setStale(false);
    setRead(false);
    try {
      const r = await api.reviewSkillPackage(folder);
      setReview(r);
      setDraft(holders(r.botons));
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => void load(), [folder]);

  if (!review) return error ? <p className="form-error">{error}</p> : <p className="hint">Loading…</p>;
  const installable = review.state === 'new' || review.state === 'update' || review.state === 'changed';
  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const skill = await api.installSkillPackage(folder, {
        version: review.version!,
        fingerprint: review.fingerprint!,
        current: review.installed?.version ?? null,
        accept: review.newAsks,
        botIds: [...draft],
        expected: [...holders(review.botons)],
      });
      actions.skillChanged(skill);
      setDone(skill);
    } catch (e) {
      setError(errorText(e));
      if (is409(e)) setStale(true);
    } finally {
      setBusy(false);
    }
  };
  const gets = review.botons.filter((m) => draft.has(m.botId));
  const verb = review.installed ? 'Update' : 'Install';

  return (
    <section className="skill-form skill-review" aria-labelledby="skill-review-title">
      <div className="skill-head">
        <h3 id="skill-review-title" className="field-label">
          {verb === 'Update' ? 'Update' : 'Install'} <code className="skill-name">/{folder}</code>
        </h3>
        {review.label && <span className="badge muted-badge">{review.label}</span>}
        <span className="badge">{STATE_TEXT[review.state]}</span>
      </div>
      {done ? (
        <>
          <p className="hint" role="status">
            {verb === 'Update' ? 'Updated' : 'Installed'} /{done.name}. {gets.length ? `${names(gets)} can use it from their next turn on.` : 'No Boton has it yet.'} Its earlier text is
            kept: you can put it back from the skill's details.
          </p>
          <div className="form-actions">
            <button type="button" className="btn primary small" onClick={onBack} data-autofocus>
              Back to packages
            </button>
          </div>
        </>
      ) : (
        <>
          {review.problems.map((x) => (
            <p key={x} className="hint warn">
              {x}
            </p>
          ))}
          {installable && review.installed?.source && review.installed.source.installed !== review.installed.version && <p className="hint warn">You changed this skill here since installing it. Installing the package again replaces your changes; they stay in its earlier texts.</p>}
          {review.installed?.disabled && <p className="hint">The skill is turned off, and stays off.</p>}
          <Diff label="Description" lines={review.diff.description} />
          <Diff label="Procedure" lines={review.diff.body} />
          {review.diff.details.length > 0 && <Diff label="Package details" lines={review.diff.details} />}
          <div>
            <span className="field-label">What it asks for or points at</span>
            {review.asks.length === 0 ? (
              <p className="hint">Nothing beyond its text.</p>
            ) : (
              <ul className="skill-asks">
                {review.asks.map((a) => (
                  <li key={a}>
                    {a} {review.newAsks.includes(a) && <span className="badge warn-badge">{review.installed ? 'new in this version' : 'new'}</span>}
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">A skill grants nothing: a Boton can only do what its access and connectors let it. Fields like allowed-tools are shown, never applied.</p>
          </div>
          {review.otherFiles.length > 0 && (
            <details className="connector-history">
              <summary>Not installed: {review.otherFiles.length} other file{review.otherFiles.length === 1 ? '' : 's'} in the folder</summary>
              <p className="hint">Only SKILL.md's text is installed. A procedure that relies on these files won't find them.</p>
              <ul className="skill-asks">
                {review.otherFiles.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {installable && (
            <fieldset className="connections">
              <legend className="field-label">Who can use it</legend>
              <BotonChecks botons={review.botons} draft={draft} busy={busy} skill={folder} onToggle={toggle(setDraft)} />
            </fieldset>
          )}
          {installable && review.newAsks.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} disabled={busy} />
              <span>I've read what's new in what it asks for or points at</span>
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={stale ? () => void load() : onBack} disabled={busy}>
              {stale ? 'Review again' : 'Back'}
            </button>
            {installable && !stale && (
              <button type="button" className="btn primary" disabled={busy || (review.newAsks.length > 0 && !read)} onClick={() => void install()}>
                {busy ? 'Saving…' : `${verb} for ${gets.length === 1 ? '1 Boton' : `${gets.length} Botons`}`}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** One skill's Botons, on or off, earlier texts and history. */
export function SkillManage({ name, onDone }: { name: string; onDone: () => void }) {
  const [details, setDetails] = useState<SkillDetails | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    setStale(false);
    try {
      const d = await api.skillDetails(name);
      setDetails(d);
      setDraft(holders(d.access.botons));
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => void load(), [name]);
  if (!details) return error ? <p className="form-error">{error}</p> : <p className="hint">Loading…</p>;
  const { skill, access, history, audit } = details;

  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await what();
      await load();
      setNote(done);
    } catch (e) {
      setError(errorText(e));
      if (is409(e)) setStale(true);
    } finally {
      setBusy(false);
    }
  };
  const before = holders(access.botons);
  const gain = access.botons.filter((m) => !m.has && draft.has(m.botId));
  const lose = access.botons.filter((m) => m.has && !draft.has(m.botId));
  const source = skill.source;

  return (
    <div className="skill-form skill-manage">
      <p className="hint">
        {source ? (
          <>
            Installed from the package <code>{source.folder}</code>
            {source.label && ` (${source.label})`} {relative(source.installedAt)}
            {source.installed !== skill.version && ', and changed here since'}.
          </>
        ) : (
          'Written here, not installed from a package.'
        )}
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={!skill.disabled}
          disabled={busy}
          onChange={(e) => {
            const on = e.target.checked;
            void run(async () => actions.skillChanged(await api.setSkillEnabled(name, on)), on ? 'Turned on.' : 'Turned off.');
          }}
        />
        <span>On: Botons it is given to see it and may follow it</span>
      </label>
      {skill.disabled && <p className="hint warn">Turned off: no Boton sees it, /{name} is plain text, and routines that follow it run without it.</p>}
      <fieldset className="connections">
        <legend className="field-label">Who can use it</legend>
        <BotonChecks botons={access.botons} draft={draft} busy={busy} skill={name} onToggle={toggle(setDraft)} />
        {(gain.length > 0 || lose.length > 0) && !stale && (
          <div className="form-actions">
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => setDraft(before)}>
              Undo
            </button>
            <button type="button" className="btn primary small" disabled={busy} onClick={() => void run(() => api.setSkillAccess(name, { botIds: [...draft], expected: [...before] }), 'Saved who can use it.')}>
              {busy ? 'Saving…' : 'Save who can use it'}
            </button>
          </div>
        )}
      </fieldset>
      <details className="connector-history">
        <summary>Earlier texts ({history.length})</summary>
        {history.length === 0 ? (
          <p className="hint">None yet: when it is changed, updated or put back, the text it had is kept here.</p>
        ) : (
          <ul className="audit-list">
            {history.map((h) => (
              <li key={h.id}>
                <span>
                  {h.source ? `From ${h.source.folder}${h.source.label ? ` (${h.source.label})` : ''}` : 'Written here'} · replaced {relative(h.replacedAt)}
                  {h.version === skill.version && ' · the same as now'}
                </span>
                <details className="skill-procedure">
                  <summary>Read it</summary>
                  <p className="skill-description">{h.description}</p>
                  <pre className="file-text">{h.body}</pre>
                </details>
                {h.version !== skill.version && (
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={busy || stale}
                    onClick={() => void run(async () => actions.skillChanged(await api.restoreSkill(name, h.id, skill.version)), 'Put back. The text it replaced is kept too.')}
                  >
                    Put this back
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
      <details className="connector-history">
        <summary>History ({audit.length})</summary>
        {audit.length === 0 ? (
          <p className="hint">Nothing recorded yet.</p>
        ) : (
          <ul className="audit-list">
            {audit.map((e) => (
              <li key={e.seq}>
                <span>
                  <strong>{e.actor.label}</strong> {ACTIONS[e.action] ?? e.action}
                  {e.target ? `: ${e.target.label || e.target.id}` : ''}
                </span>
                <span className="hint">
                  <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>
                    {relative(e.at)}
                  </time>
                  {detailText(e.details) && ` · ${detailText(e.details)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {stale && (
          <button type="button" className="btn ghost small" onClick={() => void load()}>
            Look again
          </button>
        )}
        <button type="button" className="btn ghost small" onClick={onDone}>
          Close
        </button>
      </div>
    </div>
  );
}

