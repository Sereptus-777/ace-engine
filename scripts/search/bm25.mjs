// ============================================================
// ACE — AI Campaign Engine — BM25 Search Engine
// Implements Okapi BM25 ranking for document chunk retrieval.
// Replaces the legacy keyword-overlap scorer with proper
// term frequency / inverse document frequency weighting.
// ============================================================

// ── Stop Words ───────────────────────────────────────────────
// Generic English stop words — but D&D-critical terms are KEPT.
// "floor", "room", "area", "level", "chapter" are NOT here.

const STOP_WORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being",
  "have","has","had","do","does","did","will","would","could",
  "should","may","might","shall","can","this","that","these",
  "those","it","its","of","in","to","for","with","on","at",
  "by","from","as","or","and","but","not","no","nor","so",
  "yet","both","each","every","all","any","few","more","most",
  "other","some","such","than","too","very","just","also",
  "about","after","before","between","into","through","during",
  "above","below","then","once","here","there","when","where",
  "why","how","what","which","who","whom","they","them","their",
  "your","you","our","his","her","she","him","we",
  "over","under","again","further","same","own",
  "tell","me","please","know","think","want","need","like",
  "really","actually","basically","something","anything",
  "going","get","got","make","take","give","let","try",
  "using","used","use","able","much","many",
]);

// Words that should NEVER be stripped (D&D-critical terms)
const KEEP_WORDS = new Set([
  // Structure
  "floor","room","area","level","chapter","section","dungeon",
  "tower","crypt","vault","chamber","hall","cellar","basement",
  "passage","corridor","tunnel","cave","lair","den","tomb",
  // Game terms
  "trap","treasure","loot","hoard","encounter","combat",
  "attack","damage","hit","save","check","roll","spell",
  "action","reaction","bonus","legendary","lair",
  "armor","weapon","shield","potion","scroll","wand",
  "ring","amulet","cloak","staff","rod",
  // Creature types
  "undead","fiend","dragon","beast","construct","elemental",
  "fey","celestial","aberration","monstrosity","humanoid",
  "giant","ooze","plant",
  // Common D&D nouns that matter
  "door","gate","bridge","wall","stairs","ladder","window",
  "altar","throne","statue","fountain","pool","pit","cliff",
  "forest","mountain","river","lake","sea","ocean","island",
  "village","town","city","castle","keep","fort","temple",
  "tavern","inn","shop","market","guild","church","shrine",
  "north","south","east","west",
]);


// ── Tokenizer ────────────────────────────────────────────────

/**
 * Tokenize text into searchable terms.
 * Preserves D&D-critical words, removes generic stop words.
 * @param {string} text
 * @param {Object} [opts]
 * @param {boolean} [opts.keepStopWords=false] - If true, returns ALL words (for term freq counting)
 * @param {boolean} [opts.preserveCase=false] - If true, keeps original casing
 * @returns {string[]}
 */
export function tokenize(text, opts = {}) {
  const { keepStopWords = false, preserveCase = false } = opts;

  let processed = preserveCase ? text : text.toLowerCase();

  // Replace non-alphanumeric (keep apostrophes, hyphens, periods for abbreviations)
  processed = processed.replace(/[^a-z0-9\s'''\-./+]/gi, " ");

  // Split on whitespace
  const words = processed.split(/\s+/).filter(w => w.length > 0);

  if (keepStopWords) return words;

  // Filter stop words but keep D&D-critical terms
  return words.filter(w => {
    const lower = w.toLowerCase();
    if (lower.length <= 1) return false;
    if (KEEP_WORDS.has(lower)) return true;
    if (STOP_WORDS.has(lower)) return false;
    return lower.length > 1;
  });
}

/**
 * Count term frequencies in a text string.
 * @param {string} text
 * @returns {{ terms: Object<string, number>, length: number }}
 */
export function countTerms(text) {
  const tokens = tokenize(text);
  const terms = {};
  for (const t of tokens) {
    terms[t] = (terms[t] || 0) + 1;
  }
  return { terms, length: tokens.length };
}


// ── BM25 Engine ──────────────────────────────────────────────

export class BM25 {
  /**
   * @param {number} [k1=1.2] - Term frequency saturation parameter.
   *   Higher = more weight to repeated terms. 1.2–2.0 typical.
   * @param {number} [b=0.75] - Length normalization parameter.
   *   0 = no normalization, 1 = full normalization. 0.75 typical.
   */
  constructor(k1 = 1.2, b = 0.75) {
    this.k1 = k1;
    this.b  = b;

    // Corpus statistics
    this._totalDocs     = 0;
    this._avgDocLength  = 0;
    this._docFreqs      = {};  // term → number of docs containing it
    this._documents     = [];  // [{id, termFreqs, length, meta}]
    this._ready         = false;
  }

  // ── Corpus Management ────────────────────────────────────

  /**
   * Build the full corpus index from a list of documents.
   * Call after document uploads, deletes, or enable/disable changes.
   *
   * @param {Array<{id: string, termFreqs: Object<string,number>, length: number, meta?: Object}>} documents
   *   Each document needs: id, pre-computed termFreqs, and term count (length).
   *   meta is optional pass-through data (docId, heading, page, etc.)
   */
  buildCorpus(documents) {
    this._documents = documents;
    this._totalDocs = documents.length;

    // Compute average document length
    let totalLength = 0;
    for (const doc of documents) totalLength += doc.length;
    this._avgDocLength = this._totalDocs > 0 ? totalLength / this._totalDocs : 1;

    // Compute document frequencies (how many docs contain each term)
    this._docFreqs = {};
    for (const doc of documents) {
      for (const term of Object.keys(doc.termFreqs)) {
        this._docFreqs[term] = (this._docFreqs[term] || 0) + 1;
      }
    }

    this._ready = true;
    console.debug(`ACE BM25 | Corpus built: ${this._totalDocs} documents, ${Object.keys(this._docFreqs).length} unique terms, avg length ${Math.round(this._avgDocLength)}`);
  }

  /**
   * Add a single document to the corpus incrementally.
   * More efficient than full rebuild for single additions.
   * @param {{id: string, termFreqs: Object<string,number>, length: number, meta?: Object}} doc
   */
  addDocument(doc) {
    this._documents.push(doc);
    this._totalDocs++;

    // Update average length incrementally
    this._avgDocLength = ((this._avgDocLength * (this._totalDocs - 1)) + doc.length) / this._totalDocs;

    // Update document frequencies
    for (const term of Object.keys(doc.termFreqs)) {
      this._docFreqs[term] = (this._docFreqs[term] || 0) + 1;
    }
  }

  /**
   * Remove a document from the corpus.
   * @param {string} docId
   */
  removeDocument(docId) {
    const idx = this._documents.findIndex(d => d.id === docId);
    if (idx === -1) return;

    const doc = this._documents[idx];

    // Update document frequencies
    for (const term of Object.keys(doc.termFreqs)) {
      this._docFreqs[term] = Math.max(0, (this._docFreqs[term] || 0) - 1);
      if (this._docFreqs[term] === 0) delete this._docFreqs[term];
    }

    // Remove and update stats
    this._documents.splice(idx, 1);
    this._totalDocs = Math.max(0, this._totalDocs - 1);
    if (this._totalDocs > 0) {
      this._avgDocLength = ((this._avgDocLength * (this._totalDocs + 1)) - doc.length) / this._totalDocs;
    } else {
      this._avgDocLength = 0;
    }
  }

  // ── Scoring ──────────────────────────────────────────────

  /**
   * Compute IDF (Inverse Document Frequency) for a term.
   * Uses the Robertson–Spärck Jones formula with +1 smoothing.
   * @param {string} term
   * @returns {number}
   */
  idf(term) {
    const df = this._docFreqs[term] || 0;
    const N  = this._totalDocs;
    // ln((N - df + 0.5) / (df + 0.5) + 1)
    return Math.log(((N - df + 0.5) / (df + 0.5)) + 1);
  }

  /**
   * Score a single document against query terms.
   * @param {string[]} queryTerms - Tokenized query
   * @param {Object<string,number>} docTermFreqs - Term frequencies for this document
   * @param {number} docLength - Total terms in this document
   * @returns {number} BM25 score (higher = more relevant)
   */
  score(queryTerms, docTermFreqs, docLength) {
    let totalScore = 0;

    for (const term of queryTerms) {
      const tf  = docTermFreqs[term] || 0;
      if (tf === 0) continue;

      const termIdf = this.idf(term);

      // BM25 term score with saturation and length normalization
      const numerator   = tf * (this.k1 + 1);
      const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / this._avgDocLength));
      totalScore += termIdf * (numerator / denominator);
    }

    return totalScore;
  }

  // ── Search ───────────────────────────────────────────────

  /**
   * Search the corpus and return ranked results.
   * @param {string|string[]} query - Raw query string or pre-tokenized terms
   * @param {Object} [opts]
   * @param {number} [opts.maxResults=25] - Max results to return
   * @param {number} [opts.minScore=0.1] - Minimum BM25 score to include
   * @param {Object<string, number>} [opts.boosts] - Per-field boost multipliers
   * @returns {Array<{id: string, score: number, meta: Object}>}
   */
  search(query, opts = {}) {
    const { maxResults = 25, minScore = 0.1, boosts, roomIds } = opts;

    if (!this._ready || this._totalDocs === 0) return [];

    const queryTerms = Array.isArray(query) ? query : tokenize(query);
    if (!queryTerms.length) return [];

    // Normalize requested room IDs for matching (e.g. "K17" → "k17")
    const roomSet = roomIds?.length
      ? new Set(roomIds.map(r => r.toLowerCase().replace(/\s+/g, "")))
      : null;

    const results = [];

    for (const doc of this._documents) {
      let s = this.score(queryTerms, doc.termFreqs, doc.length);

      // ── Room ID boost (strongest signal) ──
      // When the user asks about a specific room (K15, Area 12, etc.),
      // chunks whose roomId matches get a massive boost so the actual
      // room description always outranks cross-references from other sections.
      if (roomSet && doc.meta?.roomId) {
        const normalizedRoomId = doc.meta.roomId.toLowerCase().replace(/\s+/g, "");
        if (roomSet.has(normalizedRoomId)) {
          s *= 5.0;  // 5x boost for exact room match
        }
      }

      // Apply heading boost: if query terms appear in the heading, boost score
      if (doc.meta?.headingTerms) {
        let headingHits = 0;
        for (const qt of queryTerms) {
          if (doc.meta.headingTerms[qt]) headingHits++;
        }
        if (headingHits > 0) {
          s *= (1 + 0.3 * headingHits); // 30% boost per heading term match
        }
      }

      // Apply tag boost: if query terms match curated tags, boost
      if (doc.meta?.tags) {
        let tagHits = 0;
        for (const qt of queryTerms) {
          if (doc.meta.tags.includes(qt)) tagHits++;
        }
        if (tagHits > 0) {
          s *= (1 + 0.2 * tagHits); // 20% boost per tag match
        }
      }

      // Apply custom boosts (e.g., boost room-type chunks for room queries)
      if (boosts && doc.meta?.sectionType) {
        const mult = boosts[doc.meta.sectionType];
        if (mult) s *= mult;
      }

      if (s >= minScore) {
        results.push({ id: doc.id, score: s, meta: doc.meta });
      }
    }

    // Sort by score descending, return top N
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  // ── Persistence ──────────────────────────────────────────

  /**
   * Export corpus statistics for persistence (avoid full rebuild on load).
   * @returns {{ totalDocs: number, avgDocLength: number, docFreqs: Object }}
   */
  getStats() {
    return {
      totalDocs:    this._totalDocs,
      avgDocLength: this._avgDocLength,
      docFreqs:     { ...this._docFreqs },
    };
  }

  /**
   * Load persisted corpus statistics.
   * Documents array must still be loaded separately via buildCorpus() or addDocument().
   * This just pre-seeds the global stats to avoid recomputation.
   * @param {{ totalDocs: number, avgDocLength: number, docFreqs: Object }} stats
   */
  loadStats(stats) {
    if (!stats) return;
    this._totalDocs    = stats.totalDocs    ?? 0;
    this._avgDocLength = stats.avgDocLength ?? 1;
    this._docFreqs     = stats.docFreqs     ?? {};
  }

  /** @returns {boolean} Whether the corpus has been built */
  get ready() { return this._ready; }

  /** @returns {number} Total documents in corpus */
  get size() { return this._totalDocs; }
}


// ── Reciprocal Rank Fusion ───────────────────────────────────
// Merge results from multiple rankers into a single ranked list.
// Standard constant k=60 (as per the original RRF paper).

/**
 * Fuse multiple ranked result lists using Reciprocal Rank Fusion.
 * Each input list should be sorted by score descending.
 *
 * @param {Array<Array<{id: string, score: number, [key: string]: any}>>} rankedLists
 *   Array of ranked result lists from different search methods.
 * @param {number[]} [weights] - Optional weight per list (e.g., [1.0, 0.8, 1.2]).
 *   Defaults to equal weight (1.0) for all lists.
 * @param {number} [k=60] - RRF smoothing constant.
 * @returns {Array<{id: string, rrfScore: number, sources: Object}>}
 */
export function reciprocalRankFusion(rankedLists, weights = null, k = 60) {
  const scoreMap = {};  // id → { rrfScore, sources, bestMeta }

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const list   = rankedLists[listIdx];
    const weight = weights?.[listIdx] ?? 1.0;

    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const id   = item.id;

      if (!scoreMap[id]) {
        scoreMap[id] = { rrfScore: 0, sources: {}, meta: item.meta ?? item };
      }

      const rrfContribution = weight / (k + rank + 1);
      scoreMap[id].rrfScore += rrfContribution;
      scoreMap[id].sources[`list_${listIdx}`] = {
        rank:  rank + 1,
        score: item.score,
      };

      // Keep the richer metadata from the highest-scoring source
      if (item.meta && (!scoreMap[id].meta || item.score > (scoreMap[id]._bestScore ?? 0))) {
        scoreMap[id].meta = item.meta;
        scoreMap[id]._bestScore = item.score;
      }
    }
  }

  // Convert to array, sort by fused score
  return Object.entries(scoreMap)
    .map(([id, data]) => ({
      id,
      rrfScore: data.rrfScore,
      sources:  data.sources,
      meta:     data.meta,
    }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}
