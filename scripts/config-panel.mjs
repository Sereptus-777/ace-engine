// ─── ACE: Engine — Configuration Panel (popup) ─────────────────────────────
// Tabbed config panel that holds every non-essential setting. The standard
// Foundry "Configure Settings" page keeps only the master toggle, AI
// Provider dropdown, and API Key. Everything else opens here via the
// "Open Configuration" menu button.
//
// Architecture mirrors ACE: Forge / ACE: QOL — extends ApplicationV2 directly
// (NOT HandlebarsApplicationMixin), builds HTML programmatically in
// _renderHTML, wires events manually in _replaceHTML. The Handlebars-mixin
// flavor wasn't being instantiated by registerMenu in this Foundry build,
// hence the "Open Configuration" button doing nothing — the ApplicationV2-
// direct flavor is the proven path.

import { getDeprecationFor } from "./remote-catalog.mjs";
import { getSecret, getSecretVault } from "./settings.mjs";
import { setSecret, setSecretVault, isSecretKey, fetchElevenLabsVoices } from "./settings.mjs";

const MODULE_ID = "ace-engine";
const { ApplicationV2 } = foundry.applications.api;

// ⚠️ MASKING IS DERIVED, NOT DUPLICATED. This used to be a hand-kept list and
// it had already drifted: "chatApiKey" was missing, so that key rendered as a
// plain TEXT box and sat on screen in the clear — during a livestream, that is
// the key gone. isSecretKey() is the single source of truth; only the voice key
// is added, because it is stored client-side under its own name.
const _EXTRA_SECRET_KEYS = new Set(["elevenLabsApiKey"]);
const isMaskedKey = (key) => isSecretKey(key) || _EXTRA_SECRET_KEYS.has(key);

// ── Provider defaults ─────────────────────────────────────────────────────
// Mirrors AceSettings.PROVIDER_DEFAULTS (kept local to avoid circular import
// since settings.mjs imports this file). When the AI Provider dropdown
// changes, we use these to auto-fill the URL + Model fields with sane values.
const PROVIDER_DEFAULTS = {
    openai:     { apiUrl: "https://api.openai.com",       modelName: "gpt-4o-mini" },
    anthropic:  { apiUrl: "https://api.anthropic.com",    modelName: "claude-sonnet-4-20250514" },
    ollama:     { apiUrl: "http://localhost:11434",       modelName: "llama3.2" },
    lmstudio:   { apiUrl: "http://localhost:1234",        modelName: "default" },
    openrouter: { apiUrl: "https://openrouter.ai/api",    modelName: "openai/gpt-4o-mini" },
    custom:     { apiUrl: "http://localhost:8080",        modelName: "default" },
};

// ─── Provider guidance (plain English) ────────────────────────────────────
// One short "what is this, and should I pick it" blurb per provider, written
// for a GM who has never touched an API key. No jargon, no model-speak.
//
// The two browser notes are load-bearing, not filler: OpenAI refuses direct
// calls from a browser (so it silently fails inside Foundry no matter how
// good the key is), and Ollama needs OLLAMA_ORIGINS set or Foundry can't
// reach it. Both of those have burned real setup time; surfacing them at the
// moment of choosing is the whole point of this screen.
const PROVIDER_GUIDE = {
    openrouter: {
        badge: "Recommended", tone: "good", needsKey: true,
        keyLabel: "Get an OpenRouter key", keyUrl: "https://openrouter.ai/keys",
        cost: "Well under $1 for a four-hour session on the recommended cheap model — about $1–2 a month if you play weekly. $10 of credit lasts most tables for months.",
        lines: [
            "One key reaches almost every model — GPT, Claude, Gemini, and dozens of cheap open ones.",
            "Works properly inside Foundry's browser window.",
            "Pay as you go — top up once and forget about it.",
        ],
    },
    ollama: {
        badge: "Free — runs on your PC", tone: "good", needsKey: false,
        keyLabel: "Download Ollama (free)", keyUrl: "https://ollama.com/download",
        cost: "Nothing, ever. It runs on your own graphics card — you pay only the electricity.",
        lines: [
            "Completely free — the model runs on your own computer. No key, no bills, no internet needed.",
            "Needs a reasonably strong graphics card, and quality depends on which model you download.",
            "Ollama must be started with OLLAMA_ORIGINS set to * or Foundry cannot reach it.",
        ],
    },
    anthropic: {
        badge: "Best writing quality", tone: "good", needsKey: true,
        keyLabel: "Get an Anthropic key", keyUrl: "https://console.anthropic.com/settings/keys",
        cost: "Roughly $1–3 a session, so about $10 a month for a weekly game. Best writing, biggest bill.",
        lines: [
            "Claude — the strongest, most in-character NPC writing of the bunch.",
            "Noticeably pricier per message than the cheap models on OpenRouter.",
        ],
    },
    openai: {
        badge: "Usually blocked in Foundry", tone: "warn", needsKey: true,
        keyLabel: "Get an OpenAI key", keyUrl: "https://platform.openai.com/api-keys",
        cost: "Similar to OpenRouter for the same models — but read the warning above before spending anything.",
        lines: [
            "OpenAI refuses direct calls from a browser, so this often fails inside Foundry no matter how good your key is.",
            "To use GPT models, choose OpenRouter instead — same models, and it works here.",
        ],
    },
    lmstudio: {
        badge: "Free — runs on your PC", tone: "good", needsKey: false,
        keyLabel: "Download LM Studio (free)", keyUrl: "https://lmstudio.ai/",
        cost: "Nothing, ever. It runs on your own graphics card — you pay only the electricity.",
        lines: [
            "Free local models with a friendly desktop app — no key and no bills.",
            "Start the LM Studio server before playing, and leave it running.",
        ],
    },
    custom: {
        badge: "Advanced", tone: "neutral", needsKey: false,
        keyLabel: "", keyUrl: "",
        cost: "Whatever your own server charges you.",
        lines: [
            "Any server that speaks the OpenAI format. Set its exact address under Advanced settings below.",
        ],
    },
};

// ─── Tab → Setting Key Map ────────────────────────────────────────────────
// Single source of truth for which setting belongs in which tab.
//
// A tab has TWO key lists. `keys` is what a table actually touches and shows
// straight away. `advancedKeys` is the numbers and limits, tucked into a
// collapsed "Advanced settings" block at the bottom of that same tab.
//
// ⚠️ THERE IS NO LONGER A GLOBAL ADVANCED TAB, and there should never be one
// again. Everything on it turned out to be NPC settings, sitting a whole tab
// away from the NPC screen they belong to - plus the two token limits, which
// were ALSO already inside AI Setup's own advanced block. The same two
// settings appeared on two different screens, so whichever one you edited,
// the other looked wrong. Advanced belongs INSIDE the thing it is advanced
// about. Johnny, 2026-08-21: "probably every tab should have an advanced
// panel."
const ADVANCED_AI_KEYS = [
    "apiUrl", "chatModel", "digestModel", "chatApiKey", "digestApiKey",
    "gameSystem", "customInstructions", "maxContextTokens", "maxResponseTokens",
];

/** Everything a tab owns, open or collapsed. Search and Reset must use this. */
const tabKeys = (tab) => [...(tab?.keys ?? []), ...(tab?.advancedKeys ?? [])];

const TABS = [
    {
        id: "ai", label: "AI Setup", icon: "fa-solid fa-microchip",
        intro: "Four steps to get ACE talking. Pick a provider, paste its key, choose a model, then press Test — if the test comes back green, you're done.",
        keys: ["aiProvider", "modelName", "apiKey"],
        advancedKeys: ADVANCED_AI_KEYS,
    },
    {
        id: "voice", label: "Voice & TTS", icon: "fa-solid fa-microphone",
        intro: "ElevenLabs for high-quality NPC voices, browser TTS as a free fallback. Set your API key here, pick narrator voices, tune the playback model.",
        // ⚠️ ORDER IS THE UX HERE. What a table actually touches is the key and the
        // narrator voice; everything else is once-in-fifty-sessions. The browser
        // fallback voices go LAST because they only exist when ElevenLabs is
        // absent, and having them up top next to identically-worded "Narrator
        // Voice" settings is what made this screen unreadable.
        // Five things a table actually sets: where the voice comes from, the
        // key, the narrator, an optional second voice, and how loud it is.
        keys: ["voiceProvider", "elevenLabsApiKey", "elevenLabsVoiceId", "elevenLabsFemaleVoiceId", "narrationVolume"],
        // ⚠️ The two custom-voice-id settings were REGISTERED AND SURFACED
        // NOWHERE - same bug the backup keys had. They are reachable now. They
        // also matter far less since the pickers list the GM's own voices, but
        // a GM who has the override switched on needs to be able to find it,
        // because while it is on the narrator dropdown is being ignored.
        advancedKeys: ["elevenLabsModel", "narratorVoiceOverrideEnabled", "narratorVoiceOverrideId",
                       "browserVoiceName", "browserFemaleVoiceName", "browserVoiceRate", "browserVoicePitch"],
    },
    {
        id: "npc", label: "NPC Chat", icon: "fa-solid fa-comment",
        intro: "Talk to any NPC in their own voice. A bio is a short backstory and personality, so a creature has something of its own to say — ACE Engine writes one the first time it matters.",
        // ⚠️ Only what a table actually touches. Every raw number moved to
        // Advanced: people want to install and play, not set budgets.
        keys: ["npcChatEnabled", "autoGenerateBio", "tokenDropAI", "alwaysRunItemAndLoot", "skipBioForSummons", "autoLinkSummons", "enableAutoLink", "defaultVoiceRegion"],
        // Every one of these came off the old global Advanced tab. All five are
        // NPC settings and always were - how much a creature is allowed to know,
        // how often a faction throws up a spy or a wildcard, and where the
        // portrait art lives.
        advancedKeys: ["npcKnowledgeBudget", "npcKnowledgeCap", "factionSpyChance", "factionWildcardChance", "npcWebpFolder"],
    },
    {
        id: "items", label: "Items & Attunement", icon: "fa-solid fa-link",
        intro: "Item lifecycle UX — auto-prompt for attunement when a magic item needing it is added to a PC's inventory, honoring the 3-item attunement limit. More item-lifecycle features will land here over time (auto-equip suggestions, ration tracking, magic item identification flow).",
        keys: ["attunementPromptEnabled"],
    },
    {
        id: "combat", label: "Combat", icon: "fa-solid fa-shield-alt",
        intro: "Initiative reorder arrows, auto-XP on kill, auto-move dead NPCs to the X ☠ Fallen folder.",
        keys: ["initiativeReorder", "autoDistributeXP", "autoCleanupDead"],
    },
    {
        id: "memory", label: "Memory & World", icon: "fa-solid fa-book",
        intro: "Story notes, fame & reputation, subtle rolls, survival tracker, narrative time — and the world backup system.",
        // ⚠️ THE TWO BACKUP KEYS WERE REGISTERED BUT SURFACED NOWHERE (2026-08-07).
        // Both were authored with a user-facing name and hint ("Backups — Enable
        // Triple-Backup System", "Backups — External Mirror Instructions"), and
        // neither appeared on Foundry's settings page (this module hides
        // everything there by design) NOR in this panel. So the GM had no way to
        // see whether their world was being backed up, or to turn it off. For
        // the subsystem Johnny cares most about, being invisible is its own bug.
        keys: ["enableStoryNotes", "enableFameSystem", "enableNarrativeTime", "syncSimpleCalendar", "enableReputation", "enableDispositionTags", "enableSubtleRolls", "subtleRollSkills", "subtleRollAutoDetect", "subtleNarrationLength", "enableCritFumble", "enableSurvivalTracker", "memorySyncEnabled", "memorySyncExternalPath"],
    },
    {
        id: "docs", label: "Document Library", icon: "fa-solid fa-scroll",
        intro: "Reference document upload, digest extraction, auto-learn to World Bible.",
        keys: ["enableDocumentLibrary", "docContextBudget", "autoMergeDigests", "autoLearnToBible", "enableVisionImages"],
    },
    {
        id: "visualaids", label: "Visual Aids", icon: "fa-solid fa-eye",
        intro: "Token-level visual decorations the GM (or each player) can toggle. PC Token Glow draws a coloured base disc under each player character — making it easy to spot the party on a busy map. Size, opacity, style, and color source are all configurable per-user.",
        keys: ["pcGlow", "pcGlowSize", "pcGlowOpacity", "pcGlowStyle", "pcGlowColorMode", "pcGlowCustomColor"],
    },
    {
        id: "misc", label: "Misc", icon: "fa-solid fa-cog",
        intro: "Profanity filter, suggestion engine, debug mode.",
        keys: ["profanityFilter", "autoSuggestions", "suggestionInterval", "debugMode"],
    },
].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" })); // tabs displayed alphabetically

// ─── Panel Class ──────────────────────────────────────────────────────────

export class AceConfigPanel extends ApplicationV2 {

    static DEFAULT_OPTIONS = {
        id:      "ace-engine-config-panel",
        classes: ["ace-config-panel"],
        tag:     "div",
        window: {
            title:       "ACE Engine — Configuration",
            icon:        "fa-solid fa-sliders",
            resizable:   true,
            minimizable: true,
        },
        position: {
            width:  900,
            height: 720,
        },
    };

    constructor(options = {}) {
        super(options);
        this._activeTab = TABS[0].id;
        this._searchQuery = ""; // cross-tab filter input value
        // Per-provider API key cache (Phase: settings cleanup 2026-05-01).
        // Mirrors the apiKeysByProvider setting; lets us stash the visible
        // key in-memory when the user swaps providers, then write everything
        // on Save Changes. Initialized in _renderHTML.
        this._apiKeyVault          = {};
        this._lastProviderForVault = null;
        // ⚠️ SAVE WRITES A DIFF, NOT THE SCREEN (2026-08-21). See _saveAll.
        this._pendingChanges       = {};
    }

    // ─── Render lifecycle ────────────────────────────────────────────────

    async _renderHTML(_context, _options) {
        // Load (and one-time-migrate) the per-provider API key vault before
        // building HTML so the apiKey field reflects the active provider's
        // saved key on every panel open.
        this._loadApiKeyVault();
        return this._buildHTML();
    }

    _replaceHTML(result, content, _options) {
        content.innerHTML = result;
        this._wireEvents(content);
    }

    /**
     * Read apiKeysByProvider into _apiKeyVault. Performs a silent one-time
     * migration: if the map is empty but `apiKey` is set, seed the map with
     * apiKeysByProvider[currentProvider] = apiKey so existing setups keep
     * working after the schema addition.
     */
    _loadApiKeyVault() {
        let stored = {};
        try { stored = getSecretVault() || {}; }
        catch (_) { stored = {}; }
        const provider = (() => {
            try { return game.settings.get(MODULE_ID, "aiProvider") || ""; }
            catch (_) { return ""; }
        })();
        const apiKey = (() => {
            try { return getSecret("apiKey") || ""; }
            catch (_) { return ""; }
        })();

        // If the store has nothing yet but a key is readable from an older
        // name, show it. ⚠️ IN MEMORY ONLY - opening a panel must never write
        // to storage. The boot migration is what persists this, once, and a
        // write here would fire on every open including from a second GM.
        const isEmpty = !stored || Object.keys(stored).length === 0;
        if (isEmpty && provider && apiKey) stored = { [provider]: apiKey };

        this._apiKeyVault          = { ...stored };
        this._lastProviderForVault = provider || null;
    }

    // ─── HTML builders ───────────────────────────────────────────────────

    _buildHTML() {
        const tabRail = TABS.map(tab => `
            <li class="ace-cfg-tab ${tab.id === this._activeTab ? "active" : ""}"
                data-tab="${tab.id}"
                title="${this._esc(tab.label)}">
                <span class="ace-cfg-tab-icon"><i class="${tab.icon}"></i></span>
                <span class="ace-cfg-tab-label">${this._esc(tab.label)}</span>
            </li>
        `).join("");

        // ── Search bar (cross-tab) ──
        // When query has 2+ chars, the pane shows search results across ALL
        // tabs instead of the active tab's settings. Each result is rendered
        // with a small chip showing which tab it belongs to (clickable jump).
        const q = String(this._searchQuery ?? "").trim();
        const searchBar = `
            <div class="ace-cfg-search">
                <span class="ace-cfg-search-icon"><i class="fa-solid fa-magnifying-glass"></i></span>
                <input type="search" class="ace-cfg-search-input" placeholder="Search all settings…"
                       value="${this._esc(this._searchQuery ?? "")}"
                       autocomplete="off" spellcheck="false" />
                ${q ? `<button type="button" class="ace-cfg-search-clear" data-action="clear-search" title="Clear search"><i class="fa-solid fa-xmark"></i></button>` : ""}
            </div>
        `;

        let paneHtml;
        if (q.length >= 2) {
            paneHtml = this._renderSearchResults(q);
        } else {
            const activeTab = TABS.find(t => t.id === this._activeTab) || TABS[0];
            // The AI tab is a purpose-built guided flow (_buildAiSetup), which
            // renders its own deprecation banners, Test button and Refresh
            // button inline — so the standalone banner/action blocks that used
            // to sit here are NOT emitted for it (duplicate data-action nodes
            // would break the querySelector-based wiring).
            // The AI tab builds its own advanced block inside its guided flow.
            // Every other tab gets one here, collapsed, at the bottom of its own
            // settings - so "advanced" is always advanced about the thing you
            // are already looking at.
            const settingsHtml = activeTab.id === "ai"
                ? this._buildAiSetup()
                : this._buildSettingsHTML(activeTab) + this._buildAdvancedBlock(activeTab);
            paneHtml = `
                <div class="ace-cfg-pane" data-tab="${activeTab.id}">
                    <header class="ace-cfg-pane-header">
                        <span class="ace-cfg-pane-icon"><i class="${activeTab.icon}"></i></span>
                        <h2>${this._esc(activeTab.label)}</h2>
                    </header>
                    ${activeTab.intro ? `<p class="ace-cfg-intro">${this._esc(activeTab.intro)}</p>` : ""}
                    <div class="ace-cfg-settings">${settingsHtml}</div>
                </div>
            `;
        }

        return `
            <div class="ace-cfg-root">
                ${searchBar}
                <div class="ace-cfg-body">
                    <ul class="ace-cfg-tablist" role="tablist">${tabRail}</ul>
                    ${paneHtml}
                </div>
            </div>
            <footer class="ace-cfg-footer">
                <button type="button" class="ace-cfg-btn ace-cfg-btn-reset" data-action="resetTab">
                    <i class="fa-solid fa-undo"></i> Reset This Tab
                </button>
                <div class="ace-cfg-footer-spacer"></div>
                <button type="button" class="ace-cfg-btn ace-cfg-btn-cancel" data-action="cancel">
                    Cancel
                </button>
                <button type="button" class="ace-cfg-btn ace-cfg-btn-save" data-action="saveAll">
                    <i class="fa-solid fa-save"></i> Save Changes
                </button>
            </footer>
        `;
    }

    /**
     * Cross-tab search results. Walks every tab's settings, matches the
     * query (case-insensitive) against setting key, name, and hint.
     * Each match is shown with a clickable "tab chip" so the user can jump
     * to that tab and edit the setting in context.
     */
    _renderSearchResults(query) {
        const q = query.toLowerCase();
        const results = [];
        for (const tab of TABS) {
            for (const key of tabKeys(tab)) {
                const fullKey = `${MODULE_ID}.${key}`;
                const meta = game.settings.settings.get(fullKey);
                if (!meta) continue;
                const name = String(meta.name ?? "").toLowerCase();
                const hint = String(meta.hint ?? "").toLowerCase();
                if (name.includes(q) || hint.includes(q) || key.toLowerCase().includes(q)) {
                    results.push({ tab, key, meta });
                }
            }
        }

        // Rank prefix-first by the setting NAME (start-of-name beats start-of-word
        // beats mid-name); hint/key-only matches sink to the bottom. Reorders only.
        const _score = (nm) => {
            const n = String(nm ?? "").toLowerCase();
            if (n.startsWith(q)) return 0;
            if (n.split(/[\s,\-/()'".:]+/).some(w => w.startsWith(q))) return 1;
            if (n.includes(q)) return 2;
            return 3;
        };
        results.sort((a, b) => {
            const d = _score(a.meta.name) - _score(b.meta.name);
            if (d) return d;
            return String(a.meta.name ?? "").localeCompare(String(b.meta.name ?? ""));
        });

        if (!results.length) {
            return `
                <div class="ace-cfg-pane" data-tab="__search__">
                    <header class="ace-cfg-pane-header">
                        <span class="ace-cfg-pane-icon"><i class="fa-solid fa-magnifying-glass"></i></span>
                        <h2>Search Results</h2>
                    </header>
                    <p class="ace-cfg-intro">No settings match <strong>"${this._esc(query)}"</strong>. Try a shorter query or different keyword.</p>
                </div>
            `;
        }

        // Build a quick virtual tab containing only the matching keys so we can
        // reuse _buildSettingsHTML for the actual setting rows.
        const itemsHtml = results.map(r => {
            const fakeTab = { keys: [r.key] };
            const settingRow = this._buildSettingsHTML(fakeTab);
            return `
                <div class="ace-cfg-search-result">
                    <button type="button" class="ace-cfg-search-tab-chip" data-action="jump-to-tab"
                            data-tab="${r.tab.id}" title="Jump to ${this._esc(r.tab.label)} tab">
                        <span class="ace-cfg-tab-icon"><i class="${r.tab.icon}"></i></span>
                        ${this._esc(r.tab.label)}
                    </button>
                    ${settingRow}
                </div>
            `;
        }).join("");

        return `
            <div class="ace-cfg-pane" data-tab="__search__">
                <header class="ace-cfg-pane-header">
                    <span class="ace-cfg-pane-icon"><i class="fa-solid fa-magnifying-glass"></i></span>
                    <h2>Search Results — ${results.length} match${results.length === 1 ? "" : "es"} for "${this._esc(query)}"</h2>
                </header>
                <div class="ace-cfg-settings">${itemsHtml}</div>
            </div>
        `;
    }

    /**
     * @param {object} tab            object with a `keys` array
     * @param {object} [opts]
     * @param {boolean} [opts.plainLabels]  suppress the big "featured" headline
     *        treatment. The guided AI Setup passes this because its numbered
     *        step titles already carry the visual weight — without it you get
     *        two stacked gold headings saying nearly the same thing.
     */
    _buildSettingsHTML(tab, opts = {}) {
        const rows = [];
        // Four "headline" AI keys get the large-label treatment — provider
        // pick + the three model-tier dropdowns. Each renders as a big
        // brass-gold phrase + a regular-font subtitle on the same line.
        // The big part is the bolded noun phrase; the subtitle is the
        // descriptive tail. For "Digest Model" the source setting name is
        // "Digest Extraction Model" with no natural split point, so this
        // map hand-overrides the split. All other rows ignore this map and
        // render meta.name as a single regular-font label.
        const FEATURED_LABELS = {
            aiProvider:  { big: "AI Provider",  sub: "" },
            modelName:   { big: "AI Model",     sub: "— Quality / Default (session summaries, bios, lore)" },
            chatModel:   { big: "Chat Model",   sub: "— NPC Conversations (speed-tier)" },
            digestModel: { big: "Digest Model", sub: "— Extraction Model" },
        };
        for (const key of tabKeys(tab)) {
            const fullKey = `${MODULE_ID}.${key}`;
            const meta = game.settings.settings.get(fullKey);
            if (!meta) {
                console.warn(`ACE: Engine | Config panel — setting "${key}" not registered, skipping.`);
                continue;
            }
            // ⚠️🔴 A SECRET IS NEVER READ FROM ITS WORLD NAME (2026-08-21).
            // This read `game.settings.get(MODULE_ID, "apiKey")` for every key
            // including the secrets - and the migration deliberately BLANKS the
            // world copy once the real value is safe in client storage. So the
            // whole round trip destroyed the key:
            //
            //   1. paste the key, Save  -> written to apiKeySecure, world copy
            //                              blanked. Test Connection goes green,
            //                              because the test reads it properly.
            //   2. close and reopen     -> this line reads the BLANKED world
            //                              copy and renders an empty box.
            //   3. Save again           -> the empty box is written back, which
            //                              wipes apiKeySecure. Key gone.
            //
            // The ElevenLabs key survived all of this because it is registered
            // client-scoped under its own name, so a plain get returns the real
            // value. That difference is the whole reason one key vanished and
            // the other did not.
            //
            // ⚠️ I FIXED EXACTLY THIS IN ACE FORGE and wrote a comment there
            // saying a blank box "invites them to paste the key straight back
            // into world scope" - and never applied it here. Same bug, same
            // week, one module across.
            const stored = (() => {
                try {
                    if (isSecretKey(key)) return getSecret(key) || "";
                    return game.settings.get(MODULE_ID, key);
                } catch (_) { return meta.default; }
            })();
            // An edit the user has made but not yet saved wins, so typing in the
            // search box mid-edit does not silently throw the edit away.
            const value = this._pendingChanges[key] ?? stored;
            const isPassword = isMaskedKey(key);
            const inputHtml = this._buildInput(key, meta, value, isPassword);
            // Per-setting "extras" slot — currently used only for the digest
            // model "🐢 slow" warning. Populated/hidden in _wireEvents.
            const VOICE_PICKERS = ["elevenLabsVoiceId", "elevenLabsFemaleVoiceId"];
            const extras = key === "digestModel"
                ? `<div class="ace-cfg-extras" data-digest-warning style="grid-column:1 / -1; display:none;"></div>`
                : VOICE_PICKERS.includes(key)
                ? `<div class="ace-cfg-extras" style="grid-column:1 / -1; display:flex; gap:8px; align-items:center;">
                       <button type="button" class="ace-cfg-plainbtn" data-action="previewVoice" data-target="${key}">
                           <i class="fa-solid fa-play"></i> Hear it
                       </button>
                       <button type="button" class="ace-cfg-plainbtn" data-action="refreshVoices">
                           <i class="fa-solid fa-rotate"></i> Load my ElevenLabs voices
                       </button>
                       <span class="ace-cfg-hint" data-voice-status></span>
                   </div>`
                : "";
            const featured = opts.plainLabels ? null : FEATURED_LABELS[key];
            const featuredClass = featured ? " ace-cfg-row--featured" : "";
            // Featured rows: big phrase + regular-font subtitle on same line.
            // Non-featured rows: standard meta.name rendering.
            const labelHtml = featured
                ? `<label for="ace-cfg-${this._esc(key)}">
                       <span class="ace-cfg-headline">${this._esc(featured.big)}</span>${featured.sub ? `<span class="ace-cfg-headline-sub"> ${this._esc(featured.sub)}</span>` : ""}
                   </label>`
                : `<label for="ace-cfg-${this._esc(key)}">${this._esc(meta.name || key)}</label>`;
            rows.push(`
                <div class="ace-cfg-row${featuredClass}" data-setting="${this._esc(key)}">
                    ${labelHtml}
                    <div class="ace-cfg-input">${inputHtml}</div>
                    ${meta.hint ? `<p class="ace-cfg-hint">${this._esc(meta.hint)}</p>` : ""}
                    ${extras}
                </div>
            `);
        }
        return rows.join("");
    }

    _buildInput(key, meta, value, isPassword) {
        const id = `ace-cfg-${key}`;
        const v  = this._esc(String(value ?? ""));

        if (isPassword) {
            // type="text" + -webkit-text-security:disc — visually masks like a
            // password field (dots) but Chrome literally cannot detect it as a
            // password input, so the "Save password?" prompt never fires. The
            // honeypot + autocomplete="new-password" approach kept failing on
            // Foundry's Electron build; this is the bulletproof option.
            //
            // The wrapper + eye-toggle button (Phase: settings cleanup,
            // 2026-05-01) lets the GM peek at the saved key to verify it's
            // the right one, without exposing it in the DOM permanently.
            // Click toggles the -webkit-text-security style on/off.
            return `
                <div class="ace-cfg-secret-wrap">
                    <input type="text" id="${id}" data-setting-key="${key}" value="${v}"
                           autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
                           data-lpignore="true" data-1p-ignore="true" data-form-type="other"
                           data-secret-masked="true"
                           style="-webkit-text-security: disc; text-security: disc; font-family: text-security-disc, sans-serif; letter-spacing: 0.1em;">
                    <button type="button" class="ace-cfg-secret-toggle"
                            data-action="toggleSecret" data-target="${id}"
                            title="Show / hide the API key">
                        <i class="fa-solid fa-eye" data-eye="closed"></i>
                    </button>
                </div>
            `;
        }
        if (meta.type === Boolean) {
            // Toggle-switch slider — visually consistent with ACE Forge / QOL
            // config panels. Same underlying <input type="checkbox"> so the
            // existing read/write code in _saveAll() doesn't change.
            return `
                <label class="ace-cfg-toggle">
                    <input type="checkbox" id="${id}" data-setting-key="${key}" ${value ? "checked" : ""}>
                    <span class="ace-cfg-toggle-track"></span>
                </label>
            `;
        }
        if (meta.choices) {
            const options = Object.entries(meta.choices).map(([val, label]) => {
                const sel = String(val) === String(value) ? "selected" : "";
                return `<option value="${this._esc(val)}" ${sel}>${this._esc(label)}</option>`;
            });
            // ── Critical: if the saved value isn't in the static choices list,
            // prepend it as a "(current)" entry so the dropdown shows it
            // selected. Without this, the browser silently defaults to the
            // FIRST option, and a Save Changes click corrupts the saved value.
            // This bit a user with Ollama models like "llama3.2-vision:latest"
            // (with the :latest tag) that don't match the static gpt-4o/etc.
            // list, leaving the dropdown stuck on gpt-4o.
            const valueInChoices = Object.keys(meta.choices).some(k => String(k) === String(value));
            if (!valueInChoices && value !== "" && value != null) {
                options.unshift(`<option value="${this._esc(value)}" selected>${this._esc(value)} (current)</option>`);
            }
            return `<select id="${id}" data-setting-key="${key}">${options.join("")}</select>`;
        }
        if (meta.type === Number) {
            const range = meta.range;
            // All numeric inputs get autofill suppression so Chrome's password
            // manager doesn't grab a number near the apiKey field as "username".
            if (range) {
                return `
                    <div class="ace-cfg-range">
                        <input type="range" value="${v}" min="${range.min}" max="${range.max}" step="${range.step ?? 1}" data-slider-for="${id}" autocomplete="off" data-lpignore="true" data-1p-ignore="true">
                        <input type="number" id="${id}" data-setting-key="${key}" value="${v}" min="${range.min}" max="${range.max}" step="${range.step ?? 1}" autocomplete="off" data-lpignore="true" data-1p-ignore="true">
                    </div>
                `;
            }
            return `<input type="number" id="${id}" data-setting-key="${key}" value="${v}" autocomplete="off" data-lpignore="true" data-1p-ignore="true">`;
        }
        // Default: text
        return `<input type="text" id="${id}" data-setting-key="${key}" value="${v}" autocomplete="off" data-lpignore="true" data-1p-ignore="true">`;
    }

    _esc(s) {
        return String(s ?? "")
            .replace(/&/g,  "&amp;")
            .replace(/</g,  "&lt;")
            .replace(/>/g,  "&gt;")
            .replace(/"/g,  "&quot;")
            .replace(/'/g,  "&#39;");
    }

    // ─── Deprecation banners (sunset model warnings from remote catalog) ──
    // Cross-references the user's three model settings (modelName / chatModel
    // / digestModel) against the catalog's `deprecations` list. If any of
    // them is on the sunset list AND the user hasn't dismissed it before,
    // render a yellow strip offering a one-click swap to the recommended
    // replacement.
    //
    // The banner reuses _buildHTML's render cycle for state changes:
    // clicking "Switch" writes the replacement into the form field
    // immediately + persists on Save Changes; clicking "Dismiss" writes to
    // dismissedDeprecations and the banner disappears on next render.
    _buildDeprecationBanners() {
        // Collect current model values for all three tiers.
        const tiers = [
            { key: "modelName",   label: "Quality" },
            { key: "chatModel",   label: "Chat" },
            { key: "digestModel", label: "Digest" },
        ];

        // Read dismissed-list once so a single dismissed entry hides all
        // banners for the same model id (the dismissal is "I know about
        // this," not "I want one Tier to keep using it").
        let dismissed = {};
        try { dismissed = game.settings.get(MODULE_ID, "dismissedDeprecations") || {}; }
        catch (_) { dismissed = {}; }

        const banners = [];
        const seenIds = new Set();
        for (const t of tiers) {
            let value = "";
            try { value = String(game.settings.get(MODULE_ID, t.key) || ""); }
            catch (_) { value = ""; }
            if (!value) continue;
            const dep = getDeprecationFor(value);
            if (!dep) continue;
            if (dismissed[dep.id]) continue;
            if (seenIds.has(dep.id)) continue;  // one banner per deprecation
            seenIds.add(dep.id);

            const sunsetDate = dep.sunsets || "soon";
            const replacement = dep.replacement || "the current recommendation";
            const reason = dep.reason || "";
            banners.push(`
                <div class="ace-cfg-deprecation" data-deprecation-id="${this._esc(dep.id)}" data-tier-key="${this._esc(t.key)}" data-replacement="${this._esc(replacement)}">
                    <div class="ace-cfg-deprecation-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
                    <div class="ace-cfg-deprecation-body">
                        <strong>${this._esc(dep.id)} is being retired ${this._esc(sunsetDate)}.</strong>
                        Your <em>${this._esc(t.label)}</em> tier currently uses it. Recommended replacement: <strong>${this._esc(replacement)}</strong>.
                        ${reason ? `<div class="ace-cfg-deprecation-reason">${this._esc(reason)}</div>` : ""}
                    </div>
                    <div class="ace-cfg-deprecation-actions">
                        <button type="button" class="ace-cfg-plainbtn" data-action="acceptDeprecationSwap"
                                data-tier-key="${this._esc(t.key)}" data-replacement="${this._esc(replacement)}"
                                data-deprecation-id="${this._esc(dep.id)}">
                            <i class="fa-solid fa-arrow-right-arrow-left"></i> Switch to ${this._esc(replacement)}
                        </button>
                        <button type="button" class="ace-cfg-plainbtn ace-cfg-plainbtn-subtle"
                                data-action="dismissDeprecation" data-deprecation-id="${this._esc(dep.id)}">
                            Dismiss
                        </button>
                    </div>
                </div>
            `);
        }
        return banners.join("");
    }

    // ─── AI Tab: Test Connection / Refresh Models actions ────────────────
    // Plain buttons (NOT brass-textured) at the top of the AI tab so users
    // can diagnose connection issues before scrolling through settings.
    // ─── Guided AI Setup ─────────────────────────────────────────────────
    //
    // Replaces the AI tab's flat field list with a numbered, plain-English
    // flow: pick a provider → paste a key → pick a model → prove it works.
    //
    // Every row is still built by _buildSettingsHTML, so each input keeps its
    // data-setting-key attribute. That is deliberate: the save loop, the
    // per-provider key vault, the model-catalog sync and the deprecation
    // banners all key off those attributes and keep working untouched. Only
    // the LAYOUT changes here — no settings were dropped in the rebuild.

    /** Settings that stay available but shouldn't crowd the main flow. */
    static ADVANCED_AI_KEYS = ADVANCED_AI_KEYS;

    _buildAiSetup() {
        const provider = (() => {
            try { return game.settings.get(MODULE_ID, "aiProvider") || "ollama"; }
            catch (_) { return "ollama"; }
        })();
        const guide = PROVIDER_GUIDE[provider] ?? PROVIDER_GUIDE.custom;

        const step = (n, title, blurb, body, extraClass = "", attrs = "") => `
            <section class="ace-ai-step ${extraClass}" ${attrs}>
                <header class="ace-ai-step-head">
                    <span class="ace-ai-stepnum">${n}</span>
                    <h3>${this._esc(title)}</h3>
                </header>
                ${blurb ? `<p class="ace-ai-step-blurb">${this._esc(blurb)}</p>` : ""}
                <div class="ace-ai-step-body">${body}</div>
            </section>
        `;

        return `
            <div class="ace-ai-setup">

                ${step(1, "Choose your AI provider",
                    "This is the service that writes your NPC dialogue and narration.",
                    this._buildSettingsHTML({ keys: ["aiProvider"] }, { plainLabels: true })
                    + `<div class="ace-ai-note" data-provider-note>${this._buildProviderNote(provider)}</div>`)}

                ${step(2, "Pick a model",
                    "Not sure? Leave the default — it's the cheap, fast, sensible choice for this provider.",
                    this._buildDeprecationBanners()
                    + this._buildSettingsHTML({ keys: ["modelName"] }, { plainLabels: true })
                    + `<button type="button" class="ace-cfg-plainbtn" data-action="refreshModels">
                           <i class="fa-solid fa-rotate"></i> Refresh Model List
                       </button>`)}

                ${step(3, "Paste your API key",
                    "This is where your key goes. It's stored with your world and only ever visible to the GM.",
                    this._buildSettingsHTML({ keys: ["apiKey"] }, { plainLabels: true }),
                    guide.needsKey ? "" : "ace-ai-step--hidden",
                    "data-key-step")}

                ${step(4, "Test it",
                    "Sends one real request. If this comes back green, NPC chat will work.",
                    `<button type="button" class="ace-cfg-plainbtn ace-ai-testbtn" data-action="testConnection">
                         <i class="fa-solid fa-plug"></i> Test Connection
                     </button>
                     <div class="ace-cfg-test-result" data-test-result></div>`)}

                <details class="ace-ai-advanced">
                    <summary>Advanced settings<span class="ace-ai-advanced-sub"> — endpoint, per-task models, prompt, token limits</span></summary>
                    <div class="ace-ai-advanced-body">${this._buildSettingsHTML({ keys: AceConfigPanel.ADVANCED_AI_KEYS }, { plainLabels: true })}</div>
                </details>

            </div>
        `;
    }

    /**
     * The collapsed "Advanced settings" block at the foot of a tab. Renders
     * nothing at all when a tab has no advanced keys, so adding one later is
     * just a line in TABS.
     */
    _buildAdvancedBlock(tab) {
        const keys = tab?.advancedKeys ?? [];
        if (!keys.length) return "";
        return `
            <details class="ace-ai-advanced ace-cfg-advanced">
                <summary>Advanced settings<span class="ace-ai-advanced-sub"> — numbers and limits for ${this._esc(tab.label)}</span></summary>
                <div class="ace-ai-advanced-body">${this._buildSettingsHTML({ keys }, { plainLabels: true })}</div>
            </details>
        `;
    }

    /** The plain-English card under the provider picker. Swapped live on change. */
    _buildProviderNote(provider) {
        const g = PROVIDER_GUIDE[provider] ?? PROVIDER_GUIDE.custom;
        const bullets = g.lines.map(l => `<li>${this._esc(l)}</li>`).join("");
        const link = g.keyUrl
            ? `<a class="ace-ai-note-link" href="${this._esc(g.keyUrl)}" target="_blank" rel="noopener">
                   <i class="fa-solid fa-arrow-up-right-from-square"></i> ${this._esc(g.keyLabel)}
               </a>`
            : "";
        const cost = g.cost
            ? `<p class="ace-ai-cost">
                   <i class="fa-solid fa-coins"></i>
                   <span><strong>What it costs:</strong> ${this._esc(g.cost)}</span>
               </p>`
            : "";
        return `
            <span class="ace-ai-badge ace-ai-badge--${this._esc(g.tone)}">${this._esc(g.badge)}</span>
            <ul class="ace-ai-note-list">${bullets}</ul>
            ${cost}
            ${link}
        `;
    }

    // ─── Event wiring (manual, after _replaceHTML) ───────────────────────

    /**
     * Put a value into a settings control the way a PERSON would.
     *
     * ⚠️🔴 WHY THIS EXISTS. Assigning to .value or .checked in JavaScript fires
     * NO event. This panel records edits by listening for input and change on
     * every [data-setting-key] control, and Save writes only what was recorded.
     * So every place the panel filled a field in code — the slider mirroring
     * into its number box, the provider swap rewriting the API URL and model,
     * the deprecation banner replacing a model name — changed what the GM could
     * SEE and recorded nothing. Save then wrote a diff that did not contain it
     * and reported success.
     *
     * Johnny, 2026-08-23: "I keep changing the PC glow, the size of it, from 1.5
     * to 0.7, and it says it saved one setting. When I come back, it's still at
     * 1.5." The deprecation banner was worse: it printed "Click Save Changes to
     * persist" for a value Save could not see.
     *
     * ⚠️ IT ONLY RECORDS A REAL CHANGE. The same code paths also RESTORE a
     * field to its stored value — repopulating a voice list, rebuilding a model
     * dropdown on open. Recording those would write fields the GM never touched,
     * which is the exact behaviour that once erased his API key. So the stored
     * value is read first and an unchanged assignment stays silent.
     */
    _setFieldValue(el, value) {
        if (!el) return false;
        el.value = value;
        const key = el.dataset?.settingKey;
        if (!key) return false;
        let stored;
        try {
            stored = isSecretKey(key) ? (getSecret(key) || "") : game.settings.get(MODULE_ID, key);
        } catch (_) { stored = undefined; }
        if (String(stored ?? "") === String(value ?? "")) return false;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
    }

    _wireEvents(content) {
        // ── Every edit is recorded; Save writes only these ────────────────
        // A field the user never touched never enters this map, so Save cannot
        // write it. That is the whole protection, and it protects every setting
        // on the panel rather than only the ones I remembered to special-case.
        for (const el of content.querySelectorAll("[data-setting-key]")) {
            const record = () => {
                const key = el.dataset.settingKey;
                if (!key) return;
                if (el.type === "checkbox") this._pendingChanges[key] = el.checked;
                else if (el.type === "number" || el.type === "range") {
                    const v = Number(el.value);
                    this._pendingChanges[key] = Number.isNaN(v) ? 0 : v;
                } else this._pendingChanges[key] = el.value;
            };
            el.addEventListener("input", record);
            el.addEventListener("change", record);
        }

        // ── Search input ── re-renders on each keystroke to filter across
        // all tabs. Focus and caret position are restored after re-render so
        // typing stays smooth.
        const searchInput = content.querySelector(".ace-cfg-search-input");
        if (searchInput) {
            searchInput.addEventListener("input", (ev) => {
                const newQuery = ev.target.value ?? "";
                const caretPos = ev.target.selectionStart;
                this._searchQuery = newQuery;
                this.render(false);
                // Re-render is async — restore focus + caret on next tick
                setTimeout(() => {
                    const fresh = this.element?.querySelector?.(".ace-cfg-search-input");
                    if (fresh) {
                        fresh.focus();
                        try { fresh.setSelectionRange(caretPos, caretPos); } catch (_) {}
                    }
                }, 0);
            });
        }
        content.querySelector("[data-action='clear-search']")?.addEventListener("click", () => {
            this._searchQuery = "";
            this.render(false);
        });
        // Jump-to-tab chips inside search results
        content.querySelectorAll("[data-action='jump-to-tab']").forEach(btn => {
            btn.addEventListener("click", () => {
                const id = btn.dataset.tab;
                if (id) {
                    this._activeTab = id;
                    this._searchQuery = "";
                    this.render(false);
                }
            });
        });

        // Tab clicks → switch active tab + re-render.
        // Preserve the tab-rail scroll position across re-render — without this,
        // clicking a tab below the fold causes the left rail to jump to top
        // (the new DOM has fresh scrollTop=0). Capture before, restore after.
        content.querySelectorAll(".ace-cfg-tab").forEach(el => {
            el.addEventListener("click", () => {
                const tablistEl = content.querySelector(".ace-cfg-tablist");
                const savedScroll = tablistEl?.scrollTop ?? 0;
                this._activeTab = el.dataset.tab;
                const renderResult = this.render(false);
                Promise.resolve(renderResult).then(() => {
                    const newTablist = this.element?.querySelector?.(".ace-cfg-tablist");
                    if (newTablist) newTablist.scrollTop = savedScroll;
                });
            });
        });

        // Range sliders ↔ number input two-way binding
        content.querySelectorAll('input[type="range"][data-slider-for]').forEach(slider => {
            const target = content.querySelector(`#${slider.dataset.sliderFor}`);
            if (!target) return;
            // ── ⚠️🔴 SETTING .value IN CODE FIRES NO EVENT. (2026-08-23)
            //
            // The slider carries no data-setting-key, so it is not in the
            // recorder loop above. It mirrored its value into the number box
            // by assignment — and assigning to .value does NOT dispatch input
            // or change, so the number box's own recorder never ran either.
            //
            // Result: dragging ANY slider in this panel changed what you could
            // see and recorded NOTHING. Save then wrote a diff that did not
            // contain it and reported success. Johnny, 2026-08-23: "I keep
            // changing the PC glow, the size of it, from 1.5 to 0.7, and it says
            // it saved one setting. When I come back, it's still at 1.5."
            //
            // Every range setting in ACE Engine was unsaveable by its slider.
            // The fix is to dispatch the event the assignment skipped, so the
            // one recorder stays the only writer.
            slider.addEventListener("input", () => this._setFieldValue(target, slider.value));
            target.addEventListener("input", () => { slider.value = target.value; });
        });

        // ── AI Provider change → auto-update URL + Model defaults ──────────
        // Picking "Ollama" should set URL to localhost:11434 and Model to a
        // sensible Ollama default. Without this, swapping provider leaves
        // mismatched URL+Model and nothing works.
        const providerSelect = content.querySelector('[data-setting-key="aiProvider"]');
        if (providerSelect) {
            providerSelect.addEventListener("change", async () => {
                const newProvider = providerSelect.value;

                // ── Guided-setup chrome: swap the plain-English note, and show
                // or hide the whole "paste your key" step. Done BEFORE the
                // defaults bail-out so the guidance always tracks the picker.
                const guide = PROVIDER_GUIDE[newProvider] ?? PROVIDER_GUIDE.custom;
                const noteEl = content.querySelector("[data-provider-note]");
                if (noteEl) noteEl.innerHTML = this._buildProviderNote(newProvider);
                const keyStep = content.querySelector("[data-key-step]");
                if (keyStep) keyStep.classList.toggle("ace-ai-step--hidden", !guide.needsKey);

                const defaults = PROVIDER_DEFAULTS[newProvider];
                if (!defaults) return;

                // ── Swap API Key (Phase: per-provider key vault) ──
                // 1. Stash the currently-visible key under the PREVIOUS provider
                //    in the in-memory vault. (Written on Save Changes.)
                // 2. Look up the new provider's saved key and load it into the
                //    field — or blank it out + toast if none was saved.
                const apiKeyField = content.querySelector('[data-setting-key="apiKey"]');
                if (apiKeyField) {
                    const previousProvider = this._lastProviderForVault;
                    if (previousProvider && previousProvider !== newProvider) {
                        // Only stash if the user actually had a value typed
                        const currentVisible = apiKeyField.value ?? "";
                        if (currentVisible) {
                            this._apiKeyVault[previousProvider] = currentVisible;
                        }
                    }
                    const savedForNew = this._apiKeyVault[newProvider] ?? "";
                    // ALLOW-SILENT: restoring the key already saved for the
                    // provider just picked. Keys are written from _apiKeyVault
                    // in _saveAll, never from the diff, so recording this would
                    // put a value in the diff that the masked-field guard then
                    // has to defend against. Displaying it is the whole job.
                    apiKeyField.value = savedForNew;
                    if (!savedForNew && (newProvider === "openai" || newProvider === "anthropic" || newProvider === "openrouter")) {
                        ui.notifications?.info(`ACE Engine — no saved ${newProvider} API key. Paste yours and click Save Changes.`);
                    }
                    this._lastProviderForVault = newProvider;
                }

                // ── Update API URL ──
                const urlField = content.querySelector('[data-setting-key="apiUrl"]');
                if (urlField) {
                    if (urlField.tagName === "SELECT") {
                        const hasOption = Array.from(urlField.options).some(o => o.value === defaults.apiUrl);
                        if (!hasOption) {
                            const opt = document.createElement("option");
                            opt.value = defaults.apiUrl;
                            opt.textContent = defaults.apiUrl;
                            urlField.prepend(opt);
                        }
                        this._setFieldValue(urlField, defaults.apiUrl);
                    } else {
                        this._setFieldValue(urlField, defaults.apiUrl);
                    }
                }

                // ── Update AI Model: prefer live catalog, fall back to default ──
                ui.notifications?.info(`ACE Engine — fetching ${newProvider} model list…`);
                await this._populateModelDropdownFromCatalog(content, newProvider, defaults.modelName);
            });
        }

        // ── On AI tab render, populate model dropdown from cached catalog ──
        // Skip the live fetch (use cached only) so the panel renders fast.
        // The "Refresh Model List" button forces a re-fetch.
        if (this._activeTab === "ai" && providerSelect) {
            const currentProvider = providerSelect.value;
            const currentModel    = content.querySelector('[data-setting-key="modelName"]')?.value || "";
            this._populateModelDropdownFromCatalog(content, currentProvider, currentModel, /* useCacheOnly= */ true);
        }

        // Footer buttons
        content.querySelector('[data-action="saveAll"]')?.addEventListener("click", () => this._saveAll());
        content.querySelector('[data-action="cancel"]')?.addEventListener("click",  () => this.close());
        content.querySelector('[data-action="resetTab"]')?.addEventListener("click", () => this._resetTab());

        // Deprecation banner — "Switch to X" writes the replacement into the
        // matching tier's form field. The user still has to click Save
        // Changes to persist, so this is reversible until commit.
        content.querySelectorAll('[data-action="acceptDeprecationSwap"]').forEach(btn => {
            btn.addEventListener("click", (ev) => {
                ev.preventDefault();
                const tierKey     = btn.dataset.tierKey;
                const replacement = btn.dataset.replacement;
                if (!tierKey || !replacement) return;
                const field = content.querySelector(`[data-setting-key="${CSS.escape(tierKey)}"]`);
                if (!field) return;
                // For provider:model fields (chatModel / digestModel) we need
                // to prepend the provider prefix. modelName takes the bare id.
                let newValue = replacement;
                if (tierKey !== "modelName" && !replacement.includes(":")) {
                    // Default to "custom:" for provider-agnostic replacements;
                    // catalog entries can override by including a colon already.
                    newValue = `custom:${replacement}`;
                }
                // If the dropdown's <option> for newValue doesn't exist yet,
                // add it on the fly so the select reflects the choice.
                if (field.tagName === "SELECT" && !field.querySelector(`option[value="${CSS.escape(newValue)}"]`)) {
                    const opt = document.createElement("option");
                    opt.value = newValue;
                    opt.textContent = `${newValue} (catalog recommendation)`;
                    field.prepend(opt);
                }
                this._setFieldValue(field, newValue);
                // Hide this specific banner immediately.
                btn.closest(".ace-cfg-deprecation")?.remove();
                ui.notifications?.info(`Tier "${tierKey}" set to ${newValue}. Click Save Changes to persist.`);
            });
        });
        content.querySelectorAll('[data-action="dismissDeprecation"]').forEach(btn => {
            btn.addEventListener("click", async (ev) => {
                ev.preventDefault();
                const depId = btn.dataset.deprecationId;
                if (!depId) return;
                try {
                    const current = game.settings.get(MODULE_ID, "dismissedDeprecations") || {};
                    current[depId] = { dismissedAt: Date.now() };
                    await game.settings.set(MODULE_ID, "dismissedDeprecations", current);
                } catch (_) { /* non-blocking */ }
                btn.closest(".ace-cfg-deprecation")?.remove();
            });
        });

        // Eye-toggle: reveal / mask API key fields. Click flips the visual
        // text-security style on the target input + swaps the eye icon.
        // The underlying input.value is unchanged either way.
        content.querySelectorAll('[data-action="toggleSecret"]').forEach(btn => {
            btn.addEventListener("click", (ev) => {
                ev.preventDefault();
                const targetId = btn.dataset.target;
                const input = content.querySelector(`#${CSS.escape(targetId)}`);
                if (!input) return;
                const icon = btn.querySelector("i");
                const masked = input.dataset.secretMasked === "true";
                if (masked) {
                    // Reveal — clear the text-security CSS
                    input.style.webkitTextSecurity = "none";
                    input.style.textSecurity       = "none";
                    input.style.fontFamily         = "";
                    input.style.letterSpacing      = "";
                    input.dataset.secretMasked     = "false";
                    if (icon) {
                        icon.classList.remove("fa-eye");
                        icon.classList.add("fa-eye-slash");
                        icon.dataset.eye = "open";
                    }
                    btn.title = "Hide the API key";
                } else {
                    // Re-mask — restore the dots
                    input.style.webkitTextSecurity = "disc";
                    input.style.textSecurity       = "disc";
                    input.style.fontFamily         = "text-security-disc, sans-serif";
                    input.style.letterSpacing      = "0.1em";
                    input.dataset.secretMasked     = "true";
                    if (icon) {
                        icon.classList.remove("fa-eye-slash");
                        icon.classList.add("fa-eye");
                        icon.dataset.eye = "closed";
                    }
                    btn.title = "Show the API key";
                }
            });
        });

        // Test Connection (AI tab only)
        content.querySelector('[data-action="testConnection"]')?.addEventListener("click", () => this._testConnection(content));
        // Refresh Models (AI tab only) — wired in step #7 with live model fetch
        content.querySelector('[data-action="refreshModels"]')?.addEventListener("click", () => this._refreshModels(content));
        content.querySelector('[data-action="refreshVoices"]')?.addEventListener("click", () => this._refreshVoices(content, false));
        for (const b of content.querySelectorAll('[data-action="previewVoice"]')) {
            b.addEventListener("click", () => this._previewVoice(content, b.dataset.target));
        }
        // Fill the pickers from the GM's own account as soon as the tab opens,
        // quietly - a dropdown that only lists stock voices is the bug.
        if (this._activeTab === "voice") this._refreshVoices(content, true);

        // ── Digest model slowness warning (highly visible) ───────────────
        // Local digest extraction takes 10–30 minutes per book vs ~30 seconds
        // for cloud. Show a red warning box right under the digest dropdown
        // whenever the user has it pointed at a local provider.
        const digestSelect = content.querySelector('[data-setting-key="digestModel"]');
        const warningSlot  = content.querySelector('[data-digest-warning]');
        if (digestSelect && warningSlot) {
            const updateDigestWarning = () => {
                const value       = digestSelect.value || "";
                const providerVal = providerSelect?.value || "";
                const valueIsLocal = value.startsWith("ollama:") || value.startsWith("lmstudio:");
                const usingMain    = value === "";
                const mainIsLocal  = providerVal === "ollama" || providerVal === "lmstudio";

                if (valueIsLocal || (usingMain && mainIsLocal)) {
                    const which = valueIsLocal ? value.split(":")[0] : providerVal;
                    warningSlot.innerHTML = `
                        <div class="ace-cfg-warning-box ace-cfg-warning-slow">
                            <strong>🐢 SLOW WARNING:</strong> Local digest extraction on <strong>${this._esc(which)}</strong> takes <strong>10–30 minutes per book</strong> vs ~30 seconds on a cloud provider. Bigger sourcebooks (PHB, DMG) can run an hour or more. Strongly recommended: paste an OpenAI API key in <strong>Digest API Key</strong> above and pick <strong>OpenAI: GPT-4o Mini (~$0.50/book) — Best Value</strong> for the digest model. Your main AI stays local — only the bulk extraction goes cloud.
                        </div>
                    `;
                    warningSlot.style.display = "block";
                } else {
                    warningSlot.innerHTML = "";
                    warningSlot.style.display = "none";
                }
            };
            digestSelect.addEventListener("change", updateDigestWarning);
            providerSelect?.addEventListener("change", updateDigestWarning);
            updateDigestWarning();  // initial state
        }
    }

    // ─── Test Connection ─────────────────────────────────────────────────
    // Pings the configured provider/URL/key/model with a one-token request
    // and returns a precise diagnosis. Reuses AceSettings.testConnection so
    // there's only one place that knows how each provider's API is shaped.
    async _testConnection(content) {
        const btn = content.querySelector('[data-action="testConnection"]');
        const resultEl = content.querySelector('[data-test-result]');
        if (!btn || !resultEl) return;

        // Read currently-displayed values from the panel (NOT saved settings —
        // user may be testing a config they haven't saved yet)
        const provider = content.querySelector('[data-setting-key="aiProvider"]')?.value || "ollama";
        const apiKey   = content.querySelector('[data-setting-key="apiKey"]')?.value || "";
        const apiUrl   = content.querySelector('[data-setting-key="apiUrl"]')?.value || "";
        const model    = content.querySelector('[data-setting-key="modelName"]')?.value || "";

        btn.disabled = true;
        const originalLabel = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing…';
        resultEl.className = "ace-cfg-test-result testing";
        resultEl.textContent = `Pinging ${provider} at ${apiUrl || "default URL"}…`;

        try {
            // Dynamic import — settings.mjs imports this file so a static
            // import would create a cycle that breaks on module evaluation.
            const { AceSettings } = await import("./settings.mjs");
            const result = await AceSettings.testConnection(provider, apiKey, apiUrl, model);

            if (result.ok) {
                resultEl.className = "ace-cfg-test-result success";
                resultEl.innerHTML = `<i class="fa-solid fa-check-circle"></i> Connected — <strong>${this._esc(result.model || model)}</strong> responded.`;
            } else {
                resultEl.className = "ace-cfg-test-result fail";
                resultEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${this._esc(result.error || "Connection failed.")}`;
            }
        } catch (err) {
            resultEl.className = "ace-cfg-test-result fail";
            resultEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${this._esc(err.message || "Connection failed.")}`;
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalLabel;
        }
    }

    // ─── Refresh Models — force live re-fetch from provider's API ────────
    /**
     * Fill the narrator / alternate voice pickers with the voices on the GM's
     * OWN ElevenLabs account.
     *
     * ⚠️ THE STOCK LIST STAYS as the tail of the dropdown, and the currently
     * saved voice is ALWAYS present even when the fetch fails or the id is not
     * on the account any more. A picker that silently drops the value it is
     * showing is how a setting changes itself behind the user's back.
     */
    async _refreshVoices(content, quiet = true) {
        const selects = [...content.querySelectorAll('[data-setting-key="elevenLabsVoiceId"], [data-setting-key="elevenLabsFemaleVoiceId"]')]
            .filter(el => el.tagName === "SELECT");
        if (!selects.length) return;
        const status = content.querySelector("[data-voice-status]");
        const say = (t) => { if (status) status.textContent = t; };

        say("Loading your voices…");
        const { ok, voices, error } = await fetchElevenLabsVoices();
        if (!ok || !voices.length) {
            say(error ? `Could not load your voices: ${error}` : "No voices found on your account.");
            // ⚠️ Loud only when they asked. Opening a tab must not throw a
            // toast at somebody who has not set a key up yet.
            if (!quiet) ui.notifications?.warn(`ACE Engine — ${error ?? "no voices returned"}. The built-in voices are still available.`);
            return;
        }

        for (const sel of selects) {
            const current = sel.value;
            const isAlternate = sel.dataset.settingKey === "elevenLabsFemaleVoiceId";
            const stock = [...sel.options].map(o => ({ value: o.value, label: o.textContent }));
            sel.innerHTML = "";

            // ⚠️ document.createElement, not `new Option`. Option is a genuine
            // browser global, but the lint does not know it, and the one thing
            // we never do is widen the globals list to quieten a rule - a false
            // entry there hid two live bugs in August.
            const opt = (label, value) => {
                const o = document.createElement("option");
                o.value = value;
                o.textContent = label;
                return o;
            };

            if (isAlternate) sel.appendChild(opt("— Use the narrator voice —", ""));

            const group = document.createElement("optgroup");
            group.label = "Your ElevenLabs voices";
            for (const v of voices) {
                group.appendChild(opt(v.category === "cloned" ? `${v.name} (yours)` : v.name, v.id));
            }
            sel.appendChild(group);

            const legacy = document.createElement("optgroup");
            legacy.label = "Built-in suggestions";
            for (const o of stock) {
                if (!o.value || voices.some(v => v.id === o.value)) continue;
                legacy.appendChild(opt(o.label, o.value));
            }
            if (legacy.children.length) sel.appendChild(legacy);

            // Never lose the saved value, even if it is not on the account.
            if (current && ![...sel.options].some(o => o.value === current)) {
                sel.appendChild(opt(`${current} (not on your account)`, current));
            }
            // ALLOW-SILENT: the list was just rebuilt from the account and
            // this puts the ALREADY SAVED voice back on it. Nothing changed, so
            // nothing should be recorded — a diff that contains untouched
            // fields is how a bad render becomes data loss.
            sel.value = current;
        }
        say(`${voices.length} voice${voices.length === 1 ? "" : "s"} loaded from your account.`);
    }

    /** Speak a sample line in whichever voice is selected right now. */
    async _previewVoice(content, key) {
        const sel = content.querySelector(`[data-setting-key="${key}"]`);
        const voiceId = sel?.value || "";
        if (!voiceId) {
            ui.notifications?.info("Pick a voice first.");
            return;
        }
        const { ttsEngine } = await import("./npc/tts.mjs");
        const line = key === "elevenLabsFemaleVoiceId"
            ? "This is the alternate voice. Not every character need sound the same."
            : "This is your narrator. The road ahead is dark, and something is waiting on it.";
        // ⚠️ speak() honours the no-robot rule, so a bad key or a dead voice id
        // says why instead of previewing in Windows speech synthesis - which
        // would make a broken voice sound like it worked.
        try { await ttsEngine.speak(line, voiceId); }
        catch (err) { ui.notifications?.error(`ACE Engine — could not play that voice: ${err?.message ?? err}`); }
    }

    async _refreshModels(content) {
        const provider    = content.querySelector('[data-setting-key="aiProvider"]')?.value || "ollama";
        const currentModel = content.querySelector('[data-setting-key="modelName"]')?.value || "";
        const btn = content.querySelector('[data-action="refreshModels"]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Refreshing…';
        }
        try {
            const { clearModelCatalogCache } = await import("./model-catalog.mjs");
            clearModelCatalogCache();
            await this._populateModelDropdownFromCatalog(content, provider, currentModel, /* useCacheOnly= */ false);
            ui.notifications?.info(`ACE Engine — model list refreshed for ${provider}.`);
        } catch (err) {
            console.warn(`${MODULE_ID} | Refresh models failed:`, err);
            ui.notifications?.warn(`Could not refresh ${provider} models: ${err.message?.slice(0, 100) || "unknown error"}`);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Refresh Model List';
            }
        }
    }

    // ─── Populate the modelName <select> from the live catalog ───────────
    // When useCacheOnly is true, only the cached (within 24h TTL) list is
    // used — no network calls. When false, a live fetch is forced.
    async _populateModelDropdownFromCatalog(content, provider, currentValue, useCacheOnly = false) {
        const modelField = content.querySelector('[data-setting-key="modelName"]');
        if (!modelField || modelField.tagName !== "SELECT") return;

        // Helper: replace dropdown options + select currentValue (or prepend
        // it as a "(custom)" entry if not in the list).
        const fillDropdown = (models, valueToSelect) => {
            modelField.innerHTML = "";
            let hasCurrent = false;
            for (const m of models) {
                const opt = document.createElement("option");
                opt.value = m.value;
                const badge       = m.free   ? "🆓 " : "";
                const visionBadge = m.vision ? " 👁"  : "";
                opt.textContent = `${badge}${m.label}${visionBadge}`;
                if (m.value === valueToSelect) {
                    opt.selected = true;
                    hasCurrent = true;
                }
                modelField.appendChild(opt);
            }
            if (valueToSelect && !hasCurrent) {
                const opt = document.createElement("option");
                opt.value = valueToSelect;
                opt.textContent = `${valueToSelect} (custom)`;
                opt.selected = true;
                modelField.prepend(opt);
            }
            // ⚠️ SELECTING AN OPTION IN CODE FIRES NOTHING. Swapping provider
            // repopulates this list and picks that provider's model, which is a
            // real change the GM asked for by swapping — but Save writes only
            // what was RECORDED, so without this the new model was displayed and
            // never saved. _setFieldValue stays silent when the value already
            // matches what is stored, so the open-time rebuild records nothing.
            this._setFieldValue(modelField, valueToSelect);
        };

        // Static fallback — guarantees the dropdown reflects the *new*
        // provider's options even when the live API fetch fails. Without
        // this, switching from Anthropic→OpenAI with the wrong key left
        // the Claude model selected, which is exactly the bug we're fixing.
        // Dynamic-imported here (not at top of file) to avoid the circular
        // import between settings.mjs and config-panel.mjs.
        let staticFallback = [];
        try {
            const { AceSettings } = await import("./settings.mjs");
            staticFallback = AceSettings?.PROVIDER_MODELS?.[provider] ?? [];
        } catch (_) { /* settings module unavailable; static list stays empty */ }

        try {
            const { fetchModelsForProvider } = await import("./model-catalog.mjs");
            const apiKey = content.querySelector('[data-setting-key="apiKey"]')?.value || "";
            const apiUrl = content.querySelector('[data-setting-key="apiUrl"]')?.value || "";
            const models = await fetchModelsForProvider(provider, {
                apiKey, apiUrl,
                forceRefresh: !useCacheOnly,
            });
            if (models?.length) {
                fillDropdown(models, currentValue);
                return;
            }

            // ── Fetch failed / empty — fall back to static list so the
            //    dropdown still reflects the NEW provider, never the old one.
            if (staticFallback.length) {
                fillDropdown(staticFallback, currentValue);
                if (!useCacheOnly) {
                    ui.notifications?.warn(
                        `ACE Engine — couldn't fetch live ${provider} model list (likely missing or invalid API key). Showing static fallback; pick one and Save Changes.`
                    );
                }
            } else if (!useCacheOnly) {
                ui.notifications?.warn(`${provider}: no models returned. Check connection / API key.`);
            }
        } catch (err) {
            console.debug(`${MODULE_ID} | Populate model dropdown failed (non-fatal):`, err);
            // Even on import/throw, try the static fallback so the dropdown
            // doesn't get stranded on the previous provider's selection.
            if (staticFallback.length) fillDropdown(staticFallback, currentValue);
        }
    }

    // ─── Actions ─────────────────────────────────────────────────────────

    async _saveAll() {
        if (!this.element) return;

        // ⚠️🔴 SAVE WRITES WHAT CHANGED. NOT WHAT IS ON SCREEN. (2026-08-21)
        //
        // This used to walk every field in the panel and write all of them on
        // every Save. That sounds harmless and is not: it means any field that
        // renders wrongly, for any reason at all, gets that wrongness committed
        // the moment the GM presses Save on something completely unrelated. It
        // destroyed Johnny's API key exactly that way - the key box rendered
        // empty because of a bad read, and Save faithfully wrote the emptiness
        // over a perfectly good key.
        //
        // ACE Forge has always saved a diff and has never had this class of bug.
        // Johnny, 2026-08-21: "whatever Forge is doing, then do it in the
        // engine." So: a field the user never touched is never written, and a
        // display bug can no longer become a data-loss bug.
        const entries = Object.entries(this._pendingChanges);
        const providerField = this.element.querySelector('[data-setting-key="aiProvider"]');
        const provider = providerField?.value || (() => {
            try { return game.settings.get(MODULE_ID, "aiProvider"); } catch (_) { return ""; }
        })();

        // Nothing typed and no provider swap left pending: say so and stop.
        if (!entries.length && !Object.keys(this._apiKeyVault).length) {
            ui.notifications.info("ACE Engine — no changes to save.");
            this.close();
            return;
        }

        let saved = 0, failed = 0;
        for (const [key, value] of entries) {
            // The provider key is written once, below, straight into the store
            // it actually lives in. Writing it here as well is what created a
            // second copy in the first place.
            if (key === "apiKey") continue;
            try {
                // ⚠️🔴 A PANEL SAVE MAY NEVER EMPTY A KEY THAT HAS A VALUE.
                //
                // 2026-08-22, the twelfth time Johnny lost his ElevenLabs key:
                // browser storage still held the setting, and its value was an
                // EMPTY STRING. Something in this panel recorded a blank for a
                // masked field and the save wrote it out.
                //
                // I removed the old "was it touched" guard when Save became a
                // diff, reasoning that an untouched field can never be in the
                // diff. That reasoning was wrong. It protects against a field
                // nobody interacted with; it does NOT protect against a stray
                // input or change event carrying an empty value — autofill, a
                // re-render, a password manager, a focus bounce. Any one of
                // those puts "" in the diff legitimately.
                //
                // So the rule is now absolute and needs no reasoning about
                // events: this panel cannot blank a key that currently holds
                // one. Clearing a key deliberately is rare and can be done
                // knowingly; losing one silently has cost eleven evenings.
                if (isMaskedKey(key) && !String(value ?? "").trim()) {
                    let existing = "";
                    try {
                        existing = isSecretKey(key)
                            ? (getSecret(key) || "")
                            : (game.settings.get(MODULE_ID, key) || "");
                    } catch (_) { existing = ""; }
                    if (existing) {
                        console.warn(`ACE: Engine | Refused to erase "${key}" — the box was empty but a key is stored. ` +
                                     `Nothing was changed.`);
                        ui.notifications?.warn(
                            `ACE Engine kept your saved ${key === "elevenLabsApiKey" ? "ElevenLabs" : "API"} key. ` +
                            `The box was blank, and blanking is never treated as "delete it".`);
                        continue;
                    }
                }
                if (isSecretKey(key)) await setSecret(key, value);
                else await game.settings.set(MODULE_ID, key, value);
                saved++;
            } catch (err) {
                console.warn(`ACE: Engine | Config panel — failed to save ${key}:`, err);
                failed++;
            }
        }

        // ── The provider keys, in the single place they live ──────────────
        // Merges what is stored, any key stashed while swapping providers, and
        // the one currently typed. One write, one home, no active-key copy.
        try {
            const vault = { ...getSecretVault(), ...this._apiKeyVault };
            if (Object.prototype.hasOwnProperty.call(this._pendingChanges, "apiKey") && provider) {
                const typed = String(this._pendingChanges.apiKey ?? "").trim();
                if (typed) { vault[provider] = typed; saved++; }
                // ⚠️ Same absolute rule as the masked fields above: a blank box
                // never deletes a stored key. This line used to `delete` the
                // vault entry with a comment saying the user meant it, which is
                // the assumption that lost the AI key this morning.
                else if (vault[provider]) {
                    console.warn(`ACE: Engine | Refused to erase the ${provider} key — the box was empty but a key is stored.`);
                    ui.notifications?.warn(`ACE Engine kept your saved ${provider} key. A blank box is never treated as "delete it".`);
                }
            }
            await setSecretVault(vault);
            this._apiKeyVault = vault;
        } catch (err) {
            console.warn("ACE: Engine | Config panel — failed to save API keys:", err);
            failed++;
        }

        this._pendingChanges = {};
        ui.notifications.info(`ACE Engine — saved ${saved} setting${saved === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}.`);
        this.close();
    }

    async _resetTab() {
        const tab = TABS.find(t => t.id === this._activeTab);
        if (!tab) return;

        const confirmed = await Dialog.confirm({
            title: "Reset Tab to Defaults",
            content: `<p>Reset every setting on the <strong>${this._esc(tab.label)}</strong> tab to its default value?</p>
                      <p style="color:#888; font-size:0.85em;">This affects only the visible tab — other settings are untouched.</p>`,
            yes: () => true,
            no:  () => false,
            defaultYes: false,
        });
        if (!confirmed) return;

        for (const key of tab.keys) {
            const meta = game.settings.settings.get(`${MODULE_ID}.${key}`);
            if (!meta) continue;
            try { await game.settings.set(MODULE_ID, key, meta.default); }
            catch (e) { console.warn(`ACE: Engine | Reset failed for ${key}:`, e); }
        }
        for (const key of tabKeys(tab)) delete this._pendingChanges[key];
        const n = tabKeys(tab).length;
        ui.notifications.info(`Reset ${n} setting${n === 1 ? "" : "s"} on ${tab.label} to defaults.`);
        this.render(false);
    }
}
