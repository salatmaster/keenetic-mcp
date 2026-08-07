import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { guard, ok, READ_ONLY, type ToolContext } from './registry.js';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_system_info',
    {
      title: 'Router system information',
      description:
        'Model, firmware version, uptime, CPU and memory load, and the list of installed ' +
        'KeeneticOS components. Call this first when you need to know what the router supports: ' +
        'the component list tells you which features exist on this device.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const [caps, system] = await Promise.all([
        ctx.client.capabilities(),
        ctx.client.rci.get('show/system')
      ]);
      const s = asRecord(system);

      return ok({
        model: caps.model,
        hardwareId: caps.hwId,
        firmware: caps.firmware,
        hostname: s['hostname'] ?? '',
        uptimeSeconds: Number(s['uptime'] ?? 0),
        cpuLoad: s['cpuload'] ?? null,
        memoryTotalKb: s['memtotal'] ?? null,
        memoryFreeKb: s['memfree'] ?? null,
        connectionsTotal: s['conntotal'] ?? null,
        connectionsFree: s['connfree'] ?? null,
        components: [...caps.components].sort(),
        features: [...caps.features].sort()
      });
    })
  );

  server.registerTool(
    'get_config_state',
    {
      title: 'Configuration state',
      description:
        'Whether the running configuration has unsaved changes, who last changed it and when, ' +
        'and the state of the router fail-safe timer. Unsaved changes are lost on reboot.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => {
      const raw = asRecord(await ctx.client.rci.get('show/last-change'));
      const failSafe = asRecord(raw['fail-safe']);
      return ok({
        lastChangedAt: raw['date'] ?? null,
        lastChangedBy: raw['user'] ?? null,
        lastChangedVia: raw['agent'] ?? null,
        savedChecksum: raw['checksum'] ?? null,
        unsavedChanges: failSafe['unsaved'] === true,
        failSafe: {
          rollbackPending: failSafe['rollback'] === true,
          secondsLeft: failSafe['time-left'] ?? 0
        }
      });
    })
  );
}
