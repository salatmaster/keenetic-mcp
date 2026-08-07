export interface WriteOutcome {
  applied: Record<string, unknown>;
  saved: false;
  unsavedChanges: true;
  backup: string | null;
  note: string;
}

/**
 * Applies a change and proves it landed.
 *
 * The router answers a wrong field name with `{}` and no error, changing
 * nothing: sending `name` into the ip/hotspot branch instead of `known` looks
 * exactly like success. Trusting the response would report a change that never
 * happened, which is the worst failure mode for an agent, so the value is
 * always read back and checked against the intent.
 */
export async function verifiedWrite<T>(opts: {
  apply: () => Promise<unknown>;
  readBack: () => Promise<T>;
  check: (value: T) => boolean;
  what: string;
}): Promise<T> {
  await opts.apply();
  const value = await opts.readBack();
  if (!opts.check(value)) {
    throw new Error(
      `The router accepted the command but ${opts.what} did not take effect. ` +
        'This usually means the field belongs to a different configuration branch. ' +
        'Read the current state with the matching get_ tool before retrying.'
    );
  }
  return value;
}

export function describeWrite(
  applied: Record<string, unknown>,
  backupPath: string | null
): WriteOutcome {
  return {
    applied,
    saved: false,
    unsavedChanges: true,
    backup: backupPath,
    note:
      'Applied to the running configuration and verified, but NOT saved. ' +
      'A reboot discards it. Call save_config to make it permanent.'
  };
}
