import { useState } from 'react';
import { ChefHat, ClipboardPaste, FileText, Lightbulb, Loader2, X } from 'lucide-react';
import { PARA, Recipe, RECIPE_FOLDER, recipeNoteTitle, recipeToMarkdown, Template, ZETTEL_TYPES, ZettelType } from '@kladde/shared';
import { api } from '../lib/api';
import { vault } from '../data/vault';
import { closeDialog, useDialog } from '../lib/dialogs';
import { folderDisplayName, tl, useLang, zettelTypeLabel } from '../lib/i18n';
import { navigate } from '../lib/router';
import { isCoarsePointer, useVisualViewport } from '../lib/viewport';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const vp = useVisualViewport();
  return (
    <div
      className="fixed inset-x-0 z-50 flex items-end justify-center sm:items-center"
      style={vp ? { top: `${vp.top}px`, height: `${vp.height}px` } : { top: 0, bottom: 0 }}
    >
      <div className="fixed inset-0 bg-black/40 anim-fade-in" onClick={onClose} />
      <div className="relative max-h-[min(90vh,100%)] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-surface px-5 pt-5 shadow-soft anim-sheet [--pad-bottom:1.25rem] safe-bottom sm:rounded-3xl">
        <div className="mb-4 flex items-center">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn-icon ml-auto" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function NewNoteDialog({ folder }: { folder?: string }) {
  const lang = useLang();
  const templates: Template[] = vault.templates();
  const [template, setTemplate] = useState<Template | null>(null);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState(folder ?? PARA.inbox);
  const folders = vault.folders();
  const choose = (t: Template | null) => {
    setTemplate(t);
    // A template brings its home folder, unless the user started from a specific folder
    if (!folder && t) setTarget(t.folder);
  };
  const create = async () => {
    const note = await vault.createFromTemplate(template, title.trim() || (template?.label ?? tl(lang, 'common.newNote')), target);
    closeDialog();
    navigate(`/n/${note.id}${title.trim() ? '' : '?new=1'}`);
  };
  return (
    <Sheet title={tl(lang, 'dialogs.newNoteTitle')} onClose={closeDialog}>
      {templates.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-2">
          {[null, ...templates].map((t) => (
            <button
              key={t?.id ?? 'leer'}
              onClick={() => choose(t)}
              className={`truncate rounded-2xl border px-2.5 py-2.5 text-sm transition-all duration-150 ${
                template?.id === t?.id ? 'border-accent/60 bg-accent-container text-on-accent-container' : 'border-line text-muted hover:border-faint hover:text-ink'
              }`}
            >
              {t?.label ?? tl(lang, 'dialogs.newNoteEmptyTpl')}
            </button>
          ))}
        </div>
      )}
      <input
        autoFocus={!isCoarsePointer()}
        className="input mb-3"
        placeholder={tl(lang, 'dialogs.newNoteTitlePlaceholder')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && create()}
      />
      <label className="mb-4 flex items-center gap-2 text-sm text-muted">
        {tl(lang, 'dialogs.newNoteFolder')}
        <select className="input py-1.5" value={target} onChange={(e) => setTarget(e.target.value)}>
          {[...new Set([target, ...folders])].map((f) => (
            <option key={f} value={f}>
              {folderDisplayName(f, lang)}
            </option>
          ))}
        </select>
      </label>
      <button className="btn-primary w-full rounded-full py-2.5" onClick={create}>
        <FileText size={16} /> {tl(lang, 'dialogs.newNoteCreate')}
      </button>
      <p className="mt-3 text-xs text-faint">
        {templates.length ? tl(lang, 'dialogs.newNoteTplEditHint') : tl(lang, 'dialogs.newNoteTplAddHint')}
        <button
          className="underline hover:text-accent"
          onClick={() => {
            closeDialog();
            navigate('/settings/templates');
          }}
        >
          {tl(lang, 'dialogs.newNoteTplLink')}
        </button>
      </p>
    </Sheet>
  );
}

function ZettelDialog() {
  const lang = useLang();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<ZettelType>('flüchtig');
  const [source, setSource] = useState('');
  const create = async () => {
    if (!title.trim()) return;
    const note = await vault.createZettel(title.trim(), type, source.trim());
    closeDialog();
    navigate(`/n/${note.id}`);
  };
  return (
    <Sheet title={tl(lang, 'dialogs.zettelTitle')} onClose={closeDialog}>
      <input
        autoFocus={!isCoarsePointer()}
        className="input mb-3"
        placeholder={tl(lang, 'dialogs.zettelPlaceholder')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && create()}
      />
      <div className="mb-3 grid gap-2">
        {ZETTEL_TYPES.map((t) => {
          const z = zettelTypeLabel(t.id, lang);
          const active = type === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setType(t.id)}
              className={`rounded-2xl border p-3 text-left transition-all duration-150 ${
                active ? 'border-accent/60 bg-accent-container/40' : 'border-line hover:border-faint'
              }`}
            >
              <div className={`text-sm font-medium ${active ? 'text-accent' : ''}`}>{z.label}</div>
              <div className="text-xs text-muted">{z.hint}</div>
            </button>
          );
        })}
      </div>
      {type === 'literatur' && (
        <input
          className="input mb-3 anim-fade-in"
          placeholder={tl(lang, 'dialogs.zettelSourcePlaceholder')}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      )}
      <button className="btn-primary w-full rounded-full py-2.5" disabled={!title.trim()} onClick={create}>
        <Lightbulb size={16} /> {tl(lang, 'dialogs.zettelCreate')}
      </button>
      <p className="mt-3 text-xs text-faint">{tl(lang, 'dialogs.zettelIdHint')}</p>
    </Sheet>
  );
}

/** A link in, a standard recipe note out: ingredient table, numbered steps, source at the bottom */
function RecipeDialog({ initialUrl = '' }: { initialUrl?: string }) {
  const lang = useLang();
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const link = url.trim();
  const existing = link ? vault.list().find((n) => n.content.includes(`\nquelle: ${link}\n`)) : undefined;
  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      const found = /https?:\/\/\S+/.exec(text)?.[0];
      if (found) setUrl(found);
      else setError(tl(lang, 'dialogs.recipeNoLink'));
    } catch {
      setError(tl(lang, 'dialogs.recipeClipboardDenied'));
    }
  };
  const run = async () => {
    if (!link || busy) return;
    setBusy(true);
    setError('');
    try {
      const recipe = await api<Recipe>('/import/recipe', {
        method: 'POST',
        json: { url: /^https?:\/\//i.test(link) ? link : `https://${link}` },
      });
      const note = await vault.create(RECIPE_FOLDER, recipeNoteTitle(recipe), recipeToMarkdown(recipe));
      closeDialog();
      navigate(`/n/${note.id}`);
    } catch (err) {
      setError(navigator.onLine ? (err as Error).message : tl(lang, 'dialogs.recipeOnlineRequired'));
      setBusy(false);
    }
  };
  return (
    <Sheet title={tl(lang, 'dialogs.recipeTitle')} onClose={closeDialog}>
      <div className="mb-3 flex gap-2">
        <input
          autoFocus={!isCoarsePointer()}
          type="url"
          inputMode="url"
          className="input"
          placeholder={tl(lang, 'dialogs.recipePlaceholder')}
          value={url}
          onChange={(e) => (setUrl(e.target.value), setError(''))}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button className="btn-ghost shrink-0 rounded-xl border border-line" onClick={paste} title={tl(lang, 'dialogs.recipePasteTitle')}>
          <ClipboardPaste size={16} />
        </button>
      </div>
      {error && <p className="mb-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger anim-fade-in">{error}</p>}
      {existing && !busy && (
        <p className="mb-3 text-sm text-muted">
          {tl(lang, 'dialogs.recipeAlreadyExists')}{' '}
          <button className="text-accent underline" onClick={() => (closeDialog(), navigate(`/n/${existing.id}`))}>
            {tl(lang, 'dialogs.recipeOpen')}
          </button>
        </p>
      )}
      <button className="btn-primary w-full rounded-full py-2.5" disabled={!link || busy} onClick={run}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <ChefHat size={16} />} {busy ? tl(lang, 'dialogs.recipeImporting') : tl(lang, 'dialogs.recipeImport')}
      </button>
      <p className="mt-3 text-xs text-faint">{tl(lang, 'dialogs.recipeHint', { folder: folderDisplayName(RECIPE_FOLDER, lang) })}</p>
    </Sheet>
  );
}

export function Dialogs() {
  const dialog = useDialog();
  if (dialog?.kind === 'note') return <NewNoteDialog folder={dialog.folder} />;
  if (dialog?.kind === 'zettel') return <ZettelDialog />;
  if (dialog?.kind === 'recipe') return <RecipeDialog initialUrl={dialog.url} />;
  return null;
}
