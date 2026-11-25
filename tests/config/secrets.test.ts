import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSecretStore, keychainCommand, type Runner } from '../../src/config/secrets.js';

const SERVICE = 'keenetic-mcp';

function runner(result: { code: number; stdout: string }): Runner {
  return vi.fn().mockResolvedValue(result) as unknown as Runner;
}

describe('keychainCommand', () => {
  it('uses security on macOS', () => {
    const cmd = keychainCommand('darwin', 'read', 'admin@192.0.2.1');
    expect(cmd.command).toBe('security');
    expect(cmd.args).toContain('find-generic-password');
    expect(cmd.args).toContain(SERVICE);
  });

  it('uses secret-tool on Linux', () => {
    const cmd = keychainCommand('linux', 'read', 'admin@192.0.2.1');
    expect(cmd.command).toBe('secret-tool');
    expect(cmd.args[0]).toBe('lookup');
  });

  it('uses PowerShell on Windows and passes the secret on stdin', () => {
    const cmd = keychainCommand('win32', 'save', 'a');
    expect(cmd.command).toBe('powershell');
    expect(cmd.secretVia).toBe('stdin');
  });
});

describe('createSecretStore', () => {
  it('reads a secret back out of the keychain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-sec-'));
    const store = createSecretStore('darwin', runner({ code: 0, stdout: 'hunter2\n' }), dir);
    await expect(store.read('admin@192.0.2.1')).resolves.toBe('hunter2');
  });

  it('returns null when the keychain has no entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-sec-'));
    const store = createSecretStore('darwin', runner({ code: 44, stdout: '' }), dir);
    await expect(store.read('admin@192.0.2.1')).resolves.toBeNull();
  });

  it('passes the secret on stdin where the platform supports it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-sec-'));
    const spy = vi.fn().mockResolvedValue({ code: 0, stdout: 'hunter2\n' });
    const store = createSecretStore('linux', spy as unknown as Runner, dir);
    await store.save('admin@192.0.2.1', 'hunter2');

    const [, args, stdin] = spy.mock.calls[0]!;
    expect((args as string[]).join(' ')).not.toContain('hunter2');
    expect(stdin).toBe('hunter2');
  });

  it('appends the secret as the final argument on macOS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-sec-'));
    const spy = vi.fn().mockResolvedValue({ code: 0, stdout: 'hunter2\n' });
    const store = createSecretStore('darwin', spy as unknown as Runner, dir);
    await store.save('admin@192.0.2.1', 'hunter2');

    const [, args] = spy.mock.calls[0]!;
    expect((args as string[]).at(-1)).toBe('hunter2');
  });

  // An earlier version reported success while storing an empty string, because
  // it trusted the exit code alone.
  it('falls back to the file when the keychain claims success but stored nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-sec-'));
    const store = createSecretStore('darwin', runner({ code: 0, stdout: '' }), dir);

    await expect(store.save('admin@192.0.2.1', 'hunter2')).resolves.toMatch(/file/i);
    await expect(store.read('admin@192.0.2.1')).resolves.toBe('hunter2');
  });

  it('falls back to a 0600 file when the keychain tool is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-sec-'));
    const failing = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const store = createSecretStore('linux', failing as unknown as Runner, dir);

    const where = await store.save('admin@192.0.2.1', 'hunter2');
    expect(where).toMatch(/file/i);
    await expect(store.read('admin@192.0.2.1')).resolves.toBe('hunter2');

    const info = await stat(join(dir, 'secrets.json'));
    expect(info.mode & 0o077, 'the fallback file must not be group or world readable').toBe(0);
  });

  it('reports the keychain and writes no fallback file when the keychain really worked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-sec-'));
    // Echoing the secret back is what makes the keychain "working": the store
    // confirms the value rather than trusting the exit code.
    const store = createSecretStore('darwin', runner({ code: 0, stdout: 'hunter2\n' }), dir);
    await expect(store.save('admin@192.0.2.1', 'hunter2')).resolves.toMatch(/keychain/i);
    await expect(readFile(join(dir, 'secrets.json'), 'utf8')).rejects.toThrow();
  });
});
