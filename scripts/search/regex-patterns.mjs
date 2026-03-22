// ============================================================
// ACE — AI Campaign Engine — D&D Regex Pattern Library
// Central registry of all content-detection patterns used
// throughout the search pipeline: chunking, classification,
// entity extraction, pre-search, and scoring.
// ============================================================

// ── Room / Area Patterns ─────────────────────────────────────
// Detect structured room/area headings common in D&D adventure modules.
// Each pattern captures (roomId, roomTitle) where possible.

export const ROOM_PATTERNS = [
  // Lettered rooms: K1, K15, K88 (Ravenloft), L1, T3, S12
  /^([A-Z]\d{1,3}[a-z]?)[.\s:—–\-]+\s*(.+)/,

  // Lettered with dash separator: K7—Entry, E4 – The Crypt
  /^([A-Z]\d{1,3}[a-z]?)\s*[—–\-]\s*(.+)/,

  // "Area 12. Guard Room" or "Room 3B: The Chapel"
  /^(?:Area|Room|Chamber|Hall|Crypt|Vault|Tower)\s+(\d{1,3}[a-z]?)[.\s:—–\-]+\s*(.+)/i,

  // Numbered with period: "1. The Entrance", "12. Guard Room"
  /^(\d{1,3})\.\s+([A-Z][A-Za-z\s,']{3,60})$/,

  // Numbered with dash: "1—The Entrance", "12 — Guard Room"
  /^(\d{1,3})\s*[—–\-]\s*([A-Z][A-Za-z\s,']{3,60})$/,

  // Roman numerals: "Room III. The Vault", "Chamber IV: Throne Room"
  /^(?:Room|Chamber|Hall|Level)\s+([IVXLC]+)[.\s:—–\-]+\s*(.+)/i,
];

// Quick test: does a line look like a room heading?
export function isRoomHeading(line) {
  return ROOM_PATTERNS.some(rx => rx.test(line.trim()));
}

// Extract room ID from a heading line (e.g., "K15" from "K15. Chapel")
export function extractRoomId(line) {
  for (const rx of ROOM_PATTERNS) {
    const m = line.trim().match(rx);
    if (m) return m[1];
  }
  return null;
}


// ── Room Reference Patterns (inline mentions) ────────────────
// Find room references WITHIN body text: "see area K15", "leads to Room 7"

export const ROOM_REFERENCE_PATTERN =
  /\b(?:(?:area|room|chamber|hall|see|from|to|via|leads?\s+to|connects?\s+to)\s+)?([A-Z]\d{1,3}[a-z]?)\b/gi;

export const ROOM_REFERENCE_NAMED =
  /\b(?:area|room|chamber)\s+(\d{1,3}[a-z]?)\b/gi;


// ── Cross-Reference Extraction ───────────────────────────────
// Pull all room IDs, page numbers, and named area references
// from body text. Used at index time to build a link graph
// between parent chunks, enabling multi-hop retrieval.

// Page reference patterns: "see page 42", "p. 127", "appendix C"
const PAGE_REF_PATTERNS = [
  /\b(?:see\s+)?(?:page|pg\.?|p\.)\s*(\d{1,4})\b/gi,
  /\bpages?\s+(\d{1,4})\s*[-–—]\s*(\d{1,4})\b/gi,            // "pages 42-45"
  /\b(?:appendix|app\.)\s+([A-Z])\b/gi,                        // "Appendix C"
];

// "See [named section]" patterns: "see "The Crypt"", "described in The Village of Barovia"
const SEE_SECTION_PATTERN =
  /\b(?:see|described\s+in|detailed\s+in|refer\s+to|as\s+described\s+in)\s+[""]?([A-Z][A-Za-z\s,''-]{3,50}?)[""]?(?:\s+(?:section|chapter|area|above|below|on\s+page))?\b/gi;

/**
 * Extract cross-references from a block of text.
 * Returns deduplicated lists of referenced rooms, pages, and named areas.
 * Excludes the chunk's own roomId to avoid self-references.
 *
 * @param {string} text - Full text to scan (parent's fullText)
 * @param {string|null} ownRoomId - This chunk's own room ID (excluded from results)
 * @returns {{ rooms: string[], pages: number[], areas: string[] }}
 */
export function extractCrossReferences(text, ownRoomId = null) {
  const rooms = new Set();
  const pages = new Set();
  const areas = new Set();

  if (!text || text.length < 10) return { rooms: [], pages: [], areas: [] };

  // ── Room references (lettered IDs like K15, E4, T3) ──────
  const rxLettered = new RegExp(ROOM_REFERENCE_PATTERN.source, "gi");
  let m;
  while ((m = rxLettered.exec(text)) !== null) {
    const id = m[1];
    if (id && id !== ownRoomId) rooms.add(id);
  }

  // ── Room references (numbered: "area 12", "room 3b") ─────
  const rxNamed = new RegExp(ROOM_REFERENCE_NAMED.source, "gi");
  while ((m = rxNamed.exec(text)) !== null) {
    const id = m[1];
    if (id && id !== ownRoomId) rooms.add(id);
  }

  // ── Page references ──────────────────────────────────────
  for (const pattern of PAGE_REF_PATTERNS) {
    const rx = new RegExp(pattern.source, pattern.flags);
    while ((m = rx.exec(text)) !== null) {
      if (m[1]) pages.add(parseInt(m[1], 10));
      if (m[2]) pages.add(parseInt(m[2], 10));  // range end
    }
  }

  // ── "See [Section Name]" references ──────────────────────
  const rxSee = new RegExp(SEE_SECTION_PATTERN.source, SEE_SECTION_PATTERN.flags);
  while ((m = rxSee.exec(text)) !== null) {
    const name = m[1]?.trim();
    // Filter out short/generic matches and common false positives
    if (name && name.length > 4 && !/^(?:the|this|that|here|there|above|below|it)\b/i.test(name)) {
      areas.add(name);
    }
  }

  return {
    rooms: [...rooms],
    pages: [...pages].filter(p => p > 0 && p < 9999),
    areas: [...areas],
  };
}


// ── Stat Block Patterns ──────────────────────────────────────
// Detect 5e/5.5e stat block boundaries so they stay as one chunk.

export const STAT_BLOCK = {
  // Size + type + alignment line (usually first line of a stat block)
  header: /^(?:Tiny|Small|Medium|Large|Huge|Gargantuan)\s+\w+(?:\s+\([^)]+\))?,\s*(?:any|lawful|neutral|chaotic|unaligned|typically)/i,

  // Armor Class line
  armorClass: /\bArmor\s+Class\s+(\d{1,2})(?:\s*\(([^)]+)\))?/i,

  // Hit Points line
  hitPoints: /\bHit\s+Points?\s+(\d{1,4})\s*\((\d+d\d+(?:\s*[+\-]\s*\d+)?)\)/i,

  // Speed line
  speed: /\bSpeed\s+(\d+)\s*ft\.?/i,

  // Ability score row: "STR DEX CON INT WIS CHA"
  abilityRow: /\bSTR\s+DEX\s+CON\s+INT\s+WIS\s+CHA\b/,

  // Ability score values: "18 (+4) 14 (+2) ..."
  abilityValues: /\d{1,2}\s*\([+\-]\d+\)/,

  // Challenge rating
  challenge: /\bChallenge\s+(\d{1,2}(?:\/\d+)?)\s*\(([0-9,]+)\s*XP\)/i,

  // Section headers within stat blocks
  sections: /^(?:Actions|Reactions|Legendary Actions|Lair Actions|Bonus Actions|Traits|Mythic Actions)$/i,

  // Proficiency bonus (2024 format)
  profBonus: /\bProficiency\s+Bonus\s+\+(\d+)/i,
};

// Quick test: does a block of text look like it contains a stat block?
export function containsStatBlock(text) {
  return STAT_BLOCK.armorClass.test(text) && STAT_BLOCK.hitPoints.test(text);
}


// ── Read-Aloud / Boxed Text ──────────────────────────────────
// Detect descriptive text meant to be read to players.

export const READ_ALOUD_PATTERNS = [
  // Explicit markers
  /^(?:Read aloud|Read the following|When the (?:characters?|party|players?) .{0,40}read)[:\s]/i,
  /^(?:Read or paraphrase)[:\s]/i,

  // 2nd-person sensory descriptions (very common boxed text opener)
  /^You\s+(?:see|hear|smell|feel|notice|enter|step|approach|find|stand|arrive|emerge|push|open)\b/i,

  // Common boxed text openings (3rd person environmental)
  /^(?:The\s+(?:air|room|chamber|hall|corridor|passage|cave|tunnel|door|walls?|ceiling|floor)\s+(?:is|are|smells?|feels?|grows?|echoes?|opens?))/i,

  // Indented blockquote style (4+ leading spaces after PDF extraction)
  /^\s{4,}[A-Z]/,
];

export function isReadAloud(text) {
  const firstLine = text.split("\n")[0].trim();
  return READ_ALOUD_PATTERNS.some(rx => rx.test(firstLine));
}


// ── Treasure & Loot ──────────────────────────────────────────

export const TREASURE_PATTERNS = [
  // Section headers
  /\b(?:Treasure|Loot|Hoard|Reward|Valuables)s?\b[.\s:—]/i,

  // Currency amounts
  /\b(\d[\d,]*)\s*(?:gp|sp|cp|ep|pp)\b/i,

  // Magic items with "of" pattern
  /\b(?:potion|scroll|wand|ring|amulet|cloak|sword|armor|shield|staff|rod|helm|boots?|gauntlets?|bracers?|belt|cape|robe|bag|lantern|horn|gem|stone)\s+of\s+/i,

  // +N weapons/armor
  /\+\d\s+(?:weapon|armor|shield|sword|axe|mace|dagger|bow|staff|longbow|shortbow|longsword|shortsword|greatsword|greataxe|rapier|scimitar|warhammer|battleaxe|glaive|halberd|lance|maul|morningstar|pike|trident|war\s*pick|hand\s*crossbow|heavy\s*crossbow|light\s*crossbow)/i,

  // Rarity labels
  /\b(?:common|uncommon|rare|very\s+rare|legendary|artifact)\s+(?:magic\s+)?(?:item|weapon|armor|ring|wand|staff|amulet|cloak)/i,
];

export function containsTreasure(text) {
  return TREASURE_PATTERNS.some(rx => rx.test(text));
}


// ── Traps & Hazards ──────────────────────────────────────────

export const TRAP_PATTERNS = [
  // Section headers
  /\b(?:Trap|Hazard|Pit|Snare|Trigger|Tripwire|Glyph|Symbol|Rune)s?\b[.\s:—]/i,

  // Saving throws with DC
  /\bDC\s+(\d{1,2})\s+(?:Dexterity|Strength|Constitution|Intelligence|Wisdom|Charisma)\s+(?:saving\s+throw|check)/i,

  // Damage expressions
  /\btakes?\s+(\d+d\d+(?:\s*[+\-]\s*\d+)?)\s+(?:\w+\s+)?damage\b/i,

  // Detection/disarm
  /\b(?:detect(?:ed|ion)?|disarm(?:ed)?|trigger(?:ed|s)?|notice|spot|find)\s+(?:with|by|using|a)\b/i,

  // Skill DCs for traps
  /\b(?:Perception|Investigation|Thieves['']?\s*tools?|Arcana)\s+(?:DC\s+)?(\d{1,2})\b/i,

  // Mechanical trap language
  /\b(?:pressure\s+plate|trip\s*wire|false\s+floor|poison(?:ed)?\s+(?:needle|dart|gas)|swinging\s+blade|falling\s+(?:net|block|rocks?))\b/i,
];

export function containsTrap(text) {
  return TRAP_PATTERNS.some(rx => rx.test(text));
}


// ── Entity Extraction ────────────────────────────────────────
// Pull structured references out of raw text, pre-search.

export const ENTITY_PATTERNS = {
  // D&D creature types
  creatureType: /\b(?:aberration|beast|celestial|construct|dragon|elemental|fey|fiend|giant|humanoid|monstrosity|ooze|plant|undead)\b/gi,

  // Spell references (e.g., "casts fireball", "concentration on hold person")
  spellCast: /\b(?:cast(?:s|ing)?|concentration\s+on)\s+([a-z][\w\s]{2,30}?)(?:\s+(?:spell|at|on|against|to)|\b[.,;])/gi,

  // Spell name in italics pattern (after PDF extraction, often lowercase standalone)
  spellItalic: /\b(?:detect magic|dispel magic|hold person|fireball|lightning bolt|counterspell|shield|misty step|darkness|silence|web|sleep|charm person|suggestion|dominate person|polymorph|banishment|wall of (?:fire|force|stone|ice|thorns)|spiritual weapon|spirit guardians|healing word|cure wounds|lesser restoration|greater restoration|mass healing word|revivify|raise dead|resurrection)\b/gi,

  // Level/CR references
  levelRef: /\b(?:(\d+)(?:st|nd|rd|th)[- ]level|CR\s+(\d+(?:\/\d+)?)|level\s+(\d+))\b/gi,

  // Dice expressions
  dice: /\b(\d+d\d+(?:\s*[+\-]\s*\d+)?)\b/g,

  // Condition references
  conditions: /\b(?:blinded|charmed|deafened|frightened|grappled|incapacitated|invisible|paralyzed|petrified|poisoned|prone|restrained|stunned|unconscious|exhaustion)\b/gi,

  // Distance measurements
  distance: /\b(\d+)\s*(?:feet|foot|ft\.?|miles?|mi\.?)\b/gi,
};


// ── Query Classification Patterns ────────────────────────────
// Classify GM questions by intent to route searches appropriately.

export const QUERY_PATTERNS = {
  // Room/location lookup: "what's in K15", "describe Area 12", "tell me about Room 3B"
  roomQuery: /\b(?:what(?:'s| is) (?:in|at)|describe|tell me about|what happens (?:in|at)|what(?:'s| is) (?:on|in) (?:the\s+)?(?:\d+(?:st|nd|rd|th)\s+)?(?:floor|level))\s*(?:(?:room|area|chamber|hall)?\s*)?([A-Z]?\d{1,3}[a-z]?)?\b/i,

  // Floor/level query: "what's on the 3rd floor", "describe level 2"
  floorQuery: /\b(?:(\d+)(?:st|nd|rd|th)|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\s+(?:floor|level|story|storey)\b/i,

  // NPC query: "who is Strahd", "tell me about Ireena"
  npcQuery: /\b(?:who is|tell me about|what do (?:I|we) know about|describe|info (?:on|about))\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/,

  // Rules query: "how does grapple work", "what are the rules for"
  rulesQuery: /\b(?:how (?:does|do)|what (?:are|is) the rules? for|rules? (?:for|about|on)|can (?:I|a player|we|they)|does .+ stack|when (?:do|does|can))\b/i,

  // Tactical query: "what should the enemies do", "suggest tactics"
  tacticalQuery: /\b(?:tactics?|strategy|what should .{1,30} do|how (?:should|would) .{1,30} (?:fight|attack|act|respond|react)|battle plan)\b/i,

  // Lore query: "history of", "what happened to", "lore about"
  loreQuery: /\b(?:history (?:of|about)|lore (?:of|about)|what happened (?:to|in|at|with)|background (?:of|on)|origin (?:of|story))\b/i,

  // Encounter/combat query: "what monsters are here", "random encounter"
  encounterQuery: /\b(?:(?:random )?encounter|monsters? (?:here|in|at|on)|creatures? (?:here|in|at|on)|what (?:fights?|enemies|threats?|dangers?))\b/i,

  // Treasure/loot query: "what treasure", "any loot", "what items"
  treasureQuery: /\b(?:treasure|loot|hoard|reward|items?|what(?:'s| is) (?:the )?(?:treasure|loot|reward))\b/i,
};

/**
 * Classify a query and return the detected intent + any extracted entities.
 * @param {string} query
 * @returns {{ intent: string, entities: Object }}
 */
export function classifyQuery(query) {
  const trimmed = query.trim();
  const result = { intent: "general", entities: {} };

  // Check each pattern in priority order
  if (QUERY_PATTERNS.roomQuery.test(trimmed)) {
    result.intent = "room";
    const m = trimmed.match(QUERY_PATTERNS.roomQuery);
    if (m?.[1]) result.entities.roomId = m[1];
  } else if (QUERY_PATTERNS.floorQuery.test(trimmed)) {
    result.intent = "floor";
    const m = trimmed.match(QUERY_PATTERNS.floorQuery);
    if (m?.[1]) result.entities.floorNum = m[1];
  } else if (QUERY_PATTERNS.npcQuery.test(trimmed)) {
    result.intent = "npc";
    const m = trimmed.match(QUERY_PATTERNS.npcQuery);
    if (m?.[1]) result.entities.npcName = m[1];
  } else if (QUERY_PATTERNS.encounterQuery.test(trimmed)) {
    result.intent = "encounter";
  } else if (QUERY_PATTERNS.treasureQuery.test(trimmed)) {
    result.intent = "treasure";
  } else if (QUERY_PATTERNS.tacticalQuery.test(trimmed)) {
    result.intent = "tactical";
  } else if (QUERY_PATTERNS.rulesQuery.test(trimmed)) {
    result.intent = "rules";
  } else if (QUERY_PATTERNS.loreQuery.test(trimmed)) {
    result.intent = "lore";
  }

  // Reset lastIndex on all global regexes (safety)
  for (const rx of Object.values(QUERY_PATTERNS)) rx.lastIndex = 0;

  return result;
}


// ── Floor/Level Number Normalization ─────────────────────────
// Convert ordinal words to numbers: "third" → 3, "3rd" → 3

const ORDINAL_WORDS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12,
  basement: -1, cellar: -1, dungeon: -1,
  ground: 0, main: 1, top: 99,
};

export function normalizeFloorNumber(text) {
  const lower = text.toLowerCase();

  // "3rd", "1st", "2nd", "4th"
  const numMatch = lower.match(/(\d+)(?:st|nd|rd|th)/);
  if (numMatch) return parseInt(numMatch[1], 10);

  // Word ordinals
  for (const [word, num] of Object.entries(ORDINAL_WORDS)) {
    if (lower.includes(word)) return num;
  }

  // Plain digit
  const plain = lower.match(/\b(\d+)\b/);
  if (plain) return parseInt(plain[1], 10);

  return null;
}


// ── Heading Level Detection ──────────────────────────────────
// Determine the depth of a heading in document hierarchy.

export const HEADING_PATTERNS = [
  // Chapter-level (level 1): "Chapter 4:", "CHAPTER IV", "Part 2"
  { level: 1, rx: /^(?:Chapter|Part|Book|Act|Section)\s+(?:\d+|[IVXLC]+)[.\s:—–\-]/i },

  // Appendix (level 1)
  { level: 1, rx: /^(?:Appendix|Introduction|Epilogue|Prologue|Preface)\b/i },

  // Sub-chapter / Area (level 2): "The Village of Barovia", ALL-CAPS lines
  { level: 2, rx: /^[A-Z][A-Z\s\-'',]{8,80}$/ },

  // Floor/Level (level 2): "First Floor", "Dungeon Level 2"
  { level: 2, rx: /^(?:\w+\s+)?(?:Floor|Level|Dungeon Level|Sub-Level)\s*\d*/i },

  // Room/Area (level 3): matches ROOM_PATTERNS
  { level: 3, rx: null },  // handled by isRoomHeading()

  // Sub-section (level 4): "Treasure", "Developments", "Adjusting the Encounter"
  { level: 4, rx: /^(?:Treasure|Developments?|Adjusting|Tactics|Fortifications|Roleplaying|Features?\s+of|General\s+Features)\b/i },

  // Markdown headings (fallback)
  { level: 1, rx: /^#\s+/ },
  { level: 2, rx: /^##\s+/ },
  { level: 3, rx: /^###\s+/ },
  { level: 4, rx: /^####\s+/ },
];

/**
 * Detect the hierarchy level of a heading line.
 * @param {string} line
 * @returns {{ level: number, type: string } | null}
 */
export function detectHeadingLevel(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 2) return null;

  // Check room patterns first (level 3)
  if (isRoomHeading(trimmed)) {
    return { level: 3, type: "room" };
  }

  for (const { level, rx } of HEADING_PATTERNS) {
    if (rx && rx.test(trimmed)) {
      let type = "heading";
      if (level === 1) type = "chapter";
      if (level === 2) type = "area";
      if (level === 4) type = "subsection";
      return { level, type };
    }
  }

  return null;
}


// ── Section Type Labels ──────────────────────────────────────
// Content-type flags applied to chunks for search boosting.

export const SECTION_TYPES = {
  ROOM:        "room",
  STAT_BLOCK:  "stat_block",
  READ_ALOUD:  "read_aloud",
  TREASURE:    "treasure",
  TRAP:        "trap",
  ENCOUNTER:   "encounter",
  CHAPTER:     "chapter",
  AREA:        "area",
  LORE:        "lore",
  RULES:       "rules",
  APPENDIX:    "appendix",
  GENERIC:     "generic",
};


// ── Regex Search (Full-Text Scan) ────────────────────────────
// Fast regex search across full document text for exact matches.

/**
 * Build a regex that matches any of the given terms, with word boundaries.
 * Handles multi-word terms and special characters.
 * @param {string[]} terms
 * @param {Object} [opts]
 * @param {boolean} [opts.caseInsensitive=true]
 * @param {boolean} [opts.wholeWord=true]
 * @returns {RegExp}
 */
export function buildTermRegex(terms, opts = {}) {
  const { caseInsensitive = true, wholeWord = true } = opts;
  const escaped = terms
    .filter(t => t.length > 0)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return null;

  const pattern = escaped.join("|");
  const wrapped = wholeWord ? `\\b(?:${pattern})\\b` : `(?:${pattern})`;
  const flags = caseInsensitive ? "gi" : "g";
  return new RegExp(wrapped, flags);
}

/**
 * Build a regex for floor-level searches.
 * "3rd floor" → matches "3rd floor", "third floor", "floor 3", "level 3", etc.
 * @param {number} floorNum
 * @returns {RegExp}
 */
export function buildFloorRegex(floorNum) {
  const ordinals = Object.entries(ORDINAL_WORDS)
    .filter(([, n]) => n === floorNum)
    .map(([w]) => w);

  const numOrdinal = `${floorNum}(?:st|nd|rd|th)`;
  const patterns = [
    `${numOrdinal}\\s+(?:floor|level|story|storey)`,
    `(?:floor|level|story|storey)\\s+${floorNum}`,
    ...ordinals.map(w => `${w}\\s+(?:floor|level|story|storey)`),
  ];

  return new RegExp(`\\b(?:${patterns.join("|")})\\b`, "gi");
}

/**
 * Build a regex for room ID searches.
 * "K15" → matches "K15", "area K15", "room K15", "see K15", "(K15)"
 * @param {string} roomId
 * @returns {RegExp}
 */
export function buildRoomRegex(roomId) {
  const escaped = roomId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "gi");
}


// ── Content Flag Detection ───────────────────────────────────
// Scan text and return all applicable content flags.

/**
 * Detect content types present in a text block.
 * @param {string} text
 * @returns {string[]} Array of SECTION_TYPES values
 */
export function detectContentFlags(text) {
  const flags = [];
  if (containsStatBlock(text))  flags.push(SECTION_TYPES.STAT_BLOCK);
  if (isReadAloud(text))        flags.push(SECTION_TYPES.READ_ALOUD);
  if (containsTreasure(text))   flags.push(SECTION_TYPES.TREASURE);
  if (containsTrap(text))       flags.push(SECTION_TYPES.TRAP);
  return flags;
}
