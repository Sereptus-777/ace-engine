// ─── ACE Engine — is this a person, a kind of creature, or a thing? ─────────
//
// Johnny, 2026-08-22, reading his own journal folder: 475 NPC Profiles with a
// median length of 148 characters. One of them, in full:
//
//     Dining Table. Status: Alive. Encounters: 1. Scenes: 1F East MINE.
//
// ACE built a character dossier for a piece of furniture and recorded that it
// is alive. Another says Specter, Status: Killed by Kasimir Velikov, across
// 2,203 encounters, because one specter died and the whole species inherited it.
//
// ⚠️ THE OLD GATE ASKED THE WRONG QUESTION. `_isNpcJournalWorthy` asked "have
// we seen this a lot" — linked actor, or 2+ encounters, or among the 20 most
// recently seen. Nothing in it asks whether the thing is a CREATURE. The dining
// table walked in through the 20-most-recent clause on a single sighting, and
// so did every map template and stray token import.
//
// Three different things were being written in one format:
//
//   a PERSON        Vilnius, Kasimir, Joren "Quickhand" Voss
//                   Deserves prose: who they are, what they want, what has
//                   passed between them and the party.
//
//   a KIND          Specter, Goblin, Amber Golem
//                   Deserves a tally: how many met, how many killed, what was
//                   learned about fighting them, and links down to any of
//                   them that earned a name.
//
//   a THING         Dining Table, "download", Group Map Token
//                   Deserves nothing.
//
// ⚠️ THE DISCRIMINATOR IS PROVEN, NOT GUESSED. Six separate actors in his world
// are named "Specter". Exactly one is named "Vilnius". That is the line, and it
// is the same line Johnny drew himself: "Anything that gets named, I want a
// separate journal. When I fight six specters, we can just group them all
// into one."

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | journal identity";

/** Actor types that can be a creature at all. Everything else is scenery. */
const CREATURE_TYPES = new Set(["npc", "character"]);

/**
 * Names that are never a creature no matter what carries them. These come from
 * Johnny's own world: image imports that became actors, map furniture, and the
 * template actors he keeps in a folder called AAA TEMPLATES.
 */
const NEVER_A_CREATURE = [
  /^download(\s*\(\d+\))?$/i,
  /^untitled/i,
  /^new actor/i,
  // ⚠️ "Group Map Token" was listed and "Group Map Marker" was not, so one of
  // the two identical map props was correctly ignored and the other turned up
  // in Johnny's player-character list. A pattern that names one instance of a
  // thing instead of the shape of it will always miss the next one.
  /^(group\s+)?map\s+(token|marker|pin|note)s?$/i,
  /^group map (token|marker)$/i,
  /\bmap (marker|pin)\b/i,
  /^aaa\b/i,
  /^\d+$/,
  /^(image|img|token|tile|prop|marker|placeholder|test dummy)\b/i,
];

/** Furniture and scenery words. A creature is never only one of these. */
const FURNITURE = new RegExp(
  "^(dining |kitchen |writing |round |long |stone |wooden )?" +
  "(table|chair|stool|bench|bed|door|chest|crate|barrel|sack|shelf|bookcase|" +
  "cabinet|desk|altar|statue|pillar|column|brazier|torch|candle|lantern|" +
  "fireplace|hearth|rug|carpet|curtain|tapestry|painting|mirror|window|" +
  "stairs|ladder|rope|bucket|pot|pan|plate|cup|bottle|urn|coffin|sarcophagus|" +
  "wagon|cart|boat|fence|gate|well|fountain|bridge|sign|banner|corpse|body|" +
  "remains|bones|rubble|debris|campfire|fire|smoke|light|wall|floor|ceiling)s?$",
  "i");

/** Monster names known to the system, built once from the compendiums. */
let _statblockNames = null;

/**
 * Every creature name the installed compendiums know about.
 *
 * ⚠️ This is what separates "Specter" from "Vilnius". Both are the name on an
 * unlinked NPC actor. One of them ships with the game and one of them is a
 * person Johnny wrote. Asking the compendium is the only way to tell, and it
 * costs one index read per pack at startup.
 */
export async function loadStatblockNames() {
  if (_statblockNames) return _statblockNames;
  const names = new Set();
  for (const pack of (game.packs ?? [])) {
    if (pack.documentName !== "Actor") continue;
    try {
      const index = await pack.getIndex();
      for (const entry of index) {
        if (entry?.name) names.add(entry.name.trim().toLowerCase());
      }
    } catch (err) {
      console.warn(`${TAG} | could not index ${pack.collection}:`, err);
    }
  }
  _statblockNames = names;
  console.debug(`${TAG} | ${names.size} creature names known to the compendiums.`);
  return names;
}

/** Strip the decorations ACE and dnd5e add to a name. */
export function baseName(name) {
  return String(name ?? "")
    .replace(/\s*\(CR\s*[^)]*\)\s*$/i, "")   // "Varek Thalor (CR 30)"
    .replace(/\s*\(Copy\)\s*$/i, "")
    .replace(/\s*#\d+\s*$/, "")               // "Goblin #3"
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();
}

/**
 * Does this name read like a person rather than a species?
 *
 * A surname, a nickname in quotes, a comma-and-title, or a "the something"
 * epithet. Deliberately generous: Johnny's rule is that ANYTHING NAMED gets
 * its own journal, so a false person costs one extra page and a false creature
 * loses somebody's history into a tally. Only one of those is recoverable.
 */
export function looksLikeAPersonalName(name) {
  const n = baseName(name);
  if (!n) return false;
  if (/["'“‘]/.test(n)) return true;              // Joren "Quickhand" Voss
  if (/,\s*\w/.test(n)) return true;                        // Grik Skullcrusher, Chieftain
  if (/\bthe\s+[A-Z]/.test(n)) return true;                 // Mortivax the Eternal
  if (/\b(of|von|van|de|du|da)\b/i.test(n) && /\s/.test(n)) return true;
  const words = n.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.every(w => /^[A-ZÀ-Þ]/.test(w));
}

/**
 * What is this?
 *
 * @param {string} displayName  the name ACE recorded
 * @param {object} [rec]        the ace-npcs record, when there is one
 * @returns {{kind:"person"|"creature"|"thing", why:string, actor:Actor|null,
 *            actors:Actor[], name:string}}
 */
export function classify(displayName, rec = null) {
  const name = baseName(displayName);
  const lower = name.toLowerCase();
  const verdict = (kind, why, actors = []) =>
    ({ kind, why, actor: actors[0] ?? null, actors, name });

  if (!name) return verdict("thing", "no name at all");

  // ── Things, decided on the name alone ──────────────────────────────────
  for (const pattern of NEVER_A_CREATURE) {
    if (pattern.test(name)) return verdict("thing", "an import artefact, not a creature");
  }
  if (FURNITURE.test(name)) return verdict("thing", "furniture or scenery");

  const actors = (game.actors ?? []).filter(a => baseName(a.name).toLowerCase() === lower);

  // ── Things, decided on the actor ───────────────────────────────────────
  if (!actors.length) {
    // ⚠️ RARITY IS NOT INSIGNIFICANCE, AND THIS NEARLY DELETED FOUR PEOPLE.
    //
    // The first version of this dropped anything with no actor left in the
    // world and fewer than two sightings. Run against Johnny's real data it
    // produced a deletion list containing Donavich, Exethanter, Lucian
    // Petrovich and Stefania Martikov: four named Curse of Strahd characters
    // whose actors he had since deleted, renamed, or never linked. Met once,
    // never spoke, and gone forever.
    //
    // Being met once is not evidence of being furniture. Furniture is caught
    // by name above. Anything else that carries a name is kept, which is
    // exactly the rule Johnny gave: "anything that gets named".
    if (_statblockNames?.has(lower)) {
      return verdict("creature", "a statblock name, though no actor carries it now");
    }
    return verdict("person", "named, though no actor carries the name any more");
  }

  const actor = actors[0];
  if (!CREATURE_TYPES.has(actor.type)) {
    return verdict("thing", `actor type "${actor.type}" is not a creature`, actors);
  }

  // ── A person ───────────────────────────────────────────────────────────
  //
  // ⚠️ THIS MUST COME BEFORE THE STATISTICS TEST. Linking an actor is a
  // deliberate act by the GM, and a GM may well create a talking NPC with no
  // hit points, no challenge rating and no class at all. Judged on statistics
  // first, that NPC is furniture and gets deleted. Judged on the link first,
  // it is exactly what its owner said it was.
  if (actor.prototypeToken?.actorLink) {
    return verdict("person", "a linked actor, which is a deliberate choice", actors);
  }
  if (actor.hasPlayerOwner) {
    return verdict("person", "owned by a player", actors);
  }

  // ⚠️ A dnd5e creature ALWAYS has hit points. Furniture imported as an actor
  // does not, and neither does a picture that became one. Checking this rather
  // than the name is what catches the ones nobody thought to list.
  //
  // Two signals are required, never one: no statistics AND nothing about the
  // name suggesting a person. A stat-less actor called "Grik Skullcrusher,
  // Chieftain" is somebody the GM wrote, not a table.
  const hpMax = Number(actor.system?.attributes?.hp?.max ?? 0);
  const cr = actor.system?.details?.cr;
  const levels = Number(actor.system?.details?.level ?? 0);
  const hasClass = !!actor.items?.some?.(i => i.type === "class");
  const hasStats = hpMax || cr !== undefined || levels || hasClass;
  if (!hasStats && !looksLikeAPersonalName(name)) {
    return verdict("thing", "no hit points, no challenge rating, no class, no name of its own", actors);
  }

  // ── A kind of creature ─────────────────────────────────────────────────
  if (_statblockNames?.has(lower)) {
    return verdict("creature", "the name of a statblock that ships with the game", actors);
  }
  if (actors.length > 1) {
    return verdict("creature", `${actors.length} separate actors share this name`, actors);
  }

  // One actor, its own name, not out of a book. Somebody wrote this creature.
  return verdict("person", "a name that exists once and came from nowhere else", actors);
}

/**
 * What species is this?
 *
 * ⚠️ ACE HAS NEVER RECORDED THIS. It stores class and level and nothing about
 * what anybody IS, which is why a Video Overview built from five months of
 * campaign notes drew Firaxis Greenbeard as a human: the word "dragonborn"
 * appears nine times in 900 KB of source. In dnd5e the species is an embedded
 * Item, not a field, which is presumably why it was never picked up.
 */
export function speciesOf(actor) {
  const item = actor?.items?.find?.(i => i.type === "race" || i.type === "species");
  const raw = item?.name
    || (typeof actor?.system?.details?.race === "string" ? actor.system.details.race : "")
    || actor?.system?.details?.race?.name
    || "";
  // "Dragonborn (Legacy)" and "Eladrin (Variant)" are edition bookkeeping, not
  // something anybody says out loud.
  return String(raw).replace(/\s*\((Legacy|Variant)\)\s*$/i, "").trim();
}

/**
 * Class line and TOTAL level, read live.
 *
 * ⚠️ THE STORED LEVEL WAS FROZEN BY A `||` AND THEN NEVER THAWED. Even with
 * that fixed at source, a level copied into a journal is a level that starts
 * drifting the moment it is written. Chudd is 9th and his journal says 7th.
 * The only correct answer is the one on the character right now, and for a
 * multiclass it is the SUM: Syrax is Warlock 7 / Paladin 2, which is 9th level,
 * not 7th.
 */
export function classLineOf(actor) {
  const classes = (actor?.items ?? []).filter?.(i => i.type === "class") ?? [];
  if (!classes.length) {
    const level = Number(actor?.system?.details?.level ?? 0);
    return { line: "", level };
  }
  const parts = classes.map(c => `${c.name} ${c.system?.levels ?? "?"}`);
  const level = classes.reduce((n, c) => n + Number(c.system?.levels ?? 0), 0);
  return { line: parts.join(" / "), level };
}

/** The background item, when the character has one. */
export function backgroundOf(actor) {
  const item = actor?.items?.find?.(i => i.type === "background");
  const name = item?.name || actor?.system?.details?.background || "";
  return /^background$/i.test(String(name)) ? "" : String(name).trim();
}

/** Has this creature ever actually said anything to anyone? */
function _hasSpoken(rec) {
  if (!rec) return false;
  for (const info of Object.values(rec.relationships ?? {})) {
    if (info && typeof info === "object" && info.reason) return true;
  }
  return !!(rec.sceneAppearances?.some?.(a => (a?.contextText ?? "").length > 60));
}

/**
 * Group a set of records by what they are, for a sweep.
 * @returns {{people:object[], creatures:object[], things:object[]}}
 */
export function classifyAll(records) {
  const out = { people: [], creatures: [], things: [] };
  for (const rec of records) {
    const name = rec?.displayName ?? rec?.name;
    if (!name) { out.things.push({ rec, verdict: { kind: "thing", why: "no name", name: "" } }); continue; }
    const verdict = classify(name, rec);
    const bucket = verdict.kind === "person" ? out.people
      : verdict.kind === "creature" ? out.creatures : out.things;
    bucket.push({ rec, verdict });
  }
  return out;
}
