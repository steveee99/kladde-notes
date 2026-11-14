import { useEffect, useRef, useState } from 'react';
import { sharedToMarkdown } from '@kladde/shared';
import { t } from '../lib/i18n';
import { navigate } from '../lib/router';
import { clearSharedItem, readSharedItem } from '../lib/shareTarget';
import { HomeView } from './Home';
import { QuickCapture, SharedContent } from './QuickCapture';

type Received = { shared: SharedContent; notice?: string };

/**
 * /share: "Share → Kladde" from another app. Opens Quick Capture prefilled with the shared link, text and
 * files; saving puts a new note into the inbox and shows the inbox.
 */
export function ShareCaptureView() {
  const [received, setReceived] = useState<Received | null>(null);
  const saved = useRef(false);
  const params = new URLSearchParams(location.search);
  const id = params.get('id') ?? '';
  const failed = params.has('error');

  useEffect(() => {
    let alive = true;
    const empty: SharedContent = { title: '', text: '', files: [] };
    const load = async (): Promise<Received> => {
      if (failed || !id) return { shared: empty, notice: t('quick.shareMissing') };
      const item = await readSharedItem(id);
      if (!item) return { shared: empty, notice: t('quick.shareMissing') };
      const { title, body } = sharedToMarkdown(item);
      return { shared: { title, text: body, files: item.files } };
    };
    load()
      .catch(() => ({ shared: empty, notice: t('quick.shareMissing') }))
      .then((r) => alive && setReceived(r));
    return () => {
      alive = false;
    };
  }, [id, failed]);

  return (
    <>
      <HomeView />
      {received && (
        <QuickCapture
          shared={received.shared}
          notice={received.notice}
          onSaved={() => (saved.current = true)}
          onClose={() => {
            if (id) void clearSharedItem(id).catch(() => {});
            navigate(saved.current ? '/inbox' : '/', true);
          }}
        />
      )}
    </>
  );
}
