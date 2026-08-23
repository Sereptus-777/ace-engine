// ─── ACE: Engine — Promotion: a creature someone TALKED TO becomes real ─────
//
// Johnny, 2026-08-07: "you didn't mention linked tokens. As soon as somebody
// talks to someone, that fucking thing becomes a linked token immediately."
//
// He is right, and it is the structural hole under the whole identity feature.
//
// Nine goblins dropped from a compendium are nine UNLINKED tokens sharing one
// "Goblin" actor, each carrying its own delta. A biography written there lives
// in that token's private data: delete the token and the person is gone. No
// sidebar row, no reuse, nothing survives the encounter. You cannot build a
// dungeon out of characters that evaporate.
//
// It also breaks the rename that already exists in bio-generator, which is
// deliberately LINKED-ONLY — and correctly so, because renaming a shared base
// actor would rename all nine goblins at once. Promotion is the missing piece
// that makes that rename correct for the unlinked case: once this creature owns
// its own actor, renaming it affects nobody else.
//
// ⚠️ PROMOTION HAPPENS BEFORE THE AI RUNS, NOT AFTER. Contact is what makes a
// creature a person — not whether a generation call succeeded. If the AI is
// down you still have a real actor and a button to try again, instead of a
// half-written identity trapped in a token delta.
//
// ⚠️ THE OTHER EIGHT GOBLINS ARE NEVER TOUCHED. They keep pointing at the
// shared base actor and stay as disposable as they were.

import { resolveSpecies } from "./npc-identity.mjs";

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Promotion";

/** Where promoted characters live, so the sidebar does not turn into a swamp. */
export const NAMED_FOLDER = "ACE — Named NPCs";

/**
 * Find or create an Actor folder by name, optionally nested.
 * Never throws — a missing folder is a cosmetic problem, not a reason to lose
 * the character.
 */
async function _ensureFolder(name, parentId = null) {
    if (!name) return null;
    try {
        const existing = game.folders?.find(f =>
            f.type === "Actor" && f.name === name && (f.folder?.id ?? null) === parentId);
        if (existing) return existing;
        return await Folder.create({ name, type: "Actor", folder: parentId, sorting: "a" });
    } catch (err) {
        console.warn(`${TAG} | Could not create the "${name}" folder (the actor will sit at the root):`, err);
        return null;
    }
}

/**
 * Has this creature already been promoted to its own persistent actor?
 * A linked token always has its own sidebar row, so it counts as promoted even
 * if ACE was not the one that made it.
 */
export function isPromoted(tokenDocument) {
    const actor = tokenDocument?.actor;
    if (!actor) return false;
    if (actor.getFlag(MODULE_ID, "promoted")) return true;
    return !!tokenDocument.actorLink;
}

/**
 * Turn a disposable token into a persistent, named, linked character.
 *
 * @param {TokenDocument} tokenDocument
 * @param {{factionName?: string, reason?: string}} [opts]
 * @returns {Promise<{actor: Actor|null, promoted: boolean, reason: string}>}
 */
export async function promoteToNamedActor(tokenDocument, opts = {}) {
    const { factionName = "", reason = "spoken to" } = opts;

    if (!game.user?.isGM) {
        return { actor: null, promoted: false, reason: "only the GM can create actors" };
    }
    if (!tokenDocument) {
        return { actor: null, promoted: false, reason: "no token" };
    }

    const src = tokenDocument.actor;
    if (!src) {
        return { actor: null, promoted: false, reason: "token has no actor" };
    }

    // A player character is never promoted, copied, renamed or folded away.
    if (src.type === "character") {
        return { actor: src, promoted: false, reason: "player characters are left alone" };
    }

    // Already its own row — mark it and stop. This covers both a creature ACE
    // promoted earlier and a unique NPC the GM built and linked by hand, which
    // must NOT be duplicated.
    if (tokenDocument.actorLink || src.getFlag(MODULE_ID, "promoted")) {
        if (!src.getFlag(MODULE_ID, "promoted")) {
            try { await src.setFlag(MODULE_ID, "promoted", true); } catch (_) { /* cosmetic */ }
        }
        return { actor: src, promoted: false, reason: "already has its own actor" };
    }

    // ── Build the new actor from the token's CURRENT state ───────────────
    // src is the synthetic actor for an unlinked token, so its source already
    // has the delta folded in: current hit points, active conditions, anything
    // added to its pockets since it was dropped. Copying the BASE actor instead
    // would silently heal it and strip its conditions.
    let data;
    const srcUuid = src.uuid ?? null;   // needed to repair effect origins below
    try {
        data = src.toObject();
    } catch (err) {
        console.error(`${TAG} | Could not read the token's current state:`, err);
        return { actor: null, promoted: false, reason: "could not read the token's state" };
    }

    delete data._id;
    delete data.folder;

    const baseActor = game.actors?.get(tokenDocument.actorId) ?? null;
    const species = resolveSpecies(src, tokenDocument) || "";

    // The token's own look wins for future placements — a GM who re-skinned
    // this one token meant it.
    try {
        data.prototypeToken = foundry.utils.mergeObject(
            data.prototypeToken ?? {},
            {
                name: tokenDocument.name || data.name,
                texture: { src: tokenDocument.texture?.src ?? data.prototypeToken?.texture?.src },
                width: tokenDocument.width, height: tokenDocument.height,
                actorLink: true,
            },
            { inplace: false },
        );
    } catch (_) { /* prototype polish is optional */ }

    data.flags = data.flags ?? {};
    data.flags[MODULE_ID] = {
        ...(data.flags[MODULE_ID] ?? {}),
        promoted: true,
        promotedAt: Date.now(),
        promotedReason: reason,
        promotedFromActorId: baseActor?.id ?? tokenDocument.actorId ?? null,
        // Keep the statblock label so the sidebar search can still find this row
        // by species after it is renamed — npc-sidebar-search reads these.
        originalName: data.flags[MODULE_ID]?.originalName || baseActor?.name || data.name,
        ...(species ? { species } : {}),
    };

    // Ownership follows the base actor so a player who could already see this
    // creature still can.
    if (baseActor?.ownership) data.ownership = foundry.utils.deepClone(baseActor.ownership);

    // ── File it ──────────────────────────────────────────────────────────
    const root = await _ensureFolder(NAMED_FOLDER);
    const home = factionName ? await _ensureFolder(factionName, root?.id ?? null) : root;
    if (home) data.folder = home.id;

    // ── Create + relink ──────────────────────────────────────────────────
    let created;
    try {
        created = await Actor.create(data);
        if (!created) throw new Error("Actor.create returned nothing");
    } catch (err) {
        console.error(`${TAG} | Could not create a persistent actor for ${tokenDocument.name}:`, err);
        return { actor: null, promoted: false, reason: "actor creation failed" };
    }

    // ⚠️ THE ROSTER STILL POINTS AT THE TOKEN. An unlinked creature is listed in
    // its faction by TOKEN id; it has just been given a brand new actor id and
    // the token is about to be relinked. Without this the faction silently loses
    // a member at the exact moment that member became worth keeping.
    try {
        const { repointFactionMember } = await import("./faction-registry.mjs");
        const repaired = await repointFactionMember(tokenDocument.id, created.id);
        if (repaired) console.log(`${TAG} | Roster entry in "${repaired}" repointed to the new actor.`);
    } catch (err) {
        console.warn(`${TAG} | Could not repoint the faction roster entry (non-fatal):`, err);
    }

    try {
        await tokenDocument.update({ actorId: created.id, actorLink: true });
    } catch (err) {
        console.error(`${TAG} | Created "${created.name}" but could not relink the token to it:`, err);
        return { actor: created, promoted: false, reason: "created but the token did not relink" };
    }

    // ⚠️ VERIFY, DO NOT ASSUME. If the relink silently did not take, the caller
    // would go on to write a biography into the OLD shared actor and rename all
    // nine goblins at once. Say so loudly instead.
    if (tokenDocument.actor?.id !== created.id) {
        console.error(`${TAG} | The token still resolves to "${tokenDocument.actor?.name}" (${tokenDocument.actor?.id}) ` +
            `instead of the new "${created.name}" (${created.id}). NOT treating this as promoted.`);
        return { actor: created, promoted: false, reason: "relink did not take effect" };
    }

    // ── Repair effect origins that still point at the creature it used to be ──
    // Every active effect carried across keeps its `origin`, and an effect that
    // came from this creature's OWN items points at the old synthetic actor —
    // "Scene.x.Token.y.Actor.z.Item.w". That uuid resolves to nothing the moment
    // the token relinks, so anything that later asks "where did this come from?"
    // (dnd5e's own effect cleanup among them) can decide the source is gone and
    // quietly remove a condition or a magic item's passive bonus.
    //
    // Effects cast BY someone else are untouched on purpose — a caster's
    // concentration effect legitimately points at the caster, not at this
    // creature, and rewriting that would break the concentration link.
    try {
        if (srcUuid && created.effects?.size) {
            const repairs = [];
            for (const eff of created.effects) {
                const origin = eff.origin;
                if (typeof origin === "string" && origin.startsWith(srcUuid)) {
                    repairs.push({ _id: eff.id, origin: origin.replace(srcUuid, created.uuid) });
                }
            }
            if (repairs.length) {
                await created.updateEmbeddedDocuments("ActiveEffect", repairs);
                console.log(`${TAG} | Repointed ${repairs.length} effect origin(s) at the new actor, so nothing treats them as orphaned.`);
            }
        }
    } catch (err) {
        console.warn(`${TAG} | Could not repair effect origins (the effects themselves are intact):`, err);
    }

    // Keep its place in the initiative order. The combatant tracks the token,
    // but its cached actorId would otherwise point at the shared statblock.
    try {
        const combatant = game.combat?.combatants?.find(c => c.tokenId === tokenDocument.id);
        if (combatant && combatant.actorId !== created.id) {
            await combatant.update({ actorId: created.id });
            console.log(`${TAG} | Initiative preserved — combatant repointed at "${created.name}".`);
        }
    } catch (err) {
        console.warn(`${TAG} | Could not repoint the combatant (initiative is unaffected):`, err);
    }

    const hp = created.system?.attributes?.hp;
    console.log(`${TAG} | "${tokenDocument.name}" is now a persistent actor (${created.id}) in "${home?.name ?? "the root"}" — ` +
        `${reason}. Carried over: ${hp?.value ?? "?"}/${hp?.max ?? "?"} hp, ` +
        `${created.effects?.size ?? 0} active effect(s), ${created.items?.size ?? 0} item(s). ` +
        `The other tokens from "${baseActor?.name ?? "the base statblock"}" are untouched.`);

    return { actor: created, promoted: true, reason };
}
