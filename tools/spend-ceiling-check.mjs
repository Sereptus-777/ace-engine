// ─── Can a forged user id still run up the GM's bill? ────────────────────────
//
// ⚠️ THE ATTACK THIS SIMULATES. Foundry gives no trusted sender on a socket, so
// the `userId` in a relay payload is whatever the sender typed. `_claimingPlayer`
// checks only that the id names a real, active, non-GM user — which proves the
// caller knows somebody else's name, and nothing more.
//
// A client that rotates through every connected player's id gets one full
// per-user budget EACH. With six players at 30 AI requests apiece that is 180
// language-model calls billed to the GM inside five minutes, from one machine.
// External audit, 2026-08-25, and it was correct.
//
// The fix is a table-wide ceiling that never asks who is calling, so rotating
// identities buys nothing. This proves it by actually doing the attack.
//
// Run:  node tools/spend-ceiling-check.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// The module talks to Foundry. Give it just enough of one to run.
globalThis.game = { user: { isGM: false } };
globalThis.ui = { notifications: { warn() {} } };
const realWarn = console.warn;
console.warn = () => {};                       // the module is chatty on refusal

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, "..", "scripts", "npc", "ai-spend-limit.mjs")).href);
console.warn = realWarn;

const { maySpendOnAI, doneSpending, spendStatus } = mod;
if (typeof maySpendOnAI !== "function") {
  console.error("FAIL — maySpendOnAI not exported; fix this extractor rather than deleting it.");
  process.exit(1);
}

const PLAYERS = 6;
const users = Array.from({ length: PLAYERS }, (_, i) => ({ id: `player-${i}`, name: `Player ${i}` }));
const now = Date.now();

function run(what) {
  let granted = 0;
  // The module warns on every refusal, by design — 2000 of them is not a test
  // result, it is noise. Quiet only for the hammering loop.
  const warn = console.warn;
  console.warn = () => {};
  try {
  // The attacker's loop: hammer, rotating the claimed id every request so no
  // single per-user budget is ever the thing that stops them.
  for (let i = 0; i < 2000; i++) {
    const u = users[i % PLAYERS];
    if (maySpendOnAI(u, now, what)) {
      granted++;
      doneSpending(u);                         // pretend the request completed
    }
  }
  } finally { console.warn = warn; }
  return granted;
}

const aiGranted = run("AI");
const ttsGranted = run("tts");

const status = spendStatus(now);
const aiCeiling = status.ai.ceiling;
const ttsCeiling = status.tts.ceiling;
const perUserAI = 30, perUserTTS = 120;        // the documented per-user budgets

console.log(`players impersonated:            ${PLAYERS}`);
console.log(`AI  requests granted:            ${aiGranted}   (ceiling ${aiCeiling})`);
console.log(`TTS requests granted:            ${ttsGranted}   (ceiling ${ttsCeiling})`);
console.log(`\nwithout a ceiling this would be: ${PLAYERS * perUserAI} AI / ${PLAYERS * perUserTTS} TTS`);
console.log(`prevented:                       ${PLAYERS * perUserAI - aiGranted} AI / `
          + `${PLAYERS * perUserTTS - ttsGranted} TTS billable requests`);

let ok = true;
const check = (label, pass) => {
  if (!pass) ok = false;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
};

console.log("");
check("rotating ids cannot exceed the AI ceiling", aiGranted <= aiCeiling);
check("rotating ids cannot exceed the TTS ceiling", ttsGranted <= ttsCeiling);
check("the ceiling actually bites (fewer than the per-user sum)", aiGranted < PLAYERS * perUserAI);
// A ceiling so low that honest play trips it is its own bug.
check("one honest player still gets their full per-user AI budget", aiCeiling >= perUserAI);
check("one honest player still gets their full per-user TTS budget", ttsCeiling >= perUserTTS);

console.log("\n" + (ok
  ? "ALL PASS — a forged id can steal a share, but it cannot enlarge the bill."
  : "FAILURES ABOVE"));
process.exit(ok ? 0 : 1);
