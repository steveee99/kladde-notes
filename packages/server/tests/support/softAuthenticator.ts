import crypto from 'crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * A software passkey (ES256, attestation "none") for tests: answers the options the server hands out
 * with responses that `@simplewebauthn/server` verifies like those of a real authenticator.
 */

const b64url = (data: Uint8Array | Buffer | string) => Buffer.from(data).toString('base64url');
const sha256 = (data: Uint8Array | string) => crypto.createHash('sha256').update(data).digest();

interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
}

interface RequestOptions {
  challenge: string;
  rpId?: string;
}

export class SoftAuthenticator {
  readonly id = crypto.randomBytes(16);
  private readonly keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private counter = 0;
  /** The user handle of the account the passkey was made for */
  userHandle = '';

  constructor(readonly origin: string) {}

  get credentialId(): string {
    return b64url(this.id);
  }

  private publicKeyCose(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const key = new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
    ]);
    return isoCBOR.encode(key);
  }

  private authData(rpId: string, flags: number, attested?: Uint8Array): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** The answer to `navigator.credentials.create()` */
  create(options: CreationOptions, overrides: { origin?: string; challenge?: string } = {}) {
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    this.userHandle = options.user.id;
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.id.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.id, this.publicKeyCose()]);
    const authData = this.authData(rpId, 0x01 | 0x04 | 0x40, attested);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]) as never);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', overrides.challenge ?? options.challenge, overrides.origin)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** The answer to `navigator.credentials.get()`; `tamper` breaks the signature */
  get(options: RequestOptions, { tamper = false }: { tamper?: boolean } = {}) {
    const rpId = options.rpId ?? new URL(this.origin).hostname;
    this.counter++;
    const authData = this.authData(rpId, 0x01 | 0x04);
    const clientData = this.clientData('webauthn.get', options.challenge);
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.keys.privateKey);
    if (tamper) signature[signature.length - 1] ^= 0xff;
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}
