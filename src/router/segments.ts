import { RciError, ValidationError } from './errors.js';
import type { Rci } from './rci.js';

/** The home segment. Never allocated to a new network, never torn down. */
export const HOME_BRIDGE = 'Bridge0';

/**
 * How far to probe for numbered interfaces before deciding there are no more.
 * Well above any Keenetic: the largest switch in the range has eight ports.
 */
const PROBE_LIMIT = 16;

/** What the web interface names its own pools, so a segment made here looks the same. */
const POOL_PREFIX = '_WEBADMIN_BRIDGE';

/** The router keeps .1 for itself; the web interface hands out .33 to .152. */
const DHCP_FIRST = 33;
const DHCP_LAST = 152;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The router collapses a single-element list into a bare object. */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asVid(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Reads a configuration path, treating a 404 as "not configured".
 *
 * Only a 404. Swallowing every error here would turn an expired session or an
 * unplugged cable into "nothing is configured", and the allocator would then
 * hand out identifiers that are already in use.
 */
async function readOptional(rci: Rci, path: string): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await rci.get(path));
  } catch (error) {
    if (error instanceof RciError && error.code === '404') return null;
    throw error;
  }
}

export interface SwitchPort {
  /** The RCI name, for example `GigabitEthernet0/2`. */
  name: string;
  /** The label the router prints in `iseg`, for example `3`. */
  label: string;
  trunkVids: number[];
  accessVid: number | null;
}

/**
 * Every physical port of the built-in switch.
 *
 * Probed one at a time rather than read from `show/interface`, which is 32 KB.
 * Ports are contiguous from zero, so the first gap is the end of the switch.
 * An entry without a `switchport` block is some other interface sharing the
 * prefix and is not a port a VLAN can be trunked over.
 */
export async function readSwitchPorts(rci: Rci): Promise<SwitchPort[]> {
  const ports: SwitchPort[] = [];

  for (let index = 0; index < PROBE_LIMIT; index += 1) {
    const name = `GigabitEthernet0/${index}`;
    const raw = await readOptional(rci, `show/rc/interface/${name}`);
    if (raw === null) break;

    const switchport = asRecord(raw['switchport']);
    if (Object.keys(switchport).length === 0) continue;

    const trunkVids = toArray(switchport['trunk'])
      .map(entry => asVid(asRecord(entry)['vid']))
      .filter((vid): vid is number => vid !== null);

    ports.push({
      name,
      label: typeof raw['rename'] === 'string' ? raw['rename'] : String(index + 1),
      trunkVids,
      accessVid: asVid(asRecord(switchport['access'])['vid'])
    });
  }

  return ports;
}

export interface RouterInventory {
  ports: SwitchPort[];
  bridgeNumbers: number[];
  /** Third octet of every 192.168.x.0/24 already in use, from bridges and pools. */
  subnets: number[];
  vlanIds: number[];
  policies: string[];
  pools: string[];
  wlanKeys: string[];
}

/** Everything the allocator needs, so nothing is handed out twice. */
export async function readInventory(rci: Rci): Promise<RouterInventory> {
  const ports = await readSwitchPorts(rci);

  const bridgeNumbers: number[] = [];
  const subnets = new Set<number>();
  for (let index = 0; index < PROBE_LIMIT; index += 1) {
    const raw = await readOptional(rci, `show/rc/interface/Bridge${index}`);
    if (raw === null) continue;
    bridgeNumbers.push(index);
    const address = asRecord(asRecord(raw['ip'])['address'])['address'];
    const octet = typeof address === 'string' ? Number(address.split('.')[2]) : NaN;
    if (Number.isInteger(octet)) subnets.add(octet);
  }

  const pools = asRecord((await readOptional(rci, 'show/rc/ip/dhcp'))?.['pool']);
  for (const pool of Object.values(pools)) {
    const begin = asRecord(asRecord(pool)['range'])['begin'];
    const octet = typeof begin === 'string' ? Number(begin.split('.')[2]) : NaN;
    if (Number.isInteger(octet)) subnets.add(octet);
  }

  const vlanIds = new Set<number>();
  for (const port of ports) {
    for (const vid of port.trunkVids) vlanIds.add(vid);
    if (port.accessVid !== null) vlanIds.add(port.accessVid);
  }

  return {
    ports,
    bridgeNumbers,
    subnets: [...subnets].sort((a, b) => a - b),
    vlanIds: [...vlanIds].sort((a, b) => a - b),
    policies: Object.keys(asRecord(await readOptional(rci, 'show/rc/ip/policy'))),
    pools: Object.keys(pools),
    wlanKeys: Object.keys(asRecord(await readOptional(rci, 'show/rc/mws/wlan')))
  };
}

function firstFree(used: Iterable<number>, from: number, limit: number, what: string): number {
  const taken = new Set(used);
  for (let candidate = from; candidate < from + limit; candidate += 1) {
    if (!taken.has(candidate)) return candidate;
  }
  throw new ValidationError(`No free ${what} left on this router.`);
}

export interface Allocation {
  bridge: string;
  vlanId: number;
  /** The subinterface that makes the segment a VLAN, and so visible in the UI. */
  vlanInterface: string;
  address: string;
  mask: string;
  dhcpBegin: string;
  dhcpEnd: string;
  poolName: string;
  policy: string | null;
  wlanKey: string | null;
}

export interface AllocationRequest {
  /** Third octet of the 192.168.x.0/24 to use. Allocated when absent. */
  subnet?: number;
  withPolicy: boolean;
  withWifi: boolean;
}

/**
 * Picks identifiers nothing else is using.
 *
 * Bridge numbering starts at 1 and VLAN ids at 2, because Bridge0 and VLAN 1
 * are the home segment on every Keenetic. Policies start at 0: Policy0 is an
 * ordinary policy that may or may not exist.
 */
export function allocate(inventory: RouterInventory, request: AllocationRequest): Allocation {
  const bridgeNumber = firstFree(inventory.bridgeNumbers, 1, PROBE_LIMIT, 'bridge');
  const subnet =
    request.subnet ?? firstFree(inventory.subnets, 2, 250, '192.168.x.0/24 subnet');

  if (request.subnet !== undefined && inventory.subnets.includes(request.subnet)) {
    throw new ValidationError(
      `192.168.${request.subnet}.0/24 is already in use on this router. ` +
        'Choose another subnet, or omit it and one will be allocated.'
    );
  }

  const vlanId = firstFree(inventory.vlanIds, 2, 4000, 'VLAN id');
  const usedPolicyNumbers = inventory.policies
    .map(name => Number(name.replace(/^Policy/, '')))
    .filter(Number.isInteger);
  const usedWlanNumbers = inventory.wlanKeys
    .map(key => Number(key.replace(/^wlan/, '')))
    .filter(Number.isInteger);

  return {
    bridge: `Bridge${bridgeNumber}`,
    vlanId,
    vlanInterface: `GigabitEthernet0/Vlan${vlanId}`,
    address: `192.168.${subnet}.1`,
    mask: '255.255.255.0',
    dhcpBegin: `192.168.${subnet}.${DHCP_FIRST}`,
    dhcpEnd: `192.168.${subnet}.${DHCP_LAST}`,
    poolName: `${POOL_PREFIX}${bridgeNumber}`,
    policy: request.withPolicy
      ? `Policy${firstFree(usedPolicyNumbers, 0, PROBE_LIMIT, 'policy')}`
      : null,
    wlanKey: request.withWifi ? `wlan${firstFree(usedWlanNumbers, 0, PROBE_LIMIT, 'Wi-Fi network')}` : null
  };
}

export interface SegmentState {
  bridge: string;
  description: string | null;
  address: string | null;
  /** Interfaces bridged into the segment, including the VLAN subinterface. */
  include: string[];
  vlanId: string | null;
  ports: string | null;
  vlanPorts: string | null;
  /**
   * Whether the web interface lists this as a segment.
   *
   * `iseg` is computed by the router, not written by us: it stays empty for a
   * bridge that carries an address but no VLAN, which is exactly the network
   * that works over Wi-Fi and never appears under /access-points.
   *
   * Bridge0 is the exception and is always listed. Its `iseg` is empty too,
   * because the home network is the untagged one rather than a VLAN, so the
   * test that identifies every other invisible bridge would libel this one.
   */
  uiVisible: boolean;
  /** True for the home segment, which is why its empty `iseg` means nothing. */
  home: boolean;
}

export async function readSegment(rci: Rci, bridge: string): Promise<SegmentState | null> {
  const raw = await readOptional(rci, `show/rc/interface/${bridge}`);
  if (raw === null) return null;

  const iseg = asRecord(raw['iseg']);
  const vlanId = typeof iseg['vlan'] === 'string' ? iseg['vlan'] : null;
  const vlanPorts = typeof iseg['vlan-port'] === 'string' ? iseg['vlan-port'] : null;
  const address = asRecord(asRecord(raw['ip'])['address'])['address'];
  const home = bridge === HOME_BRIDGE;

  return {
    bridge,
    home,
    description: typeof raw['description'] === 'string' ? raw['description'] : null,
    address: typeof address === 'string' ? address : null,
    include: toArray(raw['include'])
      .map(entry => asRecord(entry)['interface'])
      .filter((name): name is string => typeof name === 'string'),
    vlanId,
    ports: typeof iseg['port'] === 'string' ? iseg['port'] : null,
    vlanPorts,
    uiVisible: home || ((vlanId ?? '') !== '' && (vlanPorts ?? '') !== '')
  };
}

export interface SegmentDependants {
  /** Wi-Fi networks bound to the bridge, by their mws key. */
  wlanKeys: string[];
  poolName: string | null;
}

/**
 * What has to go when a segment does, read from the router rather than derived
 * from a naming convention: a segment built by hand, or by the web interface,
 * will not follow the one used here.
 */
export async function readDependants(rci: Rci, bridge: string): Promise<SegmentDependants> {
  const boundTo = (value: unknown): boolean =>
    asRecord(asRecord(value)['bind'])['interface'] === bridge;

  const wlans = asRecord(await readOptional(rci, 'show/rc/mws/wlan'));
  const pools = asRecord((await readOptional(rci, 'show/rc/ip/dhcp'))?.['pool']);

  return {
    wlanKeys: Object.entries(wlans)
      .filter(([, value]) => boundTo(value))
      .map(([key]) => key),
    poolName: Object.entries(pools).find(([, pool]) => boundTo(pool))?.[0] ?? null
  };
}

export interface SegmentRequest {
  name: string;
  policyDescription: string | null;
  permitInterfaces: string[];
  ssid: string | null;
  psk: string | null;
}

/** Every step, in the order the router accepts them. Exported for the teardown. */
function buildSteps(allocation: Allocation, ports: SwitchPort[], request: SegmentRequest): {
  vlan: string[];
  trunk: string[];
  bridge: string[];
  policy: string[];
} {
  return {
    vlan: [
      `interface ${allocation.vlanInterface}`,
      `interface ${allocation.vlanInterface} up`
    ],
    // Every port, not just the ones a client might use. The router fills in
    // iseg.vlan-port from these, and a partial trunk gives a partial segment.
    trunk: ports.map(
      port => `interface ${port.name} switchport trunk vlan ${allocation.vlanId}`
    ),
    bridge: [
      `interface ${allocation.bridge}`,
      `interface ${allocation.bridge} description ${request.name}`,
      `interface ${allocation.bridge} security-level protected`,
      `interface ${allocation.bridge} include ${allocation.vlanInterface}`,
      `interface ${allocation.bridge} ip address ${allocation.address} ${allocation.mask}`,
      `interface ${allocation.bridge} up`,
      `ip nat ${allocation.bridge}`
    ],
    policy:
      allocation.policy === null
        ? []
        : [
            `ip policy ${allocation.policy}`,
            ...(request.policyDescription === null
              ? []
              : [`ip policy ${allocation.policy} description ${request.policyDescription}`]),
            ...request.permitInterfaces.map(
              name => `ip policy ${allocation.policy} permit global ${name}`
            ),
            `ip hotspot policy ${allocation.bridge} ${allocation.policy}`
          ]
  };
}

export interface TeardownTarget {
  bridge: string;
  vlanId: number | null;
  ports: SwitchPort[];
  policy: string | null;
  poolName: string | null;
  wlanKeys: string[];
}

/**
 * Removes a segment and everything it pulled in with it.
 *
 * Best effort by design: this runs both as a user-requested delete and as the
 * rollback of a half-built segment, where most of the steps refer to things
 * that were never created. Failures are collected and returned rather than
 * thrown, because stopping at the first one would leave more behind than it
 * cleaned up.
 *
 * The per-port trunk removal is the step people forget by hand. Skipping it
 * leaves the VLAN on every port of the switch with no bridge to belong to.
 */
export async function teardownSegment(rci: Rci, target: TeardownTarget): Promise<string[]> {
  const commands = [
    ...target.wlanKeys.map(key => `no mws wlan ${key}`),
    `no ip hotspot policy ${target.bridge}`,
    ...(target.policy === null ? [] : [`no ip policy ${target.policy}`]),
    ...(target.poolName === null ? [] : [`no ip dhcp pool ${target.poolName}`]),
    `no ip nat ${target.bridge}`,
    `no interface ${target.bridge}`,
    ...(target.vlanId === null
      ? []
      : [
          ...target.ports.map(
            port => `interface ${port.name} no switchport trunk vlan ${target.vlanId}`
          ),
          `no interface GigabitEthernet0/Vlan${target.vlanId}`
        ])
  ];

  const failed: string[] = [];
  for (const command of commands) {
    try {
      await rci.post({ parse: command });
    } catch {
      failed.push(command);
    }
  }
  return failed;
}

export interface CreatedSegment {
  allocation: Allocation;
  state: SegmentState;
  ports: string[];
}

/**
 * Builds a UI-visible segment, or leaves the router as it found it.
 *
 * The naive shape - a bridge with an address, NAT and a Wi-Fi binding - gives a
 * network that carries traffic perfectly and never appears under /access-points
 * or in the segment list. What the web interface calls a segment is backed by a
 * VLAN: a subinterface, that VLAN trunked over every switch port, and the
 * subinterface bridged in. The router then fills in `iseg` itself.
 */
export async function createSegment(
  rci: Rci,
  allocation: Allocation,
  ports: SwitchPort[],
  request: SegmentRequest
): Promise<CreatedSegment> {
  const steps = buildSteps(allocation, ports, request);

  try {
    await rci.post(steps.vlan.map(parse => ({ parse })));
    await rci.post(steps.trunk.map(parse => ({ parse })));
    await rci.post(steps.bridge.map(parse => ({ parse })));

    // JSON rather than a parsed line: `ip dhcp pool <name>` is rejected as an
    // argument parse error, and the range has to arrive with the pool.
    await rci.post({
      ip: {
        dhcp: {
          pool: {
            [allocation.poolName]: {
              range: { begin: allocation.dhcpBegin, end: allocation.dhcpEnd },
              lease: 25200,
              bind: { interface: allocation.bridge },
              enable: true
            }
          }
        }
      }
    });

    if (steps.policy.length > 0) await rci.post(steps.policy.map(parse => ({ parse })));

    // The current binding method. The legacy form configures an AccessPointN
    // directly and does not add it to the bridge, so the Wi-Fi ends up outside
    // the segment. This one puts both radios in `include` on its own.
    if (allocation.wlanKey !== null && request.ssid !== null && request.psk !== null) {
      await rci.post({
        mws: {
          wlan: {
            [allocation.wlanKey]: {
              band: ['0', '1'],
              bind: { interface: allocation.bridge },
              ssid: { name: request.ssid },
              encryption: 'wpa2+3',
              wpa: { psk: request.psk },
              enable: true
            }
          }
        }
      });
    }

    const state = await readSegment(rci, allocation.bridge);
    if (state === null || !state.uiVisible) {
      throw new Error(
        `The commands were accepted but ${allocation.bridge} did not become a segment: ` +
          `iseg.vlan is ${JSON.stringify(state?.vlanId ?? null)} and iseg.vlan-port is ` +
          `${JSON.stringify(state?.vlanPorts ?? null)}, both of which the router fills in ` +
          'once a VLAN subinterface is trunked over the switch ports and bridged in.'
      );
    }

    return { allocation, state, ports: ports.map(port => port.label) };
  } catch (error) {
    const failed = await teardownSegment(rci, {
      bridge: allocation.bridge,
      vlanId: allocation.vlanId,
      ports,
      policy: allocation.policy,
      poolName: allocation.poolName,
      wlanKeys: allocation.wlanKey === null ? [] : [allocation.wlanKey]
    });

    const suffix =
      failed.length === 0
        ? ' The half-built segment was removed, so the router is as it was.'
        : ` Rolling back left this behind, remove it by hand: ${failed.join('; ')}.`;
    throw new Error(`${(error as Error).message}${suffix}`);
  }
}
