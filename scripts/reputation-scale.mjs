// ─── ACE Engine — how a faction feels about the party, as a number ──────────
//
// ⚠️ WHY THIS REPLACES THE SIX-RUNG LADDER (2026-08-21).
//
// The old ladder was six words and nothing else: revered, friendly, neutral,
// suspicious, hostile, hated. Three problems, all of which Johnny spotted by
// reading the list:
//
//  1. IT WAS LOPSIDED BY ACCIDENT. Two rungs above neutral, three below. A
//     party could fall further than it could climb, and nobody had chosen that.
//     Johnny: "let's make those even somehow... it definitely was an accident."
//
//  2. IT WAS TOO COARSE. A legendary deed moved three rungs, which took a
//     faction from neutral to the top in ONE act. Johnny: "it is too fast.
//     That's why I was saying there doesn't seem like there's enough."
//
//  3. EVERYONE STARTED NEUTRAL, which is not how people work. Johnny: "there
//     are a lot of people that are suspicious off the bat... some people will
//     hate you from the beginning, just meeting you, and some people will love
//     you right from the beginning. That's pretty much nature."
//
// So standing is a SCORE from -100 to +100 with the words as bands read off it.
// Seven bands, three each side of neutral. A deed moves points, not rungs, so
// the words change when something has genuinely accumulated rather than because
// one big act tipped a single step.

// ⚠️ Symmetric on purpose. If you edit these, keep them mirrored, or you have
// quietly recreated the bug this file exists to fix.
// magnitude.mjs is a leaf — it imports nothing from here, so there is no cycle.
import { normalizeMagnitude } from "./magnitude.mjs";

export const BANDS = [
  { min:   80, max:  100, key: "revered",    label: "Revered"    },
  { min:   40, max:   79, key: "friendly",   label: "Friendly"   },
  { min:   10, max:   39, key: "cordial",    label: "Cordial"    },
  { min:   -9, max:    9, key: "neutral",    label: "Neutral"    },
  { min:  -39, max:  -10, key: "wary",       label: "Wary"       },
  { min:  -79, max:  -40, key: "hostile",    label: "Hostile"    },
  { min: -100, max:  -80, key: "hated",      label: "Hated"      },
];

/** What one act is worth, in points. Kills use the same table, negated. */
export const MAGNITUDE_POINTS = {
  trivial:     0,
  minor:       3,
  local:       8,
  regional:   18,
  continental: 32,
  legendary:  55,
};

// ⚠️ `national` existed in the old propagation table and was never a valid
// magnitude anywhere else, so it would have been rejected on write and honoured
// on read. Mapped here rather than left as a silent trap.
MAGNITUDE_POINTS.national = MAGNITUDE_POINTS.continental;

/**
 * What one act is worth, whichever vocabulary wrote it down.
 *
 * ⚠️🔴 `major` WAS MISSING AND IT COST JOHNNY ELEVEN DEEDS (2026-08-22).
 *
 * Two scales have been in use side by side and nothing reconciled them at the
 * point of use:
 *
 *   the DEED STORE writes    trivial · local · regional · MAJOR · legendary
 *   this table held          trivial · minor · local · regional · continental · legendary
 *
 * `MAGNITUDE_POINTS["major"]` is undefined, `?? 0` turns that into zero, and
 * propagateDeed exits on `base <= 0`. So every "major" deed — killing Vorthak
 * Szass, killing a Death Knight, eleven of them in his world — moved nobody and
 * said nothing. fameGain read the same table, so they earned no renown either.
 *
 * The mapping already existed in magnitude.mjs (`major → continental`) and
 * neither caller consulted it. Going through it here fixes every call site at
 * once, including the ones nobody has written yet.
 */
export function pointsFor(magnitude) {
  const raw = String(magnitude || "").toLowerCase().trim();
  if (raw in MAGNITUDE_POINTS) return MAGNITUDE_POINTS[raw];
  return MAGNITUDE_POINTS[normalizeMagnitude(raw)] ?? 0;
}

/**
 * How the world feels about a party it has never met.
 *
 * ⚠️ NOT EVERYONE STARTS NEUTRAL. Johnny's reasoning, which is better than a
 * flat default: "look at that green dragonborn, and he had an incident with a
 * different colour dragonborn, he doesn't like dragonborn" versus "a 17-year-old
 * guard looking at Firaxis Greenbeard in his shining armour" and revering him on
 * sight. People arrive with opinions.
 *
 * Neutral still dominates. The extremes are 1% each, because someone who
 * reveres or hates a party they have never met is a quirk, not a rule.
 */
/** What a starting attitude actually means, in a sentence a GM can read. */
const WHY = {
  revered:  "somebody among them already admires what your party is said to be",
  friendly: "they think well of strangers until shown otherwise",
  cordial:  "polite to outsiders, without going out of their way",
  neutral:  "no opinion either way",
  wary:     "slow to trust anyone they did not grow up with",
  hostile:  "armed strangers are a problem here before they are anything else",
  hated:    "somebody among them carries a grudge against people like your party",
};

export const START_DISTRIBUTION = [
  { key: "revered",  weight:  1 },
  { key: "friendly", weight: 10 },
  { key: "cordial",  weight: 13 },
  { key: "neutral",  weight: 50 },
  { key: "wary",     weight: 20 },
  { key: "hostile",  weight:  5 },
  { key: "hated",    weight:  1 },
];

/** Clamp to the scale. */
export const clampScore = (n) => Math.max(-100, Math.min(100, Math.round(Number(n) || 0)));

/** The band a score falls in. */
export function bandFor(score) {
  const s = clampScore(score);
  return BANDS.find(b => s >= b.min && s <= b.max) ?? BANDS[3];
}

/** The human word for a score. */
export const labelFor = (score) => bandFor(score).label;

/**
 * A representative score for a band name. Used to convert old word-based
 * standings once, and to turn a rolled starting band into a number.
 * ⚠️ The MIDDLE of the band, never an edge, so a converted faction is not one
 * point away from changing its label the first time anything happens.
 */
export function scoreForBand(key) {
  const b = BANDS.find(x => x.key === String(key || "").toLowerCase());
  if (!b) return 0;
  return Math.round((b.min + b.max) / 2);
}

// ── Starting standing ───────────────────────────────────────────────────────

/**
 * A stable pseudo-random number in [0,1) derived from a string.
 *
 * ⚠️ DETERMINISTIC ON PURPOSE. A faction must not change its mind about the
 * party every time the world loads, and a roll that is re-rolled is not an
 * opinion, it is a flicker. Same faction id, same starting attitude, forever.
 */
function _seededUnit(seed) {
  let h = 2166136261;
  for (const ch of String(seed || "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  // xorshift the hash so neighbouring ids do not produce neighbouring results
  h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * The band a faction starts in, before the party has done anything.
 *
 * ⚠️ HUMANOIDS ONLY, and this caveat is Johnny's: "that should only apply to
 * humanoids, because an ogre isn't going to revere a dragonborn in gold shiny
 * armour, probably ever. The chances of that happening are like zero."
 *
 * A faction made of something else does not roll. It gets a flat starting
 * attitude appropriate to what it is, which for most monstrous groups is wary
 * rather than neutral, and never friendly.
 *
 * @param {object} faction  needs id, and creatureBase from the composition pass
 * @returns {{score:number, band:string, why:string}}
 */
export function startingStanding(faction) {
  const id   = faction?.id || faction?.name || "";
  const base = String(faction?.creatureBase || "").toLowerCase().trim();

  const HUMANOID = new Set(["human", "elf", "dwarf", "halfling", "gnome", "half-elf",
                            "half-orc", "tiefling", "dragonborn", "commoner"]);
  const MONSTROUS_WARY = new Set(["orc", "goblin", "hobgoblin", "bugbear", "gnoll",
                                  "kobold", "drow", "duergar", "lizardfolk", "yuan-ti",
                                  "sahuagin", "kuo-toa", "bullywug", "troll", "ogre", "giant"]);

  if (!HUMANOID.has(base)) {
    if (base === "undead" || base === "fiend") {
      return { score: scoreForBand("hostile"), band: "hostile",
               why: `${base || "this kind"} does not warm to strangers` };
    }
    if (MONSTROUS_WARY.has(base)) {
      return { score: scoreForBand("wary"), band: "wary",
               why: `${base} groups start wary of outsiders` };
    }
    return { score: 0, band: "neutral", why: "not a people that forms opinions on sight" };
  }

  // Humanoids roll, once, deterministically.
  const roll = _seededUnit(`ace-standing:${id}`) * 100;
  let acc = 0;
  for (const slice of START_DISTRIBUTION) {
    acc += slice.weight;
    if (roll < acc) {
      // ⚠️ SAY WHY, DIFFERENTLY FOR EACH. The first version printed the same
      // sentence 233 times, which tells a GM nothing and reads like a bug.
      // Johnny's own examples are the model: a green dragonborn who had an
      // incident with another dragonborn, versus a 17-year-old guard seeing
      // shining armour and deciding this must be a knight.
      return { score: scoreForBand(slice.key), band: slice.key, why: WHY[slice.key] };
    }
  }
  return { score: 0, band: "neutral", why: "no opinion either way" };
}

// ── Notoriety ───────────────────────────────────────────────────────────────
//
// ⚠️ Johnny: "I don't think only five is good enough... If it's unknown, it
// should at least be local." A party five months into a campaign is not
// unknown, and nothing in ACE has ever raised this, which is why his has sat at
// "unknown" since March — and why the reputation engine, which checks notoriety
// FIRST and returns nothing when it is unknown, has never told an NPC anything.

export const FAME_BANDS = [
  { min:   0, max:   9, key: "unheard",     label: "Unheard of"              },
  { min:  10, max:  24, key: "local",       label: "Known locally"           },
  { min:  25, max:  44, key: "provincial",  label: "Known in the province"   },
  { min:  45, max:  64, key: "regional",    label: "Known regionally"        },
  { min:  65, max:  79, key: "national",    label: "Known nationally"        },
  { min:  80, max:  92, key: "continental", label: "Known across the continent" },
  { min:  93, max: 100, key: "legendary",   label: "Legendary"               },
];

/** A campaign in progress starts here, not at nothing. */
export const FAME_FLOOR = 12;

export const fameBandFor = (score) => {
  const s = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  return FAME_BANDS.find(b => s >= b.min && s <= b.max) ?? FAME_BANDS[0];
};

/** Clamp to 0-100. ⚠️ Does NOT round: fame carries a fraction so that small
 *  deeds accumulate instead of each rounding away to nothing. Round on read. */
export const clampFame = (n) => Math.max(0, Math.min(100, Number(n) || 0));

/**
 * What one act adds to renown.
 *
 * ⚠️🔴 THIS CURVE HAD NEVER RUN UNTIL 2026-08-22. Fame was raised only for
 * HEROIC deeds, and every deed in Johnny's world is a kill, so the whole
 * function was dead code and its numbers were never tested against anything.
 * The first time it was allowed to run it took him from 12 to 80 — "Known
 * across the continent" — on sixteen dungeon kills.
 *
 * ⚠️ AND SMALL DEEDS ROUNDED TO NOTHING. Rounding each gain independently
 * meant a local deed produced Math.round(0.49) = 0, so forty goblin bands
 * moved renown from 12 to 12. Fame is therefore accumulated as a FRACTION and
 * rounded only when it is read, so many small things add up slowly instead of
 * adding up to zero.
 *
 * ⚠️ FAME IS NOT THE FACTION SCALE. Killing a death knight is a genuine wound
 * to whoever owned it and barely a rumour three valleys away, so renown has its
 * own table. Being known is earned by doing things the world has heard of.
 */
const FAME_POINTS = {
  trivial: 0, minor: 0, local: 1, regional: 3,
  major: 6, continental: 6, national: 6, legendary: 40,
};

/** How much harder renown is to gain the more of it you have. */
const FAME_EFFORT = 0.6;
const FAME_RESISTANCE = 1.6;

export function fameGain(currentScore, magnitude) {
  const raw = String(magnitude || "").toLowerCase().trim();
  const pts = FAME_POINTS[raw] ?? FAME_POINTS[normalizeMagnitude(raw)] ?? 0;
  if (pts <= 0) return 0;
  const cur = Math.max(0, Math.min(100, Number(currentScore) || 0));
  // Never negative, never rounded here: the caller keeps the fraction.
  return Math.max(0, pts * FAME_EFFORT * Math.pow(1 - cur / 105, FAME_RESISTANCE));
}

export const applyFame = (currentScore, magnitude) =>
  clampFame(clampFame(currentScore) + fameGain(currentScore, magnitude));
