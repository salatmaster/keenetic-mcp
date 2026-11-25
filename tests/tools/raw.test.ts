import { describe, expect, it, vi } from 'vitest';
import { registerRawTool } from '../../src/tools/raw.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { captureTools, testContext, text, payload } from '../helpers/tools.js';

function harness(readOnly = false, answer: unknown = { title: '5.1.3' }) {
  const get = vi.fn(async () => answer);
  const post = vi.fn(async () => answer);
  const client = {
    rci: { get, post }
  } as unknown as KeeneticClient;
  const ctx = testContext(client, { maxResponseBytes: 2_000, readOnly });
  const { handlers } = captureTools(server => registerRawTool(server, ctx));
  return { handlers, get, post };
}

describe('rci_call', () => {
  it('performs a GET against any path, with no blocklist', async () => {
    const { handlers, get } = harness();
    const result = await handlers['rci_call']!({ method: 'GET', path: 'show/version' });
    expect(get).toHaveBeenCalledWith('show/version');
    expect(payload(result)).toMatchObject({ title: '5.1.3' });
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
