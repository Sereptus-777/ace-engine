// ============================================================
// ACE — AI Campaign Engine — Query Classifier
// Analyzes GM queries to determine intent, extract entities,
// expand search terms, and configure search strategy.
// Uses regex patterns from the D&D pattern library.
// ============================================================

import {
  classifyQuery,
  extractRoomId,
  normalizeFloorNumber,
  buildTermRegex,
  buildFloorRegex,
  buildRoomRegex,
  ROOM_REFERENCE_PATTERN,
  ROOM_REFERENCE_NAMED,
  ENTITY_PATTERNS,
  QUERY_PATTERNS,
  SECTION_TYPES,
} from "./regex-patterns.mjs";

import { tokenize } from "./bm25.mjs";


// ── Floor number words → digits (for query expansion) ────────
const FLOOR_WORDS = {
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5",
  sixth: "6", seventh: "7", eighth: "8", ninth: "9", tenth: "10",
  basement: "basement", cellar: "cellar", dungeon: "dungeon",
  ground: "ground", main: "1", top: "top",
};


// ── QueryClassifier ──────────────────────────────────────────

export class QueryClassifier {

  /**
   * Fully classify a GM query: intent, entities, search terms, strategy.
   *
   * @param {string} query - The GM's raw message
   * @param {Object} [context]
   * @param {string} [context.sceneName] - Current Foundry scene name
   * @param {string} [context.sceneDescription] - Scene description/notes
   * @param {string[]} [context.visibleNpcs] - NPC names on canvas
   * @returns {QueryAnalysis}
   */
  classify(query, context = {}) {
    const analysis = {
      // What the GM is asking about
      intent: "general",

      // Extracted structured entities
      entities: {
        rooms:     [],    // ["K15", "K16"]
        npcs:      [],    // ["Strahd", "Ireena"]
        locations: [],    // ["Argynvostholt", "Castle Ravenloft"]
        spells:    [],    // ["fireball", "hold person"]
        creatures: [],    // ["undead", "fiend"]
        floorNum:  null,  // 3
      },

      // Search terms (tokenized, stop-words removed, D&D words kept)
      searchTerms: [],

      // Expanded terms (synonyms, floor variants, etc.)
      expandedTerms: [],

      // Regex patterns for pre-search (exact match pass)
      preSearchPatterns: [],

      // Which section types to boost in BM25 results
      sectionBoosts: {},

      // Which data sources to prioritize
      sourceWeights: {
        pdf_chunk: 1.0,
        digest:    1.0,
        world_bible: 1.0,
        npc_memory:  1.0,
        session_log: 1.0,
      },

      // Original query
      rawQuery: query,
    };

    // ── Step 1: Basic intent classification ──────────────────
    const baseClass = classifyQuery(query);
    analysis.intent = baseClass.intent;
    if (baseClass.entities.roomId) {
      analysis.entities.rooms.push(baseClass.entities.roomId);
    }
    if (baseClass.entities.npcName) {
      analysis.entities.npcs.push(baseClass.entities.npcName);
    }

    // ── Step 2: Extract search terms ─────────────────────────
    analysis.searchTerms = tokenize(query);

    // ── Step 3: Extract room references ──────────────────────
    this._extractRoomRefs(query, analysis);

    // ── Step 4: Extract proper nouns (potential NPC/location names) ─
    this._extractProperNouns(query, analysis);

    // ── Step 5: Extract floor/level references ───────────────
    this._extractFloorRefs(query, analysis);

    // ── Step 6: Extract creature types ───────────────────────
    this._extractCreatureTypes(query, analysis);

    // ── Step 7: Add context-based terms ──────────────────────
    this._addContextTerms(context, analysis);

    // ── Step 8: Build expanded terms (synonyms, variants) ────
    this._expandTerms(analysis);

    // ── Step 9: Build pre-search regex patterns ──────────────
    this._buildPreSearchPatterns(analysis);

    // ── Step 10: Configure boosts and source weights ─────────
    this._configureStrategy(analysis);

    // Deduplicate all arrays
    analysis.searchTerms   = [...new Set(analysis.searchTerms)];
    analysis.expandedTerms = [...new Set(analysis.expandedTerms)];
    analysis.entities.rooms     = [...new Set(analysis.entities.rooms)];
    analysis.entities.npcs      = [...new Set(analysis.entities.npcs)];
    analysis.entities.locations = [...new Set(analysis.entities.locations)];
    analysis.entities.spells    = [...new Set(analysis.entities.spells)];
    analysis.entities.creatures = [...new Set(analysis.entities.creatures)];

    return analysis;
  }


  // ── Private: Entity Extraction ─────────────────────────────

  _extractRoomRefs(query, analysis) {
    // Find all room ID patterns in the query (K15, Area 12, etc.)
    const patterns = [ROOM_REFERENCE_PATTERN, ROOM_REFERENCE_NAMED];
    for (const rx of patterns) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(query)) !== null) {
        const roomId = m[1];
        if (roomId && roomId.length <= 6) {
          analysis.entities.rooms.push(roomId.toUpperCase());
        }
      }
    }
  }

  _extractProperNouns(query, analysis) {
    // Find capitalized multi-word names that aren't at sentence start
    // "What is in Castle Ravenloft?" → "Castle Ravenloft"
    // "Who is Strahd von Zarovich?" → "Strahd von Zarovich"
    const nameRx = /\b([A-Z][a-z]{2,}(?:\s+(?:von|van|de|the|of|el|al|le|la)\s+)?(?:[A-Z][a-z]{2,})?(?:\s+[A-Z][a-z]{2,})?)\b/g;
    let m;
    while ((m = nameRx.exec(query)) !== null) {
      const name = m[1].trim();
      // Skip common English words that happen to be capitalized at sentence start
      const skipWords = new Set([
        "What", "Where", "When", "Who", "How", "Why", "Which",
        "Tell", "Describe", "Show", "Give", "List", "Find",
        "Can", "Could", "Would", "Should", "Does", "Did",
        "The", "This", "That", "These", "Those", "Any",
      ]);
      const firstWord = name.split(/\s/)[0];
      if (skipWords.has(firstWord)) continue;

      // Determine if this is likely an NPC or location
      // Heuristic: if it appears after "who is" or "about", it's an NPC
      const beforeMatch = query.slice(0, m.index).toLowerCase();
      if (/(?:who is|talk to|speak to|ask)\s*$/.test(beforeMatch)) {
        analysis.entities.npcs.push(name);
      } else {
        // Could be either — add to both search terms and locations
        analysis.entities.locations.push(name);
      }

      // Always add as a search term (lowercased)
      analysis.searchTerms.push(name.toLowerCase());
    }
  }

  _extractFloorRefs(query, analysis) {
    const lower = query.toLowerCase();

    // Numeric ordinals: "3rd floor", "1st level"
    const numMatch = lower.match(/(\d+)(?:st|nd|rd|th)\s+(?:floor|level|story|storey)/);
    if (numMatch) {
      analysis.entities.floorNum = parseInt(numMatch[1], 10);
    }

    // Word ordinals: "third floor", "second level"
    if (!analysis.entities.floorNum) {
      for (const [word, digit] of Object.entries(FLOOR_WORDS)) {
        const rx = new RegExp(`\\b${word}\\s+(?:floor|level|story|storey)`, "i");
        if (rx.test(lower)) {
          const num = parseInt(digit, 10);
          if (!isNaN(num)) analysis.entities.floorNum = num;
          break;
        }
      }
    }

    // "floor 3", "level 2"
    if (!analysis.entities.floorNum) {
      const plainMatch = lower.match(/\b(?:floor|level)\s+(\d+)\b/);
      if (plainMatch) {
        analysis.entities.floorNum = parseInt(plainMatch[1], 10);
      }
    }
  }

  _extractCreatureTypes(query, analysis) {
    ENTITY_PATTERNS.creatureType.lastIndex = 0;
    let m;
    while ((m = ENTITY_PATTERNS.creatureType.exec(query)) !== null) {
      analysis.entities.creatures.push(m[0].toLowerCase());
    }
  }

  // ── Private: Context Integration ───────────────────────────

  _addContextTerms(context, analysis) {
    // Add scene name as search terms (split on common separators)
    if (context.sceneName) {
      const sceneWords = context.sceneName
        .split(/[\s_\-—–,.:]+/)
        .filter(w => w.length > 2)
        .map(w => w.toLowerCase());
      // Add up to 4 scene name words
      for (const w of sceneWords.slice(0, 4)) {
        if (!analysis.searchTerms.includes(w)) {
          analysis.searchTerms.push(w);
        }
      }
    }

    // If NPC names are visible on canvas, boost NPC-related results
    if (context.visibleNpcs?.length) {
      for (const npc of context.visibleNpcs.slice(0, 5)) {
        const lower = npc.toLowerCase();
        if (!analysis.searchTerms.includes(lower)) {
          analysis.expandedTerms.push(lower);
        }
      }
    }
  }

  // ── Private: Term Expansion ────────────────────────────────

  _expandTerms(analysis) {
    // Start with all search terms
    analysis.expandedTerms.push(...analysis.searchTerms);

    // Add room IDs as search terms
    for (const roomId of analysis.entities.rooms) {
      analysis.expandedTerms.push(roomId.toLowerCase());
    }

    // Add NPC names as search terms
    for (const npc of analysis.entities.npcs) {
      analysis.expandedTerms.push(npc.toLowerCase());
    }

    // Add location names as search terms
    for (const loc of analysis.entities.locations) {
      analysis.expandedTerms.push(loc.toLowerCase());
    }

    // Floor-level expansion: if asking about "3rd floor", add variant terms
    if (analysis.entities.floorNum !== null) {
      const num = analysis.entities.floorNum;
      const ordinalSuffix = num === 1 ? "st" : num === 2 ? "nd" : num === 3 ? "rd" : "th";
      analysis.expandedTerms.push(
        `${num}${ordinalSuffix}`,
        `floor ${num}`,
        `level ${num}`,
        `floor`,
        `level`,
      );

      // Add word ordinal
      const wordMap = Object.entries(FLOOR_WORDS).find(([, v]) => v === String(num));
      if (wordMap) {
        analysis.expandedTerms.push(wordMap[0]);
      }
    }
  }

  // ── Private: Pre-Search Patterns ───────────────────────────

  _buildPreSearchPatterns(analysis) {
    // Room ID exact match regex
    for (const roomId of analysis.entities.rooms) {
      analysis.preSearchPatterns.push({
        type: "room",
        regex: buildRoomRegex(roomId),
        label: `Room ${roomId}`,
      });
    }

    // Floor-level regex (matches all variants)
    if (analysis.entities.floorNum !== null) {
      analysis.preSearchPatterns.push({
        type: "floor",
        regex: buildFloorRegex(analysis.entities.floorNum),
        label: `Floor ${analysis.entities.floorNum}`,
      });
    }

    // NPC name exact match
    for (const npc of analysis.entities.npcs) {
      analysis.preSearchPatterns.push({
        type: "npc",
        regex: buildTermRegex([npc], { wholeWord: true }),
        label: `NPC: ${npc}`,
      });
    }

    // Location name exact match
    for (const loc of analysis.entities.locations) {
      if (loc.length >= 4) {
        analysis.preSearchPatterns.push({
          type: "location",
          regex: buildTermRegex([loc], { wholeWord: true }),
          label: `Location: ${loc}`,
        });
      }
    }
  }

  // ── Private: Strategy Configuration ────────────────────────

  _configureStrategy(analysis) {
    switch (analysis.intent) {
      case "room":
        analysis.sectionBoosts = {
          [SECTION_TYPES.ROOM]: 2.0,
          [SECTION_TYPES.TREASURE]: 1.3,
          [SECTION_TYPES.TRAP]: 1.3,
          [SECTION_TYPES.ENCOUNTER]: 1.2,
        };
        analysis.sourceWeights.pdf_chunk   = 1.5;
        analysis.sourceWeights.digest      = 1.0;
        analysis.sourceWeights.npc_memory  = 0.5;
        break;

      case "floor":
        analysis.sectionBoosts = {
          [SECTION_TYPES.ROOM]: 1.8,
          [SECTION_TYPES.AREA]: 1.5,
          [SECTION_TYPES.ENCOUNTER]: 1.2,
        };
        analysis.sourceWeights.pdf_chunk   = 1.5;
        analysis.sourceWeights.digest      = 1.2;
        break;

      case "npc":
        analysis.sectionBoosts = {
          [SECTION_TYPES.STAT_BLOCK]: 1.5,
          [SECTION_TYPES.LORE]: 1.3,
        };
        analysis.sourceWeights.npc_memory  = 2.0;
        analysis.sourceWeights.digest      = 1.5;
        analysis.sourceWeights.pdf_chunk   = 1.0;
        break;

      case "encounter":
        analysis.sectionBoosts = {
          [SECTION_TYPES.ENCOUNTER]: 2.0,
          [SECTION_TYPES.STAT_BLOCK]: 1.5,
          [SECTION_TYPES.ROOM]: 1.2,
        };
        analysis.sourceWeights.pdf_chunk = 1.3;
        analysis.sourceWeights.digest    = 1.3;
        break;

      case "treasure":
        analysis.sectionBoosts = {
          [SECTION_TYPES.TREASURE]: 2.5,
          [SECTION_TYPES.ROOM]: 1.2,
        };
        analysis.sourceWeights.pdf_chunk = 1.5;
        break;

      case "tactical":
        analysis.sectionBoosts = {
          [SECTION_TYPES.ENCOUNTER]: 1.5,
          [SECTION_TYPES.STAT_BLOCK]: 1.8,
          [SECTION_TYPES.TRAP]: 1.3,
        };
        analysis.sourceWeights.pdf_chunk = 1.3;
        break;

      case "lore":
        analysis.sectionBoosts = {
          [SECTION_TYPES.LORE]: 2.0,
          [SECTION_TYPES.CHAPTER]: 1.3,
          [SECTION_TYPES.AREA]: 1.2,
        };
        analysis.sourceWeights.digest      = 1.5;
        analysis.sourceWeights.world_bible = 1.5;
        analysis.sourceWeights.session_log = 1.2;
        break;

      case "rules":
        analysis.sectionBoosts = {
          [SECTION_TYPES.RULES]: 2.0,
          [SECTION_TYPES.APPENDIX]: 1.5,
        };
        analysis.sourceWeights.pdf_chunk = 1.5;
        analysis.sourceWeights.npc_memory = 0.3;
        break;

      default:
        // General query — balanced weights
        break;
    }
  }
}


// ── Type Definitions ─────────────────────────────────────────

/**
 * @typedef {Object} QueryAnalysis
 * @property {string} intent - "room"|"floor"|"npc"|"lore"|"rules"|"tactical"|"encounter"|"treasure"|"general"
 * @property {Object} entities
 * @property {string[]} entities.rooms - Room IDs found (e.g., ["K15"])
 * @property {string[]} entities.npcs - NPC names found
 * @property {string[]} entities.locations - Location names found
 * @property {string[]} entities.spells - Spell names found
 * @property {string[]} entities.creatures - Creature types found
 * @property {number|null} entities.floorNum - Floor number (normalized)
 * @property {string[]} searchTerms - Tokenized search terms (stop words removed)
 * @property {string[]} expandedTerms - All terms including expansions
 * @property {Array<{type: string, regex: RegExp, label: string}>} preSearchPatterns - Regex patterns for exact pre-search
 * @property {Object<string, number>} sectionBoosts - Section type → score multiplier
 * @property {Object<string, number>} sourceWeights - Data source → weight multiplier
 * @property {string} rawQuery - Original query string
 */
