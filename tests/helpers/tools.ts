import { vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import type { KeeneticClient } from '../../src/router/client.js';
import type { ToolContext, ToolResult } from '../../src/tools/registry.js';
import { stubBackup } from './backup.js';

export type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Registers tools against a real McpServer with registerTool intercepted. */
export function captureTools(register: (server: McpServer) => void): {
  handlers: Record<string, Handler>;
} {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const handlers: Record<string, Handler> = {};
  vi.spyOn(server, 'registerTool').mockImplementation(((
    name: string,
    _config: unknown,
    handler: Handler
  ) => {
    handlers[name] = handler;
    return {} as never;
  }) as never);

  register(server);
  return { handlers };
}

/** The usual tool context around `client`, with a stub backup guard. */
export function testContext(client: KeeneticClient, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    client,
    backupName: '192.0.2.1',
    maxResponseBytes: 25_000,
    readOnly: false,
    backup: stubBackup(),
    ...overrides
  };
}

export function text(result: ToolResult): string {
  return result.content.map(part => part.text).join('');
}

export function payload(result: ToolResult): any {
  return JSON.parse(text(result));
}
