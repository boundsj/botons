import { installCommand } from '../../../shared/install-commands.ts';
import { useEffect, useRef, useState } from 'react';
import type {
  PortableConnectorAction,
  PortableExport,
  PortableImportChoices,
  PortableImportPreview,
  PortableImportResult,
  PortableBotonPlan,
  PortableSidebarMode,
  PortableSkillAction,
  PortableTemplateAction,
} from '../../../shared/types.ts';
import { api } from '../api.ts';
import { actions, useStore } from '../state.ts';

/** The server takes at most this much: the file and the choices. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

const SKILL_ACTION: Record<PortableSkillAction, string> = { create: 'Add it', replace: "Replace this server's", keep: "Keep this server's", skip: 'Leave it out' };
const TEMPLATE_ACTION: Record<PortableTemplateAction, string> = { create: 'Add it', skip: 'Leave it out' };
const CONNECTOR_ACTION: Record<PortableConnectorAction, string> = { create: 'Add it (turned off)', keep: "Keep this server's", skip: 'Leave it out' };
const SIDEBAR_MODE: Record<PortableSidebarMode, string> = {
  replace: "Arrange the sidebar as the file has it (groups the file lacks are removed; no Boton is)",
  merge: "Put the new Botons in the file's groups, adding the groups this server lacks",
  skip: 'Leave the sidebar as it is (new Botons go among the ungrouped)',
};

const access = (a: 'workspace' | 'host') => (a === 'host' ? 'Full computer' : 'Workspace');
const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
const listText = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');
const usd = (v: number | null) => (v === null ? 'none' : `$${v}`);

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function BotonPlan({ m, onChange }: { m: PortableBotonPlan; onChange: (c: { action?: 'create' | 'skip'; provider?: string; fullAccess?: boolean; alwaysAllow?: boolean; caps?: 'file' | 'none' }) => void }) {
  const on = m.action === 'create';
  const fileCaps = [m.caps.daily.file !== null && `${usd(m.caps.daily.file)} a day`, ...m.routines.filter((r) => r.perRunCap.file !== null).map((r) => `${usd(r.perRunCap.file)} a run for “${r.name}”`)].filter(Boolean);
  return (
    <li className="config-item" data-ref={m.ref}>
      <label className="config-choice">
        <input type="checkbox" checked={on} onChange={(e) => onChange({ action: e.target.checked ? 'create' : 'skip' })} />
        <strong>{m.name}</strong>
        {m.conflict && <span className="hint warn"> · a Boton here already has this name{on ? ': this adds another' : ''}</span>}
      </label>
      {on && (
        <div className="config-details">
          <label className="config-inline">
            <span className="field-label">Brain</span>
            <select value={m.provider.imported} onChange={(e) => onChange({ provider: e.target.value })}>
              {m.provider.options.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            {!m.provider.available && <span className="hint warn"> {m.provider.file} isn't on this server</span>}
          </label>
          <ul className="hint config-facts">
            <li>
              Model: {m.model.imported || 'the brain’s default'}
              {m.model.file !== m.model.imported && ` (the file has ${m.model.file || 'the default'})`}; effort: {m.effort.imported || 'default'}
              {m.effort.file !== m.effort.imported && ` (the file has ${m.effort.file}, which this brain or model doesn't take)`}
            </li>
            <li>
              Computer access: {access(m.access.imported)}
              {m.access.file === 'host' && (
                <label className="config-inline">
                  {' '}
                  <input type="checkbox" checked={m.access.imported === 'host'} onChange={(e) => onChange({ fullAccess: e.target.checked })} /> give it Full computer access, as
                  the file has
                </label>
              )}
            </li>
            <li>
              Always allow: {listText(m.alwaysAllow.imported)}
              {m.alwaysAllow.file.length > 0 && (
                <label className="config-inline">
                  {' '}
                  <input type="checkbox" checked={m.alwaysAllow.imported.length > 0} onChange={(e) => onChange({ alwaysAllow: e.target.checked })} /> keep the file's{' '}
                  {listText(m.alwaysAllow.file)}
                </label>
              )}
            </li>
            <li>Ask first: {listText(m.askFirst)}</li>
            <li className="config-caps">
              Spending caps: {m.caps.daily.imported === null ? 'none a day' : `${usd(m.caps.daily.imported)} a day`}, starting at $0 here
              {!m.caps.applies && fileCaps.length > 0 && ' (they count only API-key turns, and this brain isn’t one)'}
              {m.caps.unpriced && <span className="warn"> · a capped model has no known price here: see the spending notes</span>}
              {fileCaps.length > 0 && ` · the file has ${fileCaps.join(', ')}`}
              {fileCaps.length > 0 && (
                <label className="config-inline">
                  {' '}
                  <input type="checkbox" checked={m.caps.choice === 'file'} onChange={(e) => onChange({ caps: e.target.checked ? 'file' : 'none' })} /> keep the file's caps
                </label>
              )}
            </li>
            <li>
              Connectors: {listText(m.connections.imported)}
              {m.connections.live.length > 0 && <span className="warn"> · usable at once with this server's own setup: {m.connections.live.join(', ')}</span>}
              {m.connections.dropped.map((d) => ` · without ${d.id} (${d.why})`).join('')}
            </li>
            <li>
              Skills: {m.skills.imported === null ? 'every skill in the library' : listText(m.skills.imported)}
              {m.skills.dropped.map((d) => ` · without ${d.name} (${d.why})`).join('')}
            </li>
            {(m.browserSites.imported.length > 0 || m.browserSites.dropped.length > 0) && (
              <li>
                Browser sites: {listText(m.browserSites.imported)}
                {m.browserSites.dropped.length > 0 && ` · without ${m.browserSites.dropped.join(', ')} (not allowed with ${access(m.access.imported)} access here)`}
              </li>
            )}
            {m.paused && <li>Paused, as in the file</li>}
            {m.routines.map((r) => (
              <li key={r.name}>
                Routine “{r.name}”: {r.schedule ?? 'no schedule'}
                {r.webhook && `, webhook (new URL and key${r.fullAccessWebhook.imported ? ', runs with Full computer access' : r.fullAccessWebhook.file ? ', with Workspace access here' : ''})`}
                {r.skill.file && (r.skill.imported ? `, follows ${r.skill.imported}` : `, without its skill ${r.skill.file}`)}
                {r.model.file !== r.model.imported && `, model ${r.model.imported ?? "the Boton's"}`}
                {r.effort.file !== r.effort.imported && `, effort ${r.effort.imported ?? "the Boton's"}`}
                {r.perRunCap.imported !== null && `, at most ${usd(r.perRunCap.imported)} a run`}
                {', arrives off'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function Preview({ preview, busy, onChoices, onImport }: { preview: PortableImportPreview; busy: boolean; onChoices: (c: PortableImportChoices) => void; onImport: () => void }) {
  const c = preview.choices;
  const making = preview.botons.filter((m) => m.action === 'create').length;
  return (
    <div className="config-preview" aria-label="What importing would do">
      <p className="hint">
        Made by Botons {preview.source.app} (schema {preview.source.schema}) on {new Date(preview.source.exportedAt).toLocaleString()}, format version {preview.source.version}
        {preview.upgradedFrom !== null && `, upgraded to this server's version to read it`}. Nothing changes until you import.
      </p>
      {preview.textWarnings.length > 0 && (
        <p className="hint warn">Something shaped like a credential is in: {preview.textWarnings.join('; ')}. It is imported as written: check it after.</p>
      )}
      <h5>Botons ({making} of {preview.botons.length})</h5>
      {preview.spending.notes.length > 0 && (
        <ul className="hint config-facts config-spending">
          {preview.spending.notes.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      <ul className="config-list">
        {preview.botons.map((m) => (
          <BotonPlan key={m.ref} m={m} onChange={(x) => onChoices({ ...c, botons: { ...c.botons, [m.ref]: { ...c.botons[m.ref], ...x } } })} />
        ))}
      </ul>
      {preview.skills.length > 0 && (
        <>
          <h5>Skills</h5>
          <p className="hint">A skill is text a Boton follows: it grants nothing. Fields like allowed-tools are listed, never applied.</p>
          <ul className="config-list">
            {preview.skills.map((s) => (
              <li key={s.name} className="config-item">
                <label className="config-inline">
                  <strong>{s.name}</strong>{' '}
                  <select value={s.action} onChange={(e) => onChoices({ ...c, skills: { ...c.skills, [s.name]: e.target.value as PortableSkillAction } })}>
                    {(s.exists ? (['keep', 'replace', 'skip'] as const) : (['create', 'skip'] as const)).map((a) => (
                      <option key={a} value={a}>
                        {SKILL_ACTION[a]}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="hint">
                  {s.exists && (s.sameText ? ' · the same text is here' : ' · this server has another text under this name')}
                  {s.disabled && ' · turned off'}
                  {s.pending && ' · written by a Boton, waits for your approval'}
                  {s.source && ` · from the package ${s.source}`}
                  {s.history > 0 && ` · ${s.history} earlier text${s.history === 1 ? '' : 's'}`}
                  {s.asks.length > 0 && ` · asks for or points at: ${s.asks.join(', ')}`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {preview.connectors.length > 0 && (
        <>
          <h5>Connectors</h5>
          <p className="hint">New ones arrive turned off and without their secrets or sign-ins, which are never in the file.</p>
          <ul className="config-list">
            {preview.connectors.map((x) => (
              <li key={x.id} className="config-item">
                <label className="config-inline">
                  <strong>{x.name}</strong>{' '}
                  <select value={x.action} onChange={(e) => onChoices({ ...c, connectors: { ...c.connectors, [x.id]: e.target.value as PortableConnectorAction } })}>
                    {(x.exists ? (['keep', 'skip'] as const) : (['create', 'skip'] as const)).map((a) => (
                      <option key={a} value={a}>
                        {CONNECTOR_ACTION[a]}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="hint">
                  {' '}
                  {x.kind === 'oauth' ? 'sign-in connector' : x.runsCommand ? 'runs a command in the turns of Botons that have it:' : 'MCP server at'} <code>{x.target}</code>
                  {x.secrets.length > 0 && ` · needs ${x.secrets.join(', ')}`}
                  {x.onRequest && ` · Botons may ask for it (${x.grant === 'immediate' ? 'given at once' : 'with your approval'})`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {preview.templates.length > 0 && (
        <>
          <h5>Saved templates</h5>
          <p className="hint">A template only fills in the New Boton form: nothing in it runs or is given to a Boton until you make one from it.</p>
          <ul className="config-list">
            {preview.templates.map((t) => (
              <li key={t.ref} className="config-item">
                <label className="config-inline">
                  <strong>{t.name}</strong>{' '}
                  <select value={t.action} onChange={(e) => onChoices({ ...c, templates: { ...c.templates, [t.ref]: e.target.value as PortableTemplateAction } })}>
                    {(['create', 'skip'] as const).map((a) => (
                      <option key={a} value={a}>
                        {TEMPLATE_ACTION[a]}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="hint">
                  {' '}
                  {count(t.routines, 'routine')}
                  {t.same && ' · the same template is saved here'}
                  {t.narrowed.length > 0 && ` · without ${t.narrowed.join('; ')}`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h5>Settings and sidebar</h5>
      <label className="config-inline">
        <input type="checkbox" checked={c.settings} onChange={(e) => onChoices({ ...c, settings: e.target.checked })} /> Use the file's settings
      </label>
      {c.settings && (
        <ul className="hint config-facts">
          {preview.settings.changes.length ? preview.settings.changes.map((x) => <li key={x.field}>{`${x.field}: ${x.from || '(none)'} → ${x.to || '(none)'}`}</li>) : <li>The same as here.</li>}
          {preview.settings.notes.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      <label className="config-inline">
        <span className="field-label">Sidebar</span>
        <select value={c.sidebar} onChange={(e) => onChoices({ ...c, sidebar: e.target.value as PortableSidebarMode })}>
          {(['replace', 'merge', 'skip'] as const).map((m) => (
            <option key={m} value={m}>
              {SIDEBAR_MODE[m]}
            </option>
          ))}
        </select>
      </label>
      {preview.reconnect.length > 0 && (
        <>
          <h5>To do by hand after importing</h5>
          <ul className="hint config-facts config-reconnect">
            {preview.reconnect.map((r, i) => (
              <li key={i}>{r.text}</li>
            ))}
          </ul>
        </>
      )}
      <div className="form-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={onImport}>
          {busy ? 'Working…' : 'Import'}
        </button>
      </div>
    </div>
  );
}

/** Settings → Move to another server: the configuration as a file without secrets, and back, with a preview. */
export function ConfigTransfer() {
  const install = useStore(st => st.info?.install ?? 'service');
  const [exported, setExported] = useState<PortableExport | null>(null);
  const [file, setFile] = useState<unknown>(null);
  const [preview, setPreview] = useState<PortableImportPreview | null>(null);
  const [result, setResult] = useState<PortableImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef<HTMLDivElement>(null);
  // The preview it replaces was long: what was made, and what is still to do, are where the owner looks next.
  useEffect(() => {
    if (result) done.current?.scrollIntoView({ block: 'nearest' });
  }, [result]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const choose = (choices: PortableImportChoices) => run(async () => setPreview(await api.previewConfigImport({ file, choices })));

  return (
    <section className="server-info config-transfer">
      <h4>Move to another server</h4>
      <p className="hint">
        Export your configuration (Botons with their routines, rules and browser sites, skills, connectors, saved templates, settings and the sidebar) as a file, and import it on
        another server or after a reinstall. It never holds chats, memories, workspace files, connector secrets, sign-ins, tokens, webhook keys or API keys:
        a full backup (<code>{installCommand(install, 'backup')}</code>, restored with <code>{installCommand(install, 'restore')}</code>) holds everything, and stays the way to recover a whole server.
      </p>
      <div className="form-actions">
        <button
          type="button"
          className="btn small"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const out = await api.exportConfig();
              setExported(out);
              download(`botons-config-${out.file.exportedAt.slice(0, 10)}.json`, out.file);
            })
          }
        >
          Export configuration
        </button>
        <button type="button" className="btn small" disabled={busy} onClick={() => input.current?.click()}>
          Import a configuration…
        </button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="Configuration file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setResult(null);
            setPreview(null);
            void run(async () => {
              if (f.size > MAX_FILE_BYTES) throw new Error('That file is larger than a configuration can be (16 MB).');
              // Read as strict UTF-8: File.text() would turn broken bytes into U+FFFD, and the import would carry them.
              let text: string;
              try {
                text = new TextDecoder('utf-8', { fatal: true }).decode(await f.arrayBuffer());
              } catch {
                throw new Error('That file is not UTF-8 text: choose a file made by Export configuration.');
              }
              let parsed: unknown;
              try {
                parsed = JSON.parse(text);
              } catch {
                throw new Error('That file is not JSON: choose a file made by Export configuration.');
              }
              setFile(parsed);
              setPreview(await api.previewConfigImport({ file: parsed }));
            });
          }}
        />
      </div>
      {exported && (
        <div className="config-exported">
          <p className="hint">
            Downloaded {count(exported.file.botons.length, 'Boton')}, {count(exported.file.skills.length, 'skill')} and {count(exported.file.connectors.length, 'connector')}.
            Left out, with placeholders where they were:
          </p>
          <ul className="hint config-facts">
            {exported.leftOut.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          {exported.textWarnings.length > 0 && (
            <p className="hint warn">
              Something shaped like a credential is in text you wrote, which is exported as written: {exported.textWarnings.join('; ')}. Check it before you share
              the file.
            </p>
          )}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      {preview && !result && (
        <Preview
          preview={preview}
          busy={busy}
          onChoices={(c) => void choose(c)}
          onImport={() =>
            run(async () => {
              const done = await api.importConfig({ file, choices: preview.choices, fingerprint: preview.fingerprint });
              setResult(done);
              setPreview(null);
              setFile(null);
              await Promise.all([actions.loadConnectors(), actions.loadMcpServers(), actions.loadSkills(), actions.loadOAuth()]).catch(() => {});
            })
          }
        />
      )}
      {result && (
        <div className="config-result" role="status" ref={done}>
          <p className="hint">
            Imported {count(result.botons.length, 'Boton')} ({listText(result.botons.map((m) => m.name))}), {count(result.skills.length, 'skill')},{' '}
            {count(result.templates.length, 'saved template')} and {count(result.connectors.length, 'connector')}
            {result.settings ? ', and the settings' : ''}. Every routine it made is off.
          </p>
          {result.reconnect.length > 0 && (
            <>
              <h5>Still to do</h5>
              <ul className="hint config-facts config-reconnect">
                {result.reconnect.map((r, i) => (
                  <li key={i}>{r.text}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
