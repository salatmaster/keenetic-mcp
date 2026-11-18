import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { capList } from '../shape/budget.js';
import { guard, ok, READ_ONLY, type ToolContext } from './registry.js';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function registerNetworkTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_internet_status',
    {
      title: 'Internet connectivity',
      description:
        'Whether the router currently reaches the internet, and which check failed if not: ' +
        'gateway reachability, DNS resolution, and captive-portal detection. Start here when ' +
        'the user reports the internet is down.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const s = asRecord(await ctx.client.rci.get('show/internet/status'));
      return ok({
        internet: s['internet'] === true,
        checked: s['checked'] === true,
        enabled: s['enabled'] === true,
        reliable: s['reliable'] === true,
        gatewayAccessible: s['gateway-accessible'] === true,
        dnsAccessible: s['dns-accessible'] === true,
        captiveAccessible: s['captive-accessible'] === true
      });
    })
  );

  server.registerTool(
    'list_routes',
    {
      title: 'List IP routes',
      description:
        'The routing table: destination, gateway, outgoing interface and metric. ' +
        'Use kind=default to see only the default route, which tells you which link ' +
        'traffic leaves through.',
      inputSchema: {
        kind: z
          .enum(['all', 'default'])
          .optional()
          .describe('all returns the full table; default returns only 0.0.0.0/0.'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum rows. Defaults to 100.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ kind, limit }) => {
      const raw = await ctx.client.rci.get('show/ip/route');
      const routes = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      const selected =
        kind === 'default' ? routes.filter(r => r['destination'] === '0.0.0.0/0') : routes;

      const capped = capList(selected, limit ?? 100, ctx.maxResponseBytes);
      return ok({
        routes: capped.items,
        shown: capped.shown,
        total: capped.total,
        ...(capped.note ? { note: capped.note } : {})
      });
    })
  );

  server.registerTool(
    'list_policies',
    {
      title: 'List routing policies',
      description:
        'Connection policies, which decide that a given device leaves through a given link - ' +
        'typically used to send some devices through a VPN tunnel and the rest direct. ' +
        'The names returned here are what a device is assigned to.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const raw = asRecord(await ctx.client.rci.get('ip/policy'));
      const policies = Object.entries(raw).map(([name, value]) => {
        const policy = asRecord(value);
        const permit = Array.isArray(policy['permit']) ? policy['permit'] : [];
        const interfaces = permit
          .map(entry => asRecord(entry)['interface'])
          .filter((id): id is string => typeof id === 'string');
        return {
          name,
          description: typeof policy['description'] === 'string' ? policy['description'] : '',
          interfaces
        };
      });
      return ok({ policies });
    })
  );

  server.registerTool(
    'get_wifi_status',
    {
      title: 'Wi-Fi status',
      description:
        'Wi-Fi radios grouped by band, each with its access points, SSIDs, link state and the ' +
        'number of connected clients. Use this rather than list_interfaces when the question ' +
        'is about Wi-Fi coverage or which network a device should be on.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const [ifaceRaw, assocRaw] = await Promise.all([
        ctx.client.rci.get('show/interface'),
        ctx.client.rci.get('show/associations')
      ]);
      const interfaces = asRecord(ifaceRaw);
      const stationsRaw = asRecord(assocRaw)['station'];
      const stations = Array.isArray(stationsRaw) ? stationsRaw.map(asRecord) : [];

      const clientsPerAp = new Map<string, number>();
      for (const station of stations) {
        const ap = typeof station['ap'] === 'string' ? station['ap'] : '';
        if (ap) clientsPerAp.set(ap, (clientsPerAp.get(ap) ?? 0) + 1);
      }

      // Band comes from the WifiMaster record itself, never from the index in its
      // name - that guess breaks on tri-band hardware.
      const bands = Object.entries(interfaces)
        .filter(([, value]) => asRecord(value)['type'] === 'WifiMaster')
        .map(([masterId, value]) => {
          const master = asRecord(value);
          const accessPoints = Object.entries(interfaces)
            .filter(
              ([apId, apValue]) =>
                apId.startsWith(`${masterId}/`) && asRecord(apValue)['type'] === 'AccessPoint'
            )
            .map(([apId, apValue]) => {
              const ap = asRecord(apValue);
              return {
                id: apId,
                ssid: typeof ap['ssid'] === 'string' ? ap['ssid'] : '',
                link: typeof ap['link'] === 'string' ? ap['link'] : '',
                state: typeof ap['state'] === 'string' ? ap['state'] : '',
                clients: clientsPerAp.get(apId) ?? 0
              };
            });

          return {
            radio: masterId,
            band: typeof master['band'] === 'string' ? master['band'] : '',
            description: typeof master['description'] === 'string' ? master['description'] : '',
            accessPoints
          };
        });

      return ok({ bands, totalClients: stations.length });
    })
  );

  const hostSchema = z
    .string()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/, 'Invalid hostname or IPv4 address.')
    .refine(value => !value.includes('..'), 'Invalid hostname.');

  const sourceInterfaceSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/, 'Invalid interface name.')
    .optional()
    .describe('Any existing Keenetic interface name.');

  const sourceAddressSchema = z
    .ipv4()
    .optional()
    .describe('IPv4 address to use as the source address for traceroute.');

  const maxHopsSchema = z
    .number()
    .int()
    .min(1)
    .max(64)
    .optional()
    .describe('Maximum number of traceroute hops (1-64, default: 30).');

  function appendMessages(
    target: string[],
    response: unknown,
    command: 'ping' | 'traceroute'
  ): boolean {
    const root = asRecord(response);
    const nested = asRecord(asRecord(root['tools'])[command]);
    const source = Object.keys(nested).length > 0 ? nested : root;

    if (Array.isArray(source['message'])) {
      for (const line of source['message']) {
        if (typeof line === 'string') target.push(line);
      }
    }

    return source['continued'] === true;
  }

  async function runDiagnostic(
    command: 'ping' | 'traceroute',
    args: Record<string, unknown>,
    getPath: 'tools/ping' | 'tools/traceroute',
    options?: {
      maxPolls?: number;
      timeoutMs?: number;
    }
  ) {
    const maxPolls = options?.maxPolls ?? 120;
    const timeoutMs = options?.timeoutMs ?? 60000;

    const response = await ctx.client.rci.post({ tools: { [command]: args } });
    const lines: string[] = [];
    let continued = appendMessages(lines, response, command);
    let polls = 0;
    const startedAt = Date.now();

    while (
      continued &&
      polls < maxPolls &&
      Date.now() - startedAt < timeoutMs
    ) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      polls++;

      const next = await ctx.client.rci.get(getPath);
      continued = appendMessages(lines, next, command);
    }

    if (continued) {
      const reason =
        polls >= maxPolls
          ? `the ${maxPolls} GET request limit was reached`
          : `the ${timeoutMs / 1000}-second time limit was reached`;

      lines.push(`[Polling stopped: ${reason}; partial output is shown above.]`);
    }

    return ok({
      command,
      lines
    });
  }

  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Send ICMP echo requests to a hostname or IPv4 address through the router. Supports a configurable packet count and source interface, and returns the collected ping output.',
      inputSchema: {
        host: hostSchema,
        count: z.number().int().min(1).max(20).optional(),
        source_interface: sourceInterfaceSchema
      },
      annotations: READ_ONLY
    },
    guard(async ({ host, count, source_interface }) => {
      const args: Record<string, unknown> = { host, count: count ?? 5 };
      if (source_interface) args['source-interface'] = source_interface;

      return runDiagnostic('ping', args, 'tools/ping');
    })
  );

  server.registerTool(
    'traceroute',
    {
      title: 'Traceroute',
      description: 'Trace the network path to a hostname or IPv4 address using ICMP probes. Supports selecting the source interface, source IPv4 address, and maximum number of hops (default: 30). Returns the collected hop-by-hop traceroute output.',
      inputSchema: {
        host: hostSchema,
        source_interface: sourceInterfaceSchema,
        source_address: sourceAddressSchema,
        max_hops: maxHopsSchema
      },
      annotations: READ_ONLY
    },
    guard(async ({ host, source_interface, source_address, max_hops }) => {
      const hops = max_hops ?? 30;

      const args: Record<string, unknown> = {
        host,
        type: 'icmp',
        'max-ttl': hops
      };

      if (source_interface) args['source-interface'] = source_interface;
      if (source_address) args['source-address'] = source_address;

      return runDiagnostic('traceroute', args, 'tools/traceroute', {
        maxPolls: hops * 4,
        // About 3 s per hop on a real router, but a tool call that runs past
        // a minute is one most MCP clients have already given up on.
        timeoutMs: Math.min(hops * 3000, 60_000)
      });
    })
  );
}
