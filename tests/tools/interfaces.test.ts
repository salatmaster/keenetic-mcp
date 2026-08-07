import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerInterfaceTools } from '../../src/tools/interfaces.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { stubBackup } from '../helpers/backup.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

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
    wireguard: { 'public-key': '<redacted>' }
  }
};

const ALL: Record<string, Record<string, unknown>> = {
  ...INTERFACES,
  'WifiMaster0/AccessPoint0': {
    id: 'WifiMaster0/AccessPoint0',
    type: 'AccessPoint',
    state: 'up',
    link: 'up'
  }
};

function harness(get: (path: string) => Promise<unknown> = async () => INTERFACES): {
  handlers: Record<string, Handler>;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(get);
  // Rci.post resolves the parsed body and throws RciError when the router
  // reports one, so the stub mirrors both behaviours.
  const postSpy = vi.fn(async (body: unknown) => {
    const name = (body as { show?: { interface?: { name?: string } } })?.show?.interface?.name;
    const record = name === undefined ? undefined : ALL[name];
    if (!record) throw new Error(`unable to find "${String(name)}".`);
    return { show: { interface: { id: name, ...record } } };
  });
  const client = {
    rci: { get: spy, post: postSpy, getText: vi.fn() },
    capabilities: vi.fn()
  } as unknown as KeeneticClient;
  const ctx: ToolContext = { client, maxResponseBytes: 25_000, readOnly: false, backup: stubBackup() };

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers: Record<string, Handler> = {};
  vi.spyOn(server, 'registerTool').mockImplementation(((
    name: string,
    _config: unknown,
    handler: Handler
  ) => {
    handlers[name] = handler;
    return {} as never;
  }) as never);

  registerInterfaceTools(server, ctx);
  return { handlers, get: spy, post: postSpy };
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content.map(p => p.text).join(''));
}

describe('list_interfaces', () => {
  it('returns summary fields only by default', async () => {
    const out = payload(await harness().handlers['list_interfaces']!({}));
    expect(Object.keys(out.interfaces[0]).sort()).toEqual(
      ['address', 'defaultGateway', 'description', 'id', 'link', 'state', 'type'].sort()
    );
  });

  it('returns the raw records when detail is full', async () => {
    const out = payload(await harness().handlers['list_interfaces']!({ detail: 'full' }));
    const wg = out.interfaces.find((i: any) => i.id === 'Wireguard3');
    expect(wg.wireguard).toBeDefined();
  });

  it('filters to VPN interfaces', async () => {
    const out = payload(await harness().handlers['list_interfaces']!({ kind: 'vpn' }));
    expect(out.interfaces.map((i: any) => i.id)).toEqual(['Wireguard3']);
  });

  it('filters to Wi-Fi interfaces', async () => {
    const out = payload(await harness().handlers['list_interfaces']!({ kind: 'wifi' }));
    expect(out.interfaces.map((i: any) => i.id)).toEqual(['WifiMaster0/AccessPoint0']);
  });

  it('filters to bridges', async () => {
    const out = payload(await harness().handlers['list_interfaces']!({ kind: 'bridge' }));
    expect(out.interfaces.map((i: any) => i.id)).toEqual(['Bridge0']);
  });

  it('reports totals', async () => {
    const out = payload(await harness().handlers['list_interfaces']!({}));
    expect(out.total).toBe(4);
  });
});

describe('get_interface', () => {
  it('asks by name through POST rather than building a URL path', async () => {
    const { handlers, post } = harness();
    const out = payload(await handlers['get_interface']!({ name: 'Wireguard3' }));
    expect(post).toHaveBeenCalledWith({ show: { interface: { name: 'Wireguard3' } } });
    expect(out.type).toBe('Wireguard');
  });

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

  it('returns isError with a usable hint when the interface does not exist', async () => {
    const { handlers } = harness();
    const result = await handlers['get_interface']!({ name: 'Nope0' });
    expect(result.isError).toBe(true);
    expect(result.content.map(p => p.text).join('')).toMatch(/list_interfaces/);
  });
});
