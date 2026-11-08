import { useState } from 'react';
import { FileText, Lightbulb, X } from 'lucide-react';
import { BUILTIN_TEMPLATES, PARA, Template, ZETTEL_TYPES, ZettelType } from '@kladde/shared';
import { vault } from '../data/vault';
import { closeDialog, useDialog } from '../lib/dialogs';
import { navigate } from '../lib/router';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40 anim-fade-in" onClick={onClose} />
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-surface px-5 pt-5 shadow-soft anim-sheet [--pad-bottom:1.25rem] safe-bottom sm:rounded-3xl">
        <div className="mb-4 flex items-center">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn-icon ml-auto" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function NewNoteDialog({ folder }: { folder?: string }) {
  const templates: Template[] = [...BUILTIN_TEMPLATES, ...vault.userTemplates()];
  const [template, setTemplate] = useState<Template | null>(null);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState(folder ?? PARA.inbox);
  const folders = vault.folders();
  const choose = (t: Template | null) => {
    setTemplate(t);
    // A template brings its home folder, unless the user started from a specific folder
    if (!folder && t) setTarget(t.folder);
  };
  const create = async () => {
    const note = await vault.createFromTemplate(template, title.trim() || (template?.label ?? 'Neue Notiz'), target);
    closeDialog();
    navigate(`/n/${note.id}${title.trim() ? '' : '?new=1'}`);
  };
  return (
    <Sheet title="Neue Notiz" onClose={closeDialog}>
      <div className="mb-4 grid grid-cols-3 gap-2">
        {[null, ...templates].map((t) => (
          <button
            key={t?.id ?? 'leer'}
            onClick={() => choose(t)}
            className={`truncate rounded-xl border px-2 py-2.5 text-sm transition-all duration-150 ${template?.id === t?.id ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted hover:border-faint hover:text-ink'}`}
          >
            {t?.label ?? 'Leer'}
          </button>
        ))}
      </div>
      <input autoFocus className="input mb-3" placeholder="Titel" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
      <label className="mb-4 flex items-center gap-2 text-sm text-muted">
        Ordner
        <select className="input py-1.5" value={target} onChange={(e) => setTarget(e.target.value)}>
          {[...new Set([target, ...folders])].map((f) => (
            <option key={f} value={f}>
              {f || '(oberste Ebene)'}
            </option>
          ))}
        </select>
      </label>
      <button className="btn-primary w-full py-2.5" onClick={create}>
        <FileText size={16} /> Anlegen
      </button>
      <p className="mt-3 text-xs text-faint">Eigene Vorlagen: Notizen in einem Ordner namens „Vorlagen“. Platzhalter: {'{{title}}'}, {'{{date}}'}.</p>
    </Sheet>
  );
}

function ZettelDialog() {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<ZettelType>('flüchtig');
  const [source, setSource] = useState('');
  const create = async () => {
    if (!title.trim()) return;
    const note = await vault.createZettel(title.trim(), type, source.trim());
    closeDialog();
    navigate(`/n/${note.id}`);
  };
  return (
    <Sheet title="Neuer Zettel" onClose={closeDialog}>
      <input autoFocus className="input mb-3" placeholder="Ein Gedanke in einem Satz" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
      <div className="mb-3 grid gap-2">
        {ZETTEL_TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => setType(t.id)}
            className={`rounded-xl border p-3 text-left transition-all duration-150 ${type === t.id ? 'border-accent bg-accent/10' : 'border-line hover:border-faint'}`}
          >
            <div className={`text-sm font-medium ${type === t.id ? 'text-accent' : ''}`}>{t.label}</div>
            <div className="text-xs text-muted">{t.hint}</div>
          </button>
        ))}
      </div>
      {type === 'literatur' && <input className="input mb-3 anim-fade-in" placeholder="Quelle (Buch, Artikel, Link …)" value={source} onChange={(e) => setSource(e.target.value)} />}
      <button className="btn-primary w-full py-2.5" disabled={!title.trim()} onClick={create}>
        <Lightbulb size={16} /> Zettel anlegen
      </button>
      <p className="mt-3 text-xs text-faint">Der Zettel bekommt eine feste ID. Links wie [[202611081530]] bleiben gültig, auch wenn du den Titel änderst.</p>
    </Sheet>
  );
}

export function Dialogs() {
  const dialog = useDialog();
  if (dialog?.kind === 'note') return <NewNoteDialog folder={dialog.folder} />;
  if (dialog?.kind === 'zettel') return <ZettelDialog />;
  return null;
}
