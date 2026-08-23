// ─── ACE Engine — a good deed changes how the world feels about you ─────────
//
// ⚠️ UNTIL NOW, REPUTATION ONLY RESPONDED TO VIOLENCE (2026-08-21).
//
// `propagateCombatEvent` is called from exactly ONE place in the codebase: a
// kill. Nothing else has ever touched faction standing. Johnny, reading that
// back: "isn't saving a princess or destroying Strahd moving my reputation
// upwards?" It should be, and it never has been. His world holds 187 recorded
// deeds and a reputation file whose deed list is empty; the ledger and the
// ladder are two systems that have never spoken to each other.
//
// So five months of rescues, bargains, mercy and diplomacy moved the needle
// exactly zero, because the only thing wired to it was a corpse.
//
// This mirrors the kill logic deliberately, so good and bad travel the same
// roads: the faction it was done for takes the full weight, their allies take
// half, their enemies take a quarter the other way. And it moves POINTS on the
// score in reputation-scale.mjs rather than whole rungs, which is what stops
// one legendary act carrying a faction from indifference to devotion.

import { pointsFor } from "./reputation-scale.mjs";
import { getAllFactions } from "./npc/faction-registry.mjs";

const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | Deeds";

const _api = () => game.modules.get(MODULE_ID)?.api ?? null;

/** Read a boolean setting, defaulting to on. */
function _enabled(key) {
  try { return game.settings.get(MODULE_ID, key) !== false; }
  catch (_) { return true; }
}

/** Resolve a faction reference (id, name, or object) to an id we hold. */
function _toFactionId(entry, all) {
  if (!entry) return null;
  const raw = typeof entry === "object" ? (entry.id ?? entry.name) : entry;
  if (!raw) return null;
  if (all[raw]) return raw;
  const norm = String(raw).toLowerCase().replace(/^(the|a|an)\s+/, "").trim();
  for (const [id, f] of Object.entries(all)) {
    const n = String(f?.name || "").toLowerCase().replace(/^(the|a|an)\s+/, "").trim();
    if (n && n === norm) return id;
  }
  return null;
}

/**
 * Push one deed through the faction web.
 *
 * @param {object} deed
 * @param {string} deed.text
 * @param {string} deed.magnitude   local | regional | continental | legendary
 * @param {string} deed.valence     heroic | villainous | neutral
 * @param {string} deed.factionId   who it was done for, or to
 */
export async function propagateDeed(deed = {}) {
  try {
    if (!game.user?.isGM) return null;
    // ⚠️ ONE CLIENT ONLY. Two connected GMs would each apply the whole thing,
    // doubling every reputation change in the world.
    if (game.users?.activeGM !== game.user) return null;
    if (!_enabled("factionPropagation")) return null;

    const valence = String(deed.valence || "neutral").toLowerCase();
    if (valence === "neutral") return null;              // noteworthy, not moving

    // ⚠️ pointsFor, not a raw lookup. The deed store writes "major" and this
    // table has no such key, so eleven of Johnny's deeds scored zero and
    // exited on the line below without a word.
    const base = pointsFor(deed.magnitude);
    if (base <= 0) return null;                          // trivial does not ripple

    const api = _api();
    if (!api?.adjustFactionScore) return null;

    const sign = valence === "heroic" ? +1 : -1;
    const worldId = game.world?.id;
    const all = getAllFactions() ?? {};

    const subject = deed.factionId && all[deed.factionId] ? deed.factionId : null;
    if (!subject) {
      // ⚠️ TWO DIFFERENT THINGS WERE PRINTING THE SAME MESSAGE, and only one of
      // them is normal. A deed about nobody in particular is fine. A deed whose
      // creature carries a factionId for a faction that NO LONGER EXISTS is
      // corrupted data, and it was hiding behind console.debug at the same
      // severity as the harmless case. Eight of Johnny's creatures were in that
      // state — Death Knight, Lord Soth and six more — and three 32-point kills
      // vanished on it without a visible word.
      if (deed.factionId) {
        console.warn(`${TAG} | "${String(deed.text).slice(0, 60)}" points at faction `
          + `${deed.factionId}, which does not exist. The creature's flag is stale — `
          + `run the faction sweep to clear it.`);
      } else {
        console.debug(`${TAG} | "${String(deed.text).slice(0, 60)}" has no faction attached — nothing to move.`);
      }
      return null;
    }

    const moves = new Map();
    moves.set(subject, sign * base);

    const f = all[subject] ?? {};
    // Their allies feel it at half strength: they heard, it was not done to them.
    for (const a of (Array.isArray(f.allies) ? f.allies : [])) {
      const id = _toFactionId(a, all);
      if (id && id !== subject && !moves.has(id)) moves.set(id, Math.round(sign * base * 0.5));
    }
    // Their enemies feel it a quarter the OTHER way: help my enemy and you are
    // a little more my problem; hurt my enemy and you are a little less.
    for (const e of (Array.isArray(f.enemies) ? f.enemies : [])) {
      const id = _toFactionId(e, all);
      if (id && !moves.has(id)) moves.set(id, Math.round(-sign * base * 0.25));
    }

    const changed = [];
    for (const [id, delta] of moves) {
      if (!delta) continue;
      // ⚠️ Only the SUBJECT gets their innate attitude applied. Allies and
      // enemies are hearing about it, and a rumour about strangers should not
      // hand them a rolled opinion of people they have never met.
      const res = await api.adjustFactionScore(id, delta, worldId, { seed: id === subject });
      if (!res) continue;
      const name = all[id]?.name || id;
      if (res.changed) changed.push(`${name}: now ${res.band}`);
      console.log(`${TAG} | ${name} ${res.from} → ${res.to} (${delta > 0 ? "+" : ""}${delta})`);
    }

    // ── Word gets around, and infamy travels at least as fast ───────────────
    //
    // ⚠️ FAME USED TO RISE ONLY FOR HEROIC DEEDS, which meant a party could
    // carve its way through Barovia and remain, officially, unheard of. All 16
    // of Johnny's applied deeds are kills, so his renown sat at 12 and could
    // never move; he could have destroyed Strahd himself and the number would
    // not have twitched.
    //
    // Johnny, asked: "yes, make fame rise for any deed of consequence."
    //
    // Renown is how WIDELY you are known, not how well you are liked. Those are
    // two separate axes and the faction scores already carry the second one.
    // Famous and hated is a perfectly good place to be in Barovia, and the band
    // labels — "Known regionally", "Legendary" — read correctly either way.
    let fame = null;
    if (api.addFame) {
      fame = await api.addFame(deed.magnitude, worldId);
    }

    if (changed.length || fame?.changed) {
      const bits = [];
      if (changed.length) bits.push(changed.join(", "));
      // ⚠️ Only when the visible number moved. Fame carries a fraction, so a
      // local deed can raise it by 0.4 and announcing "the party is now Known
      // locally" for the fortieth time is noise.
      if (fame?.changed) bits.push(`the party is now ${fame.band} (renown ${fame.to})`);
      ui.notifications?.info(`ACE: ${bits.join(" · ")}`);
    }
    return { moves: [...moves.entries()], changed, fame };
  } catch (err) {
    console.warn(`${TAG} | deed propagation failed (non-fatal):`, err);
    return null;
  }
}

/** Fire on every deed the memory manager records. */
export function installDeedPropagation() {
  Hooks.on(`${MODULE_ID}.deedRecorded`, (deed) => { propagateDeed(deed); });
  console.debug(`${TAG} | deeds now move faction standing`);
}
