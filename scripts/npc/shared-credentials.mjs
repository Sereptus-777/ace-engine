// ─── ACE: Engine — Shared ElevenLabs Credential ───────────────────────────
//
// ONE place that answers "what is the effective ElevenLabs key, and where did
// it come from?". Every consumer routes through here — tts.mjs, voice-engine
// (voice list), panel.mjs (status badge + narration), the standalone subtle
// broadcast path, and the GM socket proxy that speaks on players' behalf.
//
// Why this exists. Root cause 2026-07-10 18:24, finished 2026-07-24: the key
// can live in two places — config.local.json and the module setting — and
// FIVE separate call sites each decided for themselves which to read. Two of
// them ignored the file entirely. So a GM whose key was only in the file got
// working voices on one path and dead silence on the others, with nothing in
// the logs to explain it. One key, one accessor, every consumer.
//
// Two rules that keep it honest:
//   1. The file wins over the setting — the precedence the GM's own playback
//      has always used.
//   2. The setting is read AT CALL TIME and never cached at boot. Paste a key
//      into AI Setup mid-session and the very next spoken line uses it: no
//      reload, no stale copy left over from startup.
//
// Deliberately dependency-free (module id inlined rather than imported) so
// tts.mjs and friends can import it without pulling in the entry module and
// creating an import cycle. The key is never logged and never exposed on the
// public api.

const MODULE_ID = "ace-engine";

// ⚠️🔴 THE config.local.json KEY IS GONE, AND SO IS ITS PRECEDENCE.
//
// `_fileKey` held the key read out of config.local.json and OUTRANKED the
// module setting. Two problems in one variable:
//
//   1. Foundry serves that file to every connected client over HTTP, before
//      any of our code runs. A key in it is readable by any player.
//   2. Because it won, a GM who had already done the right thing and moved
//      their key into the (client-scoped, never broadcast) setting still had
//      the public one used instead. Doing the safe thing changed nothing.
//
// The loader in ace-engine.mjs now refuses to read the key at all, so the
// setting is the only source. The setter below stays as a REFUSAL rather than
// being deleted: if anything ever calls it again - a re-added loader, an
// older build, a third-party patch - it says so instead of quietly restoring
// the precedence that caused this. External audit, 2026-08-26.

/**
 * Refuses. Kept so a caller that reopens the hole is heard, not obeyed.
 * @deprecated The ElevenLabs key comes from the module setting and nowhere else.
 */
export function setSharedElevenLabsKey(k) {
  if (!k) return;
  console.error(`${MODULE_ID} | REFUSED an attempt to override the ElevenLabs key from outside `
    + `the module setting. That path was config.local.json, which Foundry serves to every `
    + `player. The setting is the only source. Nothing was changed.`);
}

/**
 * The effective key plus a human-readable source, for status badges.
 * @returns {{key: string, source: string}} source is "Module Settings" or
 *          "none". config.local.json is no longer a source of keys.
 */
export function getSharedElevenLabsKeyInfo() {
  try {
    const settingsKey = (game.settings.get(MODULE_ID, "elevenLabsApiKey") || "").trim();
    if (settingsKey) return { key: settingsKey, source: "Module Settings" };
  } catch (err) {
    console.warn(`${MODULE_ID} | ElevenLabs key: settings read failed —`, err?.message ?? err);
  }
  return { key: "", source: "none" };
}

/** The effective key, or "" when none is configured anywhere. */
export function getSharedElevenLabsKey() { return getSharedElevenLabsKeyInfo().key; }
