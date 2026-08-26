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

import { getSharedElevenLabsKey } from "./shared-credentials.mjs";

/** The EFFECTIVE ElevenLabs key. All precedence logic (file over setting,
 *  read live so a mid-session paste takes effect) lives in the one shared
 *  accessor — this is just a local alias so call sites stay readable. */
function _getElevenLabsKey() {
    return getSharedElevenLabsKey();
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

// ─── 🤖🔴 THE ROBOT VOICE IS NOT A FALLBACK ──────────────────────────────
// Johnny, 2026-08-21: "I don't ever want to hear the robotic voice."
//
// He is right, and it is not only a taste call. Every one of these fallbacks
// turned a FAILURE into a PERFORMANCE: ElevenLabs refused, and instead of
// saying so we played Windows speech synthesis and wrote a line to a console
// nobody has open. The table hears a robot, the GM has no idea why, and the
// actual cause - a voice id that is not on the account, a key without the
// text-to-speech permission, a model the plan does not include - never
// reaches a human. It cost a two-hour hunt in July and it cost this morning.
//
// So: if the GM chose the browser voice, it plays, because that is what they
// asked for. If they chose ElevenLabs, ElevenLabs is what they get or they get
// SILENCE AND A REASON. A wrong answer delivered confidently is worse than no
// answer, and that applies to voices too.
const _REASONS = {
    nokey:    "no ElevenLabs key is set",
    novoice:  "this speaker has no ElevenLabs voice assigned",
    invalid:  "ElevenLabs does not recognise that voice id (404) — it may belong to another account, or have been deleted",
    error:    "the ElevenLabs request failed",
    badkey:   "ElevenLabs rejected the API key",
    proxy:    "the GM's client could not produce the audio",
};

/**
 * Refuse to speak rather than drop to the robot voice. Returns "ok" so callers
 * carry on normally: the line is still on screen, it simply is not spoken.
 */
function _refuseRobot(reason, detail = "") {
    // ⚠️ A PLAYER MUST BE TOLD WHY THEIR NPC WENT QUIET (2026-08-21). This was
    // GM-only, which is right for "go fix your API key" and completely wrong
    // for a rate limit: Liam watched Varek stop mid-scene with nothing on his
    // screen at all, while the only explanation sat in the GM's console.
    // Config advice stays GM business; anything that just means "wait" is for
    // whoever is looking at the silent NPC.
    if (!game.user?.isGM && reason === "proxy") {
        ui.notifications?.warn(
            `The voice did not play: ${detail || "the GM's client could not produce the audio"}. ` +
            `The words are still in the chat.`);
        console.warn(`TTS | voice unavailable via GM proxy — ${detail || reason}`);
        return "ok";
    }
    if (game.user?.isGM) {
        // ⚠️ The provider's own sentence beats anything we can paraphrase.
        const why = detail && reason === "badkey"
            ? `ElevenLabs rejected the API key: ${detail}`
            : (_REASONS[reason] ?? reason);
        ui.notifications?.error(
            `ACE: that line was not spoken because ${why}. ` +
            `The browser voice is off because you chose ElevenLabs — fix the cause, or switch to the browser voice in ACE Engine → Voice & TTS.`,
            { permanent: true });
    }
    console.warn(`TTS | refused to fall back to the browser voice — ${reason}${detail ? ` (${detail})` : ""}`);
    return "ok";
}

/**
 * The words that identify THIS creature, for creature-sound scoring.
 * "Ogre (1)" -> ["ogre"], so an ogre prefers ogre-roar over a generic one.
 * Numbers and duplicate markers are stripped; short words are dropped because
 * two-letter fragments match everything.
 */
function _soundAffinities(actorName) {
    return String(actorName ?? "")
        .toLowerCase()
        .replace(/\([^)]*\)/g, " ")
        .split(/[^a-z]+/)
        .filter(w => w.length >= 3);
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
/**
 * ⚠️ SILENT DOWNGRADE — the reason this bug survived eleven "fixes" (2026-08-06).
 *
 * When the key went missing, the ONLY signal was a console.warn nobody reads.
 * Johnny found out because a player heard a robot voice mid-scene, and every
 * investigation started at the voice path instead of at the credential. A
 * fallback that costs the user something must ANNOUNCE ITSELF.
 *
 * Fires once per session so it can't spam a conversation, and only for the GM
 * — a player can do nothing about a missing key on the GM's machine.
 */
let _warnedNoKey = false;
function _warnBrowserFallback() {
    if (_warnedNoKey || !game.user?.isGM) return;
    _warnedNoKey = true;
    console.warn(`${MODULE_ID} | No ElevenLabs key found (checked config.local.json, then Module Settings) — NPC speech has fallen back to robotic browser TTS.`);
    // ⚠️🔴 THIS TOAST USED TO SAY "paste your key into config.local.json"
    // (Brock, 2026-08-19). Two other places in this same module warn that a key
    // in that file is readable by every player — Foundry serves it over plain
    // HTTP — so a GM who followed this toast recreated the exact leak the
    // loader had just warned them about. A permanent on-screen instruction
    // beats a console warning every time. Never point anyone at that file again.
    ui.notifications?.warn(
        "ACE: no ElevenLabs key found — NPC voices are using robotic browser TTS. "
      + "Add your key in ACE Engine → AI Setup. It is stored in this browser only "
      + "and is never sent to your players.",
        { permanent: true }
    );
}

/** Which voice provider the world is set to. */
export function _voiceProvider() {
    try { return game.settings.get(MODULE_ID, "voiceProvider") || "elevenlabs"; }
    catch (_) { return "elevenlabs"; }
}

/**
 * ⚠️🔴 SAY WHY THE LOCAL SERVER IS OUT, ONCE, ON SCREEN.
 *
 * The two ways a self-hosted speech server fails are both invisible: the server
 * is not running, or the browser refused the request before it left the page.
 * Both surface as the same generic fetch failure, so the reason is worked out
 * in tts-local.mjs and repeated here verbatim rather than being flattened into
 * "voice unavailable". A GM who is told "HTTPS blocks a plain http LAN address"
 * fixes it in a minute; a GM told "voice failed" loses an evening.
 */
let _warnedLocalServer = false;
function _warnLocalServerUnreachable(reason) {
    if (_warnedLocalServer || !game.user?.isGM) return;
    _warnedLocalServer = true;
    console.warn(`${MODULE_ID} | Local speech server unavailable: ${reason}`);
    ui.notifications?.warn(`ACE: the local speech server is not usable — ${reason}`, { permanent: true });
}

/**
 * Decide which TTS path this client should take.
 *   "local"   — generate on THIS client, broadcast the audio to everyone else.
 *   "proxy"   — ask the GM to generate; we play the audio it sends back.
 *   "browser" — free browser speechSynthesis (robotic), only if chosen.
 *   "refuse"  — cannot produce the chosen voice; say so rather than play a robot.
 *
 * ⚠️🔴 THIS IS WHERE "IT WORKS ON MY MACHINE" WOULD LIVE (2026-08-23).
 *
 * For ElevenLabs, "does this client hold a key" is a fair test of whether it can
 * generate. For a SELF-HOSTED server that test is meaningless and the natural
 * substitute — "am I the GM" — is worse, because it is an assumption. A GM whose
 * server is not running would be told to generate and would fail silently, and a
 * player who genuinely can reach a shared server would be needlessly relayed.
 *
 * So for the local provider the question is answered by PROOF: this client
 * generates only if it has actually reached the server. Everything else is
 * relayed through the GM, which is safe because the relay already broadcasts
 * finished audio as bytes — a player never needs to reach the server at all.
 *
 * Async because proving it requires a request. The result is cached per session.
 */
async function _ttsMode() {
    if (_userPickedBrowser()) return "browser";

    if (_voiceProvider() === "localserver") {
        let ready = { ok: false, reason: "the local speech module could not be loaded" };
        try {
            const { probe } = await import("./tts-local.mjs");
            ready = await probe();
        } catch (err) {
            console.warn(`${MODULE_ID} | local speech module failed to load:`, err);
        }
        if (ready.ok) return "local";
        if (!game.user.isGM && _gmAvailable()) return "proxy";
        // ⚠️ The GM cannot reach their OWN server, or no GM is connected. Both
        // are real faults with real fixes, and neither is "play a robot".
        _warnLocalServerUnreachable(ready.reason);
        return "refuse";
    }

    const hasLocalKey = !!_getElevenLabsKey();
    if (hasLocalKey) return "local";
    if (!game.user.isGM && _gmAvailable()) return "proxy";
    // Reaching here as the GM means the key is genuinely missing — say so.
    _warnBrowserFallback();
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
        // ⚠️ ONE SWITCH, AT THE ONLY PLACE THAT TOUCHES A PROVIDER. Everything
        // past this method — decoding, volume normalisation, pitch, the socket
        // broadcast, the GM relay, creature sounds — is provider-agnostic and
        // must stay that way. Adding a provider is adding a branch HERE and
        // nothing else. Building a parallel speak path beside this one is the
        // habit Johnny called out on 08-11 and it would double every bug.
        if (_voiceProvider() === "localserver") {
            // A local voice is a NAME on that server, not an ElevenLabs id, and
            // an empty one is legitimate: most local engines have a default.
            const { synthesize } = await import("./tts-local.mjs");
            return synthesize(text, voiceId, voiceSettings);
        }

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
            // ⚠️ ELEVENLABS ALREADY EXPLAINED THE PROBLEM. USE ITS WORDS.
            // 2026-08-21: a 400 came back saying, in plain English, "API key ID
            // used as API key - only valid API keys can be used. API keys start
            // with sk_". That is the entire diagnosis, sitting in the response
            // body, and we threw it away and told the GM "the request failed".
            // Hours were spent hunting a key that was never a key.
            let detail = "";
            try {
                const j = JSON.parse(err);
                detail = j?.detail?.message ?? j?.detail?.status ?? j?.message ?? "";
            } catch (_) { detail = String(err).slice(0, 200); }
            // An auth failure can arrive as 400, not only 401/403 - which is
            // exactly how this one slipped past the branch below.
            if (/api[_ ]?key|authentication|unauthor/i.test(detail)) {
                return { status: "badkey", detail };
            }
            // A dead/mis-scoped key (401 unauthorized, 403 missing permission)
            // silently fell back to the robot voice — that cost a two-hour hunt
            // (2026-07-10). SHOUT it instead: a throttled GM toast pointing at
            // the exact fix, at most once every 60s so it can't spam.
            if ((response.status === 401 || response.status === 403) && game.user?.isGM) {
                const nowMs = performance.now?.() ?? 0;
                if (nowMs - (TTSEngine._lastKeyToast ?? -1e9) > 60_000) {
                    TTSEngine._lastKeyToast = nowMs;
                    const why = response.status === 403
                        ? "missing the Text-to-Speech permission — create a Full-Access key"
                        : "invalid or expired";
                    ui.notifications?.error(
                        `ACE Engine: your ElevenLabs API key is ${why}. NPCs are using the robot voice. `
                        + `Fix it in Configure Settings → ACE Engine → Voice & TTS.`,
                        { permanent: true }
                    );
                }
            }
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
                        exclude: game.user.id,
                        // The receiver refuses anonymous speech; without this
                        // the mirror is silently inaudible, not silently open.
                        userId:  game.user.id
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

        const mode = await _ttsMode();

        if (mode === "browser") {
            // Console note only, once per session. Playing without an ElevenLabs
            // key is a perfectly valid free setup — not a fault — so it does NOT
            // earn a toast. The AI Setup screen already shows which voice is
            // active for anyone who wants to know.
            // ⚠️ SAY IT ON SCREEN, ONCE. This was a console.log with a comment
            // arguing that a free setup "does NOT earn a toast". That reasoning
            // holds for somebody who CHOSE the browser voice - and not at all
            // for somebody whose key stopped resolving, which is what actually
            // happens: the voice silently turns robotic mid-session and the
            // only trace is a line in a console nobody has open. Johnny hit
            // exactly that twice in two days.
            //
            // So: if they deliberately picked Browser TTS, stay quiet. If they
            // are on the default and simply have no working key, tell them.
            if (!this._browserTTSNotified) {
                this._browserTTSNotified = true;
                let chose = false;
                try { chose = game.settings.get(MODULE_ID, "voiceProvider") === "browser"; } catch (_) {}
                if (chose) {
                    console.log("TTS | Browser voice selected in settings — nothing wrong.");
                } else {
                    ui.notifications?.warn(
                        "ACE: NPC voices have dropped to the robotic browser voice — no working ElevenLabs key was found. " +
                        "Add or re-check it in ACE Engine → Voice & TTS.", { permanent: true });
                    console.warn("TTS | No ElevenLabs key resolved while voiceProvider is 'elevenlabs' — using the browser voice.");
                }
            }
            if (!_userPickedBrowser()) return _refuseRobot("nokey");
            await this._speakBrowser(text, pitch);
            return "ok";
        }

        // ⚠️ REFUSE MEANS SAY SO, NOT PLAY A ROBOT. The chosen provider cannot
        // produce this line on this client and no relay is available. The reason
        // was already put on screen by the mode resolver; going quiet here is
        // what the whole "a wrong answer delivered confidently" rule forbids.
        if (mode === "refuse") {
            if (_userPickedBrowser()) { await this._speakBrowser(text, pitch); return "ok"; }
            return _refuseRobot("error", "the local speech server could not be reached from this client");
        }

        if (mode === "proxy") {
            const r = await this._speakViaGm(text, voiceId, voiceSettings, pitch);
            if (r === "ok") return "ok";
            // Proxy failed (GM offline mid-request, key invalid, network) —
            // fall back to browser so the player still hears something.
            if (!_userPickedBrowser()) return _refuseRobot("proxy", r);
            await this._speakBrowser(text, pitch);
            return "ok";
        }

        // mode === "local" — generate on this client and broadcast.
        const result = await this._fetch(text, voiceId, voiceSettings);
        if (result.status !== "ok") {
            // ⚠️ This is the branch that has been playing the robot. Name the
            // cause on screen instead of hiding it behind a console warning.
            if (!_userPickedBrowser()) return _refuseRobot(result.status, result.detail ?? `voice ${voiceId || "(none)"}`);
            console.warn(`TTS | speak() got status "${result.status}" for voice ${voiceId} — browser voice was chosen, so using it.`);
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
                exclude: game.user.id,
                // The receiver refuses anonymous audio; without this the
                // spectator broadcast is silently inaudible.
                userId:  game.user.id,
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
                if (match.index > lastIndex) {
                    // Only push real speech — the gap between two adjacent
                    // emotes is whitespace, not a line, and pushing it as an
                    // empty segment is what broke the queue above.
                    const _between = fullText.slice(lastIndex, match.index).trim();
                    if (_between) segments.push({ type: "dialogue", text: _between });
                }
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
                // ⚠️ AN EMPTY SEGMENT SKIPS. IT DOES NOT STOP THE QUEUE.
                // This was `if (!seg.text || this._stopRequested) break;` — one
                // condition for two completely different situations. The parser
                // creates an EMPTY dialogue segment between two adjacent emotes
                // (the space between `*a*` and `*b*`), so any reply with two
                // emotes in a row spoke its first line and then went silent.
                // Johnny: "the narrator didn't continue… it happens once in a
                // while." It happened every single time the AI wrote two
                // actions back to back, which for a creature that can only
                // gesture is most of the time. The console said it plainly:
                // "5 segment(s) to speak", one heard. (2026-08-07)
                if (this._stopRequested) break;      // a real stop — end everything
                if (!seg.text) continue;             // nothing to say — move on

                try {
                    if (seg.type === "dialogue") {
                        let dialogueText = seg.text;

                        if (creatureSoundFolder && _csStripSoundEffects) {
                            const { cleaned, hadSounds } = _csStripSoundEffects(dialogueText);
                            if (hadSounds) {
                                console.log(`TTS | Stripped sound words: "${dialogueText}" → "${cleaned}"`);
                                // ⚠️ READ THE RETURN VALUE (2026-08-07). This used to
                                // fire and forget, ASSUMING a clip played. When the
                                // whole line is sound-words the stripped text is
                                // EMPTY, so if the clip also failed the NPC said
                                // absolutely nothing — which is exactly what Johnny
                                // hit: a 5-INT ogre whose every line is "Grrr! Roar!"
                                // was completely mute, twice, with the AI replying
                                // perfectly both times.
                                const played = await _csPlayCreatureSound(
                                    creatureSoundFolder, voicePitch, _soundAffinities(actorName));
                                if (this._stopRequested) break;
                                if (!played && !cleaned.trim()) {
                                    // No clip AND nothing left to say. Speak the line
                                    // as written — an ogre growling "Grrr! Roar!" in
                                    // its own voice beats silence every time.
                                    console.warn(`TTS | No creature clip available and nothing left after stripping — speaking the raw line so the NPC is not mute.`);
                                    dialogueText = seg.text;
                                } else {
                                    dialogueText = cleaned;
                                }
                            } else {
                                dialogueText = cleaned;
                            }
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
                            const played = await _csPlayCreatureSound(
                                creatureSoundFolder, voicePitch, _soundAffinities(actorName));
                            // Only skip the spoken version if the clip ACTUALLY played.
                            // `continue` on a failed clip is how "*Roar*" became silence.
                            if (played) continue;
                            console.warn(`TTS | Sound emote had no clip — narrating it instead of dropping it.`);
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
