import { useState } from 'react';
import { localize } from '@kladde/plugin-api/client';
import { tl, useLang } from '../lib/i18n';
import { useVault } from '../data/vault';
import { PageBody, PageHeader } from '../views/PageHeader';
import { isPluginEnabled, resolvePluginPath, setPluginEnabled, WithPluginHost } from './registry';

/** `/p/<id>/…`: a plugin's page inside the shell, or why it cannot show */
export function PluginRoute({ path }: { path: string }) {
  useVault();
  const lang = useLang();
  const [busy, setBusy] = useState(false);
  const hit = resolvePluginPath(path);
  if (!hit) return <Missing text={tl(lang, 'plugins.notFound')} />;
  const { entry, page, params, sub } = hit;
  const name = localize(entry.plugin.name, lang);
  if (!isPluginEnabled(entry)) {
    return (
      <>
        <PageHeader title={name} subtitle={localize(entry.plugin.summary, lang)} />
        <PageBody>
          <p className="text-body-m text-muted">{tl(lang, 'plugins.off', { name })}</p>
          <button
            type="button"
            className="btn-primary mt-4"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void setPluginEnabled(entry.plugin.id, true).finally(() => setBusy(false));
            }}
          >
            {tl(lang, 'plugins.turnOn')}
          </button>
        </PageBody>
      </>
    );
  }
  if (!page) return <Missing text={tl(lang, 'plugins.notFound')} />;
  const Page = page.component;
  return (
    <WithPluginHost entry={entry}>
      <Page key={sub} params={params} path={sub} />
    </WithPluginHost>
  );
}

function Missing({ text }: { text: string }) {
  return <p className="py-16 text-center text-body-m text-muted">{text}</p>;
}
