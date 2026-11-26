import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns';
import { ImportError, checkUrl, fetchImage, fetchPage, importRecipe, isPrivateAddress, safeLookup } from '../src/RecipeImport';

describe('recipe import URL guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.178.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', '64:ff9b::a00:1', '64:ff9b::192.168.1.1', '64:ff9b::7f00:1', '64:ff9b:1::1234:5678'])(
    'blocks %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(true)
  );

  it.each(['8.8.8.8', '1.1.1.1', '2a00:1450:4001::1', '64:ff9b::12f5:1f51', '64:ff9b::18.245.31.81', '64:ff9b:0:0:0:0:808:808'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('rejects non-web, local and odd-port links', () => {
    for (const url of ['file:///etc/passwd', 'http://localhost/', 'http://192.168.1.10/', 'http://[::1]/', 'https://example.com:8080/', 'https://user:pw@example.com/', 'kein link'])
      expect(() => checkUrl(url)).toThrow();
    expect(checkUrl(' https://www.chefkoch.de/rezepte/1 ').hostname).toBe('www.chefkoch.de');
  });
});

describe('recipe import DNS guard (safeLookup)', () => {
  const answer = (addresses: { address: string; family: number }[] | Error) =>
    vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _opts: unknown, cb: (err: Error | null, a?: unknown) => void) =>
      addresses instanceof Error ? cb(addresses) : cb(null, addresses)) as never);
  const lookup = (host: string, all = false) =>
    new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
      safeLookup(host, { all } as never, ((err: Error | null, address: unknown, family?: number) => resolve({ err, address, family })) as never)
    );
  afterEach(() => vi.restoreAllMocks());

  it('passes public addresses on, as one or as a list', async () => {
    answer([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
    expect(await lookup('example.com')).toEqual({ err: null, address: '93.184.216.34', family: 4 });
    expect((await lookup('example.com', true)).address).toHaveLength(2);
  });

  it('blocks a name when any of its addresses is private (DNS rebinding)', async () => {
    answer([{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.5', family: 4 }]);
    const { err } = await lookup('rebind.example');
    expect(err).toBeInstanceOf(ImportError);
    expect(err!.message).toContain('192.168.1.5');
  });

  it('reports names without addresses and passes DNS errors on', async () => {
    answer([]);
    expect((await lookup('leer.example')).err!.message).toMatch(/nicht auflösen/);
    const failure = new Error('ENOTFOUND');
    answer(failure);
    expect((await lookup('gibt-es-nicht.example')).err).toBe(failure);
  });

  it('refuses blocked links before any request', async () => {
    const spy = answer([{ address: '93.184.216.34', family: 4 }]);
    await expect(fetchPage('http://127.0.0.1/')).rejects.toThrow(ImportError);
    await expect(fetchImage('ftp://example.com/bild.png', 1000)).rejects.toThrow(/http/);
    await expect(importRecipe('kein link')).rejects.toThrow(/gültiger Link/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('turns unreachable hosts into an import error', async () => {
    answer(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    await expect(fetchPage('https://gibt-es-nicht.example/rezept')).rejects.toThrow(/nicht erreichbar/);
    await expect(fetchImage('https://gibt-es-nicht.example/bild.png', 1000)).rejects.toThrow(/nicht erreichbar/);
  });
});
