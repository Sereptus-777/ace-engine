// ─── ACE: Engine — Death Handler ───────────────────────────────────────────
// When unlinked NPCs hit 0 HP: remove from combat tracker + distribute XP
// to PCs + clear voice assignment so resurrection gives a new voice.
// Linked NPCs get death saves (GM can manually kill via combat tracker).
//
// Moved from ace-envoy/src/combat/death-handler.js as part of the
// Envoy → Engine merger. Settings + speaker aliases translated to engine.

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Death";

/** Track tokens we've already processed (prevents double-fire). */
const _converted = new Set();

/** Serializes XP distribution so simultaneous NPC deaths don't race on stale reads. */
let _xpChain = Promise.resolve();

/** Build a ChatMessage options object compatible with both V11 (type) and V12+ (style). */
function _chatOpts(content) {
    const opts = {
        content,
        speaker: { alias: "ACE: Engine" },
        whisper: [],
    };
    if (CONST.CHAT_MESSAGE_STYLES) opts.style = CONST.CHAT_MESSAGE_STYLES.OTHER;
    else if (CONST.CHAT_MESSAGE_TYPES) opts.type = CONST.CHAT_MESSAGE_TYPES.OTHER;
    return opts;
}

// ─── PUBLIC: Hook into updateActor for HP → 0 detection ────────────────────

/**
 * Detects HP dropping to 0 and handles death logic.
 * Called from the engine updateActor hook (when NPC chat death pipeline is active).
 * @param {Actor} actor
 * @param {object} changes
 */
export async function onActorHpChange(actor, changes) {
    if (actor.type !== "npc") return;

    const newHp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
    if (newHp === undefined || newHp > 0) return;

    // Unlinked tokens: actor.token points to the SPECIFIC TokenDocument.
    // We MUST use this — searching by actor.id would match ALL tokens of the
    // same creature type (e.g. all bullywugs share one base actor ID).
    const specificToken = actor.token;
    if (specificToken && !specificToken.actorLink) {
        if (_converted.has(specificToken.id)) return;
        console.log(`${TAG} | Unlinked NPC ${specificToken.name} dropped to 0 HP.`);
        _converted.add(specificToken.id);
        await _handleUnlinkedDeath(specificToken);
        return;
    }

    // Linked NPC: find token(s) on scene — they share HP via the base actor.
    const tokens = canvas.scene?.tokens?.filter(t =>
        t.actorLink && t.actor?.id === actor.id
    ) ?? [];

    for (const tokenDoc of tokens) {
        if (_converted.has(tokenDoc.id)) continue;
        // Linked NPCs get death saves, not auto-removed
        console.log(`${TAG} | Linked NPC ${actor.name} dropped to 0 HP — death saves apply.`);
    }
}

/**
 * Explicitly kill a linked NPC (called from GM context menu).
 * @param {TokenDocument} tokenDoc
 */
export async function onLinkedNpcDeath(tokenDoc) {
    if (_converted.has(tokenDoc.id)) return;
    _converted.add(tokenDoc.id);
    console.log(`${TAG} | GM killed linked NPC ${tokenDoc.name}.`);
    await _handleUnlinkedDeath(tokenDoc);
}

// ─── DEATH HANDLING PIPELINE ───────────────────────────────────────────────

async function _handleUnlinkedDeath(tokenDoc) {
    // 1. Remove from combat tracker
    await _removeFromCombat(tokenDoc);

    // 2. Distribute XP to PCs (serialized to prevent stale-read race when
    //    multiple NPCs die simultaneously in the same tick)
    _xpChain = _xpChain.then(() => _distributeXP(tokenDoc)).catch(() => {});
    await _xpChain;

    // 3. Clear voice assignment so resurrection gives a new voice
    try {
        const { onTokenDeath } = await import("../npc/voice-engine.mjs");
        await onTokenDeath(tokenDoc);
    } catch (e) {
        console.warn(`${TAG} | Voice clear on death failed (non-fatal):`, e);
    }
}

// ─── COMBAT REMOVAL ────────────────────────────────────────────────────────

async function _removeFromCombat(tokenDoc) {
    if (!game.combat) return;

    const combatant = game.combat.combatants.find(c =>
        c.tokenId === tokenDoc.id || c.token?.id === tokenDoc.id
    );

    if (combatant) {
        const name = tokenDoc.name || tokenDoc.actor?.name || "NPC";
        await game.combat.deleteEmbeddedDocuments("Combatant", [combatant.id]);
        console.log(`${TAG} | Removed ${name} from combat tracker.`);

        // Notify all players
        const msg = `<i class="fas fa-skull"></i> <strong>${name}</strong> has fallen!`;
        ChatMessage.create(_chatOpts(msg)).catch(() => {});
    }
}

// ─── XP DISTRIBUTION ───────────────────────────────────────────────────────

async function _distributeXP(tokenDoc) {
    try {
        if (!game.settings.get(MODULE_ID, "autoDistributeXP")) return;
    } catch (_) { return; }

    const actor = tokenDoc.actor;
    if (!actor) return;

    const xpValue = actor.system?.details?.xp?.value ?? 0;
    if (xpValue <= 0) return;

    // Find all PCs in the current combat, or on the scene if no combat
    let pcActors = [];

    if (game.combat) {
        pcActors = game.combat.combatants
            .filter(c => c.actor?.type === "character" && c.actor?.hasPlayerOwner)
            .map(c => c.actor)
            .filter(Boolean);
    }

    // Fallback: PCs with tokens on the scene
    if (!pcActors.length) {
        const pcTokens = canvas.scene?.tokens?.filter(t =>
            t.actor?.type === "character" && t.actor?.hasPlayerOwner
        ) ?? [];
        pcActors = pcTokens.map(t => t.actor).filter(Boolean);
    }

    // Deduplicate by actor ID
    const seen = new Set();
    pcActors = pcActors.filter(a => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
    });

    if (!pcActors.length) {
        console.log(`${TAG} | No PCs found for XP distribution.`);
        return;
    }

    const xpEach = Math.floor(xpValue / pcActors.length);
    if (xpEach <= 0) return;

    const npcName = tokenDoc.name || actor.name;

    // Award XP to each PC — re-read current XP just before each write
    // to avoid stale values if another death fired concurrently.
    for (const pc of pcActors) {
        const freshXP = pc.system?.details?.xp?.value ?? 0;
        await pc.update({ "system.details.xp.value": freshXP + xpEach });
    }

    // Chat notification
    const pcNames = pcActors.map(a => a.name).join(", ");
    const msg = `<i class="fas fa-star"></i> <strong>${xpEach} XP</strong> awarded to each PC (${pcNames}) for defeating <strong>${npcName}</strong> (${xpValue} XP total).`;
    ChatMessage.create(_chatOpts(msg)).catch(() => {});

    console.log(`${TAG} | ${xpValue} XP from ${npcName} → ${xpEach} each to ${pcActors.length} PC(s).`);
}
