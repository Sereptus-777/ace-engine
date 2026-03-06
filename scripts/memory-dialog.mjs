// ============================================================
// ACE — AI Campaign Engine — Memory Management Dialog (ApplicationV2)
// Per-category export/import, backup/restore, and summary view.
// ============================================================

const MODULE_ID = "ace-engine";

const CATEGORY_META = {
  items:   { icon: "fa-gem",        label: "Items",           color: "#d4af37" },
  tiles:   { icon: "fa-map-pin",    label: "Tiles / Locations", color: "#6ecf8a" },
  pcs:     { icon: "fa-users",      label: "Player Characters", color: "#5fa8d3" },
  npcs:    { icon: "fa-user-secret", label: "NPCs",            color: "#e08a5b" },
  scenes:  { icon: "fa-film",       label: "Scenes",           color: "#c17dcf" },
  world:   { icon: "fa-globe",      label: "World / Sessions",  color: "#d4af37" },
  history: { icon: "fa-scroll",     label: "All History",       color: "#8a8a8a" },
};

export class MemoryDialog extends foundry.applications.api.ApplicationV2 {
  constructor(memoryManager) {
    super();
    this._mgr = memoryManager;
    this._importing = new Set();  // categories currently importing
    this._backing   = false;      // backup-all in progress
    this._syncing   = false;      // journal sync in progress
  }

  static DEFAULT_OPTIONS = {
    id: "ace-memory-dialog",
    classes: ["ace-memory-dialog"],
    tag: "div",
    window: {
      title: "ACE — Memory Management",
      icon: "fas fa-database",
      resizable: false,
      minimizable: false,
    },
    position: {
      width:  520,
      height: 560,
    },
    actions: {
      exportCategory:   MemoryDialog._onExportCategory,
      importCategory:   MemoryDialog._onImportCategory,
      backupCategory:   MemoryDialog._onBackupCategory,
      exportAll:        MemoryDialog._onExportAll,
      importAll:        MemoryDialog._onImportAll,
      backupAll:        MemoryDialog._onBackupAll,
      syncJournals:     MemoryDialog._onSyncJournals,
    },
  };

  // ── Render ─────────────────────────────────────────────────

  async _renderHTML(context, options) {
    const html = document.createElement("div");
    html.classList.add("ace-mem-wrapper");
    html.innerHTML = this._buildHTML();
    return html;
  }

  _replaceHTML(result, content, options) {
    content.replaceChildren(result);
  }

  _buildHTML() {
    const summary = this._mgr.getStoreSummary();
    const totalRecords = summary.reduce((n, s) => n + s.recordCount, 0);
    const totalSize    = summary.reduce((n, s) => n + s.byteSize, 0);

    let rows = "";
    for (const s of summary) {
      const meta = CATEGORY_META[s.category] ?? { icon: "fa-file", label: s.displayName, color: "#999" };
      const sizeStr = s.byteSize > 0 ? `${(s.byteSize / 1024).toFixed(1)} KB` : "—";
      const isImporting = this._importing.has(s.category);

      rows += `
        <div class="ace-mem-row" data-category="${s.category}">
          <div class="ace-mem-info">
            <i class="fas ${meta.icon}" style="color:${meta.color}; width:18px; text-align:center;"></i>
            <span class="ace-mem-label">${meta.label}</span>
            <span class="ace-mem-stats">${s.recordCount} records · ${sizeStr}</span>
          </div>
          <div class="ace-mem-actions">
            <button class="ace-mem-btn" data-action="exportCategory" data-category="${s.category}"
                    title="Export ${meta.label} to file">
              <i class="fas fa-download"></i>
            </button>
            <button class="ace-mem-btn" data-action="importCategory" data-category="${s.category}"
                    ${isImporting ? "disabled" : ""}
                    title="Import ${meta.label} from file">
              <i class="fas ${isImporting ? "fa-spinner fa-spin" : "fa-upload"}"></i>
            </button>
            <button class="ace-mem-btn" data-action="backupCategory" data-category="${s.category}"
                    title="Create backup of ${meta.label}">
              <i class="fas fa-copy"></i>
            </button>
          </div>
        </div>`;
    }

    return `
      <div class="ace-mem-header">
        <div class="ace-mem-title">
          <i class="fas fa-database"></i> Memory Categories
        </div>
        <div class="ace-mem-summary">
          ${totalRecords} total records · ${(totalSize / 1024).toFixed(1)} KB
        </div>
      </div>

      <div class="ace-mem-list">
        ${rows}
      </div>

      <div class="ace-mem-bulk">
        <button class="ace-mem-bulk-btn" data-action="exportAll"
                title="Export all categories to a single file">
          <i class="fas fa-file-export"></i> Export All
        </button>
        <button class="ace-mem-bulk-btn" data-action="importAll"
                title="Import all categories from a full export file">
          <i class="fas fa-file-import"></i> Import All
        </button>
        <button class="ace-mem-bulk-btn" data-action="backupAll"
                ${this._backing ? "disabled" : ""}
                title="Create a backup of every category">
          <i class="fas ${this._backing ? "fa-spinner fa-spin" : "fa-shield-halved"}"></i>
          ${this._backing ? "Backing up…" : "Backup All"}
        </button>
        <button class="ace-mem-bulk-btn" data-action="syncJournals"
                ${this._syncing ? "disabled" : ""}
                title="Write all memory records to Foundry journal entries (📖 ACE subfolders)">
          <i class="fas ${this._syncing ? "fa-spinner fa-spin" : "fa-book-open"}"></i>
          ${this._syncing ? "Syncing…" : "Sync to Journals"}
        </button>
      </div>

      <div class="ace-mem-footer">
        <span class="ace-mem-footer-text">
          Files stored in <code>worlds/…/ace-engine/</code> — backups in <code>…/ace-engine/backups/</code>
        </span>
      </div>
    `;
  }

  // ── Actions ─────────────────────────────────────────────────

  /** Export a single category as a downloaded JSON file. */
  static _onExportCategory(event, target) {
    const category = target.dataset.category ?? target.closest("[data-category]")?.dataset.category;
    if (!category) return;
    const blob = this._mgr.exportCategory(category);
    if (!blob) {
      ui.notifications?.warn(`ACE: Unknown category "${category}".`);
      return;
    }
    const meta = CATEGORY_META[category] ?? { label: category };
    const filename = `ace-engine-${category}-${new Date().toISOString().slice(0, 10)}.json`;
    _downloadBlob(blob, filename);
    ui.notifications?.info(`ACE: Exported ${meta.label}.`);
  }

  /** Import a single category from a user-selected JSON file. */
  static async _onImportCategory(event, target) {
    const category = target.dataset.category ?? target.closest("[data-category]")?.dataset.category;
    if (!category || this._importing.has(category)) return;

    // Ask user for replace vs merge mode
    const mode = await _askImportMode(category);
    if (!mode) return;  // cancelled

    // Open file picker
    const file = await _pickJsonFile();
    if (!file) return;

    this._importing.add(category);
    this.render();

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const result = await this._mgr.importCategory(category, data, mode);

      if (result.ok) {
        ui.notifications?.info(`ACE: ${result.message}`);
      } else {
        ui.notifications?.warn(`ACE: Import failed — ${result.message}`);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Import error:`, err);
      ui.notifications?.error("ACE: Import failed — invalid JSON file.");
    }

    this._importing.delete(category);
    this.render();
  }

  /** Backup a single category. */
  static async _onBackupCategory(event, target) {
    const category = target.dataset.category ?? target.closest("[data-category]")?.dataset.category;
    if (!category) return;

    try {
      await this._mgr.backup(category);
      const meta = CATEGORY_META[category] ?? { label: category };
      ui.notifications?.info(`ACE: Backed up ${meta.label}.`);
    } catch (err) {
      console.error(`${MODULE_ID} | Backup error:`, err);
      ui.notifications?.error("ACE: Backup failed — see console.");
    }
  }

  /** Export all categories as a single file. */
  static _onExportAll(event, target) {
    const blob = this._mgr.exportAll();
    const filename = `ace-engine-full-${new Date().toISOString().slice(0, 10)}.json`;
    _downloadBlob(blob, filename);
    ui.notifications?.info("ACE: Exported all categories.");
  }

  /** Import all categories from a full export file. */
  static async _onImportAll(event, target) {
    const mode = await _askImportMode("all");
    if (!mode) return;

    const file = await _pickJsonFile();
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const result = await this._mgr.importAll(data, mode);

      if (result.ok) {
        ui.notifications?.info(`ACE: Full import complete.`);
      } else {
        ui.notifications?.warn(`ACE: Import failed — ${result.message}`);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Full import error:`, err);
      ui.notifications?.error("ACE: Import failed — invalid JSON file.");
    }

    this.render();
  }

  /** Backup all categories at once. */
  static async _onBackupAll(event, target) {
    if (this._backing) return;
    this._backing = true;
    this.render();

    try {
      await this._mgr.backup();
      ui.notifications?.info("ACE: All categories backed up.");
    } catch (err) {
      console.error(`${MODULE_ID} | Backup all error:`, err);
      ui.notifications?.error("ACE: Backup failed — see console.");
    }

    this._backing = false;
    this.render();
  }

  /** Sync all memory records to individual Foundry journal entries. */
  static async _onSyncJournals(event, target) {
    if (this._syncing) return;
    this._syncing = true;
    this.render();

    try {
      const count = await this._mgr.syncAllJournals();
      ui.notifications?.info(`ACE: Synced ${count} entries to journals.`);
    } catch (err) {
      console.error(`${MODULE_ID} | Journal sync error:`, err);
      ui.notifications?.error("ACE: Journal sync failed — see console.");
    }

    this._syncing = false;
    this.render();
  }
}


// ── Utilities ─────────────────────────────────────────────────

/** Trigger a browser file download from a Blob. */
function _downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

/** Open a native file picker and return the selected File (or null). */
function _pickJsonFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type   = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve(input.files?.[0] ?? null);
      document.body.removeChild(input);
    });
    input.addEventListener("cancel", () => {
      resolve(null);
      document.body.removeChild(input);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** Ask the user for Replace vs Merge import mode using DialogV2 or legacy Dialog. */
async function _askImportMode(category) {
  const label = CATEGORY_META[category]?.label ?? category;

  // Use DialogV2 if available (Foundry v12+)
  if (foundry.applications?.api?.DialogV2) {
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: `Import ${label}` },
      content: `
        <p>How should imported data be merged with existing data?</p>
        <ul style="margin:8px 0 0 12px; font-size:0.9em; color:#aaa;">
          <li><strong>Replace</strong> — overwrite existing data entirely</li>
          <li><strong>Merge</strong> — combine records; new entries added, conflicts favor import</li>
        </ul>`,
      buttons: [
        { action: "replace", label: "Replace", icon: "fas fa-exchange-alt" },
        { action: "merge",   label: "Merge",   icon: "fas fa-code-merge"  },
        { action: "cancel",  label: "Cancel",  icon: "fas fa-times"       },
      ],
      rejectClose: false,
    });
    return result === "cancel" ? null : result;
  }

  // Legacy Dialog fallback
  return new Promise((resolve) => {
    new Dialog({
      title: `Import ${label}`,
      content: `<p>How should imported data be merged with existing data?</p>
        <ul style="margin:8px 0 0 12px; font-size:0.9em;">
          <li><strong>Replace</strong> — overwrite existing data entirely</li>
          <li><strong>Merge</strong> — combine records; new entries added, conflicts favor import</li>
        </ul>`,
      buttons: {
        replace: { label: "Replace", callback: () => resolve("replace") },
        merge:   { label: "Merge",   callback: () => resolve("merge")  },
        cancel:  { label: "Cancel",  callback: () => resolve(null)     },
      },
      default: "merge",
      close:   () => resolve(null),
    }).render(true);
  });
}
