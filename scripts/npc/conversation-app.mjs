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
import { getCreatureSoundFolder, getVoicePitch }     from "./creature-sounds.mjs";
import { npcChatState }                              from "./activate.mjs";
import { isAIFailure }                               from "./ai-failure.mjs";

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

    /** The PC actor speaking in this conversation (resolved once at creation). */
    get speakingAs() {
        // If a speaker was explicitly set at conversation creation, use it
        if (this._speakerToken?.actor) return this._speakerToken.actor;

        // Fallback: derive from current state (legacy path)
        if (game.user.isGM) {
            const sel = canvas.tokens?.controlled?.[0];
            if (sel && sel.actor?.id !== this.actor.id) return sel.actor;
        }
        const sceneToken = canvas.tokens?.placeables?.find(t =>
            t.actor?.hasPlayerOwner
            && t.actor.testUserPermission(game.user, "OWNER")
            && t.document?.actorId !== this.actor.id
        );
        return sceneToken?.actor ?? game.user.character;
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

        // Only register event listeners once (prevents stacking on re-render)
        if (!isReRender) {
            this._sendBtn.addEventListener("click",   () => this.handleSend());
            this._micBtn.addEventListener("click",    () => this.handleMic());
            this._initMicPicker();
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
                    this.handleSend();
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
            if (this._sendBtn) this._sendBtn.title = "Speak as NPC";

            const stopAllBtn = el.querySelector("#ace-engine-stop-all");
            stopAllBtn?.addEventListener("click", () => {
                Dialog.confirm({
                    title: "Stop Conversation?",
                    content: `<p>Stop the conversation with <strong>${escapeHtml(this.npcName)}</strong> for everyone?</p>`,
                    yes: () => this._gmStopAll(),
                    no:  () => {}
                });
            });
        }

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
            pauseBtn.innerHTML = this._paused
                ? '<i class="fas fa-play"></i>'
                : '<i class="fas fa-pause"></i>';
            pauseBtn.classList.toggle("ace-engine-paused", this._paused);
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
        const text = this._inputField?.value?.trim();
        if (!text) return;
        // Stop any in-progress TTS before puppet speaks
        if (ttsEngine.isPlaying) ttsEngine.stop();
        this._inputField.value = "";

        this.renderMessage("assistant", text);

        game.socket.emit(`module.${MODULE_ID}`, {
            action:  "conversationMessage",
            actorId: this.actor.id,
            role:    "assistant",
            content: text,
            exclude: game.user.id
        });

        const dialogueOnly = text.replace(/\*(.*?)\*/g, "").trim();
        if (dialogueOnly) {
            ChatMessage.create({
                speaker: {
                    alias: this.actor.name,
                    actor: this.actor.id,
                    token: this.tokenDocument?.id || null,
                    scene: canvas.scene?.id || null
                },
                content: `<p>${dialogueOnly}</p>`,
                flags: { [MODULE_ID]: { isAIConversation: true } }
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
        const soundFolder = getCreatureSoundFolder(this.actor);
        const voicePitch  = getVoicePitch(this.actor);
        try {
            const result = await ttsEngine.speakResponse(text, voiceId, this.actor.name, soundFolder, voicePitch, this._getLiveVoiceSettings());
            if (result === "invalid") {
                console.warn("ACE: Engine | Puppet: voice invalid, fetching replacement...");
                await this._setFlagSafe("voiceId", null);
                const config = await getVoiceConfig(this.actor, this.tokenDocument);
                voiceId = config.voiceId;
                this._voiceId = voiceId;
                this._voiceSettings = config.voiceSettings || {};
                await ttsEngine.speakResponse(text, voiceId, this.actor.name, soundFolder, voicePitch, this._getLiveVoiceSettings());
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
        this._micFinalText = "";       // survives session cycles — see onresult
        let fatal = false;
        let restarts = 0;
        let heardAnything = false;

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
            const dialogueOnly = text.replace(/\*(.*?)\*/g, "").trim();
            if (dialogueOnly) {
                ChatMessage.create({
                    speaker: {
                        alias: this.actor.name,
                        actor: this.actor.id,
                        token: this.tokenDocument?.id || null,
                        scene: canvas.scene?.id || null
                    },
                    content: `<p>${dialogueOnly}</p>`,
                    flags: { [MODULE_ID]: { isAIConversation: true, gmInterjection: true } }
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
                const soundFolder = getCreatureSoundFolder(this.actor);
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
            actorId: this.actor.id,
            tokenId: this.tokenDocument?.id || null,
            role:    "user",
            content: text,
            exclude: game.user.id
        });

        this.setThinking(true);

        this._resetInactivityTimer();

        try {
            const response = await AIHandler.getResponse(this.actor, text, this.history, { speakerActor: this.speakingAs });

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
                actorId: this.actor.id,
                tokenId: this.tokenDocument?.id || null,
                role:    "assistant",
                content: response,
                exclude: game.user.id
            });

            const dialogueOnly = response
                .replace(/\[SUBTLE_CHECK:[^\]]+\]/g, "")
                .replace(/\[DISPOSITION:[^\]]+\]/gi, "")
                .replace(/\*(.*?)\*/g, "")
                .replace(/\s{2,}/g, " ")
                .trim();
            if (dialogueOnly) {
                ChatMessage.create({
                    speaker: {
                        alias: this.actor.name,
                        actor: this.actor.id,
                        token: this.tokenDocument?.id || null,
                        scene: canvas.scene?.id || null
                    },
                    content: `<p><strong>${playerName}:</strong> ${text}</p><p>${dialogueOnly}</p>`,
                    flags: { [MODULE_ID]: { isAIConversation: true } }
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
            const soundFolder = getCreatureSoundFolder(this.actor);
            const voicePitch  = getVoicePitch(this.actor);

            // Strip AI tags before sending to TTS — emotes (*action*) are left
            // intact because tts.js handles dialogue vs emote segmentation itself.
            const ttsText = response
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
        }, 30 * 60 * 1000);  // 30 minutes — covers normal tabletop pauses (rule lookups, snack breaks, party deliberation)
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

    /** Update the NPC name label shown over the portrait. */
    _updateNameLabel(name) {
        if (this._nameLabel && name) this._nameLabel.textContent = name;
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
            game.socket.emit(`module.${MODULE_ID}`, {
                action: "unsetFlag", actorId: this.actor.id, tokenId, key
            });
            return;
        }
        if (game.user.isGM) {
            return target.setFlag(MODULE_ID, key, value);
        }
        const tokenId = (this.tokenDocument && !this.tokenDocument.actorLink)
                      ? this.tokenDocument.id : null;
        game.socket.emit(`module.${MODULE_ID}`, {
            action: "setFlag", actorId: this.actor.id, tokenId, key, value
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
