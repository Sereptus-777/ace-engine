// ─── ACE Engine — what a faction is MADE OF, and who hears when one dies ────
//
// ⚠️ ONE FIELD WAS DOING TWO OPPOSITE JOBS, which is why the reputation system
// turned a church of the sun god against the party (2026-08-21).
//
//   COMPOSITION — what a member of this faction IS. Human, orc, drow. Wanted for
//                 generating members, voices, languages, whether they growl.
//                 EVERY faction has one. Johnny: "If it's a royal guard of
//                 Damara, then I imagine it's mostly human or whatever. Don't we
//                 know what the base creature will be?" We do, and we should.
//
//   KINSHIP     — who hears about a death and CARES. Kill a Bloodtusk orc and
//                 other orc tribes hear, because being orcs IS their identity.
//                 Kill a Damaran royal guard and humanity does not close ranks.
//
// Filling composition in everywhere WITHOUT separating these would have been
// worse than the bug it replaced: label the Damaran guard "human" under the old
// logic and killing any human anywhere angers them, and every other human
// organisation in the world besides.
//
// So composition is filled for everything, and kinship is narrow:
//
//   ⚠️ A SPECIES PROPAGATES ONLY WHEN IT IS IN THE FACTION'S NAME.
//
// "Orc Legion" and "Drow Houses" are defined by their species and propagate.
// "Royal Guard of Damara" is defined by serving Damara and does not; the crown
// hearing about a dead guard is an ORGANISATIONAL tie, which is what allies and
// parent factions are already for. Johnny, asked to confirm exactly this:
// "yes, only their allies and superiors react."

import { getAllFactions, resolveCreatureBase, inferCreatureBase } from "./faction-registry.mjs";

const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | Faction composition";

/** Species that are their own society. Killing one is heard by the rest. */
const TRIBAL_SPECIES = new Set([
    "orc", "goblin", "hobgoblin", "bugbear", "gnoll", "kobold", "drow", "duergar",
    "lizardfolk", "yuan-ti", "sahuagin", "kuo-toa", "bullywug", "troll", "ogre",
    "giant", "undead",
]);

/** Cosmopolitan species. Being one is not a faction. */
const COSMOPOLITAN = new Set(["human", "elf", "dwarf", "halfling", "gnome",
                              "half-elf", "half-orc", "tiefling", "dragonborn", "commoner"]);

/**
 * The best available answer for what this faction is made of, with the reason
 * so a GM can see which ones were reasoned and which were guessed.
 *
 * ⚠️ EVIDENCE ORDER MATTERS. His own world outranks any rule we could write:
 * if eleven creatures are assigned to the Bloodtusk Clan and nine are orcs, the
 * answer is orc and no amount of clever name parsing should overrule it.
 *
 * @returns {{base: string, why: string, confident: boolean}}
 */
export function deriveComposition(factionId, faction) {
    // 1. The creatures actually in it, in HIS world.
    const members = [];
    for (const a of (game.actors ?? [])) {
        try {
            if (a.getFlag(MODULE_ID, "factionId") === factionId) members.push(a);
        } catch (_) { /* an actor we cannot read is one we skip */ }
    }
    if (members.length) {
        const tally = new Map();
        for (const a of members) {
            const b = resolveCreatureBase(a);
            if (b) tally.set(b, (tally.get(b) ?? 0) + 1);
        }
        // ⚠️ ONE MEMBER IS NOT EVIDENCE. This accepted a majority of "1 of 1",
        // so a single actor happening to carry the monstrosity type decided that
        // the VISTANI — who are human — are monstrosities, and every basilisk in
        // the world then scored 35 points against them. A faction needs at least
        // two members agreeing before their species is treated as the faction's.
        const best = [...tally.entries()].sort((x, y) => y[1] - x[1])[0];
        if (best && best[1] >= 2 && best[1] >= Math.ceil(members.length / 2)) {
            return { base: best[0], why: `${best[1]} of ${members.length} members are ${best[0]}`, confident: true };
        }
    }

    // 2. The name says it outright.
    const fromName = inferCreatureBase(faction);
    if (fromName) return { base: fromName, why: "named in the faction title", confident: true };

    // ⚠️ THE `type` FIELD IS NOT A SOURCE AND NEVER WAS. It was written by the
    // same broken importer that put "undead" on the Royal Guard of Damara, and
    // I removed it from inferCreatureBase for exactly that reason — then left
    // this reading it. So "Beholder Hives" and "Illithid Elder Brain Colonies"
    // both kept creatureBase "undead" with the reason "the faction's own type
    // field", and every ghoul in the world scored 66 against a beholder hive.
    //
    // A field that inherited the bug cannot be used to repair it. Twice now.

    // 4. An organisation of people, with nothing saying otherwise. In the
    //    Realms that is overwhelmingly human, and a marked guess beats a blank.
    return { base: "human", why: "assumed — an organisation with no other evidence", confident: false };
}

/**
 * Does killing a member of this faction spread word to others of the species?
 * Only when the species IS the faction's identity.
 */
export function speciesPropagates(faction) {
    const base = String(faction?.creatureBase || "").toLowerCase().trim();
    if (!base || COSMOPOLITAN.has(base)) return false;
    // The species must be in the NAME. "Orc Legion" yes; a human guard company
    // that happens to be tagged human, no.
    const named = inferCreatureBase({ name: faction?.name });
    if (named && named === base) return true;
    // A tribal species with no name evidence still spreads word among its own,
    // but only if something else already established the species confidently.
    return TRIBAL_SPECIES.has(base) && faction?.compositionConfident === true;
}

/**
 * Fill composition for every faction that has none, once, and report.
 * ⚠️ Never overwrites a base that is already set — a GM's own answer wins.
 */
// ⚠️ _waitForApi and the startingStanding import lived here to serve the
// boot-time attitude roll. That roll is gone — attitude is applied on first
// contact by reputation-engine.adjustFactionScore — so both are gone with it.
// Dead code that reads as live is how a reader concludes a feature exists.

export async function backfillCompositions({ dryRun = false } = {}) {
    if (!game.user?.isGM) return null;
    // ⚠️ ONE CLIENT ONLY. `isGM` is true on EVERY connected GM, so with two GMs
    // at the table this ran twice, both writing the same world registry, and
    // whichever finished last silently clobbered the other. That is the same
    // shape as the 2026-08-15 save-template bug: a defect that appears and
    // disappears with no code change, because it depends on who is logged in.
    if (game.users?.activeGM !== game.user) return null;

    const all = getAllFactions() ?? {};
    const ids = Object.keys(all);
    if (!ids.length) return null;

    const registry = foundry.utils.deepClone(all);
    const filled = [], guessed = [], retired = [];

    // ⚠️ RETIRE ANSWERS THAT CAME FROM REASONING WE HAVE SINCE REJECTED.
    // Because every composition records WHY it was chosen, a rule we later
    // decide was wrong can be undone precisely, without touching answers that
    // were arrived at honestly. Two reasons are now disqualified:
    //   "the faction's own type field" — that field carried the same bad import
    //      data, which is how Beholder Hives and Illithid Elder Brain Colonies
    //      were both left as undead and every ghoul scored 66 against them.
    //   "1 of N members"              — one actor is not a majority. It decided
    //      the Vistani, who are human, were monstrosities.
    for (const id of ids) {
        const f = registry[id];
        const why = String(f?.compositionWhy || "");
        if (!why) continue;
        // ⚠️🔴 AND EVERY "ASSUMED" ANSWER, because the reader that should have
        // prevented it was broken (2026-08-22). The creature-name hints were
        // written as STRING literals — "\bgnolls?\b" — where \b is a backspace,
        // not a word boundary. All seventeen patterns matched nothing from the
        // day they were written, so 448 of 461 factions fell through to
        // "assumed — an organisation with no other evidence", including ones
        // literally named "Gnolls", "Kobolds" and "Drow".
        //
        // The evidence was the name the whole time. Now that the patterns work,
        // 35 factions read correctly, so every answer that was only ever a
        // fallback must be re-asked. Answers reached honestly are untouched.
        const wasAssumed = why.startsWith("assumed");
        if (why.includes("own type field") || /^1 of \d+ members/.test(why) || wasAssumed) {
            retired.push(`${f.name || id} (was ${f.creatureBase}: ${why})`);
            f.creatureBase = "";
            delete f.compositionWhy;
            delete f.compositionConfident;
        }
    }

    for (const id of ids) {
        const f = registry[id];
        if (!f || typeof f !== "object") continue;
        if (String(f.creatureBase || "").trim()) continue;   // already answered

        const { base, why, confident } = deriveComposition(id, f);
        f.creatureBase = base;
        f.compositionWhy = why;
        f.compositionConfident = confident;
        (confident ? filled : guessed).push(`${f.name || id} → ${base} (${why})`);
    }

    if (!dryRun && (filled.length || guessed.length || retired.length)) {
        await game.settings.set(MODULE_ID, "factionRegistry", registry);
    }

    // ── STARTING ATTITUDE IS NOT SEEDED HERE ANY MORE ───────────────────────
    //
    // ⚠️🔴 THIS BLOCK DEALT 241 OPINIONS ON EVERY WORLD LOAD, and Johnny had
    // already told me it was wrong twice.
    //
    // First on 2026-08-22 morning, seeing 233 factions given a standing:
    // "I don't think I really wanted that to happen." Then, asked when it
    // should happen instead: "It should happen on first contact, right?"
    //
    // I removed the roll, then re-added it here, and it re-seeded every load.
    // Worse, it FIGHTS THE REPAIR: replayDeeds wipes the dealt opinions so
    // reputation can be rebuilt from real deeds, and ten minutes later this
    // handed 241 factions an opinion again, because hasFactionScore() reads
    // false on a freshly wiped faction. Two passes undoing each other forever.
    //
    // A faction that has never met the party has no view of the party. Their
    // innate attitude is now applied by reputation-engine.adjustFactionScore
    // at the moment something FIRST touches them, which is what first contact
    // actually means. The Zhentarim still start hostile — but only once the
    // party has done something the Zhentarim could have heard about.

    const lines = [`${TAG} | ${ids.length} factions checked.`];
    if (retired.length) lines.push(`  retired ${retired.length} answer(s) from reasoning we no longer accept:`,
                                   ...retired.map(l => "    " + l));
    if (filled.length)  lines.push(`  worked out from evidence (${filled.length}):`,  ...filled.map(l => "    " + l));
    if (guessed.length) lines.push(`  assumed, review these (${guessed.length}):`,    ...guessed.map(l => "    " + l));
    console.log(lines.join("\n"));

    if (!dryRun && (filled.length || guessed.length)) {
        ui.notifications?.info(
            `ACE Engine gave ${filled.length + guessed.length} factions a base creature: ` +
            `${filled.length} worked out from members or their name, ${guessed.length} assumed human. ` +
            `Full list in the console. ⚠️ Species only spreads word among its own kind when the species is in the faction's NAME.`,
            { permanent: true });
    }
    return { filled, guessed };
}
