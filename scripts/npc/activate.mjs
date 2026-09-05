import { onCanvasReady } from "./../ready-utils.mjs";
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

// Where dead linked NPCs are filed. The leading "X" is deliberate — see the
// rename note in the cleanup function below.
const FALLEN_FOLDER        = "X ☠ Fallen";
const LEGACY_FALLEN_FOLDER = "☠ Fallen";
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
    console.log(`${TAG} | Activating NPC chat hooks.`);
    _registerHooks();
    _activated = true;  // core hooks are now registered; set AFTER _registerHooks()

    // Load dynamic modules together — errors surface in one place.
    // _activated stays true even on import failure (core hooks remain registered).
    Promise.all([
        import("./ui-hooks.mjs").then(({ registerUiHooks }) => registerUiHooks()),
        // The quill under an NPC token: "give this one a life". Token drops are
        // silent now, so this is how a GM deliberately fleshes somebody out
        // while building a dungeon rather than waiting for a player to walk up.
        import("./hud-give-a-life.mjs").then(({ wireGiveALifeHud }) => wireGiveALifeHud()),
        import("./companion-link.mjs").then(({ registerActorDirectoryContext, registerInitiativeHooks }) => {
            registerActorDirectoryContext();
            registerInitiativeHooks();
            console.log(`${TAG} | Companion-link feature online.`);
        }),
        // Find a renamed NPC by WHAT it is: typing "ogre" still surfaces
        // "Thalgar Stonehide". Feature-detected — logs and no-ops if this
        // Foundry build doesn't expose the directory matcher.
        import("./npc-sidebar-search.mjs").then(({ installNpcSidebarSearch }) => installNpcSidebarSearch()),
        // Creature sounds need a socket listener on EVERY client: one to play
        // what another client chose, one so a player (who cannot list files)
        // can ask the GM to choose. Neither existed until 2026-08-06, so a
        // roar only ever played on the machine that picked it.
        import("./creature-sounds.mjs").then(({ wireCreatureSoundSocket, rebuildCreatureSoundIndex, rebuildSpeakingWebpIndex }) => {
            wireCreatureSoundSocket();
            // The GM publishes the clip listing to world data so PLAYERS can
            // read it — Foundry forbids them from listing files themselves.
            // Without this every player hears silence. Backgrounded; a failure
            // here must never hold up activation.
            if (game.user?.isGM) {
                rebuildCreatureSoundIndex().catch(err =>
                    console.warn(`${TAG} | Creature-sound index build failed:`, err));
                // Same reason: players cannot list files, so probing for a
                // speaking portrait printed three red 404s per conversation in
                // their console. Publish the listing instead.
                rebuildSpeakingWebpIndex().catch(err =>
                    console.warn(`${TAG} | Speaking-portrait index build failed:`, err));
            }
        }),
        // Five NPC socket messages had no receiver at all — most importantly
        // ollamaRequest, which left players on a local-AI world unable to get
        // any NPC reply. Audited 2026-08-06.
        import("./npc-socket-router.mjs").then(({ wireNpcSocketRouter }) => wireNpcSocketRouter()),
        // ⚠️ LOAD BIO-GENERATOR EAGERLY (2026-08-07). It owns _isGenericName —
        // the compendium-backed test for "is this a real name or a statblock
        // label" — and installs it into npc-identity at module load. It used to
        // load ONLY on a token drop, so in a session where nothing was dropped
        // the detector was null and the fallback word-matching ran instead.
        // "Archmage" does not resemble "humanoid", so it was judged a PERSONAL
        // NAME and the prompt told the creature "YOUR NAME: Archmage — you may
        // introduce yourself with it." Which it dutifully did. Same for Bandit
        // Captain, Cult Fanatic, Veteran — every statblock that reads like a name.
        import("./bio-generator.mjs").then(() =>
            console.log(`${TAG} | Name detector installed (statblock labels vs real names).`)),
    ]).catch(err => console.error(`${TAG} | NPC chat dynamic module load failed (core hooks remain active):`, err));
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

        // ── STAMP THE ARRIVAL (2026-08-07) ─────────────────────────────
        // One tiny flag write. No network, no AI, nothing on screen — this is
        // the only thing that happens on a silent drop besides the token
        // appearing.
        //
        // It is what lets a history written three sessions later say "he took
        // that wound AFTER he got here" instead of guessing. Without it, a
        // creature found at 40 of 130 hit points is indistinguishable from one
        // that walked in bleeding. Johnny asked for exactly that: "if it has a
        // large wound or scar… recently got that from fighting the dragon one
        // month ago or whatever, or maybe yesterday, depending on if the guy is
        // still bleeding."
        if (game.user?.isGM && !tokenDocument.actor?.getFlag?.(MODULE_ID, "arrival")) {
            const _hp = tokenDocument.actor?.system?.attributes?.hp;
            let _inGame = null;
            // SimpleCalendar is optional — every reference to it in this module
            // is guarded, and this one is no exception.
            try { _inGame = globalThis.SimpleCalendar?.api?.timestampToDate?.(globalThis.SimpleCalendar.api.timestamp())?.display?.date ?? null; }
            catch (_) { _inGame = null; }

            tokenDocument.actor.setFlag(MODULE_ID, "arrival", {
                scene: canvas.scene?.name ?? null,
                sceneId: canvas.scene?.id ?? null,
                at: Date.now(),
                inGameDate: _inGame,
                hp: (_hp?.value ?? null),
                hpMax: (_hp?.max ?? null),
            }).catch(err => console.debug(`${TAG} | Arrival stamp skipped (non-fatal):`, err));
        }

        // tier = "off" is the explicit "leave this token alone" — vanilla drop.
        // Honors per-drop popup choice too, since that override sets the same
        // setting via the Smart Token Drop dialog.
        if (tier === "off") return;

        // ── SILENT: the default. The token just appears. ───────────────
        // Johnny, 2026-08-07: "Nothing — instant, silent."
        //
        // ⚠️ THIS MUST SHORT-CIRCUIT BEFORE THE AUTO-PIPELINE BELOW. That
        // pipeline batches drops and AUTO-ACCEPTS the smart-setup dialog, so
        // letting a silent drop reach it would spend an AI call per token —
        // the precise thing the silent tier exists to stop.
        //
        // queueBioGeneration turns a silent drop away at its own front door,
        // before the queue and before any database write, and does the one free
        // thing (adopt a faction that already fits). One code path owns it.
        if (tier === "silent") {
            import("./bio-generator.mjs").then(({ queueBioGeneration }) => {
                queueBioGeneration(tokenDocument).catch(err =>
                    console.warn(`${TAG} | Silent drop handling failed (the token is fine):`, err));
            }).catch(err => console.error(`${TAG} | Bio-generator load failed:`, err));
            return;
        }

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
    onCanvasReady( () => {
        if (!game.user.isGM) return;
        const tokens = canvas.tokens?.placeables ?? [];
        const npcs = tokens.filter(t => {
            const actor = t.document?.actor ?? t.actor;
            return actor && actor.type === "npc";
        });
        if (!npcs.length) return;

        console.log(`${TAG} | Scene scan — checking ${npcs.length} NPC token(s)`);

        for (let _idx = 0; _idx < npcs.length; _idx++) {
            const token = npcs[_idx];
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

            // Stagger voice + bio processing so up to ~40 NPC tokens on scene-load
            // don't all fire DB writes simultaneously. 100ms gap between each token.
            const _voiceDelay = 50 + _idx * 100;
            import("./voice-engine.mjs").then(({ onTokenCreated }) => {
                setTimeout(() => onTokenCreated(tokenDoc), _voiceDelay);
            }).catch(err => console.error(`${TAG} | Voice Engine load failed:`, err));

            try {
                if (!game.settings.get(MODULE_ID, "autoGenerateBio")) continue;
                // Honor the Token Drop AI Level here too — the drop hook has always
                // checked it (tier "off" = vanilla), but the scene scan didn't, so
                // "Off" still generated bios on every reload. Same gate, both paths.
                // (Root-caused with the Grulgar-ogre naming bug, 2026-07-26.)
                //
                // ⚠️ SILENT BELONGS HERE TOO (2026-08-07). Without it, every
                // creature on the map got a full generation on each scene load —
                // which is far worse than the drop case it was meant to prevent,
                // because a reload touches EVERY token at once.
                const _scanTier = game.settings.get(MODULE_ID, "tokenDropAI") || "silent";
                if (_scanTier === "off" || _scanTier === "silent") continue;
            } catch (_) { continue; }

            // ⚠️🔴 A SCENE LOAD MUST NEVER INVENT AN IDENTITY.
            //
            // Dropping a creature is a deliberate act; opening a map is not. This
            // scan walked EVERY NPC token on the scene on every single load and
            // generated a name and a bio for any that lacked one, which is how a
            // fully written NPC ended up wearing an invented nameplate.
            //
            // Johnny, 2026-08-24, minutes before a session: "it just renamed Isaac,
            // who already had a name and a background and everything... It was a
            // scene scan that renamed them, and that's the only thing I need off."
            //
            // The tier gate above was tightened twice already (2026-07-26 for
            // "off", 2026-08-07 for "silent") and BOTH times the fix was to add
            // one more tier to the skip list rather than to ask whether a reload
            // should be generating anything at all. It should not. The drop hook
            // still honours every tier, so nothing a GM does on purpose changes;
            // the quill under a token backfills any creature that wants one.
            //
            // ⚠️ VOICES STILL RUN ABOVE THIS LINE, deliberately. Assigning a
            // voice writes no name, invents no history, and shows the players
            // nothing - it just means an NPC can speak when spoken to.
            continue;

            /* eslint-disable no-unreachable */
            // Kept, unreachable, so the shape of what a scan WOULD do is visible
            // if this is ever revisited - and so nobody re-adds it from memory.
            const _bioDelay = 100 + _idx * 150;
            import("./bio-generator.mjs").then(({ queueBioGeneration }) => {
                setTimeout(() => queueBioGeneration(tokenDoc), _bioDelay);
            }).catch(err => console.error(`${TAG} | Bio-generator load failed:`, err));
            /* eslint-enable no-unreachable */
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

    // ── Stale conversation-lock sweep on world ready ────────────────────
    // The `conversationLocked` flag is persisted to world data. If a chat
    // closed in an unclean way (browser reload mid-conversation, crash,
    // network drop before the close handler awaited its unsetFlag) the
    // flag survives to the next session and blocks all player movement
    // forever. On every world load, scan every token and clear any
    // lingering flag. By definition no conversation is active at world
    // load — so any flag is stale and safe to drop.
    //
    // ── CRITICAL LAUNCH FIX (May 31) ────────────────────────────────────
    // Original code: `if (!tokenDoc.isOwner) continue;` — sweep only ran
    // on tokens the current user OWNED. The GM does NOT own player tokens,
    // so loading as GM (the most common case) silently skipped clearing
    // stale locks on Firaxis / Logan / any other PC token. The lock then
    // persisted until the player happened to log in AND their own sweep
    // ran without failures. Real customers hit this constantly — every
    // crashed chat = a permanently locked PC token for the GM's session.
    //
    // Fix: GM clears EVERY token's lock (GM has permission to update any
    // token in the world). Players still only clear their own tokens, but
    // since the GM sweep runs every load, the lock typically clears before
    // the player even sees it.
    // ⚠️ WAS Hooks.once("ready") — but activateNpcChat() is called from the
    // entry file's ready handler, so this registered against an event already
    // in progress and NEVER fired. "The GM sweep runs every load" was false:
    // a crashed chat left a PC token locked FOREVER. 08-16 full audit.
    const _runTokenLockSweep = async () => {
        try {
            let cleared = 0;
            const isGM = game.user.isGM;
            for (const scene of game.scenes) {
                for (const tokenDoc of scene.tokens) {
                    // GM: clear all locks (GM owns all permissions).
                    // Player: only clear own tokens (no permission for others).
                    if (!isGM && !tokenDoc.isOwner) continue;
                    const a = tokenDoc.getFlag(MODULE_ID, "conversationLocked");
                    const b = tokenDoc.flags?.npclink?.conversationLocked;
                    if (!a && !b) continue;
                    try {
                        if (a) await tokenDoc.unsetFlag(MODULE_ID, "conversationLocked");
                        if (b) await tokenDoc.unsetFlag("npclink", "conversationLocked");
                        cleared++;
                    } catch (_) { /* permission denied — skip silently */ }
                }
            }
            if (cleared > 0) {
                console.log(`ACE: Engine | Cleared ${cleared} stale conversation-lock flag(s) on world load.`);
            }
        } catch (err) {
            console.warn("ACE: Engine | stale conversation-lock sweep failed:", err);
        }
    };
    if (game.ready) _runTokenLockSweep(); else Hooks.once("ready", _runTokenLockSweep);

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
        // ── LOCK ANY OPEN CONVERSATION, ON EVERY CLIENT (2026-08-07) ────────
        // Runs BEFORE the GM-only guard below, because the players are the ones
        // who must be shut out — a GM-only handler would have left every player
        // window live. Jeth killed Savid and then interviewed the corpse, which
        // answered that it felt "stronger, no more pain".
        try {
            const deadActorId = data?.actor?.id ?? data?.tokenDoc?.actorId ?? null;
            const deadTokenId = data?.tokenDoc?.id ?? null;
            for (const [, app] of (openConversations ?? new Map())) {
                if (!app || app._isClaim) continue;
                const hit = (deadActorId && app.actor?.id === deadActorId)
                         || (deadTokenId && app.tokenDocument?.id === deadTokenId);
                if (!hit) continue;
                app._applyDeathLock?.();
                console.log(`${TAG} | ${app.npcName ?? "NPC"} died mid-conversation — window locked.`);
            }
        } catch (e) {
            console.warn(`${TAG} | conversation death-lock failed:`, e);
        }

        // ⚠️ `ace-qol.npcDeath` is a LOCAL hook — Hooks.callAll never crosses
        // the wire. Without this emit the lock above only ever ran on the GM's
        // own client, and every PLAYER window would have stayed live: exactly
        // the people the lock exists to stop. (2026-08-07)
        try {
            if (game.user.isGM) {
                game.socket.emit(`module.${MODULE_ID}`, {
                    action:   "npcDied",
                    actorId:  data?.actor?.id ?? data?.tokenDoc?.actorId ?? null,
                    tokenId:  data?.tokenDoc?.id ?? null,
                    senderId: game.user.id,
                });
            }
        } catch (e) { console.warn(`${TAG} | npcDied broadcast failed:`, e); }

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
// async because the one-time rename of the legacy ☠ Fallen folder awaits
// Foundry's update. Callers are hook handlers that do not await it.
async function _handleEngineNpcDeath({ actor, tokenDoc, changes, killerName }) {
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

    // Dead NPC Cleanup: move linked actor to "X ☠ Fallen" folder
    try {
        const autoCleanup = game.settings.get(MODULE_ID, "autoCleanupDead");
        if (!autoCleanup) return;
    } catch { return; }

    if (!actor?.id) return;
    const sidebarActor = game.actors?.get(actor.id);
    if (!sidebarActor) return;
    if (sidebarActor.type !== "npc") return;

    // ⚠️ RENAMED 2026-08-07 at Johnny's request. "☠ Fallen" sorted to the very
    // top of the Actors sidebar — the skull glyph sorts before every letter —
    // so it sat open above the search results every single time he looked for
    // a creature. Leading "X" drops it to the end and keeps the skull.
    //
    // The OLD name is still matched here so his existing folder, with all its
    // dead NPCs in it, is found and renamed rather than orphaned beside a new
    // empty one.
    let fallenFolder = game.folders?.find(f => f.name === FALLEN_FOLDER && f.type === "Actor");
    if (!fallenFolder) {
        const legacy = game.folders?.find(f => f.name === LEGACY_FALLEN_FOLDER && f.type === "Actor");
        if (legacy) {
            try {
                await legacy.update({ name: FALLEN_FOLDER });
                fallenFolder = legacy;
                console.log(`${TAG} | Renamed the "${LEGACY_FALLEN_FOLDER}" folder to "${FALLEN_FOLDER}" so it stops sorting to the top of the sidebar. Its contents are untouched.`);
            } catch (err) {
                console.warn(`${TAG} | Could not rename the fallen folder (using it as-is):`, err);
                fallenFolder = legacy;
            }
        }
    }
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
    // X ☠ Fallen folder if a previous run left orphans at the root (the
    // schema-validator dropped `parent:` in V12+ and stranded duplicates).
    const all = (game.folders ?? []).filter(f => f.name === "X ☠ Fallen" && f.type === "Actor");
    const nested = all.find(f => f.folder?.id === parentFolder.id);
    if (nested) return nested;
    if (all.length) return all[0]; // reuse the first orphan rather than make another
    // V12+ uses `folder:` for the parent field on the Folder data schema.
    // Earlier versions used `parent:` which is silently dropped now → orphan
    // at root. Use the correct field.
    return Folder.create({
        name:   "X ☠ Fallen",
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
        })().finally(() => { _fallenFolderInflight = null; });
    }
    const fallenFolder = await _fallenFolderInflight;
    if (!fallenFolder) return;
    if (actor.folder?.id === fallenFolder.id) return;
    await actor.update({ folder: fallenFolder.id });
    console.log(`${TAG} | Moved ${actor.name} to X ☠ Fallen folder.`);
}
