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

/** Real value to stand-in, per kind: mac, ip, and each label kind. */
let fakes = new Map<string, Map<string, string>>();

export function resetAnonymizer(): void {
  fakes = new Map();
}

/** The same stand-in for the same real value, numbered in order of first sight. */
function fake(kind: string, real: string, make: (n: number) => string = n => `${kind}-${n}`): string {
  let map = fakes.get(kind);
  if (!map) {
    map = new Map();
    fakes.set(kind, map);
  }
  const existing = map.get(real);
  if (existing) return existing;
  const value = make(map.size + 1);
  map.set(real, value);
  return value;
}

function fakeMac(real: string): string {
  // 02:… is the locally administered range, so these can never collide with real hardware.
  return fake('mac', real, n =>
    `02:00:${[(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join(':')}`
  );
}

function fakeIp(real: string): string {
  return fake('ip', real, n => `192.0.2.${n}`);
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
      out[key] = fake(labelKind, child);
      continue;
    }
    out[key] = anonymize(child);
  }
  return out;
}
