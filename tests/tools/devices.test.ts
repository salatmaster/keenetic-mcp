import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerDeviceTools } from '../../src/tools/devices.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { stubBackup } from '../helpers/backup.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const HOSTS = {
  host: [
    {
      mac: '02:00:00:00:00:01',
      ip: '192.0.2.5',
      name: 'device-1',
      active: true,
      ssid: 'ssid-1',
      rssi: -36,
      rxbytes: 900,
      txbytes: 100,
      access: 'permit',
      interface: { name: 'Home' }
    },
    {
      mac: '02:00:00:00:00:02',
      ip: '192.0.2.6',
      name: 'device-2',
      active: true,
      rxbytes: 50,
      txbytes: 10,
      access: 'deny',
      interface: { name: 'Home' }
    },
    {
      mac: '02:00:00:00:00:03',
      ip: '192.0.2.7',
      name: 'device-3',
      active: false,
      rxbytes: 5,
      txbytes: 1,
      access: 'permit',
      interface: { name: 'Home' }
    }
  ]
};

function harness(payload: unknown = HOSTS): Record<string, Handler> {
  const client = {
    rci: { get: vi.fn(async () => payload), post: vi.fn(), getText: vi.fn() },
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

  registerDeviceTools(server, ctx);
  return handlers;
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content.map(p => p.text).join(''));
}

describe('list_devices', () => {
  it('projects each host down to the summary fields', async () => {
    const out = payload(await harness()['list_devices']!({}));
    expect(out.devices).toHaveLength(3);
    expect(Object.keys(out.devices[0]).sort()).toEqual(
      ['active', 'blocked', 'connection', 'ip', 'mac', 'name', 'rssi', 'rxBytes', 'txBytes'].sort()
    );
  });

  it('filters to active devices', async () => {
    const out = payload(await harness()['list_devices']!({ filter: 'active' }));
    expect(out.devices.map((d: any) => d.name)).toEqual(['device-1', 'device-2']);
  });

  it('filters to wireless devices', async () => {
    const out = payload(await harness()['list_devices']!({ filter: 'wireless' }));
    expect(out.devices.map((d: any) => d.name)).toEqual(['device-1']);
  });

  it('filters to blocked devices', async () => {
    const out = payload(await harness()['list_devices']!({ filter: 'blocked' }));
    expect(out.devices.map((d: any) => d.name)).toEqual(['device-2']);
  });

  it('sorts by total traffic descending', async () => {
    const out = payload(await harness()['list_devices']!({ sort: 'traffic' }));
    expect(out.devices.map((d: any) => d.name)).toEqual(['device-1', 'device-2', 'device-3']);
  });

  it('reports totals and truncation when the limit bites', async () => {
    const out = payload(await harness()['list_devices']!({ limit: 1 }));
    expect(out.shown).toBe(1);
    expect(out.total).toBe(3);
    expect(out.note).toContain('3');
  });

  it('handles a router with no hosts', async () => {
    const out = payload(await harness({})['list_devices']!({}));
    expect(out.devices).toEqual([]);
    expect(out.total).toBe(0);
  });
});

describe('get_device', () => {
  it('finds a device by MAC, case-insensitively, and returns the full record', async () => {
    const out = payload(await harness()['get_device']!({ mac: '02:00:00:00:00:01' }));
    expect(out.ssid).toBe('ssid-1');
    expect(out.rssi).toBe(-36);
  });

  it('finds a device by IP', async () => {
    const out = payload(await harness()['get_device']!({ ip: '192.0.2.6' }));
    expect(out.mac).toBe('02:00:00:00:00:02');
  });

  it('finds a device by name', async () => {
    const out = payload(await harness()['get_device']!({ name: 'device-3' }));
    expect(out.mac).toBe('02:00:00:00:00:03');
  });

  it('returns isError listing known devices when nothing matches', async () => {
    const result = await harness()['get_device']!({ mac: '02:00:00:00:00:99' });
    expect(result.isError).toBe(true);
    expect(result.content.map(p => p.text).join('')).toContain('device-1');
  });

  it('returns isError when no identifier is supplied', async () => {
    const result = await harness()['get_device']!({});
    expect(result.isError).toBe(true);
  });
});
