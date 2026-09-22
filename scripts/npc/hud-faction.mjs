// ─── ACE Engine — one HUD button: put THIS token in a faction ────────────────
//
// Johnny, 2026-09-22: "ADD a GM-only way to assign a faction to the selected
// token. Token-drop assign stays OFF. Use the existing showFactionAssignDialog
// and assignToFaction. Do not write a second faction system. Put one button on
// the token HUD, GM only, NPC or character. Click it, the existing picker
// opens, pick a faction, stamp that token only. If nothing is selected, do
// nothing."
//
// ⚠️ THIS FILE DECIDES NOTHING. It opens the picker that already exists, hands
// what the GM chose to the assigner that already exists, and stops. Every
// faction, every rank, every roster and every flag is the registry's; a second
// opinion about any of them is the thing he asked not to have.
//
// ⚠️ AND IT NEVER INVENTS A FACTION. The legacy picker answers "make a new one"
// with `{factionId: null, isNew: true}` and leaves the making to its caller.
// Inventing one here — a name, a type, a purpose ACE made up — is exactly what
// he ruled out, so that answer is reported and nothing is stamped.
//
// ⚠️ TOKEN-DROP ASSIGN STAYS OFF. Nothing here touches the drop path or any of
// its settings; this is a button a GM presses, and it is the only way in.
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ DECLARED, NOT IMPORTED. The entry file keeps MODULE_ID as a local const and
// exports no such name, so importing it is a SyntaxError that kills this module
// on the way in — and with it everything loaded beside it. Its siblings all
// declare their own; so does this.
const MODULE_ID = "ace-engine";

import {
    showFactionAssignDialog,
    assignToFaction,
    resolveCreatureBase,
    findMatchingFactions,
    getFaction,
} from "./faction-registry.mjs";

const TAG = "ace-engine | faction button";

/**
 * Open the existing picker for one token and stamp whatever the GM chooses.
 *
 * @param {TokenDocument} tokenDoc
 * @returns {Promise<{factionId: string, role: string}|null>} what was stamped
 */
export async function assignFactionFromHud(tokenDoc) {
    const actor = tokenDoc?.actor ?? null;
    if (!actor) {
        ui.notifications?.warn("ACE: that token has no creature on it, so there is nothing to put in a faction.");
        return null;
    }

    const creatureBase = resolveCreatureBase(actor);
    const worldTag = game.world?.title || "";
    // The same list the drop path shows: what the registry already knows.
    let matching = [];
    try { matching = findMatchingFactions(creatureBase, worldTag) ?? []; }
    catch (err) { console.warn(`${TAG} | could not list matching factions, showing the picker anyway:`, err); }

    console.log(`${TAG} | ${tokenDoc.name}: opening the faction picker (${matching.length} `
        + `match${matching.length === 1 ? "" : "es"} for "${creatureBase}").`);

    let choice = null;
    try {
        choice = await showFactionAssignDialog(tokenDoc, matching, creatureBase);
    } catch (err) {
        console.error(`${TAG} | the faction picker failed for ${tokenDoc.name}:`, err);
        ui.notifications?.error("ACE: the faction picker could not open — see the console. Nothing was changed.");
        return null;
    }

    if (!choice) {
        console.log(`${TAG} | ${tokenDoc.name}: the picker was closed, so nothing was changed.`);
        return null;
    }

    // "Make a new one" is a decision this button does not make for him.
    if (!choice.factionId && choice.isNew) {
        console.log(`${TAG} | ${tokenDoc.name}: "a new faction" was chosen, and this button does not invent one. `
            + `Nothing was stamped.`);
        ui.notifications?.info("ACE: this button puts a token into a faction that already exists. "
            + "Nothing was changed.");
        return null;
    }
    // "None" is an answer too, and it is not this button's job to take one away.
    if (!choice.factionId) {
        console.log(`${TAG} | ${tokenDoc.name}: "none" was chosen, so nothing was stamped.`);
        return null;
    }

    try {
        await assignToFaction(tokenDoc, choice.factionId, choice.role);
    } catch (err) {
        console.error(`${TAG} | ${tokenDoc.name} could not be put in that faction:`, err);
        ui.notifications?.error(`ACE: ${tokenDoc.name} could not be put in that faction — see the console.`);
        return null;
    }

    const faction = getFaction(choice.factionId);
    const name = faction?.name ?? choice.factionId;
    console.log(`${TAG} | ${tokenDoc.name} is in "${name}"${choice.role ? ` as ${choice.role}` : ""}.`);
    ui.notifications?.info(`${tokenDoc.name} is in ${name}${choice.role ? ` (${choice.role})` : ""}.`);
    return { factionId: choice.factionId, role: choice.role ?? "" };
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
