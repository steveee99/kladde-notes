import {
  Math as DocxMath,
  MathFraction,
  MathIntegral,
  MathRadical,
  MathRun,
  MathSubScript,
  MathSubSuperScript,
  MathSum,
  MathSuperScript,
  type MathComponent,
} from 'docx';
import { KATEX_OPTIONS, loadKatex } from '../editor/math';

/**
 * Formulas (#85) in the Word and PDF export. Word gets real equations (OMML), converted from KaTeX's MathML;
 * the PDF gets the formula as KaTeX draws it, rasterized with html2canvas (the PDF fonts have no math glyphs).
 */

const SUM_OPS = new Set(['∑', '∏', '∐', '⋃', '⋂', '⨁', '⨂']);
const INT_OPS = new Set(['∫', '∬', '∭', '∮']);

function mathml(tex: string, display: boolean, katex: Awaited<ReturnType<typeof loadKatex>>): Element | null {
  try {
    const html = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display, output: 'mathml' });
    return new DOMParser().parseFromString(html, 'text/html').querySelector('math');
  } catch {
    return null;
  }
}

const textOf = (el: Element) => (el.textContent ?? '').replace(/⁡/g, '');

/** MathML elements as OMML components; unknown structures fall back to their text */
function convert(nodes: Element[]): MathComponent[] {
  const out: MathComponent[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const kids = [...el.children];
    const tag = el.localName;
    const bigOp = (base: Element, sub: Element | undefined, sup: Element | undefined) => {
      const op = textOf(base).trim();
      if (!SUM_OPS.has(op) && !INT_OPS.has(op)) return false;
      // The summand/integrand is what follows the operator
      const next = nodes[i + 1];
      const body = next ? convert([next]) : [new MathRun('')];
      if (next) i++;
      const opts = { children: body, ...(sub ? { subScript: convert([sub]) } : {}), ...(sup ? { superScript: convert([sup]) } : {}) };
      out.push(INT_OPS.has(op) ? new MathIntegral(opts) : new MathSum(opts));
      return true;
    };
    switch (tag) {
      case 'semantics':
      case 'mrow':
      case 'mstyle':
      case 'mpadded':
      case 'menclose':
        out.push(...convert(kids.filter((k) => k.localName !== 'annotation')));
        break;
      case 'annotation':
      case 'mphantom':
      case 'mspace':
        break;
      case 'mi':
      case 'mn':
      case 'mo':
        out.push(new MathRun(textOf(el)));
        break;
      case 'mtext':
        out.push(new MathRun({ text: textOf(el), normalText: true }));
        break;
      case 'mfrac':
        out.push(new MathFraction({ numerator: convert([kids[0]]), denominator: convert([kids[1]]) }));
        break;
      case 'msqrt':
        out.push(new MathRadical({ children: convert(kids) }));
        break;
      case 'mroot':
        out.push(new MathRadical({ children: convert([kids[0]]), degree: convert([kids[1]]) }));
        break;
      case 'msup':
        if (!bigOp(kids[0], undefined, kids[1])) out.push(new MathSuperScript({ children: convert([kids[0]]), superScript: convert([kids[1]]) }));
        break;
      case 'msub':
        if (!bigOp(kids[0], kids[1], undefined)) out.push(new MathSubScript({ children: convert([kids[0]]), subScript: convert([kids[1]]) }));
        break;
      case 'msubsup':
        if (!bigOp(kids[0], kids[1], kids[2])) out.push(new MathSubSuperScript({ children: convert([kids[0]]), subScript: convert([kids[1]]), superScript: convert([kids[2]]) }));
        break;
      case 'munder':
        if (!bigOp(kids[0], kids[1], undefined)) out.push(new MathSubScript({ children: convert([kids[0]]), subScript: convert([kids[1]]) }));
        break;
      case 'mover': {
        // Accents (\hat, \bar, \vec) and \overbrace: base with the mark as superscript
        if (!bigOp(kids[0], undefined, kids[1])) out.push(new MathSuperScript({ children: convert([kids[0]]), superScript: convert([kids[1]]) }));
        break;
      }
      case 'munderover':
        if (!bigOp(kids[0], kids[1], kids[2])) out.push(new MathSubSuperScript({ children: convert([kids[0]]), subScript: convert([kids[1]]), superScript: convert([kids[2]]) }));
        break;
      case 'mtable': {
        // Matrices and aligned lines: rows separated by semicolons inside brackets
        const rows = kids.map((row) => [...row.children].map((cell) => convert([...cell.children])));
        rows.forEach((cells, r) => {
          cells.forEach((cell, c) => {
            out.push(...cell);
            if (c < cells.length - 1) out.push(new MathRun('  '));
          });
          if (r < rows.length - 1) out.push(new MathRun(';  '));
        });
        break;
      }
      default:
        if (kids.length) out.push(...convert(kids));
        else if (textOf(el)) out.push(new MathRun(textOf(el)));
    }
  }
  // `\left( … \right)` comes as stretchy `mo` fences: kept as plain runs, which Word shows correctly
  return out;
}

/** A Word equation for a formula; KaTeX must be loaded (see `prepareMath`) */
export function mathToDocx(tex: string, display: boolean): DocxMath {
  const root = loadedKatex ? mathml(tex, display, loadedKatex) : null;
  const children = root ? convert([...root.children]) : [];
  return new DocxMath({ children: children.length ? children : [new MathRun(tex)] });
}

let loadedKatex: Awaited<ReturnType<typeof loadKatex>> | null = null;

export interface MathImage {
  dataUrl: string;
  /** Size in CSS pixels at `MATH_RENDER_PX` font size */
  width: number;
  height: number;
  /** Distance from the top to the text baseline, in CSS pixels */
  baseline: number;
}

/** Font size formulas are rasterized at: scale by (target font size / this) */
export const MATH_RENDER_PX = 32;

/** Loads KaTeX for the Word export (equations are built synchronously afterwards) */
export async function prepareMath(): Promise<void> {
  loadedKatex = await loadKatex();
}

/** Formulas drawn by KaTeX and rasterized for the PDF, key `display\ntex` */
export async function rasterizeMath(formulas: { tex: string; display: boolean }[]): Promise<Map<string, MathImage | null>> {
  const result = new Map<string, MathImage | null>();
  if (!formulas.length) return result;
  const katex = await loadKatex();
  loadedKatex = katex;
  const { default: html2canvas } = await import('html2canvas');
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, { position: 'fixed', left: '-10000px', top: '0', background: '#ffffff', color: '#1c1b22', fontSize: `${MATH_RENDER_PX}px`, lineHeight: '1.2', padding: '0' });
  document.body.append(host);
  try {
    for (const f of formulas) {
      const key = `${f.display ? 1 : 0}\n${f.tex}`;
      if (result.has(key)) continue;
      const box = document.createElement('span');
      box.style.display = 'inline-block';
      box.style.padding = '2px 1px';
      host.replaceChildren(box);
      try {
        katex.render(f.tex, box, { ...KATEX_OPTIONS, displayMode: f.display, output: 'html' });
        const display = box.querySelector<HTMLElement>('.katex-display');
        if (display) display.style.margin = '0';
        await document.fonts.ready;
        const rect = box.getBoundingClientRect();
        const strut = box.querySelector<HTMLElement>('.katex .base');
        const baseline = strut ? strut.getBoundingClientRect().bottom - rect.top - (parseFloat(getComputedStyle(strut).verticalAlign) || 0) : rect.height * 0.75;
        const canvas = await html2canvas(box, { backgroundColor: null, scale: 2, logging: false, useCORS: false });
        result.set(key, { dataUrl: canvas.toDataURL('image/png'), width: rect.width, height: rect.height, baseline: Math.min(rect.height, Math.max(0, baseline)) });
      } catch {
        result.set(key, null);
      }
    }
  } finally {
    host.remove();
  }
  return result;
}

export const mathKey = (tex: string, display: boolean) => `${display ? 1 : 0}\n${tex}`;
