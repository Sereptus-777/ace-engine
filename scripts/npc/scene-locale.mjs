// ─── ACE Engine — turning a map filename into a place ───────────────────────
//
// ⚠️ THE WORLD BIBLE HAD THE ANSWER AND COULD NEVER BE ASKED FOR IT (2026-08-21).
//
// Johnny's bible is full: 37 regions of Faerûn with nations, rulers and
// governments, 11 global factions, a 40-deity pantheon, and twelve digested
// sourcebooks including Curse of Strahd itself. Barovia, Strahd, Ravenloft,
// Vallaki, Argynvostholt and the Amber Temple are all in there.
//
// And every NPC conversation contributed ZERO characters of it, because the
// lookup searched for the SCENE NAME, and his scenes are named the way anyone
// names battlemaps:
//
//     BM: 1F Center - Amber Temple
//     BM: Argynvostholt 1F
//     BM: 1F East MINE
//     1 Barovia Map
//
// Searching a bible of places for "BM: 1F Center - Amber Temple" finds nothing.
// Searching it for "Amber Temple" finds the Amber Temple. The whole failure was
// four characters of map-naming convention and a floor number.
//
// ⚠️ THIS IS NOT A GUESS AT WHERE THEY ARE. It strips known battlemap noise and
// hands back what is left, largest fragment first, so the search gets a place
// name instead of a filename. When a GM wants certainty they set the scene flag
// and nothing here is consulted at all.

const MODULE_ID = "ace-engine";

// Prefixes GMs put on battlemaps. Johnny uses both "BM:" and "SC:"; the others
// are common enough to be worth stripping for anyone.
const MAP_PREFIX = /^\s*(bm|sc|map|battlemap|scene|dungeon|lvl|level)\s*[:\-–.]\s*/i;

// Floor and grid markers: 1F, 2F, B1, GF, L3, and bare leading numbers.
const FLOOR = /\b(?:[0-9]+\s*f|f\s*[0-9]+|b[0-9]+|gf|l[0-9]+|floor\s*[0-9]+|lvl\s*[0-9]+|level\s*[0-9]+)\b/gi;

// Where on the map, not where in the world.
const COMPASS = /\b(north|south|east|west|northeast|northwest|southeast|southwest|ne|nw|se|sw|centre|center|upper|lower|inner|outer|top|bottom|left|right)\b/gi;

// Housekeeping a GM leaves in a scene name.
const NOISE = /\((?:copy|old|new|backup|wip|test|v\d+)\)|\b(?:copy|backup|wip|template|templates|unused)\b/gi;

// A single word that describes a bit of map rather than a place. Searching a
// world bible for "Back" or "Front" returns whatever happens to contain those
// letters, which is worse than searching for nothing at all.
const GENERIC = new Set(["back", "front", "entry", "exit", "chase", "start", "end",
                         "area", "room", "hall", "cave", "path", "road", "yard",
                         "side", "main", "part", "test", "temp", "misc", "other",
                         "characters", "journal", "quests", "notes", "aaa"]);

/**
 * ⚠️ A weak term is worse than none. "BM: Back" cleans down to "Back", which
 * would match anything. A single word has to be long enough and specific
 * enough to name a place; two or more words carry their own context.
 */
function _worthSearching(term) {
    const t = String(term || "").trim();
    if (t.length < 3) return false;
    const words = t.split(/\s+/);
    if (words.length > 1) return true;
    if (t.length < 5) return false;
    return !GENERIC.has(t.toLowerCase());
}

/**
 * Search terms for the World Bible, best first.
 *
 * @param {string} sceneName
 * @returns {string[]} distinct terms, longest first, never empty unless the
 *                     name was entirely noise
 */
export function sceneSearchTerms(sceneName) {
    const raw = String(sceneName || "").trim();
    if (!raw) return [];

    let s = raw.replace(MAP_PREFIX, " ")
               .replace(NOISE, " ")
               .replace(FLOOR, " ")
               .replace(COMPASS, " ")
               .replace(/^\s*\d+\s+/, " ")          // "1 Barovia Map"
               .replace(/\bmaps?\b/gi, " ")
               .replace(/[_]+/g, " ");

    // Split on separators a GM uses between a place and its sub-area, keeping
    // each side: "Argynvostholt - Crypt" is two useful terms, not one.
    const parts = s.split(/\s*[-–—|/>]+\s*|\s{2,}/)
                   .map(p => p.replace(/[^\p{L}\p{N}'\s]/gu, " ").replace(/\s+/g, " ").trim())
                   .filter(p => p.length > 2);

    const whole = s.replace(/[^\p{L}\p{N}'\s]/gu, " ").replace(/\s+/g, " ").trim();
    const terms = [];
    for (const t of [...parts, whole]) {
        if (!_worthSearching(t)) continue;
        if (!terms.some(x => x.toLowerCase() === t.toLowerCase())) terms.push(t);
    }
    // Longest first: "Amber Temple" should be tried before "Amber".
    terms.sort((a, b) => b.length - a.length);
    return terms;
}

/**
 * Where this scene is, as far as we can tell.
 *
 * ⚠️ A GM'S OWN ANSWER WINS AND IS NEVER SECOND-GUESSED. Setting the scene flag
 * `aceRegion` pins it: no parsing, no search terms, no cleverness. That is the
 * "configure it" path, and it exists because no amount of filename parsing
 * beats being told.
 *
 * @returns {{terms: string[], pinned: boolean}}
 */
export function sceneLocale(scene = canvas?.scene) {
    let pinned = "";
    try { pinned = String(scene?.getFlag?.(MODULE_ID, "aceRegion") || "").trim(); } catch (_) {}
    if (pinned) return { terms: [pinned], pinned: true };
    return { terms: sceneSearchTerms(scene?.name), pinned: false };
}
