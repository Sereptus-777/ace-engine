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

// ⚠️🔴 THE PER-USER BUDGET CANNOT PROTECT THE BILL, AND HERE IS WHY.
//
// Foundry gives NO TRUSTED SENDER on a socket. `game.socket.emit` relays the
// payload verbatim; the `userId` inside it is a value the SENDER wrote. Every
// module stamps its own id in there for exactly that reason, and every module
// can therefore be lied to. Our own note says it plainly: "Is the sender a GM?"
// is NOT a check.
//
// So `_claimingPlayer` verifying that the claimed id names a real, active,
// non-GM user proves only that the LIAR knows somebody else's name. One client
// rotating through the ids of everyone at the table multiplies the budget by
// the number of players connected. Flagged by an external audit 2026-08-25 and
// it was right.
//
// You cannot fix that by inspecting the claim harder. There are two separate
// jobs here and they had been merged into one:
//
//   FAIRNESS  - "has THIS player had more than their share?" needs a trustworthy
//               identity, which a socket cannot give. See the note at the bottom
//               of this file for the only sound way to get one.
//   THE BILL  - "has THIS TABLE spent more than the GM agreed to?" needs no
//               identity at all. It is a ceiling, and a ceiling cannot be forged
//               by pretending to be somebody else.
//
// The ceiling is what stands between a runaway client and a real invoice, so it
// goes in now and it is deliberately independent of who anybody claims to be.
// A forged id can still steal another player's SHARE - which is rude - but it
// can no longer spend more of Johnny's money than this.
//
// ⚠️ SET SO A REAL TABLE NEVER SEES IT. Six players talking hard is roughly
// 6 AI and 12 speech requests a minute. These are five to ten times that, and
// still one to two orders of magnitude below the hundreds-per-minute a broken
// loop produces - which is the only thing this was ever meant to catch.
const TABLE_CEILING = {
  ai:  { windowMs: 300_000, max: 150 },
  tts: { windowMs: 300_000, max: 600 },
};

const _table = { ai: [], tts: [] };   // bucket -> timestamps, everyone together

/**
 * Has the whole table exceeded what the GM's bill can absorb?
 * Identity-free on purpose: this is the guard a forged userId cannot walk past.
 */
function _tableIsOverBudget(bucketName, now) {
  const cap = TABLE_CEILING[bucketName];
  if (!cap) return false;
  const stamps = _table[bucketName];
  // Drop anything outside the window, in place.
  let i = 0;
  while (i < stamps.length && now - stamps[i] >= cap.windowMs) i++;
  if (i) stamps.splice(0, i);
  return stamps.length >= cap.max;
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

  // ⚠️🔴 THE TABLE CEILING IS CHECKED FIRST, and it is checked against
  // nobody in particular. A client rotating through forged user ids sails past
  // every per-user budget in the file and arrives here, where identity is not
  // consulted at all. This is the line that protects the invoice.
  if (_tableIsOverBudget(bucketName, now)) {
    const cap = TABLE_CEILING[bucketName];
    const waitSec = Math.max(1, Math.ceil((cap.windowMs - (now - _table[bucketName][0])) / 1000));
    lastRefusal = bucketName === "tts"
      ? `the table has used its voice budget - about ${waitSec}s until more is available`
      : `the table has used its AI budget - about ${waitSec}s until more is available`;
    console.warn(`${TAG} | ${what} REFUSED BY THE TABLE CEILING - ${cap.max} ${bucketName} `
      + `requests in ${cap.windowMs / 60000} minutes across ALL players. Clears in ~${waitSec}s. `
      + `If this fires during normal play the ceiling is too low; if it fires repeatedly `
      + `something is looping.`);
    if (game.user?.isGM) {
      ui.notifications?.warn(
        `ACE: the whole table hit the ${bucketName === "tts" ? "voice" : "AI"} spend ceiling. `
        + `Clears in about ${waitSec} seconds. If nobody is roleplaying, something is looping.`);
    }
    return false;
  }

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
  // The same spend counts against the table, whoever it was billed to.
  _table[bucketName].push(now);
  if (limit.serialize) rec.inFlight = true;
  return true;
}

/**
 * What the table has spent, for a GM who wants to look.
 * `game.modules.get("ace-engine").api.spendStatus?.()` if it is wired up.
 */
export function spendStatus(now = Date.now()) {
  const out = {};
  for (const [bucket, cap] of Object.entries(TABLE_CEILING)) {
    const used = _table[bucket].filter(t => now - t < cap.windowMs).length;
    out[bucket] = { used, ceiling: cap.max, windowMinutes: cap.windowMs / 60000 };
  }
  return out;
}

/** Release the slot. Safe to call twice; safe to call for an unknown user. */
export function doneSpending(user) {
  const perUser = user?.id ? _spend.get(user.id) : null;
  if (!perUser) return;
  for (const rec of Object.values(perUser)) rec.inFlight = false;
}

// ═══ ⚠️🔴 WHAT IS STILL NOT SOLVED: WHO IS ASKING ══════════════════════
//
// The ceiling above stops the bill running away. It does NOT make the per-user
// budgets honest, because they still trust a `userId` the sender wrote. A client
// can still spend another player's share.
//
// There is exactly one sound way to learn who really sent something in Foundry,
// and it is not the socket: make them WRITE A DOCUMENT. The server enforces
// permissions on document updates and then hands every client a `userId` that IT
// determined, not one the payload claimed:
//
//     // player side - they may only ever update their OWN user
//     await game.user.setFlag(MODULE_ID, "aiRequest", payload);
//
//     // GM side - `userId` here comes from the server, not from the payload
//     Hooks.on("updateUser", (user, changes, options, userId) => {
//       const req = changes?.flags?.[MODULE_ID]?.aiRequest;
//       if (!req) return;
//       const asker = game.users.get(userId);   // TRUSTWORTHY
//       ...
//     });
//
// ⚠️ AND THE ONE TRAP IN IT: read the `userId` ARGUMENT, never
// `user.id` and never anything inside `changes`. `user` is whose document was
// edited, which a GM could edit on somebody's behalf; the fourth argument is who
// actually did the editing. Getting that backwards reintroduces the whole bug
// while looking like a fix.
//
// That is a refactor of every relay, not a patch, which is why it is written
// down here rather than half-done.
