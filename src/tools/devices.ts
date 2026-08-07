import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { capList } from '../shape/budget.js';
import { projectDevice } from '../shape/project.js';
import { fail, guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';

type HostRecord = Record<string, unknown>;

async function fetchHosts(ctx: ToolContext): Promise<HostRecord[]> {
  const raw = await ctx.client.rci.get('show/ip/hotspot');
  const container = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const hosts = container['host'];
  return Array.isArray(hosts) ? (hosts as HostRecord[]) : [];
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
}
