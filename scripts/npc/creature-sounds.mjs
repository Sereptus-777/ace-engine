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

// ═══════════════════════════════════════════════════════════════════════════
//  PICKING THE RIGHT CLIP — scoring, not a blacklist (2026-08-06)
//
//  Johnny bulk-downloaded a giant pack, and roughly half of it is not a voice:
//  stomping_ground, medium_thud, cymbal_bass, closing_large_metal_door,
//  frontdoorclose, placing_the_dumbells_on_the_floor, battle_mech_walks,
//  ivan_rockanov. The old blacklist caught "footstep" and "loop" and let every
//  one of those through, so a random pick made an ogre answer with a door.
//
//  A blacklist can only ever exclude what somebody thought of. Scoring flips
//  it: every file is rated on how much it looks like a creature vocalisation,
//  and on how well it matches THIS creature, then the best tier is chosen from
//  at random. New junk scores low automatically; a well-named clip wins without
//  anyone maintaining a list. No AI call — this is filename maths, instant and
//  free, run over a cached listing.
// ═══════════════════════════════════════════════════════════════════════════

/** Words that mean "a creature made this noise with its body". */
const VOICE_WORDS = [
    "roar", "growl", "snarl", "grunt", "howl", "screech", "shriek", "scream",
    "hiss", "bellow", "moan", "groan", "wail", "squeal", "chitter", "yelp",
    "bark", "cry", "gurgle", "rasp", "breath", "pant", "chatter", "croak",
    "warble", "trill", "purr", "snort", "huff", "grumble", "murmur",
    "vocal", "voice", "call", "sound", "creature", "monster", "beast",
];

/** Words that mean "this is NOT a mouth noise", however it is named. */
const NOT_VOICE_WORDS = [
    // movement + impacts
    "footstep", "foot_step", "step", "stepping", "walk", "walking", "run",
    "running", "stomp", "stomping", "thud", "thump", "impact", "land",
    // objects, rooms, machinery
    "door", "gate", "chest", "metal", "wood", "stone_drag", "chain",
    "machine", "mech", "robot", "engine", "motor", "servo", "electric",
    "dumbell", "dumbbell", "floor", "furniture", "glass", "crate",
    // music + production
    "cymbal", "drum", "kick", "snare", "bass_", "loop", "beat", "music",
    "melody", "chord", "synth", "moombahton", "trap_", "riser", "sting",
    // ambience + misc
    "ambien", "wind", "rain", "fire_crackle", "water", "cartoon", "sci_fi",
    "scifi", "light_saber", "lightsaber", "singing", "song", "speech",
    "dialogue", "narration", "silence", "test", "untitled",
    // ⚠️ NEVER AT SOMEONE'S TABLE. A bulk sound download drags in things nobody
    // inspected; "ghost_sex_moaning_1.mp3" was sitting in the undead TOP TIER,
    // one roll away from playing in front of a family group. Scored -1 on the
    // name alone, so no amount of good luck is required. (2026-08-06)
    "sex", "porn", "orgasm", "erotic", "nsfw", "moaning_woman", "moaning_man",
    // ⚠️ BRANDED AUDIO IS A LICENSING PROBLEM ON A PAID MODULE. A file named
    // for a commercial game is very likely ripped from it. Refusing to PLAY it
    // is not a licence — the file still has to be deleted — but it stops a rip
    // reaching a customer while the library is being cleaned up.
    "animal_crossing", "zelda", "mario", "skyrim", "minecraft", "pokemon",
    "witcher", "warcraft", "diablo", "elden_ring", "dark_souls", "fortnite",
];

/**
 * Rate one filename for this creature. Higher is better; NEGATIVE means never
 * play it.
 *
 * @param {string} file   full path or bare filename
 * @param {string[]} affinities  lowercase words identifying the creature —
 *        its species, its name, its folder. "ogre" beats "giant" beats nothing.
 */
export function scoreCreatureSound(file, affinities = []) {
    const base = String(file).split("/").pop().toLowerCase()
        .replace(/\.[^.]+$/, "")
        .replace(/^fs[_-]?\d+[_-]?/, "")   // strip freesound id prefixes
        .replace(/[^a-z0-9]+/g, "_");

    // A disqualifier is absolute — a "giant_footsteps" clip is a footstep no
    // matter how many other words look promising.
    for (const bad of NOT_VOICE_WORDS) {
        if (base.includes(bad)) return -1;
    }

    let score = 0;
    for (const good of VOICE_WORDS) {
        if (base.includes(good)) { score += 10; break; }   // one hit is enough
    }
    // Creature affinity: the more specific the match, the better. "ogre-roar"
    // must beat "giant-roar", which must beat "big-monster-roar".
    affinities.forEach((word, i) => {
        if (word && word.length >= 3 && base.includes(word)) {
            score += 20 - Math.min(i * 4, 12);            // earlier = more specific
        }
    });
    return score;
}


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

/** The shared, world-stored listing. Readable by EVERYONE. */
function _readIndex() {
    try { return game.settings.get(MODULE_ID, "creatureSoundIndex") ?? {}; }
    catch (_) { return {}; }
}

async function _getFiles(folder) {
    if (!folder) return [];

    // ── PLAYERS READ THE INDEX (2026-08-07) ──────────────────────────────
    // Foundry hard-refuses FilePicker.browse for non-GMs, in its own words:
    //   "You do not have permission to browse the host file system!"
    // That is a PERMISSION, not a bug, and no amount of retrying changes it.
    // Every player therefore heard silence. Asking the GM to resolve it at play
    // time (the first fix) only worked while a GM happened to be connected —
    // Johnny was testing solo as a player, so nobody answered.
    // The GM now resolves the folders ONCE and publishes the listing to world
    // data, which any client can read instantly: no permission, no round-trip,
    // no GM required online.
    if (!game.user?.isGM) {
        const hit = _readIndex()?.[folder];
        return Array.isArray(hit) ? hit : [];
    }
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
            // Keep every audio file — scoring picks the winner at play time, so
            // a clip is judged against the creature asking for it rather than
            // against a fixed list.
            const files = all.filter(f => /\.(mp3|wav|ogg|flac|webm)$/i.test(f));
            if (files.length) {
                _fileCache.set(cacheKey, { files, ts: now });
                _rememberForPlayers(folder, files);   // publish it for everyone
                return files;
            }
            // Folder exists but yielded nothing — say WHICH of the two it was,
            // because "no files" and "every file filtered out" need different
            // fixes and used to look identical.
            console.warn(`${TAG} | "${path}" holds ${all.length} entr${all.length === 1 ? "y" : "ies"} but no audio files` +
                (all.length ? " — accepted extensions are .mp3 .wav .ogg .flac .webm." : " — the folder is empty."));
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
 * Publish the speaking-portrait (.webp) folder listing.
 *
 * Same problem as the sounds, same cure. The conversation window used to probe
 * for "<name>.webp" by creating an <img> and seeing whether it errored — which
 * printed a red 404 per candidate, three per conversation, in every player's
 * console. Players cannot list files to check first, so the GM publishes the
 * folder contents once and every client reads it.
 */
export async function rebuildSpeakingWebpIndex() {
    if (!game.user?.isGM) return null;
    let folder = "NPCs/webps";
    try { folder = (game.settings.get(MODULE_ID, "npcWebpFolder") || folder); } catch (_) {}
    folder = String(folder).replace(/^\/+|\/+$/g, "");

    const FP = _filePicker();
    if (!FP?.browse) return null;
    try {
        const res = await FP.browse("data", folder);
        // Store bare lowercase stems — the lookup is by creature name.
        const stems = (res.files || [])
            .filter(f => /\.webp$/i.test(f))
            .map(f => decodeURIComponent(f.split("/").pop()).replace(/\.webp$/i, "").toLowerCase());
        const idx = { folder, stems, _builtAt: Date.now() };
        await game.settings.set(MODULE_ID, "speakingWebpIndex", idx);
        console.log(`${TAG} | Speaking-portrait index published: ${stems.length} .webp file(s) in "${folder}".`);
        return idx;
    } catch (err) {
        // An absent folder is normal — most tables have no speaking portraits.
        console.log(`${TAG} | No speaking-portrait folder at "${folder}" (that is fine — the feature is optional).`);
        try { await game.settings.set(MODULE_ID, "speakingWebpIndex", { folder, stems: [], _builtAt: Date.now() }); } catch (_) {}
        return null;
    }
}

/**
 * Publish one folder's listing to world data so players can read it.
 * GM-only — only a GM may write a world setting. Skips the write when the
 * listing has not changed, so this costs nothing on the common path.
 */
async function _rememberForPlayers(folder, files) {
    if (!game.user?.isGM) return;
    try {
        const idx = _readIndex();
        const prev = idx[folder];
        if (Array.isArray(prev) && prev.length === files.length
            && prev.every((f, i) => f === files[i])) return;   // unchanged
        idx[folder] = files;
        idx._builtAt = Date.now();
        await game.settings.set(MODULE_ID, "creatureSoundIndex", idx);
        console.log(`${TAG} | Published ${files.length} "${folder}" clips to the world index — players can hear them now.`);
    } catch (err) {
        console.warn(`${TAG} | Could not publish the "${folder}" listing:`, err?.message ?? err);
    }
}

/**
 * Walk every folder and publish the whole index at once.
 * Runs automatically for the GM at startup; also available on demand after
 * adding sounds:
 *   game.modules.get("ace-engine").api.rebuildCreatureSoundIndex()
 */
export async function rebuildCreatureSoundIndex() {
    if (!game.user?.isGM) {
        console.warn(`${TAG} | Only the GM can build the creature-sound index.`);
        return null;
    }
    const folders = ["beast", "construct", "dragon", "elemental", "fiend", "flying",
                     "generic", "giant", "goblinoid", "insect", "monster", "ooze",
                     "serpent", "swarm", "undead"];
    _fileCache.clear();
    const idx = {};
    let total = 0;
    for (const f of folders) {
        const files = await _getFiles(f);
        if (files.length) { idx[f] = files; total += files.length; }
    }
    idx._builtAt = Date.now();
    try {
        await game.settings.set(MODULE_ID, "creatureSoundIndex", idx);
        const n = Object.keys(idx).length - 1;
        console.log(`${TAG} | Creature-sound index published: ${total} clips across ${n} folders. Players can now hear creature sounds.`);
        return { folders: n, clips: total };
    } catch (err) {
        console.error(`${TAG} | Could not publish the creature-sound index:`, err);
        return null;
    }
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
/**
 * PLAY A BROADCAST CLIP. Registered on every client, once.
 *
 * ⚠️ THIS LISTENER DID NOT EXIST (found 2026-08-06 from Johnny's console).
 * playCreatureSound has always emitted `action: "playCreatureSound"` to the
 * other clients — and nothing anywhere was listening for it. The broadcast went
 * into the void, so a creature roar only ever played on the machine that chose
 * the file. Every player at the table heard silence while the GM heard a roar.
 */
let _csSocketWired = false;
export function wireCreatureSoundSocket() {
    if (_csSocketWired || !game?.socket) return;
    _csSocketWired = true;

    game.socket.on(`module.${MODULE_ID}`, async (data) => {
        try {
            // Someone chose a clip — play it here too.
            if (data?.action === "playCreatureSound" && data.src) {
                if (data.exclude && data.exclude === game.user.id) return;
                const { ttsEngine } = await import("./tts.mjs");
                const buf = await (await fetch(data.src)).arrayBuffer();
                await ttsEngine.playBuffer(buf, data.pitch ?? 1.0,
                                           data.maxDuration ?? MAX_CREATURE_SFX_SECONDS);
                return;
            }

            // A PLAYER cannot list files (FilePicker.browse is GM-only), so it
            // asks us to choose. Mirrors the ttsRequest proxy already used for
            // ElevenLabs. GM only, and only for a real user.
            if (data?.action === "creatureSoundRequest") {
                // Only the ACTIVE GM answers. With two GMs connected, both would
                // pick a clip and both would broadcast — the table hears the
                // roar twice, slightly out of sync. game.users.activeGM is the
                // same single-owner gate the rest of the engine uses for writes.
                if (game.users?.activeGM !== game.user) return;
                if (!game.users.get(data.userId)) return;   // ignore a stale sender
                await playCreatureSound(data.folder, data.pitch ?? 1.0, data.affinities ?? []);
            }
        } catch (err) {
            console.warn(`${TAG} | creature-sound socket handler failed:`, err);
        }
    });
    console.log(`${TAG} | Creature sound socket wired (broadcast receive + player proxy).`);
}

export async function playCreatureSound(folder, pitch = 1.0, affinities = []) {
    // ── PLAYERS CANNOT BROWSE FILES — ask the GM to pick (2026-08-06) ──────
    // FilePicker.browse is GM-only, so _getFiles returns [] on a player client
    // and every creature was mute for exactly the people the sound is FOR.
    // Johnny caught it on a client login: "No usable creature VOICE in giant"
    // while the giant folder holds 31 working clips.
    if (!game.user?.isGM) {
        // Once the index exists a player resolves and plays the clip itself, with
        // no GM online. Only fall back to asking a GM if it was never built.
        const idx = _readIndex();
        if (Object.keys(idx).some(k => k !== "_builtAt")) {
            return _resolveAndPlay(folder, pitch, affinities);
        }
        try {
            game.socket.emit(`module.${MODULE_ID}`, {
                action:  "creatureSoundRequest",
                userId:  game.user.id,
                folder, pitch, affinities,
            });
            console.warn(`${TAG} | No creature-sound index has been built yet, so this client asked a GM to choose. ` +
                `If nothing plays, the GM should log in once and run ` +
                `game.modules.get("${MODULE_ID}").api.rebuildCreatureSoundIndex().`);
            return true;
        } catch (err) {
            console.warn(`${TAG} | Could not ask the GM for a creature sound:`, err);
            return false;
        }
    }
    return _resolveAndPlay(folder, pitch, affinities);
}

async function _resolveAndPlay(folder, pitch = 1.0, affinities = []) {
    // Accepts a single folder or an ordered candidate list. Falls through to the
    // next candidate when one has nothing PLAYABLE — a folder full of footstep
    // clips is as useless as an empty one, so "has files" is not the test.
    const candidates = Array.isArray(folder) ? folder.filter(Boolean) : [folder].filter(Boolean);
    const affin = (Array.isArray(affinities) ? affinities : [affinities])
        .filter(Boolean).map(a => String(a).toLowerCase());

    let ranked = [];
    let used = null;
    let sawFiles = 0;
    for (const c of candidates) {
        const files = await _getFiles(c);
        sawFiles += files.length;
        // Score every file for THIS creature, drop the disqualified.
        const scored = files
            .map(f => ({ f, score: scoreCreatureSound(f, [...affin, c]) }))
            .filter(x => x.score >= 0)
            .sort((a, b) => b.score - a.score);
        if (scored.length) { ranked = scored; used = c; break; }
    }

    if (!ranked.length) {
        console.warn(`${TAG} | No usable creature VOICE in ${candidates.map(c => `"${c}"`).join(" → ") || "(no folder)"}` +
            (sawFiles ? ` — ${sawFiles} audio file(s) were found but every one scored as a non-voice (footsteps, impacts, doors, music). ` +
                        `Run game.modules.get("${MODULE_ID}").api.auditCreatureSounds() to see the scores.`
                      : ` — drop .mp3/.wav/.ogg clips into modules/${MODULE_ID}/sounds/creatures/<folder>/.`));
        return false;
    }
    folder = used;

    // Play from the BEST tier only. Everything sharing the top score is fair
    // game, so a well-stocked folder still varies instead of repeating one clip.
    const top = ranked[0].score;
    const best = ranked.filter(x => x.score === top).map(x => x.f);

    let src;
    const last = _lastPlayed.get(folder);
    if (best.length === 1) {
        src = best[0];
    } else {
        do {
            src = best[Math.floor(Math.random() * best.length)];
        } while (src === last && best.length > 1);
    }
    _lastPlayed.set(folder, src);

    console.log(`${TAG} | Creature sound: ${src.split("/").pop()} (score ${top}, chosen from ${best.length} of ${ranked.length} usable, pitch ${pitch})`);

    // Broadcast to other clients — send file path + pitch + duration cap
    try {
        game.socket.emit(`module.${MODULE_ID}`, {
            action:  "playCreatureSound",
            src,
            pitch,
            maxDuration: MAX_CREATURE_SFX_SECONDS,
            // When we are choosing ON BEHALF of a player, everyone needs it —
            // including the player who asked. `exclude` only ever means "not me".
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


/**
 * Print what the scorer thinks of every clip you have, folder by folder.
 *
 * Built because Johnny bulk-downloaded a giant pack where half the files were
 * doors, cymbals and footsteps — and there was no way to see that from inside
 * Foundry. Run it after adding sounds; anything marked REJECTED will never play
 * and can be deleted.
 *
 *   game.modules.get("ace-engine").api.auditCreatureSounds()
 */
export async function auditCreatureSounds(folders = null) {
    const list = folders ?? [
        "beast", "construct", "dragon", "elemental", "fiend", "flying",
        "generic", "giant", "goblinoid", "insect", "monster", "ooze",
        "serpent", "swarm", "undead",
    ];
    const summary = [];
    for (const folder of list) {
        const files = await _getFiles(folder);
        if (!files.length) { summary.push({ folder, total: 0, usable: 0, rejected: 0 }); continue; }
        const rows = files.map(f => ({
            file: f.split("/").pop(),
            score: scoreCreatureSound(f, [folder]),
        })).sort((a, b) => b.score - a.score);
        const usable = rows.filter(r => r.score >= 0);
        console.groupCollapsed(`${TAG} | ${folder} — ${usable.length} usable / ${rows.length} files`);
        console.table(rows.map(r => ({
            file: r.file,
            verdict: r.score < 0 ? "REJECTED (not a voice)" : r.score >= 20 ? "BEST MATCH" : "usable",
            score: r.score,
        })));
        console.groupEnd();
        summary.push({ folder, total: rows.length, usable: usable.length, rejected: rows.length - usable.length });
    }
    console.log(`${TAG} | Creature sound audit — folders with NO usable voice will fall back to monster/generic:`);
    console.table(summary);
    return summary;
}
