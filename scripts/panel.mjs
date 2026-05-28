// ============================================================
// ACE — AI Campaign Engine — GM Assistant Panel (ApplicationV2)
// Tabs: Chat (AI private) | Narration (to players) | Ideas | Encounter | Select
// ============================================================

import { MODULE_ID, localCredentials } from "./ace-engine.mjs";
import { CanvasHighlight } from "./canvas-highlight.mjs";
import { filterProfanity, buildProfanityPrompt } from "./profanity-filter.mjs";
import { writeBiography, appendToBiography } from "./bio-writer.mjs";
// Social Profile Engine moved to ace-envoy (standalone module)

// v13-safe FilePicker access (for document library uploads)
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ?? // v13+
  globalThis.FilePicker;                                     // v12 fallback

// ── Shared label constants ─────────────────────────────────────
// Ordered most-rolled (top) → least-rolled (bottom). Based on community
// data (CritRoleStats: Perception ~31%, Stealth ~19% — those two dominate
// every dataset; Investigation + Insight round out the top 4). Then a
// middle band of action / social skills, then knowledge skills, with the
// rarely-rolled cluster (Sleight of Hand, Animal Handling, Medicine,
// Performance) bottom-anchored. Object literal key order is preserved
// when we iterate with Object.entries in _buildTccRollOptions, so this
// IS the dropdown order.
const TCC_SKILL_LABELS = {
  prc: "Perception",       ste: "Stealth",          inv: "Investigation",
  ins: "Insight",          ath: "Athletics",        per: "Persuasion",
  acr: "Acrobatics",       dec: "Deception",        itm: "Intimidation",
  sur: "Survival",         arc: "Arcana",           his: "History",
  rel: "Religion",         nat: "Nature",           slt: "Sleight of Hand",
  ani: "Animal Handling",  med: "Medicine",         prf: "Performance",
};

// Skills where failure is NOT obvious to the player — suitable for blind/subtle rolls.
// Excluded: Athletics, Acrobatics, Stealth, Sleight of Hand, Performance,
//           Persuasion, Intimidation, Deception (failure is immediately apparent).
const TCC_SUBTLE_SKILLS = new Set([
  "prc",  // Perception — "I see nothing" but is there something?
  "ins",  // Insight — "They seem honest" but are they?
  "inv",  // Investigation — "Nothing here" but was there a hidden door?
  "arc",  // Arcana — recall lore (Nat 1 = wrong lore)
  "his",  // History — recall lore
  "rel",  // Religion — recall lore
  "nat",  // Nature — recall lore / identify creatures
  "med",  // Medicine — "Patient looks fine" but maybe poisoned
  "sur",  // Survival — "No tracks" but maybe there are
]);

// Saves where failure is NOT obvious — only Wisdom (charm/fear) and Intelligence (illusions/psychic).
const TCC_SUBTLE_SAVES = new Set(["wis", "int"]);
const TCC_ABILITY_LABELS = {
  str: "Strength", dex: "Dexterity",     con: "Constitution",
  int: "Intelligence", wis: "Wisdom",    cha: "Charisma",
};
const TCC_CONDITION_LIST = [
  "blinded","charmed","deafened","frightened","grappled","incapacitated",
  "invisible","paralyzed","petrified","poisoned","prone","restrained",
  "stunned","unconscious","exhaustion",
];

// ── Dialog compatibility helper ────────────────────────────────
// Uses DialogV2 (Foundry v12+) when available, falls back to legacy Dialog.
// Returns Promise<boolean> — true = confirmed, false = cancelled.
async function _aceConfirmDialog(title, content, {
  rejectClose = true,
  yesLabel = "Confirm",  yesIcon = "fas fa-check",
  noLabel  = "Cancel",   noIcon  = "fas fa-times",
} = {}) {
  // DialogV2 (v12 ApplicationV2-style)
  if (foundry.applications?.api?.DialogV2?.confirm) {
    return foundry.applications.api.DialogV2.confirm({
      window:      { title },
      content,
      yes:         { label: yesLabel, icon: yesIcon },
      no:          { label: noLabel,  icon: noIcon  },
      rejectClose,
    });
  }
  // Legacy Dialog (v10/v11 fallback)
  return Dialog.confirm({ title, content, defaultYes: false });
}

// ── Close-intercept dialog: "Exit & Save", "Exit Without Saving", or "Minimize" ──
// Returns "save" | "exit" | "minimize".  Throws (reject) on X → caller cancels close.
async function _aceCloseDialog(eventCount, eventLines = []) {
  const _esc = s => (s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  // Build scrollable event list
  const listHtml = eventLines.length
    ? `<div style="max-height:220px;overflow-y:auto;margin:8px 0 4px;padding:6px 8px;` +
      `background:rgba(0,0,0,0.25);border:1px solid rgba(212,175,55,0.2);border-radius:4px;` +
      `font-size:12px;line-height:1.6;color:#ccc;">` +
      eventLines.map(l => `<div style="border-bottom:1px solid rgba(255,255,255,0.05);padding:2px 0;">${_esc(l)}</div>`).join("") +
      `</div>`
    : "";

  const content =
    `<p><strong>${eventCount}</strong> events since your last session summary:</p>` +
    listHtml +
    `<p style="margin-top:8px;font-size:12px;color:#999;">Events stay in memory either way — saving creates an AI journal recap.</p>`;

  const DV2 = foundry.applications?.api?.DialogV2;
  if (DV2) {
    return new Promise((resolve, reject) => {
      const dlg = new DV2({
        window: { title: "Close ACE?" },
        content,
        buttons: [
          { action: "save",     label: "Exit & Save Session",    icon: "fas fa-book-open",       default: true, callback: () => resolve("save") },
          { action: "exit",     label: "Exit Without Saving",    icon: "fas fa-door-open",                      callback: () => resolve("exit") },
          { action: "minimize", label: "Minimize ACE",           icon: "fas fa-window-minimize",                callback: () => resolve("minimize") }
        ],
        close: () => reject()
      });
      dlg.render(true);
    });
  }
  // Legacy Dialog fallback (v10/v11)
  return new Promise((resolve, reject) => {
    const d = new Dialog({
      title: "Close ACE?",
      content,
      buttons: {
        save:     { icon: '<i class="fas fa-book-open"></i>',       label: "Exit & Save Session",  callback: () => resolve("save") },
        exit:     { icon: '<i class="fas fa-door-open"></i>',       label: "Exit Without Saving",  callback: () => resolve("exit") },
        minimize: { icon: '<i class="fas fa-window-minimize"></i>', label: "Minimize ACE",         callback: () => resolve("minimize") }
      },
      default: "save",
      close: () => reject()
    });
    d.render(true);
  });
}

export class AcePanel extends foundry.applications.api.ApplicationV2 {
  constructor({ aiProvider, sceneCtx, npcMemory, lkMemory, suggestionEngine, reputationEngine, subtleRolls, documentEngine, digestEngine, worldBible, vaultEngine, vaultSearch, triggerSfx, stopSfx } = {}) {
    super();
    this.ai          = aiProvider;
    this.scene       = sceneCtx;
    this.memory      = npcMemory;
    this.lkMemory    = lkMemory  ?? null;   // AceMemory — persistent campaign log
    this.reputation  = reputationEngine ?? null;  // ReputationEngine — faction word-of-mouth
    this.subtleRolls = subtleRolls ?? null; // SubtleRollManager — blind checks with AI narration
    this._documentEngine = documentEngine ?? null; // DocumentEngine — reference library
    this._digestEngine   = digestEngine   ?? null; // DigestEngine — AI-powered structured digests
    this._worldBible     = worldBible     ?? null; // WorldBibleEngine — world reference bible
    this._vaultEngine    = vaultEngine    ?? null; // VaultEngine — cross-campaign archival
    this._vaultSearch    = vaultSearch    ?? null; // VaultSearch — cross-campaign queries
    this.suggestions = suggestionEngine;
    this.triggerSfx  = triggerSfx ?? (() => {});   // broadcasts SFX to all clients
    this.stopSfx     = stopSfx   ?? (() => {});   // stops SFX audio (thunder etc.)

    // ── Chat (AI private) ──────────────────────────────────
    this._chatHistory        = [];  // [{role, content, timestamp, isTactic?}]
    // ── Narration (to players) ─────────────────────────────
    this._narrationHistory   = [];  // [{content, timestamp}]
    this._narrationListening = false;
    this._narrationRecognition = null;
    this._isNarrationStreaming = false;
    this._voiceGender        = "auto";  // "auto" | "male" | "female"
    // ── Shared ─────────────────────────────────────────────
    this._directions         = [];  // story direction cards
    this._activeTab          = "chat";
    this._isStreaming         = false;
    this._unsubSuggestions   = null;
    this._positioned         = false;
    // ── Chat-tab voice ─────────────────────────────────────
    this._isListening        = false;  // quick-send mic
    this._recognition        = null;
    // ── TTS ────────────────────────────────────────────────
    this._ttsUtterance       = null;
    this._ttsAudio           = null;
    this._ttsAbort           = null;   // AbortController for in-flight ElevenLabs fetch
    this._ttsPlaying         = false;
    this._ttsPaused          = false;
    this._voicesReady        = false;
    this._browserTtsWarned   = false;
    // Kick-start browser voice loading (Chrome loads them async)
    this._ensureVoicesLoaded().catch(() => {});
    // ── Crit/Fumble ─────────────────────────────────────────
    this._lastCfHtml         = "";  // preserved across re-renders (popout/back)
    this._lastCfClass        = "";  // "ace-cf-crit" or "ace-cf-fumble"
    // ── Encounter ──────────────────────────────────────────
    this._lastEncounterText  = "";
    this._lastEncounterHtml  = "";  // preserved across re-renders (popout/back)
    this._encounterData      = null; // parsed structured encounter (interactive mode)
    this._compendiumIndexCache = new Map(); // packId → { index, time }
    this._expandedLibCards     = new Set(); // doc IDs expanded in Library (default: collapsed)
    this._compendiumCacheTTL = 300_000; // 5 minutes
    // ── Splash screen ─────────────────────────────────────
    this._showingSplash      = true;  // cinematic title card on first open
    this._splashTimer        = null;  // auto-dismiss timeout handle
    // ── Session memory ─────────────────────────────────────
    this._isGeneratingSummary = false;
    this._sessionNum          = null;  // set from world store in _onRenderReady
    // ── Minimize badge ───────────────────────────────────
    this._savedPosition       = null; // stores position before minimize
    // ── Simple Calendar sync listener ────────────────────
    this._timeSyncHookId = Hooks.on("ace-engine.timeSync", () => this._updateDayCounterUI());
    // ── Select Scene Elements ─────────────────────────────
    this._selectedTokens = new Set();   // actor IDs (players) or token IDs (NPCs)
    this._selectedTiles  = new Set();   // tile IDs
    this._selectedItems  = new Set();   // token IDs (item-type tokens)
    // ── NPC Speech (Select tab) ─────────────────────────
    this._npcSpeechListening    = false;
    this._npcSpeechRecognition  = null;
    // ── Tactical Command Center ──────────────────────────
    this._tccExpanded  = { stats: false, rolls: false, bulk: false, initiative: false };
    this._tccRollType  = "skill";   // "skill" | "save" | "check"
    this._tccRollMode  = "gm";     // "gm" | "subtle" | "request"
    // Per-roll-type selection memory. Toggling Skill/Save/Check or
    // GM/Subtle/Request used to wipe these back to defaults — now they
    // persist independently per roll type so the GM doesn't have to
    // re-pick Perception every time they tap Subtle.
    this._tccRollIds   = { skill: "prc", save: "wis", check: "wis" };
    this._tccDc        = 15;
    this._tccFlavor    = "";
    // ── Select panel collapsible sections ────────────────
    this._collapsedSections = { players: false, npcs: false, tiles: true, items: true };
    // ── Adventure / Survival Tracker ──────────────────────
    this._tracker = {
      scenesSinceMeal:  0,
      scenesSinceRest:  0,
      mealTime:  Date.now(),
      restTime:  Date.now(),
    };
  }

  static DEFAULT_OPTIONS = {
    id: "ace-panel",
    classes: ["ace-panel"],
    tag: "div",
    window: {
      title:       "ACE.Panel.Title",
      icon:        "fas fa-book-sparkles",
      resizable:   true,
      minimizable: true,
    },
    position: {
      width:  590,
      height: 740,
      top:    20,
      left:   200,   // Safe default — _onRender moves it to the right side
    },
    actions: {
      // ── Chat tab ───────────────────────────────────────
      sendMessage:         AcePanel._onSendMessage,
      clearChat:           AcePanel._onClearChat,
      voiceInput:          AcePanel._onVoiceInput,
      analyzeNpcTactics:   AcePanel._onAnalyzeNpcTactics,
      copyMessage:         AcePanel._onCopyMessage,
      sendToNarration:     AcePanel._onSendToNarration,
      saveToJournal:       AcePanel._onSaveToJournal,
      learnFromChat:       AcePanel._onLearnFromChat,
      // ── Narration tab ──────────────────────────────────
      narrationVoice:      AcePanel._onNarrationVoice,
      toggleVoiceGender:   AcePanel._onToggleVoiceGender,
      polishNarration:     AcePanel._onPolishNarration,
      narrateSend:         AcePanel._onNarrateSend,
      clearNarration:      AcePanel._onClearNarration,
      copyNarration:       AcePanel._onCopyNarration,
      sfxLightning:        AcePanel._onSfxLightning,
      sfxEarthquake:       AcePanel._onSfxEarthquake,
      sfxStealthFail:      AcePanel._onSfxStealthFail,
      sfxPerceptionPass:   AcePanel._onSfxPerceptionPass,
      // ── Ideas tab ──────────────────────────────────────
      generateSuggestions: AcePanel._onGenerateSuggestions,
      acceptDirection:     AcePanel._onAcceptDirection,
      dismissDirection:    AcePanel._onDismissDirection,
      // ── Encounter tab ──────────────────────────────────
      saveSceneDesc:       AcePanel._onSaveSceneDesc,
      clearSceneDesc:      AcePanel._onClearSceneDesc,
      deleteSceneDesc:     AcePanel._onDeleteSceneDesc,
      generateEncounter:   AcePanel._onGenerateEncounter,
      rollEncounter:       AcePanel._onRollEncounter,
      copyEncounterResult: AcePanel._onCopyEncounterResult,
      sendSubtleRoll:      AcePanel._onSendSubtleRoll,
      encounterScaleUp:    AcePanel._onEncounterScaleUp,
      encounterScaleDown:  AcePanel._onEncounterScaleDown,
      narrateEncounter:    AcePanel._onNarrateEncounter,
      // ── Shared (always visible) ────────────────────────
      switchTab:           AcePanel._onSwitchTab,
      stopAudio:           AcePanel._onStopAudio,
      /* ttsToggle/ttsStop removed — single stop button now */
      digestPause:         AcePanel._onDigestPause,
      endSession:          AcePanel._onEndSession,
      saveNote:            AcePanel._onSaveNote,
      // ── Splash screen ──────────────────────────────────
      openFromSplash:      AcePanel._onOpenFromSplash,
      closeSplash:         AcePanel._onCloseSplash,
      // ── Survival tracker & Day counter ────────────────
      mealReset:           AcePanel._onMealReset,
      restReset:           AcePanel._onRestReset,
      dayPrev:             AcePanel._onDayPrev,
      dayNext:             AcePanel._onDayNext,
      // ── Deed logger ───────────────────────────────────
      toggleDeedLogger:    AcePanel._onToggleDeedLogger,
      deedSubmit:          AcePanel._onDeedSubmit,
      deedVoice:           AcePanel._onDeedVoice,
      // ── Select Scene Elements ─────────────────────────
      toggleElement:       AcePanel._onToggleElement,
      clearSelection:      AcePanel._onClearSelection,
      toggleLink:          AcePanel._onToggleLink,
      generateBio:         AcePanel._onGenerateBio,
      generateItemBio:     AcePanel._onGenerateItemBio,
      generateAllItemBios: AcePanel._onGenerateAllItemBios,
      // ── NPC Speech (Select tab) ───────────────────────────
      npcSpeechSend:       AcePanel._onNpcSpeechSend,
      npcSpeechVoice:      AcePanel._onNpcSpeechVoice,
      npcSpeechStop:       AcePanel._onNpcSpeechStop,
      openSpeakAs:         AcePanel._onOpenSpeakAs,
      // Social Profile moved to ace-envoy
      // ── Tactical Command Center ────────────────────────
      tccToggleSection:    AcePanel._onTccToggleSection,
      tccGroupRoll:        AcePanel._onTccGroupRoll,
      tccBulkCondition:    AcePanel._onTccBulkCondition,
      tccBulkHp:           AcePanel._onTccBulkHp,
      tccInitJump:         AcePanel._onTccInitJump,
      tccInitMoveUp:       AcePanel._onTccInitMoveUp,
      tccInitMoveDown:     AcePanel._onTccInitMoveDown,
      // ── Crit / Fumble (auto-detected, copy only) ────────
      copyCritFumble:      AcePanel._onCopyCritFumble,
      // ── Memory Management ──────────────────────────────
      memoryManagement:    AcePanel._onMemoryManagement,
      openTtsSettings:     AcePanel._onOpenTtsSettings,
      // ── Minimize badge ────────────────────────────────
      minimizeToBadge:     AcePanel._onMinimizeToBadge,
      restoreFromBadge:    AcePanel._onRestoreFromBadge,
      badgeClose:          AcePanel._onBadgeClose,
      // ── Document Library ──────────────────────────────
      libUploadClick:      AcePanel._onLibUploadClick,
      libToggleCollapse:   AcePanel._onLibToggleCollapse,
      libToggleDoc:        AcePanel._onLibToggleDoc,
      libEditName:         AcePanel._onLibEditName,
      libEditYear:         AcePanel._onLibEditYear,
      libEditTags:         AcePanel._onLibEditTags,
      libDeleteDoc:        AcePanel._onLibDeleteDoc,
      libHardDeleteDoc:    AcePanel._onLibHardDeleteDoc,
      libNukeAll:          AcePanel._onLibNukeAll,
      libGenerateDigest:   AcePanel._onLibGenerateDigest,
      libToggleDigest:     AcePanel._onLibToggleDigest,
      libDeleteDigest:     AcePanel._onLibDeleteDigest,
      libBrowseDigest:     AcePanel._onLibBrowseDigest,
      libMergeIntoBible:   AcePanel._onLibMergeIntoBible,
      libMergeDigestIntoBible: AcePanel._onLibMergeDigestIntoBible,
      // ── World Bible ─────────────────────────────────
      worldBibleGenerate:  AcePanel._onWorldBibleGenerate,
      worldBibleRegenerate: AcePanel._onWorldBibleRegenerate,
      // ── Open Library window (replaces in-panel Library tab content) ──
      openLibrary:         AcePanel._onOpenLibrary,
    },
  };

  // ── Render ─────────────────────────────────────────────────

  async _renderHTML(context, options) {
    const html = document.createElement("div");
    html.classList.add("ace-wrapper");
    html.innerHTML = this._buildHTML();
    return html;
  }

  _replaceHTML(result, content, options) {
    // Don't wipe DOM while AI is streaming in any tab
    if (content.querySelector("#ace-chat-log") && this._isStreaming) return;
    content.replaceChildren(result);
  }

  _buildHTML() {
    if (this._showingSplash) return this._buildSplashHTML();
    // Include the minimize badge + normal panel
    return this._buildMiniBadgeHTML() + this._buildPanelHTML();
  }

  _buildMiniBadgeHTML() {
    return `
      <div class="ace-mini-badge" data-action="restoreFromBadge" title="Click to restore ACE">
        <span class="ace-rivet ace-rivet-nw"></span>
        <span class="ace-rivet ace-rivet-ne" data-action="badgeClose" title="Close ACE"></span>
        <span class="ace-rivet ace-rivet-sw"></span>
        <span class="ace-rivet ace-rivet-se"></span>
        <span class="ace-mini-text">ACE</span>
      </div>
    `;
  }

  _buildSplashHTML() {
    return `
      <!-- ── Cinematic Title Card ────────────────────────────── -->
      <div class="ace-splash" id="ace-splash" data-action="openFromSplash">

        <!-- Radial light rays behind the title -->
        <div class="ace-splash-rays"></div>

        <!-- Floating gold particles -->
        <div class="ace-splash-particles">
          <span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span>
          <span></span><span></span><span></span><span></span>
        </div>

        <!-- Horizontal lens flare -->
        <div class="ace-splash-flare"></div>

        <!-- Title block -->
        <div class="ace-splash-title">
          <h1 class="ace-splash-logo">ACE</h1>
          <div class="ace-splash-divider"></div>
          <div class="ace-splash-subtitle">AI CAMPAIGN ENGINE</div>
        </div>

        <!-- Small X — top-right, closes the panel entirely -->
        <button class="ace-splash-close"
                data-action="closeSplash"
                aria-label="Close ACE"
                title="Close (Esc)">
          <i class="fas fa-times"></i>
        </button>

      </div>
    `;
  }

  _buildPanelHTML() {
    return `
      <!-- ── Tab Bar (always visible) ───────────────────────── -->
      <nav class="ace-tabs">
        <button class="ace-tab ${this._activeTab === "chat" ? "active" : ""}"
                data-action="switchTab" data-tab="chat">
          <i class="fas fa-comments"></i> Chat
        </button>
        <button class="ace-tab ${this._activeTab === "narration" ? "active" : ""}"
                data-action="switchTab" data-tab="narration">
          <i class="fas fa-scroll"></i> Narration
        </button>
        <button class="ace-tab ${this._activeTab === "suggestions" ? "active" : ""}"
                data-action="switchTab" data-tab="suggestions">
          <i class="fas fa-compass"></i> Ideas
        </button>
        <button class="ace-tab ${this._activeTab === "encounter" ? "active" : ""}"
                data-action="switchTab" data-tab="encounter">
          <i class="fas fa-dice-d20"></i> Encounter
        </button>
        <button class="ace-tab ${this._activeTab === "elements" ? "active" : ""}"
                data-action="switchTab" data-tab="elements">
          <i class="fas fa-crosshairs"></i> Select
        </button>
        <button class="ace-tab ${this._activeTab === "library" ? "active" : ""}"
                data-action="switchTab" data-tab="library">
          <i class="fas fa-book-open"></i> Library
        </button>
        <!-- TTS Stop — single button, pulses red when audio is active -->
        <div class="ace-tts-controls" id="ace-tts-controls">
          <button class="ace-btn ace-btn-tts-main${this._ttsPlaying ? " ace-tts-active" : ""}" data-action="stopAudio"
                  title="Stop all audio"><i class="fas fa-stop"></i></button>
        </div>
      </nav>

      <!-- Survival tracker removed from UI (AI still tracks internally) -->

      <!-- ═══════════════════════════════════════════════════
           CHAT TAB — Private AI conversation (GM only)
           ═══════════════════════════════════════════════════ -->
      <div class="ace-tab-content ${this._activeTab === "chat" ? "active" : ""}" data-tab-content="chat">
        <div class="ace-chat-log" id="ace-chat-log">
          ${this._renderChatMessages()}
        </div>
        <!-- ── Gold Divider Bar with quick actions ── -->
        <div class="ace-gold-divider">
          <div class="ace-input-spacer"></div>
          <button class="ace-divider-action" data-action="clearChat"
                  title="Clear AI conversation">
            <i class="fas fa-trash-alt"></i> Clear
          </button>
          ${this._renderSessionRecapButton()}
        </div>
        <!-- ── Input Area ── -->
        <div class="ace-chat-input">
          <textarea id="ace-input" spellcheck="true"
                    placeholder="${game.i18n.localize("ACE.Panel.Placeholder")}"
                    rows="2"></textarea>
          <div class="ace-input-actions">
            <button class="ace-btn ace-btn-mic ${this._isListening ? "ace-btn-mic-active" : ""}"
                    data-action="voiceInput"
                    title="Quick voice — speaks and auto-sends to AI">
              <i class="fas ${this._isListening ? "fa-circle ace-mic-pulse" : "fa-microphone"}"></i>
            </button>
            <button class="ace-btn ace-btn-send" data-action="sendMessage"
                    ${this._isStreaming ? "disabled" : ""}
                    title="Send to AI (private — players do not see this)">
              <i class="fas fa-paper-plane"></i> Ask AI
            </button>
          </div>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════
           NARRATION TAB — Content broadcast to players
           ═══════════════════════════════════════════════════ -->
      <div class="ace-tab-content ${this._activeTab === "narration" ? "active" : ""}" data-tab-content="narration">
        <!-- History: what has been narrated to players this session -->
        <div class="ace-narration-log" id="ace-narration-log">
          ${this._renderNarrationMessages()}
        </div>
        <!-- ── Gold Divider Bar with SFX + Session actions ── -->
        <div class="ace-gold-divider">
          <button class="ace-divider-action" data-action="sfxLightning"
                  title="Lightning flash + booming thunder — all players see &amp; hear it">
            <i class="fas fa-bolt"></i> Thunder
          </button>
          <button class="ace-divider-action" data-action="sfxEarthquake"
                  title="Earthquake shake + falling debris + bass rumble — all players see &amp; hear it">
            <i class="fas fa-mountain"></i> Earthquake
          </button>
          <!-- Stealth/Perception buttons removed -->
          <div class="ace-input-spacer"></div>
          ${this._renderSessionRecapButton()}
        </div>
        <!-- Quick Note Bar -->
        <div class="ace-note-bar">
          <input type="text" id="ace-note-input" class="ace-note-input"
                 placeholder="Quick note to memory (e.g. Jeth stole dagger from Firaxis)…"
                 title="Save a note to ACE's persistent memory — not sent to players">
          <button class="ace-btn ace-btn-sm ace-btn-save-note" data-action="saveNote"
                  title="Save this note to ACE memory">
            <i class="fas fa-save"></i> Note
          </button>
        </div>
        <!-- Narration Input -->
        <div class="ace-chat-input">
          <textarea id="ace-narration-input" spellcheck="true"
                    placeholder="Type or speak narration to send to all players… (accepted story ideas stream here for review)"
                    rows="3"></textarea>
          <div class="ace-input-actions">
            <button class="ace-btn ace-btn-mic ${this._narrationListening ? "ace-btn-mic-active" : ""}"
                    data-action="narrationVoice"
                    title="Speak narration — fills textarea for review before sending">
              <i class="fas ${this._narrationListening ? "fa-circle ace-mic-pulse" : "fa-microphone"}"></i>
            </button>
            <button class="ace-btn ace-btn-narrate-send" data-action="narrateSend"
                    ${this._isNarrationStreaming ? "disabled" : ""}
                    title="Send narration to ALL players via Foundry chat + speak aloud">
              <i class="fas fa-scroll"></i> To Players
            </button>
            <div class="ace-input-spacer"></div>
            <button class="ace-btn ace-btn-voice-gender ${this._voiceGender === "female" ? "ace-voice-female" : this._voiceGender === "male" ? "ace-voice-male" : ""}"
                    data-action="toggleVoiceGender"
                    title="Voice gender: ${this._voiceGender ?? "auto"} — click to cycle (auto → male → female)">
              <i class="fas ${this._voiceGender === "female" ? "fa-venus" : this._voiceGender === "male" ? "fa-mars" : "fa-random"}"></i>
            </button>
            <button class="ace-btn ace-btn-polish" data-action="polishNarration"
                    title="AI Polish — add punctuation, capitalize, and clean up spoken text">
              <i class="fas fa-magic"></i>
            </button>
            <button class="ace-btn ace-btn-clear" data-action="clearNarration"
                    title="Clear narration history">
              <i class="fas fa-trash-alt"></i>
            </button>
          </div>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════
           IDEAS TAB — Story direction cards
           ═══════════════════════════════════════════════════ -->
      <div class="ace-tab-content ${this._activeTab === "suggestions" ? "active" : ""}" data-tab-content="suggestions">
        <div class="ace-ideas-toolbar">
          <span class="ace-ideas-hint"><i class="fas fa-compass"></i> Where should the story go next?</span>
        </div>
        <div class="ace-directions-list" id="ace-suggestions">
          ${this._renderSuggestions()}
        </div>
        <div class="ace-ideas-bottom-bar">
          <textarea id="ace-ideas-gm-input" rows="2" spellcheck="true"
            placeholder="Steer the AI: 'I like idea 2 but with zombies' or 'the party should find a hidden tomb soon'..."></textarea>
          <button class="ace-btn ace-btn-primary ace-btn-refresh-ideas" data-action="generateSuggestions">
            <i class="fas fa-sync-alt"></i> REFRESH IDEAS
          </button>
        </div>
        <div class="ace-gold-divider ace-recap-divider">${this._renderSessionRecapButton()}</div>
      </div>

      <!-- ═══════════════════════════════════════════════════
           ENCOUNTER TAB — Encounter generator
           ═══════════════════════════════════════════════════ -->
      <div class="ace-tab-content ${this._activeTab === "encounter" ? "active" : ""}" data-tab-content="encounter">
        <div class="ace-encounter-split">
          <!-- ── Top pane: GM Scene Notes ── -->
          <div class="ace-enc-pane ace-enc-pane-top" id="ace-enc-pane-top">
            <div class="ace-scene-desc-header">
              <i class="fas fa-scroll"></i> <span class="ace-scene-desc-label">GM Scene Notes</span>
              <span class="ace-scene-desc-name">${canvas?.scene?.name ?? "No scene"}</span>
              <button class="ace-scene-desc-btn" data-action="clearSceneDesc" title="Clear text area">
                <i class="fas fa-eraser"></i>
              </button>
              <button class="ace-scene-desc-btn ace-scene-desc-delete" data-action="deleteSceneDesc" title="Delete saved notes from this scene">
                <i class="fas fa-trash"></i>
              </button>
              <button class="ace-scene-desc-btn ace-scene-desc-save" data-action="saveSceneDesc" title="Save to this scene">
                <i class="fas fa-save"></i> Save
              </button>
            </div>
            ${(canvas?.scene?.flags?.["ace-engine"]?.sceneDescription) ? `<div class="ace-scene-desc-saved"><i class="fas fa-check-circle" style="color:#4caf50;margin-right:4px;"></i><strong>Saved notes:</strong> ${this._escapeHtml(canvas.scene.flags["ace-engine"].sceneDescription).slice(0, 200)}${canvas.scene.flags["ace-engine"].sceneDescription.length > 200 ? "..." : ""}</div>` : ""}
            <textarea class="ace-scene-desc-input" id="ace-scene-desc"
                      placeholder="Tell ACE about this scene — what does the party see? Only you (the GM) see this. ACE uses it to give better answers about this location."
                      spellcheck="true"></textarea>
          </div>

          <!-- ── Draggable gold divider ── -->
          <div class="ace-enc-divider" id="ace-enc-divider" title="Drag to resize">
            <span class="ace-enc-divider-grip"></span>
          </div>

          <!-- ── Bottom pane: Encounter Generator ── -->
          <div class="ace-enc-pane ace-enc-pane-bottom" id="ace-enc-pane-bottom">
            <div class="ace-context-toolbar ace-encounter-toolbar">
              <button class="ace-btn ace-btn-generate" data-action="generateEncounter">
                <i class="fas fa-dice-d20"></i> Generate
              </button>
              <button class="ace-btn ace-btn-roll-enc" data-action="rollEncounter"
                      title="Roll for a random encounter based on current terrain (hidden from players)">
                <i class="fas fa-dice"></i> Random Roll
              </button>
              <button class="ace-btn ace-btn-copy-enc" data-action="copyEncounterResult"
                      title="Copy result to clipboard" style="margin-left:auto">
                <i class="fas fa-copy"></i>
              </button>
            </div>
            <!-- Crit/fumble results appear here via auto-detection (no manual buttons) -->
            <div class="ace-cf-result ${this._lastCfClass}" id="ace-cf-result"${this._lastCfHtml ? "" : ' style="display:none"'}>${this._lastCfHtml}</div>

            <div class="ace-encounter-result" id="ace-encounter">
              ${this._lastEncounterHtml || `<p class="ace-placeholder">
                <strong>Generate</strong> — builds a complete, ready-to-run encounter from scratch.<br><br>
                <strong>Random Roll</strong> — secretly rolls based on current terrain. Clear, Signs of Danger, or full encounter.
              </p>`}
            </div>

            <!-- Prompt at bottom -->
            <div class="ace-encounter-gen-input-wrap">
              <textarea id="ace-encounter-prompt" spellcheck="true"
                        class="ace-encounter-gen-input"
                        placeholder="Describe what you want (e.g. 'goblin ambush on a forest road'). Leave blank to auto-generate from scene."
                        rows="2"></textarea>
            </div>
          </div>
        </div>
        <div class="ace-gold-divider ace-recap-divider">${this._renderSessionRecapButton()}</div>
      </div>

      <!-- ═══════════════════════════════════════════════════
           SELECT SCENE ELEMENTS TAB — Pick tokens/tiles/items for AI context
           ═══════════════════════════════════════════════════ -->
      <div class="ace-tab-content ${this._activeTab === "elements" ? "active" : ""}" data-tab-content="elements">
        ${this._buildSelectElementsPanel()}
        <div class="ace-gold-divider ace-recap-divider">${this._renderSessionRecapButton()}</div>
      </div>

      <!-- ═══════════════════════════════════════════════════
           LIBRARY TAB — Now just opens a dedicated window
           Library was pulled out of the panel because it's prep-time
           world-building, not in-session GM tooling. Bigger fonts and
           more screen space live in the dedicated LibraryWindow.
           ═══════════════════════════════════════════════════ -->
      <div class="ace-tab-content ${this._activeTab === "library" ? "active" : ""}" data-tab-content="library">
        <div class="ace-library-stub">
          <div class="ace-library-stub-icon"><i class="fa-solid fa-book-atlas"></i></div>
          <h2 class="ace-library-stub-title">ACE Library</h2>
          <p class="ace-library-stub-blurb">
            Upload sourcebooks, generate digests, browse extracted entities, and build your World Bible — all in a dedicated window with proper room to breathe.
          </p>
          <button class="ace-library-stub-btn" data-action="openLibrary">
            <i class="fa-solid fa-arrow-up-right-from-square"></i> Open Library
          </button>
        </div>
        <div class="ace-gold-divider ace-recap-divider">${this._renderSessionRecapButton()}</div>
      </div>
    `;
  }

  // ── Survival Bar Builder ────────────────────────────────────

  _buildSurvivalBar() {
    return `
      <div class="ace-survival-bar" id="ace-survival-bar">
        <span class="ace-survival-label">Track:</span>
        ${this._buildDayCounterHtml()}
        <span class="ace-survival-sep">|</span>
        <button class="ace-deed-toggle" data-action="toggleDeedLogger" title="Log a notable deed">📜</button>
      </div>
      ${this._buildDeedLoggerHtml()}
    `;
  }

  // ── Select Scene Elements — Data Gathering ────────────────

  /** Get player character tokens on the current scene only */
  _getPlayerTokens() {
    if (!canvas.ready || !canvas.tokens?.placeables) {
      // Fallback to user-assigned characters if canvas isn't ready
      const seen = new Set();
      const players = [];
      for (const user of game.users) {
        const actor = user.character;
        if (!actor || seen.has(actor.id)) continue;
        seen.add(actor.id);
        players.push({
          id: actor.id, name: actor.name,
          img: actor.prototypeToken?.texture?.src || actor.img,
          type: "player", selected: this._selectedTokens.has(actor.id),
          hp: actor.system?.attributes?.hp?.value ?? null,
          hpMax: actor.system?.attributes?.hp?.max ?? null,
        });
      }
      return players;
    }

    const seen = new Set();
    return canvas.tokens.placeables
      .filter(t => {
        const actor = t.actor;
        if (!actor || !actor.hasPlayerOwner) return false;
        if (t.document.hidden) return false;
        if (seen.has(actor.id)) return false;
        seen.add(actor.id);
        return true;
      })
      .map(t => ({
        id:       t.actor.id,
        name:     t.document.name,
        img:      t.document.texture?.src || t.actor?.prototypeToken?.texture?.src || t.actor?.img,
        type:     "player",
        selected: this._selectedTokens.has(t.actor.id),
        hp:       t.actor.system?.attributes?.hp?.value ?? null,
        hpMax:    t.actor.system?.attributes?.hp?.max ?? null,
      }));
  }

  /** Get NPC tokens in the current scene only */
  _getNPCTokens() {
    if (!canvas.tokens?.placeables) return [];
    return canvas.tokens.placeables
      .filter(t => {
        const actor = t.actor;
        return actor && !actor.hasPlayerOwner && actor.type === "npc";
      })
      .map(t => ({
        id:       t.id,
        actorId:  t.actor?.id,
        name:     t.document.name,
        img:      t.document.texture?.src || t.actor?.prototypeToken?.texture?.src || t.actor?.img,
        type:     "npc",
        selected: this._selectedTokens.has(t.id),
        hp:       t.actor?.system?.attributes?.hp?.value ?? null,
        hpMax:    t.actor?.system?.attributes?.hp?.max ?? null,
        defeated: t.combatant?.defeated ?? false,
      }));
  }

  /** Get tiles placed on the current scene canvas */
  _getTiles() {
    if (!canvas.tiles?.placeables) return [];
    return canvas.tiles.placeables
      .filter(t => t.document.texture?.src)
      .map(t => ({
        id:       t.id,
        name:     t.document.flags?.label || `Tile ${t.id.slice(0, 6)}`,
        img:      t.document.texture.src,
        type:     "tile",
        selected: this._selectedTiles.has(t.id),
      }));
  }

  /** Get item-type tokens placed on the scene canvas */
  _getSceneItems() {
    if (!canvas.tokens?.placeables) return [];
    return canvas.tokens.placeables
      .filter(t => {
        const actor = t.actor;
        // Catch tokens that aren't PCs or standard NPCs (vehicle, loot, etc.)
        return actor && actor.type !== "character" && actor.type !== "npc";
      })
      .map(t => ({
        id:       t.id,
        actorId:  t.actor?.id,
        name:     t.document.name,
        img:      t.document.texture?.src || t.actor?.prototypeToken?.texture?.src || t.actor?.img,
        type:     "item",
        selected: this._selectedItems.has(t.id),
      }));
  }

  // ── Select Scene Elements — HTML Builder ──────────────────

  _buildSelectElementsPanel() {
    const players = this._getPlayerTokens();
    const npcs    = this._getNPCTokens();
    const tiles   = this._getTiles();
    const items   = this._getSceneItems();
    const total   = this._selectedTokens.size + this._selectedTiles.size + this._selectedItems.size;

    return `
      <div class="ace-select-panel">

        <!-- Header bar -->
        <div class="ace-select-header">
          <span class="ace-select-title"><i class="fas fa-crosshairs"></i> Scene Elements</span>
          <span class="ace-select-count" title="Total selected">${total} selected</span>
          <button class="ace-btn ace-btn-sm" data-action="analyzeNpcTactics"
                  title="Get a specific tactic suggestion for the current NPC's turn">
            <i class="fas fa-chess-knight"></i> NPC Tactics
          </button>
          <button class="ace-btn ace-btn-sm" data-action="clearSelection" title="Clear all selections">
            <i class="fas fa-times-circle"></i> Clear
          </button>
        </div>

        <!-- Players Section — always available -->
        <section class="ace-el-section${this._collapsedSections?.players ? " collapsed" : ""}" data-el-section="players">
          <h4 class="ace-el-section-header" data-action="toggleElSection" data-el-section="players">
            <i class="fas fa-users"></i> Players <span class="ace-el-count">${players.length}</span>
            <i class="fas fa-chevron-down ace-el-chevron"></i>
          </h4>
          <div class="ace-el-section-body"${this._collapsedSections?.players ? ' style="display:none"' : ""}>
            ${players.length ? `<div class="ace-el-grid">${players.map(p => this._buildElementCard(p)).join("")}</div>`
              : `<p class="ace-el-empty">No player characters assigned</p>`}
          </div>
        </section>

        <!-- NPCs Section — current scene only -->
        <section class="ace-el-section${this._collapsedSections?.npcs ? " collapsed" : ""}" data-el-section="npcs">
          <h4 class="ace-el-section-header" data-action="toggleElSection" data-el-section="npcs">
            <i class="fas fa-skull"></i> NPCs <span class="ace-el-count">${npcs.length}</span>
            <i class="fas fa-chevron-down ace-el-chevron"></i>
          </h4>
          <div class="ace-el-section-body"${this._collapsedSections?.npcs ? ' style="display:none"' : ""}>
            ${npcs.length ? `<div class="ace-el-grid">${npcs.map(n => this._buildElementCard(n)).join("")}</div>`
              : `<p class="ace-el-empty">No NPCs in current scene</p>`}
          </div>
        </section>

        ${this._buildNpcSpeechBox()}

        <!-- Tiles Section — current scene only -->
        <section class="ace-el-section${this._collapsedSections?.tiles ? " collapsed" : ""}" data-el-section="tiles">
          <h4 class="ace-el-section-header" data-action="toggleElSection" data-el-section="tiles">
            <i class="fas fa-image"></i> Tiles <span class="ace-el-count">${tiles.length}</span>
            <i class="fas fa-chevron-down ace-el-chevron"></i>
          </h4>
          <div class="ace-el-section-body"${this._collapsedSections?.tiles ? ' style="display:none"' : ""}>
            ${tiles.length ? `<div class="ace-el-grid">${tiles.map(t => this._buildElementCard(t)).join("")}</div>`
              : `<p class="ace-el-empty">No tiles in current scene</p>`}
          </div>
        </section>

        <!-- Items Section — current scene only -->
        <section class="ace-el-section${this._collapsedSections?.items ? " collapsed" : ""}" data-el-section="items">
          <h4 class="ace-el-section-header" data-action="toggleElSection" data-el-section="items">
            <i class="fas fa-gem"></i> Items <span class="ace-el-count">${items.length}</span>
            <i class="fas fa-chevron-down ace-el-chevron"></i>
          </h4>
          <div class="ace-el-section-body"${this._collapsedSections?.items ? ' style="display:none"' : ""}>
            ${items.length ? `<div class="ace-el-grid">${items.map(it => this._buildElementCard(it)).join("")}</div>`
              : `<p class="ace-el-empty">No items placed in current scene</p>`}
          </div>
        </section>

        ${this._buildInventoryPanel()}

        ${this._buildTccBar()}

      </div>
    `;
  }

  // ── Inventory Panel — shows selected token's items for bio generation ──

  _buildInventoryPanel() {
    // Only show when exactly one NPC/creature token is selected
    const selected = this._resolveSelectedActors();
    if (selected.length !== 1) return "";

    const { actor } = selected[0];
    if (!actor || actor.hasPlayerOwner) return "";

    // Get all non-natural items
    const items = [...(actor.items ?? [])]
      .filter(i => ["weapon", "equipment", "loot", "consumable", "tool", "armor"].includes(i.type))
      .filter(i => !AcePanel._isNaturalWeapon(i))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!items.length) return "";

    return `
      <section class="ace-el-section ace-inventory-section">
        <h4 class="ace-el-section-header">
          <i class="fas fa-box-open"></i> ${actor.name}'s Inventory
          <span class="ace-el-count">${items.length}</span>
          <button class="ace-btn ace-btn-sm ace-inventory-bio-all"
                  data-action="generateAllItemBios"
                  data-actor-id="${actor.id}"
                  title="Generate bios for all items without descriptions">
            <i class="fas fa-magic"></i> Bio All
          </button>
        </h4>
        <div class="ace-inventory-grid">
          ${items.map(item => this._buildItemCard(item, actor)).join("")}
        </div>
      </section>
    `;
  }

  _buildItemCard(item, actor) {
    const desc = (item.system?.description?.value || "").replace(/<[^>]+>/g, "").trim();
    const hasDesc = desc.length > 20;
    const rarity = item.system?.rarity || "common";

    const safeName = this._escapeHtml(item.name);
    return `
      <div class="ace-inventory-item ${hasDesc ? "ace-item-has-bio" : ""}" title="${safeName} (${rarity})">
        <img class="ace-inventory-item-img" src="${item.img}" alt="" loading="lazy"
             onerror="this.src='icons/svg/item-bag.svg'" />
        <div class="ace-inventory-item-info">
          <span class="ace-inventory-item-name">${safeName}</span>
          <span class="ace-inventory-item-meta">${item.type} · <span class="ace-rarity-${rarity}">${rarity}</span></span>
        </div>
        <button class="ace-el-bio-btn"
                data-action="generateItemBio"
                data-actor-id="${actor.id}"
                data-item-id="${item.id}"
                title="${hasDesc ? "Regenerate" : "Generate"} item bio">
          <i class="fas ${hasDesc ? "fa-check-circle" : "fa-feather-alt"}"></i>
        </button>
      </div>
    `;
  }

  // ── NPC Speech Box — "Speaking as [NPC]" ──────────────────

  /**
   * Returns the single selected NPC actor (if exactly one NPC is selected).
   * Returns null if 0, 2+, or only players are selected.
   */
  _getSelectedNpcForSpeech() {
    const selected = this._resolveSelectedActors();
    const npcs = selected.filter(s => !s.isPlayer && s.actor?.type === "npc");
    if (npcs.length !== 1) return null;
    return npcs[0];
  }

  /**
   * Like _getSelectedNpcForSpeech but accepts ANY single selected actor —
   * NPC or player character. Used by the "Speak as" button so the GM can
   * voice player characters too (fun for cutscene narration / out-of-game
   * moments).
   */
  _getSelectedTokenForSpeakAs() {
    const selected = this._resolveSelectedActors();
    if (selected.length !== 1) return null;
    const only = selected[0];
    if (!only?.actor) return null;
    return only;
  }

  _buildNpcSpeechBox() {
    // Replaced the old inline speech box with a single full-width button.
    // Pressing it opens the floating Speak-As window (the same compact
    // dictation tool the chat icon on an NPC token opens). Works for ANY
    // single selected token — NPC or player character.
    const sel = this._getSelectedTokenForSpeakAs();
    if (!sel) return "";

    const { actor } = sel;
    const safeName  = this._escapeHtml(actor.name);
    const kind      = actor.hasPlayerOwner ? "Player" : "NPC";

    return `
      <button class="ace-speak-as-btn" data-action="openSpeakAs"
              title="Open the Speak-As window — type or dictate what ${safeName} says, voice plays for everyone">
        <i class="fas fa-comment-dots"></i>
        Speak as <strong>${safeName}</strong>
        <span class="ace-speak-as-kind">${kind}</span>
      </button>
    `;
  }

  _buildElementCard(el) {
    // Check if this NPC's actor is ACE-linked (persistent memory flag)
    const isLinked = el.type === "npc" && el.actorId && this._isActorLinked(el.actorId);
    const linkedClass = isLinked ? "ace-el-linked" : "";

    // Dead/defeated detection
    const isDead = (el.hp !== null && el.hp !== undefined && el.hp <= 0) || el.defeated;
    const deadClass = isDead ? "ace-el-defeated" : "";

    return `
      <div class="ace-el-card ${el.selected ? "ace-el-selected" : ""} ${linkedClass} ${deadClass}"
           data-action="toggleElement"
           data-el-id="${el.id}" data-el-type="${el.type}"
           data-actor-id="${el.actorId ?? ""}"
           title="${el.name}${isLinked ? " (ACE Linked — memory persists)" : ""}${isDead ? " [DEAD]" : ""}">
        <div class="ace-el-img-wrap">
          ${/\.(webm|mp4)$/i.test(el.img)
            ? `<video class="ace-el-img" src="${el.img}" autoplay loop muted playsinline
                   onerror="this.outerHTML='<img class=\\'ace-el-img\\' src=\\'icons/svg/mystery-man.svg\\'/>'"></video>`
            : `<img class="ace-el-img" src="${el.img}" alt="${el.name}" loading="lazy"
                   onerror="this.src='icons/svg/mystery-man.svg'"/>`}
          <div class="ace-el-check"><i class="fas fa-check"></i></div>
        </div>
        <span class="ace-el-name">${el.name}</span>
        <div class="ace-el-btn-group">
          ${el.type === "npc" && el.actorId ? `
            <button class="ace-el-link-btn ${isLinked ? "ace-el-link-active" : ""}"
                    data-action="toggleLink"
                    data-actor-id="${el.actorId}"
                    title="${isLinked ? "Unlink — stop tracking this NPC" : "Link — ACE will remember this NPC across scenes"}">
              <i class="fas ${isLinked ? "fa-link" : "fa-unlink"}"></i>
            </button>
          ` : ""}
          ${(el.type === "npc" || el.type === "item") && el.actorId ? `
            <button class="ace-el-bio-btn"
                    data-action="generateBio"
                    data-actor-id="${el.actorId}"
                    title="Generate AI biography">
              <i class="fas fa-feather-alt"></i>
            </button>
          ` : ""}
        </div>
      </div>
    `;
  }

  /** Check if an actor has the ACE linked flag */
  _isActorLinked(actorId) {
    const actor = game.actors?.get(actorId);
    return actor?.getFlag("ace-engine", "linked") === true;
  }

  // ── Select Scene Elements — Actions ───────────────────────

  static _onToggleElement(event, target) {
    const id   = target.closest("[data-el-id]")?.dataset.elId;
    const type = target.closest("[data-el-type]")?.dataset.elType;
    if (!id || !type) return;

    const set = type === "tile"  ? this._selectedTiles
              : type === "item"  ? this._selectedItems
              :                    this._selectedTokens;

    if (set.has(id)) {
      set.delete(id);
      target.closest(".ace-el-card")?.classList.remove("ace-el-selected");
      // Clear canvas highlight when deselecting (mouseleave may not fire on click)
      CanvasHighlight.unhighlight(id, type);
    } else {
      set.add(id);
      target.closest(".ace-el-card")?.classList.add("ace-el-selected");
    }

    // Update counter without full re-render
    const counter = this.element.querySelector(".ace-select-count");
    if (counter) {
      const total = this._selectedTokens.size + this._selectedTiles.size + this._selectedItems.size;
      counter.textContent = `${total} selected`;
    }

    // ── Canvas selection sync: select/deselect the matching placeable ──
    const selected = set.has(id);
    if (type === "tile") {
      const tile = canvas?.tiles?.placeables?.find(t => t.id === id);
      if (tile) selected ? tile.control({ releaseOthers: false }) : tile.release();
    } else if (type === "player" || type === "npc" || type === "item") {
      const tok = canvas?.tokens?.placeables?.find(t => t.id === id || t.actor?.id === id);
      if (tok) selected ? tok.control({ releaseOthers: false }) : tok.release();
    }

    // Pan canvas to token if exactly ONE element is selected total
    if (selected && type !== "tile") {
      const totalSelected = this._selectedTokens.size + this._selectedTiles.size + this._selectedItems.size;
      if (totalSelected === 1) {
        const tok = canvas?.tokens?.placeables?.find(t => t.id === id || t.actor?.id === id);
        if (tok) {
          canvas.animatePan({ x: tok.center.x, y: tok.center.y, duration: 500 });
        }
      }
    }

    // Refresh Quick Stats if expanded
    this.refreshTccStats();
    // Refresh NPC speech box (appears/disappears based on selection)
    this._refreshNpcSpeechBox();
  }

  static _onClearSelection() {
    this._selectedTokens.clear();
    this._selectedTiles.clear();
    this._selectedItems.clear();
    // Clear all canvas highlights (DOM replacement kills mouseleave events)
    CanvasHighlight.clearAll();
    // Release all canvas selections
    canvas?.tokens?.releaseAll();
    canvas?.tiles?.releaseAll();
    // Re-render just the select panel content
    const container = this.element.querySelector('[data-tab-content="elements"]');
    if (container) container.innerHTML = this._buildSelectElementsPanel();
    this._wireSelectPanelEvents();
  }

  // ── Speak-As Button — Actions & Helpers ──────────────────

  /**
   * Re-render the Speak-As button (or remove it) without touching the
   * rest of the Select panel. Called whenever the token selection
   * changes so the button always reflects the current single-selection.
   */
  _refreshNpcSpeechBox() {
    const existing = this.element?.querySelector(".ace-speak-as-btn");
    const newHtml  = this._buildNpcSpeechBox();

    if (existing && !newHtml) {
      // Selection cleared / multi-select — remove the button
      existing.remove();
    } else if (!existing && newHtml) {
      // Single token selected — insert after the NPC section
      const npcSection = this.element?.querySelectorAll(".ace-el-section")?.[1];
      if (npcSection) npcSection.insertAdjacentHTML("afterend", newHtml);
    } else if (existing && newHtml) {
      // Different token selected — replace in place
      existing.outerHTML = newHtml;
    }
  }

  /** Wire Enter key on the NPC speech textarea. */
  _wireNpcSpeechEvents() {
    const input = this.element?.querySelector("#ace-npc-speech-input");
    if (!input) return;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._npcSpeechSend();
      }
    });
  }

  /** Send NPC speech: TTS + chat + memory. */
  async _npcSpeechSend() {
    if (this._npcSpeechListening) this._stopNpcSpeechVoice();

    const input = this.element?.querySelector("#ace-npc-speech-input");
    const raw = input?.value?.trim();
    if (!raw) return;
    input.value = "";

    const text = this._cleanupTranscript(raw);

    const npc = this._getSelectedNpcForSpeech();
    if (!npc) {
      ui.notifications?.warn("ACE: Select a single NPC to speak as.");
      return;
    }

    const { actor } = npc;
    const safeName = this._escapeHtml(actor.name);
    const safeText = this._escapeHtml(text);

    // ── Post to Foundry chat as the NPC ──
    const chatContent =
      `<div style="border-left:3px solid #8b5cf6; padding:6px 12px; margin:0; ` +
      `background:rgba(139,92,246,0.07); border-radius:0 4px 4px 0;">` +
      `<span style="display:block; font-size:10px; color:#8b5cf6; text-transform:uppercase; ` +
      `letter-spacing:1px; margin-bottom:4px; font-weight:bold;">` +
      `<i class="fas fa-comments"></i> ${safeName}</span>` +
      `<span style="font-style:italic; line-height:1.5;">"${safeText}"</span></div>`;

    // Find the token for this NPC to use as speaker
    const token = canvas?.tokens?.placeables?.find(t => t.actor?.id === actor.id);

    await ChatMessage.create({
      content: chatContent,
      speaker: {
        alias: actor.name,
        actor: actor.id,
        token: token?.id ?? null,
        scene: canvas?.scene?.id ?? null,
      },
      flags: { "ace-engine": { isNpcSpeech: true } },
    });

    // ── Save to memory ──
    this.lkMemory?.logNarration?.(`[${actor.name}] "${text}"`, canvas?.scene?.name);

    // ── TTS lookup — voice flags moved from ace-envoy to ace-engine in
    //                 the merger. Try engine flags first (canonical),
    //                 fall back to envoy flags for legacy data. For
    //                 unlinked tokens, voice may sit on the synthetic
    //                 ActorDelta actor so check it first.
    const tokenDoc       = npc.token?.document ?? null;
    const effectiveActor = (tokenDoc && !tokenDoc.actorLink && tokenDoc.actor)
                         ? tokenDoc.actor
                         : actor;
    const voiceId    = effectiveActor.getFlag(MODULE_ID, "voiceId")
                    || actor.getFlag(MODULE_ID, "voiceId")
                    || actor.getFlag("ace-envoy", "voiceId")
                    || "";
    const voiceMuted = effectiveActor.getFlag(MODULE_ID, "voiceMuted")
                    ?? actor.getFlag(MODULE_ID, "voiceMuted")
                    ?? actor.getFlag("ace-envoy", "voiceMuted")
                    ?? false;

    if (voiceMuted) {
      ui.notifications?.info(`ACE: ${actor.name} is muted — text posted to chat only.`);
      return;
    }
    if (!voiceId) {
      ui.notifications?.warn(`ACE: ${actor.name} has no voice assigned. Open AI Setup on this NPC to pick a voice.`);
      return;
    }

    const voiceSettings = effectiveActor.getFlag(MODULE_ID, "voiceSettings")
                       || actor.getFlag(MODULE_ID, "voiceSettings")
                       || actor.getFlag("ace-envoy", "voiceSettings")
                       || { stability: 0.5, similarity_boost: 0.8, style: 0.35 };

    await this._speakAsNpc(text, voiceId, voiceSettings);
  }

  /**
   * Speak text using a specific ElevenLabs voice ID + settings (from Envoy flags).
   * Broadcasts audio to all players via socket.
   */
  async _speakAsNpc(text, voiceId, voiceSettings) {
    this._cancelTTS();
    const clean = this._cleanForSpeech(text);
    if (!clean) return;

    const { key: apiKey } = this._getElevenLabsKey();
    if (!apiKey) {
      ui.notifications?.warn("ACE: No ElevenLabs API key configured. Set it in Module Settings.");
      return;
    }

    const modelId = localCredentials?.elevenLabsModel
      || game.settings.get(MODULE_ID, "elevenLabsModel")
      || "eleven_multilingual_v2";

    const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    console.log(`${MODULE_ID} | NPC Speech: voice=${voiceId}, model=${modelId}`);

    // v3 model only accepts discrete stability values: 0.0, 0.5, or 1.0
    let stability = voiceSettings.stability ?? 0.5;
    if (modelId === "eleven_v3") {
      stability = stability <= 0.25 ? 0.0 : stability >= 0.75 ? 1.0 : 0.5;
    }

    try {
      this._ttsAbort = new AbortController();
      this._updateTtsUI();   // pulse the stop button immediately while fetching
      const timeout = setTimeout(() => this._ttsAbort?.abort(), 30_000);
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", "Accept": "audio/mpeg" },
        body: JSON.stringify({
          text: clean,
          model_id: modelId,
          voice_settings: {
            stability,
            similarity_boost: voiceSettings.similarity_boost ?? 0.8,
            style: voiceSettings.style ?? 0.35,
            use_speaker_boost: true,
          },
        }),
        signal: this._ttsAbort.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        console.warn(`${MODULE_ID} | ElevenLabs NPC speech error ${resp.status}`);
        ui.notifications?.warn(`ACE: ElevenLabs returned ${resp.status} — check your API key and voice ID.`);
        return;
      }

      const blob = await resp.blob();

      // Broadcast to all players
      try {
        const base64 = await AcePanel._blobToBase64(blob);
        if (base64.length < 700_000) {
          game.socket.emit(`module.${MODULE_ID}`, {
            type: "narration-audio",
            audio: base64,
            userId: game.user.id,
          });
          console.log(`${MODULE_ID} | NPC Speech: broadcast audio (${(base64.length / 1024).toFixed(0)} KB)`);
        } else {
          console.warn(`${MODULE_ID} | NPC Speech: audio too large for socket (${(base64.length / 1024).toFixed(0)} KB)`);
        }
      } catch (bcastErr) {
        console.warn(`${MODULE_ID} | NPC Speech: broadcast failed:`, bcastErr);
      }

      // Play locally for GM
      const blobUrl = URL.createObjectURL(blob);
      this._ttsAudio = new Audio(blobUrl);
      this._ttsAudio.playbackRate = 1.0; // NPC speech at normal speed (not narrator 1.1x)
      this._ttsAudio.onended = () => {
        URL.revokeObjectURL(blobUrl);
        this._ttsAudio = null;
        this._ttsPlaying = false;
        this._ttsPaused = false;
        this._updateTtsUI();
      };
      this._ttsAudio.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        this._ttsAudio = null;
        this._ttsPlaying = false;
        this._ttsPaused = false;
        this._updateTtsUI();
      };
      this._ttsPlaying = true;
      this._ttsPaused = false;
      this._updateTtsUI();
      await this._ttsAudio.play();
    } catch (err) {
      console.error(`${MODULE_ID} | NPC Speech TTS failed:`, err);
      ui.notifications?.warn("ACE: NPC voice playback failed — check console.");
    }
  }

  // ── NPC Speech — Action handlers ──

  /**
   * Open the floating Speak-As window for whichever single token is
   * currently selected in the panel. Works for both NPC and PC tokens.
   * If a window is already open for this actor, focus it instead of
   * spawning a duplicate.
   */
  static async _onOpenSpeakAs(event, target) {
    const sel = this._getSelectedTokenForSpeakAs();
    if (!sel) {
      ui.notifications?.warn("ACE: Select a single token first.");
      return;
    }
    try {
      const { npcChatState } = await import("./npc/activate.mjs");
      const tokenDoc = sel.token?.document ?? null;
      const puppetKey = (tokenDoc && !tokenDoc.actorLink)
                     ? `tok:${tokenDoc.id}`
                     : sel.actor.id;
      const existing = npcChatState?.gmPuppets?.get?.(puppetKey);
      if (existing) {
        existing.render(true);
        try { existing.bringToTop?.(); } catch (_) {}
        return;
      }
      const { GmPuppetApp } = await import("./npc/gm-puppet-app.mjs");
      const puppet = new GmPuppetApp(sel.actor, { tokenDocument: tokenDoc });
      npcChatState?.gmPuppets?.set?.(puppetKey, puppet);
      puppet.render(true);
    } catch (err) {
      console.error(`${MODULE_ID} | Open Speak-As failed:`, err);
      ui.notifications?.error("ACE: Failed to open Speak-As window — see console.");
    }
  }

  static async _onNpcSpeechSend(event, target) {
    await this._npcSpeechSend();
  }

  static _onNpcSpeechVoice(event, target) {
    if (this._npcSpeechListening) {
      this._stopNpcSpeechVoice();
    } else {
      this._startNpcSpeechVoice();
    }
  }

  static _onNpcSpeechStop(event, target) {
    this._cancelTTS();
  }

  _startNpcSpeechVoice() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      ui.notifications?.warn("ACE: Speech recognition not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    const textarea = this.element?.querySelector("#ace-npc-speech-input");
    if (!textarea) return;

    // ── Edit-Aware Committed Baseline (same pattern as chat/narration) ──
    this._npcVoiceBaseline    = textarea.value;
    this._npcVoiceLastInterim = "";

    // Detect manual edits while voice is active
    this._npcVoiceInputHandler = () => {
      if (!this._npcSpeechListening) return;
      const el = this.element?.querySelector("#ace-npc-speech-input");
      if (!el) return;
      let val = el.value;
      if (this._npcVoiceLastInterim && val.endsWith(this._npcVoiceLastInterim)) {
        val = val.slice(0, -this._npcVoiceLastInterim.length);
      }
      this._npcVoiceBaseline    = val;
      this._npcVoiceLastInterim = "";
    };
    textarea.addEventListener("input", this._npcVoiceInputHandler);

    recognition.onresult = (e) => {
      let newFinal = "";
      let interim  = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          newFinal += e.results[i][0].transcript;
        } else {
          interim += e.results[i][0].transcript;
        }
      }

      if (newFinal) this._npcVoiceBaseline += newFinal;
      this._npcVoiceLastInterim = interim;

      const freshTA = this.element?.querySelector("#ace-npc-speech-input");
      if (freshTA) freshTA.value = this._npcVoiceBaseline + interim;
    };

    recognition.onerror = (e) => {
      console.warn(`${MODULE_ID} | NPC speech recognition error:`, e.error);
      if (e.error !== "no-speech" && e.error !== "aborted") {
        this._stopNpcSpeechVoice();
      }
    };

    recognition.onend = () => {
      if (this._npcSpeechListening) {
        try { recognition.start(); } catch (_) { this._stopNpcSpeechVoice(); }
      }
    };

    this._npcSpeechRecognition = recognition;
    this._npcSpeechListening = true;
    recognition.start();

    // Update mic button visual
    const micBtn = this.element?.querySelector('[data-action="npcSpeechVoice"]');
    if (micBtn) {
      micBtn.classList.add("ace-btn-mic-active");
      micBtn.innerHTML = '<i class="fas fa-circle ace-mic-pulse"></i>';
    }
  }

  _stopNpcSpeechVoice() {
    if (this._npcSpeechRecognition) {
      this._npcSpeechRecognition.onresult = null;
      this._npcSpeechRecognition.onend    = null;
      this._npcSpeechRecognition.onerror  = null;
      this._npcSpeechListening = false;
      try { this._npcSpeechRecognition.stop(); } catch (_) {}
      this._npcSpeechRecognition = null;
    }
    this._npcSpeechListening = false;

    // Remove manual-edit listener
    const textarea = this.element?.querySelector("#ace-npc-speech-input");
    if (textarea && this._npcVoiceInputHandler) {
      textarea.removeEventListener("input", this._npcVoiceInputHandler);
    }
    this._npcVoiceInputHandler = null;
    this._npcVoiceBaseline     = "";
    this._npcVoiceLastInterim  = "";

    // Update mic button visual
    const micBtn = this.element?.querySelector('[data-action="npcSpeechVoice"]');
    if (micBtn) {
      micBtn.classList.remove("ace-btn-mic-active");
      micBtn.innerHTML = '<i class="fas fa-microphone"></i>';
    }
  }

  // ── Canvas → Panel sync (called from controlToken / controlTile hooks) ──

  /**
   * Sync a token's controlled state on the canvas back to the panel grid.
   * @param {Token} token        The canvas Token placeable
   * @param {boolean} controlled true = selected, false = deselected
   */
  syncTokenControlled(token, controlled) {
    if (!this.rendered) return;
    const actor    = token.actor;
    const isPlayer = actor?.hasPlayerOwner && actor?.type === "character";

    // Players are stored by actor.id, NPCs/items by token.id
    const id = isPlayer ? actor?.id : token.id;
    if (!id) return;

    // Determine which set this token belongs to
    // Items have no actor; NPCs have actor but are not player-owned
    const set = this._selectedTokens;   // players + NPCs share this set
    // Check if it might be in _selectedItems (item-type tokens)
    const isItem = !actor || (actor.type !== "character" && actor.type !== "npc");
    const targetSet = isItem ? this._selectedItems : set;

    const wasSelected = targetSet.has(id);
    if (controlled && wasSelected) return;   // already in sync
    if (!controlled && !wasSelected) return;  // already in sync

    if (controlled) {
      targetSet.add(id);
    } else {
      targetSet.delete(id);
    }

    // Update the card UI
    const card = this.element.querySelector(`.ace-el-card[data-el-id="${id}"]`);
    if (card) {
      card.classList.toggle("ace-el-selected", controlled);
    }

    // Update counter
    const counter = this.element.querySelector(".ace-select-count");
    if (counter) {
      const total = this._selectedTokens.size + this._selectedTiles.size + this._selectedItems.size;
      counter.textContent = `${total} selected`;
    }

    // Refresh Quick Stats
    this.refreshTccStats();
    // Refresh NPC speech box
    this._refreshNpcSpeechBox();
  }

  /**
   * Sync a tile's controlled state on the canvas back to the panel grid.
   * @param {Tile} tile          The canvas Tile placeable
   * @param {boolean} controlled true = selected, false = deselected
   */
  syncTileControlled(tile, controlled) {
    if (!this.rendered) return;
    const id = tile.id;
    if (!id) return;

    const wasSelected = this._selectedTiles.has(id);
    if (controlled && wasSelected) return;
    if (!controlled && !wasSelected) return;

    if (controlled) {
      this._selectedTiles.add(id);
    } else {
      this._selectedTiles.delete(id);
    }

    const card = this.element.querySelector(`.ace-el-card[data-el-id="${id}"]`);
    if (card) {
      card.classList.toggle("ace-el-selected", controlled);
    }

    const counter = this.element.querySelector(".ace-select-count");
    if (counter) {
      const total = this._selectedTokens.size + this._selectedTiles.size + this._selectedItems.size;
      counter.textContent = `${total} selected`;
    }

    this.refreshTccStats();
  }

  /**
   * Toggle the ACE "linked" flag on an NPC actor.
   * Linked actors get persistent memory, journal entries, and are
   * automatically recognized across all scenes and sessions.
   */
  static async _onToggleLink(event, target) {
    event.stopPropagation();   // don't trigger card selection
    const actorId = target.closest("[data-actor-id]")?.dataset.actorId;
    if (!actorId) return;

    const actor = game.actors?.get(actorId);
    if (!actor) return;

    const currentlyLinked = actor.getFlag("ace-engine", "linked") === true;
    const newState = !currentlyLinked;

    // Set the flag on the actor — persists to the Actors sidebar entry
    await actor.setFlag("ace-engine", "linked", newState);

    // If newly linked, register in NPC memory and write journal
    if (newState) {
      const aceMemory = game.modules.get("ace-engine")?.api?.getMemoryManager?.();
      if (aceMemory) {
        const scene = canvas?.scene?.name ?? "";
        aceMemory.npcs.touchNpc(actor.name, scene);
        // Enrich NPC record with actor data
        const rec = aceMemory.npcs.getRecord(actor.name);
        if (rec) {
          rec.actorId = actor.id;
          rec.type = actor.type ?? "npc";
          try { rec.race = actor.system?.details?.race?.name ?? actor.system?.details?.race ?? ""; } catch (_) {}
          try { rec.class = actor.system?.details?.type?.value ?? actor.system?.details?.class ?? ""; } catch (_) {}
        }
        aceMemory.npcs.markDirty();
        aceMemory.saveCategory("npcs");
        aceMemory.writeNpcJournal(actor.name).catch(() => {});
        ui.notifications?.info(`ACE: ${actor.name} linked — memory will persist across scenes.`);
      }
    } else {
      ui.notifications?.info(`ACE: ${actor.name} unlinked.`);
    }

    // Refresh the card visual
    this.refreshSelectPanel();
  }

  // ── Bio Generation — Tokens & Items ──────────────────────

  /**
   * Generate an AI biography for an NPC or creature token.
   */
  static async _onGenerateBio(event, target) {
    event.stopPropagation();
    const actorId = target.closest("[data-actor-id]")?.dataset.actorId;
    if (!actorId) return;

    const actor = game.actors?.get(actorId);
    if (!actor) return;

    // Check for existing bio (ignore ACE story notes section)
    const existingBio = (actor.system?.details?.biography?.value ?? "")
      .replace(/<!-- ACE-STORY-NOTES -->[\s\S]*<!-- \/ACE-STORY-NOTES -->/, "")
      .replace(/<[^>]+>/g, "").trim();

    if (existingBio.length > 30) {
      const overwrite = await _aceConfirmDialog(
        "Existing Biography",
        `<p><strong>${actor.name}</strong> already has a biography (${existingBio.length} characters).</p><p>Overwrite it with an AI-generated one?</p>`,
        { yesLabel: "Overwrite", yesIcon: "fas fa-feather-alt" },
      );
      if (!overwrite) return;
    }

    // Disable the button and show loading state
    const btn = target.closest(".ace-el-bio-btn") ?? target;
    const origIcon = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    btn.disabled = true;

    try {
      const bio = await AcePanel._generateCreatureBio(actor);
      if (!bio) {
        ui.notifications?.warn("ACE: Bio generation returned empty — check your AI provider.");
        return;
      }

      // Serialized via bio-writer (v1.6.3). The transform reads the
      // current bio under lock so we preserve story notes even if a
      // story-note append landed while we were generating the new bio.
      await appendToBiography(actor, (currentBio) => {
        const storyNotesMatch = currentBio.match(/(<!-- ACE-STORY-NOTES -->[\s\S]*<!-- \/ACE-STORY-NOTES -->)/);
        const storyNotes = storyNotesMatch ? `\n${storyNotesMatch[1]}` : "";
        return bio + storyNotes;
      }, "panel:bio-generate");
      ui.notifications?.info(`ACE: Biography generated for ${actor.name}.`);
    } catch (err) {
      console.error("ACE | Bio generation failed:", err);
      ui.notifications?.error(`ACE: Failed to generate bio for ${actor.name}.`);
    } finally {
      btn.innerHTML = origIcon;
      btn.disabled = false;
    }
  }

  /**
   * Build AI prompt and call provider for creature/NPC bio.
   * @param {Actor} actor
   * @returns {Promise<string>} HTML biography text
   */
  static async _generateCreatureBio(actor) {
    const panel = game.modules.get("ace-engine")?.api?.getPanel?.();
    if (!panel?.ai) throw new Error("AI provider not available");

    const name     = actor.name;
    const type     = actor.type ?? "npc";
    const cr       = actor.system?.details?.cr ?? "?";
    const hp       = actor.system?.attributes?.hp?.max ?? "?";
    const ac       = actor.system?.attributes?.ac?.value ?? "?";
    const scene    = canvas?.scene?.name ?? "Unknown";
    const race     = actor.system?.details?.race?.name ?? actor.system?.details?.race ?? "";
    const actorType = actor.system?.details?.type?.value ?? "";

    // Gather abilities
    const abilities = actor.system?.abilities ?? {};
    const abilStr = Object.entries(abilities)
      .map(([k, v]) => `${k.toUpperCase()} ${v.value ?? "?"}`)
      .join(", ");

    // Gather notable features/traits
    const features = [...(actor.items ?? [])]
      .filter(i => i.type === "feat" || i.type === "feature")
      .map(i => i.name)
      .slice(0, 8)
      .join(", ");

    const prompt = `Generate a vivid, concise biography for this creature/NPC to be used in a tabletop RPG campaign.

Name: ${name}
Type: ${type}${actorType ? ` (${actorType})` : ""}${race ? ` | Race: ${race}` : ""}
Challenge Rating: ${cr} | HP: ${hp} | AC: ${ac}
Abilities: ${abilStr || "unknown"}
${features ? `Notable Features: ${features}` : ""}
Current Scene: ${scene}

Write 2-4 paragraphs covering:
- Physical appearance and distinguishing features
- Personality or behavioral traits
- A brief history or how they came to be in this place
- Any notable quirks or secrets the GM might use in gameplay

Match a dark fantasy / gothic horror tone. Format with HTML <p> tags only (no markdown).
If this is a mundane creature (horse, dog, wolf, etc.), give it personality and suggest a name in bold at the start.
Do NOT include the creature's stat block — just narrative flavor.`;

    return panel.ai.chat(prompt, "", "", []);
  }

  /**
   * Generate an AI bio for a single item in a token's inventory.
   */
  static async _onGenerateItemBio(event, target) {
    event.stopPropagation();
    const actorId = target.closest("[data-actor-id]")?.dataset.actorId;
    const itemId  = target.closest("[data-item-id]")?.dataset.itemId;
    if (!actorId || !itemId) return;

    const actor = game.actors?.get(actorId);
    const item  = actor?.items?.get(itemId);
    if (!actor || !item) return;

    // Check for existing description
    const existingDesc = (item.system?.description?.value || "").replace(/<[^>]+>/g, "").trim();
    if (existingDesc.length > 30) {
      const overwrite = await _aceConfirmDialog(
        "Existing Description",
        `<p><strong>${item.name}</strong> already has a description (${existingDesc.length} characters).</p><p>Overwrite it with an AI-generated one?</p>`,
        { yesLabel: "Overwrite", yesIcon: "fas fa-feather-alt" },
      );
      if (!overwrite) return;
    }

    // Loading state
    const btn = target.closest(".ace-el-bio-btn") ?? target;
    const origIcon = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    btn.disabled = true;

    try {
      const bio = await AcePanel._generateItemBio(actor, item);
      if (!bio) {
        ui.notifications?.warn("ACE: Item bio generation returned empty.");
        return;
      }

      await item.update({ "system.description.value": bio });
      ui.notifications?.info(`ACE: Bio generated for ${item.name}.`);

      // Update the button icon to show it now has a bio
      btn.innerHTML = '<i class="fas fa-check-circle"></i>';
      btn.closest(".ace-inventory-item")?.classList.add("ace-item-has-bio");
    } catch (err) {
      console.error("ACE | Item bio generation failed:", err);
      ui.notifications?.error(`ACE: Failed to generate bio for ${item.name}.`);
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * Build AI prompt for item bio generation.
   * @param {Actor} actor - The owning actor
   * @param {Item} item - The item to describe
   * @returns {Promise<string>} HTML description
   */
  static async _generateItemBio(actor, item) {
    const panel = game.modules.get("ace-engine")?.api?.getPanel?.();
    if (!panel?.ai) throw new Error("AI provider not available");

    const rarity = item.system?.rarity || "common";
    const damage = item.system?.damage?.parts?.map(p => p.join(" ")).join(", ") || "";
    const price  = item.system?.price?.value ? `${item.system.price.value} ${item.system.price.denomination || "gp"}` : "";
    const weight = item.system?.weight?.value ?? item.system?.weight ?? "";
    const props  = item.system?.properties
      ? [...(item.system.properties instanceof Set ? item.system.properties : Object.keys(item.system.properties).filter(k => item.system.properties[k]))].join(", ")
      : "";
    const scene  = canvas?.scene?.name ?? "Unknown";

    const prompt = `Generate a flavor description for this item in a tabletop RPG. Scale depth by rarity:
- Common/mundane: 1-2 evocative sentences about its appearance and brief history
- Uncommon: A short paragraph with origin and a notable feature
- Rare: 2 paragraphs — who made it, its history, and what makes it special
- Very Rare / Legendary: Full backstory — creation, previous owners, legends, quirks

Item: ${item.name}
Type: ${item.type} | Rarity: ${rarity}
${damage ? `Damage: ${damage}` : ""}
${props ? `Properties: ${props}` : ""}
${price ? `Value: ${price}` : ""}
${weight ? `Weight: ${weight} lbs` : ""}
Owner: ${actor.name} (${actor.type})
Scene: ${scene}

Every item has a story. Even a rusted scimitar was once new — who carried it? How did it end up here?
Format with HTML (<p> tags, use <em> for flavor text, <strong> for emphasis). No markdown.
For Rare+ items, suggest a unique name in bold at the start — something evocative and memorable.
Do NOT include game mechanics or stat blocks — just narrative flavor.`;

    return panel.ai.chat(prompt, "", "", []);
  }

  /**
   * Generate bios for ALL items on a selected actor that don't have descriptions yet.
   */
  static async _onGenerateAllItemBios(event, target) {
    event.stopPropagation();
    const actorId = target.closest("[data-actor-id]")?.dataset.actorId;
    if (!actorId) return;

    const actor = game.actors?.get(actorId);
    if (!actor) return;

    // Find items without substantial descriptions
    const items = [...(actor.items ?? [])]
      .filter(i => ["weapon", "equipment", "loot", "consumable", "tool", "armor"].includes(i.type))
      .filter(i => !AcePanel._isNaturalWeapon(i))
      .filter(i => {
        const desc = (i.system?.description?.value || "").replace(/<[^>]+>/g, "").trim();
        return desc.length <= 20;
      });

    if (!items.length) {
      ui.notifications?.info(`ACE: All items on ${actor.name} already have descriptions.`);
      return;
    }

    const proceed = await _aceConfirmDialog(
      "Generate All Item Bios",
      `<p>Generate AI bios for <strong>${items.length}</strong> items on <strong>${actor.name}</strong> that don't have descriptions?</p><p>This may take a moment.</p>`,
      { yesLabel: `Generate ${items.length} Bios`, yesIcon: "fas fa-magic" },
    );
    if (!proceed) return;

    // Disable the Bio All button
    const btn = target.closest(".ace-inventory-bio-all") ?? target;
    const origContent = btn.innerHTML;
    btn.disabled = true;

    let generated = 0;
    for (const item of items) {
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${++generated}/${items.length}`;
      try {
        const bio = await AcePanel._generateItemBio(actor, item);
        if (bio) {
          await item.update({ "system.description.value": bio });
        }
      } catch (err) {
        console.warn(`ACE | Failed to generate bio for ${item.name}:`, err);
      }
    }

    btn.innerHTML = origContent;
    btn.disabled = false;
    ui.notifications?.info(`ACE: Generated bios for ${generated} items on ${actor.name}.`);

    // Refresh inventory panel to show checkmarks
    this.refreshSelectPanel();
  }

  /** Get current selection for use by AI context / other panels */
  getSelection() {
    return {
      tokens: [...this._selectedTokens],
      tiles:  [...this._selectedTiles],
      items:  [...this._selectedItems],
    };
  }

  /** Refresh the Select panel when scene tokens/tiles change */
  refreshSelectPanel() {
    if (!this.rendered) return;
    this._selectPanelDirty = true;           // mark stale so tab-switch rebuilds it
    if (this._activeTab !== "elements") return; // rebuild immediately only if visible
    const container = this.element.querySelector('[data-tab-content="elements"]');
    if (container) {
      container.innerHTML = this._buildSelectElementsPanel();
      this._wireSelectPanelEvents();
      this._selectPanelDirty = false;
    }
  }

  /** Wire hover + double-click events for element cards */
  _wireSelectPanelEvents() {
    // Clear any stuck highlights from previous render (innerHTML kills mouseleave)
    CanvasHighlight.clearAll();

    const cards = this.element.querySelectorAll(".ace-el-card");
    for (const card of cards) {
      const id   = card.dataset.elId;
      const type = card.dataset.elType;

      card.addEventListener("mouseenter", () => CanvasHighlight.highlight(id, type));
      card.addEventListener("mouseleave", () => CanvasHighlight.unhighlight(id, type));

      // Double-click → open actor sheet
      card.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const actorId = card.dataset.actorId || card.dataset.elId;
        const actor = game.actors?.get(actorId);
        if (actor) actor.sheet.render(true);
      });
    }

    // Wire collapsible section headers (Players, NPCs, Tiles, Items)
    const sectionHeaders = this.element.querySelectorAll("[data-action='toggleElSection']");
    for (const header of sectionHeaders) {
      header.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = header.dataset.elSection;
        if (!key || !(key in this._collapsedSections)) return;
        this._collapsedSections[key] = !this._collapsedSections[key];
        const section = header.closest(".ace-el-section");
        const body = section?.querySelector(".ace-el-section-body");
        if (body) body.style.display = this._collapsedSections[key] ? "none" : "block";
        section?.classList.toggle("collapsed", this._collapsedSections[key]);
      });
    }

    // Wire NPC speech box events (Enter key)
    this._wireNpcSpeechEvents();

    // Wire TCC action bar events
    this._wireTccEvents();
  }

  // ══════════════════════════════════════════════════════════
  //  TACTICAL COMMAND CENTER (TCC) — Action bar at bottom of Select tab
  // ══════════════════════════════════════════════════════════

  /** Resolve _selectedTokens IDs to actor/token objects.
   *  Players stored by actor.id, NPCs by token.id — handle both. */
  _resolveSelectedActors() {
    const results = [];
    for (const id of this._selectedTokens) {
      let actor = game.actors?.get(id);
      let token = null;
      let isPlayer = false;

      if (actor) {
        isPlayer = actor.hasPlayerOwner;
        token = canvas?.tokens?.placeables?.find(t => t.actor?.id === id) ?? null;
      } else {
        token = canvas?.tokens?.placeables?.find(t => t.id === id) ?? null;
        actor = token?.actor;
        if (!actor) continue;
        isPlayer = actor.hasPlayerOwner;
      }
      results.push({ actor, token, isPlayer, id });
    }
    return results;
  }

  // ── TCC HTML Builders ─────────────────────────────────────

  _buildTccBar() {
    const inCombat = !!game.combat?.started;
    return `
      <div class="ace-tcc-bar">
        <div class="ace-tcc-divider"></div>
        ${this._buildTccGroupRolls()}
        ${this._buildTccBulkActions()}
        ${inCombat ? this._buildTccInitiative() : ""}
      </div>
    `;
  }

  /** Render stat rows HTML for an array of resolved actors (shared by build + refresh) */
  _renderStatRows(actors) {
    return actors.map(({ actor }) => {
      const hp    = actor.system?.attributes?.hp;
      const hpVal = hp?.value ?? 0;
      const hpMax = hp?.max ?? 1;
      const pct   = Math.round((hpVal / Math.max(hpMax, 1)) * 100);
      const ac    = actor.system?.attributes?.ac?.value ?? "\u2014";
      const spd   = actor.system?.attributes?.movement?.walk ?? "\u2014";
      const conds = (actor.effects ?? [])
        .filter(e => !e.disabled)
        .map(e => e.name || e.label || "")
        .filter(Boolean)
        .join(", ");
      const img   = actor.prototypeToken?.texture?.src || actor.img || "icons/svg/mystery-man.svg";
      const safeName  = this._escapeHtml(actor.name);
      const safeConds = this._escapeHtml(conds);
      return `
        <div class="ace-tcc-stat-row">
          <img class="ace-tcc-stat-img" src="${img}" alt="${safeName}"
               onerror="this.src='icons/svg/mystery-man.svg'" />
          <span class="ace-tcc-stat-name" title="${safeName}">${safeName}</span>
          <span class="ace-tcc-stat-hp" title="HP: ${hpVal}/${hpMax}">
            <span class="ace-tcc-hp-fill" style="width:${pct}%"></span>
            <span class="ace-tcc-hp-text">${hpVal}/${hpMax}</span>
          </span>
          <span class="ace-tcc-stat-ac" title="Armor Class">AC ${ac}</span>
          <span class="ace-tcc-stat-spd" title="Speed">${spd}ft</span>
          ${safeConds ? `<span class="ace-tcc-stat-cond" title="${safeConds}">${safeConds}</span>` : ""}
        </div>`;
    }).join("");
  }

  _buildTccQuickStats() {
    const exp = this._tccExpanded.stats;
    const actors = this._resolveSelectedActors();
    const content = actors.length
      ? this._renderStatRows(actors)
      : `<p class="ace-el-empty">Select tokens to view stats</p>`;

    return `
      <div class="ace-tcc-section ${exp ? "expanded" : ""}">
        <div class="ace-tcc-section-header" data-action="tccToggleSection" data-tcc-section="stats">
          <i class="fas fa-heart-pulse"></i> QUICK STATS
          <i class="fas fa-chevron-down ace-tcc-chevron"></i>
        </div>
        <div class="ace-tcc-section-body" style="display:${exp ? "block" : "none"}" id="ace-tcc-stats-body">
          ${content}
        </div>
      </div>`;
  }

  _buildTccGroupRolls() {
    const exp  = this._tccExpanded.rolls;
    const type = this._tccRollType;
    const mode = this._tccRollMode;
    const dc   = this._tccDc ?? 15;
    const flav = this._tccFlavor ?? "";

    const modeLabels = { gm: "Roll for Selected", subtle: "Send Subtle Roll", request: "Request from Players" };

    return `
      <div class="ace-tcc-section ${exp ? "expanded" : ""}">
        <div class="ace-tcc-section-header" data-action="tccToggleSection" data-tcc-section="rolls">
          <i class="fas fa-dice"></i> ROLLS FOR SELECTED
          <i class="fas fa-chevron-down ace-tcc-chevron"></i>
        </div>
        <div class="ace-tcc-section-body" style="display:${exp ? "block" : "none"}">
          <div class="ace-tcc-roll-types">
            <button class="ace-tcc-roll-type-btn ${type === "skill" ? "active" : ""}" data-roll-type="skill">Skill</button>
            <button class="ace-tcc-roll-type-btn ${type === "save"  ? "active" : ""}" data-roll-type="save">Save</button>
            <button class="ace-tcc-roll-type-btn ${type === "check" ? "active" : ""}" data-roll-type="check">Check</button>
          </div>
          <div class="ace-roll-system">
            <select class="ace-tcc-roll-select" id="ace-tcc-roll-id">
              ${this._buildTccRollOptions(type, mode === "subtle", this._tccRollIds[type])}
            </select>
            <div class="ace-roll-dc-wrap">
              <label for="ace-tcc-dc">DC</label>
              <input id="ace-tcc-dc" type="number" class="ace-roll-dc-input" value="${dc}" min="1" max="30" step="1" />
            </div>
          </div>
          <div class="ace-roll-mode-btns">
            <button class="ace-roll-mode-btn ${mode === "gm"      ? "active" : ""}" data-roll-mode="gm"
                    title="Secret roll — result shown only to GM in ACE panel">🎲 GM Roll</button>
            <button class="ace-roll-mode-btn ${mode === "subtle"  ? "active" : ""}" data-roll-mode="subtle"
                    title="Secret roll + optional whispered flavor text to the player">🔒 Subtle</button>
            <button class="ace-roll-mode-btn ${mode === "request" ? "active" : ""}" data-roll-mode="request"
                    title="Open roll request sent to selected players via Foundry chat">📢 Request</button>
          </div>
          <div class="ace-roll-flavor-wrap ${mode === "subtle" ? "visible" : ""}">
            <input id="ace-tcc-flavor" type="text" class="ace-roll-flavor"
                   value="${this._escapeHtmlAttr ? this._escapeHtmlAttr(flav) : flav.replace(/"/g, "&quot;")}"
                   placeholder="Flavor text: 'Something feels off about this place...'" />
          </div>
          <button class="ace-btn ace-btn-roll-execute" data-action="tccGroupRoll">
            <i class="fas fa-dice-d20"></i> ${modeLabels[mode] ?? modeLabels.gm}
          </button>
        </div>
      </div>`;
  }

  /**
   * Build dropdown options for the current roll-type, optionally restricted
   * to skills/saves where failure isn't immediately obvious (subtle mode),
   * and pre-selecting `selectedId` if it's in the resulting list.
   */
  _buildTccRollOptions(type, subtleOnly = false, selectedId = null) {
    const labels = type === "skill" ? TCC_SKILL_LABELS : TCC_ABILITY_LABELS;
    const filter = subtleOnly
      ? (type === "skill" ? TCC_SUBTLE_SKILLS : TCC_SUBTLE_SAVES)
      : null;
    return Object.entries(labels)
      .filter(([id]) => !filter || filter.has(id))
      .map(([id, name]) => `<option value="${id}"${id === selectedId ? " selected" : ""}>${name}</option>`)
      .join("");
  }

  _buildTccBulkActions() {
    const exp = this._tccExpanded.bulk;
    const condOpts = TCC_CONDITION_LIST.map(c => {
      const label = c.charAt(0).toUpperCase() + c.slice(1);
      return `<option value="${c}">${label}</option>`;
    }).join("");

    return `
      <div class="ace-tcc-section ${exp ? "expanded" : ""}">
        <div class="ace-tcc-section-header" data-action="tccToggleSection" data-tcc-section="bulk">
          <i class="fas fa-layer-group"></i> BULK ACTIONS
          <i class="fas fa-chevron-down ace-tcc-chevron"></i>
        </div>
        <div class="ace-tcc-section-body" style="display:${exp ? "block" : "none"}">
          <div class="ace-tcc-bulk-row">
            <select class="ace-tcc-cond-select" id="ace-tcc-condition">
              <option value="">-- Condition --</option>
              ${condOpts}
            </select>
            <button class="ace-btn ace-btn-sm" data-action="tccBulkCondition" data-mode="apply">
              <i class="fas fa-plus-circle"></i> Apply
            </button>
            <button class="ace-btn ace-btn-sm" data-action="tccBulkCondition" data-mode="remove">
              <i class="fas fa-minus-circle"></i> Remove
            </button>
          </div>
          <div class="ace-tcc-bulk-row">
            <input type="number" class="ace-tcc-hp-input" id="ace-tcc-hp-delta"
                   value="0" min="0" step="1" placeholder="HP" />
            <button class="ace-btn ace-btn-sm ace-tcc-dmg-btn" data-action="tccBulkHp" data-mode="damage">
              <i class="fas fa-heart-broken"></i> Damage
            </button>
            <button class="ace-btn ace-btn-sm ace-tcc-heal-btn" data-action="tccBulkHp" data-mode="heal">
              <i class="fas fa-heart"></i> Heal
            </button>
          </div>
        </div>
      </div>`;
  }

  _buildTccInitiative() {
    if (!game.combat?.started) return "";
    const exp = this._tccExpanded.initiative;
    return `
      <div class="ace-tcc-section ${exp ? "expanded" : ""}">
        <div class="ace-tcc-section-header" data-action="tccToggleSection" data-tcc-section="initiative">
          <i class="fas fa-sort-numeric-down"></i> INITIATIVE ORDER
          <i class="fas fa-chevron-down ace-tcc-chevron"></i>
        </div>
        <div class="ace-tcc-section-body" style="display:${exp ? "block" : "none"}">
          <div class="ace-tcc-init-row" id="ace-tcc-init-row">
            ${this._buildTccInitChips()}
          </div>
        </div>
      </div>`;
  }

  _buildTccInitChips() {
    if (!game.combat?.started) return "";
    return game.combat.turns.map((c, index) => {
      const isCurrent = index === game.combat.turn;
      const isNpc     = c.actor && !c.actor.hasPlayerOwner;
      const defeated  = c.isDefeated ? " ace-tcc-init-defeated" : "";
      const name      = c.name ?? "Unknown";
      const init      = c.initiative ?? "?";
      const truncated = name.length > 8 ? name.slice(0, 7) + "\u2026" : name;
      const safeName  = this._escapeHtml(name);
      const safeTrunc = this._escapeHtml(truncated);
      return `
        <div class="ace-tcc-init-chip ${isCurrent ? "ace-tcc-init-current" : ""} ${isNpc ? "ace-tcc-init-npc" : ""}${defeated}"
             data-action="tccInitJump" data-turn-index="${index}"
             title="${safeName} \u2014 Init ${init}${c.isDefeated ? " [DEFEATED]" : ""}">
          <span class="ace-tcc-init-num">${init}</span>
          <span class="ace-tcc-init-name">${safeTrunc}</span>
          <button class="ace-tcc-init-move" data-action="tccInitMoveUp"
                  data-combatant-id="${c.id}" title="Move up">
            <i class="fas fa-chevron-up"></i>
          </button>
          <button class="ace-tcc-init-move" data-action="tccInitMoveDown"
                  data-combatant-id="${c.id}" title="Move down">
            <i class="fas fa-chevron-down"></i>
          </button>
        </div>`;
    }).join("");
  }

  // ── TCC Public Refresh Methods ────────────────────────────

  /** Lightweight: rebuild just the initiative chips */
  refreshTccInitiative() {
    if (!this.rendered || this._activeTab !== "elements") return;
    const initRow = this.element.querySelector("#ace-tcc-init-row");
    if (initRow && game.combat?.started) {
      initRow.innerHTML = this._buildTccInitChips();
      return;
    }
    // Combat started/ended — full rebuild to show/hide the section
    const initSection = this.element.querySelector('[data-tcc-section="initiative"]');
    const shouldShow = !!game.combat?.started;
    if ((!initSection && shouldShow) || (initSection && !shouldShow)) {
      this.refreshSelectPanel();
    }
  }

  /** Rebuild Quick Stats content without full panel re-render */
  refreshTccStats() {
    if (!this.rendered || this._activeTab !== "elements") return;
    const statsBody = this.element.querySelector("#ace-tcc-stats-body");
    if (statsBody && statsBody.style.display !== "none") {
      // Rebuild inner HTML only
      const actors = this._resolveSelectedActors();
      if (!actors.length) {
        statsBody.innerHTML = `<p class="ace-el-empty">Select tokens to view stats</p>`;
        return;
      }
      statsBody.innerHTML = this._renderStatRows(actors);
    }
  }

  // ── TCC Action Handlers ───────────────────────────────────

  static _onTccToggleSection(event, target) {
    const sectionKey = target.dataset.tccSection;
    if (!sectionKey || !(sectionKey in this._tccExpanded)) return;
    this._tccExpanded[sectionKey] = !this._tccExpanded[sectionKey];
    const section = target.closest(".ace-tcc-section");
    const body = section?.querySelector(".ace-tcc-section-body");
    if (body) body.style.display = this._tccExpanded[sectionKey] ? "block" : "none";
    section?.classList.toggle("expanded", this._tccExpanded[sectionKey]);
    // Auto-refresh Quick Stats content when expanding
    if (sectionKey === "stats" && this._tccExpanded.stats) this.refreshTccStats();
    // Scroll expanded section into view
    if (this._tccExpanded[sectionKey] && section) {
      requestAnimationFrame(() => section.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
  }

  /** Toggle collapsible sections in the Select element list (Players, NPCs, Tiles, Items) */
  static _onToggleElSection(event, target) {
    const key = target.dataset.elSection;
    if (!key || !(key in this._collapsedSections)) return;
    this._collapsedSections[key] = !this._collapsedSections[key];
    const section = target.closest(".ace-el-section");
    const body = section?.querySelector(".ace-el-section-body");
    if (body) body.style.display = this._collapsedSections[key] ? "none" : "block";
    section?.classList.toggle("collapsed", this._collapsedSections[key]);
    // Scroll expanded section into view
    if (!this._collapsedSections[key] && section) {
      requestAnimationFrame(() => section.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
  }

  static async _onTccGroupRoll(event, target) {
    const actors = this._resolveSelectedActors();
    if (!actors.length) {
      ui.notifications?.warn("ACE: Select tokens first.");
      return;
    }
    const rollType = this._tccRollType;
    const rollId   = this.element.querySelector("#ace-tcc-roll-id")?.value;
    const rollMode = this._tccRollMode;
    const dc       = parseInt(this.element.querySelector("#ace-tcc-dc")?.value) || 15;
    const flavor   = this.element.querySelector("#ace-tcc-flavor")?.value?.trim() ?? "";
    if (!rollId) { ui.notifications?.warn("ACE: Select a roll type."); return; }

    target.disabled = true;
    let rolled = 0;

    // ── Subtle mode: batch blind rolls → one consolidated GM card ──
    if (rollMode === "subtle") {
      if (!this.subtleRolls) {
        ui.notifications?.warn("ACE: Subtle Rolls not enabled. Check Module Settings.");
        target.disabled = false;
        return;
      }
      const results = await this.subtleRolls.batchRoll({
        actors,
        skill: rollId,
        dc,
        flavor,
      });
      target.disabled = false;
      const passCount = results.filter(r => r.passed).length;
      ui.notifications?.info(`ACE: Subtle roll complete — ${passCount}/${results.length} passed (DC ${dc}).`);
      return;
    }

    const labels   = rollType === "skill" ? TCC_SKILL_LABELS : TCC_ABILITY_LABELS;
    const label    = labels[rollId] ?? rollId;
    const typeLabel = rollType === "skill" ? "Skill Check"
                    : rollType === "save"  ? "Saving Throw" : "Ability Check";

    // ── Request mode: send roll-button card to each player ─────
    if (rollMode === "request") {
      for (const { actor, isPlayer } of actors) {
        if (!isPlayer) continue;
        const ownerUser = game.users.find(u => !u.isGM && actor.testUserPermission(u, "OWNER"));
        if (!ownerUser) continue;
        const reqId = `tcc-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const cardHtml =
          `<div class="ace-subtle-request" style="background:#1c150e;border-left:4px solid #8a5bbf;` +
          `border-radius:4px;padding:10px 12px;font-family:'IM Fell English','Palatino Linotype',serif;line-height:1.6;">` +
          `<div style="color:#c4a8f0;font-weight:bold;font-size:1.05em;margin-bottom:6px;letter-spacing:0.5px;">` +
          `<i class="fas fa-eye-slash" style="margin-right:4px;"></i> ${this._escapeHtml(typeLabel)}</div>` +
          `<div style="font-style:italic;color:#eddfc5;margin-bottom:10px;">` +
          `The GM calls for a <strong>${this._escapeHtml(label)}</strong> check.</div>` +
          `<button class="ace-chat-btn" data-ace-btn="tcc-request-roll" ` +
          `data-request-id="${reqId}" data-roll-type="${rollType}" data-roll-id="${rollId}" ` +
          `data-actor-id="${actor.id}" ` +
          `style="display:block;width:100%;padding:8px 12px;background:#18102a;` +
          `border:1px solid #8a5bbf;border-radius:4px;color:#c4a8f0;cursor:pointer;` +
          `font-family:inherit;font-size:1em;text-align:center;font-weight:bold;` +
          `transition:all 0.2s;">` +
          `<i class="fas fa-dice-d20" style="margin-right:6px;"></i>` +
          `Roll ${this._escapeHtml(label)}</button>` +
          `<div style="font-size:0.78em;color:#7a6042;margin-top:6px;text-align:center;">` +
          `Select your token first, then click to roll.</div>` +
          `</div>`;

        await ChatMessage.create({
          content: cardHtml,
          speaker: { alias: "ACE" },
          whisper: [ownerUser.id],
          flags: {
            "ace-engine": {
              isTccRollRequest: true,
              tccRequestId:    reqId,
              tccRollType:     rollType,
              tccRollId:       rollId,
              tccDC:           dc,
              tccActorId:      actor.id,
            },
          },
        });
        rolled++;
      }
      target.disabled = false;
      ui.notifications?.info(`ACE: ${rolled} roll request${rolled !== 1 ? "s" : ""} sent.`);
      return;
    }

    // ── GM Roll mode: silent roll, real dice GM, blind dice players, GM-only card ──
    const gmResults = [];
    const rollErrors = [];
    for (const { actor, token } of actors) {
      try {
        const displayName = token?.document?.name ?? token?.name ?? actor.prototypeToken?.name ?? actor.name;
        const displayImg  = token?.document?.texture?.src ?? actor.prototypeToken?.texture?.src ?? actor.img;

        // Get modifier based on roll type. dnd5e 5.x changed several
        // shapes from plain numbers to objects with .value — we accept
        // either to keep the math working across versions.
        let mod = 0;
        const numericOrValue = (x) =>
          (typeof x === "number" ? x : x?.value);

        if (rollType === "skill") {
          const s = actor.system?.skills?.[rollId];
          mod = numericOrValue(s?.total) ?? numericOrValue(s?.mod) ?? 0;
        } else if (rollType === "save") {
          // In dnd5e 5.x abilities.<abl>.save is an OBJECT { value, dc, ... }
          // not a raw number — extract .value. Older dnd5e versions had it
          // as a plain number, so accept either.
          mod = numericOrValue(actor.system?.abilities?.[rollId]?.save) ?? 0;
        } else {
          mod = numericOrValue(actor.system?.abilities?.[rollId]?.mod) ?? 0;
        }
        // Coerce to a finite number so the Roll formula can't end up with
        // "[object Object]" / "NaN" / undefined interpolation garbage.
        mod = Number.isFinite(mod) ? mod : 0;

        // Roll silently — no chat message
        const roll = await new Roll(`1d20 + ${mod}`).evaluate();

        // Dice So Nice — GM sees real dice, players see blind "?" dice
        if (game.dice3d) {
          try {
            await game.dice3d.showForRoll(roll, game.user, false, null, false, null, null);
            await game.dice3d.showForRoll(roll, game.user, true, null, true, null, null, { ghost: true });
          } catch (e) {
            console.warn(`${MODULE_ID} | Dice So Nice roll failed:`, e);
          }
        }

        const total   = roll.total;
        const natural = roll.dice?.[0]?.total ?? total;
        const passed  = total >= dc;

        gmResults.push({ displayName, displayImg, total, natural, mod, passed });
        rolled++;
      } catch (err) {
        console.error(`${MODULE_ID} | TCC GM roll error for ${actor.name}:`, err);
        rollErrors.push(`${actor.name}: ${err?.message ?? err}`);
      }
    }

    // If every roll threw, surface the first error to the GM instead of
    // a silent "0 rolls executed" toast that gives no clue what broke.
    if (rolled === 0 && rollErrors.length) {
      ui.notifications?.error(`ACE: All rolls failed — ${rollErrors[0]}. See console for details.`);
      target.disabled = false;
      return;
    }

    // Build GM-only results card
    if (gmResults.length) {
      const rows = gmResults.map(r => {
        const passClass = r.passed ? "color:#4caf50;" : "color:#f44336;";
        const passLabel = r.passed ? "PASS" : "FAIL";
        const natTag    = r.natural === 20 ? ' <span style="color:#ffd700;font-weight:bold;">NAT 20</span>'
                        : r.natural === 1  ? ' <span style="color:#f44336;font-weight:bold;">NAT 1</span>' : "";
        return (
          `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #2a2a2a;">` +
          `<img src="${r.displayImg}" style="width:28px;height:28px;border-radius:50%;border:1px solid #555;" />` +
          `<span style="flex:1;color:#eddfc5;">${this._escapeHtml(r.displayName)}</span>` +
          `<span style="color:#aaa;font-size:0.85em;">${r.natural} + ${r.mod} = <strong style="color:#fff;">${r.total}</strong>${natTag}</span>` +
          `<span style="font-weight:bold;font-size:0.9em;min-width:36px;text-align:center;${passClass}">${passLabel}</span>` +
          `</div>`
        );
      }).join("");

      const passCount = gmResults.filter(r => r.passed).length;
      const cardHtml =
        `<div class="ace-gm-roll-card" style="background:#1c150e;border-left:4px solid #c9a84c;` +
        `border-radius:6px;padding:12px 14px;font-family:'Rajdhani','Segoe UI',sans-serif;line-height:1.5;">` +
        `<div style="color:#c9a84c;font-weight:bold;font-size:1.05em;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;">` +
        `<i class="fas fa-dice-d20" style="margin-right:6px;"></i>${this._escapeHtml(label)} ${this._escapeHtml(typeLabel)} — DC ${dc}</div>` +
        rows +
        `<div style="text-align:right;color:#888;font-size:0.8em;margin-top:6px;">${passCount}/${gmResults.length} passed</div>` +
        `</div>`;

      await ChatMessage.create({
        content: cardHtml,
        speaker: { alias: "ACE" },
        whisper: [game.user.id],
      });
    }

    target.disabled = false;
    ui.notifications?.info(`ACE: ${rolled} blind roll${rolled !== 1 ? "s" : ""} executed.`);
  }

  static async _onTccBulkCondition(event, target) {
    const mode      = target.dataset.mode;   // "apply" | "remove"
    const condition = this.element.querySelector("#ace-tcc-condition")?.value;
    if (!condition) { ui.notifications?.warn("ACE: Select a condition."); return; }

    const actors = this._resolveSelectedActors();
    if (!actors.length) { ui.notifications?.warn("ACE: Select tokens first."); return; }

    const label = condition.charAt(0).toUpperCase() + condition.slice(1);
    let count = 0;
    for (const { actor } of actors) {
      try {
        if (typeof actor.toggleStatusEffect === "function") {
          await actor.toggleStatusEffect(condition, { active: mode === "apply" });
        } else if (mode === "apply") {
          const eff = CONFIG.statusEffects?.find(e => e.id === condition);
          await actor.createEmbeddedDocuments("ActiveEffect", [{
            label: eff?.label ?? label,
            icon: eff?.icon ?? "icons/svg/mystery-man.svg",
            statuses: [condition],
          }]);
        } else {
          const effect = actor.effects.find(e => e.statuses?.has(condition));
          if (effect) await effect.delete();
        }
        count++;
      } catch (err) {
        console.error(`${MODULE_ID} | TCC bulk condition error for ${actor.name}:`, err);
      }
    }
    ui.notifications?.info(`ACE: ${label} ${mode === "apply" ? "applied to" : "removed from"} ${count} token${count !== 1 ? "s" : ""}.`);
    this.refreshTccStats();
  }

  static async _onTccBulkHp(event, target) {
    const mode  = target.dataset.mode;   // "damage" | "heal"
    const delta = Math.abs(parseInt(this.element.querySelector("#ace-tcc-hp-delta")?.value) || 0);
    if (!delta) { ui.notifications?.warn("ACE: Enter an HP value."); return; }

    const actors = this._resolveSelectedActors();
    if (!actors.length) { ui.notifications?.warn("ACE: Select tokens first."); return; }

    let count = 0;
    for (const { actor } of actors) {
      try {
        const hp = actor.system?.attributes?.hp;
        if (hp == null) continue;
        const current = hp.value ?? 0;
        const max     = hp.max ?? current;
        const newVal  = mode === "damage"
          ? Math.max(0, current - delta)
          : Math.min(max, current + delta);
        await actor.update({ "system.attributes.hp.value": newVal });
        count++;
      } catch (err) {
        console.error(`${MODULE_ID} | TCC bulk HP error for ${actor.name}:`, err);
      }
    }
    ui.notifications?.info(`ACE: ${mode === "damage" ? "Damaged" : "Healed"} ${count} token${count !== 1 ? "s" : ""} for ${delta} HP.`);
    this.refreshTccStats();
  }

  static async _onTccInitJump(event, target) {
    event.stopPropagation();
    const chip = target.closest("[data-turn-index]");
    const turnIndex = parseInt(chip?.dataset.turnIndex);
    if (isNaN(turnIndex) || !game.combat?.started) return;
    await game.combat.update({ turn: turnIndex });
  }

  static async _onTccInitMoveUp(event, target) {
    event.stopPropagation();
    const combatantId = target.closest("[data-combatant-id]")?.dataset.combatantId;
    if (!combatantId || !game.combat) return;
    const turns = game.combat.turns;
    const idx   = turns.findIndex(c => c.id === combatantId);
    if (idx <= 0) return;
    const thisCbt  = turns[idx];
    const otherCbt = turns[idx - 1];
    const thisInit  = thisCbt.initiative;
    const otherInit = otherCbt.initiative;
    // Swap (+0.01 offset to break ties)
    await thisCbt.update({ initiative: otherInit + 0.01 });
    await otherCbt.update({ initiative: thisInit - 0.01 });
  }

  static async _onTccInitMoveDown(event, target) {
    event.stopPropagation();
    const combatantId = target.closest("[data-combatant-id]")?.dataset.combatantId;
    if (!combatantId || !game.combat) return;
    const turns = game.combat.turns;
    const idx   = turns.findIndex(c => c.id === combatantId);
    if (idx < 0 || idx >= turns.length - 1) return;
    const thisCbt  = turns[idx];
    const otherCbt = turns[idx + 1];
    const thisInit  = thisCbt.initiative;
    const otherInit = otherCbt.initiative;
    await thisCbt.update({ initiative: otherInit - 0.01 });
    await otherCbt.update({ initiative: thisInit + 0.01 });
  }

  // ── TCC Event Wiring ──────────────────────────────────────

  _wireTccEvents() {
    // ── Persistence wiring ───────────────────────────────────────
    // Keep the live form values mirrored into instance state so toggling
    // Skill/Save/Check or GM/Subtle/Request doesn't blow away the GM's
    // current picks. Each roll type (skill/save/check) gets its OWN last
    // selection so switching back restores what was there.

    const select = this.element.querySelector("#ace-tcc-roll-id");
    if (select) {
      select.addEventListener("change", () => {
        this._tccRollIds[this._tccRollType] = select.value;
      });
    }

    const dcInput = this.element.querySelector("#ace-tcc-dc");
    if (dcInput) {
      const persistDc = () => {
        const v = parseInt(dcInput.value, 10);
        if (Number.isFinite(v)) this._tccDc = v;
      };
      dcInput.addEventListener("input",  persistDc);
      dcInput.addEventListener("change", persistDc);
    }

    const flavorInput = this.element.querySelector("#ace-tcc-flavor");
    if (flavorInput) {
      flavorInput.addEventListener("input", () => {
        this._tccFlavor = flavorInput.value || "";
      });
    }

    // ── Roll type buttons (Skill / Save / Check) ────────────────
    // On switch: remember the current dropdown value under the OLD type's
    // slot, swap the dropdown contents for the new type's labels, then
    // restore the LAST value the GM had picked for the new type (or its
    // default). DC + flavor are not touched.
    const typeButtons = this.element.querySelectorAll(".ace-tcc-roll-type-btn");
    for (const btn of typeButtons) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const oldType = this._tccRollType;
        const newType = btn.dataset.rollType;
        if (oldType === newType) return;
        // Stash the current dropdown value for the OLD type before we swap
        const sel = this.element.querySelector("#ace-tcc-roll-id");
        if (sel) this._tccRollIds[oldType] = sel.value;
        this._tccRollType = newType;
        typeButtons.forEach(b => b.classList.toggle("active", b === btn));
        if (sel) sel.innerHTML = this._buildTccRollOptions(newType, this._tccRollMode === "subtle", this._tccRollIds[newType]);
      });
    }

    // ── Mode buttons (GM Roll / Subtle / Request) ───────────────
    // Switching modes preserves the current skill/save/check pick AND
    // the DC. Only the dropdown's option list filters narrow (subtle
    // mode restricts to skills where failure isn't obvious). If the
    // current pick is still eligible under the new filter, it stays
    // selected; if not, falls back to the first eligible option.
    const modeButtons = this.element.querySelectorAll(".ace-roll-mode-btn");
    for (const btn of modeButtons) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const newMode = btn.dataset.rollMode;
        if (this._tccRollMode === newMode) return;
        // Capture the current pick BEFORE rebuilding so we can restore it
        const sel = this.element.querySelector("#ace-tcc-roll-id");
        if (sel) this._tccRollIds[this._tccRollType] = sel.value;
        this._tccRollMode = newMode;
        modeButtons.forEach(b => b.classList.toggle("active", b === btn));
        // Show/hide flavor text input (subtle mode only)
        const flavorWrap = this.element.querySelector(".ace-roll-flavor-wrap");
        if (flavorWrap) flavorWrap.classList.toggle("visible", newMode === "subtle");
        // Rebuild dropdown with new filter, restoring selection
        if (sel) {
          sel.innerHTML = this._buildTccRollOptions(this._tccRollType, newMode === "subtle", this._tccRollIds[this._tccRollType]);
          // If our preferred id wasn't in the filtered list, store whatever
          // ended up selected (first option) so the state stays consistent
          this._tccRollIds[this._tccRollType] = sel.value;
        }
        // Update execute button label
        const execBtn = this.element.querySelector(".ace-btn-roll-execute");
        if (execBtn) {
          const labels = { gm: "Roll for Selected", subtle: "Send Subtle Roll", request: "Request from Players" };
          const icons  = { gm: "fa-dice-d20", subtle: "fa-eye-slash", request: "fa-paper-plane" };
          execBtn.innerHTML = `<i class="fas ${icons[newMode] ?? "fa-dice-d20"}"></i> ${labels[newMode] ?? labels.gm}`;
        }
      });
    }
  }

  // ── Message Renderers ──────────────────────────────────────

  _renderChatMessages() {
    if (!this._chatHistory.length) {
      // Check if AI is actually configured
      const needsSetup = this._checkNeedsSetup();
      const setupBanner = needsSetup ? `
        <div class="ace-setup-nudge">
          <i class="fas fa-exclamation-triangle" style="color:#c9a84c;"></i>
          <span><strong>AI not configured.</strong> Chat, Ideas, and Encounters require an AI provider.</span>
          <button class="ace-setup-nudge-btn" onclick="game.settings.sheet.render(true);">
            <i class="fas fa-cog"></i> Open Settings
          </button>
        </div>` : "";

      return `<div class="ace-welcome">
        <i class="fas fa-book-sparkles ace-welcome-icon"></i>
        <p>Welcome to <strong>ACE</strong></p>
        <p class="ace-welcome-hint">Your private AI advisor. Ask anything — players never see this chat.</p>
        ${setupBanner}
        <div class="ace-quick-prompts">
          <button class="ace-quick-prompt" onclick="document.getElementById('ace-input').value='What should happen next in this scene?';this.closest('.ace-panel').querySelector('[data-action=sendMessage]').click();">What should happen next?</button>
          <button class="ace-quick-prompt" onclick="document.getElementById('ace-input').value='Describe the atmosphere of this scene';this.closest('.ace-panel').querySelector('[data-action=sendMessage]').click();">Describe the atmosphere</button>
          <button class="ace-quick-prompt" onclick="document.getElementById('ace-input').value='How would the NPCs here react to the party?';this.closest('.ace-panel').querySelector('[data-action=sendMessage]').click();">How would NPCs react?</button>
        </div>
      </div>`;
    }

    return this._chatHistory
      .map((msg, i) => {
        const roleClass   = msg.role === "user" ? "ace-msg-user" : "ace-msg-ai";
        const tacticClass = msg.isTactic ? " ace-msg-tactic" : "";
        const roleLabel   = msg.role === "user" ? "You" : "ACE";
        const roleIcon    = msg.role === "user" ? "fa-user"
                          : msg.isTactic ? "fa-chess-knight" : "fa-book-sparkles";
        return `
        <div class="ace-message ${roleClass}${tacticClass}" data-index="${i}">
          <div class="ace-msg-header">
            <i class="fas ${roleIcon}"></i>
            <span class="ace-msg-role">${roleLabel}</span>
            ${msg.role === "assistant" ? `
              <div class="ace-msg-actions">
                <button class="ace-icon-btn" data-action="sendToNarration" data-index="${i}" title="Send to Narration tab">
                  <i class="fas fa-scroll"></i>
                </button>
                <button class="ace-icon-btn" data-action="copyMessage" data-index="${i}" title="Copy">
                  <i class="fas fa-copy"></i>
                </button>
                <button class="ace-icon-btn" data-action="saveToJournal" data-index="${i}" title="Save to Journal">
                  <i class="fas fa-book"></i>
                </button>
                ${this._worldBible?.hasData ? `
                <button class="ace-icon-btn ace-learn-btn" data-action="learnFromChat" data-index="${i}" title="Learn — extract world knowledge into the Bible">
                  <i class="fas fa-brain"></i>
                </button>` : ""}
              </div>
            ` : ""}
          </div>
          <div class="ace-msg-body">${this._renderChatBody(msg.content)}</div>
        </div>`;
      })
      .join("");
  }

  _renderNarrationMessages() {
    if (!this._narrationHistory.length) {
      return `<div class="ace-directions-empty">
        <i class="fas fa-scroll ace-directions-empty-icon"></i>
        <p>No narrations sent yet.</p>
        <p class="ace-welcome-hint">
          Accepted story ideas stream here for review.<br>
          Type or speak below, then click <strong>To Players</strong> to broadcast + speak aloud.
        </p>
      </div>`;
    }

    return this._narrationHistory.map((entry, i) => `
      <div class="ace-narration-entry" data-idx="${i}" data-index="${i}">
        <div class="ace-narration-timestamp">
          <i class="fas fa-scroll"></i>
          ${new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          <div class="ace-msg-actions">
            <button class="ace-icon-btn" data-action="copyNarration" data-index="${i}" title="Copy">
              <i class="fas fa-copy"></i>
            </button>
          </div>
        </div>
        <div class="ace-narration-text">${this._renderMarkdown(entry.content)}</div>
      </div>
    `).join("");
  }

  _renderSuggestions() {
    const directions = this._directions;
    if (!directions.length) {
      return `<div class="ace-directions-empty">
        <i class="fas fa-compass ace-directions-empty-icon"></i>
        <p>No story directions yet.</p>
        <p class="ace-welcome-hint">Click <strong>Refresh</strong> to get 3 options for where to take the story. Accepting one streams a generated passage into the Narration tab for review.</p>
      </div>`;
    }

    return directions.map((d, i) => `
      <div class="ace-direction-card" data-idx="${i}">
        <div class="ace-direction-header">
          <span class="ace-direction-num">${i + 1}</span>
          <strong class="ace-direction-title">${this._escapeHtml(d.title)}</strong>
          <button class="ace-icon-btn ace-dismiss-btn"
                  data-action="dismissDirection" data-idx="${i}"
                  title="Dismiss this option">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <p class="ace-direction-desc">${this._escapeHtml(d.description)}</p>
        ${d.consequence ? `
          <p class="ace-direction-consequence">
            <i class="fas fa-arrow-right"></i> ${this._escapeHtml(d.consequence)}
          </p>` : ""}
        <div class="ace-direction-actions">
          <button class="ace-btn ace-btn-accept" data-action="acceptDirection" data-idx="${i}">
            <i class="fas fa-check"></i> Generate Passage
          </button>
        </div>
      </div>
    `).join("");
  }

  // ── Lifecycle ──────────────────────────────────────────────

  _onRender(context, options) {
    // Position on first render — center for splash, right side for normal panel
    if (!this._positioned) {
      this._positioned = true;
      if (this._showingSplash) {
        // Center the panel on screen for the cinematic splash
        const w = this.position?.width  ?? 555;
        const h = this.position?.height ?? 740;
        const centerLeft = Math.max(20, (window.innerWidth  - w) / 2);
        const centerTop  = Math.max(20, (window.innerHeight - h) / 2);
        try { this.setPosition({ left: centerLeft, top: centerTop }); } catch (_) {}
      } else {
        try { this.setPosition({ left: this._getTargetLeft() }); } catch (_) {}
      }
    }

    // Bind sidebar listener so the panel shifts when sidebar opens/closes
    this._initSidebarListener();

    // Full-panel drag — works in splash AND panel mode, binds once
    this._initPanelDrag();

    // ── Splash mode: hide Foundry header, skip all panel wiring ──
    if (this._showingSplash) {
      this.element.classList.add("ace-splash-mode");
      // Auto-dismiss after 3.5 seconds (or click skips immediately)
      if (this._splashTimer) clearTimeout(this._splashTimer);
      this._splashTimer = setTimeout(() => {
        if (!this._showingSplash) return;
        AcePanel._onOpenFromSplash.call(this, null, null);
      }, 3500);
      return;
    }
    // Panel mode: ensure header is visible
    this.element.classList.remove("ace-splash-mode");

    // ── Inject TTS controls + minimize button into header ──
    const header = this.element.querySelector(".window-header, header");

    // Move TTS controls from tab bar to header (after title, before window controls)
    if (header && !header.querySelector("#ace-header-tts")) {
      const ttsSource = this.element.querySelector("#ace-tts-controls");
      if (ttsSource) {
        const ttsWrap = document.createElement("div");
        ttsWrap.id = "ace-header-tts";
        ttsWrap.className = "ace-header-tts";
        ttsWrap.innerHTML = ttsSource.innerHTML;
        // Copy action handlers by re-using the same data-action attributes
        const titleEl = header.querySelector(".window-title, .application-title");
        if (titleEl) titleEl.after(ttsWrap);
        else header.prepend(ttsWrap);
      }
    }

    if (header && !header.querySelector(".ace-btn-minimize")) {
      const minBtn = document.createElement("button");
      minBtn.className = "header-control ace-btn-minimize";
      minBtn.type = "button";
      minBtn.title = "Minimize to badge";
      minBtn.innerHTML = '<i class="fas fa-minus"></i>';
      minBtn.dataset.action = "minimizeToBadge";
      // Insert before the close button
      const closeBtn = header.querySelector("button.close, button[data-action='close'], .header-control:last-child");
      if (closeBtn) header.insertBefore(minBtn, closeBtn);
      else header.appendChild(minBtn);
    }

    // Chat textarea — Enter sends to AI
    const input = this.element.querySelector("#ace-input");
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this._sendMessage();
        }
      });
      if (this._activeTab === "chat") input.focus();
    }

    // Narration textarea — Enter sends to players, Shift+Enter for newline
    const narInput = this.element.querySelector("#ace-narration-input");
    if (narInput) {
      narInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this._narrateSendMessage();
        }
      });
      if (this._activeTab === "narration") narInput.focus();
    }

    // Encounter prompt — Enter generates encounter, Shift+Enter for newline
    const encounterInput = this.element.querySelector("#ace-encounter-prompt");
    if (encounterInput) {
      encounterInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const genBtn = this.element.querySelector('[data-action="generateEncounter"]');
          if (genBtn && !genBtn.disabled) genBtn.click();
        }
      });
    }

    // Quick note bar — Enter saves to memory
    const noteInput = this.element.querySelector("#ace-note-input");
    if (noteInput) {
      noteInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this._saveQuickNote();
        }
      });
    }

    // Encounter tab — draggable split pane divider
    this._wireEncounterDivider();

    // Subscribe to suggestion engine updates (guard: only subscribe once)
    if (this.suggestions && !this._unsubSuggestions) {
      this._unsubSuggestions = this.suggestions.on((directions) => {
        this._directions = [...directions];
        this._refreshSuggestionsUI();
        if (directions.length && this._activeTab !== "suggestions") {
          const ideasTab = this.element?.querySelector(".ace-tab[data-tab='suggestions']");
          if (ideasTab && !ideasTab.querySelector(".ace-badge")) {
            const badge = document.createElement("span");
            badge.className   = "ace-badge";
            badge.textContent = directions.length;
            ideasTab.appendChild(badge);
          }
        }
      });
    }

    this._scrollChatToBottom();
    this._scrollNarrationToBottom();

    // Force spellcheck on all textareas (Foundry V13 may override)
    this.element.querySelectorAll("textarea").forEach(t => t.setAttribute("spellcheck", "true"));

    // Wire hover events for Select Scene Elements panel
    if (this._activeTab === "elements") {
      this._wireSelectPanelEvents();
    }

    // Re-wire encounter creature drag-drop after re-render (popout/back)
    if (this._encounterData) {
      this._wireEncounterDragDrop();
    }
  }

  /**
   * Override close() to intercept when unsaved events exist.
   * Offers "Exit & Save Session" or "Minimize ACE" — catching accidental closes.
   * X on dialog cancels the close entirely.
   * Passes _aceForceClose: true internally so the recursive call bypasses this check.
   */
  async close(options = {}) {
    // Only intercept when there are unsaved events and no summary in progress
    if (
      !options._aceForceClose &&
      this.lkMemory &&
      !this._isGeneratingSummary &&
      this.lkMemory.getEventsSinceLastSummary().length > 0
    ) {
      const events     = this.lkMemory.getEventsSinceLastSummary();
      const eventCount = events.length;
      const eventLines = events.map(e => this.lkMemory.history.eventToText(e)).filter(Boolean);

      let choice;
      try {
        choice = await _aceCloseDialog(eventCount, eventLines);
      } catch (_) {
        // User clicked X on dialog — changed their mind, don't close
        return;
      }

      if (choice === "save") {
        await this._runEndSession();
        // Fall through to super.close()
      } else if (choice === "minimize") {
        // Minimize instead of closing — no data loss
        AcePanel._onMinimizeToBadge.call(this);
        return;
      }
      // choice === "exit" → fall through to super.close() without saving
    }

    // Normal close (fire-and-forget guard prevents double-prompt)
    return super.close({ ...options, _aceForceClose: true });
  }

  _onClose(options) {
    // Clear splash auto-dismiss timer
    if (this._splashTimer) { clearTimeout(this._splashTimer); this._splashTimer = null; }
    if (this._unsubSuggestions) {
      this._unsubSuggestions();
      this._unsubSuggestions = null;
    }
    // Unhook Simple Calendar time sync listener
    if (this._timeSyncHookId !== undefined) {
      Hooks.off("ace-engine.timeSync", this._timeSyncHookId);
      this._timeSyncHookId = undefined;
    }
    // Clean up document-level drag listeners (prevent leak on reopen)
    if (this._panelDragCleanup) {
      this._panelDragCleanup();
      this._panelDragCleanup = null;
      this._panelDragBound = false;
    }
    // Clean up sidebar observer + hook
    if (this._sidebarObserver) {
      this._sidebarObserver.disconnect();
      this._sidebarObserver = null;
    }
    if (this._sidebarHookId !== undefined) {
      Hooks.off("collapseSidebar", this._sidebarHookId);
      this._sidebarHookId = undefined;
    }
    this._sidebarListenerBound = false;
    this._stopVoice();
    this._stopNarrationVoice();
    this._cancelTTS();
    // Stop deed voice recognition if active
    if (this._deedRecognition) {
      this._deedRecognition.abort();
      this._deedRecognition = null;
    }
  }

  // ── Tab Actions ────────────────────────────────────────────

  static _onSwitchTab(event, target) {
    const tab = target.dataset.tab;
    if (!tab) return;
    this._activeTab = tab;

    // Auto-stop voice recognition when switching away from its tab
    if (tab !== "narration" && this._narrationListening) this._stopNarrationVoice();
    if (tab !== "chat" && this._isListening) this._stopVoice();

    // Clear canvas highlights when leaving Select tab (mouseleave may not fire on tab switch)
    if (this._activeTab === "elements" && tab !== "elements") {
      CanvasHighlight.clearAll();
    }

    this.element.querySelectorAll(".ace-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    this.element.querySelectorAll(".ace-tab-content").forEach((el) => {
      el.classList.toggle("active", el.dataset.tabContent === tab);
    });
    if (tab === "suggestions") {
      this.element.querySelector(".ace-tab[data-tab='suggestions'] .ace-badge")?.remove();
    }
    if (tab === "narration") {
      this._scrollNarrationToBottom();
      this.element.querySelector("#ace-narration-input")?.focus();
    }
    if (tab === "elements") {
      // Refresh content & wire hover events when switching to Select tab
      const container = this.element.querySelector('[data-tab-content="elements"]');
      if (container) {
        container.innerHTML = this._buildSelectElementsPanel();
        this._wireSelectPanelEvents();
      }
    }
    if (tab === "library") {
      // Refresh library content & wire drag-drop events
      this._refreshLibraryUI();
    }
  }

  // ── Universal Stop Audio ────────────────────────────────────

  static _onStopAudio(event, target) {
    this._cancelTTS();   // stops ElevenLabs audio + browser TTS
    this.stopSfx();      // stops thunder audio + any browser speech synthesis
    // Also kill standalone narration audio (broadcast TTS that bypasses panel)
    const api = game.modules.get("ace-engine")?.api;
    if (api?.stopAllAudio) api.stopAllAudio();
    // Broadcast stop to ALL players so their audio stops too
    game.socket.emit(`module.${MODULE_ID}`, {
      type: "stop-audio",
      userId: game.user.id,
    });
  }

  // ── TTS Pause / Resume / Stop ────────────────────────────

  // ── Digest Pause (library card button) ─────────────────────

  static _onDigestPause(event, target) {
    const docId = target.closest("[data-doc-id]")?.dataset.docId;
    if (!docId || !this._digestEngine) return;
    if (this._digestEngine._paused) {
      this._digestEngine.resumeDigest();
      this._updateLibraryCardStatus(docId, "🧠 Resuming digest…");
    } else {
      this._digestEngine.pauseDigest();
      this._updateLibraryCardStatus(docId, "⏸ Digest paused — click to resume");
    }
    // Update button appearance
    const btn = target.closest("button");
    if (btn && this._digestEngine._paused) {
      btn.innerHTML = `<i class="fas fa-play"></i>`;
      btn.title = "Resume digest";
      btn.classList.add("ace-digest-paused");
    } else if (btn) {
      btn.innerHTML = `<i class="fas fa-pause"></i>`;
      btn.title = "Pause digest";
      btn.classList.remove("ace-digest-paused");
    }
  }

  // ── World Bible Actions ─────────────────────────────────────

  static async _onWorldBibleGenerate(event, target) {
    if (!this._worldBible || !this.ai) {
      ui.notifications?.warn("ACE: AI provider not initialized.");
      return;
    }
    if (this._worldBible.isRunning) {
      ui.notifications?.info("World Bible generation already in progress.");
      return;
    }

    // Get selected setting
    const settingEl = this.element?.querySelector("#ace-world-bible-setting");
    const settingVal = settingEl?.value ?? "faerun";

    let setting, era;
    switch (settingVal) {
      case "faerun":
        setting = "Forgotten Realms — Faerûn";
        era = "Post-Sundering (5e, ~1489-1496 DR)";
        break;
      case "eberron":
        setting = "Eberron";
        era = "998 YK (5e era)";
        break;
      case "greyhawk":
        setting = "Greyhawk — Oerth";
        era = "Common Year 591 (5e era)";
        break;
      default:
        ui.notifications?.warn("Custom settings not yet supported — coming soon!");
        return;
    }

    // Show progress bar
    const progressEl = this.element?.querySelector("#ace-world-bible-progress");
    if (progressEl) {
      progressEl.style.display = "block";
      progressEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Starting World Bible generation...`;
    }

    // Disable the button
    const btn = target.closest("button");
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = "0.5";
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Generating...`;
    }

    try {
      await this._worldBible.generate(setting, era, this.ai, game.world.id, (step, total, regionName, phase) => {
        if (progressEl) {
          const pct = Math.round((step / total) * 100);
          const bar = `<div style="background:#333;border-radius:3px;height:6px;margin-top:4px;"><div style="background:linear-gradient(90deg,#d4af37,#c49b2f);height:6px;border-radius:3px;width:${pct}%;transition:width 0.3s;"></div></div>`;
          if (phase === "paused") {
            progressEl.innerHTML = `<i class="fas fa-pause"></i> Paused at ${regionName} (${step}/${total})${bar}`;
          } else if (phase === "complete") {
            progressEl.innerHTML = `<i class="fas fa-check" style="color:#50c878"></i> World Bible complete! ${total} regions generated.${bar}`;
          } else {
            progressEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${regionName} (${step}/${total})${bar}`;
          }
        }
      });

      ui.notifications?.info(`World Bible generated! ${this._worldBible.getStats()?.nationCount ?? 0} nations, ${this._worldBible.getStats()?.cityCount ?? 0} cities, ${this._worldBible.getStats()?.factionCount ?? 0} factions.`);

      // Refresh the library panel to show the new bible stats
      this._refreshLibraryUI();

    } catch (err) {
      console.error(`${MODULE_ID} | World Bible generation error:`, err);
      if (progressEl) {
        progressEl.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:#ff6b6b"></i> ${err.message}`;
      }
      if (!err.message?.includes("cancelled")) {
        ui.notifications?.error(`World Bible: ${err.message}`);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.innerHTML = `<i class="fas fa-globe"></i> Generate World Bible`;
      }
    }
  }

  static async _onWorldBibleRegenerate(event, target) {
    const confirmed = await Dialog.confirm({
      title: "Regenerate World Bible",
      content: `<p>This will <strong>overwrite</strong> the current World Bible with freshly generated data.</p>
        <p>A backup of the current version will be saved first.</p>
        <p style="color:#d4af37;font-weight:600;margin-top:8px;">&#9888; This costs ~14 AI API calls and may use $2\u20134 in API credits depending on your provider.</p>
        <p>Continue?</p>`,
    });
    if (!confirmed) return;

    // Backup current before regenerating
    if (this._worldBible?.hasData) {
      await this._worldBible.backup(game.world.id);
      ui.notifications?.info("Current World Bible backed up.");
    }

    // Trigger generate with the existing setting
    const stats = this._worldBible?.getStats();
    const settingVal = stats?.setting?.includes("Faerûn") ? "faerun"
                     : stats?.setting?.includes("Eberron") ? "eberron"
                     : stats?.setting?.includes("Greyhawk") ? "greyhawk"
                     : "faerun";

    // Create a fake select element value for the generate handler
    const section = this.element?.querySelector("#ace-world-bible-section");
    if (section) {
      // Replace section with generation UI temporarily
      this._worldBible._bible = null;
      this._worldBible._loaded = true;
      this._refreshLibraryUI();
      // Set the dropdown to match previous setting
      const dropdown = this.element?.querySelector("#ace-world-bible-setting");
      if (dropdown) dropdown.value = settingVal;
    }
  }


  // ── Session Memory Actions ──────────────────────────────────

  static async _onEndSession(event, target) {
    await this._runEndSession();
  }

  static _onSaveNote(event, target) {
    this._saveQuickNote();
  }

  static async _onMemoryManagement(event, target) {
    if (!this.lkMemory) {
      ui.notifications?.warn("ACE: Memory system not available.");
      return;
    }
    // Lazy-import the dialog to keep panel.mjs lightweight
    try {
      const { AceMemoryDialog } = await import("./memory-dialog.mjs");
      new AceMemoryDialog(this.lkMemory).render(true);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to open Memory Management dialog:`, err);
      ui.notifications?.error("ACE: Could not open Memory Management — see console.");
    }
  }

  /** Click on the TTS status badge → open Module Settings so user can paste their ElevenLabs key. */
  static _onOpenTtsSettings(event, target) {
    // Open Foundry's module settings config and scroll to ACE section
    try {
      const SC = foundry?.applications?.settings?.SettingsConfig ?? globalThis.SettingsConfig;
      const settingsApp = new SC();
      settingsApp.render(true);
      // After it opens, try to scroll to the ace-engine section
      Hooks.once("renderSettingsConfig", (_app, html) => {
        const root = html instanceof HTMLElement ? html : html?.[0];
        if (!root) return;
        setTimeout(() => {
          const elevenInput = root.querySelector(`[name="${MODULE_ID}.elevenLabsApiKey"]`);
          if (elevenInput) elevenInput.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 300);
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not open settings:`, err);
      ui.notifications?.info("Go to Foundry Settings ⚙ → Module Settings → ACE to set your ElevenLabs API key.");
    }
  }

  // ── Splash screen Action ───────────────────────────────────

  /**
   * Click anywhere on the splash (or auto-dismiss timer) → animate out,
   * then re-render the full tabbed panel UI.
   */
  static async _onOpenFromSplash(event, target) {
    // Don't trigger from the close button
    if (target?.closest("[data-action='closeSplash']")) return;

    // Clear auto-dismiss timer
    if (this._splashTimer) { clearTimeout(this._splashTimer); this._splashTimer = null; }

    const splash = this.element?.querySelector("#ace-splash");
    if (splash) {
      splash.classList.add("ace-splash-opening");

      // Slide the panel toward its final right-side position during fade-out,
      // accounting for the Foundry sidebar width so it doesn't overlap.
      const el = this.element;
      if (el) {
        el.style.transition = "left 0.5s ease, top 0.5s ease";
        const targetLeft = this._getTargetLeft();
        const targetTop  = 80;
        try { this.setPosition({ left: targetLeft, top: targetTop }); } catch (_) {}
      }

      await new Promise((r) => setTimeout(r, 500));

      // Clean up transition so dragging isn't animated
      if (el) el.style.transition = "";
    }
    this._showingSplash = false;
    this.render();
  }

  /** X button — closes the panel entirely without entering the UI. */
  static _onCloseSplash(event, target) {
    if (this._splashTimer) { clearTimeout(this._splashTimer); this._splashTimer = null; }
    this.close();
  }

  // ── Sidebar-aware positioning ──────────────────────────────

  /**
   * Calculate the ideal left position for the panel, accounting for the
   * Foundry sidebar width so the panel doesn't overlap it.
   */
  _getTargetLeft() {
    const panelW = this.position?.width ?? 555;
    const gap = 10;
    let sidebarW = 0;
    try {
      // The tab icon strip never moves — its left edge is our anchor.
      // When collapsed: ACE sits left of the tab strip.
      // When expanded: ACE sits left of the tab strip + content panel.
      const contentEl = document.getElementById("sidebar-content");
      const isExpanded = contentEl?.classList.contains("expanded");
      // Tab strip width is constant; content width is added when expanded
      sidebarW = this._sidebarTabsWidth || 58;
      if (isExpanded) {
        sidebarW += this._sidebarContentWidth || 312;
      }
    } catch (_) { /* no sidebar */ }
    return Math.max(20, window.innerWidth - panelW - gap - sidebarW);
  }

  /**
   * Listen for sidebar open/close and reposition the panel to stay clear.
   * Uses a MutationObserver on #sidebar-content to detect the "expanded"
   * class toggle — works regardless of how the sidebar is opened/closed
   * (collapse arrow, tab click, API call, etc.).
   */
  _initSidebarListener() {
    if (this._sidebarListenerBound) return;
    this._sidebarListenerBound = true;

    const contentEl = document.getElementById("sidebar-content");
    const sidebarEl = document.getElementById("sidebar");

    // Measure the tab strip width once (it never changes)
    const tabsEl = sidebarEl?.querySelector("nav.tabs");
    this._sidebarTabsWidth = tabsEl ? tabsEl.getBoundingClientRect().width : 58;
    // Measure content panel width — use CSS variable if available, else measure
    const sidebarWidth = getComputedStyle(document.documentElement)
      .getPropertyValue("--sidebar-full-width")?.trim();
    if (sidebarWidth) {
      // Parse "calc(300px + 12px)" → just use the sidebar-width (300) + scroll gutter (12)
      const sw = parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue("--sidebar-width")) || 300;
      const sg = parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue("--sidebar-scroll-gutter")) || 12;
      this._sidebarContentWidth = sw + sg;
    } else {
      this._sidebarContentWidth = contentEl?.getBoundingClientRect().width || 312;
    }

    if (contentEl) {
      this._sidebarObserver = new MutationObserver(() => {
        if (this._showingSplash || this._savedPosition) return;
        // Slide immediately — no delay, moves in sync with the sidebar
        this._slideToSidebar();
      });
      this._sidebarObserver.observe(contentEl, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    // Fallback: also listen to Foundry's hook
    this._sidebarHookId = Hooks.on("collapseSidebar", () => {
      if (this._showingSplash || this._savedPosition) return;
      this._slideToSidebar();
    });
  }

  /** Smoothly slide ACE to sit flush against the sidebar's left edge. */
  _slideToSidebar() {
    const newLeft = this._getTargetLeft();
    const el = this.element;
    if (!el) return;
    // Skip if panel is already at (or very near) the target position
    const currentLeft = this.position?.left ?? 0;
    if (Math.abs(currentLeft - newLeft) < 5) return;
    el.style.transition = "left 0.35s ease";
    this.setPosition({ left: newLeft });
    const cleanup = () => {
      el.style.transition = "";
      el.removeEventListener("transitionend", cleanup);
    };
    el.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 400);
  }

  // ── Full-Panel Drag ────────────────────────────────────────

  /**
   * Allow the entire panel to be dragged by grabbing any non-interactive area.
   * Only true input elements (buttons, links, form controls) are excluded.
   * Scrollable areas are NOT excluded — users scroll with the mouse-wheel and
   * native scrollbar clicks don't bubble to our handler.
   * A 5 px dead-zone distinguishes an intentional drag from a stray click.
   * Works in both splash and normal panel modes.
   */
  _initPanelDrag() {
    // Only bind once — this.element persists across ApplicationV2 re-renders
    if (this._panelDragBound) return;
    this._panelDragBound = true;

    // Skip elements that need their own click / focus / text selection
    const INTERACTIVE = "button, a, input, textarea, select, [contenteditable]";

    // Content areas where text selection MUST work — never start drag here
    const TEXT_CONTENT = [
      ".ace-chat-messages",     // chat message list container
      ".ace-message",           // individual chat messages
      ".ace-msg-body",          // message body text (rendered markdown)
      ".ace-narration-preview", // narration output
      ".ace-narration-log",     // narration history
      ".ace-ideas-cards",       // idea cards
      ".ace-encounter-output",  // encounter analysis
      ".ace-enc-interactive",   // interactive encounter (draggable creatures, buttons)
      "[draggable='true']",     // any draggable element (creature cards etc.)
      ".ace-select-output",     // select panel output
      ".ace-response",          // any AI response block
      ".ace-cf-result",         // crit/fumble results
      ".ace-message-body",      // message body text (legacy class)
      "pre", "code",            // code blocks
      "p", "li", "td", "th",   // any paragraph / list / table content
    ].join(", ");

    const DRAG_THRESHOLD = 5;
    let dragging = false;
    let startX, startY, origLeft, origTop;

    const onMouseDown = (e) => {
      if (e.button !== 0) return;                       // primary button only
      if (e.target.closest(INTERACTIVE)) return;        // interactive form element
      if (e.target.closest(TEXT_CONTENT)) return;       // text content — allow selection
      if (this.element.classList.contains("ace-minimized")) return; // badge has own drag

      dragging = true;
      this._wasPanelDrag = false;
      startX   = e.clientX;
      startY   = e.clientY;
      const rect = this.element.getBoundingClientRect();
      origLeft = rect.left;
      origTop  = rect.top;
      e.preventDefault();                               // prevent text-selection only on drag handles
    };

    const onMouseMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        this._wasPanelDrag = true;
        try {
          this.setPosition({ left: origLeft + dx, top: origTop + dy });
        } catch (_) { /* ignore */ }
      }
    };

    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
    };

    this.element.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    // Store cleanup function so _onClose() can remove document-level listeners
    this._panelDragCleanup = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }

  // ── Minimize Badge Actions ─────────────────────────────────

  /** "-" button — collapse to small gold badge */
  static _onMinimizeToBadge(event, target) {
    this._savedPosition = { ...this.position };
    this.element.classList.add("ace-minimized");
    try {
      this.setPosition({ width: 120, height: 48 });
    } catch (_) { /* ignore */ }
    // Wire up drag on the badge (header is hidden so Foundry's drag is gone)
    this._initBadgeDrag();
  }

  /**
   * Make the minimized badge draggable.
   * Foundry's built-in drag lives on the header, which we hide when minimized,
   * so we add our own mousedown → mousemove → mouseup handlers on the badge.
   * Uses a 5px dead-zone to distinguish click (restore) from drag (reposition).
   */
  _initBadgeDrag() {
    const badge = this.element.querySelector(".ace-mini-badge");
    if (!badge || badge._aceDragBound) return;          // already wired
    badge._aceDragBound = true;
    this._wasBadgeDrag = false;

    let dragging = false;
    let startX, startY, origLeft, origTop;
    const DRAG_THRESHOLD = 5;                          // px dead-zone

    const onMouseDown = (e) => {
      // Ignore clicks on the close rivet
      if (e.target.closest("[data-action='badgeClose']")) return;
      dragging  = true;
      this._wasBadgeDrag = false;
      startX    = e.clientX;
      startY    = e.clientY;
      const rect = this.element.getBoundingClientRect();
      origLeft  = rect.left;
      origTop   = rect.top;
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Only start moving after exceeding threshold
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        this._wasBadgeDrag = true;
        try {
          this.setPosition({ left: origLeft + dx, top: origTop + dy });
        } catch (_) { /* ignore */ }
      }
    };

    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
    };

    badge.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    // Store cleanup refs so we can remove them when restoring
    this._badgeDragCleanup = () => {
      badge.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      badge._aceDragBound = false;
      this._badgeDragCleanup = null;
    };
  }

  /** Clean up badge drag handlers */
  _teardownBadgeDrag() {
    if (this._badgeDragCleanup) this._badgeDragCleanup();
  }

  /** Click badge body — restore full panel */
  static _onRestoreFromBadge(event, target) {
    // Don't restore if clicking the close rivet
    if (event.target.closest("[data-action='badgeClose']")) return;
    // If user just finished dragging, swallow the click
    if (this._wasBadgeDrag) { this._wasBadgeDrag = false; return; }

    const rect = this.element.getBoundingClientRect();
    this._teardownBadgeDrag();
    this.element.classList.remove("ace-minimized");
    if (this._savedPosition) {
      try {
        this.setPosition({
          left:   rect.left,              // keep where user dragged it
          top:    rect.top,               // keep where user dragged it
          width:  this._savedPosition.width,
          height: this._savedPosition.height,
        });
      } catch (_) { /* ignore */ }
      this._savedPosition = null;
    }
  }

  /** NE rivet X — close ACE (shows Exit & Save / Minimize dialog if unsaved events) */
  static async _onBadgeClose(event, target) {
    event.stopPropagation();
    this._teardownBadgeDrag();
    // Restore from minimized state first so the dialog is visible
    this.element.classList.remove("ace-minimized");
    if (this._savedPosition) {
      try {
        this.setPosition({
          width:  this._savedPosition.width,
          height: this._savedPosition.height,
        });
      } catch (_) { /* ignore */ }
      this._savedPosition = null;
    }
    // Trigger the standard close flow (Exit & Save / Minimize dialog)
    this.close();
  }

  // ── Survival Tracker Actions ────────────────────────────────

  static _onMealReset(event, target) {
    this._tracker.scenesSinceMeal = 0;
    this._tracker.mealTime        = Date.now();
    this._mealWarned4 = false;
    this._mealWarned8 = false;
    this._updateTrackerUI();
    ui.notifications.info("🍖 Meal logged — tracker reset.");
  }

  static _onRestReset(event, target) {
    this._tracker.scenesSinceRest = 0;
    this._tracker.restTime        = Date.now();
    this._restWarned8  = false;
    this._restWarned15 = false;
    this._updateTrackerUI();

    // ── Advance day counter on rest (long rest ≈ new day) ────
    try {
      if (this.lkMemory && game.settings.get("ace-engine", "enableNarrativeTime")) {
        const newDay = this.lkMemory.advanceDay(1, "morning");
        this._updateDayCounterUI();
        ui.notifications.info(`💤 Rest logged — Day ${newDay} (morning)`);
        return;  // skip the generic notification below
      }
    } catch (_) { /* non-critical */ }

    ui.notifications.info("💤 Rest logged — tracker reset.");
  }

  // ── Chat tab Actions ───────────────────────────────────────

  static async _onSendMessage(event, target) {
    await this._sendMessage();
  }

  static async _onClearChat(event, target) {
    this._chatHistory = [];
    this._refreshChatUI();
  }

  static _onVoiceInput(event, target) {
    if (this._isListening) this._stopVoice();
    else this._startVoice();
  }

  static async _onAnalyzeNpcTactics(event, target) {
    if (!game.combat?.started) {
      this._chatHistory.push({
        role:      "assistant",
        content:   "⚔️ **NPC Tactics** — No active combat. Start an encounter first, or ask me about any NPC.",
        timestamp: Date.now(),
        isTactic:  true,
      });
      this._refreshChatUI();
      this._scrollChatToBottom();
      return;
    }
    target.disabled = true;
    try {
      await this.suggestNpcTactic(game.combat, game.combat.combatant);
    } finally {
      target.disabled = false;
    }
  }

  static _onCopyMessage(event, target) {
    const idx = parseInt(target.dataset.index ?? target.closest("[data-index]")?.dataset.index);
    const msg = this._chatHistory[idx];
    if (!msg) return;

    // Clean up the content for clipboard:
    // 1. Strip markdown bold/italic markers
    // 2. Strip any [NARRATION] / [/NARRATION] tags
    // 3. Strip leading "Entering X:" or "**Entering X:**" title lines
    let text = msg.content
      .replace(/\[\/?(NARRATION|narration)\]/g, "")
      .replace(/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/^#{1,3}\s+.*\n?/gm, "")       // strip markdown headers
      .replace(/^> /gm, "")                     // strip blockquote markers
      .trim();

    navigator.clipboard.writeText(text);
    ui.notifications.info("Copied to clipboard!");
  }

  /**
   * Send narration text from a chat message to the Narration tab textarea.
   * Extracts [NARRATION] block if present, otherwise sends full message.
   */
  static _onSendToNarration(event, target) {
    const idx = parseInt(target.dataset.index ?? target.closest("[data-index]")?.dataset.index);
    const msg = this._chatHistory[idx];
    if (!msg) return;

    // Extract narration content (strips [NARRATION] tags, or uses full text)
    let text = AcePanel._extractNarration(msg.content);
    // Strip remaining markdown for clean textarea content
    text = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/^#+\s+/gm, "").trim();

    // Switch to narration tab and fill textarea
    this._switchToTab("narration");
    const textarea = this.element.querySelector("#ace-narration-input");
    if (textarea) {
      textarea.value = text;
      textarea.focus();
      // Auto-grow textarea to fit content
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
    }
    ui.notifications.info("Sent to Narration tab — review and edit before broadcasting.");
  }

  static _onCopyNarration(event, target) {
    const idx = parseInt(target.dataset.index ?? target.closest("[data-index]")?.dataset.index);
    const entry = this._narrationHistory[idx];
    if (entry) {
      // Strip markdown symbols for clean plain text
      const plain = entry.content
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/^#+\s+/gm, "")
        .trim();
      navigator.clipboard.writeText(plain);
      ui.notifications.info("Copied to clipboard!");
    }
  }

  static _onCopyCritFumble(event, target) {
    const result = this.element?.querySelector("#ace-cf-result");
    if (!result) return;
    // Get text content, skip the copy button's own text
    const clone = result.cloneNode(true);
    clone.querySelectorAll("button").forEach(b => b.remove());
    navigator.clipboard.writeText((clone.innerText ?? clone.textContent).trim());
    ui.notifications.info("Copied to clipboard!");
  }

  static async _onSaveToJournal(event, target) {
    const idx = parseInt(target.dataset.index ?? target.closest("[data-index]")?.dataset.index);
    const msg = this._chatHistory[idx];
    if (!msg) return;

    const journalName = `[ACE] ${new Date().toLocaleString()}`;
    const journal = await JournalEntry.create({
      name: journalName,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    });
    await JournalEntryPage.create(
      {
        name: "ACE Note",
        type: "text",
        text: { content: `<div>${msg.content.replace(/\n/g, "<br>")}</div>` },
      },
      { parent: journal }
    );
    ui.notifications.info(`Saved to journal: ${journalName}`);
  }

  static async _onLearnFromChat(event, target) {
    const idx = parseInt(target.dataset.index ?? target.closest("[data-index]")?.dataset.index);
    if (isNaN(idx)) return;

    // Visual feedback on button
    const btn = target.closest("[data-action]") || target;
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i>`;

    try {
      const result = await this._learnFromMessage(idx);
      // Flash green on success
      btn.innerHTML = `<i class="fas fa-check" style="color:#50c878"></i>`;
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }, 2000);
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }

  // ── Narration tab Actions ──────────────────────────────────

  static _onNarrationVoice(event, target) {
    if (this._narrationListening) this._stopNarrationVoice();
    else this._startNarrationVoice();
  }

  /** Toggle voice gender: auto → male → female → auto */
  static _onToggleVoiceGender(event, target) {
    const cycle = { auto: "male", male: "female", female: "auto" };
    this._voiceGender = cycle[this._voiceGender] || "auto";
    // Update button appearance
    const btn = this.element?.querySelector('[data-action="toggleVoiceGender"]');
    if (btn) {
      btn.className = `ace-btn ace-btn-voice-gender ${this._voiceGender === "female" ? "ace-voice-female" : this._voiceGender === "male" ? "ace-voice-male" : ""}`;
      btn.title = `Voice gender: ${this._voiceGender} — click to cycle (auto → male → female)`;
      const icon = btn.querySelector("i");
      if (icon) icon.className = `fas ${this._voiceGender === "female" ? "fa-venus" : this._voiceGender === "male" ? "fa-mars" : "fa-random"}`;
    }
    const labels = { auto: "Voice: Auto-detect gender", male: "Voice: Male", female: "Voice: Female" };
    ui.notifications?.info(labels[this._voiceGender]);
  }

  /** AI Polish — send the raw transcript through the AI for punctuation + cleanup. */
  static async _onPolishNarration(event, target) {
    const input = this.element?.querySelector("#ace-narration-input");
    const raw = input?.value?.trim();
    if (!raw) {
      ui.notifications?.warn("Nothing to polish — type or speak some text first.");
      return;
    }
    if (!this.ai) {
      ui.notifications?.warn("ACE: AI provider not configured — can't polish text.");
      return;
    }

    // Show spinner on button while processing
    const btn = this.element?.querySelector('[data-action="polishNarration"]');
    const origHtml = btn?.innerHTML;
    if (btn) { btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; btn.disabled = true; }

    try {
      const prompt =
        `Add punctuation, capitalization, and paragraph breaks to the following spoken narration text. ` +
        `Keep the EXACT same words — do not rewrite, expand, or add new content. ` +
        `Only add periods, commas, question marks, exclamation points, and capitalize sentence starts. ` +
        `Return ONLY the corrected text with no explanation or commentary.\n\n${raw}`;

      let polished = "";
      await this.ai.chatStream(prompt, "", "", [], (chunk) => { polished += chunk; });

      polished = polished.trim();
      if (polished) {
        input.value = polished;
        console.log(`${MODULE_ID} | Polish: cleaned up ${raw.length} chars → ${polished.length} chars`);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Polish failed:`, err);
      ui.notifications?.warn("ACE: AI polish failed — see console.");
    }

    if (btn) { btn.innerHTML = origHtml; btn.disabled = false; }
  }

  static async _onNarrateSend(event, target) {
    await this._narrateSendMessage();
  }

  static _onClearNarration(event, target) {
    this._narrationHistory = [];
    this._refreshNarrationUI();
  }

  // ── SFX Action — Thunder only ───────────────────────────────

  static _onSfxLightning(event, target) {
    target.disabled = true;
    setTimeout(() => { target.disabled = false; }, 2500);
    this.triggerSfx("lightning");
  }

  static _onSfxEarthquake(event, target) {
    target.disabled = true;
    setTimeout(() => { target.disabled = false; }, 3000);
    this.triggerSfx("earthquake");
  }

  static _onSfxStealthFail(event, target) {
    AcePanel._showPlayerPicker.call(this, "stealthFail", "Stealth Fail — Who stepped on the twig?", target);
  }

  static _onSfxPerceptionPass(event, target) {
    AcePanel._showPlayerPicker.call(this, "perceptionPass", "Perception Pass — Who heard something?", target);
  }

  /**
   * Shows a quick player-picker dropdown so the GM can target one player.
   * Plays the SFX only on that player's client.
   */
  static _showPlayerPicker(effect, title, buttonEl) {
    // Get active non-GM players
    const players = game.users.filter(u => u.active && !u.isGM);
    if (!players.length) {
      ui.notifications.warn("No active players connected.");
      return;
    }

    // If only one player, skip the picker
    if (players.length === 1) {
      this.triggerSfx(effect, players[0].id);
      ui.notifications.info(`🔊 ${effect === "stealthFail" ? "Stealth fail" : "Perception pass"} sent to ${players[0].name}`);
      return;
    }

    // Build a quick dialog with player buttons
    const btnHtml = players.map(p =>
      `<button class="ace-player-pick-btn" data-user-id="${p.id}" style="
        display:block; width:100%; margin:4px 0; padding:8px 12px;
        background:linear-gradient(135deg,#1a1a1e,#222226); color:#d4af37;
        border:1px solid #d4af37; border-radius:4px; cursor:pointer;
        font-family:'Rajdhani',sans-serif; font-size:14px; text-transform:uppercase;
        letter-spacing:1px; transition: background 0.2s;
      ">${p.name}</button>`
    ).join("");

    const d = new Dialog({
      title,
      content: `<div style="padding:6px 0;">${btnHtml}</div>`,
      buttons: {},
      render: (html) => {
        html.find(".ace-player-pick-btn").on("click", (ev) => {
          const userId = ev.currentTarget.dataset.userId;
          const userName = game.users.get(userId)?.name || "player";
          this.triggerSfx(effect, userId);
          ui.notifications.info(`🔊 ${effect === "stealthFail" ? "Stealth fail" : "Perception pass"} sent to ${userName}`);
          d.close();
        });
      },
    }, { width: 260 });
    d.render(true);
  }

  // ── Ideas tab Actions ──────────────────────────────────────

  static async _onGenerateSuggestions(event, target) {
    target.disabled = true;
    target.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating…';
    try {
      const gmInput = this.element.querySelector("#ace-ideas-gm-input")?.value || "";
      const directions = await this.suggestions.generateSuggestions(gmInput);
      this._directions = [...directions];
      this._refreshSuggestionsUI();
    } catch (err) {
      ui.notifications.error(`ACE: ${err.message}`);
    }
    target.disabled = false;
    target.innerHTML = '<i class="fas fa-sync-alt"></i> REFRESH IDEAS';
  }

  static async _onAcceptDirection(event, target) {
    const idx = parseInt(target.dataset.idx ?? target.closest("[data-idx]")?.dataset.idx);
    const direction = this._directions[idx];
    if (!direction) return;

    // Remove accepted direction from the list
    this._directions.splice(idx, 1);
    this._refreshSuggestionsUI();

    // Switch to Narration tab and stream AI-generated read-aloud into the textarea
    await this._generateReadAloudToNarration(direction);
  }

  static _onDismissDirection(event, target) {
    const idx = parseInt(target.dataset.idx ?? target.closest("[data-idx]")?.dataset.idx);
    this._directions.splice(idx, 1);
    this._refreshSuggestionsUI();
  }

  // ── Scene Description (Encounter tab) ─────────────────────

  static async _onSaveSceneDesc(event, target) {
    const scene = canvas?.scene;
    if (!scene) { ui.notifications.warn("ACE: No active scene."); return; }
    const textarea = this.element.querySelector("#ace-scene-desc");
    if (!textarea) return;
    const text = textarea.value.trim();
    if (!text) {
      ui.notifications.warn("ACE: Nothing to save — enter scene notes first.");
      return;
    }
    const current = scene.flags?.["ace-engine"]?.sceneDescription ?? "";
    if (text === current) {
      ui.notifications.info(`ACE: Scene notes unchanged — already saved.`);
      textarea.value = "";
      return;
    }
    target.disabled = true;
    target.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    await scene.setFlag("ace-engine", "sceneDescription", text);
    this.scene?.refresh(); // clear scene context cache
    target.disabled = false;
    target.innerHTML = '<i class="fas fa-check"></i> Saved!';
    textarea.value = "";
    // Update or add the saved-notes indicator
    let savedDiv = this.element.querySelector(".ace-scene-desc-saved");
    const preview = this._escapeHtml(text).slice(0, 200) + (text.length > 200 ? "..." : "");
    const savedHtml = `<i class="fas fa-check-circle" style="color:#4caf50;margin-right:4px;"></i><strong>Saved notes:</strong> ${preview}`;
    if (savedDiv) {
      savedDiv.innerHTML = savedHtml;
    } else {
      savedDiv = document.createElement("div");
      savedDiv.className = "ace-scene-desc-saved";
      savedDiv.innerHTML = savedHtml;
      textarea.parentNode.insertBefore(savedDiv, textarea);
    }
    ui.notifications.info(`ACE: Scene notes saved for "${scene.name}".`);
    setTimeout(() => {
      if (target) target.innerHTML = '<i class="fas fa-save"></i> Save';
    }, 2000);
  }

  static async _onClearSceneDesc(event, target) {
    const textarea = this.element.querySelector("#ace-scene-desc");
    if (textarea) textarea.value = "";
    // Only clears the text area — does NOT delete saved notes from the scene
  }

  static async _onDeleteSceneDesc(event, target) {
    const scene = canvas?.scene;
    if (!scene) return;
    const saved = scene.flags?.["ace-engine"]?.sceneDescription;
    if (!saved) {
      ui.notifications.info("ACE: No saved notes to delete.");
      return;
    }
    await scene.unsetFlag("ace-engine", "sceneDescription");
    this.scene?.refresh();
    // Clear textarea and remove saved indicator
    const textarea = this.element.querySelector("#ace-scene-desc");
    if (textarea) textarea.value = "";
    const savedDiv = this.element.querySelector(".ace-scene-desc-saved");
    if (savedDiv) savedDiv.remove();
    ui.notifications.info(`ACE: Saved scene notes deleted for "${scene.name}".`);
  }

  // ── Encounter tab Actions ──────────────────────────────────

  static async _onGenerateEncounter(event, target) {
    const analyzeBtn = this.element.querySelector('[data-action="rollEncounter"]');
    target.disabled = true;
    if (analyzeBtn) analyzeBtn.disabled = true;
    target.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Weaving...';
    try {
      const promptInput = this.element.querySelector("#ace-encounter-prompt");
      const promptText  = promptInput?.value?.trim() ?? "";
      // Clear the textarea immediately so the GM has a fresh field to type
      // the next prompt into while this one is generating. Same pattern as
      // every other chat input in the engine.
      if (promptInput) promptInput.value = "";
      await this._generateEncounter(promptText);
    } catch (err) {
      ui.notifications.error(`ACE: ${err.message}`);
    }
    target.disabled = false;
    if (analyzeBtn) analyzeBtn.disabled = false;
    target.innerHTML = '<i class="fas fa-dice-d20"></i> Generate';
  }

  static async _onRollEncounter(event, target) {
    const genBtn = this.element.querySelector('[data-action="generateEncounter"]');
    target.disabled = true;
    if (genBtn) genBtn.disabled = true;
    target.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';
    try {
      await this._rollRandomEncounter();
    } catch (err) {
      ui.notifications.error(`ACE: ${err.message}`);
    }
    target.disabled = false;
    if (genBtn) genBtn.disabled = false;
    target.innerHTML = '<i class="fas fa-dice"></i> Random Roll';
  }

  static _onCopyEncounterResult(event, target) {
    if (!this._lastEncounterText) {
      ui.notifications.warn("No encounter result to copy yet.");
      return;
    }
    navigator.clipboard.writeText(this._lastEncounterText).then(() => {
      target.innerHTML = '<i class="fas fa-check"></i>';
      setTimeout(() => { target.innerHTML = '<i class="fas fa-copy"></i>'; }, 1500);
    });
  }

  // ── Subtle Rolls — panel UI action ────────────────────────────

  static async _onSendSubtleRoll(event, target) {
    if (!this.subtleRolls) {
      ui.notifications?.warn("ACE: Subtle Rolls not enabled. Check Module Settings.");
      return;
    }

    const section = this.element.querySelector(".ace-subtle-rolls-section");
    if (!section) return;

    const skill  = section.querySelector("#ace-subtle-skill")?.value;
    const dc     = parseInt(section.querySelector("#ace-subtle-dc")?.value) || 15;
    const flavor = section.querySelector("#ace-subtle-flavor")?.value?.trim() ?? "";

    if (!skill) {
      ui.notifications?.warn("ACE: Select a skill for the subtle roll.");
      return;
    }

    // Gather checked players
    const checkboxes = section.querySelectorAll(".ace-subtle-player-cb:checked");
    if (!checkboxes.length) {
      ui.notifications?.warn("ACE: Select at least one player.");
      return;
    }

    target.disabled = true;
    target.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';

    for (const cb of checkboxes) {
      const userId  = cb.dataset.userId;
      const actorId = cb.dataset.actorId;
      if (!userId || !actorId) continue;

      await this.subtleRolls.requestRoll({
        targetUserId: userId,
        actorId,
        skill,
        dc,
        flavor,
      });
    }

    target.disabled = false;
    target.innerHTML = '<i class="fas fa-eye-slash"></i> Send Blind Roll Request';
    ui.notifications?.info(`ACE: Subtle roll request sent!`);
  }

  /**
   * Render the Subtle Rolls section HTML for the Encounter tab.
   * Includes skill dropdown, DC input, player checkboxes, and send button.
   */
  // ── Core: AI Chat ──────────────────────────────────────────

  async _sendMessage() {
    // Stop mic FIRST so it doesn't keep writing to the input after we read it
    if (this._isListening) this._stopVoice();

    const input = this.element.querySelector("#ace-input");
    const rawText = input?.value?.trim();
    if (!rawText || this._isStreaming) return;

    // Apply profanity filter — player sees and AI receives the filtered version
    const text = filterProfanity(rawText);

    this._chatHistory.push({ role: "user", content: text, timestamp: Date.now() });
    input.value = "";
    this._refreshChatUI();

    const history  = this._chatHistory.slice(0, -1).map(({ role, content }) => ({ role, content }));
    const sceneCtx = this.scene?.gather() ?? "";

    // Document Library FIRST — search PDFs before other stores so we can
    // use discovered entities for cross-store linking (NPC/reputation/fame)
    const docCtx   = await this._buildDocumentContext(text);

    // Cross-store linking: extract entities found in document results
    // (NPC names, locations) and feed them into NPC/reputation lookups
    const docEntities = this._documentEngine?.getLastSearchEntities?.() ?? {};

    // Standard NPC context (scene NPCs + journals + reputation + fame)
    const npcMem   = await this._buildNpcContext();

    // Supplemental NPC/reputation context for entities found in PDFs
    // that aren't on the current scene (e.g., Rahadin mentioned in a
    // room description but not on the current map)
    const crossStoreCtx = this._buildCrossStoreContext(docEntities);

    // World Bible: search for relevant lore entries matching the user's query
    const bibleCtx = this._buildWorldBibleContext(text, sceneCtx);

    // Cross-campaign vault search — detect if user is asking about past campaigns
    const vaultCtx = await this._buildVaultContext(text);

    let fullMem = npcMem;
    if (crossStoreCtx) fullMem += `\n\n${crossStoreCtx}`;
    if (bibleCtx)  fullMem += `\n\n${bibleCtx}`;
    if (docCtx)    fullMem += `\n\n${docCtx}`;
    if (vaultCtx)  fullMem += `\n\n${vaultCtx}`;

    // Profanity flavor prompt — teaches AI to use fantasy swearing
    try {
      const profanityEnabled = game.settings.get(MODULE_ID, "profanityFilter") ?? true;
      if (profanityEnabled) {
        const bibleData = this._worldBible?.getData?.() ?? null;
        const regionName = this.scene?.currentScene?.name ?? "";
        fullMem += `\n\n${buildProfanityPrompt(bibleData, regionName)}`;
      }
    } catch { /* setting not registered yet */ }

    // Vision images — if enabled, find relevant map/image references
    let visionImages = [];
    try {
      const enableVision = game.settings.get(MODULE_ID, "enableVisionImages") ?? false;
      if (enableVision && this._documentEngine) {
        const refs = this._documentEngine.getRelevantImages(text, sceneCtx, 2);
        if (refs.length) {
          const { loadImageAsBase64 } = await import("./document-engine.mjs");
          visionImages = await Promise.all(
            refs.map(async (r) => {
              try { return await loadImageAsBase64(r.path); }
              catch (err) { console.debug("ace-engine | Panel vision image load failed:", err); return null; }
            })
          );
          visionImages = visionImages.filter(Boolean);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Vision image loading failed:`, err);
    }

    const aiMsgIndex = this._chatHistory.length;
    this._chatHistory.push({ role: "assistant", content: "", timestamp: Date.now() });
    this._refreshChatUI();
    this._isStreaming = true;
    this._setInputState(false);

    try {
      // ── AI call ──
      try {
        await this.ai.chatStream(text, sceneCtx, fullMem, history, (chunk) => {
          this._chatHistory[aiMsgIndex].content += chunk;
          this._updateStreamingMessage(aiMsgIndex);
        }, visionImages);
      } catch (err) {
        console.error(`${MODULE_ID} | Chat error:`, err);
        const errMsg = err.message || "Unknown error";
        // Provide actionable guidance based on error type
        if (errMsg.includes("401") || errMsg.includes("Invalid API") || errMsg.includes("Unauthorized")) {
          this._chatHistory[aiMsgIndex].content =
            `**Invalid API Key**\n\nYour API key was rejected. Please check it in **Foundry Settings → Module Settings → ACE → API Key**.\n\n` +
            `If you don't have a key yet, visit your provider's website to create one (it's free for OpenAI).`;
        } else if (errMsg.includes("CORS") || errMsg.includes("Failed to fetch") || errMsg.includes("Cannot reach")) {
          this._chatHistory[aiMsgIndex].content =
            `**Connection Failed**\n\nCan't reach the AI server. Check that:\n` +
            `- Your internet connection is working\n` +
            `- The API URL in **Module Settings → ACE** is correct\n` +
            `- For local AI (Ollama): make sure it's running and set \`OLLAMA_ORIGINS=*\``;
          // For Ollama specifically, pop the friendly action dialog (once per session)
          // so the user can install / switch / test connection without digging through settings.
          try {
            const provider = this.ai?.config?.provider || "";
            if (provider === "ollama") {
              const { showOllamaDownDialog } = await import("./connection-dialog.mjs");
              showOllamaDownDialog({ message: errMsg, url: this.ai?.config?.apiUrl });
            }
          } catch (_) { /* dialog import failed — markdown message above is sufficient */ }
        } else if (errMsg.includes("429") || errMsg.includes("Rate limit")) {
          this._chatHistory[aiMsgIndex].content =
            `**Rate Limited**\n\nThe AI provider says you're sending too many requests. Wait a moment and try again.\n\n` +
            `Free tiers have lower limits — consider upgrading or using a local provider like Ollama.`;
        } else if (errMsg.includes("model") || errMsg.includes("404")) {
          this._chatHistory[aiMsgIndex].content =
            `**Model Not Found**\n\nThe model "${this.ai?.config?.modelName ?? "unknown"}" wasn't found by your provider.\n\n` +
            `Go to **Module Settings → ACE → AI Model** and pick a valid model from the dropdown.`;
        } else {
          this._chatHistory[aiMsgIndex].content = `**Error:** ${errMsg}\n\nCheck **Module Settings → ACE** to verify your AI provider configuration.`;
        }
      }

      // ── Disposition tag parsing ──────────────────────────────
      // Check if AI response includes a [DISPOSITION:...] tag (reputation system)
      try {
        const dispEnabled = game.settings.get(MODULE_ID, "enableDispositionTags") ?? true;
        if (dispEnabled && this.reputation && this._chatHistory[aiMsgIndex]) {
          const fullResponse = this._chatHistory[aiMsgIndex].content;
          const dispTag = this.reputation.parseDispositionTag?.(fullResponse) ?? null;
          if (dispTag && dispTag.value !== null) {
            // Strip the tag from the displayed message
            this._chatHistory[aiMsgIndex].content = fullResponse.replace(dispTag.raw, "").trim();

            // Find the NPC to apply the change to:
            // Priority: current combatant → selected NPC → controlled token
            let npcName = game.combat?.combatant?.name;
            if (!npcName || game.combat?.combatant?.actor?.hasPlayerOwner) {
              // Try selected NPC tokens
              for (const tokenId of this._selectedTokens) {
                const tok = canvas?.tokens?.placeables?.find(t =>
                  t.id === tokenId || t.actor?.id === tokenId
                );
                if (tok && !tok.actor?.hasPlayerOwner) {
                  npcName = tok.name;
                  break;
                }
              }
            }
            // Fallback: controlled NPC token
            if (!npcName) {
              const ctrl = canvas?.tokens?.controlled?.find(t => !t.actor?.hasPlayerOwner);
              if (ctrl) npcName = ctrl.name;
            }

            if (npcName) {
              await this.reputation.applyDispositionChange(npcName, dispTag.value);
            }
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Disposition tag parsing failed:`, err);
      }

      // ── Auto-Learn to World Bible ──
      try {
        const aiResponse = this._chatHistory[aiMsgIndex]?.content ?? "";
        if (aiResponse) this._maybeLearnFromResponse(aiResponse);
      } catch (err) {
        console.warn(`${MODULE_ID} | Auto-learn trigger failed:`, err);
      }
    } finally {
      // ALWAYS reset streaming state — even if an unexpected error occurs above.
      // Without this, a thrown error permanently locks the input field.
      this._isStreaming = false;
      this._setInputState(true);
      this._refreshChatUI();
      this._scrollChatToBottom();
    }
    // Note: AI chat responses are NOT read aloud — TTS is Narration tab only.
  }

  // ── Core: Narration Send ───────────────────────────────────

  /**
   * Sends the narration textarea content to ALL players via Foundry chat
   * AND speaks it aloud via ElevenLabs / browser TTS.
   * No AI response — this is pure GM-to-players broadcast.
   */
  async _narrateSendMessage() {
    // Read the textarea BEFORE stopping mic — user edits must be preserved
    const input = this.element.querySelector("#ace-narration-input");
    const text  = input?.value?.trim();

    // Now stop mic (won't overwrite since we already captured the text)
    if (this._narrationListening) this._stopNarrationVoice();

    if (!text || this._isNarrationStreaming) return;

    input.value = "";
    await this._narrateText(text);
  }

  // ── Session End ────────────────────────────────────────────

  /**
   * Called by the "End Session" button.
   * Generates an AI summary of the session and saves it to memory + journal.
   */
  async _runEndSession() {
    if (!this.lkMemory || !this.ai) {
      ui.notifications?.warn("ACE: AI provider or memory not available — check your AI settings.");
      console.warn(`${MODULE_ID} | _runEndSession: ai=${!!this.ai}, lkMemory=${!!this.lkMemory}`);
      return;
    }
    if (this._isGeneratingSummary) return;

    this._isGeneratingSummary = true;
    this._updateEndSessionButton();  // show spinner on End Session button

    // Post a system note in the chat tab so the GM knows what's happening
    this._pushSystemNote("📖 **Generating session summary…** This will be saved to the ACE journal.");

    try {
      const partyNames = (game.actors?.filter((a) => a.hasPlayerOwner && a.type === "character") ?? [])
        .map((a) => a.name);

      let summary = "";
      await this.lkMemory.generateSessionSummary(this.ai, this.scene, (chunk) => {
        summary += chunk;
      });

      if (summary) {
        const sessionNum = this.lkMemory.getNextSessionNum();
        await this.lkMemory.saveSessionSummary({
          sessionNum,
          date:       new Date().toISOString().slice(0, 10),
          sceneName:  canvas?.scene?.name ?? "",
          summary,
          partyNames,
        });

        this._pushSystemNote(
          `📖 **Session ${sessionNum} Summary saved to journal** — check the "📖 ACE" folder.\n\n${summary.slice(0, 300)}${summary.length > 300 ? "…" : ""}`,
        );
        ui.notifications?.info("ACE: Session summary saved to journal.");

        // Auto-backup all categories on session end
        try {
          await this.lkMemory.backup();
          console.log(`${MODULE_ID} | Session end: all memory categories backed up.`);
        } catch (bkErr) {
          console.warn(`${MODULE_ID} | Session end backup failed:`, bkErr);
        }

        // Auto-snapshot to vault on session end
        if (this._vaultEngine) {
          try {
            await this._vaultEngine.createSnapshot();
            console.log(`${MODULE_ID} | Session end: vault snapshot created.`);
          } catch (vErr) {
            console.warn(`${MODULE_ID} | Session end vault snapshot failed:`, vErr);
          }
        }
      } else {
        // Empty summary — provider returned nothing useful (could be a stream
        // that closed cleanly with no content, or a malformed response that
        // generateSessionSummary swallowed).
        this._pushSystemNote(
          `📖 **Session summary FAILED** — provider returned empty content. Click **Save Session Recap** again to retry, or check your AI provider settings.`
        );
        ui.notifications?.error("ACE: Session summary failed — provider returned empty.");
      }
    } catch (err) {
      console.error(`${MODULE_ID} | End session error:`, err);
      this._pushSystemNote(
        `📖 **Session summary FAILED** — ${err?.message ?? err}. Click **Save Session Recap** again to retry.`
      );
      ui.notifications?.error("ACE: Failed to generate session summary — see console.");
    } finally {
      // ── v1.6.4 fix ───────────────────────────────────────────────────
      // Runs even on hang, timeout, or thrown error. Without this, a stalled
      // provider call would leave the button spinning forever (production
      // repro: GM clicked Save → button spun for 10+ minutes → AI provider
      // had silently dropped the stream). The 90s timeout in
      // memory-manager.generateSessionSummary now throws, which lands here.
      this._isGeneratingSummary = false;
      this._updateEndSessionButton();
    }
  }

  /**
   * Called by ace-engine.mjs when a combat ends (deleteCombat hook).
   * Notifies the GM with a prompt to end the session — does NOT auto-generate
   * (to avoid creating a summary for every fight in a multi-combat session).
   *
   * @param {Combat} combat
   * @param {string[]} participants
   */
  onCombatEnded(combat, participants) {
    const count = participants.length;
    this._pushSystemNote(
      `⚔️ **Combat ended** — ${count} participant${count !== 1 ? "s" : ""}: ${participants.slice(0, 6).join(", ")}${count > 6 ? "…" : ""}.\n\n` +
      `When the session is over, click **Save Session Recap** (available on every tab) to save a journal summary.`
    );
  }

  /**
   * Save the quick-note input text to persistent memory.
   */
  _saveQuickNote() {
    const input = this.element?.querySelector("#ace-note-input");
    const text  = input?.value?.trim();
    if (!text) return;

    this.lkMemory?.logNote(text);
    if (input) input.value = "";

    ui.notifications?.info(`ACE: Note saved — "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`);
    this._pushSystemNote(`📝 **Note saved to memory:** ${text}`);
  }

  /**
   * Update the End Session button state without a full re-render.
   */
  /** Render the Save Session Recap button (used on every tab). */
  _renderSessionRecapButton() {
    return `<button class="ace-divider-action ace-session-recap-btn" data-action="endSession"
                    ${this._isGeneratingSummary ? "disabled" : ""}
                    title="Generate a session summary and save it to the ACE journal">
              <i class="fas ${this._isGeneratingSummary ? "fa-spinner fa-spin" : "fa-book-open"}"></i>
              ${this._isGeneratingSummary ? "Saving…" : "Save Session Recap"}
            </button>`;
  }

  _updateEndSessionButton() {
    // Update ALL recap buttons across every tab
    this.element?.querySelectorAll("[data-action='endSession']").forEach(btn => {
      btn.disabled = this._isGeneratingSummary;
      btn.innerHTML = this._isGeneratingSummary
        ? '<i class="fas fa-spinner fa-spin"></i> Saving…'
        : '<i class="fas fa-book-open"></i> Save Session Recap';
    });
  }

  // ── Story Direction → Narration Textarea ──────────────────

  /**
   * When GM accepts a story direction, AI generates a read-aloud passage
   * and streams it into the Narration tab's textarea for review/edit
   * before the GM decides to send it to players.
   */
  async _generateReadAloudToNarration(direction) {
    const sceneCtx = this.scene?.gather() ?? "";
    const npcMem   = await this._buildNpcContext();
    const docCtx   = await this._buildDocumentContext(direction.title);
    const bibleCtx = this._buildWorldBibleContext(direction.title, sceneCtx);
    let fullMem = npcMem;
    if (bibleCtx) fullMem += `\n\n${bibleCtx}`;
    if (docCtx)   fullMem += `\n\n${docCtx}`;

    const prompt = `The GM has chosen this story direction: "${direction.title}". ${direction.description} ${direction.consequence}

Write a short read-aloud passage (2-4 sentences) the GM speaks to players RIGHT NOW to transition into this moment. Requirements:
- Second person, present tense ("You hear...", "As you step forward...", "A shadow crosses...")
- NEVER use first person ("I", "my", "me") — you are the narrator, not a character
- Describe NPC actions in third person ("Her eyes narrow", "The figure steps forward") — never as "I" or "my"
- No asterisk emotes (*does something*), no parenthetical actions, no stage directions
- Vivid sensory detail — one sound, one sight, one feeling
- End with a hook that draws players toward this direction
- No game mechanics, dice, or stats
- Keep it concise — this is spoken aloud at the table and read by text-to-speech
- VOICE TAG: If the passage contains dialogue spoken by a female character, start your response with [voice:female]. If spoken by a male character or mixed/narrator, start with [voice:male]. This controls the TTS voice used to read it aloud.`;

    // Switch to Narration tab
    this._switchToTab("narration");

    const textarea = this.element.querySelector("#ace-narration-input");
    if (!textarea) return;

    this._isNarrationStreaming = true;
    textarea.disabled          = true;
    textarea.value             = "";
    const origPlaceholder      = textarea.placeholder;
    textarea.placeholder       = "✨ Weaving a passage for your players…";

    let result = "";
    try {
      await this.ai.chatStream(prompt, sceneCtx, fullMem, [], (chunk) => {
        result += chunk;
        // Show clean text in textarea (strip markdown for readability)
        textarea.value = result.replace(/\*\*/g, "").replace(/\*/g, "").replace(/^#+\s/gm, "");
      });
    } catch (err) {
      textarea.value = "(Could not generate — type your own narration)";
    } finally {
      // Always reset — prevents the "To Players" button from being stuck disabled
      this._isNarrationStreaming = false;
      textarea.disabled          = false;
      textarea.placeholder       = origPlaceholder;
    }
    textarea.focus();
  }

  // ── NPC Tactics (auto + manual) ───────────────────────────

  async suggestNpcTactic(combat, combatant) {
    if (!combatant) return;
    const sceneCtx = this.scene?.gather() ?? "";
    const npcMem   = await this._buildNpcContext();
    const npcName  = combatant.name;
    const docCtx   = await this._buildDocumentContext(npcName);
    const bibleCtx = this._buildWorldBibleContext(npcName, sceneCtx);
    let fullTacticMem = npcMem;
    if (bibleCtx) fullTacticMem += `\n\n${bibleCtx}`;
    if (docCtx)   fullTacticMem += `\n\n${docCtx}`;

    // ── Language context ────────────────────────────────────
    const langNote = this._buildLanguageNote(combatant.actor);

    const prompt = `Combat is active and it is now ${npcName}'s turn (hostile NPC/enemy).
${langNote}
In 1-2 sentences ONLY, suggest the most tactically interesting action ${npcName} should take THIS round. Be specific: name which PC to target, which ability or attack to use, and briefly why. Reference actual HP values and conditions from the scene. Be direct — this is a quick GM whisper, not an explanation.

If ${npcName} does not speak Common, reflect that in any roleplay flavoring — they may shout, snarl, or communicate in their own tongue rather than speaking to the party directly.

Style examples:
- "The Specter should use Ethereal Touch on Chuud this round — his low Wisdom makes the save likely to fail and the strength drain shifts the fight."
- "The Goblin Leader just fell; have this surviving goblin roll Wisdom DC 12 — on a fail it panics and Dashes for the nearest exit."
- "The Kobold speaks only Draconic — have it hiss a command to its allies and Disengage toward the exit rather than fighting the now-flanked position."`;

    this._switchToTab("chat");

    const msgIndex = this._chatHistory.length;
    this._chatHistory.push({
      role:      "assistant",
      content:   `⚔️ **${npcName}'s Turn** — `,
      timestamp: Date.now(),
      isTactic:  true,
    });
    this._refreshChatUI();
    this._scrollChatToBottom();

    try {
      await this.ai.chatStream(prompt, sceneCtx, fullTacticMem, [], (chunk) => {
        this._chatHistory[msgIndex].content += chunk;
        this._updateStreamingMessage(msgIndex);
      });
    } catch (err) {
      this._chatHistory[msgIndex].content += `*(Error: ${err.message})*`;
      this._refreshChatUI();
    }

    this._scrollChatToBottom();
  }

  // ── Encounter Generator ────────────────────────────────────

  async _generateEncounter(userPrompt) {
    const sceneCtx  = this.scene?.gather() ?? "";
    const npcMem    = await this._buildNpcContext();
    const sceneName = canvas?.scene?.name ?? "";
    const docCtx    = await this._buildDocumentContext(userPrompt || sceneName);
    const bibleCtx  = this._buildWorldBibleContext(userPrompt || sceneName, sceneCtx);
    let encMem = npcMem;
    if (bibleCtx) encMem += `\n\n${bibleCtx}`;
    if (docCtx)   encMem += `\n\n${docCtx}`;
    const locTag    = sceneName ? ` in **${sceneName}**` : " in the current location";

    const basePrompt = userPrompt
      ? `Design a complete, ready-to-run encounter based on: **${userPrompt}**\n` +
        `This encounter takes place${locTag}. Keep the setting, architecture, and atmosphere consistent with that specific location — do not substitute a different environment.\n\n`
      : `Design a complete, ready-to-run encounter that takes place RIGHT NOW${locTag}.\n` +
        `The encounter MUST be set inside **${sceneName || "the current scene"}** — use its specific features, architecture, atmosphere, and inhabitants. Do NOT set it in a generic forest or wilderness unless that is literally where the party is.\n\n`;

    const prompt = `${basePrompt}Use the party composition, scene context, and current game system. Structure your response exactly as follows:

## [Encounter Title]
*One-line hook that sets the tone*

### Setup
Brief GM-facing summary — what's happening and how it starts.

### Enemies
List ONLY real creatures from the D&D 5e Monster Manual, SRD, or published supplements.
Format each enemy as: **Quantity × Creature Name** (e.g., "2 × Shadow", "1 × Wraith", "1 × Young Red Dragon")
Do NOT invent creatures or make up stat blocks — use exact official creature names so they can be looked up in compendiums.
One line per creature type. Keep it short.

### Terrain & Positioning
Describe the battlefield, cover, hazards, and where enemies begin.

### Tactics
How do the enemies open? How do they react when hurt? When do they flee?

### Read-Aloud Text
> *The boxed text the GM reads aloud to players when the encounter begins. Second person ("You see..."), NEVER first person ("I", "my"). Describe NPC actions in third person ("The creature lunges"). No asterisk emotes. This is read by text-to-speech.*

### Treasure & Rewards
Appropriate loot, XP, and story rewards.

### Scaling
- **Too easy?** Quick tweak to make it harder
- **Too hard?** Quick tweak to soften it`;

    const container = this.element.querySelector("#ace-encounter");
    if (!container) return;

    container.innerHTML = `<p class="ace-thinking"><i class="fas fa-spinner fa-spin"></i> Weaving encounter from the aether...</p>`;

    try {
      let result = "";
      await this.ai.chatStream(prompt, sceneCtx, encMem, [], (chunk) => {
        result += chunk;
        container.innerHTML = `<div class="ace-encounter-analysis">${this._addReadAloudCopy(this._renderMarkdown(result))}</div>`;
      });
      this._lastEncounterText = result;

      // ── Post-process: parse → search compendiums → render interactive ──
      container.innerHTML = `<p class="ace-thinking"><i class="fas fa-spinner fa-spin"></i> Searching compendiums for creatures...</p>`;
      const parsed = this._parseEncounterMarkdown(result);
      if (parsed.creatures.length) {
        await this._resolveEncounterCreatures(parsed);
        this._encounterData = parsed;
        container.innerHTML = this._renderInteractiveEncounter(parsed);
        this._wireEncounterDragDrop();
      } else {
        // Fallback: no creatures parsed — show original markdown
        container.innerHTML = `<div class="ace-encounter-analysis">${this._addReadAloudCopy(this._renderMarkdown(result))}</div>`;
      }
      this._lastEncounterHtml = container.innerHTML;
      container.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
      container.innerHTML = `<p class="ace-error"><i class="fas fa-exclamation-triangle"></i> ${err.message}</p>`;
    }
  }

  async _rollRandomEncounter() {
    const container = this.element.querySelector("#ace-encounter");
    if (!container) return;

    const roll      = await new Roll("1d20").evaluate();
    const result    = roll.total;
    const terrain   = this._detectTerrain();
    const sceneName = canvas?.scene?.name ?? "";
    const locTag    = sceneName ? ` in **${sceneName}**` : "";

    console.log(`${MODULE_ID} | Random encounter roll: ${result} (terrain: ${terrain}, scene: ${sceneName})`);

    if (result <= 4) {
      this._lastEncounterText = `Rolled ${result} — All Clear. ${sceneName || "The area"} is quiet.`;
      container.innerHTML = `
        <div class="ace-roll-result ace-roll-clear">
          <div class="ace-roll-die">🎲 ${result}</div>
          <strong>All Clear</strong>
          <p>${sceneName || "The " + terrain} is quiet. No encounter.</p>
        </div>`;
      this._lastEncounterHtml = container.innerHTML;
      container.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else if (result <= 8) {
      container.innerHTML = `
        <div class="ace-roll-result ace-roll-signs">
          <div class="ace-roll-die">🎲 ${result}</div>
          <strong>Signs of Danger</strong>
          <p>Something feels wrong...</p>
        </div>`;
      await this._generateEncounter(
        `One atmospheric omen${locTag} (a ${terrain} environment) — DO NOT create a full encounter. Write 2-3 sentences the GM reads aloud: a sound, smell, track, or shadow that fits this specific place. Vivid, second-person, present tense.`
      );
    } else {
      const isDeadly  = result >= 19;
      const severity  = isDeadly ? "dangerous and serious" : "challenging but manageable";
      const cssClass  = isDeadly ? "ace-roll-deadly" : "ace-roll-danger";
      const labelText = isDeadly ? "Deadly Encounter!" : "Dangerous Encounter";
      container.innerHTML = `
        <div class="ace-roll-result ${cssClass}">
          <div class="ace-roll-die">🎲 ${result}</div>
          <strong>${labelText}</strong>
          <p>Generating...</p>
        </div>`;
      await this._generateEncounter(
        `A ${severity} random encounter${locTag}. This is a ${terrain} environment — theme the encounter specifically to **${sceneName || terrain}** and do not substitute a different setting.`
      );
    }
  }

  _detectTerrain() {
    const scene = canvas?.scene;
    if (!scene) return "wilderness";
    const text = (scene.name + " " + (scene.description ?? "")).toLowerCase();

    if (/forest|wood|grove|jungle|fey|sylvan/.test(text))                              return "forest";
    if (/dungeon|cave|cavern|crypt|tomb|underground|mine|vault|cellar/.test(text))     return "dungeon";
    if (/castle|keep|fortress|stronghold|tower|rampart|manor|hall|hold|estate|palace|abbey|monastery|chapel|cathedral|citadel|barracks/.test(text)) return "castle";
    if (/city|town|village|market|tavern|inn|street|alley|district|quarter/.test(text)) return "city";
    if (/road|path|highway|trail|pass|bridge|ford/.test(text))                        return "road";
    if (/sea|ocean|coast|shore|ship|island|harbor|port|dock/.test(text))              return "sea";
    if (/swamp|marsh|bog|fen|mire/.test(text))                                        return "swamp";
    if (/mountain|hill|cliff|peak|highland|glacier/.test(text))                       return "mountain";
    if (/desert|sand|dune|wasteland|arid/.test(text))                                 return "desert";
    if (/plains|field|grassland|meadow|steppe/.test(text))                            return "plains";
    if (/tundra|arctic|frozen|snow|ice/.test(text))                                   return "tundra";
    // If scene has a proper name and no terrain keyword, default to interior/dungeon
    // rather than wilderness — most named locations are indoors
    if (scene.name && scene.name.length > 2) return "interior";
    return "wilderness";
  }

  // ── Narration-tab Voice (STT → fills narration textarea) ───

  _startNarrationVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      ui.notifications.warn("Voice input not supported in this browser.");
      return;
    }

    this._narrationRecognition = new SR();
    this._narrationRecognition.continuous     = true;    // keep recording until user clicks stop/send
    this._narrationRecognition.interimResults = true;
    this._narrationRecognition.lang           = navigator.language || "en-US";

    const input   = this.element?.querySelector("#ace-narration-input");
    const micBtn  = this.element?.querySelector('[data-action="narrationVoice"]');
    this._narOrigPlaceholder = input?.placeholder ?? "";

    // ── Edit-Aware Committed Baseline (same pattern as chat voice) ──
    this._narVoiceBaseline    = input?.value ?? "";   // preserve any existing text
    this._narVoiceLastInterim = "";
    this._narFinalTranscript  = this._narVoiceBaseline;

    this._narrationListening = true;

    if (micBtn) {
      micBtn.innerHTML = '<i class="fas fa-circle ace-mic-pulse"></i>';
      micBtn.classList.add("ace-btn-mic-active");
      micBtn.title = "Recording — click mic to stop, or edit & send";
    }
    if (input) {
      input.placeholder = "🎙 Recording… click mic or Send to finish";

      // Detect manual edits while voice is active — re-snapshot baseline
      this._narVoiceInputHandler = () => {
        if (!this._narrationListening) return;
        const el = this.element?.querySelector("#ace-narration-input");
        if (!el) return;
        let val = el.value;
        if (this._narVoiceLastInterim && val.endsWith(this._narVoiceLastInterim)) {
          val = val.slice(0, -this._narVoiceLastInterim.length);
        }
        this._narVoiceBaseline    = val;
        this._narFinalTranscript  = val;
        this._narVoiceLastInterim = "";
      };
      input.addEventListener("input", this._narVoiceInputHandler);
    }

    this._narrationRecognition.onresult = (event) => {
      let newFinal = "";
      let interim  = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const segment = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          newFinal += segment;
        } else {
          interim += segment;
        }
      }

      if (newFinal) this._narVoiceBaseline += newFinal;
      this._narVoiceLastInterim = interim;
      this._narFinalTranscript  = this._narVoiceBaseline;

      const freshInput = this.element?.querySelector("#ace-narration-input");
      if (freshInput) freshInput.value = this._narVoiceBaseline + interim;
    };

    this._narrationRecognition.onerror = (event) => {
      console.warn(`${MODULE_ID} | Narration voice error:`, event.error);
      if (event.error !== "no-speech" && event.error !== "aborted") {
        this._stopNarrationVoice();
        ui.notifications.warn(`Narration voice: ${event.error}. Check microphone permissions.`);
      }
    };

    this._narrationRecognition.onend = () => {
      if (this._narrationListening) {
        try {
          this._narrationRecognition.start();
        } catch (_) {
          this._stopNarrationVoice();
        }
      }
    };

    try {
      this._narrationRecognition.start();
    } catch (e) {
      console.error(`${MODULE_ID} | Narration voice start failed:`, e);
      this._stopNarrationVoice();
    }
  }

  _stopNarrationVoice() {
    this._narrationListening = false;

    // Kill recognition FIRST — null handlers to prevent any late onresult
    if (this._narrationRecognition) {
      this._narrationRecognition.onresult = null;
      this._narrationRecognition.onend    = null;
      this._narrationRecognition.onerror  = null;
      try { this._narrationRecognition.stop(); } catch (_) { /* already stopped */ }
    }
    this._narrationRecognition = null;

    // Remove manual-edit listener to prevent leaks
    const input = this.element?.querySelector("#ace-narration-input");
    if (input && this._narVoiceInputHandler) {
      input.removeEventListener("input", this._narVoiceInputHandler);
    }
    this._narVoiceInputHandler = null;

    // Update mic button visual
    const micBtn = this.element?.querySelector('[data-action="narrationVoice"]');
    if (micBtn) {
      micBtn.innerHTML = '<i class="fas fa-microphone"></i>';
      micBtn.classList.remove("ace-btn-mic-active");
      micBtn.title = "Speak narration — fills textarea for review before sending";
    }

    // Restore placeholder
    if (input && this._narOrigPlaceholder) {
      input.placeholder = this._narOrigPlaceholder;
    }

    // NEVER overwrite the textarea — whatever is in there is the user's text.
    this._narVoiceBaseline    = "";
    this._narVoiceLastInterim = "";
    this._narFinalTranscript  = "";
    this._narOrigPlaceholder  = "";
  }

  /**
   * Basic punctuation/capitalization cleanup for speech-to-text output.
   * The browser SpeechRecognition API gives raw words with no punctuation.
   * This adds: question marks for detected questions, sentence-initial caps,
   * trailing period, and trims whitespace.
   */
  static _QUESTION_WORDS = /^(who|what|where|when|why|how|do|does|did|is|are|was|were|can|could|would|should|will|shall|have|has|had|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|won't|wouldn't|couldn't|shouldn't|hasn't|haven't|hadn't|which|whose|whom)\b/i;

  _cleanupTranscript(raw) {
    let text = raw.trim();
    if (!text) return text;

    // Capitalize first letter
    text = text.charAt(0).toUpperCase() + text.slice(1);

    // Clean up extra spaces (speech API sometimes doubles them)
    text = text.replace(/\s{2,}/g, " ");

    // Add terminal punctuation if missing
    if (!/[.!?…]$/.test(text)) {
      text += AcePanel._QUESTION_WORDS.test(raw.trim()) ? "?" : ".";
    }

    return text;
  }

  // ── Chat-tab Voice: Quick-Send Mic ─────────────────────────

  _startVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      ui.notifications.warn("Voice input not supported in this browser.");
      return;
    }

    this._recognition = new SR();
    this._recognition.continuous     = true;    // keep recording until user clicks stop/send
    this._recognition.interimResults = true;
    this._recognition.lang           = navigator.language || "en-US";

    const input   = this.element?.querySelector("#ace-input");
    const micBtn  = this.element?.querySelector('[data-action="voiceInput"]');
    this._chatVoiceOrigPh = input?.placeholder ?? "";

    // ── Edit-Aware Committed Baseline ─────────────────────────
    // _chatVoiceBaseline: the "truth" — everything the user has approved
    //   (finalized speech + any manual edits they've made).
    // _chatVoiceLastInterim: the ghost text we appended from interim results.
    // When the user manually edits the textarea, we re-snapshot baseline
    // from whatever's in there (minus interim ghost), so their edit sticks.
    this._chatVoiceBaseline    = input?.value ?? "";
    this._chatVoiceLastInterim = "";
    this._chatVoiceCommitted   = "";

    this._isListening = true;
    if (micBtn) {
      micBtn.innerHTML = '<i class="fas fa-circle ace-mic-pulse"></i>';
      micBtn.classList.add("ace-btn-mic-active");
      micBtn.title = "Listening — click to stop, then press ASK AI";
    }
    if (input) {
      input.placeholder = "🎙 Listening… click mic to stop, then ASK AI";
      input.disabled    = false;

      // Detect manual edits (keyboard typing, paste, delete) while voice is active.
      // When the user fixes a word, we re-snapshot the textarea as the new baseline.
      this._chatVoiceInputHandler = () => {
        if (!this._isListening) return;
        const el = this.element?.querySelector("#ace-input");
        if (!el) return;
        let val = el.value;
        // Strip our interim ghost from the end (it may still be there)
        if (this._chatVoiceLastInterim && val.endsWith(this._chatVoiceLastInterim)) {
          val = val.slice(0, -this._chatVoiceLastInterim.length);
        }
        // Whatever remains IS the user's approved text
        this._chatVoiceBaseline    = val;
        this._chatVoiceLastInterim = "";
      };
      input.addEventListener("input", this._chatVoiceInputHandler);
    }

    this._recognition.onresult = (event) => {
      // Only process NEW results (from event.resultIndex onward).
      // This way we never re-scan old finalized segments.
      let newFinal = "";
      let interim  = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          newFinal += text;
        } else {
          interim += text;
        }
      }

      // Append new finalized speech to the baseline
      if (newFinal) this._chatVoiceBaseline += newFinal;
      this._chatVoiceLastInterim = interim;
      this._chatVoiceCommitted   = this._chatVoiceBaseline;

      // Write baseline + interim ghost to textarea
      const freshInput = this.element?.querySelector("#ace-input");
      if (freshInput) {
        freshInput.value = (this._chatVoiceBaseline + interim).trim();
      }
    };

    this._recognition.onerror = (event) => {
      console.warn(`${MODULE_ID} | Voice error:`, event.error);
      if (event.error !== "no-speech" && event.error !== "aborted") {
        this._stopVoice();
        ui.notifications.warn(`ACE voice: ${event.error}. Check microphone permissions.`);
      }
    };

    this._recognition.onend = () => {
      // Continuous mode can fire onend unexpectedly (browser quirk) — restart if still listening.
      // On restart, resultIndex resets but our baseline persists, so edits are safe.
      if (this._isListening) {
        try { this._recognition?.start(); } catch (_) { this._stopVoice(); }
      }
    };

    try {
      this._recognition.start();
      // Move focus to the textarea so Enter sends the message
      // instead of re-triggering the mic button
      if (input) requestAnimationFrame(() => input.focus());
    } catch (e) {
      console.error(`${MODULE_ID} | Voice start failed:`, e);
      this._stopVoice();
    }
  }

  _stopVoice() {
    this._isListening = false;
    // Null out handlers BEFORE .stop() to prevent late async onresult from
    // repopulating the input after _sendMessage() has already cleared it.
    if (this._recognition) {
      this._recognition.onresult = null;
      this._recognition.onerror  = null;
      this._recognition.onend    = null;
    }
    try { this._recognition?.stop(); } catch (_) { /* already stopped */ }
    this._recognition = null;

    // Remove the manual-edit listener to prevent leaks
    const input  = this.element?.querySelector("#ace-input");
    if (input && this._chatVoiceInputHandler) {
      input.removeEventListener("input", this._chatVoiceInputHandler);
    }
    this._chatVoiceInputHandler = null;

    const micBtn = this.element?.querySelector('[data-action="voiceInput"]');
    if (micBtn) {
      micBtn.innerHTML = '<i class="fas fa-microphone"></i>';
      micBtn.classList.remove("ace-btn-mic-active");
      micBtn.title = "Voice input — click to speak";
    }
    // Apply cleanup — use whatever is currently in the input (includes interim text)
    // rather than only the committed portion, so nothing the user saw gets lost.
    if (input) {
      const raw = input.value?.trim() || this._chatVoiceCommitted || "";
      if (raw) input.value = this._cleanupTranscript(raw);
    }
    if (input) {
      input.placeholder = this._chatVoiceOrigPh ?? "Ask ACE anything...";
    }
    this._chatVoiceBaseline    = "";
    this._chatVoiceLastInterim = "";
  }

  // ── TTS ────────────────────────────────────────────────────

  /**
   * Check if an ElevenLabs API key is available from any source.
   * Returns { key, source } or { key: "", source: "none" }.
   */
  _getElevenLabsKey() {
    // 1. config.local.json (baked-in credentials)
    const localKey = localCredentials?.elevenLabsApiKey || "";
    if (localKey) return { key: localKey, source: "config.local.json" };

    // 2. Foundry Module Settings
    try {
      const settingsKey = (game.settings.get(MODULE_ID, "elevenLabsApiKey") || "").trim();
      if (settingsKey) return { key: settingsKey, source: "Module Settings" };
    } catch (e) {
      console.warn(`${MODULE_ID} | TTS: could not read ElevenLabs key from settings —`, e.message);
    }

    return { key: "", source: "none" };
  }

  /**
   * Render TTS status badge for the narration tab.
   * Shows which TTS engine is active so the user knows at a glance.
   */
  _renderTtsStatus() {
    const { key, source } = this._getElevenLabsKey();
    if (key) {
      // Subtle green pill when ElevenLabs is active
      return `<div class="ace-tts-status ace-tts-eleven">
        <i class="fas fa-broadcast-tower"></i>
        <span>ElevenLabs TTS active <span class="ace-tts-src">(${source})</span></span>
      </div>`;
    }
    // No banner — just a one-time toast on first narration tab view
    if (!this._browserTtsWarned) {
      this._browserTtsWarned = true;
      setTimeout(() => {
        ui.notifications?.info("ACE: Using browser TTS. Set ElevenLabs key in Module Settings for premium voice.");
      }, 500);
    }
    return "";
  }

  /**
   * Determine voice gender for TTS.
   * Priority: manual toggle override → [voice:*] tag in text → default "male".
   */
  _resolveVoiceGender(text) {
    // 1. Manual toggle override (male/female)
    if (this._voiceGender === "male" || this._voiceGender === "female") {
      return this._voiceGender;
    }
    // 2. Auto: parse [voice:female] or [voice:male] tag from text
    const tagMatch = text.match(/^\[voice:(male|female)\]/i);
    if (tagMatch) return tagMatch[1].toLowerCase();
    // 3. Default
    return "male";
  }

  /**
   * Speak text via TTS (ElevenLabs or browser fallback).
   * @param {string} text
   * @param {"male"|"female"} gender
   * @param {object} [opts]
   * @param {boolean} [opts.broadcast=false] — also send audio to all players via socket
   */
  async _speakText(text, gender = "male", { broadcast = false } = {}) {
    if (!text) return;
    this._cancelTTS();
    // Strip any leftover voice tags before speech
    const stripped = text.replace(/^\[voice:(male|female)\]\s*/i, "");
    const clean = this._cleanForSpeech(stripped);
    if (!clean) return;
    try {
      const { key: elevenKey, source } = this._getElevenLabsKey();

      if (elevenKey) {
        console.log(`${MODULE_ID} | TTS: ElevenLabs (${source}), gender=${gender}`);
        await this._speakElevenLabs(clean, elevenKey, gender, broadcast);
      } else {
        // One-time warning per session so the user knows why they're hearing the robot voice
        if (!this._browserTtsWarned) {
          this._browserTtsWarned = true;
          console.warn(
            `${MODULE_ID} | TTS: No ElevenLabs API key configured.\n` +
            `  → Go to Foundry Settings → Module Settings → ACE → "ElevenLabs API Key"\n` +
            `  → Or create modules/${MODULE_ID}/config.local.json with your key.\n` +
            `  → Using browser TTS as fallback.`
          );
          ui.notifications?.info(
            "ACE: Using browser voice — add your ElevenLabs API key in Module Settings for premium TTS.",
            { permanent: false }
          );
        }
        await this._speakBrowser(clean, gender, broadcast);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | TTS error (outer):`, err);
      try { await this._speakBrowser(clean, gender, false); } catch (_) {}
      ui.notifications?.warn("ACE: TTS failed — check console. Trying browser voice as fallback.");
    }
  }

  _cleanForSpeech(text) {
    return text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/^#+\s+/gm, "")
      .replace(/^[-*•]\s+/gm, "")
      .replace(/^\d+\.\s+/gm, "")
      .replace(/\[(.+?)\]\(.+?\)/g, "$1")
      .replace(/[📜⚔️🎲🔊🎭🌦️⚡🗣️🎙✦◈◇►]/gu, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 2400);
  }

  async _speakElevenLabs(text, apiKey, gender = "male", broadcast = false) {
    // config.local.json takes priority; fall back to Settings, then hardcoded defaults
    // ── Narrator voice override: if enabled + populated, use it for everything ──
    let narratorOverride = "";
    try {
      const overrideOn = game.settings.get(MODULE_ID, "narratorVoiceOverrideEnabled");
      if (overrideOn) narratorOverride = (game.settings.get(MODULE_ID, "narratorVoiceOverrideId") || "").trim();
    } catch (_) {}

    const maleVoiceId =
      localCredentials?.elevenLabsVoiceId ||
      game.settings.get(MODULE_ID, "elevenLabsVoiceId") ||
      "o3hzbFqcuIw2MRzP8rQf";

    // Female voice: setting → local config → empty (falls back to male)
    let femaleVoiceId = "";
    try { femaleVoiceId = game.settings.get(MODULE_ID, "elevenLabsFemaleVoiceId") || ""; } catch (_) {}
    if (!femaleVoiceId) femaleVoiceId = localCredentials?.elevenLabsFemaleVoiceId || "";

    const voiceId = narratorOverride || ((gender === "female" && femaleVoiceId) ? femaleVoiceId : maleVoiceId);

    const modelId =
      localCredentials?.elevenLabsModel ||
      game.settings.get(MODULE_ID, "elevenLabsModel") ||
      "eleven_multilingual_v2";
    const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    if (gender === "female" && femaleVoiceId) {
      console.log(`${MODULE_ID} | TTS: Using FEMALE ElevenLabs voice (${voiceId})`);
    }

    try {
      // AbortController — lets _cancelTTS() kill in-flight fetches instantly
      this._ttsAbort = new AbortController();
      this._updateTtsUI();   // pulse the stop button immediately while fetching
      const timeout = setTimeout(() => this._ttsAbort?.abort(), 30_000);
      const resp = await fetch(endpoint, {
        method:  "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", "Accept": "audio/mpeg" },
        body:    JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.35, use_speaker_boost: true },
        }),
        signal: this._ttsAbort.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        console.warn(`${MODULE_ID} | ElevenLabs error ${resp.status}: ${errBody}`);
        const hint = resp.status === 401 ? "Invalid API key — check Module Settings."
                   : resp.status === 403 ? "API key forbidden — check your ElevenLabs subscription."
                   : resp.status === 429 ? "Rate limit exceeded — too many requests."
                   : `ElevenLabs returned ${resp.status} — falling back to browser voice.`;
        ui.notifications?.warn(`ACE TTS: ${hint}`);
        await this._speakBrowser(text, gender, broadcast);
        return;
      }

      const blob    = await resp.blob();

      // ── Broadcast audio to all players via socket ───────────────
      if (broadcast) {
        try {
          const base64 = await AcePanel._blobToBase64(blob);
          // Socket.io handles ~1MB fine; base64 adds ~33% overhead
          if (base64.length < 700_000) {
            game.socket.emit(`module.${MODULE_ID}`, {
              type: "narration-audio",
              audio: base64,
              userId: game.user.id,
            });
            console.log(`${MODULE_ID} | TTS: Broadcast ElevenLabs audio to players (${(base64.length / 1024).toFixed(0)} KB)`);
          } else {
            // Audio too large for socket — send text for browser TTS fallback
            game.socket.emit(`module.${MODULE_ID}`, {
              type: "narration-tts",
              text,
              gender,
              userId: game.user.id,
            });
            console.warn(`${MODULE_ID} | TTS: Audio too large for socket (${(base64.length / 1024).toFixed(0)} KB) — broadcasting text instead`);
          }
        } catch (bcastErr) {
          console.warn(`${MODULE_ID} | TTS: Audio broadcast failed — players will see text only:`, bcastErr);
        }
      }

      const blobUrl = URL.createObjectURL(blob);
      this._ttsAudio = new Audio(blobUrl);
      this._ttsAudio.playbackRate = 1.1;  // ~10% faster narration
      this._ttsAudio.onended = () => {
        URL.revokeObjectURL(blobUrl);
        this._ttsAudio = null;
        this._ttsPlaying = false;
        this._ttsPaused = false;
        this._updateTtsUI();
      };
      this._ttsAudio.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        this._ttsAudio = null;
        this._ttsPlaying = false;
        this._ttsPaused = false;
        this._updateTtsUI();
      };
      this._ttsPlaying = true;
      this._ttsPaused = false;
      this._updateTtsUI();
      await this._ttsAudio.play();
    } catch (err) {
      console.error(`${MODULE_ID} | ElevenLabs TTS failed:`, err);
      await this._speakBrowser(text, gender, broadcast);
    }
  }

  /** Convert a Blob to base64 string (no data URI prefix). */
  static _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Ensure browser voices are loaded.  Chrome loads them asynchronously —
   * the first call to getVoices() returns [].  This method waits for the
   * `voiceschanged` event (up to 3 s) so we can pick a good voice.
   */
  _ensureVoicesLoaded() {
    if (this._voicesReady) return Promise.resolve();
    const synth = window.speechSynthesis;
    if (!synth) return Promise.resolve();

    // Kick off the async load
    const initial = synth.getVoices();
    if (initial.length > 0) {
      this._voicesReady = true;
      return Promise.resolve();
    }

    // Voices not ready yet — wait for the event
    return new Promise((resolve) => {
      const done = () => { this._voicesReady = true; resolve(); };
      synth.addEventListener("voiceschanged", done, { once: true });
      // Safety timeout so we don't wait forever
      setTimeout(done, 3000);
    });
  }

  /**
   * Pick the best available browser voice from the loaded list.
   * Priority: user setting → Windows Neural → macOS natural → legacy → any English.
   */
  _pickBrowserVoice(voices, gender = "male") {
    // 1) User-specified voice name from settings
    const settingKey = gender === "female" ? "browserFemaleVoiceName" : "browserVoiceName";
    let userVoiceName = "";
    try { userVoiceName = game.settings.get(MODULE_ID, settingKey) ?? ""; } catch (_) {}
    if (userVoiceName.trim()) {
      const exact = voices.find((v) => v.name === userVoiceName.trim());
      if (exact) return exact;
      const partial = voices.find((v) => v.name.toLowerCase().includes(userVoiceName.trim().toLowerCase()));
      if (partial) return partial;
    }

    // 2) Auto-detect best available voice (priority: neural/online > Google > legacy > any)
    const enVoices = voices.filter(v => /^en/i.test(v.lang));

    if (gender === "female") {
      // Female voice auto-detect priority
      return (
        // Windows Neural "Online" female voices
        enVoices.find((v) => /online/i.test(v.name) && /microsoft/i.test(v.name) && /\b(jenny|aria|sara|cortana|zira)\b/i.test(v.name))
        // Any Windows Neural female
        || enVoices.find((v) => /online/i.test(v.name) && /\b(jenny|aria|sara|female)\b/i.test(v.name))
        // Google female voices
        || enVoices.find((v) => /google uk english female/i.test(v.name))
        // macOS female voices
        || enVoices.find((v) => /\b(samantha|kate|moira|tessa|fiona|victoria)\b/i.test(v.name))
        // Windows legacy female voices
        || enVoices.find((v) => /microsoft zira/i.test(v.name))
        || enVoices.find((v) => /microsoft hazel/i.test(v.name))
        || enVoices.find((v) => /\b(female|jenny|linda|susan|cortana)\b/i.test(v.name))
        // Any English voice as last resort
        || enVoices[0]
        || null
      );
    }

    // Male voice auto-detect (original logic)
    return (
      // Windows 10/11 Neural "Online" voices — sound excellent
      enVoices.find((v) => /online/i.test(v.name) && /microsoft/i.test(v.name))
      // Edge/Chrome "Natural" voices (very high quality when available)
      || enVoices.find((v) => /natural/i.test(v.name))
      // Google Chrome built-in voices (surprisingly good)
      || enVoices.find((v) => /google uk english male/i.test(v.name))
      || enVoices.find((v) => /google us english/i.test(v.name))
      // macOS high-quality voices
      || enVoices.find((v) => /\b(daniel|samantha|aaron|gordon)\b/i.test(v.name))
      // Windows legacy voices (decent — deep male preferred)
      || enVoices.find((v) => /microsoft david/i.test(v.name))
      || enVoices.find((v) => /microsoft mark\b/i.test(v.name))
      || enVoices.find((v) => /microsoft guy\b/i.test(v.name))
      // Any English male voice (exclude known female voices)
      || enVoices.find((v) => !/female|zira|hazel|susan|jenny|linda|cortana/i.test(v.name))
      // Last resort: any English voice at all
      || enVoices[0]
      || null
    );
  }

  async _speakBrowser(text, gender = "male", broadcast = false) {
    // ── Broadcast text to players so they hear browser TTS too ───
    if (broadcast) {
      try {
        game.socket.emit(`module.${MODULE_ID}`, {
          type: "narration-tts",
          text,
          gender,
          userId: game.user.id,
        });
        console.log(`${MODULE_ID} | TTS: Broadcast narration text to players for browser TTS`);
      } catch (bcastErr) {
        console.warn(`${MODULE_ID} | TTS: Text broadcast failed:`, bcastErr);
      }
    }

    try {
      if (!window.speechSynthesis) {
        console.warn(`${MODULE_ID} | Browser TTS unavailable — speechSynthesis not found.`);
        return;
      }

      // Cancel any in-progress browser TTS to prevent "interrupted" errors
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        window.speechSynthesis.cancel();
        this._ttsUtterance = null;
      }

      // Wait for voices to load (Chrome loads them async — first call returns [])
      await this._ensureVoicesLoaded();

      const userRate  = game.settings.get(MODULE_ID, "browserVoiceRate")  ?? 1.0;
      const userPitch = game.settings.get(MODULE_ID, "browserVoicePitch") ?? 0.95;

      this._ttsUtterance         = new SpeechSynthesisUtterance(text);
      this._ttsUtterance.lang    = "en-US";
      this._ttsUtterance.rate    = userRate;
      this._ttsUtterance.pitch   = userPitch;

      const voices = window.speechSynthesis.getVoices();

      // One-time diagnostic: list all available voices so we can troubleshoot
      if (!this._voicesDumped) {
        this._voicesDumped = true;
        const enVoices = voices.filter(v => /^en/i.test(v.lang));
        console.log(`${MODULE_ID} | Browser TTS: ${voices.length} total voices, ${enVoices.length} English. English voices:\n` +
          enVoices.map(v => `  • "${v.name}" (${v.lang})${v.localService ? "" : " [remote]"}`).join("\n")
        );
      }

      const chosen = this._pickBrowserVoice(voices, gender);

      if (chosen) {
        this._ttsUtterance.voice = chosen;
        // Adjust pitch for female if using auto-detect (slightly higher pitch for feminine voice)
        if (gender === "female" && userPitch <= 1.0) {
          this._ttsUtterance.pitch = Math.min(userPitch + 0.15, 1.5);
        }
        console.log(`${MODULE_ID} | Browser TTS: using voice "${chosen.name}" (${chosen.lang}), gender=${gender}`);
      } else {
        console.warn(`${MODULE_ID} | Browser TTS: no preferred voice found — using system default. ${voices.length} voices available: ${voices.map(v => v.name).join(", ")}`);
      }

      this._ttsUtterance.onend  = () => {
        this._ttsUtterance = null;
        this._ttsPlaying = false;
        this._ttsPaused = false;
        this._updateTtsUI();
      };
      this._ttsUtterance.onerror = (e) => {
        const err = e.error ?? e;
        if (err === "interrupted" || err === "canceled") {
          console.log(`${MODULE_ID} | Browser TTS: previous utterance ${err} (normal when re-narrating).`);
        } else {
          console.error(`${MODULE_ID} | Browser TTS utterance error:`, err);
        }
        this._ttsUtterance = null;
        this._ttsPlaying = false;
        this._ttsPaused = false;
        this._updateTtsUI();
      };
      this._ttsPlaying = true;
      this._ttsPaused = false;
      this._updateTtsUI();
      window.speechSynthesis.speak(this._ttsUtterance);
      console.log(`${MODULE_ID} | Browser TTS: speaking "${text.slice(0, 60)}…"`);
    } catch (err) {
      console.error(`${MODULE_ID} | Browser TTS failed:`, err);
    }
  }

  _cancelTTS() {
    // Abort any in-flight ElevenLabs fetch first
    if (this._ttsAbort) {
      try { this._ttsAbort.abort(); } catch (_) {}
      this._ttsAbort = null;
    }
    if (this._ttsAudio) {
      this._ttsAudio.pause();
      this._ttsAudio.src = "";
      this._ttsAudio = null;
    }
    if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel();
    this._ttsUtterance = null;
    this._ttsPlaying = false;
    this._ttsPaused = false;
    this._updateTtsUI();
  }

  /** Targeted DOM update for TTS button — updates both tab-bar (hidden) and header copies. */
  _updateTtsUI() {
    const isPlaying = this._ttsPlaying && !this._ttsPaused;
    const isPaused = this._ttsPaused;
    const isBusy = !isPlaying && !isPaused && (!!this._ttsAbort || !!this._ttsAudio || window.speechSynthesis?.speaking);

    // Update header TTS controls
    const headerWrap = this.element?.querySelector("#ace-header-tts");
    if (headerWrap) {
      if (isPlaying) {
        headerWrap.innerHTML = `<button class="ace-btn-tts-main ace-tts-playing" data-action="pauseAudio"
          title="Pause narration"><i class="fas fa-pause"></i></button>`;
      } else if (isPaused) {
        headerWrap.innerHTML = `
          <button class="ace-btn-tts-main ace-tts-paused" data-action="resumeAudio"
            title="Resume narration"><i class="fas fa-play"></i></button>
          <button class="ace-btn-tts-stop" data-action="stopAudio"
            title="Stop and clear audio"><i class="fas fa-stop"></i></button>`;
      } else if (isBusy) {
        headerWrap.innerHTML = `<button class="ace-btn-tts-main ace-tts-active" data-action="stopAudio"
          title="Stop all audio"><i class="fas fa-stop"></i></button>`;
      } else {
        headerWrap.innerHTML = "";
      }
    }

    // Also update tab-bar copy (hidden but keeps internal state)
    const tabBtn = this.element?.querySelector("#ace-tts-controls .ace-btn-tts-main");
    if (tabBtn) {
      const isActive = isPlaying || isBusy;
      tabBtn.classList.toggle("ace-tts-active", isActive);
    }
  }

  // ── Context stub ────────────────────────────────────────────

  updateContext() { /* no-op: context tab removed, data still gathered */ }

  /**
   * Build a language note for an NPC actor, injected directly into tactic prompts.
   * Returns a single line (or empty string if no language data available).
   *
   * @param {Actor|null} actor
   * @returns {string}
   */
  _buildLanguageNote(actor) {
    if (!actor?.system) return "";

    // Reuse SceneContext's language extractor if available, otherwise do it inline
    const langs = this.scene?._extractLanguages?.(actor) ?? (() => {
      const langData = actor.system?.traits?.languages;
      if (!langData) return [];
      const ids = langData.value instanceof Set
        ? [...langData.value]
        : Array.isArray(langData.value) ? langData.value : [];
      const cfg = CONFIG?.DND5E?.languages ?? {};
      const labels = ids.map((id) => {
        const e = cfg[id];
        return typeof e === "string" ? e : e?.label ?? id.charAt(0).toUpperCase() + id.slice(1);
      });
      if (langData.custom) labels.push(...langData.custom.split(/[;,]/).map((s) => s.trim()).filter(Boolean));
      return labels.filter(Boolean);
    })();

    if (!langs.length) return "";

    const speaksCommon = langs.some((l) => /common/i.test(l));
    if (speaksCommon && langs.length === 1) return ""; // speaks only Common — not worth noting

    const langList = langs.join(", ");
    if (!speaksCommon) {
      return `\n**Language:** ${actor.name} speaks ${langList} — does NOT understand Common. They cannot be reasoned with in Common, read Common text, or respond to Common speech. Roleplay their communication accordingly.\n`;
    }
    return `\n**Languages:** ${actor.name} speaks ${langList}.\n`;
  }

  /**
   * Build the combined NPC + memory context string for AI prompts.
   * Merges:
   *   1. NPCLink AI Memory journals (live scene NPCs)
   *   2. ACE persistent memory context (recent events, known NPCs, last session)
   * @returns {string}
   */
  async _buildNpcContext() {
    const parts = [];

    // NPCLink scene memories (real-time journal content)
    const npcLinkMem = this.memory?.getSceneNpcMemories() ?? "";
    if (npcLinkMem) parts.push(npcLinkMem);

    // ACE persistent memory context (compact, budget 2000 chars)
    const lkCtx = this.lkMemory?.getContextString(2000) ?? "";
    if (lkCtx) parts.push(lkCtx);

    // Reputation / word-of-mouth context for relevant NPCs
    if (this.reputation) {
      const repCtx = this._buildReputationContext();
      if (repCtx) parts.push(repCtx);
    }

    // Conversation knowledge awareness (who knows what from Envoy chats)
    const convoKnowledge = this._buildConversationKnowledgeContext();
    if (convoKnowledge) parts.push(convoKnowledge);

    // Legacy Ledger — compact summaries from past campaigns
    if (this._vaultEngine) {
      try {
        const ledgerCtx = await this._vaultEngine.getLedgerContext(800);
        if (ledgerCtx) parts.push(ledgerCtx);
      } catch (err) { console.debug("ace-engine | Panel ledger context fetch non-critical:", err); }
    }

    return parts.join("\n\n");
  }

  // ── Cross-Store Entity Linking ──────────────────────────────

  /**
   * Build supplemental context for entities discovered in document search
   * results that might have matching records in the NPC/reputation/deed stores.
   *
   * Example: A PDF room description mentions "Rahadin" — if the party has
   * met Rahadin before, this pulls in his NPC record (killed status, notes,
   * combat stats, relationships) and reputation context so the AI knows
   * the party's history with this NPC even though he's not on the scene.
   *
   * @param {{ npcs: string[], locations: string[], headingNames: string[] }} docEntities
   * @returns {string} Formatted cross-store context, or ""
   * @private
   */
  _buildCrossStoreContext(docEntities) {
    if (!docEntities || !this.lkMemory) return "";

    const parts = [];
    const checked = new Set();

    // Combine NPC names, location names, and heading names as potential NPC lookups
    const candidateNames = [
      ...(docEntities.npcs ?? []),
      ...(docEntities.headingNames ?? []),
    ];

    for (const name of candidateNames) {
      if (!name || name.length < 3) continue;
      const key = name.toLowerCase().trim();
      if (checked.has(key)) continue;
      checked.add(key);

      // Look up in NPC store
      const npcRec = this.lkMemory.npcs?.getRecord(name);
      if (!npcRec) continue;

      // Build a compact summary of what the party knows about this NPC
      const lines = [];
      lines.push(`**${npcRec.displayName}**`);

      if (npcRec.killed) {
        lines.push(`  - STATUS: KILLED${npcRec.killedBy ? ` by ${npcRec.killedBy}` : ""}`);
      }
      if (npcRec.met > 0) {
        lines.push(`  - Met ${npcRec.met} time(s), last seen: ${new Date(npcRec.lastSeen * 1000).toLocaleDateString()}`);
      }
      if (npcRec.scenes?.length) {
        lines.push(`  - Seen in: ${npcRec.scenes.slice(-3).join(", ")}`);
      }
      if (npcRec.relationships && Object.keys(npcRec.relationships).length > 0) {
        const relStr = Object.entries(npcRec.relationships)
          .slice(0, 5)
          .map(([who, rel]) => `${who}: ${rel}`)
          .join("; ");
        lines.push(`  - Relationships: ${relStr}`);
      }
      if (npcRec.notes?.length) {
        const recentNotes = npcRec.notes.slice(-3).map(n => n.txt).join(" | ");
        lines.push(`  - Notes: ${recentNotes}`);
      }
      if (npcRec.combatStats?.encounterCount > 0) {
        lines.push(`  - Combat: ${npcRec.combatStats.encounterCount} encounter(s)${npcRec.combatStats.wasDefeated ? " (was defeated)" : ""}`);
      }

      if (lines.length > 1) { // has more than just the name
        parts.push(lines.join("\n"));
      }

      // Also check reputation context for this NPC
      if (this.reputation) {
        try {
          const knowledge = this.reputation.getNpcKnowledge?.(null, null);
          if (knowledge?.promptText) parts.push(knowledge.promptText);
        } catch (err) { console.debug("ace-engine | Panel reputation NPC knowledge non-critical:", err); }
      }

      // Cap to avoid bloating the prompt
      if (parts.length >= 4) break;
    }

    if (parts.length === 0) return "";

    return "## CROSS-REFERENCED NPC RECORDS\n" +
      "The following NPCs are mentioned in the reference documents above. " +
      "The party has interacted with them before:\n\n" +
      parts.join("\n\n");
  }

  // ── Learning Cache ────────────────────────────────────────

  /**
   * Decide whether an AI response is worth learning from, then fire
   * the extraction in the background (non-blocking).
   */
  _maybeLearnFromResponse(responseText) {
    // Must have a World Bible
    if (!this._worldBible?.hasData) return;

    // Check setting
    const autoLearn = game.settings.get(MODULE_ID, "autoLearnToBible") ?? false;
    if (!autoLearn) return;

    // Smart filter: skip short, generic, or rules-heavy responses
    if (responseText.length < 120) return; // too short to contain lore

    // Count capitalized proper nouns (rough heuristic for named entities)
    const properNouns = responseText.match(/\b[A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*/g) ?? [];
    if (properNouns.length < 2) return; // no named entities worth extracting

    // Skip if it looks like pure rules/mechanics
    const rulesSignals = ["DC ", "saving throw", "hit points", "damage roll", "spell slot",
      "ability check", "proficiency bonus", "attack roll", "initiative"];
    const rulesCount = rulesSignals.reduce((n, s) => n + (responseText.includes(s) ? 1 : 0), 0);
    if (rulesCount >= 3) return; // too mechanical

    // Skip error messages
    if (responseText.startsWith("**Error") || responseText.startsWith("**Invalid")
     || responseText.startsWith("**Connection") || responseText.startsWith("**Rate")) return;

    // Fire in background — non-blocking, don't await
    this._learnFromResponseAsync(responseText);
  }

  async _learnFromResponseAsync(responseText) {
    try {
      const api = game.modules.get(MODULE_ID)?.api;
      if (!api?.learnFromText) return;
      const result = await api.learnFromText(responseText);
      if (result.learned > 0) {
        console.log(`${MODULE_ID} | Auto-learn: +${result.learned} new entries from chat response.`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Auto-learn background error:`, err);
    }
  }

  /**
   * Manual "Learn" — triggered by the learn button on a specific chat message.
   * Always runs regardless of the auto-learn setting.
   */
  async _learnFromMessage(messageIndex) {
    const msg = this._chatHistory[messageIndex];
    if (!msg || msg.role !== "assistant" || !msg.content) return;
    if (!this._worldBible?.hasData) {
      ui.notifications.warn("ACE | World Bible must be generated before learning.");
      return;
    }

    const api = game.modules.get(MODULE_ID)?.api;
    if (!api?.learnFromText) return;

    try {
      const result = await api.learnFromText(msg.content);
      if (result.learned > 0) {
        ui.notifications.info(`ACE | Learned ${result.learned} new entries from this response.`);
      } else {
        ui.notifications.info("ACE | No new world knowledge found in this response.");
      }
      return result;
    } catch (err) {
      console.error(`${MODULE_ID} | Manual learn failed:`, err);
      ui.notifications.error("ACE | Learn failed — check console.");
    }
  }

  /**
   * Build World Bible context for AI prompt injection.
   * Extracts key terms from the user message + scene and searches the Bible.
   * @param {string} userMessage - The user's current message/query
   * @param {string} sceneCtx   - Scene context string
   * @returns {string} Formatted World Bible block, or ""
   */
  _buildWorldBibleContext(userMessage = "", sceneCtx = "") {
    if (!this._worldBible?.hasData) return "";
    try {
      const parts = [];

      // Extract search terms: split on common words and punctuation
      const stopWords = new Set(["the","a","an","is","are","was","were","be","been","being",
        "have","has","had","do","does","did","will","would","could","should","shall","may","might",
        "can","about","tell","me","what","where","who","how","why","when","which","this","that",
        "with","from","into","for","and","but","or","not","of","in","on","at","to","by","it","its","i"]);
      const words = userMessage.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

      // Search for multi-word phrases first (2-3 word combos), then individual words
      const searched = new Set();
      const allTerms = [];

      // Try the full message as a search (catches proper nouns like "Vallaki")
      const cleaned = userMessage.replace(/[?!.,;:]/g, "").trim();
      if (cleaned.length > 2 && cleaned.length < 60) allTerms.push(cleaned);

      // Try significant words individually
      for (const w of words) allTerms.push(w);

      // Also search for the current scene name
      const sceneName = canvas?.scene?.name ?? "";
      if (sceneName) allTerms.push(sceneName);

      for (const term of allTerms) {
        const key = term.toLowerCase();
        if (searched.has(key)) continue;
        searched.add(key);

        const result = this._worldBible.search(term, 3);
        if (result) {
          parts.push(result);
          // Limit total Bible context to avoid prompt bloat
          if (parts.join("\n").length > 3000) break;
        }
      }

      return parts.length ? parts.join("\n") : "";
    } catch (err) {
      console.warn(`${MODULE_ID} | World Bible context error:`, err);
      return "";
    }
  }

  /**
   * Build document library context for AI prompt injection.
   * Uses the user's message + scene context + conversation history for relevance matching.
   * @param {string} userMessage - The user's current message/query
   * @returns {string} Formatted reference library block, or ""
   */
  async _buildDocumentContext(userMessage = "") {
    if (!this._documentEngine) return "";
    try {
      const enableLib = game.settings.get(MODULE_ID, "enableDocumentLibrary") ?? true;
      if (!enableLib) return "";
      const sceneCtx = this.scene?.gather() ?? "";
      const sceneName = canvas?.scene?.name ?? "";
      const budget = game.settings.get(MODULE_ID, "docContextBudget") ?? 2000;

      // Conversation-aware search: extract the last AI response so the
      // search pipeline can pull entities (rooms, NPCs, locations) from it
      // and use them to enrich follow-up queries like "what about that NPC?"
      const lastAssistant = this._getLastAssistantMessage();

      return await this._documentEngine.buildDocumentContext(
        sceneCtx, userMessage, sceneName, budget, lastAssistant
      );
    } catch (err) {
      console.warn(`${MODULE_ID} | Document context error:`, err);
      return "";
    }
  }

  /**
   * Get the most recent assistant message from chat history.
   * Used for conversation-aware search — entities in the last AI response
   * are injected as supplemental search terms for follow-up queries.
   * @returns {string} The last assistant message content, or ""
   * @private
   */
  _getLastAssistantMessage() {
    if (!this._chatHistory?.length) return "";
    for (let i = this._chatHistory.length - 1; i >= 0; i--) {
      if (this._chatHistory[i].role === "assistant") {
        return this._chatHistory[i].content ?? "";
      }
    }
    return "";
  }

  /**
   * Build cross-campaign vault context when the user's message suggests
   * they're asking about events from a past campaign.
   *
   * Auto-detects cross-campaign intent via keyword patterns, then searches
   * the vault snapshots and returns formatted context for AI injection.
   *
   * @param {string} userMessage
   * @returns {Promise<string>}
   */
  async _buildVaultContext(userMessage = "") {
    if (!this._vaultSearch) return "";
    if (!userMessage?.trim()) return "";

    try {
      const lower = userMessage.toLowerCase();

      // ── Intent Detection ─────────────────────────────────────
      // Check for explicit cross-campaign language
      const crossCampaignPhrases = [
        "other campaign", "different campaign", "last campaign", "previous campaign",
        "old campaign", "past campaign", "another campaign", "another world",
        "different world", "years ago", "long ago", "ever fought", "ever talk",
        "ever met", "ever encounter", "ever killed", "ever faced", "ever seen",
        "remember when", "back when", "in the past", "from before",
        "cross campaign", "cross-campaign", "other adventure", "previous adventure",
      ];

      const hasCrossCampaignIntent = crossCampaignPhrases.some(phrase => lower.includes(phrase));

      // If no explicit cross-campaign language, also check if the query
      // mentions character names that exist in the vault but NOT in the current world
      let hasVaultOnlyName = false;
      if (!hasCrossCampaignIntent) {
        // Quick check: does the vault have ANY archived worlds?
        const worlds = await this._vaultSearch.discoverWorlds();
        if (!worlds.length) return "";

        // Do a speculative search — if it returns results, the name exists in vault
        const specHits = await this._vaultSearch.search(userMessage, { maxResults: 3 });
        if (specHits.length > 0) {
          // Check if ANY hit scores well enough to warrant cross-campaign context
          hasVaultOnlyName = specHits[0].score >= 0.5;
        }
      }

      if (!hasCrossCampaignIntent && !hasVaultOnlyName) return "";

      // ── Search vault snapshots ────────────────────────────────
      const ctx = await this._vaultSearch.buildCrossWorldContext(userMessage, 800);
      if (ctx) {
        console.debug(`${MODULE_ID} | Vault Search: cross-campaign context injected (${ctx.length} chars)`);
      }
      return ctx;
    } catch (err) {
      console.warn(`${MODULE_ID} | Vault context error:`, err);
      return "";
    }
  }

  /**
   * Build reputation context for NPCs in the current interaction.
   * Checks: current combat combatant → selected tokens → controlled tokens.
   * Returns reputation paragraph for the most relevant NPC, or empty string.
   */
  _buildReputationContext() {
    if (!this.reputation) return "";

    // Try multiple sources for "which NPC are we talking about?"
    const candidates = [];

    // 1. Current combat combatant (for tactics)
    const combatant = game.combat?.combatant;
    if (combatant?.actor && !combatant.actor.hasPlayerOwner) {
      candidates.push(combatant.name);
    }

    // 2. Selected NPC tokens from the Select tab
    for (const tokenId of this._selectedTokens) {
      const token = canvas?.tokens?.placeables?.find(t =>
        t.id === tokenId || t.actor?.id === tokenId
      );
      if (token && !token.actor?.hasPlayerOwner) {
        candidates.push(token.name);
      }
    }

    // 3. Controlled token on canvas
    const controlled = canvas?.tokens?.controlled ?? [];
    for (const token of controlled) {
      if (!token.actor?.hasPlayerOwner) {
        candidates.push(token.name);
      }
    }

    // Build context for each unique candidate, combine
    const seen = new Set();
    const contextParts = [];
    for (const name of candidates) {
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      try {
        // getNpcKnowledge takes (factionId, location) — pass null for both
        // and let it determine context from notoriety level
        const knowledge = this.reputation.getNpcKnowledge?.(null, null);
        if (knowledge?.promptText) contextParts.push(knowledge.promptText);
      } catch (err) {
        console.warn("ace-engine | Reputation context skipped:", err.message);
      }
      if (contextParts.length >= 1) break; // one reputation block is enough
    }

    return contextParts.join("\n");
  }

  // ── NPC Knowledge Awareness ─────────────────────────────────

  /**
   * Build conversation knowledge context with reasoning instructions.
   * Enriches AI context with Envoy conversation data + NPC sensory traits
   * so the AI can decide what each NPC plausibly knows.
   * @returns {string}
   */
  _buildConversationKnowledgeContext() {
    const envoy = game.modules.get("ace-envoy");
    if (!envoy?.active || !envoy.api) return "";

    const activeConvos    = envoy.api.getActiveConversations?.()              ?? [];
    const recentSummaries = envoy.api.getRecentConversationSummaries?.(true)  ?? [];
    if (!activeConvos.length && !recentSummaries.length) return "";

    const parts = [];

    parts.push("## PRIVATE CONVERSATIONS (Knowledge Awareness)");
    parts.push("");
    parts.push("The following conversations occurred privately between specific PCs and NPCs.");
    parts.push("Each conversation's contents are ONLY known to its direct participants unless");
    parts.push("another NPC has a plausible way to access that information (see NPC CAPABILITIES below).");
    parts.push("");

    // ── Active conversations ──────────────────────────────────
    if (activeConvos.length) {
      parts.push("### Currently Active Conversations");
      for (const convo of activeConvos) {
        const dist = this._computeConvoProximity(convo);
        parts.push(`- **${convo.pcName}** is speaking privately with **${convo.npcName}** (${convo.exchangeCount} exchanges so far)`);
        if (dist !== null) parts.push(`  Location: tokens are ${dist}ft apart on the scene`);
      }
      parts.push("");
    }

    // ── Recent conversation logs ──────────────────────────────
    if (recentSummaries.length) {
      parts.push("### Recent Conversation Logs");
      for (const summary of recentSummaries) {
        const header = summary.pcName
          ? `**${summary.npcName}** (spoke with ${summary.pcName})${summary.isActiveNow ? " [ONGOING]" : ""}:`
          : `**${summary.npcName}**${summary.isActiveNow ? " [ONGOING]" : ""}:`;
        parts.push(header);

        // Format last few exchanges compactly (400 char budget per NPC)
        let charBudget = 400;
        for (const msg of summary.exchanges) {
          const speaker = msg.role === "user" ? (summary.pcName ?? "Player") : summary.npcName;
          const line = `  ${speaker}: ${msg.content}`;
          const truncated = line.length > charBudget ? line.slice(0, charBudget) + "..." : line;
          parts.push(truncated);
          charBudget -= truncated.length;
          if (charBudget <= 0) break;
        }
        parts.push("");
      }
    }

    // ── NPC sensory capabilities ──────────────────────────────
    const capSection = this._buildNpcCapabilities();
    if (capSection) parts.push(capSection);

    // ── Knowledge reasoning rules ─────────────────────────────
    parts.push("### Knowledge Reasoning Rules");
    parts.push("When generating responses, suggestions, or narratives involving NPCs:");
    parts.push("1. Each NPC should ONLY act on information they could PLAUSIBLY know.");
    parts.push("2. A conversation between PC-A and NPC-X is private to those two participants.");
    parts.push("3. NPC-Y does NOT know what was said UNLESS:");
    parts.push("   a. NPC-Y was within 30ft and could overhear (check token positions above)");
    parts.push("   b. NPC-Y has Telepathy and the conversation occurred within telepathy range");
    parts.push("   c. NPC-Y has Detect Thoughts or similar divination active");
    parts.push("   d. NPC-Y and NPC-X share a faction AND the conversation ended (word could spread)");
    parts.push("   e. NPC-Y has Keen Hearing or similar enhanced senses (double overhear range to 60ft)");
    parts.push("   f. The GM explicitly narrated that information was shared");
    parts.push("4. When in doubt, the NPC does NOT know. Err on the side of information isolation.");
    parts.push("5. If an NPC acts on overheard information, briefly note HOW they learned it.");
    parts.push("6. Active [ONGOING] conversations are happening RIGHT NOW — other NPCs might notice");
    parts.push("   the participants talking but cannot hear the content unless within range.");
    parts.push("");

    return parts.join("\n");
  }

  /**
   * Compute distance in feet between conversation participant tokens.
   * @param {object} convo — active conversation metadata from Envoy API
   * @returns {number|null}
   */
  _computeConvoProximity(convo) {
    if (!convo.npcTokenPos || !convo.pcTokenPos) return null;
    try {
      const gridSizePx = canvas.grid.size;
      const gridFt     = canvas.grid.distance;
      const dx = convo.npcTokenPos.x - convo.pcTokenPos.x;
      const dy = convo.npcTokenPos.y - convo.pcTokenPos.y;
      return Math.round((Math.hypot(dx, dy) / gridSizePx) * gridFt);
    } catch (err) { console.debug("ace-engine | Panel conversation proximity calculation failed:", err); return null; }
  }

  /**
   * Build formatted section listing each scene NPC's sensory capabilities.
   * @returns {string}
   */
  _buildNpcCapabilities() {
    const tokenDocs = canvas?.scene?.tokens ?? [];
    const npcTokens = tokenDocs.filter(td => !td.actor?.hasPlayerOwner && td.actor);
    if (!npcTokens.length) return "";

    const lines = ["### NPC Sensory Capabilities"];
    let hasCapabilities = false;

    for (const td of npcTokens) {
      const traits = this._detectNpcSensoryTraits(td.actor);
      if (traits.length) {
        hasCapabilities = true;
        lines.push(`- **${td.name}**: ${traits.join("; ")}`);
      }
    }

    if (!hasCapabilities) {
      lines.push("- No NPCs on this scene have special sensory capabilities.");
      lines.push("  Standard rules apply: overhearing within 30ft, no telepathy.");
    }

    lines.push("");
    return lines.join("\n");
  }

  /**
   * Detect sensory traits relevant to knowledge awareness from an NPC actor.
   * Checks: items (features/spells), senses, active effects, biography.
   * @param {Actor} actor
   * @returns {string[]}
   */
  _detectNpcSensoryTraits(actor) {
    if (!actor) return [];
    const traits = [];

    // ── 1. Actor items (features, feats, spells) ─────────────
    for (const item of (actor.items ?? [])) {
      const name = (item.name ?? "").toLowerCase();
      const desc = this._stripHtmlSimple(
        item.system?.description?.value ?? item.system?.description ?? ""
      ).toLowerCase();
      const combined = name + " " + desc;

      if (combined.includes("telepathy")) {
        const m = combined.match(/telepathy\s+(\d+)\s*(?:ft|feet)/i);
        if (!traits.some(t => t.startsWith("Telepathy")))
          traits.push(m ? `Telepathy ${m[1]}ft` : "Telepathy");
      }
      if (name.includes("keen hearing") || name.includes("keen senses"))
        traits.push("Keen Hearing (effective overhear range 60ft)");
      if (name.includes("detect thoughts"))
        traits.push("Detect Thoughts (sense surface thoughts within 30ft)");
      if (name.includes("scrying"))
        traits.push("Scrying (observe distant targets)");
      if (name.includes("clairvoyance"))
        traits.push("Clairvoyance (see/hear at a distant point)");
      if (name.includes("tongues"))
        traits.push("Tongues (understands all languages)");
    }

    // ── 2. Senses attribute (compatible with D&D 5e 5.2.x and 5.3.0+) ──
    const rawSenses = actor.system?.attributes?.senses ?? {};
    const senses = rawSenses.ranges ?? rawSenses;
    if (senses.blindsight > 0) traits.push(`Blindsight ${senses.blindsight}ft`);
    if (senses.tremorsense > 0) traits.push(`Tremorsense ${senses.tremorsense}ft`);
    if (senses.truesight > 0) traits.push(`Truesight ${senses.truesight}ft`);

    const specialSenses = (rawSenses.special ?? senses.special ?? "").toLowerCase();
    if (specialSenses.includes("telepathy") && !traits.some(t => t.startsWith("Telepathy"))) {
      const m = specialSenses.match(/telepathy\s+(\d+)\s*(?:ft|feet)?/i);
      traits.push(m ? `Telepathy ${m[1]}ft` : "Telepathy");
    }

    // ── 3. Active effects ────────────────────────────────────
    for (const effect of (actor.effects?.filter(e => !e.disabled) ?? [])) {
      const eName = (effect.name ?? effect.label ?? "").toLowerCase();
      if (eName.includes("detect thoughts") && !traits.some(t => t.includes("Detect Thoughts")))
        traits.push("Detect Thoughts (active effect)");
      if (eName.includes("telepathy") && !traits.some(t => t.startsWith("Telepathy")))
        traits.push("Telepathy (active effect)");
    }

    // ── 4. Biography (last resort) ───────────────────────────
    const bio = this._stripHtmlSimple(
      actor.system?.details?.biography?.value ?? ""
    ).toLowerCase();
    if (bio.includes("telepathy") && !traits.some(t => t.startsWith("Telepathy"))) {
      const m = bio.match(/telepathy\s+(\d+)\s*(?:ft|feet)?/i);
      traits.push(m ? `Telepathy ${m[1]}ft` : "Telepathy");
    }

    return [...new Set(traits)];
  }

  /** Strip HTML tags from a string for trait scanning. */
  _stripHtmlSimple(html) {
    if (!html) return "";
    return html.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim();
  }

  // ── UI Helpers ─────────────────────────────────────────────

  _switchToTab(tab) {
    this._activeTab = tab;
    this.element?.querySelectorAll(".ace-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    this.element?.querySelectorAll(".ace-tab-content").forEach((el) => {
      el.classList.toggle("active", el.dataset.tabContent === tab);
    });
  }

  _refreshChatUI() {
    const log = this.element?.querySelector("#ace-chat-log");
    if (log) {
      log.innerHTML = this._renderChatMessages();
      this._scrollChatToBottom();
    }
  }

  _refreshNarrationUI() {
    const log = this.element?.querySelector("#ace-narration-log");
    if (log) {
      log.innerHTML = this._renderNarrationMessages();
      this._scrollNarrationToBottom();
    }
  }

  _refreshSuggestionsUI() {
    const container = this.element?.querySelector("#ace-suggestions");
    if (container) container.innerHTML = this._renderSuggestions();
  }

  _updateStreamingMessage(index) {
    const log = this.element?.querySelector("#ace-chat-log");
    if (!log) return;
    const msgEl = log.querySelector(`[data-index="${index}"] .ace-msg-body`);
    if (msgEl) {
      msgEl.innerHTML = this._renderChatBody(this._chatHistory[index].content);
      this._scrollChatToBottom();
    }
  }

  /**
   * Check whether the AI provider needs setup (no key for cloud providers).
   * Returns true if user needs to configure something before AI works.
   */
  _checkNeedsSetup() {
    try {
      const provider = game.settings.get(MODULE_ID, "aiProvider");
      const apiKey   = game.settings.get(MODULE_ID, "apiKey") || "";
      // Local providers (ollama, lmstudio) don't need an API key
      if (provider === "ollama" || provider === "lmstudio") return false;
      return !apiKey.trim();
    } catch (_) {
      return true;
    }
  }

  _scrollChatToBottom() {
    const log = this.element?.querySelector("#ace-chat-log");
    if (log) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    this._autoGrowPanel();
  }

  /**
   * Auto-expand panel height as content fills in, up to a max.
   * Detects when the chat/narration log is scrolling (content overflows)
   * and grows the panel to reduce or eliminate the need to scroll.
   * Capped at 85% of the viewport height or 900px.
   */
  _autoGrowPanel() {
    const el = this.element;
    if (!el) return;

    const MAX_HEIGHT = Math.min(900, Math.floor(window.innerHeight * 0.85));
    const currentH   = this.position?.height ?? 740;

    if (currentH >= MAX_HEIGHT) return; // already maxed out

    // Find the active scrollable log (chat or narration)
    const log = el.querySelector("#ace-chat-log") || el.querySelector("#ace-narration-log");
    if (!log) return;

    // How much content is hidden (overflowing)?
    const overflow = log.scrollHeight - log.clientHeight;
    if (overflow <= 10) return; // no meaningful overflow

    // Grow by the overflow amount (but don't exceed max)
    const targetH = Math.min(MAX_HEIGHT, currentH + overflow);
    if (targetH > currentH + 20) { // only resize if meaningful (>20px)
      try { this.setPosition({ height: targetH }); } catch (_) {}
    }
  }

  _scrollNarrationToBottom() {
    const log = this.element?.querySelector("#ace-narration-log");
    if (log) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    this._autoGrowPanel();
  }

  _setInputState(enabled) {
    const btn   = this.element?.querySelector("[data-action='sendMessage']");
    const input = this.element?.querySelector("#ace-input");
    if (btn)   btn.disabled   = !enabled;
    if (input) input.disabled = !enabled;
  }

  // ── Markdown / HTML helpers ───────────────────────────────

  _renderMarkdown(text) {
    if (!text) return "";
    let html = this._escapeHtml(text);

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="ace-code"><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code class="ace-inline-code">$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/^### (.+)$/gm, '<h4 class="ace-md-h3">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3 class="ace-md-h2">$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2 class="ace-md-h1">$1</h2>');
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
    html = html.replace(/<\/blockquote>\s*<br>\s*<blockquote>/g, "<br>");
    html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul class="ace-md-list">$&</ul>');
    html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
    html = html.replace(/\n/g, "<br>");

    return html;
  }

  /**
   * Render a chat message body with [NARRATION] blocks visually separated.
   * Content inside [NARRATION]...[/NARRATION] gets a gold-bordered box.
   * Everything else renders as normal markdown.
   */
  _renderChatBody(text) {
    if (!text) return "";

    // Check for [NARRATION] blocks
    const narrationRegex = /\[NARRATION\]\s*([\s\S]*?)\s*\[\/NARRATION\]/gi;
    if (!narrationRegex.test(text)) return this._renderMarkdown(text);

    // Reset regex
    narrationRegex.lastIndex = 0;

    let result = "";
    let lastIndex = 0;
    let match;
    while ((match = narrationRegex.exec(text)) !== null) {
      // Render text before the narration block
      const before = text.slice(lastIndex, match.index).trim();
      if (before) result += this._renderMarkdown(before);

      // Render the narration block in a styled container
      const narrationText = match[1].trim();
      result += `<div class="ace-narration-block">
        <div class="ace-narration-block-label"><i class="fas fa-scroll"></i> Narration</div>
        <div class="ace-narration-block-text">${this._renderMarkdown(narrationText)}</div>
      </div>`;

      lastIndex = match.index + match[0].length;
    }

    // Render any text after the last narration block
    const after = text.slice(lastIndex).trim();
    if (after) result += this._renderMarkdown(after);

    return result;
  }

  /**
   * Extract narration text from a chat message (content inside [NARRATION] tags).
   * Falls back to the full message if no tags are present.
   */
  static _extractNarration(content) {
    const match = content.match(/\[NARRATION\]\s*([\s\S]*?)\s*\[\/NARRATION\]/i);
    if (match) return match[1].trim();
    return content;
  }

  _escapeHtml(text) {
    if (!text) return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Check if an item is a natural/monster weapon by type flag OR name pattern. */
  static _isNaturalWeapon(item) {
    const wepType = item.system?.type?.value || item.system?.weaponType || "";
    if (wepType === "natural") return true;
    const name = (item.name || "").toLowerCase();
    return /^(bite|claw|claws|tail|tail attack|wing|wing attack|gore|slam|tentacle|tentacles|talon|talons|horns?|hooves?|sting|stomp|constrict|crush|ram|beak|pincers?|rock|multiattack|frightful presence|breath weapon)\b/.test(name);
  }

  /**
   * Post-process rendered encounter HTML to add a Copy button to every
   * <blockquote> element (the "Read-Aloud Text" boxed passages).
   * Uses inline onclick so the button works inside dynamically injected content.
   *
   * @param {string} html - already-rendered HTML from _renderMarkdown
   * @returns {string}
   */
  _addReadAloudCopy(html) {
    return html.replace(
      /(<blockquote>)([\s\S]*?)(<\/blockquote>)/g,
      (_, open, content, close) => {
        // Strip tags from the content to get clean plain text for the clipboard
        const plain = content.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        const safe  = plain.replace(/'/g, "\\'").replace(/"/g, "&quot;");
        return (
          `<div class="ace-bq-wrap">` +
          `${open}${content}${close}` +
          `<button class="ace-bq-copy" title="Copy read-aloud text" ` +
          `onclick="navigator.clipboard.writeText('${safe}').then(()=>{` +
          `this.innerHTML='<i class=\\'fas fa-check\\'></i> Copied';` +
          `setTimeout(()=>{this.innerHTML='<i class=\\'fas fa-copy\\'></i> Copy'},1500)})">` +
          `<i class="fas fa-copy"></i> Copy</button>` +
          `</div>`
        );
      }
    );
  }

  // ── Adventure / Survival Tracker ───────────────────────────

  /**
   * Called by ace-engine.mjs when canvasReady fires (scene change).
   * Counts each scene as ~30-60 min of in-game travel time.
   */
  trackSceneTransition() {
    if (!this._tracker) return;
    this._tracker.scenesSinceMeal++;
    this._tracker.scenesSinceRest++;
    this._updateTrackerUI();
    this._checkSurvivalReminders();
  }

  _updateTrackerUI() {
    // Meal/rest chips removed in v1.2 — tracker runs silently in background
    // Day counter updates itself via _updateDayCounterUI()
  }

  _checkSurvivalReminders() {
    const m = this._tracker.scenesSinceMeal;
    const r = this._tracker.scenesSinceRest;

    // Popup warnings — each fires once per threshold crossing
    if (m >= 8 && !this._mealWarned8) {
      this._mealWarned8 = true;
      ui.notifications?.error("🍖 Hunger Warning — The party risks exhaustion without food! (8+ scenes without eating)");
    } else if (m >= 4 && !this._mealWarned4) {
      this._mealWarned4 = true;
      ui.notifications?.warn("⏰ The party hasn't eaten in a while. Consider a meal break. (4+ scenes)");
    }

    if (r >= 15 && !this._restWarned15) {
      this._restWarned15 = true;
      ui.notifications?.error("💤 Exhaustion Warning — 15+ scenes without rest! Exhaustion rules may apply.");
    } else if (r >= 8 && !this._restWarned8) {
      this._restWarned8 = true;
      ui.notifications?.warn("⏰ The party has been active for 8+ scenes. They may need rest soon.");
    }
  }

  /** Adds a GM-only system note to the chat history. */
  _pushSystemNote(text, urgent = false) {
    this._chatHistory.push({
      role:      "assistant",
      content:   text,
      timestamp: Date.now(),
      isTactic:  urgent,
    });
    this._refreshChatUI();
    this._scrollChatToBottom();
    // Flash the Chat tab if not active
    if (this._activeTab !== "chat") {
      const chatTab = this.element?.querySelector(".ace-tab[data-tab='chat']");
      if (chatTab && !chatTab.querySelector(".ace-badge")) {
        const badge = document.createElement("span");
        badge.className   = "ace-badge";
        badge.textContent = "!";
        chatTab.appendChild(badge);
      }
    }
  }

  // ── Auto Crit / Fumble (called from createChatMessage hook) ──

  /**
   * Generate a unique AI narrative for a crit or fumble, post it to Foundry
   * chat (visible to all players), speak it via TTS, and update the panel tab.
   *
   * @param {object}           opts
   * @param {"crit"|"fumble"}  opts.type
   * @param {string}           opts.actorName
   * @param {boolean}          opts.isPC        - false = NPC (no mechanical crit bonus shown)
   * @param {string}           [opts.weaponName]
   * @param {string}           [opts.targetName]
   */
  async autoTriggerCritFumble({ type, actorName, isPC, weaponName, targetName, actor = null } = {}) {
    if (!type || !actorName) return;

    // 1. Pick a mechanical result from the table
    const table    = type === "crit" ? AcePanel.CRIT_TABLE : AcePanel.FUMBLE_TABLE;
    const idx      = Math.floor(Math.random() * table.length);
    const mechHTML = table[idx];
    const mechText = mechHTML.replace(/<[^>]+>/g, "");

    // NPCs show flavor only on crits — no mechanical bonus readout
    const showMech = isPC || type === "fumble";

    // 2. Ask AI for a single punchy line — short & glorious
    const weapon   = weaponName || "their weapon";
    const target   = targetName ? ` against ${targetName}` : "";
    const aiPrompt = type === "crit"
      ? `[D&D narrator — ONE sentence only, max 15 words, no preamble. SECOND PERSON for the acting character ("You..."), THIRD PERSON for NPCs ("The guard...", "He..."). NEVER use first person ("I", "my", "me").]\n${actorName} scores a critical hit with ${weapon}${target}. Describe the strike — visceral, dramatic, specific.`
      : `[D&D narrator — ONE sentence only, max 15 words, no preamble. SECOND PERSON for the acting character ("You..."), THIRD PERSON for NPCs ("The guard...", "He..."). NEVER use first person ("I", "my", "me").]\n${actorName} fumbles with ${weapon}. Describe the mishap — comedic, specific, punchy.`;

    let narrative = "";
    try {
      await this.ai.chatStream(aiPrompt, "", "", [], (chunk) => { narrative += chunk; });
      narrative = narrative.trim().replace(/^["'""'']|["'""'']$/gu, "").trim();

      // Hard guardrail: take only the first sentence, cap at 25 words
      if (narrative) {
        // Strip any "Here is…" or "Sure…" preamble the AI might add
        narrative = narrative.replace(/^(?:here(?:'s| is)[^:]*:|sure[,!.]?\s*)/i, "").trim();
        // Take first sentence only (split on sentence-ending punctuation followed by space/end)
        const firstSentence = narrative.match(/^[^.!?]*[.!?]/);
        if (firstSentence) narrative = firstSentence[0].trim();
        // Hard word cap
        const words = narrative.split(/\s+/);
        if (words.length > 25) narrative = words.slice(0, 25).join(" ") + "…";
      }
    } catch (err) {
      console.error(`${MODULE_ID} | AI crit/fumble narrative failed:`, err);
    }
    if (!narrative) {
      narrative = type === "crit"
        ? `${actorName} lands a devastating blow with ${weapon}!`
        : `${actorName}'s attack with ${weapon} goes spectacularly wrong!`;
    }

    // 3. Optional extra save prompt for fumbles (30% chance, only when none already in mechText)
    const fumbleSave = type === "fumble" ? this._generateFumbleSave(mechText) : null;

    // 4. Build and post a styled ChatMessage visible to all players
    const isCrit     = type === "crit";
    const accent     = isCrit ? "#b8860b"                  : "#9b2020";  // dark gold / dark red — readable on any bg
    const borderL    = isCrit ? "4px solid #c9a84c"        : "4px solid #c43b3b";
    const emoji      = isCrit ? "🎯" : "💥";
    const evtLabel   = isCrit ? "CRITICAL HIT" : "FUMBLE";

    // Dark-parchment card — high-contrast regardless of Foundry chat theme
    let html =
      `<div style="background:#1c150e;border-left:${borderL};border-radius:4px;` +
      `padding:8px 10px;line-height:1.6;font-family:'IM Fell English','Palatino Linotype',serif;">` +
      `<div style="color:${isCrit ? "#c9a84c" : "#e06060"};font-weight:bold;font-size:1.05em;` +
      `margin-bottom:4px;letter-spacing:0.5px;">${emoji} ${evtLabel} — ${actorName}</div>` +
      `<div style="font-style:italic;color:#eddfc5;margin-bottom:${showMech ? "8px" : "2px"};">` +
      `"${narrative}"</div>`;

    if (showMech) {
      const dividerColor = isCrit ? "rgba(201,168,76,0.3)" : "rgba(196,59,59,0.3)";
      html +=
        `<hr style="border:none;border-top:1px solid ${dividerColor};margin:4px 0 6px;">` +
        `<div style="font-size:0.87em;color:#b89a6e;">${mechHTML}</div>`;
    }

    if (fumbleSave) {
      html +=
        `<div style="margin-top:6px;padding:4px 6px;background:rgba(196,59,59,0.18);border-radius:3px;` +
        `font-size:0.85em;color:#d08080;">⚠️ ${fumbleSave}</div>`;
    }

    // ── Rollable / Apply buttons ─────────────────────────────────
    if (showMech) {
      const savePlainText = fumbleSave ? fumbleSave.replace(/<[^>]+>/g, "") : "";
      const combinedText  = mechText + (savePlainText ? " " + savePlainText : "");
      const btns = AcePanel._parseMechButtons(combinedText, isCrit, actor?.uuid ?? "");
      if (btns.length) {
        html += `<div class="ace-chat-btns" style="display:flex;flex-direction:column;gap:4px;margin-top:8px;">` +
          btns.map(b =>
            `<button class="ace-chat-btn ${b.cls}" ${b.data} ` +
            `style="display:block;width:100%;padding:5px 10px;border-radius:3px;cursor:pointer;` +
            `font-family:'IM Fell English','Palatino Linotype',serif;font-size:0.88em;text-align:left;">` +
            `${b.label}</button>`
          ).join("") +
          `</div>`;
      }
    }

    html += `</div>`;

    try {
      await ChatMessage.create({
        content: html,
        speaker: { alias: "ACE" },
        flags:   { "ace-engine": { isCritFumble: true, type: "critfumble" } },
      });
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to post crit/fumble chat message:`, err);
    }

    // 5. Speak via TTS narrator — just the dramatic line, not the mechanic text
    const ttsText = `${evtLabel}! ${narrative}`;
    this._speakText(ttsText, undefined, { broadcast: true });

    // 5b. Push to ACE Narration log so the GM can see it in the panel
    const lkEntry = `${emoji} **${evtLabel} — ${actorName}**: "${narrative}"${showMech ? "\n\n" + mechText : ""}`;
    this._narrationHistory.push({ content: lkEntry, timestamp: Date.now() });
    this._refreshNarrationUI();
    this._scrollNarrationToBottom();

    // 6. Mirror the result in the panel Encounter tab (if the panel is open)
    const cfCls = isCrit ? "ace-cf-crit" : "ace-cf-fumble";
    if (this.rendered) {
      const container = this.element?.querySelector("#ace-cf-result");
      if (container) {
        container.style.display = "";
        container.className     = `ace-cf-result ${cfCls}`;
        container.innerHTML     =
          `<div class="ace-cf-header">` +
          `<span class="ace-cf-type-label">${isCrit ? "🎯 Critical Hit" : "💥 Fumble"}` +
          `<span class="ace-cf-roll-num">d${table.length}: ${idx + 1}</span></span>` +
          `<div class="ace-msg-actions"><button class="ace-icon-btn" data-action="copyCritFumble" title="Copy">` +
          `<i class="fas fa-copy"></i></button></div></div>` +
          mechHTML;
        this._lastCfHtml  = container.innerHTML;
        this._lastCfClass = cfCls;
        container.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      }
    } else {
      // Panel not open — still cache so it shows when panel opens
      this._lastCfHtml  =
        `<div class="ace-cf-header">` +
        `<span class="ace-cf-type-label">${isCrit ? "🎯 Critical Hit" : "💥 Fumble"}` +
        `<span class="ace-cf-roll-num">d${table.length}: ${idx + 1}</span></span>` +
        `<div class="ace-msg-actions"><button class="ace-icon-btn" data-action="copyCritFumble" title="Copy">` +
        `<i class="fas fa-copy"></i></button></div></div>` +
        mechHTML;
      this._lastCfClass = cfCls;
    }
  }

  // ── Mechanic Button Parsers ─────────────────────────────────

  /**
   * Parse mechText for rollable / applicable mechanics.
   * Returns an array of button specs: { cls, label, data }.
   *
   * @param {string}  mechText   - Strip-tagged plain text of the mechanic line
   * @param {boolean} isCrit     - true = crit (target saves); false = fumble (actor saves)
   * @param {string}  actorUuid  - UUID of the acting actor (fumble save fallback)
   */
  static _parseMechButtons(mechText, isCrit, actorUuid = "") {
    const btns   = [];
    const hasSave = /DC\s*\d+\s+(?:Str|Dex|Con|Int|Wis|Cha)/i.test(mechText);

    // ── Saving throws ─────────────────────────────────────────────
    const saveRe = /DC\s*(\d+)\s+(Str(?:ength)?|Dex(?:terity)?|Con(?:stitution)?|Int(?:elligence)?|Wis(?:dom)?|Cha(?:risma)?)\s+save/gi;
    let m;
    while ((m = saveRe.exec(mechText)) !== null) {
      const dc      = parseInt(m[1]);
      const ability = m[2].slice(0, 3).toLowerCase();
      const abUp    = ability.toUpperCase();
      // Crits: TARGET saves — no default actor. Fumbles: ACTOR saves — use actorUuid as fallback.
      const uuid    = isCrit ? "" : actorUuid;
      const afterSave = mechText.slice(m.index + m[0].length);
      const condition = AcePanel._extractConditionFromText(afterSave);
      btns.push({
        cls:  "ace-chat-btn-save",
        label: `🎲 ${abUp} Save (DC ${dc})`,
        data: `data-ace-btn="save" data-ability="${ability}" data-dc="${dc}" data-condition="${condition}" data-actor-uuid="${uuid}"`,
      });
      if (condition) {
        const condLabel = condition.charAt(0).toUpperCase() + condition.slice(1);
        btns.push({
          cls:  "ace-chat-btn-cond",
          label: `🔴 Apply: ${condLabel}`,
          data: `data-ace-btn="condition" data-condition="${condition}"`,
        });
      }
    }

    // ── Damage dice ───────────────────────────────────────────────
    const dmgRe = /\+?(\d+d\d+(?:[+-]\d+)?)\s*(fire|cold|lightning|thunder|poison|acid|necrotic|radiant|psychic|force|bludgeoning|piercing|slashing)?\s*damage/gi;
    while ((m = dmgRe.exec(mechText)) !== null) {
      const formula = m[1];
      const dmgType = (m[2] || "untyped").toLowerCase();
      const typeStr = dmgType !== "untyped" ? ` ${dmgType}` : "";
      btns.push({
        cls:  "ace-chat-btn-dmg",
        label: `🎲 Roll ${formula}${typeStr} damage`,
        data: `data-ace-btn="damage" data-formula="${formula}" data-damage-type="${dmgType}"`,
      });
    }

    // ── Flat self-damage ("take N damage") ────────────────────────
    const flatRe = /\btake\s+(\d+)\s+(?:\w+\s+)?damage/gi;
    while ((m = flatRe.exec(mechText)) !== null) {
      btns.push({
        cls:  "ace-chat-btn-cond",
        label: `💥 Apply ${m[1]} damage (self)`,
        data: `data-ace-btn="apply-damage" data-total="${m[1]}" data-damage-type="untyped" data-self="1"`,
      });
    }

    // ── Healing ("regain Xd6 hit points") ────────────────────────
    const healRe = /regain\s+(\d+d\d+)\s+hit\s+points?/gi;
    while ((m = healRe.exec(mechText)) !== null) {
      btns.push({
        cls:  "ace-chat-btn-heal",
        label: `💚 Roll ${m[1]} healing`,
        data: `data-ace-btn="heal" data-formula="${m[1]}" data-actor-uuid="${actorUuid}"`,
      });
    }

    // ── Direct prone (no save required) ──────────────────────────
    if (/fall\s+prone|falls?\s+prone/i.test(mechText) && !hasSave) {
      btns.push({
        cls:  "ace-chat-btn-cond",
        label: `⬇️ Apply: Prone`,
        data: `data-ace-btn="condition" data-condition="prone"`,
      });
    }

    // ── Exhaustion (no save) ──────────────────────────────────────
    if (/\bexhaustion\b/i.test(mechText) && !hasSave) {
      btns.push({
        cls:  "ace-chat-btn-cond",
        label: `😵 Apply: Exhaustion (1 level)`,
        data: `data-ace-btn="condition" data-condition="exhaustion"`,
      });
    }

    return btns;
  }

  /**
   * Find a known condition keyword in text that follows a save clause,
   * so the Save button knows what condition to pair with an Apply button.
   * @returns {string} condition id, or "" if none found
   */
  static _extractConditionFromText(text) {
    const map = {
      stunned:       /\bstunned\b/i,
      prone:         /\bfall(?:s)?\s+prone\b|\bknocked\s+prone\b/i,
      frightened:    /\bfrightened\b/i,
      incapacitated: /\bincapacitated\b/i,
      blinded:       /\bblinded\b/i,
      paralyzed:     /\bparalyzed\b/i,
      charmed:       /\bcharmed\b/i,
      poisoned:      /\bpoisoned\b/i,
      exhaustion:    /\bexhaustion\b/i,
    };
    for (const [id, re] of Object.entries(map)) {
      if (re.test(text)) return id;
    }
    return "";
  }

  /**
   * Returns an extra save flavor prompt for fumbles (30% chance),
   * or null if the mechanical result already contains a save.
   */
  _generateFumbleSave(mechText) {
    if (/save|saving throw/i.test(mechText)) return null;   // already has one
    if (Math.random() >= 0.3) return null;
    const opts = [
      "Make a <strong>DC 10 Dexterity save</strong> or stumble into an adjacent ally's space.",
      "Make a <strong>DC 11 Constitution save</strong> or lose your reaction until the start of your next turn.",
      "Make a <strong>DC 12 Strength save</strong> or your grip fails and your weapon drops to your feet.",
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  // ── Interactive Encounter System ─────────────────────────────

  /**
   * Parse raw AI-generated encounter markdown into a structured object.
   * @param {string} raw — the full markdown text from the AI
   * @returns {object} parsed encounter data
   */
  _parseEncounterMarkdown(raw) {
    const data = {
      title: "", hook: "", setup: "", creatures: [],
      terrain: "", tactics: "", readAloud: "", treasure: "",
      scalingHarder: "", scalingEasier: "", rawMarkdown: raw,
    };

    // Split by ### headers (level 3) — keep the header text as keys
    const sections = {};
    let currentKey = "_preamble";
    for (const line of raw.split("\n")) {
      const h3 = line.match(/^###\s+(.+)/);
      const h2 = line.match(/^##\s+(.+)/);
      if (h2) {
        // Title line: "## Whispers of the Guardians"
        data.title = h2[1].trim();
        currentKey = "_title";
      } else if (h3) {
        currentKey = h3[1].trim().toLowerCase();
      }
      if (!sections[currentKey]) sections[currentKey] = [];
      sections[currentKey].push(line);
    }

    // Hook — the italic line right after the title
    const titleLines = sections["_title"] ?? [];
    for (const l of titleLines) {
      const m = l.match(/^\*(.+)\*$/);
      if (m) { data.hook = m[1].trim(); break; }
    }

    // Setup
    data.setup = this._extractSectionText(sections, "setup");

    // Enemies — extract "Quantity × Name" patterns
    const enemyText = (sections["enemies"] ?? []).join("\n");
    // Pattern 1: "2 × Shadow" or "2 x Shadow" or "2x Shadow"
    const creatureRe1 = /\*?\*?(\d+)\s*[×xX]\s*(.+?)\*?\*?\s*$/gm;
    // Pattern 2: "- **2 × Shadow**" markdown list format
    const creatureRe2 = /[-*]\s+\*?\*?(\d+)\s*[×xX]\s*(.+?)\*?\*?\s*$/gm;
    let matched = false;
    let m;
    while ((m = creatureRe1.exec(enemyText)) !== null) {
      const name = m[2].replace(/\*+/g, "").replace(/\(.*?\)/, "").trim();
      if (name) { data.creatures.push(this._makeCreatureEntry(name, parseInt(m[1]))); matched = true; }
    }
    if (!matched) {
      while ((m = creatureRe2.exec(enemyText)) !== null) {
        const name = m[2].replace(/\*+/g, "").replace(/\(.*?\)/, "").trim();
        if (name) { data.creatures.push(this._makeCreatureEntry(name, parseInt(m[1]))); matched = true; }
      }
    }
    if (!matched) {
      // Fallback: try to extract creature names from list items
      const listRe = /[-*]\s+\*?\*?(\d+)?\s*(.+?)(?:\*?\*?)?\s*$/gm;
      while ((m = listRe.exec(enemyText)) !== null) {
        let name = m[2].replace(/\*+/g, "").replace(/\(.*?\)/, "").trim();
        // Skip lines that look like stat descriptions not creature names
        if (/^(HP|AC|Type|Main|Special|Key)/i.test(name)) continue;
        if (name.length < 2 || name.length > 60) continue;
        const qty = m[1] ? parseInt(m[1]) : 1;
        data.creatures.push(this._makeCreatureEntry(name, qty));
      }
    }

    // Terrain & Positioning
    data.terrain = this._extractSectionText(sections, "terrain & positioning") ||
                   this._extractSectionText(sections, "terrain");

    // Tactics
    data.tactics = this._extractSectionText(sections, "tactics");

    // Read-Aloud Text — extract blockquote content
    const raLines = sections["read-aloud text"] ?? sections["read-aloud"] ?? [];
    const bqLines = [];
    for (const l of raLines) {
      const bq = l.match(/^>\s*(.*)/);
      if (bq) bqLines.push(bq[1].replace(/^\*|\*$/g, "").trim());
    }
    data.readAloud = bqLines.join(" ").trim();

    // Treasure & Rewards
    data.treasure = this._extractSectionText(sections, "treasure & rewards") ||
                    this._extractSectionText(sections, "treasure");

    // Scaling
    const scaleText = this._extractSectionText(sections, "scaling");
    const harderMatch = scaleText.match(/\*?\*?Too easy\??\*?\*?\s*(.+?)(?=\*?\*?Too hard|$)/si);
    const easierMatch = scaleText.match(/\*?\*?Too hard\??\*?\*?\s*(.+)/si);
    data.scalingHarder = harderMatch ? harderMatch[1].trim() : "";
    data.scalingEasier = easierMatch ? easierMatch[1].trim() : "";

    return data;
  }

  _makeCreatureEntry(name, quantity) {
    return { name, quantity, found: null, uuid: null, img: null, cr: null, hp: null, ac: null, placed: 0 };
  }

  _extractSectionText(sections, key) {
    const lines = sections[key];
    if (!lines) return "";
    return lines
      .filter(l => !l.match(/^###\s/))  // skip the header itself
      .join("\n")
      .trim();
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /*  Compendium Search                                                          */
  /* ──────────────────────────────────────────────────────────────────────────── */

  /**
   * Search all Actor-type compendium packs for a creature by name.
   * Returns the first match with basic stats.
   * @param {string} name
   * @returns {Promise<object|null>}
   */
  async _searchCompendiumCreature(name) {
    const baseName = name.toLowerCase().trim();

    // ── Alias resolution ──────────────────────────────────────
    // D&D NPCs frequently have a "common" name in lore but a different
    // canonical name in the official stat block. AIs (and GMs) tend to
    // use the lore name, but compendiums store the canonical one. The
    // map below converts the lore name into the canonical name (or
    // a set of alternates to try in order) so the search hits.
    //
    // Most common offender: Illithid → Mind Flayer. The AI generates
    // "Illithid" all day, but the actor in every Monster Manual / SRD
    // pack is named "Mind Flayer." Without this map, every Illithid
    // encounter card shows the orange "Not found in compendiums" stub.
    const CREATURE_NAME_ALIASES = {
      "illithid":          ["mind flayer", "mind flayer arcanist"],
      "mind flayer":       ["mind flayer", "illithid"],
      "tarrasque":         ["tarrasque"],
      "lich king":         ["lich"],
      "demilich":          ["demilich", "lich"],
      "vampire spawn":     ["vampire spawn"],
      "wererat":           ["wererat"],
      "werewolf":          ["werewolf"],
      "kraken":            ["kraken"],
      "dragon turtle":     ["dragon turtle"],
      "displacer beast":   ["displacer beast"],
      "beholder":          ["beholder", "spectator"],
      "spectator":         ["spectator", "beholder"],
      "drow":              ["drow", "drow elite warrior", "drow mage"],
      "duergar":           ["duergar"],
      "deep gnome":        ["deep gnome", "svirfneblin"],
      "svirfneblin":       ["svirfneblin", "deep gnome"],
      "githyanki":         ["githyanki warrior", "githyanki knight"],
      "githzerai":         ["githzerai monk", "githzerai zerth"],
      "kuo-toa":           ["kuo-toa"],
      "kuo toa":           ["kuo-toa"],
      "yuan-ti":           ["yuan-ti pureblood", "yuan-ti malison"],
      "yuan ti":           ["yuan-ti pureblood", "yuan-ti malison"],
      "owl bear":          ["owlbear"],
      "owlbear":           ["owlbear", "owl bear"],
      "hell hound":        ["hell hound"],
      "hellhound":         ["hell hound"],
      "devil dog":         ["hell hound"],
    };

    // Build the lookup list — alias hits first (in order), then the
    // original name as a fallback.
    const aliasList = CREATURE_NAME_ALIASES[baseName] ?? null;
    const candidates = aliasList ? [...aliasList, baseName] : [baseName];

    // Dedupe while preserving order
    const lookups = [...new Set(candidates)];

    // Also strip common monster adjectives ("Adult Red Dragon" → "Red Dragon")
    // as a LAST-resort try.
    const ADJ_RE = /^(adult|young|ancient|wyrmling|elder|greater|lesser|gnoll|dire|giant|swarm of)\s+/i;
    const stripped = baseName.replace(ADJ_RE, "").trim();
    if (stripped && stripped !== baseName) lookups.push(stripped);

    let bestMatch = null;

    for (const pack of game.packs) {
      if (pack.documentName !== "Actor") continue;

      // Get or cache the index
      let index;
      const cached = this._compendiumIndexCache.get(pack.collection);
      if (cached && Date.now() - cached.time < this._compendiumCacheTTL) {
        index = cached.index;
      } else {
        try {
          index = await pack.getIndex({
            fields: [
              "system.details.cr", "system.attributes.hp.max",
              "system.attributes.ac.flat", "system.attributes.ac.value",
              "prototypeToken.texture.src",
            ],
          });
          this._compendiumIndexCache.set(pack.collection, { index, time: Date.now() });
        } catch (err) { console.debug("ace-engine | Panel compendium index build failed:", err); continue; }
      }

      // Exact match (case-insensitive) — try every lookup variant in order
      for (const variant of lookups) {
        for (const entry of index) {
          if (entry.name.toLowerCase() === variant) {
            return this._buildCreatureResult(pack, entry);
          }
        }
      }

      // Partial match — substring either direction. Try every variant.
      if (!bestMatch) {
        for (const variant of lookups) {
          for (const entry of index) {
            const entryLower = entry.name.toLowerCase();
            if (entryLower.includes(variant) || variant.includes(entryLower)) {
              bestMatch = this._buildCreatureResult(pack, entry);
              break;
            }
          }
          if (bestMatch) break;
        }
      }
    }

    // Also check world actors (with alias support)
    for (const variant of lookups) {
      const worldActor = game.actors?.find(a => a.name.toLowerCase() === variant);
      if (worldActor) {
        return {
          uuid:  worldActor.uuid,
          name:  worldActor.name,
          img:   worldActor.prototypeToken?.texture?.src || worldActor.img,
          cr:    worldActor.system?.details?.cr ?? null,
          hp:    worldActor.system?.attributes?.hp?.max ?? null,
          ac:    worldActor.system?.attributes?.ac?.value ?? worldActor.system?.attributes?.ac?.flat ?? null,
        };
      }
    }

    return bestMatch;  // may be null
  }

  _buildCreatureResult(pack, entry) {
    const sys = entry.system ?? {};
    // Foundry v13 UUID format: Compendium.{collection}.Actor.{id}
    // Index entries may have .uuid already; otherwise build it manually
    const uuid = entry.uuid ?? `Compendium.${pack.collection}.Actor.${entry._id}`;
    return {
      uuid,
      name:  entry.name,
      img:   entry.prototypeToken?.texture?.src || entry.img || "icons/svg/mystery-man.svg",
      cr:    sys.details?.cr ?? null,
      hp:    sys.attributes?.hp?.max ?? null,
      ac:    sys.attributes?.ac?.value ?? sys.attributes?.ac?.flat ?? null,
    };
  }

  /**
   * Resolve all creatures in the encounter data against compendiums.
   * @param {object} encounterData
   */
  async _resolveEncounterCreatures(encounterData) {
    for (const creature of encounterData.creatures) {
      const result = await this._searchCompendiumCreature(creature.name);
      if (result) {
        creature.found = true;
        creature.uuid  = result.uuid;
        creature.img   = result.img;
        creature.cr    = result.cr;
        creature.hp    = result.hp;
        creature.ac    = result.ac;
        creature.name  = result.name;  // use canonical name from compendium
      } else {
        creature.found = false;
      }
    }
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /*  Interactive Encounter Renderer                                             */
  /* ──────────────────────────────────────────────────────────────────────────── */

  /**
   * Render the parsed encounter data as interactive HTML.
   * @param {object} data — the structured encounter object
   * @returns {string} HTML
   */
  _renderInteractiveEncounter(data) {
    const parts = [];

    // ── Title & Hook ──
    parts.push(`<div class="ace-enc-header">
      <h3 class="ace-enc-title"><i class="fas fa-swords"></i> ${this._escapeHtml(data.title || "Encounter")}</h3>
      ${data.hook ? `<p class="ace-enc-hook"><em>${this._escapeHtml(data.hook)}</em></p>` : ""}
    </div>`);

    // ── Setup (collapsible) ──
    if (data.setup) {
      parts.push(`<details class="ace-enc-section" open>
        <summary><i class="fas fa-scroll"></i> Setup</summary>
        <div class="ace-enc-section-body">${this._renderMarkdown(data.setup)}</div>
      </details>`);
    }

    // ── Creatures ──
    parts.push(this._renderEncounterCreatures(data));

    // ── Terrain & Tactics (collapsible, combined) ──
    const terrainTactics = [data.terrain, data.tactics].filter(Boolean).join("\n\n");
    if (terrainTactics) {
      parts.push(`<details class="ace-enc-section">
        <summary><i class="fas fa-map"></i> Terrain & Tactics</summary>
        <div class="ace-enc-section-body">${this._renderMarkdown(terrainTactics)}</div>
      </details>`);
    }

    // ── Read-Aloud ──
    if (data.readAloud) {
      const safeText = this._escapeHtml(data.readAloud);
      const clipText = data.readAloud.replace(/'/g, "\\'").replace(/"/g, "&quot;");
      parts.push(`<div class="ace-enc-read-aloud-section">
        <div class="ace-enc-section-label"><i class="fas fa-book-open-reader"></i> Read-Aloud</div>
        <blockquote class="ace-enc-blockquote"><em>${safeText}</em></blockquote>
        <div class="ace-enc-read-aloud-actions">
          <button class="ace-btn ace-enc-copy-btn"
                  onclick="navigator.clipboard.writeText('${clipText}').then(()=>{this.innerHTML='<i class=\\'fas fa-check\\'></i> Copied';setTimeout(()=>{this.innerHTML='<i class=\\'fas fa-copy\\'></i> Copy'},1500)})">
            <i class="fas fa-copy"></i> Copy
          </button>
          <button class="ace-btn ace-enc-narrate-btn" data-action="narrateEncounter">
            <i class="fas fa-bullhorn"></i> Narrate
          </button>
        </div>
      </div>`);
    }

    // ── Treasure (collapsible) ──
    if (data.treasure) {
      parts.push(`<details class="ace-enc-section">
        <summary><i class="fas fa-gem"></i> Treasure & Rewards</summary>
        <div class="ace-enc-section-body">${this._renderMarkdown(data.treasure)}</div>
      </details>`);
    }

    // ── Scaling Buttons ──
    if (data.scalingHarder || data.scalingEasier) {
      parts.push(`<div class="ace-enc-scaling">
        <div class="ace-enc-scale-bar">
          <button class="ace-btn ace-enc-scale-up" data-action="encounterScaleUp" title="${this._escapeHtml(data.scalingHarder)}">
            <i class="fas fa-arrow-up"></i> Make Harder
          </button>
          <button class="ace-btn ace-enc-scale-down" data-action="encounterScaleDown" title="${this._escapeHtml(data.scalingEasier)}">
            <i class="fas fa-arrow-down"></i> Make Easier
          </button>
        </div>
        <div class="ace-enc-scaling-text">
          ${data.scalingHarder ? `<div class="ace-enc-scale-hint"><strong>Harder:</strong> ${this._escapeHtml(data.scalingHarder)}</div>` : ""}
          ${data.scalingEasier ? `<div class="ace-enc-scale-hint"><strong>Easier:</strong> ${this._escapeHtml(data.scalingEasier)}</div>` : ""}
        </div>
      </div>`);
    }

    return `<div class="ace-enc-interactive">${parts.join("")}</div>`;
  }

  /**
   * Render just the creature cards section. Called separately for re-rendering after scaling/placement.
   * @param {object} data — encounter data
   * @returns {string} HTML
   */
  _renderEncounterCreatures(data) {
    if (!data.creatures?.length) {
      return `<div class="ace-enc-creatures-section">
        <div class="ace-enc-section-label"><i class="fas fa-dragon"></i> Creatures</div>
        <p class="ace-muted">No creatures parsed from the encounter.</p>
      </div>`;
    }

    const rows = data.creatures.map((c, i) => {
      const remaining = c.quantity - c.placed;
      const allPlaced = remaining <= 0;
      const imgSrc    = c.img || "icons/svg/mystery-man.svg";
      const crLabel   = c.cr !== null ? `CR ${c.cr}` : "";
      const statsLine = [crLabel, c.hp ? `HP ${c.hp}` : "", c.ac ? `AC ${c.ac}` : ""].filter(Boolean).join(" · ");

      if (!c.found) {
        return `<div class="ace-enc-creature-row ace-enc-not-found" data-creature-idx="${i}">
          <div class="ace-enc-creature-img-wrap">
            <img class="ace-enc-creature-img" src="icons/svg/hazard.svg" alt="?">
          </div>
          <div class="ace-enc-creature-info">
            <span class="ace-enc-creature-name">${this._escapeHtml(c.name)}</span>
            <span class="ace-enc-creature-warn">⚠ Not found in compendiums</span>
          </div>
          <span class="ace-enc-quantity-badge">×${c.quantity}</span>
        </div>`;
      }

      return `<div class="ace-enc-creature-row${allPlaced ? " ace-enc-placed" : ""}"
                   data-creature-idx="${i}" data-uuid="${c.uuid || ""}"
                   draggable="${!allPlaced && c.uuid ? "true" : "false"}">
        <div class="ace-enc-creature-img-wrap">
          <img class="ace-enc-creature-img" src="${imgSrc}" alt="${this._escapeHtml(c.name)}">
        </div>
        <div class="ace-enc-creature-info">
          <span class="ace-enc-creature-name">${this._escapeHtml(c.name)}</span>
          <span class="ace-enc-creature-stats">${statsLine}</span>
        </div>
        <span class="ace-enc-quantity-badge${allPlaced ? " ace-enc-qty-done" : ""}">
          ${allPlaced ? "✅" : `×${remaining}`}
        </span>
        ${!allPlaced ? '<i class="fas fa-grip-vertical ace-enc-drag-handle"></i>' : ""}
      </div>`;
    }).join("");

    return `<div class="ace-enc-creatures-section" id="ace-enc-creatures">
      <div class="ace-enc-section-label"><i class="fas fa-dragon"></i> Creatures</div>
      ${rows}
    </div>`;
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /*  Drag-and-Drop + Placement Tracking                                         */
  /* ──────────────────────────────────────────────────────────────────────────── */

  /**
   * Wire the draggable gold divider between Scene Description and Encounter panes.
   * Stores the split ratio so it persists within the session.
   */
  _wireEncounterDivider() {
    const divider = this.element?.querySelector("#ace-enc-divider");
    const topPane = this.element?.querySelector("#ace-enc-pane-top");
    const botPane = this.element?.querySelector("#ace-enc-pane-bottom");
    const split   = this.element?.querySelector(".ace-encounter-split");
    if (!divider || !topPane || !botPane || !split) return;

    // Restore previous ratio if set
    if (this._encSplitRatio) {
      topPane.style.flex = `0 0 ${this._encSplitRatio * 100}%`;
      botPane.style.flex = `1 1 auto`;
    }

    let startY = 0, startTopH = 0, totalH = 0;

    const onMove = (e) => {
      const dy = e.clientY - startY;
      const newTopH = Math.max(60, Math.min(totalH - 100, startTopH + dy));
      const ratio = newTopH / totalH;
      topPane.style.flex = `0 0 ${ratio * 100}%`;
      this._encSplitRatio = ratio;
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      split.classList.remove("ace-resizing");
    };

    divider.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startY = e.clientY;
      startTopH = topPane.getBoundingClientRect().height;
      totalH = split.getBoundingClientRect().height;
      split.classList.add("ace-resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  /**
   * Wire drag events on creature cards after rendering.
   * Must be called after the interactive encounter HTML is injected into the DOM.
   */
  _wireEncounterDragDrop() {
    const rows = this.element?.querySelectorAll(".ace-enc-creature-row[draggable='true']");
    if (!rows?.length) return;

    for (const row of rows) {
      row.addEventListener("dragstart", (ev) => {
        const uuid = row.dataset.uuid;
        if (!uuid) return;
        const dragData = { type: "Actor", uuid };
        ev.dataTransfer.setData("text/plain", JSON.stringify(dragData));
        ev.dataTransfer.effectAllowed = "copy";
        row.classList.add("ace-enc-dragging");
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("ace-enc-dragging");
      });
    }
  }

  /**
   * Called by the createToken hook. Checks if the created token matches an encounter creature.
   * @param {TokenDocument} tokenDoc
   */
  _onTokenCreatedForEncounter(tokenDoc) {
    if (!this._encounterData?.creatures?.length) return;
    if (!game.user.isGM) return;

    const actorName = tokenDoc.name?.toLowerCase() || tokenDoc.actor?.name?.toLowerCase();
    if (!actorName) return;

    for (const creature of this._encounterData.creatures) {
      if (!creature.found) continue;
      if (creature.placed >= creature.quantity) continue;
      if (creature.name.toLowerCase() === actorName) {
        creature.placed++;
        // Re-render just the creature section
        const container = this.element?.querySelector("#ace-enc-creatures");
        if (container) {
          container.outerHTML = this._renderEncounterCreatures(this._encounterData);
          this._wireEncounterDragDrop();
        }
        break;
      }
    }
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /*  Narrate Text (reusable)                                                    */
  /* ──────────────────────────────────────────────────────────────────────────── */

  /**
   * Send text directly as a narration — posts to chat, logs, speaks via TTS.
   * Extracted from _narrateSendMessage() for reuse by encounter narrate button.
   * @param {string} text — the narration text
   */
  async _narrateText(text) {
    if (!text) return;

    const voiceGender = this._resolveVoiceGender(text);
    text = text.replace(/^\[voice:(male|female)\]\s*/i, "");

    const safe = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const content =
      `<div style="border-left:3px solid #c9a84c;padding:6px 12px;margin:0;` +
      `background:rgba(201,168,76,0.07);border-radius:0 4px 4px 0;">` +
      `<span style="display:block;font-size:10px;color:#c9a84c;text-transform:uppercase;` +
      `letter-spacing:1px;margin-bottom:4px;font-weight:bold;">📜 Narration</span>` +
      `<span style="font-style:italic;line-height:1.5;">${safe}</span></div>`;

    await ChatMessage.create({
      content,
      speaker: { alias: "ACE" },
      flags:   { "ace-engine": { isNarration: true } },
    });

    this._narrationHistory.push({ content: text, timestamp: Date.now() });
    this._refreshNarrationUI();
    this._scrollNarrationToBottom();
    this.lkMemory?.logNarration(text);

    // Narrative time cues
    try {
      const enableTime = game.settings.get("ace-engine", "enableNarrativeTime");
      if (enableTime && this.lkMemory) {
        const cues = AcePanel._parseNarrativeTimeCues(text);
        if (cues) {
          if (cues.advanceDays) {
            this.lkMemory.advanceDay(cues.advanceDays, cues.timeOfDay ?? "morning");
          } else if (cues.timeOfDay) {
            this.lkMemory.setTimeOfDay(cues.timeOfDay);
          }
          this._updateDayCounterUI();
        }
      }
    } catch (_) { /* non-critical */ }

    this._speakText(text, voiceGender, { broadcast: true });
  }

  /* ──────────────────────────────────────────────────────────────────────────── */
  /*  Encounter Action Handlers                                                  */
  /* ──────────────────────────────────────────────────────────────────────────── */

  /**
   * 📢 Narrate the encounter read-aloud text to players.
   */
  static _onNarrateEncounter(event, target) {
    if (!this._encounterData?.readAloud) {
      ui.notifications?.warn("ACE: No read-aloud text in the current encounter.");
      return;
    }
    this._narrateText(this._encounterData.readAloud);
  }

  /**
   * ⬆ Make Harder — add one minion, boost boss HP.
   */
  static _onEncounterScaleUp(event, target) {
    const data = this._encounterData;
    if (!data?.creatures?.length) return;

    // Find lowest-CR creature (the minions) and add one
    const sorted = [...data.creatures].sort((a, b) => (a.cr ?? 0) - (b.cr ?? 0));
    const minion = sorted[0];
    minion.quantity++;

    // Boost highest-CR creature HP by 20%
    const boss = sorted[sorted.length - 1];
    if (boss.hp) boss.hp = Math.ceil(boss.hp * 1.2);

    // Re-render creature section
    const container = this.element?.querySelector("#ace-enc-creatures");
    if (container) {
      container.outerHTML = this._renderEncounterCreatures(data);
      this._wireEncounterDragDrop();
    }

    // Update cached HTML
    this._lastEncounterHtml = this.element?.querySelector("#ace-encounter")?.innerHTML ?? "";
    ui.notifications?.info(`ACE: Made harder — +1 ${minion.name}${boss.hp ? `, ${boss.name} HP → ${boss.hp}` : ""}`);
  }

  /**
   * ⬇ Make Easier — remove one minion, reduce all HP.
   */
  static _onEncounterScaleDown(event, target) {
    const data = this._encounterData;
    if (!data?.creatures?.length) return;

    // Find creature with highest quantity and reduce by 1 (min 1)
    const sorted = [...data.creatures].sort((a, b) => b.quantity - a.quantity);
    const target_ = sorted[0];
    if (target_.quantity > 1) target_.quantity--;

    // Reduce all HP by 20%
    for (const c of data.creatures) {
      if (c.hp) c.hp = Math.max(1, Math.floor(c.hp * 0.8));
    }

    // Re-render
    const container = this.element?.querySelector("#ace-enc-creatures");
    if (container) {
      container.outerHTML = this._renderEncounterCreatures(data);
      this._wireEncounterDragDrop();
    }

    this._lastEncounterHtml = this.element?.querySelector("#ace-encounter")?.innerHTML ?? "";
    ui.notifications?.info(`ACE: Made easier — ${target_.name} ×${target_.quantity}, all HP reduced 20%`);
  }

  // ── Crit / Fumble Table ─────────────────────────────────────

  // ── Crit Table (d20) — fun, memorable, mostly harmless ────────

  static CRIT_TABLE = [
    /* 1 */  "Your weapon sings true — deal <strong>maximum damage dice</strong> (no roll needed).",
    /* 2 */  "The blow lands in a gap in their armor. <strong>Ignore all AC bonuses from armor</strong> for this hit.",
    /* 3 */  "Ringing blow to the head! Target makes a <strong>DC 14 Con save or is stunned</strong> until end of their next turn.",
    /* 4 */  "Knockback! Target is shoved <strong>10 feet and must succeed a DC 13 Str save or fall prone</strong>.",
    /* 5 */  "Precise strike — <strong>double the number of damage dice</strong> rolled.",
    /* 6 */  "Inspiring hit! You <strong>regain 1d6 hit points</strong> from the rush of battle.",
    /* 7 */  "Battle cry! <strong>All allies within 30 feet gain advantage</strong> on their very next attack roll.",
    /* 8 */  "Perfect form! You may <strong>make one extra attack as a bonus action</strong> this turn.",
    /* 9 */  "The enemy's grip fails — they <strong>drop one held item of your choice</strong> (lands at their feet).",
    /* 10 */ "Momentum strike! You may immediately <strong>move up to 10 feet</strong> without provoking opportunity attacks.",
    /* 11 */ "Visceral hit! Target must make a <strong>DC 12 Wis save or be frightened</strong> of you until end of their next turn.",
    /* 12 */ "The blow exposes a weakness — <strong>target's AC is reduced by 2</strong> until the start of their next turn.",
    /* 13 */ "Reverb of steel! All enemies within 10 feet take <strong>1d4 thunder damage</strong> from the shockwave.",
    /* 14 */ "Heroic moment! One nearby ally may immediately use their reaction to <strong>take an extra action</strong>.",
    /* 15 */ "Your next attack this turn has <strong>advantage</strong> — the opening is right there.",
    /* 16 */ "Critical injury — choose a dramatic effect: <em>weapon arm numbed, cracked shield, limp, or dropped item</em>. Works narratively.",
    /* 17 */ "Eyes of the warrior — target <strong>loses their reaction</strong> for this round (they didn't see that coming).",
    /* 18 */ "The target gains <strong>one level of exhaustion</strong> (or is incapacitated until end of their next turn for minor foes).",
    /* 19 */ "Perfect execution! Add <strong>+1d8 damage</strong> of your weapon's type as a finishing flourish.",
    /* 20 */ "<strong>LEGENDARY STRIKE.</strong> Maximum damage plus double damage dice. The battlefield goes momentarily silent. Everyone saw that.",
  ];

  // ── Fumble Table (d20) — funny, harmless, memorable ──────────

  static FUMBLE_TABLE = [
    /* 1 */  "Boot slips on debris. Make a <strong>DC 10 Dex save or fall prone</strong>. Getting up costs half movement next turn.",
    /* 2 */  "Wild swing — you miss and stumble 5 feet <strong>toward your target</strong>. At least you look committed.",
    /* 3 */  "Your battle cry comes out as an <strong>undignified squeak</strong>. Enemies have advantage on their next attack against you (from laughing).",
    /* 4 */  "Attack goes wide and <strong>knocks over a torch/lantern/environmental prop</strong> nearby. Nothing catches fire. Probably.",
    /* 5 */  "You trip over your own feet. <strong>Fall prone.</strong> Getting up costs half your movement next turn.",
    /* 6 */  "Weapon briefly gets wedged in the floor/wall/scenery. Costs your <strong>bonus action to yank it free</strong>.",
    /* 7 */  "Sweat in your eyes! You have <strong>disadvantage on your next attack roll</strong>.",
    /* 8 */  "Your backswing nearly clips an ally — they have to duck and <strong>can't use their reaction</strong> this round.",
    /* 9 */  "Shield or off-hand item drops. It's fine, just needs picking up (<strong>object interaction</strong>).",
    /* 10 */ "Pulled muscle — take <strong>1 damage</strong> from the awkward lunge. Your pride takes more.",
    /* 11 */ "You lose your footing; the target takes a <strong>free 5-foot step away</strong> without provoking opportunity attacks.",
    /* 12 */ "Your footwork shifts you <strong>5 feet in a random direction</strong> (d8: 1=N, 2=NE… 8=NW). Hopefully nothing dangerous there.",
    /* 13 */ "Dramatic wobble! Must use <strong>bonus action to regain balance</strong> this turn.",
    /* 14 */ "Your weapon arm goes numb from the shock — <strong>weapon drops at your feet</strong>.",
    /* 15 */ "You accidentally look intimidating to your own side. <strong>One nearby ally must succeed a DC 8 Wis save</strong> or spend their move retreating from you.",
    /* 16 */ "You over-committed so hard the DM gives you the Leeroy Jenkins Award. Miss, lose bonus action, and everyone at the table must acknowledge you tried.",
    /* 17 */ "Your attack causes your weapon's pommel to <strong>smack yourself in the face</strong>. Take 1 bludgeoning damage. No save. Just. Wow.",
    /* 18 */ "Overextended reach — target may immediately take a <strong>free 5-foot step toward you</strong> and make one reaction attack.",
    /* 19 */ "SPECTACULAR STUMBLE — you pirouette and <strong>fall prone</strong>. But the form was *chef's kiss*. Award yourself style points.",
    /* 20 */ "<strong>LEGENDARY FUMBLE.</strong> Weapon launches 1d6×5 feet in a random direction. You fall prone. Your allies clap sarcastically. The enemies are confused. You are also confused.",
  ];

  // ── Narrative Time — keyword parsing ────────────────────────

  static _TIME_PATTERNS = [
    { regex: /\b(?:dawn|sunrise|morning|first light)\b/i,                    time: "morning" },
    { regex: /\b(?:midday|noon|high sun)\b/i,                                time: "midday" },
    { regex: /\bafternoon\b/i,                                               time: "afternoon" },
    { regex: /\b(?:evening|sunset|dusk|twilight)\b/i,                        time: "evening" },
    { regex: /\b(?:night|midnight|dark(?:ness)?|stars|moonlight|moonrise)\b/i, time: "night" },
  ];

  static _DAY_ADVANCE_PATTERNS = [
    { regex: /\b(?:next day|following day|next morning|the morning after)\b/i, days: 1 },
    { regex: /(\d+)\s*days?\s*(?:later|pass(?:ed)?|travel(?:ed)?|journey)/i,   daysCapture: 1 },
  ];

  /**
   * Parse narration text for time-of-day keywords and day advances.
   * @param {string} text
   * @returns {{ timeOfDay?: string, advanceDays?: number }|null}
   */
  static _parseNarrativeTimeCues(text) {
    if (!text || text.length < 3) return null;

    // Check for day advances first
    for (const pat of AcePanel._DAY_ADVANCE_PATTERNS) {
      const m = text.match(pat.regex);
      if (m) {
        const days = pat.daysCapture !== undefined ? parseInt(m[pat.daysCapture], 10) : pat.days;
        if (days > 0 && days <= 365) return { advanceDays: days, timeOfDay: "morning" };
      }
    }

    // Check for time-of-day keywords
    for (const pat of AcePanel._TIME_PATTERNS) {
      if (pat.regex.test(text)) return { timeOfDay: pat.time };
    }

    return null;
  }

  // ── Day Counter UI ──────────────────────────────────────────

  /** Build the day counter display HTML (inserted into survival bar). */
  _buildDayCounterHtml() {
    try {
      if (!game.settings.get("ace-engine", "enableNarrativeTime") || !this.lkMemory) return "";
    } catch (_) { return ""; }

    const day  = this.lkMemory.getDayCounter();
    const time = this.lkMemory.getTimeOfDay();
    const timeIcons = { morning: "🌅", midday: "☀️", afternoon: "🌤️", evening: "🌆", night: "🌙" };
    const icon = timeIcons[time] ?? "📅";

    // Show SC date if bridge is active, otherwise ACE day counter
    const scBridge = this.lkMemory._scBridge;
    const scDate   = scBridge?.getDisplayDate?.();
    const label    = scDate ? `${scDate}` : `Day ${day}`;

    return `
      <span class="ace-survival-sep">|</span>
      <button class="ace-day-btn ace-day-prev" data-action="dayPrev" title="Go back one day">◀</button>
      <span class="ace-day-chip" id="ace-day-chip" title="In-game day and approximate time">
        ${icon} ${label} <small>(${time})</small>
      </span>
      <button class="ace-day-btn ace-day-next" data-action="dayNext" title="Advance one day">▶</button>
    `;
  }

  /** Update the day counter chip without re-rendering the whole bar. */
  _updateDayCounterUI() {
    if (!this.element) return;
    const chip = this.element.querySelector("#ace-day-chip");
    if (!chip || !this.lkMemory) return;

    const day  = this.lkMemory.getDayCounter();
    const time = this.lkMemory.getTimeOfDay();
    const timeIcons = { morning: "🌅", midday: "☀️", afternoon: "🌤️", evening: "🌆", night: "🌙" };
    const icon = timeIcons[time] ?? "📅";

    // Show SC date if bridge is active, otherwise ACE day counter
    const scBridge = this.lkMemory._scBridge;
    const scDate   = scBridge?.getDisplayDate?.();
    const label    = scDate ? `${scDate}` : `Day ${day}`;

    chip.innerHTML = `${icon} ${label} <small>(${time})</small>`;
  }

  /** Day counter: go back one day. */
  static _onDayPrev(event, target) {
    if (!this.lkMemory) return;
    const current = this.lkMemory.getDayCounter();
    if (current <= 1) return;
    const newDay = Math.max(1, current - 1);
    // Directly set day counter (decrement)
    this.lkMemory.world._data.calendar.dayCounter = newDay;
    this.lkMemory.world._dirty = true;
    this.lkMemory._scheduleSave?.("world");
    // Push to Simple Calendar bridge (if active)
    this.lkMemory._scBridge?.pushDaySet(newDay, this.lkMemory.getTimeOfDay());
    this._updateDayCounterUI();
  }

  /** Day counter: advance one day. */
  static _onDayNext(event, target) {
    if (!this.lkMemory) return;
    this.lkMemory.advanceDay(1, this.lkMemory.getTimeOfDay());
    this._updateDayCounterUI();
    // Advancing a day implies the party rested — reset rest tracker
    this._tracker.scenesSinceRest = 0;
    this._tracker.restTime        = Date.now();
    this._restWarned8  = false;
    this._restWarned15 = false;
  }

  // ── Manual Deed Logger ──────────────────────────────────────

  /** Toggle the deed logger input area. */
  static _onToggleDeedLogger(event, target) {
    const container = this.element?.querySelector("#ace-deed-logger");
    if (!container) return;
    container.classList.toggle("ace-deed-hidden");
    if (!container.classList.contains("ace-deed-hidden")) {
      const input = container.querySelector("#ace-deed-input");
      if (input) input.focus();
    }
  }

  /** Build the deed logger HTML (collapsed by default). */
  _buildDeedLoggerHtml() {
    try {
      if (!game.settings.get("ace-engine", "enableFameSystem") || !this.lkMemory) return "";
    } catch (_) { return ""; }

    return `
      <div id="ace-deed-logger" class="ace-deed-hidden">
        <div class="ace-deed-header">📜 Log Notable Deed</div>
        <div class="ace-deed-row">
          <textarea id="ace-deed-input" class="ace-deed-input" spellcheck="true"
                    placeholder="Describe what happened (type or use mic)..."
                    rows="2"></textarea>
          <button class="ace-deed-mic" data-action="deedVoice" title="Speak a deed">🎤</button>
        </div>
        <div class="ace-deed-actions">
          <button class="ace-btn ace-btn-deed-submit" data-action="deedSubmit">Log Deed ✓</button>
        </div>
        <div id="ace-deed-preview" class="ace-deed-preview" style="display:none;"></div>
      </div>
    `;
  }

  /** Submit a deed — sends to AI for cleanup, then logs. */
  static async _onDeedSubmit(event, target) {
    const input = this.element?.querySelector("#ace-deed-input");
    const rawText = input?.value?.trim();
    if (!rawText || !this.ai || !this.lkMemory) return;

    const scene = canvas?.scene?.name ?? "";
    const submitBtn = this.element?.querySelector(".ace-btn-deed-submit");
    if (submitBtn) submitBtn.textContent = "Processing...";

    try {
      const prompt = `Rewrite this into a concise, past-tense deed entry for a campaign log (one sentence, max 60 words). Also estimate the fame magnitude: local (same town only), regional (nearby towns), major (across the region), or legendary (everyone knows).

The current scene is: "${scene}"

GM's description: "${rawText}"

Respond in this EXACT format (nothing else):
DEED: "[rewritten deed]"
MAGNITUDE: [local/regional/major/legendary]`;

      const response = await this.ai.chat(prompt, "", "", []);
      if (!response) throw new Error("No AI response");

      // Parse the response
      const deedMatch = response.match(/DEED:\s*"([^"]+)"/i);
      const magMatch  = response.match(/MAGNITUDE:\s*(\w+)/i);

      const deedText  = deedMatch?.[1] ?? rawText;
      const magnitude = ["local", "regional", "major", "legendary"].includes(magMatch?.[1]?.toLowerCase())
        ? magMatch[1].toLowerCase()
        : "local";

      // Get all PCs on the scene
      const pcs = (canvas?.tokens?.placeables?.filter(t =>
        t.actor?.hasPlayerOwner && t.actor?.type === "character"
      ) ?? []).map(t => t.actor.name);

      // Log the deed
      this.lkMemory.logDeed({
        text:      deedText,
        magnitude,
        scene,
        pcs,
        source:    "manual:gm",
      });

      // Show confirmation
      const preview = this.element?.querySelector("#ace-deed-preview");
      if (preview) {
        preview.innerHTML = `📜 <em>"${deedText}"</em> — <strong>${magnitude.toUpperCase()}</strong> ✓`;
        preview.style.display = "block";
        setTimeout(() => { preview.style.display = "none"; }, 5000);
      }

      if (input) input.value = "";
      ui.notifications.info(`📜 Deed logged: "${deedText}" (${magnitude})`);

    } catch (err) {
      console.error("ace-engine | Deed logger error:", err);
      // Fallback: log the raw text as-is
      this.lkMemory.logDeed({
        text:      rawText,
        magnitude: "local",
        scene,
        pcs:       [],
        source:    "manual:gm",
      });
      ui.notifications.info(`📜 Deed logged (raw): "${rawText}"`);
    } finally {
      if (submitBtn) submitBtn.textContent = "Log Deed ✓";
    }
  }

  /** Voice input for deed logger (reuses existing SpeechRecognition pattern). */
  static _onDeedVoice(event, target) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { ui.notifications.warn("Speech recognition not supported in this browser."); return; }

    const micBtn = this.element?.querySelector("[data-action='deedVoice']");
    const input  = this.element?.querySelector("#ace-deed-input");
    if (!input) return;

    // If already listening, stop
    if (this._deedRecognition) {
      this._deedRecognition.abort();
      this._deedRecognition = null;
      if (micBtn) micBtn.textContent = "🎤";
      return;
    }

    const recognition = new SR();
    recognition.continuous     = false;
    recognition.interimResults = true;
    recognition.lang           = "en-US";
    this._deedRecognition = recognition;
    if (micBtn) micBtn.textContent = "🔴";

    recognition.onresult = (ev) => {
      const transcript = Array.from(ev.results).map(r => r[0].transcript).join("");
      input.value = transcript;
    };

    recognition.onend = () => {
      this._deedRecognition = null;
      if (micBtn) micBtn.textContent = "🎤";
    };

    recognition.onerror = () => {
      this._deedRecognition = null;
      if (micBtn) micBtn.textContent = "🎤";
    };

    recognition.start();
  }

  // ════════════════════════════════════════════════════════════
  //  DOCUMENT LIBRARY — HTML Builders
  // ════════════════════════════════════════════════════════════

  _buildLibraryPanel() {
    const store = this._documentEngine?._mm?.documents;
    const docs = store?.getAll() ?? [];

    // Find orphan digests (no matching document card)
    const allDigests = this._digestEngine?.getAllDigests() ?? [];
    const docFileNames = new Set(docs.map(d => d.fileName));
    const orphanDigests = allDigests.filter(d => !docFileNames.has(d.sourceFile));

    const totalDocs = docs.length + orphanDigests.length;

    return `
      <div class="ace-library">

        <!-- Compact upload bar -->
        <div class="ace-library-dropzone-slim" id="ace-library-dropzone"
             data-action="libUploadClick" title="Drop files here or click to upload">
          <i class="fas fa-cloud-upload-alt"></i>
          <span>Drop files or click to upload</span>
          <span class="ace-library-formats-slim">PDF, TXT, MD, PNG, JPG, WEBP</span>
          <input type="file" id="ace-library-file-input"
                 accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp"
                 multiple style="display:none">
        </div>

        ${totalDocs > 0 ? `
        <!-- Clear All button — nuclear reset -->
        <div class="ace-library-nuke-bar">
          <button class="ace-lib-action ace-lib-nuke-btn" data-action="libNukeAll"
                  title="Permanently delete ALL documents and digests for a fresh start">
            <i class="fas fa-radiation"></i> Clear All Library
          </button>
        </div>` : ""}

        <!-- Source cards -->
        <div class="ace-library-list" id="ace-library-list">
          ${docs.length || orphanDigests.length
            ? docs.map(d => this._buildDocumentCard(d)).join("")
              + orphanDigests.map(d => this._buildOrphanDigestCard(d)).join("")
            : `<div class="ace-library-empty">
                 <i class="fas fa-book-open"></i>
                 <p>No documents uploaded yet</p>
                 <p class="ace-library-empty-hint">Upload PDFs, text files, or map images to give the AI reference material about your campaign world.</p>
               </div>`}
        </div>

        <!-- World Bible -->
        ${this._buildWorldBibleSection()}
      </div>
    `;
  }

  /**
   * Build a card for an "orphan" digest — one that exists in Extracted Knowledge
   * but has no matching document card (e.g. the PDF was removed but digest remains).
   */
  _buildOrphanDigestCard(d) {
    const store = this._documentEngine?._mm?.documents;
    const activeIds = new Set(store?.getActiveDigests() ?? []);
    const active = activeIds.has(d.id);
    const cats = d.categories ?? {};

    const catTags = [];
    if (cats.npcs) catTags.push(`${cats.npcs} NPCs`);
    if (cats.locations) catTags.push(`${cats.locations} locations`);
    if (cats.items) catTags.push(`${cats.items} items`);
    if (cats.encounters) catTags.push(`${cats.encounters} encounters`);
    if (cats.plotHooks) catTags.push(`${cats.plotHooks} hooks`);
    if (cats.factions) catTags.push(`${cats.factions} factions`);
    if (cats.lore) catTags.push(`${cats.lore} lore`);
    const catTagsHtml = catTags.length ? `<div class="ace-library-card-tags">${catTags.map(t => `<span class="ace-library-tag">${t}</span>`).join("")}</div>` : "";

    // Merge status — check if ANY Bible region was created from this digest
    const wb = this._worldBible;
    const regionKey = `digest_${(d.sourceFile ?? "").replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;
    let hasMerged = wb?.data?.regions?.[regionKey]?.cities?.length > 0
                 || wb?.data?.regions?.[regionKey]?.factions?.length > 0;
    // Fallback: if the filename changed (re-upload), search all digest regions by keyword overlap
    if (!hasMerged && wb?.data?.regions) {
      const srcWords = (d.sourceFile ?? d.displayName ?? "").toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/).filter(w => w.length > 3);
      for (const [rk, rv] of Object.entries(wb.data.regions)) {
        if (!rk.startsWith("digest_")) continue;
        if (!(rv.cities?.length > 0 || rv.factions?.length > 0)) continue;
        const matches = srcWords.filter(w => rk.includes(w));
        if (matches.length >= 3) { hasMerged = true; break; }
      }
    }

    // Pipeline
    let pipelineHtml = `<div class="ace-pipeline">
      <span class="ace-pipeline-dot ace-pipeline-done"><i class="fas fa-check"></i> Uploaded</span>
      <span class="ace-pipeline-arrow"><i class="fas fa-chevron-right"></i></span>
      <span class="ace-pipeline-dot ace-pipeline-done"><i class="fas fa-check"></i> Digested</span>
      <span class="ace-pipeline-arrow"><i class="fas fa-chevron-right"></i></span>`;

    if (hasMerged) {
      pipelineHtml += `<span class="ace-pipeline-dot ace-pipeline-done"><i class="fas fa-check"></i> Merged</span>`;
    } else if (wb?.hasData) {
      pipelineHtml += `<span class="ace-pipeline-dot ace-pipeline-action ace-pipeline-merge" data-action="libMergeDigestIntoBible" data-digest-id="${d.id}" title="Merge into World Bible (~$0.50\u20131.00)"><i class="fas fa-book-atlas"></i> Merge</span>`;
    } else {
      pipelineHtml += `<span class="ace-pipeline-dot ace-pipeline-pending"><i class="fas fa-book-atlas"></i> Merge</span>`;
    }
    pipelineHtml += `</div>`;

    const isExpanded = this._expandedLibCards?.has(d.id);

    // Inline pipeline for collapsed bar
    let pipInline = `<span class="ace-pip-inline ace-pip-done"><i class="fas fa-check"></i> Uploaded</span>`;
    pipInline += `<span class="ace-pip-inline ace-pip-done"><i class="fas fa-check"></i> Digested</span>`;
    if (hasMerged) pipInline += `<span class="ace-pip-inline ace-pip-done"><i class="fas fa-check"></i> Merged</span>`;

    return `
      <div class="ace-library-card ${active ? "ace-digest-active" : ""} ${isExpanded ? "" : "ace-lib-collapsed"}" data-digest-id="${d.id}">
        <!-- Collapsed bar -->
        <div class="ace-lib-collapsed-bar" data-action="libToggleCollapse" data-digest-id="${d.id}" title="Click to expand">
          <span class="ace-lib-collapsed-title">${d.displayName ?? d.sourceFile ?? "Unknown"}</span>
          <span class="ace-lib-collapsed-pipeline">${pipInline}</span>
          <i class="fas fa-chevron-down ace-lib-collapse-chevron"></i>
        </div>
        <!-- Expanded card -->
        <div class="ace-lib-expanded">
          <div class="ace-library-card-top">
            <div class="ace-library-card-icon">
              <div class="ace-library-card-icon-fallback"><i class="fas fa-brain"></i></div>
            </div>
            <div class="ace-library-card-info">
              <div class="ace-library-card-title">${d.displayName ?? d.sourceFile ?? "Unknown"}</div>
              <div class="ace-library-card-meta">DIGEST \u00B7 ${d.pageCount ?? "?"} pages</div>
              ${catTagsHtml}
            </div>
            <button type="button" class="ace-lib-collapse-toggle" data-action="libToggleCollapse" data-digest-id="${d.id}" title="Collapse">
              <i class="fas fa-chevron-up"></i>
            </button>
          </div>
          ${pipelineHtml}
          <div class="ace-library-card-actions">
            <button class="ace-lib-action" data-action="libBrowseDigest" data-digest-id="${d.id}"
                    title="Browse extracted entities — see exactly what the AI captured from this source">
              <i class="fas fa-book-atlas"></i> Browse
            </button>
            <button class="ace-lib-action" data-action="libToggleDigest" data-digest-id="${d.id}"
                    title="${active ? "Disable" : "Enable"} digest for this world">
              <i class="fas ${active ? "fa-eye" : "fa-eye-slash"}"></i> ${active ? "On" : "Off"}
            </button>
            <button class="ace-lib-action ace-lib-action-delete" data-action="libDeleteDigest" data-digest-id="${d.id}"
                    title="Delete digest permanently">
              <i class="fas fa-trash-alt"></i> Remove
            </button>
          </div>
        </div>
      </div>`;
  }

  _buildWorldBibleSection() {
    const wb = this._worldBible;
    const stats = wb?.getStats();
    const hasData = wb?.hasData;
    const isRunning = wb?.isRunning;

    if (hasData && stats) {
      return `
        <div class="ace-bible-section" id="ace-world-bible-section">
          <div class="ace-bible-header">
            <i class="fas fa-globe"></i> World Bible
            <span class="ace-bible-setting">${stats.setting}</span>
          </div>
          <div class="ace-bible-era">${stats.era}</div>
          <div class="ace-bible-stats">
            <span class="ace-bible-badge"><strong>${stats.nationCount}</strong> Nations</span>
            <span class="ace-bible-badge"><strong>${stats.cityCount}</strong> Cities</span>
            <span class="ace-bible-badge"><strong>${stats.factionCount}</strong> Factions</span>
            <span class="ace-bible-badge"><strong>${stats.deityCount}</strong> Deities</span>
            <span class="ace-bible-badge"><strong>${stats.geoCount}</strong> Geography</span>
          </div>
          <div class="ace-bible-stats ace-bible-stats-extended">
            ${stats.cultureCount ? `<span class="ace-bible-badge"><strong>${stats.cultureCount}</strong> Cultures</span>` : ""}
            ${stats.tradeRouteCount ? `<span class="ace-bible-badge"><strong>${stats.tradeRouteCount}</strong> Trade Routes</span>` : ""}
            ${stats.eventCount ? `<span class="ace-bible-badge"><strong>${stats.eventCount}</strong> Events</span>` : ""}
            ${stats.threatZoneCount ? `<span class="ace-bible-badge"><strong>${stats.threatZoneCount}</strong> Threat Zones</span>` : ""}
            ${stats.landmarkCount ? `<span class="ace-bible-badge"><strong>${stats.landmarkCount}</strong> Landmarks</span>` : ""}
            ${stats.npcCount ? `<span class="ace-bible-badge"><strong>${stats.npcCount}</strong> NPCs</span>` : ""}
          </div>
          <button class="ace-lib-action ace-bible-regen" data-action="worldBibleRegenerate"
                  title="Regenerate the World Bible (costs API credits)">
            <i class="fas fa-sync-alt"></i> Regenerate Bible
          </button>
        </div>`;
    }

    // No bible yet
    return `
      <div class="ace-bible-section" id="ace-world-bible-section">
        <div class="ace-bible-header">
          <i class="fas fa-globe"></i> World Bible
        </div>
        <div class="ace-bible-era" style="margin-bottom:6px;">Generate a world reference with nations, cities, factions, religions, and geography.</div>
        <select id="ace-world-bible-setting" class="ace-bible-select">
          <option value="faerun">Forgotten Realms \u2014 Faer\u00FBn (5e)</option>
          <option value="eberron">Eberron (5e)</option>
          <option value="greyhawk">Greyhawk (5e)</option>
          <option value="custom">Custom (describe below)</option>
        </select>
        <button class="ace-lib-action ace-bible-generate" data-action="worldBibleGenerate"
                ${isRunning ? "disabled" : ""}>
          <i class="fas ${isRunning ? "fa-spinner fa-spin" : "fa-globe"}"></i>
          ${isRunning ? "Generating World Bible..." : "Generate World Bible"}
        </button>
        <div id="ace-world-bible-progress" class="ace-bible-progress" style="display:none;"></div>
      </div>`;
  }

  _buildDocumentCard(doc) {
    const statusClass = doc.status === "ready" ? ""
                      : doc.status === "processing" ? "ace-lib-processing"
                      : doc.status === "error" ? "ace-lib-error"
                      : doc.status === "no_text" ? "ace-lib-no-text" : "";
    const statusLabel = doc.status === "processing" ? "\u23F3 Processing\u2026"
                      : doc.status === "error" ? `\u274C ${this._escapeHtml(doc.error || "Error")}`
                      : doc.status === "uploading" ? "\u{1F4E4} Uploading\u2026"
                      : doc.status === "no_text" ? "\u26A0\uFE0F Scanned PDF \u2014 no extractable text" : "";

    const chunkCount = doc.chunks?.length ?? 0;
    const tags = doc.tags ?? [];

    // Meta line
    let meta = doc.type.toUpperCase();
    if (doc.pageCount) meta += ` \u00B7 ${doc.pageCount} pg`;
    const sizeKB = doc.fileSize ? Math.round(doc.fileSize / 1024) : 0;
    if (sizeKB) meta += ` \u00B7 ${sizeKB >= 1024 ? (sizeKB / 1024).toFixed(1) + " MB" : sizeKB + " KB"}`;

    // Publication year badge
    const pubYear = doc.publishedYear;
    const yearHtml = `<span class="ace-lib-year-badge" data-action="libEditYear" data-doc-id="${doc.id}"
                            title="Click to ${pubYear ? "edit" : "set"} publication year">${pubYear ? `\u00A9${pubYear}` : "Set year"}</span>`;

    // Icon / thumbnail
    const coverImg = doc.images?.[0]?.src ?? doc.coverImage ?? null;
    const typeIcons = { pdf: "fa-book", txt: "fa-file-alt", md: "fa-file-code", image: "fa-scroll" };
    const fallbackIcon = typeIcons[doc.type] ?? "fa-file";

    const iconHtml = (doc.type === "image" && doc.filePath)
      ? `<img class="ace-library-card-thumb" src="${doc.filePath}" alt="${doc.displayName}" loading="lazy"
              onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
         <div class="ace-library-card-icon-fallback" style="display:none"><i class="fas fa-scroll"></i></div>`
      : coverImg
        ? `<img class="ace-library-card-thumb" src="${coverImg}" alt="${doc.displayName}" loading="lazy"
                onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
           <div class="ace-library-card-icon-fallback" style="display:none"><i class="fas ${fallbackIcon}"></i></div>`
        : `<div class="ace-library-card-icon-fallback"><i class="fas ${fallbackIcon}"></i></div>`;

    // Digest category tags (if digested)
    const allDigests = this._digestEngine?.getAllDigests() ?? [];
    const digestMeta = allDigests.find(d => d.sourceFile === doc.fileName);
    let catTagsHtml = "";
    if (digestMeta) {
      const cats = digestMeta.categories ?? {};
      const catTags = [];
      if (cats.npcs) catTags.push(`${cats.npcs} NPCs`);
      if (cats.locations) catTags.push(`${cats.locations} locations`);
      if (cats.items) catTags.push(`${cats.items} items`);
      if (cats.encounters) catTags.push(`${cats.encounters} encounters`);
      if (cats.plotHooks) catTags.push(`${cats.plotHooks} hooks`);
      if (cats.factions) catTags.push(`${cats.factions} factions`);
      if (cats.lore) catTags.push(`${cats.lore} lore`);
      if (catTags.length) catTagsHtml = `<div class="ace-library-card-tags">${catTags.map(t => `<span class="ace-library-tag">${t}</span>`).join("")}</div>`;
    }

    // Pipeline status dots: Uploaded → Digested → Merged
    const isReady = doc.status === "ready" && chunkCount > 0;
    const hasDigest = !!digestMeta;
    const wb = this._worldBible;
    const regionKey = `digest_${(doc.fileName || "").replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;

    // "Has this source been merged?" — the canonical marker is the region
    // bucket existing with `_source` set by world-bible-engine.mjs when the
    // first merge pass runs. We previously checked
    //   region.cities.length > 0 || region.factions.length > 0
    // which silently failed when a merge populated only NPCs/landmarks/
    // cultures/etc. — the merge ran, the data went in, but the UI showed
    // the source as un-merged. The user had no way to tell whether a
    // long-running merge had actually completed.
    //
    // _source is set at region-creation time during mergeFromDigest. If
    // it's there, the merge happened. Safer + cheaper than scanning 13
    // category arrays.
    const region = wb?.data?.regions?.[regionKey];
    let hasMerged = !!region?._source;

    // Fallback: if the filename changed (re-upload), search all digest
    // regions by keyword overlap and check their _source the same way.
    if (!hasMerged && wb?.data?.regions) {
      const srcWords = (doc.fileName ?? doc.displayName ?? "").toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/).filter(w => w.length > 3);
      for (const [rk, rv] of Object.entries(wb.data.regions)) {
        if (!rk.startsWith("digest_")) continue;
        if (!rv?._source) continue;
        const matches = srcWords.filter(w => rk.includes(w));
        if (matches.length >= 3) { hasMerged = true; break; }
      }
    }

    // Build pipeline HTML
    let pipelineHtml = "";
    if (isReady) {
      pipelineHtml = `<div class="ace-pipeline">`;

      // Step 1: Uploaded (always green if ready)
      pipelineHtml += `<span class="ace-pipeline-dot ace-pipeline-done"><i class="fas fa-check"></i> Uploaded</span>`;
      pipelineHtml += `<span class="ace-pipeline-arrow"><i class="fas fa-chevron-right"></i></span>`;

      // Step 2: Digested
      if (hasDigest) {
        pipelineHtml += `<span class="ace-pipeline-dot ace-pipeline-done" data-action="libGenerateDigest" data-doc-id="${doc.id}" title="Click to re-digest"><i class="fas fa-check"></i> Digested</span>`;
      } else {
        pipelineHtml += `<span class="ace-pipeline-dot ace-pipeline-action" data-action="libGenerateDigest" data-doc-id="${doc.id}" title="Extract NPCs, locations, items (~$0.30\u20130.60)"><i class="fas fa-brain"></i> Digest</span>`;
      }
      pipelineHtml += `<span class="ace-pipeline-arrow"><i class="fas fa-chevron-right"></i></span>`;

      // Step 3: Merged
      if (hasMerged) {
        pipelineHtml += `<span class="ace-pipeline-dot ace-pipeline-done"><i class="fas fa-check"></i> Merged</span>`;
      } else if (hasDigest && wb?.hasData) {
        pipelineHtml += `<span class="ace-pipeline-dot ace-pipeline-action ace-pipeline-merge" data-action="libMergeIntoBible" data-doc-id="${doc.id}" title="Merge into World Bible (~$0.50\u20131.00)"><i class="fas fa-book-atlas"></i> Merge</span>`;
      } else {
        pipelineHtml += `<span class="ace-pipeline-dot ace-pipeline-pending"><i class="fas fa-book-atlas"></i> Merge</span>`;
      }

      pipelineHtml += `</div>`;
    }

    // Default collapsed unless user has explicitly expanded this card
    const isExpanded = this._expandedLibCards?.has(doc.id);

    // Compact pipeline for collapsed bar (inline text)
    let pipelineInline = "";
    if (isReady) {
      const steps = [];
      steps.push(`<span class="ace-pip-inline ace-pip-done"><i class="fas fa-check"></i> Uploaded</span>`);
      if (hasDigest) steps.push(`<span class="ace-pip-inline ace-pip-done"><i class="fas fa-check"></i> Digested</span>`);
      if (hasMerged) steps.push(`<span class="ace-pip-inline ace-pip-done"><i class="fas fa-check"></i> Merged</span>`);
      pipelineInline = steps.join("");
    }

    return `
      <div class="ace-library-card ${statusClass} ${!doc.enabled ? "ace-lib-disabled" : ""} ${isExpanded ? "" : "ace-lib-collapsed"}" data-doc-id="${doc.id}">
        <!-- Collapsed bar — click anywhere to expand -->
        <div class="ace-lib-collapsed-bar" data-action="libToggleCollapse" data-doc-id="${doc.id}" title="Click to expand">
          <span class="ace-lib-collapsed-title">${doc.displayName}</span>
          <span class="ace-lib-collapsed-pipeline">${pipelineInline}</span>
          <i class="fas fa-chevron-down ace-lib-collapse-chevron"></i>
        </div>
        <!-- Full expanded card -->
        <div class="ace-lib-expanded">
          <div class="ace-library-card-top">
            <div class="ace-library-card-icon">
              ${iconHtml}
            </div>
            <div class="ace-library-card-info">
              <div class="ace-library-card-title" data-action="libEditName" data-doc-id="${doc.id}"
                   title="Click to rename">${doc.displayName}</div>
              <div class="ace-library-card-meta">${meta} ${yearHtml}</div>
              ${statusLabel ? `<div class="ace-library-card-status">${statusLabel}</div>` : ""}
              ${tags.length && !catTagsHtml ? `<div class="ace-library-card-tags">${tags.map(t => `<span class="ace-library-tag">${t}</span>`).join("")}</div>` : ""}
              ${catTagsHtml}
            </div>
            <button type="button" class="ace-lib-collapse-toggle" data-action="libToggleCollapse" data-doc-id="${doc.id}" title="Collapse">
              <i class="fas fa-chevron-up"></i>
            </button>
          </div>
          ${pipelineHtml}
          <div class="ace-library-card-actions">
            ${digestMeta ? `
            <button class="ace-lib-action" data-action="libBrowseDigest" data-digest-id="${digestMeta.id}"
                    title="Browse extracted entities — see exactly what the AI captured from this source">
              <i class="fas fa-book-atlas"></i> Browse
            </button>` : ""}
            <button class="ace-lib-action" data-action="libToggleDoc" data-doc-id="${doc.id}"
                    title="${doc.enabled ? "Disable" : "Enable"} for AI context">
              <i class="fas ${doc.enabled ? "fa-eye" : "fa-eye-slash"}"></i> ${doc.enabled ? "On" : "Off"}
            </button>
            <button class="ace-lib-action ace-lib-action-delete" data-action="libDeleteDoc" data-doc-id="${doc.id}"
                    title="Remove from library (keeps cached data)">
              <i class="fas fa-box-archive"></i> Remove
            </button>
            <button class="ace-lib-action ace-lib-action-nuke" data-action="libHardDeleteDoc" data-doc-id="${doc.id}"
                    title="Permanently delete — removes document AND digest">
              <i class="fas fa-trash-alt"></i> Delete
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ════════════════════════════════════════════════════════════
  //  DOCUMENT LIBRARY — Event Wiring
  // ════════════════════════════════════════════════════════════

  /** Wire drag-and-drop + file input events on the Library tab dropzone. */
  _wireLibraryEvents() {
    const dropzone = this.element?.querySelector("#ace-library-dropzone");
    const fileInput = this.element?.querySelector("#ace-library-file-input");
    if (!dropzone || !fileInput) return;

    // Drag-and-drop handlers
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("ace-library-dragover");
    });
    dropzone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("ace-library-dragover");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("ace-library-dragover");
      const files = e.dataTransfer?.files;
      if (files?.length) this._processUploadedFiles(files);
    });

    // File input change (click-to-upload)
    fileInput.addEventListener("change", (e) => {
      const files = e.target.files;
      if (files?.length) this._processUploadedFiles(files);
      fileInput.value = ""; // reset so same file can be re-selected
    });
  }

  /** Refresh the Library UI — now points at the dedicated LibraryWindow.
   *  The panel's Library tab is just a launcher button, so refresh now
   *  means: if the LibraryWindow is open, re-render it. Otherwise no-op. */
  _refreshLibraryUI() {
    if (this._libraryWindow?.rendered) {
      this._libraryWindow.render(false);
    }
    // One-shot: auto-detect publication years for existing docs that lack them
    if (!this._yearMigrationDone) {
      this._yearMigrationDone = true;
      this._migratePublishedYears();
    }
  }

  /**
   * Open (or focus) the dedicated Library window. Single-instance per panel —
   * subsequent calls just bring the existing window to the front.
   */
  static async _onOpenLibrary(_event, _target) {
    try {
      const { openLibraryWindow } = await import("./library-window.mjs");
      openLibraryWindow(this);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to open Library window:`, err);
      ui.notifications?.error(`ACE: Could not open Library — ${err.message?.slice(0, 100) ?? "unknown error"}`);
    }
  }

  /**
   * One-time migration: scan existing documents' chunks for copyright years.
   * Only sets publishedYear on docs that have chunks but no year yet.
   */
  async _migratePublishedYears() {
    const store = this._documentEngine?._mm?.documents;
    if (!store) return;
    const docs = store.getAll();
    let updated = 0;
    try {
      const { detectPublishedYear } = await import("./document-engine.mjs");
      for (const doc of docs) {
        if (doc.publishedYear) continue;                     // already has a year
        if (!doc.chunks?.length) continue;                   // no text to scan
        const year = detectPublishedYear(doc.chunks);
        if (year) {
          store.setPublishedYear(doc.id, year);
          updated++;
        }
      }
      if (updated) {
        this._saveDocuments();
        this._refreshLibraryUI();
        console.log(`${MODULE_ID} | Auto-detected publication year for ${updated} existing document(s).`);
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | Year migration failed (non-critical):`, e);
    }
  }

  /**
   * Live-update just the status line on a library card without re-rendering the
   * entire library panel (avoids flicker during long PDF extraction).
   */
  /** DOM root for library cards. Prefers the open LibraryWindow (which is
   *  where cards actually live now); falls back to the panel only as a
   *  safety net. Library actions reach this method via delegation, so `this`
   *  is the panel — but the cards are inside `this._libraryWindow.element`. */
  get _libraryDomRoot() {
    return this._libraryWindow?.element ?? this.element ?? null;
  }

  _updateLibraryCardStatus(docId, statusText, progress = null) {
    const root = this._libraryDomRoot;
    const card = root?.querySelector(`.ace-library-card[data-doc-id="${docId}"]`);
    if (!card) return;
    let statusEl = card.querySelector(".ace-library-card-status");
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.classList.add("ace-library-card-status");
      card.querySelector(".ace-library-card-info")?.appendChild(statusEl);
    }
    statusEl.textContent = statusText;

    // Progress bar — show/hide based on whether progress is provided
    let barWrap = card.querySelector(".ace-progress-bar-wrap");
    if (progress !== null && progress >= 0) {
      if (!barWrap) {
        barWrap = document.createElement("div");
        barWrap.classList.add("ace-progress-bar-wrap");
        barWrap.innerHTML = `<div class="ace-progress-bar-fill"></div><span class="ace-progress-bar-pct"></span>`;
        statusEl.after(barWrap);
      }
      const pct = Math.min(100, Math.round(progress * 100));
      barWrap.querySelector(".ace-progress-bar-fill").style.width = `${pct}%`;
      barWrap.querySelector(".ace-progress-bar-pct").textContent = `${pct}%`;
      barWrap.style.display = "";
    } else if (barWrap) {
      barWrap.style.display = "none";
    }
  }

  /** Trigger a debounced save of the documents store via MemoryManager. */
  _saveDocuments() {
    this._documentEngine?._mm?._scheduleSave?.("documents");
  }

  // ════════════════════════════════════════════════════════════
  //  DOCUMENT LIBRARY — Action Handlers
  // ════════════════════════════════════════════════════════════

  static _onLibUploadClick(event, target) {
    // Don't re-trigger if the click originated from the hidden file input
    if (event.target.id === "ace-library-file-input") return;
    // Library DOM lives in the LibraryWindow now — fall back to panel just in case.
    const root = this._libraryDomRoot ?? this.element;
    const fileInput = root?.querySelector("#ace-library-file-input");
    fileInput?.click();
  }

  static _onLibToggleCollapse(event, target) {
    const docId = target.closest("[data-doc-id]")?.dataset.docId
                ?? target.closest("[data-digest-id]")?.dataset.digestId;
    if (!docId) return;
    const card = target.closest(".ace-library-card");
    if (!card) return;
    if (this._expandedLibCards.has(docId)) {
      this._expandedLibCards.delete(docId);
      card.classList.add("ace-lib-collapsed");
    } else {
      this._expandedLibCards.add(docId);
      card.classList.remove("ace-lib-collapsed");
      requestAnimationFrame(() => card.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
  }

  static _onLibToggleDoc(event, target) {
    const docId = target.closest("[data-doc-id]")?.dataset.docId;
    const store = this._documentEngine?._mm?.documents;
    if (!docId || !store) return;
    const doc = store.getDocument(docId);
    if (!doc) return;
    store.setEnabled(docId, !doc.enabled);
    this._saveDocuments();
    this._refreshLibraryUI();
  }

  static async _onLibEditName(event, target) {
    const docId = target.closest("[data-doc-id]")?.dataset.docId;
    const store = this._documentEngine?._mm?.documents;
    if (!docId || !store) return;
    const doc = store.getDocument(docId);
    if (!doc) return;

    // Simple prompt dialog for now
    const newName = prompt("Document display name:", doc.displayName);
    if (newName !== null && newName.trim()) {
      store.setDisplayName(docId, newName.trim());
      this._saveDocuments();
      this._refreshLibraryUI();
    }
  }

  static async _onLibEditYear(event, target) {
    const docId = target.closest("[data-doc-id]")?.dataset.docId;
    const store = this._documentEngine?._mm?.documents;
    if (!docId || !store) return;
    const doc = store.getDocument(docId);
    if (!doc) return;

    const current = doc.publishedYear ?? "";
    const input = prompt("Publication year (e.g. 2016):", current);
    if (input === null) return;                       // cancelled
    const year = parseInt(input.trim(), 10);
    if (input.trim() === "") {
      store.setPublishedYear(docId, null);            // clear it
    } else if (!isNaN(year) && year >= 1970 && year <= new Date().getFullYear() + 1) {
      store.setPublishedYear(docId, year);
    } else {
      ui.notifications.warn("ACE | Enter a valid year between 1970 and now.");
      return;
    }
    this._saveDocuments();
    this._refreshLibraryUI();
  }

  static async _onLibEditTags(event, target) {
    const docId = target.closest("[data-doc-id]")?.dataset.docId;
    const store = this._documentEngine?._mm?.documents;
    if (!docId || !store) return;
    const doc = store.getDocument(docId);
    if (!doc) return;

    const currentTags = (doc.tags ?? []).join(", ");
    const input = prompt("Tags (comma-separated):", currentTags);
    if (input !== null) {
      const tags = input.split(",").map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
      store.setTags(docId, tags);
      this._saveDocuments();
      this._refreshLibraryUI();
    }
  }

  static async _onLibDeleteDoc(event, target) {
    const docId = target.closest("[data-doc-id]")?.dataset.docId;
    const store = this._documentEngine?._mm?.documents;
    if (!docId || !store) return;
    const doc = store.getDocument(docId);
    if (!doc) return;

    const confirmed = await _aceConfirmDialog(
      "Remove from Library",
      `<p>Remove <strong>${doc.displayName}</strong> from the active library?</p>` +
      `<p>The extracted data is safely cached on disk and can be re-imported later. Nothing is permanently deleted.</p>`,
      { yesLabel: "Remove", yesIcon: "fas fa-box-archive", noLabel: "Cancel", noIcon: "fas fa-times" }
    ).catch(() => false);
    if (!confirmed) return;

    // Ensure the document is cached before removing
    if (this._documentEngine && doc.status === "ready") {
      await this._documentEngine.saveDocumentCache(doc).catch(err =>
        console.warn(`${MODULE_ID} | Pre-removal cache save failed:`, err)
      );
    }

    store.removeDocument(docId);
    this._saveDocuments();
    this._refreshLibraryUI();
    ui.notifications.info(`ACE | Removed from library: ${doc.displayName} (cached on disk for re-import)`);
  }

  /**
   * Hard-delete a single document — removes from store AND deletes its digest.
   * No cache is saved. The document is gone.
   */
  static async _onLibHardDeleteDoc(event, target) {
    const docId = target.closest("[data-doc-id]")?.dataset.docId;
    const store = this._documentEngine?._mm?.documents;
    if (!docId || !store) return;
    const doc = store.getDocument(docId);
    if (!doc) return;

    const confirmed = await _aceConfirmDialog(
      "Permanently Delete",
      `<p>Permanently delete <strong>${doc.displayName}</strong>?</p>` +
      `<p style="color:#ff6b6b;">This removes the document from the library AND deletes any associated digest. ` +
      `Cached extraction data on disk will be orphaned and ignored. This cannot be undone.</p>`,
      { yesLabel: "Delete Forever", yesIcon: "fas fa-skull-crossbones", noLabel: "Cancel", noIcon: "fas fa-times" }
    ).catch(() => false);
    if (!confirmed) return;

    // Delete associated digest if one exists
    if (this._digestEngine) {
      const allDigests = this._digestEngine.getAllDigests();
      const matchingDigest = allDigests.find(d => d.sourceFile === doc.fileName);
      if (matchingDigest) {
        store.toggleDigest(matchingDigest.id, false);
        await this._digestEngine.deleteDigest(matchingDigest.id);
        console.log(`${MODULE_ID} | Hard delete: removed digest ${matchingDigest.id} for ${doc.displayName}`);
      }
    }

    store.removeDocument(docId);
    this._saveDocuments();
    this._refreshLibraryUI();
    ui.notifications.info(`ACE | Permanently deleted: ${doc.displayName}`);
  }

  /**
   * Nuclear option — wipe the ENTIRE library (all documents + all digests).
   * For when the user wants a completely fresh start.
   */
  static async _onLibNukeAll(event, target) {
    const store = this._documentEngine?._mm?.documents;
    if (!store) return;

    const docCount = store.recordCount;
    const digestCount = Object.keys(this._digestEngine?.getAllDigests() ?? []).length;

    const confirmed = await _aceConfirmDialog(
      "⚠ Clear ALL Library Data",
      `<p style="color:#ff6b6b;font-weight:bold;">This will permanently destroy:</p>` +
      `<ul style="color:#ff6b6b;">` +
      `<li>${docCount} document(s) — all chunks, indexes, and metadata</li>` +
      `<li>${digestCount} digest(s) — all AI-extracted knowledge</li>` +
      `<li>All active digest selections for this world</li>` +
      `</ul>` +
      `<p>Orphaned cache files on disk will be ignored. <strong>This cannot be undone.</strong></p>` +
      `<p>Are you absolutely sure you want a fresh start?</p>`,
      { yesLabel: "Nuke Everything", yesIcon: "fas fa-radiation", noLabel: "Cancel", noIcon: "fas fa-times" }
    ).catch(() => false);
    if (!confirmed) return;

    // Nuke the document store
    const nukedDocs = store.nukeLibrary();
    this._saveDocuments();

    // Nuke all digests
    let nukedDigests = 0;
    if (this._digestEngine) {
      nukedDigests = await this._digestEngine.nukeAllDigests();
    }

    this._refreshLibraryUI();
    ui.notifications.info(`ACE | Library cleared: ${nukedDocs} documents and ${nukedDigests} digests removed. Fresh start!`);
    console.log(`${MODULE_ID} | NUKE ALL: removed ${nukedDocs} documents and ${nukedDigests} digests`);
  }

  // ── Digest Action Handlers ─────────────────────────────────

  /**
   * Generate an AI digest for a document.
   * Triggered by the brain icon on library cards.
   */
  static async _onLibGenerateDigest(event, target) {
    const docId = target.closest("[data-doc-id]")?.dataset.docId;
    if (!docId) return;
    await this._generateDigest(docId);
  }

  /**
   * Merge a digested document's data into the World Bible.
   */
  static async _onLibMergeIntoBible(event, target) {
    const docId = target.closest("[data-doc-id]")?.dataset.docId;
    if (!docId) return;

    const doc = this._documentEngine?._mm?.documents?.getDocument(docId);
    if (!doc) { ui.notifications.warn("ACE | Document not found."); return; }

    const allDigests = this._digestEngine?.getAllDigests() ?? [];
    const digestMeta = allDigests.find(d => d.sourceFile === doc.fileName);
    if (!digestMeta) { ui.notifications.warn("ACE | No digest found for this document. Generate a digest first."); return; }

    if (!this._worldBible?.hasData) {
      ui.notifications.warn("ACE | World Bible must be generated before merging digests.");
      return;
    }

    const confirmed = await _aceConfirmDialog(
      "Merge Digest into World Bible",
      `<p>Merge <strong>${doc.displayName}</strong> into the World Bible?</p>
       <p>This will extract locations, factions, NPCs, religions, and geography from the digest and add them as canonical Bible entries.</p>
       <p style="color:#d4af37;font-weight:600;margin-top:8px;">&#9888; This costs ~5 AI API calls (~$0.50\u20131.00 depending on your provider).</p>
       <p>Existing Bible entries will be enriched, not duplicated.</p>`,
      { yesLabel: "Merge", yesIcon: "fas fa-book-atlas" }
    ).catch(() => false);
    if (!confirmed) return;

    const digestData = await this._digestEngine.loadDigest(digestMeta.id);
    if (!digestData?.digest) { ui.notifications.error("ACE | Failed to load digest data."); return; }

    const cardEl = target.closest(".ace-library-card");
    if (!cardEl) return;
    await AcePanel._executeBibleMerge.call(this, cardEl, doc.displayName, doc.fileName, digestData, doc.publishedYear ?? null);
  }

  /**
   * Merge a digest into the World Bible — triggered from the Extracted Knowledge section.
   * Works directly from digest ID (no document card needed).
   */
  static async _onLibMergeDigestIntoBible(event, target) {
    const digestId = target.closest("[data-digest-id]")?.dataset.digestId;
    if (!digestId) return;

    const digestMeta = this._digestEngine?.getDigestMeta(digestId);
    if (!digestMeta) { ui.notifications.warn("ACE | Digest not found."); return; }

    if (!this._worldBible?.hasData) {
      ui.notifications.warn("ACE | World Bible must be generated before merging digests.");
      return;
    }

    const displayName = digestMeta.displayName ?? digestMeta.sourceFile ?? "Unknown";

    const confirmed = await _aceConfirmDialog(
      "Merge Digest into World Bible",
      `<p>Merge <strong>${displayName}</strong> into the World Bible?</p>
       <p>This will extract locations, factions, NPCs, religions, and geography from the digest and add them as canonical Bible entries.</p>
       <p style="color:#d4af37;font-weight:600;margin-top:8px;">&#9888; This costs ~5 AI API calls (~$0.50–1.00 depending on your provider).</p>
       <p>Existing Bible entries will be enriched, not duplicated.</p>`,
      { yesLabel: "Merge", yesIcon: "fas fa-book-atlas" }
    ).catch(() => false);
    if (!confirmed) return;

    const digestData = await this._digestEngine.loadDigest(digestId);
    if (!digestData?.digest) { ui.notifications.error("ACE | Failed to load digest data."); return; }

    const cardEl = target.closest(".ace-library-card");
    if (!cardEl) return;
    await AcePanel._executeBibleMerge.call(this, cardEl, displayName, digestMeta.sourceFile ?? digestId, digestData, digestMeta.publishedYear ?? null);
  }

  /**
   * Shared merge execution — takes over the card with a progress bar UI.
   */
  static async _executeBibleMerge(cardEl, displayName, sourceFile, digestData, publishedYear) {
    const totalSteps = 9;  // 5 original + 4 supplement passes

    // Save original card HTML for restore on error
    const origHtml = cardEl.innerHTML;

    // Replace card content with progress bar UI
    cardEl.innerHTML = `
      <div class="ace-merge-progress">
        <div class="ace-merge-progress-title">
          <i class="fas fa-book-atlas"></i> Merging into World Bible
        </div>
        <div class="ace-merge-progress-source">${displayName}</div>
        <div class="ace-merge-progress-step">Preparing...</div>
        <div class="ace-merge-progress-bar-track">
          <div class="ace-merge-progress-bar-fill" style="width: 0%"></div>
        </div>
        <div class="ace-merge-progress-counter">0 / ${totalSteps}</div>
      </div>`;

    // Block interaction on the entire library scroll area
    const libScroll = cardEl.closest(".ace-tab-body");
    if (libScroll) libScroll.style.pointerEvents = "none";

    const stepEl = cardEl.querySelector(".ace-merge-progress-step");
    const fillEl = cardEl.querySelector(".ace-merge-progress-bar-fill");
    const counterEl = cardEl.querySelector(".ace-merge-progress-counter");

    try {
      // Phase 1: Original 5 merge passes
      const results = await game.modules.get("ace-engine")?.api?.mergeDigestIntoBible(
        digestData.digest,
        displayName,
        sourceFile,
        (step, total, category) => {
          const pct = Math.round((step / totalSteps) * 100);
          if (stepEl) stepEl.textContent = category;
          if (fillEl) fillEl.style.width = `${pct}%`;
          if (counterEl) counterEl.textContent = `${step} / ${totalSteps}`;
        },
        publishedYear
      );

      // Phase 2: Supplement 4 new category passes (steps 6-9)
      let suppResults = { merged: 0, updated: 0, skipped: 0, errors: [] };
      try {
        suppResults = await game.modules.get("ace-engine")?.api?.supplementMergeDigest(
          digestData.digest,
          displayName,
          sourceFile,
          (step, total, category) => {
            const globalStep = 5 + step;  // offset by original 5 passes
            const pct = Math.round((globalStep / totalSteps) * 100);
            if (stepEl) stepEl.textContent = category;
            if (fillEl) fillEl.style.width = `${pct}%`;
            if (counterEl) counterEl.textContent = `${globalStep} / ${totalSteps}`;
          },
          publishedYear
        );
      } catch (suppErr) {
        console.warn(`${MODULE_ID} | Supplement merge failed (non-fatal):`, suppErr);
      }

      // Combine results from both phases
      const totalMerged = (results.merged ?? 0) + (suppResults.merged ?? 0);
      const totalUpdated = (results.updated ?? 0) + (suppResults.updated ?? 0);
      const totalSkipped = (results.skipped ?? 0) + (suppResults.skipped ?? 0);
      const allErrors = [...(results.errors ?? []), ...(suppResults.errors ?? [])];

      // Show completion state
      if (stepEl) stepEl.textContent = "Complete!";
      if (fillEl) fillEl.style.width = "100%";
      if (counterEl) counterEl.textContent = `${totalSteps} / ${totalSteps}`;

      const summaryEl = cardEl.querySelector(".ace-merge-progress-source");
      if (summaryEl) summaryEl.textContent = `${totalMerged} new entries, ${totalUpdated} updated${totalSkipped ? `, ${totalSkipped} skipped` : ""}`;

      // Add done class for green glow
      const progressEl = cardEl.querySelector(".ace-merge-progress");
      if (progressEl) progressEl.classList.add("ace-merge-done");

      const msg = `Merged "${displayName}" into World Bible: ${totalMerged} new, ${totalUpdated} updated${totalSkipped ? `, ${totalSkipped} skipped (older source)` : ""}.`;
      if (allErrors.length) {
        ui.notifications.warn(`${msg} (${allErrors.length} errors — check console)`);
      } else {
        ui.notifications.info(`ACE | ${msg}`);
      }

      // Hold the completion state for 2.5s then refresh
      await new Promise(r => setTimeout(r, 2500));
      if (libScroll) libScroll.style.pointerEvents = "";
      this._refreshLibraryUI();

    } catch (err) {
      console.error(`${MODULE_ID} | Bible merge failed:`, err);
      ui.notifications.error(`ACE | Bible merge failed: ${err.message}`);
      if (libScroll) libScroll.style.pointerEvents = "";
      cardEl.innerHTML = origHtml;
    }
  }

  /**
   * Toggle a global digest active/inactive for the current world.
   */
  static async _onLibToggleDigest(event, target) {
    const digestId = target.closest("[data-digest-id]")?.dataset.digestId;
    const store = this._documentEngine?._mm?.documents;
    if (!digestId || !store) return;

    const activeIds = new Set(store.getActiveDigests());
    const newEnabled = !activeIds.has(digestId);
    store.toggleDigest(digestId, newEnabled);
    this._saveDocuments();
    this._refreshLibraryUI();

    // Rebuild world graph after toggle change
    if (this._digestEngine) {
      this._digestEngine.rebuildWorldGraph(store.getActiveDigests()).catch(err =>
        console.warn(`${MODULE_ID} | World graph rebuild after toggle failed:`, err)
      );
    }

    const meta = this._digestEngine?.getDigestMeta(digestId);
    const name = meta?.displayName ?? digestId;
    ui.notifications.info(`ACE | Digest "${name}" ${newEnabled ? "enabled" : "disabled"} for this world`);
  }

  /**
   * Delete a global digest permanently (removes from index, data stays on disk).
   */
  static async _onLibDeleteDigest(event, target) {
    const digestId = target.closest("[data-digest-id]")?.dataset.digestId;
    if (!digestId || !this._digestEngine) return;

    const meta = this._digestEngine.getDigestMeta(digestId);
    const name = meta?.displayName ?? digestId;

    const confirmed = await _aceConfirmDialog(
      "Delete Digest",
      `<p>Are you sure you want to permanently delete the digest for <strong>${name}</strong>?</p>` +
      `<p>This removes the structured knowledge index. The JSON data file remains on disk but will no longer be used.</p>`,
      { yesLabel: "Delete", yesIcon: "fas fa-trash", noLabel: "Cancel", noIcon: "fas fa-times" }
    ).catch(() => false);
    if (!confirmed) return;

    // Also remove from this world's active list
    const store = this._documentEngine?._mm?.documents;
    if (store) {
      store.toggleDigest(digestId, false);
      this._saveDocuments();
    }

    await this._digestEngine.deleteDigest(digestId);

    // Rebuild world graph after deletion
    if (store && this._digestEngine) {
      this._digestEngine.rebuildWorldGraph(store.getActiveDigests()).catch(err =>
        console.warn(`${MODULE_ID} | World graph rebuild after delete failed:`, err)
      );
    }

    this._refreshLibraryUI();
    ui.notifications.info(`ACE | Deleted digest: ${name}`);
  }

  /**
   * Open the Digest Browser window — shows every entity the AI extracted from
   * a digested source. Visible proof that digestion captured the data.
   */
  static async _onLibBrowseDigest(event, target) {
    const digestId = target.closest("[data-digest-id]")?.dataset.digestId;
    if (!digestId) return;
    try {
      const { showDigestBrowser } = await import("./digest-browser.mjs");
      showDigestBrowser(digestId);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to open digest browser:`, err);
      ui.notifications?.error(`ACE: Could not open digest browser — ${err.message?.slice(0, 100) ?? "unknown error"}`);
    }
  }

  /**
   * Run the full digest generation pipeline for a document.
   * Shows live progress on the library card, saves results globally,
   * and auto-activates the digest for the current world.
   */
  async _generateDigest(docId) {
    const store = this._documentEngine?._mm?.documents;
    const doc = store?.getDocument(docId);
    if (!doc || !this._digestEngine || !this.ai) {
      ui.notifications.error("ACE | Cannot generate digest — missing document, digest engine, or AI provider.");
      return;
    }

    if (!doc.chunks?.length) {
      ui.notifications.warn("ACE | No text chunks found. Process the document first.");
      return;
    }

    // Replace the generate button with a pause button during processing
    // — query the LibraryWindow first since that's where the card actually lives.
    const btn = this._libraryDomRoot?.querySelector(`[data-action="libGenerateDigest"][data-doc-id="${docId}"]`);
    if (btn) {
      btn.dataset.action = "digestPause";
      btn.innerHTML = `<i class="fas fa-pause"></i>`;
      btn.title = "Pause digest";
      btn.classList.add("ace-digest-running");
    }

    try {
      // Progress callback updates the library card status line
      const onProgress = (batchNum, totalBatches, phase) => {
        let statusText;
        let progress = null;
        if (phase === "extracting") {
          statusText = `🧠 Digesting batch ${batchNum}/${totalBatches}…`;
          progress = batchNum / totalBatches;
        } else if (phase === "merging") {
          statusText = `🧠 Merging extracted data…`;
          progress = 0.95;
        } else if (phase === "summary") {
          statusText = `🧠 Generating summary…`;
          progress = 0.98;
        }
        this._updateLibraryCardStatus(docId, statusText, progress);
      };

      // Run the AI digest pipeline
      const digestResult = await this._digestEngine.generateDigest(doc, this.ai, onProgress);

      // Build the digest record
      const digestId = `digest_${Math.floor(Date.now() / 1000)}_${Math.random().toString(36).slice(2, 5)}`;
      const categories = {};
      for (const key of ["npcs", "locations", "plotHooks", "encounters", "items", "factions", "lore"]) {
        categories[key] = digestResult[key]?.length ?? 0;
      }

      const digestData = {
        version: 1,
        digestId,
        sourceFile: doc.fileName,
        displayName: doc.displayName,
        createdAt: new Date().toISOString(),
        pageCount: doc.pageCount ?? 0,
        chunkCount: doc.chunks?.length ?? 0,
        digest: digestResult,
      };

      // Save the digest JSON to global storage
      this._updateLibraryCardStatus(docId, `🧠 Saving digest…`);
      await this._digestEngine.saveDigest(digestId, digestData);

      // Update the global index
      this._digestEngine.updateIndex(digestId, {
        sourceFile: doc.fileName,
        displayName: doc.displayName,
        createdAt: digestData.createdAt,
        pageCount: digestData.pageCount,
        chunkCount: digestData.chunkCount,
        categories,
      });
      await this._digestEngine.saveIndex();

      // Auto-activate for this world
      if (store) {
        store.toggleDigest(digestId, true);
        this._saveDocuments();
      }

      // Rebuild unified world graph from all active digests
      if (store && this._digestEngine) {
        this._updateLibraryCardStatus(docId, `🌍 Building world graph…`);
        try {
          await this._digestEngine.rebuildWorldGraph(store.getActiveDigests());
        } catch (wgErr) {
          console.warn(`${MODULE_ID} | World graph rebuild failed:`, wgErr);
        }
      }

      // Auto-backup digests after generation (protects API token investment)
      this._digestEngine.backupDigests(5).catch(err =>
        console.warn(`${MODULE_ID} | Post-digest backup failed (non-fatal):`, err)
      );

      this._updateLibraryCardStatus(docId, "");
      this._refreshLibraryUI();
      ui.notifications.info(`ACE | Digest created for "${doc.displayName}" — ${Object.values(categories).reduce((a, b) => a + b, 0)} entries extracted`);

      // ── Auto-merge into World Bible (if enabled) ──
      try {
        const autoMerge = game.settings.get(MODULE_ID, "autoMergeDigests");
        if (autoMerge && this._worldBible?.hasData) {
          console.log(`${MODULE_ID} | Auto-merging digest "${doc.displayName}" into World Bible...`);
          ui.notifications.info(`ACE | Auto-merging "${doc.displayName}" into World Bible...`);
          const mergeResults = await game.modules.get(MODULE_ID)?.api?.mergeDigestIntoBible(
            digestResult, doc.displayName, doc.fileName,
            (step, total, category) => {
              this._updateLibraryCardStatus(docId, `📖 Merging: ${category}… (${step}/${total})`);
            },
            doc.publishedYear ?? null
          );
          // Run supplement merge (4 new category passes) immediately after
          let suppResults = { merged: 0, updated: 0 };
          try {
            suppResults = await game.modules.get(MODULE_ID)?.api?.supplementMergeDigest(
              digestResult, doc.displayName, doc.fileName,
              (step, total, category) => {
                this._updateLibraryCardStatus(docId, `📖 Enriching: ${category}… (${step}/${total})`);
              },
              doc.publishedYear ?? null
            );
          } catch (suppErr) {
            console.warn(`${MODULE_ID} | Supplement merge failed (non-fatal):`, suppErr);
          }
          this._updateLibraryCardStatus(docId, "");
          this._refreshLibraryUI();
          const totalMerged = (mergeResults.merged ?? 0) + (suppResults.merged ?? 0);
          const totalUpdated = (mergeResults.updated ?? 0) + (suppResults.updated ?? 0);
          ui.notifications.info(`ACE | Auto-merged "${doc.displayName}": ${totalMerged} new, ${totalUpdated} updated.`);
        }
      } catch (mergeErr) {
        console.warn(`${MODULE_ID} | Auto-merge failed (non-fatal):`, mergeErr);
      }

    } catch (err) {
      console.error(`${MODULE_ID} | Digest generation failed:`, err);
      this._updateLibraryCardStatus(docId, `❌ Digest failed: ${err.message}`);
      ui.notifications.error(`ACE | Digest generation failed: ${err.message}`);

      // Re-enable the button back to brain icon
      if (btn) {
        btn.dataset.action = "libGenerateDigest";
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-brain"></i>`;
        btn.title = "Generate AI Digest";
        btn.classList.remove("ace-digest-running", "ace-digest-paused");
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  //  DOCUMENT LIBRARY — Upload Processing Pipeline
  // ════════════════════════════════════════════════════════════

  /**
   * Process one or more uploaded files: upload to Foundry, create records,
   * extract text / chunk / tag, and update the Library UI.
   * @param {FileList} fileList
   */
  async _processUploadedFiles(fileList) {
    console.log(`${MODULE_ID} | Upload handler fired — ${fileList?.length ?? 0} file(s)`);
    const store = this._documentEngine?._mm?.documents;
    if (!store) {
      console.error(`${MODULE_ID} | Document store missing: _documentEngine=${!!this._documentEngine}, _mm=${!!this._documentEngine?._mm}, documents=${!!this._documentEngine?._mm?.documents}`);
      ui.notifications.error("ACE | Document store not available. Is memory initialized?");
      return;
    }

    const worldId = game.world.id;
    const libDir = `worlds/${worldId}/ace-engine/library`;

    for (const file of fileList) {
      const ext = file.name.split(".").pop().toLowerCase();
      const allowed = ["pdf", "txt", "md", "png", "jpg", "jpeg", "webp"];
      if (!allowed.includes(ext)) {
        ui.notifications.warn(`ACE | Unsupported file type: .${ext}`);
        continue;
      }

      const type = ["png", "jpg", "jpeg", "webp"].includes(ext) ? "image"
                 : ext === "pdf" ? "pdf"
                 : ext === "md"  ? "md" : "txt";

      // 1. Upload raw file to Foundry library directory
      let storedPath;
      try {
        console.log(`${MODULE_ID} | Uploading "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB) to ${libDir}...`);
        const fp = _FP();
        console.log(`${MODULE_ID} | FilePicker resolved:`, typeof fp, fp?.name ?? fp?.constructor?.name);
        const result = await fp.upload("data", libDir, file, { notify: false });
        console.log(`${MODULE_ID} | Upload result:`, result);
        storedPath = result?.path;
        if (!storedPath) {
          console.error(`${MODULE_ID} | Upload returned no path:`, result);
          ui.notifications.error(`ACE | Upload succeeded but no file path returned for ${file.name}`);
          continue;
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Upload failed for ${file.name}:`, err);
        ui.notifications.error(`ACE | Failed to upload ${file.name}`);
        continue;
      }

      // 2. Create document record (status: "processing")
      const displayName = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
      const docRecord = store.addDocument({
        fileName: file.name,
        displayName,
        type,
        fileSize: file.size,
        storedPath,
      });

      store.setStatus(docRecord.id, "processing");
      this._saveDocuments();
      this._refreshLibraryUI();

      // 2b. Check for cached extraction before doing heavy processing
      const cached = await this._documentEngine.loadDocumentCache(file.name).catch(() => null);

      // If cache exists with 0 chunks, it's a known-scanned PDF — skip re-processing
      if (cached && Array.isArray(cached.chunks) && cached.chunks.length === 0 && type === "pdf") {
        store.setPageCount(docRecord.id, cached.pageCount ?? 0);
        store.setStatus(docRecord.id, "no_text");
        this._saveDocuments();
        this._refreshLibraryUI();
        ui.notifications.warn(
          `ACE | "${cached.displayName ?? file.name}" is a scanned PDF (no extractable text). `
          + `Try a version with an OCR text layer.`
        );
        continue;
      }

      const CURRENT_CHUNK_VERSION = 4; // Must match document-store.mjs setChunks()

      if (cached && cached.chunks?.length) {
        // Auto-reject outdated cache versions — force re-extraction
        const cacheVersion = cached.chunkVersion ?? 1;
        if (cacheVersion < CURRENT_CHUNK_VERSION) {
          console.log(`${MODULE_ID} | Cache for "${file.name}" is v${cacheVersion}, current is v${CURRENT_CHUNK_VERSION} — forcing re-extraction`);
          // Fall through to re-extract below
        } else {

        const useCached = await _aceConfirmDialog(
          "Cached Extraction Found",
          `<p>A cached extraction for <strong>${cached.displayName}</strong> was found on disk.</p>` +
          `<p>${cached.chunkCount ?? cached.chunks.length} text chunks, cached ${new Date(cached.cachedAt).toLocaleDateString()}.</p>` +
          `<p>Use the cached version (instant) or re-extract from the file?</p>`,
          { yesLabel: "Use Cache", yesIcon: "fas fa-bolt", noLabel: "Re-extract", noIcon: "fas fa-redo" }
        ).catch(() => false);

        if (useCached) {
          // Restore from cache — skip heavy extraction entirely
          // If cache has parents (v2), pass as {chunks, parents} object
          if (cached.parents?.length) {
            store.setChunks(docRecord.id, { chunks: cached.chunks, parents: cached.parents });
          } else {
            store.setChunks(docRecord.id, cached.chunks);
          }
          if (cached.images?.length) {
            for (const img of cached.images) store.addImage(docRecord.id, img);
          }
          if (cached.tags?.length)      store.setTags(docRecord.id, cached.tags);
          if (cached.pageCount)          store.setPageCount(docRecord.id, cached.pageCount);
          if (cached.embeddings)         store.setEmbeddings(docRecord.id, cached.embeddings);
          store.setStatus(docRecord.id, "ready");
          this._saveDocuments();
          this._refreshLibraryUI();
          ui.notifications.info(`ACE | Restored from cache: ${cached.displayName} (${cached.chunks.length} chunks)`);
          continue; // skip to next file
        }
        } // close version check else
      }

      // 3. Process in background (extract text, chunk, tag)
      try {
        await this._processDocument(docRecord.id, file, type);
      } catch (err) {
        console.error(`${MODULE_ID} | Processing failed for ${file.name}:`, err);
        store.setStatus(docRecord.id, "error", err.message || "Processing failed");
        this._saveDocuments();
        this._refreshLibraryUI();
      }
    }
  }

  /**
   * Process a single document: extract text, chunk, auto-tag, store results.
   * @param {string} docId
   * @param {File} file - The original File object
   * @param {string} type - "pdf" | "txt" | "md" | "image"
   */
  async _processDocument(docId, file, type) {
    const store = this._documentEngine?._mm?.documents;
    if (!store) return;

    if (type === "pdf") {
      // ── PDF: extract text page-by-page, then chunk ──
      const arrayBuffer = await file.arrayBuffer();

      const pages = await this._documentEngine.extractPdfText(arrayBuffer, (current, total) => {
        console.log(`${MODULE_ID} | Extracting PDF: page ${current}/${total}`);
        // Live progress update in the library card
        store.setStatus(docId, "processing", `Extracting page ${current} of ${total}…`);
        this._updateLibraryCardStatus(docId, `⏳ Extracting page ${current}/${total}…`, current / total);
      });

      store.setPageCount(docId, pages.length);
      this._updateLibraryCardStatus(docId, `⏳ Chunking ${pages.length} pages…`, 0);

      const chunkResult = await this._documentEngine.chunkPages(pages, (cur, tot) => {
        this._updateLibraryCardStatus(docId, `⏳ Chunking page ${cur}/${tot}…`, cur / tot);
      });
      store.setChunks(docId, chunkResult);

      // ── Scanned-PDF detection ─────────────────────────────────
      // If we got pages but zero chunks, the PDF is almost certainly
      // a scanned document (images only, no embedded text layer).
      const chunkCount = chunkResult?.chunks?.length ?? chunkResult?.length ?? 0;
      if (chunkCount === 0 && pages.length > 0) {
        store.setStatus(docId, "no_text");
        this._saveDocuments();
        this._refreshLibraryUI();
        const docName = store.getDocument(docId)?.displayName ?? file.name;
        ui.notifications.warn(
          `ACE | "${docName}" appears to be a scanned PDF (no extractable text). `
          + `Try a version with an OCR text layer, or a digitally-created PDF.`
        );

        // Still cache globally so we don't re-process the same file
        const finishedDoc = store.getDocument(docId);
        if (finishedDoc) {
          this._documentEngine.saveDocumentCache(finishedDoc).catch(err =>
            console.warn(`${MODULE_ID} | Document cache save failed:`, err)
          );
        }
        return;
      }

      // Auto-extract document-level tags from first few chunks
      const chunksArray = chunkResult?.chunks ?? chunkResult ?? [];
      const parentCount = chunkResult?.parents?.length ?? 0;
      const sample = chunksArray.slice(0, 5).map(c => c.text).join(" ");
      const { extractKeywords } = await import("./document-store.mjs");
      const autoTags = extractKeywords(sample, 6);
      store.setTags(docId, autoTags);

      // Auto-detect publication year from copyright text
      try {
        const { detectPublishedYear } = await import("./document-engine.mjs");
        const year = detectPublishedYear(chunksArray);
        if (year) {
          store.setPublishedYear(docId, year);
          console.log(`${MODULE_ID} | Auto-detected publication year: ${year}`);
        }
      } catch (e) { /* non-critical */ }

      // ── Generate semantic embeddings (Phase 5 — optional, requires Ollama) ──
      try {
        const embOk = await this._documentEngine.generateEmbeddings(docId, (cur, tot) => {
          if (cur % 10 === 0 || cur === tot) {
            console.log(`${MODULE_ID} | Embedding chunk ${cur}/${tot}`);
            this._updateLibraryCardStatus(docId, `⏳ Embedding ${cur}/${tot} chunks…`, cur / tot);
          }
        });
        if (embOk) {
          console.log(`${MODULE_ID} | Embeddings complete for ${file.name}`);
        } else {
          console.log(`${MODULE_ID} | Embeddings skipped (Ollama unavailable)`);
        }
      } catch (embErr) {
        console.warn(`${MODULE_ID} | Embedding generation failed (non-fatal):`, embErr);
      }

      store.setStatus(docId, "ready");
      this._saveDocuments();
      this._refreshLibraryUI();

      const finishedDoc = store.getDocument(docId);
      const docName = finishedDoc?.displayName;
      ui.notifications.info(`ACE | Processed: ${docName} (${pages.length} pages, ${chunksArray.length} chunks, ${parentCount} sections)`);

      // Cache extraction globally for cross-world reuse
      if (finishedDoc) {
        this._documentEngine.saveDocumentCache(finishedDoc).catch(err =>
          console.warn(`${MODULE_ID} | Document cache save failed:`, err)
        );
      }

    } else if (type === "txt" || type === "md") {
      // ── Text / Markdown: chunk by paragraphs or headings ──
      const text = await file.text();
      const txtResult = await this._documentEngine.chunkTextFile(text, type);
      store.setChunks(docId, txtResult);

      // Auto-extract tags
      const txtChunks = txtResult?.chunks ?? txtResult ?? [];
      const sample = txtChunks.slice(0, 5).map(c => c.text).join(" ");
      const { extractKeywords } = await import("./document-store.mjs");
      const autoTags = extractKeywords(sample, 6);
      store.setTags(docId, autoTags);

      // Auto-detect publication year from copyright text
      try {
        const { detectPublishedYear } = await import("./document-engine.mjs");
        const year = detectPublishedYear(txtChunks);
        if (year) {
          store.setPublishedYear(docId, year);
          console.log(`${MODULE_ID} | Auto-detected publication year: ${year}`);
        }
      } catch (e) { /* non-critical */ }

      // Generate semantic embeddings (Phase 5)
      try {
        await this._documentEngine.generateEmbeddings(docId, (cur, tot) => {
          if (cur % 10 === 0 || cur === tot) {
            console.log(`${MODULE_ID} | Embedding chunk ${cur}/${tot}`);
            this._updateLibraryCardStatus(docId, `⏳ Embedding ${cur}/${tot} chunks…`, cur / tot);
          }
        });
      } catch (_) { /* non-fatal */ }

      store.setStatus(docId, "ready");
      this._saveDocuments();
      this._refreshLibraryUI();

      const finishedDoc = store.getDocument(docId);
      const docName = finishedDoc?.displayName;
      ui.notifications.info(`ACE | Processed: ${docName} (${txtChunks.length} chunks)`);

      // Cache extraction globally for cross-world reuse
      if (finishedDoc) {
        this._documentEngine.saveDocumentCache(finishedDoc).catch(err =>
          console.warn(`${MODULE_ID} | Document cache save failed:`, err)
        );
      }

    } else if (type === "image") {
      // ── Image: store as image reference, no text extraction ──
      const img = new Image();
      const url = URL.createObjectURL(file);
      await new Promise((resolve, reject) => {
        img.onload  = resolve;
        img.onerror = reject;
        img.src     = url;
      });

      const doc = store.getDocument(docId);
      store.addImage(docId, {
        idx:    0,
        page:   0,
        label:  doc?.displayName ?? file.name,
        path:   doc?.storedPath ?? "",
        width:  img.naturalWidth,
        height: img.naturalHeight,
        tags:   [],
      });
      URL.revokeObjectURL(url);

      // Prompt user for image tags
      const tagInput = prompt("Image tags (comma-separated, e.g. 'map, sword coast, cities'):", "");
      if (tagInput) {
        const tags = tagInput.split(",").map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
        store.setTags(docId, tags);
        // Also set image-level tags so image search can match them
        const updatedDoc = store.getDocument(docId);
        if (updatedDoc?.images?.[0]) {
          updatedDoc.images[0].tags = tags;
          store.markDirty();
        }
      }

      store.setStatus(docId, "ready");
      this._saveDocuments();
      this._refreshLibraryUI();

      ui.notifications.info(`ACE | Image uploaded: ${doc?.displayName} (${img.naturalWidth}\u00D7${img.naturalHeight})`);

      // Cache image document globally for cross-world reuse
      const imgDoc = store.getDocument(docId);
      if (imgDoc) {
        this._documentEngine.saveDocumentCache(imgDoc).catch(err =>
          console.warn(`${MODULE_ID} | Document cache save failed:`, err)
        );
      }
    }
  }
}
