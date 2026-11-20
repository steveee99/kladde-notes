import { useMemo, useState } from 'react';
import { buildTagTree, extractMeta, isValidTag, normalizeTag, tagMatches, type TagNode } from '@kladde/shared';
import { ChevronDown, ChevronRight, Merge, Pencil, Search, Tags as TagsIcon, X } from '../lib/icons';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
import { t, useLang } from '../lib/i18n';
import { NoteCollection, ViewSwitch } from './NoteList';
import { Sheet } from './Dialogs';
import { PageBody, PageHeader } from './PageHeader';

/** All tags in a flat list (for the merge suggestions and "does it exist?") */
function flatten(nodes: TagNode[], out: TagNode[] = []): TagNode[] {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

/** Keeps the nodes whose tag contains `q`, with the parents on the way to them */
function filterTree(nodes: TagNode[], q: string): TagNode[] {
  if (!q) return nodes;
  const out: TagNode[] = [];
  for (const n of nodes) {
    const children = filterTree(n.children, q);
    if (n.tag.includes(q) || children.length) out.push({ ...n, children });
  }
  return out;
}

function TagRow({
  node,
  depth,
  selected,
  expanded,
  onToggle,
  forceOpen,
}: {
  node: TagNode;
  depth: number;
  selected: string | null;
  expanded: Set<string>;
  onToggle: (tag: string) => void;
  forceOpen: boolean;
}) {
  const open = forceOpen || expanded.has(node.tag) || (!!selected && selected.startsWith(`${node.tag}/`));
  const active = selected === node.tag;
  return (
    <li>
      <div
        className={`state-layer flex min-h-12 items-center rounded-full pr-4 ${active ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface'}`}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            className="btn-icon h-10 w-10"
            aria-expanded={open}
            aria-label={open ? t('tags.collapse', { tag: node.tag }) : t('tags.expand', { tag: node.tag })}
            onClick={() => onToggle(node.tag)}
          >
            {open ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
          </button>
        ) : (
          <span className="w-10 shrink-0" />
        )}
        <button
          type="button"
          aria-current={active ? 'true' : undefined}
          onClick={() => navigate(`/tags/${encodeURIComponent(node.tag)}`)}
          className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left outline-none"
        >
          <span className={`min-w-0 flex-1 truncate text-label-l ${node.count === 0 ? 'text-on-surface-variant' : ''}`}>#{node.name}</span>
          <span className="shrink-0 text-label-m text-on-surface-variant" title={t('tags.countTitle', { n: node.count, total: node.total })}>
            {node.total}
          </span>
        </button>
      </div>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TagRow key={c.tag} node={c} depth={depth + 1} selected={selected} expanded={expanded} onToggle={onToggle} forceOpen={forceOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Rename a tag or merge it into another; both rewrite the tag in all own notes */
function RenameTagSheet({ tag, merge, allTags, onClose }: { tag: string; merge: boolean; allTags: string[]; onClose: () => void }) {
  useLang();
  const [value, setValue] = useState(merge ? '' : tag);
  const [busy, setBusy] = useState(false);
  const target = normalizeTag(value);
  const valid = isValidTag(target) && target !== tag;
  const exists = allTags.includes(target);
  const nested = target.startsWith(`${tag}/`);
  const affected = vault.ownNotes().filter((n) => extractMeta(n.path, n.content).tags.some((x) => tagMatches(x, tag))).length;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    await vault.renameTag(tag, target);
    onClose();
    navigate(`/tags/${encodeURIComponent(target)}`, true);
  };
  return (
    <Sheet title={merge ? t('tags.mergeTitle', { tag }) : t('tags.renameTitle', { tag })} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="block">
          <span className="mb-1 block text-label-l text-on-surface-variant">{merge ? t('tags.mergeLabel') : t('tags.renameLabel')}</span>
          <input
            autoFocus
            className="input"
            list="tag-suggestions"
            value={value}
            placeholder={merge ? t('tags.mergePlaceholder') : undefined}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
          />
          <datalist id="tag-suggestions">
            {allTags
              .filter((x) => x !== tag)
              .map((x) => (
                <option key={x} value={x} />
              ))}
          </datalist>
        </label>
        <p className="text-body-m text-on-surface-variant" aria-live="polite">
          {value.trim() && !isValidTag(target)
            ? t('tags.invalid')
            : valid && exists
              ? t('tags.willMerge', { tag: target, n: affected })
              : t('tags.willRename', { n: affected })}
          {valid && nested ? ` ${t('tags.nestedHint')}` : ''}
        </p>
        <div className="flex justify-end gap-2 pb-2">
          <button type="button" className="btn-text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={!valid || busy}>
            {exists ? t('tags.mergeBtn') : t('tags.renameBtn')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** Tag overview (#31): all tags as a tree with counts; a tag lists its notes and can be renamed or merged */
export function TagsView({ tag }: { tag?: string }) {
  const version = useVault();
  useLang();
  const locked = useReadOnly();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<'rename' | 'merge' | null>(null);
  const own = vault.ownNotes();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tree = useMemo(() => buildTagTree(own), [version]);
  const all = flatten(tree);
  const selected = tag ? normalizeTag(tag) : null;
  const q = normalizeTag(query);
  const shown = filterTree(tree, q);
  const notes = selected
    ? own.filter((n) => extractMeta(n.path, n.content).tags.some((x) => tagMatches(x, selected))).sort((a, b) => b.updatedAt - a.updatedAt)
    : [];
  const tagged = own.filter((n) => extractMeta(n.path, n.content).tags.length > 0).length;
  const toggle = (x: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(x)) next.delete(x);
      else next.add(x);
      return next;
    });

  return (
    <div>
      <PageHeader title={t('tags.title')} subtitle={t('tags.summary', { tags: all.filter((n) => n.count > 0).length, notes: tagged })} />
      <PageBody>

      {tree.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center">
          <TagsIcon size={32} className="text-on-surface-variant" />
          <p className="max-w-sm text-body-m text-on-surface-variant">{t('tags.empty')}</p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(16rem,20rem)_1fr]">
          <section aria-label={t('tags.title')} className="min-w-0">
            {/* M3 search bar */}
            <div className="mb-3 flex h-12 items-center gap-3 rounded-full bg-surface-container-high px-4 focus-within:ring-2 focus-within:ring-primary">
              <Search size={20} className="shrink-0 text-on-surface-variant" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('tags.filterPlaceholder')}
                aria-label={t('tags.filterPlaceholder')}
                className="min-w-0 flex-1 bg-transparent text-body-l text-on-surface outline-none placeholder:text-on-surface-variant"
              />
              {query && (
                <button type="button" className="btn-icon -mr-2" onClick={() => setQuery('')} aria-label={t('search.clear')}>
                  <X size={20} />
                </button>
              )}
            </div>
            {shown.length === 0 ? (
              <p className="px-4 py-6 text-body-m text-on-surface-variant">{t('tags.noMatch')}</p>
            ) : (
              <ul className="card p-2">
                {shown.map((n) => (
                  <TagRow key={n.tag} node={n} depth={0} selected={selected} expanded={expanded} onToggle={toggle} forceOpen={!!q} />
                ))}
              </ul>
            )}
          </section>

          <section aria-live="polite" className="min-w-0">
            {selected ? (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 flex-1 basis-48 truncate text-title-l">#{selected}</h2>
                  {!locked && (
                    <>
                      <button className="btn-tonal" onClick={() => setSheet('rename')} disabled={notes.length === 0}>
                        <Pencil size={18} /> {t('tags.renameBtn')}
                      </button>
                      <button className="btn-outlined" onClick={() => setSheet('merge')} disabled={notes.length === 0}>
                        <Merge size={18} /> {t('tags.mergeInto')}
                      </button>
                    </>
                  )}
                  <ViewSwitch />
                </div>
                {notes.length === 0 ? (
                  <p className="text-body-m text-on-surface-variant">{t('tags.noNotes')}</p>
                ) : (
                  <NoteCollection notes={notes} cols="sm:grid-cols-2" />
                )}
              </>
            ) : (
              <p className="px-1 py-6 text-body-m text-on-surface-variant lg:py-3">{t('tags.pick')}</p>
            )}
          </section>
        </div>
      )}

      {sheet && selected && <RenameTagSheet tag={selected} merge={sheet === 'merge'} allTags={all.map((n) => n.tag)} onClose={() => setSheet(null)} />}
      </PageBody>
    </div>
  );
}
