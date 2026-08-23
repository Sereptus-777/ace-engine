// ─── What will actually happen when Johnny reloads ──────────────────────────
//
// ⚠️ THE POINT IS TO KNOW THE NUMBER BEFORE HE DOES. Today's pattern has been:
// ship a pass, watch it report success, then find it did nothing. So this runs
// the SHIPPED classifiers over his REAL data and predicts the outcome.
//
// What it cannot do: the faction founder calls an AI to name each tribe, and
// the world bible lives inside Foundry. So tribe NAMES are unknowable from
// here. Everything else — who is considered, what they resolve to, how many
// tribes get founded, how many deeds then land — is arithmetic on his files.
import fs from "node:fs";

const DATA = "D:/FoundryVTT/Data";
const ENGINE = `${DATA}/worlds/hijinx/ace-engine`;
const payload = JSON.parse(fs.readFileSync(`${DATA}/ace-backups/live/payload.json`, "utf8"));
const deeds = JSON.parse(fs.readFileSync(`${ENGINE}/ace-deeds.json`, "utf8")).deeds ?? [];
const npcs = JSON.parse(fs.readFileSync(`${ENGINE}/ace-npcs.json`, "utf8")).npcs ?? {};
const history = JSON.parse(fs.readFileSync(`${ENGINE}/ace-history.json`, "utf8")).events ?? [];
const registry = payload.factionRegistry ?? {};

// ── Stand Foundry up far enough for the real modules to load ───────────────
class Stub { static DEFAULT_OPTIONS = {}; render() {} }
globalThis.foundry = {
  utils: { randomID: () => "id", mergeObject: (a, b) => ({ ...a, ...b }) },
  applications: { api: { ApplicationV2: Stub, HandlebarsApplicationMixin: (c) => c, DialogV2: Stub } },
};
globalThis.Hooks = { on() {}, once() {}, callAll() {} };
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };

const flagOf = (a) => {
  const f = a.aceFlags ?? {};
  return f.factionId ?? f["ace-engine"]?.factionId ?? "";
};
const actors = (payload.actors ?? []).map(a => ({
  name: a.name,
  type: a.type,
  hasPlayerOwner: a.type === "character",
  prototypeToken: { actorLink: false },
  system: { details: { type: { value: a.type === "character" ? "humanoid" : "npc" }, cr: 1 },
            attributes: { hp: { max: 10 } } },
  items: [],
  _faction: flagOf(a),
  getFlag(_m, k) { return k === "factionId" ? this._faction : ""; },
}));
const byName = new Map(actors.map(a => [a.name, a]));
globalThis.game = {
  actors: Object.assign(actors, { size: actors.length, getName: (n) => byName.get(n) ?? null }),
  packs: [], journal: [], scenes: [], folders: [],
  world: { id: "hijinx", title: "Curse of Strahd" },
  user: { isGM: true }, users: { activeGM: null },
  settings: { get: () => true, set: () => {}, register: () => {} },
  modules: { get: () => ({ api: null, version: "1.20.0" }) },
};
globalThis.canvas = { scene: { name: "BM: Argynvostholt 1F" } };

const reg = await import("file:///D:/FoundryVTT/Data/modules/ace-engine/scripts/npc/faction-registry.mjs");
const { classifyDeed } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-engine/scripts/deed-valence.mjs");

const line = (s) => console.log(s);
line("WHAT RELOADING WILL DO");
line("=".repeat(74));

// ── Step 1: who does the sweep even look at? ───────────────────────────────
//
// ⚠️ THIS IS WHERE THE LAST RUN DIED. `_castOfTheCampaign` reads
// memory.history.events; with the memory manager missing it saw an empty set
// and declared all 1,560 creatures offstage.
const norm = (n) => String(n || "").toLowerCase()
  .replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s*#?\s*\d+\s*$/g, "")
  .replace(/\s+/g, " ").trim();
const cast = new Set();
for (const e of history) {
  if (e?.a) for (const n of String(e.a).split(",")) cast.add(norm(n));
  if (e?.tgt) cast.add(norm(e.tgt));
  if (Array.isArray(e?.p)) for (const n of e.p) cast.add(norm(n));
}
cast.delete("");
line(`\ncast of the campaign, from history: ${cast.size} names`);

const SKIP = new Set(["beast", "ooze", "plant"]);
let considered = 0, alreadyHave = 0, offstage = 0, skipped = 0;
const needFaction = [];
for (const a of actors) {
  if (a.hasPlayerOwner) continue;
  if (a._faction) { alreadyHave++; continue; }
  if (SKIP.has(String(a.system.details.type.value).toLowerCase())) { skipped++; continue; }
  if (!cast.has(norm(a.name))) { offstage++; continue; }
  considered++;
  needFaction.push(a);
}
line(`  already have a faction : ${alreadyHave}`);
line(`  beasts/oozes/plants    : ${skipped}`);
line(`  never appeared in play : ${offstage}`);
line(`  TO BE CONSIDERED       : ${considered}`);

// ── Step 2: what will they resolve to, and how many tribes get founded? ────
const FOUNDABLE = new Set(["tribe", "clan", "warband", "legion", "gang", "cult",
                           "house", "pack", "caravan", "warren", "steading",
                           "master", "creator", "order"]);
const homeOf = (a) => {
  const rec = Object.values(npcs).find(r => r.displayName === a.name);
  return rec?.scenes?.[0] ?? "an unrecorded place";
};
const FOUNDABLE_IF_NAMED = new Set(["settlement", "establishment", "guild", "temple", "court"]);
const { looksLikeAPersonalName } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-engine/scripts/npc/journal-identity.mjs");
const groups = new Map();
const notFoundable = [];
for (const a of needFaction) {
  const base = reg.resolveCreatureBase(a);
  const t = reg.getTemplate(base);
  const named = looksLikeAPersonalName(a.name);
  const worth = FOUNDABLE.has(t?.type) || (named && FOUNDABLE_IF_NAMED.has(t?.type));
  if (!base || !worth) {
    notFoundable.push(`${a.name} -> ${base} (${t?.type})${named ? " [named]" : ""}`);
    continue;
  }
  const home = homeOf(a);
  const key = FOUNDABLE.has(t?.type) ? `${base}@@${home}` : `home@@${home}`;
  if (!groups.has(key)) groups.set(key, { base, home, type: t.type, members: [] });
  groups.get(key).members.push(a.name);
}
line(`\nTRIBES/BANDS THAT WILL BE FOUNDED: ${groups.size}`);
for (const g of [...groups.values()].sort((x, y) => y.members.length - x.members.length)) {
  line(`   ${g.type.padEnd(9)} of ${g.base.padEnd(16)} at ${g.home.slice(0, 30).padEnd(32)} `
    + `${g.members.length} member(s)`);
}
line(`\ncreatures that will still belong to nothing: ${notFoundable.length}`);
for (const n of notFoundable.slice(0, 12)) line(`   ${n}`);

// ── Step 3: with those factions in place, how many deeds land? ─────────────
const willHave = new Map();          // creature name -> pretend faction id
for (const [key, g] of groups) for (const m of g.members) willHave.set(m, `new:${key}`);
for (const a of actors) if (a._faction) willHave.set(a.name, a._faction);

const POINTS = { trivial: 0, local: 10, major: 25, regional: 40, legendary: 55 };
let land = 0;
const blocked = { travel: 0, trivial: 0, neutral: 0, noFaction: 0 };
const landing = [];
for (const d of deeds) {
  if (d.source === "auto:travel") { blocked.travel++; continue; }
  if (!POINTS[String(d.magnitude).toLowerCase()]) { blocked.trivial++; continue; }
  const v = classifyDeed(d);
  if (v.valence === "neutral") { blocked.neutral++; continue; }
  // The live classifier reads actor flags; here, also accept a faction the
  // sweep is about to create.
  let fid = v.factionId;
  if (!fid) {
    for (const [name, id] of willHave) {
      if (name.length > 3 && String(d.text).includes(name)) { fid = id; break; }
    }
  }
  if (!fid) { blocked.noFaction++; continue; }
  land++;
  if (landing.length < 8) landing.push(`[${d.magnitude}] ${v.valence.padEnd(11)} ${d.text.slice(0, 68)}`);
}
line(`\nDEEDS THAT WILL MOVE A FACTION: ${land}   (today: 0)`);
line(`   set aside: ${blocked.travel} travel, ${blocked.trivial} trivial, `
  + `${blocked.neutral} move nobody, ${blocked.noFaction} still nobody to blame`);
line("\n   examples:");
for (const l of landing) line("      " + l);

line("\n" + "=".repeat(74));
line(`Currently ${Object.keys(registry).length} factions; `
  + `${Object.values(registry).filter(f => f?.members?.length).length} have members.`);
line(`After the sweep: about ${Object.keys(registry).length + groups.size} factions, `
  + `and every score in the world earned rather than dealt.`);
