import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { capList } from '../shape/budget.js';
import { projectInterface } from '../shape/project.js';
import { fail, guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';
import { describeWrite, verifiedWrite } from './write.js';

type InterfaceKind = 'all' | 'wan' | 'lan' | 'wifi' | 'vpn' | 'bridge';

/**
 * Reads one interface by name.
 *
 * Asked through POST rather than by building `show/interface/<name>`: every
 * Wi-Fi access point is named like `WifiMaster0/AccessPoint0`, and the slash is
 * read as a further path segment, so the GET form is a 404 for exactly the
 * interfaces list_interfaces reports under kind=wifi.
 */
async function readInterface(ctx: ToolContext, name: string): Promise<Record<string, unknown>> {
  const raw = await ctx.client.rci.post({ show: { interface: { name } } });
  const outer = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const show = typeof outer['show'] === 'object' && outer['show'] !== null
    ? (outer['show'] as Record<string, unknown>)
    : {};
  const record = show['interface'];
  return typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {};
}

const VPN_TYPES = new Set(['Wireguard', 'OpenVPN', 'L2TP', 'PPTP', 'IPsec', 'Sstp']);

function matchesKind(id: string, record: Record<string, unknown>, kind: InterfaceKind): boolean {
  const type = typeof record['type'] === 'string' ? record['type'] : '';
  switch (kind) {
    case 'wan':
      return record['role'] === 'inet' || record['defaultgw'] === true;
    case 'wifi':
      return id.includes('WifiMaster') || type === 'AccessPoint';
    case 'vpn':
      return VPN_TYPES.has(type);
    case 'bridge':
      return type === 'Bridge';
    case 'lan':
      return type === 'Bridge' || type.includes('Ethernet');
    default:
      return true;
  }
}

export function registerInterfaceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_interfaces',
    {
      title: 'List network interfaces',
      description:
        'Every interface on the router - WAN links, bridges, Wi-Fi access points and VPN ' +
        'tunnels - with link state, address and whether it carries the default route. ' +
        'Summary detail is the default because the full listing is very large.',
      inputSchema: {
        kind: z
          .enum(['all', 'wan', 'lan', 'wifi', 'vpn', 'bridge'])
          .optional()
          .describe('Which interfaces to include. Defaults to all.'),
        detail: z
          .enum(['summary', 'full'])
          .optional()
          .describe('summary returns seven fields per interface; full returns every field.'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum rows. Defaults to 100.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ kind, detail, limit }) => {
      const raw = await ctx.client.rci.get('show/interface');
      const all = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

      const selected = Object.entries(all).filter(([id, record]) =>
        matchesKind(
          id,
          typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {},
          kind ?? 'all'
        )
      );

      const shaped =
        detail === 'full'
          ? selected.map(([id, record]) => ({ id, ...(record as Record<string, unknown>) }))
          : selected.map(([id, record]) => projectInterface(id, record));

      const capped = capList(shaped, limit ?? 100, ctx.maxResponseBytes);
      return ok({
        interfaces: capped.items,
        shown: capped.shown,
        total: capped.total,
        ...(capped.note ? { note: capped.note } : {})
      });
    })
  );

  server.registerTool(
    'get_interface',
    {
      title: 'Get one interface in full',
      description:
        'Every field for a single interface, including protocol-specific detail such as ' +
        'WireGuard peers or PPPoE session state. Get the exact name from list_interfaces first.',
      inputSchema: {
        name: z.string().describe('Interface id, for example Bridge0 or Wireguard3.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ name }): Promise<ToolResult> => {
      try {
        return ok(await readInterface(ctx, name));
      } catch (error) {
        return fail(
          new Error(
            `Could not read interface "${name}": ${(error as Error).message} ` +
              'Call list_interfaces to see the exact ids available on this router.'
          )
        );
      }
    })
  );

  // A read-only server must not advertise what it will refuse to do.
  if (ctx.readOnly) return;

  server.registerTool(
    'set_interface_state',
    {
      title: 'Bring an interface up or down',
      description:
        'Enables or disables a network interface. Taking down a bridge or the WAN link ' +
        'can cut off access to the router itself, including this connection. Confirm what ' +
        'the interface carries with get_interface before calling this.',
      inputSchema: {
        name: z.string().describe('Interface id from list_interfaces.'),
        state: z.enum(['up', 'down']).describe('Desired administrative state.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ name, state }): Promise<ToolResult> => {
      const snapshot = await ctx.backup.ensure();
      const body =
        state === 'up'
          ? { interface: { [name]: { up: true } } }
          : { interface: { [name]: { up: { no: true } } } };

      await verifiedWrite({
        apply: () => ctx.client.rci.post(body),
        readBack: () => readInterface(ctx, name),
        check: record => record['state'] === state,
        what: `${name} state=${state}`
      });

      return ok(describeWrite({ interface: name, state }, snapshot.path));
    })
  );
}
