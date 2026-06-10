// ─── ACE: Engine — Faction Propagation (Living World, Step 2) ────────────────
// When the party does something that involves a faction (e.g. kills one of its
// members), the news travels the CONNECTION WEB — the victim faction itself, its
// kin (same creature family), and its explicit allies/enemies — and shifts each
// faction's STANDING toward the party. Standing then drives how a freshly dropped
// token of that faction ARRIVES on the canvas (its disposition).
//
// This is the vertical slice of the propagation engine: connection-web + standing
// + disposition-on-drop. Distance/time reach and the six knowledge-states (truth /
// established / rumor / distorted / legend / unaware) come in a later pass.

import { getFaction, findMatchingFactions, getAllFactions } from "./npc/faction-registry.mjs";

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Propagation";

// Standing ladder, best → worst. Index math drives the shifts.
const STANDING_LADDER = ["revered", "friendly", "neutral", "suspicious", "hostile", "hated"];
const NEUTRAL_INDEX = STANDING_LADDER.indexOf("neutral"); // 2

function _api() { return game.modules.get(MODULE_ID)?.api ?? null; }

/** Read a boolean setting, defaulting to true if it isn't registered yet. */
function _enabled(key) {
  try { return game.settings.get(MODULE_ID, key) !== false; }
  catch (_) { return true; }
}

/** How many ladder steps a kill of this magnitude moves things. */
function _magnitudeToSteps(magnitude) {
  switch (magnitude) {
    case "legendary":   return 3;
    case "continental": return 2;
    case "national":    return 2;
    case "regional":    return 1;
    case "local":       return 1;
    default:            return 0;   // trivial — does not ripple
  }
}

function _clampIdx(i) { return Math.max(0, Math.min(STANDING_LADDER.length - 1, i)); }

/**
 * Shift one faction's standing toward the party by `delta` steps.
 * Positive = worse (toward hated); negative = better (toward revered).
 */
async function _shiftStanding(factionId, delta, worldId) {
  if (!factionId || !delta) return;
  const api = _api();
  if (!api?.getFactionStanding || !api?.setFactionStanding) return;
  const current = api.getFactionStanding(factionId) || "neutral";
  const idx  = STANDING_LADDER.indexOf(current);
  const base = idx === -1 ? NEUTRAL_INDEX : idx;
  const next = _clampIdx(base + delta);
  if (next === base) return;
  await api.setFactionStanding(factionId, STANDING_LADDER[next], worldId);
  const _nm = getFaction(factionId)?.name || factionId;
  console.log(`${TAG} | ${_nm}: ${STANDING_LADDER[base]} → ${STANDING_LADDER[next]} (Δ${delta > 0 ? "+" : ""}${delta})`);
}

/** Resolve an allies/enemies entry (id or name) to a registry faction id, or null. */
function _resolveToFactionId(entry) {
  if (!entry) return null;
  const raw = (typeof entry === "object" ? (entry.id ?? entry.name) : entry);
  if (!raw) return null;
  if (getFaction(raw)) return raw;                       // direct id hit
  const norm = String(raw).toLowerCase().replace(/^(the|a|an)\s+/, "").trim();
  for (const [id, f] of Object.entries(getAllFactions() ?? {})) {
    const fn = String(f.name || "").toLowerCase().replace(/^(the|a|an)\s+/, "").trim();
    if (fn && fn === norm) return id;
  }
  return null;
}

/**
 * Propagate a combat event (a PC slew a member of `factionId`) through the
 * connection web, shifting standings. GM-only, gated by factionPropagation.
 * @param {{factionId:string, magnitude:string}} evt
 */
export async function propagateCombatEvent({ factionId, magnitude } = {}) {
  try {
    if (!game.user?.isGM) return;
    if (!_enabled("factionPropagation")) return;
    const victim = getFaction(factionId);
    if (!victim) return;
    const steps = _magnitudeToSteps(magnitude);
    if (steps <= 0) return;                       // trivial doesn't ripple
    const worldId = game.world?.id;

    const worsen  = new Map();   // factionId -> steps (toward hated)
    const improve = new Map();   // factionId -> steps (toward revered)

    // 1. The victim's own faction — their kin was slain.
    worsen.set(factionId, steps);

    // 2. Kin — same creature family ("word among their kind").
    if (victim.creatureBase) {
      for (const kin of findMatchingFactions(victim.creatureBase, victim.worldTag)) {
        if (kin.id && kin.id !== factionId && !worsen.has(kin.id)) {
          worsen.set(kin.id, Math.max(1, steps - 1));
        }
      }
    }

    // 3. Explicit allies — heard their ally was attacked.
    for (const a of (Array.isArray(victim.allies) ? victim.allies : [])) {
      const id = _resolveToFactionId(a);
      if (id && id !== factionId && !worsen.has(id)) worsen.set(id, Math.max(1, steps - 1));
    }

    // 4. Explicit enemies — the party hurt their enemy, so warmer toward the party.
    for (const e of (Array.isArray(victim.enemies) ? victim.enemies : [])) {
      const id = _resolveToFactionId(e);
      if (id && !worsen.has(id)) improve.set(id, Math.max(1, steps - 1));
    }

    for (const [fid, s] of worsen)  await _shiftStanding(fid, +s, worldId);
    for (const [fid, s] of improve) await _shiftStanding(fid, -s, worldId);

    console.log(`${TAG} | propagated [${magnitude}] kill of "${victim.name}" → ${worsen.size} worsened, ${improve.size} improved.`);
  } catch (err) {
    console.warn(`${TAG} | propagateCombatEvent failed (non-fatal):`, err);
  }
}

// ─── Disposition on token drop ────────────────────────────────────────────────

/** Map a standing to a Foundry token disposition, or null to leave the default. */
function _standingToDisposition(standing) {
  const D = CONST.TOKEN_DISPOSITIONS;
  switch (standing) {
    case "revered":
    case "friendly": return D.FRIENDLY;   // 1
    case "hostile":
    case "hated":    return D.HOSTILE;     // -1
    default:         return null;          // neutral / suspicious → leave token default
  }
}

/**
 * When a token is assigned to a faction, pre-set its canvas disposition from the
 * faction's current standing toward the party — so a faction the party angered
 * arrives hostile, and one they're revered by arrives friendly. Only overrides at
 * the extremes; leaves neutral/suspicious factions at the token's default.
 * GM-only, gated by factionDispositionOnDrop.
 * @param {TokenDocument} tokenDoc
 * @param {string} factionId
 */
export async function applyFactionDispositionToToken(tokenDoc, factionId) {
  try {
    if (!game.user?.isGM || !tokenDoc || !factionId) return;
    if (!_enabled("factionDispositionOnDrop")) return;
    const standing = _api()?.getFactionStanding?.(factionId) ?? "neutral";
    const disp = _standingToDisposition(standing);
    if (disp === null) return;
    if (tokenDoc.disposition === disp) return;
    await tokenDoc.update({ disposition: disp });
    console.log(`${TAG} | ${tokenDoc.name}: disposition → ${disp} (faction standing: ${standing}).`);
  } catch (err) {
    console.warn(`${TAG} | applyFactionDispositionToToken failed (non-fatal):`, err);
  }
}
