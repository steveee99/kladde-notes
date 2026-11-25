import { useState } from 'react';
import { Search as SearchIcon } from '../lib/icons';
import { isHiddenPath, projectTitleOf } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { NoteCollection, ViewSwitch } from './NoteList';
import { AttachmentHitList, useAttachmentSearch } from './AttachmentHits';
import { PageBody } from './PageHeader';

export function SearchView() {
  useVault();
  const lang = useLang();
  const [q, setQ] = useState('');
  const attachmentHits = useAttachmentSearch(q);
  const rc = vault.roleConfig();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = terms.length
    ? vault
        .list()
        .filter((n) => {
          if (isHiddenPath(n.path)) return false;
          const hay = `${projectTitleOf(n.path, n.content, rc)}\n${n.path}\n${n.content}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 100)
    : [];
  return (
    <PageBody>
      <div className="mb-4 flex h-10 min-w-0 items-center gap-2 rounded-md border border-line2 bg-panel px-3 focus-within:border-acc focus-within:shadow-[0_0_0_1px_rgb(var(--acc))]">
        <SearchIcon size={16} className="shrink-0 text-muted" />
        <input
          autoFocus
          data-search-input
          className="min-w-0 flex-1 bg-transparent text-body-l outline-none placeholder:text-muted"
          placeholder={tl(lang, 'search.placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-body-m text-muted">{terms.length > 0 ? tl(lang, 'search.resultsCount', { n: results.length }) : ''}</p>
        <ViewSwitch />
      </div>
      <NoteCollection notes={results} cols="sm:grid-cols-2" />
      <AttachmentHitList hits={attachmentHits} onOpen={(id) => navigate(`/n/${id}`)} />
    </PageBody>
  );
}
