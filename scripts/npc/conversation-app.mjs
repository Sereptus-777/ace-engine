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
        id:     "ace-engine-app",
        window: { title: "ACE: Engine", resizable: true, minimizable: true },
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
        this._thinkingIndicator = el.querySelector("#ace-engine-thinking");
        this._nameLabel         = el.querySelector("#ace-engine-npc-name");
        this._portraitImg       = el.querySelector("#ace-engine-portrait");

        this._thinkingIndicator.style.display = "none";

        // Only register event listeners once (prevents stacking on re-render)
        if (!isReRender) {
            this._sendBtn.addEventListener("click",   () => this.handleSend());
            this._micBtn.addEventListener("click",    () => this.handleMic());
            this._inputField.addEventListener("keypress", (ev) => {
                if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); this.handleSend(); }
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

            this._listenersAttached = true;
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
        const pauseBtn = el.querySelector("#ace-engine-pause");
        pauseBtn?.addEventListener("click", () => {
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

        const { lockNPC, isNPCLocked, isLockedByMe } = window._aceEnvoy ?? {};
        if (lockNPC && !game.user.isGM) {
            const actorId = this.actor.id;
            if (!isNPCLocked(actorId)) {
                lockNPC(actorId, game.user.id, game.user.name, this.tokenDocument?.id || null);
                this._lockPlayerToken(true);
                this._watchForSceneChange();
            } else if (!isLockedByMe(actorId)) {
                // NPC is locked by another player — demote to spectator permanently
                this.readOnly = true;
                this._isOwner = false;
                this._setUILocked(true, `${escapeHtml(this.npcName)} is already in conversation.`);
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
        const { unlockNPC, openConversations } = window._aceEnvoy ?? {};
        unlockNPC?.(this.actor.id);
        openConversations?.delete(this._convoKey);
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
                flags: { MODULE_ID: { isAIConversation: true } }
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

    async handleMic() {
        // Hard block: only the lock owner or GM can use mic
        if (!game.user.isGM && this.readOnly) return;
        const { isNPCLocked, isLockedByMe } = window._aceEnvoy ?? {};
        if (!game.user.isGM && isNPCLocked && isNPCLocked(this.actor.id) && !isLockedByMe(this.actor.id)) {
            console.warn("ACE: Engine | Blocked mic — not the active speaker.");
            return;
        }

        // ── Toggle OFF: stop listening and send what we have ─────────────
        if (this._recognition) {
            this._recognition.stop();
            this._recognition = null;
            this._micBtn.classList.remove("active");
            if (this._micSendTimer) { clearTimeout(this._micSendTimer); this._micSendTimer = null; }
            // Send whatever has been accumulated
            if (this._inputField.value.trim()) this.handleSend();
            return;
        }

        // ── Toggle ON: start continuous listening ────────────────────────
        if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
            ui.notifications.warn("Your browser does not support voice input.");
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        const recognition       = new SpeechRecognition();
        recognition.lang            = "en-US";
        recognition.continuous      = true;       // keep listening across pauses
        recognition.interimResults  = true;        // show words as they're spoken
        recognition.maxAlternatives = 1;

        this._micBtn.classList.add("active");
        this._recognition = recognition;
        let _micFatalError = false;   // tracks real errors vs transient ones
        let _micRestarts   = 0;       // prevent infinite restart loops

        recognition.onresult = (event) => {
            // Guard: drop late results that fire AFTER we've explicitly aborted
            // recognition (e.g. user clicked Send while still mid-speech). Without
            // this, the browser's queued onresult events overwrite the cleared
            // input field and the just-sent text reappears in the textarea.
            if (!this._recognition || this._recognition !== recognition) return;

            _micRestarts = 0;  // successful result = reset restart counter

            // Rebuild full transcript from scratch each event (no accumulator)
            let final = "", interim = "";
            for (let i = 0; i < event.results.length; i++) {
                if (event.results[i].isFinal) {
                    final += event.results[i][0].transcript + " ";
                } else {
                    interim += event.results[i][0].transcript;
                }
            }
            const full = (final + interim).trim();

            // Safety cap — prevent runaway text (500 chars max)
            this._inputField.value = full.length > 500 ? full.slice(0, 500) : full;

            // Reset the auto-send timer — sends 6s after the last speech.
            // Gives the speaker time to pause and collect their thoughts.
            if (this._micSendTimer) clearTimeout(this._micSendTimer);
            this._micSendTimer = setTimeout(() => {
                if (this._recognition) {
                    this._recognition.stop();
                    this._recognition = null;
                    this._micBtn.classList.remove("active");
                    if (this._inputField.value.trim()) this.handleSend();
                }
            }, 6000);
        };

        recognition.onerror = (event) => {
            // Transient errors — browser cycling, no speech yet, etc.
            if (event.error === "no-speech" || event.error === "aborted") return;

            // Real errors — stop everything
            console.error("ACE: Engine | Mic error:", event.error);
            _micFatalError = true;
            this._micBtn.classList.remove("active");
            this._recognition = null;

            // Helpful hint for common issues
            const isBrave = navigator.brave?.isBrave || navigator.userAgent.includes("Brave");
            if (event.error === "not-allowed") {
                ui.notifications.warn("Microphone permission denied. Check your browser settings.");
            } else if (event.error === "network") {
                if (isBrave) {
                    ui.notifications.warn("Voice input is not supported in Brave — its privacy shields block the speech service. Please use Chrome or Edge instead.", { permanent: true });
                } else {
                    ui.notifications.warn("Speech recognition requires an internet connection (audio is processed by your browser's cloud service).");
                }
            }
        };

        recognition.onend = () => {
            // Already cleaned up (manual stop, auto-send timer, or fatal error)
            if (!this._recognition || _micFatalError) return;

            // Browser often cycles the recognition session with continuous:true.
            // Auto-restart to keep listening (up to 5 retries without results).
            if (_micRestarts < 5) {
                _micRestarts++;
                try {
                    recognition.start();
                    console.log(`ACE: Engine | Mic: auto-restarted (cycle ${_micRestarts}).`);
                    return;
                } catch (_) { /* fall through to cleanup */ }
            }

            // Could not restart or too many retries — send what we have
            console.log("ACE: Engine | Mic: session ended, sending accumulated text.");
            this._recognition = null;
            this._micBtn.classList.remove("active");
            if (this._micSendTimer) { clearTimeout(this._micSendTimer); this._micSendTimer = null; }
            if (this._inputField.value.trim()) this.handleSend();
        };

        try {
            recognition.start();
            console.log("ACE: Engine | Mic: continuous listening started — click mic again or pause 2.5s to send.");
        } catch(e) {
            console.error("ACE: Engine | Mic start failed:", e);
            this._micBtn.classList.remove("active");
            this._recognition = null;
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

        // Hard block: only the lock owner or GM can send messages
        if (!game.user.isGM && this.readOnly) return;
        const { isNPCLocked, isLockedByMe } = window._aceEnvoy ?? {};
        if (!game.user.isGM && isNPCLocked && isNPCLocked(this.actor.id) && !isLockedByMe(this.actor.id)) {
            console.warn("ACE: Engine | Blocked send — not the active speaker.");
            return;
        }

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
                    flags: { MODULE_ID: { isAIConversation: true, gmInterjection: true } }
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
                    flags: { MODULE_ID: { isAIConversation: true } }
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
            console.warn("ACE: Engine | Inactivity timeout — releasing lock");
            const { unlockNPC, isLockedByMe, openConversations } = window._aceEnvoy ?? {};
            if (unlockNPC && isLockedByMe?.(this.actor.id)) {
                unlockNPC(this.actor.id);
            }
            openConversations?.delete(this._convoKey);
            this.renderMessage("system", "Conversation timed out due to inactivity.");
            await this._summarizeSession();
            this._setUILocked(true, "");
        }, 5 * 60 * 1000);
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

        for (const path of candidates) {
            // eslint-disable-next-line no-await-in-loop
            if (await this._fileExists(path)) {
                this._speakingWebpSrc = path;
                console.log(`ACE: Engine | Conversation | Speaking WebP found: ${decodeURIComponent(path)}`);
                break;
            }
        }

        if (!this._speakingWebpSrc) {
            const tried = candidates.map(p => decodeURIComponent(p.split("/").pop())).join(", ") || "(none — actor has no name/type data)";
            console.log(`ACE: Engine | Conversation | No speaking WebP for ${tokenName || actorName} (tried: ${tried})`);
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
        // For unlinked tokens, check the token document's flags (not the base actor)
        const already = this.tokenDocument.getFlag(MODULE_ID, "nameRevealed");
        if (already) return;

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

        // Update the token document name + make nameplate always visible
        const sceneId = this.tokenDocument.parent?.id || canvas.scene?.id;
        if (game.user.isGM) {
            const scene = game.scenes.get(sceneId);
            const tokenDoc = scene?.tokens?.get(this.tokenDocument.id);
            if (tokenDoc) await tokenDoc.update({ name, displayName: 50 }); // 50 = ALWAYS
        } else {
            // Player can't update tokens directly — ask GM via socket
            game.socket.emit(`module.${MODULE_ID}`, {
                action: "renameToken",
                sceneId,
                tokenId: this.tokenDocument.id,
                name
            });
        }

        // Flag this token so it's only renamed once
        await this._setFlagSafe("nameRevealed", true);

        // Update the name banner in the portrait area (local + broadcast to spectators)
        this._updateNameLabel(name);
        game.socket.emit(`module.${MODULE_ID}`, {
            action:  "updateNpcName",
            actorId: this.actor.id,
            tokenId: this.tokenDocument?.id || null,
            name,
            exclude: game.user.id
        });

        console.log(`ACE: Engine | Token renamed to "${name}"`);
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
        // ── GM closes silently — just switching NPCs ─────────────────────────
        // Raw history is already saved per-exchange via _saveMemorySafe().
        // Journal summary fires automatically when the PLAYER ends the conversation
        // (handled by the gmDismiss socket handler in main.js).

        // ── DOM wipe — clear stale content before closing ────────────────────
        try {
            const log   = this.element?.querySelector?.("#ace-engine-log");
            const input = this.element?.querySelector?.("#ace-engine-input");
            if (log)   log.innerHTML = "";
            if (input) input.value   = "";
        } catch (_) { /* non-critical */ }

        // ── Cleanup ──────────────────────────────────────────────────────────
        if (this._inactivityTimer) clearTimeout(this._inactivityTimer);
        if (this._micSendTimer) { clearTimeout(this._micSendTimer); this._micSendTimer = null; }
        if (this._recognition) { try { this._recognition.stop(); } catch(_) {} this._recognition = null; }
        if (this._sceneChangeHookId != null) { Hooks.off("canvasReady", this._sceneChangeHookId); this._sceneChangeHookId = null; }
        if (this._dialogueStartHookId != null) { Hooks.off("ace-engine.npcDialogueStart", this._dialogueStartHookId); this._dialogueStartHookId = null; }
        if (this._dialogueEndHookId != null)   { Hooks.off("ace-engine.npcDialogueEnd",   this._dialogueEndHookId);   this._dialogueEndHookId   = null; }
        this._lockPlayerToken(false);
        ttsEngine.stop();

        if (!this._gmForced) {
            const isConversationOwner = this._isOwner && !game.user.isGM;

            if (isConversationOwner) {
                const closingPlayerName = this.speakingAs?.name ?? game.user.name;

                game.socket.emit(`module.${MODULE_ID}`, {
                    action:     "gmDismiss",
                    actorId:    this.actor.id,
                    tokenId:    this.tokenDocument?.id || null,
                    source:     "player",
                    playerName: closingPlayerName
                });
                const { unlockNPC, isLockedByMe, openConversations } = window._aceEnvoy ?? {};
                if (unlockNPC && isLockedByMe?.(this.actor.id)) {
                    setTimeout(() => unlockNPC(this.actor.id), 3000);
                }
                openConversations?.delete(this._convoKey);
            } else if (game.user.isGM) {
                const { openConversations } = window._aceEnvoy ?? {};
                openConversations?.delete(this._convoKey);
            } else {
                game.socket.emit(`module.${MODULE_ID}`, {
                    action: "stopAudio", targetUserId: game.user.id
                });
            }
        }

        // Safety net: always clean up stale openConversations reference
        const { openConversations: _oc } = window._aceEnvoy ?? {};
        if (_oc?.get(this._convoKey) === this) _oc.delete(this._convoKey);

        return super.close(options);
    }

    async _setFlagSafe(key, value) {
        // Voice flags are always on the actor (ActorDelta for unlinked tokens).
        // Memory/conversation flags go to the TokenDocument so each unlinked
        // copy has its own conversation history.
        const ACTOR_FLAGS = new Set(["voiceId", "voiceSettings", "voiceAccent", "voiceGender", "voiceMuted",
                                      "personality", "nameRevealed", "bioGenerated"]);
        const useActor = ACTOR_FLAGS.has(key);

        const tokenId = (this.tokenDocument && !this.tokenDocument.actorLink)
                      ? this.tokenDocument.id : null;
        // For unlinked tokens: actor flags → tokenDocument.actor (synthetic), other flags → tokenDocument
        const target = tokenId
            ? (useActor ? (this.tokenDocument.actor || this.actor) : this.tokenDocument)
            : this.actor;

        if (value === null || value === undefined) {
            if (game.user.isGM) {
                return target.unsetFlag(MODULE_ID, key);
            }
            game.socket.emit(`module.${MODULE_ID}`, {
                action: "unsetFlag", actorId: this.actor.id, tokenId: useActor ? null : tokenId, key
            });
            return;
        }
        if (game.user.isGM) {
            return target.setFlag(MODULE_ID, key, value);
        }
        game.socket.emit(`module.${MODULE_ID}`, {
            action: "setFlag", actorId: this.actor.id, tokenId: useActor ? null : tokenId, key, value
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

    _lockPlayerToken(locked) {
        if (game.user.isGM) return;
        // Find the player's owned token on the scene (may differ from game.user.character)
        const token = canvas.tokens?.placeables?.find(t =>
            t.actor?.hasPlayerOwner
            && t.actor.testUserPermission(game.user, "OWNER")
        ) ?? canvas.tokens?.placeables?.find(t => t.document?.actorId === game.user.character?.id);
        if (!token) return;

        if (locked) {
            this._lockedTokenId = token.id;
            token.document.setFlag(MODULE_ID, "conversationLocked", true);
            console.log(`ACE: Engine | Player token movement locked`);
        } else {
            this._lockedTokenId = null;
            // Clear both new and legacy flags
            token.document.unsetFlag(MODULE_ID, "conversationLocked");
            try { token.document.unsetFlag("npclink", "conversationLocked").catch(() => {}); } catch(_) {}
            console.log(`ACE: Engine | Player token movement unlocked`);
        }
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
                const { unlockNPC, isLockedByMe, openConversations } = window._aceEnvoy ?? {};
                if (unlockNPC && isLockedByMe?.(this.actor.id)) {
                    unlockNPC(this.actor.id);
                }
                openConversations?.delete(this._convoKey);
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
