// ============================================================
// ACE — AI Campaign Engine — Document Engine
// Handles PDF.js integration, text extraction, chunking,
// relevance scoring, and context building for the Document
// Library reference system.
// ============================================================

import { extractKeywords } from "./document-store.mjs";
import { QueryClassifier } from "./search/query-classifier.mjs";
import { tokenize, countTerms, reciprocalRankFusion } from "./search/bm25.mjs";
import { EmbeddingEngine, serializeVector } from "./search/embeddings.mjs";
import {
  isRoomHeading, extractRoomId, detectHeadingLevel,
  containsStatBlock, isReadAloud, containsTreasure, containsTrap,
  detectContentFlags, SECTION_TYPES, extractCrossReferences,
  buildRoomRegex,
} from "./search/regex-patterns.mjs";

const MODULE_ID = "ace-engine";
const GLOBAL_CACHE_DIR = "ace-engine-library/documents";

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

// ── PDF.js CDN Loading ───────────────────────────────────────

const PDFJS_CDN_VERSION = "4.8.69";
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_CDN_VERSION}`;

let _pdfjsLib = null;

/**
 * Lazily load PDF.js from CDN. Cached after first load.
 * @returns {Promise<Object>} The pdfjs-dist library object
 */
async function _ensurePdfJs() {
  if (_pdfjsLib) return _pdfjsLib;
  try {
    _pdfjsLib = await import(`${PDFJS_CDN}/pdf.min.mjs`);
    _pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;
    console.log(`${MODULE_ID} | PDF.js ${PDFJS_CDN_VERSION} loaded from CDN`);
    return _pdfjsLib;
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to load PDF.js:`, err);
    throw new Error("PDF.js library could not be loaded. Check your internet connection. Text and image uploads still work without it.");
  }
}


// ── Copyright / Publication Year Detection ──────────────────

/**
 * Scan text chunks (or raw page text) for a copyright / publication year.
 * Looks for patterns like ©2016, Copyright 2001, Published 2005, etc.
 * Prioritises the first few pages (title page, copyright page).
 *
 * @param {Array<{text: string}>} chunks - Array of objects with a `text` field
 * @param {number} maxToScan - How many chunks/pages to scan (default: first 15)
 * @returns {number|null} - 4-digit year, or null if not found
 */
export function detectPublishedYear(chunks, maxToScan = 15) {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;

  // Patterns ordered by confidence (most specific → broadest)
  const patterns = [
    /©\s*(\d{4})/,                              // ©2016, © 2001
    /copyright\s+(?:\(c\)\s*)?(\d{4})/i,        // Copyright 2016, Copyright (c) 2005
    /\(c\)\s*(\d{4})/i,                          // (c) 2001
    /first\s+print(?:ed|ing)\s+(\d{4})/i,       // First printed 2005
    /first\s+publish(?:ed|ing)\s+(\d{4})/i,     // First published 2001
    /published\s+(\d{4})/i,                      // Published 2016
    /printing[,.]?\s+(\d{4})/i,                  // Printing, 2016
  ];

  const sample = chunks.slice(0, maxToScan);

  for (const pattern of patterns) {
    for (const chunk of sample) {
      const text = chunk.text ?? chunk;
      if (!text) continue;
      const m = pattern.exec(text);
      if (m) {
        const year = parseInt(m[1], 10);
        if (year >= 1970 && year <= new Date().getFullYear() + 1) {
          return year;
        }
      }
    }
  }
  return null;
}


// ── Text Extraction ──────────────────────────────────────────

/**
 * Extract text from a PDF file, page by page.
 * @param {ArrayBuffer} pdfData - Raw PDF bytes
 * @param {function} onProgress - (pageNum, totalPages) callback
 * @returns {Promise<Array<{page: number, text: string}>>}
 */
export async function extractPdfText(pdfData, onProgress = () => {}) {
  const pdfjsLib = await _ensurePdfJs();
  const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map(item => item.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push({ page: i, text });

    // Yield to UI every 5 pages so progress indicator updates visibly
    if (i % 5 === 0 || i === pdf.numPages) {
      onProgress(i, pdf.numPages);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return pages;
}

/**
 * Render a PDF page to a PNG image blob.
 * @param {ArrayBuffer} pdfData
 * @param {number} pageNum - 1-based page number
 * @param {number} scale - render scale (2.0 = 144dpi, good for maps)
 * @returns {Promise<{blob: Blob, width: number, height: number}>}
 */
export async function renderPdfPage(pdfData, pageNum, scale = 2.0) {
  const pdfjsLib = await _ensurePdfJs();
  const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");

  await page.render({ canvasContext: ctx, viewport }).promise;

  const blob = await new Promise(resolve =>
    canvas.toBlob(resolve, "image/png", 0.9)
  );
  return { blob, width: Math.round(viewport.width), height: Math.round(viewport.height) };
}

/**
 * Extract text from a plain text or markdown file.
 * Returns pseudo-page array matching the PDF extraction format.
 * @param {string} text - File content
 * @param {string} type - "txt" or "md"
 * @returns {Array<{page: number, text: string}>}
 */
export function extractTextFile(text, type = "txt") {
  if (!text || !text.trim()) return [];

  if (type === "md") {
    // Split by markdown headings
    const sections = text.split(/^(?=#{1,3}\s)/m);
    return sections
      .map((s, i) => ({ page: i + 1, text: s.trim() }))
      .filter(p => p.text.length > 0);
  }

  // Plain text: split by double-newline (paragraph breaks)
  const paragraphs = text.split(/\n\s*\n/);
  return paragraphs
    .map((p, i) => ({ page: i + 1, text: p.replace(/\n/g, " ").trim() }))
    .filter(p => p.text.length > 0);
}


// ── Chunking (V2: D&D-aware parent-child hierarchy) ──────────

const LEAF_CHUNK_SIZE   = 300;   // chars (~85 tokens) — small for precise search hits
const MAX_PARENT_SIZE   = 2000;  // chars (~570 tokens) — full section sent to AI
const MIN_CHUNK_SIZE    = 80;
const OVERLAP_CHARS     = 40;

// Legacy heading patterns (fallback when D&D patterns don't match)
const LEGACY_HEADING_PATTERNS = [
  /^(?:chapter|section|part|appendix)\s+[\divxlc]+[.:)—\s]/i,
  /^[A-Z][A-Z\s]{4,60}$/,
  /^\d+\.\d*\s+[A-Z]/,
  /^#{1,3}\s+/,
  /^(?:introduction|conclusion|overview|summary|appendix)\b/i,
];

/**
 * Detect structural sections in page text using D&D-aware patterns.
 * Identifies rooms, stat blocks, read-aloud text, and standard headings.
 * @param {string} text
 * @param {number} pageNum
 * @returns {Array<{heading: string, body: string, page: number, sectionType: string, headingLevel: number, contentFlags: string[], roomId: string|null}>}
 */
function detectSections(text, pageNum) {
  const lines = text.split(/\n/);
  const sections = [];
  let currentHeading = "";
  let currentType = SECTION_TYPES.GENERIC;
  let currentLevel = 0;
  let currentRoomId = null;
  let currentBody = [];

  const flushSection = () => {
    if (currentBody.length > 0) {
      const body = currentBody.join("\n").trim();
      if (body.length >= MIN_CHUNK_SIZE) {
        const flags = detectContentFlags(body);
        sections.push({
          heading:      currentHeading,
          body,
          page:         pageNum,
          sectionType:  currentType,
          headingLevel: currentLevel,
          contentFlags: flags,
          roomId:       currentRoomId,
        });
      }
    }
    currentBody = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentBody.length > 0) currentBody.push("");
      continue;
    }

    // Check D&D-aware heading detection first
    const headingInfo = detectHeadingLevel(trimmed);

    // Also check legacy patterns
    const isLegacyHeading = !headingInfo && LEGACY_HEADING_PATTERNS.some(p => p.test(trimmed));

    if (headingInfo || isLegacyHeading) {
      flushSection();

      currentHeading = trimmed.replace(/^#{1,6}\s*/, "");

      if (headingInfo) {
        currentLevel = headingInfo.level;
        currentType  = headingInfo.type;
      } else {
        currentLevel = 2;
        currentType  = SECTION_TYPES.GENERIC;
      }

      // Extract room ID if this is a room heading
      currentRoomId = extractRoomId(trimmed);

      // Don't add the heading line to the body — it's stored separately
    } else {
      // Check if this line starts a stat block mid-section
      if (containsStatBlock(trimmed) && currentBody.length > 3) {
        // Stat block detected mid-section — flush current and start new
        flushSection();
        currentHeading = currentHeading || "(Stat Block)";
        currentType = SECTION_TYPES.STAT_BLOCK;
        currentRoomId = null;
      }

      currentBody.push(trimmed);
    }
  }

  flushSection();

  // If nothing was detected, return entire text as one section
  if (sections.length === 0 && text.trim().length >= MIN_CHUNK_SIZE) {
    sections.push({
      heading:      "",
      body:         text.trim(),
      page:         pageNum,
      sectionType:  SECTION_TYPES.GENERIC,
      headingLevel: 0,
      contentFlags: detectContentFlags(text),
      roomId:       null,
    });
  }

  return sections;
}

/**
 * Split section body into leaf chunks at sentence boundaries.
 * Each leaf is small (~300 chars) for precise search matching.
 * @param {string} text
 * @param {number} targetSize
 * @returns {string[]}
 */
function splitLeafChunks(text, targetSize = LEAF_CHUNK_SIZE) {
  if (text.length <= targetSize) return [text];

  // Split at sentence boundaries
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) ?? [text];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > targetSize && current.length > 0) {
      chunks.push(current.trim());
      const overlapText = current.slice(-OVERLAP_CHARS);
      current = overlapText + sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Convert extracted page text into searchable chunks with parent-child hierarchy.
 *
 * PARENTS: Full sections (room descriptions, stat blocks, etc.) up to 2000 chars.
 *   These are what the AI reads — complete context for a location/entity.
 *
 * CHUNKS (leaves): Small fragments (~300 chars) of each parent.
 *   These are what BM25 searches — precise matches on specific details.
 *   Each leaf references its parent via parentIdx.
 *
 * @param {Array<{page: number, text: string}>} pages
 * @returns {{ chunks: Array, parents: Array }}
 */
export async function chunkPages(pages, progressCb = null) {
  const chunks  = [];
  const parents = [];
  let chunkIdx  = 0;
  let parentIdx = 0;

  for (let pi = 0; pi < pages.length; pi++) {
    const { page, text } = pages[pi];

    // Report progress & yield to UI thread every 10 pages
    if (progressCb && (pi % 10 === 0 || pi === pages.length - 1)) {
      progressCb(pi + 1, pages.length);
      await new Promise(r => setTimeout(r, 0));
    }
    if (!text || text.length < MIN_CHUNK_SIZE) continue;

    const sections = detectSections(text, page);

    for (const section of sections) {
      const { heading, body, sectionType, headingLevel, contentFlags, roomId } = section;

      // ── Build the parent (full section) ──────────────────
      // If section is too large, split into multiple parents at paragraph breaks
      const parentTexts = body.length <= MAX_PARENT_SIZE
        ? [body]
        : splitAtParagraphs(body, MAX_PARENT_SIZE);

      for (const parentText of parentTexts) {
        const fullText = heading ? `${heading}\n${parentText}` : parentText;
        const pIdx = parentIdx++;

        // ── Extract cross-references for multi-hop retrieval ──
        const crossRefs = extractCrossReferences(fullText, roomId || null);

        const parent = {
          parentIdx:    pIdx,
          page,
          pageEnd:      page,
          heading:      heading || "",
          sectionType,
          headingLevel,
          contentFlags,
          roomId:       roomId || null,
          fullText,
          childIndices: [],
          charCount:    fullText.length,
          crossRefs,    // { rooms: string[], pages: number[], areas: string[] }
        };

        // ── Build leaf chunks for search ─────────────────
        const leaves = splitLeafChunks(parentText);

        for (const leafText of leaves) {
          if (leafText.length < MIN_CHUNK_SIZE) continue;

          // Include heading in searchable terms so room IDs (K15, Area 12, etc.)
          // and heading keywords are indexed for BM25 — not just body text.
          const searchableText = heading ? `${heading} ${leafText}` : leafText;
          const { terms, length } = countTerms(searchableText);
          const cIdx = chunkIdx++;

          chunks.push({
            idx:          cIdx,
            parentIdx:    pIdx,
            page,
            heading:      heading || "",
            sectionType,
            contentFlags,
            roomId:       roomId || null,
            text:         leafText,
            tags:         extractKeywords(leafText, 8),
            termFreqs:    terms,
            charCount:    leafText.length,
            termCount:    length,
          });

          parent.childIndices.push(cIdx);
        }

        // Only keep parents that have at least one child chunk
        if (parent.childIndices.length > 0) {
          parents.push(parent);
        }
      }
    }
  }

  console.log(`ACE Chunker | ${parents.length} parents, ${chunks.length} leaf chunks from ${pages.length} pages`);
  return { chunks, parents };
}

/**
 * Split text at paragraph breaks to stay under maxChars.
 * Used when a section exceeds MAX_PARENT_SIZE.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitAtParagraphs(text, maxChars) {
  if (text.length <= maxChars) return [text];

  // Try paragraph breaks first
  const paragraphs = text.split(/\n\s*\n/);
  const result = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      result.push(current.trim());
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }

  if (current.trim().length > 0) {
    result.push(current.trim());
  }

  // If paragraphs didn't help (one giant paragraph), fall back to sentences
  if (result.length === 0) {
    return splitLeafChunks(text, maxChars);
  }

  return result;
}

/**
 * Chunk a text/markdown file into searchable chunks with parent-child hierarchy.
 * @param {string} text
 * @param {string} type - "txt" or "md"
 * @returns {{ chunks: Array, parents: Array }}
 */
export async function chunkTextFile(text, type = "txt") {
  const pages = extractTextFile(text, type);
  return chunkPages(pages);
}


// ── Image Base64 Loading ─────────────────────────────────────

/**
 * Load an image file from Foundry's data path as base64.
 * @param {string} path - relative path like "worlds/.../library/images/foo.png"
 * @returns {Promise<{base64: string, mimeType: string}>}
 */
export async function loadImageAsBase64(path) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`Failed to load image: ${path} (${resp.status})`);
  const blob = await resp.blob();
  const mimeType = blob.type || "image/png";

  // Use FileReader for efficient base64 encoding (avoids O(n²) string concat)
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:<mime>;base64,<data>" — strip the prefix
      const dataUrl = reader.result;
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error(`Failed to read image: ${path}`));
    reader.readAsDataURL(blob);
  });

  return { base64, mimeType };
}


// ── DocumentEngine — Context Builder ─────────────────────────

export class DocumentEngine {
  /**
   * @param {import("./memory-manager.mjs").MemoryManager} memoryManager
   * @param {import("./digest-engine.mjs").DigestEngine} [digestEngine]
   */
  constructor(memoryManager, digestEngine = null) {
    this._mm = memoryManager;
    this._digestEngine = digestEngine;
    this._embeddingEngine = null; // lazy-initialized
    this._classifier = null;
  }

  /**
   * Lazy-initialize the embedding engine. Checks Ollama availability once.
   * Returns the engine if available, or false if not.
   * @returns {Promise<EmbeddingEngine|false>}
   */
  async _getEmbeddingEngine() {
    if (this._embeddingEngine !== null) return this._embeddingEngine;

    // Read Ollama URL from settings, fallback to default
    let ollamaUrl = "http://localhost:11434";
    try {
      const provider = game.settings.get(MODULE_ID, "aiProvider");
      if (provider === "ollama") {
        ollamaUrl = game.settings.get(MODULE_ID, "apiUrl") || ollamaUrl;
      }
    } catch (_) { /* settings not available yet */ }

    const engine = new EmbeddingEngine({ baseUrl: ollamaUrl });
    const ok = await engine.checkAvailability();
    this._embeddingEngine = ok ? engine : false;
    return this._embeddingEngine;
  }

  /**
   * Generate embeddings for all chunks in a document.
   * Called after chunking during upload. Skipped if Ollama is unavailable.
   *
   * @param {string} docId
   * @param {Function} [onProgress] - (current, total) => void
   * @returns {Promise<boolean>} true if embeddings were generated
   */
  async generateEmbeddings(docId, onProgress = null) {
    const engine = await this._getEmbeddingEngine();
    if (!engine) return false;

    const store = this._mm?.documents;
    const doc = store?.getDocument?.(docId);
    // getDocument may not exist — fall back to getEnabled search
    const docRecord = doc ?? store?.getEnabled()?.find(d => d.id === docId);
    if (!docRecord?.chunks?.length) return false;

    // Prefix heading for better semantic representation
    const texts = docRecord.chunks.map(c =>
      c.heading ? `${c.heading}\n${c.text}` : (c.text || "")
    );

    const vectors = await engine.embedBatch(texts, onProgress);

    // Serialize and store
    const embeddingsMap = {};
    for (let i = 0; i < docRecord.chunks.length; i++) {
      embeddingsMap[docRecord.chunks[i].idx] = serializeVector(vectors[i]);
    }
    store.setEmbeddings(docId, embeddingsMap);

    console.log(`ACE Embeddings | Generated ${vectors.length} vectors for "${docRecord.displayName}"`);
    return true;
  }

  // ── Extraction Methods (delegated to module-level functions) ──

  /** Extract text from a PDF ArrayBuffer, page by page. */
  extractPdfText(pdfData, onProgress) {
    return extractPdfText(pdfData, onProgress);
  }

  /** Render a PDF page to a PNG blob. */
  renderPdfPage(pdfData, pageNum, scale) {
    return renderPdfPage(pdfData, pageNum, scale);
  }

  /** Chunk extracted pages into searchable text chunks. */
  async chunkPages(pages, progressCb = null) {
    return chunkPages(pages, progressCb);
  }

  /** Chunk a text/markdown file. */
  async chunkTextFile(text, type) {
    return chunkTextFile(text, type);
  }

  // ── Context Building ──────────────────────────────────────

  /**
   * Build document context for injection into an AI prompt.
   * Finds the most relevant chunks based on current context.
   *
   * @param {string} sceneContext - Current scene context string
   * @param {string} userMessage - The GM's current message/query
   * @param {string} currentScene - Scene name
   * @param {number} maxChars - Character budget (default from settings)
   * @param {string} lastAssistantMsg - Last AI response (for conversation-aware search)
   * @returns {string} Formatted context block, or ""
   */
  async buildDocumentContext(sceneContext = "", userMessage = "", currentScene = "", maxChars = 8000, lastAssistantMsg = "") {
    const store = this._mm?.documents;
    if (!store) return "";

    if (!userMessage?.trim()) return "";

    const contentBudget = maxChars - 300; // reserve 300 chars for headers/framing
    return this._buildContextBM25(store, userMessage, sceneContext, currentScene, contentBudget, lastAssistantMsg);
  }

  /**
   * New BM25 + regex search pipeline.
   * @private
   */
  async _buildContextBM25(store, userMessage, sceneContext, currentScene, contentBudget, lastAssistantMsg = "") {
    // ═══════════════════════════════════════════════════════════
    // Phase 3-5: Smart Context Assembly + Adaptive Digest + Embeddings
    // ═══════════════════════════════════════════════════════════

    // 1. Classify the query — intent, entities, regex patterns, boosts
    if (!this._classifier) this._classifier = new QueryClassifier();
    const analysis = this._classifier.classify(userMessage, {
      sceneName: currentScene,
      sceneDescription: sceneContext,
    });

    // 1b. Conversation-aware search — extract entities from the last AI
    //     response so follow-up queries like "what about that NPC?" or
    //     "tell me more" pull in context from what was just discussed.
    let conversationEntities = [];
    if (lastAssistantMsg && lastAssistantMsg.length > 20) {
      conversationEntities = this._extractConversationEntities(lastAssistantMsg, analysis);
    }

    // 1c. Scene-aware boosting — extract the current Foundry scene name
    //     and add scene-matching room IDs to the search for auto-priming.
    const sceneRoomIds = this._extractSceneRoomIds(currentScene);
    if (sceneRoomIds.length > 0) {
      for (const rid of sceneRoomIds) {
        if (!analysis.entities.rooms.includes(rid)) {
          analysis.entities.rooms.push(rid);
        }
      }
    }

    // 1d. Add regex pre-search patterns for rooms discovered from conversation
    //     and scene context (the classifier only built patterns for the user's
    //     explicit query — these are supplemental).
    const existingRoomPatterns = new Set(
      analysis.preSearchPatterns.filter(p => p.type === "room").map(p => p.label)
    );
    for (const roomId of analysis.entities.rooms) {
      const label = `Room ${roomId}`;
      if (!existingRoomPatterns.has(label)) {
        analysis.preSearchPatterns.push({
          type: "room",
          regex: buildRoomRegex(roomId),
          label,
        });
      }
    }

    console.log(`ACE Search | Query classified: intent="${analysis.intent}", ` +
      `rooms=[${analysis.entities.rooms}], floor=${analysis.entities.floorNum}, ` +
      `terms=[${analysis.searchTerms.slice(0, 8).join(",")}]` +
      (conversationEntities.length ? ` | +${conversationEntities.length} conversation entities` : "") +
      (sceneRoomIds.length ? ` | scene rooms=[${sceneRoomIds}]` : ""));

    // 2. Regex pre-search — exact matches for rooms, floors, NPC names
    const regexResults = store.regexSearch(analysis.preSearchPatterns, 30);

    // 3. BM25 search — ranked by term relevance + roomId boost
    const bm25Results = store.searchChunksBM25(analysis.expandedTerms, {
      maxResults: 30,
      sectionBoosts: analysis.sectionBoosts,
      roomIds: analysis.entities?.rooms ?? [],
    });

    // 3b. Semantic search — embedding similarity (Phase 5)
    //     Gracefully skipped if Ollama is unavailable or no embeddings exist.
    let semanticResults = [];
    try {
      const engine = await this._getEmbeddingEngine();
      if (engine) {
        const queryVec = await engine.embed(userMessage);
        semanticResults = store.searchChunksSemantic(queryVec, 30);
      }
    } catch (err) {
      console.warn("ACE Search | Semantic search skipped:", err.message);
    }

    // 4. Fuse results with RRF — three-way merge
    //    Weights: regex 1.5 (exact matches), BM25 1.0 (term relevance), semantic 0.8 (conceptual)
    const regexForRRF = regexResults.map(r => ({
      id: `${r.docId}::${r.chunk.idx}`,
      score: r.score,
      meta: { ...r, source: "regex" },
    }));
    const bm25ForRRF = bm25Results.map(r => ({
      id: `${r.docId}::${r.chunk.idx}`,
      score: r.score,
      meta: { ...r, source: "bm25" },
    }));

    const rrfLists   = [regexForRRF, bm25ForRRF];
    const rrfWeights = [1.5, 1.0];

    if (semanticResults.length > 0) {
      const semanticForRRF = semanticResults.map(r => ({
        id: r.id,
        score: r.score,
        meta: { ...r, source: "semantic" },
      }));
      rrfLists.push(semanticForRRF);
      rrfWeights.push(0.8);
      console.log(`ACE Search | Semantic: ${semanticResults.length} results (top score: ${semanticResults[0]?.score?.toFixed(3)})`);
    }

    const fused = reciprocalRankFusion(rrfLists, rrfWeights);

    // ── Phase 4: Adaptive Digest Budget ──────────────────────
    // Instead of a flat 40/60 split, adapt based on query type:
    //   - Specific queries (room, npc) → less digest, more raw chunks
    //   - General/lore queries → more digest for big-picture context
    let digestCtx = "";
    let digestCharsUsed = 0;
    const activeDigestIds = store.getActiveDigests();
    const hasDigests = activeDigestIds.length > 0 && this._digestEngine;

    if (hasDigests) {
      // Adaptive split based on intent
      const digestRatios = {
        room: 0.15,       // Room query — mostly want raw text, minimal digest
        npc: 0.25,        // NPC query — some digest context helps
        encounter: 0.30,  // Encounter — digest has creature/difficulty data
        tactical: 0.20,   // Tactical — raw stat blocks matter more
        treasure: 0.25,   // Treasure — raw text + digest items
        lore: 0.50,       // Lore — digest excels here (big picture)
        general: 0.40,    // General — balanced
        floor: 0.20,      // Floor/area — mostly raw chunks
        rules: 0.10,      // Rules — almost entirely raw text
      };
      const digestRatio = digestRatios[analysis.intent] ?? 0.35;
      const digestBudget = Math.floor(contentBudget * digestRatio);

      // Phase 4: Query-aware digest — pass the classified intent so the
      // digest engine can prioritize relevant categories
      const result = this._digestEngine.buildDigestContext(
        activeDigestIds,
        analysis.expandedTerms,
        digestBudget,
        analysis.intent  // NEW — intent-aware digest filtering
      );
      digestCtx = result.text;
      digestCharsUsed = result.charsUsed;
    }

    // ── Phase 3: Smart Context Assembly ──────────────────────
    const chunkBudget = contentBudget - digestCharsUsed;

    // Step A: Identify "must-include" chunks — exact room/NPC/scene matches
    //         These get guaranteed slots before ranked fill.
    const mustInclude = [];
    const mustIncludeKeys = new Set();
    const requestedRooms = new Set((analysis.entities?.rooms ?? []).map(r => r.toLowerCase().replace(/\s+/g, "")));
    const requestedNPCs  = new Set((analysis.entities?.npcs ?? []).map(n => n.toLowerCase()));

    // Scene-aware boosting: extract significant words from scene name
    // for heading-level matching (e.g., "Castle Ravenloft" → "ravenloft")
    const sceneWords = currentScene
      ? currentScene.split(/[\s_\-—–,.:]+/)
          .filter(w => w.length > 3)
          .map(w => w.toLowerCase())
          .filter(w => !["the", "room", "area", "level", "floor", "scene", "map"].includes(w))
      : [];

    if (requestedRooms.size > 0 || requestedNPCs.size > 0 || sceneWords.length > 0) {
      for (const item of fused) {
        const r     = item.meta;
        const chunk = r.chunk;
        if (!chunk) continue;

        const chunkRoom = (chunk.roomId || "").toLowerCase().replace(/\s+/g, "");
        const isRoomMatch = chunkRoom && requestedRooms.has(chunkRoom);

        // NPC match: check heading for NPC name
        const headingLower = (chunk.heading || "").toLowerCase();
        const isNPCMatch = requestedNPCs.size > 0 &&
          [...requestedNPCs].some(npc => headingLower.includes(npc));

        // Scene heading match: if the scene name contains a significant word
        // that also appears in a chunk heading, boost it as a must-include
        // (but only the first 2 scene matches to avoid flooding)
        const sceneMatchCount = mustInclude.filter(i => i._sceneMatch).length;
        const isSceneMatch = sceneMatchCount < 2 && sceneWords.length > 0 &&
          sceneWords.some(w => headingLower.includes(w));

        if (isRoomMatch || isNPCMatch || isSceneMatch) {
          const key = `${r.docId}::${chunk.parentIdx ?? chunk.idx}`;
          if (!mustIncludeKeys.has(key)) {
            mustIncludeKeys.add(key);
            mustInclude.push({ ...item, _sceneMatch: isSceneMatch && !isRoomMatch && !isNPCMatch });
          }
        }
      }
    }

    // Step B: Expand and assemble — must-includes first, then ranked fill
    const selected = [];
    let totalChars = 0;
    const seenParents = new Set();
    const seenChunks  = new Set();  // track individual chunks for dedup
    const docCharCounts = {};       // source diversity tracking
    const numDocs = new Set(fused.map(f => f.meta?.docId)).size;
    // Per-doc cap: if multiple docs, no single doc gets more than 70% of budget
    const perDocCap = numDocs > 1 ? Math.floor(chunkBudget * 0.7) : chunkBudget;

    const expandAndAdd = (item) => {
      const r = item.meta;
      const docId    = r.docId;
      const chunk    = r.chunk;
      if (!chunk) return false;
      const parentId = chunk.parentIdx;

      // Chunk-level dedup
      const chunkKey = `${docId}::${chunk.idx}`;
      if (seenChunks.has(chunkKey)) return false;

      // Try to expand to parent text (full section)
      let displayText    = chunk.text ?? "";
      let displayHeading = chunk.heading ?? "";
      let usedParent     = false;

      if (parentId != null) {
        const parentKey = `${docId}::${parentId}`;
        if (seenParents.has(parentKey)) return false; // already included this parent

        const parent = store.getParent(docId, parentId);
        if (parent) {
          displayText    = parent.fullText;
          displayHeading = parent.heading || displayHeading;
          usedParent     = true;
        }
      }

      const entryLen = displayText.length + displayHeading.length + 40;

      // Source diversity check
      const docChars = docCharCounts[docId] ?? 0;
      if (docChars + entryLen > perDocCap) return false;

      if (totalChars + entryLen > chunkBudget) {
        // Parent too big — fall back to leaf chunk
        if (usedParent && chunk.text) {
          const leafLen = chunk.text.length + (chunk.heading?.length ?? 0) + 40;
          if (totalChars + leafLen <= chunkBudget && docChars + leafLen <= perDocCap) {
            selected.push({ ...r, _displayText: chunk.text, _displayHeading: chunk.heading || "", _page: chunk.page });
            totalChars += leafLen;
            seenChunks.add(chunkKey);
            docCharCounts[docId] = docChars + leafLen;
            return true;
          }
        }
        return false;
      }

      selected.push({ ...r, _displayText: displayText, _displayHeading: displayHeading, _page: chunk.page });
      totalChars += entryLen;
      seenChunks.add(chunkKey);
      docCharCounts[docId] = docChars + entryLen;
      if (usedParent) seenParents.add(`${docId}::${parentId}`);
      // Mark all leaf chunks under this parent as seen
      if (usedParent && parentId != null) {
        for (const f of fused) {
          if (f.meta?.docId === docId && f.meta?.chunk?.parentIdx === parentId) {
            seenChunks.add(`${docId}::${f.meta.chunk.idx}`);
          }
        }
      }
      return true;
    };

    // Must-includes go first (guaranteed slots)
    for (const item of mustInclude) {
      expandAndAdd(item);
    }

    // Ranked fill from fused results
    for (const item of fused) {
      if (totalChars >= chunkBudget) break;
      if (selected.length >= 20) break;
      expandAndAdd(item);
    }

    // ── Step B2: Multi-Hop Retrieval (Cross-Reference Following) ──
    // Scan all selected parents for cross-references (rooms, pages, areas)
    // that point to content NOT already in the results. Do targeted lookups
    // for those referenced sections and add them with remaining budget.
    const hopRefs = { rooms: new Set(), pages: new Set(), areas: new Set() };
    const alreadyIncludedRooms = new Set();

    // Collect what we already have and what's referenced
    for (const item of selected) {
      const docId    = item.docId;
      const parentId = item.chunk?.parentIdx;
      if (parentId == null) continue;

      // Track rooms already in results
      const parentRoomId = item.chunk?.roomId;
      if (parentRoomId) alreadyIncludedRooms.add(parentRoomId.toLowerCase().replace(/\s+/g, ""));

      // Look up parent's crossRefs (stored at index time)
      const parent = store.getParent(docId, parentId);
      if (!parent?.crossRefs) continue;

      for (const r of (parent.crossRefs.rooms ?? [])) hopRefs.rooms.add(r);
      for (const p of (parent.crossRefs.pages ?? [])) hopRefs.pages.add(p);
      for (const a of (parent.crossRefs.areas ?? [])) hopRefs.areas.add(a);
    }

    // Remove rooms already included in first pass
    for (const r of alreadyIncludedRooms) {
      hopRefs.rooms.delete(r);
      // Also try uppercase version since roomIds can be "K15" or "k15"
      hopRefs.rooms.delete(r.toUpperCase());
    }

    // Do targeted lookups for cross-referenced content
    let hopCount = 0;
    const maxHops = 5; // cap to avoid runaway expansion

    if (hopRefs.rooms.size > 0 || hopRefs.pages.size > 0 || hopRefs.areas.size > 0) {
      // Room lookups — most reliable cross-references
      for (const roomId of hopRefs.rooms) {
        if (hopCount >= maxHops || totalChars >= chunkBudget) break;
        const matches = store.findParentsByRoomId(roomId);
        for (const { docId, docName, parent } of matches) {
          const parentKey = `${docId}::${parent.parentIdx}`;
          if (seenParents.has(parentKey)) continue;

          const entryLen = parent.fullText.length + (parent.heading?.length ?? 0) + 60;
          const docChars = docCharCounts[docId] ?? 0;
          if (totalChars + entryLen > chunkBudget) continue;
          if (docChars + entryLen > perDocCap) continue;

          selected.push({
            docId,
            docName,
            chunk: { ...parent, idx: parent.parentIdx },
            _displayText: parent.fullText,
            _displayHeading: parent.heading || "",
            _page: parent.page,
            _isHop: true,          // flag for logging/formatting
            _hopSource: roomId,
          });
          totalChars += entryLen;
          seenParents.add(parentKey);
          docCharCounts[docId] = docChars + entryLen;
          hopCount++;
          break; // one parent per room ID
        }
      }

      // Area name lookups
      for (const areaName of hopRefs.areas) {
        if (hopCount >= maxHops || totalChars >= chunkBudget) break;
        const matches = store.findParentsByAreaName(areaName);
        for (const { docId, docName, parent } of matches) {
          const parentKey = `${docId}::${parent.parentIdx}`;
          if (seenParents.has(parentKey)) continue;

          const entryLen = parent.fullText.length + (parent.heading?.length ?? 0) + 60;
          const docChars = docCharCounts[docId] ?? 0;
          if (totalChars + entryLen > chunkBudget) continue;
          if (docChars + entryLen > perDocCap) continue;

          selected.push({
            docId,
            docName,
            chunk: { ...parent, idx: parent.parentIdx },
            _displayText: parent.fullText,
            _displayHeading: parent.heading || "",
            _page: parent.page,
            _isHop: true,
            _hopSource: areaName,
          });
          totalChars += entryLen;
          seenParents.add(parentKey);
          docCharCounts[docId] = docChars + entryLen;
          hopCount++;
          break;
        }
      }

      if (hopCount > 0) {
        console.log(`ACE Search | Multi-hop: followed ${hopCount} cross-references ` +
          `(rooms: ${[...hopRefs.rooms].join(",")}, areas: ${[...hopRefs.areas].join(",")}) ` +
          `+${selected.filter(s => s._isHop).reduce((sum, s) => sum + (s._displayText?.length ?? 0), 0)} chars`);
      }
    }

    // ── Step B3: Neighbor Expansion ──────────────────────────────
    // If budget remains, grab adjacent parent sections (the room before
    // and after a selected room). D&D modules are written sequentially —
    // K14 is usually right before K15 in the PDF. This gives the AI
    // surrounding context without the GM having to ask about each room.
    let neighborCount = 0;
    const maxNeighbors = 3;
    const remainingBudget = chunkBudget - totalChars;

    if (remainingBudget > 400 && selected.length > 0) {
      // Prioritize must-includes and high-value rooms for neighbor expansion
      const neighborCandidates = selected
        .filter(s => !s._isHop && !s._isNeighbor && s.chunk?.parentIdx != null)
        .slice(0, 6); // check up to 6 candidates

      for (const item of neighborCandidates) {
        if (neighborCount >= maxNeighbors || totalChars >= chunkBudget) break;

        const docId    = item.docId;
        const docName  = item.docName;
        const parentId = item.chunk.parentIdx;
        const { prev, next } = store.getAdjacentParents(docId, parentId);

        for (const neighbor of [next, prev]) { // prefer next (following room)
          if (!neighbor || neighborCount >= maxNeighbors) continue;

          const parentKey = `${docId}::${neighbor.parentIdx}`;
          if (seenParents.has(parentKey)) continue;

          const entryLen = neighbor.fullText.length + (neighbor.heading?.length ?? 0) + 60;
          const docChars = docCharCounts[docId] ?? 0;
          if (totalChars + entryLen > chunkBudget) continue;
          if (docChars + entryLen > perDocCap) continue;

          selected.push({
            docId,
            docName,
            chunk: { ...neighbor, idx: neighbor.parentIdx },
            _displayText: neighbor.fullText,
            _displayHeading: neighbor.heading || "",
            _page: neighbor.page,
            _isNeighbor: true,
            _neighborOf: item._displayHeading || item.chunk?.heading || "",
          });
          totalChars += entryLen;
          seenParents.add(parentKey);
          docCharCounts[docId] = docChars + entryLen;
          neighborCount++;
        }
      }

      if (neighborCount > 0) {
        console.log(`ACE Search | Neighbors: expanded ${neighborCount} adjacent sections ` +
          `(+${selected.filter(s => s._isNeighbor).reduce((sum, s) => sum + (s._displayText?.length ?? 0), 0)} chars)`);
      }
    }

    if (!digestCtx && !selected.length) return "";

    // ── Step C: Sort selected by page order for readability ──
    selected.sort((a, b) => {
      if (a.docId !== b.docId) return (a.docName || "").localeCompare(b.docName || "");
      return (a._page ?? 0) - (b._page ?? 0);
    });

    // 7. Format the context block
    let chunkCtx = "";
    if (selected.length) {
      chunkCtx = this._formatExpandedChunks(selected);
    }

    let ctx = "\n\n## REFERENCE LIBRARY\n\n";
    ctx += "The following information comes from the GM's reference documents. ";
    ctx += "Use this as background knowledge — do not quote it directly to players.\n\n";

    if (digestCtx) {
      ctx += "### Structured Reference Data\n";
      ctx += digestCtx;
      if (chunkCtx) ctx += "\n### Relevant Document Excerpts\n";
    }
    if (chunkCtx) {
      ctx += chunkCtx;
    }

    const docsUsed = Object.keys(docCharCounts).length;
    const hopItems = selected.filter(s => s._isHop).length;
    const neighborItems = selected.filter(s => s._isNeighbor).length;
    console.log(`ACE Search | Context built: ${selected.length} chunks (${totalChars} chars) + ` +
      `digest (${digestCharsUsed} chars) = ${totalChars + digestCharsUsed}/${contentBudget} budget` +
      ` | ${mustInclude.length} must-include | ${hopItems} cross-refs | ${neighborItems} neighbors | ${docsUsed} source docs`);

    // ── Store discovered entities for cross-store linking ────
    // The panel can read these after calling buildDocumentContext()
    // to do supplemental NPC memory/reputation/fame lookups for
    // entities discovered in PDF content.
    this._lastSearchEntities = {
      rooms:     [...new Set(analysis.entities.rooms)],
      npcs:      [...new Set(analysis.entities.npcs)],
      locations: [...new Set(analysis.entities.locations)],
      // Also extract proper nouns from selected chunk headings
      headingNames: [...new Set(
        selected
          .map(s => s._displayHeading || s.chunk?.heading || "")
          .filter(h => h.length > 3)
      )],
    };

    return ctx;
  }


  /**
   * Get relevant images for multimodal injection.
   * Returns image references whose tags/labels match the current context.
   * @param {string} userMessage
   * @param {string} sceneContext
   * @param {number} maxImages
   * @returns {Array<{path: string, label: string, docName: string, tags: string[]}>}
   */
  getRelevantImages(userMessage = "", sceneContext = "", maxImages = 2) {
    const store = this._mm?.documents;
    if (!store) return [];

    const keywords = this._extractQueryKeywords(userMessage, sceneContext, "");
    if (!keywords.length) return [];

    const scored = store.searchImages(keywords, maxImages);
    return scored.map(s => ({
      path:    s.image.path,
      label:   s.image.label,
      docName: s.docName,
      tags:    s.image.tags ?? [],
    }));
  }

  // ── Internals ─────────────────────────────────────────────

  /**
   * Extract query keywords from multiple context sources.
   * @private
   */
  _extractQueryKeywords(userMessage, sceneContext, currentScene) {
    const keywords = [];

    // From user message: extract non-stop-word tokens (primary relevance signal)
    if (userMessage) {
      keywords.push(...extractKeywords(userMessage, 8));
    }

    // From scene name (strong relevance — user is literally in this scene)
    if (currentScene) {
      const sceneWords = currentScene.toLowerCase()
        .split(/[\s_-]+/)
        .filter(w => w.length > 2);
      keywords.push(...sceneWords.slice(0, 4));
    }

    // From scene context: extract proper nouns BUT limit heavily.
    // Too many scene keywords cause the digest to match half the book.
    // Only add a few scene names, and only if we don't already have
    // enough keywords from the user message itself.
    if (sceneContext && keywords.length < 6) {
      const names = sceneContext.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
      const unique = [...new Set(names.map(n => n.toLowerCase()))];
      keywords.push(...unique.slice(0, 5));
    }

    // Deduplicate and hard-cap total keywords
    return [...new Set(keywords)].slice(0, 12);
  }

  /**
   * Select top chunks that fit within the character budget.
   * @private
   */
  _selectWithinBudget(scoredChunks, maxChars) {
    const selected = [];
    let totalChars = 0;

    for (const item of scoredChunks) {
      const chunkLen = (item.chunk.text?.length ?? 0) + (item.chunk.heading?.length ?? 0) + 30;
      if (totalChars + chunkLen > maxChars) continue;
      selected.push(item);
      totalChars += chunkLen;
      if (selected.length >= 10) break; // hard cap on chunks per prompt
    }

    return selected;
  }

  /**
   * Format selected chunks as a context sub-block (no outer header).
   * @private
   */
  _formatChunks(selected) {
    if (!selected.length) return "";

    let ctx = "### Raw Text Excerpts\n";

    // Group by document
    const byDoc = {};
    for (const item of selected) {
      if (!byDoc[item.docId]) byDoc[item.docId] = { name: item.docName, chunks: [] };
      byDoc[item.docId].chunks.push(item.chunk);
    }

    for (const [, { name, chunks }] of Object.entries(byDoc)) {
      ctx += `**From: ${name}**\n`;
      for (const chunk of chunks) {
        if (chunk.heading) ctx += `**${chunk.heading}** (p.${chunk.page})\n`;
        else if (chunk.page) ctx += `*(p.${chunk.page})*\n`;
        ctx += `${chunk.text}\n\n`;
      }
    }

    return ctx;
  }

  /**
   * Format expanded chunks (parent text or leaf fallback) for AI context.
   * Groups by document and uses the pre-expanded _displayText/_displayHeading.
   * @private
   */
  _formatExpandedChunks(selected) {
    if (!selected.length) return "";

    // Separate direct results from cross-reference hops and neighbors
    const direct = selected.filter(s => !s._isHop && !s._isNeighbor);
    const hops   = selected.filter(s => s._isHop);
    const neighbors = selected.filter(s => s._isNeighbor);

    // Group by document
    const formatGroup = (items) => {
      const byDoc = {};
      for (const item of items) {
        if (!byDoc[item.docId]) byDoc[item.docId] = { name: item.docName, entries: [] };
        byDoc[item.docId].entries.push({
          heading: item._displayHeading || item.chunk?.heading || "",
          text:    item._displayText || item.chunk?.text || "",
          page:    item._page ?? item.chunk?.page ?? 0,
          type:    item.chunk?.sectionType || "",
        });
      }

      let ctx = "";
      for (const [, { name, entries }] of Object.entries(byDoc)) {
        ctx += `**From: ${name}**\n`;
        for (const entry of entries) {
          if (entry.heading) ctx += `**${entry.heading}** (p.${entry.page})\n`;
          else if (entry.page) ctx += `*(p.${entry.page})*\n`;
          ctx += `${entry.text}\n\n`;
        }
      }
      return ctx;
    };

    let ctx = formatGroup(direct);

    // Add cross-referenced content with a clear label so the AI
    // understands this was pulled because the primary results mention it
    if (hops.length > 0) {
      ctx += `\n**[Cross-Referenced Sections]** *(pulled automatically because the above text references these)*\n\n`;
      ctx += formatGroup(hops);
    }

    // Add neighbor sections — adjacent rooms/sections for surrounding context
    if (neighbors.length > 0) {
      ctx += `\n**[Adjacent Sections]** *(nearby content from the same document for surrounding context)*\n\n`;
      ctx += formatGroup(neighbors);
    }

    return ctx;
  }

  // ── Conversation-Aware Search ─────────────────────────────

  /**
   * Extract entities (rooms, NPCs, locations) from the last AI response
   * and inject them as supplemental search terms. This enables follow-up
   * queries like "what about that NPC?" or "tell me more about that room"
   * to find relevant content even when the user's message is vague.
   *
   * @param {string} assistantMsg - Last AI response text
   * @param {Object} analysis - The QueryAnalysis to enrich
   * @returns {string[]} List of entities that were added
   * @private
   */
  _extractConversationEntities(assistantMsg, analysis) {
    const added = [];
    if (!assistantMsg) return added;

    // Truncate to last ~1500 chars to focus on recent content
    const text = assistantMsg.length > 1500
      ? assistantMsg.slice(-1500)
      : assistantMsg;

    // Extract room IDs from the AI's last response
    const rxRoom = /\b([A-Z]\d{1,3}[a-z]?)\b/g;
    let m;
    while ((m = rxRoom.exec(text)) !== null) {
      const id = m[1];
      if (!analysis.entities.rooms.includes(id)) {
        analysis.entities.rooms.push(id);
        analysis.expandedTerms.push(id.toLowerCase());
        added.push(`room:${id}`);
      }
    }

    // Extract named room references: "area 12", "room 3b"
    const rxNamedRoom = /\b(?:area|room|chamber)\s+(\d{1,3}[a-z]?)\b/gi;
    while ((m = rxNamedRoom.exec(text)) !== null) {
      const id = m[1];
      if (!analysis.entities.rooms.includes(id)) {
        analysis.entities.rooms.push(id);
        analysis.expandedTerms.push(id.toLowerCase());
        added.push(`room:${id}`);
      }
    }

    // Extract proper nouns (potential NPCs/locations) — capitalized multi-word names
    const rxNames = /\b([A-Z][a-z]{2,}(?:\s+(?:von|van|de|the|of)\s+)?(?:[A-Z][a-z]{2,})?)\b/g;
    const skipWords = new Set([
      "The", "This", "That", "They", "Their", "There", "These", "Those",
      "You", "Your", "Would", "Could", "Should", "Perhaps", "However",
      "Additionally", "Furthermore", "Meanwhile", "Although", "Within",
    ]);
    while ((m = rxNames.exec(text)) !== null) {
      const name = m[1].trim();
      if (name.length < 4 || skipWords.has(name.split(/\s/)[0])) continue;
      // Only add if not already in entities
      const lower = name.toLowerCase();
      if (!analysis.expandedTerms.includes(lower)) {
        analysis.expandedTerms.push(lower);
        added.push(`entity:${name}`);
      }
    }

    // Cap additions to avoid polluting the search with noise
    if (added.length > 8) added.length = 8;

    return added;
  }

  // ── Scene-Aware Boosting ────────────────────────────────────

  /**
   * Extract room IDs from the current Foundry scene name.
   * Many GMs name scenes like "Castle Ravenloft - K15 Chapel" or
   * "Dungeon Level 2 - Room 23". This pulls those IDs so they
   * automatically get priority in search results.
   *
   * @param {string} sceneName - Current Foundry scene name
   * @returns {string[]} Room IDs found in the scene name
   * @private
   */
  _extractSceneRoomIds(sceneName) {
    if (!sceneName || sceneName.length < 2) return [];
    const ids = [];

    // Lettered room IDs: K15, E4, T3
    const rxLettered = /\b([A-Z]\d{1,3}[a-z]?)\b/g;
    let m;
    while ((m = rxLettered.exec(sceneName)) !== null) {
      ids.push(m[1]);
    }

    // Named room references: "Room 12", "Area 3b"
    const rxNamed = /\b(?:area|room|chamber)\s+(\d{1,3}[a-z]?)\b/gi;
    while ((m = rxNamed.exec(sceneName)) !== null) {
      ids.push(m[1]);
    }

    return [...new Set(ids)];
  }

  // ── Summary / Stats ───────────────────────────────────────

  /**
   * Get entities discovered during the most recent document search.
   * Used for cross-store linking — the panel reads these after
   * buildDocumentContext() to do supplemental NPC/reputation lookups.
   * @returns {{ rooms: string[], npcs: string[], locations: string[], headingNames: string[] }}
   */
  getLastSearchEntities() {
    return this._lastSearchEntities ?? { rooms: [], npcs: [], locations: [], headingNames: [] };
  }

  /**
   * Get a summary of the document library.
   * @returns {{ total: number, enabled: number, chunks: number, images: number }}
   */
  getLibrarySummary() {
    return this._mm?.documents?.getStats() ?? {
      totalDocuments: 0,
      enabledDocuments: 0,
      totalChunks: 0,
      totalImages: 0,
    };
  }

  // ── Document Cache (Global, Cross-World) ────────────────────

  /**
   * Save a document record to the global cache folder.
   * Stored at ace-engine-library/documents/{sanitized-filename}.json
   * This persists across worlds and survives "Remove from Library".
   * @param {Object} docRecord - Full document record from the store
   */
  async saveDocumentCache(docRecord) {
    if (!docRecord?.fileName) return;

    try {
      // Ensure directories exist
      try { await _FP().createDirectory("data", "ace-engine-library"); } catch { /* exists */ }
      try { await _FP().createDirectory("data", GLOBAL_CACHE_DIR); } catch { /* exists */ }

      const cacheEntry = {
        version:      2,
        chunkVersion: docRecord.chunkVersion ?? 1,
        cachedAt:     new Date().toISOString(),
        fileName:     docRecord.fileName,
        displayName:  docRecord.displayName,
        type:         docRecord.type,
        fileSize:     docRecord.fileSize,
        pageCount:    docRecord.pageCount ?? 0,
        tags:         docRecord.tags ?? [],
        chunks:       docRecord.chunks ?? [],
        parents:      docRecord.parents ?? [],
        images:       docRecord.images ?? [],
        embeddings:   docRecord.embeddings ?? null,
      };

      const safeName = this._safeCacheFileName(docRecord.fileName);
      const blob = new Blob([JSON.stringify(cacheEntry, null, 2)], { type: "application/json" });
      const file = new File([blob], safeName, { type: "application/json" });
      await _silentUpload("data", GLOBAL_CACHE_DIR, file);

      console.log(`${MODULE_ID} | Cached document: ${docRecord.displayName} → ${GLOBAL_CACHE_DIR}/${safeName}`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to cache document ${docRecord.displayName}:`, err);
    }
  }

  /**
   * Check if a cached extraction exists for a given filename.
   * @param {string} fileName - Original upload filename (e.g., "Curse-of-Strahd.pdf")
   * @returns {Promise<Object|null>} Cached document data, or null if not found
   */
  async loadDocumentCache(fileName) {
    if (!fileName) return null;

    try {
      const safeName = this._safeCacheFileName(fileName);
      const url = `${GLOBAL_CACHE_DIR}/${safeName}`;
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) return null;

      const data = await resp.json();
      if (data?.version && data?.chunks) {
        console.log(`${MODULE_ID} | Found cached extraction for "${fileName}" (${data.chunks.length} chunks, cached ${data.cachedAt})`);
        return data;
      }
      return null;
    } catch {
      return null; // no cache file — that's fine
    }
  }

  /**
   * Scan the global cache folder and return all cached document entries.
   * @returns {Promise<Array<{fileName: string, displayName: string, type: string, cachedAt: string, chunks: number, safeName: string}>>}
   */
  async scanDocumentCache() {
    try {
      const result = await _FP().browse("data", GLOBAL_CACHE_DIR);
      const files = result?.files ?? [];
      const entries = [];

      for (const filePath of files) {
        if (!filePath.endsWith(".json")) continue;
        try {
          const resp = await fetch(filePath, { cache: "no-store" });
          if (!resp.ok) continue;
          const data = await resp.json();
          if (data?.version && data?.fileName) {
            entries.push({
              fileName:    data.fileName,
              displayName: data.displayName ?? data.fileName,
              type:        data.type ?? "unknown",
              cachedAt:    data.cachedAt ?? "unknown",
              pageCount:   data.pageCount ?? 0,
              chunkCount:  data.chunks?.length ?? 0,
              filePath,
            });
          }
        } catch { /* skip corrupted cache files */ }
      }

      console.log(`${MODULE_ID} | Document cache scan: found ${entries.length} cached document(s)`);
      return entries;
    } catch {
      return []; // folder doesn't exist yet — no cache
    }
  }

  /**
   * Convert a filename into a safe JSON cache filename.
   * "Curse of Strahd.pdf" → "curse-of-strahd-pdf.json"
   * @private
   */
  _safeCacheFileName(fileName) {
    return fileName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      + ".json";
  }
}
