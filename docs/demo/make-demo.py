"""Render recorded Claude Code sessions into one animated SVG carousel.

Each scene is a real interactive session recorded with rec.py (asciicast v2 from a pty),
replayed through the pyte terminal emulator, so the UI is exactly what Claude Code drew.
Only frames whose content changed are kept, and long waits are compressed.

usage: python make-demo.py SCENES.json OUT.svg [--frame=T]   (T: freeze at T seconds, for previews)
SCENES.json: {"cols": 100, "rows": 34, "scenes": [{"tab": "Push gate", "cast": "x.cast",
              "subs": [["from", "to"], ...], "cut": [[t0, t1], ...], "hold": 5}]}
"""
import html, json, re, sys
import pyte

CFG = json.load(open(sys.argv[1]))
ONLY = next((int(a.split("=")[1]) for a in sys.argv if a.startswith("--scene=")), None)
if ONLY is not None:                       # one scene per file: no tab bar
    CFG["scenes"] = [CFG["scenes"][ONLY - 1]]
OUT = sys.argv[2]
FRAME = next((float(a.split("=")[1]) for a in sys.argv if a.startswith("--frame=")), None)
COLS, ROWS = CFG["cols"], CFG["rows"]

FS = 14.0                  # font size
CW = FS * 0.6              # cell width of the monospace font
LH = 19.0                  # line height
PAD = 18
BAR = 34                   # window title bar
TABS = 54 if len(CFG["scenes"]) > 1 else 0   # carousel tabs above the window
WIN_W = COLS * CW + 2 * PAD
WIN_H = BAR + ROWS * LH + 2 * PAD - 6
W, H = WIN_W, TABS + WIN_H

BG, FG = "#1a1a19", "#e8e6e3"
ANSI = {"black": "#1a1a19", "red": "#ff6b6b", "green": "#4eba65", "brown": "#e5c07b", "yellow": "#e5c07b",
        "blue": "#61afef", "magenta": "#c678dd", "cyan": "#56b6c2", "white": "#d0d0d0",
        "brightblack": "#808080", "brightred": "#ff8787", "brightgreen": "#87d787", "brightbrown": "#ffd787",
        "brightyellow": "#ffd787", "brightblue": "#87afff", "brightmagenta": "#d787ff", "brightcyan": "#87d7d7",
        "brightwhite": "#ffffff"}
ORANGE = "#d77757"


class Screen(pyte.Screen):
    """pyte has no faint (SGR 2); carry it in the unused `blink` attribute."""
    def select_graphic_rendition(self, *attrs, private=False):
        if private:
            return
        mapped, i = [], 0
        while i < len(attrs):
            a = attrs[i]
            if a in (38, 48) and i + 1 < len(attrs):     # extended colors: copy verbatim
                n = 3 if attrs[i + 1] == 5 else 5 if attrs[i + 1] == 2 else 2
                mapped += list(attrs[i:i + n]); i += n; continue
            mapped += [5] if a == 2 else [22, 25] if a == 22 else [a]
            i += 1
        super().select_graphic_rendition(*mapped)


def color(c, default):
    if c == "default":
        return default
    if re.fullmatch(r"[0-9a-fA-F]{6}", c):
        return "#" + c.lower()
    return ANSI.get(c, default)


def snapshot(screen, subs):
    """Rows as tuples of runs: (text, fg, bg, bold, italic, dim, underline)."""
    rows = []
    for y in range(ROWS):
        line = screen.buffer[y]
        runs, cur, txt = [], None, ""
        for x in range(COLS):
            ch = line[x]
            fg, bg = color(ch.fg, FG), color(ch.bg, None)
            if ch.reverse:
                fg, bg = (bg or BG), fg
            st = (fg, bg, ch.bold, ch.italics, ch.blink, ch.underscore)
            if st != cur:
                if txt:
                    runs.append((txt,) + cur)
                cur, txt = st, ""
            txt += ch.data or " "
        if txt:
            runs.append((txt,) + cur)
        # trailing spaces with no background carry nothing
        while runs and runs[-1][0].strip() == "" and runs[-1][2] is None:
            runs.pop()
        if runs and runs[-1][2] is None:
            runs[-1] = (runs[-1][0].rstrip(),) + runs[-1][1:]
        rows.append(tuple(runs))
    text = ["".join(r[0] for r in row) for row in rows]
    # The slash-command menu lists the recording machine's own commands: drop it.
    menu = [i for i, t in enumerate(text) if re.match(r"^\s+(❯ )?/[a-z][\w:-]*( \(\w+\))?\s{2,}", t)]
    if len(menu) >= 3:
        for i in range(menu[0], ROWS):
            rows[i] = ()
    for i, t in enumerate(text):
        if "�" in t and t.count("─") > 20:      # a box rule split across two reads
            rows[i] = tuple((r[0].replace("�", "─"),) + r[1:] for r in rows[i])
    # A long path that wrapped onto the next row: join it there, then substitute.
    wraps = CFG.get("wraps", [])
    rows = list(rows)
    for i in range(ROWS - 1):
        line = "".join(r[0] for r in rows[i]).rstrip()
        nxt = "".join(r[0] for r in rows[i + 1])
        for a, b, rep in wraps:
            if line.endswith(a) and nxt.lstrip().startswith(b):
                rest = nxt.rstrip().lstrip()[len(b):]
                cells = [(ch, r[1:]) for r in rows[i] for ch in r[0]][:len(line)]
                st = cells[len(line) - len(a)][1]
                cells = cells[:len(line) - len(a)] + [(ch, st) for ch in rep + rest]
                rows[i + 1] = ()
                # The terminal wrapped that row too: pull its continuation up as well.
                if len(nxt.rstrip()) >= COLS - 12 and i + 2 < ROWS:
                    more = "".join(r[0] for r in rows[i + 2]).strip()
                    if more and not more.startswith("…") and len(cells) + len(more) <= COLS:
                        cells += [(ch, st) for ch in more]
                        rows[i + 2] = ()
                rows[i] = tuple((c, ) + s_ for c, s_ in cells)
                break
    out = []
    for row in rows:
        cells = [(ch, r[1:]) for r in row for ch in r[0]]
        line = "".join(c for c, _ in cells)
        for a, b in subs:
            if a.startswith("re:"):                 # regex substitution
                pos = 0
                while True:
                    m = re.compile(a[3:]).search(line, pos)
                    if not m or m.end() == m.start():
                        break
                    st = cells[m.start()][1]
                    cells[m.start():m.end()] = [(ch, st) for ch in b]
                    line = "".join(c for c, _ in cells)
                    pos = m.start() + len(b)
                continue
            k = line.find(a)
            while k >= 0:
                st = cells[k][1] if k < len(cells) else cells[-1][1]
                cells[k:k + len(a)] = [(ch, st) for ch in b]
                line = "".join(c for c, _ in cells)
                k = line.find(a, k + len(b))
        new, cur, txt = [], None, ""
        for ch, st in cells:
            if st != cur:
                if txt:
                    new.append((txt,) + cur)
                cur, txt = st, ""
            txt += ch
        if txt:
            new.append((txt,) + cur)
        out.append(tuple(new))
    return out


SPIN = re.compile(r"^[·✢✳✶✻✽*]\s.+…")


def frames(scene):
    lines = open(scene["cast"]).read().splitlines()[1:]
    screen = Screen(COLS, ROWS)
    stream = pyte.Stream(screen)
    subs = scene.get("subs", [])
    cuts = scene.get("cut", [])
    out, last_key = [], None
    for l in lines:
        t, _, data = json.loads(l)
        # pyte ignores the ">" of CSI > … sequences (xterm key modes) and would read
        # CSI > 4 m as "underline"; they carry no screen content, so drop them.
        stream.feed(re.sub(r"\x1b\[>[0-9;]*[A-Za-z]", "", data))
        if any(a <= t < b for a, b in cuts):
            continue
        snap = snapshot(screen, subs)
        text = ["".join(r[0] for r in row) for row in snap]
        # Spinner, timers and token counters tick every second; a frame that changes
        # only those adds nothing to watch.
        key = tuple(x for x in text if not (SPIN.match(x.strip()) or "tokens" in x or "Waiting for" in x))
        if key == last_key:
            continue
        last_key = key
        out.append((t, snap, text))
    return out


def timeline(fr, hold, read_cps=380.0, cap=1.3):
    """Demo duration per kept frame. Typing runs at a fixed brisk pace, streaming at
    recorded speed, long waits shrink hard, and at each pause the viewer gets a short
    moment to read what appeared since the last one."""
    durs, unread = [], 0
    for i, (t, snap, text) in enumerate(fr):
        prev = set(fr[i - 1][2]) if i else set()
        unread += sum(len(x.strip()) for x in text if x not in prev)
        if i + 1 == len(fr):
            durs.append(hold)
            continue
        gap = fr[i + 1][0] - t
        if gap < 0.1:            # typing
            d = 0.018
        elif gap < 0.25:         # streaming
            d = gap * 0.6
        else:
            d = min(max(gap * 0.06, 0.12), 0.35)
            if gap >= 0.8:
                d = max(d, min(cap, unread / read_cps))
                unread = 0
        durs.append(d)
    return durs


def smooth(fr, durs, floor=0.07):
    """Fold frames shorter than `floor` into the next one, so nothing flickers; typing
    keeps every second keystroke."""
    out_f, out_d, carry = [], [], 0.0
    for k, (f, d) in enumerate(zip(fr, durs)):
        last = k + 1 == len(fr)
        typing = d <= 0.02
        if not last and d + carry < floor and not (typing and k % 2 == 0):
            carry += d
            continue
        out_f.append(f); out_d.append(d + carry); carry = 0.0
    return out_f, out_d


BLOCKS = {"█": "1111", "▀": "1100", "▄": "0011", "▌": "1010", "▐": "0101", "▘": "1000", "▝": "0100",
          "▖": "0010", "▗": "0001", "▛": "1110", "▜": "1101", "▙": "1011", "▟": "0111", "▚": "1001", "▞": "0110"}


# Claude's spinner glyphs, drawn so they don't depend on the font: (arms, radius).
STARS = {"✢": (4, 5.0), "✳": (4, 5.4), "✶": (6, 5.0), "✻": (6, 5.6), "✽": (8, 5.4)}


def star(cx, cy, spec, color):
    import math
    arms, r = spec
    d = " ".join(f"M{cx - r * math.cos(a):.1f} {cy - r * math.sin(a):.1f}L{cx + r * math.cos(a):.1f} {cy + r * math.sin(a):.1f}"
                 for a in (k * math.pi / arms for k in range(arms)))
    return f'<path d="{d}" stroke="{color}" stroke-width="1.9" stroke-linecap="round"/>'


def esc(s):
    return html.escape(s, quote=False)


def row_svg(y, runs):
    """One screen row: background rects, block glyphs as rects, text as positioned tspans."""
    base = BAR + PAD + y * LH
    rects, spans, col = [], [], 0
    for txt, fg, bg, bold, italic, dim, under in runs:
        x = PAD + col * CW
        if bg:
            rects.append(f'<rect x="{x:.1f}" y="{base:.1f}" width="{len(txt) * CW:.1f}" height="{LH:.1f}" fill="{bg}"/>')
        chunk, cx = "", col
        def flush():
            # Each run of non-space text gets its own x, so no renderer can collapse
            # or mis-measure the spaces between them.
            nonlocal chunk
            start = cx - len(chunk)
            for m in re.finditer(r"\S+(?: \S+)*", chunk):
                a = f' fill="{fg}"'
                if bold: a += ' font-weight="700"'
                if italic: a += ' font-style="italic"'
                if dim: a += ' opacity="0.6"'
                if under: a += ' text-decoration="underline"'
                spans.append(f'<tspan x="{PAD + (start + m.start()) * CW:.1f}"{a}>{esc(m.group())}</tspan>')
            chunk = ""
        for ch in txt:
            q = BLOCKS.get(ch)
            if ch in STARS:
                flush()
                rects.append(star(PAD + cx * CW + CW / 2, base + LH / 2, STARS[ch], fg))
                cx += 1
                continue
            if q:
                flush()
                hw, hh = CW / 2, LH / 2
                for k, on in enumerate(q):
                    if on == "1":
                        rects.append(f'<rect x="{PAD + cx * CW + (k % 2) * hw:.1f}" y="{base + (k // 2) * hh:.1f}" width="{hw + 0.3:.1f}" height="{hh + 0.3:.1f}" fill="{fg}"/>')
            else:
                chunk += ch
            cx += 1
            if q:
                chunk = ""
        flush()
        col += len(txt)
    ty = base + LH * 0.74
    text = f'<text y="{ty:.1f}" xml:space="preserve">{"".join(spans)}</text>' if spans else ""
    return "".join(rects) + text


# ------------------------------------------------------------------ build
scenes = []
FORBID = [re.compile(x) for x in CFG.get("forbid", [])]
for sc in CFG["scenes"]:
    fr = frames(sc)
    leaks = sorted({x for _, _, text in fr for x in text if any(f.search(x) for f in FORBID)})
    for x in leaks[:12]:
        print("LEAK", sc["tab"], "|", x.strip(), file=sys.stderr)
    durs = timeline(fr, sc.get("hold", 5), sc.get("read_cps", 380.0), sc.get("cap", 1.3))
    fr, durs = smooth(fr, durs)
    scenes.append((sc, fr, durs))
total = sum(sum(d) for _, _, d in scenes)


def pct(t):
    return max(0.0, min(100.0, t / total * 100))


css, body = [], []
interval_class = {}


FADE = 0.18           # seconds a new transcript row takes to appear


def cls_for(intervals):
    """A CSS class that shows an element during its intervals: [start, end] or
    [start, end, fade]. Rows switch off instantly (steps), so frames never blend; a new
    transcript row may fade in, with the easing set on that one keyframe only."""
    key = tuple((round(iv[0], 2), round(iv[1], 2), bool(iv[2]) if len(iv) > 2 else False) for iv in intervals)
    if key not in interval_class:
        name = f"v{len(interval_class)}"
        interval_class[key] = name
        if FRAME is not None:
            on = any(a <= FRAME < b for a, b, _ in key)
            css.append(f".{name}{{opacity:{1 if on else 0}}}")
        else:
            stops = {0.0: (0, "")}
            for a, b, fade in key:
                pa, pb = round(pct(a), 3), round(pct(b), 3)
                if fade and b - a > FADE * 1.5:
                    stops[pa] = (0, "linear")
                    stops[round(pct(a + FADE), 3)] = (1, "")
                else:
                    stops[pa] = (1, "")
                stops[pb] = (0, "")
            stops.setdefault(100.0, (0, ""))
            body_ = "".join(f"{k:.3f}%{{opacity:{v}{';animation-timing-function:' + tf if tf else ''}}}"
                            for k, (v, tf) in sorted(stops.items()))
            css.append(f"@keyframes {name}{{{body_}}}.{name}{{opacity:0;animation:{name} {total:.2f}s steps(1,end) infinite}}")
    return interval_class[key]


# window chrome
wy = TABS
body.append(f'<rect x="0" y="{wy}" width="{W:.0f}" height="{WIN_H:.0f}" rx="12" fill="{BG}"/>')
body.append(f'<path d="M0 {wy + 12} A12 12 0 0 1 12 {wy} H{W - 12:.0f} A12 12 0 0 1 {W:.0f} {wy + 12} V{wy + BAR} H0 Z" fill="#2a2a28"/>')
for j, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
    body.append(f'<circle cx="{20 + j * 20}" cy="{wy + 17}" r="6" fill="{c}"/>')
body.append(f'<text x="{W / 2:.0f}" y="{wy + 22}" fill="#9a9a96" font-size="13" text-anchor="middle" class="ui">✳ Claude Code</text>')

# tabs: active pill with a progress fill
n = len(scenes)
gap = 8
tw = (W - gap * (n - 1)) / n
t0 = 0.0
for i, (sc, fr, durs) in enumerate(scenes if TABS else []):
    d = sum(durs)
    x = i * (tw + gap)
    body.append(f'<rect x="{x:.1f}" y="6" width="{tw:.1f}" height="34" rx="17" fill="#2a2a28"/>')
    if FRAME is None:
        name = f"tab{i}"
        a, b = pct(t0), pct(t0 + d)
        css.append(f"@keyframes {name}{{0%,{a:.3f}%{{transform:scaleX(0)}}{b:.3f}%{{transform:scaleX(1)}}{min(b + 0.001, 100):.3f}%,100%{{transform:scaleX(0)}}}}"
                   f".{name}{{transform-box:fill-box;transform-origin:left;transform:scaleX(0);animation:{name} {total:.2f}s linear infinite}}")
        css.append(f"@keyframes {name}o{{0%{{opacity:0}}{a:.3f}%{{opacity:1}}{b:.3f}%{{opacity:0}}100%{{opacity:0}}}}"
                   f".{name}o{{opacity:0;animation:{name}o {total:.2f}s steps(1,end) infinite}}")
        body.append(f'<g class="{name}o"><rect x="{x:.1f}" y="6" width="{tw:.1f}" height="34" rx="17" fill="#3a2a23"/>'
                    f'<rect class="{name}" x="{x:.1f}" y="6" width="{tw:.1f}" height="34" rx="17" fill="{ORANGE}" opacity="0.35"/></g>')
    elif t0 <= FRAME < t0 + d:
        body.append(f'<rect x="{x:.1f}" y="6" width="{tw * (FRAME - t0) / d:.1f}" height="34" rx="17" fill="{ORANGE}" opacity="0.35"/>')
    body.append(f'<text x="{x + tw / 2:.1f}" y="28" fill="#e8e6e3" font-size="13.5" text-anchor="middle" class="ui">'
                f'<tspan fill="{ORANGE}" font-weight="700">{i + 1}</tspan>  {esc(sc["tab"])}</text>')
    t0 += d

# ------------------------------------------------------------------ rows
# The transcript (everything above the spinner and the prompt box) lives in document
# coordinates and scrolls smoothly from frame to frame, the way a terminal does; the
# bottom chrome stays put and covers whatever scrolls under it.
RULE = re.compile(r"^─{60,}$")


def boundary(text):
    """Row where the bottom chrome starts: the dialog or prompt box, plus the spinner above it."""
    rules = [i for i, x in enumerate(text) if RULE.match(x.strip())]
    if not rules:
        return ROWS
    top = None
    for i in rules:                                     # a question dialog
        if i + 1 < ROWS and re.match(r"^\s*←", text[i + 1]):
            top = i
            break
    if top is None:
        top = rules[-2] if len(rules) >= 2 else rules[-1]
    j = top - 1
    while j >= 0 and top - j <= 3:                      # spinner / waiting / done line
        x = text[j].strip()
        if x and (SPIN.match(x) or x.startswith(("✻", "✢", "✳", "✶", "✽", "·", "*")) or "Waiting for" in x):
            top = j
            break
        j -= 1
    return top


def shift(prev, cur):
    """How many rows the transcript moved up between two frames (negative: down)."""
    best, best_d = 0, 0
    for d in range(-len(cur), len(prev)):
        m = sum(1 for i, x in enumerate(cur) if x.strip() and 0 <= i + d < len(prev) and prev[i + d] == x)
        if m > best or (m == best and abs(d) < abs(best_d)):
            best, best_d = m, d
    return best_d, best


SCROLL = 0.3           # seconds a scroll takes
t0 = 0.0
doc_rows, chrome_rows, bg_rows = [], [], []
scroll_stops = []      # (time, offset in rows)
offset = 0
for sc, fr, durs in scenes:
    seen_doc, seen_chrome, seen_bg = {}, {}, {}
    frame_doc = {}       # frame start time -> {doc line: runs}
    prev = None
    prev_t = None
    t = t0
    for (rt, snap, text), d in zip(fr, durs):
        b = boundary(text)
        cur = text[:b]
        if prev is not None:
            dd, matches = shift(prev, cur)
            if matches < 2 and any(x.strip() for x in cur):
                dd = len(prev) + ROWS                   # a different screen: jump, don't slide
                scroll_stops += [(t, offset), (t + 0.001, offset + dd)]
            else:
                scroll_stops += [(t, offset), (t + min(SCROLL, d * 0.8), offset + dd)]
            offset += dd
        else:
            scroll_stops += [(t, offset)]
        prev = cur
        def mark(store, key, fade=False):
            iv = store.setdefault(key, [])
            if iv and abs(iv[-1][1] - t) < 1e-6:
                iv[-1][1] = t + d
            else:
                iv.append([t, t + d, fade])
        before = frame_doc.get(prev_t, {}) if prev_t is not None else None
        frame_doc[round(t, 6)] = {offset + y: snap[y] for y in range(b)}
        for y in range(b):
            if snap[y]:
                # fade in only rows on a line that was empty: new output, not a row
                # that changes in place (a spinner, a counter, a streaming line)
                new_line = before is not None and not before.get(offset + y)
                mark(seen_doc, (offset + y, snap[y]), new_line)
        for y in range(b, ROWS):
            if snap[y]:
                mark(seen_chrome, (y, snap[y]))
        mark(seen_bg, b)
        prev_t = round(t, 6)
        t += d
    # A row that scrolls out stays drawn while the scroll runs, unless something else
    # takes its line, so the top of the window never blanks mid-scroll.
    for (y, runs), iv in seen_doc.items():
        for seg_ in iv:
            nxt = frame_doc.get(round(seg_[1], 6))
            if nxt is not None and not nxt.get(y):
                seg_[1] += SCROLL
    for (y, runs), iv in seen_doc.items():
        el = row_svg(y, runs)
        if el:
            doc_rows.append(f'<g class="{cls_for(iv)}">{el}</g>')
    for (y, runs), iv in seen_chrome.items():
        el = row_svg(y, runs)
        if el:
            chrome_rows.append(f'<g class="{cls_for(iv)}">{el}</g>')
    for b, iv in seen_bg.items():
        if b < ROWS:
            top = BAR + PAD + b * LH
            bg_rows.append(f'<rect class="{cls_for(iv)}" x="0" y="{top:.1f}" width="{W:.0f}" height="{WIN_H - top - 4:.1f}" fill="{BG}"/>')
    t0 = t

if FRAME is not None:
    off = 0
    for tt, o in scroll_stops:
        if tt <= FRAME:
            off = o
    scroll_css = f".scroll{{transform:translateY({-off * LH:.1f}px)}}"
else:
    stops = {}
    for tt, o in scroll_stops:
        stops[round(pct(tt), 3)] = o
    stops.setdefault(0.0, 0)
    stops.setdefault(100.0, scroll_stops[-1][1])
    kf = "".join(f"{k:.3f}%{{transform:translateY({-o * LH:.1f}px)}}" for k, o in sorted(stops.items()))
    scroll_css = (f"@keyframes scroll{{{kf}}}"
                  f".scroll{{animation:scroll {total:.2f}s cubic-bezier(.25,.8,.25,1) infinite}}")
css.append(scroll_css)
clip_top = BAR + 4
body.append(f'<defs><clipPath id="term"><rect x="0" y="{wy + clip_top}" width="{W:.0f}" height="{WIN_H - clip_top - 6:.1f}"/></clipPath></defs>')
body.append(f'<g clip-path="url(#term)"><g transform="translate(0 {wy})" class="m"><g class="scroll">' + "".join(doc_rows) + "</g></g>"
            f'<g transform="translate(0 {wy})" class="m">' + "".join(bg_rows) + "".join(chrome_rows) + "</g></g>")

css.insert(0, f'.m{{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono",monospace;font-size:{FS}px;white-space:pre}}'
              '.ui{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}')
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" viewBox="0 0 {W:.0f} {H:.0f}" role="img" aria-labelledby="dt dd">'
       f'<title id="dt">{esc(CFG.get("title", "Claude Code session"))}</title><desc id="dd">{esc(CFG.get("desc", ""))}</desc>'
       f'<style>{"".join(css)}</style>' + "".join(body) + "</svg>\n")
open(OUT, "w").write(svg)
print(OUT, f"{len(svg) // 1024} KB", f"{total:.1f}s", [len(f) for _, f, _ in scenes], f"classes={len(interval_class)}")
