---
description: Connect this plugin to your Keenetic router
---

The user wants to connect the Keenetic MCP server to their router.

The server needs three things: the router address, a login, and a password. It
finds the address itself and stores the password in the operating system
keychain, so the only thing you have to do is walk the user through running the
wizard.

**Do not ask the user for their password and do not run the wizard yourself.**
It reads the password from the terminal without echoing it, which only works
when the user runs it. Tell them to run this in their own terminal:

```
npx -y keenetic-mcp init
```

Explain what will happen, so nothing is a surprise:

1. It reads the default gateway and offers it as the router address. Pressing
   enter accepts it.
2. It confirms the address really is a Keenetic before asking for anything else.
3. The login defaults to `admin`.
4. The password is typed without being shown, and is checked against the router
   immediately. Nothing is stored if the router rejects it.
5. The password goes into the system keychain. The settings file holds only the
   address and the login.

Once they say it finished, verify it by calling `get_system_info`. It should
return the model and firmware version. If it fails:

- **"No router configured"** means the wizard did not complete. Ask them to run
  it again and read out any message it printed.
- **"the router rejected credentials"** means the password is wrong. The router
  password is the one for its web interface, which is often not the Wi-Fi
  password.
- **"The router was unreachable"** means this machine is not on the same network
  as the router, or the address is wrong.

If the user would rather not store anything, the server also reads
`KEENETIC_HOST`, `KEENETIC_USER` and `KEENETIC_PASSWORD` from the environment,
and those take precedence over the stored settings.
