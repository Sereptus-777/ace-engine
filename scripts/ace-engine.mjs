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
import { triggerLightning, triggerEarthquake, stopAllSfx } from "./sfx.mjs";
import { CanvasHighlight }   from "./canvas-highlight.mjs";
import { ReputationEngine }  from "./reputation-engine.mjs";
import { SubtleRollManager } from "./subtle-rolls.mjs";
import { FameEngine }        from "./fame-engine.mjs";
import { DocumentEngine }    from "./document-engine.mjs";
import { DigestEngine }      from "./digest-engine.mjs";
import { SimpleCalendarBridge } from "./simple-calendar-bridge.mjs";

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
export let localCredentials = {};

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
let calendarBridge = null;   // SimpleCalendarBridge — optional Simple Calendar sync
let subtleRolls    = null;   // SubtleRollManager — blind skill checks with AI narration
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

// ── Ready: initialize for ALL users (socket listener first) ────
Hooks.once("ready", async () => {
  // ── Clean up stray CONFIG.debug.hooks left on by other modules (e.g. chat-images)
  if (CONFIG.debug?.hooks) CONFIG.debug.hooks = false;

  // ── Socket listener — runs for ALL users (GM + players) ──────
  // This lets players receive SFX broadcast by the GM.
  game.socket.on(`module.${MODULE_ID}`, (data) => {
    if (data?.type === "sfx") _handleRemoteSfx(data);
    if (data?.type === "subtle-narration-tts" && data.text) {
      // Player receives narration TTS broadcast — speak it aloud
      if (data.targetUserId && data.targetUserId !== game.user.id) return;
      panel?._speakTTS?.(data.text);
    }
  });

  // ── Load baked-in credentials from config.local.json (optional) ─
  // If the file exists and contains your ElevenLabs key/voice, those
  // values will be used instead of whatever is in Module Settings.
  // The file is never shared — it lives only on your local machine.
  try {
    const resp = await fetch(`modules/${MODULE_ID}/config.local.json`, { cache: "no-store" });
    if (resp.ok) {
      const cfg = await resp.json();
      // Ignore the readme comment key; only accept known credential keys
      const { elevenLabsApiKey, elevenLabsVoiceId, elevenLabsModel } = cfg;
      if (elevenLabsApiKey  && !elevenLabsApiKey.includes("YOUR_"))  localCredentials.elevenLabsApiKey  = elevenLabsApiKey.trim();
      if (elevenLabsVoiceId && !elevenLabsVoiceId.includes("YOUR_")) localCredentials.elevenLabsVoiceId = elevenLabsVoiceId.trim();
      if (elevenLabsModel)                                            localCredentials.elevenLabsModel   = elevenLabsModel.trim();
      if (Object.keys(localCredentials).length) {
        console.log(`${MODULE_ID} | Loaded local credentials from config.local.json (${Object.keys(localCredentials).join(", ")})`);
      }
    }
  } catch (_) { /* No config.local.json — perfectly fine, use Settings */ }

  // ── Register password masking for API key fields in Settings ──
  AceSettings.maskSecretFields();

  // ── GM-only initialization ────────────────────────────────────
  if (!game.user.isGM) return;

  console.log(`${MODULE_ID} | ACE ready — GM mode active`);

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

    // Migration 3: source conflict resolution
    if (currentPrompt && !currentPrompt.includes("conflicting information")) {
      currentPrompt += `\n\nWhen multiple source documents contain conflicting information (different editions, timeline changes, retcons), prefer the most recently uploaded document. GM session notes and campaign-specific content ALWAYS take priority over published sourcebooks. If you notice a conflict, briefly mention it so the GM can decide.`;
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
  if (aceMemory && reputationEnabled) {
    try {
      reputationEngine = new ReputationEngine(aceMemory);
      console.log(`${MODULE_ID} | Reputation engine initialized (scene counter: ${reputationEngine.getSceneCounter()})`);
    } catch (err) {
      console.error(`${MODULE_ID} | Reputation engine failed:`, err);
      reputationEngine = null;
    }
  } else if (!reputationEnabled) {
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

  // ── Document Engine — reference library (PDF, text, images) ──
  const libEnabled = game.settings.get(MODULE_ID, "enableDocumentLibrary") ?? true;
  if (aceMemory && libEnabled) {
    try {
      documentEngine = new DocumentEngine(aceMemory, digestEngine);
      const stats = documentEngine.getLibrarySummary();
      console.log(`${MODULE_ID} | Document engine initialized (${stats.totalDocuments} docs, ${stats.totalChunks} chunks, ${stats.totalImages} images)`);

      // Pre-load active digests for this world
      if (digestEngine) {
        const activeIds = aceMemory.documents.getActiveDigests();
        if (activeIds.length) {
          await digestEngine.loadActiveDigests(activeIds);
          console.log(`${MODULE_ID} | Loaded ${activeIds.length} active digest(s) for this world`);
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
  };
  game.modules.get(MODULE_ID).api = api;

  // Expose public API for sister modules (ACE: Envoy, ACE: Trapmaster)
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      ...api,
      getMemory: (category) => aceMemory?.getStore(category)?.getAll() ?? [],
      askAI:     (prompt) => aiProvider?.chat(prompt, "", "", []),
      narrate:   (text) => panel?.narrateText?.(text),
      openPanel: () => panel?.render(true),

      // ── Reputation API (used by ACE: Envoy) ──────────────────────
      /**
       * Log a conversation encounter from Envoy into the reputation system.
       * Called when an Envoy conversation ends and session is summarized.
       */
      logConversationEncounter: ({ actor, playerName, summary, history }) => {
        if (!reputationEngine || !actor) return;
        const factionKey = reputationEngine.resolveFactionKey(actor);
        if (!factionKey) return;

        // Gather PC names from history if available
        const pcNames = playerName ? [playerName] : [];

        reputationEngine.logEncounter({
          factionKey,
          kind:    "conversation",
          outcome: "survived",
          npcName: actor.name,
          pcNames,
          scene:   canvas?.scene?.name ?? "",
          summary: (summary ?? "").slice(0, 300),
          direct:  true,  // Conversations are always direct encounters — the NPC personally met the PC
        });
        console.log(`${MODULE_ID} | Reputation: logged DIRECT conversation from Envoy for faction "${factionKey}" — ${actor.name}`);
      },

      /**
       * Get the reputation context paragraph for an NPC (for injection into AI prompts).
       * Called by Envoy's conversation.js before building the system prompt.
       * Now also includes fame/deed context if the fame engine is active.
       */
      getReputationContext: (npcName) => {
        let ctx = reputationEngine?.buildReputationContext(npcName) ?? "";
        ctx += fameEngine?.buildFameContext(npcName, canvas?.scene?.name ?? "") ?? "";
        return ctx;
      },

      /**
       * Check if an NPC is aware of the PCs.
       */
      checkNpcAwareness: (npcName, actor) => {
        if (!reputationEngine) return null;
        return reputationEngine.checkNpcAwareness(npcName, actor);
      },

      /**
       * Get the reputation engine instance (for advanced use).
       */
      getReputationEngine: () => reputationEngine,

      /**
       * Set the intelligence network level for a faction.
       * Controls how much PC detail the AI can reveal for NPCs of that type.
       * Usage: ace.setIntelNetwork("undead", "extensive")
       * @param {string} factionKey — e.g. "undead", "goblinoid", "fiend"
       * @param {string} level — "none" | "informants" | "extensive" | "omniscient"
       */
      setIntelNetwork: (factionKey, level) => {
        if (!reputationEngine) { ui.notifications?.warn("ACE: Reputation engine not initialized."); return; }
        return reputationEngine.setIntelligenceNetwork(factionKey, level);
      },

      /**
       * Get the intelligence network level for a faction.
       * @param {string} factionKey
       * @returns {string} "none" | "informants" | "extensive" | "omniscient"
       */
      getIntelNetwork: (factionKey) => {
        if (!reputationEngine) return "none";
        return reputationEngine.getIntelligenceNetwork(factionKey);
      },

      /**
       * List all known factions with their encounter counts and intel levels.
       * Usage: ace.listFactions() — prints a nice table to the console.
       * @returns {Array}
       */
      listFactions: () => {
        if (!reputationEngine) return [];
        const factions = reputationEngine.listFactions();
        console.table(factions);
        return factions;
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
       * @param {string} npcName - NPC name for context
       * @param {string} userMessage - The user's current message/query
       * @returns {string} Formatted reference library context, or ""
       */
      getDocumentContext: (npcName, userMessage) => {
        if (!documentEngine) return "";
        return documentEngine.buildDocumentContext("", userMessage, canvas?.scene?.name ?? "") ?? "";
      },

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
            catch { return null; }
          })
        );
        return images.filter(Boolean);
      },

      /** Get the document engine instance (for advanced use). */
      getDocumentEngine: () => documentEngine,
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
    setInterval(() => {
      if (game.user.isGM) {
        aceMemory.autoBackup().catch(err =>
          console.warn(`${MODULE_ID} | Periodic auto-backup failed:`, err)
        );
      }
    }, 30 * 60 * 1000); // 30 minutes
  }
});

// ── SFX: play locally + broadcast to all other clients ─────────
function _triggerSfx(effect) {
  _handleRemoteSfx({ effect });                                       // play on GM screen
  game.socket.emit(`module.${MODULE_ID}`, { type: "sfx", effect });   // broadcast to players
}

function _handleRemoteSfx({ effect }) {
  switch (effect) {
    case "lightning":  triggerLightning();  break;
    case "earthquake": triggerEarthquake(); break;
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
    const pcs = game.actors?.filter(a => a.hasPlayerOwner && a.type === "character") ?? [];
    for (const actor of pcs) {
      aceMemory.pcs.touchPc(actor.id, actor.name);
      // Extract class/level if available
      const rec = aceMemory.pcs.getRecord(actor.id);
      if (rec) {
        rec.class = rec.class || aceMemory._extractClass(actor);
        rec.level = rec.level || aceMemory._extractLevel(actor);
      }
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
        const result = reputationEngine.checkNpcAwareness(name, actor);
        if (result) {
          console.log(`${MODULE_ID} | Reputation: ${name} is ${result.level} of PCs (awareness: ${(result.awareness * 100).toFixed(0)}%)`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Reputation check failed for ${name}:`, err);
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
  CanvasHighlight.clearAll();   // remove any lingering highlights from previous scene
  if (panel?.rendered) {
    panel.updateContext();
    panel.trackSceneTransition();   // advance survival tracker on scene change
    panel.refreshSelectPanel();     // refresh Select panel for new scene
  }
  // Re-inject toolbar button on scene changes (controls re-render)
  _injectAceControl();

  // ── Log scene transition to memory ──────────────────────────
  const newScene = canvas?.scene?.name ?? null;
  if (aceMemory && newScene && newScene !== _lastSceneName) {
    const fromScene = _lastSceneName;
    aceMemory.logSceneChange(fromScene, newScene);
    _lastSceneName = newScene;
    // Increment reputation scene counter on each genuine scene transition
    if (reputationEngine) reputationEngine.incrementSceneCounter();

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
    if (fromScene && game.settings.get(MODULE_ID, "enableNarrativeTime")) {
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
          const factionKey = reputationEngine.resolveFactionKey(actor);
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

        reputationEngine.logEncounter({
          factionKey,
          kind,
          outcome,
          npcName:  names,
          pcNames,
          scene:    canvas?.scene?.name ?? "",
          summary:  `${kind === "kill" ? "PCs killed" : "PCs fought"} ${names}. ${anySurvived ? "Some survived." : "None survived."}`,
          npcStats: bestSpreaderStats,
          direct:   true,  // Combat is always a direct encounter — these NPCs personally fought the PCs
        });
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

  // ── PC knockdown: HP drops to 0 (works in or out of combat) ──
  if (actor.hasPlayerOwner && actor.type === "character") {
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
          const result = reputationEngine.checkNpcAwareness(name, actor);
          if (result) {
            console.log(`${MODULE_ID} | Reputation: newly placed ${name} is ${result.level} of PCs (${(result.awareness * 100).toFixed(0)}%)`);
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | Reputation check failed for new token ${name}:`, err);
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

// ── Subtle Roll detection — intercept blind rolls tagged by the player ──
Hooks.on("createChatMessage", async (message) => {
  if (!game.user.isGM) return;
  if (message.flags?.["ace-engine"]?.isSubtleRoll && subtleRolls) {
    subtleRolls.handleBlindRollResult(message);
    return;  // don't fall through to crit/fumble
  }
});

// ── Crit / Fumble auto-detection ──────────────────────────────
// Fires when any chat message is created; only acts on d20 attack rolls
// that produce a natural 1 or 20 while combat is active.
Hooks.on("createChatMessage", async (message) => {
  if (!game.user.isGM)       return;   // only the GM triggers this
  if (!panel?.rendered)      return;   // panel must be open
  if (!game.combat?.active)  return;   // only during active combat
  if (message.flags?.["ace-engine"]) return; // skip our own ACE messages

  const type = _detectCritOrFumble(message);
  if (!type) return;

  // Gather context
  const actorId   = message.speaker?.actor;
  const actor     = actorId ? game.actors?.get(actorId) : null;
  const actorName = message.speaker?.alias
    ?? actor?.name
    ?? message.speaker?.token
    ?? "Unknown";
  const isPC      = actor ? actor.hasPlayerOwner : true;
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
    default: console.warn(`${MODULE_ID} | Unknown ACE button type: "${btn.dataset.aceBtn}"`);
  }
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
  catch { ui.notifications?.error(`ACE: invalid formula "${formula}"`); return; }

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
  catch { ui.notifications?.error(`ACE: invalid formula "${formula}"`); return; }

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
 * We temporarily hook preCreateChatMessage to inject ACE flags and force
 * the roll mode to BLINDROLL, then trigger the skill roll via dnd5e API.
 */
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

  // Temporarily hook preCreateChatMessage to inject subtle roll flags
  const hookId = Hooks.on("preCreateChatMessage", (msg, data) => {
    // Inject our flags into the roll message
    foundry.utils.mergeObject(data, {
      "flags.ace-engine": {
        isSubtleRoll:       true,
        subtleRollRequestId: requestId,
        subtleSkill:        skill,
        subtleActorId:      actor.id,
        subtleActorName:    actor.name,
      },
    });
    // Force blind roll mode
    data.rollMode = CONST.DICE_ROLL_MODES.BLINDROLL;
    // Remove hook after first use
    Hooks.off("preCreateChatMessage", hookId);
  });

  try {
    // dnd5e skill roll API
    if (typeof actor.rollSkill === "function") {
      await actor.rollSkill(skill, { rollMode: CONST.DICE_ROLL_MODES.BLINDROLL });
    } else {
      // Fallback for non-dnd5e: manual d20 + ability modifier
      const mod = actor.system?.skills?.[skill]?.total ?? 0;
      const roll = new Roll(`1d20 + ${mod}`);
      await roll.evaluate({ async: true });
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        rollMode: CONST.DICE_ROLL_MODES.BLINDROLL,
        flags: {
          "ace-engine": {
            isSubtleRoll:       true,
            subtleRollRequestId: requestId,
            subtleSkill:        skill,
            subtleActorId:      actor.id,
            subtleActorName:    actor.name,
          },
        },
      });
      // Clean up the hook since manual roll didn't go through preCreate
      Hooks.off("preCreateChatMessage", hookId);
    }
    btn.textContent = "Rolled (blind)";
  } catch (err) {
    console.error(`${MODULE_ID} | Subtle roll failed:`, err);
    btn.textContent = "Roll Failed";
    btn.disabled = false;
    btn.style.opacity = "1";
    Hooks.off("preCreateChatMessage", hookId); // Clean up hook on failure
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
    panel.close();
    panel = null;
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
      triggerSfx: _triggerSfx,
      stopSfx:    stopAllSfx,
    });
    panel.render(true);
  }
}

export { MODULE_ID };
