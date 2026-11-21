/**
 * "Web page from URL" (#32): the server fetches the page and extracts the article as Markdown; the note
 * lands in the inbox with `source:`, `author:` and `clipped:` in its frontmatter. Opened from the new-note
 * menu or by the bookmarklet (`/clip?url=…&title=…&text=…`), which may bring a selection: then only the
 * selection is kept, as a quote below the source.
 */
import { useEffect, useRef, useState } from 'react';
import { ClipboardPaste, Globe, Loader2 } from '../lib/icons';
import { INBOX_FOLDER, toDateString, webClipTitle, webClipToMarkdown, type WebClip } from '@kladde/shared';
import { api } from '../lib/api';
import { vault } from '../data/vault';
import { closeDialog } from '../lib/dialogs';
import { tl, useLang } from '../lib/i18n';
import { appUrl, navigate } from '../lib/router';
import { isCoarsePointer } from '../lib/viewport';
import { Sheet } from './Dialogs';
import { Switch } from './Switch';
import { CopyField } from './McpSettings';

const IMAGES_KEY = 'kladde.clipImages';

/** The bookmarklet: opens Kladde's `/clip` route with the page's address, title and selection */
export function bookmarkletCode(): string {
  const target = `${location.origin}${appUrl('/clip')}`;
  // A JS string literal that also stays inert inside an href (no quotes, angle brackets or line separators)
  const literal = JSON.stringify(target).replace(/[<>&'\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `javascript:(()=>{const s=String(getSelection()).slice(0,4000);window.open(${literal}+'?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title.slice(0,300))+(s?'&text='+encodeURIComponent(s):''),'_blank')})()`;
}

export function WebClipDialog({ initialUrl = '', title: givenTitle = '', selection = '' }: { initialUrl?: string; title?: string; selection?: string }) {
  const lang = useLang();
  const [url, setUrl] = useState(initialUrl);
  const [images, setImagesState] = useState(() => {
    try {
      return localStorage.getItem(IMAGES_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bookmarklet = useRef<HTMLAnchorElement>(null);
  const link = url.trim();
  const existing = link ? vault.list().find((n) => n.content.includes(`\nsource: ${link}\n`)) : undefined;

  // React warns about javascript: URLs in JSX, so the bookmarklet's address is set directly
  useEffect(() => {
    bookmarklet.current?.setAttribute('href', bookmarkletCode());
  }, []);

  const setImages = (on: boolean) => {
    setImagesState(on);
    try {
      localStorage.setItem(IMAGES_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

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
    const full = /^https?:\/\//i.test(link) ? link : `https://${link}`;
    try {
      let clip: WebClip;
      try {
        clip = await api<WebClip>('/clip', { method: 'POST', json: { url: full, images: images && !selection } });
      } catch (err) {
        // With a selection the page itself is not needed: keep the selection with its source
        if (!selection.trim()) throw err;
        clip = { title: givenTitle || new URL(full).hostname, markdown: '', images: [], sourceUrl: full };
      }
      if (givenTitle && !clip.title) clip.title = givenTitle;
      const note = await vault.create(INBOX_FOLDER, webClipTitle(clip), webClipToMarkdown(clip, toDateString(new Date()), selection));
      closeDialog();
      navigate(`/n/${note.id}`);
    } catch (err) {
      setError(navigator.onLine ? (err as Error).message : tl(lang, 'clip.onlineRequired'));
      setBusy(false);
    }
  };

  return (
    <Sheet title={tl(lang, 'clip.title')} onClose={closeDialog}>
      <div className="mb-3 flex gap-2">
        <input
          autoFocus={!isCoarsePointer() && !initialUrl}
          type="url"
          inputMode="url"
          className="input min-w-0 flex-1"
          placeholder={tl(lang, 'clip.placeholder')}
          value={url}
          onChange={(e) => (setUrl(e.target.value), setError(''))}
          onKeyDown={(e) => e.key === 'Enter' && run()}
        />
        <button className="btn-outlined shrink-0" onClick={paste} title={tl(lang, 'dialogs.recipePasteTitle')} aria-label={tl(lang, 'dialogs.recipePasteTitle')}>
          <ClipboardPaste size={16} />
        </button>
      </div>
      {selection.trim() && (
        <blockquote className="mb-3 line-clamp-4 border-l-4 border-primary/60 pl-3 text-body-m text-on-surface-variant">{selection.trim()}</blockquote>
      )}
      {!selection.trim() && (
        <label className="mb-3 flex items-center justify-between gap-3 text-body-m">
          <span>
            {tl(lang, 'clip.images')}
            <span className="block text-xs text-on-surface-variant">{tl(lang, 'clip.imagesHint')}</span>
          </span>
          <Switch checked={images} label={tl(lang, 'clip.images')} onChange={setImages} />
        </label>
      )}
      {error && <p className="mb-3 rounded-lg bg-error-container px-4 py-3 text-body-m text-on-error-container anim-fade-in">{error}</p>}
      {existing && !busy && (
        <p className="mb-3 text-sm text-on-surface-variant">
          {tl(lang, 'clip.alreadyExists')}{' '}
          <button className="text-primary underline" onClick={() => (closeDialog(), navigate(`/n/${existing.id}`))}>
            {tl(lang, 'dialogs.recipeOpen')}
          </button>
        </p>
      )}
      <button className="btn-primary w-full py-2.5" disabled={!link || busy} onClick={run}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Globe size={16} />} {busy ? tl(lang, 'clip.busy') : selection.trim() ? tl(lang, 'clip.saveSelection') : tl(lang, 'clip.save')}
      </button>
      <p className="mt-3 text-xs text-on-surface-variant">{tl(lang, 'clip.hint')}</p>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-on-surface-variant">{tl(lang, 'clip.bookmarkletTitle')}</summary>
        <div className="mt-2 space-y-2">
          <p className="text-xs text-on-surface-variant">{tl(lang, 'clip.bookmarkletHint')}</p>
          <a ref={bookmarklet} className="chip inline-flex cursor-grab" onClick={(e) => e.preventDefault()} title={tl(lang, 'clip.bookmarkletDrag')}>
            <Globe size={16} /> {tl(lang, 'clip.bookmarkletName')}
          </a>
          <CopyField value={bookmarkletCode()} />
        </div>
      </details>
    </Sheet>
  );
}
