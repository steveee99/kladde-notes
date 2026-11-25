import { EditorState, Extension } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { MAX_EMBED_DEPTH, embedSection, remoteNoteOf, stripBlockIds, type EmbedRef } from '@kladde/shared';
import { getLang, tl, type Lang } from '../lib/i18n';
import { appUrl, navigate } from '../lib/router';
import { editorHost } from './host';
import { embedContext, embedResolverFacet, foreignFacet, type EmbedNote, type EmbedResolver } from './embedContext';
import { editButton } from './widgets';
import { variablesFacet } from './variables';

/** Extensions of the read-only editor inside an embed; set by Editor.tsx (avoids an import cycle) */
let nestedExtensions: (noteId: string) => Extension = () => [];

export function configureEmbeds(fn: (noteId: string) => Extension): void {
  nestedExtensions = fn;
}

type EmbedDom = HTMLElement & { cmEmbed?: EditorView; embedGone?: boolean };

export type EmbedProblem = 'missing' | 'cycle' | 'deep' | 'section';

/**
 * `![[Note]]`, `![[Note#Heading]]`, `![[Note#^block]]` on its own line: a frame with the source title
 * and the referenced text, rendered read-only by a nested editor (so it looks like the note itself).
 * Tasks in it can be ticked when the reader may edit the source; they are written back to it.
 */
export class EmbedWidget extends WidgetType {
  readonly text: string;
  readonly startLine: number;
  readonly problem: EmbedProblem | null;
  /** The embedded note is a remote one: its stored text (the source), the document itself is loaded when drawn */
  readonly remote: string | null;

  constructor(
    readonly ref: EmbedRef,
    readonly note: EmbedNote | null,
    /** Ids of the notes this one is embedded in (outermost first, this editor's note last) */
    readonly chain: string[],
    readonly depth: number,
    readonly resolver: EmbedResolver | null,
    readonly lang: Lang = getLang()
  ) {
    super();
    let problem: EmbedProblem | null = null;
    let text = '';
    let startLine = 0;
    this.remote = note && remoteNoteOf(note.content) ? note.content : null;
    if (!note) problem = 'missing';
    else if (chain.includes(note.id)) problem = 'cycle';
    else if (depth >= MAX_EMBED_DEPTH) problem = 'deep';
    else if (this.remote === null) {
      const section = embedSection(note.content, ref);
      if (!section) problem = 'section';
      else {
        text = stripBlockIds(section.text);
        startLine = section.startLine;
      }
    }
    this.problem = problem;
    this.text = text;
    this.startLine = startLine;
  }

  eq(o: EmbedWidget) {
    return (
      o.ref.target === this.ref.target &&
      o.ref.heading === this.ref.heading &&
      o.ref.block === this.ref.block &&
      o.ref.alias === this.ref.alias &&
      o.note?.id === this.note?.id &&
      o.note?.title === this.note?.title &&
      o.note?.canWrite === this.note?.canWrite &&
      o.note?.href === this.note?.href &&
      o.note?.variables === this.note?.variables &&
      o.problem === this.problem &&
      o.remote === this.remote &&
      o.text === this.text &&
      o.startLine === this.startLine &&
      o.depth === this.depth &&
      o.chain.join('\n') === this.chain.join('\n') &&
      o.resolver === this.resolver &&
      o.lang === this.lang
    );
  }

  private label(): string {
    const title = this.ref.alias ?? this.note?.title ?? this.ref.target;
    if (this.ref.heading) return `${title} › ${this.ref.heading}`;
    if (this.ref.block) return `${title} › ^${this.ref.block}`;
    return title;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'wz-block wz-embed';
    wrap.dataset.depth = String(this.depth);

    const head = document.createElement('div');
    head.className = 'wz-embed-head';
    const link = document.createElement('a');
    link.className = 'wz-embed-title';
    link.textContent = this.label();
    const note = this.note;
    if (note && this.problem !== 'missing') {
      link.href = note.href ? appUrl(note.href) : '#';
      link.title = tl(this.lang, 'embed.open', { title: note.title });
      link.addEventListener('mousedown', (e) => e.preventDefault());
      link.addEventListener('click', (e) => {
        e.preventDefault();
        if (note.href) navigate(note.href);
        else if (this.ref.heading || this.ref.block) editorHost.openTask(note.id, this.startLine);
        else editorHost.openNote(note.id);
      });
    } else {
      link.classList.add('wz-embed-missing-title');
    }
    head.append(link);
    wrap.append(head);

    const body = document.createElement('div');
    body.className = 'wz-embed-body';
    if (this.problem) {
      body.classList.add('wz-embed-problem');
      body.textContent = tl(this.lang, `embed.${this.problem}`);
    } else if (note && this.remote !== null) {
      this.loadRemote(view, body, note);
    } else if (note) {
      const nested = new EditorView({
        parent: body,
        state: EditorState.create({
          doc: this.text,
          extensions: [
            nestedExtensions(note.id),
            variablesFacet.of(note.variables ?? null),
            embedContext.of({ depth: this.depth + 1, chain: [...this.chain, note.id], source: { noteId: note.id, startLine: this.startLine, canWrite: note.canWrite } }),
            this.resolver ? embedResolverFacet.of(this.resolver) : [],
          ],
        }),
      });
      (wrap as EmbedDom).cmEmbed = nested;
    }
    wrap.append(body);
    if (view.state.facet(EditorView.editable)) wrap.append(editButton(view, () => view.posAtDOM(wrap), this.lang));
    return wrap;
  }

  /** The document of an embedded remote note, read-only and without anything of the reader's vault */
  private loadRemote(view: EditorView, body: HTMLElement, note: EmbedNote): void {
    const message = (text: string) => {
      body.classList.add('wz-embed-problem');
      body.textContent = text;
    };
    // Public links: nothing is fetched for guests
    if (this.resolver) return message(tl(this.lang, 'remote.public'));
    body.setAttribute('role', 'status');
    message(tl(this.lang, 'remote.loading'));
    void editorHost.loadRemote(note.id).then((loaded) => {
      const wrap = body.closest<EmbedDom>('.wz-embed');
      if (!wrap || wrap.embedGone) return;
      body.removeAttribute('role');
      if ('problem' in loaded) message(loaded.problem);
      else {
        const section = embedSection(loaded.text, this.ref);
        if (!section) message(tl(this.lang, 'embed.section'));
        else {
          body.classList.remove('wz-embed-problem');
          body.textContent = '';
          wrap.cmEmbed = new EditorView({
            parent: body,
            state: EditorState.create({
              doc: stripBlockIds(section.text),
              extensions: [nestedExtensions(note.id), foreignFacet.of(true), embedContext.of({ depth: this.depth + 1, chain: [...this.chain, note.id], source: null })],
            }),
          });
        }
      }
      view.requestMeasure();
    });
  }

  destroy(dom: HTMLElement) {
    (dom as EmbedDom).embedGone = true;
    (dom as EmbedDom).cmEmbed?.destroy();
  }

  ignoreEvent() {
    return true;
  }
}

/** The widget for an embed line in an editor with this state */
export function embedWidgetFor(state: EditorState, ref: EmbedRef, noteId: string, lang: Lang): EmbedWidget {
  const ctx = state.facet(embedContext);
  const resolver = state.facet(embedResolverFacet);
  const note = (resolver ?? editorHost.resolveEmbed)(ref.target);
  const chain = ctx.chain.length ? ctx.chain : noteId ? [noteId] : [];
  return new EmbedWidget(ref, note, chain, ctx.depth, resolver, lang);
}
