import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../src/index.js';
import type { ToolContext } from '../src/tools/registry.js';
import type { KeeneticClient } from '../src/router/client.js';
import { stubBackup } from './helpers/backup.js';

// backup_config is here because downloading the configuration changes nothing,
// so it stays available even when writing is disabled.
const READ_TOOLS = [
  'backup_config',
  'rci_call',
  'get_config_state',
  'get_device',
  'get_interface',
  'get_internet_status',
  'get_system_info',
  'get_wifi_status',
  'list_devices',
  'list_interfaces',
  'list_policies',
  'list_routes',
  'list_segments'
];

const WRITE_TOOLS = [
  'update_device',
  'set_interface_state',
  'save_config',
  'create_segment',
  'delete_segment'
];

function context(readOnly: boolean): ToolContext {
  const client = {
    rci: { get: vi.fn(async () => ({})), post: vi.fn(), getText: vi.fn() },
    capabilities: vi.fn(async () => ({
      model: 'Keenetic Model (KN-0000)',
      hwId: 'KN-0000',
      firmware: '5.1.3',
      components: new Set<string>(),
      features: new Set<string>()
    }))
  } as unknown as KeeneticClient;
  return { client, maxResponseBytes: 25_000, readOnly, backup: stubBackup() };
}

/** Speaks real MCP to the assembled server over a linked in-memory transport. */
async function connectedClient(readOnly = false): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(context(readOnly));
  await server.connect(serverTransport);

  const client = new Client({ name: 'protocol-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('assembled server over MCP', () => {
  it('advertises every read tool', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const name of READ_TOOLS) {
      expect(tools.map(t => t.name)).toContain(name);
    }
  });

  it('gives every tool a description a model can select on', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.description!.length, `${tool.name} description is too short`).toBeGreaterThan(60);
    }
  });

  it('returns a tool result through a real tools/call round trip', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'get_system_info', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content.map(part => part.text).join(''));
    expect(payload.model).toBe('Keenetic Model (KN-0000)');
  });

  /**
   * `z.unknown()` emits a property with no `type` and no `anyOf`. A client with
   * nothing to go on may then serialise the argument to a string, and every
   * POST silently became a no-op. The advertised schema has to describe the
   * shape, so this asserts on the manifest rather than on the handler.
   */
  it('advertises a typed schema for the rci_call body', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const body = (tools.find(t => t.name === 'rci_call')?.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined)?.['body'];

    expect(body, 'rci_call must advertise a body property').toBeDefined();
    expect(
      body!['type'] ?? body!['anyOf'] ?? body!['oneOf'],
      'body must carry type information, or a client cannot tell what to send'
    ).toBeDefined();
  });
});

describe('read-only mode', () => {
  it('advertises exactly the read tools and nothing else', async () => {
    const client = await connectedClient(true);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([...READ_TOOLS].sort());
  });

  it('marks every advertised tool read-only', async () => {
    const client = await connectedClient(true);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be read-only`).toBe(true);
    }
  });
});

describe('write mode', () => {
  it('advertises the write tools', async () => {
    const client = await connectedClient(false);
    const { tools } = await client.listTools();
    for (const name of WRITE_TOOLS) {
      expect(tools.map(t => t.name)).toContain(name);
    }
  });

  it('marks every write tool destructive rather than read-only', async () => {
    const client = await connectedClient(false);
    const { tools } = await client.listTools();
    for (const name of WRITE_TOOLS) {
      const tool = tools.find(t => t.name === name);
      expect(tool?.annotations?.readOnlyHint, `${name} must not be read-only`).toBe(false);
      expect(tool?.annotations?.destructiveHint, `${name} must be destructive`).toBe(true);
    }
  });
});
