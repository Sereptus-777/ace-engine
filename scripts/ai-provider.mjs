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
  async chat(userMessage, sceneContext = "", npcMemory = "", history = [], images = []) {
    let messages = this._buildMessages(userMessage, sceneContext, npcMemory, history);
    messages = this._applyVisionImages(messages, images);

    switch (this.config.provider) {
      case "ollama":
        return this._chatOllama(messages);
      case "lmstudio":
        return this._chatOpenAICompat(messages, `${this.config.apiUrl}/v1/chat/completions`);
      case "openai":
        return this._chatOpenAICompat(messages, "https://api.openai.com/v1/chat/completions");
      case "openrouter":
        return this._chatOpenAICompat(messages, "https://openrouter.ai/api/v1/chat/completions");
      case "anthropic":
        return this._chatAnthropic(messages);
      case "custom":
        return this._chatOpenAICompat(messages, `${this.config.apiUrl}/v1/chat/completions`);
      default:
        throw new Error(`Unknown AI provider: ${this.config.provider}`);
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

  // ── Message Builder ──────────────────────────────────────

  _buildMessages(userMessage, sceneContext, npcMemory, history) {
    const systemPrompt = game.settings.get(MODULE_ID, "systemPrompt");
    const gameSystem = AceSettings.getGameSystemName();

    let fullSystem = systemPrompt;
    fullSystem += `\n\n## GAME SYSTEM\nThe current game system is: **${gameSystem}**. Answer rules questions for this system.`;
    if (sceneContext) fullSystem += `\n\n## CURRENT SCENE STATE\n${sceneContext}`;
    if (npcMemory) fullSystem += `\n\n## NPC MEMORY & HISTORY\n${npcMemory}`;

    return [
      { role: "system", content: fullSystem },
      ...history,
      { role: "user", content: userMessage },
    ];
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
    try { return game.settings.get(MODULE_ID, "maxResponseTokens"); }
    catch { return 2048; }
  }

  // ── Ollama ────────────────────────────────────────────────

  async _chatOllama(messages) {
    const url = `${this.config.apiUrl}/api/chat`;
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.config.modelName, messages, stream: false }),
      });
    } catch (fetchErr) {
      throw this._corsError(url, fetchErr);
    }
    if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return data.message?.content ?? "";
  }

  async _streamOllama(messages, onChunk) {
    const url = `${this.config.apiUrl}/api/chat`;
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.config.modelName, messages, stream: true }),
      });
    } catch (fetchErr) {
      throw this._corsError(url, fetchErr);
    }
    if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);

    let fullText = "";
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n").filter(Boolean)) {
        try {
          const json = JSON.parse(line);
          const token = json.message?.content ?? "";
          if (token) { fullText += token; onChunk(token); }
        } catch { /* partial JSON */ }
      }
    }
    return fullText;
  }

  // ── OpenAI-compatible ─────────────────────────────────────

  async _chatOpenAICompat(messages, url) {
    const headers = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.modelName, messages,
        stream: false, max_tokens: this._maxTokens(),
      }),
    });
    if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  async _streamOpenAICompat(messages, url, onChunk) {
    const headers = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.modelName, messages,
        stream: true, max_tokens: this._maxTokens(),
      }),
    });
    if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`);

    let fullText = "";
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const json = JSON.parse(line.slice(6));
          const token = json.choices?.[0]?.delta?.content ?? "";
          if (token) { fullText += token; onChunk(token); }
        } catch { /* skip */ }
      }
    }
    return fullText;
  }

  // ── Anthropic ─────────────────────────────────────────────

  async _chatAnthropic(messages) {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const chatMessages = messages.filter((m) => m.role !== "system");

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
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
    });
    if (!resp.ok) throw new Error(`Anthropic error ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return data.content?.map((c) => c.text).join("") ?? "";
  }

  async _streamAnthropic(messages, onChunk) {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const chatMessages = messages.filter((m) => m.role !== "system");

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
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
    });
    if (!resp.ok) throw new Error(`Anthropic error ${resp.status}: ${await resp.text()}`);

    let fullText = "";
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const json = JSON.parse(line.slice(6));
          if (json.type === "content_block_delta") {
            const token = json.delta?.text ?? "";
            if (token) { fullText += token; onChunk(token); }
          }
        } catch { /* skip */ }
      }
    }
    return fullText;
  }

  // ── Helpers ───────────────────────────────────────────────

  _corsError(url, fetchErr) {
    const origin = window.location.origin;
    if (origin && !url.startsWith(origin) && /localhost|127\.0\.0\.1/.test(url)) {
      return new Error(
        `Cannot reach Ollama at ${url} from ${origin}.\n` +
        `This is a CORS issue — your browser blocks cross-origin requests to localhost.\n` +
        `Fix: Set environment variable OLLAMA_ORIGINS=${origin} (or OLLAMA_ORIGINS=*) and restart Ollama.`
      );
    }
    return new Error(`Failed to connect to ${url}: ${fetchErr.message}`);
  }
}
