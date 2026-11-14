import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { STARTUP_CONFIG } from './config-state.js';
import type { Rci } from './rci.js';

export interface BackupResult {
  path: string;
  bytes: number;
  createdAt: string;
}

/** What every mutating tool needs from the backup machinery. */
export interface BackupGuard {
  ensure(): Promise<BackupResult>;
  taken(): BackupResult | null;
}

/**
 * Where a backup belongs on the given platform. KEENETIC_STATE_DIR overrides it.
 *
 * The path flavour is chosen from the `platform` argument rather than from the
 * host, so the Windows layout is still produced correctly when this runs
 * anywhere else. Using the ambient `join` would emit `C:\a/keenetic-mcp`.
 */
export function stateDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const override = env['KEENETIC_STATE_DIR'];
  if (override) return override;

  const home = env['HOME'] ?? env['USERPROFILE'] ?? '.';
  if (platform === 'win32') return win32.join(env['LOCALAPPDATA'] ?? home, 'keenetic-mcp');
  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Application Support', 'keenetic-mcp');
  }
  return posix.join(env['XDG_STATE_HOME'] ?? posix.join(home, '.local', 'state'), 'keenetic-mcp');
}

/**
 * One path segment: no directories, no traversal. writeBackup() enforces
 * this itself; the export lets tool schemas advertise the same contract.
 */
export const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** Writing to these names on Windows goes to a device, not a file. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Writes one backup file into the state directory's backups folder, with
 * owner-only permissions. Shared by the backup guard and the backup_config
 * tool so the two cannot drift apart. `filename` is validated here rather
 * than at the call sites: a future caller must not be able to aim the write
 * outside the backups directory. When `filename` is omitted, a timestamped
 * name built from the router host is used; the host comes from
 * operator-controlled settings and is sanitized anyway, for the day it is not.
 */
export async function writeBackup(
  host: string,
  text: string,
  now: () => Date,
  filename?: string
): Promise<BackupResult> {
  if (filename !== undefined &&
      (!SAFE_FILENAME.test(filename) || WINDOWS_RESERVED.test(filename))) {
    throw new Error(
      'Unsafe backup filename: use letters, digits, spaces, dots, underscores and hyphens.'
    );
  }
  const dir = join(stateDir(process.platform, process.env), 'backups');
  await mkdir(dir, { recursive: true });

  const createdAt = now().toISOString();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const safeHost = host.replace(/[^A-Za-z0-9.-]/g, '_');
  const path = join(dir, filename ?? `${safeHost}-${stamp}.txt`);
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 });
  // Set explicitly: an existing file keeps its old mode through writeFile, and
  // the startup config it holds contains password hashes and keys.
  await chmod(path, 0o600);
  return { path, bytes: Buffer.byteLength(text, 'utf8'), createdAt };
}

export function createBackupGuard(rci: Rci, host: string, now: () => Date): BackupGuard {
  let done: BackupResult | null = null;
  let pending: Promise<BackupResult> | null = null;

  async function take(): Promise<BackupResult> {
    // startup-config, not running-config: the point is to capture the state a
    // reboot would return to.
    const text = await rci.getText(STARTUP_CONFIG);
    done = await writeBackup(host, text, now);
    return done;
  }

  return {
    ensure(): Promise<BackupResult> {
      if (done) return Promise.resolve(done);
      // Latched like the auth handshake: concurrent writes must not race to
      // snapshot the same configuration twice.
      pending ??= take().finally(() => {
        pending = null;
      });
      return pending;
    },
    taken: () => done
  };
}
