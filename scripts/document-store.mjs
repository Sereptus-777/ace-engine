// ============================================================
// ACE — AI Campaign Engine — Document Store
// Manages uploaded reference documents (PDFs, text, images)
// with extracted text chunks and image references.
// ============================================================

import { CategoryStore } from "./category-store.mjs";
import { BM25, tokenize, countTerms } from "./search/bm25.mjs";
import { cosineSimilarity, deserializeVector } from "./search/embeddings.mjs";

const MAX_DOCUMENTS      = 50;   // per world
const MAX_CHUNKS_PER_DOC = 8000; // text chunks per document (raised for large adventure books)
const MAX_IMAGES_PER_DOC = 20;   // image refs per document

// ── Stop Words for Legacy Keyword Extraction ─────────────────
// NOTE: D&D-critical terms (floor, room, area, level, etc.) are
// deliberately EXCLUDED from this list. The BM25 tokenizer in
// search/bm25.mjs has its own improved stop word + keep word lists.
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
  // Removed: "floor", "room", "area", "level", "chapter" — D&D critical terms
]);

/**
 * Extract top keywords from a text string.
 * Uses simple frequency counting with RPG-aware stop-word filtering.
 * @param {string} text
 * @param {number} maxKeywords
 * @returns {string[]}
 */
export function extractKeywords(text, maxKeywords = 8) {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s''-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}


// ── DocumentStore ────────────────────────────────────────────

export class DocumentStore extends CategoryStore {
  constructor() {
    super("documents", "ace-documents.json");
  }

  _emptyData() {
    return {
      version: 1,
      worldId: null,
      savedAt: null,
      documents: {},      // keyed by docId
      activeDigests: [],   // global digest IDs enabled for this world
    };
  }

  get recordCount() {
    return Object.keys(this._data.documents ?? {}).length;
  }

  // ── Serialization ────────────────────────────────────────

  _serialize() {
    return {
      version:       this._data.version ?? 1,
      worldId:       this._data.worldId,
      savedAt:       Date.now(),
      documents:     this._data.documents ?? {},
      activeDigests: this._data.activeDigests ?? [],
    };
  }

  _deserialize(raw) {
    this._data = {
      version:       raw.version ?? 1,
      worldId:       raw.worldId ?? null,
      savedAt:       raw.savedAt ?? null,
      documents:     raw.documents ?? {},
      activeDigests: raw.activeDigests ?? [],
    };
  }

  // ── Document CRUD ────────────────────────────────────────

  /**
   * Create a new document record.
   * @param {Object} opts
   * @param {string} opts.fileName     - Original upload filename
   * @param {string} opts.displayName  - Editable display name
   * @param {string} opts.type         - "pdf" | "txt" | "md" | "image"
   * @param {number} opts.fileSize     - Bytes
   * @param {string} opts.storedPath   - Relative path in Foundry data
   * @returns {Object} The created document record
   */
  addDocument({ fileName, displayName, type, fileSize, storedPath }) {
    if (this.recordCount >= MAX_DOCUMENTS) {
      throw new Error(`Document limit reached (${MAX_DOCUMENTS}). Delete a document first.`);
    }

    const id = `doc_${Math.floor(Date.now() / 1000)}_${Math.random().toString(36).slice(2, 5)}`;
    const record = {
      id,
      fileName:    fileName ?? "unknown",
      displayName: displayName ?? fileName ?? "Untitled",
      type:        type ?? "txt",
      fileSize:    fileSize ?? 0,
      uploadedAt:  Math.floor(Date.now() / 1000),
      pageCount:   0,
      tags:        [],
      enabled:     true,
      storedPath:     storedPath ?? "",
      publishedYear:  null,          // publication year (e.g. 2016) for lore priority
      chunks:         [],
      images:         [],
      status:         "uploading",
      error:          null,
    };

    this._data.documents[id] = record;
    this.markDirty();
    return record;
  }

  /**
   * Update processing status.
   * @param {string} docId
   * @param {string} status - "uploading" | "processing" | "ready" | "error"
   * @param {string|null} error
   */
  setStatus(docId, status, error = null) {
    const doc = this._data.documents[docId];
    if (!doc) return;
    doc.status = status;
    doc.error  = error;
    this.markDirty();
  }

  /**
   * Replace all text chunks for a document.
   * Accepts either a flat chunk array (legacy) or {chunks, parents} object (v2).
   * @param {string} docId
   * @param {Array|{chunks: Array, parents: Array}} chunksOrResult
   */
  setChunks(docId, chunksOrResult) {
    const doc = this._data.documents[docId];
    if (!doc) return;

    // Handle both legacy flat array and new {chunks, parents} format
    if (chunksOrResult && !Array.isArray(chunksOrResult) && chunksOrResult.chunks) {
      // V2 format: { chunks: [...], parents: [...] }
      doc.chunks  = (chunksOrResult.chunks ?? []).slice(0, MAX_CHUNKS_PER_DOC);
      doc.parents = chunksOrResult.parents ?? [];
      doc.chunkVersion = 4;  // v4: cross-references for multi-hop retrieval
    } else {
      // Legacy flat array
      doc.chunks  = (chunksOrResult ?? []).slice(0, MAX_CHUNKS_PER_DOC);
      doc.parents = [];
      doc.chunkVersion = 1;
    }

    // Invalidate BM25 corpus (will rebuild on next search)
    if (this._bm25) this._bm25 = null;

    this.markDirty();
  }

  /**
   * Get parent sections for a document.
   * @param {string} docId
   * @returns {Array}
   */
  getParents(docId) {
    const doc = this._data.documents[docId];
    return doc?.parents ?? [];
  }

  /**
   * Get a specific parent section by its parentIdx.
   * @param {string} docId
   * @param {number} parentIdx
   * @returns {Object|null}
   */
  getParent(docId, parentIdx) {
    const doc = this._data.documents[docId];
    return doc?.parents?.find(p => p.parentIdx === parentIdx) ?? null;
  }

  // ── Cross-Reference Lookups (Multi-Hop Retrieval) ────────────

  /**
   * Find parent sections across all enabled documents that match a room ID.
   * Returns the first match per room ID (rooms are typically unique).
   * @param {string} roomId - e.g., "K15", "23b"
   * @returns {Array<{docId: string, docName: string, parent: Object}>}
   */
  findParentsByRoomId(roomId) {
    if (!roomId) return [];
    const target = roomId.toLowerCase().replace(/\s+/g, "");
    const results = [];

    for (const doc of this.getEnabled()) {
      for (const parent of (doc.parents ?? [])) {
        const pid = (parent.roomId || "").toLowerCase().replace(/\s+/g, "");
        if (pid === target) {
          results.push({ docId: doc.id, docName: doc.name, parent });
          break; // one match per doc is enough
        }
      }
    }
    return results;
  }

  /**
   * Find parent sections that appear on a specific page number.
   * @param {number} pageNum
   * @returns {Array<{docId: string, docName: string, parent: Object}>}
   */
  findParentsByPage(pageNum) {
    if (!pageNum || pageNum < 1) return [];
    const results = [];

    for (const doc of this.getEnabled()) {
      for (const parent of (doc.parents ?? [])) {
        if (parent.page === pageNum || parent.pageEnd === pageNum) {
          results.push({ docId: doc.id, docName: doc.name, parent });
        }
      }
    }
    return results;
  }

  /**
   * Get parents adjacent to a given parent (previous and next in document order).
   * Used for neighbor expansion — when K15 is selected, also grab K14 and K16.
   * @param {string} docId
   * @param {number} parentIdx
   * @returns {{ prev: Object|null, next: Object|null }}
   */
  getAdjacentParents(docId, parentIdx) {
    const doc = this._data.documents[docId];
    if (!doc?.parents?.length) return { prev: null, next: null };

    // Parents are stored in document order (sequential parentIdx)
    const idx = doc.parents.findIndex(p => p.parentIdx === parentIdx);
    if (idx < 0) return { prev: null, next: null };

    return {
      prev: idx > 0 ? doc.parents[idx - 1] : null,
      next: idx < doc.parents.length - 1 ? doc.parents[idx + 1] : null,
    };
  }

  /**
   * Find parent sections whose heading matches a named area reference.
   * Uses substring match against heading text.
   * @param {string} areaName - e.g., "The Village of Barovia"
   * @returns {Array<{docId: string, docName: string, parent: Object}>}
   */
  findParentsByAreaName(areaName) {
    if (!areaName || areaName.length < 3) return [];
    const target = areaName.toLowerCase();
    const results = [];

    for (const doc of this.getEnabled()) {
      for (const parent of (doc.parents ?? [])) {
        const heading = (parent.heading || "").toLowerCase();
        if (heading.includes(target) || target.includes(heading)) {
          results.push({ docId: doc.id, docName: doc.name, parent });
        }
      }
    }
    return results;
  }

  // ── Embedding Storage (Phase 5) ──────────────────────────────

  /**
   * Store serialized embedding vectors for a document's chunks.
   * @param {string} docId
   * @param {Object<number, string>} embeddingsMap - { chunkIdx: base64String, ... }
   */
  setEmbeddings(docId, embeddingsMap) {
    const doc = this._data.documents[docId];
    if (!doc) return;
    doc.embeddings = embeddingsMap;
    // Invalidate deserialized cache
    this._embeddingVecCache?.delete(docId);
    this.markDirty();
  }

  /**
   * Get raw embeddings map for a document.
   * @param {string} docId
   * @returns {Object<number, string>|null}
   */
  getEmbeddings(docId) {
    const doc = this._data.documents[docId];
    return doc?.embeddings ?? null;
  }

  /**
   * Check if a document has embeddings generated.
   * @param {string} docId
   * @returns {boolean}
   */
  hasEmbeddings(docId) {
    const doc = this._data.documents[docId];
    return doc?.embeddings != null && Object.keys(doc.embeddings).length > 0;
  }

  /**
   * Search chunks using cosine similarity against a query embedding vector.
   * Only searches documents that have embeddings. Gracefully skips docs without.
   *
   * @param {Float32Array} queryVector - The embedded query (768-dim)
   * @param {number} [maxResults=25]
   * @returns {Array<{id: string, score: number, meta: Object, docId: string, docName: string, chunk: Object}>}
   */
  searchChunksSemantic(queryVector, maxResults = 25) {
    if (!this._embeddingVecCache) this._embeddingVecCache = new Map();

    const results = [];

    for (const doc of this.getEnabled()) {
      if (!doc.embeddings) continue;

      // Lazy-deserialize vectors for this document (cached)
      let vecMap = this._embeddingVecCache.get(doc.id);
      if (!vecMap) {
        vecMap = new Map();
        for (const [idxStr, base64] of Object.entries(doc.embeddings)) {
          try {
            vecMap.set(Number(idxStr), deserializeVector(base64));
          } catch (_) { /* skip corrupt vectors */ }
        }
        this._embeddingVecCache.set(doc.id, vecMap);
      }

      // Score each chunk
      for (const chunk of (doc.chunks ?? [])) {
        const vec = vecMap.get(chunk.idx);
        if (!vec) continue;

        const score = cosineSimilarity(queryVector, vec);
        if (score >= 0.3) { // minimum similarity threshold
          results.push({
            id:      `${doc.id}::${chunk.idx}`,
            score,
            docId:   doc.id,
            docName: doc.displayName,
            chunk,
            meta: {
              docId:       doc.id,
              docName:     doc.displayName,
              chunkIdx:    chunk.idx,
              page:        chunk.page,
              heading:     chunk.heading,
              sectionType: chunk.sectionType ?? null,
              contentFlags: chunk.contentFlags ?? [],
              parentIdx:   chunk.parentIdx ?? null,
              roomId:      chunk.roomId ?? null,
              tags:        chunk.tags ?? [],
              source:      "semantic",
            },
          });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /**
   * Add an image reference to a document.
   * @param {string} docId
   * @param {Object} imageRecord - {idx, page, label, path, width, height, tags}
   */
  addImage(docId, imageRecord) {
    const doc = this._data.documents[docId];
    if (!doc) return;
    if ((doc.images?.length ?? 0) >= MAX_IMAGES_PER_DOC) return;

    doc.images = doc.images ?? [];
    doc.images.push({
      idx:    imageRecord.idx    ?? doc.images.length,
      page:   imageRecord.page   ?? 0,
      label:  imageRecord.label  ?? "",
      path:   imageRecord.path   ?? "",
      width:  imageRecord.width  ?? 0,
      height: imageRecord.height ?? 0,
      tags:   imageRecord.tags   ?? [],
    });
    this.markDirty();
  }

  /**
   * Set page count (after PDF processing).
   */
  setPageCount(docId, count) {
    const doc = this._data.documents[docId];
    if (!doc) return;
    doc.pageCount = count ?? 0;
    this.markDirty();
  }

  /**
   * Toggle enabled/disabled.
   */
  setEnabled(docId, enabled) {
    const doc = this._data.documents[docId];
    if (!doc) return;
    doc.enabled = !!enabled;
    this.markDirty();
  }

  /**
   * Update tags.
   * @param {string} docId
   * @param {string[]} tags
   */
  setTags(docId, tags) {
    const doc = this._data.documents[docId];
    if (!doc) return;
    doc.tags = Array.isArray(tags) ? tags.slice(0, 20) : [];
    this.markDirty();
  }

  /**
   * Update display name.
   */
  setDisplayName(docId, name) {
    const doc = this._data.documents[docId];
    if (!doc) return;
    doc.displayName = (name ?? "").slice(0, 120) || doc.fileName;
    this.markDirty();
  }

  /**
   * Set the publication year (for lore-priority conflict resolution).
   * @param {string} docId
   * @param {number|null} year - e.g. 2016, or null to clear
   */
  setPublishedYear(docId, year) {
    const doc = this._data.documents[docId];
    if (!doc) return;
    doc.publishedYear = (typeof year === "number" && year > 1900 && year < 2100) ? year : null;
    this.markDirty();
  }

  /**
   * Remove a document record (files must be cleaned separately).
   * @param {string} docId
   * @returns {Object|null} The removed record, or null
   */
  removeDocument(docId) {
    const doc = this._data.documents[docId];
    if (!doc) return null;
    delete this._data.documents[docId];
    this.markDirty();
    return doc;
  }

  /**
   * Nuclear option — wipe ALL documents and active digests from the store.
   * After calling this, call save to persist the empty state.
   * @returns {number} Number of documents that were removed
   */
  nukeLibrary() {
    const count = Object.keys(this._data.documents).length;
    this._data.documents = {};
    this._data.activeDigests = [];
    this.markDirty();
    return count;
  }

  // ── Queries ──────────────────────────────────────────────

  /**
   * Get a specific document by ID.
   */
  getDocument(docId) {
    return this._data.documents[docId] ?? null;
  }

  /**
   * Get all documents as an array (sorted by upload date, newest first).
   */
  getAll() {
    return Object.values(this._data.documents ?? {})
      .sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0));
  }

  /**
   * Get only enabled documents.
   */
  getEnabled() {
    return this.getAll().filter(d => d.enabled && d.status === "ready");
  }

  /**
   * Search chunks across all enabled documents by keyword overlap.
   * @param {string[]} keywords - Query keywords
   * @param {number} maxResults
   * @returns {Array<{docId, docName, chunk, score}>}
   */
  searchChunks(keywords, maxResults = 20) {
    if (!keywords?.length) return [];

    const querySet = new Set(keywords.map(k => k.toLowerCase()));
    const results = [];

    for (const doc of this.getEnabled()) {
      for (const chunk of (doc.chunks ?? [])) {
        let score = 0;

        // Chunk tag overlap (weighted 3x — tags are curated keywords)
        for (const tag of (chunk.tags ?? [])) {
          if (querySet.has(tag.toLowerCase())) score += 3;
        }

        // Document-level tag overlap (weighted 1x)
        for (const tag of (doc.tags ?? [])) {
          if (querySet.has(tag.toLowerCase())) score += 1;
        }

        // Heading match bonus (weighted 2x)
        if (chunk.heading) {
          const lowerHeading = chunk.heading.toLowerCase();
          for (const kw of keywords) {
            if (lowerHeading.includes(kw.toLowerCase())) score += 2;
          }
        }

        // Keyword presence in chunk text (weighted 1x per unique match)
        if (score === 0 || score < 3) {
          const lowerText = chunk.text.toLowerCase();
          for (const kw of keywords) {
            if (lowerText.includes(kw.toLowerCase())) score += 1;
          }
        }

        if (score > 0) {
          results.push({ docId: doc.id, docName: doc.displayName, chunk, score });
        }
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /**
   * Get all images from enabled documents matching keywords.
   * @param {string[]} keywords
   * @param {number} maxResults
   * @returns {Array<{docId, docName, image, score}>}
   */
  searchImages(keywords, maxResults = 5) {
    if (!keywords?.length) return [];

    const querySet = new Set(keywords.map(k => k.toLowerCase()));
    const results = [];

    for (const doc of this.getEnabled()) {
      for (const img of (doc.images ?? [])) {
        let score = 0;

        // Image tag match (3x)
        for (const tag of (img.tags ?? [])) {
          if (querySet.has(tag.toLowerCase())) score += 3;
        }

        // Image label match (2x)
        if (img.label) {
          const lowerLabel = img.label.toLowerCase();
          for (const kw of keywords) {
            if (lowerLabel.includes(kw.toLowerCase())) score += 2;
          }
        }

        // Document tag match (1x)
        for (const tag of (doc.tags ?? [])) {
          if (querySet.has(tag.toLowerCase())) score += 1;
        }

        if (score > 0) {
          results.push({ docId: doc.id, docName: doc.displayName, image: img, score });
        }
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  // ── Active Digests (per-world) ───────────────────────────

  /** Get list of active digest IDs for this world. */
  getActiveDigests() {
    return this._data.activeDigests ?? [];
  }

  /** Toggle a digest on/off for this world. */
  toggleDigest(digestId, enabled) {
    const list = this._data.activeDigests ?? [];
    const idx = list.indexOf(digestId);
    if (enabled && idx < 0) {
      list.push(digestId);
    } else if (!enabled && idx >= 0) {
      list.splice(idx, 1);
    }
    this._data.activeDigests = list;
    this.markDirty();
  }

  // ── BM25 Search ─────────────────────────────────────────

  /**
   * Build or rebuild the BM25 corpus index from all enabled documents.
   * Call after uploads, deletes, or enable/disable changes.
   */
  buildBM25Corpus() {
    if (!this._bm25) this._bm25 = new BM25();

    const documents = [];
    for (const doc of this.getEnabled()) {
      for (const chunk of (doc.chunks ?? [])) {
        // Use pre-computed termFreqs if available (v2 chunks), otherwise compute on the fly
        let termFreqs = chunk.termFreqs;
        let length    = chunk.termCount ?? (chunk.charCount ? Math.round(chunk.charCount / 5) : 0);

        if (!termFreqs) {
          const counted = countTerms(chunk.text ?? "");
          termFreqs = counted.terms;
          length    = counted.length;
        }

        // Compute heading term frequencies for boosting
        let headingTerms = null;
        if (chunk.heading) {
          headingTerms = countTerms(chunk.heading).terms;
        }

        documents.push({
          id: `${doc.id}::${chunk.idx}`,
          termFreqs,
          length,
          meta: {
            docId:       doc.id,
            docName:     doc.displayName,
            chunkIdx:    chunk.idx,
            page:        chunk.page,
            heading:     chunk.heading,
            sectionType: chunk.sectionType ?? null,
            contentFlags: chunk.contentFlags ?? [],
            parentIdx:   chunk.parentIdx ?? null,
            roomId:      chunk.roomId ?? null,
            tags:        chunk.tags ?? [],
            headingTerms,
          },
        });
      }
    }

    this._bm25.buildCorpus(documents);
  }

  /**
   * Search chunks using BM25 scoring.
   * Falls back to legacy keyword search if BM25 corpus isn't built.
   *
   * @param {string|string[]} query - Raw query string or pre-tokenized terms
   * @param {Object} [opts]
   * @param {number} [opts.maxResults=25]
   * @param {Object<string,number>} [opts.sectionBoosts] - Section type → multiplier
   * @returns {Array<{docId: string, docName: string, chunk: Object, score: number}>}
   */
  searchChunksBM25(query, opts = {}) {
    const { maxResults = 25, sectionBoosts, roomIds } = opts;

    // Ensure corpus is built
    if (!this._bm25?.ready) {
      this.buildBM25Corpus();
    }

    const results = this._bm25.search(query, {
      maxResults,
      boosts: sectionBoosts,
      roomIds,
    });

    // Map back to chunk objects for backward compatibility
    return results.map(r => {
      const meta = r.meta;
      const doc  = this._data.documents[meta.docId];
      const chunk = doc?.chunks?.find(c => c.idx === meta.chunkIdx);
      return {
        docId:   meta.docId,
        docName: meta.docName,
        chunk:   chunk ?? { idx: meta.chunkIdx, text: "", heading: meta.heading, page: meta.page, tags: [] },
        score:   r.score,
        meta:    meta,
      };
    }).filter(r => r.chunk);
  }

  /**
   * Perform regex pre-search: scan all chunks for exact pattern matches.
   * Used for room IDs, floor references, NPC names — things regex finds better than BM25.
   *
   * @param {Array<{type: string, regex: RegExp, label: string}>} patterns
   * @param {number} [maxResults=30]
   * @returns {Array<{docId: string, docName: string, chunk: Object, score: number, matchType: string}>}
   */
  regexSearch(patterns, maxResults = 30) {
    if (!patterns?.length) return [];
    const results = [];

    for (const doc of this.getEnabled()) {
      for (const chunk of (doc.chunks ?? [])) {
        const text = `${chunk.heading ?? ""} ${chunk.text ?? ""}`;
        let totalMatches = 0;
        let matchType = "";

        for (const { type, regex, label } of patterns) {
          regex.lastIndex = 0;
          const matches = text.match(regex);
          if (matches) {
            totalMatches += matches.length;
            matchType = matchType ? `${matchType}+${type}` : type;
          }
        }

        if (totalMatches > 0) {
          results.push({
            docId:     doc.id,
            docName:   doc.displayName,
            chunk,
            score:     totalMatches * 5,  // Regex matches get high base score
            matchType,
          });
        }
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /** @returns {BM25|null} The BM25 engine instance */
  get bm25() { return this._bm25 ?? null; }

  // ── Stats ────────────────────────────────────────────────

  /**
   * Get summary statistics.
   */
  getStats() {
    const all = this.getAll();
    const enabled = all.filter(d => d.enabled);
    const totalChunks = all.reduce((n, d) => n + (d.chunks?.length ?? 0), 0);
    const totalImages = all.reduce((n, d) => n + (d.images?.length ?? 0), 0);
    return {
      totalDocuments: all.length,
      enabledDocuments: enabled.length,
      totalChunks,
      totalImages,
      bm25Ready: this._bm25?.ready ?? false,
      bm25Size:  this._bm25?.size ?? 0,
    };
  }
}
