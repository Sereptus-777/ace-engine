// ─── ACE: Engine — NPC identity: name vs species ────────────────────────────
//
// ONE reader that answers three separate questions about a creature, which the
// prompt builders had been conflating into a single `actor.name`:
//
//   1. What is this creature CALLED?      "Lilith Vex"
//   2. What KIND of creature is it?       "cambion"
//   3. Is that a real NAME, or a label?   "Lilith Vex" vs "Goblin (3)"
//
// Born 2026-08-06. Johnny: Chud spoke to a cambion named Lilith Vex and the AI
// narrated her as "the cambion". Two causes, both here:
//   • The system prompt said `You are ${actor.name}` and NEVER mentioned the
//     creature's kind at all — so the model had no sanctioned way to say
//     "cambion" except by replacing her name with it.
//   • The prompt's only worked example of third-person narration was
//     "*The bandit eyes the newcomer…*" — literally teaching narrate-as-species.
//
// The fix is to give the model BOTH facts, clearly separated, plus a rule about
// which to use where. A named creature can then introduce itself — "I am Lilith
// Vex" — which is what makes a Strahd or a Lilith feel authored rather than
// generic.
//
// ⚠️ IDENTITY RULE (see memory): the sheet/actor/token name IS the creature.
// `flavorName` is a NAMEPLATE-ONLY flag and must never be treated as identity
// by mechanics — but it IS what players see over the token, so conversation is
// exactly the place it legitimately matters. It is reported separately here and
// never allowed to overwrite the real name.

const MODULE_ID = "ace-engine";

/** dnd5e's broad creature types. Useful as a fallback, too vague as a species. */
const BROAD_TYPES = new Set([
  "aberration", "beast", "celestial", "construct", "dragon", "elemental",
  "fey", "fiend", "giant", "humanoid", "monstrosity", "ooze", "plant", "undead",
]);

const clean = (v) => String(v ?? "").trim();

/**
 * Strip the decorations Foundry and GMs add when duplicating a creature, so
 * "Goblin (3)", "Goblin 2", "Goblin - Archer" all reduce to "goblin".
 */
function bareName(raw) {
  return clean(raw)
    .replace(/\s*\((?:\d+|copy)\)\s*$/i, "")   // "Goblin (3)", "Goblin (Copy)"
    .replace(/\s+#?\d+\s*$/, "")                // "Goblin 2", "Goblin #2"
    .replace(/\s*[-–—]\s*.*$/, "")              // "Goblin - Archer"
    .trim()
    .toLowerCase();
}

/**
 * The creature's KIND, most specific source first.
 *
 * dnd5e stores this as three fields and a sheet shows a blend of them:
 *   type.value   — the broad category ("fiend")   ← too vague on its own
 *   type.subtype — the specific kind ("cambion")  ← usually what we want
 *   type.custom  — free text, overrides the rest on the sheet
 * A renamed token loses none of these, but a GM who typed nothing anywhere
 * still leaves a clue: the BASE actor's name ("Cambion") when the token or a
 * duplicated actor was renamed to something personal.
 */
export function resolveSpecies(actor, tokenDoc = null) {
  if (!actor) return "";

  // 1. Explicit GM override — always wins, and is how a disguised or unusual
  //    creature gets described the way the GM wants without touching the sheet.
  try {
    const override = clean(actor.getFlag?.(MODULE_ID, "speciesOverride"));
    if (override) return override.toLowerCase();
  } catch (_) { /* flag unreadable — keep going */ }

  const type = actor.system?.details?.type ?? {};

  // 2. dnd5e's own free-text creature type — what the sheet displays.
  const custom = clean(type.custom);
  if (custom) return custom.toLowerCase();

  // 3. The specific subtype ("cambion", "goblinoid", "devil").
  const subtype = clean(type.subtype);
  if (subtype) return subtype.toLowerCase();

  // 4. The base actor's name, when this creature has been renamed.
  //    An unlinked token keeps its source Actor; a "Cambion" renamed on the
  //    token to "Lilith Vex" still has "Cambion" sitting on the base actor.
  try {
    const baseName = clean(game.actors?.get?.(tokenDoc?.actorId ?? actor.id)?.name);
    const shownName = clean(tokenDoc?.name || actor.name);
    if (baseName && bareName(baseName) !== bareName(shownName)) {
      return bareName(baseName);
    }
    // Same idea for a linked actor renamed after its prototype token was set.
    const protoName = clean(actor.prototypeToken?.name);
    if (protoName && bareName(protoName) !== bareName(shownName)) {
      return bareName(protoName);
    }
  } catch (_) { /* world not ready — fall through */ }

  // 5. The broad category. Vague, but "fiend" beats saying nothing.
  return clean(type.value).toLowerCase();
}

/**
 * Do two words describe the same kind of creature? String equality is not
 * enough: dnd5e ships goblins as name "Goblin" with subtype "goblinoid", and
 * "goblin" !== "goblinoid" would make a rank-and-file goblin look like it had
 * a personal name and narrate itself as "Goblin hesitates". Treat one word as
 * the same kind when either contains the other and the overlap is meaningful.
 */
function sameKind(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

// ── The compendium-backed generic-name probe ────────────────────────────────
// bio-generator already owns `_isGenericName`, which tests a name against an
// index of EVERY creature in the installed compendiums plus a role-word list.
// That beats any string heuristic here: it knows "Ogre" is a statblock and
// "Thalgar Stonehide" is not, without either matching the creature-type field.
// It is INJECTED rather than imported, because bio-generator imports this file
// and a direct import back would be a cycle.
let _genericProbe = null;

/** Called once by bio-generator at load. */
export function setGenericNameProbe(fn) {
  if (typeof fn === "function") _genericProbe = fn;
}

/**
 * Is the creature's name an actual NAME, or just a species label?
 * "Lilith Vex" → true.  "Goblin", "Goblin (3)", "Cambion 2" → false.
 *
 * @param {string} displayName  what the players see
 * @param {string} species      resolved creature kind
 * @param {string} [baseName]   UNUSED, kept for call-site compatibility. See below.
 *
 * ⚠️ A SOURCE-ACTOR NAME COMPARISON WAS TRIED HERE AND WAS WRONG (2026-08-06).
 * The idea was "still called what the statblock calls it → a label". For an
 * UNLINKED token that works, because the token name and the base actor's name
 * are different strings. For a LINKED actor the lookup returns the actor
 * ITSELF, so the two are ALWAYS equal and every linked NPC was judged unnamed —
 * Lilith Vex would have gone right on narrating as "the cambion", the exact bug
 * being fixed. My first test stub returned null for that lookup and hid it
 * completely; a stub more forgiving than reality is worse than no test. The
 * probe below is the reliable discriminator, so the comparison is gone.
 */
export function hasPersonalName(displayName, species, baseName = "") {
  const n = bareName(displayName);
  if (!n) return false;

  // Strongest signal first: the compendium-backed detector.
  if (_genericProbe) {
    try { return !_genericProbe(displayName, species); } catch (_) { /* fall through */ }
  }

  // Fallback for the window before the compendium index exists (early boot).
  const s = bareName(species);
  if (s) {
    if (sameKind(n, s)) return false;                       // "Goblin" vs "goblinoid"
    if (n.startsWith(`${s} `) || n.endsWith(` ${s}`)) return false;
    // "Goblin Archer" — first word is the kind, the rest is a role.
    const first = n.split(/\s+/)[0];
    if (sameKind(first, s)) return false;
  }

  // A bare broad type ("Fiend", "Undead") is never a personal name.
  if (BROAD_TYPES.has(n)) return false;
  if (n.split(/\s+/).every(w => BROAD_TYPES.has(w))) return false;

  return true;
}

/**
 * The whole identity picture for prompt builders.
 *
 * @param {Actor} actor
 * @param {TokenDocument|null} tokenDoc  the specific token being spoken to, if known
 * @returns {{name:string, species:string, isNamed:boolean, flavorName:string,
 *            shortName:string, descriptor:string, selfReference:string}}
 */
export function resolveIdentity(actor, tokenDoc = null) {
  let species = resolveSpecies(actor, tokenDoc);

  // What the players actually see. The token's own name wins over the base
  // actor's, because that is the thing on screen in front of them.
  const name = clean(tokenDoc?.name) || clean(actor?.name) || "the creature";

  let flavorName = "";
  try {
    flavorName = clean(actor?.getFlag?.(MODULE_ID, "flavorName"))
              || clean(tokenDoc?.delta?._source?.flags?.[MODULE_ID]?.flavorName);
  } catch (_) { /* nameplate flag unreadable — ignore, never fatal */ }

  let isNamed = hasPersonalName(name, species);

  // ── A STATBLOCK LABEL DESCRIBES BETTER THAN A BROAD TYPE ────────────────
  // An Archmage has no subtype, so species resolves to "humanoid" and the
  // creature would narrate as "the humanoid" — which is worse than the label
  // it already carries. When the name IS a label and the species is only a
  // broad category, the label wins: "the archmage", "the bandit captain".
  if (!isNamed && BROAD_TYPES.has(species)) {
    const bare = bareName(name);
    if (bare && bare !== species) species = bare;
  }

  // First name only, for natural narration: "Lilith hesitates", not
  // "Lilith Vex hesitates" every single line.
  const shortName = isNamed ? (name.split(/\s+/)[0] || name) : name;

  // "Lilith Vex, a cambion" / "a cambion" when unnamed.
  const article = /^[aeiou]/i.test(species) ? "an" : "a";
  const descriptor = species
    ? (isNamed ? `${name}, ${article} ${species}` : `${article} ${species}`)
    : name;

  // How the creature should refer to itself in *third-person narration*.
  const selfReference = isNamed
    ? shortName
    : (species ? `the ${species}` : name);

  return { name, species, isNamed, flavorName, shortName, descriptor, selfReference };
}

/**
 * The IDENTITY block for a system prompt. Kept here, next to the resolver, so
 * the wording and the data can never drift apart.
 */
export function buildIdentityPrompt(actor, tokenDoc = null) {
  const id = resolveIdentity(actor, tokenDoc);
  const lines = [];

  if (id.isNamed && id.species) {
    lines.push(`You are ${id.name}, ${/^[aeiou]/i.test(id.species) ? "an" : "a"} ${id.species}.`);
    lines.push(`YOUR NAME: ${id.name}. This is your actual name — you know it, you answer to it, and you may introduce yourself with it ("I am ${id.name}") when it makes sense to.`);
    lines.push(`YOUR SPECIES: ${id.species}. This is WHAT you are, not WHO you are. Never use it in place of your name.`);
    lines.push(`IN NARRATION (the *asterisk* parts), refer to yourself as "${id.shortName}" — for example *${id.shortName} hesitates.* You may occasionally write "${id.shortName} the ${id.species}" for flavour, but NEVER "the ${id.species}" alone, as though you had no name.`);
  } else if (id.species) {
    lines.push(`You are ${/^[aeiou]/i.test(id.species) ? "an" : "a"} ${id.species}.`);
    lines.push(`YOU HAVE NO PERSONAL NAME. "${id.name}" is a label, not a name.`);
    lines.push(`IN NARRATION (the *asterisk* parts), refer to yourself as "the ${id.species}" — for example *the ${id.species} hesitates.*`);
    // The bio is generated the moment someone first speaks to a nameless
    // creature (see ConversationApp._ensureIdentity), so by the time this
    // prompt is built there is usually a name sitting in BIOGRAPHY above.
    // Point at it explicitly — otherwise the model treats the statblock label
    // as the name, which is how an "Archmage" ended up saying "I am Archmage".
    lines.push(`⚠️ YOUR REAL NAME IS IN YOUR BIOGRAPHY ABOVE. "${id.name}" is a statblock label — a kind of creature, not a person — so NEVER introduce yourself as "${id.name}". If the biography names you, THAT is your name: answer to it, and offer it when the conversation earns it. If your biography gives you no name, invent one that suits your kind the first time you are asked, and use it from then on.`);
  } else {
    lines.push(`You are ${id.name}.`);
    lines.push(`IN NARRATION (the *asterisk* parts), refer to yourself as "${id.selfReference}".`);
  }

  if (id.flavorName && id.flavorName !== id.name) {
    lines.push(`WHAT STRANGERS SEE: onlookers who do not know you read you as "${id.flavorName}". Only use your real name with those who have earned it, or when you choose to reveal it.`);
  }

  return lines.join("\n");
}
