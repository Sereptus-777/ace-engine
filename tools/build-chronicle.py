# ─── ACE Engine — turn a campaign into one readable chronicle ────────────────
#
# WHY THIS EXISTS. Johnny, 2026-08-21: "What I really want is one PDF that holds
# all of the adventures' story thus far, for each of these adventures and
# everybody they've talked to and everything they've done."
#
# The Session Logs journal folder could never be that. All fifteen entries in it
# are AI summaries of roughly 2,200 characters each, capped, so five months of
# play is compressed to about 32KB total and three of them are both called
# "Session 1". That is why they read as incomplete: they ARE incomplete, by
# design, and nothing was broken.
#
# The real record was never in the journals. It is ace-history.json: 1,503
# timestamped events, each with what happened, which scene it happened in and
# who did it. Deeds, kills, items gained and lost, every NPC conversation,
# narration, crits and fumbles. That is the campaign, and nothing had ever read
# it back out.
#
# ⚠️ READ ONLY. This never writes to the world, never deletes, never touches
# Foundry's database. It reads two files and writes new ones somewhere else.
#
# Usage:
#   python build-chronicle.py                 # every world that has ACE data
#   python build-chronicle.py hijinx          # just that one
import io, json, os, re, sys, html, datetime, collections

DATA  = r"D:\FoundryVTT\Data"
OUT   = r"C:\Users\johnp\OneDrive\Desktop\ACE Project\Chronicles"

# Map furniture, not story. 499 of the 1,503 events are tiles going down and
# coming back up; including them would bury the parts a person wants to read.
SKIP_KINDS = {"tile_placed", "tile_removed"}

LABEL = {
    "note":          "",
    "deed":          "Deed",
    "item_acquired": "Gained",
    "item_lost":     "Lost",
    "kill":          "Slain",
    "narration":     "",
    "combat_start":  "Battle begins",
    "combat_end":    "Battle ends",
    "crit":          "Critical hit",
    "fumble":        "Fumble",
    "session_summary": "Session summary",
    "scene":         "",
}


def when(t):
    if not t:
        return None
    return datetime.datetime.fromtimestamp(t if t < 1e11 else t / 1000)


def load(path):
    try:
        return json.load(io.open(path, encoding="utf-8"))
    except Exception:
        return None


def gather(world):
    base = os.path.join(DATA, "worlds", world, "ace-engine")
    hist = load(os.path.join(base, "ace-history.json"))
    if not hist or not hist.get("events"):
        return None

    events = [e for e in hist["events"] if e.get("k") not in SKIP_KINDS]
    events.sort(key=lambda e: e.get("t") or 0)

    # Cast and factions come from the live payload when it is present. It is not
    # required: the chronicle stands on the event log alone.
    payload = load(os.path.join(DATA, "ace-backups", "live", "payload.json"))
    # ⚠️ The live payload belongs to whichever world was open last. Using it for
    # a different world hands that world someone else's cast list, which is
    # exactly what happened on the first run: a ten-event test world was
    # credited with 475 characters from the real campaign. Check the identity.
    if payload and (payload.get("meta") or {}).get("worldId") != world:
        payload = None
    npcs, factions = [], []
    if payload:
        for j in payload.get("journals", []):
            if j.get("folderName") == "NPC Profiles":
                npcs.append(j.get("name", ""))
            elif j.get("folderName") == "Factions":
                factions.append(j.get("name", ""))
    # Who the player characters are, so the ledger is about people and not about
    # "Group Map Token" and a stray actor called "download".
    pcs = []
    if payload:
        for a in payload.get("actors", []):
            if a.get("type") == "character" and a.get("name"):
                pcs.append(a["name"])
    # ⚠️ THE NARRATIVE SPINE. Johnny asked whether ACE Engine keeps a record of
    # the adventure "somewhere we're not aware of". It does, and this is it:
    # AI-written session summaries in ace-world.json. They are what the Engine
    # reads when he asks it where the party should go next, which is why it has
    # always seemed to know. They belong at the FRONT of the chronicle, because
    # they are the only part written as a story rather than as a log.
    world_file = load(os.path.join(base, "ace-world.json")) or {}
    W = world_file.get("world", world_file)
    sessions = [x for x in (W.get("sessions") or []) if isinstance(x, dict) and x.get("summary")]
    sessions.sort(key=lambda x: (str(x.get("date") or ""), x.get("num") or 0))

    return {"world": world, "events": events, "npcs": sorted(set(npcs)),
            "factions": sorted(set(factions)), "pcs": sorted(set(pcs)),
            "sessions": sessions, "worldName": W.get("worldName") or world}


def by_day(events):
    days = collections.OrderedDict()
    for e in events:
        d = when(e.get("t"))
        key = d.strftime("%Y-%m-%d") if d else "undated"
        days.setdefault(key, []).append(e)
    return days


def spoken_with(events):
    """Everyone the party actually held a conversation with, in order met."""
    seen, order = set(), []
    for e in events:
        m = CONVO.search(e.get("txt") or "")
        if not m:
            continue
        # ⚠️ Group 2, the name AFTER "spoke with". The first version took the
        # name BEFORE it, so it listed Firaxis Greenbeard and Chudd Buckland,
        # Johnny's own player characters, as people the party had talked to, and
        # found nine. The real answer is fifty.
        who = m.group(2).strip()
        if who and who not in seen:
            seen.add(who)
            order.append((who, when(e.get("t"))))
    return order


CONVO = re.compile(r"\[NPC Conversation\]\s*(.+?)\s+spoke with\s+(.+?)\s+at\s+(.+?)\.\s*(.*)", re.S)


def _read(e):
    """(tag, text, actor) for one event, with conversation preambles unpacked."""
    raw = (e.get("txt") or "").strip()
    m = CONVO.search(raw)
    if m:
        speaker, other, _scene, summary = (x.strip() for x in m.groups())
        return (f"Spoke with {other}", summary or f"{speaker} spoke with {other}.", speaker)
    return (LABEL.get(e.get("k"), e.get("k") or ""), raw, e.get("a"))


def party_ledger(events):
    """
    Who did what, per character. GM eyes only.

    ⚠️ DESCRIPTIVE, NEVER A VERDICT. Johnny wondered whether "one guy keeps on
    getting ignored for healing or for loot". His own data says Jeth has 42
    deeds credited and 12 items received while Chudd has 20 deeds and 57 items.
    That MIGHT be unfair. It might equally mean Chudd carries the party stash
    and picks everything up. Nothing here labels anyone; it makes a five-month
    pattern visible and leaves the reading to the person who was at the table.
    """
    who = collections.defaultdict(lambda: collections.Counter())
    for e in events:
        a = e.get("a")
        if not a:
            continue
        # "Chudd Buckland, Firaxis Greenbeard" is a shared deed, not a person.
        for name in [n.strip() for n in str(a).split(",") if n.strip()]:
            k = e.get("k")
            if   k == "item_acquired": who[name]["loot"] += 1
            elif k == "kill":          who[name]["kills"] += 1
            elif k == "deed":          who[name]["deeds"] += 1
            elif k == "crit":          who[name]["crits"] += 1
            elif k == "fumble":        who[name]["fumbles"] += 1
    return who


def render_markdown(g):
    ev = g["events"]
    first, last = when(ev[0].get("t")), when(ev[-1].get("t"))
    out = [f"# {g.get('worldName') or g['world'].title()}", ""]
    out.append(f"*{first:%d %B %Y} to {last:%d %B %Y}. "
               f"{len(ev)} recorded moments across {len({e.get('s') for e in ev if e.get('s')})} places.*")
    out.append("")

    talked = spoken_with(ev)
    if talked:
        out += ["## Everyone they have spoken with", ""]
        for who, d in talked:
            out.append(f"- **{who}** — first spoken to {d:%d %B %Y}" if d else f"- **{who}**")
        out.append("")

    out += ["## The story, in order", ""]
    for day, items in by_day(ev).items():
        try:
            heading = f"{when(items[0]['t']):%A %d %B %Y}"
        except Exception:
            heading = day
        out += [f"### {heading}", ""]
        scene = None
        for e in items:
            s = e.get("s")
            if s and s != scene:
                scene = s
                out += [f"**{s}**", ""]
            tag, line, who = _read(e)
            if not line:
                continue
            prefix = f"*{tag}* " if tag else ""
            suffix = f"  \n  <sub>{who}</sub>" if who and who not in line else ""
            out.append(f"- {prefix}{line}{suffix}")
        out.append("")

    if g.get("sessions"):
        out += ["## The story so far", ""]
        for x in g["sessions"]:
            out += [f"### Session {x.get('num','?')} — {x.get('date','')}", ""]
            if x.get("scene"): out += [f"*{x['scene']}*", ""]
            out += [str(x.get("summary")).strip(), ""]

    led = party_ledger(ev)
    # ⚠️ Player characters only. A ledger listing "Group Map Token" beside a
    # real person is noise, and noise is how a useful view gets ignored.
    if g.get("pcs"):
        keep = {p.lower() for p in g["pcs"]}
        led = {k: v for k, v in led.items() if k.lower() in keep}
    if led:
        out += ["## The ledger", "",
                "*Descriptive, not a verdict. Loot counts may simply mean somebody carries the stash.*", "",
                "| | Deeds | Kills | Loot | Crits | Fumbles |", "|---|---|---|---|---|---|"]
        for name, c in sorted(led.items(), key=lambda kv: -(kv[1]["deeds"] + kv[1]["kills"] + kv[1]["loot"]))[:12]:
            out.append(f"| {name} | {c['deeds']} | {c['kills']} | {c['loot']} | {c['crits']} | {c['fumbles']} |")
        out.append("")

    if g["factions"]:
        out += ["## Factions in play", ""] + [f"- {f}" for f in g["factions"]] + [""]
    if g["npcs"]:
        out += ["## Every character on record", "",
                f"*{len(g['npcs'])} profiles.*", ""] + [f"- {n}" for n in g["npcs"]] + [""]
    return "\n".join(out)


def render_html(g):
    """Print-ready. Ctrl+P in any browser, Save as PDF, and it paginates cleanly."""
    ev = g["events"]
    first, last = when(ev[0].get("t")), when(ev[-1].get("t"))
    E = html.escape
    p = [f"""<!doctype html><html><head><meta charset="utf-8">
<title>{E(g['world'].title())} — Campaign Chronicle</title>
<style>
  @page {{ margin: 18mm 16mm; }}
  body {{ font: 11.5pt/1.6 Georgia, "Iowan Old Style", serif; color: #23201a;
         max-width: 46em; margin: 0 auto; padding: 2em 1.5em; background: #fff; }}
  h1 {{ font-size: 2.1em; margin: 0 0 .1em; letter-spacing: .01em; }}
  h2 {{ font-size: 1.35em; margin: 2.2em 0 .6em; padding-bottom: .25em;
        border-bottom: 2px solid #c9a84c; page-break-after: avoid; }}
  h3 {{ font-size: 1.05em; margin: 1.6em 0 .4em; color: #6b5626;
        page-break-after: avoid; }}
  .sub {{ color: #6b6355; font-style: italic; margin-bottom: 2em; }}
  .scene {{ font-variant: small-caps; letter-spacing: .06em; color: #8a6d2f;
            margin: 1.1em 0 .3em; font-weight: bold; page-break-after: avoid; }}
  ul {{ margin: .2em 0 .8em; padding-left: 1.2em; }}
  li {{ margin: .32em 0; page-break-inside: avoid; }}
  .tag {{ font-style: italic; color: #8a6d2f; }}
  .who {{ color: #7a7266; font-size: .88em; }}
  .cols {{ column-count: 2; column-gap: 2.2em; }}
  .tale {{ margin: .5em 0; text-align: justify; }}
  .tale strong {{ color: #6b5626; }}
  @media print {{ a {{ color: inherit; text-decoration: none; }} }}
</style></head><body>"""]
    p.append(f"<h1>{E(g.get('worldName') or g['world'].title())}</h1>")
    p.append(f"<p class='sub'>{first:%d %B %Y} to {last:%d %B %Y}. {len(ev)} recorded moments "
             f"across {len({e.get('s') for e in ev if e.get('s')})} places.</p>")

    talked = spoken_with(ev)
    if talked:
        p.append("<h2>Everyone they have spoken with</h2><ul class='cols'>")
        for who, d in talked:
            p.append(f"<li><strong>{E(who)}</strong>"
                     + (f" <span class='who'>{d:%d %b %Y}</span>" if d else "") + "</li>")
        p.append("</ul>")

    if g.get("sessions"):
        p.append("<h2>The story so far</h2>")
        for x in g["sessions"]:
            p.append(f"<h3>Session {E(str(x.get('num','?')))} &mdash; {E(str(x.get('date','')))}</h3>")
            if x.get("scene"):
                p.append(f"<div class='scene'>{E(str(x['scene']))}</div>")
            body = E(str(x.get("summary")).strip())
            body = body.replace("&lt;br&gt;", "<br>")
            for para in [b.strip() for b in body.split(chr(10)) if b.strip()]:
                p.append(f"<p class='tale'>{para}</p>")

    p.append("<h2>Every recorded moment, in order</h2>")
    for day, items in by_day(ev).items():
        try:
            heading = f"{when(items[0]['t']):%A %d %B %Y}"
        except Exception:
            heading = day
        p.append(f"<h3>{E(heading)}</h3>")
        scene, open_ul = None, False
        for e in items:
            line = _read(e)[1]
            if not line:
                continue
            s = e.get("s")
            if s and s != scene:
                if open_ul:
                    p.append("</ul>")
                    open_ul = False
                scene = s
                p.append(f"<div class='scene'>{E(s)}</div>")
            if not open_ul:
                p.append("<ul>")
                open_ul = True
            tag, line, who = _read(e)
            p.append("<li>"
                     + (f"<span class='tag'>{E(tag)}</span> " if tag else "")
                     + E(line)
                     + (f" <span class='who'>— {E(who)}</span>" if who and who not in line else "")
                     + "</li>")
        if open_ul:
            p.append("</ul>")

    if g["factions"]:
        p.append("<h2>Factions in play</h2><ul class='cols'>"
                 + "".join(f"<li>{E(f)}</li>" for f in g["factions"]) + "</ul>")
    if g["npcs"]:
        p.append(f"<h2>Every character on record</h2><p class='sub'>{len(g['npcs'])} profiles.</p>"
                 "<ul class='cols'>" + "".join(f"<li>{E(n)}</li>" for n in g["npcs"]) + "</ul>")
    p.append("</body></html>")
    return "\n".join(p)


def main():
    wanted = sys.argv[1:] or [w for w in os.listdir(os.path.join(DATA, "worlds"))
                              if os.path.isdir(os.path.join(DATA, "worlds", w))]
    os.makedirs(OUT, exist_ok=True)
    made = 0
    for world in wanted:
        g = gather(world)
        if not g:
            print(f"  {world}: no ACE history, skipped")
            continue
        md = os.path.join(OUT, f"{world}-chronicle.md")
        ht = os.path.join(OUT, f"{world}-chronicle.html")
        io.open(md, "w", encoding="utf-8").write(render_markdown(g))
        io.open(ht, "w", encoding="utf-8").write(render_html(g))
        ev = g["events"]
        print(f"  {world}: {len(ev)} moments, {len(spoken_with(ev))} spoken with, "
              f"{len(g['npcs'])} profiles")
        print(f"      {md}")
        print(f"      {ht}")
        made += 1
    print(f"\n{made} chronicle(s) written to {OUT}")
    print("For a PDF: open the .html, Ctrl+P, Save as PDF.")
    print("For a storyteller AI: feed it the .md.")


if __name__ == "__main__":
    main()
