// ─── ACE: Engine — Living World Faction Registry ────────────────────────────
// World-level registry of named factions with political geography hierarchy.
// Two layers: stable governance (kingdom → duchy → county → town → district)
// and volatile power factions (gangs, tribes, cults, warbands) that exist
// WITHIN the political geography but don't necessarily answer to it.
//
// Every NPC belongs to a faction. Commoners inherit the local geography.
// Bandits/goblins/cultists get their own faction within the geography.
// 1-in-N chance of a token being a spy/deserter from a DIFFERENT faction.
//
// Moved from ace-envoy/src/ai/faction-registry.js as part of the
// Envoy → Engine merger. Settings/flag namespaces switched to ace-engine.
// EngineBridge.* calls now reach engine's own api by module id.

import { isAIFailure } from "./ai-failure.mjs";
import { getSecret } from "../settings.mjs";


const MODULE_ID = "ace-engine";

/** Read engine's AI config — replaces envoy's getEnvoyAIConfig. */
function getEnvoyAIConfig() {
    try {
        return {
            provider: game.settings.get(MODULE_ID, "aiProvider") || "ollama",
            apiKey:   getSecret("apiKey")     || "",
            apiUrl:   game.settings.get(MODULE_ID, "apiUrl")     || "",
            modelName: game.settings.get(MODULE_ID, "modelName") || "",
        };
    } catch (_) {
        return { provider: "ollama", apiKey: "", apiUrl: "", modelName: "" };
    }
}

/** Drop-in stand-in for the Envoy → Engine bridge. We ARE the engine, so we
 *  reach our own public API (game.modules.get(MODULE_ID).api.X). All existing
 *  `EngineBridge.X(...)` call sites in this file work unchanged. */
const EngineBridge = {
    isEngineActive: () => true,
    digestLookupContext:        (...args) => game.modules.get(MODULE_ID)?.api?.digestLookupContext?.(...args)        ?? "",
    getSceneIntelligencePrompt: (...args) => game.modules.get(MODULE_ID)?.api?.getSceneIntelligencePrompt?.(...args) ?? Promise.resolve(""),
    getSceneIntelligence:       (...args) => game.modules.get(MODULE_ID)?.api?.getSceneIntelligence?.(...args)       ?? Promise.resolve(null),
    searchWorldBible:           (...args) => game.modules.get(MODULE_ID)?.api?.searchWorldBible?.(...args)           ?? "",
    resolveWorldBibleLocation:  (...args) => game.modules.get(MODULE_ID)?.api?.resolveWorldBibleLocation?.(...args)  ?? Promise.resolve(""),
    getWorldGraphFactions:      (...args) => game.modules.get(MODULE_ID)?.api?.getWorldGraphFactions?.(...args)      ?? [],
    getWorldBibleFactions:      (...args) => game.modules.get(MODULE_ID)?.api?.getWorldBibleFactions?.(...args)      ?? [],
};

// AIHandler imported lazily to avoid circular dependency
// (conversation-engine.mjs → faction-registry.mjs → conversation-engine.mjs)
let _AIHandler = null;
async function _getAIHandler() {
    if (!_AIHandler) {
        const mod = await import("./conversation-engine.mjs");
        _AIHandler = mod.AIHandler;
    }
    return _AIHandler;
}

const TAG = "ACE: Engine | Factions";
const SETTING_KEY = "factionRegistry";

// ─── FACTION TYPE TEMPLATES ──────────────────────────────────────────────────
// Maps creature patterns to default faction types and structures.

export const FACTION_TEMPLATES = {
    // ── Power factions (volatile) ─────────────────────────────────────────
    bandit:    { type: "gang",      stability: "sand",    structure: "leader + enforcers + grunts",     canSpy: true  },
    thug:      { type: "gang",      stability: "sand",    structure: "leader + enforcers + grunts",     canSpy: true  },
    pirate:    { type: "gang",      stability: "sand",    structure: "captain + officers + crew",       canSpy: true  },
    goblin:    { type: "tribe",     stability: "sand",    structure: "chieftain + shaman + warriors",   canSpy: true  },
    kobold:    { type: "tribe",     stability: "sand",    structure: "chieftain + trapmaster + miners",  canSpy: true  },
    orc:       { type: "tribe",     stability: "sand",    structure: "warchief + champions + warriors", canSpy: true  },
    hobgoblin: { type: "legion",    stability: "stone",   structure: "warlord + captains + soldiers",   canSpy: true  },
    gnoll:     { type: "warband",   stability: "glass",   structure: "fang + pack lords + hunters",     canSpy: true  },
    lizardfolk:{ type: "tribe",     stability: "stone",   structure: "queen/king + shamans + warriors", canSpy: true  },
    bugbear:   { type: "gang",      stability: "sand",    structure: "boss + bullies + scouts",         canSpy: true  },
    drow:      { type: "house",     stability: "stone",   structure: "matron + priestesses + warriors", canSpy: true  },
    cultist:   { type: "cult",      stability: "glass",   structure: "high priest + zealots + initiates", canSpy: true },
    acolyte:   { type: "cult",      stability: "glass",   structure: "high priest + zealots + initiates", canSpy: true },

    // ── Governance factions (stable) ──────────────────────────────────────
    guard:     { type: "garrison",  stability: "stone",   structure: "captain + sergeants + guards",    canSpy: true  },
    soldier:   { type: "garrison",  stability: "stone",   structure: "captain + sergeants + soldiers",  canSpy: true  },
    knight:    { type: "order",     stability: "granite", structure: "commander + knights + squires",   canSpy: true  },
    noble:     { type: "court",     stability: "granite", structure: "lord + advisors + courtiers",     canSpy: true  },

    // ── Civilian factions (very stable) ───────────────────────────────────
    commoner:  { type: "settlement",stability: "granite", structure: "mayor + merchants + residents",   canSpy: true  },
    merchant:  { type: "guild",     stability: "stone",   structure: "guildmaster + senior + junior",   canSpy: true  },
    priest:    { type: "temple",    stability: "granite", structure: "high priest + priests + acolytes",canSpy: true  },
    bartender: { type: "establishment", stability: "granite", structure: "owner + staff",               canSpy: true  },
    barmaid:   { type: "establishment", stability: "granite", structure: "owner + staff",               canSpy: true  },
    innkeeper: { type: "establishment", stability: "granite", structure: "owner + staff",               canSpy: true  },

    // ── Non-sentient / master-bound (no spy chance) ───────────────────────
    construct: { type: "creator",   stability: "granite", structure: "creator + constructs",            canSpy: false },
    golem:     { type: "creator",   stability: "granite", structure: "creator + constructs",            canSpy: false },
    skeleton:  { type: "master",    stability: "stone",   structure: "necromancer + undead thralls",    canSpy: false },
    zombie:    { type: "master",    stability: "stone",   structure: "necromancer + undead thralls",    canSpy: false },
    undead:    { type: "master",    stability: "stone",   structure: "necromancer/lich + undead",       canSpy: false },

    // ── Beast / natural (pack hierarchy) ──────────────────────────────────
    wolf:      { type: "pack",      stability: "stone",   structure: "alpha + pack members",            canSpy: false },
    bear:      { type: "pack",      stability: "stone",   structure: "solitary or mated pair",          canSpy: false },
    beast:     { type: "pack",      stability: "stone",   structure: "alpha + pack members",            canSpy: false },

    // ── Tribal peoples (2026-08-22) ───────────────────────────────────────
    //
    // ⚠️ WITHOUT A ROW HERE A CREATURE RESOLVES TO "commoner". resolveCreatureBase
    // falls through to that default, so every bullywug in Johnny's world was
    // being treated as a villager who might join a merchants' guild. Johnny:
    // "the Bullywugs have tribes and shit like that, with shamans and all kinds
    // of shit, so let's do the most realistic thing."
    //
    // These are the social creatures that appear in his campaign. Solitary ones
    // are deliberately absent: an ancient dragon, an aboleth or an awakened
    // shrub has no faction, and inventing one for them would be worse than
    // leaving them alone.
    bullywug:  { type: "tribe",     stability: "sand",    structure: "chieftain + shaman + warriors",   canSpy: true  },
    troglodyte:{ type: "tribe",     stability: "sand",    structure: "chieftain + shaman + warriors",   canSpy: true  },
    grimlock:  { type: "tribe",     stability: "sand",    structure: "chieftain + seers + hunters",     canSpy: true  },
    "kuo-toa": { type: "tribe",     stability: "glass",   structure: "archpriest + whips + monitors",   canSpy: true  },
    sahuagin:  { type: "tribe",     stability: "stone",   structure: "baron + priestesses + hunters",   canSpy: true  },
    "yuan-ti": { type: "cult",      stability: "stone",   structure: "abomination + malisons + purebloods", canSpy: true },
    duergar:   { type: "clan",      stability: "stone",   structure: "clan lord + overseers + smiths",  canSpy: true  },
    ogre:      { type: "warband",   stability: "sand",    structure: "biggest one + the rest",          canSpy: false },
    troll:     { type: "warband",   stability: "sand",    structure: "biggest one + the rest",          canSpy: false },
    "hill giant":  { type: "steading", stability: "sand", structure: "chief + brutes",                  canSpy: false },
    "frost giant": { type: "steading", stability: "stone", structure: "jarl + thanes + thralls",        canSpy: true  },
    werewolf:  { type: "pack",      stability: "glass",   structure: "alpha + pack + new-bitten",       canSpy: true  },
    wererat:   { type: "pack",      stability: "glass",   structure: "alpha + pack + new-bitten",       canSpy: true  },
    vistani:   { type: "caravan",   stability: "stone",   structure: "elder + families + outriders",    canSpy: true  },
    mongrelfolk:{ type: "warren",   stability: "glass",   structure: "keeper + the made + the kept",    canSpy: true  },

    // ── Bound to a master (2026-08-22) ────────────────────────────────────
    //
    // ⚠️ THESE ARE NOT FREE AGENTS AND THEY ARE NOT NOBODY. A Strahd Zombie
    // belongs to Strahd, a specter to whatever raised it, an imp to the devil
    // who sent it. Killing one is a wound to its master, and that is precisely
    // the connection that makes reputation feel like a world rather than a
    // scoreboard. Left untyped they defaulted to "commoner" and belonged to
    // nothing, so slaughtering Strahd's undead cost the party nothing with Strahd.
    specter:   { type: "master",    stability: "stone",   structure: "necromancer/lich + undead",       canSpy: false },
    spectre:   { type: "master",    stability: "stone",   structure: "necromancer/lich + undead",       canSpy: false },
    shadow:    { type: "master",    stability: "stone",   structure: "necromancer/lich + undead",       canSpy: false },
    wraith:    { type: "master",    stability: "stone",   structure: "necromancer/lich + undead",       canSpy: false },
    wight:     { type: "master",    stability: "stone",   structure: "necromancer/lich + undead",       canSpy: false },
    ghoul:     { type: "master",    stability: "stone",   structure: "necromancer/lich + undead",       canSpy: false },
    ghast:     { type: "master",    stability: "stone",   structure: "necromancer/lich + undead",       canSpy: false },
    mummy:     { type: "master",    stability: "granite", structure: "high priest + guardians",         canSpy: false },
    ghost:     { type: "master",    stability: "glass",   structure: "the haunted place + its dead",    canSpy: false },
    revenant:  { type: "master",    stability: "granite", structure: "the oath + those bound by it",    canSpy: true  },
    "vampire spawn": { type: "master", stability: "stone", structure: "vampire lord + spawn",           canSpy: false },
    "phantom warrior": { type: "master", stability: "granite", structure: "the fallen order + its dead", canSpy: false },
    imp:       { type: "master",    stability: "stone",   structure: "archdevil + lesser devils",       canSpy: true  },
    quasit:    { type: "master",    stability: "stone",   structure: "demon lord + lesser demons",      canSpy: true  },
    abishai:   { type: "master",    stability: "stone",   structure: "Tiamat + her abishai",            canSpy: true  },
};

// ── CREATURE FAMILIES ────────────────────────────────────────────────────────
// Creatures in the same family can share factions. A bugbear dragged onto a scene
// with an existing goblin tribe should be offered that tribe as an option — because
// goblins, hobgoblins, and bugbears are all goblinoids who worship Maglubiyet
// and commonly form mixed-race warbands with bugbears as enforcers/leaders.
export const CREATURE_FAMILIES = {
    goblinoid: ["goblin", "hobgoblin", "bugbear"],            // Maglubiyet's children
    orcish:    ["orc", "half-orc"],                            // Gruumsh worshippers
    underdark: ["drow", "duergar", "svirfneblin"],             // Underdark races
    // ⚠️ THE UNDEAD LIST WAS MISSING THE ONES HE ACTUALLY FIGHTS. Specters,
    // shadows, phantom warriors and vampire spawn are most of the undead in
    // this campaign — the Specter alone has been met 2,205 times — and none of
    // them were in this list, so they could never share a master's faction with
    // the skeletons and zombies standing beside them.
    undead:    ["skeleton", "zombie", "undead", "wight", "ghoul", "ghast", "ghost",
                "wraith", "specter", "spectre", "shadow", "mummy", "revenant",
                "vampire spawn", "phantom warrior"],
    construct: ["construct", "golem"],
    canine:    ["wolf", "worg", "dire wolf"],
    // Amphibious and subterranean peoples who live in tribes with shamans.
    tribal:    ["bullywug", "troglodyte", "grimlock", "kuo-toa", "sahuagin", "lizardfolk"],
    giantkin:  ["ogre", "troll", "hill giant", "frost giant"],
    lycan:     ["werewolf", "wererat", "werebear", "wereboar"],
    fiend:     ["imp", "quasit", "abishai"],
    criminal:  ["bandit", "thug", "pirate", "assassin"],       // Human criminal types
    military:  ["guard", "soldier", "knight", "veteran"],       // Organized military
    civilian:  ["commoner", "merchant", "priest", "bartender", "barmaid", "innkeeper"],
    cultist:   ["cultist", "acolyte", "fanatic"],
};

// Reverse lookup: creature base → family key
const _creatureToFamily = {};
for (const [family, members] of Object.entries(CREATURE_FAMILIES)) {
    for (const member of members) {
        _creatureToFamily[member] = family;
    }
}

/**
 * Get the creature family for a creature base.
 * @param {string} creatureBase
 * @returns {string|null} — family key, or null if no family
 */
export function getCreatureFamily(creatureBase) {
    return _creatureToFamily[creatureBase] || null;
}

/**
 * Get all creature bases in the same family.
 * @param {string} creatureBase
 * @returns {string[]} — all bases in the family, including the input
 */
export function getFamilyMembers(creatureBase) {
    const family = _creatureToFamily[creatureBase];
    if (!family) return [creatureBase];
    return CREATURE_FAMILIES[family] || [creatureBase];
}

// ── POLITICAL TIER HIERARCHY ─────────────────────────────────────────────────
// From largest to smallest. Used for auto-nesting.
export const POLITICAL_TIERS = [
    "empire",        // Largest sovereign entity
    "kingdom",       // Major sovereign nation
    "duchy",         // Province / major region
    "county",        // Regional subdivision
    "city-state",    // Self-governing city
    "town",          // Settlement
    "district",      // Ward / neighborhood
    "establishment", // Tavern, shop, guild hall
];

// ── STABILITY TIERS ──────────────────────────────────────────────────────────
// How resistant a faction is to change. Only shifts via campaign events.
export const STABILITY = {
    granite: { label: "Granite",  desc: "Almost never changes (empires, kingdoms, temples)" },
    stone:   { label: "Stone",    desc: "Rarely changes (towns, garrisons, established guilds)" },
    sand:    { label: "Sand",     desc: "Can shift when campaign events dictate (tribes, gangs)" },
    glass:   { label: "Glass",    desc: "Can shatter overnight (cults, warbands, conspiracies)" },
};

// ─── DATA ACCESS ─────────────────────────────────────────────────────────────

function _load() {
    try {
        return game.settings.get(MODULE_ID, SETTING_KEY) ?? {};
    } catch (_) {
        return {};
    }
}

async function _save(data) {
    try {
        await game.settings.set(MODULE_ID, SETTING_KEY, data);
        // Nudge the triple-backup mirror so Tier 2 reflects the new registry.
        try { const { requestSync } = await import("../memory-sync-engine.mjs"); requestSync(); } catch (_) { /* sync optional */ }
    } catch (e) {
        console.error(`${TAG} | Failed to save faction registry:`, e);
    }
}

// Serialize writes to prevent race conditions
let _writeLock = Promise.resolve();

async function _serializedSave(data) {
    const prev = _writeLock;
    _writeLock = prev.then(() => _save(data)).catch(err => {
        console.error(`${TAG} | Serialized save failed:`, err);
    });
    return _writeLock;
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

/**
 * Get all factions in the registry.
 * @returns {Object<string, FactionData>}
 */
export function getAllFactions() {
    return _load();
}

// ─── LIVING WORLD: Import World Library factions into the registry ────────────
// Pulls every faction from the World Bible into the operational registry as a
// medium-weight entry (enough to USE — name, type, leader, allies/enemies,
// inferred creature kind — plus a live reference back to the Library for deep
// lore). Deduped by normalized name; existing registry duplicates are folded
// together and any standings preserved. GM-triggered; backs the registry up first.

const _NORM = (s) => String(s || "").toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Creature-kind inference so monster factions can ride the kin-propagation web.
// Empty string = a human/organisation faction (no creature kin).
// ⚠ WORD BOUNDARIES BOTH ENDS. A leading-only boundary matched "Orcus",
// the demon lord, and tagged him as an orc.
// ⚠️🔴 THESE WERE STRINGS, AND EVERY ONE OF THEM WAS DEAD (2026-08-22).
//
// They were written as "\bgnolls?\b" — a STRING literal, not a regex literal.
// In a JavaScript string, \b is the BACKSPACE character, not a word boundary.
// So `new RegExp("\bgnolls?\b")` builds a pattern demanding a backspace byte on
// either side of the word, which no faction name will ever contain.
//
// All seventeen hints matched nothing, silently, from the day they were
// written. The consequences ran the whole length of the system:
//
//   - 448 of Johnny's 453 factions were recorded as being made of HUMANS,
//     including ones literally named "Gnolls", "Kobolds", "Drow" and
//     "Hobgoblin Legions", each with the reason "assumed — an organisation
//     with no other evidence". The evidence was the name.
//   - The faction matcher could therefore never place a monster: a bullywug
//     scored zero against 453 human organisations, because the 91 monster
//     factions he already owned were all wearing a human label.
//   - Which is why I concluded ACE had to INVENT tribes with an AI, and built
//     that, and Johnny quite rightly said: "I don't think there should be any
//     AI-made-up factions. I think we have enough to choose from." He was
//     right. There was never a shortage; there was a broken pattern.
//
// ⚠️ REGEX LITERALS FROM NOW ON. A regex literal cannot suffer this: /\b/ is a
// word boundary and there is no string-escaping layer in between to eat it.
// The control-character checker cannot catch this class either — the file on
// disk is perfectly clean, and the corruption only exists at runtime.
const _CREATURE_HINTS = [
    [/\bhobgoblins?\b/i, "hobgoblin"], [/\bbugbears?\b/i, "bugbear"],
    [/\bgoblinoids?\b/i, "goblin"],    [/\bgoblins?\b/i, "goblin"],
    [/\bkobolds?\b/i, "kobold"],       [/\bgnolls?\b/i, "gnoll"],
    [/\borcs?\b/i, "orc"],             [/\bdrow\b/i, "drow"],
    [/\bduergar\b/i, "duergar"],       [/\blizardfolk\b/i, "lizardfolk"],
    [/\byuan-?ti\b/i, "yuan-ti"],      [/\bsahuagin\b/i, "sahuagin"],
    [/\bkuo-?toa\b/i, "kuo-toa"],      [/\bbullywugs?\b/i, "bullywug"],
    [/\bgiants?\b/i, "giant"],         [/\bogres?\b/i, "ogre"],
    [/\btrolls?\b/i, "troll"],         [/\bgrimlocks?\b/i, "grimlock"],
    [/\btroglodytes?\b/i, "troglodyte"], [/\bmongrelfolk\b/i, "mongrelfolk"],
    [/\bwere(wolf|wolves|rat|rats|bear|bears)\b/i, "werewolf"],
    [/\bvistani\b/i, "vistani"],
    [/\b(imps?|quasits?|abishai|devils?|archdevils?)\b/i, "imp"],
    [/\b(demons?|balors?|mariliths?)\b/i, "quasit"],
    [/\b(constructs?|golems?)\b/i, "golem"],
    [/\b(vampires?|lich|liches|wights?|ghouls?|zombies?|skeletons?|undead|wraiths?|spectres?|specters?)\b/i, "undead"],
    // ADDED 2026-08-22 after a faction literally named "Mind Flayers" was
    // recorded as being made of GOBLINS, because no hint claimed the name and
    // its composition fell through to whatever creature happened to be dropped.
    [/\b(mind ?flayers?|illithids?|ulitharids?)\b/i, "aberration"],
    [/\b(beholders?|aboleths?|aberrations?)\b/i, "aberration"],
];
// Words that mean "we fight these", not "we are these". A description is where
// a faction names its ENEMIES, so any creature word near one of these is the
// opposite of an identity.
const _OPPOSITION = /\b(combat|combating|fight|fighting|oppose|opposing|against|hunt|hunting|hunter|hunters|slay|slayer|slayers|bane|purge|purging|destroy|destroying|defend|defending|protect|protecting|resist|resisting|war)\b/i;

/**
 * What creature a faction is MADE OF. Empty for an organisation of people,
 * which is correct and deliberate.
 *
 * ⚠️🔴 THIS READ THE DESCRIPTION, AND A DESCRIPTION NAMES YOUR ENEMIES (2026-08-21).
 *
 * The old version joined name + type + description + purpose and matched any
 * creature word anywhere in it. So:
 *
 *   Royal Guard of Damara — "renowned for their skill in COMBATING UNDEAD"
 *       -> tagged creatureBase "undead"
 *   Followers of the Morninglord — "They oppose Strahd and his VAMPIRE spawn"
 *       -> tagged creatureBase "undead"
 *
 * Nine of Johnny's organisations were labelled as the very thing they exist to
 * destroy. Then kin propagation did exactly what it was built to do: every time
 * the party killed an undead in Barovia, word spread "among their own kind" and
 * worsened every faction sharing that base. The church of the sun god ended up
 * HATING the party for killing vampires. The factions most opposed to undead
 * were the ones most likely to say so in their description, and therefore the
 * most likely to be mislabelled and turned against the party.
 *
 * The rule now: identity comes from the NAME, never the description. "Orc
 * Legion" is orcs. "Royal Guard of Damara" is not undead, whatever its history
 * says. And a creature word sitting next to an opposition word is an enemy
 * being named, so it yields nothing.
 */
export function inferCreatureBase(f) {
    // ⚠️ THE NAME. Nothing else. Description and purpose name a faction's
    // ENEMIES, and `type` in Johnny's world had already been poisoned by the
    // same bad import - Beholder Hives and Illithid Elder Brain Colonies were
    // both carrying type "undead", which is how they survived a name-based
    // pass. A field that inherited the bug cannot be used to repair it.
    const name = String(f.name || "").toLowerCase();
    if (_OPPOSITION.test(name)) return "";
    for (const [pat, base] of _CREATURE_HINTS) {
        // ⚠️ The pattern is already a compiled regex. Rebuilding it from a
        // string is what let the escaping bug in; there is nothing to rebuild.
        if (pat.test(name)) return base;
    }
    return "";
}

function _buildLibraryEntry(f, keepId) {
    return {
        id:           keepId || f.id || foundry.utils.randomID(),
        name:         f.name || "(unnamed faction)",
        type:         f.type || "",
        creatureBase: inferCreatureBase(f),
        leader:       f.leader || "",
        scope:        f.scope || "",
        nation:       f.nation || "",
        headquarters: f.headquarters || "",
        purpose:      f.purpose || "",
        description:  String(f.description || "").slice(0, 600),
        allies:       Array.isArray(f.allies)   ? f.allies.slice(0, 24)   : [],
        enemies:      Array.isArray(f.enemies)  ? f.enemies.slice(0, 24)  : [],
        presence:     Array.isArray(f.presence) ? f.presence.slice(0, 24) : [],
        worldTag:     game.world?.title || "",
        source:       "library",
        bibleRef:     { factionId: f.id || null, regionId: f._regionId || null },
        lastActive:   Date.now(),
    };
}

async function _backupRegistry(registry) {
    try {
        const worldId = game.world?.id;
        if (!worldId) return;
        const dir  = `worlds/${worldId}/ace-engine`;
        const json = JSON.stringify({ savedAt: new Date().toISOString(), factionRegistry: registry }, null, 2);
        const file = new File([new Blob([json], { type: "application/json" })],
                              "ace-faction-registry.pre-import.bak.json", { type: "application/json" });
        const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
        try { await FP.createDirectory("data", dir, { notify: false }); } catch (_) { /* exists */ }
        const { silentUpload } = await import("../silent-upload.mjs");
        await silentUpload("data", dir, file);
        console.log(`${TAG} | Registry backed up to ${dir}/ace-faction-registry.pre-import.bak.json`);
    } catch (e) {
        console.warn(`${TAG} | Registry backup failed (continuing):`, e);
    }
}

/**
 * Import every World Library faction into the registry (medium + live reference),
 * deduped by normalized name, folding existing registry duplicates and preserving
 * standings. GM-triggered.
 * @param {{dryRun?:boolean}} [opts] — dryRun:true reports what WOULD happen, writes nothing.
 * @returns {Promise<object>} summary of the import
 */
export async function importLibraryFactions({ dryRun = false } = {}) {
    if (!game.user?.isGM) return { error: "GM only" };
    const api = game.modules.get(MODULE_ID)?.api;
    const bibleFactions = api?.getWorldBibleFactions?.() ?? [];
    if (!bibleFactions.length) return { error: "No World Library factions found — is the World Bible loaded for this world?" };

    const registry = _load();
    if (!dryRun) await _backupRegistry(registry);

    // 1. Index existing registry by normalized name; fold internal duplicates.
    const byNorm = new Map();
    const dupMerges = [];   // { fromId, toId }
    for (const [id, f] of Object.entries(registry)) {
        const norm = _NORM(f.name);
        if (!norm) continue;
        if (!byNorm.has(norm)) {
            byNorm.set(norm, { id, faction: { ...f, id } });
        } else {
            const primary = byNorm.get(norm);
            primary.faction.allies  = Array.from(new Set([...(primary.faction.allies  || []), ...(f.allies  || [])]));
            primary.faction.enemies = Array.from(new Set([...(primary.faction.enemies || []), ...(f.enemies || [])]));
            dupMerges.push({ fromId: id, toId: primary.id });
            if (!dryRun) delete registry[id];
        }
    }

    // 2. Dedup the Library factions by normalized name.
    const bibleByNorm = new Map();
    for (const bf of bibleFactions) {
        const norm = _NORM(bf.name);
        if (!norm) continue;
        if (!bibleByNorm.has(norm)) { bibleByNorm.set(norm, { ...bf }); continue; }
        const ex = bibleByNorm.get(norm);
        ex.allies  = Array.from(new Set([...(ex.allies  || []), ...(bf.allies  || [])]));
        ex.enemies = Array.from(new Set([...(ex.enemies || []), ...(bf.enemies || [])]));
        if ((bf.description || "").length > (ex.description || "").length) ex.description = bf.description;
        if (!ex.leader && bf.leader) ex.leader = bf.leader;
    }

    // 3. Merge Library factions into the registry.
    let added = 0, enriched = 0;
    for (const [norm, bf] of bibleByNorm) {
        const existing = byNorm.get(norm);
        const entry = _buildLibraryEntry(bf, existing?.id);
        if (existing) {
            const merged = { ...existing.faction };
            for (const k of ["type", "leader", "scope", "nation", "headquarters", "purpose", "description"]) {
                if (!merged[k] && entry[k]) merged[k] = entry[k];
            }
            merged.allies   = Array.from(new Set([...(merged.allies   || []), ...(entry.allies   || [])]));
            merged.enemies  = Array.from(new Set([...(merged.enemies  || []), ...(entry.enemies  || [])]));
            if (!merged.creatureBase && entry.creatureBase) merged.creatureBase = entry.creatureBase;
            merged.bibleRef = entry.bibleRef;
            merged.source   = merged.source || "library";
            if (!dryRun) registry[existing.id] = merged;
            enriched++;
        } else {
            if (!dryRun) registry[entry.id] = entry;
            added++;
        }
    }

    // 4. Preserve standings for folded duplicates (keep the non-neutral one).
    if (!dryRun && api?.getFactionStanding && api?.setFactionStanding) {
        for (const { fromId, toId } of dupMerges) {
            const from = api.getFactionStanding(fromId);
            const to   = api.getFactionStanding(toId);
            if (from && from !== "neutral" && to === "neutral") {
                await api.setFactionStanding(toId, from);
            }
        }
    }

    if (!dryRun) await _serializedSave(registry);

    const summary = {
        dryRun,
        libraryFactions:  bibleFactions.length,
        distinctLibrary:  bibleByNorm.size,
        added, enriched,
        duplicatesFolded: dupMerges.length,
        totalNow:         dryRun
            ? (Object.keys(registry).length - dupMerges.length + added)   // projected
            : Object.keys(registry).length,
    };
    console.log(`${TAG} | Library import ${dryRun ? "(DRY RUN) " : ""}— +${added} new, ${enriched} enriched, ${dupMerges.length} dupes folded → ${summary.totalNow} factions total.`);
    return summary;
}

/**
 * Get a single faction by ID.
 * @param {string} factionId
 * @returns {FactionData|null}
 */
export function getFaction(factionId) {
    if (!factionId) return null;
    const data = _load();
    return data[factionId] || null;
}

/**
 * Get the faction assigned to an actor/token.
 * Checks token flags first (unlinked), then actor flags.
 * @param {TokenDocument|Actor} target
 * @returns {FactionData|null}
 */
export function getActorFaction(target) {
    const actor = target?.actor ?? target;
    if (!actor) return null;

    const factionId = actor.getFlag(MODULE_ID, "factionId");
    if (!factionId) return null;
    return getFaction(factionId);
}

/**
 * Find factions matching a creature base name or type in the current world context.
 * Also matches creature FAMILY — a bugbear will find goblin tribe factions because
 * goblins, hobgoblins, and bugbears are all goblinoids.
 * @param {string} creatureBase — e.g. "bandit", "goblin", "bugbear"
 * @param {string} [worldTag] — filter to this world/adventure
 * @returns {FactionData[]}
 */
export function findMatchingFactions(creatureBase, worldTag) {
    const data = _load();
    const base = (creatureBase || "").toLowerCase().trim();

    // ⚠️ NO BASE MEANS NO KIN, NOT EVERY KIN. 338 of Johnny's 453 factions are
    // organisations and correctly carry an empty creature base. Matching an
    // empty base against an empty base made all 338 "kin" to each other, so one
    // death could ripple through every organisation in the world. One caller
    // happened to guard against it; that guard was all that stood in the way.
    if (!base) return [];

    // Build set of acceptable creature bases: this creature + all family members
    const familyBases = new Set(getFamilyMembers(base).map(b => b.toLowerCase()));

    const results = [];
    for (const [id, faction] of Object.entries(data)) {
        const factionBase = (faction.creatureBase || "").toLowerCase();
        // Match by exact creature base OR creature family
        if (!familyBases.has(factionBase)) continue;
        // Filter by world tag — skip factions from OTHER worlds.
        // Factions with no worldTag are orphans from before tagging — skip those too
        // unless we also have no worldTag (shouldn't happen in normal play).
        if (worldTag) {
            if (!faction.worldTag || faction.worldTag !== worldTag) continue;
        }
        results.push({ ...faction, id });
    }
    return results;
}

/**
 * Find factions by political tier for the current scene context.
 * @param {string} tier — e.g. "town", "county", "kingdom"
 * @param {string} [worldTag]
 * @returns {FactionData[]}
 */
export function findByTier(tier, worldTag) {
    const data = _load();
    const results = [];
    for (const [id, faction] of Object.entries(data)) {
        if (faction.tier !== tier) continue;
        if (worldTag) {
            if (!faction.worldTag || faction.worldTag !== worldTag) continue;
        }
        results.push({ ...faction, id });
    }
    return results;
}

/**
 * Create or update a faction in the registry.
 * @param {FactionData} factionData — must include an `id` field
 * @returns {Promise<FactionData>}
 */
export async function saveFaction(factionData) {
    // ⚠️ MATCH BEFORE YOU CREATE. Johnny's registry holds "Cult of the
    // Dragon" three times, "Red Wizards of Thay" twice, and six duplicated names
    // across thirteen entries, because a new id was minted whenever the caller
    // did not supply one. Nothing ever asked whether that faction already
    // existed under the same name.
    //
    // Only on CREATE. An explicit id means the caller is editing a known
    // faction and renaming it is their business, including renaming it to
    // something that collides.
    if (!factionData?.id && factionData?.name) {
        // ⚠️ Dynamic, for the same cycle reason as above.
        let twin = null;
        try {
            const lk = await import("./faction-lookup.mjs");
            const hit = lk.findFactionByName(factionData.name);
            if (hit) twin = { ...hit.faction, id: hit.id };
        } catch (_) { /* dedupe is a courtesy, never a blocker */ }
        if (twin) {
            console.log(`${TAG} | "${factionData.name}" already exists (${twin.id}) — updating it instead of creating a second.`);
            factionData.id = twin.id;
            // Keep anything the existing one knows that the new one does not.
            for (const k of ["description", "purpose", "leader", "headquarters", "creatureBase", "tier", "bibleRef"]) {
                if (!factionData[k] && twin[k]) factionData[k] = twin[k];
            }
            factionData.allies  = Array.from(new Set([...(twin.allies  || []), ...(factionData.allies  || [])]));
            factionData.enemies = Array.from(new Set([...(twin.enemies || []), ...(factionData.enemies || [])]));
        }
    }
    if (!factionData?.id) {
        factionData.id = foundry.utils.randomID();
    }
    const data = _load();
    data[factionData.id] = {
        ...factionData,
        lastActive: Date.now(),
    };
    await _serializedSave(data);
    console.log(`${TAG} | Saved faction: ${factionData.name} (${factionData.id})`);
    return data[factionData.id];
}

/**
 * Delete a faction from the registry.
 * @param {string} factionId
 */
/**
 * Remove a faction, and let go of everyone who belonged to it.
 *
 * ⚠️🔴 THIS USED TO LEAVE ORPHANS, AND THAT IS HOW EIGHT CREATURES ENDED UP
 * POINTING AT NOTHING (2026-08-22). Deleting the registry entry never touched
 * the `factionId` flag on its members, so Death Knight, Lord Soth, Casimir
 * Thornwick and five others were left carrying an id that resolved to nothing.
 *
 * The damage was silent and specific: the faction sweep only asked whether a
 * flag was PRESENT, so it treated them as settled and skipped them forever,
 * while deed propagation found no faction and exited without a word. Three
 * 32-point kills evaporated on that alone.
 *
 * A creature whose faction is deleted is unaffiliated, not broken. Say so, and
 * write it down, so the sweep can find them a new home.
 */
export async function deleteFaction(factionId) {
    const data = _load();
    const name = data[factionId]?.name || factionId;

    const freed = [];
    for (const actor of (game.actors ?? [])) {
        try {
            if (actor.getFlag(MODULE_ID, "factionId") !== factionId) continue;
            await actor.unsetFlag(MODULE_ID, "factionId");
            await actor.unsetFlag(MODULE_ID, "factionRole").catch(() => {});
            freed.push(actor.name);
        } catch (err) {
            console.warn(`${TAG} | could not release ${actor?.name} from ${name}:`, err);
        }
    }

    // ⚠️ AND THE UNLINKED ONES. A wandering monster keeps its flags in the
    // token delta, not on a world actor, so a sweep of game.actors alone leaves
    // every creature on every scene pointing at a faction that no longer
    // exists. That is exactly the dangling-flag state that made eight creatures
    // invisible to the reputation sweep.
    for (const scene of (game.scenes ?? [])) {
        for (const token of (scene.tokens ?? [])) {
            if (token.actorLink) continue;              // handled above
            try {
                if (token.actor?.getFlag?.(MODULE_ID, "factionId") !== factionId) continue;
                await token.actor.unsetFlag(MODULE_ID, "factionId");
                await token.actor.unsetFlag(MODULE_ID, "factionRole").catch(() => {});
                freed.push(`${token.name} (${scene.name})`);
            } catch (err) {
                console.warn(`${TAG} | could not release ${token?.name} from ${name}:`, err);
            }
        }
    }

    delete data[factionId];
    await _serializedSave(data);
    console.log(`${TAG} | Deleted faction: ${name}`
        + (freed.length ? ` — released ${freed.length}: ${freed.join(", ")}` : ""));
    return { name, freed };
}

/**
 * Register a faction that is being adopted from a NAMED source — scene
 * intelligence, the world digest, or anything else that hands us a name that is
 * meant to be canonical.
 *
 * ⚠️ WHY THIS EXISTS, AND IT COST A LIVE BUG. There were FIVE places that
 * created a faction and only ONE of them checked whether that name already
 * existed. The four that did not all minted a fresh random id, so accepting a
 * canonical name the world already knew produced a SECOND faction sitting
 * beside the real one, invisible in a list of hundreds.
 *
 * ⚠️ AND THE SECOND FAULT IS WORSE. Those four sites stamped the DROPPED
 * CREATURE'S species onto the new faction. Drop a goblin at a mine, accept the
 * canonical name "Mind Flayers", and you get a faction called Mind Flayers made
 * of GOBLINS. It then matched every goblin in the world perfectly, because the
 * matcher was doing exactly what it was told. Proven live 2026-08-22: a goblin
 * was auto-assigned to it and renamed after it.
 *
 * A named faction's composition comes from ITS OWN NAME, the way every other
 * identity in ACE does. The dropped creature is only the fallback for a name
 * that says nothing about species.
 *
 * @param {object} candidate — the faction to register; `id` is ignored
 * @param {object} [opts]
 * @param {string} [opts.sceneName] — recorded as presence when adopting
 * @param {string} [opts.droppedBase] — the dropped creature's base, used only as a fallback
 * @returns {Promise<{faction:object, id:string, adopted:boolean}>}
 */
export async function registerNamedFaction(candidate, opts = {}) {
    const { sceneName = "", droppedBase = "" } = opts;
    const wanted = String(candidate?.name || "").trim();

    // ── Already there? Join it. ──────────────────────────────────────────
    if (wanted) {
        const target = _normaliseFactionName(wanted);
        for (const [id, existing] of Object.entries(_load())) {
            if (_normaliseFactionName(existing?.name) !== target) continue;
            if (sceneName) {
                try {
                    const { rememberPresence } = await import("./faction-lookup.mjs");
                    await rememberPresence(id, sceneName);
                } catch (_) { /* presence is a nicety, not the point */ }
            }
            console.log(`${TAG} | "${wanted}" already exists — joined it instead of creating a duplicate.`);
            return { faction: { ...existing, id }, id, adopted: true };
        }
    }

    // ── The name decides what it is made of. ─────────────────────────────
    const fromName = inferCreatureBase({ name: wanted });
    const faction = {
        ...candidate,
        id: foundry.utils.randomID(),
        creatureBase: fromName || droppedBase || candidate?.creatureBase || "commoner",
        members: Array.isArray(candidate?.members) ? candidate.members : [],
        presence: sceneName ? [sceneName] : (candidate?.presence ?? []),
        created: candidate?.created ?? Date.now(),
        lastActive: Date.now(),
    };
    await saveFaction(faction);
    console.log(`${TAG} | Registered "${faction.name}" (${faction.id})`
        + ` — composed of ${faction.creatureBase}`
        + (fromName ? " (read from its name)" : " (from the creature that was dropped)"));
    return { faction, id: faction.id, adopted: false };
}

/**
 * One spelling of a faction name, so two callers can agree it is the same one.
 * Trailing punctuation, a leading "the" and casing are all noise.
 */
function _normaliseFactionName(name) {
    return String(name || "")
        .toLowerCase()
        .replace(/^the\s+/, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * Move a creature from one faction's roster to another's.
 *
 * ⚠️ WHY THIS EXISTS. Setting the `factionId` flag is only HALF of joining a
 * faction. The other half is the roster — the faction's own `members` list.
 * `assignToFaction` has always written both, but the Customize NPC dialog wrote
 * only the flag, so changing the drop-down moved the creature's allegiance in
 * one place and left it standing in the old faction's ranks forever.
 *
 * Live consequence, found 2026-08-22: a goblin auto-assigned on drop was
 * changed by hand to a different tribe and kept showing as a Mind Flayer,
 * because the Mind Flayers still listed him and the new tribe never did. Two
 * records of the same fact, only one of them updated, is not a display bug.
 *
 * Both ids are optional, so this covers joining (no old), leaving (no new) and
 * moving. It writes ONCE, whatever the combination.
 *
 * @param {string} memberId — actor id for a linked creature, token id for an unlinked one
 * @param {string|null} fromFactionId
 * @param {string|null} toFactionId
 * @returns {Promise<{left: string|null, joined: string|null}>} names, for logging
 */
export async function moveFactionMember(memberId, fromFactionId, toFactionId) {
    if (!memberId || fromFactionId === toFactionId) return { left: null, joined: null };

    const data = _load();
    let left = null;
    let joined = null;
    let dirty = false;

    const from = fromFactionId ? data[fromFactionId] : null;
    if (from && Array.isArray(from.members)) {
        const before = from.members.length;
        from.members = from.members.filter((m) => m !== memberId);
        if (from.members.length !== before) { left = from.name; dirty = true; }
    }

    const to = toFactionId ? data[toFactionId] : null;
    if (to) {
        if (!Array.isArray(to.members)) to.members = [];
        if (!to.members.includes(memberId)) { to.members.push(memberId); joined = to.name; dirty = true; }
    }

    if (dirty) await _serializedSave(data);
    return { left, joined };
}

/**
 * Repoint a roster entry from one id to another, in whatever faction holds it.
 *
 * ⚠️ An UNLINKED creature is listed by TOKEN id. Promoting it to a persistent
 * actor gives it a brand new actor id and relinks the token, so the roster
 * entry left behind points at nothing — the faction quietly loses a member the
 * moment that member becomes important enough to keep.
 *
 * @param {string} oldId
 * @param {string} newId
 * @returns {Promise<string|null>} the faction name that was repaired, if any
 */
export async function repointFactionMember(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return null;

    const data = _load();
    for (const faction of Object.values(data)) {
        if (!Array.isArray(faction?.members)) continue;
        const at = faction.members.indexOf(oldId);
        if (at === -1) continue;
        if (faction.members.includes(newId)) faction.members.splice(at, 1);
        else                                 faction.members[at] = newId;
        await _serializedSave(data);
        return faction.name ?? null;
    }
    return null;
}

/**
 * Assign a token/actor to a faction.
 * Stores the faction ID as an actor flag (or token flag for unlinked).
 * @param {TokenDocument} tokenDoc
 * @param {string} factionId
 * @param {string} [role] — optional role within the faction (e.g. "bartender", "patron")
 */
export async function assignToFaction(tokenDoc, factionId, role) {
    const actor = tokenDoc.actor;
    if (!actor) return;

    const target = tokenDoc.actorLink ? actor : tokenDoc.actor;
    await target.setFlag(MODULE_ID, "factionId", factionId);
    if (role) await target.setFlag(MODULE_ID, "factionRole", role);

    // Add to faction member list
    const data = _load();
    const faction = data[factionId];
    if (faction) {
        if (!faction.members) faction.members = [];
        const memberId = tokenDoc.actorLink ? actor.id : tokenDoc.id;
        if (!faction.members.includes(memberId)) {
            faction.members.push(memberId);
            await _serializedSave(data);
        }
    }

    console.log(`${TAG} | Assigned ${actor.name} to faction "${faction?.name || factionId}"${role ? ` as ${role}` : ""}`);

    // ── Living World Step 2: pre-set the token's disposition from the faction's
    // current standing toward the party (angered → hostile, revered → friendly).
    // Lazy import avoids a static cycle (faction-propagation imports this file).
    try {
        const { applyFactionDispositionToToken } = await import("../faction-propagation.mjs");
        await applyFactionDispositionToToken(tokenDoc, factionId);
    } catch (dispErr) {
        console.warn(`${TAG} | Faction disposition-on-drop failed (non-fatal):`, dispErr);
    }

    // ── v0.7.21 Step 4: Cross-reference into the Factions journal folder ──
    // Append-only entry showing this actor was added to this faction.
    // Idempotent — if already recorded, no-op. GM is the only editor.
    if (faction) {
        try {
            const { recordFactionMember } = await import("./cross-reference-journal.mjs");
            await recordFactionMember(actor, faction, role);
        } catch (xrefErr) {
            console.warn(`${TAG} | Cross-reference write to Factions journal failed (non-fatal):`, xrefErr);
        }
    }
}

// ─── CREATURE BASE RESOLUTION ────────────────────────────────────────────────
// Resolves what "kind" of creature this is for faction template matching.

/**
 * Get the creature base key for faction template matching.
 * Strips parentheticals, trailing numbers, and matches against templates.
 * @param {Actor} actor
 * @returns {string} — lowercase key like "bandit", "goblin", "commoner"
 */
export function resolveCreatureBase(actor) {
    if (!actor) return "commoner";

    const name = (actor.name || "").toLowerCase()
        .replace(/\s*\([^)]*\)\s*/g, "")   // strip parentheticals
        .replace(/\s*#?\s*\d+\s*$/g, "")   // strip trailing numbers
        .replace(/\s+[a-z]$/g, "")          // strip trailing single letter
        .trim();

    // Check direct name match against templates
    for (const key of Object.keys(FACTION_TEMPLATES)) {
        if (name === key || name.startsWith(key + " ") || name.endsWith(" " + key)) {
            return key;
        }
    }

    // Check creature type from D&D 5e data
    const creatureType = (actor.system?.details?.type?.value || "").toLowerCase();
    if (FACTION_TEMPLATES[creatureType]) return creatureType;

    // Check creature subtype
    const subtype = (actor.system?.details?.type?.subtype || "").toLowerCase();

    // Humanoid subtypes → check if any template matches
    if (creatureType === "humanoid") {
        // Check the original name words against templates
        const words = name.split(/\s+/);
        for (const word of words) {
            if (FACTION_TEMPLATES[word]) return word;
        }
        // Default humanoid to commoner
        return "commoner";
    }

    // Non-humanoid creature types — return the D&D creature type directly
    // so the faction scoring affinity matrix can use it
    const KNOWN_TYPES = new Set([
      "undead", "construct", "beast", "fiend", "fey", "giant",
      "dragon", "aberration", "celestial", "elemental", "monstrosity",
      "ooze", "plant",
    ]);
    if (KNOWN_TYPES.has(creatureType)) return creatureType;

    return "commoner"; // absolute fallback
}

/**
 * Get the faction template for a creature base.
 * @param {string} creatureBase
 * @returns {object} — template from FACTION_TEMPLATES
 */
export function getTemplate(creatureBase) {
    return FACTION_TEMPLATES[creatureBase] || FACTION_TEMPLATES.commoner;
}

// ─── SPY / DESERTER ROLL ─────────────────────────────────────────────────────

/**
 * Roll to see if this token is secretly from a different faction.
 * Returns null if no spy, or the "real" faction ID if spy.
 * @param {TokenDocument} tokenDoc
 * @param {string} assignedFactionId — the faction they'd normally belong to
 * @returns {{ isSpy: boolean, realFactionId?: string, realFactionName?: string }}
 */
export function rollSpyChance(tokenDoc, assignedFactionId) {
    const actor = tokenDoc.actor;
    const creatureBase = resolveCreatureBase(actor);
    const template = getTemplate(creatureBase);

    // No spy chance for constructs, undead, beasts
    if (!template.canSpy) {
        return { isSpy: false };
    }

    let spyChance;
    try {
        spyChance = game.settings.get(MODULE_ID, "factionSpyChance") ?? 200;
    } catch (_) {
        spyChance = 200;
    }

    // 0 = disabled
    if (spyChance <= 0) return { isSpy: false };

    // Roll 1-in-N
    const roll = Math.floor(Math.random() * spyChance) + 1;
    if (roll !== 1) {
        return { isSpy: false };
    }

    // Spy! Find a DIFFERENT faction to be the "real" allegiance.
    const data = _load();
    const worldTag = game.world?.title || "";
    const candidates = Object.entries(data).filter(([id, f]) => {
        if (id === assignedFactionId) return false;  // Not the same faction
        if (f.worldTag && f.worldTag !== worldTag) return false;  // Same world
        // Only spy into power factions, not governance (no spy-bartenders)
        const powerTypes = new Set(["gang", "tribe", "cult", "warband", "legion", "house"]);
        return powerTypes.has(f.type);
    });

    if (candidates.length === 0) {
        return { isSpy: false }; // No other factions to spy from
    }

    const [realId, realFaction] = candidates[Math.floor(Math.random() * candidates.length)];
    console.log(`${TAG} | 🕵️ SPY ROLL HIT! ${actor.name} is secretly from "${realFaction.name}"`);
    return {
        isSpy: true,
        realFactionId: realId,
        realFactionName: realFaction.name,
    };
}

// ─── AI FACTION GENERATION ───────────────────────────────────────────────────

/**
 * Use AI to generate a faction identity (name, purpose, lore, leader).
 * @param {string} creatureBase — e.g. "bandit", "goblin"
 * @param {string} sceneName
 * @param {string} worldName
 * @param {object} template — from FACTION_TEMPLATES
 * @param {object} [parentFaction] — the governance faction this exists within
 * @returns {Promise<{ name: string, purpose: string, lore: string, leader: string }>}
 */
export async function generateFactionIdentity(creatureBase, sceneName, worldName, template, parentFaction, neighbourContext = "") {
    const { provider, apiKey } = getEnvoyAIConfig();

    const parentContext = parentFaction
        ? `This faction operates within: ${parentFaction.name} (${parentFaction.tier}). ${parentFaction.lore || ""}`
        : "";

    const systemPrompt = `You are a D&D 5e world-builder generating a faction for a living campaign world.
Generate a CONCISE faction identity. Be specific and flavorful, not generic.

RULES:
- The faction NAME should be evocative and memorable (2-4 words). Examples: "The Black Swords", "Thornscale Tribe", "The Ember Cult", "Dockside Merchants' Guild"
- The PURPOSE explains why this faction exists in THIS location specifically
- The LORE is 2-3 sentences of shared backstory ALL members know
- The LEADER is a single named individual (with a title)
- Keep everything SHORT — this gets injected into NPC prompts

Respond in EXACTLY this format (no extra text):
NAME: [faction name]
LEADER: [leader name and title]
PURPOSE: [1 sentence — why they are HERE]
LORE: [2-3 sentences of shared history]

If — and ONLY if — one of the already-existing factions listed below is genuinely
the right home for this creature, do not invent anything. Reply with a single line:
EXISTING: [the exact existing faction name]`;

    // ── Scene Intelligence + World Bible + Direct Lookup: inject canonical knowledge ──
    let locationContext = "";
    try {
        // Direct digest lookup for faction/location data — instant, structured (via bridge)
        const digestCtx = EngineBridge.digestLookupContext(sceneName, { maxChars: 1500 });
        if (digestCtx.length > 20) {
            locationContext = `\n\nDIGEST LOOKUP (canonical source data — DO NOT contradict):\n${digestCtx}`;
        }
        // Scene Intelligence (comprehensive, cached) — supplements direct lookup
        const intelPrompt = await EngineBridge.getSceneIntelligencePrompt(sceneName, null, creatureBase);
        if (intelPrompt) locationContext += `\n\nSCENE INTELLIGENCE (use this canonical lore — DO NOT contradict it):\n${intelPrompt}`;
        // Fallback to basic World Bible search (only if nothing else found)
        if (!locationContext) {
            let ctx = EngineBridge.searchWorldBible(`${creatureBase} ${sceneName}`, 3);
            if (!ctx) ctx = await EngineBridge.resolveWorldBibleLocation(sceneName, creatureBase);
            if (ctx) locationContext = `\n\nWORLD BIBLE CONTEXT (use this canonical lore — DO NOT contradict it):\n${ctx}`;
        }
    } catch (err) { console.warn("ACE: Engine | faction-registry world bible context for faction generation failed:", err); }

    const userMsg = `Generate a ${template.type} faction for ${creatureBase}s.
- Scene: ${sceneName}
- World/Campaign: ${worldName || "Unknown"}
- Faction type: ${template.type}
- Structure: ${template.structure}
- Stability: ${template.stability}
${parentContext ? `- Operates within: ${parentContext}` : ""}
${locationContext}
The faction name should feel appropriate for ${creatureBase}s — not generic.${locationContext ? " Use canonical faction names from the scene intelligence or World Bible if appropriate for this creature type and location." : ""}${neighbourContext || ""}`;

    try {
        const Handler = await _getAIHandler();
        const response = await Handler.callAI(systemPrompt, [], userMsg, provider, apiKey, [], { context: "faction-naming" });
        if (isAIFailure(response)) throw new Error("AI unavailable — using fallback name");

        // The model may decline to invent and point at something real instead.
        // That is the preferred outcome, not a parse failure.
        const existing = /^\s*EXISTING:\s*(.+?)\s*$/mi.exec(response);
        if (existing) return { useExistingName: existing[1].trim() };

        return _parseFactionIdentity(response);
    } catch (err) {
        console.error(`${TAG} | AI faction generation failed:`, err);
        // Fallback: generate a basic name
        return {
            name: `The ${_capitalize(creatureBase)} ${template.type === "tribe" ? "Tribe" : template.type === "gang" ? "Gang" : "Band"}`,
            leader: "Unknown leader",
            purpose: `A ${template.type} of ${creatureBase}s operating near ${sceneName}.`,
            lore: `Little is known about this group beyond their presence in the area.`,
        };
    }
}

/**
 * Use AI to generate a political geography faction (town, county, kingdom, etc.).
 * @param {string} tier — e.g. "town", "county", "kingdom"
 * @param {string} sceneName
 * @param {string} worldName
 * @param {object} [parentFaction] — the parent governance tier
 * @returns {Promise<{ name: string, purpose: string, lore: string, leader: string }>}
 */
export async function generateGovernanceFaction(tier, sceneName, worldName, parentFaction) {
    const { provider, apiKey } = getEnvoyAIConfig();

    const parentContext = parentFaction
        ? `This ${tier} is part of: ${parentFaction.name} (${parentFaction.tier}). ${parentFaction.lore || ""}`
        : "";

    const systemPrompt = `You are a D&D 5e world-builder generating political geography for a living campaign world.
Generate a CONCISE governance entity. Be specific and flavorful.

RULES:
- The NAME should fit the tier: kingdoms have regal names, towns have local names
- The LEADER has an appropriate title for the tier (King, Duke, Count, Baron, Mayor, etc.)
- The PURPOSE explains what role this governance entity plays
- The LORE is 2-3 sentences of local history ALL residents know
- Keep everything SHORT

Respond in EXACTLY this format (no extra text):
NAME: [governance name]
LEADER: [leader name and title]
PURPOSE: [1 sentence]
LORE: [2-3 sentences]`;

    // ── Scene Intelligence + World Bible + Direct Lookup: inject canonical governance knowledge ──
    let locationContext = "";
    try {
        // Direct digest lookup for governance/location data — instant, structured (via bridge)
        const digestCtx = EngineBridge.digestLookupContext(sceneName, { maxChars: 1500 });
        if (digestCtx.length > 20) {
            locationContext = `\n\nDIGEST LOOKUP (canonical source data — DO NOT contradict, use the REAL names and leaders):\n${digestCtx}`;
        }
        // Scene Intelligence (comprehensive, cached) — supplements direct lookup
        const intelPrompt = await EngineBridge.getSceneIntelligencePrompt(sceneName, null, tier);
        if (intelPrompt) locationContext += `\n\nSCENE INTELLIGENCE (use this canonical lore — DO NOT contradict it, use the REAL names and leaders):\n${intelPrompt}`;
        // Fallback to basic World Bible search (only if nothing else found)
        if (!locationContext) {
            let ctx = EngineBridge.searchWorldBible(`${tier} governance ${sceneName}`, 3);
            if (!ctx) ctx = await EngineBridge.resolveWorldBibleLocation(sceneName);
            if (ctx) locationContext = `\n\nWORLD BIBLE CONTEXT (use this canonical lore — DO NOT contradict it, use the REAL names and leaders):\n${ctx}`;
        }
    } catch (err) { console.warn("ACE: Engine | faction-registry world bible context for governance generation failed:", err); }

    const userMsg = `Generate a ${tier}-level governance entity.
- Scene: ${sceneName}
- World/Campaign: ${worldName || "Unknown"}
- Tier: ${tier}
${parentContext ? `- Part of: ${parentContext}` : ""}
${locationContext}
${locationContext ? "Use the CANONICAL names, rulers, and details from the scene intelligence or World Bible above. Do NOT invent new names if the real ones are provided." : ""}`;

    try {
        const Handler = await _getAIHandler();
        const response = await Handler.callAI(systemPrompt, [], userMsg, provider, apiKey, [], { context: "faction-naming" });
        if (isAIFailure(response)) throw new Error("AI unavailable — using fallback governance");
        return _parseFactionIdentity(response);
    } catch (err) {
        console.error(`${TAG} | AI governance generation failed:`, err);
        return {
            name: sceneName,
            leader: "Unknown authority",
            purpose: `The local governance of ${sceneName}.`,
            lore: `A settlement in the region of ${worldName || "the known world"}.`,
        };
    }
}

function _parseFactionIdentity(response) {
    if (!response) return null;

    const nameMatch    = response.match(/^NAME:\s*(.+?)$/mi);
    const leaderMatch  = response.match(/^LEADER:\s*(.+?)$/mi);
    const purposeMatch = response.match(/^PURPOSE:\s*(.+?)$/mi);
    const loreMatch    = response.match(/^LORE:\s*(.+?)$/msi);

    return {
        name:    nameMatch?.[1]?.trim()    || "Unknown Faction",
        leader:  leaderMatch?.[1]?.trim()  || "Unknown leader",
        purpose: purposeMatch?.[1]?.trim() || "",
        lore:    loreMatch?.[1]?.trim()    || "",
    };
}

function _capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── CIVILIAN BASE CHECK ────────────────────────────────────────────────────────
// These creature bases get "No Faction" pre-selected in the dialog.
// They still SEE the dialog for role/origin/auto-link — just default to no faction.
const _CIVILIAN_BASES = new Set(["commoner", "merchant", "bartender", "barmaid", "innkeeper", "priest"]);
function _isCivilianBase(base) { return _CIVILIAN_BASES.has((base || "").toLowerCase()); }

// ─── ROLE CHIP DATA (dynamic per creature base) ────────────────────────────────

// ── Official D&D 5e variant names as role chips ──────────────────────────────
// Sources: Monster Manual (MM), Volo's Guide (VGM), Mordenkainen's (MTF/MPMM),
// 2024 Monster Manual (XMM). Prefix stripped (e.g., "Goblin Boss" → "Boss").
// The custom text field covers any role not listed here.
const ROLE_CHIPS = {
  // Goblinoids (MM + VGM + XMM 2024)
  goblin:     ["Boss", "Warrior", "Hexer", "Scout", "Archer", "Runt", "Trapmaker"],
  hobgoblin:  ["Captain", "Warlord", "Warrior", "Devastator", "Iron Shadow", "Soldier"],
  bugbear:    ["Chief", "Stalker", "Warrior", "Bruiser", "Scout"],

  // Orcs (MM + VGM)
  orc:        ["War Chief", "Eye of Gruumsh", "Blade of Ilneval", "Berserker", "Champion", "Red Fang"],

  // Gnolls (MM + VGM + XMM)
  gnoll:      ["Pack Lord", "Fang of Yeenoghu", "Flesh Gnawer", "Hunter", "Warrior", "Demoniac"],

  // Kobolds (MM + VGM)
  kobold:     ["Dragonshield", "Scale Sorcerer", "Inventor", "Warrior", "Scout", "Trapmaker"],

  // Drow (MM + MTF/MPMM)
  drow:       ["Elite Warrior", "Mage", "Priestess", "Shadowblade", "Inquisitor", "House Captain", "Arachnomancer"],

  // Duergar (MM + MTF/MPMM)
  duergar:    ["Warlord", "Mind Master", "Soulblade", "Stone Guard", "Hammerer", "Despot"],

  // Lizardfolk (MM + XMM)
  lizardfolk: ["Shaman", "King/Queen", "Warrior", "Hunter", "Geomancer", "Render"],

  // Yuan-ti (MM + VGM)
  "yuan-ti":  ["Malison", "Abomination", "Mind Whisperer", "Nightmare Speaker", "Pit Master", "Infiltrator"],

  // Kuo-toa (MM)
  "kuo-toa":  ["Whip", "Monitor", "Archpriest", "Warrior"],

  // Githyanki (MM + MTF)
  githyanki:  ["Warrior", "Knight", "Gish", "Kith'rak", "Supreme Commander", "Dracomancer"],

  // Githzerai (MM + MTF)
  githzerai:  ["Monk", "Zerth", "Anarch", "Enlightened", "Psion"],

  // Sahuagin (MM + XMM)
  sahuagin:   ["Priestess", "Baron", "Warrior", "Scout"],

  // Myconid (MM)
  myconid:    ["Sprout", "Adult", "Sovereign"],

  // Grung (VGM)
  grung:      ["Elite Warrior", "Wildling", "Scout"],

  // Mind Flayer (MM + VGM)
  "mind flayer": ["Arcanist", "Psion", "Ulitharid", "Thrall"],

  // Ogre (MM + MTF)
  ogre:       ["Battering Ram", "Bolt Launcher", "Chain Brute", "Howdah", "Warrior"],

  // Troll (MM + MTF)
  troll:      ["Dire", "Rot", "Spirit", "Venom", "Warrior"],

  // Vampire (MM + XMM)
  vampire:    ["Spawn", "Spellcaster", "Warrior", "Nightbringer", "Umbral Lord"],

  // Shadar-kai (MTF/MPMM)
  "shadar-kai": ["Gloom Weaver", "Shadow Dancer", "Soul Monger"],

  // Eladrin (MTF/MPMM)
  eladrin:    ["Autumn", "Spring", "Summer", "Winter"],

  // Centaur (MM + XMM)
  centaur:    ["Trooper", "Warden", "Scout"],

  // Merfolk (MM + XMM)
  merfolk:    ["Skirmisher", "Wavebender", "Scout"],

  // Azer (MM + XMM)
  azer:       ["Pyromancer", "Sentinel", "Warrior"],

  // Bullywug (MM + XMM)
  bullywug:   ["Bog Sage", "Warrior", "Scout"],

  // Civilized — military (MM + XMM 2024)
  guard:      ["Captain", "Sergeant", "Patrol", "Gate Guard", "Investigator", "Rookie", "Veteran"],
  soldier:    ["Commander", "Veteran", "Infantry", "Captain", "Sergeant", "Archer", "Recruit"],
  knight:     ["Knight Errant", "Commander", "Champion", "Squire", "Oath-Bound", "Fallen"],

  // Civilized — civilian
  commoner:   ["Villager", "Farmer", "Laborer", "Elder", "Refugee", "Traveler", "Beggar"],
  merchant:   ["Shopkeeper", "Traveling Merchant", "Fence", "Craftsman", "Peddler", "Appraiser"],
  bartender:  ["Owner", "Server", "Cook", "Bouncer", "Entertainer"],
  barmaid:    ["Server", "Cook", "Singer", "Regular"],
  innkeeper:  ["Owner", "Night Manager", "Stablehand", "Cook", "Housekeeper"],
  priest:     ["Archpriest", "Acolyte", "Healer", "Missionary", "Temple Guard"],
  noble:      ["Lord/Lady", "Heir", "Prodigy", "Advisor", "Diplomat", "Reformer"],

  // Criminal (MM + XMM 2024)
  bandit:     ["Captain", "Crime Lord", "Deceiver", "Thug", "Lookout", "Enforcer", "Fence"],
  thug:       ["Enforcer", "Boss", "Muscle", "Collector", "Hired Blade"],
  pirate:     ["Captain", "Admiral", "First Mate", "Bosun", "Navigator"],
  assassin:   ["Contract Killer", "Poisoner", "Shadow", "Handler", "Informant"],
  spy:        ["Master", "Informant", "Double Agent", "Handler"],

  // Cult (MM + XMM 2024)
  cultist:    ["Fanatic", "Hierophant", "Initiate", "Spy", "Sacrifice-Keeper"],
  acolyte:    ["Devotee", "Healer", "Temple Servant", "Scribe", "Watcher"],

  // NPC casters (MM + XMM 2024)
  mage:       ["Archmage", "Apprentice", "Evoker", "Illusionist", "Necromancer"],
  scout:      ["Captain", "Tracker", "Ranger", "Outrider"],
  berserker:  ["Commander", "Champion", "Ravager"],

  // Undead (MM + XMM)
  skeleton:   ["Guardian", "Warrior", "Archer", "Servant", "Ancient"],
  zombie:     ["Shambler", "Bloated", "Armored", "Ancient"],
  undead:     ["Lord", "Knight", "Mage", "Guardian", "Revenant", "Thrall", "Ancient"],

  // Beast
  beast:      ["Alpha", "Hunter", "Scout", "Runt", "Lone", "Pack Member"],
  wolf:       ["Alpha", "Pack Hunter", "Lone Wolf", "Omega", "Den Mother"],

  // Fiend
  fiend:      ["General", "Lieutenant", "Soldier", "Diplomat", "Exile", "Scout", "Spy"],

  // Celestial
  celestial:  ["Guardian", "Messenger", "Warrior", "Judge", "Watcher", "Herald"],

  // Universal fallback — works for any creature type not listed above
  _default:   ["Member", "Leader", "Lieutenant", "Scout", "Specialist", "Recruit", "Outcast", "Elder"],
};

// Default role per creature base + CR bracket (using official D&D variant names)
function _getDefaultRole(creatureBase, cr) {
  const base = (creatureBase || "").toLowerCase();
  if (cr >= 17) {
    const leaderRoles = { goblin: "Boss", orc: "War Chief", guard: "Captain", knight: "Commander",
      bandit: "Crime Lord", cultist: "Hierophant", fiend: "General", celestial: "Guardian",
      undead: "Lord", hobgoblin: "Warlord", noble: "Lord/Lady", drow: "Priestess",
      duergar: "Despot", vampire: "Nightbringer", gnoll: "Pack Lord" };
    return leaderRoles[base] ?? "Leader";
  }
  if (cr >= 5) {
    const midRoles = { goblin: "Boss", orc: "Champion", guard: "Sergeant", knight: "Knight Errant",
      bandit: "Captain", cultist: "Fanatic", fiend: "Lieutenant", celestial: "Warrior",
      hobgoblin: "Captain", drow: "Elite Warrior", kobold: "Scale Sorcerer",
      gnoll: "Fang of Yeenoghu", bugbear: "Chief", vampire: "Spellcaster" };
    return midRoles[base] ?? (ROLE_CHIPS[base]?.[0]) ?? "Member";
  }
  // Low CR: basic rank-and-file roles
  const lowRoles = { goblin: "Warrior", kobold: "Warrior", orc: "Berserker", guard: "Patrol",
    soldier: "Infantry", bandit: "Thug", commoner: "Villager", merchant: "Shopkeeper",
    bartender: "Server", priest: "Acolyte", cultist: "Initiate", beast: "Pack Member",
    wolf: "Pack Hunter", skeleton: "Guardian", zombie: "Shambler", hobgoblin: "Soldier",
    bugbear: "Warrior", gnoll: "Hunter", drow: "Elite Warrior", pirate: "First Mate" };
  return lowRoles[base] ?? (ROLE_CHIPS[base]?.[0]) ?? "Member";
}

// Origin options — shown in dialog
const ORIGIN_OPTIONS = [
  { value: "this_scene",  label: "From this area",       desc: "Local — this is their home territory" },
  { value: "nearby",      label: "From nearby",          desc: "From a neighboring settlement or area" },
  { value: "elsewhere",   label: "From elsewhere",       desc: "From a distant part of the campaign world" },
  { value: "foreign",     label: "From a foreign realm",  desc: "Outsider — from another plane, continent, or distant land" },
];

// ─── ALIGNMENT UTILITIES ────────────────────────────────────────────────────

/** Abbreviate a full alignment string to its short form (e.g. "Lawful Good" → "LG") */
function _abbreviateAlignment(alignment) {
    if (!alignment) return "";
    const al = alignment.trim();
    const ABBREV_MAP = {
        "lawful good": "LG", "neutral good": "NG", "chaotic good": "CG",
        "lawful neutral": "LN", "true neutral": "TN", "chaotic neutral": "CN",
        "lawful evil": "LE", "neutral evil": "NE", "chaotic evil": "CE",
        "unaligned": "U",
    };
    // Check direct match first
    const key = al.toLowerCase();
    if (ABBREV_MAP[key]) return ABBREV_MAP[key];
    // Already abbreviated?
    if (/^(LG|NG|CG|LN|TN|CN|LE|NE|CE|U)$/i.test(al)) return al.toUpperCase();
    // Try partial match (e.g. "neutral" alone)
    if (/^neutral$/i.test(al)) return "TN";
    return al; // return as-is if unrecognized
}

/** Get a badge color for alignment */
function _alignmentColor(abbrev) {
    if (!abbrev) return { bg: "#999", text: "#fff" };
    switch (abbrev.toUpperCase()) {
        case "LG": return { bg: "#2e7d32", text: "#fff" }; // deep green
        case "NG": return { bg: "#43a047", text: "#fff" }; // green
        case "CG": return { bg: "#66bb6a", text: "#111" }; // light green
        case "LN": return { bg: "#546e7a", text: "#fff" }; // steel blue-gray
        case "TN": return { bg: "#78909c", text: "#fff" }; // gray
        case "CN": return { bg: "#8d6e63", text: "#fff" }; // brown
        case "LE": return { bg: "#c62828", text: "#fff" }; // deep red
        case "NE": return { bg: "#d32f2f", text: "#fff" }; // red
        case "CE": return { bg: "#b71c1c", text: "#fff" }; // dark red
        case "U":  return { bg: "#757575", text: "#fff" }; // neutral gray
        default:   return { bg: "#999", text: "#fff" };
    }
}

/**
 * Convert a snake_case faction ID to a readable display name.
 * E.g. "demon_hunters_guild" → "Demon Hunters Guild"
 * If the ID matches a known Bible faction, use its real name instead.
 * @param {string} id — snake_case ID or already-readable name
 * @param {Map<string, Object>} [bibleLookup] — optional Bible lookup for resolving IDs to real names
 * @returns {string}
 */
function _resolveIdToName(id, bibleLookup) {
    if (!id || typeof id !== "string") return "";
    // If it doesn't contain underscores, it's probably already a name
    if (!id.includes("_")) return id.trim();
    // Try Bible lookup by ID
    if (bibleLookup?.size) {
        for (const [, bf] of bibleLookup) {
            if (bf.id === id) return bf.name;
        }
    }
    // Fallback: convert snake_case to Title Case
    return id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
}

/**
 * Format an allies or enemies field for display.
 * Handles arrays of snake_case IDs, comma-separated strings, or mixed.
 * @param {string|string[]} field — allies/enemies value
 * @param {Map<string, Object>} [bibleLookup]
 * @returns {string} — comma-separated readable names
 */
function _formatRelationList(field, bibleLookup) {
    if (!field) return "";
    const items = Array.isArray(field) ? field : String(field).split(",");
    return items.map(s => _resolveIdToName(s.trim(), bibleLookup)).filter(Boolean).join(", ");
}

// ─── WORLD BIBLE ENRICHMENT ─────────────────────────────────────────────────

/**
 * Build a name-normalized lookup Map from World Bible factions.
 * Indexes under exact lowercase name AND article-stripped form
 * (e.g. "The Harpers" → keyed as both "the harpers" and "harpers").
 * @param {Object[]} bibleFactions — Array from EngineBridge.getWorldBibleFactions()
 * @returns {Map<string, Object>}
 */
function _buildBibleLookup(bibleFactions) {
    const map = new Map();
    if (!bibleFactions?.length) return map;
    for (const bf of bibleFactions) {
        const name = (bf.name || "").trim();
        if (!name) continue;
        const key = name.toLowerCase();
        map.set(key, bf);
        // Also index under article-stripped form for fuzzy matching
        const stripped = key.replace(/^(the|a|an)\s+/i, "").trim();
        if (stripped && stripped !== key && !map.has(stripped)) {
            map.set(stripped, bf);
        }
    }
    return map;
}

/**
 * Enrich a faction object in-place with data from the World Bible.
 * Bible data fills gaps and upgrades thin fields with richer prose.
 * @param {Object} faction — Faction object (mutated in place)
 * @param {Map<string, Object>} bibleLookup — From _buildBibleLookup()
 * @returns {boolean} — true if enrichment was applied
 */
function _enrichFromBible(faction, bibleLookup) {
    if (!faction?.name || !bibleLookup.size) return false;
    const key = faction.name.toLowerCase().trim();
    let bible = bibleLookup.get(key);
    if (!bible) {
        // Try article-stripped match
        const stripped = key.replace(/^(the|a|an)\s+/i, "").trim();
        if (stripped !== key) bible = bibleLookup.get(stripped);
    }
    if (!bible) return false;

    // String fields: Bible wins if non-empty and faction field is empty or shorter
    const _mergeStr = (field) => {
        const bVal = (bible[field] || "").trim();
        const fVal = (faction[field] || "").trim();
        if (bVal && (!fVal || bVal.length > fVal.length)) faction[field] = bVal;
    };
    _mergeStr("leader");
    _mergeStr("alignment");
    _mergeStr("scope");
    _mergeStr("headquarters");
    _mergeStr("nation");
    _mergeStr("description");
    _mergeStr("purpose");
    _mergeStr("type");

    // Array fields: Bible Array replaces if non-empty
    const _mergeArr = (field) => {
        const bVal = bible[field];
        if (Array.isArray(bVal) && bVal.length > 0) faction[field] = bVal;
    };
    _mergeArr("allies");
    _mergeArr("enemies");
    _mergeArr("presence");

    // Fill _regionId if missing
    if (!faction._regionId && bible._regionId) faction._regionId = bible._regionId;

    faction._bibleEnriched = true;
    return true;
}

// ─── FACTION INFO PANEL BUILDER ──────────────────────────────────────────────

/**
 * Build HTML for the faction info panel shown under the faction dropdown.
 * @param {object} meta — { name, type, alignment, leader, description, region, members }
 * @returns {string} — HTML fragment
 */
function _buildFactionInfoHtml(meta) {
    if (!meta) return `<span style="color:#666; font-size:1.1em;">Select a faction above.</span>`;

    const parts = [];

    // Header line: name + type tag + alignment badge
    const typeLabel = (meta.type || "").replace(/_/g, " ");
    const typeTag = typeLabel ? `<span style="background:#c8be9e; padding:3px 10px; border-radius:4px; font-size:1em; font-weight:700; color:#111; margin-left:8px;">${typeLabel}</span>` : "";
    const alAbbrev = _abbreviateAlignment(meta.alignment);
    const alColor = _alignmentColor(alAbbrev);
    const alignTag = alAbbrev ? `<span style="background:${alColor.bg}; color:${alColor.text}; padding:3px 10px; border-radius:4px; font-size:1em; font-weight:700; margin-left:6px;">${alAbbrev}</span>` : "";
    parts.push(`<div style="margin-bottom:8px;"><strong style="color:#000; font-size:1.35em;">${meta.name || "Unknown"}</strong>${typeTag}${alignTag}</div>`);

    // Detail lines — bold, dark, each on own line for readability
    const details = [];
    if (meta.leader) details.push(`<strong>Leader:</strong> ${meta.leader}`);
    if (meta.region) details.push(`<strong>Region:</strong> ${meta.region}`);
    if (meta.members !== undefined) details.push(`<strong>Members on scene:</strong> ${meta.members}`);
    if (details.length) {
        parts.push(`<div style="color:#111; font-size:1.15em; font-weight:600; margin-bottom:8px; line-height:1.6;">${details.join("<br>")}</div>`);
    }

    // Description — full text, large and dark. No truncation under 3000 chars.
    const rawDesc = (meta.description || "").trim();
    if (rawDesc) {
        const desc = rawDesc.length > 3000 ? rawDesc.substring(0, 2997) + "..." : rawDesc;
        parts.push(`<div style="color:#111; font-size:1.1em; font-weight:500; line-height:1.55; border-top:2px solid #b8ae8e; padding-top:8px; margin-top:4px;">${desc}</div>`);
    }

    // If no details AND no description, show a "no info" notice so the panel isn't blank
    if (!details.length && !rawDesc) {
        parts.push(`<div style="color:#666; font-size:1.05em; font-style:italic; margin-top:4px;">No details available for this faction. Choose "Generate New Faction" for AI-created lore, or assign and the AI will flesh it out during bio generation.</div>`);
    }

    return parts.join("");
}

// ─── COMPREHENSIVE NPC IDENTITY DIALOG ──────────────────────────────────────

/**
 * Show the GM a comprehensive NPC setup dialog when a token is dropped.
 * Combines: role selection, origin, faction assignment, auto-link option.
 * @param {TokenDocument} tokenDoc
 * @param {FactionData[]} existingFactions
 * @param {string} creatureBase
 * @param {object|null} sceneIntel
 * @returns {Promise<{ factionId, isNew, role, origin, originCustom, autoLink } | null>}
 */
export async function showNpcIdentityDialog(tokenDoc, existingFactions, creatureBase, sceneIntel = null, worldDigestFactions = [], bibleFactions = [], recommendations = []) {
    const actor = tokenDoc.actor;
    const sceneName = canvas.scene?.name || "Unknown Scene";
    const template = getTemplate(creatureBase);
    const cr = actor.system?.details?.cr ?? 0;
    const alignment = actor.system?.details?.alignment ?? "Any Alignment";
    const creatureType = (actor.system?.details?.type?.value || "humanoid").toLowerCase();
    const creatureSubtype = (actor.system?.details?.type?.subtype || "").toLowerCase();

    // What ACE thinks this creature is, pre-filled into the correction box so
    // the GM only has to touch it when ACE got it wrong.
    //
    // ⚠️ resolveSpecies ALREADY EXISTS and already reads the GM's override
    // first, then dnd5e's custom/subtype/type fields, then the base actor's
    // name. Do not write a second one.
    let detectedSpecies = "";
    try {
        const { resolveSpecies } = await import("./npc-identity.mjs");
        detectedSpecies = resolveSpecies(actor, tokenDoc) || creatureSubtype || creatureType;
    } catch (_) {
        detectedSpecies = creatureSubtype || creatureType;
    }

    // Resolve role chips for this creature
    const chips = ROLE_CHIPS[creatureBase] ?? ROLE_CHIPS[creatureType] ?? ROLE_CHIPS._default;
    const defaultRole = _getDefaultRole(creatureBase, cr);

    // Determine default origin based on creature type
    const defaultOrigin = (creatureType === "fiend" || creatureType === "celestial" || creatureType === "aberration")
      ? "foreign" : "this_scene";

    // Check auto-link setting
    let autoLinkDefault = true;
    try { autoLinkDefault = game.settings.get(MODULE_ID, "enableAutoLink") ?? true; } catch { /* setting may not exist yet */ }

    // Check existing scene roles to suggest what's NOT yet filled
    const sceneRoles = new Set();
    try {
      for (const t of canvas.scene?.tokens ?? []) {
        if (t.id === tokenDoc.id) continue;
        const role = t.actor?.getFlag(MODULE_ID, "factionRole");
        if (role) sceneRoles.add(role.toLowerCase());
      }
    } catch (err) { console.debug("ACE: Engine | faction-registry scene role scan non-fatal:", err); }

    // ══════════════════════════════════════════════════════════════════
    // WORLD BIBLE ENRICHMENT — cross-reference ALL factions with Bible
    // ══════════════════════════════════════════════════════════════════
    const bibleLookup = _buildBibleLookup(bibleFactions);
    let enrichCount = 0;

    // Enrich scene canonical factions
    for (const f of (sceneIntel?.canonicalFactions ?? [])) {
        if (_enrichFromBible(f, bibleLookup)) enrichCount++;
    }
    // Enrich world digest factions
    for (const f of worldDigestFactions) {
        if (_enrichFromBible(f, bibleLookup)) enrichCount++;
    }
    // Enrich existing local factions
    for (const f of existingFactions) {
        if (_enrichFromBible(f, bibleLookup)) enrichCount++;
    }

    // Inject Bible-only factions into the world digest pool so they appear in the dialog
    const seenNames = new Set([
        ...(sceneIntel?.canonicalFactions ?? []).map(f => (f.name || "").toLowerCase()),
        ...worldDigestFactions.map(f => (f.name || "").toLowerCase()),
    ]);
    let injectedCount = 0;
    for (const bf of bibleFactions) {
        const key = (bf.name || "").toLowerCase().trim();
        if (!key || seenNames.has(key)) continue;
        // Also check article-stripped form to avoid near-duplicates
        const stripped = key.replace(/^(the|a|an)\s+/i, "").trim();
        if (stripped !== key && seenNames.has(stripped)) continue;
        seenNames.add(key);
        if (stripped !== key) seenNames.add(stripped);
        worldDigestFactions.push({
            ...bf,
            goals: bf.purpose || "",
            territory: Array.isArray(bf.presence) ? bf.presence.join(", ") : (bf.territory || ""),
            _bibleEnriched: true,
            _source: "world_bible",
        });
        injectedCount++;
    }

    if (enrichCount || injectedCount) {
        console.log(`${TAG} | Bible enrichment: ${enrichCount} factions enriched, ${injectedCount} Bible-only factions injected`);
    }

    // ══════════════════════════════════════════════════════════════════
    // SMART FACTION SCORING — combine canonical + world, cap at 20 total
    // ══════════════════════════════════════════════════════════════════
    const scoredCanonical = [];
    if (sceneIntel?.canonicalFactions?.length) {
      for (let idx = 0; idx < sceneIntel.canonicalFactions.length; idx++) {
        const f = { ...sceneIntel.canonicalFactions[idx], _sceneCanonical: true };
        const score = _scoreFactionForDialog(f, creatureType, creatureSubtype, creatureBase, sceneIntel, sceneName, actor);
        if (score >= 0) scoredCanonical.push({ ...f, _idx: idx, _score: score, _source: "canonical" });
      }
    }

    // World digest factions — dedupe by name against canonical
    const canonicalNames = new Set(scoredCanonical.map(f => (f.name || "").toLowerCase()));
    const scoredWorld = [];
    if (worldDigestFactions?.length) {
      for (let idx = 0; idx < worldDigestFactions.length; idx++) {
        const f = worldDigestFactions[idx];
        const nameLower = (f.name || "").toLowerCase();
        if (!nameLower || canonicalNames.has(nameLower)) continue;
        const score = _scoreFactionForDialog(f, creatureType, creatureSubtype, creatureBase, sceneIntel, sceneName, actor);
        if (score >= 0) scoredWorld.push({ ...f, _widx: idx, _score: score, _source: "world" });
      }
    }

    // Combine, sort by score, cap at 20 total
    const combined = [...scoredCanonical, ...scoredWorld].sort((a, b) => b._score - a._score);
    const MAX_VISIBLE = 20;
    const topCombined = combined.slice(0, MAX_VISIBLE);

    // Force-include any factions from the recommendation popup that got scored out or capped
    if (recommendations?.length) {
        const topNames = new Set(topCombined.map(f => (f.name || "").toLowerCase()));
        for (const rec of recommendations) {
            if (!rec.name || rec.source === "generate" || rec.source === "none") continue;
            const recLower = rec.name.toLowerCase();
            if (topNames.has(recLower)) continue;
            // Find it in the full combined list or source arrays
            let found = combined.find(f => (f.name || "").toLowerCase() === recLower);
            if (!found && rec.source === "canonical" && rec.canonIdx !== undefined) {
                const canon = sceneIntel?.canonicalFactions?.[rec.canonIdx];
                if (canon) found = { ...canon, _idx: rec.canonIdx, _score: 50, _source: "canonical" };
            }
            if (!found && rec.source === "world_digest" && rec.worldIdx !== undefined) {
                const wf = worldDigestFactions[rec.worldIdx];
                if (wf) found = { ...wf, _widx: rec.worldIdx, _score: 50, _source: "world" };
            }
            if (!found) {
                // Last resort — scan all sources by name
                const ci = (sceneIntel?.canonicalFactions ?? []).findIndex(f => (f.name || "").toLowerCase() === recLower);
                if (ci >= 0) found = { ...sceneIntel.canonicalFactions[ci], _idx: ci, _score: 50, _source: "canonical" };
                else {
                    const wi = worldDigestFactions.findIndex(f => (f.name || "").toLowerCase() === recLower);
                    if (wi >= 0) found = { ...worldDigestFactions[wi], _widx: wi, _score: 50, _source: "world" };
                }
            }
            if (found) {
                topCombined.push(found);
                topNames.add(recLower);
            }
        }
    }

    // Re-split by source for display (keeps section headers meaningful)
    const topCanonicalFiltered = topCombined.filter(f => f._source === "canonical");
    const topWorldFiltered = topCombined.filter(f => f._source === "world");
    console.log(`${TAG} | Faction dialog: ${combined.length} candidates → top ${topCombined.length} shown (${topCanonicalFiltered.length} scene + ${topWorldFiltered.length} world)`);

    // ── Build faction metadata lookup for the info panel ──
    const factionMeta = {};
    topCanonicalFiltered.forEach(f => {
      // Combine all available text — purpose, description, lore, goals (digest field)
      const descParts = [f.purpose, f.description, f.lore, f.goals].filter(Boolean);
      const fullDesc = descParts.join(" ").trim() || "";
      const extras = [];
      if (f.leader) extras.push(`Leader: ${f.leader}`);
      if (f.headquarters) extras.push(`Headquarters: ${_resolveIdToName(f.headquarters, bibleLookup)}`);
      if (f.scope) extras.push(`Scope: ${f.scope}`);
      const allyStr = _formatRelationList(f.allies, bibleLookup);
      const enemyStr = _formatRelationList(f.enemies, bibleLookup);
      if (allyStr) extras.push(`Allies: ${allyStr}`);
      if (enemyStr) extras.push(`Enemies: ${enemyStr}`);
      const extraText = extras.length ? "\n" + extras.join(" · ") : "";
      const region = (Array.isArray(f.presence) && f.presence.length)
        ? f.presence.map(p => _resolveIdToName(p, bibleLookup)).join(", ")
        : (f.territory || "");
      factionMeta[`__canonical__:${f._idx}`] = { name: f.name, type: f.type || "faction", alignment: f.alignment || "", leader: f.leader || "", description: fullDesc + extraText, region };
    });
    topWorldFiltered.forEach(f => {
      // Digest factions use "goals" not "purpose"/"description" — check all fields
      const descParts = [f.purpose, f.description, f.lore, f.goals].filter(Boolean);
      const fullDesc = descParts.join(" ").trim() || "";
      const extras = [];
      if (f.leader) extras.push(`Leader: ${f.leader}`);
      const allyStr = _formatRelationList(f.allies, bibleLookup);
      const enemyStr = _formatRelationList(f.enemies, bibleLookup);
      if (allyStr) extras.push(`Allies: ${allyStr}`);
      if (enemyStr) extras.push(`Enemies: ${enemyStr}`);
      if (f.headquarters) extras.push(`Headquarters: ${_resolveIdToName(f.headquarters, bibleLookup)}`);
      if (f.scope) extras.push(`Scope: ${f.scope}`);
      const extraText = extras.length ? "\n" + extras.join(" · ") : "";
      const region = f.region || (f._regionId ? _resolveIdToName(f._regionId, bibleLookup) : "") || f.territory || "";
      factionMeta[`__world__:${f._widx}`] = { name: f.name, type: f.type || "faction", alignment: f.alignment || "", leader: f.leader || "", description: fullDesc + extraText, region };
    });
    existingFactions.forEach(f => {
      const mc = f.members?.length ?? 0;
      const descParts = [f.purpose, f.lore, f.description].filter(Boolean);
      const fullDesc = descParts.join(" ").trim() || "";
      factionMeta[f.id] = { name: f.name, type: f.type || "faction", alignment: f.alignment || "", leader: f.leader || "", description: fullDesc, region: f.region || "", members: mc };
    });
    factionMeta["__new__"] = { name: "Generate New Faction", type: template?.type ?? "group", alignment: "", leader: "", description: `AI will create a new ${template?.type ?? "group"} for ${creatureBase}s in ${sceneName}. The faction will be tailored to the creature type, scene context, and world lore.`, region: "" };
    factionMeta["__none__"] = { name: "No Faction", type: "", alignment: "", leader: "", description: "This NPC is independent — their social profile and bio will define their identity without a faction affiliation.", region: "" };

    // Default OFF — most NPCs are throwaway. GMs check the box deliberately
    // when they want a recurring character with a persistent actor sheet.
    const persistDefault = false;

    return new Promise((resolve) => {
        // ── Build role chips HTML (D&D official variant names) ──
        const roleChipsHtml = chips.map(r => {
          const isDefault = r === defaultRole;
          const isOnScene = sceneRoles.has(r.toLowerCase());
          const dimStyle = isOnScene ? "opacity:0.4; text-decoration:line-through;" : "";
          return `<label class="ace-role-chip" style="display:inline-flex; align-items:center; gap:4px; padding:4px 10px;
            border:${isDefault ? "2px solid #222" : "1px solid #bbb"}; border-radius:14px; cursor:pointer; font-size:1.05em; ${dimStyle}
            background:${isDefault ? "rgba(212,175,55,0.15)" : "#f5f5f5"}; color:#222; font-weight:${isDefault ? "bold" : "normal"};
            transition:all 0.15s ease;">
            <input type="radio" name="npcRole" value="${r}" ${isDefault ? "checked" : ""} style="display:none;">
            <span class="ace-chip-text">${r}</span>
          </label>`;
        }).join(" ");

        // ── Build origin dropdown HTML ──
        const originDropdownHtml = ORIGIN_OPTIONS.map(o => {
          const sel = o.value === defaultOrigin ? "selected" : "";
          return `<option value="${o.value}" ${sel} title="${o.desc}">${o.label}</option>`;
        }).join("");

        // ── Build faction dropdown with optgroups ──
        let factionOptionsHtml = "";
        const defaultFactionValue = topCanonicalFiltered.length
          ? `__canonical__:${topCanonicalFiltered[0]._idx}`
          : (existingFactions.length ? existingFactions[0].id
          : (_isCivilianBase(creatureBase) ? "__none__" : "__new__"));

        if (topCanonicalFiltered.length) {
          factionOptionsHtml += `<optgroup label="Scene: ${sceneName}">`;
          factionOptionsHtml += topCanonicalFiltered.map(f => {
            const val = `__canonical__:${f._idx}`;
            const alAbbr = _abbreviateAlignment(f.alignment);
            const alStr = alAbbr ? ` [${alAbbr}]` : "";
            const sel = val === defaultFactionValue ? "selected" : "";
            return `<option value="${val}" ${sel}>${f.name} \u2014 ${f.type || "faction"}${alStr}</option>`;
          }).join("");
          factionOptionsHtml += `</optgroup>`;
        }

        if (topWorldFiltered.length) {
          factionOptionsHtml += `<optgroup label="World Digest">`;
          factionOptionsHtml += topWorldFiltered.map(f => {
            const val = `__world__:${f._widx}`;
            const alAbbr = _abbreviateAlignment(f.alignment);
            const alStr = alAbbr ? ` [${alAbbr}]` : "";
            const sel = val === defaultFactionValue ? "selected" : "";
            return `<option value="${val}" ${sel}>${f.name} \u2014 ${f.type || "faction"}${alStr}</option>`;
          }).join("");
          factionOptionsHtml += `</optgroup>`;
        }

        if (existingFactions.length) {
          factionOptionsHtml += `<optgroup label="Already on Scene">`;
          factionOptionsHtml += existingFactions.map(f => {
            const mc = f.members?.length ?? 0;
            const sel = f.id === defaultFactionValue ? "selected" : "";
            return `<option value="${f.id}" ${sel}>${f.name} \u2014 ${f.type} (${mc} member${mc !== 1 ? "s" : ""})</option>`;
          }).join("");
          factionOptionsHtml += `</optgroup>`;
        }

        factionOptionsHtml += `<optgroup label="Other">`;
        factionOptionsHtml += `<option value="__new__" ${"__new__" === defaultFactionValue ? "selected" : ""}>\u2728 Generate New Faction</option>`;
        factionOptionsHtml += `<option value="__none__" ${"__none__" === defaultFactionValue ? "selected" : ""}>\u2014 No Faction</option>`;
        factionOptionsHtml += `</optgroup>`;

        // ── Build the default info panel content ──
        const defaultMeta = factionMeta[defaultFactionValue] || factionMeta["__none__"];
        const defaultInfoHtml = _buildFactionInfoHtml(defaultMeta);

        // ── Build the complete dialog HTML ──
        const dialogHtml = `
          <div style="padding:2px; font-family:sans-serif;">
            <!-- Creature Info Banner -->
            <div style="display:flex; align-items:center; gap:12px; padding:10px; margin-bottom:12px; background:#f0ead6; border:1px solid #ccc; border-radius:6px;">
              <img src="${actor.prototypeToken?.texture?.src || actor.img || 'icons/svg/mystery-man.svg'}"
                   style="width:48px; height:48px; border-radius:6px; border:2px solid #b8860b;"
                   onerror="this.src='icons/svg/mystery-man.svg'">
              <div>
                <strong style="font-size:1.3em; color:#111;">${actor.name}</strong> <span style="color:#555;">(${creatureBase})</span>
                <br><span style="font-size:1.05em; color:#333;">${creatureType}${creatureSubtype ? ` (${creatureSubtype})` : ""} \u00b7 ${alignment} \u00b7 CR ${cr}</span>
              </div>
            </div>

            <!-- Role Selection -->
            <div style="margin-bottom:14px;">
              <div style="font-size:1em; text-transform:uppercase; letter-spacing:0.05em; color:#8b6914; font-weight:bold; margin-bottom:6px;">
                <i class="fas fa-user-tag"></i> Role
              </div>
              <div style="display:flex; flex-wrap:wrap; gap:5px;">
                ${roleChipsHtml}
              </div>
              <input type="text" name="npcRoleCustom" placeholder="Or type a custom role..."
                     autocomplete="off" data-lpignore="true" data-1p-ignore="true"
                     style="width:100%; margin-top:6px; padding:6px 10px; background:#fff; border:1px solid #bbb; border-radius:4px; color:#222; font-size:1.05em;">
            </div>

            <!-- Origin + Location (compact row) -->
            <div style="margin-bottom:14px;">
              <div style="font-size:1em; text-transform:uppercase; letter-spacing:0.05em; color:#8b6914; font-weight:bold; margin-bottom:6px;">
                <i class="fas fa-compass"></i> Origin
              </div>
              <div style="display:flex; gap:8px; align-items:center;">
                <select name="npcOrigin" style="flex:0 0 auto; padding:6px 10px; background:#fff; border:1px solid #bbb; border-radius:4px; color:#222; font-size:1.05em; color-scheme:light;">
                  ${originDropdownHtml}
                </select>
                <input type="text" name="npcOriginCustom" placeholder="Specific location (optional)..."
                       autocomplete="off" data-lpignore="true" data-1p-ignore="true"
                       style="flex:1; padding:6px 10px; background:#fff; border:1px solid #bbb; border-radius:4px; color:#222; font-size:1.05em;">
              </div>
            </div>

            <!-- Faction Selection (dropdown + info panel) -->
            <div style="margin-bottom:14px;">
              <div style="font-size:1em; text-transform:uppercase; letter-spacing:0.05em; color:#8b6914; font-weight:bold; margin-bottom:6px;">
                <i class="fas fa-flag"></i> Faction
              </div>
              <select name="factionChoice" style="width:100%; padding:12px 10px; background:#fff; border:1px solid #bbb; border-radius:4px; color:#111; font-size:1.1em; font-weight:600; margin-bottom:8px; line-height:1.4; color-scheme:light;">
                ${factionOptionsHtml}
              </select>
              <div class="ace-faction-info" style="padding:12px 14px; background:#f9f7f0; border:1px solid #d4c9a8; border-radius:6px; font-size:1.05em; color:#222;">
                ${defaultInfoHtml}
              </div>
            </div>

            <!-- Gender Override -->
            <div style="margin-bottom:14px;">
              <div style="font-size:1em; text-transform:uppercase; letter-spacing:0.05em; color:#8b6914; font-weight:bold; margin-bottom:6px;">
                <i class="fas fa-venus-mars"></i> Gender
              </div>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <label style="flex:1; min-width:90px; cursor:pointer; padding:8px 10px; background:#fff; border:1px solid #bbb; border-radius:4px; font-size:0.95em; color:#222; display:flex; align-items:center; gap:6px;">
                  <input type="radio" name="genderOverride" value="auto" checked style="accent-color:#d4af37;"> Auto
                </label>
                <label style="flex:1; min-width:90px; cursor:pointer; padding:8px 10px; background:#fff; border:1px solid #bbb; border-radius:4px; font-size:0.95em; color:#222; display:flex; align-items:center; gap:6px;">
                  <input type="radio" name="genderOverride" value="male" style="accent-color:#d4af37;"> Male
                </label>
                <label style="flex:1; min-width:90px; cursor:pointer; padding:8px 10px; background:#fff; border:1px solid #bbb; border-radius:4px; font-size:0.95em; color:#222; display:flex; align-items:center; gap:6px;">
                  <input type="radio" name="genderOverride" value="female" style="accent-color:#d4af37;"> Female
                </label>
                <label style="flex:1; min-width:90px; cursor:pointer; padding:8px 10px; background:#fff; border:1px solid #bbb; border-radius:4px; font-size:0.95em; color:#222; display:flex; align-items:center; gap:6px;">
                  <input type="radio" name="genderOverride" value="androgynous" style="accent-color:#d4af37;"> Androgynous
                </label>
              </div>
              <div style="font-size:0.85em; color:#666; margin-top:4px; line-height:1.4;">
                Auto = ACE decides from the portrait and the statblock, then writes the answer down so the voice matches the name. Pick one to lock it.
              </div>
            </div>

            <!-- What it is — the naming input the GM can correct -->
            <!--
              ⚠️ THIS IS ONE OF THE THREE THINGS THE NAMER GETS, and the only one
              ACE can get wrong on its own. Johnny, 2026-08-23: "we could even
              have a dropdown or a correction area, where we could say, hey, no,
              this isn't a fucking goblin. This is a hobgoblin. You got that
              wrong, buddy."
              Pre-filled with what ACE worked out, so it is a CORRECTION SURFACE
              and never a requirement. Naming still works when this dialog is
              never opened, which it usually is not.
            -->
            <div style="margin-bottom:14px;">
              <div style="font-size:1em; text-transform:uppercase; letter-spacing:0.05em; color:#8b6914; font-weight:bold; margin-bottom:6px;">
                <i class="fas fa-paw"></i> What It Is
              </div>
              <input type="text" name="speciesOverride" value="${foundry.utils.escapeHTML(String(detectedSpecies || ""))}"
                     placeholder="goblin, hobgoblin, drow, human..."
                     style="width:100%; padding:8px 10px; background:#fff; border:1px solid #bbb; border-radius:4px; color:#222; font-size:1em;">
              <div style="font-size:0.85em; color:#666; margin-top:4px; line-height:1.4;">
                Used to pick a fitting name. ACE read this off the statblock &mdash; correct it if it is wrong and the name will match.
              </div>
            </div>

            <!-- Rename NPC Checkbox -->
            <div style="padding:8px 10px; background:#f5f5f5; border:1px solid #ccc; border-radius:6px; margin-bottom:8px;">
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" name="rename" ${(creatureType === "beast" || creatureType === "ooze" || creatureType === "plant" || creatureType === "swarm") ? "" : "checked"} ${(creatureType === "beast" || creatureType === "ooze" || creatureType === "plant" || creatureType === "swarm") ? "disabled" : ""} style="accent-color:#d4af37; width:16px; height:16px;">
                <div>
                  <strong style="font-size:1.05em; color:#222;">Rename NPC</strong>
                  <span style="font-size:0.95em; color:#555;"> \u2014 AI gives the bio's protagonist a personal name (e.g. "Gronk" instead of "Goblin"). Uncheck to keep the species label.</span>
                </div>
              </label>
            </div>

            <!-- Persistent NPC Checkbox -->
            <div style="padding:8px 10px; background:#f5f5f5; border:1px solid #ccc; border-radius:6px;">
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" name="autoLink" ${persistDefault ? "checked" : ""} style="accent-color:#d4af37; width:16px; height:16px;">
                <div>
                  <strong style="font-size:1.05em; color:#222;">Save as persistent NPC</strong>
                  <span style="font-size:0.95em; color:#555;"> \u2014 creates linked actor in sidebar. Uncheck for disposable tokens.</span>
                </div>
              </label>
            </div>
          </div>`;

        // ── Create Foundry Dialog ──
        const d = new Dialog({
            title: `NPC Setup — ${actor.name}`,
            content: dialogHtml,
            buttons: {
                create: {
                    icon: '<i class="fas fa-star"></i>',
                    label: "Create NPC",
                    callback: (html) => {
                        // Read role (chip or custom)
                        const chipRole = html.find('input[name="npcRole"]:checked').val() || "";
                        const customRole = html.find('input[name="npcRoleCustom"]').val()?.trim() || "";
                        const role = customRole || chipRole;

                        // Read origin (dropdown)
                        const origin = html.find('select[name="npcOrigin"]').val() || "this_scene";
                        const originCustom = html.find('input[name="npcOriginCustom"]').val()?.trim() || "";

                        // Read faction (dropdown)
                        const factionChoice = html.find('select[name="factionChoice"]').val() || "__none__";

                        // Read auto-link
                        const autoLink = html.find('input[name="autoLink"]').is(':checked');

                        // Read rename preference (overrides the outer smart-setup dialog's choice)
                        const rename = html.find('input[name="rename"]').is(':checked');

                        // Read gender override (auto / male / female / androgynous)
                        const genderOverride = html.find('input[name="genderOverride"]:checked').val() || "auto";

                        // What the GM says this creature is. Only recorded when
                        // it DIFFERS from what ACE detected, so an untouched box
                        // never writes a flag — a field nobody edited must not
                        // become stored data.
                        const typedSpecies = String(html.find('input[name="speciesOverride"]').val() ?? "").trim();
                        const speciesOverride =
                            (typedSpecies && typedSpecies.toLowerCase() !== String(detectedSpecies || "").toLowerCase())
                                ? typedSpecies
                                : "";

                        // Parse faction choice
                        let factionId = null;
                        let isNew = false;
                        if (factionChoice === "__new__") {
                            isNew = true;
                        } else if (factionChoice === "__none__") {
                            factionId = null;
                        } else if (factionChoice.startsWith("__canonical__:") || factionChoice.startsWith("__world__:")) {
                            factionId = factionChoice; // handled downstream
                        } else {
                            factionId = factionChoice;
                        }

                        resolve({ factionId, isNew, role, origin, originCustom, autoLink, rename, genderOverride, speciesOverride });
                    }
                },
                skip: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Skip",
                    callback: () => resolve(null)
                }
            },
            default: "create",
            close: () => resolve(null),
        }, {
            width: 520,
            height: "auto",
            resizable: true,
            classes: ["ace-npc-identity-dialog"],
        });
        d.render(true);

        // ── Wire up chip click styling + faction info panel ──
        setTimeout(() => {
            const el = d.element?.[0] ?? document.querySelector(".ace-npc-identity-dialog");
            if (!el) return;

            // Faction metadata for info panel (closure reference — mutable)
            let _factionMeta = factionMeta;

            // ── Closure data for dynamic origin-based faction rebuild ──
            const _sceneName = sceneName;
            const _scoredCanonical = scoredCanonical;
            const _scoredWorld = scoredWorld;
            const _existingFactions = existingFactions;
            const _bibleLookup = bibleLookup;
            const _sceneRegion = sceneIntel?.canonicalFactions?.[0]?._regionId || "";

            /**
             * Rebuild the faction dropdown options based on the selected origin.
             * "this_scene"/"nearby" → prioritize local/regional factions
             * "elsewhere"/"foreign" → show ALL factions, prioritize non-local
             */
            function _rebuildFactionDropdown(origin) {
                const factionSelect = el.querySelector('select[name="factionChoice"]');
                const infoPanel = el.querySelector('.ace-faction-info');
                if (!factionSelect) return;

                // ── ⚠️🔴 FILTERING A MENU MUST NEVER UN-CHOOSE WHAT WAS CHOSEN.
                //
                // This function replaces the whole option list. It never put the
                // GM's current pick back, so the select silently fell to
                // whatever now sat first — the top-scoring recommendation.
                //
                // Johnny, live 2026-08-23: "I picked the faction first, the
                // Cragmaw whatever, and then I went and changed it from a local
                // to elsewhere. Soon as I did that, it went back to Mind
                // Flayers." Changing the ORIGIN silently discarded his FACTION.
                // That is what started the whole Mind Flayers hunt.
                //
                // Captured here, restored at the end, and re-added to the list
                // if the new filter dropped it. An explicit choice outranks a
                // filter every time.
                const chosenBefore = factionSelect.value;
                const chosenLabel  = factionSelect.selectedOptions?.[0]?.textContent ?? "";

                // Determine caps and scoring adjustments per origin
                const isLocal = (origin === "this_scene" || origin === "nearby");
                const MAX = isLocal ? 25 : 50;

                // Re-filter and re-sort based on origin
                let filteredCanonical, filteredWorld;
                if (isLocal) {
                    // Local: standard scoring, scene factions first
                    filteredCanonical = [..._scoredCanonical].sort((a, b) => b._score - a._score);
                    filteredWorld = [..._scoredWorld].sort((a, b) => b._score - a._score);
                } else {
                    // Foreign/elsewhere: boost non-local, show everything
                    filteredCanonical = [..._scoredCanonical].map(f => {
                        const isOtherRegion = f._regionId && f._regionId !== _sceneRegion;
                        return { ...f, _score: f._score + (isOtherRegion ? 30 : -10) };
                    }).sort((a, b) => b._score - a._score);
                    filteredWorld = [..._scoredWorld].map(f => {
                        const isOtherRegion = f._regionId && f._regionId !== _sceneRegion;
                        const isGlobal = (f.scope === "continental" || f.scope === "global" || f._regionId === "global");
                        return { ...f, _score: f._score + (isOtherRegion ? 30 : 0) + (isGlobal ? 20 : 0) };
                    }).sort((a, b) => b._score - a._score);
                }

                // Combine, cap, split
                const allCombined = [...filteredCanonical, ...filteredWorld].sort((a, b) => b._score - a._score);
                const capped = allCombined.slice(0, MAX);
                const capCanon = capped.filter(f => f._source === "canonical");
                const capWorld = capped.filter(f => f._source === "world");

                // Rebuild metadata
                const newMeta = {};
                capCanon.forEach(f => {
                    const descParts = [f.purpose, f.description, f.lore, f.goals].filter(Boolean);
                    const fullDesc = descParts.join(" ").trim() || "";
                    const extras = [];
                    if (f.leader) extras.push(`Leader: ${f.leader}`);
                    if (f.headquarters) extras.push(`Headquarters: ${_resolveIdToName(f.headquarters, _bibleLookup)}`);
                    if (f.scope) extras.push(`Scope: ${f.scope}`);
                    const allyStr = _formatRelationList(f.allies, _bibleLookup);
                    const enemyStr = _formatRelationList(f.enemies, _bibleLookup);
                    if (allyStr) extras.push(`Allies: ${allyStr}`);
                    if (enemyStr) extras.push(`Enemies: ${enemyStr}`);
                    const extraText = extras.length ? "\n" + extras.join(" \u00b7 ") : "";
                    const region = (Array.isArray(f.presence) && f.presence.length) ? f.presence.map(p => _resolveIdToName(p, _bibleLookup)).join(", ") : (f.territory || "");
                    newMeta[`__canonical__:${f._idx}`] = { name: f.name, type: f.type || "faction", alignment: f.alignment || "", leader: f.leader || "", description: fullDesc + extraText, region };
                });
                capWorld.forEach(f => {
                    const descParts = [f.purpose, f.description, f.lore, f.goals].filter(Boolean);
                    const fullDesc = descParts.join(" ").trim() || "";
                    const extras = [];
                    if (f.leader) extras.push(`Leader: ${f.leader}`);
                    const allyStr = _formatRelationList(f.allies, _bibleLookup);
                    const enemyStr = _formatRelationList(f.enemies, _bibleLookup);
                    if (allyStr) extras.push(`Allies: ${allyStr}`);
                    if (enemyStr) extras.push(`Enemies: ${enemyStr}`);
                    if (f.headquarters) extras.push(`Headquarters: ${_resolveIdToName(f.headquarters, _bibleLookup)}`);
                    if (f.scope) extras.push(`Scope: ${f.scope}`);
                    const extraText = extras.length ? "\n" + extras.join(" \u00b7 ") : "";
                    const region = f.region || (f._regionId ? _resolveIdToName(f._regionId, _bibleLookup) : "") || f.territory || "";
                    newMeta[`__world__:${f._widx}`] = { name: f.name, type: f.type || "faction", alignment: f.alignment || "", leader: f.leader || "", description: fullDesc + extraText, region };
                });
                _existingFactions.forEach(f => {
                    const mc = f.members?.length ?? 0;
                    const descParts = [f.purpose, f.lore, f.description].filter(Boolean);
                    const fullDesc = descParts.join(" ").trim() || "";
                    newMeta[f.id] = { name: f.name, type: f.type || "faction", alignment: f.alignment || "", leader: f.leader || "", description: fullDesc, region: f.region || "", members: mc };
                });
                newMeta["__new__"] = _factionMeta["__new__"] || { name: "Generate New Faction", type: "group", alignment: "", leader: "", description: "AI will create a new faction.", region: "" };
                newMeta["__none__"] = _factionMeta["__none__"] || { name: "No Faction", type: "", alignment: "", leader: "", description: "Independent NPC.", region: "" };

                // Update closure reference
                _factionMeta = newMeta;

                // Rebuild dropdown HTML
                const sectionLabel = isLocal ? `Scene: ${_sceneName}` : `Scene: ${_sceneName} (all regions)`;
                let html = "";
                if (capCanon.length) {
                    html += `<optgroup label="${sectionLabel}">`;
                    html += capCanon.map(f => {
                        const val = `__canonical__:${f._idx}`;
                        const alAbbr = _abbreviateAlignment(f.alignment);
                        const alStr = alAbbr ? ` [${alAbbr}]` : "";
                        return `<option value="${val}">${f.name} \u2014 ${f.type || "faction"}${alStr}</option>`;
                    }).join("");
                    html += `</optgroup>`;
                }
                if (capWorld.length) {
                    html += `<optgroup label="World${isLocal ? " Digest" : " — All Regions"}">`;
                    html += capWorld.map(f => {
                        const val = `__world__:${f._widx}`;
                        const alAbbr = _abbreviateAlignment(f.alignment);
                        const alStr = alAbbr ? ` [${alAbbr}]` : "";
                        return `<option value="${val}">${f.name} \u2014 ${f.type || "faction"}${alStr}</option>`;
                    }).join("");
                    html += `</optgroup>`;
                }
                if (_existingFactions.length) {
                    html += `<optgroup label="Already on Scene">`;
                    html += _existingFactions.map(f => {
                        const mc = f.members?.length ?? 0;
                        return `<option value="${f.id}">${f.name} \u2014 ${f.type} (${mc} member${mc !== 1 ? "s" : ""})</option>`;
                    }).join("");
                    html += `</optgroup>`;
                }
                html += `<optgroup label="Other">`;
                html += `<option value="__new__">\u2728 Generate New Faction</option>`;
                html += `<option value="__none__">\u2014 No Faction</option>`;
                html += `</optgroup>`;

                factionSelect.innerHTML = html;

                // Force visibility styles on new options
                factionSelect.style.setProperty('color', '#111', 'important');
                factionSelect.style.setProperty('color-scheme', 'light', 'important');

                // ── Put the GM's choice back ─────────────────────────────
                if (chosenBefore) {
                    const stillThere = [...factionSelect.options].some(o => o.value === chosenBefore);
                    if (!stillThere) {
                        // The new filter no longer lists it. Keep it anyway,
                        // clearly marked, rather than overriding a decision the
                        // GM already made.
                        const grp = document.createElement("optgroup");
                        grp.label = "Your choice";
                        const opt = document.createElement("option");
                        opt.value = chosenBefore;
                        opt.textContent = chosenLabel || chosenBefore;
                        grp.appendChild(opt);
                        factionSelect.prepend(grp);
                    }
                    factionSelect.value = chosenBefore;
                }

                // Update the info panel for whatever is now actually selected.
                const shownVal = factionSelect.value;
                const shownMeta = newMeta[shownVal] || _factionMeta[shownVal] || newMeta["__none__"];
                if (infoPanel) infoPanel.innerHTML = _buildFactionInfoHtml(shownMeta);
            }

            // ── Role chip selection highlighting ──
            el.querySelectorAll('input[name="npcRole"]').forEach(radio => {
                radio.addEventListener("change", () => {
                    el.querySelectorAll('input[name="npcRole"]').forEach(r => {
                        const label = r.closest("label");
                        if (label) {
                            label.style.border = r.checked ? "2px solid #222" : "1px solid #bbb";
                            label.style.background = r.checked ? "rgba(212,175,55,0.15)" : "#f5f5f5";
                            label.style.fontWeight = r.checked ? "bold" : "normal";
                        }
                    });
                });
            });

            // ── Custom role clears chip selection ──
            const customInput = el.querySelector('input[name="npcRoleCustom"]');
            if (customInput) {
                customInput.addEventListener("input", () => {
                    if (customInput.value.trim()) {
                        el.querySelectorAll('input[name="npcRole"]').forEach(r => { r.checked = false; });
                        el.querySelectorAll('input[name="npcRole"]').forEach(r => {
                            const label = r.closest("label");
                            if (label) { label.style.border = "1px solid #bbb"; label.style.background = "#f5f5f5"; label.style.fontWeight = "normal"; }
                        });
                    }
                });
            }

            // ── Origin dropdown → rebuild faction list ──
            const originSelect = el.querySelector('select[name="npcOrigin"]');
            if (originSelect) {
                originSelect.addEventListener("change", () => {
                    _rebuildFactionDropdown(originSelect.value);
                });
            }

            // ── Faction dropdown → info panel update ──
            const factionSelect = el.querySelector('select[name="factionChoice"]');
            const infoPanel = el.querySelector('.ace-faction-info');
            if (factionSelect && infoPanel) {
                factionSelect.addEventListener("change", () => {
                    const val = factionSelect.value;
                    const meta = _factionMeta[val] || { name: val, type: "", description: "" };
                    infoPanel.innerHTML = _buildFactionInfoHtml(meta);
                });
            }

            // ── Force dropdown text visibility (bypasses ALL theme CSS) ──
            el.querySelectorAll('select').forEach(sel => {
                sel.style.setProperty('color', '#111', 'important');
                sel.style.setProperty('background', '#fff', 'important');
                sel.style.setProperty('-webkit-text-fill-color', '#111', 'important');
                sel.style.setProperty('color-scheme', 'light', 'important');
                sel.style.setProperty('opacity', '1', 'important');
                // Also fix options and optgroups
                sel.querySelectorAll('option').forEach(opt => {
                    opt.style.setProperty('color', '#111', 'important');
                    opt.style.setProperty('-webkit-text-fill-color', '#111', 'important');
                });
                sel.querySelectorAll('optgroup').forEach(og => {
                    og.style.setProperty('color', '#555', 'important');
                    og.style.setProperty('-webkit-text-fill-color', '#555', 'important');
                });
            });
        }, 100);
    });
}

/**
 * Score a canonical faction for the NPC identity dialog.
 * Wraps the existing affinity logic in a callable function.
 */
/**
 * Is this registry entry not actually a faction?
 *
 * ⚠️🔴 ONE DEFINITION, BECAUSE ONE COPY WAS NOT ENOUGH (2026-08-23). This test
 * already existed, inline, inside the Customize dialog's scorer. The QUICK
 * setup screen — the three-option one a GM actually sees on a token drop — used
 * a different path and never learned it, so it offered Johnny "Goblinoids" as
 * a faction his goblin might belong to.
 *
 * A creature type is not an organisation. Neither is "Evil-Aligned Factions".
 * Both are artefacts of importing a sourcebook index as though it were a roster,
 * and both are useless as an allegiance.
 *
 * Exported so there is exactly one place that decides this. Fixing the copy that
 * surfaced and leaving the other is the habit that keeps costing days.
 */
const _rejectedNames = new Set();

/**
 * Give lowercase faction names their capitals back.
 *
 * ⚠️ ONLY NAMES THAT ARE ENTIRELY LOWERCASE ARE TOUCHED. A name with any
 * capital in it already was written by somebody on purpose - "the Order of the
 * Silver Dragon", "vistani" the adjective versus "Vistani" the people - and
 * re-casing those would quietly rewrite Johnny's own words. All-lowercase is
 * the only signal that means "this came out of an extractor, not a person".
 *
 * ⚠️ SMALL WORDS STAY SMALL, except at the start. "keepers of the black
 * feather" becomes "Keepers of the Black Feather", not "Keepers Of The Black
 * Feather", which reads like a spreadsheet rather than a name.
 *
 * ⚠️ DRY RUN BY DEFAULT, and it prints every before/after line. This edits
 * the world graph, which is his campaign's memory - he sees the list first.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.fix=false]  Actually write the change.
 * @returns {Promise<{renamed:number, names:Array<[string,string]>}>}
 */
export async function capitaliseFactionNames({ fix = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications?.warn("Only the GM can rename factions.");
        return { renamed: 0, names: [] };
    }

    const SMALL = new Set(["of", "the", "and", "in", "on", "at", "to", "for",
                           "a", "an", "or", "de", "von", "van"]);
    const titleCase = (name) => String(name).split(/\s+/).map((word, i) => {
        const lower = word.toLowerCase();
        if (i > 0 && SMALL.has(lower)) return lower;
        // Hyphenated and apostrophed parts each get their own capital:
        // "half-orc" -> "Half-Orc", "d'avenir" -> "D'Avenir".
        return lower.replace(/(^|[-'’])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase());
    }).join(" ");

    // ⚠️ THE REGISTRY, NOT THE DIGEST GRAPH. The graph is rebuilt from source
    // material every time it loads, so a rename written there is undone on the
    // next build. `_load()`/`_save()` are this file's own store - a world
    // setting - and that is the copy every picker, standing and deed reads.
    const data = _load();
    const factions = data?.factions ?? data;
    if (!factions || typeof factions !== "object") {
        // ⚠️ "ABSENT" AND "BROKEN" MUST NOT PRINT THE SAME THING. Say which.
        console.warn(`${TAG} | capitaliseFactionNames: the faction registry is empty or `
            + `unreadable, so there is nothing to rename. That is not "every name is fine".`);
        ui.notifications?.warn("The faction registry is empty — nothing to rename.");
        return { renamed: 0, names: [] };
    }

    const names = [];
    let total = 0;
    for (const f of Object.values(factions)) {
        if (!f || typeof f !== "object") continue;
        total++;
        const raw = String(f.name ?? "");
        if (!raw || raw !== raw.toLowerCase()) continue;   // has a capital already
        if (!/[a-z]/.test(raw)) continue;                  // nothing to capitalise
        const next = titleCase(raw);
        if (next === raw) continue;
        names.push([raw, next]);
        if (fix) f.name = next;
    }

    console.log(`${TAG} | capitaliseFactionNames ${fix ? "APPLIED" : "(dry run)"} — `
        + `${names.length} of ${total} faction names are all-lowercase:`);
    for (const [before, after] of names) console.log(`     "${before}"  ->  "${after}"`);

    if (fix && names.length) {
        try {
            await _save(data);
            console.log(`${TAG} | faction registry saved.`);
        } catch (err) {
            console.error(`${TAG} | could not save the faction registry — nothing was kept:`, err);
            ui.notifications?.error("Could not save the renamed factions — see the console.");
            return { renamed: 0, names };
        }
    } else if (!fix) {
        console.log(`${TAG} | nothing was written. Run again with { fix: true } to apply.`);
    }

    ui.notifications?.info(`${names.length} faction name(s) ${fix ? "capitalised" : "would be capitalised (dry run)"}.`);
    return { renamed: fix ? names.length : 0, names };
}

export function isNotARealFaction(f) {
    const nameRaw = String(f?.name ?? "").trim();
    if (!nameRaw) return true;
    const nameLower = nameRaw.toLowerCase();

    // "Evil-Aligned Factions", "World-Preserving Factions", "Major Factions"…
    const GENERIC_CATEGORY = /^(evil|good|neutral|lawful|chaotic|world[\s-]\w+|practical|esoteric|major|minor|ancient|modern|other|misc|various|all)[\s\-/]*\w*\s+factions?$/i;
    if (GENERIC_CATEGORY.test(nameLower)) return true;
    if (/\baligned factions?\b|\btype factions?\b|\bcategory factions?\b/i.test(nameLower)) return true;

    // The digest sometimes indexes taxonomy entries as factions.
    const SPECIES_TYPES = new Set(["species", "race", "creature type", "creature", "taxonomy", "monster", "beast type", "creature family"]);
    if (SPECIES_TYPES.has(String(f?.type ?? "").toLowerCase())) return true;

    // A name that IS a creature type: "Goblinoids", "Orcs", "Undead".
    const CREATURE_TYPE_NAMES = /^(goblinoids?|orcs?|elves|dwarves|humans?|gnolls?|kobolds?|lizardfolk|undead|fiends?|celestials?|aberrations?|constructs?|elementals?|monstrosities|oozes?|plants?|beasts?|giants?|dragons?|fey|humanoids?|beholders?|mind ?flayers?|illithids?|aboleths?|trolls?|ogres?|hobgoblins?|bugbears?|goblins?|treants?|golems?|skeletons?|zombies?|ghouls?|wights?|spectres?|specters?|wraiths?|liches|harpies|minotaurs?|medusas?|myconids?|grimlocks?|troglodytes?|gargoyles?|basilisks?|chimeras?|manticores?|wyverns?|slimes?|shamblers?|swarms?)$/i;
    if (CREATURE_TYPE_NAMES.test(nameRaw)) {
        // ⚠️ SAY WHAT WAS REJECTED, ONCE. This list is a judgement about
        // somebody else's data. If it ever culls a group Johnny considers real,
        // the failure mode without this line is a faction that silently stops
        // appearing in every picker with nothing to explain why — undebuggable
        // from the outside. One console line per name makes it findable.
        if (!_rejectedNames.has(nameLower)) {
            _rejectedNames.add(nameLower);
            console.log(`${TAG} | "${nameRaw}" is a creature KIND, not an organisation — not offered as a faction. `
                + `If that is wrong, rename it to something that reads as a group.`);
        }
        return true;
    }

    return false;
}

function _scoreFactionForDialog(f, creatureType, creatureSubtype, creatureBase, sceneIntel, sceneName, actor) {
    // ── HARD EXCLUSION 1: Generic category factions (not real factions) ──
    // These are placeholder groupings from digest extraction, not actual factions.
    const fNameRaw = (f.name || "").trim();
    const fNameLower = fNameRaw.toLowerCase();
    // ⚠️ ONE DEFINITION. These rules used to live here, inline, and the quick
    // setup screen never saw them — which is how "Goblinoids" was offered as a
    // faction. See isNotARealFaction above.
    if (isNotARealFaction(f)) return -1;

    // Reuse the AFFINITY matrix and scoring from the existing system
    const AFFINITY = {
      humanoid:    { military: 80, criminal: 80, religious: 80, political: 80, mercantile: 80, arcane: 70, "noble house": 70, cult: 80, tribe: 70, gang: 80, undead: 40, nature: 60, resistance: 70, government: 80 },
      undead:      { military: 20, criminal: 10, religious: 30, political: 0, mercantile: 0, arcane: 30, "noble house": 0, cult: 60, tribe: 0, gang: 0, undead: 100, nature: 0, resistance: 0, government: 0 },
      fiend:       { military: 20, criminal: 30, religious: 20, political: 0, mercantile: 0, arcane: 30, "noble house": 0, cult: 80, tribe: 0, gang: 0, undead: 40, nature: 0, resistance: 0, government: 0 },
      fey:         { military: 0, criminal: 20, religious: 30, political: 20, mercantile: 20, arcane: 50, "noble house": 20, cult: 30, tribe: 40, gang: 0, undead: 0, nature: 80, resistance: 30, government: 20 },
      giant:       { military: 40, criminal: 10, religious: 20, political: 10, mercantile: 10, arcane: 10, "noble house": 10, cult: 10, tribe: 80, gang: 20, undead: 0, nature: 20, resistance: 10, government: 10 },
      dragon:      { military: 20, criminal: 20, religious: 10, political: 20, mercantile: 20, arcane: 40, "noble house": 20, cult: 50, tribe: 10, gang: 0, undead: 0, nature: 10, resistance: 10, government: 10 },
      aberration:  { military: 0, criminal: 0, religious: 10, political: 0, mercantile: 0, arcane: 40, "noble house": 0, cult: 70, tribe: 0, gang: 0, undead: 0, nature: 0, resistance: 0, government: 0 },
      celestial:   { military: 40, criminal: 0, religious: 80, political: 20, mercantile: 0, arcane: 30, "noble house": 0, cult: 0, tribe: 0, gang: 0, undead: 0, nature: 30, resistance: 40, government: 20 },
      elemental:   { military: 10, criminal: 0, religious: 20, political: 0, mercantile: 0, arcane: 50, "noble house": 0, cult: 40, tribe: 0, gang: 0, undead: 0, nature: 40, resistance: 0, government: 0 },
      monstrosity: { military: 10, criminal: 0, religious: 0, political: 0, mercantile: 0, arcane: 10, "noble house": 0, cult: 20, tribe: 30, gang: 0, undead: 0, nature: 30, resistance: 0, government: 0 },
      construct:   { military: 10, criminal: 0, religious: 0, political: 0, mercantile: 0, arcane: 40, "noble house": 0, cult: 10, tribe: 0, gang: 0, undead: 0, nature: 0, resistance: 0, government: 0 },
      tribal_humanoid:   { military: 30, criminal: 40, religious: 20, political: 5, mercantile: 0, arcane: 10, "noble house": 0, cult: 50, tribe: 90, gang: 60, undead: 10, nature: 30, resistance: 10, government: 0 },
      criminal_humanoid: { military: 20, criminal: 90, religious: 10, political: 10, mercantile: 40, arcane: 10, "noble house": 0, cult: 20, tribe: 10, gang: 90, undead: 0, nature: 5, resistance: 20, government: 5 },
      cult_humanoid:     { military: 10, criminal: 20, religious: 90, political: 10, mercantile: 5, arcane: 40, "noble house": 0, cult: 95, tribe: 10, gang: 10, undead: 30, nature: 10, resistance: 10, government: 0 },
    };

    const BASE_TO_AFFINITY = {
      goblin: "tribal_humanoid", kobold: "tribal_humanoid", orc: "tribal_humanoid",
      gnoll: "tribal_humanoid", lizardfolk: "tribal_humanoid", bugbear: "tribal_humanoid",
      hobgoblin: "tribal_humanoid", troglodyte: "tribal_humanoid", bullywug: "tribal_humanoid",
      bandit: "criminal_humanoid", thug: "criminal_humanoid", pirate: "criminal_humanoid",
      assassin: "criminal_humanoid", spy: "criminal_humanoid", smuggler: "criminal_humanoid",
      cultist: "cult_humanoid", acolyte: "cult_humanoid", fanatic: "cult_humanoid",
    };

    const affinityKey = BASE_TO_AFFINITY[creatureBase.toLowerCase()] || creatureType;
    const affinityRow = AFFINITY[affinityKey] || AFFINITY[creatureType] || AFFINITY.humanoid;
    const fType = (f.type || "organization").toLowerCase();
    const affinity = affinityRow[fType] ?? 40;
    if (affinity === 0) return -1;

    const fDesc = ((f.description || "") + " " + (f.purpose || "") + " " + (f.goals || "")).toLowerCase();
    const baseLower = creatureBase.toLowerCase();
    const actorName = (actor?.name || "").toLowerCase();

    // ── HARD EXCLUSION 2: Existing type-specific exclusions ──
    const affinityOverride = BASE_TO_AFFINITY[baseLower];
    if (affinityOverride === "tribal_humanoid") {
      if (new Set(["political", "noble house", "government", "mercantile"]).has(fType) && !fDesc.includes(baseLower)) return -1;
    }
    if (creatureType === "undead" || creatureType === "fiend") {
      if (new Set(["tribe", "tribal", "nature", "resistance", "knightly_order"]).has(fType) && !fDesc.includes("undead") && !fDesc.includes("fiend") && !fDesc.includes("death") && !fDesc.includes("fallen")) return -1;
      const GOOD_KEYWORDS = /\b(protect(?:ing)? innocents|oppose(?:s|ing)? evil|holy|righteous|defend(?:ing)? the weak|sacred oath|divine justice|vanquish(?:ing)? darkness|purge(?:s|ing)? undead)\b/i;
      if (GOOD_KEYWORDS.test(fDesc)) return -1;
      if (fType === "secret_society" && /\b(monitor|infiltrat|freedom fighter|oppose|resist)\b/i.test(fDesc)) return -1;
    }
    if (affinity < 15) return -1;

    // ── HARD EXCLUSION 3: Alignment opposites ──
    const actorAlignment = (actor?.system?.details?.alignment || "").toLowerCase();
    const factionAlignment = (f.alignment || f.goals || f.purpose || "").toLowerCase();
    if (actorAlignment && factionAlignment) {
      const actorGood = /\bgood\b/.test(actorAlignment);
      const actorEvil = /\bevil\b/.test(actorAlignment);
      const actorLawful = /\blawful\b/.test(actorAlignment);
      const actorChaotic = /\bchaotic\b/.test(actorAlignment);
      // Only hard-exclude from faction alignment if faction has an explicit alignment field
      if (f.alignment) {
        const facAlign = f.alignment.toLowerCase();
        if (actorGood && /\bevil\b/.test(facAlign)) return -1;
        if (actorEvil && /\bgood\b/.test(facAlign)) return -1;
        if (actorLawful && /\bchaotic\b/.test(facAlign)) return -1;
        if (actorChaotic && /\blawful\b/.test(facAlign)) return -1;
      }
    }

    // ── HARD EXCLUSION 4: CR vs faction tier ──
    const cr = Number(actor?.system?.details?.cr ?? 0);
    const tierText = ((f.tier || "") + " " + (f.type || "") + " " + (f.purpose || "")).toLowerCase();
    if (cr <= 1 && /\b(legendary|mythic|planar|arch-?(devil|fey|lich)|god[\s-]?tier)\b/i.test(tierText)) return -1;

    // ══════════════════════════════════════════════════════════════════
    // SCORING: start with affinity, add bonuses for matches
    // ══════════════════════════════════════════════════════════════════
    let score = affinity;

    // Bonus: creature base appears in faction description (e.g., "mongrelfolk" in Belview Clan)
    if (fDesc.includes(baseLower)) score += 50;
    if (fNameLower.includes(baseLower)) score += 70;

    // Bonus: creature SUBTYPE match (e.g., Mishka Belview's subtype is "mongrelfolk")
    const subtypeLower = (creatureSubtype || "").toLowerCase().trim();
    if (subtypeLower && subtypeLower.length >= 4) {
      if (fNameLower.includes(subtypeLower)) score += 100; // direct name match is strongest signal
      else if (fDesc.includes(subtypeLower)) score += 60;
    }

    // Bonus: creature type exact match in faction name/description
    if (creatureType && fDesc.includes(creatureType)) score += 15;

    // Bonus: actor's name/surname matches faction name or description
    // E.g., "Mishka Belview" → "Belview Clan" faction
    const nameParts = actorName.split(/\s+/).filter(p => p.length >= 4);
    for (const part of nameParts) {
      if (fNameLower.includes(part)) { score += 90; break; }
      if (fDesc.includes(part)) { score += 35; break; }
    }

    // Bonus: alignment match (soft compatibility)
    if (actorAlignment && f.alignment) {
      const facAlign = f.alignment.toLowerCase();
      if ((/\bgood\b/.test(actorAlignment) && /\bgood\b/.test(facAlign)) ||
          (/\bevil\b/.test(actorAlignment) && /\bevil\b/.test(facAlign)) ||
          (/\bneutral\b/.test(actorAlignment) && /\bneutral\b/.test(facAlign))) score += 25;
      if ((/\blawful\b/.test(actorAlignment) && /\blawful\b/.test(facAlign)) ||
          (/\bchaotic\b/.test(actorAlignment) && /\bchaotic\b/.test(facAlign))) score += 15;
    }

    // Bonus/Penalty: region proximity
    const sceneRegion = (sceneIntel?.region || sceneIntel?._regionId || "").toLowerCase();
    const factionRegion = (f.region || f._regionId || f._source || "").toLowerCase();
    if (sceneRegion && factionRegion) {
      if (factionRegion.includes(sceneRegion) || sceneRegion.includes(factionRegion)) score += 30;
      else score -= 15; // penalty for foreign, not exclude (wildcard still possible)
    }

    // Bonus: scene canonical factions (already localized, boost them)
    if (f._sceneCanonical) score += 20;

    // Penalty: very generic faction names (likely low quality extractions)
    if (fNameRaw.length < 6 || fNameLower === fType) score -= 20;

    return score;
}

// ─── LEGACY FACTION ASSIGNMENT DIALOG ────────────────────────────────────────
// Kept as fallback. New code uses showNpcIdentityDialog above.

/**
 * Show the GM a dialog to assign a token to an existing faction or create a new one.
 * @param {TokenDocument} tokenDoc
 * @param {FactionData[]} existingFactions — matching factions for this creature type
 * @param {string} creatureBase
 * @returns {Promise<{ factionId: string, isNew: boolean, role: string } | null>} — null if cancelled
 */
export async function showFactionAssignDialog(tokenDoc, existingFactions, creatureBase, sceneIntel = null) {
    const actor = tokenDoc.actor;
    const sceneName = canvas.scene?.name || "Unknown Scene";
    const template = getTemplate(creatureBase);

    return new Promise((resolve) => {
        // ══════════════════════════════════════════════════════════════
        // SMART FACTION SCORING — ranks factions by relevance
        // ══════════════════════════════════════════════════════════════
        const creatureType = (tokenDoc.actor?.system?.details?.type?.value || "humanoid").toLowerCase();
        const creatureSubtype = (tokenDoc.actor?.system?.details?.type?.subtype || "").toLowerCase();
        const actorNameLower = (tokenDoc.actor?.name || "").toLowerCase();

        // ── Affinity matrix: creature type × faction type → 0-100 ──
        // Zero = hard exclude (never show)
        const AFFINITY = {
          humanoid:    { military: 80, criminal: 80, religious: 80, political: 80, mercantile: 80, arcane: 70, "noble house": 70, cult: 80, tribe: 70, gang: 80, undead: 40, nature: 60, resistance: 70, government: 80 },
          undead:      { military: 20, criminal: 10, religious: 30, political: 0, mercantile: 0, arcane: 30, "noble house": 0, cult: 60, tribe: 0, gang: 0, undead: 100, nature: 0, resistance: 0, government: 0 },
          fiend:       { military: 20, criminal: 30, religious: 20, political: 0, mercantile: 0, arcane: 30, "noble house": 0, cult: 80, tribe: 0, gang: 0, undead: 40, nature: 0, resistance: 0, government: 0 },
          fey:         { military: 0, criminal: 20, religious: 30, political: 20, mercantile: 20, arcane: 50, "noble house": 20, cult: 30, tribe: 40, gang: 0, undead: 0, nature: 80, resistance: 30, government: 20 },
          giant:       { military: 40, criminal: 10, religious: 20, political: 10, mercantile: 10, arcane: 10, "noble house": 10, cult: 10, tribe: 80, gang: 20, undead: 0, nature: 20, resistance: 10, government: 10 },
          dragon:      { military: 20, criminal: 20, religious: 10, political: 20, mercantile: 20, arcane: 40, "noble house": 20, cult: 50, tribe: 10, gang: 0, undead: 0, nature: 10, resistance: 10, government: 10 },
          aberration:  { military: 0, criminal: 0, religious: 10, political: 0, mercantile: 0, arcane: 40, "noble house": 0, cult: 70, tribe: 0, gang: 0, undead: 0, nature: 0, resistance: 0, government: 0 },
          celestial:   { military: 40, criminal: 0, religious: 80, political: 20, mercantile: 0, arcane: 30, "noble house": 0, cult: 0, tribe: 0, gang: 0, undead: 0, nature: 30, resistance: 40, government: 20 },
          elemental:   { military: 10, criminal: 0, religious: 20, political: 0, mercantile: 0, arcane: 50, "noble house": 0, cult: 40, tribe: 0, gang: 0, undead: 0, nature: 40, resistance: 0, government: 0 },
          monstrosity: { military: 10, criminal: 0, religious: 0, political: 0, mercantile: 0, arcane: 10, "noble house": 0, cult: 20, tribe: 30, gang: 0, undead: 0, nature: 30, resistance: 0, government: 0 },
          construct:   { military: 10, criminal: 0, religious: 0, political: 0, mercantile: 0, arcane: 40, "noble house": 0, cult: 10, tribe: 0, gang: 0, undead: 0, nature: 0, resistance: 0, government: 0 },
          // ── Creature-base override profiles (humanoid subtypes) ──
          tribal_humanoid:   { military: 30, criminal: 40, religious: 20, political: 5,  mercantile: 0,  arcane: 10, "noble house": 0,  cult: 50, tribe: 90, gang: 60, undead: 10, nature: 30, resistance: 10, government: 0 },
          criminal_humanoid: { military: 20, criminal: 90, religious: 10, political: 10, mercantile: 40, arcane: 10, "noble house": 0,  cult: 20, tribe: 10, gang: 90, undead: 0,  nature: 5,  resistance: 20, government: 5 },
          cult_humanoid:     { military: 10, criminal: 20, religious: 90, political: 10, mercantile: 5,  arcane: 40, "noble house": 0,  cult: 95, tribe: 10, gang: 10, undead: 30, nature: 10, resistance: 10, government: 0 },
        };

        // ── Creature base → affinity profile override ──
        // Tribal, criminal, and cult humanoids use specialized profiles instead of generic humanoid
        const BASE_TO_AFFINITY = {
          goblin: "tribal_humanoid", kobold: "tribal_humanoid", orc: "tribal_humanoid",
          gnoll: "tribal_humanoid", lizardfolk: "tribal_humanoid", bugbear: "tribal_humanoid",
          hobgoblin: "tribal_humanoid", troglodyte: "tribal_humanoid", bullywug: "tribal_humanoid",
          grung: "tribal_humanoid", sahuagin: "tribal_humanoid",
          bandit: "criminal_humanoid", thug: "criminal_humanoid", pirate: "criminal_humanoid",
          assassin: "criminal_humanoid", spy: "criminal_humanoid", smuggler: "criminal_humanoid",
          cultist: "cult_humanoid", acolyte: "cult_humanoid", fanatic: "cult_humanoid",
        };

        // Sentient undead blend: 60% undead + 40% humanoid
        const SENTIENT_UNDEAD = new Set(["vampire", "vampire spawn", "death knight", "lich", "mummy lord", "revenant", "wight", "wraith"]);

        // creatureBase → faction type semantic mapping
        const BASE_TO_FACTION_TYPE = {
          guard: ["military", "political", "government"], soldier: ["military"], knight: ["military", "noble house"],
          veteran: ["military"], warlord: ["military"], captain: ["military"],
          bandit: ["criminal", "gang"], thief: ["criminal", "gang"], assassin: ["criminal"],
          spy: ["criminal"], rogue: ["criminal", "gang"], smuggler: ["criminal"],
          cultist: ["cult", "religious"], acolyte: ["religious", "cult"], priest: ["religious"],
          fanatic: ["cult"], cleric: ["religious"],
          mage: ["arcane"], wizard: ["arcane"], archmage: ["arcane"], apprentice: ["arcane"],
          merchant: ["mercantile", "political"], trader: ["mercantile"], commoner: ["political", "government"],
          noble: ["noble house", "political", "government"],
          goblin: ["tribe", "military", "gang"], orc: ["tribe", "military"], hobgoblin: ["military", "tribe"],
          bugbear: ["tribe", "criminal"], gnoll: ["tribe"], kobold: ["tribe"],
          druid: ["nature"], ranger: ["nature", "resistance"],
          skeleton: ["undead"], zombie: ["undead"],
        };

        // Generic civilian set — boost locality for these
        const GENERIC_CIVILIAN = new Set(["commoner", "noble", "merchant", "trader", "villager", "peasant", "townsfolk"]);
        const isGenericCivilian = GENERIC_CIVILIAN.has(creatureBase.toLowerCase());

        // Weights (adjust for civilians)
        const W_LOCALITY  = isGenericCivilian ? 0.45 : 0.35;
        const W_AFFINITY  = 0.25;
        const W_TYPEFIT   = isGenericCivilian ? 0.10 : 0.20;
        const W_SCOPE     = 0.10;
        const W_NAMEHINT  = 0.10;

        function _scoreFaction(f) {
          // ── Locality ──
          let locality = 10;
          const via = (f._matchedVia || "").toLowerCase();
          if (via.startsWith("city:")) locality = 100;
          else if (via.startsWith("geo:")) locality = 95;
          else if (via.startsWith("region:")) locality = 70;
          else if (via.startsWith("nation:")) locality = 50;
          else if (via === "global") locality = (f.scope === "continental" || f.scope === "global") ? 25 : 15;
          // HQ bonus
          const sceneLocation = (sceneIntel?.location || sceneName || "").toLowerCase();
          if (f.headquarters && sceneLocation.includes((f.headquarters || "").toLowerCase())) locality = Math.min(locality + 15, 100);

          // ── Affinity (creature type × faction type) ──
          // Creature-base overrides: tribal, criminal, and cult humanoids get specialized profiles
          const affinityKey = BASE_TO_AFFINITY[creatureBase.toLowerCase()] || creatureType;
          let affinityRow = AFFINITY[affinityKey] || AFFINITY[creatureType] || AFFINITY.humanoid;
          // Sentient undead blend
          if (creatureType === "undead" && SENTIENT_UNDEAD.has(creatureBase.toLowerCase())) {
            const undeadRow = AFFINITY.undead;
            const humanRow = AFFINITY.humanoid;
            affinityRow = {};
            for (const key of Object.keys(undeadRow)) {
              affinityRow[key] = Math.round((undeadRow[key] ?? 0) * 0.6 + (humanRow[key] ?? 0) * 0.4);
            }
          }
          const fType = (f.type || "organization").toLowerCase();
          let affinity = affinityRow[fType] ?? 40; // default 40 for unrecognized faction types
          if (affinity === 0) return -1; // HARD EXCLUDE

          // ── TypeFit (creatureBase role → faction purpose) ──
          let typeFit = 0;
          const fDesc = ((f.description || "") + " " + (f.purpose || "")).toLowerCase();
          const baseLower = creatureBase.toLowerCase();

          // ── Hard exclusion: creature-base incompatible factions ──
          // Tribal creatures should never be recommended for civilized institutions
          // unless the faction description explicitly mentions the creature type.
          const affinityOverride = BASE_TO_AFFINITY[baseLower];
          if (affinityOverride === "tribal_humanoid") {
            const TRIBAL_EXCLUDE = new Set(["political", "noble house", "government", "mercantile"]);
            if (TRIBAL_EXCLUDE.has(fType) && !fDesc.includes(baseLower)) return -1;
          } else if (affinityOverride === "criminal_humanoid") {
            if (fType === "religious" && !fDesc.includes("cult") && !fDesc.includes("criminal")) return -1;
          }
          // Undead/fiend hard exclusions — these don't join good-aligned or nature factions
          // Note: World Bible uses "tribal" while FACTION_TEMPLATES use "tribe" — match both
          if (creatureType === "undead" || creatureType === "fiend") {
            const UNDEAD_FIEND_EXCLUDE = new Set(["tribe", "tribal", "nature", "resistance", "knightly_order"]);
            if (UNDEAD_FIEND_EXCLUDE.has(fType) && !fDesc.includes("undead") && !fDesc.includes("fiend") && !fDesc.includes("death") && !fDesc.includes("fallen")) return -1;
            // Also exclude factions whose description/purpose signals good alignment
            const GOOD_KEYWORDS = /\b(protect(?:ing)? innocents|oppose(?:s|ing)? evil|holy|righteous|defend(?:ing)? the weak|sacred oath|divine justice|vanquish(?:ing)? darkness|purge(?:s|ing)? undead)\b/i;
            if (GOOD_KEYWORDS.test(fDesc)) return -1;
            // Exclude secret societies that monitor/oppose evil (Harpers, Keepers of the Feather)
            if (fType === "secret_society" && /\b(monitor|infiltrat|freedom fighter|oppose|resist)\b/i.test(fDesc)) return -1;
          }
          // Universal: affinity too low = not worth showing
          if (affinity < 15) return -1;
          if (fDesc.includes(baseLower)) {
            typeFit = 100; // creature name in faction description
          } else {
            const mappedTypes = BASE_TO_FACTION_TYPE[baseLower] || [];
            if (mappedTypes.includes(fType)) typeFit = 80;
            else if (mappedTypes.length === 0) typeFit = 20; // unknown creature, small generic score
          }
          // Goblinoid in urban area bonus for criminal/gang
          if (creatureSubtype === "goblinoid" && (fType === "criminal" || fType === "gang")) {
            typeFit = Math.max(typeFit, 60);
          }

          // ── ScopePenalty ──
          let scopeScore = 30;
          const fScope = (f.scope || "regional").toLowerCase();
          if (fScope === "local" && (via.startsWith("city:") || via.startsWith("geo:"))) scopeScore = 100;
          else if (fScope === "local") scopeScore = 70;
          else if (fScope === "regional" && via.startsWith("region:")) scopeScore = 80;
          else if (fScope === "regional") scopeScore = 50;
          else if (fScope === "continental") scopeScore = 40;
          else if (fScope === "global") scopeScore = 30;

          // ── NameHint ──
          let nameHint = 0;
          const fNameLower = (f.name || "").toLowerCase();
          if (actorNameLower.includes(fNameLower) || fNameLower.split(/\s+/).some(w => w.length > 3 && actorNameLower.includes(w))) {
            nameHint = 100;
          } else if (f.leader && actorNameLower.includes((f.leader || "").toLowerCase())) {
            nameHint = 80;
          }

          const score = (locality * W_LOCALITY) + (affinity * W_AFFINITY) + (typeFit * W_TYPEFIT) + (scopeScore * W_SCOPE) + (nameHint * W_NAMEHINT);
          return Math.round(score * 10) / 10;
        }

        // ── Score and filter canonical factions ──
        let canonicalOptions = "";
        const canonicalFactions = sceneIntel?.canonicalFactions ?? [];
        if (canonicalFactions.length > 0) {
            const existingNames = new Set(existingFactions.map(f => (f.name || "").toLowerCase()));
            let scored = canonicalFactions
                .map((f, i) => ({ ...f, _idx: i, _finalScore: _scoreFaction(f) }))
                .filter(f => !existingNames.has((f.name || "").toLowerCase()))
                .filter(f => f._finalScore > 0)  // Remove hard-excluded (affinity=0)
                .filter(f => f._finalScore >= 20) // Remove irrelevant low-scorers
                .sort((a, b) => b._finalScore - a._finalScore);

            // Tier A: top 3, expand to 5 if #4/#5 are within 15 of #3
            let tierACut = Math.min(3, scored.length);
            if (scored.length > 3 && scored[2]) {
              const threshold = scored[2]._finalScore - 15;
              while (tierACut < 5 && tierACut < scored.length && scored[tierACut]._finalScore >= threshold) tierACut++;
            }
            const tierA = scored.slice(0, tierACut);
            const tierB = scored.slice(tierACut);

            if (tierA.length > 0) {
                canonicalOptions = `
                <div style="margin: 8px 0 4px; padding: 4px 0; border-bottom: 1px solid rgba(212,175,55,0.3);">
                    <strong style="color: #d4af37;">📖 Recommended</strong>
                    <small style="opacity: 0.6; margin-left: 6px;">(${sceneIntel.location || sceneName})</small>
                </div>`;
                const firstCanonChecked = existingFactions.length === 0 ? 'checked' : '';
                canonicalOptions += tierA.map((f, i) => {
                    const checked = (i === 0 && existingFactions.length === 0) ? firstCanonChecked : "";
                    return `
                    <div class="ace-faction-option" style="margin: 4px 0; padding: 6px; background: rgba(212,175,55,0.08); border-radius: 4px; border-left: 3px solid #d4af37;">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="radio" name="factionChoice" value="__canonical__:${f._idx}" ${checked}>
                            <div>
                                <strong>${f.name}</strong> <span style="opacity: 0.6;">(${f.type})</span>
                                <span style="color: #d4af37; font-size: 1em; font-weight:600;"> 🌍 World Bible</span>
                                ${f.leader ? `<br><small style="opacity: 0.7;">Led by ${f.leader}</small>` : ""}
                                ${f.description ? `<br><small style="opacity: 0.5;">${f.description.slice(0, 80)}</small>` : ""}
                            </div>
                        </label>
                    </div>`;
                }).join("");
            }

            // Tier B: collapsed "Show more..."
            if (tierB.length > 0) {
                const moreId = `ace-faction-more-${Date.now()}`;
                canonicalOptions += `
                <div style="margin: 6px 0 2px; text-align: center;">
                    <a href="#" onclick="document.getElementById('${moreId}').style.display = document.getElementById('${moreId}').style.display === 'none' ? 'block' : 'none'; this.textContent = this.textContent.includes('Show') ? 'Hide ${tierB.length} more' : 'Show ${tierB.length} more...'; return false;"
                       style="color: #d4af37; font-size: 1em; font-weight:600;">Show ${tierB.length} more...</a>
                </div>
                <div id="${moreId}" style="display: none;">`;
                canonicalOptions += tierB.slice(0, 15).map(f => `
                    <div class="ace-faction-option" style="margin: 3px 0; padding: 4px 6px; background: rgba(255,255,255,0.03); border-radius: 3px; border-left: 2px solid rgba(212,175,55,0.3);">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; opacity: 0.8;">
                            <input type="radio" name="factionChoice" value="__canonical__:${f._idx}">
                            <div>
                                <strong style="font-size: 1.05em;">${f.name}</strong> <span style="opacity: 0.5; font-size: 1em;">(${f.type})</span>
                                ${f.leader ? ` <small style="opacity: 0.5;">— ${f.leader}</small>` : ""}
                            </div>
                        </label>
                    </div>`).join("");
                canonicalOptions += `</div>`;
            }
        }

        // ── Build existing faction radio options ──
        let existingHeader = "";
        if (existingFactions.length > 0 && canonicalOptions) {
            existingHeader = `
            <div style="margin: 8px 0 4px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.15);">
                <strong>Existing Scene Factions</strong>
            </div>`;
        }
        let factionOptions = existingFactions.map((f, i) => {
            const memberCount = f.members?.length || 0;
            const checked = (i === 0 && !canonicalOptions) ? "checked" : "";
            // Show family relationship hint if faction belongs to a different creature base
            const isFamilyMatch = (f.creatureBase || "").toLowerCase() !== creatureBase.toLowerCase();
            const familyHint = isFamilyMatch
                ? ` <span style="color: #d4af37; font-style: italic;">— same family as ${f.creatureBase}s</span>`
                : "";
            return `
                <div class="ace-faction-option" style="margin: 4px 0; padding: 6px; background: rgba(255,255,255,0.05); border-radius: 4px;">
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="radio" name="factionChoice" value="${f.id}" ${checked}>
                        <div>
                            <strong>${f.name}</strong> <span style="opacity: 0.6;">(${f.type} — ${memberCount} member${memberCount !== 1 ? "s" : ""})</span>${familyHint}
                            ${f.leader ? `<br><small style="opacity: 0.7;">Led by ${f.leader}</small>` : ""}
                        </div>
                    </label>
                </div>`;
        }).join("");

        // Add "New Faction" and "No Faction" options
        const noExisting = existingFactions.length === 0 && !canonicalOptions;
        factionOptions += `
            <div class="ace-faction-option" style="margin: 4px 0; padding: 6px; background: rgba(255,255,255,0.05); border-radius: 4px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                    <input type="radio" name="factionChoice" value="__new__" ${noExisting ? "checked" : ""}>
                    <div>
                        <strong>✨ Generate New Faction</strong>
                        <br><small style="opacity: 0.7;">AI will create a new ${template.type} for ${creatureBase}s in ${sceneName}</small>
                    </div>
                </label>
            </div>
            <div class="ace-faction-option" style="margin: 4px 0; padding: 6px; background: rgba(255,255,255,0.05); border-radius: 4px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                    <input type="radio" name="factionChoice" value="__none__">
                    <div>
                        <strong>🚫 No Faction</strong>
                        <br><small style="opacity: 0.7;">This NPC is a loner with no group affiliation</small>
                    </div>
                </label>
            </div>`;

        // Optional role field
        const roleField = `
            <hr style="margin: 8px 0; border-color: rgba(255,255,255,0.1);">
            <div style="margin-top: 4px;">
                <label><strong>Role</strong> <small style="opacity: 0.6;">(optional — e.g. "bartender", "patrol leader", "patron")</small></label>
                <input type="text" name="factionRole" value="" placeholder="Leave blank for AI to decide" autocomplete="off" data-lpignore="true" data-1p-ignore="true" style="width: 100%; margin-top: 4px;">
            </div>`;

        // Scene intelligence location hint
        const locationHint = sceneIntel?.location
            ? ` <small style="opacity: 0.5;">— ${sceneIntel.region ? sceneIntel.region + ", " : ""}${sceneIntel.location}</small>`
            : "";

        const content = `
            <div style="overflow-y: auto; padding: 4px; height: 100%;">
                <p style="margin-bottom: 8px;">
                    <strong>${actor.name}</strong> (${creatureBase}) dropped on <strong>${sceneName}</strong>.${locationHint}
                    <br>Assign to a faction:
                </p>
                ${canonicalOptions}
                ${existingHeader}
                ${factionOptions}
                ${roleField}
            </div>`;

        new Dialog({
            title: `Faction Assignment — ${actor.name}`,
            content,
            buttons: {
                assign: {
                    icon: '<i class="fas fa-users"></i>',
                    label: "Assign",
                    callback: (html) => {
                        const el = html[0] ?? html;
                        const choice = el.querySelector('input[name="factionChoice"]:checked')?.value;
                        const role = el.querySelector('input[name="factionRole"]')?.value?.trim() || "";
                        if (!choice) { resolve(null); return; }
                        if (choice === "__none__") { resolve({ factionId: null, isNew: false, role }); return; }
                        if (choice === "__new__") { resolve({ factionId: null, isNew: true, role }); return; }
                        resolve({ factionId: choice, isNew: false, role });
                    }
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Skip",
                    callback: () => resolve(null),
                }
            },
            default: "assign",
            close: () => resolve(null),
        }, { width: 450, resizable: true, height: "auto" }).render(true);
    });
}

// ─── SMART SETUP: AI-POWERED FACTION RECOMMENDATIONS ────────────────────────

/**
 * Ask the AI to recommend 3 ranked faction options for a creature being placed.
 * Falls back to data-driven suggestions if AI fails.
 */
async function recommendFactions(actor, creatureBase, template, sceneName, worldTag, matching, sceneIntel, worldDigestFactions) {
    const { provider, apiKey } = getEnvoyAIConfig();

    // Build context about what factions already exist
    // ⚠️ NOTHING THAT IS NOT A FACTION REACHES THE MODEL. "Goblinoids" and
    // "Evil-Aligned Factions" are sourcebook index entries that got imported as
    // if they were organisations. Offered as an allegiance they are noise, and
    // once the model sees one in the list it will happily recommend it.
    const _real = (list) => (list || []).filter(f => !isNotARealFaction(f));
    const _matching = _real(matching);
    const _canon    = _real(sceneIntel?.canonicalFactions);
    const _digest   = _real(worldDigestFactions).slice(0, 8);

    const existingList = _matching.map(f => `• "${f.name}" (${f.type}) — ${f.purpose || "no description"}`).join("\n");
    const canonList = _canon.map(f => `• "${f.name}" (${f.type || "faction"}) — ${f.description || ""}`).join("\n");
    const digestList = _digest.map(f => `• "${f.name}" (${f.type || "faction"}) — ${f.purpose || f.description || ""}`).join("\n");

    const cr = actor.system?.details?.cr ?? "?";
    const alignment = actor.system?.details?.alignment || "unknown";
    const creatureType = actor.system?.details?.type?.value || "unknown";

    // ── Scene Intelligence context ──
    let locationContext = "";
    try {
        const digestCtx = EngineBridge.digestLookupContext(sceneName, { maxChars: 800 });
        if (digestCtx.length > 20) locationContext += `\nLOCATION INTEL:\n${digestCtx}`;
        const intelPrompt = await EngineBridge.getSceneIntelligencePrompt(sceneName, null, creatureBase);
        if (intelPrompt) locationContext += `\nSCENE INTEL:\n${intelPrompt}`;
    } catch (err) { console.warn(`${TAG} | recommendFactions location context failed (non-fatal):`, err); }

    const systemPrompt = `You are a D&D 5e world-builder analyzing an NPC being placed on the battlefield.
Given the creature type, scene context, and known factions, suggest exactly 3 ranked faction assignments.

RULES:
- CHOOSE ONLY FROM THE FACTIONS LISTED BELOW. Do NOT invent a faction. Do NOT
  suggest a name that does not appear in the lists. If nothing fits well, say so
  by choosing the closest options anyway and explaining the stretch in the reason.
- Option 1 should be the BEST match of the ones listed
- Option 2 should be an interesting ALTERNATIVE from the list (a rival, a
  different allegiance, something that adds tension)
- Option 3 should be a third option from the list, or "No Faction" if only two fit
- Each option needs a NAME copied EXACTLY as it appears in the list, and a
  1-sentence REASON explaining why this creature might belong there
- Keep reasons SHORT (under 25 words)

Respond in EXACTLY this format (3 lines, no extra text):
1. [faction name] | [reason]
2. [faction name] | [reason]
3. [faction name] | [reason]`;

    const userMsg = `Creature: ${actor.name} (${creatureType}, CR ${cr}, ${alignment})
Creature base: ${creatureBase}
Faction archetype: ${template.type} (${template.structure})
Scene: ${sceneName}
World: ${worldTag || "Unknown"}
${existingList ? `\nEXISTING FACTIONS for ${creatureBase}s:\n${existingList}` : `\nNo existing factions for ${creatureBase}s yet.`}
${canonList ? `\nCANONICAL FACTIONS (from source material):\n${canonList}` : ""}
${digestList ? `\nWORLD FACTIONS (from campaign lore):\n${digestList}` : ""}
${locationContext}`;

    try {
        const Handler = await _getAIHandler();
        const response = await Handler.callAI(systemPrompt, [], userMsg, provider, apiKey, [], { context: "faction-naming" });
        if (isAIFailure(response)) throw new Error("AI unavailable — using fallback recommendations");
        const parsed = _parseRecommendations(response, matching, sceneIntel, worldDigestFactions);
        // ⚠️ PAD, DO NOT DISCARD. Requiring exactly three threw away two good
        // recommendations whenever the model offered one invented name, and fell
        // all the way back to raw data. Keep what was real, fill the rest.
        if (parsed.length) {
            const filler = _fallbackRecommendations(matching, sceneIntel, worldDigestFactions, creatureBase, template);
            const have = new Set(parsed.map(r => String(r.name).toLowerCase()));
            for (const f of filler) {
                if (parsed.length >= 3) break;
                if (have.has(String(f.name).toLowerCase())) continue;
                have.add(String(f.name).toLowerCase());
                parsed.push(f);
            }
            return parsed.slice(0, 3);
        }
    } catch (err) {
        console.warn(`${TAG} | AI faction recommendation failed (using fallback):`, err);
    }

    // ── Fallback: data-driven suggestions ──
    return _fallbackRecommendations(matching, sceneIntel, worldDigestFactions, creatureBase, template);
}

/**
 * Parse AI response into 3 recommendation objects.
 */
function _parseRecommendations(response, matching, sceneIntel, worldDigestFactions) {
    const lines = response.trim().split("\n").filter(l => /^\d+\.\s/.test(l.trim()));
    const results = [];
    for (const line of lines.slice(0, 3)) {
        const cleaned = line.replace(/^\d+\.\s*/, "").trim();
        const parts = cleaned.split("|");
        const name = (parts[0] || "").trim();
        const reason = (parts[1] || "").trim();
        if (!name) continue;

        // Check if this matches an existing faction
        const existingMatch = matching.find(f => f.name.toLowerCase() === name.toLowerCase());
        if (existingMatch) {
            results.push({ name: existingMatch.name, reason, source: "existing", factionId: existingMatch.id });
            continue;
        }
        // Check canonical factions
        const canonIdx = (sceneIntel?.canonicalFactions || []).findIndex(f => f.name.toLowerCase() === name.toLowerCase());
        if (canonIdx >= 0) {
            results.push({ name: sceneIntel.canonicalFactions[canonIdx].name, reason, source: "canonical", canonIdx });
            continue;
        }
        // Check world digest factions
        const worldIdx = (worldDigestFactions || []).findIndex(f => f.name.toLowerCase() === name.toLowerCase());
        if (worldIdx >= 0) {
            results.push({ name: worldDigestFactions[worldIdx].name, reason, source: "world_digest", worldIdx });
            continue;
        }
        // ⚠️🔴 A NAME THAT IS NOT IN THE REGISTRY IS DISCARDED, NOT INVENTED.
        //
        // The prompt now forbids inventing a faction, and a model can ignore a
        // prompt. Johnny, 2026-08-22: "everything from now on is going to have
        // to belong to whatever factions we have available." That is a rule
        // about what ACE DOES, so it is enforced where the answer is read, not
        // where the request is written.
        //
        // Asking nicely and hoping is the same mistake as the elf who folded his
        // arms defiantly at an order he was not supposed to understand: don't
        // send it > gate in code > ask nicely, and the last one fails silently.
        console.log(`${TAG} | The recommender offered "${name}", which is not in the registry. Discarded — ACE does not invent factions unasked.`);
    }
    return results;
}

/**
 * Fallback when AI recommendation fails — build 3 options from raw data.
 */
/** The nth canonical faction, shaped like the rows this function returns. */
function _canonAt(sceneIntel, idx) {
    const f = (sceneIntel?.canonicalFactions || []).filter(x => !isNotARealFaction(x))[idx];
    return f ? { name: f.name, canonIdx: idx } : null;
}

function _fallbackRecommendations(matching, sceneIntel, worldDigestFactions, creatureBase, template) {
    // ⚠️ The same filter the AI path uses. A fallback that offers rows the
    // main path rejects is not a fallback, it is a second set of rules.
    matching = (matching || []).filter(f => !isNotARealFaction(f));
    const results = [];

    // Option 1: first matching existing faction
    if (matching.length > 0) {
        results.push({ name: matching[0].name, reason: `Existing ${template.type} for ${creatureBase}s in this world`, source: "existing", factionId: matching[0].id });
    } else if (sceneIntel?.canonicalFactions?.length) {
        const canon = sceneIntel.canonicalFactions[0];
        results.push({ name: canon.name, reason: `Canonical faction from source material`, source: "canonical", canonIdx: 0 });
    }

    // Option 2: second matching or first canonical/world digest
    if (matching.length > 1) {
        results.push({ name: matching[1].name, reason: `Alternative ${template.type} in this world`, source: "existing", factionId: matching[1].id });
    } else if (sceneIntel?.canonicalFactions?.length > (results.length > 0 ? 0 : 1)) {
        const idx = results.length > 0 && results[0].source === "canonical" ? 1 : 0;
        if (sceneIntel.canonicalFactions[idx]) {
            results.push({ name: sceneIntel.canonicalFactions[idx].name, reason: `From scene source material`, source: "canonical", canonIdx: idx });
        }
    } else {
        // ⚠️ Filtered like everything else — the world digest is exactly where
        // taxonomy entries such as "Goblinoids" come from.
        const wIdx = (worldDigestFactions || []).findIndex(f => !isNotARealFaction(f));
        if (wIdx >= 0) {
            results.push({ name: worldDigestFactions[wIdx].name, reason: `From campaign world lore`, source: "world_digest", worldIdx: wIdx });
        }
    }

    // ⚠️ NO INVENTED FACTION HERE EITHER (2026-08-23). This fallback runs
    // whenever the AI is unavailable, and it used to push "Generate New Faction"
    // as option 3 unconditionally — so turning invention off in one path left it
    // switched on in the path that runs when the AI is down. Johnny: "everything
    // from now on is going to have to belong to whatever factions we have
    // available." Inventing one is still possible, deliberately, from the
    // Customize screen's drop-down; it is no longer offered unasked.
    const third = matching[2] ?? _canonAt(sceneIntel, 2) ?? null;
    if (third) {
        results.push(third.factionId
            ? { name: third.name, reason: `Another ${template.type} in this world`, source: "existing", factionId: third.factionId }
            : { name: third.name, reason: `From scene source material`, source: "canonical", canonIdx: third.canonIdx });
    }
    while (results.length < 3) {
        results.push({ name: "No Faction", reason: `Leave this creature unaffiliated`, source: "none" });
    }

    return results.slice(0, 3);
}

/**
 * Show the AI-powered smart setup dialog with 3 ranked faction suggestions.
 * @returns {Promise<{ choice: "accept"|"customize"|"skip", selectedIndex: number, rename: boolean }|null>}
 */
async function showSmartSetupDialog(actorName, creatureBase, recommendations, creatureType, currentTier) {
    const isNonSentient = new Set(["beast", "ooze", "plant", "swarm"]).has((creatureType || "").toLowerCase());

    // Build radio options HTML — large readable text, gold highlight on selected
    const optionsHtml = recommendations.map((rec, i) => `
        <label class="ace-smart-setup-option" style="display:flex; align-items:flex-start; gap:10px; padding:12px 14px; margin:8px 0; border-radius:6px; cursor:pointer; border:${i === 0 ? "2px solid #222" : "1px solid #bbb"}; background:${i === 0 ? "rgba(212,175,55,0.12)" : "#fafafa"}; box-shadow:${i === 0 ? "0 0 0 1px #d4af37" : "none"};">
            <input type="radio" name="ace-faction-pick" value="${i}" ${i === 0 ? "checked" : ""} style="margin-top:5px; accent-color:#d4af37; width:18px; height:18px;">
            <div style="flex:1;">
                <div style="font-weight:700; color:${i === 0 ? "#8b6914" : "#111"}; font-size:18px;">${i + 1}. ${rec.name}</div>
                <div style="font-size:15px; color:#222; margin-top:4px; line-height:1.5; font-weight:500;">${rec.reason}</div>
            </div>
        </label>`).join("");

    // RENAME defaults CHECKED for sentient NPCs — but that only gives the mob a
    // DISPLAY-ONLY flavor name on the nameplate; the real name is never touched.
    // AUTO-LINK (persist as a NEW sidebar actor, which DOES rename the token's sheet)
    // is OPT-IN — it follows the "Auto-Save NPCs as Persistent Actors" setting, OFF by
    // default, so dropped mobs stay unlinked and keep their real name for the pipeline.
    // Tick it deliberately for a recurring NPC. [2026-06-30 — was hardcoded "checked",
    // which silently converted every dropped token into a renamed linked actor.]
    const renameChecked = isNonSentient ? "" : "checked";
    const renameDisabled = isNonSentient ? "disabled" : "";
    const renameNote = isNonSentient ? " (beasts keep species name)" : "";
    const factionHidden = (currentTier === "bio-only") ? "display:none;" : "";
    let autoLinkChecked = "";
    try { autoLinkChecked = game.settings.get(MODULE_ID, "enableAutoLink") ? "checked" : ""; } catch (_) { autoLinkChecked = ""; }

    const content = `
        <div style="font-family:sans-serif;">
            <div class="ace-smart-faction-section" style="${factionHidden}">
                <p style="color:#222; font-size:16px; font-weight:600; margin:0 0 12px 0;">Based on this creature and the current scene:</p>
                <div class="ace-smart-setup-options" style="margin-bottom:14px;">
                    ${optionsHtml}
                </div>
            </div>
            <hr style="border-color:#ccc; margin:10px 0;">
            <div style="display:flex; align-items:center; gap:14px; margin-bottom:8px; flex-wrap:wrap;">
                <label style="display:flex; align-items:center; gap:8px; font-size:15px; color:#111; font-weight:700; white-space:nowrap;">
                    AI Generation:
                    <select name="ace-drop-tier" style="background:#2a2a2e; color:#d4af37; border:1px solid #555; border-radius:4px; padding:5px 10px; font-size:15px; font-weight:600;">
                        <option value="full" ${currentTier === "full" ? "selected" : ""}>Full</option>
                        <option value="bio-only" ${currentTier === "bio-only" ? "selected" : ""}>Bio Only</option>
                        <option value="faction-only" ${currentTier === "faction-only" ? "selected" : ""}>Faction Only</option>
                    </select>
                </label>
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:15px; color:#111; font-weight:700;">
                    <input type="checkbox" name="ace-rename-toggle" ${renameChecked} ${renameDisabled} style="accent-color:#d4af37; width:18px; height:18px;">
                    Rename NPC${renameNote}
                </label>
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:15px; color:#111; font-weight:700;"
                       title="Save this NPC as a persistent linked actor in the sidebar so the same identity survives across sessions. Leave unchecked for disposable tokens.">
                    <input type="checkbox" name="ace-autolink-toggle" ${autoLinkChecked} style="accent-color:#d4af37; width:18px; height:18px;">
                    Save as persistent NPC
                </label>
            </div>
        </div>`;

    return new Promise(resolve => {
        new Dialog({
            title: `NPC Setup \u2014 ${actorName}`,
            content,
            buttons: {
                accept: {
                    icon: '<i class="fas fa-check"></i>',
                    label: "Accept",
                    callback: (html) => {
                        const idx = parseInt(html.find("input[name='ace-faction-pick']:checked").val(), 10) || 0;
                        const rename = !!html.find("input[name='ace-rename-toggle']").prop("checked");
                        const autoLink = !!html.find("input[name='ace-autolink-toggle']").prop("checked");
                        const tier = html.find("select[name='ace-drop-tier']").val() || currentTier;
                        resolve({ choice: "accept", selectedIndex: idx, rename, autoLink, tier });
                    }
                },
                customize: {
                    icon: '<i class="fas fa-sliders-h"></i>',
                    label: "Customize\u2026",
                    callback: (html) => {
                        const rename = !!html.find("input[name='ace-rename-toggle']").prop("checked");
                        const autoLink = !!html.find("input[name='ace-autolink-toggle']").prop("checked");
                        const tier = html.find("select[name='ace-drop-tier']").val() || currentTier;
                        resolve({ choice: "customize", selectedIndex: 0, rename, autoLink, tier });
                    }
                },
                skip: {
                    icon: '<i class="fas fa-forward"></i>',
                    label: "Skip All",
                    callback: () => resolve({ choice: "skip", selectedIndex: -1, rename: false, autoLink: false, tier: "off" })
                }
            },
            default: "accept",
            close: () => resolve(null),
            render: (html) => {
                // Highlight selected radio option border on change
                html.find("input[name='ace-faction-pick']").on("change", function () {
                    html.find(".ace-smart-setup-option").each(function () {
                        $(this).css({ border: "1px solid #bbb", background: "#fafafa", "box-shadow": "none" });
                        $(this).find("div > div:first-child").css("color", "#222");
                    });
                    const parent = $(this).closest(".ace-smart-setup-option");
                    parent.css({ border: "2px solid #222", background: "rgba(212,175,55,0.12)", "box-shadow": "0 0 0 1px #d4af37" });
                    parent.find("div > div:first-child").css("color", "#8b6914");
                });

                // Show/hide faction section when tier dropdown changes
                html.find("select[name='ace-drop-tier']").on("change", function () {
                    const val = $(this).val();
                    const factionSection = html.find(".ace-smart-faction-section");
                    const customizeBtn = html.closest(".dialog").find("button[data-button='customize']");
                    if (val === "bio-only") {
                        factionSection.slideUp(150);
                        customizeBtn.prop("disabled", true).css("opacity", "0.4");
                    } else {
                        factionSection.slideDown(150);
                        customizeBtn.prop("disabled", false).css("opacity", "1");
                    }
                    // Disable rename for faction-only (no bio = no rename)
                    const renameBox = html.find("input[name='ace-rename-toggle']");
                    if (val === "faction-only") {
                        renameBox.prop("checked", false).prop("disabled", true);
                    } else if (!isNonSentient) {
                        renameBox.prop("disabled", false);
                    }
                });
            }
        }, { width: 420 }).render(true);
    });
}

// ─── MAIN ENTRY: PROCESS TOKEN FOR FACTION ───────────────────────────────────

/**
 * Main entry point: determine faction for a newly dropped token.
 * Called from bio-generator.js during the createToken flow.
 *
 * Flow:
 * 1. Resolve creature base (bandit, goblin, commoner, etc.)
 * 2. Check if matching factions exist for this world/scene
 * 3. First creature of this type → auto-generate faction (no popup)
 * 4. Subsequent creatures → GM popup to pick faction
 * 5. Roll spy chance
 * 6. Store faction assignment on token/actor
 *
 * @param {TokenDocument} tokenDoc
 * @returns {Promise<{ faction: FactionData|null, isSpy: boolean, spyFaction: FactionData|null, role: string }>}
 */
/**
 * Decide a creature's rank inside its faction and record it on the roster.
 *
 * ⚠️ SHARED BY BOTH PATHS ON PURPOSE (2026-08-07). The silent adopt path used
 * to return the moment it found a faction, so it never reached the rank ladder
 * and every silently-dropped creature ended up with an empty role and a null
 * roster — proven live on Johnny's Amberfang goblin. Rank costs nothing: it is
 * read from the statblock, class levels, gear and token, with a weighted roll
 * only as a last resort. There is no reason for a free path to skip it.
 *
 * @returns {Promise<string>} the role label ("" if it could not be decided)
 */
async function _decideAndClaimRole(actor, tokenDoc, faction, factionId, template, creatureBase) {
    if (!actor || !faction || !factionId) return "";
    try {
        const { decideRole, claimRosterSlot, ensureOfficersHarvested } = await import("./faction-roster.mjs");

        // ⚠️ HARVEST BEFORE DECIDING (2026-08-07). A faction records its leader
        // in a field and every other officer in prose — "Their shaman, Zizka the
        // Wise, communes with the spirits". Nothing structured knew about Zizka,
        // so the shaman post read as vacant and the next shaman-shaped creature
        // would have been given a rival name, contradicting the tribe's own
        // history. Reading those officers onto the roster first means the post
        // is held, and a creature that qualifies for it BECOMES that person.
        // Idempotent — a post with an occupant is left alone.
        await ensureOfficersHarvested(factionId, template);
        // Re-read: the harvest above may have just written the roster.
        const freshFaction = getFaction(factionId) ?? faction;

        // Everyone of this faction standing on this scene, so slot capacity and
        // the CR comparison are measured against the actual group.
        const groupActors = [];
        try {
            for (const t of canvas.scene?.tokens ?? []) {
                const a = t.actor;
                if (!a) continue;
                if (a.getFlag?.(MODULE_ID, "factionId") === factionId || t.id === tokenDoc?.id) groupActors.push(a);
            }
        } catch (_) { /* an empty group is a valid answer */ }

        const decided = decideRole({ actor, tokenDoc, faction: freshFaction, template, speciesLabel: creatureBase, groupActors });
        await claimRosterSlot(factionId, decided.slotKey, actor.id, decided.roleLabel, decided.becomesOfficer ?? null);
        if (decided.becomesOfficer?.name) {
            console.log(`${TAG} | ${actor.name} IS ${decided.becomesOfficer.name}, the ${decided.roleLabel} "${freshFaction.name}" already spoke of.`);
        }
        console.log(`${TAG} | ${actor.name} is ${decided.roleLabel} of "${freshFaction.name}" — ${decided.reasons.join("; ")}.`);
        return decided.roleLabel;
    } catch (err) {
        console.warn(`${TAG} | Could not decide a role (the creature still joins the faction):`, err);
        return "";
    }
}

export async function processTokenFaction(tokenDoc, { adoptOnly = false } = {}) {
    const actor = tokenDoc.actor;
    if (!actor) return { faction: null, isSpy: false, spyFaction: null, role: "" };

    // Check if factions are enabled
    try {
        if (!game.settings.get(MODULE_ID, "enableFactions")) {
            return { faction: null, isSpy: false, spyFaction: null, role: "" };
        }
    } catch (err) { console.warn("ACE: Engine | faction-registry enableFactions setting check failed:", err); }

    // Skip if already assigned
    const existingFactionId = actor.getFlag(MODULE_ID, "factionId");
    if (existingFactionId) {
        const existing = getFaction(existingFactionId);
        if (existing) {
            console.log(`${TAG} | ${actor.name} already assigned to "${existing.name}"`);
            return { faction: existing, isSpy: false, spyFaction: null, role: actor.getFlag(MODULE_ID, "factionRole") || "" };
        }
    }

    const creatureBase = resolveCreatureBase(actor);
    const template = getTemplate(creatureBase);
    const worldTag = game.world?.title || "";
    const sceneName = canvas.scene?.name || "Unknown Scene";

    // ── Skip non-sentient creatures entirely ──────────────────────
    // Beasts, oozes, plants, constructs don't join factions.
    const creatureType = (actor.system?.details?.type?.value || "").toLowerCase();
    const SKIP_TYPES = new Set(["beast", "ooze", "plant"]);
    // Constructs skip UNLESS they have a humanoid subtype (animated armor serving a faction)
    if (SKIP_TYPES.has(creatureType) || (creatureType === "construct" && !template.canSpy)) {
      console.log(`${TAG} | ${actor.name} (${creatureType}) — skipping faction assignment (non-sentient)`);
      return { faction: null, isSpy: false, spyFaction: null, role: "" };
    }

    // ── Existing factions for this creature type in this world ─────
    // ⚠️ DECLARED HERE, ABOVE THE AUTO-SCAN BRANCH, ON PURPOSE (2026-08-07).
    // These two used to be declared ~30 lines further down while the silent
    // branch below already read `matching` and wrote `isNew`. In a module that
    // is a temporal-dead-zone ReferenceError — thrown every single time a
    // non-civilian creature arrived by scene auto-scan, which is now the
    // DEFAULT path for every token drop. ESLint's no-use-before-define is what
    // surfaced it; `node --check` cannot see this class of bug. Do not move
    // them back down.
    let isNew = false;

    // ── The proper lookup, loaded once and shared by both paths ────
    // Dynamic import keeps faction-lookup and faction-registry from forming an
    // import cycle (lookup reads the registry's store).
    let _lookup = null;
    let _lookupCtx = null;
    try {
        _lookup = await import("./faction-lookup.mjs");
        let sceneIntelText = "";
        try { sceneIntelText = EngineBridge.digestLookupContext(sceneName, { maxChars: 1500 }) || ""; }
        catch (_) { /* digest is optional context, never a blocker */ }
        _lookupCtx = {
            creatureBase, sceneName, worldTag, template, sceneIntelText,
            factionIdsOnScene: _lookup.factionIdsOnCurrentScene(tokenDoc?.id ?? null),
        };
    } catch (err) {
        console.warn(`${TAG} | Faction lookup module unavailable — falling back to creature-base matching only:`, err);
    }

    // ── The candidate pool, scored across EVERY faction ──────────────────
    // ⚠️ Computed HERE, after the dynamic import above, because this and
    // decideFaction() are now the SAME scorer. They used to be two: one built
    // this list for the AI, the other made the decision, and nothing kept them
    // agreeing. The dynamic import is what stops faction-lookup and this file
    // forming a cycle, so the ranking cannot happen before it.
    let ranked = [];
    try { ranked = _lookup?.rankFactions?.(actor, { sceneName, worldTag, limit: 12 }) ?? []; }
    catch (err) { console.warn(`${TAG} | ranking failed, falling back to creature-base matching:`, err); }
    const matching = ranked.length ? ranked : findMatchingFactions(creatureBase, worldTag);
    if (ranked.length) {
        console.log(`${TAG} | ${actor.name}: best faction matches — ` +
            ranked.slice(0, 3).map(r => `${r.name} (${r._score}: ${r._why.slice(0, 2).join("; ")})`).join(" | "));
    }

    // ── Auto-scan (scene load) vs manual drop ──────────────────────
    // Scene auto-scan should generate silently — no dialog popups.
    // Manual drops get the full NPC Identity Dialog.
    // adoptOnly is the silent drop: pure registry lookup, no dialog, no
    // invention, no AI call. It is deliberately treated as an auto-scan.
    const isManualDrop = !adoptOnly && !!tokenDoc._aceManualDrop;
    if (!isManualDrop) {
      // Silent path: auto-assign faction or skip for civilians
      if (_isCivilianBase(creatureBase)) {
        console.log(`${TAG} | ${actor.name} (${creatureBase}) — auto-scan, civilian, skipping faction`);
        return { faction: null, isSpy: false, spyFaction: null, role: creatureBase };
      }

      // LOOK BEFORE YOU INVENT — the silent path gets the same full lookup the
      // dialog path does. It used to take `matching[0]`, which only ever
      // considered creature-base matches and so could never see any of the 440
      // imported world factions (they carry an empty creature base by design).
      let silentPick = null;
      if (_lookup && _lookupCtx) {
        const verdict = _lookup.decideFaction(_lookupCtx);
        if (verdict.decision === "adopt" && verdict.id) {
          silentPick = verdict.faction;
          await _lookup.rememberPresence(verdict.id, sceneName);
          console.log(`${TAG} | ${actor.name} joined the EXISTING "${verdict.faction.name}" — ${verdict.reasons.join("; ")}.`);
        }
      } else if (matching.length > 0) {
        silentPick = matching[0];   // degraded fallback if the lookup failed to load
      }

      if (silentPick) {
        const factionId = silentPick.id;
        // Rank is free — read from the statblock, levels, gear and token — so
        // the silent path decides it too. Skipping it left every silently
        // dropped creature with no role and the faction with an empty roster,
        // which is exactly what "this faction already has a chief" needs.
        const role = await _decideAndClaimRole(actor, tokenDoc, silentPick, factionId, template, creatureBase);
        await assignToFaction(tokenDoc, factionId, role);
        const spyResult = rollSpyChance(tokenDoc, factionId);
        const spyFaction = spyResult.isSpy ? getFaction(spyResult.realFactionId) : null;
        return { faction: silentPick, isSpy: spyResult.isSpy, spyFaction, role };
      }

      // Nothing in the world fits. On a silent drop we stop here rather than
      // spend an AI call inventing a warband for a creature nobody may ever
      // speak to — the question gets settled on first contact instead.
      if (adoptOnly) {
        console.log(`${TAG} | ${actor.name} — no existing faction fits; leaving it unaffiliated until somebody talks to it.`);
        return { faction: null, isSpy: false, spyFaction: null, role: "" };
      }

      // Nothing in the world fits — auto-generate silently
      isNew = true;
      console.log(`${TAG} | ${actor.name} — nothing in the registry fits, generating a new faction silently.`);
    }

    // ── Scene Intelligence: get canonical factions from source material ──
    let sceneIntel = null;
    let worldDigestFactions = [];
    let bibleFactions = [];
    try {
        sceneIntel = await EngineBridge.getSceneIntelligence(sceneName);
        // Pull ALL factions from the world digest (via bridge — no instance leak)
        worldDigestFactions = EngineBridge.getWorldGraphFactions();
        // Pull ALL factions from the World Bible for enrichment
        try { bibleFactions = EngineBridge.getWorldBibleFactions(); } catch (_) { /* non-fatal */ }
        if (worldDigestFactions.length || bibleFactions.length) {
            console.log(`${TAG} | Loaded ${worldDigestFactions.length} digest factions + ${bibleFactions.length} Bible factions`);
        }
    } catch (err) {
        console.warn(`${TAG} | Scene intelligence / world digest lookup failed (non-fatal):`, err);
    }

    let factionId = null;
    let role = "";
    let faction = null;
    // `matching` and `isNew` are declared above the auto-scan branch — see the
    // temporal-dead-zone note there.

    // ── Wild Card: "The guy from Zambia" ──────────────────────────────
    // 1-in-N chance this NPC is from a completely different region of the world.
    // Only humanoid-ish creatures — beasts, constructs, undead stay local.
    if (template.canSpy) { // canSpy = humanoid-capable creature types
      let wildcardChance;
      try { wildcardChance = game.settings.get(MODULE_ID, "factionWildcardChance") ?? 200; }
      catch (_) { wildcardChance = 200; }

      if (wildcardChance > 0 && Math.floor(Math.random() * wildcardChance) + 1 === 1) {
        // Wild card triggered! Pick a random faction from the ENTIRE World Bible (via bridge)
        try {
          const allFactions = EngineBridge.getWorldBibleFactions();
          if (allFactions.length > 0) {
            // Filter to factions from a DIFFERENT region than the current scene
            const localRegion = sceneIntel?.canonicalFactions?.[0]?._regionId || "";
            const foreignFactions = allFactions.filter(f => f._regionId && f._regionId !== localRegion);
            const pool = foreignFactions.length > 3 ? foreignFactions : allFactions;
            const pick = pool[Math.floor(Math.random() * pool.length)];
            if (pick) {
              console.log(`${TAG} | 🃏 WILD CARD! ${actor.name} is from far away — assigned to "${pick.name}" (${pick._regionId})`);
              ui.notifications.info(`🃏 Wild Card — ${actor.name} is a far-flung outsider from ${pick.name}!`);
              // Create the faction in the local registry
              faction = {
                name: pick.name,
                type: pick.type || template.type,
                tier: pick.type || template.type,
                stability: template.stability,
                creatureBase,
                worldTag,
                scene: sceneName,
                purpose: pick.purpose || pick.description || `A ${pick.type} from ${pick._regionId}.`,
                leader: pick.leader || null,
                members: [],
                isCanonical: true,
                _sourceRegion: pick._regionId,
                _wildcard: true,
              };
              const data = _load();
              data[faction.id] = faction;
              await _serializedSave(data);
              factionId = faction.id;
              role = "outsider";
              await assignToFaction(tokenDoc, factionId, role);
              const spyResult = rollSpyChance(tokenDoc, factionId);
              const spyFaction = spyResult.isSpy ? getFaction(spyResult.realFactionId) : null;
              return { faction, isSpy: spyResult.isSpy, spyFaction, role };
            }
          }
        } catch (wcErr) {
          console.warn(`${TAG} | Wild card roll failed (non-fatal):`, wcErr);
        }
      }
    }

    if (isManualDrop) {
        // ── Read the persistent tier setting ───────────────────────────
        let defaultTier = "full";
        try { defaultTier = game.settings.get(MODULE_ID, "tokenDropAI") ?? "full"; }
        catch (_) { /* setting not registered yet — use default */ }

        // ── Step 1: AI recommends 3 factions (skip if bio-only) ────────
        let recommendations = [];
        if (defaultTier !== "bio-only") {
            recommendations = await recommendFactions(
                actor, creatureBase, template, sceneName, worldTag,
                matching, sceneIntel, worldDigestFactions
            );
            console.log(`${TAG} | AI recommendations for ${actor.name}:`, recommendations.map(r => r.name));
        }

        // ── Step 2: Show smart setup dialog (OR auto-accept #1) ────────
        // If tokenDoc has _aceAutoAccept set (auto-pipeline mode), skip
        // the dialog entirely and accept the AI's #1 recommendation.
        let setup;
        if (tokenDoc._aceAutoAccept) {
            setup = {
                choice: "accept",
                selectedIndex: 0,
                rename: false,
                autoLink: false,
                tier: defaultTier,
            };
            console.log(`${TAG} | ${actor.name} — AUTO-ACCEPT recommendation #1: ${recommendations[0]?.name}`);
        } else {
            setup = await showSmartSetupDialog(actor.name, creatureBase, recommendations, creatureType, defaultTier);
        }

        // Store rename preference and tier override for bio-generator downstream
        if (setup && !setup.rename) tokenDoc._aceSkipRename = true;
        if (setup?.tier) tokenDoc._aceDropTier = setup.tier;
        // Propagate the smart-dialog's auto-link choice. If the user later goes
        // through "Customize…", that dialog's autoLink checkbox overrides this
        // value (handled below where result.autoLink is read).
        if (setup?.autoLink !== undefined) tokenDoc._aceAutoLink = setup.autoLink;

        if (!setup || setup.choice === "skip") {
            // Skip All — no faction, no auto-assign, bio still runs unless tier=off
            console.log(`${TAG} | ${actor.name} — GM skipped all (smart setup)`);
            tokenDoc._aceDropTier = "off";
            return { faction: null, isSpy: false, spyFaction: null, role: "" };
        }

        // If the user changed the tier to bio-only in the dialog, skip faction assignment
        if (setup.tier === "bio-only") {
            console.log(`${TAG} | ${actor.name} — tier set to bio-only, skipping faction`);
            return { faction: null, isSpy: false, spyFaction: null, role: "" };
        }

        if (setup.choice === "accept") {
            // ── Direct accept of AI recommendation ─────────────────────
            const pick = recommendations[setup.selectedIndex];
            console.log(`${TAG} | ${actor.name} — GM accepted recommendation: "${pick.name}" (${pick.source})`);

            if (pick.source === "existing" && pick.factionId) {
                factionId = pick.factionId;
            } else if (pick.source === "canonical" && pick.canonIdx !== undefined) {
                // Create from scene intel
                const canon = sceneIntel?.canonicalFactions?.[pick.canonIdx];
                if (canon) {
                    const candidate = {
                        name: canon.name,
                        type: canon.type || template.type,
                        tier: canon.type || template.type,
                        stability: template.stability,
                        creatureBase, worldTag, scene: sceneName,
                        purpose: canon.description || `A ${canon.type} faction at ${sceneName}.`,
                        leader: canon.leader || "", lore: canon.description || "",
                        parentFaction: null, members: [], reputation: 0,
                        created: Date.now(), lastActive: Date.now(),
                        source: canon.source || "scene_intelligence",
                    };
                    // ⚠️ NEVER `saveFaction` A NAMED FACTION DIRECTLY. This path takes a name
                    // the world already knows, so it must join an existing entry rather than
                    // mint a duplicate, and its composition must come from that NAME and not
                    // from whichever creature happened to be dropped. See registerNamedFaction.
                    const reg = await registerNamedFaction(candidate, { sceneName, droppedBase: creatureBase });
                    faction   = reg.faction;
                    factionId = reg.id;
                    ui.notifications?.info(reg.adopted
                        ? `Joined existing faction: ${faction.name}`
                        : `Canonical faction registered: ${faction.name}`);
                } else { isNew = true; }
            } else if (pick.source === "world_digest" && pick.worldIdx !== undefined) {
                // Create from world graph
                const wf = worldDigestFactions?.[pick.worldIdx];
                if (wf) {
                    const candidate = {
                        name: wf.name,
                        type: wf.type || template.type,
                        tier: wf.type || template.type,
                        stability: template.stability,
                        creatureBase, worldTag, scene: sceneName,
                        purpose: wf.purpose || wf.description || `A ${wf.type || "faction"} from the world.`,
                        leader: wf.leader || "", lore: wf.purpose || wf.description || "",
                        parentFaction: null, members: [], reputation: 0,
                        created: Date.now(), lastActive: Date.now(),
                        source: wf._source || wf.source || "world_digest",
                        _regionId: wf.region || wf._regionId || "",
                        isCanonical: true,
                    };
                    // ⚠️ NEVER `saveFaction` A NAMED FACTION DIRECTLY. This path takes a name
                    // the world already knows, so it must join an existing entry rather than
                    // mint a duplicate, and its composition must come from that NAME and not
                    // from whichever creature happened to be dropped. See registerNamedFaction.
                    const reg = await registerNamedFaction(candidate, { sceneName, droppedBase: creatureBase });
                    faction   = reg.faction;
                    factionId = reg.id;
                    ui.notifications?.info(reg.adopted
                        ? `Joined existing faction: ${faction.name}`
                        : `World faction registered: ${faction.name}`);
                } else { isNew = true; }
            } else if (pick.source === "none") {
                // "No Faction" selected
                return { faction: null, isSpy: false, spyFaction: null, role: "" };
            } else {
                // "Generate New Faction" or AI-suggested new name
                isNew = true;
            }
            role = "";
        }

        if (setup.choice === "customize") {
            // ── Full dialog: existing NPC Identity Dialog ───────────────
            const result = await showNpcIdentityDialog(tokenDoc, matching, creatureBase, sceneIntel, worldDigestFactions, bibleFactions, recommendations);
            if (!result) {
                // GM cancelled/skipped — truly skip, no silent auto-assignment
                return { faction: null, isSpy: false, spyFaction: null, role: "" };
            } else if (result.factionId === null && !result.isNew) {
                console.log(`${TAG} | ${actor.name} assigned no faction (GM choice)${result.role ? `, role: ${result.role}` : ""}`);
                if (result.origin) await tokenDoc.actor.setFlag(MODULE_ID, "npcOrigin", result.origin);
                if (result.originCustom) await tokenDoc.actor.setFlag(MODULE_ID, "npcOriginCustom", result.originCustom);
                if (result.autoLink !== undefined) tokenDoc._aceAutoLink = result.autoLink;
                // Rename: undo/set the outer smart-setup's _aceSkipRename flag.
                // result.rename === true → user WANTS rename → clear skip flag
                // result.rename === false → user does NOT want rename → set skip flag
                if (result.rename !== undefined) tokenDoc._aceSkipRename = !result.rename;
                if (result.genderOverride && result.genderOverride !== "auto") {
                    await tokenDoc.actor.setFlag(MODULE_ID, "genderOverride", result.genderOverride);
                }
                // The GM correcting the species is the single most useful thing
                // he can tell the namer, so it must survive the dialog closing.
                if (result.speciesOverride) {
                    await tokenDoc.actor.setFlag(MODULE_ID, "speciesOverride", result.speciesOverride);
                }
                return { faction: null, isSpy: false, spyFaction: null, role: result.role || "" };
            } else if (result.isNew) {
                isNew = true;
                role = result.role;
            }

            // Store origin + autoLink + rename + gender override from dialog
            if (result) {
                try {
                    if (result.origin) await tokenDoc.actor.setFlag(MODULE_ID, "npcOrigin", result.origin);
                    if (result.originCustom) await tokenDoc.actor.setFlag(MODULE_ID, "npcOriginCustom", result.originCustom);
                    if (result.autoLink !== undefined) tokenDoc._aceAutoLink = result.autoLink;
                    // Rename override (see comment above)
                    if (result.rename !== undefined) tokenDoc._aceSkipRename = !result.rename;
                    // Gender override: only save when user picked something other than auto.
                    // bio-generator reads this flag and hardcodes the gender in the AI prompt.
                    if (result.genderOverride && result.genderOverride !== "auto") {
                        await tokenDoc.actor.setFlag(MODULE_ID, "genderOverride", result.genderOverride);
                    }
                    if (result.speciesOverride) {
                        await tokenDoc.actor.setFlag(MODULE_ID, "speciesOverride", result.speciesOverride);
                    }
                } catch (err) { console.debug("ACE: Engine | faction-registry origin/autoLink flag save non-fatal:", err); }
            }

            if (result?.factionId?.startsWith("__canonical__:")) {
                const canonIdx = parseInt(result.factionId.split(":")[1], 10);
                const canon = sceneIntel?.canonicalFactions?.[canonIdx];
                if (canon) {
                    const candidate = {
                        name: canon.name,
                        type: canon.type || template.type,
                        tier: canon.type || template.type,
                        stability: template.stability,
                        creatureBase, worldTag, scene: sceneName,
                        purpose: canon.description || `A ${canon.type} faction at ${sceneName}.`,
                        leader: canon.leader || "", lore: canon.description || "",
                        parentFaction: null, members: [], reputation: 0,
                        created: Date.now(), lastActive: Date.now(),
                        source: canon.source || "scene_intelligence",
                    };
                    // ⚠️ NEVER `saveFaction` A NAMED FACTION DIRECTLY. This path takes a name
                    // the world already knows, so it must join an existing entry rather than
                    // mint a duplicate, and its composition must come from that NAME and not
                    // from whichever creature happened to be dropped. See registerNamedFaction.
                    const reg = await registerNamedFaction(candidate, { sceneName, droppedBase: creatureBase });
                    faction   = reg.faction;
                    factionId = reg.id;
                    role      = result.role;
                    ui.notifications?.info(reg.adopted
                        ? `Joined existing faction: ${faction.name}`
                        : `Canonical faction registered: ${faction.name}`);
                } else {
                    isNew = true;
                    role = result.role;
                }
            } else if (result?.factionId?.startsWith("__world__:")) {
                const worldIdx = parseInt(result.factionId.split(":")[1], 10);
                const worldFaction = worldDigestFactions?.[worldIdx];
                if (worldFaction) {
                    const candidate = {
                        name: worldFaction.name,
                        type: worldFaction.type || template.type,
                        tier: worldFaction.type || template.type,
                        stability: template.stability,
                        creatureBase, worldTag, scene: sceneName,
                        purpose: worldFaction.purpose || worldFaction.description || `A ${worldFaction.type || "faction"} from the world.`,
                        leader: worldFaction.leader || "", lore: worldFaction.purpose || worldFaction.description || "",
                        parentFaction: null, members: [], reputation: 0,
                        created: Date.now(), lastActive: Date.now(),
                        source: worldFaction._source || worldFaction.source || "world_digest",
                        _regionId: worldFaction.region || worldFaction._regionId || "",
                        isCanonical: true,
                    };
                    // ⚠️ NEVER `saveFaction` A NAMED FACTION DIRECTLY. This path takes a name
                    // the world already knows, so it must join an existing entry rather than
                    // mint a duplicate, and its composition must come from that NAME and not
                    // from whichever creature happened to be dropped. See registerNamedFaction.
                    const reg = await registerNamedFaction(candidate, { sceneName, droppedBase: creatureBase });
                    faction   = reg.faction;
                    factionId = reg.id;
                    role      = result.role;
                    ui.notifications?.info(reg.adopted
                        ? `Joined existing faction: ${faction.name}`
                        : `World faction registered: ${faction.name}`);
                } else {
                    isNew = true;
                    role = result.role;
                }
            } else {
                factionId = result.factionId;
                role = result.role;
            }
        }
    }

    // ── LOOK BEFORE YOU INVENT (2026-08-07) ──────────────────────────────
    // Johnny: "we already got real factions… like over 200 or something, but
    // yet we're inventing them through the AI." Proven cause: the only lookup
    // that ever ran matched on creature base alone, and every imported world
    // faction is an ORGANISATION with a deliberately empty creature base — so
    // all 440 of them were invisible to the only question ever asked.
    //
    // faction-lookup asks properly: kin, place, institution shape, what the
    // scene's own canon names, and who is already standing on this map. It
    // never invents; it returns a verdict.
    if (isNew && _lookup && _lookupCtx) {
        try {
            const verdict = _lookup.decideFaction(_lookupCtx);
            if (verdict.decision === "adopt" && verdict.id) {
                faction   = verdict.faction;
                factionId = verdict.id;
                isNew     = false;
                // The world map grows on its own: a faction adopted somewhere it
                // had no recorded presence now has it.
                await _lookup.rememberPresence(factionId, sceneName);
                ui.notifications?.info(`Joined existing faction: ${faction.name}`);
                console.log(`${TAG} | ${tokenDoc?.name ?? creatureBase} joined the EXISTING "${faction.name}" — ${verdict.reasons.join("; ")}.`);
            }
        } catch (err) {
            console.warn(`${TAG} | Faction lookup failed — falling back to inventing one:`, err);
        }
    }

    // ── Generate new faction if needed ───────────────────────────────────
    if (isNew) {
        // Find the local governance faction for context (if any)
        const localGovernance = _findLocalGovernance(worldTag);

        let neighbourContext = "";
        try {
            if (_lookup && _lookupCtx) neighbourContext = _lookup.describeNeighbours(_lookupCtx);
        } catch (_) { /* prompt garnish only */ }

        const identity = await generateFactionIdentity(
            creatureBase, sceneName, worldTag, template, localGovernance, neighbourContext
        );

        // ── ADOPT ON COLLISION ───────────────────────────────────────────
        // Scene intelligence and the world bible are already in the generation
        // prompt, so the model regularly answers with a canonical name that is
        // ALREADY in the registry. Without this test each of those became a
        // duplicate sitting next to the real entry. Also catches the model
        // taking the explicit EXISTING: escape hatch.
        // ⚠️ THE GUARD USED TO LIVE HERE AND ONLY HERE, and it leaned on `_lookup`
        // being loaded — a module import inside a try, so a failure turned the
        // whole collision test into a silent pass. The four OTHER creation sites
        // in this function had no test at all, which is how a second faction
        // called "Mind Flayers" came to exist beside the real one. There is now
        // one door: registerNamedFaction, which reads the registry directly.
        if (identity.useExistingName) identity.name = identity.useExistingName;

        if (isNew) {
            const candidate = {
                name: identity.name,
                type: template.type,
                tier: template.type,  // Power factions use their type as tier
                stability: template.stability,
                creatureBase,
                worldTag,
                scene: sceneName,
                // ⚠️ presence is what makes an emergent faction FINDABLE later.
                // Without it the Red Fang met in a forest could never be matched
                // by place again, and the next encounter would invent a second one.
                presence: sceneName ? [sceneName] : [],
                source: "emergent",
                purpose: identity.purpose,
                leader: identity.leader,
                lore: identity.lore,
                parentFaction: localGovernance?.id || null,
                members: [],
                reputation: 0,
                created: Date.now(),
                lastActive: Date.now(),
            };

            const reg = await registerNamedFaction(candidate, { sceneName, droppedBase: creatureBase });
            faction   = reg.faction;
            factionId = reg.id;
            isNew     = !reg.adopted;

            ui.notifications?.info(reg.adopted
                ? `Joined existing faction: ${faction.name}`
                : `New faction created: ${faction.name} (${template.type})`);
        }
    } else if (factionId) {
        faction = getFaction(factionId);
    }

    // ── WHO IS THE CHIEF, AND WHO IS A MOOK (2026-08-07) ────────────────
    // Johnny: "there's going to be a lot more mooks than chiefs… the AI has to
    // be smart enough to know, okay, this faction already has a chief."
    //
    // Rank is READ, not rolled. The Monster Manual builds the hierarchy into
    // statblock names — Goblin Boss IS the chieftain — and gear, class levels
    // and legendary actions fill in the rest. Only when nothing says anything
    // does a weighted roll happen, and the roster refuses to hand out a post
    // that is already held. See faction-roster.mjs for the full ladder.
    if (faction && factionId && !role) {
        role = await _decideAndClaimRole(actor, tokenDoc, faction, factionId, template, creatureBase);
    }

    // ── Assign token to faction ─────────────────────────────────────────
    if (faction && factionId) {
        await assignToFaction(tokenDoc, factionId, role);
    }

    // ── Spy roll ────────────────────────────────────────────────────────
    let isSpy = false;
    let spyFaction = null;
    if (faction && factionId) {
        const spyResult = rollSpyChance(tokenDoc, factionId);
        if (spyResult.isSpy) {
            isSpy = true;
            spyFaction = getFaction(spyResult.realFactionId);
            // Store spy info as hidden flags (GM only, not visible to players)
            const target = tokenDoc.actorLink ? actor : tokenDoc.actor;
            await target.setFlag(MODULE_ID, "isSpy", true);
            await target.setFlag(MODULE_ID, "realFactionId", spyResult.realFactionId);
            console.log(`${TAG} | 🕵️ ${actor.name} is a spy from "${spyResult.realFactionName}"`);
        }
    }

    return { faction, isSpy, spyFaction, role };
}

// ─── GOVERNANCE HELPERS ──────────────────────────────────────────────────────

/**
 * Find the most specific local governance faction for the current scene.
 * Walks up from establishment → district → town → county → etc.
 * @param {string} worldTag
 * @returns {FactionData|null}
 */
function _findLocalGovernance(worldTag) {
    const data = _load();
    const sceneName = (canvas.scene?.name || "").toLowerCase();

    // Look for governance factions related to this scene, most specific first
    for (const tier of [...POLITICAL_TIERS].reverse()) {
        for (const [id, faction] of Object.entries(data)) {
            if (faction.tier !== tier) continue;
            if (worldTag) {
                if (!faction.worldTag || faction.worldTag !== worldTag) continue;
            }
            // Check if this governance faction's name or scene matches
            if (faction.scene && sceneName.includes(faction.scene.toLowerCase())) {
                return { ...faction, id };
            }
            if (faction.name && sceneName.includes(faction.name.toLowerCase())) {
                return { ...faction, id };
            }
        }
    }
    return null;
}

// ─── CONTEXT INJECTION FOR BIO GENERATOR ─────────────────────────────────────

/**
 * Build faction context to inject into the bio generation prompt.
 * @param {FactionData} faction — the faction this NPC belongs to
 * @param {boolean} isSpy — is this NPC secretly from another faction?
 * @param {FactionData|null} spyFaction — the real faction if spy
 * @param {string} role — role within the faction
 * @param {string} [creatureBase] — the creature base of the token being generated
 * @returns {string} — context block for the bio prompt
 */
export function buildFactionBioContext(faction, isSpy, spyFaction, role, creatureBase) {
    if (!faction) return "";

    const lines = [];
    lines.push(`\n\nFACTION IDENTITY — this NPC belongs to a group:`);
    lines.push(`- Faction: ${faction.name} (${faction.type})`);
    if (faction.leader) lines.push(`- Leader: ${faction.leader}`);
    if (faction.purpose) lines.push(`- Purpose: ${faction.purpose}`);
    if (faction.lore) lines.push(`- Shared Lore (all members know this): ${faction.lore}`);
    if (faction.structure) lines.push(`- Structure: ${faction.structure}`);
    if (role) {
        lines.push(`- This NPC's role: ${role} — their profession/function is ${role.toUpperCase()}, do NOT change it to something else.`);
    }

    // Cross-species family context — bugbear joining a goblin tribe, etc.
    const factionBase = (faction.creatureBase || "").toLowerCase();
    const thisBase = (creatureBase || "").toLowerCase();
    if (thisBase && factionBase && thisBase !== factionBase) {
        const family = getCreatureFamily(thisBase);
        if (family) {
            const familyName = family.charAt(0).toUpperCase() + family.slice(1);
            lines.push(`\n- INTER-SPECIES HIERARCHY: This NPC is a ${thisBase}, joining a faction primarily made up of ${factionBase}s. They are both ${familyName}s — they share the same gods, customs, and social structures. In D&D lore, ${thisBase}s within ${factionBase} groups often serve as enforcers, champions, leaders, or elite warriors. Write the bio reflecting their specific role within this mixed-race group — are they the muscle? A lieutenant? A spiritual figure? Make the cross-species dynamic interesting.`);
        }
    }

    // Hierarchy context
    if (faction.parentFaction) {
        const parent = getFaction(faction.parentFaction);
        if (parent) {
            lines.push(`- Operates within: ${parent.name} (${parent.tier})`);
            if (parent.parentFaction) {
                const grandparent = getFaction(parent.parentFaction);
                if (grandparent) lines.push(`- Which is part of: ${grandparent.name} (${grandparent.tier})`);
            }
        }
    }

    lines.push(`\nWeave the faction identity naturally into the biography. The NPC should reference their group, their leader, and their shared purpose. They are PART of something larger.`);

    // Spy context — only the GM and AI know this
    if (isSpy && spyFaction) {
        lines.push(`\n⚠️ SECRET — SPY/INFILTRATOR: This NPC is secretly from "${spyFaction.name}" (${spyFaction.type}), posing as a member of ${faction.name}. Work this into the bio as a hidden secret. They have a cover story that fits ${faction.name}, but their TRUE loyalty is to ${spyFaction.name}. Include subtle hints that something is off — nervous habits, evasive about their past, knowledge they shouldn't have. The players should NOT be told directly — this is for conversation AI to know.`);
    }

    return lines.join("\n");
}

// ─── CONTEXT INJECTION FOR CONVERSATION ──────────────────────────────────────

/**
 * Build faction context for injecting into NPC conversation prompts.
 * @param {Actor} actor
 * @returns {string} — context block for the conversation system prompt
 */
export function buildFactionConversationContext(actor) {
    if (!actor) return "";

    const factionId = actor.getFlag(MODULE_ID, "factionId");
    if (!factionId) return "";

    const faction = getFaction(factionId);
    if (!faction) return "";

    const role = actor.getFlag(MODULE_ID, "factionRole") || "";
    const isSpy = actor.getFlag(MODULE_ID, "isSpy") || false;
    const realFactionId = actor.getFlag(MODULE_ID, "realFactionId");

    const lines = [];
    lines.push(`\n## YOUR FACTION`);
    lines.push(`You belong to ${faction.name} (${faction.type}).`);
    if (faction.leader) lines.push(`Your leader is ${faction.leader}.`);
    if (faction.purpose) lines.push(`Purpose: ${faction.purpose}`);
    if (faction.lore) lines.push(`What you know: ${faction.lore}`);
    if (role) lines.push(`Your role: ${role}`);

    // Hierarchy awareness
    if (faction.parentFaction) {
        const parent = getFaction(faction.parentFaction);
        if (parent) {
            lines.push(`Your group operates within ${parent.name}'s territory.`);
        }
    }

    // Reputation with PCs
    if (faction.reputation !== undefined && faction.reputation !== 0) {
        if (faction.reputation >= 50) lines.push(`Your faction regards the adventurers favorably — they've earned trust.`);
        else if (faction.reputation >= 20) lines.push(`Your faction has heard good things about these adventurers.`);
        else if (faction.reputation <= -50) lines.push(`Your faction considers these adventurers enemies — they've wronged your kind.`);
        else if (faction.reputation <= -20) lines.push(`Your faction has heard bad things about these adventurers — be wary.`);
    }

    lines.push(`Reference your faction naturally — "we", "our people", "${faction.name}" — as part of your identity.`);

    // Spy behavior
    if (isSpy && realFactionId) {
        const realFaction = getFaction(realFactionId);
        if (realFaction) {
            lines.push(`\n⚠️ SECRET: You are actually a spy from ${realFaction.name}. You PRETEND to be a loyal member of ${faction.name}, but your true loyalty is to ${realFaction.name}. If asked probing questions about your past, you become nervous and evasive. You have a cover story. If directly confronted with strong evidence, you may break — but never voluntarily reveal your true allegiance.`);
        }
    }

    return lines.join("\n");
}

// ─── REPUTATION MANAGEMENT ───────────────────────────────────────────────────

/**
 * Adjust a faction's reputation with the PCs.
 * @param {string} factionId
 * @param {number} delta — positive or negative
 * @param {string} [reason] — why the reputation changed
 */
export async function adjustReputation(factionId, delta, reason) {
    const data = _load();
    const faction = data[factionId];
    if (!faction) return;

    const oldRep = faction.reputation || 0;
    faction.reputation = Math.max(-100, Math.min(100, oldRep + delta));
    faction.lastActive = Date.now();

    await _serializedSave(data);
    console.log(`${TAG} | Reputation for "${faction.name}": ${oldRep} → ${faction.reputation} (${delta > 0 ? "+" : ""}${delta}${reason ? `, ${reason}` : ""})`);
}
