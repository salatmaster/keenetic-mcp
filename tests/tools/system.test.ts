import { describe, expect, it, vi } from 'vitest';
import { registerSystemTools } from '../../src/tools/system.js';
import { fail, type ToolContext } from '../../src/tools/registry.js';
import { AuthError } from '../../src/router/errors.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { captureTools, testContext, text, payload } from '../helpers/tools.js';

const CAPS = {
  model: 'Keenetic Model (KN-0000)',
  hwId: 'KN-0000',
  firmware: '5.1.3',
  components: new Set(['base', 'wireguard']),
  features: new Set(['hwnat'])
};

/** The memory fields of tests/fixtures/show_system.json, captured from a real router. */
const SHOW_SYSTEM = {
  memory: '156044/524288',
  memtotal: 524_288,
  memfree: 297_508,
  membuffers: 15_232,
  memcache: 55_504
};

function contextWith(
  get: (path: string) => Promise<unknown>,
  getText: (path: string) => Promise<string> = async () => ''
): ToolContext {
  const client = {
    rci: { get, post: vi.fn(), getText },
    capabilities: async () => CAPS
  } as unknown as KeeneticClient;
  return testContext(client);
}

function capture(ctx: ToolContext) {
  return captureTools(server => registerSystemTools(server, ctx));
}

describe('result helpers', () => {
  it('fail handles a non-Error value without crashing', () => {
    const result = fail('something odd');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('something odd');
  });
});

describe('get_system_info', () => {
  it('reports model, firmware and the component list', async () => {
    const { handlers } = capture(
      contextWith(async path => {
        if (path === 'show/system') {
          return {
            hostname: 'router',
            cpuload: 6,
            memtotal: 524_288,
            memfree: 300_728,
            uptime: '94683'
          };
        }
        throw new Error(`unexpected path ${path}`);
      })
    );

    const out = payload(await handlers['get_system_info']!({}));
    expect(out.model).toBe('Keenetic Model (KN-0000)');
    expect(out.firmware).toBe('5.1.3');
    expect(out.components).toContain('wireguard');
    expect(out.cpuLoad).toBe(6);
  });

  it('counts buffers and cache as available, matching the router used/total figure', async () => {
    const { handlers } = capture(
      contextWith(async path => {
        if (path === 'show/system') return SHOW_SYSTEM;
        throw new Error(`unexpected path ${path}`);
      })
    );

    const out = payload(await handlers['get_system_info']!({}));
    const used = Number(SHOW_SYSTEM.memory.split('/')[0]);
    expect(out.memoryFreeKb).toBe(297_508);
    expect(out.memoryAvailableKb).toBe(297_508 + 15_232 + 55_504);
    expect(out.memoryTotalKb - out.memoryAvailableKb).toBe(used);
  });

  it('reports available memory as null rather than guessing from a partial answer', async () => {
    const { handlers } = capture(
      contextWith(async () => ({ memtotal: 131_072, memfree: 15_360 }))
    );

    const out = payload(await handlers['get_system_info']!({}));
    expect(out.memoryAvailableKb).toBeNull();
  });

  it('returns isError instead of throwing when the router is unreachable', async () => {
    const { handlers } = capture(
      contextWith(async () => {
        throw new AuthError('the router rejected credentials for user "admin"');
      })
    );

    const result = await handlers['get_system_info']!({});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('keenetic-mcp init');
  });
});

describe('get_config_state', () => {
  const RUNNING = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const STALE = '0f9e8d7c6b5a49382716f5e4d3c2b1a0';

  /**
   * `fail-safe.unsaved` is false in every case here on purpose. A real 5.1.1
   * router reports it that way even with a change pending, so any answer that
   * comes from that flag rather than from the checksums is wrong.
   */
  const lastChange = async () => ({
    date: 'Thu, 6 Aug 2026 10:46:01 GMT',
    agent: 'http/rci',
    user: 'admin',
    checksum: RUNNING,
    'fail-safe': { unsaved: false, rollback: false, 'time-left': 0 }
  });

  const startupWith = (checksum: string) => async () =>
    `! $$$ Md5 checksum: ${checksum}\nip hotspot\n`;

  it('reports unsaved changes when flash still holds an older checksum', async () => {
    const { handlers } = capture(contextWith(lastChange, startupWith(STALE)));

    const out = payload(await handlers['get_config_state']!({}));
    expect(out.unsavedChanges).toBe(true);
    expect(out.runningChecksum).toBe(RUNNING);
    expect(out.savedChecksum).toBe(STALE);
    expect(out.lastChangedBy).toBe('admin');
    expect(out.failSafe.rollbackPending).toBe(false);
    expect(out.failSafe.unsaved).toBe(false);
  });

  it('reports saved once the checksums agree', async () => {
    const { handlers } = capture(contextWith(lastChange, startupWith(RUNNING)));

    const out = payload(await handlers['get_config_state']!({}));
    expect(out.unsavedChanges).toBe(false);
  });

  it('answers unknown rather than saved when the startup config cannot be read', async () => {
    const { handlers } = capture(
      contextWith(lastChange, async () => {
        throw new Error('404');
      })
    );

    const out = payload(await handlers['get_config_state']!({}));
    expect(out.unsavedChanges).toBeNull();
    expect(out.savedChecksum).toBeNull();
  });
});
