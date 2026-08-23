# ─── ACE Engine — the story pack ─────────────────────────────────────────────
#
# Johnny, 2026-08-22: "are there any other sources I can give Gemini Notebook
# here to create the story... to make it become more alive?"
#
# NotebookLM does its best work with SEVERAL FOCUSED SOURCES, not one blob. A
# single 616KB timeline forces it to answer every question from the same
# undifferentiated pile. Five documents that each answer a different question —
# what happened, who is in it, where it happened, what the world is, what was
# written down — let it cite the right one and cross-reference between them.
#
# ⚠️ WHAT THIS FOUND. ACE has been COUNTING, not REMEMBERING. There are 563
# creature records carrying 18 pieces of narrative prose between them. Varek
# Thalor has been "met" 638 times and almost nothing is recorded about any of
# them. The narrative that DOES exist lives in three places nothing ever read
# together: 12 session summaries, 203 world notes, and 194 world events.
#
# Sources, in order of how much story they actually carry:
#   ace-world.json      sessions[]   — 12 full session summaries. The spine.
#                       worldNotes[] — 203 dated notes, real prose.
#   ace-world-events.json            — 194 events with magnitude and ripples.
#   ace-history.json                 — 1,530 raw events (mostly counters).
#   ace-npcs.json                    — 563 creatures: met, killed, scenes.
#   ace-scenes.json                  — 51 places with visit logs and who was there.
#   ace-world-bible.json             — 37 regions, 11 factions, 40 deities.
#   payload.json                     — 578 journals, full text.
import io
import json
import os
import re
from datetime import datetime, timezone

ENGINE = r"D:\FoundryVTT\Data\worlds\hijinx\ace-engine"
LIVE = r"D:\FoundryVTT\Data\ace-backups\live\payload.json"
OUT = r"C:\Users\johnp\OneDrive\Desktop\ACE FULL HISTORY\05 STORY PACK (for NotebookLM)"

TAG_RE = re.compile(r"<[^>]*>")
WS_RE = re.compile(r"[ \t]+")


def load(name):
    path = os.path.join(ENGINE, name)
    try:
        return json.load(io.open(path, encoding="utf-8"))
    except Exception as exc:
        print(f"   ! {name}: {exc}")
        return {}


def when(ts):
    """A timestamp in this data may be seconds or milliseconds. Both appear."""
    if not ts:
        return None
    ts = float(ts)
    if ts > 1e11:
        ts /= 1000.0
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def day(ts):
    d = when(ts)
    return d.strftime("%Y-%m-%d") if d else "undated"


def clean(html):
    if not html:
        return ""
    text = TAG_RE.sub(" ", str(html))
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
                .replace("&#39;", "'"))
    text = WS_RE.sub(" ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def write(name, body):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    io.open(path, "w", encoding="utf-8").write(body)
    print(f"   {os.path.getsize(path):>9,}  {name}")
    return path


# ══ 1. THE CHRONICLE — what happened, in order ══════════════════════════════
#
# ⚠️ THE FIRST VERSION OF THIS THREW AWAY MOST OF THE STORY. It read the `txt`
# field and nothing else, so 1,060 of the 1,530 history events were skipped for
# being "empty" — 75 kills, 174 things picked up, 27 critical hits, 15 fumbles,
# 123 journeys between places and every fight starting and ending. None of those
# carry a sentence. They carry an actor, a target, a weapon and a place, and the
# sentence has to be written from them.
#
# ⚠️ history and worldNotes hold THE SAME RECORDS. Notes are copied into
# history, so every note was landing twice. Deduplication has to compare the
# text itself, not the formatted line, or the dates and the trailing scene
# labels make two copies of one moment look different.

# Dice results are mechanics, not story.
ROLL_NOISE = re.compile(r"^\s*(subtle\s+(batch\s+)?roll|batch roll)\b", re.I)

# A creature "losing" its own fists is inventory churn, not a plot point.
NOT_LOOT = re.compile(r"^(unarmed strike|claws?|bite|slam|tail|talons?|fists?|"
                      r"tentacle|gore|hooves|sting|multiattack)\b", re.I)


def _sentence(e):
    """Turn one structured history event into a line of English, or None."""
    k = e.get("k")
    who = e.get("a") or ""
    tgt = e.get("tgt") or ""
    item = e.get("item") or ""
    weapon = e.get("w") or ""

    if k in ("tile_placed", "tile_removed"):
        return None                       # map dressing, not narrative
    if k == "session_summary":
        return None                       # the real summaries live in ace-world.json

    if k == "kill":
        if not tgt:
            return None
        return (f"**{who}** killed **{tgt}**." if who
                else f"**{tgt}** was killed.")
    if k == "item_acquired":
        if not item or NOT_LOOT.match(item):
            return None
        return f"**{who or 'The party'}** took possession of *{item}*."
    if k == "item_lost":
        if not item or NOT_LOOT.match(item):
            return None
        return f"**{who or 'The party'}** lost *{item}*."
    if k == "crit":
        if not who:
            return None
        blow = f" with {weapon}" if weapon else ""
        return (f"**{who}** landed a critical hit on **{tgt}**{blow}." if tgt
                else f"**{who}** landed a critical hit{blow}.")
    if k == "fumble":
        if not who:
            return None
        blow = f" with {weapon}" if weapon else ""
        return (f"**{who}** fumbled badly against **{tgt}**{blow}." if tgt
                else f"**{who}** fumbled badly{blow}.")
    if k == "scene":
        to = e.get("to") or e.get("s") or ""
        frm = e.get("from") or ""
        if not to:
            return None
        return (f"The party travelled from {frm} to **{to}**." if frm
                else f"The party arrived at **{to}**.")
    if k == "combat_start":
        return f"Fighting broke out at {e.get('s') or 'an unrecorded place'}."
    if k == "combat_end":
        survivors = ", ".join(p for p in (e.get("p") or []) if "Test Fighter" not in p)
        return ("The fighting ended. Still standing: " + survivors + "."
                if survivors else "The fighting ended.")
    return None


def chronicle():
    world = load("ace-world.json")
    events = (load("ace-world-events.json") or {}).get("events") or []
    history = (load("ace-history.json") or {}).get("events") or []

    moments = []   # (timestamp, kind, key-for-dedup, rendered line)

    for s in (world.get("sessions") or []):
        summary = clean(s.get("summary"))
        if not summary:
            continue
        party = ", ".join(p for p in (s.get("party") or [])
                          if "Test Fighter" not in p
                          and p not in ("download", "Group Map Token"))
        moments.append((s.get("t") or 0, "SESSION", f"session{s.get('num')}", (
            f"### Session {s.get('num', '?')} — {s.get('date', day(s.get('t')))}\n\n"
            f"**Where:** {s.get('scene', 'unrecorded')}  \n"
            f"**Who was there:** {party or 'unrecorded'}\n\n{summary}\n")))

    for e in events:
        summary = clean(e.get("summary"))
        if not summary or ROLL_NOISE.match(summary):
            continue
        nouns = e.get("nouns") or {}
        tail = [b for b in (e.get("magnitude") or "", e.get("scene") or "",
                            ", ".join(nouns.get("actors") or [])) if b]
        moments.append((e.get("ts") or 0, "EVENT", summary,
                        f"- {summary}"
                        + (f"  \n  <sub>{' · '.join(tail)}</sub>" if tail else "")))

    for h in history:
        text = clean(h.get("txt") or "")
        if text and not ROLL_NOISE.match(text):
            if len(text) < 25:
                continue
            scene = h.get("s") or ""
            actor = h.get("a") or ""
            tail = [b for b in (scene, actor) if b]
            moments.append((h.get("t") or 0, h.get("k", "note").upper(), text,
                            f"- {text}"
                            + (f"  \n  <sub>{' · '.join(tail)}</sub>" if tail else "")))
            continue
        line = _sentence(h)
        if not line:
            continue
        scene = h.get("s") or ""
        moments.append((h.get("t") or 0, h.get("k", "").upper(), line,
                        f"- {line}" + (f"  \n  <sub>{scene}</sub>" if scene else "")))

    # ⚠️ Compare the CONTENT, not the formatted line. The same moment arrives
    # once as a world note and once as a history row with a different scene tag.
    seen = set()
    unique = []
    for ts, kind, key, text in sorted(moments, key=lambda m: m[0] or 0):
        fingerprint = re.sub(r"\W+", "", str(key).lower())[:160]
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        unique.append((ts, kind, text))

    counts = {}
    for _ts, kind, _t in unique:
        counts[kind] = counts.get(kind, 0) + 1
    tally = ", ".join(f"{v} {k.lower().replace('_', ' ')}"
                      for k, v in sorted(counts.items(), key=lambda kv: -kv[1]))

    body = ["# The Chronicle",
            "",
            "Everything that happened, oldest first. The twelve session summaries are "
            "the spine; kills, discoveries, journeys, conversations and fights fill in "
            "between them.",
            "",
            f"{len(unique)} moments — {tally}",
            ""]
    current = None
    for ts, kind, text in unique:
        if kind == "SESSION":
            body.append("\n---\n")
            body.append(text)
            current = None
            continue
        d = day(ts)
        if d != current:
            body.append(f"\n**{d}**\n")
            current = d
        body.append(text)
    # ⚠️ A DIFFERENT NAME FROM build-narrative.py. Both wrote
    # "01 - THE CHRONICLE.md", so whichever ran last silently destroyed the
    # other's work, and it did exactly that twice in one afternoon. This is the
    # COMPLETE record including the mechanical events; the narrative one is the
    # one to upload.
    return write("09 - THE FULL LOG.md", "\n".join(body)), len(unique)


# ══ 2. THE CAST — who is in it ══════════════════════════════════════════════
def cast(journals):
    npcs = (load("ace-npcs.json") or {}).get("npcs") or {}

    # The Memory page of each NPC Profile journal is the character writing.
    memory = {}
    for j in journals:
        if j.get("folderName") != "NPC Profiles":
            continue
        name = re.sub(r"\s*\(CR [^)]*\)\s*$", "", j.get("name") or "").strip()
        # ⚠️ THE PAGE NAMES CHANGED UNDER THIS READER. Until 2026-08-22 every NPC
        # journal had a single page called "Memory". The rebuild replaced that
        # with four named pages, and this kept asking for "Memory", found nothing,
        # and quietly produced a Cast file a third of its former size. Nothing
        # errored. A reader that silently returns less is the worst kind.
        wanted = ("Who They Are", "What They Want", "Between Us", "Where They Stand",
                  "Memory")
        parts = []
        for want in wanted:
            for p in (j.get("pages") or []):
                if p.get("name") != want:
                    continue
                text = clean(p.get("text"))
                if len(text) > 60:
                    parts.append(text)
        if parts:
            memory[name] = "\n\n".join(parts)

    rows = []
    for rec in npcs.values():
        name = rec.get("displayName") or ""
        if not name or "Test Fighter" in name:
            continue
        met = int(rec.get("met") or 0)
        note = memory.get(re.sub(r"\s*\(CR [^)]*\)\s*$", "", name).strip(), "")
        prose = [a.get("contextText") or "" for a in (rec.get("sceneAppearances") or [])]
        prose = [clean(p) for p in prose if len(p or "") > 120]
        if met < 3 and not note and not prose:
            continue
        rows.append((met, name, rec, note, prose))

    rows.sort(key=lambda r: (-r[0], r[1]))

    body = ["# The Cast",
            "",
            "Every creature the party has met more than twice, or that anything was "
            "written about. Sorted by how often they turn up.",
            "",
            f"{len(rows)} of {len(npcs)} recorded creatures.",
            ""]
    for met, name, rec, note, prose in rows:
        body.append(f"\n## {name}\n")
        facts = []
        if rec.get("killed"):
            by = rec.get("killedBy") or "unknown hands"
            facts.append(f"**Dead** — killed by {by}")
        else:
            facts.append("**Alive**")
        kind = rec.get("race") or rec.get("class") or ""
        if kind:
            facts.append(kind)
        facts.append(f"met {met} time{'s' if met != 1 else ''}")
        first, last = day(rec.get("firstSeen")), day(rec.get("lastSeen"))
        if first != "undated":
            facts.append(f"first seen {first}, last seen {last}")
        body.append(" · ".join(facts))
        scenes = [s for s in (rec.get("scenes") or []) if s]
        if scenes:
            body.append(f"\n**Seen at:** {', '.join(scenes)}")
        if note:
            body.append(f"\n{note}")
        for p in prose:
            body.append(f"\n> {p}")
    return write("02 - THE CAST.md", "\n".join(body)), len(rows)


# ══ 3. THE PLACES — where it happened ═══════════════════════════════════════
def places():
    scenes = (load("ace-scenes.json") or {}).get("scenes") or {}
    rows = sorted(scenes.values(), key=lambda s: -(s.get("visitCount") or 0))

    body = ["# The Places",
            "",
            "Every location the party has been, how often, and who was standing there.",
            "",
            f"{len(rows)} places.",
            ""]
    for s in rows:
        name = s.get("displayName") or "unnamed"
        visits = s.get("visits") or []
        body.append(f"\n## {name}\n")
        body.append(f"Visited {s.get('visitCount', len(visits))} times · "
                    f"first {day(s.get('firstVisited'))} · last {day(s.get('lastVisited'))}")
        fights = sum(1 for v in visits if v.get("combatOccurred"))
        if fights:
            body.append(f"\n**{fights} fight{'s' if fights != 1 else ''} happened here.**")
        cast_here, pcs_here = [], []
        for v in visits:
            for n in (v.get("npcsPresent") or []):
                if n not in cast_here:
                    cast_here.append(n)
            for p in (v.get("pcsPresent") or []):
                if p not in pcs_here and "Test Fighter" not in p:
                    pcs_here.append(p)
        if cast_here:
            body.append(f"\n**Who lives or waits here:** {', '.join(cast_here)}")
        if pcs_here:
            body.append(f"\n**Party members who came:** {', '.join(pcs_here)}")
        events = [e for v in visits for e in (v.get("eventsHere") or [])]
        for e in events[:12]:
            text = clean(e if isinstance(e, str) else e.get("summary") or e.get("txt") or "")
            if text:
                body.append(f"\n- {text}")
    return write("03 - THE PLACES.md", "\n".join(body)), len(rows)


# ══ 4. THE WORLD — the setting these people live in ═════════════════════════
def world_bible():
    bible = load("ace-world-bible.json")
    regions = bible.get("regions") or {}
    factions = bible.get("globalFactions") or []
    pantheon = bible.get("pantheon") or []

    def described(obj, *keys):
        for k in keys:
            v = obj.get(k)
            if isinstance(v, str) and len(v) > 30:
                return clean(v)
        return ""

    body = ["# The World",
            "",
            "The setting as ACE holds it: regions, powers and gods. This is the "
            "backdrop, not the story.",
            ""]

    body.append(f"\n# Regions ({len(regions)})\n")
    for key, r in sorted(regions.items()):
        if not isinstance(r, dict):
            continue
        name = r.get("name") or key
        body.append(f"\n## {name}\n")
        desc = described(r, "description", "summary", "overview", "text")
        if desc:
            body.append(desc)
        for field, label in (("nations", "Nations"), ("cities", "Settlements"),
                             ("factions", "Powers"), ("deities", "Worshipped here")):
            vals = r.get(field)
            if isinstance(vals, list) and vals:
                names = [v.get("name") if isinstance(v, dict) else str(v) for v in vals]
                names = [n for n in names if n]
                if names:
                    body.append(f"\n**{label}:** {', '.join(names[:40])}"
                                + (f" and {len(names) - 40} more" if len(names) > 40 else ""))

    body.append(f"\n\n# Powers of the world ({len(factions)})\n")
    for f in factions:
        if not isinstance(f, dict):
            continue
        body.append(f"\n## {f.get('name', 'unnamed')}\n")
        desc = described(f, "description", "summary", "goals", "text")
        if desc:
            body.append(desc)
        for k in ("alignment", "scope", "nation", "leader", "headquarters"):
            if f.get(k):
                body.append(f"\n**{k.title()}:** {f[k]}")

    body.append(f"\n\n# The gods ({len(pantheon)})\n")
    for d in pantheon:
        if not isinstance(d, dict):
            continue
        line = f"\n**{d.get('name', 'unnamed')}**"
        for k in ("title", "alignment", "domains", "portfolio"):
            v = d.get(k)
            if v:
                line += f" · {', '.join(v) if isinstance(v, list) else v}"
        body.append(line)
        desc = described(d, "description", "summary", "text")
        if desc:
            body.append(f"\n{desc}")
    return write("04 - THE WORLD.md", "\n".join(body)), len(regions)


# ══ 5. THE JOURNALS — everything written down, in full ══════════════════════
def journals_doc(journals):
    keep = []
    for j in journals:
        text = "\n\n".join(
            (f"**{p.get('name')}**\n\n" if p.get("name") not in (None, j.get("name")) else "")
            + clean(p.get("text"))
            for p in (j.get("pages") or []) if clean(p.get("text")))
        if len(text) < 80:
            continue
        keep.append((j.get("folderName") or "Loose pages", j.get("name") or "untitled", text))
    keep.sort()

    body = ["# The Journals",
            "",
            "Every journal in the world, in full. Folder by folder.",
            "",
            f"{len(keep)} journals with content.",
            ""]
    folder = None
    for f, name, text in keep:
        if f != folder:
            body.append(f"\n\n# {f}\n")
            folder = f
        body.append(f"\n## {name}\n\n{text}\n")
    return write("05 - THE JOURNALS.md", "\n".join(body)), len(keep)


def main():
    print("BUILDING THE STORY PACK")
    print("=" * 74)
    try:
        journals = json.load(io.open(LIVE, encoding="utf-8")).get("journals") or []
    except Exception as exc:
        print(f"   ! journals unavailable: {exc}")
        journals = []

    print("\nwriting to:", OUT, "\n")
    _p1, n1 = chronicle()
    _p2, n2 = cast(journals)
    _p3, n3 = places()
    _p4, n4 = world_bible()
    _p5, n5 = journals_doc(journals)

    readme = f"""UPLOAD THESE FIVE FILES TO NOTEBOOKLM
{'=' * 74}

Built {datetime.now().strftime('%Y-%m-%d %H:%M')}. Upload all five as separate
sources. Keeping them separate is the point: NotebookLM cites the document it
drew from, so you can tell a remembered fact from an invented one.

  01 - THE CHRONICLE   {n1} moments, oldest first. What actually happened.
                       The 12 session summaries are the spine.
  02 - THE CAST        {n2} creatures with a history. Who they are, whether
                       they are still breathing, and who killed them.
  03 - THE PLACES      {n3} locations, visit counts, who was standing there.
  04 - THE WORLD       {n4} regions plus the powers and the gods. Backdrop.
  05 - THE JOURNALS    {n5} journals in full, including the ones you wrote.

GOOD QUESTIONS TO ASK IT

  "Write the story of the party's time in the Amber Temple as a chapter."
  "Who has the party wronged, and who would remember it?"
  "What threads have been left hanging?"
  "Write Vilnius's account of meeting the party, in his own voice."
  "Build a Previously On recap for the top of the next session."

WHAT IS THIN, AND WHY

  The system has been counting rather than remembering. There are 563 creature
  records and 18 pieces of narrative prose between them. Varek Thalor is logged
  as met 638 times with almost nothing recorded about any of them.

  So the story lives almost entirely in the 12 session summaries and the 203
  world notes. That is what these five files gather. Anything you add to the
  journals from here forward lands in file 05 the next time this is run.
"""
    write("00 READ ME FIRST.txt", readme)
    print("\ndone. Five sources plus a read-me.")


if __name__ == "__main__":
    main()
