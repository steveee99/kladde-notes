import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChefHat, CheckSquare, FileText, Image, Loader2, Send, X } from '../lib/icons';
import { useVault, vault } from '../data/vault';
import { editorHost } from '../editor/host';
import { tl, useLang } from '../lib/i18n';
import { useVisualViewport } from '../lib/viewport';
import { importRecipe, newNote } from './Shell';

/** Content another app shared with Kladde (PWA share target), already turned into Markdown */
export interface SharedContent {
  title: string;
  text: string;
  files: File[];
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/**
 * Bottom sheet for one-handed input on the phone: a thought or a task into the inbox, in two taps.
 * With `shared` it opens prefilled with what another app shared; files are uploaded when saving, like a paste.
 */
export function QuickCapture({
  onClose,
  shared,
  onSaved,
  notice,
}: {
  onClose: () => void;
  shared?: SharedContent;
  onSaved?: () => void;
  /** Shown above the input, e.g. when a share could not be received */
  notice?: string;
}) {
  useVault();
  const lang = useLang();
  const recipeEnabled = vault.features().recipe.enabled;
  const [text, setText] = useState(shared?.text ?? '');
  const [asTask, setAsTask] = useState(!shared);
  const [files, setFiles] = useState<File[]>(shared?.files ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const online = useOnline() || vault.standalone;
  // Attachments need the server; offline they cannot be stored yet, the text can
  const keptFiles = online ? files : [];
  const vp = useVisualViewport();
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const uploaded = await Promise.all(keptFiles.map((f) => editorHost.upload(f)));
      // Same embed as a pasted file in the editor; brackets would break the link text
      const embeds = uploaded.map((r) => `![${r.name.replace(/[[\]\\]/g, '')}](${r.url})`);
      const body = [text.trim(), ...embeds].filter(Boolean).join('\n\n');
      const fileTitle = keptFiles[0]?.name.replace(/\.[^.]+$/, '').replace(/[\\/:#[\]|]/g, ' ').trim();
      const title = shared ? shared.title || fileTitle : undefined;
      if (body) await vault.capture(body, asTask && !keptFiles.length, title);
      if (shared) onSaved?.();
      onClose();
    } catch (err) {
      setError(tl(lang, 'quick.shareUploadFailed', { error: (err as Error).message }));
      setBusy(false);
    }
  };
  return createPortal(
    <div
      className="fixed inset-x-0 z-50 flex items-end justify-center sm:items-center"
      style={vp ? { top: `${vp.top}px`, height: `${vp.height}px` } : { top: 0, bottom: 0 }}
    >
      <div className="fixed inset-0 bg-scrim/[0.32] anim-fade-in" onClick={onClose} />
      <div className="relative max-h-[min(90vh,100%)] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-surface-container-high px-4 pt-4 shadow-elevation-3 anim-sheet [--pad-bottom:1rem] safe-bottom sm:rounded-3xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-outline-variant sm:hidden" />
        {notice && (
          <p role="status" className="mb-3 flex items-start gap-2 text-sm text-warn">
            <AlertTriangle size={18} className="shrink-0" /> {notice}
          </p>
        )}
        <textarea
          autoFocus
          rows={shared ? 5 : 3}
          className="input resize-none text-base"
          placeholder={asTask ? tl(lang, 'quick.taskPlaceholder') : tl(lang, 'quick.notePlaceholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Shared text often has several lines: there only Ctrl/⌘+Enter saves
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !shared))) {
              e.preventDefault();
              void save();
            }
          }}
        />
        {files.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className={`chip max-w-full gap-1.5 pr-1 ${online ? '' : 'opacity-60'}`}>
                {f.type.startsWith('image/') ? <Image size={16} /> : <FileText size={16} />}
                <span className="truncate">{f.name}</span>
                <button
                  className="btn-icon h-7 w-7"
                  aria-label={tl(lang, 'quick.shareRemoveFile', { name: f.name })}
                  title={tl(lang, 'quick.shareRemoveFile', { name: f.name })}
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}
                >
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        {files.length > 0 && !online && (
          <p className="mt-2 flex items-start gap-2 text-xs text-warn">
            <AlertTriangle size={16} className="shrink-0" /> {tl(lang, 'quick.shareOffline')}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 flex items-start gap-2 text-xs text-error">
            <AlertTriangle size={16} className="shrink-0" /> {error}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            disabled={keptFiles.length > 0}
            className={`btn rounded-full px-3.5 disabled:opacity-40 ${asTask && !keptFiles.length ?'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
            onClick={() => setAsTask(!asTask)}
          >
            <CheckSquare size={16} /> {tl(lang, 'quick.taskBtn')}
          </button>
          <button
            className="btn-ghost rounded-full px-3"
            onClick={() => {
              onClose();
              void newNote();
            }}
          >
            <FileText size={16} /> {tl(lang, 'quick.fullNoteBtn')}
          </button>
          {recipeEnabled && (
            <button
              className="btn-ghost rounded-full px-3"
              title={tl(lang, 'quick.recipeTitle')}
              onClick={() => {
                onClose();
                importRecipe(/^https?:\/\/\S+$/.test(text.trim()) ? text.trim() : undefined);
              }}
            >
              <ChefHat size={16} /> {tl(lang, 'quick.recipeBtn')}
            </button>
          )}
          <button className="btn-primary ml-auto rounded-full px-4" onClick={save} disabled={busy}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} {tl(lang, 'quick.saveBtn')}
          </button>
        </div>
        <p className="mt-2 text-xs text-on-surface-variant">{asTask && !keptFiles.length ? tl(lang, 'quick.taskHint') : tl(lang, 'quick.noteHint')}</p>
      </div>
    </div>,
    document.body
  );
}
