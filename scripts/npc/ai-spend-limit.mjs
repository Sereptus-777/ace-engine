// ─── ACE: Engine — what a player is allowed to spend of the GM's money ───────
//
// ⚠️ MOVED OUT OF THE SOCKET ROUTER (Brock, 2026-08-19). The limiter was
// written inside npc-socket-router.mjs, so the ONE relay that lives in a
// different file — ttsRequest, the one that bills ElevenLabs per character —
// could not reach it and shipped authorised but unlimited. A console loop still
// ran up the bill. A guard that only half the callers can import is half a
// guard, so it lives on its own now and every relay imports it.
//
// This is a BILL, not a permission. Relaying through the GM is the only safe
// place for the credential, but it also means a player's client decides when
// the GM's card gets charged.
//
// One request in flight per player — a human waits for the reply before typing
// the next line — and 20 per five minutes, far above real roleplay and far
// below abuse.

const TAG = "ACE: Engine | Spend";

const _spend = new Map();          // userId -> { inFlight, stamps[] }
export const AI_WINDOW_MS = 300_000;
export const AI_MAX_PER_WINDOW = 20;

/**
 * Claim a slot. Returns false when the player must wait.
 * ⚠️ Every caller MUST pair a true return with doneSpending() in a `finally`,
 * or that player is locked out until they reload.
 */
export function maySpendOnAI(user, now = Date.now(), what = "AI") {
  if (!user?.id) return false;
  const rec = _spend.get(user.id) ?? { inFlight: false, stamps: [] };
  _spend.set(user.id, rec);

  if (rec.inFlight) {
    console.warn(`${TAG} | ${what} REFUSED — "${user.name}" already has a request in flight.`);
    return false;
  }
  rec.stamps = rec.stamps.filter(t => now - t < AI_WINDOW_MS);
  if (rec.stamps.length >= AI_MAX_PER_WINDOW) {
    console.warn(`${TAG} | ${what} REFUSED — "${user.name}" hit ${AI_MAX_PER_WINDOW} requests in ` +
      `${AI_WINDOW_MS / 60000} minutes. Ignoring until the window clears.`);
    return false;
  }
  rec.stamps.push(now);
  rec.inFlight = true;
  return true;
}

/** Release the slot. Safe to call twice; safe to call for an unknown user. */
export function doneSpending(user) {
  const rec = user?.id ? _spend.get(user.id) : null;
  if (rec) rec.inFlight = false;
}
