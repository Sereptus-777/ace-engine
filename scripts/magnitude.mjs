// ─── ACE: Engine — World-Event Magnitude ─────────────────────────────────────
// The ONE canonical magnitude scale for the Living World system, plus the
// DETERMINISTIC scorer that rates an event purely from game data. No AI decides
// magnitude — these are transparent, tunable rules. A common rank-and-file
// creature is HARD-FLOORED at "trivial" and can never be inflated into a big
// event.
//
// Scale (low → high):
//   trivial      — logged in the journal, but does NOT ripple outward
//   local        — the scene & immediate surroundings
//   regional     — the surrounding region, neighbouring settlements
//   national     — a whole kingdom / realm
//   continental  — several realms; "three or four states would know"
//   legendary    — the whole world, even other planes (Strahd-and-Vecna tier)
//
// "trivial" is the FLOOR: anything below "local" is recorded for the party's own
// history but is not significant enough to propagate to other factions.

export const MAGNITUDE = Object.freeze({
  TRIVIAL:     "trivial",
  LOCAL:       "local",
  REGIONAL:    "regional",
  NATIONAL:    "national",
  CONTINENTAL: "continental",
  LEGENDARY:   "legendary",
});

// Order from lowest to highest. Index used for ranking / comparison / bumping.
export const MAGNITUDE_ORDER = Object.freeze([
  MAGNITUDE.TRIVIAL,
  MAGNITUDE.LOCAL,
  MAGNITUDE.REGIONAL,
  MAGNITUDE.NATIONAL,
  MAGNITUDE.CONTINENTAL,
  MAGNITUDE.LEGENDARY,
]);

// At or above this tier, an event propagates to other factions. Below it
// (i.e. "trivial") the event is journaled but does not ripple.
export const RIPPLE_FLOOR = MAGNITUDE.LOCAL;

// Human-readable labels for UI.
export const MAGNITUDE_LABELS = Object.freeze({
  trivial:     "Trivial",
  local:       "Local",
  regional:    "Regional",
  national:    "National",
  continental: "Continental",
  legendary:   "Legendary",
});

// ─── Tunable thresholds ──────────────────────────────────────────────────────
// All kill-significance rules live here so they can be adjusted in one place.
// Ratios are challenge-rating ÷ average party level.
const KILL_CR = Object.freeze({
  GRUNT_FLOOR:  0.5,   // below this (and not named/leader) → trivial
  LOCAL_MIN:    0.5,   // ≥ this → at least local
  REGIONAL_MIN: 1.0,   // ≥ party level → regional
  NATIONAL_MIN: 2.0,   // ≥ 2× party level → national
  CONTINENTAL_MIN: 3.0,// ≥ 3× party level → continental
});

// Notoriety levels considered "widespread" — a famous party's deeds carry
// one tier further than they otherwise would.
const HIGH_NOTORIETY = new Set(["continental", "legendary"]);

// ─── Normalisation (legacy → canonical) ──────────────────────────────────────
// Folds the two older scales onto the canonical one so migrated data lines up:
//   old Fame:       trivial / local / regional / major / legendary  (major→continental)
//   old Reputation: local / regional / continental / legendary
const LEGACY_MAGNITUDE = Object.freeze({
  trivial:     MAGNITUDE.TRIVIAL,
  local:       MAGNITUDE.LOCAL,
  regional:    MAGNITUDE.REGIONAL,
  national:    MAGNITUDE.NATIONAL,
  major:       MAGNITUDE.CONTINENTAL,   // old Fame "major"
  continental: MAGNITUDE.CONTINENTAL,   // old Reputation impact
  legendary:   MAGNITUDE.LEGENDARY,
  unknown:     MAGNITUDE.TRIVIAL,       // old notoriety "unknown"
});

/**
 * Map any legacy magnitude/impact string onto the canonical scale.
 * @param {string} value
 * @returns {string} a canonical MAGNITUDE value (defaults to LOCAL if unknown)
 */
export function normalizeMagnitude(value) {
  if (!value) return MAGNITUDE.LOCAL;
  const key = String(value).toLowerCase().trim();
  return LEGACY_MAGNITUDE[key] ?? (MAGNITUDE_ORDER.includes(key) ? key : MAGNITUDE.LOCAL);
}

// ─── Rank / compare helpers ───────────────────────────────────────────────────

/** Numeric rank of a magnitude (0 = trivial … 5 = legendary). -1 if unknown. */
export function magnitudeRank(m) {
  return MAGNITUDE_ORDER.indexOf(normalizeMagnitude(m));
}

/** Return the higher of two magnitudes. */
export function higherMagnitude(a, b) {
  return magnitudeRank(a) >= magnitudeRank(b) ? normalizeMagnitude(a) : normalizeMagnitude(b);
}

/** True if this magnitude is significant enough to propagate to other factions. */
export function meetsRippleFloor(m) {
  return magnitudeRank(m) >= magnitudeRank(RIPPLE_FLOOR);
}

/**
 * Raise a magnitude by N tiers, capped at legendary. Never lowers, and never
 * promotes "trivial" (a bump only applies to events already ≥ local — callers
 * gate on that, but we hard-guard here too).
 * @param {string} m
 * @param {number} steps
 * @returns {string}
 */
export function bumpMagnitude(m, steps = 1) {
  const canonical = normalizeMagnitude(m);
  if (canonical === MAGNITUDE.TRIVIAL) return canonical;
  const idx = MAGNITUDE_ORDER.indexOf(canonical);
  const next = Math.min(idx + Math.max(0, steps), MAGNITUDE_ORDER.length - 1);
  return MAGNITUDE_ORDER[next];
}

function _isHighNotoriety(notoriety) {
  return HIGH_NOTORIETY.has(String(notoriety || "").toLowerCase().trim());
}

// ─── Deterministic scorers (NO AI) ────────────────────────────────────────────

/**
 * Rate the magnitude of a kill purely from game data.
 *
 * Guarantees: a creature that is NOT named, NOT a faction leader, and below the
 * grunt CR floor is ALWAYS "trivial" — a lone Red Fang goblin can never be
 * inflated into a regional/continental event.
 *
 * @param {object} o
 * @param {number}  [o.victimCR]          — challenge rating of the slain creature
 * @param {boolean} [o.isNamed]           — a named/unique NPC (not "Goblin 3")
 * @param {boolean} [o.isFactionLeader]   — leads its faction (chieftain, warlord…)
 * @param {number}  [o.partyAvgLevel]     — average party level (defaults to 1)
 * @param {string}  [o.locationFame]      — canonical magnitude of the location's fame, or null
 * @param {string}  [o.partyNotoriety]    — party notoriety level (unknown…legendary)
 * @param {boolean} [o.isCampaignVillain] — GM-flagged central villain → legendary
 * @returns {string} canonical MAGNITUDE
 */
export function scoreKillMagnitude(o = {}) {
  const cr         = Number(o.victimCR);
  const partyLevel = Number(o.partyAvgLevel) > 0 ? Number(o.partyAvgLevel) : 1;
  const named      = !!o.isNamed;
  const leader     = !!o.isFactionLeader;
  const crKnown    = !isNaN(cr) && cr > 0;
  const ratio      = crKnown ? cr / partyLevel : 0;

  // 1. GM-flagged campaign villain → top tier, full stop.
  if (o.isCampaignVillain) return MAGNITUDE.LEGENDARY;

  // 2. HARD FLOOR — common rank-and-file. Not named, not a leader, weak.
  if (!named && !leader && (!crKnown || ratio < KILL_CR.GRUNT_FLOOR)) {
    return MAGNITUDE.TRIVIAL;
  }

  // 3. Base tier from role (named/leader provide a floor)…
  let base = MAGNITUDE.LOCAL;
  if (leader)      base = MAGNITUDE.REGIONAL;   // a faction leader's death matters
  else if (named)  base = MAGNITUDE.LOCAL;      // a named NPC

  // …and from raw combat significance (CR vs party). Take the higher of the two.
  if (crKnown) {
    let crTier = MAGNITUDE.TRIVIAL;
    if      (ratio >= KILL_CR.CONTINENTAL_MIN) crTier = MAGNITUDE.CONTINENTAL;
    else if (ratio >= KILL_CR.NATIONAL_MIN)    crTier = MAGNITUDE.NATIONAL;
    else if (ratio >= KILL_CR.REGIONAL_MIN)    crTier = MAGNITUDE.REGIONAL;
    else if (ratio >= KILL_CR.LOCAL_MIN)       crTier = MAGNITUDE.LOCAL;
    base = higherMagnitude(base, crTier);
  }

  // 4. Bumps (only for events already ≥ local), each capped at legendary.
  let tier = base;
  if (o.locationFame && meetsRippleFloor(tier)) tier = bumpMagnitude(tier, 1);
  if (_isHighNotoriety(o.partyNotoriety) && meetsRippleFloor(tier)) tier = bumpMagnitude(tier, 1);

  return tier;
}

/**
 * Rate the magnitude of acquiring an item from its rarity.
 * @param {string} rarity — dnd5e rarity key
 * @returns {string} canonical MAGNITUDE
 */
export function scoreItemMagnitude(rarity) {
  switch (String(rarity || "").toLowerCase()) {
    case "artifact":  return MAGNITUDE.LEGENDARY;
    case "legendary": return MAGNITUDE.CONTINENTAL;
    case "veryrare":  return MAGNITUDE.REGIONAL;
    case "rare":      return MAGNITUDE.LOCAL;
    default:          return MAGNITUDE.TRIVIAL;   // common / uncommon → not world news
  }
}

/**
 * Rate the magnitude of a PC level change. A level-up is a personal milestone,
 * not world news — so it is trivial except for the big bracket milestones, which
 * are local at most. (Recorded for the party's own history; rarely ripples.)
 * @param {number} newLevel
 * @returns {string} canonical MAGNITUDE
 */
export function scoreLevelMagnitude(newLevel) {
  const milestones = new Set([5, 10, 15, 20]);
  return milestones.has(Number(newLevel)) ? MAGNITUDE.LOCAL : MAGNITUDE.TRIVIAL;
}
