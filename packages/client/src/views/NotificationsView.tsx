/**
 * Notifications (#69, #68): mentions, comments, replies and being added to a group, newest first, ten at a time.
 * The same list as the panel behind the bell in the top bar.
 */
import { useEffect } from 'react';
import { CheckCheck } from '../lib/icons';
import { useVault, vault } from '../data/vault';
import { tl, useLang } from '../lib/i18n';
import { DevicePushPrompt, NotificationList } from './NotificationsPanel';
import { PageBody, PageHeader } from './PageHeader';

export function NotificationsView() {
  useVault();
  const lang = useLang();
  useEffect(() => void vault.loadNotifications(), []);
  return (
    <div data-notifications>
      <PageHeader
        title={tl(lang, 'notices.title')}
        subtitle={tl(lang, 'notices.unread', { n: vault.unreadNotifications })}
        actions={
          vault.unreadNotifications > 0 && (
            <button className="btn-tonal" onClick={() => void vault.readNotifications()}>
              <CheckCheck size={16} /> {tl(lang, 'notices.readAll')}
            </button>
          )
        }
      />
      <PageBody className="max-w-[960px] space-y-3 !mx-0">
        <DevicePushPrompt />
        <div className="anim-fade-up">
          <NotificationList />
        </div>
      </PageBody>
    </div>
  );
}
