// ─── ACE Engine — one place for every name Foundry 14 changes ─────────────────────
//
// His rule, 2026-10-14: "Start making ACE load on Foundry 13 and 14... Each of
// these keeps working on 13 and uses the 14 name when that name exists."
//
// ACE Engine runs without ACE QOL, so it carries its own copy of the helpers it
// needs, the same as ACE QOL's scripts/foundry-compat.mjs, which holds all four
// (chat, regions, who sees a message, deleting a key). This module only renders
// chat cards today, so only that one is here; another comes over, unchanged,
// the day this module first needs it.
//
// ⚠️ Imports nothing on purpose: the entry file imports the files that import
// this, and a cycle read at load kills the whole module (2026-09-06).
// ──────────────────────────────────────────────────────────────────────────────

const TAG = "ace-engine | Foundry 13/14";

let _saidUnreadable = false;

/**
 * Register a chat-card render listener on the hook this Foundry fires.
 *
 * Foundry 13 and 14 fire `renderChatMessageHTML` with an HTMLElement. Foundry 13
 * ALSO fires the deprecated `renderChatMessage` (with jQuery) whenever anything
 * listens to it, so registering both runs every listener twice. One hook, picked
 * by the generation. The listener is always handed an HTMLElement, whichever hook
 * fired, so no listener has to handle jQuery.
 *
 * Call it at init or later: before init Foundry has not said which version it is.
 *
 * @param {(message: ChatMessage, element: HTMLElement, context?: object) => void} handler
 * @returns {{hook: string, id: number}|null}
 */
export function onRenderChatMessage(handler) {
  if (typeof handler !== "function") {
    console.warn(`${TAG} | a chat render listener was registered with no function; nothing registered.`);
    return null;
  }
  const hook = chatRenderHook();
  const id = Hooks.on(hook, (message, html, ...rest) => handler(message, html?.jquery ? html[0] : html, ...rest));
  return { hook, id };
}

/** The chat-card render hook this Foundry fires, for anything that has to name it. */
export function chatRenderHook() {
  // The generation, not `isNewerVersion(game.version, "13")`: that comparison is
  // false on a 13.0 and would pick the old name on the very version it guards.
  const generation = game?.release?.generation ?? parseInt(game?.version) ?? 0;
  if (!Number.isFinite(generation) && !_saidUnreadable) {
    _saidUnreadable = true;
    console.warn(`${TAG} | could not read Foundry's generation, so chat listeners are on `
      + `the old renderChatMessage hook.`);
  }
  return generation >= 13 ? "renderChatMessageHTML" : "renderChatMessage";
}
