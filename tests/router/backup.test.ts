import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackupGuard, stateDir } from '../../src/router/backup.js';
import type { Rci } from '../../src/router/rci.js';

const CONFIG = '! $$$ Model: Keenetic Model\nip hotspot\n';
const CLOCK = () => new Date('2026-08-07T01:20:36Z');

function rciReturning(text: string, spy = vi.fn()): Rci {
  return { getText: spy.mockResolvedValue(text) } as unknown as Rci;
}

afterEach(() => vi.unstubAllEnvs());

describe('stateDir', () => {
  it('uses XDG_STATE_HOME on Linux', () => {
    expect(stateDir('linux', { XDG_STATE_HOME: '/x' } as NodeJS.ProcessEnv)).toBe(
      '/x/keenetic-mcp'
    );
  });

  it('falls back to ~/.local/state on Linux without XDG_STATE_HOME', () => {
    expect(stateDir('linux', { HOME: '/home/u' } as NodeJS.ProcessEnv)).toBe(
      '/home/u/.local/state/keenetic-mcp'
    );
  });

  it('uses Application Support on macOS', () => {
    expect(stateDir('darwin', { HOME: '/Users/u' } as NodeJS.ProcessEnv)).toBe(
      '/Users/u/Library/Application Support/keenetic-mcp'
    );
  });

  it('uses LOCALAPPDATA on Windows', () => {
    expect(stateDir('win32', { LOCALAPPDATA: 'C:\\a' } as NodeJS.ProcessEnv)).toBe(
      'C:\\a\\keenetic-mcp'
    );
  });

  it('lets KEENETIC_STATE_DIR override the platform choice', () => {
    expect(stateDir('darwin', { KEENETIC_STATE_DIR: '/custom' } as NodeJS.ProcessEnv)).toBe(
      '/custom'
    );
  });
});

describe('createBackupGuard', () => {
  it('writes the startup config and reports where it went', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-'));
    vi.stubEnv('KEENETIC_STATE_DIR', dir);

    const guard = createBackupGuard(rciReturning(CONFIG), '192.0.2.1', CLOCK);
    const result = await guard.ensure();

    expect(result.bytes).toBe(CONFIG.length);
    expect(result.path).toContain('192.0.2.1');
    await expect(readFile(result.path, 'utf8')).resolves.toBe(CONFIG);
  });

  it('fetches once however many times it is asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-'));
    vi.stubEnv('KEENETIC_STATE_DIR', dir);

    const spy = vi.fn();
    const guard = createBackupGuard(rciReturning(CONFIG, spy), '192.0.2.1', CLOCK);
    const first = await guard.ensure();
    const second = await guard.ensure();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('does not race when two writes start at once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-'));
    vi.stubEnv('KEENETIC_STATE_DIR', dir);

    const spy = vi.fn();
    const guard = createBackupGuard(rciReturning(CONFIG, spy), '192.0.2.1', CLOCK);
    const [a, b] = await Promise.all([guard.ensure(), guard.ensure()]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('reports nothing taken before the first write', () => {
    const guard = createBackupGuard(rciReturning(CONFIG), '192.0.2.1', CLOCK);
    expect(guard.taken()).toBeNull();
  });

  it('reads the startup config, not the running one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-'));
    vi.stubEnv('KEENETIC_STATE_DIR', dir);

    const spy = vi.fn();
    await createBackupGuard(rciReturning(CONFIG, spy), '192.0.2.1', CLOCK).ensure();
    expect(spy).toHaveBeenCalledWith('/ci/startup-config.txt');
  });
});
