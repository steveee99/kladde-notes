import { useRef, useState } from 'react';
import { splitPath } from '@kladde/shared';
import { vault } from '../data/vault';
import { isReadOnly } from './readOnly';

/** What is being dragged: a note or a whole folder */
export type DragItem = { kind: 'note'; id: string } | { kind: 'folder'; path: string };

const MIME = 'application/x-kladde';
/** dataTransfer can only be read on drop, so the item is kept here for the dragover checks */
let current: DragItem | null = null;

export function dragSource(item: DragItem) {
  return {
    draggable: true,
    onDragStart(e: React.DragEvent) {
      e.stopPropagation();
      if (isReadOnly()) {
        e.preventDefault();
        return;
      }
      current = item;
      const el = e.currentTarget as HTMLElement;
      el.dataset.dragging = 'true';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(MIME, JSON.stringify(item));
      e.dataTransfer.setData('text/plain', item.kind === 'note' ? (vault.get(item.id)?.path ?? '') : item.path);
      // Next frame: the browser has taken its drag image, now the source may fade
      requestAnimationFrame(() => document.documentElement.classList.add('is-dragging'));
    },
    onDragEnd(e: React.DragEvent) {
      delete (e.currentTarget as HTMLElement).dataset.dragging;
      current = null;
      document.documentElement.classList.remove('is-dragging');
    },
  };
}

function canDrop(item: DragItem | null, folder: string): boolean {
  if (!item || isReadOnly()) return false;
  if (item.kind === 'note') {
    const note = vault.get(item.id);
    return !!note && note.access === 'owner' && splitPath(note.path).folder !== folder;
  }
  const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
  return parent !== folder && vault.canMoveFolder(item.path, folder);
}

/**
 * Makes an element a drop target for `folder` ('' = top level). `onHover` fires after hovering
 * a moment, e.g. to unfold a closed folder while dragging.
 */
export function useDropTarget(folder: string, onHover?: () => void) {
  const [over, setOver] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    setOver(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    over,
    props: {
      onDragOver(e: React.DragEvent) {
        if (!canDrop(current, folder)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (!over) {
          setOver(true);
          if (onHover) timer.current = setTimeout(onHover, 600);
        }
      },
      onDragLeave(e: React.DragEvent) {
        if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) clear();
      },
      onDrop(e: React.DragEvent) {
        clear();
        let item = current;
        try {
          item = JSON.parse(e.dataTransfer.getData(MIME)) as DragItem;
        } catch {
          // keep `current`
        }
        if (!canDrop(item, folder)) return;
        e.preventDefault();
        e.stopPropagation();
        if (item!.kind === 'note') void vault.moveNote(item!.id, folder);
        else void vault.moveFolder(item!.path, folder);
      },
    },
  };
}
