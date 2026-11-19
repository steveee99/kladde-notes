import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isTitleSlide, SLIDE_FORMATS, slideFormatOf, slideRatio, splitSlides, type NoteReleaseInfo, type SlideFormat } from '@kladde/shared';
import { Editor } from '../editor/Editor';
import type { EmbedResolver } from '../editor/embedContext';
import { AspectRatio, ChevronLeft, ChevronRight, CloseFullscreen, Fullscreen, SpeakerNotes, X } from '../lib/icons';
import { t, useLang } from '../lib/i18n';
import { useModal } from '../lib/modal';
import { Dropdown } from './Dropdown';

/*
 * Presentation mode (#87): the note as full-screen slides. Every slide is drawn on a fixed canvas whose short side
 * is 720 px in the note's format (16:9 = 1280 × 720) and scaled as a whole to the screen, so a slide looks the same
 * on a phone and on a projector. Text starts large and shrinks only as far as a full slide needs.
 */

/** Short side of the slide canvas in CSS px */
const SHORT_SIDE = 720;
/** Body text size on the canvas; headings, images and tables are sized in em, so they shrink with it */
const BASE_FONT = 34;
const MIN_FONT = 14;

export interface PresentationProps {
  /** Key of the note (editor instances per slide) */
  docKey: string;
  title: string;
  content: string;
  onClose: () => void;
  /** Saves another format on the note; without it (read-only) the choice lasts until the presentation ends */
  onFormat?: (format: SlideFormat) => void;
  resolveEmbed?: EmbedResolver;
  releases?: NoteReleaseInfo[] | null;
}

const canvasOf = (format: SlideFormat) => {
  const ratio = slideRatio(format);
  return ratio >= 1 ? { w: Math.round(SHORT_SIDE * ratio), h: SHORT_SIDE } : { w: SHORT_SIDE, h: Math.round(SHORT_SIDE / ratio) };
};

const fullscreenOn = () => typeof document !== 'undefined' && !!document.fullscreenElement;

export default function Presentation({ docKey, title, content, onClose, onFormat, resolveEmbed, releases = null }: PresentationProps) {
  useLang();
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const slides = useMemo(() => splitSlides(content, title), [content, title]);
  const [localFormat, setLocalFormat] = useState<SlideFormat | null>(null);
  const format = localFormat ?? slideFormatOf(content);
  const canvas = canvasOf(format);
  const [index, setIndex] = useState(0);
  const [notesOpen, setNotesOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [chrome, setChrome] = useState(true);
  const [isFull, setIsFull] = useState(fullscreenOn);
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const current = Math.min(index, slides.length - 1);
  const slide = slides[current];
  const centered = isTitleSlide(slide.markdown);

  const leave = useCallback(() => {
    if (fullscreenOn()) void document.exitFullscreen().catch(() => undefined);
    onClose();
  }, [onClose]);
  useModal(rootRef, leave);

  const go = useCallback((delta: number) => setIndex((i) => Math.max(0, Math.min(slides.length - 1, Math.min(i, slides.length - 1) + delta))), [slides.length]);

  const toggleFullscreen = useCallback(() => {
    // The whole page goes full screen (not just this layer), so menus opened from here stay visible
    if (fullscreenOn()) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.()?.catch(() => undefined);
  }, []);

  // Full screen right away (the click on "Start presentation" still counts as the user's gesture); left again at the end
  useEffect(() => {
    const onChange = () => setIsFull(fullscreenOn());
    document.addEventListener('fullscreenchange', onChange);
    if (!fullscreenOn()) void document.documentElement.requestFullscreen?.()?.catch(() => undefined);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (fullscreenOn()) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  // Keyboard: arrows, Page Up/Down (presenter remotes), space, Home/End, N for notes, F for full screen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      // Menus (the format list) and buttons keep their own keys
      if (target?.closest('[role="listbox"],[role="combobox"],[role="menu"],input,textarea,select')) return;
      const onButton = !!target?.closest('button,a[href]');
      let handled = true;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
          go(1);
          break;
        case ' ':
        case 'Enter':
          if (onButton) return;
          go(e.shiftKey ? -1 : 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          go(-1);
          break;
        case 'Home':
          setIndex(0);
          break;
        case 'End':
          setIndex(slides.length - 1);
          break;
        case 'n':
        case 'N':
          setNotesOpen((v) => !v);
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, slides.length, toggleFullscreen]);

  // The canvas scales to the free space (smaller with the speaker notes open)
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const pad = 16;
      const w = Math.max(1, stage.clientWidth - pad * 2);
      const h = Math.max(1, stage.clientHeight - pad * 2);
      setScale(Math.min(w / canvas.w, h / canvas.h));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [canvas.w, canvas.h, notesOpen]);

  // Text as large as possible: start at the base size and shrink while the slide overflows. Images and diagrams that
  // load later change the height, so the fit runs again when the content resizes.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let frame = 0;
    const fit = () => {
      let size = BASE_FONT;
      body.style.fontSize = `${size}px`;
      for (let i = 0; i < 16 && size > MIN_FONT && body.scrollHeight > body.clientHeight + 1; i++) {
        size = Math.max(MIN_FONT, size * 0.92);
        body.style.fontSize = `${size}px`;
      }
    };
    fit();
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    const inner = body.firstElementChild;
    if (inner) ro.observe(inner);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [slide.markdown, format]);

  // The controls fade out while the mouse rests and come back when it moves or something in them has focus
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setChrome(true);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!rootRef.current?.querySelector('[data-present-controls]')?.contains(document.activeElement)) setChrome(false);
      }, 2800);
    };
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);

  // Elapsed time for the speaker
  useEffect(() => {
    if (!notesOpen) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [notesOpen]);

  // Swipe on touch screens
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };

  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const changeFormat = (value: string) => {
    const next = value as SlideFormat;
    if (onFormat) onFormat(next);
    else setLocalFormat(next);
  };
  const controlBtn = 'btn-icon h-11 w-11 rounded-full text-on-surface disabled:opacity-40';

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${t('present.dialog')}: ${title}`}
      tabIndex={-1}
      data-presentation
      data-format={format}
      className={`no-print fixed inset-0 z-[95] flex flex-col bg-surface-container-lowest outline-none ${chrome ? '' : 'cursor-none'}`}
    >
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (swipe.current = null)}
      >
        <div style={{ width: canvas.w * scale, height: canvas.h * scale }} className="relative shrink-0">
          <section
            aria-roledescription="slide"
            aria-label={t('present.position', { current: current + 1, total: slides.length })}
            data-slide={current + 1}
            style={{ width: canvas.w, height: canvas.h, transform: `scale(${scale})` }}
            className="slide-canvas absolute left-0 top-0 origin-top-left overflow-hidden rounded-[24px] bg-surface text-on-surface shadow-soft ring-1 ring-outline-variant"
          >
            <div ref={bodyRef} className={`slide-body ${centered ? 'slide-title' : ''}`} style={{ fontSize: BASE_FONT }}>
              <div className="slide-inner">
                <Editor key={`${current}:${format}`} docKey={`present:${docKey}:${current}`} value={slide.markdown} readOnly resolveEmbed={resolveEmbed} releases={releases} />
              </div>
            </div>
            <div className="slide-footer" aria-hidden="true">
              <span className="truncate">{title}</span>
              <span className="tabular-nums">
                {current + 1} / {slides.length}
              </span>
            </div>
            <div className="slide-progress" aria-hidden="true" style={{ width: `${((current + 1) / slides.length) * 100}%` }} />
          </section>
        </div>
        <div
          data-present-controls
          className={`absolute inset-x-0 bottom-3 flex justify-center px-3 transition-opacity duration-300 focus-within:opacity-100 ${chrome ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        >
          <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-outline-variant bg-surface-container-high p-1 shadow-soft">
            <button type="button" className={controlBtn} title={t('present.prev')} aria-label={t('present.prev')} disabled={current === 0} onClick={() => go(-1)}>
              <ChevronLeft size={24} />
            </button>
            <span className="min-w-[4.5rem] px-1 text-center text-label-l tabular-nums text-on-surface" aria-live="polite">
              <span className="sr-only">{t('present.position', { current: current + 1, total: slides.length })}</span>
              <span aria-hidden="true">
                {current + 1} / {slides.length}
              </span>
            </span>
            <button type="button" className={controlBtn} title={t('present.next')} aria-label={t('present.next')} disabled={current >= slides.length - 1} onClick={() => go(1)}>
              <ChevronRight size={24} />
            </button>
            <span className="mx-1 h-6 w-px shrink-0 bg-outline-variant" aria-hidden="true" />
            <Dropdown
              variant="ghost"
              value={format}
              options={SLIDE_FORMATS.map((f) => ({ value: f, label: f }))}
              onChange={changeFormat}
              leadingIcon={<AspectRatio size={18} />}
              className="h-11 shrink-0 !rounded-full !px-3"
              title={t('present.format')}
              aria-label={t('present.format')}
            />
            <button
              type="button"
              className={`${controlBtn} ${notesOpen ? 'bg-secondary-container text-on-secondary-container' : ''}`}
              title={t('present.notes')}
              aria-label={t('present.notes')}
              aria-pressed={notesOpen}
              onClick={() => setNotesOpen((v) => !v)}
            >
              <SpeakerNotes size={22} />
            </button>
            {typeof document !== 'undefined' && document.fullscreenEnabled && (
              <button
                type="button"
                className={controlBtn}
                title={isFull ? t('present.exitFullscreen') : t('present.fullscreen')}
                aria-label={isFull ? t('present.exitFullscreen') : t('present.fullscreen')}
                onClick={toggleFullscreen}
              >
                {isFull ? <CloseFullscreen size={22} /> : <Fullscreen size={22} />}
              </button>
            )}
            <button type="button" className={controlBtn} title={t('present.close')} aria-label={t('present.close')} data-present-close onClick={leave}>
              <X size={22} />
            </button>
          </div>
        </div>
      </div>

      {notesOpen && (
        <aside aria-label={t('present.notes')} data-speaker-notes className="max-h-[38vh] shrink-0 overflow-y-auto border-t border-outline-variant bg-surface-container px-6 py-4 scrollbar-thin">
          <div className="mx-auto flex max-w-4xl items-start gap-6">
            <p className={`min-w-0 flex-1 whitespace-pre-wrap text-body-l ${slide.notes ? 'text-on-surface' : 'italic text-on-surface-variant'}`}>{slide.notes || t('present.noNotes')}</p>
            <span className="shrink-0 text-title-m tabular-nums text-on-surface-variant">{clock}</span>
          </div>
        </aside>
      )}

    </div>,
    document.body
  );
}
