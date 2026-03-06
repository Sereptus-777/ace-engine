// ============================================================
// ACE — AI Campaign Engine — GM Assistant Panel (ApplicationV2)
// Tabs: Chat (AI private) | Narration (to players) | Ideas | Encounter | Select
// ============================================================

import { MODULE_ID, localCredentials } from "./ace-engine.mjs";
import { CanvasHighlight } from "./canvas-highlight.mjs";

// v13-safe FilePicker access (for document library uploads)
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ?? // v13+
  globalThis.FilePicker;                                     // v12 fallback

// ── Shared label constants ─────────────────────────────────────
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
const TCC_CONDITION_LIST = [
  "blinded","charmed","deafened","frightened","grappled","incapacitated",
  "invisible","paralyzed","petrified","poisoned","prone","restrained",
  "stunned","unconscious","exhaustion",
];

// ── Dialog compatibility helper ────────────────────────────────
// Uses DialogV2 (Foundry v12+) when available, falls back to legacy Dialog.
// Returns Promise<boolean> — true = confirmed, false = cancelled.
async function _aceConfirmDialog(title, content) {
  // DialogV2 (v12 ApplicationV2-style)
  if (foundry.applications?.api?.DialogV2?.confirm) {
    return foundry.applications.api.DialogV2.confirm({
      window:      { title },
      content,
      yes:         { label: "Save Summary & Close", icon: "fas fa-book-open" },
      no:          { label: "Close Without Saving", icon: "fas fa-times"     },
      rejectClose: false,
    });
  }
  // Legacy Dialog (v10/v11 fallback)
  return Dialog.confirm({ title, content, defaultYes: false });
}

export class AcePanel extends foundry.applications.api.ApplicationV2 {
  constructor({ aiProvider, sceneCtx, npcMemory, lkMemory, suggestionEngine, reputationEngine, subtleRolls, documentEngine, triggerSfx, stopSfx } = {}) {
    super();
    this.ai          = aiProvider;
    this.scene       = sceneCtx;
    this.memory      = npcMemory;
    this.lkMemory    = lkMemory  ?? null;   // AceMemory — persistent campaign log
    this.reputation  = reputationEngine ?? null;  // ReputationEngine — faction word-of-mouth
    this.subtleRolls = subtleRolls ?? null; // SubtleRollManager — blind checks with AI narration
    this._documentEngine = documentEngine ?? null; // DocumentEngine — reference library
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
    this._voicesReady        = false;
    this._browserTtsWarned   = false;
    // Kick-start browser voice loading (Chrome loads them async)
    this._ensureVoicesLoaded().catch(() => {});
    // ── Encounter ──────────────────────────────────────────
    this._lastEncounterText  = "";
    // ── Splash screen ─────────────────────────────────────
    this._showingSplash      = true;  // show grimoire cover on first open
    // ── Session memory ─────────────────────────────────────
    this._isGeneratingSummary = false;
    this._sessionNum          = 1;    // auto-incremented each time End Session is used
    // ── Minimize badge ───────────────────────────────────
    this._savedPosition       = null; // stores position before minimize
    // ── Simple Calendar sync listener ────────────────────
    this._timeSyncHookId = Hooks.on("ace-engine.timeSync", () => this._updateDayCounterUI());
    // ── Select Scene Elements ─────────────────────────────
    this._selectedTokens = new Set();   // actor IDs (players) or token IDs (NPCs)
    this._selectedTiles  = new Set();   // tile IDs
    this._selectedItems  = new Set();   // token IDs (item-type tokens)
    // ── Tactical Command Center ──────────────────────────
    this._tccExpanded  = { stats: false, rolls: false, bulk: false, initiative: false };
    this._tccRollType  = "skill";   // "skill" | "save" | "check"
    this._tccRollMode  = "gm";     // "gm" | "request"
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
      width:  555,   // +25px per side from previous 505
      height: 740,   // +25px from previous 715
      top:    80,
      left:   200,  // Safe default — _onRender moves it to the right side
    },
    actions: {
      // ── Chat tab ───────────────────────────────────────
      sendMessage:         AcePanel._onSendMessage,
      clearChat:           AcePanel._onClearChat,
      voiceInput:          AcePanel._onVoiceInput,
      analyzeNpcTactics:   AcePanel._onAnalyzeNpcTactics,
      copyMessage:         AcePanel._onCopyMessage,
      saveToJournal:       AcePanel._onSaveToJournal,
      // ── Narration tab ──────────────────────────────────
      narrationVoice:      AcePanel._onNarrationVoice,
      polishNarration:     AcePanel._onPolishNarration,
      narrateSend:         AcePanel._onNarrateSend,
      clearNarration:      AcePanel._onClearNarration,
      copyNarration:       AcePanel._onCopyNarration,
      sfxLightning:        AcePanel._onSfxLightning,
      // ── Ideas tab ──────────────────────────────────────
      generateSuggestions: AcePanel._onGenerateSuggestions,
      acceptDirection:     AcePanel._onAcceptDirection,
      dismissDirection:    AcePanel._onDismissDirection,
      // ── Encounter tab ──────────────────────────────────
      generateEncounter:   AcePanel._onGenerateEncounter,
      rollEncounter:       AcePanel._onRollEncounter,
      copyEncounterResult: AcePanel._onCopyEncounterResult,
      sendSubtleRoll:      AcePanel._onSendSubtleRoll,
      // ── Shared (always visible) ────────────────────────
      switchTab:           AcePanel._onSwitchTab,
      stopAudio:           AcePanel._onStopAudio,
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
      // ── Tactical Command Center ────────────────────────
      tccToggleSection:    AcePanel._onTccToggleSection,
      tccGroupRoll:        AcePanel._onTccGroupRoll,
      tccBulkCondition:    AcePanel._onTccBulkCondition,
      tccBulkHp:           AcePanel._onTccBulkHp,
      tccInitJump:         AcePanel._onTccInitJump,
      tccInitMoveUp:       AcePanel._onTccInitMoveUp,
      tccInitMoveDown:     AcePanel._onTccInitMoveDown,
      // ── Crit / Fumble ───────────────────────────────────
      rollCrit:            AcePanel._onRollCrit,
      rollFumble:          AcePanel._onRollFumble,
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
      libToggleDoc:        AcePanel._onLibToggleDoc,
      libEditName:         AcePanel._onLibEditName,
      libEditTags:         AcePanel._onLibEditTags,
      libDeleteDoc:        AcePanel._onLibDeleteDoc,
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
      <!-- ── Grimoire Splash Screen ──────────────────────────── -->
      <div class="ace-splash" id="ace-splash">

        <!-- Full-panel book cover -->
        <img src="modules/ace-engine/assets/book-cover.png"
             class="ace-splash-img" alt="ACE Grimoire"
             onerror="this.style.display='none'">

        <!-- Small X — top-right, closes the panel entirely -->
        <button class="ace-splash-close"
                data-action="closeSplash"
                aria-label="Close ACE"
                title="Close (Esc)">
          <i class="fas fa-times"></i>
        </button>

        <!-- Pulsing gem overlay — sits over the amethyst gem on the book cover.
             Adjust --ace-gem-x / --ace-gem-y in ace-engine.css if alignment is off. -->
        <button class="ace-gem-btn"
                data-action="openFromSplash"
                aria-label="Open ACE"
                title="Open ACE">
          <span class="ace-gem-ring ace-gem-ring-1"></span>
          <span class="ace-gem-ring ace-gem-ring-2"></span>
          <span class="ace-gem-core"></span>
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
        <!-- Universal stop button — always visible on every tab -->
        <button class="ace-btn ace-btn-stop-audio" data-action="stopAudio"
                title="Stop all audio — halts narration TTS and thunder sound">
          <i class="fas fa-stop-circle"></i>
        </button>
      </nav>

      <!-- ── Survival Tracker — always visible ────────────── -->
      ${this._buildSurvivalBar()}

      <!-- ═══════════════════════════════════════════════════
           CHAT TAB — Private AI conversation (GM only)
           ═══════════════════════════════════════════════════ -->
      <div class="ace-tab-content ${this._activeTab === "chat" ? "active" : ""}" data-tab-content="chat">
        <div class="ace-chat-log" id="ace-chat-log">
          ${this._renderChatMessages()}
        </div>
        <!-- ── Gold Divider Bar with quick actions ── -->
        <div class="ace-gold-divider">
          <button class="ace-divider-action" data-action="analyzeNpcTactics"
                  title="Get a specific tactic suggestion for the current NPC's turn">
            <i class="fas fa-chess-knight"></i> NPC Tactics
          </button>
          <div class="ace-input-spacer"></div>
          <button class="ace-divider-action" data-action="clearChat"
                  title="Clear AI conversation">
            <i class="fas fa-trash-alt"></i> Clear
          </button>
        </div>
        <!-- ── Input Area ── -->
        <div class="ace-chat-input">
          <textarea id="ace-input"
                    placeholder="${game.i18n.localize("ACE.Panel.Placeholder")}"
                    rows="2"></textarea>
          <div class="ace-input-actions">
            <button class="ace-btn ace-btn-mic ${this._isListening ? "ace-btn-mic-active" : ""}"
                    data-action="voiceInput"
                    title="Quick voice — speaks and auto-sends to AI">
              <i class="fas ${this._isListening ? "fa-circle ace-mic-pulse" : "fa-microphone"}"></i>
            </button>
            <div class="ace-input-spacer"></div>
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
          <div class="ace-input-spacer"></div>
          <button class="ace-divider-action" data-action="endSession"
                  ${this._isGeneratingSummary ? "disabled" : ""}
                  title="Generate a session summary and save it to the ACE journal">
            <i class="fas ${this._isGeneratingSummary ? "fa-spinner fa-spin" : "fa-book-open"}"></i>
            ${this._isGeneratingSummary ? "Saving…" : "End Session"}
          </button>
          <button class="ace-divider-action" data-action="memoryManagement"
                  title="Open Memory Management — view, export, import, backup category data">
            <i class="fas fa-database"></i> Memory
          </button>
        </div>
        <!-- TTS Status Indicator -->
        ${this._renderTtsStatus()}
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
          <textarea id="ace-narration-input"
                    placeholder="Type or speak narration to send to all players… (accepted story ideas stream here for review)"
                    rows="3"></textarea>
          <div class="ace-input-actions">
            <button class="ace-btn ace-btn-mic ${this._narrationListening ? "ace-btn-mic-active" : ""}"
                    data-action="narrationVoice"
                    title="Speak narration — fills textarea for review before sending">
              <i class="fas ${this._narrationListening ? "fa-circle ace-mic-pulse" : "fa-microphone"}"></i>
            </button>
            <button class="ace-btn ace-btn-polish" data-action="polishNarration"
                    title="AI Polish — add punctuation, capitalize, and clean up spoken text">
              <i class="fas fa-magic"></i>
            </button>
            <div class="ace-input-spacer"></div>
            <button class="ace-btn ace-btn-narrate-send" data-action="narrateSend"
                    ${this._isNarrationStreaming ? "disabled" : ""}
                    title="Send narration to ALL players via Foundry chat + speak aloud">
              <i class="fas fa-scroll"></i> To Players
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
          <button class="ace-btn ace-btn-sm" data-action="generateSuggestions"
                  title="Generate new directions">
            <i class="fas fa-sync-alt"></i> Refresh
          </button>
        </div>
        <div class="ace-directions-list" id="ace-suggestions">
          ${this._renderSuggestions()}
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════
           ENCOUNTER TAB — Encounter generator
           ═══════════════════════════════════════════════════ -->
      <div class="ace-tab-content ${this._activeTab === "encounter" ? "active" : ""}" data-tab-content="encounter">
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
        <div class="ace-encounter-gen-input-wrap">
          <textarea id="ace-encounter-prompt"
                    class="ace-encounter-gen-input"
                    placeholder="Describe what you want (e.g. 'goblin ambush on a forest road'). Leave blank to auto-generate from scene."
                    rows="3"></textarea>
        </div>
        <!-- ── Crit / Fumble Tables — above encounter so result is never clipped ── -->
        <div class="ace-cf-bar">
          <span class="ace-cf-label">Roll:</span>
          <button class="ace-btn ace-btn-crit" data-action="rollCrit"
                  title="Draw a random Critical Hit result (nat 20)">
            🎯 Crit
          </button>
          <button class="ace-btn ace-btn-fumble" data-action="rollFumble"
                  title="Draw a random Fumble result (nat 1)">
            💥 Fumble
          </button>
        </div>
        <div class="ace-cf-result" id="ace-cf-result" style="display:none"></div>

        <div class="ace-encounter-result" id="ace-encounter">
          <p class="ace-placeholder">
            <strong>Generate</strong> — builds a complete, ready-to-run encounter from scratch.<br><br>
            <strong>Random Roll</strong> — secretly rolls based on current terrain. Clear, Signs of Danger, or full encounter.
          </p>
        </div>

        ${this._renderSubtleRollsSection()}

      </div>

      <!-- ═══════════════════════════════════════════════════
           SELECT SCENE ELEMENTS TAB — Pick tokens/tiles/items for AI context
           ═══════════════════════════════════════════════════ -->
      <div class="ace-tab-content ${this._activeTab === "elements" ? "active" : ""}" data-tab-content="elements">
        ${this._buildSelectElementsPanel()}
      </div>

      <!-- ═══════════════════════════════════════════════════
           LIBRARY TAB — Document uploads for AI reference
           ═══════════════════════════════════════════════════ -->
      <div class="ace-tab-content ${this._activeTab === "library" ? "active" : ""}" data-tab-content="library">
        ${this._buildLibraryPanel()}
      </div>
    `;
  }

  // ── Survival Bar Builder ────────────────────────────────────

  _buildSurvivalBar() {
    const m = this._tracker.scenesSinceMeal;
    const r = this._tracker.scenesSinceRest;
    const mealClass = m >= 8  ? "ace-survival-crit" : m >= 4  ? "ace-survival-warn" : "";
    const restClass = r >= 15 ? "ace-survival-crit" : r >= 8  ? "ace-survival-warn" : "";
    const mealHrs = Math.round((Date.now() - this._tracker.mealTime) / 3_600_000 * 10) / 10;
    const restHrs = Math.round((Date.now() - this._tracker.restTime) / 3_600_000 * 10) / 10;
    return `
      <div class="ace-survival-bar" id="ace-survival-bar">
        <span class="ace-survival-label">Track:</span>
        <span class="ace-survival-chip ${mealClass}" id="ace-chip-meal"
              title="Scenes since last meal (${mealHrs}h real time)">
          🍖 ${m} scene${m !== 1 ? "s" : ""}
        </span>
        <button class="ace-survival-reset" data-action="mealReset"
                title="Mark — party just ate a meal">✓ Meal</button>
        <span class="ace-survival-sep">|</span>
        <span class="ace-survival-chip ${restClass}" id="ace-chip-rest"
              title="Scenes since last rest (${restHrs}h real time)">
          💤 ${r} scene${r !== 1 ? "s" : ""}
        </span>
        <button class="ace-survival-reset" data-action="restReset"
                title="Mark — party just took a rest">✓ Rest</button>
        ${this._buildDayCounterHtml()}
        <span class="ace-survival-sep">|</span>
        <button class="ace-deed-toggle" data-action="toggleDeedLogger" title="Log a notable deed">📜</button>
      </div>
      ${this._buildDeedLoggerHtml()}
    `;
  }

  // ── Select Scene Elements — Data Gathering ────────────────

  /** Get all player character tokens (always available, regardless of scene) */
  _getPlayerTokens() {
    const seen = new Set();
    const players = [];

    // 1. User-assigned characters (always)
    for (const user of game.users) {
      const actor = user.character;
      if (!actor) continue;
      if (seen.has(actor.id)) continue;
      seen.add(actor.id);
      players.push({
        id:       actor.id,
        name:     actor.name,
        img:      actor.prototypeToken?.texture?.src || actor.img,
        type:     "player",
        selected: this._selectedTokens.has(actor.id),
      });
    }

    // 2. Any "character"-type actors with player ownership (catches unassigned PCs)
    for (const actor of game.actors) {
      if (actor.type !== "character") continue;
      if (seen.has(actor.id)) continue;
      if (!actor.hasPlayerOwner) continue;
      seen.add(actor.id);
      players.push({
        id:       actor.id,
        name:     actor.name,
        img:      actor.prototypeToken?.texture?.src || actor.img,
        type:     "player",
        selected: this._selectedTokens.has(actor.id),
      });
    }

    return players;
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
        img:      t.document.texture?.src || t.actor?.img,
        type:     "npc",
        selected: this._selectedTokens.has(t.id),
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
        img:      t.document.texture?.src || t.actor?.img,
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
          <button class="ace-btn ace-btn-sm" data-action="clearSelection" title="Clear all selections">
            <i class="fas fa-times-circle"></i> Clear
          </button>
        </div>

        <!-- Players Section — always available -->
        <section class="ace-el-section">
          <h4 class="ace-el-section-header"><i class="fas fa-users"></i> Players <span class="ace-el-count">${players.length}</span></h4>
          ${players.length ? `<div class="ace-el-grid">${players.map(p => this._buildElementCard(p)).join("")}</div>`
            : `<p class="ace-el-empty">No player characters assigned</p>`}
        </section>

        <!-- NPCs Section — current scene only -->
        <section class="ace-el-section">
          <h4 class="ace-el-section-header"><i class="fas fa-skull"></i> NPCs <span class="ace-el-count">${npcs.length}</span></h4>
          ${npcs.length ? `<div class="ace-el-grid">${npcs.map(n => this._buildElementCard(n)).join("")}</div>`
            : `<p class="ace-el-empty">No NPCs in current scene</p>`}
        </section>

        <!-- Tiles Section — current scene only -->
        <section class="ace-el-section">
          <h4 class="ace-el-section-header"><i class="fas fa-image"></i> Tiles <span class="ace-el-count">${tiles.length}</span></h4>
          ${tiles.length ? `<div class="ace-el-grid">${tiles.map(t => this._buildElementCard(t)).join("")}</div>`
            : `<p class="ace-el-empty">No tiles in current scene</p>`}
        </section>

        <!-- Items Section — current scene only -->
        <section class="ace-el-section">
          <h4 class="ace-el-section-header"><i class="fas fa-gem"></i> Items <span class="ace-el-count">${items.length}</span></h4>
          ${items.length ? `<div class="ace-el-grid">${items.map(it => this._buildElementCard(it)).join("")}</div>`
            : `<p class="ace-el-empty">No items placed in current scene</p>`}
        </section>

        ${this._buildTccBar()}

      </div>
    `;
  }

  _buildElementCard(el) {
    // Check if this NPC's actor is ACE-linked (persistent memory flag)
    const isLinked = el.type === "npc" && el.actorId && this._isActorLinked(el.actorId);
    const linkedClass = isLinked ? "ace-el-linked" : "";

    return `
      <div class="ace-el-card ${el.selected ? "ace-el-selected" : ""} ${linkedClass}"
           data-action="toggleElement"
           data-el-id="${el.id}" data-el-type="${el.type}"
           data-actor-id="${el.actorId ?? ""}"
           title="${el.name}${isLinked ? " (ACE Linked — memory persists)" : ""}">
        <div class="ace-el-img-wrap">
          <img class="ace-el-img" src="${el.img}" alt="${el.name}" loading="lazy"
               onerror="this.src='icons/svg/mystery-man.svg'"/>
          <div class="ace-el-check"><i class="fas fa-check"></i></div>
        </div>
        <span class="ace-el-name">${el.name}</span>
        ${el.type === "npc" && el.actorId ? `
          <button class="ace-el-link-btn ${isLinked ? "ace-el-link-active" : ""}"
                  data-action="toggleLink"
                  data-actor-id="${el.actorId}"
                  title="${isLinked ? "Unlink — stop tracking this NPC" : "Link — ACE will remember this NPC across scenes"}">
            <i class="fas ${isLinked ? "fa-link" : "fa-unlink"}"></i>
          </button>
        ` : ""}
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

    // Refresh Quick Stats if expanded
    this.refreshTccStats();
  }

  static _onClearSelection() {
    this._selectedTokens.clear();
    this._selectedTiles.clear();
    this._selectedItems.clear();
    // Release all canvas selections
    canvas?.tokens?.releaseAll();
    canvas?.tiles?.releaseAll();
    // Re-render just the select panel content
    const container = this.element.querySelector('[data-tab-content="elements"]');
    if (container) container.innerHTML = this._buildSelectElementsPanel();
    this._wireSelectPanelEvents();
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
    if (!this.rendered || this._activeTab !== "elements") return;
    const container = this.element.querySelector('[data-tab-content="elements"]');
    if (container) {
      container.innerHTML = this._buildSelectElementsPanel();
      this._wireSelectPanelEvents();
    }
  }

  /** Wire hover + double-click events for element cards */
  _wireSelectPanelEvents() {
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
        ${this._buildTccQuickStats()}
        ${this._buildTccGroupRolls()}
        ${this._buildTccBulkActions()}
        ${inCombat ? this._buildTccInitiative() : ""}
      </div>
    `;
  }

  _buildTccQuickStats() {
    const exp = this._tccExpanded.stats;
    const actors = this._resolveSelectedActors();

    let content;
    if (!actors.length) {
      content = `<p class="ace-el-empty">Select tokens to view stats</p>`;
    } else {
      content = actors.map(({ actor }) => {
        const hp    = actor.system?.attributes?.hp;
        const hpVal = hp?.value ?? 0;
        const hpMax = hp?.max ?? 1;
        const pct   = Math.round((hpVal / Math.max(hpMax, 1)) * 100);
        const ac    = actor.system?.attributes?.ac?.value ?? "—";
        const spd   = actor.system?.attributes?.movement?.walk ?? "—";
        const conds = (actor.effects ?? [])
          .filter(e => !e.disabled)
          .map(e => e.name || e.label || "")
          .filter(Boolean)
          .join(", ");
        const img   = actor.prototypeToken?.texture?.src || actor.img || "icons/svg/mystery-man.svg";

        return `
          <div class="ace-tcc-stat-row">
            <img class="ace-tcc-stat-img" src="${img}" alt="${actor.name}"
                 onerror="this.src='icons/svg/mystery-man.svg'" />
            <span class="ace-tcc-stat-name" title="${actor.name}">${actor.name}</span>
            <span class="ace-tcc-stat-hp" title="HP: ${hpVal}/${hpMax}">
              <span class="ace-tcc-hp-fill" style="width:${pct}%"></span>
              <span class="ace-tcc-hp-text">${hpVal}/${hpMax}</span>
            </span>
            <span class="ace-tcc-stat-ac" title="Armor Class">AC ${ac}</span>
            <span class="ace-tcc-stat-spd" title="Speed">${spd}ft</span>
            ${conds ? `<span class="ace-tcc-stat-cond" title="${conds}">${conds}</span>` : ""}
          </div>`;
      }).join("");
    }

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

    return `
      <div class="ace-tcc-section ${exp ? "expanded" : ""}">
        <div class="ace-tcc-section-header" data-action="tccToggleSection" data-tcc-section="rolls">
          <i class="fas fa-dice"></i> GROUP ROLLS
          <i class="fas fa-chevron-down ace-tcc-chevron"></i>
        </div>
        <div class="ace-tcc-section-body" style="display:${exp ? "block" : "none"}">
          <div class="ace-tcc-roll-types">
            <button class="ace-tcc-roll-type-btn ${type === "skill" ? "active" : ""}" data-roll-type="skill">Skill</button>
            <button class="ace-tcc-roll-type-btn ${type === "save"  ? "active" : ""}" data-roll-type="save">Save</button>
            <button class="ace-tcc-roll-type-btn ${type === "check" ? "active" : ""}" data-roll-type="check">Check</button>
          </div>
          <select class="ace-tcc-roll-select" id="ace-tcc-roll-id">
            ${this._buildTccRollOptions(type)}
          </select>
          <div class="ace-tcc-roll-mode">
            <button class="ace-tcc-mode-btn ${mode === "gm"      ? "active" : ""}" data-roll-mode="gm">GM Roll</button>
            <button class="ace-tcc-mode-btn ${mode === "request" ? "active" : ""}" data-roll-mode="request">Request</button>
          </div>
          <button class="ace-btn ace-tcc-roll-execute" data-action="tccGroupRoll">
            <i class="fas fa-dice-d20"></i> ${mode === "gm" ? "Roll for Selected" : "Request from Players"}
          </button>
        </div>
      </div>`;
  }

  _buildTccRollOptions(type) {
    const labels = type === "skill" ? TCC_SKILL_LABELS : TCC_ABILITY_LABELS;
    return Object.entries(labels)
      .map(([id, name]) => `<option value="${id}">${name}</option>`)
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
      return `
        <div class="ace-tcc-init-chip ${isCurrent ? "ace-tcc-init-current" : ""} ${isNpc ? "ace-tcc-init-npc" : ""}${defeated}"
             data-action="tccInitJump" data-turn-index="${index}"
             title="${name} \u2014 Init ${init}${c.isDefeated ? " [DEFEATED]" : ""}">
          <span class="ace-tcc-init-num">${init}</span>
          <span class="ace-tcc-init-name">${truncated}</span>
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
      statsBody.innerHTML = actors.map(({ actor }) => {
        const hp    = actor.system?.attributes?.hp;
        const hpVal = hp?.value ?? 0;
        const hpMax = hp?.max ?? 1;
        const pct   = Math.round((hpVal / Math.max(hpMax, 1)) * 100);
        const ac    = actor.system?.attributes?.ac?.value ?? "\u2014";
        const spd   = actor.system?.attributes?.movement?.walk ?? "\u2014";
        const conds = (actor.effects ?? []).filter(e => !e.disabled).map(e => e.name || e.label || "").filter(Boolean).join(", ");
        const img   = actor.prototypeToken?.texture?.src || actor.img || "icons/svg/mystery-man.svg";
        return `
          <div class="ace-tcc-stat-row">
            <img class="ace-tcc-stat-img" src="${img}" alt="${actor.name}" onerror="this.src='icons/svg/mystery-man.svg'" />
            <span class="ace-tcc-stat-name" title="${actor.name}">${actor.name}</span>
            <span class="ace-tcc-stat-hp" title="HP: ${hpVal}/${hpMax}">
              <span class="ace-tcc-hp-fill" style="width:${pct}%"></span>
              <span class="ace-tcc-hp-text">${hpVal}/${hpMax}</span>
            </span>
            <span class="ace-tcc-stat-ac" title="Armor Class">AC ${ac}</span>
            <span class="ace-tcc-stat-spd" title="Speed">${spd}ft</span>
            ${conds ? `<span class="ace-tcc-stat-cond" title="${conds}">${conds}</span>` : ""}
          </div>`;
      }).join("");
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
    if (!rollId) { ui.notifications?.warn("ACE: Select a roll type."); return; }

    target.disabled = true;
    let rolled = 0;
    for (const { actor, isPlayer } of actors) {
      // Request mode: whisper to owning player to ask them to roll
      if (rollMode === "request" && isPlayer) {
        const ownerUser = game.users.find(u => !u.isGM && actor.testUserPermission(u, "OWNER"));
        if (ownerUser) {
          const labels = rollType === "skill" ? TCC_SKILL_LABELS : TCC_ABILITY_LABELS;
          const label  = labels[rollId] ?? rollId;
          const typeLabel = rollType === "skill" ? "Skill Check"
                          : rollType === "save"  ? "Saving Throw" : "Ability Check";
          await ChatMessage.create({
            content: `<div class="ace-group-roll-request"><i class="fas fa-dice-d20"></i> <strong>${actor.name}</strong>, please roll a <strong>${label} ${typeLabel}</strong>.</div>`,
            whisper: [ownerUser.id],
            speaker: ChatMessage.getSpeaker({ alias: "ACE" }),
          });
          rolled++;
        }
        continue;
      }
      // GM rolls directly (for NPCs always, or GM mode for everyone)
      try {
        if (rollType === "skill") {
          try { await actor.rollSkill({ skill: rollId }); }
          catch { await actor.rollSkill(rollId); }  // v3 fallback
        } else if (rollType === "save") {
          try { await actor.rollSavingThrow({ ability: rollId }); }
          catch { await actor.rollSavingThrow(rollId); }
        } else {
          try { await actor.rollAbilityCheck({ ability: rollId }); }
          catch { await actor.rollAbilityCheck(rollId); }
        }
        rolled++;
      } catch (err) {
        console.error(`${MODULE_ID} | TCC group roll error for ${actor.name}:`, err);
      }
    }
    target.disabled = false;
    ui.notifications?.info(`ACE: ${rolled} roll${rolled !== 1 ? "s" : ""} ${rollMode === "request" ? "requested" : "executed"}.`);
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
    // Roll type buttons (Skill / Save / Check)
    const typeButtons = this.element.querySelectorAll(".ace-tcc-roll-type-btn");
    for (const btn of typeButtons) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._tccRollType = btn.dataset.rollType;
        typeButtons.forEach(b => b.classList.toggle("active", b === btn));
        const select = this.element.querySelector("#ace-tcc-roll-id");
        if (select) select.innerHTML = this._buildTccRollOptions(this._tccRollType);
      });
    }

    // Mode buttons (GM Roll / Request)
    const modeButtons = this.element.querySelectorAll(".ace-tcc-mode-btn");
    for (const btn of modeButtons) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._tccRollMode = btn.dataset.rollMode;
        modeButtons.forEach(b => b.classList.toggle("active", b === btn));
        const execBtn = this.element.querySelector(".ace-tcc-roll-execute");
        if (execBtn) {
          execBtn.innerHTML = this._tccRollMode === "gm"
            ? '<i class="fas fa-dice-d20"></i> Roll for Selected'
            : '<i class="fas fa-paper-plane"></i> Request from Players';
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
                <button class="ace-icon-btn" data-action="copyMessage" data-index="${i}" title="Copy">
                  <i class="fas fa-copy"></i>
                </button>
                <button class="ace-icon-btn" data-action="saveToJournal" data-index="${i}" title="Save to Journal">
                  <i class="fas fa-book"></i>
                </button>
              </div>
            ` : ""}
          </div>
          <div class="ace-msg-body">${this._renderMarkdown(msg.content)}</div>
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
    // Position to right side of screen on first render
    if (!this._positioned) {
      this._positioned = true;
      const targetLeft = Math.max(20, window.innerWidth - (this.position?.width ?? 555) - 24);
      try { this.setPosition({ left: targetLeft }); } catch (_) { /* ignore */ }
    }

    // Full-panel drag — works in splash AND panel mode, binds once
    this._initPanelDrag();

    // ── Splash mode: hide Foundry header, skip all panel wiring ──
    if (this._showingSplash) {
      this.element.classList.add("ace-splash-mode");
      return;
    }
    // Panel mode: ensure header is visible
    this.element.classList.remove("ace-splash-mode");

    // ── Inject minimize "-" button into header (next to close X) ──
    const header = this.element.querySelector(".window-header, header");
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

    // Narration textarea — Enter sends to players
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

    // Wire hover events for Select Scene Elements panel
    if (this._activeTab === "elements") {
      this._wireSelectPanelEvents();
    }
  }

  /**
   * Override close() to offer an "End Session" prompt when the GM hits X,
   * Escape, or any other close trigger — as long as there are unsaved events
   * and no summary is already in progress.
   *
   * Passes _aceForceClose: true internally so the second call bypasses this check
   * and doesn't recurse.
   */
  async close(options = {}) {
    // Only intercept for the GM when there are unsaved events
    if (
      !options._aceForceClose &&
      this.lkMemory &&
      !this._isGeneratingSummary &&
      this.lkMemory.getEventsSinceLastSummary().length > 0
    ) {
      const eventCount = this.lkMemory.getEventsSinceLastSummary().length;

      const content =
        `<p>There are <strong>${eventCount}</strong> unsaved events since your last session summary.</p>` +
        `<p>Generate and save a <strong>Session Summary</strong> to the journal before closing?</p>`;

      // Use DialogV2 (v12+) if available, fall back to legacy Dialog
      const save = await _aceConfirmDialog("End Session?", content).catch(() => false);

      if (save) {
        await this._runEndSession();
      }
    }

    // Normal close (fire-and-forget guard prevents double-prompt)
    return super.close({ ...options, _aceForceClose: true });
  }

  _onClose(options) {
    if (this._unsubSuggestions) {
      this._unsubSuggestions();
      this._unsubSuggestions = null;
    }
    // Unhook Simple Calendar time sync listener
    if (this._timeSyncHookId !== undefined) {
      Hooks.off("ace-engine.timeSync", this._timeSyncHookId);
      this._timeSyncHookId = undefined;
    }
    this._stopVoice();
    this._stopNarrationVoice();
    this._cancelTTS();
  }

  // ── Tab Actions ────────────────────────────────────────────

  static _onSwitchTab(event, target) {
    const tab = target.dataset.tab;
    if (!tab) return;
    this._activeTab = tab;
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
   * GM clicks the pulsing gem on the grimoire cover → animate it out,
   * then re-render the full tabbed panel UI.
   */
  static async _onOpenFromSplash(event, target) {
    const splash = this.element?.querySelector("#ace-splash");
    if (splash) {
      splash.classList.add("ace-splash-opening");
      await new Promise((r) => setTimeout(r, 450));
    }
    this._showingSplash = false;
    this.render();
  }

  /** X button — closes the panel entirely without entering the UI. */
  static _onCloseSplash(event, target) {
    this.close();
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
      ".ace-chat-messages",     // chat response text
      ".ace-narration-preview", // narration output
      ".ace-ideas-cards",       // idea cards
      ".ace-encounter-output",  // encounter analysis
      ".ace-select-output",     // select panel output
      ".ace-response",          // any AI response block
      ".ace-cf-result",         // crit/fumble results
      ".ace-message-body",      // message body text
      "pre", "code",            // code blocks
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

  /** NE rivet X — close with save (same as End Session + close) */
  static async _onBadgeClose(event, target) {
    event.stopPropagation();
    this._teardownBadgeDrag();
    // Restore first so endSession dialog works
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
    // Trigger end session flow (includes save prompt)
    await AcePanel._onEndSession.call(this, event, target);
  }

  // ── Survival Tracker Actions ────────────────────────────────

  static _onMealReset(event, target) {
    this._tracker.scenesSinceMeal = 0;
    this._tracker.mealTime        = Date.now();
    this._updateTrackerUI();
    ui.notifications.info("🍖 Meal logged — tracker reset.");
  }

  static _onRestReset(event, target) {
    this._tracker.scenesSinceRest = 0;
    this._tracker.restTime        = Date.now();
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

  // ── Crit / Fumble Actions ────────────────────────────────────

  static _onRollCrit(event, target) {
    this._showCritFumble("crit");
  }

  static _onRollFumble(event, target) {
    this._showCritFumble("fumble");
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
    if (msg) {
      navigator.clipboard.writeText(msg.content);
      ui.notifications.info("Copied to clipboard!");
    }
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

  // ── Narration tab Actions ──────────────────────────────────

  static _onNarrationVoice(event, target) {
    if (this._narrationListening) this._stopNarrationVoice();
    else this._startNarrationVoice();
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

  // ── Ideas tab Actions ──────────────────────────────────────

  static async _onGenerateSuggestions(event, target) {
    target.disabled = true;
    target.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    try {
      const directions = await this.suggestions.generateSuggestions();
      this._directions = [...directions];
      this._refreshSuggestionsUI();
    } catch (err) {
      ui.notifications.error(`ACE: ${err.message}`);
    }
    target.disabled = false;
    target.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
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

  // ── Encounter tab Actions ──────────────────────────────────

  static async _onGenerateEncounter(event, target) {
    const analyzeBtn = this.element.querySelector('[data-action="rollEncounter"]');
    target.disabled = true;
    if (analyzeBtn) analyzeBtn.disabled = true;
    target.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Weaving...';
    try {
      const promptInput = this.element.querySelector("#ace-encounter-prompt");
      await this._generateEncounter(promptInput?.value?.trim() ?? "");
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
  _renderSubtleRollsSection() {
    let enabled;
    try { enabled = game.settings.get(MODULE_ID, "enableSubtleRolls"); } catch { enabled = false; }
    if (!enabled) return "";

    // Build skill options from setting
    let skillIds;
    try { skillIds = (game.settings.get(MODULE_ID, "subtleRollSkills") || "ins,his,arc,rel,nat,prc,inv,sur,med").split(",").map(s => s.trim()); }
    catch { skillIds = ["ins","his","arc","rel","nat","prc","inv","sur","med"]; }

    const SKILL_LABELS = {
      acr: "Acrobatics",  ani: "Animal Handling", arc: "Arcana",
      ath: "Athletics",   dec: "Deception",       his: "History",
      ins: "Insight",     itm: "Intimidation",    inv: "Investigation",
      med: "Medicine",    nat: "Nature",          prc: "Perception",
      prf: "Performance", per: "Persuasion",      rel: "Religion",
      slt: "Sleight of Hand", ste: "Stealth",     sur: "Survival",
    };

    const skillOptions = skillIds
      .filter(id => SKILL_LABELS[id])
      .map(id => `<option value="${id}">${SKILL_LABELS[id]}</option>`)
      .join("");

    // Build player checkboxes (non-GM users with characters)
    const playerCheckboxes = (game.users?.filter(u => !u.isGM && u.active) ?? [])
      .map(u => {
        const char = u.character;
        if (!char) return "";
        const name = char.name || u.name;
        return `<label class="ace-subtle-player-label">
          <input type="checkbox" class="ace-subtle-player-cb"
                 data-user-id="${u.id}" data-actor-id="${char.id}" checked />
          ${name}
        </label>`;
      })
      .filter(Boolean)
      .join("");

    return `
      <!-- ── Subtle Rolls Section ─────────────────────── -->
      <div class="ace-subtle-rolls-section">
        <div class="ace-subtle-header">
          <i class="fas fa-eye-slash"></i> Subtle Rolls — Blind Checks
        </div>

        <div class="ace-subtle-controls">
          <div class="ace-subtle-row">
            <label class="ace-subtle-label" for="ace-subtle-skill">Skill</label>
            <select id="ace-subtle-skill" class="ace-subtle-select">
              ${skillOptions}
            </select>
          </div>
          <div class="ace-subtle-row">
            <label class="ace-subtle-label" for="ace-subtle-dc">DC</label>
            <input id="ace-subtle-dc" type="number" class="ace-subtle-input"
                   value="15" min="1" max="30" step="1" />
          </div>
        </div>

        <div class="ace-subtle-players">
          ${playerCheckboxes || '<span class="ace-subtle-no-players">No active players</span>'}
        </div>

        <div class="ace-subtle-flavor-wrap">
          <input id="ace-subtle-flavor" type="text" class="ace-subtle-flavor"
                 placeholder="Flavor text (optional): 'Something about this story doesn't add up...'" />
        </div>

        <button class="ace-btn ace-btn-subtle-send" data-action="sendSubtleRoll">
          <i class="fas fa-eye-slash"></i> Send Blind Roll Request
        </button>
      </div>`;
  }

  // ── Core: AI Chat ──────────────────────────────────────────

  async _sendMessage() {
    // Stop mic FIRST so it doesn't keep writing to the input after we read it
    if (this._isListening) this._stopVoice();

    const input = this.element.querySelector("#ace-input");
    const text  = input?.value?.trim();
    if (!text || this._isStreaming) return;

    this._chatHistory.push({ role: "user", content: text, timestamp: Date.now() });
    input.value = "";
    this._refreshChatUI();

    const history  = this._chatHistory.slice(0, -1).map(({ role, content }) => ({ role, content }));
    const sceneCtx = this.scene?.gather() ?? "";
    const npcMem   = this._buildNpcContext();

    // Document Library: inject relevant reference chunks based on the user's message
    const docCtx   = this._buildDocumentContext(text);
    const fullMem  = docCtx ? `${npcMem}\n\n${docCtx}` : npcMem;

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
              catch { return null; }
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
    const dispEnabled = game.settings.get(MODULE_ID, "enableDispositionTags") ?? true;
    if (dispEnabled && this.reputation && this._chatHistory[aiMsgIndex]) {
      try {
        const fullResponse = this._chatHistory[aiMsgIndex].content;
        const dispTag = this.reputation.parseDispositionTag(fullResponse);
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
      } catch (err) {
        console.warn(`${MODULE_ID} | Disposition tag parsing failed:`, err);
      }
    }

    this._isStreaming = false;
    this._setInputState(true);
    this._refreshChatUI();
    this._scrollChatToBottom();
    // Note: AI chat responses are NOT read aloud — TTS is Narration tab only.
  }

  // ── Core: Narration Send ───────────────────────────────────

  /**
   * Sends the narration textarea content to ALL players via Foundry chat
   * AND speaks it aloud via ElevenLabs / browser TTS.
   * No AI response — this is pure GM-to-players broadcast.
   */
  async _narrateSendMessage() {
    // Stop mic FIRST so it doesn't keep writing to the textarea after we clear it
    if (this._narrationListening) this._stopNarrationVoice();

    const input = this.element.querySelector("#ace-narration-input");
    const text  = input?.value?.trim();
    if (!text || this._isNarrationStreaming) return;

    input.value = "";

    // Sanitise for inline HTML
    const safe = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Styled narration block in the Foundry chat log
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

    // Track in narration history
    this._narrationHistory.push({ content: text, timestamp: Date.now() });
    this._refreshNarrationUI();
    this._scrollNarrationToBottom();

    // Log to persistent memory (compact — not full text)
    this.lkMemory?.logNarration(text);

    // ── Narrative time: parse time cues from narration text ──
    try {
      const enableTime = game.settings.get("ace-engine", "enableNarrativeTime");
      if (enableTime && this.lkMemory) {
        const cues = AcePanel._parseNarrativeTimeCues(text);
        if (cues) {
          if (cues.advanceDays) {
            this.lkMemory.advanceDay(cues.advanceDays, cues.timeOfDay ?? "morning");
            console.log(`ace-engine | Narrative time: advanced ${cues.advanceDays} day(s) → Day ${this.lkMemory.getDayCounter()} (${cues.timeOfDay ?? "morning"})`);
          } else if (cues.timeOfDay) {
            this.lkMemory.setTimeOfDay(cues.timeOfDay);
            console.log(`ace-engine | Narrative time: set to ${cues.timeOfDay}`);
          }
          this._updateDayCounterUI();
        }
      }
    } catch (_) { /* non-critical */ }

    // Always speak narration aloud — ElevenLabs if key set, browser TTS otherwise
    this._speakText(text);
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
        await this.lkMemory.saveSessionSummary({
          sessionNum: this._sessionNum,
          date:       new Date().toISOString().slice(0, 10),
          sceneName:  canvas?.scene?.name ?? "",
          summary,
          partyNames,
        });
        this._sessionNum++;

        this._pushSystemNote(
          `📖 **Session ${this._sessionNum - 1} Summary saved to journal** — check the "📖 ACE" folder.\n\n${summary.slice(0, 300)}${summary.length > 300 ? "…" : ""}`,
        );
        ui.notifications?.info("ACE: Session summary saved to journal.");

        // Auto-backup all categories on session end
        try {
          await this.lkMemory.backup();
          console.log(`${MODULE_ID} | Session end: all memory categories backed up.`);
        } catch (bkErr) {
          console.warn(`${MODULE_ID} | Session end backup failed:`, bkErr);
        }
      }
    } catch (err) {
      console.error(`${MODULE_ID} | End session error:`, err);
      ui.notifications?.error("ACE: Failed to generate session summary — see console.");
    }

    this._isGeneratingSummary = false;
    this._updateEndSessionButton();
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
      `When the session is over, click **End Session** on the Narration tab to save a journal summary.`
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
  _updateEndSessionButton() {
    const btn = this.element?.querySelector("[data-action='endSession']");
    if (!btn) return;
    btn.disabled = this._isGeneratingSummary;
    btn.innerHTML = this._isGeneratingSummary
      ? '<i class="fas fa-spinner fa-spin"></i> Saving…'
      : '<i class="fas fa-book-open"></i> End Session';
  }

  // ── Story Direction → Narration Textarea ──────────────────

  /**
   * When GM accepts a story direction, AI generates a read-aloud passage
   * and streams it into the Narration tab's textarea for review/edit
   * before the GM decides to send it to players.
   */
  async _generateReadAloudToNarration(direction) {
    const sceneCtx = this.scene?.gather() ?? "";
    const npcMem   = this._buildNpcContext();
    const docCtx   = this._buildDocumentContext(direction.title);
    const fullMem  = docCtx ? `${npcMem}\n\n${docCtx}` : npcMem;

    const prompt = `The GM has chosen this story direction: "${direction.title}". ${direction.description} ${direction.consequence}

Write a short read-aloud passage (2-4 sentences) the GM speaks to players RIGHT NOW to transition into this moment. Requirements:
- Second person, present tense ("You hear...", "As you step forward...", "A shadow crosses...")
- Vivid sensory detail — one sound, one sight, one feeling
- End with a hook that draws players toward this direction
- No game mechanics, dice, or stats
- Keep it concise — this is spoken aloud at the table`;

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
    }

    this._isNarrationStreaming = false;
    textarea.disabled          = false;
    textarea.placeholder       = origPlaceholder;
    textarea.focus();
  }

  // ── NPC Tactics (auto + manual) ───────────────────────────

  async suggestNpcTactic(combat, combatant) {
    if (!combatant) return;
    const sceneCtx = this.scene?.gather() ?? "";
    const npcMem   = this._buildNpcContext();
    const npcName  = combatant.name;
    const docCtx   = this._buildDocumentContext(npcName);
    const fullTacticMem = docCtx ? `${npcMem}\n\n${docCtx}` : npcMem;

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
    const npcMem    = this._buildNpcContext();
    const sceneName = canvas?.scene?.name ?? "";
    const docCtx    = this._buildDocumentContext(userPrompt || sceneName);
    const encMem    = docCtx ? `${npcMem}\n\n${docCtx}` : npcMem;
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
List each enemy with:
- Name & type (CR or difficulty rating)
- Key stats: HP, AC, main attack
- Any special abilities worth flagging

### Terrain & Positioning
Describe the battlefield, cover, hazards, and where enemies begin.

### Tactics
How do the enemies open? How do they react when hurt? When do they flee?

### Read-Aloud Text
> *The boxed text the GM reads aloud to players when the encounter begins.*

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
    } catch (err) {
      container.innerHTML = `<p class="ace-error"><i class="fas fa-exclamation-triangle"></i> ${err.message}</p>`;
    }
  }

  async _rollRandomEncounter() {
    const container = this.element.querySelector("#ace-encounter");
    if (!container) return;

    const roll      = await new Roll("1d20").evaluate({ async: true });
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
      const severity = result >= 19 ? "dangerous and serious" : "challenging but manageable";
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

    // Track confirmed (final) text separately from in-progress interim text
    this._narFinalTranscript = input?.value ?? "";   // preserve any existing text

    this._narrationListening = true;

    if (micBtn) {
      micBtn.innerHTML = '<i class="fas fa-circle ace-mic-pulse"></i>';
      micBtn.classList.add("ace-btn-mic-active");
      micBtn.title = "Recording — click mic to stop, or edit & send";
    }
    if (input) {
      input.placeholder = "🎙 Recording… click mic or Send to finish";
    }

    this._narrationRecognition.onresult = (event) => {
      // Build transcript from finalized + interim segments
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const segment = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          this._narFinalTranscript += segment;
        } else {
          interim += segment;
        }
      }
      if (input) input.value = this._narFinalTranscript + interim;
    };

    this._narrationRecognition.onerror = (event) => {
      console.warn(`${MODULE_ID} | Narration voice error:`, event.error);
      // "no-speech" and "aborted" are non-fatal — let continuous mode restart
      if (event.error !== "no-speech" && event.error !== "aborted") {
        this._stopNarrationVoice();
        ui.notifications.warn(`Narration voice: ${event.error}. Check microphone permissions.`);
      }
    };

    this._narrationRecognition.onend = () => {
      // In continuous mode, the browser may still fire onend (e.g. long silence).
      // Auto-restart if we're still supposed to be listening.
      if (this._narrationListening) {
        try {
          this._narrationRecognition.start();
        } catch (_) {
          // Can't restart — stop gracefully
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
    // Null out handlers BEFORE .stop() to prevent late async onresult from
    // writing the transcript back into the textarea after we've cleared it.
    if (this._narrationRecognition) {
      this._narrationRecognition.onresult = null;
      this._narrationRecognition.onend    = null;
      this._narrationRecognition.onerror  = null;
      try { this._narrationRecognition.stop(); } catch (_) { /* already stopped */ }
    }
    this._narrationRecognition = null;

    const micBtn = this.element?.querySelector('[data-action="narrationVoice"]');
    const input  = this.element?.querySelector("#ace-narration-input");

    if (micBtn) {
      micBtn.innerHTML = '<i class="fas fa-microphone"></i>';
      micBtn.classList.remove("ace-btn-mic-active");
      micBtn.title = "Speak narration — fills textarea for review before sending";
    }
    if (input && this._narOrigPlaceholder) {
      input.placeholder = this._narOrigPlaceholder;
    }

    // Commit any remaining final transcript to the input, with basic cleanup
    if (input && this._narFinalTranscript) {
      input.value = this._cleanupTranscript(this._narFinalTranscript);
    }
    this._narFinalTranscript = "";
    this._narOrigPlaceholder = "";
  }

  /**
   * Basic punctuation/capitalization cleanup for speech-to-text output.
   * The browser SpeechRecognition API gives raw words with no punctuation.
   * This adds: sentence-initial caps, trailing period, and trims whitespace.
   */
  _cleanupTranscript(raw) {
    let text = raw.trim();
    if (!text) return text;

    // Capitalize first letter
    text = text.charAt(0).toUpperCase() + text.slice(1);

    // Add trailing period if no terminal punctuation
    if (!/[.!?…]$/.test(text)) text += ".";

    // Clean up extra spaces (speech API sometimes doubles them)
    text = text.replace(/\s{2,}/g, " ");

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
    this._chatVoiceCommitted = "";  // finalized text so far

    this._isListening = true;
    if (micBtn) {
      micBtn.innerHTML = '<i class="fas fa-circle ace-mic-pulse"></i>';
      micBtn.classList.add("ace-btn-mic-active");
      micBtn.title = "Listening — click to stop, then press ASK AI";
    }
    if (input) {
      input.value       = "";
      input.placeholder = "🎙 Listening… click mic to stop, then ASK AI";
      input.disabled    = false;
    }

    this._recognition.onresult = (event) => {
      // Rebuild: all finalized segments + current interim
      let committed = "";
      let interim   = "";
      for (let i = 0; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          committed += text;
        } else {
          interim += text;
        }
      }
      this._chatVoiceCommitted = committed;
      if (input) input.value = (committed + interim).trim();
    };

    this._recognition.onerror = (event) => {
      console.warn(`${MODULE_ID} | Voice error:`, event.error);
      if (event.error !== "no-speech" && event.error !== "aborted") {
        this._stopVoice();
        ui.notifications.warn(`ACE voice: ${event.error}. Check microphone permissions.`);
      }
    };

    this._recognition.onend = () => {
      // Continuous mode can fire onend unexpectedly (browser quirk) — restart if still listening
      if (this._isListening) {
        try { this._recognition?.start(); } catch (_) { this._stopVoice(); }
      }
    };

    try {
      this._recognition.start();
    } catch (e) {
      console.error(`${MODULE_ID} | Voice start failed:`, e);
      this._stopVoice();
    }
  }

  _stopVoice() {
    this._isListening = false;
    try { this._recognition?.stop(); } catch (_) { /* already stopped */ }
    this._recognition = null;

    const micBtn = this.element?.querySelector('[data-action="voiceInput"]');
    const input  = this.element?.querySelector("#ace-input");

    if (micBtn) {
      micBtn.innerHTML = '<i class="fas fa-microphone"></i>';
      micBtn.classList.remove("ace-btn-mic-active");
      micBtn.title = "Voice input — click to speak";
    }
    // Apply cleanup to finalized text
    if (input && this._chatVoiceCommitted) {
      input.value = this._cleanupTranscript(this._chatVoiceCommitted);
    }
    if (input) {
      input.placeholder = this._chatVoiceOrigPh ?? "Ask ACE anything...";
    }
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
      return `<div class="ace-tts-status ace-tts-eleven">
        <i class="fas fa-broadcast-tower"></i>
        <span>ElevenLabs TTS active <span class="ace-tts-src">(${source})</span></span>
      </div>`;
    }
    return `<div class="ace-tts-status ace-tts-browser" data-action="openTtsSettings" style="cursor:pointer;" title="Click to open Module Settings">
      <i class="fas fa-volume-up"></i>
      <span>Browser TTS — set ElevenLabs key in <em>Module Settings → ElevenLabs API Key</em> for premium voice</span>
    </div>`;
  }

  async _speakText(text) {
    if (!text) return;
    this._cancelTTS();
    const clean = this._cleanForSpeech(text);
    if (!clean) return;
    try {
      const { key: elevenKey, source } = this._getElevenLabsKey();

      if (elevenKey) {
        console.log(`${MODULE_ID} | TTS: ElevenLabs key found (from ${source}) — using ElevenLabs narrator`);
        await this._speakElevenLabs(clean, elevenKey);
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
        await this._speakBrowser(clean);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | TTS error (outer):`, err);
      try { await this._speakBrowser(clean); } catch (_) {}
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

  async _speakElevenLabs(text, apiKey) {
    // config.local.json takes priority; fall back to Settings, then hardcoded defaults
    const voiceId =
      localCredentials?.elevenLabsVoiceId ||
      game.settings.get(MODULE_ID, "elevenLabsVoiceId") ||
      "o3hzbFqcuIw2MRzP8rQf";
    const modelId =
      localCredentials?.elevenLabsModel ||
      game.settings.get(MODULE_ID, "elevenLabsModel") ||
      "eleven_multilingual_v2";
    const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    try {
      const resp = await fetch(endpoint, {
        method:  "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", "Accept": "audio/mpeg" },
        body:    JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.35, use_speaker_boost: true },
        }),
      });

      if (!resp.ok) {
        console.warn(`${MODULE_ID} | ElevenLabs error ${resp.status}`);
        await this._speakBrowser(text);
        return;
      }

      const blob    = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      this._ttsAudio = new Audio(blobUrl);
      this._ttsAudio.playbackRate = 1.1;  // ~10% faster narration
      this._ttsAudio.onended = () => { URL.revokeObjectURL(blobUrl); this._ttsAudio = null; };
      this._ttsAudio.onerror = () => { URL.revokeObjectURL(blobUrl); this._ttsAudio = null; };
      await this._ttsAudio.play();
    } catch (err) {
      console.error(`${MODULE_ID} | ElevenLabs TTS failed:`, err);
      await this._speakBrowser(text);
    }
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
  _pickBrowserVoice(voices) {
    // 1) User-specified voice name from settings
    let userVoiceName = "";
    try { userVoiceName = game.settings.get(MODULE_ID, "browserVoiceName") ?? ""; } catch (_) {}
    if (userVoiceName.trim()) {
      const exact = voices.find((v) => v.name === userVoiceName.trim());
      if (exact) return exact;
      const partial = voices.find((v) => v.name.toLowerCase().includes(userVoiceName.trim().toLowerCase()));
      if (partial) return partial;
    }

    // 2) Auto-detect best available voice (priority: neural/online > Google > legacy > any)
    // Filter to English voices first
    const enVoices = voices.filter(v => /^en/i.test(v.lang));

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

  async _speakBrowser(text) {
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

      const chosen = this._pickBrowserVoice(voices);

      if (chosen) {
        this._ttsUtterance.voice = chosen;
        console.log(`${MODULE_ID} | Browser TTS: using voice "${chosen.name}" (${chosen.lang})`);
      } else {
        console.warn(`${MODULE_ID} | Browser TTS: no preferred voice found — using system default. ${voices.length} voices available: ${voices.map(v => v.name).join(", ")}`);
      }

      this._ttsUtterance.onend  = () => { this._ttsUtterance = null; };
      this._ttsUtterance.onerror = (e) => {
        const err = e.error ?? e;
        if (err === "interrupted" || err === "canceled") {
          console.log(`${MODULE_ID} | Browser TTS: previous utterance ${err} (normal when re-narrating).`);
        } else {
          console.error(`${MODULE_ID} | Browser TTS utterance error:`, err);
        }
        this._ttsUtterance = null;
      };
      window.speechSynthesis.speak(this._ttsUtterance);
      console.log(`${MODULE_ID} | Browser TTS: speaking "${text.slice(0, 60)}…"`);
    } catch (err) {
      console.error(`${MODULE_ID} | Browser TTS failed:`, err);
    }
  }

  _cancelTTS() {
    if (this._ttsAudio) {
      this._ttsAudio.pause();
      this._ttsAudio.src = "";
      this._ttsAudio = null;
    }
    if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel();
    this._ttsUtterance = null;
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
  _buildNpcContext() {
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

    return parts.join("\n\n");
  }

  /**
   * Build document library context for AI prompt injection.
   * Uses the user's message + scene context for relevance matching.
   * @param {string} userMessage - The user's current message/query
   * @returns {string} Formatted reference library block, or ""
   */
  _buildDocumentContext(userMessage = "") {
    if (!this._documentEngine) return "";
    try {
      const enableLib = game.settings.get(MODULE_ID, "enableDocumentLibrary") ?? true;
      if (!enableLib) return "";
      const sceneCtx = this.scene?.gather() ?? "";
      const sceneName = canvas?.scene?.name ?? "";
      const budget = game.settings.get(MODULE_ID, "docContextBudget") ?? 2000;
      return this._documentEngine.buildDocumentContext(sceneCtx, userMessage, sceneName, budget);
    } catch (err) {
      console.warn(`${MODULE_ID} | Document context error:`, err);
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
      const ctx = this.reputation.buildReputationContext(name);
      if (ctx) contextParts.push(ctx);
      if (contextParts.length >= 2) break; // limit to avoid bloating prompt
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
    } catch { return null; }
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

    // ── 2. Senses attribute ──────────────────────────────────
    const senses = actor.system?.attributes?.senses ?? {};
    if (senses.blindsight > 0) traits.push(`Blindsight ${senses.blindsight}ft`);
    if (senses.tremorsense > 0) traits.push(`Tremorsense ${senses.tremorsense}ft`);
    if (senses.truesight > 0) traits.push(`Truesight ${senses.truesight}ft`);

    const specialSenses = (senses.special ?? "").toLowerCase();
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
      msgEl.innerHTML = this._renderMarkdown(this._chatHistory[index].content);
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
  }

  _scrollNarrationToBottom() {
    const log = this.element?.querySelector("#ace-narration-log");
    if (log) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
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

  _escapeHtml(text) {
    if (!text) return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
    if (!this.element || this._showingSplash) return;
    const m = this._tracker.scenesSinceMeal;
    const r = this._tracker.scenesSinceRest;

    // Update meal chip
    const mealChip = this.element.querySelector("#ace-chip-meal");
    if (mealChip) {
      mealChip.textContent = `🍖 ${m} scene${m !== 1 ? "s" : ""}`;
      mealChip.className   = "ace-survival-chip" +
        (m >= 8 ? " ace-survival-crit" : m >= 4 ? " ace-survival-warn" : "");
    }

    // Update rest chip
    const restChip = this.element.querySelector("#ace-chip-rest");
    if (restChip) {
      restChip.textContent = `💤 ${r} scene${r !== 1 ? "s" : ""}`;
      restChip.className   = "ace-survival-chip" +
        (r >= 15 ? " ace-survival-crit" : r >= 8 ? " ace-survival-warn" : "");
    }
  }

  _checkSurvivalReminders() {
    const m = this._tracker.scenesSinceMeal;
    const r = this._tracker.scenesSinceRest;

    // Warn at 4 scenes without food, critical at 8
    if (m === 4) {
      this._pushSystemNote("🍖 The party hasn't eaten in a while. If this is Ravenloft or a survival campaign, consider prompting for a meal — or start tracking exhaustion.");
    } else if (m === 8) {
      this._pushSystemNote("🍖⚠️ **Hunger Warning** — The party has gone through 8+ scenes without eating. In survival rules, they may be risking exhaustion. Consider a meal check or prompt.", true);
    }

    // Warn at 8 scenes without rest, critical at 15
    if (r === 8) {
      this._pushSystemNote("💤 The party has been active for 8+ scenes without rest. Consider offering a short rest opportunity.");
    } else if (r === 15) {
      this._pushSystemNote("💤⚠️ **Exhaustion Warning** — The party has pushed through 15+ scenes without a long rest. Exhaustion rules may apply. Time for camp?", true);
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

    // 2. Ask AI for a unique 1-sentence narrative
    const weapon   = weaponName || "their weapon";
    const target   = targetName ? ` against ${targetName}` : "";
    const aiPrompt = type === "crit"
      ? `You are a vivid D&D narrator. Write ONE dramatic sentence (max 25 words) describing ${actorName} scoring a critical hit with ${weapon}${target}. Be specific to these characters. Flavor only — no game mechanics.`
      : `You are a vivid D&D narrator. Write ONE dramatic yet slightly comic sentence (max 25 words) describing ${actorName} fumbling an attack with ${weapon}. Be specific to this character. Flavor only — no game mechanics.`;

    let narrative = "";
    try {
      await this.ai.chatStream(aiPrompt, "", "", [], (chunk) => { narrative += chunk; });
      narrative = narrative.trim().replace(/^["'""'']|["'""'']$/gu, "").trim();
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

    // 5. Speak via TTS narrator
    const ttsText = `${evtLabel}! ${narrative}${showMech ? " " + mechText : ""}`;
    this._speakText(ttsText);

    // 5b. Push to ACE Narration log so the GM can see it in the panel
    const lkEntry = `${emoji} **${evtLabel} — ${actorName}**: "${narrative}"${showMech ? "\n\n" + mechText : ""}`;
    this._narrationHistory.push({ content: lkEntry, timestamp: Date.now() });
    this._refreshNarrationUI();
    this._scrollNarrationToBottom();

    // 6. Mirror the result in the panel Encounter tab (if the panel is open)
    if (this.rendered) {
      const container = this.element?.querySelector("#ace-cf-result");
      if (container) {
        container.style.display = "";
        container.className     = `ace-cf-result ${isCrit ? "ace-cf-crit" : "ace-cf-fumble"}`;
        container.innerHTML     =
          `<div class="ace-cf-header">` +
          `<span class="ace-cf-type-label">${isCrit ? "🎯 Critical Hit" : "💥 Fumble"}` +
          `<span class="ace-cf-roll-num">d${table.length}: ${idx + 1}</span></span>` +
          `<div class="ace-msg-actions"><button class="ace-icon-btn" data-action="copyCritFumble" title="Copy">` +
          `<i class="fas fa-copy"></i></button></div></div>` +
          mechHTML;
        container.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      }
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

  // ── Crit / Fumble Table ─────────────────────────────────────

  _showCritFumble(type) {
    const table  = type === "crit" ? AcePanel.CRIT_TABLE : AcePanel.FUMBLE_TABLE;
    const idx    = Math.floor(Math.random() * table.length);
    const roll   = idx + 1;
    const result = table[idx];
    const label  = type === "crit" ? "🎯 Critical Hit" : "💥 Fumble";
    const cls    = type === "crit" ? "ace-cf-crit"      : "ace-cf-fumble";

    const container = this.element?.querySelector("#ace-cf-result");
    if (!container) return;

    container.style.display = "";
    container.className     = `ace-cf-result ${cls}`;
    container.innerHTML     = `
      <div class="ace-cf-header">
        <span class="ace-cf-type-label">${label}
          <span class="ace-cf-roll-num">d${table.length}: ${roll}</span>
        </span>
        <div class="ace-msg-actions">
          <button class="ace-icon-btn" data-action="copyCritFumble" title="Copy">
            <i class="fas fa-copy"></i>
          </button>
        </div>
      </div>
      ${result}
    `;
    container.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }

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
          <textarea id="ace-deed-input" class="ace-deed-input"
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
    const stats = store?.getStats() ?? { totalDocuments: 0, enabledDocuments: 0, totalChunks: 0, totalImages: 0 };

    return `
      <div class="ace-library">

        <!-- Upload dropzone -->
        <div class="ace-library-dropzone" id="ace-library-dropzone"
             data-action="libUploadClick" title="Drop files here or click to upload">
          <i class="fas fa-cloud-upload-alt"></i>
          <span class="ace-library-drop-label">Drop files here or click to upload</span>
          <span class="ace-library-formats">PDF, TXT, MD, PNG, JPG, WEBP</span>
          <input type="file" id="ace-library-file-input"
                 accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp"
                 multiple style="display:none">
        </div>

        <!-- Stats bar -->
        <div class="ace-library-stats">
          <span title="Total documents">\u{1F4C4} ${stats.totalDocuments} doc${stats.totalDocuments !== 1 ? "s" : ""}</span>
          <span class="ace-library-stats-sep">\u00B7</span>
          <span title="Active documents">\u2705 ${stats.enabledDocuments} active</span>
          <span class="ace-library-stats-sep">\u00B7</span>
          <span title="Text chunks extracted">\u{1F9E9} ${stats.totalChunks} chunks</span>
          ${stats.totalImages > 0 ? `<span class="ace-library-stats-sep">\u00B7</span><span title="Image references">\u{1F5BC} ${stats.totalImages} image${stats.totalImages !== 1 ? "s" : ""}</span>` : ""}
        </div>

        <!-- Document list -->
        <div class="ace-library-list" id="ace-library-list">
          ${docs.length
            ? docs.map(d => this._buildDocumentCard(d)).join("")
            : `<div class="ace-library-empty">
                 <i class="fas fa-book-open"></i>
                 <p>No documents uploaded yet</p>
                 <p class="ace-library-empty-hint">Upload PDFs, text files, or map images to give the AI reference material about your campaign world.</p>
               </div>`}
        </div>
      </div>
    `;
  }

  _buildDocumentCard(doc) {
    const typeIcons = { pdf: "fa-file-pdf", txt: "fa-file-alt", md: "fa-file-code", image: "fa-image" };
    const icon = typeIcons[doc.type] ?? "fa-file";
    const statusClass = doc.status === "ready" ? "ace-lib-ready"
                      : doc.status === "processing" ? "ace-lib-processing"
                      : doc.status === "error" ? "ace-lib-error" : "";
    const statusLabel = doc.status === "processing" ? "\u23F3 Processing\u2026"
                      : doc.status === "error" ? `\u274C ${doc.error || "Error"}`
                      : doc.status === "uploading" ? "\u{1F4E4} Uploading\u2026" : "";

    const chunkCount = doc.chunks?.length ?? 0;
    const imageCount = doc.images?.length ?? 0;
    const tags = doc.tags ?? [];

    let meta = doc.type.toUpperCase();
    if (doc.pageCount) meta += ` \u00B7 ${doc.pageCount} pages`;
    if (chunkCount) meta += ` \u00B7 ${chunkCount} chunks`;
    if (imageCount) meta += ` \u00B7 ${imageCount} image${imageCount !== 1 ? "s" : ""}`;

    const sizeKB = doc.fileSize ? Math.round(doc.fileSize / 1024) : 0;
    if (sizeKB) meta += ` \u00B7 ${sizeKB >= 1024 ? (sizeKB / 1024).toFixed(1) + " MB" : sizeKB + " KB"}`;

    return `
      <div class="ace-library-card ${statusClass} ${!doc.enabled ? "ace-lib-disabled" : ""}" data-doc-id="${doc.id}">
        <div class="ace-library-card-icon">
          <i class="fas ${icon}"></i>
        </div>
        <div class="ace-library-card-info">
          <div class="ace-library-card-name" data-action="libEditName" data-doc-id="${doc.id}"
               title="Click to rename">${doc.displayName}</div>
          <div class="ace-library-card-meta">${meta}</div>
          ${statusLabel ? `<div class="ace-library-card-status">${statusLabel}</div>` : ""}
          ${tags.length ? `<div class="ace-library-card-tags">${tags.map(t => `<span class="ace-library-tag">${t}</span>`).join("")}</div>` : ""}
        </div>
        <div class="ace-library-card-actions">
          <button class="ace-lib-action" data-action="libToggleDoc" data-doc-id="${doc.id}"
                  title="${doc.enabled ? "Disable" : "Enable"} for AI context">
            <i class="fas ${doc.enabled ? "fa-eye" : "fa-eye-slash"}"></i>
          </button>
          <button class="ace-lib-action" data-action="libEditTags" data-doc-id="${doc.id}"
                  title="Edit tags">
            <i class="fas fa-tags"></i>
          </button>
          <button class="ace-lib-action ace-lib-action-delete" data-action="libDeleteDoc" data-doc-id="${doc.id}"
                  title="Delete document">
            <i class="fas fa-trash-alt"></i>
          </button>
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

  /** Refresh the Library tab content and re-wire events. */
  _refreshLibraryUI() {
    const container = this.element?.querySelector('[data-tab-content="library"]');
    if (container) {
      container.innerHTML = this._buildLibraryPanel();
      this._wireLibraryEvents();
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
    const fileInput = this.element.querySelector("#ace-library-file-input");
    fileInput?.click();
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
      "Delete Document",
      `<p>Are you sure you want to delete <strong>${doc.displayName}</strong>?</p>` +
      `<p>This removes the document record and all extracted text chunks. The original file in the library/ folder is not deleted.</p>`
    );
    if (!confirmed) return;

    store.removeDocument(docId);
    this._saveDocuments();
    this._refreshLibraryUI();
    ui.notifications.info(`ACE | Deleted document: ${doc.displayName}`);
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
    const store = this._documentEngine?._mm?.documents;
    if (!store) {
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
        const result = await _FP().upload("data", libDir, file, { notify: false });
        storedPath = result.path;
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
      });

      store.setPageCount(docId, pages.length);

      const chunks = this._documentEngine.chunkPages(pages);
      store.setChunks(docId, chunks);

      // Auto-extract document-level tags from first few chunks
      const sample = chunks.slice(0, 5).map(c => c.text).join(" ");
      const { extractKeywords } = await import("./document-store.mjs");
      const autoTags = extractKeywords(sample, 6);
      store.setTags(docId, autoTags);

      store.setStatus(docId, "ready");
      this._saveDocuments();
      this._refreshLibraryUI();

      const docName = store.getDocument(docId)?.displayName;
      ui.notifications.info(`ACE | Processed: ${docName} (${pages.length} pages, ${chunks.length} chunks)`);

    } else if (type === "txt" || type === "md") {
      // ── Text / Markdown: chunk by paragraphs or headings ──
      const text = await file.text();
      const chunks = this._documentEngine.chunkTextFile(text, type);
      store.setChunks(docId, chunks);

      // Auto-extract tags
      const sample = chunks.slice(0, 5).map(c => c.text).join(" ");
      const { extractKeywords } = await import("./document-store.mjs");
      const autoTags = extractKeywords(sample, 6);
      store.setTags(docId, autoTags);

      store.setStatus(docId, "ready");
      this._saveDocuments();
      this._refreshLibraryUI();

      const docName = store.getDocument(docId)?.displayName;
      ui.notifications.info(`ACE | Processed: ${docName} (${chunks.length} chunks)`);

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
    }
  }
}
