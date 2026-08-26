// ─── ACE: Engine — a stored key cannot be blanked, and blanking gets named ───
//
// ⚠️🔴 THIRTEEN TIMES. Johnny has now lost his ElevenLabs key thirteen times.
// Each loss is silent: the key becomes an empty string, and he finds out when an
// NPC answers in a robot voice in front of his players.
//
// On 2026-08-25 I traced every write path in the suite and every one of them is
// already guarded:
//
//   • Foundry's own Game Settings — the key is `config: false`, so it does not
//     render there and Save Changes cannot touch it.
//   • ACE's config panel — `isMaskedKey()` covers it and the panel refuses to
//     write "" over a stored value, with a notification saying so.
//   • The secrets migration — only touches apiKey / chatApiKey / digestApiKey.
//
// So the caller that blanks it is one I have not found. That is the whole
// problem with the approach: I have been reconstructing the crime afterwards
// from an empty box, thirteen times, and losing.
//
// ═══ SO THIS FILE DOES TWO THINGS, AND THE SECOND MATTERS MORE ══════════════
//
//   1. PUTS THE KEY BACK. Any write of an empty value over a stored key is
//      undone immediately. Whoever did it, however they got there.
//
//   2. NAMES WHO DID IT. It captures a stack trace at the moment of the
//      blanking and prints it. The next time this happens we will not be
//      guessing — we will have the file and line of the caller I could not
//      find by reading.
//
// ⚠️ A GUARD THAT ONLY PREVENTS TEACHES US NOTHING. Prevention alone would
// have quietly papered over twelve of these and left the cause alive. The trace
// is the part that ends it.
//
// ⚠️ CLEARING A KEY ON PURPOSE IS STILL POSSIBLE, and has to be — a rotated key
// must be removable. It is done knowingly, through `clearProtectedKey()`, and
// never by leaving a box empty. Johnny's rule, and it is the right one:
// "a blank box is never 'delete it'."
// ──────────────────────────────────────────────────────────────────────────────

const LOG = "ACE: Engine | KeyGuard";

/** Last known-good value per "module.key", so a blanking can be undone. */
const _shadow = new Map();

/** Set while we are writing the value back, so the guard cannot recurse. */
const _restoring = new Set();

/** Keys the caller has asked to clear deliberately — one write each. */
const _blessed = new Set();

const _id = (moduleId, key) => `${moduleId}.${key}`;

/**
 * Protect one setting from being silently emptied.
 *
 * Call AFTER the setting is registered. Returns an onChange-compatible function
 * if the caller wants to chain it; the guard installs itself either way.
 *
 * @param {string} moduleId
 * @param {string} key
 * @param {string} label   what to call it when speaking to the GM
 */
export function protectKey(moduleId, key, label = key) {
  const id = _id(moduleId, key);
  try {
    const current = (game.settings.get(moduleId, key) || "").toString().trim();
    if (current) _shadow.set(id, current);
  } catch (_) { /* not registered yet — the first non-empty write seeds it */ }

  return async function onKeyChanged(value) {
    const v = (value ?? "").toString().trim();

    // A real value: remember it and get out of the way.
    if (v) { _shadow.set(id, v); return; }

    // Deliberate removal, asked for by name.
    if (_blessed.has(id)) {
      _blessed.delete(id);
      _shadow.delete(id);
      console.log(`${LOG} | "${label}" cleared deliberately.`);
      return;
    }

    // Our own write-back landing.
    if (_restoring.has(id)) return;

    const saved = _shadow.get(id);
    if (!saved) return;              // nothing to protect — it was already empty

    // ⚠️ THE TRACE IS THE POINT. Capture it BEFORE the await, while the
    // blanking caller is still on the stack.
    const trace = new Error("blanked here").stack ?? "(no stack available)";

    try {
      _restoring.add(id);
      await game.settings.set(moduleId, key, saved);
      console.warn(
        `${LOG} | Something tried to erase "${label}" and it has been put back.\n`
        + `${LOG} | A blank box is never "delete it". To remove it on purpose, call:\n`
        + `${LOG} |     game.modules.get("ace-engine").api.clearKey("${key}")\n`
        + `${LOG} | THE CALLER THAT DID THIS:\n${trace}`);
      ui.notifications?.warn(
        `ACE kept your ${label}. Something tried to blank it — the console names what.`);
    } catch (err) {
      // ⚠️ IF THE RESTORE FAILS, SAY SO IN THE LOUDEST WAY AVAILABLE. A guard
      // that fails quietly is worse than no guard, because it is trusted.
      console.error(`${LOG} | COULD NOT restore "${label}" — it is now empty. `
        + `The value was: ${saved.slice(0, 6)}…${saved.slice(-4)}`, err);
      ui.notifications?.error(
        `ACE could not restore your ${label}. Check the console before you re-enter it.`);
    } finally {
      _restoring.delete(id);
    }
  };
}

/** Remove a protected key on purpose. The only way it can legitimately go. */
export async function clearProtectedKey(moduleId, key) {
  const id = _id(moduleId, key);
  _blessed.add(id);
  try {
    await game.settings.set(moduleId, key, "");
    ui.notifications?.info(`ACE cleared ${key}.`);
  } catch (err) {
    _blessed.delete(id);
    console.error(`${LOG} | could not clear "${key}":`, err);
  }
}

/** What the guard is currently holding, for a GM who wants to look. */
export function protectedKeyStatus(moduleId, key) {
  const saved = _shadow.get(_id(moduleId, key)) ?? "";
  let live = "";
  try { live = (game.settings.get(moduleId, key) || "").toString().trim(); } catch (_) {}
  return {
    stored: !!live,
    shadowed: !!saved,
    preview: live ? `${live.slice(0, 6)}…${live.slice(-4)} (${live.length} chars)` : "empty",
  };
}
