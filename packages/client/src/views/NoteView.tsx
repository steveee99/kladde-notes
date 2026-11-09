import { useEffect, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { ArrowLeft, ChevronRight, Bold, CalendarPlus, CheckSquare, Code, Heading, History, Image as ImageIcon, Link2, List, Lock, Share2, Trash2, Undo2, Users } from 'lucide-react';
import { undo } from '@codemirror/commands';
import { excerpt, splitPath, toDateString } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
import { Editor, insertAtLineStart, insertText, toggleCode, toggleWrap, wrapSelection } from '../editor/Editor';
import { editorHost } from '../editor/host';
import { ShareDialog } from './ShareDialog';
import { HistoryDialog } from './History';
import { ParaBar } from './ParaBar';
import { Graph } from './Graph';

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Strg';

function Toolbar({ view }: { view: EditorView | null }) {
  const file = useRef<HTMLInputElement>(null);
  if (!view) return null;
  const btn = (Icon: typeof Bold, title: string, fn: () => void) => (
    <button
      key={title}
      title={title}
      className="btn-icon shrink-0"
      onMouseDown={(e) => e.preventDefault()}
      onClick={fn}
    >
      <Icon size={18} />
    </button>
  );
  return (
    <div className="sticky bottom-0 z-20 flex gap-1 overflow-x-auto border-t border-line bg-surface/95 px-2 pt-1.5 backdrop-blur [--pad-bottom:0.375rem] max-md:pb-1.5 md:safe-bottom scrollbar-thin">
      {btn(CheckSquare, 'Aufgabe', () => insertAtLineStart(view, '- [ ] '))}
      {btn(CalendarPlus, 'Fällig heute', () => insertText(view, ` 📅 ${toDateString(new Date())}`))}
      {btn(Heading, 'Überschrift', () => insertAtLineStart(view, '## '))}
      {btn(List, 'Liste', () => insertAtLineStart(view, '- '))}
      {btn(Bold, `Fett (${MOD}+B)`, () => toggleWrap(view, '**'))}
      {btn(Link2, `Verknüpfen (${MOD}+Shift+L)`, () => wrapSelection(view, '[[', ']]'))}
      {btn(Code, `Code (${MOD}+Shift+M)`, () => toggleCode(view))}
      {btn(ImageIcon, 'Bild/PDF', () => file.current?.click())}
      {btn(Undo2, 'Rückgängig', () => undo(view))}
      <input
        ref={file}
        type="file"
        accept="image/*,application/pdf"
        hidden
        multiple
        onChange={async (e) => {
          for (const f of [...(e.target.files ?? [])]) {
            try {
              const r = await editorHost.upload(f);
              insertText(view, `\n![${r.name}](${r.url})\n`);
            } catch (err) {
              alert(`Upload fehlgeschlagen: ${(err as Error).message}`);
            }
          }
          e.target.value = '';
        }}
      />
    </div>
  );
}

export function NoteView({ id, isNew }: { id: string; isNew: boolean }) {
  const version = useVault();
  const note = vault.get(id);
  const [view, setView] = useState<EditorView | null>(null);
  const locked = useReadOnly();
  const [sharing, setSharing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showGraph, setShowGraph] = useState(true);
  const [title, setTitle] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const name = note ? splitPath(note.path).name : '';

  useEffect(() => setTitle(name), [name]);
  useEffect(() => {
    if (isNew) titleRef.current?.select();
  }, [isNew, id]);
  // ?line=N (from a double click on a task): scroll to that line once the editor exists
  const hasNote = !!note;
  useEffect(() => {
    const n = Number(new URLSearchParams(location.search).get('line'));
    if (!view || !hasNote || !n) return;
    const ln = view.state.doc.line(Math.min(n, view.state.doc.lines));
    view.dispatch({ selection: { anchor: ln.from }, effects: EditorView.scrollIntoView(ln.from, { y: 'center' }) });
    history.replaceState(null, '', location.pathname);
  }, [view, hasNote]);

  if (!note) {
    return (
      <div className="p-10 text-center text-muted anim-fade-in">
        {vault.ready ? 'Diese Notiz gibt es nicht (mehr).' : 'Lade …'}
        <div>
          <button className="btn-ghost mt-4" onClick={() => navigate('/')}>
            Zum Start
          </button>
        </div>
      </div>
    );
  }

  const sharedReadOnly = note.access === 'read';
  // The read-only switch locks the note like a share with read access
  const readOnly = sharedReadOnly || locked;
  const isOwner = note.access === 'owner' && !locked;
  // Own notes, or shared ones whose folder share allows deleting
  const mayDelete = !locked && vault.canDelete(note);
  const { folder } = splitPath(note.path);
  const index = vault.links();
  const backlinks = index.backlinks(id).map((b) => vault.get(b)!).filter(Boolean);
  const mentions = index.unlinkedMentions(id).map((m) => vault.get(m)!).filter((n) => n && n.access !== 'read');
  const local = index.localGraph(id, 2);
  const commitTitle = () => {
    if (title.trim() && title.trim() !== name) void vault.update(id, { title: title.trim() });
    else setTitle(name);
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 pt-4 sm:px-8 sm:pt-8">
        <div className="mb-2 flex items-center gap-1 text-sm text-faint anim-fade-in">
          <button className="btn-icon -ml-2" onClick={() => history.back()} title="Zurück">
            <ArrowLeft size={18} />
          </button>
          {note.access === 'owner' && locked ? (
            <span className="min-w-0 truncate py-1">{folder || '(oberste Ebene)'}</span>
          ) : isOwner ? (
            <select
              className="min-w-0 max-w-[50%] truncate rounded-lg bg-transparent py-1 pr-1 hover:bg-raised"
              value={folder}
              onChange={(e) => void vault.update(id, { folder: e.target.value })}
              title="Verschieben"
            >
              {[...new Set(['', ...vault.folders(), folder])].map((f) => (
                <option key={f} value={f}>
                  {f || '(oberste Ebene)'}
                </option>
              ))}
            </select>
          ) : (
            <span className="chip">
              <Users size={12} /> {note.owner} · {sharedReadOnly ? 'nur lesen' : note.canDelete ? 'bearbeiten, löschen' : 'bearbeiten'}
            </span>
          )}
          <div className="ml-auto flex items-center">
            {readOnly && (
              <span title={sharedReadOnly ? 'Nur lesen (geteilt)' : 'Lesemodus'}>
                <Lock size={15} className="mr-2" />
              </span>
            )}
            <button className="btn-icon" title="Verlauf" onClick={() => setShowHistory(true)}>
              <History size={18} />
            </button>
            {isOwner && (
              <button className="btn-icon" title="Teilen" onClick={() => setSharing(true)}>
                <Share2 size={18} />
              </button>
            )}
            {mayDelete && (
              <button
                className="btn-icon hover:!text-danger"
                title="Löschen"
                onClick={() => {
                  if (confirm(`„${name}“ löschen?`)) {
                    void vault.remove(id);
                    navigate(!isOwner ? '/shared' : folder ? `/f/${encodeURIComponent(folder)}` : '/notes', true);
                  }
                }}
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>
        </div>
        <input
          ref={titleRef}
          className="mb-2 w-full bg-transparent text-3xl font-bold tracking-tight outline-none placeholder:text-faint sm:text-4xl"
          value={title}
          readOnly={!isOwner}
          placeholder="Titel"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitTitle();
              view?.focus();
            }
          }}
        />
        {!locked && <ParaBar note={note} />}
        <Editor docKey={id} value={note.content} readOnly={readOnly} stamp={version} onChange={(content) => void vault.update(id, { content })} onView={setView} />
        <div className="mb-10 space-y-6 border-t border-line pt-4">
          {backlinks.length > 0 && (
            <section className="anim-fade-in">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">Verweise hierher · {backlinks.length}</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {backlinks.map((b) => (
                  <button key={b.id} className="rounded-xl border border-line p-3 text-left text-sm transition hover:border-accent/40" onClick={() => navigate(`/n/${b.id}`)}>
                    <div className="font-medium">{splitPath(b.path).name}</div>
                    <div className="line-clamp-1 text-muted">{excerpt(b.content, 90)}</div>
                  </button>
                ))}
              </div>
            </section>
          )}
          {mentions.length > 0 && (
            <section className="anim-fade-in">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">Unverlinkte Erwähnungen · {mentions.length}</h2>
              <ul className="space-y-1.5">
                {mentions.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm">
                    <button className="min-w-0 flex-1 truncate text-left hover:text-accent" onClick={() => navigate(`/n/${m.id}`)}>
                      {splitPath(m.path).name}
                    </button>
                    <button className="edit-only chip shrink-0 px-2.5 py-1 hover:bg-accent/15 hover:text-accent" onClick={() => void vault.linkMention(m.id, id)}>
                      <Link2 size={12} /> Verlinken
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {local.nodes.length > 1 && (
            <section className="anim-fade-in">
              <button className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-faint hover:text-ink" onClick={() => setShowGraph(!showGraph)}>
                <ChevronRight size={14} className={`transition-transform duration-200 ${showGraph ? 'rotate-90' : ''}`} /> Lokales Netz · {local.nodes.length - 1}
              </button>
              {showGraph && <Graph nodes={local.nodes} edges={local.edges} focusId={id} height={300} onOpen={(n) => n !== id && navigate(`/n/${n}`)} />}
            </section>
          )}
        </div>
      </div>
      {!readOnly && <Toolbar view={view} />}
      {showHistory && <HistoryDialog noteId={id} current={note.content} canRestore={!readOnly} onClose={() => setShowHistory(false)} />}
      {sharing && <ShareDialog target={{ note: id }} onClose={() => setSharing(false)} />}
    </div>
  );
}
