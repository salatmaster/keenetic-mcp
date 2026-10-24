import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { registerConfigTools } from '../../src/tools/config.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import type { KeeneticClient } from '../../src/router/client.js';
import { stubBackup } from '../helpers/backup.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

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
function harness(opts: { unsavedAfter?: boolean; readOnly?: boolean; lagPolls?: number } = {}) {
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
    rci: { get, post, getText },
    capabilities: vi.fn()
  } as unknown as KeeneticClient;

  const ctx: ToolContext = {
    client,
    maxResponseBytes: 25_000,
    readOnly: opts.readOnly === true,
    backup: stubBackup()
  };
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers: Record<string, Handler> = {};
  vi.spyOn(server, 'registerTool').mockImplementation(((
    name: string,
    _c: unknown,
    handler: Handler
  ) => {
    handlers[name] = handler;
    return {} as never;
  }) as never);

  registerConfigTools(server, ctx);
  return { handlers, posts, get, getText };
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content.map(p => p.text).join(''));
}

describe('save_config', () => {
  it('sends the save command and confirms afterwards', async () => {
    const { handlers, posts } = harness();
    const out = payload(await handlers['save_config']!({}));
    expect(posts).toContainEqual({ system: { configuration: { save: {} } } });
    expect(out.saved).toBe(true);
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
    const { handlers } = harness({ unsavedAfter: true });
    const result = await handlers['save_config']!({});
    expect(result.isError).toBe(true);
    expect(result.content.map(p => p.text).join('')).toMatch(/still reports unsaved/i);
  }, 10_000);

  // The startup config is ~17 KB. Polling the confirmation rather than the
  // cheap endpoint turned one save into roughly 100 KB of traffic.
  it('reads the startup config once, however many times it polls', async () => {
    const { handlers, get, getText } = harness();
    await handlers['save_config']!({});
    expect(getText).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.length).toBeGreaterThan(1);
  });

  it('reads it once on the failing path too', async () => {
    const { handlers, getText } = harness({ unsavedAfter: true });
    await handlers['save_config']!({});
    expect(getText).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('is not registered in read-only mode', () => {
    const { handlers } = harness({ readOnly: true });
    expect(handlers['save_config']).toBeUndefined();
  });
});

describe('backup_config', () => {
  it('writes the startup config to the requested path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-'));
    const target = join(dir, 'out.txt');
    const { handlers } = harness();
    const out = payload(await handlers['backup_config']!({ path: target }));

    expect(out.path).toBe(target);
    expect(out.bytes).toBe(CONFIG.length);
    await expect(readFile(target, 'utf8')).resolves.toBe(CONFIG);
  });

  it('reports a usable error when the directory does not exist', async () => {
    const { handlers } = harness();
    const result = await handlers['backup_config']!({ path: '/nope/missing/out.txt' });
    expect(result.isError).toBe(true);
    expect(result.content.map(p => p.text).join('')).toMatch(/absolute path/i);
  });

  it('stays available in read-only mode, since reading changes nothing', () => {
    const { handlers } = harness({ readOnly: true });
    expect(handlers['backup_config']).toBeDefined();
  });
});
