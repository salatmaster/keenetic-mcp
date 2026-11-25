import type { StoredConfig } from './discover.js';

export interface AppConfig {
  host: string;
  login: string;
  password: string;
  /** The profile in use, or null for the router `init` set up without one. */
  profile: string | null;
  readOnly: boolean;
  maxResponseBytes: number;
}

/** Looks a password up in the keychain by account name, see {@link secretAccount}. */
export type ReadSecret = (account: string) => Promise<string | null>;

const NO_STORED_CONFIG: StoredConfig = { router: null, profiles: {} };

/**
 * Letters, digits, `-` and `_`: the name ends up in a keychain account, a
 * backup file name and, on Windows, a PowerShell command line.
 */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** KEENETIC_PROFILE, else --profile, else none. */
export function selectedProfile(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  const name = env['KEENETIC_PROFILE'] || flagValue(argv, '--profile');
  if (!name) return null;
  if (!PROFILE_NAME.test(name)) {
    throw new Error(
      `Profile name "${name}" is not allowed: use up to 32 letters, digits, "-" and "_".`
    );
  }
  return name;
}

/**
 * The keychain account a router's password is stored under.
 *
 * Without a profile it is `login@host`, as in 0.4, so existing setups keep
 * working. A profile prefixes its name: two routers that both answer at
 * 192.168.1.1 with login admin would otherwise overwrite each other's password.
 */
export function secretAccount(profile: string | null, login: string, host: string): string {
  return profile ? `${profile}:${login}@${host}` : `${login}@${host}`;
}

function knownProfiles(stored: StoredConfig): string {
  const names = Object.keys(stored.profiles);
  return names.length > 0 ? `Saved profiles: ${names.join(', ')}.` : 'No profiles are saved.';
}

export const DEFAULT_MAX_RESPONSE_BYTES = 25_000;

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

/**
 * Merges the three sources of configuration.
 *
 * The environment wins over both the flag and the stored value: a container or
 * a CI run has no keychain to read, and must never be redirected by whatever
 * happens to be configured on a developer machine.
 *
 * The password is looked up for the router this resolves to, not for the one
 * `init` saved. Pointing KEENETIC_HOST at a second router used to send it the
 * first router's password, which came back as a 401 that read like a typo.
 */
export async function loadConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stored: StoredConfig = NO_STORED_CONFIG,
  readSecret: ReadSecret = async () => null
): Promise<AppConfig> {
  const profile = selectedProfile(argv, env);
  // Own keys only: a profile called "constructor" must not find Object's.
  const router = profile
    ? Object.hasOwn(stored.profiles, profile)
      ? stored.profiles[profile]
      : undefined
    : stored.router;
  if (profile && !router) {
    throw new Error(
      `No profile "${profile}". ${knownProfiles(stored)} Set one up with ` +
        `"npx keenetic-mcp init --profile ${profile}".`
    );
  }

  const host = env['KEENETIC_HOST'] ?? flagValue(argv, '--host') ?? router?.host;
  const login = env['KEENETIC_USER'] ?? router?.login ?? 'admin';
  const password =
    env['KEENETIC_PASSWORD'] ??
    (host ? await readSecret(secretAccount(profile, login, host)) : null);

  const rawMax = flagValue(argv, '--max-response-bytes');
  const parsedMax = rawMax === undefined ? DEFAULT_MAX_RESPONSE_BYTES : Number.parseInt(rawMax, 10);
  if (!Number.isFinite(parsedMax) || parsedMax <= 0) {
    throw new Error(`--max-response-bytes must be a positive integer, got "${rawMax}"`);
  }

  if (!host) {
    throw new Error(
      Object.keys(stored.profiles).length > 0
        ? `No router selected. ${knownProfiles(stored)} Choose one with KEENETIC_PROFILE ` +
            'or --profile, or run "npx keenetic-mcp init" to set up a default router.'
        : 'No router configured. Run "npx keenetic-mcp init" to set one up, or set ' +
            'KEENETIC_HOST and KEENETIC_PASSWORD in the environment.'
    );
  }
  if (!password) {
    const init = profile ? `npx keenetic-mcp init --profile ${profile}` : 'npx keenetic-mcp init';
    throw new Error(
      `No password stored for ${login}@${host}${profile ? ` in profile "${profile}"` : ''}. ` +
        `Run "${init}" for that router, or set KEENETIC_PASSWORD in the environment.`
    );
  }

  return {
    host,
    login,
    password,
    profile,
    readOnly: argv.includes('--read-only'),
    maxResponseBytes: parsedMax
  };
}
