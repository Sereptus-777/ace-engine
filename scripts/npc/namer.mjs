// ─── Naming is its own step, and its whole output is a name ──────────────────
//
// ⚠️🔴 WHY THIS FILE EXISTS. Naming used to be smuggled into the biography
// request as "put a NAME: line first". When the model skipped that line — which
// it does often — ACE went rummaging through the finished prose for the most
// frequent proper noun and crowned it.
//
// Johnny, 2026-08-23: "why is it writing a bio and then guessing the name? This
// can't be this fragile."
//
// It named a goblin **Mind Flayers** (the faction it served, mentioned three
// times) and, the following night, **Phandelver** (the town he had typed into
// the dialog's location box, in a bio the prompt had explicitly demanded be
// almost entirely about where the creature came from). Every fix was another
// exclusion rule — factions, places, scene names, species words, singulars and
// plurals — bolted onto a guess. That list can never be finished, because prose
// is not a data format.
//
// So the order flips. **The name is decided BEFORE the biography exists**, from
// a request whose entire answer is a name, and the biography is then told that
// name as a fact. The bio cannot disagree with the name, because the name came
// first. There is nothing left to parse and nothing left to exclude.
//
// ⚠️ IT TAKES THREE THINGS AND NOTHING ELSE. What it is, what it does, which
// gender. Johnny: "the AI can perfectly name them by type of creature alone...
// we have the role... that gives the AI plenty to pick a name from, especially
// when it knows it's a goblin." He is right, and the inputs he leaves out are
// exactly the ones that poisoned it: no faction, no scene, no location, no
// alignment, no biography.
//
// ⚠️ AND IT MUST WORK WITH THE AI SWITCHED OFF. A paying customer with no API
// key, or Ollama not running, still needs creatures to get names. The name book
// below is not a nicety, it is the floor.
const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | Namer";

// ─── The name book ───────────────────────────────────────────────────────────
//
// The fallback, and the proof that naming works with no AI at all. Built to
// match the style already in Johnny's world — Grizzle Snaptooth, Krex Sootclaw,
// Skarth Grimfang, Grik Thornshadow — a short given name plus an earned epithet.
//
// Combinatorial on purpose: a few dozen parts per family multiply into tens of
// thousands of names, so a warband of nine never repeats.
const BOOK = {
    goblinoid: {
        male:   ["Grik", "Krex", "Snag", "Vex", "Zog", "Rask", "Nub", "Skar", "Grit", "Yek",
                 "Drez", "Mog", "Snarl", "Kez", "Bratt", "Gnash", "Rutt", "Skiv", "Wrek", "Zib"],
        female: ["Nissa", "Grizka", "Vexa", "Sarn", "Mella", "Zeeka", "Rikka", "Ulga", "Prin", "Skree",
                 "Yanna", "Drexa", "Nog", "Kesh", "Bramble", "Tikka", "Wrenna", "Zilla"],
        epithet:["Snaptooth", "Sootclaw", "Grimfang", "Thornshadow", "Rotmaw", "Ironfist", "Bonepick",
                 "Ashgrin", "Nettlefoot", "Rustnail", "Cinderhand", "Mudwhisker", "Sparkgut",
                 "Gutterborn", "Thistlejaw", "Coalbite", "Ratbane", "Splintershin", "Grubfinger"],
    },
    orc: {
        male:   ["Thokk", "Grum", "Argash", "Morg", "Urzul", "Karg", "Brakk", "Hrothek", "Durm", "Vokk"],
        female: ["Ushka", "Grenna", "Morga", "Yzra", "Krada", "Thurga", "Bagra", "Ulrath", "Senga"],
        epithet:["Skullsplitter", "Ironhide", "Bloodtusk", "Stormjaw", "Bonecleaver", "Ashborn",
                 "Fangbreaker", "Redmaw", "Hammerhand", "Scarback"],
    },
    dwarf: {
        male:   ["Bruni", "Dain", "Thrain", "Orsik", "Gundren", "Balder", "Nuri", "Harbek", "Torgga"],
        female: ["Vistra", "Amber", "Gunnloda", "Riswynn", "Helja", "Kathra", "Diesa", "Bardryn"],
        epithet:["Ironfoot", "Deepdelve", "Stonebeard", "Emberforge", "Anvilborn", "Coalheart",
                 "Rockmantle", "Grimhammer", "Oreseeker"],
    },
    elf: {
        male:   ["Aelar", "Cithrel", "Fenrith", "Ivellios", "Laucian", "Rolen", "Thamior", "Varis"],
        female: ["Andrathe", "Bethrynna", "Caelynn", "Iaerdrith", "Naivara", "Shanairra", "Thia"],
        epithet:["Moonwhisper", "Silverbough", "Duskwind", "Starfall", "Nightbriar", "Dawnthorn",
                 "Willowmere", "Frostleaf"],
    },
    undead: {
        male:   ["Corvin", "Mordath", "Ashlen", "Vaskir", "Grelan", "Duvane", "Sorrel"],
        female: ["Meridia", "Vashti", "Ilsabet", "Corvine", "Nerith", "Dolora"],
        epithet:["the Unmourned", "Gravewake", "Hollowbell", "the Unquiet", "Palewatch",
                 "the Third Silence", "Coldvigil"],
    },
    fiend: {
        male:   ["Malphas", "Orbas", "Zevruk", "Caim", "Halphax", "Nybbas"],
        female: ["Ardat", "Lilura", "Mazikeen", "Verrine", "Sabnok"],
        epithet:["the Bargainer", "Ninefold", "the Lesser Flame", "Ashtongue", "the Debtkeeper"],
    },
    giant: {
        male:   ["Harshnag", "Kayalithica", "Brimskarda", "Ulmarr", "Thrymgar"],
        female: ["Ilde", "Sansuri", "Neri", "Yrsa", "Hrunna"],
        epithet:["Stormcrown", "Frostmantle", "Hillbreaker", "the Elder", "Skyshoulder"],
    },
    // The default for people: humans, half-elves, tieflings, anyone whose names
    // read as ordinary Realms names rather than a monster culture.
    folk: {
        male:   ["Bardun", "Corwin", "Devrin", "Emeric", "Fendrel", "Garrick", "Halvor", "Joren",
                 "Kellen", "Lomas", "Mardyn", "Oswin", "Perrin", "Rowan", "Sever", "Tomas", "Wendel"],
        female: ["Alisen", "Brienne", "Coratha", "Delia", "Esmara", "Fenna", "Halene", "Ivet",
                 "Jesla", "Korrin", "Lisbet", "Maerwyn", "Nessa", "Orla", "Riva", "Sanna", "Tamsin"],
        epithet:["Ashford", "Blackwater", "Cobbleshaw", "Duskmoor", "Fenwick", "Greyhollow",
                 "Harrowmill", "Larkspur", "Mirebank", "Oakhurst", "Redhollow", "Stonefield",
                 "Thornbury", "Westerbrook"],
    },
};

// Which book a creature reads from. The species word decides; the creature type
// is only the fallback, because "humanoid" tells you nothing about a culture.
const FAMILY_BY_WORD = [
    [/\b(goblins?|hobgoblins?|bugbears?|goblinoids?)\b/i, "goblinoid"],
    [/\b(orcs?|orogs?|half-?orcs?)\b/i,                   "orc"],
    [/\b(dwar(f|ves)|duergar)\b/i,                        "dwarf"],
    [/\b(elf|elves|elven|drow|eladrin)\b/i,               "elf"],
    [/\b(giants?|ogres?|trolls?|ettins?)\b/i,             "giant"],
    [/\b(zombies?|skeletons?|ghouls?|wights?|wraiths?|specters?|spectres?|vampires?|liches?|undead)\b/i, "undead"],
    [/\b(devils?|demons?|imps?|quasits?|fiends?|cambions?)\b/i, "fiend"],
];
const FAMILY_BY_TYPE = { undead: "undead", fiend: "fiend", giant: "giant" };

/**
 * Which name book fits this creature.
 * @param {string} species — the species word, e.g. "goblin"
 * @param {string} creatureType — the dnd5e type, e.g. "humanoid"
 */
export function familyFor(species, creatureType = "") {
    const s = String(species || "");
    for (const [re, family] of FAMILY_BY_WORD) {
        if (re.test(s)) return family;
    }
    const t = String(creatureType || "").toLowerCase();
    return FAMILY_BY_TYPE[t] ?? "folk";
}

// ─── Validation ──────────────────────────────────────────────────────────────
//
// ⚠️ THIS IS THE PART THAT CANNOT BE TALKED OUT OF. A model may answer with a
// sentence, a title, the species, or a name already in use. Every one of those
// has to bounce, because an unvalidated answer is exactly the guess we are
// removing.
const SHAPE = /^[A-Z][a-z'’-]{1,15}(?: (?:the )?[A-Z][a-z'’-]{1,15}){0,2}$/;

// ⚠️ "the" IS NOT ON THIS LIST, AND THAT IS DELIBERATE. It was, and it made the
// validator reject "Corvin the Unmourned" — a name shape this file's own book
// produces for every undead. The book would have burned forty attempts and
// fallen out the bottom on every skeleton in the world. Where "the" may appear
// is already governed by SHAPE; a stopword list is the wrong tool for grammar.
// Caught by testing the book against the validator instead of trusting both.
const NOT_A_NAME = new Set([
    "unknown", "unnamed", "none", "null", "name",
    "certainly", "sure", "here", "sorry", "assistant", "okay",
]);

/**
 * Is this a usable personal name for this creature?
 *
 * @param {string} candidate
 * @param {object} ctx
 * @param {string} ctx.species — the species word, barred outright
 * @param {Set<string>} ctx.taken — every name already in use, lower-cased
 * @param {Set<string>} ctx.barred — factions, places, species words, lower-cased
 * @returns {{ok: boolean, why: string}}
 */
export function validateName(candidate, ctx = {}) {
    const raw = String(candidate ?? "").trim().replace(/[.!?,;:"']+$/, "");
    if (!raw) return { ok: false, why: "empty" };
    if (raw.length > 48) return { ok: false, why: "it answered with prose, not a name" };
    if (!SHAPE.test(raw)) return { ok: false, why: "not shaped like a name" };

    const lower = raw.toLowerCase();
    for (const word of lower.split(/\s+/)) {
        if (NOT_A_NAME.has(word)) return { ok: false, why: `"${word}" is not part of a name` };
    }

    const species = String(ctx.species || "").toLowerCase().trim();
    if (species) {
        // ⚠️ A CREATURE IS NEVER NAMED ITS OWN SPECIES. "Grik the Goblin" is a
        // label, not a name, and "Goblin" alone is what we started with.
        const bare = species.replace(/s$/, "");
        if (lower === species || lower === bare) return { ok: false, why: "that is the species" };
        if (lower.split(/\s+/).some(w => w === species || w === bare)) {
            return { ok: false, why: "it put the species in the name" };
        }
    }

    if (ctx.barred?.has(lower)) return { ok: false, why: "that is a faction or a place" };
    if (lower.split(/\s+/).some(w => ctx.barred?.has(w))) {
        return { ok: false, why: "it used a faction or place name" };
    }
    if (ctx.taken?.has(lower)) return { ok: false, why: "somebody already has that name" };

    return { ok: true, why: "" };
}

// ─── The book fallback ───────────────────────────────────────────────────────

function pick(list, avoid) {
    const fresh = list.filter(x => !avoid.has(String(x).toLowerCase()));
    const pool = fresh.length ? fresh : list;
    return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * A name from the book. Never fails, never calls anything, works offline.
 *
 * ⚠️ THE FLOOR, NOT THE CEILING. This is what a customer with no API key gets,
 * so it has to produce something Johnny would not be embarrassed to see on a
 * nameplate — not "Goblin 4".
 */
export function nameFromBook({ species, creatureType, gender, taken = new Set(), barred = new Set() }) {
    const family = familyFor(species, creatureType);
    const book = BOOK[family] ?? BOOK.folk;
    const givenList = (gender === "female") ? book.female : book.male;

    for (let attempt = 0; attempt < 40; attempt++) {
        const given = pick(givenList, taken);
        const full = `${given} ${pick(book.epithet, new Set())}`;
        if (validateName(full, { species, taken, barred }).ok) return full;
    }

    // ⚠️ FORTY COLLISIONS MEANS THE TWO-PART POOL IS SPENT, NOT THAT NAMING
    // FAILED. Given names times epithets is a few hundred combinations, which
    // is ample for a warband and finite across a whole campaign. Rather than
    // hand back a duplicate — which is what the first version did, silently —
    // widen the shape to given plus two epithet roots. That multiplies the pool
    // by the epithet count again and still reads like the rest of the book.
    for (let attempt = 0; attempt < 40; attempt++) {
        const given = givenList[Math.floor(Math.random() * givenList.length)];
        const a = pick(book.epithet, new Set()).replace(/^the\s+/, "");
        const b = pick(book.epithet, new Set()).replace(/^the\s+/, "");
        if (a === b) continue;
        // Splice two epithet roots into one: "Sootclaw" + "Grimfang" -> "Sootfang".
        const spliced = a.slice(0, Math.ceil(a.length / 2)) + b.slice(Math.floor(b.length / 2));
        const full = `${given} ${spliced.charAt(0).toUpperCase()}${spliced.slice(1)}`;
        if (validateName(full, { species, taken, barred }).ok) return full;
    }

    // Genuinely nothing left. Say so rather than issuing a name that is already
    // in use, so a duplicate on the nameplate is never a silent outcome.
    console.warn(`${TAG} | The ${familyFor(species, creatureType)} name book is exhausted for `
        + `${gender} names that are still free. Add more parts to BOOK.`);
    return `${givenList[Math.floor(Math.random() * givenList.length)]} `
        + `${book.epithet[Math.floor(Math.random() * book.epithet.length)]}`;
}

// ─── The AI naming call ──────────────────────────────────────────────────────

/**
 * Ask for a name, and nothing else.
 *
 * ⚠️ THE ENTIRE ANSWER IS THE NAME. No biography, no explanation, no NAME:
 * line to find inside prose. If the answer is not a name, it is rejected and
 * asked again once, then the book takes over. That is the whole design: there
 * is no path where ACE has to infer who a piece of writing was about.
 *
 * @param {object} opts
 * @param {string} opts.species      — "goblin", "hobgoblin", "human"
 * @param {string} opts.role         — "shaman", "chieftain", "scout", "" if unknown
 * @param {string} opts.gender       — "male" | "female"
 * @param {string} [opts.cultureHint]— optional regional flavour, e.g. "Barovian"
 * @param {string[]} [opts.kin]      — a few names already in this group, for style
 * @param {Set<string>} [opts.taken]
 * @param {Set<string>} [opts.barred]
 * @returns {Promise<{name: string, source: "ai"|"book", tries: number}>}
 */
export async function generateName(opts) {
    const {
        species, role = "", gender = "male", cultureHint = "",
        kin = [], taken = new Set(), barred = new Set(),
    } = opts;

    const bookName = () => ({
        name: nameFromBook({ ...opts, taken, barred }), source: "book", tries: 0,
    });

    // ⚠️ AIHandler LIVES IN conversation-engine.mjs, NOT ai-provider.mjs.
    // I reached for the obvious file first and it exports nothing by that name.
    // Verified against bio-generator's own import rather than assumed: calling a
    // member that does not exist is a silent no-op, and that class of mistake
    // has cost this project months (see the platform API drift audit).
    let AIHandler, provider, apiKey;
    try {
        ({ AIHandler } = await import("./conversation-engine.mjs"));
        const { getSecret } = await import("../settings.mjs");
        provider = game.settings.get(MODULE_ID, "aiProvider") || "";
        apiKey   = getSecret("apiKey") || "";
    } catch (err) {
        console.warn(`${TAG} | The AI provider is unavailable, using the name book:`, err);
        return bookName();
    }
    if (typeof AIHandler?.callAI !== "function" || !provider) {
        console.log(`${TAG} | No AI provider configured — naming from the book.`);
        return bookName();
    }

    // ⚠️ THREE INPUTS. Deliberately no faction, no scene, no location, no
    // alignment, no biography. Those are what produced "Mind Flayers" and
    // "Phandelver", and a namer does not need any of them.
    const system = "You name fantasy creatures for a Dungeons & Dragons game. "
        + "You reply with the name and NOTHING else: no greeting, no explanation, no quotation marks, "
        + "no title, no species, no punctuation at the end. One or two words. "
        + "A given name, optionally followed by a surname or an earned epithet.";

    const lines = [
        `Creature: ${species}`,
        role ? `Role: ${role}` : "",
        `Gender: ${gender}`,
        cultureHint ? `Cultural flavour: ${cultureHint}` : "",
        kin.length ? `Others of its group are called: ${kin.slice(0, 3).join(", ")}. Match that style but do NOT reuse any of them.` : "",
        "",
        `Give this individual ${gender === "female" ? "her" : "his"} personal name.`,
    ].filter(Boolean);

    let rejected = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
        const userMsg = rejected
            ? `${lines.join("\n")}\n\nYour previous answer "${rejected}" was rejected: it must be a plain personal name, one or two words, and must not be the species, a place, a faction, or a name already in use. Answer again with the name only.`
            : lines.join("\n");
        let answer = "";
        try {
            answer = await AIHandler.callAI(system, [], userMsg, provider, apiKey, [], { context: "namer" });
        } catch (err) {
            console.warn(`${TAG} | Naming call failed, using the name book:`, err);
            return bookName();
        }

        // ⚠️ A FAILURE MARKER IS NOT AN ANSWER. ACE's provider returns a
        // distinctive marker when a call fails rather than throwing. Validation
        // would reject it anyway and fall through to the book, but it would log
        // "rejected, not shaped like a name" and manufacture a false cause. Say
        // what actually happened.
        try {
            const { isAIFailure } = await import("./ai-failure.mjs");
            if (isAIFailure(answer)) {
                console.warn(`${TAG} | The AI call failed; naming from the book instead.`);
                return bookName();
            }
        } catch (_) { /* detector unavailable; validation still guards */ }

        // Take only the first line: the cheapest defence against a model that
        // adds a sentence of commentary underneath.
        const first = String(answer ?? "").trim().split("\n")[0].trim().replace(/^["'`]|["'`]$/g, "");
        const verdict = validateName(first, { species, taken, barred });
        if (verdict.ok) {
            console.log(`${TAG} | Named a ${gender} ${species}${role ? ` (${role})` : ""} "${first}".`);
            return { name: first, source: "ai", tries: attempt };
        }
        console.log(`${TAG} | Rejected "${first || "(empty)"}" — ${verdict.why}.`);
        rejected = first;
    }

    const fallback = bookName();
    console.log(`${TAG} | The AI could not produce a usable name in two tries; the book gave "${fallback.name}".`);
    return fallback;
}

/**
 * Which gender this creature is, as a decided fact.
 *
 * ⚠️ "AUTO" MUST END AS A DECISION, NOT A SHRUG. Johnny, 2026-08-23: "we confuse
 * this all too much with the female/male thing... it should say male/female at
 * the top, or random, where the AI just picks."
 *
 * The trap is what happens after. Gender drives BOTH the name and the voice. If
 * "auto" resolves to female inside the namer and is never written down, the
 * voice engine later resolves it independently, lands on male, and you get a
 * female name speaking in a male voice — a defect that would surface weeks after
 * launch and look like a TTS bug. So the answer is RECORDED on the creature the
 * moment it is decided, and everything downstream reads the same fact.
 *
 * Order of authority: the GM's explicit choice, then a voice already assigned,
 * then signals from the art and text, then a coin toss. A coin toss is honest;
 * silently defaulting every unknown creature to male is not.
 *
 * @returns {Promise<{gender: "male"|"female", source: string}>}
 */
export async function resolveGender(actor, tokenDoc) {
    const target = (tokenDoc && !tokenDoc.actorLink) ? tokenDoc.actor : actor;
    const read = (flag) => { try { return target?.getFlag?.(MODULE_ID, flag) || ""; } catch (_) { return ""; } };

    const override = read("genderOverride");
    if (override === "male" || override === "female") return { gender: override, source: "the GM chose it" };

    const voiceGender = read("voiceGender");
    if (voiceGender === "male" || voiceGender === "female") return { gender: voiceGender, source: "its assigned voice" };

    const art  = String(tokenDoc?.texture?.src || actor?.img || "").toLowerCase();
    const bio  = String(actor?.system?.details?.biography?.value || "").toLowerCase();
    const app  = String(actor?.system?.details?.appearance || "").toLowerCase();
    const all  = `${art} ${bio} ${app} ${String(actor?.name || "").toLowerCase()}`;
    if (/\b(female|woman|girl|lady|queen|princess|priestess|witch|sorceress|matron|maiden|duchess|countess|baroness|empress|mistress|hag|banshee|dryad|nymph|harpy|medusa|siren|barmaid)\b/.test(all)) {
        return { gender: "female", source: "its art or description" };
    }
    if (/\b(male|man|boy|lord|king|prince|priest|duke|count|baron|emperor|master|patriarch)\b/.test(all)) {
        return { gender: "male", source: "its art or description" };
    }

    // ⚠️ A COIN TOSS, NOT A DEFAULT TO MALE. The old code defaulted every
    // unsignalled creature to male, which quietly made most of the world men.
    const gender = Math.random() < 0.5 ? "male" : "female";
    return { gender, source: "nothing said, so ACE picked" };
}

/**
 * Decide the gender AND write it down, so the voice engine cannot disagree.
 */
export async function resolveAndRecordGender(actor, tokenDoc) {
    const { gender, source } = await resolveGender(actor, tokenDoc);
    const target = (tokenDoc && !tokenDoc.actorLink) ? tokenDoc.actor : actor;
    try {
        if (!target?.getFlag?.(MODULE_ID, "voiceGender")) {
            await target?.setFlag?.(MODULE_ID, "voiceGender", gender);
        }
    } catch (err) {
        console.warn(`${TAG} | Could not record the decided gender (the voice may disagree):`, err);
    }
    return { gender, source };
}

/**
 * Every name already spoken for, so nothing is issued twice.
 *
 * ⚠️ TOKENS COUNT, NOT ONLY ACTORS. An unlinked creature's name lives on its
 * token, and a warband of nine goblins is nine tokens and one actor. Reading
 * only `game.actors` would let the same name go out nine times.
 */
export function takenNames() {
    const out = new Set();
    const add = (n) => { const s = String(n || "").toLowerCase().trim(); if (s) out.add(s); };

    // ⚠️ A FLAVOUR NAME IS A NAME THE PLAYERS SEE. Some creatures keep their
    // statblock name on the actor and wear a personal name only on the
    // nameplate, stored as a flag. A dedup that reads only real names once let
    // TWO OGRES both be called "Grulgar Stonearm" on the same scene (root-caused
    // 2026-07-26). The old scan in bio-generator knew this; it was deleted along
    // with the name-guessing, so the knowledge moves here rather than dying
    // with the code that held it.
    const addAll = (doc) => {
        add(doc?.name);
        try { add(doc?.getFlag?.(MODULE_ID, "flavorName")); } catch (_) { /* no flags */ }
    };

    for (const actor of (game.actors ?? [])) addAll(actor);
    for (const scene of (game.scenes ?? [])) {
        for (const token of (scene.tokens ?? [])) {
            add(token.name);
            addAll(token.actor);
        }
    }
    return out;
}

/**
 * Names that belong to something else — factions and places. A creature is
 * never named one of these, whatever the model suggests.
 */
export async function barredNames() {
    const out = new Set();
    const add = (n) => {
        const s = String(n || "").toLowerCase().trim();
        if (!s) return;
        out.add(s);
        out.add(s.replace(/^the\s+/, ""));
        if (s.endsWith("s")) out.add(s.slice(0, -1));
        for (const w of s.split(/[^a-z0-9'-]+/)) if (w.length >= 4) out.add(w);
    };
    try {
        const { getAllFactions } = await import("./faction-registry.mjs");
        for (const f of Object.values(getAllFactions() ?? {})) add(f?.name);
    } catch (_) { /* factions unavailable; places still bar */ }
    try {
        for (const scene of (game.scenes ?? [])) add(scene.name);
    } catch (_) { /* nothing to add */ }
    return out;
}
