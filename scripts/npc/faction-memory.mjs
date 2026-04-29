// ─── ACE: Engine — NPC Faction Memory ───────────────────────────────────────
// Stores narrative events per faction/creature-type key.
// When one NPC of a faction learns something, all NPCs of that faction can
// reference it — "word spreads among their kind."
//
// Moved from ace-envoy/src/ai/faction-memory.js as part of the
// Envoy → Engine merger. The cross-module engineResolveFactionKey bridge
// import is gone — engine reaches its own reputation engine via api by id.

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Faction";
const SETTING_KEY = "factionMemory";
const MAX_EVENTS_PER_FACTION = 20;   // Rolling buffer per faction
const MAX_FACTIONS = 50;             // Safety cap

/** Reach engine's own reputation engine for canonical faction-key resolution. */
function engineResolveFactionKey(actor) {
    try {
        return game.modules.get(MODULE_ID)?.api?.resolveFactionKey?.(actor) ?? null;
    } catch (_) { return null; }
}

// ─── Faction Key Resolution ──────────────────────────────────────────────────
// Mirrors ACE Engine's resolveFactionKey logic so Envoy works standalone.

/**
 * Resolve a faction key from a D&D 5e actor.
 * For humanoids, uses the subtype (goblinoid, human, elf, etc.).
 * For other creatures, uses the creature type directly (undead, beast, etc.).
 * Falls back to ACE Engine's reputation engine if available.
 * @param {Actor} actor
 * @returns {string|null}
 */
export function resolveFactionKey(actor) {
    if (!actor) return null;

    // Priority 1: Named faction from the faction registry (Living World system)
    try {
        const factionId = actor.getFlag(MODULE_ID, "factionId");
        if (factionId) return `faction:${factionId}`;
    } catch (_) {}

    // Priority 2: ACE Engine's reputation engine (via bridge — handles GM-defined faction groupings)
    try {
        const key = engineResolveFactionKey(actor);
        if (key) return key;
    } catch (_) { /* ACE Engine not available — use standalone logic */ }

    // Priority 3: Standalone — resolve from D&D 5e creature type data
    const type = actor.system?.details?.type;
    if (!type) return null;

    const creatureType = (type.value || "").toLowerCase().trim();
    const subtype = (type.subtype || "").toLowerCase().trim();

    // For humanoids, use subtype for more specific grouping
    if (creatureType === "humanoid" && subtype) return subtype;

    return creatureType || null;
}

// ─── Read / Write ────────────────────────────────────────────────────────────

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
        console.error(`${TAG} | Failed to save faction memory:`, e);
    }
}

// ─── Write Serialization ────────────────────────────────────────────────────
// Prevents race conditions when two rapid calls both read → modify → write,
// which would cause the second write to overwrite the first's changes.
let _writeLock = Promise.resolve();

// ─── Log a Faction Event ─────────────────────────────────────────────────────

/**
 * Record a narrative event that all NPCs of the same faction can reference.
 * @param {Actor} actor — the NPC involved
 * @param {object} event
 * @param {string} event.kind — "conversation" | "threat" | "deal" | "betrayal" | "death" | "combat"
 * @param {string} event.summary — 1-2 sentence narrative description
 * @param {string} [event.npcName] — the specific NPC involved
 * @param {string} [event.playerName] — the PC involved
 * @param {string} [event.scene] — where it happened
 */
export async function logFactionEvent(actor, event) {
    if (!game.user.isGM) return;

    const factionKey = resolveFactionKey(actor);
    if (!factionKey) {
        console.warn(`${TAG} | Could not resolve faction key for ${actor.name}`);
        return;
    }

    // Serialize all writes to prevent race conditions
    const prev = _writeLock;
    _writeLock = prev.then(() => _doLogFactionEvent(factionKey, event, actor)).catch(err => {
        console.error(`${TAG} | Faction event logging failed:`, err);
    });
    return _writeLock;
}

async function _doLogFactionEvent(factionKey, event, actor) {
    const data = _load();

    // Safety cap on total factions
    if (!data[factionKey] && Object.keys(data).length >= MAX_FACTIONS) {
        console.warn(`${TAG} | Faction limit reached (${MAX_FACTIONS}), skipping new faction "${factionKey}"`);
        return;
    }

    if (!data[factionKey]) data[factionKey] = { events: [] };

    const entry = {
        t:      Math.floor(Date.now() / 1000),
        kind:   event.kind || "conversation",
        npc:    event.npcName || actor.name,
        player: event.playerName || "",
        scene:  event.scene || canvas?.scene?.name || "",
        summary: (event.summary || "").slice(0, 400),
    };

    data[factionKey].events.push(entry);

    // Rolling buffer — keep only the most recent events per faction
    if (data[factionKey].events.length > MAX_EVENTS_PER_FACTION) {
        data[factionKey].events = data[factionKey].events.slice(-MAX_EVENTS_PER_FACTION);
    }

    await _save(data);
    console.log(`${TAG} | Logged "${event.kind}" event for faction "${factionKey}" — ${entry.npc}`);
}

// ─── Log a Death Event ───────────────────────────────────────────────────────

/**
 * Record that an NPC with conversation history was killed.
 * Nearby same-faction NPCs may react to this.
 * @param {TokenDocument} tokenDocument — the dying token
 * @param {string} [killerName] — who killed them (if known)
 */
export async function logDeathEvent(tokenDocument, killerName) {
    if (!game.user.isGM) return;
    const actor = tokenDocument?.actor;
    if (!actor) return;

    // Check if this NPC had any conversation history
    const history = actor.getFlag(MODULE_ID, "memoryLog");
    const hadConversation = history && history.length > 0;

    const npcName = tokenDocument.name || actor.name;
    const scene = canvas?.scene?.name || "";

    let summary;
    if (hadConversation) {
        // Extract the last thing said in conversation for dramatic effect
        const lastMsg = [...history].reverse().find(m => m.role === "assistant");
        const lastWords = lastMsg ? lastMsg.content.slice(0, 100) : "";
        summary = killerName
            ? `${npcName} was slain by ${killerName} at ${scene}.${lastWords ? ` Their last words were: "${lastWords}"` : ""}`
            : `${npcName} was killed at ${scene}.${lastWords ? ` Their last words were: "${lastWords}"` : ""}`;
    } else {
        summary = killerName
            ? `${npcName} was slain by ${killerName} at ${scene}. They died without ever speaking to the adventurers.`
            : `${npcName} was killed at ${scene}.`;
    }

    // Uses logFactionEvent which is already serialized via _writeLock
    return logFactionEvent(actor, {
        kind:       "death",
        summary,
        npcName,
        playerName: killerName || "",
        scene,
    });
}

// ─── Read Faction Events for Prompt Injection ────────────────────────────────

/**
 * Get faction events for an NPC's faction, formatted for AI prompt injection.
 * Returns empty string if no events exist for this faction.
 * @param {Actor} actor — the NPC about to have a conversation
 * @param {number} [maxEvents=5] — how many recent events to include
 * @returns {string} — formatted context block, or ""
 */
export function getFactionContext(actor, maxEvents = 5) {
    const factionKey = resolveFactionKey(actor);
    if (!factionKey) return "";

    const data = _load();
    const faction = data[factionKey];
    if (!faction?.events?.length) return "";

    // Don't include events about THIS specific NPC (they have their own memory)
    const npcName = actor.name;
    const otherEvents = faction.events.filter(e => e.npc !== npcName);
    if (!otherEvents.length) return "";

    // Take the most recent events
    const recent = otherEvents.slice(-maxEvents);

    const lines = [`\n## FACTION AWARENESS (word among your kind)`];
    lines.push(`Others of your kind have shared these accounts:`);

    for (const evt of recent) {
        const timeAgo = _timeAgo(evt.t);
        const prefix = evt.kind === "death" ? "⚠️ " : "";
        lines.push(`- ${prefix}${evt.summary} (${timeAgo})`);
    }

    lines.push(`\nReact to this knowledge naturally — you heard it through your kin, not firsthand (unless you were there).`);
    lines.push(`If a death was reported, you may be angry, fearful, or vengeful depending on your personality.`);

    return lines.join("\n");
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function _timeAgo(unixSeconds) {
    const diff = Math.floor(Date.now() / 1000) - unixSeconds;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
    return `${Math.floor(diff / 86400)} days ago`;
}

/**
 * Get all faction data (for debugging / export).
 * @returns {object}
 */
export function getAllFactions() {
    return _load();
}

/**
 * Clear faction memory for a specific faction key (GM use).
 * @param {string} factionKey
 */
export async function clearFaction(factionKey) {
    if (!game.user.isGM) return;
    const data = _load();
    delete data[factionKey];
    await _save(data);
    console.log(`${TAG} | Cleared faction memory for "${factionKey}"`);
}
