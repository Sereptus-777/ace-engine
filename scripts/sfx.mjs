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

  const audio = new Audio("modules/ace-engine/assets/Thunder.wav");
  _currentSfxAudio = audio;
  audio.volume = 1.0;
  audio.play().catch((err) => {
    console.warn("ACE SFX | Thunder playback error:", err);
  });
  // Only null the ref if it still points to THIS audio (prevents race with new SFX)
  audio.onended = () => { if (_currentSfxAudio === audio) _currentSfxAudio = null; };
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
    const fallback = new Audio("modules/ace-engine/assets/Earthquake.wav");
    _currentSfxAudio = fallback;
    fallback.volume = 0.6;
    fallback.play().catch(() => {});
    fallback.onended = () => { if (_currentSfxAudio === fallback) _currentSfxAudio = null; };
  }
}

/* ── Stealth Fail — twig snap / kicked rock / armor clank ── */

const _stealthFailSounds = [
  _synthTwigSnap,
  _synthKickedRock,
  _synthArmorClank,
  _synthStumble,
  _synthLoosePebbles,
];

export function triggerStealthFail() {
  const fn = _stealthFailSounds[Math.floor(Math.random() * _stealthFailSounds.length)];
  fn();
}

function _synthTwigSnap() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Sharp transient crack — very short burst of filtered noise
    const dur = 0.08;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const env = Math.exp(-i / (d.length * 0.08));   // fast decay
      d[i] = (Math.random() * 2 - 1) * env * 1.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 1800;
    const gain = ctx.createGain();
    gain.gain.value = 0.7;
    src.connect(hp).connect(gain).connect(ctx.destination);
    src.start();
    src.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
}

function _synthKickedRock() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Short thud + scrape: low thump then gritty skitter
    const dur = 0.25;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / ctx.sampleRate;
      const thud = Math.sin(t * 180 * Math.PI * 2) * Math.exp(-t * 30) * 0.6;
      const scrape = (Math.random() * 2 - 1) * Math.max(0, t - 0.04) * Math.exp(-(t - 0.04) * 12) * 0.5;
      d[i] = thud + scrape;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0.6;
    src.connect(gain).connect(ctx.destination);
    src.start();
    src.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
}

function _synthArmorClank() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Metallic ping — two close sine bursts at harmonic frequencies
    const dur = 0.3;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / ctx.sampleRate;
      const ping1 = Math.sin(t * 3200 * Math.PI * 2) * Math.exp(-t * 18) * 0.3;
      const ping2 = Math.sin(t * 4800 * Math.PI * 2) * Math.exp(-t * 22) * 0.2;
      const noise = (Math.random() * 2 - 1) * Math.exp(-t * 25) * 0.15;
      d[i] = ping1 + ping2 + noise;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    src.connect(gain).connect(ctx.destination);
    src.start();
    src.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
}

function _synthStumble() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Two thuds in quick succession — a foot catching then hitting
    const dur = 0.35;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / ctx.sampleRate;
      const thud1 = Math.sin(t * 120 * Math.PI * 2) * Math.exp(-t * 20) * 0.5;
      const t2 = Math.max(0, t - 0.12);
      const thud2 = Math.sin(t2 * 90 * Math.PI * 2) * Math.exp(-t2 * 15) * 0.7;
      const dirt = (Math.random() * 2 - 1) * Math.exp(-t * 8) * 0.15;
      d[i] = thud1 + (t > 0.12 ? thud2 : 0) + dirt;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 600;
    const gain = ctx.createGain();
    gain.gain.value = 0.65;
    src.connect(lp).connect(gain).connect(ctx.destination);
    src.start();
    src.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
}

function _synthLoosePebbles() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Rapid sequence of tiny clicks — like pebbles skittering
    const dur = 0.4;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const clicks = [0.0, 0.04, 0.07, 0.11, 0.16, 0.22, 0.30];
    for (let i = 0; i < d.length; i++) {
      const t = i / ctx.sampleRate;
      let val = 0;
      for (const ct of clicks) {
        const dt = t - ct;
        if (dt >= 0 && dt < 0.02) {
          val += (Math.random() * 2 - 1) * Math.exp(-dt * 200) * (0.3 + Math.random() * 0.3);
        }
      }
      d[i] = val;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 2500; bp.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.value = 0.55;
    src.connect(bp).connect(gain).connect(ctx.destination);
    src.start();
    src.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
}

/* ── Perception Pass — faint rustle / distant footstep / whisper / creak ── */

const _perceptionPassSounds = [
  _synthFaintRustle,
  _synthDistantFootstep,
  _synthEerieCreak,
  _synthWhisper,
  _synthBreathingClose,
];

export function triggerPerceptionPass() {
  const fn = _perceptionPassSounds[Math.floor(Math.random() * _perceptionPassSounds.length)];
  fn();
}

function _synthFaintRustle() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Soft filtered noise that swells and fades — leaves rustling
    const dur = 0.8;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.sin(t / dur * Math.PI) * 0.3;  // gentle swell
      d[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 3000; bp.Q.value = 0.5;
    const gain = ctx.createGain();
    gain.gain.value = 0.25;
    src.connect(bp).connect(gain).connect(ctx.destination);
    src.start();
    src.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
}

function _synthDistantFootstep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Single muffled thump — like a boot on dirt, far away
    const dur = 0.3;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / ctx.sampleRate;
      const thud = Math.sin(t * 60 * Math.PI * 2) * Math.exp(-t * 12) * 0.4;
      const ground = (Math.random() * 2 - 1) * Math.exp(-t * 10) * 0.08;
      d[i] = thud + ground;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 300;
    const gain = ctx.createGain();
    gain.gain.value = 0.3;
    src.connect(lp).connect(gain).connect(ctx.destination);
    src.start();
    src.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
}

function _synthEerieCreak() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Slow frequency sweep — like old wood groaning
    const dur = 0.6;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / ctx.sampleRate;
      const freq = 400 + Math.sin(t * 8) * 200;   // wobbling frequency
      const env = Math.sin(t / dur * Math.PI) * 0.25;
      d[i] = Math.sin(t * freq * Math.PI * 2) * env * 0.15 + (Math.random() * 2 - 1) * env * 0.1;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 500; bp.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.value = 0.3;
    src.connect(bp).connect(gain).connect(ctx.destination);
    src.start();
    src.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
}

function _synthWhisper() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Breathy noise shaped like speech cadence — unsettling whisper
    const dur = 1.0;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / ctx.sampleRate;
      // Pulsing envelope simulates syllables
      const syllable = Math.sin(t * 6 * Math.PI * 2) * 0.3 + 0.7;
      const env = Math.sin(t / dur * Math.PI);
      d[i] = (Math.random() * 2 - 1) * env * syllable * 0.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 2000; bp.Q.value = 1;
    const gain = ctx.createGain();
    gain.gain.value = 0.2;
    src.connect(bp).connect(gain).connect(ctx.destination);
    src.start();
    src.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
}

function _synthBreathingClose() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Two slow breaths — filtered noise with rhythmic envelope
    const dur = 1.4;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / ctx.sampleRate;
      // Two breath cycles
      const breath1 = t < 0.6 ? Math.sin(t / 0.6 * Math.PI) : 0;
      const breath2 = t > 0.7 && t < 1.3 ? Math.sin((t - 0.7) / 0.6 * Math.PI) : 0;
      const env = (breath1 + breath2) * 0.2;
      d[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 1200;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass"; hp.frequency.value = 200;
    const gain = ctx.createGain();
    gain.gain.value = 0.25;
    src.connect(lp).connect(hp).connect(gain).connect(ctx.destination);
    src.start();
    src.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
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
