// ============================================================
// ACE — Reputation / Word-of-Mouth Engine
//
// Tracks faction-level awareness of PCs based on encounters.
// When PCs fight/talk/kill NPCs of a type, other NPCs of the
// same type may later "know about" the PCs — decaying over time.
// Also handles disposition auto-update via AI response tags.
// ============================================================

import { MODULE_ID } from "./ace-engine.mjs";

// ── Significance weights by encounter kind ──────────────────
const SIGNIFICANCE = {
  combat:       0.7,
  kill:         0.9,
  conversation: 0.3,
};

// ── Survival multipliers ────────────────────────────────────
const SURVIVAL_BONUS = {
  survived: 1.5,
  fled:     1.3,
  killed:   0.7,
  unknown:  1.0,
};

// ── Tuning constants ────────────────────────────────────────
const DECAY_PER_SCENE       = 0.85;   // 15% decay per scene transition
const VAGUE_THRESHOLD       = 0.25;   // ≥ 0.25 = vague rumors
const DETAILED_THRESHOLD    = 0.60;   // ≥ 0.60 = detailed knowledge
const MAX_ENCOUNTERS        = 50;     // max stored per faction
const DIRECT_FLOOR          = 0.30;   // Direct encounters never decay below this

// ── NPC Stat Modifiers for propagation ────────────────────
// How well an NPC spreads info (INT + CHA of the original NPC)
// and how well the receiving NPC picks it up (WIS + INT)
const SPREAD_BONUS = {
  // Spreader: High INT/CHA = better description of events
  low:     0.7,   // INT or CHA ≤ 7  → poor communicator
  average: 1.0,   // 8-14 → normal
  high:    1.3,   // ≥ 15 → eloquent/charismatic spreader
};

const RECEIVE_BONUS = {
  // Receiver: High WIS/INT = pays attention to rumors
  low:     0.7,   // WIS or INT ≤ 7 → oblivious
  average: 1.0,   // 8-14 → normal
  high:    1.2,   // ≥ 15 → perceptive, listens carefully
};

// ── Intelligence Network Levels ───────────────────────────
// GM-configurable per faction: controls how much PC detail flows into AI prompts
const INTEL_LEVELS = {
  none:       0,   // Only faction rumors (default)
  informants: 1,   // Knows names and general descriptions (tavern spies)
  extensive:  2,   // Knows equipment, abilities, recent activities (scrying/familiar network)
  omniscient: 3,   // Knows everything (godlike beings, hive minds)
};

// ── Disposition constants (mirrors Foundry) ─────────────────
const DISP = {
  HOSTILE:  -1,
  NEUTRAL:   0,
  FRIENDLY:  1,
  SECRET:   -2,
};

const DISP_LABELS = { [-2]: "Secret", [-1]: "Hostile", 0: "Neutral", 1: "Friendly" };

export class ReputationEngine {

  /**
   * @param {object} memoryManager — AceMemoryManager instance (has .world, .npcs, .history)
   */
  constructor(memoryManager) {
    this._mm = memoryManager;
  }

  // ── Creature Type Resolution ──────────────────────────────

  /**
   * Extract the creature-type faction key from a Foundry actor.
   * dnd5e: system.details.type.value  → "goblinoid", "elemental", etc.
   * PF2e:  system.details.creatureType
   * Fallback: race or actor type
   * @param {Actor} actor
   * @returns {string|null}
   */
  resolveCreatureType(actor) {
    if (!actor?.system) return null;

    // dnd5e primary: creature type ("goblinoid", "undead", "elemental", etc.)
    const typeValue = actor.system?.details?.type?.value;
    if (typeValue && typeof typeValue === "string" && typeValue.trim()) {
      return typeValue.toLowerCase().trim();
    }

    // dnd5e subtype fallback ("goblin", "fire", etc.)
    const subtype = actor.system?.details?.type?.subtype;
    if (subtype && typeof subtype === "string" && subtype.trim()) {
      return subtype.toLowerCase().trim();
    }

    // PF2e: creatureType
    const pf2eType = actor.system?.details?.creatureType;
    if (pf2eType && typeof pf2eType === "string" && pf2eType.trim()) {
      return pf2eType.toLowerCase().trim();
    }

    // Generic fallback: race field
    const race = actor.system?.details?.race?.name
              ?? actor.system?.details?.race;
    if (race && typeof race === "string" && race.trim()) {
      return race.toLowerCase().trim();
    }

    return null;
  }

  /**
   * Resolve the faction key for an actor.
   * Checks if any GM-defined faction absorbs this creature type,
   * otherwise uses the creature type directly.
   * @param {Actor} actor
   * @returns {string|null}
   */
  resolveFactionKey(actor) {
    const creatureType = this.resolveCreatureType(actor);
    if (!creatureType) return null;

    // Check if any manually-grouped faction absorbs this creature type
    const factions = this._mm.world.getFactions();
    for (const [key, fac] of Object.entries(factions)) {
      if (fac.creatureTypes && Array.isArray(fac.creatureTypes)) {
        if (fac.creatureTypes.includes(creatureType)) return key;
      }
    }

    // Otherwise use the creature type itself as the faction key
    return creatureType;
  }

  // ── Faction Management ────────────────────────────────────

  /**
   * Ensure a faction entry exists in WorldStore. Auto-creates if missing.
   * @param {string} key — Faction key (creature type string)
   * @param {string} [displayName] — Human-friendly name
   */
  ensureFaction(key, displayName) {
    if (!key || !this._mm?.world) return;
    const factions = this._mm.world._data.factions;
    if (factions[key]) return; // already exists

    factions[key] = {
      displayName: displayName ?? key.charAt(0).toUpperCase() + key.slice(1),
      encounters: [],
    };
    this._mm.world.markDirty();
  }

  // ── Log Reputation Events ─────────────────────────────────

  /**
   * Record an encounter between PCs and an NPC faction.
   * Called when combat ends, an NPC is killed, or conversation occurs.
   * @param {object} opts
   * @param {string} opts.factionKey — Creature type / faction key
   * @param {string} opts.kind       — "combat" | "kill" | "conversation"
   * @param {string} opts.outcome    — "survived" | "killed" | "fled"
   * @param {string} opts.npcName    — NPC name(s) involved
   * @param {string[]} opts.pcNames  — PC names involved
   * @param {string} opts.scene      — Scene name
   * @param {string} opts.summary    — AI-readable summary (max 300 chars)
   * @param {object} [opts.npcStats] — {int, wis, cha} of the NPC involved
   * @param {object} [opts.pcSnapshots] — PC state at encounter time
   * @param {boolean} [opts.direct] — True if this NPC personally encountered the PCs
   *                                   (direct encounters never fully decay, min 30% awareness)
   */
  logEncounter({ factionKey, kind, outcome, npcName, pcNames, scene, summary, npcStats, pcSnapshots, direct }) {
    if (!factionKey || !this._mm?.world) return;

    this.ensureFaction(factionKey);
    const fac = this._mm.world._data.factions[factionKey];
    if (!fac) return;

    // Auto-snapshot PCs if not provided
    const snapshots = pcSnapshots ?? this._snapshotPCs(pcNames);

    fac.encounters.push({
      t:       Math.floor(Date.now() / 1000),
      sc:      this.getSceneCounter(),
      scene:   scene ?? "",
      kind:    kind ?? "combat",
      outcome: outcome ?? "unknown",
      npcName: npcName ?? "Unknown",
      pcNames: pcNames ?? [],
      summary: (summary ?? "").slice(0, 300),
      // NPC stats of the spreader (affects how well info propagates)
      npcStats: npcStats ?? null,
      // PC state at time of encounter (for change detection later)
      pcSnap:  snapshots,
      // Direct encounters (NPC personally met the PCs) never fully decay
      direct:  !!direct,
    });

    // Prune oldest if over limit
    if (fac.encounters.length > MAX_ENCOUNTERS) {
      fac.encounters.splice(0, fac.encounters.length - MAX_ENCOUNTERS);
    }

    this._mm.world.markDirty();
    this._mm._scheduleSave?.("world");

    console.log(`${MODULE_ID} | Reputation: logged ${kind} event for faction "${factionKey}" — ${npcName} (${outcome})`);
  }

  // ── PC Snapshot ─────────────────────────────────────────────

  /**
   * Capture current PC state for storage in encounter records.
   * Used for change detection when re-encountering ("you've grown stronger").
   * @param {string[]} pcNames
   * @returns {object} Map of pcName → snapshot
   */
  _snapshotPCs(pcNames) {
    if (!pcNames?.length) return {};
    const snapshots = {};
    for (const name of pcNames) {
      const actor = game.actors?.getName(name);
      if (!actor) continue;
      snapshots[name] = {
        level:   actor.system?.details?.level ?? 0,
        class:   actor.items?.find(i => i.type === "class")?.name ?? "",
        race:    actor.system?.details?.race?.value ?? actor.system?.details?.race ?? "",
        hp:      actor.system?.attributes?.hp?.value ?? 0,
        maxHp:   actor.system?.attributes?.hp?.max ?? 0,
        ac:      actor.system?.attributes?.ac?.value ?? 0,
        int:     actor.system?.abilities?.int?.value ?? 10,
        wis:     actor.system?.abilities?.wis?.value ?? 10,
        cha:     actor.system?.abilities?.cha?.value ?? 10,
        str:     actor.system?.abilities?.str?.value ?? 10,
        weapons: this._getNotableWeapons(actor),
        gear:    this._getNotableGear(actor),
      };
    }
    return snapshots;
  }

  /**
   * Get notable weapon names from an actor (equipped or most powerful).
   * @param {Actor} actor
   * @returns {string[]}
   */
  _getNotableWeapons(actor) {
    if (!actor?.items) return [];
    return actor.items
      .filter(i => i.type === "weapon" && (i.system?.equipped || i.system?.quantity > 0))
      .map(i => i.name)
      .slice(0, 3); // max 3
  }

  /**
   * Get notable gear (magic items, armor, shields).
   * @param {Actor} actor
   * @returns {string[]}
   */
  _getNotableGear(actor) {
    if (!actor?.items) return [];
    const notable = [];
    // Equipped armor
    const armor = actor.items.find(i => i.type === "equipment" && i.system?.armor?.type && i.system?.equipped);
    if (armor) notable.push(armor.name);
    // Magic items (rarity uncommon+)
    const rarities = new Set(["uncommon", "rare", "veryRare", "legendary", "artifact"]);
    for (const item of actor.items) {
      if (rarities.has(item.system?.rarity) && notable.length < 5) {
        notable.push(item.name);
      }
    }
    return notable;
  }

  // ── PC Change Detection ─────────────────────────────────────

  /**
   * Compare current PC state against a stored snapshot.
   * Returns human-readable changes for AI context.
   * @param {string} pcName
   * @param {object} oldSnapshot
   * @returns {string[]} Array of change descriptions
   */
  detectPcChanges(pcName, oldSnapshot) {
    if (!oldSnapshot) return [];
    const actor = game.actors?.getName(pcName);
    if (!actor) return [];

    const changes = [];
    const currentLevel = actor.system?.details?.level ?? 0;
    const currentWeapons = this._getNotableWeapons(actor);
    const currentGear = this._getNotableGear(actor);
    const currentAc = actor.system?.attributes?.ac?.value ?? 0;

    if (currentLevel > (oldSnapshot.level ?? 0)) {
      changes.push(`${pcName} has grown more powerful (was level ${oldSnapshot.level}, now level ${currentLevel}).`);
    }

    // New weapons not in old snapshot
    const oldWeapons = new Set(oldSnapshot.weapons ?? []);
    const newWeapons = currentWeapons.filter(w => !oldWeapons.has(w));
    if (newWeapons.length) {
      changes.push(`${pcName} now carries: ${newWeapons.join(", ")}.`);
    }

    // New notable gear
    const oldGear = new Set(oldSnapshot.gear ?? []);
    const newGear = currentGear.filter(g => !oldGear.has(g));
    if (newGear.length) {
      changes.push(`${pcName} has acquired: ${newGear.join(", ")}.`);
    }

    // Significant AC change
    if (currentAc > (oldSnapshot.ac ?? 0) + 2) {
      changes.push(`${pcName} appears much more heavily armored than before.`);
    }

    return changes;
  }

  // ── Awareness Computation ─────────────────────────────────

  /**
   * Compute how aware a faction is of the PCs, based on encounter history
   * and decay over scene transitions. Now factors in NPC stats:
   * - Spreader INT/CHA affects how well info propagates
   * - Receiver WIS/INT (optional) affects how well they pick it up
   * @param {string} factionKey
   * @param {Actor} [receiverActor] — The NPC receiving the info (optional, for stat-based bonus)
   * @returns {{ awareness: number, level: string, bestEvent: object|null }}
   */
  computeAwareness(factionKey, receiverActor) {
    const fac = this._mm.world._data.factions?.[factionKey];
    if (!fac?.encounters?.length) {
      return { awareness: 0, level: "unaware", bestEvent: null };
    }

    // Receiver bonus (how well this specific NPC pays attention to rumors)
    let receiverBonus = RECEIVE_BONUS.average;
    if (receiverActor?.system?.abilities) {
      const recWis = receiverActor.system.abilities?.wis?.value ?? 10;
      const recInt = receiverActor.system.abilities?.int?.value ?? 10;
      const recBest = Math.max(recWis, recInt);
      receiverBonus = recBest <= 7 ? RECEIVE_BONUS.low
                    : recBest >= 15 ? RECEIVE_BONUS.high
                    : RECEIVE_BONUS.average;
    }

    const currentScene = this.getSceneCounter();
    let maxAwareness = 0;
    let bestEvent = null;

    for (const enc of fac.encounters) {
      const scenesSince = currentScene - (enc.sc ?? 0);
      if (scenesSince < 0) continue;

      const sig  = SIGNIFICANCE[enc.kind] ?? 0.5;
      const surv = SURVIVAL_BONUS[enc.outcome] ?? 1.0;

      // Spreader bonus (how well the original NPC communicated the event)
      let spreadBonus = SPREAD_BONUS.average;
      if (enc.npcStats) {
        const npcInt = enc.npcStats.int ?? 10;
        const npcCha = enc.npcStats.cha ?? 10;
        const spreadBest = Math.max(npcInt, npcCha);
        spreadBonus = spreadBest <= 7 ? SPREAD_BONUS.low
                    : spreadBest >= 15 ? SPREAD_BONUS.high
                    : SPREAD_BONUS.average;
      }

      let aw = Math.min(1.0, sig * surv * spreadBonus * receiverBonus * Math.pow(DECAY_PER_SCENE, scenesSince));

      // Direct encounters (NPC personally met PCs) never fully decay.
      // A goblin that FOUGHT the party will always remember them, at least vaguely.
      if (enc.direct && aw < DIRECT_FLOOR) {
        aw = DIRECT_FLOOR;
      }

      if (aw > maxAwareness) {
        maxAwareness = aw;
        bestEvent = enc;
      }
    }

    const level = maxAwareness >= DETAILED_THRESHOLD ? "detailed"
                : maxAwareness >= VAGUE_THRESHOLD    ? "vague"
                : "unaware";

    return { awareness: maxAwareness, level, bestEvent };
  }

  // ── NPC Awareness Check ───────────────────────────────────

  /**
   * Full awareness check for a specific NPC. Resolves their faction,
   * computes awareness, and writes to the NPC's relationships record.
   * Called when a token is placed or discovered on a scene.
   * @param {string} npcName
   * @param {Actor} actor
   * @returns {{ factionKey: string, awareness: number, level: string, bestEvent: object }|null}
   */
  checkNpcAwareness(npcName, actor) {
    const factionKey = this.resolveFactionKey(actor);
    if (!factionKey) return null;

    const { awareness, level, bestEvent } = this.computeAwareness(factionKey);
    if (level === "unaware") return null;

    // Write awareness to the NPC's relationships in the NPC store
    const rec = this._mm.npcs.getRecord(npcName);
    if (rec) {
      const pcNames = bestEvent?.pcNames ?? [];
      for (const pc of pcNames) {
        rec.relationships[pc] = {
          aware:       true,
          source:      "faction",
          reason:      bestEvent?.summary ?? "Word has spread among their kind.",
          lastUpdated: Math.floor(Date.now() / 1000),
        };
      }
      this._mm.npcs.markDirty();
      this._mm._scheduleSave?.("npcs");
    }

    return { factionKey, awareness, level, bestEvent };
  }

  // ── AI Context Builder ────────────────────────────────────

  /**
   * Build a reputation context paragraph for injection into AI prompts.
   * Returns empty string if the NPC is unaware of PCs.
   * Now includes:
   * - Intelligence network level (controls detail)
   * - Knowledge scoping (tells AI what it does/doesn't know)
   * - PC change detection (notices level-ups, new weapons)
   * @param {string} npcName
   * @returns {string}
   */
  buildReputationContext(npcName) {
    const rec = this._mm.npcs.getRecord(npcName);
    if (!rec) return "";

    // Resolve faction key — try from stored actorId, or from relationships
    const actor = rec.actorId ? game.actors?.get(rec.actorId) : null;
    const factionKey = actor ? this.resolveFactionKey(actor) : null;
    if (!factionKey) return "";

    const { awareness, level, bestEvent } = this.computeAwareness(factionKey, actor);
    if (level === "unaware") return "";

    const fac = this._mm.world._data.factions?.[factionKey];
    const factionName = fac?.displayName ?? factionKey;
    const intelLevel = this.getIntelligenceNetwork(factionKey);
    const intelValue = INTEL_LEVELS[intelLevel] ?? 0;

    const isDirect = bestEvent?.direct ?? false;

    let ctx = `\n## REPUTATION AWARENESS\n`;
    ctx += `This ${factionName} `;

    if (isDirect) {
      // Direct encounter — this NPC (or this specific creature) personally fought/met the PCs
      ctx += `has PERSONALLY encountered these adventurers before. `;
      ctx += `It remembers: ${bestEvent?.summary ?? "a direct confrontation with the party."}`;
      ctx += `\nThis is a personal memory, not hearsay — the creature recalls the experience vividly.`;
    } else if (level === "detailed" || intelValue >= INTEL_LEVELS.informants) {
      ctx += `has heard detailed accounts from others of its kind about the adventurers. `;
      ctx += `They know: ${bestEvent?.summary ?? "the adventurers have been active in the area."}`;
    } else {
      ctx += `has heard vague rumors from others of its kind about adventurers in the area. `;
      ctx += `The rumors suggest: ${bestEvent?.summary ?? "strangers have been causing trouble."}`;
    }

    // Outcome-based disposition hints
    if (bestEvent?.outcome === "killed") {
      ctx += `\nOthers of this creature's kind were slain — it may be fearful or vengeful.`;
    } else if (bestEvent?.outcome === "survived" && bestEvent?.kind === "combat") {
      ctx += `\nA survivor reported the encounter — this creature is wary.`;
    } else if (bestEvent?.outcome === "fled") {
      ctx += `\nA survivor fled and spread the word — this creature is cautious.`;
    }

    // PC names (scoped by knowledge level)
    if (bestEvent?.pcNames?.length) {
      if (isDirect) {
        // Direct encounters: the NPC met them face-to-face
        ctx += `\nThe creature personally encountered: ${bestEvent.pcNames.join(", ")}.`;
      } else if (intelValue >= INTEL_LEVELS.informants || level === "detailed") {
        ctx += `\nNames the creature has heard: ${bestEvent.pcNames.join(", ")}.`;
      } else {
        ctx += `\nThe creature has heard there are ${bestEvent.pcNames.length} adventurers, but doesn't know their names.`;
      }
    }

    // ── Intelligence Network: detailed PC info ────────────────
    if (intelValue >= INTEL_LEVELS.extensive && bestEvent?.pcSnap) {
      ctx += `\n\nDETAILED INTELLIGENCE (from spy network/scrying):`;
      for (const [pcName, snap] of Object.entries(bestEvent.pcSnap)) {
        const parts = [`${pcName}`];
        if (snap.class) parts.push(`${snap.class} level ${snap.level}`);
        if (snap.weapons?.length) parts.push(`carries ${snap.weapons.join(", ")}`);
        if (snap.gear?.length) parts.push(`notable gear: ${snap.gear.join(", ")}`);
        ctx += `\n- ${parts.join(", ")}`;

        // PC change detection — compare old snapshot to current state
        const changes = this.detectPcChanges(pcName, snap);
        if (changes.length) {
          ctx += `\n  CHANGES NOTICED: ${changes.join(" ")}`;
        }
      }
    } else if (intelValue === INTEL_LEVELS.informants && bestEvent?.pcSnap) {
      ctx += `\n\nINFORMANT REPORTS (tavern gossip):`;
      for (const [pcName, snap] of Object.entries(bestEvent.pcSnap)) {
        const parts = [`${pcName}`];
        if (snap.class) parts.push(`appears to be a ${snap.class}`);
        if (snap.race) parts.push(`${snap.race}`);
        ctx += `\n- ${parts.join(", ")}`;
      }
    }

    // ── Knowledge Scoping (CRITICAL for AI behavior) ──────────
    if (intelValue >= INTEL_LEVELS.omniscient) {
      ctx += `\n\nYou have omniscient knowledge of these adventurers through your vast power. You know their every move, ability, and weakness.`;
    } else if (intelValue >= INTEL_LEVELS.extensive) {
      ctx += `\n\nYou have detailed intelligence about these adventurers through your spy network. Reference this information naturally — as reports from your agents.`;
    } else if (isDirect) {
      ctx += `\n\nYou personally experienced this encounter. You remember what you saw: their faces, fighting style, and weapons. You do NOT know their private plans, spells they didn't cast, or items they didn't show. Reference only what you witnessed firsthand.`;
    } else if (level === "detailed") {
      ctx += `\n\nYou know what others of your kind have told you: general descriptions, names, and the nature of encounters. You do NOT know specific weapons, spells, or detailed tactics unless described in the summary above.`;
    } else {
      ctx += `\n\nIMPORTANT: You have heard only VAGUE RUMORS. You know roughly that adventurers are in the area. You do NOT know their names, specific equipment, or abilities. Do NOT reference specific details you wouldn't know from vague word-of-mouth.`;
    }

    // Disposition change instruction
    ctx += `\n\nIMPORTANT: If during this conversation or interaction the NPC's attitude changes significantly (e.g., agrees to help, becomes friendly, turns hostile, or is persuaded), include a tag at the very END of your response on its own line: [DISPOSITION:NEUTRAL] or [DISPOSITION:FRIENDLY] or [DISPOSITION:HOSTILE]. Only include this when a genuine attitude shift occurs — not for minor dialogue.`;

    return ctx;
  }

  // ── Disposition Tag Parsing ───────────────────────────────

  /**
   * Parse a [DISPOSITION:...] tag from AI response text.
   * @param {string} text — Full AI response text
   * @returns {{ label: string, value: number, raw: string }|null}
   */
  parseDispositionTag(text) {
    if (!text) return null;
    const match = text.match(/\[DISPOSITION:(HOSTILE|NEUTRAL|FRIENDLY|SECRET)\]/i);
    if (!match) return null;

    const label = match[1].toUpperCase();
    const value = label === "HOSTILE"  ? DISP.HOSTILE
                : label === "NEUTRAL"  ? DISP.NEUTRAL
                : label === "FRIENDLY" ? DISP.FRIENDLY
                : label === "SECRET"   ? DISP.SECRET
                : null;

    return { label, value, raw: match[0] };
  }

  // ── Disposition Application ───────────────────────────────

  /**
   * Update a token's disposition on the canvas and show a GM notification.
   * @param {string|Token} tokenOrName — Token name string or Token object
   * @param {number} newDisposition — CONST.TOKEN_DISPOSITIONS value
   */
  async applyDispositionChange(tokenOrName, newDisposition) {
    if (newDisposition == null) return;

    // Resolve token from name or use directly
    let token;
    if (typeof tokenOrName === "string") {
      token = canvas?.tokens?.placeables?.find(t => t.name === tokenOrName);
    } else {
      token = tokenOrName;
    }

    if (!token?.document) {
      console.warn(`${MODULE_ID} | Reputation: could not find token "${tokenOrName}" for disposition change`);
      return;
    }

    const oldDisp = token.document.disposition;
    if (oldDisp === newDisposition) return; // no change needed

    try {
      await token.document.update({ disposition: newDisposition });

      const oldLabel = DISP_LABELS[oldDisp] ?? "Unknown";
      const newLabel = DISP_LABELS[newDisposition] ?? "Unknown";

      ui.notifications?.info(`ACE: ${token.name}'s disposition changed: ${oldLabel} → ${newLabel}`);
      console.log(`${MODULE_ID} | Reputation: ${token.name} disposition ${oldLabel} → ${newLabel}`);

      // Log to history
      this._mm.history.push({
        k:    "disposition_change",
        tgt:  token.name,
        from: oldLabel,
        to:   newLabel,
        s:    canvas?.scene?.name ?? "",
      });
      this._mm._scheduleSave?.("history");

      // Emit hook for story-note integration
      Hooks.callAll("ace.dispositionChange", {
        npcName:   token.name,
        fromLabel: oldLabel,
        toLabel:   newLabel,
        scene:     canvas?.scene?.name ?? "",
      });
    } catch (err) {
      console.error(`${MODULE_ID} | Reputation: failed to update disposition for ${token.name}:`, err);
    }
  }

  // ── Intelligence Network Management ─────────────────────

  /**
   * Get the intelligence network level for a faction.
   * Checks: 1) faction data in WorldStore, 2) module settings fallback.
   * @param {string} factionKey
   * @returns {string} "none" | "informants" | "extensive" | "omniscient"
   */
  getIntelligenceNetwork(factionKey) {
    if (!factionKey) return "none";

    // Check faction data first
    const fac = this._mm.world._data.factions?.[factionKey];
    if (fac?.intelligenceNetwork) return fac.intelligenceNetwork;

    // Fallback to module settings
    try {
      const networks = game.settings.get(MODULE_ID, "factionIntelNetworks") ?? {};
      return networks[factionKey] ?? "none";
    } catch (_) {
      return "none";
    }
  }

  /**
   * Set the intelligence network level for a faction.
   * Stores in both WorldStore faction data AND module settings for redundancy.
   * @param {string} factionKey
   * @param {string} level — "none" | "informants" | "extensive" | "omniscient"
   */
  async setIntelligenceNetwork(factionKey, level) {
    if (!factionKey) return;
    const validLevels = Object.keys(INTEL_LEVELS);
    if (!validLevels.includes(level)) {
      console.warn(`${MODULE_ID} | Invalid intelligence level "${level}". Valid: ${validLevels.join(", ")}`);
      return;
    }

    // Store in faction data
    this.ensureFaction(factionKey);
    const fac = this._mm.world._data.factions[factionKey];
    if (fac) {
      fac.intelligenceNetwork = level;
      this._mm.world.markDirty();
      this._mm._scheduleSave?.("world");
    }

    // Also store in module settings for redundancy
    try {
      const networks = foundry.utils.deepClone(game.settings.get(MODULE_ID, "factionIntelNetworks") ?? {});
      networks[factionKey] = level;
      await game.settings.set(MODULE_ID, "factionIntelNetworks", networks);
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not save intel network to settings:`, err);
    }

    const displayName = fac?.displayName ?? factionKey;
    console.log(`${MODULE_ID} | Reputation: ${displayName} intelligence network set to "${level}"`);
    ui.notifications?.info(`ACE: ${displayName} intelligence network → ${level}`);
  }

  /**
   * List all known factions and their intelligence network levels.
   * Useful for the GM to see what's configured.
   * @returns {Array<{key: string, displayName: string, encounters: number, intelNetwork: string}>}
   */
  listFactions() {
    const factions = this._mm.world._data.factions ?? {};
    return Object.entries(factions).map(([key, fac]) => ({
      key,
      displayName: fac.displayName ?? key,
      encounters: fac.encounters?.length ?? 0,
      intelNetwork: fac.intelligenceNetwork ?? "none",
    }));
  }

  // ── Scene Counter Helpers ─────────────────────────────────

  /** Increment the scene counter in WorldStore. */
  incrementSceneCounter() {
    const count = this._mm.world.incrementSceneCounter();
    this._mm._scheduleSave?.("world");
    console.log(`${MODULE_ID} | Reputation: scene counter → ${count}`);
    return count;
  }

  /** Get the current scene counter. */
  getSceneCounter() {
    return this._mm.world.getSceneCounter();
  }
}
