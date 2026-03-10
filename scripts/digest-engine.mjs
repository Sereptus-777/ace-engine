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

/** Upload a file silently — suppresses Foundry notification toast.
 *  Uses a refcount instead of save/restore so concurrent calls are safe. */
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


// ── Extraction Prompt ────────────────────────────────────────

const DIGEST_EXTRACTION_PROMPT = `You are analyzing sections of a tabletop RPG sourcebook or adventure module. Extract ALL structured information from the following text passages.

Return ONLY valid JSON with these categories (include empty arrays for categories with no data):
{
  "npcs": [{"name": "...", "role": "...", "location": "...", "faction": "...", "knowledge_level": "common|local|faction|secret", "notes": "..."}],
  "locations": [{"name": "...", "type": "...", "parent_location": "...", "region": "...", "key_details": "...", "knowledge_level": "common|local|secret", "encounters": "..."}],
  "factions": [{"name": "...", "type": "...", "territory": "...", "goals": "...", "allies": "...", "enemies": "...", "knowledge_level": "common|faction|secret"}],
  "plotHooks": [{"title": "...", "description": "...", "trigger": "...", "knowledge_level": "common|local|faction|secret"}],
  "encounters": [{"name": "...", "location": "...", "creatures": "...", "difficulty": "..."}],
  "items": [{"name": "...", "type": "...", "description": "...", "location": "...", "knowledge_level": "common|local|secret"}],
  "lore": [{"topic": "...", "details": "...", "knowledge_level": "common|local|faction|secret"}]
}

Rules:
- Extract EVERY named NPC, location, item, faction, creature, and plot element
- Be thorough — each distinct entity gets its own entry
- For NPCs: capture role (ally, villain, quest-giver, shopkeeper, etc.), faction membership if any, and key personality traits
- For locations: set parent_location to the containing location (e.g. a tavern's parent is its town), region to the broad area
- For factions: capture territory as comma-separated location names where they operate
- knowledge_level determines who in the game world would know about this:
  "common" = widely known in the region (rulers, major landmarks, public events, geography)
  "local" = known to people in that specific location (local businesses, neighborhood gossip, town politics)
  "faction" = known only to faction members (secret meetings, internal politics, hidden agendas)
  "secret" = known to very few (hidden identities, DM-only plot twists, ancient mysteries, sealed knowledge)
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
    // ── Digest run state ──
    this._running = false;    // true while generateDigest() is in progress
    this._paused = false;
    this._cancelled = false;
    this._pauseResolve = null;  // resolve function to unblock when resumed
  }

  /** Pause a running digest — it will save WIP and wait until resumed. */
  pauseDigest() {
    this._paused = true;
    console.log(`${MODULE_ID} | Digest paused by user.`);
  }

  /** Resume a paused digest. */
  resumeDigest() {
    this._paused = false;
    if (this._pauseResolve) {
      this._pauseResolve();
      this._pauseResolve = null;
    }
    console.log(`${MODULE_ID} | Digest resumed.`);
  }

  /** Cancel a running digest — saves progress, stops after current batch. */
  cancelDigest() {
    this._cancelled = true;
    this.resumeDigest(); // unblock if currently paused
    console.log(`${MODULE_ID} | Digest cancelled by user.`);
  }

  /** @private Block until resumed if paused. */
  async _waitIfPaused() {
    if (!this._paused) return;
    return new Promise(resolve => { this._pauseResolve = resolve; });
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
   * Saves progress after each batch — survives crashes and can resume.
   * @param {Object} doc - Document record from DocumentStore
   * @param {Object} aiProvider - AiProvider instance with .chat()
   * @param {function} onProgress - (batchNum, totalBatches, phase) callback
   * @returns {Promise<Object>} The digest object
   */
  async generateDigest(doc, aiProvider, onProgress = () => {}) {
    if (this._running) {
      throw new Error("A digest is already in progress. Wait for it to finish, or cancel it first.");
    }
    this._running = true;

    try {
      return await this._runDigest(doc, aiProvider, onProgress);
    } finally {
      this._running = false;
      this._paused = false;
      this._cancelled = false;
      this._pauseResolve = null;
    }
  }

  /** @private Internal digest runner — always called via generateDigest() which manages the lock. */
  async _runDigest(doc, aiProvider, onProgress) {
    const chunks = doc.chunks ?? [];
    if (!chunks.length) throw new Error("No text chunks to digest");

    const totalBatches = Math.ceil(chunks.length / DIGEST_BATCH_SIZE);

    // ── Check for work-in-progress from a previous interrupted run ──
    let partials = [];
    let startBatch = 0;
    const wip = await this._loadWip(doc.id);
    if (wip && wip.partials?.length && wip.totalBatches === totalBatches) {
      partials = wip.partials;
      startBatch = wip.completedUpTo + 1;
      console.log(`${MODULE_ID} | Resuming digest from batch ${startBatch + 1}/${totalBatches} (${partials.length} batches cached)`);
    }

    // ── Phase 1: Batch extraction ──
    this._paused = false;
    this._cancelled = false;
    let consecutiveFailures = 0;
    for (let i = startBatch; i < totalBatches; i++) {
      // ── Check cancel ──
      if (this._cancelled) {
        await this._saveWip(doc.id, { totalBatches, completedUpTo: Math.max(0, i - 1), partials, docDisplayName: doc.displayName });
        throw new Error("Digest cancelled — progress saved. Click Digest again to resume.");
      }
      // ── Wait while paused ──
      if (this._paused) {
        onProgress(i, totalBatches, "paused");
        await this._saveWip(doc.id, { totalBatches, completedUpTo: Math.max(0, i - 1), partials, docDisplayName: doc.displayName });
        await this._waitIfPaused();
        // Re-check cancel after unpause
        if (this._cancelled) {
          throw new Error("Digest cancelled — progress saved. Click Digest again to resume.");
        }
      }

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
        if (parsed) {
          partials.push(parsed);
          consecutiveFailures = 0;
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Digest batch ${i + 1}/${totalBatches} failed:`, err);
        consecutiveFailures++;
        // If 5 in a row fail, the AI provider is probably down — save and bail
        if (consecutiveFailures >= 5) {
          console.error(`${MODULE_ID} | 5 consecutive batch failures — saving progress and stopping.`);
          await this._saveWip(doc.id, { totalBatches, completedUpTo: i, partials, docDisplayName: doc.displayName });
          throw new Error(`Digest paused at batch ${i + 1}/${totalBatches} — 5 consecutive failures. Progress saved. Fix your AI connection and retry to resume.`);
        }
        // Continue with remaining batches — partial digest is better than none
      }

      // Save progress after every batch (crash protection)
      await this._saveWip(doc.id, { totalBatches, completedUpTo: i, partials, docDisplayName: doc.displayName });

      // Yield to UI between batches
      await new Promise(r => setTimeout(r, 50));
    }

    // ── Clean up WIP file — we're done with batch extraction ──
    await this._deleteWip(doc.id);

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

  // ── Work-In-Progress (WIP) Persistence ──────────────────

  /** Save batch progress so digests can resume after crashes. */
  async _saveWip(docId, wipData) {
    try {
      const fileName = `_wip_${docId}.json`;
      const payload = JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        ...wipData,
      }, null, 0); // compact — these can be big
      const file = new File([payload], fileName, { type: "application/json" });
      await _silentUpload("data", GLOBAL_DIGEST_DIR, file);
    } catch (err) {
      console.debug(`${MODULE_ID} | WIP save failed (non-critical):`, err);
    }
  }

  /** Load existing WIP data for a document, or null if none. */
  async _loadWip(docId) {
    try {
      const url = `${GLOBAL_DIGEST_DIR}/_wip_${docId}.json`;
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data?.version && data?.partials) return data;
      return null;
    } catch {
      return null;
    }
  }

  /** Remove WIP file after successful completion. */
  async _deleteWip(docId) {
    // Foundry has no file delete API — overwrite with a tiny tombstone
    try {
      const fileName = `_wip_${docId}.json`;
      const file = new File(['{"done":true}'], fileName, { type: "application/json" });
      await _silentUpload("data", GLOBAL_DIGEST_DIR, file);
    } catch { /* best effort */ }
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
    const MIN_SCORE = 2;   // Require at least 2 keyword hits to include an entry
    const MAX_ENTRIES = 25; // Hard cap on total entries sent to AI
    let text = "";
    let charsUsed = 0;

    for (const digestId of activeDigestIds) {
      const digestData = this._cache.get(digestId);
      if (!digestData?.digest) {
        console.warn(`${MODULE_ID} | Digest "${digestId}" is active but not in cache — skipping. Try reloading the world.`);
        continue;
      }

      const d = digestData.digest;
      const source = digestData.displayName ?? "Unknown";
      const matches = [];

      // Score NPCs
      for (const npc of (d.npcs ?? [])) {
        const score = this._scoreEntry(npc, querySet, ["name", "role", "location", "faction", "notes"]);
        if (score >= MIN_SCORE) {
          const parts = [`**${npc.name}** (${npc.role ?? "?"})`];
          if (npc.faction) parts.push(`[${npc.faction}]`);
          if (npc.notes) parts.push(npc.notes);
          if (npc.location) parts.push(`— ${npc.location}`);
          matches.push({ type: "NPC", score, kl: npc.knowledge_level, line: parts.join(" ") });
        }
      }

      // Score Locations
      for (const loc of (d.locations ?? [])) {
        const score = this._scoreEntry(loc, querySet, ["name", "type", "parent_location", "region", "key_details", "encounters"]);
        if (score >= MIN_SCORE) {
          const parts = [`**${loc.name}** (${loc.type ?? "location"})`];
          if (loc.parent_location) parts.push(`in ${loc.parent_location}`);
          if (loc.region && loc.region !== loc.parent_location) parts.push(`[${loc.region}]`);
          if (loc.key_details) parts.push(`: ${loc.key_details}`);
          if (loc.encounters) parts.push(`Encounters: ${loc.encounters}`);
          matches.push({ type: "Location", score, kl: loc.knowledge_level, line: parts.join(" ") });
        }
      }

      // Score Encounters
      for (const enc of (d.encounters ?? [])) {
        const score = this._scoreEntry(enc, querySet, ["name", "location", "creatures", "difficulty"]);
        if (score >= MIN_SCORE) matches.push({ type: "Encounter", score,
          line: `**${enc.name}**: ${enc.creatures ?? ""} at ${enc.location ?? "unknown"} (${enc.difficulty ?? "?"})` });
      }

      // Score Items
      for (const item of (d.items ?? [])) {
        const score = this._scoreEntry(item, querySet, ["name", "type", "description", "location"]);
        if (score >= MIN_SCORE) matches.push({ type: "Item", score, kl: item.knowledge_level,
          line: `**${item.name}** (${item.type ?? "item"}): ${item.description ?? ""}${item.location ? " — " + item.location : ""}` });
      }

      // Score Factions
      for (const fac of (d.factions ?? [])) {
        const score = this._scoreEntry(fac, querySet, ["name", "goals", "territory", "allies", "enemies"]);
        if (score >= MIN_SCORE) {
          const parts = [`**${fac.name}**`];
          if (fac.type) parts.push(`(${fac.type})`);
          if (fac.territory) parts.push(`[operates in: ${fac.territory}]`);
          if (fac.goals) parts.push(fac.goals);
          if (fac.allies) parts.push(`Allies: ${fac.allies}`);
          if (fac.enemies) parts.push(`Enemies: ${fac.enemies}`);
          matches.push({ type: "Faction", score, kl: fac.knowledge_level, line: parts.join(" ") });
        }
      }

      // Score Plot Hooks
      for (const hook of (d.plotHooks ?? [])) {
        const score = this._scoreEntry(hook, querySet, ["title", "description", "trigger"]);
        if (score >= MIN_SCORE) matches.push({ type: "Plot", score, kl: hook.knowledge_level,
          line: `**${hook.title}**: ${hook.description ?? ""}${hook.trigger ? " Trigger: " + hook.trigger : ""}` });
      }

      // Score Lore
      for (const lore of (d.lore ?? [])) {
        const score = this._scoreEntry(lore, querySet, ["topic", "details"]);
        if (score >= MIN_SCORE) matches.push({ type: "Lore", score, kl: lore.knowledge_level,
          line: `**${lore.topic}**: ${lore.details ?? ""}` });
      }

      if (!matches.length) continue;

      // Sort by score descending, then hard-cap to prevent context bloat
      matches.sort((a, b) => b.score - a.score);
      matches.length = Math.min(matches.length, MAX_ENTRIES);
      const header = `**From: ${source}**\n`;
      if (charsUsed + header.length > maxChars) break;
      text += header;
      charsUsed += header.length;

      for (const m of matches) {
        const klTag = m.kl ? ` {${m.kl}}` : "";
        const entry = `- [${m.type}]${klTag} ${m.line}\n`;
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

  // ── World Graph ─────────────────────────────────────────────
  // Merges all active digests into a single unified world model.
  // Stored at ace-engine-library/world-graph.json + backup.

  /**
   * Build a unified world graph from all active digests.
   * Merges and deduplicates entities across all digest sources.
   * @param {string[]} activeDigestIds - Digest IDs enabled for this world
   * @returns {Object} The world graph object
   */
  buildWorldGraph(activeDigestIds) {
    const graph = {
      version: 2,
      generatedAt: new Date().toISOString(),
      sources: [],
      npcs: [],
      locations: [],
      factions: [],
      items: [],
      encounters: [],
      plotHooks: [],
      lore: [],
      summary: "",
    };

    if (!activeDigestIds?.length) return graph;

    const allPartials = [];

    for (const digestId of activeDigestIds) {
      const digestData = this._cache.get(digestId);
      if (!digestData?.digest) continue;

      graph.sources.push({
        id: digestId,
        name: digestData.displayName ?? digestId,
        generatedAt: digestData.generatedAt ?? "",
      });

      allPartials.push(digestData.digest);
    }

    if (!allPartials.length) return graph;

    // Merge all digests using the same dedup logic as batch merging
    const merged = this._mergePartials(allPartials);

    graph.npcs       = merged.npcs       ?? [];
    graph.locations   = merged.locations   ?? [];
    graph.factions    = merged.factions    ?? [];
    graph.items       = merged.items       ?? [];
    graph.encounters  = merged.encounters  ?? [];
    graph.plotHooks   = merged.plotHooks   ?? [];
    graph.lore        = merged.lore        ?? [];

    // Build a combined summary from sources
    const summaries = allPartials
      .map(p => p.summary)
      .filter(Boolean);
    graph.summary = summaries.join("\n\n");

    console.log(`${MODULE_ID} | World graph built from ${graph.sources.length} source(s): ` +
      `${graph.npcs.length} NPCs, ${graph.locations.length} locations, ${graph.factions.length} factions, ` +
      `${graph.items.length} items, ${graph.lore.length} lore entries`);

    return graph;
  }

  /**
   * Save the world graph to disk (global storage + backup).
   * @param {Object} graph - The world graph object from buildWorldGraph()
   */
  async saveWorldGraph(graph) {
    await this.ensureGlobalDirectory();

    const payload = JSON.stringify(graph, null, 2);
    const mainFile = new File([payload], "world-graph.json", { type: "application/json" });
    const backupFile = new File([payload], "world-graph-backup.json", { type: "application/json" });

    try {
      await _silentUpload("data", "ace-engine-library", mainFile);
      await _silentUpload("data", "ace-engine-library", backupFile);
      console.log(`${MODULE_ID} | World graph saved (${(payload.length / 1024).toFixed(1)} KB) + backup`);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to save world graph:`, err);
    }
  }

  /**
   * Load the world graph from disk.
   * @returns {Promise<Object|null>}
   */
  async loadWorldGraph() {
    try {
      const resp = await fetch("ace-engine-library/world-graph.json", { cache: "no-store" });
      if (resp.ok) return await resp.json();
    } catch (_) { /* not found */ }

    // Try backup
    try {
      const resp = await fetch("ace-engine-library/world-graph-backup.json", { cache: "no-store" });
      if (resp.ok) {
        console.warn(`${MODULE_ID} | Loaded world graph from backup`);
        return await resp.json();
      }
    } catch (_) { /* no backup either */ }

    return null;
  }

  /**
   * Rebuild and save the world graph from current active digests.
   * Call this after generating, toggling, or deleting a digest.
   * @param {string[]} activeDigestIds
   */
  async rebuildWorldGraph(activeDigestIds) {
    // Ensure all active digests are in cache
    await this.loadActiveDigests(activeDigestIds);

    const graph = this.buildWorldGraph(activeDigestIds);
    await this.saveWorldGraph(graph);
    return graph;
  }
}
