// ============================================================
// ACE — AI Campaign Engine — Fame Engine
// Builds AI context about party fame and deeds for NPC prompts.
// Works alongside ReputationEngine (faction awareness) to give
// NPCs knowledge of the party's accomplishments based on deed
// magnitude, geographic proximity, and NPC role.
//
// Design: The mechanical system is simple — the AI handles nuance.
// We give it structured deed data + magnitude + locations, and
// it decides what a specific NPC would reasonably know.
// ============================================================

const MODULE_ID = "ace-engine";

// Magnitude order for filtering / display
const MAGNITUDE_ORDER = ["trivial", "local", "regional", "major", "legendary"];

// How many deeds to include in context (avoid prompt bloat)
const MAX_DEEDS_IN_CONTEXT = 25;

export class FameEngine {
  /**
   * @param {import("./memory-manager.mjs").MemoryManager} memoryManager
   */
  constructor(memoryManager) {
    this._mm = memoryManager;
  }

  // ── Main Context Builder ──────────────────────────────────

  /**
   * Build a fame context string for injection into an NPC's AI prompt.
   * Returns empty string if no deeds exist or fame system is disabled.
   *
   * @param {string} npcName — The NPC being spoken to
   * @param {string} currentScene — Scene name where the NPC is located
   * @returns {string} — Formatted context block for AI prompt, or ""
   */
  buildFameContext(npcName, currentScene) {
    const deeds = this._mm?.deeds?.getDeeds() ?? [];
    if (!deeds.length) return "";

    // Filter out trivial deeds for NPC context (trivial = location tracking only)
    const notableDeeds = deeds.filter(d => d.magnitude !== "trivial");
    if (!notableDeeds.length) return "";

    const dayCounter = this._mm.world?.getDayCounter() ?? 1;
    const timeOfDay  = this._mm.world?.getTimeOfDay() ?? "unknown";

    // Sort by day descending (most recent first), take limited set
    const sorted = [...notableDeeds]
      .sort((a, b) => (b.day ?? 0) - (a.day ?? 0))
      .slice(0, MAX_DEEDS_IN_CONTEXT);

    // Build the deed list
    const deedLines = sorted.map(d => {
      const dayStr = d.day ? `Day ${d.day}` : "Unknown day";
      const mag    = (d.magnitude ?? "local").toUpperCase();
      const pcs    = d.pcs?.length ? ` — ${d.pcs.join(", ")}` : "";
      const scene  = d.scene ? ` at ${d.scene}` : "";
      return `- [${dayStr}] ${d.text}${scene} (${mag})${pcs}`;
    }).join("\n");

    // Build the full context block
    let ctx = `\n\n## PARTY FAME & KNOWN DEEDS\n\n`;
    ctx += `The adventuring party has accomplished the following. Use deed MAGNITUDE and LOCATION `;
    ctx += `to judge what this NPC would reasonably know. Consider geographic distance between `;
    ctx += `the deed location and this NPC's location, the NPC's role and profession `;
    ctx += `(a tavern keeper in a trade city hears travelers' gossip; a hermit hears nothing; `;
    ctx += `a merchant who travels between cities carries news), and how long ago each deed occurred.\n\n`;

    ctx += `NPC location: ${currentScene || "unknown"}\n`;
    ctx += `Current in-game day: ${dayCounter} (${timeOfDay})\n\n`;

    ctx += `Known Deeds (most recent first):\n${deedLines}\n\n`;

    ctx += `Magnitude guide:\n`;
    ctx += `- LOCAL: Only people in the same town/area would know\n`;
    ctx += `- REGIONAL: Nearby towns and trade partners might have heard rumors\n`;
    ctx += `- MAJOR: Well-known across the region; neighboring regions have heard\n`;
    ctx += `- LEGENDARY: Continental fame — everyone has heard something\n\n`;

    ctx += `IMPORTANT: Adjust your knowledge of the party based on this NPC's location, `;
    ctx += `role, and connections. Do NOT reveal deeds this NPC would not reasonably know about. `;
    ctx += `A bartender in a distant desert town would not know about a LOCAL deed in a northern city. `;
    ctx += `But a MAJOR or LEGENDARY deed might reach them as vague rumors.`;

    return ctx;
  }

  // ── Query Helpers ─────────────────────────────────────────

  /**
   * Get a quick fame summary (for panel display or tooltips).
   * @returns {{ total: number, highest: string, recentDeed: string }}
   */
  getFameSummary() {
    const deeds = this._mm?.deeds?.getDeeds() ?? [];
    if (!deeds.length) return { total: 0, highest: "none", recentDeed: "" };

    let highestIdx = -1;
    for (const d of deeds) {
      const idx = MAGNITUDE_ORDER.indexOf(d.magnitude);
      if (idx > highestIdx) highestIdx = idx;
    }

    const recent = deeds[deeds.length - 1];
    return {
      total:      deeds.length,
      highest:    highestIdx >= 0 ? MAGNITUDE_ORDER[highestIdx] : "none",
      recentDeed: recent?.text ?? "",
    };
  }

  /**
   * Get deeds that happened at or near a specific scene (exact name match).
   * @param {string} sceneName
   * @returns {Array}
   */
  getDeedsForScene(sceneName) {
    if (!sceneName) return [];
    const lower = sceneName.toLowerCase();
    return (this._mm?.deeds?.getDeeds() ?? []).filter(d =>
      (d.scene ?? "").toLowerCase() === lower
    );
  }

  /**
   * Get deeds involving a specific PC.
   * @param {string} pcName
   * @returns {Array}
   */
  getDeedsForPC(pcName) {
    if (!pcName) return [];
    const lower = pcName.toLowerCase();
    return (this._mm?.deeds?.getDeeds() ?? []).filter(d =>
      (d.pcs ?? []).some(pc => pc.toLowerCase() === lower)
    );
  }
}
