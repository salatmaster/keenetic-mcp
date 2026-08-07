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
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
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
    defaultGateway: bool(i, 'defaultgw')
  };
}
