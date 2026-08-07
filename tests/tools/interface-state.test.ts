import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerInterfaceTools } from '../../src/tools/interfaces.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { stubBackup } from '../helpers/backup.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const NAME = 'WifiMaster0/AccessPoint6';

/**
 * `obeys` false models the router accepting a command and not acting on it,
 * which is what a wrong branch looks like from the caller's side.
 */
function harness(initial: 'up' | 'down', obeys = true, readOnly = false) {
  const writes: unknown[] = [];
  let state = initial;

  const post = vi.fn(async (body: unknown) => {
    const asShow = body as { show?: { interface?: { name?: string } } };
    if (asShow.show?.interface?.name !== undefined) {
      return { show: { interface: { id: asShow.show.interface.name, state, link: state } } };
    }
    writes.push(body);
    if (obeys) {
      const iface = (body as { interface: Record<string, { up: unknown }> }).interface;
      const spec = Object.values(iface)[0];
      state = spec?.up === true ? 'up' : 'down';
    }
    return {};
  });

  const client = {
    rci: { get: vi.fn(async () => ({})), post, getText: vi.fn() },
    capabilities: vi.fn()
  } as unknown as KeeneticClient;

  const ctx: ToolContext = {
    client,
    maxResponseBytes: 25_000,
    readOnly,
    backup: stubBackup()
  };
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers: Record<string, Handler> = {};
  vi.spyOn(server, 'registerTool').mockImplementation(((
    name: string,
    _c: unknown,
    handler: Handler
  ) => {
    handlers[name] = handler;
    return {} as never;
  }) as never);

  registerInterfaceTools(server, ctx);
  return { handlers, writes };
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content.map(p => p.text).join(''));
}

describe('set_interface_state', () => {
  it('brings an interface up', async () => {
    const { handlers, writes } = harness('down');
    const result = await handlers['set_interface_state']!({ name: NAME, state: 'up' });
    expect(result.isError).toBeUndefined();
    expect(writes).toContainEqual({ interface: { [NAME]: { up: true } } });
  });

  it('brings an interface down with the negated up command', async () => {
    const { handlers, writes } = harness('up');
    const result = await handlers['set_interface_state']!({ name: NAME, state: 'down' });
    expect(result.isError).toBeUndefined();
    expect(writes).toContainEqual({ interface: { [NAME]: { up: { no: true } } } });
  });

  it('reports the change as unsaved and names the backup', async () => {
    const { handlers } = harness('down');
    const out = payload(await handlers['set_interface_state']!({ name: NAME, state: 'up' }));
    expect(out.saved).toBe(false);
    expect(out.unsavedChanges).toBe(true);
    expect(out.backup).toBeTruthy();
    expect(out.applied).toEqual({ interface: NAME, state: 'up' });
  });

  it('fails when the interface did not actually change state', async () => {
    const { handlers } = harness('up', false);
    const result = await handlers['set_interface_state']!({ name: NAME, state: 'down' });
    expect(result.isError).toBe(true);
    expect(result.content.map(p => p.text).join('')).toMatch(/did not take effect/i);
  });

  it('is not registered at all in read-only mode', () => {
    const { handlers } = harness('up', true, true);
    expect(handlers['set_interface_state']).toBeUndefined();
    expect(handlers['get_interface']).toBeDefined();
  });
});
