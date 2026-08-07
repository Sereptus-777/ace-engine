// ─── ACE: Engine — Auto-Biography Generator ─────────────────────────────────
// Generates AI backstories when NPC tokens are dropped onto a scene.
// Linked tokens → bio stored on actor sheet (shared identity).
// Unlinked tokens → bio stored on token ActorDelta (unique per instance).
//
// Moved from ace-envoy/src/ai/bio-generator.js as part of the
// Envoy → Engine merger.

import { AIHandler }                                             from "./conversation-engine.mjs";
import { isAIFailure }                                           from "./ai-failure.mjs";
import { writeBiography }                                        from "../bio-writer.mjs";
import { processTokenFaction, buildFactionBioContext,
         resolveCreatureBase }                                   from "./faction-registry.mjs";
import { SocialProfileEngine }                                   from "./social-profile.mjs";
import npcProfileJournal                                         from "./npc-profile-journal.mjs";
import { resolveSpecies, hasPersonalName, setGenericNameProbe } from "./npc-identity.mjs";

const MODULE_ID = "ace-engine";
const QOL_ID    = "ace-qol";
const TAG       = "ACE: Engine | Bio";

// ─── Flavor-name nameplate (display-only) ────────────────────────────────────
// The bio generator stores its generated "flavor" name in the actor flag
// `flavorName` and NEVER overwrites the real name (mechanics read the real name as
// identity). This hook paints the flavor name onto the token nameplate so players
// still see the immersive name, while the sheet + mechanics keep the canonical one.
// Display-only and fully defensive — if anything is off, the real nameplate stands.
function _paintFlavorNameplate(token) {
    try {
        const doc = token?.document;
        let flavor;
        if (doc?.actorLink) {
            // LINKED token: the actor IS the shared identity, so its flag is correct
            // (all linked copies are the same named NPC — intended).
            flavor = token.actor?.getFlag?.(MODULE_ID, "flavorName");
        } else {
            // UNLINKED token: use ONLY this token's OWN delta flag — NEVER the base
            // actor's. Every unlinked sibling of the same base actor inherits the
            // base flag through token.actor.getFlag, so a generic ogre would wrongly
            // borrow a NAMED ogre's flavor name off the shared "Ogre" actor. Reading
            // the delta's own source flags isolates each token. (Root-caused +
            // fixed 2026-07-26 — the "both ogres became Grulgar Stonearm" bug.)
            flavor = doc?.delta?._source?.flags?.[MODULE_ID]?.flavorName;
        }
        if (flavor && token.nameplate && typeof token.nameplate.text === "string" && token.nameplate.text !== flavor) {
            token.nameplate.text = flavor;
        }
    } catch (_) { /* never let display break a token refresh */ }
}
Hooks.on("refreshToken", _paintFlavorNameplate);
Hooks.on("drawToken",    _paintFlavorNameplate);

// ─── Stuck bioInFlight flag recovery ──────────────────────────────────────
// Vulnerability identified by Gemini code review (2026-05-31):
//
// `bioInFlight` is stored on the actor (Foundry DB) and cleared in a
// `try/finally`. The finally block handles standard JS errors + API
// timeouts perfectly. BUT — if the JS execution environment is
// destroyed mid-generation (F5 refresh, browser crash, power outage,
// OS kill), the `finally` never fires. The DB write of bioInFlight=true
// persists. ace-token-art's chooser then sees the flag, waits, fails.
//
// Two-layer recovery (Gemini's "mid-session staleness" follow-up):
//
//   Layer 1 (world ready): clear all stuck bioInFlight flags on load.
//     Recovers from full-session crashes (browser closed, world reload).
//
//   Layer 2 (mid-session staleness check): `bioInFlightSince` companion
//     timestamp flag is set alongside bioInFlight. Read sites (token-art
//     chooser etc.) treat the flag as stale if the timestamp is older
//     than 5 minutes. A bio generation that legitimately takes > 5 min
//     is broken anyway and shouldn't block other actors.
//
// GM-only — only the GM has permission to update actor flags world-wide.
const BIO_INFLIGHT_STALE_MS = 5 * 60 * 1000;  // 5 minutes

Hooks.once("ready", async () => {
    if (!game.user.isGM) return;
    try {
        const stuck = game.actors?.filter?.(a => a.getFlag?.(MODULE_ID, "bioInFlight")) ?? [];
        if (!stuck.length) return;
        await Promise.all(stuck.map(actor =>
            actor.update?.({
                [`flags.${MODULE_ID}.bioInFlight`]: false,
                [`flags.${MODULE_ID}.-=bioInFlightSince`]: null,
            }).catch(_ => { /* per-actor failure shouldn't block the sweep */ })
        ));
        console.log(`${TAG} | Cleared ${stuck.length} stuck bioInFlight flag(s) on world load (recovery from crashed prior session).`);
    } catch (err) {
        console.warn(`${TAG} | bioInFlight sweep failed:`, err);
    }
});

/**
 * Check whether an actor's bioInFlight flag is "live" (currently generating)
 * vs "stuck" (mid-session staleness from an aborted prior generation).
 *
 * Returns true if the bio is genuinely in-flight RIGHT NOW (chooser should
 * wait). Returns false if either (a) no flag set, OR (b) flag is set but
 * the timestamp is older than the staleness window (treat as stale and
 * proceed without waiting).
 *
 * Used by ace-token-art's chooser via the engine API
 * (game.aceEngine.isBioInFlight) so the cross-module signal stays consistent
 * with our internal queue state.
 *
 * @param {Actor} actor
 * @returns {boolean} true if a live generation is in-flight for this actor
 */
export function isBioInFlight(actor, tokenDoc = null) {
    if (!actor) return false;
    // ── Synchronous in-memory check FIRST (closes the queue-vs-flag race). ──
    // _inFlightTokenIds is updated synchronously at addToBioQueue entry,
    // BEFORE the async setFlag. Token-art's createToken hook may fire
    // between queue and setFlag-commit — this sync set catches that window.
    if (tokenDoc?.id && _inFlightTokenIds.has(tokenDoc.id)) return true;
    // Also scan for any active token of this actor (covers callers who only
    // pass the actor, not the specific tokenDoc).
    try {
        for (const t of actor.getActiveTokens?.() ?? []) {
            if (_inFlightTokenIds.has(t.document?.id ?? t.id)) return true;
        }
    } catch (_) { /* non-fatal */ }

    const inFlight = actor.getFlag?.(MODULE_ID, "bioInFlight");
    if (!inFlight) return false;
    const since = actor.getFlag?.(MODULE_ID, "bioInFlightSince");
    if (!since) return true;  // legacy: no timestamp → trust the boolean
    const age = Date.now() - Number(since);
    if (age > BIO_INFLIGHT_STALE_MS) {
        // Stale flag — opportunistic cleanup if we have permission
        if (game.user?.isGM) {
            try {
                actor.setFlag(MODULE_ID, "bioInFlight", false);
                actor.unsetFlag?.(MODULE_ID, "bioInFlightSince");
                console.log(`${TAG} | Cleared stale bioInFlight on ${actor.name} (age ${Math.round(age / 1000)}s — was orphaned mid-session).`);
            } catch (_) { /* non-fatal */ }
        }
        return false;
    }
    return true;
}

/** Read engine's AI config (replaces envoy's getEnvoyAIConfig). */
function getEnvoyAIConfig() {
    try {
        return {
            provider: game.settings.get(MODULE_ID, "aiProvider") || "ollama",
            apiKey:   game.settings.get(MODULE_ID, "apiKey")     || "",
            apiUrl:   game.settings.get(MODULE_ID, "apiUrl")     || "",
            modelName: game.settings.get(MODULE_ID, "modelName") || "",
        };
    } catch (_) {
        return { provider: "ollama", apiKey: "", apiUrl: "", modelName: "" };
    }
}

/** Drop-in stand-in for the Envoy → Engine bridge (we ARE the engine). */
const EngineBridge = {
    isEngineActive:             () => true,
    digestLookupContext:        (...args) => game.modules.get(MODULE_ID)?.api?.digestLookupContext?.(...args)        ?? "",
    getDocumentContext:         (...args) => game.modules.get(MODULE_ID)?.api?.getDocumentContext?.(...args)         ?? Promise.resolve(""),
    getSceneIntelligencePrompt: (...args) => game.modules.get(MODULE_ID)?.api?.getSceneIntelligencePrompt?.(...args) ?? Promise.resolve(""),
    getWorldBibleCityContext:   (...args) => game.modules.get(MODULE_ID)?.api?.getWorldBibleCityContext?.(...args)   ?? "",
    searchWorldBible:           (...args) => game.modules.get(MODULE_ID)?.api?.searchWorldBible?.(...args)           ?? "",
    resolveWorldBibleLocation:  (...args) => game.modules.get(MODULE_ID)?.api?.resolveWorldBibleLocation?.(...args)  ?? Promise.resolve(""),
    getNpcRecord:               (...args) => game.modules.get(MODULE_ID)?.api?.getNpcRecord?.(...args)               ?? null,
};

/** ACE: QOL integration — loot generation on bio creation. Inlined from
 *  envoy's qol-bridge.js so engine doesn't depend on envoy at runtime. */
function shouldGenerateLoot(cr) {
    if (!game.modules.get(QOL_ID)?.active) return false;
    try {
        const enabled = game.settings.get(QOL_ID, "enableLootGeneration");
        const onBio   = game.settings.get(QOL_ID, "lootOnBio");
        if (!enabled || !onBio) return false;
        const minCR = game.settings.get(QOL_ID, "minCRForLoot") ?? 0;
        return cr >= minCR;
    } catch (_) { return false; }
}

async function generateLoot(tokenDoc, options = {}) {
    try { return game.aceQol?.lootEngine?.generateLoot?.(tokenDoc, options); }
    catch (_) { return null; }
}

/** Combined-loot hard cap (ace-qol `maxTotalLoot` setting, default 3). Option C, 2026-07-14. */
function _lootMaxTotal() {
    try { return Number(game.settings.get(QOL_ID, "maxTotalLoot")) || 3; }
    catch (_) { return 3; }
}

/**
 * AI pocket-loot THEN compendium loot, sharing ONE item budget so the two don't
 * pile up (Johnny 2026-07-14: "goblins ~4 items" → chose Option C: a little
 * flavor + the occasional real item, capped). We count what the AI flavor-loot
 * added by diffing the actor's item count around it — `_generateItemBios` runs
 * before this and adds none — then hand the remainder to the compendium engine.
 */
async function _lootThenRealLoot(tokenDocument) {
    const actor = tokenDocument?.actor;
    if (!actor) return;
    const cr   = actor.system?.details?.cr ?? 0;
    const tier = _getLootTier(cr);

    // Fix #1 (2026-07-14): ONE shared "does this creature carry anything?" roll
    // gates BOTH systems together — a mook usually has NOTHING (35%), a boss
    // always does (100%). Previously the graduated chance only gated the flavor
    // side while the compendium fired every time, so every goblin had real loot;
    // this matches Johnny's "a random goblin usually has nothing worth taking."
    if (Math.random() > (LOOT_CHANCE[tier] ?? 1)) {
        try {
            const t = tokenDocument.actorLink ? actor : tokenDocument;
            await t.setFlag?.(MODULE_ID, "lootGenerated", true);
        } catch (_) { /* non-fatal */ }
        return;
    }

    const cap = _lootMaxTotal();
    if (tier === "high" || tier === "elite") {
        // Fix #2: high-value creatures lead with their REAL compendium magic so
        // the rare/legendary drop isn't crowded out by flavor trinkets. Flavor
        // then fills whatever budget is left (0-1 item on a full boss).
        const before = actor.items?.size ?? 0;
        await _generateRealLoot(tokenDocument, 0);          // real first, capped to `cap`
        const realCount = Math.max(0, (actor.items?.size ?? 0) - before);
        await _generateLoot(tokenDocument, { forceLoot: true, maxItems: Math.max(0, cap - realCount) });
    } else {
        // Mooks lead with flavor (the in-character pocket junk IS the point);
        // the compendium tops up whatever budget the flavor left.
        const before = actor.items?.size ?? 0;
        await _generateLoot(tokenDocument, { forceLoot: true });
        const aiCount = Math.max(0, (actor.items?.size ?? 0) - before);
        await _generateRealLoot(tokenDocument, aiCount);
    }
}

// ─── GENERATION QUEUE ─────────────────────────────────────────────────────────
// Sequential processing prevents 10 simultaneous AI calls when dropping 10 goblins.
// Hard cap prevents runaway API costs when dropping large groups of tokens at once.
const _queue = [];
const MAX_QUEUE_SIZE = 25;
let _processing = false;
const _pendingActorIds = new Set();  // Dedup linked actors in queue/in-flight

/**
 * SYNCHRONOUS in-memory tracker of token IDs whose bio is in-flight.
 * Updated synchronously at addToBioQueue() entry and cleared in the queue's
 * `finally` block. Closes the race window between addToBioQueue's async
 * setFlag commit and ace-token-art's createToken hook reading the actor flag.
 * Covers BOTH linked and unlinked tokens (unlike _pendingActorIds, which only
 * dedups linked actors). Exported via game.aceEngine API for cross-module use.
 * (Audit-mandated 2026-06-08 — Grok pre-launch audit, Critical #4.)
 */
const _inFlightTokenIds = new Set();

/**
 * Run item flavor + loot generation only — bypasses the bio paragraph and
 * faction popup. Used when the master "Always Check Items & Loot on Token
 * Drop" setting is ON but bio generation is disabled (autoGenerateBio off,
 * or the per-drop dialog picked "Faction Only" / similar).
 *
 * Existing creature-type rules in the loot pipeline still apply — beasts /
 * oozes / plants / mindless creatures are filtered out as usual.
 *
 * @param {TokenDocument} tokenDocument
 */
export async function runItemAndLootOnly(tokenDocument) {
    if (!tokenDocument?.actor) return;
    try {
        await _generateItemBios(tokenDocument);
        await _lootThenRealLoot(tokenDocument);
        _playShimmer(tokenDocument);
    } catch (err) {
        console.warn(`${TAG} | Items + loot only generation failed for ${tokenDocument.actor.name}:`, err);
    }
}

/**
 * v0.7.21 Two-Part Bio System — Scene-context journal pipeline.
 *
 * Runs when a linked NPC with an existing sheet bio is dropped on a scene.
 * Sheet bio is SACRED — never touched here. Instead:
 *   1. Ensure the NPC's profile journal exists (idempotent)
 *   2. Check the date-gap rule (same scene + same day = reuse)
 *   3. If a fresh entry is warranted, run a SHORT AI prompt (5-10 lines,
 *      "why is this NPC here on this scene RIGHT NOW")
 *   4. Append the dated entry to the journal's Scenes section
 *
 * Fire-and-forget — never blocks token drop. All errors caught + logged.
 */
async function _maybeGenerateSceneContext(tokenDocument) {
    const actor = tokenDocument?.actor;
    const scene = tokenDocument?.parent;
    if (!actor || !scene?.id) return;

    // Ensure profile exists (creates record + anchors UUID if first time).
    npcProfileJournal.ensureProfile(actor, tokenDocument);

    // Date-gap rule — skip if the most-recent entry for (actor, scene) is
    // from the same calendar day, OR within the sceneContextMinDays window.
    if (!npcProfileJournal.shouldGenerateForScene(actor, scene.id)) {
        const latest = npcProfileJournal.getLatestSceneAppearance(actor, scene.id);
        if (latest) {
            console.log(`${TAG} | Scene-context for ${actor.name} on "${scene.name}" — reusing existing entry from ${new Date(latest.t * 1000).toLocaleDateString()}.`);
        }
        return;
    }

    console.log(`${TAG} | Scene-context for ${actor.name} on "${scene.name}" — generating fresh entry.`);

    try {
        const { provider, apiKey } = getEnvoyAIConfig();
        if (!provider) {
            console.warn(`${TAG} | Scene-context skipped — no AI provider configured.`);
            return;
        }

        // Pull the core bio from the sheet so the AI knows who this NPC is.
        const coreBio = String(actor.system?.details?.biography?.value ?? "")
            .replace(/<[^>]+>/g, " ")     // strip HTML for a clean plaintext feed
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 2000);              // cap context — we only need the gist

        // Look up the NPC's prior appearances on OTHER scenes so the AI can
        // weave in continuity ("Aldric returns from Vallaki...").
        const rec = npcProfileJournal.ensureProfile(actor);
        const recentAppearances = (rec?.sceneAppearances ?? [])
            .filter(a => a.sceneId !== scene.id)
            .slice(-3)                    // last 3 OTHER appearances
            .map(a => `On ${new Date(a.t * 1000).toLocaleDateString()} in "${a.sceneName}": ${a.contextText}`)
            .join("\n");

        const systemPrompt = `You are a Dungeon Master's narrative assistant. Write a SHORT scene-context paragraph — 5 to 10 lines, NO MORE — explaining why a specific NPC has appeared on a specific scene RIGHT NOW. Voice: evocative but grounded. No headings, no lists, no labels. Just prose. Treat the NPC's core biography (provided below) as immutable canon — do not contradict it. If prior appearances on other scenes are provided, weave in continuity where natural. The reader is the GM, who will use this as a single-paragraph reminder of why this NPC is here on this date.`;

        const userMsg = `NPC: ${actor.name}
Scene: ${scene.name}
Current real-world date: ${new Date().toLocaleDateString()}

Core biography (immutable canon — respect it):
${coreBio || "(no prior bio recorded — improvise minimally)"}

${recentAppearances ? `Recent appearances on other scenes:\n${recentAppearances}\n` : ""}
Write the 5-10 line scene-context paragraph now. Just the paragraph — no preamble, no title.`;

        const response = await AIHandler.callAI(systemPrompt, [], userMsg, provider, apiKey, [], { context: "scene-notes" });
        if (isAIFailure(response)) return;   // GM already notified — never persist a failure marker
        const text = String(response ?? "").trim();
        if (!text) {
            console.warn(`${TAG} | Scene-context generator returned empty for ${actor.name}.`);
            return;
        }

        // Persist + sync journal page.
        await npcProfileJournal.addSceneAppearance(actor, scene, text);
        console.log(`${TAG} | Scene-context written for ${actor.name} on "${scene.name}" (${text.length} chars).`);
    } catch (err) {
        console.warn(`${TAG} | Scene-context generation failed for ${actor?.name ?? "?"} (non-fatal):`, err);
    }
}

/**
 * Queue a token for biography generation.
 * Called from the createToken hook in main.js.
 * @param {TokenDocument} tokenDocument
 */
export async function queueBioGeneration(tokenDocument) {
    const actor = tokenDocument.actor;
    if (!actor) return;

    // ── Guard: already generated? ─────────────────────────────────────────
    // ── Guard: already has a real bio? ─────────────────────────────────────
    // Check the ACTUAL bio content first — if our ace-engine-bio section exists,
    // skip. If the flag is set but the bio is just a stub/boilerplate (no
    // ace-engine-bio section), allow re-generation so stat-block inference can run.
    const existingBio = actor.system?.details?.biography?.value || "";
    const hasOurBio = existingBio.includes('class="ace-engine-bio"');

    if (tokenDocument.actorLink) {
        // ── v0.7.21 Two-Part Bio System (Steps 1-3 wired) ──
        // Linked NPC with existing ACE bio → SHEET stays static. Branch into
        // the scene-context journal pipeline instead. Date-gap rule decides
        // whether to spend an API call on a fresh "why is he here NOW" entry.
        // (Design source: session_april1_2026.md "Two-Part Bio System".)
        if (hasOurBio) {
            console.log(`${TAG} | ${actor.name} — ACE bio core already on sheet; routing to scene-context journal pipeline.`);
            // Fire-and-forget scene-context generation (non-blocking — items
            // and loot continue in parallel, just like before).
            _maybeGenerateSceneContext(tokenDocument).catch(err => {
                console.warn(`${TAG} | scene-context journal pipeline threw (non-fatal):`, err);
            });
            _generateItemBios(tokenDocument).then(() => _generateLoot(tokenDocument)).catch(() => {});
            return;
        }

        // NOTE: Linked actors with existing non-ACE bios (e.g. from adventure modules
        // or compendium MM text like Aldric Thorne's stat-block flavor) are NOT skipped —
        // they proceed through ONE-TIME generation that incorporates the canon text.
        // After that, the sheet bio is permanent. Scene-context lives in the journal.
        // See _buildPrompt() canonBio parameter.
    } else {
        // Unlinked token → same logic: only skip if our bio section exists
        if (hasOurBio) {
            console.log(`${TAG} | Skipping token ${tokenDocument.id} — ACE bio already exists.`);
            _generateItemBios(tokenDocument).then(() => _generateLoot(tokenDocument)).catch(() => {});
            return;
        }
    }

    // Dedup: skip linked tokens whose actor is already queued or in-flight
    if (tokenDocument.actorLink && _pendingActorIds.has(actor.id)) {
        console.log(`${TAG} | ${actor.name} already queued for bio generation, skipping duplicate.`);
        return;
    }
    if (tokenDocument.actorLink) _pendingActorIds.add(actor.id);

    if (_queue.length >= MAX_QUEUE_SIZE) {
        console.warn(`${TAG} | Bio queue full (${MAX_QUEUE_SIZE}). Skipping ${actor.name} — drop fewer tokens at once.`);
        ui.notifications?.warn(`Envoy: Bio generation queue full (${MAX_QUEUE_SIZE} max). Some tokens were skipped.`);
        return;
    }

    // ── SYNCHRONOUS in-memory in-flight mark (closes race window) ──
    // Set BEFORE the async setFlag so isBioInFlight() returns true
    // immediately, before any other createToken hook listener runs its
    // check. Companion `ace-engine.bioQueued` hook fires synchronously so
    // listeners can react in the same tick. (Audit-mandated 2026-06-08.)
    _inFlightTokenIds.add(tokenDocument.id);
    try {
        Hooks.callAll("ace-engine.bioQueued", {
            tokenDoc: tokenDocument,
            actor: tokenDocument.actor ?? null,
        });
    } catch (hookErr) {
        console.warn(`${TAG} | bioQueued hook callAll failed (non-fatal):`, hookErr);
    }

    // Mark bio in-flight at QUEUE time (the DB-backed flag — survives crashes).
    // The sync _inFlightTokenIds add above covers the race window before the
    // setFlag commit propagates. Companion `bioInFlightSince` timestamp enables
    // mid-session staleness recovery — see isBioInFlight() above.
    try {
        await tokenDocument.actor?.update?.({
            [`flags.${MODULE_ID}.bioInFlight`]: true,
            [`flags.${MODULE_ID}.bioInFlightSince`]: Date.now(),
        });
    } catch (_) { /* non-fatal — flag is advisory */ }

    _queue.push(tokenDocument);
    _processQueue();
}

async function _processQueue() {
    if (_processing || _queue.length === 0) return;
    _processing = true;

    try {
        // Load compendium creature names on first use (cached after that)
        await _loadCompendiumNames();

        while (_queue.length > 0) {
            const tokenDoc = _queue.shift();
            let error = null;
            // ── bioInFlight already set at QUEUE time (in addToBioQueue) ──
            // Previous code re-set it here too — redundant DB write (and DB
            // writes sync to all clients, so each one costs network traffic).
            // The flag was set when this token entered the queue and survives
            // until the `finally` block below clears it.

            try {
                await _generateBio(tokenDoc);
            } catch (err) {
                error = err;
                console.error(`${TAG} | Generation failed for ${tokenDoc.actor?.name}:`, err);
            } finally {
                // Clear sync in-memory tracker FIRST so any concurrent
                // isBioInFlight() check sees the cleared state immediately.
                // Cleared only AFTER bioGenerated has been written (in the
                // bio path below), preserving the "in-flight until bio set"
                // invariant Grok's audit called out.
                _inFlightTokenIds.delete(tokenDoc.id);
                // Clear in-flight flag + companion timestamp — match scope of the set above
                try {
                    await tokenDoc.actor?.setFlag?.(MODULE_ID, "bioInFlight", false);
                    await tokenDoc.actor?.unsetFlag?.(MODULE_ID, "bioInFlightSince");
                } catch (_) { /* non-fatal */ }
                // Clear dedup tracking for linked actors
                if (tokenDoc.actorLink && tokenDoc.actor) _pendingActorIds.delete(tokenDoc.actor.id);
                // Fire completion hook so listeners (ace-token-art chooser,
                // future plugins, etc.) know the pipeline is done with this
                // token — success OR failure. This always fires exactly once
                // per queued token. Token Art uses this to delay its chooser
                // until bio + faction picker have produced a final name and
                // role flag.
                try {
                    Hooks.callAll("ace-engine.bioComplete", {
                        tokenDoc,
                        actor: tokenDoc.actor ?? null,
                        renamed: !!tokenDoc.actor?.getFlag?.(MODULE_ID, "nameRevealed"),
                        role: tokenDoc.actor?.getFlag?.(MODULE_ID, "factionRole") ?? null,
                        error: error ? String(error.message ?? error) : null,
                    });
                } catch (hookErr) {
                    console.warn(`${TAG} | bioComplete hook callAll failed (non-fatal):`, hookErr);
                }
            }
        }
    } finally {
        _processing = false;
    }
}

// ─── BOILERPLATE DETECTION ────────────────────────────────────────────────────
// Detects OGL/SRD disclaimers, empty HTML, and generic stat-line bios.

const BOILERPLATE_PATTERNS = [
    /open\s*game\s*license/i,
    /wizards\s*of\s*the\s*coast/i,
    /system\s*reference\s*document/i,
    /copyright\s*\d{4}/i,
    /licensed\s*under/i,
    /creative\s*commons/i,
    /\bOGL\b/,
    /\bSRD\b/,
    /permission.*reproduce/i,
    /^(tiny|small|medium|large|huge|gargantuan)\s+(aberration|beast|celestial|construct|dragon|elemental|fey|fiend|giant|humanoid|monstrosity|ooze|plant|undead)/i,
];

// Detects bios that are just "See X for details" references with no real content.
const STUB_REFERENCE_PATTERNS = [
    /\bsee\s+.{3,60}\bfor\s+(details|more|info|description|encounter|personality|tactics)/i,
    /\brefer\s+to\b/i,
    /\bconsult\b.{0,30}\b(module|book|chapter|appendix|supplement)\b/i,
    /\bdetails\s+(can\s+be|are)\s+found\s+in\b/i,
    /\bdescribed\s+in\b/i,
];

/**
 * Detects whether a biography string is a real, authored bio vs boilerplate/empty.
 * @param {string} bioHtml — raw HTML biography value
 * @returns {boolean} — true if the bio appears to be real content
 */
export function isRealBiography(bioHtml) {
    if (!bioHtml) return false;

    // Strip HTML tags → plain text
    const plain = bioHtml.replace(/<[^>]*>/g, "").trim();

    // Too short to be meaningful
    if (plain.length < 20) return false;

    // Check against boilerplate patterns
    for (const re of BOILERPLATE_PATTERNS) {
        if (re.test(plain)) return false;
    }

    // Check for stub references ("See X for details") — not a real bio.
    // If the bio contains a reference pattern, strip the reference and check
    // whether the remaining content is substantial enough to count as a real bio.
    // Threshold: 150 chars — a single flavor sentence doesn't count.
    for (const re of STUB_REFERENCE_PATTERNS) {
        if (re.test(plain)) {
            const stripped = plain
                .replace(/see\s+.{3,80}for\s+\w+[.\s]*/gi, "")
                .replace(/refer\s+to\b.{3,80}/gi, "")
                .replace(/consult\b.{3,80}/gi, "")
                .replace(/details\s+(can\s+be|are)\s+found\s+in\b.{3,80}/gi, "")
                .replace(/described\s+in\b.{3,80}/gi, "")
                .replace(/[\s.,:;!?\-—–]+/g, " ").trim();
            if (stripped.length < 150) return false;
        }
    }

    return true;
}

// ─── GENERIC NAME DETECTION ──────────────────────────────────────────────────
// Determines whether a token name is a generic creature label (should be renamed)
// vs a proper NPC name (should be kept). Only generic names trigger the AI rename.
//
// Two-layer approach:
//   1) Compendium index — loaded once from Foundry's installed monster packs at runtime.
//      This catches every creature the user actually has installed (SRD, Monster Manual, etc.)
//   2) Fallback word lists — roles, modifiers, and common creatures for when the
//      compendium hasn't loaded yet or if a creature isn't in any installed pack.
//
// A multi-word name like "Hobgoblin Devastator" is checked as a whole string against
// the compendium index first, then split into words where each word is checked against
// the fallback lists. ALL words must be generic for the name to be considered generic.

/** Compendium creature names — populated once from Foundry's monster packs. */
let _compendiumNames = null;   // Set<string> (lowercase), null = not loaded yet

/**
 * Load creature names from all installed NPC/monster compendium packs.
 * Called lazily on first use, then cached forever.
 */
async function _loadCompendiumNames() {
    if (_compendiumNames) return;
    _compendiumNames = new Set();
    try {
        const actorPacks = (game.packs ?? []).filter(p => p.documentName === "Actor");
        const indices = await Promise.all(actorPacks.map(p => p.getIndex()));
        for (const index of indices) {
            for (const entry of index) {
                if (entry.name) _compendiumNames.add(entry.name.trim().toLowerCase());
            }
        }
        console.log(`${TAG} | Loaded ${_compendiumNames.size} creature names from compendium packs.`);
    } catch (err) {
        console.warn(`${TAG} | Failed to load compendium names:`, err);
    }
}

/** Generic role/class/occupation words — things that describe WHAT an NPC is, not WHO. */
const GENERIC_ROLE_NAMES = new Set([
    "guard", "bandit", "thug", "scout", "spy", "cultist", "acolyte", "priest",
    "knight", "soldier", "warrior", "archer", "mage", "apprentice", "commoner",
    "noble", "assassin", "berserker", "captain", "veteran", "gladiator",
    "druid", "merchant", "trader", "innkeeper", "barmaid", "barkeep",
    "servant", "slave", "peasant", "villager", "townsfolk", "pirate",
    "smuggler", "brigand", "marauder", "raider", "warlord", "chieftain",
    "shaman", "witch", "necromancer", "warlock", "sorcerer", "wizard",
    "cleric", "paladin", "ranger", "rogue", "fighter", "monk", "bard",
    "devastator", "champion", "boss", "warchief", "warpriest", "fanatic",
    "bodyguard", "tracker", "hunter", "sniper", "brute", "caster",
    "minion", "overseer", "taskmaster", "torturer", "jailer", "warden",
    "herald", "envoy", "emissary", "diplomat", "advisor", "sage",
    "chief", "elder", "matron", "patriarch", "leader", "commander",
    "lieutenant", "sergeant", "corporal", "recruit", "conscript",
    "zealot", "inquisitor", "templar", "crusader", "avenger",
    "herbalist", "alchemist", "smith", "blacksmith", "armorer",
    "cook", "stablehand", "ferryman", "beggar", "urchin", "hermit",
    "pitfighter", "brawler", "enforcer", "lookout",
]);

/** Modifiers/adjectives used in creature names — "Young Green Dragon", "Iron Shadow". */
const GENERIC_MODIFIERS = new Set([
    "young", "old", "elder", "ancient", "adult", "greater", "lesser",
    "red", "blue", "green", "black", "white", "gold", "silver", "bronze",
    "brass", "copper", "gray", "grey", "brown", "dark", "pale", "shadow",
    "iron", "steel", "stone", "bone", "fire", "ice", "frost", "flame",
    "storm", "thunder", "lightning", "war", "death", "blood", "dire",
    "swamp", "sea", "deep", "cave", "hill", "mountain", "forest", "desert",
    "flying", "animated", "cursed", "corrupted", "feral", "rabid", "spectral",
    "skeletal", "vampiric", "demonic", "infernal", "celestial", "abyssal",
    "mind", "the", "of", "a", "an",

    // Regional/cultural adjectives — "Barovian Commoner", "Calishite Merchant", etc.
    "barovian", "calishite", "chultan", "amnian", "cormyrean", "cormyrian",
    "thayan", "zhentarim", "waterdhavian", "baldurean", "luskan", "neverwinter",
    "dalelands", "rashemi", "halruaan", "tethyrian", "illuskan", "turami",
    "mulan", "shou", "damaran", "vaasan", "sembian", "aglarondian",
    "vistani", "drow", "underdark", "feywild", "shadowfell",
    "northern", "southern", "eastern", "western", "coastal", "highland",
    "lowland", "tribal", "nomadic", "frostmaiden", "icewind",
    "sword", "coast", "high", "low", "wild", "common", "local", "native",
    "forgotten", "realms",

    // Gender / age labels — "Barovian Male", "Female Guard", "Old Woman", etc.
    "male", "female", "man", "woman", "boy", "girl", "child", "baby",
    "gentleman", "lady", "lad", "lass", "maiden", "crone", "youth",
]);

/** Check if a single word (lowercase) is a known generic word from the fallback lists. */
function _isGenericWord(word) {
    if (GENERIC_ROLE_NAMES.has(word)) return true;
    if (GENERIC_MODIFIERS.has(word)) return true;
    // Try without trailing 's' for plurals: "guards" → "guard"
    if (word.endsWith("s") && word.length > 3) {
        const singular = word.slice(0, -1);
        if (GENERIC_ROLE_NAMES.has(singular)) return true;
    }
    return false;
}

/**
 * Returns true if the name looks generic (creature type, role, or monster manual entry).
 * Proper names like "Thordina Ironforge" return false.
 *
 * Checks in order:
 *   1. Exact match on actor's creatureType field
 *   2. Full name match against compendium index (catches everything installed)
 *   3. Multi-word split: every word must be a known role/modifier/compendium creature
 *
 * Examples:
 *   "Hobgoblin Devastator" → in compendium as full name → generic ✓
 *   "Bullywug"             → in compendium → generic ✓
 *   "Thordina Ironforge"   → not in compendium, words unrecognized → proper name ✗
 *   "Captain Blackthorn"   → captain(role) + blackthorn(???) → proper name ✗
 */
function _isGenericName(name, creatureType) {
    if (!name) return true;
    const cleaned = name.trim();

    // Strip trailing numbers/letters: "Goblin 2", "Orc A", "Guard #3"
    // Strip parenthetical variants: "Bandit (Brute Club 2)", "Bandit (Crossbow)", "Bandit (Sword & Shield)"
    const base = cleaned
        .replace(/\s*\([^)]*\)\s*/g, "")      // strip parenthetical suffixes
        .replace(/\s*[#]?\s*\d+\s*$/, "")      // strip trailing numbers
        .replace(/\s+[A-Z]$/, "")              // strip trailing single letter
        .trim().toLowerCase();

    // Exact match on creature type from actor data → generic
    if (creatureType && base === creatureType.toLowerCase()) return true;

    // ── Compendium check: full name match ────────────────────────────────
    // This catches EVERY creature the user has installed — no manual list needed.
    if (_compendiumNames?.has(base)) return true;

    // ── Fallback: split into words and check each ────────────────────────
    // For names NOT in the compendium (custom creatures, homebrew, etc.)
    // If every word is a known role, modifier, or compendium creature word, it's generic.
    const words = base.split(/[\s-]+/).filter(w => w.length > 0);
    if (words.length > 0 && words.every(w => _isGenericWord(w) || (_compendiumNames?.has(w)))) return true;

    // Name with "the" pattern: "The Goblin", "The Guard" → generic, but only
    // if the remaining words are all known generic (avoids catching "The Whisperer",
    // "The Oracle", "The Nameless One" which are proper NPC titles).
    if (/^the\s+/i.test(cleaned)) {
        const afterThe = cleaned.replace(/^the\s+/i, "").split(/[\s-]+/).filter(w => w.length > 0);
        if (afterThe.length > 0 && afterThe.length <= 2 && afterThe.every(w => _isGenericWord(w) || (_compendiumNames?.has(w)))) return true;
    }

    return false;
}

// Hand the compendium-backed generic-name test to the identity reader. It is a
// far better "is this a real name" discriminator than any string heuristic —
// it knows every creature in the installed compendiums. Injected rather than
// imported to avoid a cycle (npc-identity is imported above).
setGenericNameProbe(_isGenericName);

// ─── INTELLIGENCE TIERS ──────────────────────────────────────────────────────

function _getIntTier(intScore) {
    if (intScore <= 3) return "instinct";
    if (intScore <= 7) return "simple";
    if (intScore <= 12) return "moderate";
    return "rich";
}

function _getTierInstructions(tier) {
    switch (tier) {
        case "instinct":
            return `This creature has barely any intellect. Write ONE short sentence describing its basic instinctual behavior, territory, or pack role. For oozes and mindless undead, write something like "Mindless — driven by hunger alone." Keep it under 20 words.`;
        case "simple":
            return `This creature has simple intelligence. Write exactly 2-3 sentences:
1. A name and basic role or occupation (guard, scavenger, tracker)
2. One distinguishing trait or habit
3. One piece of knowledge or rumor they might know
If geographic context is provided, mention where the creature came from or how it ended up here. Keep it grounded and brief.`;
        case "moderate":
            return `This creature has average intelligence. Write 4-6 sentences covering:
1. A name and brief background — where they're from, what route or journey brought them here
2. Their current motivation or goal
3. Who they serve or are loyal to
4. One secret, fear, or vulnerability
Use geographic context to ground the NPC in the world — reference nearby landmarks, settlements, mountain ranges, or travel routes they would realistically know about. Make it specific and useful for roleplay.`;
        case "rich":
            return `This creature is intelligent and complex. Write 6-10 sentences covering:
1. A name, origin story, and how they arrived at their current location — the journey, the route, what they passed through
2. Their primary goals and what they want
3. Faction allegiances, allies, or enemies
4. A personal secret or hidden agenda
5. A rumor, reputation, or what others say about them
Use geographic context to make the NPC feel like they live in this world — they should know their surroundings and have opinions about them. Make it rich, specific, and full of personality a GM can use in roleplay.`;
        default:
            return "";
    }
}

// ─── STAT BLOCK GATHERER ─────────────────────────────────────────────────────
// When an actor has no usable biography (empty, boilerplate, or stub reference),
// gather the full mechanical stat block so the AI can infer personality and
// backstory from the creature's abilities, resistances, features, etc.

function _gatherStatBlock(actor) {
    const parts = [];
    try {
        const sys = actor.system;
        if (!sys) return "";

        // ── Ability Scores ───────────────────────────────────────────────
        const abilities = sys.abilities || {};
        const abilityLine = ["str", "dex", "con", "int", "wis", "cha"]
            .map(a => `${a.toUpperCase()} ${abilities[a]?.value ?? "?"}`)
            .join(", ");
        if (abilityLine) parts.push(`Abilities: ${abilityLine}`);

        // ── HP / AC ──────────────────────────────────────────────────────
        const hp = sys.attributes?.hp;
        if (hp) parts.push(`HP: ${hp.max ?? hp.value ?? "?"}${hp.formula ? ` (${hp.formula})` : ""}`);
        const ac = sys.attributes?.ac;
        if (ac) parts.push(`AC: ${ac.flat ?? ac.value ?? "?"}${ac.calc === "natural" ? " (natural armor)" : ""}`);

        // ── Speed ────────────────────────────────────────────────────────
        const movement = sys.attributes?.movement || {};
        const speeds = [];
        if (movement.walk)    speeds.push(`${movement.walk} ft`);
        if (movement.fly)     speeds.push(`fly ${movement.fly} ft${movement.hover ? " (hover)" : ""}`);
        if (movement.swim)    speeds.push(`swim ${movement.swim} ft`);
        if (movement.burrow)  speeds.push(`burrow ${movement.burrow} ft`);
        if (movement.climb)   speeds.push(`climb ${movement.climb} ft`);
        if (speeds.length) parts.push(`Speed: ${speeds.join(", ")}`);

        // ── Senses (compatible with D&D 5e 5.2.x and 5.3.0+) ────────────
        const rawSenses = sys.attributes?.senses || {};
        const senses = rawSenses.ranges ?? rawSenses;
        const senseList = [];
        if (senses.darkvision)     senseList.push(`darkvision ${senses.darkvision} ft`);
        if (senses.blindsight)     senseList.push(`blindsight ${senses.blindsight} ft`);
        if (senses.tremorsense)    senseList.push(`tremorsense ${senses.tremorsense} ft`);
        if (senses.truesight)      senseList.push(`truesight ${senses.truesight} ft`);
        if (rawSenses.special ?? senses.special) senseList.push(rawSenses.special ?? senses.special);
        if (senseList.length) parts.push(`Senses: ${senseList.join(", ")}`);

        // ── Skills (proficient only) ─────────────────────────────────────
        const skills = sys.skills || {};
        const profSkills = [];
        for (const [key, skill] of Object.entries(skills)) {
            if (skill.value >= 1) {  // proficient or expert
                const total = skill.total ?? skill.mod ?? "?";
                profSkills.push(`${key} +${total}`);
            }
        }
        if (profSkills.length) parts.push(`Skills: ${profSkills.join(", ")}`);

        // ── Damage Resistances / Immunities / Vulnerabilities ────────────
        const traits = sys.traits || {};
        const _traitList = (trait) => {
            if (!trait) return [];
            const values = trait.value instanceof Set ? [...trait.value] : Array.isArray(trait.value) ? trait.value : [];
            const custom = (trait.custom || "").split(";").map(s => s.trim()).filter(Boolean);
            return [...values, ...custom].filter(Boolean);
        };
        const dr = _traitList(traits.dr);
        const di = _traitList(traits.di);
        const dv = _traitList(traits.dv);
        const ci = _traitList(traits.ci);
        if (dr.length) parts.push(`Damage Resistances: ${dr.join(", ")}`);
        if (di.length) parts.push(`Damage Immunities: ${di.join(", ")}`);
        if (dv.length) parts.push(`Damage Vulnerabilities: ${dv.join(", ")}`);
        if (ci.length) parts.push(`Condition Immunities: ${ci.join(", ")}`);

        // ── Legendary / Lair ─────────────────────────────────────────────
        const resources = sys.resources || {};
        if (resources.legact?.max)  parts.push(`Legendary Actions: ${resources.legact.max}/round`);
        if (resources.legres?.max)  parts.push(`Legendary Resistances: ${resources.legres.max}/day`);
        if (resources.lair?.value)  parts.push(`Has Lair: yes (lair actions on initiative 20)`);

        // ── Features & Actions (names + short descriptions) ──────────────
        const items = actor.items || [];
        const features = [];
        const actions = [];
        for (const item of items) {
            const iType = item.type;
            const iName = item.name || "";
            // Get first 100 chars of description for flavor
            const iDesc = (item.system?.description?.value || "")
                .replace(/<[^>]*>/g, "").trim().slice(0, 100);

            if (iType === "feat") {
                features.push(iDesc ? `${iName}: ${iDesc}` : iName);
            } else if (iType === "weapon" || (iType === "feat" && item.system?.activation?.type === "action")) {
                const dmg = item.system?.damage?.parts?.[0];
                const dmgStr = dmg ? ` [${dmg[0]} ${dmg[1] || ""}]` : "";
                actions.push(`${iName}${dmgStr}${iDesc ? ` — ${iDesc}` : ""}`);
            }
        }
        if (features.length) parts.push(`Notable Features:\n  ${features.slice(0, 10).join("\n  ")}`);
        if (actions.length)  parts.push(`Actions/Attacks:\n  ${actions.slice(0, 8).join("\n  ")}`);

        // ── Spellcasting (if any) ────────────────────────────────────────
        const spellItems = [...(actor.items || [])].filter(i => i.type === "spell");
        if (spellItems.length > 0) {
            const spellNames = spellItems.slice(0, 15).map(s => s.name).join(", ");
            parts.push(`Spells: ${spellNames}${spellItems.length > 15 ? ` (+${spellItems.length - 15} more)` : ""}`);
        }

    } catch (err) {
        console.warn(`${TAG} | Error gathering stat block for ${actor.name}:`, err);
    }

    return parts.join("\n");
}

// ─── PROMPT BUILDER ──────────────────────────────────────────────────────────

async function _buildPrompt(tokenDocument, factionResult = {}, socialProfile = null, canonBio = "") {
    const actor = tokenDocument.actor;
    const intScore = actor.system?.abilities?.int?.value ?? 10;
    const tier = _getIntTier(intScore);

    // ── Actor data ──────────────────────────────────────────────────────
    const name = actor.name || "Unknown Creature";
    const creatureType = actor.system?.details?.type?.value || "";
    const creatureSubtype = actor.system?.details?.type?.subtype || "";
    const alignment = actor.system?.details?.alignment || "";
    const cr = actor.system?.details?.cr ?? "";
    const npcTrait = (actor.system?.details?.trait || "").trim();
    const npcIdeal = (actor.system?.details?.ideal || "").trim();
    const npcBond = (actor.system?.details?.bond || "").trim();
    const npcFlaw = (actor.system?.details?.flaw || "").trim();

    // ── Scene data ──────────────────────────────────────────────────────
    const sceneName = canvas.scene?.name || "an unknown location";
    const sceneDesc = (canvas.scene?.description || "").replace(/<[^>]*>/g, "").trim();

    // ── World & geographic context ───────────────────────────────────────
    // World name + current scene journal only. We intentionally do NOT list
    // other scene names — modules ship hundreds of map scenes with names like
    // "BM: 1F Bluewater Inn" and the AI treats them as important locations,
    // leading to hallucinated connections in the bio.
    const worldName = game.world?.title || game.world?.id || "";
    let geographyContext = "";
    try {
        if (worldName) geographyContext = `Campaign/World: ${worldName}`;

        // Scene journal: if the current scene has a linked journal entry, pull text
        const sceneJournal = canvas.scene?.journal;
        if (sceneJournal) {
            // Try specific linked page first, then first page
            const pageId = canvas.scene?.journalEntryPage;
            let page = pageId ? sceneJournal.pages?.get(pageId) : null;
            if (!page) page = sceneJournal.pages?.contents?.[0];
            if (page?.text?.content) {
                const journalText = (page.text.content || "").replace(/<[^>]*>/g, "").trim();
                if (journalText.length > 20) {
                    // Cap at 500 chars — enough for geographic flavor
                    geographyContext += `\nScene notes: ${journalText.slice(0, 500)}`;
                }
            }
        }
    } catch (err) { console.warn(`${TAG} | Scene geography context gathering failed:`, err); }

    // ── Adventure context from ACE Engine (if available) ────────────────
    // Strategy: direct digest lookup FIRST for canonical identity data,
    // then chunk search for supplementary prose detail.
    let adventureContext = "";
    try {
        // 1. Direct digest lookup — instant, structured, canonical (via bridge)
        const directCtx = EngineBridge.digestLookupContext(name, { maxChars: 2000 });

        // 2. Chunk search for supplementary prose — reduced budget if direct lookup found data
        const query = `${name} ${creatureType || ""} backstory at ${sceneName}`.trim();
        const chunkBudget = directCtx.length > 20 ? 4000 : 8000;
        const chunkCtx = await EngineBridge.getDocumentContext(name, query, { maxChars: chunkBudget });

        // Combine: direct lookup (canonical) + chunks (detail)
        const combined = [directCtx, chunkCtx].filter(s => s.length > 10).join("\n");
        if (combined.length > 10) adventureContext = combined;
    } catch (_) { /* ACE Engine not available */ }

    // ── Gather existing names on the scene to avoid duplicates ─────────
    const existingNames = [];
    try {
        for (const t of canvas.scene?.tokens ?? []) {
            const n = t.name?.trim();
            if (n && n !== name) existingNames.push(n);
        }
        // Also include PC actor names
        for (const a of game.actors ?? []) {
            if (a.hasPlayerOwner && a.name) existingNames.push(a.name);
        }
    } catch (err) { console.warn(`${TAG} | Existing names gathering failed:`, err); }
    const uniqueNames = [...new Set(existingNames)];

    // ── Scene-mate awareness: NPCs of the same kind should know each other ──
    let sceneMateContext = "";
    try {
        const myTokenId = tokenDocument.id;
        const myBaseActorId = actor.id;
        // Get the "base" creature identity — strip trailing numbers/letters
        const myBaseName = name.replace(/\s*[#]?\s*\d+\s*$/, "").replace(/\s+[A-Z]$/, "").trim().toLowerCase();

        const mates = [];
        for (const t of canvas.scene?.tokens ?? []) {
            if (t.id === myTokenId) continue;   // skip self
            const tActor = t.actor;
            if (!tActor) continue;

            // Match criteria: same base actor OR same creature base name
            const tBaseName = (tActor.name || "").replace(/\s*[#]?\s*\d+\s*$/, "").replace(/\s+[A-Z]$/, "").trim().toLowerCase();
            const sameBaseActor = tActor.id === myBaseActorId || (t.actorId === tokenDocument.actorId);
            const sameCreature  = tBaseName === myBaseName && myBaseName.length > 1;

            if (!sameBaseActor && !sameCreature) continue;

            // Gather info about this scene-mate
            const mateName = t.name || tActor.name || "Unknown";
            let mateInfo = mateName;

            // Check if this mate already has a generated bio — pull a one-line summary
            const mateBio = tActor.system?.details?.biography?.value || "";
            const mateBioClean = mateBio.replace(/<[^>]*>/g, "").trim();
            if (mateBioClean.length > 20) {
                // Grab first sentence or first 120 chars, whichever is shorter
                const firstSentence = mateBioClean.split(/[.!?]\s/)[0] + ".";
                mateInfo += ` — ${firstSentence.slice(0, 120)}`;
            }
            mates.push(mateInfo);
        }

        if (mates.length > 0) {
            const plural = mates.length > 1 ? "allies" : "an ally";
            sceneMateContext = `\n\nScene-mates (same creature type already on the scene — they know each other):\n` +
                mates.map(m => `  • ${m}`).join("\n") +
                `\nWeave natural relationships with these scene-mates into the biography — they might be siblings, packmates, squad members, rivals, or old friends. Reference them by name if they have one.` +
                `\nIMPORTANT: these scene-mates are OTHER individuals. This creature is NOT any of them. NEVER give this creature a scene-mate's name — its NAME: line must be a brand-new name that appears nowhere in the lists above.`;
        }

        // ── Scene role awareness: what roles are already filled ──────────
        // Prevents 5 bartenders in one tavern. Lists ALL NPCs on scene
        // (not just same-type) so AI knows what positions are taken.
        const allSceneNpcs = [];
        for (const t of canvas.scene?.tokens ?? []) {
            if (t.id === myTokenId) continue;
            const tActor = t.actor;
            if (!tActor || tActor.type !== "npc") continue;
            const tRole = tActor.getFlag?.(MODULE_ID, "factionRole") || "";
            const tName = t.name || tActor.name || "Unknown";
            if (tRole) {
                allSceneNpcs.push(`${tName} (${tRole})`);
            } else {
                allSceneNpcs.push(tName);
            }
        }
        if (allSceneNpcs.length > 0) {
            sceneMateContext += `\n\nAll NPCs already on this scene:\n` +
                allSceneNpcs.map(n => `  • ${n}`).join("\n") +
                `\nDo NOT duplicate existing roles. If the scene already has a bartender, this NPC should NOT also be a bartender — choose a different appropriate role (patron, traveler, visitor, cook, bouncer, etc.).`;
        }
    } catch (err) { console.warn(`${TAG} | Scene-mate awareness context failed:`, err); }

    // ── Detect gender from voice flag → token art → existing data ───────
    // Priority: 1) Already-assigned voice gender flag (set by voice engine or GM toggle)
    //           2) Art path / name / race keyword signals
    // This ensures the bio matches the voice the NPC will actually use.
    let genderHint = "";
    try {
        const voiceGender = (!tokenDocument.actorLink ? tokenDocument.actor : actor)
            .getFlag(MODULE_ID, "voiceGender") || "";
        if (voiceGender === "male" || voiceGender === "female") {
            genderHint = `\n- Gender: ${voiceGender.charAt(0).toUpperCase() + voiceGender.slice(1)} (use matching pronouns)`;
        } else {
            const artPath = (tokenDocument.texture?.src || actor.img || "").toLowerCase();
            const bioRaw  = (actor.system?.details?.biography?.value || "").toLowerCase();
            const appearance = (actor.system?.details?.appearance || "").toLowerCase();
            const allText = `${artPath} ${bioRaw} ${appearance} ${name.toLowerCase()}`;

            const femaleSignals = /\b(female|woman|girl|lady|queen|princess|priestess|witch|sorceress|matron|maiden|duchess|countess|baroness|empress|mistress|hag|banshee|dryad|nymph|harpy|medusa|siren|she-|her |barmaid)\b|_[Ff](?:emale)?[_./]|[_-]f[_./]/;
            const maleSignals   = /\b(male|man|boy|lord|king|prince|priest|duke|count|baron|emperor|master|patriarch|he |his )\b|_[Mm](?:ale)?[_./]|[_-]m[_./]/;

            if (femaleSignals.test(allText)) genderHint = "\n- Apparent Gender: Female";
            else if (maleSignals.test(allText)) genderHint = "\n- Apparent Gender: Male";
            else genderHint = "\n- Apparent Gender: Male";  // default male when no signal
        }
    } catch (err) { console.warn(`${TAG} | Gender detection from voice/art failed:`, err); }

    // ── Build system prompt ─────────────────────────────────────────────
    const isUnlinked = !tokenDocument.actorLink;

    // Non-sentient creature types: don't rename, use minimal bio
    const NO_RENAME_TYPES = new Set(["beast", "ooze", "plant", "swarm"]);
    const isNonSentient = NO_RENAME_TYPES.has((creatureType || "").toLowerCase());

    let nameInstruction = "";
    let tierInstructions = _getTierInstructions(tier);

    // ── Detect scene region for culturally appropriate naming ──────────
    let namingHint = "";
    try {
        const regionFlag = canvas.scene?.flags?.[MODULE_ID]?.voiceRegion || "";
        const sceneNameLower = (sceneName || "").toLowerCase();
        // Map regions to naming culture hints
        const REGION_NAMING = {
            "barovia":      "Eastern European (Romanian, Slavic, Hungarian)",
            "ravenloft":    "Eastern European (Romanian, Slavic, Hungarian)",
            "calimshan":    "Middle Eastern / Arabic",
            "chult":        "African (West African, Swahili-inspired)",
            "kara_tur":     "East Asian (Chinese, Japanese, Korean)",
            "icewind_dale": "Nordic / Scandinavian",
            "nordic":       "Nordic / Scandinavian",
            "underdark":    "Dark/unusual — Drow or Undercommon-influenced",
            "sword_coast":  "British / Western European",
            "waterdeep":    "British / Western European",
            "baldurs_gate": "British / Western European",
        };
        const region = regionFlag || Object.keys(REGION_NAMING).find(r =>
            sceneNameLower.includes(r.replace(/_/g, " "))) || "";
        if (region && REGION_NAMING[region]) {
            namingHint = ` The name should sound ${REGION_NAMING[region]} — culturally appropriate for the region.`;
        }
    } catch (err) { console.warn(`${TAG} | Region naming hint detection failed:`, err); }

    // ── Personality instruction (sentient NPCs only) ─────────────────
    let personalityInstruction = "";

    if (isNonSentient) {
        // Beasts, oozes, plants, swarms — keep species name, minimal bio
        nameInstruction = `\nThis is a ${creatureType || "creature"} — it does NOT need a personal name. "${name}" is its species. Do NOT rename it or start with a NAME: line.\n`;
        tierInstructions = `This is a beast or simple creature. Write ONE sentence (max 20 words) about its behavior, territory, or pack role. No personality, no backstory, no dialogue. Example: "Territorial alpha with fresh scars, patrols the mountain pass at dusk."`;
    } else if (isUnlinked && _isGenericName(name, creatureType) && tokenDocument._aceSkipRename) {
        // Generic name but GM chose to keep it via smart setup dialog — write bio generically
        nameInstruction = `\nThis NPC is known only as "${name}" — a generic label, not a personal name. Do NOT give them a personal name or start with a NAME: line. Refer to them as "this ${name.toLowerCase()}" or "the ${name.toLowerCase()}" throughout the biography. Write them as a specific individual with their own personality and history, but without a proper name.\n`;
        personalityInstruction = `\nAfter the biography, add TWO lines:\nPERSONALITY: [1-2 sentence description of how this NPC speaks, their mannerisms, speech patterns, and demeanor]\nTONE: [one word from this list ONLY: formal, casual, cryptic, cheerful, grim, sarcastic, threatening, nervous, stoic, theatrical]\n`;
    } else if (isUnlinked && _isGenericName(name, creatureType) && !tokenDocument._aceSkipRename) {
        // Generic label → AI should rename (canon bio no longer blocks this)
        let avoidList = "";
        if (uniqueNames.length) {
            avoidList = `\nDo NOT use names similar to these existing characters: ${uniqueNames.join(", ")}. Pick something distinctly different.`;
        }
        nameInstruction = `\nCRITICAL — NAMING REQUIRED: "${name}" is a GENERIC LABEL, not a real name. You MUST give this NPC a unique personal name. Your response MUST begin with exactly this format on the very first line:\nNAME: Firstname Lastname\nThen write the biography below that line. Do NOT use "${name}" as the NPC's name anywhere in the bio — replace it with the name you chose.${namingHint}${avoidList}\n`;
        personalityInstruction = `\nAfter the biography, add TWO lines:\nPERSONALITY: [1-2 sentence description of how this NPC speaks, their mannerisms, speech patterns, and demeanor]\nTONE: [one word from this list ONLY: formal, casual, cryptic, cheerful, grim, sarcastic, threatening, nervous, stoic, theatrical]\n`;
    } else if (isUnlinked) {
        // Proper name ("Thordina Ironforge") → keep the name, don't rename
        nameInstruction = `\nThis NPC is already named "${name}". Use this name in the biography — do NOT rename them or start with a NAME: line.\n`;
        personalityInstruction = `\nAfter the biography, add TWO lines:\nPERSONALITY: [1-2 sentence description of how this NPC speaks, their mannerisms, speech patterns, and demeanor]\nTONE: [one word from this list ONLY: formal, casual, cryptic, cheerful, grim, sarcastic, threatening, nervous, stoic, theatrical]\n`;
    } else {
        // Linked NPC — keep the name, still generate personality
        nameInstruction = `\nThis NPC is named "${name}". Use this name — do NOT rename or start with a NAME: line.\n`;
        personalityInstruction = `\nAfter the biography, add TWO lines:\nPERSONALITY: [1-2 sentence description of how this NPC speaks, their mannerisms, speech patterns, and demeanor]\nTONE: [one word from this list ONLY: formal, casual, cryptic, cheerful, grim, sarcastic, threatening, nervous, stoic, theatrical]\n`;
    }

    const systemPrompt = `You are a D&D 5e backstory generator for a tabletop RPG.
Generate a concise NPC biography for use by an AI conversation system.
Write in third person. Do NOT include stat blocks, abilities, or game mechanics.
Do NOT address the GM or players directly — just write the biography.

BIOGRAPHY STRUCTURE — follow this balance:
• 80-90% should be the NPC's HISTORY, BACKGROUND, and PERSONALITY — who they fundamentally are, independent of any specific location. Their origin, their formative experiences, their values, their relationships, their goals across their entire life.
• 10-20% should briefly address why they are in the CURRENT SCENE — what brought them here, what they're doing right now. This is a footnote, not the focus.
• The biography should work even if the NPC moves to a completely different location — their identity is not defined by where they currently stand.
• For powerful/legendary creatures: focus on their cosmic significance, history, and reputation FIRST. The current scene is just where they happen to be at this moment.

STRICT RULES — violating these makes the bio unusable:
• NO plot hooks, adventure suggestions, quest ideas, or "potential encounters" — NEVER. Focus ONLY on who this NPC is, their past, personality, and current motivations.
• NO location name-dropping — only mention a location if the NPC was born there, lives there, or has deep personal history with it. The geographic context is for YOUR reference to ground the NPC, not a checklist to work into the text.
• End the biography with the NPC's current state or mindset — NOT with speculation about what adventurers might do.
${nameInstruction}
${tierInstructions}
${personalityInstruction}`;

    // ── Role hint: original token name tells us what this NPC does ──────
    // "Bartender" → role is bartender. "Commoner" → generic, AI picks role.
    // The original name is sacred — we use it as a profession signal.
    let roleHint = "";
    const originalName = (tokenDocument.name || actor.name || "").replace(/\s*\([^)]*\)\s*/g, "").replace(/\s*#?\s*\d+\s*$/g, "").trim();
    const roleNames = new Set(["bartender", "barmaid", "waitress", "innkeeper", "merchant", "blacksmith", "stable hand",
        "cook", "servant", "guard", "soldier", "scout", "spy", "assassin", "priest", "acolyte", "farmer",
        "fisherman", "miner", "woodcutter", "herbalist", "healer", "beggar", "thief", "pickpocket",
        "shopkeeper", "tailor", "cobbler", "baker", "butcher", "librarian", "scribe", "sage",
        "entertainer", "bard", "dancer", "courtesan", "gladiator", "bouncer", "dockworker", "sailor"]);
    if (roleNames.has(originalName.toLowerCase())) {
        roleHint = `\n- Original Role: ${originalName} — this NPC's profession is ${originalName.toUpperCase()}. Do NOT change their profession to something else. They may get a proper name but their JOB stays the same.`;
    }

    // If faction result has a role, use that instead (it's more specific/GM-chosen)
    if (factionResult?.role) {
        roleHint = `\n- Assigned Role: ${factionResult.role} — this NPC's role/profession is ${factionResult.role.toUpperCase()}. Do NOT change it.`;
    }

    // ── Token portrait: grab for AI vision (gender/age/ethnicity matching) ──
    let tokenImage = null;
    try {
        const imgPath = tokenDocument.texture?.src || actor.prototypeToken?.texture?.src || actor.img || "";
        if (imgPath && !imgPath.includes("mystery-man") && !imgPath.includes("default-avatar")) {
            const imgResp = await fetch(imgPath, { signal: AbortSignal.timeout(10000) });
            if (imgResp.ok) {
                const blob = await imgResp.blob();
                // Only formats the vision APIs actually accept. `image/*` was
                // far too permissive: Foundry ships a lot of SVG token art, and
                // "image/svg+xml" sails through a startsWith("image/") test and
                // is then rejected by OpenAI/Azure with a bare 400 — which
                // surfaced as an unexplained bio-generation failure on token
                // drop. Anything not on this list is simply not sent; the bio
                // still generates, just without portrait-based gender matching.
                const VISION_MIME_OK = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
                const mime = String(blob.type || "").toLowerCase();
                if (blob.size > 0 && blob.size < 5_000_000 && VISION_MIME_OK.includes(mime)) {
                    const buf = await blob.arrayBuffer();
                    // Chunk the byte→char conversion: spreading a whole multi-MB
                    // buffer into String.fromCharCode blows the call stack
                    // (RangeError) on any real portrait. 8192 matches tts.mjs.
                    const bytes = new Uint8Array(buf);
                    let binary = "";
                    for (let i = 0; i < bytes.length; i += 8192) {
                        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                    }
                    const base64 = btoa(binary);
                    tokenImage = { base64, mimeType: blob.type };
                    console.log(`${TAG} | Token art loaded for vision (${(blob.size/1024).toFixed(0)} KB, ${blob.type})`);
                } else {
                    console.log(`${TAG} | Token art NOT sent to vision (${(blob.size/1024).toFixed(0)} KB, ${blob.type || "unknown type"}) — unsupported format or too large. Bio still generates, just without portrait matching.`);
                }
            }
        }
    } catch (e) {
        console.debug(`${TAG} | Token art vision load failed (non-fatal):`, e.message);
    }

    // ── Build user message with context ─────────────────────────────────
    let userMsg = `Generate a biography for this NPC:
- Name: ${name}
- Type: ${creatureType}${creatureSubtype ? ` (${creatureSubtype})` : ""}
- Alignment: ${alignment || "Unknown"}
- Intelligence: ${intScore}
- Challenge Rating: ${cr}
- Current Scene: ${sceneName}${genderHint}${roleHint}`;

    // ── Canon biography: existing lore from adventure module or GM ───────
    // This is the MOST important context — the AI must expand on it, never contradict.
    if (canonBio) {
        userMsg += `\n\nEXISTING CANON BIOGRAPHY — this is established lore from the adventure module or GM notes. Your biography MUST be 100% consistent with every fact stated here. Expand and enrich this information with additional details, personality, and backstory, but NEVER contradict, change, or ignore any of these facts:\n"${canonBio}"`;
    }

    // ── Origin context: where is this NPC from? (set by NPC Identity Dialog) ─
    try {
        const npcOrigin = actor.getFlag(MODULE_ID, "npcOrigin");
        const npcOriginCustom = actor.getFlag(MODULE_ID, "npcOriginCustom");
        if (npcOrigin) {
            const originLabels = {
                this_scene: `This NPC is FROM this area (${sceneName}). Their background is rooted here — this is home.`,
                nearby: `This NPC is from a nearby area${npcOriginCustom ? ` (${npcOriginCustom})` : ""}. They have ties to the region but aren't a local.`,
                elsewhere: `This NPC is from a distant location${npcOriginCustom ? ` (${npcOriginCustom})` : ""} within the campaign world. Most of their background takes place far from here.`,
                foreign: `This NPC is from a completely foreign realm${npcOriginCustom ? ` (${npcOriginCustom})` : ""} — another plane, continent, or distant land. Their background is almost entirely about where they came from. Only briefly mention why they're currently at ${sceneName}.`,
            };
            userMsg += `\n\nORIGIN: ${originLabels[npcOrigin] ?? `From ${npcOriginCustom || "unknown"}.`}`;
        }
    } catch (err) { console.debug("ACE: Engine | bio-generator NPC origin flag read non-fatal:", err); }

    // ── Gender override (set by NPC drop dialog) ─────────────────────
    // The user can lock the gender via the drop dialog's Auto/Male/Female/
    // Androgynous radio. When set to anything but auto, this hardcoded
    // instruction takes precedence over the vision-based gender check —
    // critical for users on non-vision models (qwen2.5-coder, llama3.2 base)
    // and for explicit non-binary characters regardless of portrait.
    let genderOverride = "";
    try { genderOverride = actor.getFlag(MODULE_ID, "genderOverride") || ""; }
    catch (_) { /* flag not set — fall through to portrait-based detection */ }

    if (genderOverride === "male") {
        userMsg += `\n\nGENDER LOCK: This NPC is MALE. Use a masculine name and he/him pronouns. Do NOT override based on portrait — the GM has explicitly chosen male.`;
    } else if (genderOverride === "female") {
        userMsg += `\n\nGENDER LOCK: This NPC is FEMALE. Use a feminine name and she/her pronouns. Do NOT override based on portrait — the GM has explicitly chosen female.`;
    } else if (genderOverride === "androgynous") {
        userMsg += `\n\nGENDER LOCK: This NPC is ANDROGYNOUS. Use a gender-neutral or unisex name and they/them pronouns throughout. Do NOT override based on portrait — the GM has explicitly chosen androgynous.`;
    } else if (tokenImage) {
        // Auto path — let the portrait drive gender (only works on vision-capable models)
        userMsg += `\n\nIMPORTANT: A portrait of this NPC is attached. Match the character's apparent GENDER, AGE, and ETHNICITY from the image. If the portrait shows a woman, use a female name and she/her pronouns. If elderly, reflect that in the bio. Override any prior gender hints if they conflict with what you see in the portrait.`;
    }

    // ── Cross-reference: resolve "See X for details" stubs ─────────────
    // If the bio references another document ("See 1F Sepulcher of Dawn for details"),
    // try to find that scene or journal and pull its text as additional context.
    const existingBio = actor.system?.details?.biography?.value || "";
    let crossRefContext = "";
    try {
        const stubMatch = existingBio.replace(/<[^>]*>/g, "").match(
            /\bsee\s+(?:\d+[A-Za-z]?\s+)?(.{3,60}?)\s+for\s+(?:details|more|info|description|encounter|personality|tactics)/i
        );
        if (stubMatch) {
            const refName = stubMatch[1].trim();
            // Search scenes for a name containing the reference
            let refText = "";
            for (const s of game.scenes ?? []) {
                if (s.name && s.name.toLowerCase().includes(refName.toLowerCase())) {
                    // Found matching scene — grab its journal if available
                    const sj = s.journal;
                    if (sj) {
                        const sp = s.journalEntryPage ? sj.pages?.get(s.journalEntryPage) : null;
                        const pg = sp || sj.pages?.contents?.[0];
                        if (pg?.text?.content) {
                            refText = pg.text.content.replace(/<[^>]*>/g, "").trim().slice(0, 600);
                        }
                    }
                    if (!refText && s.description) {
                        refText = s.description.replace(/<[^>]*>/g, "").trim().slice(0, 600);
                    }
                    break;
                }
            }
            // If no scene match, search journal entries
            if (!refText) {
                for (const j of game.journal ?? []) {
                    for (const pg of j.pages?.contents ?? []) {
                        if (pg.name && pg.name.toLowerCase().includes(refName.toLowerCase())) {
                            refText = (pg.text?.content || "").replace(/<[^>]*>/g, "").trim().slice(0, 600);
                            break;
                        }
                    }
                    if (refText) break;
                }
            }
            if (refText) {
                crossRefContext = `\n\nReferenced location "${refName}" (from the NPC's bio stub):\n${refText}`;
            }
        }
    } catch (err) { console.warn(`${TAG} | Cross-reference resolution failed:`, err); }

    // ── Stat-block inference for empty/stub bios ──────────────────────
    // If the actor has no real bio (empty, boilerplate, or "see X for details"),
    // gather the full stat block so the AI can infer personality and style from mechanics.
    const hasRealBio = isRealBiography(existingBio);
    if (!hasRealBio) {
        const statBlock = _gatherStatBlock(actor);
        if (statBlock) {
            userMsg += `\n\nThis creature's actor sheet has no usable biography — only a stub or empty field.
Infer this NPC's personality, combat style, territorial behavior, and backstory from the stat block below.
A high STR suggests brute force; high DEX suggests stealth/agility; swim/burrow speeds suggest habitat;
resistances/immunities hint at origin; legendary actions mean this is a boss creature; spells reveal intellect and tradition.
DO NOT list stats or mechanics in the bio — translate them into narrative flavor.

STAT BLOCK:
${statBlock}`;
        }
        if (crossRefContext) userMsg += crossRefContext;
    } else {
        // Has a real bio already — include a brief excerpt for context
        const bioExcerpt = existingBio.replace(/<[^>]*>/g, "").trim().slice(0, 300);
        if (bioExcerpt.length > 20) {
            userMsg += `\n\nExisting biography excerpt (build on this, don't contradict it):\n${bioExcerpt}`;
        }
        if (crossRefContext) userMsg += crossRefContext;
    }

    if (sceneDesc) userMsg += `\n- Scene Description: ${sceneDesc}`;
    if (geographyContext) userMsg += `\n\nWorld context:\n${geographyContext}`;
    if (npcTrait)  userMsg += `\n- Personality Trait: ${npcTrait}`;
    if (npcIdeal)  userMsg += `\n- Ideal: ${npcIdeal}`;
    if (npcBond)   userMsg += `\n- Bond: ${npcBond}`;
    if (npcFlaw)   userMsg += `\n- Flaw: ${npcFlaw}`;
    if (adventureContext) userMsg += `\n\nRelevant adventure context:\n${adventureContext}`;
    if (sceneMateContext) userMsg += sceneMateContext;

    // ── Faction context: inject faction identity into the bio prompt ──────
    if (factionResult?.faction) {
        const tokenCreatureBase = resolveCreatureBase(actor);
        const factionCtx = buildFactionBioContext(
            factionResult.faction,
            factionResult.isSpy || false,
            factionResult.spyFaction || null,
            factionResult.role || "",
            tokenCreatureBase
        );
        if (factionCtx) userMsg += factionCtx;
    }

    // ── Social Profile: inject societal structure constraints ──────────
    if (socialProfile) {
        try {
            const spCtx = SocialProfileEngine.buildPromptContext(socialProfile);
            if (spCtx) userMsg += spCtx;
        } catch (err) {
            console.warn(`${TAG} | Social profile context injection failed (non-fatal):`, err);
        }
    }

    // ── Scene Intelligence: comprehensive location context ──────────────
    // Scene Intelligence combines document library + World Bible + cross-refs
    // into a single cached deep scan per scene. Much richer than separate lookups.
    let sceneIntelInjected = false;
    try {
        const intelPrompt = await EngineBridge.getSceneIntelligencePrompt(sceneName, null, name);
        if (intelPrompt && intelPrompt.length > 20) {
            userMsg += `\n\n${intelPrompt}\nUse this scene intelligence to make the NPC's backstory fit naturally into the local culture, politics, factions, and religion. Reference local factions, rulers, deities, or tensions where appropriate.`;
            sceneIntelInjected = true;
        }
    } catch (err) {
        console.debug(`${TAG} | Scene intelligence lookup failed (non-fatal):`, err);
    }

    // Fallback: World Bible context if scene intelligence wasn't available
    if (!sceneIntelInjected) {
        try {
            let wbCtx = EngineBridge.getWorldBibleCityContext(sceneName, name);
            if (!wbCtx) wbCtx = EngineBridge.searchWorldBible(`${name} ${sceneName}`, 3);
            if (!wbCtx) wbCtx = await EngineBridge.resolveWorldBibleLocation(sceneName, name);
            if (wbCtx) {
                userMsg += `\n\n${wbCtx}\nUse this world knowledge to make the NPC's backstory fit naturally into the local culture, politics, and religion. Reference local factions, rulers, or tensions where appropriate.`;
            }
        } catch (err) {
            console.debug(`${TAG} | World Bible context lookup failed (non-fatal):`, err);
        }
    }

    // ── Travel history: for recurring linked NPCs ────────────────────────
    // If this NPC has been seen in previous locations, feed that history
    // so the AI can explain WHY they moved and maintain narrative continuity.
    const bioHistory = actor.getFlag(MODULE_ID, "bioHistory") || [];
    if (bioHistory.length > 0) {
        const historyLines = bioHistory
            .map(h => `• ${h.sceneName}: ${h.summary}`)
            .join("\n");
        userMsg += `\n\nTRAVEL HISTORY — this NPC has been encountered before in other locations. Acknowledge their journey and explain why they are NOW in "${sceneName}". Do not repeat old backstory verbatim, but maintain continuity:\n${historyLines}`;
    }

    // ── NPC memory from ACE Engine: past encounters, kills, notes ─────────
    // If ACE Engine is active, check if this NPC has been encountered before.
    // This is how the AI knows "Grock was killed by Jeth 90 sessions ago."
    try {
        {
            const npcRecord = EngineBridge.getNpcRecord(name);
                if (npcRecord) {
                    const parts = [];
                    if (npcRecord.killed) {
                        parts.push(`PREVIOUSLY KILLED by ${npcRecord.killerName || "unknown"}.`);
                    }
                    if (npcRecord.met > 1) {
                        parts.push(`Encountered ${npcRecord.met} times before.`);
                    }
                    if (npcRecord.scenes?.length) {
                        parts.push(`Previously seen in: ${npcRecord.scenes.slice(-5).join(", ")}.`);
                    }
                    if (npcRecord.notes?.length) {
                        const recentNotes = npcRecord.notes.slice(-3).map(n => n.txt || n).filter(Boolean);
                        if (recentNotes.length) parts.push(`Notes: ${recentNotes.join("; ")}`);
                    }
                if (parts.length) {
                    userMsg += `\n\nCAMPAIGN MEMORY — ACE Engine has records for this NPC from previous sessions:\n${parts.join("\n")}`;
                    if (npcRecord.killed) {
                        userMsg += `\nThis creature was killed before. If it is reappearing, explain WHY — resurrection, necromancy, a different individual of the same lineage, a ghost, or some other narrative reason. Do NOT ignore the death.`;
                    }
                }
            }
        }
    } catch (_) { /* ACE Engine not available or NPC not found — that's fine */ }

    // ── Final naming reminder for generic NPCs ──────────────────────────
    // This MUST be the last thing in userMsg so the AI sees it right before
    // generating. Long context windows cause the AI to forget the system prompt
    // NAME: instruction buried thousands of tokens earlier.
    if (!isNonSentient && isUnlinked && (!canonBio || /\s*[#]?\s*\d+\s*$/.test(name)) && _isGenericName(name, creatureType)) {
        userMsg += `\n\nREMEMBER: Your response MUST start with "NAME: [Unique Personal Name]" on the very first line. "${name}" is a generic label — do NOT use it as the NPC's name. Pick a culturally appropriate name that fits the setting.`;
    }

    return { systemPrompt, userMsg, tokenImage };
}

// ─── GENERATE BIO ────────────────────────────────────────────────────────────

async function _generateBio(tokenDocument) {
    const actor = tokenDocument.actor;
    if (!actor) return;

    // ── Tier check: determine what AI work to run ───────────────────────
    // The dialog may have overridden the tier on the tokenDoc itself
    let tier = tokenDocument._aceDropTier || "full";
    if (tier === "full" || tier === "bio-only" || tier === "faction-only") {
        // Valid tier from dialog override
    } else {
        try { tier = game.settings.get(MODULE_ID, "tokenDropAI") ?? "full"; }
        catch (_) { tier = "full"; }
    }

    // "off" — bail entirely (shouldn't normally reach here, but guard anyway)
    if (tier === "off") {
        console.log(`${TAG} | Token drop AI is off — skipping all generation for ${actor.name}`);
        return;
    }

    const { provider, apiKey } = getEnvoyAIConfig();
    const isUnlinked = !tokenDocument.actorLink;

    console.log(`${TAG} | Generating for ${actor.name} (${isUnlinked ? "unlinked" : "linked"}, tier: ${tier})...`);

    // ── Faction assignment (only if tier includes faction) ───────────────
    let factionResult = { faction: null, isSpy: false, spyFaction: null, role: "" };
    if (tier === "full" || tier === "faction-only") {
        try {
            factionResult = await processTokenFaction(tokenDocument);
        } catch (err) {
            console.warn(`${TAG} | Faction processing failed for ${actor.name} (non-fatal):`, err);
        }
    }

    // ── Re-read tier in case the Smart Setup dialog overrode it ─────────
    // The dialog's "Skip All" button sets tokenDocument._aceDropTier="off"
    // mid-flow. The local `tier` was captured BEFORE the dialog so we
    // need to refresh it now. If GM hit Skip All, bail completely — no
    // bio, no items, no loot, nothing.
    if (tokenDocument._aceDropTier && tokenDocument._aceDropTier !== tier) {
        tier = tokenDocument._aceDropTier;
        console.log(`${TAG} | Tier updated by dialog → "${tier}" for ${actor.name}`);
    }
    if (tier === "off") {
        console.log(`${TAG} | GM chose Skip All — no further generation for ${actor.name}`);
        return;
    }

    // If faction-only, skip bio + social profile. But the master toggle says
    // items + loot still run regardless of the bio decision, so honor it here.
    if (tier === "faction-only") {
        console.log(`${TAG} | Tier is faction-only — skipping bio for ${actor.name}`);
        let alwaysItemsLoot = true;
        try { alwaysItemsLoot = game.settings.get(MODULE_ID, "alwaysRunItemAndLoot") !== false; }
        catch (_) {}
        if (alwaysItemsLoot) {
            _generateItemBios(tokenDocument)
                .then(() => _lootThenRealLoot(tokenDocument))
                .then(() => _playShimmer(tokenDocument))
                .catch(err => console.warn(`${TAG} | Items + loot (faction-only path) failed:`, err));
        }
        return;
    }

    // ── Social profile generation (local — no cross-module dependency) ──
    let socialProfile = null;
    try {
        const spEnabled = game.settings.get(MODULE_ID, "enableSocialProfiles") ?? true;
        if (spEnabled) {
            socialProfile = SocialProfileEngine.generate(actor, {
                factionRole: factionResult?.role ?? "",
                factionName: factionResult?.faction?.name ?? "",
                cr: actor.system?.details?.cr ?? 1,
            });
            if (socialProfile) {
                await SocialProfileEngine.store(actor, socialProfile);
                console.log(`${TAG} | Social profile generated for ${actor.name}:`, socialProfile.hierarchy, socialProfile.disposition);
            }
        }
    } catch (err) {
        console.warn(`${TAG} | Social profile generation failed for ${actor.name} (non-fatal):`, err);
    }

    // ── Extract existing canon biography (adventure module content) ─────
    // If the actor already has bio text that isn't ours, treat it as canon
    // and feed it into the prompt so the AI expands without contradicting.
    let canonBio = "";
    try {
        const rawBio = actor.system?.details?.biography?.value || "";
        const stripped = rawBio
            .replace(/<section class="ace-engine-bio">[\s\S]*?<\/section>/gi, "") // remove any ACE bio
            .replace(/<hr\s*\/?>/gi, "")                                          // remove separators
            .replace(/<[^>]+>/g, " ")                                              // strip HTML tags
            .replace(/Disclaimer[\s\S]*$/i, "")                                    // strip disclaimers
            .replace(/SRD\s+\d[\s\S]*$/i, "")                                     // strip SRD notices
            .replace(/Open Game License[\s\S]*$/i, "")                             // strip OGL
            .replace(/This (character|work|material) is designed to be compatible[\s\S]*$/i, "") // strip compatibility notices
            .replace(/All product and company names[\s\S]*$/i, "")                 // strip trademark notices
            .replace(/Token [Aa]rt(work)?[\s\S]*$/i, "")                             // strip art credits (any variant)
            .replace(/[Aa]bility [Aa]rt[\s\S]*$/i, "")                               // strip ability art credits
            .replace(/[Aa]rtwork by[\s\S]*$/i, "")                                    // strip generic art credits
            .replace(/\s+/g, " ")                                                  // collapse whitespace
            .trim();
        if (stripped.length > 15) {
            canonBio = stripped;
            console.log(`${TAG} | Found existing canon bio for ${actor.name} (${stripped.length} chars): "${stripped.slice(0, 80)}..."`);
        }
    } catch (err) { console.debug("ACE: Engine | bio-generator canon bio extraction non-fatal:", err); }

    //── Build prompt and call AI ─────────────────────────────────────────
    const { systemPrompt, userMsg, tokenImage } = await _buildPrompt(tokenDocument, factionResult, socialProfile, canonBio);
    let images = tokenImage ? [tokenImage] : [];

    // ── Vision capability check ─────────────────────────────────────────
    // If we have a portrait but the model can't see images, the bio prompt's
    // "match the portrait's gender" instruction does nothing — the AI will
    // pick a random gender from the name pool. Warn the user once per session
    // so they can switch to a vision-capable model.
    if (images.length) {
        try {
            const { isVisionCapable, warnVisionUnavailable } = await import("../vision-capability.mjs");
            const { modelName, apiUrl } = getEnvoyAIConfig();
            const canSee = await isVisionCapable(provider, modelName, { apiUrl, queryOllamaShow: provider === "ollama" });
            if (!canSee) {
                warnVisionUnavailable(provider, modelName);
                // DROP the image rather than send it anyway. Previously this
                // only warned and still attached the portrait, so a text-only
                // model got a multimodal payload and answered with a 400 —
                // failing the whole bio instead of merely losing the portrait.
                images = [];
                console.warn(`${TAG} | Vision NOT available on ${provider}:${modelName} — portrait dropped from the request. Bio still generates; gender won't be portrait-matched.`);
            }
        } catch (e) { console.debug("ACE: Engine | vision-capability check failed:", e); }
    }

    const response = await AIHandler.callAI(systemPrompt, [], userMsg, provider, apiKey, images, { context: "bio-generator" });

    if (isAIFailure(response)) return;   // GM already notified — never persist a failure marker
    if (!response || !response.trim()) {
        console.warn(`${TAG} | AI returned no usable bio for ${actor.name}.`);
        return;
    }

    // Guard against AI timeout/error fallback strings being saved as real bios
    const FALLBACK_STRINGS = ["my mind is foggy", "my thoughts are scattered"];
    if (FALLBACK_STRINGS.includes(response.trim().replace(/\.{3}$/, "").toLowerCase())) {
        console.warn(`${TAG} | AI returned fallback string for ${actor.name} — skipping bio save.`);
        return;
    }

    // ── Parse response ──────────────────────────────────────────────────
    let bioText = response.trim();
    let generatedName = null;
    let generatedPersonality = null;

    // Extract NAME: line if present — only use it for generic names that we asked to rename.
    // If the AI returns a NAME: line for a proper-named NPC (shouldn't happen), strip it but don't rename.
    // Non-sentient types (beast, ooze, plant, swarm) NEVER get renamed.
    //
    // Flexible regex:
    //   • Accepts NAME: at the start OR at the start of any line within the
    //     first ~300 chars (some AI responses lead with a one-sentence intro
    //     then drop the NAME: line on its own line below).
    //   • Allows leading whitespace, markdown code fences, or blank lines.
    // ── Taken names on this scene — REAL names AND flavor nameplates ──────
    // The old dedup only compared real token names ("Ogre" vs "Ogre (1)"), so a
    // generated name could still collide with a neighbour's FLAVOR name — that is
    // exactly how two ogres both ended up as "Grulgar Stonearm" (root-caused
    // 2026-07-26). Collect every name any creature on the scene is wearing:
    // real token names, base actor names, and flavor nameplates (the token's own
    // AND its base actor's). Used by BOTH naming paths below.
    const takenNames = new Set();
    try {
        for (const t of canvas.scene?.tokens ?? []) {
            if (t.id === tokenDocument.id) continue;
            for (const n of [
                t.name,
                t.actor?.name,
                t.actor?.getFlag?.(MODULE_ID, "flavorName"),
                game.actors.get(t.actorId)?.getFlag?.(MODULE_ID, "flavorName"),
            ]) {
                const clean = (n || "").trim().toLowerCase();
                if (clean) takenNames.add(clean);
            }
        }
    } catch (err) { console.warn(`${TAG} | Name dedup scene scan failed:`, err); }

    const nameMatch = bioText.slice(0, 400).match(/(?:^|\n)\s*(?:```\w*\s*)?NAME:\s*(.+?)(?:\r?\n|$)/i);
    if (nameMatch) {
        const name = tokenDocument.actor?.name || "";
        const creatureType = tokenDocument.actor?.system?.details?.type?.value || "";
        const NO_RENAME = new Set(["beast", "ooze", "plant", "swarm"]);
        if (!NO_RENAME.has((creatureType || "").toLowerCase()) && _isGenericName(name, creatureType) && !tokenDocument._aceSkipRename) {
            let candidate = nameMatch[1].trim()
                .replace(/^["']+|["']+$/g, "")  // strip quotes
                .replace(/\*+/g, "")             // strip markdown bold
                .trim();

            if (takenNames.has(candidate.toLowerCase())) {
                // Name collision — append a distinguishing suffix that is itself
                // FREE (a 15-goblin scene can collide repeatedly; random retry
                // could land on an already-taken suffix). Numbered fallback if
                // all seven are burned.
                const suffixes = ["the Bold", "the Elder", "the Younger", "the Scarred", "the Silent", "the Red", "the Pale"];
                const free = suffixes.find(s => !takenNames.has(`${candidate} ${s}`.toLowerCase()));
                candidate = free ? `${candidate} ${free}`
                    : `${candidate} ${2 + suffixes.filter(s => takenNames.has(`${candidate} ${s}`.toLowerCase())).length}`;
                console.warn(`${TAG} | Duplicate name detected — renamed to "${candidate}"`);
            }

            generatedName = candidate;
        }
        bioText = bioText.slice(nameMatch[0].length).trim();
    } else {
        // ── Fallback: AI didn't produce a NAME: line for a generic NPC ──
        // The AI is supposed to start its response with "NAME: Firstname Lastname"
        // but gpt-4o-mini routinely buries the personal name mid-bio:
        //   "This goblin hails from the Amberfang Tribe… Griknik grew up…"
        // The old fallback only looked at the FIRST SENTENCE — which here
        // starts with "This goblin", so it extracted "This" and either
        // produced a garbage rename or no rename at all.
        //
        // New approach: scan the WHOLE bio for proper-noun candidates,
        // prefer ones in subject position (followed by an action verb),
        // and fall back to most-frequent capitalized word. Reject common
        // false positives (pronouns, articles, the generic creature name).
        const actorName = tokenDocument.actor?.name || "";
        const creatureType = tokenDocument.actor?.system?.details?.type?.value || "";
        if (_isGenericName(actorName, creatureType) && !tokenDocument._aceSkipRename) {
            const NO_RENAME = new Set(["beast", "ooze", "plant", "swarm"]);
            if (!NO_RENAME.has((creatureType || "").toLowerCase())) {
                const REJECT = new Set([
                    "this", "that", "these", "those", "the", "a", "an", "in", "on", "at",
                    "for", "with", "and", "but", "or", "if", "when", "where", "how", "why",
                    "who", "what", "it", "he", "she", "they", "we", "you", "i", "his", "her",
                    "their", "its", "him", "them", "us", "as", "by", "of", "to", "from",
                    "before", "after", "during", "biography", "name", "personality", "tone",
                    "while", "though", "although", "however", "despite", "since", "until",
                    "currently", "presently", "today", "now", "later", "soon", "haunted",
                    "nervous", "stoic", "casual", "formal", "cryptic", "cheerful", "grim",
                ]);
                const genericBase = actorName
                    .replace(/\s*[#]?\s*\d+\s*$/, "")
                    .replace(/\s*\([^)]*\)\s*/g, "")
                    .trim().toLowerCase();
                const isCandidate = (s) => {
                    const lower = s.toLowerCase();
                    if (REJECT.has(lower)) return false;
                    if (lower === genericBase) return false;
                    if (genericBase && (lower.startsWith(genericBase + " ") || genericBase.includes(lower))) return false;
                    // Never adopt a name ANY scene creature already wears (real OR
                    // flavor) — the proper-noun scan otherwise plucks a scene-mate's
                    // name straight out of the bio text (the Grulgar bug, 2026-07-26).
                    if (takenNames.has(lower)) return false;
                    return true;
                };

                // Strip any HTML in case it slipped in, collapse whitespace
                const plainText = bioText.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

                // Pass 1: high-confidence — proper noun followed by a biographical verb
                const subjectRe = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+){0,2})\s+(?:is|was|grew|hails|came|comes|lived|fled|joined|left|escaped|served|rose|rises|fell|fights|fought|leads|led|seeks|sought|wields|wielded|carries|carried|guards|guarded|hunts|hunted|stalks|stalked|wanders|wandered|believes|believed|knows|knew|remembers|remembered|earned|earns|spent|spends|holds|held|trained|trains|once|now|still)\b/g;
                // Pass 2: any 1-3 word proper noun anywhere
                const properNounRe = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+){0,2})\b/g;

                const collect = (re) => {
                    const counts = new Map();
                    for (const m of plainText.matchAll(re)) {
                        const w = m[1].trim();
                        if (!isCandidate(w)) continue;
                        counts.set(w, (counts.get(w) ?? 0) + 1);
                    }
                    return counts;
                };

                const subjectHits = collect(subjectRe);
                const allHits = subjectHits.size ? subjectHits : collect(properNounRe);

                if (allHits.size) {
                    // Most-frequent candidate wins; ties broken by length (longer = more specific)
                    const best = [...allHits.entries()]
                        .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
                    generatedName = best;
                    console.log(`${TAG} | Extracted name "${best}" from bio text via proper-noun scan (AI skipped NAME: line; subject-pass=${subjectHits.size > 0})`);
                }
            }
        }
    }

    // Extract PERSONALITY: line if present — save as the NPC's personality flag
    const personalityMatch = bioText.match(/\n\s*PERSONALITY:\s*(.+?)(?:\n|$)/i);
    if (personalityMatch) {
        generatedPersonality = personalityMatch[1].trim();
        // Remove from bio text so it doesn't appear in the biography HTML
        bioText = bioText.replace(personalityMatch[0], "").trim();
    }

    // Extract TONE: line if present — save as the NPC's tone flag
    const VALID_TONES = ["formal", "casual", "cryptic", "cheerful", "grim", "sarcastic", "threatening", "nervous", "stoic", "theatrical"];
    const toneMatch = bioText.match(/\n\s*TONE:\s*(.+?)(?:\n|$)/i);
    let generatedTone = "";
    if (toneMatch) {
        const raw = toneMatch[1].trim().toLowerCase();
        generatedTone = VALID_TONES.includes(raw) ? raw : "";
        bioText = bioText.replace(toneMatch[0], "").trim();
    }

    // Wrap in a marked section so we can identify/replace it later
    // HTML-escape AI output before injection to prevent XSS
    const safeBio = bioText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    // Build "Previously seen in:" footer if this NPC has travel history
    const bioHistory = actor.getFlag(MODULE_ID, "bioHistory") || [];
    let historyFooter = "";
    if (bioHistory.length > 0) {
        const locations = bioHistory.map(h => h.sceneName).join(" • ");
        historyFooter = `<p class="ace-bio-history"><em>Previously seen in: ${locations}</em></p>`;
    }

    const htmlBio = `<section class="ace-engine-bio"><div class="ace-bio-header"><span>ACE: Biography</span></div><p>${safeBio.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>${historyFooter}</section>`;

    // ── Store the biography — PREPEND, preserving existing content ─────
    // Existing content (disclaimers, OGL notices, etc.) is kept below our section.
    // If a previous ace-engine-bio section exists (regeneration), replace only that.
    const existingBio = actor.system?.details?.biography?.value || "";
    const cleanedExisting = existingBio
        .replace(/<section class="ace-engine-bio">[\s\S]*?<\/section>/gi, "")
        .trim();
    const finalBio = cleanedExisting
        ? `${htmlBio}\n<hr>\n${cleanedExisting}`
        : htmlBio;

    if (isUnlinked) {
        // Unlinked: write to token's ActorDelta (visible on token's sheet).
        // Serialized via bio-writer so concurrent generates / manual edits
        // don't last-writer-wins each other (v1.6.3).
        await writeBiography(tokenDocument.actor, finalBio, "bio-generator:unlinked");
        await tokenDocument.setFlag(MODULE_ID, "bioGenerated", true);
        await tokenDocument.setFlag(MODULE_ID, "bioSceneId", canvas.scene?.id || "");
        await tokenDocument.setFlag(MODULE_ID, "bioSceneName", canvas.scene?.name || "");

        // FLAVOR NAME — store as a DISPLAY-ONLY flag; NEVER overwrite the real token
        // name. Mechanics (spell pipeline, features, creature-type detection) read the
        // name as IDENTITY — renaming "Skeleton Warrior" → "Strix" broke them. We keep
        // the canonical name, keep the nameplate visible, and store the flavor in a flag
        // (a refreshToken hook paints it on the nameplate for immersion).
        if (generatedName) {
            await tokenDocument.update({ displayName: 50 }); // 50 = ALWAYS show nameplate (real name kept)
            await tokenDocument.actor.setFlag(MODULE_ID, "flavorName", generatedName).catch(() => {});
            await tokenDocument.actor.setFlag(MODULE_ID, "nameRevealed", true).catch(() => {});
            console.log(`${TAG} | Flavor name stored (display-only): "${generatedName}" — real name kept as "${tokenDocument.name}"`);
        }

        // Save personality to actor flag (shown in AI Setup dialog)
        if (generatedPersonality) {
            await tokenDocument.actor.setFlag(MODULE_ID, "personality", generatedPersonality).catch(() => {});
            console.log(`${TAG} | Personality saved for ${generatedName || actor.name}: "${generatedPersonality}"`);
        }
        if (generatedTone) {
            await tokenDocument.actor.setFlag(MODULE_ID, "tone", generatedTone).catch(() => {});
            console.log(`${TAG} | Tone saved for ${generatedName || actor.name}: "${generatedTone}"`);
        }

        console.log(`${TAG} | Bio saved to token ActorDelta for ${generatedName || actor.name}.`);
    } else {
        // Linked: archive old bio summary to history before overwriting
        try {
            const oldBioHtml = existingBio.match(/<section class="ace-engine-bio">([\s\S]*?)<\/section>/i)?.[1] || "";
            const oldBioText = oldBioHtml.replace(/<[^>]*>/g, "").trim();
            const oldSceneId = actor.getFlag(MODULE_ID, "bioSceneId") || "";
            if (oldBioText.length > 30 && oldSceneId) {
                // Build a 1-2 sentence summary from the old bio (first ~200 chars)
                const oldSceneName = actor.getFlag(MODULE_ID, "bioSceneName") || "Unknown location";
                const summary = oldBioText.slice(0, 200).replace(/\s+\S*$/, "…");
                const history = actor.getFlag(MODULE_ID, "bioHistory") || [];
                history.push({
                    sceneId:   oldSceneId,
                    sceneName: oldSceneName,
                    summary,
                    timestamp: Date.now()
                });
                // Keep last 10 entries max
                if (history.length > 10) history.splice(0, history.length - 10);
                await actor.setFlag(MODULE_ID, "bioHistory", history);
                console.log(`${TAG} | Archived previous bio for ${actor.name} (scene: ${oldSceneName}).`);
            }
        } catch (e) { console.warn(`${TAG} | Failed to archive bio history:`, e); }

        // Write to the base actor's biography — serialized via bio-writer
        // so concurrent regenerates / story-note appends / manual edits
        // don't last-writer-wins each other (v1.6.3).
        await writeBiography(actor, finalBio, "bio-generator:linked");
        await actor.setFlag(MODULE_ID, "bioGenerated", true);
        await actor.setFlag(MODULE_ID, "bioSceneId", canvas.scene?.id || "");
        await actor.setFlag(MODULE_ID, "bioSceneName", canvas.scene?.name || "");

        // ── FLAVOR NAME (display-only) — NEVER overwrite the real actor/token name ──
        // The bio generator produces a flavor name (e.g. "Aldric Thorne" for a Death
        // Knight). It must NOT replace the real name: the spell pipeline, features, and
        // creature-type detection read the name as IDENTITY, so renaming broke undead
        // mechanics — and on a LINKED actor it corrupted EVERY instance. We keep the
        // canonical name and store the flavor in a flag (a refreshToken hook paints it
        // on the nameplate for immersion). [2026-06-29 — identity-stability fix.]
        if (generatedName && generatedName !== actor.name) {
            try {
                // ── A NAMED, LINKED NPC IS RENAMED FOR REAL (2026-08-06) ──────
                // Johnny: "what if I'm looking for an Ogre that they talked to…
                // five sessions later I want to find that same Ogre. It's got to
                // be named whatever name was given to it in the actor sidebar."
                // He is right: a linked actor IS its own sidebar row, and a row
                // called "Ogre" is unfindable a month later.
                //
                // ⚠️ WHY THIS IS NOW SAFE, when 2026-06-29 banned it. Back then
                // mechanics read the actor NAME as identity, so renaming broke
                // undead behaviour. The July species-tag work moved every engine
                // onto system.details.type — verified 2026-08-06: nothing in
                // ace-qol or ace-engine infers creature KIND from an actor name
                // any more (every name.includes() hit is an ITEM or EFFECT name).
                //
                // ⚠️ LINKED ONLY. An unlinked token shares its base actor with
                // every other token from it — renaming that would rename all
                // eight goblins at once. The unlinked branch above keeps the
                // display-only flag, which is correct: those have no sidebar row
                // to find in the first place.
                //
                // ⚠️ ONLY WHEN THE NAME IS STILL A SPECIES LABEL. "Ogre" gets
                // renamed; "Thalgar Stonehide" — named by the GM or by an earlier
                // run — is left alone. That makes this idempotent and means a
                // GM who renames something back is never overruled.
                const _species = resolveSpecies(actor, tokenDocument ?? null);
                const _isLabel = !hasPersonalName(actor.name, _species);

                if (_isLabel) {
                    // Keep what it WAS, so the sidebar search can still find it
                    // by species/statblock name once the row says "Thalgar".
                    await actor.setFlag(MODULE_ID, "originalName", actor.name);
                    if (_species) await actor.setFlag(MODULE_ID, "species", _species);
                    await actor.setFlag(MODULE_ID, "nameRevealed", true);

                    // The real name IS the name now, so the display-only flavour
                    // flag would just double up on the nameplate. Clear it.
                    await actor.unsetFlag(MODULE_ID, "flavorName").catch(() => {});

                    // prototypeToken too, so tokens placed later carry the name
                    // instead of reverting to the statblock label.
                    await actor.update({ name: generatedName, "prototypeToken.name": generatedName });
                    if (tokenDocument && tokenDocument !== actor) {
                        try { await tokenDocument.update({ name: generatedName, displayName: 50 }); }
                        catch (tokErr) { console.warn(`${TAG} | Token rename failed (non-fatal):`, tokErr); }
                    }
                    console.log(`${TAG} | Linked actor RENAMED "${actor.name}" → "${generatedName}" (was a ${_species || "generic"} label; searchable by "${_species}" and the original name).`);
                } else {
                    // Already personally named — never overwrite the GM's choice.
                    await actor.setFlag(MODULE_ID, "flavorName", generatedName);
                    await actor.setFlag(MODULE_ID, "nameRevealed", true);
                    console.log(`${TAG} | Flavor name stored (display-only): "${generatedName}" — real name kept as "${actor.name}" (already a personal name).`);
                    if (tokenDocument && tokenDocument !== actor) {
                        try { await tokenDocument.update({ displayName: 50 }); }   // keep nameplate visible
                        catch (tokErr) { console.warn(`${TAG} | Nameplate visibility update failed (non-fatal):`, tokErr); }
                    }
                }
            } catch (flavorErr) {
                console.warn(`${TAG} | Naming failed (non-fatal — bio still saved):`, flavorErr);
            }
        }

        // Save personality to actor flag (shown in AI Setup dialog)
        if (generatedPersonality) {
            await actor.setFlag(MODULE_ID, "personality", generatedPersonality).catch(() => {});
            console.log(`${TAG} | Personality saved for ${actor.name}: "${generatedPersonality}"`);
        }
        if (generatedTone) {
            await actor.setFlag(MODULE_ID, "tone", generatedTone).catch(() => {});
            console.log(`${TAG} | Tone saved for ${actor.name}: "${generatedTone}"`);
        }

        console.log(`${TAG} | Bio saved to actor sheet for ${actor.name}.`);
    }

    // ── Post-bio gender re-check: if bio reveals gender, update voice ──
    // The voice engine runs before bio generation, so it may have guessed wrong.
    // Now that the bio has pronouns, re-detect and reassign if different.
    try {
        // voice-engine lives next to bio-generator in /npc/ and is .mjs.
        // Was: "../voice-engine.js" (wrong dir AND wrong extension), which
        // failed silently with "Failed to fetch dynamically imported module".
        const { detectGender, assignVoice } = await import("./voice-engine.mjs");
        const bioGender = detectGender(isUnlinked ? tokenDocument.actor : actor);
        const currentGender = (isUnlinked ? tokenDocument.actor : actor).getFlag(MODULE_ID, "voiceGender") || "";
        if (bioGender && bioGender !== currentGender) {
            console.log(`${TAG} | Gender mismatch detected: voice=${currentGender}, bio=${bioGender} → reassigning voice`);
            const target = isUnlinked ? tokenDocument.actor : actor;
            // Preserve existing accent — only the gender changed, not the accent
            const existingAccent = target.getFlag(MODULE_ID, "voiceAccent") || undefined;
            const result = await assignVoice(target, bioGender, existingAccent);
            if (result) {
                await target.update({
                    "flags.ace-engine.voiceId":       result.voiceId,
                    "flags.ace-engine.voiceSettings":  result.voiceSettings,
                    "flags.ace-engine.voiceAccent":    result.accent,
                    "flags.ace-engine.voiceGender":    bioGender,
                });
                console.log(`${TAG} | Voice reassigned for ${generatedName || actor.name}: ${result.voiceId} (${bioGender}/${result.accent})`);
            }
        }
    } catch (e) {
        console.warn(`${TAG} | Post-bio gender re-check failed (non-fatal):`, e);
    }

    // ── Auto-link: convert unlinked token to persistent linked actor ────
    if (isUnlinked && tokenDocument._aceAutoLink) {
        try {
            await _autoLinkToken(tokenDocument, generatedName);
        } catch (e) {
            console.warn(`${TAG} | Auto-link failed for ${generatedName || actor.name} (non-fatal):`, e);
        }
    }

    // ── Item bios + loot, then shimmer when fully complete ──────────────
    _generateItemBios(tokenDocument)
        .then(() => _lootThenRealLoot(tokenDocument))
        .then(() => _playShimmer(tokenDocument))
        .catch(err =>
            console.warn(`${TAG} | Item bio / loot generation failed for ${actor.name}:`, err)
        );
}

// ─── ITEM BIO GENERATION ─────────────────────────────────────────────────────
// After NPC bio is done, scan inventory for notable items and generate
// 2-3 sentence backstories in a single batched AI call.

/** Item types worth generating backstories for. */
const NOTABLE_ITEM_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot"]);

/** Skip these mundane items — not worth a backstory. */
const MUNDANE_SKIP = /^(torch|rations|rope|waterskin|bedroll|backpack|pouch|arrows?|bolts?|sling bullets?|darts?|component pouch|mess kit|tinderbox|pitons?|crowbar|hammer|chain|manacles|ink|paper|parchment|sealing wax|soap|mirror|candle|chalk|common clothes|traveler.s clothes|costume clothes|ladder|tent|blanket)$/i;

/** Natural/innate attacks — body parts, not lootable items.
 *  Uses CONTAINS match (no ^ $ anchors) so "Poisonous Bite" catches on "bite",
 *  "Tail Stinger" catches on "tail" AND "stinger", etc.
 *  Covers: MM natural weapons, breath weapons, gaze attacks, touch/drain,
 *  spore/aura abilities, multiattack, and body-slam variants. */
const NATURAL_WEAPON_SKIP = /\b(bite|claws?|slam|slap|tail|gore|tentacles?|horns?|hooves?|hoof|talons?|pincers?|stingers?|sting|beak|fists?|rocks?|spit|breath|web|constrict|swallow|engulf|pseudopod|appendage|ram|tusks?|antlers?|maw|mandibles?|proboscis|spines?|quills?|wings?\s*(?:attack|buffet)?|tendrils?|trunk|tongue|stomp|trample|rend|lash|barb|crush|coil|gaze|glare|touch|drain|grasp|embrace|spores?|mucus|aura|frightful|multiattack|shriek|wail|howl|roar|pounce|swoop|headbutt|boulder|smash|bash|limb|chill|eye\s*rays?)\b/i;

/**
 * Generate backstories for notable items in an NPC's inventory.
 * Called automatically after NPC bio generation completes.
 * @param {TokenDocument} tokenDocument
 */
// ─── AUTO-LINK: Convert unlinked token to persistent linked actor ────────────
async function _autoLinkToken(tokenDocument, generatedName) {
    const actor = tokenDocument.actor;
    if (!actor || tokenDocument.actorLink) return; // already linked

    // ── UNIQUE-NAME GUARD ──────────────────────────────────────────────
    // The "Boris moment" vision is built on each persistent NPC having a
    // unique AI-generated name (Throx, Marek, etc.). If the bio step
    // didn't produce one — because the AI returned generic output, or
    // because the creature is a non-sentient type that intentionally
    // skips renaming (beast/ooze/plant/swarm) — we should NOT persist
    // the actor. Otherwise we end up with a graveyard of "Goblin",
    // "Goblin (2)", "Black Pudding (3)" entries that pollute the
    // sidebar without delivering the recurring-character benefit.
    const baseName = actor.name?.trim() ?? "";
    const cleanGenerated = (generatedName || "").trim();
    if (!cleanGenerated || cleanGenerated.toLowerCase() === baseName.toLowerCase()) {
        console.log(`${TAG} | Skipping auto-link for "${baseName}" — no unique AI name was generated (generic NPC, not worth persisting).`);
        return;
    }
    const npcName = cleanGenerated;

    // ── Derive folder name from scene's folder hierarchy ──
    // Walks up the scene folder tree to build a meaningful location path.
    // Example: "Beneos: Curse of Strahd" / "Ch. 8: Abbey of St. Markovia" → "Curse of Strahd / Abbey of St. Markovia"
    let adventureName = "";
    let locationName = "";
    try {
        const folders = [];
        let f = canvas.scene?.folder;
        while (f) { folders.unshift(f); f = f.folder; }
        // Depth 1 = adventure name, Depth 2 = location name
        if (folders.length >= 2) {
            adventureName = folders[0].name
                .replace(/^[A-Za-z]+:\s*/, "")          // strip "Beneos: " or similar prefix
                .trim();
            locationName = folders[1].name
                .replace(/^Ch\.\s*\d+:\s*/i, "")        // strip "Ch. 8: " prefix
                .replace(/^Chapter\s*\d+:\s*/i, "")      // strip "Chapter 8: " prefix
                .trim();
        } else if (folders.length === 1) {
            locationName = folders[0].name
                .replace(/^[A-Za-z]+:\s*/, "")
                .replace(/^Ch\.\s*\d+:\s*/i, "")
                .trim();
        }
    } catch (err) { console.debug("ACE: Engine | bio-generator auto-link folder resolution non-fatal:", err); }

    // Build the folder path: "Adventure / Location" or just "Location" or scene name as fallback
    const folderPath = adventureName && locationName
        ? `${adventureName} / ${locationName}`
        : locationName || adventureName || canvas.scene?.name || "ACE NPCs";

    console.log(`${TAG} | Auto-linking ${npcName} as persistent actor in "${folderPath}" folder...`);

    // ── Find or create the location folder ──
    // V12+ uses `folder:` for the parent-folder field on the Folder data
    // schema. Earlier versions used `parent:` which is now silently dropped
    // by the validator — caused location subfolders to be created as
    // root-level orphans instead of nested under "ACE NPCs". Use the
    // correct field. (Same gotcha is documented in activate.mjs for the
    // ☠ Fallen folder helper.)
    let folder = game.folders?.find(f => f.name === folderPath && f.type === "Actor");
    if (!folder) {
        // Find or create a parent "ACE NPCs" folder
        let parentFolder = game.folders?.find(f => f.name === "ACE NPCs" && f.type === "Actor");
        if (!parentFolder) {
            parentFolder = await Folder.create({ name: "ACE NPCs", type: "Actor", folder: null });
            console.log(`${TAG} | Created parent folder: ACE NPCs`);
        }
        // If folderPath happens to match the parent name (e.g. fallback to
        // "ACE NPCs" when no scene info), reuse the parent — don't nest
        // "ACE NPCs" inside "ACE NPCs".
        if (folderPath === "ACE NPCs") {
            folder = parentFolder;
        } else {
            folder = await Folder.create({ name: folderPath, type: "Actor", folder: parentFolder.id });
            console.log(`${TAG} | Created location folder: "${folderPath}" inside "ACE NPCs"`);
        }
    }

    // ── Gather all data from the synthetic actor (bio, flags, items) ──
    const syntheticActor = tokenDocument.actor;
    const mergedFlags = foundry.utils.deepClone(syntheticActor.flags ?? {});
    // Tag this actor as ACE auto-linked so the cleanup API can find these
    // later. Also record the original base creature name and the path it
    // was filed under for debugging / future migrations.
    mergedFlags[MODULE_ID] = {
        ...(mergedFlags[MODULE_ID] ?? {}),
        autoLinked: true,
        autoLinkedAt: new Date().toISOString(),
        autoLinkedFrom: baseName,
        autoLinkedFolder: folderPath,
        // IDENTITY RULE (Johnny 2026-07-10, final): the AI name is DISPLAY-
        // ONLY on every path — linked included. The nameplate hook renders
        // this flag; the sheet/actor/token names stay the creature.
        flavorName: npcName,
    };

    const actorData = {
        // IDENTITY RULE (Johnny 2026-07-10 17:56, overruling the old opt-in
        // rename): the REAL name stays the creature ("Hydra") on the sheet,
        // the actor, and the token — linked or not. Mechanics read identity;
        // renaming it broke game rules in play. The AI name ("Strix") lives
        // in the flavorName flag and shows on the nameplate only.
        name: baseName,
        type: "npc",
        img: syntheticActor.img,
        system: foundry.utils.deepClone(syntheticActor.system),
        prototypeToken: {
            ...foundry.utils.deepClone(syntheticActor.prototypeToken ?? {}),
            name: baseName,
            actorLink: true,
            disposition: tokenDocument.disposition ?? CONST.TOKEN_DISPOSITIONS.HOSTILE,
            texture: { src: tokenDocument.texture?.src || syntheticActor.prototypeToken?.texture?.src },
        },
        folder: folder.id,
        flags: mergedFlags,
    };

    // ── Create the new world actor ──
    const newActor = await Actor.create(actorData);
    if (!newActor) {
        console.error(`${TAG} | Failed to create actor for ${npcName}`);
        return;
    }

    // ── Clone items from the synthetic actor to the new actor ──
    const items = syntheticActor.items?.map(i => i.toObject()) ?? [];
    if (items.length) {
        await newActor.createEmbeddedDocuments("Item", items);
    }

    // ── Update the token on the canvas to point to the new linked actor ──
    await tokenDocument.update({
        actorId: newActor.id,
        actorLink: true,
        name: baseName,   // identity on the token; flavor renders via the nameplate hook
    });

    console.log(`${TAG} | ✅ Auto-linked: "${npcName}" (${baseName}) → Actor ID ${newActor.id} (folder: "${folderPath}") — sheet name stays "${baseName}"`);
    ui.notifications?.info(`ACE: ${npcName} (${baseName}) saved as persistent NPC in "${folderPath}".`);
}

async function _generateItemBios(tokenDocument) {
    const actor = tokenDocument.actor;
    if (!actor) return;

    // Collect notable items that don't already have a backstory
    const items = [];
    for (const item of actor.items) {
        if (!NOTABLE_ITEM_TYPES.has(item.type)) continue;
        if (MUNDANE_SKIP.test(item.name)) continue;
        if (NATURAL_WEAPON_SKIP.test(item.name)) continue;

        // Skip natural/innate weapons (D&D 5e marks these with weaponType "natural")
        const wepType = item.system?.type?.value || item.system?.weaponType || "";
        if (wepType === "natural") continue;

        // Skip if we already wrote an item bio
        const desc = item.system?.description?.value || "";
        if (desc.includes('class="ace-engine-item-bio"')) continue;

        items.push(item);
    }

    if (!items.length) {
        console.log(`${TAG} | No notable items to generate bios for on ${actor.name}.`);
        return;
    }

    // Cap at 6 items per NPC to keep the AI call reasonable
    const batch = items.slice(0, 6);
    console.log(`${TAG} | Generating item bios for ${batch.length} item(s) on ${actor.name}...`);

    // ── Build a single batched prompt ────────────────────────────────────
    const npcBio = actor.system?.details?.biography?.value || "";
    const npcBioPlain = npcBio.replace(/<[^>]*>/g, "").trim().slice(0, 400);
    const sceneName = canvas.scene?.name || "an unknown location";

    const itemList = batch.map((item, i) => {
        const rarity = item.system?.rarity || "common";
        const type = item.type;
        const price = item.system?.price?.value
            ? `${item.system.price.value} ${item.system.price.denomination || "gp"}`
            : "";
        return `${i + 1}. "${item.name}" — ${type}${rarity !== "common" ? `, ${rarity}` : ""}${price ? `, worth ~${price}` : ""}`;
    }).join("\n");

    // Use the token's display name (may have been renamed by bio generator)
    const npcName = tokenDocument.name || actor.name;

    const systemPrompt = `You are a D&D 5e item lore generator for a tabletop RPG.
Generate SHORT backstories for items carried by an NPC. Each backstory should be exactly 2-3 sentences.
Cover: who made or previously owned it, how the NPC got it, and one evocative detail.
Tie the item's history to the NPC's story and location when possible.
Write in third person. No stat blocks or game mechanics.
IMPORTANT: The NPC's name is "${npcName}" — use EXACTLY this name when referring to them. Do NOT invent a different name.
Do NOT number the items. Use this exact format for each:

ITEM: [exact item name]
[2-3 sentence backstory]

Separate each item with a blank line.`;

    const userMsg = `NPC: ${npcName}
Location: ${sceneName}
NPC Background: ${npcBioPlain || "No background available."}

Generate backstories for these items:
${itemList}`;

    // ── Call AI ──────────────────────────────────────────────────────────
    const { provider, apiKey } = getEnvoyAIConfig();
    const response = await AIHandler.callAI(systemPrompt, [], userMsg, provider, apiKey, [], { context: "item-descriptions" });

    if (isAIFailure(response)) return;   // GM already notified — never persist a failure marker
    if (!response) {
        console.warn(`${TAG} | AI returned no item bios for ${actor.name}.`);
        return;
    }

    // ── Parse response — extract ITEM: blocks ───────────────────────────
    // Split on ITEM: whether it appears at start-of-string or after a newline.
    // Any preamble text before the first ITEM: becomes an empty/junk first element
    // that harmlessly fails the fuzzy match below.
    const blocks = response.split(/(?:^|\n)ITEM:\s*/i).filter(b => b.trim());

    let written = 0;
    for (const block of blocks) {
        const lines = block.trim().split("\n");
        const itemName = lines[0].trim().replace(/^["']|["']$/g, "");
        const lore = lines.slice(1).join(" ").trim();
        if (!itemName || !lore || lore.length < 15) continue;

        // Find the matching item (fuzzy name match)
        const item = batch.find(i =>
            i.name.toLowerCase() === itemName.toLowerCase() ||
            itemName.toLowerCase().includes(i.name.toLowerCase()) ||
            i.name.toLowerCase().includes(itemName.toLowerCase())
        );
        if (!item) {
            console.log(`${TAG} | Could not match item bio for "${itemName}" — skipping.`);
            continue;
        }

        // Prepend the lore as a marked section (HTML-escape AI output to prevent XSS)
        const safeLore = lore.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const htmlLore = `<section class="ace-engine-item-bio"><em>${safeLore.replace(/\n/g, " ")}</em></section>`;
        const existingDesc = item.system?.description?.value || "";
        const finalDesc = existingDesc ? `${htmlLore}\n<hr>\n${existingDesc}` : htmlLore;

        await item.update({ "system.description.value": finalDesc });
        written++;
        console.log(`${TAG} | Item bio written for "${item.name}".`);
    }

    if (written) {
        console.log(`${TAG} | ${written} item bio(s) generated for ${actor.name}.`);
    }
}

// ─── LOOT GENERATION ─────────────────────────────────────────────────────────
// After NPC bio + item bios, generate contextual loot (coins, trinkets, gems,
// personal effects) based on CR, creature type, and NPC backstory.
// Items are created as real Foundry items in the NPC's inventory.

/** Creature types that never carry loot — no hands, no pockets, no intent.
 *  Beast is handled separately below (pack animals + messenger birds get loot). */
const NO_LOOT_TYPES = new Set(["ooze", "plant"]);

/** Pack animals — beasts that carry saddlebags, cargo, or rider possessions.
 *  These get loot styled as "found in saddlebags" or "strapped to the saddle." */
const PACK_ANIMAL_NAMES = /^(horse|warhorse|riding horse|draft horse|pony|mule|donkey|camel|elephant|mammoth|giant lizard|axe beak)/i;

/** Messenger animals — beasts that may carry a message tied to a leg or collar. */
const MESSENGER_NAMES = /^(raven|hawk|blood hawk|eagle|owl|pigeon|falcon|parrot|pseudodragon)/i;

/** Loot tier by CR range. */
function _getLootTier(cr) {
    const n = Number(cr) || 0;
    if (n <= 1)  return "low";
    if (n <= 4)  return "mid";
    if (n <= 10) return "high";
    return "elite";
}

/** Chance of generating any loot at all, by tier. Johnny 2026-07-11: "things
 *  shouldn't drop that much" — a random goblin usually has nothing worth taking,
 *  while a named boss always carries something. Graduated by CR so low-CR mooks
 *  frequently carry NOTHING (variety + less trinket clutter) and elites always
 *  do. Tunable if the table wants richer/leaner drops. */
const LOOT_CHANCE = { low: 0.35, mid: 0.55, high: 0.80, elite: 1.0 };

/**
 * Generate contextual loot for an NPC and add it to their inventory.
 * Called after bio + item bio generation completes.
 * @param {TokenDocument} tokenDocument
 */
async function _generateLoot(tokenDocument, opts = {}) {
    const actor = tokenDocument.actor;
    if (!actor) return;
    // Shared budget already full (real-first elite path) — no flavor items/coins.
    if (opts.maxItems === 0) return;

    // Already generated loot? (guard flag)
    const flagTarget = tokenDocument.actorLink ? actor : tokenDocument;
    if (flagTarget.getFlag(MODULE_ID, "lootGenerated")) return;

    // ── Creature type + intelligence loot filter ──────────────────────────
    // The question: "Does this creature have hands, pockets, or intent to carry things?"
    //   Humanoid, Undead, Fiend, Celestial, Fey, Giant, Dragon → YES (carried/worn items)
    //   Ooze, Plant, Beast → NEVER (no hands, no intent)
    //   Monstrosity → depends on INT (yuan-ti INT 14 = yes, death dog INT 3 = no)
    //   Construct → depends on INT (shield guardian INT 4 = no, some golems = no)
    //   Aberration → depends on INT (mind flayer INT 19 = yes, gibbering mouther INT 3 = no)
    const creatureType = (actor.system?.details?.type?.value || "").toLowerCase();
    if (NO_LOOT_TYPES.has(creatureType)) {
        console.log(`${TAG} | No loot for ${actor.name} — ${creatureType} type (no hands/pockets).`);
        return;
    }

    const intScore = actor.system?.abilities?.int?.value ?? 10;
    const actorName = actor.name || "";

    // ── Beasts: usually no loot, but pack animals + messenger birds are exceptions ──
    if (creatureType === "beast") {
        if (PACK_ANIMAL_NAMES.test(actorName)) {
            console.log(`${TAG} | ${actor.name} is a pack animal — generating saddlebag/cargo loot.`);
            // Falls through to loot generation with creature-type prompt context
        } else if (MESSENGER_NAMES.test(actorName)) {
            console.log(`${TAG} | ${actor.name} is a messenger animal — may carry a message.`);
            // Falls through to loot generation with creature-type prompt context
        } else {
            console.log(`${TAG} | No loot for ${actor.name} — beast with no carrying capacity.`);
            return;
        }
    }

    // Monstrosities with animal-level intelligence don't carry items
    // (death dog INT 3, basilisk INT 2, owlbear INT 3)
    // But intelligent monstrosities DO (yuan-ti INT 14, medusa INT 12, lamia INT 14)
    if (creatureType === "monstrosity" && intScore <= 5) {
        console.log(`${TAG} | No loot for ${actor.name} — low-intelligence monstrosity (INT ${intScore}).`);
        return;
    }

    // Constructs with INT ≤ 5 don't carry loot (flying swords, animated armor, shield guardians)
    if (creatureType === "construct" && intScore <= 5) {
        console.log(`${TAG} | No loot for ${actor.name} — mindless construct (INT ${intScore}).`);
        return;
    }

    // Aberrations with INT ≤ 5 don't carry loot (gibbering mouther, otyugh)
    if (creatureType === "aberration" && intScore <= 5) {
        console.log(`${TAG} | No loot for ${actor.name} — mindless aberration (INT ${intScore}).`);
        return;
    }

    // Roll for loot chance
    const cr = actor.system?.details?.cr ?? 0;
    const tier = _getLootTier(cr);
    const chance = LOOT_CHANCE[tier];
    // opts.forceLoot: the shared roll in _lootThenRealLoot already passed, so
    // don't roll the chance a second time (that would double-gate and make loot
    // far rarer than the tier chance intends).
    if (!opts.forceLoot && Math.random() > chance) {
        console.log(`${TAG} | ${actor.name} has no loot this time (${Math.round(chance * 100)}% chance, missed).`);
        await flagTarget.setFlag(MODULE_ID, "lootGenerated", true).catch(() => {});
        return;
    }

    console.log(`${TAG} | Generating loot for ${actor.name} (CR ${cr}, tier: ${tier})...`);

    // ── Build AI prompt ──────────────────────────────────────────────────
    const npcName = tokenDocument.name || actor.name;
    const npcBio = actor.system?.details?.biography?.value || "";
    const npcBioPlain = npcBio.replace(/<[^>]*>/g, "").trim().slice(0, 300);
    const sceneName = canvas.scene?.name || "an unknown location";
    const creatureSubtype = actor.system?.details?.type?.subtype || "";

    const tierInstructions = {
        low: `This is a LOW-tier creature (CR 0-1). Generate 1-2 items max.
Coins: 1d12 copper, maybe 1d4 silver.
Items should be PERSONAL and MUNDANE — things a real person carries in their pockets or belt pouch. NO magic items. NO potions. NO scrolls. NO gems. NO jewelry.
VARIETY IS CRITICAL — pick from categories like these, but choose what fits THIS specific NPC's background:
• Food/drink: a half-eaten bread roll, a waterskin, a pouch of dried herbs, a flask of cheap wine, a wrapped piece of cheese
• Tools of trade: a whittling knife, a ball of twine, a fishing hook, a sewing needle and thread, a tinderbox, a piece of chalk
• Personal effects: a carved wooden token, a child's toy, a pressed flower, a lock of hair tied with ribbon, a love letter, a tattered prayer card
• Junk/scavenged: a bent fork, a cracked hand mirror, a smooth river stone, a tarnished copper button, a scrap of cloth with a bloodstain
• Documents: a crude map scratched on bark, a wanted poster (folded), a receipt from a merchant, a scrawled note with directions
Do NOT default to gems, necklaces, or jewelry — commoners don't carry those.`,

        mid: `This is a MID-tier creature (CR 2-4). Generate 2-3 items.
Coins: 2d6 silver, 1d6 gold.
Items should reflect this NPC's specific role and background — a bandit carries different things than a merchant or a cultist.
VARIETY IS CRITICAL — do NOT default to "gem + necklace" every time. Pick from categories that fit THIS NPC:
• Personal effects: a locket with a portrait, a lucky charm, a signet ring, a bone dice set, a flask of spirits, a pouch of pipe tobacco
• Trade goods: a bolt of fine cloth, a jar of spices, a set of thieves' tools, a healer's kit, a merchant's scale, a bundle of candles
• Documents: a letter from a contact, a bounty notice, a coded message, a debt ledger, a forged travel pass, a map fragment
• Food/supplies: rations wrapped in oilcloth, a pouch of salt, a whetstone, a coil of rope, a small lantern, a vial of ink
• Curiosities: a foreign coin from a distant land, a tooth from a large beast, a raven feather quill, an old military insignia, a cracked compass
• Small valuables: a semiprecious stone, a silver brooch, a carved ivory comb — but only ONE of these at most, not multiples
10% chance: include ONE common potion (healing, climbing, etc.) or a spell scroll (cantrip or 1st level). Only include this if you roll favorably — most of the time, skip it.`,

        high: `This is a HIGH-tier creature (CR 5-10). Generate 2-4 items.
Coins: 3d10 gold, maybe 1d4 platinum.
Items should reflect power, rank, or purpose — but still be VARIED. Do not just generate "gem + jewelry" every time.
Mix categories — pick 2-4 from different groups that match THIS NPC's story:
• Valuables: a gem worth 25-100 gp, a gold signet ring, an ornate dagger (decorative), a jeweled hairpin, a silver hip flask with engraving
• Documents with weight: a sealed letter to a lord, a map showing a hidden route, a signed contract, a blackmail note, a coded cipher key, orders from a superior
• Personal artifacts: a war medal, a holy symbol of unusual make, a keepsake from a fallen comrade, a portrait miniature, a worn journal with entries
• Tools of the trade: a poisoner's kit, a spyglass, a set of masterwork lockpicks, an alchemist's pouch, a disguise kit component
• Trophies: a monster fang on a cord, an enemy's broken blade, a wanted poster of themselves, a trophy ear collection
15% chance: include ONE common magic item (think Cloak of Many Fashions, Driftglobe, Hat of Wizardry level — NOT +1 weapons).
10% chance: include ONE uncommon potion or spell scroll (up to 2nd level).`,

        elite: `This is an ELITE creature (CR 11+). Generate 3-5 items.
Coins: 5d20 gold, 2d6 platinum.
This is a powerful figure — their possessions should tell a story. Mix valuables with personally significant items:
• High valuables: gems worth 50-500 gp, art objects, a crown or circlet, a golden chalice, a jeweled weapon scabbard
• Keys & access: a key to a vault or dungeon, a sigil-etched token granting passage, a sealed diplomatic pouch
• Intelligence: orders from a patron, a strategic map, a list of agents or spies, a treaty document, a letter revealing a betrayal
• Personal power: a trophy from a defeated rival, a relic of their order, a keepsake from their homeland, memento of a past life
• Rare materials: a vial of exotic poison, a pouch of residuum, a dragon scale, a piece of meteorite iron
20% chance: include ONE uncommon magic item.
15% chance: include ONE rare potion or spell scroll (up to 3rd level).`
    };

    // ── Creature-type loot style guide ────────────────────────────────────
    // Tells the AI HOW to generate loot based on what the creature IS.
    const LOOT_STYLE_BY_TYPE = {
        humanoid:    "This is a HUMANOID — a person with pockets, belt pouches, and a life. Generate personal belongings, trade goods, documents, and tools of their profession. Think about what they'd carry in their daily life.",
        undead:      "This is an UNDEAD creature — it was once alive. Generate remnants of its former life: a ring it doesn't remember wearing, a locket with a faded portrait, a rusted weapon still gripped in skeletal hands, tattered clothing with a coin sewn into the hem. Items should feel old, worn, and melancholy. The more intelligent the undead, the better-preserved and more valuable the items.",
        fiend:       "This is a FIEND — a creature of evil from another plane. It may wear dark jewelry, unholy symbols, or carry trophies from corrupted souls. Items should feel sinister, otherworldly, or blasphemous. Obsidian, bone, blackened metal, and infernal script are common materials.",
        celestial:   "This is a CELESTIAL — a being of good from the upper planes. It may carry holy relics, blessed tokens, divine symbols, or radiant materials. Items should feel sacred, luminous, or ancient.",
        fey:         "This is a FEY creature — whimsical and otherworldly. Items should be strange, beautiful, and slightly unsettling: a leaf that never wilts, a silver bell that rings silently, a mirror reflecting a different face, a vial of moonlight. Nothing ordinary.",
        dragon:      "This is a DRAGON — items are from its hoard, not its pockets. Generate treasures it has collected: art objects, gemstones, coins from fallen kingdoms, magical curiosities, and trophies from defeated foes.",
        giant:       "This is a GIANT — items are oversized and crude. A necklace of skulls, a sack of stolen livestock, a boulder-sized club with teeth embedded in it, coins taken from raided villages. Scale and brutality.",
        aberration:  "This is an ABERRATION — alien and unnatural. Items should feel wrong: a pulsing crystal, a journal written in a language that shifts, a preserved eye that still blinks, psionically-charged focus objects.",
        construct:   "This is a CONSTRUCT — items are components, embedded gems, power sources, or things its creator installed. NOT personal belongings — functional parts with potential value.",
        monstrosity:  "This is an intelligent MONSTROSITY — it may wear jewelry, carry weapons, or keep trophies. Items should reflect its predatory nature and intelligence: a collection of victims' rings, a map of its hunting territory, a stolen noble's cloak it wears as decoration.",
    };

    // Override for beast subcategories — pack animals and messenger birds
    if (creatureType === "beast") {
        if (PACK_ANIMAL_NAMES.test(actorName)) {
            LOOT_STYLE_BY_TYPE.beast = `This is a PACK ANIMAL (${actorName}). It does NOT carry personal belongings — it carries its RIDER'S or OWNER'S possessions. Generate items found in saddlebags, strapped to the saddle, or in cargo packs: rations, rope, a bedroll, a merchant's ledger, trade goods, a water flask, a map, coins in a belt pouch tied to the saddle. The items should belong to whoever was riding or leading this animal, NOT to the animal itself.`;
        } else if (MESSENGER_NAMES.test(actorName)) {
            LOOT_STYLE_BY_TYPE.beast = `This is a MESSENGER ANIMAL (${actorName}). It carries ONE item only: a small message, note, or letter tied to its leg, tucked in a collar tube, or clutched in its talons. The message should be short, mysterious, and plot-relevant — a coded warning, coordinates to a meeting point, a name and location, or a torn fragment of a larger letter. Do NOT generate coins, gems, or personal items — just the message.`;
        }
    }

    const lootStyleHint = LOOT_STYLE_BY_TYPE[creatureType] || LOOT_STYLE_BY_TYPE.humanoid;

    const systemPrompt = `You are a D&D 5e loot generator for a tabletop RPG.
Generate realistic, thematic loot that this NPC would plausibly carry based on their background, creature type, and CR.
Each item needs a NAME and a one-line FLAVOR description (10-20 words, evocative and specific).
For coins, specify the exact amount and denomination.

CREATURE TYPE CONTEXT:
${lootStyleHint}

CRITICAL — VARIETY: Every NPC should feel unique. Do NOT fall back on "gem + necklace/amulet" as your default.
Think about what THIS specific creature would realistically carry based on their job, lifestyle, and personality.
A farmer carries different things than a cultist. A bandit carries different things than a merchant.
Favor personal, flavorful items over generic valuables.

IMPORTANT: The NPC's name is "${npcName}" — reference them by name if relevant.
Do NOT generate natural weapons, armor they're wearing, or weapons they're wielding (those already exist).
Do NOT generate generic "gold pouch" — be specific about amounts.
Do NOT add any preamble or introduction — start directly with the first LOOT: block.
Do NOT use markdown formatting (no ** or * around names).
The item name MUST go on the LOOT: line itself, like: LOOT: Cracked Hand Mirror

Use this EXACT format for each item:

LOOT: [item name]
TYPE: [coins|gem|trinket|jewelry|document|potion|scroll|magic|trade_good]
VALUE: [price in gp, or coin amount like "15 gp" or "30 sp"]
FLAVOR: [one-line description]

For items where TYPE is magic, potion, or scroll, ALSO include these two extra lines so the party can't read the true magic just by picking it up (RAW: magic items must be identified via the Identify spell or 1-hour interaction):

OBSCURED_NAME: [What a non-magical observer would call it — describe the appearance, materials, craftsmanship. Do NOT name the spell, the bonus, the legendary effect, or anything that gives the magic away. Examples: "Rune-Etched Scimitar" for a Frost Brand. "A Small Glass Vial of Murky Green Liquid" for a Potion of Animal Friendship. "A Brass-Bound Tube of Sealed Parchment" for a Scroll of Fireball.]
OBSCURED_DESC: [1-2 sentences of evocative flavor that hints at QUALITY or STRANGENESS without spoiling the function. Examples: "A finely-balanced scimitar with delicate frost-flecked runes traced along the fuller; the grip is colder than the air around it." "The vial's stopper is sealed with a fragment of mossy bark; bubbles drift inside even when the bottle is still." "Heavier than it looks; the wax seal bears a sigil no scribe in the city would recognize."]

Mundane items (gem, trinket, jewelry, document, trade_good) do NOT include OBSCURED_NAME or OBSCURED_DESC — they're known on sight.

Separate each item with a blank line.

${tierInstructions[tier]}`;

    const userMsg = `Generate loot for this NPC:
- Name: ${npcName}
- Creature Type: ${creatureType}${creatureSubtype ? ` (${creatureSubtype})` : ""}
- CR: ${cr}
- Intelligence: ${intScore}
- Location: ${sceneName}
- Background: ${npcBioPlain || "No background available."}`;

    // ── Call AI ──────────────────────────────────────────────────────────
    const { provider, apiKey } = getEnvoyAIConfig();
    const response = await AIHandler.callAI(systemPrompt, [], userMsg, provider, apiKey, [], { context: "loot-generation" });

    if (isAIFailure(response)) return;   // GM already notified — don't set lootGenerated, allow retry
    if (!response) {
        console.warn(`${TAG} | AI returned no loot for ${npcName}.`);
        // Do NOT set lootGenerated flag — allow retry on next token placement
        return;
    }

    // Validate response contains at least one LOOT: block (guards against
    // fallback strings like "My mind is foggy..." from AI timeout/errors)
    if (!/LOOT:\s*/i.test(response)) {
        console.warn(`${TAG} | AI response for ${npcName} loot contained no LOOT: blocks — skipping. Response: "${response.slice(0, 80)}"`);
        return;
    }

    // ── Parse response ──────────────────────────────────────────────────
    // Split on LOOT: whether at start-of-string or after a newline.
    const blocks = response.split(/(?:^|\n)LOOT:\s*/i).filter(b => b.trim());

    const itemsToCreate = [];
    const currencyAdd = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };

    /** Strip markdown bold/italic wrapping and trim quotes from a string. */
    const _cleanName = (s) => s.replace(/\*+/g, "").replace(/^["']|["']$/g, "").trim();

    for (const block of blocks) {
        const lines = block.trim().split("\n");
        let itemName = _cleanName(lines[0] || "");

        // ── Robustness: if the LOOT: line was empty, the AI may have put
        //    the item name on the TYPE: line instead (e.g. "TYPE: Cracked Hand Mirror")
        //    or on the FLAVOR: line.  Detect and recover. ─────────────────
        if (!itemName || /^(TYPE|VALUE|FLAVOR):/i.test(itemName)) {
            // Look through subsequent lines for the first one with actual content
            // that isn't a recognized field prefix with a known category value
            const knownTypes = new Set(["coins","gem","trinket","jewelry","document","potion","scroll","magic","trade_good"]);
            let recovered = "";
            for (const line of lines) {
                const typeM = line.match(/^TYPE:\s*(.+)/i);
                if (typeM) {
                    const val = typeM[1].trim();
                    // If the TYPE value is NOT a known loot category, it's actually the item name
                    if (!knownTypes.has(val.toLowerCase())) {
                        recovered = _cleanName(val);
                        break;
                    }
                }
                const flavM = line.match(/^FLAVOR:\s*(.+)/i);
                if (flavM && !recovered) {
                    recovered = _cleanName(flavM[1]);
                    break;
                }
            }
            if (recovered) itemName = recovered;
        }

        // Skip preamble lines the AI sometimes adds ("Here is the loot for X:")
        if (!itemName || /^here is the loot/i.test(itemName) || /^(TYPE|VALUE|FLAVOR):?\s*$/i.test(itemName)) continue;

        const knownLootTypes = new Set(["coins","gem","trinket","jewelry","document","potion","scroll","magic","trade_good"]);
        let lootType = "trinket", value = "", flavor = "";
        let obscuredName = "", obscuredDesc = "";
        for (const line of lines.slice(1)) {
            const typeMatch     = line.match(/^TYPE:\s*(.+)/i);
            const valMatch      = line.match(/^VALUE:\s*(.+)/i);
            const flavMatch     = line.match(/^FLAVOR:\s*(.+)/i);
            const obscNameMatch = line.match(/^OBSCURED_NAME:\s*(.+)/i);
            const obscDescMatch = line.match(/^OBSCURED_DESC:\s*(.+)/i);
            // Only accept TYPE if it's a known loot category (prevents item names bleeding in)
            if (typeMatch && knownLootTypes.has(typeMatch[1].trim().toLowerCase())) {
                lootType = typeMatch[1].trim().toLowerCase();
            }
            if (valMatch)      value        = valMatch[1].trim();
            if (flavMatch)     flavor       = _cleanName(flavMatch[1]);
            if (obscNameMatch) obscuredName = _cleanName(obscNameMatch[1]);
            if (obscDescMatch) obscuredDesc = _cleanName(obscDescMatch[1]);
        }

        // ── Handle coins → add to currency directly ─────────────────────
        if (lootType === "coins") {
            const coinMatches = value.matchAll(/(\d+)\s*(cp|sp|ep|gp|pp)/gi);
            for (const m of coinMatches) {
                const amount = parseInt(m[1], 10);
                const denom  = m[2].toLowerCase();
                if (currencyAdd[denom] !== undefined) currencyAdd[denom] += amount;
            }
            console.log(`${TAG} | Loot coin: ${value}`);
            continue;
        }

        // Shared-budget item cap (Option C, 2026-07-14): the real-first elite path
        // passes opts.maxItems so flavor items don't overflow the budget the
        // compendium magic already claimed. Coins above are unaffected.
        if (Number.isFinite(opts?.maxItems) && itemsToCreate.length >= opts.maxItems) continue;

        // ── Handle items → create as Foundry loot items ─────────────────
        if (!flavor) flavor = itemName;

        // Pick an appropriate icon based on type, then refine by item name keywords
        const typeIconMap = {
            gem:        "icons/commodities/gems/gem-faceted-round-white.webp",
            trinket:    "icons/svg/item-bag.svg",
            jewelry:    "icons/equipment/neck/necklace-simple-gold.webp",
            document:   "icons/sundries/documents/document-sealed-brown-red.webp",
            potion:     "icons/consumables/potions/potion-bottle-standard-red.webp",
            scroll:     "icons/sundries/scrolls/scroll-runed-brown-purple.webp",
            magic:      "icons/magic/symbols/rune-sigil-gold-purple.webp",
            trade_good: "icons/commodities/treasure/token-gold-gem-blue.webp",
        };

        // ── Smart icon resolution: sub-keywords → random pool → type fallback ──
        // Each entry: { match: /regex/, sub: [[/subRegex/, icon], ...], pool: [icons...] }
        // Resolution order: 1) sub-keyword match  2) random from pool  3) typeIconMap  4) trinket
        const _rng = (arr) => arr[Math.floor(Math.random() * arr.length)];
        const iconRules = [
            // ── Keys & Locks ──
            { match: /\bkey\b/i, sub: [
                [/\b(gold|ornate|jewel|royal)\b/i, "icons/sundries/misc/key-jeweled-gold-purple.webp"],
                [/\b(iron|old|rusted|ancient|dungeon|crypt)\b/i, "icons/sundries/misc/key-ornate-iron-black.webp"],
                [/\b(brass|copper)\b/i, "icons/sundries/misc/key-brass.webp"],
            ], pool: [
                "icons/sundries/misc/key-steel.webp",
                "icons/sundries/misc/key-gold.webp",
                "icons/sundries/misc/key-brass.webp",
                "icons/sundries/misc/key-copper.webp",
                "icons/sundries/misc/key-ornate-iron-black.webp",
                "icons/sundries/misc/key-short-gold.webp",
            ]},
            { match: /\block\b/i, pool: [
                "icons/sundries/misc/lock-steel-blue.webp",
                "icons/sundries/misc/lock-bronze-reinforced.webp",
            ]},

            // ── Books & Tomes ──
            { match: /\b(book|tome|grimoire|codex|manual|lexicon)\b/i, sub: [
                [/\b(necro|death|dark|shadow|evil|curse|forbidden|black)\b/i, "icons/sundries/books/book-face-black.webp"],
                [/\b(eye|watch|secret|occult|arcane|eldritch)\b/i, "icons/sundries/books/book-eye-purple.webp"],
                [/\b(nature|druid|leaf|forest|green)\b/i, "icons/sundries/books/book-embossed-roots-green.webp"],
                [/\b(holy|sacred|divine|prayer|hymn|celestial)\b/i, "icons/sundries/books/book-symbol-cross-blue.webp"],
                [/\b(fire|flame|burn|infernal)\b/i, "icons/sundries/books/book-symbol-fire-gold-orange.webp"],
                [/\b(lightning|storm|thunder)\b/i, "icons/sundries/books/book-symbol-lightning-silver-blue.webp"],
            ], pool: [
                "icons/sundries/books/book-embossed-jewel-gold-purple.webp",
                "icons/sundries/books/book-embossed-gold-red.webp",
                "icons/sundries/books/book-embossed-steel-brown.webp",
                "icons/sundries/books/book-tooled-gold-brown.webp",
                "icons/sundries/books/book-embossed-bound-brown.webp",
                "icons/sundries/books/book-clasp-spiral-green.webp",
            ]},
            { match: /\b(journal|diary|ledger|log)\b/i, pool: [
                "icons/sundries/books/book-worn-brown.webp",
                "icons/sundries/books/book-worn-red.webp",
                "icons/sundries/books/book-worn-teal.webp",
                "icons/sundries/books/book-simple-brown.webp",
                "icons/sundries/books/book-worn-green.webp",
            ]},

            // ── Documents ──
            { match: /\b(letter|envelope|missive|correspondence)\b/i, pool: [
                "icons/sundries/documents/envelope-sealed-red-tan.webp",
                "icons/sundries/documents/envelope-sealed-red-brown.webp",
                "icons/sundries/documents/envelope-sealed-red-white.webp",
            ]},
            { match: /\b(note|parchment|deed|warrant|writ|contract)\b/i, pool: [
                "icons/sundries/documents/document-letter-tan.webp",
                "icons/sundries/documents/document-letter-brown.webp",
                "icons/sundries/documents/document-sealed-brown-red.webp",
                "icons/sundries/documents/document-official-capital.webp",
            ]},
            { match: /\b(map|chart|atlas)\b/i, pool: [
                "icons/sundries/documents/document-torn-diagram-tan.webp",
                "icons/sundries/documents/document-symbol-circle-brown.webp",
            ]},
            { match: /\b(scroll|scripture)\b/i, pool: [
                "icons/sundries/scrolls/scroll-runed-brown-purple.webp",
            ]},

            // ── Rings ──
            { match: /\b(ring|signet)\b/i, sub: [
                [/\b(bone|skull|death|undead|necro)\b/i, "icons/equipment/finger/ring-bone-spiked-skull.webp"],
                [/\b(fire|flame|red|ruby)\b/i, "icons/equipment/finger/ring-cabochon-gold-red.webp"],
                [/\b(ice|frost|blue|sapphire|water)\b/i, "icons/equipment/finger/ring-cabochon-gold-blue.webp"],
                [/\b(nature|green|emerald|vine|forest)\b/i, "icons/equipment/finger/ring-cabochon-gold-green.webp"],
                [/\b(shadow|dark|obsidian|void)\b/i, "icons/equipment/finger/ring-faceted-grey.webp"],
                [/\b(gold|ornate|royal|king|queen)\b/i, "icons/equipment/finger/ring-band-engraved-scrolls-gold.webp"],
            ], pool: [
                "icons/equipment/finger/ring-cabochon-gold-red.webp",
                "icons/equipment/finger/ring-cabochon-silver-purple.webp",
                "icons/equipment/finger/ring-cabochon-gold-green.webp",
                "icons/equipment/finger/ring-band-gold.webp",
                "icons/equipment/finger/ring-cabochon-gold-blue.webp",
                "icons/equipment/finger/ring-faceted-gold-teal.webp",
            ]},

            // ── Necklaces & Amulets ──
            { match: /\b(amulet|pendant|talisman|medallion|locket)\b/i, sub: [
                [/\b(sun|solar|radiant|dawn)\b/i, "icons/equipment/neck/necklace-astrology-sun-gold.webp"],
                [/\b(moon|lunar|night)\b/i, "icons/equipment/neck/necklace-astrology-moon-gold.webp"],
                [/\b(bone|skull|death)\b/i, "icons/equipment/neck/necklace-carved-bone-skull.webp"],
                [/\b(spider|web)\b/i, "icons/equipment/neck/necklace-animal-spider-purple.webp"],
            ], pool: [
                "icons/equipment/neck/amulet-round-gold-red.webp",
                "icons/equipment/neck/amulet-round-silver-blue.webp",
                "icons/equipment/neck/amulet-geometric-gold-green.webp",
                "icons/equipment/neck/amulet-round-engraved-gold.webp",
                "icons/equipment/neck/amulet-triangle-blue.webp",
            ]},
            { match: /\b(necklace|choker|torque|torc)\b/i, pool: [
                "icons/equipment/neck/necklace-simple-gold.webp",
                "icons/equipment/neck/choker-chain-thick-gold.webp",
                "icons/equipment/neck/choker-chain-thick-silver.webp",
            ]},
            { match: /\b(bracelet|bangle|bracer|cuff)\b/i, pool: [
                "icons/equipment/neck/choker-chain-thick-gold.webp",
                "icons/equipment/neck/choker-chain-thin-gold.webp",
            ]},

            // ── Headwear ──
            { match: /\b(crown|circlet|tiara|diadem|coronet)\b/i, pool: [
                "icons/equipment/head/crown-gold-red.webp",
                "icons/equipment/head/crown-gold-blue.webp",
                "icons/equipment/head/crown-thorns-gold.webp",
            ]},
            { match: /\b(mask)\b/i, pool: [
                "icons/magic/symbols/mask-metal-silver-white.webp",
                "icons/magic/symbols/mask-yellow-orange.webp",
            ]},

            // ── Cloaks & Robes ──
            { match: /\b(cloak|cape|mantle)\b/i, sub: [
                [/\b(shadow|dark|night|black|stealth|thief)\b/i, "icons/equipment/back/cloak-heavy-black-red.webp"],
                [/\b(nature|forest|green|druid|ranger)\b/i, "icons/equipment/back/cloak-hooded-green-gold.webp"],
                [/\b(red|fire|flame|blood)\b/i, "icons/equipment/back/cloak-collared-red-gold.webp"],
                [/\b(blue|ice|frost|winter|water)\b/i, "icons/equipment/back/cloak-collared-blue-gold.webp"],
                [/\b(royal|purple|king|queen|noble)\b/i, "icons/equipment/back/cloak-collared-purple-gold.webp"],
            ], pool: [
                "icons/equipment/back/cloak-collared-purple-gold.webp",
                "icons/equipment/back/cloak-collared-blue-gold.webp",
                "icons/equipment/back/cloak-collared-red-gold.webp",
                "icons/equipment/back/cloak-hooded-blue.webp",
                "icons/equipment/back/cloak-collared-grey-gold.webp",
                "icons/equipment/back/cloak-brown-fur-white.webp",
            ]},
            { match: /\b(robe|gown|vestment|garb)\b/i, pool: [
                "icons/equipment/back/cloak-collared-blue-gold.webp",
                "icons/equipment/back/cloak-collared-red-gold.webp",
                "icons/equipment/back/cloak-collared-purple-gold.webp",
            ]},

            // ── Shields ──
            { match: /\b(shield|buckler)\b/i, pool: [
                "icons/equipment/shield/heater-steel-gold.webp",
                "icons/equipment/shield/heater-steel-grey.webp",
                "icons/equipment/shield/heater-wooden-blue.webp",
                "icons/equipment/shield/kite-steel-boss-gold.webp",
                "icons/equipment/shield/round-wooden-boss-gold-brown.webp",
            ]},

            // ── Swords ──
            { match: /\b(sword|blade|longsword|greatsword|rapier|scimitar|saber|sabre)\b/i, sub: [
                [/\b(holy|sacred|divine|paladin|radiant|celestial)\b/i, "icons/weapons/swords/sword-gold-holy.webp"],
                [/\b(evil|cursed|dark|shadow|doom|unholy|demon)\b/i, "icons/weapons/swords/greatsword-evil-green.webp"],
                [/\b(rune|runed|glow|magic|enchant|arcane)\b/i, "icons/weapons/swords/sword-runed-glowing.webp"],
                [/\b(old|ancient|rusted|worn|broken)\b/i, "icons/weapons/swords/sword-guard-worn.webp"],
                [/\b(flame|fire|burning|ember)\b/i, "icons/weapons/swords/sword-flanged-lightning.webp"],
            ], pool: [
                "icons/weapons/swords/sword-guard-gold-red.webp",
                "icons/weapons/swords/sword-guard-steel-green.webp",
                "icons/weapons/swords/sword-guard-purple.webp",
                "icons/weapons/swords/sword-guard-bronze.webp",
                "icons/weapons/swords/greatsword-guard-gold.webp",
                "icons/weapons/swords/shortsword-guard-gold.webp",
                "icons/weapons/swords/sword-jeweled-red.webp",
            ]},

            // ── Daggers ──
            { match: /\b(dagger|knife|stiletto|shiv)\b/i, sub: [
                [/\b(ritual|sacrifice|cult|dark|blood|occult)\b/i, "icons/weapons/daggers/dagger-ritual-black.webp"],
                [/\b(poison|venom|toxic|green)\b/i, "icons/weapons/daggers/dagger-poisoned-curved-green.webp"],
                [/\b(bone|skull|death|necro)\b/i, "icons/weapons/daggers/dagger-bone-black.webp"],
                [/\b(jewel|gem|ornate|royal|gold)\b/i, "icons/weapons/daggers/dagger-jeweled-blue.webp"],
                [/\b(crystal|ice|frost|magic)\b/i, "icons/weapons/daggers/dagger-ritual-crooked-crystal.webp"],
            ], pool: [
                "icons/weapons/daggers/dagger-jeweled-black.webp",
                "icons/weapons/daggers/dagger-curved-gold.webp",
                "icons/weapons/daggers/dagger-simple-black.webp",
                "icons/weapons/daggers/dagger-straight-blue.webp",
                "icons/weapons/daggers/dagger-serrated-black.webp",
                "icons/weapons/daggers/dagger-blue.webp",
            ]},

            // ── Axes ──
            { match: /\b(axe|hatchet)\b/i, pool: [
                "icons/weapons/axes/axe-broad-grey.webp",
                "icons/weapons/axes/axe-broad-brown.webp",
                "icons/weapons/axes/axe-broad-engraved.webp",
                "icons/weapons/axes/axe-broad-black.webp",
            ]},

            // ── Staves ──
            { match: /\b(staff|quarterstaff)\b/i, sub: [
                [/\b(necro|death|skull|dark|shadow|undead|bone|doom)\b/i, "icons/weapons/staves/staff-skull-brown.webp"],
                [/\b(nature|druid|vine|leaf|forest|wood|oak|branch)\b/i, "icons/weapons/staves/staff-nature.webp"],
                [/\b(fire|flame|ember|infernal|red)\b/i, "icons/weapons/staves/staff-engraved-red.webp"],
                [/\b(ice|frost|blue|water|storm|lightning)\b/i, "icons/weapons/staves/staff-blue-jewel.webp"],
                [/\b(holy|sacred|divine|celestial|cross|prayer)\b/i, "icons/weapons/staves/staff-ornate-cross.webp"],
                [/\b(eye|watch|seer|oracle|vision)\b/i, "icons/weapons/staves/staff-ornate-eye.webp"],
                [/\b(simple|walking|travel|wander|pilgrim)\b/i, "icons/weapons/staves/staff-simple-brown.webp"],
            ], pool: [
                "icons/weapons/staves/staff-ornate-gold-jeweled.webp",
                "icons/weapons/staves/staff-ornate-purple.webp",
                "icons/weapons/staves/staff-ornate-blue.webp",
                "icons/weapons/staves/staff-ornate-green.webp",
                "icons/weapons/staves/staff-ornate-red.webp",
                "icons/weapons/staves/staff-forest-jewel.webp",
                "icons/weapons/staves/staff-simple-spiral-green.webp",
                "icons/weapons/staves/staff-crescent-purple.webp",
            ]},

            // ── Wands & Rods ──
            { match: /\b(wand|rod|scepter|sceptre)\b/i, sub: [
                [/\b(necro|death|skull|dark|shadow|bone|doom)\b/i, "icons/weapons/wands/wand-skull-horned.webp"],
                [/\b(fire|flame|ember|infernal)\b/i, "icons/weapons/wands/wand-carved-fire.webp"],
                [/\b(star|celestial|holy|light)\b/i, "icons/weapons/wands/wand-star-gold.webp"],
            ], pool: [
                "icons/weapons/wands/wand-gem-purple.webp",
                "icons/weapons/wands/wand-gem-blue.webp",
                "icons/weapons/wands/wand-gem-red.webp",
                "icons/weapons/wands/wand-gem-green.webp",
                "icons/weapons/wands/wand-gem-teal.webp",
                "icons/weapons/wands/wand-star-white.webp",
            ]},

            // ── Bows & Ammunition ──
            { match: /\b(bow|longbow|shortbow)\b/i, pool: [
                "icons/weapons/bows/longbow-recurve.webp",
                "icons/weapons/bows/longbow-recurve-brown.webp",
                "icons/weapons/bows/shortbow-recurve.webp",
                "icons/weapons/bows/shortbow-recurve-leather.webp",
            ]},
            { match: /\b(arrow|bolt|quiver|ammunition)\b/i, pool: [
                "icons/containers/ammunition/arrows-quiver-brown.webp",
                "icons/containers/ammunition/arrows-quiver-green.webp",
                "icons/containers/ammunition/arrows-quiver-blue.webp",
            ]},

            // ── Potions & Vials ──
            { match: /\b(potion|elixir|philter|draught|tonic)\b/i, sub: [
                [/\b(heal|health|life|red|restore|cure)\b/i, "icons/consumables/potions/potion-bottle-corked-labeled-red.webp"],
                [/\b(mana|magic|blue|arcane)\b/i, "icons/consumables/potions/potion-bottle-corked-blue.webp"],
                [/\b(poison|toxic|green|venom)\b/i, "icons/consumables/potions/potion-round-corked-glowing-green.webp"],
                [/\b(fire|flame|orange|explosive)\b/i, "icons/consumables/potions/potion-flask-corked-orange.webp"],
                [/\b(invisib|stealth|clear|vanish)\b/i, "icons/consumables/potions/potion-bottle-corked-white.webp"],
            ], pool: [
                "icons/consumables/potions/potion-bottle-corked-blue.webp",
                "icons/consumables/potions/potion-flask-corked-green.webp",
                "icons/consumables/potions/potion-flask-corked-orange.webp",
                "icons/consumables/potions/potion-tube-corked-blue.webp",
                "icons/consumables/potions/potion-bottle-corked-labeled-red.webp",
                "icons/consumables/potions/potion-jar-corked-green.webp",
            ]},
            { match: /\b(vial|flask|bottle|phial)\b/i, pool: [
                "icons/consumables/potions/potion-flask-corked-blue.webp",
                "icons/consumables/potions/potion-flask-corked-green.webp",
                "icons/consumables/potions/potion-tube-corked-red.webp",
                "icons/consumables/potions/potion-vial-corked-purple.webp",
            ]},

            // ── Bones & Remains ──
            { match: /\b(skull)\b/i, pool: [
                "icons/commodities/bones/skull-hollow-white.webp",
                "icons/commodities/bones/skull-hollow-grey.webp",
                "icons/commodities/bones/skull-hollow-brown.webp",
            ]},
            { match: /\b(bone|femur|rib)\b/i, pool: [
                "icons/commodities/bones/bone-simple-white.webp",
                "icons/commodities/bones/bone-broken-grey.webp",
                "icons/commodities/bones/bone-fragments-white.webp",
            ]},
            { match: /\b(horn|trumpet|bugle)\b/i, pool: [
                "icons/commodities/bones/horn-curved-brown.webp",
                "icons/commodities/bones/horn-curved-grey.webp",
                "icons/commodities/bones/horn-drinking-white.webp",
                "icons/commodities/bones/horn-engraved-vines-grey.webp",
            ]},

            // ── Gems & Crystals ──
            { match: /\b(gem|jewel|ruby|sapphire|emerald|diamond|amethyst|opal|topaz|garnet)\b/i, sub: [
                [/\b(ruby|red|garnet|blood)\b/i, "icons/commodities/gems/gem-faceted-radiant-red.webp"],
                [/\b(sapphire|blue)\b/i, "icons/commodities/gems/gem-faceted-diamond-blue.webp"],
                [/\b(emerald|green)\b/i, "icons/commodities/gems/gem-faceted-diamond-green.webp"],
                [/\b(diamond|white|clear)\b/i, "icons/commodities/gems/gem-faceted-round-white.webp"],
                [/\b(amethyst|purple|violet)\b/i, "icons/commodities/gems/gem-faceted-rough-purple.webp"],
                [/\b(topaz|yellow|amber)\b/i, "icons/commodities/gems/gem-faceted-octagon-yellow.webp"],
                [/\b(opal|teal|cyan)\b/i, "icons/commodities/gems/gem-faceted-round-teal.webp"],
            ], pool: [
                "icons/commodities/gems/gem-faceted-round-white.webp",
                "icons/commodities/gems/gem-faceted-radiant-red.webp",
                "icons/commodities/gems/gem-faceted-diamond-blue.webp",
                "icons/commodities/gems/gem-faceted-diamond-green.webp",
                "icons/commodities/gems/gem-faceted-rough-purple.webp",
                "icons/commodities/gems/gem-faceted-octagon-yellow.webp",
            ]},
            { match: /\b(crystal|orb|sphere|globe)\b/i, pool: [
                "icons/commodities/gems/gem-cluster-blue-white.webp",
                "icons/commodities/gems/gem-cluster-purple.webp",
                "icons/commodities/gems/gem-cluster-teal.webp",
                "icons/commodities/gems/gem-cluster-red.webp",
            ]},

            // ── Currency & Containers ──
            { match: /\b(coin|gold\s*piece|silver\s*piece|currency|money)\b/i, pool: [
                "icons/commodities/currency/coins-plain-stack-gold.webp",
                "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
                "icons/commodities/currency/coins-plain-pouch-gold.webp",
            ]},
            { match: /\b(pouch|purse|coinpouch)\b/i, pool: [
                "icons/containers/bags/coinpouch-gold-red.webp",
                "icons/containers/bags/coinpouch-leather-red.webp",
                "icons/containers/bags/coinpouch-leather-orange.webp",
                "icons/containers/bags/pouch-leather-gold-tan.webp",
            ]},
            { match: /\b(bag|sack|pack)\b/i, pool: [
                "icons/containers/bags/sack-leather-brown.webp",
                "icons/containers/bags/sack-cloth-brown.webp",
                "icons/containers/bags/pack-leather-brown.webp",
                "icons/containers/bags/pouch-simple-brown.webp",
            ]},

            // ── Lights ──
            { match: /\b(lantern|lamp)\b/i, pool: [
                "icons/sundries/lights/lantern-iron-lit-yellow.webp",
                "icons/sundries/lights/lantern-iron-yellow.webp",
                "icons/sundries/lights/lantern-steel.webp",
            ]},
            { match: /\b(torch)\b/i, pool: [
                "icons/sundries/lights/torch-brown-lit.webp",
                "icons/sundries/lights/torch-brown.webp",
                "icons/sundries/lights/torch-grey.webp",
            ]},
            { match: /\b(candle)\b/i, pool: [
                "icons/sundries/lights/candle-lit-yellow.webp",
                "icons/sundries/lights/candle-lit-red.webp",
                "icons/sundries/lights/candle-pillar-lit-yellow.webp",
            ]},

            // ── ID Tags / Medals / Insignia (semantic: necklace-ish chains worn on body) ──
            // Covers things like "Tattered Dog Tags", "Soldier's ID Tag", "Service Medal"
            { match: /\b(dog\s*tag|id\s*tag|name\s*tag|service\s*tag|military\s*tag|tags?)\b/i, pool: [
                "icons/equipment/neck/necklace-simple-gold.webp",
                "icons/equipment/neck/necklace-pendant-pearl-silver.webp",
                "icons/equipment/neck/choker-chain-thin-gold.webp",
                "icons/equipment/neck/choker-chain-thick-silver.webp",
            ]},
            { match: /\b(badge|insignia|crest|emblem|sigil\s*pin|brooch|seal\s*pin)\b/i, pool: [
                "icons/equipment/neck/amulet-round-engraved-gold.webp",
                "icons/equipment/neck/amulet-round-gold-red.webp",
                "icons/equipment/neck/amulet-triangle-blue.webp",
            ]},
            { match: /\b(medal|ribbon|honor\s*token|service\s*pin|war\s*medal)\b/i, pool: [
                "icons/equipment/neck/amulet-round-engraved-gold.webp",
                "icons/equipment/neck/amulet-round-gold-red.webp",
                "icons/equipment/neck/medallion-engraved-gold.webp",
            ]},

            // ── Food / Rations / Provisions ──
            { match: /\b(ration|rations|provisions|hardtack|bread|loaf|biscuit|cracker)\b/i, pool: [
                "icons/consumables/food/bread-loaf-boule-rustic-tan.webp",
                "icons/consumables/food/bread-loaf-rustic-brown.webp",
                "icons/consumables/food/bread-loaf-baguette-tan.webp",
            ]},
            { match: /\b(meat|jerky|bacon|sausage|steak|roast|game)\b/i, pool: [
                "icons/consumables/meat/cooked-meat-grey-red.webp",
                "icons/consumables/meat/skewer-cooked-meat-brown.webp",
                "icons/consumables/meat/raw-meat-grey-red.webp",
            ]},
            { match: /\b(cheese|wheel\s*of)\b/i, pool: [
                "icons/consumables/food/cheese-wedge-yellow.webp",
                "icons/consumables/food/cheese-wheel-yellow.webp",
            ]},
            { match: /\b(fruit|apple|berry|berries|peach|pear|plum)\b/i, pool: [
                "icons/consumables/fruit/apple-red.webp",
                "icons/consumables/fruit/berries-blue.webp",
                "icons/consumables/fruit/grapes-bunch-purple.webp",
            ]},
            { match: /\b(soup|stew|broth|porridge|gruel)\b/i, pool: [
                "icons/consumables/soup/bowl-steaming-brown.webp",
                "icons/consumables/soup/soup-meat-stew-brown.webp",
            ]},
            { match: /\b(food|meal|snack|ration\s*pack|packet)\b/i, pool: [
                "icons/consumables/food/bread-loaf-rustic-brown.webp",
                "icons/consumables/food/cake-side-brown.webp",
                "icons/consumables/soup/bowl-steaming-brown.webp",
            ]},

            // ── Drinks / Containers ──
            { match: /\b(waterskin|wineskin|skin\s*of|flask|canteen)\b/i, pool: [
                "icons/sundries/survival/canteen-skin-tan.webp",
                "icons/sundries/survival/canteen-tin-grey.webp",
            ]},
            { match: /\b(wine|ale|beer|mead|liquor|spirits|whiskey|rum|brandy|grog)\b/i, pool: [
                "icons/consumables/drinks/wine-bottle-glass-red.webp",
                "icons/consumables/drinks/beer-glass-foam-tan.webp",
                "icons/consumables/drinks/alcohol-jug-tan.webp",
            ]},
            { match: /\b(jug|jar|pitcher|urn|amphora)\b/i, pool: [
                "icons/consumables/drinks/alcohol-jug-tan.webp",
                "icons/containers/kitchenware/vase-clay-painted-blue.webp",
                "icons/containers/kitchenware/vase-clay-engraved-grey.webp",
            ]},
            { match: /\b(bottle|vial|phial)\b/i, pool: [
                "icons/consumables/drinks/wine-bottle-glass-red.webp",
                "icons/consumables/potions/bottle-corked-empty-tan.webp",
                "icons/consumables/potions/vial-cork-empty-glass.webp",
            ]},

            // ── Bags / Pouches / Containers ──
            { match: /\b(pouch|purse|sack|bag|satchel|knapsack|backpack)\b/i, pool: [
                "icons/containers/bags/pouch-simple-leather-brown.webp",
                "icons/containers/bags/pack-rolled-tan.webp",
                "icons/containers/bags/sack-simple-leather-tan.webp",
            ]},
            { match: /\b(box|case|crate|chest)\b/i, pool: [
                "icons/containers/chest/chest-simple-engraved-brown.webp",
                "icons/containers/boxes/box-gift-tan.webp",
                "icons/containers/chest/chest-iron-bronze-grey.webp",
            ]},

            // ── Tools / Misc Items (existing + augmented) ──
            { match: /\b(goblet|chalice|cup|grail|tankard)\b/i, pool: [
                "icons/containers/kitchenware/goblet-jeweled-gold-red.webp",
                "icons/containers/kitchenware/goblet-engraved-gold.webp",
                "icons/containers/kitchenware/goblet-jeweled-gold-purple.webp",
            ]},
            { match: /\b(mirror|looking\s*glass)\b/i, pool: [
                "icons/svg/item-bag.svg",
            ]},
            { match: /\b(feather|quill|plume)\b/i, pool: [
                "icons/sundries/documents/document-writing-brown.webp",
                "icons/sundries/documents/document-writing-pink.webp",
            ]},
            { match: /\b(bell)\b/i, pool: ["icons/svg/sound.svg"] },
            { match: /\b(herb|plant|flower|root|moss|leaf|sprig)\b/i, pool: [
                "icons/consumables/plants/herb-tied-bundle-green.webp",
                "icons/consumables/plants/herb-bunch-dried-leaf-green.webp",
                "icons/consumables/plants/leaf-herb-green.webp",
                "icons/consumables/plants/sprout-leaf-herb-green.webp",
            ]},
            { match: /\b(rope|twine|cord|string|wire)\b/i, pool: [
                "icons/sundries/survival/rope-coil-tan.webp",
                "icons/tools/fasteners/chain-steel-grey.webp",
            ]},
            { match: /\b(chain|shackle|manacle)\b/i, pool: [
                "icons/tools/fasteners/chain-brass-yellow.webp",
                "icons/tools/fasteners/chain-steel-grey.webp",
            ]},
            { match: /\b(hammer|mace|maul|cudgel)\b/i, pool: [
                "icons/tools/hand/hammer-simple-stone.webp",
                "icons/tools/hand/hammer-mallet-brown.webp",
            ]},
            { match: /\b(pick|pickaxe)\b/i, pool: ["icons/tools/hand/pickaxe-simple-stone-brown.webp"] },
            { match: /\b(idol|figurine|statue|statuette|effigy|totem)\b/i, pool: [
                "icons/commodities/treasure/bust-carved-stone.webp",
                "icons/commodities/treasure/bust-pharaoh-gold-blue.webp",
            ]},

            // ── Cloth / Worn / Tattered things — sensible default to clothing/cloth ──
            // Catches "Tattered Cloth", "Worn Garment", "Bloody Rag" etc. that fall
            // through everything else above. The "tattered" keyword shouldn't beat
            // "tattered dog tags" because that rule appears earlier in the list.
            { match: /\b(cloak|robe|cape|mantle|shawl)\b/i, pool: [
                "icons/equipment/back/cape-layered-red.webp",
                "icons/equipment/back/cloak-collared-brown.webp",
                "icons/equipment/back/cape-layered-tan.webp",
            ]},
            { match: /\b(boot|boots|shoe|shoes|sandal)\b/i, pool: [
                "icons/equipment/feet/boots-leather-brown.webp",
                "icons/equipment/feet/shoes-pointed-leather-brown.webp",
            ]},
            { match: /\b(glove|gloves|gauntlet|mitten)\b/i, pool: [
                "icons/equipment/hand/glove-cloth-pink.webp",
                "icons/equipment/hand/glove-leather-brown.webp",
            ]},
            { match: /\b(belt|sash|girdle|strap|harness)\b/i, pool: [
                "icons/equipment/waist/belt-simple-leather-brown.webp",
                "icons/equipment/waist/sash-cloth-tan.webp",
            ]},
            { match: /\b(rag|cloth|fabric|cloth\s*scrap|bandage|wrap|garment|tunic|shirt)\b/i, pool: [
                "icons/sundries/survival/bedroll-blue.webp",
                "icons/equipment/back/cloak-collared-brown.webp",
                "icons/sundries/lights/lantern-simple-tan.webp",
            ]},

            // ── Survival / Camp gear ──
            { match: /\b(bedroll|blanket|tarp|tent)\b/i, pool: [
                "icons/sundries/survival/bedroll-blue.webp",
                "icons/sundries/survival/bedroll-tan.webp",
            ]},
            { match: /\b(lantern|lamp|firefly\s*jar)\b/i, pool: [
                "icons/sundries/lights/lantern-simple-tan.webp",
                "icons/sundries/lights/lantern-iron-yellow.webp",
            ]},

            // ── Tobacco / Smoking ──
            { match: /\b(pipe|tobacco|cigar|cigarette|smoke)\b/i, pool: [
                "icons/sundries/misc/pipe-wood-engraved.webp",
                "icons/sundries/misc/pipe-wood-stoke.webp",
            ]},

            // ── Music ──
            { match: /\b(lute|harp|flute|drum|fiddle|whistle|horn\s*(of|that)|instrument)\b/i, pool: [
                "icons/tools/instruments/lute-gold-brown.webp",
                "icons/tools/instruments/flute-simple-wood.webp",
                "icons/tools/instruments/horn-carved-brown.webp",
            ]},

            // ── Game / Gambling ──
            { match: /\b(dice|die|card|cards|gaming|gambling)\b/i, pool: [
                "icons/sundries/gaming/dice-runed-tan.webp",
                "icons/sundries/gaming/playing-card-simple.webp",
            ]},

            // ── Magic & Theme (broad matches — keep these last!) ──
            { match: /\b(rune|sigil|glyph|symbol)\b/i, pool: [
                "icons/magic/symbols/runes-carved-stone-purple.webp",
                "icons/magic/symbols/runes-carved-stone-red.webp",
                "icons/magic/symbols/runes-carved-stone-green.webp",
                "icons/magic/symbols/runes-carved-stone-yellow.webp",
            ]},
            { match: /\b(tear|vesper|whisper|shadow|dark|midnight|doom|death|cursed|unholy)\b/i, pool: [
                "icons/magic/symbols/rune-sigil-black-pink.webp",
                "icons/magic/symbols/rune-sigil-red-orange.webp",
                "icons/magic/symbols/rune-sigil-horned-blue.webp",
            ]},
            { match: /\b(holy|sacred|blessed|divine|celestial|radiant)\b/i, pool: [
                "icons/magic/symbols/cross-circle-blue.webp",
                "icons/magic/symbols/star-solid-gold.webp",
                "icons/magic/symbols/star-yellow.webp",
            ]},
        ];

        // Resolve icon: sub-keyword → random pool → type map → trinket → guaranteed SVG
        // Guaranteed final fallback uses an icons/svg/* path which is Foundry-stock
        // and always exists, so the chat card never renders a broken image.
        const FINAL_FALLBACK = "icons/svg/item-bag.svg";
        function _pickLootIcon(name, type) {
            const n = (name || "").toLowerCase();
            try {
                for (const rule of iconRules) {
                    if (!rule.match.test(n)) continue;
                    // 1) Sub-keyword refinement
                    if (rule.sub) {
                        for (const [subRe, subIcon] of rule.sub) {
                            if (subRe.test(n)) return subIcon || FINAL_FALLBACK;
                        }
                    }
                    // 2) Random from pool
                    if (rule.pool?.length) {
                        const picked = _rng(rule.pool);
                        if (picked) return picked;
                    }
                }
            } catch (err) {
                console.warn(`${TAG} | _pickLootIcon rule scan failed for "${name}":`, err);
            }
            // 3) Type-map fallback → 4) FINAL_FALLBACK so we never return undefined/empty
            return typeIconMap[type] || typeIconMap.trinket || FINAL_FALLBACK;
        }

        // Parse gp value for price
        const gpMatch = value.match(/(\d+)\s*gp/i);
        const spMatch = value.match(/(\d+)\s*sp/i);
        const priceGp = gpMatch ? parseInt(gpMatch[1], 10) : (spMatch ? Math.round(parseInt(spMatch[1], 10) / 10) : 0);

        const _esc = (s) => String(s ?? "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

        const realDescHtml = `<section class="ace-engine-item-bio"><em>${_esc(flavor)}</em></section>`;

        const itemData = {
            name: itemName,
            type: "loot",
            img:  _pickLootIcon(itemName, lootType),
            system: {
                description: { value: realDescHtml },
                quantity: 1,
                weight: { value: 0.1 },
                price:  { value: priceGp || 1, denomination: "gp" },
                rarity: (lootType === "magic") ? "common" : (lootType === "potion" || lootType === "scroll") ? "common" : "",
            }
        };

        // ── Unidentified layer (magical items only) ──
        // For magical loot (magic, potion, scroll), if the AI returned an
        // obscured name + description, populate the dnd5e identification
        // schema so the loot dialog (and item sheets) show the obscured
        // version to players until the GM clicks Reveal. Mundane items
        // skip this entirely — they're known on sight.
        const isMagical = (lootType === "magic" || lootType === "potion" || lootType === "scroll");
        if (isMagical && obscuredName && obscuredDesc) {
            const obscuredDescHtml = `<section class="ace-engine-item-bio"><em>${_esc(obscuredDesc)}</em></section>`;
            itemData.system.identified = false;
            itemData.system.unidentified = {
                name: obscuredName,
                description: obscuredDescHtml,
            };
            console.log(`${TAG} | Loot item (unidentified): "${itemName}" hides behind "${obscuredName}".`);
        }

        itemsToCreate.push(itemData);
        console.log(`${TAG} | Loot item: "${itemName}" (${lootType}, ${value})`);
    }

    // ── Write coins to currency ─────────────────────────────────────────
    const hasCurrency = Object.values(currencyAdd).some(v => v > 0);
    if (hasCurrency) {
        const existing = actor.system?.currency || {};
        const update = {};
        for (const [denom, amount] of Object.entries(currencyAdd)) {
            if (amount > 0) {
                update[`system.currency.${denom}`] = (existing[denom] || 0) + amount;
            }
        }
        await actor.update(update);
        console.log(`${TAG} | Coins added to ${npcName}:`, currencyAdd);
    }

    // ── Create loot items ───────────────────────────────────────────────
    if (itemsToCreate.length) {
        await actor.createEmbeddedDocuments("Item", itemsToCreate);
        console.log(`${TAG} | ${itemsToCreate.length} loot item(s) created for ${npcName}.`);
    }

    // Set guard flag
    await flagTarget.setFlag(MODULE_ID, "lootGenerated", true).catch(() => {});

    if (hasCurrency || itemsToCreate.length) {
        console.log(`${TAG} | Loot generation complete for ${npcName}.`);
    }
}

// ─── REAL COMPENDIUM LOOT (via ACE QOL) ─────────────────────────────────────
// After AI flavor loot, add real D&D items from DDB compendiums via ace-qol's
// LootEngine. Graceful no-op if ace-qol isn't installed.

async function _generateRealLoot(tokenDocument, aiCount = 0) {
    try {
        const actor = tokenDocument.actor;
        if (!actor) return;

        const cr = actor.system?.details?.cr ?? 0;
        if (!shouldGenerateLoot(cr)) return;

        // Shared cap (Option C): only top up to the budget the AI pocket-loot left.
        // 0 → the compendium engine adds gold only, no items.
        const budget = Math.max(0, _lootMaxTotal() - (Number(aiCount) || 0));
        const lootData = await generateLoot(tokenDocument, { maxItems: budget });
        if (lootData && (lootData.gold > 0 || lootData.items?.length > 0)) {
            console.log(`${TAG} | Real loot added to ${actor.name}: ${lootData.gold} gp + ${lootData.items?.length ?? 0} items (budget ${budget}, AI took ${aiCount})`);
        }
    } catch (err) {
        console.warn(`${TAG} | Real loot generation failed for ${tokenDocument.actor?.name}:`, err);
    }
}

// ─── SHIMMER EFFECT ──────────────────────────────────────────────────────────
// Red outline glow on the canvas token, auto-removed after 2 seconds.

function _playShimmer(tokenDocument) {
    if (!canvas?.ready) return;

    const canvasToken = canvas.tokens.get(tokenDocument.id);
    if (!canvasToken) return;

    try {
        // v13+: foundry.canvas.rendering.filters; v12: globalThis
        const FilterClass = foundry?.canvas?.rendering?.filters?.OutlineOverlayFilter
                         ?? globalThis.OutlineOverlayFilter
                         ?? null;

        if (FilterClass) {
            const shimmer = new FilterClass({
                outlineColor: [0.9, 0.15, 0.15, 1],   // red — eye-catching
                thickness: 3,
                wave: true,
            });

            const target = canvasToken.mesh ?? canvasToken;
            const origFilters = target.filters ? [...target.filters] : [];
            target.filters = [...origFilters, shimmer];

            // Remove after 2 seconds
            setTimeout(() => {
                try {
                    const t = canvasToken.mesh ?? canvasToken;
                    t.filters = origFilters;
                } catch (_) { /* token may have been removed */ }
            }, 2000);

            return;
        }
    } catch (_) { /* fall through to fallback */ }

    // ── Fallback: sinusoidal alpha pulse ──────────────────────────────────
    const target = canvasToken.mesh ?? canvasToken;
    const origAlpha = target.alpha;
    let elapsed = 0;
    const startTime = performance.now();

    function pulse(now) {
        elapsed = (now - startTime) / 1000;
        if (elapsed > 2) {
            target.alpha = origAlpha;
            return;
        }
        target.alpha = origAlpha * (0.6 + 0.4 * Math.sin(elapsed * Math.PI * 4));
        requestAnimationFrame(pulse);
    }
    requestAnimationFrame(pulse);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Auto-link cleanup — the one-off purge of old auto-linked actors
//  (Johnny 2026-07-10). The enableAutoLink-default-true era (fixed 1.7.12)
//  left orphaned linked actors in the sidebar. This lists every actor carrying
//  the autoLinked flag, pre-checks the SAFE ones (no token on any scene),
//  flags the live ones, and deletes ONLY what the GM ticks and confirms.
// ═════════════════════════════════════════════════════════════════════════════

export async function openAutoLinkCleanup() {
    if (!game.user.isGM) return ui.notifications?.warn("GM only.");

    const candidates = [];
    for (const actor of game.actors) {
        const fl = actor.flags?.[MODULE_ID];
        if (!fl?.autoLinked) continue;
        // Is a linked token for this actor still placed on any scene?
        let liveScene = null;
        for (const scene of game.scenes) {
            if (scene.tokens.some(t => t.actorId === actor.id)) { liveScene = scene.name; break; }
        }
        candidates.push({
            id: actor.id, name: actor.name,
            from: fl.autoLinkedFrom ?? "?",
            at: fl.autoLinkedAt ? fl.autoLinkedAt.slice(0, 10) : "?",
            liveScene,
        });
    }

    if (!candidates.length) {
        return ui.notifications?.info("ACE: no auto-linked actors found — the sidebar is already clean.");
    }
    candidates.sort((a, z) => a.name.localeCompare(z.name));

    const rowsHtml = candidates.map(c => `
        <label style="display:flex;align-items:center;gap:8px;padding:4px 2px;border-bottom:1px solid #2a2a30;cursor:pointer;">
            <input type="checkbox" name="ace-al-clean" value="${c.id}" ${c.liveScene ? "" : "checked"}
                   style="width:16px;height:16px;accent-color:#c9a76b;"/>
            <span style="flex:1;font-size:15px;">${foundry.utils.escapeHTML(c.name)}
                <span style="color:#8a7f68;font-size:12px;">(from ${foundry.utils.escapeHTML(c.from)}, ${c.at})</span>
            </span>
            ${c.liveScene
                ? `<span style="color:#e0885c;font-size:12px;font-weight:700;">ON SCENE: ${foundry.utils.escapeHTML(c.liveScene)}</span>`
                : `<span style="color:#7ec97e;font-size:12px;">no token — safe</span>`}
        </label>`).join("");

    const content = `
        <div class="ace-al-cleanup" style="background:#141118;color:#e8dcc3;border:1px solid #c9a76b;border-radius:8px;padding:12px 14px;max-height:60vh;overflow-y:auto;font-size:16px;">
            <div style="font-weight:700;color:#c9a76b;font-size:17px;"><i class="fas fa-broom"></i> Auto-linked actor cleanup — ${candidates.length} found</div>
            <div style="font-size:13px;color:#9c8f74;margin:4px 0 8px;">
                Leftovers from the old auto-link default. Safe ones (no token anywhere) are pre-checked.
                Ones still standing on a scene are UNCHECKED and marked — deleting those breaks the placed token.
                Nothing is deleted until you click Delete Selected.
            </div>
            ${rowsHtml}
        </div>`;

    new Dialog({
        title: "ACE — Auto-Link Cleanup",
        content,
        buttons: {
            del: {
                icon: '<i class="fas fa-trash"></i>',
                label: "Delete Selected",
                callback: async (html) => {
                    const root = html[0] ?? html;
                    const ids = [...root.querySelectorAll('input[name="ace-al-clean"]:checked')].map(i => i.value);
                    if (!ids.length) return ui.notifications?.info("ACE: nothing selected — nothing deleted.");
                    await Actor.deleteDocuments(ids);
                    ui.notifications?.info(`ACE: deleted ${ids.length} auto-linked actor${ids.length === 1 ? "" : "s"}.`);
                    console.log(`${TAG} | auto-link cleanup: deleted ${ids.length} actors:`, ids);
                },
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" },
        },
        default: "cancel",
    }, { width: 560 }).render(true);
}
