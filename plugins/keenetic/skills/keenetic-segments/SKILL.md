---
name: keenetic-segments
description: Use when creating an isolated network on a Keenetic - a guest network, an IoT network, a segment routed through a VPN - explains why the obvious way produces a working network the web interface refuses to list, and the VLAN it is actually missing
---

# Creating a segment the router will admit exists

## The trap

The obvious way to build an isolated network is a bridge with an address, NAT,
and a Wi-Fi network bound to it:

```
interface Bridge2
interface Bridge2 ip address 192.168.3.1 255.255.255.0
interface Bridge2 up
ip nat Bridge2
```

This works. Clients associate, get addresses, reach the internet, and stay off
the home network. It is also **invisible**: nothing appears under
`/access-points`, nothing appears in the segment list, and the user cannot
manage from the web interface the thing they just asked you to create.

Reported as "it works but I can't see it", which is a much harder bug to find
after the fact than before.

## What the web interface means by a segment

A segment is **VLAN-backed**. The bridge is only half of it. Three things are
missing from the sequence above:

1. a VLAN subinterface, `GigabitEthernet0/VlanN`
2. that VLAN trunked over **every** port of the switch
3. the subinterface bridged into the segment

Do those and the router fills in the rest itself. `iseg` - the block the web
interface reads - is computed, not written:

```json
"iseg": { "vlan": "2", "port": "1,2,3,4,5", "vlan-port": "1,2,3,4,5",
          "free-port": "", "busy-vlan": "1" }
```

You never set those fields. If they are empty, the VLAN is missing.

## Use the tool

`create_segment` does all of it, picks free identifiers, verifies the result
against `iseg`, and rolls the whole thing back if any step fails:

```
create_segment { "name": "iot", "ssid": "…", "psk": "…" }
create_segment { "name": "vpn", "permit_interfaces": ["Wireguard1"] }
create_segment { "name": "wired-lab", "subnet": 40 }
```

`list_segments` shows what exists and, per bridge, whether `uiVisible` is true.
Run it first: a bridge that is already there but not visible has the same
missing VLAN, and is worth mentioning to the user.

Everything below is for doing it by hand through `rci_call`, which is worth
reading anyway, because it is what the tool is doing.

## Doing it by hand

Commands go through `parse`, which takes a CLI line:

```
rci_call { "method": "POST", "body": { "parse": "interface Bridge2 up" } }
```

An array executes several in order:

```
rci_call { "method": "POST", "body": [ { "parse": "…" }, { "parse": "…" } ] }
```

### 1. Find what is free

| Read | Tells you |
|---|---|
| `show/rc/interface/Bridge<n>` | which bridges exist, and their subnets. 404 means free |
| `show/rc/interface/GigabitEthernet0/<n>` | one switch port: `rename` is its label, `switchport.trunk` its VLANs. 404 means the switch ended |
| `show/rc/ip/dhcp` | pools, keyed by name, with the ranges they hand out |
| `show/rc/ip/policy` | policies, keyed by name |
| `show/rc/mws/wlan` | Wi-Fi networks, keyed by `wlanN`, each with `bind.interface` |

Probe the numbered paths one at a time. `show/interface` gives the same answers
in 32 KB.

Bridge0 and VLAN 1 are the home segment on every Keenetic. Start bridges at 1
and VLAN ids at 2. A VLAN id is free if it is in no port's `trunk` list and is
no port's `access.vid`.

### 2. Build it

```
interface GigabitEthernet0/Vlan3
interface GigabitEthernet0/Vlan3 up

interface GigabitEthernet0/0 switchport trunk vlan 3
interface GigabitEthernet0/1 switchport trunk vlan 3
interface GigabitEthernet0/2 switchport trunk vlan 3
…one line per port…

interface Bridge2
interface Bridge2 description iot
interface Bridge2 security-level protected
interface Bridge2 include GigabitEthernet0/Vlan3
interface Bridge2 ip address 192.168.3.1 255.255.255.0
interface Bridge2 up
ip nat Bridge2
```

`switchport trunk vlan` **adds** to the port. It does not disturb `access.vid`,
so the home network on that port keeps working. Trunk every port, not the ones
you expect to be used: `iseg.vlan-port` is built from them, and a partial trunk
gives a partial segment.

`security-level protected` is what the web interface sets on its own segments.

### 3. DHCP, which will not go through `parse`

`ip dhcp pool <name>` comes back as an argument parse error. Send JSON, with the
range in the same call:

```json
{ "ip": { "dhcp": { "pool": { "_WEBADMIN_BRIDGE2": {
    "range": { "begin": "192.168.3.33", "end": "192.168.3.152" },
    "lease": 25200,
    "bind": { "interface": "Bridge2" },
    "enable": true } } } } }
```

The `_WEBADMIN_BRIDGE<n>` name is the one the web interface uses for its own
pools. Matching it keeps the segment editable there.

### 4. Wi-Fi, if it needs any

Use `mws wlan`, not the legacy per-`AccessPointN` configuration. The legacy form
configures a radio without adding it to the bridge, so the Wi-Fi ends up outside
the segment it is supposed to serve. `mws wlan` adds both radios to `include`
itself:

```json
{ "mws": { "wlan": { "wlan1": {
    "band": ["0", "1"],
    "bind": { "interface": "Bridge2" },
    "ssid": { "name": "…" },
    "encryption": "wpa2+3",
    "wpa": { "psk": "…" },
    "enable": true } } } }
```

### 5. A policy, if it routes somewhere specific

```
ip policy Policy1
ip policy Policy1 description through-the-tunnel
ip policy Policy1 permit global Wireguard1
ip hotspot policy Bridge2 Policy1
```

## Verify against `iseg`, not against the return value

The router answers a wrong field name with `{}` and no error. The only proof is
the computed block:

```
rci_call { "method": "GET", "path": "show/rc/interface/Bridge2" }
```

```json
"iseg": { "vlan": "3", "port": "1,2,3,4,5", "vlan-port": "1,2,3,4,5" },
"include": [ { "interface": "GigabitEthernet0/Vlan3" },
             { "interface": "WifiMaster0/AccessPoint1" },
             { "interface": "WifiMaster1/AccessPoint1" } ]
```

`iseg.vlan` and `iseg.vlan-port` both non-empty means the web interface will
list it. Empty means you have built the invisible version. `include` should hold
the VLAN and, if Wi-Fi was configured, one access point per radio.

Two exceptions to that test, both measured rather than assumed:

**Bridge0 has an empty `iseg` and is listed anyway.** The home network is the
untagged one rather than a VLAN, so the check that identifies every other
invisible bridge would libel this one. `list_segments` reports it as `home`.

**A segment with no Wi-Fi will not appear under `/access-points`.** That page is
"My networks and Wi-Fi": it lists Wi-Fi networks, so a wired-only segment has
nothing to show there. It still appears in the segment list. If the user says
they cannot see it, ask which page they are looking at before assuming the
segment is broken - the two access-point lines only enter `include` when
`mws wlan` binds to the bridge:

```
interface Bridge1                  interface Bridge2
    description guest                  description wired-only
    include GigabitEthernet0/Vlan2     include GigabitEthernet0/Vlan3
    include WifiMaster1/AccessPoint1
    include WifiMaster0/AccessPoint1
    security-level protected           security-level protected
```

Both are segments. Only the first is on `/access-points`.

The name shown is the `description`, not the bridge.

## Tearing one down

Removing the bridge is not enough. The VLAN stays trunked over every port of the
switch with nothing to belong to, and the next segment inherits the mess.

```
no mws wlan wlan1
no ip hotspot policy Bridge2
no ip policy Policy1
no ip dhcp pool _WEBADMIN_BRIDGE2
no ip nat Bridge2
no interface Bridge2
interface GigabitEthernet0/0 no switchport trunk vlan 3
interface GigabitEthernet0/1 no switchport trunk vlan 3
…one line per port…
no interface GigabitEthernet0/Vlan3
```

Read `show/rc/mws/wlan` and `show/rc/ip/dhcp` first and match on
`bind.interface` rather than assuming the names: a segment made in the web
interface will not be called what this skill calls it.

`delete_segment` does the whole list, in order, and refuses Bridge0.

A policy is shared configuration. Leave it unless nothing else references it.

## None of this is saved

A segment created here disappears on reboot until `save_config` runs, which is a
useful property while testing: build it, look at it in the web interface, and if
it is wrong, reboot rather than unpick it.

Tell the user it is unsaved, let them look, and call `save_config` only once
they say it is right. Read [keenetic-safe-changes](../keenetic-safe-changes/SKILL.md)
before any of this.

## Confirmed on

Keenetic Ultra (KN-1811), KeeneticOS 5.1.3, five switch ports, by building a
segment and tearing it down again.

Worth knowing from that run: `switchport trunk vlan` really is additive. The
ports went from `access=1 trunk=[2]` to `access=1 trunk=[2,3]` and back, so
neither the home network nor the existing guest segment on those ports noticed.
The two access points appeared in `include` on their own when `mws wlan` bound
to the bridge, and the teardown left no subinterface, pool or Wi-Fi entry.

The shape is not model-specific, but the port count is: read the ports rather
than assuming five.
