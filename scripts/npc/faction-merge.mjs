// ─── Two factions with the same name are one faction ─────────────────────────
//
// ⚠️ WHY THIS EXISTS. `processTokenFaction` had FIVE places that could create a
// faction and only ONE of them checked whether the name was already taken. The
// other four minted a fresh random id every time, so any canonical name the
// world already knew — taken from scene intelligence or the world digest —
// produced a SECOND entry sitting invisibly beside the real one in a list of
// four hundred and sixty.
//
// ⚠️ AND THE DUPLICATE WAS WORSE THAN A TIDINESS PROBLEM. Those four sites
// stamped the DROPPED CREATURE'S species onto the new faction. Proven live on
// 2026-08-22: a goblin dropped at a mine produced a second faction called
// "Mind Flayers" whose composition said GOBLIN. It then scored a perfect match
// against every goblin in the world, the goblin was assigned to it, his written
// history said he served the Mind Flayers, and the name scan that picks a
// creature's name off its own bio handed him "Mind Flayers" as a name.
//
// One bad record, four visible symptoms, and every one of them looked like a
// separate bug.
//
// ─── ⚠️🔴 WHICH ONE SURVIVES IS THE WHOLE DECISION ───────────────────────────
//
// The first version of this file ranked the two records by how much CONTENT
// they held: lore, a leader, a region, a roster. Run against Johnny's world it
// chose to keep the runtime-generated twin and throw away the imported library
// original in FIVE of seven cases, because the twin had accumulated a member or
// a scene while the curated entry sat clean and unused.
//
// That is not a cosmetic misjudgement. REPUTATION IS KEYED BY FACTION ID.
// `factionScore[id]` and `factionStanding[id]` in the reputation store, and
// `factionId` on every recorded deed, all point at one specific id. Deleting
// the id the world references discards that faction's earned standing and
// orphans every deed that named it — silently, because a missing key reads as
// "no opinion yet" rather than as an error.
//
// So the keeper is not the prettiest record. It is THE ONE THE REST OF THE
// WORLD ALREADY POINTS AT, counted from the real data: standings, deeds,
// creature flags, roster entries. Content only breaks a tie. That is a fact
// about his world, not a preference of mine, and the report prints the count
// beside every candidate so the call can be checked rather than trusted.
//
// ⚠️ AND IT PRINTS THE KEEPER, NOT ONLY THE LOSERS. Version one logged what got
// absorbed and never said what survived or why, so a backwards ranking looked
// like a clean run. A report that cannot show you a wrong answer is not a
// report.
//
// ⚠️ IT NEVER DELETES A FACTION WITHOUT MOVING ITS PEOPLE FIRST. Membership
// lives in two places — the faction's own roster and a `factionId` flag on each
// creature — and both are carried across before the loser is removed. Deleting
// first is how you orphan a flag pointing at nothing.
import {
    getAllFactions, saveFaction, deleteFaction, inferCreatureBase,
} from "./faction-registry.mjs";

const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | Faction Merge";

/**
 * One spelling of a faction name, so two records of the same group agree.
 * Casing, a leading "the", punctuation and doubled spaces are all noise.
 */
function normalise(name) {
    return String(name || "")
        .toLowerCase()
        .replace(/^the\s+/, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * Every creature in the world carrying a `factionId` flag, wherever it lives.
 *
 * ⚠️ UNLINKED TOKENS HOLD THEIR FLAGS IN A DELTA, not on the world actor, so a
 * sweep that only walks `game.actors` misses every wandering monster on every
 * scene — which in Johnny's world is most of them.
 */
function everyFlagHolder() {
    const out = [];
    for (const actor of game.actors ?? []) {
        const id = actor.getFlag(MODULE_ID, "factionId");
        if (id) out.push({ doc: actor, id, label: actor.name });
    }
    for (const scene of game.scenes ?? []) {
        for (const token of scene.tokens ?? []) {
            if (token.actorLink) continue;              // counted above
            const id = token.actor?.getFlag?.(MODULE_ID, "factionId");
            if (id) out.push({ doc: token.actor, id, label: `${token.name} (${scene.name})` });
        }
    }
    return out;
}

/**
 * How many recorded deeds name each faction id.
 *
 * ⚠️ SAY WHEN THE DEEDS COULD NOT BE READ. If the store is unavailable this
 * returns null rather than an empty map, so the caller can refuse to merge
 * instead of quietly deciding that no faction has any history. A count of zero
 * and a count that failed must never look the same.
 */
async function deedCounts() {
    try {
        const api = game.modules.get(MODULE_ID)?.api;
        const memory = api?.memoryManager ?? null;
        if (!memory) return null;
        const { collectDeeds } = await import("../deed-replay.mjs");
        const { rows, label } = collectDeeds(memory);
        if (!rows.length && label === "nothing answered") return null;
        const counts = {};
        for (const row of rows) {
            const id = row?.factionId;
            if (id) counts[id] = (counts[id] ?? 0) + 1;
        }
        return counts;
    } catch (err) {
        console.warn(`${TAG} | Could not read the deed record:`, err);
        return null;
    }
}

/**
 * What the rest of the world has invested in this id.
 *
 * This is the number that decides which record survives a merge. Everything in
 * it is a real reference held somewhere else: an opinion in the reputation
 * store, a deed that named it, a creature wearing its flag, a name on its
 * roster. Content is NOT counted here — a well-written entry nobody points at
 * has nothing to lose by being folded into one that is referenced everywhere.
 */
function references(id, faction, ctx) {
    const hasScore    = Object.prototype.hasOwnProperty.call(ctx.scores, id);
    const score       = Number(ctx.scores[id] ?? 0);
    const deeds       = ctx.deeds ? (ctx.deeds[id] ?? 0) : 0;
    const flagged     = ctx.holders.filter(h => h.id === id).length;
    const roster      = faction?.members?.length ?? 0;
    return {
        hasScore, score, deeds, flagged, roster,
        // An earned opinion is the single most expensive thing to lose, so it
        // dominates. Below it, anything that points here counts once.
        weight: (hasScore && score !== 0 ? 10000 : 0)
              + (hasScore ? 1000 : 0)
              + deeds * 100
              + flagged * 10
              + roster,
    };
}

/**
 * How complete a record is. ONLY used to break a tie when nothing in the world
 * points at either candidate, in which case the curated import wins.
 */
function completeness(faction, id) {
    let score = 0;
    const source = String(faction?.source || "").toLowerCase();
    if (source === "library")     score += 400;
    if (source === "world_bible") score += 300;
    if (faction?.isCanonical)     score += 200;
    if (source && source !== "emergent") score += 100;
    // ⚠️ A STABLE SLUG ID IS THE IMPORTED ORIGINAL. Foundry hands out sixteen
    // mixed-case characters; "mind_flayers" and "asmodeus_faction" were written
    // by the import and are what any hand-authored reference would have used.
    if (/^[a-z][a-z0-9_]+$/.test(id)) score += 150;
    if (faction?.leader)  score += 40;
    if (faction?.lore)    score += 20;
    if (faction?.purpose) score += 10;
    if (faction?.region || faction?._regionId) score += 20;
    score += (faction?.presence?.length ?? 0);
    return score;
}

function describe(id, faction, ref, complete) {
    return `[${id}] ${String(faction?.source || "unknown").padEnd(12)}`
        + ` made of ${String(faction?.creatureBase || "?").padEnd(11)}`
        + ` | standing ${ref.hasScore ? String(ref.score).padStart(4) : "  --"}`
        + ` | ${String(ref.deeds).padStart(3)} deed(s)`
        + ` | ${String(ref.flagged).padStart(3)} creature(s)`
        + ` | ${String(ref.roster).padStart(3)} on roster`
        + ` | references ${ref.weight}, completeness ${complete}`;
}

/**
 * Merge every set of factions that share a name, and report what happened.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] — report only, change nothing
 * @param {Record<string,string>} [opts.keep] — force a winner: { "normalised name": id }
 * @returns {Promise<object>} a summary, also printed to the console
 */
export async function mergeDuplicateFactions({ dryRun = false, keep: forced = {} } = {}) {
    if (!game.user?.isGM) {
        ui.notifications?.warn("Only a GM can merge factions.");
        return { merged: 0 };
    }

    const all = getAllFactions() ?? {};
    const groups = new Map();
    for (const [id, faction] of Object.entries(all)) {
        const key = normalise(faction?.name);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ id, faction });
    }

    const dupes = [...groups.entries()].filter(([, rows]) => rows.length > 1);
    if (!dupes.length) {
        console.log(`${TAG} | No two factions share a name.`);
        ui.notifications?.info("No duplicate faction names found.");
        return { merged: 0, moved: 0, repointed: 0, report: [] };
    }

    // ── What the world points at ─────────────────────────────────────────
    const api    = game.modules.get(MODULE_ID)?.api;
    const scores = api?.getAllFactionScores?.() ?? {};
    const deeds  = await deedCounts();
    if (deeds === null) {
        console.warn(`${TAG} | THE DEED RECORD COULD NOT BE READ.`);
        console.warn(`${TAG} | Deed references cannot be counted, so a merge could`
            + ` discard the id your history points at. Nothing will be changed.`);
        ui.notifications?.error("Faction merge stopped: the deed record could not be read.");
        return { merged: 0, blocked: "deeds unreadable" };
    }
    const holders = everyFlagHolder();
    const ctx = { scores, deeds, holders };

    const report = [];
    let movedMembers = 0;
    let repointedCreatures = 0;
    let discardedOpinions = 0;

    console.log(`${TAG} | ${dryRun ? "DRY RUN — nothing will be changed" : "MERGING"}`);
    console.log("=".repeat(110));

    for (const [key, rows] of dupes) {
        for (const row of rows) {
            row.ref      = references(row.id, row.faction, ctx);
            row.complete = completeness(row.faction, row.id);
        }
        // References first, completeness only as a tie-break.
        rows.sort((a, b) => (b.ref.weight - a.ref.weight) || (b.complete - a.complete));

        // An explicit instruction always wins over the heuristic.
        let keeper = rows[0];
        if (forced[key]) {
            const chosen = rows.find(r => r.id === forced[key]);
            if (chosen) keeper = chosen;
            else console.warn(`${TAG} | You asked to keep ${forced[key]} for "${key}",`
                + ` but no faction with that id has that name. Using the counted winner instead.`);
        }
        const losers = rows.filter(r => r !== keeper);

        console.log(`\n   ${keeper.faction.name}`);
        console.log(`      KEEP    ${describe(keeper.id, keeper.faction, keeper.ref, keeper.complete)}`);
        for (const l of losers) {
            console.log(`      absorb  ${describe(l.id, l.faction, l.ref, l.complete)}`);
        }

        const keep = foundry.utils.deepClone(keeper.faction);
        keep.id = keeper.id;
        keep.members  = Array.isArray(keep.members)  ? [...keep.members]  : [];
        keep.presence = Array.isArray(keep.presence) ? [...keep.presence] : [];

        for (const loser of losers) {
            const l = loser.faction;

            for (const m of (l.members ?? [])) {
                if (!keep.members.includes(m)) { keep.members.push(m); movedMembers++; }
            }
            for (const p of (l.presence ?? [])) {
                if (!keep.presence.includes(p)) keep.presence.push(p);
            }
            // Fill only what the keeper is missing. Never overwrite real lore
            // with a guess.
            for (const field of ["leader", "lore", "purpose", "region", "_regionId", "alignment", "type", "tier", "source"]) {
                if (!keep[field] && l[field]) keep[field] = l[field];
            }

            for (const h of ctx.holders.filter(h => h.id === loser.id)) {
                if (!dryRun) await h.doc.setFlag(MODULE_ID, "factionId", keeper.id);
                h.id = keeper.id;                       // so deleteFaction cannot re-release it
                repointedCreatures++;
            }

            // ⚠️ AN OPINION THAT IS ABOUT TO BE DELETED MUST BE SAID OUT LOUD.
            // Two records of one group can both have been judged. Only one id
            // survives, so the other's standing goes with it, and silently
            // dropping how a faction felt about the party is exactly the kind of
            // loss that shows up months later as "why do they like us now".
            if (loser.ref.hasScore) {
                discardedOpinions++;
                console.log(`      ⚠️  that record also held a standing of ${loser.ref.score},`
                    + ` and it is discarded. Re-run replayDeeds afterwards to rebuild it from the deeds.`);
            }
            if (loser.ref.deeds) {
                console.log(`      ⚠️  ${loser.ref.deeds} recorded deed(s) name the absorbed id.`
                    + ` Re-run replayDeeds afterwards so they land on the survivor.`);
            }
        }

        // ⚠️ THE NAME DECIDES WHAT IT IS MADE OF. This is the field the bad
        // creation sites poisoned, so the merge is the right moment to reread it
        // from the only trustworthy source.
        const fromName = inferCreatureBase({ name: keep.name });
        if (fromName && fromName !== keep.creatureBase) {
            console.log(`      composition corrected: ${keep.creatureBase || "none"} -> ${fromName} (read from its name)`);
            keep.creatureBase = fromName;
        }

        if (!dryRun) {
            await saveFaction(keep);
            for (const loser of losers) await deleteFaction(loser.id);
        }

        report.push({ name: keep.name, keptId: keeper.id, absorbed: losers.map(l => l.id) });
    }

    console.log("\n" + "=".repeat(110));
    console.log(`   ${report.length} name(s) ${dryRun ? "would be" : ""} merged,`
        + ` ${movedMembers} roster entr(ies) moved, ${repointedCreatures} creature(s) repointed.`);
    if (discardedOpinions) {
        console.log(`   ⚠️  ${discardedOpinions} earned standing(s) sit on records that would be removed.`
            + ` Run replayDeeds afterwards.`);
    }
    if (dryRun) {
        console.log(`   Nothing was changed. To apply: mergeDuplicateFactions()`);
        console.log(`   To override a winner: mergeDuplicateFactions({ keep: { "mind flayers": "mind_flayers" } })`);
    } else {
        ui.notifications?.info(`Merged ${report.length} duplicate faction name(s); `
            + `${repointedCreatures} creature(s) repointed.`);
    }
    return { merged: report.length, moved: movedMembers, repointed: repointedCreatures,
             discardedOpinions, report };
}

/**
 * Factions whose recorded composition disagrees with their own name.
 *
 * Separate from the merge because a wrong composition is not always a duplicate
 * — the bad creation sites also wrote it onto brand new names. Reported first,
 * fixed only when asked, because this is the field that drives kin propagation
 * and a bad sweep here is how the church of the sun god came to hate the party.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.fix=false]
 */
export async function auditFactionComposition({ fix = false } = {}) {
    const all = getAllFactions() ?? {};
    const wrong = [];
    for (const [id, faction] of Object.entries(all)) {
        const fromName = inferCreatureBase({ name: faction?.name });
        if (!fromName) continue;                       // the name claims nothing
        if (fromName === faction?.creatureBase) continue;
        wrong.push({ id, name: faction.name, was: faction.creatureBase || "none", should: fromName, faction });
    }

    console.log(`${TAG} | COMPOSITION AUDIT`);
    console.log("=".repeat(74));
    if (!wrong.length) {
        console.log("   Every faction whose name names a creature is recorded as that creature.");
        return { wrong: 0 };
    }
    for (const w of wrong) console.log(`   ${w.name.padEnd(38)} ${w.was.padEnd(14)} -> ${w.should}`);
    console.log("=".repeat(74));
    console.log(`   ${wrong.length} faction(s) disagree with their own name.`);

    if (fix && game.user?.isGM) {
        for (const w of wrong) {
            await saveFaction({ ...w.faction, id: w.id, creatureBase: w.should });
        }
        console.log(`   ${wrong.length} corrected.`);
        ui.notifications?.info(`Corrected the composition of ${wrong.length} faction(s).`);
    } else if (wrong.length) {
        console.log("   Nothing was changed. Pass { fix: true } to apply.");
    }
    return { wrong: wrong.length, rows: wrong };
}
