import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ValidationError } from '../router/errors.js';
import {
  allocate,
  createSegment,
  HOME_BRIDGE,
  nextBridgeNumber,
  readDependants,
  readInventory,
  readSegment,
  readSwitchPorts,
  teardownSegment
} from '../router/segments.js';
import { fail, guard, ok, READ_ONLY, type ToolContext, type ToolResult } from './registry.js';
import { describeWrite } from './write.js';

export function registerSegmentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_segments',
    {
      title: 'List network segments',
      description:
        'Every bridge on the router, and whether the web interface lists it as a segment. ' +
        'A bridge that carries an address but has no VLAN behind it works for traffic and ' +
        'never appears under /access-points, so uiVisible is the field that matters.',
      inputSchema: {},
      annotations: READ_ONLY
    },
    guard(async (): Promise<ToolResult> => {
      const inventory = await readInventory(ctx.client.rci);
      return ok({
        segments: inventory.segments,
        switchPorts: inventory.ports.map(port => ({
          port: port.label,
          interface: port.name,
          accessVlan: port.accessVid,
          trunkVlans: port.trunkVids
        })),
        free: {
          nextBridge: `Bridge${nextBridgeNumber(inventory.bridgeNumbers)}`,
          usedVlanIds: inventory.vlanIds,
          usedSubnets: inventory.subnets.map(octet => `192.168.${octet}.0/24`),
          usedPolicies: inventory.policies
        }
      });
    })
  );

  if (ctx.readOnly) return;

  server.registerTool(
    'create_segment',
    {
      title: 'Create a network segment',
      description:
        'Creates an isolated network that the web interface actually lists as a segment: ' +
        'a VLAN subinterface trunked over every switch port, a bridge, an address, NAT, ' +
        'a DHCP pool, and optionally a Wi-Fi network and a routing policy. Free ' +
        'identifiers are chosen automatically. The result is verified against the ' +
        'router-computed iseg block, and a failure anywhere rolls the whole thing back. ' +
        'Nothing is saved; call save_config once the user confirms.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('Segment name, shown in the web interface. One word works best.'),
        ssid: z.string().min(1).optional().describe('Wi-Fi network name. Omit for wired only.'),
        psk: z
          .string()
          .min(8)
          .optional()
          .describe('Wi-Fi password, at least 8 characters. Required with ssid.'),
        subnet: z
          .number()
          .int()
          .min(0)
          .max(255)
          .optional()
          .describe('Third octet of 192.168.x.0/24. Allocated when omitted.'),
        permit_interfaces: z
          .array(z.string())
          .optional()
          .describe(
            'Create a routing policy allowing only these interfaces, for example ' +
              '["Wireguard1"]. Omit to leave the segment on the default route.'
          ),
        policy_description: z
          .string()
          .optional()
          .describe('Description for the created policy.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    guard(
      async ({
        name,
        ssid,
        psk,
        subnet,
        permit_interfaces,
        policy_description
      }): Promise<ToolResult> => {
        if ((ssid === undefined) !== (psk === undefined)) {
          return fail(
            new ValidationError('ssid and psk go together: give both, or neither for a wired segment.')
          );
        }

        const snapshot = await ctx.backup.ensure();
        const inventory = await readInventory(ctx.client.rci);

        if (inventory.ports.length === 0) {
          return fail(
            new Error(
              'No switch ports were found, so a VLAN cannot be trunked and the segment ' +
                'would not appear in the web interface. Call list_segments to see what ' +
                'this router reports.'
            )
          );
        }

        const allocation = allocate(inventory, {
          ...(subnet === undefined ? {} : { subnet }),
          withPolicy: permit_interfaces !== undefined && permit_interfaces.length > 0,
          withWifi: ssid !== undefined
        });

        const state = await createSegment(ctx.client.rci, allocation, inventory.ports, {
          name,
          policyDescription: policy_description ?? null,
          permitInterfaces: permit_interfaces ?? [],
          ssid: ssid ?? null,
          psk: psk ?? null
        });

        return ok({
          ...describeWrite(
            {
              segment: state.bridge,
              name,
              address: allocation.address,
              vlan: allocation.vlanId,
              dhcp: `${allocation.dhcpBegin} - ${allocation.dhcpEnd}`,
              trunkedOverPorts: inventory.ports.map(port => port.label),
              policy: allocation.policy,
              wifi: ssid === undefined ? null : { ssid, network: allocation.wlanKey }
            },
            snapshot.path
          ),
          uiVisible: state.uiVisible,
          include: state.include,
          verifiedBy: `iseg.vlan=${state.vlanId}, iseg.vlan-port=${state.vlanPorts}`
        });
      }
    )
  );

  server.registerTool(
    'delete_segment',
    {
      title: 'Delete a network segment',
      description:
        'Removes a segment and everything created with it: the Wi-Fi networks bound to ' +
        'it, its policy, its DHCP pool, NAT, the bridge, and the VLAN on every switch ' +
        'port. Removing the bridge alone leaves the VLAN trunked over the whole switch. ' +
        'Devices on the segment lose their connection. Refuses the home segment.',
      inputSchema: {
        bridge: z.string().describe('Segment to remove, for example Bridge2.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    guard(async ({ bridge }): Promise<ToolResult> => {
      if (bridge === HOME_BRIDGE) {
        return fail(
          new ValidationError(
            `${HOME_BRIDGE} is the home segment that carries the local network and, most ` +
              'likely, this management session. It cannot be removed here.'
          )
        );
      }

      const state = await readSegment(ctx.client.rci, bridge);
      if (state === null) {
        return fail(new ValidationError(`There is no ${bridge} on this router.`));
      }

      const snapshot = await ctx.backup.ensure();
      const ports = await readSwitchPorts(ctx.client.rci);
      const { wlanKeys, poolName } = await readDependants(ctx.client.rci, bridge);

      const failed = await teardownSegment(ctx.client.rci, {
        bridge,
        vlanId: state.vlanId === null ? null : Number(state.vlanId),
        ports,
        policy: null,
        poolName,
        wlanKeys
      });

      const after = await readSegment(ctx.client.rci, bridge);
      if (after !== null) {
        return fail(
          new Error(
            `${bridge} still exists after the removal. Left to clean up by hand: ` +
              `${failed.join('; ') || 'nothing reported as failed'}.`
          )
        );
      }

      return ok({
        ...describeWrite(
          { removed: bridge, wifi: wlanKeys, dhcpPool: poolName, vlan: state.vlanId },
          snapshot.path
        ),
        note:
          'Applied to the running configuration but NOT saved. A reboot discards it. ' +
          'Any routing policy the segment used was left in place, because policies are ' +
          'shared; remove it separately if nothing else uses it.',
        ...(failed.length === 0 ? {} : { notRemoved: failed })
      });
    })
  );
}
