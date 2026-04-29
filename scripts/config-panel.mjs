// ─── ACE: Engine — Configuration Panel (popup) ─────────────────────────────
// All non-essential settings live here. The standard Foundry "Configure
// Settings" page keeps only the master toggle, AI Provider dropdown, and
// API Key. Everything else opens via the "Open Configuration" menu button.
//
// This is the FUNCTIONAL scaffold — minimal styling. The gunmetal-tech-fancy
// theme is layered on later via ace-engine.css. Tab structure + form rendering
// are stable; only the visual skin changes.

import { MODULE_ID } from "./ace-engine.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// ─── Tab → Setting Key Map ────────────────────────────────────────────────
// Single source of truth for which setting belongs in which tab. Add new
// settings to the appropriate array; the panel picks them up automatically.

const TABS = [
    {
        id: "ai",
        label: "AI Provider",
        icon: "fas fa-microchip",
        intro: "Connect to OpenAI, Anthropic, Ollama, or any compatible model. The API Key for your primary provider lives on the main settings page so it's quick to update.",
        keys: [
            "aiProvider", "apiUrl", "modelName",
            "digestApiKey", "digestModel",
            "gameSystem",
            "systemPrompt",
            "maxContextTokens", "maxResponseTokens",
        ],
    },
    {
        id: "voice",
        label: "Voice & TTS",
        icon: "fas fa-microphone",
        intro: "ElevenLabs for high-quality NPC voices, browser TTS as a free fallback. Set your API key here, pick narrator voices, tune the playback model.",
        keys: [
            "voiceProvider",
            "elevenLabsApiKey",
            "elevenLabsVoiceId", "elevenLabsFemaleVoiceId",
            "narratorVoiceOverrideEnabled", "narratorVoiceOverrideId",
            "elevenLabsModel",
            "narrationVolume",
            "browserVoiceName", "browserFemaleVoiceName",
            "browserVoiceRate", "browserVoicePitch",
        ],
    },
    {
        id: "npc",
        label: "NPC Chat",
        icon: "fas fa-comment",
        intro: "Bio generation, faction assignment, item & loot pipeline, conversation memory. Master switch turns the whole subsystem on/off.",
        keys: [
            "npcChatEnabled",
            "autoGenerateBio", "tokenDropAI", "alwaysRunItemAndLoot",
            "enableSocialProfiles", "enableAutoLink",
            "npcKnowledgeBudget", "npcIntelligenceScaling", "npcKnowledgeCap",
            "enableFactions", "factionSpyChance", "factionWildcardChance",
            "defaultVoiceRegion", "npcWebpFolder",
        ],
    },
    {
        id: "combat",
        label: "Combat",
        icon: "fas fa-shield-alt",
        intro: "Initiative reorder arrows, auto-XP on kill, auto-move dead NPCs to the ☠ Fallen folder.",
        keys: [
            "initiativeReorder",
            "autoDistributeXP",
            "autoCleanupDead",
        ],
    },
    {
        id: "memory",
        label: "Memory & World",
        icon: "fas fa-book",
        intro: "Story notes, fame & reputation, subtle rolls, survival tracker, narrative time.",
        keys: [
            "enableStoryNotes", "enableFameSystem", "enableNarrativeTime",
            "syncSimpleCalendar",
            "enableReputation", "enableDispositionTags",
            "enableSubtleRolls", "subtleRollSkills", "subtleRollAutoDetect", "subtleNarrationLength",
            "enableCritFumble", "enableSurvivalTracker",
        ],
    },
    {
        id: "docs",
        label: "Document Library",
        icon: "fas fa-scroll",
        intro: "Reference document upload, digest extraction, auto-learn to World Bible.",
        keys: [
            "enableDocumentLibrary",
            "docContextBudget",
            "autoMergeDigests", "autoLearnToBible",
            "enableVisionImages",
        ],
    },
    {
        id: "misc",
        label: "Misc",
        icon: "fas fa-cog",
        intro: "Profanity filter, suggestion engine, PC glow indicator, debug mode.",
        keys: [
            "profanityFilter",
            "autoSuggestions", "suggestionInterval",
            "pcGlow",
            "debugMode",
        ],
    },
];

// Settings whose name should render as a password input
const SECRET_KEYS = new Set(["apiKey", "digestApiKey", "elevenLabsApiKey"]);

// ─── Panel Class ──────────────────────────────────────────────────────────

export class AceConfigPanel extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id:       "ace-engine-config-panel",
        classes:  ["ace-engine", "ace-config-panel"],
        tag:      "form",
        window: {
            title:        "ACE Engine — Configuration",
            icon:         "fas fa-sliders-h",
            resizable:    true,
            minimizable:  true,
        },
        position: {
            width:  900,
            height: 720,
        },
        actions: {
            switchTab:   AceConfigPanel._onSwitchTab,
            saveAll:     AceConfigPanel._onSaveAll,
            cancel:      AceConfigPanel._onCancel,
            resetTab:    AceConfigPanel._onResetTab,
        },
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/config-panel.html` },
    };

    /** @type {string} active tab id */
    _activeTab = "ai";

    async _prepareContext(options) {
        const tabs = TABS.map(tab => ({
            ...tab,
            active: tab.id === this._activeTab,
            settings: this._collectSettings(tab.keys),
        }));
        return {
            moduleId: MODULE_ID,
            tabs,
            activeTabId: this._activeTab,
        };
    }

    /** Pull metadata + current value for each setting key in this tab. */
    _collectSettings(keys) {
        const out = [];
        for (const key of keys) {
            const fullKey = `${MODULE_ID}.${key}`;
            const meta = game.settings.settings.get(fullKey);
            if (!meta) {
                console.warn(`ACE: Engine | Config panel — setting "${key}" not registered, skipping.`);
                continue;
            }
            const value = (() => {
                try { return game.settings.get(MODULE_ID, key); }
                catch (_) { return meta.default; }
            })();
            const isPassword = SECRET_KEYS.has(key);
            const choices = meta.choices || null;
            const range = meta.range || null;
            const inputType = (() => {
                if (isPassword) return "password";
                if (meta.type === Boolean) return "checkbox";
                if (meta.type === Number) return range ? "range-number" : "number";
                if (choices) return "select";
                return "text";
            })();
            out.push({
                key,
                fullKey,
                name: meta.name || key,
                hint: meta.hint || "",
                value,
                isPassword,
                inputType,
                isCheckbox:  inputType === "checkbox",
                isSelect:    inputType === "select",
                isText:      inputType === "text",
                isNumber:    inputType === "number",
                isRange:     inputType === "range-number",
                isPasswordI: inputType === "password",
                choices,
                rangeMin:    range?.min  ?? "",
                rangeMax:    range?.max  ?? "",
                rangeStep:   range?.step ?? "",
                choicePairs: choices ? Object.entries(choices).map(([v, l]) => ({ value: v, label: l, selected: v === value })) : null,
                defaultValue: meta.default,
            });
        }
        return out;
    }

    // ─── ACTIONS ──────────────────────────────────────────────────────────

    static _onSwitchTab(event, target) {
        const newTab = target?.dataset?.tab;
        if (!newTab) return;
        this._activeTab = newTab;
        this.render(false);
    }

    static async _onSaveAll(event, target) {
        event.preventDefault();
        const form = this.element.querySelector("form, .ace-config-form");
        if (!form) return;

        let saved = 0;
        let failed = 0;
        // Iterate every input/select with a data-setting-key attribute
        for (const el of form.querySelectorAll("[data-setting-key]")) {
            const key = el.dataset.settingKey;
            if (!key) continue;
            try {
                let value;
                if (el.type === "checkbox") {
                    value = el.checked;
                } else if (el.type === "number" || el.type === "range") {
                    value = Number(el.value);
                    if (Number.isNaN(value)) value = 0;
                } else {
                    value = el.value;
                }
                await game.settings.set(MODULE_ID, key, value);
                saved++;
            } catch (err) {
                console.warn(`ACE: Engine | Config panel — failed to save ${key}:`, err);
                failed++;
            }
        }
        ui.notifications.info(`ACE Engine — saved ${saved} setting${saved === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}.`);
        this.close();
    }

    static _onCancel(event, target) {
        event.preventDefault();
        this.close();
    }

    static async _onResetTab(event, target) {
        event.preventDefault();
        const tabId = this._activeTab;
        const tab = TABS.find(t => t.id === tabId);
        if (!tab) return;

        const confirmed = await Dialog.confirm({
            title: "Reset Tab to Defaults",
            content: `<p>Reset every setting on the <strong>${tab.label}</strong> tab to its default value?</p>
                      <p style="color:#888; font-size:0.85em;">This affects only the visible tab — other settings are untouched.</p>`,
            yes: () => true,
            no: () => false,
            defaultYes: false,
        });
        if (!confirmed) return;

        for (const key of tab.keys) {
            const meta = game.settings.settings.get(`${MODULE_ID}.${key}`);
            if (!meta) continue;
            try { await game.settings.set(MODULE_ID, key, meta.default); }
            catch (e) { console.warn(`ACE: Engine | Config panel — reset failed for ${key}:`, e); }
        }
        ui.notifications.info(`Reset ${tab.keys.length} setting${tab.keys.length === 1 ? "" : "s"} on ${tab.label} to defaults.`);
        this.render(false);
    }

    // ─── Open Helper ──────────────────────────────────────────────────────

    /** Opens (or focuses) the singleton config panel. */
    static open() {
        if (!AceConfigPanel._instance || AceConfigPanel._instance._closed) {
            AceConfigPanel._instance = new AceConfigPanel();
        }
        AceConfigPanel._instance.render(true);
    }
}
