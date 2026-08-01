// ─── ACE: Engine — Context Budget ─────────────────────────────────────────
//
// ONE definition of "how much conversation history may ride along with an AI
// request", derived from the Max Context Tokens setting.
//
// Why this exists. Until 2026-07-24 that setting was registered, rendered in
// the config panel with a helpful hint, and read by NOTHING. The real limit
// was a hard-coded 24,000-character budget buried in ai-provider.mjs. Moving
// the slider did absolutely nothing — which is worse than having no slider,
// because a GM moves it, sees no change, and concludes the module is broken.
//
// Tokens → characters uses the same ~3.5 chars/token estimate the provider
// already used for its own prompt-size logging, so the number on the slider
// lines up with what the provider reports.
//
// Dependency-free (module id inlined) so both AI stacks — ai-provider.mjs and
// the NPC conversation engine — can import it without an import cycle.

const MODULE_ID      = "ace-engine";
const CHARS_PER_TOKEN = 3.5;

// Matches the old hard-coded 24,000-char behaviour (24000 / 3.5 ≈ 6857).
// Used when the setting isn't readable yet, and it's also the registered
// default, so a GM who never touches the slider gets exactly what ACE always
// did rather than a silent downgrade.
const FALLBACK_TOKENS = 7000;

/** The configured context budget, in tokens. */
export function getContextBudgetTokens() {
  try {
    const v = Number(game.settings.get(MODULE_ID, "maxContextTokens"));
    if (Number.isFinite(v) && v > 0) return v;
  } catch (_) { /* settings not registered yet — fall through */ }
  return FALLBACK_TOKENS;
}

/** The configured context budget, expressed in characters. */
export function getContextBudgetChars() {
  return Math.round(getContextBudgetTokens() * CHARS_PER_TOKEN);
}

/**
 * The GM's Max Response Tokens setting — the ceiling on how long one AI reply
 * may be. Lives here beside the context budget so both token dials are read
 * through one place rather than re-implemented per stack.
 *
 * This matters more than it looks: providers PRE-AUTHORISE this number against
 * your credit before generating anything. Sending no cap makes OpenRouter
 * reserve the model's absolute maximum (16,384 on gpt-4o-mini) and refuse the
 * job outright if your balance can't cover the worst case — which is exactly
 * how bio generation died silently for weeks (2026-07-24).
 */
export function getMaxResponseTokens() {
  try {
    const v = Number(game.settings.get(MODULE_ID, "maxResponseTokens"));
    if (Number.isFinite(v) && v > 0) return v;
  } catch (_) { /* settings not registered yet */ }
  return 2048;
}

/**
 * Drop the oldest messages until the history fits the budget.
 * Always keeps the last few exchanges, so an oversized budget-buster can
 * never erase the whole thread and leave the model with no thread to follow.
 *
 * @param {Array}  history
 * @param {number} [budgetChars]  defaults to the configured budget
 * @param {number} [keepMin]      floor on retained messages
 * @returns {Array} the same array when it already fits, otherwise a trimmed copy
 */
export function trimHistoryToBudget(history, budgetChars = getContextBudgetChars(), keepMin = 4) {
  if (!Array.isArray(history) || history.length === 0) return history;
  const size = (m) => (typeof m?.content === "string" ? m.content.length : 200);

  let total = history.reduce((sum, m) => sum + size(m), 0);
  if (total <= budgetChars) return history;

  const trimmed = [...history];
  while (trimmed.length > keepMin && total > budgetChars) {
    total -= size(trimmed.shift());
  }
  return trimmed;
}
