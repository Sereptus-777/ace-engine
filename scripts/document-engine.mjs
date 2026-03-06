// ============================================================
// ACE — AI Campaign Engine — Document Engine
// Handles PDF.js integration, text extraction, chunking,
// relevance scoring, and context building for the Document
// Library reference system.
// ============================================================

import { extractKeywords } from "./document-store.mjs";

const MODULE_ID = "ace-engine";

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


// ── Chunking ─────────────────────────────────────────────────

const TARGET_CHUNK_SIZE = 800;   // chars (~200 tokens)
const MIN_CHUNK_SIZE    = 100;
const OVERLAP_CHARS     = 50;

// Heading detection patterns
const HEADING_PATTERNS = [
  /^(?:chapter|section|part|appendix)\s+[\divxlc]+[.:)—\s]/i,
  /^[A-Z][A-Z\s]{4,60}$/,          // ALL CAPS lines
  /^\d+\.\d*\s+[A-Z]/,             // "1.2 Title" pattern
  /^#{1,3}\s+/,                     // Markdown headings
  /^(?:introduction|conclusion|overview|summary|appendix)\b/i,
];

/**
 * Split text into heading-delimited sections.
 * @param {string} text
 * @returns {Array<{heading: string, body: string}>}
 */
function splitByHeadings(text) {
  const lines = text.split(/\n/);
  const sections = [];
  let currentHeading = "";
  let currentBody = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeading = HEADING_PATTERNS.some(p => p.test(trimmed));

    if (isHeading && currentBody.length > 0) {
      sections.push({ heading: currentHeading, body: currentBody.join(" ").trim() });
      currentHeading = trimmed.replace(/^#{1,3}\s*/, "");
      currentBody = [];
    } else if (isHeading && currentBody.length === 0) {
      currentHeading = trimmed.replace(/^#{1,3}\s*/, "");
    } else {
      currentBody.push(trimmed);
    }
  }

  // Last section
  if (currentBody.length > 0) {
    sections.push({ heading: currentHeading, body: currentBody.join(" ").trim() });
  }

  // If no headings were found, return entire text as one section
  if (sections.length === 0 && text.trim().length > 0) {
    sections.push({ heading: "", body: text.trim() });
  }

  return sections;
}

/**
 * Split text at sentence boundaries to stay under maxChars.
 * @param {string} text
 * @param {number} maxChars
 * @param {number} overlap - chars to overlap between chunks
 * @returns {string[]}
 */
function splitAtSentences(text, maxChars, overlap) {
  if (text.length <= maxChars) return [text];

  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) ?? [text];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      // Start new chunk with overlap from end of previous
      const overlapText = current.slice(-overlap);
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
 * Convert extracted page text into searchable chunks.
 * Uses a hybrid heading-aware + fixed-size approach.
 * @param {Array<{page: number, text: string}>} pages
 * @returns {Array<{idx, page, heading, text, tags}>}
 */
export function chunkPages(pages) {
  const chunks = [];
  let idx = 0;

  for (const { page, text } of pages) {
    if (!text || text.length < MIN_CHUNK_SIZE) continue;

    const sections = splitByHeadings(text);

    for (const { heading, body } of sections) {
      if (!body || body.length < MIN_CHUNK_SIZE) continue;

      const subChunks = splitAtSentences(body, TARGET_CHUNK_SIZE, OVERLAP_CHARS);

      for (const subText of subChunks) {
        if (subText.length < MIN_CHUNK_SIZE) continue;
        chunks.push({
          idx:     idx++,
          page,
          heading: heading || "",
          text:    subText,
          tags:    extractKeywords(subText, 8),
        });
      }
    }
  }

  return chunks;
}

/**
 * Chunk a text/markdown file into searchable chunks.
 * @param {string} text
 * @param {string} type - "txt" or "md"
 * @returns {Array<{idx, page, heading, text, tags}>}
 */
export function chunkTextFile(text, type = "txt") {
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
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
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
  chunkPages(pages) {
    return chunkPages(pages);
  }

  /** Chunk a text/markdown file. */
  chunkTextFile(text, type) {
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
   * @returns {string} Formatted context block, or ""
   */
  buildDocumentContext(sceneContext = "", userMessage = "", currentScene = "", maxChars = 2000) {
    const store = this._mm?.documents;
    if (!store) return "";

    // 1. Build query keywords from user message + scene context
    const queryKeywords = this._extractQueryKeywords(userMessage, sceneContext, currentScene);
    if (!queryKeywords.length) return "";

    let digestCtx = "";
    let digestCharsUsed = 0;

    // 2. Try digest-based context first (structured, high quality)
    const activeDigestIds = store.getActiveDigests();
    if (activeDigestIds.length && this._digestEngine) {
      const digestBudget = Math.floor((maxChars - 300) * 0.7); // 70% for digests
      const result = this._digestEngine.buildDigestContext(activeDigestIds, queryKeywords, digestBudget);
      digestCtx = result.text;
      digestCharsUsed = result.charsUsed;
    }

    // 3. Fill remaining budget with raw chunk matches (fallback/supplement)
    let chunkCtx = "";
    const enabledDocs = store.getEnabled();
    if (enabledDocs.length) {
      const chunkBudget = maxChars - digestCharsUsed - 300;
      if (chunkBudget > 200) {
        const scored = store.searchChunks(queryKeywords, 25);
        if (scored.length) {
          const selected = this._selectWithinBudget(scored, chunkBudget);
          if (selected.length) {
            chunkCtx = this._formatChunks(selected);
          }
        }
      }
    }

    if (!digestCtx && !chunkCtx) return "";

    // 4. Assemble final context block
    let ctx = "\n\n## REFERENCE LIBRARY\n\n";
    ctx += "The following information comes from the GM's reference documents. ";
    ctx += "Use this as background knowledge — do not quote it directly to players.\n\n";

    if (digestCtx) {
      ctx += "### Structured Reference Data\n";
      ctx += digestCtx;
    }
    if (chunkCtx) {
      ctx += chunkCtx;
    }

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

    // From user message: extract non-stop-word tokens
    if (userMessage) {
      keywords.push(...extractKeywords(userMessage, 12));
    }

    // From scene name
    if (currentScene) {
      const sceneWords = currentScene.toLowerCase()
        .split(/[\s_-]+/)
        .filter(w => w.length > 2);
      keywords.push(...sceneWords);
    }

    // From scene context: extract proper nouns (capitalized words 3+ chars)
    if (sceneContext) {
      const names = sceneContext.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
      keywords.push(...names.map(n => n.toLowerCase()).slice(0, 15));
    }

    // Deduplicate
    return [...new Set(keywords)];
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

  // ── Summary / Stats ───────────────────────────────────────

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
}
