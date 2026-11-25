import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackupGuard, stateDir, writeBackup } from '../../src/router/backup.js';
import type { Rci } from '../../src/router/rci.js';

const CONFIG = '! $$$ Model: Keenetic Model\nip hotspot\n';
const CLOCK = () => new Date('2026-08-07T01:20:36Z');

afterEach(() => vi.unstubAllEnvs());

async function stateDirFor(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `kn-${label}-`));
  vi.stubEnv('KEENETIC_STATE_DIR', dir);
  return dir;
}

async function guardForTest() {
  await stateDirFor('guard');
  const spy = vi.fn().mockResolvedValue(CONFIG);
  return { spy, guard: createBackupGuard({ getText: spy } as unknown as Rci, '192.0.2.1', CLOCK) };
}

describe('stateDir', () => {
  it.each([
    ['uses XDG_STATE_HOME on Linux', 'linux', { XDG_STATE_HOME: '/x' }, '/x/keenetic-mcp'],
    [
      'falls back to ~/.local/state on Linux without XDG_STATE_HOME',
      'linux',
      { HOME: '/home/u' },
      '/home/u/.local/state/keenetic-mcp'
    ],
    [
      'uses Application Support on macOS',
      'darwin',
      { HOME: '/Users/u' },
      '/Users/u/Library/Application Support/keenetic-mcp'
    ],
    ['uses LOCALAPPDATA on Windows', 'win32', { LOCALAPPDATA: 'C:\\a' }, 'C:\\a\\keenetic-mcp'],
    [
      'lets KEENETIC_STATE_DIR override the platform choice',
      'darwin',
      { KEENETIC_STATE_DIR: '/custom' },
      '/custom'
    ]
  ] as const)('%s', (_title, platform, env, expected) => {
    expect(stateDir(platform, env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe('createBackupGuard', () => {
  it('writes the startup config, not the running one, and reports where it went', async () => {
    const { spy, guard } = await guardForTest();
    const result = await guard.ensure();

    expect(spy).toHaveBeenCalledWith('/ci/startup-config.txt');
    expect(result.bytes).toBe(CONFIG.length);
    expect(result.path).toContain('192.0.2.1');
    await expect(readFile(result.path, 'utf8')).resolves.toBe(CONFIG);
  });

  it('fetches once however many times it is asked', async () => {
    const { spy, guard } = await guardForTest();
    const first = await guard.ensure();
    const second = await guard.ensure();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('does not race when two writes start at once', async () => {
    const { spy, guard } = await guardForTest();
    const [a, b] = await Promise.all([guard.ensure(), guard.ensure()]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});

describe('writeBackup', () => {
  it('sanitizes the host before it becomes part of the file name', async () => {
    const dir = await stateDirFor('host');
    const out = await writeBackup('a/../b', CONFIG, CLOCK);

    expect(dirname(out.path)).toBe(join(dir, 'backups'));
    // The separators are gone: the name stays a single segment inside the dir.
    expect(basename(out.path)).not.toMatch(/[/\\]/);
    await expect(readFile(out.path, 'utf8')).resolves.toBe(CONFIG);
  });
});
