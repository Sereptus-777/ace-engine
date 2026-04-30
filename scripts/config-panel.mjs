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

        // No honeypot needed — secret fields are now type="text" with CSS
        // text-security masking, so Chrome can't detect a password form at all.

        return `
            <div class="ace-cfg-root">
                <ul class="ace-cfg-tablist" role="tablist">${tabRail}</ul>
                <div class="ace-cfg-pane" data-tab="${activeTab.id}">
                    <header class="ace-cfg-pane-header">
                        <span class="ace-cfg-pane-icon"><i class="${activeTab.icon}"></i></span>
                        <h2>${this._esc(activeTab.label)}</h2>
                    </header>
                    ${activeTab.intro ? `<p class="ace-cfg-intro">${this._esc(activeTab.intro)}</p>` : ""}
                    ${activeTab.id === "ai" ? this._buildAiTabActions() : ""}
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
            // Per-setting "extras" slot — currently used only for the digest
            // model "🐢 slow" warning. Populated/hidden in _wireEvents.
            const extras = key === "digestModel"
                ? `<div class="ace-cfg-extras" data-digest-warning style="grid-column:1 / -1; display:none;"></div>`
                : "";
            rows.push(`
                <div class="ace-cfg-row" data-setting="${this._esc(key)}">
                    <label for="ace-cfg-${this._esc(key)}">${this._esc(meta.name || key)}</label>
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
            return `<input type="text" id="${id}" data-setting-key="${key}" value="${v}" `
                 + `autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" `
                 + `data-lpignore="true" data-1p-ignore="true" data-form-type="other" `
                 + `style="-webkit-text-security: disc; text-security: disc; font-family: text-security-disc, sans-serif; letter-spacing: 0.1em;">`;
        }
        if (meta.type === Boolean) {
            return `<input type="checkbox" id="${id}" data-setting-key="${key}" ${value ? "checked" : ""}>`;
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

    // ─── AI Tab: Test Connection / Refresh Models actions ────────────────
    // Plain buttons (NOT brass-textured) at the top of the AI tab so users
    // can diagnose connection issues before scrolling through settings.
    _buildAiTabActions() {
        return `
            <div class="ace-cfg-ai-actions">
                <button type="button" class="ace-cfg-plainbtn" data-action="testConnection">
                    <i class="fa-solid fa-plug"></i> Test Connection
                </button>
                <button type="button" class="ace-cfg-plainbtn" data-action="refreshModels">
                    <i class="fa-solid fa-rotate"></i> Refresh Model List
                </button>
                <div class="ace-cfg-test-result" data-test-result></div>
            </div>
        `;
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

        // ── AI Provider change → auto-update URL + Model defaults ──────────
        // Picking "Ollama" should set URL to localhost:11434 and Model to a
        // sensible Ollama default. Without this, swapping provider leaves
        // mismatched URL+Model and nothing works.
        const providerSelect = content.querySelector('[data-setting-key="aiProvider"]');
        if (providerSelect) {
            providerSelect.addEventListener("change", async () => {
                const newProvider = providerSelect.value;
                const defaults = PROVIDER_DEFAULTS[newProvider];
                if (!defaults) return;

                // ── Update API URL ──
                const urlField = content.querySelector('[data-setting-key="apiUrl"]');
                if (urlField) {
                    if (urlField.tagName === "SELECT") {
                        const hasOption = Array.from(urlField.options).some(o => o.value === defaults.apiUrl);
                        if (hasOption) urlField.value = defaults.apiUrl;
                        else {
                            const opt = document.createElement("option");
                            opt.value = defaults.apiUrl;
                            opt.textContent = defaults.apiUrl;
                            opt.selected = true;
                            urlField.prepend(opt);
                        }
                    } else {
                        urlField.value = defaults.apiUrl;
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

        // Test Connection (AI tab only)
        content.querySelector('[data-action="testConnection"]')?.addEventListener("click", () => this._testConnection(content));
        // Refresh Models (AI tab only) — wired in step #7 with live model fetch
        content.querySelector('[data-action="refreshModels"]')?.addEventListener("click", () => this._refreshModels(content));

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

        try {
            const { fetchModelsForProvider } = await import("./model-catalog.mjs");
            const apiKey = content.querySelector('[data-setting-key="apiKey"]')?.value || "";
            const apiUrl = content.querySelector('[data-setting-key="apiUrl"]')?.value || "";
            const models = await fetchModelsForProvider(provider, {
                apiKey, apiUrl,
                forceRefresh: !useCacheOnly,
            });
            if (!models?.length) {
                if (!useCacheOnly) ui.notifications?.warn(`${provider}: no models returned. Check connection / API key.`);
                return;
            }

            // Replace the dropdown's options with the live catalog
            modelField.innerHTML = "";
            let hasCurrent = false;
            for (const m of models) {
                const opt = document.createElement("option");
                opt.value = m.value;
                // Prepend free badge to label so it stands out
                const badge = m.free ? "🆓 " : "";
                const visionBadge = m.vision ? " 👁" : "";
                opt.textContent = `${badge}${m.label}${visionBadge}`;
                if (m.value === currentValue) {
                    opt.selected = true;
                    hasCurrent = true;
                }
                modelField.appendChild(opt);
            }
            // If the saved model isn't in the live list, prepend it as a custom entry
            if (currentValue && !hasCurrent) {
                const opt = document.createElement("option");
                opt.value = currentValue;
                opt.textContent = `${currentValue} (custom)`;
                opt.selected = true;
                modelField.prepend(opt);
            }
        } catch (err) {
            console.debug(`${MODULE_ID} | Populate model dropdown failed (non-fatal):`, err);
        }
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
