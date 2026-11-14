import { useCallback, useEffect, useState } from 'react';
import type { PushDevice, PushSettings } from '@kladde/shared';
import { ArrowLeft, Bell, Smartphone, Trash2 } from '../lib/icons';
import { api } from '../lib/api';
import { locale, tl, useLang, type Lang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { Switch } from './Switch';

const DEVICE_KEY = 'kladde_push_device';

function storedDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

function storeDeviceId(id: string | null) {
  try {
    if (id) localStorage.setItem(DEVICE_KEY, id);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    // ignore
  }
}

/** Web Push needs a service worker and the Push API; on iPhone/iPad only in the app added to the Home Screen */
function pushSupport(): 'ok' | 'ios-install' | 'unsupported' {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (supported) return 'ok';
  return ios ? 'ios-install' : 'unsupported';
}

/** "Chrome · Android": enough to tell devices apart in the list */
function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

function keyBytes(base64url: string): Uint8Array {
  const raw = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function defaultSettings(lang: Lang): PushSettings {
  return { digestTime: null, quietStart: null, quietEnd: null, showText: false, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', lang };
}

/** Settings → Notifications: reminders for tasks with a time and a daily digest, per device (#26) */
export function NotificationSettingsView() {
  const lang = useLang();
  const loc = locale(lang);
  const support = pushSupport();
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [current, setCurrent] = useState<PushDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const permission = 'Notification' in window ? Notification.permission : 'default';

  const load = useCallback(async () => {
    const list = await api<PushDevice[]>('/push/devices');
    setDevices(list);
    const id = storedDeviceId();
    // Only counts as "on" when the browser still has its subscription too
    const reg = support === 'ok' ? await navigator.serviceWorker.getRegistration() : undefined;
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    const mine = (sub && list.find((d) => d.id === id)) || null;
    setCurrent(mine);
    if (!mine && id) storeDeviceId(null);
  }, [support]);

  useEffect(() => {
    load().catch((err) => setError((err as Error).message));
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    run(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) throw new Error(tl(lang, 'notify.noWorker'));
      if ((await Notification.requestPermission()) !== 'granted') throw new Error(tl(lang, 'notify.denied'));
      const { publicKey } = await api<{ publicKey: string }>('/push/key');
      const existing = await reg.pushManager.getSubscription();
      // A subscription made for another server key cannot be reused
      if (existing) await existing.unsubscribe();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
      const device = await api<PushDevice>('/push/devices', { method: 'POST', json: { subscription: sub.toJSON(), name: deviceName(), settings: defaultSettings(lang) } });
      storeDeviceId(device.id);
      await load();
    });

  const disable = () =>
    run(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
      if (current) setDevices(await api<PushDevice[]>(`/push/devices/${encodeURIComponent(current.id)}`, { method: 'DELETE' }));
      storeDeviceId(null);
      setCurrent(null);
    });

  const save = (patch: Partial<PushSettings>) => {
    if (!current) return;
    const settings = { ...current.settings, ...patch, timeZone: defaultSettings(lang).timeZone, lang };
    setCurrent({ ...current, settings });
    void run(async () => {
      const device = await api<PushDevice>(`/push/devices/${encodeURIComponent(current.id)}`, { method: 'PUT', json: { settings } });
      setCurrent(device);
    });
  };

  const test = () =>
    run(async () => {
      if (!current) return;
      await api(`/push/devices/${encodeURIComponent(current.id)}/test`, { method: 'POST' });
      setInfo(tl(lang, 'notify.testSent'));
    });

  const remove = (device: PushDevice) =>
    run(async () => {
      setDevices(await api<PushDevice[]>(`/push/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }));
    });

  const s = current?.settings;
  const others = devices?.filter((d) => d.id !== current?.id) ?? [];

  return (
    <div className="content-container space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 anim-fade-up">
        <button className="btn-icon -ml-2" onClick={() => navigate('/settings')} title={tl(lang, 'templates.backToSettings')}>
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-headline-m">{tl(lang, 'notify.title')}</h1>
      </div>
      <p className="text-sm text-on-surface-variant anim-fade-up">{tl(lang, 'notify.intro')}</p>

      <section className="card space-y-4 p-5 anim-fade-up">
        <h2 className="font-medium">{tl(lang, 'notify.thisDevice')}</h2>
        {support !== 'ok' ? (
          <p className="text-sm text-on-surface-variant">{tl(lang, support === 'ios-install' ? 'notify.iosInstall' : 'notify.unsupported')}</p>
        ) : (
          <>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                {tl(lang, 'notify.enable')}
                <span className="block text-xs text-on-surface-variant">{permission === 'denied' ? tl(lang, 'notify.blocked') : tl(lang, 'notify.enableDesc')}</span>
              </span>
              <Switch checked={!!current} disabled={busy || (permission === 'denied' && !current)} onChange={(on) => void (on ? enable() : disable())} label={tl(lang, 'notify.enable')} />
            </label>
            {s && (
              <>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    {tl(lang, 'notify.digest')}
                    <span className="block text-xs text-on-surface-variant">{tl(lang, 'notify.digestDesc')}</span>
                  </span>
                  <div className="flex items-center gap-2">
                    {s.digestTime && <input type="time" className="input w-28 py-1.5" value={s.digestTime} onChange={(e) => e.target.value && save({ digestTime: e.target.value })} aria-label={tl(lang, 'notify.digest')} />}
                    <Switch checked={!!s.digestTime} onChange={(on) => save({ digestTime: on ? '08:00' : null })} label={tl(lang, 'notify.digest')} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span>
                    {tl(lang, 'notify.quiet')}
                    <span className="block text-xs text-on-surface-variant">{tl(lang, 'notify.quietDesc')}</span>
                  </span>
                  <div className="flex items-center gap-2">
                    {s.quietStart && s.quietEnd && (
                      <>
                        <input type="time" className="input w-28 py-1.5" value={s.quietStart} onChange={(e) => e.target.value && save({ quietStart: e.target.value })} aria-label={tl(lang, 'notify.quietFrom')} />
                        <span className="text-on-surface-variant">–</span>
                        <input type="time" className="input w-28 py-1.5" value={s.quietEnd} onChange={(e) => e.target.value && save({ quietEnd: e.target.value })} aria-label={tl(lang, 'notify.quietTo')} />
                      </>
                    )}
                    <Switch checked={!!s.quietStart} onChange={(on) => save(on ? { quietStart: '22:00', quietEnd: '07:00' } : { quietStart: null, quietEnd: null })} label={tl(lang, 'notify.quiet')} />
                  </div>
                </div>
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    {tl(lang, 'notify.showText')}
                    <span className="block text-xs text-on-surface-variant">{tl(lang, 'notify.showTextDesc')}</span>
                  </span>
                  <Switch checked={s.showText} onChange={(on) => save({ showText: on })} label={tl(lang, 'notify.showText')} />
                </label>
                <button className="btn-outlined" disabled={busy} onClick={() => void test()}>
                  <Bell size={16} /> {tl(lang, 'notify.test')}
                </button>
              </>
            )}
          </>
        )}
        {info && <p className="text-sm text-on-surface-variant">{info}</p>}
        {error && <p className="text-sm text-error">{error}</p>}
      </section>

      <section className="card space-y-2 p-5 anim-fade-up">
        <h2 className="font-medium">{tl(lang, 'notify.howTitle')}</h2>
        <p className="text-sm text-on-surface-variant">{tl(lang, 'notify.how')}</p>
        <code className="block rounded-lg bg-surface-container-high px-3 py-2 text-sm">- [ ] Zahnarzt anrufen 📅 2026-11-20 ⏰ 09:00</code>
      </section>

      {others.length > 0 && (
        <section className="card divide-y divide-outline-variant anim-fade-up">
          <h2 className="p-5 pb-3 font-medium">{tl(lang, 'notify.otherDevices')}</h2>
          {others.map((device) => (
            <div key={device.id} className="flex items-center gap-3 p-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary-container text-on-secondary-container">
                <Smartphone size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{device.name}</div>
                <div className="truncate text-xs text-on-surface-variant">
                  {tl(lang, 'import.created')} {new Date(device.createdAt).toLocaleDateString(loc, { dateStyle: 'medium' })}
                  {device.settings.digestTime ? ` · ${tl(lang, 'notify.digestAt', { time: device.settings.digestTime })}` : ''}
                </div>
              </div>
              <button className="btn-icon h-8 w-8 shrink-0" title={tl(lang, 'notify.remove')} disabled={busy} onClick={() => void remove(device)}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
