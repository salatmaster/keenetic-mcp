"""Build the README demo: a Claude Code session with keenetic-mcp, as an asciicast.

The session is composed, not recorded, the same way as nahuya's transcript scenes.
What it shows is what the tools really do: the tool names, arguments and JSON shapes
are the server's own, output is folded the way Claude Code folds it ("… +N lines"),
and every claim in the final message is something the tools verify.

usage: python scene.py OUT.cast
then:  python make-demo.py demo.json demo.svg    (needs pyte)
"""
import json, sys

OUT = sys.argv[1]
COLS, ROWS = 100, 34
GREEN, GREY, WHITE, LINK, ORANGE, RULE, USERBG = "4eba65", "999999", "ffffff", "b1b9f9", "d77757", "888888", "373737"
HOME = "~"


def seg(text, fg=None, bg=None, bold=False):
    return (text, fg, bg, bold)


def md(text, base=None):
    """`code` -> link colour, **bold** -> bold."""
    out, bold, code, buf = [], False, False, ""
    i = 0
    while i < len(text):
        if text.startswith("**", i):
            out.append(seg(buf, LINK if code else base, None, bold)); buf = ""; bold = not bold; i += 2; continue
        if text[i] == "`":
            out.append(seg(buf, LINK if code else base, None, bold)); buf = ""; code = not code; i += 1; continue
        buf += text[i]; i += 1
    out.append(seg(buf, LINK if code else base, None, bold))
    return [s for s in out if s[0]]


def wrap_segs(segs, first, cont, width=COLS):
    """Word-wrap styled segments; `first`/`cont` are prefix segment lists."""
    words = []
    for t, fg, bg, b in segs:
        for k, part in enumerate(t.split(" ")):
            if k:
                words.append(None)
            if part:
                words.append((part, fg, bg, b))
    rows, cur = [], list(first)
    used = sum(len(s[0]) for s in first)
    pending = False
    for w in words:
        if w is None:
            pending = True; continue
        start = sum(len(s[0]) for s in (first if not rows else cont))
        space = 1 if pending and used > start else 0
        if used + space + len(w[0]) > width:
            rows.append(cur); cur = list(cont); used = sum(len(s[0]) for s in cont); space = 0
        if space:
            cur.append(seg(" ", None, w[2])); used += 1
        cur.append(w); used += len(w[0]); pending = False
    rows.append(cur)
    return rows


def say(text):
    """An assistant message: white ⏺, markdown, 2-space continuation."""
    blocks = []
    for para in text.split("\n"):
        if not para.strip():
            blocks.append([]); continue
        lead = len(para) - len(para.lstrip())
        first = [seg("⏺ ", WHITE)] if not blocks else [seg("  " + " " * lead)]
        cont = [seg("  " + " " * lead + ("  " if para.lstrip().startswith("- ") else ""))]
        blocks += wrap_segs(md(para.lstrip()), first, cont)
    return blocks


def mcp(tool, args, out=None, running=False):
    """An MCP tool call, as Claude Code draws one: server - tool (MCP)(args), then the
    first three lines of the JSON it returned and "… +N lines" for the rest."""
    name = f"keenetic - {tool} (MCP)"
    rows = wrap_segs([seg(name, None, None, True), seg("(" + args + ")")],
                     [seg("⏺ ", GREY if running else GREEN)], [seg("      ")])
    if running:
        rows.append([seg("  ⎿  Running…", GREY)])
        return rows
    lines = json.dumps(out, indent=2, ensure_ascii=False).split("\n")
    for k, line in enumerate(lines[:3]):
        rows.append([seg("  ⎿  " if k == 0 else "     ", GREY), seg(line)])
    if len(lines) > 3:
        rest = len(lines) - 3
        rows.append([seg(f"     … +{rest} line{'s' if rest > 1 else ''} (ctrl+o to expand)", GREY)])
    return rows


def user(text):
    rows = wrap_segs([seg(text, WHITE, USERBG)], [seg("❯ ", GREY, USERBG)], [seg("  ", None, USERBG)])
    return [r + [seg(" " * (COLS - sum(len(s[0]) for s in r)), None, USERBG)] for r in rows]


LOGO = [
    [seg(" ▐", ORANGE), seg("▛███▛█", ORANGE, "000000"), seg("   "), seg("Claude", None, None, True), seg(" "),
     seg("Code", None, None, True), seg(" "), seg("v2.1.325", GREY)],
    [seg("▝▜", ORANGE), seg("█████", ORANGE, "000000"), seg("█▀", ORANGE), seg("  "), seg("Opus 5.5", GREY)],
    [seg(" ▝▝", ORANGE), seg("   "), seg("▝▝", ORANGE), seg("   "), seg(HOME, GREY)],
]

SPIN = "·✢✳✶✻✽"


class Scene:
    def __init__(self):
        self.blocks = []
        self.t = 0.0
        self.events = []
        self.prompt = ""
        self.bottom = ("idle", None)
        self.tick = 0

    def content(self):
        rows = list(LOGO) + [[], []]
        for b in self.blocks:
            rows += b + [[]]
        return rows

    def bottom_rows(self):
        kind, info = self.bottom
        out = []
        if kind == "spin":
            g = SPIN[self.tick % len(SPIN)]
            verb, secs, tok = info
            out += [[seg(g, ORANGE), seg(" "), seg(verb + "…", ORANGE), seg(f" ({secs} · ↓ {tok} tokens)", GREY)], []]
        elif kind == "done":
            out += [[seg("✻ ", GREY), seg(info, GREY)], []]
        out += [[seg("─" * COLS, RULE)], [seg("❯ "), seg(self.prompt)], [seg("─" * COLS, RULE)],
                [seg("  "), seg("? for shortcuts", GREY)]]
        return out

    def frame(self, dt):
        self.t += dt
        self.tick += 1
        bottom = self.bottom_rows()
        avail = ROWS - len(bottom)
        content = self.content()
        while content and not content[-1]:
            content.pop()
        content.append([])
        content = content[-avail:] if len(content) > avail else content + [[]] * (avail - len(content))
        buf = "\x1b[H\x1b[2J"
        for y, row in enumerate((content + bottom)[:ROWS]):
            buf += f"\x1b[{y + 1};1H"
            for text, fg, bg, bold in row:
                sgr = "0"
                if bold: sgr += ";1"
                if fg: sgr += ";38;2;" + ";".join(str(int(fg[i:i + 2], 16)) for i in (0, 2, 4))
                if bg: sgr += ";48;2;" + ";".join(str(int(bg[i:i + 2], 16)) for i in (0, 2, 4))
                buf += f"\x1b[{sgr}m{text}"
            buf += "\x1b[0m"
        self.events.append([round(self.t, 3), "o", buf])

    def type(self, text):
        for ch in text:
            self.prompt += ch
            self.frame(0.05)

    def send(self, text, verb):
        self.type(text)
        self.frame(0.6)
        self.prompt = ""
        self.blocks.append(user(text))
        self.bottom = ("spin", (verb, "2s", "0.3k"))
        self.frame(0.8)

    def add(self, rows, dt=2.0):
        self.blocks.append(rows)
        self.frame(dt)

    def call(self, tool, args, out, spin, run=1.2, dt=1.6):
        """A tool call shows as running first, then with its result."""
        self.bottom = ("spin", spin)
        self.add(mcp(tool, args, running=True), run)
        self.blocks[-1] = mcp(tool, args, out)
        self.frame(dt)

    def save(self):
        with open(OUT, "w") as f:
            f.write(json.dumps({"version": 2, "width": COLS, "height": ROWS}) + "\n")
            for e in self.events:
                f.write(json.dumps(e) + "\n")


# ------------------------------------------------------------------ what the tools return
# Shapes as in src/tools/*.ts; values are a plausible home network.
NOTE = "Applied to the running configuration and verified, but NOT saved. A reboot discards it. Call save_config to make it permanent."
BACKUP = "~/Library/Application Support/keenetic-mcp/backups/192.168.1.1-2026-11-24T18-02-11-000Z.txt"

POLICIES = {"policies": [
    {"name": "Policy0", "description": "VPN", "interfaces": ["Wireguard0"]},
    {"name": "Policy1", "description": "Kids", "interfaces": ["GigabitEthernet1"]},
]}
# list_devices returns 11 devices of 10 fields each: what JSON.stringify(…, null, 2) prints.
DEVICES_LINES = 2 + 11 * 12 + 4
DEVICE = {"applied": {"policy": "Policy0"}, "saved": False, "unsavedChanges": True, "backup": BACKUP, "note": NOTE}
SEGMENT = {
    "applied": {"segment": "Bridge2", "name": "IoT", "address": "192.168.3.1/24", "vlan": 3,
                "dhcp": "192.168.3.33 - 192.168.3.152", "trunkedOverPorts": ["1", "2", "3", "4"], "policy": None,
                "wifi": {"ssid": "Home-IoT", "network": "WifiMaster0/AccessPoint2"}},
    "saved": False, "unsavedChanges": True, "backup": BACKUP, "note": NOTE,
    "uiVisible": True, "include": ["Bridge2"], "verifiedBy": "iseg.vlan=3, iseg.vlan-port=1,2,3,4"}
SAVED = {"saved": True, "note": "The running configuration is now the startup configuration."}


def devices_out():
    lines = ["{", '  "devices": [', "    {"]
    return lines, DEVICES_LINES


# ------------------------------------------------------------------ the session
s = Scene()
s.frame(0.8)
s.send("put the living room TV and my work laptop on the WireGuard VPN, everything else stays direct. "
       "and give the smart home stuff its own wifi that can't see my home network", "Percolating")

s.call("list_policies", "", POLICIES, ("Percolating", "4s", "0.6k"))

# list_devices prints 11 devices; draw its head and the real fold count
s.bottom = ("spin", ("Percolating", "6s", "0.9k"))
s.add(mcp("list_devices", 'sort: "name"', running=True), 1.2)
head, total = devices_out()
s.blocks[-1] = (wrap_segs([seg("keenetic - list_devices (MCP)", None, None, True), seg('(sort: "name")')], [seg("⏺ ", GREEN)], [seg("      ")])
                + [[seg("  ⎿  " if k == 0 else "     ", GREY), seg(x)] for k, x in enumerate(head)]
                + [[seg(f"     … +{total - 3} lines (ctrl+o to expand)", GREY)]])
s.frame(1.6)

s.bottom = ("spin", ("Percolating", "11s", "1.4k"))
s.add(say("`Policy0` already sends traffic only through `Wireguard0`, so the TV and the laptop just go on it. "
          "For the smart home I'll build a separate segment with its own Wi-Fi."), 3.2)

s.call("update_device", 'mac: "02:00:00:00:00:21", policy: "Policy0"', DEVICE, ("Percolating", "15s", "1.8k"))
s.call("update_device", 'mac: "02:00:00:00:00:07", policy: "Policy0"', DEVICE, ("Percolating", "18s", "2.0k"))
s.call("create_segment", 'name: "IoT", ssid: "Home-IoT", psk: "kettle-orbit-58"', SEGMENT,
       ("Percolating", "23s", "2.3k"), run=2.6)

s.bottom = ("done", "Cooked for 31s")
s.add(say("Done, and every change was read back from the router:\n"
          "\n"
          "- **VPN:** `living-room-tv` and `work-laptop` are on `Policy0` and leave through `Wireguard0`. "
          "Everything else keeps the default route.\n"
          "- **Smart home:** new segment `IoT` with Wi-Fi `Home-IoT` (password `kettle-orbit-58`) on its own "
          "VLAN and addresses. Devices on it reach the internet but not your home network, and it is listed "
          "in the web interface like any other segment.\n"
          "\n"
          "**Nothing is saved yet:** a reboot undoes all of it. The configuration from before is backed up. "
          "Connect something to `Home-IoT` and check the TV, then say the word and I'll save."), 7.5)

s.send("all good, save it", "Percolating")
s.call("save_config", "", SAVED, ("Percolating", "2s", "0.2k"), run=1.6)
s.bottom = ("done", "Cooked for 6s")
s.add(say("Saved. The VPN routing and the `IoT` network now survive a reboot."), 6.0)
s.save()
print(OUT, len(s.events), "frames", f"{s.t:.0f}s")
