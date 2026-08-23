// ─── ACE Engine — give NPCs back the fights they already survived ───────────
//
// ⚠️ WHY. `combatEncounters` was read in three places and written in none, so
// no creature in Johnny's five-month campaign has ever remembered fighting his
// party. Fixing the writer only helps from the next combat onward, and he asked
// the obvious question: "What about fixing whatever has happened so far?"
//
// It can be reconstructed, because the history file already holds it:
//
//   {"k":"combat_end","t":1773192907,"s":"BM: Argynvostholt 3F",
//    "p":["Spectral Dire Wolf (King)","Chudd Buckland","Firaxis Greenbeard",
//         "Jeth","Syrax Razeson","Vladimir Horngaard","Virric Vaesoldandros"]}
//
// Thirty combats, seventy-five kills, every one stamped with a scene and a
// time. Vladimir Horngaard fought the party at Argynvostholt and has no idea.
//
// ⚠️ WHAT IT CANNOT DO, and says so rather than pretending. It can only reach
// creatures that STILL EXIST as actors and whose names still match. A "Bandit
// Captain" token deleted four months ago is gone, and three tokens that shared
// that name cannot be told apart from a name in a log. So this recovers the
// NAMED, surviving cast — which is exactly the set anyone would want, because
// those are the ones the party will meet again.
//
// ⚠️ AND IT NEVER INVENTS A FIGHT. A creature is only credited with a combat it
// is actually listed in, and is skipped entirely if it was killed in that same
// fight.

const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | Combat memory backfill";
const DONE_FLAG = "combatMemoryBackfill2026";

/** Kills in the same scene within an hour either side count as that fight's dead. */
const SAME_FIGHT_SECONDS = 3600;

function _norm(n) {
    return String(n || "").toLowerCase()
        .replace(/\s*\([^)]*\)\s*/g, " ")     // "(King)", "(Copy)"
        .replace(/\s*#?\s*\d+\s*$/g, "")      // trailing numbers
        .replace(/\s+/g, " ").trim();
}

/**
 * @param {object}  opts
 * @param {object}  opts.memory   the live ACE memory manager (it owns the log)
 * @param {boolean} [opts.dryRun]
 */
export async function backfillCombatMemory({ memory, dryRun = false } = {}) {
    if (!game.user?.isGM) return null;
    if (!dryRun) {
        try { if (game.settings.get(MODULE_ID, DONE_FLAG)) return null; } catch (_) { return null; }
    }

    const history = memory?.history?.events ?? [];
    if (!Array.isArray(history) || !history.length) {
        console.log(`${TAG} | no history to read.`);
        return null;
    }

    const combats = history.filter(e => e?.k === "combat_end" && Array.isArray(e.p) && e.p.length);
    const kills   = history.filter(e => e?.k === "kill" && e.tgt);
    if (!combats.length) return null;

    // Every actor in the world, by normalised name. Ambiguous names are dropped
    // rather than guessed at: crediting the wrong Bandit Captain is worse than
    // crediting none.
    const byName = new Map();
    const ambiguous = new Set();
    for (const a of (game.actors ?? [])) {
        const key = _norm(a.name);
        if (!key) continue;
        if (byName.has(key)) { ambiguous.add(key); continue; }
        byName.set(key, a);
    }
    for (const k of ambiguous) byName.delete(k);

    const pending = new Map();   // actor -> encounters[]
    let unreachable = 0, ambiguousHits = 0;

    for (const c of combats) {
        const pcs = [], npcs = [];
        for (const name of c.p) {
            const key = _norm(name);
            if (ambiguous.has(key)) { ambiguousHits++; continue; }
            const actor = byName.get(key);
            if (!actor) { unreachable++; continue; }
            if (actor.hasPlayerOwner) pcs.push(name);
            else npcs.push({ actor, name });
        }
        if (!pcs.length || !npcs.length) continue;

        // Who died in this fight, so the memory carries what it cost them.
        const dead = new Set(
            kills.filter(k => k.s === c.s && Math.abs((k.t ?? 0) - (c.t ?? 0)) <= SAME_FIGHT_SECONDS)
                 .map(k => _norm(k.tgt)));

        for (const { actor, name } of npcs) {
            // ⚠️ Skip anyone who died in that very fight. They were there; they
            // are not going to bring it up.
            if (dead.has(_norm(name))) continue;
            const alliesLost = [...dead].filter(d => d !== _norm(name)).length;
            const list = pending.get(actor) ?? [];
            list.push({
                t:          c.t ?? 0,
                pcNames:    pcs,
                sceneName:  c.s || "",
                outcome:    alliesLost > 0 ? "watched allies die in" : "survived",
                alliesLost,
                recovered:  true,      // marked, so it is clear this came from the log
            });
            pending.set(actor, list);
        }
    }

    const written = [];
    for (const [actor, encounters] of pending) {
        try {
            const prior = actor.getFlag(MODULE_ID, "combatEncounters") ?? [];
            // Do not duplicate anything a live combat already recorded.
            const known = new Set(prior.map(e => `${e.t}|${e.sceneName}`));
            const fresh = encounters.filter(e => !known.has(`${e.t}|${e.sceneName}`));
            if (!fresh.length) continue;
            const merged = [...prior, ...fresh].sort((a, b) => (a.t ?? 0) - (b.t ?? 0)).slice(-20);
            if (!dryRun) await actor.setFlag(MODULE_ID, "combatEncounters", merged);
            written.push(`${actor.name} — ${fresh.length} fight${fresh.length === 1 ? "" : "s"}`);
        } catch (err) {
            console.warn(`${TAG} | could not write memory for ${actor.name}:`, err);
        }
    }

    // ⚠️ Only settle if we genuinely had a world to read. Running before the
    // actor directory is populated would find nothing, write nothing, and then
    // mark the job done forever — which is precisely how the faction repair
    // left fifteen factions on "hated" tonight.
    const hadAWorld = (game.actors?.size ?? 0) > 0;
    if (!dryRun && hadAWorld) { try { await game.settings.set(MODULE_ID, DONE_FLAG, true); } catch (_) {} }
    if (!dryRun && !hadAWorld) {
        console.error(`${TAG} | there were no actors loaded, so nothing could be matched. ` +
                      `Leaving this unmarked so it runs again next load.`);
    }

    const lines = [`${TAG} | read ${combats.length} recorded combats.`];
    if (written.length) lines.push(`  gave memories back to ${written.length} creature(s):`, ...written.map(w => "    " + w));
    if (unreachable)    lines.push(`  ${unreachable} participant mention(s) no longer exist as actors — nothing to write to.`);
    if (ambiguousHits)  lines.push(`  ${ambiguousHits} mention(s) matched several actors sharing a name — skipped rather than guessed.`);
    console.log(lines.join("\n"));

    if (!dryRun && written.length) {
        ui.notifications?.info(
            `ACE Engine recovered combat memories for ${written.length} creature(s) from ${combats.length} past fights. ` +
            `They now remember your party. Full list in the console.`, { permanent: true });
    }
    return { combats: combats.length, written, unreachable, ambiguousHits };
}
