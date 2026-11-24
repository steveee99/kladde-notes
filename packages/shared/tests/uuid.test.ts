import { describe, expect, it } from 'vitest';
import { uuidV4 } from '../src/index.js';

describe('uuidV4', () => {
  it('sets only the version and variant bits', () => {
    expect(uuidV4(new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
    expect(uuidV4(new Uint8Array(16).fill(255))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(uuidV4(Uint8Array.from({ length: 16 }, (_, i) => i))).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('leaves the given bytes alone and needs exactly 16 of them', () => {
    const bytes = new Uint8Array(16).fill(255);
    uuidV4(bytes);
    expect([...bytes]).toEqual(Array(16).fill(255));
    expect(() => uuidV4(new Uint8Array(15))).toThrow(RangeError);
  });

  it('is a valid, different UUID for random bytes', () => {
    const ids = Array.from({ length: 1000 }, () => uuidV4(crypto.getRandomValues(new Uint8Array(16))));
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
