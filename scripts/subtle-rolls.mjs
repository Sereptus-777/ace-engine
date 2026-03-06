// ============================================================
// ACE — AI Campaign Engine — Subtle Rolls System
// Blind skill checks with AI-generated narration options.
// The player rolls blind, the GM sees the result, and the AI
// generates 3 narration options (including misinformation on
// Natural 1s). The GM picks one to deliver to the player.
// ============================================================

import { MODULE_ID } from "./ace-engine.mjs";

// ── dnd5e skill labels ──────────────────────────────────────
const SKILL_LABELS = {
  acr: "Acrobatics",    ani: "Animal Handling", arc: "Arcana",
  ath: "Athletics",     dec: "Deception",       his: "History",
  ins: "Insight",       itm: "Intimidation",    inv: "Investigation",
  med: "Medicine",      nat: "Nature",          prc: "Perception",
  prf: "Performance",   per: "Persuasion",      rel: "Religion",
  slt: "Sleight of Hand", ste: "Stealth",       sur: "Survival",
};

// ── AI Prompt: Generate 3 narrations from a blind roll ──────
const NARRATION_PROMPT = `You are a vivid, immersive D&D narrator. A player just made a BLIND skill check — they cannot see their own roll result. Based on the outcome, write exactly 3 narration options the GM can choose from. Each narration is delivered to the player as what their character perceives or learns.

## ROLL DETAILS
- Character: {actorName}
- Skill: {skillLabel} ({skillId})
- DC: {dc}
- Roll Total: {total} (Natural d20: {natural})
- Result: {resultCategory}

## SCENE CONTEXT
{sceneContext}

## NPC / SITUATION CONTEXT
{npcContext}

## NARRATION RULES BY OUTCOME

**Natural 1 (Critical Failure — MISINFORMATION):**
The character is CONFIDENT but COMPLETELY WRONG. Write narrations where the character firmly believes false information. The falsehoods should be plausible enough that the player cannot tell they were lied to. Do NOT hint that the information is wrong — present it as fact.

**Failed (rolled below DC, but not Nat 1):**
The character gains little useful information. Narrations should be vague, uncertain, or incomplete. Missing by 1-2 gives a faint impression; missing by 5+ gives almost nothing.

**Passed (met or exceeded DC, but not Nat 20):**
The character gains accurate, useful information. Beating DC by 1-2 gives basic truth; beating by 5+ gives richer detail. Be specific to the current scene and NPCs.

**Natural 20 (Critical Success):**
The character gains exceptional, vivid insight — sharp, specific details others would miss. Make it feel rewarding.

## OUTPUT FORMAT
Respond ONLY as a JSON array of exactly 3 strings. Each string is a standalone narration paragraph (2-4 sentences, second person). Vary the tone and detail level across the three options.

["First narration option...", "Second narration option...", "Third narration option..."]`;

// ── AI Prompt: Detect when rolls should happen ──────────────
const DETECTION_PROMPT = `You are an expert D&D Game Master assistant analyzing the current scene for moments where players should make BLIND skill checks. These checks prevent metagaming — the player should NOT see the result.

## CURRENT SCENE STATE
{sceneContext}

## ACTIVE NPC CONVERSATIONS
{envoyContext}

## KNOWN TRAPS ON SCENE
{trapContext}

## SKILLS TO CONSIDER
Only suggest these skills: {enabledSkills}

## RULES
- Only suggest a roll when the situation CLEARLY warrants it right now
- Perception: hidden enemies, traps, secret doors, ambushes
- Insight: NPC lying or hiding motives, social deception in active conversation
- Investigation: examining objects, searching rooms, finding clues
- Arcana/History/Religion/Nature: identifying magical effects, recalling lore relevant to what is happening NOW
- Medicine: diagnosing poison, disease, or unusual death
- Survival: tracking, finding paths, sensing weather danger
- Do NOT suggest rolls for things already resolved, obvious, or purely combat-related
- Maximum 2 suggestions at a time
- Name the SPECIFIC player character who should roll

## OUTPUT FORMAT
If no rolls are warranted: []
Otherwise, respond ONLY as a JSON array:
[{"actorName":"Character Name","skill":"ins","dc":14,"reason":"GM-only explanation","flavor":"What the character senses — shown as the roll prompt"}]`;


export class SubtleRollManager {

  constructor(aiProvider, sceneCtx, npcMemory, aceMemory) {
    this.ai       = aiProvider;
    this.scene    = sceneCtx;
    this.memory   = npcMemory;
    this.aceMem   = aceMemory;

    this._pendingRequests = new Map();   // requestId → { dc, skill, ... }
    this._detectInterval  = null;
    this._listeners       = new Set();   // observer for panel notifications
  }

  // ── Observer pattern (same as SuggestionEngine) ───────────
  on(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }
  _notify(data) {
    for (const cb of this._listeners) {
      try { cb(data); } catch (e) { console.error(e); }
    }
  }

  // ── Unique request ID ─────────────────────────────────────
  _genId() {
    return `sr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ────────────────────────────────────────────────────────────
  // STEP 1 — GM sends a blind roll request to a player
  // ────────────────────────────────────────────────────────────

  async requestRoll({ targetUserId, actorId, skill, dc, flavor }) {
    const requestId  = this._genId();
    const skillLabel = SKILL_LABELS[skill] ?? skill;
    const actor      = game.actors.get(actorId);
    const actorName  = actor?.name ?? "Unknown";

    // Store in pending map (GM-side state for fast retrieval)
    this._pendingRequests.set(requestId, {
      dc, skill, skillLabel, targetUserId, actorId, actorName, flavor,
      timestamp: Date.now(),
    });

    // Build the player-visible chat card
    const cardHtml = this._buildRollRequestCard(skillLabel, flavor, requestId, skill);

    await ChatMessage.create({
      content:  cardHtml,
      speaker:  { alias: "ACE" },
      whisper:  [targetUserId],
      flags:    {
        "ace-engine": {
          isSubtleRollRequest: true,
          subtleRequestId:     requestId,
          subtleSkill:         skill,
          subtleDC:            dc,             // stored in flags, NOT in the HTML
          subtleTargetUser:    targetUserId,
          subtleActorId:       actorId,
        },
      },
    });

    console.log(`${MODULE_ID} | Subtle Roll: sent ${skillLabel} (DC ${dc}) request to ${actorName}`);
  }

  // ────────────────────────────────────────────────────────────
  // STEP 2 — Process blind roll result (GM-side only)
  // ────────────────────────────────────────────────────────────

  async handleBlindRollResult(message) {
    const flags     = message.flags?.["ace-engine"];
    const requestId = flags?.subtleRollRequestId;
    if (!requestId) return;

    // Retrieve request metadata (in-memory first, then message flags)
    let dc, skill, actorName, targetUserId, skillLabel;
    const pending = this._pendingRequests.get(requestId);

    if (pending) {
      ({ dc, skill, actorName, targetUserId, skillLabel } = pending);
    } else {
      // Fallback: find the original request ChatMessage
      const origMsg = game.messages.contents.find(m =>
        m.flags?.["ace-engine"]?.subtleRequestId === requestId
      );
      if (!origMsg) {
        console.warn(`${MODULE_ID} | Subtle Roll: no pending request for ${requestId}`);
        return;
      }
      const f = origMsg.flags["ace-engine"];
      dc            = f.subtleDC;
      skill         = f.subtleSkill;
      targetUserId  = f.subtleTargetUser;
      actorName     = flags.subtleActorName ?? "Unknown";
      skillLabel    = SKILL_LABELS[skill] ?? skill;
    }

    // Extract the d20 result
    const { total, natural } = this._extractRollResult(message);
    if (total === null) {
      console.warn(`${MODULE_ID} | Subtle Roll: could not extract roll result`);
      return;
    }

    const resultCategory = this._categorizeResult(natural, total, dc);
    console.log(
      `${MODULE_ID} | Subtle Roll: ${actorName} rolled ${natural} (total ${total}) vs DC ${dc} → ${resultCategory}`
    );

    // ── Generate 3 AI narrations ─────────────────────────────
    const narrations = await this.generateNarrations({
      skill, skillLabel, dc, total, natural, actorName, resultCategory,
    });

    if (!narrations.length) {
      ui.notifications?.warn("ACE: Subtle Roll narration generation failed — check your AI connection.");
      return;
    }

    // ── Post GM-only Narration Picker card ───────────────────
    const pickerHtml = this._buildNarrationPickerCard(
      actorName, skillLabel, dc, total, natural, narrations, requestId
    );

    await ChatMessage.create({
      content:  pickerHtml,
      speaker:  { alias: "ACE" },
      whisper:  [game.user.id],
      flags:    {
        "ace-engine": {
          isSubtleNarrationPicker: true,
          subtleRequestId:         requestId,
          subtleNarrations:        narrations,
          subtleTargetUser:        targetUserId,
          subtleActorName:         actorName,
          subtleSkillLabel:        skillLabel,
        },
      },
    });

    // Clean up pending map
    this._pendingRequests.delete(requestId);
  }

  // ────────────────────────────────────────────────────────────
  // STEP 3 — GM picks a narration
  // ────────────────────────────────────────────────────────────

  async pickNarration(btn) {
    const requestId = btn.dataset.requestId;
    const narration = decodeURIComponent(btn.dataset.narration);

    // Retrieve metadata from the picker message
    const pickerMsg = game.messages.contents.find(m =>
      m.flags?.["ace-engine"]?.subtleRequestId === requestId &&
      m.flags?.["ace-engine"]?.isSubtleNarrationPicker
    );
    const f            = pickerMsg?.flags?.["ace-engine"] ?? {};
    const targetUserId = f.subtleTargetUser;
    const actorName    = f.subtleActorName ?? "Unknown";
    const skillLabel   = f.subtleSkillLabel ?? "Skill Check";

    // "Send to all players" checkbox
    const card      = btn.closest(".ace-subtle-picker");
    const sendToAll = card?.querySelector(".ace-subtle-sendall")?.checked ?? false;

    // Build and deliver narration
    const deliveryHtml = this._buildNarrationDeliveryCard(actorName, skillLabel, narration);

    await ChatMessage.create({
      content:  deliveryHtml,
      speaker:  { alias: "ACE" },
      whisper:  sendToAll ? undefined : [targetUserId],
      flags:    { "ace-engine": { isSubtleNarration: true, subtleRequestId: requestId } },
    });

    // ── Disable all pick buttons on this card ────────────────
    card?.querySelectorAll("[data-ace-btn='subtle-pick']").forEach(b => {
      b.disabled = true;
      b.style.opacity = "0.35";
      b.style.cursor  = "default";
    });
    btn.style.opacity     = "1";
    btn.style.borderColor = "#c9a84c";

    // ── TTS broadcast via socket ─────────────────────────────
    game.socket.emit(`module.${MODULE_ID}`, {
      type:         "subtle-narration-tts",
      text:         narration,
      targetUserId: sendToAll ? null : targetUserId,
    });

    // ── Log to persistent memory ─────────────────────────────
    this.aceMem?.logNote?.(`Subtle Roll: ${actorName} — ${skillLabel}: "${narration}"`);

    console.log(`${MODULE_ID} | Subtle Roll: delivered ${skillLabel} narration to ${sendToAll ? "all" : actorName}`);
  }

  // ────────────────────────────────────────────────────────────
  // AI — Generate 3 narrations for a blind roll result
  // ────────────────────────────────────────────────────────────

  async generateNarrations({ skill, skillLabel, dc, total, natural, actorName, resultCategory }) {
    const sceneCtx = this.scene?.gatherCompact?.() ?? "";
    const npcMem   = this.memory?.getSceneNpcMemories?.() ?? "";

    const prompt = NARRATION_PROMPT
      .replace("{actorName}",       actorName)
      .replace("{skillLabel}",      skillLabel)
      .replace("{skillId}",         skill)
      .replace("{dc}",              dc)
      .replace("{total}",           total)
      .replace("{natural}",         natural)
      .replace("{resultCategory}",  resultCategory)
      .replace("{sceneContext}",    sceneCtx || "No scene data available.")
      .replace("{npcContext}",      npcMem   || "No NPC context available.");

    try {
      const response = await this.ai.chat(prompt, "", "", []);
      return this._parseNarrations(response);
    } catch (err) {
      console.error(`${MODULE_ID} | Subtle Roll narration failed:`, err);
      return this._fallbackNarrations(resultCategory, skillLabel, actorName);
    }
  }

  // ────────────────────────────────────────────────────────────
  // AI — Detect when rolls should happen (auto-detect)
  // ────────────────────────────────────────────────────────────

  startAutoDetect() {
    if (this._detectInterval) return;
    const baseSec = game.settings.get(MODULE_ID, "suggestionInterval") || 120;
    // 1.5× the suggestion interval so they don't collide
    this._detectInterval = setInterval(() => this.detectRollOpportunities(), baseSec * 1500);
    console.log(`${MODULE_ID} | Subtle Roll auto-detect started (every ${Math.round(baseSec * 1.5)}s)`);
  }

  stopAutoDetect() {
    if (this._detectInterval) {
      clearInterval(this._detectInterval);
      this._detectInterval = null;
    }
  }

  async detectRollOpportunities() {
    try {
      const enabled = game.settings.get(MODULE_ID, "subtleRollAutoDetect");
      if (!enabled) return [];

      const sceneCtx    = this.scene?.gatherCompact?.();
      if (!sceneCtx) return [];
      const enabledStr  = game.settings.get(MODULE_ID, "subtleRollSkills") || "";
      const enabledList = enabledStr.split(",").map(s => s.trim()).filter(Boolean);

      // ── Envoy conversation context ───────────────────────
      let envoyCtx = "No active conversations.";
      const envoy  = game.modules.get("ace-envoy");
      if (envoy?.active && envoy.api?.getActiveConversations) {
        const convos = envoy.api.getActiveConversations();
        if (convos.length) {
          envoyCtx = convos.map(c =>
            `${c.pcName} is speaking privately with ${c.npcName} (${c.exchangeCount} exchanges)`
          ).join("\n");
        }
      }

      // ── Trapmaster context ───────────────────────────────
      let trapCtx = "No known traps.";
      const tm    = game.modules.get("ace-trapmaster");
      if (tm?.active && tm.api?.getTraps) {
        const traps = tm.api.getTraps(canvas.scene?.id);
        if (traps?.length) {
          trapCtx = traps.map(t => `${t.name}: ${t.description ?? "hidden trap"}`).join("\n");
        }
      }

      const prompt = DETECTION_PROMPT
        .replace("{sceneContext}",  sceneCtx)
        .replace("{envoyContext}",  envoyCtx)
        .replace("{trapContext}",   trapCtx)
        .replace("{enabledSkills}", enabledList.map(s => `${s} (${SKILL_LABELS[s] ?? s})`).join(", "));

      const response    = await this.ai.chat(prompt, "", "", []);
      const suggestions = this._parseDetections(response);

      if (suggestions.length) {
        this._notify({ type: "rollSuggestions", suggestions });
        // Also post a GM-only card for each suggestion
        for (const s of suggestions) {
          await this._postDetectionCard(s);
        }
      }
      return suggestions;
    } catch (err) {
      console.error(`${MODULE_ID} | Subtle Roll detection error:`, err);
      return [];
    }
  }

  async _postDetectionCard(suggestion) {
    const skillLabel = SKILL_LABELS[suggestion.skill] ?? suggestion.skill;

    // Find the actor + owning user
    const actor = game.actors.getName(suggestion.actorName);
    const owner = actor ? game.users.find(u => !u.isGM && actor.testUserPermission(u, "OWNER")) : null;

    const html =
      `<div class="ace-subtle-detection" style="background:#1c150e;border-left:4px solid #8a5bbf;` +
      `border-radius:4px;padding:10px 12px;font-family:'IM Fell English','Palatino Linotype',serif;line-height:1.6;">` +
      `<div style="color:#c4a8f0;font-weight:bold;font-size:0.95em;margin-bottom:4px;">` +
      `<i class="fas fa-brain" style="margin-right:4px;"></i> Subtle Roll Suggestion</div>` +
      `<div style="color:#eddfc5;margin-bottom:6px;">` +
      `<strong>${suggestion.actorName}</strong> should make a ` +
      `<strong style="color:#c4a8f0;">${skillLabel}</strong> check (DC ${suggestion.dc})</div>` +
      `<div style="font-size:0.85em;color:#9a9890;font-style:italic;margin-bottom:8px;">` +
      `${suggestion.reason}</div>` +
      `<button class="ace-chat-btn" data-ace-btn="subtle-send-request" ` +
      `data-skill="${suggestion.skill}" data-dc="${suggestion.dc}" ` +
      `data-actor-id="${actor?.id ?? ""}" data-user-id="${owner?.id ?? ""}" ` +
      `data-flavor="${_encodeAttr(suggestion.flavor)}" ` +
      `style="display:block;width:100%;padding:7px 10px;background:#18102a;` +
      `border:1px solid #8a5bbf;border-radius:4px;color:#c4a8f0;cursor:pointer;` +
      `font-family:inherit;font-size:0.95em;text-align:center;font-weight:bold;">` +
      `<i class="fas fa-paper-plane" style="margin-right:6px;"></i>Send Roll Request</button>` +
      `</div>`;

    await ChatMessage.create({
      content: html,
      speaker: { alias: "ACE" },
      whisper: [game.user.id],
      flags:   { "ace-engine": { isSubtleDetection: true } },
    });
  }

  // ────────────────────────────────────────────────────────────
  // HELPERS — Roll result extraction
  // ────────────────────────────────────────────────────────────

  _extractRollResult(message) {
    try {
      const rolls = message.rolls ?? [];
      for (const roll of rolls) {
        for (const term of (roll.terms ?? [])) {
          if (term.faces !== 20) continue;
          for (const result of (term.results ?? [])) {
            if (!result.active || result.discarded) continue;
            return { natural: result.result, total: roll.total };
          }
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | _extractRollResult error:`, err);
    }
    return { total: null, natural: null };
  }

  _categorizeResult(natural, total, dc) {
    if (natural === 1)  return "Natural 1 (Critical Failure — Misinformation)";
    if (natural === 20) return "Natural 20 (Critical Success)";
    if (total >= dc + 5) return `Strong Success (beat DC by ${total - dc})`;
    if (total >= dc)     return `Success (beat DC by ${total - dc})`;
    if (total >= dc - 2) return `Near Miss (missed DC by ${dc - total})`;
    return `Failure (missed DC by ${dc - total})`;
  }

  // ────────────────────────────────────────────────────────────
  // HELPERS — JSON parsers
  // ────────────────────────────────────────────────────────────

  _parseNarrations(text) {
    try {
      const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const arr = JSON.parse(cleaned);
      if (!Array.isArray(arr)) return [];
      return arr.filter(s => typeof s === "string" && s.length > 0).slice(0, 3);
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not parse narrations:`, err);
      return [];
    }
  }

  _parseDetections(text) {
    try {
      const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const arr = JSON.parse(cleaned);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(s => s.actorName && s.skill)
        .slice(0, 2)
        .map(s => ({
          actorName: s.actorName,
          skill:     s.skill,
          dc:        parseInt(s.dc) || 15,
          reason:    s.reason ?? "",
          flavor:    s.flavor ?? "The DM calls for a check...",
        }));
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not parse detections:`, err);
      return [];
    }
  }

  _fallbackNarrations(resultCategory, skillLabel, actorName) {
    if (resultCategory.includes("Misinformation")) {
      return [
        `${actorName} is absolutely certain about what they perceive. There is nothing unusual here at all — everything is exactly as it appears.`,
        `After careful consideration, ${actorName} feels completely confident in their assessment. They recall a detail that confirms their initial impression.`,
        `${actorName}'s ${skillLabel.toLowerCase()} tells them this situation is straightforward. They feel no need for further scrutiny.`,
      ];
    }
    if (resultCategory.includes("Success") || resultCategory.includes("Natural 20")) {
      return [
        `${actorName}'s keen senses pick up on something important about the situation — a detail that others would easily overlook.`,
        `With focused attention, ${actorName} notices subtle but significant details that paint a clearer picture of what is really going on.`,
        `${actorName}'s experience and training reveal useful information. Something clicks into place.`,
      ];
    }
    return [
      `${actorName} considers the situation carefully but cannot draw any firm conclusions one way or another.`,
      `Despite their best efforts, ${actorName} finds it difficult to read the situation clearly. Nothing stands out.`,
      `${actorName} has a vague feeling about this, but nothing concrete enough to act on with confidence.`,
    ];
  }

  // ────────────────────────────────────────────────────────────
  // CHAT CARD BUILDERS
  // ────────────────────────────────────────────────────────────

  /** Card 1: Roll Request — whispered to the player */
  _buildRollRequestCard(skillLabel, flavor, requestId, skill) {
    return (
      `<div class="ace-subtle-request" style="background:#1c150e;border-left:4px solid #8a5bbf;` +
      `border-radius:4px;padding:10px 12px;font-family:'IM Fell English','Palatino Linotype',serif;line-height:1.6;">` +
      // Header
      `<div style="color:#c4a8f0;font-weight:bold;font-size:1.05em;margin-bottom:6px;letter-spacing:0.5px;">` +
      `<i class="fas fa-eye-slash" style="margin-right:4px;"></i> Subtle Check</div>` +
      // Flavor
      `<div style="font-style:italic;color:#eddfc5;margin-bottom:10px;">` +
      `${_escapeHtml(flavor || "The DM calls for a check...")}</div>` +
      // Roll button
      `<button class="ace-chat-btn" data-ace-btn="subtle-roll" ` +
      `data-request-id="${requestId}" data-skill="${skill}" ` +
      `style="display:block;width:100%;padding:8px 12px;background:#18102a;` +
      `border:1px solid #8a5bbf;border-radius:4px;color:#c4a8f0;cursor:pointer;` +
      `font-family:inherit;font-size:1em;text-align:center;font-weight:bold;` +
      `transition:all 0.2s;">` +
      `<i class="fas fa-dice-d20" style="margin-right:6px;"></i>` +
      `Roll ${skillLabel}</button>` +
      // Footer
      `<div style="font-size:0.78em;color:#7a6042;margin-top:6px;text-align:center;">` +
      `Select your token first, then click to roll blind.</div>` +
      `</div>`
    );
  }

  /** Card 2: Narration Picker — GM-only whisper */
  _buildNarrationPickerCard(actorName, skillLabel, dc, total, natural, narrations, requestId) {
    const isNat1  = natural === 1;
    const isNat20 = natural === 20;
    const passed  = total >= dc;

    const bannerColor = isNat1 ? "#c43b3b" : isNat20 ? "#c9a84c" : passed ? "#5db88a" : "#e06060";
    const bannerText  = isNat1  ? "NATURAL 1 — Misinformation"
                      : isNat20 ? "NATURAL 20 — Perfect Insight"
                      : passed  ? `PASSED (${total} vs DC ${dc})`
                      :           `FAILED (${total} vs DC ${dc})`;

    let html =
      `<div class="ace-subtle-picker" style="background:#1c150e;border-left:4px solid #8a5bbf;` +
      `border-radius:4px;padding:10px 12px;font-family:'IM Fell English','Palatino Linotype',serif;line-height:1.6;">` +
      // Header
      `<div style="color:#c4a8f0;font-weight:bold;font-size:1.05em;margin-bottom:4px;">` +
      `<i class="fas fa-eye" style="margin-right:4px;"></i>` +
      ` Subtle Roll Result — ${_escapeHtml(actorName)}</div>` +
      // Result banner
      `<div style="background:${bannerColor}22;border:1px solid ${bannerColor};` +
      `border-radius:3px;padding:4px 8px;margin-bottom:10px;text-align:center;` +
      `color:${bannerColor};font-weight:bold;font-size:0.9em;">` +
      `${bannerText} &nbsp;|&nbsp; d20: ${natural} + ${total - natural} = ${total}</div>` +
      // Skill label
      `<div style="color:#9a9890;font-size:0.85em;margin-bottom:8px;">` +
      `${_escapeHtml(actorName)} rolled <strong>${skillLabel}</strong> — pick a narration to send:</div>`;

    // 3 narration options
    narrations.forEach((narr, i) => {
      html +=
        `<button class="ace-chat-btn" data-ace-btn="subtle-pick" ` +
        `data-request-id="${requestId}" data-pick="${i}" ` +
        `data-narration="${encodeURIComponent(narr)}" ` +
        `style="display:block;width:100%;padding:8px 10px;margin-bottom:6px;` +
        `background:#111114;border:1px solid #3a3a40;border-radius:4px;` +
        `color:#eddfc5;cursor:pointer;font-family:inherit;font-size:0.92em;` +
        `text-align:left;line-height:1.5;transition:all 0.2s;">` +
        `<span style="color:#c4a8f0;font-weight:bold;margin-right:6px;">${i + 1}.</span>` +
        `${_escapeHtml(narr)}</button>`;
    });

    // "Send to all" checkbox
    html +=
      `<div style="margin-top:4px;text-align:right;">` +
      `<label style="font-size:0.8em;color:#7a6042;cursor:pointer;">` +
      `<input type="checkbox" class="ace-subtle-sendall" style="margin-right:4px;" />` +
      `Send to all players (not just ${_escapeHtml(actorName)})</label></div>`;

    html += `</div>`;
    return html;
  }

  /** Card 3: Narration Delivery — whispered to the player (or public) */
  _buildNarrationDeliveryCard(actorName, skillLabel, narrationText) {
    return (
      `<div class="ace-subtle-delivery" style="background:#1c150e;border-left:4px solid #c9a84c;` +
      `border-radius:4px;padding:10px 12px;font-family:'IM Fell English','Palatino Linotype',serif;line-height:1.6;">` +
      `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">` +
      `<span style="color:#c9a84c;font-weight:bold;font-size:0.85em;` +
      `text-transform:uppercase;letter-spacing:1px;">` +
      `<i class="fas fa-scroll" style="margin-right:4px;"></i>` +
      `${skillLabel} — ${_escapeHtml(actorName)}</span></div>` +
      `<div style="font-style:italic;color:#eddfc5;font-size:1em;">` +
      `"${_escapeHtml(narrationText)}"</div>` +
      `</div>`
    );
  }

  // ────────────────────────────────────────────────────────────
  // STATIC HELPERS
  // ────────────────────────────────────────────────────────────

  /** Get the human-readable label for a skill ID */
  static getSkillLabel(skillId) {
    return SKILL_LABELS[skillId] ?? skillId;
  }

  /** All known skill labels */
  static get SKILL_LABELS() {
    return { ...SKILL_LABELS };
  }
}

// ── Utility ────────────────────────────────────────────────────
function _escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function _encodeAttr(str) {
  return (str ?? "").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
