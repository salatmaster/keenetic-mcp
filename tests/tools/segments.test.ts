import { describe, expect, it, vi } from 'vitest';
import type { KeeneticClient } from '../../src/router/client.js';
import { registerSegmentTools } from '../../src/tools/segments.js';
import { captureTools, payload, testContext, text } from '../helpers/tools.js';
import { parseLines, rciWith } from '../helpers/rci.js';

/** A two-port switch, a home segment, and nothing else configured. */
const SWITCH: Record<string, unknown> = {
  'show/rc/interface/GigabitEthernet0/0': {
    rename: '1',
    switchport: { access: { vid: '1' }, trunk: [{ vid: '2' }] }
  },
  'show/rc/interface/GigabitEthernet0/1': { rename: '2', switchport: { access: { vid: '1' } } },
  'show/rc/interface/Bridge0': { ip: { address: { address: '192.168.1.1' } } }
};

/** What the router reports for the bridge once the VLAN has landed. */
const BUILT = {
  description: 'iot',
  include: [{ interface: 'GigabitEthernet0/Vlan3' }],
  ip: { address: { address: '192.168.2.1' } },
  iseg: { vlan: '3', port: '1,2', 'vlan-port': '1,2' }
};

interface HarnessOptions {
  paths?: Record<string, unknown>;
  /** Start from an empty router rather than from SWITCH. */
  bare?: boolean;
  readOnly?: boolean;
  /** Paths the router stops reporting once this command has been sent. */
  removesOn?: { command: string; paths: string[] };
  /**
   * Paths that only start answering once this command has been sent. Without
   * this the bridge would already exist when the allocator looks, and it would
   * hand out the next number instead.
   */
  appearsOn?: { command: string; paths: Record<string, unknown> };
}

function harness(opts: HarnessOptions = {}) {
  const paths: Record<string, unknown> = { ...(opts.bare ? {} : SWITCH), ...opts.paths };

  const post = vi.fn(async (body: unknown) => {
    const sent = (Array.isArray(body) ? body : [body]) as { parse?: string }[];
    if (opts.removesOn && sent.some(entry => entry.parse === opts.removesOn?.command)) {
      for (const path of opts.removesOn.paths) delete paths[path];
    }
    if (opts.appearsOn && sent.some(entry => entry.parse === opts.appearsOn?.command)) {
      Object.assign(paths, opts.appearsOn.paths);
    }
    return {};
  });

  const client = { rci: rciWith(paths, post) } as unknown as KeeneticClient;

  const ctx = testContext(client, { readOnly: opts.readOnly === true });
  const { handlers } = captureTools(server => registerSegmentTools(server, ctx));
  return { handlers, post };
}

describe('list_segments', () => {
  it('reads in read-only mode and flags a bridge that is not a segment', async () => {
    const { handlers } = harness({
      readOnly: true,
      paths: {
        'show/rc/interface/Bridge1': {
          ip: { address: { address: '192.168.2.1' } },
          iseg: { vlan: '', 'vlan-port': '' }
        }
      }
    });

    const body = payload(await handlers['list_segments']!({}));
    const segments = body['segments'] as Array<Record<string, unknown>>;
    const bridge1 = segments.find(entry => entry['bridge'] === 'Bridge1');

    expect(bridge1?.['address'], 'the network is configured').toBe('192.168.2.1');
    expect(bridge1?.['uiVisible'], 'and the web interface still will not list it').toBe(false);
    expect(body['switchPorts']).toHaveLength(2);
  });
});

describe('create_segment', () => {
  const BECOMES_A_SEGMENT = {
    command: 'interface Bridge1 up',
    paths: { 'show/rc/interface/Bridge1': BUILT }
  };

  it('trunks the VLAN over every port, behind a backup', async () => {
    const { handlers, post } = harness({ appearsOn: BECOMES_A_SEGMENT });

    const body = payload(await handlers['create_segment']!({ name: 'iot' }));

    expect(body['uiVisible']).toBe(true);
    expect(body['backup']).toBe('/tmp/keenetic-test-backup.txt');

    const lines = parseLines(post);
    expect(lines).toContain('interface GigabitEthernet0/0 switchport trunk vlan 3');
    expect(lines).toContain('interface GigabitEthernet0/1 switchport trunk vlan 3');
    expect(lines).toContain('interface Bridge1 include GigabitEthernet0/Vlan3');
    expect(lines).toContain('interface Bridge1 security-level protected');
  });

  it('sends the DHCP pool as JSON, because parse rejects it', async () => {
    const { handlers, post } = harness({ appearsOn: BECOMES_A_SEGMENT });
    await handlers['create_segment']!({ name: 'iot' });

    const sent = post.mock.calls
      .map(([body]) => body as { ip?: { dhcp?: { pool?: Record<string, unknown> } } })
      .find(body => body?.ip?.dhcp?.pool !== undefined);

    expect(sent?.ip?.dhcp?.pool?.['_WEBADMIN_BRIDGE1']).toMatchObject({
      bind: { interface: 'Bridge1' },
      enable: true
    });
  });

  it('refuses an ssid without a psk instead of building half a network', async () => {
    const { handlers, post } = harness();
    const result = await handlers['create_segment']!({ name: 'iot', ssid: 'somewhere' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/ssid and psk go together/i);
    expect(post).not.toHaveBeenCalled();
  });

  /** No switch means no VLAN to trunk, which means no segment the UI will list. */
  it('refuses a router that reports no switch ports, rather than building the invisible kind', async () => {
    const { handlers, post } = harness({ bare: true });

    const result = await handlers['create_segment']!({ name: 'iot' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no switch ports/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a subnet that is already routed', async () => {
    const { handlers, post } = harness();
    const result = await handlers['create_segment']!({ name: 'iot', subnet: 1 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/192\.168\.1\.0\/24 is already in use/);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('delete_segment', () => {
  it('refuses the home segment', async () => {
    const { handlers, post } = harness();
    const result = await handlers['delete_segment']!({ bridge: 'Bridge0' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/home segment/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a bridge that is not there', async () => {
    const { handlers } = harness();
    const result = await handlers['delete_segment']!({ bridge: 'Bridge9' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no Bridge9/);
  });

  it('removes what is bound to the bridge, matched by binding rather than by name', async () => {
    const { handlers, post } = harness({
      removesOn: { command: 'no interface Bridge1', paths: ['show/rc/interface/Bridge1'] },
      paths: {
        'show/rc/interface/Bridge1': BUILT,
        'show/rc/mws/wlan': {
          DEFAULT__: { bind: { interface: 'Bridge0' } },
          wlan4: { bind: { interface: 'Bridge1' } }
        },
        'show/rc/ip/dhcp': { pool: { madeInTheWebUi: { bind: { interface: 'Bridge1' } } } }
      }
    });

    const body = payload(await handlers['delete_segment']!({ bridge: 'Bridge1' }));

    expect((body['applied'] as Record<string, unknown>)['removed']).toBe('Bridge1');

    const lines = parseLines(post);
    expect(lines, 'the Wi-Fi bound to it, whatever its key').toContain('no mws wlan wlan4');
    expect(lines, 'the pool bound to it, whatever its name').toContain(
      'no ip dhcp pool madeInTheWebUi'
    );
    expect(lines, 'and the VLAN off every port').toContain(
      'interface GigabitEthernet0/0 no switchport trunk vlan 3'
    );
  });

  it('reports a failure when the bridge is still there afterwards', async () => {
    const { handlers } = harness({ paths: { 'show/rc/interface/Bridge1': BUILT } });
    const result = await handlers['delete_segment']!({ bridge: 'Bridge1' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/still exists/);
  });
});
