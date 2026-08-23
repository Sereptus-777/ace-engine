// Run the SHIPPED classifier over Johnny's real 109 deeds.
//
// ⚠️ The point is to know the number BEFORE he reloads, not to discover after
// the fact that the fix moved four things. The classifier is imported from the
// shipped file; nothing here is a retyped copy of its logic.
import fs from "node:fs";

const DEEDS = "D:/FoundryVTT/Data/worlds/hijinx/ace-engine/ace-deeds.json";
const PAYLOAD = "D:/FoundryVTT/Data/ace-backups/live/payload.json";

const payload = JSON.parse(fs.readFileSync(PAYLOAD, "utf8"));
const registry = payload.factionRegistry ?? {};

// Mock the actors, carrying whatever faction flag the backup preserved.
const actors = (payload.actors ?? []).map(a => ({
  name: a.name,
  hasPlayerOwner: a.type === "character",
  _faction: a.aceFlags?.factionId ?? a.aceFlags?.["ace-engine"]?.factionId ?? "",
  getFlag(_mod, key) { return key === "factionId" ? this._faction : ""; },
}));
const byName = new Map(actors.map(a => [a.name, a]));
globalThis.game = {
  actors: Object.assign(actors, { getName: (n) => byName.get(n) ?? null }),
  packs: [], journal: [], scenes: [],
};

const { classifyDeed } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-engine/scripts/deed-valence.mjs");

const rows = JSON.parse(fs.readFileSync(DEEDS, "utf8")).deeds ?? [];
const POINTS = { trivial: 0, local: 10, major: 25, regional: 40, legendary: 55 };

const tally = { heroic: 0, villainous: 0, neutral: 0 };
const blocked = { travel: 0, trivial: 0, neutral: 0, noFaction: 0 };
let willMove = 0;
const examples = { heroic: [], villainous: [], noFaction: [] };

for (const r of rows) {
  const v = classifyDeed(r);
  tally[v.valence]++;
  if (r.source === "auto:travel") { blocked.travel++; continue; }
  if (!POINTS[String(r.magnitude).toLowerCase()]) { blocked.trivial++; continue; }
  if (v.valence === "neutral") {
    blocked.neutral++;
    continue;
  }
  if (!v.factionId || !registry[v.factionId]) {
    blocked.noFaction++;
    if (examples.noFaction.length < 4) examples.noFaction.push(r.text.slice(0, 92));
    continue;
  }
  willMove++;
  const bucket = examples[v.valence];
  if (bucket.length < 4) {
    bucket.push(`${(registry[v.factionId]?.name ?? v.factionId).slice(0, 28)}  <-  ${r.text.slice(0, 74)}`);
  }
}

console.log("RUNNING THE NEW CLASSIFIER OVER 109 REAL DEEDS");
console.log("=".repeat(74));
console.log(`\nvalence decided:  heroic ${tally.heroic} · villainous ${tally.villainous} · neutral ${tally.neutral}`);
console.log(`\nWILL MOVE A FACTION: ${willMove}   (it was 0)`);
console.log("\nstill blocked, and why:");
console.log(`   ${String(blocked.travel).padStart(3)}  travel, which is no longer recorded as a deed at all`);
console.log(`   ${String(blocked.trivial).padStart(3)}  trivial, worth zero points by design`);
console.log(`   ${String(blocked.neutral).padStart(3)}  genuinely move nobody`);
console.log(`   ${String(blocked.noFaction).padStart(3)}  have nobody to blame: no faction resolved`);

for (const [k, list] of Object.entries(examples)) {
  if (!list.length) continue;
  console.log(`\n${k}:`);
  for (const line of list) console.log("   " + line);
}
