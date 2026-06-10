// ─── ACE: Engine — World-Event Ledger ────────────────────────────────────────
// The ONE canonical record of "what happened in the world." Every significant
// event is written here exactly once; Fame, Reputation, and (later) faction
// propagation all READ from this single store instead of keeping their own copies.
//
// Persistence mirrors reputation-engine exactly: on-disk JSON under the world
// folder, GM-guarded, dirty-flagged, saved via the shared silent uploader.
//   worlds/{worldId}/ace-engine/ace-world-events.json
//
// An event is the TRUTH and never changes once recorded. How far it travels and
// what each faction comes to believe about it is computed downstream (Step 2+).

import {
  MAGNITUDE, normalizeMagnitude, magnitudeRank, meetsRippleFloor,
} from "./magnitude.mjs";
import { silentUpload as _silentUpload } from "./silent-upload.mjs";
import { requestSync } from "./memory-sync-engine.mjs";

const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | WorldEvents";

const LEDGER_DIR  = (worldId) => `worlds/${worldId}/ace-engine`;
const LEDGER_FILE = "ace-world-events.json";

const MAX_EVENTS  = 1000;   // safety cap; prune trivial-first, then oldest
const DATA_VERSION = 1;

// v13-safe FilePicker access (matches reputation-engine).
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ??
  globalThis.FilePicker;

/** Build an empty ledger structure. */
function _emptyData(worldId) {
  return {
    meta: {
      worldId,
      savedAt: new Date().toISOString(),
      version: DATA_VERSION,
      migratedLegacy: false,   // set true once old deeds are folded in
    },
    events: [],
  };
}

export class WorldEventLedger {
  constructor() {
    this._data    = null;
    this._loaded  = false;
    this._dirty   = false;
    this._worldId = null;
  }

  // ── Persistence ─────────────────────────────────────────────

  /**
   * Load the ledger from disk for the given world. Creates an empty structure
   * if the file does not exist yet (first-time worlds print no 404).
   * @param {string} worldId
   */
  async load(worldId) {
    this._worldId = worldId;
    const dir  = LEDGER_DIR(worldId);
    const path = `${dir}/${LEDGER_FILE}`;
    try {
      const FP = _FP();
      let exists = false;
      try {
        const listing = await FP.browse("data", dir);
        exists = (listing?.files ?? []).some(f => f.endsWith(LEDGER_FILE));
      } catch (_) { /* dir doesn't exist yet */ }
      if (!exists) throw new Error("HTTP 404");

      const response = await fetch(`/${path}?_=${Date.now()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();

      this._data = json;
      this._data.meta          ??= { worldId, version: DATA_VERSION };
      this._data.meta.worldId   = worldId;
      this._data.events         = Array.isArray(this._data.events) ? this._data.events : [];
      this._loaded = true;
      console.debug(`${TAG} | loaded ${this._data.events.length} events from ${path}`);
    } catch (_) {
      this._data   = _emptyData(worldId);
      this._loaded = true;
      console.debug(`${TAG} | no ledger on disk yet — starting fresh`);
    }
    return this._data;
  }

  /**
   * Save the ledger to disk. No-ops if not dirty or the user is not the GM.
   * @param {string} [worldId]
   */
  async save(worldId = this._worldId) {
    if (!this._dirty)      return;
    if (!game.user?.isGM)  return;
    if (!this._data || !worldId) return;

    this._data.meta.savedAt = new Date().toISOString();

    const dir  = LEDGER_DIR(worldId);
    const json = JSON.stringify(this._data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const file = new File([blob], LEDGER_FILE, { type: "application/json" });

    try {
      try {
        await _FP().createDirectory("data", dir, { notify: false });
      } catch (_) { /* directory already exists */ }

      await _silentUpload("data", dir, file);
      this._dirty = false;
      console.log(`${TAG} | saved ${this._data.events.length} events to ${dir}/${LEDGER_FILE}`);
      // Nudge the triple-backup mirror so Tier 2 reflects the new ledger.
      try { requestSync(); } catch (_) { /* sync engine optional */ }
    } catch (err) {
      console.error(`${TAG} | save failed —`, err);
      throw err;
    }
  }

  /** Debounced self-save — coalesces a flurry of events into one upload. */
  _scheduleSave(delay = 2000) {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save(this._worldId).catch(e => console.warn(`${TAG} | scheduled save failed:`, e));
    }, delay);
  }

  /**
   * Write a one-time snapshot of the data being migrated, into the ledger dir,
   * so there's a safety net even though migration never alters the originals.
   * @param {string} worldId
   * @param {{fameDeeds:object[], reputationDeeds:object[]}} payload
   */
  async writeMigrationBackup(worldId, payload) {
    if (!game.user?.isGM || !worldId) return;
    const dir  = LEDGER_DIR(worldId);
    const json = JSON.stringify({ savedAt: new Date().toISOString(), ...payload }, null, 2);
    const file = new File([new Blob([json], { type: "application/json" })],
                          "ace-pre-ledger-backup.json", { type: "application/json" });
    try {
      try { await _FP().createDirectory("data", dir, { notify: false }); } catch (_) { /* exists */ }
      await _silentUpload("data", dir, file);
      console.log(`${TAG} | wrote pre-ledger backup to ${dir}/ace-pre-ledger-backup.json`);
    } catch (err) {
      console.warn(`${TAG} | backup write failed (non-fatal):`, err);
    }
  }

  get loaded() { return this._loaded; }
  get dirty()  { return this._dirty; }

  // ── Recording ───────────────────────────────────────────────

  /**
   * Record one canonical world event (the truth). Deduplicates against recent
   * identical entries. Returns the stored record, or null if skipped.
   *
   * @param {object} e
   * @param {string}  e.summary            — the truth, 1-2 sentences
   * @param {string}  [e.magnitude]        — canonical tier (normalized if legacy)
   * @param {string}  [e.source]           — e.g. "auto:kill", "manual:gm"
   * @param {string}  [e.scene]            — where it happened
   * @param {string}  [e.victim]           — who/what was the subject
   * @param {string}  [e.location]         — named location (may differ from scene)
   * @param {string[]}[e.actors]           — who did it (usually PC names)
   * @param {Array}   [e.factions]         — involved faction ids or {id,name}
   * @param {number}  [e.ts]               — unix seconds (defaults to now)
   * @param {object}  [e.meta]             — anything extra (day, session, etc.)
   * @returns {object|null}
   */
  recordEvent(e = {}) {
    if (!this._data) return null;
    const summary = String(e.summary ?? "").trim();
    if (!summary) return null;

    const ts        = Number.isFinite(e.ts) ? e.ts : Math.floor(Date.now() / 1000);
    const magnitude = normalizeMagnitude(e.magnitude ?? MAGNITUDE.LOCAL);

    // Dedup: same normalized summary + same source within the recent tail.
    const norm = summary.toLowerCase();
    const src  = (e.source ?? "").toLowerCase();
    const tail = this._data.events.slice(-60);
    if (tail.some(x => (x.summary ?? "").toLowerCase() === norm && (x.source ?? "").toLowerCase() === src)) {
      return null;
    }

    const record = {
      id:        foundry.utils?.randomID?.() ?? `evt_${ts}_${Math.floor(Math.random() * 1e6)}`,
      ts,
      magnitude,
      ripples:   meetsRippleFloor(magnitude),   // false for trivial
      summary:   summary.slice(0, 400),
      source:    (e.source ?? "manual:gm").slice(0, 40),
      scene:     (e.scene ?? "").slice(0, 120),
      nouns: {
        victim:   e.victim ? String(e.victim).slice(0, 120) : "",
        location: (e.location ?? e.scene ?? "").slice(0, 120),
        actors:   Array.isArray(e.actors) ? e.actors.slice(0, 10).map(String) : [],
        factions: _normalizeFactions(e.factions),
      },
      meta: (e.meta && typeof e.meta === "object") ? e.meta : {},
    };

    this._data.events.push(record);
    this._pruneIfNeeded();
    this._dirty = true;
    console.log(`${TAG} | recorded [${magnitude}] "${record.summary}" (${record.source})`);
    this._scheduleSave();
    return record;
  }

  _pruneIfNeeded() {
    if (this._data.events.length <= MAX_EVENTS) return;
    // Drop the oldest trivial event; if none, drop the oldest event overall.
    const idx = this._data.events.findIndex(x => x.magnitude === MAGNITUDE.TRIVIAL);
    this._data.events.splice(idx !== -1 ? idx : 0, 1);
  }

  // ── Reads / queries ─────────────────────────────────────────

  /** All events (read-only). */
  getEvents() { return this._data?.events ?? []; }

  /** The N most recent events. */
  getRecent(n = 20) { return (this._data?.events ?? []).slice(-n); }

  /** Events that name a given faction id among their nouns. */
  getByFaction(factionId) {
    if (!factionId || !this._data) return [];
    return this._data.events.filter(x =>
      (x.nouns?.factions ?? []).some(f => (f?.id ?? f) === factionId));
  }

  /**
   * Filter events.
   * @param {object} [q]
   * @param {number} [q.sinceTs]       — only events at/after this unix time
   * @param {string} [q.minMagnitude]  — only events at/above this tier
   * @param {string} [q.source]        — exact source match
   * @param {string} [q.actor]         — events where this actor appears
   * @param {boolean}[q.ripplingOnly]  — exclude trivial (non-rippling) events
   */
  query(q = {}) {
    let out = this._data?.events ?? [];
    if (Number.isFinite(q.sinceTs)) out = out.filter(x => x.ts >= q.sinceTs);
    if (q.minMagnitude) {
      const min = magnitudeRank(q.minMagnitude);
      out = out.filter(x => magnitudeRank(x.magnitude) >= min);
    }
    if (q.source)       out = out.filter(x => x.source === q.source);
    if (q.ripplingOnly) out = out.filter(x => x.ripples);
    if (q.actor)        out = out.filter(x => (x.nouns?.actors ?? []).includes(q.actor));
    return out;
  }

  /** Count of events by magnitude tier. */
  getMagnitudeCounts() {
    const counts = { trivial: 0, local: 0, regional: 0, national: 0, continental: 0, legendary: 0 };
    for (const x of this._data?.events ?? []) {
      if (counts[x.magnitude] !== undefined) counts[x.magnitude]++;
    }
    return counts;
  }

  // ── Migration ───────────────────────────────────────────────

  /** True if the one-time legacy fold-in has already run. */
  get migrated() { return !!this._data?.meta?.migratedLegacy; }

  /**
   * Fold legacy Fame deeds + Reputation deeds into the ledger as historical
   * events, mapping their old magnitudes onto the canonical scale. Idempotent:
   * marks meta.migratedLegacy so it runs only once. Returns the import count.
   * @param {object} src
   * @param {object[]} [src.fameDeeds]        — from DeedStore.getDeeds()
   * @param {object[]} [src.reputationDeeds]  — from ReputationEngine.deeds
   */
  importLegacy({ fameDeeds = [], reputationDeeds = [] } = {}) {
    if (!this._data) return 0;
    if (this._data.meta.migratedLegacy) return 0;

    const seen = new Set(this._data.events.map(x => (x.summary ?? "").toLowerCase()));
    let count = 0;

    const fold = (deed, source) => {
      const text = String(deed?.text ?? deed?.summary ?? "").trim();
      if (!text) return;
      const norm = text.toLowerCase();
      if (seen.has(norm)) return;
      seen.add(norm);
      this._data.events.push({
        id:        foundry.utils?.randomID?.() ?? `evt_legacy_${count}_${Math.floor(Math.random() * 1e6)}`,
        ts:        Number(deed.timestamp) || Math.floor(Date.now() / 1000),
        magnitude: normalizeMagnitude(deed.magnitude ?? deed.impact),
        ripples:   meetsRippleFloor(normalizeMagnitude(deed.magnitude ?? deed.impact)),
        summary:   text.slice(0, 400),
        source:    `migrated:${source}`,
        scene:     (deed.scene ?? deed.location ?? "").toString().slice(0, 120),
        nouns: {
          victim: "",
          location: (deed.location ?? deed.scene ?? "").toString().slice(0, 120),
          actors: Array.isArray(deed.pcs) ? deed.pcs.slice(0, 10).map(String) : [],
          factions: [],
        },
        meta: { migrated: true, legacyId: deed.id ?? null },
      });
      count++;
    };

    for (const d of fameDeeds)       fold(d, "fame");
    for (const d of reputationDeeds) fold(d, "reputation");

    // Keep chronological order after the bulk insert.
    this._data.events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    this._pruneToCap();

    this._data.meta.migratedLegacy = true;
    this._dirty = true;
    console.log(`${TAG} | migrated ${count} legacy deed(s) into the ledger`);
    return count;
  }

  _pruneToCap() {
    while (this._data.events.length > MAX_EVENTS) this._pruneIfNeeded();
  }
}

// ── helpers ───────────────────────────────────────────────────

function _normalizeFactions(factions) {
  if (!Array.isArray(factions)) return [];
  return factions.slice(0, 12).map(f => {
    if (f && typeof f === "object") return { id: f.id ?? "", name: f.name ?? "" };
    return { id: String(f), name: "" };
  }).filter(f => f.id || f.name);
}
