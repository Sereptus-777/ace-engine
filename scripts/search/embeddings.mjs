// ============================================================
// ACE — AI Campaign Engine — Embedding Engine (Phase 5)
// Uses Ollama's nomic-embed-text for semantic vector search.
// Embeddings are generated at upload time and stored on disk.
// At query time, cosine similarity finds conceptual matches
// that keyword search (BM25/regex) would miss.
// ============================================================

const EMBED_MODEL    = "nomic-embed-text";
const DIMENSIONS     = 768;
const DEFAULT_URL    = "http://localhost:11434";
const CHECK_TIMEOUT  = 3000;   // ms to wait when probing Ollama
const BATCH_YIELD    = 10;     // yield to UI every N embeddings

// ── Cosine Similarity ────────────────────────────────────────

/**
 * Compute cosine similarity between two Float32Arrays.
 * Returns a value between -1 and 1 (1 = identical meaning).
 */
export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Serialization (Float32Array ↔ base64) ────────────────────

/**
 * Serialize a Float32Array to a base64 string for JSON storage.
 * 768 floats × 4 bytes = 3072 bytes → ~4096 chars base64.
 */
export function serializeVector(vec) {
  const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  // Process in 8KB slices to avoid call stack limits with String.fromCharCode
  let binary = "";
  const SLICE = 8192;
  for (let i = 0; i < bytes.length; i += SLICE) {
    const chunk = bytes.subarray(i, Math.min(i + SLICE, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Deserialize a base64 string back to Float32Array.
 */
export function deserializeVector(base64str) {
  const binary = atob(base64str);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

// ── EmbeddingEngine ──────────────────────────────────────────

export class EmbeddingEngine {
  /**
   * @param {Object} opts
   * @param {string} [opts.model]   - Ollama embedding model name
   * @param {string} [opts.baseUrl] - Ollama API base URL
   */
  constructor({ model = EMBED_MODEL, baseUrl = DEFAULT_URL } = {}) {
    this._model   = model;
    this._baseUrl = baseUrl.replace(/\/+$/, ""); // strip trailing slash
    this._available = null; // null = not checked, true/false = checked
  }

  /** @returns {boolean} Whether Ollama + the embedding model is available */
  get available() { return this._available === true; }

  /**
   * Probe Ollama to see if the embedding model is available.
   * Sends a tiny test embedding. Caches the result.
   * @returns {Promise<boolean>}
   */
  async checkAvailability() {
    if (this._available !== null) return this._available;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

      const res = await fetch(`${this._baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this._model, prompt: "test" }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        console.warn(`ACE Embeddings | Ollama returned ${res.status} — embeddings disabled`);
        this._available = false;
        return false;
      }

      const data = await res.json();
      if (!data.embedding || data.embedding.length !== DIMENSIONS) {
        console.warn(`ACE Embeddings | Unexpected dimensions: ${data.embedding?.length} (expected ${DIMENSIONS})`);
        this._available = false;
        return false;
      }

      console.log(`ACE Embeddings | ${this._model} available (${DIMENSIONS}d vectors)`);
      this._available = true;
      return true;

    } catch (err) {
      if (err.name === "AbortError") {
        console.log("ACE Embeddings | Ollama not responding (timeout) — embeddings disabled");
      } else {
        console.log(`ACE Embeddings | Ollama not available: ${err.message} — embeddings disabled`);
      }
      this._available = false;
      return false;
    }
  }

  /**
   * Reset availability check (e.g., if user starts Ollama mid-session).
   */
  resetAvailability() {
    this._available = null;
  }

  /**
   * Embed a single text string.
   * @param {string} text
   * @returns {Promise<Float32Array>}
   */
  async embed(text) {
    const res = await fetch(`${this._baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this._model, prompt: text }),
    });

    if (!res.ok) {
      throw new Error(`Embedding failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return new Float32Array(data.embedding);
  }

  /**
   * Embed a batch of texts (sequentially — Ollama processes one at a time).
   * Yields to the event loop every BATCH_YIELD items to keep UI responsive.
   *
   * @param {string[]} texts - Array of text strings to embed
   * @param {Function} [onProgress] - Callback: (current, total) => void
   * @returns {Promise<Float32Array[]>}
   */
  async embedBatch(texts, onProgress = null) {
    const vectors = [];

    for (let i = 0; i < texts.length; i++) {
      const vec = await this.embed(texts[i]);
      vectors.push(vec);

      if (onProgress) onProgress(i + 1, texts.length);

      // Yield to UI every N embeddings
      if ((i + 1) % BATCH_YIELD === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    return vectors;
  }

  /**
   * Search stored vectors by cosine similarity against a query vector.
   *
   * @param {Float32Array} queryVec - The query embedding
   * @param {Array<{id: string, vector: Float32Array, meta?: Object}>} corpus - Stored vectors
   * @param {number} [maxResults=25]
   * @param {number} [minScore=0.3] - Minimum cosine similarity to include
   * @returns {Array<{id: string, score: number, meta: Object}>}
   */
  searchVectors(queryVec, corpus, maxResults = 25, minScore = 0.3) {
    const results = [];

    for (const item of corpus) {
      const score = cosineSimilarity(queryVec, item.vector);
      if (score >= minScore) {
        results.push({ id: item.id, score, meta: item.meta ?? {} });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }
}
