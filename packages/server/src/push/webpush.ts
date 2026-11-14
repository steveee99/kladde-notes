import crypto from 'crypto';

/**
 * Web Push without a dependency: VAPID (RFC 8292) authenticates the server to the push service, and the
 * payload is encrypted for the device (RFC 8291, "aes128gcm" from RFC 8188), so the push service only
 * ever sees ciphertext.
 */

export interface PushTarget {
  endpoint: string;
  /** Device public key (uncompressed P-256 point, base64url) */
  p256dh: string;
  /** Device auth secret (16 bytes, base64url) */
  auth: string;
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (the browser's `applicationServerKey`) */
  publicKey: string;
  /** PKCS#8 PEM */
  privateKeyPem: string;
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x!), fromB64url(jwk.y!)]);
  return { publicKey: b64url(raw), privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

/**
 * Push services this server talks to. Subscriptions come from browsers, so their endpoint is checked:
 * https and a known push service only, never an address in the server's own network (SSRF).
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function allowedPushHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.PUSH_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...PUSH_HOSTS, ...extra];
}

export function isAllowedEndpoint(endpoint: unknown, hosts: string[]): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Valid device keys: a P-256 point (65 bytes) and a 16-byte auth secret */
export function isValidKeys(p256dh: unknown, auth: unknown): boolean {
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return false;
  const key = fromB64url(p256dh);
  if (key.length !== 65 || key[0] !== 0x04 || fromB64url(auth).length !== 16) return false;
  try {
    // Throws if the point is not on the curve
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(key);
    return true;
  } catch {
    return false;
  }
}

/** `Authorization` header for the push service of `endpoint` */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject })));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

/** Encrypts `payload` for the device (one aes128gcm record) */
export function encryptPayload(payload: Buffer, target: Pick<PushTarget, 'p256dh' | 'auth'>, salt = crypto.randomBytes(16), ecdh = crypto.createECDH('prime256v1')): Buffer {
  const uaPublic = fromB64url(target.p256dh);
  const authSecret = fromB64url(target.auth);
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hkdf(shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

export type PushOutcome = 'sent' | 'gone' | 'failed';

/** Sends one push message. 'gone' = the subscription no longer exists and should be deleted. */
export async function sendPush(target: PushTarget, payload: object, keys: VapidKeys, subject: string, opts: { ttl?: number; urgency?: 'normal' | 'high'; topic?: string } = {}): Promise<PushOutcome> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), target);
  try {
    const res = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(target.endpoint, keys, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(opts.ttl ?? 6 * 60 * 60),
        Urgency: opts.urgency ?? 'normal',
        ...(opts.topic ? { Topic: opts.topic } : {}),
      },
      body: new Uint8Array(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
