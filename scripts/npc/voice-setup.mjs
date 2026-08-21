// ─── ACE Engine — Set up your voice before you need it ───────────────────────
//
// Johnny, 2026-08-21, after losing an evening to it: "Once I picked the correct
// microphone in Chrome, then speak automatically worked. I had to switch our
// mic to the correct mic, which seems fucked up. We got to have a 'set up your
// microphone' thing before they start talking to NPCs."
//
// ⚠️ THE FACT THAT MAKES OUR MIC DROPDOWN A LIE.
// Chrome's webkitSpeechRecognition takes NO device argument. It always uses
// whatever Chrome's site permission has set as the microphone for this origin,
// and nothing a web page does can change that. So ACE's own device picker
// selects the device for the LEVEL METER only. Picking "the right mic" in our
// dropdown and then finding dictation still dead is not a bug the user caused -
// it is our UI implying a control it does not have.
//
// This screen exists to say that once, plainly, and to prove the chain works
// end to end BEFORE somebody is mid-session in front of their players:
//   1. is a microphone reachable at all
//   2. does CHROME's chosen device actually produce recognised words
//   3. is a premium voice configured, or are they about to get the robot
//
// ⚠️ IT TESTS RECOGNITION, NOT THE LEVEL BAR. A bouncing meter proves only that
// SOME device works. The whole failure was a loud meter with a deaf recogniser,
// so a check that stops at the meter would have passed on the broken setup.

const MODULE_ID = "ace-engine";
const LOG = "ACE: Engine | VoiceSetup";

/** Chrome's own microphone permission page — where the device is really chosen. */
const CHROME_MIC_SETTINGS = "chrome://settings/content/microphone";

export const VoiceSetup = {

  /** Has this browser been through the check for this world? */
  get _done() {
    try { return game.settings.get(MODULE_ID, "voiceSetupDone") === true; }
    catch (_) { return false; }
  },
  async _markDone() {
    try { await game.settings.set(MODULE_ID, "voiceSetupDone", true); } catch (_) {}
  },

  /**
   * Run once, the first time this client opens an NPC conversation.
   * Never blocks the conversation - it opens alongside it.
   */
  async maybePrompt() {
    if (this._done) return;
    await this._markDone();          // one prompt per browser, even if they cancel
    this.open({ firstRun: true });
  },

  /* ─── The checks ──────────────────────────────────────────────────────── */

  /** Can we open ANY microphone? Returns a plain-English result. */
  async _checkDevice() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { ok: false, text: "This browser exposes no microphone API at all." };
    }
    if (window.isSecureContext === false) {
      return { ok: false, text: `This page is served over plain http://, and browsers only allow the microphone on https:// or localhost. Voice input cannot work here. Typing still does.` };
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const label = s.getAudioTracks()[0]?.label || "(unnamed device)";
      s.getTracks().forEach(t => t.stop());
      return { ok: true, text: `Chrome is using: <strong>${foundry.utils.escapeHTML(label)}</strong>`, label };
    } catch (err) {
      const n = err?.name ?? "";
      const text = n === "NotAllowedError"
        ? "Microphone permission is blocked for this site. Click the padlock in the address bar, allow Microphone, then reload."
        : n === "NotFoundError"
        ? "No microphone was found. Plug one in."
        : n === "NotReadableError"
        ? "Your microphone is held by another program - a dictation tool, meeting app or recorder. Close it."
        : `Could not open a microphone (${n || "unknown error"}).`;
      return { ok: false, text };
    }
  },

  /**
   * Does speech recognition actually produce words on THIS machine?
   *
   * ⚠️ This is the check that matters and the one nothing did before. It runs
   * the real recogniser for a few seconds and reports whether anything came
   * back - which is exactly the step that was failing while the level meter
   * happily bounced.
   */
  _checkRecognition(seconds = 6) {
    return new Promise((resolve) => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        resolve({ ok: false, text: "This browser has no speech recognition. Chrome and Edge have it; Firefox and Safari do not. Typing always works." });
        return;
      }
      let heard = "", settled = false;
      const rec = new SR();
      rec.lang = "en-US";
      rec.continuous = true;
      rec.interimResults = true;

      const finish = (ok, text) => {
        if (settled) return;
        settled = true;
        try { rec.stop(); rec.abort?.(); } catch (_) {}
        resolve({ ok, text, heard });
      };

      rec.onresult = (e) => {
        for (const r of e.results) heard += r[0].transcript;
        if (heard.trim()) {
          finish(true, `Heard you: "<strong>${foundry.utils.escapeHTML(heard.trim().slice(0, 60))}</strong>"`);
        }
      };
      rec.onerror = (e) => {
        if (e.error === "no-speech") {
          finish(false, `Chrome's recogniser received no audio. Its microphone is chosen in Chrome's own settings, NOT in ACE - open <code>${CHROME_MIC_SETTINGS}</code> and set the right device there, then try again.`);
        } else if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          finish(false, "Chrome refused the microphone for this site. Allow it via the padlock in the address bar, then reload.");
        } else if (e.error === "network") {
          finish(false, "Chrome's speech service could not be reached. Speech recognition needs an internet connection.");
        } else {
          finish(false, `Speech recognition failed (${e.error}).`);
        }
      };
      rec.onend = () => finish(!!heard.trim(),
        heard.trim() ? `Heard you: "${heard.trim().slice(0, 60)}"`
                     : `Nothing was recognised. If you did speak, Chrome is listening to a different microphone than you think - it picks its own, at <code>${CHROME_MIC_SETTINGS}</code>.`);

      try { rec.start(); } catch (err) {
        finish(false, `Could not start speech recognition (${err?.message ?? "unknown"}).`);
      }
      setTimeout(() => finish(!!heard.trim(),
        heard.trim() ? `Heard you: "${heard.trim().slice(0, 60)}"`
                     : `Nothing was recognised in ${seconds} seconds. Chrome chooses its own microphone at <code>${CHROME_MIC_SETTINGS}</code> - ACE's dropdown only drives the level bar.`), seconds * 1000);
    });
  },

  /** Premium voice, or are they about to get the robot? */
  async _checkVoice() {
    let key = "";
    try {
      const { getSharedElevenLabsKey } = await import("./shared-credentials.mjs");
      key = getSharedElevenLabsKey();
    } catch (_) {}
    if (!key) {
      return { ok: false, text: "No ElevenLabs key, so NPCs will use the free robotic browser voice. Add a key in ACE Engine → AI Setup for real voices." };
    }
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/user", {
        headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        return { ok: false, text: `ElevenLabs rejected your key (${res.status}). NPCs will fall back to the robotic browser voice until it is fixed.` };
      }
      return { ok: true, text: "ElevenLabs is live - NPCs will use your premium narrator voice." };
    } catch (_) {
      return { ok: false, text: "Could not reach ElevenLabs to check the key. It may still be fine." };
    }
  },

  /* ─── The window ──────────────────────────────────────────────────────── */

  open({ firstRun = false } = {}) {
    const row = (id, label) => `
      <div class="acevs-row" data-row="${id}">
        <div class="acevs-dot" data-dot="${id}">•</div>
        <div>
          <div class="acevs-label">${label}</div>
          <div class="acevs-text" data-text="${id}">not checked yet</div>
        </div>
      </div>`;

    // ⚠️ Dark wrapper + 15px minimum. Foundry's dialog is light parchment and
    // ACE's palette is invisible on it; this pops over Foundry's own chrome so
    // it does not get the compact panel sizing.
    const content = `
      <style>
        .acevs { background:#0f1014; border:1px solid #3a3122; border-left:4px solid #d4af37;
                 border-radius:5px; padding:14px 16px; line-height:1.5; }
        .acevs h3 { color:#d4af37; font-size:19px; margin:0 0 4px; font-weight:700; }
        .acevs .acevs-intro { color:#c9bd94; font-size:15px; margin-bottom:10px; }
        .acevs-row { display:flex; gap:10px; padding:8px 0; border-top:1px solid #2a2419; }
        .acevs-dot { font-size:20px; line-height:1.2; color:#8a8168; width:18px; text-align:center; }
        .acevs-label { color:#e8dcb8; font-size:16px; font-weight:600; }
        .acevs-text { color:#c9bd94; font-size:15px; }
        .acevs-text code { background:#1a1a20; padding:1px 5px; border-radius:3px; color:#d4af37; }
        .acevs-note { margin-top:10px; color:#8a8168; font-size:14px; }
      </style>
      <div class="acevs">
        <h3>Voice check</h3>
        <div class="acevs-intro">
          ${firstRun ? "First time talking to an NPC on this browser. " : ""}
          Two minutes now beats finding out mid-session. Press <strong>Run the check</strong>,
          then <strong>say something out loud</strong> when it asks.
        </div>
        ${row("device", "Microphone")}
        ${row("recog",  "Speech recognition")}
        ${row("voice",  "NPC voice")}
        <div class="acevs-note">
          ACE's microphone dropdown drives the level bar only. Chrome picks its own
          microphone for speech, at <code>${CHROME_MIC_SETTINGS}</code>.
        </div>
      </div>`;

    const dlg = new foundry.applications.api.DialogV2({
      window: { title: "ACE — Voice check", icon: "fa-solid fa-microphone-lines", resizable: true },
      position: { width: 560 },
      content,
      buttons: [
        {
          action: "run", label: "Run the check", icon: "fa-solid fa-play", default: true,
          // ⚠️ Returning false keeps DialogV2 open so results can be written
          // into it. A check that closed its own window before reporting would
          // be worse than no check.
          callback: async (_ev, _btn, dialog) => { await VoiceSetup._run(dialog); return false; },
        },
        { action: "close", label: "Close", icon: "fa-solid fa-xmark" },
      ],
    });
    dlg.render(true);
    return dlg;
  },

  async _run(dialog) {
    const root = dialog?.element ?? document;
    const set = (id, ok, text) => {
      const dot = root.querySelector(`[data-dot="${id}"]`);
      const txt = root.querySelector(`[data-text="${id}"]`);
      if (dot) { dot.textContent = ok === null ? "…" : ok ? "✓" : "✕";
                 dot.style.color = ok === null ? "#8a8168" : ok ? "#7fc98b" : "#e08a7a"; }
      if (txt) txt.innerHTML = text;
    };

    set("device", null, "checking…");
    const dev = await this._checkDevice();
    set("device", dev.ok, dev.text);
    if (!dev.ok) {
      set("recog", false, "skipped - no microphone to test with.");
    } else {
      set("recog", null, "<strong>Say something now</strong> — anything, for a few seconds…");
      const rec = await this._checkRecognition(6);
      set("recog", rec.ok, rec.text);
    }

    set("voice", null, "checking…");
    const v = await this._checkVoice();
    set("voice", v.ok, v.text);

    console.log(`${LOG} | device=${dev.ok} voice=${v.ok}`);
  },
};
