// ============================================================
// ACE — AI Campaign Engine — Sound & Visual Effects (SFX)
// Lightning flash + Thunder.wav, Earthquake shake + rumble
// ============================================================

let _currentSfxAudio = null;

export function triggerLightning() {
  _flashScreen();
  setTimeout(() => _playThunder(), 200);
}

function _flashScreen() {
  document.querySelector(".ace-lightning-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "ace-lightning-overlay";
  document.body.appendChild(overlay);

  const kf = [
    { t: 0,   o: 0.00 },
    { t: 40,  o: 0.95 },
    { t: 80,  o: 0.20 },
    { t: 115, o: 0.72 },
    { t: 175, o: 0.00 },
    { t: 235, o: 0.30 },
    { t: 400, o: 0.00 },
  ];

  let start = null;
  const total = kf[kf.length - 1].t;

  (function frame(ts) {
    if (!start) start = ts;
    const elapsed = ts - start;
    if (elapsed >= total) { overlay.remove(); return; }

    let prev = kf[0], next = kf[1];
    for (let i = 1; i < kf.length; i++) {
      if (kf[i].t >= elapsed) { prev = kf[i - 1]; next = kf[i]; break; }
    }
    const t = (elapsed - prev.t) / (next.t - prev.t);
    overlay.style.opacity = String(prev.o + (next.o - prev.o) * t);
    requestAnimationFrame(frame);
  })(performance.now());
}

function _playThunder() {
  if (_currentSfxAudio) {
    _currentSfxAudio.pause();
    _currentSfxAudio.currentTime = 0;
    _currentSfxAudio = null;
  }

  _currentSfxAudio = new Audio("modules/ace-engine/assets/Thunder.wav");
  _currentSfxAudio.volume = 1.0;
  _currentSfxAudio.play().catch((err) => {
    console.warn("ACE SFX | Thunder playback error:", err);
  });
  _currentSfxAudio.onended = () => { _currentSfxAudio = null; };
}

/* ── Earthquake ──────────────────────────────────────────── */

export function triggerEarthquake() {
  _playRumbleSynth();         // Procedural deep rumble (replaces bad WAV)
  _shakeScreenProgressive();  // Slow build → peak → fade
  setTimeout(() => _spawnDebris(), 600);  // Debris starts after initial tremor
}

/**
 * Progressive screen shake: small tremors → violent quake → calm.
 * Total duration ~3.5s: 0.8s build + 1.8s peak + 0.9s fade
 */
function _shakeScreenProgressive() {
  document.body.classList.remove("ace-earthquake-shake");
  void document.body.offsetWidth;
  document.body.classList.add("ace-earthquake-shake");

  setTimeout(() => {
    document.body.classList.remove("ace-earthquake-shake");
  }, 3800);
}

/**
 * Debris particles — rocks/dust that fall from above and drift downward.
 * Two waves: an initial scatter, then a heavier burst during peak shaking.
 */
function _spawnDebris() {
  const colors = ["#8b7355", "#6b5a3c", "#9e8b6e", "#554430", "#a09080", "#7a6a55"];
  const frags = [];

  // Wave 1: light initial dust (few small particles from edges/top)
  _spawnDebrisWave(6, colors, frags, { sizeMin: 2, sizeMax: 5, delayMax: 0.3, durationMin: 1.8, durationMax: 2.5 });

  // Wave 2: heavy rubble burst after 400ms (more, bigger, from more locations)
  setTimeout(() => {
    _spawnDebrisWave(16, colors, frags, { sizeMin: 3, sizeMax: 10, delayMax: 0.5, durationMin: 1.5, durationMax: 2.8 });
  }, 400);

  // Cleanup all particles
  setTimeout(() => frags.forEach((f) => f.remove()), 5000);
}

function _spawnDebrisWave(count, colors, frags, { sizeMin, sizeMax, delayMax, durationMin, durationMax }) {
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "ace-debris-particle";
    const size = sizeMin + Math.random() * (sizeMax - sizeMin);
    el.style.width  = `${size}px`;
    el.style.height = `${size}px`;
    el.style.background = colors[Math.floor(Math.random() * colors.length)];

    // Spawn from top edge OR upper sides (not just straight-line rain)
    const fromSide = Math.random() < 0.3;
    if (fromSide) {
      // Spawn from upper-left or upper-right edge
      el.style.left = Math.random() < 0.5 ? `${-5 + Math.random() * 10}px` : `${window.innerWidth - 10 + Math.random() * 10}px`;
      el.style.top  = `${Math.random() * 40}vh`;
    } else {
      el.style.left = `${5 + Math.random() * 90}vw`;
      el.style.top  = `-${5 + Math.random() * 20}px`;
    }

    // Horizontal drift — gives each particle a unique trajectory
    const driftX = -30 + Math.random() * 60;
    el.style.setProperty("--debris-drift-x", `${driftX}px`);

    el.style.animationDuration = `${durationMin + Math.random() * (durationMax - durationMin)}s`;
    el.style.animationDelay    = `${Math.random() * delayMax}s`;
    el.style.borderRadius      = Math.random() < 0.4 ? "50%" : `${Math.random() * 3}px`;

    document.body.appendChild(el);
    frags.push(el);
  }
}

/**
 * Procedural earthquake rumble using Web Audio API.
 * Deep brown noise filtered to sub-bass frequencies with volume envelope:
 * fade-in (0.8s) → sustained rumble (2s) → fade-out (1s)
 */
function _playRumbleSynth() {
  // Stop any existing SFX audio
  if (_currentSfxAudio) {
    _currentSfxAudio.pause?.();
    _currentSfxAudio.currentTime = 0;
    _currentSfxAudio = null;
  }

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const duration = 3.8;

    // Brown noise buffer — deeper and more natural than white noise
    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(2, bufferSize, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + (0.02 * white)) / 1.02;   // Brown noise filter
        data[i] = last * 3.5;                     // Amplify
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Low-pass filter — keep only the deep rumble (< 100 Hz)
    const lowPass = ctx.createBiquadFilter();
    lowPass.type = "lowpass";
    lowPass.frequency.value = 90;
    lowPass.Q.value = 0.7;

    // Secondary resonance for that "cavern" feel
    const resonance = ctx.createBiquadFilter();
    resonance.type = "peaking";
    resonance.frequency.value = 45;
    resonance.gain.value = 8;
    resonance.Q.value = 1.5;

    // Volume envelope: fade-in → sustain → fade-out
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.7, now + 0.8);    // Slow build
    gain.gain.setValueAtTime(0.7, now + 2.8);              // Sustained rumble
    gain.gain.linearRampToValueAtTime(0, now + duration);  // Fade out

    source.connect(lowPass).connect(resonance).connect(gain).connect(ctx.destination);
    source.start();
    source.onended = () => ctx.close().catch(() => {});

    // Track for stopAllSfx
    _currentSfxAudio = { pause: () => { try { source.stop(); ctx.close(); } catch (_) {} }, currentTime: 0 };
  } catch (err) {
    console.warn("ACE SFX | Web Audio rumble failed, falling back to WAV:", err);
    // Fallback to the WAV file if Web Audio is unavailable
    _currentSfxAudio = new Audio("modules/ace-engine/assets/Earthquake.wav");
    _currentSfxAudio.volume = 0.6;
    _currentSfxAudio.play().catch(() => {});
    _currentSfxAudio.onended = () => { _currentSfxAudio = null; };
  }
}

/* ── Stop all ────────────────────────────────────────────── */

export function stopAllSfx() {
  if (_currentSfxAudio) {
    _currentSfxAudio.pause();
    _currentSfxAudio.currentTime = 0;
    _currentSfxAudio = null;
  }
  if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel();
}

export function playEvilLaugh(variant = "male") {
  if (!window.speechSynthesis) return;

  const configs = {
    male: {
      text: "Mwahahaha ha ha ha ha! Your doom is upon you! Mwahahahaha!",
      pitch: 0.32, rate: 0.70,
      find: /david|george|daniel|thomas|fred|alex|mark/i,
    },
    female: {
      text: "Hehehehe! Oh how absolutely delightful! Kehehehehehe!",
      pitch: 1.80, rate: 0.88,
      find: /samantha|karen|victoria|alice|zira|linda/i,
    },
    creature: {
      text: "Gaaaarrraaahahahaha! RAAAAAAHAHAHAHA! Graaaaahhh hah hah!",
      pitch: 0.06, rate: 0.45,
      find: /david|george|daniel|male|deep/i,
    },
  };

  const cfg = configs[variant] ?? configs.male;
  window.speechSynthesis.cancel();

  const utt = new SpeechSynthesisUtterance(cfg.text);
  utt.lang = "en-US";
  utt.pitch = cfg.pitch;
  utt.rate = cfg.rate;

  const voices = window.speechSynthesis.getVoices();
  if (voices.length) {
    const match = voices.find((v) => cfg.find.test(v.name));
    if (match) utt.voice = match;
  }
  window.speechSynthesis.speak(utt);
}
