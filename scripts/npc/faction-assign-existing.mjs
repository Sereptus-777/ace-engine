// ─── ACE Engine — give the creatures you already have a faction ─────────────
//
// ⚠️ WHY. The deed read-back classified five months of history correctly and
// then reported this:
//
//     heroic 52 · villainous 12 · neither 124
//     61 concerned nobody we hold a faction for — counted, moved nothing.
//
// Sixty-one of the sixty-four meaningful deeds had nowhere to land. The model
// named Vilnius, Varek, Syrax, the Abbot, Grex — all real creatures in the
// world, almost none of them belonging to anything. Faction assignment only
// ever ran when a token was dropped with that feature switched on, so 563
// existing creatures were never given one.
//
// So the reputation system works and has nothing to work with. This is the
// missing link.
//
// ⚠️ IT REFUSES TO GUESS, and that is the whole design. A creature is assigned
// only when one faction scores well AND clearly beats the runner-up. A close
// call is left alone and reported, because a wrong faction is worse than none:
// it would put a deed on the wrong people's ledger permanently, and nobody
// would ever know to look.
//
// ⚠️ IT NEVER OVERWRITES. A creature that already has a faction — assigned by
// you, or by a token drop — keeps it.

import { rankFactions } from "./faction-lookup.mjs";
import { getFaction } from "./faction-registry.mjs";
// ⚠️ Reused, not re-implemented. journal-identity already decides whether a
// name reads as a person, and it was written against Johnny's real data:
// quotes, comma-titles, "the something" epithets, and multi-word capitals.
import { looksLikeAPersonalName, classify, loadStatblockNames } from "./journal-identity.mjs";

const MODULE_ID  = "ace-engine";
const TAG        = "ACE: Engine | Faction assign";
const DONE_FLAG  = "factionAssignExisting2026";

// A confident match. Roughly: a distinctive shared name word (60), or a species
// match plus creature type plus alignment agreement.
const MIN_SCORE  = 50;
// And it must beat the next candidate by this much, or it is a coin toss.
const MIN_MARGIN = 15;

// Creatures that do not join anything. Mirrors processTokenFaction.
const SKIP_TYPES = new Set(["beast", "ooze", "plant"]);

/**
 * Names of creatures that have actually taken part in this campaign.
 *
 * ⚠️ THE FIRST RUN CONSIDERED 2,017 CREATURES, which is Johnny's entire imported
 * bestiary, not his cast. Assigning a faction to every Aboleth and Ancient
 * Dragon sitting unused in a compendium is noise at best, and the deeds only
 * ever name creatures that were actually there.
 */
function _castOfTheCampaign(memory) {
    const names = new Set();
    const norm = (n) => String(n || "").toLowerCase()
        .replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s*#?\s*\d+\s*$/g, "")
        .replace(/\s+/g, " ").trim();
    for (const e of (memory?.history?.events ?? [])) {
        if (e?.a)   for (const n of String(e.a).split(",")) names.add(norm(n));
        if (e?.tgt) names.add(norm(e.tgt));
        if (Array.isArray(e?.p)) for (const n of e.p) names.add(norm(n));
    }
    names.delete("");
    return names;
}

/**
 * @param {boolean} [opts.foundTribes=false]  invent a faction when nothing fits.
 *
 * ⚠️🔴 OFF BY DEFAULT, AND FOR A GOOD REASON (2026-08-22). Johnny: "I don't
 * think there should be any AI-made-up factions. I think we have enough to
 * choose from." He was right, and the reason the matcher could not find them
 * was a bug, not a shortage: the creature-name patterns in faction-registry
 * were string literals, so the word-boundary escape became a backspace and
 * all 17 matched nothing. 448
 * of his 461 factions were therefore labelled "human", including ones named
 * "Gnolls" and "Kobolds", and a bullywug scored zero against every one of them.
 *
 * With that fixed, 35 factions read as creatures and there is somewhere for
 * monsters to go. Inventing more would bury real ones under invented ones.
 *
 * The nine already founded are KEPT. Johnny: "it just makes sense that that's
 * what people would call it... Goblins are going to go out of their way to name
 * other goblin tribes. They're just going to call them the Amber Goblin tribes."
 * The code stays so it can be turned on deliberately; it simply never runs on
 * its own again.
 */
export async function assignFactionsToExisting({ dryRun = false, force = false, memory = null,
                                                everyone = false, foundTribes = false } = {}) {
    if (!game.user?.isGM) return null;
    // ⚠️ ONE CLIENT ONLY. `isGM` is true on EVERY connected GM, so with two GMs
    // at the table this ran twice, both writing the same world registry, and
    // whichever finished last silently clobbered the other. That is the same
    // shape as the 2026-08-15 save-template bug: a defect that appears and
    // disappears with no code change, because it depends on who is logged in.
    if (game.users?.activeGM !== game.user) return null;
    if (!force && !dryRun) {
        try { if (game.settings.get(MODULE_ID, DONE_FLAG)) return null; } catch (_) { return null; }
    }

    const worldTag = game.world?.title || "";
    const assigned = [], unsure = [], skipped = [];
    // ⚠️ Keep the ACTORS too. `unsure` holds sentences for the report, and a
    // sentence cannot be given a faction.
    const unsureActors = [];
    // Flags that point at a faction which no longer exists.
    const orphaned = [];
    const cast = everyone ? null : _castOfTheCampaign(memory);
    const norm = (n) => String(n || "").toLowerCase()
        .replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s*#?\s*\d+\s*$/g, "")
        .replace(/\s+/g, " ").trim();
    let offstage = 0;

    for (const actor of (game.actors ?? [])) {
        try {
            if (actor.hasPlayerOwner) continue;                       // the party

            // ⚠️ A FLAG POINTING AT NOTHING IS NOT AN ANSWER (2026-08-22).
            // Eight creatures in Johnny's world — Death Knight, Lord Soth,
            // Casimir Thornwick and five more — carry a factionId for a faction
            // that no longer exists, deleted or never saved. This check used to
            // ask only whether a flag was PRESENT, so those eight were treated
            // as settled and skipped forever, while propagateDeed found nothing
            // to move and exited quietly. Three "Slew Death Knight" deeds, each
            // worth 32 points, evaporated on that alone.
            const existingId = actor.getFlag(MODULE_ID, "factionId");
            if (existingId) {
                if (getFaction(existingId)) continue;                 // genuinely answered
                orphaned.push(`${actor.name} — pointed at ${existingId}, which no longer exists`);
                if (!dryRun) await actor.unsetFlag(MODULE_ID, "factionId");
            }
            const type = String(actor.system?.details?.type?.value || "").toLowerCase();
            if (SKIP_TYPES.has(type)) { skipped.push(`${actor.name} (${type})`); continue; }
            // Never appeared in play: not part of this story, leave it alone.
            if (cast && !cast.has(norm(actor.name))) { offstage++; continue; }

            const ranked = rankFactions(actor, { worldTag, limit: 3 });
            if (!ranked.length) { unsureActors.push(actor); unsure.push(`${actor.name} — nothing scored at all`); continue; }

            const best = ranked[0];
            const second = ranked[1]?._score ?? 0;
            if (best._score < MIN_SCORE) {
                unsureActors.push(actor); unsure.push(`${actor.name} — best was ${best.name} at ${best._score}, under the bar`);
                continue;
            }
            if (best._score - second < MIN_MARGIN) {
                unsureActors.push(actor); unsure.push(`${actor.name} — ${best.name} (${best._score}) vs ${ranked[1].name} (${second}), too close`);
                continue;
            }

            if (!dryRun) await actor.setFlag(MODULE_ID, "factionId", best.id);
            assigned.push(`${actor.name} → ${best.name} (${best._score}: ${best._why.slice(0, 2).join("; ")})`);
        } catch (err) {
            console.warn(`${TAG} | could not consider ${actor?.name}:`, err);
        }
    }

    // ── Found what does not exist yet ────────────────────────────────────────
    //
    // ⚠️ THE SWEEP COULD ONLY EVER JOIN, NEVER FOUND. 448 of Johnny's 453
    // factions have a creatureBase of "human" — they are nations, guilds and
    // knightly orders. A bullywug scores nothing against any of them and never
    // could, so it landed in "too uncertain" forever and killing one cost the
    // party nothing with anybody.
    //
    // Johnny: "the Bullywugs have tribes and shit like that, with shamans and
    // all kinds of shit, so let's do the most realistic thing."
    //
    // So: one tribe per SPECIES per PLACE. The bullywugs at Argynvostholt are
    // not the bullywugs at the Amber Temple, and a tribe wiped out at one does
    // not answer for the other. Grouping also keeps the cost down to one AI call
    // per tribe instead of one per creature.
    const founded = [];
    if (foundTribes && !dryRun && unsureActors.length) {
        try {
            founded.push(...await _foundMissingFactions(unsureActors, { worldTag, memory }));
        } catch (err) {
            console.warn(`${TAG} | founding new factions failed (nothing else is affected):`, err);
        }
    }

    if (!dryRun && assigned.length) {
        try { await game.settings.set(MODULE_ID, DONE_FLAG, true); } catch (_) {}
    }

    const lines = [
        `${TAG} | ${dryRun ? "DRY RUN — " : ""}considered ${game.actors?.size ?? 0} creatures.`,
        `  assigned ${assigned.length}:`, ...assigned.map(a => "    " + a),
        ...(founded.length ? [`  founded ${founded.length} new faction(s):`,
                              ...founded.map(f => "    " + f)] : []),
        `  left alone as too uncertain: ${unsure.length}`, ...unsure.slice(0, 40).map(u => "    " + u),
        ...(unsure.length > 40 ? [`    ... and ${unsure.length - 40} more`] : []),
        ...(orphaned.length ? [`  cleared ${orphaned.length} flag(s) pointing at a faction that no longer exists:`,
                               ...orphaned.map(o => "    " + o)] : []),
        `  skipped ${skipped.length} beasts, oozes and plants — they do not join anything.`,
        ...(offstage ? [`  ignored ${offstage} creature(s) that have never appeared in this campaign.`] : []),
    ];
    console.log(lines.join("\n"));

    if (!dryRun) {
        ui.notifications?.info(
            `ACE Engine gave ${assigned.length} creature(s) a faction. ` +
            `${unsure.length} were too uncertain to call and were left alone. Full list in the console.` +
            (assigned.length ? ` Re-run the deed read-back to let past deeds land on them.` : ""),
            { permanent: true });
    }
    return { assigned, unsure, skipped, orphaned, founded };
}

// ─── Founding what does not exist ───────────────────────────────────────────
//
// ⚠️ ONE TRIBE PER SPECIES PER PLACE. Not one per creature, which would give
// every bullywug its own nation, and not one per species, which would make the
// bullywugs at Argynvostholt answer for a massacre at the Amber Temple. A tribe
// holds a territory, and territory is what makes a grudge local.

/** Kinds of faction that are worth founding for a creature that has none. */
const FOUNDABLE = new Set([
    "tribe", "clan", "warband", "legion", "gang", "cult", "house", "pack",
    "caravan", "warren", "steading", "master", "creator", "order",
]);

/**
 * And for somebody with a NAME, their community counts too.
 *
 * ⚠️ WITHOUT THIS, THE PEOPLE WHO MATTER MOST STAY ORPHANS. A simulation over
 * Johnny's real data showed The Abbot, Vilnius, Ezmerelda d'Avenir, Ismark
 * Kolyanovich, Clovin Belview and Vasilka all resolving to "commoner", whose
 * faction type is "settlement", which was not on the list above. Every one of
 * them is a named character the party has dealt with, and every deed involving
 * them had nowhere to land.
 *
 * A settlement is only worth founding for somebody with a name of their own.
 * Founding one for a creature called "Bandit" would invent a village of bandits
 * out of a statblock.
 */
const FOUNDABLE_IF_NAMED = new Set(["settlement", "establishment", "guild", "temple", "court"]);

/** Where has this creature actually been? Its territory, not the current scene. */
function _homeOf(actor, memory) {
    try {
        const rec = memory?.npcs?.getRecord?.(actor.name);
        const scenes = rec?.scenes;
        if (Array.isArray(scenes) && scenes.length) return String(scenes[0]);
    } catch (_) { /* the store is optional here */ }
    return canvas?.scene?.name || "an unrecorded place";
}

async function _foundMissingFactions(actors, { worldTag, memory }) {
    const reg = await import("./faction-registry.mjs");
    // classify() consults the compendium index; without this it silently
    // falls back to name-shape and the one-word people stay orphans.
    await loadStatblockNames();
    const founded = [];

    // ── Group by what they are and where they live ──────────────────────────
    const groups = new Map();
    for (const actor of actors) {
        let base = "";
        try { base = reg.resolveCreatureBase(actor); } catch (_) { continue; }
        if (!base) continue;
        const template = reg.getTemplate(base);
        // ⚠️ ASK THE COMPENDIUM, NOT THE SHAPE OF THE WORD. `Vilnius`,
        // `Vasilka` and `Sangzor` are people; `Archmage` and `Rabbit` are
        // statblocks; all five are one capitalised word and no amount of
        // pattern-matching on the string can separate them. classify() asks
        // whether the name ships with the game, which is the only thing that
        // actually knows. looksLikeAPersonalName stays as the fallback for
        // when the compendium index is unavailable.
        let named = false;
        try { named = classify(actor.name, null).kind === "person"; }
        catch (_) { named = looksLikeAPersonalName(actor.name); }
        const worth = FOUNDABLE.has(template?.type)
            || (named && FOUNDABLE_IF_NAMED.has(template?.type));
        if (!worth) continue;

        const home = _homeOf(actor, memory);
        // ⚠️ A settlement is keyed on the PLACE alone, not the species. Ismark
        // and Ezmerelda in the same village belong to the same village; keying
        // on "commoner@@village" and "human@@village" separately would found two.
        const key = FOUNDABLE.has(template?.type) ? `${base}@@${home}` : `home@@${home}`;
        if (!groups.has(key)) groups.set(key, { base, home, template, members: [] });
        groups.get(key).members.push(actor);
    }
    if (!groups.size) return founded;

    console.log(`${TAG} | founding factions for ${groups.size} group(s) of creature that belong to nothing.`);

    for (const { base, home, template, members } of groups.values()) {
        try {
            // Ask once whether something suitable already exists, before inventing.
            const existing = reg.findMatchingFactions(base, worldTag) ?? [];
            const nearby = existing.find(f => String(f.scene || "").toLowerCase() === home.toLowerCase());
            let id = nearby?.id ?? null;
            let name = nearby?.name ?? "";

            if (!id) {
                const identity = await reg.generateFactionIdentity(
                    base, home, worldTag, template, null,
                    existing.slice(0, 6).map(f => f.name).join(", "));

                // The generator is allowed to say "this already exists".
                if (identity?.useExistingName) {
                    const hit = existing.find(f =>
                        (f.name || "").toLowerCase() === identity.useExistingName.toLowerCase());
                    if (hit) { id = hit.id; name = hit.name; }
                }
                if (!id) {
                    const saved = await reg.saveFaction({
                        name:         identity?.name || `The ${base} ${template.type}`,
                        type:         template.type,
                        tier:         template.type,
                        stability:    template.stability,
                        creatureBase: base,
                        worldTag,
                        scene:        home,
                        leader:       identity?.leader || "",
                        purpose:      identity?.purpose || "",
                        lore:         identity?.lore || "",
                        members:      [],
                        allies:       [],
                        enemies:      [],
                        source:       "auto:founded-2026-08-22",
                    });
                    id = saved?.id ?? saved;
                    name = identity?.name || String(id);
                }
            }
            if (!id) {
                console.warn(`${TAG} | could not found a faction for ${base} at ${home}.`);
                continue;
            }

            for (const actor of members) {
                try { await actor.setFlag(MODULE_ID, "factionId", id); }
                catch (err) { console.warn(`${TAG} | could not enrol ${actor.name}:`, err); }
            }
            founded.push(`${name} — ${template.type} of ${base}s at ${home} `
                + `(${members.length} member${members.length === 1 ? "" : "s"}: `
                + members.slice(0, 4).map(a => a.name).join(", ")
                + (members.length > 4 ? ", …" : "") + ")");
        } catch (err) {
            console.warn(`${TAG} | founding a faction for ${base} at ${home} failed:`, err);
        }
    }
    return founded;
}
