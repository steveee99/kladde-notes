import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ChefHat, CheckSquare, FileText, Send } from '../lib/icons';
import { useVault, vault } from '../data/vault';
import { tl, useLang } from '../lib/i18n';
import { useVisualViewport } from '../lib/viewport';
import { importRecipe, newNote } from './Shell';

/** Bottom sheet for one-handed input on the phone: a thought or a task into the inbox, in two taps */
export function QuickCapture({ onClose }: { onClose: () => void }) {
  useVault();
  const lang = useLang();
  const recipeEnabled = vault.features().recipe.enabled;
  const [text, setText] = useState('');
  const [asTask, setAsTask] = useState(true);
  const vp = useVisualViewport();
  const save = async () => {
    if (text.trim()) await vault.capture(text.trim(), asTask);
    onClose();
  };
  return createPortal(
    <div
      className="fixed inset-x-0 z-50 flex items-end justify-center sm:items-center"
      style={vp ? { top: `${vp.top}px`, height: `${vp.height}px` } : { top: 0, bottom: 0 }}
    >
      <div className="fixed inset-0 bg-scrim/[0.32] anim-fade-in" onClick={onClose} />
      <div className="relative max-h-[min(90vh,100%)] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-surface-container-high px-4 pt-4 shadow-elevation-3 anim-sheet [--pad-bottom:1rem] safe-bottom sm:rounded-3xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-outline-variant sm:hidden" />
        <textarea
          autoFocus
          rows={3}
          className="input resize-none text-base"
          placeholder={asTask ? tl(lang, 'quick.taskPlaceholder') : tl(lang, 'quick.notePlaceholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              void save();
            }
          }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            className={`btn rounded-full px-3.5 ${asTask ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
            onClick={() => setAsTask(!asTask)}
          >
            <CheckSquare size={16} /> {tl(lang, 'quick.taskBtn')}
          </button>
          <button
            className="btn-ghost rounded-full px-3"
            onClick={() => {
              onClose();
              void newNote();
            }}
          >
            <FileText size={16} /> {tl(lang, 'quick.fullNoteBtn')}
          </button>
          {recipeEnabled && (
            <button
              className="btn-ghost rounded-full px-3"
              title={tl(lang, 'quick.recipeTitle')}
              onClick={() => {
                onClose();
                importRecipe(/^https?:\/\/\S+$/.test(text.trim()) ? text.trim() : undefined);
              }}
            >
              <ChefHat size={16} /> {tl(lang, 'quick.recipeBtn')}
            </button>
          )}
          <button className="btn-primary ml-auto rounded-full px-4" onClick={save}>
            <Send size={16} /> {tl(lang, 'quick.saveBtn')}
          </button>
        </div>
        <p className="mt-2 text-xs text-on-surface-variant">{asTask ? tl(lang, 'quick.taskHint') : tl(lang, 'quick.noteHint')}</p>
      </div>
    </div>,
    document.body
  );
}
