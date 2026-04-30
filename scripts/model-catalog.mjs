// ─── ACE: Engine — Live Model Catalog ──────────────────────────────────────
// Each provider exposes a /models-style endpoint that returns its current
// catalog. We fetch from those endpoints so users see fresh model lists
// (including new releases) without needing a module update.
//
// Returned items have a uniform shape: { value, label, free, vision }.
// `free` = local model OR explicitly free-tier on a hosted provider.
// `vision` = best-effort flag based on naming heuristics; not guaranteed.
//
// Caching: results are cached in a world-scoped game setting with a
// timestamp. UI calls use the cached list if it's < 24h old. The
// "Refresh Model List" button forces a re-fetch.

const MODULE_ID = "ace-engine";

const CACHE_SETTING = "modelCatalogCache";  // registered lazily on first use
const CACHE_TTL_MS  = 24 * 60 * 60 * 1000;  // 24 hours

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch the model list for a provider. Uses cached data if fresh.
 * @param {string} provider — "openai" | "anthropic" | "ollama" | "openrouter" | "lmstudio" | "custom"
 * @param {object} opts
 * @param {string} [opts.apiKey]
 * @param {string} [opts.apiUrl]
 * @param {boolean} [opts.forceRefresh] — bypass cache
 * @returns {Promise<Array<{ value: string, label: string, free: boolean, vision: boolean }>>}
 */
export async function fetchModelsForProvider(provider, opts = {}) {
    if (!opts.forceRefresh) {
        const cached = _readCache(provider);
        if (cached) return cached;
    }

    let models = [];
    try {
        switch (provider) {
            case "ollama":     models = await _fetchOllamaModels(opts.apiUrl); break;
            case "lmstudio":   models = await _fetchLmStudioModels(opts.apiUrl); break;
            case "openai":     models = await _fetchOpenAIModels(opts.apiKey); break;
            case "anthropic":  models = await _fetchAnthropicModels(opts.apiKey); break;
            case "openrouter": models = await _fetchOpenRouterModels(); break;
            default:           models = []; break;
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | Model catalog fetch failed for ${provider}:`, err);
        return [];
    }

    if (models.length) _writeCache(provider, models);
    return models;
}

// ── Per-provider fetchers ────────────────────────────────────────────────

async function _fetchOllamaModels(apiUrl) {
    const url = `${(apiUrl || "http://localhost:11434").replace(/\/$/, "")}/api/tags`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) throw new Error(`Ollama /api/tags returned ${resp.status}`);
    const data = await resp.json();
    return (data.models ?? []).map(m => ({
        value:  m.name,
        label:  `${m.name} (${_formatBytes(m.size)})`,
        free:   true,                                          // all local models are free
        vision: _hasVisionPrefix(m.name),
    })).sort(_sortFreeFirst);
}

async function _fetchLmStudioModels(apiUrl) {
    const url = `${(apiUrl || "http://localhost:1234").replace(/\/$/, "")}/v1/models`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) throw new Error(`LM Studio /v1/models returned ${resp.status}`);
    const data = await resp.json();
    return (data.data ?? []).map(m => ({
        value:  m.id,
        label:  m.id,
        free:   true,
        vision: _hasVisionPrefix(m.id),
    }));
}

async function _fetchOpenAIModels(apiKey) {
    if (!apiKey) return _fallbackOpenAIModels();
    const resp = await fetch("https://api.openai.com/v1/models", {
        signal: AbortSignal.timeout(8_000),
        headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!resp.ok) {
        if (resp.status === 401) throw new Error("OpenAI: invalid API key");
        return _fallbackOpenAIModels();
    }
    const data = await resp.json();
    // Filter out non-chat models (embeddings, image gen, audio, deprecated etc.)
    const CHAT_RX = /^(gpt-4|gpt-3\.5|o1|o3|chatgpt)/i;
    const models = (data.data ?? [])
        .filter(m => CHAT_RX.test(m.id))
        .map(m => ({
            value:  m.id,
            label:  m.id,
            free:   false,
            vision: /gpt-4o|gpt-4-turbo|gpt-4\.1|o1|o3/i.test(m.id),
        }));
    return models.length ? models : _fallbackOpenAIModels();
}

async function _fetchAnthropicModels(apiKey) {
    if (!apiKey) return _fallbackAnthropicModels();
    try {
        const resp = await fetch("https://api.anthropic.com/v1/models", {
            signal: AbortSignal.timeout(8_000),
            headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "anthropic-dangerous-direct-browser-access": "true",
            },
        });
        if (!resp.ok) return _fallbackAnthropicModels();
        const data = await resp.json();
        return (data.data ?? []).map(m => ({
            value:  m.id,
            label:  m.display_name || m.id,
            free:   false,
            vision: /claude-3|claude-sonnet-4|claude-haiku-4|claude-opus-4/i.test(m.id),
        }));
    } catch (_) { return _fallbackAnthropicModels(); }
}

async function _fetchOpenRouterModels() {
    // OpenRouter's /models endpoint is public — no key needed
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
        signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`OpenRouter /models returned ${resp.status}`);
    const data = await resp.json();
    return (data.data ?? []).map(m => {
        const promptPrice = parseFloat(m?.pricing?.prompt ?? "0");
        const free = promptPrice === 0 || /:free$/i.test(m.id);
        const visionRx = /vision|gpt-4o|gpt-4\.1|claude-sonnet-4|claude-haiku-4|claude-opus-4|claude-3|gemini|llava|qwen.*-vl|llama-3\.2-.*vision/i;
        return {
            value:  m.id,
            label:  free ? `${m.name || m.id}  ·  FREE` : `${m.name || m.id}  ·  $${(promptPrice * 1_000_000).toFixed(2)}/M`,
            free,
            vision: visionRx.test(m.id),
        };
    }).sort(_sortFreeFirst);
}

// ── Static fallbacks (when no API key or fetch fails) ─────────────────────

function _fallbackOpenAIModels() {
    return [
        { value: "gpt-4o-mini",   label: "gpt-4o-mini  ·  cheap + fast",  free: false, vision: true },
        { value: "gpt-4o",        label: "gpt-4o  ·  best quality",       free: false, vision: true },
        { value: "gpt-4.1",       label: "gpt-4.1  ·  latest",            free: false, vision: true },
        { value: "gpt-4.1-mini",  label: "gpt-4.1-mini",                  free: false, vision: true },
        { value: "gpt-4.1-nano",  label: "gpt-4.1-nano  ·  cheapest",     free: false, vision: true },
    ];
}

function _fallbackAnthropicModels() {
    return [
        { value: "claude-sonnet-4-20250514",  label: "Claude Sonnet 4",       free: false, vision: true },
        { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5",      free: false, vision: true },
        { value: "claude-opus-4-20250514",    label: "Claude Opus 4",         free: false, vision: true },
        { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet",    free: false, vision: true },
        { value: "claude-3-5-haiku-20241022",  label: "Claude 3.5 Haiku",     free: false, vision: true },
    ];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _hasVisionPrefix(name) {
    const lower = String(name || "").toLowerCase();
    const PREFIXES = ["llava", "bakllava", "llama3.2-vision", "llama-3.2-vision",
                      "qwen2-vl", "qwen2.5-vl", "moondream", "minicpm-v",
                      "granite3.2-vision", "internvl"];
    return PREFIXES.some(p => lower.startsWith(p));
}

function _sortFreeFirst(a, b) {
    if (a.free !== b.free) return a.free ? -1 : 1;
    return a.value.localeCompare(b.value);
}

function _formatBytes(bytes) {
    if (!bytes || bytes < 0) return "?";
    const gb = bytes / (1024 ** 3);
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

// ── Cache I/O ────────────────────────────────────────────────────────────

function _readCache(provider) {
    try {
        const cache = game.settings.get(MODULE_ID, CACHE_SETTING) || {};
        const entry = cache[provider];
        if (!entry?.fetchedAt) return null;
        if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
        return entry.models;
    } catch (_) { return null; }
}

function _writeCache(provider, models) {
    try {
        const cache = game.settings.get(MODULE_ID, CACHE_SETTING) || {};
        cache[provider] = { models, fetchedAt: Date.now() };
        game.settings.set(MODULE_ID, CACHE_SETTING, cache);
    } catch (err) { console.debug(`${MODULE_ID} | model catalog cache write failed:`, err); }
}

/** Force-clear the cache (used by the Refresh Model List button) */
export function clearModelCatalogCache() {
    try { game.settings.set(MODULE_ID, CACHE_SETTING, {}); } catch (_) {}
}
