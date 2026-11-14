/**
 * Web Push reminders (imported into the generated service worker, see vite.config.ts).
 * The server sends an encrypted payload ({ title, body, tag, url, task?, lang? }, see PushPayload); without
 * the "show task text" option it contains no note text at all.
 */
const ACTION_LABELS = {
  de: { done: 'Erledigt', tomorrow: 'Morgen' },
  en: { done: 'Done', tomorrow: 'Tomorrow' },
};

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const labels = ACTION_LABELS[data.lang === 'en' ? 'en' : 'de'];
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' ? data.tag : 'kladde',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/', task: data.task || null },
  };
  // Action buttons where the platform has them (not on iOS)
  if (data.task && 'actions' in Notification.prototype) {
    options.actions = [
      { action: 'done', title: labels.done },
      { action: 'tomorrow', title: labels.tomorrow },
    ];
  }
  event.waitUntil(self.registration.showNotification(typeof data.title === 'string' ? data.title : 'Kladde', options));
});

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, task } = event.notification.data || {};
  if ((event.action === 'done' || event.action === 'tomorrow') && task) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    event.waitUntil(
      fetch('/api/push/action', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...task, action: event.action, date: localDate(tomorrow) }),
      }).catch(() => undefined)
    );
    return;
  }
  // Open the note in a running window if there is one (the app navigates without reloading), else a new one
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const win = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        win.postMessage({ type: 'kladde:navigate', url });
        return win.focus();
      }
      return self.clients.openWindow(url || '/');
    })
  );
});
