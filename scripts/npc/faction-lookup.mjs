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

import { getAllFactions, getFaction, getFamilyMembers, saveFaction } from "./faction-registry.mjs";

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
