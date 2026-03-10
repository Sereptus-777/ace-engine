// ============================================================
// ACE — AI Campaign Engine — Document Store
// Manages uploaded reference documents (PDFs, text, images)
// with extracted text chunks and image references.
// ============================================================

import { CategoryStore } from "./category-store.mjs";

const MAX_DOCUMENTS      = 50;   // per world
const MAX_CHUNKS_PER_DOC = 500;  // text chunks per document
const MAX_IMAGES_PER_DOC = 20;   // image refs per document

// ── Stop Words for Keyword Extraction ────────────────────────
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
  "your","you","our","his","her","she","him","her","its","we",
  "been","being","over","under","again","further","same","own",
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
   * @param {string} docId
   * @param {Array} chunks - [{idx, page, heading, text, tags}]
   */
  setChunks(docId, chunks) {
    const doc = this._data.documents[docId];
    if (!doc) return;
    doc.chunks = (chunks ?? []).slice(0, MAX_CHUNKS_PER_DOC);
    this.markDirty();
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
    };
  }
}
