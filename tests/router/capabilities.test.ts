import { describe, expect, it, vi } from 'vitest';
import { parseCapabilities } from '../../src/router/capabilities.js';
import { loadConfig } from '../../src/config/load.js';
import { createClient } from '../../src/router/client.js';

const VERSION = {
  title: '5.1.3',
  model: 'Keenetic Model (KN-0000)',
  hw_id: 'KN-0000',
  ndw: {
    features: 'wifi5ghz,hwnat,wpa3',
    components: 'base,dhcpd,wireguard,dns-tls'
  }
};

describe('parseCapabilities', () => {
  it('splits the comma-separated component and feature strings', () => {
    const caps = parseCapabilities(VERSION);
    expect(caps.components.has('wireguard')).toBe(true);
    expect(caps.components.has('torrent')).toBe(false);
    expect(caps.features.has('hwnat')).toBe(true);
    expect(caps.model).toBe('Keenetic Model (KN-0000)');
    expect(caps.hwId).toBe('KN-0000');
    expect(caps.firmware).toBe('5.1.3');
  });

  it('tolerates a router that omits the ndw block', () => {
    const caps = parseCapabilities({ title: '2.16', model: 'Old' });
    expect(caps.components.size).toBe(0);
    expect(caps.features.size).toBe(0);
    expect(caps.firmware).toBe('2.16');
  });
});

describe('client capability caching', () => {
  it('fetches the version once no matter how often capabilities are asked for', async () => {
    const client = createClient({ host: '192.0.2.1', login: 'admin', password: 'x' });
    const spy = vi.spyOn(client.rci, 'get').mockResolvedValue(VERSION);

    const a = await client.capabilities();
    const b = await client.capabilities();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});

describe('loadConfig', () => {
  it('reads host, login and password from the environment', () => {
    const cfg = loadConfig([], {
      KEENETIC_HOST: '192.0.2.1',
      KEENETIC_USER: 'root',
      KEENETIC_PASSWORD: 'secret'
    } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ host: '192.0.2.1', login: 'root', password: 'secret' });
  });

  it('defaults the login to admin and read-only to false', () => {
    const cfg = loadConfig([], {
      KEENETIC_HOST: '192.0.2.1',
      KEENETIC_PASSWORD: 'secret'
    } as NodeJS.ProcessEnv);
    expect(cfg.login).toBe('admin');
    expect(cfg.readOnly).toBe(false);
    expect(cfg.maxResponseBytes).toBe(25_000);
  });

  it('honours --read-only and --max-response-bytes', () => {
    const cfg = loadConfig(['--read-only', '--max-response-bytes', '4096'], {
      KEENETIC_HOST: '192.0.2.1',
      KEENETIC_PASSWORD: 'secret'
    } as NodeJS.ProcessEnv);
    expect(cfg.readOnly).toBe(true);
    expect(cfg.maxResponseBytes).toBe(4096);
  });

  it('names the missing variable when the password is absent', () => {
    expect(() => loadConfig([], { KEENETIC_HOST: '192.0.2.1' } as NodeJS.ProcessEnv)).toThrow(
      /KEENETIC_PASSWORD/
    );
  });
});
