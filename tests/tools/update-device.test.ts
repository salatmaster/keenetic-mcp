import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerDeviceTools } from '../../src/tools/devices.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import type { KeeneticClient } from '../../src/router/client.js';
import type { BackupGuard, BackupResult } from '../../src/router/backup.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const MAC = '02:00:00:00:00:01';

const SNAPSHOT: BackupResult = {
  path: '/tmp/backup.txt',
  bytes: 10,
  createdAt: '2026-08-07T00:00:00.000Z'
};

function harness(hotspotHost: Record<string, unknown>, showHost: Record<string, unknown> = {}) {
  const posts: unknown[] = [];
  const client = {
    rci: {
      get: vi.fn(async (path: string) => {
        if (path === 'ip/hotspot/host') return [{ mac: MAC, ...hotspotHost }];
        // The real router returns only {mac} here and never echoes the name,
        // which is why renames are verified through show/ip/hotspot instead.
        if (path === 'known/host') return [{ mac: MAC }];
        if (path === 'show/ip/hotspot') return { host: [{ mac: MAC, ...showHost }] };
        return {};
      }),
      post: vi.fn(async (body: unknown) => {
        posts.push(body);
        return {};
      }),
      getText: vi.fn()
    },
    capabilities: vi.fn()
  } as unknown as KeeneticClient;

  const backup: BackupGuard = {
    ensure: vi.fn(async () => SNAPSHOT),
    taken: () => null
  };

  const ctx: ToolContext = { client, maxResponseBytes: 25_000, readOnly: false, backup };
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
  return { handlers, posts, backup };
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content.map(p => p.text).join(''));
}

describe('update_device', () => {
  it('sends deny to the ip/hotspot branch and reports it unsaved', async () => {
    const { handlers, posts } = harness({ access: 'deny', deny: true });
    const out = payload(await handlers['update_device']!({ mac: MAC, access: 'deny' }));

    expect(posts).toContainEqual({ ip: { hotspot: { host: { mac: MAC, deny: true } } } });
    expect(out.saved).toBe(false);
    expect(out.unsavedChanges).toBe(true);
    expect(out.note).toMatch(/save_config/);
  });

  it('sends name to the known branch, not to ip/hotspot', async () => {
    const { handlers, posts } = harness({}, { name: 'new-name' });
    const result = await handlers['update_device']!({ mac: MAC, name: 'new-name' });
    expect(result.isError).toBeUndefined();
    expect(posts).toContainEqual({ known: { host: { mac: MAC, name: 'new-name' } } });
  });

  it('verifies a rename through the operational view, since known/host omits the name', async () => {
    // showHost left empty: the rename did not take effect operationally.
    const { handlers } = harness({}, {});
    const result = await handlers['update_device']!({ mac: MAC, name: 'new-name' });
    expect(result.isError).toBe(true);
    expect(result.content.map(p => p.text).join('')).toMatch(/name=new-name did not take effect/);
  });

  it('takes a backup before applying anything', async () => {
    const { handlers, backup } = harness({ access: 'permit', permit: true });
    const out = payload(await handlers['update_device']!({ mac: MAC, access: 'permit' }));
    expect(backup.ensure).toHaveBeenCalledOnce();
    expect(out.backup).toBe('/tmp/backup.txt');
  });

  it('fails when the read-back does not show the requested change', async () => {
    const { handlers } = harness({ access: 'permit', permit: true });
    const result = await handlers['update_device']!({ mac: MAC, access: 'deny' });
    expect(result.isError).toBe(true);
    expect(result.content.map(p => p.text).join('')).toMatch(/did not take effect/i);
  });

  it('applies name before access so the host is registered first', async () => {
    const { handlers, posts } = harness({ access: 'deny', deny: true }, { name: 'n' });
    await handlers['update_device']!({ mac: MAC, name: 'n', access: 'deny' });
    const knownIndex = posts.findIndex(p => JSON.stringify(p).includes('known'));
    const hotspotIndex = posts.findIndex(p => JSON.stringify(p).includes('hotspot'));
    expect(knownIndex).toBeGreaterThanOrEqual(0);
    expect(knownIndex).toBeLessThan(hotspotIndex);
  });

  it('sends policy, schedule and priority to the ip/hotspot branch', async () => {
    const { handlers, posts } = harness({
      access: 'permit',
      permit: true,
      policy: 'Policy0',
      schedule: 'schedule0',
      priority: 5
    });
    await handlers['update_device']!({
      mac: MAC,
      policy: 'Policy0',
      schedule: 'schedule0',
      priority: 5
    });
    expect(posts).toContainEqual({ ip: { hotspot: { host: { mac: MAC, policy: 'Policy0' } } } });
    expect(posts).toContainEqual({ ip: { hotspot: { host: { mac: MAC, schedule: 'schedule0' } } } });
    expect(posts).toContainEqual({ ip: { hotspot: { host: { mac: MAC, priority: 5 } } } });
  });

  it('matches the host case-insensitively on read-back', async () => {
    const { handlers } = harness({ access: 'deny', deny: true });
    const result = await handlers['update_device']!({ mac: MAC.toUpperCase(), access: 'deny' });
    expect(result.isError).toBeUndefined();
  });

  it('rejects a call that asks for no change at all', async () => {
    const { handlers } = harness({});
    const result = await handlers['update_device']!({ mac: MAC });
    expect(result.isError).toBe(true);
  });
});
