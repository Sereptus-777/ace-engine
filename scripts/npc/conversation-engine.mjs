// ─── ACE: Engine — NPC AI Conversation Handler ──────────────────────────────
// Builds the full system prompt for an NPC chat turn (rules, persona,
// faction, reputation, world bible, scene intel, document library context),
// then dispatches the call to the AI provider and parses the response.
//
// Moved from ace-envoy/src/ai/conversation.js as part of the
// Envoy → Engine merger. Settings + EngineBridge translated to engine.

import { getFactionContext }                 from "./faction-memory.mjs";
import { buildFactionConversationContext }   from "./faction-registry.mjs";
import { SocialProfileEngine }               from "./social-profile.mjs";
import { surfaceAIFailure, AI_FAILED_REPLY, isAIFailure } from "./ai-failure.mjs";
import { resolveIdentity, buildIdentityPrompt }  from "./npc-identity.mjs";
import { trimHistoryToBudget, getMaxResponseTokens } from "../context-budget.mjs";
import * as Lang from "./language-barrier.mjs";
import * as Perceive from "./scene-perception.mjs";
import { getSecret, getSecretVault } from "../settings.mjs";

// Features that emit a LIST rather than one reply — an entry per item, per
// loot pile. One shared cap truncates these mid-list, so they get headroom.
// (Before 2026-07-24 this stack sent no cap at all and nothing was ever cut.)
const LONG_FORM_CONTEXTS = new Set(["item-descriptions", "loot-generation"]);

const MODULE_ID = "ace-engine";

/** Read engine's AI config (replaces envoy's getEnvoyAIConfig). */
function getEnvoyAIConfig() {
    try {
        return {
            provider: game.settings.get(MODULE_ID, "aiProvider") || "ollama",
            apiKey:   getSecret("apiKey")     || "",
            apiUrl:   game.settings.get(MODULE_ID, "apiUrl")     || "",
            modelName: game.settings.get(MODULE_ID, "modelName") || "",
        };
    } catch (_) {
        return { provider: "ollama", apiKey: "", apiUrl: "", modelName: "" };
    }
}

/** Drop-in stand-in for the Envoy → Engine bridge. We ARE the engine, so we
 *  reach our own public API. Existing `EngineBridge.X(...)` call sites work
 *  unchanged. */
const EngineBridge = {
    isEngineActive:             () => true,
    getReputationContext:       (...args) => game.modules.get(MODULE_ID)?.api?.getReputationContext?.(...args)       ?? "",
    getReputationStats:         (...args) => game.modules.get(MODULE_ID)?.api?.getReputationStats?.(...args)         ?? null,
    getFactionStanding:         (...args) => game.modules.get(MODULE_ID)?.api?.getFactionStanding?.(...args)         ?? "",
    digestLookupContext:        (...args) => game.modules.get(MODULE_ID)?.api?.digestLookupContext?.(...args)        ?? "",
    getDocumentContext:         (...args) => game.modules.get(MODULE_ID)?.api?.getDocumentContext?.(...args)         ?? Promise.resolve(""),
    getLastSearchEntities:      (...args) => game.modules.get(MODULE_ID)?.api?.getLastSearchEntities?.(...args)      ?? {},
    buildProfanityPrompt:       (...args) => game.modules.get(MODULE_ID)?.api?.buildProfanityPrompt?.(...args)       ?? "",
    getSceneIntelligencePrompt: (...args) => game.modules.get(MODULE_ID)?.api?.getSceneIntelligencePrompt?.(...args) ?? Promise.resolve(""),
    getWorldBibleCityContext:   (...args) => game.modules.get(MODULE_ID)?.api?.getWorldBibleCityContext?.(...args)   ?? "",
    searchWorldBible:           (...args) => game.modules.get(MODULE_ID)?.api?.searchWorldBible?.(...args)           ?? "",
    resolveWorldBibleLocation:  (...args) => game.modules.get(MODULE_ID)?.api?.resolveWorldBibleLocation?.(...args)  ?? Promise.resolve(""),
};

/** Max wait time for a direct AI fetch before aborting (ms).
 *  90s accommodates large local models (e.g. 27B+) on first prompt
 *  when Ollama is still loading weights into VRAM. */
// AI request timeout. Increased from 90s → 180s in v1.6.10 because local
// 32B+ models (qwen2.5:32b, llama3.3, etc.) need 60–120 seconds to PREFILL
// the system prompt on first request (the NPC chat system prompt assembles
// ~5–10K input tokens of personality + memory + world bible + scene state).
// After the first request, Ollama caches the prompt prefix and subsequent
// calls are fast (10–20s). Cloud providers (Claude, OpenAI) finish well
// under 30s even with the same context — the larger timeout just gives
// local models room to breathe.
const AI_FETCH_TIMEOUT = 180_000;

/**
 * Default endpoint URL per provider — used when the Chat tier overrides
 * to a different provider than the main one (so we don't accidentally
 * send Claude requests to Ollama's URL etc.).
 */
function _defaultUrlForProvider(provider) {
    switch (provider) {
        case "anthropic":  return "https://api.anthropic.com";
        case "openai":     return "https://api.openai.com";
        case "openrouter": return "https://openrouter.ai/api";
        case "ollama":     return "http://localhost:11434";
        case "lmstudio":
        case "lm-studio":  return "http://localhost:1234";
        default:           return "";
    }
}

/**
 * Resolve the active CHAT-tier provider config for an NPC conversation.
 *
 * Three-tier model split (v1.6.11):
 *   - QUALITY (settings.modelName)       — session summaries, bios, lore
 *   - CHAT    (settings.chatModel)       — real-time NPC conversation
 *   - DIGEST  (settings.digestModel)     — background entity extraction
 *
 * Returns an object the AI fetcher uses to know which provider/url/key/model
 * to call for THIS request. If `chatModel` is unset, falls back to the main
 * Quality config (current behavior — no breaking change).
 *
 * Format of `chatModel`:
 *   ""                       → use main provider + main model
 *   "model-name"             → use main provider, override model only
 *   "provider:model-name"    → cross-provider override (auto-routes URL,
 *                              optionally uses chatApiKey for auth)
 */
function _resolveChatProvider() {
    const main = getEnvoyAIConfig();
    let provider = main.provider;
    let apiKey   = main.apiKey;
    let apiUrl   = main.apiUrl;
    let model    = main.modelName;

    try {
        const cm = game.settings.get(MODULE_ID, "chatModel");
        if (cm && cm.length > 0) {
            const colon = cm.indexOf(":");
            if (colon > 0) {
                // "provider:model" — cross-provider override
                const overrideProvider = cm.slice(0, colon);
                provider = overrideProvider;
                model    = cm.slice(colon + 1);
                // Cross-provider call needs the right URL — derive from provider name
                if (overrideProvider !== main.provider) {
                    apiUrl = _defaultUrlForProvider(overrideProvider) || apiUrl;
                    // Use Chat-specific API key if set (cross-provider needs different auth)
                    const chatKey = getSecret("chatApiKey");
                    if (chatKey && chatKey.length > 0) apiKey = chatKey;
                }
            } else {
                // Bare model name — same provider, different model
                model = cm;
            }
            console.debug(`${MODULE_ID} | Chat using override: ${provider} → ${model}`);
        }
    } catch (_) { /* setting unregistered — fall through to main config */ }

    return { provider, apiKey, apiUrl, modelName: model };
}

export class AIHandler {

    // ── Ollama socket dispatcher (per-call socket.on replacement) ──────────
    // One static handler replaces per-call registrations that accumulate
    // without bound and can cross-fire between concurrent requests.
    static _socketPending = new Map();
    static _socketListenerRegistered = false;

    /**
     * Background prompt warm-up (v1.6.12).
     *
     * Fires a TINY throwaway chat request to the Chat-tier provider purely
     * to load the model into VRAM. Called when a ConversationApp opens —
     * by the time the user types and hits send, the model is already hot
     * (saves the 5–30s "cold-load" delay that hits the first real request
     * after a Foundry session or scene change).
     *
     * Fire-and-forget. Never throws. Never blocks the UI. Quietly skips
     * for cloud providers (Claude / OpenAI are always hot — no model-load
     * concept exists for them). Only Ollama / LM Studio benefit, since
     * those swap models in and out of VRAM based on usage.
     *
     * Cost: one extra request per dialog open, ~2 tokens out. On Ollama
     * this is free. On cloud providers we skip entirely so the warm-up
     * never costs money.
     *
     * Debounced — multiple ConversationApp opens within 30 seconds only
     * fire one warm-up (the model is still hot from the first call).
     */
    static async warmUp() {
        try {
            const chatCfg = _resolveChatProvider();
            // Cloud providers don't have a "cold load" — skip warm-up
            // entirely so we don't waste API spend on a useless ping.
            if (chatCfg.provider !== "ollama" && chatCfg.provider !== "lmstudio" && chatCfg.provider !== "lm-studio") {
                return;
            }
            // Debounce — Ollama keeps a model loaded for ~5 minutes after
            // last use by default. A 30-second debounce on our side is
            // plenty to avoid double-warming when the GM bounces around
            // multiple NPC chats in quick succession.
            const now = Date.now();
            if (AIHandler._lastWarmUpAt && (now - AIHandler._lastWarmUpAt) < 30_000) {
                console.debug(`${MODULE_ID} | warmUp skipped — already warmed within 30s`);
                return;
            }
            AIHandler._lastWarmUpAt = now;

            // Minimal payload — Ollama loads the model on first request
            // regardless of how short the prompt is. "hi" is enough to
            // trigger the VRAM load. We don't care about the response;
            // .then/.catch swallow it so this is true fire-and-forget.
            const messages = [{ role: "user", content: "hi" }];
            AIHandler._fetchOllama(messages, [], {
                modelOverride: chatCfg.modelName,
                urlOverride:   chatCfg.apiUrl,
            }).then(() => {
                console.log(`${MODULE_ID} | Chat model pre-warmed: ${chatCfg.modelName}`);
            }).catch(err => {
                console.debug(`${MODULE_ID} | Chat warm-up failed (non-fatal):`, err?.message ?? err);
            });
        } catch (err) {
            console.debug(`${MODULE_ID} | warmUp threw (non-fatal):`, err?.message ?? err);
        }
    }

    // ─── MAIN ENTRY POINT ────────────────────────────────────────────────────
    static async getResponse(actor, input, history, { speakerActor: externalSpeaker } = {}) {
        const chatCfg = _resolveChatProvider();
        const { provider, apiKey } = chatCfg;
        const scene     = canvas.scene;
        const sceneName = scene?.name || "an unknown location";
        const token     = actor.getActiveTokens()[0];

        // ── NPC Stats ──────────────────────────────────────────────────────
        const intScore     = actor.system?.abilities?.int?.value  ?? 10;
        const wisScore     = actor.system?.abilities?.wis?.value  ?? 10;
        const chaScore     = actor.system?.abilities?.cha?.value  ?? 10;
        const hpCurrent    = actor.system?.attributes?.hp?.value  ?? 1;
        const hpMax        = actor.system?.attributes?.hp?.max    ?? 1;
        const creatureType = (actor.system?.details?.type?.value  || "").toLowerCase();

        // ── WHO vs WHAT (2026-08-06) ──────────────────────────────────────
        // The prompt used to carry only `actor.name`, so a cambion called
        // Lilith Vex had no sanctioned way to mention her own kind and the
        // model substituted it for her name. Resolve both facts up front and
        // hand them over separately. `token` is the on-canvas token when there
        // is one — its name is what the players are actually looking at.
        const identity = resolveIdentity(actor, token?.document ?? null);

        // ── NPC State Checks ─────────────────────────────────────────────
        const isUnconscious = this.hasCondition(actor, ["unconscious", "incapacitated", "stunned"]);
        const hasDeadCondition = this.hasCondition(actor, ["dead"]);
        const isDead           = hasDeadCondition;  // trust dnd5e's condition system; don't shortcut on HP==0

        const isUndead  = creatureType.includes("undead");
        const isAnimal  = (intScore < 6) || creatureType.includes("beast");
        const isWounded = hpCurrent < hpMax * 0.5;
        const npcConditions = this.getConditions(actor);

        // ── Player/Questioner State ──────────────────────────────────────
        // Use the speaker actor resolved at conversation creation time (passed in).
        // Fallback: GM's selected token → player's owned scene token → game.user.character
        let playerActor = externalSpeaker || null;
        // ── CAN HE EVEN UNDERSTAND THEM? (2026-08-07) ─────────────────────
        // Computed here, at the one door every reply comes through, rather
        // than at a call site somebody could forget. Read from dnd5e's own
        // language traits, and fails OPEN when either side has none recorded —
        // a barrier is a hard block on a scene, and blocking one because of an
        // empty field would be the module inventing a rule out of missing data.
        let _barrier = null;
        let playerToken = null;
        if (playerActor) {
            playerToken = playerActor.getActiveTokens()?.[0] ?? canvas.tokens?.placeables?.find(t => t.document?.actorId === playerActor.id) ?? null;
        } else {
            const selectedToken = canvas.tokens?.controlled?.[0];
            if (game.user.isGM && selectedToken && selectedToken.actor?.id !== actor.id) {
                playerActor = selectedToken.actor;
                playerToken = selectedToken;
            } else {
                playerToken = canvas.tokens?.placeables?.find(t =>
                    t.actor?.hasPlayerOwner
                    && t.actor.testUserPermission(game.user, "OWNER")
                    && t.document?.actorId !== actor.id
                );
                playerActor = playerToken?.actor ?? game.user.character;
            }
        }
        const playerConditions = playerActor ? this.getConditions(playerActor) : [];
        const playerHp         = playerActor?.system?.attributes?.hp?.value ?? 1;
        const playerHpMax      = playerActor?.system?.attributes?.hp?.max   ?? 1;
        const playerWounded    = playerHp < playerHpMax * 0.5;
        const playerIntScore   = playerActor?.system?.abilities?.int?.value ?? 10;
        const playerWisScore   = playerActor?.system?.abilities?.wis?.value ?? 10;
        const playerChaScore   = playerActor?.system?.abilities?.cha?.value ?? 10;
        // Race on PCs in dnd5e 5.x is an embedded Item document; extract .name.
        // Older shapes stored a {value:""} object or a plain string.
        const _raceField = playerActor?.system?.details?.race;
        const playerRace = typeof _raceField === "string"
            ? _raceField
            : (typeof _raceField?.name === "string"
                ? _raceField.name
                : (typeof _raceField?.value === "string" ? _raceField.value : ""));
        const playerClass      = playerActor?.items?.find(i => i.type === "class")?.name ?? "";
        const playerLevel      = playerActor?.system?.details?.level ?? 0;
        const playerActiveEffects = playerActor ? this.getActiveEffects(playerActor) : [];

        // ── Distance from NPC to player ──────────────────────────────────
        let distanceContext = "";
        try {
            if (playerToken && token) {
                const gridSizePx = canvas.grid.size;
                const gridFt     = canvas.grid.distance;
                const a = token.center;
                const b = playerToken.center;
                const distFt = typeof game.aceQol?.distanceFt === "function"
                    ? game.aceQol.distanceFt(token, playerToken)
                    : Math.round((Math.hypot(b.x - a.x, b.y - a.y) / gridSizePx) * gridFt);
                if (distFt <= 5)       distanceContext = "The speaker is right beside you, within arm's reach.";
                else if (distFt <= 15) distanceContext = `The speaker is close by, about ${distFt} feet away.`;
                else if (distFt <= 30) distanceContext = `The speaker is ${distFt} feet away — a comfortable conversation distance.`;
                else if (distFt <= 60) distanceContext = `The speaker is ${distFt} feet away — you must raise your voice somewhat.`;
                else                   distanceContext = `The speaker is ${distFt} feet away — quite far, you must project your voice.`;
            }
        } catch(e) { /* ignore distance errors */ }

        // ── Special Spells ───────────────────────────────────────────────
        const hasSpeakWithAnimals = playerActor?.effects.some(e =>
            (e.label || e.name || "").toLowerCase().includes("speak with animals")
        );
        const hasSpeakWithDead = playerActor?.effects.some(e =>
            (e.label || e.name || "").toLowerCase().includes("speak with dead")
        );

        // ─── GATE: UNCONSCIOUS ───────────────────────────────────────────
        if (isUnconscious && !isDead) {
            return `${actor.name} is unconscious and does not respond.`;
        }

        // ─── GATE: DEAD (no magic) ──────────────────────────────────────
        if (isDead && !isUndead && !hasSpeakWithDead) {
            return this.getDeadResponse(actor);
        }

        // ─── GATE: MUTED / NON-SPEAKING (construct, ooze, etc.) ────────
        if (actor.getFlag(MODULE_ID, "voiceMuted")) {
            const type = (creatureType || "creature").toLowerCase();
            const responses = [
                `*${actor.name} turns slowly in your direction, but offers no response.*`,
                `*${actor.name} tilts its form toward you, as if listening, but remains silent.*`,
                `*${actor.name} stares at you blankly. It does not — perhaps cannot — speak.*`,
                `*${actor.name} shifts slightly, acknowledging your presence, but makes no sound.*`,
                `*${actor.name} regards you with what might be curiosity, but says nothing.*`,
                `*A low hum emanates from ${actor.name}, but no words follow.*`,
                `*${actor.name} pauses its movement briefly, then continues as if you weren't there.*`,
            ];
            return responses[Math.floor(Math.random() * responses.length)];
        }

        // ─── GATE: ANIMAL (no magic) ────────────────────────────────────
        if (isAnimal && !hasSpeakWithAnimals) {
            const animalPrompt = `
                You are a ${creatureType || "animal"} named ${actor.name}.
                You cannot speak any humanoid language.
                Respond ONLY with animal sounds. No human words. 1-2 sounds only.
            `.trim();
            return await this.callAI(animalPrompt, [], input, provider, apiKey);
        }

        // ─── NORMAL CONVERSATION ─────────────────────────────────────────
        const alignment   = actor.system?.details?.alignment || "Neutral";
        const alignmentNote = AIHandler.buildAlignmentNote(alignment);
        const personality = actor.getFlag(MODULE_ID, "personality")
                         || actor.flags?.npclink?.personality  // legacy fallback
                         || "A mysterious inhabitant of this world.";
        let   secretLore  = actor.getFlag(MODULE_ID, "secretLore")
                         || actor.flags?.npclink?.secretLore   // legacy fallback
                         || "";
        // Append GM quick-notes to secret knowledge
        const gmNotes = actor.getFlag(MODULE_ID, "gmNotes") || [];
        if (gmNotes.length) {
            const noteBlock = gmNotes.map(n => `- ${n}`).join("\n");
            secretLore = secretLore
                ? `${secretLore}\n\nGM NOTES (additional knowledge):\n${noteBlock}`
                : `GM NOTES (additional knowledge):\n${noteBlock}`;
        }
        const bio         = (actor.system?.details?.biography?.value || "").replace(/<[^>]*>/g, "").trim();

        // ── NPC Character Details (dnd5e sheet fields) ──────────────
        const npcTrait      = (actor.system?.details?.trait      || "").trim();
        const npcIdeal      = (actor.system?.details?.ideal      || "").trim();
        const npcBond       = (actor.system?.details?.bond       || "").trim();
        const npcFlaw       = (actor.system?.details?.flaw       || "").trim();
        const npcAppearance = (actor.system?.details?.appearance || "").trim();

        const journalLore = this.getJournalLore(actor);
        const speechStyle = this.buildSpeechProfile(intScore, wisScore, chaScore, creatureType);
        const npcState    = this.buildNPCStateNote(isDead, isUndead, isWounded, isAnimal, hasSpeakWithAnimals, npcConditions, hpCurrent, hpMax, creatureType, actor);
        const playerNote  = this.buildPlayerStateNote(playerConditions, playerWounded, playerActor, playerHp, playerHpMax, playerIntScore, playerWisScore, playerChaScore, playerRace, playerClass, playerLevel, playerActiveEffects);
        // ── WHAT HE CAN ACTUALLY PERCEIVE (2026-08-07) ────────────────────
        // Replaces buildNearbyActorsSummary, which listed every token within 60
        // feet with NO line-of-sight test — so an NPC knew about a fight through
        // a stone wall, in a sealed room, around a corner. Johnny: "the NPC
        // isn't going to know what's going on down the hallway."
        //
        // Sight uses the real wall geometry, hearing uses Foundry's separate
        // sound walls, and what he MAKES of it is gated on his Intelligence —
        // a dull creature sees someone standing wrong where a learned one sees
        // Hold Person. All local reads; single-digit milliseconds.
        let nearbyNote = "";
        let _scan = null;
        try {
            _scan = Perceive.perceive(token, actor);
            const _changes = Perceive.diff(AIHandler._lastScan?.[actor.id] ?? null, _scan);
            nearbyNote = Perceive.toPrompt(_scan, _changes);
            (AIHandler._lastScan ??= {})[actor.id] = _scan;
            AIHandler._lastGmLine = Perceive.toGmLine(_scan, _changes);
            Hooks.callAll(`${MODULE_ID}.perceptionScan`, { actorId: actor.id, line: AIHandler._lastGmLine, scan: _scan, changes: _changes });
        } catch (err) {
            // A perception failure must never silence an NPC — fall back to the
            // old summary and SAY the scan failed rather than quietly degrading.
            console.warn(`${MODULE_ID} | scene perception failed — falling back to the plain nearby list:`, err);
            nearbyNote = this.buildNearbyActorsSummary(token);
        }
        const sceneNote   = this.buildSceneNote(scene);

        // ── Cross-module: Get reputation context from ACE Engine ─────────
        const reputationContext = AIHandler._getReputationContext(actor);

        // ── Faction memory: what this NPC's kin have reported ─────────────
        const factionContext = AIHandler._getFactionContext(actor);

        // ── Faction registry: named faction identity and hierarchy ────────
        const factionIdentityContext = AIHandler._getFactionRegistryContext(actor);

        // ── Social profile context (local to envoy) ────────────────────
        const socialProfileContext = AIHandler._getSocialProfileContext(actor);

        // ── Combat encounter memory ─────────────────────────────────────
        const combatMemoryContext = AIHandler._getCombatMemoryContext(actor);

        // ── Dynamic NPC state (emotional state, trust, attitude — computed live) ─
        const dynamicStateContext = AIHandler._getDynamicStateContext(actor, playerActor);

        // ── Cross-module: Get document library context from ACE Engine ───
        // Pass last NPC reply for conversation-aware search ("tell me more about that")
        const lastNpcReply = AIHandler._getLastAssistantMsg(history);
        const documentContext = await AIHandler._getDocumentContext(actor, input, lastNpcReply);

        // ── Cross-module: Get World Bible context from ACE Engine ──────
        const worldBibleContext = await AIHandler._getWorldBibleContext(sceneName);

        // ── Cross-module: Cross-store entity linking from document search ──
        const crossStoreContext = AIHandler._getCrossStoreContext();

        // ── Cross-module: Fantasy profanity prompt from ACE Engine ──────
        const profanityPrompt = AIHandler._getProfanityPrompt(sceneName);

        // Resolved now that playerActor is settled. Placed at the TOP of the
        // prompt below because it must outrank personality, tone and every
        // other instruction — an NPC who cannot understand you must not answer
        // your question no matter how chatty its personality is.
        try {
            _barrier = Lang.describeBarrier(actor, playerActor);
            if (!_barrier.understands) {
                console.log(`${MODULE_ID} | LANGUAGE BARRIER — ${actor.name} cannot understand ${playerActor?.name ?? "the speaker"}. ${_barrier.reason}`);
            }
        } catch (err) {
            // Never let a language lookup stop a reply — fail open and say so.
            console.warn(`${MODULE_ID} | language barrier check failed (proceeding as understood):`, err);
            _barrier = null;
        }
        // The gesture rules. Only when the barrier is actually up; two creatures
        // who understand each other just talk.
        //
        // ⚠️ The spoken-language instruction that used to be appended here is
        // GONE. It asked the model to write every line twice behind a [SPOKEN]
        // marker, and mid-roleplay it simply stopped doing it — the line came
        // out in plain English every time. Rendering the finished line is now a
        // separate, deterministic step (AIHandler.renderSpoken), called from
        // ConversationApp._foreignAudioFor, which also covers the GM's own
        // puppet lines that the marker never touched. (2026-08-07)
        const languageDirective = (_barrier && !_barrier.understands)
            ? `${Lang.gesturePromptFor(actor, playerActor, _barrier)}\n\n`
            : "";

        const systemPrompt = `${languageDirective}
${buildIdentityPrompt(actor, token?.document ?? null)}

ALIGNMENT: ${alignment}
${alignmentNote}
SCENE: ${sceneName}
${distanceContext}
${sceneNote}
PERSONALITY: ${personality}
${actor.getFlag(MODULE_ID, "tone") ? `TONE: Speak in a ${actor.getFlag(MODULE_ID, "tone")} manner. This defines your default speaking style — ${
    actor.getFlag(MODULE_ID, "tone") === "formal" ? "proper grammar, measured words, respectful address" :
    actor.getFlag(MODULE_ID, "tone") === "casual" ? "relaxed, colloquial, friendly, uses slang" :
    actor.getFlag(MODULE_ID, "tone") === "cryptic" ? "vague, riddling, mysterious, speaks in metaphors" :
    actor.getFlag(MODULE_ID, "tone") === "cheerful" ? "upbeat, warm, optimistic, finds the bright side" :
    actor.getFlag(MODULE_ID, "tone") === "grim" ? "dark, serious, pessimistic, expects the worst" :
    actor.getFlag(MODULE_ID, "tone") === "sarcastic" ? "dry wit, biting remarks, eye-rolls in every sentence" :
    actor.getFlag(MODULE_ID, "tone") === "threatening" ? "intimidating, menacing, implies violence" :
    actor.getFlag(MODULE_ID, "tone") === "nervous" ? "stammering, uncertain, fidgeting, second-guessing" :
    actor.getFlag(MODULE_ID, "tone") === "stoic" ? "few words, emotionless, direct, wastes no breath" :
    actor.getFlag(MODULE_ID, "tone") === "theatrical" ? "dramatic, grand gestures, flowery language, loves an audience" :
    "adapt naturally"
}. Your conditions (wounded, frightened, etc.) modify this tone but do not replace it.` : ""}
BIOGRAPHY: ${bio}
${npcTrait      ? `PERSONALITY TRAITS: ${npcTrait}` : ""}
${npcIdeal      ? `IDEALS: ${npcIdeal}` : ""}
${npcBond       ? `BONDS: ${npcBond}` : ""}
${npcFlaw       ? `FLAWS: ${npcFlaw}` : ""}
${npcAppearance ? `APPEARANCE: ${npcAppearance}` : ""}
MEMORIES FROM PAST SESSIONS (what you remember): ${journalLore}
SECRET KNOWLEDGE: ${secretLore}
${reputationContext}
${factionContext}
${factionIdentityContext}
${socialProfileContext}
${combatMemoryContext}
${dynamicStateContext}
${worldBibleContext}
${documentContext}
${crossStoreContext}
${profanityPrompt}
YOUR CURRENT STATE:
${npcState}

NEARBY CREATURES:
${nearbyNote}

THE PERSON SPEAKING TO YOU:
${playerNote}

MENTAL STATS:
- Intelligence: ${intScore}
- Wisdom: ${wisScore}
- Charisma: ${chaScore}

SPEECH STYLE:
${speechStyle}

RULES:
- Speak ONLY as ${identity.name}. Use first person ("I", "my") ONLY inside spoken dialogue.
- ALL physical actions, body language, gestures, and emotes MUST be wrapped in *asterisks* and written in THIRD person. NEVER use first person for actions — only for spoken words.
- In those *asterisk* parts, call yourself ${identity.isNamed ? `"${identity.shortName}"` : `"${identity.selfReference}"`}${identity.isNamed && identity.species ? ` — NOT "the ${identity.species}". You have a name; use it.` : "."}
- WRONG: "What's in it for me?" I ask gruffly, my hand drifting to my quiver.
${identity.isNamed
  ? `- WRONG: *The ${identity.species || "creature"} eyes the newcomer.* "What's in it for me?"   ← you are not a nameless ${identity.species || "creature"}; you are ${identity.name}.
- RIGHT: *${identity.shortName} eyes the newcomer, hand drifting to the quiver on ${identity.shortName === identity.name ? "their" : "their"} back.* "What's in it for me? Why would I join a group like yours?"`
  : `- RIGHT: *${identity.selfReference.charAt(0).toUpperCase() + identity.selfReference.slice(1)} eyes the newcomer, hand drifting to the quiver on their back.* "What's in it for me? Why would I join a group like yours?"`}
- NEVER describe, narrate, or control the player character's actions, thoughts, feelings, or body language. You may ONLY write what YOUR character says and does. The player decides what their character does — you do NOT.
- Keep responses to 2-3 sentences.
- Do NOT mention you are an AI.
- CRITICAL — EMBODY YOUR STATE: If you are wounded, poisoned, frightened, restrained, exhausted, or under ANY condition listed above, your speech MUST reflect it in EVERY response. Slur words when poisoned. Stammer when frightened. Gasp and wince when badly hurt. Speak from the ground when prone. This is not optional — a poisoned NPC does NOT speak normally. A frightened NPC does NOT sound brave. Your physical and mental state shapes every word you say.
- REACT TO THEIR STATE: If the person speaking to you is visibly wounded, frightened, restrained, or dying — acknowledge it. Comment on their condition. Offer help or mock their weakness depending on your alignment. A bloodied, dying adventurer crawling toward you demands a reaction — do not ignore it.
- Stay consistent with all provided lore.
- You may invent new lore but must remain consistent with what the GM has provided.
- IMPORTANT: Only reference information your character would reasonably know. If your knowledge comes from "vague rumors", do NOT mention specific names, weapons, or tactics you haven't been told about.
- ALIGNMENT DYNAMICS: Your alignment shapes how you react. An evil NPC is suspicious of do-gooders, a lawful NPC disapproves of chaotic behavior, and opposing alignments create friction. Compatible alignments make trust come easier. Factor both your alignment and the speaker's apparent nature into your willingness to help, trust, or cooperate.
- CHARISMA MATTERS: A speaker with high Charisma is more persuasive, likable, and harder to refuse. A speaker with low Charisma is off-putting, unconvincing, and easy to dismiss. Weight their requests accordingly — a Charisma 18 PC asking for help should be far more compelling than a Charisma 7 PC making the same request. Your OWN Charisma affects how smoothly you communicate back.
- INTELLIGENCE AND WISDOM: A high-INT speaker uses clever arguments you may respect (or resent). A high-WIS speaker reads situations perceptively. Factor the mental gap between you and the speaker — a genius NPC may find a dim-witted PC tedious, while a simpleton NPC might be easily swayed by clever words.
- If the conversation genuinely warrants a skill check from the player (e.g., you are being deceptive and they should roll Insight, or you mention arcane lore they might recognize, or you hint at something hidden they might notice), include this tag ONCE at the END of your response: [SUBTLE_CHECK:skill:dc:flavor text]. Example: [SUBTLE_CHECK:ins:14:Something about this story doesn't quite add up...]. Valid skills: ins, his, arc, rel, nat, prc, inv, sur, med, dec, itm, per, ath, acr, slt, ste, ani. Only use this when genuinely appropriate — do NOT overuse it.
        `.trim();

        // ── THE WORDS NEVER REACH IT (2026-08-07) ─────────────────────────
        // Johnny proved instructions are not enough: he typed "I am your new
        // master" at an elf who speaks no Common, and the elf folded his arms
        // DEFIANTLY — reacting to a meaning he could not have parsed. A model
        // that can read the sentence will react to the sentence, no matter what
        // the prompt says about not understanding it.
        //
        // So when the barrier is up the line is REPLACED, before the call, with
        // a description of how it sounded. There is then no path by which the
        // meaning can leak, because it was never sent.
        //
        // ⚠️ HISTORY TOO. Past turns are sent on every call, so masking only the
        // current line would leak every earlier sentence the player said. The
        // whole user side of the conversation is masked for a barrier turn.
        let _input   = input;
        let _history = history;
        if (_barrier && !_barrier.understands) {
            const who = playerActor?.name ?? "Someone";
            _input = Lang.maskedUtterance(input, who);
            _history = (history ?? []).map(h =>
                h?.role === "user" ? { ...h, content: Lang.maskedUtterance(h.content, who) } : h
            );
            console.log(`${MODULE_ID} | barrier: player's words withheld from the AI — sent instead: ${_input}`);
        }

        // Pass the Chat-tier override (provider, apiUrl, model, key) down
        // so the fetcher hits the right endpoint with the right model.
        return await this.callAI(systemPrompt, _history, _input, provider, apiKey, [], {
            modelOverride: chatCfg.modelName,
            urlOverride:   chatCfg.apiUrl,
        });
    }

    /**
     * RENDER A SPOKEN LINE IN THE STAND-IN LANGUAGE. (2026-08-07)
     *
     * Replaces the `[SPOKEN]` marker, which asked the model to write every line
     * twice mid-roleplay and was simply forgotten — Johnny heard plain English
     * every time. One call, one job, nothing for a character actor to remember.
     *
     * Only the AUDIO changes. The English stays in chat, where Polyglot decides
     * who may read it, so a character who genuinely knows the tongue still gets
     * the meaning. This is purely what the room HEARS.
     *
     * @param {string} text          the finished dialogue, English
     * @param {string|null} langKey  real language key ("hungarian"), or null for invented
     * @param {string} tongueLabel   the fantasy tongue's name, for flavour ("Dwarvish")
     * @returns {Promise<string>}    the line as it sounds, or "" if it could not be made
     */
    static async renderSpoken(text, langKey, tongueLabel = "another tongue") {
        const line = String(text ?? "").trim();
        if (!line) return "";
        try {
            const chatCfg = _resolveChatProvider();
            const { provider, apiKey } = chatCfg;

            const target = langKey
                ? `real, natural ${langKey.charAt(0).toUpperCase() + langKey.slice(1)}`
                : `INVENTED words that sound like a consistent, harsh, alien language — no real language`;

            const sys = [
                `You render a line of dialogue into how it SOUNDS when spoken in ${tongueLabel}.`,
                `Output the line in ${target}.`,
                `HARD RULES:`,
                `- Output ONLY the rendered line. No English, no translation back,`,
                `  no quotes, no explanation, no notes, no romanisation in brackets.`,
                `- Keep it the same LENGTH and force as the original.`,
                `- Keep exclamation marks and question marks so it is spoken with`,
                `  the same energy.`,
                `- If the line is a name, keep the name recognisable.`,
            ].join(String.fromCharCode(10));

            const out = await this.callAI(sys, [], line, provider, apiKey, [], {
                modelOverride: chatCfg.modelName,
                urlOverride:   chatCfg.apiUrl,
            });

            let cleaned = String(out ?? "").trim()
                .replace(/^["'“”]+|["'“”]+$/g, "")
                .split(new RegExp("\r?\n"))[0]   // one line only — models like to add notes
                .trim();
            if (!cleaned || isAIFailure(cleaned)) {
                console.warn(`${MODULE_ID} | spoken rendering unavailable — the line will be read in English.`);
                return "";
            }
            console.log(`${MODULE_ID} | spoken as ${langKey ?? "invented"}: "${line}" -> "${cleaned}"`);
            return cleaned;
        } catch (err) {
            console.warn(`${MODULE_ID} | spoken rendering failed — reading the line in English:`, err);
            return "";
        }
    }

    /**
     * RE-VOICE THE GM'S LINE IN CHARACTER. (Johnny 2026-08-07)
     *
     * Why: a GM's puppet line goes to the voice engine exactly as typed, and
     * "What do you mean?" is four words and one question mark — there is
     * nothing there for a speech engine to perform, so it lands flat and
     * robotic no matter how good the voice is. The AI's own lines sound better
     * purely because they are longer and better punctuated. This gives the GM's
     * line the same treatment.
     *
     * ⚠️ IT RE-VOICES. IT DOES NOT REWRITE. The GM authored the content and
     * keeps it: same meaning, same intent, same length, no new information, no
     * answering a question they did not ask. A hostile personality does not get
     * to turn "what do you mean" into a threat. That constraint is the whole
     * contract — if it drifts, the feature is worse than useless because the GM
     * stops trusting what their own NPC says.
     *
     * Returns the ORIGINAL text on any failure, timeout or empty answer.
     * Losing a GM's line mid-scene is far worse than a flat delivery.
     */
    static async revoiceLine(actor, text, { speakerName = null } = {}) {
        const original = String(text ?? "").trim();
        if (!original) return original;
        try {
            const chatCfg = _resolveChatProvider();
            const { provider, apiKey } = chatCfg;
            const name = speakerName || actor?.name || "the character";

            const personality = actor?.getFlag?.(MODULE_ID, "personality") || "";
            const tone        = actor?.getFlag?.(MODULE_ID, "tone") || "";

            const sys = [
                `You are a dialogue editor. ${name} is about to say a line out loud.`,
                personality ? `${name}'s personality: ${personality}` : "",
                tone ? `${name}'s speaking tone: ${tone}` : "",
                ``,
                `Rewrite the line SO IT SOUNDS LIKE ${name.toUpperCase()} SAYING IT.`,
                `HARD RULES — breaking any of these makes the result useless:`,
                `- Keep the MEANING exactly. Do not answer anything, add information,`,
                `  change the subject, or introduce opinions the line does not contain.`,
                `- Keep it the same LENGTH. A four-word line stays about four words.`,
                `  Never turn a short line into a speech.`,
                `- You MAY add natural punctuation, a pause, or ONE short *emote in`,
                `  asterisks* describing how they say it.`,
                `- Do not add a name tag, quotation marks, or any commentary.`,
                `- Output ONLY the finished line. Nothing else.`,
            ].filter(Boolean).join(String.fromCharCode(10));

            const out = await this.callAI(sys, [], original, provider, apiKey, [], {
                modelOverride: chatCfg.modelName,
                urlOverride:   chatCfg.apiUrl,
            });

            const cleaned = String(out ?? "").trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
            if (!cleaned) return original;
            if (isAIFailure(cleaned)) return original;

            // A runaway rewrite is a rewrite, not a re-voice. If it has ballooned
            // well past the GM's line, the model has started writing its own
            // dialogue — take the original rather than put words in their mouth.
            const words = (str) => str.split(/\s+/).filter(Boolean).length;
            if (words(cleaned) > Math.max(12, words(original) * 3)) {
                console.warn(`${MODULE_ID} | revoice REJECTED — model ballooned ${words(original)} words into ${words(cleaned)}. Speaking the GM's line as typed.`);
                return original;
            }
            return cleaned;
        } catch (err) {
            console.warn(`${MODULE_ID} | revoice failed — speaking the GM's line as typed:`, err);
            return original;
        }
    }

    // ── Cross-Module: Get reputation context from ACE Engine (via bridge) ──
    static _getReputationContext(actor) {
        try {
            return EngineBridge.getReputationContext(actor.name);
        } catch(e) {
            console.warn("ACE: Engine | Failed to get reputation context from ACE Engine:", e);
        }
        return "";
    }

    // ── Faction Memory: Get shared faction awareness context ────────────
    static _getFactionContext(actor) {
        try {
            return getFactionContext(actor) || "";
        } catch(e) {
            console.warn("ACE: Engine | Failed to get faction context:", e);
        }
        return "";
    }

    // ── Faction Registry: Get named faction identity context ────────────
    static _getFactionRegistryContext(actor) {
        try {
            return buildFactionConversationContext(actor) || "";
        } catch(e) {
            console.warn("ACE: Engine | Failed to get faction registry context:", e);
        }
        return "";
    }

    // ── Social Profile: local context (no cross-module dependency) ─────
    static _getSocialProfileContext(actor) {
        try {
            const spEnabled = game.settings.get(MODULE_ID, "enableSocialProfiles") ?? true;
            if (!spEnabled) return "";
            const profile = SocialProfileEngine.retrieve(actor);
            return SocialProfileEngine.buildPromptContext(profile) || "";
        } catch (e) {
            console.warn("ACE: Engine | Failed to get social profile context:", e);
        }
        return "";
    }

    // ── Combat Encounter Memory: NPC remembers fighting the party ─────
    static _getCombatMemoryContext(actor) {
        try {
            const encounters = actor.getFlag(MODULE_ID, "combatEncounters");
            if (!encounters?.length) return "";

            const recent = encounters.slice(-3);
            const lines = ["\nCOMBAT MEMORY — you have fought these adventurers before:"];
            for (const enc of recent) {
                const names = (enc.pcNames || []).join(", ");
                const scene = enc.sceneName || "an unknown location";
                lines.push(`- You ${enc.outcome || "survived"} a fight with ${names} at ${scene}.`);
            }
            lines.push("You remember their faces and fighting styles. React accordingly — with fear, respect, anger, or caution depending on your disposition.");
            return lines.join("\n");
        } catch (e) {
            console.warn("ACE: Engine | Failed to get combat memory context:", e);
        }
        return "";
    }

    // ── Dynamic NPC State: emotional state + trust + attitude ──────────
    // Computed fresh at conversation time from live game state. Not stored.
    static _getDynamicStateContext(actor, playerActor) {
        try {
            const profile = SocialProfileEngine.retrieve(actor);
            if (!profile) return "";

            const lines = ["\nCURRENT DYNAMIC STATE (how this NPC feels RIGHT NOW):"];

            // ── Emotional State (derived from conditions + game state) ──
            const hp = actor.system?.attributes?.hp?.value ?? 0;
            const hpMax = actor.system?.attributes?.hp?.max ?? 1;
            const hpRatio = hpMax > 0 ? hp / hpMax : 1;
            const conditions = new Set();
            try {
                for (const e of actor.effects ?? []) {
                    if (!e.disabled) conditions.add((e.name || e.label || "").toLowerCase());
                }
            } catch { /* effects may not be iterable */ }

            let emotion = "calm";
            if (hp <= 0) emotion = "dying or incapacitated";
            else if (hpRatio < 0.25) emotion = "terrified — barely clinging to life";
            else if (hpRatio < 0.5) emotion = "frightened and in pain";
            else if (conditions.has("frightened")) emotion = "shaking with fear";
            else if (conditions.has("charmed")) emotion = "unusually warm and trusting";
            else if (conditions.has("poisoned")) emotion = "nauseous and disoriented";
            else if (conditions.has("exhaustion")) emotion = "bone-tired, barely standing";
            else {
                // Check faction memory for recent trauma
                const encounters = actor.getFlag(MODULE_ID, "combatEncounters") ?? [];
                const recentFight = encounters.length > 0;
                const disposition = profile.disposition ?? "pragmatic";
                if (recentFight && disposition === "broken") emotion = "haunted — the last fight left scars";
                else if (recentFight) emotion = "wary — remembers recent violence";
                else if (disposition === "broken") emotion = "despairing — going through the motions";
                else if (disposition === "fanatical") emotion = "fervent — burning with conviction";
                else if (disposition === "ambitious") emotion = "calculating — always thinking ahead";
                else if (disposition === "conflicted") emotion = "uneasy — wrestling with doubts";
                else emotion = "composed — baseline demeanor";
            }
            lines.push(`- Emotional State: ${emotion}`);

            // ── Trust Level (derived from multiple sources) ──
            let trust = 2; // stranger baseline

            // Base attitude modifier
            const baseAtt = profile.context?.baseAttitude ?? "suspicious";
            const attBonus = { welcoming: 3, curious: 2, indifferent: 0, suspicious: -1, opportunistic: 0, hostile: -3, terrified: -2 };
            trust += (attBonus[baseAtt] ?? 0);

            // Reputation modifier (via bridge)
            try {
                const stats = EngineBridge.getReputationStats();
                if (stats) {
                    const notorietyBonus = { unknown: 0, local: 1, regional: 2, continental: 3, legendary: 4 };
                    const communityVal = (profile.values?.community ?? 5) / 10;
                    trust += Math.round((notorietyBonus[stats?.notoriety] ?? 0) * communityVal);
                }
            } catch { /* ace-engine not available, that's fine */ }

            // Faction standing modifier (via bridge)
            try {
                const factionId = actor.getFlag(MODULE_ID, "factionId");
                if (factionId) {
                    const standing = EngineBridge.getFactionStanding(factionId);
                    const standingBonus = { revered: 4, friendly: 2, neutral: 0, suspicious: -1, hostile: -3, hated: -5 };
                    trust += (standingBonus[standing] ?? 0);
                }
            } catch { /* no faction or no engine */ }

            // Need-desperation modifier: if NPC needs something the party could provide
            const need = profile.innerLife?.need ?? "";
            const needUrgency = actor.getFlag(MODULE_ID, "needUrgency") ?? 0;
            if (need && !need.includes("nothing") && !need.includes("self-sufficient") && needUrgency > 0) {
                const survivalVal = (profile.values?.survival ?? 5) / 10;
                trust += Math.round(needUrgency * survivalVal);
            }

            // Combat encounter modifier
            const encounters = actor.getFlag(MODULE_ID, "combatEncounters") ?? [];
            if (encounters.length > 0) {
                trust -= 2; // fought before = trust penalty
            }

            // Direct interaction history
            const memoryLog = actor.getFlag(MODULE_ID, "memoryLog") ?? [];
            if (memoryLog.length > 0) trust += Math.min(memoryLog.length, 3); // each past conversation builds trust slightly

            trust = Math.max(0, Math.min(10, trust));
            const trustLabels = ["Stranger — says nothing freely", "Stranger — guarded", "Wary — minimal cooperation",
                "Cautious — polite but reserved", "Acquaintance — willing to share surface info",
                "Acquaintance — relaxed, shares opinions", "Familiar — open, might ask for help",
                "Familiar — confides small concerns", "Trusted — shares secrets, offers real help",
                "Trusted — would take risks for the party", "Bonded — absolute trust, shares everything"];
            lines.push(`- Trust Level: ${trust}/10 — ${trustLabels[trust]}`);

            // ── Current Attitude (base + modifiers) ──
            let attitude = baseAtt;
            if (trust >= 7) attitude = "cooperative and open";
            else if (trust >= 5) attitude = "cautiously friendly";
            else if (trust >= 3) attitude = "guarded but polite";
            else if (trust <= 1 && baseAtt !== "hostile") attitude = "cold and dismissive";
            lines.push(`- Current Attitude: ${attitude}`);

            // ── Need Urgency ──
            if (need && !need.includes("nothing") && !need.includes("self-sufficient")) {
                const urgencyLabels = ["not urgent", "mild concern", "growing worry", "desperate", "life-or-death"];
                const u = Math.min(needUrgency, 4);
                lines.push(`- Need: "${need}" — urgency: ${urgencyLabels[u]}`);
                if (u >= 2) lines.push("  (NPC will bring up their need unprompted if trust is high enough)");
            }

            lines.push("");
            return lines.join("\n");
        } catch (e) {
            console.warn("ACE: Engine | Dynamic state computation failed:", e);
        }
        return "";
    }

    // ── Cross-Module: Get document library context from ACE Engine ─────
    // Strategy: direct digest lookup FIRST for canonical NPC identity,
    // then chunk search for supplementary prose detail.
    static async _getDocumentContext(actor, userMessage, lastAssistantMsg = "") {
        try {
            // 1. Direct digest lookup — instant, structured, canonical (via bridge)
            const directCtx = EngineBridge.digestLookupContext(actor.name, { maxChars: 3000 });

            // 2. Chunk search for supplementary prose — reduced budget if direct lookup found data
            const chunkBudget = directCtx.length > 20 ? 5000 : 8000;
            const chunkCtx = await EngineBridge.getDocumentContext(actor.name, userMessage, {
                lastAssistantMsg,
                maxChars: chunkBudget,
            });

            // Combine: direct lookup (canonical) + chunks (detail)
            return [directCtx, chunkCtx].filter(s => s.length > 10).join("\n");
        } catch(e) {
            console.warn("ACE: Engine | Failed to get document context from ACE Engine:", e);
        }
        return "";
    }

    // ── Cross-Module: Cross-store entity linking from document search ────
    // After document search, look up discovered NPCs/locations in the
    // reputation/fame engines for richer NPC conversation context.
    static _getCrossStoreContext() {
        try {
            const entities = EngineBridge.getLastSearchEntities();
            const npcNames = entities.npcs ?? [];
            if (!npcNames.length) return "";

            // Look up reputation data for NPCs discovered in PDF results (via bridge)
            const parts = [];
            for (const name of npcNames.slice(0, 5)) {
                const repCtx = EngineBridge.getReputationContext(name);
                if (repCtx && repCtx.length > 10) {
                    parts.push(repCtx);
                }
            }
            if (!parts.length) return "";
            return `\n── RELATED NPC INTEL (from campaign records) ──\n${parts.join("\n")}`;
        } catch(e) {
            console.warn("ACE: Engine | Cross-store entity linking failed:", e);
            return "";
        }
    }

    // ── Cross-Module: Fantasy profanity prompt from ACE Engine ───────────
    static _getProfanityPrompt(sceneName = "") {
        try {
            return EngineBridge.buildProfanityPrompt();
        } catch { /* ACE Engine not available */ }
        return "";
    }

    // ── Extract last assistant message from conversation history ─────────
    static _getLastAssistantMsg(history) {
        if (!Array.isArray(history) || !history.length) return "";
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === "assistant" && history[i].content) {
                return history[i].content.slice(-1500); // Last 1500 chars for context
            }
        }
        return "";
    }

    // ── Cross-Module: Get scene intelligence / World Bible context from ACE Engine ──
    static async _getWorldBibleContext(sceneName) {
        try {
            // Prefer Scene Intelligence (comprehensive, cached per scene) — via bridge
            const intelPrompt = await EngineBridge.getSceneIntelligencePrompt(sceneName);
            if (intelPrompt && intelPrompt.length > 20) {
                return intelPrompt + "\nUse this scene intelligence naturally in conversation — reference local rulers, factions, religions, and tensions as a local would.";
            }

            // Fallback to basic World Bible search (via bridge)
            let ctx = EngineBridge.getWorldBibleCityContext(sceneName);
            if (!ctx) ctx = EngineBridge.searchWorldBible(`${sceneName}`, 3);
            if (!ctx) ctx = await EngineBridge.resolveWorldBibleLocation(sceneName);
            if (ctx) {
                return ctx + "\nUse this world knowledge naturally in conversation — reference local rulers, factions, religions, and tensions as a local would.";
            }
        } catch(e) {
            console.warn("ACE: Engine | Failed to get scene intelligence / World Bible context from ACE Engine:", e);
        }
        return "";
    }

    // ─── CALL AI PROVIDER ────────────────────────────────────────────────────
    /**
     * Three-tier override support (v1.6.11): `opts.modelOverride` and
     * `opts.urlOverride` are passed in from getResponse when the GM has
     * configured a Chat-tier model that differs from the main Quality
     * model. When unset, we fall back to the main config (no change to
     * pre-v1.6.11 behavior).
     */
    static async callAI(systemPrompt, history, input, provider, apiKey, images = [], opts = {}) {
        // Honour the GM's Max Context Tokens setting. NPC chat previously had
        // no size budget at all — only a 20-message cap — so a long roleplay
        // scene could quietly balloon the request. Generators pass an empty
        // history, so this is a no-op for them.
        // Which FEATURE is calling. Everything funnels through callAI — NPC
        // chat, bio generation, faction naming, memory summaries — so a
        // hard-coded "npc-chat" label made a bio failure look like a chat
        // failure and sent a real debugging session down the wrong path.
        const ctxLabel = opts.context || "npc-chat";

        // Output ceiling. Honours the GM's Max Response Tokens slider — which
        // until now this entire stack ignored, so the slider was a dial that
        // moved nothing for NPC chat, bios, loot or summaries.
        const maxTokens = Number(opts.maxTokens) > 0
            ? Number(opts.maxTokens)
            : (LONG_FORM_CONTEXTS.has(ctxLabel)
                ? Math.max(getMaxResponseTokens(), 3000)
                : getMaxResponseTokens());
        const budgetedHistory = trimHistoryToBudget(history);
        const messages = [
            { role: "system", content: systemPrompt },
            ...budgetedHistory,
            { role: "user", content: input }
        ];

        // Prompt-size + shape diagnostics. The NPC stack never logged this, so
        // an over-long or malformed request was invisible — you just got a bare
        // 400 with nothing to go on. `bad` catches the shapes providers reject
        // outright: a null/undefined/empty content, or a role they don't accept.
        try {
            const chars = messages.reduce((n, m) => n + (typeof m?.content === "string" ? m.content.length : 0), 0);
            const bad = messages
                .map((m, i) => ({ i, role: m?.role, type: typeof m?.content,
                                  len: typeof m?.content === "string" ? m.content.length : -1 }))
                .filter(m => !["system", "user", "assistant"].includes(m.role) || m.type !== "string" || m.len === 0);
            console.debug(`${MODULE_ID} | NPC prompt: ${messages.length} msgs, ~${chars.toLocaleString()} chars (~${Math.round(chars / 3.5).toLocaleString()} tokens), system ${String(systemPrompt ?? "").length.toLocaleString()}`);
            if (bad.length) console.warn(`${MODULE_ID} | NPC prompt has ${bad.length} message(s) a provider will reject:`, bad);
        } catch (_) { /* diagnostics must never block a call */ }

        // Effective config — prefer the per-call overrides, fall back to main.
        const aiCfg = getEnvoyAIConfig();
        const useModel  = opts.modelOverride || aiCfg.modelName;
        const useUrl    = opts.urlOverride   || aiCfg.apiUrl;
        const useApiKey = apiKey             || aiCfg.apiKey;

        // ── Anthropic (different API format) ─────────────────────────────
        if (provider === "anthropic") {
            if (!useApiKey) {
                return surfaceAIFailure({ provider: "anthropic", rawBody: "no api key set", context: ctxLabel });
            }
            try {
                // Always use Anthropic's URL — don't inherit apiUrl which may be set to another provider
                const anthropicUrl = "https://api.anthropic.com";
                const sysMsg = messages.find(m => m.role === "system")?.content || "";
                let nonSys = messages.filter(m => m.role !== "system");
                // Inject images into the last user message (multimodal content blocks)
                if (images?.length) {
                    nonSys = nonSys.map(m => ({ ...m }));
                    const lastUser = [...nonSys].reverse().find(m => m.role === "user");
                    if (lastUser) {
                        const text = typeof lastUser.content === "string" ? lastUser.content : lastUser.content;
                        lastUser.content = [
                            ...images.map(img => ({
                                type: "image",
                                source: { type: "base64", media_type: img.mimeType, data: img.base64 },
                            })),
                            { type: "text", text: typeof text === "string" ? text : JSON.stringify(text) },
                        ];
                    }
                }
                const ctrl = AbortSignal.timeout(AI_FETCH_TIMEOUT);
                const response = await fetch(`${anthropicUrl}/v1/messages`, {
                    method: "POST",
                    signal: ctrl,
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": useApiKey,
                        "anthropic-version": "2023-06-01",
                        "anthropic-dangerous-direct-browser-access": "true",
                    },
                    body: JSON.stringify({
                        model: useModel || "claude-sonnet-4-20250514",
                        max_tokens: maxTokens,
                        system: sysMsg,
                        messages: nonSys,
                        temperature: 0.7,
                    }),
                });
                if (!response.ok) {
                    const rawBody = await response.text().catch(() => "");
                    return surfaceAIFailure({ provider: "anthropic", status: response.status, rawBody, context: ctxLabel });
                }
                const data = await response.json();
                if (data.error) {
                    return surfaceAIFailure({ provider: "anthropic", status: response.status, rawBody: data.error.message || JSON.stringify(data.error), context: ctxLabel });
                }
                const text = data.content?.[0]?.text || "";
                console.debug("AI Handler | Anthropic Response:", text);
                return text || "My thoughts are scattered...";
            } catch (err) {
                return surfaceAIFailure({ provider: "anthropic", error: err, context: ctxLabel });
            }
        }

        // ── OpenAI / OpenRouter / LM Studio / Custom (OpenAI-compatible) ─
        if (["openai", "openrouter", "lm-studio", "lmstudio", "custom"].includes(provider)) {
            if (!useApiKey && provider === "openai") {
                return surfaceAIFailure({ provider: "openai", rawBody: "no api key set", context: ctxLabel });
            }
            try {
                // Inject images into messages for OpenAI vision format
                let oaiMessages = messages;
                if (images?.length) {
                    oaiMessages = messages.map(m => ({ ...m }));
                    const lastUser = [...oaiMessages].reverse().find(m => m.role === "user");
                    if (lastUser && typeof lastUser.content === "string") {
                        lastUser.content = [
                            ...images.map(img => ({
                                type: "image_url",
                                image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
                            })),
                            { type: "text", text: lastUser.content },
                        ];
                    }
                }
                const headers = { "Content-Type": "application/json" };
                if (useApiKey) headers["Authorization"] = `Bearer ${useApiKey}`;
                const response = await fetch(`${useUrl}/v1/chat/completions`, {
                    method: "POST",
                    signal: AbortSignal.timeout(AI_FETCH_TIMEOUT),
                    headers,
                    // Fallback model must be VALID FOR THIS PROVIDER. A bare
                    // "gpt-4o" is not a model OpenRouter recognises — it wants
                    // the full vendor/model slug — so the old shared default
                    // guaranteed a 400 for any OpenRouter user whose model
                    // setting was ever blank.
                    body: JSON.stringify({
                        model: useModel || (provider === "openrouter" ? "openai/gpt-4o-mini" : "gpt-4o-mini"),
                        messages: oaiMessages, temperature: 0.7, max_tokens: maxTokens,
                    })
                });
                if (!response.ok) {
                    const rawBody = await response.text().catch(() => "");
                    return surfaceAIFailure({ provider, status: response.status, rawBody, context: ctxLabel });
                }
                const data = await response.json();
                if (data.error) {
                    return surfaceAIFailure({ provider, status: response.status, rawBody: data.error.message || JSON.stringify(data.error), context: ctxLabel });
                }
                const text = data.choices?.[0]?.message?.content;
                console.debug(`AI Handler | ${provider} Response:`, text);
                return text || "My thoughts are scattered...";
            } catch (err) {
                return surfaceAIFailure({ provider, error: err, context: ctxLabel });
            }
        }

        // ── Ollama (local) via GM socket proxy (default) ────────────────
        try {
            // Pass `images` through — when present, Ollama call switches to
            // /api/chat (native vision endpoint) and injects images on the
            // last user message in Ollama's expected format.
            // v1.6.11: `opts` carries Chat-tier overrides (modelOverride,
            // urlOverride) so a GM running e.g. Quality=qwen2.5:32b can
            // route Chat through dolphin3:8b without touching main settings.
            const text = await AIHandler._callOllamaViaGM(messages, images, opts);
            if (!text) {
                ui.notifications?.warn("Ollama returned an empty response. Is your model loaded? Try: ollama pull llama3.2");
                return "My mind is foggy...";
            }
            console.debug("AI Handler | Ollama Response:", text);
            return text;
        } catch (err) {
            console.error("AI Handler | Ollama Error:", err);
            const isTimeout = err.message?.includes("timed out") || err.name === "AbortError";
            const isNetwork = err.message?.includes("Failed to fetch") || err.message?.includes("NetworkError") || err.message?.includes("not responding");
            if (isNetwork) {
                // Friendly action dialog (once per session) instead of a permanent red banner.
                try {
                    const { showOllamaDownDialog } = await import("../connection-dialog.mjs");
                    const apiUrl = (() => { try { return game.settings.get(MODULE_ID, "apiUrl") || "http://localhost:11434"; } catch (_) { return "http://localhost:11434"; } })();
                    showOllamaDownDialog({ message: err.message, url: apiUrl });
                } catch (e) {
                    // Fallback to a non-permanent toast if the dialog import fails
                    ui.notifications?.error(`Ollama isn't responding. Open ACE Engine settings to switch provider or test connection.`);
                }
            } else if (isTimeout) {
                ui.notifications?.warn("Ollama is taking too long to respond. The model may still be loading — try again in a moment.");
            } else {
                ui.notifications?.warn(`Ollama error: ${err.message?.slice(0, 100) || "Unknown error"}. Check the console for details.`);
            }
            return "My mind is foggy...";
        }
    }

    // ─── OLLAMA CALLER ──────────────────────────────────────────────────────
    // `images` is an array of { base64, mimeType }. When present, the call
    // switches from /v1/chat/completions (OpenAI-compat) to /api/chat
    // (Ollama's native vision endpoint) and attaches images to the last
    // user message using Ollama's expected `message.images = [base64...]`
    // shape. Vision-capable models (llava, llama3.2-vision, qwen2-vl,
    // bakllava) honor this; non-vision models silently ignore it.
    static _callOllamaViaGM(messages, images = [], opts = {}) {
        if (game.user.isGM) {
            return AIHandler._fetchOllama(messages, images, opts);
        }
        return AIHandler._callOllamaViaSocket(messages, images);
    }

    static async _fetchOllama(messages, images = [], opts = {}) {
        const { apiUrl, modelName } = getEnvoyAIConfig();
        // v1.6.11: opts.urlOverride / opts.modelOverride from Chat tier
        const ollamaUrl   = opts.urlOverride   || apiUrl   || "http://localhost:11434";
        const ollamaModel = opts.modelOverride || modelName || "llama3.2";

        // ── Vision path: use Ollama's native /api/chat endpoint ──
        // The OpenAI-compat /v1/chat/completions endpoint may strip Ollama's
        // image format, so when images are present we use the native endpoint
        // and Ollama's own message shape.
        if (images?.length) {
            const visionMessages = messages.map(m => ({ ...m }));
            const lastUser = [...visionMessages].reverse().find(m => m.role === "user");
            if (lastUser) lastUser.images = images.map(img => img.base64);

            const res = await fetch(`${ollamaUrl}/api/chat`, {
                method:  "POST",
                signal:  AbortSignal.timeout(AI_FETCH_TIMEOUT),
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ model: ollamaModel, messages: visionMessages, stream: false }),
            });
            const json = await res.json();
            if (json.error) throw new Error(json.error);
            const text = json.message?.content;
            if (!text) throw new Error("Ollama returned no content");
            return text;
        }

        // ── Non-vision path: keep existing OpenAI-compat endpoint ──
        const res  = await fetch(`${ollamaUrl}/v1/chat/completions`, {
            method:  "POST",
            signal:  AbortSignal.timeout(AI_FETCH_TIMEOUT),
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ model: ollamaModel, messages, temperature: 0.7 })
        });
        const json = await res.json();
        if (json.error) throw new Error(json.error);
        const text = json.choices?.[0]?.message?.content;
        if (!text) throw new Error("Ollama returned no content");
        return text;
    }

    static _callOllamaViaSocket(messages, images = []) {
        // One-time listener registration — prevents unbounded accumulation of per-call
        // handlers that could cross-fire between concurrent requests.
        if (!AIHandler._socketListenerRegistered) {
            AIHandler._socketListenerRegistered = true;
            game.socket.on(`module.${MODULE_ID}`, (data) => {
                if (data.action !== "ollamaResponse") return;
                const pending = AIHandler._socketPending.get(data.requestId);
                if (!pending) return;
                AIHandler._socketPending.delete(data.requestId);
                clearTimeout(pending.timeout);
                if (data.error) pending.reject(new Error(data.error));
                else pending.resolve(data.text);
            });
        }
        return new Promise((resolve, reject) => {
            const requestId = foundry.utils.randomID();
            // v1.6.13: bumped from 30s → 180s to match AI_FETCH_TIMEOUT.
            // The GM-side fetch to Ollama can take 60–120s on the FIRST
            // message of a session (cold model load + 8K-char system
            // prompt prefill). The previous 30s ceiling left players
            // staring at "My mind is foggy..." (the hardcoded fallback
            // that fires on any failed call) every time, even when the
            // GM was actually getting a real response from Ollama —
            // they just never lived long enough to see it. After the
            // first message the prompt prefix is cached and subsequent
            // calls return in 5–10s.
            const SOCKET_PROXY_TIMEOUT_MS = 180_000;
            const timeout = setTimeout(() => {
                AIHandler._socketPending.delete(requestId);
                reject(new Error(`Ollama GM proxy timed out after ${SOCKET_PROXY_TIMEOUT_MS / 1000}s — is a GM logged in?`));
            }, SOCKET_PROXY_TIMEOUT_MS);
            AIHandler._socketPending.set(requestId, { resolve, reject, timeout });
            game.socket.emit(`module.${MODULE_ID}`, {
                action: "ollamaRequest",
                requestId,
                messages,
                images,  // forwarded so the GM-side handler can include them in the actual fetch
            });
        });
    }

    // ─── SCENE CONTEXT ──────────────────────────────────────────────────────
    static buildSceneNote(scene) {
        if (!scene) return "";
        // Check ace-engine flags first, then legacy npclink flags
        const weather  = scene.getFlag(MODULE_ID, "weather")
                      || scene.flags?.npclink?.weather || "";
        const location = scene.getFlag(MODULE_ID, "locationDescription")
                      || scene.flags?.npclink?.locationDescription || "";
        const lines = [];
        if (weather)  lines.push(`WEATHER: ${weather}`);
        if (location) lines.push(`ENVIRONMENT: ${location}`);
        return lines.join("\n");
    }

    // ─── NEARBY TOKENS ──────────────────────────────────────────────────────
    static buildNearbyActorsSummary(originToken) {
        if (!originToken || !canvas?.tokens) return "No nearby tokens detected.";

        const MAX_RANGE_FEET = 60;
        const gridSize       = canvas.grid.size;
        const gridDist       = canvas.grid.distance || 5;

        const others = canvas.tokens.placeables.filter(t => {
            if (t.id === originToken.id || t.document.hidden) return false;
            // ⚠️ Edge-to-edge when ace-qol is present. Centre-to-centre puts a
            // Large creature a full square further away than it really is, so
            // earshot quietly excluded big NPCs standing right beside the party.
            const proper = game.aceQol?.distanceFt;
            const distFeet = typeof proper === "function"
                ? proper(t, originToken)
                : (Math.hypot(t.center.x - originToken.center.x,
                              t.center.y - originToken.center.y) / gridSize) * gridDist;
            return distFeet <= MAX_RANGE_FEET;
        });

        if (!others.length) return "No nearby tokens detected.";

        return others.map(t => {
            const a = t.center;
            const b = originToken.center;
            const distPixels = Math.hypot(a.x - b.x, a.y - b.y);
            const distFeet   = Math.round((distPixels / gridSize) * gridDist);
            const relation   = t.actor?.getFlag(MODULE_ID, "relationship")
                            || t.actor?.flags?.npclink?.relationship || "unknown";
            const type       = t.actor?.type || "creature";
            return `- ${t.name} (${type}), ~${distFeet}ft away, relationship: ${relation}`;
        }).join("\n");
    }

    // ─── NPC STATE ──────────────────────────────────────────────────────────
    static buildAlignmentNote(alignment) {
        const a = (alignment || "").toLowerCase();
        const notes = [];

        if (a.includes("lawful"))  notes.push("You respect order, hierarchy, and keeping your word. You honor deals and codes.");
        if (a.includes("chaotic")) notes.push("You value freedom and personal choice over rules. You act on impulse and distrust authority.");
        if (a.includes("neutral") && !a.includes("good") && !a.includes("evil"))
            notes.push("You are pragmatic — rules and chaos both have their place depending on the situation.");

        if (a.includes("good"))  notes.push("You genuinely care about others' wellbeing. You help when you can and avoid unnecessary harm.");
        if (a.includes("evil"))  notes.push("You prioritize your own desires and power. You manipulate, threaten, or harm when it serves you. You enjoy having the upper hand.");
        if (a.includes("neutral") && (a.includes("lawful") || a.includes("chaotic") || a === "neutral"))
            notes.push("You are neither selfless nor cruel — you act in your own interest without malice.");

        if (a === "lawful evil")      notes.push("You are methodical and calculating. You use law and order as tools for control. Every action serves a long-term agenda.");
        if (a === "chaotic evil")     notes.push("You are unpredictable and dangerous. You act on dark impulses with little regard for consequences.");
        if (a === "lawful good")      notes.push("You uphold justice and protect the innocent. You work within systems to do what is right.");
        if (a === "chaotic good")     notes.push("You follow your heart over rules. You rebel against injustice but sometimes cause collateral chaos.");
        if (a === "neutral evil")     notes.push("You are coldly self-serving. You use whoever and whatever benefits you, with no loyalty to anyone.");
        if (a === "lawful neutral")   notes.push("You follow codes and structures above all. Right and wrong matter less than order and consistency.");
        if (a === "chaotic neutral")  notes.push("You do whatever you want. Freedom is paramount and you resist being controlled or categorized.");
        if (a === "true neutral")     notes.push("You seek balance and avoid extremes. You weigh situations carefully without ideological bias.");
        if (a === "neutral good")     notes.push("You do the most good you can without rigid rules. You are kind, flexible, and genuinely helpful.");

        return notes.length ? `ALIGNMENT BEHAVIOR:\n${notes.map(n => "- "+n).join("\n")}` : "";
    }

    static buildNPCStateNote(isDead, isUndead, isWounded, isAnimal, hasSpeakWithAnimals, conditions, hpCurrent, hpMax, creatureType, actor = null) {
        const lines = [];
        const pct = hpMax > 0 ? Math.round((hpCurrent / hpMax) * 100) : 0;

        if (isDead && isUndead) {
            lines.push("- You are undead. You exist beyond life and feel no pain or warmth.");
        } else if (isDead) {
            lines.push("- You are dead but magically compelled to speak. You feel nothing.");
        } else if (hpCurrent <= 0) {
            lines.push("- ⚠️ CRITICAL: You are bleeding out and on death's door. Every word is agony. You can barely speak. Your responses MUST reflect this — gasping, weak, desperate.");
        } else if (pct <= 10) {
            lines.push(`- ⚠️ CRITICAL: You are near death (${pct}% health, ${hpCurrent}/${hpMax} HP). You are in extreme pain, barely conscious. You MUST sound desperate, weak, and afraid. Short, labored sentences. You may beg, plead, or surrender.`);
        } else if (pct <= 25) {
            lines.push(`- ⚠️ WOUNDED: You are gravely wounded (${pct}% health, ${hpCurrent}/${hpMax} HP). You are bleeding heavily, in serious pain, and struggling to stay upright. Your voice shakes. You MUST reflect your injuries — strained words, wincing, holding wounds. You are NOT casual or composed.`);
        } else if (pct <= 50) {
            lines.push(`- WOUNDED: You are badly hurt (${pct}% health, ${hpCurrent}/${hpMax} HP). You are bleeding and in pain. Speak with strain and urgency. You are aware you could die.`);
        } else if (pct <= 75) {
            lines.push(`- You are lightly wounded (${pct}% health). You have taken some hits but are still strong.`);
        }

        if (isAnimal && hasSpeakWithAnimals) {
            lines.push(`- You are a ${creatureType}. You think like an animal: food, safety, smells.`);
        }

        const conditionDescriptions = {
            "frightened":    "You are FRIGHTENED — your voice trembles, you stammer and flinch. You want to flee. Every word betrays your terror.",
            "charmed":       "You are CHARMED — you feel warm and trusting toward the speaker. You want to help them and agree with them. You may reveal things you normally wouldn't.",
            "poisoned":      "You are POISONED — your thoughts are foggy, your stomach churns, you slur words. You may gag or retch mid-sentence. Speaking is an effort.",
            "stunned":       "You are STUNNED — you can barely form coherent words. You stare blankly, mumble fragments, and struggle to understand what's happening.",
            "paralyzed":     "You are PARALYZED — your body is locked rigid. You can only move your eyes and mouth. Words come out strained and breathless.",
            "prone":         "You are PRONE — you are on the ground looking up. You speak from below, maybe spitting dirt or blood. Getting up feels impossible right now.",
            "blinded":       "You are BLINDED — total darkness. You cannot see who speaks to you. You reach out blindly, turn your head toward sounds, and your voice carries fear of the unknown.",
            "deafened":      "You are DEAFENED — you cannot hear. You may shout without realizing it, misunderstand questions, or respond to what you think was said. You feel isolated.",
            "incapacitated": "You are INCAPACITATED — speaking requires immense effort. Words come out as weak groans or whispers. You cannot take actions.",
            "restrained":    "You are RESTRAINED — bound, webbed, or magically held in place. You struggle against your bonds as you speak. Your words carry frustration or desperation.",
            "grappled":      "You are GRAPPLED — someone or something holds you tight. You speak through gritted teeth while struggling to break free.",
            "petrified":     "You are partially PETRIFIED — your body is turning to stone. Words come out slow, grinding, as if your jaw is made of rock.",
            "exhaustion":    "You are EXHAUSTED — bone-deep weariness weighs on every word. You speak slowly, sigh often, and may trail off mid-sentence.",
            "invisible":     "You are invisible — others cannot see you, which may affect how you choose to reveal yourself.",
            "dead":          "You are dead.",
            "concentrating": "You are maintaining CONCENTRATION on a spell — you speak carefully, distracted, not wanting to lose focus. You may wince if interrupted.",
        };
        for (const cond of conditions) {
            if (conditionDescriptions[cond]) lines.push(`- ${conditionDescriptions[cond]}`);
            else lines.push(`- You are affected by: ${cond}. This visibly impacts your behavior and speech.`);
        }

        // Exhaustion levels (dnd5e)
        const exhaustion = actor?.system?.attributes?.exhaustion ?? 0;
        if (exhaustion >= 5) {
            lines.push("- ⚠️ You are at EXHAUSTION level 5 — you are on the verge of death. You can barely whisper. Every word might be your last.");
        } else if (exhaustion >= 3) {
            lines.push(`- You are at EXHAUSTION level ${exhaustion} — you are profoundly fatigued. Your speech is slow, slurred, and you may lose your train of thought.`);
        } else if (exhaustion >= 1) {
            lines.push(`- You are at EXHAUSTION level ${exhaustion} — you are tired and it shows in your voice. You speak with less energy than usual.`);
        }

        // Concentration check
        const concentrating = actor?.effects?.find(e =>
            e.statuses?.has("concentration") ||
            e.flags?.dnd5e?.statusId === "concentration" ||
            e.name?.toLowerCase()?.includes("concentrat")
        );
        if (concentrating) {
            lines.push(`- ${conditionDescriptions["concentrating"]}`);
        }

        return lines.join("\n") || "- You are healthy and fully alert.";
    }

    // ─── PLAYER STATE ───────────────────────────────────────────────────────
    static buildPlayerStateNote(conditions, isWounded, playerActor, hp, hpMax, intScore, wisScore, chaScore, race, cls, level, activeEffects) {
        if (!playerActor) return "- An unknown figure speaks to you.";
        const pct = hpMax > 0 ? Math.round((hp / hpMax) * 100) : 100;
        const lines = [];

        let identity = `- Their name is ${playerActor.name}`;
        if (race || cls) identity += ` (${[race, cls ? `${level > 0 ? "level "+level+" " : ""}${cls}` : ""].filter(Boolean).join(", ")})`;
        lines.push(identity + ".");

        if (hp <= 0) {
            lines.push("- They are unconscious and dying on the ground.");
        } else if (pct <= 10) {
            lines.push(`- They are critically wounded (${pct}% health). They look like they might die any moment.`);
        } else if (pct <= 25) {
            lines.push(`- They are gravely wounded (${pct}% health). Clearly struggling.`);
        } else if (pct <= 50) {
            lines.push(`- They are badly wounded (${pct}% health). Visibly bloodied.`);
        } else if (pct <= 75) {
            lines.push(`- They are lightly wounded (${pct}% health).`);
        }

        const conditionDescriptions = {
            "frightened":    "They are visibly FRIGHTENED — trembling, wide-eyed, looking around nervously. You can see their fear.",
            "charmed":       "They seem CHARMED — their eyes are glazed with unnatural warmth. They are unusually agreeable and compliant.",
            "poisoned":      "They look POISONED — their skin is pallid, they sway on their feet, and their words come out slurred and confused.",
            "stunned":       "They are STUNNED — staring blankly, mouth agape, barely able to string words together.",
            "paralyzed":     "They are PARALYZED — their body is locked rigid. Only their eyes and lips move. They look terrified.",
            "prone":         "They are on the GROUND — sprawled out, looking up at you. They may be crawling or struggling to rise.",
            "blinded":       "They are BLINDED — they cannot see you. They reach out blindly and turn their head toward your voice.",
            "deafened":      "They are DEAFENED — they cannot hear you well. They squint at your lips, lean in close, or shout without realizing it.",
            "incapacitated": "They are INCAPACITATED — barely conscious, groaning, unable to take any real action.",
            "restrained":    "They are RESTRAINED — bound, webbed, or magically held. They struggle against their bonds as they speak.",
            "grappled":      "They are being GRAPPLED — held tight by someone or something. They writhe and strain while trying to talk.",
            "petrified":     "They are partially PETRIFIED — parts of their body are turning to stone. Their movements are stiff and grinding.",
            "invisible":     "They are INVISIBLE to you — you can hear their voice but see nothing.",
            "dead":          "They are dead.",
            "exhaustion":    "They look deeply EXHAUSTED — dark circles under their eyes, shoulders slumped, voice thin and weary.",
        };
        for (const cond of conditions) {
            if (conditionDescriptions[cond]) lines.push(`- ${conditionDescriptions[cond]}`);
            else lines.push(`- They appear to be affected by: ${cond}.`);
        }

        if (activeEffects.length) {
            lines.push(`- They appear to be under magical effects: ${activeEffects.join(", ")}.`);
        }

        const intDesc = intScore <= 7 ? "dim-witted" : intScore >= 15 ? "highly intelligent" : "average intelligence";
        const wisDesc = wisScore <= 7 ? "naive or impulsive" : wisScore >= 15 ? "perceptive and wise" : "average perception";
        const chaDesc = chaScore <= 7 ? "awkward or unpleasant" : chaScore >= 15 ? "charismatic and compelling" : "unremarkable presence";
        lines.push(`- They strike you as ${intDesc}, ${wisDesc}, and have ${chaDesc}.`);

        // Player alignment — the NPC can perceive intent/vibe
        const playerAlignment = playerActor?.system?.details?.alignment || "";
        if (playerAlignment) {
            lines.push(`- Their demeanor suggests they are ${playerAlignment}.`);
        }

        // ── PC Backstory & Character Details ───────────────────────
        const pcAppearance = (playerActor?.system?.details?.appearance || "").trim();
        if (pcAppearance) {
            lines.push(`- Their appearance: ${pcAppearance}`);
        }
        const pcTrait = (playerActor?.system?.details?.trait || "").trim();
        if (pcTrait) {
            lines.push(`- They seem to be: ${pcTrait}`);
        }
        const pcBio = (playerActor?.system?.details?.biography?.value || "").replace(/<[^>]*>/g, "").trim();
        if (pcBio) {
            // Truncate to ~500 chars to keep prompt size reasonable
            const briefBio = pcBio.length > 500 ? pcBio.slice(0, 500) + "…" : pcBio;
            lines.push(`- What you can sense about their story: ${briefBio}`);
        }

        return lines.join("\n");
    }

    // ─── ACTIVE EFFECTS (non-condition) ─────────────────────────────────────
    static getActiveEffects(actor) {
        const conditionNames = new Set(["frightened","charmed","poisoned","exhaustion","prone",
            "unconscious","incapacitated","stunned","blinded","deafened","paralyzed",
            "invisible","dead","restrained","grappled","petrified"]);
        return actor.effects
            .filter(e => !e.disabled && !e.isSuppressed)
            .map(e => (e.label || e.name || "").toLowerCase())
            .filter(name => name && !conditionNames.has(name) && name.length > 2)
            .slice(0, 5);
    }

    // ─── SPEECH PROFILE ─────────────────────────────────────────────────────
    static buildSpeechProfile(intScore, wisScore, chaScore, creatureType = "") {
        const intStyle = intScore <= 5  ? "Barely verbal. 1-3 word utterances only. No complex thought."
                       : intScore <= 7  ? "Simple vocabulary, short sentences. Broken grammar."
                       : intScore <= 10 ? "Plain, direct speech. Short sentences, common words only."
                       : intScore <= 14 ? "Average vocabulary. Comfortable with language."
                       : "Eloquent, precise, analytical.";
        const wisStyle = wisScore <= 7  ? "Impulsive, emotional."
                       : wisScore >= 15 ? "Calm, insightful, perceptive."
                       : "Average common sense.";
        const chaStyle = chaScore >= 15 ? "Magnetic and charming."
                       : chaScore <= 7  ? "Blunt or awkward."
                       : "Average presence.";

        let profile = `INT ${intScore}: ${intStyle}\nWIS ${wisScore}: ${wisStyle}\nCHA ${chaScore}: ${chaStyle}`;

        // Creature type speech modifiers — non-humanoids speak differently
        // even at the same INT as a human
        const type = creatureType.toLowerCase();
        if (type.includes("monstrosity") || type.includes("beast")) {
            profile += "\nCREATURE NOTE: This is a monster, not a scholar. Speech is primal and blunt — short declarations, threats, demands. No flowery language, no philosophy. Think caveman with fangs.";
        } else if (type.includes("undead")) {
            profile += "\nCREATURE NOTE: Speech is hollow and haunting. Monotone delivery, fixated on death, hunger, or old memories. No warmth.";
        } else if (type.includes("giant")) {
            profile += "\nCREATURE NOTE: Giants favor loud, simple declarations. Boastful and direct. Not subtle.";
        } else if (type.includes("fiend")) {
            profile += "\nCREATURE NOTE: Fiends are cunning and manipulative but their speech drips with menace. Cruel wordplay, veiled threats.";
        } else if (type.includes("aberration")) {
            profile += "\nCREATURE NOTE: Alien thought patterns. Speech is unsettling and disjointed, as if translating from an inhuman mind.";
        } else if (type.includes("construct")) {
            profile += "\nCREATURE NOTE: Mechanical and literal. No emotion, no humor. Follows instructions.";
        } else if (type.includes("elemental")) {
            profile += "\nCREATURE NOTE: Speaks in elemental metaphors — flame, storm, earth, tide. Alien perspective, not human.";
        }

        return profile;
    }

    // ─── CONDITIONS ─────────────────────────────────────────────────────────
    static getConditions(actor) {
        if (!actor?.effects) return [];
        const known = ["frightened","charmed","poisoned","exhaustion","prone","unconscious",
                       "incapacitated","stunned","blinded","deafened","paralyzed","invisible","dead",
                       "restrained","grappled","petrified"];
        return actor.effects
            .filter(e => !e.disabled && !e.isSuppressed)
            .map(e => (e.label || e.name || "").toLowerCase())
            .filter(name => known.includes(name));
    }

    static hasCondition(actor, conditions) {
        const active = this.getConditions(actor);
        return conditions.some(c => active.includes(c));
    }

    // ─── JOURNAL LORE ───────────────────────────────────────────────────────
    static getJournalLore(actor) {
        try {
            const name    = `[AI Memory] ${actor.name}`;
            const journal = game.journal.find(j => j.name === name);
            if (!journal) return "";
            const summaryPage = journal.pages.find(p => p.name === "Chronicle")
                             ?? journal.pages.find(p => p.name === "Memory Summary")
                             ?? journal.pages.contents[0];
            const text = (summaryPage?.text?.content || "").replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim();
            if (!text || text.includes("No sessions recorded yet")) return "";
            return text;
        } catch(e) { console.warn("ACE: Engine | conversation-engine.mjs getJournalLore failed:", e); return ""; }
    }

    // ─── DEAD RESPONSE ──────────────────────────────────────────────────────
    static getDeadResponse(actor) {
        const responses = [
            `${actor.name} does not respond. They are dead.`,
            `The body of ${actor.name} lies still. No words come.`,
            `${actor.name} is beyond conversation. Only silence answers you.`,
            `The dead do not speak without magic to compel them.`
        ];
        return responses[Math.floor(Math.random() * responses.length)];
    }
}
