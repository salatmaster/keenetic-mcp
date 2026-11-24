#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { runInitFromTerminal } from './cli/init.js';
import { configDir, readStoredConfig } from './config/discover.js';
import { loadConfig } from './config/load.js';
import { createSecretStore, spawnRunner } from './config/secrets.js';
import { createBackupGuard } from './router/backup.js';
import { createClient } from './router/client.js';
import { registerConfigTools } from './tools/config.js';
import { registerDeviceTools } from './tools/devices.js';
import { registerInterfaceTools } from './tools/interfaces.js';
import { registerNetworkTools } from './tools/network.js';
import { registerRawTool } from './tools/raw.js';
import type { ToolContext } from './tools/registry.js';
import { registerSegmentTools } from './tools/segments.js';
import { registerSystemTools } from './tools/system.js';
import { loadLocalEnv, resolveVersion } from './version.js';

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'keenetic', version: resolveVersion() });
  registerSystemTools(server, ctx);
  registerDeviceTools(server, ctx);
  registerInterfaceTools(server, ctx);
  registerNetworkTools(server, ctx);
  registerSegmentTools(server, ctx);
  registerConfigTools(server, ctx);
  registerRawTool(server, ctx);
  return server;
}

async function main(): Promise<void> {
  // Before anything reads the environment, so a checkout can keep its router
  // credentials in .env instead of exporting them. A no-op once installed.
  loadLocalEnv();

  // Before the config is read, so it answers on a machine that has never been
  // set up. Every bug report starts by asking which version is running.
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${resolveVersion()}\n`);
    return;
  }

  // `init` is a subcommand rather than a second binary, so the published
  // surface stays a single command.
  if (process.argv[2] === 'init') {
    process.exit(await runInitFromTerminal(process.argv.slice(3)));
  }

  const dir = configDir(process.platform, process.env);
  const store = createSecretStore(process.platform, spawnRunner, dir);
  const config = await loadConfig(
    process.argv.slice(2),
    process.env,
    await readStoredConfig(dir),
    account => store.read(account)
  );
  const client = createClient({
    host: config.host,
    login: config.login,
    password: config.password
  });
  // Two routers can share an address, so a profile's backups carry its name.
  const backupName = config.profile ? `${config.profile}-${config.host}` : config.host;
  const ctx: ToolContext = {
    client,
    backupName,
    maxResponseBytes: config.maxResponseBytes,
    readOnly: config.readOnly,
    backup: createBackupGuard(client.rci, backupName, () => new Date())
  };

  await createServer(ctx).connect(new StdioServerTransport());
}

/**
 * True when this module is the program being run, rather than imported.
 *
 * The entry path has to be resolved through symlinks first: npm installs a bin
 * as a symlink in node_modules/.bin, so under `npx keenetic-mcp` argv[1] is the
 * link and import.meta.url is its target. Comparing them unresolved never
 * matches, and the server exits silently without ever starting.
 */
function isProgramEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isProgramEntry()) {
  main().catch((error: unknown) => {
    // stderr only: stdout carries the MCP protocol stream.
    process.stderr.write(`keenetic-mcp failed to start: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
