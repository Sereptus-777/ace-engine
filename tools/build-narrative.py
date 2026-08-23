# ─── ACE Engine — the chronicle, written as a story ─────────────────────────
#
# ⚠️ WHY THE VIDEO PUT HIS NOTES ON SCREEN. Frames pulled from the finished
# Video Overview show, verbatim:
#
#     trivial · Intro Throne Room Encounter Intro · Chudd Buckland, Firaxis
#     Greenbeard, Group Map Token, Jeth, Jexx, ... download
#     The party travelled from BM: Argynvostholt 3F to Intro Throne Room Encounter Intro.
#     Phantom Warrior fumbled badly against Spectral Dire Wolf (King) with Spectral Longsword.
#
# None of that is the model behaving badly. That is my own chronicle handing it
# map codes, magnitude tags, a token called "download", and dice outcomes, and
# the video faithfully reading them out. A source that looks like a document
# gets shown as a document.
#
# So this is the same events with everything that is not story taken out:
#
#   GONE  scene codes "BM:" and "SC:", magnitude tags, trailing metadata lines,
#         travel between maps, fights starting and stopping, criticals and
#         fumbles, inventory churn, and every non-person in the party list.
#   KEPT  session summaries, what people said and did, kills, discoveries, and
#         the narration written for the table.
#
# ⚠️ THE FULL VERSION IS NOT DELETED. It stays as the complete record. This is
# the one to upload; that one is the one to keep.
import io
import json
import os
import re
import subprocess
from datetime import datetime, timezone

ENGINE = r"D:\FoundryVTT\Data\worlds\hijinx\ace-engine"
OUT_DIR = r"C:\Users\johnp\Downloads\ACE STORY PACK"
PACK = r"C:\Users\johnp\OneDrive\Desktop\ACE FULL HISTORY\05 STORY PACK (for NotebookLM)"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# Things in the party list that are not people.
NOT_A_PERSON = re.compile(
    r"^(group map token|download|ace test dummy|hammer the test fighter.*|"
    r"spectral dire wolf \(king\) original|\d+)$", re.I)

# Map bookkeeping that means nothing to a reader.
SCENE_PREFIX = re.compile(r"^(BM|SC|AAA|Overview|Intro)\s*[:\-]?\s*", re.I)

# Machine noise that ended up in the narrative fields.
MACHINE = re.compile(
    r"messages\.\d+:|user messages must have|requires more credits|can only afford|"
    r"openrouter\.ai|__ACE_AI_FAILED__|I'm sorry, but I need more information|"
    r"^\s*subtle\s+(batch\s+)?roll|^\s*batch roll", re.I)

# Event kinds that are mechanics rather than story.
DROP_KINDS = {"tile_placed", "tile_removed", "scene", "combat_start", "combat_end",
              "crit", "fumble", "item_lost", "session_summary"}


def when(ts):
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
    return d.strftime("%d %B %Y") if d else ""


def load(name):
    try:
        return json.load(io.open(os.path.join(ENGINE, name), encoding="utf-8"))
    except Exception as exc:
        print(f"   ! {name}: {exc}")
        return {}


def place(name):
    """Turn 'BM: 1F East - Amber Temple' into 'the Amber Temple'.

    ⚠️ A SESSION'S SCENE FIELD CAN HOLD SEVERAL, comma separated, and stripping
    only the LEADING prefix left the rest intact: "Argynvostholt 1F, BM:
    Argynvostholt 2F" went out with the second code still showing.
    """
    raw = str(name or "")
    if "," in raw:
        parts = [place(p) for p in raw.split(",")]
        return ", ".join(dict.fromkeys(p for p in parts if p))
    s = SCENE_PREFIX.sub("", raw.strip()).strip()
    s = re.sub(r"^\d+F\s*(North|South|East|West|Centre|Center)?\s*(East|West)?\s*[-–]?\s*", "", s, flags=re.I)
    s = re.sub(r"\s*\(Copy\)$", "", s, flags=re.I)
    s = re.sub(r"\s*(Encounter )?Intro$", "", s, flags=re.I)
    s = re.sub(r"^(MINE|Entry|Pass \d+|Gate)\s*", "", s, flags=re.I).strip()
    return s


# ⚠️ CLEANING THE FIELDS IS NOT ENOUGH. The first run of this came out with 85
# remaining "BM:" codes and five mentions of "Hammer the Test Fighter", because
# those are inside the SESSION SUMMARY PROSE, which the model wrote from data
# that already contained them. The scrubbing has to run over the body text too,
# not just the scene and party fields.
INLINE_SCENE = re.compile(r"\b(?:BM|SC)\s*:\s*([^,.;()\n]+)")
TEST_ACTOR = re.compile(
    r",?\s*(?:and\s+)?Hammer the Test Fighter(?:\s*\(Fighter\s*\d+\))?(?:\s*#\d+)?", re.I)
ROLL_LINE = re.compile(r"subtle\s+(batch\s+)?roll|batch roll", re.I)


def clean(text):
    t = re.sub(r"<[^>]*>", " ", str(text or ""))
    t = (t.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
          .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'"))
    t = INLINE_SCENE.sub(lambda m: place(m.group(1)) or "the map", t)
    t = TEST_ACTOR.sub("", t)
    # "Session Summary: Argynvostholt 3F, 2026-03-10" is a filing label the model
    # wrote at the head of its own prose. It reads as a document heading, which
    # is exactly the thing that ends up rendered on screen as a document.
    t = re.sub(r"^\**\s*#*\s*Session Summary:?\s*[^\n]{0,60}?\**\s*(?=[A-Z])", "", t)
    t = re.sub(r"\s+([,.;])", r"\1", t)          # tidy what the removals left
    t = re.sub(r",\s*,", ",", t)
    return re.sub(r"\s+", " ", t).strip()


def people(names):
    return [n for n in (names or []) if n and not NOT_A_PERSON.match(str(n).strip())]


def narrative_line(e):
    """One history event as a sentence, or None if it is mechanics."""
    k = e.get("k")
    if k in DROP_KINDS:
        return None
    text = clean(e.get("txt") or "")
    if text and not MACHINE.search(text) and not ROLL_LINE.search(text):
        # "[NPC Conversation] X spoke with Y at Z. <the actual story>" — the
        # prefix is bookkeeping, the sentence after it is what happened.
        m = re.match(r"^\[NPC Conversation\]\s*(.+?)\s+spoke with\s+(.+?)\s+at\s+.+?\.\s*(.*)$",
                     text, re.S)
        if m:
            who, other, said = m.group(1), m.group(2), m.group(3).strip()
            if not said or MACHINE.search(said):
                return None
            return f"{who} spoke with {other}. {said}"
        if text.startswith("["):
            # "[Clovin Belview] \"I like her.\"" reads fine as a quotation.
            q = re.match(r"^\[([^\]]+)\]\s*(.+)$", text, re.S)
            if q:
                return f"{q.group(1)}: {q.group(2)}"
        if len(text) < 25:
            return None
        return text

    # ⚠️ FILTER THE ACTOR, NOT ONLY THE TARGET. The first pass checked the victim
    # of a kill and forgot the person doing it and the person picking things up,
    # so five lines went out reading "Hammer the Test Fighter (Fighter 5) #2 took
    # possession of the Deck of Illusions". Johnny's test dummy, in his campaign
    # history, looting.
    if k == "kill":
        victim, killer = e.get("tgt"), e.get("a")
        if not victim or NOT_A_PERSON.match(str(victim).strip()):
            return None
        if killer and NOT_A_PERSON.match(str(killer).strip()):
            return None
        where = place(e.get("s"))
        at = f" at {where}" if where else ""
        return f"{killer} killed {victim}{at}." if killer else f"{victim} was killed{at}."
    if k == "item_acquired":
        item, who = e.get("item"), e.get("a")
        if not item or re.match(r"^(unarmed strike|claws?|bite|slam|tail|talons?|fists?)",
                                str(item), re.I):
            return None
        if who and NOT_A_PERSON.match(str(who).strip()):
            return None
        return f"{who or 'The party'} took possession of the {item}."
    return None


def build():
    world = load("ace-world.json")
    events = (load("ace-world-events.json") or {}).get("events") or []
    history = (load("ace-history.json") or {}).get("events") or []

    moments = []
    for s in (world.get("sessions") or []):
        summary = clean(s.get("summary"))
        if not summary:
            continue
        # The model wrote its own title into the summary; the session heading
        # above it already says what this is.
        summary = re.sub(r"^#+\s*Session Summary:\s*", "", summary).strip()
        party = ", ".join(people(s.get("party")))
        moments.append((s.get("t") or 0, "session", f"s{s.get('num')}", {
            "num": s.get("num"), "date": s.get("date") or day(s.get("t")),
            "where": place(s.get("scene")), "party": party, "text": summary}))

    for e in events:
        summary = clean(e.get("summary"))
        if (not summary or MACHINE.search(summary) or ROLL_LINE.search(summary)
                or len(summary) < 25):
            continue
        moments.append((e.get("ts") or 0, "line", summary, {"text": summary}))

    for h in history:
        line = narrative_line(h)
        if not line:
            continue
        moments.append((h.get("t") or 0, "line", line, {"text": line}))

    seen, unique = set(), []
    for ts, kind, key, payload in sorted(moments, key=lambda m: m[0] or 0):
        fp = re.sub(r"\W+", "", str(key).lower())[:160]
        if fp in seen:
            continue
        seen.add(fp)
        unique.append((ts, kind, payload))

    sessions = sum(1 for _t, k, _p in unique if k == "session")
    print(f"   {len(unique)} moments kept ({sessions} session summaries), "
          f"{len(moments) - len(unique)} duplicates dropped")
    return unique


CSS = """
@page { size:A4; margin:18mm 18mm 20mm; }
body { font:11.5pt/1.7 Georgia,'Times New Roman',serif; color:#1a1a1a; }
h1 { font-size:24pt; color:#6b4a12; border-bottom:3px solid #c9a84c; padding-bottom:8px;
     margin:0 0 4px; }
h2 { font-size:15pt; color:#7a5a1a; margin:30px 0 4px; page-break-after:avoid; }
.sub { color:#6f6a5e; font-size:10pt; margin:0 0 26px; }
.when { color:#8a7f68; font-size:9.5pt; letter-spacing:.06em; text-transform:uppercase;
        margin:22px 0 6px; }
.meta { color:#6f6a5e; font-size:10pt; font-style:italic; margin:0 0 10px; }
p { margin:9px 0; text-align:justify; }
hr { border:0; border-top:1px solid #c9a84c; margin:26px 0; }
"""


def render(moments):
    out = ["<h1>The Chronicle of Barovia</h1>",
           "<p class='sub'>What happened, in order, as a story.</p>"]
    current = None
    for ts, kind, p in moments:
        if kind == "session":
            out.append("<hr>")
            out.append(f"<h2>Session {p['num']} &middot; {p['date']}</h2>")
            meta = " &middot; ".join(x for x in (p["where"], p["party"]) if x)
            if meta:
                out.append(f"<p class='meta'>{meta}</p>")
            for para in re.split(r"\n{2,}|(?<=\.)\s{2,}", p["text"]):
                para = para.strip()
                if para:
                    out.append(f"<p>{para}</p>")
            current = None
            continue
        d = day(ts)
        if d and d != current:
            out.append(f"<p class='when'>{d}</p>")
            current = d
        out.append(f"<p>{p['text']}</p>")
    return (f"<!doctype html><html><head><meta charset='utf-8'>"
            f"<title>The Chronicle of Barovia</title><style>{CSS}</style></head>"
            f"<body>{''.join(out)}</body></html>")


def main():
    print("BUILDING THE NARRATIVE CHRONICLE")
    print("=" * 74)
    moments = build()
    html = render(moments)

    os.makedirs(OUT_DIR, exist_ok=True)
    name = "01 - THE CHRONICLE"
    html_path = os.path.join(OUT_DIR, name + ".html")
    io.open(html_path, "w", encoding="utf-8").write(html)
    pdf_path = os.path.join(OUT_DIR, name + ".pdf")
    url = "file:///" + html_path.replace("\\", "/").replace(" ", "%20")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
                    "--no-pdf-header-footer", "--run-all-compositor-stages-before-draw",
                    "--virtual-time-budget=120000", f"--print-to-pdf={pdf_path}", url],
                   capture_output=True, timeout=900)
    if os.path.exists(pdf_path):
        os.remove(html_path)
        print(f"\n   {os.path.getsize(pdf_path):,} bytes  {pdf_path}")

    # Markdown twin, and the full log-shaped version kept under its own name.
    md = ["# The Chronicle of Barovia", "", "What happened, in order, as a story.", ""]
    current = None
    for ts, kind, p in moments:
        if kind == "session":
            md += ["", "---", "", f"## Session {p['num']} · {p['date']}", ""]
            meta = " · ".join(x for x in (p["where"], p["party"]) if x)
            if meta:
                md += [f"*{meta}*", ""]
            md += [p["text"], ""]
            current = None
            continue
        d = day(ts)
        if d and d != current:
            md += ["", f"**{d}**", ""]
            current = d
        md.append(p["text"])
    io.open(os.path.join(PACK, "01 - THE CHRONICLE.md"), "w",
            encoding="utf-8").write("\n".join(md))
    print("   markdown twin written to the story pack.")


if __name__ == "__main__":
    main()
