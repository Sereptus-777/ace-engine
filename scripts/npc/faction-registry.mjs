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

const MODULE_ID = "ace-engine";

/** Read engine's AI config — replaces envoy's getEnvoyAIConfig. */
function getEnvoyAIConfig() {
    try {
        return {
            provider: game.settings.get(MODULE_ID, "aiProvider") || "ollama",
            apiKey:   game.settings.get(MODULE_ID, "apiKey")     || "",
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
    undead:    ["skeleton", "zombie", "undead", "wight", "ghoul", "ghost", "wraith"],
    construct: ["construct", "golem"],
    canine:    ["wolf", "worg", "dire wolf"],
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
export async function deleteFaction(factionId) {
    const data = _load();
    const name = data[factionId]?.name || factionId;
    delete data[factionId];
    await _serializedSave(data);
    console.log(`${TAG} | Deleted faction: ${name}`);
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
export async function generateFactionIdentity(creatureBase, sceneName, worldName, template, parentFaction) {
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
LORE: [2-3 sentences of shared history]`;

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
The faction name should feel appropriate for ${creatureBase}s — not generic.${locationContext ? " Use canonical faction names from the scene intelligence or World Bible if appropriate for this creature type and location." : ""}`;

    try {
        const Handler = await _getAIHandler();
        const response = await Handler.callAI(systemPrompt, [], userMsg, provider, apiKey);
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
        const response = await Handler.callAI(systemPrompt, [], userMsg, provider, apiKey);
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

    // Smart default for persistent NPC based on CR
    const persistDefault = cr >= 5;

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

                        resolve({ factionId, isNew, role, origin, originCustom, autoLink });
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

                // Update info panel for first option
                const firstVal = factionSelect.value;
                const firstMeta = newMeta[firstVal] || newMeta["__none__"];
                if (infoPanel) infoPanel.innerHTML = _buildFactionInfoHtml(firstMeta);
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
function _scoreFactionForDialog(f, creatureType, creatureSubtype, creatureBase, sceneIntel, sceneName, actor) {
    // ── HARD EXCLUSION 1: Generic category factions (not real factions) ──
    // These are placeholder groupings from digest extraction, not actual factions.
    const fNameRaw = (f.name || "").trim();
    const fNameLower = fNameRaw.toLowerCase();
    if (!fNameRaw) return -1;
    // Matches: "Evil-Aligned Factions", "World-Preserving Factions", "Practical/Esoteric Factions", etc.
    const GENERIC_CATEGORY = /^(evil|good|neutral|lawful|chaotic|world[\s-]\w+|practical|esoteric|major|minor|ancient|modern|other|misc|various|all)[\s\-/]*\w*\s+factions?$/i;
    if (GENERIC_CATEGORY.test(fNameLower)) return -1;
    // Also exclude "X Aligned Factions" or "Y-Type Factions"
    if (/\baligned factions?\b|\btype factions?\b|\bcategory factions?\b/i.test(fNameLower)) return -1;

    // ── HARD EXCLUSION 1b: Species/taxonomy entries (not real factions) ──
    // Digest engine sometimes indexes creature type entries as "factions."
    // Filter out entries where the type is a species/race/taxonomy label.
    const fTypeLower = (f.type || "").toLowerCase();
    const SPECIES_TYPES = new Set(["species", "race", "creature type", "creature", "taxonomy", "monster", "beast type", "creature family"]);
    if (SPECIES_TYPES.has(fTypeLower)) return -1;
    // Also filter entries whose name IS a creature type (e.g., "Goblinoids", "Orcs", "Undead")
    const CREATURE_TYPE_NAMES = /^(goblinoids?|orcs?|elves|dwarves|humans?|gnolls?|kobolds?|lizardfolk|undead|fiends?|celestials?|aberrations?|constructs?|elementals?|monstrosities|oozes?|plants?|beasts?|giants?|dragons?|fey|humanoids?)$/i;
    if (CREATURE_TYPE_NAMES.test(fNameRaw)) return -1;

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
    const existingList = matching.map(f => `• "${f.name}" (${f.type}) — ${f.purpose || "no description"}`).join("\n");
    const canonList = (sceneIntel?.canonicalFactions || []).map(f => `• "${f.name}" (${f.type || "faction"}) — ${f.description || ""}`).join("\n");
    const digestList = (worldDigestFactions || []).slice(0, 8).map(f => `• "${f.name}" (${f.type || "faction"}) — ${f.purpose || f.description || ""}`).join("\n");

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
- Option 1 should be the BEST match (existing faction if one fits, or a compelling new one)
- Option 2 should be an interesting ALTERNATIVE (rival faction, different allegiance, adds tension)
- Option 3 should be "Generate New Faction" — a fresh faction the AI will create
- Each option needs a NAME and a 1-sentence REASON explaining why this creature might belong there
- If existing factions match well, prefer them. If not, suggest new names that fit the creature and setting.
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
        const response = await Handler.callAI(systemPrompt, [], userMsg, provider, apiKey);
        const parsed = _parseRecommendations(response, matching, sceneIntel, worldDigestFactions);
        if (parsed.length === 3) return parsed;
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
        // New faction suggestion
        results.push({ name, reason, source: "generate" });
    }
    return results;
}

/**
 * Fallback when AI recommendation fails — build 3 options from raw data.
 */
function _fallbackRecommendations(matching, sceneIntel, worldDigestFactions, creatureBase, template) {
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
    } else if (worldDigestFactions?.length) {
        results.push({ name: worldDigestFactions[0].name, reason: `From campaign world lore`, source: "world_digest", worldIdx: 0 });
    }

    // Fill to 2 if needed, then always add Generate New as option 3
    while (results.length < 2) {
        results.push({ name: "No Faction", reason: `Skip faction assignment entirely`, source: "none" });
    }
    results.push({ name: "Generate New Faction", reason: `Create a fresh ${template.type} for this ${creatureBase}`, source: "generate" });

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

    const renameChecked = isNonSentient ? "" : "checked";
    const renameDisabled = isNonSentient ? "disabled" : "";
    const renameNote = isNonSentient ? " (beasts keep species name)" : "";
    const factionHidden = (currentTier === "bio-only") ? "display:none;" : "";

    const content = `
        <div style="font-family:sans-serif;">
            <div class="ace-smart-faction-section" style="${factionHidden}">
                <p style="color:#222; font-size:16px; font-weight:600; margin:0 0 12px 0;">Based on this creature and the current scene:</p>
                <div class="ace-smart-setup-options" style="margin-bottom:14px;">
                    ${optionsHtml}
                </div>
            </div>
            <hr style="border-color:#ccc; margin:10px 0;">
            <div style="display:flex; align-items:center; gap:14px; margin-bottom:8px;">
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
                        const tier = html.find("select[name='ace-drop-tier']").val() || currentTier;
                        resolve({ choice: "accept", selectedIndex: idx, rename, tier });
                    }
                },
                customize: {
                    icon: '<i class="fas fa-sliders-h"></i>',
                    label: "Customize\u2026",
                    callback: (html) => {
                        const rename = !!html.find("input[name='ace-rename-toggle']").prop("checked");
                        const tier = html.find("select[name='ace-drop-tier']").val() || currentTier;
                        resolve({ choice: "customize", selectedIndex: 0, rename, tier });
                    }
                },
                skip: {
                    icon: '<i class="fas fa-forward"></i>',
                    label: "Skip All",
                    callback: () => resolve({ choice: "skip", selectedIndex: -1, rename: false, tier: "off" })
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
export async function processTokenFaction(tokenDoc) {
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

    // ── Auto-scan (scene load) vs manual drop ──────────────────────
    // Scene auto-scan should generate silently — no dialog popups.
    // Manual drops get the full NPC Identity Dialog.
    const isManualDrop = !!tokenDoc._aceManualDrop;
    if (!isManualDrop) {
      // Silent path: auto-assign faction or skip for civilians
      if (_isCivilianBase(creatureBase)) {
        console.log(`${TAG} | ${actor.name} (${creatureBase}) — auto-scan, civilian, skipping faction`);
        return { faction: null, isSpy: false, spyFaction: null, role: creatureBase };
      }
      // For non-civilians on auto-scan, use first matching faction or auto-generate
      if (matching.length > 0) {
        const factionId = matching[0].id;
        const role = "";
        await assignToFaction(tokenDoc, factionId, role);
        const spyResult = rollSpyChance(tokenDoc, factionId);
        const spyFaction = spyResult.isSpy ? getFaction(spyResult.realFactionId) : null;
        return { faction: matching[0], isSpy: spyResult.isSpy, spyFaction, role };
      }
      // No matching factions — auto-generate silently
      isNew = true;
      console.log(`${TAG} | ${actor.name} — auto-scan, first of type, auto-generating faction`);
    }

    // Find existing factions for this creature type in this world
    const matching = findMatchingFactions(creatureBase, worldTag);

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
    let isNew = false;
    let role = "";
    let faction = null;

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
                id: foundry.utils.randomID(),
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

        // ── Step 2: Show smart setup dialog ────────────────────────────
        const setup = await showSmartSetupDialog(actor.name, creatureBase, recommendations, creatureType, defaultTier);

        // Store rename preference and tier override for bio-generator downstream
        if (setup && !setup.rename) tokenDoc._aceSkipRename = true;
        if (setup?.tier) tokenDoc._aceDropTier = setup.tier;

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
                    faction = {
                        id: foundry.utils.randomID(),
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
                    await saveFaction(faction);
                    factionId = faction.id;
                    ui.notifications?.info(`Canonical faction registered: ${faction.name}`);
                } else { isNew = true; }
            } else if (pick.source === "world_digest" && pick.worldIdx !== undefined) {
                // Create from world graph
                const wf = worldDigestFactions?.[pick.worldIdx];
                if (wf) {
                    faction = {
                        id: foundry.utils.randomID(),
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
                    await saveFaction(faction);
                    factionId = faction.id;
                    ui.notifications?.info(`World faction registered: ${faction.name}`);
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
                return { faction: null, isSpy: false, spyFaction: null, role: result.role || "" };
            } else if (result.isNew) {
                isNew = true;
                role = result.role;
            }

            // Store origin + autoLink from dialog
            if (result) {
                try {
                    if (result.origin) await tokenDoc.actor.setFlag(MODULE_ID, "npcOrigin", result.origin);
                    if (result.originCustom) await tokenDoc.actor.setFlag(MODULE_ID, "npcOriginCustom", result.originCustom);
                    if (result.autoLink !== undefined) tokenDoc._aceAutoLink = result.autoLink;
                } catch (err) { console.debug("ACE: Engine | faction-registry origin/autoLink flag save non-fatal:", err); }
            }

            if (result?.factionId?.startsWith("__canonical__:")) {
                const canonIdx = parseInt(result.factionId.split(":")[1], 10);
                const canon = sceneIntel?.canonicalFactions?.[canonIdx];
                if (canon) {
                    faction = {
                        id: foundry.utils.randomID(),
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
                    await saveFaction(faction);
                    factionId = faction.id;
                    role = result.role;
                    ui.notifications?.info(`Canonical faction registered: ${faction.name}`);
                    console.log(`${TAG} | Created canonical faction from scene intel: ${faction.name} (${faction.id})`);
                } else {
                    isNew = true;
                    role = result.role;
                }
            } else if (result?.factionId?.startsWith("__world__:")) {
                const worldIdx = parseInt(result.factionId.split(":")[1], 10);
                const worldFaction = worldDigestFactions?.[worldIdx];
                if (worldFaction) {
                    faction = {
                        id: foundry.utils.randomID(),
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
                    await saveFaction(faction);
                    factionId = faction.id;
                    role = result.role;
                    ui.notifications?.info(`World faction registered: ${faction.name}`);
                    console.log(`${TAG} | Created world digest faction: ${faction.name} (${faction.id}) from ${faction._regionId || "unknown region"}`);
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

    // ── Generate new faction if needed ───────────────────────────────────
    if (isNew) {
        // Find the local governance faction for context (if any)
        const localGovernance = _findLocalGovernance(worldTag);

        const identity = await generateFactionIdentity(
            creatureBase, sceneName, worldTag, template, localGovernance
        );

        faction = {
            id: foundry.utils.randomID(),
            name: identity.name,
            type: template.type,
            tier: template.type,  // Power factions use their type as tier
            stability: template.stability,
            creatureBase,
            worldTag,
            scene: sceneName,
            purpose: identity.purpose,
            leader: identity.leader,
            lore: identity.lore,
            parentFaction: localGovernance?.id || null,
            members: [],
            reputation: 0,
            created: Date.now(),
            lastActive: Date.now(),
        };

        await saveFaction(faction);
        factionId = faction.id;

        ui.notifications?.info(`New faction created: ${faction.name} (${template.type})`);
        console.log(`${TAG} | Created new faction: ${faction.name} (${faction.id})`);
    } else if (factionId) {
        faction = getFaction(factionId);
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
