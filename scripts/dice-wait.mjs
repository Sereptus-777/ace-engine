// ─── ACE: Engine — nothing lands before the dice ──────────────────────────────
// Johnny's rule across the whole suite: nothing touches a creature, fires a
// signal or shows an answer until the dice that decided it have visibly landed.
// ACE QOL keeps this in its dsn-utils.mjs and Forge in its own dice-wait.mjs.
// Engine runs without either, so it carries the same two ideas, the same way
// Forge does:
//
//   1. engineShowDice(...) throws a roll's dice and keeps Dice So Nice's own
//      "these dice have stopped" promise. It takes showForRoll's own arguments,
//      so a blind throw, a ghost "?" throw or a GM-only throw stays exactly that.
//   2. engineAwaitDice() waits until every die Engine has thrown has landed.
//
// ⚠️ WHY (Codex review, 2026-10-14): the blind "?" rolls awaited Dice So Nice's
// bare promise. A renderer that breaks mid-throw never settles it, and a catch
// cannot release a promise that never settles, so the roll hung forever. The cap
// below only ever catches that; a working renderer says when its dice stop,
// however long they take.
//
// Imports nothing on purpose: Engine's entry file imports the files that import
// this, and a cycle read at load kills the whole module.
// ──────────────────────────────────────────────────────────────────────────────

const TAG = "ace-engine | dice";
const CAP_MS = 20000;
const _inFlight = new Set();

/** Throw a roll's dice with showForRoll's own arguments. Never throws, never hangs. */
export function engineShowDice(...args) {
  const dsn = game?.dice3d;
  if (typeof dsn?.showForRoll !== "function") return;
  try {
    const p = dsn.showForRoll(...args);
    if (p && typeof p.then === "function") {
      _inFlight.add(p);
      const drop = () => _inFlight.delete(p);
      p.then(drop, (err) => {
        drop();
        console.warn(`${TAG}: Dice So Nice refused a roll (the result still stands):`, err?.message ?? err);
      });
    }
  } catch (err) {
    console.warn(`${TAG}: Dice So Nice threw while showing a roll (the result still stands):`, err?.message ?? err);
  }
}

/** Wait until every die Engine has thrown has landed. */
export async function engineAwaitDice() {
  if (!_inFlight.size) return;
  let timer = null;
  const cap = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`${TAG}: dice still reported rolling after ${CAP_MS / 1000} seconds; carrying on.`);
      resolve();
    }, CAP_MS);
  });
  await Promise.race([Promise.allSettled([..._inFlight]), cap]);
  clearTimeout(timer);
}
