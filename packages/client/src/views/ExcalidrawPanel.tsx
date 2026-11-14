/**
 * The canvas of a drawing note (`type: excalidraw`, see `shared/excalidrawNote.ts`). Loaded lazily
 * from NoteView because Excalidraw is large. Changes are written back into the note text (debounced);
 * scenes that arrive through sync are merged into the canvas element by element.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Excalidraw, MainMenu, hashElementsVersion, restoreElements, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawImperativeAPI, AppState, BinaryFiles, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { mergeExcalidrawElements } from '@kladde/shared';
import { appUrl } from '../lib/router';
import { useResolvedScheme } from '../lib/theme';
import { t, type Lang } from '../lib/i18n';
import { FileText, Maximize2, Minimize2 } from '../lib/icons';

// Fonts are served by the app itself (copied by the Vite plugin in vite.config.ts), never from a CDN
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = appUrl('/excalidraw-assets/');

const SAVE_DELAY = 600;

type Scene = { elements?: readonly ExcalidrawElement[]; appState?: Partial<AppState>; files?: BinaryFiles };

/** The parsed scene, an empty one for '', or null when the JSON is broken */
function parseScene(json: string): Scene | null {
  if (!json.trim()) return {};
  try {
    const data = JSON.parse(json) as Scene;
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/** What counts as a change worth saving: elements, background and attached images */
function sceneKey(elements: readonly ExcalidrawElement[], appState: Partial<AppState>, files: BinaryFiles): string {
  return `${hashElementsVersion(elements)}|${appState.viewBackgroundColor ?? ''}|${Object.keys(files).sort().join(',')}`;
}

export default function ExcalidrawPanel({
  scene,
  readOnly,
  lang,
  onSave,
  onEditText,
}: {
  /** Scene JSON from the note ('' for a new drawing) */
  scene: string;
  readOnly: boolean;
  lang: Lang;
  /** Not needed when read-only (public links) */
  onSave?: (json: string) => void;
  /** Without it (public links) the canvas offers no switch to the text */
  onEditText?: () => void;
}) {
  const scheme = useResolvedScheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  // Fullscreen covers the whole window (the canvas stays mounted, only its frame changes)
  const [fullscreen, setFullscreen] = useState(false);
  // The scene text last written or applied, to tell own saves from changes that came through sync
  const lastJson = useRef(scene);
  // null until the first onChange: Excalidraw reports the loaded scene once, which is no edit
  const lastKey = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // Only the first scene seeds the canvas; later ones are merged in below
  const initial = useMemo(() => parseScene(scene), []); // eslint-disable-line react-hooks/exhaustive-deps
  const initialData = useMemo<ExcalidrawInitialDataState | null>(
    () =>
      initial && {
        elements: initial.elements ?? [],
        appState: { ...initial.appState, collaborators: new Map() },
        files: initial.files,
        scrollToContent: true,
      },
    [initial]
  );

  // Writes only a pending edit: right after mounting Excalidraw may not have loaded the scene yet,
  // and saving then would replace the drawing with an empty one
  // The canvas as of its last onChange. Flushing serializes this, not the live canvas: when the note
  // is left, Excalidraw unmounts (and empties its scene) before this component's cleanup runs
  const latest = useRef<{ elements: readonly ExcalidrawElement[]; appState: AppState; files: BinaryFiles } | null>(null);

  const flush = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    const snap = latest.current;
    if (!snap || readOnly) return;
    const json = serializeAsJSON(snap.elements, snap.appState, snap.files, 'local');
    if (json === lastJson.current) return;
    lastJson.current = json;
    onSaveRef.current?.(json);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Save what is pending when the note is left, the tab is hidden or closed, or the app asks (Ctrl+S)
  useEffect(() => {
    const onFlush = () => flushRef.current();
    const onVisibility = () => document.visibilityState === 'hidden' && onFlush();
    window.addEventListener('kladde:flush-note', onFlush);
    window.addEventListener('pagehide', onFlush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('kladde:flush-note', onFlush);
      window.removeEventListener('pagehide', onFlush);
      document.removeEventListener('visibilitychange', onVisibility);
      onFlush();
    };
  }, []);

  // A scene from elsewhere (sync, history restore, text edit): merge it into the canvas
  useEffect(() => {
    if (!api || scene === lastJson.current) return;
    const remote = parseScene(scene);
    if (!remote) return;
    const pending = timer.current !== null;
    const merged = mergeExcalidrawElements(api.getSceneElementsIncludingDeleted().filter((e) => !e.isDeleted), remote.elements ?? [], pending);
    const elements = restoreElements(merged, null);
    const files = remote.files ? Object.values(remote.files) : [];
    if (files.length) api.addFiles(files);
    const bg = remote.appState?.viewBackgroundColor;
    api.updateScene({ elements, ...(bg ? { appState: { viewBackgroundColor: bg } } : {}) });
    lastJson.current = scene;
    lastKey.current = sceneKey(elements, { ...api.getAppState(), ...(bg ? { viewBackgroundColor: bg } : {}) }, api.getFiles());
  }, [api, scene]);

  if (!initialData) {
    return (
      <div className="mb-4 flex min-h-[60vh] flex-1 flex-col gap-2 anim-fade-in">
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-outline-variant bg-surface-container-low p-6 text-center text-sm text-on-surface-variant">
          {t('note.drawingBroken')}
          {onEditText && (
            <button type="button" className="btn-tonal" onClick={onEditText}>
              {t('note.drawingEditText')}
            </button>
          )}
        </div>
      </div>
    );
  }

  const toggleLabel = fullscreen ? t('note.drawingExitFullscreen') : t('note.drawingFullscreen');
  return (
    <div
      className={
        fullscreen
          ? 'fixed inset-0 z-[95] bg-surface'
          : 'excalidraw-host relative mb-4 h-[calc(100dvh-11rem)] min-h-[420px] overflow-hidden rounded-xl border border-outline-variant anim-fade-in'
      }
    >
      <Excalidraw
        // On narrow canvases the toolbar fills the row; the menu has the same entry there
        renderTopRightUI={(isMobile) =>
          isMobile ? null : (
          <button type="button" className="btn-icon rounded-full" onClick={() => setFullscreen((v) => !v)} title={toggleLabel} aria-label={toggleLabel}>
            {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          )
        }
        excalidrawAPI={setApi}
        initialData={initialData}
        theme={scheme}
        langCode={lang === 'de' ? 'de-DE' : 'en'}
        viewModeEnabled={readOnly}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false } }}
        onChange={(elements, appState, files) => {
          if (readOnly) return;
          latest.current = { elements, appState, files };
          const key = sceneKey(elements, appState, files);
          if (lastKey.current === null || key === lastKey.current) {
            lastKey.current = key;
            return;
          }
          lastKey.current = key;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => flushRef.current(), SAVE_DELAY);
        }}
      >
        {/* Excalidraw's menu (bottom left) with Kladde's own entries; loading/saving files and the theme are handled by the app */}
        <MainMenu>
          {onEditText && (
            <MainMenu.Item icon={<FileText size={16} />} onSelect={onEditText}>
              {t('note.drawingEditText')}
            </MainMenu.Item>
          )}
          <MainMenu.Item icon={fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />} onSelect={() => setFullscreen((v) => !v)}>
            {toggleLabel}
          </MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.SaveAsImage />
          {!readOnly && <MainMenu.DefaultItems.Export />}
          <MainMenu.DefaultItems.Help />
          {!readOnly && <MainMenu.DefaultItems.ClearCanvas />}
          {!readOnly && <MainMenu.Separator />}
          {!readOnly && <MainMenu.DefaultItems.ChangeCanvasBackground />}
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
