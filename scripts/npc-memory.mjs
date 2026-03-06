// ============================================================
// ACE — AI Campaign Engine — NPC Memory Reader
// Reads [AI Memory] journals created by NPCLink/ACE: Envoy
// Falls back to ace-envoy API if available
// ============================================================

import { MODULE_ID } from "./ace-engine.mjs";

export class NpcMemoryReader {
  constructor() {
    this._cache = new Map();
    this._cacheTime = 0;
    this._cacheTTL = 30000;
  }

  invalidate() { this._cache.clear(); this._cacheTime = 0; }

  isAvailable() {
    return (game.modules.get("ace-envoy")?.active ?? false)
        || (game.modules.get("npclink")?.active ?? false);
  }

  getAllMemories(maxTokens = 2000) {
    // Try ace-envoy API first
    const envoy = game.modules.get("ace-envoy")?.active
      ? game.modules.get("ace-envoy").api : null;
    if (envoy?.getConversationHistory) {
      try {
        const history = envoy.getConversationHistory();
        if (history) return history;
      } catch { /* fall through to journal reader */ }
    }

    // Fallback: read [AI Memory] journals
    if (!this._hasMemoryJournals()) return "";

    const memories = this._gatherMemories();
    if (!memories.length) return "";

    const lines = ["### NPC Memories"];
    let charCount = 0;
    for (const mem of memories) {
      const block = `\n**${mem.npcName}:**\n${mem.content}`;
      if (charCount + block.length > maxTokens * 4) break;
      lines.push(block);
      charCount += block.length;
    }
    return lines.join("\n");
  }

  getMemoryFor(npcName) {
    const envoy = game.modules.get("ace-envoy")?.active
      ? game.modules.get("ace-envoy").api : null;
    if (envoy?.getNpcProfile) {
      try {
        const profile = envoy.getNpcProfile(npcName);
        if (profile) return profile;
      } catch { /* fall through */ }
    }

    const memories = this._gatherMemories();
    const match = memories.find((m) => m.npcName.toLowerCase() === npcName.toLowerCase());
    return match?.content ?? "";
  }

  getSceneNpcMemories() {
    if (!this.isAvailable() && !this._hasMemoryJournals()) return "";

    const sceneTokenNames = new Set(
      (canvas?.scene?.tokens ?? []).map((t) => t.name.toLowerCase())
    );
    if (!sceneTokenNames.size) return "";

    const memories = this._gatherMemories().filter((m) =>
      sceneTokenNames.has(m.npcName.toLowerCase())
    );
    if (!memories.length) return "";

    const lines = ["### NPC Memories (Scene NPCs)"];
    for (const mem of memories) {
      lines.push(`\n**${mem.npcName}:**\n${mem.content}`);
    }
    return lines.join("\n");
  }

  // ── Private ───────────────────────────────────────────────

  _hasMemoryJournals() {
    return game.journal?.contents?.some((j) => j.name.startsWith("[AI Memory]")) ?? false;
  }

  _gatherMemories() {
    const now = Date.now();
    if (this._cache.size > 0 && now - this._cacheTime < this._cacheTTL) {
      return Array.from(this._cache.values());
    }

    this._cache.clear();
    const journals = game.journal?.contents ?? [];

    for (const journal of journals) {
      if (!journal.name.startsWith("[AI Memory]")) continue;
      const npcName = journal.name.replace("[AI Memory]", "").trim();
      if (!npcName) continue;

      const content = this._getJournalContent(journal);
      if (!content) continue;

      this._cache.set(npcName.toLowerCase(), {
        npcName,
        journalId: journal.id,
        content: content.trim(),
      });
    }

    this._cacheTime = now;
    return Array.from(this._cache.values());
  }

  _getJournalContent(journal) {
    const pages = journal.pages?.contents ?? [];
    if (!pages.length) return "";
    return pages
      .filter((p) => p.type === "text")
      .map((p) => {
        const html = p.text?.content ?? "";
        return this._stripHtml(html);
      })
      .filter(Boolean)
      .join("\n\n");
  }

  _stripHtml(html) {
    if (!html) return "";
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent?.trim() ?? "";
  }
}
