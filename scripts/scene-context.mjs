// ============================================================
// ACE — AI Campaign Engine — Scene Context Gatherer
// Reads live game state and serializes it for AI consumption
// System-agnostic with smart data extraction
// ============================================================

import { MODULE_ID } from "./ace-engine.mjs";

// ── Weather effect lookup (module-scope constant, created once) ────────────
const WEATHER_MAP = {
  // Foundry native
  "rain":           "Rain",         "rainweathereffect":       "Rain",
  "snow":           "Snow",         "snowweathereffect":       "Snow",
  "leaves":         "Falling leaves","leavesweathereffect":    "Falling leaves",
  "fog":            "Fog",          "fogweathereffect":        "Fog",
  // FXMaster types
  "raintop":        "Rain",         "raintopweathereffect":    "Rain",
  "snowstorm":      "Snowstorm",    "snowstormweathereffect":  "Snowstorm",
  "blizzard":       "Blizzard",     "blizzardweathereffect":   "Blizzard",
  "hail":           "Hail",         "hailweathereffect":       "Hail",
  "sandstorm":      "Sandstorm",    "sandstormweathereffect":  "Sandstorm",
  "embers":         "Embers",       "embersweathereffect":     "Embers",
  "clouds":         "Cloudy",       "cloudsweathereffect":     "Cloudy",
  "autumnleaves":   "Autumn leaves","autumnleavesweathereffect":"Autumn leaves",
  "bubbles":        "Bubbles",      "bubblesweathereffect":    "Bubbles",
  "stars":          "Starry sky",   "starsweathereffect":      "Starry sky",
  "fireflies":      "Fireflies",    "firefliesweathereffect":  "Fireflies",
  "sakurablossoms": "Cherry blossoms","sakurablossomsweathereffect":"Cherry blossoms",
  "sakurabloom":    "Cherry blossoms","sakurabloomweathereffect":"Cherry blossoms",
  "magiccrystals":  "Magical energy","magiccrystalsweathereffect":"Magical energy",
  "ghosts":         "Ghostly apparitions","ghostsweathereffect":"Ghostly apparitions",
  // FXMaster Config class names (sometimes stored with "Config" suffix)
  "snowweathereffectsconfig":       "Snow",
  "snowstormweathereffectsconfig":  "Snowstorm",
  "rainweathereffectsconfig":       "Rain",
  "raintopweathereffectsconfig":    "Rain",
  "fogweathereffectsconfig":        "Fog",
  "hailweathereffectsconfig":       "Hail",
  "sandstormweathereffectsconfig":  "Sandstorm",
  "embersweathereffectsconfig":     "Embers",
  "cloudsweathereffectsconfig":     "Cloudy",
  "autumnleavesweathereffectsconfig":"Autumn leaves",
  "batsweathereffectsconfig":       "Bats flying",
  "birdsweathereffectsconfig":      "Birds flying",
  "crowsweathereffectsconfig":      "Crows flying",
  "eaglesweathereffectsconfig":     "Eagles flying",
  "ratsweathereffectsconfig":       "Rats scurrying",
  "spidersweathereffectsconfig":    "Spiders crawling",
  "fishweathereffectsconfig":       "Fish swimming",
  "bubblesweathereffectsconfig":    "Bubbles rising",
  "starsweathereffectsconfig":      "Starry sky",
  "firefliesweathereffectsconfig":  "Fireflies",
  "sakurablossomsweathereffectsconfig":"Cherry blossoms",
  "sakurabloomweathereffectsconfig": "Cherry blossoms",
  "magiccrystalsweathereffectsconfig":"Magical energy",
  "ghostsweathereffectsconfig":     "Ghostly apparitions",
};

export class SceneContext {
  constructor() {
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = 5000;
    this._worldBible = null;
    this._digestEngine = null;
    // ── Scene Entity Pre-Load Cache (Enhancement 3) ──
    this._sceneEntityCache = new Map(); // npcName → {primary, connected, envoyContext}
    this._preloadSceneId = null;
  }

  /** @param {WorldBibleEngine} bible */
  setWorldBible(bible) { this._worldBible = bible; }

  /** @param {DigestEngine} engine */
  setDigestEngine(engine) { this._digestEngine = engine; }

  refresh() { this._cache = null; this._cacheTime = 0; this._sceneEntityCache.clear(); this._preloadSceneId = null; }
  refreshCombat() { this._cache = null; }
  refreshActor() { this._cache = null; }

  // ── Scene Entity Pre-Load (Enhancement 3) ──────────────

  /**
   * Pre-load digest entries for all NPC tokens on the current scene.
   * Called on canvasReady — provides instant context for any NPC interaction.
   */
  preloadSceneEntities() {
    try {
      const scene = canvas?.scene;
      if (!scene || !this._digestEngine?.hasLookupIndex) return;
      if (this._preloadSceneId === scene.id && this._sceneEntityCache.size > 0) return; // already loaded

      this._sceneEntityCache.clear();
      this._preloadSceneId = scene.id;

      const tokenDocs = scene.tokens?.contents ?? [];
      let loaded = 0;
      for (const td of tokenDocs) {
        const actor = td.actor;
        if (!actor || actor.hasPlayerOwner) continue; // skip PCs
        const npcName = actor.name;
        if (!npcName || this._sceneEntityCache.has(npcName)) continue;

        const result = this._digestEngine.lookupWithConnections(npcName, {
          category: "NPC", maxResults: 3, maxConnected: 3, includeEnvoy: false
        });
        if (result.primary.length > 0) {
          this._sceneEntityCache.set(npcName, result);
          loaded++;
        }
      }
      if (loaded > 0) {
        console.log(`ACE Engine | Scene pre-load: ${loaded} NPCs cached for "${scene.name}"`);
      }
    } catch (err) {
      console.warn("ACE Engine | Scene pre-load failed:", err.message);
    }
  }

  /** Get pre-loaded NPC data (instant, no lookup needed). */
  getPreloadedNPC(name) {
    return this._sceneEntityCache.get(name) ?? null;
  }

  /** Get all pre-loaded NPC names for the current scene. */
  getPreloadedNPCNames() {
    return [...this._sceneEntityCache.keys()];
  }

  gather() {
    const now = Date.now();
    if (this._cache && now - this._cacheTime < this._cacheTTL) return this._cache;

    const parts = [];
    parts.push(this._gatherSystemInfo());
    parts.push(this._gatherScene());
    parts.push(this._gatherNarrativeTime());
    parts.push(this._gatherCombat());
    parts.push(this._gatherTokens());
    // Note: _gatherTokens() already includes full PC details for scene tokens,
    // so a separate _gatherParty() call is not needed (it would duplicate data).
    parts.push(this._gatherChatLog());

    // Integrate trap data from ACE: Trapmaster if available
    parts.push(this._gatherTraps());

    this._cache = parts.filter(Boolean).join("\n\n");
    this._cacheTime = now;
    return this._cache;
  }

  gatherCompact() {
    const parts = [];
    const scene = canvas?.scene;
    if (scene) {
      parts.push(`Scene: ${scene.name}`);
      const aceDesc = scene.flags?.["ace-engine"]?.sceneDescription;
      const nativeDesc = scene.description ? this._stripHtml(scene.description) : "";
      const desc = aceDesc || nativeDesc;
      if (desc) parts.push(`Description: ${desc.slice(0, 300)}`);
    }

    const tokenDocs = (canvas?.scene?.tokens ?? []).filter(td => !td.hidden || td.actor?.hasPlayerOwner);
    if (tokenDocs.length) {
      const summary = tokenDocs.map((td) => {
        const actor = td.actor;
        let s = td.name;
        // Race/Class
        const race = actor?.system?.details?.race?.name ?? actor?.system?.details?.race ?? "";
        const cls  = actor?.system?.details?.class ?? actor?.items?.find(i => i.type === "class")?.name ?? "";
        if (race || cls) s += ` [${[race, cls].filter(Boolean).join(" ")}]`;
        const hp = actor ? this._extractHP(actor) : null;
        if (hp) s += ` (HP: ${hp.current}/${hp.max})`;
        const conditions = actor ? this._getActorConditions(actor) : [];
        if (conditions.length) s += ` {${conditions.join(", ")}}`;
        return s;
      });
      parts.push(`Tokens: ${summary.join("; ")}`);
    }

    const combat = game.combat;
    if (combat?.started) {
      parts.push(`Combat round ${combat.round}, turn: ${combat.combatant?.name ?? "?"}`);
    }

    return parts.join("\n");
  }

  // ── Private gatherers ───────────────────────────────────────

  _gatherSystemInfo() {
    const sys = game.system;
    if (!sys) return "";
    return `### Game System: ${sys.title ?? sys.id} (v${sys.version ?? "?"})`;
  }

  _gatherScene() {
    const scene = canvas?.scene;
    if (!scene) return "";

    const lines = [`### Scene: ${scene.name}`];

    // ── Smart Location Resolution ──────────────────────────────
    // When scene names are abbreviated (e.g., "BM: 2F North East"),
    // cross-reference NPC tokens + digest data to identify the actual location.
    const resolvedLocation = this._resolveSceneLocation(scene);
    if (resolvedLocation) lines.push(`**Resolved Location:** ${resolvedLocation}`);

    // Check ACE custom flag first, then Foundry native description
    const aceDesc = scene.flags?.["ace-engine"]?.sceneDescription;
    const nativeDesc = scene.description ? this._stripHtml(scene.description) : "";
    const desc = aceDesc || nativeDesc;
    if (desc) lines.push(`**Description:** ${desc}`);

    const darknessLevel = scene.environment?.darknessLevel ?? scene.environment?.darkness ?? null;
    if (darknessLevel !== null && darknessLevel !== undefined) {
      const timeOfDay = darknessLevel > 0.7 ? "Night" : darknessLevel > 0.3 ? "Dusk/Dawn" : "Day";
      lines.push(`**Lighting:** ${timeOfDay} (darkness: ${Math.round(darknessLevel * 100)}%)`);
    }

    // ── Weather detection — Foundry native + FXMaster ──
    const weatherDesc = this._detectWeather(scene);
    if (weatherDesc) lines.push(`**Weather:** ${weatherDesc}`);

    // ── World Bible auto-lookup — match scene name to known locations ──
    const bibleContext = this._lookupSceneInBible(scene.name);
    if (bibleContext) lines.push(bibleContext);

    return lines.join("\n");
  }

  /**
   * Resolve an abbreviated scene name to an actual canonical location by
   * cross-referencing NPC tokens on the scene with their known locations
   * from the digest world graph.
   *
   * Example: Scene "BM: 2F North East" has Clovin Belview (a mongrelfolk).
   * Digest says Clovin's location is "Abbey of Saint Markovia".
   * → Resolved: "Abbey of Saint Markovia (2nd floor, northeast section)"
   *
   * @param {Scene} scene
   * @returns {string} Resolved location description, or ""
   */
  _resolveSceneLocation(scene) {
    if (!this._digestEngine?.hasLookupIndex) return "";

    const sceneName = scene.name ?? "";
    // Only attempt resolution if scene name looks abbreviated
    // (contains prefix with colon, very short, or mostly abbreviations)
    const looksAbbreviated = /^[A-Z]{1,4}:/.test(sceneName) ||
                             sceneName.length < 15 ||
                             /^\S+\s*:\s*\d/.test(sceneName);
    if (!looksAbbreviated) return "";

    // ── Strategy 1: Look up NPC tokens on this scene in the digest ──
    // If an NPC has a known location in the digest, that's likely where the scene is.
    const tokenDocs = [...(scene.tokens ?? [])];
    const locationVotes = {}; // location name → count of NPCs from there

    for (const td of tokenDocs) {
      const actor = td.actor;
      if (!actor || actor.hasPlayerOwner) continue;

      const npcName = actor.name;
      if (!npcName) continue;

      const results = this._digestEngine.lookupByName(npcName, { category: "NPC", maxResults: 3 });
      for (const r of results) {
        if (r.matchType === "exact" && r.entry.location) {
          const loc = r.entry.location;
          locationVotes[loc] = (locationVotes[loc] || 0) + (r.matchType === "exact" ? 3 : 1);
        }
      }
    }

    // Pick the location with the most votes
    let bestLocation = "";
    let bestScore = 0;
    for (const [loc, score] of Object.entries(locationVotes)) {
      if (score > bestScore) {
        bestLocation = loc;
        bestScore = score;
      }
    }

    // ── Strategy 2: Parse floor/section info from scene name ──
    let floorSection = "";
    const floorMatch = sceneName.match(/(\d+)[Ff]\b/);
    if (floorMatch) {
      const floor = parseInt(floorMatch[1]);
      const ordinal = floor === 1 ? "1st" : floor === 2 ? "2nd" : floor === 3 ? "3rd" : `${floor}th`;
      floorSection = `${ordinal} floor`;
    }
    // Directional section
    const dirMatch = sceneName.match(/\b(North|South|East|West|NE|NW|SE|SW|North\s*East|North\s*West|South\s*East|South\s*West|Central|Main)\b/i);
    if (dirMatch) {
      const dir = dirMatch[1].toLowerCase().replace(/\s+/g, "");
      const dirNames = { north: "north", south: "south", east: "east", west: "west",
        ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
        northeast: "northeast", northwest: "northwest", southeast: "southeast", southwest: "southwest",
        central: "central", main: "main" };
      const dirName = dirNames[dir] ?? dirMatch[1];
      floorSection = floorSection ? `${floorSection}, ${dirName} section` : `${dirName} section`;
    }

    // ── Strategy 3: Try matching scene prefix against digest locations directly ──
    if (!bestLocation) {
      // Extract the prefix before the colon (e.g., "BM" from "BM: 2F North East")
      const prefixMatch = sceneName.match(/^([A-Z]{1,4}):/);
      if (prefixMatch) {
        const prefix = prefixMatch[1];
        // Search digest locations whose name contains words starting with these letters
        // E.g., "BM" could match "Bonegrinder Mill" or "Barovia Manor"
        // We let the NPC-based resolution take priority — this is a weaker fallback
        const locResults = this._digestEngine.lookupByName(prefix, { category: "Location", maxResults: 5 });
        // Only use if there's exactly one strong match (otherwise too ambiguous)
        if (locResults.length === 1 && locResults[0].matchType === "exact") {
          bestLocation = locResults[0].entry.name;
        }
      }
    }

    if (!bestLocation) return "";

    // Build the final resolved string
    if (floorSection) {
      return `This scene is most likely **${bestLocation}** (${floorSection}). ` +
             `Location identified by cross-referencing NPC tokens with adventure source material.`;
    }
    return `This scene is most likely **${bestLocation}**. ` +
           `Location identified by cross-referencing NPC tokens with adventure source material.`;
  }

  /**
   * Search the World Bible for the current scene name and return matching
   * location data. Tries the full name first, then strips common prefixes
   * like "BM:" or "Chapter 4 -" to find the core location name.
   * @param {string} sceneName
   * @returns {string} Formatted Bible context or ""
   */
  _lookupSceneInBible(sceneName) {
    if (!this._worldBible?.hasData || !sceneName) return "";

    // Try full scene name first
    let result = this._worldBible.search(sceneName, 3);
    if (result) return `**Location (World Bible):**\n${result}`;

    // Strip common scene naming prefixes: "BM: Entry - Amber Temple" → "Amber Temple"
    // Patterns: "XX:", "XX: Name -", "Chapter N -", "Area N -", "Room N -"
    const stripped = sceneName
      .replace(/^[A-Z]{1,4}:\s*/i, "")           // "BM: " prefix
      .replace(/^(?:chapter|area|room|level)\s*\d+\s*[-–:]\s*/i, "")  // "Chapter 4 - "
      .replace(/^[^-–]+[-–]\s*/, "")              // "Entry - " prefix (anything before first dash)
      .trim();

    if (stripped && stripped !== sceneName) {
      result = this._worldBible.search(stripped, 3);
      if (result) return `**Location (World Bible):**\n${result}`;
    }

    // Last try: split on common separators and search each part
    const parts = sceneName.split(/[-–:,]/);
    for (const part of parts) {
      const clean = part.trim();
      if (clean.length < 4) continue; // skip short fragments like "BM"
      result = this._worldBible.search(clean, 2);
      if (result) return `**Location (World Bible):**\n${result}`;
    }

    return "";
  }

  /**
   * Detect active weather effects from multiple sources:
   *  1. Foundry native scene.weather (class name key)
   *  2. FXMaster flags (scene.flags.fxmaster.effects)
   *  3. Simple Weather flags
   * Translates technical identifiers into natural-language descriptions.
   */
  _detectWeather(scene) {
    const effects = [];

    // ── Source 1: Foundry native weather ──
    const nativeWeather = scene.weather ?? "";
    if (nativeWeather) {
      const readable = this._weatherKeyToLabel(nativeWeather);
      if (readable) effects.push(readable);
    }

    // ── Source 2: FXMaster module flags ──
    const fxEffects = scene.flags?.fxmaster?.effects;
    if (fxEffects && typeof fxEffects === "object") {
      // FXMaster stores effects as an object: { "effectId": { type: "...", options: {...} }, ... }
      const fxEntries = Array.isArray(fxEffects) ? fxEffects : Object.values(fxEffects);
      for (const fx of fxEntries) {
        if (!fx || typeof fx !== "object") continue;
        const fxType = fx.type ?? fx.id ?? "";
        const readable = this._weatherKeyToLabel(fxType);
        if (readable && !effects.includes(readable)) effects.push(readable);

        // Also check for density/intensity if available
        if (fx.options?.density && fx.options.density > 0.5) {
          const idx = effects.indexOf(readable);
          if (idx >= 0) effects[idx] = `Heavy ${readable.toLowerCase()}`;
        }
      }
    }

    // ── Source 3: Simple Weather module ──
    const simpleWeather = scene.flags?.["simple-weather"]?.weather
                       ?? scene.flags?.["simple-weather"]?.current;
    if (simpleWeather && typeof simpleWeather === "string") {
      const readable = this._weatherKeyToLabel(simpleWeather) || simpleWeather;
      if (!effects.includes(readable)) effects.push(readable);
    }

    return effects.length ? effects.join(", ") : "";
  }

  /**
   * Convert a weather effect class name / key into a human-readable label.
   * Handles Foundry native names, FXMaster class names, and plain strings.
   */
  _weatherKeyToLabel(key) {
    if (!key || typeof key !== "string") return "";

    // Normalize: strip module prefix (e.g. "fxmaster.Snow..." → "Snow..."),
    // remove dots/hyphens, lowercase for lookup
    let normalized = key.replace(/^fxmaster\./i, "")
                        .replace(/[.\-_]/g, "")
                        .toLowerCase();
    if (WEATHER_MAP[normalized]) return WEATHER_MAP[normalized];

    // Fallback: try to extract a readable word from the class name
    // e.g. "SnowWeatherEffect" → "Snow", "HeavyRainEffect" → "HeavyRain"
    const match = key.match(/^(?:fxmaster\.)?([A-Za-z]+?)(?:Weather)?(?:Effects?)?(?:Config)?$/i);
    if (match?.[1]) {
      // Convert camelCase to spaced: "HeavyRain" → "Heavy Rain"
      const spaced = match[1].replace(/([a-z])([A-Z])/g, "$1 $2");
      return spaced.charAt(0).toUpperCase() + spaced.slice(1);
    }

    // Last resort: return cleaned-up original if it looks like a word
    if (key.length < 30 && /^[a-zA-Z]+$/.test(key)) return key;
    return "";
  }

  _gatherNarrativeTime() {
    try {
      if (!game.settings.get(MODULE_ID, "enableNarrativeTime")) return "";
      const aceApi = game.modules.get(MODULE_ID)?.api;
      if (!aceApi) return "";

      // If Simple Calendar bridge is active, prefer its rich date strings
      const scBridge = aceApi.getCalendarBridge?.();
      if (scBridge) {
        const scDisplay = scBridge.getFormattedDateTime();
        if (scDisplay) {
          const time = aceApi.getTimeOfDay?.() ?? "unknown";
          return `### In-Game Time: ${scDisplay} (${time})`;
        }
      }

      // Fallback: ACE's own day counter
      const day  = aceApi.getDayCounter?.() ?? null;
      const time = aceApi.getTimeOfDay?.() ?? null;
      if (day === null) return "";

      return `### In-Game Time: Day ${day}, ${time ?? "unknown"} (approximate)`;
    } catch (_) {
      return "";
    }
  }

  _gatherCombat() {
    const combat = game.combat;
    if (!combat?.started) return "";

    const lines = [`### Combat — Round ${combat.round}`];

    if (combat.combatant) {
      lines.push(`**Current turn:** ${combat.combatant.name} (Initiative: ${combat.combatant.initiative ?? "?"})`);
    }

    const order = combat.turns.map((c, i) => {
      const marker = c.id === combat.combatant?.id ? "\u25ba" : " ";
      const defeated = c.isDefeated ? " [DEFEATED]" : "";
      return `${marker} ${i + 1}. ${c.name} (Init: ${c.initiative ?? "?"})${defeated}`;
    });
    lines.push(`**Initiative Order:**\n${order.join("\n")}`);

    return lines.join("\n");
  }

  _gatherTokens() {
    const tokenDocs = [...(canvas?.scene?.tokens ?? [])];
    if (!tokenDocs.length) return "";

    const lines = ["### Tokens on Scene"];
    const pcTokens = tokenDocs.filter(td => td.actor?.hasPlayerOwner);
    // Filter out GM-hidden tokens so the AI doesn't reveal secret enemies or ambushes
    const npcTokens = tokenDocs.filter(td => !td.actor?.hasPlayerOwner && !td.hidden);

    if (pcTokens.length) {
      lines.push("**Player Characters:**");
      for (const td of pcTokens) {
        if (td.actor) lines.push(this._buildDetailedActorBlock(td.actor, true));
      }
    } else {
      // No PCs on current scene — scan ALL scenes to find where they are
      const pcLocations = this._findPCsAcrossScenes();
      if (pcLocations.length) {
        lines.push("**Player Characters (not on current scene):**");
        lines.push("The party's tokens were found on other scenes:");
        for (const pc of pcLocations) {
          const sceneList = pc.scenes.join(", ");
          let entry = `- **${pc.name}**`;
          if (pc.level !== null) entry += ` — Level ${pc.level}`;
          if (pc.classInfo) entry += ` ${pc.classInfo}`;
          entry += ` — found on: ${sceneList}`;
          lines.push(entry);
        }
        // Determine likely party location (scene with most PC tokens)
        const sceneCounts = {};
        for (const pc of pcLocations) {
          for (const s of pc.scenes) {
            sceneCounts[s] = (sceneCounts[s] || 0) + 1;
          }
        }
        const sorted = Object.entries(sceneCounts).sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0) {
          lines.push(`**Likely party location:** "${sorted[0][0]}" (${sorted[0][1]} PC token(s))`);
        }
      } else {
        lines.push("**Player Characters:** None found on any scene.");
      }
    }
    if (npcTokens.length) {
      lines.push("**NPCs & Creatures:**");
      for (const td of npcTokens) {
        if (td.actor) {
          lines.push(this._buildDetailedActorBlock(td.actor, false));
        } else {
          lines.push(`- **${td.name}** (no actor data)`);
        }
      }
    }

    return lines.join("\n");
  }

  /**
   * Scan all scenes in the world to find PC tokens when none are on the current scene.
   * Returns an array of { name, level, classInfo, scenes[] } for each unique PC actor.
   */
  _findPCsAcrossScenes() {
    const currentSceneId = canvas?.scene?.id;
    const pcMap = new Map(); // actorId → { name, level, classInfo, scenes[] }

    for (const scene of game.scenes ?? []) {
      if (scene.id === currentSceneId) continue; // already checked current scene
      for (const td of scene.tokens ?? []) {
        const actor = td.actor ?? game.actors?.get(td.actorId);
        if (!actor?.hasPlayerOwner) continue;

        const key = actor.id;
        if (!pcMap.has(key)) {
          pcMap.set(key, {
            name: actor.name,
            level: this._extractLevel(actor),
            classInfo: this._extractClass(actor),
            scenes: [],
          });
        }
        const entry = pcMap.get(key);
        if (!entry.scenes.includes(scene.name)) {
          entry.scenes.push(scene.name);
        }
      }
    }

    return [...pcMap.values()];
  }

  /**
   * Build a detailed text block for an actor — includes spells, features,
   * equipment, saves, resistances, and all relevant game state.
   * @param {Actor} actor
   * @param {boolean} isPC
   * @returns {string}
   */
  _buildDetailedActorBlock(actor, isPC = false) {
    const lines = [];
    const hp = this._extractHP(actor);
    const classInfo = this._extractClass(actor);
    const level = this._extractLevel(actor);

    // Tag dead/defeated NPCs so AI doesn't suggest interacting with them
    const isDead = hp && hp.current <= 0 && !isPC;
    let header = `- **${actor.name}**`;
    if (isDead) header += ` [DEAD]`;
    if (level !== null) header += ` \u2014 Level ${level}`;
    if (classInfo) header += ` ${classInfo}`;
    lines.push(header);

    // HP + AC
    if (hp) {
      const pct = hp.max > 0 ? Math.round((hp.current / hp.max) * 100) : 0;
      let hpLine = `  HP: ${hp.current}/${hp.max} (${pct}%)`;
      if (hp.temp) hpLine += ` +${hp.temp} temp`;
      const ac = this._extractAC(actor);
      if (ac) hpLine += ` | AC: ${ac}`;
      lines.push(hpLine);
    }

    // Spell slots remaining
    const slots = this._extractSpellSlots(actor);
    if (slots) lines.push(`  Spell Slots: ${slots}`);

    // Prepared / known spells
    const spells = this._extractSpells(actor);
    if (spells) lines.push(spells);

    // Key features and abilities
    const features = this._extractFeatures(actor);
    if (features) lines.push(features);

    // Equipment (weapons + armor)
    const equipment = this._extractEquipment(actor);
    if (equipment) lines.push(equipment);

    // Resources (Ki, Sorcery Points, Channel Divinity, etc.)
    const resources = this._extractResources(actor);
    if (resources) lines.push(`  Resources: ${resources}`);

    // Saving throw proficiencies
    const saves = this._extractSaves(actor);
    if (saves) lines.push(`  Save Prof: ${saves}`);

    // Resistances, immunities, vulnerabilities
    const defenses = this._extractDefenses(actor);
    if (defenses) lines.push(defenses);

    // Senses (darkvision, etc.)
    const senses = this._extractSenses(actor);
    if (senses) lines.push(`  Senses: ${senses}`);

    // Active conditions
    const conditions = this._getActorConditions(actor);
    if (conditions.length) lines.push(`  Conditions: ${conditions.join(", ")}`);

    // Backstory & character details (dnd5e sheet fields)
    const details = actor?.system?.details;
    if (details) {
      const alignment = details.alignment;
      if (alignment) lines.push(`  Alignment: ${alignment}`);

      const appearance = (details.appearance || "").trim();
      if (appearance) lines.push(`  Appearance: ${appearance}`);

      const trait = (details.trait || "").trim();
      if (trait) lines.push(`  Personality: ${trait}`);

      const ideal = (details.ideal || "").trim();
      if (ideal) lines.push(`  Ideals: ${ideal}`);

      const bond = (details.bond || "").trim();
      if (bond) lines.push(`  Bonds: ${bond}`);

      const flaw = (details.flaw || "").trim();
      if (flaw) lines.push(`  Flaws: ${flaw}`);

      const bio = this._stripHtml(details.biography?.value || "").trim();
      if (bio) {
        // Truncate to keep context size manageable (~300 chars per actor)
        const brief = bio.length > 300 ? bio.slice(0, 300) + "…" : bio;
        lines.push(`  Backstory: ${brief}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Gather recent Foundry chat messages so the AI can reference rolls,
   * dialogue, and game events that happened in-session.
   * Skips whispers and blind rolls (GM-only info).
   */
  _gatherChatLog() {
    const messages = game.messages?.contents ?? [];
    if (!messages.length) return "";

    // Grab the last 20 messages — enough context without overwhelming the prompt
    const recent = messages.slice(-20);
    const lines = ["### Recent Chat Log"];

    for (const msg of recent) {
      // Skip whispers (private GM messages) and blind rolls
      if ((msg.whisper?.length ?? 0) > 0 && !msg.isContentVisible) continue;
      if (msg.blind) continue;

      const speaker = msg.speaker?.alias || msg.author?.name || "Unknown";
      const content = this._stripHtml(msg.content || "").trim();

      // ── Roll messages — show formula + result + flavor ──
      if (msg.rolls?.length) {
        const rollSummaries = [];
        for (const r of msg.rolls) {
          try {
            const roll = r instanceof Roll ? r : Roll.fromData(r);
            rollSummaries.push(`${roll.formula} = **${roll.total}**`);
          } catch (err) { console.debug("ace-engine | SceneContext skip unparseable roll:", err); }
        }
        if (rollSummaries.length) {
          const flavor = msg.flavor ? this._stripHtml(msg.flavor).trim() : "";
          const label = flavor || "Roll";
          lines.push(`- **${speaker}** ${label}: ${rollSummaries.join(", ")}`);
          continue;
        }
      }

      // ── Regular chat messages ──
      if (content) {
        // Truncate very long messages to keep context manageable
        const brief = content.length > 250 ? content.slice(0, 250) + "…" : content;
        lines.push(`- **${speaker}:** ${brief}`);
      }
    }

    return lines.length > 1 ? lines.join("\n") : "";
  }

  _gatherTraps() {
    // FIXED 2026-06-25: was pointing at the renamed/ghost module "ace-trapmaster"
    // and a non-existent .api.getTraps(sceneId) — so it silently gathered nothing.
    // ace-artificer (the renamed module) places traps as Tiles flagged `isTrap`
    // (linked to a MeasuredTemplate), and exposes trap DEFINITIONS on
    // game.aceForge.trapEngine.getTraps(). We scan the live scene for placed-trap
    // tiles and enrich each from its definition. Fully defensive — any gap → "".
    try {
      const scene = canvas?.scene;
      if (!scene) return "";
      const MOD = "ace-artificer";

      const defs = game.aceForge?.trapEngine?.getTraps?.() ?? [];
      const defById = new Map(defs.filter(d => d?.id).map(d => [d.id, d]));

      const seen = new Set();
      const lines = [];
      for (const tile of (scene.tiles ?? [])) {
        const f = tile?.flags?.[MOD];
        if (!f?.isTrap) continue;
        const tid = f.trapId;
        if (tid && seen.has(tid)) continue;   // dedupe dual-tile / sibling traps
        if (tid) seen.add(tid);
        const def  = tid ? defById.get(tid) : null;
        const name = f.trapName ?? def?.name ?? "Trap";
        const desc = def?.description ?? f.description ?? "A concealed trap.";
        lines.push(`- **${name}**: ${desc}`);
      }
      if (!lines.length) return "";
      return ["### Traps on Scene", ...lines].join("\n");
    } catch (err) {
      console.debug("ace-engine | SceneContext trap gathering failed:", err);
      return "";
    }
  }

  // ── System-agnostic data extractors ───────────────────────

  _extractHP(actor) {
    const sys = actor?.system;
    if (!sys) return null;
    if (sys.attributes?.hp) {
      const hp = sys.attributes.hp;
      return { current: hp.value ?? 0, max: hp.max ?? 0, temp: hp.temp ?? 0 };
    }
    if (sys.wounds !== undefined) {
      return { current: (sys.wounds.max ?? 3) - (sys.wounds.value ?? 0), max: sys.wounds.max ?? 3, temp: 0 };
    }
    if (sys.attribs?.hp) {
      const hp = sys.attribs.hp;
      return { current: hp.value ?? 0, max: hp.max ?? 0, temp: 0 };
    }
    if (sys.status?.wounds) {
      const w = sys.status.wounds;
      return { current: w.value ?? 0, max: w.max ?? 0, temp: 0 };
    }
    // sys.hp can be a plain number (some systems) or an object { value, max }
    if (sys.hp != null) {
      if (typeof sys.hp === "number") return { current: sys.hp, max: sys.hp, temp: 0 };
      return { current: sys.hp.value ?? 0, max: sys.hp.max ?? 0, temp: 0 };
    }
    if (sys.health) return { current: sys.health.value ?? 0, max: sys.health.max ?? 0, temp: 0 };
    return null;
  }

  _extractAC(actor) {
    const sys = actor?.system;
    if (!sys) return null;
    if (sys.attributes?.ac?.value !== undefined) return sys.attributes.ac.value;
    if (sys.attributes?.ac?.total !== undefined) return sys.attributes.ac.total;
    if (sys.attributes?.ac?.base !== undefined) return sys.attributes.ac.base;
    if (sys.stats?.parry !== undefined) return `Parry ${sys.stats.parry.value ?? sys.stats.parry}`;
    return null;
  }

  _extractClass(actor) {
    const classItems = actor?.items?.filter((i) => i.type === "class") ?? [];
    if (classItems.length) {
      return classItems.map((c) => `${c.name} ${c.system?.levels ?? c.system?.level ?? ""}`).join("/");
    }
    const pf2eClass = actor?.items?.find((i) => i.type === "class");
    if (pf2eClass) return pf2eClass.name;
    const sys = actor?.system;
    // Race on PCs in dnd5e 5.x is an embedded Item document; extract .name.
    // Older shapes stored a plain string or {value:""}. Always return a
    // string here — callers do toLowerCase / interpolation on the result.
    const raceField = sys?.details?.race;
    if (typeof raceField === "string") return raceField;
    if (typeof raceField?.name === "string") return raceField.name;
    if (typeof raceField?.value === "string") return raceField.value;
    return sys?.details?.ancestry?.name ?? "";
  }

  _extractLevel(actor) {
    const sys = actor?.system;
    if (!sys) return null;
    // FIX: PF2e stores level as {value: N} — check .value first
    if (sys.details?.level?.value !== undefined) return sys.details.level.value;
    if (typeof sys.details?.level === "number") return sys.details.level;
    if (sys.details?.cr !== undefined) return `CR ${sys.details.cr}`;
    return null;
  }

  _extractSpellSlots(actor) {
    const spells = actor?.system?.spells;
    if (!spells) return "";
    const slots = [];
    for (let i = 1; i <= 9; i++) {
      const slot = spells[`spell${i}`];
      if (slot?.max > 0) slots.push(`L${i}: ${slot.value}/${slot.max}`);
    }
    // Pact magic slots
    const pact = spells?.pact;
    if (pact?.max > 0) slots.push(`Pact(L${pact.level ?? "?"}): ${pact.value}/${pact.max}`);
    return slots.length ? slots.join(", ") : "";
  }

  /**
   * Extract prepared/known spells grouped by level.
   * Works with dnd5e (items of type "spell"), PF2e, and generic systems.
   * @returns {string}
   */
  _extractSpells(actor) {
    const spellItems = actor?.items?.filter(i => i.type === "spell") ?? [];
    if (!spellItems.length) return "";

    // Group by spell level
    const byLevel = {};
    for (const spell of spellItems) {
      const level = spell.system?.level ?? spell.system?.spellLevel ?? 0;
      // dnd5e 5.1+ uses .method / .prepared; older uses .preparation.mode / .preparation.prepared
      const mode = spell.system?.method ?? spell.system?.preparation?.mode ?? "always";
      const isPrepared = spell.system?.prepared ?? spell.system?.preparation?.prepared ?? true;

      // For prepared casters, skip spells that aren't prepared (except cantrips & always-prepared)
      if (mode === "prepared" && !isPrepared && level > 0) continue;

      // Skip spells without uses remaining if they're limited
      const uses = spell.system?.uses;
      if (uses?.max > 0 && (uses.value ?? 0) <= 0 && mode !== "prepared") continue;

      const label = level === 0 ? "Cantrips" : `Level ${level}`;
      if (!byLevel[label]) byLevel[label] = [];

      let name = spell.name;
      // Add ritual/concentration tags
      const components = spell.system?.components ?? spell.system?.properties ?? {};
      const tags = [];
      if (components.ritual || spell.system?.ritual)             tags.push("R");
      if (components.concentration || spell.system?.concentration) tags.push("C");
      if (tags.length) name += ` [${tags.join(",")}]`;

      // Add remaining uses for limited spells
      if (uses?.max > 0) name += ` (${uses.value}/${uses.max})`;

      byLevel[label].push(name);
    }

    if (!Object.keys(byLevel).length) return "";

    const lines = ["  Spells:"];
    // Sort: Cantrips first, then by level
    const sortedKeys = Object.keys(byLevel).sort((a, b) => {
      if (a === "Cantrips") return -1;
      if (b === "Cantrips") return 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
    for (const key of sortedKeys) {
      lines.push(`    ${key}: ${byLevel[key].join(", ")}`);
    }
    return lines.join("\n");
  }

  /**
   * Extract key features and class abilities (feats, class features, racial traits).
   * @returns {string}
   */
  _extractFeatures(actor) {
    const featureItems = actor?.items?.filter(i =>
      i.type === "feat" || i.type === "feature" || i.type === "classfeature" || i.type === "ancestryfeature"
    ) ?? [];
    if (!featureItems.length) return "";

    // Prioritize features with limited uses (they're tactical choices)
    const withUses = [];
    const passive = [];

    for (const feat of featureItems) {
      const uses = feat.system?.uses;
      if (uses?.max > 0) {
        withUses.push(`${feat.name} (${uses.value}/${uses.max})`);
      } else {
        passive.push(feat.name);
      }
    }

    const lines = [];
    if (withUses.length) {
      lines.push(`  Abilities: ${withUses.join(", ")}`);
    }
    if (passive.length) {
      // Cap passive features to avoid overwhelming the context
      const shown = passive.slice(0, 15);
      lines.push(`  Features: ${shown.join(", ")}${passive.length > 15 ? ` (+${passive.length - 15} more)` : ""}`);
    }
    return lines.join("\n");
  }

  /**
   * Extract equipped weapons and armor.
   * @returns {string}
   */
  _extractEquipment(actor) {
    const equipItems = actor?.items?.filter(i =>
      (i.type === "weapon" || i.type === "equipment" || i.type === "armor") &&
      (i.system?.equipped === true || i.system?.equipped?.value === true ||
       i.system?.attunement === "attuned" || i.system?.attuned === true)
    ) ?? [];
    if (!equipItems.length) return "";

    const weapons = [];
    const armor = [];

    for (const item of equipItems) {
      const name = item.name;
      if (item.type === "weapon") {
        // Extract damage info
        const dmg = item.system?.damage;
        const dmgParts = dmg?.parts ?? dmg?.base ?? [];
        let dmgStr = "";
        if (Array.isArray(dmgParts) && dmgParts.length) {
          dmgStr = ` (${dmgParts.map(p => Array.isArray(p) ? p[0] : p.formula ?? "").filter(Boolean).join(", ")})`;
        } else if (dmg?.base?.formula) {
          dmgStr = ` (${dmg.base.formula})`;
        }
        weapons.push(`${name}${dmgStr}`);
      } else {
        const acBonus = item.system?.armor?.value ?? item.system?.ac ?? "";
        armor.push(acBonus ? `${name} (AC ${acBonus})` : name);
      }
    }

    const parts = [];
    if (weapons.length) parts.push(`Weapons: ${weapons.join(", ")}`);
    if (armor.length) parts.push(`Armor: ${armor.join(", ")}`);
    return parts.length ? `  ${parts.join(" | ")}` : "";
  }

  /**
   * Extract saving throw proficiencies.
   * @returns {string}
   */
  _extractSaves(actor) {
    const abilities = actor?.system?.abilities;
    if (!abilities) return "";

    const proficient = [];
    const abilityNames = { str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha" };

    for (const [key, data] of Object.entries(abilities)) {
      const prof = data?.proficient ?? data?.save?.proficient ?? 0;
      if (prof >= 1) {
        const label = abilityNames[key] ?? key.toUpperCase();
        const mod = data?.save?.mod ?? data?.mod ?? 0;
        proficient.push(`${label} (${mod >= 0 ? "+" : ""}${mod})`);
      }
    }
    return proficient.length ? proficient.join(", ") : "";
  }

  /**
   * Extract damage resistances, immunities, and vulnerabilities.
   * @returns {string}
   */
  _extractDefenses(actor) {
    const traits = actor?.system?.traits ?? {};
    const lines = [];

    // dnd5e format
    const dr = this._traitToList(traits.dr ?? traits.dr?.value);
    const di = this._traitToList(traits.di ?? traits.di?.value);
    const dv = this._traitToList(traits.dv ?? traits.dv?.value);
    const ci = this._traitToList(traits.ci ?? traits.ci?.value);

    if (dr.length) lines.push(`Resist: ${dr.join(", ")}`);
    if (di.length) lines.push(`Immune: ${di.join(", ")}`);
    if (dv.length) lines.push(`Vuln: ${dv.join(", ")}`);
    if (ci.length) lines.push(`Cond.Immune: ${ci.join(", ")}`);

    return lines.length ? `  ${lines.join(" | ")}` : "";
  }

  /** Helper: convert a dnd5e trait object or Set/Array into a flat string array. */
  _traitToList(trait) {
    if (!trait) return [];
    // dnd5e v4: trait is {value: Set/Array, custom: ""}
    if (trait.value) {
      const vals = trait.value instanceof Set ? [...trait.value] : Array.isArray(trait.value) ? trait.value : [];
      const custom = trait.custom ? trait.custom.split(";").map(s => s.trim()).filter(Boolean) : [];
      return [...vals, ...custom];
    }
    // Already an array
    if (Array.isArray(trait)) return trait.filter(Boolean);
    return [];
  }

  /**
   * Extract senses (darkvision, blindsight, etc.).
   * @returns {string}
   */
  _extractSenses(actor) {
    const rawSenses = actor?.system?.attributes?.senses ?? actor?.system?.traits?.senses ?? {};
    if (!rawSenses || typeof rawSenses !== "object") return "";

    // D&D 5e 5.3.0 moved senses into .ranges sub-object; 5.2.x keeps them flat
    const senses = rawSenses.ranges ?? rawSenses;

    const parts = [];
    for (const [key, val] of Object.entries(senses)) {
      if (key === "units" || key === "special" || key === "ranges" || !val) continue;
      if (typeof val === "number" && val > 0) {
        parts.push(`${key} ${val}ft`);
      } else if (typeof val === "string" && val) {
        parts.push(`${key}: ${val}`);
      }
    }
    // Special senses string — check both old and new paths
    const special = rawSenses.special ?? senses.special;
    if (special) parts.push(special);
    return parts.length ? parts.join(", ") : "";
  }

  _extractResources(actor) {
    const res = actor?.system?.resources;
    if (!res) return "";
    const parts = [];
    for (const key of ["primary", "secondary", "tertiary"]) {
      const r = res[key];
      if (r?.max > 0) parts.push(`${r.label || key}: ${r.value}/${r.max}`);
    }
    return parts.join(", ");
  }

  _getActorConditions(actor) {
    const effects = actor?.effects?.filter((e) => !e.disabled) ?? [];
    return effects.map((e) => e.name ?? e.label ?? "Unknown Effect");
  }

  _stripHtml(html) {
    if (!html) return "";
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent?.trim() ?? "";
  }
}
