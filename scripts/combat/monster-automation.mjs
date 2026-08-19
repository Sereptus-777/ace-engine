// ─── ACE: Engine — Monster Automation ─────────────────────────────────────
// Makes SRD monster traits, reactions, auras, and on-death effects FIRE
// AUTOMATICALLY in Foundry V13 / dnd5e 5.x instead of sitting inert on the
// stat block as text-only features.
//
// Design goals
// ------------
//  • Data-driven, NOT one-function-per-monster. We detect traits by the
//    feature-item NAME present on the dropped actor, then read the actual
//    rules text out of that feature's description to extract dice formulas
//    and save DCs. This means a single implementation of "Heated Body"
//    automatically covers the Salamander (2d6), Azer (1d10), Fire Snake
//    (1d6), and any homebrew creature that has a feature by that name —
//    each at its own printed damage value.
//  • Foundry-native: passive traits become ActiveEffects (so they show on
//    the token), reactive damage is rolled into chat with an Apply button,
//    on-death and start-of-turn effects roll into chat automatically.
//  • Safe: nothing is auto-applied to actors unless the GM opts in. The
//    headline behaviour ("the effect fires and rolls automatically") happens
//    regardless; only the HP-mutating step is gated so we never silently
//    break an encounter the GM is hand-running.
//
// Covered trait families (each generalises across many COMPENDIUM monsters):
//   Passive (createToken → ActiveEffect):
//     • Heated Body / Fire Aura  – fiery token light + reactive-melee rider
//     • Spider Climb             – grants climb speed = walk speed
//     • Pack Tactics             – advantage reminder marker
//     • Magic Resistance         – adv. on saves-vs-magic marker
//     • Sunlight Sensitivity     – disadvantage-in-sunlight marker
//     • Amphibious / Water Breathing – marker
//     • Legendary Resistance     – usage tracker marker
//   Reactive (dnd5e.rollDamage → chat):
//     • Heated Body, Barbed Hide, Fire Form, and any "melee attacker takes
//       X (YdZ) <type> damage" trait → rolls retaliation vs the attacker
//   On death (HP→0 → chat):
//     • Death Burst / Death Throes → rolls the AoE damage + prints the DC
//   Start of turn (updateCombat → chat):
//     • Regeneration → rolls the heal with an Apply button (respects the
//       fire/acid caveat by leaving application to the GM)
//   On failed save (dnd5e.rollSavingThrow → chat):
//     • Legendary Resistance → offers to convert the failure into a success
//
// All behaviour is gated behind the `monsterAutomation` master setting.

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Monsters";
const FLAG = "monster-automation";

/* ──────────────────────────────────────────────────────────────────────────
 * Settings
 * ────────────────────────────────────────────────────────────────────────*/

function registerSettings() {
  const reg = (key, def, name, hint, type = Boolean) => {
    try {
      game.settings.register(MODULE_ID, key, {
        name, hint, scope: "world", config: true, type, default: def,
      });
    } catch (_) { /* already registered */ }
  };
  reg("monsterAutomation", true,
    "Monster Trait Automation",
    "Master switch. Auto-fire SRD monster traits — Heated Body, Spider Climb, Pack Tactics, Death Burst, Regeneration, Legendary Resistance and more — when their tokens are placed and during combat.");
  reg("monsterAutoVisuals", true,
    "Monster Trait Visuals",
    "Give trait-bearing tokens a fitting glow (e.g. a fiery aura for Heated Body creatures) and a status icon so the GM can see at a glance which automations are live.");
  reg("monsterReactiveDamage", true,
    "Auto-roll Reactive Damage",
    "When a creature with a retaliation aura (Heated Body, Barbed Hide, …) is hit in melee, automatically roll its damage into chat against the attacker.");
  reg("monsterAutoApplyDamage", false,
    "Auto-apply Reactive Damage",
    "Apply rolled reactive/Death-Burst damage to targets automatically instead of waiting for the GM to click Apply. Off by default so you stay in control of HP.");
}

function enabled() {
  try { return game.settings.get(MODULE_ID, "monsterAutomation"); }
  catch (_) { return false; }
}
function setting(key, dflt = false) {
  try { return game.settings.get(MODULE_ID, key); }
  catch (_) { return dflt; }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Trait registry — fallback values when the stat-block text can't be parsed.
 * Detection is by feature NAME (case-insensitive). The description parser is
 * always preferred; these defaults only fill the gaps.
 * ────────────────────────────────────────────────────────────────────────*/

// Reactive "attacker takes X damage in melee" auras.
const REACTIVE_AURAS = {
  "heated body":  { defFormula: "2d6", defType: "fire",
                    byActor: { "azer": "1d10", "fire snake": "1d6", "salamander": "2d6" } },
  "fire form":    { defFormula: "1d10", defType: "fire" },
  "barbed hide":  { defFormula: "1d10", defType: "piercing" },
  "fiery body":   { defFormula: "2d6", defType: "fire" },
};

// On-death area effects.
const DEATH_EFFECTS = new Set([
  "death burst", "death throes", "death curse", "rotting death",
]);

// Start-of-turn self-heal.
const REGEN_TRAITS = new Set(["regeneration", "troll regeneration"]);

// Passive markers → cosmetic ActiveEffect (+ a functional change for some).
// icon paths are core Foundry icons that ship with every install.
const PASSIVE_MARKERS = {
  "spider climb":        { icon: "icons/creatures/webs/web-spider-glowing-purple.webp", climb: true },
  "pack tactics":        { icon: "icons/skills/social/intimidation-impressing.webp" },
  "magic resistance":    { icon: "icons/magic/defensive/shield-barrier-glowing-blue.webp" },
  "sunlight sensitivity":{ icon: "icons/magic/light/explosion-star-glow-yellow.webp" },
  "amphibious":          { icon: "icons/creatures/fish/fish-blue-fin.webp" },
  "water breathing":     { icon: "icons/creatures/fish/fish-blue-fin.webp" },
  "legendary resistance":{ icon: "icons/magic/defensive/shield-barrier-glowing-triangle-orange.webp", tracker: true },
};

/* ──────────────────────────────────────────────────────────────────────────
 * Text parsing helpers
 * ────────────────────────────────────────────────────────────────────────*/

function _plainText(html) {
  try {
    const div = document.createElement("div");
    div.innerHTML = html ?? "";
    return (div.textContent || "").replace(/\s+/g, " ").trim();
  } catch (_) { return String(html ?? ""); }
}

const DMG_TYPES = [
  "acid", "bludgeoning", "cold", "fire", "force", "lightning",
  "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder",
];

/**
 * Pull the first "X (YdZ[+N]) <type> damage" out of rules text.
 * Returns { formula, type, avg } or null.
 */
function parseDamageExpr(text) {
  if (!text) return null;
  // Prefer the parenthesised dice; fall back to a bare YdZ.
  const re = /(?:(\d+)\s*)?\((\d+d\d+(?:\s*[+-]\s*\d+)?)\)\s*([a-z]+)?\s*damage|(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*([a-z]+)?\s*damage/i;
  const m = text.match(re);
  if (!m) return null;
  const formula = (m[2] ?? m[4] ?? "").replace(/\s+/g, "");
  if (!formula) return null;
  const typeRaw = (m[3] ?? m[5] ?? "").toLowerCase();
  const type = DMG_TYPES.includes(typeRaw) ? typeRaw : null;
  return { formula, type };
}

/** Pull a "DC NN <Ability>" save out of rules text. */
function parseSaveDC(text) {
  if (!text) return null;
  const m = text.match(/DC\s*(\d+)\s*(strength|dexterity|constitution|intelligence|wisdom|charisma|str|dex|con|int|wis|cha)/i);
  if (!m) return null;
  return { dc: Number(m[1]), ability: m[2].slice(0, 3).toLowerCase() };
}

/** Pull "regains NN hit points" out of regeneration text. */
function parseRegen(text) {
  if (!text) return null;
  const m = text.match(/regains?\s*(\d+)\s*(?:\((\d+d\d+(?:\s*[+-]\s*\d+)?)\)\s*)?hit points?/i);
  if (!m) return null;
  return { amount: Number(m[1]), formula: (m[2] || "").replace(/\s+/g, "") || String(m[1]) };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Actor trait scanning
 * ────────────────────────────────────────────────────────────────────────*/

const _norm = (s) => (s ?? "").toLowerCase().trim();

/** All feature-ish items on an actor with their normalized names + text. */
function* iterTraits(actor) {
  for (const item of actor?.items ?? []) {
    if (item.type !== "feat" && item.type !== "feature") continue;
    yield {
      item,
      key: _norm(item.name),
      text: _plainText(item.system?.description?.value),
    };
  }
}

function findTrait(actor, predicate) {
  for (const t of iterTraits(actor)) if (predicate(t)) return t;
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Chat output helpers
 * ────────────────────────────────────────────────────────────────────────*/

function _chatStyle() {
  return CONST.CHAT_MESSAGE_STYLES?.OTHER ?? CONST.CHAT_MESSAGE_TYPES?.OTHER ?? 0;
}

/**
 * Post an ACE monster-automation card. `apply` (optional) describes an
 * Apply-damage / Apply-healing button: { actorUuid, amount, type, kind }.
 */
async function postCard({ title, icon, body, flavor, apply }) {
  let html = `<div class="ace-monster-card" style="border-left:3px solid #c0392b;padding:4px 8px;">`;
  html += `<header style="display:flex;align-items:center;gap:6px;font-weight:bold;">`;
  if (icon) html += `<img src="${icon}" width="22" height="22" style="border:none;flex:0 0 auto;">`;
  html += `<span>${title}</span></header>`;
  if (flavor) html += `<div style="font-style:italic;opacity:.8;font-size:.9em;">${flavor}</div>`;
  if (body) html += `<div style="margin-top:2px;">${body}</div>`;
  if (apply) {
    const verb = apply.kind === "heal" ? "Apply Healing" : "Apply Damage";
    html += `<button type="button" class="ace-monster-apply" `
      + `data-actor="${apply.actorUuid}" data-amount="${apply.amount}" `
      + `data-type="${apply.type || ""}" data-kind="${apply.kind || "damage"}" `
      + `style="margin-top:4px;width:100%;">${verb}: ${apply.amount}${apply.type ? " " + apply.type : ""}</button>`;
  }
  html += `</div>`;

  const data = {
    content: html,
    speaker: { alias: "ACE: Monsters" },
    style: _chatStyle(),
    flags: { [MODULE_ID]: { monsterAutomation: true, apply: apply ?? null } },
  };
  try { return await ChatMessage.create(data); }
  catch (err) { console.warn(`${TAG} | chat post failed:`, err); return null; }
}

/** Roll a formula, returning { total, roll } (roll already evaluated). */
async function rollFormula(formula) {
  const roll = new Roll(String(formula || "0"));
  await roll.evaluate();
  return { total: roll.total ?? 0, roll };
}

/** Resolve an Actor from a token/actor uuid string. */
async function actorFromUuid(uuid) {
  try {
    const doc = await fromUuid(uuid);
    if (!doc) return null;
    return doc.actor ?? doc; // TokenDocument → actor, or Actor itself
  } catch (_) { return null; }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 1. Passive traits → ActiveEffects on token drop
 * ────────────────────────────────────────────────────────────────────────*/

async function applyPassiveTraits(tokenDoc) {
  const actor = tokenDoc?.actor;
  if (!actor || actor.type !== "npc") return;
  // Linked actors share one base actor — only set up effects once.
  if (actor.getFlag(MODULE_ID, FLAG)?.passivesApplied && actor.prototypeToken?.actorLink) return;

  const toCreate = [];
  const seen = new Set();

  for (const t of iterTraits(actor)) {
    // Reactive auras & Heated Body → visual marker + (visuals) token light.
    if (REACTIVE_AURAS[t.key] && !seen.has("aura") && !qolOwnsTrait("reactive aura")) {
      seen.add("aura");
      const isFire = (REACTIVE_AURAS[t.key].defType ?? "fire") === "fire";
      toCreate.push(_effectData(actor, t.item.name,
        isFire ? "icons/magic/fire/flame-burning-creature-skeleton.webp"
               : "icons/skills/melee/strike-blade-knife-white-red.webp"));
      if (isFire && setting("monsterAutoVisuals", true)) _applyFireGlow(tokenDoc);
    }

    // Passive markers (Spider Climb, Pack Tactics, Magic Resistance, …).
    const marker = PASSIVE_MARKERS[t.key];
    if (marker && !seen.has(t.key)) {
      seen.add(t.key);
      const changes = [];
      if (marker.climb) {
        const walk = Number(actor.system?.attributes?.movement?.walk) || 0;
        if (walk > 0) changes.push({
          key: "system.attributes.movement.climb",
          mode: CONST.ACTIVE_EFFECT_MODES.UPGRADE,
          value: String(walk), priority: 20,
        });
      }
      toCreate.push(_effectData(actor, t.item.name, marker.icon, changes));
    }
  }

  if (!toCreate.length) {
    await _markPassivesApplied(actor);
    return;
  }
  try {
    // Skip effects that already exist (idempotent across re-drops / reloads).
    const existing = new Set(actor.effects.map(e => e.name));
    const fresh = toCreate.filter(e => !existing.has(e.name));
    if (fresh.length) await actor.createEmbeddedDocuments("ActiveEffect", fresh);
    await _markPassivesApplied(actor);
    console.log(`${TAG} | Applied ${fresh.length} passive trait effect(s) to ${actor.name}.`);
  } catch (err) {
    console.warn(`${TAG} | Failed applying passive traits to ${actor.name}:`, err);
  }
}

function _effectData(actor, name, icon, changes = []) {
  return {
    name,
    icon,                       // v11/v12 key
    img: icon,                  // v13 key
    origin: actor.uuid,
    disabled: false,
    transfer: false,
    changes,
    flags: { [MODULE_ID]: { monsterAutomation: true } },
    description: `Auto-applied by ACE monster automation.`,
  };
}

async function _markPassivesApplied(actor) {
  try { await actor.setFlag(MODULE_ID, FLAG, { passivesApplied: true }); }
  catch (_) {}
}

/** Give a Heated-Body token a subtle fiery light if it has none of its own. */
async function _applyFireGlow(tokenDoc) {
  try {
    if (tokenDoc.getFlag(MODULE_ID, "fireGlow")) return;
    const dim = Number(tokenDoc.light?.dim) || 0;
    const bright = Number(tokenDoc.light?.bright) || 0;
    if (dim > 0 || bright > 0) return; // respect an existing light source
    await tokenDoc.update({
      light: {
        dim: 2, bright: 1, color: "#ff7a18", alpha: 0.35,
        animation: { type: "torch", speed: 2, intensity: 3 },
      },
      [`flags.${MODULE_ID}.fireGlow`]: true,
    });
  } catch (err) { console.warn(`${TAG} | fire glow failed:`, err); }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 2. Reactive melee auras → fire on attacker (dnd5e.rollDamage)
 * ────────────────────────────────────────────────────────────────────────*/

async function onDamageRolled(rolls, data) {
  if (!enabled() || !setting("monsterReactiveDamage", true)) return;
  const activity = data?.subject;
  if (!activity) return;

  // Only melee attacks provoke touch/melee retaliation auras.
  const isMelee = activity.attack?.type?.value === "melee"
    || activity.item?.system?.attackType === "melee"
    || _normRange(activity) === "melee";
  if (!isMelee) return;

  const attacker = activity.actor;
  if (!attacker) return;

  // Targets come from the rolling user's target set.
  const targets = [...(game.user?.targets ?? [])];
  if (!targets.length) return;

  for (const tok of targets) {
    const victim = tok?.actor;
    if (!victim || victim === attacker) continue;

    // ⚠️ QOL OWNS RETALIATION (Brock, 2026-08-19). The comment on qolOwnsTrait
    // listed Heated Body as something Engine "uniquely provides". It does not:
    // ace-qol/scripts/retaliation-engine.mjs has handled exactly this family
    // since June, and handles it BETTER — it reads each feature's DESCRIPTION
    // for the retaliation intent instead of matching a name, so it catches the
    // homebrew salamander whose trait is called "Molten Hide", which the name
    // table below never would. With both installed, the attacker took the
    // damage twice.
    if (qolOwnsTrait("reactive aura")) continue;

    const aura = findTrait(victim, (t) => REACTIVE_AURAS[t.key]);
    if (!aura) continue;

    const cfg = REACTIVE_AURAS[aura.key];
    // Prefer the printed value in THIS creature's stat block.
    const parsed = parseDamageExpr(aura.text);
    let formula = parsed?.formula
      || cfg.byActor?.[_norm(victim.name)]
      || cfg.defFormula;
    let type = parsed?.type || cfg.defType || "fire";

    const { total } = await rollFormula(formula);
    if (total <= 0) continue;

    const attackerToken = attacker.token ?? attacker.getActiveTokens?.()[0]?.document;
    const applyUuid = attackerToken?.uuid ?? attacker.uuid;

    await postCard({
      title: `${victim.name}: ${aura.item.name}`,
      icon: type === "fire" ? "icons/magic/fire/flame-burning-creature-skeleton.webp" : null,
      flavor: `${attacker.name} struck ${victim.name} in melee.`,
      body: `<b>${attacker.name}</b> takes <b>${total}</b> ${type} damage (${formula}).`,
      apply: { actorUuid: applyUuid, amount: total, type, kind: "damage" },
    });

    if (setting("monsterAutoApplyDamage", false) && game.user.isGM) {
      await _applyDamage(attacker, total, type);
    }
  }
}

function _normRange(activity) {
  // Heuristic fallback: range value ≤ 10 ft (reach) with no long range ⇒ melee.
  const r = activity?.range;
  if (!r) return null;
  if (r.reach != null || (r.value != null && Number(r.value) <= 10 && !r.long)) return "melee";
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * 3. Death Burst / Death Throes → on HP reaching 0 (updateActor)
 * ────────────────────────────────────────────────────────────────────────*/

const _deathFired = new Set();

async function onActorUpdate(actor, changes) {
  if (!enabled()) return;
  if (game.users?.activeGM !== game.user) return; // single owner
  if (actor?.type !== "npc") return;

  const newHp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
  if (newHp === undefined || newHp > 0) return;

  const token = actor.token ?? actor.getActiveTokens?.()[0]?.document;
  const fireKey = token?.id ?? actor.id;
  if (_deathFired.has(fireKey)) return;

  const trait = findTrait(actor, (t) => DEATH_EFFECTS.has(t.key));
  if (!trait) return;
  _deathFired.add(fireKey);
  setTimeout(() => _deathFired.delete(fireKey), 10000); // allow re-kill later

  const dmg = parseDamageExpr(trait.text);
  const save = parseSaveDC(trait.text);
  if (!dmg) {
    await postCard({
      title: `${actor.name}: ${trait.item.name}`,
      icon: "icons/magic/fire/explosion-fireball-medium-orange.webp",
      body: trait.text || "Triggers its death effect.",
    });
    return;
  }

  const { total } = await rollFormula(dmg.formula);
  const dc = save ? ` — DC ${save.dc} ${save.ability.toUpperCase()} save for half` : "";
  await postCard({
    title: `${actor.name}: ${trait.item.name}`,
    icon: "icons/magic/fire/explosion-fireball-medium-orange.webp",
    flavor: `${actor.name} is destroyed!`,
    body: `Each creature within range takes <b>${total}</b> ${dmg.type || ""} damage (${dmg.formula})${dc}.`,
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * 4. Regeneration → start of the creature's turn (updateCombat)
 * ────────────────────────────────────────────────────────────────────────*/

async function onCombatTurn(combat, changed) {
  if (!enabled()) return;
  if (game.users?.activeGM !== game.user) return;
  if (!changed || !("turn" in changed)) return;

  const actor = combat?.combatant?.actor;
  if (!actor || actor.type !== "npc") return;

  const hp = actor.system?.attributes?.hp;
  if (!hp || hp.value <= 0 || hp.value >= hp.max) return; // dead or full

  const trait = findTrait(actor, (t) => REGEN_TRAITS.has(t.key) || /regenerat/i.test(t.key));
  if (!trait) return;

  // ACE QOL runs regeneration through its OverTime engine, which shares the
  // damage chokepoint. Two heal offers on one turn is worse than one.
  if (qolOwnsTrait("regeneration")) {
    console.debug(`${TAG} | Regeneration for ${actor.name} left to ACE QOL (OverTime engine).`);
    return;
  }

  const regen = parseRegen(trait.text);
  if (!regen) return;

  const { total } = await rollFormula(regen.formula);
  if (total <= 0) return;

  const token = actor.token ?? actor.getActiveTokens?.()[0]?.document;
  const applyUuid = token?.uuid ?? actor.uuid;
  // Note the elemental caveat so the GM can skip if it took fire/acid.
  const caveat = /fire|acid|radiant|necrotic/i.test(trait.text)
    ? " (unless it took the suppressing damage type since its last turn)"
    : "";

  await postCard({
    title: `${actor.name}: ${trait.item.name}`,
    icon: "icons/magic/life/heart-cross-green.webp",
    flavor: `Start of ${actor.name}'s turn`,
    body: `Regains <b>${total}</b> hit points${caveat}.`,
    apply: { actorUuid: applyUuid, amount: total, type: "", kind: "heal" },
  });

  if (setting("monsterAutoApplyDamage", false)) {
    await _applyDamage(actor, -total, null); // negative = healing
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 5. Legendary Resistance → on a failed save (dnd5e.rollSavingThrow)
 * ────────────────────────────────────────────────────────────────────────*/


/**
 * Does ACE QOL already own this monster trait at this table?
 *
 * ⚠️ TWO MODULES OFFERING THE SAME THING IS WORSE THAN NEITHER (Grok audit
 * 2026-08-18). Engine and QOL both automate Legendary Resistance and
 * Regeneration, and Engine's master switch defaults ON. With both installed —
 * which is the whole point of the suite — a monster failing a save produced
 * TWO "spend a Legendary Resistance?" prompts, and a regenerating creature
 * offered its heal twice. Click both and it heals twice.
 *
 * QOL is the combat engine and its versions are wired into the save pipeline,
 * the damage chokepoint and the reaction system. So QOL wins, and Engine
 * stands down for exactly the traits it duplicates — not for the ones it
 * uniquely provides (Death Burst and the other on-death effects, Spider Climb's
 * movement change, the passive stat-block markers).
 *
 * ⚠️ THIS COMMENT USED TO NAME "Heated Body" AS UNIQUELY ENGINE'S, and it was
 * wrong (Brock, 2026-08-19). QOL's retaliation engine has covered that whole
 * family since June. A stand-down list is only as good as the survey behind it,
 * and this one was written from memory instead of from a grep of the other
 * module. Before adding a trait here, search ace-qol for the CAPABILITY, not
 * the trait name — QOL matches retaliation by description intent, so it will
 * never contain the string "Heated Body" in the code that handles it.
 *
 * ⚠️ Checks that QOL is ACTIVE, not merely installed, and honours QOL's own
 * setting: if the GM turned QOL's Legendary Resistance off, Engine should NOT
 * silently take over — the GM asked for it off.
 */
function qolOwnsTrait(traitKey) {
  try {
    if (!game.modules?.get?.("ace-qol")?.active) return false;
    switch (traitKey) {
      case "legendary resistance":
        // QOL offers this from the save pipeline where it knows the DC and
        // the whole save context. Stand down whether its toggle is on or off.
        return true;
      case "regeneration":
        return true;
      case "reactive aura":
        // Heated Body, Fire Form, Barbed Hide, Fiery Body and every homebrew
        // rename of them. QOL applies these from the damage chokepoint, where
        // it already knows the attacker's resistances.
        return true;
      default:
        return false;
    }
  } catch (_) { return false; }
}

async function onSavingThrow(rolls, data) {
  if (!enabled()) return;
  const actor = data?.subject?.actor ?? data?.subject;
  if (!actor || actor.type !== "npc") return;

  const trait = findTrait(actor, (t) => t.key === "legendary resistance");
  if (!trait) return;

  // ACE QOL offers this from inside the save pipeline — do not prompt twice.
  if (qolOwnsTrait("legendary resistance")) {
    console.debug(`${TAG} | Legendary Resistance for ${actor.name} left to ACE QOL (it owns the save pipeline).`);
    return;
  }

  // Did the save fail? We can't always know the DC; only prompt when it's
  // clearly low. dnd5e stores the target DC on the roll options when set.
  const roll = rolls?.[0];
  const dc = roll?.options?.target ?? null;
  if (dc != null && (roll?.total ?? 99) >= dc) return; // succeeded → no prompt

  // Track remaining uses on the actor flag (resets via the feature's own uses).
  const usesItem = trait.item;
  const remaining = usesItem.system?.uses?.value
    ?? (trait.text.match(/(\d+)\s*\/\s*day/i)?.[1]) ?? "?";
  if (remaining === 0 || remaining === "0") return;

  await postCard({
    title: `${actor.name}: Legendary Resistance`,
    icon: PASSIVE_MARKERS["legendary resistance"].icon,
    flavor: dc != null ? `Failed a DC ${dc} save (rolled ${roll.total}).` : `May have failed a save.`,
    body: `<b>${actor.name}</b> can expend a use of Legendary Resistance to <b>succeed instead</b>. Uses remaining: <b>${remaining}</b>.`,
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Apply-damage button handler (renderChatMessageHTML)
 * ────────────────────────────────────────────────────────────────────────*/

function bindApplyButtons(message, html) {
  const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
  if (!root?.querySelectorAll) return;
  for (const btn of root.querySelectorAll(".ace-monster-apply")) {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (!game.user.isGM) {
        ui.notifications?.warn("Only the GM can apply monster automation damage.");
        return;
      }
      const { actor: uuid, amount, type, kind } = btn.dataset;
      const target = await actorFromUuid(uuid);
      if (!target) { ui.notifications?.warn("ACE: target token no longer exists."); return; }
      const amt = Number(amount) || 0;
      await _applyDamage(target, kind === "heal" ? -amt : amt, type || null);
      btn.disabled = true;
      btn.textContent = `${kind === "heal" ? "Healed" : "Applied"} ${amt}${type ? " " + type : ""}`;
    });
  }
}

/** Apply (positive) damage or (negative) healing, honoring resistances. */
async function _applyDamage(actor, amount, type) {
  try {
    if (!actor?.applyDamage) return;
    if (type) await actor.applyDamage([{ value: amount, type }]);
    else await actor.applyDamage(amount);
  } catch (err) {
    console.warn(`${TAG} | applyDamage failed:`, err);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Init
 * ────────────────────────────────────────────────────────────────────────*/

let _initialized = false;

export function initMonsterAutomation() {
  if (_initialized) return;
  _initialized = true;

  registerSettings();

  // Passive traits on token drop. activeGM-gated so that in a multi-GM game
  // exactly ONE client creates the ActiveEffects / edits the token light —
  // matching the module's existing multi-GM safety convention.
  Hooks.on("createToken", (tokenDoc) => {
    if (!enabled() || game.users?.activeGM !== game.user) return;
    applyPassiveTraits(tokenDoc).catch(err =>
      console.warn(`${TAG} | createToken handler:`, err));
  });

  // Reactive melee auras (fires on the rolling client; has the targets).
  Hooks.on("dnd5e.rollDamage", (rolls, data) => {
    onDamageRolled(rolls, data).catch(err =>
      console.warn(`${TAG} | rollDamage handler:`, err));
  });

  // Death Burst / Death Throes.
  Hooks.on("updateActor", (actor, changes) => {
    onActorUpdate(actor, changes).catch(err =>
      console.warn(`${TAG} | updateActor handler:`, err));
  });

  // Regeneration at start of turn.
  Hooks.on("updateCombat", (combat, changed) => {
    onCombatTurn(combat, changed).catch(err =>
      console.warn(`${TAG} | updateCombat handler:`, err));
  });

  // Legendary Resistance on failed save (V2 + legacy names).
  const saveHandler = (rolls, data) => onSavingThrow(rolls, data).catch(err =>
    console.warn(`${TAG} | save handler:`, err));
  Hooks.on("dnd5e.rollSavingThrow", saveHandler);
  Hooks.on("dnd5e.rollSavingThrowV2", saveHandler);

  // Apply-damage buttons on our chat cards.
  //
  // ⚠️ ONE HOOK PER CORE VERSION (2026-08-16 audit). This registered BOTH
  // renderChatMessageHTML AND legacy renderChatMessage unconditionally, and
  // Foundry V13 fires both for every message. bindApplyButtons has no
  // rebind guard, so every apply button got TWO click listeners — one click,
  // damage applied TWICE. Invisible in testing because the second apply reads
  // the same dataset and just doubles the number quietly.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    try { bindApplyButtons(message, html); } catch (_) {}
  });
  try {
    const major = parseInt(game?.version);
    if (isNaN(major) || major < 13) {
      Hooks.on("renderChatMessage", (message, html) => {
        try { bindApplyButtons(message, html); } catch (_) {}
      });
    }
  } catch (_) { /* no legacy registration — V13+ is covered above */ }

  console.log(`${TAG} | Monster trait automation initialized.`);
}

// Exposed for testing / manual re-scan from the console.
export const MonsterAutomation = {
  applyPassiveTraits, parseDamageExpr, parseSaveDC, parseRegen,
  REACTIVE_AURAS, DEATH_EFFECTS, REGEN_TRAITS, PASSIVE_MARKERS,
};
