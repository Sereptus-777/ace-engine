# ─── ACE Engine — the longest timeline the data can support ─────────────────
#
# Johnny, 2026-08-22: "Look everywhere for anything, for a story arc, because it
# could be hiding shit in different areas... Do a comprehensive search to get the
# longest, best timeline available."
#
# ⚠️ WHY THE FIRST CHRONICLE MISSED THINGS. build-chronicle.py reads exactly two
# files: ace-history.json and ace-world.json. That is a fraction of what the
# campaign has actually written down. The campfire where King entered the story
# is not in either of them, because ACE writes narrative into SEVEN separate
# stores plus the journals, and no single reader had ever looked at all of them.
#
# Sources merged here, with what each uniquely holds:
#
#   ace-history.json        1,530 events — the raw log, every kill and item
#   ace-world-events.json     194 events — magnitude, ripples, and NOUNS
#                                          (who/where/what), which the raw log
#                                          does not carry
#   ace-world.json            203 world notes + 12 session summaries — the only
#                                          prose written as a story
#   ace-deeds.json            109 deeds   — with session and in-world DAY
#   ace-scenes.json            51 scenes  — first visit, last visit, visit count
#                                          and per-visit events
#   ace-npcs.json             563 NPCs    — per-creature notes and appearances
#   payload journals          578 entries, 398KB — Session Logs, World Lore, PC
#                                          and NPC Profiles, the World Library
#
# ⚠️ EVERYTHING IS DEDUPED. The same sentence is often written to three stores;
# a timeline that repeats itself is worse than a short one. Matching is on
# normalised text, so trivial punctuation differences still collapse.
#
# ⚠️ NOTHING IS SUMMARISED AWAY. Johnny: "I want it in full text: the whole
# conversations, the whole interactions, plus a summary. Nobody is worried about
# hard drive space when it comes to stories."
import io, json, os, re, sys, html, datetime, collections

DATA = r"D:\FoundryVTT\Data"
OUT  = r"C:\Users\johnp\OneDrive\Desktop\ACE Project\Chronicles"

SKIP_KINDS = {"tile_placed", "tile_removed"}


def load(p):
    try:
        return json.load(io.open(p, encoding="utf-8"))
    except Exception:
        return None


def when(t):
    if not t:
        return None
    try:
        return datetime.datetime.fromtimestamp(t if t < 1e11 else t / 1000)
    except Exception:
        return None


def strip_html(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", str(s or ""))).strip()


def key(text):
    """Normalised, for dedupe. Punctuation and case must not create a twin."""
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())[:220]


def gather(world):
    base = os.path.join(DATA, "worlds", world, "ace-engine")
    rows, seen, sources = [], set(), collections.Counter()

    def add(t, kind, text, scene="", who="", src="", extra=None):
        text = strip_html(text)
        if len(text) < 3:
            return
        k = key(text)
        if k in seen:
            return
        seen.add(k)
        sources[src] += 1
        rows.append({"t": t or 0, "kind": kind, "text": text, "scene": scene or "",
                     "who": who or "", "src": src, "extra": extra or {}})

    # ── The prose, first, because it is the only part written as a story ────
    W = (load(os.path.join(base, "ace-world.json")) or {})
    W = W.get("world", W)
    sessions = [s for s in (W.get("sessions") or []) if s.get("summary")]

    # ── The world-event ledger: richest single source (nouns + magnitude) ───
    for e in ((load(os.path.join(base, "ace-world-events.json")) or {}).get("events") or []):
        n = e.get("nouns") or {}
        who = ", ".join(n.get("actors") or []) if isinstance(n, dict) else ""
        add(e.get("ts"), e.get("magnitude") or "event", e.get("summary"),
            e.get("scene"), who, "world-events",
            {"magnitude": e.get("magnitude"), "ripples": e.get("ripples"), "nouns": n})

    # ── Deeds: carry the in-world DAY and session number ────────────────────
    for d in ((load(os.path.join(base, "ace-deeds.json")) or {}).get("deeds") or []):
        add(d.get("timestamp"), "deed", d.get("text"), d.get("scene"),
            ", ".join(d.get("pcs") or []), "deeds",
            {"day": d.get("day"), "session": d.get("session"), "magnitude": d.get("magnitude")})

    # ── World notes ─────────────────────────────────────────────────────────
    for n in (W.get("worldNotes") or []):
        add(n.get("t"), n.get("category") or "note", n.get("txt"), n.get("s"), "", "world-notes")

    # ── The raw history log ─────────────────────────────────────────────────
    for e in ((load(os.path.join(base, "ace-history.json")) or {}).get("events") or []):
        if e.get("k") in SKIP_KINDS:
            continue
        txt = e.get("txt")
        if not txt:
            if e.get("k") == "kill":
                txt = f"{e.get('tgt','someone')} was slain" + (f" by {e['a']}" if e.get("a") else "")
            elif e.get("k") == "item_acquired":
                txt = f"{e.get('a','someone')} acquired {e.get('item','something')}"
            elif e.get("k") == "item_lost":
                txt = f"{e.get('a','someone')} lost {e.get('item','something')}"
            elif e.get("k") == "scene":
                txt = f"Moved from {e.get('from','?')} to {e.get('to','?')}"
            elif e.get("k") in ("combat_start", "combat_end"):
                txt = "Combat began" if e["k"] == "combat_start" else \
                      "Combat ended" + (f" ({', '.join(e['p'])})" if e.get("p") else "")
        add(e.get("t"), e.get("k"), txt, e.get("s"), e.get("a"), "history")

    # ── Per-creature notes ──────────────────────────────────────────────────
    N = load(os.path.join(base, "ace-npcs.json")) or {}
    for rec in (N.get("npcs", N) or {}).values():
        if not isinstance(rec, dict):
            continue
        for note in (rec.get("notes") or []):
            add(note.get("t"), "npc note", note.get("txt"), "",
                rec.get("displayName") or "", "npc-notes")

    # ── Scene visits: when they arrived somewhere, and how long they stayed ─
    S = load(os.path.join(base, "ace-scenes.json")) or {}
    for rec in (S.get("scenes") or {}).values():
        if not isinstance(rec, dict):
            continue
        name = rec.get("displayName") or ""
        for v in (rec.get("visits") or []):
            for ve in (v.get("events") or []):
                add(ve.get("t"), ve.get("k") or "scene event", ve.get("txt") or ve.get("note"),
                    name, "", "scene-visits")

    # ── The journals, which the first chronicle never opened ────────────────
    payload = load(os.path.join(DATA, "ace-backups", "live", "payload.json")) or {}
    journals = []
    if (payload.get("meta") or {}).get("worldId") == world:
        for j in payload.get("journals", []):
            body = " ".join(strip_html(p.get("text")) for p in (j.get("pages") or []))
            if len(body) < 40:
                continue
            journals.append({"folder": j.get("folderName") or "(root)",
                             "name": j.get("name") or "(untitled)", "text": body})

    rows.sort(key=lambda r: r["t"])
    return {"world": world, "worldName": W.get("worldName") or world,
            "rows": rows, "sessions": sessions, "journals": journals,
            "sources": sources}


# ── Rendering ───────────────────────────────────────────────────────────────
E = html.escape

CSS = """
@page { margin: 16mm 14mm; }
body { font: 11pt/1.55 Georgia,"Iowan Old Style",serif; color:#23201a; max-width:48em;
       margin:0 auto; padding:2em 1.5em; background:#fff; }
h1 { font-size:2.2em; margin:0 0 .1em; }
h2 { font-size:1.3em; margin:2em 0 .5em; padding-bottom:.2em;
     border-bottom:2px solid #c9a84c; page-break-after:avoid; }
h3 { font-size:1.02em; margin:1.4em 0 .3em; color:#6b5626; page-break-after:avoid; }
.sub { color:#6b6355; font-style:italic; }
.scene { font-variant:small-caps; letter-spacing:.06em; color:#8a6d2f; font-weight:bold;
         margin:1em 0 .25em; page-break-after:avoid; }
ul { margin:.2em 0 .7em; padding-left:1.15em; }
li { margin:.28em 0; page-break-inside:avoid; }
.tag { font-style:italic; color:#8a6d2f; }
.who { color:#7a7266; font-size:.88em; }
.tale { margin:.45em 0; text-align:justify; }
.src { color:#b0a892; font-size:.75em; }
table { border-collapse:collapse; margin:.5em 0 1em; font-size:.92em; }
td,th { border:1px solid #ddd6c2; padding:3px 9px; text-align:left; }
th { background:#f4efe2; }
.jrn { page-break-inside:avoid; margin:0 0 1.2em; }
"""


def render(g):
    rows, out = g["rows"], []
    dated = [r for r in rows if r["t"]]
    first, last = when(dated[0]["t"]), when(dated[-1]["t"])
    out.append(f"<style>{CSS}</style>")
    out.append(f"<h1>{E(g['worldName'])}</h1>")
    out.append(f"<p class='sub'>{first:%d %B %Y} to {last:%d %B %Y}. "
               f"{len(rows):,} distinct recorded moments, merged from every store ACE writes to.</p>")

    out.append("<h2>Where all of this came from</h2><table><tr><th>Source</th><th>Entries kept</th></tr>")
    for s, c in g["sources"].most_common():
        out.append(f"<tr><td>{E(s)}</td><td>{c:,}</td></tr>")
    out.append(f"<tr><th>total after removing duplicates</th><th>{len(rows):,}</th></tr></table>")

    if g["sessions"]:
        out.append("<h2>The story, as it was written down</h2>")
        for s in g["sessions"]:
            out.append(f"<h3>Session {E(str(s.get('num','?')))} &mdash; {E(str(s.get('date','')))}</h3>")
            if s.get("scene"):
                out.append(f"<div class='scene'>{E(str(s['scene']))}</div>")
            for para in [p.strip() for p in strip_html(s['summary']).split("  ") if p.strip()]:
                out.append(f"<p class='tale'>{E(para)}</p>")

    out.append("<h2>Everything, in order</h2>")
    day = scene = None
    open_ul = False
    for r in rows:
        d = when(r["t"])
        dk = f"{d:%A %d %B %Y}" if d else "undated"
        if dk != day:
            if open_ul: out.append("</ul>"); open_ul = False
            day, scene = dk, None
            out.append(f"<h3>{E(dk)}</h3>")
        if r["scene"] and r["scene"] != scene:
            if open_ul: out.append("</ul>"); open_ul = False
            scene = r["scene"]
            out.append(f"<div class='scene'>{E(scene)}</div>")
        if not open_ul:
            out.append("<ul>"); open_ul = True
        tag = "" if r["kind"] in ("note", "narration", "event") else f"<span class='tag'>{E(r['kind'])}</span> "
        who = f" <span class='who'>&mdash; {E(r['who'])}</span>" if r["who"] and r["who"] not in r["text"] else ""
        out.append(f"<li>{tag}{E(r['text'])}{who}</li>")
    if open_ul: out.append("</ul>")

    if g["journals"]:
        by = collections.defaultdict(list)
        for j in g["journals"]: by[j["folder"]].append(j)
        out.append("<h2>The journals, in full</h2>")
        out.append("<p class='sub'>Every journal with real content, complete and unabridged. "
                   "These carry no timestamps, so they cannot be placed on the timeline above.</p>")
        for folder in sorted(by):
            out.append(f"<h3>{E(folder)} &mdash; {len(by[folder])} entries</h3>")
            for j in sorted(by[folder], key=lambda x: x["name"]):
                out.append(f"<div class='jrn'><div class='scene'>{E(j['name'])}</div>")
                for para in [p.strip() for p in j["text"].split("  ") if p.strip()]:
                    out.append(f"<p class='tale'>{E(para)}</p>")
                out.append("</div>")
    return "\n".join(out)


def main():
    worlds = sys.argv[1:] or [w for w in os.listdir(os.path.join(DATA, "worlds"))
                              if os.path.isdir(os.path.join(DATA, "worlds", w))]
    os.makedirs(OUT, exist_ok=True)
    for world in worlds:
        g = gather(world)
        if not g or not g["rows"]:
            print(f"  {world}: nothing to build from")
            continue
        p = os.path.join(OUT, f"{world}-FULL-TIMELINE.html")
        io.open(p, "w", encoding="utf-8").write(render(g))
        print(f"  {world}: {len(g['rows']):,} moments · {len(g['sessions'])} sessions · "
              f"{len(g['journals'])} journals")
        for s, c in g["sources"].most_common():
            print(f"       {c:>6,}  {s}")
        print(f"      -> {p}  ({os.path.getsize(p)//1024} KB)")


if __name__ == "__main__":
    main()
