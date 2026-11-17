import { useState } from 'react';
import { ArrowLeft, CalendarDays, FilePlus2, LayoutTemplate, Pencil, Trash2 } from '../lib/icons';
import { INBOX_FOLDER, Template, TEMPLATE_PLACEHOLDERS } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { folderDisplayName, tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
import { Dropdown } from './Dropdown';

const newId = () => `tpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Own templates for new notes (projects, meetings …); stored in the synced settings, none at first */
export function TemplatesView() {
  useVault();
  const lang = useLang();
  const readOnly = useReadOnly();
  const templates = vault.templates();
  const [editing, setEditing] = useState<Template | null>(null);
  const [editingDaily, setEditingDaily] = useState(false);
  const daily = vault.features().daily;

  return (
    <div className="content-container space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 anim-fade-up">
        <button className="btn-icon -ml-2" onClick={() => navigate('/settings')} title={tl(lang, 'templates.backToSettings')}>
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-headline-m">{tl(lang, 'templates.title')}</h1>
      </div>
      <p className="text-sm text-on-surface-variant anim-fade-up">{tl(lang, 'templates.intro')}</p>

      {editingDaily ? (
        <TemplateEditor
          daily
          template={{ id: 'daily', label: tl(lang, 'templates.dailyLabel'), folder: daily.folder, content: vault.dailyTemplate() }}
          isNew={false}
          onDone={() => setEditingDaily(false)}
        />
      ) : editing ? (
        <TemplateEditor key={editing.id} template={editing} isNew={!templates.some((t) => t.id === editing.id)} onDone={() => setEditing(null)} />
      ) : (
        <>
          {daily.enabled && (
            <section className="card anim-fade-up">
              <div className="flex items-center gap-3 p-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary-container text-on-secondary-container">
                  <CalendarDays size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{tl(lang, 'templates.dailyLabel')}</div>
                  <div className="truncate text-xs text-on-surface-variant">{tl(lang, 'templates.dailyHint')}</div>
                </div>
                <button className="btn-icon h-8 w-8 shrink-0" disabled={readOnly} title={tl(lang, 'common.edit')} onClick={() => setEditingDaily(true)}>
                  <Pencil size={15} />
                </button>
              </div>
            </section>
          )}
          <section className="card divide-y divide-outline-variant anim-fade-up">
            {!templates.length && (
              <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-on-surface-variant">
                <LayoutTemplate size={28} className="text-on-surface-variant" />
                {tl(lang, 'templates.empty')}
              </div>
            )}
            {templates.map((t) => (
              <div key={t.id} className="flex items-center gap-3 p-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary-container text-on-secondary-container">
                  <LayoutTemplate size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.label}</div>
                  <div className="truncate text-xs text-on-surface-variant">{folderDisplayName(t.folder, lang)}</div>
                </div>
                <button className="btn-icon h-8 w-8 shrink-0" disabled={readOnly} title={tl(lang, 'common.edit')} onClick={() => setEditing(t)}>
                  <Pencil size={15} />
                </button>
                <button
                  className="btn-icon h-8 w-8 shrink-0"
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

/** Edits an own template; with `daily` the fixed daily note template (no name or folder, those come from the daily note settings) */
function TemplateEditor({ template, isNew, daily, onDone }: { template: Template; isNew: boolean; daily?: boolean; onDone: () => void }) {
  const lang = useLang();
  const [label, setLabel] = useState(template.label);
  const [folder, setFolder] = useState(template.folder);
  const [content, setContent] = useState(template.content);
  const folders = [...new Set([folder, ...vault.folders(), ''])];

  const placeholderLabel = (token: string, fallback: string) => {
    if (token === '{{title}}') return tl(lang, daily ? 'templates.placeholder.dailyTitle' : 'templates.placeholder.title');
    if (token === '{{date}}') return tl(lang, daily ? 'templates.placeholder.dailyDate' : 'templates.placeholder.date');
    if (token === '{{zid}}') return tl(lang, 'templates.placeholder.zid');
    return fallback;
  };

  const save = async () => {
    if (daily) {
      await vault.saveDailyTemplate(content);
      onDone();
      return;
    }
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
        if (daily || label.trim()) void save();
      }}
    >
      <h2 className="font-medium">{daily ? tl(lang, 'templates.dailyLabel') : isNew ? tl(lang, 'templates.createTitle') : tl(lang, 'templates.editTitle')}</h2>
      {daily ? (
        <p className="text-sm text-on-surface-variant">{tl(lang, 'templates.dailyHint')}</p>
      ) : (
        <>
          <input autoFocus={isNew} className="input" placeholder={tl(lang, 'templates.namePlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
          <div className="flex flex-col gap-1.5 text-sm text-on-surface-variant sm:flex-row sm:items-center sm:gap-2">
            <span className="shrink-0">{tl(lang, 'templates.folderLabel')}</span>
            <Dropdown
              value={folder}
              onChange={setFolder}
              aria-label={tl(lang, 'templates.folderLabel')}
              className="sm:w-auto sm:min-w-[14rem]"
              options={folders.map((f) => ({
                value: f,
                label: folderDisplayName(f, lang),
              }))}
            />
          </div>
        </>
      )}
      <textarea
        className="input min-h-[16rem] font-mono text-sm leading-relaxed"
        spellCheck={false}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={tl(lang, daily ? 'templates.dailyContentPlaceholder' : 'templates.contentPlaceholder')}
      />
      <div className="text-xs text-on-surface-variant">
        {tl(lang, 'templates.placeholdersLabel')}{' '}
        {TEMPLATE_PLACEHOLDERS.filter((p) => !daily || p.token !== '{{zid}}').map((p, i) => (
          <span key={p.token}>
            {i > 0 && ' · '}
            <button type="button" className="font-mono text-on-surface-variant hover:text-primary" title={tl(lang, 'templates.insertEndTitle')} onClick={() => setContent((c) => c + p.token)}>
              {p.token}
            </button>{' '}
            {placeholderLabel(p.token, p.label)}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <button className="btn-primary rounded-full px-5" disabled={!daily && !label.trim()}>
          {tl(lang, 'common.save')}
        </button>
        <button type="button" className="btn-ghost rounded-full px-4" onClick={onDone}>
          {tl(lang, 'common.cancel')}
        </button>
      </div>
    </form>
  );
}
