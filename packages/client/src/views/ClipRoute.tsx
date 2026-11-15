import { useEffect } from 'react';
import { openDialog } from '../lib/dialogs';
import { navigate } from '../lib/router';

/** `/clip?url=…&title=…&text=…` from the web clipper bookmarklet (#32): opens the clip dialog, then leaves the route */
export function ClipRoute() {
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const url = q.get('url') ?? '';
    navigate('/', true);
    openDialog({
      kind: 'clip',
      url: /^https?:\/\//i.test(url) ? url.slice(0, 2000) : '',
      title: (q.get('title') ?? '').slice(0, 300),
      selection: (q.get('text') ?? '').slice(0, 4000),
    });
  }, []);
  return null;
}
