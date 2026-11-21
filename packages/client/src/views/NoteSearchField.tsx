import { useId, useMemo, useRef, useState } from 'react';
import { isDatabasePath, isTicketContent, splitPath } from '@kladde/shared';
import { vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { folderDisplayName, t, useLang } from '../lib/i18n';
import { AddLink, FileText } from '../lib/icons';
import { searchNotes, searchTerms } from './SearchDialog';

const MAX = 8;

/** The [[link]] target of a note: its title, or its path when another note has the same title */
function linkTargetOf(n: LocalNote): string {
  const links = vault.links();
  const title = links.notes.get(n.id)?.title ?? splitPath(n.path).name;
  return links.resolve(title) === n.id ? title : n.path.replace(/\.md$/, '');
}

/**
 * A search field that finds notes by title, path and text (like the search dialog) and hands the chosen note's link
 * target to `onPick`. Enter without a highlighted hit links the typed text (a note that does not exist yet).
 * Tickets and database notes are left out; `exclude` holds note ids that are linked already.
 */
export function NoteSearchField({ onPick, exclude, label, placeholder, className = '' }: { onPick: (target: string) => void; exclude?: Set<string>; label: string; placeholder?: string; className?: string }) {
  const lang = useLang();
  const id = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const terms = searchTerms(q);
  const hits = useMemo(() => {
    if (!terms.length) return [];
    const pool = vault.list().filter((n) => !isDatabasePath(n.path) && !n.path.startsWith('.') && !exclude?.has(n.id) && !isTicketContent(n.content));
    return searchNotes(pool, terms, (n) => vault.links().notes.get(n.id)?.title ?? splitPath(n.path).name).slice(0, MAX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, exclude]);
  const pick = (target: string) => {
    const v = target.trim();
    if (!v) return;
    onPick(v);
    setQ('');
    setActive(0);
    setOpen(false);
  };
  const choose = () => (hits[active] ? pick(linkTargetOf(hits[active])) : pick(q));
  const show = open && terms.length > 0;
  return (
    <div className={`relative flex gap-1.5 ${className}`}>
      <input
        ref={input}
        className="input !min-h-0 min-w-0 flex-1 !py-1.5"
        role="combobox"
        aria-expanded={show}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={show && hits[active] ? `${id}-${active}` : undefined}
        aria-label={label}
        placeholder={placeholder ?? t('tickets.docSearchHint')}
        autoComplete="off"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // A click on a hit lands before the blur closes the list (onMouseDown below)
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && hits.length) {
            e.preventDefault();
            setOpen(true);
            setActive((a) => (a + 1) % hits.length);
          } else if (e.key === 'ArrowUp' && hits.length) {
            e.preventDefault();
            setActive((a) => (a - 1 + hits.length) % hits.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose();
          } else if (e.key === 'Escape' && show) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        data-note-search
      />
      <button type="button" className="btn-tonal shrink-0" onClick={choose} disabled={!q.trim()} aria-label={label} title={label}>
        <AddLink size={16} />
      </button>
      {show && (
        <ul id={`${id}-list`} role="listbox" aria-label={label} className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-line2 bg-raised p-1 shadow-elevation-2">
          {hits.map((n, i) => {
            const { folder } = splitPath(n.path);
            const where = [n.group ? vault.group(n.group)?.name : '', folder ? folderDisplayName(folder, lang) : ''].filter(Boolean).join(' / ');
            return (
              <li
                key={n.id}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${i === active ? 'bg-line' : 'hover:bg-line/60'}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(linkTargetOf(n));
                }}
                onMouseEnter={() => setActive(i)}
              >
                <FileText size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-m text-text">{vault.links().notes.get(n.id)?.title ?? splitPath(n.path).name}</span>
                  {where && <span className="block truncate text-label-m text-muted">{where}</span>}
                </span>
              </li>
            );
          })}
          {!hits.length && <li className="px-2 py-1.5 text-body-s text-muted">{t('tickets.docSearchEmpty', { q: q.trim() })}</li>}
        </ul>
      )}
    </div>
  );
}
