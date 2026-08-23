// ─── ACE: Engine — GM Puppet Window ─────────────────────────────────────────
// Lets the GM speak THROUGH an NPC without going through the AI chat pipeline.
// Compact tool: portrait, name, dictation log, mic + send.
//
// The GM types or dictates a line; the NPC's ElevenLabs voice plays for every
// connected client; a chat card is posted to the Foundry sidebar; the window
// stays open for the next line. Unlike ConversationApp, this never:
//   - calls the AI for replies
//   - broadcasts conversationMessage (so it doesn't pop spectator windows
//     on player clients and step on their active conversations)
//   - writes to the NPC's memoryLog flag (this is GM-direction, not real
//     NPC memory)
//   - takes a conversation lock
//
// Result: GM can be Lord Soth on one window and Ezmerelda on another while
// Greenbeard stays mid-chat with Barovich, undisturbed.

import { ttsEngine }                                 from "./tts.mjs";
import { getVoiceConfig, getDynamicVoiceSettings }   from "./voice-engine.mjs";
import { getCreatureSoundFolder, getVoicePitch }     from "./creature-sounds.mjs";
import { npcChatState }                              from "./activate.mjs";

const MODULE_ID = "ace-engine";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function escapeHtml(s) {
    return String(s ?? "")
        .replace(/&/g,  "&amp;")
        .replace(/</g,  "&lt;")
        .replace(/>/g,  "&gt;")
        .replace(/"/g,  "&quot;");
}

export class GmPuppetApp extends HandlebarsApplicationMixin(ApplicationV2) {

    constructor(actor, { tokenDocument = null } = {}) {
        // Generate the unique id BEFORE calling super() and pass it through
        // options. ApplicationV2 stores this in this.options.id during its
        // own constructor — that's the value used as the DOM element id
        // and as the key in the global windows registry. A static
        // DEFAULT_OPTIONS.id or a `get id()` override both arrive too late;
        // by the time they're consulted the parent has already booked the
        // instance under whatever was passed (or the static fallback) and
        // every new instance with the same key replaces the previous one.
        const uniqueId = `ace-engine-puppet-${foundry.utils.randomID()}`;
        super({ id: uniqueId });

        this.actor = actor;
        this.tokenDocument = tokenDocument;
        this._messageLog = [];
        this._puppetKey = (tokenDocument && !tokenDocument.actorLink)
                        ? `tok:${tokenDocument.id}`
                        : actor.id;

        // Voice — read from the effective actor (unlinked tokens use the
        // ActorDelta-merged synthetic actor so per-token voice overrides
        // apply correctly).
        const effectiveActor = (tokenDocument && !tokenDocument.actorLink && tokenDocument.actor)
                             ? tokenDocument.actor : actor;
        this._voiceId       = effectiveActor.getFlag(MODULE_ID, "voiceId")
                           || actor.flags?.npclink?.voiceId || null;
        this._voiceSettings = effectiveActor.getFlag(MODULE_ID, "voiceSettings") || {};
    }

    /** Display name — prefer token name (e.g. "Grimfang") over base actor name (e.g. "Otyugh"). */
    get npcName() {
        return this.tokenDocument?.name || this.actor.name;
    }

    // No static `id` here — each instance generates its own unique id in
    // the constructor and passes it via super({ id }). Including a static
    // here would just be a fallback for someone forgetting to override,
    // which would collide all instances under the same key.
    static DEFAULT_OPTIONS = {
        classes: [MODULE_ID, "gm-puppet"],
        window: { title: "Speak as NPC", resizable: true, minimizable: true },
        position: { width: 440, height: 520 },
        actions: {
            puppetToggleMinimize: function(_e, _t) {
                try {
                    if (this.minimized) this.maximize();
                    else this.minimize();
                } catch (err) {
                    console.warn("ACE: Engine | GM puppet minimize toggle failed:", err);
                }
            },
        },
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/gm-puppet-app.html` }
    };

    _shouldRender(options) {
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

    /** Best portrait — actor img → token texture → prototype texture → mystery-man fallback. */
    _getPortraitImage() {
        const FALLBACK = "icons/svg/mystery-man.svg";
        const isMystery = (img) => !img || img.includes("mystery-man");
        if (!isMystery(this.actor.img)) return this.actor.img;
        const tokenTex = this.tokenDocument?.texture?.src;
        if (!isMystery(tokenTex)) return tokenTex;
        const protoTex = this.actor.prototypeToken?.texture?.src;
        if (!isMystery(protoTex)) return protoTex;
        return FALLBACK;
    }

    async _prepareContext() {
        return {
            actorName: this.npcName,
            actorImg:  this._getPortraitImage(),
        };
    }

    _onRender(context, options) {
        const el = this.element;

        const isReRender = this._listenersAttached;

        this._inputField   = el.querySelector("#gm-puppet-input");
        this._sendBtn      = el.querySelector("#gm-puppet-send");
        this._micBtn       = el.querySelector("#gm-puppet-voice");
        this._stopBtn      = el.querySelector("#gm-puppet-stop");
        this._logContainer = el.querySelector("#gm-puppet-log");
        this._nameLabel    = el.querySelector("#gm-puppet-name");

        // Replay prior lines after a re-render (e.g. minimize → restore)
        if (this._logContainer && this._messageLog?.length) {
            for (const text of this._messageLog) {
                const div = document.createElement("div");
                div.className = "gm-puppet-line";
                div.innerHTML = `<div class="gm-puppet-bubble">${escapeHtml(text)}</div>`;
                this._logContainer.appendChild(div);
            }
            requestAnimationFrame(() => { this._logContainer.scrollTop = this._logContainer.scrollHeight; });
        }

        // ── Inject manual header controls (minimize + close) ──────────
        // Foundry V13 ApplicationV2 doesn't always render its built-in
        // chrome controls when classes are passed via DEFAULT_OPTIONS, so
        // we manually inject both buttons. Same defensive pattern used
        // by ConversationApp for the same reason.
        const header = el.querySelector(".window-header, header");
        if (header) {
            const hasNativeClose = !!header.querySelector(
                "button.close, button[data-action='close'], button[data-tooltip='Close'], .header-control[data-action='close']"
            );

            // Minimize button
            if (!header.querySelector(".gm-puppet-btn-minimize")) {
                const minBtn = document.createElement("button");
                minBtn.className = "header-control gm-puppet-btn-minimize";
                minBtn.type      = "button";
                minBtn.title     = "Minimize";
                minBtn.innerHTML = '<i class="fas fa-minus"></i>';
                minBtn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    try { if (this.minimized) this.maximize(); else this.minimize(); }
                    catch (err) { console.warn("ACE: Engine | GM puppet minimize toggle failed:", err); }
                });
                header.appendChild(minBtn);
            }

            // Close button (only if V13 didn't render its own)
            if (!hasNativeClose && !header.querySelector(".gm-puppet-btn-close")) {
                const closeBtn = document.createElement("button");
                closeBtn.className = "header-control gm-puppet-btn-close";
                closeBtn.type      = "button";
                closeBtn.title     = "Close";
                closeBtn.innerHTML = '<i class="fas fa-xmark"></i>';
                closeBtn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    this.close().catch(err => {
                        console.error(`${MODULE_ID} | GM puppet close failed:`, err);
                        try { this.element?.remove(); } catch (_) {}
                    });
                });
                header.appendChild(closeBtn);
            }
        }

        if (isReRender) return;
        this._listenersAttached = true;

        this._sendBtn?.addEventListener("click", () => this.handleSend());
        this._micBtn?.addEventListener("click",  () => this.handleMic());
        // Stop button kills audio EVERYWHERE — locally + broadcast to all
        // other clients so the NPC's voice doesn't keep playing for the
        // players when the GM hits stop. Server-side receiver lives in
        // ace-engine.mjs and routes through _stopAllAudio().
        this._stopBtn?.addEventListener("click", () => {
            try { ttsEngine.stop(); } catch (_) {}
            this._setInputLocked(false);
            try {
                game.socket.emit(`module.${MODULE_ID}`, {
                    type: "stop-audio",
                    userId: game.user.id,
                });
            } catch (_) {}
        });

        // Enter sends, Shift+Enter newline. stopPropagation on every key event
        // so Foundry's global keybindings (delete token, etc.) never fire from
        // inside the textarea — same defense pattern used in ConversationApp.
        this._inputField?.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                this.handleSend();
            }
        });
        this._inputField?.addEventListener("keyup",   (e) => e.stopPropagation());
        this._inputField?.addEventListener("keypress",(e) => e.stopPropagation());

        this._inputField?.focus();
    }

    async handleSend() {
        const text = this._inputField?.value?.trim();
        if (!text) return;

        // ── Hard-stop the mic FIRST. ──────────────────────────────────
        // continuous=true recognition keeps listening through pauses. If
        // we left it on while TTS played, the mic would pick up the NPC's
        // own voice through the speakers and re-transcribe garbled bits
        // back into the input — creating a feedback loop. Killing the
        // recognition + its handlers right at send eliminates this.
        this._hardStopMic();

        if (ttsEngine.isPlaying) ttsEngine.stop();
        this._inputField.value = "";

        this._appendToLog(text);

        // Strip *emotes* for the chat card text (TTS uses the narrator voice
        // for emotes; the card should show just the spoken dialogue).
        const dialogueOnly = text.replace(/\*(.*?)\*/g, "").replace(/\s{2,}/g, " ").trim();
        if (dialogueOnly) {
            try {
                ChatMessage.create({
                    speaker: {
                        alias: this.actor.name,
                        actor: this.actor.id,
                        token: this.tokenDocument?.id || null,
                        scene: canvas.scene?.id || null,
                    },
                    content: `<p>${escapeHtml(dialogueOnly)}</p>`,
                    flags:   { [MODULE_ID]: { isGmPuppet: true } },
                });
            } catch (err) {
                console.warn("ACE: Engine | GM puppet chat card post failed:", err);
            }
        }

        // Lazy voice resolution — if none cached, pick one and persist
        try {
            if (!this._voiceId) {
                const config = await getVoiceConfig(this.actor, this.tokenDocument);
                this._voiceId       = config.voiceId;
                this._voiceSettings = config.voiceSettings || {};
            }
            const soundFolder = getCreatureSoundFolder(this.actor);
            const voicePitch  = getVoicePitch(this.actor);
            const liveSettings = getDynamicVoiceSettings(this.actor, this._voiceSettings);

            this._setInputLocked(true);
            const result = await ttsEngine.speakResponse(
                text, this._voiceId, this.actor.name,
                soundFolder, voicePitch, liveSettings
            );
            this._setInputLocked(false);

            if (result === "invalid") {
                console.warn(`ACE: Engine | GM puppet: voice "${this._voiceId}" invalid, refetching`);
                try { await this.actor.unsetFlag(MODULE_ID, "voiceId"); } catch (_) {}
                const config = await getVoiceConfig(this.actor, this.tokenDocument);
                this._voiceId       = config.voiceId;
                this._voiceSettings = config.voiceSettings || {};
                this._setInputLocked(true);
                await ttsEngine.speakResponse(
                    text, this._voiceId, this.actor.name,
                    soundFolder, voicePitch, liveSettings
                );
                this._setInputLocked(false);
            }
        } catch (err) {
            console.error("ACE: Engine | GM puppet TTS failed:", err);
            this._setInputLocked(false);
            ui.notifications.error("Voice generation failed — see console.");
        }
    }

    /**
     * Toggle dictation for the line you are about to speak AS the NPC.
     *
     * ⚠️🔴 WHY THIS WAS REWRITTEN (2026-08-21). Johnny, from the GM's chair:
     * "I push the speak button. The level bar is going. It's on the right
     * microphone, but it's not typing anything."
     *
     * The old version had three ways to die in silence, and it took all three:
     *
     *  1. CHROME ENDS A CONTINUOUS SESSION BY ITSELF, after a pause or a few
     *     seconds of quiet. The old onend simply nulled the recogniser and
     *     un-highlighted the button. Dictation was over and nothing said so,
     *     so the button looked live right up until you noticed the box was
     *     still empty. There was no restart, and that alone is enough to make
     *     a perfectly good microphone type nothing.
     *  2. onerror wrote one console.warn and cleared the button. A denied
     *     permission, a missing device and a network failure all looked
     *     exactly like success from the outside.
     *  3. Nothing ever noticed the case that matters most: recognition ran to
     *     completion and returned NOT ONE WORD while the microphone was
     *     plainly live. That is another program holding the device
     *     exclusively, and on a machine with streaming software on it that is
     *     the usual cause.
     *
     * ⚠️ THIS IS NOT THE PLAYER CONVERSATION WINDOW'S DICTATION AND MUST NOT
     * BECOME IT. That one auto-sends after a pause, because a player is
     * talking TO an NPC and the pause ends their turn. Here the GM is
     * composing the NPC's own line and sends it deliberately, so nothing in
     * this method ever sends for you.
     */
    handleMic() {
        if (this._recognition) { this._hardStopMic(); return; }

        // Don't start the mic while audio is playing, or it picks up the NPC's
        // own speech and feeds it straight back into the input.
        if (ttsEngine.isPlaying) {
            ui.notifications?.info("Wait for audio to finish before dictating.");
            return;
        }

        // Focus FIRST and synchronously, before any check that can bail out.
        // If the microphone then fails, the caret is already in the box and you
        // can type the line instead of staring at a dead window.
        this._inputField?.focus();

        const RecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!RecognitionClass) {
            ui.notifications.warn("This browser has no speech recognition. Chrome and Edge support it; Firefox does not. You can still type the line.", { permanent: true });
            return;
        }

        // The API OBJECT exists on plain http:// and simply never works there.
        if (window.isSecureContext === false) {
            ui.notifications.error(
                "Voice input needs a secure connection. This page is served over plain http://, and browsers only allow the microphone on https:// or localhost. Typing still works.",
                { permanent: true });
            return;
        }

        const r = new RecognitionClass();
        r.continuous      = true;
        r.interimResults  = true;
        r.lang            = "en-US";
        r.maxAlternatives = 1;

        // ⚠️ ADDITIVE. Seeding from the live box means dictation continues what
        // is already there, instead of the first syllable wiping a line you had
        // half typed by hand.
        const carry = (this._inputField?.value ?? "").trim();
        this._micFinalText = carry ? carry + " " : "";
        this._micWanted    = true;    // false only when YOU stop it
        this._micHeard     = false;   // has a single word ever arrived?
        this._micRestarts  = 0;
        this._micToldDeaf  = false;

        r.onresult = (event) => {
            // Drop late events from a session already torn down, and never
            // write while the input is locked for playback.
            if (this._recognition !== r || this._inputField?.disabled) return;
            this._micHeard    = true;
            this._micRestarts = 0;

            // event.results covers only THIS session and resets on every
            // restart cycle, so finalised words must be banked or a restart
            // erases the sentence mid-flow.
            let justFinal = "", interim = "";
            for (let i = 0; i < event.results.length; i++) {
                const res = event.results[i];
                if (res.isFinal) justFinal += res[0].transcript + " ";
                else             interim   += res[0].transcript;
            }
            this._micFinalText += justFinal;
            if (this._inputField) {
                this._inputField.value = (this._micFinalText + interim).replace(/\s+/g, " ").trimStart();
                this._inputField.dispatchEvent(new Event("input"));
            }
        };

        r.onerror = (e) => {
            if (this._recognition !== r) return;
            const code = e?.error ?? "unknown";
            // "no-speech" and "aborted" are ordinary punctuation in a dictation
            // session; onend restarts after them. Everything else is real, and
            // gets said out loud rather than written to a console nobody reads.
            if (code === "no-speech" || code === "aborted") return;
            console.warn(`ACE: Engine | GM puppet mic error: ${code}`, e);
            ui.notifications.error(
                code === "not-allowed"
                    ? "Microphone permission was denied. Click the padlock in the address bar, then Site settings, then allow Microphone, and reload."
                : code === "audio-capture"
                    ? "No microphone was available. Check it is plugged in and not being held by another program."
                : code === "network"
                    ? "Speech recognition needs the internet and could not reach the service."
                : `Speech recognition stopped: ${code}. You can still type the line.`,
                { permanent: true });
            this._hardStopMic();
        };

        r.onend = () => {
            if (this._recognition !== r) return;   // torn down deliberately

            // ⚠️ THE FIX. Chrome ends a continuous session on its own, and this
            // is exactly where dictation used to die without a word. If you
            // have not pressed stop, start it again.
            if (this._micWanted && this._micRestarts < 20) {
                this._micRestarts++;
                try { r.start(); return; }
                catch (_) { /* fall through to the honest stop below */ }
            }

            // It ran, it ended, and it never produced a single word while we
            // held the microphone open. Say what that actually means.
            if (this._micWanted && !this._micHeard && !this._micToldDeaf) {
                this._micToldDeaf = true;
                ui.notifications.error(
                    "Your microphone is live but the browser's speech recogniser got no audio from it. That is " +
                    "almost always another program holding the microphone exclusively: a dictation tool " +
                    "(Wispr Flow, Dragon), a meeting app, or a virtual device like Wave Link, Voicemeeter, OBS " +
                    "or NVIDIA Broadcast. Close it, or pick the plain hardware microphone in Windows sound " +
                    "settings. Typing always works.",
                    { permanent: true });
                console.error("ACE: Engine | GM puppet mic: session ended having produced no results.");
            }

            this._recognition = null;
            this._micWanted   = false;
            this._micBtn?.classList.remove("active");
            this._inputField?.focus();
        };

        try {
            r.start();
            this._recognition = r;
            this._micBtn?.classList.add("active");
        } catch (err) {
            console.warn("ACE: Engine | GM puppet mic start failed:", err);
            this._micWanted = false;
            ui.notifications.error("Could not start speech recognition. You can still type the line.", { permanent: true });
        }
    }

    /**
     * Cleanly tear down speech recognition. Detach the handlers BEFORE
     * stopping so an in-flight result or end event is dropped, and clear
     * _micWanted first so onend does not helpfully restart the very thing you
     * just switched off.
     */
    _hardStopMic() {
        this._micWanted = false;
        if (!this._recognition) return;
        const r = this._recognition;
        try { r.onresult = null; r.onerror = null; r.onend = null; } catch (_) {}
        try { r.stop(); } catch (_) {}
        this._recognition = null;
        this._micBtn?.classList.remove("active");
    }

    _setInputLocked(locked) {
        if (this._inputField) this._inputField.disabled = locked;
        if (this._sendBtn)    this._sendBtn.disabled    = locked;
        if (this._micBtn)     this._micBtn.disabled     = locked;
    }

    _appendToLog(text) {
        this._messageLog.push(text);
        if (!this._logContainer) return;
        const div = document.createElement("div");
        div.className = "gm-puppet-line";
        div.innerHTML = `<div class="gm-puppet-bubble">${escapeHtml(text)}</div>`;
        this._logContainer.appendChild(div);
        requestAnimationFrame(() => { this._logContainer.scrollTop = this._logContainer.scrollHeight; });
    }

    async close(options = {}) {
        this._hardStopMic();
        try { ttsEngine.stop(); } catch (_) {}

        const map = npcChatState?.gmPuppets;
        if (map?.get?.(this._puppetKey) === this) map.delete(this._puppetKey);

        return super.close(options);
    }
}
