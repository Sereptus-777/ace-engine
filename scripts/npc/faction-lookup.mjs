// ─── ACE: Engine — Faction Lookup: LOOK BEFORE YOU INVENT ───────────────────
//
// Johnny, 2026-08-07: "we already got real factions… like over 200 or something
// like that, but yet we're inventing them through the AI."
//
// He was right, and the reason is narrow and provable. The registry holds his
// whole imported world library — 440 factions at last count, the Lords of
// Waterdeep among them — but the only lookup the generator ever ran was
// findMatchingFactions(), which matches on ONE field: the faction's creature
// base, widened to that creature's family.
//
// Imported world factions are human ORGANISATIONS. _inferCreatureBase() returns
// an empty string for those on purpose ("Empty string = a human/organisation
// faction (no creature kin)"). An empty creature base matches no family, so
// every one of those 440 was invisible to the only question ever asked, and the
// generator dutifully concluded nothing existed and invented a replacement.
//
// This module asks the question properly. A faction is a candidate because of
// WHO it recruits (creature kin), WHERE it operates (presence, headquarters,
// nation, scope), WHAT it is (an order takes knights, a garrison takes guards),
// what the scene's own intelligence says is here, and who is already standing
// on this map. Kin is still the strongest signal; it is no longer the only one.
//
// Two further rules close the loop:
//   • ADOPT ON COLLISION — if the AI invents a name the world already uses, we
//     adopt the existing faction instead of minting a duplicate.
//   • EVERY NEW FACTION IS REAL — an emergent warband is written back into the
//     same registry with its presence recorded, so the Red Fang met in a forest
//     is findable by scene three sessions later in a different valley.
//
// ⚠️ This module never invents anything itself. It decides whether inventing is
// warranted and hands back a verdict. The caller does the generating.

import { getAllFactions, getFaction, getFamilyMembers, saveFaction, resolveCreatureBase } from "./faction-registry.mjs";

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Faction lookup";

/** Normalize a faction name for comparison: "The Harpers" and "harpers" are one. */
export const normalizeFactionName = (s) => String(s || "")
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Loose place comparison — "Waterdeep" matches "City of Waterdeep, Dock Ward". */
function _placeMatches(needle, haystack) {
    const n = normalizeFactionName(needle);
    const h = normalizeFactionName(haystack);
    if (!n || !h || n.length < 3) return false;
    return h.includes(n) || n.includes(h);
}

// ── Who may NOT join a civic institution ─────────────────────────────────────
// A goblin does not get to be a candidate for the Lords of Waterdeep merely
// because both happen to be in the same city. Scene presence is a strong signal
// and without this gate it would produce exactly that absurdity. A monstrous
// creature can still join a civic faction — but only one that explicitly
// recruits its kin (a hobgoblin legion IS a garrison), which the kin test below
// establishes independently.
const MONSTROUS_BASES = new Set([
    "goblin", "hobgoblin", "bugbear", "orc", "kobold", "gnoll", "ogre", "troll",
    "lizardfolk", "drow", "duergar", "skeleton", "zombie", "undead", "ghoul",
    "wight", "wraith", "ghost", "cultist", "fanatic", "bandit", "thug", "pirate",
    "wolf", "worg", "bear", "beast", "construct", "golem",
]);

const CIVIC_TYPES = new Set([
    "government", "court", "order", "garrison", "temple", "guild", "settlement",
    "establishment", "kingdom", "duchy", "county", "town", "district", "nation",
]);

// ═══════════════════════════════════════════════════════════════════════════
//  MERGED IN FROM faction-matcher.mjs (2026-08-22)
//
//  ⚠️ THERE WERE TWO SCORERS RUNNING ON THE SAME CREATURE. This module was
//  written 2026-08-07 for Johnny's complaint "we already got real factions but
//  yet we're inventing them through the AI". On 2026-08-21 he made the SAME
//  complaint — "I keep getting prompted to put the same ones in every time" —
//  and I wrote a second scorer without finding this one, because I searched for
//  "faction matcher" instead of for the CAPABILITY. processTokenFaction then
//  ran both: the new one built the list shown to the AI, this one made the
//  actual decision, and they could disagree about the same creature.
//
//  One scorer now. This file keeps its hard exclusions, which the other never
//  had — a wolf pack does not recruit goblins, and a monster does not join a
//  civic institution — and gains the signals the other brought:
//  rarity-weighted name words, being NAMED as a faction's leader, alignment on
//  both axes, challenge rating against the faction's standing, and languages.
//
//  ⚠️ The actor-based signals only apply when ctx.actor is supplied, so every
//  existing caller behaves exactly as before.
// ═══════════════════════════════════════════════════════════════════════════

const STOP = new Set(["the", "of", "a", "an", "and", "clan", "tribe", "order", "house",
                      "company", "guild", "band", "pack", "circle", "society", "legion",
                      "council", "court", "cult", "followers", "warriors", "guard"]);

// ⚠️ A SHARED WORD IS ONLY EVIDENCE IF IT IS A NAME (2026-08-22).
//
// The first run weighted a shared word purely by how many factions used it, so
// a word appearing in exactly one faction scored a full 60 — whether it was
// "Martikov" or "ancient". The results spoke for themselves:
//
//     Ancient Red Dragon    -> Ancient mountain tribe   ("ancient")
//     Arcane Sword          -> The Arcane Brotherhood   ("arcane")
//     Death Dog             -> Cult of Death House      ("death")
//     Clockwork Iron Cobra  -> Iron Lords               ("iron")
//
// Eighteen ancient dragons were assigned to a mountain tribe. "Martikov" and
// "Zarovich" are proper nouns and sharing one is near-proof; "ancient" is an
// adjective half the bestiary carries.
//
// These still count, because a real place name can look generic — "Amber" means
// something specific in Johnny's campaign. But they are CAPPED, so they nudge a
// ranking and can never decide one on their own.
const GENERIC_WORD = new Set([
  "ancient", "elder", "old", "young", "adult", "great", "greater", "lesser", "high", "low",
  "arcane", "magic", "magical", "mystic", "eldritch",
  "death", "dead", "blood", "bone", "soul", "spirit", "ghost", "shadow", "dark", "night",
  "fire", "flame", "frost", "ice", "storm", "thunder", "lightning", "earth", "stone", "iron",
  "steel", "silver", "gold", "bronze", "copper", "brass", "crystal", "obsidian",
  "black", "white", "red", "blue", "green", "grey", "gray", "crimson", "azure", "emerald",
  "holy", "unholy", "sacred", "cursed", "blessed", "divine", "infernal", "celestial",
  "wild", "savage", "fierce", "swift", "strong", "silent", "hidden", "secret", "lost",
  "royal", "imperial", "noble", "grand", "supreme", "eternal", "immortal", "undying",
  "north", "south", "east", "west", "upper", "lower", "inner", "outer", "deep", "under",
  "temple", "tower", "keep", "hall", "gate", "throne", "crown", "blade", "sword", "shield",
  "hand", "eye", "heart", "mind", "war", "battle", "giant", "dire", "greater", "true",
  // Roles and titles. "Death Knight" is not a member of the Clergy of the Red
  // Knight, and "knight" is the only word they share.
  "knight", "knights", "lord", "lords", "lady", "king", "queen", "prince", "baron",
  "captain", "master", "keeper", "keepers", "warden", "wardens", "hunter", "hunters",
  "rider", "riders", "prowler", "prowlers", "servant", "servants", "forces", "force",
  "brotherhood", "sisterhood", "collective", "compact", "covenant", "enclave", "enclaves",
  "colony", "colonies", "hive", "hives", "pack", "horde", "host", "army", "watch",
  // Places. A shared mountain is not a shared identity.
  "mount", "mountain", "mountains", "valley", "vale", "river", "lake", "sea", "coast",
  "forest", "wood", "woods", "hill", "hills", "peak", "peaks", "pass", "isle", "island",
  "city", "town", "village", "castle", "fort", "fortress", "abbey", "shrine", "ruins",
]);

// The most a generic word may contribute, however rare it is in the registry.
const GENERIC_CAP = 12;

// ⚠️ Creature and statblock names. These may never stand in for a person when
// matching against a faction's leader or description — that route is for proper
// nouns only, and a monster manual entry is not a proper noun.
const STATBLOCK_WORD = new Set([
  "archmage", "mage", "wizard", "sorcerer", "warlock", "cleric", "priest", "acolyte",
  "druid", "bard", "monk", "paladin", "ranger", "rogue", "fighter", "barbarian",
  "commoner", "noble", "guard", "scout", "spy", "thug", "bandit", "cultist", "veteran",
  "berserker", "assassin", "knight", "captain", "soldier", "champion", "apprentice",
  "goblin", "hobgoblin", "bugbear", "kobold", "gnoll", "orc", "drow", "duergar", "bullywug",
  "lizardfolk", "sahuagin", "troglodyte", "yuanti", "grimlock", "quaggoth", "githyanki",
  "elf", "dwarf", "human", "halfling", "gnome", "tiefling", "dragonborn", "aarakocra",
  "zombie", "skeleton", "ghoul", "ghast", "wight", "specter", "spectre", "wraith",
  "vampire", "spawn", "lich", "mummy", "banshee", "revenant", "shadow", "ghost", "poltergeist",
  "dragon", "wyrmling", "drake", "wyvern", "giant", "ogre", "troll", "ettin", "cyclops",
  "golem", "elemental", "demon", "devil", "fiend", "celestial", "angel", "deva", "couatl",
  "basilisk", "medusa", "minotaur", "harpy", "hag", "chimera", "manticore", "griffon",
  "beholder", "illithid", "aboleth", "slaad", "modron", "oblex", "otyugh", "mimic",
  "wolf", "bear", "spider", "snake", "rat", "swarm", "steed", "defender", "familiar",
]);

// ⚠️ NOT A SPECIES. "commoner" is dnd5e's default statblock, carried by half the
// humanoids in a world. Scoring it as a species match gave 35 points to any two
// creatures that had simply never been given one, which is how Rahadin, Strahd's
// own chamberlain, was assigned to the Red Wizards of Thay on "both commoner;
// both evil".
const NOT_A_SPECIES = new Set(["commoner", "humanoid", "any", "none", ""]);

/** Distinctive words in a name. "The Bloodtusk Clan" -> {bloodtusk} */
function _tokens(text) {
    return new Set(String(text || "").toLowerCase()
        .replace(/[^a-z0-9\s'-]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP.has(w)));
}

function _alignment(actor) {
    const a = String(actor?.system?.details?.alignment || "").toLowerCase();
    return {
        evil:    /evil/.test(a),
        good:    /good/.test(a),
        lawful:  /lawful/.test(a),
        chaotic: /chaotic/.test(a),
        known:   a.trim().length > 0,
    };
}

function _cr(actor) {
    const v = Number(actor?.system?.details?.cr);
    return Number.isFinite(v) ? v : null;
}

function _languages(actor) {
    const l = actor?.system?.traits?.languages;
    const out = new Set();
    for (const v of (l?.value ?? [])) out.add(String(v).toLowerCase());
    if (typeof l?.custom === "string") {
        for (const v of l.custom.split(/[;,]/)) { const t = v.trim().toLowerCase(); if (t) out.add(t); }
    }
    return out;
}

/**
 * Score one faction as a home for this creature.
 *
 * Returns the score plus the human-readable reasons behind it, because a silent
 * number is worthless when this later picks something surprising and Johnny
 * wants to know why.
 *
 * @returns {{score:number, reasons:string[], excluded:(string|null)}}
 */
export function scoreFactionForCreature(faction, ctx) {
    const {
        creatureBase = "",
        sceneName = "",
        worldTag = "",
        template = null,
        sceneIntelText = "",
        factionIdsOnScene = new Set(),
    } = ctx || {};

    const reasons = [];
    let score = 0;

    // ── Hard exclusions ──────────────────────────────────────────────────
    // Another world's factions are not merely unlikely, they are wrong.
    if (worldTag && faction.worldTag && faction.worldTag !== worldTag) {
        return { score: 0, reasons: [], excluded: "belongs to a different world" };
    }

    const base = String(creatureBase || "").toLowerCase().trim();
    const familyBases = new Set(getFamilyMembers(base).map(b => b.toLowerCase()));
    const fBase = String(faction.creatureBase || "").toLowerCase().trim();
    const kinMatch = !!fBase && familyBases.has(fBase);

    // A faction that recruits a specific kin does not take other kin. The Wolf
    // Pack is not hiring goblins.
    if (fBase && !kinMatch) {
        return { score: 0, reasons: [], excluded: `recruits ${fBase}, not ${base || "this creature"}` };
    }

    // A monster does not join a civic institution unless that institution is
    // explicitly its own kin (handled above — kinMatch would be true).
    if (MONSTROUS_BASES.has(base) && CIVIC_TYPES.has(String(faction.type || "").toLowerCase()) && !kinMatch) {
        return { score: 0, reasons: [], excluded: `a ${base} would not belong to a ${faction.type}` };
    }

    // ── Positive signals ─────────────────────────────────────────────────

    // 1. KIN — the strongest signal, and the only one the old lookup had.
    if (kinMatch) {
        score += 100;
        reasons.push(fBase === base ? `recruits ${base}s` : `recruits ${fBase}s — same family as ${base}`);
    }

    // 2. PLACE — this is what makes the imported 440 visible at all. An
    //    organisation faction has no kin, so where it operates IS its identity.
    if (sceneName) {
        const places = [
            ...(Array.isArray(faction.presence) ? faction.presence : []),
            faction.headquarters, faction.nation, faction.scope, faction.scene,
        ].filter(Boolean);
        const hit = places.find(p => _placeMatches(sceneName, p));
        if (hit) {
            score += 80;
            reasons.push(`operates at ${hit}`);
        }
    }

    // 3. SHAPE — a knight belongs in an order, a guard in a garrison. The
    //    creature's own template already names the institution type it implies.
    if (template?.type && String(faction.type || "").toLowerCase() === String(template.type).toLowerCase()) {
        score += 40;
        reasons.push(`is a ${faction.type}, which is what a ${base || "creature"} like this forms`);
    }

    // 4. CANON — the scene's own intelligence names this faction. If the world
    //    bible says the Zhentarim run this town, they are the answer.
    if (sceneIntelText && faction.name) {
        const n = normalizeFactionName(faction.name);
        if (n.length > 3 && normalizeFactionName(sceneIntelText).includes(n)) {
            score += 60;
            reasons.push("named in this scene's canonical lore");
        }
    }

    // 5. COMPANY — somebody already standing on this map belongs to it. This is
    //    what keeps four goblins in ONE warband instead of four.
    if (faction.id && factionIdsOnScene.has(faction.id)) {
        score += 70;
        reasons.push("others on this scene already belong to it");
    }

    // 6. RECENCY — a pure tiebreak between two otherwise equal candidates.
    if (faction.lastActive && (Date.now() - faction.lastActive) < 1000 * 60 * 60 * 24 * 30) {
        score += 10;
        reasons.push("active recently");
    }


    // ── Everything below needs the ACTOR, and is skipped without one ─────
    const actor = ctx?.actor ?? null;
    if (actor) {
        const at = _tokens(actor.name);
        const ft = _tokens(faction.name);
        const shared = [...at].filter(w => ft.has(w));
        if (shared.length) {
            // ⚠️ WEIGHT BY RARITY. "Martikov" appears in exactly one faction and
            // identifies it beyond doubt. "Amber" appears in twelve of Johnny's,
            // and "temple" in four more, so an Amber Temple token matched a dozen
            // factions equally and told us nothing. A shared word is worth what it
            // narrows down: unique words score full, common ones score a fraction.
            for (const w of shared) {
                const seenIn = ctx.tokenFrequency?.get(w) ?? 1;
                const generic = GENERIC_WORD.has(w);
                const worth = generic
                    ? Math.min(GENERIC_CAP, Math.round(60 / seenIn))
                    : Math.round(60 / seenIn);
                score += worth;
                reasons.push(generic
                    ? `shares "${w}", but that is an ordinary word`
                    : seenIn > 1
                    ? `shares "${w}" (${seenIn} factions use it)`
                    : `shares the name "${w}"`);
            }
        }

        // ── NAMED BY THE FACTION ITSELF ──────────────────────────────────────
        //
        // ⚠️ THE STRONGEST EVIDENCE IN THE REGISTRY, AND IT WAS NEVER READ.
        //
        // Vladimir Horngaard was filed under Strahd's Servants — the enemy he died
        // opposing — on the strength of "both undead". Meanwhile his real faction
        // sat in the same registry naming him TWICE:
        //
        //   Order of the Silver Dragon
        //     leader: "Vladimir Horngaard (former leader, now revenant)"
        //     description: "...Vladimir Horngaard, their former leader, now exists
        //                   as a corrupted revenant at Argynvostholt..."
        //
        // A faction that names a creature as its leader is not a guess, it is a
        // statement. Johnny's imported library is full of these and every one was
        // being thrown away in favour of a shared creature type.
        //
        // ⚠️ ONLY THE CREATURE'S OWN DISTINCTIVE NAME WORDS ARE MATCHED, never
        // species or type words. Reading descriptions for creature TYPES is what
        // labelled the Royal Guard of Damara as undead because they fight undead.
        // A proper noun in a leader field means membership; the word "undead" in a
        // description means nothing of the kind.
        // ⚠️ A CREATURE TYPE IS NOT A PERSONAL NAME. "Archmage" matched the Cowled
        // Wizards because their leader field describes an archmage, and "Bullywug"
        // matched the Foul Aristocracy the same way — five archmages and a bullywug
        // assigned on 80 points of pure coincidence. "Vladimir Horngaard" and
        // "Kasimir Velikov" are people; "Archmage" is a statblock.
        const distinct = [...at].filter(w =>
            !GENERIC_WORD.has(w) && !STATBLOCK_WORD.has(w) && w.length >= 4);
        if (distinct.length) {
            const leader = String(faction.leader || "").toLowerCase();
            const blurb  = `${faction.description || ""} ${faction.purpose || ""}`.toLowerCase();
            const inLeader = distinct.filter(w => leader.includes(w));
            const inBlurb  = distinct.filter(w => blurb.includes(w));
            // ⚠️ SAY WHICH WORD MATCHED. "named as their leader" is a verdict with
            // the evidence removed, and it cost a round trip: The Mad Mage of Mount
            // Baratok landed on the Holy Slayers at 80 points and neither of us
            // could tell whether that was "baratok", which would be real, or
            // "mount", which would be a coincidence about a mountain.
            if (inLeader.length) {
                score += 80;
                reasons.push(`their leader is named "${inLeader.join('", "')}"`);
            }
            if (inBlurb.length && !inLeader.length) {
                score += Math.min(50, 25 * inBlurb.length);
                reasons.push(`their description mentions "${inBlurb.join('", "')}"`);
            }
        }

        // ⚠️ NO SPECIES BLOCK HERE. The KIN signal above already scores this,
        // at 100 and with family expansion this one never had. Keeping both
        // billed one fact twice — the exact double-count fixed on 2026-08-21
        // and reintroduced by this merge until the audit caught it.
        const fbase = String(faction.creatureBase || "").toLowerCase();

        // ── Creature type (humanoid, undead, fiend...).
        //
        // ⚠️ NOT WHEN IT REPEATS THE SPECIES MATCH. "Undead" is both a species and a
        // creature type, so a ghoul against Strahd's Servants scored 35 for the
        // species and another 15 for the type — one fact, counted twice, printed as
        // "both undead; both undead", and worth exactly the 50 needed to clear the
        // bar. Twenty-one generic undead were assigned on the strength of a single
        // shared word double-billed.
        const type = String(actor.system?.details?.type?.value || "").toLowerCase();
        const ftype = String(faction.type || "").toLowerCase();
        if (type && ftype && ftype.includes(type) && type !== base) {
            score += 15;
            reasons.push(`same creature type (${type})`);
        }

        // ── Alignment, both axes, scored separately so one can agree and one not.
        const al = _alignment(actor);
        const ftext = `${faction.name || ""} ${faction.type || ""} ${faction.purpose || ""} ${faction.description || ""}`.toLowerCase();
        if (al.known) {
            const fEvil = /\bevil\b|malevolent|tyrann|cruel|dark cult/.test(ftext);
            const fGood = /\bgood\b|benevolent|protect|charitab|righteous|holy/.test(ftext);
            if (al.evil && fEvil) { score += 20; reasons.push("both evil"); }
            if (al.good && fGood) { score += 20; reasons.push("both good"); }
            if (al.evil && fGood) { score -= 25; reasons.push("an evil creature in a good faction"); }
            if (al.good && fEvil) { score -= 25; reasons.push("a good creature in an evil faction"); }
            if (al.lawful  && /\blawful\b|discipl|hierarch|military|order of/.test(ftext)) score += 6;
            if (al.chaotic && /\bchaotic\b|raid|marauder|anarch|wild/.test(ftext))         score += 6;
        }

        // ── Power. A CR 30 does not take orders in a village militia, and a CR 1/8
        //    is not running an archmage conclave.
        const cr = _cr(actor);
        const tier = String(faction.tier || "").toLowerCase();
        if (cr !== null) {
            if (cr >= 15 && /(empire|kingdom|archm|conclave|legend|master)/.test(`${tier} ${ftext}`)) {
                score += 12; reasons.push("powerful enough for a faction of that standing");
            }
            if (cr <= 2 && /(empire|kingdom|conclave|archm)/.test(`${tier} ${ftext}`)) score -= 8;
        }

        // ⚠️ NO PLACE BLOCK HERE EITHER. The PLACE signal above already scores
        // presence, headquarters, nation and scope together, which is strictly
        // more than this one looked at.

        // ── Language in common with the faction's own species.
        const langs = _languages(actor);
        if (fbase && langs.size) {
            const SPEAKS = { orc: "orc", goblin: "goblin", drow: "elvish", duergar: "dwarvish",
                             gnoll: "gnoll", kobold: "draconic", "yuan-ti": "abyssal",
                             giant: "giant", troll: "giant", ogre: "giant", undead: "common" };
            const expect = SPEAKS[fbase];
            if (expect && langs.has(expect)) { score += 10; reasons.push(`speaks ${expect}`); }
        }

        // ── Ties that already exist in the world.
        const allies = (Array.isArray(faction.allies) ? faction.allies : []).map(a => String(a?.name ?? a).toLowerCase());
        if (ctx.knownFactionNames?.length && allies.some(a => ctx.knownFactionNames.includes(a))) {
            score += 8; reasons.push("allied with a faction already in play");
        }
    }

    return { score, reasons, excluded: null };
}

/** Every faction id already represented by a token on the current scene. */
export function factionIdsOnCurrentScene(excludeTokenId = null) {
    const ids = new Set();
    try {
        for (const t of canvas.scene?.tokens ?? []) {
            if (excludeTokenId && t.id === excludeTokenId) continue;
            const id = t.actor?.getFlag?.(MODULE_ID, "factionId");
            if (id) ids.add(id);
        }
    } catch (_) { /* no canvas yet — an empty set is the correct answer */ }
    return ids;
}

/**
 * Rank every registered faction as a home for this creature, best first.
 * Excluded factions are dropped, not scored zero, so the caller cannot
 * accidentally adopt one.
 *
 * @returns {Array<{faction:object, id:string, score:number, reasons:string[]}>}
 */
export function findCandidateFactions(ctx) {
    const all = getAllFactions();
    const out = [];
    for (const [id, faction] of Object.entries(all)) {
        if (!faction || typeof faction !== "object") continue;
        const { score, reasons, excluded } = scoreFactionForCreature({ ...faction, id }, ctx);
        if (excluded || score <= 0) continue;
        out.push({ faction: { ...faction, id }, id, score, reasons });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
}

// The bar a candidate must clear to be adopted instead of inventing. 100 is
// deliberately "one strong signal on its own" — kin alone qualifies, and so does
// place plus shape. A lone weak signal (place alone, at 80) does not: a goblin
// in a Waterdeep sewer should get its own warband, not be filed under whoever
// else happens to be in the city.
export const ADOPT_THRESHOLD = 100;

/**
 * THE CHOKEPOINT. Answer "which faction does this creature belong to?" without
 * inventing anything.
 *
 * @returns {{faction:object|null, id:string|null, decision:"adopt"|"invent",
 *            score:number, reasons:string[], considered:number}}
 */
export function decideFaction(ctx) {
    const candidates = findCandidateFactions(ctx);
    const best = candidates[0] ?? null;

    if (best && best.score >= ADOPT_THRESHOLD) {
        console.log(`${TAG} | "${best.faction.name}" already exists and fits (${best.score}): ${best.reasons.join("; ")}. Not inventing one.`);
        return {
            faction: best.faction, id: best.id, decision: "adopt",
            score: best.score, reasons: best.reasons, considered: candidates.length,
        };
    }

    if (best) {
        console.log(`${TAG} | Closest existing faction was "${best.faction.name}" (${best.score}, needs ${ADOPT_THRESHOLD}) — inventing a new one.`);
    } else {
        console.log(`${TAG} | No existing faction fits this creature (${Object.keys(getAllFactions()).length} in the registry) — inventing a new one.`);
    }
    return {
        faction: null, id: null, decision: "invent",
        score: best?.score ?? 0, reasons: best?.reasons ?? [], considered: candidates.length,
    };
}

/**
 * ADOPT ON COLLISION.
 *
 * The generator has just produced a name. Before it becomes a new faction, check
 * whether the world already uses that name. Scene intelligence and the world
 * bible are fed into the generation prompt, so it will quite often produce a
 * canonical name that already exists in the registry — and without this test,
 * every one of those became a duplicate sitting alongside the real entry.
 *
 * @returns {{faction:object, id:string}|null} the existing faction, if any
 */
export function findFactionByName(name) {
    const target = normalizeFactionName(name);
    if (!target) return null;
    for (const [id, faction] of Object.entries(getAllFactions())) {
        if (normalizeFactionName(faction?.name) === target) return { faction: { ...faction, id }, id };
    }
    return null;
}

/**
 * Record that a faction is present at a scene.
 *
 * Called whenever a faction is adopted for a scene it had no presence at. This
 * is how the world map grows on its own: a warband met in one valley becomes
 * findable there forever, and the imported library factions accumulate the
 * places your table actually visits rather than only the ones the source book
 * listed.
 */
export async function rememberPresence(factionId, sceneName) {
    if (!factionId || !sceneName) return false;
    if (!game.user?.isGM) return false;      // only a GM may write world data
    try {
        const faction = getFaction(factionId);
        if (!faction) return false;
        const presence = Array.isArray(faction.presence) ? [...faction.presence] : [];
        if (presence.some(p => _placeMatches(sceneName, p))) return false;   // already known
        presence.push(sceneName);
        await saveFaction({ ...faction, id: factionId, presence, lastActive: Date.now() });
        console.log(`${TAG} | "${faction.name}" now has recorded presence at ${sceneName}.`);
        return true;
    } catch (err) {
        console.warn(`${TAG} | Could not record presence for ${factionId}:`, err);
        return false;
    }
}

/**
 * A one-line summary of what already exists, for injection into the generation
 * prompt. Given to the AI so that when it DOES invent, it invents something that
 * does not collide with — and ideally acknowledges — what is already there.
 */
export function describeNeighbours(ctx, limit = 8) {
    const candidates = findCandidateFactions({ ...ctx });
    if (!candidates.length) return "";
    const lines = candidates.slice(0, limit).map(c => {
        const f = c.faction;
        const bits = [f.type, f.leader ? `led by ${f.leader}` : "", f.headquarters || ""].filter(Boolean);
        return `  • ${f.name}${bits.length ? ` (${bits.join(", ")})` : ""}`;
    });
    return `\n\nFACTIONS THAT ALREADY EXIST IN THIS WORLD AND COULD PLAUSIBLY BE RELEVANT HERE:\n${lines.join("\n")}\n` +
        `Do NOT reuse any of these names for the new faction. If one of them is genuinely the right answer, ` +
        `respond with EXISTING: <exact name> on its own line and nothing else.`;
}

/**
 * Every faction ranked as a home for this creature, best first.
 *
 * ⚠️ Goes through findCandidateFactions, so the hard exclusions apply here too.
 * The bulk-assign pass used to call a scorer that had none, which is how a
 * wolf pack could ever have been offered a goblin.
 *
 * @returns {Array<object>} faction objects with `_score` and `_why`
 */
export function rankFactions(actor, { sceneName = "", worldTag = "", limit = 0 } = {}) {
    const all = getAllFactions() ?? {};

    // How many factions use each word, so a distinctive name outweighs a common
    // one. Built once per ranking, never per faction.
    const tokenFrequency = new Map();
    for (const f of Object.values(all)) {
        if (!f || typeof f !== "object") continue;
        for (const w of _tokens(f.name)) tokenFrequency.set(w, (tokenFrequency.get(w) ?? 0) + 1);
    }

    const knownFactionNames = [];
    for (const a of (game.actors ?? [])) {
        try {
            const fid = a.getFlag(MODULE_ID, "factionId");
            if (fid && all[fid]?.name) knownFactionNames.push(String(all[fid].name).toLowerCase());
        } catch (_) { /* unreadable actor */ }
    }

    let creatureBase = "";
    try { creatureBase = resolveCreatureBase(actor) || ""; } catch (_) {}

    const ctx = {
        actor, sceneName, worldTag, creatureBase, tokenFrequency,
        knownFactionNames: [...new Set(knownFactionNames)],
        factionIdsOnScene: factionIdsOnCurrentScene(null),
    };

    const rows = findCandidateFactions(ctx)
        .map(c => ({ ...c.faction, _score: c.score, _why: c.reasons }));
    return limit > 0 ? rows.slice(0, limit) : rows;
}
