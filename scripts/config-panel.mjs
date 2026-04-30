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

const MODULE_ID = "ace-engine";
const { ApplicationV2 } = foundry.applications.api;

const SECRET_KEYS = new Set(["apiKey", "digestApiKey", "elevenLabsApiKey"]);

// ─── Tab → Setting Key Map ────────────────────────────────────────────────
// Single source of truth for which setting belongs in which tab.

const TABS = [
    {
        id: "ai", label: "AI Provider", icon: "fa-solid fa-microchip",
        intro: "Connect to OpenAI, Anthropic, Ollama, or any compatible model. The primary API Key lives on the main settings page so it's quick to update.",
        keys: ["aiProvider", "apiUrl", "modelName", "digestApiKey", "digestModel", "gameSystem", "systemPrompt", "maxContextTokens", "maxResponseTokens"],
    },
    {
        id: "voice", label: "Voice & TTS", icon: "fa-solid fa-microphone",
        intro: "ElevenLabs for high-quality NPC voices, browser TTS as a free fallback. Set your API key here, pick narrator voices, tune the playback model.",
        keys: ["voiceProvider", "elevenLabsApiKey", "elevenLabsVoiceId", "elevenLabsFemaleVoiceId", "narratorVoiceOverrideEnabled", "narratorVoiceOverrideId", "elevenLabsModel", "narrationVolume", "browserVoiceName", "browserFemaleVoiceName", "browserVoiceRate", "browserVoicePitch"],
    },
    {
        id: "npc", label: "NPC Chat", icon: "fa-solid fa-comment",
        intro: "Bio generation, faction assignment, item & loot pipeline, conversation memory. Master switch turns the whole subsystem on/off.",
        keys: ["npcChatEnabled", "autoGenerateBio", "tokenDropAI", "alwaysRunItemAndLoot", "enableSocialProfiles", "enableAutoLink", "npcKnowledgeBudget", "npcIntelligenceScaling", "npcKnowledgeCap", "enableFactions", "factionSpyChance", "factionWildcardChance", "defaultVoiceRegion", "npcWebpFolder"],
    },
    {
        id: "combat", label: "Combat", icon: "fa-solid fa-shield-alt",
        intro: "Initiative reorder arrows, auto-XP on kill, auto-move dead NPCs to the ☠ Fallen folder.",
        keys: ["initiativeReorder", "autoDistributeXP", "autoCleanupDead"],
    },
    {
        id: "memory", label: "Memory & World", icon: "fa-solid fa-book",
        intro: "Story notes, fame & reputation, subtle rolls, survival tracker, narrative time.",
        keys: ["enableStoryNotes", "enableFameSystem", "enableNarrativeTime", "syncSimpleCalendar", "enableReputation", "enableDispositionTags", "enableSubtleRolls", "subtleRollSkills", "subtleRollAutoDetect", "subtleNarrationLength", "enableCritFumble", "enableSurvivalTracker"],
    },
    {
        id: "docs", label: "Document Library", icon: "fa-solid fa-scroll",
        intro: "Reference document upload, digest extraction, auto-learn to World Bible.",
        keys: ["enableDocumentLibrary", "docContextBudget", "autoMergeDigests", "autoLearnToBible", "enableVisionImages"],
    },
    {
        id: "misc", label: "Misc", icon: "fa-solid fa-cog",
        intro: "Profanity filter, suggestion engine, PC glow indicator, debug mode.",
        keys: ["profanityFilter", "autoSuggestions", "suggestionInterval", "pcGlow", "debugMode"],
    },
];

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
    }

    // ─── Render lifecycle ────────────────────────────────────────────────

    async _renderHTML(_context, _options) {
        return this._buildHTML();
    }

    _replaceHTML(result, content, _options) {
        content.innerHTML = result;
        this._wireEvents(content);
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

        const activeTab = TABS.find(t => t.id === this._activeTab) || TABS[0];
        const settingsHtml = this._buildSettingsHTML(activeTab);

        return `
            <div class="ace-cfg-root">
                <ul class="ace-cfg-tablist" role="tablist">${tabRail}</ul>
                <div class="ace-cfg-pane" data-tab="${activeTab.id}">
                    <header class="ace-cfg-pane-header">
                        <span class="ace-cfg-pane-icon"><i class="${activeTab.icon}"></i></span>
                        <h2>${this._esc(activeTab.label)}</h2>
                    </header>
                    ${activeTab.intro ? `<p class="ace-cfg-intro">${this._esc(activeTab.intro)}</p>` : ""}
                    <div class="ace-cfg-settings">${settingsHtml}</div>
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

    _buildSettingsHTML(tab) {
        const rows = [];
        for (const key of tab.keys) {
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
            const inputHtml = this._buildInput(key, meta, value, isPassword);
            rows.push(`
                <div class="ace-cfg-row" data-setting="${this._esc(key)}">
                    <label for="ace-cfg-${this._esc(key)}">${this._esc(meta.name || key)}</label>
                    <div class="ace-cfg-input">${inputHtml}</div>
                    ${meta.hint ? `<p class="ace-cfg-hint">${this._esc(meta.hint)}</p>` : ""}
                </div>
            `);
        }
        return rows.join("");
    }

    _buildInput(key, meta, value, isPassword) {
        const id = `ace-cfg-${key}`;
        const v  = this._esc(String(value ?? ""));

        if (isPassword) {
            return `<input type="password" id="${id}" data-setting-key="${key}" value="${v}" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true">`;
        }
        if (meta.type === Boolean) {
            return `<input type="checkbox" id="${id}" data-setting-key="${key}" ${value ? "checked" : ""}>`;
        }
        if (meta.choices) {
            const options = Object.entries(meta.choices).map(([val, label]) => {
                const sel = String(val) === String(value) ? "selected" : "";
                return `<option value="${this._esc(val)}" ${sel}>${this._esc(label)}</option>`;
            }).join("");
            return `<select id="${id}" data-setting-key="${key}">${options}</select>`;
        }
        if (meta.type === Number) {
            const range = meta.range;
            if (range) {
                return `
                    <div class="ace-cfg-range">
                        <input type="range" value="${v}" min="${range.min}" max="${range.max}" step="${range.step ?? 1}" data-slider-for="${id}">
                        <input type="number" id="${id}" data-setting-key="${key}" value="${v}" min="${range.min}" max="${range.max}" step="${range.step ?? 1}">
                    </div>
                `;
            }
            return `<input type="number" id="${id}" data-setting-key="${key}" value="${v}" autocomplete="off">`;
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

    // ─── Event wiring (manual, after _replaceHTML) ───────────────────────

    _wireEvents(content) {
        // Tab clicks → switch active tab + re-render
        content.querySelectorAll(".ace-cfg-tab").forEach(el => {
            el.addEventListener("click", () => {
                this._activeTab = el.dataset.tab;
                this.render(false);
            });
        });

        // Range sliders ↔ number input two-way binding
        content.querySelectorAll('input[type="range"][data-slider-for]').forEach(slider => {
            const target = content.querySelector(`#${slider.dataset.sliderFor}`);
            if (!target) return;
            slider.addEventListener("input", () => { target.value = slider.value; });
            target.addEventListener("input", () => { slider.value = target.value; });
        });

        // Footer buttons
        content.querySelector('[data-action="saveAll"]')?.addEventListener("click", () => this._saveAll());
        content.querySelector('[data-action="cancel"]')?.addEventListener("click",  () => this.close());
        content.querySelector('[data-action="resetTab"]')?.addEventListener("click", () => this._resetTab());
    }

    // ─── Actions ─────────────────────────────────────────────────────────

    async _saveAll() {
        if (!this.element) return;
        let saved = 0, failed = 0;
        for (const el of this.element.querySelectorAll("[data-setting-key]")) {
            const key = el.dataset.settingKey;
            if (!key) continue;
            try {
                let value;
                if (el.type === "checkbox") value = el.checked;
                else if (el.type === "number" || el.type === "range") {
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
        ui.notifications.info(`Reset ${tab.keys.length} setting${tab.keys.length === 1 ? "" : "s"} on ${tab.label} to defaults.`);
        this.render(false);
    }
}
