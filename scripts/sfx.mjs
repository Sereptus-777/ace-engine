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
  _shakeScreen();
  _spawnDebris();
  setTimeout(() => _playRumble(), 100);
}

function _shakeScreen() {
  document.body.classList.remove("ace-earthquake-shake");
  // Force reflow so re-adding the class restarts the animation
  void document.body.offsetWidth;
  document.body.classList.add("ace-earthquake-shake");

  // Clean up after animation completes (~2.4s)
  setTimeout(() => {
    document.body.classList.remove("ace-earthquake-shake");
  }, 2600);
}

function _spawnDebris() {
  const count = 18;
  const colors = ["#8b7355", "#6b5a3c", "#9e8b6e", "#554430", "#a09080"];
  const frags = [];

  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "ace-debris-particle";
    const size = 3 + Math.random() * 6;              // 3–9px
    el.style.width  = `${size}px`;
    el.style.height = `${size}px`;
    el.style.left   = `${Math.random() * 100}vw`;
    el.style.top    = `-${10 + Math.random() * 30}px`;
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.animationDuration  = `${2.0 + Math.random() * 1.2}s`;  // 2.0–3.2s
    el.style.animationDelay     = `${Math.random() * 0.6}s`;         // stagger
    document.body.appendChild(el);
    frags.push(el);
  }

  // Cleanup all particles after longest possible animation
  setTimeout(() => frags.forEach((f) => f.remove()), 4000);
}

function _playRumble() {
  if (_currentSfxAudio) {
    _currentSfxAudio.pause();
    _currentSfxAudio.currentTime = 0;
    _currentSfxAudio = null;
  }

  _currentSfxAudio = new Audio("modules/ace-engine/assets/Earthquake.wav");
  _currentSfxAudio.volume = 0.85;
  _currentSfxAudio.play().catch((err) => {
    console.warn("ACE SFX | Earthquake rumble playback error:", err);
  });
  _currentSfxAudio.onended = () => { _currentSfxAudio = null; };
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
