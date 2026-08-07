---
name: keenetic-safe-changes
description: Use before changing anything on a Keenetic router - explains that changes are not saved until asked, what the router's fail-safe does and does not protect against, and the order that avoids locking yourself out
---

# Changing a Keenetic router without breaking it

## Changes are not saved until someone says so

A change through this server applies to the **running** configuration
immediately and is **discarded on reboot**. That is a safety feature, not a bug:
a mistake undoes itself if the router restarts.

Every write tool tells you this in its response:

```json
{ "applied": { "access": "deny" }, "saved": false, "unsavedChanges": true,
  "backup": "/…/192.168.1.1-2026-08-07T01-20-36-000Z.txt" }
```

`save_config` is the only thing that makes a change permanent. **Call it only
when the user has confirmed the result is what they wanted**, never
automatically as part of a change. If they never call it, nothing is lost that
they cared about keeping.

Use `get_config_state` to see whether anything is pending.

## The router's fail-safe protects less than it sounds like

Keenetic arms a three-minute timer when the configuration changes, and reverts
to the saved configuration if the **management session loses connectivity**.

That protects against locking yourself out. It does **not** protect against a
change that is simply wrong: block the wrong device and the router stays
perfectly reachable, so nothing reverts.

## A backup is taken for you

Before the first change of a session, the startup configuration is downloaded to
a local file. The path is in every write response. Mention it to the user the
first time something is changed, so they know a way back exists.

`backup_config` takes one on demand, which is worth doing before a sequence of
related changes.

## Order matters for devices

A device must be registered before its access, policy, schedule or priority can
be set. Setting a `name` registers it, so if you are configuring a device the
router has only seen and not registered, set the name in the same
`update_device` call. The tool already applies name first.

Symptom of getting this wrong: `host "..." is unregistered`.

## What can cut off your own access

`set_interface_state` with `state: "down"` is the one genuinely dangerous tool
here. Taking down a bridge, the WAN link, or the interface carrying the
management session ends the conversation with the router, and the fail-safe
reboot is then the only way back.

Before calling it, check what the interface actually carries:

```
get_interface { "name": "Bridge0" }
```

If it has an address the user is likely connected through, or `defaultGateway`
is true, say so and ask before proceeding. Disabling an unused guest access
point is fine; disabling `Bridge0` on a home router is not.

## The working order

1. Read the current state with the matching `get_` or `list_` tool.
2. Make the change. The tool reads it back and fails loudly if it did not land.
3. Read the state again and tell the user what actually changed.
4. Ask whether to keep it.
5. Only then call `save_config`.

If something looks wrong at step 3, the change is still unsaved: the user can
reboot the router and everything returns to the last saved state.
