import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configDir,
  gatewayCommand,
  identifyRouter,
  parseGateway,
  readStoredConfig,
  writeStoredConfig
} from '../../src/config/discover.js';

afterEach(() => vi.restoreAllMocks());

const MACOS_ROUTE = `   route to: default
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0
`;

const LINUX_ROUTE = 'default via 192.168.1.1 dev eth0 proto dhcp metric 100 \n';

describe('gatewayCommand', () => {
  it('uses route on macOS and ip on Linux', () => {
    expect(gatewayCommand('darwin').command).toBe('route');
    expect(gatewayCommand('linux').command).toBe('ip');
    expect(gatewayCommand('win32').command).toBe('powershell');
  });
});

describe('parseGateway', () => {
  it('reads the gateway out of macOS route output', () => {
    expect(parseGateway('darwin', MACOS_ROUTE)).toBe('192.168.1.1');
  });

  it('reads the gateway out of Linux ip output', () => {
    expect(parseGateway('linux', LINUX_ROUTE)).toBe('192.168.1.1');
  });

  it('reads a bare address out of PowerShell output', () => {
    expect(parseGateway('win32', '192.168.1.1\r\n')).toBe('192.168.1.1');
  });

  it('returns null when there is no default route', () => {
    expect(parseGateway('darwin', 'route: writing to routing socket: not in table\n')).toBeNull();
    expect(parseGateway('linux', '')).toBeNull();
  });

  // The macOS parser must key on the gateway line, not on the first address in
  // the output, or it would return the destination instead.
  it('does not confuse the destination for the gateway', () => {
    const output = 'destination: 198.51.100.0\n    gateway: 192.168.1.1\n';
    expect(parseGateway('darwin', output)).toBe('192.168.1.1');
  });
});

describe('identifyRouter', () => {
  it('recognises a Keenetic by its realm header', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 401, headers: { 'X-NDM-Realm': 'Keenetic Ultra' } })
    );
    await expect(identifyRouter('192.0.2.1', fetchImpl as unknown as typeof fetch)).resolves.toEqual(
      { realm: 'Keenetic Ultra' }
    );
  });

  it('recognises a Netcraze, which answers with the same realm header', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 401, headers: { 'X-NDM-Realm': 'Netcraze Speedster' } })
    );
    await expect(identifyRouter('192.0.2.1', fetchImpl as unknown as typeof fetch)).resolves.toEqual(
      { realm: 'Netcraze Speedster' }
    );
  });

  it('returns null for something that is not a Keenetic', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(
      identifyRouter('192.0.2.1', fetchImpl as unknown as typeof fetch)
    ).resolves.toBeNull();
  });

  it('returns null when nothing answers', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      identifyRouter('192.0.2.1', fetchImpl as unknown as typeof fetch)
    ).resolves.toBeNull();
  });
});

describe('configDir', () => {
  it('honours XDG_CONFIG_HOME on Linux', () => {
    expect(configDir('linux', { XDG_CONFIG_HOME: '/c' } as NodeJS.ProcessEnv)).toBe(
      '/c/keenetic-mcp'
    );
  });

  it('uses Application Support on macOS', () => {
    expect(configDir('darwin', { HOME: '/Users/u' } as NodeJS.ProcessEnv)).toBe(
      '/Users/u/Library/Application Support/keenetic-mcp'
    );
  });

  it('uses APPDATA on Windows with backslashes', () => {
    expect(configDir('win32', { APPDATA: 'C:\\a' } as NodeJS.ProcessEnv)).toBe(
      'C:\\a\\keenetic-mcp'
    );
  });
});

describe('stored config', () => {
  it('round-trips host and login', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-cfg-'));
    await writeStoredConfig(dir, { host: '192.0.2.1', login: 'admin' });
    await expect(readStoredConfig(dir)).resolves.toEqual({ host: '192.0.2.1', login: 'admin' });
  });

  it('returns null when nothing has been written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-cfg-'));
    await expect(readStoredConfig(dir)).resolves.toBeNull();
  });

  it('never stores a password', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-cfg-'));
    const path = await writeStoredConfig(dir, { host: '192.0.2.1', login: 'admin' });
    expect(await readFile(path, 'utf8')).not.toMatch(/password/i);
  });

  it('ignores a file that is missing the fields it needs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-cfg-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'config.json'), '{"host":"192.0.2.1"}', 'utf8');
    await expect(readStoredConfig(dir)).resolves.toBeNull();
  });
});
