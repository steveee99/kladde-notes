import { useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';
import { useVault, vault } from '../data/vault';
import { tl, useLang } from '../lib/i18n';
import { NoteCollection, ViewSwitch } from './NoteList';

export function SearchView() {
  useVault();
  const lang = useLang();
  const [q, setQ] = useState('');
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = terms.length
    ? vault
        .list()
        .filter((n) => {
          const hay = `${n.path}\n${n.content}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 100)
    : [];
  return (
    <div className="content-container px-4 py-6 sm:px-8 sm:py-10">
      <div className="card mb-6 flex items-center gap-2 rounded-full px-4 anim-fade-up">
        <SearchIcon size={18} className="text-faint" />
        <input
          autoFocus
          data-search-input
          className="w-full bg-transparent py-3 text-base outline-none placeholder:text-faint"
          placeholder={tl(lang, 'search.placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-faint">{terms.length > 0 ? tl(lang, 'search.resultsCount', { n: results.length }) : ''}</p>
        <ViewSwitch />
      </div>
      <NoteCollection notes={results} cols="sm:grid-cols-2" />
    </div>
  );
}
