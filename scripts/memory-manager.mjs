// ============================================================
// ACE — AI Campaign Engine — Memory Manager (Orchestrator)
// Replaces the monolithic memory class.
// Manages 7 category stores, fan-out, migration, context,
// backup, and export/import.
// ============================================================

import {
  ItemStore, TileStore, PcStore, NpcStore,
  SceneStore, WorldStore, HistoryStore, DeedStore,
} from "./category-store.mjs";
import { DocumentStore } from "./document-store.mjs";

const MODULE_ID    = "ace-engine";
const SAVE_DEBOUNCE_MS = 2500;

// v13-safe FilePicker access (global removed in v13, namespaced under foundry.applications)
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ?? // v13+
  globalThis.FilePicker;                                     // v12 fallback

/** Upload a file silently — suppresses Foundry v13 notification toast.
 *  Uses refcount so concurrent uploads don't clobber the restore. */
let _silentDepth = 0;
let _origNotifyInfo = null;
async function _silentUpload(source, dir, file) {
  try {
    if (ui.notifications) {
      if (_silentDepth === 0) _origNotifyInfo = ui.notifications.info;
      _silentDepth++;
      ui.notifications.info = () => {};
    }
    return await _FP().upload(source, dir, file, { notify: false });
  } finally {
    if (ui.notifications && _silentDepth > 0) {
      _silentDepth--;
      if (_silentDepth === 0 && _origNotifyInfo) {
        ui.notifications.info = _origNotifyInfo;
        _origNotifyInfo = null;
      }
    }
  }
}

// Journal constants — hierarchical folder structure
const ACE_FOLDER_NAME     = "\u{1F4D6} ACE Engine";
const ACE_FOLDER_LEGACY   = "\u{1F4D6} ACE";          // old name → auto-renamed
const ACE_SUB_NPC         = "NPC Profiles";
const ACE_SUB_PC          = "PC Profiles";
const ACE_SUB_WORLD       = "World Lore";
const ACE_SUB_SESSIONS    = "Session Logs";

// Legacy constants (for detecting old single-journal structure)
const ACE_SESSION_JOURNAL = "Session Log";
const ACE_NPC_JOURNAL     = "NPC Memory";
const ACE_NOTES_JOURNAL   = "World Notes";

export class MemoryManager {
  constructor() {
    // ── Category stores ─────────────────────────────────────
    this.items   = new ItemStore();
    this.tiles   = new TileStore();
    this.pcs     = new PcStore();
    this.npcs    = new NpcStore();
    this.scenes  = new SceneStore();
    this.world   = new WorldStore();
    this.history = new HistoryStore();
    this.deeds     = new DeedStore();
    this.documents = new DocumentStore();

    this._stores = new Map([
      ["items",     this.items],
      ["tiles",     this.tiles],
      ["pcs",       this.pcs],
      ["npcs",      this.npcs],
      ["scenes",    this.scenes],
      ["world",     this.world],
      ["history",   this.history],
      ["deeds",     this.deeds],
      ["documents", this.documents],
    ]);

    this._worldId    = null;
    this._loaded     = false;
    this._saveTimers = new Map();   // per-category debounce
    this._lastAutoBackup = 0;      // timestamp of last auto-backup (5-min debounce)
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /**
   * Load all category stores from disk.
   * Handles migration from the old monolithic file.
   */
  async load() {
    this._worldId = game.world?.id ?? "unknown";

    // Ensure directory structure exists
    await this._ensureDirectories();

    // Check for old monolithic file and migrate if needed
    await this._migrateIfNeeded();

    // Load all stores
    const loadPromises = [];
    for (const store of this._stores.values()) {
      loadPromises.push(store.load(this._worldId));
    }
    await Promise.all(loadPromises);

    this._loaded = true;

    // Set campaign start if not yet set
    if (!this.world._data.campaignStart) {
      this.world._data.campaignStart = Math.floor(Date.now() / 1000);
      this.world._data.worldName     = game.world?.title ?? game.world?.id ?? "";
      this.world.markDirty();
      this._scheduleSave("world");
    }

    const totalRecords = Array.from(this._stores.values()).reduce((n, s) => n + s.recordCount, 0);
    console.log(`${MODULE_ID} | MemoryManager: loaded ${totalRecords} total records across ${this._stores.size} stores.`);
  }

  /** Save all dirty stores immediately. */
  async saveAll() {
    const saves = [];
    for (const store of this._stores.values()) {
      saves.push(store.save(this._worldId));
    }
    await Promise.all(saves);
  }

  /** Save a specific category. */
  async saveCategory(category) {
    const store = this._stores.get(category);
    if (store) await store.save(this._worldId);
  }

  // ── Directory Setup ───────────────────────────────────────

  async _ensureDirectories() {
    try {
      await _FP().createDirectory("data", `worlds/${this._worldId}/ace-engine`);
    } catch (e) {
      // Directory may already exist — that's fine
      if (!e.message?.includes("EEXIST") && !e.message?.includes("already exists")) {
        console.warn(`${MODULE_ID} | Could not create ace-engine directory:`, e.message);
      }
    }
    try {
      await _FP().createDirectory("data", `worlds/${this._worldId}/ace-engine/backups`);
    } catch (e) {
      if (!e.message?.includes("EEXIST") && !e.message?.includes("already exists")) {
        console.warn(`${MODULE_ID} | Could not create backups directory:`, e.message);
      }
    }
    try {
      await _FP().createDirectory("data", `worlds/${this._worldId}/ace-engine/library`);
    } catch (e) {
      if (!e.message?.includes("EEXIST") && !e.message?.includes("already exists")) {
        console.warn(`${MODULE_ID} | Could not create library directory:`, e.message);
      }
    }
    try {
      await _FP().createDirectory("data", `worlds/${this._worldId}/ace-engine/library/images`);
    } catch (e) {
      if (!e.message?.includes("EEXIST") && !e.message?.includes("already exists")) {
        console.warn(`${MODULE_ID} | Could not create library/images directory:`, e.message);
      }
    }
  }

  // ── Migration from monolithic memory file ──────────────────

  async _migrateIfNeeded() {
    // Use FilePicker.browse() to check existence — avoids red 404s in console
    const aceDir  = `worlds/${this._worldId}/ace-engine`;
    const worldDir = `worlds/${this._worldId}`;

    // If new format already exists, skip migration
    try {
      const listing = await _FP().browse("data", aceDir);
      const hasNew  = (listing?.files ?? []).some(f => f.endsWith("ace-history.json"));
      if (hasNew) return false;  // already migrated
    } catch (_) { /* directory may not exist yet */ }

    // Check if old monolithic file exists
    let oldData;
    try {
      const listing = await _FP().browse("data", worldDir);
      const hasOld  = (listing?.files ?? []).some(f => f.endsWith("ace-engine-memory.json"));
      if (!hasOld) return false;  // no old file either — fresh install

      // Old file exists — fetch it for migration
      const resp = await fetch(`${worldDir}/ace-engine-memory.json`, { cache: "no-store" });
      if (!resp.ok) return false;
      oldData = await resp.json();
    } catch (_) { return false; }

    console.log(`${MODULE_ID} | Migrating from monolithic memory file…`);

    // Back up the original
    try {
      const bkPayload = JSON.stringify(oldData, null, 0);
      const bkFile = new File([bkPayload], "ace-engine-memory-pre-migration.json", { type: "application/json" });
      await _silentUpload("data", `worlds/${this._worldId}/ace-engine/backups`, bkFile);
      console.log(`${MODULE_ID} | Migration: backed up original file.`);
    } catch (e) {
      console.warn(`${MODULE_ID} | Migration: could not backup original:`, e.message);
    }

    // ── Split data into category stores ─────────────────────

    // 1. History — events[]
    if (Array.isArray(oldData.events)) {
      this.history._deserialize({ events: oldData.events });
      this.history.markDirty();
    }

    // 2. NPCs — npcs{}
    if (oldData.npcs && typeof oldData.npcs === "object") {
      // Enrich old NPC records with new fields
      const enriched = {};
      for (const [key, rec] of Object.entries(oldData.npcs)) {
        enriched[key] = {
          actorId: null,
          type: "unknown",
          race: null,
          class: null,
          killedAt: rec.killed ? (rec.last ?? Math.floor(Date.now() / 1000)) : null,
          relationships: {},
          combatStats: { encounterCount: 0, wasDefeated: rec.killed ?? false, lastHp: null },
          ...rec,
        };
      }
      this.npcs._deserialize({ npcs: enriched });
      this.npcs.markDirty();
    }

    // 3. World — sessions[] + worldNotes[]
    const worldData = {
      worldName:     game.world?.title ?? "",
      campaignStart: oldData.events?.[0]?.t ?? Math.floor(Date.now() / 1000),
      sessions:      Array.isArray(oldData.sessions)   ? oldData.sessions   : [],
      worldNotes:    Array.isArray(oldData.worldNotes) ? oldData.worldNotes : [],
      factions:      {},
      calendar:      { currentDate: "", notes: [] },
    };
    this.world._deserialize(worldData);
    this.world.markDirty();

    // 4. PCs — extract from events
    if (Array.isArray(oldData.events)) {
      const pcNames = new Set();
      for (const e of oldData.events) {
        if (e.a) pcNames.add(e.a);
      }
      // Try to match names to actual player-owned actors
      for (const name of pcNames) {
        const actor = game.actors?.find(a => a.name === name && a.hasPlayerOwner);
        if (actor) {
          const rec = this.pcs.touchPc(actor.id, actor.name);
          if (rec) {
            rec.class = this._extractClass(actor);
            rec.level = this._extractLevel(actor);
            // Tally crits/fumbles/kills from events
            for (const e of oldData.events) {
              if (e.a === name && e.k === "crit")   rec.crits++;
              if (e.a === name && e.k === "fumble") rec.fumbles++;
              if (e.a === name && e.k === "kill")   rec.kills++;
            }
          }
        }
      }
      this.pcs.markDirty();
    }

    // 5. Scenes — extract from scene-transition events
    if (Array.isArray(oldData.events)) {
      const sceneNames = new Set();
      for (const e of oldData.events) {
        if (e.k === "scene") {
          if (e.from) sceneNames.add(e.from);
          if (e.to)   sceneNames.add(e.to);
        }
        if (e.s) sceneNames.add(e.s);
      }
      for (const name of sceneNames) {
        if (!name) continue;
        const foundryScene = game.scenes?.find(s => s.name === name);
        this.scenes.recordVisit(name, foundryScene?.id ?? null, {
          description: foundryScene?.description ?? "",
        });
      }
      this.scenes.markDirty();
    }

    // 6. Items + Tiles — start empty (no data to migrate)
    this.items.markDirty();
    this.tiles.markDirty();

    // Mark every store as loaded so save() doesn't skip them
    for (const store of this._stores.values()) {
      store._loaded = true;
      store._data.worldId = this._worldId;
    }

    // Save all migrated stores to disk
    await this.saveAll();
    console.log(`${MODULE_ID} | Migration complete: split into ${this._stores.size} category files.`);
    return true;
  }

  // ── Event Logging (fan-out) ───────────────────────────────

  /**
   * Log a critical hit or fumble.
   * Fan-out: history, npcs (attacker + target), pcs (attacker tally)
   */
  logCritFumble({ type, actorName, weaponName, targetName, scene } = {}) {
    const kind = type === "crit" ? "crit" : "fumble";
    this.history.push({
      k: kind, a: actorName ?? "Unknown", w: weaponName ?? null,
      tgt: targetName ?? null, s: scene ?? this._currentScene(),
    });

    if (actorName)  this.npcs.touchNpc(actorName, scene);
    if (targetName) this.npcs.touchNpc(targetName, scene);

    // Tally for PC
    const pc = this._findPcByName(actorName);
    if (pc) {
      if (kind === "crit")   pc.crits++;
      else                   pc.fumbles++;
      this.pcs.markDirty();
    }

    // Scene event
    this.scenes.appendVisitEvent(scene ?? this._currentScene(), {
      t: Math.floor(Date.now() / 1000), k: kind,
      summary: `${actorName ?? "?"} ${kind} ${targetName ? "→ " + targetName : ""}`,
    });

    this._scheduleSaves(["history", "npcs", "pcs", "scenes"]);

    // Auto-sync journals for involved parties
    if (actorName)  this.writeNpcJournal(actorName).catch(() => {});
    if (targetName) this.writeNpcJournal(targetName).catch(() => {});
    if (pc) this.writePcJournal(pc.actorId).catch(() => {});
  }

  /**
   * Log a kill (HP reaching 0).
   * Fan-out: history, npcs (victim + killer), pcs (killer tally), scenes
   */
  logKill({ victimName, killerName, scene } = {}) {
    this.history.push({
      k: "kill", tgt: victimName ?? "Unknown", a: killerName ?? null,
      s: scene ?? this._currentScene(),
    });

    this.npcs.markKilled(victimName, killerName);
    if (killerName) this.npcs.touchNpc(killerName, scene);

    // PC kill tally
    const pc = this._findPcByName(killerName);
    if (pc) { pc.kills++; this.pcs.markDirty(); }

    // Scene event
    this.scenes.appendVisitEvent(scene ?? this._currentScene(), {
      t: Math.floor(Date.now() / 1000), k: "kill",
      summary: `${victimName ?? "?"} killed${killerName ? " by " + killerName : ""}`,
    });

    this._scheduleSaves(["history", "npcs", "pcs", "scenes"]);

    // Auto-sync journals for involved parties
    if (victimName) this.writeNpcJournal(victimName).catch(() => {});
    if (killerName) this.writeNpcJournal(killerName).catch(() => {});
    if (pc) this.writePcJournal(pc.actorId).catch(() => {});
  }

  /**
   * Log an attack hit or miss for a PC.
   * @param {{ actorName: string, hit: boolean, damage: number, weaponName: string|null }} opts
   */
  logAttackResult({ actorName, hit, damage = 0, weaponName = null } = {}) {
    const pc = this._findPcByName(actorName);
    if (!pc) return;
    if (hit) {
      pc.hits = (pc.hits ?? 0) + 1;
      if (damage > 0) {
        pc.damageDealt = (pc.damageDealt ?? 0) + damage;
        if (damage > (pc.highestHit ?? 0)) pc.highestHit = damage;
      }
    } else {
      pc.misses = (pc.misses ?? 0) + 1;
    }
    this.pcs.markDirty();
    this._scheduleSaves(["pcs"]);
  }

  /**
   * Log HP damage taken by a PC.
   * @param {{ actorName: string, amount: number }} opts
   */
  logDamageTaken({ actorName, amount } = {}) {
    if (!amount || amount <= 0) return;
    const pc = this._findPcByName(actorName);
    if (!pc) return;
    pc.damageTaken = (pc.damageTaken ?? 0) + amount;
    this.pcs.markDirty();
    this._scheduleSaves(["pcs"]);
  }

  /**
   * Log healing done by a PC (to any target).
   * @param {{ actorName: string, amount: number }} opts
   */
  logHealing({ actorName, amount } = {}) {
    if (!amount || amount <= 0) return;
    const pc = this._findPcByName(actorName);
    if (!pc) return;
    pc.healingDone = (pc.healingDone ?? 0) + amount;
    this.pcs.markDirty();
    this._scheduleSaves(["pcs"]);
  }

  /**
   * Log a PC being knocked to 0 HP.
   * @param {{ actorName: string }} opts
   */
  logKnockout({ actorName } = {}) {
    const pc = this._findPcByName(actorName);
    if (!pc) return;
    pc.timesKO = (pc.timesKO ?? 0) + 1;
    this.pcs.markDirty();
    this._scheduleSaves(["pcs"]);
  }

  /**
   * Log a death save result for a PC.
   * @param {{ actorName: string, success: boolean }} opts
   */
  logDeathSave({ actorName, success } = {}) {
    const pc = this._findPcByName(actorName);
    if (!pc) return;
    if (success) pc.deathSavePass = (pc.deathSavePass ?? 0) + 1;
    else         pc.deathSaveFail = (pc.deathSaveFail ?? 0) + 1;
    this.pcs.markDirty();
    this._scheduleSaves(["pcs"]);
  }

  /**
   * Increment session count for a PC.
   * @param {{ actorName: string }} opts
   */
  logSession({ actorName } = {}) {
    const pc = this._findPcByName(actorName);
    if (!pc) return;
    pc.sessions = (pc.sessions ?? 0) + 1;
    this.pcs.markDirty();
    this._scheduleSaves(["pcs"]);
  }

  /** Log a scene transition. Fan-out: history, scenes, tiles (location) */
  logSceneChange(fromScene, toScene) {
    this.history.push({
      k: "scene", from: fromScene ?? null, to: toScene ?? null,
      s: toScene ?? this._currentScene(),
    });

    // Record visit in scene store
    if (toScene) {
      const foundryScene = canvas?.scene;
      const npcs = (canvas?.tokens?.placeables ?? [])
        .filter(t => !t.actor?.hasPlayerOwner && t.actor?.type === "npc")
        .map(t => t.name);
      const pcsArr = (canvas?.tokens?.placeables ?? [])
        .filter(t => t.actor?.hasPlayerOwner)
        .map(t => t.name);
      this.scenes.recordVisit(toScene, foundryScene?.id ?? null, {
        npcsPresent: npcs,
        pcsPresent:  pcsArr,
        description: foundryScene?.description ?? "",
      });
    }

    // Touch location in tile store
    if (toScene) {
      const foundryScene = canvas?.scene;
      this.tiles.touchLocation(toScene, foundryScene?.id ?? null);
    }

    this._scheduleSaves(["history", "scenes", "tiles"]);
  }

  /** Log a narration sent to players. Fan-out: history only */
  logNarration(text, scene) {
    if (!text) return;
    this.history.push({
      k: "narration", txt: text.slice(0, 300),
      s: scene ?? this._currentScene(),
    });
    this._scheduleSave("history");
  }

  /** Log a GM note. Fan-out: history, world (world note), journal */
  logNote(text, scene) {
    if (!text) return;
    this.history.push({
      k: "note", txt: text.slice(0, 500),
      s: scene ?? this._currentScene(),
    });
    this.world.addWorldNote(text, scene ?? this._currentScene(), "note");
    this._scheduleSaves(["history", "world"]);
    // Auto-sync journal
    const title = scene
      ? `${scene} — ${new Date().toLocaleDateString()}`
      : `Note — ${new Date().toLocaleDateString()}`;
    this.writeWorldNoteJournal(text, title).catch(e => console.warn(`${MODULE_ID} | World note journal sync:`, e));
  }

  /** Log combat start. Fan-out: history, scenes */
  logCombatStart(scene) {
    this.history.push({ k: "combat_start", s: scene ?? this._currentScene() });
    this.scenes.appendVisitEvent(scene ?? this._currentScene(), {
      t: Math.floor(Date.now() / 1000), k: "combat_start",
    });
    this._scheduleSaves(["history", "scenes"]);
  }

  /** Log combat end. Fan-out: history, npcs (participants), scenes */
  logCombatEnd(participantNames, scene) {
    this.history.push({
      k: "combat_end", p: participantNames ?? [],
      s: scene ?? this._currentScene(),
    });
    for (const name of (participantNames ?? [])) {
      this.npcs.touchNpc(name, scene);
    }
    this.scenes.appendVisitEvent(scene ?? this._currentScene(), {
      t: Math.floor(Date.now() / 1000), k: "combat_end",
      summary: `Participants: ${(participantNames ?? []).join(", ")}`,
    });
    this._scheduleSaves(["history", "npcs", "scenes"]);
  }

  // ── NEW Event Logging ─────────────────────────────────────

  /** Log item acquired by a PC. Fan-out: history, items, pcs */
  logItemAcquired({ actorName, itemName, itemType, rarity, scene } = {}) {
    if (!itemName) return;
    this.history.push({
      k: "item_acquired", a: actorName ?? null, item: itemName,
      s: scene ?? this._currentScene(),
    });

    const rec = this.items.touch(itemName, itemName);
    if (rec) {
      rec.owner   = actorName ?? rec.owner;
      rec.status  = "held";
      rec.location = scene ?? this._currentScene();
      if (itemType) rec.type   = itemType;
      if (rarity)   rec.rarity = rarity;
    }

    this._scheduleSaves(["history", "items"]);
  }

  /** Log item lost/removed. Fan-out: history, items */
  logItemLost({ actorName, itemName, scene } = {}) {
    if (!itemName) return;
    this.history.push({
      k: "item_lost", a: actorName ?? null, item: itemName,
      s: scene ?? this._currentScene(),
    });

    const rec = this.items.getRecord(itemName);
    if (rec) {
      if (rec.owner && !rec.previousOwners.includes(rec.owner)) {
        rec.previousOwners.push(rec.owner);
      }
      rec.owner  = null;
      rec.status = "lost";
      this.items.markDirty();
    }

    this._scheduleSaves(["history", "items"]);
  }

  /** Log PC level-up. Fan-out: history, pcs */
  logPcLevelUp({ actorId, actorName, newLevel, className, scene } = {}) {
    const txt = `${className ? className + " " : ""}Level ${newLevel ?? "?"}`;
    this.history.push({
      k: "pc_levelup", a: actorName ?? "Unknown", txt,
      s: scene ?? this._currentScene(),
    });

    if (actorId) {
      const rec = this.pcs.touchPc(actorId, actorName);
      if (rec) {
        rec.level = newLevel ?? rec.level;
        if (className) rec.class = className;
        rec.milestones.push({
          t: Math.floor(Date.now() / 1000),
          txt: `Reached ${txt}`,
          type: "levelup",
        });
        if (rec.milestones.length > 100) rec.milestones.shift();
      }
    }

    this._scheduleSaves(["history", "pcs"]);
  }

  /** Log PC milestone (manual). Fan-out: history, pcs */
  logPcMilestone({ actorId, actorName, text, milestoneType, scene } = {}) {
    this.history.push({
      k: "pc_milestone", a: actorName ?? "Unknown", txt: text ?? "milestone",
      s: scene ?? this._currentScene(),
    });

    if (actorId) {
      const rec = this.pcs.touchPc(actorId, actorName);
      if (rec) {
        rec.milestones.push({
          t: Math.floor(Date.now() / 1000),
          txt: (text ?? "milestone").slice(0, 300),
          type: milestoneType ?? "story",
        });
        if (rec.milestones.length > 100) rec.milestones.shift();
      }
    }

    this._scheduleSaves(["history", "pcs"]);
  }

  /** Log a location note. Fan-out: history, tiles */
  logLocationNote({ locationName, text, scene } = {}) {
    if (!locationName || !text) return;
    this.history.push({
      k: "location_discovered", txt: locationName,
      s: scene ?? this._currentScene(),
    });

    const loc = this.tiles.touchLocation(locationName);
    if (loc) {
      loc.notes.push({ t: Math.floor(Date.now() / 1000), txt: text.slice(0, 500) });
      if (loc.notes.length > 30) loc.notes.shift();
      this.tiles.markDirty();
    }

    this._scheduleSaves(["history", "tiles"]);
  }

  /** Log Foundry tile placed/removed. Fan-out: history, tiles */
  logTileChange({ action, sceneName, tileData } = {}) {
    this.history.push({
      k: action === "removed" ? "tile_removed" : "tile_placed",
      s: sceneName ?? this._currentScene(),
    });
    this._scheduleSaves(["history", "tiles"]);
  }

  // ── Deed Logging (Fame System) ────────────────────────────

  /**
   * Log a significant party deed. Fan-out: deeds, history
   * @param {{ text: string, magnitude: string, scene?: string, pcs?: string[], source?: string }} deed
   * @returns {object|null} The created deed record, or null if duplicate/invalid
   */
  logDeed(deed) {
    if (!deed?.text) return null;

    // Enrich with current day/session context
    const enriched = {
      ...deed,
      scene:   deed.scene || this._currentScene(),
      day:     deed.day ?? (this.world.getDayCounter()),
      session: deed.session ?? (this.world.getLastSession()?.num ?? 0),
    };

    const record = this.deeds.addDeed(enriched);
    if (!record) return null;  // duplicate or invalid

    // Also log to history for timeline visibility
    this.history.push({
      k:   "deed",
      txt: record.text,
      s:   record.scene,
      a:   record.pcs?.join(", ") ?? "",
    });

    this._scheduleSaves(["deeds", "history"]);
    console.log(`${MODULE_ID} | Deed logged: "${record.text}" (${record.magnitude}) [${record.source}]`);
    return record;
  }

  /** Get all deeds. */
  getDeeds()            { return this.deeds.getDeeds(); }
  /** Get N most recent deeds. */
  getRecentDeeds(n)     { return this.deeds.getRecentDeeds(n); }
  /** Get deed count by magnitude. */
  getDeedCounts()       { return this.deeds.getMagnitudeCounts(); }

  // ── Simple Calendar Bridge (set externally by ace-engine.mjs) ─
  /** @type {import("./simple-calendar-bridge.mjs").SimpleCalendarBridge|null} */
  _scBridge = null;

  /** Attach Simple Calendar bridge for two-way sync. */
  setCalendarBridge(bridge) { this._scBridge = bridge ?? null; }

  // ── Day Counter Convenience Methods ─────────────────────────

  /** Get current in-game day. */
  getDayCounter()       { return this.world.getDayCounter(); }
  /** Get current time of day. */
  getTimeOfDay()        { return this.world.getTimeOfDay(); }

  /** Advance day counter and optionally set time. */
  advanceDay(n = 1, timeOfDay = "morning") {
    const newDay = this.world.advanceDay(n);
    this.world.setTimeOfDay(timeOfDay);
    this._scheduleSave("world");
    // Push to Simple Calendar (if bridge active)
    this._scBridge?.pushDayAdvance(n, timeOfDay);
    return newDay;
  }

  /** Set time of day. */
  setTimeOfDay(time) {
    this.world.setTimeOfDay(time);
    this._scheduleSave("world");
    // Push to Simple Calendar (if bridge active)
    this._scBridge?.pushTimeChange(time);
  }

  /** Advance time by one step. */
  advanceTimeStep() {
    const newTime = this.world.advanceTimeStep();
    this._scheduleSave("world");
    // Push to Simple Calendar (if bridge active)
    this._scBridge?.pushTimeChange(newTime);
    return newTime;
  }

  // ── NPC Management (backward compat) ──────────────────────

  getNpcRecord(name)   { return this.npcs.getRecord(name); }
  getAllNpcs()          { return this.npcs.getAll(); }

  addNpcNote(npcName, noteText) {
    if (!npcName || !noteText) return;
    this.npcs.touchNpc(npcName, this._currentScene());
    this.npcs.addNote(npcName, noteText);
    this._scheduleSave("npcs");
    // Auto-sync journal
    this.writeNpcJournal(npcName).catch(e => console.warn(`${MODULE_ID} | NPC journal sync:`, e));
  }

  // ── Context Injection (backward compat) ───────────────────

  /**
   * Build a compact context string for AI prompts.
   * Draws from all relevant stores.
   * @param {number} maxChars
   * @returns {string}
   */
  getContextString(maxChars = 3000) {
    if (!this._loaded) return "";

    const parts = [];

    // 1. Last session summary (world store)
    const lastSession = this.world.getLastSession();
    if (lastSession) {
      parts.push(`### Last Session (${lastSession.date})\n${lastSession.summary}`);
    }

    // 2. Recent events (history store, last 40)
    const recent = this.history.getRecent(40);
    if (recent.length) {
      const lines = recent.map(e => this.history.eventToText(e)).filter(Boolean);
      if (lines.length) parts.push(`### Recent Events\n${lines.join("\n")}`);
    }

    // 3. Known NPCs (npc store, top 15 by recency)
    const npcs = this.npcs.getAll()
      .filter(n => n.met > 0)
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
      .slice(0, 15);

    if (npcs.length) {
      const lines = npcs.map(n => {
        let line = `- **${n.displayName}**`;
        if (n.killed) line += ` \u2620\uFE0F (killed${n.killedBy ? " by " + n.killedBy : ""})`;
        else          line += ` \u2014 met ${n.met}x`;
        if (n.notes?.length) {
          line += ` | ${n.notes.slice(-2).map(x => x.txt).join("; ")}`;
        }
        return line;
      });
      parts.push(`### Known NPCs\n${lines.join("\n")}`);
    }

    // 4. PC highlights (pc store)
    const pcList = this.pcs.getAll().filter(p => p.displayName);
    if (pcList.length) {
      const lines = pcList.map(p => {
        let line = `- **${p.displayName}**`;
        if (p.class) line += ` (${p.class})`;
        if (p.kills)   line += ` | ${p.kills} kills`;
        if (p.crits)   line += `, ${p.crits} crits`;
        const recentMs = p.milestones?.slice(-2) ?? [];
        if (recentMs.length) line += ` | ${recentMs.map(m => m.txt).join("; ")}`;
        return line;
      });
      parts.push(`### Party\n${lines.join("\n")}`);
    }

    // 5. World notes (world store, last 5)
    const worldNotes = this.world.getWorldNotes().slice(-5);
    if (worldNotes.length) {
      const notes = worldNotes.map(n => `- ${n.txt}`).join("\n");
      parts.push(`### World Notes\n${notes}`);
    }

    // 6. Notable items (item store, currently held)
    const heldItems = this.items.getAll().filter(i => i.status === "held" && i.owner);
    if (heldItems.length) {
      const lines = heldItems.slice(0, 10).map(i => `- **${i.displayName}** (${i.owner})`);
      parts.push(`### Notable Items\n${lines.join("\n")}`);
    }

    // Trim to budget
    let result = parts.join("\n\n");
    if (result.length > maxChars) result = result.slice(0, maxChars) + "\n\u2026(truncated)";
    return result;
  }

  /** Get the last N narration events as plain text. */
  getRecentNarrations(n = 50) {
    return this.history.getByKind("narration", n).map(e => e.txt).filter(Boolean);
  }

  /** Get events since the last session_summary marker. */
  getEventsSinceLastSummary() {
    return this.history.getEventsSinceLastSummary();
  }

  /** Get a human-readable digest of recent events. */
  getEventDigest(maxEvents = 100) {
    const events = this.getEventsSinceLastSummary().slice(-maxEvents);
    if (!events.length) return "No events recorded since last session.";
    return events.map(e => this.history.eventToText(e)).filter(Boolean).join("\n");
  }

  // ── Session Management (backward compat) ──────────────────

  async saveSessionSummary({ sessionNum, date, sceneName, summary, partyNames = [] } = {}) {
    const record = {
      t:       Math.floor(Date.now() / 1000),
      num:     sessionNum,
      date:    date ?? new Date().toISOString().slice(0, 10),
      scene:   sceneName ?? this._currentScene(),
      party:   partyNames,
      summary: summary.slice(0, 2000),
    };

    this.world.addSession(record);
    this.history.push({ k: "session_summary", txt: `Session ${sessionNum}`, s: record.scene });

    await this._writeSessionJournal(record);
    this._scheduleSaves(["world", "history"]);

    // ── Auto-backup after session summary (critical save point) ────
    // Run in background so it doesn't block the UI
    this.autoBackup().catch(err =>
      console.warn(`${MODULE_ID} | Auto-backup after session summary failed:`, err)
    );
  }

  /**
   * Get the next session number based on existing records.
   */
  getNextSessionNum() {
    const lastSession = this.world.getLastSession();
    return (lastSession?.num ?? 0) + 1;
  }

  /**
   * Generate a retroactive session summary from events on a specific date.
   * @param {string} dateStr  ISO date like "2026-03-10"
   * @param {object} aiProvider  AI provider instance
   * @param {object} sceneCtx    Scene context (optional)
   * @param {Function} onChunk   Streaming callback (optional)
   * @returns {string} The generated summary text
   */
  async generateRetroactiveSummary(dateStr, aiProvider, sceneCtx = null, onChunk = null) {
    // Filter events by date
    const targetDate = dateStr; // "2026-03-10"
    const allEvents = this.history.getAll();
    const dayEvents = allEvents.filter(e => {
      if (!e.t) return false;
      return new Date(e.t * 1000).toISOString().slice(0, 10) === targetDate;
    });

    if (!dayEvents.length) {
      throw new Error(`No events found for ${dateStr}`);
    }

    // Build digest from those events
    const digest = dayEvents.map(e => this.history.eventToText(e)).filter(Boolean).join("\n");
    const narrations = dayEvents.filter(e => e.k === "narration").map(e => e.txt).filter(Boolean).join("\n- ");

    // Extract party names from events (actors mentioned in combat, kills, crits)
    const partyNamesSet = new Set();
    for (const e of dayEvents) {
      if (e.p && Array.isArray(e.p)) e.p.forEach(n => partyNamesSet.add(n));
      if (e.a) {
        const actor = game.actors?.find(a => a.name === e.a && a.hasPlayerOwner);
        if (actor) partyNamesSet.add(e.a);
      }
    }
    const partyNames = partyNamesSet.size > 0
      ? [...partyNamesSet].join(", ")
      : (game.actors?.filter(a => a.hasPlayerOwner && a.type === "character") ?? []).map(a => a.name).join(", ");

    // Extract scene names mentioned
    const sceneNames = [...new Set(dayEvents.filter(e => e.s).map(e => e.s))];
    const sceneLabel = sceneNames.length ? sceneNames.join(", ") : "unknown";

    const prompt = `You are ACE, the AI Campaign Engine chronicler for a tabletop RPG campaign.

Based on these events from a session on ${targetDate}, write a concise session summary (3-5 paragraphs) suitable for a campaign journal. Write in past tense, third person. Focus on dramatic moments, character decisions, and story beats — not every mechanical detail.

**Scenes visited:** ${sceneLabel}
**Party:** ${partyNames || "unknown"}

**Events this session:**
${digest}

${narrations ? `**Narrations sent to players:**\n- ${narrations}` : ""}

Write the session summary now. Be vivid but concise — this is a campaign journal entry, not a transcript.`;

    let summary = "";
    try {
      const sceneContext = sceneCtx?.gatherCompact?.() ?? "";
      if (onChunk) {
        await aiProvider.chatStream(prompt, sceneContext, "", [], (chunk) => {
          summary += chunk;
          onChunk(chunk);
        });
      } else {
        summary = await aiProvider.chat(prompt, sceneContext);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | generateRetroactiveSummary failed:`, err);
      summary = `Session summary could not be generated. Events: ${digest.slice(0, 500)}`;
    }

    return { summary: summary.trim(), sceneLabel, partyNames };
  }

  /**
   * Check if there are unsaved events (events since the last session_summary marker).
   * @returns {number} Number of unsaved events
   */
  getUnsavedEventCount() {
    return this.getEventsSinceLastSummary().length;
  }

  /**
   * Ask the AI to generate a session summary.
   */
  async generateSessionSummary(aiProvider, sceneCtx, onChunk = null) {
    const digest     = this.getEventDigest(150);
    const narrations = this.getRecentNarrations(30).join("\n- ");
    const partyNames = (game.actors?.filter(a => a.hasPlayerOwner && a.type === "character") ?? [])
      .map(a => a.name).join(", ");
    const sceneName  = canvas?.scene?.name ?? "unknown";

    const prompt = `You are ACE, the AI Campaign Engine chronicler for a tabletop RPG campaign.

Based on these recent events and narrations, write a concise session summary (3-5 paragraphs) suitable for a campaign journal. Write in past tense, third person. Focus on dramatic moments, character decisions, and story beats \u2014 not every mechanical detail.

**Current Scene:** ${sceneName}
**Party:** ${partyNames || "unknown"}

**Events this session:**
${digest}

${narrations ? `**Narrations sent to players:**\n- ${narrations}` : ""}

Write the session summary now. Be vivid but concise \u2014 this is a campaign journal entry, not a transcript.`;

    let summary = "";
    try {
      const sceneContext = sceneCtx?.gatherCompact?.() ?? "";
      if (onChunk) {
        await aiProvider.chatStream(prompt, sceneContext, "", [], (chunk) => {
          summary += chunk;
          onChunk(chunk);
        });
      } else {
        summary = await aiProvider.chat(prompt, sceneContext);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | generateSessionSummary failed:`, err);
      summary = `Session summary could not be generated. Events: ${digest.slice(0, 500)}`;
    }
    return summary.trim();
  }

  // ── Backup ────────────────────────────────────────────────

  /**
   * Back up one or all categories.
   * Each store creates a timestamped copy and prunes old backups.
   * @param {string|null} category — A specific category name, or null for all.
   * @param {number} [maxBackups=10] — How many backups to keep per store.
   */
  async backup(category = null, maxBackups = 10) {
    if (category) {
      const store = this._stores.get(category);
      if (store) await store.backup(this._worldId, maxBackups);
    } else {
      const tasks = [];
      for (const store of this._stores.values()) {
        tasks.push(store.backup(this._worldId, maxBackups));
      }
      await Promise.all(tasks);
      console.log(`${MODULE_ID} | Full backup completed (${this._stores.size} stores, keeping ${maxBackups} per store).`);
    }
  }

  /**
   * Auto-backup: called internally after significant events.
   * Backs up all stores that have data, keeps 10 rotating copies.
   * Debounced — won't fire more than once per 5 minutes.
   */
  async autoBackup() {
    const now = Date.now();
    if (this._lastAutoBackup && (now - this._lastAutoBackup) < 300_000) {
      // Demoted from log to debug — routine background operation, no need
      // to spam the console with skip notifications.
      console.debug(`${MODULE_ID} | Auto-backup skipped (last was ${Math.round((now - this._lastAutoBackup) / 1000)}s ago).`);
      return;
    }
    this._lastAutoBackup = now;
    console.debug(`${MODULE_ID} | Auto-backup triggered…`);
    await this.backup(null, 10);
  }

  // ── Export / Import ───────────────────────────────────────

  /** Export a single category as a downloadable Blob. */
  exportCategory(category) {
    const store = this._stores.get(category);
    if (!store) return null;
    return store.exportBlob();
  }

  /** Export all categories as a single JSON Blob. */
  exportAll() {
    const combined = {
      _export: {
        module:     MODULE_ID,
        version:    game.modules?.get(MODULE_ID)?.version ?? "0.6",
        type:       "full",
        worldId:    this._worldId,
        exportedAt: new Date().toISOString(),
      },
    };
    for (const [name, store] of this._stores) {
      combined[name] = store._serialize();
    }
    return new Blob([JSON.stringify(combined, null, 2)], { type: "application/json" });
  }

  /**
   * Import a single category from parsed JSON.
   * @param {string} category
   * @param {object} data
   * @param {"replace"|"merge"} mode
   * @returns {{ ok: boolean, message: string }}
   */
  async importCategory(category, data, mode = "replace") {
    const store = this._stores.get(category);
    if (!store) return { ok: false, message: `Unknown category: ${category}` };
    const result = store.importData(data, mode);
    if (result.ok) {
      await store.save(this._worldId);
    }
    return result;
  }

  /**
   * Import all categories from a full export.
   * Automatically creates a backup before import to protect existing data.
   * @param {object} data   - the parsed JSON with all category keys
   * @param {"replace"|"merge"} mode
   * @returns {{ ok: boolean, message: string }}
   */
  async importAll(data, mode = "replace") {
    if (!data || typeof data !== "object") return { ok: false, message: "Invalid data." };

    // Safety backup before import — in case the import goes wrong
    console.log(`${MODULE_ID} | Creating safety backup before import (mode: ${mode})…`);
    await this.backup(null, 10);

    const results = [];
    for (const [name, store] of this._stores) {
      if (data[name]) {
        const r = store.importData({ _export: data._export, ...data[name] }, mode);
        results.push(`${name}: ${r.message}`);
      }
    }
    await this.saveAll();
    return { ok: true, message: results.join("\n") };
  }

  /** Get summary info for all stores (for the management dialog). */
  getStoreSummary() {
    const summary = [];
    for (const [name, store] of this._stores) {
      summary.push({
        category:    name,
        displayName: name.charAt(0).toUpperCase() + name.slice(1),
        recordCount: store.recordCount,
        byteSize:    store.byteSize,
      });
    }
    return summary;
  }

  // ── Private Utilities ─────────────────────────────────────

  _currentScene() {
    return canvas?.scene?.name ?? "";
  }

  /** Find a PC record by display name (for events that don't carry actorId). */
  _findPcByName(name) {
    if (!name) return null;
    // First try the pcs store
    const found = this.pcs.findByName(name);
    if (found) return found;
    // Try to look up the actor and create a record
    const actor = game.actors?.find(a => a.name === name && a.hasPlayerOwner);
    if (actor) return this.pcs.touchPc(actor.id, actor.name);
    return null;
  }

  /** Extract class string from an actor (system-agnostic). */
  _extractClass(actor) {
    try {
      const sys = actor.system;
      if (sys?.details?.class)         return sys.details.class;
      if (sys?.details?.biography?.class) return sys.details.biography.class;
      if (sys?.attributes?.class)      return sys.attributes.class;
      // dnd5e: classes object
      if (actor.items) {
        const classes = actor.items.filter(i => i.type === "class");
        if (classes.length) return classes.map(c => `${c.name} ${c.system?.levels ?? ""}`).join(" / ");
      }
    } catch (_) {}
    return "";
  }

  /** Extract level from an actor (system-agnostic). */
  _extractLevel(actor) {
    try {
      const sys = actor.system;
      if (sys?.details?.level != null)      return Number(sys.details.level) || 0;
      if (sys?.details?.cr != null)         return Number(sys.details.cr) || 0;
      if (sys?.attributes?.level != null)   return Number(sys.attributes.level) || 0;
    } catch (_) {}
    return 0;
  }

  // ── Save Scheduling ───────────────────────────────────────

  _scheduleSave(category) {
    if (this._saveTimers.has(category)) clearTimeout(this._saveTimers.get(category));
    this._saveTimers.set(category, setTimeout(() => {
      this._saveTimers.delete(category);
      this.saveCategory(category);
    }, SAVE_DEBOUNCE_MS));
  }

  _scheduleSaves(categories) {
    for (const cat of categories) this._scheduleSave(cat);
  }

  // ── Journal Folders (Hierarchical) ───────────────────────

  /** Get or create the top-level folder (auto-renames legacy "📖 ACE" if found). */
  async _getAceFolder() {
    let folder = game.folders?.find(
      f => f.type === "JournalEntry" && f.name === ACE_FOLDER_NAME && !f.folder
    );
    if (!folder) {
      // Check for legacy folder name and rename it
      folder = game.folders?.find(
        f => f.type === "JournalEntry" && f.name === ACE_FOLDER_LEGACY && !f.folder
      );
      if (folder) {
        await folder.update({ name: ACE_FOLDER_NAME });
        console.log(`${MODULE_ID} | Renamed journal folder "${ACE_FOLDER_LEGACY}" → "${ACE_FOLDER_NAME}"`);
      } else {
        folder = await Folder.create({
          name: ACE_FOLDER_NAME, type: "JournalEntry", color: "#c9a84c",
        });
      }
    }
    return folder;
  }

  /** Get or create a subfolder (auto-renames legacy "NPC"→"NPC Profiles" etc.). */
  async _getAceSubfolder(subName) {
    const parent = await this._getAceFolder();
    let sub = game.folders?.find(
      f => f.type === "JournalEntry" && f.name === subName && f.folder?.id === parent.id
    );
    if (!sub) {
      // Check for legacy short subfolder names and rename them
      const legacyMap = { "NPC Profiles": "NPC", "PC Profiles": "PC", "World Lore": "World", "Session Logs": "Sessions" };
      const oldName = legacyMap[subName];
      if (oldName) {
        sub = game.folders?.find(
          f => f.type === "JournalEntry" && f.name === oldName && f.folder?.id === parent.id
        );
        if (sub) {
          await sub.update({ name: subName });
          console.log(`${MODULE_ID} | Renamed subfolder "${oldName}" → "${subName}"`);
        }
      }
      if (!sub) {
        sub = await Folder.create({
          name: subName, type: "JournalEntry", folder: parent.id,
          color: subName === ACE_SUB_NPC      ? "#8b4513"
               : subName === ACE_SUB_PC       ? "#2e6f9e"
               : subName === ACE_SUB_WORLD    ? "#6b4c9a"
               : subName === ACE_SUB_SESSIONS ? "#3a7d44"
               : "#c9a84c",
        });
      }
    }
    return sub;
  }

  /**
   * Get or create an individual journal entry inside a subfolder.
   * Each entry has a single "Memory" page that gets replaced on update.
   */
  async _getOrCreateJournal(subfolder, journalName) {
    let journal = game.journal?.find(
      j => j.name === journalName && j.folder?.id === subfolder.id
    );
    if (!journal) {
      journal = await JournalEntry.create({
        name: journalName, folder: subfolder.id,
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
      });
    }
    return journal;
  }

  /**
   * Write (create or update) a single page in a journal entry.
   * If the page already exists it is updated; otherwise it is created.
   */
  async _upsertJournalPage(journal, pageName, htmlContent) {
    let page = journal.pages?.find(p => p.name === pageName);
    if (page) {
      await page.update({ "text.content": htmlContent });
    } else {
      await journal.createEmbeddedDocuments("JournalEntryPage", [{
        name: pageName, type: "text", text: { content: htmlContent },
      }]);
    }
  }

  // ── NPC Journals (individual per NPC) ──────────────────────

  /**
   * Write an NPC journal — one journal entry per NPC in the ACE / NPC / subfolder.
   * Content is the compiled NPC record (scenes, notes, status, relationships).
   * @param {string} npcName - Display name of the NPC
   * @param {string} [content] - Optional raw content override. If omitted, auto-generates from store.
   */
  /**
   * Check if an NPC qualifies for a sidebar journal entry.
   * Criteria: linked actor in this world, OR 2+ encounters, OR among the 20 most recent.
   */
  _isNpcJournalWorthy(npcName) {
    const rec = this.npcs.getRecord(npcName);
    if (!rec) return false;

    // Linked actors always qualify
    if (rec.actorId) {
      const actor = game.actors?.get(rec.actorId);
      if (actor?.prototypeToken?.actorLink) return true;
    }
    // Also check by name — some linked actors might not have actorId stored
    const actorByName = game.actors?.find(a => a.name === rec.displayName && a.prototypeToken?.actorLink);
    if (actorByName) return true;

    // 2+ encounters always qualify
    if ((rec.met ?? 0) >= 2) return true;

    // Check if among the 20 most recent NPCs (by lastSeen timestamp)
    const allNpcs = this.npcs.getAll()
      .filter(r => r.displayName)
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    const top20 = allNpcs.slice(0, 20);
    return top20.some(r => r.displayName?.toLowerCase() === rec.displayName?.toLowerCase());
  }

  async writeNpcJournal(npcName, content) {
    // Only write to sidebar journal if this NPC qualifies
    // (All NPC data is always kept in ace-npcs.json regardless)
    // Per-NPC logs intentionally removed — full sync emits ONE summary
    // "Journal sync complete — N entries" line at the end. The 500+ debug
    // lines per world load were drowning out real warnings/errors. Errors
    // (try/catch below) still log so genuine failures aren't lost.
    if (!content && !this._isNpcJournalWorthy(npcName)) {
      return;
    }

    try {
      const folder = await this._getAceSubfolder(ACE_SUB_NPC);
      const journal = await this._getOrCreateJournal(folder, npcName);

      let htmlContent;
      if (content) {
        htmlContent = `<div>${content.replace(/\n/g, "<br>")}</div>`;
      } else {
        htmlContent = this._buildNpcHtml(npcName);
      }

      await this._upsertJournalPage(journal, "Memory", htmlContent);
    } catch (err) {
      console.error(`${MODULE_ID} | writeNpcJournal failed for "${npcName}":`, err);
    }
  }

  /**
   * Clean up NPC journal entries that no longer qualify for the sidebar.
   * Removes journals for NPCs that aren't linked, have < 2 encounters,
   * and aren't in the top 20 most recent. Data stays in ace-npcs.json.
   */
  async pruneNpcJournals() {
    try {
      const folder = await this._getAceSubfolder(ACE_SUB_NPC);
      const journals = game.journal?.filter(j => j.folder?.id === folder.id) ?? [];
      let removed = 0;

      for (const journal of journals) {
        if (!this._isNpcJournalWorthy(journal.name)) {
          await journal.delete();
          removed++;
        }
      }

      if (removed > 0) {
        console.log(`${MODULE_ID} | Pruned ${removed} NPC journal(s) from sidebar (data preserved in JSON).`);
      }
      return removed;
    } catch (err) {
      console.error(`${MODULE_ID} | pruneNpcJournals failed:`, err);
      return 0;
    }
  }

  /** HTML-escape a string to prevent XSS in journal pages. */
  _esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** Build rich HTML for an NPC from its store record. */
  _buildNpcHtml(npcName) {
    const rec = this.npcs.getRecord(npcName);
    if (!rec) return `<div><p>No data recorded for ${this._esc(npcName)}.</p></div>`;

    const e = (s) => this._esc(s);
    const lines = [];
    lines.push(`<h2>${e(rec.displayName)}</h2>`);

    // Status line
    const status = rec.killed
      ? `<strong style="color:#c0392b;">Killed</strong>${rec.killedBy ? ` by ${e(rec.killedBy)}` : ""}`
      : `<strong style="color:#27ae60;">Alive</strong>`;
    lines.push(`<p><b>Status:</b> ${status}</p>`);

    // Basic info
    if (rec.race || rec.class) {
      lines.push(`<p><b>Race/Class:</b> ${e([rec.race, rec.class].filter(Boolean).join(" / ") || "Unknown")}</p>`);
    }
    lines.push(`<p><b>Encounters:</b> ${rec.met ?? 0} &nbsp; | &nbsp; <b>First seen:</b> ${rec.firstSeen ? new Date(rec.firstSeen * 1000).toLocaleDateString() : "?"} &nbsp; | &nbsp; <b>Last seen:</b> ${rec.lastSeen ? new Date(rec.lastSeen * 1000).toLocaleDateString() : "?"}</p>`);

    // Scenes
    if (rec.scenes?.length) {
      lines.push(`<h3>Scenes</h3><ul>${rec.scenes.map(s => `<li>${e(s)}</li>`).join("")}</ul>`);
    }

    // Notes
    if (rec.notes?.length) {
      lines.push(`<h3>Notes</h3><ul>`);
      for (const n of rec.notes) {
        const date = n.t ? new Date(n.t * 1000).toLocaleDateString() : "";
        lines.push(`<li><em>${date}</em> — ${e(n.txt)}</li>`);
      }
      lines.push(`</ul>`);
    }

    // Relationships
    const rels = Object.entries(rec.relationships ?? {});
    if (rels.length) {
      lines.push(`<h3>Relationships</h3><ul>`);
      for (const [name, info] of rels) {
        lines.push(`<li><b>${e(name)}</b>: ${e(typeof info === "string" ? info : JSON.stringify(info))}</li>`);
      }
      lines.push(`</ul>`);
    }

    return `<div>${lines.join("\n")}</div>`;
  }

  // ── PC Journals (individual per PC) ────────────────────────

  /**
   * Write a PC journal — one journal entry per PC in the ACE / PC / subfolder.
   * Auto-generates content from the PC store.
   * @param {string} actorId - Foundry actor ID
   * @param {string} [content] - Optional raw content override.
   */
  async writePcJournal(actorId, content) {
    try {
      const rec = this.pcs.getRecord(actorId);
      const displayName = rec?.displayName ?? game.actors?.get(actorId)?.name ?? actorId;
      const folder = await this._getAceSubfolder(ACE_SUB_PC);
      const journal = await this._getOrCreateJournal(folder, displayName);

      let htmlContent;
      if (content) {
        htmlContent = `<div>${content.replace(/\n/g, "<br>")}</div>`;
      } else {
        htmlContent = this._buildPcHtml(actorId);
      }

      await this._upsertJournalPage(journal, "Memory", htmlContent);
      // Per-PC log removed — full sync emits one summary at the end.
    } catch (err) {
      console.error(`${MODULE_ID} | writePcJournal failed:`, err);
    }
  }

  /** Build rich HTML for a PC from its store record. */
  _buildPcHtml(actorId) {
    const rec = this.pcs.getRecord(actorId);
    if (!rec) return `<div><p>No data recorded for this character.</p></div>`;

    const lines = [];
    lines.push(`<h2>${rec.displayName}</h2>`);

    // Stats
    if (rec.class || rec.level) {
      lines.push(`<p><b>Class:</b> ${rec.class || "?"} &nbsp; | &nbsp; <b>Level:</b> ${rec.level || "?"}</p>`);
    }
    // Combat stats
    lines.push(`<h3>⚔️ Combat Career</h3>`);
    lines.push(`<p><b>Hits:</b> ${rec.hits ?? 0} &nbsp; | &nbsp; <b>Misses:</b> ${rec.misses ?? 0} &nbsp; | &nbsp; <b>Accuracy:</b> ${(rec.hits ?? 0) + (rec.misses ?? 0) > 0 ? Math.round(((rec.hits ?? 0) / ((rec.hits ?? 0) + (rec.misses ?? 0))) * 100) : 0}%</p>`);
    lines.push(`<p><b>Damage Dealt:</b> ${rec.damageDealt ?? 0} HP &nbsp; | &nbsp; <b>Highest Single Hit:</b> ${rec.highestHit ?? 0} HP</p>`);
    lines.push(`<p><b>Damage Taken:</b> ${rec.damageTaken ?? 0} HP &nbsp; | &nbsp; <b>Healing Done:</b> ${rec.healingDone ?? 0} HP</p>`);
    lines.push(`<p><b>Kills:</b> ${rec.kills ?? 0} &nbsp; | &nbsp; <b>Crits:</b> ${rec.crits ?? 0} &nbsp; | &nbsp; <b>Fumbles:</b> ${rec.fumbles ?? 0}</p>`);
    lines.push(`<p><b>Times KO'd:</b> ${rec.timesKO ?? 0} &nbsp; | &nbsp; <b>Deaths:</b> ${rec.deaths ?? 0} &nbsp; | &nbsp; <b>Death Saves:</b> ${rec.deathSavePass ?? 0}✓ / ${rec.deathSaveFail ?? 0}✗</p>`);
    lines.push(`<p><b>Sessions:</b> ${rec.sessions ?? 0} &nbsp; | &nbsp; <b>First seen:</b> ${rec.firstSeen ? new Date(rec.firstSeen * 1000).toLocaleDateString() : "?"} &nbsp; | &nbsp; <b>Last seen:</b> ${rec.lastSeen ? new Date(rec.lastSeen * 1000).toLocaleDateString() : "?"}</p>`);

    // Scenes
    if (rec.scenes?.length) {
      lines.push(`<h3>Scenes Visited</h3><ul>${rec.scenes.map(s => `<li>${s}</li>`).join("")}</ul>`);
    }

    // Milestones
    if (rec.milestones?.length) {
      lines.push(`<h3>Milestones</h3><ul>`);
      for (const m of rec.milestones) {
        const date = m.t ? new Date(m.t * 1000).toLocaleDateString() : "";
        lines.push(`<li><em>${date}</em> — ${m.txt ?? m.type ?? "milestone"}</li>`);
      }
      lines.push(`</ul>`);
    }

    // Notes
    if (rec.notes?.length) {
      lines.push(`<h3>Notes</h3><ul>`);
      for (const n of rec.notes) {
        const date = n.t ? new Date(n.t * 1000).toLocaleDateString() : "";
        lines.push(`<li><em>${date}</em> — ${n.txt}</li>`);
      }
      lines.push(`</ul>`);
    }

    return `<div>${lines.join("\n")}</div>`;
  }

  // ── World Note Journals (individual entries) ───────────────

  /**
   * Write a World Note journal — one entry per note in the ACE / World / subfolder.
   * @param {string} content - The note text
   * @param {string} [title] - Optional title (defaults to timestamped "Note")
   */
  async writeWorldNoteJournal(content, title) {
    try {
      const folder  = await this._getAceSubfolder(ACE_SUB_WORLD);
      const noteName = title || `Note — ${new Date().toLocaleString()}`;
      const journal = await this._getOrCreateJournal(folder, noteName);
      const htmlContent = `<div>${content.replace(/\n/g, "<br>")}</div>`;
      await this._upsertJournalPage(journal, "Content", htmlContent);
      // Per-note log removed — full sync emits one summary at the end.
    } catch (err) {
      console.error(`${MODULE_ID} | writeWorldNoteJournal failed:`, err);
    }
  }

  // ── Session Journals (individual entries) ──────────────────

  async _writeSessionJournal(record) {
    try {
      const folder = await this._getAceSubfolder(ACE_SUB_SESSIONS);
      const journalName = `Session ${record.num} — ${record.date}`;
      const journal = await this._getOrCreateJournal(folder, journalName);

      const partyStr = record.party?.length ? `<p><b>Party:</b> ${record.party.join(", ")}</p>` : "";
      const sceneStr = record.scene ? `<p><b>Scene:</b> ${record.scene}</p>` : "";
      const htmlContent =
        `<div><h2>${journalName}</h2>${sceneStr}${partyStr}<hr>` +
        `<div>${record.summary.replace(/\n/g, "<br>")}</div></div>`;

      await this._upsertJournalPage(journal, "Summary", htmlContent);
      console.log(`${MODULE_ID} | Journal: wrote "${journalName}"`);
    } catch (err) {
      console.error(`${MODULE_ID} | _writeSessionJournal failed:`, err);
    }
  }

  // ── Bulk Journal Sync ──────────────────────────────────────

  /**
   * Sync ALL known memory records to individual journal entries.
   * Useful on first migration or manual re-sync from Memory Management dialog.
   */
  async syncAllJournals() {
    console.log(`${MODULE_ID} | Syncing all memory records to journals…`);
    let count = 0;

    // NPCs
    for (const rec of this.npcs.getAll()) {
      if (rec.displayName) {
        await this.writeNpcJournal(rec.displayName);
        count++;
      }
    }

    // PCs
    for (const rec of this.pcs.getAll()) {
      if (rec.actorId) {
        await this.writePcJournal(rec.actorId);
        count++;
      }
    }

    // World notes
    for (const note of (this.world._data.worldNotes ?? [])) {
      const title = note.scene
        ? `${note.scene} — ${new Date((note.t ?? 0) * 1000).toLocaleDateString()}`
        : `Note — ${new Date((note.t ?? 0) * 1000).toLocaleDateString()}`;
      const text = note.txt ?? note.text ?? "";
      if (text) {
        await this.writeWorldNoteJournal(text, title);
        count++;
      }
    }

    // Sessions
    for (const sess of (this.world._data.sessions ?? [])) {
      await this._writeSessionJournal(sess);
      count++;
    }

    // Prune NPC journals that no longer qualify for the sidebar
    const pruned = await this.pruneNpcJournals();
    if (pruned) console.log(`${MODULE_ID} | Pruned ${pruned} old NPC journal(s) from sidebar.`);

    console.log(`${MODULE_ID} | Journal sync complete — ${count} entries written.`);
    return count;
  }
}
