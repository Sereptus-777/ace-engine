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
}

/** Expose internal state for the engine api block (so other modules / macros
 *  can find an open conversation, see locks, etc). */
export const npcChatState = {
    openConversations,
    npcLocks,
    isActivated: () => _activated,
};

// ─── HOOK REGISTRATION ─────────────────────────────────────────────────────

function _registerHooks() {

    // ── Auto-bio + voice on token drop ──────────────────────────────────
    Hooks.on("createToken", (tokenDocument, options, userId) => {
        if (userId !== game.user.id || !game.user.isGM) return;
        if (!tokenDocument.actor || tokenDocument.actor.type !== "npc") return;

        // Voice assignment (always runs, even if bio gen is off)
        import("./voice-engine.mjs").then(({ onTokenCreated }) => {
            setTimeout(() => onTokenCreated(tokenDocument), 50);
        }).catch(err => console.error(`${TAG} | Voice Engine load failed:`, err));

        // Bio generation (gated on autoGenerateBio + tokenDropAI tier)
        try {
            if (!game.settings.get(MODULE_ID, "autoGenerateBio")) return;
            const tier = game.settings.get(MODULE_ID, "tokenDropAI") ?? "full";
            if (tier === "off") return;
        } catch (_) { return; }

        import("./bio-generator.mjs").then(({ queueBioGeneration }) => {
            tokenDocument._aceManualDrop = true;
            setTimeout(() => queueBioGeneration(tokenDocument), 100);
        }).catch(err => console.error(`${TAG} | Bio-generator load failed:`, err));
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
    const existing = game.folders?.find(f => f.name === "ACE NPCs" && f.type === "Actor");
    if (existing) return existing;
    return Folder.create({ name: "ACE NPCs", type: "Actor", parent: null });
}

async function _getOrCreateFallenFolder(parentFolder) {
    let fallen = game.folders?.find(f =>
        f.name === "☠ Fallen" && f.type === "Actor" && f.folder?.id === parentFolder.id
    );
    if (fallen) return fallen;
    return Folder.create({
        name:   "☠ Fallen",
        type:   "Actor",
        parent: parentFolder.id,
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
