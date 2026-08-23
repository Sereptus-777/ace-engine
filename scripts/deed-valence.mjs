// ─── ACE Engine — deciding what a deed MEANS, at the moment it happens ──────
//
// ⚠️ WHY NOTHING THE PARTY DID HAD EVER MOVED A FACTION (2026-08-22).
//
// Johnny's world: 109 deeds recorded, 82 of them real and non-trivial, and
// ZERO had ever moved a single faction. Every faction score in the world was an
// artifact of a starting roll: 233 of 236 sat on an exact band midpoint.
//
// The pipeline was complete at both ends and starved in the middle.
//
//   memory-manager.logDeed  emits `deedRecorded`             ✓ works
//   deed-propagation        listens for it                    ✓ works
//   propagateDeed           returns null on its FIRST test    ✗
//
// Its first test throws out anything with a valence of "neutral", and the emit
// reads `deed.valence ?? record.valence ?? "neutral"`. NOTHING THAT CALLS
// logDeed HAS EVER PASSED A VALENCE. So every deed in five months arrived
// morally weightless and was discarded one line into the consumer.
//
// ⚠️ AND A SECOND BREAK, IN THE ONE PLACE THAT DID THE WORK. The kill path
// looks up the victim's faction properly and passes it as
// `factions: [{ id, name }]` — an ARRAY. The store writes `factionId`, and
// propagateDeed reads `deed.factionId`, a STRING. Different key, same object,
// no error, data silently dropped. So even kills, the one case that bothered to
// resolve a faction, arrived with an empty one.
//
// ⚠️ VALENCE HERE MEANS "HOW THE SUBJECT TAKES IT", NOT GLOBAL MORALITY.
// Killing a goblin is heroic in a tavern and villainous to the goblins. The
// subject of a deed is the faction it was done TO, so a kill is villainous
// toward them and their enemies gain a little. That is what makes the world
// have sides. Do not "fix" this to mean good-versus-evil; it would invert every
// kill and make slaughtering a tribe improve your standing with that tribe.

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | deed valence";

/**
 * Words that decide which way a deed cuts.
 *
 * ⚠️ Whole words only. An early draft matched "spare" inside "spared no one"
 * and "free" inside "freezing", and turned a massacre into an act of mercy.
 */
const HEROIC = new RegExp("\\b(" + [
  "saved?", "rescued?", "freed", "liberat(?:ed|ing)", "heal(?:ed|s)?", "cured?",
  "spared?", "protect(?:ed|ing)", "defend(?:ed|ing)", "restor(?:ed|ing)",
  "return(?:ed|ing)", "gave", "gifted", "help(?:ed|ing)", "aided", "assisted",
  "pledged", "promised", "vowed", "swore", "honou?red", "buried", "avenged",
  "forgave", "pardoned", "shelter(?:ed|ing)", "warned", "escort(?:ed|ing)",
  "reconcil(?:ed|ing)", "allied", "befriended", "blessed", "consecrated",
].join("|") + ")\\b", "i");

const VILLAINOUS = new RegExp("\\b(" + [
  "killed", "slew", "slain", "murder(?:ed|ing)", "slaughter(?:ed|ing)",
  "executed", "betray(?:ed|ing)", "stole", "stolen", "rob(?:bed|bing)",
  "plunder(?:ed|ing)", "loot(?:ed|ing)", "threat(?:ened|ening)",
  "intimidat(?:ed|ing)", "extort(?:ed|ing)", "blackmail(?:ed|ing)",
  "tortur(?:ed|ing)", "destroy(?:ed|ing)", "burn(?:ed|t|ing)",
  "desecrat(?:ed|ing)", "defiled?", "abandon(?:ed|ing)", "deceiv(?:ed|ing)",
  "lied", "cheated", "ambush(?:ed|ing)", "massacred?", "enslav(?:ed|ing)",
  "cursed", "profaned?",
].join("|") + ")\\b", "i");

/** Breaking a promise is villainous even though "promise" is a heroic word. */
const BROKEN = /\b(broke|broken|betrayed|reneged|abandoned)\b[^.]{0,30}\b(promise|oath|vow|word|pact|deal|truce)\b/i;

/** Taking things is only a deed against somebody if it was taken FROM them. */
const THEFT = /\b(stole|stolen|rob(?:bed)?|plunder(?:ed)?|pickpocket|snatched|took by force)\b/i;


/**
 * Work out how a deed lands, and on whom.
 *
 * @param {object} deed  as passed to logDeed
 * @returns {{valence:"heroic"|"villainous"|"neutral", factionId:string, why:string}}
 */
export function classifyDeed(deed = {}) {
  const text = String(deed.text ?? deed.summary ?? "");
  const source = String(deed.source ?? "");
  const factionId = subjectFactionOf(deed);

  // ── Source tells us most of it ─────────────────────────────────────────
  if (source === "auto:kill") {
    return { valence: "villainous", factionId,
             why: "a kill is always a wound to whoever the dead belonged to" };
  }
  if (source.startsWith("auto:heal") || source === "manual:heal") {
    return { valence: "heroic", factionId, why: "healing" };
  }
  if (source === "auto:item") {
    // Picking loot off a corpse is not a deed against anybody. Taking it from
    // someone who is still standing very much is.
    return THEFT.test(text)
      ? { valence: "villainous", factionId, why: "taken by theft, not salvage" }
      : { valence: "neutral", factionId: "", why: "salvage, not a deed against anyone" };
  }
  if (source === "auto:travel") {
    return { valence: "neutral", factionId: "", why: "travelling is not a deed" };
  }

  // ── Otherwise read the words ───────────────────────────────────────────
  if (BROKEN.test(text)) {
    return { valence: "villainous", factionId, why: "a promise broken" };
  }
  const heroic = HEROIC.test(text);
  const villainous = VILLAINOUS.test(text);

  // ⚠️ BOTH IS NOT NEITHER. "Firaxis spared the captive but burned the shrine"
  // is genuinely mixed, and calling it neutral would silently throw away a real
  // event. The harsher reading wins, because a faction remembers the wound.
  if (heroic && villainous) {
    return { valence: "villainous", factionId,
             why: "the words cut both ways; the wound is what gets remembered" };
  }
  if (heroic) return { valence: "heroic", factionId, why: "words of aid or good faith" };
  if (villainous) return { valence: "villainous", factionId, why: "words of harm" };

  return { valence: "neutral", factionId: "", why: "nothing in it moves anybody" };
}

/**
 * Which faction was this done to?
 *
 * ⚠️ ACCEPTS EVERY SHAPE THE CALLERS ACTUALLY USE. The kill path passes
 * `factions: [{ id, name }]`; nothing else passes anything at all; the store
 * and the consumer both want a bare `factionId` string. Reading only one of
 * those is exactly how the kill path's careful faction lookup got thrown away.
 */
export function subjectFactionOf(deed = {}) {
  if (deed.factionId) return String(deed.factionId);

  const list = deed.factions;
  if (Array.isArray(list) && list.length) {
    const first = list[0];
    if (typeof first === "string") return first;
    if (first?.id) return String(first.id);
  }

  // Nobody named it, so look for a creature the deed mentions and read its flag.
  const named = deed.target ?? deed.victim ?? deed.npc ?? deed.with ?? "";
  const candidates = [];
  if (named) candidates.push(String(named));
  const text = String(deed.text ?? deed.summary ?? "");
  if (text) {
    for (const actor of (game.actors ?? [])) {
      if (actor.hasPlayerOwner) continue;                 // the party is not a subject
      const name = actor.name;
      if (name && name.length > 3 && text.includes(name)) candidates.push(name);
    }
  }
  for (const name of candidates) {
    const actor = game.actors?.getName?.(name);
    if (!actor) continue;
    let id = "";
    try { id = actor.getFlag(MODULE_ID, "factionId") || ""; } catch (_) { continue; }
    if (id) return String(id);
  }
  return "";
}

/**
 * Fill in valence and factionId on a deed, in place, and say what was decided.
 * Called by logDeed so that every deed is judged the moment it is recorded
 * rather than by a backfill pass that may never run.
 */
export function enrichDeed(deed = {}) {
  if (deed.valence && deed.factionId) return deed;        // caller was explicit
  const verdict = classifyDeed(deed);
  if (!deed.valence) deed.valence = verdict.valence;
  if (!deed.factionId && verdict.factionId) deed.factionId = verdict.factionId;
  deed._why = verdict.why;
  return deed;
}
