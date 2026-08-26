// ─── Put the creature names back ─────────────────────────────────────────────
//
// ⚠️ WHY THIS EXISTS. Between 2026-08-06 and 2026-08-23, ACE renamed linked
// NPCs for real: the actor, its prototype token and the canvas token were all
// rewritten to the AI-generated name. "Goblin Crookshank" became "Gruk
// Skullsplitter" on the sheet.
//
// That violated a rule Johnny had already settled on 2026-07-10 and written
// down as final — the sheet, prototype and token always carry the CREATURE's
// name, and a generated name lives in the flavorName flag and shows on the
// NAMEPLATE only. Renaming the sheet breaks things a long way from here:
// creature identity, the spell pipeline, the Multiattack parser, token art
// lookups, and every journal that refers to the creature by name.
//
// The rename is removed. This puts back what it already did.
//
// ⚠️ NOTHING IS LOST. The name currently on the sheet is not discarded — it is
// moved into flavorName, which is where it should have been all along. The
// creature goes back to being a goblin; the party still knows him as Gruk.
//
// ⚠️ IT REPORTS FIRST AND CHANGES NOTHING UNTIL ASKED. A pass that silently
// rewrites every actor in somebody's world is not a repair.
const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Name restore";

/**
 * Did ACE rename this document, and is it still renamed?
 *
 * ⚠️ THE SIGNATURE HAS TO BE PRECISE, because the cost of a false positive is
 * renaming a creature the GM named deliberately. Three things must all hold:
 *
 *   • an `originalName` flag exists — ACE stamped what it was called before
 *   • the current name DIFFERS from it — so it is still renamed
 *   • there is NO flavorName — the rename path deliberately cleared that flag,
 *     while the correct path SETS it. Its absence is what separates "ACE
 *     renamed this" from "ACE left this alone and stored a nameplate name".
 *
 * `originalName` alone is not enough: the promotion path stamps it too, without
 * ever renaming anything, so matching on it would drag in every persistent NPC
 * in the world.
 */
function wasRenamed(doc) {
    try {
        const original = doc?.getFlag?.(MODULE_ID, "originalName");
        if (!original) return null;
        const current = String(doc.name ?? "").trim();
        if (!current || current === String(original).trim()) return null;
        if (doc.getFlag(MODULE_ID, "flavorName")) return null;
        return String(original).trim();
    } catch (_) {
        return null;
    }
}

/**
 * Restore every creature ACE renamed.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.fix=false] write the changes
 */
export async function restoreCreatureNames({ fix = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications?.warn("Only the GM can restore creature names.");
        return { found: 0, rows: [] };
    }

    const rows = [];

    // ── World actors ─────────────────────────────────────────────────────
    for (const actor of (game.actors ?? [])) {
        const original = wasRenamed(actor);
        if (!original) continue;
        rows.push({ kind: "actor", doc: actor, from: actor.name, to: original, where: "sidebar" });
    }

    // ── Tokens on every scene ────────────────────────────────────────────
    //
    // ⚠️ A TOKEN CARRIES ITS OWN NAME. Restoring the actor does not touch a
    // token already placed, so a scene would keep showing the renamed label
    // while the sheet said something else — worse than either state alone.
    // Unlinked tokens hold their flags in a delta and are checked in their own
    // right; linked ones follow whatever their actor was renamed to.
    const renamedActorIds = new Map(rows.filter(r => r.kind === "actor").map(r => [r.doc.id, r.to]));
    for (const scene of (game.scenes ?? [])) {
        for (const token of (scene.tokens ?? [])) {
            if (token.actorLink) {
                const target = renamedActorIds.get(token.actorId);
                if (target && String(token.name).trim() !== target) {
                    rows.push({ kind: "token", doc: token, from: token.name, to: target, where: scene.name });
                }
                continue;
            }
            const original = wasRenamed(token.actor) ?? wasRenamed(token);
            if (original && String(token.name).trim() !== original) {
                rows.push({ kind: "token", doc: token, from: token.name, to: original, where: scene.name });
            }
        }
    }

    console.log(`${TAG} | ${fix ? "RESTORING" : "DRY RUN —"} ${rows.length} renamed creature(s).`);
    console.log("=".repeat(84));
    for (const r of rows) {
        console.log(`   ${r.kind.padEnd(6)} "${r.from}"  ->  "${r.to}"   (${r.where})`
            + `   the party still knows it as "${r.from}"`);
    }
    console.log("=".repeat(84));

    if (!rows.length) {
        console.log(`${TAG} | No creature carries a name ACE gave it. Nothing to restore.`);
        ui.notifications?.info("ACE: no renamed creatures found — every sheet already shows its creature name.");
        return { found: 0, rows: [] };
    }

    if (!fix) {
        console.log(`${TAG} | Nothing was changed. Run again with { fix: true } to restore them.`);
        console.log(`${TAG} | Each creature's current name is kept as its nameplate name, so nothing is lost.`);
        ui.notifications?.warn(`ACE: ${rows.length} creature(s) carry an AI name on the sheet. `
            + `See the console (F12); nothing was changed.`);
        return { found: rows.length, rows };
    }

    let done = 0, failed = 0;
    for (const r of rows) {
        try {
            if (r.kind === "actor") {
                // ⚠️ THE FLAG GOES ON FIRST. If the update succeeded and the flag
                // write then failed, the name the party knows would be gone with
                // nothing left pointing at it. Ordered so the worst outcome is a
                // creature that still shows its AI name — recoverable — rather
                // than one whose AI name no longer exists anywhere.
                await r.doc.setFlag(MODULE_ID, "flavorName", r.from);
                await r.doc.setFlag(MODULE_ID, "nameRevealed", true);
                await r.doc.update({ name: r.to, "prototypeToken.name": r.to });
            } else {
                // A token's nameplate is driven by the flag, so the visible name
                // does not change for the table — only the underlying label.
                try { await r.doc.actor?.setFlag?.(MODULE_ID, "flavorName", r.from); } catch (_) { /* linked actor already has it */ }
                await r.doc.update({ name: r.to, displayName: 50 });
            }
            done++;
        } catch (err) {
            failed++;
            console.warn(`${TAG} | Could not restore "${r.from}":`, err);
        }
    }

    console.log(`${TAG} | ${done} restored${failed ? `, ${failed} FAILED — see the warnings above` : ""}.`);
    ui.notifications?.info(`ACE: restored ${done} creature name(s). `
        + `Their AI names are now nameplate-only, which is where they belong.`);
    return { found: rows.length, restored: done, failed, rows };
}
