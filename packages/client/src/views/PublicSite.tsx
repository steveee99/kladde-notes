import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { excerpt, fillReleasePlaceholders, fillVariables, LinkIndex, siteNoteHref, splitPath, stripFrontmatter, type PublicSite as PublicSiteData, type PublicSiteNote } from '@kladde/shared';
import { api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { locale, tl, useLang } from '../lib/i18n';
import { useModal } from '../lib/modal';
import { navigate } from '../lib/router';
import { showToast } from '../lib/toast';
import { ancestorsOf, buildSiteTree, findSiteNote, homeOf, searchSite, siteTitleOf, type SiteFolder } from '../lib/siteTree';
import { ChevronRight, Copy, FileText, Folder, FolderOpen, Globe, Loader2, Menu, Network, PictureAsPdf, Search, Slideshow, X } from '../lib/icons';
import { editorHost, type EditorHost } from '../editor/host';
import type { EmbedResolver } from '../editor/embedContext';
import { useOutline } from '../editor/outline';
import { releaseRenderOptions } from '../editor/releases';
import { Avatar } from './Avatar';
import { ExportMenu } from './ExportMenu';
import { Graph } from './Graph';
import { OutlinePanel } from './OutlinePanel';
import { guestNoteKind, PublicNoteContent, publicScope } from './PublicNoteContent';

const Presentation = lazy(() => import('./Presentation'));

/**
 * The editor widgets reach the app through `editorHost`; on a site they may only see the site's notes. Set while the
 * page is shown (during render, so the first editor already resolves links), put back when it goes.
 */
function useSiteHost(index: LinkIndex | null, open: (id: string) => void, noQueries: string): void {
  const saved = useRef<Partial<EditorHost> | null>(null);
  const install = () => {
    if (!index) return;
    saved.current ??= { ...editorHost };
    const resolve = (target: string) => index.resolve(target) ?? index.resolvePath(target);
    Object.assign(editorHost, {
      openWiki: (target: string) => {
        const id = resolve(target);
        if (id) open(id);
      },
      wikiExists: (target: string) => !!resolve(target),
      openNote: open,
      openTask: (id: string) => open(id),
      linkPreview: () => false,
      runQuery: () => ({ error: noQueries }),
      toggleTask: () => {},
      setFrontmatter: () => {},
      noteTitles: () => [...index.notes.values()].map((n) => n.title),
      tags: () => [],
      people: () => [],
      autoLinkTargets: () => [],
      ticketKeys: () => [],
      ticket: () => null,
    } satisfies Partial<EditorHost>);
  };
  useMemo(install, [index]);
  useEffect(() => {
    install();
    return () => {
      if (saved.current) Object.assign(editorHost, saved.current);
      saved.current = null;
    };
  }, [index]);
}

/** A published folder as a read-only website (no account needed): folder tree, note, outline, backlinks, graph */
export function PublicSite({ slug, rest }: { slug: string; rest: string }) {
  const lang = useLang();
  const [site, setSite] = useState<PublicSiteData | null>(null);
  const [error, setError] = useState('');
  const [graph, setGraph] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setSite(null);
    setError('');
    api<PublicSiteData>(`/sites/${encodeURIComponent(slug)}`).then(setSite, () => setError(tl(lang, 'site.gone')));
  }, [slug]);

  const byId = useMemo(() => new Map((site?.notes ?? []).map((n) => [n.id, n])), [site]);
  const index = useMemo(() => (site ? new LinkIndex(site.notes) : null), [site]);
  const tree = useMemo(() => buildSiteTree(site?.notes ?? []), [site]);
  const open = (id: string) => {
    const n = byId.get(id);
    if (!n) return;
    setGraph(false);
    setTreeOpen(false);
    navigate(siteNoteHref(slug, n.path));
  };
  const openRef = useRef(open);
  openRef.current = open;
  useSiteHost(index, (id) => openRef.current(id), tl(lang, 'site.noQueries'));

  const home = useMemo(() => (site ? homeOf(site.notes, site.title) : undefined), [site]);
  const current = site ? (rest ? findSiteNote(site.notes, rest) : home) : undefined;
  const missing = !!site && !!rest && !current;

  useEffect(() => {
    if (!site) return;
    document.title = current ? `${siteTitleOf(current)} · ${site.title}` : site.title;
    mainRef.current?.scrollTo({ top: 0 });
  }, [site, current?.id, graph]);

  // Embeds show notes of the same site only
  const resolveEmbed = useMemo<EmbedResolver>(
    () => (target) => {
      const id = index?.resolve(target);
      const n = id ? byId.get(id) : undefined;
      return n
        ? {
            id: n.id,
            title: siteTitleOf(n),
            content: n.content,
            canWrite: false,
            href: siteNoteHref(slug, n.path),
            variables: publicScope(n.variables),
          }
        : null;
    },
    [index, byId, slug],
  );

  if (error) return <div className="flex h-full items-center justify-center p-8 text-center text-muted">{error}</div>;
  if (!site || !index) return <div className="flex h-full items-center justify-center p-8 text-center text-muted">{tl(lang, 'common.loading')}</div>;

  const treePanel = <SiteTreePanel site={site} tree={tree} currentId={current?.id ?? null} onOpen={open} />;

  return (
    <div className="flex h-[100dvh] flex-col bg-bg text-text">
      <header className="no-print flex h-12 shrink-0 items-center gap-1.5 border-b border-line bg-bar px-2 sm:px-4">
        <button type="button" className="btn-icon nav:hidden" aria-label={tl(lang, 'site.folders')} aria-expanded={treeOpen} onClick={() => setTreeOpen(true)}>
          <Menu size={20} />
        </button>
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-raised"
          onClick={() => {
            setGraph(false);
            navigate(`/site/${encodeURIComponent(slug)}`);
          }}
        >
          <Globe size={18} className="shrink-0 text-acc" />
          <span className="font-display truncate text-title-m text-strong">{site.title}</span>
        </button>
        <div className="flex-1" />
        <button type="button" className={`btn-text h-9 px-3 ${graph ? 'bg-acc-bg text-acc-hi' : ''}`} aria-pressed={graph} onClick={() => setGraph((g) => !g)}>
          <Network size={18} />
          <span className="phone:hidden">{tl(lang, 'site.graph')}</span>
        </button>
        <span className="flex items-center gap-2 pl-1 text-caption text-muted" title={tl(lang, 'site.by', { owner: site.owner })}>
          <Avatar name={site.owner} avatarUrl={site.ownerAvatar} size="sm" />
          <span className="phone:hidden">{site.owner}</span>
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="no-print hidden w-72 shrink-0 flex-col border-r border-line bg-panel nav:flex" aria-label={tl(lang, 'site.folders')}>
          {treePanel}
        </aside>
        {treeOpen && <TreeDrawer onClose={() => setTreeOpen(false)}>{treePanel}</TreeDrawer>}
        <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
          {graph ? (
            <div className="p-4 sm:p-6">
              <h1 className="font-display mb-4 text-headline-s">{tl(lang, 'site.graph')}</h1>
              <SiteGraph index={index} focusId={current?.id} onOpen={open} height={Math.max(360, window.innerHeight - 180)} />
            </div>
          ) : current ? (
            <SiteNoteView key={current.id} slug={slug} note={current} index={index} byId={byId} resolveEmbed={resolveEmbed} onOpen={open} />
          ) : (
            <SiteOverview site={site} missing={missing} onOpen={open} />
          )}
        </main>
      </div>
    </div>
  );
}

function TreeDrawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const lang = useLang();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModal(panel, onClose);
  return (
    <div className="no-print fixed inset-0 z-40 nav:hidden">
      <div className="absolute inset-0 bg-scrim/[0.32] anim-fade-in" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-[min(20rem,86vw)] flex-col border-r border-line2 bg-panel shadow-elevation-3 outline-none"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
          <h2 id={titleId} className="flex-1 text-title-s">
            {tl(lang, 'site.folders')}
          </h2>
          <button type="button" className="btn-icon" aria-label={tl(lang, 'common.close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Search field and folder tree */
function SiteTreePanel({ site, tree, currentId, onOpen }: { site: PublicSiteData; tree: SiteFolder; currentId: string | null; onOpen: (id: string) => void }) {
  const lang = useLang();
  const [query, setQuery] = useState('');
  const hits = useMemo(() => searchSite(site.notes, query), [site, query]);
  const current = currentId ? site.notes.find((n) => n.id === currentId) : undefined;
  // Top-level folders start open, and so do the folders above the note shown
  const [openFolders, setOpenFolders] = useState(() => new Set(tree.folders.map((f) => f.path)));
  useEffect(() => {
    if (!current) return;
    const above = ancestorsOf(current.path);
    setOpenFolders((prev) => (above.every((p) => prev.has(p)) ? prev : new Set([...prev, ...above])));
  }, [current?.path]);
  const toggle = (path: string) =>
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const noteRow = (id: string, title: string, depth: number) => (
    <li key={id}>
      <button
        type="button"
        aria-current={id === currentId ? 'page' : undefined}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left text-body-m ${id === currentId ? 'bg-line text-strong' : 'text-body hover:bg-raised'}`}
        style={{ paddingLeft: `${0.5 + depth * 0.875 + 1.125}rem` }}
        onClick={() => onOpen(id)}
      >
        <FileText size={15} className="shrink-0 text-faint" />
        <span className="truncate">{title}</span>
      </button>
    </li>
  );
  const folderRows = (folder: SiteFolder, depth: number): React.ReactNode => (
    <>
      {folder.folders.map((f) => {
        const isOpen = openFolders.has(f.path);
        return (
          <li key={`f:${f.path}`}>
            <button
              type="button"
              aria-expanded={isOpen}
              className="flex w-full min-w-0 items-center gap-1 rounded-md py-1 pr-2 text-left text-body-m text-body hover:bg-raised"
              style={{ paddingLeft: `${0.5 + depth * 0.875}rem` }}
              onClick={() => toggle(f.path)}
            >
              <ChevronRight size={14} className={`shrink-0 text-faint transition-transform ${isOpen ? 'rotate-90' : ''}`} />
              {isOpen ? <FolderOpen size={15} className="shrink-0 text-muted" /> : <Folder size={15} className="shrink-0 text-muted" />}
              <span className="truncate">{f.name}</span>
            </button>
            {isOpen && <ul>{folderRows(f, depth + 1)}</ul>}
          </li>
        );
      })}
      {folder.notes.map((n) => noteRow(n.id, n.title, depth))}
    </>
  );

  return (
    <>
      <div className="shrink-0 p-2">
        <label className="relative block">
          <span className="sr-only">{tl(lang, 'site.search')}</span>
          <Search size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input h-9 w-full pl-8" type="search" value={query} placeholder={tl(lang, 'site.search')} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-label={tl(lang, 'site.folders')}>
        {query.trim() ? (
          hits.length ? (
            <ul className="space-y-0.5">
              {hits.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    aria-current={n.id === currentId ? 'page' : undefined}
                    className={`w-full min-w-0 rounded-md px-2 py-1.5 text-left ${n.id === currentId ? 'bg-line' : 'hover:bg-raised'}`}
                    onClick={() => onOpen(n.id)}
                  >
                    <div className="truncate text-body-m text-strong">{siteTitleOf(n)}</div>
                    {splitPath(n.path).folder && <div className="truncate text-caption text-faint">{splitPath(n.path).folder}</div>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 py-6 text-center text-body-m text-muted">{tl(lang, 'site.noResults')}</p>
          )
        ) : (
          <ul>{folderRows(tree, 0)}</ul>
        )}
      </nav>
    </>
  );
}

function SiteGraph({ index, focusId, height, onOpen }: { index: LinkIndex; focusId?: string; height: number; onOpen: (id: string) => void }) {
  const g = useMemo(() => {
    const { nodes, edges } = index.graph();
    return {
      nodes: nodes.map((n) => ({ ...n, orphan: index.isOrphan(n.id) })),
      edges,
    };
  }, [index]);
  return <Graph nodes={g.nodes} edges={g.edges} focusId={focusId} height={height} onOpen={onOpen} />;
}

/** Start page of a site without an own start note: what is in it, newest first */
function SiteOverview({ site, missing, onOpen }: { site: PublicSiteData; missing: boolean; onOpen: (id: string) => void }) {
  const lang = useLang();
  const recent = useMemo(() => [...site.notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 24), [site]);
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8 anim-fade-up">
      {missing && <p className="mb-6 rounded-lg border border-line bg-panel px-4 py-3 text-body-m text-muted">{tl(lang, 'site.notInSite')}</p>}
      <h1 className="font-display mb-2 break-words text-[34px] leading-tight">{site.title}</h1>
      <p className="mb-8 text-caption text-muted">
        {tl(lang, 'site.by', { owner: site.owner })} ·{' '}
        {tl(lang, 'site.updated', {
          date: new Date(site.updatedAt).toLocaleDateString(locale(lang)),
        })}{' '}
        · {tl(lang, 'site.count', { n: site.notes.length })}
      </p>
      {site.truncated && <p className="mb-6 text-body-m text-muted">{tl(lang, 'site.truncated', { n: site.notes.length })}</p>}
      {recent.length === 0 ? (
        <p className="empty-sheet rounded-lg border border-line px-4 py-10 text-center text-body-m text-muted">{tl(lang, 'site.empty')}</p>
      ) : (
        <section>
          <h2 className="mb-3 text-title-s text-muted">{tl(lang, 'site.recent')}</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {recent.map((n) => (
              <button key={n.id} type="button" className="card min-w-0 p-3 text-left transition-colors hover:border-acc-line" onClick={() => onOpen(n.id)}>
                <div className="truncate text-body-m font-medium text-strong">{siteTitleOf(n)}</div>
                <div className="line-clamp-2 break-words text-caption text-muted">{excerpt(n.content, 110)}</div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SiteNoteView({
  slug,
  note,
  index,
  byId,
  resolveEmbed,
  onOpen,
}: {
  slug: string;
  note: PublicSiteNote;
  index: LinkIndex;
  byId: Map<string, PublicSiteNote>;
  resolveEmbed: EmbedResolver;
  onOpen: (id: string) => void;
}) {
  const lang = useLang();
  const [view, setView] = useState<EditorView | null>(null);
  const [busy, setBusy] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const title = siteTitleOf(note);
  const variables = publicScope(note.variables);
  const { drawing, slides, remote } = guestNoteKind(note.content);
  const releases = note.versioning ? (note.releases ?? []) : null;
  const exported = note.versioning ? fillReleasePlaceholders(note.content, note.releases ?? [], releaseRenderOptions(lang)) : note.content;
  const outline = useOutline(view, note.content);
  const backlinks = index.backlinks(note.id).flatMap((id) => byId.get(id) ?? []);
  const local = useMemo(() => index.localGraph(note.id), [index, note.id]);
  const folders = splitPath(note.path).folder.split('/').filter(Boolean);
  // A note that starts with its title as a heading shows it once
  const firstLine = stripFrontmatter(note.content).trimStart().split('\n', 1)[0];
  const leadingTitle = /^#\s/.test(firstLine) && firstLine.replace(/^#\s+/, '').trim().toLowerCase() === title.toLowerCase();

  const copyMarkdown = async () => {
    const text = stripFrontmatter(fillVariables(exported, variables));
    if (await copyText(text.endsWith('\n') ? text : `${text}\n`)) showToast(tl(lang, 'site.copied'));
  };
  const downloadPdf = async () => {
    setBusy(true);
    try {
      await (await import('../lib/noteExport')).exportNoteAsPdf(title, exported, variables);
    } catch (err) {
      showToast(tl(lang, 'export.failed', { error: (err as Error).message }), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex justify-center gap-8 px-4 py-8 sm:px-8">
      <article className={`min-w-0 max-w-3xl flex-1 ${drawing !== null ? 'anim-fade-in' : 'anim-fade-up'}`}>
        {folders.length > 0 && (
          <div className="no-print mb-2 flex flex-wrap items-center gap-1 text-caption text-muted">
            {folders.map((f, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={12} className="text-faint" />}
                {f}
              </span>
            ))}
          </div>
        )}
        <h1 className={leadingTitle ? 'sr-only' : 'font-display mb-1 break-words text-[34px] leading-tight'}>{title}</h1>
        <div className="no-print mb-4 flex items-center gap-2">
          <p className="min-w-0 flex-1 text-caption text-muted">
            {tl(lang, 'site.updated', {
              date: new Date(note.updatedAt).toLocaleDateString(locale(lang)),
            })}
            {note.showsRelease && <span className="pill ml-2 font-mono">v{note.showsRelease}</span>}
          </p>
          {!remote && (
            <div className="flex shrink-0 items-center gap-0.5">
              {slides && (
                <button type="button" className="btn-icon" title={tl(lang, 'present.start')} aria-label={tl(lang, 'present.start')} onClick={() => setPresenting(true)}>
                  <Slideshow size={18} />
                </button>
              )}
              {drawing === null && (
                <button type="button" className="btn-icon" title={tl(lang, 'site.copyMarkdown')} aria-label={tl(lang, 'site.copyMarkdown')} onClick={() => void copyMarkdown()}>
                  <Copy size={18} />
                </button>
              )}
              <button type="button" className="btn-icon" title={tl(lang, 'site.pdf')} aria-label={tl(lang, 'site.pdf')} disabled={busy} onClick={() => void downloadPdf()}>
                {busy ? <Loader2 size={18} className="animate-spin" /> : <PictureAsPdf size={18} />}
              </button>
              <ExportMenu title={title} slides={slides} content={exported} variables={variables} />
            </div>
          )}
        </div>
        <PublicNoteContent docKey={`${slug}:${note.id}`} note={note} variables={variables} resolveEmbed={resolveEmbed} onView={setView} />

        <div className="no-print mt-10 space-y-6">
          {backlinks.length > 0 && (
            <section>
              <h2 className="mb-2 text-title-s text-muted">{tl(lang, 'note.backlinksTitle', { n: backlinks.length })}</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {backlinks.map((b) => (
                  <button key={b.id} type="button" className="card min-w-0 p-3 text-left transition-colors hover:border-acc-line" onClick={() => onOpen(b.id)}>
                    <div className="truncate text-body-m font-medium text-strong">{siteTitleOf(b)}</div>
                    <div className="line-clamp-1 break-words text-caption text-muted">{excerpt(b.content, 90)}</div>
                  </button>
                ))}
              </div>
            </section>
          )}
          {local.nodes.length > 1 && (
            <section>
              <button type="button" className="mb-2 flex items-center gap-1 text-title-s text-muted hover:text-strong" aria-expanded={showGraph} onClick={() => setShowGraph(!showGraph)}>
                <ChevronRight size={14} className={`transition-transform duration-200 ${showGraph ? 'rotate-90' : ''}`} />{' '}
                {tl(lang, 'note.localGraphTitle', {
                  n: local.nodes.length - 1,
                })}
              </button>
              {showGraph && <Graph nodes={local.nodes} edges={local.edges} focusId={note.id} height={320} onOpen={(id) => id !== note.id && onOpen(id)} />}
            </section>
          )}
        </div>
      </article>
      {outline.headings.length > 1 && (
        <aside className="no-print sticky top-8 hidden max-h-[calc(100dvh-8rem)] w-56 shrink-0 self-start overflow-y-auto xl:block" aria-label={tl(lang, 'site.outline')}>
          <h2 className="mb-2 px-2 text-caption text-muted">{tl(lang, 'site.outline')}</h2>
          <OutlinePanel
            outline={outline}
            variables={variables}
            view={view}
            canEdit={false}
            onJump={(pos) =>
              view?.dispatch({
                effects: EditorView.scrollIntoView(Math.min(pos, view.state.doc.length), { y: 'start', yMargin: 24 }),
              })
            }
          />
        </aside>
      )}
      {presenting && (
        <Suspense fallback={null}>
          <Presentation docKey={`${slug}:${note.id}`} title={title} content={note.content} resolveEmbed={resolveEmbed} releases={releases} variables={variables} onClose={() => setPresenting(false)} />
        </Suspense>
      )}
    </div>
  );
}
