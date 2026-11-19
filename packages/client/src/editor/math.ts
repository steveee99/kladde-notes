import { EditorView, WidgetType } from '@codemirror/view';
import type { KatexOptions } from 'katex';

/**
 * Formulas (#85) with KaTeX. KaTeX and its fonts are bundled with the app (no CDN, CSP) and loaded the first
 * time a note shows a formula. Rendering is safe for note text from others: `trust: false` turns off
 * `\href`, `\url`, `\includegraphics` and HTML extensions, errors show the source in the error color.
 */

type Katex = typeof import('katex').default;
let katex: Katex | null = null;
let loading: Promise<Katex> | null = null;

export function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([mod]) => {
    katex = mod.default;
    return katex;
  });
  return loading;
}

export const KATEX_OPTIONS: KatexOptions = { throwOnError: false, trust: false, strict: 'ignore', maxSize: 50, maxExpand: 500, output: 'htmlAndMathml' };

/** Renders into `el`, right away when KaTeX is loaded, else once it is; `done` runs after rendering */
export function renderMath(el: HTMLElement, tex: string, display: boolean, done?: () => void): void {
  const draw = (k: Katex) => {
    try {
      k.render(tex, el, { ...KATEX_OPTIONS, displayMode: display });
    } catch {
      el.textContent = tex;
      el.classList.add('cm-math-error');
    }
    done?.();
  };
  if (katex) return draw(katex);
  el.textContent = display ? `$$${tex}$$` : `$${tex}$`;
  el.classList.add('cm-math-loading');
  void loadKatex().then(
    (k) => {
      el.classList.remove('cm-math-loading');
      el.textContent = '';
      draw(k);
    },
    () => el.classList.replace('cm-math-loading', 'cm-math-error')
  );
}

/** A formula in the live preview: inline `$…$`, or a display block `$$…$$` (clicking it shows its source) */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly block: boolean
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display && other.block === this.block;
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = this.block ? 'cm-math cm-math-block' : `cm-math cm-math-inline${this.display ? ' cm-math-display' : ''}`;
    el.setAttribute('role', 'math');
    el.setAttribute('aria-label', this.tex);
    // Height changes once KaTeX has loaded: let the editor measure again
    renderMath(el, this.tex, this.display, () => view.requestMeasure());
    if (this.block && view.state.facet(EditorView.editable)) {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: view.posAtDOM(el) } });
        view.focus();
      });
    }
    return el;
  }
  ignoreEvent() {
    return this.block;
  }
}
