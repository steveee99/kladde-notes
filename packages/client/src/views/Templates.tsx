import { useState } from 'react';
import { ArrowLeft, FilePlus2, LayoutTemplate, Pencil, Trash2 } from 'lucide-react';
import { INBOX_FOLDER, Template, TEMPLATE_PLACEHOLDERS } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { folderDisplayName, tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';

const newId = () => `tpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Own templates for new notes (projects, meetings …); stored in the synced settings, none at first */
export function TemplatesView() {
  useVault();
  const lang = useLang();
  const readOnly = useReadOnly();
  const templates = vault.templates();
  const [editing, setEditing] = useState<Template | null>(null);

  return (
    <div className="content-container space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 anim-fade-up">
        <button className="btn-icon -ml-2" onClick={() => navigate('/settings')} title={tl(lang, 'templates.backToSettings')}>
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-2xl font-bold tracking-tight">{tl(lang, 'templates.title')}</h1>
      </div>
      <p className="text-sm text-muted anim-fade-up">{tl(lang, 'templates.intro')}</p>

      {editing ? (
        <TemplateEditor key={editing.id} template={editing} isNew={!templates.some((t) => t.id === editing.id)} onDone={() => setEditing(null)} />
      ) : (
        <>
          <section className="card divide-y divide-line anim-fade-up">
            {!templates.length && (
              <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted">
                <LayoutTemplate size={28} className="text-faint" />
                {tl(lang, 'templates.empty')}
              </div>
            )}
            {templates.map((t) => (
              <div key={t.id} className="flex items-center gap-3 p-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-container/60 text-accent">
                  <LayoutTemplate size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.label}</div>
                  <div className="truncate text-xs text-faint">{folderDisplayName(t.folder, lang)}</div>
                </div>
                <button className="btn-icon h-8 w-8" disabled={readOnly} title={tl(lang, 'common.edit')} onClick={() => setEditing(t)}>
                  <Pencil size={15} />
                </button>
                <button
                  className="btn-icon h-8 w-8"
                  disabled={readOnly}
                  title={tl(lang, 'common.delete')}
                  onClick={() => confirm(tl(lang, 'templates.deleteConfirm', { label: t.label })) && void vault.removeTemplate(t.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </section>
          <button
            className="btn-primary rounded-full px-5 anim-fade-up"
            disabled={readOnly}
            onClick={() =>
              setEditing({
                id: newId(),
                label: '',
                folder: INBOX_FOLDER,
                content: '# {{title}}\n\n',
              })
            }
          >
            <FilePlus2 size={16} /> {tl(lang, 'templates.newBtn')}
          </button>
        </>
      )}
    </div>
  );
}

function TemplateEditor({ template, isNew, onDone }: { template: Template; isNew: boolean; onDone: () => void }) {
  const lang = useLang();
  const [label, setLabel] = useState(template.label);
  const [folder, setFolder] = useState(template.folder);
  const [content, setContent] = useState(template.content);
  const folders = [...new Set([folder, ...vault.folders(), ''])];

  const placeholderLabel = (token: string, fallback: string) => {
    if (token === '{{title}}') return tl(lang, 'templates.placeholder.title');
    if (token === '{{date}}') return tl(lang, 'templates.placeholder.date');
    if (token === '{{zid}}') return tl(lang, 'templates.placeholder.zid');
    return fallback;
  };

  const save = async () => {
    await vault.saveTemplate({
      id: template.id,
      label: label.trim(),
      folder,
      content,
    });
    onDone();
  };

  return (
    <form
      className="card space-y-3 p-5 anim-fade-up"
      onSubmit={(e) => {
        e.preventDefault();
        if (label.trim()) void save();
      }}
    >
      <h2 className="font-semibold">{isNew ? tl(lang, 'templates.createTitle') : tl(lang, 'templates.editTitle')}</h2>
      <input autoFocus={isNew} className="input" placeholder={tl(lang, 'templates.namePlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
      <label className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <span>{tl(lang, 'templates.folderLabel')}</span>
        <select className="input w-auto min-w-[12rem] py-1.5" value={folder} onChange={(e) => setFolder(e.target.value)}>
          {folders.map((f) => (
            <option key={f} value={f}>
              {folderDisplayName(f, lang)}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="input min-h-[16rem] font-mono text-sm leading-relaxed"
        spellCheck={false}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={tl(lang, 'templates.contentPlaceholder')}
      />
      <div className="text-xs text-faint">
        {tl(lang, 'templates.placeholdersLabel')}{' '}
        {TEMPLATE_PLACEHOLDERS.map((p, i) => (
          <span key={p.token}>
            {i > 0 && ' · '}
            <button type="button" className="font-mono text-muted hover:text-accent" title={tl(lang, 'templates.insertEndTitle')} onClick={() => setContent((c) => c + p.token)}>
              {p.token}
            </button>{' '}
            {placeholderLabel(p.token, p.label)}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <button className="btn-primary rounded-full px-5" disabled={!label.trim()}>
          {tl(lang, 'common.save')}
        </button>
        <button type="button" className="btn-ghost rounded-full px-4" onClick={onDone}>
          {tl(lang, 'common.cancel')}
        </button>
      </div>
    </form>
  );
}
