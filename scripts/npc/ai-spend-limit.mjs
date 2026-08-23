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
// ⚠️🔴 IT THROTTLED A REAL CONVERSATION (2026-08-21). The original version put
// every relay through ONE budget of 20 requests per five minutes, above a
// comment claiming that was "far above real roleplay". It is not, and Varek
// Thalor proved it mid-scene: he answered four times, went silent, and the only
// trace was a console line.
//
// The arithmetic nobody did. One exchange with an NPC costs:
//     1 AI request   — the reply itself
//   + 2 TTS requests — the log says "2 segment(s) to speak" for a line with
//                      any narration in it, and long answers split further
// So a normal back-and-forth burns THREE slots, and twenty of them is six
// exchanges. Six. That is not abuse, that is a conversation barely getting
// started, and the limiter cut the NPC off in the middle of one.
//
// Two things were wrong underneath the number:
//   1. ONE BUDGET FOR TWO VERY DIFFERENT COSTS. A sentence of speech is not a
//      language-model call; they bill differently and they occur at completely
//      different rates. They get separate budgets now.
//   2. IT COUNTED SEGMENTS, NOT UTTERANCES. Splitting one spoken line into a
//      narration part and a dialogue part is our own implementation detail. It
//      must not make a player look three times as expensive as they are.
//
// The point of this file is to stop a runaway loop, which fires hundreds of
// requests a minute. It was never meant to police someone roleplaying.

const TAG = "ACE: Engine | Spend";

// ⚠️ Anything a language model answers is metered tightly. Speech is metered
// loosely, because it is cheap per line and a talkative scene is legitimate.
// Both remain orders of magnitude below what a runaway loop produces.
const BUDGETS = {
  ai:  { windowMs: 300_000, max:  30, serialize: true  },
  tts: { windowMs: 300_000, max: 120, serialize: false },
};

/** Which budget a relay draws from. Anything voice-shaped is speech. */
function _bucketFor(what) {
  return /tts|speak|voice/i.test(String(what ?? "")) ? "tts" : "ai";
}

const _spend = new Map();          // userId -> { [bucket]: { inFlight, stamps[] } }

// Kept for anything that still imports them.
export const AI_WINDOW_MS     = BUDGETS.ai.windowMs;
export const AI_MAX_PER_WINDOW = BUDGETS.ai.max;

/** Last refusal reason, so a caller can tell the human instead of a console. */
export let lastRefusal = "";

/**
 * Claim a slot. Returns false when the player must wait.
 * ⚠️ Every caller MUST pair a true return with doneSpending() in a `finally`,
 * or that player is locked out until they reload.
 */
export function maySpendOnAI(user, now = Date.now(), what = "AI") {
  lastRefusal = "";
  if (!user?.id) return false;

  const bucketName = _bucketFor(what);
  const limit = BUDGETS[bucketName];
  const perUser = _spend.get(user.id) ?? {};
  _spend.set(user.id, perUser);
  const rec = perUser[bucketName] ?? { inFlight: false, stamps: [] };
  perUser[bucketName] = rec;

  // ⚠️ Speech is NOT serialised. One spoken line is several sequential
  // requests, and a strict one-in-flight rule turns our own segmenting into a
  // refusal — which is exactly what produced "Too many voice requests in a row"
  // in the middle of a single sentence.
  if (limit.serialize && rec.inFlight) {
    lastRefusal = "still working on your last request";
    console.warn(`${TAG} | ${what} REFUSED — "${user.name}" already has a request in flight.`);
    return false;
  }

  rec.stamps = rec.stamps.filter(t => now - t < limit.windowMs);
  if (rec.stamps.length >= limit.max) {
    const waitSec = Math.max(1, Math.ceil((limit.windowMs - (now - rec.stamps[0])) / 1000));
    lastRefusal = bucketName === "tts"
      ? `voices are rate limited for about ${waitSec}s to protect the GM's ElevenLabs bill`
      : `AI replies are rate limited for about ${waitSec}s to protect the GM's bill`;
    console.warn(`${TAG} | ${what} REFUSED — "${user.name}" used ${limit.max} ${bucketName} requests in ` +
      `${limit.windowMs / 60000} minutes. Clears in ~${waitSec}s.`);
    // ⚠️ SAY IT ON SCREEN. A silent refusal is indistinguishable from a broken
    // feature: the NPC simply stops mid-scene and everyone assumes it crashed.
    // The GM is the one who can do something about it, and it is their bill.
    if (game.user?.isGM) {
      ui.notifications?.warn(
        `ACE: ${user.name} hit the ${bucketName === "tts" ? "voice" : "AI"} rate limit. ` +
        `It clears in about ${waitSec} seconds.`);
    }
    return false;
  }

  rec.stamps.push(now);
  if (limit.serialize) rec.inFlight = true;
  return true;
}

/** Release the slot. Safe to call twice; safe to call for an unknown user. */
export function doneSpending(user) {
  const perUser = user?.id ? _spend.get(user.id) : null;
  if (!perUser) return;
  for (const rec of Object.values(perUser)) rec.inFlight = false;
}
