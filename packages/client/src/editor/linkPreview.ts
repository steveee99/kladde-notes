/**
 * Link preview (#130, opt-in feature `linkPreview`): hovering a rendered `[[link]]` in the editor shows a floating
 * card with the target's title and the beginning of its text (a link to a heading or block shows that part); a long
 * press does the same on touch screens. Clicking the card opens the note. The card is built from text nodes only
 * (note text comes from other users and AI assistants), the text with its Markdown marks taken out.
 */
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { embedSection, parseEmbed, resolveVariables } from '@kladde/shared';
import { editorHost } from './host';
import { foreignFacet } from './embedContext';
import { t } from '../lib/i18n';

const HOVER_MS = 450;
const LONG_PRESS_MS = 500;
const HIDE_MS = 250;
const MAX_CHARS = 420;
const MAX_LINES = 9;

let longPressed = false;

/** True once after a long press showed the preview: the tap that ends it does not follow the link */
export function consumeLongPress(): boolean {
  const was = longPressed;
  longPressed = false;
  return was;
}

/** Markdown as readable plain text for the card: marks, link syntax and images out, one line per line */
export function previewText(markdown: string): string {
  const lines = markdown
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*```.*$/, '')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^(\s*)[-*+]\s+\[[ xXoOhH]\]\s+/, '$1☐ ')
        .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
        .replace(/!\[\[[^\]\n]*\]\]/g, '')
        .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
        .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
        .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
        .replace(/(\*\*|__|~~|==)/g, '')
        .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_]/g, '$1$2')
        .replace(/`([^`\n]*)`/g, '$1')
        .replace(/\s+\^[\w-]+\s*$/, '')
        .trimEnd()
    )
    .filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()));
  let out = lines.slice(0, MAX_LINES).join('\n').trim();
  if (out.length > MAX_CHARS) out = `${out.slice(0, MAX_CHARS).replace(/\s+\S*$/, '')} …`;
  else if (lines.length > MAX_LINES) out += ' …';
  return out;
}

/** What the card says about `target` (`Note`, `Note#Heading`, `Note#^block`) */
export function previewOf(target: string): { title: string; text: string; missing?: boolean; loading?: boolean } {
  const hash = target.indexOf('#');
  const ref = parseEmbed(hash < 0 ? target : target.slice(0, hash), hash < 0 ? '' : target.slice(hash));
  const note = ref && editorHost.resolveEmbed(ref.target);
  if (!ref || !note) return { title: target, text: t('preview.missing'), missing: true };
  const section = embedSection(note.content, ref);
  const title = ref.heading ? `${note.title} › ${ref.heading}` : note.title;
  if (!note.content && !section?.text) return { title, text: t('preview.loading'), loading: true };
  if (!section) return { title, text: t('preview.noSection') };
  const raw = note.variables ? resolveVariables(section.text, note.variables) : section.text;
  return { title, text: previewText(raw) || t('preview.empty') };
}

class LinkPreview {
  private card: HTMLDivElement | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private anchor: HTMLElement | null = null;

  constructor(private readonly view: EditorView) {
    view.dom.addEventListener('mouseover', this.onOver);
    view.dom.addEventListener('mouseout', this.onOut);
    view.dom.addEventListener('touchstart', this.onTouchStart, { passive: true });
    view.dom.addEventListener('touchend', this.cancelPress);
    view.dom.addEventListener('touchmove', this.cancelPress, { passive: true });
    window.addEventListener('scroll', this.hideNow, true);
    window.addEventListener('keydown', this.onKey, true);
  }

  private enabled(): boolean {
    return editorHost.linkPreview() && !this.view.state.facet(foreignFacet);
  }

  private linkOf(e: Event): HTMLElement | null {
    const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-wiki-target]');
    return el && this.view.dom.contains(el) ? el : null;
  }

  private onOver = (e: MouseEvent) => {
    if (!this.enabled()) return;
    const link = this.linkOf(e);
    if (!link) return;
    this.clearHide();
    if (this.anchor === link && this.card) return;
    this.clearShow();
    this.showTimer = setTimeout(() => this.show(link), HOVER_MS);
  };

  private onOut = (e: MouseEvent) => {
    if (!this.linkOf(e)) return;
    this.clearShow();
    this.scheduleHide();
  };

  private onTouchStart = (e: TouchEvent) => {
    if (!this.enabled() || e.touches.length !== 1) return;
    const link = this.linkOf(e);
    if (!link) return;
    this.cancelPress();
    this.pressTimer = setTimeout(() => {
      longPressed = true;
      this.show(link);
      // The tap that ends the press would follow the link; `consumeLongPress` stops it, and here as a fallback
      setTimeout(() => (longPressed = false), 1500);
    }, LONG_PRESS_MS);
  };

  private cancelPress = () => {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.card) {
      e.stopPropagation();
      this.hideNow();
    }
  };

  private clearShow() {
    if (this.showTimer) clearTimeout(this.showTimer);
    this.showTimer = null;
  }

  private clearHide() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private scheduleHide() {
    this.clearHide();
    this.hideTimer = setTimeout(this.hideNow, HIDE_MS);
  }

  hideNow = () => {
    this.clearShow();
    this.clearHide();
    this.anchor?.removeAttribute('aria-describedby');
    this.card?.remove();
    this.card = null;
    this.anchor = null;
  };

  private show(link: HTMLElement) {
    if (!link.isConnected) return;
    const target = link.dataset.wikiTarget!;
    this.card?.remove();
    const card = document.createElement('div');
    card.className = 'link-preview card anim-fade-in';
    card.setAttribute('role', 'tooltip');
    card.dataset.linkPreview = target;
    const fill = () => {
      const p = previewOf(target);
      card.replaceChildren();
      const title = document.createElement('div');
      title.className = 'link-preview-title';
      title.textContent = p.title;
      const text = document.createElement('div');
      text.className = `link-preview-text${p.missing || p.loading ? ' text-muted' : ''}`;
      text.textContent = p.text;
      card.append(title, text);
      if (!p.missing) {
        const hint = document.createElement('div');
        hint.className = 'link-preview-hint';
        hint.textContent = t('preview.open');
        card.append(hint);
      }
      return p;
    };
    const first = fill();
    // Online mode: the text arrives after `resolveEmbed` asked for it
    if (first.loading) setTimeout(() => card.isConnected && fill(), 700);
    card.addEventListener('mouseenter', () => this.clearHide());
    card.addEventListener('mouseleave', () => this.scheduleHide());
    card.addEventListener('click', () => {
      this.hideNow();
      if (!first.missing) editorHost.openWiki(target);
    });
    document.body.append(card);
    const r = link.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    card.style.left = `${left}px`;
    card.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - h)}px`;
    link.setAttribute('aria-describedby', 'link-preview');
    card.id = 'link-preview';
    this.card = card;
    this.anchor = link;
  }

  update(u: ViewUpdate) {
    // The links are drawn anew after an edit; a card over the old one would point nowhere
    if (u.docChanged && this.card) this.hideNow();
  }

  destroy() {
    this.hideNow();
    this.cancelPress();
    this.view.dom.removeEventListener('mouseover', this.onOver);
    this.view.dom.removeEventListener('mouseout', this.onOut);
    this.view.dom.removeEventListener('touchstart', this.onTouchStart);
    this.view.dom.removeEventListener('touchend', this.cancelPress);
    this.view.dom.removeEventListener('touchmove', this.cancelPress);
    window.removeEventListener('scroll', this.hideNow, true);
    window.removeEventListener('keydown', this.onKey, true);
  }
}

/** The editor extension; inert while the feature is off */
export const linkPreview = ViewPlugin.define((view) => new LinkPreview(view));
