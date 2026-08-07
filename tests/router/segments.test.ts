import { describe, expect, it, vi } from 'vitest';
import { AuthError, RciError } from '../../src/router/errors.js';
import type { Rci } from '../../src/router/rci.js';
import {
  allocate,
  createSegment,
  readDependants,
  readInventory,
  readSegment,
  readSwitchPorts,
  teardownSegment,
  type SwitchPort
} from '../../src/router/segments.js';

const notFound = (path: string): never => {
  throw new RciError('this path does not exist on this firmware', {
    path,
    code: '404',
    ident: 'http'
  });
};

/** A five-port switch with VLAN 1 as the access network and VLAN 2 already trunked. */
const PORTS: Record<string, unknown> = {
  'show/rc/interface/GigabitEthernet0/0': {
    rename: '1',
    switchport: { access: { vid: '1' }, trunk: [{ vid: '2' }] }
  },
  'show/rc/interface/GigabitEthernet0/1': {
    rename: '2',
    // A single trunk arrives as a bare object rather than a list.
    switchport: { access: { vid: '1' }, trunk: { vid: '2' } }
  },
  'show/rc/interface/GigabitEthernet0/2': { rename: '3', switchport: { access: { vid: '1' } } },
  // Not a switch port: shares the prefix, has no switchport block.
  'show/rc/interface/GigabitEthernet0/3': { rename: '4' }
};

type PostFn = (body: unknown) => Promise<unknown>;

function rciWith(paths: Record<string, unknown>, post: PostFn = async () => ({})): Rci {
  return {
    get: vi.fn(async (path: string) => {
      if (path in paths) return paths[path];
      return notFound(path);
    }),
    post,
    getText: vi.fn(async () => '')
  } as unknown as Rci;
}

describe('readSwitchPorts', () => {
  it('reads every port, both list and bare-object trunks, and stops at the first gap', async () => {
    const ports = await readSwitchPorts(rciWith(PORTS));

    expect(ports.map(p => p.name)).toEqual([
      'GigabitEthernet0/0',
      'GigabitEthernet0/1',
      'GigabitEthernet0/2'
    ]);
    expect(ports[0]?.trunkVids).toEqual([2]);
    expect(ports[1]?.trunkVids, 'a single trunk is not wrapped in a list').toEqual([2]);
    expect(ports[2]?.trunkVids).toEqual([]);
    expect(ports.map(p => p.label)).toEqual(['1', '2', '3']);
  });

  /**
   * The reason readOptional only swallows 404. Treating every failure as "not
   * configured" would report an empty switch on an expired session, and the
   * allocator would then hand out a VLAN that is already trunked everywhere.
   */
  it('does not read a session failure as an empty switch', async () => {
    const rci = {
      get: vi.fn(async () => {
        throw new AuthError('the router rejected the stored credentials');
      }),
      post: vi.fn(),
      getText: vi.fn()
    } as unknown as Rci;

    await expect(readSwitchPorts(rci)).rejects.toThrow(/credentials/);
  });
});

describe('readSegment', () => {
  const iseg = {
    vlan: '2',
    port: '1,2,3,4,5',
    'vlan-port': '1,2,3,4,5',
    'free-port': '',
    'busy-vlan': '1'
  };

  it('reports a VLAN-backed bridge as visible in the web interface', async () => {
    const rci = rciWith({
      'show/rc/interface/Bridge1': {
        description: 'guest',
        include: [{ interface: 'GigabitEthernet0/Vlan2' }, { interface: 'WifiMaster0/AccessPoint1' }],
        ip: { address: { address: '192.168.2.1', mask: '255.255.255.0' } },
        iseg
      }
    });

    const state = await readSegment(rci, 'Bridge1');
    expect(state?.uiVisible).toBe(true);
    expect(state?.vlanId).toBe('2');
    expect(state?.include).toContain('GigabitEthernet0/Vlan2');
  });

  /** The bug this whole skill exists for: a working network the UI never lists. */
  it('reports a bridge with an address but no VLAN as invisible', async () => {
    const rci = rciWith({
      'show/rc/interface/Bridge2': {
        description: 'iot',
        ip: { address: { address: '192.168.3.1', mask: '255.255.255.0' } },
        iseg: { vlan: '', port: '1,2,3,4,5', 'vlan-port': '' }
      }
    });

    const state = await readSegment(rci, 'Bridge2');
    expect(state?.address, 'the network itself is configured').toBe('192.168.3.1');
    expect(state?.uiVisible, 'and still not a segment').toBe(false);
  });

  /**
   * Measured on a live 5.1.3: Bridge0 carries an address and an empty `iseg`,
   * because the home network is the untagged one rather than a VLAN. The test
   * that catches every other invisible bridge would call this one invisible.
   */
  it('does not call the home segment invisible for having no VLAN', async () => {
    const rci = rciWith({
      'show/rc/interface/Bridge0': {
        ip: { address: { address: '192.168.1.1' } },
        iseg: { vlan: '', 'vlan-port': '' }
      }
    });

    const state = await readSegment(rci, 'Bridge0');
    expect(state?.home).toBe(true);
    expect(state?.uiVisible).toBe(true);
  });

  it('returns null for a bridge that does not exist', async () => {
    await expect(readSegment(rciWith({}), 'Bridge7')).resolves.toBeNull();
  });
});

const INVENTORY = {
  ...PORTS,
  'show/rc/interface/Bridge0': { ip: { address: { address: '192.168.1.1' } } },
  'show/rc/interface/Bridge1': { ip: { address: { address: '192.168.2.1' } } },
  'show/rc/ip/dhcp': {
    pool: {
      _WEBADMIN: { range: { begin: '192.168.1.50' }, bind: { interface: 'Bridge0' } },
      _WEBADMIN_BRIDGE1: { range: { begin: '192.168.2.50' }, bind: { interface: 'Bridge1' } }
    }
  },
  'show/rc/ip/policy': { Policy0: { description: 'tunnel' } },
  'show/rc/mws/wlan': {
    DEFAULT__: { bind: { interface: 'Bridge0' } },
    wlan0: { bind: { interface: 'Bridge1' } }
  }
};

describe('allocate', () => {
  it('skips everything already in use', async () => {
    const inventory = await readInventory(rciWith(INVENTORY));
    const allocation = allocate(inventory, { withPolicy: true, withWifi: true });

    expect(allocation.bridge, 'Bridge0 and Bridge1 are taken').toBe('Bridge2');
    expect(allocation.vlanId, 'VLAN 1 is the home access vlan, 2 is trunked').toBe(3);
    expect(allocation.vlanInterface).toBe('GigabitEthernet0/Vlan3');
    expect(allocation.address, '192.168.1 and 192.168.2 are taken').toBe('192.168.3.1');
    expect(allocation.policy, 'Policy0 exists').toBe('Policy1');
    expect(allocation.wlanKey, 'wlan0 exists').toBe('wlan1');
    expect(allocation.poolName).toBe('_WEBADMIN_BRIDGE2');
  });

  it('leaves out the policy and the Wi-Fi network when they are not wanted', async () => {
    const inventory = await readInventory(rciWith(INVENTORY));
    const allocation = allocate(inventory, { withPolicy: false, withWifi: false });

    expect(allocation.policy).toBeNull();
    expect(allocation.wlanKey).toBeNull();
  });

  it('refuses a requested subnet that is already routed', async () => {
    const inventory = await readInventory(rciWith(INVENTORY));
    expect(() => allocate(inventory, { subnet: 2, withPolicy: false, withWifi: false })).toThrow(
      /192\.168\.2\.0\/24 is already in use/
    );
  });
});

describe('readDependants', () => {
  it('finds the Wi-Fi and the pool by what they are bound to, not by their names', async () => {
    const found = await readDependants(rciWith(INVENTORY), 'Bridge1');
    expect(found.wlanKeys).toEqual(['wlan0']);
    expect(found.poolName).toBe('_WEBADMIN_BRIDGE1');
  });

  it('finds nothing for a bridge nothing points at', async () => {
    const found = await readDependants(rciWith(INVENTORY), 'Bridge9');
    expect(found).toEqual({ wlanKeys: [], poolName: null });
  });
});

const THREE_PORTS: SwitchPort[] = [
  { name: 'GigabitEthernet0/0', label: '1', trunkVids: [], accessVid: 1 },
  { name: 'GigabitEthernet0/1', label: '2', trunkVids: [], accessVid: 1 },
  { name: 'GigabitEthernet0/2', label: '3', trunkVids: [], accessVid: 1 }
];

const ALLOCATION = {
  bridge: 'Bridge2',
  vlanId: 3,
  vlanInterface: 'GigabitEthernet0/Vlan3',
  address: '192.168.3.1',
  mask: '255.255.255.0',
  dhcpBegin: '192.168.3.33',
  dhcpEnd: '192.168.3.152',
  poolName: '_WEBADMIN_BRIDGE2',
  policy: null,
  wlanKey: null
};

const REQUEST = {
  name: 'iot',
  policyDescription: null,
  permitInterfaces: [],
  ssid: null,
  psk: null
};

/** Collects every `parse` line a run sent, in order. */
function parseLines(post: { mock: { calls: unknown[][] } }): string[] {
  return post.mock.calls
    .flatMap(([body]) => (Array.isArray(body) ? body : [body]))
    .map(entry => (entry as { parse?: string }).parse)
    .filter((line): line is string => typeof line === 'string');
}

describe('createSegment', () => {
  it('trunks the VLAN over every port and verifies against iseg', async () => {
    const post = vi.fn(async () => ({}));
    const rci = rciWith(
      {
        'show/rc/interface/Bridge2': {
          iseg: { vlan: '3', port: '1,2,3', 'vlan-port': '1,2,3' },
          include: [{ interface: 'GigabitEthernet0/Vlan3' }]
        }
      },
      post
    );

    const created = await createSegment(rci, ALLOCATION, THREE_PORTS, REQUEST);

    expect(created.state.uiVisible).toBe(true);
    const lines = parseLines(post);
    for (const port of THREE_PORTS) {
      expect(lines, `${port.name} must carry the VLAN`).toContain(
        `interface ${port.name} switchport trunk vlan 3`
      );
    }
    expect(lines).toContain('interface Bridge2 include GigabitEthernet0/Vlan3');
    expect(lines).toContain('interface Bridge2 security-level protected');
  });

  /**
   * The failure this guards against is a bridge that carries traffic and is not
   * a segment. Reporting success there is worse than failing, because the user
   * only finds out when they go looking in the web interface.
   */
  it('fails and rolls back when the router does not fill in iseg', async () => {
    const post = vi.fn(async () => ({}));
    const rci = rciWith(
      { 'show/rc/interface/Bridge2': { iseg: { vlan: '', 'vlan-port': '' } } },
      post
    );

    await expect(createSegment(rci, ALLOCATION, THREE_PORTS, REQUEST)).rejects.toThrow(
      /did not become a segment/
    );

    const lines = parseLines(post);
    expect(lines).toContain('no interface Bridge2');
    expect(lines).toContain('no interface GigabitEthernet0/Vlan3');
    for (const port of THREE_PORTS) {
      expect(lines, 'rollback must take the VLAN off every port').toContain(
        `interface ${port.name} no switchport trunk vlan 3`
      );
    }
  });

  it('rolls back when a command partway through is rejected', async () => {
    const post = vi.fn(async (body: unknown) => {
      const lines = (Array.isArray(body) ? body : [body]) as { parse?: string }[];
      if (lines.some(line => line.parse?.startsWith('interface Bridge2 ip address'))) {
        throw new RciError('address already in use', {
          path: 'POST /rci/',
          code: '1',
          ident: 'Command'
        });
      }
      return {};
    });

    await expect(
      createSegment(rciWith({}, post), ALLOCATION, THREE_PORTS, REQUEST)
    ).rejects.toThrow(/address already in use/);
    expect(parseLines(post)).toContain('no interface GigabitEthernet0/Vlan3');
  });

  it('says so when the rollback itself could not finish', async () => {
    const post = vi.fn(async (body: unknown) => {
      const lines = (Array.isArray(body) ? body : [body]) as { parse?: string }[];
      if (lines.some(line => line.parse === 'no interface Bridge2')) throw new Error('busy');
      if (lines.some(line => line.parse?.startsWith('interface Bridge2 ip address'))) {
        throw new Error('rejected');
      }
      return {};
    });

    await expect(
      createSegment(rciWith({}, post), ALLOCATION, THREE_PORTS, REQUEST)
    ).rejects.toThrow(/remove it by hand: no interface Bridge2/);
  });
});

describe('teardownSegment', () => {
  it('removes the VLAN from every port, which is the step people forget', async () => {
    const post = vi.fn(async () => ({}));
    const failed = await teardownSegment(rciWith({}, post), {
      bridge: 'Bridge2',
      vlanId: 3,
      ports: THREE_PORTS,
      policy: 'Policy1',
      poolName: '_WEBADMIN_BRIDGE2',
      wlanKeys: ['wlan1']
    });

    expect(failed).toEqual([]);
    const lines = parseLines(post);
    expect(lines).toEqual([
      'no mws wlan wlan1',
      'no ip hotspot policy Bridge2',
      'no ip policy Policy1',
      'no ip dhcp pool _WEBADMIN_BRIDGE2',
      'no ip nat Bridge2',
      'no interface Bridge2',
      'interface GigabitEthernet0/0 no switchport trunk vlan 3',
      'interface GigabitEthernet0/1 no switchport trunk vlan 3',
      'interface GigabitEthernet0/2 no switchport trunk vlan 3',
      'no interface GigabitEthernet0/Vlan3'
    ]);
  });

  it('keeps going after a failure and reports what did not go', async () => {
    const post = vi.fn(async (body: unknown) => {
      const line = (body as { parse?: string }).parse;
      if (line === 'no ip nat Bridge2') throw new Error('nope');
      return {};
    });

    const failed = await teardownSegment(rciWith({}, post), {
      bridge: 'Bridge2',
      vlanId: 3,
      ports: THREE_PORTS,
      policy: null,
      poolName: null,
      wlanKeys: []
    });

    expect(failed).toEqual(['no ip nat Bridge2']);
    expect(parseLines(post), 'the steps after it still ran').toContain('no interface Bridge2');
  });
});
