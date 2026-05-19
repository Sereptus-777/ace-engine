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
 *  Uses a refcount instead of save/restore so concurrent calls are safe.
 *
 *  Also filters Foundry's spurious "User [] does not have permission to
 *  upload files" notifications (fired server-side on hosted Foundry even
 *  when the upload itself succeeds). Foundry V13 fires this through BOTH
 *  warn() and error() depending on context — we intercept both. The upload
 *  itself is fine, only the toast spam is the problem. */
let _silentDepth = 0;
let _origNotifyInfo = null;
let _origNotifyWarn = null;
let _origNotifyErr  = null;
const _PERM_RX = /does not have permission to upload/i;

async function _silentUpload(source, dir, file) {
  try {
    if (ui.notifications) {
      if (_silentDepth === 0) {
        _origNotifyInfo = ui.notifications.info;
        _origNotifyWarn = ui.notifications.warn.bind(ui.notifications);
        _origNotifyErr  = ui.notifications.error.bind(ui.notifications);
        ui.notifications.warn  = (msg, ...rest) => (typeof msg === "string" && _PERM_RX.test(msg)) ? null : _origNotifyWarn(msg, ...rest);
        ui.notifications.error = (msg, ...rest) => (typeof msg === "string" && _PERM_RX.test(msg)) ? null : _origNotifyErr(msg, ...rest);
      }
      _silentDepth++;
      ui.notifications.info = () => {};
    }
    return await _FP().upload(source, dir, file, { notify: false });
  } finally {
    if (ui.notifications && _silentDepth > 0) {
      _silentDepth--;
      if (_silentDepth === 0) {
        if (_origNotifyInfo) { ui.notifications.info  = _origNotifyInfo; _origNotifyInfo = null; }
        if (_origNotifyWarn) { ui.notifications.warn  = _origNotifyWarn; _origNotifyWarn = null; }
        if (_origNotifyErr)  { ui.notifications.error = _origNotifyErr;  _origNotifyErr  = null; }
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
  "factions": [{"name": "...", "type": "...", "alignment": "Lawful Good|Neutral Good|Chaotic Good|Lawful Neutral|True Neutral|Chaotic Neutral|Lawful Evil|Neutral Evil|Chaotic Evil|Unaligned", "territory": "...", "leader": "Name and Title or null", "goals": "...", "description": "3-5 sentences — founding history, methods, reputation, structure, and current activities", "allies": "...", "enemies": "...", "knowledge_level": "common|faction|secret"}],
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
- For factions: capture territory as comma-separated location names where they operate. ALWAYS include alignment (moral/ethical stance of the organization). Include the leader's name and title if known. The description should be RICH — 3-5 sentences covering founding history, organizational structure, methods, reputation, and current activities. Goals is a separate 1-2 sentence field for their active mission.
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
    // ── Direct Lookup Index ──
    this._lookupIndex = null;   // Map<normalizedName, Array<{category, entry, source}>>
    this._worldGraph = null;    // cached world graph object
    // ── Reverse Indexes (Enhancement 2) ──
    this._reverseLocationIndex = new Map(); // normalizedLocation → [{entry, source}]
    this._reverseFactionIndex = new Map();  // normalizedFaction → [{entry, source}]
    // ── Recent Context Memory (Enhancement 4) ──
    this._recentLookups = [];  // [{name, category, timestamp}] max 10
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

  /**
   * Nuclear option — wipe ALL digests from the index and cache.
   * Orphan JSON files remain on disk (Foundry has no delete API)
   * but they'll never be loaded again since the index is empty.
   * @returns {number} Number of digests that were removed
   */
  async nukeAllDigests() {
    const count = Object.keys(this._index.digests ?? {}).length;
    this._index.digests = {};
    this._cache.clear();
    await this.saveIndex();
    return count;
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

    // Read digest-specific model override from settings (cheaper model for bulk extraction)
    // Format: "provider:model" (e.g., "openai:gpt-4o-mini") or empty for main model
    const aiOpts = {};
    try {
      const dm = game.settings.get(MODULE_ID, "digestModel");
      if (dm && dm.length > 0) {
        const colonIdx = dm.indexOf(":");
        if (colonIdx > 0) {
          // "provider:model" format — route to a different API
          aiOpts.provider = dm.slice(0, colonIdx);
          aiOpts.model = dm.slice(colonIdx + 1);
        } else {
          // Legacy: bare model name (no provider prefix)
          aiOpts.model = dm;
        }
        // Use digest-specific API key if set, otherwise fall back to main key
        const digestKey = game.settings.get(MODULE_ID, "digestApiKey");
        if (digestKey && digestKey.length > 0) {
          aiOpts.apiKey = digestKey;
        }
        console.log(`${MODULE_ID} | Digest using override: ${aiOpts.provider ?? "same provider"} → ${aiOpts.model}`);
      }
    } catch { /* setting not registered yet — use main model */ }

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
        // Pass the extraction instructions as the SYSTEM prompt — NOT
        // stuffed into the user message — so Claude reads its role as
        // "JSON extractor", not "Game Master refusing to do something
        // off-brand." User message is just the chunk text.
        //
        // maxTokens: 8000 — without this the default (1792) silently
        // truncates Claude's rich JSON output mid-object on 10-chunk
        // batches. Truncated JSON fails JSON.parse → null result → 5
        // consecutive failures → digest aborts. 8K is the upper bound
        // for Claude Haiku output and covers any plausible extraction.
        const response = await aiProvider.chat(
          batchText,
          "", "", [], [],
          { ...aiOpts, systemPromptOverride: DIGEST_EXTRACTION_PROMPT, maxTokens: 8000 }
        );
        const parsed = this._parseDigestResponse(response);
        if (parsed) {
          partials.push(parsed);
          consecutiveFailures = 0;
        } else {
          // Parser returned null — response wasn't valid JSON. Count this
          // as a failure too so we don't loop silently on a model that
          // keeps refusing or returning prose instead of JSON.
          console.warn(`${MODULE_ID} | Digest batch ${i + 1}/${totalBatches}: response unparseable (no JSON found). First 200 chars: ${String(response ?? "").slice(0, 200)}`);
          consecutiveFailures++;
          if (consecutiveFailures >= 5) {
            await this._saveWip(doc.id, { totalBatches, completedUpTo: i, partials, docDisplayName: doc.displayName });
            throw new Error(`Digest paused at batch ${i + 1}/${totalBatches} — 5 consecutive unparseable responses (model is refusing or returning prose). Progress saved.`);
          }
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
      const summaryResponse = await aiProvider.chat(summaryPrompt, "", "", [], [], aiOpts);
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
    } catch (err) {
      console.warn("ace-engine | DigestEngine WIP file load failed:", err);
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
    } catch (err) { console.debug("ace-engine | DigestEngine WIP delete best-effort failed:", err); }
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

  // ── Direct Lookup Index ──────────────────────────────────
  // O(1) name-based lookup for NPCs, locations, factions, items, etc.
  // Built from the world graph at startup. No API calls, no keyword scoring.

  /** Category config: array key in world graph → name field → display label */
  static LOOKUP_CATEGORIES = [
    { key: "npcs",      nameField: "name",  label: "NPC" },
    { key: "locations",  nameField: "name",  label: "Location" },
    { key: "factions",   nameField: "name",  label: "Faction" },
    { key: "items",      nameField: "name",  label: "Item" },
    { key: "encounters", nameField: "name",  label: "Encounter" },
    { key: "plotHooks",  nameField: "title", label: "Plot Hook" },
    { key: "lore",       nameField: "topic", label: "Lore" },
  ];

  /**
   * Build the lookup index from a world graph.
   * Creates a Map keyed by normalized name → array of matching entries.
   * Each entry is stored under its full name AND each individual word (3+ chars).
   * @param {Object} graph - World graph object from buildWorldGraph/loadWorldGraph
   */
  buildLookupIndex(graph) {
    if (!graph) return;
    this._worldGraph = graph;
    const index = new Map();
    let entityCount = 0;

    // Build source lookup: index in sources array → source display name
    const sourceNames = (graph.sources ?? []).map(s => s.name ?? "Unknown");
    const defaultSource = sourceNames[0] ?? "World Graph";

    const addToIndex = (key, record) => {
      if (!key) return;
      const existing = index.get(key);
      if (existing) {
        // Avoid exact duplicates (same entry reference)
        if (!existing.some(r => r.entry === record.entry)) existing.push(record);
      } else {
        index.set(key, [record]);
      }
    };

    for (const cat of DigestEngine.LOOKUP_CATEGORIES) {
      const entries = graph[cat.key];
      if (!entries?.length) continue;

      for (const entry of entries) {
        const rawName = entry[cat.nameField];
        if (!rawName || typeof rawName !== "string") continue;

        const normalized = rawName.toLowerCase().trim();
        if (!normalized) continue;

        // Resolve source — if entry has _source stamp, use it; otherwise default
        const source = entry._source ?? defaultSource;
        const record = { category: cat.label, entry, source };

        // Store under full normalized name
        addToIndex(normalized, record);

        // Store under each individual word (3+ chars) for partial matching
        const words = normalized.split(/\s+/);
        if (words.length > 1) {
          for (const word of words) {
            if (word.length >= 3) addToIndex(word, record);
          }
        }

        entityCount++;
      }
    }

    this._lookupIndex = index;

    // ── Build reverse indexes: location→NPCs, faction→members ──
    const revLocation = new Map();
    const revFaction = new Map();
    const npcs = graph.npcs ?? [];
    for (const npc of npcs) {
      const source = npc._source ?? defaultSource;
      if (npc.location) {
        const locKey = npc.location.toLowerCase().trim();
        if (!revLocation.has(locKey)) revLocation.set(locKey, []);
        revLocation.get(locKey).push({ entry: npc, source });
      }
      if (npc.faction) {
        const facKey = npc.faction.toLowerCase().trim();
        if (!revFaction.has(facKey)) revFaction.set(facKey, []);
        revFaction.get(facKey).push({ entry: npc, source });
      }
    }
    this._reverseLocationIndex = revLocation;
    this._reverseFactionIndex = revFaction;

    console.debug(`${MODULE_ID} | Lookup index built: ${index.size} keys indexing ${entityCount} entities, ${revLocation.size} locations, ${revFaction.size} factions (reverse)`);
  }

  /** Whether the lookup index is ready for queries. */
  get hasLookupIndex() {
    return this._lookupIndex?.size > 0;
  }

  /** Get the cached world graph. */
  getWorldGraph() {
    return this._worldGraph;
  }

  /**
   * Direct name lookup against the world graph index.
   * @param {string} name - Entity name to look up (e.g., "Clovin Belview", "Abbey of Saint Markovia")
   * @param {Object} [options]
   * @param {string} [options.category] - Filter to category label ("NPC", "Location", "Faction", etc.)
   * @param {number} [options.maxResults=50] - Max entries to return
   * @returns {Array<{category: string, entry: Object, source: string, matchType: "exact"|"partial"}>}
   */
  lookupByName(name, options = {}) {
    if (!name || !this._lookupIndex) return [];
    const { category, maxResults = 50 } = options;

    const normalized = name.toLowerCase().trim();
    if (!normalized) return [];

    const seen = new Set(); // track by category:name to deduplicate
    const results = [];

    const addResult = (record, matchType) => {
      if (category && record.category !== category) return;
      const nameField = DigestEngine.LOOKUP_CATEGORIES.find(c => c.label === record.category)?.nameField ?? "name";
      const key = `${record.category}:${(record.entry[nameField] ?? "").toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ ...record, matchType });
    };

    // 1. Exact full-name match — highest priority
    const exact = this._lookupIndex.get(normalized);
    if (exact) {
      for (const record of exact) addResult(record, "exact");
    }

    // 2. Per-word partial matches (only if input has multiple words or exact didn't find enough)
    const words = normalized.split(/\s+/).filter(w => w.length >= 3);
    for (const word of words) {
      const partial = this._lookupIndex.get(word);
      if (partial) {
        for (const record of partial) addResult(record, "partial");
      }
    }

    // Sort: exact first, then partial; recency boost; then NPC > Location > Faction > rest
    const categoryPriority = { NPC: 0, Location: 1, Faction: 2, Item: 3, Encounter: 4, "Plot Hook": 5, Lore: 6 };
    const recentNames = new Set(this._recentLookups.map(r => r.name.toLowerCase()));
    results.sort((a, b) => {
      if (a.matchType !== b.matchType) return a.matchType === "exact" ? -1 : 1;
      // Recency boost — recently looked-up entities sort higher
      const nameFieldA = DigestEngine.LOOKUP_CATEGORIES.find(c => c.label === a.category)?.nameField ?? "name";
      const nameFieldB = DigestEngine.LOOKUP_CATEGORIES.find(c => c.label === b.category)?.nameField ?? "name";
      const aRecent = recentNames.has((a.entry[nameFieldA] ?? "").toLowerCase());
      const bRecent = recentNames.has((b.entry[nameFieldB] ?? "").toLowerCase());
      if (aRecent !== bRecent) return aRecent ? -1 : 1;
      return (categoryPriority[a.category] ?? 9) - (categoryPriority[b.category] ?? 9);
    });

    // ── Track recent lookups for context memory ──
    if (results.length > 0 && results[0].matchType === "exact") {
      const topHit = results[0];
      this._recentLookups.push({ name: topHit.entry[DigestEngine.LOOKUP_CATEGORIES.find(c => c.label === topHit.category)?.nameField ?? "name"] ?? name, category: topHit.category, timestamp: Date.now() });
      if (this._recentLookups.length > 10) this._recentLookups.shift();
    }

    return results.slice(0, maxResults);
  }

  /**
   * Look up multiple names at once, deduplicating across all results.
   * @param {string[]} names - Array of entity names to look up
   * @param {Object} [options] - Same as lookupByName
   * @returns {Array<{category, entry, source, matchType, queryName}>}
   */
  lookupMultiple(names, options = {}) {
    if (!names?.length || !this._lookupIndex) return [];

    const seen = new Set();
    const results = [];

    for (const name of names) {
      if (!name) continue;
      const hits = this.lookupByName(name, options);
      for (const hit of hits) {
        const nameField = DigestEngine.LOOKUP_CATEGORIES.find(c => c.label === hit.category)?.nameField ?? "name";
        const dedup = `${hit.category}:${(hit.entry[nameField] ?? "").toLowerCase()}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        results.push({ ...hit, queryName: name });
      }
    }

    return results;
  }

  /**
   * Format lookup results into AI-ready context text.
   * @param {Array} results - From lookupByName or lookupMultiple
   * @param {number} [maxChars=4000] - Character budget
   * @returns {{ text: string, charsUsed: number }}
   */
  formatLookupResults(results, maxChars = 4000) {
    if (!results?.length) return { text: "", charsUsed: 0 };

    const header = "── DIRECT LOOKUP (canonical source data) ──\n";
    let text = header;
    let charsUsed = header.length;

    // Group by source for cleaner output
    const bySource = new Map();
    for (const r of results) {
      const src = r.source ?? "Unknown";
      if (!bySource.has(src)) bySource.set(src, []);
      bySource.get(src).push(r);
    }

    for (const [source, entries] of bySource) {
      const srcHeader = `**From: ${source}**\n`;
      if (charsUsed + srcHeader.length > maxChars) break;
      text += srcHeader;
      charsUsed += srcHeader.length;

      for (const { category, entry } of entries) {
        const line = this._formatLookupEntry(category, entry);
        if (charsUsed + line.length > maxChars) break;
        text += line;
        charsUsed += line.length;
      }
      text += "\n";
      charsUsed += 1;
    }

    return { text, charsUsed };
  }

  /**
   * Format a single lookup entry based on its category.
   * @private
   */
  _formatLookupEntry(category, entry) {
    const kl = entry.knowledge_level ? ` {${entry.knowledge_level}}` : "";

    switch (category) {
      case "NPC": {
        const parts = [`**${entry.name}** (${entry.role ?? "?"})`];
        if (entry.faction) parts.push(`[${entry.faction}]`);
        if (entry.notes) parts.push(entry.notes);
        if (entry.location) parts.push(`— ${entry.location}`);
        return `- [NPC]${kl} ${parts.join(" ")}\n`;
      }
      case "Location": {
        const parts = [`**${entry.name}** (${entry.type ?? "location"})`];
        if (entry.parent_location) parts.push(`in ${entry.parent_location}`);
        if (entry.region && entry.region !== entry.parent_location) parts.push(`[${entry.region}]`);
        if (entry.key_details) parts.push(`: ${entry.key_details}`);
        if (entry.encounters) parts.push(`Encounters: ${entry.encounters}`);
        return `- [Location]${kl} ${parts.join(" ")}\n`;
      }
      case "Faction": {
        const parts = [`**${entry.name}**`];
        if (entry.type) parts.push(`(${entry.type})`);
        if (entry.territory) parts.push(`[operates in: ${entry.territory}]`);
        if (entry.goals) parts.push(entry.goals);
        if (entry.allies) parts.push(`Allies: ${entry.allies}`);
        if (entry.enemies) parts.push(`Enemies: ${entry.enemies}`);
        return `- [Faction]${kl} ${parts.join(" ")}\n`;
      }
      case "Item":
        return `- [Item]${kl} **${entry.name}** (${entry.type ?? "item"}): ${entry.description ?? ""}${entry.location ? " — " + entry.location : ""}\n`;
      case "Encounter":
        return `- [Encounter] **${entry.name}**: ${entry.creatures ?? ""} at ${entry.location ?? "unknown"} (${entry.difficulty ?? "?"})\n`;
      case "Plot Hook":
        return `- [Plot]${kl} **${entry.title}**: ${entry.description ?? ""}${entry.trigger ? " Trigger: " + entry.trigger : ""}\n`;
      case "Lore":
        return `- [Lore]${kl} **${entry.topic}**: ${entry.details ?? ""}\n`;
      default:
        return `- [${category}] ${JSON.stringify(entry)}\n`;
    }
  }

  // ── Reverse Index Queries (Enhancement 2) ────────────────

  /** Get all NPCs at a given location name. */
  getNPCsAtLocation(locationName) {
    if (!locationName) return [];
    return this._reverseLocationIndex.get(locationName.toLowerCase().trim()) ?? [];
  }

  /** Get all NPC members of a given faction name. */
  getFactionMembers(factionName) {
    if (!factionName) return [];
    return this._reverseFactionIndex.get(factionName.toLowerCase().trim()) ?? [];
  }

  // ── Recent Context Memory (Enhancement 4) ──────────────

  /** Get formatted context of recently looked-up entities. */
  getRecentContext(maxChars = 1000) {
    if (!this._recentLookups.length) return { text: "", names: [] };
    const names = this._recentLookups.map(r => r.name);
    const results = this.lookupMultiple([...new Set(names)], { maxResults: 10 });
    if (!results.length) return { text: "", names };
    const formatted = this.formatLookupResults(results, maxChars);
    return { text: formatted.text, names, charsUsed: formatted.charsUsed };
  }

  /** Get recent lookup names (for injecting into query name extraction). */
  getRecentNames() {
    return this._recentLookups.map(r => r.name);
  }

  // ── Connected Entity Pulling (Enhancement 1) ────────────

  /**
   * Look up an entity by name AND pull all connected entities.
   * For NPCs: follows location → Location entry, faction → Faction entry
   * For Locations: pulls NPCs at this location (reverse index)
   * For Factions: pulls faction members (reverse index)
   * @param {string} name
   * @param {Object} [options] - Same as lookupByName plus:
   * @param {number} [options.maxConnected=5] - Max connected entities per primary result
   * @param {boolean} [options.includeEnvoy=true] - Include Envoy conversation history
   * @returns {{primary: Array, connected: Array, envoyContext: string}}
   */
  lookupWithConnections(name, options = {}) {
    const { maxConnected = 5, includeEnvoy = true, ...lookupOpts } = options;
    const primary = this.lookupByName(name, lookupOpts);
    if (!primary.length) return { primary: [], connected: [], envoyContext: "" };

    const connected = [];
    const seen = new Set(primary.map(r => `${r.category}:${(r.entry.name ?? r.entry.topic ?? r.entry.title ?? "").toLowerCase()}`));

    const addConnected = (results) => {
      for (const r of results) {
        const key = `${r.category}:${(r.entry.name ?? r.entry.topic ?? r.entry.title ?? "").toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        connected.push(r);
        if (connected.length >= maxConnected * primary.length) return;
      }
    };

    for (const p of primary) {
      if (p.category === "NPC") {
        // Follow NPC → Location
        if (p.entry.location) {
          addConnected(this.lookupByName(p.entry.location, { category: "Location", maxResults: 2 }));
          // Also pull other NPCs at that location
          const colocated = this.getNPCsAtLocation(p.entry.location);
          addConnected(colocated.filter(c => c.entry.name !== p.entry.name).slice(0, 3).map(c => ({
            category: "NPC", entry: c.entry, source: c.source, matchType: "connected"
          })));
        }
        // Follow NPC → Faction
        if (p.entry.faction) {
          addConnected(this.lookupByName(p.entry.faction, { category: "Faction", maxResults: 2 }));
        }
      } else if (p.category === "Location") {
        // Pull NPCs at this location
        const npcsHere = this.getNPCsAtLocation(p.entry.name);
        addConnected(npcsHere.slice(0, maxConnected).map(c => ({
          category: "NPC", entry: c.entry, source: c.source, matchType: "connected"
        })));
      } else if (p.category === "Faction") {
        // Pull faction members
        const members = this.getFactionMembers(p.entry.name);
        addConnected(members.slice(0, maxConnected).map(c => ({
          category: "NPC", entry: c.entry, source: c.source, matchType: "connected"
        })));
      }
    }

    // Enhancement 5: Envoy conversation history
    let envoyContext = "";
    if (includeEnvoy) {
      for (const p of primary) {
        if (p.category === "NPC" && p.entry.name) {
          envoyContext += this._getEnvoyContext(p.entry.name);
        }
      }
    }

    return { primary, connected, envoyContext };
  }

  /**
   * Format connection results (primary + connected + envoy) into AI context.
   * @param {{primary, connected, envoyContext}} result - From lookupWithConnections
   * @param {number} [maxChars=4000]
   * @returns {{ text: string, charsUsed: number }}
   */
  formatConnectionResults(result, maxChars = 4000) {
    if (!result?.primary?.length) return { text: "", charsUsed: 0 };

    // Budget: 70% primary, 20% connected, 10% envoy
    const primaryBudget = Math.floor(maxChars * 0.70);
    const connectedBudget = Math.floor(maxChars * 0.20);
    const envoyBudget = Math.floor(maxChars * 0.10);

    const primaryFmt = this.formatLookupResults(result.primary, primaryBudget);
    let text = primaryFmt.text;
    let charsUsed = primaryFmt.charsUsed;

    // Connected entities
    if (result.connected.length > 0) {
      const connHeader = "\n── CONNECTED ENTITIES ──\n";
      const connFmt = this.formatLookupResults(result.connected, connectedBudget - connHeader.length);
      if (connFmt.charsUsed > 0) {
        text += connHeader + connFmt.text;
        charsUsed += connHeader.length + connFmt.charsUsed;
      }
    }

    // Envoy conversation history
    if (result.envoyContext) {
      const remaining = maxChars - charsUsed;
      const envoyTrimmed = result.envoyContext.slice(0, Math.min(remaining, envoyBudget));
      if (envoyTrimmed.length > 10) {
        text += "\n── LAST CONVERSATION ──\n" + envoyTrimmed + "\n";
        charsUsed += envoyTrimmed.length + 25;
      }
    }

    return { text, charsUsed };
  }

  // ── Envoy Integration (Enhancement 5) ──────────────────

  /**
   * Get conversation history from ACE Envoy for an NPC.
   * Graceful fallback if Envoy not installed.
   * @private
   */
  _getEnvoyContext(npcName) {
    try {
      const envoy = game.modules.get("ace-envoy");
      if (!envoy?.active || !envoy.api) return "";
      const memory = envoy.api.getConversationMemory?.(npcName);
      if (!memory || typeof memory !== "string" || memory.length < 10) return "";
      return memory;
    } catch (err) {
      console.warn(`${MODULE_ID} | Envoy context fetch failed for ${npcName}:`, err.message);
      return "";
    }
  }

  /** Get index statistics for debugging. */
  getIndexStats() {
    return {
      lookupKeys: this._lookupIndex?.size ?? 0,
      locations: this._reverseLocationIndex.size,
      factions: this._reverseFactionIndex.size,
      recentLookups: this._recentLookups.length,
    };
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
  buildDigestContext(activeDigestIds, queryKeywords, maxChars, intent = "general") {
    if (!activeDigestIds?.length || !queryKeywords?.length) return { text: "", charsUsed: 0 };

    const querySet = new Set(queryKeywords.map(k => k.toLowerCase()));
    const MIN_SCORE = 2;   // Require at least 2 keyword hits to include an entry
    const MAX_ENTRIES = 25; // Hard cap on total entries sent to AI

    // Phase 4: Intent-aware category priorities
    // Higher multiplier = more likely to be included for this intent
    const categoryBoosts = {
      room:      { Location: 2.0, Encounter: 1.5, NPC: 1.0, Item: 1.0, Lore: 0.5, Faction: 0.5, Plot: 0.3 },
      npc:       { NPC: 2.5, Faction: 1.5, Location: 1.0, Lore: 1.0, Plot: 0.8, Encounter: 0.5, Item: 0.3 },
      encounter: { Encounter: 2.5, NPC: 1.5, Location: 1.0, Item: 1.0, Lore: 0.5, Faction: 0.5, Plot: 0.3 },
      tactical:  { Encounter: 2.0, NPC: 1.5, Item: 1.0, Location: 0.8, Lore: 0.3, Faction: 0.3, Plot: 0.3 },
      treasure:  { Item: 2.5, Location: 1.0, Encounter: 1.0, NPC: 0.5, Lore: 0.5, Faction: 0.3, Plot: 0.3 },
      lore:      { Lore: 2.5, Faction: 2.0, NPC: 1.5, Location: 1.0, Plot: 1.5, Encounter: 0.5, Item: 0.5 },
      general:   { NPC: 1.0, Location: 1.0, Encounter: 1.0, Item: 1.0, Lore: 1.0, Faction: 1.0, Plot: 1.0 },
      floor:     { Location: 2.0, Encounter: 1.5, NPC: 1.0, Item: 0.8, Lore: 0.5, Faction: 0.3, Plot: 0.3 },
      rules:     { Lore: 1.5, Item: 1.0, Encounter: 1.0, NPC: 0.5, Location: 0.3, Faction: 0.3, Plot: 0.3 },
    };
    const boosts = categoryBoosts[intent] ?? categoryBoosts.general;

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

      // Phase 4: Apply intent-aware category boosts to sort order
      for (const m of matches) {
        m.boostedScore = m.score * (boosts[m.type] ?? 1.0);
      }

      // Sort by boosted score descending, then hard-cap
      matches.sort((a, b) => b.boostedScore - a.boostedScore);
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

  // ── Digest Backup ──────────────────────────────────────────
  // Creates a timestamped backup of all digest files + index.
  // Called by the MemoryManager's autoBackup cycle to protect
  // AI-generated digest data that costs real API tokens.

  /**
   * Back up all digest files to a timestamped backup folder.
   * Keeps a rotating set of backups (default 5) to avoid unbounded growth.
   * Each backup is a single combined JSON file containing the index + all digest data.
   *
   * @param {number} maxBackups - How many backup files to keep (default 5)
   */
  async backupDigests(maxBackups = 5) {
    await this.ensureGlobalDirectory();

    const BACKUP_DIR = "ace-engine-library/digest-backups";
    try {
      await _FP().createDirectory("data", BACKUP_DIR);
    } catch (e) {
      if (!e.message?.includes("EEXIST") && !e.message?.includes("already exists")) {
        console.warn(`${MODULE_ID} | Could not create digest-backups/:`, e.message);
        return;
      }
    }

    // Collect all digest data into a single backup bundle
    const digestIds = Object.keys(this._index?.digests ?? {});
    if (digestIds.length === 0) {
      console.log(`${MODULE_ID} | Digest backup skipped — no digests to back up.`);
      return;
    }

    const bundle = {
      _backup: {
        module:     MODULE_ID,
        type:       "digest-backup",
        createdAt:  new Date().toISOString(),
        digestCount: digestIds.length,
      },
      index: this._index,
      digests: {},
    };

    // Load each digest and add to bundle
    for (const id of digestIds) {
      try {
        const data = await this.loadDigest(id);
        if (data) bundle.digests[id] = data;
      } catch { /* skip corrupt digests */ }
    }

    // Save as a single timestamped file
    const ts = new Date().toISOString().replace(/:/g, "-");
    const fileName = `digest-backup.${ts}.json`;
    const payload = JSON.stringify(bundle, null, 0); // compact to save space
    const file = new File([payload], fileName, { type: "application/json" });

    try {
      await _silentUpload("data", BACKUP_DIR, file);
      // Demoted from log to debug — runs every 30 min, was spamming console.
      console.debug(`${MODULE_ID} | Digest backup created: ${fileName} ` +
        `(${digestIds.length} digests, ${(payload.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.error(`${MODULE_ID} | Digest backup failed:`, err);
      return;
    }

    // Prune old backups — keep only the newest maxBackups
    try {
      const listing = await _FP().browse("data", BACKUP_DIR);
      const backupFiles = (listing?.files ?? [])
        .filter(f => f.split("/").pop().startsWith("digest-backup."))
        .sort(); // ISO timestamps sort chronologically

      if (backupFiles.length > maxBackups) {
        const toDelete = backupFiles.slice(0, backupFiles.length - maxBackups);
        for (const filePath of toDelete) {
          // Foundry has no file delete API — overwrite with tiny tombstone
          const oldName = filePath.split("/").pop();
          const tombstone = new File(['{"pruned":true}'], oldName, { type: "application/json" });
          await _silentUpload("data", BACKUP_DIR, tombstone);
        }
        console.debug(`${MODULE_ID} | Pruned ${toDelete.length} old digest backup(s), keeping ${maxBackups}.`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Digest backup pruning failed:`, err);
    }
  }

  /**
   * Restore digests from a backup file.
   * Reads the bundle, writes each digest file back + updates the index.
   * @param {Object} bundle - Parsed backup bundle JSON
   * @returns {{ ok: boolean, restored: number, message: string }}
   */
  async restoreFromBackup(bundle) {
    if (!bundle?._backup?.type || bundle._backup.type !== "digest-backup") {
      return { ok: false, restored: 0, message: "Invalid backup format." };
    }

    await this.ensureGlobalDirectory();
    let restored = 0;

    // Restore index
    if (bundle.index) {
      this._index = bundle.index;
      await this.saveIndex();
    }

    // Restore each digest
    for (const [id, data] of Object.entries(bundle.digests ?? {})) {
      try {
        await this.saveDigest(id, data);
        restored++;
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to restore digest ${id}:`, err);
      }
    }

    console.log(`${MODULE_ID} | Restored ${restored} digests from backup.`);
    return { ok: true, restored, message: `Restored ${restored} digests.` };
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
    let graph = null;
    try {
      const resp = await fetch("ace-engine-library/world-graph.json", { cache: "no-store" });
      if (resp.ok) graph = await resp.json();
    } catch (_) { /* not found */ }

    // Try backup
    if (!graph) {
      try {
        const resp = await fetch("ace-engine-library/world-graph-backup.json", { cache: "no-store" });
        if (resp.ok) {
          console.warn(`${MODULE_ID} | Loaded world graph from backup`);
          graph = await resp.json();
        }
      } catch (_) { /* no backup either */ }
    }

    // Cache and build lookup index
    if (graph) {
      this._worldGraph = graph;
      this.buildLookupIndex(graph);
    }

    return graph;
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

    // Rebuild lookup index from new graph
    this._worldGraph = graph;
    this.buildLookupIndex(graph);

    return graph;
  }
}
