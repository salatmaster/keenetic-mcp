import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { asRecord } from '../shape/record.js';

export function gatewayCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'route', args: ['-n', 'get', 'default'] };
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-Command', '(Get-NetRoute -DestinationPrefix 0.0.0.0/0).NextHop']
    };
  }
  return { command: 'ip', args: ['route', 'show', 'default'] };
}

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;

export function parseGateway(platform: NodeJS.Platform, stdout: string): string | null {
  if (platform === 'darwin') {
    const line = stdout.split('\n').find(l => l.trim().startsWith('gateway:'));
    return line?.match(IPV4)?.[1] ?? null;
  }
  if (platform === 'win32') {
    return stdout.match(IPV4)?.[1] ?? null;
  }
  const line = stdout.split('\n').find(l => l.startsWith('default'));
  return line?.match(IPV4)?.[1] ?? null;
}

/**
 * Confirms a host is a Keenetic by asking for /auth and reading the realm,
 * which is the same signal the session layer authenticates against. Anything
 * else answering on port 80 will not carry that header.
 */
export async function identifyRouter(
  host: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ realm: string } | null> {
  try {
    const res = await fetchImpl(`http://${host}/auth`, {
      signal: AbortSignal.timeout(4000),
      redirect: 'manual'
    });
    const realm = res.headers.get('X-NDM-Realm');
    return realm ? { realm } : null;
  } catch {
    return null;
  }
}

export function configDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const override = env['KEENETIC_CONFIG_DIR'];
  if (override) return override;

  const home = env['HOME'] ?? env['USERPROFILE'] ?? '.';
  if (platform === 'win32') return win32.join(env['APPDATA'] ?? home, 'keenetic-mcp');
  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Application Support', 'keenetic-mcp');
  }
  return posix.join(env['XDG_CONFIG_HOME'] ?? posix.join(home, '.config'), 'keenetic-mcp');
}

/** One router as `init` saved it. The password is in the keychain, not here. */
export interface StoredRouter {
  host: string;
  login: string;
}

/**
 * Everything config.json holds: the router `init` set up without a profile,
 * kept at the top level where 0.4 put it, and any named ones under `profiles`.
 */
export interface StoredConfig {
  router: StoredRouter | null;
  profiles: Record<string, StoredRouter>;
}

const FILE = 'config.json';

function asRouter(value: unknown): StoredRouter | null {
  const v = value as Partial<StoredRouter> | null;
  if (typeof v?.host !== 'string' || typeof v.login !== 'string') return null;
  return { host: v.host, login: v.login };
}

async function readFileObject(dir: string): Promise<Record<string, unknown>> {
  try {
    return asRecord(JSON.parse(await readFile(join(dir, FILE), 'utf8')));
  } catch {
    return {};
  }
}

export async function readStoredConfig(dir: string): Promise<StoredConfig> {
  const raw = await readFileObject(dir);
  const entries = Object.entries(asRecord(raw['profiles']));
  // fromEntries defines own properties, so a "__proto__" key stays a key.
  const profiles = Object.fromEntries(
    entries.flatMap(([name, value]) => {
      const router = asRouter(value);
      return router ? [[name, router] as const] : [];
    })
  );
  return { router: asRouter(raw), profiles };
}

/**
 * Saves one router, as the default or under a profile, and leaves every other
 * entry in the file as it was: setting up the parents' router must not forget
 * the home one.
 *
 * JSON rather than TOML: Node has no built-in parser and a handful of fields do
 * not justify a dependency. The password is never written here; it lives in the
 * keychain.
 */
export async function writeStoredRouter(
  dir: string,
  router: StoredRouter,
  profile?: string
): Promise<string> {
  const raw = await readFileObject(dir);
  const entry = { host: router.host, login: router.login };
  if (profile) {
    raw['profiles'] = { ...asRecord(raw['profiles']), [profile]: entry };
  } else {
    Object.assign(raw, entry);
  }
  await mkdir(dir, { recursive: true });
  const path = join(dir, FILE);
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return path;
}
