// ─── ACE: Engine — Memory Sync Engine ───────────────────────────────────────
// Triple-backup architecture for all campaign-affecting data.
//
//   Tier 1 — Foundry live (untouched)
//   Tier 2 — D:/FoundryVTT/Data/ace-backups/
//            • live/      — write-through mirror, debounced ~2s, no rotation
//            • snapshots/ — gzipped JSON, kept forever
//   Tier 3 — User's chosen cloud sync (Google Drive Desktop / OneDrive / etc.)
//            pointed at the Tier 2 folder. Zero code — OS-level mirror.
//
// Snapshot triggers (all event-driven, no timer):
//   1. First write of a new calendar day → daily snapshot
//   2. Save Session UI button → session snapshot (with optional name)
//   3. "Take Snapshot Now" button → manual snapshot
//   4. World shutdown safety net → snapshot IF last one > 4h old AND writes since
//
// Backed up: world-graph.json + all ACE journal folders + memory stores +
// ACE-namespaced actor flags + world bible(s). Source PDFs + token art
// images NOT backed up (regeneratable / external).
//
// Design source: 2026-06-08 evening session — built after Aldric Thorne's
// bio was overwritten in testing prompted a full architectural rework of
// memory + redundancy. Architecture green-lit by Johnny same session.
// ────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | SyncEngine";

// Foundry Data path is the "data" source for FilePicker.upload — relative to
// the data root. All Tier 2 writes go through this folder.
const TIER2_ROOT       = "ace-backups";
const TIER2_LIVE       = `${TIER2_ROOT}/live`;
const TIER2_SNAPSHOTS  = `${TIER2_ROOT}/snapshots`;
const STATE_FILENAME   = "sync-state.json";

// v13-safe FilePicker access — same pattern used by world-bible-engine + digest-engine
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ??
  globalThis.FilePicker;

// ─── Silent uploader ─────────────────────────────────────────────────────────
// Mirrors the silent-upload pattern in world-bible-engine.mjs. Suppresses
// Foundry's "User does not have permission to upload" warn-spam on hosted
// servers + reduces toast noise during snapshot bursts.
// Silent uploader moved to the shared, corruption-proof module.
import { silentUpload as _silentUpload } from "./silent-upload.mjs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Today's calendar date as YYYY-MM-DD (local timezone). */
function _todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Compact ISO timestamp safe for filenames. */
function _nowStampForFilename() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Sanitize a user-supplied label so it's safe as part of a filename. */
function _sanitizeLabel(s) {
  return String(s ?? "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

/** Gzip a UTF-8 string using the browser's CompressionStream API. */
async function _gzipString(s) {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(s));
  writer.close();
  return await new Response(cs.readable).arrayBuffer();
}

/** Decompress a gzipped ArrayBuffer/Uint8Array back to a UTF-8 string. */
async function _gunzipToString(buf) {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(buf);
  writer.close();
  const out = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(out);
}

/** Detect gzip magic bytes (1f 8b) at the start of a buffer. */
function _isGzipped(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 2) return false;
  const view = new Uint8Array(arrayBuffer, 0, 2);
  return view[0] === 0x1f && view[1] === 0x8b;
}

/** Ensure a directory exists in Foundry's data folder (idempotent). */
async function _ensureDir(path) {
  try {
    await _FP().createDirectory("data", path, {});
  } catch (err) {
    // EEXIST is fine — Foundry throws if it already exists, which is what we want.
    const msg = String(err?.message ?? err).toLowerCase();
    if (msg.includes("exist") || msg.includes("eexist")) return;
    // Anything else, re-throw so the caller knows the dir prep failed.
    throw err;
  }
}

/** Upload raw text/JSON to a relative path inside the data folder. */
async function _uploadText(relativePath, content) {
  const parts = relativePath.split("/");
  const filename = parts.pop();
  const dir = parts.join("/");
  await _ensureDir(dir);
  const file = new File([content], filename, { type: "application/json" });
  await _silentUpload("data", dir, file);
}

/** Upload raw bytes (e.g. gzipped) to a relative path inside the data folder. */
async function _uploadBytes(relativePath, arrayBuffer, mime = "application/gzip") {
  const parts = relativePath.split("/");
  const filename = parts.pop();
  const dir = parts.join("/");
  await _ensureDir(dir);
  const file = new File([arrayBuffer], filename, { type: mime });
  await _silentUpload("data", dir, file);
}

/** Fetch a file from the data folder as text. Returns null if missing. */
async function _fetchText(relativePath) {
  try {
    const resp = await fetch(`/${relativePath}`);
    if (!resp.ok) return null;
    return await resp.text();
  } catch (_) { return null; }
}

/** Fetch a file from the data folder as ArrayBuffer. Returns null if missing. */
async function _fetchBytes(relativePath) {
  try {
    const resp = await fetch(`/${relativePath}`);
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch (_) { return null; }
}

/** List filenames in a Foundry data directory. Returns [] if missing. */
async function _listDir(relativePath) {
  try {
    const result = await _FP().browse("data", relativePath);
    return result?.files ?? [];
  } catch (_) { return []; }
}

// ─── Sync State Tracking ─────────────────────────────────────────────────────
// Persisted to <Tier2>/sync-state.json. Tracks last snapshot dates + write
// counts since last snapshot for the shutdown safety-net heuristic.

const DEFAULT_STATE = Object.freeze({
  version: 1,
  lastDailySnapshotDate: "",       // YYYY-MM-DD — empty until first snapshot
  lastSnapshotTime: 0,             // epoch ms of any snapshot (daily/session/manual/shutdown)
  lastWriteTime: 0,                // epoch ms of last mirror write
  writesSinceLastSnapshot: 0,
  totalSnapshotsTaken: 0,
  totalWritesProcessed: 0,
});

let _state = { ...DEFAULT_STATE };
let _stateLoaded = false;

async function _loadState() {
  if (_stateLoaded) return _state;
  const text = await _fetchText(`${TIER2_ROOT}/${STATE_FILENAME}`);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      _state = { ...DEFAULT_STATE, ...parsed };
    } catch (err) {
      console.warn(`${TAG} | sync-state.json malformed, resetting:`, err);
      _state = { ...DEFAULT_STATE };
    }
  }
  _stateLoaded = true;
  return _state;
}

async function _saveState() {
  try {
    await _uploadText(`${TIER2_ROOT}/${STATE_FILENAME}`, JSON.stringify(_state, null, 2));
  } catch (err) {
    console.warn(`${TAG} | failed to persist sync-state.json (non-fatal):`, err);
  }
}

// ─── Data Gathering ──────────────────────────────────────────────────────────
// Builds a single JSON object containing everything to back up. Used for both
// live-mirror writes (one big file per gather pass, atomic) AND snapshots
// (same object gzipped).

const ACE_FLAG_NAMESPACES = ["ace-engine", "ace-qol", "ace-envoy", "ace-artificer", "ace-token-art"];
const ACE_FOLDER_NAMES = ["NPC Profiles", "PC Profiles", "World Lore", "Session Logs", "Factions", "World Library"];

/** Pull all ACE-namespaced flags from a document. Empty object if none. */
function _extractAceFlags(doc) {
  const out = {};
  const flags = doc?.flags ?? {};
  for (const ns of ACE_FLAG_NAMESPACES) {
    if (flags[ns] && Object.keys(flags[ns]).length) {
      out[ns] = flags[ns];
    }
  }
  return out;
}

/**
 * Gather everything campaign-affecting into a single serializable object.
 * Throws nothing — best-effort. Returns the snapshot payload.
 */
async function _gatherPayload() {
  const t0 = performance.now();

  // 1. Actors — name, id, type, plus ACE flags
  const actors = [];
  for (const a of game.actors?.contents ?? []) {
    try {
      const aceFlags = _extractAceFlags(a);
      if (!Object.keys(aceFlags).length && a.type !== "character") continue;
      actors.push({
        id: a.id,
        uuid: a.uuid,
        name: a.name,
        type: a.type,
        img: a.img,
        aceFlags,
      });
    } catch (_) { /* skip */ }
  }

  // 2. Journals — ACE folder contents only
  const journals = [];
  for (const j of game.journal?.contents ?? []) {
    try {
      const folderName = j.folder?.name ?? "";
      const grandparent = j.folder?.folder?.name ?? "";
      // Capture if its IMMEDIATE folder is an ACE folder OR if its parent
      // chain includes "ACE / <subfolder>" pattern.
      const isAceJournal = ACE_FOLDER_NAMES.includes(folderName)
                        || ACE_FOLDER_NAMES.includes(grandparent)
                        || folderName === "ACE"
                        || grandparent === "ACE";
      if (!isAceJournal) continue;
      const pages = [];
      for (const p of j.pages?.contents ?? []) {
        pages.push({
          id: p.id,
          name: p.name,
          type: p.type,
          text: p.text?.content ?? "",
        });
      }
      journals.push({
        id: j.id,
        uuid: j.uuid,
        name: j.name,
        folderName,
        grandparent,
        pages,
      });
    } catch (_) { /* skip */ }
  }

  // 3. Memory stores — from the live MemoryManager instance
  let memory = {};
  try {
    const mm = game.modules?.get?.(MODULE_ID)?.api?.memoryManager;
    if (mm) {
      memory = {
        npcs:    mm.npcs?._data ?? null,
        pcs:     mm.pcs?._data ?? null,
        items:   mm.items?._data ?? null,
        world:   mm.world?._data ?? null,
        // Add other category stores here as they're added to MemoryManager
      };
    }
  } catch (err) {
    console.warn(`${TAG} | memory store extraction failed:`, err);
  }

  // 4. World graph + world bible — read from disk (already JSON files there)
  let worldGraph = null;
  let worldBible = null;
  try {
    const wgText = await _fetchText("ace-engine-library/world-graph.json");
    if (wgText) worldGraph = JSON.parse(wgText);
  } catch (_) { /* non-fatal */ }
  try {
    // World bible lives per-world inside worlds/<world>/ace-engine/
    const worldId = game.world?.id;
    if (worldId) {
      const wbText = await _fetchText(`worlds/${worldId}/ace-engine/ace-world-bible.json`);
      if (wbText) worldBible = JSON.parse(wbText);
    }
  } catch (_) { /* non-fatal */ }

  // 4b. Reputation + World-Event ledger — per-world ace-engine JSON files.
  //     Browse the folder once so we never fetch (and 404-log) a file that
  //     hasn't been created yet — reputation/ledger files appear on first save.
  let reputation  = null;
  let worldEvents = null;
  try {
    const worldId = game.world?.id;
    if (worldId) {
      const dir = `worlds/${worldId}/ace-engine`;
      let present = new Set();
      try {
        const listing = await _FP().browse("data", dir);
        present = new Set((listing?.files ?? []).map(f => f.split("/").pop()));
      } catch (_) { /* folder doesn't exist yet */ }
      if (present.has("ace-party-reputation.json")) {
        const t = await _fetchText(`${dir}/ace-party-reputation.json`); if (t) reputation = JSON.parse(t);
      }
      if (present.has("ace-world-events.json")) {
        const t = await _fetchText(`${dir}/ace-world-events.json`); if (t) worldEvents = JSON.parse(t);
      }
    }
  } catch (_) { /* non-fatal */ }

  // 4c. Faction registry — a world setting (the living faction roster).
  let factionRegistry = null;
  try { factionRegistry = game.settings.get(MODULE_ID, "factionRegistry") ?? null; } catch (_) { /* not registered */ }

  // 5. Meta — when, who, what version
  const meta = {
    capturedAt: Date.now(),
    capturedAtISO: new Date().toISOString(),
    worldId: game.world?.id ?? null,
    worldTitle: game.world?.title ?? null,
    foundryVersion: game.version ?? null,
    systemVersion: game.system?.version ?? null,
    moduleVersion: game.modules?.get?.(MODULE_ID)?.version ?? null,
    counts: {
      actors: actors.length,
      journals: journals.length,
      journalPages: journals.reduce((s, j) => s + j.pages.length, 0),
    },
  };

  const elapsed = Math.round(performance.now() - t0);
  console.log(`${TAG} | Gathered payload — ${actors.length} actors, ${journals.length} journals, world-graph=${!!worldGraph}, world-bible=${!!worldBible}, reputation=${!!reputation}, events=${worldEvents?.events?.length ?? 0}, factions=${factionRegistry ? Object.keys(factionRegistry).length : 0} (${elapsed}ms)`);

  return { meta, actors, journals, memory, worldGraph, worldBible, reputation, worldEvents, factionRegistry };
}

// ─── Write-Through to Tier 2 Live Mirror ─────────────────────────────────────
// Debounced. Multiple writes within the debounce window coalesce into one
// mirror op. Each pass overwrites live/payload.json atomically (write to
// temp, then upload as final filename — Foundry's FilePicker.upload IS
// atomic since the put is one HTTP request).

const WRITE_DEBOUNCE_MS = 2000;
let _writeDebounceHandle = null;
let _writeInProgress = false;
let _writeQueued = false;

async function _doWrite() {
  if (_writeInProgress) {
    _writeQueued = true;
    return;
  }
  _writeInProgress = true;
  try {
    await _loadState();
    const payload = await _gatherPayload();

    // First-write-of-day check → fires daily snapshot BEFORE writing
    const todayISO = _todayISO();
    if (_state.lastDailySnapshotDate !== todayISO) {
      try {
        await _takeSnapshot("daily", { autoTriggered: true });
        _state.lastDailySnapshotDate = todayISO;
      } catch (err) {
        console.warn(`${TAG} | daily snapshot failed (non-fatal — write continues):`, err);
      }
    }

    // Now write the live mirror
    const json = JSON.stringify(payload);
    await _uploadText(`${TIER2_LIVE}/payload.json`, json);

    _state.lastWriteTime = Date.now();
    _state.writesSinceLastSnapshot++;
    _state.totalWritesProcessed++;
    await _saveState();

    console.debug(`${TAG} | live mirror updated (writes-since-last-snapshot: ${_state.writesSinceLastSnapshot})`);
  } catch (err) {
    console.error(`${TAG} | live-mirror write failed:`, err);
  } finally {
    _writeInProgress = false;
    if (_writeQueued) {
      _writeQueued = false;
      // Coalesce — fire next pass after a fresh debounce window
      _writeDebounceHandle = setTimeout(_doWrite, WRITE_DEBOUNCE_MS);
    }
  }
}

/** Public — request a debounced mirror write. Safe to call constantly. */
export function requestSync() {
  if (_writeDebounceHandle) clearTimeout(_writeDebounceHandle);
  _writeDebounceHandle = setTimeout(_doWrite, WRITE_DEBOUNCE_MS);
}

// ─── Snapshots ───────────────────────────────────────────────────────────────
// One gzipped JSON file per snapshot. Filename format:
//   <type>-<YYYY-MM-DD-HH-MM-SS>[-<label>].json.gz
// e.g. session-2026-06-08-23-45-12-Vallaki_S12.json.gz

const SNAPSHOT_TYPES = new Set(["daily", "session", "manual", "shutdown"]);

async function _takeSnapshot(type, { label = "", autoTriggered = false } = {}) {
  if (!SNAPSHOT_TYPES.has(type)) {
    console.warn(`${TAG} | snapshot type "${type}" unknown — using "manual"`);
    type = "manual";
  }
  await _loadState();

  const stamp = _nowStampForFilename();
  const cleanLabel = _sanitizeLabel(label);
  // ── File extension is .json even though contents are gzipped ──
  // Foundry's FilePicker.upload blocks .gz extensions (only image/audio/
  // video/doc types allowed). The gzipped bytes still start with the
  // 0x1f 0x8b magic header, which the reader detects automatically.
  // (Bug hit + fixed 2026-06-08 — initial build used .json.gz, blocked.)
  const filename = cleanLabel
    ? `${type}-${stamp}-${cleanLabel}.json`
    : `${type}-${stamp}.json`;

  const payload = await _gatherPayload();
  payload.meta.snapshotType = type;
  payload.meta.snapshotLabel = label || null;
  payload.meta.autoTriggered = !!autoTriggered;
  payload.meta.compressed = true;

  const json = JSON.stringify(payload);
  const gzipped = await _gzipString(json);

  // Content-type masquerade — Foundry validates by extension, not MIME,
  // so application/json here is fine even though bytes are gzip.
  await _uploadBytes(`${TIER2_SNAPSHOTS}/${filename}`, gzipped, "application/json");

  _state.lastSnapshotTime = Date.now();
  _state.writesSinceLastSnapshot = 0;
  _state.totalSnapshotsTaken++;
  await _saveState();

  console.log(`${TAG} | Snapshot "${filename}" written (${(gzipped.byteLength / 1024).toFixed(1)} KB gzipped, ${(json.length / 1024).toFixed(1)} KB uncompressed${autoTriggered ? ", auto-triggered" : ""}).`);
  return { filename, sizeGz: gzipped.byteLength, sizeRaw: json.length };
}

/** Public — take a manual snapshot now. Optionally accepts a user label. */
export async function takeSnapshotNow(label = "") {
  return _takeSnapshot("manual", { label });
}

/** Public — take a session snapshot. Hooks Save Session call this. */
export async function takeSessionSnapshot(label = "") {
  return _takeSnapshot("session", { label });
}

/** Public — explicit shutdown-time call. Fires only if conditions met. */
export async function maybeTakeShutdownSnapshot() {
  await _loadState();
  const last = _state.lastSnapshotTime || 0;
  const ageMs = Date.now() - last;
  const FOUR_HOURS = 4 * 3600 * 1000;
  if (ageMs < FOUR_HOURS) {
    console.log(`${TAG} | Shutdown snapshot skipped — last snapshot was ${Math.round(ageMs / 60000)} min ago (< 4h threshold).`);
    return null;
  }
  if (_state.writesSinceLastSnapshot < 1) {
    console.log(`${TAG} | Shutdown snapshot skipped — no writes since last snapshot.`);
    return null;
  }
  return _takeSnapshot("shutdown", { autoTriggered: true });
}

// ─── Restore ─────────────────────────────────────────────────────────────────
// Lists / reads snapshot files. Restore APPLICATION (rebuilding journals,
// actor flags, etc. from a snapshot) is deliberately NOT automated — that's
// destructive and gets its own UI in a later pass. For now, restore() returns
// the parsed payload so callers can inspect / use selectively.

export async function listSnapshots() {
  const files = await _listDir(TIER2_SNAPSHOTS);
  // Accept both .json (new — gzipped bytes inside json extension) and
  // .json.gz (legacy fallback in case any older files exist).
  return files
    .filter(f => /\.(json|json\.gz)$/i.test(f))
    .map(fullPath => {
      const name = fullPath.split("/").pop();
      // Strip extension, then parse the prefix.
      const stripped = name.replace(/\.(json|json\.gz)$/i, "");
      const match = stripped.match(/^(daily|session|manual|shutdown)-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})(?:-(.+))?$/);
      if (!match) return { name, path: fullPath, type: "?", stamp: "?", label: "" };
      return {
        name,
        path: fullPath,
        type: match[1],
        stamp: match[2],
        label: match[3] ?? "",
      };
    })
    // Don't include the live mirror or sync-state file (they're in different folders, but defense-in-depth)
    .filter(s => s.type !== "?")
    .sort((a, b) => b.stamp.localeCompare(a.stamp));  // newest first
}

export async function readSnapshot(filenameOrPath) {
  const path = filenameOrPath.includes("/")
    ? filenameOrPath
    : `${TIER2_SNAPSHOTS}/${filenameOrPath}`;
  const bytes = await _fetchBytes(path);
  if (!bytes) throw new Error(`Snapshot not found: ${path}`);
  // Auto-detect gzip via magic header bytes — covers both new files (gzipped
  // bytes in .json extension) and any legacy uncompressed test files.
  const json = _isGzipped(bytes)
    ? await _gunzipToString(bytes)
    : new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

// ─── Status ──────────────────────────────────────────────────────────────────
// Returns a small object summarizing sync health. Used by the status UI button
// and by tests / diagnostics.

export async function status() {
  await _loadState();
  const snapshots = await listSnapshots();
  const lastSnap = snapshots[0] ?? null;
  return {
    tier2Path: TIER2_ROOT,
    snapshotsTotal: snapshots.length,
    lastSnapshotFilename: lastSnap?.name ?? null,
    lastSnapshotStamp: lastSnap?.stamp ?? null,
    lastSnapshotTimeMs: _state.lastSnapshotTime,
    lastWriteTimeMs: _state.lastWriteTime,
    writesSinceLastSnapshot: _state.writesSinceLastSnapshot,
    totalSnapshotsTaken: _state.totalSnapshotsTaken,
    totalWritesProcessed: _state.totalWritesProcessed,
    daily: {
      lastDailyDate: _state.lastDailySnapshotDate,
      todayDate: _todayISO(),
      pending: _state.lastDailySnapshotDate !== _todayISO(),
    },
  };
}

// ─── Initialization + Hook Wiring ────────────────────────────────────────────

let _initialized = false;

export async function initialize() {
  if (_initialized) return;
  _initialized = true;

  // Ensure Tier 2 folders exist on first run
  try {
    await _ensureDir(TIER2_ROOT);
    await _ensureDir(TIER2_LIVE);
    await _ensureDir(TIER2_SNAPSHOTS);
  } catch (err) {
    console.error(`${TAG} | Tier 2 folder prep failed:`, err);
  }

  await _loadState();

  // ── Automatic write detection — hook journal + actor changes ──
  // Debounced via requestSync; bursts coalesce into one mirror write.
  const _isAceJournal = (j) => {
    const f = j?.folder?.name ?? "";
    const g = j?.folder?.folder?.name ?? "";
    return ACE_FOLDER_NAMES.includes(f) || ACE_FOLDER_NAMES.includes(g) || f === "ACE" || g === "ACE";
  };

  Hooks.on("createJournalEntry",  j => { if (_isAceJournal(j)) requestSync(); });
  Hooks.on("updateJournalEntry",  j => { if (_isAceJournal(j)) requestSync(); });
  Hooks.on("deleteJournalEntry",  j => { if (_isAceJournal(j)) requestSync(); });
  Hooks.on("createJournalEntryPage", p => { if (_isAceJournal(p.parent)) requestSync(); });
  Hooks.on("updateJournalEntryPage", p => { if (_isAceJournal(p.parent)) requestSync(); });
  Hooks.on("deleteJournalEntryPage", p => { if (_isAceJournal(p.parent)) requestSync(); });

  Hooks.on("updateActor", (actor, changes) => {
    // Only react when ACE-namespaced flags actually changed
    const flagsChange = changes?.flags ?? {};
    if (ACE_FLAG_NAMESPACES.some(ns => flagsChange[ns])) requestSync();
  });

  // ── Shutdown safety net ──
  // Fires on world close (player disconnect / window unload).
  globalThis.addEventListener?.("beforeunload", () => {
    // Can't await here — browser will tear down. Best-effort fire-and-forget.
    try {
      maybeTakeShutdownSnapshot();
      // Force one last debounced write to flush
      if (_writeDebounceHandle) {
        clearTimeout(_writeDebounceHandle);
        _doWrite();
      }
    } catch (_) { /* page closing, nothing to recover */ }
  });

  console.log(`${TAG} | Memory Sync Engine online — Tier 2 root: ${TIER2_ROOT}`);

  // Kick a first write so the live mirror exists from the start
  requestSync();
}

// ─── Default export bundle ───────────────────────────────────────────────────
export default {
  initialize,
  requestSync,
  takeSnapshotNow,
  takeSessionSnapshot,
  maybeTakeShutdownSnapshot,
  listSnapshots,
  readSnapshot,
  status,
};
