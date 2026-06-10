// ============================================================
// ACE — AI Campaign Engine — Category Store Base + 7 Subclasses
// Each store manages one JSON file in worlds/{worldId}/ace-engine/
// ============================================================

const MODULE_ID = "ace-engine";
const STORE_VERSION = 2;

// v13-safe FilePicker access (global removed in v13, namespaced under foundry.applications)
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ?? // v13+
  globalThis.FilePicker;                                     // v12 fallback

/**
 * Upload a file silently — suppresses Foundry's upload notification toast.
 * In Foundry v13, FilePicker.upload() ignores the { notify: false } option,
 * so we temporarily mute ui.notifications.info() during the upload.
 * Also filters the spurious "User [] does not have permission to upload"
 * warning (fires on some hosted Foundry setups even when uploads succeed).
 * Uses refcount so concurrent uploads don't clobber the restore.
 */
// Silent uploader moved to the shared, corruption-proof module (the old
// per-file copy raced with the other engines' copies and broke notifications).
import { silentUpload as _silentUpload } from "./silent-upload.mjs";

// ── Base Class ──────────────────────────────────────────────

export class CategoryStore {
  /**
   * @param {string} category  - e.g. "items", "npcs"
   * @param {string} fileName  - e.g. "ace-items.json"
   */
  constructor(category, fileName) {
    this.category = category;
    this.fileName = fileName;
    this._data    = this._emptyData();
    this._dirty   = false;
    this._loaded  = false;
    this._size    = 0;            // last-known serialized byte size
  }

  /** Override in subclasses — returns the empty data skeleton. */
  _emptyData() {
    return { version: STORE_VERSION, worldId: null, savedAt: null };
  }

  /** How many records this store contains (override per subclass). */
  get recordCount() { return 0; }

  /** Approximate byte size from last save/load. */
  get byteSize() { return this._size; }

  // ── File I/O ──────────────────────────────────────────────

  /** Build the full file path for this store. */
  _path(worldId) {
    return `worlds/${worldId}/ace-engine/${this.fileName}`;
  }

  /** Build the backup path. */
  _backupPath(worldId, timestamp) {
    const ts = timestamp.replace(/:/g, "-");
    return `worlds/${worldId}/ace-engine/backups/${this.fileName.replace(".json", "")}.${ts}.json`;
  }

  /**
   * Load from disk.  Silently handles missing file (first run).
   * Uses FilePicker.browse() to check existence BEFORE fetch, so
   * the browser console never shows red 404 errors on first run.
   * @param {string} worldId
   */
  async load(worldId) {
    const dir  = `worlds/${worldId}/ace-engine`;
    const path = this._path(worldId);

    try {
      // Check if the file exists via FilePicker — no red 404 noise in console
      let exists = false;
      try {
        const listing = await _FP().browse("data", dir);
        exists = (listing?.files ?? []).some(f => f.endsWith(this.fileName));
      } catch (_) {
        // Directory doesn't exist yet — that's fine on first run
      }

      if (!exists) {
        console.log(`${MODULE_ID} | ${this.category}: no file found, starting fresh.`);
        this._data.worldId = worldId;
        this._loaded = true;
        return;
      }

      const resp = await fetch(path, { cache: "no-store" });
      if (!resp.ok) {
        console.log(`${MODULE_ID} | ${this.category}: could not read file, starting fresh.`);
        this._data.worldId = worldId;
        this._loaded = true;
        return;
      }
      const raw = await resp.text();
      this._size = raw.length;
      const data = JSON.parse(raw);
      this._deserialize(data);
      this._data.worldId = worldId;
      console.debug(`${MODULE_ID} | ${this.category}: loaded (${this.recordCount} records, ${(this._size / 1024).toFixed(1)} KB).`);
    } catch (err) {
      console.warn(`${MODULE_ID} | ${this.category}: load failed (${err.message}). Starting fresh.`);
      this._data.worldId = worldId;
    }
    this._loaded = true;
  }

  /**
   * Save to disk via FilePicker upload.
   * Writes BOTH the canonical .json AND a human-readable .txt companion.
   * The .txt is best-effort — if it fails, the .json save still succeeds.
   * @param {string} worldId
   */
  async save(worldId) {
    if (!this._loaded || !this._dirty) return;
    if (!game.user?.isGM) return;

    this._data.savedAt = new Date().toISOString();
    this._data.worldId = worldId;
    const payload = JSON.stringify(this._serialize(), null, 0);
    this._size = payload.length;
    const file = new File([payload], this.fileName, { type: "application/json" });

    try {
      await _silentUpload("data", `worlds/${worldId}/ace-engine`, file);
      this._dirty = false;
      console.log(`${MODULE_ID} | ${this.category}: saved (${(this._size / 1024).toFixed(1)} KB, ${this.recordCount} records).`);
    } catch (err) {
      console.error(`${MODULE_ID} | ${this.category}: save failed:`, err);
      return; // skip .txt if .json failed
    }

    // ── Human-readable .txt companion (best-effort, non-blocking) ──
    // Saved alongside the canonical .json so the user can open the
    // ace-engine folder and read what's in each store without
    // navigating raw JSON. Filename mirrors the .json (deeds.json →
    // deeds.txt). Generated fresh on every save. If this write fails,
    // we log and move on — the canonical .json save already succeeded.
    try {
      const txt = this._formatAsText();
      const txtName = this.fileName.replace(/\.json$/i, ".txt");
      const txtFile = new File([txt], txtName, { type: "text/plain" });
      await _silentUpload("data", `worlds/${worldId}/ace-engine`, txtFile);
    } catch (err) {
      console.warn(`${MODULE_ID} | ${this.category}: .txt companion write failed:`, err);
    }
  }

  /**
   * Build a human-readable text rendering of this store's contents.
   * Subclasses override `_formatRecord()` to customize per-record output;
   * this base method handles the header and iteration. The default
   * `_formatRecord` falls back to pretty-printed JSON if no override.
   *
   * Output structure:
   *   === ace-engine <category> — saved <iso-timestamp> ===
   *   Total: N records
   *
   *   [1] <record-formatted-text>
   *
   *   [2] <record-formatted-text>
   *   ...
   */
  _formatAsText() {
    const records = this._recordsForText();
    const header = [
      `=== ace-engine ${this.category} — saved ${this._data.savedAt ?? new Date().toISOString()} ===`,
      `Total: ${records.length} record${records.length === 1 ? "" : "s"}`,
      `World: ${this._data.worldId ?? "?"}`,
      `Version: ${this._data.version ?? "?"}`,
      "",
    ].join("\n");

    if (records.length === 0) return header + "(no records)\n";

    const body = records.map((rec, i) => {
      const formatted = this._formatRecord(rec, i);
      return `[${i + 1}] ${formatted}`;
    }).join("\n\n");

    return header + body + "\n";
  }

  /**
   * Return the array of records that should appear in the .txt output.
   * Subclasses override to point at the right field (e.g. `_data.deeds`).
   * Base default: empty array.
   */
  _recordsForText() {
    return [];
  }

  /**
   * Format a single record as text. Override per-category for nice output;
   * base falls back to indented JSON. Two-space indent so blocks line up
   * under the `[N]` index header.
   */
  _formatRecord(rec, _idx) {
    try {
      return JSON.stringify(rec, null, 2)
        .split("\n")
        .map((l, j) => j === 0 ? l : "    " + l)
        .join("\n");
    } catch (_) {
      return String(rec);
    }
  }

  /**
   * Create a timestamped backup copy and prune old backups (keep last MAX_BACKUPS).
   * @param {string} worldId
   * @param {number} [maxBackups=10] — How many backups to keep per store
   */
  async backup(worldId, maxBackups = 10) {
    if (!this._loaded) return;
    const ts  = new Date().toISOString().replace(/:/g, "-");
    const bkName = `${this.fileName.replace(".json", "")}.${ts}.json`;
    const payload = JSON.stringify(this._serialize(), null, 0);
    const file = new File([payload], bkName, { type: "application/json" });
    const backupDir = `worlds/${worldId}/ace-engine/backups`;

    try {
      await _silentUpload("data", backupDir, file);
      // Demoted from log to debug — auto-backup runs every 30 minutes across
      // ~8 categories, so this used to flood the console.
      console.debug(`${MODULE_ID} | ${this.category}: backup created (${bkName}).`);
    } catch (err) {
      console.error(`${MODULE_ID} | ${this.category}: backup failed:`, err);
      return; // Don't try to prune if backup creation itself failed
    }

    // ── Prune old backups — keep only the newest maxBackups ─────
    try {
      const prefix = this.fileName.replace(".json", "");
      const listing = await _FP().browse("data", backupDir);
      const myBackups = (listing?.files ?? [])
        .filter(f => {
          const name = f.split("/").pop();
          return name.startsWith(prefix + ".") && name.endsWith(".json");
        })
        .sort(); // ISO timestamps sort alphabetically = chronologically

      if (myBackups.length > maxBackups) {
        const toDelete = myBackups.slice(0, myBackups.length - maxBackups);
        for (const path of toDelete) {
          try {
            // Foundry doesn't have a native delete API for data files,
            // so we overwrite with an empty marker to reclaim intent.
            // In practice, GMs can manually clear the backups folder.
            // Log what would be pruned for manual cleanup.
            console.debug(`${MODULE_ID} | ${this.category}: old backup eligible for cleanup: ${path.split("/").pop()}`);
          } catch (_) { /* ignore cleanup errors */ }
        }
        if (toDelete.length) {
          // Demoted from log to debug — Foundry has no file-delete API for
          // data files, so this message is informational only (the count
          // grows forever until the user manually deletes the folder). No
          // value spamming the console with it every backup cycle.
          console.debug(`${MODULE_ID} | ${this.category}: ${toDelete.length} old backup(s) eligible for manual cleanup (keeping ${maxBackups} newest).`);
        }
      }
    } catch (_) { /* prune is best-effort */ }
  }

  // ── Serialization (override in subclasses) ────────────────

  _serialize() { return { ...this._data }; }

  _deserialize(data) {
    if (data && typeof data === "object") {
      Object.assign(this._data, data);
    }
  }

  // ── Export / Import ───────────────────────────────────────

  /** Build an export blob with metadata. */
  exportBlob() {
    const payload = {
      _export: {
        module:      MODULE_ID,
        version:     game.modules?.get(MODULE_ID)?.version ?? "0.6",
        category:    this.category,
        worldId:     this._data.worldId,
        exportedAt:  new Date().toISOString(),
        recordCount: this.recordCount,
      },
      ...this._serialize(),
    };
    return new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  }

  /**
   * Import data from a parsed JSON object.
   * @param {object} data        - the parsed JSON (with _export block)
   * @param {"replace"|"merge"} mode
   * @returns {{ ok: boolean, message: string }}
   */
  importData(data, mode = "replace") {
    if (!data || typeof data !== "object") return { ok: false, message: "Invalid data." };

    // Validate export metadata
    const ex = data._export;
    if (ex && ex.module !== MODULE_ID) return { ok: false, message: `Wrong module: ${ex.module}` };
    if (ex && ex.category && ex.category !== this.category) {
      return { ok: false, message: `Category mismatch: expected ${this.category}, got ${ex.category}` };
    }

    // Strip _export metadata before merging
    const clean = { ...data };
    delete clean._export;

    if (mode === "replace") {
      this._deserialize(clean);
    } else {
      this._mergeImport(clean);
    }
    this._dirty = true;
    return { ok: true, message: `Imported ${this.category} (${mode}).` };
  }

  /** Override in subclasses for merge logic. Default = replace. */
  _mergeImport(data) {
    this._deserialize(data);
  }

  /** Mark store as dirty (needs save). */
  markDirty() { this._dirty = true; }
}


// ── Item Store ──────────────────────────────────────────────

export class ItemStore extends CategoryStore {
  constructor() { super("items", "ace-items.json"); }

  _emptyData() {
    return { version: STORE_VERSION, worldId: null, savedAt: null, items: {} };
  }

  get recordCount() { return Object.keys(this._data.items ?? {}).length; }

  _serialize() {
    return {
      version:  this._data.version  ?? STORE_VERSION,
      worldId:  this._data.worldId,
      savedAt:  this._data.savedAt,
      items:    this._data.items ?? {},
    };
  }

  _deserialize(data) {
    this._data.version = data.version ?? STORE_VERSION;
    this._data.items   = data.items && typeof data.items === "object" ? data.items : {};
  }

  _mergeImport(data) {
    const incoming = data.items ?? {};
    for (const [key, rec] of Object.entries(incoming)) {
      const existing = this._data.items[key];
      if (!existing) {
        this._data.items[key] = rec;
      } else {
        // Merge: imported wins on scalar fields, notes deduped by timestamp
        const origNotes = existing.notes ?? [];
        Object.assign(existing, rec);
        if (Array.isArray(rec.notes)) {
          const nTs = new Set(origNotes.map(n => n.t));
          existing.notes = [...origNotes];
          for (const n of rec.notes) {
            if (!nTs.has(n.t)) existing.notes.push(n);
          }
        }
      }
    }
  }

  /** Get or create an item record. */
  touch(itemKey, displayName) {
    const key = itemKey.toLowerCase().trim();
    if (!key) return null;
    if (!this._data.items[key]) {
      this._data.items[key] = {
        displayName: displayName ?? itemKey,
        type: "misc",
        rarity: "unknown",
        firstSeen: Math.floor(Date.now() / 1000),
        lastSeen: Math.floor(Date.now() / 1000),
        owner: null,
        previousOwners: [],
        location: null,
        status: "unknown",
        notes: [],
        properties: {},
      };
    }
    this._data.items[key].lastSeen = Math.floor(Date.now() / 1000);
    this._dirty = true;
    return this._data.items[key];
  }

  getRecord(name) {
    return this._data.items[name?.toLowerCase?.().trim() ?? ""] ?? null;
  }

  getAll() { return Object.values(this._data.items); }
}


// ── Tile / Location Store ───────────────────────────────────

export class TileStore extends CategoryStore {
  constructor() { super("tiles", "ace-tiles.json"); }

  _emptyData() {
    return { version: STORE_VERSION, worldId: null, savedAt: null, locations: {} };
  }

  get recordCount() { return Object.keys(this._data.locations ?? {}).length; }

  _serialize() {
    return {
      version:   this._data.version ?? STORE_VERSION,
      worldId:   this._data.worldId,
      savedAt:   this._data.savedAt,
      locations: this._data.locations ?? {},
    };
  }

  _deserialize(data) {
    this._data.version   = data.version ?? STORE_VERSION;
    this._data.locations = data.locations && typeof data.locations === "object" ? data.locations : {};
  }

  _mergeImport(data) {
    const incoming = data.locations ?? {};
    for (const [key, rec] of Object.entries(incoming)) {
      const existing = this._data.locations[key];
      if (!existing) {
        this._data.locations[key] = rec;
      } else {
        const origNotes = existing.notes ?? [];
        Object.assign(existing, rec);
        if (Array.isArray(rec.notes)) {
          const nTs = new Set(origNotes.map(n => n.t));
          existing.notes = [...origNotes];
          for (const n of rec.notes) {
            if (!nTs.has(n.t)) existing.notes.push(n);
          }
        }
      }
    }
  }

  /** Get or create a location record. */
  touchLocation(sceneName, sceneId) {
    const key = sceneName?.toLowerCase?.().trim() ?? "";
    if (!key) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!this._data.locations[key]) {
      this._data.locations[key] = {
        displayName: sceneName,
        type: "misc",
        firstVisited: now,
        lastVisited: now,
        visitCount: 0,
        sceneId: sceneId ?? null,
        description: "",
        notes: [],
        associatedNpcs: [],
        events: [],
        tileSnapshots: [],
      };
    }
    const loc = this._data.locations[key];
    loc.lastVisited = now;
    loc.visitCount++;
    if (sceneId && !loc.sceneId) loc.sceneId = sceneId;
    this._dirty = true;
    return loc;
  }

  /** Snapshot current Foundry tiles for a location. */
  snapshotTiles(sceneName, tiles) {
    const key = sceneName?.toLowerCase?.().trim() ?? "";
    const loc = this._data.locations[key];
    if (!loc) return;
    const snap = {
      t: Math.floor(Date.now() / 1000),
      tiles: (tiles ?? []).map(t => ({
        id:      t.id ?? null,
        label:   t.texture?.label ?? t.name ?? "",
        texture: t.texture?.src ?? "",
        x:       t.x ?? 0,
        y:       t.y ?? 0,
        w:       t.width ?? 0,
        h:       t.height ?? 0,
      })),
    };
    loc.tileSnapshots.push(snap);
    // Keep last 10 snapshots per location
    if (loc.tileSnapshots.length > 10) loc.tileSnapshots.shift();
    this._dirty = true;
  }

  getRecord(name) {
    return this._data.locations[name?.toLowerCase?.().trim() ?? ""] ?? null;
  }

  getAll() { return Object.values(this._data.locations); }
}


// ── PC Store ────────────────────────────────────────────────

export class PcStore extends CategoryStore {
  constructor() { super("pcs", "ace-pcs.json"); }

  _emptyData() {
    return { version: STORE_VERSION, worldId: null, savedAt: null, pcs: {} };
  }

  get recordCount() { return Object.keys(this._data.pcs ?? {}).length; }

  _serialize() {
    return {
      version: this._data.version ?? STORE_VERSION,
      worldId: this._data.worldId,
      savedAt: this._data.savedAt,
      pcs:     this._data.pcs ?? {},
    };
  }

  _deserialize(data) {
    this._data.version = data.version ?? STORE_VERSION;
    this._data.pcs     = data.pcs && typeof data.pcs === "object" ? data.pcs : {};
  }

  _mergeImport(data) {
    const incoming = data.pcs ?? {};
    for (const [key, rec] of Object.entries(incoming)) {
      const existing = this._data.pcs[key];
      if (!existing) {
        this._data.pcs[key] = rec;
      } else {
        // Merge milestones + notes by timestamp dedup
        const origMilestones = existing.milestones ?? [];
        const origNotes      = existing.notes ?? [];
        Object.assign(existing, rec);
        if (Array.isArray(rec.milestones)) {
          const msTs = new Set(origMilestones.map(m => m.t));
          existing.milestones = [...origMilestones];
          for (const m of rec.milestones) {
            if (!msTs.has(m.t)) existing.milestones.push(m);
          }
        }
        if (Array.isArray(rec.notes)) {
          const nTs = new Set(origNotes.map(n => n.t));
          existing.notes = [...origNotes];
          for (const n of rec.notes) {
            if (!nTs.has(n.t)) existing.notes.push(n);
          }
        }
      }
    }
  }

  /** Get or create a PC record. Keyed by Foundry actor ID. */
  touchPc(actorId, displayName) {
    if (!actorId) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!this._data.pcs[actorId]) {
      this._data.pcs[actorId] = {
        displayName: displayName ?? "Unknown",
        actorId,
        class: "",
        level: 0,
        firstSeen: now,
        lastSeen: now,
        milestones: [],
        kills: 0,
        crits: 0,
        fumbles: 0,
        deaths: 0,
        hits: 0,
        misses: 0,
        damageDealt: 0,
        damageTaken: 0,
        healingDone: 0,
        timesKO: 0,
        deathSavePass: 0,
        deathSaveFail: 0,
        sessions: 0,
        highestHit: 0,
        scenes: [],
        relationships: {},
        notes: [],
      };
    }
    this._data.pcs[actorId].lastSeen = now;
    if (displayName) this._data.pcs[actorId].displayName = displayName;
    this._dirty = true;
    return this._data.pcs[actorId];
  }

  /** Find PC by name (for events that only have a name, not actor ID). */
  findByName(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    return Object.values(this._data.pcs).find(
      p => p.displayName?.toLowerCase() === lower
    ) ?? null;
  }

  getRecord(actorId) { return this._data.pcs[actorId] ?? null; }

  getAll() { return Object.values(this._data.pcs); }
}


// ── NPC Store ───────────────────────────────────────────────

export class NpcStore extends CategoryStore {
  constructor() { super("npcs", "ace-npcs.json"); }

  _emptyData() {
    return { version: STORE_VERSION, worldId: null, savedAt: null, npcs: {} };
  }

  get recordCount() { return Object.keys(this._data.npcs ?? {}).length; }

  _serialize() {
    return {
      version: this._data.version ?? STORE_VERSION,
      worldId: this._data.worldId,
      savedAt: this._data.savedAt,
      npcs:    this._data.npcs ?? {},
    };
  }

  _deserialize(data) {
    this._data.version = data.version ?? STORE_VERSION;
    this._data.npcs    = data.npcs && typeof data.npcs === "object" ? data.npcs : {};
  }

  _mergeImport(data) {
    const incoming = data.npcs ?? {};
    for (const [key, rec] of Object.entries(incoming)) {
      const existing = this._data.npcs[key];
      if (!existing) {
        this._data.npcs[key] = rec;
      } else {
        const origNotes = existing.notes ?? [];
        Object.assign(existing, rec);
        if (Array.isArray(rec.notes)) {
          const nTs = new Set(origNotes.map(n => n.t));
          existing.notes = [...origNotes];
          for (const n of rec.notes) {
            if (!nTs.has(n.t)) existing.notes.push(n);
          }
        }
      }
    }
  }

  /** Get or create an NPC record. Keyed by lowercase name. */
  touchNpc(name, scene) {
    if (!name || typeof name !== "string") return null;
    const key = name.toLowerCase().trim();
    if (!key) return null;
    const now = Math.floor(Date.now() / 1000);

    if (!this._data.npcs[key]) {
      this._data.npcs[key] = {
        displayName: name,
        actorId: null,
        actorUuid: null,                  // v0.7.21: UUID anchor for rename safety
        type: "unknown",
        race: null,
        class: null,
        firstSeen: now,
        lastSeen: now,
        met: 0,
        killed: false,
        killedBy: null,
        killedAt: null,
        scenes: [],                       // legacy: simple scene name list (kept for back-compat)
        sceneAppearances: [],             // v0.7.21: dated appearance log (Two-Part Bio System)
        notes: [],
        relationships: {},
        combatStats: { encounterCount: 0, wasDefeated: false, lastHp: null },
      };
    }

    const rec = this._data.npcs[key];
    rec.met++;
    rec.lastSeen = now;

    // Backfill new fields on legacy records
    if (rec.sceneAppearances === undefined) rec.sceneAppearances = [];
    if (rec.actorUuid === undefined) rec.actorUuid = null;

    if (scene && !rec.scenes.includes(scene)) {
      rec.scenes.push(scene);
      if (rec.scenes.length > 20) rec.scenes.shift();
    }
    this._dirty = true;
    return rec;
  }

  /**
   * v0.7.21 Two-Part Bio System — record a dated scene appearance with
   * AI-generated "why is this NPC here NOW" context.
   *
   * Stores a chronological log per NPC-scene pair. Re-dropping a token in
   * the same scene on a different day produces a fresh entry (matching
   * Johnny's "session 1 vs session 30" mental model).
   *
   * @param {string} name           — NPC display name (will be lowercased for keying)
   * @param {object} appearance     — { sceneId, sceneName, contextText, actorUuid?, generatedBy? }
   * @returns {object|null}         — the inserted appearance object, or null on failure
   */
  addSceneAppearance(name, appearance) {
    if (!name || typeof name !== "string") return null;
    const key = name.toLowerCase().trim();
    if (!key) return null;
    const rec = this._data.npcs[key];
    if (!rec) return null;
    if (!appearance?.sceneId) return null;

    const now = Math.floor(Date.now() / 1000);
    const entry = {
      sceneId:      appearance.sceneId,
      sceneName:    appearance.sceneName ?? "",
      contextText:  String(appearance.contextText ?? "").trim(),
      t:            now,
      generatedBy:  appearance.generatedBy ?? "ai",
    };

    if (!Array.isArray(rec.sceneAppearances)) rec.sceneAppearances = [];
    rec.sceneAppearances.push(entry);
    // Bounded history — keep last 100 appearances per NPC. Each entry is
    // small (~500 chars) so 100 entries ≈ 50KB worst-case per NPC.
    if (rec.sceneAppearances.length > 100) rec.sceneAppearances.shift();

    // Anchor the actor UUID for rename safety the first time we see it.
    if (appearance.actorUuid && !rec.actorUuid) rec.actorUuid = appearance.actorUuid;

    this._dirty = true;
    return entry;
  }

  /**
   * Most recent appearance entry for the given (npcName, sceneId) pair, or null.
   * Used by bio-generator to apply the date-gap rule before deciding whether
   * to spend an API call on a fresh scene-context generation.
   */
  getLatestSceneAppearance(name, sceneId) {
    if (!name || !sceneId) return null;
    const key = name.toLowerCase().trim();
    const rec = this._data.npcs[key];
    if (!rec || !Array.isArray(rec.sceneAppearances)) return null;
    // Newest-first scan
    for (let i = rec.sceneAppearances.length - 1; i >= 0; i--) {
      if (rec.sceneAppearances[i].sceneId === sceneId) return rec.sceneAppearances[i];
    }
    return null;
  }

  markKilled(name, killerName) {
    const key = name?.toLowerCase?.().trim() ?? "";
    const rec = this._data.npcs[key];
    if (!rec) return;
    rec.killed   = true;
    rec.killedBy = killerName ?? null;
    rec.killedAt = Math.floor(Date.now() / 1000);
    this._dirty  = true;
  }

  addNote(name, text) {
    const key = name?.toLowerCase?.().trim() ?? "";
    const rec = this._data.npcs[key];
    if (!rec || !text) return;
    rec.notes.push({ t: Math.floor(Date.now() / 1000), txt: text.slice(0, 300) });
    if (rec.notes.length > 50) rec.notes.shift();
    this._dirty = true;
  }

  getRecord(name) { return this._data.npcs[name?.toLowerCase?.().trim() ?? ""] ?? null; }

  getAll() { return Object.values(this._data.npcs); }

  /** Get all records as a Map (backward compat with old ACE Memory). */
  getMap() { return new Map(Object.entries(this._data.npcs)); }
}


// ── Scene Store ─────────────────────────────────────────────

export class SceneStore extends CategoryStore {
  constructor() { super("scenes", "ace-scenes.json"); }

  _emptyData() {
    return { version: STORE_VERSION, worldId: null, savedAt: null, scenes: {} };
  }

  get recordCount() { return Object.keys(this._data.scenes ?? {}).length; }

  _serialize() {
    return {
      version: this._data.version ?? STORE_VERSION,
      worldId: this._data.worldId,
      savedAt: this._data.savedAt,
      scenes:  this._data.scenes ?? {},
    };
  }

  _deserialize(data) {
    this._data.version = data.version ?? STORE_VERSION;
    this._data.scenes  = data.scenes && typeof data.scenes === "object" ? data.scenes : {};
  }

  _mergeImport(data) {
    const incoming = data.scenes ?? {};
    for (const [key, rec] of Object.entries(incoming)) {
      const existing = this._data.scenes[key];
      if (!existing) {
        this._data.scenes[key] = rec;
      } else {
        // Merge visits by timestamp dedup, merge notes
        const origVisits = existing.visits ?? [];
        const origNotes  = existing.notes ?? [];
        Object.assign(existing, rec);
        if (Array.isArray(rec.visits)) {
          const vTs = new Set(origVisits.map(v => v.t));
          existing.visits = [...origVisits];
          for (const v of rec.visits) {
            if (!vTs.has(v.t)) existing.visits.push(v);
          }
        }
        if (Array.isArray(rec.notes)) {
          const nTs = new Set(origNotes.map(n => n.t));
          existing.notes = [...origNotes];
          for (const n of rec.notes) {
            if (!nTs.has(n.t)) existing.notes.push(n);
          }
        }
      }
    }
  }

  /** Record a scene visit. */
  recordVisit(sceneName, sceneId, { npcsPresent, pcsPresent, description } = {}) {
    const key = sceneName?.toLowerCase?.().trim() ?? "";
    if (!key) return null;
    const now = Math.floor(Date.now() / 1000);

    if (!this._data.scenes[key]) {
      this._data.scenes[key] = {
        displayName: sceneName,
        sceneId: sceneId ?? null,
        firstVisited: now,
        lastVisited: now,
        visitCount: 0,
        visits: [],
        description: description ?? "",
        notes: [],
      };
    }

    const sc = this._data.scenes[key];
    sc.lastVisited = now;
    sc.visitCount++;
    if (sceneId && !sc.sceneId) sc.sceneId = sceneId;
    if (description && !sc.description) sc.description = description;

    // Start a new visit record
    sc.visits.push({
      t:               now,
      duration:        0,
      combatOccurred:  false,
      npcsPresent:     npcsPresent ?? [],
      pcsPresent:      pcsPresent  ?? [],
      eventsHere:      [],
    });

    // Keep last 50 visits
    if (sc.visits.length > 50) sc.visits.shift();
    this._dirty = true;
    return sc;
  }

  /** Append an event summary to the current visit of a scene. */
  appendVisitEvent(sceneName, eventSummary) {
    const key = sceneName?.toLowerCase?.().trim() ?? "";
    const sc  = this._data.scenes[key];
    if (!sc || !sc.visits.length) return;
    const visit = sc.visits[sc.visits.length - 1];
    visit.eventsHere.push(eventSummary);
    if (eventSummary.k === "combat_start" || eventSummary.k === "combat_end") {
      visit.combatOccurred = true;
    }
    this._dirty = true;
  }

  getRecord(name) { return this._data.scenes[name?.toLowerCase?.().trim() ?? ""] ?? null; }

  getAll() { return Object.values(this._data.scenes); }
}


// ── World Store ─────────────────────────────────────────────

export class WorldStore extends CategoryStore {
  constructor() { super("world", "ace-world.json"); }

  _emptyData() {
    return {
      version: STORE_VERSION, worldId: null, savedAt: null,
      worldName: "",
      campaignStart: null,
      sessions: [],
      worldNotes: [],
      factions: {},
      sceneCounter: 0,
      calendar: { dayCounter: 1, timeOfDay: "morning", lastUpdate: 0, timeNote: "" },
    };
  }

  get recordCount() {
    return (this._data.sessions?.length ?? 0)
         + (this._data.worldNotes?.length ?? 0)
         + Object.keys(this._data.factions ?? {}).length;
  }

  _serialize() {
    return {
      version:       this._data.version ?? STORE_VERSION,
      worldId:       this._data.worldId,
      savedAt:       this._data.savedAt,
      worldName:     this._data.worldName ?? "",
      campaignStart: this._data.campaignStart ?? null,
      sessions:      this._data.sessions ?? [],
      worldNotes:    this._data.worldNotes ?? [],
      factions:      this._data.factions ?? {},
      sceneCounter:  this._data.sceneCounter ?? 0,
      calendar:      this._data.calendar ?? { dayCounter: 1, timeOfDay: "morning", lastUpdate: 0, timeNote: "" },
    };
  }

  _deserialize(data) {
    this._data.version       = data.version ?? STORE_VERSION;
    this._data.worldName     = data.worldName ?? "";
    this._data.campaignStart = data.campaignStart ?? null;
    this._data.sessions      = Array.isArray(data.sessions)   ? data.sessions   : [];
    this._data.worldNotes    = Array.isArray(data.worldNotes) ? data.worldNotes : [];
    this._data.factions      = data.factions && typeof data.factions === "object" ? data.factions : {};
    this._data.sceneCounter  = typeof data.sceneCounter === "number" ? data.sceneCounter : 0;
    // Migrate old calendar format (had currentDate string) → new format (dayCounter + timeOfDay)
    const cal = data.calendar ?? {};
    this._data.calendar = {
      dayCounter:  typeof cal.dayCounter === "number" ? cal.dayCounter : 1,
      timeOfDay:   cal.timeOfDay || "morning",
      lastUpdate:  cal.lastUpdate ?? 0,
      timeNote:    cal.timeNote ?? "",
    };
  }

  _mergeImport(data) {
    // Sessions: dedup by session number
    if (Array.isArray(data.sessions)) {
      const existingNums = new Set((this._data.sessions ?? []).map(s => s.num));
      for (const s of data.sessions) {
        if (!existingNums.has(s.num)) this._data.sessions.push(s);
      }
    }
    // World notes: dedup by timestamp
    if (Array.isArray(data.worldNotes)) {
      const existingTs = new Set((this._data.worldNotes ?? []).map(n => n.t));
      for (const n of data.worldNotes) {
        if (!existingTs.has(n.t)) this._data.worldNotes.push(n);
      }
    }
    // Factions: merge by key
    if (data.factions) {
      for (const [key, fac] of Object.entries(data.factions)) {
        if (!this._data.factions[key]) this._data.factions[key] = fac;
      }
    }
  }

  /** Add a session summary record. */
  addSession(record) {
    this._data.sessions.push(record);
    this._dirty = true;
  }

  /** Get the last session record. */
  getLastSession() {
    return this._data.sessions.length ? this._data.sessions[this._data.sessions.length - 1] : null;
  }

  /**
   * Update an existing session record in place. Returns true if a matching
   * session was found and updated, false otherwise. Used by the bidirectional
   * journal-sync hook so GM edits to "Session N" journals flow back to the
   * JSON store that feeds the AI context.
   *
   * @param {number} num — session number to update
   * @param {object} patch — fields to merge into the existing record
   * @returns {boolean}
   */
  updateSession(num, patch) {
    const idx = this._data.sessions.findIndex(s => Number(s.num) === Number(num));
    if (idx === -1) return false;
    this._data.sessions[idx] = { ...this._data.sessions[idx], ...patch };
    this._dirty = true;
    return true;
  }

  /** Add a world note. */
  addWorldNote(text, scene, category) {
    if (!text) return;
    this._data.worldNotes.push({
      t:        Math.floor(Date.now() / 1000),
      txt:      text.slice(0, 500),
      s:        scene ?? "",
      category: category ?? "note",
    });
    this._dirty = true;
  }

  /** Get sessions array (read-only). */
  getSessions()   { return this._data.sessions ?? []; }
  getWorldNotes() { return this._data.worldNotes ?? []; }
  getFactions()   { return this._data.factions ?? {}; }

  /** Increment the global scene counter (monotonic). */
  incrementSceneCounter() {
    this._data.sceneCounter = (this._data.sceneCounter ?? 0) + 1;
    this._dirty = true;
    return this._data.sceneCounter;
  }

  /** Get current scene counter value. */
  getSceneCounter() { return this._data.sceneCounter ?? 0; }

  // ── Day Counter & Narrative Time ─────────────────────────────

  /** Get current in-game day. */
  getDayCounter() { return this._data.calendar?.dayCounter ?? 1; }

  /** Get current time of day. */
  getTimeOfDay() { return this._data.calendar?.timeOfDay ?? "morning"; }

  /** Advance the in-game day counter by N days (default 1). */
  advanceDay(n = 1) {
    if (!this._data.calendar) this._data.calendar = { dayCounter: 1, timeOfDay: "morning", lastUpdate: 0, timeNote: "" };
    this._data.calendar.dayCounter = (this._data.calendar.dayCounter ?? 1) + Math.max(1, Math.floor(n));
    this._data.calendar.lastUpdate = Math.floor(Date.now() / 1000);
    this._dirty = true;
    return this._data.calendar.dayCounter;
  }

  /** Set the time of day (morning, midday, afternoon, evening, night). */
  setTimeOfDay(time) {
    const valid = ["morning", "midday", "afternoon", "evening", "night"];
    if (!valid.includes(time)) return;
    if (!this._data.calendar) this._data.calendar = { dayCounter: 1, timeOfDay: "morning", lastUpdate: 0, timeNote: "" };
    this._data.calendar.timeOfDay  = time;
    this._data.calendar.lastUpdate = Math.floor(Date.now() / 1000);
    this._dirty = true;
  }

  /** Advance time of day by one step. Returns new time string. */
  advanceTimeStep() {
    const order = ["morning", "midday", "afternoon", "evening", "night"];
    const current = this.getTimeOfDay();
    const idx = order.indexOf(current);
    if (idx < order.length - 1) {
      this.setTimeOfDay(order[idx + 1]);
    }
    // If already "night", stays night until new day
    return this.getTimeOfDay();
  }

  /** Set an optional time note (AI-generated context). */
  setTimeNote(note) {
    if (!this._data.calendar) this._data.calendar = { dayCounter: 1, timeOfDay: "morning", lastUpdate: 0, timeNote: "" };
    this._data.calendar.timeNote = (note ?? "").slice(0, 200);
    this._dirty = true;
  }

  /** Get the time note. */
  getTimeNote() { return this._data.calendar?.timeNote ?? ""; }

  /**
   * World data is heterogeneous (calendar + sessions + notes + factions),
   * so we override _formatAsText directly rather than route through the
   * base flat-record-list helpers.
   */
  _formatAsText() {
    const d = this._data;
    const out = [
      `=== ace-engine world — saved ${d.savedAt ?? new Date().toISOString()} ===`,
      `World: ${d.worldId ?? "?"}`,
      `Version: ${d.version ?? "?"}`,
      `Name: ${d.worldName || "(unnamed)"}`,
      `Campaign Start: ${d.campaignStart ? new Date(d.campaignStart * 1000).toISOString().slice(0, 10) : "(unset)"}`,
      `Scene Counter: ${d.sceneCounter ?? 0}`,
      "",
    ];

    const cal = d.calendar ?? {};
    out.push("── Calendar ──");
    out.push(`Day:          ${cal.dayCounter ?? 1}`);
    out.push(`Time of Day:  ${cal.timeOfDay ?? "morning"}`);
    if (cal.timeNote)   out.push(`Note:         ${cal.timeNote}`);
    if (cal.lastUpdate) out.push(`Last Update:  ${new Date(cal.lastUpdate * 1000).toISOString().slice(0, 19).replace("T", " ")}`);
    out.push("");

    const sessions = d.sessions ?? [];
    out.push(`── Sessions (${sessions.length}) ──`);
    if (!sessions.length) {
      out.push("(none)");
    } else {
      sessions.forEach((s, i) => {
        const ts = s.t ? new Date(s.t * 1000).toISOString().slice(0, 19).replace("T", " ") : "?";
        out.push(`[${i + 1}] Session ${s.num ?? "?"} — ${s.date ?? ts}`);
        if (s.scene)         out.push(`    scene:   ${s.scene}`);
        if (s.party?.length) out.push(`    party:   ${s.party.join(", ")}`);
        if (s.summary) {
          const lines = String(s.summary).split("\n");
          out.push(`    summary: ${lines[0] ?? ""}`);
          for (let j = 1; j < lines.length; j++) out.push(`             ${lines[j]}`);
        }
      });
    }
    out.push("");

    const notes = d.worldNotes ?? [];
    out.push(`── World Notes (${notes.length}) ──`);
    if (!notes.length) {
      out.push("(none)");
    } else {
      notes.forEach((n, i) => {
        const ts  = n.t ? new Date(n.t * 1000).toISOString().slice(0, 19).replace("T", " ") : "?";
        const sc  = n.s ? ` [${n.s}]` : "";
        const tag = n.category ? ` (${n.category})` : "";
        out.push(`[${i + 1}] ${ts}${sc}${tag}`);
        out.push(`    ${n.txt ?? ""}`);
      });
    }
    out.push("");

    const factions = d.factions ?? {};
    const facKeys = Object.keys(factions);
    out.push(`── Factions (${facKeys.length}) ──`);
    if (!facKeys.length) {
      out.push("(none)");
    } else {
      facKeys.forEach((key, i) => {
        const f = factions[key] ?? {};
        out.push(`[${i + 1}] ${key}${f.name && f.name !== key ? `: ${f.name}` : ""}`);
        for (const [k, v] of Object.entries(f)) {
          if (k === "name") continue;
          const display = typeof v === "object" ? JSON.stringify(v) : String(v);
          out.push(`    ${k.padEnd(12)} ${display}`);
        }
      });
    }
    out.push("");

    return out.join("\n");
  }
}


// ── History Store ───────────────────────────────────────────

const MAX_EVENTS  = 1000000;
const PRUNE_COUNT = 10000;

export class HistoryStore extends CategoryStore {
  constructor() { super("history", "ace-history.json"); }

  _emptyData() {
    return { version: STORE_VERSION, worldId: null, savedAt: null, events: [] };
  }

  get recordCount() { return this._data.events?.length ?? 0; }

  _serialize() {
    return {
      version: this._data.version ?? STORE_VERSION,
      worldId: this._data.worldId,
      savedAt: this._data.savedAt,
      events:  this._data.events ?? [],
    };
  }

  _deserialize(data) {
    this._data.version = data.version ?? STORE_VERSION;
    this._data.events  = Array.isArray(data.events) ? data.events : [];
  }

  _mergeImport(data) {
    if (!Array.isArray(data.events)) return;
    // Dedup by timestamp + kind combo
    const existing = new Set(
      (this._data.events ?? []).map(e => `${e.t}:${e.k}:${e.a ?? ""}:${e.tgt ?? ""}`)
    );
    for (const e of data.events) {
      const sig = `${e.t}:${e.k}:${e.a ?? ""}:${e.tgt ?? ""}`;
      if (!existing.has(sig)) {
        this._data.events.push(e);
        existing.add(sig);
      }
    }
    // Re-sort by timestamp
    this._data.events.sort((a, b) => a.t - b.t);
  }

  /** Push a new event.  Prunes when MAX_EVENTS exceeded. */
  push(partial) {
    const event = { t: Math.floor(Date.now() / 1000), ...partial };
    this._data.events.push(event);
    // Warn GM when approaching the event cap (90% threshold)
    const count = this._data.events.length;
    if (count === Math.floor(MAX_EVENTS * 0.9)) {
      console.warn(`${MODULE_ID} | ⚠️ Event history at 90% capacity (${count.toLocaleString()} / ${MAX_EVENTS.toLocaleString()})`);
      if (game.user?.isGM) {
        ui.notifications?.warn(`ACE Engine: Event history reaching capacity (${count.toLocaleString()} / ${MAX_EVENTS.toLocaleString()}). Oldest events will be pruned soon.`, { permanent: true });
      }
    }
    if (count > MAX_EVENTS) {
      this._data.events.splice(0, PRUNE_COUNT);
      console.log(`${MODULE_ID} | history: pruned ${PRUNE_COUNT} oldest events.`);
      if (game.user?.isGM) {
        ui.notifications?.info(`ACE Engine: Pruned ${PRUNE_COUNT.toLocaleString()} oldest events to free space.`);
      }
    }
    this._dirty = true;
    return event;
  }

  /** Records used by the .txt companion. */
  _recordsForText() { return this._data.events ?? []; }

  /** Human-readable single-event format. Events use compact keys (t, k, a, tgt, etc.) — translate to readable labels. */
  _formatRecord(rec, _idx) {
    const ts = rec.t ? new Date(rec.t * 1000).toISOString().slice(0, 19).replace("T", " ") : "?";
    const kind = rec.k ?? "?";
    const lines = [`${kind.toUpperCase()} — ${ts}`];
    for (const [key, val] of Object.entries(rec)) {
      if (key === "t" || key === "k") continue;
      const labelMap = { a: "actor", tgt: "target", s: "scene", txt: "text", v: "value", d: "data" };
      const label = labelMap[key] ?? key;
      const display = typeof val === "object" ? JSON.stringify(val) : String(val);
      lines.push(`    ${label.padEnd(8)} ${display}`);
    }
    return lines.join("\n");
  }

  /** Get events since the last session_summary marker. */
  getEventsSinceLastSummary() {
    let lastIdx = -1;
    for (let i = this._data.events.length - 1; i >= 0; i--) {
      if (this._data.events[i].k === "session_summary") { lastIdx = i; break; }
    }
    return this._data.events.slice(lastIdx + 1);
  }

  /** Get the last N events. */
  getRecent(n = 40) { return this._data.events.slice(-n); }

  /** Get events matching a specific kind. */
  getByKind(kind, n = 50) {
    return this._data.events.filter(e => e.k === kind).slice(-n);
  }

  /** Get all events. */
  getAll() { return this._data.events; }

  /** Convert event to human-readable text. */
  eventToText(e) {
    if (!e) return "";
    const ts = e.t ? new Date(e.t * 1000).toLocaleDateString() : "";
    const sc = e.s ? ` [${e.s}]` : "";
    switch (e.k) {
      case "crit":           return `${ts} 🎯 Crit: ${e.a}${e.w ? " (" + e.w + ")" : ""}${e.tgt ? " → " + e.tgt : ""}${sc}`;
      case "fumble":         return `${ts} 💥 Fumble: ${e.a}${e.w ? " (" + e.w + ")" : ""}${sc}`;
      case "kill":           return `${ts} ☠️ ${e.tgt} killed${e.a ? " by " + e.a : ""}${sc}`;
      case "scene":          return `${ts} 🗺️ Scene: ${e.from ?? "?"} → ${e.to ?? "?"}`;
      case "narration":      return `${ts} 📜 Narration${sc}: "${(e.txt ?? "").slice(0, 80)}"`;
      case "note":           return `${ts} 📝 Note${sc}: ${e.txt ?? ""}`;
      case "combat_start":   return `${ts} ⚔️ Combat started${sc}`;
      case "combat_end":     return `${ts} 🏁 Combat ended${sc}${e.p?.length ? " (" + e.p.join(", ") + ")" : ""}`;
      case "session_summary": return `${ts} 📖 ${e.txt ?? "Session summary"}${sc}`;
      case "item_acquired":  return `${ts} 🎒 ${e.a ?? "?"} acquired ${e.item ?? "item"}${sc}`;
      case "item_lost":      return `${ts} 📤 ${e.a ?? "?"} lost ${e.item ?? "item"}${sc}`;
      case "pc_levelup":     return `${ts} ⬆️ ${e.a ?? "?"} leveled up: ${e.txt ?? ""}${sc}`;
      case "pc_milestone":   return `${ts} 🏆 ${e.a ?? "?"}: ${e.txt ?? "milestone"}${sc}`;
      case "location_discovered": return `${ts} 📍 Discovered: ${e.txt ?? "location"}${sc}`;
      case "tile_placed":    return `${ts} 🗺️ Tile placed${sc}`;
      case "tile_removed":   return `${ts} 🗺️ Tile removed${sc}`;
      case "disposition_change": return `${ts} 🤝 ${e.tgt ?? "NPC"} disposition: ${e.from ?? "?"} → ${e.to ?? "?"}${sc}`;
      case "deed":             return `${ts} 📜 Deed${sc}: ${e.txt ?? ""}${e.a ? " (" + e.a + ")" : ""}`;
      default:               return "";
    }
  }
}


// ── Deed Store ────────────────────────────────────────────────
// Tracks significant party accomplishments for the Fame system.
// Each deed has a magnitude (trivial/local/regional/major/legendary),
// a scene name (geographic proxy), and an in-game day counter.

const MAX_DEEDS = 500;

export class DeedStore extends CategoryStore {
  constructor() { super("deeds", "ace-deeds.json"); }

  _emptyData() {
    return { version: 1, deeds: [] };
  }

  get recordCount() { return this._data.deeds?.length ?? 0; }

  _serialize() {
    return {
      version: this._data.version ?? 1,
      deeds:   this._data.deeds ?? [],
    };
  }

  _deserialize(data) {
    this._data.version = data.version ?? 1;
    this._data.deeds   = Array.isArray(data.deeds) ? data.deeds : [];
  }

  _mergeImport(data) {
    if (!Array.isArray(data.deeds)) return;
    const existingIds = new Set((this._data.deeds ?? []).map(d => d.id));
    for (const d of data.deeds) {
      if (d.id && !existingIds.has(d.id)) this._data.deeds.push(d);
    }
  }

  /**
   * Add a deed to the log.
   * @param {{ text: string, magnitude: string, scene: string, day?: number, session?: number, pcs?: string[], source?: string }} deed
   * @returns {object} The created deed record
   */
  addDeed(deed) {
    if (!deed?.text) return null;

    const validMagnitudes = ["trivial", "local", "regional", "major", "legendary"];
    const magnitude = validMagnitudes.includes(deed.magnitude) ? deed.magnitude : "local";

    // Duplicate check: same text (normalized) on same day
    const normalizedText = deed.text.toLowerCase().trim();
    const day = deed.day ?? 1;
    const isDupe = (this._data.deeds ?? []).some(d =>
      d.day === day && d.text.toLowerCase().trim() === normalizedText
    );
    if (isDupe) return null;

    const id = `deed_${Math.floor(Date.now() / 1000)}_${Math.random().toString(36).slice(2, 5)}`;
    const record = {
      id,
      text:      deed.text.slice(0, 300),
      magnitude,
      scene:     (deed.scene ?? "").slice(0, 100),
      day,
      session:   deed.session ?? 0,
      timestamp: Math.floor(Date.now() / 1000),
      pcs:       Array.isArray(deed.pcs) ? deed.pcs.slice(0, 10) : [],
      source:    (deed.source ?? "manual:gm").slice(0, 30),
    };

    this._data.deeds.push(record);

    // Prune if over limit (remove oldest trivial deeds first, then oldest local)
    if (this._data.deeds.length > MAX_DEEDS) {
      const pruneOrder = ["trivial", "local", "regional", "major", "legendary"];
      for (const mag of pruneOrder) {
        const idx = this._data.deeds.findIndex(d => d.magnitude === mag);
        if (idx !== -1) { this._data.deeds.splice(idx, 1); break; }
      }
    }

    this._dirty = true;
    return record;
  }

  /** Records used by the .txt companion. */
  _recordsForText() { return this._data.deeds ?? []; }

  /** Human-readable single-deed format. */
  _formatRecord(rec, _idx) {
    const ts = rec.timestamp ? new Date(rec.timestamp * 1000).toISOString().slice(0, 19).replace("T", " ") : "?";
    const mag = (rec.magnitude ?? "?").toUpperCase();
    const lines = [
      `${mag} — ${ts}`,
      `    text:     ${rec.text ?? "(no text)"}`,
      `    source:   ${rec.source ?? "?"}`,
      `    day:      ${rec.day ?? "?"}`,
      `    session:  ${rec.session ?? "?"}`,
      `    scene:    ${rec.scene || "(none)"}`,
    ];
    if (rec.pcs?.length) lines.push(`    pcs:      ${rec.pcs.join(", ")}`);
    if (rec.id) lines.push(`    id:       ${rec.id}`);
    return lines.join("\n");
  }

  /** Get all deeds (read-only). */
  getDeeds() { return this._data.deeds ?? []; }

  /** Get the N most recent deeds. */
  getRecentDeeds(n = 20) {
    return (this._data.deeds ?? []).slice(-n);
  }

  /** Get deeds filtered by minimum magnitude. */
  getDeedsByMinMagnitude(minMag) {
    const order = ["trivial", "local", "regional", "major", "legendary"];
    const minIdx = order.indexOf(minMag);
    if (minIdx < 0) return this._data.deeds ?? [];
    return (this._data.deeds ?? []).filter(d => order.indexOf(d.magnitude) >= minIdx);
  }

  /** Remove a deed by ID. */
  removeDeed(id) {
    const idx = (this._data.deeds ?? []).findIndex(d => d.id === id);
    if (idx === -1) return false;
    this._data.deeds.splice(idx, 1);
    this._dirty = true;
    return true;
  }

  /** Get deed count by magnitude. */
  getMagnitudeCounts() {
    const counts = { trivial: 0, local: 0, regional: 0, major: 0, legendary: 0 };
    for (const d of this._data.deeds ?? []) {
      if (counts[d.magnitude] !== undefined) counts[d.magnitude]++;
    }
    return counts;
  }
}
