import { describe, expect, it } from 'vitest';
import { checkUrl, isPrivateAddress } from '../src/RecipeImport';

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
