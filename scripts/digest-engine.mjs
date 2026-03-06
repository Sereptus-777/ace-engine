// ============================================================
// ACE — AI Campaign Engine — Digest Engine
// AI-powered structured extraction from uploaded documents.
// Generates JSON digests (NPCs, locations, items, etc.) stored
// globally across all Foundry worlds.
// ============================================================

const MODULE_ID = "ace-engine";
const GLOBAL_DIGEST_DIR = "ace-engine-library/digests";
const DIGEST_BATCH_SIZE = 10;  // chunks per AI call

// v13-safe FilePicker access
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ??
  globalThis.FilePicker;

/** Upload a file silently — suppresses Foundry notification toast. */
async function _silentUpload(source, dir, file) {
  const orig = ui.notifications?.info;
  try {
    if (ui.notifications) ui.notifications.info = () => {};
    return await _FP().upload(source, dir, file, { notify: false });
  } finally {
    if (ui.notifications && orig) ui.notifications.info = orig;
  }
}


// ── Extraction Prompt ────────────────────────────────────────

const DIGEST_EXTRACTION_PROMPT = `You are analyzing sections of a tabletop RPG sourcebook or adventure module. Extract ALL structured information from the following text passages.

Return ONLY valid JSON with these categories (include empty arrays for categories with no data):
{
  "npcs": [{"name": "...", "role": "...", "location": "...", "notes": "..."}],
  "locations": [{"name": "...", "type": "...", "key_details": "...", "encounters": "..."}],
  "plotHooks": [{"title": "...", "description": "...", "trigger": "..."}],
  "encounters": [{"name": "...", "location": "...", "creatures": "...", "difficulty": "..."}],
  "items": [{"name": "...", "type": "...", "description": "...", "location": "..."}],
  "factions": [{"name": "...", "goals": "...", "allies": "...", "enemies": "..."}],
  "lore": [{"topic": "...", "details": "..."}]
}

Rules:
- Extract EVERY named NPC, location, item, faction, creature, and plot element
- Be thorough — each distinct entity gets its own entry
- For NPCs, capture their role (ally, villain, quest-giver, shopkeeper, etc.) and key traits
- For locations, capture type (dungeon, town, wilderness, etc.) and notable features
- If text mentions a combat encounter, extract creatures, location, and difficulty if stated
- Keep individual field values concise (1-2 sentences max per field)
- Respond with ONLY the JSON — no explanation, no markdown fences

Text passages:
`;

const SUMMARY_PROMPT_PREFIX = `You are summarizing a tabletop RPG sourcebook for a Game Master assistant. Based on the extracted data below, write a concise 2-4 paragraph overview of this adventure/sourcebook. Cover the main premise, key villain(s), setting, and overall story arc. Be specific — use names and locations from the data.

Respond with ONLY the summary text — no JSON, no markdown headings.

Document: `;


// ── DigestEngine ─────────────────────────────────────────────

export class DigestEngine {
  constructor() {
    this._indexLoaded = false;
    this._index = { version: 1, digests: {} };
    this._cache = new Map(); // digestId → full digest JSON
  }

  // ── Global Directory & Index ─────────────────────────────

  async ensureGlobalDirectory() {
    try {
      await _FP().createDirectory("data", "ace-engine-library");
    } catch (e) {
      if (!e.message?.includes("EEXIST") && !e.message?.includes("already exists")) {
        console.warn(`${MODULE_ID} | Could not create ace-engine-library/:`, e.message);
      }
    }
    try {
      await _FP().createDirectory("data", GLOBAL_DIGEST_DIR);
    } catch (e) {
      if (!e.message?.includes("EEXIST") && !e.message?.includes("already exists")) {
        console.warn(`${MODULE_ID} | Could not create digests/:`, e.message);
      }
    }
  }

  async loadIndex() {
    if (this._indexLoaded) return;
    await this.ensureGlobalDirectory();

    try {
      const listing = await _FP().browse("data", GLOBAL_DIGEST_DIR);
      const hasIndex = (listing?.files ?? []).some(f => f.endsWith("_index.json"));
      if (!hasIndex) {
        this._indexLoaded = true;
        return;
      }
      const resp = await fetch(`${GLOBAL_DIGEST_DIR}/_index.json`, { cache: "no-store" });
      if (resp.ok) {
        this._index = await resp.json();
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Digest index load failed:`, err);
    }
    this._indexLoaded = true;
  }

  async saveIndex() {
    const payload = JSON.stringify(this._index, null, 2);
    const file = new File([payload], "_index.json", { type: "application/json" });
    await _silentUpload("data", GLOBAL_DIGEST_DIR, file);
  }

  /** Get all digest entries from the index. */
  getAllDigests() {
    return Object.entries(this._index.digests ?? {}).map(([id, meta]) => ({ id, ...meta }));
  }

  /** Get a single digest index entry by ID. */
  getDigestMeta(digestId) {
    return this._index.digests?.[digestId] ?? null;
  }

  // ── Digest File I/O ──────────────────────────────────────

  async saveDigest(digestId, digestData) {
    const fileName = `${digestId}.json`;
    const payload = JSON.stringify(digestData, null, 2);
    const file = new File([payload], fileName, { type: "application/json" });
    await _silentUpload("data", GLOBAL_DIGEST_DIR, file);
    this._cache.set(digestId, digestData);
  }

  async loadDigest(digestId) {
    if (this._cache.has(digestId)) return this._cache.get(digestId);
    const fileName = `${digestId}.json`;
    try {
      const resp = await fetch(`${GLOBAL_DIGEST_DIR}/${fileName}`, { cache: "no-store" });
      if (!resp.ok) return null;
      const data = await resp.json();
      this._cache.set(digestId, data);
      return data;
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to load digest ${digestId}:`, err);
      return null;
    }
  }

  /** Remove a digest from disk and index. */
  async deleteDigest(digestId) {
    delete this._index.digests[digestId];
    this._cache.delete(digestId);
    await this.saveIndex();
    // Note: Foundry has no file delete API — the JSON file remains on disk
    // but is no longer referenced by the index.
  }

  updateIndex(digestId, meta) {
    this._index.digests[digestId] = meta;
  }

  // ── Digest Generation ────────────────────────────────────

  /**
   * Generate a structured digest from a document's chunks.
   * @param {Object} doc - Document record from DocumentStore
   * @param {Object} aiProvider - AiProvider instance with .chat()
   * @param {function} onProgress - (batchNum, totalBatches, phase) callback
   * @returns {Promise<Object>} The digest object
   */
  async generateDigest(doc, aiProvider, onProgress = () => {}) {
    const chunks = doc.chunks ?? [];
    if (!chunks.length) throw new Error("No text chunks to digest");

    const totalBatches = Math.ceil(chunks.length / DIGEST_BATCH_SIZE);
    const partials = [];

    // ── Phase 1: Batch extraction ──
    for (let i = 0; i < totalBatches; i++) {
      const batchChunks = chunks.slice(i * DIGEST_BATCH_SIZE, (i + 1) * DIGEST_BATCH_SIZE);
      const batchText = batchChunks.map(c => {
        let entry = "";
        if (c.heading) entry += `[${c.heading}] `;
        entry += `(p.${c.page}) ${c.text}`;
        return entry;
      }).join("\n\n---\n\n");

      onProgress(i + 1, totalBatches, "extracting");

      try {
        const response = await aiProvider.chat(
          DIGEST_EXTRACTION_PROMPT + batchText,
          "", "", []
        );
        const parsed = this._parseDigestResponse(response);
        if (parsed) partials.push(parsed);
      } catch (err) {
        console.warn(`${MODULE_ID} | Digest batch ${i + 1}/${totalBatches} failed:`, err);
        // Continue with remaining batches — partial digest is better than none
      }

      // Yield to UI between batches
      await new Promise(r => setTimeout(r, 50));
    }

    if (!partials.length) {
      throw new Error("All digest batches failed — check your AI provider connection.");
    }

    // ── Phase 2: Merge partial results ──
    onProgress(totalBatches, totalBatches, "merging");
    const merged = this._mergePartials(partials);

    // ── Phase 3: Generate summary ──
    onProgress(totalBatches, totalBatches, "summary");
    try {
      const statsText = this._digestStatsText(merged);
      const summaryPrompt = SUMMARY_PROMPT_PREFIX + `"${doc.displayName}"\n\nExtracted data:\n${statsText}`;
      const summaryResponse = await aiProvider.chat(summaryPrompt, "", "", []);
      merged.summary = summaryResponse.trim();
    } catch (err) {
      console.warn(`${MODULE_ID} | Digest summary generation failed:`, err);
      merged.summary = `Digest of "${doc.displayName}" — ${doc.pageCount ?? 0} pages processed.`;
    }

    return merged;
  }

  // ── JSON Parsing ─────────────────────────────────────────

  _parseDigestResponse(text) {
    if (!text) return null;

    // Try direct parse first
    try {
      const obj = JSON.parse(text);
      if (this._isValidDigest(obj)) return obj;
    } catch (_) { /* not raw JSON */ }

    // Try extracting from markdown fences
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      try {
        const obj = JSON.parse(fenceMatch[1]);
        if (this._isValidDigest(obj)) return obj;
      } catch (_) { /* bad JSON in fence */ }
    }

    // Try finding first { to last }
    const first = text.indexOf("{");
    const last  = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        const obj = JSON.parse(text.slice(first, last + 1));
        if (this._isValidDigest(obj)) return obj;
      } catch (_) { /* still not valid */ }
    }

    console.warn(`${MODULE_ID} | Could not parse digest response`);
    return null;
  }

  _isValidDigest(obj) {
    if (!obj || typeof obj !== "object") return false;
    // Must have at least one recognized category
    const categories = ["npcs", "locations", "plotHooks", "encounters", "items", "factions", "lore"];
    return categories.some(c => Array.isArray(obj[c]));
  }

  // ── Merge & Deduplicate ──────────────────────────────────

  _mergePartials(partials) {
    const merged = {
      summary: "",
      npcs: [],
      locations: [],
      plotHooks: [],
      encounters: [],
      items: [],
      factions: [],
      lore: [],
    };

    // Concatenate all partials
    for (const partial of partials) {
      for (const category of Object.keys(merged)) {
        if (category === "summary") continue;
        if (Array.isArray(partial[category])) {
          merged[category].push(...partial[category]);
        }
      }
    }

    // Deduplicate by name (npcs, locations, items, factions)
    for (const category of ["npcs", "locations", "items", "factions"]) {
      merged[category] = this._deduplicateByField(merged[category], "name");
    }

    // Deduplicate plotHooks/encounters by title or name
    merged.plotHooks  = this._deduplicateByField(merged.plotHooks, "title");
    merged.encounters = this._deduplicateByField(merged.encounters, "name");
    merged.lore       = this._deduplicateByField(merged.lore, "topic");

    return merged;
  }

  _deduplicateByField(items, field) {
    const seen = new Map();
    for (const entry of items) {
      const key = (entry[field] ?? "").toLowerCase().trim();
      if (!key) continue;
      if (seen.has(key)) {
        // Keep longer values for each field
        const existing = seen.get(key);
        for (const [f, value] of Object.entries(entry)) {
          if (f === field) continue;
          if (value && (!existing[f] || String(value).length > String(existing[f]).length)) {
            existing[f] = value;
          }
        }
      } else {
        seen.set(key, { ...entry });
      }
    }
    return [...seen.values()];
  }

  _digestStatsText(digest) {
    const parts = [];
    if (digest.npcs?.length)       parts.push(`NPCs: ${digest.npcs.map(n => n.name).join(", ")}`);
    if (digest.locations?.length)   parts.push(`Locations: ${digest.locations.map(l => l.name).join(", ")}`);
    if (digest.factions?.length)    parts.push(`Factions: ${digest.factions.map(f => f.name).join(", ")}`);
    if (digest.encounters?.length)  parts.push(`Encounters: ${digest.encounters.length}`);
    if (digest.items?.length)       parts.push(`Items: ${digest.items.map(i => i.name).join(", ")}`);
    if (digest.plotHooks?.length)   parts.push(`Plot hooks: ${digest.plotHooks.length}`);
    if (digest.lore?.length)        parts.push(`Lore topics: ${digest.lore.map(l => l.topic).join(", ")}`);
    return parts.join("\n");
  }

  // ── Context Building from Digests ────────────────────────

  /**
   * Build AI context from active digest data.
   * Searches digest entries by keyword, scores and formats matches.
   * @param {string[]} activeDigestIds - Digest IDs enabled for this world
   * @param {string[]} queryKeywords - Keywords extracted from user message + scene
   * @param {number} maxChars - Character budget
   * @returns {{ text: string, charsUsed: number }}
   */
  buildDigestContext(activeDigestIds, queryKeywords, maxChars) {
    if (!activeDigestIds?.length || !queryKeywords?.length) return { text: "", charsUsed: 0 };

    const querySet = new Set(queryKeywords.map(k => k.toLowerCase()));
    let text = "";
    let charsUsed = 0;

    for (const digestId of activeDigestIds) {
      const digestData = this._cache.get(digestId);
      if (!digestData?.digest) continue;

      const d = digestData.digest;
      const source = digestData.displayName ?? "Unknown";
      const matches = [];

      // Score NPCs
      for (const npc of (d.npcs ?? [])) {
        const score = this._scoreEntry(npc, querySet, ["name", "role", "location", "notes"]);
        if (score > 0) matches.push({ type: "NPC", score,
          line: `**${npc.name}** (${npc.role ?? "?"}): ${npc.notes ?? ""}${npc.location ? " — " + npc.location : ""}` });
      }

      // Score Locations
      for (const loc of (d.locations ?? [])) {
        const score = this._scoreEntry(loc, querySet, ["name", "type", "key_details", "encounters"]);
        if (score > 0) matches.push({ type: "Location", score,
          line: `**${loc.name}** (${loc.type ?? "location"}): ${loc.key_details ?? ""}${loc.encounters ? " Encounters: " + loc.encounters : ""}` });
      }

      // Score Encounters
      for (const enc of (d.encounters ?? [])) {
        const score = this._scoreEntry(enc, querySet, ["name", "location", "creatures", "difficulty"]);
        if (score > 0) matches.push({ type: "Encounter", score,
          line: `**${enc.name}**: ${enc.creatures ?? ""} at ${enc.location ?? "unknown"} (${enc.difficulty ?? "?"})` });
      }

      // Score Items
      for (const item of (d.items ?? [])) {
        const score = this._scoreEntry(item, querySet, ["name", "type", "description", "location"]);
        if (score > 0) matches.push({ type: "Item", score,
          line: `**${item.name}** (${item.type ?? "item"}): ${item.description ?? ""}` });
      }

      // Score Factions
      for (const fac of (d.factions ?? [])) {
        const score = this._scoreEntry(fac, querySet, ["name", "goals", "allies", "enemies"]);
        if (score > 0) matches.push({ type: "Faction", score,
          line: `**${fac.name}**: ${fac.goals ?? ""}${fac.allies ? " Allies: " + fac.allies : ""}${fac.enemies ? " Enemies: " + fac.enemies : ""}` });
      }

      // Score Plot Hooks
      for (const hook of (d.plotHooks ?? [])) {
        const score = this._scoreEntry(hook, querySet, ["title", "description", "trigger"]);
        if (score > 0) matches.push({ type: "Plot", score,
          line: `**${hook.title}**: ${hook.description ?? ""}${hook.trigger ? " Trigger: " + hook.trigger : ""}` });
      }

      // Score Lore
      for (const lore of (d.lore ?? [])) {
        const score = this._scoreEntry(lore, querySet, ["topic", "details"]);
        if (score > 0) matches.push({ type: "Lore", score,
          line: `**${lore.topic}**: ${lore.details ?? ""}` });
      }

      if (!matches.length) continue;

      // Sort by score and format within budget
      matches.sort((a, b) => b.score - a.score);
      const header = `**From: ${source}**\n`;
      if (charsUsed + header.length > maxChars) break;
      text += header;
      charsUsed += header.length;

      for (const m of matches) {
        const entry = `- [${m.type}] ${m.line}\n`;
        if (charsUsed + entry.length > maxChars) break;
        text += entry;
        charsUsed += entry.length;
      }
      text += "\n";
      charsUsed += 1;
    }

    return { text, charsUsed };
  }

  /**
   * Score a digest entry against query keywords.
   * @private
   */
  _scoreEntry(entry, querySet, fields) {
    let score = 0;
    for (const field of fields) {
      const value = entry[field];
      if (!value) continue;
      const lower = String(value).toLowerCase();
      for (const kw of querySet) {
        if (lower.includes(kw)) score += (field === fields[0] ? 3 : 1); // name field = 3x
      }
    }
    return score;
  }

  /**
   * Pre-load active digests into cache for fast context building.
   * @param {string[]} digestIds
   */
  async loadActiveDigests(digestIds) {
    for (const id of (digestIds ?? [])) {
      if (!this._cache.has(id)) {
        await this.loadDigest(id);
      }
    }
  }
}
