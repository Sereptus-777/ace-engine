// ============================================================
// ACE — AI Campaign Engine — Scene Intelligence Layer
// Pre-computes location intelligence for a scene using the full
// search pipeline (document library + World Bible + cross-refs).
// Cached per scene — one deep scan, reused by every token drop,
// faction assignment, bio generation, and conversation.
// ============================================================

const MODULE_ID = "ace-engine";

const TAG = `${MODULE_ID} | SceneIntel`;

/** Cache: sceneId → { data: SceneIntelligence, timestamp } */
const _cache = new Map();

/** Cache TTL: 5 minutes — invalidated on scene change anyway */
const CACHE_TTL = 5 * 60 * 1000;

/**
 * @typedef {Object} CanonicalFaction
 * @property {string} name — Faction name
 * @property {string} type — e.g. "order", "settlement", "military", "cult", "tribe"
 * @property {string} status — "active", "defunct", "hidden", "unknown"
 * @property {string} source — Where this came from: "digest", "world_bible", "world_graph"
 * @property {string} [description] — Brief description
 * @property {string} [leader] — Known leader
 * @property {string[]} [creatureTypes] — What creature types belong here (commoner, guard, knight, etc.)
 */

/**
 * @typedef {Object} SceneIntelligence
 * @property {string} sceneId
 * @property {string} sceneName
 * @property {string} location — Parsed location name
 * @property {string} description — What this place is
 * @property {string} region — Geographic region
 * @property {string} nation — Nation/domain
 * @property {CanonicalFaction[]} canonicalFactions — Factions from source material
 * @property {string[]} keyNPCs — Named NPCs associated with this location
 * @property {string[]} deities — Relevant deities for this region
 * @property {string} culturalContext — Brief cultural/thematic description
 * @property {string[]} nearbyLocations — Connected/adjacent locations
 * @property {number} timestamp — When this was generated
 */

/**
 * Parse a Foundry scene name into location keywords.
 * Handles patterns like "BM: Argynvostholt 3F", "Castle Ravenloft - K15", etc.
 * @param {string} sceneName
 * @returns {{ location: string, roomId: string|null, floor: string|null, keywords: string[] }}
 */
function _parseSceneName(sceneName) {
  if (!sceneName) return { location: "", roomId: null, floor: null, keywords: [] };

  let name = sceneName.trim();

  // Strip common prefixes: "BM:", "Map:", "Scene:", etc.
  name = name.replace(/^(?:BM|Map|Scene|Area|Level|Floor)\s*[:—–\-]\s*/i, "").trim();

  // Extract room ID (K15, E4, T3, etc.)
  const roomMatch = name.match(/\b([A-Z]\d{1,3}[a-z]?)\b/);
  const roomId = roomMatch ? roomMatch[1] : null;

  // Extract floor indicator (1F, 2F, B1, etc.)
  const floorMatch = name.match(/\b(\d+F|B\d+|Floor\s*\d+|Level\s*\d+)\b/i);
  const floor = floorMatch ? floorMatch[1] : null;

  // Clean location name: remove room IDs, floor indicators, punctuation noise
  let location = name
    .replace(/\b[A-Z]\d{1,3}[a-z]?\b/g, "")        // room IDs
    .replace(/\b\d+F\b/gi, "")                       // floor indicators
    .replace(/\bB\d+\b/g, "")                        // basement floors
    .replace(/\bFloor\s*\d+\b/gi, "")
    .replace(/\bLevel\s*\d+\b/gi, "")
    .replace(/[\s\-—–]+/g, " ")                      // normalize whitespace
    .replace(/^\s*[,\-—–:]\s*/, "")                  // leading punctuation
    .replace(/\s*[,\-—–:]\s*$/, "")                  // trailing punctuation
    .trim();

  // Build keyword list (words > 3 chars, no stopwords)
  const stopwords = new Set(["the", "and", "for", "with", "from", "into", "this", "that", "area", "room", "map", "scene"]);
  const keywords = location
    .split(/[\s_\-—–,.:]+/)
    .filter(w => w.length > 2)
    .map(w => w.toLowerCase())
    .filter(w => !stopwords.has(w));

  return { location: location || sceneName, roomId, floor, keywords };
}

/**
 * Extract faction-like entities from document search results.
 * Scans the formatted context text for faction names, organizations, groups.
 * @param {string} docContext — Formatted document context from search
 * @returns {CanonicalFaction[]}
 */
function _extractFactionsFromDocContext(docContext) {
  if (!docContext || docContext.length < 20) return [];

  const factions = [];
  const seen = new Set();

  // Patterns that indicate faction/organization mentions
  const factionPatterns = [
    // "the Order of X", "the Knights of X", "the Brotherhood of X"
    /\b(?:the\s+)?(Order|Knights|Brotherhood|Sisters|Cult|Church|Temple|Guild|Society|Alliance|Legion|Clan|Tribe|House|Council|Circle|Band|Company|Coven|Court|Guard|Garrison|Patrol|Watch)\s+of\s+(?:the\s+)?([A-Z][\w\s]{2,30}?)(?=[.,;!\?\)\]\n]|$)/gi,
    // "X's Forces", "X's Army", "X's Followers"
    /\b([A-Z][\w]+(?:'s|'s))\s+(Forces|Army|Followers|Servants|Minions|Guard|Militia|Agents|Spies|Cultists|Warriors|Troops)/gi,
    // Named groups with "the": "the Harpers", "the Zhentarim", "the Vistani"
    /\b(?:the\s+)((?:[A-Z][\w]+(?:\s+[A-Z][\w]+)?){1,3})(?=\s+(?:are|is|were|was|have|had|control|operate|patrol|guard|worship|serve))/gi,
    // "X tribe", "X warband", "X cult"
    /\b([A-Z][\w]+(?:\s+[A-Z][\w]+)?)\s+(tribe|warband|cult|gang|clan|guild|order|faction|sect|cabal)/gi,
  ];

  for (const pattern of factionPatterns) {
    const rx = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = rx.exec(docContext)) !== null) {
      // Reconstruct the full faction name from the match
      const fullMatch = m[0].trim();
      let name = fullMatch
        .replace(/^the\s+/i, "")
        .replace(/\s+(?:are|is|were|was|have|had|control|operate|patrol|guard|worship|serve).*$/i, "");

      // Clean up
      name = name.trim();
      if (name.length < 4 || name.length > 60) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // Guess faction type from keywords
      let type = "organization";
      const lower = name.toLowerCase();
      if (/order|knight/i.test(lower)) type = "order";
      else if (/cult|coven|sect|cabal/i.test(lower)) type = "cult";
      else if (/tribe|clan/i.test(lower)) type = "tribe";
      else if (/guild|company/i.test(lower)) type = "guild";
      else if (/guard|garrison|legion|army|forces|militia|patrol|watch/i.test(lower)) type = "military";
      else if (/temple|church/i.test(lower)) type = "temple";
      else if (/society|alliance|circle|council/i.test(lower)) type = "organization";
      else if (/gang|band|warband/i.test(lower)) type = "gang";
      else if (/house|court/i.test(lower)) type = "noble house";

      factions.push({
        name,
        type,
        status: "unknown",
        source: "digest",
      });
    }
  }

  return factions;
}

/**
 * Extract factions from World Bible data for a region/location.
 * @param {Object} worldBible — World Bible engine instance
 * @param {string} location — Location name
 * @param {string[]} keywords — Search keywords
 * @returns {CanonicalFaction[]}
 */
function _extractFactionsFromBible(worldBible, location, keywords) {
  if (!worldBible) return [];

  const factions = [];
  const seen = new Set();

  try {
    // Search Bible factions
    const bibleFactions = worldBible.searchCategory?.("factions", location) ?? [];
    for (const f of bibleFactions.slice(0, 15)) {
      const name = f.name || f.Name || "";
      if (!name || name.length < 3) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      factions.push({
        name,
        type: f.type || f.category || "organization",
        status: "active",
        source: "world_bible",
        description: f.description || f.notes || "",
        purpose: f.purpose || "",
        leader: f.leader || f.Leader || null,
        alignment: f.alignment || "",
        allies: f.allies || [],
        enemies: f.enemies || [],
        scope: f.scope || "",
        presence: f.presence || [],
        headquarters: f.headquarters || "",
      });
    }

    // Also search by keywords
    for (const kw of keywords.slice(0, 3)) {
      const results = worldBible.searchCategory?.("factions", kw) ?? [];
      for (const f of results.slice(0, 5)) {
        const name = f.name || f.Name || "";
        if (!name || name.length < 3) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        factions.push({
          name,
          type: f.type || f.category || "organization",
          status: "active",
          source: "world_bible",
          description: f.description || f.notes || "",
          purpose: f.purpose || "",
          leader: f.leader || f.Leader || null,
          alignment: f.alignment || "",
          allies: f.allies || [],
          enemies: f.enemies || [],
          scope: f.scope || "",
          presence: f.presence || [],
          headquarters: f.headquarters || "",
        });
      }
    }

    // Search cities for the location — cities often list ruling factions
    const cities = worldBible.searchCategory?.("cities", location) ?? [];
    for (const city of cities.slice(0, 3)) {
      if (city.rulingFaction || city.ruler) {
        const name = city.rulingFaction || `${city.ruler}'s Government`;
        const key = name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          factions.push({
            name,
            type: "government",
            status: "active",
            source: "world_bible",
            description: `Government of ${city.name || location}`,
            leader: city.ruler || null,
          });
        }
      }
    }
  } catch (err) {
    console.warn(`${TAG} | Bible faction extraction failed:`, err);
  }

  return factions;
}

/**
 * Extract factions from active digest data (adventure module digests).
 * Searches all cached digests for factions whose name or territory
 * matches the scene location or keywords.
 * @param {Object} digestEngine — DigestEngine instance
 * @param {string} location — Scene location name
 * @param {string[]} keywords — Search keywords from scene name
 * @returns {CanonicalFaction[]}
 */
function _extractFactionsFromDigests(digestEngine, location, keywords) {
  if (!digestEngine?._cache) return [];

  const factions = [];
  const seen = new Set();
  const locationLower = (location || "").toLowerCase();
  const kwSet = new Set(keywords.map(k => k.toLowerCase()));

  try {
    for (const [digestId, digestData] of digestEngine._cache) {
      const digest = digestData?.digest;
      if (!digest?.factions?.length) continue;

      for (const f of digest.factions) {
        const name = f.name || "";
        if (!name || name.length < 3) continue;
        // Skip single-word generic names (e.g. "Temples", "Vampire", "Guard")
        if (!name.includes(" ") && name.length < 12) continue;
        // Skip factions with no territory data — they're too generic to match reliably
        if (!(f.territory || "").trim()) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;

        // Check if this faction is relevant to the scene
        const territory = (f.territory || "").toLowerCase();
        const goals = (f.goals || "").toLowerCase();
        const fNameLower = key;
        let matched = false;
        let matchedVia = "digest";
        let score = 10;

        // Location match in territory or name
        if (locationLower && (territory.includes(locationLower) || fNameLower.includes(locationLower))) {
          matched = true;
          matchedVia = `digest_territory:${location}`;
          score = 90;
        }
        // Keyword match in territory, name, or goals
        if (!matched) {
          for (const kw of kwSet) {
            if (kw.length < 3) continue;
            if (territory.includes(kw) || fNameLower.includes(kw) || goals.includes(kw)) {
              matched = true;
              matchedVia = `digest_keyword:${kw}`;
              score = 60;
              break;
            }
          }
        }

        if (!matched) continue;

        seen.add(key);
        factions.push({
          name,
          type: f.type || "organization",
          alignment: f.alignment || "",
          status: "active",
          source: "digest",
          description: f.description || f.goals || "",
          purpose: f.goals || "",
          leader: f.leader || null,
          allies: f.allies || "",
          enemies: f.enemies || "",
          _matchedVia: matchedVia,
          _score: score,
          // Preserve digest fields for scoring
          territory: f.territory,
          scope: territory.includes("barovia") || territory.includes("valley") ? "regional" : "local",
        });
      }
    }
  } catch (err) {
    console.warn(`${TAG} | Digest faction extraction failed:`, err);
  }

  return factions;
}

/**
 * Extract key NPCs and deities from search results.
 * @param {string} docContext
 * @param {Object} worldBible
 * @param {string} location
 * @returns {{ npcs: string[], deities: string[], culturalContext: string }}
 */
function _extractAdditionalContext(docContext, worldBible, location) {
  const npcs = new Set();
  const deities = new Set();
  let culturalContext = "";

  // Extract NPC names from doc context (capitalized names near "NPC", character-like descriptions)
  if (docContext) {
    // Look for named characters (2-3 capitalized words)
    const npcPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b(?=\s*(?:is|was|guards|leads|rules|lives|dwells|haunts|serves|commands|patrols))/g;
    let m;
    while ((m = npcPattern.exec(docContext)) !== null) {
      const name = m[1].trim();
      if (name.length > 3 && name.length < 40) npcs.add(name);
    }
  }

  // Get deities from World Bible
  try {
    const bibleDeities = worldBible?.searchCategory?.("deities", location) ?? [];
    for (const d of bibleDeities.slice(0, 8)) {
      const name = d.name || d.Name || "";
      if (name) deities.add(name);
    }
  } catch { /* no bible */ }

  // Get geographic/cultural context from World Bible
  try {
    const geo = worldBible?.searchCategory?.("geography", location) ?? [];
    if (geo.length > 0) {
      const g = geo[0];
      culturalContext = g.description || g.notes || "";
    }
    if (!culturalContext) {
      const cities = worldBible?.searchCategory?.("cities", location) ?? [];
      if (cities.length > 0) {
        const c = cities[0];
        culturalContext = c.description || c.notes || c.culture || "";
      }
    }
  } catch { /* no bible */ }

  return {
    npcs: [...npcs].slice(0, 15),
    deities: [...deities].slice(0, 10),
    culturalContext: culturalContext.slice(0, 300),
  };
}

/**
 * Extract region/nation from World Bible for a location.
 * @param {Object} worldBible
 * @param {string} location
 * @returns {{ region: string, nation: string }}
 */
function _extractRegionInfo(worldBible, location) {
  let region = "";
  let nation = "";

  try {
    const cities = worldBible?.searchCategory?.("cities", location) ?? [];
    if (cities.length > 0) {
      const c = cities[0];
      region = c.region || c.province || c.area || "";
      nation = c.nation || c.kingdom || c.domain || c.country || "";
    }
    if (!region) {
      const geo = worldBible?.searchCategory?.("geography", location) ?? [];
      if (geo.length > 0) {
        region = geo[0].region || geo[0].name || "";
        nation = geo[0].nation || geo[0].domain || "";
      }
    }
    if (!nation) {
      const nations = worldBible?.searchCategory?.("nations", location) ?? [];
      if (nations.length > 0) {
        nation = nations[0].name || "";
      }
    }
  } catch { /* no bible */ }

  return { region, nation };
}

/**
 * Extract nearby/connected locations from document cross-references.
 * @param {Object} documentEngine
 * @param {string} location
 * @returns {string[]}
 */
function _extractNearbyLocations(documentEngine, location) {
  const nearby = new Set();

  try {
    const entities = documentEngine?.getLastSearchEntities?.() ?? {};
    const rooms = entities.rooms ?? [];
    const locations = entities.locations ?? [];

    for (const r of rooms.slice(0, 10)) nearby.add(r);
    for (const l of locations.slice(0, 10)) nearby.add(l);
  } catch { /* no engine */ }

  return [...nearby].slice(0, 10);
}


// ═══════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════

export class SceneIntelligence {

  /**
   * @param {Object} opts
   * @param {Object} opts.documentEngine — DocumentEngine instance
   * @param {Object} opts.worldBible — WorldBibleEngine instance
   * @param {Object} [opts.digestEngine] — DigestEngine instance (for digest factions)
   */
  constructor({ documentEngine, worldBible, digestEngine } = {}) {
    this._docEngine = documentEngine;
    this._worldBible = worldBible;
    this._digestEngine = digestEngine;
  }

  /**
   * Get scene intelligence, using cache if available.
   * @param {string} [sceneId] — Foundry scene ID (default: current scene)
   * @param {string} [sceneName] — Foundry scene name (default: current scene)
   * @returns {Promise<SceneIntelligence>}
   */
  async getIntelligence(sceneId, sceneName) {
    const sid = sceneId || canvas?.scene?.id || "";
    const sname = sceneName || canvas?.scene?.name || "";

    if (!sid && !sname) {
      console.warn(`${TAG} | No scene ID or name provided`);
      return this._emptyIntelligence(sid, sname);
    }

    // Check cache
    const cached = _cache.get(sid);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log(`${TAG} | Cache hit for "${sname}"`);
      return cached.data;
    }

    // Build fresh intelligence
    console.log(`${TAG} | Building intelligence for "${sname}"...`);
    const intel = await this._buildIntelligence(sid, sname);

    // Cache it
    _cache.set(sid, { data: intel, timestamp: Date.now() });

    return intel;
  }

  /**
   * Invalidate cache for a scene (or all scenes).
   * @param {string} [sceneId] — Specific scene, or omit to clear all
   */
  invalidate(sceneId) {
    if (sceneId) {
      _cache.delete(sceneId);
    } else {
      _cache.clear();
    }
  }

  /**
   * Build scene intelligence from scratch.
   * @private
   */
  async _buildIntelligence(sceneId, sceneName) {
    const parsed = _parseSceneName(sceneName);
    const { location, roomId, keywords } = parsed;

    // ── Step 1: Document library search (full pipeline) ──────────
    let docContext = "";
    try {
      if (this._docEngine) {
        // Use the location as the search query for maximum relevance
        const searchQuery = roomId
          ? `${location} room ${roomId}`
          : location;
        docContext = await this._docEngine.buildDocumentContext(
          "", searchQuery, sceneName, 6000, ""
        ) ?? "";
      }
    } catch (err) {
      console.warn(`${TAG} | Document search failed:`, err);
    }

    // ── Step 2: Extract factions from World Bible ──────────────
    // Regex extraction from document text was removed — it produced garbage
    // like "Ethereal Plane where distance". The World Bible has 245+ curated
    // factions with leaders, descriptions, and location cross-references.
    const bibleFactions = _extractFactionsFromBible(this._worldBible, location, keywords);

    // ── Step 2b: Extract factions from active digests ─────────
    // Digests have factions from adventure modules (e.g., Curse of Strahd
    // has Strahd's Servants, Keepers of the Feather, Vistani, etc.)
    // that may not be in the World Bible (Barovia is a demiplane).
    const digestFactions = _extractFactionsFromDigests(this._digestEngine, location, keywords);

    // ── Step 3: Merge and deduplicate ─────────────────────────
    const allFactions = [];
    const seenNames = new Set();
    // Bible first (more authoritative), then digests
    for (const f of [...bibleFactions, ...digestFactions]) {
      const key = (f.name || "").toLowerCase();
      if (!key || key.length < 3 || seenNames.has(key)) continue;
      // Partial match dedup
      let isDupe = false;
      for (const existing of seenNames) {
        if (existing.includes(key) || key.includes(existing)) { isDupe = true; break; }
      }
      if (isDupe) continue;
      seenNames.add(key);
      allFactions.push(f);
    }

    // ── Step 5: Extract additional context ───────────────────────
    const { npcs, deities, culturalContext } = _extractAdditionalContext(
      docContext, this._worldBible, location
    );

    // ── Step 6: Region/nation info ──────────────────────────────
    const { region, nation } = _extractRegionInfo(this._worldBible, location);

    // ── Step 7: Nearby locations ────────────────────────────────
    const nearbyLocations = _extractNearbyLocations(this._docEngine, location);

    // ── Step 8: Build description from doc context ──────────────
    let description = "";
    if (docContext) {
      // Take the first meaningful paragraph from results
      const lines = docContext.split("\n").filter(l => l.trim().length > 20);
      description = (lines[0] || "").replace(/^#+\s*/, "").trim().slice(0, 250);
    }

    const intel = {
      sceneId,
      sceneName,
      location,
      roomId,
      description,
      region,
      nation,
      canonicalFactions: allFactions.slice(0, 20),
      keyNPCs: npcs,
      deities,
      culturalContext,
      nearbyLocations,
      timestamp: Date.now(),
    };

    console.log(`${TAG} | Built intelligence for "${sceneName}": ` +
      `${allFactions.length} factions, ${npcs.length} NPCs, ${deities.length} deities`);

    return intel;
  }

  /**
   * Return an empty intelligence object (no data available).
   * @private
   */
  _emptyIntelligence(sceneId, sceneName) {
    return {
      sceneId,
      sceneName,
      location: sceneName || "",
      roomId: null,
      description: "",
      region: "",
      nation: "",
      canonicalFactions: [],
      keyNPCs: [],
      deities: [],
      culturalContext: "",
      nearbyLocations: [],
      timestamp: Date.now(),
    };
  }

  /**
   * Get a compact text summary of the intelligence for AI prompt injection.
   * @param {SceneIntelligence} intel
   * @returns {string}
   */
  formatForPrompt(intel) {
    if (!intel || !intel.location) return "";

    const parts = [];
    parts.push(`## SCENE INTELLIGENCE: ${intel.location}`);
    if (intel.description) parts.push(intel.description);
    if (intel.region || intel.nation) {
      parts.push(`Region: ${intel.region || "Unknown"}${intel.nation ? `, ${intel.nation}` : ""}`);
    }
    if (intel.canonicalFactions.length > 0) {
      parts.push("\nKnown factions at this location:");
      for (const f of intel.canonicalFactions.slice(0, 10)) {
        let line = `- ${f.name} (${f.type})`;
        if (f.leader) line += ` — led by ${f.leader}`;
        if (f.status !== "unknown") line += ` [${f.status}]`;
        parts.push(line);
      }
    }
    if (intel.keyNPCs.length > 0) {
      parts.push(`\nKey NPCs: ${intel.keyNPCs.join(", ")}`);
    }
    if (intel.deities.length > 0) {
      parts.push(`Local deities: ${intel.deities.join(", ")}`);
    }
    if (intel.culturalContext) {
      parts.push(`Culture: ${intel.culturalContext}`);
    }
    return parts.join("\n");
  }
}
