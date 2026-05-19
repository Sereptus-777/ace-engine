// ============================================================
// ACE — AI Campaign Engine — Party Reputation Engine
// Tracks what the party has done and makes that knowledge
// available to NPCs based on faction and notoriety level.
// ============================================================

const MODULE_ID = "ace-engine";
const REPUTATION_DIR  = (worldId) => `worlds/${worldId}/ace-engine`;
const REPUTATION_FILE = "ace-party-reputation.json";

// ── v13-safe FilePicker access ─────────────────────────────────
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ??
  globalThis.FilePicker;

/** Silent upload — suppresses Foundry notification toast. */
let _silentDepth = 0;
let _origNotifyInfo = null;
async function _silentUpload(source, dir, file) {
  try {
    if (ui.notifications) {
      if (_silentDepth === 0) _origNotifyInfo = ui.notifications.info;
      _silentDepth++;
      ui.notifications.info = () => {};
    }
    return await _FP().upload(source, dir, file, { notify: false });
  } finally {
    if (ui.notifications && _silentDepth > 0) {
      _silentDepth--;
      if (_silentDepth === 0 && _origNotifyInfo) {
        ui.notifications.info = _origNotifyInfo;
        _origNotifyInfo = null;
      }
    }
  }
}

// ── Constants ──────────────────────────────────────────────────
const NOTORIETY_LEVELS = ["unknown", "local", "regional", "continental", "legendary"];
const STANDING_VALUES  = ["revered", "friendly", "neutral", "suspicious", "hostile", "hated"];
const IMPACT_LEVELS    = ["local", "regional", "continental", "legendary"];

/** Build an empty reputation data structure. */
function _emptyData(worldId) {
  return {
    meta: {
      worldId,
      savedAt: new Date().toISOString(),
      version: 1,
    },
    notoriety:       "unknown",
    deeds:           [],
    factionStanding: {},
    titles:          [],
    knownInRegions:  [],
  };
}

// ── ReputationEngine ───────────────────────────────────────────
export class ReputationEngine {
  constructor() {
    this._data        = null;
    this._loaded      = false;
    this._dirty       = false;
    this._deedCounter = 0;
  }

  // ── Persistence ─────────────────────────────────────────────

  /**
   * Load reputation data from disk for the given world.
   * Creates an empty structure if the file does not exist.
   * @param {string} worldId
   */
  async load(worldId) {
    const dir  = REPUTATION_DIR(worldId);
    const path = `${dir}/${REPUTATION_FILE}`;
    try {
      // Existence-check via FilePicker before fetching, so first-time worlds
      // don't print a console 404 (the file is created on first save).
      const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
      let exists = false;
      try {
        const listing = await FP.browse("data", dir);
        exists = (listing?.files ?? []).some(f => f.endsWith(REPUTATION_FILE));
      } catch (_) { /* dir doesn't exist yet */ }
      if (!exists) throw new Error("HTTP 404");
      const response = await fetch(`/${path}?_=${Date.now()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      this._data = json;

      // Re-hydrate deed counter from the highest existing deed ID number
      this._deedCounter = 0;
      for (const deed of (this._data.deeds ?? [])) {
        const match = String(deed.id ?? "").match(/deed_(\d+)/);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n > this._deedCounter) this._deedCounter = n;
        }
      }

      // Ensure all required arrays/objects exist (handles older saves)
      this._data.deeds           ??= [];
      this._data.factionStanding ??= {};
      this._data.titles          ??= [];
      this._data.knownInRegions  ??= [];

      this._loaded = true;
      this._dirty  = false;
      console.debug(`${MODULE_ID} | Reputation: loaded from ${path} (${this._data.deeds.length} deeds, notoriety: ${this._data.notoriety})`);
    } catch (err) {
      const msg = String(err.message ?? err);
      if (!msg.includes("404") && !msg.includes("HTTP 404")) {
        console.warn(`${MODULE_ID} | Reputation: could not load (${msg}) — starting fresh`);
      } else {
        console.log(`${MODULE_ID} | Reputation: no existing file found — starting fresh`);
      }
      this._data        = _emptyData(worldId);
      this._deedCounter = 0;
      this._loaded      = true;
      this._dirty       = false;
    }
  }

  /**
   * Save reputation data to disk.
   * No-ops if not dirty or the current user is not the GM.
   * @param {string} worldId
   */
  async save(worldId) {
    if (!this._dirty)       return;
    if (!game.user?.isGM)   return;
    if (!this._data)        return;

    this._data.meta.savedAt = new Date().toISOString();

    const dir  = REPUTATION_DIR(worldId);
    const json = JSON.stringify(this._data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const file = new File([blob], REPUTATION_FILE, { type: "application/json" });

    try {
      // Ensure directory exists — ignore error if it already does
      try {
        await _FP().createDirectory("data", dir, { notify: false });
      } catch (_) { /* directory already exists */ }

      await _silentUpload("data", dir, file);
      this._dirty = false;
      console.log(`${MODULE_ID} | Reputation: saved to ${dir}/${REPUTATION_FILE}`);
    } catch (err) {
      console.error(`${MODULE_ID} | Reputation: save failed —`, err);
      throw err;
    }
  }

  // ── Getters ──────────────────────────────────────────────────

  /** Full reputation data object. */
  get data() {
    return this._data;
  }

  /** Current notoriety level string. */
  get notoriety() {
    return this._data?.notoriety ?? "unknown";
  }

  /** Array of deed objects. */
  get deeds() {
    return this._data?.deeds ?? [];
  }

  /** Array of title strings. */
  get titles() {
    return this._data?.titles ?? [];
  }

  // ── Faction Standing ─────────────────────────────────────────

  /**
   * Return the party's standing with a given faction.
   * Defaults to "neutral" if the faction is not tracked.
   * @param {string} factionId
   * @returns {string}
   */
  getFactionStanding(factionId) {
    if (!factionId || !this._data) return "neutral";
    return this._data.factionStanding[factionId] ?? "neutral";
  }

  /**
   * Update the party's standing with a faction and save.
   * @param {string} factionId
   * @param {string} standing  — one of STANDING_VALUES
   * @param {string} worldId
   */
  async setFactionStanding(factionId, standing, worldId) {
    if (!factionId) return;
    if (!STANDING_VALUES.includes(standing)) {
      console.warn(`${MODULE_ID} | Reputation: unknown standing "${standing}", defaulting to "neutral"`);
      standing = "neutral";
    }
    if (!this._data) return;
    this._data.factionStanding[factionId] = standing;
    this._dirty = true;
    console.log(`${MODULE_ID} | Reputation: faction "${factionId}" standing → ${standing}`);
    await this.save(worldId);
  }

  // ── Notoriety ────────────────────────────────────────────────

  /**
   * Manually override the notoriety level and save.
   * @param {string} level  — one of NOTORIETY_LEVELS
   * @param {string} worldId
   */
  async setNotoriety(level, worldId) {
    if (!NOTORIETY_LEVELS.includes(level)) {
      console.warn(`${MODULE_ID} | Reputation: unknown notoriety level "${level}", ignoring`);
      return;
    }
    if (!this._data) return;
    this._data.notoriety = level;
    this._dirty = true;
    console.log(`${MODULE_ID} | Reputation: notoriety manually set → ${level}`);
    await this.save(worldId);
  }

  // ── Titles ───────────────────────────────────────────────────

  /**
   * Add a title if not already present and save.
   * @param {string} title
   * @param {string} worldId
   */
  async addTitle(title, worldId) {
    if (!title || !this._data) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    if (this._data.titles.includes(trimmed)) {
      console.debug(`${MODULE_ID} | Reputation: title "${trimmed}" already exists, skipping`);
      return;
    }
    this._data.titles.push(trimmed);
    this._dirty = true;
    console.log(`${MODULE_ID} | Reputation: title added — "${trimmed}"`);
    await this.save(worldId);
  }

  /**
   * Remove a title by exact match and save.
   * @param {string} title
   * @param {string} worldId
   */
  async removeTitle(title, worldId) {
    if (!title || !this._data) return;
    const before = this._data.titles.length;
    this._data.titles = this._data.titles.filter(t => t !== title);
    if (this._data.titles.length !== before) {
      this._dirty = true;
      console.log(`${MODULE_ID} | Reputation: title removed — "${title}"`);
      await this.save(worldId);
    }
  }

  // ── Deeds ────────────────────────────────────────────────────

  /**
   * Add a new deed, auto-recalculate notoriety, and save.
   *
   * @param {string} summary        — Short description of the deed
   * @param {object} [options={}]
   * @param {string} [options.location]          — Where it happened (city/region id)
   * @param {number} [options.session]            — Session number
   * @param {string} [options.impact="local"]     — "local"|"regional"|"continental"|"legendary"
   * @param {object} [options.factionReactions]   — { factionId: "grateful"|"hostile"|etc }
   * @param {string[]} [options.tags]             — Keyword tags for matching
   * @param {string} worldId
   * @returns {object|null} The new deed object, or null on failure
   */
  async addDeed(summary, options = {}, worldId) {
    if (!summary || !this._data) return null;

    const impact = IMPACT_LEVELS.includes(options.impact) ? options.impact : "local";

    const deed = {
      id:               `deed_${++this._deedCounter}`,
      summary:          summary.trim(),
      location:         options.location   ?? null,
      session:          options.session    ?? null,
      timestamp:        new Date().toISOString(),
      impact,
      factionReactions: (options.factionReactions && typeof options.factionReactions === "object")
        ? options.factionReactions
        : {},
      tags: Array.isArray(options.tags) ? [...options.tags] : [],
    };

    this._data.deeds.push(deed);

    // Auto-update knownInRegions from deed location
    if (deed.location) {
      const region = String(deed.location).trim().toLowerCase().replace(/\s+/g, "_");
      if (region && !this._data.knownInRegions.includes(region)) {
        this._data.knownInRegions.push(region);
      }
    }

    this._recalculateNotoriety();
    this._dirty = true;
    console.log(`${MODULE_ID} | Reputation: deed added [${deed.id}] — "${deed.summary}" (impact: ${impact})`);
    await this.save(worldId);
    return deed;
  }

  /**
   * Remove a deed by ID, recalculate notoriety, and save.
   * @param {string} deedId
   * @param {string} worldId
   */
  async removeDeed(deedId, worldId) {
    if (!deedId || !this._data) return;
    const before = this._data.deeds.length;
    this._data.deeds = this._data.deeds.filter(d => d.id !== deedId);
    if (this._data.deeds.length !== before) {
      this._recalculateNotoriety();
      this._dirty = true;
      console.log(`${MODULE_ID} | Reputation: deed removed [${deedId}]`);
      await this.save(worldId);
    }
  }

  // ── Notoriety Calculation ────────────────────────────────────

  /**
   * Recalculate notoriety from the current deed list.
   * Updates this._data.notoriety in place.
   * @private
   */
  _recalculateNotoriety() {
    if (!this._data) return;

    const counts = { local: 0, regional: 0, continental: 0, legendary: 0 };
    for (const deed of this._data.deeds) {
      if (counts[deed.impact] !== undefined) counts[deed.impact]++;
    }

    let level = "unknown";

    if (counts.legendary > 0) {
      level = "legendary";
    } else if (counts.continental >= 3) {
      level = "legendary";
    } else if (counts.continental > 0) {
      level = "continental";
    } else if (counts.regional >= 3) {
      level = "continental";
    } else if (counts.regional > 0) {
      level = "regional";
    } else if (counts.local >= 3) {
      level = "regional";
    } else if (counts.local > 0) {
      level = "local";
    }

    const previous = this._data.notoriety;
    this._data.notoriety = level;
    if (previous !== level) {
      console.log(`${MODULE_ID} | Reputation: notoriety recalculated ${previous} → ${level}`);
    }
  }

  // ── NPC Knowledge ────────────────────────────────────────────

  /**
   * Return what an NPC would know about the party, or null if they know nothing.
   *
   * Decision logic (first match wins):
   *  1. notoriety "unknown"      → null (party is unknown to everyone)
   *  2. notoriety "legendary"    → every NPC knows ("legendary_status")
   *  3. notoriety "continental"  → widespread, every NPC knows ("widespread_fame")
   *  4. NPC's faction is tracked → faction network knows ("faction_network")
   *  5. NPC is in a known region → local word of mouth ("local_knowledge")
   *  6. Otherwise                → null
   *
   * @param {string|null} npcFactionId  — Faction ID of the NPC (may be null/undefined)
   * @param {string|null} npcLocation   — Location/region ID of the NPC (may be null/undefined)
   * @returns {object|null}
   */
  getNpcKnowledge(npcFactionId = null, npcLocation = null) {
    if (!this._data) return null;

    const notoriety = this._data.notoriety;
    if (notoriety === "unknown") return null;

    const factionKey  = npcFactionId
      ? String(npcFactionId).trim().toLowerCase()
      : null;
    const locationKey = npcLocation
      ? String(npcLocation).trim().toLowerCase().replace(/\s+/g, "_")
      : null;

    const hasFactionLink  = factionKey  !== null && factionKey  in this._data.factionStanding;
    const isInKnownRegion = locationKey !== null && this._data.knownInRegions.includes(locationKey);

    let knows  = false;
    let source = null;

    if (notoriety === "legendary") {
      knows  = true;
      source = "legendary_status";
    } else if (notoriety === "continental") {
      knows  = true;
      source = "widespread_fame";
    } else if (hasFactionLink) {
      knows  = true;
      source = "faction_network";
    } else if (isInKnownRegion) {
      knows  = true;
      source = "local_knowledge";
    }

    if (!knows) return null;

    // Derive attitude from faction standing (if available)
    let attitude = "neutral";
    if (hasFactionLink) {
      const standing = this._data.factionStanding[factionKey];
      if (standing === "revered" || standing === "friendly") {
        attitude = "friendly";
      } else if (standing === "hostile" || standing === "hated") {
        attitude = "hostile";
      } else {
        // suspicious / neutral → neutral attitude in NPC knowledge
        attitude = "neutral";
      }
    }

    const knownDeeds  = this._filterDeedsForNpc(factionKey, locationKey, notoriety);
    const knownTitles = [...this._data.titles];
    const promptText  = this._buildNpcPromptText({ notoriety, source, attitude, knownDeeds, knownTitles });

    return {
      knows: true,
      source,
      attitude,
      knownDeeds,
      knownTitles,
      promptText,
    };
  }

  /**
   * Filter the deed list to those most relevant for a given NPC context.
   * @private
   * @param {string|null} factionKey
   * @param {string|null} locationKey
   * @param {string} notoriety
   * @returns {object[]} Lightweight deed summaries
   */
  _filterDeedsForNpc(factionKey, locationKey, notoriety) {
    if (!this._data) return [];

    return this._data.deeds.filter(deed => {
      // High-impact deeds are known when fame is widespread
      if (notoriety === "legendary" || notoriety === "continental") {
        if (deed.impact === "legendary" || deed.impact === "continental") return true;
      }

      // Deeds that specifically name this faction in reactions
      if (factionKey && deed.factionReactions) {
        const reactionKey = Object.keys(deed.factionReactions)
          .find(k => k.toLowerCase() === factionKey);
        if (reactionKey) return true;
      }

      // Deeds that happened in the NPC's region
      if (locationKey && deed.location) {
        const deedLoc = String(deed.location).trim().toLowerCase().replace(/\s+/g, "_");
        if (deedLoc === locationKey) return true;
      }

      // For legendary notoriety include ALL deeds — the legend is everywhere
      if (notoriety === "legendary") return true;

      return false;
    }).map(deed => {
      // Find this faction's specific reaction, if any
      let factionReaction = null;
      if (factionKey && deed.factionReactions) {
        const key = Object.keys(deed.factionReactions)
          .find(k => k.toLowerCase() === factionKey);
        if (key) factionReaction = deed.factionReactions[key];
      }
      return {
        summary:         deed.summary,
        impact:          deed.impact,
        factionReaction,
      };
    });
  }

  /**
   * Build the pre-formatted prompt text to inject into an NPC system prompt.
   * @private
   */
  _buildNpcPromptText({ notoriety, source, attitude, knownDeeds, knownTitles }) {
    const sourceLabel = {
      faction_network:  "their faction network",
      local_knowledge:  "local word of mouth",
      widespread_fame:  "widespread regional fame",
      legendary_status: "legendary reputation that has spread across the land",
    }[source] ?? "word of mouth";

    const attitudeLabel = {
      friendly: "friendly / respectful",
      neutral:  "neutral / curious",
      hostile:  "hostile / wary",
    }[attitude] ?? "neutral / curious";

    const titlesLine = knownTitles.length > 0
      ? knownTitles.join(", ")
      : "an unnamed adventuring party";

    let deedsSection;
    if (knownDeeds.length > 0) {
      const lines = knownDeeds.map(d => {
        const reaction = d.factionReaction
          ? ` [this NPC's faction reaction: ${d.factionReaction}]`
          : "";
        return `- ${d.summary} (${d.impact} impact)${reaction}`;
      }).join("\n");
      deedsSection = `\nKnown deeds:\n${lines}`;
    } else {
      deedsSection = "\nThe NPC has heard only vague rumours but knows no specific deeds.";
    }

    return [
      "## PARTY REPUTATION",
      `The adventuring party is known as: ${titlesLine}. Their notoriety level: ${notoriety}.`,
      `This NPC has heard of them through ${sourceLabel}.`,
      `NPC's attitude toward the party: ${attitudeLabel}`,
      deedsSection,
      "",
      "Use this knowledge naturally in conversation. The NPC should reference these deeds",
      "if relevant, react according to their attitude, and address the party with appropriate",
      "respect/fear/hostility. Do NOT list all deeds — weave 1-2 naturally into dialogue.",
    ].join("\n");
  }

  // ── AI Deed Suggestion ───────────────────────────────────────

  /**
   * Use the AI provider to extract notable deeds from a session summary.
   * Returns suggested deed objects for GM review — does NOT save them.
   *
   * Supports both .complete(systemPrompt, userPrompt) and
   * .chat([{role, content}]) style providers.
   *
   * @param {string} summaryText
   * @param {object} aiProvider  — ACE aiProvider instance
   * @returns {object[]} Array of sanitised suggested deed objects (not yet saved)
   */
  async suggestDeedsFromSummary(summaryText, aiProvider) {
    if (!summaryText || !aiProvider) return [];

    const systemPrompt = [
      "You are an expert Dungeons & Dragons game analyst.",
      "Extract notable accomplishments from a session summary.",
      "Return ONLY a valid JSON array. Each object must have:",
      '  - "summary": string (concise deed description, 1-2 sentences)',
      '  - "impact": one of "local" | "regional" | "continental" | "legendary"',
      '  - "location": string or null (region/city where it happened)',
      '  - "factionReactions": object mapping faction IDs to reactions',
      '    e.g. {"harpers": "grateful", "zhentarim": "hostile"} or {}',
      '  - "tags": string array of relevant keywords',
      "",
      "Only include significant story deeds: boss kills, quest completions,",
      "major decisions, faction-shaping events.",
      "Skip minor skirmishes and routine encounters.",
      "If there are no significant deeds, return an empty array: []",
    ].join("\n");

    const userPrompt = `Session summary:\n${summaryText}\n\nExtract notable deeds as a JSON array.`;

    try {
      let raw = "";

      if (typeof aiProvider.complete === "function") {
        raw = await aiProvider.complete(systemPrompt, userPrompt);
      } else if (typeof aiProvider.chat === "function") {
        raw = await aiProvider.chat([
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt  },
        ]);
      } else {
        console.warn(`${MODULE_ID} | Reputation: aiProvider has no compatible complete() or chat() method`);
        return [];
      }

      // Extract JSON array from response — handles markdown code fences
      const jsonMatch = String(raw).match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn(`${MODULE_ID} | Reputation: AI response contained no JSON array`);
        return [];
      }

      const suggested = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(suggested)) return [];

      // Sanitise each entry
      return suggested
        .map((d, i) => ({
          summary:          String(d.summary ?? "").trim(),
          impact:           IMPACT_LEVELS.includes(d.impact) ? d.impact : "local",
          location:         d.location ? String(d.location).trim() : null,
          factionReactions: (d.factionReactions && typeof d.factionReactions === "object")
            ? d.factionReactions
            : {},
          tags:             Array.isArray(d.tags) ? d.tags.map(String) : [],
          _suggestIndex:    i,  // used by formatForGmReview checkboxes
        }))
        .filter(d => d.summary.length > 0);

    } catch (err) {
      console.error(`${MODULE_ID} | Reputation: suggestDeedsFromSummary failed —`, err);
      return [];
    }
  }

  /**
   * Format an array of suggested deeds as an HTML string for a review dialog.
   * Each deed gets a checkbox so the GM can approve/reject before adding.
   *
   * @param {object[]} suggestedDeeds
   * @returns {string} HTML string
   */
  formatForGmReview(suggestedDeeds) {
    if (!Array.isArray(suggestedDeeds) || suggestedDeeds.length === 0) {
      return `<p class="ace-rep-empty">No deeds were extracted from the summary.</p>`;
    }

    const rows = suggestedDeeds.map((deed, i) => {
      const factionHtml = Object.keys(deed.factionReactions ?? {}).length > 0
        ? `<span class="ace-rep-factions">${
            Object.entries(deed.factionReactions)
              .map(([f, r]) => `${f}: <em>${r}</em>`)
              .join(", ")
          }</span>`
        : "";

      const tagsHtml = (deed.tags ?? []).length > 0
        ? `<span class="ace-rep-tags">${deed.tags.join(", ")}</span>`
        : "";

      const locationHtml = deed.location
        ? `<span class="ace-rep-location">Location: ${deed.location}</span>`
        : "";

      return `
        <div class="ace-rep-deed-row" data-index="${i}">
          <label class="ace-rep-deed-label">
            <input type="checkbox"
                   class="ace-rep-deed-check"
                   name="deed_${i}"
                   value="${i}"
                   checked />
            <span class="ace-rep-deed-summary">${deed.summary}</span>
          </label>
          <div class="ace-rep-deed-meta">
            <span class="ace-rep-impact ace-rep-impact--${deed.impact}">${deed.impact}</span>
            ${locationHtml}
            ${factionHtml}
            ${tagsHtml}
          </div>
        </div>`;
    }).join("\n");

    return `
      <div class="ace-rep-review">
        <p class="ace-rep-review-intro">
          The AI found <strong>${suggestedDeeds.length}</strong> notable deed(s).
          Check the ones you want to add to the party's reputation record.
        </p>
        <div class="ace-rep-deed-list">
          ${rows}
        </div>
      </div>`;
  }

  // ── Stats ────────────────────────────────────────────────────

  /**
   * Return summary counts for UI display.
   * @returns {object}
   */
  getStats() {
    if (!this._data) {
      return {
        notoriety:    "unknown",
        deedCount:    0,
        titleCount:   0,
        factionCount: 0,
        regionCount:  0,
      };
    }
    return {
      notoriety:    this._data.notoriety,
      deedCount:    this._data.deeds.length,
      titleCount:   this._data.titles.length,
      factionCount: Object.keys(this._data.factionStanding).length,
      regionCount:  this._data.knownInRegions.length,
    };
  }
}
