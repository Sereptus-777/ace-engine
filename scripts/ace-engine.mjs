// ============================================================
// ACE — AI Campaign Engine
// Main entry point: hooks, settings, and initialization
// ============================================================

import { AcePanel }          from "./panel.mjs";
import { AceSettings }       from "./settings.mjs";
import { SceneContext }       from "./scene-context.mjs";
import { AiProvider }         from "./ai-provider.mjs";
import { SuggestionEngine }   from "./suggestion-engine.mjs";
import { NpcMemoryReader }    from "./npc-memory.mjs";
import { MemoryManager }      from "./memory-manager.mjs";
import { triggerLightning, triggerEarthquake, triggerStealthFail, triggerPerceptionPass, stopAllSfx } from "./sfx.mjs";
import { CanvasHighlight }   from "./canvas-highlight.mjs";
import { ReputationEngine }  from "./reputation-engine.mjs";
import { SubtleRollManager } from "./subtle-rolls.mjs";
import { FameEngine }        from "./fame-engine.mjs";
import { DocumentEngine }    from "./document-engine.mjs";
import { DigestEngine }      from "./digest-engine.mjs";
import { SimpleCalendarBridge } from "./simple-calendar-bridge.mjs";
import { filterProfanity, buildProfanityPrompt } from "./profanity-filter.mjs";
import { WorldBibleEngine }    from "./world-bible-engine.mjs";
import { VaultEngine }         from "./vault-engine.mjs";
import { VaultSearch }         from "./vault-search.mjs";
import { SceneIntelligence }   from "./scene-intelligence.mjs";
// Social Profile Engine moved to ace-envoy (standalone module, no cross-dependency)

const MODULE_ID = "ace-engine";

// ── XSS escape helper ───────────────────────────────────────
function _escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ── Story Notes — auto-append notable events to PC biographies ──

const _bioWriteQueue = new Map();  // actorId → Promise chain (serializes writes)

/**
 * Silently append a story-note bullet to a PC actor's biography HTML.
 * Creates a "Notable Events" section if one doesn't exist.
 * @param {Actor} actor — Must be a PC (hasPlayerOwner). NPC calls are no-ops.
 * @param {string} bulletText — Plain text for the bullet (will be HTML-escaped).
 */
function _appendStoryNote(actor, bulletText) {
  // Gate on setting
  try {
    if (!game.settings.get(MODULE_ID, "enableStoryNotes")) return Promise.resolve();
  } catch (_) { return Promise.resolve(); }

  // PCs only
  if (!actor?.hasPlayerOwner || actor.type !== "character") return Promise.resolve();
  if (!bulletText) return Promise.resolve();

  // Serialize writes per-actor to prevent race conditions
  const prev = _bioWriteQueue.get(actor.id) ?? Promise.resolve();
  const next = prev.then(() => _doAppendStoryNote(actor, bulletText)).catch(err => {
    console.warn(`${MODULE_ID} | Story note failed for ${actor.name}:`, err);
  });
  _bioWriteQueue.set(actor.id, next);
  return next;
}

async function _doAppendStoryNote(actor, bulletText) {
  const bio = actor.system?.details?.biography?.value ?? "";

  // Build the timestamp and bullet HTML
  const dateStr    = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const escaped    = _escapeHtml(bulletText);
  const newLi      = `<li><strong>${dateStr}</strong> — ${escaped}</li>`;

  // Duplicate check — skip if this exact bullet text is already in the bio
  if (bio.includes(escaped)) return;

  let newBio;
  if (bio.includes("<!-- ACE-STORY-NOTES -->")) {
    // Insert new <li> before the closing </ul> inside our notes section
    newBio = bio.replace(
      /(<\/ul>\s*<!-- \/ACE-STORY-NOTES -->)/,
      `${newLi}\n$1`
    );
  } else {
    // Create the notes section from scratch
    const section = `\n<hr>\n<!-- ACE-STORY-NOTES -->\n<h4>Notable Events</h4>\n<ul>\n${newLi}\n</ul>\n<!-- /ACE-STORY-NOTES -->`;
    newBio = bio + section;
  }

  await actor.update({ "system.details.biography.value": newBio });
  console.log(`${MODULE_ID} | Story note added to ${actor.name}: ${bulletText}`);

  // Also write to the PC store notes array (for PC journal profiles)
  if (aceMemory) {
    const pc = aceMemory.pcs.touchPc(actor.id, actor.name);
    if (pc) {
      if (!Array.isArray(pc.notes)) pc.notes = [];
      // Dedup: skip if this exact text already exists
      if (!pc.notes.some(n => n.txt === bulletText)) {
        pc.notes.push({ t: Math.floor(Date.now() / 1000), txt: bulletText });
        if (pc.notes.length > 100) pc.notes.shift(); // cap at 100 notes
        aceMemory.pcs.markDirty();
        aceMemory._scheduleSaves(["pcs"]);
        aceMemory.writePcJournal(actor.id).catch(() => {});
      }
    }
  }
}

// ── Significance filters for story notes ────────────────────

function _isSignificantKill(victimActor) {
  if (!victimActor) return false;

  // Named/unique NPC: name doesn't end with " #N" pattern (e.g. "Goblin 3")
  const numberedPattern = /^.+\s+\d+$/;
  const isNamed = !numberedPattern.test(victimActor.name);

  // CR check: CR >= half the average party level
  const cr = Number(victimActor.system?.details?.cr);
  if (!isNaN(cr) && cr > 0) {
    const avgLevel = _getAveragePartyLevel();
    if (cr >= avgLevel * 0.5) return true;
  }

  // Named NPCs are always notable
  return isNamed;
}

function _isSignificantItem(rarity) {
  const notable = new Set(["rare", "veryRare", "legendary", "artifact"]);
  return notable.has(rarity);
}

function _isDramaticDispositionShift(fromLabel, toLabel) {
  // Only Hostile ↔ Friendly is dramatic enough
  return (fromLabel === "Hostile" && toLabel === "Friendly")
      || (fromLabel === "Friendly" && toLabel === "Hostile");
}

function _getAveragePartyLevel() {
  const pcs = game.actors?.filter(a => a.hasPlayerOwner && a.type === "character") ?? [];
  if (!pcs.length) return 1;
  const total = pcs.reduce((sum, a) => sum + (Number(a.system?.details?.level) || 1), 0);
  return total / pcs.length;
}

// ── Deed magnitude estimation helpers ─────────────────────────

/** Estimate magnitude for a kill deed based on CR vs party level. */
function _estimateKillMagnitude(victimActor) {
  const cr = Number(victimActor?.system?.details?.cr);
  if (isNaN(cr) || cr <= 0) return "local";
  const avgLevel = _getAveragePartyLevel();
  if (cr >= avgLevel * 2)   return "major";     // CR 2× party level = major feat
  if (cr >= avgLevel)        return "regional";  // CR ≥ party level = notable
  return "local";                                 // lower CR = local news
}

/** Map item rarity to deed magnitude. */
function _itemRarityToMagnitude(rarity) {
  switch (rarity) {
    case "artifact":   return "legendary";
    case "legendary":  return "major";
    case "veryRare":   return "regional";
    case "rare":       return "local";
    default:           return null;  // not significant enough for a deed
  }
}

/** Determine if a level-up is a milestone (5/10/15/20). */
function _levelUpMagnitude(newLevel) {
  const milestones = new Set([5, 10, 15, 20]);
  return milestones.has(newLevel) ? "regional" : "local";
}

// ── Narrative time keyword parsing ────────────────────────────

const _TIME_PATTERNS = [
  { regex: /\b(?:dawn|sunrise|morning|first light)\b/i,                    time: "morning" },
  { regex: /\b(?:midday|noon|high sun)\b/i,                                time: "midday" },
  { regex: /\bafternoon\b/i,                                               time: "afternoon" },
  { regex: /\b(?:evening|sunset|dusk|twilight)\b/i,                        time: "evening" },
  { regex: /\b(?:night|midnight|dark(?:ness)?|stars|moonlight|moonrise)\b/i, time: "night" },
];

const _DAY_ADVANCE_PATTERNS = [
  { regex: /\b(?:next day|following day|next morning|the morning after)\b/i, days: 1 },
  { regex: /(\d+)\s*days?\s*(?:later|pass(?:ed)?|travel(?:ed)?|journey)/i,   daysCapture: 1 },
];

/**
 * Parse narration text for time-of-day keywords and day advances.
 * Returns { timeOfDay?: string, advanceDays?: number } or null if no cues found.
 */
function _parseNarrativeTimeCues(text) {
  if (!text || text.length < 3) return null;

  let result = null;

  // Check for day advances first (they also set time to morning)
  for (const pat of _DAY_ADVANCE_PATTERNS) {
    const m = text.match(pat.regex);
    if (m) {
      const days = pat.daysCapture !== undefined ? parseInt(m[pat.daysCapture], 10) : pat.days;
      if (days > 0 && days <= 365) {
        result = { advanceDays: days, timeOfDay: "morning" };
        break;
      }
    }
  }

  // Check for time-of-day keywords (overridden if day advance already matched)
  if (!result) {
    for (const pat of _TIME_PATTERNS) {
      if (pat.regex.test(text)) {
        result = { timeOfDay: pat.time };
        break;
      }
    }
  }

  return result;
}

// ── Local credentials (loaded from config.local.json at startup) ──
// These take priority over Settings entries so the GM never needs
// to re-enter keys in the UI.  See config.local.json for instructions.
export const localCredentials = {};

// ── Global state ───────────────────────────────────────────────
let panel          = null;
let sceneCtx       = null;
let aiProvider     = null;
let suggestionEngine = null;
let npcMemory      = null;
let aceMemory      = null;   // MemoryManager — persistent campaign log (8-category)
let reputationEngine = null; // ReputationEngine — faction awareness / word-of-mouth
let fameEngine     = null;   // FameEngine — party deed fame / geographic reputation
let documentEngine = null;   // DocumentEngine — document library / reference RAG
let digestEngine   = null;   // DigestEngine — AI-powered structured digest (global)
let worldBible     = null;   // WorldBibleEngine — comprehensive world reference bible
let calendarBridge = null;   // SimpleCalendarBridge — optional Simple Calendar sync
let subtleRolls    = null;   // SubtleRollManager — blind skill checks with AI narration
let vaultEngine    = null;   // VaultEngine — cross-campaign archival snapshots + Legacy Ledger
let vaultSearch    = null;   // VaultSearch — cross-campaign query search
let sceneIntelligence = null; // SceneIntelligence — per-scene deep knowledge cache
let _aceReady      = false;  // true after all subsystems (AI, memory, etc.) are initialized

// ── Initialization ─────────────────────────────────────────────
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing ACE`);
  AceSettings.register();

  game.keybindings.register(MODULE_ID, "openPanel", {
    name:     "Open ACE Panel",
    hint:     "Toggle the ACE GM Assistant panel",
    editable: [{ key: "KeyL", modifiers: ["Control", "Shift"] }],
    onDown:   () => { if (game.user.isGM) openPanel(); },
    restricted: true,
  });
});

// ── Scene control button — v12 (array-based API) ───────────────
// Works in v13 too via backward-compat shim
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM || !Array.isArray(controls)) return;
  const tokenGroup = controls.find((c) => c.name === "token" || c.name === "tokens");
  if (tokenGroup) {
    tokenGroup.tools.push({
      name:    "ace-engine",
      title:   "ACE — GM Assistant (Ctrl+Shift+L)",
      icon:    "fas fa-scroll",
      visible:  true,
      onClick: () => openPanel(),
      button:   true,
    });
  }
});

// ── Scene control button — v13 (DOM injection via renderSceneControls) ────
// Fires when scene controls are rendered; we inject our button into the DOM.
Hooks.on("renderSceneControls", (app, html) => {
  if (!game.user?.isGM) return;
  _injectAceControl();
});

/**
 * Inject the ACE toolbar button into Foundry's scene controls.
 *
 * Foundry v13 structure (confirmed via DOM inspection):
 *   <aside id="scene-controls">
 *     <menu id="scene-controls-layers">   <- inject here
 *       <li><button class="control ui-control layer icon ..."></button></li>
 *
 * Foundry v12 structure (legacy):
 *   <nav id="controls">
 *     <ol class="main-controls">
 *       <li class="scene-control ...">...</li>
 */
function _injectAceControl() {
  // Don't inject twice (re-checked after every render)
  if (document.querySelector("[data-ace-control]")) return;

  // v13 first, then v12 fallbacks
  const mainControls =
    document.querySelector("#scene-controls-layers")           ??  // v13 confirmed
    document.querySelector("#scene-controls menu:first-child") ??  // v13 alt
    document.querySelector("#scene-controls ol")               ??  // v13 alt2
    document.querySelector("#controls .main-controls")         ??  // v12
    document.querySelector("#controls ol")                     ??  // v12 alt
    document.querySelector(".main-controls")                   ??  // generic
    null;

  if (!mainControls) {
    console.log(`${MODULE_ID} | Toolbar: controls menu not found yet`);
    return;
  }

  console.log(`${MODULE_ID} | Toolbar: injecting into <${mainControls.tagName}> #${mainControls.id}`);

  // v13 uses <li><button ...></button></li> — match that pattern exactly
  const li  = document.createElement("li");
  li.setAttribute("data-ace-control", "1");

  const btn = document.createElement("button");
  btn.type      = "button";
  btn.className = "control ui-control";
  btn.setAttribute("data-tooltip", "ACE — GM Assistant (Ctrl+Shift+L)");
  btn.setAttribute("aria-label",   "ACE — GM Assistant");
  btn.title = "ACE — GM Assistant (Ctrl+Shift+L)";
  // Let Foundry's .control.ui-control CSS supply the gray background + border-radius.
  // Only override layout — no background/border overrides that would fight Foundry's styles.
  btn.style.cssText = "display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;width:100%;height:100%;";

  // Use the same fa-book-sparkles icon as the panel header, in grimoire gold
  const icon = document.createElement("i");
  icon.className   = "fas fa-book-sparkles";
  icon.style.cssText = "font-size:28px;color:#c9a84c;pointer-events:none;display:block;";

  btn.appendChild(icon);
  li.appendChild(btn);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPanel();
  });

  mainControls.appendChild(li);
  console.log(`${MODULE_ID} | Toolbar button injected`);
}

// ── Standalone browser TTS for players (no panel, no ElevenLabs) ──────
// Used by socket handlers when a player receives narration broadcast.
// Players don't have an AcePanel instance or ElevenLabs key.
function _speakBrowserTTS(text, volume = 1.0) {
  if (!text || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^#+\s+/gm, "")
    .trim();
  if (!clean) return;
  const utter = new SpeechSynthesisUtterance(clean);
  utter.rate = 1.0;
  utter.pitch = 1.0;
  utter.volume = Math.max(0, Math.min(1, volume));
  // Try to find a decent English voice
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v => /David|Daniel|Google US English/i.test(v.name) && v.lang.startsWith("en"));
  if (preferred) utter.voice = preferred;
  window.speechSynthesis.speak(utter);
}

// ── Global audio stop — kills ALL audio sources (panel, narration, browser TTS) ──
function _stopAllAudio() {
  // Stop standalone narration audio
  if (_narrationAudio) {
    try { _narrationAudio.pause(); _narrationAudio.src = ""; } catch (_) {}
    _narrationAudio = null;
  }
  // Stop browser TTS
  if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel();
  // Stop panel TTS (if panel is open)
  if (panel?._cancelTTS) panel._cancelTTS();
  // Stop any SFX
  if (panel?.stopSfx) panel.stopSfx();
  console.log(`${MODULE_ID} | All audio stopped`);
}

// ── Play narration audio from base64 (ElevenLabs quality on player side) ──
let _narrationAudio = null;

function _playNarrationAudio(base64, volume = 0.8) {
  // Stop any previous narration audio
  if (_narrationAudio) {
    try { _narrationAudio.pause(); _narrationAudio.src = ""; } catch (_) {}
    _narrationAudio = null;
  }
  try {
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob   = new Blob([bytes], { type: "audio/mpeg" });
    const url    = URL.createObjectURL(blob);
    _narrationAudio = new Audio(url);
    _narrationAudio.volume      = Math.max(0, Math.min(1, volume));
    _narrationAudio.playbackRate = 1.1;  // match GM's playback speed
    _narrationAudio.onended = () => { URL.revokeObjectURL(url); _narrationAudio = null; };
    _narrationAudio.onerror = () => { URL.revokeObjectURL(url); _narrationAudio = null; };
    _narrationAudio.play().catch(err => {
      console.warn(`${MODULE_ID} | Narration audio playback failed:`, err);
      URL.revokeObjectURL(url);
      _narrationAudio = null;
    });
    console.log(`${MODULE_ID} | Playing narration audio from GM (${(base64.length / 1024).toFixed(0)} KB, vol=${volume})`);
  } catch (err) {
    console.warn(`${MODULE_ID} | Narration audio decode failed:`, err);
  }
}

// ── Standalone ElevenLabs TTS (no panel dependency) ─────────────
// Used by _handleSubtleBroadcast to generate audio when panel is closed.

function _getElevenLabsKeyStandalone() {
  try { return game.settings.get(MODULE_ID, "elevenLabsApiKey") || ""; }
  catch (_) { return ""; }
}

async function _generateElevenLabsAudio(text, apiKey) {
  if (!text || !apiKey) return null;
  const voiceId = (() => {
    try { return game.settings.get(MODULE_ID, "elevenLabsVoiceId") || "o3hzbFqcuIw2MRzP8rQf"; }
    catch (_) { return "o3hzbFqcuIw2MRzP8rQf"; }
  })();
  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.35, use_speaker_boost: true },
    }),
  });
  if (!resp.ok) throw new Error(`ElevenLabs ${resp.status}: ${resp.statusText}`);
  const buf = await resp.arrayBuffer();
  // Convert to base64 for socket transport
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── Ready: initialize for ALL users (socket listener first) ────
Hooks.once("ready", async () => {
  // ── Clean up stray CONFIG.debug.hooks left on by other modules (e.g. chat-images)
  if (CONFIG.debug?.hooks) CONFIG.debug.hooks = false;

  // ── Socket listener — runs for ALL users (GM + players) ──────
  // This lets players receive SFX broadcast by the GM.
  game.socket.on(`module.${MODULE_ID}`, (data) => {
    if (data?.type === "sfx") {
      // Only accept SFX from GM users (prevents player socket spoofing)
      if (data.userId && !game.users.get(data.userId)?.isGM) return;
      // If targeted to a specific player, only that player plays it
      if (data.targetUserId && data.targetUserId !== game.user.id) return;
      _handleRemoteSfx(data);
    }
    if (data?.type === "subtle-narration-tts" && data.text) {
      // Player receives narration TTS broadcast — speak it aloud
      if (data.targetUserId && data.targetUserId !== game.user.id) return;
      // GM has full TTS via panel; players use standalone browser speech
      if (panel?._speakText) {
        panel._speakText(data.text);
      } else {
        _speakBrowserTTS(data.text);
      }
    }

    // ── Stop audio broadcast — GM told everyone to stop ─────────
    if (data?.type === "stop-audio") {
      if (data.userId && !game.users.get(data.userId)?.isGM) return; // GM-only
      _stopAllAudio();
    }

    // ── Narration audio broadcast (ElevenLabs quality) ────────────
    if (data?.type === "narration-audio" && data.audio) {
      if (data.userId === game.user.id) return;  // sender already plays locally
      if (data.userId && !game.users.get(data.userId)?.isGM) return; // GM-only
      // If targeted to a specific player, only that player hears it
      if (data.targetUserId && data.targetUserId !== game.user.id) return;
      let vol = 0.8;
      try { vol = game.settings.get(MODULE_ID, "narrationVolume") ?? 0.8; } catch (_) {}
      if (vol <= 0) return;  // muted
      _playNarrationAudio(data.audio, vol);
    }

    // ── Narration text broadcast (browser TTS fallback) ───────────
    if (data?.type === "narration-tts" && data.text) {
      if (data.userId === game.user.id) return;  // sender already plays locally
      if (data.userId && !game.users.get(data.userId)?.isGM) return; // GM-only
      let vol = 0.8;
      try { vol = game.settings.get(MODULE_ID, "narrationVolume") ?? 0.8; } catch (_) {}
      if (vol <= 0) return;  // muted
      _speakBrowserTTS(data.text, vol);
    }
  });

  // ── Register password masking for API key fields in Settings ──
  AceSettings.maskSecretFields();

  // ── GM-only initialization ────────────────────────────────────
  if (!game.user.isGM) return;

  console.log(`${MODULE_ID} | ACE ready — GM mode active`);

  // ── Load baked-in credentials from config.local.json (optional) ─
  // GM-only: players don't need ElevenLabs keys or other credentials.
  // If the file exists and contains your ElevenLabs key/voice, those
  // values will be used instead of whatever is in Module Settings.
  try {
    const resp = await fetch(`modules/${MODULE_ID}/config.local.json`, { cache: "no-store" });
    if (resp.ok) {
      const cfg = await resp.json();
      const { elevenLabsApiKey, elevenLabsVoiceId, elevenLabsModel } = cfg;
      if (elevenLabsApiKey  && !elevenLabsApiKey.includes("YOUR_"))  localCredentials.elevenLabsApiKey  = elevenLabsApiKey.trim();
      if (elevenLabsVoiceId && !elevenLabsVoiceId.includes("YOUR_")) localCredentials.elevenLabsVoiceId = elevenLabsVoiceId.trim();
      if (elevenLabsModel)                                            localCredentials.elevenLabsModel   = elevenLabsModel.trim();
      if (Object.keys(localCredentials).length) {
        console.log(`${MODULE_ID} | Loaded local credentials from config.local.json (${Object.keys(localCredentials).join(", ")})`);
      }
    }
  } catch (_) { /* No config.local.json — perfectly fine, use Settings */ }

  // ── Envoy sync status ──────────────────────────────────────
  if (game.modules.get("ace-envoy")?.active) {
    try {
      const envoySync = game.settings.get("ace-envoy", "useAceEngineSettings");
      const cfg = AceSettings.getProviderConfig();
      if (envoySync) {
        console.log(`${MODULE_ID} | Envoy sync: ON — both modules using ${cfg.provider} → ${cfg.modelName}`);
      } else {
        console.log(`${MODULE_ID} | Envoy sync: OFF — Envoy is using its own AI settings`);
      }
    } catch (_) { /* Envoy may not have the new setting yet */ }
  }

  // ── One-time system prompt migrations ──
  try {
    let currentPrompt = game.settings.get(MODULE_ID, "systemPrompt") || "";
    let changed = false;

    // Migration 1: library awareness
    if (currentPrompt && !currentPrompt.includes("REFERENCE LIBRARY section is present")) {
      currentPrompt += `\n\nWhen a REFERENCE LIBRARY section is present in your context, that content has ALREADY been extracted from the GM's uploaded documents (PDFs, text files, etc.). You have it right now — do NOT say "let me retrieve the file" or "give me a moment to access the PDF." Just answer using the reference material provided.`;
      changed = true;
    }

    // Migration 2: structured digest + training knowledge awareness
    if (currentPrompt && !currentPrompt.includes("STRUCTURED REFERENCE DATA")) {
      currentPrompt += ` When STRUCTURED REFERENCE DATA is present, it contains AI-extracted entities (NPCs, locations, items, encounters, factions, lore) from the GM's sourcebooks — use it directly. For published content (official D&D modules, Pathfinder adventures, etc.), ALSO use your own training knowledge to fill in gaps the reference data does not cover. If neither reference data nor your training covers the question, say so honestly.`;
      changed = true;
    }

    // Migration 3: verbatim quoting of room/area descriptions
    if (currentPrompt && !currentPrompt.includes("quote the relevant text directly")) {
      currentPrompt += `\n\nWhen the GM asks about a specific room, area, location, or section from an uploaded sourcebook, quote the relevant text directly from the REFERENCE LIBRARY — include the full description, features, creatures, treasure, and any read-aloud text. Do NOT summarize or hedge with "you'd need to check the book." The text IS in your context — present it fully and confidently.`;
      changed = true;
    }

    // Migration 4: source conflict resolution (legacy — replaced by Migration 5)
    if (currentPrompt && !currentPrompt.includes("conflicting information") && !currentPrompt.includes("EDITION CONFLICTS")) {
      currentPrompt += `\n\nWhen multiple source documents contain conflicting information (different editions, timeline changes, retcons), prefer the most recently uploaded document. GM session notes and campaign-specific content ALWAYS take priority over published sourcebooks. If you notice a conflict, briefly mention it so the GM can decide.`;
      changed = true;
    }

    // Migration 5: Fix "most recently uploaded" → edition-based priority
    //   Old text said prefer newest UPLOAD order — wrong, should be newest EDITION.
    //   Also replaces the old wall-of-text reference library paragraph with cleaner bullets.
    if (currentPrompt && currentPrompt.includes("prefer the most recently uploaded document")) {
      // Remove the old conflict resolution paragraph
      currentPrompt = currentPrompt.replace(
        /\n*When multiple source documents contain conflicting information[^]*?briefly mention it so the GM can decide\./,
        ""
      );
      // Remove the old reference library wall-of-text if present (Migrations 1+2 added it)
      currentPrompt = currentPrompt.replace(
        /\n*When a REFERENCE LIBRARY section is present[^]*?say so honestly\./,
        ""
      );
      // Add the new clean versions
      currentPrompt += `\n\n## REFERENCE DATA\n- REFERENCE LIBRARY and STRUCTURED REFERENCE DATA sections contain content already extracted from the GM's documents. Use it directly — NEVER say "let me retrieve the file" or "give me a moment to access the PDF."\n- For published content (official modules, adventures), also use your training knowledge to fill gaps.\n- If neither reference data nor your training covers the question, say so honestly.`;
      currentPrompt += `\n\n## EDITION CONFLICTS\n- When sources contain conflicting stats or rules from different editions (e.g. AD&D THAC0 vs 5E attack bonuses, descending AC vs ascending AC), ALWAYS use the newest edition (5th Edition / 5E) stats.\n- GM session notes and campaign-specific content ALWAYS override published sourcebooks.\n- If you notice an edition conflict, briefly mention it so the GM can decide.`;
      changed = true;
    }

    if (changed) {
      await game.settings.set(MODULE_ID, "systemPrompt", currentPrompt);
      console.log(`${MODULE_ID} | Migrated system prompt: added library/digest awareness`);
    }
  } catch (_) { /* non-critical — prompt just stays as-is */ }

  // ── TTS availability diagnostic ────────────────────────────
  {
    const localKey = localCredentials?.elevenLabsApiKey || "";
    let settingsKey = "";
    try { settingsKey = (game.settings.get(MODULE_ID, "elevenLabsApiKey") || "").trim(); } catch (_) {}
    if (localKey) {
      console.log(`${MODULE_ID} | TTS: ElevenLabs key loaded from config.local.json`);
    } else if (settingsKey) {
      console.log(`${MODULE_ID} | TTS: ElevenLabs key found in Module Settings`);
    } else {
      console.warn(
        `${MODULE_ID} | TTS: No ElevenLabs API key — narration will use browser voice (Microsoft David / best available).\n` +
        `  -> Fix: Foundry Settings -> Module Settings -> ACE -> "ElevenLabs API Key"\n` +
        `  -> Set it once — it's stored per-browser and works across all worlds.`
      );
    }
  }

  aiProvider      = new AiProvider();
  sceneCtx        = new SceneContext();
  npcMemory       = new NpcMemoryReader();
  suggestionEngine = new SuggestionEngine(aiProvider, sceneCtx, npcMemory);

  // ── Persistent campaign memory (7-category system) ──────────
  try {
    aceMemory = new MemoryManager();
    await aceMemory.load();
  } catch (err) {
    console.error(`${MODULE_ID} | Memory system failed to initialize:`, err);
    ui.notifications?.error("ACE: Memory system failed to load — see F12 console for details.");
    aceMemory = null;
  }

  // ── Reputation / Word-of-Mouth Engine ───────────────────────
  const reputationEnabled = game.settings.get(MODULE_ID, "enableReputation");
  if (reputationEnabled) {
    try {
      reputationEngine = new ReputationEngine();
      await reputationEngine.load(game.world.id);
      const repStats = reputationEngine.getStats();
      console.log(`${MODULE_ID} | Reputation engine loaded: notoriety=${repStats.notoriety}, ${repStats.deedCount} deeds, ${repStats.titleCount} titles, ${repStats.factionCount} faction standings`);
    } catch (err) {
      console.error(`${MODULE_ID} | Reputation engine failed:`, err);
      reputationEngine = null;
    }
  } else {
    console.log(`${MODULE_ID} | Reputation engine disabled by settings.`);
  }

  // ── Fame Engine — party deeds / geographic reputation ─────
  const fameEnabled = game.settings.get(MODULE_ID, "enableFameSystem");
  if (aceMemory && fameEnabled) {
    try {
      fameEngine = new FameEngine(aceMemory);
      console.log(`${MODULE_ID} | Fame engine initialized (${aceMemory.deeds?.recordCount ?? 0} deeds, day ${aceMemory.getDayCounter()})`);
    } catch (err) {
      console.error(`${MODULE_ID} | Fame engine failed:`, err);
      fameEngine = null;
    }
  } else if (!fameEnabled) {
    console.log(`${MODULE_ID} | Fame engine disabled by settings.`);
  }

  // ── Digest Engine — global AI-powered structured digests ──
  try {
    digestEngine = new DigestEngine();
    await digestEngine.loadIndex();
    const allDigests = digestEngine.getAllDigests();
    console.log(`${MODULE_ID} | Digest engine initialized (${allDigests.length} global digests)`);
  } catch (err) {
    console.error(`${MODULE_ID} | Digest engine failed:`, err);
    digestEngine = null;
  }

  // ── World Bible — comprehensive world reference ──
  try {
    worldBible = new WorldBibleEngine();
    await worldBible.load(game.world.id);
    if (worldBible.hasData) {
      worldBible._buildIndexes();
      const stats = worldBible.getStats();
      console.log(`${MODULE_ID} | World Bible loaded: "${stats.setting}" — ${stats.nationCount} nations, ${stats.cityCount} cities, ${stats.factionCount} factions, ${stats.deityCount} deities`);
      // Give SceneContext access to Bible for auto-location lookup
      if (sceneCtx) sceneCtx.setWorldBible(worldBible);
    } else {
      console.log(`${MODULE_ID} | World Bible: no data yet (generate via panel)`);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | World Bible init failed:`, err);
    worldBible = null;
  }

  // ── Document Engine — reference library (PDF, text, images) ──
  const libEnabled = game.settings.get(MODULE_ID, "enableDocumentLibrary") ?? true;
  if (aceMemory && libEnabled) {
    try {
      documentEngine = new DocumentEngine(aceMemory, digestEngine);

      // ── Recover stuck "processing"/"uploading" documents from interrupted sessions ──
      // If a document was mid-extraction when Foundry crashed, the store may have
      // status="processing" with no chunks — but the disk cache may have the full
      // extraction. Try to restore from cache before giving up and marking "error".
      const allDocs = aceMemory.documents.getAll();
      let recoveredCount = 0;
      let cacheRestoredCount = 0;

      // Helper: attempt to restore a document's chunks from the global disk cache
      const _tryRestoreFromCache = async (doc) => {
        try {
          const cached = await documentEngine.loadDocumentCache(doc.fileName);
          if (cached?.chunks?.length) {
            if (cached.parents?.length) {
              aceMemory.documents.setChunks(doc.id, { chunks: cached.chunks, parents: cached.parents });
            } else {
              aceMemory.documents.setChunks(doc.id, cached.chunks);
            }
            if (cached.tags?.length)  aceMemory.documents.setTags(doc.id, cached.tags);
            if (cached.pageCount)     aceMemory.documents.setPageCount(doc.id, cached.pageCount);
            if (cached.embeddings)    aceMemory.documents.setEmbeddings(doc.id, cached.embeddings);
            if (cached.images?.length) {
              for (const img of cached.images) aceMemory.documents.addImage(doc.id, img);
            }
            aceMemory.documents.setStatus(doc.id, "ready");
            cacheRestoredCount++;
            console.log(`${MODULE_ID} | Restored "${doc.displayName}" from disk cache (${cached.chunks.length} chunks)`);
            return true;
          }
        } catch (cacheErr) {
          console.warn(`${MODULE_ID} | Cache restore failed for "${doc.displayName}":`, cacheErr);
        }
        return false;
      };

      for (const doc of allDocs) {
        const hasChunks = (doc.chunks?.length ?? 0) > 0;

        // Case 1: Document stuck in "processing"/"uploading" (crashed mid-extraction)
        if (doc.status === "processing" || doc.status === "uploading") {
          if (hasChunks) {
            aceMemory.documents.setStatus(doc.id, "ready");
          } else if (!(await _tryRestoreFromCache(doc))) {
            aceMemory.documents.setStatus(doc.id, "error", "Interrupted — please delete and re-upload");
          }
          recoveredCount++;
        }

        // Case 2: Document marked "ready" but has 0 chunks (data lost / save race condition)
        // The UI shows green badges but the AI can't actually use the document.
        else if (doc.status === "ready" && !hasChunks && doc.type !== "image") {
          console.warn(`${MODULE_ID} | "${doc.displayName}" is marked ready but has 0 chunks — attempting cache restore`);
          if (!(await _tryRestoreFromCache(doc))) {
            aceMemory.documents.setStatus(doc.id, "error", "Data lost — please delete and re-upload");
          }
          recoveredCount++;
        }

        // Case 3: Document stuck in "error" but disk cache has full data
        // This happens when recovery marked it as error but the cache was written later.
        else if (doc.status === "error" && !hasChunks && doc.type !== "image") {
          console.warn(`${MODULE_ID} | "${doc.displayName}" is in error state — re-checking disk cache`);
          if (await _tryRestoreFromCache(doc)) {
            console.log(`${MODULE_ID} | Successfully recovered "${doc.displayName}" from disk cache on retry`);
          }
          recoveredCount++;
        }
      }

      if (recoveredCount > 0) {
        aceMemory._scheduleSave("documents");
        const msg = cacheRestoredCount > 0
          ? `Recovered ${recoveredCount} document(s) (${cacheRestoredCount} restored from disk cache)`
          : `Recovered ${recoveredCount} document(s) with issues`;
        console.warn(`${MODULE_ID} | ${msg}`);
      }

      const stats = documentEngine.getLibrarySummary();
      console.log(`${MODULE_ID} | Document engine initialized (${stats.totalDocuments} docs, ${stats.totalChunks} chunks, ${stats.totalImages} images)`);

      // Pre-load active digests for this world
      if (digestEngine) {
        const activeIds = aceMemory.documents.getActiveDigests();
        if (activeIds.length) {
          await digestEngine.loadActiveDigests(activeIds);
          console.log(`${MODULE_ID} | Loaded ${activeIds.length} active digest(s) for this world`);

          // Load world graph and build direct lookup index
          const graph = await digestEngine.loadWorldGraph();
          if (graph) {
            console.log(`${MODULE_ID} | World graph loaded — lookup index ready`);
          } else {
            // No world graph on disk — rebuild from active digests
            console.log(`${MODULE_ID} | No world graph found — rebuilding from active digests...`);
            await digestEngine.rebuildWorldGraph(activeIds);
          }

          // Give SceneContext access to digest engine for location resolution
          if (sceneCtx) sceneCtx.setDigestEngine(digestEngine);
        }
      }

      // Build BM25 search corpus for document retrieval
      if (stats.totalChunks > 0) {
        try {
          aceMemory.documents.buildBM25Corpus();
          console.log(`${MODULE_ID} | BM25 corpus ready`);
        } catch (err) {
          console.warn(`${MODULE_ID} | BM25 corpus build failed (will retry on first search):`, err);
        }
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Document engine failed:`, err);
      documentEngine = null;
    }
  } else if (!libEnabled) {
    console.log(`${MODULE_ID} | Document library disabled by settings.`);
  }

  // ── Simple Calendar Bridge (optional) ─────────────────────
  if (aceMemory && SimpleCalendarBridge.shouldSync()) {
    try {
      calendarBridge = new SimpleCalendarBridge(aceMemory);
      calendarBridge.activate();
      aceMemory.setCalendarBridge(calendarBridge);
      console.log(`${MODULE_ID} | Simple Calendar bridge activated.`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Simple Calendar bridge failed:`, err);
      calendarBridge = null;
    }
  } else if (SimpleCalendarBridge.isAvailable() && !SimpleCalendarBridge.isEnabled()) {
    console.log(`${MODULE_ID} | Simple Calendar detected but sync disabled in settings.`);
  }

  // ── Subtle Rolls — blind skill checks with AI narration ───
  const subtleEnabled = game.settings.get(MODULE_ID, "enableSubtleRolls");
  if (subtleEnabled) {
    try {
      subtleRolls = new SubtleRollManager(aiProvider, sceneCtx, npcMemory, aceMemory);
      if (game.settings.get(MODULE_ID, "subtleRollAutoDetect")) {
        subtleRolls.startAutoDetect();
      }
      console.log(`${MODULE_ID} | Subtle Rolls initialized (auto-detect: ${game.settings.get(MODULE_ID, "subtleRollAutoDetect")})`);
    } catch (err) {
      console.error(`${MODULE_ID} | Subtle Rolls failed to initialize:`, err);
      subtleRolls = null;
    }
  } else {
    console.log(`${MODULE_ID} | Subtle Rolls disabled by settings.`);
  }

  // ── Vault Engine — cross-campaign archival + Legacy Ledger ──
  if (aceMemory) {
    try {
      vaultEngine = new VaultEngine(aceMemory);
      vaultSearch = new VaultSearch();
      const worlds = await vaultSearch.discoverWorlds();
      const ledger = await vaultEngine.loadLedger();
      console.log(`${MODULE_ID} | Vault initialized (${worlds.length} archived world(s), ${ledger.campaigns?.length ?? 0} ledger entries)`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Vault init failed (non-critical):`, err);
      vaultEngine = null;
      vaultSearch = null;
    }
  }

  // ── Scene Intelligence — per-scene deep knowledge cache ──────
  if (documentEngine || worldBible) {
    try {
      sceneIntelligence = new SceneIntelligence({
        documentEngine,
        worldBible,
        digestEngine,
      });
      console.log(`${MODULE_ID} | Scene Intelligence initialized`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Scene Intelligence init failed (non-critical):`, err);
      sceneIntelligence = null;
    }
  }

  const api = {
    openPanel,
    getPanel:        () => panel,
    getSceneContext: () => sceneCtx.gather(),
    ask:             (prompt) => aiProvider.chat(prompt, sceneCtx.gather()),
    getAiProvider:   () => aiProvider,
    getSceneCtx:     () => sceneCtx,
    getNpcMemory:    () => npcMemory,
    getAceMemory:    () => aceMemory,
    logNote:         (text) => aceMemory?.logNote(text),
    backupMemory:    () => aceMemory?.backup(),
    backupDigests:   () => digestEngine?.backupDigests(5),
    restoreDigests:  (bundle) => digestEngine?.restoreFromBackup(bundle),
    getMemoryManager: () => aceMemory,
    triggerSfx:      (effect) => _triggerSfx(effect),
    stopSfx:         () => stopAllSfx(),
    getSubtleRolls:  () => subtleRolls,

    /** Clear all Envoy conversation history from NPC actors.
     *  Usage: `ace.clearEnvoyMemory()` — wipes memoryLog flags from ALL NPC actors.
     *  Pass a single Actor or array to target specific NPCs:
     *    `ace.clearEnvoyMemory(game.actors.getName("Lich"))` */
    clearEnvoyMemory: async (targets) => {
      if (!game.user.isGM) { ui.notifications?.warn("GM only."); return; }
      const actors = targets
        ? (Array.isArray(targets) ? targets : [targets])
        : game.actors.filter(a => a.type === "npc" && a.getFlag("ace-envoy", "memoryLog")?.length);

      if (!actors.length) {
        ui.notifications?.info("ACE: No NPC conversation data found to clear.");
        return;
      }

      const names = actors.map(a => a.name);
      const confirm = await Dialog.confirm({
        title:   "Clear Envoy Conversation Data",
        content: `<p>This will erase conversation history from <strong>${actors.length}</strong> NPC(s):</p>` +
                 `<p style="color:#e06060;font-style:italic;">${names.join(", ")}</p>` +
                 `<p>This cannot be undone. Continue?</p>`,
      });
      if (!confirm) return;

      let cleared = 0;
      for (const actor of actors) {
        try {
          await actor.unsetFlag("ace-envoy", "memoryLog");
          cleared++;
          console.log(`${MODULE_ID} | Cleared Envoy memory for: ${actor.name}`);
        } catch (err) {
          console.error(`${MODULE_ID} | Failed to clear Envoy memory for ${actor.name}:`, err);
        }
      }
      ui.notifications?.info(`ACE: Cleared conversation history from ${cleared} NPC(s).`);
    },

    /**
     * Generate a retroactive session summary for a past date.
     * Usage: `ace.retroSummary("2026-03-10")`
     * @param {string} dateStr  ISO date like "2026-03-10"
     */
    retroSummary: async (dateStr) => {
      if (!game.user.isGM) { ui.notifications?.warn("GM only."); return; }
      if (!aceMemory || !aiProvider) {
        ui.notifications?.error("ACE: Memory or AI provider not available.");
        return;
      }
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        ui.notifications?.warn('ACE: Provide a date like "2026-03-10"');
        return;
      }

      ui.notifications?.info(`ACE: Generating retroactive summary for ${dateStr}…`);
      try {
        const { summary, sceneLabel, partyNames } = await aceMemory.generateRetroactiveSummary(
          dateStr, aiProvider, sceneCtx
        );
        if (!summary) {
          ui.notifications?.warn("ACE: No summary could be generated.");
          return;
        }
        const sessionNum = aceMemory.getNextSessionNum();
        await aceMemory.saveSessionSummary({
          sessionNum,
          date:       dateStr,
          sceneName:  sceneLabel,
          summary,
          partyNames: partyNames ? partyNames.split(", ") : [],
        });
        ui.notifications?.info(`ACE: Session ${sessionNum} summary for ${dateStr} saved to journal!`);
        console.log(`${MODULE_ID} | Retroactive session ${sessionNum} (${dateStr}):\n${summary}`);
      } catch (err) {
        console.error(`${MODULE_ID} | retroSummary error:`, err);
        ui.notifications?.error(`ACE: ${err.message}`);
      }
    },

    // ── Vault API ──────────────────────────────────────────────
    getVaultEngine:  () => vaultEngine,
    getVaultSearch:  () => vaultSearch,

    /**
     * Create a vault snapshot (backup all stores).
     * Usage: `ace.vaultSnapshot()`
     */
    vaultSnapshot: async () => {
      if (!game.user.isGM) { ui.notifications?.warn("GM only."); return; }
      if (!vaultEngine) { ui.notifications?.warn("ACE: Vault engine not available."); return; }
      ui.notifications?.info("ACE: Creating vault snapshot…");
      const ok = await vaultEngine.createSnapshot();
      if (ok) ui.notifications?.info("ACE: Vault snapshot saved!");
      else ui.notifications?.error("ACE: Vault snapshot failed — see console.");
    },

    /**
     * Close this campaign — generate AI summary, archive to Legacy Ledger.
     * Usage: `ace.closeCampaign()`
     */
    closeCampaign: async () => {
      if (!game.user.isGM) { ui.notifications?.warn("GM only."); return; }
      if (!vaultEngine || !aiProvider) { ui.notifications?.warn("ACE: Vault or AI not available."); return; }

      const confirm = await Dialog.confirm({
        title:   "Close Campaign",
        content: `<p>This will generate an AI summary of your entire campaign and archive it to the <strong>Legacy Ledger</strong>.</p>` +
                 `<p>Your vault data will be permanently saved. You can still access this world afterward.</p>` +
                 `<p>Continue?</p>`,
      });
      if (!confirm) return;

      ui.notifications?.info("ACE: Generating campaign summary — this may take a moment…");
      const entry = await vaultEngine.closeCampaign(async (sys, user) => {
        let text = "";
        await aiProvider.chat(user, "", sys, [], (chunk) => { text += chunk; });
        return text;
      });

      if (entry) {
        ui.notifications?.info(`ACE: Campaign "${entry.worldName}" archived to Legacy Ledger!`);
      } else {
        ui.notifications?.error("ACE: Campaign close failed — see console.");
      }
    },

    /**
     * Search across all archived campaigns.
     * Usage: `ace.vaultSearch("who killed the mummy")`
     * @param {string} query
     * @returns {Promise<Array>}
     */
    vaultQuery: async (query) => {
      if (!vaultSearch) return [];
      return vaultSearch.search(query);
    },
  };

  // Expose public API for sister modules (ACE: Envoy, ACE: Trapmaster)
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      ...api,
      getMemory: (category) => aceMemory?.getStore(category)?.getAll() ?? [],
      askAI:     (prompt) => aiProvider?.chat(prompt, "", "", []),
      narrate:   (text) => panel?.narrateText?.(text),
      stopAllAudio: _stopAllAudio,

      // ── Party Reputation API (used by ACE: Envoy) ─────────────────
      /** Get the ReputationEngine instance. */
      getReputationEngine: () => reputationEngine,

      /** Get reputation stats for UI display. */
      getReputationStats: () => reputationEngine?.getStats() ?? null,

      /** Add a party deed. Returns the new deed object. */
      addDeed: async (summary, options = {}) => {
        if (!reputationEngine) return null;
        return reputationEngine.addDeed(summary, options, game.world.id);
      },

      /** Remove a deed by ID. */
      removeDeed: async (deedId) => {
        if (!reputationEngine) return;
        return reputationEngine.removeDeed(deedId, game.world.id);
      },

      /** Set faction standing (e.g. "friendly", "hostile"). */
      setFactionStanding: async (factionId, standing) => {
        if (!reputationEngine) return;
        return reputationEngine.setFactionStanding(factionId, standing, game.world.id);
      },

      /** Get faction standing. */
      getFactionStanding: (factionId) => {
        return reputationEngine?.getFactionStanding(factionId) ?? "neutral";
      },

      /** Set notoriety level ("unknown"|"local"|"regional"|"continental"|"legendary"). */
      setNotoriety: async (level) => {
        if (!reputationEngine) return;
        return reputationEngine.setNotoriety(level, game.world.id);
      },

      /** Add a party title. */
      addTitle: async (title) => {
        if (!reputationEngine) return;
        return reputationEngine.addTitle(title, game.world.id);
      },

      /**
       * Get what an NPC would know about the party.
       * Returns { knows, source, attitude, knownDeeds, knownTitles, promptText } or null.
       */
      getNpcKnowledge: (npcFactionId, npcLocation) => {
        if (!reputationEngine) return null;
        return reputationEngine.getNpcKnowledge(npcFactionId, npcLocation);
      },

      /**
       * Get the reputation context paragraph for an NPC (for injection into AI prompts).
       * Called by Envoy's conversation.js before building the system prompt.
       * Backwards-compatible — now delegates to getNpcKnowledge.
       */
      getReputationContext: (npcName, npcFaction, npcLocation) => {
        if (!reputationEngine) return "";
        const knowledge = reputationEngine.getNpcKnowledge(npcFaction, npcLocation);
        return knowledge?.promptText ?? "";
      },

      /** Suggest deeds from a session summary (AI-powered, returns suggestions for GM review). */
      suggestDeedsFromSummary: async (summaryText) => {
        if (!reputationEngine || !aiProvider) return [];
        return reputationEngine.suggestDeedsFromSummary(summaryText, aiProvider);
      },

      /** Format suggested deeds as HTML for GM review dialog. */
      formatDeedsForReview: (suggestedDeeds) => {
        if (!reputationEngine) return "";
        return reputationEngine.formatForGmReview(suggestedDeeds);
      },

      /**
       * Log a conversation encounter from Envoy. Auto-creates a deed if significant.
       * Backwards-compatible wrapper for the old logConversationEncounter API.
       */
      logConversationEncounter: ({ actor, playerName, summary }) => {
        // Under the new system, conversation encounters don't auto-create deeds.
        // Deeds are created explicitly by the GM or suggested from session summaries.
        // This is kept for backwards compatibility — it's a no-op now.
        console.log(`${MODULE_ID} | Reputation: conversation encounter logged (${actor?.name ?? "unknown"}) — deed creation now requires GM approval`);
      },

      // ── Profanity Filter API (used by ACE: Envoy) ────────────────
      /**
       * Filter profanity from player text, replacing with fantasy equivalents.
       * @param {string} text
       * @returns {string} Filtered text
       */
      filterProfanity: (text) => {
        try {
          const enabled = game.settings.get(MODULE_ID, "profanityFilter") ?? true;
          return enabled ? filterProfanity(text) : text;
        } catch { return text; }
      },

      /**
       * Build the AI profanity prompt for system message injection.
       * @param {Object} [worldBible] - World Bible data
       * @param {string} [region] - Current region name
       * @returns {string}
       */
      buildProfanityPrompt: (worldBible, region) => {
        try {
          const enabled = game.settings.get(MODULE_ID, "profanityFilter") ?? true;
          return enabled ? buildProfanityPrompt(worldBible, region) : "";
        } catch { return ""; }
      },

      // ── Subtle Rolls API (used by ACE: Envoy) ──────────────────
      /**
       * Request a subtle (blind) skill check from a player.
       * Called by Envoy when an NPC AI emits a [SUBTLE_CHECK:...] tag.
       * @param {{ actorId: string, skill: string, dc: number, flavor: string }} opts
       */
      requestSubtleRoll: (opts) => {
        if (!subtleRolls) {
          console.warn(`${MODULE_ID} | Subtle Rolls not initialized — cannot request roll.`);
          return;
        }
        // Find the player who owns this actor
        const actor = game.actors?.get(opts.actorId);
        if (!actor) { console.warn(`${MODULE_ID} | requestSubtleRoll: actor not found`); return; }
        const ownerUser = game.users?.find(u => !u.isGM && actor.testUserPermission(u, "OWNER"));
        if (!ownerUser) { console.warn(`${MODULE_ID} | requestSubtleRoll: no player owner found`); return; }
        return subtleRolls.requestRoll({
          targetUserId: ownerUser.id,
          actorId: opts.actorId,
          skill: opts.skill,
          dc: opts.dc,
          flavor: opts.flavor ?? "",
        });
      },

      getSubtleRolls: () => subtleRolls,

      // ── Fame / Deed API ────────────────────────────────────────

      /**
       * Log a deed from a sister module (e.g., ACE: Envoy conversation extraction).
       * @param {{ text: string, magnitude: string, scene?: string, pcs?: string[], source?: string }} deed
       */
      logDeed: (deed) => {
        if (!aceMemory) return null;
        return aceMemory.logDeed(deed);
      },

      /**
       * Get the fame context paragraph for an NPC (standalone, without reputation).
       * @param {string} npcName
       * @returns {string}
       */
      getFameContext: (npcName) => {
        return fameEngine?.buildFameContext(npcName, canvas?.scene?.name ?? "") ?? "";
      },

      /** Get current in-game day counter. */
      getDayCounter: () => aceMemory?.getDayCounter() ?? 1,

      /** Get current approximate time of day. */
      getTimeOfDay: () => aceMemory?.getTimeOfDay() ?? "unknown",

      /** Get the Simple Calendar bridge (for display strings / sync state). */
      getCalendarBridge: () => calendarBridge,

      /** Get the fame engine instance (for advanced use). */
      getFameEngine: () => fameEngine,

      /** Get all deeds. */
      getDeeds: () => aceMemory?.getDeeds() ?? [],

      // ── Document Library API (used by ACE: Envoy) ───────────────

      /**
       * Get relevant document context for AI prompt injection.
       * Searches uploaded reference material (PDFs, text, images)
       * and returns formatted text chunks that match the query.
       * Supports conversation-aware search via lastAssistantMsg.
       * @param {string} npcName - NPC name for context
       * @param {string} userMessage - The user's current message/query
       * @param {Object} [options] - Additional options
       * @param {string} [options.lastAssistantMsg] - Last AI/NPC response (for conversation-aware follow-up search)
       * @param {number} [options.maxChars] - Max chars of context to return (default 8000)
       * @returns {string} Formatted reference library context, or ""
       */
      getDocumentContext: async (npcName, userMessage, options = {}) => {
        if (!documentEngine) return "";
        const sceneName = canvas?.scene?.name ?? "";
        const lastMsg = options.lastAssistantMsg ?? "";
        const maxChars = options.maxChars ?? 8000;
        return await documentEngine.buildDocumentContext("", userMessage, sceneName, maxChars, lastMsg, npcName) ?? "";
      },

      /**
       * Get entities discovered during the last document search.
       * Used for cross-store linking — Envoy can look up NPCs/locations
       * mentioned in PDF results to enrich the conversation context.
       * @returns {Object} { rooms: string[], npcs: string[], locations: string[] }
       */
      getLastSearchEntities: () => {
        return documentEngine?.getLastSearchEntities?.() ?? {};
      },

      // ── Digest Direct Lookup API ─────────────────────────────
      // O(1) name-based lookup against the world graph index.
      // No API calls — purely in-memory from pre-built index.

      /**
       * Direct name lookup in the digest world graph.
       * @param {string} name - Entity name (e.g., "Clovin Belview", "Abbey of Saint Markovia")
       * @param {Object} [options] - { category: "NPC"|"Location"|"Faction"|etc, maxResults: 50 }
       * @returns {Array<{category, entry, source, matchType}>}
       */
      digestLookup: (name, options) => {
        return digestEngine?.lookupByName(name, options) ?? [];
      },

      /**
       * Look up multiple names at once, deduplicating across results.
       * @param {string[]} names - Array of entity names
       * @param {Object} [options] - Same as digestLookup
       * @returns {Array<{category, entry, source, matchType, queryName}>}
       */
      digestLookupMultiple: (names, options) => {
        return digestEngine?.lookupMultiple(names, options) ?? [];
      },

      /**
       * Direct lookup + format as AI-ready context text.
       * @param {string} name - Entity name to look up
       * @param {Object} [options] - { maxChars: 4000, category: "NPC"|etc }
       * @returns {string} Formatted lookup context, or ""
       */
      digestLookupContext: (name, options = {}) => {
        if (!digestEngine?.hasLookupIndex) return "";
        const maxChars = options.maxChars ?? 4000;
        const results = digestEngine.lookupByName(name, options);
        if (!results.length) return "";
        const { text } = digestEngine.formatLookupResults(results, maxChars);
        return text;
      },

      /** Get the digest engine instance. */
      getDigestEngine: () => digestEngine,

      /**
       * Connected lookup: entity + location + faction + NPCs at location + Envoy history.
       * @param {string} name - Entity name
       * @param {Object} [options] - { maxConnected: 5, includeEnvoy: true, category, maxResults }
       * @returns {{primary: Array, connected: Array, envoyContext: string}}
       */
      digestLookupWithConnections: (name, options) => {
        return digestEngine?.lookupWithConnections(name, options) ?? { primary: [], connected: [], envoyContext: "" };
      },

      /** Get all NPCs at a given location (reverse index). */
      getNPCsAtLocation: (locationName) => digestEngine?.getNPCsAtLocation(locationName) ?? [],

      /** Get all NPC members of a faction (reverse index). */
      getFactionMembers: (factionName) => digestEngine?.getFactionMembers(factionName) ?? [],

      /** Get pre-loaded NPC data for the current scene (instant, no lookup). */
      getPreloadedSceneNPC: (name) => sceneCtx?.getPreloadedNPC(name) ?? null,

      /** Get recent digest lookup summaries for context continuity. */
      getRecentDigestContext: () => digestEngine?.getRecentContext() ?? { text: "", names: [] },

      /** Get index statistics for debugging. */
      getDigestStats: () => digestEngine?.getIndexStats() ?? {},

      /**
       * Get relevant images from the document library for multimodal AI.
       * Returns base64-encoded images matching the query keywords.
       * @param {string} userMessage - Query to match against image tags/labels
       * @returns {Promise<Array<{base64: string, mimeType: string}>>}
       */
      getRelevantImages: async (userMessage) => {
        if (!documentEngine) return [];
        const { loadImageAsBase64 } = await import("./document-engine.mjs");
        const refs = documentEngine.getRelevantImages(userMessage, "", 2);
        const images = await Promise.all(
          refs.map(async (r) => {
            try { return await loadImageAsBase64(r.path); }
            catch (err) { console.debug("ace-engine | API vision image load failed:", err); return null; }
          })
        );
        return images.filter(Boolean);
      },

      /** Get the document engine instance (for advanced use). */
      getDocumentEngine: () => documentEngine,

      // ── World Bible API (used by ACE: Envoy) ─────────────────

      /**
       * Get city context from the World Bible for AI prompt injection.
       * Returns formatted text about the city, its nation, local factions, and religions.
       * @param {string} cityName - City name (case-insensitive)
       * @returns {string} Formatted world context, or ""
       */
      getWorldBibleCityContext: (cityName, npcName) => {
        if (!worldBible?.hasData) return "";
        let ctx = worldBible.getCityContext(cityName);
        // If NPC name provided, also search for NPC-specific context
        if (npcName && !ctx) {
          ctx = worldBible.search(`${npcName} ${cityName}`, 3);
        }
        return ctx ?? "";
      },

      /**
       * Search the World Bible for any matching entity.
       * @param {string} query
       * @param {number} [maxResults=5]
       * @returns {string} Formatted search results
       */
      searchWorldBible: (query, maxResults = 5) => {
        if (!worldBible?.hasData) return "";
        return worldBible.search(query, maxResults);
      },

      /**
       * Get full faction details from the World Bible.
       * @param {string} factionName
       * @returns {string}
       */
      getWorldBibleFaction: (factionName) => {
        if (!worldBible?.hasData) return "";
        return worldBible.getFactionContext(factionName);
      },

      /**
       * Look up any entity by name in the World Bible.
       * @param {string} name
       * @returns {{ type, id, data }|null}
       */
      findInWorldBible: (name) => {
        if (!worldBible?.hasData) return null;
        return worldBible.findByName(name);
      },

      /** Get stats about the loaded World Bible. */
      getWorldBibleStats: () => worldBible?.getStats() ?? null,

      /** Get the World Bible engine instance (for advanced use). */
      getWorldBible: () => worldBible,

      /**
       * Generate a World Bible. Called from the panel UI.
       * @param {string} setting - e.g. "Forgotten Realms — Faerûn"
       * @param {string} era - e.g. "Post-Sundering (5e, ~1489-1496 DR)"
       * @param {function} onProgress - (step, total, regionName, phase) callback
       */
      generateWorldBible: async (setting, era, onProgress) => {
        if (!worldBible || !aiProvider) {
          throw new Error("World Bible engine or AI provider not initialized.");
        }
        return worldBible.generate(setting, era, aiProvider, game.world.id, onProgress);
      },

      /** Pause an in-progress World Bible generation. */
      pauseWorldBible: () => worldBible?.pauseGeneration(),

      /** Resume a paused World Bible generation. */
      resumeWorldBible: () => worldBible?.resumeGeneration(),

      /** Cancel an in-progress World Bible generation (saves progress). */
      cancelWorldBible: () => worldBible?.cancelGeneration(),

      /**
       * Auto-resolve an unknown scene/location name via AI lookup.
       * Caches the result permanently in the World Bible.
       * Returns formatted context string, or "" if not found.
       * @param {string} locationName
       * @returns {Promise<string>}
       */
      resolveWorldBibleLocation: async (locationName, npcName) => {
        if (!worldBible?.hasData || !aiProvider) return "";
        // Include NPC name in the resolution query for better matching
        const query = npcName ? `${npcName} ${locationName}` : locationName;
        return worldBible.resolveLocation(query, aiProvider, game.world.id);
      },

      /**
       * Merge a digest's extracted data into the World Bible.
       * Runs 5 focused AI calls (locations, factions, NPCs, religions, geography).
       * @param {object} digestData  - Full digest object ({ summary, npcs, locations, factions, ... })
       * @param {string} sourceName  - Display name (e.g. "Curse of Strahd")
       * @param {string} sourceFile  - Filename (e.g. "curse_of_strahd.pdf")
       * @param {function} onProgress - (step, total, category, phase) callback
       * @returns {Promise<{ merged: number, updated: number, errors: string[] }>}
       */
      mergeDigestIntoBible: async (digestData, sourceName, sourceFile, onProgress, publishedYear = null) => {
        if (!worldBible?.hasData || !aiProvider) {
          throw new Error("World Bible must be generated before merging digests. Generate a Bible first.");
        }
        return worldBible.mergeFromDigest(digestData, sourceName, sourceFile, aiProvider, game.world.id, onProgress, publishedYear);
      },

      /**
       * Supplement-merge: runs ONLY the 4 new category passes (cultures, trade,
       * power structures, demographics, threats, landmarks, current events)
       * on an already-merged digest. Use this to backfill existing digests that
       * were merged before the expanded Bible schema.
       */
      supplementMergeDigest: async (digestData, sourceName, sourceFile, onProgress, publishedYear = null) => {
        if (!worldBible?.hasData || !aiProvider) {
          throw new Error("World Bible must be generated before supplement-merging. Generate a Bible first.");
        }
        return worldBible.supplementMerge(digestData, sourceName, sourceFile, aiProvider, game.world.id, onProgress, publishedYear);
      },

      /**
       * Run supplement merge on ALL existing digests that are active in this world.
       * Iterates every digest, loads its data, and runs the 4 new category passes.
       * @param {function} onProgress - (digestName, digestIndex, totalDigests, step, totalSteps) callback
       * @returns {Promise<{ results: Object[], errors: string[] }>}
       */
      supplementMergeAll: async (onProgress) => {
        if (!worldBible?.hasData || !aiProvider) {
          throw new Error("World Bible must exist before supplement-merging.");
        }
        if (!digestEngine) {
          throw new Error("Digest engine not available.");
        }
        const allDigests = digestEngine.getAllDigests();
        const results = [];
        const errors = [];
        for (let i = 0; i < allDigests.length; i++) {
          const meta = allDigests[i];
          try {
            const digestData = await digestEngine.loadDigest(meta.id);
            if (!digestData) {
              errors.push(`${meta.name ?? meta.id}: digest data not found`);
              continue;
            }
            console.log(`${MODULE_ID} | Supplement merge ${i + 1}/${allDigests.length}: ${meta.name ?? meta.id}`);
            const digest = digestData.digest ?? digestData;
            const result = await worldBible.supplementMerge(
              digest, meta.name ?? meta.id, meta.sourceFile ?? meta.id,
              aiProvider, game.world.id,
              (step, total, cat, phase) => {
                if (onProgress) onProgress(meta.name ?? meta.id, i + 1, allDigests.length, step, total, cat, phase);
              },
              meta.publishedYear ?? null
            );
            results.push({ name: meta.name ?? meta.id, ...result });
          } catch (err) {
            console.error(`${MODULE_ID} | Supplement merge failed for ${meta.name ?? meta.id}:`, err);
            errors.push(`${meta.name ?? meta.id}: ${err.message}`);
          }
        }
        return { results, errors };
      },

      learnFromText: async (text) => {
        if (!worldBible?.hasData || !aiProvider) return { learned: 0, skipped: 0 };
        return worldBible.learnFromText(text, aiProvider, game.world.id);
      },

      // ── Scene Intelligence API (used by ACE: Envoy) ────────────
      /**
       * Get deep scene intelligence for a scene. Cached per scene (5min TTL).
       * Returns factions, NPCs, deities, cultural context, nearby locations
       * from the full search pipeline (document library + World Bible + cross-refs).
       *
       * @param {string} [sceneName] — Scene name (default: current scene)
       * @param {string} [sceneId] — Scene ID (default: current scene)
       * @returns {Promise<Object>} SceneIntelligence data
       */
      getSceneIntelligence: async (sceneName, sceneId) => {
        if (!sceneIntelligence) return null;
        return sceneIntelligence.getIntelligence(
          sceneId || canvas?.scene?.id || "",
          sceneName || canvas?.scene?.name || ""
        );
      },

      /**
       * Get scene intelligence formatted as a text block for AI prompt injection.
       * @param {string} [sceneName]
       * @param {string} [sceneId]
       * @returns {Promise<string>}
       */
      getSceneIntelligencePrompt: async (sceneName, sceneId, npcName) => {
        if (!sceneIntelligence) return "";
        const intel = await sceneIntelligence.getIntelligence(
          sceneId || canvas?.scene?.id || "",
          sceneName || canvas?.scene?.name || ""
        );
        let prompt = sceneIntelligence.formatForPrompt(intel);
        // If NPC name provided, append digest lookup for NPC-specific context
        if (npcName && digestEngine?.hasLookupIndex) {
          const npcResults = digestEngine.lookupByName(npcName, { category: "NPC", maxResults: 5 });
          if (npcResults.length) {
            const { text } = digestEngine.formatLookupResults(npcResults, 1500);
            if (text) prompt += `\n\n${text}`;
          }
        }
        return prompt;
      },

      /**
       * Invalidate scene intelligence cache (e.g., when a new document is uploaded).
       * @param {string} [sceneId] — Specific scene, or omit to clear all
       */
      invalidateSceneIntelligence: (sceneId) => {
        sceneIntelligence?.invalidate(sceneId);
      },

      /** Get the SceneIntelligence instance (for advanced use). */
      getSceneIntelligenceEngine: () => sceneIntelligence,
    };
  }

  // Make the full API available as window.ace for GM macros and console use
  window.ace = game.modules.get(MODULE_ID)?.api ?? api;

  _aceReady = true;
  console.log(`${MODULE_ID} | Ready. Open via: Ctrl+Shift+L, scene controls, or ace.openPanel()`);

  // Retry toolbar injection — catches cases where renderSceneControls fires
  // before the DOM is fully built, or for late-loading scenes.
  setTimeout(_injectAceControl, 1000);
  setTimeout(_injectAceControl, 3000);

  if (game.settings.get(MODULE_ID, "autoSuggestions")) {
    suggestionEngine.start();
  }

  // ── First-run setup wizard ──────────────────────────────────
  // Show a friendly guided setup if this is the first time ACE is used in this world.
  try {
    const setupDone = game.settings.get(MODULE_ID, "setupComplete");
    if (!setupDone) {
      setTimeout(async () => {
        const result = await AceSettings.showSetupWizard();
        if (result) {
          // User completed setup — refresh provider config
          aiProvider?.refreshConfig();
          console.log(`${MODULE_ID} | Setup wizard completed — provider: ${aiProvider?.config?.provider}`);
        }
      }, 1500);  // slight delay so the UI has settled
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Setup wizard check failed:`, err);
  }

  // ── Auto-discover PCs, scene NPCs, and [AI Memory] journals ────
  // Run after a short delay so the canvas has time to fully initialize
  setTimeout(() => _autoDiscoverAndSync(), 2000);

  // ── Periodic auto-backup (every 30 minutes while Foundry is running) ──
  if (aceMemory) {
    aceMemory._autoBackupInterval = setInterval(() => {
      if (game.user.isGM) {
        // Back up all memory stores (NPCs, deeds, history, documents, etc.)
        aceMemory.autoBackup().catch(err =>
          console.warn(`${MODULE_ID} | Periodic auto-backup failed:`, err)
        );
        // Also back up AI-generated digests (separate global storage)
        if (digestEngine) {
          digestEngine.backupDigests(5).catch(err =>
            console.warn(`${MODULE_ID} | Periodic digest backup failed:`, err)
          );
        }
      }
    }, 30 * 60 * 1000); // 30 minutes
  }
});

// ── SFX: play locally + broadcast to all other clients ─────────
// targetUserId: if set, only that player hears it (GM always hears on their own screen)
function _triggerSfx(effect, targetUserId = null) {
  _handleRemoteSfx({ effect });                                       // play on GM screen
  game.socket.emit(`module.${MODULE_ID}`, { type: "sfx", effect, userId: game.user.id, targetUserId });
}

function _handleRemoteSfx({ effect }) {
  switch (effect) {
    case "lightning":       triggerLightning();       break;
    case "earthquake":      triggerEarthquake();      break;
    case "stealthFail":     triggerStealthFail();     break;
    case "perceptionPass":  triggerPerceptionPass();  break;
    // Laugh variants dormant — uncomment when adding a dedicated SFX panel:
    // case "laughMale":     playEvilLaugh("male");     break;
    // case "laughFemale":   playEvilLaugh("female");   break;
    // case "laughCreature": playEvilLaugh("creature"); break;
  }
}

// ── Auto-Discovery: PCs, NPCs, [AI Memory] journals ──────────────

/**
 * Scan the world for PCs, scene NPCs, and old [AI Memory] journals,
 * register them in the memory system, and create organized journal entries.
 */
async function _autoDiscoverAndSync() {
  if (!aceMemory) return;

  try {
    // 1. Discover all player-owned characters → PC store + journals
    // Filter out junk: tokens without real character names (map tokens, downloads, test actors)
    const JUNK_PC_RE = /^(group\s*map|download|test|template|copy\s*of)/i;
    const pcs = (game.actors?.filter(a => a.hasPlayerOwner && a.type === "character") ?? [])
      .filter(a => a.name && !JUNK_PC_RE.test(a.name.trim()) && a.name.trim().length > 1);
    for (const actor of pcs) {
      aceMemory.pcs.touchPc(actor.id, actor.name);
      // Extract class/level if available
      const rec = aceMemory.pcs.getRecord(actor.id);
      if (rec) {
        rec.class = rec.class || aceMemory._extractClass(actor);
        rec.level = rec.level || aceMemory._extractLevel(actor);
      }
    }
    // Increment session count for each PC (once per world load)
    for (const actor of pcs) {
      aceMemory.logSession({ actorName: actor.name });
    }

    if (pcs.length) {
      aceMemory.pcs.markDirty();
      aceMemory.saveCategory("pcs");
    }

    // 2. Discover scene NPCs → NPC store
    _discoverSceneNpcs();

    // 3. Import [AI Memory] journals into ACE's NPC store
    const aiMemoryJournals = game.journal?.contents?.filter(j => j.name.startsWith("[AI Memory]")) ?? [];
    for (const journal of aiMemoryJournals) {
      const npcName = journal.name.replace("[AI Memory]", "").trim();
      if (!npcName) continue;

      // Touch the NPC so it exists in the store
      aceMemory.npcs.touchNpc(npcName, canvas?.scene?.name ?? "");

      // Extract journal content as a note
      const pages = journal.pages?.contents ?? [];
      const content = pages
        .filter(p => p.type === "text")
        .map(p => {
          const html = p.text?.content ?? "";
          const div = document.createElement("div");
          div.innerHTML = html;
          return div.textContent?.trim() ?? "";
        })
        .filter(Boolean)
        .join("\n\n");

      if (content) {
        // Add as a note if not already present
        const existing = aceMemory.npcs.getRecord(npcName);
        const hasImportNote = existing?.notes?.some(n => n.txt?.startsWith("[Imported]"));
        if (!hasImportNote) {
          aceMemory.npcs.addNote(npcName, `[Imported] ${content.slice(0, 500)}`);
        }
      }
    }
    if (aiMemoryJournals.length) {
      aceMemory.npcs.markDirty();
      aceMemory.saveCategory("npcs");
    }

    // 4. Sync all known records to organized journal folders (📖 ACE / NPC, PC, etc.)
    const count = await aceMemory.syncAllJournals();
    if (count > 0) {
      console.log(`${MODULE_ID} | Auto-discovery: synced ${count} journal entries into 📖 ACE folders`);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | Auto-discovery failed:`, err);
  }
}

/**
 * Discover NPCs on the current scene canvas and register them in the NPC store.
 */
function _discoverSceneNpcs() {
  if (!aceMemory || !canvas?.scene) return;

  const sceneName = canvas.scene.name ?? "";
  const tokens = canvas.tokens?.placeables ?? [];
  let found = 0;

  for (const token of tokens) {
    const actor = token.actor;
    if (!actor) continue;

    // Skip player-owned tokens
    if (actor.hasPlayerOwner) continue;

    const name = token.name || actor.name;
    if (!name) continue;

    // Register the NPC in the store
    aceMemory.npcs.touchNpc(name, sceneName);

    // Enrich with actor data if available
    const rec = aceMemory.npcs.getRecord(name);
    if (rec && actor) {
      if (!rec.actorId) rec.actorId = actor.id;
      if (!rec.type || rec.type === "unknown") rec.type = actor.type ?? "npc";
      if (!rec.race) {
        try {
          rec.race = actor.system?.details?.race?.name
                  ?? actor.system?.details?.race
                  ?? actor.system?.details?.ancestry?.name
                  ?? "";
        } catch (_) {}
      }
      if (!rec.class) {
        try {
          rec.class = actor.system?.details?.type?.value
                   ?? actor.system?.details?.class
                   ?? "";
        } catch (_) {}
      }
    }

    // ── Reputation awareness check ────────────────────────────
    // See if this NPC's faction has heard of the PCs (word-of-mouth)
    if (reputationEngine) {
      try {
        if (typeof reputationEngine.checkNpcAwareness === "function") {
          const result = reputationEngine.checkNpcAwareness(name, actor);
          if (result) {
            console.log(`${MODULE_ID} | Reputation: ${name} is ${result.level} of PCs (awareness: ${(result.awareness * 100).toFixed(0)}%)`);
          }
        }
      } catch (err) {
        // Non-critical — reputation check is optional
      }
    }

    found++;
  }

  if (found) {
    aceMemory.npcs.markDirty();
    aceMemory.saveCategory("npcs");
  }
}

// ── Scene & Combat awareness ───────────────────────────────────
let _lastSceneName = null;  // track scene transitions for memory

Hooks.on("canvasReady", () => {
  if (!game.user.isGM || !sceneCtx) return;
  sceneCtx.refresh();
  // Enhancement 3: Pre-load digest entries for all NPC tokens on scene
  sceneCtx.preloadSceneEntities();
  CanvasHighlight.clearAll();   // remove any lingering highlights from previous scene
  // Apply subtle gold glow to PC tokens so they're easy to spot
  if (game.settings.get(MODULE_ID, "pcGlow")) {
    setTimeout(() => CanvasHighlight.refreshAllPcGlows(), 500);  // short delay for tokens to finish drawing
  }
  if (panel?.rendered) {
    panel.updateContext();
    panel.trackSceneTransition();   // advance survival tracker on scene change
    panel.refreshSelectPanel();     // refresh Select panel for new scene
  }
  // Re-inject toolbar button on scene changes (controls re-render)
  _injectAceControl();

  // Pre-warm scene intelligence cache for the new scene (async, non-blocking)
  if (sceneIntelligence) {
    sceneIntelligence.getIntelligence().catch(() => {});
  }

  // ── Log scene transition to memory ──────────────────────────
  const newScene = canvas?.scene?.name ?? null;
  if (aceMemory && newScene && newScene !== _lastSceneName) {
    const isInitialLoad = !_lastSceneName;
    if (!isInitialLoad) {
      // Only log actual scene transitions (not the first load on startup)
      aceMemory.logSceneChange(_lastSceneName, newScene);
      // Increment reputation scene counter on each genuine scene transition
      if (reputationEngine && typeof reputationEngine.incrementSceneCounter === "function") reputationEngine.incrementSceneCounter();
    }
    _lastSceneName = newScene;

    // ── Track scene visit for all PCs ─────────────────────────
    try {
      const pcs = game.actors?.filter(a => a.hasPlayerOwner && a.type === "character") ?? [];
      for (const pc of pcs) {
        const rec = aceMemory.pcs.touchPc(pc.id, pc.name);
        if (rec) {
          if (!Array.isArray(rec.scenes)) rec.scenes = [];
          if (!rec.scenes.includes(newScene)) {
            rec.scenes.push(newScene);
            if (rec.scenes.length > 100) rec.scenes.shift();
          }
          // Fix firstSeen if it was never set
          if (!rec.firstSeen) rec.firstSeen = Math.floor(Date.now() / 1000);
        }
      }
      aceMemory.pcs.markDirty();
    } catch (_) {}

    // ── Deed: first visit to a new scene (travel tracking) ────
    if (fameEngine) {
      // Check if scene was visited before (use SceneStore)
      const sceneRec = aceMemory.scenes?.getRecord(newScene);
      const visitCount = sceneRec?.visitCount ?? 0;
      if (visitCount === 1) {  // first visit (visitCount was just incremented by logSceneChange)
        aceMemory.logDeed({
          text:      `Arrived in ${newScene}`,
          magnitude: "trivial",
          scene:     newScene,
          pcs:       (game.actors?.filter(a => a.hasPlayerOwner && a.type === "character") ?? []).map(a => a.name),
          source:    "auto:travel",
        });
      }
    }

    // ── Narrative time: advance one step on scene transition ──
    if (!isInitialLoad && game.settings.get(MODULE_ID, "enableNarrativeTime")) {
      aceMemory.advanceTimeStep();
    }
  }

  // ── Discover NPCs on the new scene ──────────────────────────
  // Delayed slightly to ensure tokens are fully loaded
  setTimeout(() => {
    _discoverSceneNpcs();
    // Write journals for any newly discovered NPCs
    if (aceMemory) {
      for (const rec of aceMemory.npcs.getAll()) {
        if (rec.displayName) {
          aceMemory.writeNpcJournal(rec.displayName).catch(() => {});
        }
      }
    }
  }, 1000);
});

Hooks.on("createCombat", (combat) => {
  if (!game.user.isGM || !aceMemory) return;
  aceMemory.logCombatStart(canvas?.scene?.name ?? "");
  if (panel?.rendered) panel.refreshSelectPanel();  // show initiative section
});

Hooks.on("deleteCombat", (combat) => {
  if (!game.user.isGM || !aceMemory) return;
  // Gather participant names from the just-deleted combat
  const participants = combat.turns?.map((c) => c.name).filter(Boolean) ?? [];
  aceMemory.logCombatEnd(participants, canvas?.scene?.name ?? "");

  // ── Reputation: log faction encounter events ──────────────
  if (reputationEngine) {
    try {
      const pcNames = [];
      const npcData = [];

      for (const combatant of (combat.turns ?? [])) {
        const actor = combatant.actor ?? combatant.token?.actor;
        if (!actor) continue;

        if (actor.hasPlayerOwner) {
          pcNames.push(combatant.name);
        } else {
          const factionKey = typeof reputationEngine.resolveFactionKey === "function"
            ? reputationEngine.resolveFactionKey(actor) : null;
          if (factionKey) {
            const hp = actor.system?.attributes?.hp;
            const isKilled = (hp?.value ?? 1) <= 0;
            // Extract NPC ability scores for spread quality calculation
            const abilities = actor.system?.abilities;
            const npcStats = abilities ? {
              int: abilities.int?.value ?? 10,
              wis: abilities.wis?.value ?? 10,
              cha: abilities.cha?.value ?? 10,
            } : null;
            npcData.push({
              name:       combatant.name,
              factionKey,
              outcome:    isKilled ? "killed" : "survived",
              npcStats,
            });
          }
        }
      }

      // Group by faction and log one event per faction
      const byFaction = {};
      for (const npc of npcData) {
        (byFaction[npc.factionKey] ??= []).push(npc);
      }

      for (const [factionKey, npcs] of Object.entries(byFaction)) {
        const anyKilled   = npcs.some(n => n.outcome === "killed");
        const anySurvived = npcs.some(n => n.outcome === "survived");
        const outcome     = anySurvived ? "survived" : "killed";
        const kind        = anyKilled   ? "kill"     : "combat";
        const names       = npcs.map(n => n.name).join(", ");

        // Pick the best communicator (highest INT or CHA) as the spreader
        let bestSpreaderStats = null;
        let bestSpreadScore = 0;
        for (const npc of npcs) {
          if (npc.npcStats && npc.outcome === "survived") {
            const score = Math.max(npc.npcStats.int ?? 10, npc.npcStats.cha ?? 10);
            if (score > bestSpreadScore) {
              bestSpreadScore = score;
              bestSpreaderStats = npc.npcStats;
            }
          }
        }
        // Fallback: use any NPC's stats if none survived
        if (!bestSpreaderStats) {
          bestSpreaderStats = npcs.find(n => n.npcStats)?.npcStats ?? null;
        }

        if (typeof reputationEngine.logEncounter === "function") {
          reputationEngine.logEncounter({
            factionKey,
            kind,
            outcome,
            npcName:  names,
            pcNames,
            scene:    canvas?.scene?.name ?? "",
            summary:  `${kind === "kill" ? "PCs killed" : "PCs fought"} ${names}. ${anySurvived ? "Some survived." : "None survived."}`,
            npcStats: bestSpreaderStats,
            direct:   true,
          });
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Reputation combat logging failed:`, err);
    }
  }

  // Auto-generate session summary if the panel is open and combat had 5+ participants
  if (panel?.rendered && participants.length >= 1) {
    panel.onCombatEnded(combat, participants);
  }
  if (panel?.rendered) panel.refreshSelectPanel();  // hide initiative section
});

Hooks.on("updateCombat", async (combat, changed, options, userId) => {
  if (!game.user.isGM || !sceneCtx) return;
  sceneCtx.refreshCombat(combat);
  if (panel?.rendered) panel.updateContext();
  if (panel?.rendered) panel.refreshTccInitiative();

  if (panel?.rendered && changed && "turn" in changed) {
    const combatant = combat.combatant;
    if (combatant?.actor && !combatant.actor.hasPlayerOwner) {
      // Only auto-suggest tactics for HOSTILE tokens — not friendly/neutral NPCs
      // (allies, companions, summoned creatures, etc. should never get enemy tactics)
      const disposition =
        combatant.token?.disposition ??
        combatant.actor.prototypeToken?.disposition ??
        CONST.TOKEN_DISPOSITIONS.HOSTILE;   // assume hostile if unknown
      if (disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE) {
        setTimeout(() => panel.suggestNpcTactic(combat, combatant), 600);
      }
    }
  }
});

Hooks.on("updateActor", (actor, changes) => {
  if (!game.user.isGM || !sceneCtx) return;
  sceneCtx.refreshActor(actor);
  if (panel?.rendered) panel.updateContext();
  if (panel?.rendered) panel.refreshTccStats();

  // ── Kill detection: HP reaching 0 ─────────────────────────
  if (aceMemory && game.combat?.active) {
    const hp = changes?.system?.attributes?.hp;
    // Handle both dnd5e v3 {value} and v4 nested objects
    const newHp = hp?.value ?? (typeof hp === "number" ? hp : undefined);
    if (newHp === 0) {
      // Best-effort: find the current combatant as the killer
      const killer = game.combat?.combatant?.name ?? null;
      aceMemory.logKill({
        victimName: actor.name,
        killerName: killer !== actor.name ? killer : null,
        scene:      canvas?.scene?.name ?? "",
      });

      // ── Story note: PC delivers killing blow on a significant enemy ──
      if (killer && killer !== actor.name && !actor.hasPlayerOwner) {
        const killerActor = game.actors?.find(a => a.name === killer && a.hasPlayerOwner);
        if (killerActor && _isSignificantKill(actor)) {
          const scene = canvas?.scene?.name ?? "";
          const bullet = scene ? `Slew ${actor.name} in ${scene}` : `Slew ${actor.name}`;
          _appendStoryNote(killerActor, bullet).catch(() => {});

          // ── Deed: significant kill ──────────────────────────────
          if (fameEngine) {
            aceMemory.logDeed({
              text:      bullet,
              magnitude: _estimateKillMagnitude(actor),
              scene,
              pcs:       [killerActor.name],
              source:    "auto:kill",
            });
          }
        }
      }
    }
  }

  // ── PC Level-up detection ─────────────────────────────────
  if (aceMemory && actor.hasPlayerOwner) {
    const levelPath = changes?.system?.details?.level;
    const newLevel  = levelPath != null ? Number(levelPath) : undefined;
    if (newLevel && newLevel > 0) {
      // actor.system.details.level is already updated by the time this hook fires,
      // so compare against the PC store's last-recorded level instead.
      const pcRec    = aceMemory.pcs?.getRecord(actor.id);
      const oldLevel = pcRec?.level ?? null;
      // Only trigger if the level actually increased (not just any update)
      if (oldLevel == null || newLevel > Number(oldLevel)) {
        // Extract class name (dnd5e items of type "class")
        let className = "";
        try {
          const classes = actor.items?.filter(i => i.type === "class");
          if (classes?.length) className = classes.map(c => `${c.name} ${c.system?.levels ?? ""}`).join(" / ");
        } catch (_) {}
        aceMemory.logPcLevelUp({
          actorId:   actor.id,
          actorName: actor.name,
          newLevel,
          className,
          scene: canvas?.scene?.name ?? "",
        });
        console.log(`${MODULE_ID} | PC level-up detected: ${actor.name} -> Level ${newLevel}`);

        // ── Story note: level up ──────────────────────────────
        const levelLabel = className ? `${className}` : `Level ${newLevel}`;
        _appendStoryNote(actor, `Reached ${levelLabel}`).catch(() => {});

        // ── Deed: level up ──────────────────────────────────
        if (fameEngine) {
          aceMemory.logDeed({
            text:      `${actor.name} reached ${levelLabel}`,
            magnitude: _levelUpMagnitude(newLevel),
            scene:     canvas?.scene?.name ?? "",
            pcs:       [actor.name],
            source:    "auto:levelup",
          });
        }
      }
    }
  }

  // ── PC career stats: damage taken, healing received, knockouts ──
  if (actor.hasPlayerOwner && actor.type === "character" && aceMemory) {
    const hp = changes?.system?.attributes?.hp;
    const newHp = hp?.value ?? (typeof hp === "number" ? hp : undefined);
    if (newHp !== undefined) {
      const maxHp   = actor.system?.attributes?.hp?.max ?? 0;
      const prevHp  = actor.system?.attributes?.hp?.value ?? maxHp;
      // Calculate delta: negative = damage, positive = healing
      // Note: prevHp is already updated by the time we see it in v13,
      // so we use the old value from the actor's prior state
      const oldHp = (typeof actor._source?.system?.attributes?.hp?.value === "number")
        ? actor._source.system.attributes.hp.value
        : prevHp;
      const delta = newHp - oldHp;

      if (delta < 0) {
        // Damage taken
        aceMemory.logDamageTaken({ actorName: actor.name, amount: Math.abs(delta) });
      } else if (delta > 0 && oldHp < maxHp) {
        // Healing received (not just temp HP manipulation)
        // Note: this tracks healing received, not healing done
        // Healing done is tracked via the chat message roll
      }

      // Knockout detection
      if (newHp === 0) {
        aceMemory.logKnockout({ actorName: actor.name });

        const scene    = canvas?.scene?.name ?? "";
        const attacker = game.combat?.active ? (game.combat.combatant?.name ?? null) : null;
        let bullet;
        if (attacker && attacker !== actor.name) {
          bullet = scene ? `Fell in battle against ${attacker} in ${scene}` : `Fell in battle against ${attacker}`;
        } else {
          bullet = scene ? `Fell unconscious in ${scene}` : `Fell unconscious`;
        }
        _appendStoryNote(actor, bullet).catch(() => {});
      }
    }
  } else if (actor.hasPlayerOwner && actor.type === "character") {
    // Fallback: no aceMemory, still log story note for knockdowns
    const hp = changes?.system?.attributes?.hp;
    const newHp = hp?.value ?? (typeof hp === "number" ? hp : undefined);
    if (newHp === 0) {
      const scene    = canvas?.scene?.name ?? "";
      const attacker = game.combat?.active ? (game.combat.combatant?.name ?? null) : null;
      let bullet;
      if (attacker && attacker !== actor.name) {
        bullet = scene ? `Fell in battle against ${attacker} in ${scene}` : `Fell in battle against ${attacker}`;
      } else {
        bullet = scene ? `Fell unconscious in ${scene}` : `Fell unconscious`;
      }
      _appendStoryNote(actor, bullet).catch(() => {});
    }
  }
});

Hooks.on("updateToken", () => {
  if (!game.user.isGM || !sceneCtx) return;
  sceneCtx.refresh();
  if (panel?.rendered) {
    panel.updateContext();
    panel.refreshSelectPanel();
  }
});

// Re-apply PC glow after token re-renders (movement, refresh, etc.)
Hooks.on("refreshToken", (token) => {
  if (!game.user.isGM) return;
  try {
    if (game.settings.get(MODULE_ID, "pcGlow")) CanvasHighlight.applyPcGlow(token);
  } catch (_) {}
});

// ── Canvas ↔ Panel selection sync — mirror canvas clicks to the Select panel ──
Hooks.on("controlToken", (token, controlled) => {
  if (!game.user.isGM) return;
  if (panel?.rendered) panel.syncTokenControlled(token, controlled);
});

Hooks.on("controlTile", (tile, controlled) => {
  if (!game.user.isGM) return;
  if (panel?.rendered) panel.syncTileControlled(tile, controlled);
});

// ── Item lifecycle — track acquisitions and losses ──────────
Hooks.on("createItem", (item, options, userId) => {
  if (!game.user.isGM || !aceMemory) return;
  // Only track items added to player-owned characters
  const actor = item.parent;
  if (!actor || !actor.hasPlayerOwner || actor.type !== "character") return;
  // Skip class/feature/spell items — only track "inventory" items
  const skipTypes = new Set(["class", "subclass", "feat", "feature", "spell", "background", "race"]);
  if (skipTypes.has(item.type)) return;
  aceMemory.logItemAcquired({
    actorName: actor.name,
    itemName:  item.name,
    itemType:  item.type ?? "misc",
    rarity:    item.system?.rarity ?? "unknown",
    scene:     canvas?.scene?.name ?? "",
  });
  console.log(`${MODULE_ID} | Item acquired: ${actor.name} got ${item.name}`);

  // ── Story note: rare+ item acquired ──────────────────────
  const rarity = item.system?.rarity ?? "unknown";
  if (_isSignificantItem(rarity)) {
    const rarityLabel = { rare: "rare", veryRare: "very rare", legendary: "legendary", artifact: "artifact" }[rarity] ?? rarity;
    const scene = canvas?.scene?.name ?? "";
    const bullet = scene
      ? `Acquired ${item.name} (${rarityLabel}) in ${scene}`
      : `Acquired ${item.name} (${rarityLabel})`;
    _appendStoryNote(actor, bullet).catch(() => {});

    // ── Deed: significant item acquired ───────────────────
    const itemMag = _itemRarityToMagnitude(rarity);
    if (fameEngine && itemMag) {
      aceMemory.logDeed({
        text:      bullet,
        magnitude: itemMag,
        scene,
        pcs:       [actor.name],
        source:    "auto:item",
      });
    }
  }
});

Hooks.on("deleteItem", (item, options, userId) => {
  if (!game.user.isGM || !aceMemory) return;
  const actor = item.parent;
  if (!actor || !actor.hasPlayerOwner || actor.type !== "character") return;
  const skipTypes = new Set(["class", "subclass", "feat", "feature", "spell", "background", "race"]);
  if (skipTypes.has(item.type)) return;
  aceMemory.logItemLost({
    actorName: actor.name,
    itemName:  item.name,
    scene:     canvas?.scene?.name ?? "",
  });
  console.log(`${MODULE_ID} | Item lost: ${actor.name} lost ${item.name}`);
});

// ── Token & Tile lifecycle — refresh Select panel ──────────
Hooks.on("createToken", (tokenDoc) => {
  if (!game.user.isGM) return;
  if (sceneCtx) sceneCtx.refresh();
  if (panel?.rendered) panel.refreshSelectPanel();

  // ── Encounter: track placed creatures ──
  if (panel) panel._onTokenCreatedForEncounter(tokenDoc);

  // ── Reputation: check newly placed NPC tokens for faction awareness ──
  if (reputationEngine && aceMemory) {
    const actor = tokenDoc.actor;
    if (actor && !actor.hasPlayerOwner) {
      const name = tokenDoc.name || actor.name;
      if (name) {
        // Register in NPC store first
        aceMemory.npcs.touchNpc(name, canvas?.scene?.name ?? "");
        const rec = aceMemory.npcs.getRecord(name);
        if (rec && !rec.actorId) rec.actorId = actor.id;

        // Run awareness check
        try {
          if (typeof reputationEngine?.checkNpcAwareness === "function") {
            const result = reputationEngine.checkNpcAwareness(name, actor);
            if (result) {
              console.log(`${MODULE_ID} | Reputation: newly placed ${name} is ${result.level} of PCs (${(result.awareness * 100).toFixed(0)}%)`);
            }
          }
        } catch (err) {
          // Non-critical — reputation check is optional
        }
      }
    }
  }
});

Hooks.on("deleteToken", () => {
  if (!game.user.isGM) return;
  if (sceneCtx) sceneCtx.refresh();
  if (panel?.rendered) panel.refreshSelectPanel();
});

Hooks.on("createTile", (tile) => {
  if (!game.user.isGM) return;
  if (panel?.rendered) panel.refreshSelectPanel();
  // Log tile placement to memory
  if (aceMemory) {
    aceMemory.logTileChange({
      action: "placed",
      sceneName: canvas?.scene?.name ?? "",
      tileData: { id: tile.id, texture: tile.texture?.src ?? "" },
    });
  }
});

Hooks.on("deleteTile", (tile) => {
  if (!game.user.isGM) return;
  if (panel?.rendered) panel.refreshSelectPanel();
  // Log tile removal to memory
  if (aceMemory) {
    aceMemory.logTileChange({
      action: "removed",
      sceneName: canvas?.scene?.name ?? "",
      tileData: { id: tile.id },
    });
  }
});

Hooks.on("createCombatant", () => {
  if (!game.user.isGM || !sceneCtx) return;
  sceneCtx.refresh();
  if (panel?.rendered) panel.updateContext();
  if (panel?.rendered) panel.refreshTccInitiative();
});

Hooks.on("deleteCombatant", () => {
  if (!game.user.isGM || !sceneCtx) return;
  sceneCtx.refresh();
  if (panel?.rendered) panel.updateContext();
  if (panel?.rendered) panel.refreshTccInitiative();
});

// ── Disposition change → PC story notes ───────────────────────
Hooks.on("ace.dispositionChange", ({ npcName, fromLabel, toLabel, scene }) => {
  if (!game.user.isGM) return;
  if (!_isDramaticDispositionShift(fromLabel, toLabel)) return;

  // Write a story note to all PCs currently on the scene
  const pcTokens = canvas?.tokens?.placeables?.filter(t =>
    t.actor?.hasPlayerOwner && t.actor?.type === "character"
  ) ?? [];

  const pcNames = [];
  for (const tok of pcTokens) {
    const verb = toLabel === "Friendly" ? "Earned the friendship of" : "Made an enemy of";
    const bullet = scene ? `${verb} ${npcName} in ${scene}` : `${verb} ${npcName}`;
    _appendStoryNote(tok.actor, bullet).catch(() => {});
    pcNames.push(tok.actor.name);
  }

  // ── Deed: dramatic disposition shift ──────────────────────
  if (fameEngine && pcNames.length) {
    const verb = toLabel === "Friendly" ? "Earned the friendship of" : "Made an enemy of";
    aceMemory.logDeed({
      text:      scene ? `${verb} ${npcName} in ${scene}` : `${verb} ${npcName}`,
      magnitude: "local",
      scene:     scene ?? "",
      pcs:       pcNames,
      source:    "auto:disposition",
    });
  }
});

// ── Chat message handler: Subtle Roll detection + Crit/Fumble auto-detection ──
// Single handler prevents subtle rolls from also being processed as crits/fumbles.
Hooks.on("createChatMessage", async (message) => {
  if (!game.user.isGM) return;

  // ── Subtle Roll detection — intercept blind rolls tagged by the player ──
  if (message.flags?.["ace-engine"]?.isSubtleRoll && subtleRolls) {
    subtleRolls.handleBlindRollResult(message);
    return;  // don't fall through to crit/fumble
  }

  // ── PC Career Stats + Crit/Fumble auto-detection ──────────────
  if (message.flags?.["ace-engine"]) return; // skip our own ACE messages

  const actorId   = message.speaker?.actor;
  const actor     = actorId ? game.actors?.get(actorId) : null;
  const actorName = message.speaker?.alias
    ?? actor?.name
    ?? message.speaker?.token
    ?? "Unknown";
  const isPC      = actor ? actor.hasPlayerOwner : false;

  // ── Track attack hits/misses for PCs ───────────────────────
  if (aceMemory && isPC && game.combat?.active) {
    const rollType = message.flags?.dnd5e?.roll?.type;
    if (rollType === "attack") {
      try {
        const rolls = message.rolls ?? [];
        for (const roll of rolls) {
          const d20 = roll.terms?.find(t => t.faces === 20);
          if (!d20) continue;
          // Determine hit/miss: dnd5e v13 stores the evaluation
          // A roll total >= target AC = hit. We approximate using the
          // isCritical flag or by checking if Foundry marked it.
          // dnd5e sets roll.options.target (the AC) when available.
          const ac = roll.options?.target ?? roll.options?.targetValue ?? 0;
          const hit = message.flags?.dnd5e?.roll?.isCritical
            || (ac > 0 && roll.total >= ac)
            || (!ac && roll.total >= 10); // fallback heuristic if no AC stored
          const isFumble = d20.results?.some(r => r.active && r.result === 1);
          aceMemory.logAttackResult({
            actorName,
            hit: isFumble ? false : !!hit,
            weaponName: _parseWeaponName(message),
          });
          break; // one attack roll per message
        }
      } catch (_) {}
    }

    // ── Track damage dealt by PCs ───────────────────────────
    if (rollType === "damage") {
      try {
        const rolls = message.rolls ?? [];
        let totalDmg = 0;
        for (const roll of rolls) totalDmg += (roll.total ?? 0);
        if (totalDmg > 0) {
          aceMemory.logAttackResult({ actorName, hit: true, damage: totalDmg });
        }
      } catch (_) {}
    }

    // ── Track healing done by PCs ────────────────────────────
    if (rollType === "healing") {
      try {
        const rolls = message.rolls ?? [];
        let totalHeal = 0;
        for (const roll of rolls) totalHeal += (roll.total ?? 0);
        if (totalHeal > 0) {
          aceMemory.logHealing({ actorName, amount: totalHeal });
        }
      } catch (_) {}
    }

    // ── Track death saves ────────────────────────────────────
    if (rollType === "death") {
      try {
        const rolls = message.rolls ?? [];
        for (const roll of rolls) {
          const success = (roll.total ?? 0) >= 10;
          aceMemory.logDeathSave({ actorName, success });
          break;
        }
      } catch (_) {}
    }
  }

  // ── Crit / Fumble auto-detection ──────────────────────────────
  // Only acts on d20 attack rolls with a natural 1 or 20 during active combat.
  if (!panel?.rendered)      return;   // panel must be open
  if (!game.combat?.active)  return;   // only during active combat

  const type = _detectCritOrFumble(message);
  if (!type) return;

  const weaponName = _parseWeaponName(message);
  const targetName = _parseTargetName();

  console.log(`${MODULE_ID} | Detected ${type} by ${actorName} (isPC:${isPC}) weapon:${weaponName ?? "?"} target:${targetName ?? "?"}`);

  // Log to persistent memory
  aceMemory?.logCritFumble({
    type,
    actorName,
    weaponName,
    targetName,
    scene: canvas?.scene?.name ?? "",
  });

  panel.autoTriggerCritFumble({ type, actorName, isPC, weaponName, targetName, actor });
});

/**
 * Inspect a chat message's roll data to find a d20 attack roll that
 * produced a natural 1 (fumble) or natural 20 (crit).
 * @returns {"crit"|"fumble"|null}
 */
function _detectCritOrFumble(message) {
  try {
    // Skip non-attack roll types (dnd5e flag present and not "attack")
    const rollType = message.flags?.dnd5e?.roll?.type;
    if (rollType && rollType !== "attack") return null;

    // dnd5e explicit critical flag
    if (message.flags?.dnd5e?.roll?.isCritical) return "crit";

    // Walk the Roll terms looking for an active d20 result
    const rolls = message.rolls ?? [];
    for (const roll of rolls) {
      for (const term of (roll.terms ?? [])) {
        if (term.faces !== 20) continue;
        for (const result of (term.results ?? [])) {
          if (!result.active || result.discarded) continue;
          if (result.result === 20) return "crit";
          if (result.result === 1)  return "fumble";
        }
      }
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | _detectCritOrFumble error:`, err);
  }
  return null;
}

/**
 * Extract the weapon / spell name from a dnd5e chat message.
 * Tries multiple dnd5e v3/v4 flag paths then falls back to HTML scraping.
 * @returns {string|null}
 */
function _parseWeaponName(message) {
  try {
    const d5e = message.flags?.dnd5e ?? {};

    // dnd5e v4 activity system — item may be stored several ways
    const fromFlags =
      d5e.item?.name         ??   // v4: direct item object
      d5e.itemData?.name     ??   // v3: itemData snapshot
      d5e.activity?.name     ??   // v4: activity name (e.g. "Slam", "Claw")
      d5e.roll?.itemName     ??   // v3: roll itemName
      d5e.metadata?.item?.name ?? // v4: metadata wrapper
      null;

    if (fromFlags) return fromFlags;

    // Fallback: resolve UUID to item name if we have one
    const uuid = d5e.item?.uuid ?? d5e.roll?.itemUuid ?? null;
    if (uuid) {
      // fromUuidSync is available in Foundry v11+ — won't throw, returns null if not found
      const resolved = fromUuidSync?.(uuid);
      if (resolved?.name) return resolved.name;
    }

    // Final fallback: scrape the rendered card HTML
    const div = document.createElement("div");
    div.innerHTML = message.content ?? "";
    // dnd5e v4 uses .name-stacked .title; v3 uses .card-header h3; older uses .item-name
    const heading = div.querySelector([
      ".name-stacked .title",   // dnd5e v4 activity card
      ".card-header h3",        // dnd5e v3
      ".item-name",             // dnd5e v2/v3 alt
      ".action-title",          // some systems
      ".dnd5e2 header h3",      // dnd5e v4 alt
      "h3",                     // broad fallback
    ].join(", "));
    return heading?.textContent?.trim() || null;
  } catch (err) {
    console.warn(`${MODULE_ID} | _parseWeaponName error:`, err);
    return null;
  }
}

/**
 * Try to read the current user target name (first selected target).
 * @returns {string|null}
 */
function _parseTargetName() {
  try {
    const targets = [...(game.user?.targets ?? [])];
    if (targets.length) return targets[0].name ?? null;
  } catch (_) {}
  return null;
}

// ── Settings changes ───────────────────────────────────────────
Hooks.on("closeSettingsConfig", () => {
  if (!game.user.isGM) return;
  aiProvider?.refreshConfig();
  if (game.settings.get(MODULE_ID, "autoSuggestions")) {
    suggestionEngine?.start();
  } else {
    suggestionEngine?.stop();
  }
});

// ── ACE Chat Card: portrait + interactive buttons ─────────────
// Shared handler — works with both v12 renderChatMessage and v13 renderChatMessageHTML.
const ACE_PORTRAIT = `modules/${MODULE_ID}/assets/ace-portrait.png`;

function _aceOnRenderChatMessage(message, html) {
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root) return;

  // ── Portrait: mark ACE messages so CSS can force the portrait ──
  const isAce = message.speaker?.alias === "ACE"
            || message.flags?.["ace-engine"];
  if (isAce) {
    // Tag the <li> so our CSS rule can replace the avatar image via `content:`
    root.classList.add("ace-message");

    // Also try direct DOM replacement as primary method
    const img = root.querySelector("a.avatar img, .avatar img, .message-header img, .message-sender img");
    if (img) {
      img.src = ACE_PORTRAIT;
      img.alt = "ACE";
      img.classList.add("ace-avatar-img");
    } else {
      // No avatar element — inject one
      const sender = root.querySelector(".message-sender") ?? root.querySelector(".message-header");
      if (sender) {
        const link = document.createElement("a");
        link.classList.add("avatar");
        const avatarImg = document.createElement("img");
        avatarImg.src = ACE_PORTRAIT;
        avatarImg.alt = "ACE";
        avatarImg.classList.add("ace-avatar-img");
        link.append(avatarImg);
        sender.prepend(link);
      }
    }
  }

  // ── Interactive buttons on flagged messages ──
  if (!message.flags?.["ace-engine"]) return;
  root.querySelectorAll("[data-ace-btn]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await _aceHandleButton(btn);
      } catch (err) {
        console.error(`${MODULE_ID} | ACE button error:`, err);
        ui.notifications?.error("ACE: action failed — see console.");
      }
    });
  });
}

// v13+ uses renderChatMessageHTML; v12 uses renderChatMessage.
// Only register the correct one to avoid deprecation warnings on v13.
Hooks.on("renderChatMessageHTML", _aceOnRenderChatMessage);
Hooks.once("init", () => {
  try {
    const major = parseInt(game?.version);
    if (isNaN(major) || major < 13) {
      Hooks.on("renderChatMessage", _aceOnRenderChatMessage);
    }
  } catch (_) {
    // Version check failed — register legacy hook as safety fallback
    Hooks.on("renderChatMessage", _aceOnRenderChatMessage);
  }
});

// ── Button dispatcher ──────────────────────────────────────────
async function _aceHandleButton(btn) {
  switch (btn.dataset.aceBtn) {
    case "damage":       return _aceRollDamage(btn);
    case "heal":         return _aceRollHeal(btn);
    case "save":         return _aceRollSave(btn);
    case "condition":    return _aceApplyCondition(btn);
    case "apply-damage": return _aceApplyDamage(btn);
    case "apply-heal":   return _aceApplyHeal(btn);
    // ── Subtle Rolls ──────────────────────────────────────
    case "subtle-roll":         return _handleSubtleRollClick(btn);
    case "subtle-pick":         return subtleRolls?.pickNarration(btn);
    case "subtle-send-request": return _handleSubtleSendRequest(btn);
    case "subtle-broadcast":    return _handleSubtleBroadcast(btn);
    case "subtle-override":     return _handleSubtleOverride(btn);
    case "tcc-request-roll":    return _handleTccRequestRollClick(btn);
    default: console.warn(`${MODULE_ID} | Unknown ACE button type: "${btn.dataset.aceBtn}"`);
  }
}

/**
 * GM clicks "Broadcast" on a subtle roll narration.
 * Sends the narration as a whispered chat message + TTS to ONLY the rolling player.
 * Other players see/hear nothing — keeps the subtle roll truly subtle.
 */
async function _handleSubtleBroadcast(btn) {
  if (!game.user.isGM) return;

  const actorName    = btn.dataset.actorName ?? "Unknown";
  const skillLabel   = btn.dataset.skillLabel ?? "Skill Check";
  const narration    = decodeURIComponent(btn.dataset.narration ?? "");
  const targetUserId = btn.dataset.targetUserId ?? "";

  if (!narration) return;

  // Disable both buttons on the card (broadcast + override)
  const card = btn.closest(".ace-subtle-result");
  card?.querySelectorAll(".ace-chat-btn").forEach(b => {
    b.disabled      = true;
    b.style.opacity = "0.35";
    b.style.cursor  = "default";
  });
  btn.textContent   = "Sent!";
  btn.style.opacity = "0.6";

  // Persist the disabled state in the ChatMessage so it survives refresh
  _persistCardState(card);

  // Build delivery card
  const cardHtml =
    `<div class="ace-subtle-delivery" style="background:#1c150e;border-left:4px solid #c9a84c;` +
    `border-radius:6px;padding:14px 16px;font-family:'IM Fell English','Palatino Linotype',serif;line-height:1.7;">` +
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">` +
    `<span style="color:#c9a84c;font-weight:bold;font-size:1.1em;` +
    `text-transform:uppercase;letter-spacing:1px;">` +
    `<i class="fas fa-scroll" style="margin-right:6px;"></i>` +
    `${_escapeHtml(skillLabel)} — ${_escapeHtml(actorName)}</span></div>` +
    `<div style="font-style:italic;color:#eddfc5;font-size:1.15em;">` +
    `"${_escapeHtml(narration)}"</div>` +
    `</div>`;

  // Whisper to ONLY the rolling player + GM — other players see nothing
  const whisperIds = [game.user.id];  // GM always sees it
  if (targetUserId && targetUserId !== game.user.id) {
    whisperIds.push(targetUserId);
  }

  await ChatMessage.create({
    content: cardHtml,
    speaker: { alias: "ACE" },
    whisper: whisperIds,
    flags:   { "ace-engine": { isSubtleNarration: true } },
  });

  // TTS — generate ElevenLabs audio on GM side, send to ONLY the rolling player
  const elevenKey = _getElevenLabsKeyStandalone();
  if (elevenKey) {
    try {
      const audioBase64 = await _generateElevenLabsAudio(narration, elevenKey);
      if (audioBase64) {
        // Play locally on GM
        _playNarrationAudio(audioBase64, 0.8);
        // Send audio to ONLY the rolling player
        if (targetUserId && targetUserId !== game.user.id) {
          game.socket.emit(`module.${MODULE_ID}`, {
            type:         "narration-audio",
            audio:        audioBase64,
            userId:       game.user.id,
            targetUserId: targetUserId,
          });
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Subtle broadcast TTS error, falling back to browser:`, err.message);
      if (targetUserId) {
        game.socket.emit(`module.${MODULE_ID}`, {
          type:         "subtle-narration-tts",
          text:         narration,
          targetUserId: targetUserId,
        });
      }
    }
  } else {
    // No ElevenLabs key — fall back to browser TTS for just the rolling player
    if (targetUserId) {
      game.socket.emit(`module.${MODULE_ID}`, {
        type:         "subtle-narration-tts",
        text:         narration,
        targetUserId: targetUserId,
      });
    }
  }

  console.log(`${MODULE_ID} | Subtle Roll: broadcast ${skillLabel} narration for ${actorName} to player ${targetUserId}`);
}

/**
 * GM clicks "Override: Pass/Fail" on a subtle roll result card.
 * Generates a new narration for the opposite outcome, replaces the
 * narration text on the card, and swaps the broadcast button's data.
 */
async function _handleSubtleOverride(btn) {
  if (!game.user.isGM) return;

  const actorName    = btn.dataset.actorName ?? "Unknown";
  const skillLabel   = btn.dataset.skillLabel ?? "Skill Check";
  const dc           = parseInt(btn.dataset.dc) || 10;
  const total        = parseInt(btn.dataset.total) || 0;
  const natural      = parseInt(btn.dataset.natural) || 0;
  const targetUserId = btn.dataset.targetUserId ?? "";
  const actuallyPassed = btn.dataset.passed === "true";
  const flavor       = decodeURIComponent(btn.dataset.flavor ?? "");

  // The override result is the OPPOSITE of what actually happened
  const overridePassed = !actuallyPassed;
  const overrideCategory = overridePassed
    ? (natural === 20 ? "nat20" : "strong_success")
    : (natural === 1  ? "nat1"  : "strong_failure");

  // Show loading state
  btn.disabled      = true;
  btn.innerHTML     = `<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i>Generating...`;
  btn.style.opacity = "0.6";

  try {
    // Generate a new narration for the overridden result
    const subtleRolls = game.modules.get(MODULE_ID)?.api?.getSubtleRolls?.();
    if (!subtleRolls) throw new Error("SubtleRolls not available");

    const narrations = await subtleRolls.generateNarrations({
      skill: skillLabel, skillLabel, dc, total, natural,
      actorName, resultCategory: overrideCategory, flavor,
    });

    const newNarration = narrations[0] ?? "";
    if (!newNarration) throw new Error("No narration generated");

    // Update the narration text on the card
    const card = btn.closest(".ace-subtle-result");
    const narrationDiv = card?.querySelector(".ace-subtle-narration-text");
    if (narrationDiv) {
      narrationDiv.innerHTML = `"${_escapeHtml(newNarration)}"`;
    }

    // Update the broadcast button's narration data to use the new one
    const broadcastBtn = card?.querySelector("[data-ace-btn='subtle-broadcast']");
    if (broadcastBtn) {
      broadcastBtn.dataset.narration = encodeURIComponent(newNarration);
      broadcastBtn.disabled = false;
      broadcastBtn.style.opacity = "1";
    }

    // Update override button to show it was used
    btn.innerHTML     = `<i class="fas fa-check" style="margin-right:6px;"></i>` +
                        `Overridden to ${overridePassed ? "Pass" : "Fail"}`;
    btn.style.opacity = "0.5";
    btn.style.cursor  = "default";

    // Persist updated card state so it survives refresh
    _persistCardState(card);

    console.log(`${MODULE_ID} | Subtle Roll: GM overrode ${actorName}'s result to ${overridePassed ? "PASS" : "FAIL"}`);
  } catch (err) {
    console.error(`${MODULE_ID} | Subtle override failed:`, err);
    btn.innerHTML     = `<i class="fas fa-exclamation-triangle" style="margin-right:6px;"></i>Override Failed`;
    btn.style.opacity = "0.5";
  }
}

/**
 * Persist a card's current DOM state into the ChatMessage database.
 * After buttons are disabled/text changed, this saves the updated HTML
 * so the state survives page refreshes.
 * @param {HTMLElement|null} cardEl - The card wrapper element (.ace-subtle-result or .ace-subtle-request)
 */
function _persistCardState(cardEl) {
  if (!cardEl) return;
  // Only GMs can update chat messages they authored (player can't update GM-whispered cards)
  if (!game.user.isGM) return;
  // Walk up to the chat message element to get the message ID
  const msgEl = cardEl.closest("[data-message-id]");
  const msgId = msgEl?.dataset?.messageId;
  if (!msgId) return;
  const msg = game.messages.get(msgId);
  if (!msg) return;
  // Update stored content with current DOM (includes disabled buttons, changed text, etc.)
  msg.update({ content: cardEl.outerHTML }).catch(() => {});
}

/** Get targeted tokens first, fall back to selected tokens. */
function _aceGetTargets() {
  const targeted = [...(game.user?.targets ?? [])];
  if (targeted.length) return targeted;
  return [...(canvas?.tokens?.controlled ?? [])];
}

/** Build a dark-parchment ACE result card (used by roll results). */
function _aceCardHtml(borderColor, titleColor, titleHtml, bodyHtml) {
  return (
    `<div style="background:#1c150e;border-left:4px solid ${borderColor};border-radius:4px;` +
    `padding:8px 10px;font-family:'IM Fell English','Palatino Linotype',serif;line-height:1.6;">` +
    `<div style="color:${titleColor};font-weight:bold;margin-bottom:5px;">${titleHtml}</div>` +
    bodyHtml +
    `</div>`
  );
}

/** Roll extra damage dice -> post a card with an Apply Damage button. */
async function _aceRollDamage(btn) {
  const formula = btn.dataset.formula;
  const dmgType = btn.dataset.damageType || "untyped";
  let roll;
  try { roll = await new Roll(formula).evaluate(); }
  catch (err) { console.warn("ace-engine | Roll damage formula evaluation failed:", err); ui.notifications?.error(`ACE: invalid formula "${formula}"`); return; }

  const typeLabel = dmgType !== "untyped" ? ` ${_escapeHtml(dmgType)}` : "";
  const body =
    `<div style="font-size:2em;color:#eddfc5;text-align:center;font-weight:bold;padding:4px 0;">${roll.total}</div>` +
    `<div style="font-size:0.8em;color:#7a6042;text-align:center;margin-bottom:6px;">${_escapeHtml(formula)}${typeLabel}</div>` +
    `<button class="ace-chat-btn ace-chat-btn-apply" data-ace-btn="apply-damage" ` +
    `data-total="${roll.total}" data-damage-type="${_escapeHtml(dmgType)}" ` +
    `style="display:block;width:100%;padding:5px 10px;background:#261a08;border:1px solid #c9a84c;` +
    `border-radius:3px;color:#c9a84c;cursor:pointer;font-family:inherit;font-size:0.9em;text-align:left;">` +
    `Apply ${roll.total}${typeLabel} damage to Selected/Targeted</button>`;

  await ChatMessage.create({
    content: _aceCardHtml("#c9a84c", "#c9a84c", "Extra Damage", body),
    speaker: { alias: "ACE" },
    flags:   { "ace-engine": { isDmgCard: true, type: "dmg" } },
  });
  btn.textContent   = `Rolled: ${roll.total}`;
  btn.disabled      = true;
  btn.style.opacity = "0.6";
}

/** Roll a healing pool -> post a card with an Apply Healing button. */
async function _aceRollHeal(btn) {
  const formula   = btn.dataset.formula;
  let roll;
  try { roll = await new Roll(formula).evaluate(); }
  catch (err) { console.warn("ace-engine | Roll heal formula evaluation failed:", err); ui.notifications?.error(`ACE: invalid formula "${formula}"`); return; }

  const body =
    `<div style="font-size:2em;color:#eddfc5;text-align:center;font-weight:bold;padding:4px 0;">+${roll.total}</div>` +
    `<div style="font-size:0.8em;color:#7a6042;text-align:center;margin-bottom:6px;">${_escapeHtml(formula)}</div>` +
    `<button class="ace-chat-btn ace-chat-btn-heal" data-ace-btn="apply-heal" ` +
    `data-total="${roll.total}" ` +
    `style="display:block;width:100%;padding:5px 10px;background:#0f2e1a;border:1px solid #5db88a;` +
    `border-radius:3px;color:#5db88a;cursor:pointer;font-family:inherit;font-size:0.9em;text-align:left;">` +
    `Apply +${roll.total} HP to Selected/Targeted</button>`;

  await ChatMessage.create({
    content: _aceCardHtml("#5db88a", "#5db88a", "Healing", body),
    speaker: { alias: "ACE" },
    flags:   { "ace-engine": { isHealCard: true, type: "heal" } },
  });
  btn.textContent   = `Rolled: +${roll.total}`;
  btn.disabled      = true;
  btn.style.opacity = "0.6";
}

/**
 * Roll a saving throw for targeted/selected tokens.
 * For dnd5e: delegates to actor.rollAbilitySave (posts its own styled card).
 * For others: posts an ACE result card with pass/fail and optional Apply Condition button.
 */
async function _aceRollSave(btn) {
  const ability    = btn.dataset.ability;
  const dc         = parseInt(btn.dataset.dc);
  const condition  = btn.dataset.condition || "";
  const defaultUuid = btn.dataset.actorUuid || "";
  const abUp       = ability.toUpperCase();

  let targets = _aceGetTargets();
  // Fumble fallback: roll for the acting actor if nothing is selected/targeted
  if (!targets.length && defaultUuid) {
    const a = fromUuidSync?.(defaultUuid);
    if (a) targets = [{ actor: a }];
  }
  if (!targets.length) {
    ui.notifications?.warn(`ACE: target or select token(s) to roll ${abUp} Save.`);
    return;
  }

  for (const t of targets) {
    const actor = t.actor ?? t;
    try {
      if (game.system.id === "dnd5e") {
        // dnd5e posts its own roll card with pass/fail decoration
        await actor.rollAbilitySave(ability, { targetValue: dc });
      } else if (game.system.id === "pf2e") {
        const pf2e = { str: "fortitude", dex: "reflex", con: "fortitude", int: "will", wis: "will", cha: "will" };
        await actor.saves?.[pf2e[ability] || "reflex"]?.roll({ dc: { value: dc } });
      } else {
        // Generic: manual d20 roll
        const mod  = actor.system?.abilities?.[ability]?.mod ?? 0;
        const roll = await new Roll("1d20 + @mod", { mod }).evaluate();
        const pass = roll.total >= dc;
        const safeActorName = _escapeHtml(actor.name);
        const passTag = pass
          ? `<span style="color:#5db88a;font-weight:bold;">PASSED</span>`
          : `<span style="color:#c43b3b;font-weight:bold;">FAILED</span>`;
        const condBtn = (!pass && condition)
          ? `<button class="ace-chat-btn ace-chat-btn-cond" data-ace-btn="condition" data-condition="${_escapeHtml(condition)}" ` +
            `style="display:block;width:100%;padding:4px 8px;margin-top:5px;background:#2e0f0f;border:1px solid #c43b3b;` +
            `border-radius:3px;color:#e06060;cursor:pointer;font-family:inherit;font-size:0.88em;text-align:left;">` +
            `Apply: ${_escapeHtml(condition.charAt(0).toUpperCase() + condition.slice(1))}</button>`
          : "";
        const body =
          `<div style="font-size:1.8em;color:#eddfc5;text-align:center;font-weight:bold;padding:4px 0;">${roll.total}</div>` +
          `<div style="text-align:center;font-size:0.9em;">vs DC ${dc} — ${passTag}</div>` +
          condBtn;
        await ChatMessage.create({
          content: _aceCardHtml("#8a5bbf", "#c4a8f0", `${abUp} Save — ${safeActorName}`, body),
          speaker: { alias: actor.name },
          flags:   { "ace-engine": { isSaveResult: true, type: "save" } },
        });
      }
    } catch (err) {
      console.error(`${MODULE_ID} | _aceRollSave:`, err);
      ui.notifications?.error(`ACE: save roll failed for ${actor?.name ?? "unknown"}`);
    }
  }

  btn.textContent   = `Rolled (${targets.length})`;
  btn.style.opacity = "0.7";
}

/** Apply a Foundry status condition to targeted/selected tokens. */
async function _aceApplyCondition(btn) {
  const condition = btn.dataset.condition;
  if (!condition) return;
  const tokens = _aceGetTargets();
  if (!tokens.length) {
    ui.notifications?.warn(`ACE: select or target token(s) to apply ${condition}.`);
    return;
  }
  const label = condition.charAt(0).toUpperCase() + condition.slice(1);
  for (const t of tokens) {
    const actor = t.actor ?? t;
    try {
      if (typeof actor.toggleStatusEffect === "function") {
        await actor.toggleStatusEffect(condition, { active: true });
      } else {
        const eff = CONFIG.statusEffects?.find(e => e.id === condition);
        await actor.createEmbeddedDocuments("ActiveEffect", [{
          label:    eff?.label  ?? label,
          icon:     eff?.icon   ?? "icons/svg/mystery-man.svg",
          statuses: [condition],
        }]);
      }
      ui.notifications?.info(`Applied ${label} to ${actor.name}`);
    } catch (err) {
      console.error(`${MODULE_ID} | _aceApplyCondition:`, err);
      ui.notifications?.error(`ACE: could not apply ${label} — see console.`);
    }
  }
  btn.textContent   = `Applied: ${label}`;
  btn.disabled      = true;
  btn.style.opacity = "0.6";
}

/** Apply a pre-rolled damage total to targeted/selected tokens. */
async function _aceApplyDamage(btn) {
  const total   = parseInt(btn.dataset.total);
  const dmgType = btn.dataset.damageType || "untyped";
  const tokens  = _aceGetTargets();
  if (!tokens.length) {
    ui.notifications?.warn("ACE: select or target token(s) to apply damage.");
    return;
  }
  for (const t of tokens) {
    const actor = t.actor ?? t;
    try {
      if (game.system.id === "dnd5e") {
        await actor.applyDamage([{ value: total, type: dmgType }], { multiplier: 1 });
      } else {
        const hp = actor.system?.attributes?.hp;
        if (hp != null)
          await actor.update({ "system.attributes.hp.value": Math.max(0, (hp.value ?? 0) - total) });
      }
      ui.notifications?.info(`Applied ${total} damage to ${actor.name}`);
    } catch (err) {
      console.error(`${MODULE_ID} | _aceApplyDamage:`, err);
      ui.notifications?.error(`ACE: damage application failed — see console.`);
    }
  }
  btn.textContent   = `Applied to ${tokens.length} token(s)`;
  btn.disabled      = true;
  btn.style.opacity = "0.6";
}

/** Apply pre-rolled healing to targeted/selected tokens. */
async function _aceApplyHeal(btn) {
  const total  = parseInt(btn.dataset.total);
  const tokens = _aceGetTargets();
  if (!tokens.length) {
    ui.notifications?.warn("ACE: select or target token(s) to apply healing.");
    return;
  }
  for (const t of tokens) {
    const actor = t.actor ?? t;
    try {
      const hp = actor.system?.attributes?.hp;
      if (hp != null) {
        const newVal = Math.min(hp.max ?? 9999, (hp.value ?? 0) + total);
        await actor.update({ "system.attributes.hp.value": newVal });
        ui.notifications?.info(`Healed ${actor.name}: +${total} HP`);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | _aceApplyHeal:`, err);
    }
  }
  btn.textContent   = `Healed ${tokens.length} token(s)`;
  btn.disabled      = true;
  btn.style.opacity = "0.6";
}

// ── Subtle Rolls — Player-side roll button handler ─────────────
/**
 * Player clicks the [Roll {Skill}] button in the subtle roll request card.
 * We build a manual d20 + modifier roll to avoid Midi-QOL patching conflicts,
 * then post it as a BLINDROLL with ACE flags for result processing.
 */
const SKILL_LABELS_FALLBACK = {
  acr: "Acrobatics", ani: "Animal Handling", arc: "Arcana", ath: "Athletics",
  dec: "Deception", his: "History", ins: "Insight", itm: "Intimidation",
  inv: "Investigation", med: "Medicine", nat: "Nature", prc: "Perception",
  prf: "Performance", per: "Persuasion", rel: "Religion", slt: "Sleight of Hand",
  ste: "Stealth", sur: "Survival",
};

async function _handleSubtleRollClick(btn) {
  const requestId = btn.dataset.requestId;
  const skill     = btn.dataset.skill;
  const actorId   = btn.dataset.actorId;

  // Find the token / actor to roll for
  const controlled = canvas?.tokens?.controlled ?? [];
  let token = controlled[0];
  let actor = token?.actor;

  // If a specific actorId was provided (Envoy integration), use that
  if (actorId) {
    actor = game.actors?.get(actorId);
    if (!actor) {
      ui.notifications?.warn("ACE: Could not find the character for this roll.");
      return;
    }
    // Try to find the token on canvas
    token = canvas?.tokens?.placeables?.find(t => t.actor?.id === actorId);
  }

  if (!actor) {
    ui.notifications?.warn("ACE: Select your token first, then click to roll blind.");
    return;
  }

  // Disable the button immediately
  btn.disabled      = true;
  btn.textContent   = "Rolling...";
  btn.style.opacity = "0.6";

  try {
    // Manual d20 + skill modifier roll — avoids Midi-QOL patching conflicts
    // with actor.rollSkill() which expects different argument formats.
    const skillData = actor.system?.skills?.[skill];
    const mod = skillData?.total ?? skillData?.mod ?? 0;
    const skillLabel = CONFIG.DND5E?.skills?.[skill]?.label
                    ?? SKILL_LABELS_FALLBACK[skill]
                    ?? skill.toUpperCase();
    // Advantage/disadvantage detection (same as batch rolls)
    const subtleRolls = game.modules.get(MODULE_ID)?.api?.getSubtleRolls?.();
    const advState = subtleRolls?._detectAdvantage?.(actor, skill) ?? "normal";
    const diceExpr = advState === "advantage"    ? "2d20kh1"
                   : advState === "disadvantage" ? "2d20kl1"
                   :                              "1d20";

    const roll = new Roll(`${diceExpr} + ${mod}`);
    await roll.evaluate();

    // Bypass roll.toMessage() entirely — it calls applyRollMode()
    // which reads the player's chat dropdown and overwrites our
    // whisper/blind flags. ChatMessage.create() with rolls[] gives
    // us full control: player sees NOTHING, GM sees the result.
    const gmUsers = game.users.filter(u => u.isGM).map(u => u.id);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor:  `${skillLabel} Check (Blind)`,
      rolls:   [roll],
      whisper: gmUsers,
      blind:   true,
      flags: {
        "ace-engine": {
          isSubtleRoll:        true,
          subtleRollRequestId: requestId,
          subtleSkill:         skill,
          subtleActorId:       actor.id,
          subtleActorName:     actor.name,
        },
      },
    });
    btn.textContent = "Rolled (blind)";
    // Persist so the button stays disabled after browser refresh
    _persistCardState(btn.closest(".ace-subtle-request"));
  } catch (err) {
    console.error(`${MODULE_ID} | Subtle roll failed:`, err);
    btn.textContent = "Roll Failed";
    btn.disabled = false;
    btn.style.opacity = "1";
  }
}

/**
 * Player clicks the Roll button on a TCC Request Roll card.
 * Rolls blind — player sees "?" dice, GM gets the result whispered.
 */
async function _handleTccRequestRollClick(btn) {
  const rollType = btn.dataset.rollType;   // "skill" | "save" | "check"
  const rollId   = btn.dataset.rollId;     // e.g. "prc", "dex"
  const actorId  = btn.dataset.actorId;

  // Resolve actor
  let actor = actorId ? game.actors?.get(actorId) : null;
  if (!actor) {
    // Fallback: use selected token
    const token = canvas?.tokens?.controlled?.[0];
    actor = token?.actor;
  }
  if (!actor) {
    ui.notifications?.warn("ACE: Select your token first, then click to roll.");
    return;
  }

  // Disable button immediately
  btn.disabled      = true;
  btn.textContent   = "Rolling...";
  btn.style.opacity = "0.6";

  try {
    // Get modifier based on roll type
    let mod = 0;
    if (rollType === "skill") {
      mod = actor.system?.skills?.[rollId]?.total ?? actor.system?.skills?.[rollId]?.mod ?? 0;
    } else if (rollType === "save") {
      mod = actor.system?.abilities?.[rollId]?.save ?? 0;
    } else {
      mod = actor.system?.abilities?.[rollId]?.mod ?? 0;
    }

    // Roll silently — no chat message
    const roll = await new Roll(`1d20 + ${mod}`).evaluate();

    // Dice So Nice — player sees blind "?" dice, GM sees real dice
    if (game.dice3d) {
      try {
        // Player sees "?" dice locally (not synchronized, ghost shows "?" faces)
        await game.dice3d.showForRoll(roll, game.user, false, null, false, null, null, { ghost: true });
        // GM sees real dice (synchronized only to GM users, blind=true skips local player)
        const gmUsers = game.users.filter(u => u.isGM).map(u => u.id);
        if (gmUsers.length) {
          await game.dice3d.showForRoll(roll, game.user, true, gmUsers, true, null, null);
        }
      } catch (e) {
        console.warn(`${MODULE_ID} | Dice So Nice roll failed:`, e);
      }
    }

    const total   = roll.total;
    const natural = roll.dice?.[0]?.total ?? total;

    // Find the original request message to get the DC (stored in flags, not shown to player)
    const requestId = btn.dataset.requestId;
    const origMsg   = requestId ? game.messages.contents.find(m =>
      m.flags?.["ace-engine"]?.tccRequestId === requestId
    ) : null;
    const dc = origMsg?.flags?.["ace-engine"]?.tccDC ?? 15;

    const passed   = total >= dc;
    const passText = passed ? "PASS" : "FAIL";
    const passColor = passed ? "#4caf50" : "#f44336";
    const natTag   = natural === 20 ? ' <span style="color:#ffd700;font-weight:bold;">NAT 20</span>'
                   : natural === 1  ? ' <span style="color:#f44336;font-weight:bold;">NAT 1</span>' : "";

    const TCC_SKILL_LABELS = {
      acr: "Acrobatics",  ani: "Animal Handling", arc: "Arcana",
      ath: "Athletics",   dec: "Deception",       his: "History",
      ins: "Insight",     itm: "Intimidation",    inv: "Investigation",
      med: "Medicine",    nat: "Nature",          prc: "Perception",
      prf: "Performance", per: "Persuasion",      rel: "Religion",
      slt: "Sleight of Hand", ste: "Stealth",     sur: "Survival",
    };
    const TCC_ABILITY_LABELS = {
      str: "Strength", dex: "Dexterity",     con: "Constitution",
      int: "Intelligence", wis: "Wisdom",    cha: "Charisma",
    };
    const rollLabels = rollType === "skill" ? TCC_SKILL_LABELS : TCC_ABILITY_LABELS;
    const label      = rollLabels[rollId] ?? rollId;
    const typeLabel  = rollType === "skill" ? "Skill Check"
                     : rollType === "save"  ? "Saving Throw" : "Ability Check";

    // Send result to GM only
    const gmCardHtml =
      `<div class="ace-gm-roll-card" style="background:#1c150e;border-left:4px solid #c9a84c;` +
      `border-radius:6px;padding:12px 14px;font-family:'Rajdhani','Segoe UI',sans-serif;line-height:1.5;">` +
      `<div style="color:#c9a84c;font-weight:bold;font-size:1.05em;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;">` +
      `<i class="fas fa-dice-d20" style="margin-right:6px;"></i>${_escapeHtml(label)} ${_escapeHtml(typeLabel)} — DC ${dc}</div>` +
      `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;">` +
      `<img src="${actor.prototypeToken?.texture?.src ?? actor.img}" style="width:28px;height:28px;border-radius:50%;border:1px solid #555;" />` +
      `<span style="flex:1;color:#eddfc5;">${_escapeHtml(actor.name)}</span>` +
      `<span style="color:#aaa;font-size:0.85em;">${natural} + ${mod} = <strong style="color:#fff;">${total}</strong>${natTag}</span>` +
      `<span style="font-weight:bold;font-size:0.9em;min-width:36px;text-align:center;color:${passColor};">${passText}</span>` +
      `</div>` +
      `</div>`;

    // Find GM user to whisper to
    const gmUser = game.users.find(u => u.isGM);
    if (gmUser) {
      await ChatMessage.create({
        content: gmCardHtml,
        speaker: { alias: "ACE" },
        whisper: [gmUser.id],
      });
    }

    btn.textContent = "Rolled!";
  } catch (err) {
    console.error(`${MODULE_ID} | TCC request roll failed:`, err);
    btn.textContent = "Roll Failed";
    btn.disabled = false;
    btn.style.opacity = "1";
  }
}

/**
 * GM clicks [Send Roll Request] on an AI auto-detection suggestion card.
 * Reads the data attributes and fires a subtle roll request to the player.
 */
async function _handleSubtleSendRequest(btn) {
  if (!subtleRolls || !game.user.isGM) return;

  const actorId   = btn.dataset.actorId;
  const userId    = btn.dataset.userId;
  const skill     = btn.dataset.skill;
  const dc        = parseInt(btn.dataset.dc);
  const flavor    = decodeURIComponent(btn.dataset.flavor ?? "");

  // Resolve actor and user from data attributes
  const actor = actorId ? game.actors?.get(actorId) : null;
  if (!actor) {
    ui.notifications?.warn("ACE: Could not find the character for this roll suggestion.");
    return;
  }

  const ownerUser = userId
    ? game.users?.get(userId)
    : game.users?.find(u => !u.isGM && actor.testUserPermission(u, "OWNER"));
  if (!ownerUser) {
    ui.notifications?.warn(`ACE: No player found who owns "${actor.name}".`);
    return;
  }

  btn.disabled      = true;
  btn.textContent   = "Sent!";
  btn.style.opacity = "0.6";

  await subtleRolls.requestRoll({
    targetUserId: ownerUser.id,
    actorId:      actor.id,
    skill,
    dc,
    flavor,
  });
}

// ── Open / toggle panel ────────────────────────────────────────
function openPanel() {
  if (panel?.rendered) {
    // If minimized (badge mode), restore it instead of closing
    if (panel.element?.classList?.contains("ace-minimized")) {
      AcePanel._onRestoreFromBadge.call(panel);
      return;
    }
    // Already open and visible — bring to front / focus
    panel.bringToTop?.();
    return;
  } else {
    // Guard: all subsystems must be ready before opening
    if (!_aceReady) {
      ui.notifications?.warn("ACE is still loading — please wait a moment and try again.");
      return;
    }
    panel = new AcePanel({
      aiProvider,
      sceneCtx,
      npcMemory,
      lkMemory:          aceMemory,
      suggestionEngine,
      reputationEngine,
      subtleRolls,
      documentEngine,
      digestEngine,
      worldBible,
      vaultEngine,
      vaultSearch,
      triggerSfx: _triggerSfx,
      stopSfx:    stopAllSfx,
    });
    panel.render(true);
  }
}

export { MODULE_ID };
