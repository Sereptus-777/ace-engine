// ─── WHICH GM SCREEN MAKES A PLAYER'S NPC VOICE ─────────────────────────────
//
// Johnny, 2026-10-15: a second GM login on another screen showed "no
// ElevenLabs key found", and his main screen did not. Both were right. The key
// is kept in each browser (his rule, 2026-10-13: client settings only), so a
// second browser starts empty.
//
// ⚠️🔴 BUT EVERY GM SCREEN ANSWERED A PLAYER'S VOICE REQUEST. A player's screen
// asks a GM to make the voice and takes the FIRST answer that comes back. The
// keyless screen answered at once with "the GM has no ElevenLabs API key",
// while the main screen was still waiting on ElevenLabs, so with a second GM
// connected the table's NPC voices failed. Two GMs both holding a key would each
// pay for the line, and the table would hear it twice.
//
// ONE GM ANSWERS, AND IT IS ONE THAT CAN MAKE THE VOICE. Each GM screen says
// whether it can (yes or no, never the key) when it starts, when it is asked,
// and when its key or voice provider changes. Every GM screen works out the
// same answerer from the same list:
//   • someone can voice: the active GM if it can, otherwise the lowest id;
//   • every GM has said it cannot: the active GM gives the honest error, so
//     the player is not left waiting thirty seconds for nothing;
//   • a GM screen has not said yet: nobody sends an error in its place.
//
// The creature-sound relay already lets only the active GM answer; voice
// cannot, because the active GM may be the screen without the key.
// ──────────────────────────────────────────────────────────────────────────────

import { getSharedElevenLabsKey } from "./shared-credentials.mjs";

const MODULE_ID = "ace-engine";

/**
 * Who answers, from what each connected GM has said.
 * @param {Array<{id:string, can:(boolean|undefined)}>} gms  connected GMs; can is undefined until said
 * @param {string|null} activeGmId  Foundry's active GM
 * @returns {{id:(string|null), answer:("voice"|"error"|"wait")}}
 */
export function chooseVoiceAnswerer(gms, activeGmId) {
  const live = (gms ?? []).filter(g => g?.id);
  const can = live.filter(g => g.can === true).map(g => g.id).sort();
  if (can.length) return { id: can.includes(activeGmId) ? activeGmId : can[0], answer: "voice" };
  if (!live.length || live.some(g => g.can !== false)) return { id: null, answer: "wait" };
  const fallback = live.some(g => g.id === activeGmId) ? activeGmId : (live.map(g => g.id).sort()[0] ?? null);
  return { id: fallback, answer: "error" };
}

/** What each other GM screen has said: user id → can it voice. */
const _said = new Map();

/** A GM screen said whether it can voice. */
export function noteVoiceStatus(userId, can) {
  if (userId) _said.set(userId, can === true);
}

/**
 * Can THIS screen make a player's voice? The same test the relay itself uses:
 * a reachable local speech server when that is the provider, otherwise an
 * ElevenLabs key in this browser.
 */
export async function canVoiceHere() {
  let provider = "elevenlabs";
  try { provider = game.settings.get(MODULE_ID, "voiceProvider") || "elevenlabs"; } catch (_) { /* default */ }
  if (provider === "localserver") {
    try {
      const { probe } = await import("./tts-local.mjs");
      return !!(await probe())?.ok;
    } catch (_) { return false; }
  }
  return !!getSharedElevenLabsKey();
}

/** Who answers a voice request right now, with this screen's own answer read fresh. */
export function voiceAnswerer({ selfCan }) {
  const me = game.user?.id ?? null;
  const gms = (game.users?.filter?.(u => u.isGM && u.active) ?? []).map(u => ({
    id: u.id,
    can: u.id === me ? selfCan === true : _said.get(u.id),
  }));
  return chooseVoiceAnswerer(gms, game.users?.activeGM?.id ?? null);
}

/** A GM screen says whether it can voice. Yes or no only: the key never leaves this browser. */
export async function sayVoiceStatus() {
  if (!game.user?.isGM) return;
  const can = await canVoiceHere();
  _said.set(game.user.id, can);
  try {
    game.socket.emit(`module.${MODULE_ID}`, { action: "voiceStatus", can });
    console.log(`${MODULE_ID} | this GM screen ${can ? "can" : "cannot"} make players' NPC voices, and told the other GM screens.`);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not tell the other GM screens whether this one can make NPC voices:`, err);
  }
}

/** Ask every GM screen to say whether it can voice. */
export function askVoiceStatus() {
  try { game.socket.emit(`module.${MODULE_ID}`, { action: "voiceStatusAsk" }); }
  catch (err) { console.warn(`${MODULE_ID} | could not ask the other GM screens whether they can make NPC voices:`, err); }
}
