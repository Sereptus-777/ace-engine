// ─── ACE Engine — one HUD button: put THIS token in a faction ────────────────
//
// Johnny, 2026-09-22: "ADD a GM-only way to assign a faction to the selected
// token... Put one button on the token HUD, GM only, NPC or character. Click
// it, the existing picker opens, pick a faction, stamp that token only."
//
// And his correction the same day: "The gold HUD flag must open the SAME popup
// a manual token drop used to open: showNpcIdentityDialog, through
// processTokenFaction with _aceManualDrop set. Not showFactionAssignDialog.
// That is the leftover fallback."
//
// ⚠️ THIS FILE DECIDES NOTHING. It opens the picker that already exists, hands
// what the GM chose to the assigner that already exists, and stops. Every
// faction, every rank, every roster and every flag is the registry's; a second
// opinion about any of them is the thing he asked not to have.
//
// ⚠️ AND IT INVENTS NOTHING. Whether a faction is made, which one is offered,
// what rank a creature holds and what is written on it are all decisions the
// drop path already owns. This file adds none of its own.
//
// ⚠️ TOKEN-DROP ASSIGN STAYS OFF. Nothing here touches the drop path or any of
// its settings; this is a button a GM presses, and it is the only way in.
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ DECLARED, NOT IMPORTED. The entry file keeps MODULE_ID as a local const and
// exports no such name, so importing it is a SyntaxError that kills this module
// on the way in — and with it everything loaded beside it. Its siblings all
// declare their own; so does this.
const MODULE_ID = "ace-engine";

import { processTokenFaction, getFaction } from "./faction-registry.mjs";

const TAG = "ace-engine | faction button";

/**
 * Open the faction popup a manual token drop used to open, for ONE token.
 *
 * ⚠️ THE DROP'S OWN PATH, NOT A SECOND ONE (his correction, 2026-09-22:
 * "WRONG DIALOG. The gold HUD flag must open the SAME popup a manual token drop
 * used to open: showNpcIdentityDialog, through processTokenFaction with
 * _aceManualDrop set. Not showFactionAssignDialog. That is the leftover
 * fallback.").
 *
 * So this file does not pick, rank, match or assign anything. It marks the
 * token the way a manual drop marks it and hands it to the one processor,
 * which recommends, shows the smart setup, opens the identity dialog on
 * "customize", and calls the assigner itself. Everything this button knows
 * about factions, it knows by asking that.
 *
 * @param {TokenDocument} tokenDoc
 * @returns {Promise<object|null>} whatever the drop path decided
 */
export async function assignFactionFromHud(tokenDoc) {
    const actor = tokenDoc?.actor ?? null;
    if (!actor) {
        ui.notifications?.warn("ACE: that token has no creature on it, so there is nothing to put in a faction.");
        return null;
    }

    console.log(`${TAG} | ${tokenDoc.name}: opening the full identity dialog for this one token.`);
    // ⚠️ THE PRESS MARK, NOT THE DROP MARK (2026-09-22). A drop asks "does this
    // new creature need setting up" and turns back when it already has a
    // faction; a press asks "let me change this one". The processor reads this
    // and stands its drop-only guards down.
    const held = tokenDoc._aceGmPress;
    tokenDoc._aceGmPress = true;
    try {
        const result = await processTokenFaction(tokenDoc);
        // The dialog has returned, so the press is over. The biography below
        // runs a pipeline that asks the faction engine its own questions, and
        // it must find a token nobody is pressing.
        delete tokenDoc._aceGmPress;
        const faction = result?.faction ?? null;
        if (faction) {
            console.log(`${TAG} | ${tokenDoc.name} is in "${faction.name}"${result.role ? ` as ${result.role}` : ""}.`);
            ui.notifications?.info(`${tokenDoc.name} is in ${faction.name}${result.role ? ` (${result.role})` : ""}.`);
        } else {
            // ⚠️ SILENCE IS A BUG. "He closed it" and "he chose no faction" are
            // different answers and the console says which.
            console.log(`${TAG} | ${tokenDoc.name}: the popup ended with no faction`
                + `${result?.role ? ` (role "${result.role}")` : ""}. Nothing else was changed.`);
        }
        // ⚠️ THE BIOGRAPHY IS ITS OWN WINDOW NOW (2026-09-23). It was a tick
        // here, which could only ever mean "replace it with an AI one"; the
        // dialog's Biography button opens a window that can also take one he
        // pastes or add to what is there. Nothing about a biography is decided
        // by pressing this flag.
        return result ?? null;
    } catch (err) {
        console.error(`${TAG} | the faction popup failed for ${tokenDoc.name}:`, err);
        ui.notifications?.error("ACE: the faction popup could not run — see the console. Nothing was changed.");
        return null;
    } finally {
        // ⚠️ THE MARK IS THIS PRESS'S, NOT THE TOKEN'S FOREVER. Leaving it on
        // would make a later pass treat this creature as a fresh press.
        if (held === undefined) delete tokenDoc._aceGmPress;
        else tokenDoc._aceGmPress = held;
    }
}

export class FactionHudButton {

    static register() {
        if (this._registered) return;
        this._registered = true;

        Hooks.on("renderTokenHUD", (app, root, data) => {
            try {
                // GM only. A player deciding who is in which faction is a
                // different feature and he did not ask for one.
                if (!game.user?.isGM) return;

                // V13 hands a plain element where V12 handed jQuery: the same
                // normalisation the "give this one a life" button uses.
                const el = root?.jquery ? root[0] : (root instanceof HTMLElement ? root : app?.element);
                if (!el) return;

                const token = canvas.tokens?.get(data?._id ?? app?.object?.id);
                const actor = token?.actor;
                // NPC or character, his words. Anything else on a map (a vehicle,
                // a group) does not join factions.
                if (!actor || (actor.type !== "npc" && actor.type !== "character")) return;

                el.querySelectorAll(".ace-engine-faction").forEach(n => n.remove());

                const col = el.querySelector(".col.right") ?? el.querySelector(".col.left");
                if (!col) {
                    console.warn(`${TAG} | the token HUD has no control column, so the faction button cannot be shown. `
                        + `Use game.modules.get("${MODULE_ID}").api.assignFactionFromHud(token.document) instead.`);
                    return;
                }

                const held = actor.getFlag(MODULE_ID, "factionId") ?? null;
                const faction = held ? getFaction(held) : null;
                const btn = document.createElement("div");
                btn.classList.add("control-icon", "ace-engine-faction");
                if (faction) btn.classList.add("active");
                btn.dataset.action = `${MODULE_ID}.assign-faction`;
                btn.setAttribute("data-tooltip", faction
                    ? `${token.document.name || actor.name} is in ${faction.name} — click to move them`
                    : `Put ${token.document.name || actor.name} in a faction`);
                // Gold, like ACE's other HUD control, and opaque in both states.
                btn.innerHTML = `<i class="fas fa-flag" style="color:${faction ? "#c9a84c" : "#ffd76a"};"></i>`;

                btn.addEventListener("click", async (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    // ⚠️ THIS TOKEN ONLY (his rule). Whatever else is selected on
                    // the map is not what the HUD is showing.
                    const doc = token?.document ?? null;
                    if (!doc) {
                        console.log(`${TAG} | the HUD's token is gone, so nothing was changed.`);
                        return;
                    }
                    canvas.hud?.token?.clear();
                    await assignFactionFromHud(doc);
                });

                col.appendChild(btn);
            } catch (err) {
                console.warn(`${TAG} | the faction button could not be added to this HUD:`, err);
            }
        });

        console.debug(`${TAG} | online: a GM can put the token on the HUD into a faction that already exists.`);
    }
}
