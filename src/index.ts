#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config/load.js';
import { createClient } from './router/client.js';
import { registerDeviceTools } from './tools/devices.js';
import { registerInterfaceTools } from './tools/interfaces.js';
import { registerNetworkTools } from './tools/network.js';
import type { ToolContext } from './tools/registry.js';
import { registerSystemTools } from './tools/system.js';

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'keenetic', version: '0.1.0' });
  registerSystemTools(server, ctx);
  registerDeviceTools(server, ctx);
  registerInterfaceTools(server, ctx);
  registerNetworkTools(server, ctx);
  return server;
}

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2), process.env);
  const ctx: ToolContext = {
    client: createClient({
      host: config.host,
      login: config.login,
      password: config.password
    }),
    maxResponseBytes: config.maxResponseBytes,
    readOnly: config.readOnly
  };

  await createServer(ctx).connect(new StdioServerTransport());
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    // stderr only: stdout carries the MCP protocol stream.
    process.stderr.write(`keenetic-mcp failed to start: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
