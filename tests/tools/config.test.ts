import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerConfigTools } from '../../src/tools/config.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { captureTools, payload, testContext, text } from '../helpers/tools.js';

const RUNNING_CHECKSUM = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const STALE_CHECKSUM = '0f9e8d7c6b5a49382716f5e4d3c2b1a0';
const SAVED_CHECKSUM = '5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';

/** Startup config as the router serves it: the saved checksum is in the header. */
const configText = (checksum: string) =>
  `! $$$ Md5 checksum: ${checksum}\n! $$$ Model: Keenetic Model\nip hotspot\n`;

const CONFIG = configText(STALE_CHECKSUM);

/**
 * `unsavedAfter` models a save that never completes: the command is accepted
 * but the checksum in flash never catches up with the running one.
 *
 * `lagPolls` models the write taking a while, the way a Netcraze Speedster
 * on 5.2 Beta 1 does it: the date moves the moment the command is accepted,
 * and only that many reads of show/last-change later do the running checksum
 * and the one in flash both move to the saved value.
 *
 * `fail-safe.unsaved` is deliberately pinned to false throughout, because that
 * is what a real 5.1.1 router reports even while a change sits unsaved. A save
 * check that believes that flag passes this harness while doing nothing.
 */
function harness(opts: { unsavedAfter?: boolean; lagPolls?: number } = {}) {
  const posts: unknown[] = [];
  let runningChecksum = RUNNING_CHECKSUM;
  let savedChecksum = STALE_CHECKSUM;
  let lastChangedAt = 'Fri, 7 Aug 2026 01:20:36 GMT';
  let pollsUntilWritten: number | null = null;

  const get = vi.fn(async () => {
    if (pollsUntilWritten !== null) {
      if (pollsUntilWritten === 0) {
        runningChecksum = SAVED_CHECKSUM;
        if (opts.unsavedAfter !== true) savedChecksum = SAVED_CHECKSUM;
        pollsUntilWritten = null;
      } else {
        pollsUntilWritten -= 1;
      }
    }
    return {
      date: lastChangedAt,
      user: 'admin',
      checksum: runningChecksum,
      'fail-safe': { unsaved: false, rollback: false, 'time-left': 0 }
    };
  });
  const getText = vi.fn(async () => configText(savedChecksum));
  const post = vi.fn(async (body: unknown) => {
    posts.push(body);
    // The router records the save either way; whether flash caught up is what
    // separates a real save from one that never landed.
    lastChangedAt = 'Fri, 7 Aug 2026 01:20:40 GMT';
    pollsUntilWritten = opts.lagPolls ?? 0;
    return {};
  });

  const client = {
    rci: { get, post, getText }
  } as unknown as KeeneticClient;

  const ctx = testContext(client);
  const { handlers } = captureTools(server => registerConfigTools(server, ctx));
  return { handlers, posts, get, getText };
}

describe('save_config', () => {
  it('sends the save command and confirms afterwards', async () => {
    const { handlers, posts, get, getText } = harness();
    const out = payload(await handlers['save_config']!({}));
    expect(posts).toContainEqual({ system: { configuration: { save: {} } } });
    expect(out.saved).toBe(true);
    // The startup config is ~17 KB. Polling the confirmation rather than the
    // cheap endpoint turned one save into roughly 100 KB of traffic.
    expect(getText).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.length).toBeGreaterThan(1);
  });

  // The date moves when the save starts. Confirming on that read flash before
  // the write had finished and reported a save that landed as a failure.
  it('waits for the write to finish, not just for the command to be accepted', async () => {
    const { handlers, getText } = harness({ lagPolls: 4 });
    const out = payload(await handlers['save_config']!({}));
    expect(out.saved).toBe(true);
    expect(getText).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('fails when the router still reports unsaved changes', async () => {
    const { handlers, getText } = harness({ unsavedAfter: true });
    const result = await handlers['save_config']!({});
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/still reports unsaved/i);
    expect(getText).toHaveBeenCalledTimes(1);
  }, 10_000);
});

describe('backup_config', () => {
  // writeBackup resolves the state dir from the environment; point it at a
  // throwaway directory for each test.
  async function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'kn-state-'));
    const previous = process.env['KEENETIC_STATE_DIR'];
    process.env['KEENETIC_STATE_DIR'] = dir;
    try {
      return await fn(dir);
    } finally {
      if (previous === undefined) delete process.env['KEENETIC_STATE_DIR'];
      else process.env['KEENETIC_STATE_DIR'] = previous;
    }
  }

  it('writes into the backups directory with a timestamped name and 0600 permissions', async () => {
    await withStateDir(async dir => {
      const { handlers } = harness();
      const out = payload(await handlers['backup_config']!({}));

      expect(dirname(out.path)).toBe(join(dir, 'backups'));
      expect(basename(out.path)).toMatch(/^192\.0\.2\.1-.+\.txt$/);
      expect(out.bytes).toBe(Buffer.byteLength(CONFIG, 'utf8'));
      await expect(readFile(out.path, 'utf8')).resolves.toBe(CONFIG);
      await expect(stat(out.path).then(s => s.mode & 0o777)).resolves.toBe(0o600);
    });
  });
});
