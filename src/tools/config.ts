import { writeFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  checksumMoved,
  readConfigState,
  readLastChange,
  STARTUP_CONFIG,
  type LastChange
} from '../router/config-state.js';
import { fail, guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';

/**
 * The router answers the save command with "saving (http/rci)." in the present
 * tense, so the write may still be in flight. A single immediate check would
 * report a false failure; this polls briefly instead.
 *
 * The loop watches the running checksum in show/last-change, which is a small
 * JSON document. The date in the same document moves when the save starts, not
 * when it ends: measured on a Netcraze Speedster (5.2 Beta 1), the date had
 * moved within a second while flash still held the old checksum for several
 * more. The confirmation reads startup-config.txt at about 17 KB, so it runs
 * once at the end rather than on every attempt.
 *
 * Only an explicit `false` counts as saved. An unknown saved state resolves to
 * "not confirmed", so a failed read sends the caller to look rather than
 * telling them the save landed.
 */
async function waitForSaved(
  ctx: ToolContext,
  before: LastChange,
  attempts = 30,
  delayMs = 500
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (checksumMoved(before, await readLastChange(ctx.client.rci))) break;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return (await readConfigState(ctx.client.rci)).unsavedChanges === false;
}

export function registerConfigTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'backup_config',
    {
      title: 'Download a configuration backup',
      description:
        'Saves the router startup configuration to a local file. Take one before any ' +
        'sequence of changes so there is a known-good state to return to. Reading the ' +
        'configuration changes nothing on the router.',
      inputSchema: {
        path: z.string().describe('Absolute path of the local file to write.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ path }): Promise<ToolResult> => {
      const text = await ctx.client.rci.getText(STARTUP_CONFIG);
      try {
        await writeFile(path, text, 'utf8');
      } catch (error) {
        return fail(
          new Error(
            `Could not write "${path}": ${(error as Error).message} ` +
              'Give an absolute path in a directory that exists.'
          )
        );
      }
      return ok({ path, bytes: Buffer.byteLength(text, 'utf8') });
    })
  );

  if (ctx.readOnly) return;

  server.registerTool(
    'save_config',
    {
      title: 'Save the configuration',
      description:
        'Writes the running configuration to the startup configuration, so pending ' +
        'changes survive a reboot. Nothing else in this server saves, so call this only ' +
        'once the user has confirmed the changes are what they want.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async (): Promise<ToolResult> => {
      // Taken before the command so the poll can tell the router has acted.
      const before = await readLastChange(ctx.client.rci);
      await ctx.client.rci.post({ system: { configuration: { save: {} } } });
      if (!(await waitForSaved(ctx, before))) {
        return fail(
          new Error(
            'The save command was accepted but the router still reports unsaved changes. ' +
              'Call get_config_state to inspect the current state before retrying.'
          )
        );
      }
      return ok({
        saved: true,
        note: 'The running configuration is now the startup configuration.'
      });
    })
  );
}
