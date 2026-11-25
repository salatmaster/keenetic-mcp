import { describe, expect, it, vi } from 'vitest';
import { registerInterfaceTools } from '../../src/tools/interfaces.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { captureTools, payload, testContext, text } from '../helpers/tools.js';

const NAME = 'WifiMaster0/AccessPoint6';

/**
 * `obeys` false models the router accepting a command and not acting on it,
 * which is what a wrong branch looks like from the caller's side.
 */
function harness(initial: 'up' | 'down', obeys = true) {
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
    rci: { post }
  } as unknown as KeeneticClient;

  const ctx = testContext(client);
  const { handlers } = captureTools(server => registerInterfaceTools(server, ctx));
  return { handlers, writes };
}

describe('set_interface_state', () => {
  it('brings an interface up', async () => {
    const { handlers, writes } = harness('down');
    const result = await handlers['set_interface_state']!({ name: NAME, state: 'up' });
    expect(result.isError).toBeUndefined();
    expect(writes).toContainEqual({ interface: { [NAME]: { up: true } } });
    expect(payload(result).applied).toEqual({ interface: NAME, state: 'up' });
    expect(payload(result).backup).toBeTruthy();
  });

  it('brings an interface down with the negated up command', async () => {
    const { handlers, writes } = harness('up');
    const result = await handlers['set_interface_state']!({ name: NAME, state: 'down' });
    expect(result.isError).toBeUndefined();
    expect(writes).toContainEqual({ interface: { [NAME]: { up: { no: true } } } });
  });

  it('fails when the interface did not actually change state', async () => {
    const { handlers } = harness('up', false);
    const result = await handlers['set_interface_state']!({ name: NAME, state: 'down' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/did not take effect/i);
  });
});
