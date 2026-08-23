// ─── ACE Engine — undo the mislabelled factions ─────────────────────────────
//
// ⚠️ WHY. `_inferCreatureBase` used to read a faction's DESCRIPTION, and a
// description is where a faction names its ENEMIES. So:
//
//   Royal Guard of Damara — "renowned for their skill in COMBATING UNDEAD"
//   Followers of the Morninglord — "They oppose Strahd and his VAMPIRE spawn"
//
// were both stamped `creatureBase: "undead"`. Kin propagation then did exactly
// what it was designed to do: every undead the party killed in Barovia spread
// word "among their own kind" and worsened everyone sharing that base. Nine of
// Johnny's organisations, including a church of the sun god, ended up HATING his
// party for killing vampires. The factions most committed to destroying undead
// were the most likely to say so, and so the most likely to be turned against
// the party. Nothing the players did earned any of it.
//
// The source is fixed. This repairs what it already wrote.
//
// ⚠️ IT RE-READS EVERY TAG RATHER THAN GUESSING WHICH ARE SALVAGEABLE.
// My first attempt scored each existing tag against an "are they fighting it"
// heuristic and kept the rest. It still let Red Wizards of Thay through as
// undead, The Harpers as fiends, the Vistani as monstrosities and the Wachter
// family as orcs, because those descriptions mention a creature without any
// fighting word nearby. All 115 tags came out of the same broken reader, so all
// 115 get read again with the fixed one. "Orc Legion" and "Drow Houses" survive
// because their NAMES say so; nothing else does.
//
// ⚠️ AND EVERY STANDING GOES BACK TO NEUTRAL, not just the retagged ones.
// Each was produced by kin propagation acting on a broken tag, so none of them
// records anything the party did. Johnny, told what that costs: "We can redo it
// so that it works properly."
//
// ⚠️ IT SAYS WHAT IT CHANGED, names every faction, and only ever runs once.

import { inferCreatureBase } from "./faction-registry.mjs";

const MODULE_ID  = "ace-engine";
const TAG        = "ACE: Engine | Faction repair";
const DONE_FLAG  = "factionBaseRepair2026";

/** Poll briefly for the module API. Returns null if it never arrives. */
async function _waitForApi(ms = 15000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const api = game.modules.get(MODULE_ID)?.api;
        if (api?.getFactionStanding && api?.setFactionStanding) return api;
        await new Promise(r => setTimeout(r, 250));
    }
    return null;
}

export async function repairFactionCreatureBases({ dryRun = false } = {}) {
    if (!game.user?.isGM) return null;
    // ⚠️ ONE CLIENT ONLY. `isGM` is true on EVERY connected GM, so with two GMs
    // at the table this ran twice, both writing the same world registry, and
    // whichever finished last silently clobbered the other. That is the same
    // shape as the 2026-08-15 save-template bug: a defect that appears and
    // disappears with no code change, because it depends on who is logged in.
    if (game.users?.activeGM !== game.user) return null;
    if (!dryRun) {
        try { if (game.settings.get(MODULE_ID, DONE_FLAG)) return null; } catch (_) { return null; }
    }

    let registry;
    try { registry = foundry.utils.deepClone(game.settings.get(MODULE_ID, "factionRegistry") ?? {}); }
    catch (_) { return null; }
    const ids = Object.keys(registry);
    if (!ids.length) return null;

    const stripped = [];   // { name, was, why }
    const kept     = [];   // { name, base }

    for (const id of ids) {
        const f = registry[id];
        if (!f || typeof f !== "object") continue;
        // ⚠️ DO NOT UNDO THE COMPOSITION PASS. It runs after this one and fills
        // every empty base from real evidence — members in the world, then the
        // name, then a marked assumption. Re-running the repair over its answers
        // would strip "human" back off the Royal Guard of Damara, because the
        // NAME does not say human, and the two passes would fight each other
        // every load. A faction composition has spoken for is settled.
        if (f.compositionWhy) continue;

        const was = String(f.creatureBase || "").trim().toLowerCase();
        // ⚠️ Recompute with the FIXED rule rather than trying to guess which
        // old tags were salvageable. A first attempt scored each tag against an
        // "are they fighting it" heuristic and still let Red Wizards of Thay
        // through as undead, The Harpers as fiends and the Vistani as
        // monstrosities. Every one of these 115 tags came out of a broken
        // reader, so every one gets read again properly.
        const now = inferCreatureBase(f);
        if (now === was) { if (was) kept.push({ name: f.name || id, base: was }); continue; }

        stripped.push({ id, name: f.name || id, was: was || "(none)", why: now ? `now ${now}` : "the name does not say they are that creature" });
        f.creatureBase = now;
    }

    // ⚠️ EVERY standing goes back to neutral, not only the ones we retagged.
    // All of them were produced by kin propagation reading the broken tags, so
    // none of them reflects anything the party actually did. Johnny, told what
    // it would cost: "We can redo it so that it works properly." From here the
    // ladder means something.
    // ⚠️🔴 WAIT FOR THE API, AND DO NOT MARK THE JOB DONE WITHOUT IT (2026-08-22).
    //
    // This read `game.modules.get(MODULE_ID)?.api` at the top of a ready
    // handler registered BEFORE the one that builds that api. Foundry runs
    // ready handlers in registration order, so the api did not exist yet, the
    // whole standing reset was skipped by an `if`, and the one-shot flag was
    // set anyway. Result: Johnny's factions were correctly retagged and all
    // fifteen stayed on "hated" forever, with nothing in the log to say why.
    //
    // A guard that silently skips work and then records the work as complete is
    // worse than a crash. Now it waits, and if the api never arrives it says so
    // and leaves the flag UNSET so the next load tries again.
    const reset = [];
    const api = await _waitForApi();
    if (!dryRun && !api) {
      console.error(`${TAG} | the module API never appeared, so standings were NOT reset. ` +
                    `Leaving this repair unmarked so it runs again next load.`);
      ui.notifications?.warn("ACE Engine: faction tags were repaired but standings could not be reset. It will retry on next load.");
      if (stripped.length) await game.settings.set(MODULE_ID, "factionRegistry", registry);
      return { checked: ids.length, stripped, kept: kept.length, reset: [], incomplete: true };
    }
    if (!dryRun && api?.getFactionStanding && api?.setFactionStanding) {
        for (const id of ids) {
            try {
                const cur = api.getFactionStanding(id);
                if (cur && cur !== "neutral") {
                    await api.setFactionStanding(id, "neutral");
                    reset.push(`${registry[id]?.name || id} (${cur})`);
                }
            } catch (_) { /* a standing we cannot read is one we leave alone */ }
        }
    }

    if (!dryRun && stripped.length) {
        await game.settings.set(MODULE_ID, "factionRegistry", registry);
    }
    if (!dryRun) {
        try { await game.settings.set(MODULE_ID, DONE_FLAG, true); } catch (_) {}
    }

    // ── Say it, and name names ──────────────────────────────────────────────
    const lines = [`${TAG} | checked ${ids.length} factions.`];
    if (stripped.length) {
        lines.push(`  removed a wrong creature tag from ${stripped.length}:`);
        for (const s of stripped) lines.push(`    "${s.name}" was tagged ${s.was} — ${s.why}`);
    }
    if (kept.length) {
        lines.push(`  left ${kept.length} correct tags alone, e.g. ` +
                   kept.slice(0, 5).map(k => `${k.name} (${k.base})`).join(", "));
    }
    if (reset.length) {
        lines.push(`  reset ${reset.length} standing(s) the party never earned: ${reset.join(", ")}`);
    }
    console.log(lines.join("\n"));

    if (!dryRun && (stripped.length || reset.length)) {
        ui.notifications?.info(
            `ACE Engine re-read ${stripped.length} faction creature tag${stripped.length === 1 ? "" : "s"} that had been taken from descriptions of who they FIGHT` +
            (reset.length ? `, and reset ${reset.length} standing${reset.length === 1 ? "" : "s"} your party never earned` : "") +
            `. ${kept.length} correct tags were left alone. Full list in the console.`,
            { permanent: true });
    }
    return { checked: ids.length, stripped, kept: kept.length, reset };
}
