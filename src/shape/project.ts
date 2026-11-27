import { asRecord, str } from './record.js';

export interface DeviceSummary {
  mac: string;
  ip: string;
  name: string;
  connection: string;
  rssi: number | null;
  active: boolean;
  rxBytes: number;
  txBytes: number;
  blocked: boolean;
}

export interface InterfaceSummary {
  id: string;
  type: string;
  description: string;
  link: string;
  state: string;
  address: string;
  defaultGateway: boolean;
  addressScope?: AddressScope | undefined;
  likelyExit?: string | undefined;
}

export type AddressScope = 'public' | 'private' | 'cgnat';

/**
 * Whether an IPv4 address can be the one the internet sees. A WAN link with a
 * private or CGNAT address sits behind the provider's NAT, so its external
 * address cannot be read from the router at all.
 */
export function addressScope(address: string): AddressScope | undefined {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return undefined;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
    return 'private';
  }
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  return 'public';
}

/**
 * The remote endpoint of a WireGuard tunnel with a single peer. Many VPN
 * providers send traffic out from that same address, but not all of them, so it
 * is only a hint. With several peers the router is the server side and the
 * endpoints are its clients, not an exit.
 */
export function likelyExit(iface: Record<string, unknown>): string | undefined {
  const peers = asRecord(iface['wireguard'])['peer'];
  if (!Array.isArray(peers) || peers.length !== 1) return undefined;
  return str(asRecord(peers[0]), 'remote-endpoint-address') || undefined;
}

function num(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function bool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

/**
 * Nine fields out of roughly forty. The raw hotspot listing is 10.7 KB for nine
 * hosts; almost all of it is noise for "who is on my network".
 *
 * No band label here: deriving 2.4 vs 5 GHz from the WifiMaster index is a
 * guess that breaks on tri-band hardware. get_wifi_status reports bands
 * properly because it already holds the interface records.
 */
export function projectDevice(host: unknown): DeviceSummary {
  const h = asRecord(host);
  const iface = asRecord(h['interface']);
  const ssid = str(h, 'ssid');
  const ifaceLabel = str(iface, 'name') || str(iface, 'id');
  const rssiRaw = h['rssi'];

  return {
    mac: str(h, 'mac'),
    ip: str(h, 'ip'),
    name: str(h, 'name') || str(h, 'hostname') || str(h, 'mac'),
    connection: ssid ? `wifi:${ssid}` : `wired:${ifaceLabel}`,
    rssi: typeof rssiRaw === 'number' ? rssiRaw : null,
    active: bool(h, 'active'),
    rxBytes: num(h, 'rxbytes'),
    txBytes: num(h, 'txbytes'),
    blocked: str(h, 'access') === 'deny'
  };
}

export function projectInterface(id: string, iface: unknown): InterfaceSummary {
  const i = asRecord(iface);
  return {
    id,
    type: str(i, 'type'),
    description: str(i, 'description'),
    link: str(i, 'link'),
    state: str(i, 'state'),
    address: str(i, 'address'),
    defaultGateway: bool(i, 'defaultgw'),
    addressScope: addressScope(str(i, 'address')),
    likelyExit: likelyExit(i)
  };
}
