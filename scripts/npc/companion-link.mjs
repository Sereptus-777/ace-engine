// ─── ACE: Engine — Companion Link ──────────────────────────────────────────
// Mark an actor as a "companion" — a recurring summon belonging to a specific
// player. Steel Defender, Iron Defender, familiars, animal companions, etc.
//
// Flag schema (stored on the COMPANION actor, not the player's PC):
//
//   flags["ace-suite"].companion = {
//     ownerUserId:  "abc123",           // user that owns the summoning PC
//     initOffset:   -0.01,              // base initiative offset from summoner
//     // Future: tokenArt, more.
//   }
//
// Behavior at the table:
//   1. Auto-bio is skipped (handled by _detectSkipReason in activate.mjs)
//   2. When the summoner rolls initiative, the companion auto-takes
//      summoner.init + offset (with -0.01 / -0.02 / -0.03 stacking when
//      multiple companions of the same summoner are in combat)
//   3. When a companion token is created mid-combat, it auto-adds itself
//      to the combat tracker at the right initiative slot
//
// Future (artwork phase):
//   - tokenArt override forced at spawn time
//   - compendium auto-fallback for actors without explicit art
//
// Cross-module flag namespace (`ace-suite`) so ace-artificer / ace-qol /
// future modules can read it without importing this file.
// ───────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-engine.mjs";

const TAG = "ACE: Engine | Companion";

/* ────────────────────────────────────────────────────────────────────────
   Flag accessors
   ──────────────────────────────────────────────────────────────────────── */

/** Read the companion-link config from an actor. Returns null if not linked. */
export function getCompanionLink(actor) {
    if (!actor) return null;
    const cfg = actor.flags?.["ace-suite"]?.companion;
    if (!cfg || typeof cfg !== "object") return null;
    if (!cfg.ownerUserId) return null;
    return {
        ownerUserId: cfg.ownerUserId,
        initOffset:  Number.isFinite(cfg.initOffset) ? cfg.initOffset : -0.01,
        tokenArt:    cfg.tokenArt ?? "",
    };
}

/** Save companion-link config on the actor. Pass null/undefined to unlink.
 *  Also grants the linked user OWNER on the SOURCE actor — required for
 *  dnd5e's Summon activity to fire (it checks `actor.isOwner` on the
 *  spawn-source before placing tokens). Without this, players see
 *  "You must have ownership of '<NPC>' in order to summon it." Reverses
 *  the grant on unlink if the user isn't already a default owner.
 *
 *  NOTE: writes flags via `actor.update({"flags.ace-suite.companion": ...})`
 *  rather than `setFlag()`. Foundry's setFlag validates that the scope is a
 *  registered module ID, and `ace-suite` is our cross-module convention,
 *  not a real module — so setFlag throws "Flag scope 'ace-suite' is not
 *  valid or not currently active." Direct updates skip that validation.
 */
export async function setCompanionLink(actor, cfg) {
    if (!actor) return;
    if (!cfg) {
        // Unlink path — drop OWNER on the source actor for the previously
        // linked user (read it from the existing flag, since `cfg` is null).
        const prev = actor.flags?.["ace-suite"]?.companion;
        const updates = { "flags.ace-suite.-=companion": null };
        if (prev?.ownerUserId) {
            const ownership = foundry.utils.deepClone(actor.ownership ?? {});
            // Only revert if this user-specific entry was set to OWNER (3).
            // Don't touch DEFAULT or other users — leaves manual grants alone.
            if (ownership[prev.ownerUserId] === 3) {
                delete ownership[prev.ownerUserId];
                updates.ownership = ownership;
            }
        }
        try { await actor.update(updates); }
        catch (e) { console.warn("ACE: Engine | Companion | unlink failed", e); }
        return;
    }
    const companion = {
        ownerUserId: cfg.ownerUserId,
        initOffset:  Number.isFinite(cfg.initOffset) ? cfg.initOffset : -0.01,
        tokenArt:    cfg.tokenArt ?? "",
    };
    const updates = { "flags.ace-suite.companion": companion };
    // Auto-grant OWNER on the SOURCE actor so the linked player can fire
    // the dnd5e Summon activity that points at this actor. Token ownership
    // (granted in createToken hook) only covers the spawned copy — the
    // SOURCE check happens BEFORE the token exists.
    if (cfg.ownerUserId) {
        const current = actor.ownership ?? {};
        if ((current[cfg.ownerUserId] ?? 0) < 3) {
            const ownership = foundry.utils.deepClone(current);
            ownership[cfg.ownerUserId] = 3; // OWNER
            updates.ownership = ownership;
        }
    }
    try { await actor.update(updates); }
    catch (e) { console.warn("ACE: Engine | Companion | link save failed", e); }
}

/* ────────────────────────────────────────────────────────────────────────
   Detection — is this token/combatant a "summon" the system should treat
   as a companion (auto-linking init, transferring ownership, skipping
   bio)? Three sources, in priority:

     1. ORIGIN CHAIN — the dnd5e Summon activity stamps
        flags.dnd5e.summon.origin on every spawn. AUTOMATIC, no setup.
        This is the common case for Steel Defender, Conjure Animals,
        Find Familiar, etc. on dnd5e 5.x.
     2. MANUAL COMPANION LINK — flags["ace-suite"].companion on the actor.
        Useful only for drag-drop spawns or custom offsets.
     3. ACE FORGE TRAP — flags["ace-suite"].summonedByTrap on the token,
        for Mimic Chest / Summoning Rune spawns.

   isSummonedToken() returns true if any source matches.
   resolveSummonerActor() returns the summoning Actor (for ownership +
     init linking), null if nothing resolves.
   ──────────────────────────────────────────────────────────────────────── */

/** Pull the dnd5e summon-origin UUID from any of the places it might live.
 *  dnd5e 5.x stamps it on the ACTOR (`actor.flags.dnd5e.summon.origin`),
 *  not on the token document itself. Older versions / other modules may
 *  put it on the token directly or on the token's delta. Check all three. */
function _getDnd5eSummonOrigin(tokenDoc) {
    return tokenDoc?.flags?.dnd5e?.summon?.origin
        ?? tokenDoc?.actor?.flags?.dnd5e?.summon?.origin
        ?? tokenDoc?.delta?.flags?.dnd5e?.summon?.origin
        ?? null;
}

/** Quick check — does this token look like a summon at all? Fast (no async). */
export function isSummonedToken(tokenDoc) {
    if (!tokenDoc) return false;
    if (_getDnd5eSummonOrigin(tokenDoc)) return true;
    if (tokenDoc.flags?.["ace-suite"]?.summonedByTrap === true) return true;
    if (tokenDoc.actor?.flags?.["ace-suite"]?.summonedByTrap === true) return true;
    if (getCompanionLink(tokenDoc.actor)) return true;
    return false;
}

/** Resolve the summoning Actor document for this token. Async because the
 *  origin path requires a fromUuid lookup. Returns null if no source applies. */
export async function resolveSummonerActor(tokenDoc) {
    if (!tokenDoc) return null;
    // Path 1 — dnd5e Summon activity origin chain (token, actor, or delta)
    const originUuid = _getDnd5eSummonOrigin(tokenDoc);
    if (originUuid) {
        try {
            const item   = await fromUuid(originUuid);
            const parent = item?.parent;
            if (parent?.documentName === "Actor") return parent;
        } catch (_) { /* fall through */ }
    }
    // Path 2 — manual companion link's owner-as-PC fallback
    const link = getCompanionLink(tokenDoc.actor);
    if (link?.ownerUserId) {
        const owner = game.actors?.find(a => {
            if (!a || a.id === tokenDoc.actor?.id) return false;
            if (getCompanionLink(a)) return false;
            return a.testUserPermission?.(game.users.get(link.ownerUserId), "OWNER")
                ?? a.ownership?.[link.ownerUserId] >= 3;
        });
        if (owner) return owner;
    }
    return null;
}

/** Same as resolveSummonerActor but scoped to a Combat — returns the
 *  combatant for the resolved summoner, or null. */
export async function findSummonerCombatant(companionTokenDoc, combat) {
    if (!companionTokenDoc || !combat) return null;
    const summonerActor = await resolveSummonerActor(companionTokenDoc);
    if (!summonerActor) return null;
    return combat.combatants.find(c => c.actor?.id === summonerActor.id) ?? null;
}

/** Default initiative offset, used when there's no manual companion-link
 *  override. Tweaking the global default could be a future setting. */
const DEFAULT_INIT_OFFSET = -0.01;

/** Get the init offset for a token — manual override if set, else default. */
export function getInitOffsetForToken(tokenDoc) {
    const link = getCompanionLink(tokenDoc?.actor);
    if (link && Number.isFinite(link.initOffset)) return link.initOffset;
    return DEFAULT_INIT_OFFSET;
}

/* ────────────────────────────────────────────────────────────────────────
   Initiative computation — handles the multi-companion stacking case
   (multiple wolves from Conjure Animals all want unique slots after the
   wizard's init, e.g. -0.01, -0.02, -0.03).

   Algorithm: count how many ALREADY-IN-COMBAT companions of the same
   summoner there are (excluding the new one), use that as the stack index.
   ──────────────────────────────────────────────────────────────────────── */

export function computeCompanionInitiative(summonerInit, baseOffset, stackIndex) {
    if (summonerInit == null) return null;
    const offset = Number.isFinite(baseOffset) ? baseOffset : -0.01;
    const idx = Math.max(1, Math.floor(stackIndex || 1));
    return summonerInit + (offset * idx);
}

/** Count the companion combatants in this combat whose summoner is the
 *  given combatant. Used to determine the stack index for a new arrival. */
export async function countSummonedCompanionsOf(summonerCombatant, combat) {
    if (!summonerCombatant || !combat) return 0;
    let count = 0;
    for (const c of combat.combatants) {
        if (c.id === summonerCombatant.id) continue;
        const a = c.actor;
        if (!a) continue;
        if (!getCompanionLink(a)) continue;
        // Resolve THIS companion's summoner — does it match summonerCombatant?
        const otherSummoner = await findSummonerCombatant(c.token, combat);
        if (otherSummoner?.id === summonerCombatant.id) count++;
    }
    return count;
}

/* ────────────────────────────────────────────────────────────────────────
   Right-click context menu — "Link as companion to player..."
   ──────────────────────────────────────────────────────────────────────── */

export function registerActorDirectoryContext() {
    const handler = (_html, options) => {
        if (!Array.isArray(options)) return;

        // Link / Edit
        options.push({
            name: "Link as companion (Steel Defender, familiar, etc.)",
            icon: '<i class="fa-solid fa-link"></i>',
            condition: (li) => {
                const id = li.dataset?.entryId ?? li.dataset?.documentId;
                const actor = game.actors.get(id);
                return !!actor && !getCompanionLink(actor);
            },
            callback: (li) => {
                const id = li.dataset?.entryId ?? li.dataset?.documentId;
                const actor = game.actors.get(id);
                if (actor) openCompanionLinkDialog(actor);
            },
        });
        options.push({
            name: "Edit companion link",
            icon: '<i class="fa-solid fa-pen"></i>',
            condition: (li) => {
                const id = li.dataset?.entryId ?? li.dataset?.documentId;
                const actor = game.actors.get(id);
                return !!actor && !!getCompanionLink(actor);
            },
            callback: (li) => {
                const id = li.dataset?.entryId ?? li.dataset?.documentId;
                const actor = game.actors.get(id);
                if (actor) openCompanionLinkDialog(actor);
            },
        });
        options.push({
            name: "Unlink companion",
            icon: '<i class="fa-solid fa-link-slash"></i>',
            condition: (li) => {
                const id = li.dataset?.entryId ?? li.dataset?.documentId;
                const actor = game.actors.get(id);
                return !!actor && !!getCompanionLink(actor);
            },
            callback: async (li) => {
                const id = li.dataset?.entryId ?? li.dataset?.documentId;
                const actor = game.actors.get(id);
                if (!actor) return;
                await setCompanionLink(actor, null);
                ui.notifications?.info(`ACE Engine — "${actor.name}" companion link removed.`);
            },
        });
    };
    Hooks.on("getActorDirectoryEntryContext", handler);  // V12
    Hooks.on("getActorContextOptions",        handler);  // V13
}

/* ────────────────────────────────────────────────────────────────────────
   Setup dialog — picks player owner + initiative offset.
   File picker / token-art override is intentionally NOT in this version;
   that comes in the artwork phase (separate build).
   ──────────────────────────────────────────────────────────────────────── */

async function openCompanionLinkDialog(actor) {
    const current = getCompanionLink(actor) ?? { ownerUserId: "", initOffset: -0.01 };
    const players = game.users.filter(u => !u.isGM);
    const options = players.map(u => {
        const sel = u.id === current.ownerUserId ? "selected" : "";
        return `<option value="${u.id}" ${sel}>${foundry.utils.escapeHTML(u.name)}</option>`;
    }).join("");

    const content = `
        <div style="display:flex;flex-direction:column;gap:10px;font-size:13px;">
            <p style="margin:0;color:#aaa;">
                Linking <strong style="color:#c9a84c;">${foundry.utils.escapeHTML(actor.name)}</strong>
                as a companion. Future tokens of this actor will:
            </p>
            <ul style="margin:0 0 0 18px;padding:0;color:#aaa;font-size:12px;">
                <li>Skip auto-bio / voice / items+loot</li>
                <li>Auto-enter combat at the linked player's initiative slot</li>
                <li>Use the same initiative as the player, minus the offset below</li>
            </ul>
            <div class="form-group">
                <label style="display:block;font-weight:700;color:#c9a84c;">Player Owner</label>
                <select name="ownerUserId" style="width:100%;padding:5px 8px;">
                    <option value="">— select a player —</option>
                    ${options}
                </select>
            </div>
            <div class="form-group">
                <label style="display:block;font-weight:700;color:#c9a84c;">Initiative Offset</label>
                <input type="number" name="initOffset" value="${current.initOffset}" step="0.01" min="-1" max="1"
                       style="width:100%;padding:5px 8px;">
                <p style="margin:4px 0 0;color:#888;font-size:11px;font-style:italic;">
                    Default <code>-0.01</code> = act immediately after the player. Negative = after, positive = before.
                    Multi-companion summoners stack automatically (-0.01, -0.02, -0.03 …).
                </p>
            </div>
            <p style="margin:0;color:#888;font-size:11px;font-style:italic;">
                Token art override coming in the next update — for now the actor's prototype-token texture is used.
            </p>
        </div>
    `;

    return foundry.applications.api.DialogV2.wait({
        window: { title: `Companion Link — ${actor.name}` },
        content,
        buttons: [
            {
                action: "save",
                label: "Save Link",
                icon: "fa-solid fa-floppy-disk",
                default: true,
                callback: async (event, button, dialog) => {
                    const root = dialog?.element ?? document;
                    const ownerUserId = root.querySelector('[name="ownerUserId"]')?.value || "";
                    const initOffset  = Number(root.querySelector('[name="initOffset"]')?.value) || -0.01;
                    if (!ownerUserId) {
                        ui.notifications?.warn("ACE Engine — pick a player owner first.");
                        return;
                    }
                    await setCompanionLink(actor, { ownerUserId, initOffset });
                    const userName = game.users.get(ownerUserId)?.name ?? "?";
                    ui.notifications?.info(`ACE Engine — "${actor.name}" linked as companion of ${userName}. Init offset ${initOffset}.`);
                },
            },
            { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" },
        ],
        rejectClose: false,
        position: { width: 460 },
    });
}

/* ────────────────────────────────────────────────────────────────────────
   Initiative hooks — auto-place companion in combat at summoner's init slot
   ──────────────────────────────────────────────────────────────────────── */

/** Master toggle — when ON (default), auto-detect summons via dnd5e origin
 *  chain and apply ownership/init linking automatically. When OFF, only
 *  actors with an explicit manual companion-link get the treatment. */
function _isAutoLinkEnabled() {
    try { return game.settings.get(MODULE_ID, "autoLinkSummons") !== false; }
    catch (_) { return true; }
}

export function registerInitiativeHooks() {
    // ── Scenario A — summoner rolls initiative; backfill linked companions
    Hooks.on("updateCombatant", async (combatant, changes) => {
        if (!game.user.isGM) return;
        if (changes.initiative == null) return;
        const combat = combatant.parent;
        if (!combat) return;
        const summonerInit = combatant.initiative;
        if (summonerInit == null) return;

        // Walk every other combatant; resolve its summoner; if it's THIS
        // combatant, queue an init update. Auto-detect (origin chain) and
        // manual link both flow through resolveSummonerActor.
        const linked = [];
        const autoOn = _isAutoLinkEnabled();
        const summonsInTracker = [];
        for (const c of combat.combatants) {
            if (c.id === combatant.id) continue;
            if (!isSummonedToken(c.token)) continue;
            summonsInTracker.push(c.name);
            // Skip auto-detected summons when auto mode is off — only
            // manual companion-links should drive behavior in that case.
            if (!autoOn && !getCompanionLink(c.actor)) continue;
            const summonerC = await findSummonerCombatant(c.token, combat);
            if (summonerC?.id !== combatant.id) continue;
            linked.push(c);
        }
        console.log(`${TAG} | ${combatant.name} init=${summonerInit} | combat has ${combat.combatants.size} combatants, ${summonsInTracker.length} summons in tracker [${summonsInTracker.join(", ")}], ${linked.length} linked to me`);
        if (!linked.length) return;

        // Stable ordering for deterministic stacking (-0.01 / -0.02 / -0.03)
        linked.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
        const updates = linked.map((c, i) => ({
            _id: c.id,
            initiative: computeCompanionInitiative(summonerInit, getInitOffsetForToken(c.token), i + 1),
        }));
        try {
            await combat.updateEmbeddedDocuments("Combatant", updates);
            console.log(`${TAG} | Linked ${updates.length} summon init(s) to ${combatant.name}'s ${summonerInit}`);
        } catch (err) {
            console.warn(`${TAG} | Companion initiative backfill failed:`, err);
        }
    });

    // ── Scenario B — combatant entering combat. Two sub-cases:
    //    (1) the combatant IS a summon → set its init from summoner
    //    (2) the combatant is a PC → scan scene for its un-tracked summons
    //        and add them to combat too
    Hooks.on("createCombatant", async (combatant) => {
        if (!game.user.isGM) return;
        const combat = combatant.parent;
        if (!combat) return;

        // ── Sub-case 1: this combatant is a summon ──
        if (isSummonedToken(combatant.token) &&
            (_isAutoLinkEnabled() || getCompanionLink(combatant.actor))) {
            const summonerActor = await resolveSummonerActor(combatant.token);
            const summonerC = summonerActor
                ? combat.combatants.find(c => c.actor?.id === summonerActor.id)
                : null;
            if (summonerC && summonerC.initiative != null) {
                const existingSiblings = await countSummonedCompanionsOf(summonerC, combat);
                // +1: count is queried BEFORE this combatant is added, so add 1 to get correct slot
                const init = computeCompanionInitiative(
                    summonerC.initiative,
                    getInitOffsetForToken(combatant.token),
                    existingSiblings + 1,
                );
                try {
                    await combatant.update({ initiative: init });
                    console.log(`${TAG} | ${combatant.name} added at init ${init} (after ${summonerC.name} @ ${summonerC.initiative})`);
                } catch (err) {
                    console.warn(`${TAG} | Companion initiative-on-add failed:`, err);
                }
            } else if (summonerC) {
                console.log(`${TAG} | ${combatant.name} added — summoner ${summonerC.name} hasn't rolled yet, init will backfill on roll`);
            } else if (summonerActor) {
                // Summoner actor exists but isn't in combat yet — totally
                // fine (init will resolve when summoner enters combat and
                // rolls). Not an error.
                console.log(`${TAG} | ${combatant.name} added — summoner ${summonerActor.name} not in combat yet, init will backfill when they enter and roll`);
            } else {
                console.log(`${TAG} | ${combatant.name} added but origin chain didn't resolve to any summoner actor`);
            }
        }

        // ── Sub-case 2: a PC was added — scan scene for their summons ──
        // This is the missing piece — when you set up a combat by adding
        // Varick to the tracker, my code now scans the scene for any
        // un-tracked Steel Defender / Conjure Animals tokens that trace
        // back to Varick and adds them. Without this, summons placed
        // before "Begin Combat" never enter the tracker.
        if (!isSummonedToken(combatant.token) && combatant.actor) {
            await _scanSceneForUntrackedSummons(combatant, combat);
        }
    });

    // ── Token creation — fires for every new token. Two jobs here:
    //    1. Transfer ownership to the summoning player (auto, no setup)
    //    2. If a combat exists in this scene (started or not), add to it.
    //       createCombatant above then handles the initiative side.
    Hooks.on("createToken", async (tokenDoc) => {
        if (!game.user.isGM) return;
        if (!tokenDoc.actor) return;
        // Diagnostic — print every NPC token's flag state so we can see
        // exactly what dnd5e wrote, in case detection logic is wrong.
        if (tokenDoc.actor.type === "npc") {
            const origin = _getDnd5eSummonOrigin(tokenDoc);
            const traps  = tokenDoc.flags?.["ace-suite"]?.summonedByTrap
                       ?? tokenDoc.actor.flags?.["ace-suite"]?.summonedByTrap;
            const link   = getCompanionLink(tokenDoc.actor);
            const detected = isSummonedToken(tokenDoc);
            console.log(`${TAG} | createToken: ${tokenDoc.name} | origin=${origin || "—"} | trapFlag=${traps || "—"} | manualLink=${link ? "yes" : "no"} | DETECTED-AS-SUMMON=${detected}`);
        }
        if (!isSummonedToken(tokenDoc)) return;
        if (!_isAutoLinkEnabled() && !getCompanionLink(tokenDoc.actor)) return;

        // ── Job 1: ownership transfer ──
        try {
            const summonerActor = await resolveSummonerActor(tokenDoc);
            if (summonerActor) {
                const ownerUserId = _findPrimaryPlayerOwner(summonerActor);
                if (ownerUserId) {
                    const current = tokenDoc.actor.ownership ?? {};
                    if ((current[ownerUserId] ?? 0) < 3) {
                        await tokenDoc.actor.update({
                            [`ownership.${ownerUserId}`]: 3,  // OWNER
                        });
                        console.log(`${TAG} | Granted OWNER on ${tokenDoc.name} to ${game.users.get(ownerUserId)?.name ?? ownerUserId}`);
                    }
                }
            }
        } catch (err) {
            console.warn(`${TAG} | Companion ownership transfer failed:`, err);
        }

        // ── Job 1b: enforce companion uniqueness (RAW) ──
        // Steel Defender, Iron Defender, Find Familiar, etc. all have the
        // "if you already have one, the first immediately perishes" rule.
        //
        // Identity check: SUMMON ORIGIN UUID (flags.dnd5e.summon.origin) is
        // shared by every spawn from the same caster's same feature. Two
        // SDs from Varick → same origin. Varick's SD vs Bob's SD → different
        // origins. So origin matching gives "same caster + same feature".
        //
        // Gate: enforce uniqueness if EITHER:
        //   (a) The summon profile says count === "1" (Steel Defender,
        //       Iron Defender, familiar, etc. — single-spawn features).
        //   (b) The source/clone has a companion-link flag (manual override
        //       for unusual cases).
        // Conjure Animals / Animate Objects have count="1d4+1" or numeric
        // > 1 → gate fails → multiples stay alive.
        try {
            const newOriginUuid = _getDnd5eSummonOrigin(tokenDoc);
            if (newOriginUuid) {
                // Resolve source actor from origin (Item.parent === source Actor)
                let sourceActor = null;
                let originItem = null;
                try {
                    originItem = await fromUuid(newOriginUuid);
                    if (originItem?.parent?.documentName === "Actor") {
                        sourceActor = originItem.parent;
                    }
                } catch (_) { /* origin uuid stale */ }

                // ── Gate (a): profile.count === "1" ──
                let isSingleSpawn = false;
                try {
                    const summonFlag = tokenDoc.actor?.flags?.dnd5e?.summon
                                    ?? tokenDoc.flags?.dnd5e?.summon
                                    ?? tokenDoc.delta?.flags?.dnd5e?.summon;
                    const activityId = summonFlag?.activity;
                    const profileId  = summonFlag?.profile;
                    if (originItem && activityId) {
                        const activity = originItem.system?.activities?.get?.(activityId)
                                      ?? originItem.system?.activities?.contents?.find(a => a.id === activityId);
                        if (activity?.type === "summon") {
                            const profiles = activity.profiles ?? activity.toObject?.()?.profiles ?? [];
                            const profile = profileId
                                ? profiles.find(p => p._id === profileId)
                                : profiles[0];
                            // Count is a Foundry formula string. Parse strict:
                            // "1" → single. "1d4+1", "6", "1+@scaling" → multi.
                            const rawCount = (profile?.count ?? "").toString().trim();
                            isSingleSpawn = rawCount === "1" || rawCount === "";
                            console.log(`${TAG} | uniqueness: profile.count="${rawCount}" → singleSpawn=${isSingleSpawn} for ${tokenDoc.name}`);
                        }
                    }
                } catch (e) {
                    console.warn(`${TAG} | uniqueness: profile lookup failed (non-blocking):`, e);
                }

                // ── Gate (b): companion-link flag (manual override) ──
                const profileLink = await _resolveCompanionLinkForSpawn(tokenDoc, sourceActor);
                const isCompanion = !!profileLink;

                // Either gate passes → enforce
                if (isSingleSpawn || isCompanion) {
                    const scene = tokenDoc.parent;
                    const stale = [];
                    for (const otherTok of scene.tokens) {
                        if (otherTok.id === tokenDoc.id) continue;
                        const otherOrigin = _getDnd5eSummonOrigin(otherTok);
                        if (otherOrigin === newOriginUuid) {
                            stale.push(otherTok.id);
                        }
                    }
                    if (stale.length) {
                        await scene.deleteEmbeddedDocuments("Token", stale);
                        console.log(`${TAG} | RAW uniqueness: removed ${stale.length} previous ${tokenDoc.actor.name}(s) sharing origin ${newOriginUuid} (gate: singleSpawn=${isSingleSpawn}, companion=${isCompanion})`);
                    } else {
                        console.log(`${TAG} | uniqueness: no previous instances of ${tokenDoc.actor.name} found on canvas`);
                    }
                } else {
                    console.log(`${TAG} | uniqueness: ${tokenDoc.actor.name} is multi-spawn (count > 1, no companion-link) — allowing duplicates`);
                }
            }
        } catch (err) {
            console.warn(`${TAG} | Companion uniqueness enforcement failed (non-blocking):`, err);
        }

        // ── Job 2: auto-add to combat (any combat in this scene, started or not) ──
        const combat = game.combats.find(c => c.scene?.id === tokenDoc.parent?.id);
        if (!combat) {
            console.log(`${TAG} | ${tokenDoc.name} created but no combat in scene yet — will be added when combat is created or summoner enters`);
            return;
        }
        if (combat.combatants.find(c => c.tokenId === tokenDoc.id)) return;
        try {
            await combat.createEmbeddedDocuments("Combatant", [{
                tokenId:  tokenDoc.id,
                actorId:  tokenDoc.actorId ?? tokenDoc.actor?.id,
                sceneId:  tokenDoc.parent?.id,
                hidden:   tokenDoc.hidden ?? false,
            }]);
            console.log(`${TAG} | ${tokenDoc.name} auto-added to combat (started=${combat.started})`);
        } catch (err) {
            console.warn(`${TAG} | Companion auto-add to combat failed:`, err);
        }
    });

    // ── Combat creation scan — DISABLED ─────────────────────────────────────
    // Previously: when a new combat was created in a scene with summon tokens
    // already on canvas, this scanned the scene and pulled ALL summons into
    // the new combat — regardless of whether their summoner was joining the
    // fight. That caused stray companions (e.g. Virric's Steel Defender) to
    // get added to combats their owner wasn't part of, just because the
    // token was sitting on the map.
    //
    // The desired behavior — and what this module already supported through
    // OTHER triggers — is: a summon enters combat ONLY when its summoner
    // does. The remaining triggers cover every legitimate case:
    //   • createCombatant Sub-case 2 — PC added to combat → scan for THEIR
    //     summons → add them right after their summoner.
    //   • createCombatant Sub-case 1 — summon manually added to combat →
    //     auto-set its initiative based on its summoner's roll.
    //   • createToken — summon token placed mid-combat → auto-add it to
    //     the active combat with the right initiative.
    //   • updateCombatant initiative roll — summoner rolls → companion
    //     initiative backfills under them.
    //
    // Together these cover every flow without the false-positive of
    // pulling in unrelated summon tokens at combat-create time.
}

/** When a non-summon combatant (typically a PC) is added to combat, scan
 *  the scene for summon tokens whose summoner traces back to that combatant.
 *  Add any un-tracked ones. Used by createCombatant sub-case 2 above. */
async function _scanSceneForUntrackedSummons(pcCombatant, combat) {
    const scene = combat.scene;
    if (!scene) return;
    const pcActorId = pcCombatant.actor?.id;
    if (!pcActorId) return;
    let added = 0;
    for (const tokenDoc of scene.tokens) {
        if (!isSummonedToken(tokenDoc)) continue;
        if (combat.combatants.find(c => c.tokenId === tokenDoc.id)) continue;
        const summonerActor = await resolveSummonerActor(tokenDoc);
        if (summonerActor?.id !== pcActorId) continue;
        try {
            await combat.createEmbeddedDocuments("Combatant", [{
                tokenId:  tokenDoc.id,
                actorId:  tokenDoc.actorId ?? tokenDoc.actor?.id,
                sceneId:  scene.id,
                hidden:   tokenDoc.hidden ?? false,
            }]);
            added++;
        } catch (err) {
            console.warn(`${TAG} | scan: failed to add ${tokenDoc.name}:`, err);
        }
    }
    if (added) console.log(`${TAG} | ${pcCombatant.name} entered combat — added ${added} of their summon(s) to the tracker`);
}

/** Decide if a freshly-spawned summoned token came from a companion-linked
 *  source. Checks (in order):
 *    1. The synthetic actor on the spawn (cloned actor inherits flags from
 *       source — so if source had the flag, the clone has it too).
 *    2. The actor pointed to by the summon profile (the world / compendium
 *       SD that the artificer's feature uses as its profile UUID).
 *    3. The owner-side: search game.actors for an actor matching the
 *       spawn's name with companion-link set (last-resort fallback).
 *
 *  Returns the companion-link config object if found, null otherwise.
 */
async function _resolveCompanionLinkForSpawn(tokenDoc, sourceActor) {
    // 1. Inherited from clone
    const onSpawn = getCompanionLink(tokenDoc.actor);
    if (onSpawn) return onSpawn;

    // 2. On the source actor (resolved from origin chain by caller)
    if (sourceActor) {
        const onSource = getCompanionLink(sourceActor);
        if (onSource) return onSource;
    }

    // 3. Search by name in world actors (defensive fallback for cases where
    //    the clone got stripped of flags or the origin chain is incomplete)
    const byName = game.actors?.find(a =>
        a.name === tokenDoc.actor?.name &&
        a.type === "npc" &&
        getCompanionLink(a)
    );
    return byName ? getCompanionLink(byName) : null;
}

/** Find the primary non-GM player owner of an actor. Used to identify
 *  the summoning player when an actor's `flags.dnd5e.summon.origin` chain
 *  resolves back to a PC. Returns the user ID or null. */
function _findPrimaryPlayerOwner(actor) {
    if (!actor?.ownership) return null;
    const candidates = [];
    for (const [userId, level] of Object.entries(actor.ownership)) {
        if (userId === "default") continue;
        if (level < 3) continue;  // need OWNER level
        const user = game.users.get(userId);
        if (!user || user.isGM) continue;
        candidates.push({ userId, active: user.active });
    }
    if (!candidates.length) return null;
    // Prefer active user if multiple players own the actor (rare)
    candidates.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    return candidates[0].userId;
}
