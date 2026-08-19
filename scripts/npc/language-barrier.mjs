/**
 * ACE: Engine — LANGUAGE BARRIER
 * ─────────────────────────────────────────────────────────────────────────────
 * Can these two creatures actually understand each other?
 *
 * Johnny 2026-08-07: an elf who speaks no Common should not hold a fluent
 * conversation with a party who speaks nothing else. He should fail to
 * understand, and try to get his meaning across by POINTING — which is a better
 * scene than a translation.
 *
 * ⚠️ READS dnd5e's OWN TRAIT BLOCK, NOT POLYGLOT.
 * Polyglot is wonderful and Johnny owns it, but ACE ships to people who don't.
 * Every language decision here comes from `system.traits.languages`, which
 * exists on every actor in the system. Polyglot is used for ONE thing and only
 * when present: rendering the words as scrambled Elvish glyphs in chat, via the
 * `flags.polyglot.language` flag it already reads. Without Polyglot the feature
 * still works — the barrier still bites, the gestures still happen, the line
 * just isn't scrambled. Same principle as Sequencer: a bonus, never a
 * requirement.
 */

const MODULE_ID = "ace-engine";

/** dnd5e's own key for the trade tongue. */
export const COMMON = "common";

/**
 * STATBLOCK BOILERPLATE THAT IS NOT A LANGUAGE. (Johnny 2026-08-07)
 *
 * Savid's language list read: "…, orc, any one language (usually Common)".
 * That last entry is not a tongue anyone speaks — it is an instruction to the
 * GM to pick one, printed in the Monster Manual and carried verbatim into the
 * `custom` free-text field by every importer. Offering it in a "which language
 * is he speaking" dropdown is nonsense, and counting it toward a shared-language
 * check is worse: two creatures could "share" the phrase and be judged mutually
 * intelligible on the strength of an editorial note.
 *
 * ⚠️ FILTERED AT THE READER, NOT DELETED FROM THE ACTOR. Johnny asked whether
 * to strip it from the creature's traits; the answer is no. It is his world
 * data, it came from the compendium, and it would return on the next import —
 * on his world and on every customer's. Doppelgangers, cultists and half the
 * Monster Manual carry some version of it. Fixing it here fixes it once, for
 * everyone, permanently.
 *
 * Deliberately narrow: it matches the "any N language(s)" family and the
 * "understands but cannot speak" note. Anything that might be a real invented
 * tongue is left alone — a GM who typed a language meant it.
 */
const NOT_A_LANGUAGE = [
    /^any\b.*\blanguages?\b/i,          // "any one language (usually Common)", "any two languages"
    /^one language\b/i,                 // "one language known by its creator"
    /^two languages\b/i,
    /^all\b.*\blanguages?\b/i,          // "all languages it knew in life"
    /^the languages? it knew in life/i,
    /^understands?\b.*\bbut\b.*\bspeaks?\b/i,   // "understands Common but can't speak it"
    /^(none|n\/?a|-+)$/i,               // literal "none", "—"
    // Orphan clause fragments. Splitting "one language known by its creator,
    // but can't speak" on the comma leaves "but can't speak" behind, and
    // without these it would be registered as a language in its own right —
    // caught by the self-test, not by reading the code. (2026-08-07)
    // ⚠️ ALL OF THESE REQUIRE A FOLLOWING SPACE, so they only ever match a
    // CLAUSE and never a single word. Without that, `can'?t` matched **Cant** —
    // Thieves' Cant, a real language Savid speaks — and silently deleted it.
    // Caught by the self-test, not by reading the code. Never write a
    // boilerplate pattern that can swallow a one-word language.
    /^but\s/i,
    /^(can'?t|cannot|unable to)\s/i,
    /^(and|or|though|although)\s/i,
    /^(usually|typically|often)\s/i,    // "…, usually Common"
];

/** Is this entry editorial boilerplate rather than something a creature speaks? */
function _isBoilerplate(text) {
    const t = String(text ?? "").trim();
    if (!t) return true;
    return NOT_A_LANGUAGE.some(re => re.test(t));
}

/**
 * Flatten dnd5e's language config into { key: label }.
 *
 * The shape has moved around between system versions — flat in old ones,
 * grouped under `standard` / `exotic` with a `children` map in current ones,
 * and a child can be a bare string OR an object carrying `.label`. Handle all
 * of it rather than pick one and be wrong after the next system update.
 */
export function languageCatalogue() {
    const out = {};
    const add = (k, v) => {
        if (!k) return;
        const label = (typeof v === "string") ? v : (v?.label ?? v?.name ?? null);
        out[String(k).toLowerCase()] = label || _titleCase(k);
    };
    try {
        const cfg = CONFIG?.DND5E?.languages ?? {};
        for (const [k, v] of Object.entries(cfg)) {
            if (v && typeof v === "object" && v.children) {
                for (const [ck, cv] of Object.entries(v.children)) add(ck, cv);
                // A group can also be selectable in its own right (e.g. "exotic").
                if (v.label && !Object.keys(v.children).length) add(k, v);
            } else {
                add(k, v);
            }
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | language catalogue unavailable:`, err);
    }
    return out;
}

function _titleCase(s) {
    return String(s ?? "").replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/** Human label for a language key — falls back to a tidied key, never blank. */
export function labelFor(key) {
    if (!key) return "";
    const k = String(key).toLowerCase();
    return languageCatalogue()[k] ?? _titleCase(k);
}

/**
 * Every language this creature knows, as lowercase keys.
 *
 * `traits.languages.value` is a Set in current dnd5e and an Array in older
 * ones. The `custom` field is free text ("Thieves' Cant; Old Suloise") and is
 * split on the separators the system itself uses, so a hand-written language
 * still counts — a GM who typed it meant it.
 */
export function readLanguages(actor) {
    const out = new Set();
    try {
        const langs = actor?.system?.traits?.languages;
        if (!langs) return out;
        const raw = langs.value;
        const list = (raw instanceof Set) ? [...raw] : (Array.isArray(raw) ? raw : []);
        for (const l of list) if (l && !_isBoilerplate(l)) out.add(String(l).toLowerCase());

        // The `custom` field is free text and is where the statblock boilerplate
        // lives. Split on the separators the system itself uses, then drop
        // anything that is an editorial note rather than a tongue.
        const custom = String(langs.custom ?? "").trim();
        if (custom) {
            for (const piece of custom.split(/[;,]/)) {
                const p = piece.trim();
                if (!p) continue;
                if (_isBoilerplate(p)) {
                    console.debug(`${MODULE_ID} | languages: ignoring statblock note "${p}" on ${actor?.name} — not a language.`);
                    continue;
                }
                out.add(p.toLowerCase());
            }
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | couldn't read languages for ${actor?.name}:`, err);
    }
    return out;
}

/**
 * The languages this creature can be SPOKEN AS, for the GM's dropdown.
 * Sorted with Common first when it has it, then alphabetically by label, so
 * the list reads the way a GM expects and the default is one click away.
 */
export function speakableLanguages(actor) {
    const keys = [...readLanguages(actor)];
    const cat = languageCatalogue();
    const rows = keys.map(k => ({ key: k, label: cat[k] ?? _titleCase(k) }));
    rows.sort((a, b) => {
        if (a.key === COMMON) return -1;
        if (b.key === COMMON) return 1;
        return a.label.localeCompare(b.label);
    });
    return rows;
}

/**
 * Which language the GM's dropdown should start on.
 *
 * Johnny: "the default should be common — but only if the NPC speaks common.
 * If it doesn't have it, it goes to whatever it does have." Most conversations
 * are in the trade tongue, so that is the sane default; a creature with no
 * Common falls to its own first language rather than silently speaking a
 * tongue it does not know.
 */
export function defaultLanguageFor(actor) {
    const known = readLanguages(actor);
    if (known.has(COMMON)) return COMMON;
    const rows = speakableLanguages(actor);
    return rows[0]?.key ?? null;      // null = this creature has no language at all
}

/**
 * Can the LISTENER understand something said in `language`?
 * A creature with no languages recorded understands nothing — but see
 * `describeBarrier`, which refuses to enforce a barrier it cannot evidence.
 */
export function understands(listenerActor, language) {
    if (!language) return true;                     // nothing declared → don't invent a barrier
    return readLanguages(listenerActor).has(String(language).toLowerCase());
}

/**
 * THE READER. Everything about whether these two can talk, in one answer.
 *
 * ⚠️ FAILS OPEN, DELIBERATELY. If either side has NO languages recorded at all
 * — a homebrew statblock, a monster nobody filled in — this reports that they
 * understand each other. A barrier is a hard block on play, and blocking a
 * scene because of missing data would be the module inventing a rule out of an
 * empty field. Same principle as the immunity gate in ace-qol: never stop
 * something on a fact we could not read.
 *
 * @returns {{understands:boolean, shared:string[], npc:string[], speaker:string[],
 *            reason:string, npcDefault:string|null}}
 */
export function describeBarrier(npcActor, speakerActor) {
    const npc = [...readLanguages(npcActor)];
    const speaker = [...readLanguages(speakerActor)];
    const npcDefault = defaultLanguageFor(npcActor);

    if (!npc.length || !speaker.length) {
        return {
            understands: true, shared: [], npc, speaker, npcDefault,
            reason: !npc.length
                ? `${npcActor?.name ?? "This creature"} has no languages recorded — assuming it understands.`
                : `${speakerActor?.name ?? "The speaker"} has no languages recorded — assuming they are understood.`,
        };
    }

    const npcSet = new Set(npc);
    const shared = speaker.filter(l => npcSet.has(l));
    return {
        understands: shared.length > 0,
        shared, npc, speaker, npcDefault,
        reason: shared.length
            ? `Shared: ${shared.map(labelFor).join(", ")}.`
            : `No shared language. ${npcActor?.name ?? "They"} speaks ${npc.map(labelFor).join(", ")}; `
              + `${speakerActor?.name ?? "the speaker"} speaks ${speaker.map(labelFor).join(", ")}.`,
    };
}

/**
 * The instruction handed to the AI when it cannot understand a word.
 *
 * Written as a scene direction rather than a rule, because that is what the
 * model is good at. It must NOT reply in the player's language, must NOT
 * secretly understand, and must NOT narrate the player's meaning back — the
 * whole point is that it does not know what was said and is guessing from
 * tone, volume and pointing.
 */
export function gesturePromptFor(npcActor, speakerActor, barrier) {
    const npcLangs = barrier.npc.map(labelFor).join(", ") || "no known language";
    const spk = speakerActor?.name ?? "the speaker";
    return `
LANGUAGE BARRIER — THIS IS THE MOST IMPORTANT RULE IN THIS PROMPT.
You do NOT speak or understand any language ${spk} is using. You speak ${npcLangs}.
You have just heard a stream of sounds that mean NOTHING to you.

Therefore:
- Do NOT answer the question. You do not know what was asked.
- Do NOT repeat, paraphrase or hint at what they said. You did not understand it.
- You MAY judge their TONE — angry, pleading, frightened, friendly — and their
  posture, gestures and where they are looking. That is all you have.
- Lead with ACTION: point, beckon, shake your head, hold up fingers, draw in
  the dust, mime, back away, bar the door, offer an object. Write these as
  *emotes between asterisks*.
- AND SAY SOMETHING. You are not mute — you are foreign. Most of the time you
  WOULD answer out loud in ${npcLangs}, because that is what a person does when
  they are spoken to. Keep it short: a name, a refusal, a warning, a question of
  your own, a word repeated louder and slower as if that would help.
  Say nothing only when the character genuinely would stay silent.
- Show your own frustration or patience as the character would.

⚠️ FORMAT — GET THIS EXACTLY RIGHT OR THE LINE IS NEVER SPOKEN ALOUD:
Words you SAY go on their OWN LINE, OUTSIDE any asterisks, in quotes.
Actions go inside *asterisks*. NEVER put spoken words inside the asterisks.

WRONG (this is narration, and the voice will never say it):
  *With a shake of his head he repeats, "Savid!" impatiently.*

RIGHT:
  *He shakes his head, impatient.*
  "Savid! Savid!"

Full shape (do not copy the wording):
  *tilts his head, brow furrowed, catching none of it*
  "Who are you? What do you want?"
  *jabs a finger hard at the door, then at you, then at the door again*
`.trim();
}

/**
 * Stamp a chat message so Polyglot renders it in that language's script.
 *
 * `flags.polyglot.language` is the flag Polyglot itself reads
 * (module/polyglot.js — `message.getFlag("polyglot", "language")`), so this is
 * its public contract rather than a reach into its internals. Harmless when
 * Polyglot is absent: it is just an unread flag.
 *
 * Returns flag data to merge into a ChatMessage.create payload.
 */
export function polyglotFlags(language) {
    if (!language) return {};
    return { polyglot: { language: String(language).toLowerCase() } };
}

/** Is Polyglot actually installed and running? Used only for GM messaging. */
export function polyglotActive() {
    try { return game.modules.get("polyglot")?.active === true; }
    catch (_) { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SPOKEN SUBSTITUTION — what a foreign tongue SOUNDS like out loud
// ═══════════════════════════════════════════════════════════════════════════
//
// Polyglot scrambles TEXT. Nothing scrambles AUDIO — so the moment an NPC
// actually SPEAKS a line the party can't follow, the voice read it aloud in
// plain English and the whole barrier leaked through their ears.
//
// The cure: the model writes the line twice in one reply — the MEANING in
// English (which goes to chat, where Polyglot decides who can read it) and the
// SOUND in a real language nobody at the table speaks (which is what the voice
// actually says). One call, no extra latency, no extra cost.
//
// ⚠️ WHY THE ENGLISH STILL GOES TO CHAT. The obvious shortcut — have the AI
// just answer in Finnish — breaks the one person the feature exists to reward:
// a player who genuinely READS Elvish would be shown Finnish, which they can't
// read either. English in the log + Polyglot's per-viewer scrambling is the
// only shape where the Elvish-reader gets the meaning and nobody else does.

/** ElevenLabs `eleven_multilingual_v2` speaks these. Anything else is silence. */
export const TTS_LANGUAGES = {
    invented:   "— Invented (no real language) —",
    bulgarian:  "Bulgarian",  croatian: "Croatian",  czech:     "Czech",
    danish:     "Danish",     dutch:    "Dutch",     filipino:  "Filipino",
    finnish:    "Finnish",    french:   "French",    german:    "German",
    greek:      "Greek",      hindi:    "Hindi",     hungarian: "Hungarian",
    indonesian: "Indonesian", italian:  "Italian",   japanese:  "Japanese",
    korean:     "Korean",     malay:    "Malay",     polish:    "Polish",
    portuguese: "Portuguese", romanian: "Romanian",  russian:   "Russian",
    slovak:     "Slovak",     spanish:  "Spanish",   swedish:   "Swedish",
    tamil:      "Tamil",      turkish:  "Turkish",   ukrainian: "Ukrainian",
};

/**
 * SHIPPED DEFAULTS — deliberate, and defensible in public.
 *
 * Mortal tongues borrow real languages, which is Tolkien's own trick: he built
 * Quenya on Finnish, so Elvish → Finnish is the source rather than a joke.
 *
 * ⚠️ FIEND AND ABERRATION TONGUES ARE **INVENTED** ON PURPOSE.
 * Abyssal, Infernal, Deep Speech and Orc map to no living language. Two
 * reasons, and the second is the one that matters commercially:
 *   • It is better fiction. Abyssal should sound like nothing on Earth;
 *     pinning it to a modern nation makes it smaller, not scarier. Tolkien
 *     invented the Black Speech from scratch for exactly this reason.
 *   • "The demon language is Spanish" reads very differently in Madrid than it
 *     does at the author's desk, and ACE ships worldwide. The module must not
 *     make that statement on a GM's behalf.
 * A GM who wants it can set it themselves in the table — their world, their
 * call. The DEFAULTS take no position on anyone. (Johnny agreed 2026-08-07.)
 */
export const DEFAULT_SPOKEN_MAP = {
    elvish:      "finnish",     // Tolkien built Quenya on Finnish
    dwarvish:    "hungarian",   // hard, consonant-heavy
    giant:       "swedish",     // Norse weight
    draconic:    "greek",       // old, formal, imperious
    halfling:    "dutch",       // homely
    gnomish:     "dutch",
    undercommon: "ukrainian",
    goblin:      "czech",       // clipped
    sylvan:      "finnish",
    primordial:  "finnish",
    celestial:   "italian",
    orc:         "invented",    // Black Speech was invented — keep it that way
    abyssal:     "invented",
    infernal:    "invented",
    "deep speech": "invented",
    druidic:     "invented",
    cant:        "invented",    // Thieves' Cant is argot, not a nation's tongue
};

const SETTING_MAP     = "spokenLanguageMap";
const SETTING_ENABLED = "spokenLanguageSubstitution";

/** The live map: shipped defaults with the GM's edits laid over the top. */
export function spokenMap() {
    let stored = {};
    try { stored = game.settings.get(MODULE_ID, SETTING_MAP) ?? {}; }
    catch (_) { stored = {}; }
    return { ...DEFAULT_SPOKEN_MAP, ...stored };
}

/** Is spoken substitution switched on? Defaults ON (Johnny 2026-08-07). */
export function substitutionEnabled() {
    try { return game.settings.get(MODULE_ID, SETTING_ENABLED) !== false; }
    catch (_) { return true; }
}

/**
 * Which real language should this tongue SOUND like?
 * Returns null for "invented" or an unmapped tongue — the caller then asks the
 * model for invented phonetics instead of a real language.
 */
export function spokenLanguageFor(languageKey) {
    if (!languageKey) return null;
    const k = String(languageKey).toLowerCase();
    const v = spokenMap()[k];
    if (!v || v === "invented") return null;
    return TTS_LANGUAGES[v] ? v : null;
}

/** Human label, e.g. "finnish" -> "Finnish". */
export function spokenLabel(key) {
    return TTS_LANGUAGES[String(key ?? "").toLowerCase()] ?? "Invented";
}

/** Every fantasy tongue worth offering a row for in the settings table. */
export function mappableLanguages() {
    const cat = languageCatalogue();
    const keys = new Set([...Object.keys(cat), ...Object.keys(DEFAULT_SPOKEN_MAP)]);
    keys.delete(COMMON);          // Common is the table's baseline — never substituted
    return [...keys]
        .map(k => ({ key: k, label: cat[k] ?? _titleCase(k) }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * ⚠️ THE [SPOKEN] MARKER APPROACH WAS REMOVED. (2026-08-07)
 *
 * It asked the model to write every spoken line twice — once in English, once
 * in the stand-in language behind a `[SPOKEN]` marker — and parsed the marker
 * back out. It looked elegant and it did not work: mid-roleplay the model
 * simply stopped emitting the marker, and worse, buried the dialogue inside an
 * *emote* so there was no spoken line at all. Johnny heard plain English every
 * time. A format the model has to remember while also acting a character is a
 * format it will drop.
 *
 * Replaced by a dedicated, deterministic step — AIHandler.renderSpoken() takes
 * the finished line and renders it in the target language, one call, one job,
 * nothing to forget. It also fixed the GM's puppet lines for free, which the
 * marker never covered at all.
 */

/**
 * Should this line be SPOKEN in a stand-in language rather than read in English?
 *
 * Only when the listener genuinely cannot understand it. If they share the
 * tongue there is no meaning to protect and the table needs to follow the
 * scene, so it stays in English.
 */
export function shouldSubstituteAudio(npcLanguageKey, listenerActor) {
    if (!substitutionEnabled()) return false;
    if (!npcLanguageKey) return false;
    if (String(npcLanguageKey).toLowerCase() === COMMON) return false;
    // A listener we know nothing about is treated as not understanding — the
    // NPC is demonstrably speaking a non-Common tongue, so foreign audio is the
    // safe reading. (Failing the other way would leak meaning.)
    if (!listenerActor) return true;
    return !understands(listenerActor, npcLanguageKey);
}

/**
 * Build what the VOICE should say, given the chat copy and the foreign line.
 *
 * Keeps every *emote* exactly where it was — those are the narrator's, and the
 * narrator speaks English on purpose (Johnny's option 2: describe the manner,
 * so a listener who understands nothing still reads anger or pleading). Only
 * the DIALOGUE is swapped for the foreign rendering (option 3).
 *
 * Result: the narrator says "he snaps something clipped and angry", the NPC's
 * own voice makes the foreign sounds, and no meaning reaches an ear that
 * shouldn't have it.
 */
export function buildSpokenText(display, spoken) {
    if (!spoken) return display;
    const emotes = String(display ?? "").match(/\*[^*]+\*/g) ?? [];
    // Emotes first (the manner), then the foreign line — which is the order a
    // GM narrates it: you see him react, then you hear the noise.
    return [...emotes, spoken].join(" ").trim();
}

/**
 * DESCRIBE AN UTTERANCE WITHOUT REVEALING IT. (2026-08-07)
 *
 * ⚠️ THE FIX FOR THE REAL BUG. Telling the model "do not understand this" while
 * still handing it the sentence does not work, and Johnny caught it live: he
 * typed "I am your new master" at an elf who speaks no Common, and the elf
 * folded his arms **defiantly** — a reaction to the MEANING of a line he could
 * not possibly have parsed. Instructions cannot make a model un-know something
 * it has already read.
 *
 * So the words never reach it. This turns a line into what a listener who
 * shares no language would actually perceive — volume, cadence, whether it
 * rose like a question or landed like an order — and that description is what
 * the model is given instead.
 *
 * Derived locally, from punctuation and shape. No second AI call, no cost, and
 * — the point — no path by which the meaning can leak.
 */
export function describeUtterance(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return "a short, unclear sound";

    const words   = raw.split(/\s+/).filter(Boolean).length;
    const letters = raw.replace(/[^a-z]/gi, "");
    const shouty  = letters.length > 3 && letters === letters.toUpperCase();
    const bangs   = (raw.match(/!/g) ?? []).length;
    const asks    = /\?\s*$/.test(raw);

    const bits = [];

    // Volume / force
    if (shouty || bangs >= 2)      bits.push("shouted, loud and forceful");
    else if (bangs === 1)          bits.push("sharp and emphatic");
    else                           bits.push("spoken at a normal volume");

    // Shape
    if (asks)                      bits.push("rising at the end like a question");
    else if (/\.\.\.|…/.test(raw)) bits.push("trailing off, hesitant");
    else                           bits.push("flat and declarative, like a statement");

    // Length — a listener can judge this perfectly well without understanding.
    if (words <= 3)                bits.push("only a few words");
    else if (words <= 12)          bits.push("a single short sentence");
    else if (words <= 30)          bits.push("a few sentences");
    else                           bits.push("a long speech");

    return bits.join(", ");
}

/**
 * What the model is given INSTEAD of the player's line when it cannot understand.
 * Deliberately reads as a stage direction, not as dialogue, so there is nothing
 * to answer even if the model tries.
 */
export function maskedUtterance(text, speakerName = "Someone") {
    return `[${speakerName} speaks to you in a language you do not know. `
         + `You catch none of the words. What you can tell: it was ${describeUtterance(text)}.]`;
}
