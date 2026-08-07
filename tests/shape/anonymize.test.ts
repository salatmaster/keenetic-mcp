import { beforeEach, describe, expect, it } from 'vitest';
import { anonymize, resetAnonymizer } from '../../src/shape/anonymize.js';

beforeEach(() => resetAnonymizer());

describe('anonymize', () => {
  it('maps a MAC address stably within one run', () => {
    const a = anonymize({ mac: 'aa:bb:cc:dd:ee:ff' }) as { mac: string };
    const b = anonymize({ mac: 'aa:bb:cc:dd:ee:ff' }) as { mac: string };
    expect(a.mac).toBe(b.mac);
    expect(a.mac).not.toBe('aa:bb:cc:dd:ee:ff');
    expect(a.mac).toMatch(/^02(:[0-9a-f]{2}){5}$/);
  });

  it('maps different MACs to different values', () => {
    const a = anonymize({ mac: 'aa:bb:cc:dd:ee:ff' }) as { mac: string };
    const b = anonymize({ mac: '11:22:33:44:55:66' }) as { mac: string };
    expect(a.mac).not.toBe(b.mac);
  });

  it('replaces hostnames, names and SSIDs', () => {
    const out = anonymize({ hostname: 'my-vacuum', name: 'Kitchen tablet', ssid: 'HomeNet' }) as Record<
      string,
      string
    >;
    expect(out['hostname']).toBe('host-1');
    expect(out['name']).toBe('device-1');
    expect(out['ssid']).toBe('ssid-1');
  });

  it('rewrites private IPv4 addresses into the documentation range', () => {
    const out = anonymize({ ip: '10.0.0.42' }) as { ip: string };
    expect(out.ip).toMatch(/^192\.0\.2\.\d+$/);
  });

  it('redacts anything that looks like key material', () => {
    const out = anonymize({ wireguard: { 'public-key': 'EXAMPLEKEYFORTESTSONLYEXAMPLEKEYFORTESTS01=' } }) as {
      wireguard: Record<string, string>;
    };
    expect(out.wireguard['public-key']).toBe('<redacted>');
  });

  it('walks nested arrays and objects', () => {
    const out = anonymize({ host: [{ mac: 'aa:bb:cc:dd:ee:ff' }] }) as { host: Array<{ mac: string }> };
    expect(out.host[0]?.mac).toMatch(/^02:/);
  });

  it('leaves harmless values untouched', () => {
    expect(anonymize({ cpuload: 6, link: 'up' })).toEqual({ cpuload: 6, link: 'up' });
  });
});
