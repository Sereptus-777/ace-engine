// ─── Your NPCs keep their voices when the provider changes ───────────────────
//
// ⚠️ THE PROBLEM THIS SOLVES. Every NPC in Johnny's world carries an ElevenLabs
// voice id — a string like o3hzbFqcuIw2MRzP8rQf. It means nothing to Kokoro,
// nothing to Chatterbox, nothing to any local server. Switch the provider
// without a translation layer and one of two things happens, both bad:
//
//   • every NPC goes silent, or
//   • every NPC is handed a default voice, so the whole cast sounds identical
//
// And the naive fix — rewrite each actor's voiceId to a local one — is worse
// than either, because it DESTROYS the original. Switching back to ElevenLabs
// afterwards would find every id gone. A migration that cannot be reversed is
// not a migration, it is data loss with a friendly name.
//
// ⚠️ SO NOTHING IS EVER OVERWRITTEN. The ElevenLabs id stays exactly where it
// is, untouched, forever. This module holds a SEPARATE map from an ElevenLabs id
// to a local voice, consulted only while a local provider is selected. Switching
// back restores every original voice instantly, because they never left.
//
// ⚠️ AND IT IS KEYED BY VOICE, NOT BY CREATURE. Two NPCs sharing an ElevenLabs
// voice keep sharing one locally. An NPC that gets renamed — which ACE does
// constantly — keeps its voice, because the key is the voice id and not the
// name. Hashing a name would have re-voiced half the world the first time the
// namer ran.
const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | Voice map";

/**
 * Voices that ship with Kokoro, the Apache-2.0 engine ACE recommends for the
 * everyday cast. Used when the server does not advertise its own list.
 *
 * ⚠️ SPLIT BY GENDER ON PURPOSE. A stable-but-random assignment that gives a
 * grizzled bandit chief a bright young woman's voice is technically consistent
 * and useless at the table. Gender is the one attribute ACE already records for
 * every creature, so it is the one attribute the fallback can honour.
 */
const KOKORO_VOICES = {
    male:   ["am_adam", "am_michael", "am_fenrir", "am_puck", "am_onyx", "am_echo",
             "bm_george", "bm_lewis", "bm_daniel", "bm_fable"],
    female: ["af_bella", "af_nicole", "af_sarah", "af_sky", "af_heart", "af_river",
             "bf_emma", "bf_isabella", "bf_alice", "bf_lily"],
};

/** The stored map: { "<providerVoiceId>": "<localVoiceName>" }. */
export function getVoiceMap() {
    try { return foundry.utils.deepClone(game.settings.get(MODULE_ID, "voiceMap") ?? {}); }
    catch (_) { return {}; }
}

async function saveVoiceMap(map) {
    if (!game.user?.isGM) return false;
    try { await game.settings.set(MODULE_ID, "voiceMap", map); return true; }
    catch (err) { console.warn(`${TAG} | Could not save the voice map:`, err); return false; }
}

/**
 * A stable number from a string.
 *
 * ⚠️ STABLE ACROSS SESSIONS AND MACHINES. Not Math.random, not a Map insertion
 * order, not Date. The same voice id must produce the same local voice on the
 * GM's machine tonight, on a player's machine tomorrow, and after a world
 * restore, or an NPC's voice would drift and nobody would ever trust it.
 */
function stableHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
}

/**
 * Which voices the connected server actually offers, if it says so.
 *
 * ⚠️ ASK THE SERVER BEFORE ASSUMING. A built-in list is a guess about somebody
 * else's install; handing a server a voice it does not have produces either an
 * error per line or a silent substitution, and the second is worse. The probe
 * already fetches the server's own description, so the list is usually free.
 */
export async function availableVoices() {
    try {
        const { probe } = await import("./tts-local.mjs");
        const ready = await probe();
        const info = ready?.info;
        // Accept the shapes real servers use: a bare array, {voices:[...]},
        // or OpenAI's {data:[{id}]}.
        const raw = Array.isArray(info) ? info
                  : Array.isArray(info?.voices) ? info.voices
                  : Array.isArray(info?.data)   ? info.data
                  : null;
        if (raw?.length) {
            const names = raw.map(v => (typeof v === "string" ? v : (v?.id ?? v?.name ?? ""))).filter(Boolean);
            if (names.length) return { names, source: "the speech server" };
        }
    } catch (_) { /* fall through to the built-in list */ }
    return { names: [...KOKORO_VOICES.male, ...KOKORO_VOICES.female], source: "ACE's built-in Kokoro list" };
}

/**
 * The local voice for a provider voice id.
 *
 * Order: an explicit entry in the map, then a stable gender-aware assignment.
 * Never returns nothing — a missing voice means the whole line goes silent, and
 * a plausible voice beats silence every time.
 *
 * @param {string} voiceId    the id the rest of ACE stores (ElevenLabs, usually)
 * @param {string} gender     "male" | "female", when the caller knows it
 */
export function localVoiceFor(voiceId, gender = "") {
    const key = String(voiceId || "").trim();
    const map = getVoiceMap();
    if (key && map[key]) return map[key];

    // ⚠️ AN UNMAPPED VOICE IS STILL DETERMINISTIC. The hash is over the voice
    // id, so this NPC sounds the same in every session even though nobody has
    // opened the mapping screen. Without that, an unmapped world would reshuffle
    // every voice on every reload and read as broken.
    const pool = (gender === "female") ? KOKORO_VOICES.female
               : (gender === "male")   ? KOKORO_VOICES.male
               // No gender recorded: draw from everything rather than defaulting
               // the whole world to male voices, which is what the old gender
               // detection did before it was made to toss a coin.
               : [...KOKORO_VOICES.male, ...KOKORO_VOICES.female];
    if (!key) return pool[0];
    return pool[stableHash(key) % pool.length];
}

/**
 * Look at the world and propose a map, gender-matched, without saving.
 *
 * ⚠️ IT READS THE GENDER ACE ALREADY DECIDED. resolveAndRecordGender writes a
 * gender onto every creature it names, and the voice engine reads the same flag,
 * so the map is built from the same fact rather than a second guess that could
 * disagree with it. Two sources for one fact is how a female name ends up with a
 * male voice.
 */
export async function proposeMap() {
    const byVoice = new Map();   // voiceId -> { male: n, female: n, names: [] }

    const note = (voiceId, gender, label) => {
        const key = String(voiceId || "").trim();
        if (!key) return;
        if (!byVoice.has(key)) byVoice.set(key, { male: 0, female: 0, names: [] });
        const row = byVoice.get(key);
        if (gender === "male" || gender === "female") row[gender]++;
        if (row.names.length < 4 && label) row.names.push(label);
    };

    const readOne = (doc, label) => {
        try {
            const v = doc?.getFlag?.(MODULE_ID, "voiceId");
            if (!v) return;
            const g = doc.getFlag(MODULE_ID, "genderOverride") || doc.getFlag(MODULE_ID, "voiceGender") || "";
            note(v, g, label);
        } catch (_) { /* unreadable flags are simply not counted */ }
    };

    for (const actor of (game.actors ?? [])) readOne(actor, actor.name);
    // ⚠️ Unlinked tokens hold their flags in a delta, so a sweep of game.actors
    // alone misses most of the creatures on the map.
    for (const scene of (game.scenes ?? [])) {
        for (const token of (scene.tokens ?? [])) {
            if (token.actorLink) continue;
            readOne(token.actor, token.name);
        }
    }

    const existing = getVoiceMap();
    const rows = [];
    for (const [voiceId, row] of byVoice.entries()) {
        const gender = row.female > row.male ? "female" : row.male > 0 ? "male" : "";
        rows.push({
            voiceId,
            users: row.names,
            gender: gender || "unknown",
            current: existing[voiceId] || "",
            proposed: existing[voiceId] || localVoiceFor(voiceId, gender),
        });
    }
    rows.sort((a, b) => b.users.length - a.users.length);
    return rows;
}

/**
 * Build and save the map for every voice in the world that has none yet.
 *
 * ⚠️ IT NEVER TOUCHES AN ENTRY THAT ALREADY EXISTS. A GM who has hand-picked a
 * voice for Strahd must be able to re-run this after adding NPCs without having
 * that choice quietly reassigned. Re-running a repair has to be safe or nobody
 * runs it twice.
 */
export async function autoMap({ dryRun = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications?.warn("Only the GM can build the voice map.");
        return { added: 0, kept: 0, rows: [] };
    }

    const rows = await proposeMap();
    const map = getVoiceMap();
    let added = 0, kept = 0;

    for (const row of rows) {
        if (map[row.voiceId]) { kept++; continue; }
        map[row.voiceId] = row.proposed;
        added++;
    }

    console.log(`${TAG} | ${dryRun ? "WOULD MAP" : "MAPPED"} ${added} voice(s); ${kept} already had a choice.`);
    for (const row of rows) {
        console.log(`   ${String(row.voiceId).padEnd(24)} ${String(row.gender).padEnd(8)}`
            + ` -> ${map[row.voiceId]}   (${row.users.slice(0, 3).join(", ") || "nobody using it"})`);
    }

    if (!dryRun && added) {
        await saveVoiceMap(map);
        ui.notifications?.info(`ACE: mapped ${added} voice(s) to local equivalents. Your ElevenLabs ids are untouched.`);
    }
    return { added, kept, rows };
}

/** Set one mapping by hand. */
export async function setMapping(voiceId, localVoice) {
    const map = getVoiceMap();
    if (localVoice) map[String(voiceId)] = String(localVoice);
    else delete map[String(voiceId)];
    return saveVoiceMap(map);
}
