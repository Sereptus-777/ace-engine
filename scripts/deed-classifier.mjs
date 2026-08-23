// ─── ACE Engine — make five months of deeds count ───────────────────────────
//
// Johnny has 187 recorded deeds and a reputation that has never moved for any
// of them, because a deed had no notion of good or bad and nothing was wired
// to the ladder except a kill. The code is fixed from here. This is the
// back-catalogue.
//
// It reads every deed already in the history log, asks the AI once whether each
// was heroic, villainous or neither, works out which faction it concerned, and
// applies the result.
//
// ⚠️ AT REDUCED WEIGHT, AND THIS MATTERS. Applying 187 deeds at full strength
// would peg every faction in the world at an extreme, which is exactly as wrong
// as the all-hated state we just repaired. Five months of accumulated goodwill
// is a REPUTATION, not a single act, and reputations settle rather than spike.
// So retroactive deeds land at a third of their weight. The shape of the
// history survives; the magnitude does not overwhelm everything that follows.
//
// ⚠️ IT NEVER GUESSES A FACTION. A deed whose subject cannot be matched against
// a real faction in the registry is classified and counted and moves nothing,
// and the report says how many of those there were. Attributing a rescue to the
// wrong people is worse than attributing it to nobody.

import { MAGNITUDE_POINTS } from "./reputation-scale.mjs";
import { getAllFactions } from "./npc/faction-registry.mjs";

const MODULE_ID  = "ace-engine";
const TAG        = "ACE: Engine | Deed history";
const DONE_FLAG  = "deedClassification2026";
const BATCH      = 25;
const RETRO_WEIGHT = 1 / 3;

const SYSTEM = `You classify things a party did in a Dungeons & Dragons campaign.
For each numbered entry reply with one line: the number, a pipe, then exactly one of
HEROIC, VILLAINOUS or NEUTRAL, then a pipe, then the name of the group or person it
most concerns, or NONE.

HEROIC: rescuing, sparing, healing, protecting, keeping a promise, giving freely.
VILLAINOUS: murder of the helpless, betrayal, theft from the innocent, cruelty.
NEUTRAL: everything else, including ordinary combat, travel, trade and discovery.

Reply with nothing but those lines.`;

function _parse(reply, batch) {
    const out = new Map();
    for (const raw of String(reply || "").split(/\r?\n/)) {
        // ⚠️ BE GENEROUS ABOUT SHAPE. The model answered correctly and my first
        // regex threw all 192 answers away because it insisted on one layout.
        // What actually came back, in the same run:
        //
        //     1. 1 | HEROIC | Firaxis Greenbeard      <- its list number AND mine
        //     1.  NEUTRAL | NONE                      <- its number, mine dropped
        //     10. VILLAINOUS | Orc                    <- no pipe after the number
        //
        // A model asked for "one line each" will wrap them in a markdown list
        // roughly half the time, and no amount of instruction reliably stops
        // that. The parser is the right place to absorb it, because a strict
        // parser turns a correct answer into silence.
        const m = raw.match(/^\s*(?:(\d+)\s*[.)]\s*)?(?:(\d+)\s*\|\s*)?(HEROIC|VILLAINOUS|NEUTRAL)\b\s*(?:\|\s*(.*))?$/i);
        if (!m) continue;
        const n = m[2] ?? m[1];
        if (n === undefined) continue;
        const idx = Number(n) - 1;
        if (!batch[idx]) continue;
        const subject = (m[4] || "").trim();
        out.set(batch[idx], {
            valence: m[3].toLowerCase(),
            subject: /^none$/i.test(subject) ? "" : subject,
        });
    }
    return out;
}

/**
 * A creature's name to the faction it belongs to.
 *
 * ⚠️ THE MODEL NAMES PEOPLE, NOT ORGANISATIONS, and of course it does — the
 * deeds are written about people. Its answers were "Vilnius", "The Abbot",
 * "Firaxis Greenbeard", "Bullywug". Matching those against a registry of
 * faction names finds nothing, so a perfectly good classification would still
 * have moved not one standing.
 *
 * ⚠️ AND A PLAYER CHARACTER IS SKIPPED. Half the deeds name the party, and the
 * party is not a faction that can hold an opinion of itself.
 */
function _matchCreatureFaction(name, all) {
    const t = String(name || "").trim();
    if (t.length < 3) return null;
    const norm = (x) => String(x || "").toLowerCase()
        .replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s*#?\s*\d+\s*$/g, "")
        .replace(/\s+/g, " ").trim();
    const target = norm(t);
    let hit = null;
    for (const a of (game.actors ?? [])) {
        if (norm(a.name) !== target) continue;
        if (a.hasPlayerOwner) return null;        // the party, not a faction
        hit = a; break;
    }
    if (!hit) return null;
    try {
        const fid = hit.getFlag("ace-engine", "factionId");
        if (fid && all[fid]) return fid;
    } catch (_) { /* unreadable actor */ }
    return null;
}

/** Match a name the AI gave us to a faction we actually hold. */
function _matchFaction(name, all) {
    const norm = (t) => String(t || "").toLowerCase().replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]/g, "");
    const target = norm(name);
    if (!target || target.length < 3) return null;
    for (const [id, f] of Object.entries(all)) {
        if (norm(f?.name) === target) return id;
    }
    // A containment match, but only one way and only for long names, so "guard"
    // does not attach a rescue to every watch company in the world.
    if (target.length >= 6) {
        for (const [id, f] of Object.entries(all)) {
            const n = norm(f?.name);
            if (n.length >= 6 && (n.includes(target) || target.includes(n))) return id;
        }
    }
    return null;
}

export async function classifyDeedHistory({ memory, aiProvider, dryRun = false } = {}) {
    if (!game.user?.isGM) return null;
    if (game.users?.activeGM !== game.user) return null;
    if (!dryRun) {
        try { if (game.settings.get(MODULE_ID, DONE_FLAG)) return null; } catch (_) { return null; }
    }
    if (!aiProvider) {
        console.warn(`${TAG} | no AI provider — cannot classify past deeds.`);
        return null;
    }

    const deeds = (memory?.history?.events ?? []).filter(e => e?.k === "deed" && e.txt);
    if (!deeds.length) return null;

    const all = getAllFactions() ?? {};
    // ⚠️ WAIT FOR IT. Reading the api once, early, is what stopped the faction
    // repair from resetting a single standing. Classifying 192 deeds correctly
    // and then having nowhere to put the result would be the same failure in a
    // more expensive costume.
    let api = game.modules.get(MODULE_ID)?.api;
    for (let waited = 0; !api?.adjustFactionScore && waited < 15000; waited += 250) {
        await new Promise(r => setTimeout(r, 250));
        api = game.modules.get(MODULE_ID)?.api;
    }
    if (!api?.adjustFactionScore) {
        console.error(`${TAG} | the module API never appeared. Not classifying, and not marking this done.`);
        return null;
    }
    const tally = { heroic: 0, villainous: 0, neutral: 0, unmatched: 0, moved: 0 };
    const perFaction = new Map();

    ui.notifications?.info(`ACE Engine is reading back ${deeds.length} past deeds. This takes a moment and happens once.`);

    for (let i = 0; i < deeds.length; i += BATCH) {
        const batch = deeds.slice(i, i + BATCH);
        const prompt = batch.map((d, n) => `${n + 1}. ${String(d.txt).slice(0, 220)}`).join("\n");
        let reply = "";
        try {
            if (typeof aiProvider.complete === "function") {
                reply = await aiProvider.complete(SYSTEM, prompt);
            } else if (typeof aiProvider.chat === "function") {
                // ⚠️ chat()'s SECOND argument is scene context, not a system
                // prompt. Passing the instructions there and hoping is how the
                // first run classified 192 deeds as nothing at all. Put the
                // instructions in the message itself.
                reply = await aiProvider.chat(`${SYSTEM}

---

${prompt}`);
            } else {
                console.error(`${TAG} | the AI provider has neither complete() nor chat() — cannot classify.`);
                return null;
            }
        } catch (err) {
            console.warn(`${TAG} | batch ${i / BATCH + 1} failed:`, err);
            continue;
        }

        const parsed = _parse(reply, batch);
        // ⚠️🔴 REPORT THE OUTCOME, NOT THE ATTEMPT. The first version printed
        // "read 192 past deeds" and a row of zeroes, which reads like a result
        // and was actually total failure: every reply parsed to nothing and
        // nobody could tell, because the only number shown was how many were
        // READ. If a batch yields nothing, show what came back instead.
        if (!parsed.size) {
            console.warn(`${TAG} | batch ${i / BATCH + 1} of ${Math.ceil(deeds.length / BATCH)} ` +
                         `parsed to NOTHING. First 400 characters of what the model actually returned:
` +
                         String(reply ?? "").slice(0, 400));
            tally.unparsed = (tally.unparsed ?? 0) + batch.length;
        }

        for (const [deed, verdict] of parsed) {
            tally[verdict.valence] = (tally[verdict.valence] ?? 0) + 1;
            if (verdict.valence === "neutral") continue;

            // A faction by name first, then the creature's own faction.
            const factionId = _matchFaction(verdict.subject, all)
                           ?? _matchCreatureFaction(verdict.subject, all);
            if (!factionId) { tally.unmatched++; continue; }

            // Historical deeds carry no magnitude, so treat them as local acts:
            // the safe assumption, and 187 of them still add up.
            const pts = Math.round(MAGNITUDE_POINTS.local * RETRO_WEIGHT)
                      * (verdict.valence === "heroic" ? 1 : -1);
            perFaction.set(factionId, (perFaction.get(factionId) ?? 0) + pts);
        }
    }

    const changes = [];
    if (!dryRun && api?.adjustFactionScore) {
        for (const [id, delta] of perFaction) {
            if (!delta) continue;
            const res = await api.adjustFactionScore(id, delta);
            if (!res) continue;
            tally.moved++;
            changes.push(`${all[id]?.name || id}: ${res.from} → ${res.to} (${res.band})`);
        }
    }

    // ⚠️ Only mark it done if it actually did something. A pass that classified
    // nothing has not "completed", and flagging it would mean it never retries.
    const didSomething = (tally.heroic + tally.villainous + tally.neutral) > 0;
    if (!dryRun && didSomething) { try { await game.settings.set(MODULE_ID, DONE_FLAG, true); } catch (_) {} }
    if (!dryRun && !didSomething) {
        console.error(`${TAG} | classified NOTHING out of ${deeds.length} deeds. Not marking this done; ` +
                      `it will run again next load. See the batch warnings above for what the model returned.`);
    }

    const lines = [
        `${TAG} | read ${deeds.length} past deeds.`,
        `  heroic ${tally.heroic} · villainous ${tally.villainous} · neither ${tally.neutral}`,
        `  ${tally.unmatched} concerned nobody we hold a faction for — counted, moved nothing.`,
        ...(tally.unparsed ? [`  ⚠️ ${tally.unparsed} deed(s) came back in a form we could not read.`] : []),
        ...(changes.length ? ["  standings changed:", ...changes.map(c => "    " + c)] : []),
    ];
    console.log(lines.join("\n"));

    if (!dryRun && didSomething) {
        ui.notifications?.info(
            `ACE Engine read back ${deeds.length} past deeds: ${tally.heroic} heroic, ${tally.villainous} villainous. ` +
            `${tally.moved} faction${tally.moved === 1 ? "" : "s"} changed their view of your party. Full list in the console.`,
            { permanent: true });
    }
    return { deeds: deeds.length, ...tally, changes };
}
