// ─── ACE: Engine — NPC Conversation Window ──────────────────────────────────
// FaceTime-style chat UI for talking to NPCs. Audio + voice + video portrait
// + chat history + close-session summary into the NPC's memory journal.
//
// Moved from ace-envoy/src/ui/ConversationApp.js as part of the
// Envoy → Engine merger. Imports retargeted to engine siblings, settings
// and flag namespace switched ace-envoy.* -> ace-engine.*.

import { AIHandler }                                 from "./conversation-engine.mjs";
import { summarizeAndSaveSession }                   from "./memory.mjs";
import { ttsEngine }                                 from "./tts.mjs";
import { getVoiceConfig, getDynamicVoiceSettings }   from "./voice-engine.mjs";
import { getCreatureSoundCandidates, getVoicePitch } from "./creature-sounds.mjs";
import { npcChatState }                              from "./activate.mjs";
import { isAIFailure }                               from "./ai-failure.mjs";
import * as Lang                                     from "./language-barrier.mjs";

const MODULE_ID = "ace-engine";

/** Drop-in stand-in for the Envoy → Engine bridge (we ARE the engine). */
const EngineBridge = {
    isEngineActive:         () => true,
    filterProfanity:        (...args) => game.modules.get(MODULE_ID)?.api?.filterProfanity?.(...args)        ?? args[0],
    applyDispositionChange: (...args) => game.modules.get(MODULE_ID)?.api?.applyDispositionChange?.(...args) ?? Promise.resolve(),
    getSubtleRolls:         (...args) => game.modules.get(MODULE_ID)?.api?.getSubtleRolls?.(...args)         ?? null,
};

function escapeHtml(str) {
    return String(str)
        .replace(/&/g,  "&amp;")
        .replace(/</g,  "&lt;")
        .replace(/>/g,  "&gt;")
        .replace(/"/g,  "&quot;");
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Confirm dialog: Yes → resolves true, No → resolves false,
 * X button → rejects (caller can catch to cancel the action).
 * Works with Foundry v12+ DialogV2 and legacy Dialog.
 */
async function _envoyConfirmDialog(title, content) {
    const DV2 = foundry.applications?.api?.DialogV2;
    if (DV2) {
        return DV2.confirm({ window: { title }, content, rejectClose: true, yes: { default: true } });
    }
    return new Promise((resolve, reject) => {
        const d = new Dialog({
            title,
            content,
            buttons: {
                yes: { icon: '<i class="fas fa-check"></i>', label: "Yes", callback: () => resolve(true) },
                no:  { icon: '<i class="fas fa-times"></i>', label: "No",  callback: () => resolve(false) }
            },
            default: "yes",
            close: () => reject()   // X button → reject → caller cancels the close
        });
        d.render(true);
    });
}

/** Read a setting without letting an unregistered key throw into a caller.
 *  Returns the fallback and SAYS SO — an absent setting and a broken one must
 *  never look the same in the console. */
function QolSafe(fn, fallback) {
    try {
        const v = fn();
        return (v === undefined || v === null) ? fallback : v;
    } catch (err) {
        console.debug(`ace-engine | setting unavailable, using default (${fallback}):`, err?.message ?? err);
        return fallback;
    }
}


/**
 * How long a player's conversation window sits idle before it releases.
 *
 * Was 30 minutes, on the reasoning that it should cover rule lookups and snack
 * breaks. Johnny cut it to 10 on 2026-08-09: 30 is far longer than any real
 * pause, and a window that stays live that long holds the NPC hostage from
 * everyone else at the table.
 *
 * ⚠️ This is ALSO the cap on conversation time-cost. Talking to an NPC advances
 * the world clock by the real elapsed time, so this constant is what stops a
 * forgotten window from charging the party half an hour for standing in a
 * doorway. It bounds both behaviours — change it and you change both.
 *
 * GM and read-only spectator windows never time out at all; see the guard in
 * `_resetInactivityTimer`.
 */
const CONVERSATION_IDLE_MS = 10 * 60 * 1000;   // 10 minutes

export class ConversationApp extends HandlebarsApplicationMixin(ApplicationV2) {

    constructor(actor, { readOnly = false, isOwner = false, tokenDocument = null, speakerToken = null } = {}) {
        super();
        this.actor      = actor;
        this.isThinking = false;
        this.readOnly      = readOnly;
        this._isOwner      = isOwner;
        this._paused       = false;
        this._audioQueue   = [];
        this._audioPlaying = false;
        this._messageLog    = [];

        // The PC token speaking in this conversation (resolved at creation time).
        // Prevents wrong-speaker bugs when multiple tokens are selected.
        this._speakerToken = speakerToken || null;

        // Store the token document for unlinked-token-aware flag writes.
        // For unlinked tokens, flags must route through the token document (ActorDelta)
        // rather than the base actor, so each token gets its own conversation history.
        this.tokenDocument = tokenDocument || null;

        // Conversation key: token ID for unlinked tokens, actor ID for linked/no-token
        this._convoKey = (tokenDocument && !tokenDocument.actorLink)
                       ? `tok:${tokenDocument.id}`
                       : actor.id;

        // Read from ace-engine flags on the actor (for unlinked tokens,
        // tokenDocument.actor is the synthetic actor with ActorDelta merged flags).
        // Voice flags are always saved to the actor, not the TokenDocument.
        const effectiveActor = (tokenDocument && !tokenDocument.actorLink && tokenDocument.actor)
                             ? tokenDocument.actor : actor;
        this.history    = effectiveActor.getFlag(MODULE_ID, "memoryLog")
                       || actor.flags?.npclink?.memoryLog || [];
        this._voiceId   = effectiveActor.getFlag(MODULE_ID, "voiceId")
                       || actor.flags?.npclink?.voiceId || null;
        this._voiceSettings = effectiveActor.getFlag(MODULE_ID, "voiceSettings") || {};
    }

    /**
     * Compute live voice settings — base settings + dynamic modifiers from HP, conditions, mood.
     * Called right before each TTS call so the voice reacts to the NPC's current state.
     */
    _getLiveVoiceSettings() {
        return getDynamicVoiceSettings(this.actor, this._voiceSettings);
    }

    _shouldRender(options) {
        if (!this.rendered) return true;
        if (options?.force) return true;
        return false;
    }

    _canRender(options) {
        if (!this.rendered) return true;
        if (options?.force) return true;
        return false;
    }

    render(options = {}, _opts = {}) {
        if (!this.rendered || options === true || options?.force || _opts?.force) {
            return super.render(options, _opts);
        }
        return this;
    }

    static DEFAULT_OPTIONS = {
        window: { title: "ACE: NPC Chat", resizable: true, minimizable: true },
        position: { width: 600, height: 850 },
        classes:  [MODULE_ID],
    };

    get id() {
        if (!this._uniqueId) this._uniqueId = `ace-engine-${foundry.utils.randomID()}`;
        return this._uniqueId;
    }

    /** Display name: prefer token name (e.g. "Grimfang") over base actor name (e.g. "Otyugh"). */
    get npcName() {
        return this.tokenDocument?.name || this.actor.name;
    }

    /**
     * "Ogre (1) — speaking with Chud", shown in the window title bar AND on the
     * label under the portrait, identically on EVERY client.
     *
     * Johnny 2026-08-06: with several conversations open, or a spectator
     * watching someone else's, "ACE: NPC Chat" over a picture of an ogre says
     * nothing about whose scene this is. Naming both parties makes each window
     * self-describing at a glance.
     */
    get conversationTitle() {
        const npc = this.npcName;
        // `_speakerNameHint` is the name the SENDER told us when this client
        // couldn't resolve their token (different scene, not yet drawn). A
        // right name beats a resolved-but-wrong creature, so it outranks the
        // guess and sits just under the real token. (2026-08-07)
        const who = this._speakerToken?.actor?.name
                 ?? this._speakerNameHint
                 ?? this.speakingAs?.name
                 ?? this._playerName
                 ?? game.user.character?.name
                 ?? null;
        return who && who !== npc ? `${npc} — speaking with ${who}` : npc;
    }

    /** The PC actor speaking in this conversation (resolved once at creation). */
    get speakingAs() {
        // If a speaker was explicitly set at conversation creation, use it
        if (this._speakerToken?.actor) return this._speakerToken.actor;

        // Fallback: derive from current state (legacy path)
        if (game.user.isGM) {
            const sel = canvas.tokens?.controlled?.[0];
            if (sel && sel.actor?.id !== this.actor.id) return sel.actor;
        }
        // ── THE LAST-RESORT GUESS, AND IT USED TO GUESS BADLY (2026-08-07) ──
        // Old test: "first token that has a player owner AND that I own".
        //
        // On a GM client the second half does NOTHING — a GM owns every actor
        // in the world — so it degenerated to "first player-owned token in
        // canvas order". Johnny's first was an Artificer's STEEL DEFENDER:
        // player-owned, but a companion, not a person. Every window on his
        // screen read "Vilnius — speaking with Steel Defender" while his six
        // actual characters sat behind it in the same list.
        //
        // Two changes:
        //  • Ask "does a real PLAYER own this?" (a non-GM user), which means
        //    something on every client, instead of "do I own this?".
        //  • Prefer an actual character. A companion — Steel Defender, a
        //    familiar, a summon — is only ever a fallback, and only when there
        //    is no real character to be found.
        // Ranked, so the order tokens happen to sit in on the canvas can never
        // decide who the party is talking as.
        const _ownedByAPlayer = (a) => {
            try { return game.users.some(u => u.active && !u.isGM && a?.testUserPermission?.(u, "OWNER")); }
            catch (_) { return false; }
        };
        const pool = (canvas.tokens?.placeables ?? []).filter(t =>
            t.actor
            && t.document?.actorId !== this.actor.id
            && (_ownedByAPlayer(t.actor) || t.actor.hasPlayerOwner)
        );
        // 1. A real character an online player owns — the overwhelmingly right answer.
        let pick = pool.find(t => t.actor.type === "character" && _ownedByAPlayer(t.actor));
        // 2. Any real character with a player owner (their player may be offline).
        pick ??= pool.find(t => t.actor.type === "character");
        // 3. Only now consider a companion / summon.
        pick ??= pool[0];
        return pick?.actor ?? game.user.character ?? null;
    }

    /**
     * WHO IS SPEAKING — sent with every broadcast so the receiving client is
     * TOLD instead of guessing. (2026-08-07)
     *
     * A spectator/GM window is opened by the socket handler when a message
     * arrives, and that handler had no idea who the player was — so it fell
     * through to the `speakingAs` guess above. On a GM client that guess is
     * worthless: it filters for "a player-owned token I own", and a GM owns
     * EVERY actor, so it simply took the first player-owned token in canvas
     * order. Johnny's was an Artificer's Steel Defender, so every window on his
     * screen read "Vilnius — speaking with Steel Defender" while the player's
     * own window correctly said Chudd Buckland.
     *
     * ⚠️ Only ever sends a speaker we actually KNOW — one captured at
     * conversation start. Never the guess. Broadcasting a guess would spread
     * the wrong answer to every client instead of leaving it on one.
     */
    /**
     * WHICH LANGUAGE THIS NPC IS SPEAKING RIGHT NOW. (2026-08-07)
     *
     * The GM's dropdown when they have made a choice; otherwise the creature's
     * default — Common when it knows it, else its own first language. Never a
     * language the creature does not know.
     *
     * Used to tag the chat message so Polyglot renders it in that script. One
     * reader so the three places the NPC's words reach chat cannot drift apart.
     */
    _spokenLanguage() {
        try {
            if (this._npcLanguage) return this._npcLanguage;
            return Lang.defaultLanguageFor(this.actor);
        } catch (_) { return null; }
    }

    /**
     * IS THIS CREATURE DEAD? (Johnny 2026-08-07)
     *
     * ⚠️ THE BUG THIS EXISTS FOR. Jeth killed Savid — 3 slashing, 3 → 0, the
     * death pipeline ran, the token became a corpse, the loot card posted, and
     * ace-engine's OWN log said "Death ripple: Savid fell — moved to X ☠ Fallen
     * folder". Twenty-two seconds later Jeth asked "how do you feel now elf?"
     * and the corpse replied "Savid feel... stronger. No more pain. Ready to
     * face what comes next."
     *
     * The information was never missing — the prompt already carries hit
     * points, which is exactly how he correctly described being wounded at 1 HP
     * earlier in the same conversation. What was missing was a RULE. Nothing
     * anywhere said a dead creature does not talk. Building a profile is not
     * consulting it.
     *
     * Reads the same markers the rest of the suite writes, in order of
     * authority: ace-qol's death flag, the dnd5e "dead" status, then hit
     * points. Any one of them is enough.
     */
    get isDeadNow() {
        try {
            // Re-read the token from the scene rather than trusting the copy
            // captured at construction — the death flag is written after this
            // window opened, so a stale reference would report "alive" forever.
            const held = this.tokenDocument ?? null;
            const td = (held?.id && held?.parent?.tokens?.get?.(held.id)) || held;
            if (td?.flags?.["ace-qol"]?.isDead === true) return true;

            const a = td?.actor ?? this.actor;
            if (!a) return false;
            if (a.statuses?.has?.("dead")) return true;
            // A PC at 0 is unconscious and dying, not dead — they can still be
            // spoken to. Only an NPC is finished at 0.
            const hp = Number(a.system?.attributes?.hp?.value ?? 1);
            if (a.type === "npc" && hp <= 0) return true;
            return false;
        } catch (err) {
            // Never let a state read silence a living NPC — fail toward alive
            // and say so, rather than mute a scene on a lookup error.
            console.warn(`${MODULE_ID} | couldn't read life state for ${this.npcName} — treating as alive:`, err);
            return false;
        }
    }

    /**
     * Lock the conversation because the creature is dead.
     *
     * Johnny's call: PLAYERS are locked out, the GM can still puppet. A dying
     * word, a ghost, an undead that talks, or simply narrating through the body
     * are all legitimate — taking the tool off the GM would be worse than the
     * bug. The AI never speaks for a corpse again either way.
     */
    _applyDeathLock({ announce = true } = {}) {
        if (this._deathLocked) return;
        this._deathLocked = true;
        try {
            if (announce) {
                this.renderMessage("system", game.user.isGM
                    ? `${this.npcName} is dead. Players can no longer speak here; you can still speak as ${this.npcName}.`
                    : `${this.npcName} is dead.`);
            }
            if (!game.user.isGM) {
                this._setInputLocked(true, "");
                if (this._recognition) { try { this._stopMic({ send: false }); } catch (_) {} }
            }
            this.element?.classList?.add?.("ace-engine-dead");
        } catch (err) {
            console.warn(`${MODULE_ID} | death lock failed for ${this.npcName}:`, err);
        }
    }

    /**
     * WHAT THE ROOM HEARS, when the NPC is speaking a tongue the listener
     * cannot follow. (2026-08-07 — replaces the [SPOKEN] marker.)
     *
     * Takes the finished English line, renders it in the stand-in language, and
     * hands back what the voice should say. Used by BOTH the AI's replies and
     * the GM's own "Speak as NPC" lines, so they can never behave differently —
     * the marker approach only ever covered the first, which is why Johnny's
     * puppet lines came out in English while the chat was scrambled.
     *
     * Returns null when nothing should change: substitution off, no barrier,
     * Common, no real dialogue, or the render failed. Every one of those means
     * "just say it in English" — losing the line entirely would be worse than
     * saying it plainly.
     */
    async _foreignAudioFor(fullText) {
        try {
            const dialogue = String(fullText ?? "").replace(/\*(.*?)\*/g, "").replace(/\s{2,}/g, " ").trim();
            if (!dialogue) return null;                       // pure action — nothing is said

            const tongue = this._spokenLanguage();
            if (!Lang.shouldSubstituteAudio(tongue, this.speakingAs)) return null;

            const real = Lang.spokenLanguageFor(tongue);      // null => invented sounds
            const said = await AIHandler.renderSpoken(dialogue, real, Lang.labelFor(tongue));
            return said || null;
        } catch (err) {
            console.warn(`${MODULE_ID} | foreign audio unavailable — speaking in English:`, err);
            return null;
        }
    }

    /**
     * The language to stamp on a chat message — but ONLY if that message is
     * actually SPEECH. (Johnny 2026-08-07)
     *
     * ⚠️ Polyglot scrambles the WHOLE message (`content.innerHTML =
     * scrambleString(innerText, …)`) — there is no per-span option for chat. So
     * stamping the language on a message that carries an *emote* scrambled the
     * NARRATION: Johnny watched "Savid raises an eyebrow, crossing his arms"
     * turn into Dwarvish runes. What a creature DOES is public — everyone in
     * the room can see him fold his arms. Only what he SAYS is hidden.
     *
     * An emote-only reply therefore gets no language flag at all and posts in
     * plain text, which is exactly right.
     */
    _chatLanguageFor(bodyText) {
        try {
            const dialogue = String(bodyText ?? "").replace(/\*(.*?)\*/g, "").trim();
            if (!dialogue) return null;        // pure action — never scramble it
            return this._spokenLanguage();
        } catch (_) { return null; }
    }

    _speakerPayload() {
        const tok = this._speakerToken;
        if (!tok) return {};
        return {
            speakerTokenId: tok.id ?? tok.document?.id ?? null,
            speakerActorId: tok.actor?.id ?? null,
            speakerName:    tok.actor?.name ?? tok.name ?? null,
        };
    }

    static PARTS = {
        // NOTE: template still lives in modules/ace-envoy/templates/. Will be
        // copied to modules/ace-engine/templates/ in Phase 3 (envoy shim).
        main: { template: "modules/ace-engine/templates/conversation-app.html" }
    };

    async _prepareContext(options) {
        return {
            actorName: this.npcName,
            actorImg:  this._getPortraitImage(),
            isGM:      game.user.isGM
        };
    }

    /**
     * Returns the best available portrait image for this NPC.
     * Priority: actor portrait → placed token texture → prototype token texture → mystery-man fallback.
     */
    _getPortraitImage() {
        const FALLBACK = "icons/svg/mystery-man.svg";
        const isMystery = (img) => !img || img.includes("mystery-man");

        // 1. Actor portrait (the "full art" image)
        if (!isMystery(this.actor.img)) return this.actor.img;

        // 2. Placed token texture (the image on the canvas)
        const tokenTex = this.tokenDocument?.texture?.src;
        if (!isMystery(tokenTex)) return tokenTex;

        // 3. Prototype token texture (the default token image on the actor sheet)
        const protoTex = this.actor.prototypeToken?.texture?.src;
        if (!isMystery(protoTex)) return protoTex;

        return FALLBACK;
    }

    _onRender(context, options) {
        const el = this.element;

        // Guard: prevent double-registering listeners on re-render
        const isReRender = this._listenersAttached;

        const freshLog = el.querySelector("#ace-engine-log");

        // ── Restore previous conversation from history if visual log is empty ──
        // This ensures the GM (or anyone reopening) sees the full conversation.
        if (freshLog && !this._messageLog?.length && this.history?.length) {
            for (const entry of this.history) {
                // Strip action text and subtle check tags for display (same as renderMessage)
                let displayContent = entry.content;
                if (entry.role === "assistant") {
                    displayContent = displayContent.replace(/\[SUBTLE_CHECK:[^\]]+\]/g, "");
                    displayContent = displayContent.replace(/\[DISPOSITION:[^\]]+\]/gi, "");
                    displayContent = displayContent.replace(/\*(.*?)\*/g, "").replace(/\s{2,}/g, " ").trim();
                }
                if (!displayContent) continue;
                const html = escapeHtml(displayContent);
                if (!this._messageLog) this._messageLog = [];
                this._messageLog.push({ role: entry.role, html });

                const div = document.createElement("div");
                div.className = `ace-engine-message ace-engine-${entry.role}`;
                div.innerHTML = `<div class="ace-engine-bubble">${html}</div>`;
                freshLog.appendChild(div);
            }
            requestAnimationFrame(() => { freshLog.scrollTop = freshLog.scrollHeight; });
        } else if (freshLog && this._messageLog?.length) {
            // ── Re-render existing visual log (e.g. after ApplicationV2 re-render) ──
            for (const msg of this._messageLog) {
                const div = document.createElement("div");
                div.className = `ace-engine-message ace-engine-${msg.role}`;
                div.innerHTML = `<div class="ace-engine-bubble">${msg.html}</div>`;
                freshLog.appendChild(div);
            }
            requestAnimationFrame(() => { freshLog.scrollTop = freshLog.scrollHeight; });
        }

        this._logContainer      = freshLog;
        this._inputField        = el.querySelector("#ace-engine-input");
        this._sendBtn           = el.querySelector("#ace-engine-send");
        this._micBtn            = el.querySelector("#ace-engine-voice");
        this._micSelect         = el.querySelector("#ace-engine-mic-device");
        this._micLevelBar       = el.querySelector("#ace-engine-mic-level");
        this._thinkingIndicator = el.querySelector("#ace-engine-thinking");
        this._nameLabel         = el.querySelector("#ace-engine-npc-name");
        this._portraitImg       = el.querySelector("#ace-engine-portrait");

        this._thinkingIndicator.style.display = "none";

        // Name BOTH parties, on every client — frame title and portrait label.
        this._applyConversationTitle();

        // Only register event listeners once (prevents stacking on re-render)
        if (!isReRender) {
            // ⚠️ EVERY ENTRY POINT IS WRAPPED (2026-08-06). handleSend is async,
            // and `() => this.handleSend()` discards the promise — so anything it
            // throws became an unhandled rejection: no toast, no context, and in
            // Foundry's console easy to miss entirely. The player just saw their
            // message appear and nothing happen. Name the source and the error.
            const guard = (label, fn) => async (...a) => {
                try { await fn(...a); }
                catch (err) {
                    console.error(`${MODULE_ID} | ${label} failed:`, err);
                    ui.notifications?.error(`ACE: ${label} failed — ${err?.message ?? err}. See the console (F12).`);
                    this.setThinking(false);
                    this._setInputLocked(false);
                }
            };
            this._sendBtn.addEventListener("click",   guard("Send", () => this.handleSend()));
            this._micBtn.addEventListener("click",    guard("Microphone", () => this.handleMic()));
            this._sendGuard = guard("Send", () => this.handleSend());
            this._initMicPicker();
            // A creature nobody bothered to name gets one NOW — see below.
            this._ensureIdentity();
            // Measure AFTER the browser has laid the row out, and again once
            // webfonts land — a fallback font measures narrower than the real
            // one, which is how a "fitted" row still clips a letter.
            requestAnimationFrame(() => this._fitWidthToControls());
            try { document.fonts?.ready?.then(() => this._fitWidthToControls()); } catch (_) {}
            // Use `keydown` (not the deprecated `keypress`) and stop ALL
            // keyboard events from propagating to Foundry's global keybinding
            // system. Without `stopPropagation`, Backspace inside the chat
            // textarea triggers Foundry's "delete selected token" hotkey and
            // obliterates the player's character. Same risk exists for
            // Delete, Tab, Ctrl+Z, arrow keys, and any future Foundry binding.
            //
            // `isComposing` check prevents IME composition-end events from
            // firing a phantom Enter — that was the source of the
            // "duplicate message on fast Enter" symptom: IME flushes its
            // buffer with an Enter keydown that we'd otherwise treat as a
            // send command alongside the user's actual Enter.
            this._inputField.addEventListener("keydown", (ev) => {
                ev.stopPropagation();
                if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
                    ev.preventDefault();
                    // Enter while dictating means "that is my sentence, send it"
                    // — stop the mic FIRST so a late result cannot repopulate
                    // the box after the message has gone. (2026-08-06)
                    if (this._recognition) { this._stopMic({ send: true }); return; }
                    this._sendGuard();
                }
                // Escape abandons a dictation without sending it.
                if (ev.key === "Escape" && this._recognition) {
                    ev.preventDefault();
                    this._stopMic({ send: false });
                    this._inputField.value = "";
                }
            });
            // ALSO stop keyup propagation — Foundry's keybinding system fires
            // on keyup for some bindings (e.g., release-delete for token
            // delete), so a keydown-only stopPropagation isn't sufficient.
            this._inputField.addEventListener("keyup", (ev) => {
                ev.stopPropagation();
            });
            // Auto-grow textarea as user types or dictates (capped at max-height)
            this._inputField.addEventListener("input", () => {
                this._inputField.style.height = "auto";
                this._inputField.style.height = Math.min(this._inputField.scrollHeight, 100) + "px";
            });

            // ── Animated portrait: probe for a token-name / actor-name .webp ──
            // Plays only while the NPC speaks dialogue. Falls through silently
            // when no file is present (current static portrait stays).
            this._initSpeakingPortrait();

            // ── Pre-warm the Chat-tier model (v1.6.12) ─────────────────
            // Fire a tiny throwaway request to load the model into VRAM
            // so the user's first real message gets a hot model. Only
            // does anything for local providers (Ollama / LM Studio);
            // skipped for cloud automatically inside warmUp(). Fire-and-
            // forget — never blocks the dialog from rendering.
            AIHandler.warmUp();

            this._listenersAttached = true;
        }

        // ── Inject manual minimize + close buttons in header ──────────────
        // Foundry V13 ApplicationV2's default chrome controls don't always
        // render here (engine's main panel hits the same issue). Without a
        // close button, the player can't exit the conversation — they'd
        // have to F5 reload Foundry. Inject manual buttons every render so
        // they're guaranteed to appear regardless of V13's chrome state.
        const header = el.querySelector(".window-header, header");
        if (header) {
            // Detect whether V13 already rendered its native close — match
            // every variant we've seen across V13 sub-versions.
            const hasNativeClose = !!header.querySelector(
                "button.close, button[data-action='close'], button[data-tooltip='Close'], .header-control[data-action='close']"
            );

            // Minimize
            if (!header.querySelector(".ace-engine-btn-minimize")) {
                const minBtn = document.createElement("button");
                minBtn.className = "header-control ace-engine-btn-minimize";
                minBtn.type = "button";
                minBtn.title = "Minimize";
                minBtn.innerHTML = '<i class="fas fa-minus"></i>';
                minBtn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    this.minimize();
                });
                header.appendChild(minBtn);
            }

            // Close (only when V13 didn't render its own — never duplicate)
            if (!hasNativeClose && !header.querySelector(".ace-engine-btn-close")) {
                const closeBtn = document.createElement("button");
                closeBtn.className = "header-control ace-engine-btn-close";
                closeBtn.type = "button";
                closeBtn.title = "Close conversation";
                closeBtn.innerHTML = '<i class="fas fa-xmark"></i>';
                closeBtn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    this.close().catch(err => {
                        console.error(`${MODULE_ID} | Conversation close failed:`, err);
                        // Last-resort: rip the DOM out so the user is unstuck
                        try { this.element?.remove(); } catch (_) {}
                    });
                });
                header.appendChild(closeBtn);
            }
        }

        // ── GM-only controls ──────────────────────────────────────────────
        if (game.user.isGM) {
            // Update send button tooltip — GM sends as NPC, not to AI
            // GM sends are NPC dialogue, so say so on the button itself.
            // Johnny 2026-08-07: on the GM's window the MIC is the thing that
            // voices the NPC, so that is where the label belongs. Send is just
            // send — the paper plane says it, and a word beside it only crowds
            // the row.
            if (this._micBtn) {
                this._micBtn.title = "Speak as this NPC out loud";
                const mlbl = this._micBtn.querySelector("span");
                if (mlbl) mlbl.textContent = "Speak as NPC";
            }
            if (this._sendBtn) {
                this._sendBtn.title = "Speak as this NPC";
                const lbl = this._sendBtn.querySelector("span");
                if (lbl) lbl.remove();
                this._sendBtn.classList.add("ace-engine-pill-icon");
            }

            // ── WHICH TONGUE IS HE SPEAKING (2026-08-07) ──────────────────
            // Only languages this creature actually knows. Defaults to Common
            // when it has it, otherwise its own first language — a creature
            // must never default to speaking something it does not know.
            // Hidden when there is nothing to choose between.
            this._langSelect = el.querySelector("#ace-engine-npc-language");
            if (this._langSelect) {
                try {
                    const rows = Lang.speakableLanguages(this.actor);
                    if (rows.length > 1) {
                        const chosen = this._npcLanguage ?? Lang.defaultLanguageFor(this.actor);
                        this._langSelect.innerHTML = rows
                            .map(r => `<option value="${r.key}"${r.key === chosen ? " selected" : ""}>${r.label}</option>`)
                            .join("");
                        this._npcLanguage = chosen;
                        this._langSelect.style.display = "";
                        if (!isReRender) {
                            this._langSelect.addEventListener("change", (ev) => {
                                this._npcLanguage = ev.target.value || null;
                                console.log(`ACE: Engine | ${this.npcName} will speak ${Lang.labelFor(this._npcLanguage)}.`);
                            });
                        }
                    } else {
                        // One language (or none) — nothing to pick, so don't
                        // show a control that cannot change anything. Still
                        // record it so the chat message is tagged correctly.
                        this._npcLanguage = rows[0]?.key ?? null;
                        this._langSelect.style.display = "none";
                    }
                } catch (err) {
                    console.warn(`${MODULE_ID} | language dropdown unavailable:`, err);
                }
            }

            // END IT ON THE PLAYERS' SCREENS, KEEP MINE. (2026-08-07)
            // The old red button ended the whole conversation including the
            // GM's own window; that job now lives here, and the red button is
            // a pure audio kill for everyone (wired OUTSIDE this GM block).
            const endPlayersBtn = el.querySelector("#ace-engine-end-players");
            endPlayersBtn?.addEventListener("click", () => {
                Dialog.confirm({
                    title: "Close on players' screens?",
                    content: `<p>Close the conversation with <strong>${escapeHtml(this.npcName)}</strong> on every player's screen?</p>`
                           + `<p style="opacity:.8;font-size:13px;">Your window stays open so you can read it back.</p>`,
                    yes: () => this._endForPlayers(),
                    no:  () => {}
                });
            });
        }

        // ── GM's perception readout (2026-08-07) ────────────────────────
        // Fed by the scan that runs before every reply, so the GM can see what
        // the creature was reacting to — and catch it instantly when the scan
        // is wrong. GM-only: the element does not exist on a player's client.
        if (game.user.isGM && !isReRender) {
            this._perceptionEl = el.querySelector("#ace-engine-perception");
            this._perceptionHook = Hooks.on(`${MODULE_ID}.perceptionScan`, (data) => {
                try {
                    if (data?.actorId !== this.actor?.id) return;
                    const box = this._perceptionEl
                        ?? this.element?.querySelector?.("#ace-engine-perception");
                    if (!box || !data.line) return;
                    box.textContent = data.line;
                    box.style.display = "";
                } catch (_) { /* cosmetic — never block a reply */ }
            });
        }

        // Opened onto a body — a window can be opened AFTER the death, or
        // reopened later, and the death hook has long since fired. Check the
        // state rather than relying on having been present for the event.
        if (this.isDeadNow) this._applyDeathLock({ announce: !isReRender });

        // ── STOP AUDIO — every client, including spectators ─────────────
        // Wired BEFORE the spectator bail below on purpose: someone watching a
        // conversation they are not part of is exactly the person most likely
        // to want the narration to shut up. No confirm dialog — a stop button
        // that asks a question is not a stop button. (2026-08-07)
        const stopAudioBtn = el.querySelector("#ace-engine-stop-all");
        if (stopAudioBtn && !isReRender) stopAudioBtn.addEventListener("click", () => {
            ConversationApp.silenceEverything("local");
            game.socket.emit(`module.${MODULE_ID}`, {
                action:   "aceStopAudio",
                senderId: game.user.id,
                who:      game.user.name,
            });
            ui.notifications?.info("Audio stopped.");
        });

        // ── Spectator (readOnly) — lock EVERYTHING and bail ─────────────
        if (this.readOnly) {
            this._setUILocked(true, "You are observing this conversation.");
            return;  // ← no pause, no input, no mic — spectators are view-only
        }

        // ── Pause button — only active player + GM can pause ────────────
        // ⚠️ WIRED ONCE. This sat OUTSIDE the isReRender guard above, so it
        // gained a fresh listener on EVERY render — and this window re-renders
        // on every message. Click it after an even number of renders and the
        // handler toggled `_paused` an even number of times: net zero, plus
        // pause()/resume() racing each other. That is the whole of "Pause does
        // not work". (2026-08-06)
        const pauseBtn = el.querySelector("#ace-engine-pause");
        if (pauseBtn && !isReRender) pauseBtn.addEventListener("click", () => {
            this._paused = !this._paused;
            if (this._paused) {
                ttsEngine.pause();
                // PAUSE MEANS PAUSE. A live recogniser kept transcribing into a
                // box the player can no longer see or correct. Stop it — WITHOUT
                // sending — so nothing is lost and nothing is fired off while
                // the conversation is held. Whatever is already typed or
                // dictated stays exactly where it is; pressing the mic after
                // resuming continues from it (see _startMic). (2026-08-07)
                if (this._recognition) {
                    try { this._stopMic({ send: false }); } catch (_) { /* already stopped */ }
                }
            } else {
                ttsEngine.resume();
            }
            game.socket.emit(`module.${MODULE_ID}`, {
                action:   "pauseAudio",
                paused:   this._paused,
                actorId:  this.actor.id,
                tokenId:  this.tokenDocument?.id || null,
                senderId: game.user.id,
                isGM:     game.user.isGM
            });
            // ONE button, ONE job. It used to swap its icon to a Play arrow,
            // which meant the control people were looking for had visibly
            // changed into something else. Now the label and icon stay put and
            // only the COLOUR moves: red while paused, brass while running.
            pauseBtn.classList.toggle("ace-engine-paused", this._paused);
            pauseBtn.title = this._paused
                ? "Conversation paused — press to continue"
                : "Pause the conversation — press again to continue";
            this._setInputLocked(this._paused, this._paused ? "Conversation paused." : "");
        });

        // Cache the player's scene identity at conversation start.
        // Uses the speakingAs getter which respects the resolved speaker token.
        if (!this._playerName && !game.user.isGM) {
            this._playerName = this.speakingAs?.name ?? game.user.character?.name ?? game.user.name;
        }

        // Conversation lock — at most ONE player at a time owns an open
        // chat. Acquire here when a player opens a new window. If a lock
        // is already held by someone else (any NPC, any player), demote
        // this window to read-only spectator. GM is exempt.
        const npcLocks = npcChatState?.npcLocks;
        if (!game.user.isGM && npcLocks) {
            const actorLock = npcLocks.get(this.actor.id);
            const heldBySomeoneElse = actorLock?.userId && actorLock.userId !== game.user.id;
            if (heldBySomeoneElse) {
                this.readOnly = true;
                this._isOwner = false;
                this._setUILocked(true, `${escapeHtml(this.npcName)} — another player is in conversation.`);
            } else {
                const actorId = this.actor.id;
                const lockInfo = {
                    userId:   game.user.id,
                    userName: game.user.name,
                    tokenId:  this.tokenDocument?.id || null,
                    convoKey: this._convoKey,
                };
                npcLocks.set(actorId, lockInfo);
                game.socket.emit(`module.${MODULE_ID}`, {
                    action: "lockSet", actorId, lockInfo,
                });
                this._lockedActorId = actorId;
                this._lockPlayerToken(true);
                this._watchForSceneChange();
            }
        }

        this._resetInactivityTimer();

        // ── Eagerly assign a voice if none is set ────────────────────────
        // Prevents re-randomization on each handleSend() call.
        if (!this.readOnly && !this._voiceId) {
            this._initVoice().catch(e => console.warn("ACE: Engine | Voice init failed:", e));
        }

        console.log(`ACE: Engine | UI Listeners activated for ${this.npcName}`);
    }

    /** Pick and persist a voice immediately so it's locked before any messages. */
    async _initVoice() {
        // Use the Voice Engine to get voiceId + voiceSettings together
        const config = await getVoiceConfig(this.actor, this.tokenDocument);
        this._voiceId = config.voiceId;
        this._voiceSettings = config.voiceSettings || {};
        console.log(`ACE: Engine | Voice initialized: ${config.voiceId}`, this._voiceSettings);
    }

    /**
     * Re-read voice config from actor flags (live).
     * Called before each TTS call so that GM changes in AI Setup
     * take effect immediately — even in a running conversation.
     */
    _refreshVoiceFromFlags() {
        const effectiveActor = (this.tokenDocument && !this.tokenDocument.actorLink && this.tokenDocument.actor)
                             ? this.tokenDocument.actor : this.actor;
        const flagVoiceId = effectiveActor.getFlag?.(MODULE_ID, "voiceId")
                         || this.actor.flags?.npclink?.voiceId || null;
        const flagSettings = effectiveActor.getFlag?.(MODULE_ID, "voiceSettings") || null;
        if (flagVoiceId && flagVoiceId !== this._voiceId) {
            console.log(`ACE: Engine | Voice updated from flags: ${this._voiceId} → ${flagVoiceId}`);
            this._voiceId = flagVoiceId;
            if (flagSettings) this._voiceSettings = flagSettings;
        } else if (flagVoiceId && flagSettings) {
            this._voiceSettings = flagSettings;
        }
    }

    /**
     * KILL EVERY VOICE ON THIS CLIENT, RIGHT NOW. (2026-08-07)
     *
     * Johnny: "sometimes these things are going on and on and people don't want
     * to hear it — dig deep for that." So this does not politely ask the TTS
     * engine to stop; it goes after every route sound can be leaving by, and
     * each one is independently guarded so a missing module cannot stop the
     * rest from being silenced.
     *
     *   1. ACE's own TTS engine  — the ElevenLabs / GM-proxy audio path.
     *   2. Browser speechSynthesis — the fallback voice, which lives OUTSIDE
     *      the TTS engine's own state and kept talking when only step 1 ran.
     *      This is why "stop" felt like it did nothing: the engine reported
     *      itself stopped while the browser carried on to the end of the line.
     *   3. Any loose <audio>/<video> element ACE created.
     *   4. Sequencer sounds, if it is installed.
     *   5. Foundry's own audio helper — a narration played through it is not
     *      the TTS engine's to stop.
     *
     * Static so a client can silence itself with no conversation window open.
     */
    static silenceEverything(reason = "local") {
        let killed = [];
        try { ttsEngine?.stop?.();                     killed.push("ACE TTS"); } catch (_) {}
        try {
            // The NARRATOR's audio is a bare `new Audio(url)` held in a module
            // variable — it is NOT in the DOM, so the element sweep below can
            // never see it. ace-engine already owns a killer for it and puts it
            // on the module API; use that rather than reaching into its guts.
            // This is the one that matters when a narration is "going on and
            // on" — miss it and the stop button feels broken.
            const api = game.modules.get("ace-engine")?.api;
            if (typeof api?.stopAllAudio === "function") { api.stopAllAudio(); killed.push("narration"); }
        } catch (_) {}
        try {
            // The browser voice is its own beast — cancel() twice, because a
            // queued utterance can start between the cancel and the next tick.
            if (window.speechSynthesis) {
                window.speechSynthesis.cancel();
                setTimeout(() => { try { window.speechSynthesis.cancel(); } catch (_) {} }, 60);
                killed.push("browser voice");
            }
        } catch (_) {}
        try {
            for (const el of document.querySelectorAll("audio, video")) {
                if (el.paused) continue;
                el.pause();
                try { el.currentTime = 0; } catch (_) {}
                killed.push("media element");
            }
        } catch (_) {}
        try {
            if (globalThis.Sequencer?.SoundManager?.stop) {
                globalThis.Sequencer.SoundManager.stop();
                killed.push("Sequencer sound");
            }
        } catch (_) {}
        try {
            // Foundry's audio helper. Never call a global bare — if the shape
            // is not what we expect, say so instead of pretending it worked.
            const ah = globalThis.game?.audio;
            if (ah?.playing?.size) {
                for (const snd of [...ah.playing.values()]) { try { snd.stop(); } catch (_) {} }
                killed.push("Foundry audio");
            }
        } catch (_) {}
        console.log(`ACE: Engine | STOP AUDIO (${reason}) — silenced: ${killed.length ? [...new Set(killed)].join(", ") : "nothing was playing"}`);
        return killed;
    }

    /**
     * Close this conversation on every PLAYER's screen and leave the GM's open.
     * (Johnny 2026-08-07 — he wants to keep reading it back after cutting the
     * players loose.) Distinct from _gmStopAll, which also closes his own.
     */
    async _endForPlayers() {
        ConversationApp.silenceEverything("gm ended for players");
        game.socket.emit(`module.${MODULE_ID}`, {
            action:   "aceStopAudio",
            senderId: game.user.id,
            who:      game.user.name,
        });
        game.socket.emit(`module.${MODULE_ID}`, {
            action:   "endConversationForPlayers",
            actorId:  this.actor.id,
            tokenId:  this.tokenDocument?.id || null,
            senderId: game.user.id,
        });
        // The players are gone, so nobody is holding the conversation open —
        // free the slot but keep this window on screen.
        try {
            const map = npcChatState?.openConversations;
            if (map?.get?.(this._convoKey) === this) map.delete(this._convoKey);
        } catch (_) {}
        this._setInputLocked(true, "");
        ui.notifications?.info(`Closed "${this.npcName}" on the players' screens. Yours is still open.`);
    }

    /** Drop the perception listener — an un-removed hook leaks for every window
     *  the GM ever opens, and they all fire on every scan. */
    _releasePerceptionHook() {
        try {
            if (this._perceptionHook != null) {
                Hooks.off(`${MODULE_ID}.perceptionScan`, this._perceptionHook);
                this._perceptionHook = null;
            }
        } catch (_) { /* already gone */ }
    }

    async _gmStopAll() {
        ttsEngine.stop();
        game.socket.emit(`module.${MODULE_ID}`, {
            action:  "gmDismiss",
            actorId: this.actor.id,
            tokenId: this.tokenDocument?.id || null,
            source:  "gm"
        });
        npcChatState?.openConversations?.delete?.(this._convoKey);
        this._gmForced = true;
        // close() handles summarization in the background — no need to double-summarize
        this.close();
    }

    async handlePuppet() {
        // Puppet now uses the shared input field (no separate textarea)
        const raw = this._inputField?.value?.trim();
        if (!raw) return;
        // The GM MAY speak as a dead creature — dying words, a ghost, an undead
        // that talks, or simply narrating through the body. (Johnny's call.)
        // Noted once so it is never a surprise that the corpse said something.
        if (this.isDeadNow && !this._deadPuppetNoted) {
            this._deadPuppetNoted = true;
            console.log(`${MODULE_ID} | ${this.npcName} is dead — GM is speaking as them deliberately.`);
        }
        // Stop any in-progress TTS before puppet speaks
        if (ttsEngine.isPlaying) ttsEngine.stop();
        this._inputField.value = "";

        // ── RE-VOICE THE GM'S LINE IN CHARACTER (Johnny 2026-08-07) ─────────
        // A typed line goes to the speech engine exactly as written, and
        // "What do you mean?" is four words and one question mark — there is
        // nothing there to perform, so it lands flat and robotic no matter how
        // good the voice is. The AI's own lines only sound better because they
        // are longer and better punctuated. This gives the GM's line the same
        // treatment: same meaning, same length, his rhythm.
        //
        // ⚠️ A LEADING QUOTE MEANS "SAY THIS EXACTLY". Sometimes the GM has
        // written the precise words they want in the world and nothing may
        // touch them. `"Get out."` goes through untouched, with no AI call and
        // no delay.
        //
        // ⚠️ THE GM'S LINE IS NEVER LOST. revoiceLine returns the original on
        // any failure, timeout, empty answer or runaway rewrite — a flat
        // delivery is a far smaller problem than a line that never got said.
        let text = raw;
        const verbatim = /^["“]/.test(raw);
        if (verbatim) {
            text = raw.replace(/^["“]\s*/, "").replace(/["”]\s*$/, "").trim() || raw;
            console.log(`${MODULE_ID} | puppet: verbatim (leading quote) — speaking exactly as typed.`);
        } else if (QolSafe(() => game.settings.get(MODULE_ID, "revoicePuppetLines"), true)) {
            this.setThinking(true);
            try {
                text = await AIHandler.revoiceLine(this.actor, raw, { speakerName: this.npcName });
                if (text !== raw) console.log(`${MODULE_ID} | puppet re-voiced: "${raw}" -> "${text}"`);
            } finally {
                this.setThinking(false);
            }
        }

        this.renderMessage("assistant", text);

        game.socket.emit(`module.${MODULE_ID}`, {
            action:  "conversationMessage",
            ...this._speakerPayload(),
            actorId: this.actor.id,
            role:    "assistant",
            content: text,
            exclude: game.user.id
        });

        // Emote-only lines post as italic actions rather than vanishing — see
        // the note on the player path below. (2026-08-07)
        const dialogueOnly = text.replace(/\*(.*?)\*/g, "").trim();
        const _postBody = dialogueOnly || (text.trim() ? `<em>${text.replace(/\*/g, "").trim()}</em>` : "");

        // ── THE GM'S OWN LINE IS SPOKEN IN THE TONGUE TOO (2026-08-07) ──────
        // This was the half the [SPOKEN] marker never covered at all: Johnny
        // picked Dwarvish, the chat scrambled correctly, and the voice read his
        // English out loud anyway. Same helper as the AI path, so the two can
        // never drift apart again.
        const _heardPuppet = await this._foreignAudioFor(text);
        if (_postBody) {
            ChatMessage.create({
                speaker: {
                    alias: this.actor.name,
                    actor: this.actor.id,
                    token: this.tokenDocument?.id || null,
                    scene: canvas.scene?.id || null
                },
                content: `<p>${_postBody}</p>`,
                flags: { [MODULE_ID]: { isAIConversation: true }, ...Lang.polyglotFlags(this._chatLanguageFor(_postBody)) }
            });
        }

        // Re-read from flags in case GM changed voice in AI Setup
        this._refreshVoiceFromFlags();
        if (!this._voiceId) {
            console.log("ACE: Engine | Puppet: no voice cached, picking one...");
            const config = await getVoiceConfig(this.actor, this.tokenDocument);
            this._voiceId = config.voiceId;
            this._voiceSettings = config.voiceSettings || {};
        }
        let voiceId = this._voiceId;
        console.log(`ACE: Engine | Puppet speaking with voice: ${voiceId}`);
        const soundFolder = getCreatureSoundCandidates(this.actor);
        const voicePitch  = getVoicePitch(this.actor);
        try {
            const _puppetSpeech = Lang.buildSpokenText(text, _heardPuppet);
            const result = await ttsEngine.speakResponse(_puppetSpeech, voiceId, this.actor.name, soundFolder, voicePitch, this._getLiveVoiceSettings());
            if (result === "invalid") {
                console.warn("ACE: Engine | Puppet: voice invalid, fetching replacement...");
                await this._setFlagSafe("voiceId", null);
                const config = await getVoiceConfig(this.actor, this.tokenDocument);
                voiceId = config.voiceId;
                this._voiceId = voiceId;
                this._voiceSettings = config.voiceSettings || {};
                await ttsEngine.speakResponse(_puppetSpeech, voiceId, this.actor.name, soundFolder, voicePitch, this._getLiveVoiceSettings());
            }
        } catch(err) {
            console.error("ACE: Engine | Puppet speak error:", err);
            ui.notifications.error("Puppet speak failed — check console.");
        }
    }

    _setUILocked(locked, message = "") {
        if (this._inputField) this._inputField.disabled = locked;
        if (this._sendBtn)    this._sendBtn.disabled    = locked;
        if (this._micBtn)     this._micBtn.disabled     = locked;
        // Also disable pause button for spectators
        const pauseBtn = this.element?.querySelector?.("#ace-engine-pause");
        if (pauseBtn) {
            pauseBtn.disabled = locked;
            if (locked) pauseBtn.style.display = "none"; // hide entirely for spectators
        }
        // Hide mic and send buttons entirely for spectators — disabled isn't enough
        if (locked) {
            if (this._sendBtn) this._sendBtn.style.display = "none";
            if (this._micBtn)  this._micBtn.style.display  = "none";
            if (this._inputField) this._inputField.style.display = "none";
        }
        if (locked && message && this._logContainer) {
            const div = document.createElement("div");
            div.className = "ace-engine-message ace-engine-system";
            div.innerHTML = `<div class="ace-engine-bubble" style="opacity:0.6;font-style:italic;">${message}</div>`;
            this._logContainer.appendChild(div);
        }
    }

    _setInputLocked(locked, message = "") {
        if (this._inputField) this._inputField.disabled = locked;
        if (this._sendBtn)    this._sendBtn.disabled    = locked;
        if (this._micBtn)     this._micBtn.disabled     = locked;
        // Pause button stays enabled — player must be able to pause during TTS playback.
        // Spectators are handled separately by _setUILocked which hides pause entirely.
        // Return cursor to input when unlocking
        if (!locked && this._inputField) this._inputField.focus();
    }

    /**
     * Widen the window until the control row fits on one line.
     *
     * Johnny 2026-08-06: "Make sure the buttons themselves are always visible
     * with the full text in there, and that is actually the push that expands
     * the pop-up size. Don't try to guess what pop-up size it should be."
     *
     * So nothing here is a guessed number. It MEASURES the row the browser has
     * actually laid out — every button at its natural width, plus the gaps and
     * the padding around them — and grows the window to that if it is short.
     * Change a label, add a button, use a wider font: the window follows,
     * because the measurement is of the real thing rather than an estimate of
     * it. The window is never SHRUNK here; a GM who has widened it keeps their
     * size.
     */
    /** Push conversationTitle into the window frame and the portrait label. */
    _applyConversationTitle() {
        try {
            const title = this.conversationTitle;
            if (this._nameLabel) this._nameLabel.textContent = title;
            // The ApplicationV2 frame keeps its own title node; update the live
            // DOM as well as the option, or the header keeps the old string
            // until the next full re-render.
            if (this.options?.window) this.options.window.title = title;
            const h = this.element?.querySelector?.(".window-title");
            if (h) h.textContent = title;
        } catch (err) {
            console.warn(`${MODULE_ID} | Could not set the conversation title (non-fatal):`, err);
        }
    }

    _fitWidthToControls() {
        try {
            const el  = this.element;
            const row = el?.querySelector?.(".ace-engine-btn-row");
            if (!row) return;

            // Buttons at their natural width — the picker is allowed to
            // collapse, so exclude it from the demand.
            let needed = 0;
            const style = getComputedStyle(row);
            const gap = parseFloat(style.columnGap || style.gap || "0") || 0;
            const kids = [...row.children];
            for (const k of kids) {
                if (k.classList.contains("ace-engine-mic-picker")) { needed += 80; continue; }
                needed += Math.ceil(k.getBoundingClientRect().width) || 0;
            }
            needed += gap * Math.max(0, kids.length - 1);

            // Padding on the controls bar + the window frame either side.
            const controls = el.querySelector(".ace-engine-controls");
            if (controls) {
                const cs = getComputedStyle(controls);
                needed += (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
            }
            const frame = el.getBoundingClientRect().width - (row.getBoundingClientRect().width || 0);
            needed += Math.max(0, Math.ceil(frame));

            const current = this.position?.width ?? el.getBoundingClientRect().width;
            if (needed > current + 1) {
                const target = Math.min(needed, Math.round(window.innerWidth * 0.9));
                this.setPosition({ width: target });
                console.log(`${MODULE_ID} | Conversation window widened to ${target}px so the controls fit on one line.`);
            }
        } catch (err) {
            console.warn(`${MODULE_ID} | Could not size the window to its controls (non-fatal):`, err);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  MICROPHONE PICKER + LIVE LEVEL METER (2026-08-06)
    //
    //  Johnny's default input was "Wave Link MicrophoneFX" — an Elgato VIRTUAL
    //  channel that carries nothing unless Wave Link is routing to it. Measured
    //  peak: 2 out of 128. Silence. Recognition ran flawlessly against a dead
    //  line, so the button pulsed red and transcribed nothing, with no way to
    //  tell the difference from the outside.
    //
    //  ⚠️ I FIRST CALLED THIS UNFIXABLE FROM HERE, AND THE EVIDENCE SAID NO.
    //  The Web Speech API genuinely exposes no device parameter — there is no
    //  deviceId anywhere on SpeechRecognition — so I concluded a picker could
    //  not redirect it and only a browser setting could. Johnny's log
    //  (2026-08-06 19:18) disproved that: while a device sweep happened to be
    //  HOLDING a live input open, he pressed the mic and it transcribed and
    //  sent perfectly, with the dead Wave Link channel still selected as the
    //  system default.
    //
    //  So: opening the chosen device with getUserMedia and KEEPING it open for
    //  the life of the recognition session is what makes recognition follow it.
    //  That is exactly what the meter stream does, which means one mechanism
    //  buys both the picker and the "is it hearing me" bar. The stream is held
    //  for the whole session and released in _stopMic — releasing it early was
    //  the flaw in the first version of this code.
    // ═══════════════════════════════════════════════════════════════════════

    async _initMicPicker() {
        const sel = this._micSelect;
        if (!sel) return;
        try {
            // Labels stay hidden until the site has microphone permission, so a
            // fresh player would see "Microphone 1, 2, 3". Ask once, release at
            // once — we only wanted the names.
            try {
                const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
                probe.getTracks().forEach(t => t.stop());
            } catch (_) { /* denied — fall through with generic labels */ }

            const devices = (await navigator.mediaDevices.enumerateDevices())
                .filter(d => d.kind === "audioinput");
            const saved = game.settings.get(MODULE_ID, "micDeviceId") ?? "";

            sel.innerHTML = '<option value="">Default microphone</option>';
            for (const d of devices) {
                const o = document.createElement("option");
                o.value = d.deviceId;
                o.textContent = d.label || `Microphone ${sel.options.length}`;
                sel.appendChild(o);
            }
            if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;

            sel.addEventListener("change", async () => {
                try { await game.settings.set(MODULE_ID, "micDeviceId", sel.value); } catch (_) {}
                // Show the new choice working (or not) straight away.
                this._startLevelMeter(sel.value, 4000);
            });
            sel.addEventListener("click", ev => ev.stopPropagation());
        } catch (err) {
            console.warn(`${MODULE_ID} | Mic picker init failed (voice still works):`, err);
        }
    }

    /**
     * Open the chosen device and drive the little bar under the picker.
     * @param {string} deviceId  "" for the system default
     * @param {number} ms        auto-stop after this long; 0 = until stopped
     * @returns {Promise<boolean>} whether the stream opened at all
     */
    async _startLevelMeter(deviceId = "", ms = 0) {
        this._stopLevelMeter();
        try {
            const constraint = deviceId ? { deviceId: { exact: deviceId } } : true;
            const stream = await navigator.mediaDevices.getUserMedia({ audio: constraint });
            const ctx = new AudioContext();
            const an  = ctx.createAnalyser();
            an.fftSize = 512;
            ctx.createMediaStreamSource(stream).connect(an);
            const buf = new Uint8Array(an.fftSize);

            this._meter = { stream, ctx, peak: 0, loudest: 0 };
            this._meter.interval = setInterval(() => {
                an.getByteTimeDomainData(buf);
                let peak = 0;
                for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
                this._meter.peak = peak;
                this._meter.loudest = Math.max(this._meter.loudest, peak);
                if (this._micLevelBar) {
                    const pct = Math.min(100, Math.round((peak / 60) * 100));
                    this._micLevelBar.style.width = pct + "%";
                    this._micLevelBar.classList.toggle("hot", peak > 6);
                }
            }, 60);

            if (ms > 0) this._meter.timeout = setTimeout(() => this._stopLevelMeter(), ms);
            return true;
        } catch (err) {
            console.warn(`${MODULE_ID} | Level meter could not open that microphone:`, err?.name ?? err);
            if (this._micLevelBar) this._micLevelBar.style.width = "0%";
            return false;
        }
    }

    /** Loudest level seen since the meter started (0 when it never opened). */
    get _meterLoudest() { return this._meter?.loudest ?? 0; }

    _stopLevelMeter() {
        const m = this._meter;
        this._meter = null;
        if (!m) return;
        clearInterval(m.interval);
        if (m.timeout) clearTimeout(m.timeout);
        try { m.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
        try { m.ctx.close(); } catch (_) {}
        if (this._micLevelBar) {
            this._micLevelBar.style.width = "0%";
            this._micLevelBar.classList.remove("hot");
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  VOICE INPUT — press, talk, done.
    //
    //  WHAT ACTUALLY RUNS THE SPEECH-TO-TEXT: the browser's own Web Speech API
    //  (SpeechRecognition / webkitSpeechRecognition). In Chrome and Edge that
    //  streams the microphone to Google's speech service and streams words
    //  back. Free, no key, but it needs a live internet connection. Firefox
    //  does not implement it; Brave blocks the service by default.
    //  (INPUT only — the NPC's spoken reply is ElevenLabs, a separate system
    //  configured in AI Setup.)
    //
    //  WHAT WAS WRONG (2026-08-06, Johnny: "it did not go to the text area and
    //  it did not start recording"):
    //   1. handleMic NEVER focused the input. The caret stayed wherever it
    //      was, so it looked dead even on the runs where it worked.
    //   2. Only TWO of the eight error codes were ever reported.
    //      "service-not-allowed" (page not served over https) and
    //      "audio-capture" (no mic, or another app holding it — a dictation
    //      tool, say) both failed in total silence: button lit, nothing
    //      happened, no message anywhere.
    //   3. No permission pre-flight, so a blocked mic was indistinguishable
    //      from a working one right up until it quietly did nothing.
    //   4. On a continuous-mode session cycle it called start() again — and
    //      event.results RESETS on a new session, while the old code assigned
    //      that fresh transcript straight over the field. Everything said
    //      before the cycle was wiped mid-sentence.
    // ═══════════════════════════════════════════════════════════════════════

    /** Milliseconds of silence before the sentence sends itself. */
    static MIC_SILENCE_MS = 3000;

    /** Human wording for every error the Web Speech API can raise. */
    static _MIC_ERRORS = {
        "not-allowed":            "Microphone permission is blocked. Click the padlock in the address bar, then Site settings, then allow Microphone, and reload.",
        "service-not-allowed":    "Your browser will not run speech recognition on this page. This almost always means Foundry is served over plain http:// — the speech service requires https:// or localhost. Typing still works.",
        "audio-capture":          "No microphone was available. Check it is plugged in, and close any other app holding it (dictation tools, meeting apps, recorders).",
        "network":                "Speech recognition needs an internet connection — the browser sends the audio to its own cloud service.",
        "aborted":                null,
        "no-speech":              null,
        "language-not-supported": "This browser cannot do speech recognition in the configured language.",
        "bad-grammar":            "Speech recognition rejected its grammar configuration.",
    };

    /** Put the mic UI into a named state so it always LOOKS like what it is. */
    _setMicState(state, note = "") {
        const btn = this._micBtn;
        if (btn) {
            btn.classList.toggle("active", state === "listening");
            btn.classList.toggle("mic-warmup", state === "starting");
            btn.setAttribute("aria-pressed", state === "listening" ? "true" : "false");
            btn.title = state === "listening" ? "Listening — click to send now (or press Enter)"
                      : state === "starting"  ? "Starting the microphone..."
                      : "Click to talk";
            // ⚠️ THE VISIBLE LABEL, NOT JUST THE TOOLTIP. The button read
            // "Speak" the entire time, including while it was listening, so
            // the only feedback that anything was happening was a CSS class
            // and a tooltip nobody hovers mid-sentence. On a control the user
            // is actively waiting on, the word on the button is the status.
            const label = btn.querySelector("span");
            if (label) {
                label.textContent = state === "listening" ? "Listening"
                                  : state === "starting"  ? "Starting…"
                                  : "Speak";
            }
            const icon = btn.querySelector("i");
            if (icon) {
                icon.className = state === "listening" ? "fas fa-stop"
                               : state === "starting"  ? "fas fa-spinner fa-spin"
                               : "fas fa-microphone";
            }
        }
        if (this._inputField) {
            this._inputField.placeholder =
                  state === "listening" ? (note || "Listening... pause when you're done, or press Enter to send")
                : state === "starting"  ? "Starting the microphone..."
                : "Type to speak, or press the mic to talk freely...";
        }
    }

    /** Stop listening. `send` posts whatever is in the box. */
    _stopMic({ send = false, note = "" } = {}) {
        const rec = this._recognition;
        this._recognition = null;                 // clear FIRST so late events bail
        if (this._micSendTimer) { clearTimeout(this._micSendTimer); this._micSendTimer = null; }
        if (rec) {
            try { rec.stop(); } catch (_) {}
            try { rec.abort?.(); } catch (_) {}
        }
        this._micFinalText = "";
        this._stopLevelMeter();            // release the held capture device
        if (this._micSilenceCheck) { clearTimeout(this._micSilenceCheck); this._micSilenceCheck = null; }
        this._setMicState("idle", note);
        if (send && this._inputField?.value.trim()) this.handleSend();
    }

    async handleMic() {
        if (!game.user.isGM && this.readOnly) return;

        // Already listening -> this click means "I'm done".
        if (this._recognition) { this._stopMic({ send: true }); return; }

        // ── FOCUS FIRST, SYNCHRONOUSLY ───────────────────────────────────
        // Before any await, before any capability check. The caret belongs in
        // the box the instant the button is pressed — if the mic then fails,
        // the player is already able to type instead of staring at a dead UI.
        // Doing it after an await would also drop the user-gesture context.
        this._inputField?.focus();

        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            ui.notifications.warn("This browser has no speech recognition. Chrome and Edge support it; Firefox does not. You can still type.", { permanent: true });
            return;
        }

        // ── SECURE CONTEXT ───────────────────────────────────────────────
        // The API OBJECT exists on plain http:// — it just never works. That
        // is exactly why this failed silently for players on a LAN address
        // while working for the GM on localhost.
        if (window.isSecureContext === false) {
            ui.notifications.error(
                "Voice input needs a secure connection. This page is served over plain http://, and browsers only allow the microphone on https:// or localhost. Typing still works.",
                { permanent: true });
            console.warn("ACE: Engine | Mic: insecure context — speech recognition cannot run on", window.location.origin);
            return;
        }

        // ── OPEN THE CHOSEN DEVICE AND HOLD IT ───────────────────────────
        // Two jobs in one stream: it proves the microphone is reachable (a real
        // named error instead of a session that quietly dies), and holding it
        // open for the whole session is what makes recognition actually listen
        // to THIS device rather than a dead system default. Released in
        // _stopMic — never before.
        this._setMicState("starting");
        let deviceId = "";
        try { deviceId = game.settings.get(MODULE_ID, "micDeviceId") ?? ""; } catch (_) {}
        if (this._micSelect?.value) deviceId = this._micSelect.value;

        const opened = await this._startLevelMeter(deviceId, 0);
        if (!opened) {
            // Retry on the default before giving up — a saved device can vanish
            // when a headset is unplugged, and that must not brick the button.
            const fellBack = deviceId ? await this._startLevelMeter("", 0) : false;
            if (!fellBack) {
                this._setMicState("idle");
                ui.notifications.error("Could not open that microphone. Pick a different one from the dropdown beside the mic button.", { permanent: true });
                return;
            }
            ui.notifications.warn("That microphone was unavailable — using the default instead.");
        }
        try {
            // Confirm permission explicitly so a denial is named, not guessed.
            const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
            probe.getTracks().forEach(t => t.stop());
        } catch (err) {
            this._stopLevelMeter();
            this._setMicState("idle");
            const name = err?.name ?? "";
            const msg = name === "NotAllowedError"
                ? "Microphone permission was denied. Click the padlock in the address bar, then Site settings, then allow Microphone, and reload."
                : name === "NotFoundError"
                ? "No microphone was found. Plug one in and try again."
                : name === "NotReadableError"
                ? "Your microphone is in use by another program. Close any dictation tool, meeting app or recorder and try again."
                : `Could not open the microphone (${name || "unknown error"}).`;
            ui.notifications.error(msg, { permanent: true });
            console.error("ACE: Engine | Mic: getUserMedia failed:", err);
            return;
        }

        const recognition = new SR();
        recognition.lang = "en-US";
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        this._recognition  = recognition;
        // ── CONTINUE FROM WHAT IS ALREADY THERE. DO NOT WIPE IT. (2026-08-07) ──
        // This used to be `= ""`. Because onresult rebuilds the WHOLE box from
        // `_micFinalText + this session's words`, starting a dictation with an
        // empty bank meant the first syllable destroyed everything already in
        // the input — dictated earlier, or typed by hand, it made no
        // difference. Johnny hit it by pausing mid-sentence: press pause, press
        // it again, speak, and the sentence he had built vanished and started
        // over. Nothing about pause was at fault; any second press of the mic
        // did it.
        //
        // Seeding from the live box makes dictation ADDITIVE, which is what
        // anyone would expect: it picks up where you left off, and typing a
        // few words then finishing them out loud now works too.
        const _carry = (this._inputField?.value ?? "").trim();
        this._micFinalText = _carry ? _carry + " " : "";
        let fatal = false;
        let restarts = 0;
        let heardAnything = false;
        this._micDeafRetried = false;   // one automatic recovery per dictation

        recognition.onstart = () => {
            if (this._recognition !== recognition) return;
            this._setMicState("listening");
            this._inputField?.focus();           // keep the caret where the words land
            console.log("ACE: Engine | Mic: listening on", this._micSelect?.selectedOptions?.[0]?.textContent ?? "default device");

            // ── SAY SO WHEN NOTHING IS ARRIVING ──────────────────────────
            // The whole reason this looked broken for so long: a dead input
            // and a working one are indistinguishable from the outside. After
            // five seconds of a completely flat signal, name the problem and
            // the device it applies to.
            if (this._micSilenceCheck) clearTimeout(this._micSilenceCheck);
            this._micSilenceCheck = setTimeout(() => {
                if (this._recognition !== recognition) return;

                // ⚠️ A LOUD METER IS NOT PROOF THAT DICTATION WORKS, and this
                // line used to treat it as exactly that: `if loud, return` -
                // fine. That is the precise case Johnny hit. There are TWO
                // ways five seconds of nothing can happen and they need
                // opposite answers:
                //   quiet meter -> the device is not producing audio at all
                //   loud  meter -> the device is fine and the RECOGNISER is
                //                  deaf, which is recoverable
                // Some setups never even raise "no-speech"; recognition just
                // sits there. So the positive check lives here too.
                if (this._meterLoudest > 6 && !heardAnything) {
                    this._recogniserIsDeaf(recognition);
                    return;
                }
                if (this._meterLoudest > 4) return;          // heard something — fine
                const dev = this._micSelect?.selectedOptions?.[0]?.textContent ?? "your default microphone";
                ui.notifications.warn(
                    `No sound is reaching the browser from "${dev}". Pick a different microphone in the dropdown beside the mic button — virtual devices (Wave Link, Voicemeeter, OBS, NVIDIA Broadcast) are often silent unless that software is running.`,
                    { permanent: true });
                console.warn(`${MODULE_ID} | Mic: 5s of silence from "${dev}" — peak level ${this._meterLoudest}.`);
            }, 5000);
        };

        recognition.onresult = (event) => {
            if (this._recognition !== recognition) return;   // stale session
            restarts = 0;
            heardAnything = true;

            // event.results holds only THIS session. On a cycle it resets, so
            // finalized text must be banked in _micFinalText or it is erased
            // mid-sentence.
            let justFinal = "", interim = "";
            for (let i = 0; i < event.results.length; i++) {
                const r = event.results[i];
                if (r.isFinal) justFinal += r[0].transcript + " ";
                else           interim   += r[0].transcript;
            }
            const full = (this._micFinalText + justFinal + interim).trim().slice(0, 1000);
            this._inputField.value = full;
            this._inputField.dispatchEvent(new Event("input"));   // let it auto-grow

            // Silence timer — restarts on every word, fires when speech stops.
            if (this._micSendTimer) clearTimeout(this._micSendTimer);
            this._micSendTimer = setTimeout(() => {
                if (this._recognition === recognition) this._stopMic({ send: true });
            }, ConversationApp.MIC_SILENCE_MS);
        };

        recognition.onerror = (event) => {
            if (this._recognition !== recognition) return;
            const code = event.error;

            // ⚠️🔴 "no-speech" WHILE THE METER IS LOUD IS NOT TRANSIENT - IT IS
            // THE BUG (2026-08-20). Johnny: "the speak button does nothing,
            // even though I can see that it can see my voice." That is exactly
            // this: the level bar is reading his microphone at full tilt while
            // recognition reports hearing nothing, and the line below threw
            // that contradiction away as noise. A dead button and a working one
            // looked identical from the outside for weeks.
            //
            // Two different meanings share one error code:
            //   quiet meter + no-speech  = they genuinely said nothing. Ignore.
            //   LOUD meter + no-speech   = the browser's recogniser is not
            //                              getting the audio we can plainly
            //                              see. Never ignore that.
            if (code === "no-speech" && (this._meterLoudest ?? 0) > 6 && !heardAnything) {
                this._recogniserIsDeaf(recognition);
                return;
            }
            if (code === "no-speech" || code === "aborted") return;   // transient

            fatal = true;
            console.error("ACE: Engine | Mic error:", code);

            // EVERY code gets a human answer. Silence here is what made this
            // look broken.
            let msg = ConversationApp._MIC_ERRORS[code];
            if (msg === undefined) msg = `Speech recognition failed (${code}).`;
            if (code === "network" && (navigator.brave?.isBrave || navigator.userAgent.includes("Brave"))) {
                msg = "Voice input does not work in Brave — its shields block the speech service. Use Chrome or Edge, or type instead.";
            }
            if (msg) ui.notifications.error(msg, { permanent: true });
            this._stopMic({ send: false });
        };

        recognition.onend = () => {
            if (this._recognition !== recognition || fatal) return;

            // Bank what this session finalized BEFORE a restart wipes it.
            const banked = this._inputField?.value?.trim() ?? "";
            if (banked) this._micFinalText = banked + " ";

            // Chrome cycles continuous sessions on its own. Keep listening.
            if (restarts < 5) {
                restarts++;
                try { recognition.start(); return; } catch (_) { /* fall through */ }
            }
            console.log("ACE: Engine | Mic: session ended.");
            this._stopMic({ send: heardAnything });
        };

        try {
            recognition.start();
        } catch (err) {
            console.error("ACE: Engine | Mic start failed:", err);
            ui.notifications.error("Could not start the microphone. Try again, or type your message.", { permanent: true });
            this._stopMic({ send: false });
        }
    }

    /**
     * The level meter can hear you and the browser's recogniser cannot.
     *
     * ⚠️ WHY THIS HAPPENS, AND WHY THE OLD COMMENT WAS WRONG. This class opens
     * a getUserMedia stream for the level bar and HOLDS it for the whole
     * dictation. The comment above that code claimed holding it is "what makes
     * recognition actually listen to THIS device". That is not true of Chrome:
     * webkitSpeechRecognition takes no device argument and always uses the
     * system default. Holding the capture buys nothing - and on Windows, with
     * an exclusive-mode driver or a virtual device (Wave Link, Voicemeeter, OBS,
     * NVIDIA Broadcast) or another dictation tool already holding the mic, our
     * stream is exactly what starves the recogniser.
     *
     * So: drop our capture and try once more. If it then works, the meter is
     * the price and the button is worth more than the bar. Said out loud once,
     * because silently changing behaviour is how this stayed invisible.
     */
    _recogniserIsDeaf(recognition) {
        // ⚠️ Read the peak NOW. _stopLevelMeter() clears this._meter, and the
        // getter falls back to 0 - so every log line below would have reported
        // "peak 0", which is the exact opposite of what happened and would
        // send the next reader hunting a silent microphone.
        const peak = this._meterLoudest;
        if (this._micDeafRetried) {
            this._stopMic({ send: false });
            ui.notifications.error(
                "Your microphone is working - the level bar can see it - but this browser's speech " +
                "recogniser is getting no audio from it. That is almost always another program holding " +
                "the microphone exclusively: a dictation tool (Wispr Flow, Dragon), a meeting app, or a " +
                "virtual device like Wave Link, Voicemeeter, OBS or NVIDIA Broadcast. Close it, or pick " +
                "the plain hardware microphone in the dropdown. Typing always works.",
                { permanent: true });
            console.error(`${MODULE_ID} | Mic: recogniser deaf on both attempts. Meter peak was ` +
                `${peak}, recognition returned no-speech.`);
            return;
        }
        this._micDeafRetried = true;
        console.warn(`${MODULE_ID} | Mic: meter peak ${peak} but recognition heard nothing - ` +
            `releasing our own capture (it may be starving the recogniser) and retrying once.`);
        ui.notifications.info("Microphone is live but the recogniser heard nothing - releasing the level meter and trying again.");
        this._stopLevelMeter();          // give the device back
        try {
            recognition.stop();
            setTimeout(() => {
                if (this._recognition !== recognition) return;
                try { recognition.start(); } catch (_) { this._stopMic({ send: false }); }
            }, 250);
        } catch (_) {
            this._stopMic({ send: false });
        }
    }

    /** Clean up speech-to-text: capitalize, detect questions, add punctuation. */
    static _QUESTION_WORDS = /^(who|what|where|when|why|how|do|does|did|is|are|was|were|can|could|would|should|will|shall|have|has|had|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|wouldn't|couldn't|shouldn't|hasn't|haven't|hadn't|which|whose|whom)\b/i;

    _cleanupTranscript(raw) {
        let text = raw.trim();
        if (!text) return text;
        text = text.charAt(0).toUpperCase() + text.slice(1);
        text = text.replace(/\s{2,}/g, " ");
        if (!/[.!?…]$/.test(text)) {
            text += ConversationApp._QUESTION_WORDS.test(raw.trim()) ? "?" : ".";
        }
        return text;
    }

    async handleSend() {
        const raw = this._inputField.value.trim();
        if (!raw || this.isThinking || this._paused) return;
        let text = this._cleanupTranscript(raw);

        // Apply ACE Engine profanity filter if available (via bridge)
        try {
            text = EngineBridge.filterProfanity(text);
        } catch (err) { console.debug("ACE: Engine | ConversationApp profanity filter not loaded:", err); }

        // Hard block: spectators (readOnly) can never send. Lock-based
        // multi-player conflict checks were lost in the envoy merger —
        // see _onRender for the cleanup note.
        if (!game.user.isGM && this.readOnly) return;

        // Kill any active voice recognition so it doesn't re-fill the input
        if (this._recognition) {
            try { this._recognition.abort(); } catch (_) {}
            this._recognition = null;
            this._micBtn?.classList.remove("active");
            if (this._micSendTimer) { clearTimeout(this._micSendTimer); this._micSendTimer = null; }
        }

        // If NPC is still speaking, interrupt TTS so the player can talk
        if (ttsEngine.isPlaying) ttsEngine.stop();

        this._inputField.value = "";

        // ══════════════════════════════════════════════════════════════════
        // GM INTERJECTION — GM is speaking AS the NPC, not as a player.
        // The GM's text becomes NPC dialogue (assistant role). No AI call.
        // ══════════════════════════════════════════════════════════════════
        if (game.user.isGM) {
            this.renderMessage("assistant", text);

            // Broadcast to player + spectators as NPC speech
            game.socket.emit(`module.${MODULE_ID}`, {
                action:  "conversationMessage",
                ...this._speakerPayload(),
                actorId: this.actor.id,
                tokenId: this.tokenDocument?.id || null,
                role:    "assistant",
                content: text,
                exclude: game.user.id
            });

            // Push into history as NPC speech so the AI has context if the player replies
            const MAX_MEMORY = 20;
            this.history.push({ role: "assistant", content: text });
            if (this.history.length > MAX_MEMORY)
                this.history = this.history.slice(this.history.length - MAX_MEMORY);
            await this._saveMemorySafe(this.history);

            // Chat log entry — NPC speaking (not "DUNGEON MASTER")
            // Emote-only lines post as italic actions rather than vanishing.
            const dialogueOnly = text.replace(/\*(.*?)\*/g, "").trim();
            const _postBody = dialogueOnly || (text.trim() ? `<em>${text.replace(/\*/g, "").trim()}</em>` : "");
            if (_postBody) {
                ChatMessage.create({
                    speaker: {
                        alias: this.actor.name,
                        actor: this.actor.id,
                        token: this.tokenDocument?.id || null,
                        scene: canvas.scene?.id || null
                    },
                    content: `<p>${_postBody}</p>`,
                    flags: { [MODULE_ID]: { isAIConversation: true, gmInterjection: true }, ...Lang.polyglotFlags(this._chatLanguageFor(_postBody)) }
                });
            }

            // TTS — speak with the NPC's voice
            try {
                // Re-read from flags in case GM changed voice in AI Setup
                this._refreshVoiceFromFlags();
                if (!this._voiceId) {
                    const config = await getVoiceConfig(this.actor, this.tokenDocument);
                    this._voiceId = config.voiceId;
                    this._voiceSettings = config.voiceSettings || {};
                }
                let voiceId = this._voiceId;
                const soundFolder = getCreatureSoundCandidates(this.actor);
                const voicePitch  = getVoicePitch(this.actor);

                this._setInputLocked(true);
                const result = await ttsEngine.speakResponse(text, voiceId, this.actor.name, soundFolder, voicePitch, this._getLiveVoiceSettings());
                this._setInputLocked(false);

                if (result === "invalid") {
                    console.warn(`ACE: Engine | Voice "${voiceId}" invalid, fetching replacement...`);
                    await this._setFlagSafe("voiceId", null);
                    const config = await getVoiceConfig(this.actor, this.tokenDocument);
                    voiceId = config.voiceId;
                    this._voiceId = voiceId;
                    this._voiceSettings = config.voiceSettings || {};
                    this._setInputLocked(true);
                    await ttsEngine.speakResponse(text, voiceId, this.actor.name, soundFolder, voicePitch, this._getLiveVoiceSettings());
                    this._setInputLocked(false);
                }
            } catch (err) {
                console.warn("ACE: Engine | GM interjection TTS failed:", err);
                this._setInputLocked(false);
            }

            console.log(`ACE: Engine | GM interjection as ${this.actor.name}: "${text.slice(0, 60)}..."`);
            return; // ← Done — no AI call for GM interjections
        }

        // ══════════════════════════════════════════════════════════════════
        // PLAYER MESSAGE — normal flow: send to AI, get NPC response
        // ══════════════════════════════════════════════════════════════════
        this.renderMessage("user", text);

        // ── Broadcast the player's message so GM (and other spectators) see it ──
        game.socket.emit(`module.${MODULE_ID}`, {
            action:  "conversationMessage",
            ...this._speakerPayload(),
            actorId: this.actor.id,
            tokenId: this.tokenDocument?.id || null,
            role:    "user",
            content: text,
            exclude: game.user.id
        });

        // ── THE GATE: A DEAD CREATURE DOES NOT ANSWER. (2026-08-07) ────────
        // Checked HERE, at the door every player message comes through, rather
        // than trusting the window to have been locked in time — a player can
        // press Send in the same instant the killing blow lands.
        if (this.isDeadNow) {
            this._applyDeathLock();
            console.log(`${MODULE_ID} | GATE: ${this.npcName} is dead — no reply generated.`);
            this._setInputLocked(game.user.isGM ? false : true, "");
            return;
        }

        this.setThinking(true);

        this._resetInactivityTimer();

        try {
            let response = await AIHandler.getResponse(this.actor, text, this.history, { speakerActor: this.speakingAs });

            // Hard AI failure (bad/no key, out of credit, provider down, timeout).
            // The GM already received a plain-English toast from surfaceAIFailure.
            // Show a silent, in-window beat and STOP — never push a broken turn to
            // history, never broadcast to other clients, never post to public chat,
            // and never speak an error line. (finally{} clears the thinking dots.)
            if (isAIFailure(response)) {
                const beat = game.user.isGM
                    ? "⚠ No response — the AI provider is unavailable. Check ACE Engine → AI Setup."
                    : "⚠ No response right now — please try again in a moment.";
                this.renderMessage("system", beat);
                this._setInputLocked(false);
                return;
            }

            console.log("ACE: Engine | Response:", response);

            // ── WHAT IS SAID vs WHAT IS HEARD (2026-08-07) ────────────────
            // The English stays in chat, where Polyglot decides who may read
            // it, so a character who knows the tongue still gets the meaning.
            // Only the AUDIO is rendered into the stand-in language. Null means
            // "say it in English" — no barrier, Common, or the render failed.
            const _heard = await this._foreignAudioFor(response);

            // Track whether this was the first exchange (for name reveal)
            const isFirstExchange = this.history.length === 0;

            const MAX_MEMORY = 20;
            this.history.push({ role: "user",      content: text     });
            this.history.push({ role: "assistant",  content: response });
            if (this.history.length > MAX_MEMORY)
                this.history = this.history.slice(this.history.length - MAX_MEMORY);

            await this._saveMemorySafe(this.history);

            // On the first conversation, reveal the NPC's real name on the token
            if (isFirstExchange) {
                this._maybeRevealName().catch(e =>
                    console.warn("ACE: Engine | Name reveal failed:", e)
                );
            }

            const playerName = this.speakingAs?.name ?? game.user.name;

            this.renderMessage("assistant", response);

            game.socket.emit(`module.${MODULE_ID}`, {
                action:  "conversationMessage",
                ...this._speakerPayload(),
                actorId: this.actor.id,
                tokenId: this.tokenDocument?.id || null,
                role:    "assistant",
                content: response,
                exclude: game.user.id
            });

            // ⚠️ AN EMOTE-ONLY REPLY USED TO VANISH (2026-08-07).
            // Stripping *asterisks* and posting only what remains means a reply
            // that is ENTIRELY an emote — "*Roar*", which is exactly what a
            // 5-INT ogre produces — leaves an empty string, and the guard below
            // skipped the ChatMessage entirely. Nothing reached the sidebar and
            // it looked precisely like the Send button was broken. It was not:
            // the same code posted fine one minute later when the AI happened to
            // answer "Grrr! Roar!" with no asterisks.
            // An emote is not nothing. It is an ACTION, so it posts in italics —
            // which is how it reads at a table anyway.
            const _cleanResponse = response
                .replace(/\[SUBTLE_CHECK:[^\]]+\]/g, "")
                .replace(/\[DISPOSITION:[^\]]+\]/gi, "")
                .replace(/\s{2,}/g, " ")
                .trim();
            const dialogueOnly = _cleanResponse.replace(/\*(.*?)\*/g, "").replace(/\s{2,}/g, " ").trim();
            // Emote-only → render the emote itself, italicised, rather than drop it.
            const _postBody = dialogueOnly
                || (_cleanResponse ? `<em>${_cleanResponse.replace(/\*/g, "")}</em>` : "");
            // ── TWO SPEAKERS, TWO MESSAGES (2026-08-07) ──────────────────
            // This used to put the PLAYER's line and the NPC's reply in ONE
            // chat message and then tag it with the NPC's language. Polyglot
            // scrambles per message, so it encoded Jeth's own sentence along
            // with Savid's — a single block of runes containing two different
            // people's speech, one of whom obviously understood himself.
            // Johnny's screenshot: "what the hell is that all about?"
            //
            // A message can only carry one language, so it can only carry one
            // speaker. The player's line posts as itself, readable, always.
            // The NPC's reply posts separately and is the only part that can be
            // hidden.
            if (_postBody) {
                const _npcSpeaker = {
                    alias: this.actor.name,
                    actor: this.actor.id,
                    token: this.tokenDocument?.id || null,
                    scene: canvas.scene?.id || null
                };

                // 1. What the PLAYER said — their own words, never scrambled.
                //    They said it; hiding it from them would be nonsense.
                ChatMessage.create({
                    speaker: { alias: playerName },
                    content: `<p><strong>${playerName}:</strong> ${text}</p>`,
                    flags: { [MODULE_ID]: { isAIConversation: true, playerLine: true } }
                });

                // 2. What the NPC said back — the only part a language can hide.
                ChatMessage.create({
                    speaker: _npcSpeaker,
                    content: `<p>${_postBody}</p>`,
                    flags: { [MODULE_ID]: { isAIConversation: true }, ...Lang.polyglotFlags(this._chatLanguageFor(_postBody)) }
                });
            }

            // Re-read from flags in case GM changed voice in AI Setup
            this._refreshVoiceFromFlags();
            if (!this._voiceId) {
                const config = await getVoiceConfig(this.actor, this.tokenDocument);
                this._voiceId = config.voiceId;
                this._voiceSettings = config.voiceSettings || {};
            }
            let voiceId = this._voiceId;
            const soundFolder = getCreatureSoundCandidates(this.actor);
            const voicePitch  = getVoicePitch(this.actor);

            // Strip AI tags before sending to TTS — emotes (*action*) are left
            // intact because tts.js handles dialogue vs emote segmentation itself.
            const ttsText = Lang.buildSpokenText(response, _heard)
                .replace(/\[SUBTLE_CHECK:[^\]]+\]/g, "")
                .replace(/\[DISPOSITION:[^\]]+\]/gi, "")
                .replace(/\s{2,}/g, " ")
                .trim();

            this._setInputLocked(true);
            const result = await ttsEngine.speakResponse(ttsText, voiceId, this.actor.name, soundFolder, voicePitch, this._getLiveVoiceSettings());
            this._setInputLocked(false);

            if (result === "invalid") {
                console.warn(`ACE: Engine | Voice "${voiceId}" invalid, fetching replacement...`);
                await this._setFlagSafe("voiceId", null);
                const config = await getVoiceConfig(this.actor, this.tokenDocument);
                voiceId = config.voiceId;
                this._voiceId = voiceId;
                this._voiceSettings = config.voiceSettings || {};
                this._setInputLocked(true);
                await ttsEngine.speakResponse(ttsText, voiceId, this.actor.name, soundFolder, voicePitch, this._getLiveVoiceSettings());
                this._setInputLocked(false);
            }

        } catch (err) {
            console.error("ACE: Engine | Error:", err);
            this.renderMessage("assistant", "My thoughts are scattered... (Check Console)");
            this._setInputLocked(false);
        } finally {
            this.setThinking(false);
        }
    }

    _resetInactivityTimer() {
        // GM and read-only spectator windows should NEVER time out —
        // only the active conversation owner (the player) should.
        if (game.user.isGM || this.readOnly) return;

        if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
        this._inactivityTimer = setTimeout(async () => {
            console.warn("ACE: Engine | Inactivity timeout — releasing window");
            npcChatState?.openConversations?.delete?.(this._convoKey);
            this.renderMessage("system", "Conversation timed out due to inactivity.");
            await this._summarizeSession();
            this._setUILocked(true, "");
        }, CONVERSATION_IDLE_MS);
    }

    async _saveMemorySafe(history) { return this._setFlagSafe("memoryLog", history); }

    // ── Speaking-synced animated portrait ──────────────────────────────────
    // Probes the configured WebP folder in this cascade:
    //   1. {folder}/{token.name}.webp     — most specific (the named instance)
    //   2. {folder}/{actor.name}.webp     — creature template (e.g. "Goblin")
    //   3. {folder}/{subtype}.webp        — family (e.g. "goblinoid"), lowercase
    //   4. {folder}/{type}.webp           — broad type (e.g. "humanoid"), lowercase
    //   5. (no swap) static portrait / token image stays
    // Listens for npcDialogueStart/End hooks and swaps the portrait <img> src
    // between the static fallback and the WebP. Plays only during dialogue
    // segments — not narrator-voiced *emotes* or silent listening.

    async _initSpeakingPortrait() {
        if (!this._portraitImg) return;

        // Cache the static portrait src so we can swap back on dialogue end
        this._staticPortraitSrc = this._portraitImg.src;

        const folderRaw = (() => {
            try { return game.settings.get(MODULE_ID, "npcWebpFolder"); }
            catch (_) { return "NPCs/webps/"; }
        })();
        const folder = (folderRaw || "NPCs/webps/").replace(/^\/+|\/+$/g, "");

        const tokenName = (this.tokenDocument?.name || "").trim();
        const actorName = (this.actor?.name || "").trim();
        const subtype   = (this.actor?.system?.details?.type?.subtype || "").trim().toLowerCase();
        const type      = (this.actor?.system?.details?.type?.value   || "").trim().toLowerCase();

        // Build the 4-level lookup cascade. Token + actor names keep their
        // natural casing; subtype + type are lowercase per dnd5e data.
        const candidates = [];
        const seen = new Set();
        for (const name of [tokenName, actorName, subtype, type]) {
            if (!name) continue;
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push(`${folder}/${encodeURIComponent(name)}.webp`);
        }

        // ── CONSULT THE INDEX FIRST — no probing, no 404s (2026-08-07) ──────
        // The probe below creates an <img> per candidate and lets it fail, which
        // printed three red 404s in every player's console on every conversation
        // open. When the GM has published the folder listing we can just LOOK,
        // and nobody sees an error for a file that was never expected to exist.
        let _indexed = null;
        try {
            const wi = game.settings.get(MODULE_ID, "speakingWebpIndex");
            if (wi?.stems?.length) {
                const stems = new Set(wi.stems);
                for (const name of [tokenName, actorName, subtype, type]) {
                    const n = String(name || "").trim().toLowerCase();
                    if (n && stems.has(n)) {
                        _indexed = `${wi.folder || folder}/${encodeURIComponent(name)}.webp`;
                        break;
                    }
                }
                // The index exists and holds no match — that is a definitive NO.
                // Probing anyway would only manufacture 404s.
                this._speakingWebpSrc = _indexed;
                if (_indexed) console.log(`ACE: Engine | Conversation | Speaking WebP (from index): ${decodeURIComponent(_indexed)}`);
                else console.log(`ACE: Engine | Conversation | No speaking WebP for ${tokenName || actorName} (checked the index — nothing probed).`);
                candidates.length = 0;   // skip the probe entirely
            }
        } catch (_) { /* no index yet — fall through to the old probe */ }

        if (candidates.length) {
            try {
                this._speakingWebpSrc = await Promise.any(
                    candidates.map(path =>
                        this._fileExists(path).then(found => found ? path : Promise.reject(new Error("not found")))
                    )
                );
                console.log(`ACE: Engine | Conversation | Speaking WebP found: ${decodeURIComponent(this._speakingWebpSrc)}`);
            } catch {
                const tried = candidates.map(p => decodeURIComponent(p.split("/").pop())).join(", ") || "(none — actor has no name/type data)";
                console.log(`ACE: Engine | Conversation | No speaking WebP for ${tokenName || actorName} (tried: ${tried})`);
            }
        }

        // Always wire hooks — even when no WebP is found — so the system stays
        // ready if the user drops a file in mid-session and reopens the chat.
        this._dialogueStartHookId = Hooks.on("ace-engine.npcDialogueStart", (data) => this._onDialogueStart(data));
        this._dialogueEndHookId   = Hooks.on("ace-engine.npcDialogueEnd",   (data) => this._onDialogueEnd(data));
    }

    /** Promise-based file probe via Image preload (works for any browser-loadable asset). */
    _fileExists(path) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload  = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = path;
        });
    }

    _onDialogueStart({ actorName } = {}) {
        if (!this._speakingWebpSrc || !this._portraitImg) return;
        // Match against this conversation's actor — TTS engine fires the hook
        // with the actor name passed in by speakResponse(). Skip events from
        // other conversations.
        if (actorName && actorName !== this.actor?.name) return;
        this._portraitImg.src = this._speakingWebpSrc;
    }

    _onDialogueEnd({ actorName } = {}) {
        if (!this._portraitImg || !this._staticPortraitSrc) return;
        if (actorName && actorName !== this.actor?.name) return;
        this._portraitImg.src = this._staticPortraitSrc;
    }

    /**
     * GIVE A NAMELESS CREATURE A NAME AND A PAST, THE MOMENT SOMEONE SPEAKS TO IT.
     *
     * Johnny, 2026-08-07: "if the characters suddenly talk to a goblin, I want
     * the AI to name the goblin and write a backstory so it has something to
     * respond to." He deliberately does NOT pre-name tokens, because there is no
     * predicting which goblin a party decides to chat with. When they do, that
     * goblin should stop being furniture and become a person.
     *
     * "Archmage" is a statblock label exactly like "Goblin" or "Ogre". Until
     * someone talks to it, it is nobody. After that, it is somebody — and stays
     * that somebody for the rest of the campaign, because the bio is written to
     * the sheet.
     *
     * Runs at conversation OPEN, not on the first message, so the generation
     * happens while the player is still reading the portrait and typing.
     * queueBioGeneration is already idempotent — it returns immediately when an
     * ACE bio exists — so a creature is never named twice and a GM-written bio
     * is never overwritten.
     *
     * ⚠️ THE NAME STAYS SECRET. Nothing here touches the nameplate: the players
     * still see "Goblin". _maybeRevealName below is what paints the real name on
     * the token, and only after the creature has introduced itself in the
     * conversation. Johnny chose that explicitly — you learn a name by asking
     * for it, not by hovering over a token.
     */
    async _ensureIdentity() {
        try {
            if (!this.actor || this._identityQueued) return;
            this._identityQueued = true;

            // ── A PLAYER ASKS THE GM (2026-08-07) ────────────────────────
            // This runs on whichever client opened the conversation, and that
            // is usually a PLAYER — which is the whole point of the feature:
            // "if the characters suddenly talk to a goblin, I want the AI to
            // name the goblin and write a backstory." A player client cannot
            // create an Actor or write world data; Foundry refuses outright.
            // So it asks the GM, who runs the identical code path.
            //
            // ⚠️ NO SILENT CATCH. If nobody is there to answer, say so — an
            // unexplained "the goblin has nothing to say" is exactly the kind
            // of believable lie that wastes an evening.
            if (!game.user?.isGM) {
                const tokenDoc = this.tokenDocument ?? this.actor.getActiveTokens?.()[0]?.document ?? null;
                if (!tokenDoc) return;

                const bioNow = this.actor.system?.details?.biography?.value || "";
                if (bioNow.includes('class="ace-engine-bio"')) return;   // already somebody

                const { resolveIdentity } = await import("./npc-identity.mjs");
                if (resolveIdentity(this.actor, tokenDoc).isNamed) return;

                if (!game.users?.activeGM) {
                    console.warn(`${MODULE_ID} | "${tokenDoc.name}" has no name or history, and no GM is connected to write one. ` +
                        `It can still talk, but it has nothing personal to talk about. A GM can click the quill on its token later.`);
                    return;
                }
                game.socket.emit(`module.${MODULE_ID}`, {
                    action: "ensureIdentity",
                    tokenId: tokenDoc.id,
                    sceneId: tokenDoc.parent?.id ?? canvas.scene?.id ?? null,
                    senderId: game.user.id,
                });
                console.log(`${MODULE_ID} | "${tokenDoc.name}" is nobody yet — asked the GM to give it a name and a history.`);
                return;
            }

            const bio = this.actor.system?.details?.biography?.value || "";
            if (bio.includes('class="ace-engine-bio"')) return;   // already has a past

            const { resolveIdentity } = await import("./npc-identity.mjs");
            const id = resolveIdentity(this.actor, this.tokenDocument ?? null);
            if (id.isNamed) return;                    // already somebody

            const tokenDoc = this.tokenDocument
                ?? this.actor.getActiveTokens?.()[0]?.document
                ?? null;
            if (!tokenDoc) return;

            console.log(`${MODULE_ID} | "${id.name}" has no name or history — inventing both before the conversation starts.`);

            // ── PROMOTE FIRST, GENERATE SECOND (2026-08-07) ──────────────
            // Johnny: "as soon as somebody talks to someone, that thing becomes
            // a linked token immediately."
            //
            // Nine goblins share one base actor, so a biography written now
            // would land in this token's private delta — gone the moment the
            // token is deleted, invisible in the sidebar, unusable next session.
            // Worse, the rename in bio-generator is deliberately linked-only,
            // so an unlinked creature could never actually take its new name.
            //
            // Promotion runs BEFORE the AI, because contact is what makes a
            // creature a person, not whether a generation call succeeded. If
            // the AI is down he still has a real actor and a button to retry.
            let genToken = tokenDoc;
            try {
                const { promoteToNamedActor, isPromoted } = await import("./actor-promotion.mjs");
                if (!isPromoted(tokenDoc)) {
                    let factionName = "";
                    try {
                        const fid = this.actor.getFlag?.(MODULE_ID, "factionId");
                        if (fid) {
                            const { getFaction } = await import("./faction-registry.mjs");
                            factionName = getFaction(fid)?.name || "";
                        }
                    } catch (_) { /* folder nicety only */ }

                    const res = await promoteToNamedActor(tokenDoc, { factionName, reason: "spoken to by a player" });
                    if (res.promoted && res.actor) {
                        // Everything downstream must now target the NEW actor.
                        this.actor = res.actor;
                        genToken = tokenDoc;   // same token document, now linked
                    } else if (!res.actor) {
                        console.warn(`${MODULE_ID} | Promotion did not happen (${res.reason}) — the identity will live on the token only.`);
                    }
                }
            } catch (err) {
                // A creature that cannot be promoted can still be given a life;
                // it just will not persist past the token. Never block the chat.
                console.warn(`${MODULE_ID} | Could not promote this creature to a persistent actor (continuing):`, err);
            }

            const { queueBioGeneration } = await import("./bio-generator.mjs");
            // Since 2026-08-08 this resolves when the bio is actually WRITTEN,
            // not when it is queued — which is what we want here, because the
            // conversation reads that bio. But a conversation must never be held
            // hostage by a slow model, so cap the wait: if it overruns, the chat
            // opens anyway and the history lands when it lands.
            const _capped = await Promise.race([
                // onContact — somebody is TALKING to it. This is the lazy half
                // of "identity on first contact" and must not be gated by the
                // token-DROP setting.
                queueBioGeneration(genToken, { onContact: true }),
                new Promise(res => setTimeout(() => res({ ok: false, error: "timed out" }), 25_000)),
            ]);
            if (_capped?.ok === false) {
                console.warn(`${MODULE_ID} | Identity not ready before the chat opened (${_capped.error ?? "no reason given"}) — continuing without it.`);
            }
        } catch (err) {
            // Never block a conversation over this. A creature with no backstory
            // can still talk; it just has less to talk about.
            console.warn(`${MODULE_ID} | Could not generate an identity for this NPC (chat continues):`, err);
        }
    }

    /**
     * On the first conversation with a generic NPC (unlinked token), parse the
     * character's name from their bio and rename the canvas token so players
     * and the GM see a real name instead of "Barovian Commoner 02".
     * Only fires once — sets a flag to prevent repeat renames.
     */
    async _maybeRevealName() {
        // Only for unlinked tokens (generic NPCs that aren't shared with the base actor)
        if (!this.tokenDocument || this.tokenDocument.actorLink) return;

        // Already revealed or bio-generator already named this token? Don't rename again
        // Instance guard prevents race when two players close first exchange simultaneously.
        if (this._renameInProgress) return;
        const already = this.tokenDocument.getFlag(MODULE_ID, "nameRevealed");
        if (already) return;
        this._renameInProgress = true;

        // Parse name from biography — strip headings and module-injected labels first
        // so <h3>ACE: BIOGRAPHY</h3><p>Name... doesn't get "ACE" extracted as the name
        const bioHtml = this.actor.system?.details?.biography?.value || "";
        const stripped = bioHtml
          .replace(/<section[^>]*class="ace-engine-bio"[^>]*>[\s\S]*?<\/section>/gi, (match) => {
              // Keep only the bio paragraph text, strip ALL structural HTML
              return match.replace(/<[^>]*class="[^"]*(?:bio-header|bio-history)[^"]*"[^>]*>[\s\S]*?<\/[^>]*>/gi, " ");
          })
          .replace(/<h[1-6][^>]*>.*?<\/h[1-6]>/gi, " ")                    // headings
          .replace(/<div[^>]*class="[^"]*(?:bio|header|label)[^"]*"[^>]*>.*?<\/div>/gi, " ")  // module labels
          .replace(/<span[^>]*class="[^"]*(?:bio|header|label)[^"]*"[^>]*>.*?<\/span>/gi, " ") // span labels
          .replace(/ACE[:\s]*BIOGRAPHY/gi, " ")                             // our label (any format)
          .replace(/\bRESET\b/gi, " ");                                     // UI button text
        const div = document.createElement("div");
        div.innerHTML = stripped;
        const plainText = (div.textContent || "").trim();
        if (!plainText) return;

        // Extract name: first 1–3 capitalized words at the start of the bio.
        // Matches "Elara Voss", "Count Strahd", "Elya Morozov" etc.
        const nameMatch = plainText.match(/^([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})/);
        if (!nameMatch) return;

        const name = nameMatch[1].trim();

        // Don't rename if the extracted "name" is suspiciously short, a common article,
        // or a module/system keyword that leaked from HTML labels.
        // Check EACH word individually — catches "ACE Biography", "Token Details", etc.
        const BLOCKED_WORDS = /^(the|this|once|after|born|from|biography|ace|npc|dnd|srd|details|public|token|reset|envoy|engine|module|bandit|guard|goblin|orc|skeleton)$/i;
        if (name.length < 3) return;
        const nameWords = name.split(/\s+/);
        if (nameWords.some(w => BLOCKED_WORDS.test(w))) return;

        // Set nameRevealed flag BEFORE the network ops so concurrent callers see it immediately
        await this._setFlagSafe("nameRevealed", true);

        // DISPLAY-ONLY reveal. The chat hard-rename was RETIRED (2026-06-30) — it wrote the
        // real token.name, which the dnd5e sheet + every ACE pipeline read as identity, which
        // broke everything downstream. Now we only paint the revealed name on the nameplate/
        // hover via the flavorName flag; the REAL name is never touched. (Matches the
        // bio-generator's display-only architecture; this method already bails on linked
        // tokens above, so it's unlinked-only — the flavor name dies with the token.)
        try {
            const revealActor = this.tokenDocument?.actor ?? this.actor;
            await revealActor?.setFlag?.(MODULE_ID, "flavorName", name);
            if (game.user.isGM && this.tokenDocument) {
                const scene = game.scenes.get(this.tokenDocument.parent?.id || canvas.scene?.id);
                const tokenDoc = scene?.tokens?.get(this.tokenDocument.id);
                // displayName is nameplate VISIBILITY (a mode constant), NOT the name string — safe.
                if (tokenDoc) await tokenDoc.update({ displayName: CONST.TOKEN_DISPLAY_MODES.ALWAYS });
            }
        } catch (err) {
            console.warn("ACE: Engine | Display-only name reveal failed:", err);
        }

        // Update the name banner in the portrait area (display-only DOM label).
        this._updateNameLabel(name);

        console.log(`ACE: Engine | Name revealed (display-only) as "${name}" — real name untouched`);
    }

    /**
     * Update the NPC name label shown over the portrait.
     * Keeps the "— speaking with <PC>" half: a mid-conversation name reveal used
     * to replace the whole label with the bare new name, silently dropping who
     * the NPC was talking to. (2026-08-06)
     */
    _updateNameLabel(name) {
        if (!this._nameLabel || !name) return;
        // Same precedence as conversationTitle — the two must never disagree,
        // and both must prefer a known speaker over the last-resort guess.
        const who = this._speakerToken?.actor?.name
                 ?? this._speakerNameHint
                 ?? this.speakingAs?.name
                 ?? this._playerName
                 ?? game.user.character?.name
                 ?? null;
        this._nameLabel.textContent = (who && who !== name) ? `${name} — speaking with ${who}` : name;
        try {
            if (this.options?.window) this.options.window.title = this._nameLabel.textContent;
            const h = this.element?.querySelector?.(".window-title");
            if (h) h.textContent = this._nameLabel.textContent;
        } catch (_) { /* label already updated — frame is cosmetic */ }
    }

    async _summarizeSession() {
        if (!this.history?.length) return;
        const playerName = this.speakingAs?.name ?? game.user.name;
        try {
            await summarizeAndSaveSession(this.actor, this.history, playerName);
        } catch(e) {
            console.error("ACE: Engine | Session summarize failed:", e);
        }
    }

    async close(options = {}) {
        // Drop the perception listener FIRST — a hook that outlives its window
        // fires on every future scan, for every window ever opened.
        this._releasePerceptionHook();
        // Raw history is already saved per-exchange via _saveMemorySafe(),
        // so the underlying conversation data is durable BEFORE close even
        // runs. The slow work below (journal summary AI call, gmDismiss
        // broadcast, lock releases) is derivative — if it fails, the
        // raw conversation is still on the actor flag.
        //
        // This method is structured to tear down the DOM in milliseconds
        // (call super.close synchronously) and fire-and-forget the
        // persistence work afterward, so the GM never sees a window
        // lingering on screen while the AI summarizer runs for ~30 sec.
        const openConversations = npcChatState?.openConversations;

        // ── Spectator (readOnly) fast-path — unchanged, already instant ──
        if (this.readOnly) {
            try {
                const log = this.element?.querySelector?.("#ace-engine-log");
                if (log) log.innerHTML = "";
            } catch (_) {}
            if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
            if (this._sceneChangeHookId != null) { Hooks.off("canvasReady", this._sceneChangeHookId); this._sceneChangeHookId = null; }
            if (this._dialogueStartHookId != null) { Hooks.off("ace-engine.npcDialogueStart", this._dialogueStartHookId); this._dialogueStartHookId = null; }
            if (this._dialogueEndHookId != null)   { Hooks.off("ace-engine.npcDialogueEnd",   this._dialogueEndHookId);   this._dialogueEndHookId   = null; }
            ttsEngine.stop();
            if (openConversations?.get?.(this._convoKey) === this) {
                openConversations.delete(this._convoKey);
            }
            return super.close(options);
        }

        // ── 1. SYNCHRONOUS TEARDOWN — everything that must happen before
        //      the DOM goes away. All of this is fast (milliseconds total). ──
        if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
        if (this._micSendTimer) { clearTimeout(this._micSendTimer); this._micSendTimer = null; }
        if (this._recognition) { try { this._recognition.stop(); } catch(_) {} this._recognition = null; }
        if (this._sceneChangeHookId != null) { Hooks.off("canvasReady", this._sceneChangeHookId); this._sceneChangeHookId = null; }
        if (this._dialogueStartHookId != null) { Hooks.off("ace-engine.npcDialogueStart", this._dialogueStartHookId); this._dialogueStartHookId = null; }
        if (this._dialogueEndHookId != null)   { Hooks.off("ace-engine.npcDialogueEnd",   this._dialogueEndHookId);   this._dialogueEndHookId   = null; }
        ttsEngine.stop();

        // Pull the openConversations entry NOW so reopening the same NPC
        // immediately works while the background cleanup is still running.
        if (openConversations?.get?.(this._convoKey) === this) {
            openConversations.delete(this._convoKey);
        }

        // ── 2. CAPTURE STATE — everything the background work needs, into
        //      local variables. The `this` reference becomes unreliable
        //      after super.close (the app instance is detached from
        //      Foundry's registry and the DOM is gone). ──
        const bgState = {
            actor:               this.actor,
            tokenDocument:       this.tokenDocument,
            history:             this.history,
            lockedActorId:       this._lockedActorId,
            gmForced:            this._gmForced,
            isConversationOwner: this._isOwner && !game.user.isGM,
            isGMUser:            game.user.isGM,
            closingPlayerName:   this.speakingAs?.name ?? game.user.name,
            currentUserId:       game.user.id,
            npcLocks:            npcChatState?.npcLocks,
        };
        this._lockedActorId = null;  // pre-clear to prevent re-entry double-work

        // ── 3. DOM TEARDOWN — fire super.close immediately. The window
        //      disappears from the GM's screen in milliseconds. ──
        const closePromise = super.close(options);

        // ── 4. BACKGROUND PERSISTENCE — fire-and-forget. The window is
        //      already gone; everything below runs on its own promise
        //      while the GM moves on with the game. Failures surface
        //      via a toast so partial saves don't go silent. ──
        this._runBackgroundClose(bgState).catch(err => {
            console.error("ACE: Engine | Background close cleanup failed:", err);
            try { ui.notifications?.warn(`ACE: Engine — session save partial: ${err?.message || err}`); }
            catch (_) {}
        });

        return closePromise;
    }

    /**
     * Runs the slow persistence work after the window has visually closed.
     * All state references come from the bgState object — `this` may have
     * been detached by Foundry's app teardown by the time this executes.
     *
     * Order matters:
     *   1. Token movement-lock release (player path only — no-op for GM)
     *   2. NPC conversation-lock release + broadcast (gold icons return)
     *   3. gmDismiss broadcast (player path) — ships history to GM for summary
     *      OR direct _summarizeSession (GM-owned chat path)
     *      OR stopAudio (spectator path — handled in fast branch above, but
     *      defensive fallback here for non-GM, non-owner edge case)
     */
    async _runBackgroundClose(s) {
        // Token movement-lock release. _lockPlayerToken is a no-op for GMs,
        // so this matters only for player closes. Already wrapped in
        // try/catch internally, so it can't throw.
        try { await this._lockPlayerToken(false); } catch (_) {}

        // Conversation lock release (player-owner path) — broadcast so other
        // clients' chat icons go back to gold.
        if (s.lockedActorId) {
            if (s.npcLocks) s.npcLocks.delete(s.lockedActorId);
            try {
                game.socket.emit(`module.${MODULE_ID}`, {
                    action: "lockClear", actorId: s.lockedActorId, userId: s.currentUserId,
                });
            } catch (_) {}
        }

        if (s.gmForced) return;

        if (s.isConversationOwner) {
            // Player closed their own chat. Ship the full history to the
            // GM via socket — GM-side handler in ace-engine.mjs persists
            // it to actor flags AND runs summarizeAndSaveSession to write
            // the journal entry.
            try {
                game.socket.emit(`module.${MODULE_ID}`, {
                    action:     "gmDismiss",
                    actorId:    s.actor.id,
                    tokenId:    s.tokenDocument?.id || null,
                    source:     "player",
                    playerName: s.closingPlayerName,
                    history:    s.history,
                });
            } catch (_) {}
        } else if (s.isGMUser) {
            // GM closed a GM-owned chat (puppet mode). Run the summary
            // directly — this is the slow one (AI summarizer call, ~5-30s).
            // The window is already visually gone; the GM doesn't wait.
            if (s.history?.length > 0) {
                await this._summarizeSession();
            }
        } else {
            // Edge case: non-GM, non-owner. Stop any audio that might
            // still be playing on this client.
            try {
                game.socket.emit(`module.${MODULE_ID}`, {
                    action: "stopAudio", targetUserId: s.currentUserId
                });
            } catch (_) {}
        }
    }

    async _setFlagSafe(key, value) {
        // All NPC chat flags (memoryLog, voice, personality, gmNotes, faction
        // assignment, etc.) target the synthetic actor:
        //   - Linked tokens   → tokenDocument.actor === base actor (shared)
        //   - Unlinked tokens → tokenDocument.actor === base + ActorDelta layer
        //                       (per-instance, read+write hit the same delta)
        // Previously memoryLog wrote to tokenDocument flags but was read from
        // tokenDocument.actor — different storage. That caused unlinked
        // instances to all share the base actor's stale memoryLog because
        // their writes silently went into a TokenDocument flag the constructor
        // never looked at. Routing every flag through the synthetic actor
        // makes write and read symmetric and ties history to the on-canvas
        // identity (the renamed token + its delta) instead of the base
        // creature template.
        const target = (this.tokenDocument && !this.tokenDocument.actorLink && this.tokenDocument.actor)
                     ? this.tokenDocument.actor
                     : this.actor;

        if (value === null || value === undefined) {
            if (game.user.isGM) {
                return target.unsetFlag(MODULE_ID, key);
            }
            // Player path: ask the GM to apply on our behalf via socket.
            // tokenId tells the receiver to resolve the synthetic actor for
            // unlinked tokens; null means hit the base actor directly.
            const tokenId = (this.tokenDocument && !this.tokenDocument.actorLink)
                          ? this.tokenDocument.id : null;
            // ⚠️ userId is REQUIRED now. The GM-side handler refuses a payload
            // that names nobody — it cannot check a claim that was never made.
            game.socket.emit(`module.${MODULE_ID}`, {
                action: "unsetFlag", actorId: this.actor.id, tokenId, key,
                userId: game.user.id
            });
            return;
        }
        if (game.user.isGM) {
            return target.setFlag(MODULE_ID, key, value);
        }
        const tokenId = (this.tokenDocument && !this.tokenDocument.actorLink)
                      ? this.tokenDocument.id : null;
        game.socket.emit(`module.${MODULE_ID}`, {
            action: "setFlag", actorId: this.actor.id, tokenId, key, value,
            userId: game.user.id
        });
    }

    renderMessage(role, content) {
        let displayContent = content;

        // ── Extract [SUBTLE_CHECK:skill:dc:flavor] tags BEFORE any stripping ──
        // The tag is ALWAYS stripped from the displayed text — player never sees it.
        // A GM-only suggestion card is posted to chat so the GM can approve / send it.
        let subtleCheck = null;
        let dispositionTag = null;
        if (role === "assistant") {
            const checkMatch = displayContent.match(/\[SUBTLE_CHECK:(\w+):(\d+):([^\]]+)\]/);
            if (checkMatch) {
                subtleCheck = { skill: checkMatch[1], dc: parseInt(checkMatch[2]), flavor: checkMatch[3] };
                displayContent = displayContent.replace(/\[SUBTLE_CHECK:[^\]]+\]/g, "").trim();
            }

            // ── Extract [DISPOSITION:FRIENDLY/HOSTILE/NEUTRAL/SECRET] tags ──
            // Silently strip from display, then route to ACE Engine's reputation
            // engine to actually update the token's disposition on the canvas.
            const dispMatch = displayContent.match(/\[DISPOSITION:(HOSTILE|NEUTRAL|FRIENDLY|SECRET)\]/i);
            if (dispMatch) {
                dispositionTag = dispMatch[1].toUpperCase();
                displayContent = displayContent.replace(/\[DISPOSITION:[^\]]+\]/gi, "").trim();
            }

            displayContent = displayContent.replace(/\*(.*?)\*/g, "").replace(/\s{2,}/g, " ").trim();
        }
        if (!displayContent) return;

        const html = escapeHtml(displayContent);

        if (!this._messageLog) this._messageLog = [];
        this._messageLog.push({ role, html });

        if (this._logContainer) {
            const div = document.createElement("div");
            div.className = `ace-engine-message ace-engine-${role}`;
            div.innerHTML = `<div class="ace-engine-bubble">${html}</div>`;
            this._logContainer.appendChild(div);
            // Scroll after the browser has painted the new element
            requestAnimationFrame(() => {
                this._logContainer.scrollTop = this._logContainer.scrollHeight;
            });
        }

        // Return focus to input field so the player can keep typing
        if (this._inputField && !this._inputField.disabled) {
            this._inputField.focus();
        }

        // ── Notify the GM about the suggested check (GM decides whether to send) ──
        if (subtleCheck && role === "assistant") {
            this._notifyGmSubtleCheck(subtleCheck);
        }

        // ── Apply disposition change via ACE Engine's reputation system ──
        if (dispositionTag && role === "assistant" && game.user.isGM) {
            this._applyDispositionChange(dispositionTag);
        }
    }

    /**
     * Route a [DISPOSITION:...] tag to ACE Engine's reputation system
     * to update the NPC token's disposition ring on the canvas.
     */
    _applyDispositionChange(label) {
        const DISP_MAP = {
            HOSTILE:  -1, // CONST.TOKEN_DISPOSITIONS.HOSTILE
            NEUTRAL:   0, // CONST.TOKEN_DISPOSITIONS.NEUTRAL
            FRIENDLY:  1, // CONST.TOKEN_DISPOSITIONS.FRIENDLY
            SECRET:   -2, // CONST.TOKEN_DISPOSITIONS.SECRET
        };
        const newDisp = DISP_MAP[label];
        if (newDisp == null) return;

        // Try ACE Engine's reputation system first (via bridge — logs event, shows notification)
        if (EngineBridge.isEngineActive()) {
            const npcName = this.actor?.name;
            if (npcName) {
                EngineBridge.applyDispositionChange(npcName, newDisp).catch(err => {
                    console.error("ACE: Engine | Disposition change failed:", err);
                });
            }
            return;
        }

        // Fallback: update the token directly if ACE Engine isn't available
        const npcName = this.actor?.name;
        if (!npcName) return;
        const token = canvas?.tokens?.placeables?.find(t => t.name === npcName);
        if (token?.document) {
            token.document.update({ disposition: newDisp }).catch(err => {
                console.error("ACE: Engine | Disposition update failed:", err);
            });
        }
    }

    /**
     * Send a GM-only suggestion card to Foundry chat when the NPC AI
     * determines the player should make a skill check. The GM reviews
     * the suggestion and clicks "Send Roll Request" to push it to the
     * player — the player never sees anything until the GM approves.
     */
    _notifyGmSubtleCheck(check) {
        const SKILL_NAMES = {
            acr: "Acrobatics", ani: "Animal Handling", arc: "Arcana",
            ath: "Athletics",  dec: "Deception",       his: "History",
            ins: "Insight",    itm: "Intimidation",    inv: "Investigation",
            med: "Medicine",   nat: "Nature",          prc: "Perception",
            prf: "Performance", per: "Persuasion",     rel: "Religion",
            slt: "Sleight of Hand", ste: "Stealth",    sur: "Survival",
        };
        const skillLabel = SKILL_NAMES[check.skill] || check.skill;

        // Resolve the PC actor talking to this NPC.
        // On the GM client, game.user.character is the GM's own character (wrong).
        // Use the NPC lock info to find the player who initiated the conversation,
        // then look up their assigned character.
        const lockInfo  = game.modules.get(MODULE_ID)?.api?.getNpcLock?.(this.actor.id);
        const ownerUser = lockInfo?.userId
            ? game.users?.get(lockInfo.userId)
            : null;
        const pcActor   = ownerUser?.character ?? game.user?.character;
        const pcName    = pcActor?.name ?? ownerUser?.name ?? lockInfo?.userName ?? "Unknown";

        // ── Route through ACE Engine if available (via bridge) ──
        if (EngineBridge.getSubtleRolls()) {
            // Use ACE Engine's detection card system — posts a GM-only whisper
            // with an "Approve / Send Roll Request" button
            const gmUsers = game.users?.filter(u => u.isGM && u.active) ?? [];
            const gmIds   = gmUsers.map(u => u.id);

            const flavorSafe = (check.flavor ?? "").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

            const cardHtml =
                `<div class="ace-subtle-detection" style="background:#1c150e;border-left:4px solid #8a5bbf;` +
                `border-radius:4px;padding:10px 12px;font-family:'IM Fell English','Palatino Linotype',serif;line-height:1.6;">` +
                `<div style="color:#c4a8f0;font-weight:bold;font-size:0.95em;margin-bottom:4px;">` +
                `<i class="fas fa-comments" style="margin-right:4px;"></i> Envoy — Subtle Check Suggestion</div>` +
                `<div style="color:#eddfc5;margin-bottom:6px;">` +
                `<strong>${escapeHtml(pcName)}</strong> is speaking with <strong>${escapeHtml(this.npcName)}</strong> — ` +
                `the NPC thinks a <strong style="color:#c4a8f0;">${skillLabel}</strong> check (DC ${check.dc}) is warranted.</div>` +
                `<div style="font-size:0.85em;color:#b0a080;font-style:italic;margin-bottom:8px;">` +
                `"${escapeHtml(check.flavor)}"</div>` +
                `<button class="ace-chat-btn" data-ace-btn="subtle-send-request" ` +
                `data-skill="${check.skill}" data-dc="${check.dc}" ` +
                `data-actor-id="${pcActor?.id ?? ""}" data-user-id="${ownerUser?.id ?? ""}" ` +
                `data-flavor="${flavorSafe}" ` +
                `style="display:block;width:100%;padding:7px 10px;background:#18102a;` +
                `border:1px solid #8a5bbf;border-radius:4px;color:#c4a8f0;cursor:pointer;` +
                `font-family:inherit;font-size:0.95em;text-align:center;font-weight:bold;">` +
                `<i class="fas fa-paper-plane" style="margin-right:6px;"></i>Send Roll Request to ${escapeHtml(pcName)}</button>` +
                `</div>`;

            ChatMessage.create({
                content: cardHtml,
                speaker: { alias: "ACE: Engine" },
                whisper: gmIds,
                flags:   { "ace-engine": { isSubtleDetection: true, source: "envoy" } },
            });
            return;
        }

        // ── Fallback: basic GM whisper without ACE Engine ──
        const gmUsers = game.users?.filter(u => u.isGM && u.active) ?? [];
        if (!gmUsers.length) return;

        ChatMessage.create({
            content: `<div style="background:#1c150e;border-left:4px solid #8a5bbf;border-radius:4px;padding:10px 12px;">` +
                `<strong style="color:#c4a8f0;">Envoy — Check Suggestion</strong><br>` +
                `<strong>${escapeHtml(pcName)}</strong> is speaking with <strong>${escapeHtml(this.npcName)}</strong>.<br>` +
                `The NPC suggests a <strong>${skillLabel}</strong> check (DC ${check.dc}).<br>` +
                `<em style="color:#b0a080;">"${escapeHtml(check.flavor)}"</em></div>`,
            speaker: { alias: "ACE: Engine" },
            whisper: gmUsers.map(u => u.id),
        });
    }

    async _lockPlayerToken(locked) {
        if (game.user.isGM) return;
        // Find the player's owned token on the scene (may differ from game.user.character)
        const token = canvas.tokens?.placeables?.find(t =>
            t.actor?.hasPlayerOwner
            && t.actor.testUserPermission(game.user, "OWNER")
        ) ?? canvas.tokens?.placeables?.find(t => t.document?.actorId === game.user.character?.id);
        if (!token) return;

        try {
            if (locked) {
                this._lockedTokenId = token.id;
                await token.document.setFlag(MODULE_ID, "conversationLocked", true);
                console.log(`ACE: Engine | Player token movement locked`);
            } else {
                this._lockedTokenId = null;
                // Clear both new and legacy flags. AWAIT both — the close()
                // path used to fire-and-forget these, and if the app context
                // tore down before the flag write completed (browser reload,
                // crash, hard ESC) the flag would persist to the next session
                // and block all player movement until manually cleared.
                await token.document.unsetFlag(MODULE_ID, "conversationLocked");
                try { await token.document.unsetFlag("npclink", "conversationLocked"); } catch(_) {}
                console.log(`ACE: Engine | Player token movement unlocked`);
            }
        } catch (err) {
            console.warn("ACE: Engine | _lockPlayerToken update failed:", err);
        }
    }

    /**
     * Called on the GM client when the conversing player closes their
     * conversation window (or otherwise terminates — scene change, etc.).
     * Surfaces four layered notifications so the GM never sits on a stale
     * conversation thinking it's still active:
     *   1. Yellow banner across the top of the chat window
     *   2. Foundry toast notification (top-right corner)
     *   3. System message inserted into the chat log
     *   4. Two-tone chime via Web Audio (no asset dependency)
     *   5. Input field disabled with explanatory placeholder
     * Idempotent — re-calls are no-ops once the banner is shown.
     */
    async notifyPlayerEnded(playerName = "Player") {
        if (this._playerHasEnded) return;  // idempotent
        this._playerHasEnded = true;

        const npcName = this.npcName || this.actor?.name || "the NPC";
        // GM puppet windows keep their input ENABLED — the GM should be
        // able to keep speaking as the NPC after the player closes (taunt
        // them in chat, drop a parting threat, etc.). Spectator windows
        // (any non-GM client watching) get the input disabled because
        // they can't do anything useful with it anyway.
        const isGmPuppet = game.user.isGM && !this.readOnly;

        // ── 1. Banner inside the conversation window ─────────────
        try {
            const root = this.element;
            if (root && !root.querySelector(".ace-engine-player-ended-banner")) {
                const banner = document.createElement("div");
                banner.className = "ace-engine-player-ended-banner";
                const bannerText = isGmPuppet
                    ? `<strong>${this._escAttr(playerName)}</strong> has closed their chat — you can still puppet <strong>${this._escAttr(npcName)}</strong>. Type a line to drop it into Foundry chat as the NPC.`
                    : `<strong>${this._escAttr(playerName)}</strong> has ended this conversation with <strong>${this._escAttr(npcName)}</strong>. Close this window when you're done reviewing.`;
                banner.innerHTML = `
                    <i class="fa-solid fa-circle-exclamation"></i>
                    <span>${bannerText}</span>
                `;
                // Insert at the very top of the conversation pane, above
                // the chat log. Element children vary by template — try
                // a few likely anchors so this works regardless of layout.
                const anchor = root.querySelector(".window-content")
                            ?? root.querySelector("#ace-engine-log")?.parentElement
                            ?? root;
                anchor.prepend(banner);
            }
        } catch (_) { /* banner is non-critical, don't block */ }

        // ── 2. Foundry toast ────────────────────────────────────
        try { ui.notifications?.warn(`${playerName} ended the conversation with ${npcName}.`); }
        catch (_) {}

        // ── 3. System message in the chat log ───────────────────
        try { this.renderMessage("system", `── ${playerName} ended the conversation ──`); }
        catch (_) {}

        // ── 4. Two-tone chime via Web Audio (no asset needed) ──
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) {
                const ctx  = new Ctx();
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.setValueAtTime(660, ctx.currentTime);                 // E5
                osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);          // A5
                gain.gain.setValueAtTime(0.15, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.35);
                setTimeout(() => ctx.close().catch(() => {}), 600);
            }
        } catch (_) { /* audio may be blocked */ }

        // ── 5. Disable input + update placeholder ───────────────
        // Skip for GM puppet windows — GM keeps typing capability so they
        // can taunt the player after the player closes. Only spectator
        // (readOnly) windows get the input disabled.
        if (!isGmPuppet) {
            try {
                const input = this.element?.querySelector?.("#ace-engine-input");
                if (input) {
                    input.disabled = true;
                    input.placeholder = `${playerName} has left — close this window when done`;
                }
                // Also disable the Send button if there is one
                const sendBtn = this.element?.querySelector?.("#ace-engine-send, [data-action=\"send\"]");
                if (sendBtn) sendBtn.disabled = true;
            } catch (_) { /* non-critical */ }
        }
    }

    /** Defensive attribute-escape for innerHTML strings. */
    _escAttr(s) {
        return String(s ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    _watchForSceneChange() {
        this._startingSceneId = canvas.scene?.id;
        // Use a Foundry hook instead of polling — fires when a new scene is drawn
        this._sceneChangeHookId = Hooks.on("canvasReady", () => {
            if (canvas.scene?.id !== this._startingSceneId) {
                console.warn("ACE: Engine | Conversing player changed scene — ending conversation");
                Hooks.off("canvasReady", this._sceneChangeHookId);
                this._sceneChangeHookId = null;
                this.renderMessage("system", "Conversation ended — you moved to another area.");
                game.socket.emit(`module.${MODULE_ID}`, {
                    action:     "gmDismiss",
                    actorId:    this.actor.id,
                    tokenId:    this.tokenDocument?.id || null,
                    source:     "player",
                    playerName: this._playerName ?? game.user.character?.name ?? game.user.name
                });
                npcChatState?.openConversations?.delete?.(this._convoKey);
                this._gmForced = true;
                this.close();
            }
        });
    }

    setThinking(isThinking) {
        this.isThinking = isThinking;
        if (!this._thinkingIndicator) return;
        this._thinkingIndicator.style.display = isThinking ? "flex" : "none";
        if (this._sendBtn) this._sendBtn.disabled = isThinking;
        // Return cursor to input when AI finishes thinking
        if (!isThinking && this._inputField && !this._inputField.disabled) {
            this._inputField.focus();
        }
    }
}
