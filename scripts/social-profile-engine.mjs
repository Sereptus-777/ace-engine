// ============================================================
// Social Profile Engine — NPC Societal Structure Generator
// Weighted-random social profiles per creature type.
// No API calls — rule-based generation, AI uses as constraints.
// ============================================================

const MODULE_ID = "ace-engine";

// ── Enums ───────────────────────────────────────────────────
const HIERARCHY = ["sovereign", "inner_circle", "authority", "skilled", "common", "low"];
const LOYALTY_TYPES = ["person", "god", "ideal", "place", "group", "self"];
const DISPOSITIONS = ["loyal", "conflicted", "ambitious", "broken", "fanatical", "pragmatic"];
const STANDINGS = ["respected", "tolerated", "ignored", "despised", "new"];
const WEALTH_TIERS = ["destitute", "poor", "modest", "comfortable", "wealthy", "rich"];
const PHYSICAL_STATES = ["healthy", "scarred", "injured", "disabled", "diseased", "aged"];
const COMPETENCE_LEVELS = ["brilliant", "capable", "average", "mediocre", "incompetent"];

// ── Creature-Category Name Patterns ─────────────────────────
const CREATURE_NAME_PATTERNS = {
  tribal:   /\b(goblin|orc|gnoll|kobold|lizardfolk|hobgoblin|bugbear|troglodyte|bullywug|grung|sahuagin|kuo-toa)\b/i,
  criminal: /\b(bandit|thug|pirate|assassin|spy|smuggler|brigand|cutthroat|highwayman|rogue)\b/i,
  cult:     /\b(cultist|acolyte|fanatic|zealot|warlock|witch)\b/i,
  undead:   /\b(zombie|skeleton|ghoul|wight|wraith|specter|mummy|lich|vampire|revenant|ghost|banshee)\b/i,
  beast:    /\b(wolf|bear|rat|spider|snake|boar|hawk|owl|bat|cat|dog|lion|tiger|ape|horse|deer|elk|panther|crocodile|scorpion|hyena)\b/i,
  fiend:    /\b(devil|demon|imp|quasit|succubus|incubus|pit fiend|balor|hezrou|vrock|cambion|yugoloth|mezzoloth|nycaloth|ultroloth)\b/i,
  celestial:/\b(angel|deva|planetar|solar|couatl|pegasus|unicorn|ki-rin|empyrean)\b/i,
};

const CIVILIZED_NAMES = /\b(guard|soldier|knight|noble|merchant|priest|cleric|mage|wizard|sorcerer|bard|innkeeper|bartender|barmaid|commoner|villager|farmer|blacksmith|shopkeeper|scholar|sage|captain|veteran|acolyte|monk|paladin|ranger|druid|artificer)\b/i;

// ── D&D 5e creature type values ─────────────────────────────
const TYPE_TO_CATEGORY = {
  beast:        "beast",
  monstrosity:  "beast",
  ooze:         "beast",
  plant:        "beast",
  construct:    "beast",
  undead:       "undead",
  fiend:        "fiend",
  celestial:    "celestial",
  giant:        "tribal",
  dragon:       "civilized",
  fey:          "civilized",
  elemental:    "tribal",
  aberration:   "tribal",
};

// ── Weighted Probability Tables ─────────────────────────────
// Format: { value: relativeWeight }  (higher = more likely)
const PROFILE_WEIGHTS = {

  // ─── HIERARCHY ────────────────────────────────────────────
  hierarchy: {
    civilized: { sovereign: 1, inner_circle: 3, authority: 8, skilled: 20, common: 50, low: 18 },
    tribal:    { sovereign: 2, inner_circle: 5, authority: 10, skilled: 15, common: 45, low: 23 },
    criminal:  { sovereign: 1, inner_circle: 4, authority: 8, skilled: 22, common: 42, low: 23 },
    cult:      { sovereign: 1, inner_circle: 5, authority: 10, skilled: 15, common: 50, low: 19 },
    undead:    { sovereign: 1, inner_circle: 2, authority: 5, skilled: 10, common: 60, low: 22 },
    beast:     { sovereign: 2, inner_circle: 3, authority: 5, skilled: 10, common: 55, low: 25 },
    fiend:     { sovereign: 2, inner_circle: 5, authority: 12, skilled: 18, common: 43, low: 20 },
    celestial: { sovereign: 2, inner_circle: 5, authority: 12, skilled: 18, common: 43, low: 20 },
  },

  // ─── LOYALTY TYPE ─────────────────────────────────────────
  loyalty: {
    civilized: { person: 15, god: 10, ideal: 15, place: 15, group: 30, self: 15 },
    tribal:    { person: 25, god: 15, ideal: 5,  place: 15, group: 30, self: 10 },
    criminal:  { person: 15, god: 2,  ideal: 5,  place: 5,  group: 25, self: 48 },
    cult:      { person: 10, god: 40, ideal: 20, place: 2,  group: 20, self: 8 },
    undead:    { person: 50, god: 5,  ideal: 5,  place: 5,  group: 10, self: 25 },
    beast:     { person: 5,  god: 0,  ideal: 0,  place: 40, group: 45, self: 10 },
    fiend:     { person: 20, god: 5,  ideal: 10, place: 5,  group: 25, self: 35 },
    celestial: { person: 5,  god: 35, ideal: 35, place: 5,  group: 15, self: 5 },
  },

  // ─── DISPOSITION ──────────────────────────────────────────
  disposition: {
    civilized: { loyal: 25, conflicted: 15, ambitious: 15, broken: 10, fanatical: 5,  pragmatic: 30 },
    tribal:    { loyal: 30, conflicted: 10, ambitious: 15, broken: 10, fanatical: 15, pragmatic: 20 },
    criminal:  { loyal: 10, conflicted: 10, ambitious: 25, broken: 10, fanatical: 5,  pragmatic: 40 },
    cult:      { loyal: 15, conflicted: 10, ambitious: 10, broken: 10, fanatical: 40, pragmatic: 15 },
    undead:    { loyal: 30, conflicted: 5,  ambitious: 10, broken: 25, fanatical: 15, pragmatic: 15 },
    beast:     { loyal: 35, conflicted: 5,  ambitious: 10, broken: 10, fanatical: 5,  pragmatic: 35 },
    fiend:     { loyal: 10, conflicted: 5,  ambitious: 30, broken: 5,  fanatical: 15, pragmatic: 35 },
    celestial: { loyal: 40, conflicted: 10, ambitious: 5,  broken: 5,  fanatical: 20, pragmatic: 20 },
  },

  // ─── SOCIAL STANDING ──────────────────────────────────────
  standing: {
    civilized: { respected: 15, tolerated: 30, ignored: 25, despised: 10, new: 20 },
    tribal:    { respected: 15, tolerated: 25, ignored: 25, despised: 15, new: 20 },
    criminal:  { respected: 10, tolerated: 25, ignored: 20, despised: 20, new: 25 },
    cult:      { respected: 15, tolerated: 30, ignored: 20, despised: 10, new: 25 },
    undead:    { respected: 5,  tolerated: 15, ignored: 40, despised: 30, new: 10 },
    beast:     { respected: 10, tolerated: 25, ignored: 40, despised: 15, new: 10 },
    fiend:     { respected: 15, tolerated: 25, ignored: 20, despised: 20, new: 20 },
    celestial: { respected: 30, tolerated: 30, ignored: 15, despised: 5,  new: 20 },
  },

  // ─── WEALTH TIER ──────────────────────────────────────────
  wealth: {
    civilized: { destitute: 5,  poor: 20, modest: 35, comfortable: 25, wealthy: 12, rich: 3 },
    tribal:    { destitute: 15, poor: 35, modest: 25, comfortable: 15, wealthy: 8,  rich: 2 },
    criminal:  { destitute: 10, poor: 20, modest: 25, comfortable: 20, wealthy: 18, rich: 7 },
    cult:      { destitute: 15, poor: 30, modest: 30, comfortable: 15, wealthy: 8,  rich: 2 },
    undead:    { destitute: 40, poor: 25, modest: 15, comfortable: 10, wealthy: 7,  rich: 3 },
    beast:     { destitute: 60, poor: 25, modest: 10, comfortable: 4,  wealthy: 1,  rich: 0 },
    fiend:     { destitute: 10, poor: 15, modest: 20, comfortable: 20, wealthy: 20, rich: 15 },
    celestial: { destitute: 5,  poor: 10, modest: 20, comfortable: 30, wealthy: 25, rich: 10 },
  },

  // ─── PHYSICAL STATE ───────────────────────────────────────
  physical: {
    civilized: { healthy: 45, scarred: 15, injured: 10, disabled: 8,  diseased: 7,  aged: 15 },
    tribal:    { healthy: 35, scarred: 25, injured: 12, disabled: 8,  diseased: 8,  aged: 12 },
    criminal:  { healthy: 35, scarred: 25, injured: 15, disabled: 5,  diseased: 5,  aged: 15 },
    cult:      { healthy: 40, scarred: 15, injured: 10, disabled: 5,  diseased: 10, aged: 20 },
    undead:    { healthy: 10, scarred: 25, injured: 20, disabled: 15, diseased: 20, aged: 10 },
    beast:     { healthy: 50, scarred: 20, injured: 12, disabled: 5,  diseased: 8,  aged: 5 },
    fiend:     { healthy: 50, scarred: 20, injured: 10, disabled: 5,  diseased: 5,  aged: 10 },
    celestial: { healthy: 60, scarred: 10, injured: 5,  disabled: 3,  diseased: 2,  aged: 20 },
  },

  // ─── COMPETENCE ───────────────────────────────────────────
  competence: {
    civilized: { brilliant: 8,  capable: 25, average: 40, mediocre: 18, incompetent: 9 },
    tribal:    { brilliant: 5,  capable: 20, average: 35, mediocre: 25, incompetent: 15 },
    criminal:  { brilliant: 10, capable: 30, average: 30, mediocre: 20, incompetent: 10 },
    cult:      { brilliant: 8,  capable: 22, average: 35, mediocre: 22, incompetent: 13 },
    undead:    { brilliant: 3,  capable: 15, average: 35, mediocre: 30, incompetent: 17 },
    beast:     { brilliant: 5,  capable: 20, average: 40, mediocre: 25, incompetent: 10 },
    fiend:     { brilliant: 15, capable: 30, average: 30, mediocre: 18, incompetent: 7 },
    celestial: { brilliant: 15, capable: 35, average: 30, mediocre: 15, incompetent: 5 },
  },
};

// ── Secret Tables (per category) ────────────────────────────
const SECRET_POOLS = {
  civilized: [
    "secretly in crushing debt to a dangerous creditor",
    "has a forbidden love affair across faction lines",
    "is an informant for a rival faction",
    "murdered someone in their past and hid the body",
    "is addicted to a dangerous substance",
    "lives under a false identity — their real name is unknown",
    "is planning to betray their current leader",
    "stole something valuable and hid it somewhere nearby",
    "has a bastard child they've never acknowledged",
    "witnessed a crime by someone powerful and stays silent out of fear",
    "is slowly being blackmailed by an unknown party",
    "practices forbidden magic in secret",
  ],
  tribal: [
    "plotting to challenge the chief for leadership",
    "stole sacred relics from the tribe's shrine",
    "cursed by an enemy shaman — hiding the symptoms",
    "secretly worships a different god than the tribe",
    "traded tribal secrets to outsiders for personal gain",
    "is the illegitimate offspring of the previous chief",
    "has been meeting with humans in secret",
    "knows the location of an ancient treasure but keeps it hidden",
    "killed a tribesman and blamed it on outsiders",
    "is slowly poisoning the current chief",
  ],
  criminal: [
    "is an undercover agent for the local authorities",
    "planning a double-cross on the next big job",
    "has a bounty from their own gang for a past betrayal",
    "secretly wants to go straight and leave the life behind",
    "has been skimming from the group's take for months",
    "is protecting a family member the gang doesn't know about",
    "murdered a fellow gang member and made it look like an accident",
    "is working for a rival gang as a mole",
    "stole a powerful item during a heist and told no one",
    "knows who the real boss is — and it's not who everyone thinks",
  ],
  cult: [
    "doubts the faith but is too afraid to leave",
    "planted by local authorities to gather evidence",
    "secretly worships a rival deity",
    "was forced into the cult and looks for escape",
    "knows the leader is a fraud but stays for power",
    "has visions from a different entity entirely",
    "killed another cultist who discovered their doubt",
    "hides a holy symbol of the cult's enemy god",
  ],
  undead: [
    "retains fragments of their living memories and grieves",
    "was raised against their will and seeks to break free",
    "bound by a phylactery they desperately want destroyed",
    "secretly serves a different master than the one who raised them",
    "remembers who killed them and wants revenge",
    "is slowly regaining sentience and hides it from their creator",
  ],
  beast: [
    "was once a humanoid, polymorphed or cursed into this form",
    "guards a hidden den with treasure from fallen adventurers",
    "has a symbiotic bond with a nearby druid or hermit",
    "territorial over an area that contains something valuable",
    "is the last of its kind in this region",
  ],
  fiend: [
    "secretly serves a rival archdevil or demon lord",
    "is bound by a contract they are desperate to escape",
    "has developed a forbidden attachment to a mortal",
    "possesses knowledge that could topple their infernal superior",
    "is plotting to ascend beyond their current rank through deception",
    "once made a deal that they actually regret",
    "hides a vulnerability that could destroy them",
  ],
  celestial: [
    "has doubts about the righteousness of their divine mandate",
    "once showed mercy to a fiend and conceals this transgression",
    "carries a burden of guilt over a mortal they failed to save",
    "secretly questions the wisdom of their deity",
    "has fallen in love with a mortal and hides it from the hierarchy",
  ],
};

// Secret chance per category (0-1)
const SECRET_CHANCE = {
  civilized: 0.15,
  tribal:    0.15,
  criminal:  0.25,
  cult:      0.20,
  undead:    0.12,
  beast:     0.08,
  fiend:     0.18,
  celestial: 0.10,
};

// ── Loyalty Target Templates ────────────────────────────────
const LOYALTY_TARGETS = {
  person: {
    civilized: ["the local lord", "their mentor", "a childhood friend in power", "their patron", "a beloved relative", "the guild master"],
    tribal:    ["the chief", "the shaman", "the war-leader", "the eldest hunter", "a blood-brother"],
    criminal:  ["the boss", "their fence", "a corrupt official", "a childhood partner-in-crime", "the gang leader"],
    cult:      ["the high priest", "the prophet", "the cult founder's memory", "a divine emissary"],
    undead:    ["their creator", "the necromancer", "the lich who raised them", "a vampire lord"],
    beast:     ["the alpha", "the pack leader", "a bonded companion"],
    fiend:     ["an archdevil", "a demon lord", "their summoner", "a rival fiend they fear"],
    celestial: ["a solar", "their divine patron", "a mortal they've sworn to protect"],
  },
  god: {
    civilized: ["a local deity", "one of the major gods", "an obscure patron saint", "a nature spirit"],
    tribal:    ["the tribe's patron god", "an ancestral spirit", "a beast-totem deity", "the storm god"],
    criminal:  ["a trickster god", "a god of shadows", "luck itself"],
    cult:      ["the cult's dark patron", "an elder god", "a forbidden deity", "the void between stars"],
    undead:    ["a death god", "Orcus", "Vecna's memory", "the shadow that speaks"],
    beast:     [],
    fiend:     ["Asmodeus", "a demon prince", "Tiamat", "an infernal court"],
    celestial: ["their deity", "the celestial hierarchy", "the concept of divine law"],
  },
  ideal: {
    civilized: ["justice", "freedom", "knowledge", "tradition", "order", "compassion", "ambition", "beauty"],
    tribal:    ["strength", "honor in battle", "survival of the tribe", "revenge", "the old ways"],
    criminal:  ["freedom", "wealth", "revenge", "anarchy", "personal power"],
    cult:      ["transcendence", "the coming apocalypse", "forbidden knowledge", "eternal life"],
    undead:    ["freedom from undeath", "vengeance", "oblivion", "eternal servitude"],
    beast:     ["territory", "survival"],
    fiend:     ["power", "domination", "corruption", "the infernal hierarchy", "chaos"],
    celestial: ["justice", "mercy", "order", "redemption", "the greater good"],
  },
  place: {
    civilized: ["this city", "their homeland", "the family estate", "a sacred grove", "the old quarter"],
    tribal:    ["the ancestral hunting grounds", "the sacred cave", "this mountain", "the river territory"],
    criminal:  ["this district", "the hideout", "the docks", "the underground market"],
    cult:      ["the temple", "the ritual site", "the forbidden sanctum"],
    undead:    ["their tomb", "the place where they died", "the haunted manor"],
    beast:     ["this forest", "the den", "the hunting grounds", "the nesting site"],
    fiend:     ["their infernal domain", "a corrupted mortal city", "the gate between planes"],
    celestial: ["a holy site", "a celestial realm", "a place of great suffering they guard"],
  },
  group: {
    civilized: ["their guild", "the family", "the merchant consortium", "the church", "the city watch"],
    tribal:    ["the tribe", "the war-band", "the hunting pack", "the clan"],
    criminal:  ["the gang", "the syndicate", "the crew", "the thieves' guild"],
    cult:      ["the cult", "the inner circle", "the brotherhood", "the sisterhood of shadow"],
    undead:    ["the undead horde", "the vampire court", "the coven"],
    beast:     ["the pack", "the herd", "the colony", "the swarm"],
    fiend:     ["the infernal legion", "the demonic horde", "the dark court"],
    celestial: ["the angelic host", "the celestial order", "the divine council"],
  },
  self: {
    civilized: ["themselves — a pragmatic survivor", "themselves — driven by personal ambition", "themselves — trusts no one"],
    tribal:    ["themselves — an exile or loner", "themselves — too cunning for the tribe", "themselves — abandoned by the group"],
    criminal:  ["themselves — in it for the coin", "themselves — trusts only their own blade", "themselves — a lone wolf"],
    cult:      ["themselves — using the cult for personal gain", "themselves — already planning their exit"],
    undead:    ["themselves — clinging to the remnants of free will", "themselves — all they have left"],
    beast:     ["themselves — a solitary predator", "themselves — driven from the pack"],
    fiend:     ["themselves — scheming for promotion", "themselves — every fiend for themselves"],
    celestial: ["themselves — questioning their purpose", "themselves — fallen from grace"],
  },
};

// ── Hierarchy labels for prompt context ─────────────────────
const HIERARCHY_LABELS = {
  sovereign:    "Sovereign — the ultimate authority (king, chief, alpha, hive queen)",
  inner_circle: "Inner Circle — a trusted confidant or lieutenant of leadership",
  authority:    "Authority — holds real power (captain, shaman, guild master)",
  skilled:      "Skilled — competent and valued (warrior, hunter, craftsman, scout)",
  common:       "Common — ordinary member (laborer, foot soldier, tribe member)",
  low:          "Low — bottom of the hierarchy (servant, outcast, the runt)",
};

const DISPOSITION_LABELS = {
  loyal:      "Loyal — devoted, would die for the cause",
  conflicted: "Conflicted — torn between duty and doubts",
  ambitious:  "Ambitious — scheming to rise, plotting advancement",
  broken:     "Broken — traumatized, despairing, just surviving",
  fanatical:  "Fanatical — true believer, no compromise",
  pragmatic:  "Pragmatic — follows practical advantage, switches sides when it makes sense",
};

const STANDING_LABELS = {
  respected: "Respected — admired, feared, or listened to by peers",
  tolerated: "Tolerated — useful but not particularly liked",
  ignored:   "Ignored — beneath notice, invisible",
  despised:  "Despised — outcast, shunned, marked",
  new:       "New — outsider, refugee, recently arrived",
};

const WEALTH_LABELS = {
  destitute:   "Destitute — never held a real coin, fights over scraps",
  poor:        "Poor — a few coppers, a silver is a windfall",
  modest:      "Modest — some silver, seen gold but doesn't have it",
  comfortable: "Comfortable — handles gold regularly, can afford things",
  wealthy:     "Wealthy — gold is common, owns property, has influence",
  rich:        "Rich — platinum, gems, land, servants",
};

// ── Role Override Patterns ──────────────────────────────────
const SOVEREIGN_ROLES = /\b(king|queen|chief|chieftain|lord|lady|emperor|empress|sovereign|alpha|patriarch|matriarch|elder\s*dragon|hive\s*queen|warlord|overlord|high\s*priest(ess)?)\b/i;
const AUTHORITY_ROLES = /\b(captain|commander|lieutenant|shaman|guild\s*master|sergeant|general|marshal|advisor|champion|priest(ess)?|elder)\b/i;
const LOW_ROLES = /\b(grunt|minion|thrall|slave|servant|lackey|peon|runt|drudge|scullion)\b/i;

// ════════════════════════════════════════════════════════════
//  SocialProfileEngine — static-method class
// ════════════════════════════════════════════════════════════
export class SocialProfileEngine {

  // ── Resolve creature category from actor data ─────────────
  static resolveCreatureCategory(actor) {
    if (!actor) return "civilized";

    const name = actor.name ?? "";
    const creatureType = actor.system?.details?.type?.value?.toLowerCase() ?? "";
    const creatureSubtype = actor.system?.details?.type?.subtype?.toLowerCase() ?? "";
    const intScore = actor.system?.abilities?.int?.value ?? 10;

    // 1. Name-pattern matching (most specific)
    for (const [category, pattern] of Object.entries(CREATURE_NAME_PATTERNS)) {
      if (pattern.test(name) || pattern.test(creatureSubtype)) {
        // Intelligent undead get civilized profiles
        if (category === "undead" && intScore >= 10) return "civilized";
        return category;
      }
    }

    // 2. Civilized name patterns (guard, merchant, etc.)
    if (CIVILIZED_NAMES.test(name)) return "civilized";

    // 3. D&D 5e creature type field
    if (creatureType && TYPE_TO_CATEGORY[creatureType]) {
      const cat = TYPE_TO_CATEGORY[creatureType];
      if (cat === "undead" && intScore >= 10) return "civilized";
      return cat;
    }

    // 4. Humanoid default
    if (creatureType === "humanoid") return "civilized";

    // 5. Fallback
    return "civilized";
  }

  // ── Generate a full social profile ────────────────────────
  static generate(actor, options = {}) {
    const category = this.resolveCreatureCategory(actor);
    const cr = options.cr ?? actor.system?.details?.cr ?? 1;
    const factionRole = options.factionRole ?? "";
    const factionName = options.factionName ?? "";

    // For beasts/low-INT creatures: minimal profile
    const isMinimal = (category === "beast") ||
      (category === "undead" && (actor.system?.abilities?.int?.value ?? 10) < 6);

    const profile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      creatureCategory: category,
      hierarchy:   this._pickHierarchy(category, cr, factionRole),
      loyalty:     this._pickLoyalty(category, factionName),
      disposition: this._weightedPick(PROFILE_WEIGHTS.disposition[category] ?? PROFILE_WEIGHTS.disposition.civilized, DISPOSITIONS),
      standing:    this._weightedPick(PROFILE_WEIGHTS.standing[category] ?? PROFILE_WEIGHTS.standing.civilized, STANDINGS),
      wealth:      this._pickWealth(category, cr),
      circumstances: {
        physical:   this._weightedPick(PROFILE_WEIGHTS.physical[category] ?? PROFILE_WEIGHTS.physical.civilized, PHYSICAL_STATES),
        competence: this._weightedPick(PROFILE_WEIGHTS.competence[category] ?? PROFILE_WEIGHTS.competence.civilized, COMPETENCE_LEVELS),
        secret:     this._rollSecret(category),
      },
    };

    // Minimal profiles strip unnecessary dimensions
    if (isMinimal) {
      profile.loyalty = { type: "group", target: "the pack" };
      profile.standing = "ignored";
      profile.wealth = "destitute";
      profile.disposition = "pragmatic";
      profile.circumstances.secret = "";
    }

    // Hierarchy-wealth correlation: sovereigns tend wealthier, low tend poorer
    profile.wealth = this._adjustWealthForHierarchy(profile.wealth, profile.hierarchy);

    // Standing-hierarchy correlation: sovereigns tend respected, low tend ignored/despised
    profile.standing = this._adjustStandingForHierarchy(profile.standing, profile.hierarchy);

    return profile;
  }

  // ── Pick hierarchy with CR adjustment + role override ─────
  static _pickHierarchy(category, cr, factionRole) {
    const baseWeights = { ...(PROFILE_WEIGHTS.hierarchy[category] ?? PROFILE_WEIGHTS.hierarchy.civilized) };

    // CR adjustment
    if (cr >= 17) {
      baseWeights.sovereign = (baseWeights.sovereign ?? 1) * 10;
      baseWeights.inner_circle = (baseWeights.inner_circle ?? 3) * 5;
      baseWeights.authority = (baseWeights.authority ?? 8) * 3;
    } else if (cr >= 10) {
      baseWeights.sovereign = (baseWeights.sovereign ?? 1) * 3;
      baseWeights.inner_circle = (baseWeights.inner_circle ?? 3) * 3;
      baseWeights.authority = (baseWeights.authority ?? 8) * 2;
    } else if (cr >= 5) {
      baseWeights.authority = (baseWeights.authority ?? 8) * 2;
      baseWeights.skilled = Math.round((baseWeights.skilled ?? 20) * 1.5);
    } else if (cr < 1) {
      baseWeights.sovereign = 0;
      baseWeights.inner_circle = 0;
      baseWeights.common = (baseWeights.common ?? 50) * 2;
      baseWeights.low = (baseWeights.low ?? 18) * 2;
    }

    // Role override
    if (factionRole) {
      if (SOVEREIGN_ROLES.test(factionRole)) return "sovereign";
      if (AUTHORITY_ROLES.test(factionRole)) return "authority";
      if (LOW_ROLES.test(factionRole)) return "low";
    }

    return this._weightedPick(baseWeights, HIERARCHY);
  }

  // ── Pick loyalty with target ──────────────────────────────
  static _pickLoyalty(category, factionName) {
    const loyaltyWeights = PROFILE_WEIGHTS.loyalty[category] ?? PROFILE_WEIGHTS.loyalty.civilized;
    const type = this._weightedPick(loyaltyWeights, LOYALTY_TYPES);

    // Pick a target from templates
    const targets = LOYALTY_TARGETS[type]?.[category] ?? LOYALTY_TARGETS[type]?.civilized ?? [];
    let target = targets.length ? targets[Math.floor(Math.random() * targets.length)] : "";

    // If loyalty is to a group and we have a faction name, use it
    if (type === "group" && factionName) {
      target = factionName;
    }

    return { type, target };
  }

  // ── Pick wealth with CR adjustment ────────────────────────
  static _pickWealth(category, cr) {
    const baseWeights = { ...(PROFILE_WEIGHTS.wealth[category] ?? PROFILE_WEIGHTS.wealth.civilized) };

    if (cr >= 10) {
      baseWeights.wealthy = (baseWeights.wealthy ?? 12) * 3;
      baseWeights.rich = (baseWeights.rich ?? 3) * 4;
    } else if (cr >= 5) {
      baseWeights.comfortable = (baseWeights.comfortable ?? 25) * 2;
      baseWeights.wealthy = (baseWeights.wealthy ?? 12) * 2;
    } else if (cr < 1) {
      baseWeights.destitute = (baseWeights.destitute ?? 5) * 3;
      baseWeights.poor = (baseWeights.poor ?? 20) * 2;
      baseWeights.rich = 0;
      baseWeights.wealthy = Math.round((baseWeights.wealthy ?? 12) * 0.3);
    }

    return this._weightedPick(baseWeights, WEALTH_TIERS);
  }

  // ── Adjust wealth to correlate with hierarchy ─────────────
  static _adjustWealthForHierarchy(wealth, hierarchy) {
    const wealthIndex = WEALTH_TIERS.indexOf(wealth);
    if (hierarchy === "sovereign" && wealthIndex < 3) {
      // Sovereigns are at least comfortable (50% chance to bump up)
      return Math.random() < 0.5 ? "comfortable" : WEALTH_TIERS[Math.min(wealthIndex + 2, 5)];
    }
    if (hierarchy === "low" && wealthIndex > 2) {
      // Low hierarchy rarely wealthy (75% chance to bump down)
      return Math.random() < 0.75 ? WEALTH_TIERS[Math.max(wealthIndex - 2, 0)] : wealth;
    }
    return wealth;
  }

  // ── Adjust standing to correlate with hierarchy ───────────
  static _adjustStandingForHierarchy(standing, hierarchy) {
    if (hierarchy === "sovereign" && (standing === "ignored" || standing === "despised")) {
      return Math.random() < 0.7 ? "respected" : "tolerated";
    }
    if (hierarchy === "low" && standing === "respected") {
      return Math.random() < 0.6 ? "tolerated" : "ignored";
    }
    return standing;
  }

  // ── Roll for a secret ─────────────────────────────────────
  static _rollSecret(category) {
    const chance = SECRET_CHANCE[category] ?? 0.15;
    if (Math.random() > chance) return "";

    const pool = SECRET_POOLS[category] ?? SECRET_POOLS.civilized;
    return pool[Math.floor(Math.random() * pool.length)] ?? "";
  }

  // ── Weighted random pick ──────────────────────────────────
  static _weightedPick(weights, validValues) {
    // Build array of [value, weight] pairs, only including valid values
    const entries = [];
    let total = 0;
    for (const val of validValues) {
      const w = weights[val] ?? 0;
      if (w > 0) {
        entries.push([val, w]);
        total += w;
      }
    }
    if (!entries.length) return validValues[0];

    let roll = Math.random() * total;
    for (const [val, w] of entries) {
      roll -= w;
      if (roll <= 0) return val;
    }
    return entries[entries.length - 1][0];
  }

  // ── Build AI prompt context from profile ──────────────────
  static buildPromptContext(profile) {
    if (!profile) return "";

    const cat = profile.creatureCategory;

    // Minimal profiles for beasts/mindless undead
    if (cat === "beast" || (cat === "undead" && profile.disposition === "pragmatic" && profile.standing === "ignored")) {
      return [
        "\nSOCIAL PROFILE — pack/colony role:",
        `- Hierarchy: ${HIERARCHY_LABELS[profile.hierarchy] ?? profile.hierarchy}`,
        `- State: ${profile.circumstances?.physical ?? "healthy"}, ${profile.circumstances?.competence ?? "average"} for its kind`,
        "",
      ].join("\n");
    }

    const lines = [
      "\nSOCIAL PROFILE — use these constraints to shape this NPC's personality and behavior:",
      `- Power: ${HIERARCHY_LABELS[profile.hierarchy] ?? profile.hierarchy}`,
      `- Loyalty: ${_loyaltyLabel(profile.loyalty)}`,
      `- Disposition: ${DISPOSITION_LABELS[profile.disposition] ?? profile.disposition}`,
      `- Social Standing: ${STANDING_LABELS[profile.standing] ?? profile.standing}`,
      `- Physical State: ${profile.circumstances?.physical ?? "healthy"}, ${profile.circumstances?.competence ?? "average"} at what they do`,
      `- Wealth: ${WEALTH_LABELS[profile.wealth] ?? profile.wealth} (relative to their creature type — a goblin chief's "wealthy" is a human merchant's "modest")`,
    ];

    if (profile.circumstances?.secret) {
      lines.push(`- SECRET (weave subtle hints into bio, DO NOT state outright): ${profile.circumstances.secret}`);
    }

    lines.push("");
    lines.push("Write the biography consistent with these social constraints. A \"respected\" NPC should have earned that respect. A \"broken\" disposition means visible trauma. Wealth should show in possessions and bearing. Hierarchy determines how they relate to others in their group.");
    lines.push("");

    return lines.join("\n");
  }

  // ── Build HTML display for panel UI ───────────────────────
  static buildDisplayHtml(profile) {
    if (!profile) return "";

    const row = (label, value) => `<div class="ace-sp-row"><span class="ace-sp-label">${label}</span><span class="ace-sp-value">${_escapeHtml(value)}</span></div>`;

    const cat = profile.creatureCategory;
    const catLabel = cat.charAt(0).toUpperCase() + cat.slice(1);

    let html = `<div class="ace-sp-grid">`;
    html += row("Category", catLabel);
    html += row("Power", _capitalize(profile.hierarchy?.replace("_", " ")));
    html += row("Loyalty", _loyaltyShort(profile.loyalty));
    html += row("Disposition", _capitalize(profile.disposition));
    html += row("Standing", _capitalize(profile.standing));
    html += row("Wealth", _capitalize(profile.wealth));
    html += row("Physical", _capitalize(profile.circumstances?.physical ?? "healthy"));
    html += row("Competence", _capitalize(profile.circumstances?.competence ?? "average"));

    if (profile.circumstances?.secret) {
      html += `<div class="ace-sp-row"><span class="ace-sp-label">Secret</span><span class="ace-sp-value ace-sp-secret">${_escapeHtml(profile.circumstances.secret)}</span></div>`;
    }

    html += `</div>`;
    return html;
  }

  // ── Storage helpers ───────────────────────────────────────
  static async store(actor, profile) {
    if (!actor || !profile) return;
    await actor.setFlag(MODULE_ID, "socialProfile", profile);
  }

  static retrieve(actor) {
    if (!actor) return null;
    return actor.getFlag(MODULE_ID, "socialProfile") ?? null;
  }

  static async clear(actor) {
    if (!actor) return;
    try { await actor.unsetFlag(MODULE_ID, "socialProfile"); } catch { /* flag may not exist */ }
  }
}

// ── Utility helpers ─────────────────────────────────────────
function _capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function _escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function _loyaltyLabel(loyalty) {
  if (!loyalty) return "Unknown";
  const typeLabel = _capitalize(loyalty.type);
  if (loyalty.target) return `${typeLabel} — "${loyalty.target}"`;
  return typeLabel;
}

function _loyaltyShort(loyalty) {
  if (!loyalty) return "Unknown";
  const typeLabel = _capitalize(loyalty.type);
  if (loyalty.target) {
    const short = loyalty.target.length > 35 ? loyalty.target.slice(0, 32) + "..." : loyalty.target;
    return `${typeLabel}: ${short}`;
  }
  return typeLabel;
}
