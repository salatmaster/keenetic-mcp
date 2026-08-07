---
name: keenetic-rci
description: Use when a Keenetic question is not covered by the curated tools and you need rci_call - explains the RCI tree, the paths that exist, the responses that will blow up your context, and the traps that make a wrong call look like success
---

# Reaching the Keenetic API directly

The curated tools cover the common questions. `rci_call` covers everything else.
It is deliberately unrestricted, so the responsibility for calling it well is
yours.

## What RCI actually is

Not REST. It is a JSON mirror of the router's command-line tree, so a URL path
is a path through that tree. There are two branches:

| Form | What it gives you |
|---|---|
| `GET show/...` | operational state, the equivalent of a `show` command |
| `GET <config path>` | the running configuration, as JSON |
| `POST` with a body | executes a command; the body mirrors the same tree |

`GET` with an empty path returns the entire running configuration, about 35 KB.

## Find the syntax instead of guessing it

**This is the single most useful technique.** The router stores its own
configuration as valid CLI, so it will tell you the exact syntax of anything it
is already doing:

```
rci_call { "method": "GET", "path": "show/running-config" }
```

Read the lines around whatever you want to change. A host with a routing policy
appears as `host <mac> policy Policy0`, which maps to
`{"ip":{"hotspot":{"host":{"mac":"...","policy":"Policy0"}}}}`. Guessing field
names instead produces silent no-ops, described below.

## Three traps

**A wrong field name looks exactly like success.** Send a field into a branch
that does not have it and the router answers `{}` with no error and changes
nothing. Always read the value back after a write and confirm it actually
changed. The curated write tools do this for you; `rci_call` does not.

**Errors arrive inside HTTP 200.** A failure is reported as
`{"status":[{"status":"error","code":...,"message":...}]}` in the body. The
server raises those as errors for you, but if you see a `status` block with a
level other than `error`, that is informational and not a failure: a successful
write returns `{"status":[{"status":"message","message":"rule \"permit\" applied..."}]}`.

**A config branch does not echo what you write.** `known/host` returns only
`[{"mac":"..."}]` and never includes the name, even straight after a successful
rename. Verify a change against whichever view actually exposes the field, which
for names is `show/ip/hotspot`.

## Paths worth knowing

Confirmed on KeeneticOS 5.1. Smaller firmware has fewer of them; call
`get_system_info` and read the component list before assuming a feature exists.

| Path | Contents |
|---|---|
| `show/version` | model, firmware, installed components, hardware features |
| `show/system` | CPU, memory, uptime, conntrack usage |
| `show/interface` | every interface, about 32 KB |
| `show/ip/hotspot` | every known device with full telemetry |
| `show/ip/route` | routing table |
| `show/associations` | Wi-Fi stations |
| `show/internet/status` | reachability checks |
| `show/last-change` | who changed the config, and whether it is saved |
| `show/ip/dhcp/bindings` | DHCP leases |
| `show/ip/policy`, `ip/policy` | connection policies |
| `ip/hotspot/host` | per-device access and policy configuration |
| `known/host` | device registration and names |
| `ip/static` | port forwarding |

## Responses that will blow up your context

The server caps every response, but a capped response is still a wasted call.
Measured on a mid-range router:

| Path | Size |
|---|---|
| `show/ip/nat` | over 100 KB, hundreds of rows |
| `show/processes` | about 70 KB |
| `show/netfilter` | about 34 KB, and **plain text, not JSON** |
| `show/interface` | about 32 KB |
| `show/running-config` | about 15 KB, an array of CLI lines |

Ask for a narrow path. `show/interface/Bridge0` instead of `show/interface`.

## Paths that do not exist

Do not assume a component implies a path of the same name. On 5.1 these are all
404, even with the corresponding component installed:

`show/wireguard`, `show/log`, `show/ipsec`, `show/components/list`,
`show/ntce`, `show/skydns`, `show/wlan`

WireGuard state lives under `show/interface/Wireguard3`, not `show/wireguard`.

## Interface names containing a slash

Every Wi-Fi access point is named like `WifiMaster0/AccessPoint0`. The slash is
read as another path segment, so `GET show/interface/WifiMaster0/AccessPoint0`
is a 404. Ask by name instead:

```
rci_call { "method": "POST",
           "body": { "show": { "interface": { "name": "WifiMaster0/AccessPoint0" } } } }
```

The `get_interface` tool already does this.

## Before you write anything

Read [keenetic-safe-changes](../keenetic-safe-changes/SKILL.md). Writes through
`rci_call` skip the verification and the automatic backup that the curated tools
provide, so prefer `update_device` and `set_interface_state` whenever they fit.
