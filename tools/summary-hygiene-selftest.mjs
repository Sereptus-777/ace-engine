// ─── Who was at the table, and what the voice says out loud ─────────────────
//
// Two things Johnny reported on 2026-09-06, both of which put words in front of
// his players that nobody wrote.
//
// ⚠️🔴 THE PARTY LIST WAS THE ACTORS SIDEBAR. *"under Party it says Hammer the
// Test Fighter and Jexxi is in there. Fucking anybody I ever had, it's got to
// stop saying that all those people are not there."* The list goes into the
// PROMPT, so the model wrote absent people into the story, and the summary then
// feeds the video pipeline, which repeats it.
//
// ⚠️🔴 AND MY FIRST FIX WAS THE SIDEBAR WEARING A HAT. It cross-checked the
// directory against the event log and the connected user list. Cleverer, still
// the wrong question, and he said so within the hour: *"All it's doing is
// reading whatever's in my actor sidebar for players... That's bullshit. It's
// got to read the scene."*
//
// He is right and it is not a preference. This is a virtual tabletop. A
// character who was in the session HAS A TOKEN ON THE MAP. The map is the room.
//
// ⚠️🔴 THE VOICE ALSO SAID "NARRATION". *"It would say 'Narration: you fumble'...
// but it would say it out loud too."* The crit prompt casts the model as a
// narrator, and models answer a role by announcing it.
//
// Run:  node tools/summary-hygiene-selftest.mjs

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

// ── The two decisions, mirrored from the modules and asserted against the
//    source at the end so they cannot drift apart. ─────────────────────────
const scenesVisited = (events, allScenes, viewed) => {
  const out = new Map();
  for (const e of (events ?? [])) {
    if (!e?.s) continue;
    const sc = allScenes.find(x => x.name === e.s);
    if (sc) out.set(sc.id, sc);
  }
  if (!out.size && viewed) out.set(viewed.id, viewed);
  return [...out.values()];
};
const partyPresent = (events, allScenes, viewed) => {
  const present = new Map();
  for (const scene of scenesVisited(events, allScenes, viewed)) {
    for (const t of (scene.tokens ?? [])) {
      const a = t.actor;
      if (!a?.hasPlayerOwner || a.type !== "character") continue;
      if (!present.has(a.name)) present.set(a.name, scene.name);
    }
  }
  return [...present.keys()];
};

const stripLabel = (text) => {
  let out = String(text ?? "").replace(/\[\/?(?:NARRATION|narration)\]/g, "").trim();
  const LABEL = /^\s*[[(*_"'“‘]*\s*(?:narration|narrator|narrate|gm|dm|description|response|output|answer|result)\s*[*_]*\s*[:—-]\s*/i;
  const PREAMBLE = /^(?:here(?:'s| is)[^:]*:|sure[,!.]?\s*|okay[,!.]?\s*)/i;
  for (let i = 0; i < 4; i++) {
    const before = out;
    out = out.replace(LABEL, "").replace(PREAMBLE, "").trim();
    out = out.replace(/^[\])*_"'”’]+\s*/, "").trim();
    if (out === before) break;
  }
  return out;
};

const pc = (name) => ({ name, type: "character", hasPlayerOwner: true });
const npc = (name) => ({ name, type: "npc", hasPlayerOwner: false });
const scene = (id, name, ...actors) => ({ id, name, tokens: actors.map(a => ({ actor: a })) });

// His Actors directory as it stood when the bad summary was written. Every one
// of these is player-owned and typed "character", which is exactly why reading
// the sidebar could never tell them apart.
const SIDEBAR = [
  pc("ACE Test Dummy"), pc("Chudd Buckland"), pc("Firaxis Greenbeard"),
  pc("Group Map Token"), pc("Hammer the Test Fighter (Fighter 5) #2"),
  pc("Hammer the Test Fighter (Fighter 6)"), pc("Jeth"), pc("Jexx"),
  pc("King"), pc("Syrax Razeson"), pc("Virric Vaesoldandros"),
];
const find = (n) => SIDEBAR.find(a => a.name === n);

console.log("\nTHE SESSION THAT PRODUCED THE COMPLAINT");
{
  const lower = scene("s1", "AMBER TEMPLE: LOWER",
    find("Firaxis Greenbeard"), find("Jeth"), find("Syrax Razeson"),
    find("Virric Vaesoldandros"), npc("Ghast"), npc("Shield Guardian"));
  const got = partyPresent([{ s: "AMBER TEMPLE: LOWER", a: "Jeth" }], [lower], lower);

  check("the four with tokens on the map are listed", got,
    ["Firaxis Greenbeard", "Jeth", "Syrax Razeson", "Virric Vaesoldandros"]);
  // ⚠️🔴 THE WHOLE POINT. Every one of these is in the sidebar and none of them
  // is on the map.
  check("no test fighter", got.some(n => /Hammer/.test(n)), false);
  check("no test dummy", got.includes("ACE Test Dummy"), false);
  check("no group map token", got.includes("Group Map Token"), false);
  check("nobody who stayed home", got.includes("Jexx"), false);
  check("and no NPCs from the fight", got.some(n => /Ghast|Guardian/.test(n)), false);
}

console.log("\nA SESSION THAT MOVED ROOMS COUNTS BOTH");
{
  // ⚠️ NOT JUST THE SCENE THAT HAPPENS TO BE OPEN. A party that started in the
  // upper temple and finished below was in both places.
  const up = scene("s1", "AMBER TEMPLE: UPPER", find("King"));
  const down = scene("s2", "AMBER TEMPLE: LOWER", find("Jeth"));
  const events = [{ s: "AMBER TEMPLE: UPPER" }, { s: "AMBER TEMPLE: LOWER" }];
  check("both scenes contribute",
    partyPresent(events, [up, down], down).sort(), ["Jeth", "King"]);
}

console.log("\nSIX TOKENS OF ONE CHARACTER IS ONE NAME");
{
  const sc = scene("s1", "Barovia", find("King"), find("King"), find("King"));
  check("deduped", partyPresent([{ s: "Barovia" }], [sc], sc), ["King"]);
}

console.log("\nNO EVENTS MEANS THE SCENE HE IS LOOKING AT");
{
  const sc = scene("s1", "Barovia", find("Jeth"));
  check("falls back to the viewed scene, never the directory",
    partyPresent([], [sc], sc), ["Jeth"]);
}

console.log("\nAN EMPTY MAP SAYS NOTHING, NOT EVERYBODY");
{
  // ⚠️🔴 THE OLD FALLBACK WAS THE BUG. Listing the sidebar when the map holds
  // no players is exactly what put strangers into the prompt.
  const sc = scene("s1", "Empty Room", npc("Rat"));
  check("no player tokens yields an empty list",
    partyPresent([{ s: "Empty Room" }], [sc], sc), []);
}

console.log("\nA SCENE THAT NO LONGER EXISTS IS SKIPPED, NOT GUESSED");
{
  const sc = scene("s1", "Barovia", find("Jeth"));
  check("a deleted scene name contributes nothing and does not throw",
    partyPresent([{ s: "A Scene He Deleted" }], [sc], null), []);
}

console.log("\nTHE VOICE NO LONGER ANNOUNCES ITS OWN JOB");
{
  const LINE = "You cleave the ghast from collar to hip.";
  for (const opener of [
    "Narration: ", "Narrator: ", "**Narration:** ", "[NARRATION] ",
    "NARRATION — ", "GM: ", "DM: ", "Response: ", "Output: ",
    "Here is the narration: ", "Sure! ", "Okay, ",
  ]) {
    check(`"${opener.trim()}" is removed`, stripLabel(opener + LINE), LINE);
  }
  check("a doubled label is removed too",
    stripLabel("**Narration:** Narrator: " + LINE), LINE);
}

console.log("\nAND IT LEAVES REAL PROSE ALONE");
{
  // ⚠️🔴 THE ONE THAT MUST NOT BREAK. A known word plus a colon at the very
  // front, and nothing looser, or it starts eating dialogue.
  const keep = [
    "You cleave the ghast from collar to hip.",
    "Narrator was the title he had earned.",
    "The narration of the temple's fall is carved here.",
    "Strahd: you were always going to lose.",
    "Nothing: that is what the amber gave him.",
  ];
  for (const line of keep) check(`untouched: "${line.slice(0, 34)}..."`, stripLabel(line), line);
}

console.log("\nAND BOTH MODULES STILL CONTAIN THESE DECISIONS");
{
  const { readFileSync } = await import("node:fs");
  const mm = readFileSync(
    "D:/FoundryVTT/Data/modules/ace-engine/scripts/memory-manager.mjs", "utf8");
  const pnl = readFileSync(
    "D:/FoundryVTT/Data/modules/ace-engine/scripts/panel.mjs", "utf8");
  check("there is one presence reader", /_partyPresent\(events = \[\]\)/.test(mm), true);
  check("it reads the scene", /const scenes = this\._scenesVisited\(events\);/.test(mm), true);
  check("and walks that scene's tokens",
    /for \(const tokenDoc of \(scene\.tokens \?\? \[\]\)\)/.test(mm), true);
  check("the live summary uses it",
    /const partyNames = this\._partyPresent\(this\.history\?\.events \?\? \[\]\)/.test(mm), true);
  check("the rebuild path uses it",
    /const partyNames = this\._partyPresent\(dayEvents\)/.test(mm), true);
  // ⚠️🔴 NEITHER THE DIRECTORY SCAN NOR THE USER SCAN MAY COME BACK. The first
  // was the original bug; the second was my wrong fix for it.
  check("no path lists every player-owned character any more",
    /filter\(a => a\.hasPlayerOwner && a\.type === "character"\)/.test(mm), false);
  check("and it does not fall back to connected users either",
    /if \(u\?\.isGM \|\| !u\?\.active\) continue;/.test(mm), false);
  check("the speech path strips the label",
    /text = this\._stripNarratorLabel\(text\);/.test(pnl), true);
  check("and the crit card does too",
    /narrative = this\._stripNarratorLabel\(narrative\);/.test(pnl), true);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
