import { useEffect, useState } from 'react';
import { ArrowLeft, CalendarDays, Plus, Trash2 } from '../lib/icons';
import { CALENDAR_FEED_DAYS, type CalendarFeed, type CalendarFeedCreated } from '@kladde/shared';
import { api } from '../lib/api';
import { locale, tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { Dropdown } from './Dropdown';
import { CopyField } from './McpSettings';
import { Switch } from './Switch';

/** Secret ICS addresses with the user's own due tasks, for subscribing in a calendar app (#34) */
export function CalendarSettingsView() {
  const lang = useLang();
  const loc = locale(lang);
  const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(loc, { dateStyle: 'medium' }) : tl(lang, 'import.never'));

  const [feeds, setFeeds] = useState<CalendarFeed[] | null>(null);
  const [created, setCreated] = useState<{ name: string; url: string } | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState<number>(CALENDAR_FEED_DAYS[0]);
  const [includeDone, setIncludeDone] = useState(false);
  const [showTitles, setShowTitles] = useState(true);
  const [folder, setFolder] = useState('');
  const [tag, setTag] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<CalendarFeed[]>('/calendar-feeds').then(setFeeds, (err) => setError((err as Error).message));
  }, []);

  const createFeed = async () => {
    setError('');
    try {
      const result = await api<CalendarFeedCreated>('/calendar-feeds', {
        method: 'POST',
        json: { name, days, options: { includeDone, showTitles, folder, tag, lang } },
      });
      setCreated({ name: result.feed.name, url: `${location.origin}${result.path}` });
      setName('');
      setFolder('');
      setTag('');
      setFeeds((list) => [result.feed, ...(list ?? [])]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (feed: CalendarFeed) => {
    if (!confirm(tl(lang, 'calendar.revokeConfirm', { name: feed.name }))) return;
    setError('');
    try {
      setFeeds(await api<CalendarFeed[]>(`/calendar-feeds/${encodeURIComponent(feed.id)}`, { method: 'DELETE' }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const describe = (feed: CalendarFeed) =>
    [
      feed.options.folder ? tl(lang, 'calendar.inFolder', { folder: feed.options.folder }) : tl(lang, 'calendar.allNotes'),
      feed.options.tag ? `#${feed.options.tag}` : '',
      feed.options.includeDone ? tl(lang, 'calendar.withDone') : '',
      feed.options.showTitles ? '' : tl(lang, 'calendar.noTitles'),
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <div className="content-container space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 anim-fade-up">
        <button className="btn-icon -ml-2" onClick={() => navigate('/settings')} title={tl(lang, 'templates.backToSettings')}>
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-headline-m">{tl(lang, 'calendar.title')}</h1>
      </div>
      <p className="text-sm text-on-surface-variant anim-fade-up">{tl(lang, 'calendar.intro')}</p>

      <section className="card space-y-3 p-5 anim-fade-up">
        <h2 className="font-medium">{tl(lang, 'calendar.createTitle')}</h2>
        <p className="text-sm text-on-surface-variant">{tl(lang, 'calendar.createDesc')}</p>
        {created ? (
          <div className="space-y-2 rounded-2xl border border-primary/40 bg-secondary-container/40 p-3.5 anim-fade-up">
            <p className="text-sm font-medium">{tl(lang, 'calendar.createdTitle', { name: created.name })}</p>
            <CopyField value={created.url} label={tl(lang, 'calendar.copyUrl')} />
            <p className="text-xs text-on-surface-variant">{tl(lang, 'calendar.subscribeHint')}</p>
            <button className="btn-ghost rounded-full px-4 text-sm" onClick={() => setCreated(null)}>
              {tl(lang, 'common.done')}
            </button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void createFeed();
            }}
          >
            <input className="input" placeholder={tl(lang, 'calendar.namePlaceholder')} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <div className="grid gap-2 sm:grid-cols-2">
              <input className="input" placeholder={tl(lang, 'calendar.folderPlaceholder')} maxLength={300} value={folder} onChange={(e) => setFolder(e.target.value)} />
              <input className="input" placeholder={tl(lang, 'calendar.tagPlaceholder')} maxLength={60} value={tag} onChange={(e) => setTag(e.target.value)} />
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{tl(lang, 'calendar.includeDone')}</span>
              <Switch checked={includeDone} onChange={setIncludeDone} label={tl(lang, 'calendar.includeDone')} />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                {tl(lang, 'calendar.showTitles')}
                <span className="block text-xs text-on-surface-variant">{tl(lang, 'calendar.showTitlesDesc')}</span>
              </span>
              <Switch checked={showTitles} onChange={setShowTitles} label={tl(lang, 'calendar.showTitles')} />
            </label>
            <div className="flex flex-col gap-1.5 text-sm text-on-surface-variant sm:flex-row sm:items-center sm:gap-2">
              <span className="shrink-0">{tl(lang, 'import.validFor')}</span>
              <Dropdown
                value={String(days)}
                onChange={(v) => setDays(Number(v))}
                aria-label={tl(lang, 'import.validFor')}
                className="sm:w-auto sm:min-w-[14rem]"
                options={[...CALENDAR_FEED_DAYS].sort((a, b) => a - b).map((d) => ({ value: String(d), label: tl(lang, 'import.days', { n: d }) }))}
              />
            </div>
            <button className="btn-ghost rounded-full border border-outline-variant px-4" type="submit">
              <Plus size={16} /> {tl(lang, 'calendar.createBtn')}
            </button>
          </form>
        )}
        {error && <p className="text-sm text-error">{error}</p>}
      </section>

      <section className="card divide-y divide-outline-variant anim-fade-up">
        <h2 className="p-5 pb-3 font-medium">{tl(lang, 'calendar.feedsTitle')}</h2>
        {feeds && !feeds.length && <p className="p-5 pt-3 text-sm text-on-surface-variant">{tl(lang, 'calendar.feedsEmpty')}</p>}
        {feeds?.map((feed) => (
          <div key={feed.id} className="flex items-center gap-3 p-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary-container text-on-secondary-container">
              <CalendarDays size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{feed.name}</div>
              <div className="truncate text-xs text-on-surface-variant">{describe(feed)}</div>
              <div className="truncate text-xs text-on-surface-variant">
                {feed.expiresAt <= Date.now() ? <span className="text-error">{tl(lang, 'import.expired')}</span> : `${tl(lang, 'import.expires')} ${when(feed.expiresAt)}`} ·{' '}
                {tl(lang, 'import.lastUsed')} {when(feed.lastUsedAt)}
              </div>
            </div>
            <button className="btn-icon h-8 w-8 shrink-0" title={tl(lang, 'import.revoke')} onClick={() => void revoke(feed)}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
