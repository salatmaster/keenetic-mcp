import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNetworkTools } from '../../src/tools/network.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { captureTools, payload, testContext } from '../helpers/tools.js';

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

type HarnessOptions = {
  get?: (path: string) => Promise<unknown>;
  post?: (body: unknown) => Promise<unknown>;
};

/** GET answers from DATA unless `get` is given; POST answers `{}` unless `post` is given. */
function harness(options: HarnessOptions = {}) {
  const get = vi.fn(async (path: string): Promise<unknown> => {
    if (options.get) return options.get(path);
    if (!(path in DATA)) throw new Error(`this path does not exist on this firmware: ${path}`);
    return DATA[path];
  });
  const post = vi.fn(async (body: unknown): Promise<unknown> => {
    if (options.post) return options.post(body);
    return {};
  });
  const client = {
    rci: { get, post }
  } as unknown as KeeneticClient;

  const ctx = testContext(client);
  const { handlers } = captureTools(server => registerNetworkTools(server, ctx));
  return { handlers, get, post };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('get_internet_status', () => {
  it('reports reachability flags', async () => {
    const out = payload(await harness().handlers['get_internet_status']!({}));
    expect(out.internet).toBe(true);
    expect(out.gatewayAccessible).toBe(true);
    expect(out.dnsAccessible).toBe(true);
  });
});

describe('list_routes', () => {
  it('returns every route with totals', async () => {
    const out = payload(await harness().handlers['list_routes']!({}));
    expect(out.routes).toHaveLength(2);
    expect(out.total).toBe(2);
  });

  it('filters to the default route when kind is default', async () => {
    const out = payload(await harness().handlers['list_routes']!({ kind: 'default' }));
    expect(out.routes.map((r: any) => r.destination)).toEqual(['0.0.0.0/0']);
  });
});

describe('list_policies', () => {
  it('returns each policy with its name and description', async () => {
    const out = payload(await harness().handlers['list_policies']!({}));
    expect(out.policies).toEqual([
      { name: 'Policy0', description: 'desc-1', interfaces: ['Wireguard3'] }
    ]);
  });
});

describe('get_wifi_status', () => {
  it('groups access points by band and counts clients', async () => {
    const out = payload(await harness().handlers['get_wifi_status']!({}));
    const twoFour = out.bands.find((b: any) => b.band === '2.4');
    expect(twoFour.accessPoints[0].ssid).toBe('ssid-1');
    expect(twoFour.accessPoints[0].clients).toBe(1);
    const five = out.bands.find((b: any) => b.band === '5');
    expect(five.accessPoints[0].clients).toBe(0);
  });
});

describe('ping', () => {
  it('uses count=5 by default and polls until continued is false', async () => {
    const h = harness({
      post: async () => ({ message: ['PING started'], continued: true }),
      get: async path => {
        expect(path).toBe('tools/ping');
        return { message: ['5 packets transmitted'], continued: false };
      }
    });

    const pending = h.handlers['ping']!({ host: '1.1.1.1' });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    const out = payload(result);

    expect(h.post).toHaveBeenCalledWith({
      tools: { ping: { host: '1.1.1.1', count: 5 } }
    });
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(out.lines).toEqual(['PING started', '5 packets transmitted']);
  });

  it('continues polling when message is empty and continued is true', async () => {
    let getNumber = 0;

    const h = harness({
      post: async () => ({ message: ['PING started'], continued: true }),
      get: async () => {
        getNumber++;
        if (getNumber === 1) return { message: [], continued: true };
        return { message: ['PING finished'], continued: false };
      }
    });

    const pending = h.handlers['ping']!({ host: '1.1.1.1' });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;
    const out = payload(result);

    expect(h.get).toHaveBeenCalledTimes(2);
    expect(out.lines).toEqual(['PING started', 'PING finished']);
  });

  it('passes count and source_interface to RCI', async () => {
    const h = harness({
      post: async () => ({ message: ['done'], continued: false })
    });

    await h.handlers['ping']!({
      host: '1.1.1.1',
      count: 3,
      source_interface: 'Wireguard0'
    });

    expect(h.post).toHaveBeenCalledWith({
      tools: {
        ping: {
          host: '1.1.1.1',
          count: 3,
          'source-interface': 'Wireguard0'
        }
      }
    });
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe('traceroute', () => {
  it('passes source_address and source_interface together', async () => {
    const h = harness({
      post: async () => ({ message: ['trace complete'], continued: false })
    });

    await h.handlers['traceroute']!({
      host: '185.178.210.201',
      source_interface: 'Wireguard0',
      source_address: '192.0.2.10'
    });

    expect(h.post).toHaveBeenCalledWith({
      tools: {
        traceroute: {
          host: '185.178.210.201',
          type: 'icmp',
          'max-ttl': 30,
          'source-interface': 'Wireguard0',
          'source-address': '192.0.2.10'
        }
      }
    });
  });

  it('passes custom max_hops to RCI', async () => {
    const h = harness({
      post: async () => ({ message: ['trace complete'], continued: false })
    });

    await h.handlers['traceroute']!({
      host: '1.1.1.1',
      max_hops: 5
    });

    expect(h.post).toHaveBeenCalledWith({
      tools: {
        traceroute: {
          host: '1.1.1.1',
          type: 'icmp',
          'max-ttl': 5
        }
      }
    });
  });

  it('uses hop-based polling limits', async () => {
    const h = harness({
      post: async () => ({ message: ['trace started'], continued: true }),
      get: async () => ({ message: [], continued: true })
    });

    const pending = h.handlers['traceroute']!({
      host: '1.1.1.1',
      max_hops: 5
    });

    await vi.advanceTimersByTimeAsync(15_000);

    const result = await pending;
    const out = payload(result);

    expect(h.get).toHaveBeenCalledTimes(15);
    expect(out.lines).toContain(
      '[Polling stopped: the 15-second time limit was reached; partial output is shown above.]'
    );
  });

  it('stops after 60 seconds however many hops were asked for', async () => {
    const h = harness({
      post: async () => ({ message: ['trace started'], continued: true }),
      get: async () => ({ message: [], continued: true })
    });

    const pending = h.handlers['traceroute']!({ host: '1.1.1.1', max_hops: 64 });
    await vi.advanceTimersByTimeAsync(61_000);
    const out = payload(await pending);

    expect(h.get.mock.calls.length).toBeLessThanOrEqual(60);
    expect(out.lines).toContain(
      '[Polling stopped: the 60-second time limit was reached; partial output is shown above.]'
    );
  });
});

describe('diagnostic polling errors', () => {
  it('does not treat a GET 404 as successful completion', async () => {
    const notFound = Object.assign(
      new Error('this path does not exist on this firmware'),
      { code: '404' }
    );

    const h = harness({
      post: async () => ({ message: ['partial output'], continued: true }),
      get: async () => {
        throw notFound;
      }
    });

    const pending = h.handlers['ping']!({ host: '1.1.1.1' });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(h.get).toHaveBeenCalledTimes(1);
  });
});
