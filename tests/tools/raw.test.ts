import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerRawTool } from '../../src/tools/raw.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { stubBackup } from '../helpers/backup.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function harness(readOnly = false, payload: unknown = { title: '5.1.3' }) {
  const get = vi.fn(async () => payload);
  const post = vi.fn(async () => payload);
  const client = {
    rci: { get, post, getText: vi.fn() },
    capabilities: vi.fn()
  } as unknown as KeeneticClient;
  const ctx: ToolContext = { client, host: '192.0.2.1', maxResponseBytes: 2_000, readOnly, backup: stubBackup() };

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers: Record<string, Handler> = {};
  vi.spyOn(server, 'registerTool').mockImplementation(((
    n: string,
    _c: unknown,
    h: Handler
  ) => {
    handlers[n] = h;
    return {} as never;
  }) as never);

  registerRawTool(server, ctx);
  return { handlers, get, post };
}

function text(result: ToolResult): string {
  return result.content.map(p => p.text).join('');
}

describe('rci_call', () => {
  it('performs a GET against any path, with no blocklist', async () => {
    const { handlers, get } = harness();
    const result = await handlers['rci_call']!({ method: 'GET', path: 'show/version' });
    expect(get).toHaveBeenCalledWith('show/version');
    expect(JSON.parse(text(result))).toMatchObject({ title: '5.1.3' });
  });

  it('reaches a path no curated tool covers', async () => {
    const { handlers, get } = harness();
    await handlers['rci_call']!({ method: 'GET', path: 'show/processes' });
    expect(get).toHaveBeenCalledWith('show/processes');
  });

  it('performs a POST with the given body', async () => {
    const { handlers, post } = harness();
    await handlers['rci_call']!({ method: 'POST', body: { show: { version: {} } } });
    expect(post).toHaveBeenCalledWith({ show: { version: {} } });
  });

  it('posts an array body unchanged, for a batch', async () => {
    const { handlers, post } = harness();
    await handlers['rci_call']!({ method: 'POST', body: [{ parse: 'show version' }] });
    expect(post).toHaveBeenCalledWith([{ parse: 'show version' }]);
  });

  // A client with no `type` to go on may serialise the body to a string. Sent
  // on as-is it reached the router double-encoded, matched no command and came
  // back as `{}` - indistinguishable from success.
  it('decodes a body that arrived as a JSON string', async () => {
    const { handlers, post } = harness();
    await handlers['rci_call']!({ method: 'POST', body: '{"show":{"version":{}}}' });
    expect(post).toHaveBeenCalledWith({ show: { version: {} } });
  });

  it('decodes a stringified array body', async () => {
    const { handlers, post } = harness();
    await handlers['rci_call']!({ method: 'POST', body: '[{"parse":"show version"}]' });
    expect(post).toHaveBeenCalledWith([{ parse: 'show version' }]);
  });

  it('refuses a string body that is not JSON, instead of sending it', async () => {
    const { handlers, post } = harness();
    const result = await handlers['rci_call']!({ method: 'POST', body: 'show version' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not JSON/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a body that decodes to a scalar', async () => {
    const { handlers, post } = harness();
    const result = await handlers['rci_call']!({ method: 'POST', body: '42' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not a command tree/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses POST in read-only mode', async () => {
    const { handlers, post } = harness(true);
    const result = await handlers['rci_call']!({ method: 'POST', body: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/read-only/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('still allows GET in read-only mode', async () => {
    const { handlers, get } = harness(true);
    const result = await handlers['rci_call']!({ method: 'GET', path: 'show/version' });
    expect(result.isError).toBeUndefined();
    expect(get).toHaveBeenCalled();
  });

  it('requires a path for GET and a body for POST', async () => {
    const { handlers } = harness();
    expect((await handlers['rci_call']!({ method: 'GET' })).isError).toBe(true);
    expect((await handlers['rci_call']!({ method: 'POST' })).isError).toBe(true);
  });

  it('truncates an oversized response and says so', async () => {
    const big = { rows: Array.from({ length: 400 }, (_, i) => ({ i, pad: 'x'.repeat(50) })) };
    const { handlers } = harness(false, big);
    const result = await handlers['rci_call']!({ method: 'GET', path: 'show/ip/nat' });
    expect(text(result).length).toBeLessThan(4_000);
    expect(text(result)).toMatch(/truncated/i);
  });

  it('lets max_bytes lower the ceiling but never raise it', async () => {
    const big = { rows: Array.from({ length: 400 }, (_, i) => ({ i, pad: 'x'.repeat(50) })) };
    const { handlers } = harness(false, big);
    const tight = text(await handlers['rci_call']!({ method: 'GET', path: 'p', max_bytes: 200 }));
    const wide = text(await handlers['rci_call']!({ method: 'GET', path: 'p', max_bytes: 999_999 }));
    expect(tight.length).toBeLessThan(wide.length);
    expect(wide.length).toBeLessThan(4_000);
  });
});
