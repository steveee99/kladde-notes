import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChefHat, ClipboardPaste, Draw, FileText, FileType2, Lightbulb, Loader2, X } from '../lib/icons';
import { INBOX_FOLDER, Recipe, recipeNoteTitle, recipeToMarkdown, SharedFolder, Template, ZETTEL_TYPES, ZettelType } from '@kladde/shared';
import { api } from '../lib/api';
import { vault } from '../data/vault';
import { closeDialog, openDialog, useDialog } from '../lib/dialogs';
import { createDrawingNote, createPdfNote, type NewNoteKind } from '../lib/newNote';
import { folderDisplayName, tl, useLang, zettelTypeLabel } from '../lib/i18n';
import { navigate } from '../lib/router';
import { isCoarsePointer, useVisualViewport } from '../lib/viewport';
import { Dropdown } from './Dropdown';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const lang = useLang();
  const vp = useVisualViewport();
  return createPortal(
    <div
      className="fixed inset-x-0 z-50 flex items-end justify-center sm:items-center"
      style={vp ? { top: `${vp.top}px`, height: `${vp.height}px` } : { top: 0, bottom: 0 }}
    >
      <div className="fixed inset-0 bg-scrim/[0.32] anim-fade-in" onClick={onClose} />
      <div className="relative max-h-[min(90vh,100%)] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-surface-container-high px-6 pt-6 shadow-elevation-3 anim-sheet [--pad-bottom:1.25rem] safe-bottom sm:rounded-3xl">
        <div className="mb-4 flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-headline-s">{title}</h2>
          <button className="btn-icon shrink-0" onClick={onClose} title={tl(lang, 'common.close')} aria-label={tl(lang, 'common.close')}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

function NewNoteDialog({ folder, type, shared }: { folder?: string; type?: NewNoteKind; shared?: SharedFolder }) {
  const lang = useLang();
  const templates: Template[] = vault.templates();
  const features = vault.features();
  // PDFs are uploaded into the own space, so a shared folder offers notes and drawings only
  const [kind, setKind] = useState<NewNoteKind>(shared && type === 'pdf' ? 'note' : (type ?? 'note'));
  const [template, setTemplate] = useState<Template | null>(null);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState(shared?.folder ?? folder ?? INBOX_FOLDER);
  const [busy, setBusy] = useState(false);
  const pdfInput = useRef<HTMLInputElement>(null);
  const folders = vault.folders();
  const choose = (t: Template | null) => {
    setTemplate(t);
    // A template brings its home folder, unless the user started from a specific folder
    if (!folder && !shared && t) setTarget(t.folder);
  };
  const create = async () => {
    if (busy) return;
    if (kind === 'pdf') {
      pdfInput.current?.click();
      return;
    }
    setBusy(true);
    try {
      if (kind === 'drawing') {
        if (await createDrawingNote(target, title, shared)) closeDialog();
        return;
      }
      const note = await vault.createFromTemplate(template, title.trim() || (template?.label ?? tl(lang, 'common.newNote')), target, shared);
      closeDialog();
      navigate(`/n/${note.id}${title.trim() ? '' : '?new=1'}`);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const kinds: { value: NewNoteKind | 'zettel' | 'recipe'; label: string; Icon: typeof FileText; hint?: string }[] = [
    { value: 'note', label: tl(lang, 'nav.newNoteShort'), Icon: FileText },
    { value: 'drawing', label: tl(lang, 'nav.drawingNote'), Icon: Draw, hint: tl(lang, 'nav.drawingNoteTitle') },
  ];
  if (!shared) {
    kinds.push({ value: 'pdf', label: tl(lang, 'nav.pdfNote'), Icon: FileType2, hint: tl(lang, 'nav.pdfNoteTitle') });
    if (features.zettel.enabled) kinds.push({ value: 'zettel', label: 'Zettel', Icon: Lightbulb, hint: tl(lang, 'nav.zettelTitle') });
    if (features.recipe.enabled) kinds.push({ value: 'recipe', label: tl(lang, 'nav.recipe'), Icon: ChefHat, hint: tl(lang, 'quick.recipeTitle') });
  }
  const CreateIcon = kind === 'drawing' ? Draw : kind === 'pdf' ? FileType2 : FileText;
  return (
    <Sheet title={tl(lang, 'dialogs.newNoteTitle')} onClose={closeDialog}>
      <div role="group" aria-label={tl(lang, 'dialogs.newNoteKind')} className="mb-4 flex flex-wrap gap-2">
        {kinds.map(({ value, label, Icon, hint }) => (
          <button
            key={value}
            type="button"
            title={hint}
            aria-pressed={kind === value}
            className={`chip state-layer !h-9 !px-3 ${kind === value ? '!border-transparent bg-secondary-container text-on-secondary-container' : ''}`}
            onClick={() => {
              if (value === 'zettel') openDialog({ kind: 'zettel' });
              else if (value === 'recipe') openDialog({ kind: 'recipe' });
              else setKind(value);
            }}
          >
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>
      {kind === 'note' && templates.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[null, ...templates].map((t) => (
            <button
              key={t?.id ?? 'leer'}
              onClick={() => choose(t)}
              className={`truncate rounded-2xl border px-2.5 py-2.5 text-sm transition-all duration-150 ${
                template?.id === t?.id ? 'border-transparent bg-secondary-container text-on-secondary-container' : 'border-outline-variant text-on-surface-variant hover:border-outline hover:text-on-surface'
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
        placeholder={kind === 'pdf' ? tl(lang, 'dialogs.newNotePdfTitlePlaceholder') : tl(lang, 'dialogs.newNoteTitlePlaceholder')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && create()}
      />
      <div className="mb-4 flex flex-col gap-1.5 text-sm text-on-surface-variant sm:flex-row sm:items-center sm:gap-2">
        <span className="shrink-0">{tl(lang, 'dialogs.newNoteFolder')}</span>
        {shared ? (
          <span className="chip min-w-0 flex-1" title={shared.folder}>
            <span className="truncate">
              {shared.folder} · {shared.owner}
            </span>
          </span>
        ) : (
          <Dropdown
            value={target}
            onChange={setTarget}
            aria-label={tl(lang, 'dialogs.newNoteFolder')}
            className="flex-1"
            options={[...new Set([target, ...folders, ''])].map((f) => ({
              value: f,
              label: folderDisplayName(f, lang),
            }))}
          />
        )}
      </div>
      <input
        ref={pdfInput}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setBusy(true);
          void createPdfNote(file, target, title)
            .then((note) => note && closeDialog())
            .finally(() => setBusy(false));
        }}
      />
      <button className="btn-primary w-full rounded-full py-2.5" disabled={busy} onClick={create}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <CreateIcon size={16} />}{' '}
        {kind === 'pdf' ? tl(lang, 'dialogs.newNoteChoosePdf') : tl(lang, 'dialogs.newNoteCreate')}
      </button>
      {kind === 'note' && (
        <p className="mt-3 text-xs text-on-surface-variant">
          {templates.length ? tl(lang, 'dialogs.newNoteTplEditHint') : tl(lang, 'dialogs.newNoteTplAddHint')}
          <button
            className="underline hover:text-primary"
            onClick={() => {
              closeDialog();
              navigate('/settings/templates');
            }}
          >
            {tl(lang, 'dialogs.newNoteTplLink')}
          </button>
        </p>
      )}
    </Sheet>
  );
}

function ZettelDialog() {
  const lang = useLang();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<ZettelType>('flüchtig');
  const [source, setSource] = useState('');
  const targetFolder = vault.features().zettel.folder;
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
                active ? 'border-primary/60 bg-secondary-container/60' : 'border-outline-variant hover:border-outline'
              }`}
            >
              <div className={`text-sm font-medium ${active ? 'text-primary' : ''}`}>{z.label}</div>
              <div className="text-xs text-on-surface-variant">{z.hint}</div>
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
      <p className="mt-3 text-xs text-on-surface-variant">{tl(lang, 'dialogs.zettelIdHint')}</p>
      <p className="mt-1 text-xs text-on-surface-variant">{tl(lang, 'dialogs.zettelSavedIn', { folder: folderDisplayName(targetFolder, lang) })}</p>
    </Sheet>
  );
}

/** A link in, a standard recipe note out: ingredient table, numbered steps, source at the bottom */
function RecipeDialog({ initialUrl = '' }: { initialUrl?: string }) {
  const lang = useLang();
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const targetFolder = vault.features().recipe.folder;
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
      const note = await vault.create(targetFolder, recipeNoteTitle(recipe), recipeToMarkdown(recipe));
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
          className="input min-w-0 flex-1"
          placeholder={tl(lang, 'dialogs.recipePlaceholder')}
          value={url}
          onChange={(e) => (setUrl(e.target.value), setError(''))}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button className="btn-ghost shrink-0 rounded-xl border border-outline-variant" onClick={paste} title={tl(lang, 'dialogs.recipePasteTitle')}>
          <ClipboardPaste size={16} />
        </button>
      </div>
      {error && <p className="mb-3 rounded-lg bg-error-container px-4 py-3 text-body-m text-on-error-container anim-fade-in">{error}</p>}
      {existing && !busy && (
        <p className="mb-3 text-sm text-on-surface-variant">
          {tl(lang, 'dialogs.recipeAlreadyExists')}{' '}
          <button className="text-primary underline" onClick={() => (closeDialog(), navigate(`/n/${existing.id}`))}>
            {tl(lang, 'dialogs.recipeOpen')}
          </button>
        </p>
      )}
      <button className="btn-primary w-full rounded-full py-2.5" disabled={!link || busy} onClick={run}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <ChefHat size={16} />} {busy ? tl(lang, 'dialogs.recipeImporting') : tl(lang, 'dialogs.recipeImport')}
      </button>
      <p className="mt-3 text-xs text-on-surface-variant">{tl(lang, 'dialogs.recipeHint', { folder: folderDisplayName(targetFolder, lang) })}</p>
    </Sheet>
  );
}

export function Dialogs() {
  const dialog = useDialog();
  if (dialog?.kind === 'note')
    return <NewNoteDialog key={`${dialog.type ?? ''}:${dialog.shared?.folder ?? dialog.folder ?? ''}`} folder={dialog.folder} type={dialog.type} shared={dialog.shared} />;
  if (dialog?.kind === 'zettel') return <ZettelDialog />;
  if (dialog?.kind === 'recipe') return <RecipeDialog initialUrl={dialog.url} />;
  return null;
}
