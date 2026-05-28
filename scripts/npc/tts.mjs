// ─── ACE: Engine — NPC TTS Engine (Singleton) ──────────────────────────────
// ElevenLabs + browser-fallback text-to-speech engine for NPC speech.
// Shared AudioContext across all conversation windows.
//
// Moved from ace-envoy/src/elevenlabs/tts.js as part of the Envoy → Engine
// merger. Settings keys translated from ace-envoy.* → ace-engine.* equivalents:
//   elevenLabsModel       → ace-engine.elevenLabsModel
//   narratorVoiceId       → ace-engine.narratorVoiceOverrideId (gated by
//                           narratorVoiceOverrideEnabled), or elevenLabsVoiceId
//   voiceProvider         → ace-engine.voiceProvider (new setting)
// Socket channel renamed: module.ace-envoy → module.ace-engine

const MODULE_ID = "ace-engine";

/** Read the ElevenLabs API key (client-scoped) from engine settings. */
function _getElevenLabsKey() {
    try { return game.settings.get(MODULE_ID, "elevenLabsApiKey") || ""; }
    catch (_) { return ""; }
}

/** Resolve the narrator voice ID — used for atmospheric *emote* segments.
 *  Prefers a custom override, then falls back to the world's configured narrator. */
function _getNarratorVoiceId() {
    try {
        const override = game.settings.get(MODULE_ID, "narratorVoiceOverrideEnabled");
        if (override) {
            const custom = (game.settings.get(MODULE_ID, "narratorVoiceOverrideId") || "").trim();
            if (custom) return custom;
        }
        return (game.settings.get(MODULE_ID, "elevenLabsVoiceId") || "").trim();
    } catch (_) { return ""; }
}

/** Read the ElevenLabs model — defaults to multilingual_v2. */
function _getElevenLabsModel() {
    try { return game.settings.get(MODULE_ID, "elevenLabsModel") || "eleven_multilingual_v2"; }
    catch (_) { return "eleven_multilingual_v2"; }
}

/** Whether the user explicitly chose browser TTS. */
function _userPickedBrowser() {
    try { return game.settings.get(MODULE_ID, "voiceProvider") === "browser"; }
    catch (_) { return false; }
}

/** Is there an active GM session we can proxy ElevenLabs requests to? */
function _gmAvailable() {
    return !!game.users?.some?.(u => u.isGM && u.active);
}

/**
 * Decide which TTS path this client should take.
 *   "local"   — generate via ElevenLabs on this client, broadcast result.
 *   "proxy"   — ask the GM to generate; we play the audio it sends back.
 *   "browser" — fall back to free browser speechSynthesis (robotic).
 *
 * GM proxy is the right answer for any non-GM client without a local
 * key, so the player hears ElevenLabs paid for by the GM's account
 * instead of the OS's built-in voice.
 */
function _ttsMode() {
    if (_userPickedBrowser()) return "browser";
    const hasLocalKey = !!_getElevenLabsKey();
    if (hasLocalKey) return "local";
    if (!game.user.isGM && _gmAvailable()) return "proxy";
    return "browser";
}

class TTSEngine {
    constructor() {
        this.audioContext = null;
        this.isPlaying    = false;
        this.isPaused     = false;
        this._currentSource = null;
        this._currentBuffer = null;   // decoded AudioBuffer (for pause/resume)
        this._currentPitch  = 1.0;    // playbackRate of current clip
        this._startTime     = 0;      // ctx.currentTime when source.start() was called
        this._pauseOffset   = 0;      // seconds into the buffer where we paused
        this._resolvePlay   = null;   // pending playBuffer() promise resolver
        this._safetyTimeout = null;   // safety timeout reference
        this._stopRequested = false;
        this._speakLock     = false;   // prevents overlapping speakResponse calls
        this._unlockAudio();
    }

    _unlockAudio() {
        const unlock = () => {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                console.log("TTS | AudioContext created and unlocked.");
            }
            if (this.audioContext.state === "suspended") {
                this.audioContext.resume();
            }
            document.removeEventListener("click",   unlock);
            document.removeEventListener("keydown", unlock);
        };
        document.addEventListener("click",   unlock);
        document.addEventListener("keydown", unlock);
    }

    stop() {
        if (this._safetyTimeout) { clearTimeout(this._safetyTimeout); this._safetyTimeout = null; }
        if (this._currentSource) {
            try { this._currentSource.stop(); } catch(e) {}
            this._currentSource = null;
        }
        // Stop browser TTS if active
        if (this._browserUtterance) {
            try { window.speechSynthesis?.cancel(); } catch (_) {}
            this._browserUtterance = null;
        }
        this._currentBuffer = null;
        this._pauseOffset   = 0;
        this.isPlaying      = false;
        this.isPaused       = false;
        this._stopRequested = true;
        this._speakLock     = false;
        if (this._resolvePlay) {
            this._resolvePlay();
            this._resolvePlay = null;
        }
        console.log("TTS | Audio stopped.");
    }

    pause() {
        if (this._browserUtterance) {
            try { window.speechSynthesis?.pause(); } catch (_) {}
            this.isPaused  = true;
            this.isPlaying = false;
            console.log("TTS | Browser TTS paused");
            return;
        }
        if (!this._currentSource || !this.isPlaying) return;
        const ctx = this.audioContext;
        this._pauseOffset += (ctx.currentTime - this._startTime) * (this._currentPitch || 1.0);
        if (this._safetyTimeout) { clearTimeout(this._safetyTimeout); this._safetyTimeout = null; }
        try { this._currentSource.stop(); } catch(e) {}
        this._currentSource = null;
        this.isPaused  = true;
        this.isPlaying = false;
        console.log(`TTS | Audio paused at ${this._pauseOffset.toFixed(2)}s`);
    }

    resume() {
        if (this._browserUtterance && this.isPaused) {
            try { window.speechSynthesis?.resume(); } catch (_) {}
            this.isPaused  = false;
            this.isPlaying = true;
            console.log("TTS | Browser TTS resumed");
            return;
        }
        if (!this.isPaused || !this._currentBuffer || !this.audioContext) return;
        const ctx = this.audioContext;
        if (ctx.state === "suspended") ctx.resume();

        const source = ctx.createBufferSource();
        source.buffer = this._currentBuffer;
        source.playbackRate.value = this._currentPitch;
        source.connect(ctx.destination);

        source.onended = () => {
            if (this.isPaused) return;
            if (this._safetyTimeout) { clearTimeout(this._safetyTimeout); this._safetyTimeout = null; }
            this._currentSource = null;
            this._currentBuffer = null;
            this.isPlaying = false;
            this._pauseOffset = 0;
            if (this._resolvePlay) {
                this._resolvePlay();
                this._resolvePlay = null;
            }
        };

        source.start(0, this._pauseOffset);
        this._currentSource = source;
        this._startTime = ctx.currentTime;
        this.isPaused  = false;
        this.isPlaying = true;

        const remaining = (this._currentBuffer.duration - this._pauseOffset) / (this._currentPitch || 1.0);
        this._safetyTimeout = setTimeout(() => {
            if (this._currentSource === source) {
                this._currentSource = null;
                this._currentBuffer = null;
                this.isPlaying = false;
                if (this._resolvePlay) {
                    this._resolvePlay();
                    this._resolvePlay = null;
                }
            }
        }, Math.ceil((remaining + 1) * 1000));

        console.log(`TTS | Audio resumed from ${this._pauseOffset.toFixed(2)}s`);
    }

    /**
     * Normalize an AudioBuffer so all voices play at a consistent volume.
     * Peak normalization — finds the loudest sample and scales so the peak
     * hits the target level. Prevents quiet voices from being inaudible
     * and loud voices from blasting.
     */
    _normalizeVolume(audioBuffer, targetPeak = 0.8) {
        let maxSample = 0;
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
            const data = audioBuffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
                const abs = Math.abs(data[i]);
                if (abs > maxSample) maxSample = abs;
            }
        }
        if (maxSample < 0.001 || Math.abs(maxSample - targetPeak) < 0.05) return;
        const scale = targetPeak / maxSample;
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
            const data = audioBuffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
                data[i] *= scale;
            }
        }
        console.log(`TTS | Volume normalized: peak ${maxSample.toFixed(3)} → ${targetPeak} (scale ${scale.toFixed(2)}x)`);
    }

    /**
     * @param {ArrayBuffer} arrayBuffer  Raw audio data
     * @param {number}      pitch        playbackRate (0.7 = deep, 1.0 = normal, 1.2 = high)
     * @param {number}      maxDuration  Max seconds to play (0 = full clip). Clips longer
     *                                   than this fade out in the last 300ms and stop.
     */
    async playBuffer(arrayBuffer, pitch = 1.0, maxDuration = 0) {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === "suspended") {
            await this.audioContext.resume();
        }
        const ctx = this.audioContext;
        const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));

        this._normalizeVolume(decoded);

        this._currentBuffer = decoded;
        this._currentPitch  = pitch;
        this._pauseOffset   = 0;
        this._startTime     = ctx.currentTime;

        const realDuration = decoded.duration / (pitch || 1.0);
        const needsCap = maxDuration > 0 && realDuration > maxDuration;

        return new Promise((resolve) => {
            this._resolvePlay = resolve;

            const source = ctx.createBufferSource();
            source.buffer = decoded;
            source.playbackRate.value = pitch;

            if (needsCap) {
                const gain = ctx.createGain();
                source.connect(gain);
                gain.connect(ctx.destination);

                const fadeStart = Math.max(0, maxDuration - 0.3);
                gain.gain.setValueAtTime(1.0, ctx.currentTime + fadeStart);
                gain.gain.linearRampToValueAtTime(0.0, ctx.currentTime + maxDuration);
            } else {
                source.connect(ctx.destination);
            }

            // Web Audio API requires start() BEFORE stop() — calling stop on
            // a source that hasn't started throws InvalidStateError. The
            // capped-duration stop schedule moves here, after start, so the
            // node is valid by the time stop is scheduled.
            source.start(0);
            if (needsCap) {
                source.stop(ctx.currentTime + maxDuration + 0.05);
            }
            this._currentSource = source;
            this.isPlaying = true;

            const expectedDuration = needsCap ? maxDuration : realDuration;
            const safetyMs = Math.ceil((expectedDuration + 1) * 1000);
            this._safetyTimeout = setTimeout(() => {
                if (this._currentSource === source) {
                    console.warn("TTS | playBuffer safety timeout fired — resolving.");
                    this._currentSource = null;
                    this._currentBuffer = null;
                    this.isPlaying = false;
                }
                this._resolvePlay = null;
                resolve();
            }, safetyMs);

            source.onended = () => {
                if (this.isPaused) return;
                if (this._safetyTimeout) { clearTimeout(this._safetyTimeout); this._safetyTimeout = null; }
                this._currentSource = null;
                this._currentBuffer = null;
                this.isPlaying = false;
                this._resolvePlay = null;
                resolve();
            };
        });
    }

    async _fetch(text, voiceId, voiceSettings = {}) {
        const apiKey = _getElevenLabsKey();
        if (!apiKey) return { status: "nokey" };
        if (!voiceId) return { status: "novoice" };

        const response = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            {
                method: "POST",
                headers: {
                    "xi-api-key":   apiKey,
                    "Content-Type": "application/json",
                    "Accept":       "audio/mpeg"
                },
                body: JSON.stringify({
                    text,
                    model_id: _getElevenLabsModel(),
                    voice_settings: (() => {
                        const merged = { stability: 0.5, similarity_boost: 0.8, ...voiceSettings };
                        const modelId = _getElevenLabsModel();
                        if (modelId === "eleven_v3") {
                            // v3 clamps stability to 0/0.5/1
                            merged.stability = merged.stability <= 0.25 ? 0.0 : merged.stability >= 0.75 ? 1.0 : 0.5;
                        }
                        return merged;
                    })()
                }),
                signal: AbortSignal.timeout(30_000)
            }
        );
        if (response.status === 404) return { status: "invalid" };
        if (!response.ok) {
            const err = await response.text();
            console.error("TTS | ElevenLabs error:", response.status, err);
            return { status: "error" };
        }
        const arrayBuffer = await response.arrayBuffer();
        return { status: "ok", arrayBuffer };
    }

    /**
     * Speak text using browser's built-in speechSynthesis API.
     * Used as fallback when ElevenLabs is unavailable or voiceProvider is "browser".
     */
    _speakBrowser(text, pitch = 1.0, { broadcast = true } = {}) {
        return new Promise((resolve) => {
            if (!window.speechSynthesis) { resolve(); return; }

            window.speechSynthesis.cancel();

            const utter = new SpeechSynthesisUtterance(text);
            utter.rate  = Math.max(0.5, Math.min(pitch, 2.0));
            utter.pitch = 1.0;

            const voices = window.speechSynthesis.getVoices();
            const preferred = ["Microsoft David", "Daniel", "Google UK English Male",
                               "Google US English", "Microsoft Mark", "Microsoft Zira"];
            let picked = voices.find(v => preferred.some(p => v.name.includes(p)));
            if (!picked) picked = voices.find(v => v.lang.startsWith("en"));
            if (picked) utter.voice = picked;

            utter.onend   = () => resolve();
            utter.onerror = () => resolve();

            if (broadcast) {
                try {
                    game.socket.emit(`module.${MODULE_ID}`, {
                        action: "browserTTS",
                        text,
                        pitch,
                        exclude: game.user.id
                    });
                } catch (_) {}
            }

            this.isPlaying = true;
            this._browserUtterance = utter;
            window.speechSynthesis.speak(utter);

            const maxMs = Math.max(text.length * 100, 10000);
            setTimeout(() => { this.isPlaying = false; resolve(); }, maxMs);
        }).then(() => { this.isPlaying = false; this._browserUtterance = null; });
    }

    async speak(text, voiceId, voiceSettings = {}, pitch = 1.0) {
        if (!text?.trim()) return "empty";

        const mode = _ttsMode();

        if (mode === "browser") {
            if (!this._browserTTSNotified) {
                this._browserTTSNotified = true;
                console.log("TTS | Using free browser voices. Add an ElevenLabs key in module settings for premium AI voices.");
                if (game.user?.isGM) {
                    ui.notifications?.info("ACE Engine is using free browser voices. Add an ElevenLabs API key in settings for premium AI voices.", { permanent: false });
                }
            }
            await this._speakBrowser(text, pitch);
            return "ok";
        }

        if (mode === "proxy") {
            const r = await this._speakViaGm(text, voiceId, voiceSettings, pitch);
            if (r === "ok") return "ok";
            // Proxy failed (GM offline mid-request, key invalid, network) —
            // fall back to browser so the player still hears something.
            console.warn(`TTS | GM proxy returned "${r}" — falling back to browser TTS.`);
            await this._speakBrowser(text, pitch);
            return "ok";
        }

        // mode === "local" — generate on this client and broadcast.
        const result = await this._fetch(text, voiceId, voiceSettings);
        if (result.status !== "ok") {
            console.warn(`TTS | speak() got status "${result.status}" for voice ${voiceId} — falling back to browser TTS`);
            await this._speakBrowser(text, pitch);
            return "ok";
        }

        // Broadcast audio + pitch to other clients
        try {
            const uint8 = new Uint8Array(result.arrayBuffer);
            const CHUNK = 8192;
            const parts = [];
            for (let i = 0; i < uint8.length; i += CHUNK) {
                parts.push(String.fromCharCode(...uint8.subarray(i, i + CHUNK)));
            }
            const base64 = btoa(parts.join(""));
            game.socket.emit(`module.${MODULE_ID}`, {
                action:  "playAudio",
                base64,
                pitch,
                exclude: game.user.id
            });
        } catch(e) {
            console.warn("TTS | Socket broadcast failed (non-fatal):", e);
        }

        await this.playBuffer(result.arrayBuffer.slice(0), pitch);
        return "ok";
    }

    /**
     * Ask the GM client to generate ElevenLabs audio with their API key.
     *
     * Flow:
     *   1. Emit ttsRequest with our user id + requestId.
     *   2. GM handler in ace-engine.mjs fetches ElevenLabs, broadcasts a
     *      `playAudio` event to OTHER clients (so spectators hear it too)
     *      and replies to us with `ttsResponse` carrying the base64 audio.
     *   3. We decode and play locally, awaiting playBuffer so the speak
     *      pipeline's segment loop only advances when audio actually ends.
     *
     * If the GM doesn't respond inside 30 s, or returns an error, resolves
     * with a non-"ok" status so the caller can fall back to browser TTS.
     */
    _speakViaGm(text, voiceId, voiceSettings = {}, pitch = 1.0) {
        return new Promise((resolve) => {
            const requestId = foundry.utils.randomID();
            let settled = false;
            const finish = (status) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                game.socket.off(`module.${MODULE_ID}`, handler);
                resolve(status);
            };
            const timeout = setTimeout(() => {
                console.warn(`TTS | _speakViaGm: GM did not respond within 30s (req ${requestId.slice(0, 6)}).`);
                finish("error");
            }, 30000);
            const handler = async (msg) => {
                if (!msg || msg.action !== "ttsResponse" || msg.requestId !== requestId) return;
                if (msg.error) {
                    console.warn(`TTS | _speakViaGm: GM returned error: ${msg.error}`);
                    finish("error");
                    return;
                }
                if (!msg.base64) {
                    console.warn(`TTS | _speakViaGm: GM ack without audio payload.`);
                    finish("error");
                    return;
                }
                try {
                    const binary = atob(msg.base64);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    await this.playBuffer(bytes.buffer, msg.pitch ?? pitch);
                    finish("ok");
                } catch (err) {
                    console.warn(`TTS | _speakViaGm: playback failed:`, err);
                    finish("error");
                }
            };
            game.socket.on(`module.${MODULE_ID}`, handler);
            game.socket.emit(`module.${MODULE_ID}`, {
                action:  "ttsRequest",
                requestId,
                userId:  game.user.id,
                text,
                voiceId,
                voiceSettings,
                pitch
            });
        });
    }

    /**
     * Speaks an NPC's full response, handling dialogue vs *emote* segments.
     * @param {string}      fullText              Raw AI response text
     * @param {string}      npcVoiceId            ElevenLabs voice ID for the NPC
     * @param {string}      actorName             Display name (for emote narration)
     * @param {string|null} creatureSoundFolder   When set, sound emotes play audio
     *                                            clips and onomatopoeia is stripped.
     */
    async speakResponse(fullText, npcVoiceId, actorName, creatureSoundFolder = null, voicePitch = 1.0, npcVoiceSettings = {}) {
        if (this._speakLock) {
            console.warn("TTS | speakResponse blocked — already speaking. Call stop() first.");
            return;
        }
        this._speakLock = true;

        let _csIsSoundEmote, _csStripSoundEffects, _csPlayCreatureSound;
        if (creatureSoundFolder) {
            try {
                const cs = await import("./creature-sounds.mjs");
                _csIsSoundEmote      = cs.isSoundEmote;
                _csStripSoundEffects = cs.stripSoundEffects;
                _csPlayCreatureSound = cs.playCreatureSound;
            } catch (e) {
                console.warn("TTS | Could not load creature-sounds module:", e);
                creatureSoundFolder = null;
            }
        }

        try {
            const NARRATOR_VOICE_ID = _getNarratorVoiceId() || "j9jfwdrw7BRfcR43Qohk";
            console.log("TTS | Narrator voice:", NARRATOR_VOICE_ID, "NPC voice:", npcVoiceId,
                        creatureSoundFolder ? `| Creature sounds: ${creatureSoundFolder}` : "");
            this._stopRequested = false;

            // Parse segments: dialogue vs *emotes*
            const segments = [];
            const regex = /\*(.*?)\*/g;
            let lastIndex = 0, match;
            while ((match = regex.exec(fullText)) !== null) {
                if (match.index > lastIndex)
                    segments.push({ type: "dialogue", text: fullText.slice(lastIndex, match.index).trim() });
                segments.push({ type: "emote", text: match[1].trim() });
                lastIndex = regex.lastIndex;
            }
            if (lastIndex < fullText.length) {
                const tail = fullText.slice(lastIndex).trim();
                if (tail) segments.push({ type: "dialogue", text: tail });
            }

            console.log(`TTS | ${segments.length} segment(s) to speak:`, segments.map(s => `[${s.type}] "${s.text.slice(0, 40)}…"`));

            // Play each segment
            for (const seg of segments) {
                if (!seg.text || this._stopRequested) break;

                try {
                    if (seg.type === "dialogue") {
                        let dialogueText = seg.text;

                        if (creatureSoundFolder && _csStripSoundEffects) {
                            const { cleaned, hadSounds } = _csStripSoundEffects(dialogueText);
                            if (hadSounds) {
                                console.log(`TTS | Stripped sound words: "${dialogueText}" → "${cleaned}"`);
                                await _csPlayCreatureSound(creatureSoundFolder, voicePitch);
                                if (this._stopRequested) break;
                            }
                            dialogueText = cleaned;
                        }

                        if (dialogueText) {
                            // Fire dialogue-start hook so listeners (e.g. ConversationApp's
                            // animated WebP portrait) can sync to the spoken segment only,
                            // not the narrator-voiced *emote* segments.
                            try { Hooks.callAll("ace-engine.npcDialogueStart", { actorName }); } catch (_) {}

                            const r = await this.speak(dialogueText, npcVoiceId, npcVoiceSettings, voicePitch);

                            try { Hooks.callAll("ace-engine.npcDialogueEnd", { actorName }); } catch (_) {}

                            if (r === "invalid") return "invalid";
                            if (r !== "ok" && r !== "empty") {
                                console.warn(`TTS | Dialogue segment failed (${r}) — skipping.`);
                            }
                        }
                    } else {
                        if (creatureSoundFolder && _csIsSoundEmote && _csIsSoundEmote(seg.text)) {
                            console.log(`TTS | Sound emote → creature clip: "${seg.text}"`);
                            await _csPlayCreatureSound(creatureSoundFolder, voicePitch);
                            continue;
                        }

                        const isAction = /^I['\s,]/i.test(seg.text);
                        const creatureName = actorName || "The creature";
                        let spokenText = seg.text;

                        if (isAction) {
                            spokenText = seg.text
                                .replace(/^I'm\b/i,     `${creatureName} is`)
                                .replace(/^I've\b/i,     `${creatureName} has`)
                                .replace(/^I'll\b/i,     `${creatureName} will`)
                                .replace(/^I'd\b/i,      `${creatureName} would`)
                                .replace(/^I\b/i,        `The ${creatureName}`)
                                .replace(/\bmy\b/gi,     "their")
                                .replace(/\bmyself\b/gi, "themselves")
                                .replace(/\bme\b/gi,     "them")
                                .replace(/\bI'm\b/g,     "they're")
                                .replace(/\bI've\b/g,    "they've")
                                .replace(/\bI'll\b/g,    "they'll")
                                .replace(/\bI'd\b/g,     "they'd")
                                .replace(/\bI\b/g,       "they");
                            spokenText = spokenText.replace(
                                new RegExp(`^The ${creatureName} ([a-z]+)\\b`),
                                (m, verb) => `The ${creatureName} ${verb}s`
                            );
                            console.log(`TTS | Action emote → "${spokenText}"`);
                        } else {
                            console.log("TTS | Atmospheric → narrator voice");
                        }
                        const r = await this.speak(spokenText, NARRATOR_VOICE_ID, { stability: 0.75, similarity_boost: 0.6 });
                        if (r !== "ok" && r !== "empty") {
                            console.warn(`TTS | Emote segment failed (${r}) — skipping.`);
                        }
                    }
                } catch(segErr) {
                    console.error(`TTS | Segment error (continuing):`, segErr);
                }
            }
        } finally {
            this._speakLock = false;
            // Safety: ensure dialogueEnd fires even if TTS was interrupted (stop button,
            // segment error, etc.) so the animated portrait doesn't get stuck "speaking".
            try { Hooks.callAll("ace-engine.npcDialogueEnd", { actorName }); } catch (_) {}
        }
    }
}

// Singleton export
export const ttsEngine = new TTSEngine();
