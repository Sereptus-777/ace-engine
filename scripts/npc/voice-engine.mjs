// ─── ACE: Engine — Voice Engine ─────────────────────────────────────────────
// Intelligent voice assignment: race → accent, scene region → accent pool,
// creature type → voice personality, alignment → voice settings tuning.
// Uses ElevenLabs Shared Voice Library for massive, diverse voice pool.
//
// Moved from ace-envoy/src/voice-engine.js as part of the Envoy → Engine
// merger. Settings + flag namespaces translated ace-envoy.* → ace-engine.*.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-engine";

/** Read the ElevenLabs API key (client-scoped) from engine settings. */
function getElevenLabsKey() {
    try { return game.settings.get(MODULE_ID, "elevenLabsApiKey") || ""; }
    catch (_) { return ""; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFIGURATION TABLES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Race → accent override (highest priority after manual/named NPC).
 * Key = lowercase race/subrace keyword found in actor data.
 * Value = ElevenLabs accent label to search for.
 */
export const RACE_ACCENT_MAP = {
    // Dwarves
    "dwarf":            "scottish",
    "hill dwarf":       "scottish",
    "mountain dwarf":   "scottish",
    "duergar":          "scottish",

    // Elves
    "high elf":         "french",
    "sun elf":          "french",
    "moon elf":         "french",
    "wood elf":         "welsh",
    "wild elf":         "welsh",
    "drow":             "swedish",
    "dark elf":         "swedish",
    "eladrin":          "british",
    "sea elf":          "french",
    "shadar-kai":       "swedish",

    // Halflings
    "lightfoot halfling":  "irish",
    "lightfoot":           "irish",
    "halfling":            "irish",
    "stout halfling":      "british",

    // Gnomes
    "rock gnome":       "italian",
    "gnome":            "italian",
    "forest gnome":     "dutch",
    "deep gnome":       "german",
    "svirfneblin":      "german",

    // Tiefling — uses scene accent (chameleon), no override
    // "tiefling": null,

    // Goliath
    "goliath":          "swedish",

    // Orc / Half-Orc
    "orc":              "australian",
    "half-orc":         "australian",

    // Aasimar
    "aasimar":          "british",

    // Tabaxi
    "tabaxi":           "brazilian",

    // Firbolg
    "firbolg":          "irish",

    // Kenku — special: mimicry, no accent
    // "kenku": null,

    // Dragonborn
    "dragonborn":       "british",

    // Genasi
    "genasi":           "middle eastern",
    "fire genasi":      "middle eastern",
    "water genasi":     "middle eastern",
    "earth genasi":     "middle eastern",
    "air genasi":       "middle eastern",

    // Tortle
    "tortle":           "british",

    // Lizardfolk
    "lizardfolk":       "german",

    // Bugbear / Goblin / Hobgoblin
    "goblin":           "british",
    "hobgoblin":        "german",
    "bugbear":          "australian",
};

/**
 * Scene region → accent pool.
 * The first accent in each array is the dominant one (60% weight).
 * Remaining accents split the other 40%.
 */
export const REGION_ACCENT_MAP = {
    "barovia":      ["romanian", "ukrainian", "russian", "polish"],
    "ravenloft":    ["romanian", "ukrainian", "russian", "polish"],
    "sword_coast":  ["british", "irish", "australian"],
    "waterdeep":    ["british", "irish", "australian"],
    "baldurs_gate": ["british", "irish", "australian"],
    "calimshan":    ["middle eastern", "indian"],
    "chult":        ["african", "nigerian"],
    "kara_tur":     ["korean", "japanese", "chinese"],
    "icewind_dale": ["swedish", "norwegian", "danish"],
    "nordic":       ["swedish", "norwegian", "danish"],
    "underdark":    ["swedish", "german"],
    "default":      ["british", "irish", "australian"],
};

/**
 * Named NPC hardcoded overrides.
 * Key = lowercase actor name. Value = { accent, voiceSettings }.
 */
export const NAMED_NPC_OVERRIDES = {
    "strahd von zarovich": {
        accent: "romanian",
        voiceSettings: { stability: 0.7, similarity_boost: 0.85, style: 0.6 },
    },
    "strahd": {
        accent: "romanian",
        voiceSettings: { stability: 0.7, similarity_boost: 0.85, style: 0.6 },
    },
};

/**
 * Intelligent non-humanoid creature voice profiles.
 * These get a neutral-accent deep voice with tuned ElevenLabs settings.
 * Keyed by creature type or name keyword.
 */
export const CREATURE_VOICE_PROFILES = {
    // Dragons by color — keyed by name substring
    "red dragon":    { style: "commanding",   voiceSettings: { stability: 0.8, similarity_boost: 0.7, style: 0.8 } },
    "gold dragon":   { style: "commanding",   voiceSettings: { stability: 0.8, similarity_boost: 0.7, style: 0.8 } },
    "white dragon":  { style: "feral",        voiceSettings: { stability: 0.3, similarity_boost: 0.6, style: 0.2 } },
    "green dragon":  { style: "manipulative", voiceSettings: { stability: 0.7, similarity_boost: 0.8, style: 0.7 } },
    "black dragon":  { style: "cruel",        voiceSettings: { stability: 0.4, similarity_boost: 0.7, style: 0.5 } },
    "blue dragon":   { style: "authoritative",voiceSettings: { stability: 0.85, similarity_boost: 0.75, style: 0.6 } },

    // Generic dragon fallback (creature type)
    "dragon":        { style: "commanding",   voiceSettings: { stability: 0.7, similarity_boost: 0.7, style: 0.6 } },

    // Undead intelligents
    "lich":          { style: "ethereal",     voiceSettings: { stability: 0.9, similarity_boost: 0.4, style: 0.3 } },
    "vampire":       { style: "aristocratic", voiceSettings: { stability: 0.75, similarity_boost: 0.8, style: 0.6 } },
    "death knight":  { style: "commanding",   voiceSettings: { stability: 0.8, similarity_boost: 0.6, style: 0.4 } },
    "mummy lord":    { style: "ethereal",     voiceSettings: { stability: 0.85, similarity_boost: 0.5, style: 0.3 } },

    // Aberrations
    "beholder":      { style: "manic",        voiceSettings: { stability: 0.25, similarity_boost: 0.7, style: 0.9 } },
    "mind flayer":   { style: "clinical",     voiceSettings: { stability: 0.95, similarity_boost: 0.5, style: 0.1 } },
    "aboleth":       { style: "clinical",     voiceSettings: { stability: 0.9, similarity_boost: 0.4, style: 0.2 } },

    // Fiends
    "devil":         { style: "persuasive",   voiceSettings: { stability: 0.8, similarity_boost: 0.8, style: 0.7 } },
    "demon":         { style: "chaotic",      voiceSettings: { stability: 0.15, similarity_boost: 0.6, style: 0.9 } },
    "pit fiend":     { style: "commanding",   voiceSettings: { stability: 0.8, similarity_boost: 0.7, style: 0.7 } },
    "balor":         { style: "chaotic",      voiceSettings: { stability: 0.2, similarity_boost: 0.6, style: 0.8 } },

    // Celestials
    "solar":         { style: "commanding",   voiceSettings: { stability: 0.9, similarity_boost: 0.8, style: 0.5 } },
    "planetar":      { style: "commanding",   voiceSettings: { stability: 0.85, similarity_boost: 0.8, style: 0.5 } },

    // Fey
    "hag":           { style: "manipulative", voiceSettings: { stability: 0.3, similarity_boost: 0.7, style: 0.8 } },

    // Giants
    "giant":         { style: "commanding",   voiceSettings: { stability: 0.6, similarity_boost: 0.7, style: 0.4 } },
};

/**
 * Alignment → voice settings modifiers.
 * Applied on top of base/creature settings.
 */
const ALIGNMENT_MODIFIERS = {
    // Ethical axis
    "lawful":  { stability: +0.1, style: -0.1 },   // measured, controlled
    "chaotic": { stability: -0.1, style: +0.1 },   // wild, expressive

    // Moral axis
    "good":    { similarity_boost: +0.05, stability: +0.05 },  // warm, trustworthy
    "evil":    { similarity_boost: -0.05, stability: -0.05 },  // cold, unpredictable
};

/**
 * Creature types that should NEVER get a voice (non-speaking).
 */
const NON_SPEAKING_TYPES = new Set([
    "ooze", "plant",
]);

/**
 * Minimum INT to qualify for voice. Below this = non-speaking.
 */
const MIN_VOICE_INT = 3;

// ═══════════════════════════════════════════════════════════════════════════════
//  ELEVENLABS SHARED VOICE LIBRARY CACHE
// ═══════════════════════════════════════════════════════════════════════════════

/** In-memory cache of fetched voices, keyed by "gender|accent" */
let _voiceLibraryCache = null;
let _voiceLibraryCacheTime = 0;
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const CACHE_VERSION = 2; // Bump to invalidate stale caches (v2: removed featured filter)

/**
 * Fetch voices from ElevenLabs shared voice library, filtered and cached.
 * Returns Map<string, VoiceEntry[]> keyed by "male|accent" or "female|accent".
 */
async function _fetchSharedVoiceLibrary() {
    const now = Date.now();
    if (_voiceLibraryCache && (now - _voiceLibraryCacheTime) < CACHE_TTL) {
        return _voiceLibraryCache;
    }

    // Try loading from world setting first
    try {
        const stored = game.settings.get(MODULE_ID, "voiceLibraryCache");
        if (stored?.voices && stored?.timestamp
            && (now - stored.timestamp) < CACHE_TTL
            && (stored.version || 0) >= CACHE_VERSION) {
            _voiceLibraryCache = _deserializeCache(stored.voices);
            _voiceLibraryCacheTime = stored.timestamp;
            console.log(`${MODULE_ID} | Voice library loaded from cache v${stored.version || 0} (${_countVoices(_voiceLibraryCache)} voices)`);
            return _voiceLibraryCache;
        }
    } catch (_) {}

    const apiKey = getElevenLabsKey();
    if (!apiKey) {
        console.warn(`${MODULE_ID} | No ElevenLabs API key — voice engine using fallback`);
        return null;
    }

    console.log(`${MODULE_ID} | Fetching shared voice library from ElevenLabs...`);

    const cache = new Map();

    // Accents we need to query for
    const accents = new Set();
    for (const acc of Object.values(RACE_ACCENT_MAP)) {
        if (acc) accents.add(acc);
    }
    for (const pool of Object.values(REGION_ACCENT_MAP)) {
        for (const acc of pool) accents.add(acc);
    }

    for (const accent of accents) {
        for (const gender of ["male", "female"]) {
            try {
                const params = new URLSearchParams({
                    language: "en",
                    gender,
                    accent,
                    page_size: "25",
                    sort: "usage_character_count_1y",
                });

                const res = await fetch(
                    `https://api.elevenlabs.io/v1/shared-voices?${params}`,
                    { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(15000) }
                );

                if (!res.ok) {
                    console.warn(`${MODULE_ID} | Shared voice query failed for ${gender}/${accent}: ${res.status}`);
                    continue;
                }

                const data = await res.json();
                const voices = (data.voices || []).map(v => ({
                    voice_id: v.voice_id,
                    name:     v.name,
                    accent:   v.accent,
                    gender:   v.gender,
                    age:      v.age,
                    preview:  v.preview_url,
                }));

                if (voices.length) {
                    cache.set(`${gender}|${accent}`, voices);
                }
            } catch (e) {
                console.warn(`${MODULE_ID} | Voice fetch error for ${gender}/${accent}:`, e.message);
            }
        }
    }

    if (cache.size > 0) {
        _voiceLibraryCache = cache;
        _voiceLibraryCacheTime = now;

        // Persist to world setting
        try {
            await game.settings.set(MODULE_ID, "voiceLibraryCache", {
                voices: _serializeCache(cache),
                timestamp: now,
                version: CACHE_VERSION,
            });
            console.log(`${MODULE_ID} | Voice library cached v${CACHE_VERSION} (${_countVoices(cache)} voices across ${cache.size} pools)`);
        } catch (e) {
            console.warn(`${MODULE_ID} | Could not persist voice cache:`, e.message);
        }
    }

    return cache.size > 0 ? cache : null;
}

function _serializeCache(map) {
    const obj = {};
    for (const [key, val] of map.entries()) obj[key] = val;
    return obj;
}

function _deserializeCache(obj) {
    const map = new Map();
    for (const [key, val] of Object.entries(obj)) map.set(key, val);
    return map;
}

function _countVoices(map) {
    let n = 0;
    for (const arr of map.values()) n += arr.length;
    return n;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GENDER DETECTION (enhanced from original voices.js)
// ═══════════════════════════════════════════════════════════════════════════════

const _FEMALE_TYPES = /\b(female|woman|girl|hag|harpy|medusa|nymph|dryad|siren|banshee|succubus|sea hag|green hag|night hag|lamia|sphinx|priestess|queen|empress|duchess|countess|baroness|matriarch|abbess|sorceress|enchantress|witch)\b/i;
const _MALE_TYPES   = /\b(male|man|boy|king|emperor|duke|count|baron|patriarch|abbot|warlock|knight|prince|lord)\b/i;

const _FEMALE_PRONOUNS = /\b(she|her|hers|herself|woman|lady|girl|mother|daughter|sister|wife|mistress|maiden|matron|goddess)\b/i;
const _MALE_PRONOUNS   = /\b(he|him|his|himself|man|lord|boy|father|son|brother|husband|master|god)\b/i;

/**
 * Multi-signal gender detection.
 * Returns "female", "male", or null (unknown → caller defaults to male).
 */
export function detectGender(actor) {
    if (!actor) return null;

    // 1) Explicit gender field
    const genderField = (actor.system?.details?.gender || "").toLowerCase().trim();
    if (genderField) {
        if (/female|woman|girl|she/i.test(genderField)) return "female";
        if (/male|man|boy|he/i.test(genderField))       return "male";
        return null;
    }

    // 2) Bio pronoun scanning
    const bio = (actor.system?.details?.biography?.value || "").replace(/<[^>]+>/g, " ");
    if (bio.length > 10) {
        const femaleHits = (bio.match(new RegExp(_FEMALE_PRONOUNS.source, "gi")) || []).length;
        const maleHits   = (bio.match(new RegExp(_MALE_PRONOUNS.source,   "gi")) || []).length;
        if (femaleHits > 0 && femaleHits >= maleHits * 2) return "female";
        if (maleHits   > 0 && maleHits   >= femaleHits * 2) return "male";
    }

    // 3) Name + race/type keywords
    const searchText = [
        actor.name,
        actor.system?.details?.race?.value ?? actor.system?.details?.race ?? "",
        actor.system?.details?.type?.value ?? "",
        actor.system?.details?.type?.subtype ?? "",
    ].join(" ");

    if (_FEMALE_TYPES.test(searchText)) return "female";
    if (_MALE_TYPES.test(searchText))   return "male";

    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACCENT RESOLUTION (the priority chain)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine the accent for a given actor on the current scene.
 *
 * Priority:
 *   1. Named NPC override (Strahd → Romanian)
 *   2. Race-based accent (Dwarf → Scottish)
 *   3. Scene region accent (Barovia → Eastern European pool)
 *   4. Default → British
 *
 * @param {Actor} actor
 * @returns {string} ElevenLabs accent label
 */
export function resolveAccent(actor) {
    const actorName = (actor?.name || "").toLowerCase().trim();

    // 1. Named NPC override
    if (NAMED_NPC_OVERRIDES[actorName]) {
        return NAMED_NPC_OVERRIDES[actorName].accent;
    }

    // 2. Race-based accent
    const raceAccent = _getRaceAccent(actor);
    if (raceAccent) return raceAccent;

    // 3. Scene region accent (weighted random from pool)
    const region = _getSceneRegion();
    const pool = REGION_ACCENT_MAP[region] || REGION_ACCENT_MAP["default"];
    return _weightedPick(pool);
}

/**
 * Check actor race/subrace against RACE_ACCENT_MAP.
 * Tries most-specific first (e.g., "hill dwarf" before "dwarf").
 */
function _getRaceAccent(actor) {
    if (!actor) return null;

    const raceRaw = (
        actor.system?.details?.race?.value
        ?? actor.system?.details?.race
        ?? ""
    ).toLowerCase().trim();

    const subtypeRaw = (actor.system?.details?.type?.subtype || "").toLowerCase().trim();
    const nameRaw = (actor.name || "").toLowerCase();

    // Build search strings from most to least specific
    const candidates = [
        raceRaw,
        subtypeRaw,
        nameRaw,
    ].filter(Boolean);

    // Try exact matches first (most specific)
    for (const text of candidates) {
        if (RACE_ACCENT_MAP[text] !== undefined) return RACE_ACCENT_MAP[text];
    }

    // Try partial keyword matches
    for (const [keyword, accent] of Object.entries(RACE_ACCENT_MAP)) {
        if (!accent) continue; // null = no override (tiefling, kenku)
        for (const text of candidates) {
            if (text.includes(keyword)) return accent;
        }
    }

    return null;
}

/**
 * Get the scene region from the scene flag or infer from name.
 */
function _getSceneRegion() {
    try {
        const flag = canvas.scene?.getFlag(MODULE_ID, "voiceRegion");
        if (flag && REGION_ACCENT_MAP[flag]) return flag;
    } catch (_) {}

    // Infer from scene name
    const sceneName = (canvas.scene?.name || "").toLowerCase();
    for (const region of Object.keys(REGION_ACCENT_MAP)) {
        if (region === "default") continue;
        if (sceneName.includes(region.replace(/_/g, " "))) return region;
    }

    // Extended scene name → region inference (common adventure locations)
    const SCENE_HINTS = {
        barovia: ["ravenloft", "strahd", "death house", "amber temple", "vallaki",
                  "krezk", "village of barovia", "old bonegrinder", "yester hill",
                  "tser pool", "argynvostholt", "berez", "van richten", "barov"],
        calimshan: ["calim", "memnon", "almraiven"],
        chult: ["port nyanzaru", "omu", "tomb of annihilation", "mezro"],
        icewind_dale: ["icewind", "ten-towns", "bryn shander", "lonelywood", "auril"],
    };
    for (const [region, hints] of Object.entries(SCENE_HINTS)) {
        for (const hint of hints) {
            if (sceneName.includes(hint)) return region;
        }
    }

    // Also check world title for campaign-wide hints
    try {
        const worldName = (game.world?.title || "").toLowerCase();
        for (const [region, hints] of Object.entries(SCENE_HINTS)) {
            for (const hint of hints) {
                if (worldName.includes(hint)) return region;
            }
        }
    } catch (_) {}

    return "default";
}

/**
 * Weighted random pick from an accent pool.
 * First accent gets 60% weight, rest split 40%.
 */
function _weightedPick(pool) {
    if (!pool || !pool.length) return "british";
    if (pool.length === 1) return pool[0];

    const roll = Math.random();
    if (roll < 0.6) return pool[0]; // dominant accent
    // Pick randomly from the rest
    const idx = 1 + Math.floor(Math.random() * (pool.length - 1));
    return pool[idx];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VOICE SETTINGS RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the ElevenLabs voice_settings for this actor.
 * Layers: base defaults → creature profile → alignment modifiers → named NPC override.
 *
 * @param {Actor} actor
 * @returns {{ stability: number, similarity_boost: number, style: number }}
 */
export function resolveVoiceSettings(actor) {
    const base = { stability: 0.5, similarity_boost: 0.8, style: 0.35 };
    if (!actor) return base;

    const actorName = (actor.name || "").toLowerCase().trim();

    // Named NPC override — use their settings directly
    if (NAMED_NPC_OVERRIDES[actorName]?.voiceSettings) {
        return { ...base, ...NAMED_NPC_OVERRIDES[actorName].voiceSettings };
    }

    // Creature profile
    const profile = _getCreatureProfile(actor);
    if (profile?.voiceSettings) {
        Object.assign(base, profile.voiceSettings);
    }

    // Alignment modifiers (additive)
    const alignment = (actor.system?.details?.alignment || "").toLowerCase();
    for (const [keyword, mods] of Object.entries(ALIGNMENT_MODIFIERS)) {
        if (alignment.includes(keyword)) {
            for (const [key, delta] of Object.entries(mods)) {
                if (base[key] !== undefined) {
                    base[key] = Math.max(0, Math.min(1, base[key] + delta));
                }
            }
        }
    }

    return base;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DYNAMIC VOICE SETTINGS — per-call adjustments based on live actor state
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * D&D 5e condition → voice settings modifiers (additive).
 * Simulates how each condition would affect someone's voice.
 */
const CONDITION_VOICE_MODIFIERS = {
    // Fear/anxiety → shaky, faster, less controlled
    frightened:   { stability: -0.20, style: +0.10 },
    // Poison/illness → strained, breathy
    poisoned:     { stability: -0.15, similarity_boost: -0.10 },
    // Physical restraint → tense, controlled urgency
    restrained:   { stability: -0.10, style: +0.05 },
    // Exhaustion → slow, weak, breathy (scaled by level below)
    exhaustion:   { stability: -0.10, similarity_boost: -0.10, style: -0.15 },
    // Charmed → warm, relaxed, slightly dreamy
    charmed:      { stability: +0.10, similarity_boost: +0.10, style: +0.10 },
    // Stunned → disoriented, slurred
    stunned:      { stability: -0.25, style: -0.10 },
    // Blinded → cautious, uncertain
    blinded:      { stability: -0.10, style: -0.05 },
    // Deafened → louder, less modulated (can't hear self)
    deafened:     { stability: -0.15, style: +0.15 },
    // Invisible → confident, smug
    invisible:    { stability: +0.15, style: +0.10 },
    // Prone → strained, winded
    prone:        { stability: -0.10, similarity_boost: -0.05 },
    // Grappled → tense, strained
    grappled:     { stability: -0.10, style: +0.05 },
    // Petrified, paralyzed, incapacitated, unconscious → can't speak (handled elsewhere)
};

/**
 * Compute dynamic voice settings based on the actor's CURRENT state.
 * Called right before each TTS call to adjust voice in real-time.
 *
 * Reads: HP percentage, active conditions, exhaustion level, personality flag.
 * Returns a new settings object (does NOT mutate the input).
 *
 * @param {Actor} actor — the speaking actor
 * @param {object} baseSettings — the stored/static voice settings { stability, similarity_boost, style }
 * @returns {object} adjusted voice settings
 */
export function getDynamicVoiceSettings(actor, baseSettings = {}) {
    const settings = {
        stability:        baseSettings.stability        ?? 0.5,
        similarity_boost: baseSettings.similarity_boost ?? 0.8,
        style:            baseSettings.style            ?? 0.35,
    };

    if (!actor) return settings;

    // ── HP-based modifiers ──────────────────────────────────────────────────
    // Lower HP = more strained, urgent, shaky voice
    const hp    = actor.system?.attributes?.hp;
    const maxHp = hp?.max || 1;
    const curHp = hp?.value ?? maxHp;
    const hpPct = Math.max(0, Math.min(1, curHp / maxHp));

    if (hpPct <= 0.25) {
        // Critical — desperate, shaky, weak
        settings.stability        -= 0.20;
        settings.similarity_boost -= 0.15;
        settings.style            -= 0.10;
    } else if (hpPct <= 0.50) {
        // Bloodied — strained, urgent
        settings.stability        -= 0.12;
        settings.similarity_boost -= 0.08;
    } else if (hpPct <= 0.75) {
        // Hurt — slightly tense
        settings.stability        -= 0.05;
    }
    // Full HP → no modifier

    // ── Condition-based modifiers ────────────────────────────────────────────
    // D&D 5e stores conditions as active effects with statuses
    try {
        const conditions = new Set();

        // V13+ uses actor.statuses (a Set of status IDs)
        if (actor.statuses) {
            for (const s of actor.statuses) conditions.add(s);
        }

        // Also check active effects for status IDs (fallback for older versions)
        for (const effect of (actor.effects ?? [])) {
            if (effect.disabled) continue;
            for (const s of (effect.statuses ?? [])) conditions.add(s);
        }

        for (const [condition, mods] of Object.entries(CONDITION_VOICE_MODIFIERS)) {
            if (!conditions.has(condition)) continue;

            for (const [key, delta] of Object.entries(mods)) {
                if (settings[key] !== undefined) {
                    settings[key] += delta;
                }
            }
        }

        // Exhaustion scales — each level compounds the effect
        if (conditions.has("exhaustion")) {
            const exhaustionLevel = _getExhaustionLevel(actor);
            if (exhaustionLevel > 1) {
                // Additional penalty per level beyond 1 (level 1 already applied above)
                const extra = (exhaustionLevel - 1) * 0.05;
                settings.stability        -= extra;
                settings.similarity_boost -= extra;
            }
        }
    } catch (e) {
        console.warn(`${MODULE_ID} | Dynamic voice: condition check failed:`, e);
    }

    // ── Personality/mood injection (from conversation context) ───────────────
    // If the AI flagged a current mood on the actor, apply it
    try {
        const mood = actor.getFlag?.(MODULE_ID, "currentMood") || "";
        if (mood) {
            const moodLower = mood.toLowerCase();
            if (moodLower.includes("angry") || moodLower.includes("furious") || moodLower.includes("rage")) {
                settings.stability -= 0.15;
                settings.style     += 0.15;
            } else if (moodLower.includes("sad") || moodLower.includes("grief") || moodLower.includes("mourn")) {
                settings.stability += 0.05;
                settings.style     -= 0.15;
                settings.similarity_boost -= 0.10;
            } else if (moodLower.includes("nervous") || moodLower.includes("anxious") || moodLower.includes("afraid")) {
                settings.stability -= 0.15;
                settings.style     += 0.05;
            } else if (moodLower.includes("confident") || moodLower.includes("smug") || moodLower.includes("proud")) {
                settings.stability += 0.10;
                settings.style     += 0.10;
            } else if (moodLower.includes("drunk") || moodLower.includes("intoxicated")) {
                settings.stability -= 0.25;
                settings.style     += 0.10;
            } else if (moodLower.includes("whisper") || moodLower.includes("quiet") || moodLower.includes("hushed")) {
                settings.stability += 0.15;
                settings.style     -= 0.20;
                settings.similarity_boost += 0.10;
            }
        }
    } catch (_) {}

    // ── Clamp all values to [0, 1] ──────────────────────────────────────────
    settings.stability        = Math.max(0, Math.min(1, settings.stability));
    settings.similarity_boost = Math.max(0, Math.min(1, settings.similarity_boost));
    settings.style            = Math.max(0, Math.min(1, settings.style));

    // Log if settings changed significantly
    const stabDiff = Math.abs(settings.stability - (baseSettings.stability ?? 0.5));
    const simDiff  = Math.abs(settings.similarity_boost - (baseSettings.similarity_boost ?? 0.8));
    const stylDiff = Math.abs(settings.style - (baseSettings.style ?? 0.35));
    if (stabDiff > 0.05 || simDiff > 0.05 || stylDiff > 0.05) {
        console.log(`${MODULE_ID} | Dynamic voice for ${actor.name}: stability=${settings.stability.toFixed(2)}, sim=${settings.similarity_boost.toFixed(2)}, style=${settings.style.toFixed(2)} (HP=${Math.round(hpPct * 100)}%)`);
    }

    return settings;
}

/**
 * Get the exhaustion level for a D&D 5e actor.
 */
function _getExhaustionLevel(actor) {
    // V13 D&D 5e stores exhaustion level directly
    if (typeof actor.system?.attributes?.exhaustion === "number") {
        return actor.system.attributes.exhaustion;
    }
    // Fallback: count exhaustion effects
    let level = 0;
    for (const effect of (actor.effects ?? [])) {
        if (effect.disabled) continue;
        for (const s of (effect.statuses ?? [])) {
            if (s === "exhaustion") level++;
        }
    }
    return level;
}

/**
 * Find a creature voice profile by name keyword or creature type.
 */
function _getCreatureProfile(actor) {
    const name = (actor.name || "").toLowerCase();
    const type = (actor.system?.details?.type?.value || "").toLowerCase();

    // Name-based match first (most specific)
    for (const [keyword, profile] of Object.entries(CREATURE_VOICE_PROFILES)) {
        if (name.includes(keyword)) return profile;
    }

    // Type-based fallback
    if (type && CREATURE_VOICE_PROFILES[type]) {
        return CREATURE_VOICE_PROFILES[type];
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SHOULD THIS ACTOR GET A VOICE?
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns true if this actor should NOT receive a voice.
 * Non-speaking creatures, mindless, or explicitly skipped.
 */
export function isNonSpeaking(actor) {
    if (!actor) return true;

    // Check creature type
    const type = (actor.system?.details?.type?.value || "").toLowerCase().trim();
    if (NON_SPEAKING_TYPES.has(type)) return true;

    // Check INT score (below MIN_VOICE_INT = non-speaking)
    const int = actor.system?.abilities?.int?.value;
    if (typeof int === "number" && int < MIN_VOICE_INT) return true;

    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN: PICK A VOICE FOR AN ACTOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The main voice assignment function. Called on token creation.
 *
 * Priority chain:
 *   1. Manual GM override (already saved in flag — we don't touch it)
 *   2. Named NPC override (Strahd → specific accent + settings)
 *   3. Race-based accent (Dwarf → Scottish)
 *   4. Creature type profile (Dragon → neutral accent, tuned settings)
 *   5. Scene regional accent (Barovia → Eastern European)
 *   6. Default → British
 *
 * @param {Actor} actor
 * @param {string} [genderOverride] — Force "male" or "female" instead of auto-detect
 * @param {string} [accentOverride] — Force a specific accent instead of resolving from race/region
 * @returns {{ voiceId: string|null, voiceSettings: object, accent: string, gender: string }}
 */
export async function assignVoice(actor, genderOverride = null, accentOverride = null) {
    if (!actor) return null;

    // Non-speaking creature → no voice
    if (isNonSpeaking(actor)) {
        console.log(`${MODULE_ID} | Voice Engine: ${actor.name} is non-speaking — skipping`);
        return null;
    }

    // Detect gender (or use override from GM gender toggle)
    const gender = genderOverride || detectGender(actor) || "male";

    // Resolve accent (use override if provided, e.g. from gender toggle preserving current accent)
    const accent = accentOverride || resolveAccent(actor);

    // Resolve voice settings (alignment + creature profile)
    const voiceSettings = resolveVoiceSettings(actor);

    // Check if this is an intelligent non-humanoid (use neutral accent instead)
    const creatureType = (actor.system?.details?.type?.value || "").toLowerCase();
    const isIntelligentMonster = _getCreatureProfile(actor) !== null
        && creatureType !== "humanoid"
        && creatureType !== "fey";

    const effectiveAccent = isIntelligentMonster ? "british" : accent;

    console.log(`${MODULE_ID} | Voice Engine: ${actor.name} → gender=${gender}, accent=${effectiveAccent}, creature=${isIntelligentMonster ? "yes" : "no"}`);

    // Pick from shared voice library
    const voiceId = await _pickFromLibrary(gender, effectiveAccent);

    if (!voiceId) {
        console.warn(`${MODULE_ID} | Voice Engine: No voice found for ${gender}/${effectiveAccent}, trying fallback`);
        // Fallback chain: try british, then opposite gender with same accent, then hardcoded list
        // Track the ACTUAL accent used so the flag doesn't lie
        let fallbackAccent = effectiveAccent;
        let fallback = await _pickFromLibrary(gender, "british");
        if (fallback) {
            fallbackAccent = "british";
        } else {
            fallback = await _pickFromLibrary(gender === "male" ? "female" : "male", effectiveAccent);
            if (!fallback) {
                fallback = await _pickFromFallbackList(gender);
                fallbackAccent = "british"; // hardcoded fallback list is British/American
            }
        }
        return fallback ? {
            voiceId: fallback,
            voiceSettings,
            accent: fallbackAccent,
            gender,
        } : null;
    }

    return {
        voiceId,
        voiceSettings,
        accent: effectiveAccent,
        gender,
    };
}

/**
 * Pick a random voice from the shared library cache.
 */
async function _pickFromLibrary(gender, accent) {
    const library = await _fetchSharedVoiceLibrary();
    if (!library) return null;

    const key = `${gender}|${accent}`;
    const pool = library.get(key);
    if (!pool || !pool.length) return null;

    const voice = pool[Math.floor(Math.random() * pool.length)];
    console.log(`${MODULE_ID} | Voice Engine: Picked "${voice.name}" (${voice.voice_id}) from ${key} pool (${pool.length} available)`);
    return voice.voice_id;
}

/**
 * Hardcoded fallback voices if the shared library is unavailable.
 * These are default ElevenLabs voices that should always work.
 */
const FALLBACK_VOICES = {
    male: [
        { id: "pNInz6obpgDQGcFmaJgB", name: "Adam" },
        { id: "nPczCjzI2devNBz1zQrb", name: "Brian" },
        { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie" },
        { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel" },
        { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" },
        { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam" },
    ],
    female: [
        { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
        { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice" },
        { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica" },
        { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily" },
    ],
};

async function _pickFromFallbackList(gender) {
    const pool = FALLBACK_VOICES[gender] || FALLBACK_VOICES.male;
    const voice = pool[Math.floor(Math.random() * pool.length)];
    console.log(`${MODULE_ID} | Voice Engine: Using fallback voice "${voice.name}"`);
    return voice.id;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TOKEN CREATION HOOK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Called from main.js createToken hook.
 * Assigns a voice immediately when a token is dropped on the scene.
 * Saves voiceId + voiceSettings + accent + gender to actor/token flags.
 *
 * @param {TokenDocument} tokenDocument
 */
export async function onTokenCreated(tokenDocument) {
    const actor = tokenDocument.actor;
    if (!actor || actor.type !== "npc") return;

    // Skip if voice already assigned (linked actor reuse)
    // Voice flags are always on the actor (ActorDelta for unlinked)
    const existingVoice = actor.getFlag(MODULE_ID, "voiceId");

    if (existingVoice) {
        console.log(`${MODULE_ID} | Voice Engine: ${actor.name} already has voice ${existingVoice} — keeping`);
        return;
    }

    // Assign voice
    const result = await assignVoice(actor);
    if (!result) return;

    // Save to flags
    const flagData = {
        voiceId:       result.voiceId,
        voiceSettings: result.voiceSettings,
        voiceAccent:   result.accent,
        voiceGender:   result.gender,
    };

    if (tokenDocument.actorLink) {
        // Linked token → save to base actor
        await actor.update({
            [`flags.${MODULE_ID}.voiceId`]:       flagData.voiceId,
            [`flags.${MODULE_ID}.voiceSettings`]:  flagData.voiceSettings,
            [`flags.${MODULE_ID}.voiceAccent`]:    flagData.voiceAccent,
            [`flags.${MODULE_ID}.voiceGender`]:    flagData.voiceGender,
        });
    } else {
        // Unlinked token → save to ActorDelta (synthetic actor) so
        // actor.getFlag(MODULE_ID, "voiceId") works everywhere
        // (AI Setup dialog, ConversationApp, getNpcPersonality API, etc.)
        await tokenDocument.actor.update({
            [`flags.${MODULE_ID}.voiceId`]:       flagData.voiceId,
            [`flags.${MODULE_ID}.voiceSettings`]:  flagData.voiceSettings,
            [`flags.${MODULE_ID}.voiceAccent`]:    flagData.voiceAccent,
            [`flags.${MODULE_ID}.voiceGender`]:    flagData.voiceGender,
        });
    }

    console.log(`${MODULE_ID} | Voice Engine: Assigned voice to ${actor.name} → ${result.voiceId} (${result.gender}/${result.accent})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DEATH: CLEAR VOICE FLAG
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Called when an NPC dies. Clears their voice so if resurrected they get a new one.
 *
 * @param {TokenDocument} tokenDocument
 */
export async function onTokenDeath(tokenDocument) {
    const actor = tokenDocument?.actor;
    if (!actor) return;

    try {
        // Voice flags are always on the actor (base actor for linked,
        // ActorDelta synthetic actor for unlinked)
        await actor.unsetFlag(MODULE_ID, "voiceId");
        await actor.unsetFlag(MODULE_ID, "voiceSettings");
        await actor.unsetFlag(MODULE_ID, "voiceAccent");
        await actor.unsetFlag(MODULE_ID, "voiceGender");
        console.log(`${MODULE_ID} | Voice Engine: Cleared voice for ${actor.name} (death)`);
    } catch (e) {
        console.warn(`${MODULE_ID} | Voice Engine: Failed to clear voice on death:`, e);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BACKWARD COMPATIBILITY — pickVoiceForActor / pickValidatedVoiceForActor
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Legacy compatibility wrapper.
 * ConversationApp calls this if no voice is flagged — falls back to assignVoice.
 */
export async function pickValidatedVoiceForActor(actor) {
    const result = await assignVoice(actor);
    return result?.voiceId || FALLBACK_VOICES.male[0].id;
}

export function pickVoiceForActor(actor) {
    const gender = detectGender(actor) || "male";
    const pool = FALLBACK_VOICES[gender] || FALLBACK_VOICES.male;
    return pool[Math.floor(Math.random() * pool.length)].id;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GET VOICE SETTINGS FOR AN ACTOR (for TTS calls)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Retrieve the saved voice settings for an actor, or compute fresh ones.
 * Called by ConversationApp before each TTS call.
 *
 * @param {Actor} actor
 * @param {TokenDocument} [tokenDoc]
 * @returns {{ voiceId: string, voiceSettings: object }}
 */
export async function getVoiceConfig(actor, tokenDoc = null) {
    // Voice flags are always on the actor (base actor for linked,
    // ActorDelta synthetic actor for unlinked). For unlinked tokens,
    // tokenDoc.actor IS the synthetic actor with merged flags.
    const effectiveActor = (tokenDoc && !tokenDoc.actorLink && tokenDoc.actor)
                         ? tokenDoc.actor : actor;

    const voiceId = effectiveActor?.getFlag?.(MODULE_ID, "voiceId")
                 || actor?.getFlag?.(MODULE_ID, "voiceId")
                 || actor?.flags?.npclink?.voiceId;

    const voiceSettings = effectiveActor?.getFlag?.(MODULE_ID, "voiceSettings")
                       || actor?.getFlag?.(MODULE_ID, "voiceSettings")
                       || null;

    if (voiceId) {
        return {
            voiceId,
            voiceSettings: voiceSettings || resolveVoiceSettings(actor),
        };
    }

    // No voice assigned yet — assign now
    const result = await assignVoice(actor);
    if (result) {
        // Save it
        try {
            // For unlinked tokens, save to ActorDelta (synthetic actor) so
            // actor.getFlag() works from AI Setup dialog, ConversationApp, etc.
            const target = (tokenDoc && !tokenDoc.actorLink) ? tokenDoc.actor : actor;
            await target.update({
                [`flags.${MODULE_ID}.voiceId`]:      result.voiceId,
                [`flags.${MODULE_ID}.voiceSettings`]: result.voiceSettings,
                [`flags.${MODULE_ID}.voiceAccent`]:   result.accent,
                [`flags.${MODULE_ID}.voiceGender`]:   result.gender,
            });
        } catch (e) {
            console.warn(`${MODULE_ID} | Voice Engine: Could not save voice assignment:`, e);
        }

        return {
            voiceId: result.voiceId,
            voiceSettings: result.voiceSettings,
        };
    }

    // Ultimate fallback
    return {
        voiceId: FALLBACK_VOICES.male[0].id,
        voiceSettings: { stability: 0.5, similarity_boost: 0.8, style: 0.35 },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REGISTER SETTINGS (called from settings.js)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register voice engine settings. Called during init.
 */
export function registerVoiceEngineSettings() {
    // Scene region dropdown — registered as a world setting
    // (Scene-level flags are set via the scene config hook instead)
    game.settings.register(MODULE_ID, "defaultVoiceRegion", {
        name:    "Default Voice Region",
        hint:    "Default regional accent pool for NPCs when no scene-specific region is set. Affects commoners, humans, and races without a fixed accent.",
        scope:   "world",
        config:  true,
        type:    String,
        choices: {
            "default":      "Sword Coast / Generic (British)",
            "barovia":      "Barovia / Ravenloft (Eastern European)",
            "calimshan":    "Calimshan (Middle Eastern)",
            "chult":        "Chult (African)",
            "kara_tur":     "Kara-Tur (East Asian)",
            "icewind_dale": "Icewind Dale / Nordic (Scandinavian)",
            "underdark":    "Underdark (Scandinavian/German)",
        },
        default: "default",
    });

    // Hidden: voice library cache
    game.settings.register(MODULE_ID, "voiceLibraryCache", {
        scope:   "world",
        config:  false,
        type:    Object,
        default: {},
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SCENE CONFIG HOOK — Add region dropdown to scene settings
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Injects a "Voice Region" dropdown into the scene configuration sheet.
 * Call this from main.js renderSceneConfig hook.
 */
export function onRenderSceneConfig(app, html) {
    const el = html[0] ?? html;
    // Find the ambience or atmosphere section to inject near
    const target = el.querySelector('.tab[data-tab="ambience"]')
                || el.querySelector('.tab[data-tab="basic"]');
    if (!target) return;

    const current = app.document.getFlag(MODULE_ID, "voiceRegion") || "";

    const regionOptions = Object.entries({
        "":             "— Use World Default —",
        "default":      "Sword Coast / Generic (British)",
        "barovia":      "Barovia / Ravenloft (Eastern European)",
        "ravenloft":    "Barovia / Ravenloft (Eastern European)",
        "sword_coast":  "Sword Coast (British)",
        "waterdeep":    "Waterdeep (British)",
        "baldurs_gate":  "Baldur's Gate (British)",
        "calimshan":    "Calimshan (Middle Eastern)",
        "chult":        "Chult (African)",
        "kara_tur":     "Kara-Tur (East Asian)",
        "icewind_dale": "Icewind Dale (Scandinavian)",
        "nordic":       "Nordic (Scandinavian)",
        "underdark":    "Underdark (Scandinavian/German)",
    }).map(([value, label]) => {
        const sel = value === current ? "selected" : "";
        return `<option value="${value}" ${sel}>${label}</option>`;
    }).join("");

    const group = document.createElement("div");
    group.classList.add("form-group");
    group.innerHTML = `
        <label>ACE: Voice Region</label>
        <div class="form-fields">
            <select name="flags.${MODULE_ID}.voiceRegion">
                ${regionOptions}
            </select>
        </div>
        <p class="hint">Regional accent pool for NPC voices on this scene. Affects humans, commoners, and races without a fixed accent (e.g., Tieflings adopt local accent).</p>
    `;

    target.prepend(group);
}
