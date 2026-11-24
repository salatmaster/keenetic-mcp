import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configDir,
  gatewayCommand,
  identifyRouter,
  parseGateway,
  readStoredConfig,
  writeStoredRouter
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
  const HOME = { host: '192.0.2.1', login: 'admin' };
  const PARENTS = { host: '192.0.2.1', login: 'admin' };

  async function fresh(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'kn-cfg-'));
  }

  it('round-trips host and login', async () => {
    const dir = await fresh();
    await writeStoredRouter(dir, HOME);
    await expect(readStoredConfig(dir)).resolves.toEqual({ router: HOME, profiles: {} });
  });

  it('is empty when nothing has been written', async () => {
    const dir = await fresh();
    await expect(readStoredConfig(dir)).resolves.toEqual({ router: null, profiles: {} });
  });

  it('never stores a password', async () => {
    const dir = await fresh();
    const path = await writeStoredRouter(dir, HOME);
    await writeStoredRouter(dir, PARENTS, 'parents');
    expect(await readFile(path, 'utf8')).not.toMatch(/password/i);
  });

  it('ignores a file that is missing the fields it needs', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'config.json'), '{"host":"192.0.2.1"}', 'utf8');
    await expect(readStoredConfig(dir)).resolves.toEqual({ router: null, profiles: {} });
  });

  // 0.4 wrote host and login at the top level; that file has to keep working.
  it('reads a config written before profiles existed', async () => {
    const dir = await fresh();
    await writeFile(join(dir, 'config.json'), '{"host":"192.0.2.1","login":"admin"}', 'utf8');
    await expect(readStoredConfig(dir)).resolves.toEqual({ router: HOME, profiles: {} });
  });

  it('adds a profile without forgetting the default router', async () => {
    const dir = await fresh();
    await writeStoredRouter(dir, HOME);
    await writeStoredRouter(dir, PARENTS, 'parents');
    await expect(readStoredConfig(dir)).resolves.toEqual({
      router: HOME,
      profiles: { parents: PARENTS }
    });
  });

  it('rewrites the default router without forgetting the profiles', async () => {
    const dir = await fresh();
    await writeStoredRouter(dir, PARENTS, 'parents');
    await writeStoredRouter(dir, { host: '198.51.100.1', login: 'root' });
    await expect(readStoredConfig(dir)).resolves.toEqual({
      router: { host: '198.51.100.1', login: 'root' },
      profiles: { parents: PARENTS }
    });
  });

  it('skips a profile entry that is missing the fields it needs', async () => {
    const dir = await fresh();
    await writeFile(
      join(dir, 'config.json'),
      '{"profiles":{"broken":{"host":"192.0.2.1"},"parents":{"host":"192.0.2.1","login":"admin"}}}',
      'utf8'
    );
    await expect(readStoredConfig(dir)).resolves.toEqual({
      router: null,
      profiles: { parents: PARENTS }
    });
  });
});
