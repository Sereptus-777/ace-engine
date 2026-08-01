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

/** Key found in config.local.json, deposited once at boot. Highest precedence. */
let _fileKey = "";

/** Deposit the config.local.json key. Called at boot by ace-engine.mjs. */
export function setSharedElevenLabsKey(k) { _fileKey = (k || "").trim(); }

/**
 * The effective key plus a human-readable source, for status badges.
 * @returns {{key: string, source: string}} source is "config.local.json",
 *          "Module Settings", or "none".
 */
export function getSharedElevenLabsKeyInfo() {
  if (_fileKey) return { key: _fileKey, source: "config.local.json" };
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
