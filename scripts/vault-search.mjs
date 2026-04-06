// ============================================================
// ACE — AI Campaign Engine — Vault Search
// Cross-campaign search across archived world snapshots.
//
// Searches ace-engine-vault/*/latest/ store files to answer
// questions like "who got that crit on the mummy 4 years ago?"
// ============================================================

const MODULE_ID  = "ace-engine";
const VAULT_ROOT = "ace-engine-vault";

// v13-safe FilePicker access (same pattern as vault-engine.mjs)
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ??
  globalThis.FilePicker;

// ── VaultSearch ────────────────────────────────────────────

export class VaultSearch {

  constructor() {
    /** @type {Map<string, Object>} worldId → { manifest, stores } */
    this._cache = new Map();
    /** @type {string|null} current world ID (excluded from cross-campaign results) */
    this._currentWorldId = game.world?.id ?? null;
    /** @type {Array|null} cached world discovery results */
    this._discoveryCache = null;
  }

  // ── Discovery ──────────────────────────────────────────────

  /**
   * Scan the vault root for archived worlds.
   * @returns {Promise<Array<{worldId: string, manifest: Object}>>}
   */
  async discoverWorlds() {
    // Return cached results after first successful discovery
    if (this._discoveryCache) return this._discoveryCache;

    try {
      const result = await _FP().browse("data", VAULT_ROOT);
      const worldDirs = (result.dirs ?? [])
        .map(d => d.split("/").pop())
        .filter(Boolean);

      const worlds = [];
      for (const wid of worldDirs) {
        // Skip current world — live data is already in context
        if (wid === this._currentWorldId) continue;

        const manifest = await this._loadManifest(wid);
        if (manifest) worlds.push({ worldId: wid, manifest });
      }
      this._discoveryCache = worlds;
      return worlds;
    } catch (err) {
      console.warn("ace-engine | VaultSearch world discovery failed:", err);
      // Vault root doesn't exist yet — no archived worlds
      return [];
    }
  }

  /**
   * Load a world's vault-manifest.json.
   * @param {string} worldId
   * @returns {Promise<Object|null>}
   */
  async _loadManifest(worldId) {
    try {
      const res = await fetch(`${VAULT_ROOT}/${worldId}/latest/vault-manifest.json`);
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      console.warn("ace-engine | VaultSearch manifest load failed:", err);
      return null;
    }
  }

  // ── Store Loading (lazy, cached) ───────────────────────────

  /**
   * Get cached store data for a world, loading from vault if needed.
   * @param {string} worldId
   * @returns {Promise<Object>} { manifest, deeds, npcs, pcs, history, world, scenes, items }
   */
  async _getWorldData(worldId) {
    if (this._cache.has(worldId)) return this._cache.get(worldId);

    const base = `${VAULT_ROOT}/${worldId}/latest`;
    const manifest = await this._loadManifest(worldId);
    if (!manifest) return null;

    const data = { manifest, deeds: [], npcs: {}, pcs: {}, events: [], sessions: [], scenes: {} };

    // Load each store file — silent failures for missing stores
    const loads = [
      { key: "deeds",    file: "ace-deeds.json",   extract: d => d?.deeds ?? [] },
      { key: "npcs",     file: "ace-npcs.json",    extract: d => d?.npcs ?? {} },
      { key: "pcs",      file: "ace-pcs.json",     extract: d => d?.pcs ?? {} },
      { key: "events",   file: "ace-history.json",  extract: d => d?.events ?? [] },
      { key: "sessions", file: "ace-world.json",    extract: d => d?.sessions ?? [] },
      { key: "scenes",   file: "ace-scenes.json",   extract: d => d?.scenes ?? {} },
    ];

    for (const { key, file, extract } of loads) {
      try {
        const res = await fetch(`${base}/${file}`);
        if (res.ok) {
          const json = await res.json();
          data[key] = extract(json);
        }
      } catch (err) { console.debug("ace-engine | VaultSearch store load skipped:", err); }
    }

    this._cache.set(worldId, data);
    return data;
  }

  // ── Search ────────────────────────────────────────────────

  /**
   * Search across all archived campaigns.
   * @param {string} query - Natural language search query
   * @param {Object} [opts]
   * @param {string[]} [opts.categories] - Limit to specific store types: "deeds", "npcs", "pcs", "events", "sessions"
   * @param {number} [opts.maxResults=15] - Max results total
   * @returns {Promise<Array<{worldName: string, worldId: string, category: string, text: string, score: number}>>}
   */
  async search(query, { categories, maxResults = 15 } = {}) {
    if (!query?.trim()) return [];

    const worlds = await this.discoverWorlds();
    if (!worlds.length) return [];

    const terms = this._tokenize(query);
    if (!terms.length) return [];

    const allHits = [];

    for (const { worldId, manifest } of worlds) {
      const data = await this._getWorldData(worldId);
      if (!data) continue;

      const worldName = manifest.worldName ?? worldId;

      // Search deeds
      if (!categories || categories.includes("deeds")) {
        for (const deed of (data.deeds ?? [])) {
          const score = this._scoreText(terms, deed.text ?? "");
          if (score > 0) {
            allHits.push({
              worldName, worldId,
              category: "deed",
              text: `[${deed.magnitude ?? "minor"}] ${deed.text}${deed.session ? ` (Session ${deed.session})` : ""}`,
              score: score * (deed.magnitude === "legendary" ? 2.0 : deed.magnitude === "major" ? 1.5 : 1.0),
            });
          }
        }
      }

      // Search NPCs
      if (!categories || categories.includes("npcs")) {
        for (const [key, npc] of Object.entries(data.npcs ?? {})) {
          const nameScore = this._scoreText(terms, npc.displayName ?? key);
          const noteScore = Math.max(...(npc.notes ?? []).map(n => this._scoreText(terms, n.txt ?? n)), 0);
          const score = Math.max(nameScore * 2, noteScore);
          if (score > 0) {
            allHits.push({
              worldName, worldId,
              category: "npc",
              text: `**${npc.displayName ?? key}** — met ${npc.met ?? 0}x${npc.killed ? " [KILLED]" : ""}` +
                    `${(npc.scenes ?? []).length ? `, scenes: ${npc.scenes.slice(0, 3).join(", ")}` : ""}`,
              score,
            });
          }
        }
      }

      // Search PCs
      if (!categories || categories.includes("pcs")) {
        for (const [key, pc] of Object.entries(data.pcs ?? {})) {
          const score = this._scoreText(terms, `${pc.displayName ?? key} ${pc.class ?? ""} ${pc.race ?? ""}`);
          if (score > 0) {
            allHits.push({
              worldName, worldId,
              category: "pc",
              text: `**${pc.displayName ?? key}** (${pc.class ?? "?"} L${pc.level ?? "?"}) — ` +
                    `${pc.kills ?? 0} kills, ${pc.crits ?? 0} crits, ${pc.sessions ?? 0} sessions`,
              score: score * 1.5,  // boost PC matches — likely what cross-campaign queries want
            });
          }
        }
      }

      // Search events (crits, kills, fumbles)
      if (!categories || categories.includes("events")) {
        for (const evt of (data.events ?? [])) {
          const evtText = `${evt.type ?? ""} ${evt.actor ?? ""} ${evt.target ?? ""} ${evt.text ?? ""} ${evt.weapon ?? ""}`;
          const score = this._scoreText(terms, evtText);
          if (score > 0) {
            allHits.push({
              worldName, worldId,
              category: "event",
              text: `[${evt.type}] ${evt.actor ?? "Unknown"}${evt.target ? ` vs ${evt.target}` : ""}` +
                    `${evt.weapon ? ` (${evt.weapon})` : ""}${evt.text ? `: ${evt.text}` : ""}`,
              score,
            });
          }
        }
      }

      // Search session summaries
      if (!categories || categories.includes("sessions")) {
        for (const sess of (data.sessions ?? [])) {
          const score = this._scoreText(terms, sess.summary ?? "");
          if (score > 0) {
            allHits.push({
              worldName, worldId,
              category: "session",
              text: `Session ${sess.num ?? "?"} (${sess.date ?? "?"}): ${(sess.summary ?? "").slice(0, 200)}`,
              score,
            });
          }
        }
      }
    }

    // Sort by score descending, take top N
    allHits.sort((a, b) => b.score - a.score);
    return allHits.slice(0, maxResults);
  }

  /**
   * Build a compact context string from cross-campaign search results.
   * Suitable for injection into AI system prompt.
   * @param {string} query
   * @param {number} [maxChars=600]
   * @returns {Promise<string>}
   */
  async buildCrossWorldContext(query, maxChars = 600) {
    const hits = await this.search(query, { maxResults: 10 });
    if (!hits.length) return "";

    let ctx = "### Cross-Campaign Memory (data from PAST campaigns, not this one)\n";
    ctx += "Format: [Campaign Name] → category: details\n";
    let used = ctx.length;

    for (const hit of hits) {
      // Use explicit "Campaign:" label so the AI can't confuse world names with NPC names
      const line = `- Campaign: "${hit.worldName}" → ${hit.category}: ${hit.text}\n`;
      if (used + line.length > maxChars) break;
      ctx += line;
      used += line.length;
    }

    return used > 70 ? ctx : "";
  }

  // ── Tokenizer & Scorer ────────────────────────────────────

  /**
   * Simple keyword tokenizer — lowercase, strip punctuation, filter stopwords.
   * @param {string} text
   * @returns {string[]}
   */
  _tokenize(text) {
    if (!text) return [];
    const stopwords = new Set([
      "the", "a", "an", "is", "was", "were", "are", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "shall", "can", "need", "dare", "ought",
      "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
      "into", "through", "during", "before", "after", "above", "below",
      "between", "out", "off", "over", "under", "again", "further",
      "then", "once", "that", "this", "these", "those", "who", "what",
      "which", "when", "where", "how", "not", "no", "nor", "and", "but",
      "or", "so", "if", "it", "its", "my", "your", "his", "her", "our",
      "their", "me", "him", "them", "i", "you", "he", "she", "we", "they",
    ]);
    return text
      .toLowerCase()
      .replace(/[^\w\s'-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopwords.has(w));
  }

  /**
   * Simple term-frequency scoring: count how many query terms appear in text.
   * Returns 0 if no match.
   * @param {string[]} queryTerms
   * @param {string} text
   * @returns {number}
   */
  _scoreText(queryTerms, text) {
    if (!text || !queryTerms.length) return 0;
    const lower = text.toLowerCase();
    let hits = 0;
    for (const term of queryTerms) {
      if (lower.includes(term)) hits++;
    }
    // Normalize by query length so longer queries don't auto-score higher
    return hits / queryTerms.length;
  }

  // ── Cache Management ───────────────────────────────────────

  /** Clear all cached world data (e.g., when a new snapshot is created). */
  clearCache() {
    this._cache.clear();
    this._discoveryCache = null;
  }
}
