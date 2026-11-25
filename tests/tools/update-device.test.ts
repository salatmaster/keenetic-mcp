import { describe, expect, it, vi } from 'vitest';
import { registerDeviceTools } from '../../src/tools/devices.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { STUB_SNAPSHOT } from '../helpers/backup.js';
import { captureTools, payload, testContext, text } from '../helpers/tools.js';

const MAC = '02:00:00:00:00:01';

function harness(hotspotHost: Record<string, unknown>, showHost: Record<string, unknown> = {}) {
  const posts: unknown[] = [];
  const client = {
    rci: {
      get: vi.fn(async (path: string) => {
        if (path === 'ip/hotspot/host') return [{ mac: MAC, ...hotspotHost }];
        if (path === 'show/ip/hotspot') return { host: [{ mac: MAC, ...showHost }] };
        return {};
      }),
      post: vi.fn(async (body: unknown) => {
        posts.push(body);
        return {};
      })
    }
  } as unknown as KeeneticClient;

  const ctx = testContext(client);
  const { handlers } = captureTools(server => registerDeviceTools(server, ctx));
  return { handlers, posts, backup: ctx.backup };
}

describe('update_device', () => {
  it('sends deny to the ip/hotspot branch', async () => {
    const { handlers, posts } = harness({ access: 'deny', deny: true });
    await handlers['update_device']!({ mac: MAC, access: 'deny' });

    expect(posts).toContainEqual({ ip: { hotspot: { host: { mac: MAC, deny: true } } } });
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
    expect(text(result)).toMatch(/name=new-name did not take effect/);
  });

  it('takes a backup before applying anything', async () => {
    const { handlers, backup } = harness({ access: 'permit', permit: true });
    const out = payload(await handlers['update_device']!({ mac: MAC, access: 'permit' }));
    expect(backup.ensure).toHaveBeenCalledOnce();
    expect(out.backup).toBe(STUB_SNAPSHOT.path);
  });

  it('fails when the read-back does not show the requested change', async () => {
    const { handlers } = harness({ access: 'permit', permit: true });
    const result = await handlers['update_device']!({ mac: MAC, access: 'deny' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/did not take effect/i);
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
