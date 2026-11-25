import { useEffect, useState } from 'react';
import type { PushDevice, PushSettings } from '@kladde/shared';
import { api } from './api';
import { tl, type Lang } from './i18n';

/*
 * Web Push on this device (#26, #69): the subscription the settings page and the notifications panel turn on. A
 * device counts as "on" when the server knows it (its id in localStorage) and the browser still has the subscription.
 */

const DEVICE_KEY = 'kladde_push_device';

export function storedDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

export function storeDeviceId(id: string | null) {
  try {
    if (id) localStorage.setItem(DEVICE_KEY, id);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    // ignore
  }
}

/** Web Push needs a service worker and the Push API; on iPhone/iPad only in the app added to the Home Screen */
export function pushSupport(): 'ok' | 'ios-install' | 'unsupported' {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (supported) return 'ok';
  return ios ? 'ios-install' : 'unsupported';
}

/** "Chrome · Android": enough to tell devices apart in the list */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

export function keyBytes(base64url: string): Uint8Array {
  const raw = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function defaultSettings(lang: Lang): PushSettings {
  return { digestTime: null, quietStart: null, quietEnd: null, showText: false, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', lang };
}

/** Asks for permission, subscribes with the server's key and registers the device; returns it */
export async function subscribeDevice(lang: Lang): Promise<PushDevice> {
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
  return device;
}

export type DevicePushState = 'checking' | 'on' | 'off' | 'denied' | 'ios-install' | 'unsupported';

/** Whether this device gets notifications; `refresh` checks again (after turning them on) */
export function useDevicePush(): { state: DevicePushState; refresh: () => void } {
  const [state, setState] = useState<DevicePushState>('checking');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const support = pushSupport();
    if (support !== 'ok') {
      setState(support);
      return;
    }
    if (Notification.permission === 'denied') {
      setState('denied');
      return;
    }
    void (async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (alive) setState(sub && storedDeviceId() && Notification.permission === 'granted' ? 'on' : 'off');
    })().catch(() => alive && setState('off'));
    return () => {
      alive = false;
    };
  }, [tick]);
  return { state, refresh: () => setTick((t) => t + 1) };
}
