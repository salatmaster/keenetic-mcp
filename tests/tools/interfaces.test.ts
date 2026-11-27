import { describe, expect, it, vi } from 'vitest';
import { registerInterfaceTools } from '../../src/tools/interfaces.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { captureTools, payload, testContext, text } from '../helpers/tools.js';

const INTERFACES = {
  GigabitEthernet1: {
    type: 'GigabitEthernet',
    description: 'desc-1',
    link: 'up',
    state: 'up',
    address: '203.0.113.9',
    defaultgw: false,
    role: 'inet'
  },
  Bridge0: {
    type: 'Bridge',
    description: 'Home',
    link: 'up',
    state: 'up',
    address: '192.0.2.1',
    defaultgw: false
  },
  'WifiMaster0/AccessPoint0': {
    type: 'AccessPoint',
    description: 'ssid-1',
    link: 'up',
    state: 'up',
    address: '',
    defaultgw: false
  },
  Wireguard3: {
    type: 'Wireguard',
    description: 'desc-2',
    link: 'up',
    state: 'up',
    address: '198.51.100.8',
    defaultgw: true,
    wireguard: { 'public-key': '<redacted>', peer: [{ 'remote-endpoint-address': '203.0.113.20' }] }
  }
};

function harness() {
  // Rci.post resolves the parsed body and throws RciError when the router
  // reports one, so the stub mirrors both behaviours.
  const postSpy = vi.fn(async (body: unknown) => {
    const name = (body as { show?: { interface?: { name?: string } } })?.show?.interface?.name;
    const record = name === undefined ? undefined : (INTERFACES as Record<string, Record<string, unknown>>)[name];
    if (!record) throw new Error(`unable to find "${String(name)}".`);
    return { show: { interface: { id: name, ...record } } };
  });
  const client = {
    rci: { get: async () => INTERFACES, post: postSpy }
  } as unknown as KeeneticClient;
  const ctx = testContext(client);
  const { handlers } = captureTools(server => registerInterfaceTools(server, ctx));
  return { handlers, post: postSpy };
}

describe('list_interfaces', () => {
  it('returns summary fields only by default', async () => {
    const out = payload(await harness().handlers['list_interfaces']!({}));
    expect(Object.keys(out.interfaces[0]).sort()).toEqual(
      ['address', 'addressScope', 'defaultGateway', 'description', 'id', 'link', 'state', 'type'].sort()
    );
    expect(out.total).toBe(4);
  });

  it('returns the raw records when detail is full', async () => {
    const out = payload(await harness().handlers['list_interfaces']!({ detail: 'full' }));
    const wg = out.interfaces.find((i: any) => i.id === 'Wireguard3');
    expect(wg.wireguard).toBeDefined();
  });

  it.each([
    ['vpn', ['Wireguard3']],
    ['wifi', ['WifiMaster0/AccessPoint0']],
    ['bridge', ['Bridge0']]
  ])('filters to the %s kind', async (kind, ids) => {
    const out = payload(await harness().handlers['list_interfaces']!({ kind }));
    expect(out.interfaces.map((i: any) => i.id)).toEqual(ids);
  });
});

describe('get_interface', () => {
  // Regression: GET show/interface/WifiMaster0/AccessPoint6 is a 404 on a real
  // router because the slash is read as another path segment, and every Wi-Fi
  // access point has a slash in its name.
  it('handles an interface whose name contains a slash', async () => {
    const { handlers, post } = harness();
    const out = payload(await handlers['get_interface']!({ name: 'WifiMaster0/AccessPoint0' }));
    expect(post).toHaveBeenCalledWith({
      show: { interface: { name: 'WifiMaster0/AccessPoint0' } }
    });
    expect(out.id).toBe('WifiMaster0/AccessPoint0');
  });

  it('adds the address scope and the likely exit to the raw record', async () => {
    const out = payload(await harness().handlers['get_interface']!({ name: 'Wireguard3' }));
    expect(out).toMatchObject({ addressScope: 'public', likelyExit: '203.0.113.20' });
    expect(out.wireguard.peer).toHaveLength(1);
  });

  it('returns isError with a usable hint when the interface does not exist', async () => {
    const { handlers } = harness();
    const result = await handlers['get_interface']!({ name: 'Nope0' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/list_interfaces/);
  });
});
