// ─── ACE: Engine — Library Window ─────────────────────────────────────────
// Dedicated window for document library, digest browser, and World Bible.
// Pulled out of the main panel because:
//   • It's prep-time work (uploading PDFs, generating digests, world building),
//     not in-session GM tools (Chat, Narration, Ideas, Encounter, Select)
//   • It needs more screen real estate than a tab inside a 555×740 panel
//   • Bigger fonts and higher contrast for actually-readable text
//
// Architecture: this window is a THIN delegating shell. The panel still
// owns the engines (documentEngine, digestEngine, worldBible) because the
// chat / encounter / NPC pipelines read from them. The LibraryWindow gets
// references via getter delegation — when a Library action runs, `this`
// is the LibraryWindow and the getters forward each property/method to
// the panel. Both UIs share state cleanly.

const MODULE_ID = "ace-engine";
const { ApplicationV2 } = foundry.applications.api;

// Lazy-import AcePanel's static action handlers to register them in our
// own actions map. Done at construction time to avoid a circular import
// at module load.
let _AcePanelClass = null;
async function _getAcePanelClass() {
    if (_AcePanelClass) return _AcePanelClass;
    const mod = await import("./panel.mjs");
    _AcePanelClass = mod.AcePanel;
    return _AcePanelClass;
}

export class LibraryWindow extends ApplicationV2 {

    static DEFAULT_OPTIONS = {
        id:      "ace-library-window",
        classes: ["ace-library-window"],
        tag:     "div",
        window: {
            title:       "ACE — Library",
            icon:        "fa-solid fa-book-atlas",
            resizable:   true,
            minimizable: true,
        },
        position: {
            width:  1080,
            height: 820,
        },
        // All of the lib* / world-bible action handlers are static methods
        // on AcePanel. We register them via plain function expressions (NOT
        // arrows) so ApplicationV2's call-with-app-instance-as-`this`
        // semantics work — the function then forwards `this` (the
        // LibraryWindow instance) into the panel's static handler. The
        // window's getter delegation maps property reads back to the panel.
        actions: {
            libUploadClick:          function(e, t) { return LibraryWindow._delegate.call(this, "_onLibUploadClick", e, t); },
            libToggleCollapse:       function(e, t) { return LibraryWindow._delegate.call(this, "_onLibToggleCollapse", e, t); },
            libToggleDoc:            function(e, t) { return LibraryWindow._delegate.call(this, "_onLibToggleDoc", e, t); },
            libEditName:             function(e, t) { return LibraryWindow._delegate.call(this, "_onLibEditName", e, t); },
            libEditYear:             function(e, t) { return LibraryWindow._delegate.call(this, "_onLibEditYear", e, t); },
            libEditTags:             function(e, t) { return LibraryWindow._delegate.call(this, "_onLibEditTags", e, t); },
            libDeleteDoc:            function(e, t) { return LibraryWindow._delegate.call(this, "_onLibDeleteDoc", e, t); },
            libHardDeleteDoc:        function(e, t) { return LibraryWindow._delegate.call(this, "_onLibHardDeleteDoc", e, t); },
            libNukeAll:              function(e, t) { return LibraryWindow._delegate.call(this, "_onLibNukeAll", e, t); },
            libGenerateDigest:       function(e, t) { return LibraryWindow._delegate.call(this, "_onLibGenerateDigest", e, t); },
            libMergeIntoBible:       function(e, t) { return LibraryWindow._delegate.call(this, "_onLibMergeIntoBible", e, t); },
            libMergeDigestIntoBible: function(e, t) { return LibraryWindow._delegate.call(this, "_onLibMergeDigestIntoBible", e, t); },
            libToggleDigest:         function(e, t) { return LibraryWindow._delegate.call(this, "_onLibToggleDigest", e, t); },
            libDeleteDigest:         function(e, t) { return LibraryWindow._delegate.call(this, "_onLibDeleteDigest", e, t); },
            libBrowseDigest:         function(e, t) { return LibraryWindow._delegate.call(this, "_onLibBrowseDigest", e, t); },
            digestPause:             function(e, t) { return LibraryWindow._delegate.call(this, "_onDigestPause", e, t); },
            worldBibleGenerate:      function(e, t) { return LibraryWindow._delegate.call(this, "_onWorldBibleGenerate", e, t); },
            worldBibleRegenerate:    function(e, t) { return LibraryWindow._delegate.call(this, "_onWorldBibleRegenerate", e, t); },
            // ── Recovery — opens the Digest Recovery dialog ────
            openRecovery:            function(_e, _t) {
                if (!this._panel) return;
                import("./digest-recovery.mjs").then(({ openRecoveryDialog }) => openRecoveryDialog(this._panel))
                    .catch(err => {
                        console.error("ACE | Failed to open Recovery dialog:", err);
                        ui.notifications?.error(`ACE: Could not open Recovery — ${err.message?.slice(0, 100) ?? "unknown error"}`);
                    });
            },
        },
    };

    constructor(panel, options = {}) {
        super(options);
        this._panel = panel;
    }

    /**
     * Delegate an action handler call to the panel's matching static method.
     * `this` inside the action callback is the LibraryWindow; the panel's
     * static handlers expect `this` to have the engine references — our
     * getter delegation provides that.
     */
    static async _delegate(methodName, event, target) {
        // `this` here is the LibraryWindow instance (ApplicationV2 binds it)
        const Panel = await _getAcePanelClass();
        const fn = Panel?.[methodName];
        if (typeof fn !== "function") {
            console.warn(`${MODULE_ID} | LibraryWindow: no panel handler "${methodName}"`);
            return;
        }
        // Call the static handler with `this` pointing at the LibraryWindow.
        // Its body reads this._documentEngine / this._refreshLibraryUI / etc.,
        // which our getters forward to the panel.
        return fn.call(this, event, target);
    }

    // ─── Engine + state delegation ──────────────────────────────────────
    // The panel owns all of these. We forward reads/writes through so the
    // panel's static handlers behave identically when called with `this` =
    // LibraryWindow.

    get ai()                  { return this._panel?.ai; }
    get _documentEngine()     { return this._panel?._documentEngine; }
    get _digestEngine()       { return this._panel?._digestEngine; }
    get _worldBible()         { return this._panel?._worldBible; }
    get _expandedLibCards()   { return this._panel?._expandedLibCards; }
    set _expandedLibCards(v)  { if (this._panel) this._panel._expandedLibCards = v; }

    // Panel helper methods that the action handlers call internally.
    _buildLibraryPanel()      { return this._panel?._buildLibraryPanel?.() ?? ""; }
    _buildDocumentCard(d)     { return this._panel?._buildDocumentCard?.(d) ?? ""; }
    _buildOrphanDigestCard(d) { return this._panel?._buildOrphanDigestCard?.(d) ?? ""; }
    _buildWorldBibleSection() { return this._panel?._buildWorldBibleSection?.() ?? ""; }

    _generateDigest(docId)    { return this._panel?._generateDigest?.(docId); }
    _processUploadedFiles(f)  { return this._panel?._processUploadedFiles?.(f); }
    _processDocument(...args) { return this._panel?._processDocument?.(...args); }
    _saveDocuments()          { return this._panel?._saveDocuments?.(); }

    /**
     * Re-render the Library UI. The panel's old _refreshLibraryUI method
     * pointed at [data-tab-content="library"] inside the panel; in the
     * window it's just a full re-render.
     */
    _refreshLibraryUI() {
        if (!this.rendered) return;
        this.render(false);
    }

    // ─── Render lifecycle ────────────────────────────────────────────────

    async _renderHTML(_context, _options) {
        return this._buildHTML();
    }

    _replaceHTML(result, content, _options) {
        content.innerHTML = result;
        this._wireEvents(content);
    }

    /**
     * Inject a minimize button into the window header.
     *
     * Foundry V13's ApplicationV2 frame only ships a close button by default —
     * the minimize button needs to be added manually. AcePanel does this with
     * a custom "minimize to floating badge" flow; the Library doesn't need
     * that flourish, so we use Foundry's built-in `this.minimize()` which
     * collapses to a standard horizontal bar (same as any native Foundry
     * window). Idempotent — won't double-add on re-renders.
     */
    _onRender(_context, _options) {
        const header = this.element?.querySelector?.(".window-header");
        if (!header) return;
        if (header.querySelector(".ace-library-btn-minimize")) return;
        const minBtn = document.createElement("button");
        minBtn.type = "button";
        minBtn.className = "header-control ace-library-btn-minimize";
        minBtn.title = "Minimize";
        minBtn.innerHTML = '<i class="fas fa-minus"></i>';
        minBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.minimize();
        });
        // Insert immediately before the close button so the order matches
        // every other Foundry window (minimize, then close, top-right corner).
        const closeBtn = header.querySelector('button[data-action="close"], button.close, .header-control:last-of-type');
        if (closeBtn) header.insertBefore(minBtn, closeBtn);
        else header.appendChild(minBtn);
    }

    _buildHTML() {
        // Wrap the panel's existing _buildLibraryPanel output in a window-
        // scoped container so our larger-font, higher-contrast CSS hits
        // only this window without polluting the panel's other tabs.
        // The toolbar at the top exposes the "Recover Lost Digests" entry
        // — useful when a digest run crashed mid-way and left WIP files
        // on disk that the index never picked up.
        const toolbar = `
            <div class="ace-library-toolbar">
                <button type="button" class="ace-library-toolbar-btn" data-action="openRecovery"
                        title="Scan disk for crashed digest runs and restore them without re-extracting">
                    <i class="fa-solid fa-wrench"></i> Recover Lost Digests
                </button>
            </div>
        `;
        const inner = this._buildLibraryPanel();
        return `<div class="ace-library-window-root">${toolbar}${inner}</div>`;
    }

    /**
     * Wire dropzone drag-drop + file-input events. Mirrors the panel's
     * _wireLibraryEvents but scoped to this window's element.
     */
    _wireEvents(content) {
        const dropzone = content.querySelector("#ace-library-dropzone");
        const fileInput = content.querySelector("#ace-library-file-input");

        if (fileInput) {
            fileInput.addEventListener("change", async (ev) => {
                const files = ev.target.files;
                if (files?.length) await this._processUploadedFiles(files);
                // Reset so the same file can be re-uploaded if needed
                ev.target.value = "";
            });
        }

        if (dropzone) {
            dropzone.addEventListener("dragover", (ev) => {
                ev.preventDefault();
                dropzone.classList.add("ace-library-dragover");
            });
            dropzone.addEventListener("dragleave", () => {
                dropzone.classList.remove("ace-library-dragover");
            });
            dropzone.addEventListener("drop", async (ev) => {
                ev.preventDefault();
                dropzone.classList.remove("ace-library-dragover");
                const files = ev.dataTransfer?.files;
                if (files?.length) await this._processUploadedFiles(files);
            });
        }
    }

    // ─── Lifecycle hooks — keep panel's reference fresh ──────────────────

    async _onClose(options) {
        // Tell the panel we're gone so it can null its handle
        if (this._panel && this._panel._libraryWindow === this) {
            this._panel._libraryWindow = null;
        }
        return super._onClose(options);
    }
}

// ─── Public entry point ───────────────────────────────────────────────────

/**
 * Open the Library window from the given panel. Single-instance — opens
 * the existing window if one is already open.
 */
export function openLibraryWindow(panel) {
    if (!panel) {
        ui.notifications?.warn("ACE: cannot open Library window — panel reference missing.");
        return null;
    }
    if (panel._libraryWindow?.rendered) {
        panel._libraryWindow.bringToFront?.();
        return panel._libraryWindow;
    }
    panel._libraryWindow = new LibraryWindow(panel);
    panel._libraryWindow.render(true);
    return panel._libraryWindow;
}
