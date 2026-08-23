// Dry run: how many of Johnny's 459 factions can be given named members using
// ONLY what is already written in his own data? No invention, no lore from me.
import fs from "node:fs";

const payload = JSON.parse(fs.readFileSync(
  "D:/FoundryVTT/Data/ace-backups/live/payload.json", "utf8"));
const reg = payload.factionRegistry ?? {};

// ⚠️ A DESCRIPTION IS NOT A PERSON. The leader field holds both:
//   "Grik Skullcrusher, Chieftain"        <- a person
//   "Council of faith leaders"            <- a description of how they decide
//   "No single leader - network of High Harpers"
//   "Rotating council of city lords"
//   "Various Thayan Zulkirs"
//   "none"
// The existing harvester only checks for a capital letter, and every one of
// those descriptions has one. Assigning "Council" as an officer would put a
// noun in a chair.
const NOT_A_PERSON = new RegExp(
  "(^|\\b)(none|unknown|n/a|nobody|varies|various|several|many|rotating|" +
  "no single|leaderless|collective|committee|assembly|network|multiple|" +
  "council|conclave|circle|senate|parliament|board|group of|a group|" +
  "elected|unelected|shared|no formal|no known|not known|tbd|tba)\\b", "i");

// A person has at least one capitalised word that is not purely a title.
const TITLE_ONLY = new RegExp(
  "^(the\\s+)?(lord|lady|king|queen|baron|baroness|chief|chieftain|captain|" +
  "commander|leader|master|mistress|high\\s+priest|priest|abbot|elder|" +
  "warchief|warlord|thane|jarl|matron|archmage|guildmaster|mayor)s?$", "i");

function personFrom(leader) {
  const raw = String(leader || "").trim();
  if (!raw) return null;
  if (NOT_A_PERSON.test(raw)) return null;
  // "Name, Title" or "Name (Title)"
  let name = raw.split(/\s*[,(]\s*/)[0].trim();
  name = name.replace(/\s*[-–—]\s*.*$/, "").trim();
  if (!name || name.length < 3) return null;
  const words = name.split(/\s+/).filter(Boolean);
  const capitals = words.filter(w => /^[A-Z\u00C0-\u00DE]/.test(w));
  if (!capitals.length) return null;
  // "Baron" alone is a title, not a person. "Baron Vargas Vallakovich" is fine.
  if (words.length === 1 && TITLE_ONLY.test(name)) return null;
  const title = raw.slice(name.length).replace(/^[\s,()-]+|[\s()]+$/g, "").trim();
  return { name, title };
}

let harvestable = 0, described = 0, blank = 0;
const good = [], rejected = [];
for (const f of Object.values(reg)) {
  if (!f || typeof f !== "object") continue;
  const raw = String(f.leader || "").trim();
  if (!raw) { blank++; continue; }
  const p = personFrom(raw);
  if (p) { harvestable++; if (good.length < 20) good.push(`${String(f.name).slice(0,32).padEnd(34)} ${p.name}${p.title ? "  (" + p.title + ")" : ""}`); }
  else   { described++;  if (rejected.length < 14) rejected.push(`${String(f.name).slice(0,32).padEnd(34)} ${raw.slice(0,44)}`); }
}

console.log("CAN WE FILL THESE FROM HIS OWN DATA, WITHOUT INVENTING ANYTHING?");
console.log("=".repeat(74));
console.log(`  factions                         : ${Object.keys(reg).length}`);
console.log(`  a real named person to harvest   : ${harvestable}`);
console.log(`  a description, not a person      : ${described}`);
console.log(`  no leader recorded at all        : ${blank}`);
console.log("\nWOULD BE ASSIGNED (sample):");
for (const g of good) console.log("   " + g);
console.log("\nCORRECTLY REFUSED — these are descriptions, not people:");
for (const r of rejected) console.log("   " + r);
