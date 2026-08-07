import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInit, type InitDeps } from '../../src/cli/init.js';
import { readStoredConfig } from '../../src/config/discover.js';

async function makeDeps(
  over: Partial<InitDeps> = {}
): Promise<{ deps: InitDeps; out: string[]; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kn-init-'));
  const out: string[] = [];
  const deps: InitDeps = {
    configDir: dir,
    prompt: vi.fn(async () => ''),
    hidden: vi.fn(async () => 'hunter2'),
    out: line => out.push(line),
    store: {
      save: vi.fn(async () => 'the system keychain'),
      read: vi.fn(async () => null),
      remove: vi.fn(async () => undefined)
    },
    discoverGateway: vi.fn(async () => '192.0.2.1'),
    identify: vi.fn(async () => ({ realm: 'Keenetic Ultra' })),
    verify: vi.fn(async () => ({
      ok: true as const,
      model: 'Keenetic Ultra (KN-1811)',
      firmware: '5.1.3',
      components: 43
    })),
    ...over
  };
  return { deps, out, dir };
}

describe('runInit', () => {
  it('discovers, verifies and stores', async () => {
    const { deps, out, dir } = await makeDeps();
    await expect(runInit(deps)).resolves.toBe(0);

    await expect(readStoredConfig(dir)).resolves.toEqual({ host: '192.0.2.1', login: 'admin' });
    expect(deps.store.save).toHaveBeenCalledWith('admin@192.0.2.1', 'hunter2');
    expect(out.join('\n')).toMatch(/Keenetic Ultra \(KN-1811\)/);
    expect(out.join('\n')).toMatch(/5\.1\.3/);
  });

  it('never prints the password', async () => {
    const { deps, out } = await makeDeps();
    await runInit(deps);
    expect(out.join('\n')).not.toContain('hunter2');
  });

  it('names both agents, not just one, plus the generic config', async () => {
    const { deps, out } = await makeDeps();
    await runInit(deps);
    const text = out.join('\n');
    expect(text).toMatch(/Claude Code/);
    expect(text).toMatch(/Codex/);
    expect(text).toMatch(/plugin marketplace add salatmaster\/keenetic-mcp/);
    expect(text).toMatch(/"command": "npx"/);
    expect(text).toMatch(/"keenetic-mcp"/);
  });

  it('fails with a usable message when nothing answers at the gateway', async () => {
    const { deps, out } = await makeDeps({ identify: vi.fn(async () => null) });
    await expect(runInit(deps)).resolves.toBe(1);
    expect(out.join('\n')).toMatch(/Keenetic/i);
  });

  it('stores nothing when the credentials are rejected', async () => {
    const { deps, out, dir } = await makeDeps({
      verify: vi.fn(async () => ({ ok: false as const, reason: 'HTTP 401' }))
    });
    await expect(runInit(deps)).resolves.toBe(1);
    expect(deps.store.save).not.toHaveBeenCalled();
    await expect(readStoredConfig(dir)).resolves.toBeNull();
    expect(out.join('\n')).toMatch(/rejected|401/i);
  });

  it('takes the host the user types over the discovered one', async () => {
    const { deps } = await makeDeps({ prompt: vi.fn(async () => '198.51.100.7') });
    await runInit(deps);
    expect(deps.identify).toHaveBeenCalledWith('198.51.100.7');
  });

  it('falls back to a sensible default when no gateway is found', async () => {
    const { deps } = await makeDeps({ discoverGateway: vi.fn(async () => null) });
    await runInit(deps);
    expect(deps.identify).toHaveBeenCalledWith('192.168.1.1');
  });

  it('reports where the secret went', async () => {
    const { deps, out } = await makeDeps();
    await runInit(deps);
    expect(out.join('\n')).toMatch(/system keychain/);
  });

  it('verifies before it writes anything', async () => {
    const order: string[] = [];
    const { deps } = await makeDeps({
      verify: vi.fn(async () => {
        order.push('verify');
        return { ok: true as const, model: 'M', firmware: '5.1.3', components: 1 };
      }),
      store: {
        save: vi.fn(async () => {
          order.push('save');
          return 'the system keychain';
        }),
        read: vi.fn(async () => null),
        remove: vi.fn(async () => undefined)
      }
    });
    await runInit(deps);
    expect(order).toEqual(['verify', 'save']);
  });
});
