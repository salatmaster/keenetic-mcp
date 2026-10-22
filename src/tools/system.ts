import type { McpServer } from '@modelcontextprotocol/server';
import { readConfigState } from '../router/config-state.js';
import { guard, ok, READ_ONLY, type ToolContext } from './registry.js';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * `memfree` alone reads as an alarm: Linux fills idle RAM with page cache, so a
 * healthy 128 MB router reports ~15 MB free. Buffers and cache are given back on
 * demand, and the router's own `memory` field ("used/total") is computed the
 * same way: total - free - buffers - cache.
 */
function availableKb(s: Record<string, unknown>): number | null {
  const parts = [s['memfree'], s['membuffers'], s['memcache']];
  if (!parts.every(part => typeof part === 'number')) return null;
  return (parts as number[]).reduce((sum, part) => sum + part, 0);
}

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_system_info',
    {
      title: 'Router system information',
      description:
        'Model, firmware version, uptime, CPU and memory load, and the list of installed ' +
        'KeeneticOS components. Call this first when you need to know what the router supports: ' +
        'the component list tells you which features exist on this device. ' +
        'Judge memory pressure by memoryAvailableKb, not memoryFreeKb: free excludes the ' +
        'page cache the kernel releases on demand, so it is always low on a healthy router.',
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
        memoryAvailableKb: availableKb(s),
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
        'and the state of the router fail-safe timer. Unsaved changes are lost on reboot. ' +
        'unsavedChanges is null when the saved checksum could not be read - treat that as ' +
        'unknown, not as saved.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async () => ok(await readConfigState(ctx.client.rci)))
  );
}
