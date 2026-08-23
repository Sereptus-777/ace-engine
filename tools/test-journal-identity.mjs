// Run the SHIPPED classifier over Johnny's real journal names and real actors.
//
// ⚠️ The point is to test the file that ships, not a retyped copy of its logic.
// A deed parser once "passed" a test written against a pattern I had typed out
// by hand while the shipped one contained a literal backspace and matched
// nothing. So this imports journal-identity.mjs directly.
import fs from "node:fs";

const PAYLOAD = "D:/FoundryVTT/Data/ace-backups/live/payload.json";
const NPCS = "D:/FoundryVTT/Data/worlds/hijinx/ace-engine/ace-npcs.json";

const payload = JSON.parse(fs.readFileSync(PAYLOAD, "utf8"));
const npcs = JSON.parse(fs.readFileSync(NPCS, "utf8")).npcs ?? {};

// The backup carries a trimmed actor, so give each one plausible statistics.
// That deliberately exercises the NAME logic, which is the part under test;
// the statistics branch only ever fires in a live world where real data exists.
globalThis.game = {
  actors: payload.actors.map(a => ({
    name: a.name,
    type: a.type,
    img: a.img,
    uuid: a.uuid,
    hasPlayerOwner: a.type === "character",
    prototypeToken: { actorLink: false },
    system: { attributes: { hp: { max: 11 } }, details: {} },
    items: [],
  })),
  packs: [],                 // no compendium offline; forces the duplicate-name path
  journal: [],
  scenes: [],
};

const { classify, loadStatblockNames } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-engine/scripts/npc/journal-identity.mjs");
await loadStatblockNames();

const journals = payload.journals.filter(j => j.folderName === "NPC Profiles");
const recFor = (name) => Object.values(npcs).find(
  r => (r.displayName ?? "").toLowerCase() === name.toLowerCase()) ?? null;

const buckets = { person: [], creature: [], thing: [] };
for (const j of journals) {
  const v = classify(j.name, recFor(j.name));
  buckets[v.kind].push({ name: j.name, why: v.why });
}

console.log(`CLASSIFYING ${journals.length} NPC PROFILE JOURNALS`);
console.log("=".repeat(74));
for (const [kind, rows] of Object.entries(buckets)) {
  console.log(`\n${kind.toUpperCase()}: ${rows.length}`);
  const why = {};
  for (const r of rows) why[r.why] = (why[r.why] ?? 0) + 1;
  for (const [reason, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(4)}  ${reason}`);
  }
}

console.log("\n\nSPOT CHECKS");
console.log("=".repeat(74));
for (const name of ["Dining Table", "Specter", "Vilnius", "Varek Thalor (CR 30)",
                    'Joren "Quickhand" Voss', "download", "Basilisk", "Imp",
                    "Kasimir Velikov", "Ezmerelda d'Avenir"]) {
  const v = classify(name, recFor(name));
  console.log(`   ${v.kind.toUpperCase().padEnd(9)} ${name.padEnd(26)} ${v.why}`);
}

console.log("\n\nEVERY DELETION, SO NOTHING GOES QUIETLY");
console.log("=".repeat(74));
console.log(buckets.thing.map(t => `   ${t.name}`).join("\n"));
