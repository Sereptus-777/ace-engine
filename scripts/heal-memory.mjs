// ─── ACE Engine — healing is an act, not a statistic ────────────────────────
//
// Johnny, 2026-08-21, having healed Vilnius in the Amber Temple to keep him
// alive: "is it recorded?"
//
// It was not. The only trace healing left anywhere was a running total on the
// HEALER's character sheet: ACE knew Chudd had healed 240 points in his life
// and had no idea a single one of them went to a dying enemy. It never recorded
// who was healed, whether they were hostile, or where it happened, and if an
// NPC did the healing it was dropped entirely.
//
// What makes that worse is that his history already holds Vilnius's side:
//
//   "Vilnius offered knowledge that could be of use to Chudd, should he choose
//    to spare him."
//
// The plea was written down and the mercy was not. Half a story.
//
// ⚠️ NOT EVERY HEAL IS A DEED. Johnny: "obviously, healing another party member
// isn't a great thing, but it should be noted somehow." Exactly right, and the
// distinction is the whole design:
//
//   HEALING AN ALLY    — a relationship fact. Logged, counted, never a deed.
//                        Who patches up whom is worth knowing (and worth a GM
//                        noticing when one party member is never on the
//                        receiving end) but nobody's reputation grows from it.
//   HEALING AN OUTSIDER — an ACT. A neutral or hostile creature you could have
//                        left to die, and did not. That is a deed, it changes
//                        how that creature speaks to you forever, and it moves
//                        their faction toward you. It is also the only mechanism
//                        in the whole reputation system that moves the ladder
//                        the GOOD way, which until now only ever went down.

const MODULE_ID = "ace-engine";
const QOL_ID    = "ace-qol";
const TAG       = "ACE: Engine | Mercy";

/** Was this creature the party's enemy, or at least not one of them? */
function _standing(actor) {
    if (!actor) return "unknown";
    if (actor.hasPlayerOwner) return "party";
    const tokens = actor.getActiveTokens?.() ?? [];
    const d = tokens[0]?.document?.disposition ?? actor.prototypeToken?.disposition;
    if (d === CONST?.TOKEN_DISPOSITIONS?.HOSTILE)  return "hostile";
    if (d === CONST?.TOKEN_DISPOSITIONS?.FRIENDLY) return "friendly";
    return "neutral";
}

/**
 * Who just healed, best effort.
 * ⚠️ The heal chokepoint knows the TARGET and not the healer, because a heal
 * arrives from a dozen different places. So we look for a healing roll in the
 * last few seconds and take its speaker. When that finds nothing we say
 * "someone" rather than inventing a name — a wrong name in a permanent record
 * is worse than an honest gap.
 */
function _recentHealer(exceptActorId) {
    const now = Date.now();
    const recent = (game.messages?.contents ?? []).slice(-12).reverse();
    for (const m of recent) {
        if (now - (m.timestamp ?? 0) > 8000) break;
        const name = m.speaker?.alias || m.alias;
        if (!name) continue;
        const speakerActor = m.speaker?.actor ? game.actors?.get(m.speaker.actor) : null;
        if (speakerActor?.id && speakerActor.id === exceptActorId) continue;   // healing itself
        const flavour = `${m.flavor ?? ""} ${m.content ?? ""}`.toLowerCase();
        if (/heal|cure wounds|healing word|lay on hands|goodberry|prayer of healing|revivify|spare the dying/.test(flavour)) {
            return { name, actor: speakerActor };
        }
    }
    return { name: "", actor: null };
}

export function installHealMemory({ memory } = {}) {
    Hooks.on(`${QOL_ID}.healApplied`, async (data) => {
        try {
            // ⚠️ Only one client records, or two GMs write it twice.
            if (game.users?.activeGM !== game.user) return;
            const { actor, amount, isCorrection, wasDying } = data ?? {};
            if (!actor || !amount || amount <= 0) return;
            if (isCorrection) return;      // an undo is not an act of mercy

            const standing = _standing(actor);
            const scene    = canvas?.scene?.name ?? "";
            const healer   = _recentHealer(actor.id);
            const who      = healer.name || "Someone";

            // ── Always noted, whoever it was ────────────────────────────────
            const line = standing === "party"
                ? `${who} healed ${actor.name} for ${amount}${wasDying ? ", who was down" : ""}.`
                : `${who} healed ${actor.name}, ${standing === "hostile" ? "an enemy" : "an outsider"}, for ${amount}` +
                  `${wasDying ? " while they lay dying" : ""}.`;
            try { memory?.logNote?.(line, scene); } catch (_) {}

            // ── An ally patched up is a relationship, not a reputation ──────
            if (standing === "party") return;

            // ── An outsider spared is an ACT ────────────────────────────────
            const magnitude = wasDying ? "regional" : "local";
            try {
                memory?.logDeed?.({
                    text: `${who} healed ${actor.name}${wasDying ? ", who was dying" : ""} rather than leaving them to it.`,
                    magnitude,
                    scene,
                    pcs: healer.actor?.hasPlayerOwner ? [healer.name] : [],
                    source: "mercy",
                });
            } catch (_) { /* deed log optional */ }

            // The creature itself remembers. This is what changes how they
            // speak to the party the next time they meet.
            try {
                const prior = actor.getFlag(MODULE_ID, "combatEncounters") ?? [];
                await actor.setFlag(MODULE_ID, "combatEncounters", [...prior, {
                    t: Math.floor(Date.now() / 1000),
                    pcNames: healer.name ? [healer.name] : [],
                    sceneName: scene,
                    outcome: wasDying ? "was saved from death by" : "was healed by",
                    mercy: true,
                }].slice(-20));
            } catch (err) {
                console.warn(`${TAG} | could not record mercy on ${actor.name}:`, err);
            }

            // ── And their faction warms to the party ────────────────────────
            // ⚠️ THE ONLY THING THAT MOVES THIS LADDER UPWARD. Every other
            // input worsens standing; without this, a party can only ever be
            // hated more, never less, which is not a reputation system, it is a
            // decay curve.
            try {
                // ⚠️ Uses the SCORED path, not a private copy of the ladder.
                // This file had its own six-word array, which is exactly how two
                // definitions of the same scale drift apart.
                const factionId = actor.getFlag(MODULE_ID, "factionId");
                const api = game.modules.get(MODULE_ID)?.api;
                if (factionId && api?.adjustFactionScore) {
                    const { MAGNITUDE_POINTS } = await import("./reputation-scale.mjs");
                    const points = wasDying ? MAGNITUDE_POINTS.regional : MAGNITUDE_POINTS.local;
                    const res = await api.adjustFactionScore(factionId, points);
                    if (res) {
                        console.log(`${TAG} | ${actor.name}'s faction: ${res.from} → ${res.to}` +
                                    `${res.changed ? ` (now ${res.band})` : ""} — they were spared.`);
                    }
                }
            } catch (err) {
                console.warn(`${TAG} | faction standing could not be improved:`, err);
            }

            ui.notifications?.info(
                `${who} healed ${actor.name}, who is not one of the party. ` +
                `They will remember it${wasDying ? ", and they were dying" : ""}.`);
            console.log(`${TAG} | ${line}`);
        } catch (err) {
            console.warn(`${TAG} | heal record failed:`, err);
        }
    });
    console.debug(`${TAG} | healing an outsider is now recorded as an act`);
}
