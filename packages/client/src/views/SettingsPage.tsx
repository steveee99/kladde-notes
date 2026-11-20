import type { ReactNode } from 'react';
import { ArrowLeft } from '../lib/icons';
import { tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { PageBody, PageHeader } from './PageHeader';

/**
 * Frame of a settings subpage (title with a back button to the settings). `embedded` drops the frame so the
 * same content can sit in the "Settings" tab of a feature in the features dialog.
 */
export function SettingsPage({ title, embedded, children }: { title: string; embedded?: boolean; children: ReactNode }) {
  const lang = useLang();
  if (embedded) return <div className="space-y-4">{children}</div>;
  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-1.5">
            <button className="btn-icon -ml-2 h-8 w-8" onClick={() => navigate('/settings')} title={tl(lang, 'templates.backToSettings')} aria-label={tl(lang, 'templates.backToSettings')}>
              <ArrowLeft size={18} />
            </button>
            {title}
          </span>
        }
      />
      <PageBody className="max-w-[960px] space-y-5 !mx-0">{children}</PageBody>
    </div>
  );
}
