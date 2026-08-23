# ─── ACE Engine — the Cast Bible, for Gemini Notebook ───────────────────────
#
# Johnny, 2026-08-22, on his first Video Overview: "Firaxis Greenbeard looks
# like a human, not a Dragonborn... It didn't mention the Abbey at all or the
# Flesh Golem or anything... make sure that it's not showing screenshots of the
# document we uploaded."
#
# ⚠️ THREE CAUSES, ALL MEASURABLE, NONE OF THEM THE MODEL BEING STUPID.
#
#  1. ACE HAS NEVER RECORDED SPECIES. It stores class and level and nothing
#     about what anybody IS. The word "dragonborn" appears 9 times in 900 KB of
#     source against 796 for "Argynvostholt". The model drew a human because
#     almost nothing told it otherwise.
#
#  2. THE VIDEO PUT RAW LOG LINES ON SCREEN because that is what I gave it.
#     Frames from the finished video show "[NPC Conversation] ...", "BM:
#     Argynvostholt 1F", the magnitude tag "trivial", a party list containing
#     "Group Map Token" and "download", and dice outcomes rendered as story.
#     The chronicle was a log wearing a narrative coat.
#
#  3. THE FLESH GOLEM APPEARS ZERO TIMES IN ANY SOURCE. Not thin: absent. The
#     Abbey is present but at 63 mentions against Argynvostholt's 796, so a
#     video weighted by frequency will never reach for it. There IS a full
#     session summary about the Abbey sitting in the data, which is exactly why
#     the AUDIO overview covered it well and the video did not.
#
# This document is the fix for all three: species and appearance written the way
# an artist needs them, portraits embedded so the real faces are on screen, the
# Abbey written out properly, and an instruction block telling Gemini Notebook
# to narrate rather than quote.
import base64
import io
import os
import subprocess

OUT_DIR = r"C:\Users\johnp\Downloads\ACE STORY PACK"
PACK = r"C:\Users\johnp\OneDrive\Desktop\ACE FULL HISTORY\05 STORY PACK (for NotebookLM)"
DATA = r"D:\FoundryVTT\Data"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
FFMPEG = os.path.expanduser(
    r"~\AppData\Local\Microsoft\WinGet\Packages"
    r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    r"\ffmpeg-8.0.1-full_build\bin\ffmpeg.exe")
TMP = os.path.join(os.environ.get("TEMP", "."), "ace-cast")


# ⚠️ Portraits are 6-7 MB PNGs. Embedded raw as base64 that is a 50 MB page
# that Chrome takes minutes to lay out. Resized to 700px they are ~80 KB each
# and lose nothing a video generator will ever see.
def portrait(path, name):
    src = os.path.join(DATA, path)
    if not os.path.exists(src):
        print(f"   MISSING  {name}: {path}")
        return ""
    os.makedirs(TMP, exist_ok=True)
    dst = os.path.join(TMP, name.replace(" ", "_") + ".jpg")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", src,
                    "-vf", "scale=700:-1:force_original_aspect_ratio=decrease",
                    "-q:v", "4", dst], check=False)
    if not os.path.exists(dst):
        print(f"   FAILED   {name}")
        return ""
    b64 = base64.b64encode(io.open(dst, "rb").read()).decode("ascii")
    print(f"   ok       {name}  ({os.path.getsize(dst)//1024} KB)")
    return f"data:image/jpeg;base64,{b64}"


# ── The party ────────────────────────────────────────────────────────────────
#
# Descriptions written from the portraits themselves, in the language an image
# generator can act on: species first, then build, colouring, dress and weapon.
# Class and level come from ace-pcs.json, which is now correct at source even
# though the journals still show the old figures.
CAST = [
    {
        "name": "Chudd Buckland",
        "img": r"PCs\Chudd\Chudd POR.png",
        "line": "Stout halfling · Druid, 9th level",
        "look": (
            "A stout halfling: short, broad and barefoot, with the wide hairy feet of his "
            "people. Middle-aged and weathered, with a thick mop of curly grey-brown hair "
            "and a lined, wry face. He wears layered brown leather and undyed homespun, and "
            "the whole of it is overgrown: living green vines, cushions of moss and orange "
            "and green leaves trail from his shoulders, collar and belt. Bone charms, "
            "acorns and small pouches hang at his waist. He carries a twisted wooden staff "
            "crowned with a pair of stag antlers cradling a large glowing white crystal."),
        "traits": (
            "Never armoured, never shod. He looks like part of the forest walked in and sat "
            "down. He brought down Strahd's dire wolf in the courtyard at the Abbey, and he "
            "was the one who took the Celestial Star Chart of the Lower Planes out of the "
            "Amber Temple, which says something about what interests him."),
    },
    {
        "name": "Firaxis Greenbeard",
        "img": r"NPCs\PORTRAITS\Firaxis Portrait.png",
        "line": "Green dragonborn · Paladin, 9th level · Folk Hero",
        "look": (
            "A GREEN DRAGONBORN, not a human. Deep forest-green scales, a long reptilian "
            "muzzle, a heavy ridged brow and two long ivory horns sweeping back from his "
            "skull. A thick scaled tail. He wears heavy ornate plate of pale steel chased "
            "with gold filigree and carries a large round gold shield with engraved "
            "scrollwork. Red battle scars cross the scales of his chest and snout. His "
            "sword burns golden-white: Dawnbringer, the legendary blade recovered at "
            "Argynvostholt."),
        "traits": (
            "He is a dragonborn. He has never been human and no depiction should show human "
            "skin or hair. He talks before he fights, to everything: mongrelfolk, skeletons, "
            "air elementals, a lich, a ghost. He also has more kills than anyone else in the "
            "company. A folk hero who tries diplomacy first and finishes what it starts."),
    },
    {
        "name": "Jeth",
        "img": r"PCs\Jexx & Jeth\Jeth 33.png",
        "line": "Albino drow elf of the Shatterkai · Assassin, 9th level",
        "look": (
            "An ALBINO DROW: chalk-white skin, long straight bone-white hair worn loose past "
            "the shoulders, sharply pointed ears and burning red eyes under a heavy scowl. "
            "Black spiderweb and skull tattoos cover his bare chest, shoulders and arms. Dark "
            "brown studded leather, a single spiked pauldron on the left shoulder, bracers, a "
            "belt heavy with pouches, worn boots. He fights with two blades at once, a slim "
            "silver rapier in one hand and a curved scimitar in the other."),
        "traits": (
            "He comes from the Shadowfell, and his people are the Shatterkai, which is where "
            "the party found him before he joined them. He opens fights rather than joins "
            "them: it was Jeth who put the first critical hit into The Abbot before anyone "
            "else had moved."),
    },
    {
        "name": "King",
        "img": r"PCs\KING\A Spectral King PORTRAIT -2.png",
        "line": "Spectral dire wolf · Wolf spirit",
        "look": (
            "A dire wolf made of light. Translucent, pale blue-white and green, his whole "
            "shape drifting like smoke caught in a current, the edges glowing. Pale burning "
            "eyes. He casts no solid shadow and nothing about him is opaque."),
        "traits": (
            "King was alive once, Firaxis's companion, and he was killed in battle in the "
            "Desert of Desolation trying to survive long enough to get back to him. He "
            "returned as a spirit, searched, and found the party in the woods outside "
            "Argynvostholt. He led them there. If the beacon is lit he becomes a mortal wolf "
            "again. He is loyal to the party and to Firaxis above all."),
    },
    {
        "name": "Steel Defender",
        "img": r"PCs\Steel Defender\2014-steel-defender.webp",
        "line": "Construct · Virric's creation",
        "look": (
            "A mechanical hound of brass and steel: riveted armour plates in copper, bronze "
            "and dull silver, exposed gearing along the spine, pipes and cables running "
            "between the joints, and glowing lenses set where the eyes would be. Four legs "
            "ending in articulated steel claws. Built, not born."),
        "traits": (
            "Virric made him and Virric keeps him running. He has been at every fight the "
            "company has been in, including the ones where the written record forgets to "
            "name him. He was destroyed once, at the Amber Temple, and rebuilt."),
    },
    {
        "name": "Syrax Razeson",
        "img": r"PCs\Syrax\Syrax.jpg",
        "line": "Aasimar · Warlock 7 / Paladin 2 · Hermit",
        "look": (
            "An AASIMAR, celestial-blooded. Tall, armoured in dark spiked steel plate over "
            "layered brown and grey robes. Dark brown hair pulled back into tight braids. "
            "His eyes burn a hard electric blue and throw that light onto his own face, which "
            "is the mark of what he is. He carries an ornate polearm with a wide fluted head: "
            "the Blood Halberd."),
        "traits": (
            "Half holy warrior and half something that struck a bargain, and the two do not "
            "sit easily together. A hermit before he travelled with these people. It was his "
            "Blood Halberd that killed The Abbot, a fallen deva, which is a strange thing "
            "for a man with celestial blood to have done."),
    },
    {
        "name": "Virric Vaesoldandros",
        "img": r"PCs\VIRRIC\Virric POR.png",
        "line": "High elf · Artificer, 9th level · Soldier",
        "look": (
            "A HIGH ELF: lean and fine-boned, with a shaved or close-cropped head and a "
            "plain, focused face. Practical brown leather and olive canvas hung with brass "
            "instruments: gauges, gears, a shoulder rig of clockwork, glowing vials of blue, "
            "orange and green at his belt, tools in every loop. He carries a long spear whose "
            "haft is inlaid with runes glowing blue and orange along its length."),
        "traits": (
            "The maker. The Steel Defender is his, and so is most of what the company "
            "carries. A soldier before he was an artificer. When the fighting at the Abbey "
            "stopped, what he took off The Abbot's body was the correspondence and the "
            "surgical notes, not the treasure."),
    },
]


ABBEY = """
The Abbey of Saint Markovia stands above the village of Krezk, and what the party
found inside it was not a sanctuary.

Scarecrows line the abbey walls, facing outward, dressed in tattered chain shirts
and carrying spears with rusted heads. The courtyard below them is blanketed in fog.
Inside, the halls are given over to the mongrelfolk: twisted, patchwork people, the
failed work of something that once knew better. **Firaxis Greenbeard** went through
those chambers talking rather than fighting, to the Mongrelfolk and to **Marzena
Belview**, gathering what he could about the horrors ahead. **Clovin Belview**, who
insists to anyone listening that he is smarter than they are, took a liking to the
party and told them what lay beyond the arched room: a vast chamber to the east, and
to the west a landing where the stairs curl down into darkness on one side and climb
into thick drapes of cobwebs on the other.

At the heart of it was **The Abbot**. Once a deva, a genuinely holy thing, and now
warped by centuries of Barovia into something that believed it was still doing good
work. Beside him stood **Vasilka**, his masterpiece: a bride stitched together out of
parts, built as a gift for Strahd.

Diplomacy failed and the fight was short and vicious. **Jeth** opened it with a
devastating critical hit. **Syrax Razeson's** Blood Halberd finished it, striking The
Abbot down. **Ezmerelda d'Avenir** destroyed Vasilka with a thrown handaxe. Among the
spoils the party took **Tatyana's Locket**, **Saint Markovia's Blessed Pendant**, The
Abbot's own correspondence and surgical notes, and a **Figurine of Wondrous Power**.

The victory lasted minutes. **Count Strahd von Zarovich** came into the courtyard
himself, with his dire wolf and his vampire spawn, and greeted them:

> "Ah, the brave souls of Barovia have come to face their demise in my garden of
> despair! How delightful!"

What followed cost the party badly. Strahd killed **Ismark Kolyanovich**, and he
killed **Clovin Belview**, who had helped them an hour earlier. **Virric** destroyed
the vampire spawn and **Chudd** brought down the dire wolf, but Strahd left under his
own power, bloodied, promising that this was not the end of it.

They went from the Abbey to the Amber Temple, where six enormous amber statues of
faceless hooded figures stand before the entrance with their hands pressed together
in eternal prayer.
"""


def main():
    print("BUILDING THE CAST BIBLE")
    print("=" * 74)
    cards = []
    for c in CAST:
        src = portrait(c["img"], c["name"])
        img = (f'<img class="por" src="{src}" alt="{c["name"]}">' if src
               else '<div class="por missing">portrait not on disk</div>')
        cards.append(f"""
        <div class="card">
          {img}
          <div class="body">
            <h2>{c["name"]}</h2>
            <p class="line">{c["line"]}</p>
            <p>{c["look"]}</p>
            <p class="note">{c["traits"]}</p>
          </div>
        </div>""")

    import re
    # ⚠️ COLLAPSE THE LINE BREAKS BEFORE CONVERTING BOLD. The source text is
    # wrapped at 80 columns, so "**Marzena\nBelview**" puts a newline inside the
    # marker pair. Without DOTALL the pattern cannot match across it, so it
    # silently pairs the NEXT two markers instead and the page renders a literal
    # "**Marzena Belview<strong>". Two stray asterisks in the output were the
    # only sign, and they are easy to read past.
    paragraphs = [re.sub(r"\s+", " ", p).strip() for p in ABBEY.strip().split("\n\n")]
    paragraphs = [re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", p, flags=re.S)
                  for p in paragraphs if p]
    abbey_html = "\n".join(
        f"<blockquote>{p[2:].strip()}</blockquote>" if p.startswith("> ") else f"<p>{p}</p>"
        for p in paragraphs)

    html = f"""<!doctype html><html><head><meta charset="utf-8">
<title>The Company and the Abbey</title><style>
@page {{ size: A4; margin: 16mm; }}
body {{ font: 11pt/1.6 Georgia,'Times New Roman',serif; color:#1a1a1a; }}
h1 {{ font-size:24pt; color:#6b4a12; border-bottom:3px solid #c9a84c;
      padding-bottom:8px; margin:0 0 6px; }}
h2 {{ font-size:16pt; color:#7a5a1a; margin:0 0 2px; }}
h3 {{ font-size:14pt; color:#6b4a12; margin:26px 0 8px;
      border-bottom:1px solid #ddd0a8; padding-bottom:4px; }}
.sub {{ color:#6f6a5e; font-size:10pt; margin:0 0 20px; }}
.rules {{ background:#faf4e2; border:1px solid #d8cca4; border-left:5px solid #c9a84c;
          padding:14px 18px; margin:0 0 24px; }}
.rules li {{ margin:6px 0; }}
.card {{ display:flex; gap:18px; align-items:flex-start; page-break-inside:avoid;
         margin:0 0 22px; padding:0 0 20px; border-bottom:1px solid #e6ddc2; }}
.por {{ width:190px; border-radius:6px; background:#f3ece0; flex:0 0 auto; }}
.por.missing {{ width:190px; height:190px; display:flex; align-items:center;
                justify-content:center; color:#9a9384; font-size:9pt; text-align:center; }}
.body {{ flex:1; }}
.line {{ font-style:italic; color:#7a5a1a; margin:0 0 8px; font-size:11pt; }}
.roster {{ width:100%; border-collapse:collapse; margin:0 0 26px; font-size:10.5pt; }}
.roster th {{ background:#f0e6c8; text-align:left; }}
.roster th, .roster td {{ border:1px solid #d8cca4; padding:5px 9px; }}
.note {{ color:#5a5348; font-size:10pt; border-left:3px solid #c9a84c;
         padding-left:10px; margin-top:10px; }}
blockquote {{ margin:10px 0 10px 16px; padding:4px 0 4px 14px;
              border-left:3px solid #c9a84c; font-style:italic; color:#33302a; }}
p {{ margin:8px 0; }}
strong {{ color:#000; }}
</style></head><body>

<h1>The Company and the Abbey</h1>
<p class="sub">Reference sheet for the Barovia campaign. Who these people are, what they
look like, and what happened at the Abbey of Saint Markovia.</p>

<div class="rules">
<strong>How to use this document</strong>
<ul>
<li><strong>This is the authority on what the characters look like.</strong> Where any
other source disagrees, or says nothing, use what is written here.</li>
<li><strong>Firaxis Greenbeard is a green dragonborn.</strong> Scales, muzzle, horns and
tail. He is not a human and must never be drawn as one.</li>
<li><strong>All seven travel together.</strong> Chudd, Firaxis, Jeth, King, the Steel
Defender, Syrax and Virric. Any scene showing the party should show all seven, including
King the spectral wolf and the Steel Defender, both of whom were present at every fight
even where the written record does not name them.</li>
<li><strong>Narrate the story. Do not put the source documents on screen.</strong> Never
show pages of notes, bullet lists, log lines, file excerpts or screenshots of the
uploaded text. Tell what happened in continuous prose over original imagery.</li>
<li><strong>Ignore anything that reads as machine output</strong>: map codes beginning
"BM:" or "SC:", labels like "trivial" or "local", entries named "Group Map Token" or
"download", and dice results such as hits, misses, criticals and fumbles. None of that
is part of the story.</li>
</ul>
</div>

<h3>The company at a glance</h3>
<table class="roster">
<tr><th>Name</th><th>Species</th><th>Class</th></tr>
<tr><td>Chudd Buckland</td><td>Stout halfling</td><td>Druid 9</td></tr>
<tr><td>Firaxis Greenbeard</td><td><strong>Green dragonborn</strong></td><td>Paladin 9</td></tr>
<tr><td>Jeth</td><td>Albino drow elf, of the Shatterkai</td><td>Assassin 9</td></tr>
<tr><td>King</td><td>Spectral dire wolf</td><td>Wolf spirit</td></tr>
<tr><td>Steel Defender</td><td>Construct</td><td>Virric's creation</td></tr>
<tr><td>Syrax Razeson</td><td>Aasimar</td><td>Warlock 7 / Paladin 2</td></tr>
<tr><td>Virric Vaesoldandros</td><td>High elf</td><td>Artificer 9</td></tr>
</table>

<h3>The company</h3>
{"".join(cards)}

<h3>The Abbey of Saint Markovia</h3>
{abbey_html}

<h3>A note on what is missing</h3>
<p>Two things happened at this table that the written record does not contain. There was
a <strong>fight at a campfire that split the party</strong>, and there was a
<strong>flesh golem</strong>. Neither appears anywhere in the source documents, so nothing
generated from them can mention either. They are named here so that their absence is
understood as a gap in the record rather than a gap in the campaign.</p>

</body></html>"""

    os.makedirs(OUT_DIR, exist_ok=True)
    html_path = os.path.join(OUT_DIR, "08 - THE COMPANY AND THE ABBEY.html")
    io.open(html_path, "w", encoding="utf-8").write(html)
    pdf_path = os.path.join(OUT_DIR, "08 - THE COMPANY AND THE ABBEY.pdf")
    url = "file:///" + html_path.replace("\\", "/").replace(" ", "%20")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
                    "--no-pdf-header-footer", "--run-all-compositor-stages-before-draw",
                    "--virtual-time-budget=60000", f"--print-to-pdf={pdf_path}", url],
                   capture_output=True, timeout=600)
    if os.path.exists(pdf_path):
        os.remove(html_path)
        print(f"\n   {os.path.getsize(pdf_path):,} bytes  {pdf_path}")
    else:
        print("\n   PDF FAILED; the HTML is still there:", html_path)

    # Keep a markdown twin in the story pack so a rebuild picks it up.
    md = ["# The Company and the Abbey", "",
          "Reference sheet for the Barovia campaign.", ""]
    for c in CAST:
        md += [f"\n## {c['name']}", f"\n*{c['line']}*", f"\n{c['look']}", f"\n> {c['traits']}"]
    md += ["\n\n## The Abbey of Saint Markovia\n", ABBEY.strip()]
    io.open(os.path.join(PACK, "08 - THE COMPANY AND THE ABBEY.md"), "w",
            encoding="utf-8").write("\n".join(md))
    print("   markdown twin written to the story pack.")


if __name__ == "__main__":
    main()
