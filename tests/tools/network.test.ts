import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerNetworkTools } from '../../src/tools/network.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { stubBackup } from '../helpers/backup.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const DATA: Record<string, unknown> = {
  'show/internet/status': {
    checked: true,
    enabled: true,
    reliable: true,
    'gateway-accessible': true,
    'dns-accessible': true,
    internet: true
  },
  'show/ip/route': [
    {
      destination: '0.0.0.0/0',
      gateway: '203.0.113.1',
      interface: 'GigabitEthernet1',
      metric: 0,
      flags: 'UG'
    },
    { destination: '192.0.2.0/24', gateway: '0.0.0.0', interface: 'Bridge0', metric: 0, flags: 'U' }
  ],
  'ip/policy': {
    Policy0: { description: 'desc-1', permit: [{ enabled: true, interface: 'Wireguard3' }] }
  },
  'show/interface': {
    WifiMaster0: { type: 'WifiMaster', description: '2.4 GHz', band: '2.4', link: 'up' },
    'WifiMaster0/AccessPoint0': { type: 'AccessPoint', ssid: 'ssid-1', link: 'up', state: 'up' },
    WifiMaster1: { type: 'WifiMaster', description: '5 GHz', band: '5', link: 'up' },
    'WifiMaster1/AccessPoint0': { type: 'AccessPoint', ssid: 'ssid-2', link: 'up', state: 'up' }
  },
  'show/associations': {
    station: [{ mac: '02:00:00:00:00:01', ap: 'WifiMaster0/AccessPoint0', rssi: -36, txrate: 65 }]
  }
};

function harness(): Record<string, Handler> {
  const get = vi.fn(async (path: string) => {
    if (!(path in DATA)) throw new Error(`this path does not exist on this firmware: ${path}`);
    return DATA[path];
  });
  const client = {
    rci: { get, post: vi.fn(), getText: vi.fn() },
    capabilities: vi.fn()
  } as unknown as KeeneticClient;

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

  registerNetworkTools(server, { client, maxResponseBytes: 25_000, readOnly: false, backup: stubBackup() });
  return handlers;
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content.map(p => p.text).join(''));
}

describe('get_internet_status', () => {
  it('reports reachability flags', async () => {
    const out = payload(await harness()['get_internet_status']!({}));
    expect(out.internet).toBe(true);
    expect(out.gatewayAccessible).toBe(true);
    expect(out.dnsAccessible).toBe(true);
  });
});

describe('list_routes', () => {
  it('returns every route with totals', async () => {
    const out = payload(await harness()['list_routes']!({}));
    expect(out.routes).toHaveLength(2);
    expect(out.total).toBe(2);
  });

  it('filters to the default route when kind is default', async () => {
    const out = payload(await harness()['list_routes']!({ kind: 'default' }));
    expect(out.routes.map((r: any) => r.destination)).toEqual(['0.0.0.0/0']);
  });
});

describe('list_policies', () => {
  it('returns each policy with its name and description', async () => {
    const out = payload(await harness()['list_policies']!({}));
    expect(out.policies).toEqual([
      { name: 'Policy0', description: 'desc-1', interfaces: ['Wireguard3'] }
    ]);
  });
});

describe('get_wifi_status', () => {
  it('groups access points by band and counts clients', async () => {
    const out = payload(await harness()['get_wifi_status']!({}));
    const twoFour = out.bands.find((b: any) => b.band === '2.4');
    expect(twoFour.accessPoints[0].ssid).toBe('ssid-1');
    expect(twoFour.accessPoints[0].clients).toBe(1);
    const five = out.bands.find((b: any) => b.band === '5');
    expect(five.accessPoints[0].clients).toBe(0);
  });
});
