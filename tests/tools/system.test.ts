import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerSystemTools } from '../../src/tools/system.js';
import { fail, ok, type ToolContext, type ToolResult } from '../../src/tools/registry.js';
import { AuthError } from '../../src/router/errors.js';
import type { KeeneticClient } from '../../src/router/client.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
interface Captured {
  handlers: Record<string, Handler>;
  configs: Record<string, { annotations?: { readOnlyHint?: boolean } }>;
}

const CAPS = {
  model: 'Keenetic Model (KN-0000)',
  hwId: 'KN-0000',
  firmware: '5.1.3',
  components: new Set(['base', 'wireguard']),
  features: new Set(['hwnat'])
};

function contextWith(get: (path: string) => Promise<unknown>): ToolContext {
  const client = {
    rci: { get, post: vi.fn(), getText: vi.fn() },
    capabilities: async () => CAPS
  } as unknown as KeeneticClient;
  return { client, maxResponseBytes: 25_000, readOnly: false };
}

/** Registers the tools against a real McpServer with registerTool intercepted. */
function capture(ctx: ToolContext): Captured {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers: Record<string, Handler> = {};
  const configs: Record<string, { annotations?: { readOnlyHint?: boolean } }> = {};
  vi.spyOn(server, 'registerTool').mockImplementation(((
    name: string,
    config: { annotations?: { readOnlyHint?: boolean } },
    handler: Handler
  ) => {
    handlers[name] = handler;
    configs[name] = config;
    return {} as never;
  }) as never);

  registerSystemTools(server, ctx);
  return { handlers, configs };
}

function textOf(result: ToolResult): string {
  return result.content.map(part => part.text).join('');
}

describe('result helpers', () => {
  it('ok serialises the payload as JSON text', () => {
    expect(JSON.parse(textOf(ok({ a: 1 })))).toEqual({ a: 1 });
  });

  it('fail marks isError and includes the guidance', () => {
    const result = fail(new AuthError('bad credentials'));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('keenetic-mcp init');
  });

  it('fail handles a non-Error value without crashing', () => {
    const result = fail('something odd');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('something odd');
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

    const payload = JSON.parse(textOf(await handlers['get_system_info']!({})));
    expect(payload.model).toBe('Keenetic Model (KN-0000)');
    expect(payload.firmware).toBe('5.1.3');
    expect(payload.components).toContain('wireguard');
    expect(payload.cpuLoad).toBe(6);
  });

  it('returns isError instead of throwing when the router is unreachable', async () => {
    const { handlers } = capture(
      contextWith(async () => {
        throw new AuthError('the router rejected credentials for user "admin"');
      })
    );

    const result = await handlers['get_system_info']!({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('keenetic-mcp init');
  });

  it('registers read tools with readOnlyHint', () => {
    const { configs } = capture(contextWith(async () => ({})));
    expect(configs['get_system_info']?.annotations?.readOnlyHint).toBe(true);
    expect(configs['get_config_state']?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('get_config_state', () => {
  it('surfaces the unsaved flag and fail-safe state', async () => {
    const { handlers } = capture(
      contextWith(async () => ({
        date: 'Thu, 6 Aug 2026 10:46:01 GMT',
        agent: 'http/rci',
        user: 'admin',
        checksum: 'aa4b',
        'fail-safe': { unsaved: true, rollback: false, 'time-left': 0 }
      }))
    );

    const payload = JSON.parse(textOf(await handlers['get_config_state']!({})));
    expect(payload.unsavedChanges).toBe(true);
    expect(payload.lastChangedBy).toBe('admin');
    expect(payload.failSafe.rollbackPending).toBe(false);
  });
});
