import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../src/index.js';
import type { ToolContext } from '../src/tools/registry.js';
import type { KeeneticClient } from '../src/router/client.js';

const EXPECTED_TOOLS = [
  'get_config_state',
  'get_device',
  'get_interface',
  'get_internet_status',
  'get_system_info',
  'get_wifi_status',
  'list_devices',
  'list_interfaces',
  'list_policies',
  'list_routes'
];

function context(): ToolContext {
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
  return { client, maxResponseBytes: 25_000, readOnly: false };
}

/** Speaks real MCP to the assembled server over a linked in-memory transport. */
async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(context());
  await server.connect(serverTransport);

  const client = new Client({ name: 'protocol-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('assembled server over MCP', () => {
  it('advertises exactly the ten read tools', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it('marks every advertised tool as read-only', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be read-only in this plan`).toBe(
        true
      );
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
});
