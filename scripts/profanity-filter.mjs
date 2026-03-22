// ============================================================
// ACE — AI Campaign Engine — Profanity Filter
// Replaces real-world profanity with fantasy equivalents.
// Static replacements + dynamic deity/regional flavor via AI.
// ============================================================

import { MODULE_ID } from "./ace-engine.mjs";

// ── Static Replacement Map ──────────────────────────────────
// Each entry: [regex pattern, replacement root, verb forms]
// Ordered longest-first to prevent partial matches.

const STATIC_REPLACEMENTS = [
  // ── bullshit (before shit to prevent partial match) ──
  { pattern: /\bbullshit(s|ting|ter|ted)?\b/gi,     base: "troll spit",   forms: { s: "troll spits", ting: "troll spitting", ter: "troll spitter", ted: "troll spit" } },
  // ── asshole (before ass) ──
  { pattern: /\bass\s*hole(s)?\b/gi,                 base: "skullhole",    forms: { s: "skullholes" } },
  // ── fuck — the big one ──
  { pattern: /\bmotherfuck(er|ers|ing|ed)?\b/gi,     base: "motherxork",   forms: { er: "motherxorker", ers: "motherxorkers", ing: "motherxorking", ed: "motherxorked" } },
  { pattern: /\bfuck(s|ing|ed|er|ers|face|head|wit|tard|all|up)?\b/gi, base: "xork", forms: {
    s: "xorks", ing: "xorking", ed: "xorked", er: "xorker", ers: "xorkers",
    face: "xorkface", head: "xorkhead", wit: "xorkwit", tard: "xorkwit",
    all: "xork-all", up: "up",
  }},
  // ── shit ──
  { pattern: /\bshit(s|ty|ting|ted|ter|iest|head|face|show|storm|hole)?\b/gi, base: "grak", forms: {
    s: "graks", ty: "grakky", ting: "grakking", ted: "grakked", ter: "grakker",
    iest: "grakkiest", head: "grakhead", face: "grakface", show: "grakshow",
    storm: "grakstorm", hole: "grakhole",
  }},
  // ── bitch ──
  { pattern: /\bbitch(es|y|ing|ed)?\b/gi,            base: "hag",          forms: { es: "hags", y: "haggish", ing: "hagging", ed: "hagged" } },
  // ── bastard ──
  { pattern: /\bbastard(s|ly|ize|ized)?\b/gi,        base: "grub",         forms: { s: "grubs", ly: "grubbily", ize: "grub", ized: "grubbed" } },
  // ── damn ──
  { pattern: /\bgoddamn(ed|it)?\b/gi,                base: "gods-blasted", forms: { ed: "gods-blasted", it: "gods blast it" } },
  { pattern: /\bgod\sdamn(ed|it)?\b/gi,              base: "gods-blasted", forms: { ed: "gods-blasted", it: "gods blast it" } },
  { pattern: /\bdamn(ed|it|s|ing)?\b/gi,             base: "blast",        forms: { ed: "blasted", it: "blast it", s: "blasts", ing: "blasting" } },
  // ── hell ──
  { pattern: /\bwhat the hell\b/gi,                   base: "what in the Abyss" },
  { pattern: /\bgo to hell\b/gi,                      base: "rot in the Abyss" },
  { pattern: /\bhell(ish|hole|bent|fire)?\b/gi,       base: "the Abyss",    forms: { ish: "abyssal", hole: "abyss-pit", bent: "abyss-bent", fire: "abyss-fire" } },
  // ── ass (standalone, after asshole already matched) ──
  { pattern: /\bass(es)?\b/gi,                        base: "gob",          forms: { es: "gobs" } },
  // ── crap ──
  { pattern: /\bcrap(s|py|ped|ping)?\b/gi,            base: "muck",         forms: { s: "mucks", py: "mucky", ped: "mucked", ping: "mucking" } },
  // ── piss ──
  { pattern: /\bpiss(es|ed|ing|er)?\b/gi,             base: "vex",          forms: { es: "vexes", ed: "vexed", ing: "vexing", er: "vexer" } },
  // ── SOB ──
  { pattern: /\bson of a bitch\b/gi,                   base: "son of a hag" },
  // ── WTF ──
  { pattern: /\bwtf\b/gi,                             base: "what in the Abyss" },
  // ── stfu ──
  { pattern: /\bstfu\b/gi,                            base: "shut your gob" },
];


/**
 * Apply static profanity replacements to text.
 * Preserves original capitalization pattern (all-caps, title-case, lowercase).
 *
 * @param {string} text - Input text
 * @returns {string} Filtered text
 */
export function filterProfanity(text) {
  if (!text || typeof text !== "string") return text;

  let result = text;

  for (const rule of STATIC_REPLACEMENTS) {
    result = result.replace(rule.pattern, (match, suffix) => {
      let replacement;
      const sfx = (typeof suffix === "string") ? suffix.toLowerCase() : "";
      if (sfx && rule.forms?.[sfx]) {
        replacement = rule.forms[sfx];
      } else {
        replacement = rule.base;
      }

      // Preserve case pattern
      if (match === match.toUpperCase() && match.length > 1) {
        return replacement.toUpperCase();
      } else if (match[0] === match[0].toUpperCase()) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1);
      }
      return replacement;
    });
  }

  return result;
}


// ── AI System Prompt Injection ──────────────────────────────

/**
 * Build the profanity/flavor prompt to inject into the AI system message.
 * If a World Bible is available, pulls deity names for contextual swearing.
 *
 * @param {Object} [worldBible] - World Bible data (optional)
 * @param {string} [currentRegion] - Current scene/region name (optional)
 * @returns {string} System prompt addition for AI profanity flavor
 */
export function buildProfanityPrompt(worldBible = null, currentRegion = "") {
  // Gather deity names from World Bible if available
  let deityList = [];
  try {
    const deities = worldBible?.deities ?? worldBible?.Deities ?? [];
    if (Array.isArray(deities)) {
      deityList = deities.slice(0, 20).map(d => d.name || d.Name || d).filter(Boolean);
    }
  } catch { /* no bible data */ }

  const deityExamples = deityList.length > 0
    ? deityList.slice(0, 6).map(d => `"${d}'s wrath!", "By ${d}!'s name!"`).join(", ")
    : `"Tyr's blind eye!", "By Moradin's beard!", "Mystra's mercy!"`;

  return `
── PROFANITY & IN-WORLD SWEARING ──
When speaking in character (as NPCs or narrating), use fantasy profanity that fits the world.
NEVER use real-world swear words. Instead, use creative in-world expressions:

Static replacements the player sees (you should recognize these):
- "xork" = the F-word equivalent. "xorking" = adverb form.
- "skullhole" = asshole
- "hag" = bitch
- "grub" = bastard
- "troll spit" = bullshit
- "the Abyss" = hell
- "grak" = shit

For deity/god-related exclamations, use the campaign's actual gods:
${deityExamples}

Be CREATIVE with profanity. Don't just say "xork" — use colorful expressions like:
- "By [Deity]'s [iconic attribute]!" (beard, hammer, flame, scales, shadow)
- "[Deity]'s [body part/weapon], that was close!"
- "You're slimier than a [regional monster] in a [local place]"
- "Son of a [monster]!" — gelatinous cube, beholder, hag, owlbear, etc.
- "May [Deity] take your [thing]!" as a curse
- NPCs should swear in ways that reflect THEIR culture, region, and patron deity

${currentRegion ? `Current region: ${currentRegion} — use regionally appropriate deities and monsters.` : ""}
`.trim();
}


/**
 * Quick test — logs replacement examples to console.
 */
export function testFilter() {
  const examples = [
    "What the fuck was that?!",
    "This dungeon is bullshit",
    "God damn it, the rogue stole everything",
    "You piece of shit!",
    "That shopkeeper is an asshole",
    "Son of a bitch, he critted!",
    "Stop being a little bitch about it",
    "That bastard sold us cursed gear",
    "What the hell is going on?",
    "Holy shit, the dragon talked!",
    "FUCK THIS",
    "Fucking unbelievable",
    "Go to hell, you shitty bastard",
    "WTF just happened",
  ];

  console.log(`${MODULE_ID} | ── Profanity Filter Test ──`);
  for (const ex of examples) {
    console.log(`  "${ex}"\n  → "${filterProfanity(ex)}"\n`);
  }
}
