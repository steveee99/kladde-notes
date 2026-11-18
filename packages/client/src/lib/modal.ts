import { useEffect, useRef, useState, type RefObject } from 'react';

/*
 * Keyboard behaviour of dialogs and bottom sheets (#63): focus moves into the dialog when it opens, Tab and Shift+Tab
 * stay inside it, Escape closes it, and focus returns to where it was when the dialog closes (unless something else,
 * such as a newly opened note, took it in the meantime). With dialogs on top of each other only the topmost reacts.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

const stack: HTMLElement[] = [];

const visible = (el: HTMLElement) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

/** Modal keyboard handling for the element in `ref` while it is mounted; give it `tabIndex={-1}` so it can hold focus itself */
export function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Taken while rendering the first time: by the time effects run, an autoFocus field inside already has the focus
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = opener;
    stack.push(el);
    // An element inside that focused itself (autoFocus) keeps the focus; a sheet hidden by CSS (on wide screens) does nothing
    if (visible(el) && !el.contains(document.activeElement)) {
      // The first field to type in, otherwise the first control (often the close button)
      const items = focusableIn(el);
      const first = el.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ?? items.find((i) => i.matches('input:not([type=checkbox]):not([type=radio]),textarea,select')) ?? items[0];
      (first ?? el).focus({ preventScroll: true });
    }

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== el || !visible(el)) return;
      if (e.key === 'Escape') {
        // A menu or list inside (Dropdown, autocomplete) handles its own Escape first
        if (e.defaultPrevented) return;
        e.preventDefault();
        closeRef.current();
      } else if (e.key === 'Tab') {
        const items = focusableIn(el);
        if (!items.length) {
          e.preventDefault();
          el.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === el || !el.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !el.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      const i = stack.lastIndexOf(el);
      if (i >= 0) stack.splice(i, 1);
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if (previous?.isConnected && (!now || now === document.body || !now.isConnected)) previous.focus({ preventScroll: true });
      });
    };
  }, [ref, opener]);
}
