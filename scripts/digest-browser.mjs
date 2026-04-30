// ─── ACE: Engine — Digest Browser ─────────────────────────────────────────
// Opens a window showing every entity the AI extracted from a digested book:
// NPCs, locations, factions, items, encounters, plot hooks, lore, plus the
// AI-generated summary. Searchable, clickable, expandable. The point is to
// give the GM visible proof that digestion actually captured the data.

const MODULE_ID = "ace-engine";
const { ApplicationV2 } = foundry.applications.api;

// Categories shown as tabs in the browser, in display order.
// Each entry: id (key in the digest data), label, icon, primary field.
const CATEGORIES = [
    { id: "npcs",       label: "NPCs",       icon: "fa-solid fa-user",          name: "name",  brief: ["role", "location", "faction"] },
    { id: "locations",  label: "Locations",  icon: "fa-solid fa-map-location",  name: "name",  brief: ["type", "region", "parent_location"] },
    { id: "factions",   label: "Factions",   icon: "fa-solid fa-flag",          name: "name",  brief: ["type", "alignment", "leader"] },
    { id: "items",      label: "Items",      icon: "fa-solid fa-gem",           name: "name",  brief: ["type", "location"] },
    { id: "encounters", label: "Encounters", icon: "fa-solid fa-skull",         name: "name",  brief: ["location", "difficulty"] },
    { id: "plotHooks",  label: "Plot Hooks", icon: "fa-solid fa-bolt",          name: "title", brief: ["trigger"] },
    { id: "lore",       label: "Lore",       icon: "fa-solid fa-scroll",        name: "topic", brief: [] },
];

export class DigestBrowser extends ApplicationV2 {

    static DEFAULT_OPTIONS = {
        id:      "ace-digest-browser",
        classes: ["ace-digest-browser"],
        tag:     "div",
        window: {
            title:       "ACE — Digest Browser",
            icon:        "fa-solid fa-book-atlas",
            resizable:   true,
            minimizable: true,
        },
        position: {
            width:  920,
            height: 760,
        },
    };

    constructor(digestId, options = {}) {
        super(options);
        this._digestId        = digestId;
        this._activeCategory  = "npcs";
        this._search          = "";
        this._expandedEntries = new Set();   // string keys: "npcs:0", "locations:3"
        this._summaryExpanded = false;
        this._digestData      = null;        // populated by _load()
        this._digestMeta      = null;
    }

    async _load() {
        const eng = game.modules.get(MODULE_ID)?.api?.digestEngine;
        if (!eng) {
            this._digestData = null;
            return;
        }
        try {
            this._digestMeta = eng.getDigestMeta?.(this._digestId) ?? null;
            this._digestData = await eng.loadDigest?.(this._digestId) ?? null;
        } catch (err) {
            console.warn(`${MODULE_ID} | DigestBrowser load failed:`, err);
        }
    }

    // ─── Render lifecycle ────────────────────────────────────────────────

    async _renderHTML(_context, _options) {
        if (!this._digestData) await this._load();
        return this._buildHTML();
    }

    _replaceHTML(result, content, _options) {
        content.innerHTML = result;
        this._wireEvents(content);
    }

    // ─── HTML builders ───────────────────────────────────────────────────

    _buildHTML() {
        if (!this._digestData) {
            return `<div class="ace-digbrw-error">
                Could not load digest <code>${this._esc(this._digestId)}</code>.
                Either the digest doesn't exist or the engine isn't ready.
            </div>`;
        }

        const meta    = this._digestMeta ?? {};
        const data    = this._digestData;
        const summary = data.summary ?? "";

        // Update window title with the source name
        try {
            const title = meta.displayName ?? meta.sourceFile ?? "Digest Browser";
            this.options.window.title = `Digest — ${title}`;
        } catch (_) {}

        // Tab rail with counts
        const tabsHtml = CATEGORIES.map(cat => {
            const count = (data[cat.id] ?? []).length;
            const active = cat.id === this._activeCategory ? "active" : "";
            return `
                <button type="button" class="ace-digbrw-tab ${active}" data-category="${cat.id}">
                    <span class="ace-digbrw-tab-icon"><i class="${cat.icon}"></i></span>
                    <span class="ace-digbrw-tab-label">${this._esc(cat.label)}</span>
                    <span class="ace-digbrw-tab-count">${count}</span>
                </button>
            `;
        }).join("");

        // Summary block (collapsible)
        const summaryHtml = summary ? `
            <div class="ace-digbrw-summary ${this._summaryExpanded ? "expanded" : ""}">
                <div class="ace-digbrw-summary-head" data-action="toggleSummary">
                    <i class="fa-solid fa-feather-pointed"></i>
                    <span>AI Summary</span>
                    <i class="fa-solid fa-chevron-down ace-digbrw-summary-chevron"></i>
                </div>
                <div class="ace-digbrw-summary-body">${this._renderProse(summary)}</div>
            </div>
        ` : "";

        // Active category content
        const activeCat = CATEGORIES.find(c => c.id === this._activeCategory) ?? CATEGORIES[0];
        const entryListHtml = this._buildEntryList(activeCat, data[activeCat.id] ?? []);

        // Top metadata strip
        const sourceName = meta.displayName ?? meta.sourceFile ?? "Unknown";
        const pageCount  = meta.pageCount ? `${meta.pageCount} pages` : "";
        const digestedAt = meta.digestedAt ? new Date(meta.digestedAt).toLocaleDateString() : "";
        const modelUsed  = meta.modelUsed ?? meta.model ?? "";
        const totalEntries = CATEGORIES.reduce((sum, c) => sum + (data[c.id]?.length ?? 0), 0);

        const metaBits = [
            sourceName ? `<strong>${this._esc(sourceName)}</strong>` : "",
            pageCount ? this._esc(pageCount) : "",
            digestedAt ? `digested ${this._esc(digestedAt)}` : "",
            modelUsed ? `via ${this._esc(modelUsed)}` : "",
            `<strong>${totalEntries}</strong> total entries`,
        ].filter(Boolean).join("  ·  ");

        return `
            <div class="ace-digbrw-root">
                <header class="ace-digbrw-header">
                    <div class="ace-digbrw-meta">${metaBits}</div>
                    <div class="ace-digbrw-search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input type="text" class="ace-digbrw-search"
                               placeholder="Search ${activeCat.label.toLowerCase()}…"
                               value="${this._esc(this._search)}"
                               autocomplete="off" data-lpignore="true" data-1p-ignore="true">
                    </div>
                </header>

                ${summaryHtml}

                <div class="ace-digbrw-body">
                    <nav class="ace-digbrw-tabs">${tabsHtml}</nav>
                    <main class="ace-digbrw-content">
                        ${entryListHtml}
                    </main>
                </div>
            </div>
        `;
    }

    _buildEntryList(category, entries) {
        if (!entries || entries.length === 0) {
            return `<div class="ace-digbrw-empty">
                <i class="${category.icon}"></i>
                <p>No ${category.label.toLowerCase()} were extracted from this source.</p>
            </div>`;
        }

        // Filter by search
        const search = this._search.trim().toLowerCase();
        const filtered = !search ? entries : entries.filter(e => {
            try {
                return JSON.stringify(e).toLowerCase().includes(search);
            } catch { return false; }
        });

        if (filtered.length === 0) {
            return `<div class="ace-digbrw-empty">
                <i class="fa-solid fa-magnifying-glass"></i>
                <p>No ${category.label.toLowerCase()} match "<strong>${this._esc(search)}</strong>".</p>
            </div>`;
        }

        // Sort by primary field
        const nameField = category.name;
        const sorted = [...filtered].sort((a, b) => {
            const an = String(a[nameField] ?? "").toLowerCase();
            const bn = String(b[nameField] ?? "").toLowerCase();
            return an.localeCompare(bn);
        });

        return sorted.map((entry, idx) => this._buildEntryCard(category, entry, idx)).join("");
    }

    _buildEntryCard(category, entry, idx) {
        const key       = `${category.id}:${idx}`;
        const expanded  = this._expandedEntries.has(key);
        const nameField = category.name;
        const name      = entry[nameField] ?? "(unnamed)";

        // Brief inline summary — show 1-3 important fields right beside the name
        const briefBits = (category.brief ?? [])
            .map(f => entry[f])
            .filter(Boolean)
            .map(v => Array.isArray(v) ? v.join(", ") : String(v))
            .filter(s => s && s.length < 80);

        const knowledge = entry.knowledge_level ?? entry.knowledgeLevel ?? "";
        const knowledgeBadge = knowledge ? `<span class="ace-digbrw-knowledge ace-digbrw-knowledge-${this._esc(String(knowledge).toLowerCase())}">${this._esc(knowledge)}</span>` : "";

        // Detail view — every field of the entry, formatted
        const detailHtml = expanded ? this._buildEntryDetail(entry) : "";

        return `
            <article class="ace-digbrw-entry ${expanded ? "expanded" : ""}" data-entry-key="${key}">
                <header class="ace-digbrw-entry-head" data-action="toggleEntry" data-entry-key="${key}">
                    <i class="fa-solid fa-chevron-right ace-digbrw-entry-chevron"></i>
                    <span class="ace-digbrw-entry-name">${this._esc(name)}</span>
                    ${briefBits.length ? `<span class="ace-digbrw-entry-brief">${briefBits.map(b => this._esc(b)).join(" · ")}</span>` : ""}
                    ${knowledgeBadge}
                </header>
                ${detailHtml}
            </article>
        `;
    }

    _buildEntryDetail(entry) {
        // Render every field as a label/value row. Skip the primary name (shown in header) and empty values.
        const skipFields = new Set(["name", "title", "topic"]);
        const rows = [];

        for (const [field, value] of Object.entries(entry)) {
            if (skipFields.has(field)) continue;
            if (value == null || value === "") continue;
            if (Array.isArray(value) && value.length === 0) continue;

            const label = this._humanizeField(field);
            const display = this._formatValue(value);
            rows.push(`
                <div class="ace-digbrw-field">
                    <div class="ace-digbrw-field-label">${this._esc(label)}</div>
                    <div class="ace-digbrw-field-value">${display}</div>
                </div>
            `);
        }

        if (!rows.length) {
            return `<div class="ace-digbrw-entry-body"><em>No additional details.</em></div>`;
        }

        return `<div class="ace-digbrw-entry-body">${rows.join("")}</div>`;
    }

    _humanizeField(field) {
        // snake_case / camelCase → "Snake Case" / "Camel Case"
        return field
            .replace(/_/g, " ")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    _formatValue(value) {
        if (Array.isArray(value)) {
            // Array of strings → bullet list. Array of objects → inline list of names.
            if (value.every(v => typeof v === "string" || typeof v === "number")) {
                return `<ul class="ace-digbrw-field-list">${value.map(v => `<li>${this._esc(String(v))}</li>`).join("")}</ul>`;
            }
            return `<ul class="ace-digbrw-field-list">${value.map(v => `<li>${this._esc(JSON.stringify(v))}</li>`).join("")}</ul>`;
        }
        if (typeof value === "object" && value !== null) {
            return `<pre class="ace-digbrw-field-json">${this._esc(JSON.stringify(value, null, 2))}</pre>`;
        }
        return this._renderProse(String(value));
    }

    _renderProse(text) {
        // Light prose rendering: escape HTML, preserve paragraph breaks.
        const escaped = this._esc(text);
        const paragraphs = escaped.split(/\n\s*\n/).map(p => p.replace(/\n/g, "<br>"));
        return paragraphs.map(p => `<p>${p}</p>`).join("");
    }

    _esc(s) {
        return String(s ?? "")
            .replace(/&/g,  "&amp;")
            .replace(/</g,  "&lt;")
            .replace(/>/g,  "&gt;")
            .replace(/"/g,  "&quot;")
            .replace(/'/g,  "&#39;");
    }

    // ─── Event wiring ────────────────────────────────────────────────────

    _wireEvents(content) {
        // Tab clicks
        content.querySelectorAll(".ace-digbrw-tab").forEach(el => {
            el.addEventListener("click", () => {
                this._activeCategory = el.dataset.category;
                this._search = "";        // reset search when changing tabs
                this._expandedEntries = new Set();
                this.render(false);
            });
        });

        // Entry expand/collapse
        content.querySelectorAll('[data-action="toggleEntry"]').forEach(el => {
            el.addEventListener("click", () => {
                const key = el.dataset.entryKey;
                if (this._expandedEntries.has(key)) {
                    this._expandedEntries.delete(key);
                } else {
                    this._expandedEntries.add(key);
                }
                this.render(false);
            });
        });

        // Summary toggle
        content.querySelector('[data-action="toggleSummary"]')?.addEventListener("click", () => {
            this._summaryExpanded = !this._summaryExpanded;
            this.render(false);
        });

        // Search input — debounced re-render
        const searchInput = content.querySelector(".ace-digbrw-search");
        if (searchInput) {
            // Restore focus + caret position after re-render
            const cursorPos = searchInput === document.activeElement
                ? { start: searchInput.selectionStart, end: searchInput.selectionEnd } : null;
            if (cursorPos) {
                searchInput.focus();
                try { searchInput.setSelectionRange(cursorPos.start, cursorPos.end); } catch (_) {}
            }

            let debounce;
            searchInput.addEventListener("input", () => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                    this._search = searchInput.value;
                    this._expandedEntries = new Set();   // collapse all when searching
                    this.render(false);
                }, 200);
            });
        }
    }
}

// ─── Public entry point ───────────────────────────────────────────────────

/**
 * Open a digest browser for the given digest id.
 * @param {string} digestId
 */
export function showDigestBrowser(digestId) {
    if (!digestId) {
        ui.notifications?.warn("ACE: no digest id provided.");
        return;
    }
    new DigestBrowser(digestId).render(true);
}
