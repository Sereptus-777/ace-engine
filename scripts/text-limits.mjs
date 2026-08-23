// ─── ACE Engine — how long a stored piece of campaign text may be ───────────
//
// ⚠️🔴 WHY THIS EXISTS, AND WHAT WAS WRONG (2026-08-21).
//
// Johnny: "I don't ever remember discussing caps on responses and talking to
// people. I didn't even know that existed until today. Why is it being cut off
// at all?" He is right on both counts. Nobody chose these numbers deliberately;
// they were typed inline at nine different call sites, each one a guess, and
// they quietly cost him five months of campaign detail.
//
// What they actually cost, measured against his own history file:
//     conversations   138 of 178 clipped   (78%)  cut at 200 chars, mid-word
//     narration        23 of  62 clipped   (37%)  cut at 300 chars, mid-word
//     GM notes          1 of 198 clipped    (1%)
//     deeds             0 of 183            (0%)  longest was 166
//
// ⚠️ THE MISTAKE UNDERNEATH ALL OF THEM: trimming on the way IN.
//
// There are two completely different reasons to shorten text, and they were
// conflated. Keeping a file small and keeping a MODEL PROMPT small are not the
// same job, and only one of them is allowed to destroy anything:
//
//   READING  — a language model has a token budget, so context assembled for a
//              prompt must be trimmed. This is correct, it already happens, and
//              it costs nothing: the full text is still on disk. The event
//              formatter has always cut narration to 80 characters for exactly
//              this reason.
//   WRITING  — the archive of what happened in someone's campaign. Trimming
//              here is not a budget, it is deletion, and it is permanent.
//
// Because the read side already protects the prompt, the write side never
// needed to cut anything at all. It did both, so the loss bought nothing.
//
// The limits below are therefore a runaway guard and nothing more: a stuck loop
// writing a megabyte of text still cannot bloat the world. Real prose from a
// real session never comes near them.
//
// ⚠️ AND NOTHING IS EVER CUT MID-WORD. A record ending "where a sacred artifa"
// is not a shorter record, it is a broken one.

// ⚠️🔴 NO LIMITS ON WRITING TO THE WORLD. Johnny, 2026-08-21: "I don't want any
// limits on writing to my world. I'm not worried about space here."
//
// So every value below is the SAME number, and that number is not a length
// choice, it is a runaway guard: one entry may be a hundred thousand
// characters, roughly forty pages of prose, for a single note. Nothing a person
// types and nothing a language model returns comes within a hundredth of it.
// The only thing it can ever stop is a stuck loop writing until the world file
// is unusable, and that is the entire reason it is not simply Infinity.
//
// The named keys are kept so the call sites still read clearly, and so a future
// limit, if one is ever genuinely wanted, has an obvious place to go. Today
// they are all the same and none of them shortens anything real.
const RUNAWAY_GUARD = 100_000;

export const STORE_LIMIT = {
  narration:      RUNAWAY_GUARD,   // was 300  — 37% of his narration was clipped
  note:           RUNAWAY_GUARD,   // was 500
  worldNote:      RUNAWAY_GUARD,   // was 500
  npcNote:        RUNAWAY_GUARD,   // was 300
  conversation:   RUNAWAY_GUARD,   // was 200  — the worst, 78% clipped
  encounter:      RUNAWAY_GUARD,   // was 300  — the conversation encounter record
  deed:           RUNAWAY_GUARD,   // was 300
  milestone:      RUNAWAY_GUARD,   // was 300
  sessionSummary: RUNAWAY_GUARD,   // was 2000, or 4000 when hand-edited
  scene:          RUNAWAY_GUARD,
};

/**
 * Shorten to a whole sentence, falling back to a whole word, and only when the
 * text genuinely exceeds the limit. Text that fits is returned untouched.
 *
 * @param {string} text
 * @param {number} max   character ceiling
 * @returns {string}
 */
export function trimToSentence(text, max) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;

  const cut = t.slice(0, max);
  // Prefer a sentence ending, but only if it is not so early that we would
  // throw away most of what fits.
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "),
                        cut.lastIndexOf("? "), cut.lastIndexOf(".\n"));
  if (stop > max * 0.5) return cut.slice(0, stop + 1);

  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[,;:\-–—]$/, "") + "…";
}
