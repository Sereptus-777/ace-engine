// ─── ACE: Engine — "Give this one a life" token-HUD button ──────────────────
//
// Johnny, 2026-08-07: "I am going to need some button somewhere that lets me
// say, okay, let's create a bio for this guy. If I'm building a dungeon or
// something like that, or an encounter, I want to be able to give this guy a
// bio immediately and make him a persistent PC and all that shit."
//
// Token drops are silent now — nine goblins land instantly and cost nothing,
// and identity is created lazily the first time a player actually talks to one.
// That is right for play, but it leaves no way to do it ON PURPOSE while
// building a dungeon at leisure. This is that way.
//
// It is the SAME code path a conversation takes: promote to a persistent actor,
// then generate. Never a second implementation that drifts from the first.

import { promoteToNamedActor, isPromoted } from "./actor-promotion.mjs";

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Give a life";

/** Does this creature already have an ACE-written history? */
function _hasLife(actor) {
    const bio = actor?.system?.details?.biography?.value || "";
    return bio.includes('class="ace-engine-bio"');
}

/**
 * Promote + generate. The single entry point, shared by the HUD button and the
 * public API so a macro and a click do exactly the same thing.
 *
 * @param {TokenDocument} tokenDoc
 * @param {{force?: boolean}} [opts] — force:true rewrites an existing history
 */
export async function giveThisOneALife(tokenDoc, { force = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications?.warn("Only the GM can write a character's history.");
        return { ok: false, reason: "not the GM" };
    }
    if (!tokenDoc?.actor) return { ok: false, reason: "no actor" };
    if (tokenDoc.actor.type === "character") {
        ui.notifications?.warn("That is a player character — ACE will not rewrite their history.");
        return { ok: false, reason: "player character" };
    }

    const label = tokenDoc.name || tokenDoc.actor.name;

    // ── Promote first, exactly as a conversation does ────────────────────
    let target = tokenDoc;
    try {
        if (!isPromoted(tokenDoc)) {
            let factionName = "";
            try {
                const fid = tokenDoc.actor.getFlag?.(MODULE_ID, "factionId");
                if (fid) {
                    const { getFaction } = await import("./faction-registry.mjs");
                    factionName = getFaction(fid)?.name || "";
                }
            } catch (_) { /* folder nicety only */ }
            const res = await promoteToNamedActor(tokenDoc, { factionName, reason: "the GM asked for a history" });
            if (!res.promoted && !res.actor) {
                ui.notifications?.error(`Could not make ${label} a persistent character (${res.reason}).`);
                return { ok: false, reason: res.reason };
            }
        }
    } catch (err) {
        console.error(`${TAG} | Promotion failed:`, err);
        ui.notifications?.error(`Could not make ${label} a persistent character — see the console.`);
        return { ok: false, reason: "promotion threw" };
    }

    // ── Then generate ────────────────────────────────────────────────────
    //
    // ⚠️ The success toast used to fire the moment the token joined the queue,
    // because queueBioGeneration resolved on ENQUEUE. Johnny clicked the quill,
    // read "is now a persistent character with a history", and nothing ever
    // appeared. It now waits for the real result and says which way it went.
    // (2026-08-08.)
    try {
        const { queueBioGeneration } = await import("./bio-generator.mjs");
        ui.notifications?.info(`Writing a life for ${label}…`);

        const res = await queueBioGeneration(target, force ? { force: true } : {});
        const finalName = target.actor?.name || label;

        if (res && res.ok === false) {
            ui.notifications?.error(`Couldn't write a history for ${finalName} — ${res.error ?? "the reason wasn't reported"}.`);
            console.error(`${TAG} | "${label}" — generation reported failure: ${res.error ?? "(no reason given)"}`);
            return { ok: false, reason: res.error ?? "generation failed" };
        }
        if (res?.skipped) {
            ui.notifications?.info(`${finalName} — ${res.skipped}. Nothing was rewritten.`);
            return { ok: true, actor: target.actor ?? null, skipped: res.skipped };
        }

        ui.notifications?.info(`${finalName} is now a persistent character with a history.`);
        console.log(`${TAG} | "${label}" → "${finalName}" — persistent actor with a written history.`);
        return { ok: true, actor: target.actor ?? null };
    } catch (err) {
        console.error(`${TAG} | Generation failed:`, err);
        ui.notifications?.error(`${label} is now a persistent character, but writing the history failed: ${err?.message ?? err}. Click the quill again to retry.`);
        return { ok: false, reason: "generation threw" };
    }
}

/** Register the HUD button. Idempotent — safe to call more than once. */
let _wired = false;
export function wireGiveALifeHud() {
    if (_wired) return;
    _wired = true;

    /**
     * ⚠️ THIS IS A NATIVE HUD CONTROL, NOT A FLOATING ICON (2026-08-07).
     *
     * The first version absolutely-positioned a feather below the token, which
     * landed straight on top of Foundry's hit-point input — the field every GM
     * uses to set HP without opening a sheet. Johnny found it stacked over the
     * "16" under his goblin. Removing Foundry's HP box to make room would have
     * surprised anyone who has used Foundry for more than a week, so the button
     * moved into the HUD's own control column instead: same shape, same size and
     * same hover behaviour as the combat, target and visibility buttons, and
     * nothing overlaps anything.
     *
     * The V12/V13 html normalisation below is the pattern proven to work in
     * Johnny's install (advanced-drawing-tools does the same thing) — V13 hands
     * this hook a plain HTMLElement where V12 handed it jQuery.
     */
    Hooks.on("renderTokenHUD", (app, root, data) => {
        try {
            if (!game.user?.isGM) return;

            const el = root?.jquery ? root[0] : (root instanceof HTMLElement ? root : app?.element);
            if (!el) return;

            const token = canvas.tokens?.get(data?._id ?? app?.object?.id);
            const actor = token?.actor;
            if (!actor || actor.type !== "npc") return;

            // A corpse does not get a biography written for it. ace-qol stamps
            // this the moment its death pipeline runs.
            if (token.document?.flags?.["ace-qol"]?.isDead === true) return;

            // Never stack on a re-render.
            el.querySelectorAll(".ace-engine-give-a-life").forEach(n => n.remove());

            const col = el.querySelector(".col.right") ?? el.querySelector(".col.left");
            if (!col) {
                // ⚠️ Say it. A button that silently fails to appear is
                // indistinguishable from a feature that was never built.
                console.warn(`${TAG} | The token HUD has no control column to attach to — the "give this one a life" button cannot be shown. ` +
                    `Use game.modules.get("${MODULE_ID}").api.giveThisOneALife() with a token selected instead.`);
                return;
            }

            const lived = _hasLife(actor);
            const btn = document.createElement("div");
            btn.classList.add("control-icon", "ace-engine-give-a-life");
            if (lived) btn.classList.add("active");
            btn.dataset.action = `${MODULE_ID}.give-a-life`;
            btn.setAttribute("data-tooltip", lived
                ? `${actor.name} already has a history — click to write a new one`
                : `Give ${token.document.name || actor.name} a name, a history and a permanent place in your world`);
            // Gold so it reads as an ACE control among Foundry's white ones, and
            // fully opaque in BOTH states — the old 65%-opacity "already has a
            // life" version was invisible on a dark map.
            btn.innerHTML = `<i class="fas fa-feather-pointed" style="color:${lived ? "#c9a84c" : "#ffd76a"};"></i>`;

            btn.addEventListener("click", async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();

                if (lived) {
                    const ok = await foundry.applications.api.DialogV2.confirm({
                        window: { title: "Rewrite this character's history?" },
                        content: `<p style="font-size:16px; color:#1a1a1a; line-height:1.5;">
                            <strong>${foundry.utils.escapeHTML(actor.name)}</strong> already has a written history.
                            Writing a new one replaces it permanently.</p>
                            <p style="font-size:14px; color:#4a3a1a;">Their name, hit points, items and conditions are not touched.</p>`,
                        yes: { label: "Write a new history" },
                        no:  { label: "Keep the current one", default: true },
                    }).catch(() => false);
                    if (!ok) return;
                }

                canvas.hud?.token?.clear();
                await giveThisOneALife(token.document, { force: lived });
            });

            col.appendChild(btn);
        } catch (err) {
            console.warn(`${TAG} | Could not draw the HUD button (the rest of the HUD is unaffected):`, err);
        }
    });

    console.log(`${TAG} | Token-HUD button registered (GM only, NPC tokens, in the HUD control column).`);
}
