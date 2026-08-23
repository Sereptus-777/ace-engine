# ─── ACE Engine — one document per video ────────────────────────────────────
#
# Johnny, 2026-08-22, after the second Video Overview: "why did it only build
# this? And it was still referencing pages... can you not just put this all in
# one fucking document... It isn't even drawing Firaxis Greenbeard sometimes.
# When it draws the whole party, it just is a bunch of human fighters."
#
# ⚠️ THREE THINGS LEARNED FROM WATCHING THE OUTPUT FRAME BY FRAME.
#
#  1. EMBEDDING PORTRAITS MADE THE DOCUMENT SOMETHING TO DISPLAY. Frames from
#     the video show my own Cast Bible on screen, portraits and all, scrolling
#     as a document. A PDF full of pictures is a visual asset, and the "do not
#     show the source" instruction written INSIDE it is just more text; it does
#     not bind the generator. So: no images in these, and no reference tables.
#
#  2. IT DRAWS WHAT A SENTENCE NAMES. Every genuinely good shot in that video
#     had exactly one named subject: Ezmerelda mid-throw with the handaxe,
#     Chudd's vines dragging down Strahd's dire wolf, Vasilka's stitched hand
#     on a bunch of dead roses. Every bad shot was "the party", which gave it
#     nothing to hold and produced stock human fighters. So appearance is woven
#     into the prose at the moment each person acts, never listed in a table.
#
#  3. ONE PLACE PER VIDEO. Five minutes will not hold five months, and a
#     notebook draws on every source in it. One document, one notebook, one
#     video, one location.
import io
import json
import os
import re
import subprocess
from datetime import datetime, timezone

ENGINE = r"D:\FoundryVTT\Data\worlds\hijinx\ace-engine"
LIVE = r"D:\FoundryVTT\Data\ace-backups\live\payload.json"
OUT_DIR = r"C:\Users\johnp\Downloads\ACE STORY PACK\FOR VIDEOS"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# Reused from the narrative builder: the same noise, filtered the same way.
NOT_A_PERSON = re.compile(
    r"^(group map token|download|ace test dummy|hammer the test fighter.*|"
    r"spectral dire wolf \(king\) original|\d+)$", re.I)
SCENE_PREFIX = re.compile(r"^(BM|SC|AAA|Overview|Intro)\s*[:\-]?\s*", re.I)
INLINE_SCENE = re.compile(r"\b(?:BM|SC)\s*:\s*([^,.;()\n]+)")
TEST_ACTOR = re.compile(
    r",?\s*(?:and\s+)?Hammer the Test Fighter(?:\s*\(Fighter\s*\d+\))?(?:\s*#\d+)?", re.I)
MACHINE = re.compile(
    r"messages\.\d+:|user messages must have|requires more credits|can only afford|"
    r"openrouter\.ai|__ACE_AI_FAILED__|I'm sorry, but I need more information|"
    r"subtle\s+(batch\s+)?roll|batch roll", re.I)
DROP_KINDS = {"tile_placed", "tile_removed", "scene", "combat_start", "combat_end",
              "crit", "fumble", "item_lost", "session_summary"}

# Movement and kill bookkeeping written as though it were prose.
#
# ⚠️ THIS PATTERN ONCE ENDED IN A LITERAL BACKSPACE. Written through a shell
# heredoc, the word-boundary escape became byte 0x08, so the regex demanded a
# character no text will ever contain. It matched nothing, silently, while
# looking perfectly correct on screen, and 69 'Arrived in' lines plus 69
# 'Slew' lines sailed straight through into the finished documents.
#
# A character class cannot be eaten the same way, so that is what it uses now.
BOOKKEEPING = re.compile(r"^(Arrived in|Slew|Departed|Entered|Left)[\s:,]", re.I)


# ⚠️ AN OUTLINE IS THE ONE THING THAT MUST NOT GET IN. A world note reading
# "Here's a concise breakdown of the plan... ### Objective: Light the Beacon"
# is the model talking to the GM about planning, not something that happened.
# Left in, it is precisely the shape a video renders as a bulleted slide, which
# is the complaint that started all of this.
META = re.compile(
    r"^(here'?s|here is|below is|the following)\b.{0,40}\b"
    r"(breakdown|summary|plan|overview|outline|list|steps)|"
    r"^#{1,6}\s|^\s*(objective|goal|step \d|option \d|note to|tl;dr)\s*:", re.I)


# ⚠️ AND ANCHORING IS NOT ENOUGH. The note that started this begins as ordinary
# prose and turns into an outline halfway through, so a pattern anchored at the
# start never sees it. These markers are unmistakable wherever they appear.
OUTLINE_ANYWHERE = re.compile(
    r"#{2,}\s|here'?s a (concise |quick |brief )?(breakdown|summary|plan|overview)|"
    r"\bstep \d\s*[:.]|\bobjective\s*:", re.I)


def is_noise(text):
    """One test, used by every path that accepts a line."""
    t = (text or "").strip()
    return ((not t) or bool(MACHINE.search(t)) or bool(BOOKKEEPING.match(t))
            or bool(META.match(t)) or bool(OUTLINE_ANYWHERE.search(t)))

# ── How each person is described, at the moment they first act ──────────────
#
# ⚠️ NOT A TABLE. A table of characters is a reference sheet, and a reference
# sheet gets rendered on screen as a reference sheet. These are sentences meant
# to sit inside the story, so the description arrives attached to an action.
WHO = {
    "Firaxis Greenbeard":
        "Firaxis Greenbeard is a green dragonborn paladin: deep forest-green scales "
        "over a long reptilian muzzle, two ivory horns swept back from his skull and a "
        "heavy scaled tail, in gold-chased plate with a round gold shield, the "
        "golden-white blade Dawnbringer burning in his fist",
    "Chudd Buckland":
        "Chudd Buckland is a stout halfling druid, barefoot on the cold stone, grey-brown "
        "curls and a lined face, his brown leathers overgrown with living vines and moss "
        "and autumn leaves, an antlered staff cradling a white crystal",
    "Jeth":
        "Jeth is an albino drow assassin out of the Shadowfell: chalk-white skin and long "
        "bone-white hair, red eyes, black spiderweb and skull tattoos across his bare "
        "chest and arms, a silver rapier in one hand and a curved scimitar in the other",
    "Syrax Razeson":
        "Syrax Razeson is an aasimar in dark spiked plate over grey robes, brown hair in "
        "tight braids, his eyes burning hard electric blue and throwing that light back "
        "onto his own face, the Blood Halberd in both hands",
    "Virric Vaesoldandros":
        "Virric Vaesoldandros is a high elf artificer with a close-cropped head and a plain "
        "focused face, brown leather hung with brass gauges and clockwork and glowing "
        "vials, a long spear inlaid with runes burning blue and orange",
    "King":
        "King is a spectral dire wolf, translucent and drifting, pale blue-white light "
        "with edges that glow and no solid shadow beneath him",
    "Steel Defender":
        "The Steel Defender is Virric's mechanical hound of riveted brass and copper plate, "
        "gears along its spine and glowing lenses where eyes should be",
}

SCENES = [
    {
        "key": "argynvostholt",
        "title": "Argynvostholt",
        "subtitle": "The mansion of the Order of the Silver Dragon, and the dead who still keep it",
        "scenes": ["argynvostholt"],
        "words": ["argynvostholt", "revenant", "vladimir", "silver dragon", "beacon",
                  "argynvost", "phantom warrior", "order of the silver"],
    },
    {
        "key": "abbey",
        "title": "The Abbey of Saint Markovia",
        "subtitle": "A fallen deva, his stitched bride, and the arrival of Strahd",
        "scenes": ["north east", "south west", "abbey", "krezk"],
        "words": ["abbey", "markovia", "abbot", "vasilka", "mongrelfolk", "belview",
                  "scarecrow", "krezk", "ismark"],
    },
    {
        "key": "amber-temple",
        "title": "The Amber Temple",
        "subtitle": "Six faceless guardians, and the dark gifts sealed behind amber",
        "scenes": ["amber temple"],
        "words": ["amber temple", "amber golem", "amber statue", "vestige", "exethanter",
                  "vilnius", "varek", "dark gift", "sarcophag"],
    },
]


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


def load(name):
    try:
        return json.load(io.open(os.path.join(ENGINE, name), encoding="utf-8"))
    except Exception as exc:
        print(f"   ! {name}: {exc}")
        return {}


def place(name):
    raw = str(name or "")
    if "," in raw:
        return ", ".join(dict.fromkeys(p for p in (place(x) for x in raw.split(",")) if p))
    s = SCENE_PREFIX.sub("", raw.strip()).strip()
    s = re.sub(r"^\d+F\s*(North|South|East|West|Centre|Center)?\s*(East|West)?\s*[-–]?\s*",
               "", s, flags=re.I)
    s = re.sub(r"\s*\(Copy\)$|\s*(Encounter )?Intro$", "", s, flags=re.I)
    return re.sub(r"^(MINE|Entry|Pass \d+|Gate)\s*", "", s, flags=re.I).strip()


def clean(text):
    t = re.sub(r"<[^>]*>", " ", str(text or ""))
    t = (t.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
          .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'"))
    t = INLINE_SCENE.sub(lambda m: place(m.group(1)) or "the map", t)
    t = TEST_ACTOR.sub("", t)
    t = re.sub(r"^\**\s*#*\s*Session Summary:?\s*[^\n]{0,60}?\**\s*(?=[A-Z])", "", t)
    # Every asterisk, not only matched pairs. An unclosed ** from a session
    # summary survived the pair-only version and reached the page.
    t = re.sub(r"\*+", "", t)
    t = re.sub(r"\s+([,.;])", r"\1", t)
    return re.sub(r"\s+", " ", t).strip()


def belongs(scene_def, scene_name, text):
    s = (scene_name or "").lower()
    if any(k in s for k in scene_def["scenes"]):
        return True
    t = (text or "").lower()
    return any(w in t for w in scene_def["words"])


def line_for(e):
    k = e.get("k")
    if k in DROP_KINDS:
        return None
    text = clean(e.get("txt") or "")
    # "Arrived in Overview - Abbey" is a movement log line wearing prose.
    if is_noise(text):
        return None
    if text and not MACHINE.search(text):
        m = re.match(r"^\[NPC Conversation\]\s*(.+?)\s+spoke with\s+(.+?)\s+at\s+.+?\.\s*(.*)$",
                     text, re.S)
        if m:
            said = m.group(3).strip()
            if not said or MACHINE.search(said):
                return None
            return f"{m.group(1)} spoke with {m.group(2)}. {said}"
        q = re.match(r"^\[([^\]]+)\]\s*(.+)$", text, re.S)
        if q:
            return f"{q.group(1)} said: {q.group(2)}"
        return text if len(text) >= 25 else None
    if k == "kill":
        victim, killer = e.get("tgt"), e.get("a")
        if not victim or NOT_A_PERSON.match(str(victim).strip()):
            return None
        if killer and NOT_A_PERSON.match(str(killer).strip()):
            return None
        return f"{killer} killed {victim}." if killer else f"{victim} was killed."
    if k == "item_acquired":
        item, who = e.get("item"), e.get("a")
        if not item or re.match(r"^(unarmed strike|claws?|bite|slam|tail|talons?|fists?)",
                                str(item), re.I):
            return None
        if who and NOT_A_PERSON.match(str(who).strip()):
            return None
        article = "" if re.match(r"^(the|a|an)[\s’']", str(item), re.I) else "the "
        return f"{who or 'The party'} took {article}{item}."
    return None


def introduce(text, already):
    """Attach a description the first time somebody acts.

    ⚠️ THIS IS THE WHOLE TRICK. The generator draws what a sentence names. Every
    good shot in the last video had one named subject; every bad one said "the
    party" and got stock human fighters. So the first time Firaxis does anything
    in this document, the sentence carries his scales, his horns and his sword.
    """
    intros = []
    for name, description in WHO.items():
        if name in already:
            continue
        # Only on a whole-word first mention, and only once.
        if not re.search(r"\b" + re.escape(name) + r"\b", text):
            continue
        # ⚠️ PREPEND A WHOLE SENTENCE; DO NOT SPLICE INTO THE MIDDLE OF ONE. The
        # first attempt substituted the description for the name in place and
        # produced "...Dawnbringer burning in his fist spoke with Specter." The
        # description has to stand on its own before the action.
        intros.append(description.rstrip(".") + ".")
        already.add(name)
    return (" ".join(intros) + " " + text) if intros else text


def gather(scene_def):
    world = load("ace-world.json")
    events = (load("ace-world-events.json") or {}).get("events") or []
    history = (load("ace-history.json") or {}).get("events") or []

    moments = []
    for s in (world.get("sessions") or []):
        summary = clean(s.get("summary"))
        if not summary or not belongs(scene_def, s.get("scene"), summary):
            continue
        moments.append((s.get("t") or 0, summary))
    for e in events:
        summary = clean(e.get("summary"))
        if is_noise(summary) or len(summary) < 25:
            continue
        if belongs(scene_def, e.get("scene"), summary):
            moments.append((e.get("ts") or 0, summary))
    for h in history:
        if not belongs(scene_def, h.get("s"), h.get("txt") or ""):
            continue
        line = line_for(h)
        if line:
            moments.append((h.get("t") or 0, line))

    seen, unique = set(), []
    for ts, text in sorted(moments, key=lambda m: m[0] or 0):
        fp = re.sub(r"\W+", "", text.lower())[:150]
        if fp in seen:
            continue
        seen.add(fp)
        unique.append(text)
    return unique


CSS = """
@page { size:A4; margin:20mm; }
body { font:12pt/1.75 Georgia,'Times New Roman',serif; color:#1a1a1a; }
h1 { font-size:26pt; color:#6b4a12; margin:0 0 4px; }
.sub { color:#6f6a5e; font-size:12pt; font-style:italic; margin:0 0 28px; }
h2 { font-size:14pt; color:#7a5a1a; margin:28px 0 10px; }
p { margin:11px 0; text-align:justify; }
"""


def build_one(scene_def):
    lines = gather(scene_def)
    already = set()
    body = [f"<h1>{scene_def['title']}</h1>",
            f"<p class='sub'>{scene_def['subtitle']}</p>",
            "<h2>What happened</h2>"]
    for text in lines:
        body.append(f"<p>{introduce(text, already)}</p>")

    # Anyone who never got named in this chapter still needs to exist, because
    # they were there. One closing paragraph, still prose, still no table.
    missing = [d for n, d in WHO.items() if n not in already]
    if missing:
        body.append("<h2>Who was there</h2>")
        body.append("<p>All seven of the company were present throughout: "
                    + "; ".join(WHO.values()) + ". They travel together and they fight "
                    "together, and any scene showing the company shows all seven of them.</p>")
    else:
        body.append("<h2>Who was there</h2>")
        body.append("<p>All seven of the company were present throughout. They travel "
                    "together and they fight together, and any scene showing the company "
                    "shows all seven of them.</p>")

    html = (f"<!doctype html><html><head><meta charset='utf-8'>"
            f"<title>{scene_def['title']}</title><style>{CSS}</style></head>"
            f"<body>{''.join(body)}</body></html>")

    os.makedirs(OUT_DIR, exist_ok=True)
    stem = scene_def["title"]
    html_path = os.path.join(OUT_DIR, stem + ".html")
    io.open(html_path, "w", encoding="utf-8").write(html)
    pdf_path = os.path.join(OUT_DIR, stem + ".pdf")
    url = "file:///" + html_path.replace("\\", "/").replace(" ", "%20")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
                    "--no-pdf-header-footer", "--run-all-compositor-stages-before-draw",
                    "--virtual-time-budget=60000", f"--print-to-pdf={pdf_path}", url],
                   capture_output=True, timeout=600)
    if os.path.exists(pdf_path):
        os.remove(html_path)
    print(f"   {os.path.getsize(pdf_path):>9,}  {stem}.pdf   "
          f"({len(lines)} moments, {len(already)} of 7 named in the story)")


def main():
    print("BUILDING ONE DOCUMENT PER VIDEO")
    print("=" * 74)
    for scene_def in SCENES:
        build_one(scene_def)
    print(f"\nin: {OUT_DIR}")


if __name__ == "__main__":
    main()
