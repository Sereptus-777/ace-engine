# ─── ACE Engine — the story pack, as PDFs he can actually find ───────────────
#
# Johnny, 2026-08-22: "I can't even find them on my hard drive. Put them in a
# downloads folder, OK? Copy them there in PDF form and build the fucking 6th
# and 7th."
#
# ⚠️ HE COULD NOT FIND THE JOURNALS BECAUSE THEY ARE NOT FILES. Foundry keeps
# journals inside the world's LevelDB store, as binary rows. Nothing on disk is
# named after a journal, nothing is readable, and no amount of searching his
# drive would ever have turned one up. Every export path has to go through the
# backup payload.
#
# Builds sources 6 and 7, then renders all seven to PDF via headless Chrome,
# which is the only PDF engine present on this machine.
import io
import os
import re
import subprocess
import json
from datetime import datetime

PACK = r"C:\Users\johnp\OneDrive\Desktop\ACE FULL HISTORY\05 STORY PACK (for NotebookLM)"
DOWNLOADS = r"C:\Users\johnp\Downloads\ACE STORY PACK"
TRANSCRIPTS = r"C:\Users\johnp\OneDrive\Desktop\ACE FULL HISTORY\04 READABLE TRANSCRIPTS (timestamped)"
ENGINE = r"D:\FoundryVTT\Data\worlds\hijinx\ace-engine"
LIVE = r"D:\FoundryVTT\Data\ace-backups\live\payload.json"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"


def write(name, body, folder=PACK):
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, name)
    io.open(path, "w", encoding="utf-8").write(body)
    print(f"   {os.path.getsize(path):>10,}  {name}")
    return path


# ══ 6. THE CONVERSATIONS — Johnny describing his own table ══════════════════
#
# 446 transcripts, five months. Most of it is us building modules. Buried in it
# is Johnny telling me what happened at his table in his own words, which exists
# nowhere else: not in a journal, not in the history log, not in a session
# summary. That is the most alive writing in the whole archive.

PARTY = ["Firaxis Greenbeard", "Firaxis", "Jeth", "Chudd Buckland", "Chudd",
         "Syrax Razeson", "Syrax", "Virric Vaesoldandros", "Virric", "Varric",
         "Jexx", "King"]

CAMPAIGN = PARTY + [
    "Strahd", "Barovia", "Vallaki", "Krezk", "Berez", "Argynvostholt",
    "Amber Temple", "Yester Hill", "Tser Pool", "Ravenloft", "Vistani",
    "Ireena", "Ismark", "Kasimir", "Ezmerelda", "Van Richten", "Madam Eva",
    "Rahadin", "Escher", "Izek", "Vasilka", "The Abbot", "Vilnius", "Varek",
    "Sergei", "Tatyana", "Baba Lysaga", "Vladimir", "Kavan", "Savid",
    "Wachter", "Blinsky", "Rictavio", "Arabelle", "Morgantha", "Bluto",
    "Donavich", "Doru", "Kolyan", "Milivoj", "Stella", "Victor Vallakovich",
    "Fiona Wachter", "Lady Wachter", "Yester", "Wizard of Wines", "Bildrath",
    "Old Bonegrinder", "Death House", "Tsolenka", "Mount Baratok",
    "Amber Collective", "Order of the Silver Dragon", "Keepers of the Feather",
]

# A message full of these is us building software, not him telling a story.
CODE = re.compile(
    r"\b(function|const |let |=>|return |console\.|import |export |async |await )"
    r"|\.mjs\b|\.json\b|\.css\b|\bnpm\b|\bgit \b|\{\}|\(\)|=>|;\s*$|\bAPI\b"
    r"|\bhook\b|\bcommit\b|\bpush\b|\brepo\b|\bdebug\b|\bconsole\b|\berror\b"
    r"|\bfunction\b|\bmodule\b|\bsetting\b|\bF5\b|\breload\b", re.I)

MSG_RE = re.compile(
    r"^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \w{3}\]\s+([A-Z]+):\s*$")


def _messages(path):
    """Yield (date, time, speaker, text) from one readable transcript."""
    speaker = date = time = None
    buf = []
    for line in io.open(path, encoding="utf-8", errors="ignore"):
        m = MSG_RE.match(line.rstrip("\n"))
        if m:
            if speaker and buf:
                yield date, time, speaker, "\n".join(buf).strip()
            date, time, speaker = m.group(1), m.group(2), m.group(3)
            buf = []
        elif speaker is not None:
            buf.append(line.rstrip("\n").strip())
    if speaker and buf:
        yield date, time, speaker, "\n".join(buf).strip()


def conversations():
    files = []
    for root, _dirs, names in os.walk(TRANSCRIPTS):
        for n in names:
            if n.endswith(".txt") and n != "INDEX.txt":
                files.append(os.path.join(root, n))
    files.sort()

    found = []
    scanned = 0
    for path in files:
        for date, time, speaker, text in _messages(path):
            scanned += 1
            if speaker != "JOHNNY":
                continue
            if not (60 < len(text) < 3000):
                continue
            if text.startswith("This session is being continued"):
                continue
            hits = [c for c in CAMPAIGN if c.lower() in text.lower()]
            if not hits:
                continue
            # Weigh story words against build words. A message that names three
            # characters and no code is him talking about his game.
            code_hits = len(CODE.findall(text))
            names = len(set(hits))
            if code_hits > names * 2:
                continue
            found.append((date, time, sorted(set(hits))[:6], text))

    found.sort(key=lambda r: (r[0], r[1]))
    seen = set()
    unique = []
    for date, time, hits, text in found:
        fp = re.sub(r"\W+", "", text.lower())[:180]
        if fp in seen:
            continue
        seen.add(fp)
        unique.append((date, time, hits, text))

    body = ["# The Conversations",
            "",
            "Johnny describing his own table, in his own words, pulled from five months "
            "of working sessions. This is the only place some of it was ever written "
            "down. It is not a tidy record: it is him talking about what happened, what "
            "went wrong, and what he wanted to happen next.",
            "",
            f"{len(unique)} passages, from {scanned:,} messages across {len(files)} "
            f"conversations.",
            ""]
    current = None
    for date, time, hits, text in unique:
        if date != current:
            body.append(f"\n\n## {date}\n")
            current = date
        body.append(f"\n**{time}** · <sub>{', '.join(hits)}</sub>\n")
        for para in text.split("\n"):
            if para.strip():
                body.append(f"> {para.strip()}")
        body.append("")
    return write("06 - THE CONVERSATIONS.md", "\n".join(body)), len(unique)


# ══ 7. THE FACTIONS — who belongs where, and who hates whom ═════════════════
#
# ⚠️ THE FIRST ATTEMPT FOUND ONE FACTION INSTEAD OF 453. It went looking for the
# registry inside the backup's `settings` block, because that is where a Foundry
# world setting normally lives. The ACE backup does not store it there: it lifts
# the registry to the TOP LEVEL of the payload as `factionRegistry`. `settings`
# is not empty in that payload, it is absent entirely, so the lookup returned
# nothing and the fallback picked up the wrapper object and called it a faction.
#
# The give-away was in the output and I nearly shipped past it: "1 factions ·
# 251 carry a recorded standing". A standing for 251 things that do not exist
# is not a small discrepancy, it is the reader pointing at its own bug.
def factions():
    def load(path):
        try:
            return json.load(io.open(path, encoding="utf-8"))
        except Exception as exc:
            print(f"   ! {os.path.basename(path)}: {exc}")
            return {}

    payload = load(LIVE)
    catalogue = payload.get("factionRegistry") or {}
    if isinstance(catalogue, dict) and "factions" in catalogue:
        catalogue = catalogue["factions"]

    rep = load(os.path.join(ENGINE, "ace-party-reputation.json"))
    standing = rep.get("factionStanding") or {}
    deeds = load(os.path.join(ENGINE, "ace-deeds.json"))
    deed_rows = (deeds.get("deeds") if isinstance(deeds, dict) else deeds) or []
    if not deed_rows:
        deed_rows = rep.get("deeds") or []

    # Rosters are stored as actor ids. A list of ids tells a reader nothing.
    names = {}
    for a in (payload.get("actors") or []):
        if isinstance(a, dict) and a.get("_id"):
            names[a["_id"]] = a.get("name") or a["_id"]
        elif isinstance(a, dict) and a.get("id"):
            names[a["id"]] = a.get("name") or a["id"]

    def resolve(vals):
        out = []
        for v in (vals or []):
            if isinstance(v, dict):
                v = v.get("name") or v.get("id") or ""
            v = str(v)
            out.append(names.get(v, v))
        return [n for n in out if n]

    rows = []
    for fid, f in (catalogue or {}).items():
        if not isinstance(f, dict):
            continue
        rows.append((f.get("name") or fid, fid, f, standing.get(fid, "unrecorded")))
    rows.sort(key=lambda r: r[0].lower())

    peopled = sum(1 for r in rows if r[2].get("members"))
    opinions = [r for r in rows if r[3] not in ("neutral", "unrecorded")]

    body = ["# The Factions",
            "",
            "Every organised power ACE knows about: what it wants, who leads it, who "
            "stands in it, who it counts as friend and enemy, and where your party "
            "sits with it.",
            "",
            f"{len(rows)} factions · {peopled} have members in your world · "
            f"{len(opinions)} have formed an opinion of the party · "
            f"{len(deed_rows)} deeds logged.",
            ""]

    if opinions:
        body.append("\n## Factions that have an opinion of the party\n")
        body.append("| Faction | Standing |")
        body.append("|---|---|")
        for name, _fid, _f, st in opinions:
            body.append(f"| {name} | **{st}** |")
    else:
        body.append("\nNo faction has moved off neutral yet. Every standing on record "
                    "is the value it started at.\n")

    body.append("\n\n## Factions with people in them\n")
    body.append("These are the ones that actually matter at the table: something in "
                "your world belongs to them.\n")
    for name, fid, f, st in rows:
        if not f.get("members"):
            continue
        body.append(f"\n### {name}\n")
        body.append(_faction_facts(f, st))
        body.append(_faction_prose(f))
        roster = resolve(f.get("members"))
        if roster:
            body.append(f"\n**Members ({len(roster)}):** {', '.join(roster[:60])}"
                        + (f" and {len(roster) - 60} more" if len(roster) > 60 else ""))
        for key, label in (("allies", "Allies"), ("enemies", "Enemies")):
            vals = resolve(f.get(key))
            if vals:
                body.append(f"\n**{label}:** {', '.join(vals)}")

    body.append("\n\n## Every other faction\n")
    body.append("Known powers with nobody in your world assigned to them yet.\n")
    for name, fid, f, st in rows:
        if f.get("members"):
            continue
        body.append(f"\n### {name}\n")
        body.append(_faction_facts(f, st))
        body.append(_faction_prose(f))
        for key, label in (("allies", "Allies"), ("enemies", "Enemies")):
            vals = resolve(f.get(key))
            if vals:
                body.append(f"\n**{label}:** {', '.join(vals)}")

    if deed_rows:
        body.append("\n\n## The deed ledger\n")
        body.append("Everything the party has done that anybody wrote down.\n")
        for d in deed_rows:
            if not isinstance(d, dict):
                body.append(f"- {d}")
                continue
            text = d.get("text") or d.get("txt") or d.get("summary") or ""
            when_ = d.get("date") or d.get("t") or ""
            kind = d.get("classification") or d.get("kind") or d.get("category") or ""
            who = d.get("a") or d.get("actor") or ""
            if not text:
                continue
            tail = " · ".join(str(b) for b in (kind, who, when_) if b)
            body.append(f"- {text}" + (f"  \n  <sub>{tail}</sub>" if tail else ""))
    return write("07 - THE FACTIONS.md", "\n".join(body)), len(rows)


def _faction_facts(f, standing):
    facts = []
    for key, label in (("type", "Type"), ("tier", "Tier"), ("scope", "Scope"),
                       ("nation", "Nation"), ("creatureBase", "Made up of"),
                       ("stability", "Stability"), ("leader", "Led by"),
                       ("headquarters", "Seat"), ("scene", "Found at"),
                       ("worldTag", "Story")):
        val = f.get(key)
        if val and isinstance(val, str):
            facts.append(f"**{label}:** {val}")
    facts.append(f"**Standing with the party:** {standing}")
    return " · ".join(facts)


def _faction_prose(f):
    out = []
    for key in ("purpose", "description", "lore"):
        val = f.get(key)
        if isinstance(val, str) and len(val.strip()) > 20:
            out.append("\n" + re.sub(r"<[^>]*>", " ", val).strip())
    return "".join(out)


# ══ Markdown to a printable page ════════════════════════════════════════════
#
# ⚠️ No markdown library is installed and none of the usual PDF engines are
# either. Chrome is. So the markdown is rendered by hand into HTML and Chrome
# prints it, which also gives real page breaks and a readable serif face.

CSS = """
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }
body { font: 10.5pt/1.55 Georgia, 'Times New Roman', serif; color: #1a1a1a; }
h1 { font-size: 22pt; color: #6b4a12; border-bottom: 2px solid #c9a84c;
     padding-bottom: 6px; margin: 0 0 14px; page-break-after: avoid; }
h2 { font-size: 15pt; color: #7a5a1a; margin: 22px 0 8px; border-bottom: 1px solid #ddd0a8;
     padding-bottom: 3px; page-break-after: avoid; }
h3 { font-size: 12.5pt; color: #4a3a12; margin: 16px 0 5px; page-break-after: avoid; }
p, li { margin: 4px 0; }
ul { margin: 4px 0 8px 0; padding-left: 20px; }
blockquote { margin: 5px 0 5px 14px; padding: 2px 0 2px 12px;
             border-left: 3px solid #c9a84c; color: #33302a; }
sub { font-size: 8.5pt; color: #6f6a5e; }
hr { border: 0; border-top: 1px solid #c9a84c; margin: 20px 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 14px;
        font-size: 9.5pt; page-break-inside: avoid; }
th { background: #f0e6c8; text-align: left; }
th, td { border: 1px solid #d8cca4; padding: 4px 7px; vertical-align: top; }
strong { color: #000; }
.meta { color: #6f6a5e; font-size: 9pt; margin-bottom: 18px; }
"""

INLINE = [
    (re.compile(r"\*\*(.+?)\*\*"), r"<strong>\1</strong>"),
    (re.compile(r"(?<![\w*])\*([^*\n]+?)\*(?![\w*])"), r"<em>\1</em>"),
    (re.compile(r"`([^`]+)`"), r"<code>\1</code>"),
]


def _inline(text):
    text = (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    # <sub> is ours and deliberate, so it survives escaping.
    text = text.replace("&lt;sub&gt;", "<sub>").replace("&lt;/sub&gt;", "</sub>")
    for pattern, repl in INLINE:
        text = pattern.sub(repl, text)
    return text


def md_to_html(md, title):
    out = []
    lines = md.split("\n")
    i = 0
    in_list = False

    def close_list():
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    while i < len(lines):
        line = lines[i].rstrip()
        stripped = line.strip()

        if stripped.startswith("|") and i + 1 < len(lines) and \
                re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            close_list()
            header = [c.strip() for c in stripped.strip("|").split("|")]
            out.append("<table><thead><tr>"
                       + "".join(f"<th>{_inline(c)}</th>" for c in header)
                       + "</tr></thead><tbody>")
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                out.append("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in cells) + "</tr>")
                i += 1
            out.append("</tbody></table>")
            continue

        if not stripped:
            close_list()
            i += 1
            continue
        if stripped.startswith("### "):
            close_list()
            out.append(f"<h3>{_inline(stripped[4:])}</h3>")
        elif stripped.startswith("## "):
            close_list()
            out.append(f"<h2>{_inline(stripped[3:])}</h2>")
        elif stripped.startswith("# "):
            close_list()
            out.append(f"<h1>{_inline(stripped[2:])}</h1>")
        elif stripped.startswith("---"):
            close_list()
            out.append("<hr>")
        elif stripped.startswith("> "):
            close_list()
            out.append(f"<blockquote>{_inline(stripped[2:])}</blockquote>")
        elif stripped.startswith("- "):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{_inline(stripped[2:])}</li>")
        else:
            close_list()
            out.append(f"<p>{_inline(stripped)}</p>")
        i += 1
    close_list()
    return (f"<!doctype html><html><head><meta charset='utf-8'>"
            f"<title>{title}</title><style>{CSS}</style></head>"
            f"<body>{''.join(out)}</body></html>")


def to_pdf(md_path, out_dir):
    name = os.path.splitext(os.path.basename(md_path))[0]
    md = io.open(md_path, encoding="utf-8").read()
    html_path = os.path.join(out_dir, name + ".html")
    io.open(html_path, "w", encoding="utf-8").write(md_to_html(md, name))
    pdf_path = os.path.join(out_dir, name + ".pdf")
    url = "file:///" + html_path.replace("\\", "/").replace(" ", "%20")
    proc = subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
         "--no-pdf-header-footer", "--run-all-compositor-stages-before-draw",
         "--virtual-time-budget=120000", f"--print-to-pdf={pdf_path}", url],
        capture_output=True, timeout=900)
    if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 2000:
        os.remove(html_path)
        return pdf_path, os.path.getsize(pdf_path)
    return None, (proc.stderr or b"")[-300:]


def main():
    print("BUILDING SOURCES 6 AND 7")
    print("=" * 74)
    conversations()
    factions()

    print("\nRENDERING EVERY SOURCE TO PDF")
    print("=" * 74)
    os.makedirs(DOWNLOADS, exist_ok=True)
    # ⚠️ 08 HAS ITS OWN BUILDER AND THIS ONE DESTROYS IT. build-cast-bible.py
    # embeds seven portraits as base64; the markdown twin beside it carries only
    # the text. Rendering that twin here silently replaced a 567 KB illustrated
    # PDF with an 89 KB one containing no pictures at all, and reported success.
    OWN_BUILDER = ("08 - THE COMPANY AND THE ABBEY.md",)
    mds = sorted(f for f in os.listdir(PACK)
                 if f.endswith(".md") and f not in OWN_BUILDER)
    total = 0
    for f in mds:
        path, size = to_pdf(os.path.join(PACK, f), DOWNLOADS)
        if path:
            total += size
            print(f"   {size:>10,}  {os.path.basename(path)}")
        else:
            print(f"   FAILED  {f}  {size}")

    # The read-me rides along so the folder explains itself.
    readme = os.path.join(PACK, "00 READ ME FIRST.txt")
    if os.path.exists(readme):
        import shutil
        shutil.copy2(readme, os.path.join(DOWNLOADS, "00 READ ME FIRST.txt"))

    print(f"\n{len(mds)} PDFs, {total:,} bytes total")
    print(f"in: {DOWNLOADS}")
    print(f"built {datetime.now().strftime('%Y-%m-%d %H:%M')}")


if __name__ == "__main__":
    main()
