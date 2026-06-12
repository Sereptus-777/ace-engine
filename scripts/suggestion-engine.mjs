// ============================================================
// ACE — AI Campaign Engine — Story Direction Engine
// Generates 3 concise "what happens next" options for the GM
// ============================================================

import { MODULE_ID } from "./ace-engine.mjs";

const DIRECTION_PROMPT = `Based on the current scene and what the players have just accomplished, generate exactly 3 concise story direction options for the GM. Each option is a possible next step — where the players could go or what they could do, and what that leads to.

Requirements:
- EXACTLY 3 options, numbered 1 through 3
- Each must be SPECIFIC to the current scene, NPCs present, and recent events — never generic
- Title: 3-6 words, action-focused (e.g. "Pursue the fleeing cultists", "Search the hidden chamber")
- Description: 1 sentence — what happens or what they encounter if they take this path RIGHT NOW
- Consequence: 1 sentence — where this leads, what develops, or what changes in the story
- Think like a co-GM who knows the tone, the setting, and the stakes
- When involving NPCs, respect information boundaries — NPC-A should not react to a private conversation between a PC and NPC-B unless NPC-A has a plausible way to know (proximity, telepathy, faction, etc.)

Respond ONLY as a JSON array — no preamble, no explanation:
[
  {"id": "1", "title": "...", "description": "...", "consequence": "..."},
  {"id": "2", "title": "...", "description": "...", "consequence": "..."},
  {"id": "3", "title": "...", "description": "...", "consequence": "..."}
]`;

export class SuggestionEngine {
  constructor(aiProvider, sceneCtx, npcMemory) {
    this.ai = aiProvider;
    this.scene = sceneCtx;
    this.memory = npcMemory;
    this._interval = null;
    this._lastSuggestions = [];
    this._listeners = new Set();
    this._running = false;
    this._lastFingerprint = "";
  }

  on(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  _notify(suggestions) {
    this._lastSuggestions = suggestions;
    for (const cb of this._listeners) {
      try { cb(suggestions); } catch (e) { console.error(e); }
    }
  }

  get lastSuggestions() { return this._lastSuggestions; }

  start() {
    if (this._interval) return;  // already running — don't double-up
    this._running = true;
    const intervalSec = game.settings.get(MODULE_ID, "suggestionInterval") || 120;
    this._interval = setInterval(() => this.generateSuggestions("", { auto: true }), intervalSec * 1000);
  }

  stop() {
    this._running = false;
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  async generateSuggestions(gmInput = "", { auto = false } = {}) {
    try {
      // ── Auto-cycle guards: skip AI calls that would waste tokens ──
      if (auto) {
        // Guard 1: No non-GM players connected → GM is developing, not playing.
        // Silent — this fires on every auto-cycle when soloing and is pure noise.
        const activePlayers = game.users?.filter(u => u.active && !u.isGM) ?? [];
        if (!activePlayers.length) return [];
      }

      const sceneCtx = this.scene.gatherCompact();
      if (!sceneCtx) return [];

      // Guard 2: Scene context unchanged since last auto-cycle → nothing new to suggest
      if (auto) {
        const fingerprint = sceneCtx.slice(0, 500);
        if (fingerprint === this._lastFingerprint) {
          console.debug(`${MODULE_ID} | Suggestions skipped — scene unchanged`);
          return [];
        }
        this._lastFingerprint = fingerprint;
      }

      const gmDirective = gmInput.trim()
        ? `\n\nGM DIRECTION: The Game Master wants: "${gmInput}". Shape 2 of the 3 suggestions around this direction while keeping the 3rd as a fresh independent idea.`
        : "";

      const prompt = DIRECTION_PROMPT + gmDirective;
      const npcMem = this.memory.getSceneNpcMemories();
      const response = await this.ai.chat(prompt, sceneCtx, npcMem, []);
      const directions = this._parseDirections(response);
      if (directions.length) this._notify(directions);
      return directions;
    } catch (err) {
      console.error(`${MODULE_ID} | Direction engine error:`, err);
      return [];
    }
  }

  _parseDirections(text) {
    try {
      const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const arr = JSON.parse(cleaned);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((s) => s.title && s.description)
        .slice(0, 3)
        .map((s, i) => ({
          id: s.id ?? String(i + 1),
          title: s.title,
          description: s.description,
          consequence: s.consequence ?? "",
          timestamp: Date.now(),
        }));
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not parse story directions:`, err);
      return [];
    }
  }
}
