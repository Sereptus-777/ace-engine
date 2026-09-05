// ─── ACE: QOL — Registering for a thing that has already happened ───────────
//
// ⚠️🔴 THE SHAPE THAT COST THIRTEEN CONDITION GHOSTS. On 2026-08-12 we learned
// that `Hooks.once("ready")` registered from INSIDE the entry file's own ready
// handler waits on an event already in progress and never fires. Nothing
// throws, nothing logs, and the feature is simply absent. The fix written that
// day was `if (game.ready) run(); else Hooks.once("ready", run);`.
//
// ⚠️ `canvasReady` HAS THE SAME SHAPE AND IT IS EASIER TO MISS. Foundry draws
// the canvas and fires `canvasReady` BEFORE `ready` finishes, so any ACE
// subsystem that starts from a ready handler and then does
// `Hooks.on("canvasReady", …)` has already missed the first firing. It looks
// fine, because the listener DOES fire — on the next scene change. So the
// feature is absent exactly once: on load, which is the only time he is looking
// at a fresh world.
//
// A sweep on 2026-09-05 found 25 of these across the suite.
//
// ⚠️ THIS IS NOT `once`. The listener stays registered for every future scene;
// all this adds is the run that was missed. That makes it behaviour-preserving
// everywhere: it can only ADD the first call, never remove a later one.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-engine";

/**
 * Run `fn` on every canvas draw, INCLUDING the one that already happened.
 *
 * @param {Function} fn     the listener, called with the canvas as Foundry does
 * @param {string} label    named in any error, so a throw points at the caller
 * @returns {Function}      the registered listener, for `Hooks.off`
 */
export function onCanvasReady(fn, label = "a canvas listener") {
  const wrapped = (cnv) => {
    try { return fn(cnv ?? globalThis.canvas); }
    catch (err) {
      // ⚠️ ONE LISTENER'S THROW MUST NOT TAKE THE SCENE DOWN WITH IT, and it
      // must not be silent either — a canvas feature that quietly stopped is
      // indistinguishable from one that was never built.
      console.error(`${MODULE_ID} | ${label} threw on canvasReady:`, err);
    }
  };
  Hooks.on("canvasReady", wrapped);

  // The one that already happened. `canvas.ready` is Foundry's own flag for
  // "the scene is drawn"; if it is up, this registration is late and the first
  // call has to be made by hand.
  try {
    if (globalThis.canvas?.ready) wrapped(globalThis.canvas);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not run ${label} for the current canvas:`, err);
  }
  return wrapped;
}

/**
 * Run `fn` ONCE, on the next canvas draw — or right now if it already drew.
 *
 * ⚠️🔴 `Hooks.once("canvasReady", …)` REGISTERED LATE NEVER RUNS AT ALL.
 * The recurring form at least wakes on the next scene change; the `once` form
 * is waiting for a firing that has already been and gone, so the work simply
 * never happens. `perception-watcher.mjs` used it for its initial overlay draw
 * and `ui-hooks.mjs` for the HUD observer — both marked "initial", both the one
 * call that mattered.
 */
export function onceCanvasReady(fn, label = "a one-time canvas listener") {
  const run = () => {
    try { fn(globalThis.canvas); }
    catch (err) { console.error(`${MODULE_ID} | ${label} threw on canvasReady:`, err); }
  };
  if (globalThis.canvas?.ready) run();
  else Hooks.once("canvasReady", run);
}
