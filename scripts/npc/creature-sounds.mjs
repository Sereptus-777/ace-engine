// ─── ACE: Engine — Creature Sound Effects ──────────────────────────────────
// Replaces literal sound words (Grrr, *growls*, Hisss) with actual audio clips
// so TTS doesn't read them aloud.
//
// Moved from ace-envoy/src/audio/creature-sounds.js as part of the
// Envoy → Engine merger.
//
// Creature vocalization sounds live in ace-engine.
// (2026-06-28: the legacy ace-envoy fallback path was removed — Envoy is
// retired and its sounds were already copied here. Engine is self-contained.)

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine";
const SOUND_PATHS = [
    `modules/${MODULE_ID}/sounds/creatures`,
];

// ─── File-list cache ───────────────────────────────────────────────────────
const _fileCache = new Map();
const CACHE_TTL  = 120_000;          // 2 minutes

/** Filename patterns that are NOT creature vocalizations — safety-net filter */
const EXCLUDE_RE = /(?:walking|footstep|step|ambien|loop|light.saber|electric|cartoon|robotic|sci.fi|singing|chirp)/i;

/**
 * Resolve the FilePicker class the way the rest of ace-engine does.
 *
 * ⚠️ THIS FILE USED THE BARE `FilePicker` GLOBAL (fixed 2026-08-06). In V13 the
 * class moved to foundry.applications.apps.FilePicker.implementation and the
 * bare global is deprecated. If it is absent, `FilePicker.browse(...)` throws a
 * ReferenceError — which landed in a `catch (_) {}` that treated it as "this
 * folder does not exist" and returned an empty list. The result: "No creature
 * sounds found in giant" while four perfectly good roars sat in that folder,
 * with nothing anywhere explaining why.
 *
 * That is the identical failure shape as the wall-collision bug earlier the
 * same day: an API that does not exist, thrown into a silent catch, quietly
 * disabling a whole feature. Resolve it properly, and never swallow the reason.
 */
function _filePicker() {
    return foundry?.applications?.apps?.FilePicker?.implementation
        ?? globalThis.FilePicker
        ?? null;
}

async function _getFiles(folder) {
    if (!folder) return [];
    if (!game.user?.isGM) return [];  // browse is GM-only; players get an empty list
    const now = Date.now();
    const cacheKey = folder;
    const cached = _fileCache.get(cacheKey);
    if (cached && (now - cached.ts) < CACHE_TTL) return cached.files;

    const FP = _filePicker();
    if (!FP?.browse) {
        console.error(`${TAG} | No FilePicker implementation available — creature sounds cannot be listed. This is a Foundry API problem, not a missing-files problem.`);
        return [];
    }

    let lastErr = null;
    for (const base of SOUND_PATHS) {
        const path = `${base}/${folder}`;
        try {
            const result = await FP.browse("data", path);
            const all = result.files || [];
            const files = all.filter(f => {
                if (!/\.(mp3|wav|ogg|flac|webm)$/i.test(f)) return false;
                const name = f.split("/").pop();
                return !EXCLUDE_RE.test(name);
            });
            if (files.length) {
                _fileCache.set(cacheKey, { files, ts: now });
                return files;
            }
            // Folder exists but yielded nothing — say WHICH of the two it was,
            // because "no files" and "every file filtered out" need different
            // fixes and used to look identical.
            console.warn(`${TAG} | "${path}" holds ${all.length} entr${all.length === 1 ? "y" : "ies"} but 0 usable creature sounds` +
                (all.length ? " — wrong extension, or the name matched the exclude filter (walking/footstep/loop/ambient/…)." : " — the folder is empty."));
        } catch (err) {
            lastErr = err;
        }
    }
    if (lastErr) {
        console.warn(`${TAG} | Could not browse creature sounds for "${folder}":`, lastErr?.message ?? lastErr);
    }
    return [];
}

/**
 * The folders to try for one creature, most specific first.
 *
 * Johnny 2026-08-06: "Why is it looking under Giant? It should be looking at a
 * lot of other areas." An ogre IS giant-family, so "giant" is the right first
 * guess — the buckets are deliberately per-family so one set of roars serves
 * ogres, trolls and ettins rather than needing a folder per statblock. What was
 * missing is what happens when that bucket is EMPTY: the creature simply went
 * silent. Now it falls through to a generic bucket, so a half-populated library
 * still makes noise.
 */
export function getCreatureSoundCandidates(actor) {
    const primary = getCreatureSoundFolder(actor);
    const out = [];
    if (primary) out.push(primary);
    for (const generic of ["monster", "generic", "beast"]) {
        if (!out.includes(generic)) out.push(generic);
    }
    return out;
}

// ─── Creature-type → sound-folder mapping ──────────────────────────────────

/** Direct D&D 5e creature type → folder */
const TYPE_TO_FOLDER = {
    beast:       "beast",
    dragon:      "dragon",
    undead:      "undead",
    fiend:       "fiend",
    aberration:  "beast",
    monstrosity: "beast",
    ooze:        "ooze",
    elemental:   "elemental",
    plant:       "swarm",
    construct:   "construct",
    giant:       "giant",
    swarm:       "swarm",
    // Types that speak normally — no creature sounds (fey, celestial, humanoid)
};

/** Name/race overrides for humanoid-typed creatures that should still growl. */
const NAME_OVERRIDES = [
    ["goblin",     "goblinoid"],
    ["hobgoblin",  "goblinoid"],
    ["bugbear",    "goblinoid"],
    ["gnoll",      "goblinoid"],
    ["orc",        "goblinoid"],
    ["ogre",       "giant"],
    ["troll",      "giant"],
    ["ettin",      "giant"],
    ["kobold",     "serpent"],
    ["yuan-ti",    "serpent"],
    ["lizardfolk", "serpent"],
    ["troglodyte", "serpent"],
    ["naga",       "serpent"],
    ["harpy",      "flying"],
    ["aarakocra",  "flying"],
    ["kenku",      "flying"],
    ["wyvern",     "flying"],
    ["griffon",    "flying"],
    ["hippogriff", "flying"],
    ["basilisk",   "serpent"],
    ["cockatrice", "flying"],
    ["mimic",      "beast"],
    ["minotaur",   "beast"],
    ["werewolf",   "beast"],
    ["werebear",   "beast"],
    ["wererat",    "beast"],
    ["wereboar",   "beast"],
    ["weretiger",  "beast"],
];

/**
 * Returns a playbackRate pitch multiplier based on creature size.
 * Larger creatures get deeper, slower voices. Smaller get higher.
 * @param {Actor} actor
 * @returns {number}  e.g. 0.78 for huge, 1.0 for medium, 1.2 for tiny
 */
export function getVoicePitch(actor) {
    if (!actor) return 1.0;

    // D&D 5e size trait (primary)
    const size = (actor.system?.traits?.size || "").toLowerCase();
    if (size === "tiny") return 1.20;
    if (size === "sm")   return 1.05;
    if (size === "lg")   return 0.88;
    if (size === "huge") return 0.78;
    if (size === "grg")  return 0.70;

    // Fallback: token grid size (works for any system)
    const token = actor.getActiveTokens?.()?.[0];
    const tokenW = token?.document?.width ?? 1;
    if (tokenW >= 4) return 0.70;
    if (tokenW >= 3) return 0.78;
    if (tokenW >= 2) return 0.88;

    return 1.0;
}

/**
 * Determines which sound-effect folder to use for this actor.
 * Returns folder name (e.g. "beast") or null if the NPC speaks normally.
 */
export function getCreatureSoundFolder(actor) {
    if (!actor) return null;

    const type = (actor.system?.details?.type?.value || "").toLowerCase().trim();
    const name = (actor.name || "").toLowerCase();

    // dnd5e 5.x: race on PCs is an embedded Item document — extract its
    // .name. Older shapes stored a {value:""} object or a plain string.
    // Defensive read keeps this working across dnd5e versions.
    const raceField = actor.system?.details?.race;
    let raceStr = "";
    if (typeof raceField === "string") {
        raceStr = raceField;
    } else if (raceField?.name && typeof raceField.name === "string") {
        raceStr = raceField.name;
    } else if (typeof raceField?.value === "string") {
        raceStr = raceField.value;
    }
    const race = raceStr.toLowerCase();

    // 0. D&D 5e swarm flag — swarms are typed "beast" but have a swarm size field
    const swarmSize = (actor.system?.details?.type?.swarm || "").toLowerCase();
    if (swarmSize) return "swarm";

    // 1. Direct creature type match
    if (type && TYPE_TO_FOLDER[type] !== undefined) {
        return TYPE_TO_FOLDER[type];
    }

    // 2. Name/race override (catches humanoid-typed goblins, ogres, etc.)
    for (const [keyword, folder] of NAME_OVERRIDES) {
        if (name.includes(keyword) || race.includes(keyword)) return folder;
    }

    return null;
}

// ─── Sound-word detection ──────────────────────────────────────────────────

/** Verbs/nouns that describe creature sounds. */
const SOUND_VERBS = new Set([
    "growl", "growls", "growling", "growled",
    "snarl", "snarls", "snarling", "snarled",
    "hiss", "hisses", "hissing", "hissed",
    "roar", "roars", "roaring", "roared",
    "howl", "howls", "howling", "howled",
    "screech", "screeches", "screeching", "screeched",
    "shriek", "shrieks", "shrieking", "shrieked",
    "moan", "moans", "moaning", "moaned",
    "groan", "groans", "groaning", "groaned",
    "grunt", "grunts", "grunting", "grunted",
    "bark", "barks", "barking", "barked",
    "yelp", "yelps", "yelping", "yelped",
    "whimper", "whimpers", "whimpering", "whimpered",
    "wail", "wails", "wailing", "wailed",
    "squeal", "squeals", "squealing", "squealed",
    "snort", "snorts", "snorting", "snorted",
    "huff", "huffs", "huffing", "huffed",
    "pant", "pants", "panting", "panted",
    "wheeze", "wheezes", "wheezing", "wheezed",
    "chitter", "chittering", "chittered",
    "buzz", "buzzes", "buzzing", "buzzed",
    "click", "clicks", "clicking", "clicked",
    "clack", "clacks", "clacking",
    "bellow", "bellows", "bellowing", "bellowed",
    "rumble", "rumbles", "rumbling", "rumbled",
    "purr", "purrs", "purring", "purred",
    "whine", "whines", "whining", "whined",
    "croak", "croaks", "croaking", "croaked",
    "gurgle", "gurgles", "gurgling", "gurgled",
    "spit", "spits", "spitting",
    "sniff", "sniffs", "sniffing", "sniffed",
    "cackle", "cackles", "cackling", "cackled",
    "scream", "screams", "screaming", "screamed",
    "snarl", "snarling",
    "squelch", "squelches", "squelching", "squelched",
    "caw", "caws", "cawing", "cawed",
    "squawk", "squawks", "squawking", "squawked",
    "chirp", "chirps", "chirping", "chirped",
    "cluck", "clucks", "clucking", "clucked",
    "hoot", "hoots", "hooting", "hooted",
]);

/** True if the *emote* text describes a creature sound (not an action). */
export function isSoundEmote(emoteText) {
    if (!emoteText) return false;
    const words = emoteText.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/);
    return words.some(w => SOUND_VERBS.has(w));
}

/**
 * Strips onomatopoeia and standalone sound words from dialogue text.
 *
 * "Grrr, me kill you!" → { cleaned: "me kill you!", hadSounds: true }
 * "Back off!"          → { cleaned: "Back off!",    hadSounds: false }
 * "Hisss!"             → { cleaned: "",              hadSounds: true }
 */
export function stripSoundEffects(text) {
    if (!text) return { cleaned: "", hadSounds: false };
    let hadSounds = false;

    // 1. Onomatopoeia with repeated letters (Grrr, Hisss, Raargh, etc.)
    let cleaned = text.replace(
        /\b(?:g+r+[aeiou]*r*[aeiou]*[wl]*|h+i+s+[s]*|r+[ao]+[aor]*g*h*|g+[aeo]+h+|a+r+g+h*|u+g+h+|r+a+w+r*|n+g+h+|b+a+h+|s+n+a+r+l*|g+n+a+r+l*|s+n+o+r+t*|g+r+u+n+t*|h+o+w+l*|m+o+a+n*|g+r+o+a+n*|w+a+i+l*|y+e+l+p*|b+u+z+z*|c+a+w+|s+q+u+a+w+k*)\b[!.,;:?\s]*/gi,
        () => { hadSounds = true; return ""; }
    );

    // 2. Standalone sound verbs (catches "Screech!" or "Caw!" cases)
    cleaned = cleaned.replace(
        /\b(screech|shriek|squeal|bellow|chitter|squelch|wheeze|croak|gurgle|cackle|caw|squawk|chirp|screee|cluck|hoot)[s]?[!.,;:?\s]*/gi,
        () => { hadSounds = true; return ""; }
    );

    // 3. Clean up leftover punctuation / extra spaces
    cleaned = cleaned.replace(/^[\s,;:!?.…—–-]+/, "")
                     .replace(/\s{2,}/g, " ")
                     .trim();

    return { cleaned, hadSounds };
}

// ─── Sound playback ────────────────────────────────────────────────────────

/** Track last played file per folder to avoid immediate repeats */
const _lastPlayed = new Map();

/** Max seconds for any creature sound clip — keeps grunts/growls short and punchy */
const MAX_CREATURE_SFX_SECONDS = 2.5;

/**
 * Plays a random creature sound from the given folder.
 * Broadcasts to all connected clients via socket.
 * @param {string} folder  e.g. "beast", "dragon", "undead"
 * @param {number} pitch   playbackRate multiplier (0.7 = deep, 1.0 = normal)
 * @returns {Promise<boolean>} true if a sound was played
 */
export async function playCreatureSound(folder, pitch = 1.0) {
    // Accepts a single folder or an ordered candidate list. Falls through to the
    // next candidate when one is empty, so a partly-stocked library still makes
    // noise instead of the creature going mute.
    const candidates = Array.isArray(folder) ? folder.filter(Boolean) : [folder].filter(Boolean);
    let files = [];
    let used = null;
    for (const c of candidates) {
        files = await _getFiles(c);
        if (files.length) { used = c; break; }
    }
    if (!files.length) {
        console.warn(`${TAG} | No creature sounds available for ${candidates.map(c => `"${c}"`).join(" → ") || "(no folder)"}. ` +
            `Drop .mp3/.wav/.ogg files into modules/${MODULE_ID}/sounds/creatures/<folder>/ and they are picked up within 2 minutes.`);
        return false;
    }
    folder = used;

    // Pick random, avoiding immediate repeat
    let src;
    const last = _lastPlayed.get(folder);
    if (files.length === 1) {
        src = files[0];
    } else {
        do {
            src = files[Math.floor(Math.random() * files.length)];
        } while (src === last && files.length > 1);
    }
    _lastPlayed.set(folder, src);

    console.log(`ACE: Engine | Creature sound: ${src} (pitch ${pitch})`);

    // Broadcast to other clients — send file path + pitch + duration cap
    try {
        game.socket.emit(`module.${MODULE_ID}`, {
            action:  "playCreatureSound",
            src,
            pitch,
            maxDuration: MAX_CREATURE_SFX_SECONDS,
            exclude: game.user.id,
        });
    } catch (e) {
        console.warn("ACE: Engine | Creature sound broadcast failed:", e);
    }

    // Play locally via ttsEngine (re-uses AudioContext, awaits completion)
    try {
        const { ttsEngine } = await import("./tts.mjs");
        const resp   = await fetch(src);
        const buffer = await resp.arrayBuffer();
        await ttsEngine.playBuffer(buffer, pitch, MAX_CREATURE_SFX_SECONDS);
    } catch (e) {
        console.error("ACE: Engine | Creature sound playback error:", e);
    }

    return true;
}
