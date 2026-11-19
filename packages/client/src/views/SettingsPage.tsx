import type { ReactNode } from 'react';
import { ArrowLeft } from '../lib/icons';
import { tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';

/**
 * Frame of a settings subpage (title with a back button to the settings). `embedded` drops the frame so the
 * same content can sit in the "Settings" tab of a feature in the features dialog.
 */
export function SettingsPage({ title, embedded, children }: { title: string; embedded?: boolean; children: ReactNode }) {
  const lang = useLang();
  if (embedded) return <div className="space-y-4">{children}</div>;
  return (
    <div className="content-container space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 anim-fade-up">
        <button className="btn-icon -ml-2" onClick={() => navigate('/settings')} title={tl(lang, 'templates.backToSettings')}>
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-headline-m">{title}</h1>
      </div>
      {children}
    </div>
  );
}
