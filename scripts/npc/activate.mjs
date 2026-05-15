// ─── ACE: Engine — NPC Chat Subsystem Activation ───────────────────────────
// Single entry point that wires the dormant npc/*.mjs files into Foundry
// hooks. Called from ace-engine.mjs init/ready when the npcChatEnabled gate
// is true. Each hook is registered ONCE per Foundry session.
//
// Ported from ace-envoy/src/main.js as part of the Envoy → Engine merger.
//
// Hooks wired:
//   createToken       — bio + voice + faction on token drop
//   canvasReady       — scene scan for missing voices/bios
//   preUpdateToken    — conversation lock + scene change cleanup
//   ace-qol.npcDeath  — death pipeline trigger (via QOL hook)
//   updateActor       — fallback death detection (when QOL absent)
//   deleteCombat      — end-of-combat cleanup
//   deleteToken       — close conversations when NPC token removed
//
// DEFERRED (TODO Phase 3c):
//   renderTokenHUD     — chat button on NPC token HUDs (~200 lines, complex)
//   renderActorSheetV2 — actor sheet AI Setup dialog
//   renderSceneConfig  — voice region dropdown
//   canvas hover/control hooks — chat bubble overlay rendering

const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | NPC Chat";

let _activated = false;
const openConversations = new Map(); // convoKey → ConversationApp instance
const npcLocks          = new Map(); // actorId → { userId, userName }
const gmPuppets         = new Map(); // puppetKey → GmPuppetApp instance (GM-side speak-as-NPC tool)

/** Compute conversation Map key — token-specific for unlinked tokens. */
function _convoKey(actorId, tokenDoc) {
    return (tokenDoc && !tokenDoc.actorLink) ? `tok:${tokenDoc.id}` : actorId;
}

function _findConvo(actorId, tokenId) {
    if (tokenId) {
        const byToken = openConversations.get(`tok:${tokenId}`);
        if (byToken) return { key: `tok:${tokenId}`, app: byToken };
    }
    const byActor = openConversations.get(actorId);
    if (byActor) return { key: actorId, app: byActor };
    return null;
}

function _isNpcChatEnabled() {
    try { return game.settings.get(MODULE_ID, "npcChatEnabled") === true; }
    catch (_) { return false; }
}

/**
 * Detect whether a token (or its actor) is a "summon-like" entity that
 * should skip the auto-bio / voice / items+loot pipeline. Returns a short
 * string naming the source that flagged it, or null if no flag matches.
 *
 * Sources, in priority order:
 *   1. "companion-link" — flags["ace-suite"].companion on the ACTOR.
 *      Set via "Link as companion" right-click menu; used for recurring
 *      summons that also need ownership/init linking (Steel Defender etc.).
 *   2. "actor-opt-out"  — flags["ace-suite"].alwaysSkipBio on the ACTOR.
 *      Simpler "skip bio only" mark with no init/ownership behavior.
 *   3. "ace-forge"      — flags["ace-suite"].summonedByTrap on the token,
 *      stamped by ACE Forge's summon-pipeline (Mimic Chest, Summoning Rune).
 *   4. "warpgate"       — flags.warpgate.* (Warpgate module spawn)
 *   5. "foundry-summons" — flags["foundry-summons"].* (Foundry Summons)
 *   6. "dnd5e-summon"   — flags.dnd5e.summon / summonedActorUuid
 *      (the dnd5e system's native Summon activity, e.g. Conjure Animals)
 */
function _detectSkipReason(tokenDoc) {
    const actor = tokenDoc?.actor;
    if (actor?.flags?.["ace-suite"]?.companion?.ownerUserId) return "companion-link";
    if (actor?.flags?.["ace-suite"]?.alwaysSkipBio === true) return "actor-opt-out";
    const tFlags = tokenDoc?.flags ?? {};
    if (tFlags["ace-suite"]?.summonedByTrap === true) return "ace-forge";
    if (actor?.flags?.["ace-suite"]?.summonedByTrap === true) return "ace-forge";
    if (tFlags.warpgate && Object.keys(tFlags.warpgate).length) return "warpgate";
    if (tFlags["foundry-summons"] && Object.keys(tFlags["foundry-summons"]).length) return "foundry-summons";
    // dnd5e Summon activity stamps `flags.dnd5e.summon.origin` on the spawned
    // ACTOR (and sometimes on the token's delta), not on the token document
    // itself. Check all three locations or this skip will silently fail and
    // bios will generate for Steel Defender, Conjure Animals, etc.
    if (tFlags.dnd5e?.summon || tFlags.dnd5e?.summonedActorUuid) return "dnd5e-summon";
    if (actor?.flags?.dnd5e?.summon || actor?.flags?.dnd5e?.summonedActorUuid) return "dnd5e-summon";
    if (tokenDoc?.delta?.flags?.dnd5e?.summon) return "dnd5e-summon";
    return null;
}

/**
 * Activate the NPC chat subsystem. Idempotent — registers hooks only once.
 * Safe to call from init OR ready — internally gates on canvas/game readiness.
 */
export function activateNpcChat() {
    if (_activated) return;
    if (!_isNpcChatEnabled()) {
        console.log(`${TAG} | npcChatEnabled is false — subsystem stays dormant.`);
        return;
    }
    _activated = true;
    console.log(`${TAG} | Activating NPC chat hooks.`);

    _registerHooks();

    // UI hooks (token HUD chat button, scene voice region, party face, etc.)
    // Lazy import to avoid circular dependency (ui-hooks reads npcChatState
    // from this file).
    import("./ui-hooks.mjs").then(({ registerUiHooks }) => {
        registerUiHooks();
    }).catch(err => console.error(`${TAG} | UI hooks load failed:`, err));

    // Companion-link feature — right-click context menu in Actors directory
    // + initiative auto-link hooks. Used for recurring summons that belong
    // to a specific player (Steel Defender, Iron Defender, familiars, etc.)
    import("./companion-link.mjs").then(({ registerActorDirectoryContext, registerInitiativeHooks }) => {
        registerActorDirectoryContext();
        registerInitiativeHooks();
        console.log(`${TAG} | Companion-link feature online.`);
    }).catch(err => console.error(`${TAG} | Companion-link load failed:`, err));
}

/** Expose internal state for the engine api block (so other modules / macros
 *  can find an open conversation, see locks, etc). */
export const npcChatState = {
    openConversations,
    npcLocks,
    gmPuppets,
    isActivated: () => _activated,
};

// ─── HOOK REGISTRATION ─────────────────────────────────────────────────────

function _registerHooks() {

    // ── Auto-bio + voice on token drop ──────────────────────────────────
    Hooks.on("createToken", (tokenDocument, options, userId) => {
        if (userId !== game.user.id || !game.user.isGM) return;
        if (!tokenDocument.actor || tokenDocument.actor.type !== "npc") return;

        // Skip auto-bio / voice / items+loot for summoned creatures.
        // Five recognized sources (any one is sufficient):
        //   1. ACE Forge summon-pipeline (Mimic Chest, Summoning Rune)
        //   2. Warpgate module — flags.warpgate.*
        //   3. Foundry Summons module — flags["foundry-summons"].*
        //   4. dnd5e system Summon activity — flags.dnd5e.summon / summonedActorUuid
        //   5. Actor-level explicit opt-out — flags["ace-suite"].alwaysSkipBio
        //      (set via the right-click context menu on the actor — used for
        //      Steel Defender / Iron Defender / familiars / recurring NPCs)
        const skipReason = _detectSkipReason(tokenDocument);
        let skipForSummons = true;
        try { skipForSummons = game.settings.get(MODULE_ID, "skipBioForSummons") !== false; }
        catch (_) { /* default true */ }
        if (skipReason && skipForSummons) {
            console.log(`${TAG} | Skipping auto-bio/voice/items for ${tokenDocument.name} (reason: ${skipReason})`);
            return;
        }

        // Voice assignment (always runs, even if bio gen is off)
        import("./voice-engine.mjs").then(({ onTokenCreated }) => {
            setTimeout(() => onTokenCreated(tokenDocument), 50);
        }).catch(err => console.error(`${TAG} | Voice Engine load failed:`, err));

        // Read the three relevant settings up-front
        let bioEnabled = true;
        let alwaysItemsLoot = true;
        let tier = "full";
        try {
            bioEnabled = game.settings.get(MODULE_ID, "autoGenerateBio") !== false;
            alwaysItemsLoot = game.settings.get(MODULE_ID, "alwaysRunItemAndLoot") !== false;
            tier = game.settings.get(MODULE_ID, "tokenDropAI") ?? "full";
        } catch (_) { /* defaults */ }

        // tier = "off" is the explicit "leave this token alone" — vanilla drop.
        // Honors per-drop popup choice too, since that override sets the same
        // setting via the Smart Token Drop dialog.
        if (tier === "off") return;

        // ── Auto-pipeline branch ───────────────────────────────────────
        // When autoGenerateOnDrop is ON, every drop goes through the
        // auto-pipeline which batches simultaneous drops, applies a rate
        // limit, shows a single confirmation for big batches, and serially
        // processes each token with auto-accept on the smart-setup dialog.
        // Bio path only — items-only mode (bioEnabled=false) bypasses
        // because there's no popup to skip in that path anyway.
        let autoMode = false;
        try { autoMode = !!game.settings.get(MODULE_ID, "autoGenerateOnDrop"); } catch (_) {}
        if (autoMode && bioEnabled) {
            import("./auto-pipeline.mjs").then(({ enqueueAutoGeneration }) => {
                enqueueAutoGeneration(tokenDocument);
            }).catch(err => console.error(`${TAG} | Auto-pipeline load failed:`, err));
            return;
        }

        if (bioEnabled) {
            // Normal path — full bio + items + loot pipeline
            import("./bio-generator.mjs").then(({ queueBioGeneration }) => {
                tokenDocument._aceManualDrop = true;
                setTimeout(() => queueBioGeneration(tokenDocument), 100);
            }).catch(err => console.error(`${TAG} | Bio-generator load failed:`, err));
        } else if (alwaysItemsLoot) {
            // Bio is off globally but master toggle says items + loot should
            // still check every NPC. Skip the bio paragraph + faction popup,
            // run only the item flavor + loot generation.
            import("./bio-generator.mjs").then(({ runItemAndLootOnly }) => {
                setTimeout(() => runItemAndLootOnly(tokenDocument), 100);
            }).catch(err => console.error(`${TAG} | Items+loot only load failed:`, err));
        }
        // else: bio off + master toggle off = legacy quiet behavior, nothing runs
    });

    // ── Scene scan for missing voices/bios ──────────────────────────────
    Hooks.on("canvasReady", () => {
        if (!game.user.isGM) return;
        const tokens = canvas.tokens?.placeables ?? [];
        const npcs = tokens.filter(t => {
            const actor = t.document?.actor ?? t.actor;
            return actor && actor.type === "npc";
        });
        if (!npcs.length) return;

        console.log(`${TAG} | Scene scan — checking ${npcs.length} NPC token(s)`);

        for (const token of npcs) {
            const tokenDoc = token.document;
            if (!tokenDoc?.actor) continue;

            // Skip surviving summoned creatures on scene scan — same five-
            // source detection as the createToken hook above. A Steel
            // Defender or Mimic that survives a reload doesn't suddenly
            // want a bio at next world load.
            const skipReason = _detectSkipReason(tokenDoc);
            let skipForSummons = true;
            try { skipForSummons = game.settings.get(MODULE_ID, "skipBioForSummons") !== false; }
            catch (_) { /* default true */ }
            if (skipReason && skipForSummons) continue;

            import("./voice-engine.mjs").then(({ onTokenCreated }) => {
                setTimeout(() => onTokenCreated(tokenDoc), 50);
            }).catch(err => console.error(`${TAG} | Voice Engine load failed:`, err));

            try {
                if (!game.settings.get(MODULE_ID, "autoGenerateBio")) continue;
            } catch (_) { continue; }

            import("./bio-generator.mjs").then(({ queueBioGeneration }) => {
                setTimeout(() => queueBioGeneration(tokenDoc), 100);
            }).catch(err => console.error(`${TAG} | Bio-generator load failed:`, err));
        }
    });

    // ── Actor directory context menu — toggle "skip auto-bio" on actors ─
    // Sets the flags["ace-suite"].alwaysSkipBio actor flag, which the
    // _detectSkipReason() helper reads in the createToken / canvasReady
    // hooks above. Used for recurring summons like Steel Defender,
    // Iron Defender, familiars — actors that don't go through any
    // automated summon-module pipeline but still want bio-skip every
    // time they're spawned.
    //
    // Both V12 (`getActorDirectoryEntryContext`) and V13
    // (`getActorContextOptions`) hook names are registered for compat.
    const _actorContextOptions = (_html, options) => {
        if (!Array.isArray(options)) return;
        options.push({
            name: "Mark as summon — skip auto-bio",
            icon: '<i class="fa-solid fa-wand-sparkles"></i>',
            condition: (li) => {
                const id = li.dataset?.entryId ?? li.dataset?.documentId;
                const actor = game.actors.get(id);
                return !!actor && !actor.flags?.["ace-suite"]?.alwaysSkipBio;
            },
            callback: async (li) => {
                const id = li.dataset?.entryId ?? li.dataset?.documentId;
                const actor = game.actors.get(id);
                if (!actor) return;
                // Direct update bypasses Foundry's setFlag scope validation
                // (it rejects "ace-suite" since it's not a registered module).
                await actor.update({ "flags.ace-suite.alwaysSkipBio": true });
                ui.notifications?.info(`ACE Engine — "${actor.name}" marked as summon. Future tokens of this actor will skip auto-bio.`);
            },
        });
        options.push({
            name: "Unmark summon — restore auto-bio",
            icon: '<i class="fa-solid fa-rotate-left"></i>',
            condition: (li) => {
                const id = li.dataset?.entryId ?? li.dataset?.documentId;
                const actor = game.actors.get(id);
                return !!actor && actor.flags?.["ace-suite"]?.alwaysSkipBio === true;
            },
            callback: async (li) => {
                const id = li.dataset?.entryId ?? li.dataset?.documentId;
                const actor = game.actors.get(id);
                if (!actor) return;
                await actor.update({ "flags.ace-suite.-=alwaysSkipBio": null });
                ui.notifications?.info(`ACE Engine — "${actor.name}" no longer skips auto-bio. Tokens will be processed normally.`);
            },
        });
    };
    Hooks.on("getActorDirectoryEntryContext", _actorContextOptions); // V12
    Hooks.on("getActorContextOptions",        _actorContextOptions); // V13

    // ── Conversation lock: block player movement during chat ────────────
    Hooks.on("preUpdateToken", (tokenDoc, changes) => {
        const isMovement = "x" in changes || "y" in changes;
        if (isMovement && !game.user.isGM) {
            const isLocked = tokenDoc.getFlag(MODULE_ID, "conversationLocked")
                          || tokenDoc.flags?.npclink?.conversationLocked;
            if (isLocked) {
                ui.notifications.warn("You cannot move while speaking — finish your conversation first.");
                return false;
            }
        }
    });

    // ── Scene change → end conversation ─────────────────────────────────
    Hooks.on("preUpdateToken", (tokenDoc, changes) => {
        if (!("sceneId" in changes)) return;
        const actor   = tokenDoc.actor;
        const actorId = actor?.id;
        if (!actorId) return;

        const moveKey = _convoKey(actorId, tokenDoc);
        const moveFound = openConversations.get(moveKey)
            ? { key: moveKey, app: openConversations.get(moveKey) }
            : _findConvo(actorId, tokenDoc.id);

        if (npcLocks.has(actorId) || moveFound) {
            console.warn(`${TAG} | NPC token moved to different scene — ending convo`);
            game.socket.emit(`module.${MODULE_ID}`, {
                action:  "gmDismiss",
                actorId,
                tokenId: tokenDoc.id,
                source:  "scene-change",
            });
            if (npcLocks.has(actorId)) npcLocks.delete(actorId);
            if (moveFound) {
                moveFound.app._gmForced = true;
                moveFound.app.close().catch(() => {});
                openConversations.delete(moveFound.key);
            }
        }
    });

    // ── Token deleted → close any open conversation ─────────────────────
    Hooks.on("deleteToken", (tokenDoc) => {
        const actor   = tokenDoc.actor;
        const actorId = actor?.id || tokenDoc.actorId || tokenDoc.flags?.[MODULE_ID]?.actorId;
        const tokenId = tokenDoc.id;

        let found = null;
        if (tokenId) {
            const tokKey = `tok:${tokenId}`;
            const byTok  = openConversations.get(tokKey);
            if (byTok) found = { key: tokKey, app: byTok };
        }
        if (!found && actorId) {
            found = _findConvo(actorId, tokenId);
        }

        if (found || (actorId && npcLocks.has(actorId))) {
            const name = actor?.name || tokenDoc.name || "NPC";
            console.warn(`${TAG} | NPC token deleted mid-conversation — ending convo for ${name}`);
            game.socket.emit(`module.${MODULE_ID}`, {
                action:  "gmDismiss",
                actorId: actorId || "",
                tokenId,
                source:  "gm",
            });
            if (actorId) npcLocks.delete(actorId);
            if (found) {
                found.app._gmForced = true;
                found.app.close().catch(() => {});
                openConversations.delete(found.key);
            }
        }
    });

    // ── Death pipeline: prefer QOL custom hook, fall back to updateActor ─
    Hooks.on("ace-qol.npcDeath", (data) => {
        if (!game.user.isGM) return;
        // QOL fires this AFTER its dead-marker / loot / dead-art processing
        _handleEngineNpcDeath({
            actor:      data?.actor,
            tokenDoc:   data?.tokenDoc,
            changes:    data?.changes ?? {},
            killerName: data?.killerName ?? "",
        });
    });

    Hooks.on("updateActor", (actor, changes, options, userId) => {
        if (!game.user.isGM) return;
        if (actor.type !== "npc") return;

        // Only fire fallback path when QOL is NOT active (QOL hook handles it)
        if (game.modules.get("ace-qol")?.active) return;

        const newHp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
        if (newHp === undefined || newHp > 0) return;

        const tokenDoc = actor.token ?? actor.getActiveTokens()?.[0]?.document ?? null;
        const killerName = game.combat?.combatant?.name ?? "";

        _handleEngineNpcDeath({ actor, tokenDoc, changes, killerName });
    });

    // ── End-of-combat cleanup ───────────────────────────────────────────
    Hooks.on("deleteCombat", async (combat, options, userId) => {
        if (!game.user.isGM) return;
        // Close any conversations involving combatants from the deleted combat
        for (const combatant of combat.combatants ?? []) {
            const actorId = combatant.actor?.id;
            if (!actorId) continue;
            const found = _findConvo(actorId, combatant.tokenId);
            if (found) {
                console.log(`${TAG} | Combat ended — closing convo for ${combatant.name}`);
                found.app._gmForced = true;
                found.app.close().catch(() => {});
                openConversations.delete(found.key);
            }
        }
    });
}

// ─── DEATH DISPATCHER ──────────────────────────────────────────────────────

/** Single entry point for engine NPC death logic: faction memory ripple +
 *  combat removal + XP + Fallen folder cleanup. */
function _handleEngineNpcDeath({ actor, tokenDoc, changes, killerName }) {
    if (!game.user.isGM) return;

    // Faction Memory (Death Ripple)
    if (tokenDoc) {
        import("./faction-memory.mjs").then(({ logDeathEvent }) => {
            logDeathEvent(tokenDoc, killerName || "").catch(e =>
                console.warn(`${TAG} | Death ripple failed:`, e)
            );
            console.log(`${TAG} | Death ripple: ${tokenDoc.name || actor.name} fell — faction memory updated`);
        }).catch(err => console.error(`${TAG} | Faction memory load failed:`, err));
    }

    // Combat Removal + XP Distribution
    import("../combat/death-handler.mjs").then(({ onActorHpChange }) => {
        onActorHpChange(actor, changes);
    }).catch(err => console.error(`${TAG} | Death handler load failed:`, err));

    // Dead NPC Cleanup: move linked actor to "☠ Fallen" folder
    try {
        const autoCleanup = game.settings.get(MODULE_ID, "autoCleanupDead");
        if (!autoCleanup) return;
    } catch { return; }

    if (!actor?.id) return;
    const sidebarActor = game.actors?.get(actor.id);
    if (!sidebarActor) return;
    if (sidebarActor.type !== "npc") return;

    const fallenFolder = game.folders?.find(f => f.name === "☠ Fallen" && f.type === "Actor");
    if (fallenFolder && sidebarActor.folder?.id === fallenFolder.id) return;

    _moveActorToFallenFolder(sidebarActor).catch(err =>
        console.warn(`${TAG} | Dead NPC cleanup failed:`, err)
    );
}

// ─── FALLEN FOLDER ─────────────────────────────────────────────────────────

let _fallenFolderInflight = null;

async function _getOrCreateAceNpcsFolder() {
    // Match by name regardless of parent — there should only be ONE root-level
    // "ACE NPCs" folder. Reuse it even if it has children we didn't create.
    const existing = game.folders?.find(f => f.name === "ACE NPCs" && f.type === "Actor");
    if (existing) return existing;
    return Folder.create({ name: "ACE NPCs", type: "Actor", folder: null });
}

async function _getOrCreateFallenFolder(parentFolder) {
    // Defensive find: prefer one nested under ACE NPCs, but accept any
    // ☠ Fallen folder if a previous run left orphans at the root (the
    // schema-validator dropped `parent:` in V12+ and stranded duplicates).
    const all = (game.folders ?? []).filter(f => f.name === "☠ Fallen" && f.type === "Actor");
    const nested = all.find(f => f.folder?.id === parentFolder.id);
    if (nested) return nested;
    if (all.length) return all[0]; // reuse the first orphan rather than make another
    // V12+ uses `folder:` for the parent field on the Folder data schema.
    // Earlier versions used `parent:` which is silently dropped now → orphan
    // at root. Use the correct field.
    return Folder.create({
        name:   "☠ Fallen",
        type:   "Actor",
        folder: parentFolder.id,
        color:  "#8b0000",
    });
}

async function _moveActorToFallenFolder(actor) {
    if (!_fallenFolderInflight) {
        _fallenFolderInflight = (async () => {
            const parent = await _getOrCreateAceNpcsFolder();
            const fallen = await _getOrCreateFallenFolder(parent);
            return fallen;
        })();
    }
    const fallenFolder = await _fallenFolderInflight;
    if (!fallenFolder) return;
    if (actor.folder?.id === fallenFolder.id) return;
    await actor.update({ folder: fallenFolder.id });
    console.log(`${TAG} | Moved ${actor.name} to ☠ Fallen folder.`);
}
