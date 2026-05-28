// ─── ACE: Engine — Remote Model Catalog ────────────────────────────────────
// Pulls a curated model catalog from the ACE GitHub repo daily so the
// in-module dropdowns + deprecation warnings stay current without
// requiring a module release every time a provider drops or sunsets a
// model.
//
// Fetch chain (most-fresh first):
//   1. Remote JSON on GitHub raw       (live, updated by maintainer)
//   2. Bundled JSON shipped in module  (snapshot at last release)
//   3. Hardcoded hints in model-catalog.mjs (ultimate fallback)
//
// All three are merged: the live catalog can add new providers/models;
// the bundled copy stays as the floor; existing dropdowns keep working
// even if both remote AND bundled JSON fail.

const MODULE_ID  = "ace-engine";
const REMOTE_URL = "https://raw.githubusercontent.com/Sereptus-777/ace-engine/main/model-catalog.json";
const BUNDLED_URL = `modules/${MODULE_ID}/model-catalog.json`;

const CACHE_SETTING_KEY  = "remoteCatalogCache";   // stores the last successful fetch
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;   // background re-fetch every 24h
const FETCH_TIMEOUT_MS    = 8_000;                 // 8s — fail fast, don't block startup

// In-memory copy. Loaded once per session, refreshed in the background.
let _liveCatalog    = null;
let _bundledCatalog = null;
let _refreshing     = false;

/**
 * Public: get the active catalog. Returns whichever is freshest available:
 * live → cached → bundled → null.
 * Synchronous after the first ready() call.
 */
export function getCatalog() {
    return _liveCatalog ?? _bundledCatalog ?? null;
}

/**
 * Public: look up a deprecation entry for a given model id.
 * Returns null if not deprecated, otherwise the deprecation record.
 *
 *   { id, providers[], sunsets, replacement, replacementProvider, reason }
 */
export function getDeprecationFor(modelId) {
    if (!modelId) return null;
    const cat = getCatalog();
    if (!cat?.deprecations?.length) return null;
    // modelId can be either "gpt-4o-mini" OR "openai:gpt-4o-mini" — strip
    // the "provider:" prefix before matching the deprecation list.
    const bare = String(modelId).includes(":")
        ? String(modelId).split(":").slice(1).join(":")
        : String(modelId);
    return cat.deprecations.find(d => d.id === bare) ?? null;
}

/**
 * Public: return the curated model entries for a given provider id, or [].
 * The catalog stores them in the same shape the model-catalog.mjs hint
 * maps expect: { id, label, hint, star, vision, tier }.
 */
export function getModelsForProvider(provider) {
    const cat = getCatalog();
    return cat?.providers?.[provider]?.models ?? [];
}

/**
 * Public: return the named preset record, or null. Used by the preset
 * picker UI (not yet implemented — schema is in place for it).
 */
export function getPreset(presetKey) {
    const cat = getCatalog();
    return cat?.presets?.[presetKey] ?? null;
}

/**
 * Public: list all preset keys for the UI to enumerate.
 */
export function listPresetKeys() {
    const cat = getCatalog();
    return cat?.presets ? Object.keys(cat.presets) : [];
}

/**
 * Public: explicitly refresh the catalog from the remote URL. Used by
 * the "Refresh Catalog" button in settings.
 * @returns {Promise<{ ok: boolean, source: string, updated?: string, error?: string }>}
 */
export async function refreshCatalog() {
    return _doFetchAndCache({ forceRemote: true });
}

/**
 * Called once on world ready. Loads the bundled JSON immediately (so the
 * dropdown has data even before any network call), then fires a background
 * remote fetch if the last fetch is older than REFRESH_INTERVAL_MS.
 */
export async function initRemoteCatalog() {
    // Always load the bundled copy first — it's our floor.
    _bundledCatalog = await _fetchJSON(BUNDLED_URL).catch(err => {
        console.warn(`${MODULE_ID} | bundled catalog missing/broken:`, err);
        return null;
    });

    // Restore the last cached remote fetch from world settings, so we have
    // something current even before this session's background fetch
    // completes.
    try {
        const cache = game.settings.get(MODULE_ID, CACHE_SETTING_KEY);
        if (cache?.catalog && cache?.fetchedAt) {
            _liveCatalog = cache.catalog;
        }
    } catch (_) { /* setting may not be registered yet — fine */ }

    // Decide whether to refresh.
    const lastFetch = _liveCatalog ? (await _readCachedFetchedAt()) : 0;
    const stale     = !lastFetch || (Date.now() - lastFetch) > REFRESH_INTERVAL_MS;
    const autoOn    = _readAutoUpdateSetting();
    if (stale && autoOn) {
        // Fire and forget — don't block world ready on the network.
        _doFetchAndCache({ forceRemote: false }).catch(err => {
            console.warn(`${MODULE_ID} | background catalog refresh failed:`, err);
        });
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────

async function _doFetchAndCache({ forceRemote }) {
    if (_refreshing) return { ok: false, source: "skipped", error: "already refreshing" };
    _refreshing = true;
    try {
        const remote = await _fetchJSON(REMOTE_URL);
        if (!remote || typeof remote !== "object") {
            return { ok: false, source: "remote", error: "empty or invalid JSON" };
        }
        // Schema sanity check — refuse to apply a wildly malformed catalog
        // that could blank out the dropdowns.
        if (!remote.providers || typeof remote.providers !== "object") {
            return { ok: false, source: "remote", error: "missing providers map" };
        }
        _liveCatalog = remote;
        try {
            await game.settings.set(MODULE_ID, CACHE_SETTING_KEY, {
                catalog:   remote,
                fetchedAt: Date.now(),
            });
        } catch (err) { console.debug(`${MODULE_ID} | remote catalog cache write failed:`, err); }
        console.log(`${MODULE_ID} | Remote model catalog updated (version ${remote.updated || "?"})`);
        return { ok: true, source: "remote", updated: remote.updated };
    } catch (err) {
        return { ok: false, source: "remote", error: String(err?.message ?? err) };
    } finally {
        _refreshing = false;
    }
}

async function _fetchJSON(url) {
    const resp = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache:  "no-cache",
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
}

async function _readCachedFetchedAt() {
    try {
        const cache = game.settings.get(MODULE_ID, CACHE_SETTING_KEY);
        return cache?.fetchedAt ?? 0;
    } catch (_) { return 0; }
}

function _readAutoUpdateSetting() {
    try { return !!game.settings.get(MODULE_ID, "autoUpdateCatalog"); }
    catch (_) { return true; }  // default ON if setting not registered yet
}
