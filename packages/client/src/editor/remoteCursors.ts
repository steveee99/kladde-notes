import { StateEffect, StateField, Text, Transaction } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { resolveCursor, type PresenceCursor, type PresenceViewer } from '@kladde/shared';
import { presence } from '../lib/presence';

/** Characters before the cursor that are sent along to find the spot again */
const CTX = 24;
/** Number of `--cursor-N` colors in index.css */
const COLORS = 6;

interface RemoteCursor {
  raw: PresenceCursor;
  head: number;
  anchor: number;
  name: string;
  avatarUrl: string | null;
  color: number;
}

/** The same color for a person on every device and for everybody watching */
export function colorOf(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return (Math.abs(h) % COLORS) + 1;
}

/** The text right before the cursor, sent with its offset */
export function cursorContext(doc: Text, head: number): string {
  return doc.sliceString(Math.max(0, head - CTX), head);
}

const setCursors = StateEffect.define<{ cursors: PresenceCursor[]; viewers: PresenceViewer[] }>();

function place(doc: Text, raw: PresenceCursor, viewers: PresenceViewer[]): RemoteCursor {
  const text = doc.toString();
  const head = resolveCursor(text, raw.head, raw.ctx);
  const anchor = Math.min(Math.max(0, head + raw.anchor - raw.head), text.length);
  const viewer = viewers.find((v) => v.userId === raw.userId);
  return { raw, head, anchor, name: viewer?.username ?? '?', avatarUrl: viewer?.avatarUrl ?? null, color: colorOf(raw.userId) };
}

const cursorField = StateField.define<{ list: RemoteCursor[]; viewers: PresenceViewer[] }>({
  create: () => ({ list: [], viewers: [] }),
  update(value, tr: Transaction) {
    let { list, viewers } = value;
    for (const e of tr.effects) {
      if (e.is(setCursors)) {
        viewers = e.value.viewers;
        const known = new Map(list.map((c) => [c.raw.clientId, c]));
        list = e.value.cursors.map((raw) => {
          const before = known.get(raw.clientId);
          // Unchanged cursors keep where they were mapped to (the texts may have moved apart meanwhile)
          if (before && before.raw.head === raw.head && before.raw.anchor === raw.anchor && before.raw.ctx === raw.ctx) {
            const viewer = viewers.find((v) => v.userId === raw.userId);
            return { ...before, name: viewer?.username ?? before.name, avatarUrl: viewer?.avatarUrl ?? before.avatarUrl };
          }
          return place(tr.state.doc, raw, viewers);
        });
      }
    }
    if (tr.docChanged) {
      // Text from elsewhere (likely the sender's own change): the sent offsets fit again
      if (tr.annotation(Transaction.remote)) list = list.map((c) => place(tr.state.doc, c.raw, viewers));
      else list = list.map((c) => ({ ...c, head: tr.changes.mapPos(c.head, 1), anchor: tr.changes.mapPos(c.anchor, 1) }));
    }
    return list === value.list && viewers === value.viewers ? value : { list, viewers };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => decorations(v.list)),
});

class CursorWidget extends WidgetType {
  constructor(private readonly c: RemoteCursor) {
    super();
  }

  eq(other: CursorWidget) {
    return other.c.raw.clientId === this.c.raw.clientId && other.c.name === this.c.name && other.c.avatarUrl === this.c.avatarUrl && other.c.color === this.c.color;
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-remote-cursor';
    wrap.style.setProperty('--rc', `var(--cursor-${this.c.color})`);
    wrap.setAttribute('aria-hidden', 'true');
    const flag = document.createElement('span');
    flag.className = 'cm-remote-cursor-flag';
    flag.title = this.c.name;
    const initial = document.createElement('span');
    initial.textContent = (this.c.name.trim().charAt(0) || '?').toUpperCase();
    flag.append(initial);
    if (this.c.avatarUrl) {
      const img = document.createElement('img');
      img.src = this.c.avatarUrl;
      img.alt = '';
      img.decoding = 'async';
      img.onerror = () => img.remove();
      flag.append(img);
    }
    const name = document.createElement('span');
    name.className = 'cm-remote-cursor-name';
    name.textContent = this.c.name;
    wrap.append(flag, name);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

function decorations(list: RemoteCursor[]): DecorationSet {
  const ranges = [];
  for (const c of list) {
    const from = Math.min(c.head, c.anchor);
    const to = Math.max(c.head, c.anchor);
    if (from < to) ranges.push(Decoration.mark({ class: 'cm-remote-selection', attributes: { style: `--rc: var(--cursor-${c.color})` } }).range(from, to));
    ranges.push(Decoration.widget({ widget: new CursorWidget(c), side: 1 }).range(c.head));
  }
  return Decoration.set(ranges, true);
}

/**
 * Shows where the other devices/tabs on the note have their cursor (a colored caret with a small avatar,
 * their selection tinted) and reports where this tab's cursor is moved to.
 */
export function remoteCursors(noteId: string) {
  const sync = ViewPlugin.fromClass(
    class {
      private unsubscribe: () => void;
      private lastCursors: PresenceCursor[] | null = null;
      private lastViewers: PresenceViewer[] | null = null;

      constructor(private readonly view: EditorView) {
        this.unsubscribe = presence.subscribe(() => this.pull());
        // Not inside the constructor's update cycle
        queueMicrotask(() => this.pull());
      }

      private pull() {
        const cursors = presence.cursors(noteId);
        const viewers = presence.viewers(noteId);
        if (cursors === this.lastCursors && viewers === this.lastViewers) return;
        this.lastCursors = cursors;
        this.lastViewers = viewers;
        // Only the devices/tabs still on the note
        const here = new Set(viewers.map((v) => v.userId));
        this.view.dispatch({ effects: setCursors.of({ cursors: cursors.filter((c) => here.has(c.userId)), viewers }) });
      }

      update(u: ViewUpdate) {
        const focusIn = u.focusChanged && u.view.hasFocus;
        // Moves made here (clicks, typing, keys); text from elsewhere only shifts the cursor along
        const own = u.transactions.some((tr) => !tr.annotation(Transaction.remote) && (tr.selection || tr.docChanged));
        if (!focusIn && !own) return;
        const { head, anchor } = u.state.selection.main;
        presence.moveCursor(noteId, { head, anchor, ctx: cursorContext(u.state.doc, head) });
      }

      destroy() {
        this.unsubscribe();
      }
    }
  );
  return [cursorField, sync, cursorTheme];
}

const cursorTheme = EditorView.baseTheme({
  '.cm-remote-cursor': {
    position: 'relative',
    display: 'inline-block',
    width: '0',
    height: '1.2em',
    verticalAlign: 'text-bottom',
    borderLeft: '2px solid rgb(var(--rc))',
    marginLeft: '-1px',
    marginRight: '-1px',
    pointerEvents: 'none',
    zIndex: '5',
  },
  '.cm-remote-cursor-flag': {
    position: 'absolute',
    left: '-9px',
    bottom: '100%',
    marginBottom: '1px',
    width: '16px',
    height: '16px',
    borderRadius: '9999px',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgb(var(--rc))',
    boxShadow: '0 0 0 1.5px rgb(var(--rc)), 0 1px 3px rgb(0 0 0 / 0.3)',
    color: 'rgb(var(--surface))',
    fontSize: '9px',
    fontWeight: '700',
    lineHeight: '1',
    fontFamily: 'var(--font-sans)',
    pointerEvents: 'auto',
  },
  '.cm-remote-cursor-flag img': {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  '.cm-remote-cursor-name': {
    position: 'absolute',
    left: '10px',
    bottom: '100%',
    marginBottom: '3px',
    padding: '0 5px',
    borderRadius: '6px',
    background: 'rgb(var(--rc))',
    color: 'rgb(var(--surface))',
    fontSize: '10px',
    fontWeight: '600',
    lineHeight: '14px',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-sans)',
    opacity: '0',
    transition: 'opacity 150ms',
  },
  '.cm-remote-cursor:hover .cm-remote-cursor-name, .cm-remote-cursor-flag:hover + .cm-remote-cursor-name': { opacity: '1' },
  '.cm-remote-selection': { backgroundColor: 'rgb(var(--rc) / 0.22)' },
});
