import { vi } from 'vitest';
import type { BackupGuard, BackupResult } from '../../src/router/backup.js';

export const STUB_SNAPSHOT: BackupResult = {
  path: '/tmp/keenetic-test-backup.txt',
  bytes: 10,
  createdAt: '2026-08-07T00:00:00.000Z'
};

/** A backup guard that records calls without touching the filesystem. */
export function stubBackup(): BackupGuard {
  return {
    ensure: vi.fn(async () => STUB_SNAPSHOT),
    taken: () => null
  };
}
