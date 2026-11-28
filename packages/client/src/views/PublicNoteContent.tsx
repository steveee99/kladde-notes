import { lazy, Suspense } from 'react';
import type { EditorView } from '@codemirror/view';
import { EMPTY_VARIABLE_SCOPE, type PublicNote, type VariableScope, excalidrawSceneOf, fixedVariableScope, isPresentationNote, parseNoteType, propertiesAt, remoteNoteOf, resolveVariables } from '@kladde/shared';
import { tl, useLang } from '../lib/i18n';
import { Editor } from '../editor/Editor';
import type { EmbedResolver } from '../editor/embedContext';
import { NoteTypePanel } from './NoteTypePanel';
import { RemoteDoc } from '../lib/icons';

const ExcalidrawPanel = lazy(() => import('./ExcalidrawPanel'));

/** Only the values the note uses come with a public link or site; the others show as unknown */
const publicScopes = new WeakMap<object, VariableScope>();
export function publicScope(values: Record<string, string> | undefined): VariableScope {
  if (!values) return EMPTY_VARIABLE_SCOPE;
  let scope = publicScopes.get(values);
  if (!scope) publicScopes.set(values, (scope = fixedVariableScope(values)));
  return scope;
}

/** What a guest page knows about how to show a note */
export function guestNoteKind(content: string): { drawing: string | null; slides: boolean; remote: boolean } {
  // Drawing notes show their canvas (view only) instead of the scene JSON
  const drawing = excalidrawSceneOf(content);
  // Notes the owner set up as a presentation (frontmatter `presentation`, #87) can be presented
  const slides = drawing === null && isPresentationNote(content);
  // A remote note: guests never see the document, it is read with the server's own access
  return { drawing, slides, remote: !!remoteNoteOf(content) };
}

type GuestNote = Pick<PublicNote, 'content' | 'noteType' | 'versioning' | 'releases'>;

/** The body of a note on a public link or a folder website: read-only editor, drawing or remote placeholder */
export function PublicNoteContent({
  docKey,
  note,
  variables,
  resolveEmbed,
  stamp,
  onView,
}: {
  docKey: string;
  note: GuestNote;
  variables: VariableScope;
  resolveEmbed: EmbedResolver;
  stamp?: number;
  onView?: (view: EditorView | null) => void;
}) {
  const lang = useLang();
  const { drawing, slides, remote } = guestNoteKind(note.content);
  const releases = note.versioning ? (note.releases ?? []) : null;
  // A custom note type shows the note's properties as its owner modelled them
  const noteType = note.noteType ? parseNoteType(note.noteType) : null;
  const typePanel = (where: 'top' | 'right' | 'bottom') =>
    noteType && <NoteTypePanel type={noteType} where={where} content={note.content} noteId={null} canEdit={false} fill={(text) => resolveVariables(text, variables)} />;
  const sideType = !!noteType && propertiesAt(noteType, 'right').length > 0;
  if (remote)
    return (
      <p data-remote-public className="flex items-center justify-center gap-2 rounded-lg border border-line bg-panel px-4 py-8 text-center text-body-m text-muted">
        <RemoteDoc size={18} className="shrink-0" /> {tl(lang, 'remote.public')}
      </p>
    );
  if (drawing !== null)
    return (
      <Suspense fallback={<div className="p-8 text-center text-on-surface-variant">{tl(lang, 'common.loading')}</div>}>
        <ExcalidrawPanel scene={drawing} readOnly lang={lang} />
      </Suspense>
    );
  return (
    <>
      {typePanel('top')}
      <div className={sideType ? 'ticket-layout' : 'contents'}>
        <div className={sideType ? 'ticket-grid' : 'contents'}>
          {sideType && <div className="ticket-side">{typePanel('right')}</div>}
          <Editor
            docKey={docKey}
            value={note.content}
            readOnly
            stamp={stamp}
            onView={onView}
            resolveEmbed={resolveEmbed}
            releases={releases}
            variables={variables}
            slideBreaks={slides ? tl(lang, 'present.slideBreak') : ''}
            hideProperties={!!noteType && !noteType.showFrontmatter}
          />
        </div>
      </div>
      {typePanel('bottom')}
    </>
  );
}
