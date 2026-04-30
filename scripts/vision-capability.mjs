// ─── ACE: Engine — Vision Capability Detection ───────────────────────────
// Determines whether the configured AI model can interpret images. Bio
// generation passes the NPC portrait to the AI for gender/age/ethnicity
// matching — but if the model can't see images, that prompt is wasted and
// the bio defaults to the random-name pool's gender. We warn the user when
// they're configured this way so they can switch models.

const MODULE_ID = "ace-engine";

// ── Cloud-provider vision allowlist ───────────────────────────────────────
// Keep this list in sync with provider docs. Models not listed are assumed
// non-vision. False negatives are the safer side — we'll just show an
// occasional warning that the user can dismiss; a false positive would
// silently waste tokens on an image the model can't read.
const CLOUD_VISION_MODELS = {
    openai: [
        /^gpt-4o(-mini)?$/i,
        /^gpt-4o-/i,
        /^gpt-4-turbo/i,                 // GPT-4 Turbo with Vision
        /^gpt-4\.1/i,                    // 4.1 family (vision-capable)
        /^o1-/i,                         // o1-vision variants
        /^o3-/i,                         // o3-vision variants
    ],
    anthropic: [
        /^claude-3/i,                    // all Claude 3.x have vision
        /^claude-sonnet-4/i,             // Sonnet 4 family
        /^claude-haiku-4/i,              // Haiku 4.5 family
        /^claude-opus-4/i,               // Opus 4 family
    ],
    openrouter: [
        // Most OpenRouter routings to vision-capable models. The model name
        // includes the provider prefix (e.g. "openai/gpt-4o").
        /vision/i,
        /\/gpt-4o/i,
        /\/gpt-4\.1/i,
        /\/claude-sonnet-4/i,
        /\/claude-haiku-4/i,
        /\/claude-opus-4/i,
        /\/claude-3/i,
        /\/gemini-/i,                    // Gemini family supports vision
        /\/llama-3\.2-.*vision/i,
        /\/qwen.*-vl/i,
        /\/llava/i,
    ],
    custom: [],  // can't know — assume false, user will tell us
    lmstudio: [], // depends on what's loaded — also unknown
};

// ── Local vision-capable model name prefixes ──────────────────────────────
// Used as a fast offline check before hitting Ollama's /api/show endpoint.
// If the model name matches one of these, we skip the network call.
const LOCAL_VISION_PREFIXES = [
    "llava",            // llava, llava-llama3, llava-phi3, llava:13b, etc.
    "bakllava",
    "llama3.2-vision",
    "llama-3.2-vision",
    "qwen2-vl",
    "qwen2.5-vl",
    "moondream",
    "minicpm-v",
    "granite3.2-vision",
    "internvl",
];

/**
 * Decide whether the configured provider/model can see images.
 * For Ollama, optionally hits /api/show to confirm vision support — but
 * the prefix list above catches all common cases without a network call.
 *
 * @param {string} provider — "openai" | "anthropic" | "ollama" | etc.
 * @param {string} modelName
 * @param {object} [opts]
 * @param {string} [opts.apiUrl]   — required for Ollama /api/show fallback
 * @param {boolean} [opts.queryOllamaShow] — when true, hit /api/show to verify
 * @returns {Promise<boolean>}
 */
export async function isVisionCapable(provider, modelName, opts = {}) {
    if (!provider || !modelName) return false;

    // ── Cloud providers: regex match against allowlist ──
    if (CLOUD_VISION_MODELS[provider]) {
        return CLOUD_VISION_MODELS[provider].some(rx => rx.test(modelName));
    }

    // ── Ollama: check prefix list first, then optionally /api/show ──
    if (provider === "ollama") {
        const lower = modelName.toLowerCase();
        if (LOCAL_VISION_PREFIXES.some(p => lower.startsWith(p))) return true;

        if (opts.queryOllamaShow && opts.apiUrl) {
            try {
                const resp = await fetch(`${opts.apiUrl.replace(/\/$/, "")}/api/show`, {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify({ name: modelName }),
                    signal:  AbortSignal.timeout(5_000),
                });
                if (!resp.ok) return false;
                const data = await resp.json();
                // Ollama returns details with families like ["clip", "llama"] for
                // vision models. Also model_info may contain "<arch>.vision.*"
                // keys for some architectures.
                const families = data?.details?.families || [];
                if (families.some(f => /clip|vision/i.test(f))) return true;
                const modelInfo = data?.model_info || {};
                if (Object.keys(modelInfo).some(k => /vision/i.test(k))) return true;
            } catch (_) { /* unreachable / model not pulled — assume non-vision */ }
        }
        return false;
    }

    return false;
}

// Once-per-session guard so users don't get spammed if 30 NPCs drop in a row.
let _visionWarningShownThisSession = false;

/**
 * Show a one-time toast warning the user that bio generation is happening
 * on a model that can't see portraits. Includes the suggested fix.
 */
export function warnVisionUnavailable(provider, modelName) {
    if (_visionWarningShownThisSession) return;
    _visionWarningShownThisSession = true;

    const suggestion = provider === "ollama"
        ? `Run <code>ollama pull llama3.2-vision</code> and switch to it in ACE Engine settings.`
        : `Switch to a vision-capable model (GPT-4o, Claude Sonnet 4, Claude Haiku 4.5).`;

    ui.notifications?.warn(
        `ACE Engine — current model "${modelName}" can't see portraits. NPC bio gender will be random unless you fix this. ${suggestion.replace(/<\/?code>/g, '')}`,
        { permanent: false }
    );
}

/** Reset the once-per-session guard (e.g. after user changes model). */
export function resetVisionWarning() {
    _visionWarningShownThisSession = false;
}
