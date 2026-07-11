// ─── ACE: Engine — Shared Credential Slot ─────────────────────────────────────
// ace-engine.mjs (which loads config.local.json) deposits the EFFECTIVE
// ElevenLabs key here at boot; tts.mjs reads it without importing the entry
// module (no import cycle). The value is never logged and never exposed on
// the public api. Root cause 2026-07-10 18:24: the GM window spoke via the
// local credentials FILE while the player-proxy + tts getters read only the
// (empty) client setting — voices worked on one path and were silent on the
// others. One effective key, every consumer.
let _elevenLabsKey = "";
export function setSharedElevenLabsKey(k) { _elevenLabsKey = (k || "").trim(); }
export function getSharedElevenLabsKey() { return _elevenLabsKey; }
