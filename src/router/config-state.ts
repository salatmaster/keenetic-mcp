import type { Rci } from './rci.js';

/** Where the router serves the saved configuration. Three callers need the path. */
export const STARTUP_CONFIG = '/ci/startup-config.txt';

/** The router stamps the saved configuration with its own checksum, in a header comment. */
const SAVED_CHECKSUM = /^!\s*\$+\s*Md5 checksum:\s*([0-9a-f]{32})/im;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export interface LastChange {
  date: string | null;
  user: string | null;
  agent: string | null;
  /** Moves when the configuration changes, and again when it is saved. */
  checksum: string | null;
  failSafe: { unsaved: boolean; rollbackPending: boolean; secondsLeft: unknown };
}

/** What `get_config_state` returns. Named for the reader, not for the wire. */
export interface ConfigState {
  lastChangedAt: string | null;
  lastChangedBy: string | null;
  lastChangedVia: string | null;
  runningChecksum: string | null;
  savedChecksum: string | null;
  /** null when the saved checksum could not be read - never a guess. */
  unsavedChanges: boolean | null;
  failSafe: { unsaved: boolean; rollbackPending: boolean; secondsLeft: unknown };
}

/**
 * The cheap half: a small JSON document, against ~17 KB for the startup config.
 * Enough to see that the router has acted, not enough to prove what it wrote.
 */
export async function readLastChange(rci: Rci): Promise<LastChange> {
  const raw = asRecord(await rci.get('show/last-change'));
  const failSafe = asRecord(raw['fail-safe']);
  return {
    date: asString(raw['date']),
    user: asString(raw['user']),
    agent: asString(raw['agent']),
    checksum: asString(raw['checksum']),
    failSafe: {
      unsaved: failSafe['unsaved'] === true,
      rollbackPending: failSafe['rollback'] === true,
      secondsLeft: failSafe['time-left'] ?? 0
    }
  };
}

/**
 * True once the running checksum has moved since `before` was taken.
 *
 * The date is not enough: on a save it moves as soon as the command is
 * accepted, while startup-config.txt still holds the old checksum. The running
 * checksum moves only when the write has finished.
 */
export function checksumMoved(before: LastChange, after: LastChange): boolean {
  return before.checksum !== after.checksum;
}

/**
 * Whether the running configuration still differs from the one in flash.
 *
 * `show/last-change` carries a `fail-safe.unsaved` flag that reads like the
 * answer and is not: it tracks the fail-safe rollback timer, not the saved
 * state. Measured on KeeneticOS 5.1.1, three objects were removed over RCI and
 * the flag stayed `false` throughout, while startup-config.txt was still
 * byte-for-byte the old one - a reboot would have restored everything.
 *
 * The checksum is the signal that actually moves, so the running one is
 * compared against the header the router writes into startup-config.txt.
 */
export async function readConfigState(rci: Rci): Promise<ConfigState> {
  const last = await readLastChange(rci);

  let savedChecksum: string | null = null;
  try {
    savedChecksum = SAVED_CHECKSUM.exec(await rci.getText(STARTUP_CONFIG))?.[1] ?? null;
  } catch {
    // Reporting "saved" on a failed read would be the very error this replaces.
    savedChecksum = null;
  }

  return {
    lastChangedAt: last.date,
    lastChangedBy: last.user,
    lastChangedVia: last.agent,
    runningChecksum: last.checksum,
    savedChecksum,
    unsavedChanges:
      last.checksum === null || savedChecksum === null ? null : last.checksum !== savedChecksum,
    failSafe: last.failSafe
  };
}
