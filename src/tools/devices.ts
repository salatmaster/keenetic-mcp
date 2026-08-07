import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { capList } from '../shape/budget.js';
import { projectDevice } from '../shape/project.js';
import { fail, guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';
import { describeWrite, verifiedWrite } from './write.js';

type HostRecord = Record<string, unknown>;

async function fetchHosts(ctx: ToolContext): Promise<HostRecord[]> {
  const raw = await ctx.client.rci.get('show/ip/hotspot');
  const container = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const hosts = container['host'];
  return Array.isArray(hosts) ? (hosts as HostRecord[]) : [];
}

/** Reads one row out of a config branch that stores hosts as a MAC-keyed array. */
async function branchEntry(
  ctx: ToolContext,
  path: 'ip/hotspot/host' | 'known/host',
  mac: string
): Promise<HostRecord | undefined> {
  const raw = await ctx.client.rci.get(path);
  const rows = Array.isArray(raw) ? (raw as HostRecord[]) : [];
  return rows.find(row => String(row['mac']).toLowerCase() === mac.toLowerCase());
}

/**
 * Reads a host from the operational view.
 *
 * Needed for name verification: the `known/host` config branch returns only
 * `{mac}` and never echoes the name back, so a rename can only be confirmed
 * here. Assuming a config branch echoes what you wrote is exactly the mistake
 * that made an earlier version report every rename as failed.
 */
async function operationalHost(ctx: ToolContext, mac: string): Promise<HostRecord | undefined> {
  const hosts = await fetchHosts(ctx);
  return hosts.find(row => String(row['mac']).toLowerCase() === mac.toLowerCase());
}

export function registerDeviceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_devices',
    {
      title: 'List devices on the network',
      description:
        'Every device the router knows about, with IP, name, how it is connected, signal ' +
        'strength and traffic counters. Use filter to narrow to active, wired, wireless or ' +
        'blocked devices, and sort to rank by traffic, name, signal or last seen.',
      inputSchema: {
        filter: z
          .enum(['all', 'active', 'wired', 'wireless', 'blocked'])
          .optional()
          .describe('Which devices to include. Defaults to all.'),
        sort: z
          .enum(['traffic', 'name', 'rssi', 'last_seen'])
          .optional()
          .describe('Ordering. Defaults to traffic, highest first.'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum rows. Defaults to 50.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ filter, sort, limit }) => {
      const hosts = await fetchHosts(ctx);
      let devices = hosts.map(projectDevice);

      switch (filter) {
        case 'active':
          devices = devices.filter(d => d.active);
          break;
        case 'wired':
          devices = devices.filter(d => d.connection.startsWith('wired:'));
          break;
        case 'wireless':
          devices = devices.filter(d => d.connection.startsWith('wifi:'));
          break;
        case 'blocked':
          devices = devices.filter(d => d.blocked);
          break;
        default:
          break;
      }

      switch (sort) {
        case 'name':
          devices.sort((a, b) => a.name.localeCompare(b.name));
          break;
        case 'rssi':
          devices.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
          break;
        case 'last_seen':
          devices.sort((a, b) => Number(b.active) - Number(a.active));
          break;
        default:
          devices.sort((a, b) => b.rxBytes + b.txBytes - (a.rxBytes + a.txBytes));
          break;
      }

      const capped = capList(devices, limit ?? 50, ctx.maxResponseBytes);
      return ok({
        devices: capped.items,
        shown: capped.shown,
        total: capped.total,
        ...(capped.note ? { note: capped.note } : {})
      });
    })
  );

  server.registerTool(
    'get_device',
    {
      title: 'Get one device in full',
      description:
        'Every field the router holds for a single device: DHCP lease, Wi-Fi rate and mode, ' +
        'access policy, traffic shaping, first and last seen. Identify it by MAC, IP or name.',
      inputSchema: {
        mac: z.string().optional().describe('MAC address, any case.'),
        ip: z.string().optional().describe('Current IPv4 address.'),
        name: z.string().optional().describe('Registered name or hostname.')
      },
      annotations: READ_ONLY
    },
    guard(async ({ mac, ip, name }): Promise<ToolResult> => {
      if (!mac && !ip && !name) {
        return fail(new Error('Supply one of mac, ip or name to identify the device.'));
      }

      const hosts = await fetchHosts(ctx);
      const wanted = mac?.toLowerCase();
      const match = hosts.find(host => {
        const hostMac = typeof host['mac'] === 'string' ? host['mac'].toLowerCase() : '';
        if (wanted && hostMac === wanted) return true;
        if (ip && host['ip'] === ip) return true;
        if (name && (host['name'] === name || host['hostname'] === name)) return true;
        return false;
      });

      if (!match) {
        const known = hosts.map(h => String(h['name'] ?? h['hostname'] ?? h['mac'])).join(', ');
        return fail(
          new Error(
            `No device matched. Known devices: ${known || 'none'}. ` +
              'Call list_devices to see them with their addresses.'
          )
        );
      }
      return ok(match);
    })
  );

  // A read-only server must not advertise what it will refuse to do.
  if (ctx.readOnly) return;

  server.registerTool(
    'update_device',
    {
      title: 'Change a device',
      description:
        'Rename a device, allow or block its internet access, put it on a routing policy ' +
        'or a schedule, or set its traffic priority. Changes apply immediately but are ' +
        'NOT saved: a reboot discards them until save_config is called.',
      inputSchema: {
        mac: z.string().describe('MAC address of the device, any case.'),
        name: z.string().optional().describe('New name. Also registers the device.'),
        access: z.enum(['permit', 'deny']).optional().describe('Allow or block internet access.'),
        policy: z.string().optional().describe('Policy name from list_policies.'),
        schedule: z.string().optional().describe('Schedule name.'),
        priority: z.number().int().min(0).max(7).optional().describe('Traffic priority, 0 to 7.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    guard(async ({ mac, name, access, policy, schedule, priority }): Promise<ToolResult> => {
      if (
        name === undefined &&
        access === undefined &&
        policy === undefined &&
        schedule === undefined &&
        priority === undefined
      ) {
        return fail(
          new Error(
            'Nothing to change. Supply at least one of name, access, policy, schedule or priority.'
          )
        );
      }

      const snapshot = await ctx.backup.ensure();
      const applied: Record<string, unknown> = {};

      // name first: ip/hotspot refuses every setting for a host that is not
      // registered in the known branch.
      if (name !== undefined) {
        await verifiedWrite({
          apply: () => ctx.client.rci.post({ known: { host: { mac, name } } }),
          readBack: () => operationalHost(ctx, mac),
          check: row => row?.['name'] === name,
          what: `name=${name}`
        });
        applied['name'] = name;
      }

      if (access !== undefined) {
        const body =
          access === 'deny'
            ? { ip: { hotspot: { host: { mac, deny: true } } } }
            : { ip: { hotspot: { host: { mac, permit: true } } } };
        await verifiedWrite({
          apply: () => ctx.client.rci.post(body),
          readBack: () => branchEntry(ctx, 'ip/hotspot/host', mac),
          check: row => row?.['access'] === access,
          what: `access=${access}`
        });
        applied['access'] = access;
      }

      for (const [field, value] of [
        ['policy', policy],
        ['schedule', schedule],
        ['priority', priority]
      ] as const) {
        if (value === undefined) continue;
        await verifiedWrite({
          apply: () => ctx.client.rci.post({ ip: { hotspot: { host: { mac, [field]: value } } } }),
          readBack: () => branchEntry(ctx, 'ip/hotspot/host', mac),
          check: row => row?.[field] === value,
          what: `${field}=${String(value)}`
        });
        applied[field] = value;
      }

      return ok(describeWrite(applied, snapshot.path));
    })
  );
}
