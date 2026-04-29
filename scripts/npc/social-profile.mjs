// ============================================================
// Social Profile Engine — NPC Societal Structure Generator
// Weighted-random social profiles per creature type.
// No API calls — rule-based generation, AI uses as constraints.
//
// Moved from ace-envoy/src/ai/social-profile.js as part of the
// Envoy → Engine merger. MODULE_ID switched ace-envoy → ace-engine
// (propagates through actor flag namespace for socialProfile data).
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
//  LAYER 2: INNER LIFE POOLS — desire, fear, bond, moral line,
//           knowledge hook, need
// ════════════════════════════════════════════════════════════

const DESIRE_POOLS = {
  civilized: [
    "save enough to open their own shop",
    "protect their family from the dangers outside",
    "find someone who truly understands them",
    "escape this place and start over somewhere new",
    "learn the truth about their parents' past",
    "earn a title or position of respect",
    "find and punish the one who wronged them",
    "atone for a terrible mistake they made years ago",
    "see their children grow up safe",
    "master a craft or skill that earns recognition",
  ],
  tribal: [
    "prove their strength by defeating a great beast",
    "protect the young ones of the tribe",
    "earn the respect of the warriors",
    "erase a dishonor that haunts their name",
    "find new hunting grounds where the tribe can thrive",
    "have songs sung about their deeds around the fire",
    "escape the tribe and see what lies beyond the forest",
    "challenge the chief and lead the tribe themselves",
    "avenge a fallen packmate",
    "find a mate worthy of their bloodline",
  ],
  criminal: [
    "pull off one last score big enough to disappear",
    "rise to run their own crew",
    "go straight and leave the criminal life behind",
    "find and kill the one who betrayed them",
    "keep their family safe from their own associates",
    "experience the thrill of the next impossible heist",
    "buy their way into legitimate society",
    "control the local black market entirely",
  ],
  cult: [
    "ascend to the inner circle of the faith",
    "witness the prophecy fulfilled in their lifetime",
    "find proof that the faith is real, not delusion",
    "convert someone powerful to the cause",
    "escape the cult without being hunted",
    "become the vessel for their deity's power",
    "destroy the enemies of the faith",
    "understand the visions that haunt their dreams",
  ],
  undead: [
    "break free from the curse that binds them",
    "find peace and true death",
    "remember who they were in life",
    "destroy the one who raised them",
    "protect the place where they died",
    "complete the task they left unfinished in life",
  ],
  beast: [
    "find a safe den for their young",
    "defend their territory from intruders",
    "find enough food to survive the season",
    "rejoin the pack they were driven from",
  ],
  fiend: [
    "ascend to a higher rank in the infernal hierarchy",
    "break free from a binding contract",
    "corrupt a powerful mortal to serve their ends",
    "establish a domain outside their master's control",
    "collect enough souls to buy their freedom",
    "find a mortal weakness they can exploit for centuries",
    "overthrow their immediate superior",
  ],
  celestial: [
    "redeem a fallen soul they were charged to protect",
    "understand why mortals choose evil when good is possible",
    "complete a divine mandate that has lasted centuries",
    "find a mortal worthy of their deity's blessing",
    "prevent a catastrophe their visions have foretold",
    "reconcile their duty with the mercy they feel",
  ],
};

const FEAR_POOLS = {
  civilized: [
    "losing their family to violence or disease",
    "poverty — ending up on the street with nothing",
    "someone discovering their darkest secret",
    "dying alone and forgotten",
    "the specific threat that haunts this region",
    "failing the people who depend on them",
    "being abandoned by everyone they love",
    "the supernatural — things that shouldn't exist",
    "growing old without having mattered",
    "being forced to become what they despise",
  ],
  tribal: [
    "exile from the tribe — cast out, alone, nameless",
    "the predator or monster that killed their kin",
    "dying a coward's death, without honor",
    "the tribe starving because the hunt failed",
    "being captured and enslaved",
    "the shaman's curses and dark magic",
    "losing their place in the hierarchy to a rival",
    "the thing that lurks in the deepest part of the forest",
  ],
  criminal: [
    "prison — the walls closing in, the key thrown away",
    "betrayal from within their own crew",
    "being recognized by someone from their past",
    "the law finally catching up with them",
    "the boss discovering their skimming",
    "losing the one person they actually care about",
    "becoming exactly like the people they rob",
    "dying in a gutter with nothing to show for it",
  ],
  cult: [
    "the faith being proven false — everything was for nothing",
    "the wrath of their deity for insufficient devotion",
    "being exposed as a doubter to the other faithful",
    "the ritual going wrong and consuming them",
    "discovery by the authorities",
    "that the visions are madness, not divine truth",
  ],
  undead: [
    "true destruction — the final end with no return",
    "remembering the full horror of how they died",
    "sunlight and the burning it brings",
    "holy symbols and the pain of divine rejection",
    "being controlled again after tasting freedom",
    "forgetting the last fragments of who they were",
  ],
  beast: [
    "fire — the primal terror",
    "the predator that hunts even them",
    "starvation — the slow weakening",
    "losing their territory to a stronger rival",
  ],
  fiend: [
    "demotion in the infernal hierarchy — a fate worse than death",
    "being bound by a mortal's magic",
    "their true name being discovered",
    "a rival discovering their secret weakness",
    "eternal imprisonment in a sealed vessel",
    "the one being in existence that can truly destroy them",
  ],
  celestial: [
    "falling from grace — losing their divine connection",
    "failing a mortal they swore to protect",
    "corruption slowly taking root in their own heart",
    "their deity's silence — the prayers going unanswered",
    "becoming indifferent to mortal suffering after millennia",
  ],
};

const BOND_POOLS = {
  civilized: [
    "their daughter, who is everything to them",
    "their aging mother, who lives alone",
    "their brother, who went to war and never came back",
    "a romantic partner who makes life bearable",
    "an old mentor who taught them their trade",
    "the family homestead — the only stable thing in their life",
    "their father's sword — the last piece of him they have",
    "a debt they owe to someone who saved their life",
    "the memory of a child they lost",
    "a stray animal they rescued and now can't live without",
    "a childhood friend they haven't seen in years",
    "their reputation — the one thing nobody can take from them",
  ],
  tribal: [
    "their litter-brother, the only one who truly knows them",
    "the chief who saved their life when they were young",
    "their father's weapon — taken from his cold hands",
    "the tribe itself — blood is everything",
    "a rival who pushes them to be stronger",
    "the sacred cave where the ancestors sleep",
    "a trophy from their greatest kill",
    "the shaman who saw potential in them when no one else did",
  ],
  criminal: [
    "a childhood partner-in-crime — the only one they trust",
    "a sibling they're protecting from the life",
    "the score that got away — it haunts them",
    "a fence who's more friend than business partner",
    "a hideout that's the closest thing they have to home",
    "a locket with a portrait of someone they left behind",
    "the knife that's saved their life more times than they can count",
  ],
  cult: [
    "the high priest who showed them the truth",
    "a fellow cultist who shares their private doubts",
    "the sacred text that changed their life",
    "the shrine they built with their own hands",
    "a vision they received that they can never forget",
    "the memory of the life they had before the faith",
  ],
  undead: [
    "a locket or ring from their living days",
    "the place where they died — they cannot leave it",
    "a living descendant they watch over from the shadows",
    "the last words someone said to them before they died",
    "a fellow undead who shares their curse",
  ],
  beast: [
    "their cubs, who depend on them completely",
    "the den — their safe place in a dangerous world",
    "the alpha who leads the pack",
    "their territory — they'll die before abandoning it",
  ],
  fiend: [
    "a mortal they've developed a forbidden attachment to",
    "an artifact that contains a fragment of their power",
    "a rival they've sparred with for millennia — it's almost friendship",
    "the memory of the first soul they ever corrupted",
    "a contract that binds them in ways they didn't expect",
  ],
  celestial: [
    "a mortal they were charged to protect centuries ago",
    "a fallen comrade they failed to save from corruption",
    "the memory of the mortal world when it was young and pure",
    "their divine weapon — an extension of their purpose",
    "a mortal prayer that moved them in ways they cannot explain",
  ],
};

const MORAL_LINE_POOLS = {
  civilized: [
    "will never harm a child, no matter the circumstances",
    "will never betray their family, even to save themselves",
    "will never steal from someone who has less than they do",
    "will never break a sworn oath",
    "will never kill an unarmed person",
    "will never abandon a companion in danger",
    "will never use poison — it's a coward's weapon",
    "will never lie to someone who trusts them",
    "has no moral line — will do whatever survival demands",
  ],
  tribal: [
    "will never abandon the tribe, even if the chief is wrong",
    "will never kill a pregnant creature of any kind",
    "will never attack during a declared truce",
    "will never defile the burial grounds of any people",
    "will never use magic they don't understand",
    "will never defy the spirits or the shaman's word",
    "will never eat the flesh of their own kind",
    "has no moral line — survival of the tribe justifies everything",
  ],
  criminal: [
    "will never hurt children — that's where the line is",
    "will never rat on the crew, not even under torture",
    "will never steal from someone who has nothing",
    "will never kill for free — it's business, not pleasure",
    "will never work for the law, even as an informant",
    "will never betray someone who showed them genuine kindness",
    "has no moral line — coin is coin, a job is a job",
  ],
  cult: [
    "will never harm a fellow believer, even a heretic",
    "will never reveal the inner mysteries to an outsider",
    "will never deny the faith, even facing death",
    "will never sacrifice a child — some lines even gods don't cross",
    "will never betray the high priest who saved their soul",
    "has no moral line — the faith demands absolute obedience",
  ],
  undead: [
    "will never harm the living descendants of their bloodline",
    "will never enter the home they lived in — that life is over",
    "will never serve the one who killed them, even in undeath",
    "will never forget who they were, no matter how much it hurts",
    "has no moral line — undeath has stripped away all such concerns",
  ],
  beast: [
    "will never abandon their young",
    "will not attack something much larger unless cornered",
  ],
  fiend: [
    "will always honor the exact letter of a contract",
    "will never harm another fiend of higher rank without cause",
    "will never break a deal, even with a mortal",
    "will never show vulnerability to an inferior",
    "has no moral line — morality is a mortal delusion",
  ],
  celestial: [
    "will never strike first — always offers redemption",
    "will never abandon an innocent to save themselves",
    "will never use deception, even against evil",
    "will never kill a mortal who could still be redeemed",
    "will never disobey a direct divine command, even if it breaks their heart",
  ],
};

const KNOWLEDGE_HOOK_TEMPLATES = {
  civilized: [
    "knows a shortcut through the local area that avoids danger",
    "overheard a conversation about a plot against someone important",
    "knows where a hidden cache of supplies is stashed",
    "knows the patrol schedule of the local guards",
    "has seen something strange in the area recently — lights, sounds, movement",
    "knows a local merchant who deals in rare or illegal goods",
    "remembers a historical detail about a nearby ruin or landmark",
    "knows where someone important has been hiding",
  ],
  tribal: [
    "knows where a predator has its den in the nearby wilderness",
    "has seen tracks of something large and dangerous passing through",
    "knows a safe water source hidden from outsiders",
    "knows the territorial boundaries of nearby rival groups",
    "has found an entrance to underground tunnels or caves",
    "knows when the next enemy patrol or raid is expected",
    "has seen a dragon or other powerful creature flying overhead recently",
    "knows where the old burial grounds are — and why nobody goes there",
  ],
  criminal: [
    "knows the combination or key to a locked area",
    "has a map of the sewer system or underground passages",
    "knows which guard can be bribed and for how much",
    "overheard a heist being planned by a rival gang",
    "knows where stolen goods are being fenced",
    "has information about a bounty that nobody else has claimed",
    "knows who really controls the local criminal underworld",
  ],
  cult: [
    "knows the location of a hidden shrine or ritual site",
    "has read texts describing an ancient evil sealed nearby",
    "knows the real identity of a powerful figure in the community",
    "has witnessed a ritual that revealed something about the future",
    "knows where the cult stores its most dangerous artifacts",
    "overheard the leader's true plans, which differ from public doctrine",
  ],
  undead: [
    "remembers the location of treasure buried with them in life",
    "knows the weakness of the creature that controls this area",
    "has witnessed events from centuries ago that explain the present",
    "knows where other undead are congregating and why",
    "remembers a password or phrase that opens a sealed door",
  ],
  beast: [
    "territorial behavior reveals safe vs dangerous areas",
    "migration patterns indicate seasonal changes or approaching danger",
  ],
  fiend: [
    "knows the true name of a lesser fiend that could be bound",
    "has information about a weakness in the local power structure",
    "knows where a planar rift or portal exists nearby",
    "has knowledge of an ancient pact that affects this region",
    "knows what a powerful entity is secretly planning",
  ],
  celestial: [
    "knows the location of a sacred site that has been corrupted",
    "has prophetic knowledge of an approaching threat",
    "knows the true nature of a cursed artifact nearby",
    "remembers the original purpose of ruins that mortals have forgotten",
    "knows which mortal in the area is destined for something significant",
  ],
};

const NEED_POOLS = {
  civilized: [
    "medicine for a sick family member",
    "money to pay off a dangerous debt",
    "protection from someone who has been threatening them",
    "help finding a missing person they care about",
    "a message delivered to someone they can't reach",
    "an escort to the next settlement — the roads aren't safe",
    "justice from authorities who won't listen to someone like them",
    "materials or tools they can't obtain on their own",
    "nothing — self-sufficient and doesn't need outsiders",
  ],
  tribal: [
    "weapons or tools — their equipment is broken and worn",
    "food — the hunt has been bad and the young ones are thin",
    "medicine — the shaman's herbs aren't working anymore",
    "a dangerous creature dealt with that's been killing scouts",
    "information about where the humans built their new camp",
    "safe passage across territory guarded by something hostile",
    "an alliance against a common enemy threatening both peoples",
    "nothing — hostile to outsiders and wants nothing from them",
  ],
  criminal: [
    "a fence for goods too hot to sell through normal channels",
    "a place to lie low until the heat dies down",
    "someone with muscle to back them up on a job",
    "information about a mark's schedule or defenses",
    "a way out of the criminal life — papers, a new identity",
    "medical attention for a wound they can't explain to a healer",
    "nothing — suspicious of anyone offering help",
  ],
  cult: [
    "a rare component needed for an upcoming ritual",
    "new converts — the congregation is shrinking",
    "protection from authorities investigating the faith",
    "an artifact described in their sacred texts",
    "a place to worship in secret after being driven out",
    "nothing — the faith provides everything they need",
  ],
  undead: [
    "someone to break the curse that binds them",
    "a living person to carry out a task in the world of the living",
    "to be left alone — peace is all they want",
    "the destruction of the one who created them",
    "nothing — beyond mortal needs",
  ],
  beast: [
    "food — driven into this area by hunger",
    "their territory left alone",
  ],
  fiend: [
    "a mortal willing to enter a bargain",
    "information about a rival fiend's activities",
    "a specific rare material for an infernal ritual",
    "a loophole in a contract that binds them",
    "nothing from mortals — they take what they want",
  ],
  celestial: [
    "a mortal champion willing to fight for a holy cause",
    "information about a corruption spreading in the area",
    "protection for a sacred site while they attend to duties elsewhere",
    "a mortal perspective on a dilemma they cannot resolve alone",
    "nothing — they serve, they do not ask",
  ],
};

// ════════════════════════════════════════════════════════════
//  LAYER 3: VALUE SYSTEM — 14 values scored 0-10
//  Base weights per creature category, modified by alignment
//  and hierarchy. Random variance ±2 applied.
// ════════════════════════════════════════════════════════════

const VALUE_NAMES = [
  "order", "freedom", "mercy", "justice", "honor",
  "survival", "family", "faith", "knowledge", "power",
  "tradition", "community", "wealth", "glory",
];

// Base scores per creature category (before alignment/hierarchy/variance)
const VALUE_BASES = {
  //                ord  fre  mer  jus  hon  sur  fam  fai  kno  pow  tra  com  wea  glo
  civilized:      [ 5,   4,   5,   5,   5,   5,   6,   4,   4,   3,   5,   6,   4,   3 ],
  tribal:         [ 3,   4,   2,   2,   4,   7,   7,   3,   1,   4,   6,   5,   2,   5 ],
  criminal:       [ 1,   7,   2,   1,   2,   8,   4,   1,   2,   6,   1,   2,   7,   3 ],
  cult:           [ 5,   1,   2,   2,   3,   4,   2,   9,   3,   4,   4,   5,   1,   3 ],
  undead:         [ 2,   3,   1,   2,   2,   5,   3,   1,   3,   4,   4,   1,   2,   1 ],
  beast:          [ 1,   3,   1,   0,   0,  10,   6,   0,   0,   2,   1,   3,   0,   0 ],
  fiend:          [ 6,   3,   0,   1,   3,   5,   1,   2,   5,   8,   3,   0,   5,   5 ],
  celestial:      [ 7,   3,   8,   8,   8,   2,   4,   9,   5,   2,   5,   7,   1,   3 ],
};

// Alignment modifiers: [ord, fre, mer, jus, hon, sur, fam, fai, kno, pow, tra, com, wea, glo]
const ALIGNMENT_MODS = {
  "lawful good":     [ 2,  -1,  2,  2,  2,  -1,  1,  1,  0,  -1,  1,  2,  0,  0 ],
  "neutral good":    [ 0,   0,  2,  1,  1,   0,  1,  1,  1,  -1,  0,  2,  0,  0 ],
  "chaotic good":    [-1,   2,  2,  1,  0,   0,  1,  0,  1,  -1, -1,  1,  0,  1 ],
  "lawful neutral":  [ 2,  -1,  0,  1,  2,   1,  0,  1,  1,   1,  2,  0,  1,  0 ],
  "true neutral":    [ 0,   0,  0,  0,  0,   1,  1,  0,  1,   0,  0,  0,  0,  0 ],
  "neutral":         [ 0,   0,  0,  0,  0,   1,  1,  0,  1,   0,  0,  0,  0,  0 ],
  "chaotic neutral": [-1,   2,  0,  0, -1,   2,  0, -1,  0,   1, -1, -1,  1,  1 ],
  "lawful evil":     [ 2,  -1, -2,  0,  1,   1, -1,  0,  1,   2,  1, -2,  2,  1 ],
  "neutral evil":    [ 0,   0, -2, -1, -1,   2, -1, -1,  1,   2,  0, -2,  2,  0 ],
  "chaotic evil":    [-2,   2, -2, -2, -1,   2, -1, -1,  0,   2, -2, -2,  1,  2 ],
  "any alignment":   [ 0,   0,  0,  0,  0,   0,  0,  0,  0,   0,  0,  0,  0,  0 ],
  "unaligned":       [ 0,   0,  0,  0,  0,   2,  0,  0,  0,   0,  0,  0,  0,  0 ],
};

// Hierarchy modifiers
const HIERARCHY_VALUE_MODS = {
  sovereign:    [ 1,  0,  0,  0,  1,  0,  0,  0,  0,  2,  1,  0,  1,  2 ],
  inner_circle: [ 1,  0,  0,  0,  1,  0,  1,  0,  1,  1,  0,  0,  1,  1 ],
  authority:    [ 1,  0,  0,  1,  1,  0,  0,  0,  0,  1,  1,  1,  0,  0 ],
  skilled:      [ 0,  0,  0,  0,  1,  0,  0,  0,  1,  0,  0,  0,  0,  0 ],
  common:       [ 0,  0,  0,  0,  0,  1,  1,  0,  0,  0,  0,  1, -1,  0 ],
  low:          [ 0,  1,  0,  0, -1,  2,  1,  0,  0, -1,  0,  0, -1, -1 ],
};

// ════════════════════════════════════════════════════════════
//  LAYER 4: CONTEXT POOLS — origin, reputation, connections,
//           combat readiness, base attitude toward outsiders
// ════════════════════════════════════════════════════════════

const ORIGIN_POOLS = {
  civilized: [
    { value: "born_here",   weight: 35, label: "Born and raised here — knows everyone and everything" },
    { value: "refugee",     weight: 15, label: "Refugee — fled here from somewhere worse" },
    { value: "traveler",    weight: 15, label: "Traveler — passing through, has seen many places" },
    { value: "exile",       weight: 5,  label: "Exile — cast out from their homeland for a reason" },
    { value: "stationed",   weight: 20, label: "Stationed here — assigned by duty, not by choice" },
    { value: "immigrant",   weight: 10, label: "Immigrant — moved here seeking a better life" },
  ],
  tribal: [
    { value: "born_here",   weight: 50, label: "Born in this territory — knows no other life" },
    { value: "refugee",     weight: 10, label: "Refugee — their original tribe was destroyed" },
    { value: "exile",       weight: 10, label: "Exile — cast out from another tribe" },
    { value: "captured",    weight: 10, label: "Captured — taken as a child, raised by this tribe" },
    { value: "wanderer",    weight: 10, label: "Wanderer — drifted between groups before settling" },
    { value: "born_here",   weight: 10, label: "Born in the deep wild — far from civilization" },
  ],
  criminal: [
    { value: "local",       weight: 25, label: "Local — grew up on these streets" },
    { value: "refugee",     weight: 15, label: "Refugee from the law — hiding from another jurisdiction" },
    { value: "recruited",   weight: 25, label: "Recruited — pulled into the life by someone they trusted" },
    { value: "fallen",      weight: 15, label: "Fallen — once respectable, now desperate" },
    { value: "born_into",   weight: 20, label: "Born into it — criminal family, no other path" },
  ],
  cult:      [{ value: "converted",  weight: 40, label: "Converted — found the faith and never looked back" },
              { value: "born_into",   weight: 25, label: "Born into the faith — knows nothing else" },
              { value: "recruited",   weight: 20, label: "Recruited — manipulated during a vulnerable time" },
              { value: "seeker",      weight: 15, label: "Seeker — searched for meaning and found this" }],
  undead:    [{ value: "died_here",   weight: 40, label: "Died here — bound to the place of death" },
              { value: "raised",      weight: 30, label: "Raised — created by a necromancer's will" },
              { value: "cursed",      weight: 20, label: "Cursed — undeath was punishment, not choice" },
              { value: "ancient",     weight: 10, label: "Ancient — has existed for centuries beyond count" }],
  beast:     [{ value: "native",      weight: 60, label: "Native — this is their territory" },
              { value: "displaced",   weight: 25, label: "Displaced — driven here by a greater predator" },
              { value: "escaped",     weight: 15, label: "Escaped — broke free from captivity" }],
  fiend:     [{ value: "summoned",    weight: 30, label: "Summoned — called to the material plane by magic" },
              { value: "manifested",  weight: 25, label: "Manifested — tore through a planar rift" },
              { value: "exiled",      weight: 20, label: "Exiled — cast out from the lower planes" },
              { value: "stationed",   weight: 25, label: "Stationed — assigned here by infernal/abyssal command" }],
  celestial: [{ value: "dispatched",  weight: 40, label: "Dispatched — sent by divine will for a specific purpose" },
              { value: "guardian",     weight: 30, label: "Guardian — has watched over this place for ages" },
              { value: "fallen",      weight: 10, label: "Fallen — lost favor and wanders seeking redemption" },
              { value: "manifested",  weight: 20, label: "Manifested — drawn by a concentration of faith or need" }],
};

const REPUTATION_OPTIONS = [
  { value: "anonymous",       weight: 40, label: "Anonymous — nobody outside their immediate circle knows them" },
  { value: "locally_known",   weight: 30, label: "Locally known — recognized in the immediate area" },
  { value: "regionally_known",weight: 15, label: "Regionally known — name carries weight across the region" },
  { value: "famous",          weight: 10, label: "Famous — widely recognized, reputation precedes them" },
  { value: "legendary",       weight: 5,  label: "Legendary — the stuff of stories and songs" },
];

// CR adjusts reputation: higher CR = more likely to be known
const REPUTATION_CR_BOOST = {
  // cr_threshold: weight_multiplier for famous/legendary
  0:  { famous: 0.2, legendary: 0 },
  5:  { famous: 1,   legendary: 0.3 },
  10: { famous: 2,   legendary: 1 },
  17: { famous: 3,   legendary: 2 },
  21: { famous: 4,   legendary: 5 },
};

const CONNECTIONS_OPTIONS = {
  civilized: [
    { value: "isolated",        weight: 15, label: "Isolated — no meaningful relationships, a loner" },
    { value: "small_circle",    weight: 35, label: "Small circle — a few close relationships" },
    { value: "well_connected",  weight: 30, label: "Well-connected — knows many people, trades favors" },
    { value: "community_pillar",weight: 20, label: "Community pillar — killing them would have serious ripple effects" },
  ],
  tribal: [
    { value: "isolated",        weight: 20, label: "Isolated — an outcast even within the tribe" },
    { value: "small_circle",    weight: 35, label: "Small circle — a few trusted packmates" },
    { value: "well_connected",  weight: 30, label: "Well-connected — known across multiple tribal groups" },
    { value: "community_pillar",weight: 15, label: "Tribal pillar — their loss would destabilize the group" },
  ],
  criminal: [
    { value: "isolated",        weight: 25, label: "Isolated — trusts nobody, works alone" },
    { value: "small_circle",    weight: 35, label: "Small circle — a tight crew of 2-3 trusted partners" },
    { value: "well_connected",  weight: 30, label: "Well-connected — contacts across multiple criminal networks" },
    { value: "community_pillar",weight: 10, label: "Kingpin — removing them would create a power vacuum" },
  ],
  cult:      [{ value: "isolated", weight: 20 }, { value: "small_circle", weight: 35 }, { value: "well_connected", weight: 30 }, { value: "community_pillar", weight: 15 }],
  undead:    [{ value: "isolated", weight: 50 }, { value: "small_circle", weight: 25 }, { value: "well_connected", weight: 15 }, { value: "community_pillar", weight: 10 }],
  beast:     [{ value: "isolated", weight: 30 }, { value: "small_circle", weight: 50 }, { value: "well_connected", weight: 15 }, { value: "community_pillar", weight: 5 }],
  fiend:     [{ value: "isolated", weight: 25 }, { value: "small_circle", weight: 30 }, { value: "well_connected", weight: 30 }, { value: "community_pillar", weight: 15 }],
  celestial: [{ value: "isolated", weight: 20 }, { value: "small_circle", weight: 30 }, { value: "well_connected", weight: 30 }, { value: "community_pillar", weight: 20 }],
};

const COMBAT_READINESS_OPTIONS = [
  { value: "battle_hardened", weight: 10, label: "Battle-hardened — has survived many fights, scars to prove it" },
  { value: "trained",         weight: 20, label: "Trained — knows how to fight but hasn't seen much real combat" },
  { value: "capable",         weight: 25, label: "Capable — can handle themselves if pressed" },
  { value: "untested",        weight: 25, label: "Untested — has never been in a real fight" },
  { value: "pacifist",        weight: 10, label: "Pacifist — refuses violence, will flee or surrender" },
  { value: "coward",          weight: 10, label: "Coward — will flee at the first sign of danger" },
];

// CR adjusts combat readiness: higher CR = more battle-hardened
const COMBAT_CR_BOOST = {
  0:  { battle_hardened: 0.2, trained: 0.5 },
  5:  { battle_hardened: 2,   trained: 1.5 },
  10: { battle_hardened: 4,   trained: 2 },
  17: { battle_hardened: 8,   trained: 3 },
};

const ATTITUDE_POOLS = {
  civilized: [
    { value: "welcoming",     weight: 20, label: "Welcoming — open and friendly to strangers" },
    { value: "curious",       weight: 20, label: "Curious — interested in newcomers, asks questions" },
    { value: "suspicious",    weight: 25, label: "Suspicious — wary of outsiders, needs a reason to trust" },
    { value: "indifferent",   weight: 20, label: "Indifferent — doesn't care about strangers one way or another" },
    { value: "opportunistic", weight: 10, label: "Opportunistic — sees strangers as potential marks or tools" },
    { value: "hostile",       weight: 5,  label: "Hostile — actively dislikes outsiders" },
  ],
  tribal: [
    { value: "hostile",       weight: 30, label: "Hostile — outsiders are enemies by default" },
    { value: "suspicious",    weight: 30, label: "Suspicious — outsiders are watched and tested" },
    { value: "curious",       weight: 15, label: "Curious — fascinated by things from outside the tribe" },
    { value: "terrified",     weight: 15, label: "Terrified — outsiders bring death and change" },
    { value: "opportunistic", weight: 10, label: "Opportunistic — outsiders have things the tribe needs" },
  ],
  criminal: [
    { value: "suspicious",    weight: 35, label: "Suspicious — could be law, could be a rival" },
    { value: "opportunistic", weight: 30, label: "Opportunistic — everyone's a potential mark or partner" },
    { value: "hostile",       weight: 15, label: "Hostile — strangers are threats to the operation" },
    { value: "indifferent",   weight: 15, label: "Indifferent — not their problem" },
    { value: "curious",       weight: 5,  label: "Curious — new faces mean new opportunities" },
  ],
  cult:      [{ value: "welcoming", weight: 25 }, { value: "suspicious", weight: 30 }, { value: "hostile", weight: 15 }, { value: "curious", weight: 15 }, { value: "opportunistic", weight: 15 }],
  undead:    [{ value: "hostile", weight: 40 }, { value: "indifferent", weight: 30 }, { value: "curious", weight: 10 }, { value: "terrified", weight: 10 }, { value: "suspicious", weight: 10 }],
  beast:     [{ value: "hostile", weight: 30 }, { value: "terrified", weight: 30 }, { value: "indifferent", weight: 30 }, { value: "curious", weight: 10 }],
  fiend:     [{ value: "opportunistic", weight: 35 }, { value: "hostile", weight: 25 }, { value: "suspicious", weight: 20 }, { value: "curious", weight: 10 }, { value: "indifferent", weight: 10 }],
  celestial: [{ value: "welcoming", weight: 30 }, { value: "curious", weight: 25 }, { value: "suspicious", weight: 15 }, { value: "indifferent", weight: 15 }, { value: "opportunistic", weight: 5 }, { value: "hostile", weight: 10 }],
};

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

    // CR-competence correlation: high-CR creatures are never incompetent
    if (cr >= 21) {
      profile.circumstances.competence = "brilliant";
      profile.circumstances.physical = "healthy"; // demigods don't limp
    } else if (cr >= 15) {
      if (profile.circumstances.competence === "incompetent" || profile.circumstances.competence === "mediocre") {
        profile.circumstances.competence = "capable";
      }
      if (profile.circumstances.physical === "disabled") {
        profile.circumstances.physical = "scarred"; // powerful but marked by battle, not disabled
      }
    } else if (cr >= 10) {
      if (profile.circumstances.competence === "incompetent") {
        profile.circumstances.competence = "mediocre";
      }
    }

    // Hierarchy-wealth correlation: sovereigns tend wealthier, low tend poorer
    profile.wealth = this._adjustWealthForHierarchy(profile.wealth, profile.hierarchy);

    // Standing-hierarchy correlation: sovereigns tend respected, low tend ignored/despised
    profile.standing = this._adjustStandingForHierarchy(profile.standing, profile.hierarchy);

    // ── Layer 2: Inner Life ───────────────────────────────────
    const innerPools = isMinimal ? null : {
      desire:        DESIRE_POOLS[category] ?? DESIRE_POOLS.civilized,
      fear:          FEAR_POOLS[category] ?? FEAR_POOLS.civilized,
      bond:          BOND_POOLS[category] ?? BOND_POOLS.civilized,
      moralLine:     MORAL_LINE_POOLS[category] ?? MORAL_LINE_POOLS.civilized,
      knowledgeHook: KNOWLEDGE_HOOK_TEMPLATES[category] ?? KNOWLEDGE_HOOK_TEMPLATES.civilized,
      need:          NEED_POOLS[category] ?? NEED_POOLS.civilized,
    };

    if (innerPools) {
      profile.innerLife = {
        desire:        innerPools.desire[Math.floor(Math.random() * innerPools.desire.length)],
        fear:          innerPools.fear[Math.floor(Math.random() * innerPools.fear.length)],
        bond:          innerPools.bond[Math.floor(Math.random() * innerPools.bond.length)],
        moralLine:     innerPools.moralLine[Math.floor(Math.random() * innerPools.moralLine.length)],
        knowledgeHook: innerPools.knowledgeHook[Math.floor(Math.random() * innerPools.knowledgeHook.length)],
        need:          innerPools.need[Math.floor(Math.random() * innerPools.need.length)],
      };
    } else {
      profile.innerLife = {
        desire: "survive and protect their territory",
        fear: "a larger predator",
        bond: "their den or pack",
        moralLine: "will never abandon their young",
        knowledgeHook: "territorial behavior reveals safe vs dangerous areas",
        need: "to be left alone",
      };
    }

    // ── Layer 3: Value System (14 values, 0-10) ──────────────
    const alignment = (actor.system?.details?.alignment ?? "").toLowerCase().trim();
    profile.values = this._generateValues(category, alignment, profile.hierarchy);

    // ── Layer 4: Context ─────────────────────────────────────
    profile.context = isMinimal ? {
      origin: "native",
      reputation: "anonymous",
      connections: "small_circle",
      combatReadiness: "capable",
      baseAttitude: "hostile",
    } : {
      origin:          this._pickFromWeightedPool(ORIGIN_POOLS[category] ?? ORIGIN_POOLS.civilized),
      reputation:      this._pickReputation(cr),
      connections:     this._pickFromWeightedPool(
        (CONNECTIONS_OPTIONS[category] ?? CONNECTIONS_OPTIONS.civilized)
          .map(o => ({ value: o.value, weight: o.weight, label: o.label ?? o.value }))
      ),
      combatReadiness: this._pickCombatReadiness(cr),
      baseAttitude:    this._pickFromWeightedPool(ATTITUDE_POOLS[category] ?? ATTITUDE_POOLS.civilized),
    };

    return profile;
  }

  // ── Pick hierarchy with CR adjustment + role override ─────
  static _pickHierarchy(category, cr, factionRole) {
    const baseWeights = { ...(PROFILE_WEIGHTS.hierarchy[category] ?? PROFILE_WEIGHTS.hierarchy.civilized) };

    // CR adjustment — high-CR creatures should almost always land in top tiers
    if (cr >= 21) {
      // Deity-tier: sovereign or bust
      baseWeights.sovereign = (baseWeights.sovereign ?? 1) * 50;
      baseWeights.inner_circle = (baseWeights.inner_circle ?? 3) * 5;
      baseWeights.authority = 0;
      baseWeights.skilled = 0;
      baseWeights.common = 0;
      baseWeights.low = 0;
    } else if (cr >= 17) {
      baseWeights.sovereign = (baseWeights.sovereign ?? 1) * 20;
      baseWeights.inner_circle = (baseWeights.inner_circle ?? 3) * 10;
      baseWeights.authority = (baseWeights.authority ?? 8) * 5;
      baseWeights.skilled = Math.round((baseWeights.skilled ?? 20) * 0.3);
      baseWeights.common = Math.round((baseWeights.common ?? 50) * 0.1);
      baseWeights.low = 0;
    } else if (cr >= 10) {
      baseWeights.sovereign = (baseWeights.sovereign ?? 1) * 5;
      baseWeights.inner_circle = (baseWeights.inner_circle ?? 3) * 5;
      baseWeights.authority = (baseWeights.authority ?? 8) * 4;
      baseWeights.skilled = Math.round((baseWeights.skilled ?? 20) * 0.7);
      baseWeights.common = Math.round((baseWeights.common ?? 50) * 0.3);
      baseWeights.low = Math.round((baseWeights.low ?? 18) * 0.2);
    } else if (cr >= 5) {
      baseWeights.authority = (baseWeights.authority ?? 8) * 3;
      baseWeights.skilled = Math.round((baseWeights.skilled ?? 20) * 1.5);
      baseWeights.common = Math.round((baseWeights.common ?? 50) * 0.7);
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

  // ── Generate value scores (14 values, 0-10) ───────────────
  static _generateValues(category, alignment, hierarchy) {
    const bases = VALUE_BASES[category] ?? VALUE_BASES.civilized;
    const alignMods = ALIGNMENT_MODS[alignment] ?? ALIGNMENT_MODS["true neutral"] ?? new Array(14).fill(0);
    const hierMods = HIERARCHY_VALUE_MODS[hierarchy] ?? new Array(14).fill(0);

    const values = {};
    for (let i = 0; i < VALUE_NAMES.length; i++) {
      // Base + alignment modifier + hierarchy modifier + random variance ±2
      const variance = Math.floor(Math.random() * 5) - 2; // -2 to +2
      const raw = (bases[i] ?? 3) + (alignMods[i] ?? 0) + (hierMods[i] ?? 0) + variance;
      values[VALUE_NAMES[i]] = Math.max(0, Math.min(10, raw)); // clamp 0-10
    }
    return values;
  }

  // ── Pick from weighted pool of {value, weight, label?} objects ─
  static _pickFromWeightedPool(pool) {
    if (!pool?.length) return pool?.[0]?.value ?? "unknown";
    let total = 0;
    for (const item of pool) total += (item.weight ?? 1);
    let roll = Math.random() * total;
    for (const item of pool) {
      roll -= (item.weight ?? 1);
      if (roll <= 0) return item.value;
    }
    return pool[pool.length - 1].value;
  }

  // ── Pick reputation with CR boost ─────────────────────────
  static _pickReputation(cr) {
    const options = REPUTATION_OPTIONS.map(o => ({ ...o }));
    // Find the right CR bracket
    let boost = REPUTATION_CR_BOOST[0];
    for (const [threshold, b] of Object.entries(REPUTATION_CR_BOOST)) {
      if (cr >= Number(threshold)) boost = b;
    }
    for (const opt of options) {
      if (opt.value === "famous") opt.weight *= (boost.famous ?? 1);
      if (opt.value === "legendary") opt.weight *= (boost.legendary ?? 0);
    }
    return this._pickFromWeightedPool(options);
  }

  // ── Pick combat readiness with CR boost ───────────────────
  static _pickCombatReadiness(cr) {
    const options = COMBAT_READINESS_OPTIONS.map(o => ({ ...o }));
    let boost = COMBAT_CR_BOOST[0];
    for (const [threshold, b] of Object.entries(COMBAT_CR_BOOST)) {
      if (cr >= Number(threshold)) boost = b;
    }
    for (const opt of options) {
      if (opt.value === "battle_hardened") opt.weight *= (boost.battle_hardened ?? 1);
      if (opt.value === "trained") opt.weight *= (boost.trained ?? 1);
      // Reduce pacifist/coward chance for high CR
      if (cr >= 10 && (opt.value === "pacifist" || opt.value === "coward")) opt.weight *= 0.2;
    }
    return this._pickFromWeightedPool(options);
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

    // ── Inner Life ──────────────────────────────────────────
    if (profile.innerLife) {
      lines.push("");
      lines.push("INNER LIFE — what drives this NPC as a person:");
      lines.push(`- Desire: ${profile.innerLife.desire}`);
      lines.push(`- Fear: ${profile.innerLife.fear}`);
      lines.push(`- Bond: ${profile.innerLife.bond}`);
      lines.push(`- Moral Line: ${profile.innerLife.moralLine}`);
      lines.push(`- Knowledge (weave naturally, do NOT have NPC blurt this out): ${profile.innerLife.knowledgeHook}`);
      lines.push(`- Need: ${profile.innerLife.need}`);
    }

    // ── Value System ────────────────────────────────────────
    if (profile.values) {
      lines.push("");
      const vStr = VALUE_NAMES.map(v => `${_capitalize(v)} ${profile.values[v] ?? 0}`).join(", ");
      lines.push(`VALUES (0=irrelevant, 10=would die for it): ${vStr}`);
      // Highlight extremes for the AI
      const highs = VALUE_NAMES.filter(v => (profile.values[v] ?? 0) >= 8);
      const lows = VALUE_NAMES.filter(v => (profile.values[v] ?? 0) <= 1);
      if (highs.length) lines.push(`CORE VALUES (8+): ${highs.map(_capitalize).join(", ")} — these define who they are`);
      if (lows.length) lines.push(`IRRELEVANT VALUES (0-1): ${lows.map(_capitalize).join(", ")} — these mean nothing to them`);
    }

    // ── Context ─────────────────────────────────────────────
    if (profile.context) {
      lines.push("");
      lines.push("CONTEXT:");
      const originEntry = (ORIGIN_POOLS[cat] ?? ORIGIN_POOLS.civilized).find(o => o.value === profile.context.origin);
      lines.push(`- Origin: ${originEntry?.label ?? profile.context.origin}`);
      const repEntry = REPUTATION_OPTIONS.find(o => o.value === profile.context.reputation);
      lines.push(`- Reputation: ${repEntry?.label ?? profile.context.reputation}`);
      const conOpts = CONNECTIONS_OPTIONS[cat] ?? CONNECTIONS_OPTIONS.civilized;
      const conEntry = conOpts.find(o => o.value === profile.context.connections);
      lines.push(`- Social Connections: ${conEntry?.label ?? profile.context.connections}`);
      const combatEntry = COMBAT_READINESS_OPTIONS.find(o => o.value === profile.context.combatReadiness);
      lines.push(`- Combat Readiness: ${combatEntry?.label ?? profile.context.combatReadiness}`);
      const attPool = ATTITUDE_POOLS[cat] ?? ATTITUDE_POOLS.civilized;
      const attEntry = attPool.find(o => o.value === profile.context.baseAttitude);
      lines.push(`- Attitude Toward Outsiders: ${attEntry?.label ?? profile.context.baseAttitude}`);
    }

    lines.push("");
    // NOTE: Do NOT add procedural instructions here ("Write the biography..." etc.)
    // The system prompt in bio-generator.js handles that. Adding action language here
    // causes the AI to skip the NAME: prefix for generic NPCs.

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
