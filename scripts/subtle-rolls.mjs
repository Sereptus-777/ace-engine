// ============================================================
// ACE — AI Campaign Engine — Subtle Rolls System
// Blind skill checks with AI-generated narration.
// The GM rolls blind for selected tokens, sees the actual
// results on a consolidated card, and the AI generates one
// narration per actor (including misinformation on Natural 1s).
// The GM clicks "Broadcast" to send each narration to everyone.
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

// ── Skill → Ability mapping (for condition-based adv/disadv) ─
const SKILL_ABILITY = {
  acr: "dex", ani: "wis", arc: "int", ath: "str", dec: "cha",
  his: "int", ins: "wis", itm: "cha", inv: "int", med: "wis",
  nat: "int", prc: "wis", prf: "cha", per: "cha", rel: "int",
  slt: "dex", ste: "dex", sur: "wis",
};

// ── Conditions that grant disadvantage on ability checks ─────
// dnd5e conditions stored in actor.statuses (Set of string IDs)
const DISADV_CONDITIONS = new Set([
  "poisoned",    // disadv on all ability checks
  "frightened",  // disadv on all ability checks while source in sight
  "exhaustion",  // level 1+ = disadv on ability checks (dnd5e 2014)
]);

// Conditions that grant disadvantage only on certain ability checks
const DISADV_DEX_CONDITIONS = new Set([
  "restrained",  // disadv on Dex checks
  "prone",       // (usually attack rolls, but some GMs apply to Dex checks)
]);

// Conditions that grant disadvantage on Perception (sight-based)
const DISADV_PERCEPTION = new Set([
  "blinded",     // disadv on Perception checks that rely on sight
]);

// ── AI Prompt: Generate ONE narration from a blind roll ──────
const NARRATION_PROMPT = `You are a vivid, immersive D&D narrator. A player just made a BLIND skill check — they cannot see their own roll result. Based on the outcome, write a single narration paragraph that the GM will read aloud to ALL players.

## ROLL DETAILS
- Character: {actorName} ({actorRace} {actorClass})
- Skill: {skillLabel} ({skillId})
- DC: {dc}
- Roll Total: {total} (Natural d20: {natural})
- Result: {resultCategory}

## SCENE CONTEXT (USE THIS — DO NOT INVENT LOCATIONS OR SETTINGS)
{sceneContext}

## NPC / SITUATION CONTEXT
{npcContext}

## CRITICAL — USE THE ACTUAL SCENE
Your narration MUST match the ACTUAL scene described above. If players are outdoors, describe outdoor sensations. If in a tavern, describe tavern details. NEVER invent locations, rooms, or environments that are not in the scene context. If no scene description is available, keep the narration generic and environment-neutral — do NOT fabricate a setting.

## CRITICAL — STAY ON SKILL
Your narration MUST be about the specific skill being used. Do NOT generate unrelated lore, secrets, or information that has nothing to do with the skill check.

**What each skill is about:**
- **Perception** — noticing things with your senses (seeing, hearing, smelling). NOT recalling knowledge.
- **Insight** — reading a person's intentions, detecting lies, social intuition. ONLY about people.
- **Investigation** — examining objects, searching rooms, deductive reasoning about physical things.
- **Arcana** — recalling knowledge about magic, spells, magical creatures, planes of existence.
- **History** — recalling knowledge about historical events, people, wars, kingdoms, legends.
- **Religion** — recalling knowledge about deities, rites, prayers, holy symbols, undead.
- **Nature** — recalling knowledge about terrain, plants, animals, weather, natural cycles.
- **Medicine** — assessing wounds, diagnosing illness/poison, stabilizing the dying, examining bodies. ONLY medical things.
- **Survival** — tracking creatures, navigating wilderness, finding food/water, predicting weather.
- **Wisdom Save** — resisting charm, fear, psychic effects. The character's mental fortitude.
- **Intelligence Save** — resisting illusions, psychic intrusion, mental manipulation.

## NARRATION RULES BY OUTCOME

**Natural 1 (Critical Failure — MISINFORMATION):**
The character is CONFIDENT but COMPLETELY WRONG about the specific thing the skill covers. A Medicine Nat 1 means a wrong medical diagnosis — NOT revealing unrelated secrets. An Insight Nat 1 means misreading a person's intentions — NOT recalling wrong lore. The falsehood must be plausible and skill-appropriate. Do NOT hint that the information is wrong — present it as absolute fact. This is the entire point of a subtle roll.

**Failed (rolled below DC, but not Nat 1):**
The character gains little useful information about what the skill covers. Narration should be vague, uncertain, or incomplete. Missing by 1-2 gives a faint impression; missing by 5+ gives almost nothing.

**Passed (met or exceeded DC, but not Nat 20):**
The character gains accurate, useful information relevant to the skill. Beating DC by 1-2 gives basic truth; beating by 5+ gives richer detail. Be specific to the current scene and NPCs.

**Natural 20 (Critical Success):**
The character gains exceptional, vivid insight about the skill's domain — sharp, specific details others would miss. More detail, more clarity — but still grounded and believable.

## CRITICAL — KEEP IT SUBTLE AND BELIEVABLE
The ENTIRE purpose of a blind roll is that the player cannot tell what they rolled from the narration alone.
- NEVER use absolutes like "you are certain", "without a doubt", "must be true", "every word is truthful" — players will instantly suspect a high roll.
- NEVER use obviously vague language like "you can't tell anything" — players will instantly suspect a low roll.
- A PASSED check should feel like a natural observation: "You notice the genuine weight of grief in his voice" — NOT "You know with absolute certainty he speaks only truth."
- A FAILED check should feel like things are just unclear: "His expression is hard to read" — NOT "You have no idea what's going on."
- A Nat 1 MISINFORMATION should feel like a normal, confident observation that happens to be WRONG — NOT an over-the-top declaration.
- A Nat 20 should feel like keen, specific observation — NOT magical omniscience.
- The tone difference between pass and fail should be SUBTLE. A player hearing either narration should think "that could be anything from a 5 to a 19."

## PERSPECTIVE RULES — CRITICAL
- Describe the PLAYER CHARACTER's experience in SECOND PERSON: "You notice...", "You sense...", "You feel..."
- Describe NPCs in THIRD PERSON: "The guard crosses his arms", NOT "I cross my arms" or "my face"
- NEVER use first person ("I", "my", "me") — the narration is read aloud BY the GM TO the players
- NPC actions use their name or "he/she/they": "{actorName} narrows their eyes" NOT "narrows my eyes"

## OUTPUT FORMAT
{lengthInstruction}
No JSON, no quotes, no preamble — just the narration text.`;

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
- ONLY suggest rolls for PLAYER CHARACTERS — never for NPCs, monsters, or enemies
- ONLY suggest a roll when something CONCRETE and VERIFIABLE is happening right now:
  - A known trap exists on the scene (listed above)
  - An NPC is actively lying or hiding motives in a live conversation (listed above)
  - A specific game element (token, tile, item) on the scene warrants examination
- Do NOT invent dangers, ambushes, traps, or threats that are not listed in the scene data above
- Do NOT speculate about what MIGHT be happening — only react to what IS happening
- If the scene data and conversation context don't contain a clear trigger, return []
- Perception: ONLY if a known trap/hidden token is on the scene
- Insight: ONLY if an NPC is actively in conversation and has reason to deceive
- Investigation: ONLY if a specific object/room feature is described in the scene
- Arcana/History/Religion/Nature: ONLY if a specific magical effect or creature is present
- Medicine: ONLY if someone is visibly injured, poisoned, or dead on scene
- Survival: ONLY if the party is actively traveling or lost
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

  // ── Advantage / Disadvantage auto-detection ────────────────
  // Returns "advantage", "disadvantage", or "normal" based on
  // the actor's active conditions and the skill being rolled.
  _detectAdvantage(actor, skill) {
    const statuses = actor?.statuses;  // Set<string> in dnd5e
    if (!statuses?.size) return "normal";

    let hasAdv = false;
    let hasDisadv = false;
    const ability = SKILL_ABILITY[skill] ?? "";

    // Universal disadvantage conditions
    for (const cond of DISADV_CONDITIONS) {
      if (statuses.has(cond)) hasDisadv = true;
    }

    // Dex-specific disadvantage
    if (ability === "dex") {
      for (const cond of DISADV_DEX_CONDITIONS) {
        if (statuses.has(cond)) hasDisadv = true;
      }
    }

    // Perception-specific (blinded)
    if (skill === "prc") {
      for (const cond of DISADV_PERCEPTION) {
        if (statuses.has(cond)) hasDisadv = true;
      }
    }

    // Invisible grants advantage on Stealth
    if (skill === "ste" && statuses.has("invisible")) hasAdv = true;

    // Adv + disadv cancel out
    if (hasAdv && hasDisadv) return "normal";
    if (hasAdv) return "advantage";
    if (hasDisadv) return "disadvantage";
    return "normal";
  }

  // ────────────────────────────────────────────────────────────
  // BATCH — GM rolls all selected tokens, one consolidated card
  // ────────────────────────────────────────────────────────────

  async batchRoll({ actors, skill, dc, flavor }) {
    const skillLabel = SKILL_LABELS[skill] ?? skill;
    const results    = [];

    for (const { actor, token } of actors) {
      // Use TOKEN name (e.g. "Grimfang") not actor base name ("Otyugh")
      const displayName = token?.document?.name ?? token?.name ?? actor.prototypeToken?.name ?? actor.name;
      const displayImg  = token?.document?.texture?.src ?? actor.prototypeToken?.texture?.src ?? actor.img;

      try {
        // ── Advantage / Disadvantage auto-detection ───────────────
        const advState = this._detectAdvantage(actor, skill);
        const diceExpr = advState === "advantage"    ? "2d20kh1"
                       : advState === "disadvantage" ? "2d20kl1"
                       :                              "1d20";

        // Roll silently — no chat message
        const roll = await new Roll(`${diceExpr} + @mod`, {
          mod: actor.system?.skills?.[skill]?.total
            ?? actor.system?.skills?.[skill]?.mod
            ?? 0,
        }).evaluate();

        // ── Dice So Nice ──────────────────────────────────────────
        // 1. GM sees the REAL dice result (local only, not synchronized)
        // 2. Players see secret "?" dice (synchronized, secret flag hides faces)
        //
        // showForRoll signature (Dice So Nice v4+):
        //   showForRoll(roll, user, synchronize, users, blind, messageId, speaker, options)
        //   - blind:  skips LOCAL animation (sender doesn't see dice)
        //   - secret: via options {secret:true} — shows "?" faces on receiving clients
        // Dice So Nice — GM sees real dice, players see blind "?" dice
        if (game.dice3d) {
          try {
            // 1. GM sees real dice locally (not synchronized)
            await game.dice3d.showForRoll(roll, game.user, false, null, false, null, null);
            // 2. Players see ghost "?" dice (synchronized, blind=true skips GM local, ghost shows "?")
            await game.dice3d.showForRoll(roll, game.user, true, null, true, null, null, { ghost: true });
          } catch (e) {
            console.warn(`${MODULE_ID} | Dice So Nice roll failed:`, e);
          }
        }

        const total   = roll.total;
        // For 2d20kh/kl, the "kept" die is the active one
        const natural = roll.dice?.[0]?.total ?? roll.terms?.[0]?.results?.find(r => r.active)?.result ?? total;

        // Extract race/class for AI narration context
        const race  = actor.system?.details?.race?.name ?? actor.system?.details?.race ?? "";
        const cls   = actor.system?.details?.class ?? actor.items?.find(i => i.type === "class")?.name ?? "";

        results.push({
          actorName: displayName,
          actorImg:  displayImg,
          actorRace: typeof race === "string" ? race : "",
          actorClass: cls,
          total,
          natural,
          modifier: total - natural,
          passed:   total >= dc,
          isNat1:   natural === 1,
          isNat20:  natural === 20,
          advState, // "advantage", "disadvantage", or "normal"
        });
      } catch (err) {
        console.error(`${MODULE_ID} | Subtle batch roll error for ${displayName}:`, err);
        results.push({
          actorName: displayName,
          actorImg:  displayImg,
          total: 0, natural: 0, modifier: 0,
          passed: false, isNat1: false, isNat20: false,
          error: true,
        });
      }
    }

    // Build & post one consolidated GM-only card (without narrations yet)
    const cardHtml = this._buildConsolidatedCard(skillLabel, dc, flavor, results);
    const chatMsg = await ChatMessage.create({
      content: cardHtml,
      speaker: { alias: "ACE" },
      whisper: [game.user.id],
      flags:   { "ace-engine": { isSubtleBatchResult: true } },
    });

    // Log to memory
    const summary = results.map(r => {
      const adv = r.advState === "advantage" ? " [ADV]" : r.advState === "disadvantage" ? " [DIS]" : "";
      return `${r.actorName}: ${r.total}${adv} ${r.passed ? "PASS" : "FAIL"}`;
    }).join(", ");
    this.aceMem?.logNote?.(`Subtle Batch Roll (${skillLabel} DC ${dc}): ${summary}`);

    // ── AI narration for EVERY result — appended to the card ──
    if (this.ai) {
      this._generateAllNarrations(skillLabel, skill, dc, flavor, results, chatMsg);  // fire-and-forget
    }

    return results;
  }

  // ────────────────────────────────────────────────────────────
  // AI narration for ALL results — one per actor, appended to
  // the consolidated card. GM clicks "Broadcast" to send to all.
  // ────────────────────────────────────────────────────────────

  async _generateAllNarrations(skillLabel, skill, dc, flavor, results, chatMsg) {
    const sceneCtx = this.scene?.gatherCompact?.() ?? "";
    const npcMem   = this.memory?.getSceneNpcMemories?.() ?? "";
    const narrations = [];

    for (const r of results) {
      if (r.error) { narrations.push({ ...r, narration: "" }); continue; }

      const resultCategory = this._categorizeResult(r.natural, r.total, dc);
      const lengthPref = this._getNarrationLength();
      const prompt = NARRATION_PROMPT
        .replace("{actorName}",      r.actorName)
        .replace("{actorRace}",      r.actorRace || "unknown race")
        .replace("{actorClass}",     r.actorClass || "adventurer")
        .replace("{skillLabel}",     skillLabel)
        .replace("{skillId}",        skill)
        .replace("{dc}",             dc)
        .replace("{total}",          r.total)
        .replace("{natural}",        r.natural)
        .replace("{resultCategory}", resultCategory)
        .replace("{lengthInstruction}", lengthPref)
        .replace("{sceneContext}",   sceneCtx || "No scene data available.")
        .replace("{npcContext}",     npcMem   || "No NPC context available.");

      try {
        let narration = await this.ai.chat(prompt, "", "", []);
        // Strip any accidental JSON wrapping, quotes, or markdown
        narration = narration.replace(/```[a-z]*\s*/g, "").replace(/```\s*/g, "").trim();
        narration = narration.replace(/^\[?"?|"?\]?$/g, "").trim();
        narrations.push({ ...r, narration });
      } catch (err) {
        console.error(`${MODULE_ID} | Narration failed for ${r.actorName}:`, err);
        // Use fallback narration
        const fb = this._fallbackNarrations(resultCategory, skillLabel, r.actorName);
        narrations.push({ ...r, narration: fb[0] });
      }
    }

    // Rebuild the card with narrations appended
    const updatedHtml = this._buildConsolidatedCard(skillLabel, dc, flavor, results, narrations);
    try {
      await chatMsg.update({ content: updatedHtml });
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to update consolidated card:`, err);
    }
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
          subtleFlavor:        flavor,         // original suggestion context for narration
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
    let dc, skill, actorName, targetUserId, skillLabel, flavor;
    const pending = this._pendingRequests.get(requestId);

    if (pending) {
      ({ dc, skill, actorName, targetUserId, skillLabel, flavor } = pending);
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
      flavor        = f.subtleFlavor ?? "";
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

    // ── Generate 1 AI narration using the suggestion's original context ──
    const narrations = await this.generateNarrations({
      skill, skillLabel, dc, total, natural, actorName, resultCategory, flavor,
    });

    const narration = narrations[0] ?? "";

    // ── Post GM-only result card with broadcast + override buttons ─
    const resultHtml = this._buildResultCard(
      actorName, skillLabel, dc, total, natural, narration, requestId, targetUserId, flavor
    );

    await ChatMessage.create({
      content:  resultHtml,
      speaker:  { alias: "ACE" },
      whisper:  [game.user.id],
      flags:    {
        "ace-engine": {
          isSubtleNarrationPicker: true,
          subtleRequestId:         requestId,
          subtleNarrations:        narration ? [narration] : [],
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

    const card = btn.closest(".ace-subtle-result") ?? btn.closest(".ace-subtle-picker");

    // Build and deliver narration — always public (everyone hears it)
    const deliveryHtml = this._buildNarrationDeliveryCard(actorName, skillLabel, narration);

    await ChatMessage.create({
      content:  deliveryHtml,
      speaker:  { alias: "ACE" },
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

    // ── TTS broadcast via socket — everyone hears it ────────
    game.socket.emit(`module.${MODULE_ID}`, {
      type:         "subtle-narration-tts",
      text:         narration,
      targetUserId: null,  // null = all players
    });

    // ── Log to persistent memory ─────────────────────────────
    this.aceMem?.logNote?.(`Subtle Roll: ${actorName} — ${skillLabel}: "${narration}"`);

    console.log(`${MODULE_ID} | Subtle Roll: broadcast ${skillLabel} narration for ${actorName} to all players`);
  }

  // ────────────────────────────────────────────────────────────
  // AI — Generate narration for a blind roll result
  // ────────────────────────────────────────────────────────────

  async generateNarrations({ skill, skillLabel, dc, total, natural, actorName, actorRace, actorClass, resultCategory, flavor }) {
    const sceneCtx = this.scene?.gatherCompact?.() ?? "";
    const npcMem   = this.memory?.getSceneNpcMemories?.() ?? "";
    const lengthPref = this._getNarrationLength();

    // If we have the original suggestion flavor/reason, inject it as extra context
    // so the narration is specific to WHY the check was called
    const flavorCtx = flavor
      ? `\n\n## WHY THIS CHECK WAS CALLED\nThe GM requested this check because: ${flavor}\nUse this context to write a narration that directly relates to this specific reason.`
      : "";

    const prompt = NARRATION_PROMPT
      .replace("{actorName}",       actorName)
      .replace("{actorRace}",       actorRace || "unknown race")
      .replace("{actorClass}",      actorClass || "adventurer")
      .replace("{skillLabel}",      skillLabel)
      .replace("{skillId}",         skill)
      .replace("{dc}",              dc)
      .replace("{total}",           total)
      .replace("{natural}",         natural)
      .replace("{resultCategory}",  resultCategory)
      .replace("{lengthInstruction}", lengthPref)
      .replace("{sceneContext}",    sceneCtx || "No scene data available.")
      .replace("{npcContext}",      npcMem   || "No NPC context available.")
      + flavorCtx;

    try {
      let response = await this.ai.chat(prompt, "", "", []);
      // Strip markdown fencing
      response = response.replace(/```[a-z]*\s*/g, "").replace(/```\s*/g, "").trim();
      // If the AI returned a JSON array, extract the first entry
      if (response.startsWith("[")) {
        const arr = this._parseNarrations(response);
        if (arr.length) return [arr[0]];
      }
      // Otherwise treat as a single narration string
      response = response.replace(/^\[?"?|"?\]?$/g, "").trim();
      return response ? [response] : this._fallbackNarrations(resultCategory, skillLabel, actorName);
    } catch (err) {
      console.error(`${MODULE_ID} | Subtle Roll narration failed:`, err);
      return this._fallbackNarrations(resultCategory, skillLabel, actorName);
    }
  }

  // ────────────────────────────────────────────────────────────
  // AI — Detect when rolls should happen (auto-detect)
  // ────────────────────────────────────────────────────────────

  startAutoDetect() {
    // Clear any existing interval first (allows setting changes without restart)
    this.stopAutoDetect();
    const baseSec = game.settings.get(MODULE_ID, "suggestionInterval") || 120;
    this._detectInterval = setInterval(() => this.detectRollOpportunities(), baseSec * 1000);
    console.log(`${MODULE_ID} | Subtle Roll auto-detect started (every ${baseSec}s)`);
  }

  stopAutoDetect() {
    if (this._detectInterval) {
      clearInterval(this._detectInterval);
      this._detectInterval = null;
    }
  }

  /** Restart the interval (call after settings change). */
  restartAutoDetect() {
    if (this._detectInterval) {
      this.startAutoDetect();
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
        const traps = tm.api.getTraps(canvas?.scene?.id);
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
      const raw         = this._parseDetections(response);

      // Hard filter: only player characters, never NPCs
      const suggestions = raw.filter(s => {
        const actor = game.actors.getName(s.actorName);
        return actor?.hasPlayerOwner && actor.type === "character";
      });

      if (suggestions.length) {
        this._notify({ type: "rollSuggestions", suggestions });
        // Show a dismissable popup for each suggestion (not in chat)
        for (const s of suggestions) {
          this._showDetectionPopup(s);
        }
      }
      return suggestions;
    } catch (err) {
      console.error(`${MODULE_ID} | Subtle Roll detection error:`, err);
      return [];
    }
  }

  /**
   * Show a small floating popup in the top-right corner for a
   * subtle-roll suggestion. Auto-dismisses after 20s.
   * GM can press Enter, Escape, or click Dismiss to close.
   */
  _showDetectionPopup(suggestion) {
    const skillLabel = SKILL_LABELS[suggestion.skill] ?? suggestion.skill;
    const actor = game.actors.getName(suggestion.actorName);
    const owner = actor ? game.users.find(u => !u.isGM && actor.testUserPermission(u, "OWNER")) : null;

    // Remove any existing popup (only one at a time)
    document.getElementById("ace-subtle-popup")?.remove();

    const popup = document.createElement("div");
    popup.id = "ace-subtle-popup";
    popup.setAttribute("tabindex", "0");
    popup.innerHTML =
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">` +
      `<span style="color:#c4a8f0;font-weight:bold;font-size:0.9em;">` +
      `<i class="fas fa-brain" style="margin-right:4px;"></i>Subtle Roll Suggestion</span>` +
      `<button id="ace-subtle-popup-dismiss" style="background:none;border:none;color:#888;` +
      `cursor:pointer;font-size:1.1em;padding:0 2px;" title="Dismiss (Enter/Esc)">✕</button>` +
      `</div>` +
      `<div style="color:#e0ddd8;margin-bottom:4px;font-size:0.88em;">` +
      `<strong>${_escapeHtml(suggestion.actorName)}</strong> → ` +
      `<strong style="color:#c4a8f0;">${_escapeHtml(skillLabel)}</strong> DC ${suggestion.dc}</div>` +
      `<div style="font-size:0.8em;color:#9a9890;font-style:italic;margin-bottom:8px;">` +
      `${_escapeHtml(suggestion.reason)}</div>` +
      `<div style="display:flex;gap:6px;">` +
      `<button id="ace-subtle-popup-send" data-skill="${suggestion.skill}" data-dc="${suggestion.dc}" ` +
      `data-actor-id="${actor?.id ?? ""}" data-user-id="${owner?.id ?? ""}" ` +
      `data-flavor="${_encodeAttr(suggestion.flavor)}" ` +
      `style="flex:1;padding:5px 8px;background:#18102a;border:1px solid #8a5bbf;border-radius:3px;` +
      `color:#c4a8f0;cursor:pointer;font-family:inherit;font-size:0.85em;font-weight:bold;">` +
      `<i class="fas fa-paper-plane" style="margin-right:4px;"></i>Send</button>` +
      `<button id="ace-subtle-popup-close" style="flex:1;padding:5px 8px;background:#222;` +
      `border:1px solid #555;border-radius:3px;color:#ccc;cursor:pointer;font-family:inherit;` +
      `font-size:0.85em;font-weight:bold;">Dismiss</button>` +
      `</div>`;

    // Styles — slides in from right edge, docks beside sidebar
    const sidebar = document.getElementById("sidebar");
    const sidebarRight = sidebar ? (window.innerWidth - sidebar.getBoundingClientRect().left + 8) : 320;
    Object.assign(popup.style, {
      position: "fixed",
      top: "80px",
      right: `${sidebarRight}px`,
      width: "300px",
      background: "#1c150e",
      border: "1px solid #8a5bbf",
      borderLeft: "4px solid #8a5bbf",
      borderRadius: "6px",
      padding: "12px 14px",
      fontFamily: "'Rajdhani', 'Segoe UI', sans-serif",
      lineHeight: "1.5",
      zIndex: "10000",
      boxShadow: "0 4px 20px rgba(0,0,0,0.7)",
      transform: "translateX(100%)",
      opacity: "0",
      transition: "transform 0.35s ease, opacity 0.35s ease",
    });

    document.body.appendChild(popup);
    // Trigger slide-in on next frame
    requestAnimationFrame(() => {
      popup.style.transform = "translateX(0)";
      popup.style.opacity = "1";
      popup.focus();
    });

    // Dismiss handler — slides out to the right
    const dismiss = () => {
      popup.style.transform = "translateX(100%)";
      popup.style.opacity = "0";
      setTimeout(() => popup.remove(), 350);
      document.removeEventListener("keydown", onKey);
    };

    // No auto-dismiss timer — only replaced when a new suggestion arrives

    // Close on Escape, Enter, or button click
    const onKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
      }
    };
    document.addEventListener("keydown", onKey);

    popup.querySelector("#ace-subtle-popup-dismiss")?.addEventListener("click", dismiss);
    popup.querySelector("#ace-subtle-popup-close")?.addEventListener("click", dismiss);

    // Send button — triggers roll request and dismisses
    popup.querySelector("#ace-subtle-popup-send")?.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      const skill = btn.dataset.skill;
      const dc = parseInt(btn.dataset.dc) || 15;
      const actorId = btn.dataset.actorId;
      const userId = btn.dataset.userId;
      const flavor = btn.dataset.flavor || "The DM calls for a check...";

      if (actorId && userId) {
        this.requestRoll({ targetUserId: userId, actorId, skill, dc, flavor });
      } else {
        ui.notifications?.warn("ACE: Cannot send roll — actor or player not found.");
      }
      dismiss();
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

  /**
   * Get narration length instruction based on user setting.
   * Returns the instruction string to inject into the AI prompt.
   */
  _getNarrationLength() {
    let pref = "short";
    try { pref = game.settings.get(MODULE_ID, "subtleNarrationLength") || "short"; } catch (_) {}
    switch (pref) {
      case "short":
        return "Respond with ONLY 1 sentence (15-25 words max). Be vivid but extremely concise.";
      case "medium":
        return "Respond with ONLY 2 sentences (30-50 words max). Be vivid but concise.";
      case "long":
        return "Respond with a single narration paragraph (3-5 sentences, 60-100 words). Be vivid and immersive.";
      default:
        return "Respond with ONLY 1 sentence (15-25 words max). Be vivid but extremely concise.";
    }
  }

  // ────────────────────────────────────────────────────────────
  // HELPERS — JSON parsers
  // ────────────────────────────────────────────────────────────

  _parseNarrations(text) {
    try {
      let cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

      // If the AI returned prose instead of a JSON array, try to extract it
      if (!cleaned.startsWith("[")) {
        const match = cleaned.match(/\[[\s\S]*\]/);
        if (match) {
          cleaned = match[0];
        } else {
          // Pure prose — treat the whole response as a single narration
          if (cleaned.length > 20) return [cleaned];
          return [];
        }
      }

      const arr = JSON.parse(cleaned);
      if (!Array.isArray(arr)) return [];
      return arr.filter(s => typeof s === "string" && s.length > 0).slice(0, 3);
    } catch (err) {
      // Last resort: if JSON parse fails but we have text, use it as a single narration
      const fallback = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      if (fallback.length > 20) return [fallback];
      console.warn(`${MODULE_ID} | Could not parse narrations:`, err.message);
      return [];
    }
  }

  _parseDetections(text) {
    try {
      let cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

      // If the AI returned prose instead of JSON, try to extract JSON from it
      if (!cleaned.startsWith("[")) {
        const match = cleaned.match(/\[[\s\S]*\]/);
        if (match) {
          cleaned = match[0];
        } else {
          // Pure prose with no JSON — AI decided no rolls needed (or failed to format)
          if (cleaned === "[]" || cleaned.toLowerCase().includes("no roll")) return [];
          console.log(`${MODULE_ID} | Subtle Roll detection: AI returned prose, no JSON found`);
          return [];
        }
      }

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
      console.warn(`${MODULE_ID} | Could not parse detections (non-critical):`, err.message);
      return [];
    }
  }

  _fallbackNarrations(resultCategory, skillLabel, actorName) {
    if (resultCategory.includes("Misinformation")) {
      return [
        `${actorName} is absolutely certain about what they perceive. There is nothing unusual here at all — everything is exactly as it appears.`,
      ];
    }
    if (resultCategory.includes("Success") || resultCategory.includes("Natural 20")) {
      return [
        `${actorName}'s keen senses pick up on something important about the situation — a detail that others would easily overlook.`,
      ];
    }
    return [
      `${actorName} considers the situation carefully but cannot draw any firm conclusions one way or another.`,
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

  /** Card 2: Single result + narration — GM-only whisper with broadcast + override buttons */
  _buildResultCard(actorName, skillLabel, dc, total, natural, narration, requestId, targetUserId = "", flavor = "") {
    const isNat1  = natural === 1;
    const isNat20 = natural === 20;
    const passed  = total >= dc;

    const bannerColor = isNat1 ? "#c43b3b" : isNat20 ? "#c9a84c" : passed ? "#5db88a" : "#e06060";
    const bannerText  = isNat1  ? "NATURAL 1 — Misinformation"
                      : isNat20 ? "NATURAL 20 — Perfect Insight"
                      : passed  ? `PASSED (${total} vs DC ${dc})`
                      :           `FAILED (${total} vs DC ${dc})`;

    // Override button label — opposite of what actually happened
    const overrideLabel = passed ? "Override: Fail" : "Override: Pass";
    const overrideIcon  = passed ? "fa-times-circle" : "fa-check-circle";
    const overrideColor = passed ? "#e06060" : "#5db88a";

    let html =
      `<div class="ace-subtle-result" style="background:#1c150e;border-left:4px solid #8a5bbf;` +
      `border-radius:4px;padding:10px 12px;font-family:'IM Fell English','Palatino Linotype',serif;line-height:1.6;">` +
      // Header
      `<div style="color:#c4a8f0;font-weight:bold;font-size:1.05em;margin-bottom:4px;">` +
      `<i class="fas fa-eye" style="margin-right:4px;"></i>` +
      ` Subtle Roll — ${_escapeHtml(actorName)}</div>` +
      // Result banner
      `<div style="background:${bannerColor}22;border:1px solid ${bannerColor};` +
      `border-radius:3px;padding:4px 8px;margin-bottom:10px;text-align:center;` +
      `color:${bannerColor};font-weight:bold;font-size:0.9em;">` +
      `${bannerText} &nbsp;|&nbsp; d20: ${natural} + ${total - natural} = ${total}</div>`;

    if (narration) {
      html +=
        // Narration text (wrapped in a div with ID for override replacement)
        `<div class="ace-subtle-narration-text" style="font-style:italic;color:#eddfc5;margin-bottom:10px;font-size:0.95em;` +
        `border-left:3px solid #3a3a40;padding-left:10px;">` +
        `"${_escapeHtml(narration)}"</div>` +
        // Button row — Broadcast + Override side by side
        `<div style="display:flex;gap:6px;">` +
        // Broadcast button — sends narration + TTS to ONLY the rolling player
        `<button class="ace-chat-btn" data-ace-btn="subtle-broadcast" ` +
        `data-request-id="${requestId}" ` +
        `data-actor-name="${_escapeHtml(actorName)}" ` +
        `data-skill-label="${_escapeHtml(skillLabel)}" ` +
        `data-target-user-id="${targetUserId}" ` +
        `data-narration="${encodeURIComponent(narration)}" ` +
        `style="flex:1;padding:8px 12px;` +
        `background:#18102a;border:1px solid #c9a84c;border-radius:4px;` +
        `color:#c9a84c;cursor:pointer;font-family:inherit;font-size:0.95em;` +
        `text-align:center;font-weight:bold;transition:all 0.2s;">` +
        `<i class="fas fa-bullhorn" style="margin-right:6px;"></i>` +
        `Broadcast</button>` +
        // Override button — generates opposite narration
        `<button class="ace-chat-btn" data-ace-btn="subtle-override" ` +
        `data-request-id="${requestId}" ` +
        `data-actor-name="${_escapeHtml(actorName)}" ` +
        `data-skill-label="${_escapeHtml(skillLabel)}" ` +
        `data-skill="${_escapeHtml(skillLabel)}" ` +
        `data-dc="${dc}" data-total="${total}" data-natural="${natural}" ` +
        `data-target-user-id="${targetUserId}" ` +
        `data-passed="${passed ? "true" : "false"}" ` +
        `data-flavor="${encodeURIComponent(flavor)}" ` +
        `style="flex:1;padding:8px 12px;` +
        `background:#18102a;border:1px solid ${overrideColor};border-radius:4px;` +
        `color:${overrideColor};cursor:pointer;font-family:inherit;font-size:0.95em;` +
        `text-align:center;font-weight:bold;transition:all 0.2s;">` +
        `<i class="fas ${overrideIcon}" style="margin-right:6px;"></i>` +
        `${overrideLabel}</button>` +
        `</div>`;
    } else {
      html +=
        `<div style="font-style:italic;color:#7a6042;font-size:0.85em;">` +
        `Narration generation failed — describe the result manually.</div>`;
    }

    html += `</div>`;
    return html;
  }

  /** Card 2b: Legacy Narration Picker — GM-only whisper (kept for batch rolls) */
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

    html += `</div>`;
    return html;
  }

  /** Card 3: Narration Delivery — broadcast to everyone */
  _buildNarrationDeliveryCard(actorName, skillLabel, narrationText) {
    return (
      `<div class="ace-subtle-delivery" style="background:#1c150e;border-left:6px solid #c9a84c;` +
      `border-radius:6px;padding:14px 16px;font-family:'IM Fell English','Palatino Linotype',serif;line-height:1.7;">` +
      `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">` +
      `<span style="color:#c9a84c;font-weight:bold;font-size:1.1em;` +
      `text-transform:uppercase;letter-spacing:1px;">` +
      `<i class="fas fa-scroll" style="margin-right:6px;"></i>` +
      `${skillLabel} — ${_escapeHtml(actorName)}</span></div>` +
      `<div style="font-style:italic;color:#eddfc5;font-size:1.15em;">` +
      `"${_escapeHtml(narrationText)}"</div>` +
      `</div>`
    );
  }

  /** Card 4: Consolidated Batch — GM-only, one card for all actors.
   *  Clean, compact layout inspired by D&D 5e damage application cards.
   *  @param {Array} [narrations] — Optional. If provided, each entry has a `.narration` string
   *  that gets appended under the actor's row with a "Broadcast" button. */
  _buildConsolidatedCard(skillLabel, dc, flavor, results, narrations) {
    const hasNarrations = narrations?.some(n => n.narration);

    let html =
      `<div class="ace-subtle-batch" style="background:#1e1e22;border-radius:6px;padding:0;` +
      `font-family:'Rajdhani','Segoe UI',sans-serif;overflow:hidden;border:1px solid #333;">` +
      // Header bar
      `<div style="background:#2a1a3a;padding:8px 14px;display:flex;align-items:center;justify-content:space-between;">` +
      `<span style="color:#c4a8f0;font-weight:bold;font-size:1em;letter-spacing:0.5px;">` +
      `<i class="fas fa-eye-slash" style="margin-right:6px;"></i>${_escapeHtml(skillLabel)}</span>` +
      `<span style="color:#c4a8f0;font-weight:bold;font-size:1em;">DC ${dc}</span>` +
      `</div>`;

    // Flavor text (compact)
    if (flavor) {
      html += `<div style="padding:6px 14px;font-style:italic;color:#9a9890;font-size:0.9em;` +
        `border-bottom:1px solid #2a2a2e;">"${_escapeHtml(flavor)}"</div>`;
    }

    // Actor rows — compact like D&D 5e damage cards
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const n = narrations?.[i];
      const color = r.error  ? "#555"
                  : r.isNat1  ? "#c43b3b"
                  : r.isNat20 ? "#c9a84c"
                  : r.passed  ? "#5db88a"
                  :             "#e06060";
      const label = r.error  ? "ERR"
                  : r.isNat1  ? "NAT 1"
                  : r.isNat20 ? "NAT 20"
                  : r.passed  ? "PASS"
                  :             "FAIL";
      const advTag = r.advState === "advantage"
        ? ` <span style="color:#5db88a;font-size:0.75em;font-weight:bold;" title="Advantage">ADV</span>`
        : r.advState === "disadvantage"
        ? ` <span style="color:#e06060;font-size:0.75em;font-weight:bold;" title="Disadvantage">DIS</span>`
        : "";

      html +=
        `<div style="padding:6px 14px;display:flex;align-items:center;gap:10px;` +
        `border-bottom:1px solid #2a2a2e;">` +
        // Portrait (small)
        `<img src="${r.actorImg}" style="width:32px;height:32px;border-radius:50%;` +
        `border:2px solid ${color};object-fit:cover;flex-shrink:0;" />` +
        // Name
        `<span style="flex:1;color:#e0ddd8;font-weight:600;font-size:0.95em;` +
        `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">` +
        `${_escapeHtml(r.actorName)}${advTag}</span>` +
        // Roll breakdown (compact)
        `<span style="color:#888;font-size:0.85em;flex-shrink:0;">` +
        `${r.natural}${r.modifier >= 0 ? "+" : ""}${r.modifier}</span>` +
        // Total
        `<span style="color:${color};font-weight:bold;font-size:1.1em;min-width:28px;text-align:right;">` +
        `${r.total}</span>` +
        // Pass/fail badge
        `<span style="font-size:0.8em;font-weight:bold;color:#1e1e22;` +
        `background:${color};border-radius:3px;padding:2px 6px;min-width:44px;text-align:center;">` +
        `${label}</span>` +
        `</div>`;

      // Narration block (compact, under the actor row)
      if (n?.narration) {
        const narrId = `sr_narr_${i}_${Date.now()}`;
        html +=
          `<div style="padding:6px 14px 8px 56px;border-bottom:1px solid #2a2a2e;">` +
          `<div style="font-style:italic;color:#c5bfa8;font-size:0.88em;line-height:1.5;margin-bottom:6px;">` +
          `"${_escapeHtml(n.narration)}"</div>` +
          `<button class="ace-chat-btn" data-ace-btn="subtle-broadcast" ` +
          `data-narr-id="${narrId}" ` +
          `data-actor-name="${_encodeAttr(r.actorName)}" ` +
          `data-skill-label="${_encodeAttr(skillLabel)}" ` +
          `data-narration="${encodeURIComponent(n.narration)}" ` +
          `style="display:inline-block;padding:4px 12px;background:#2a1a3a;` +
          `border:1px solid ${color};border-radius:3px;color:${color};cursor:pointer;` +
          `font-family:inherit;font-size:0.85em;font-weight:bold;transition:all 0.2s;">` +
          `<i class="fas fa-bullhorn" style="margin-right:4px;"></i>Broadcast</button>` +
          `</div>`;
      }
    }

    // Loading indicator if narrations haven't arrived yet
    if (!hasNarrations) {
      html +=
        `<div style="text-align:center;color:#8a5bbf;font-size:0.85em;padding:8px 0;font-style:italic;">` +
        `<i class="fas fa-spinner fa-pulse" style="margin-right:4px;"></i>` +
        `Generating narrations…</div>`;
    }

    html += `</div>`;
    return html;
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
