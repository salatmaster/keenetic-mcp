const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const PRIVATE_IPV4_RE = /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\./;

/** Keys whose values are replaced wholesale, because they are secrets. */
const SECRET_KEYS = new Set(['public-key', 'private-key', 'preshared-key', 'psk', 'password', 'key']);

/** Keys whose values are replaced with a stable counter-based label. */
const LABEL_KEYS: Record<string, string> = {
  hostname: 'host',
  name: 'device',
  ssid: 'ssid',
  description: 'desc',
  domainname: 'domain'
};

let macMap = new Map<string, string>();
let ipMap = new Map<string, string>();
let labelMaps = new Map<string, Map<string, string>>();

export function resetAnonymizer(): void {
  macMap = new Map();
  ipMap = new Map();
  labelMaps = new Map();
}

function fakeMac(real: string): string {
  const existing = macMap.get(real);
  if (existing) return existing;
  const n = macMap.size + 1;
  // 02:… is the locally administered range, so these can never collide with real hardware.
  const tail = [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join(':');
  const fake = `02:00:${tail}`;
  macMap.set(real, fake);
  return fake;
}

function fakeIp(real: string): string {
  const existing = ipMap.get(real);
  if (existing) return existing;
  const fake = `192.0.2.${ipMap.size + 1}`;
  ipMap.set(real, fake);
  return fake;
}

function fakeLabel(kind: string, real: string): string {
  let map = labelMaps.get(kind);
  if (!map) {
    map = new Map();
    labelMaps.set(kind, map);
  }
  const existing = map.get(real);
  if (existing) return existing;
  const fake = `${kind}-${map.size + 1}`;
  map.set(real, fake);
  return fake;
}

function anonymizeString(value: string): string {
  if (MAC_RE.test(value)) return fakeMac(value.toLowerCase());
  if (PRIVATE_IPV4_RE.test(value)) return fakeIp(value);
  return value;
}

export function anonymize(value: unknown): unknown {
  if (typeof value === 'string') return anonymizeString(value);
  if (Array.isArray(value)) return value.map(item => anonymize(item));
  if (typeof value !== 'object' || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key)) {
      out[key] = '<redacted>';
      continue;
    }
    const labelKind = LABEL_KEYS[key];
    if (labelKind !== undefined && typeof child === 'string' && child.length > 0) {
      out[key] = fakeLabel(labelKind, child);
      continue;
    }
    out[key] = anonymize(child);
  }
  return out;
}
