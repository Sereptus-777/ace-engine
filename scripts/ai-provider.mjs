// ============================================================
// ACE — AI Campaign Engine — AI Provider Abstraction
// Supports: Ollama, LM Studio, OpenAI, Anthropic, OpenRouter,
//           and any OpenAI-compatible endpoint
// ============================================================

import { MODULE_ID } from "./ace-engine.mjs";
import { AceSettings } from "./settings.mjs";

export class AiProvider {
  constructor() {
    this.config = {};
    this.refreshConfig();
  }

  refreshConfig() {
    this.config = AceSettings.getProviderConfig();
    if (game.settings?.get?.(MODULE_ID, "debugMode")) {
      console.log(`${MODULE_ID} | AI Provider: ${this.config.provider} → ${this.config.modelName}`);
    }
  }

  /**
   * Send a chat completion request.
   * @param {string} userMessage
   * @param {string} sceneContext
   * @param {string} [npcMemory]
   * @param {Array} [history]
   * @returns {Promise<string>}
   */
  async chat(userMessage, sceneContext = "", npcMemory = "", history = [], images = [], options = {}) {
    if (options.maxTokens) this._maxTokensOverride = options.maxTokens;
    if (options.timeout) this._timeoutOverride = options.timeout;
    let messages = this._buildMessages(userMessage, sceneContext, npcMemory, history);
    messages = this._applyVisionImages(messages, images);

    try {
      switch (this.config.provider) {
        case "ollama":
          return await this._chatOllama(messages);
        case "lmstudio":
          return await this._chatOpenAICompat(messages, `${this.config.apiUrl}/v1/chat/completions`);
        case "openai":
          return await this._chatOpenAICompat(messages, "https://api.openai.com/v1/chat/completions");
        case "openrouter":
          return await this._chatOpenAICompat(messages, "https://openrouter.ai/api/v1/chat/completions");
        case "anthropic":
          return await this._chatAnthropic(messages);
        case "custom":
          return await this._chatOpenAICompat(messages, `${this.config.apiUrl}/v1/chat/completions`);
        default:
          throw new Error(`Unknown AI provider: ${this.config.provider}`);
      }
    } finally {
      this._maxTokensOverride = null;
      this._timeoutOverride = null;
    }
  }

  /**
   * Stream a chat completion via callback.
   * @param {string} userMessage
   * @param {string} sceneContext
   * @param {string} npcMemory
   * @param {Array} history
   * @param {function} onChunk
   * @returns {Promise<string>}
   */
  async chatStream(userMessage, sceneContext = "", npcMemory = "", history = [], onChunk = () => {}, images = []) {
    let messages = this._buildMessages(userMessage, sceneContext, npcMemory, history);
    messages = this._applyVisionImages(messages, images);

    switch (this.config.provider) {
      case "ollama":
        return this._streamOllama(messages, onChunk);
      case "lmstudio":
      case "openai":
      case "openrouter":
      case "custom": {
        const url = this.config.provider === "openai"
          ? "https://api.openai.com/v1/chat/completions"
          : this.config.provider === "openrouter"
            ? "https://openrouter.ai/api/v1/chat/completions"
            : `${this.config.apiUrl}/v1/chat/completions`;
        return this._streamOpenAICompat(messages, url, onChunk);
      }
      case "anthropic":
        return this._streamAnthropic(messages, onChunk);
      default: {
        const text = await this.chat(userMessage, sceneContext, npcMemory, history);
        onChunk(text);
        return text;
      }
    }
  }

  // ── Capabilities Section (self-awareness) ───────────────

  _buildCapabilitiesSection() {
    const hasEnvoy = game.modules.get("ace-envoy")?.active;
    const hasTrapmaster = game.modules.get("ace-trapmaster")?.active;

    let section = `\n\n## YOUR CAPABILITIES
You are ACE — the GM's AI Campaign Engine running inside Foundry VTT. When relevant, proactively suggest the GM use these features:

- **Select Tab → Tactical Command Center**: The GM can select tokens (players, NPCs, creatures) and:
  - Roll group skill checks, saves, or attacks with a configurable DC — these are **Subtle Rolls** the players cannot see, perfect for passive Perception, Insight, hidden dangers
  - View quick stats (HP, AC, Speed, Conditions) for selected tokens
  - Apply/remove conditions or damage/heal in bulk
  - Generate an AI biography for any NPC or creature token
  - Browse a token's inventory and generate AI bios for individual items or all items at once

- **Narration Tab**: Compose read-aloud text the GM can broadcast to all players with text-to-speech. Suggest narration for dramatic moments, scene transitions, NPC speeches, or environmental descriptions.

- **Ideas Tab**: Story suggestions auto-generate every ~2 minutes, or the GM can request them on demand. Suggest hooks, encounter twists, NPC motivations, and dramatic complications.

- **Encounter Tab**: Analyze the tactical situation during combat, suggest NPC tactics, evaluate encounter difficulty, and recommend adjustments.

- **Document Library**: The GM's uploaded sourcebooks and PDFs are available as reference. Use them to answer lore and rules questions.`;

    if (hasEnvoy) {
      section += `

- **ACE: Envoy** (installed): Players can have direct two-way conversations with NPCs. Suggest the GM initiate NPC contact when roleplay opportunities arise — Envoy opens a private chat window between a player and the NPC with full AI-driven responses.`;
    }

    if (hasTrapmaster) {
      section += `

- **ACE: Trapmaster** (installed): The GM can place and manage traps. When players approach suspicious areas, suggest checking for traps or remind the GM about placed traps in the scene.`;
    }

    section += `

When suggesting these features, be natural — weave them into your advice. For example: "A subtle Perception check on the party might reveal the ambush — try selecting the players in the Select tab" rather than listing features mechanically.

**CRITICAL**: ONLY reference characters and NPCs whose tokens are listed in the CURRENT SCENE STATE below. NEVER invent, fabricate, or assume character names. If no tokens are listed, do not suggest rolls or actions for specific characters.`;

    return section;
  }

  // ── History Trimming ────────────────────────────────────

  /**
   * Trim chat history to fit within a character budget.
   * Drops oldest messages first, always keeps at least the last 4 exchanges.
   * Prevents unbounded context growth that can exceed provider limits or rack up costs.
   * @param {Array} history — chat history messages
   * @param {number} budgetChars — max total characters (~3.5 chars per token)
   * @returns {Array} trimmed history
   */
  _trimHistory(history, budgetChars = 24000) {
    if (!history.length) return history;
    let total = history.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 200), 0);
    if (total <= budgetChars) return history;

    const trimmed = [...history];
    while (trimmed.length > 4 && total > budgetChars) {
      const removed = trimmed.shift();
      total -= typeof removed.content === "string" ? removed.content.length : 200;
    }
    console.log(`${MODULE_ID} | Trimmed chat history: ${history.length} → ${trimmed.length} messages (budget: ${budgetChars} chars)`);
    return trimmed;
  }

  // ── Message Builder ──────────────────────────────────────

  _buildMessages(userMessage, sceneContext, npcMemory, history) {
    const systemPrompt = game.settings.get(MODULE_ID, "systemPrompt");
    const gameSystem = AceSettings.getGameSystemName();

    let fullSystem = systemPrompt;
    fullSystem += `\n\n## GAME SYSTEM\nThe current game system is: **${gameSystem}**. Answer rules questions for this system.`;
    fullSystem += this._buildCapabilitiesSection();
    if (sceneContext) fullSystem += `\n\n## CURRENT SCENE STATE\n${sceneContext}`;

    // Split NPC memory from document library context (separated by "## REFERENCE LIBRARY")
    const libSplit = npcMemory.indexOf("\n\n## REFERENCE LIBRARY");
    const npcPart  = libSplit >= 0 ? npcMemory.slice(0, libSplit) : npcMemory;
    const libPart  = libSplit >= 0 ? npcMemory.slice(libSplit)    : "";
    if (npcPart.trim()) fullSystem += `\n\n## NPC MEMORY & HISTORY\n${npcPart}`;
    if (libPart.trim()) fullSystem += libPart;

    const trimmedHistory = this._trimHistory(history);

    const messages = [
      { role: "system", content: fullSystem },
      ...trimmedHistory,
      { role: "user", content: userMessage },
    ];

    // Log prompt size for performance debugging
    const totalChars = messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
    const estTokens  = Math.round(totalChars / 3.5);  // rough char-to-token estimate
    const trimNote   = trimmedHistory.length < history.length ? ` (trimmed from ${history.length})` : "";
    console.log(`${MODULE_ID} | Prompt: ~${totalChars.toLocaleString()} chars (~${estTokens.toLocaleString()} tokens) `
      + `| system: ${fullSystem.length.toLocaleString()} `
      + `| history: ${trimmedHistory.length} msgs${trimNote} `
      + `| library: ${libPart.length.toLocaleString()} chars`);

    return messages;
  }

  /**
   * Transform messages to include vision images for multimodal AI models.
   * Format differs per provider — Anthropic, OpenAI-compatible, and Ollama
   * each expect images in a different structure.
   *
   * @param {Array} messages - Standard text messages
   * @param {Array<{base64: string, mimeType: string}>} images - Image data
   * @returns {Array} Messages with images injected into the last user message
   */
  _applyVisionImages(messages, images) {
    if (!images?.length) return messages;

    // Clone to avoid mutating the original array
    const result = messages.map(m => ({ ...m }));
    // Find last user message
    let lastUser = null;
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === "user") { lastUser = result[i]; break; }
    }
    if (!lastUser) return result;

    const text = lastUser.content;
    const provider = this.config.provider;

    if (provider === "anthropic") {
      // Anthropic: content array with image blocks before text
      lastUser.content = [
        ...images.map(img => ({
          type: "image",
          source: { type: "base64", media_type: img.mimeType, data: img.base64 },
        })),
        { type: "text", text },
      ];
    } else if (provider === "ollama") {
      // Ollama: separate "images" field on the message
      lastUser.images = images.map(img => img.base64);
    } else {
      // OpenAI-compatible (openai, openrouter, lmstudio, custom)
      lastUser.content = [
        { type: "text", text },
        ...images.map(img => ({
          type: "image_url",
          image_url: {
            url: `data:${img.mimeType};base64,${img.base64}`,
            detail: "low",  // "low" saves tokens; "auto" for higher quality
          },
        })),
      ];
    }

    return result;
  }

  _maxTokens() {
    // Per-call override takes precedence (set by chat()/chatStream() options)
    if (this._maxTokensOverride) return this._maxTokensOverride;
    try { return game.settings.get(MODULE_ID, "maxResponseTokens"); }
    catch { return 2048; }
  }

  // ── Ollama ────────────────────────────────────────────────

  async _chatOllama(messages) {
    const url = `${this.config.apiUrl}/api/chat`;
    const resp = await this._safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.config.modelName, messages, stream: false, options: { num_predict: this._maxTokens() } }),
    }, "Ollama");
    await this._checkResponse(resp, "Ollama");
    const data = await resp.json();
    return data.message?.content ?? "";
  }

  async _streamOllama(messages, onChunk) {
    const url = `${this.config.apiUrl}/api/chat`;
    const resp = await this._safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.config.modelName, messages, stream: true, options: { num_predict: this._maxTokens() } }),
    }, "Ollama");
    await this._checkResponse(resp, "Ollama");

    if (!resp.body) throw new Error("Ollama returned an empty response body.");
    let fullText = "";
    let buffer = "";  // accumulate partial lines across chunk boundaries
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";  // last element is either "" or an incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          const token = json.message?.content ?? "";
          if (token) { fullText += token; onChunk(token); }
        } catch { /* malformed JSON line — skip */ }
      }
    }
    // Process any remaining buffered content
    if (buffer.trim()) {
      try {
        const json = JSON.parse(buffer);
        const token = json.message?.content ?? "";
        if (token) { fullText += token; onChunk(token); }
      } catch { /* incomplete final line */ }
    }
    return fullText;
  }

  // ── OpenAI-compatible ─────────────────────────────────────

  async _chatOpenAICompat(messages, url) {
    const providerName = this.config.provider === "openai" ? "OpenAI"
      : this.config.provider === "openrouter" ? "OpenRouter"
      : this.config.provider === "lmstudio" ? "LM Studio" : "AI Server";
    const headers = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

    const resp = await this._safeFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.modelName, messages,
        stream: false, max_tokens: this._maxTokens(),
      }),
    }, providerName);
    await this._checkResponse(resp, providerName);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  async _streamOpenAICompat(messages, url, onChunk) {
    const providerName = this.config.provider === "openai" ? "OpenAI"
      : this.config.provider === "openrouter" ? "OpenRouter"
      : this.config.provider === "lmstudio" ? "LM Studio" : "AI Server";
    const headers = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

    const resp = await this._safeFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.modelName, messages,
        stream: true, max_tokens: this._maxTokens(),
      }),
    }, providerName);
    await this._checkResponse(resp, providerName);

    if (!resp.body) throw new Error(`${providerName} returned an empty response body.`);
    let fullText = "";
    let buffer = "";  // accumulate partial SSE lines across chunk boundaries
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";  // keep incomplete trailing line
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const json = JSON.parse(line.slice(6));
          const token = json.choices?.[0]?.delta?.content ?? "";
          if (token) { fullText += token; onChunk(token); }
        } catch { /* malformed SSE line */ }
      }
    }
    // Flush remaining buffer
    if (buffer.startsWith("data: ") && buffer !== "data: [DONE]") {
      try {
        const json = JSON.parse(buffer.slice(6));
        const token = json.choices?.[0]?.delta?.content ?? "";
        if (token) { fullText += token; onChunk(token); }
      } catch { /* incomplete final line */ }
    }
    return fullText;
  }

  // ── Anthropic ─────────────────────────────────────────────

  /**
   * Merge consecutive messages with the same role into one message.
   * Anthropic's Messages API requires strictly alternating user/assistant roles.
   * Our chat history can contain back-to-back assistant messages from system notes,
   * tactics output, and crit/fumble injections — causing 400 errors.
   */
  _mergeConsecutiveRoles(messages) {
    if (!messages.length) return messages;
    const merged = [];
    for (const msg of messages) {
      const prev = merged.length ? merged[merged.length - 1] : null;
      if (prev && prev.role === msg.role && typeof prev.content === "string" && typeof msg.content === "string") {
        prev.content += "\n\n" + msg.content;
      } else {
        merged.push({ ...msg });
      }
    }
    return merged;
  }

  async _chatAnthropic(messages) {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const chatMessages = this._mergeConsecutiveRoles(messages.filter((m) => m.role !== "system"));
    // Always use Anthropic's URL — don't inherit apiUrl which may be set to another provider
    const baseUrl = "https://api.anthropic.com";

    const resp = await this._safeFetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: this.config.modelName || "claude-sonnet-4-20250514",
        max_tokens: this._maxTokens(),
        system,
        messages: chatMessages,
      }),
    }, "Anthropic");
    await this._checkResponse(resp, "Anthropic");
    const data = await resp.json();
    return data.content?.map((c) => c.text).join("") ?? "";
  }

  async _streamAnthropic(messages, onChunk) {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const chatMessages = this._mergeConsecutiveRoles(messages.filter((m) => m.role !== "system"));
    // Always use Anthropic's URL — don't inherit apiUrl which may be set to another provider
    const baseUrl = "https://api.anthropic.com";

    const resp = await this._safeFetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: this.config.modelName || "claude-sonnet-4-20250514",
        max_tokens: this._maxTokens(),
        system,
        messages: chatMessages,
        stream: true,
      }),
    }, "Anthropic");
    await this._checkResponse(resp, "Anthropic");

    if (!resp.body) throw new Error("Anthropic returned an empty response body.");
    let fullText = "";
    let buffer = "";  // accumulate partial SSE lines across chunk boundaries
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";  // keep incomplete trailing line
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const json = JSON.parse(line.slice(6));
          if (json.type === "content_block_delta") {
            const token = json.delta?.text ?? "";
            if (token) { fullText += token; onChunk(token); }
          }
        } catch { /* malformed SSE line */ }
      }
    }
    // Flush remaining buffer
    if (buffer.startsWith("data: ")) {
      try {
        const json = JSON.parse(buffer.slice(6));
        if (json.type === "content_block_delta") {
          const token = json.delta?.text ?? "";
          if (token) { fullText += token; onChunk(token); }
        }
      } catch { /* incomplete final line */ }
    }
    return fullText;
  }

  // ── Helpers ───────────────────────────────────────────────

  /**
   * Parse an HTTP error response into a human-readable message.
   * @private
   */
  _friendlyHttpError(status, rawBody, provider) {
    const body = (rawBody || "").slice(0, 300); // truncate huge JSON blobs
    switch (status) {
      case 401:
        return `Invalid API key — check your ${provider} key in ACE Engine settings.`;
      case 403:
        return `Access denied by ${provider}. Your API key may lack permissions or your account may be restricted.`;
      case 404:
        return `Model not found — "${this.config.modelName}" doesn't exist on ${provider}. Check the model name in settings.`;
      case 429:
        return `Rate limited by ${provider} — too many requests. Wait a moment and try again, or use a local model like Ollama.`;
      case 500:
      case 502:
      case 503:
        return `${provider} server error (${status}). The service may be overloaded — try again in a moment.`;
      default:
        return `${provider} error ${status}: ${body}`;
    }
  }

  /**
   * Wrap a fetch call with CORS detection and friendly error messages.
   * Works for all providers, not just Ollama.
   * @private
   */
  async _safeFetch(url, options, providerName) {
    try {
      // Add a timeout to prevent hung connections
      // Use extended timeout (5min) for large generation calls, 90s for normal
      const timeoutMs = this._timeoutOverride ?? 90_000;
      if (!options.signal) options.signal = AbortSignal.timeout(timeoutMs);
      return await fetch(url, options);
    } catch (fetchErr) {
      const origin = window.location.origin;
      if (/localhost|127\.0\.0\.1/.test(url) && origin && !url.startsWith(origin)) {
        throw new Error(
          `Can't reach ${providerName} at ${url}.\n` +
          `This is likely a CORS issue.` + (providerName === "Ollama"
            ? ` Fix: set environment variable OLLAMA_ORIGINS=${origin} (or OLLAMA_ORIGINS=*) and restart Ollama.`
            : ` Check that ${providerName} allows requests from ${origin}.`)
        );
      }
      if (fetchErr.message?.includes("Failed to fetch") || fetchErr instanceof TypeError) {
        throw new Error(
          `Can't connect to ${providerName} at ${url}. Check that:\n` +
          `• The server is running\n` +
          `• The URL is correct in ACE Engine settings\n` +
          `• Your network/firewall allows the connection`
        );
      }
      throw new Error(`${providerName} connection failed: ${fetchErr.message}`);
    }
  }

  /**
   * Check a response and throw a friendly error if not OK.
   * @private
   */
  async _checkResponse(resp, providerName) {
    if (resp.ok) return;
    const rawBody = await resp.text().catch(() => "");
    throw new Error(this._friendlyHttpError(resp.status, rawBody, providerName));
  }

}
