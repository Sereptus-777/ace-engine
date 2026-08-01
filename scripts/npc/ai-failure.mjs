// ─── ACE: Engine — AI Failure Policy ──────────────────────────────────────
//
// ONE place that turns any AI-provider failure into (a) a quiet, GM-only,
// plain-English notice and (b) a safe signal so that NO raw error text ever
// reaches an NPC's spoken or displayed line.
//
// Root cause 2026-07-23: the NPC chat handler (conversation-engine.mjs
// `AIHandler.callAI`) returned raw provider error strings — e.g.
// "Incorrect API key provided…", "You exceeded your current quota…" — as the
// NPC's reply. That reply was then rendered in the window, broadcast to every
// player, posted to public chat, AND spoken via ElevenLabs. A paying customer
// would watch their NPC "speak" a billing error out loud. Never again.
//
// Design: callAI returns AI_FAILED_REPLY (a distinctive sentinel STRING, not a
// Symbol) on any hard failure. A string is deliberate — every consumer of
// callAI (bio-generator, faction-registry, memory, conversation) can compare
// it by equality, and if any site is ever missed the value still flows through
// String ops (.replace/.trim) without throwing. The speaking path checks for
// it and suppresses TTS + chat + broadcast; the generator paths bail cleanly.

import { MODULE_ID } from "../ace-engine.mjs";

/**
 * Sentinel returned by callAI on a hard failure. Callers compare by strict
 * equality via isAIFailure(). Kept distinctive so it can't collide with real
 * model output, yet harmless if it ever slipped through to display.
 */
export const AI_FAILED_REPLY = "__ACE_AI_FAILED__";

/** True when a callAI result represents a hard failure (never speak/persist it). */
export function isAIFailure(result) {
  return result === AI_FAILED_REPLY;
}

/** Map a raw provider id to a short, human name for GM-facing notices. */
function providerLabel(provider) {
  switch (String(provider || "").toLowerCase()) {
    case "anthropic":  return "Anthropic (Claude)";
    case "openai":     return "OpenAI";
    case "openrouter": return "OpenRouter";
    case "lmstudio":
    case "lm-studio":  return "LM Studio";
    case "ollama":     return "Ollama";
    case "custom":     return "your AI server";
    default:           return provider ? String(provider) : "the AI provider";
  }
}

/**
 * Turn an HTTP status (+ optional provider body text) into a short, plain-English,
 * GM-facing sentence. No stack traces, no JSON blobs — just "what's wrong and
 * where to fix it."
 */
/**
 * Pull the provider's own human-readable explanation out of an error body.
 * Every major provider nests it as {error:{message}} or {message}; some just
 * return prose. Returns "" when nothing useful can be found.
 */
function extractProviderMessage(rawBody) {
  const raw = String(rawBody ?? "").trim();
  if (!raw) return "";
  try {
    const j = JSON.parse(raw);
    const msg = j?.error?.message ?? j?.message ?? j?.error?.metadata?.raw ?? j?.detail;
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 200);
  } catch (_) { /* not JSON — fall through to the raw text */ }
  // Plain-text body: keep it short and single-line.
  return raw.replace(/\s+/g, " ").slice(0, 200);
}

export function friendlyAIError(status, provider = "the AI provider", rawBody = "") {
  const p = providerLabel(provider);
  const body = String(rawBody || "").toLowerCase();
  const detail = extractProviderMessage(rawBody);
  switch (Number(status)) {
    case 400: {
      // 400 = the provider rejected the request itself. Its own message is far
      // more useful than anything we could guess, so lead with it. The most
      // common cause by a mile is a model name the provider doesn't recognise
      // — OpenRouter in particular requires the full "vendor/model" slug.
      const looksLikeModel = /model/.test(body) || !detail;
      const hint = looksLikeModel && /openrouter/i.test(String(provider))
        ? ` OpenRouter needs the full model name including the vendor, e.g. "openai/gpt-4o-mini" rather than just "gpt-4o-mini". Check the model in AI Setup.`
        : ` Check the model name in AI Setup.`;
      return detail
        ? `${p} rejected the request: "${detail}".${hint}`
        : `${p} rejected the request (error 400).${hint}`;
    }
    case 401:
    case 403:
      return `${p}: the API key was rejected. Open ACE Engine → AI Setup and re-check the key.`;
    case 402:
      return `${p}: the account is out of credit. Add funds, or switch to a free local model (Ollama).`;
    case 404:
      return `${p}: that model name wasn't found. Pick a valid model in AI Setup.`;
    case 429:
      return `${p}: rate-limited (too many requests). Wait a moment, or switch to a local model.`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `${p}: the service is having trouble right now. Try again in a moment.`;
    default: {
      // No/odd status — try to read intent from the provider's error body.
      if (/no.*(api.?)?key|key.*(not set|missing|blank|empty|unset)|missing.*key/.test(body))
        return `${p}: no API key is set. Add one in ACE Engine → AI Setup.`;
      if (/insufficient|credit|quota|billing|exceeded your current/.test(body))
        return `${p}: the account is out of credit or quota. Add funds, or use a free local model (Ollama).`;
      if (/invalid.*key|api.?key|unauthorized|authentication/.test(body))
        return `${p}: the API key looks invalid. Re-check it in AI Setup.`;
      if (/model/.test(body) && /not.*(found|exist)|does not exist|unknown/.test(body))
        return `${p}: that model name wasn't found. Pick a valid model in AI Setup.`;
      if (/rate.?limit|too many requests|overloaded/.test(body))
        return `${p}: rate-limited. Wait a moment, or switch to a local model.`;
      if (/tim(e|ed).?out|aborted|the operation was aborted/.test(body))
        return `${p}: took too long to respond and timed out. Try again, or switch to a faster/local model.`;
      if (/failed to fetch|networkerror|network error|cors|connection|econnrefused|refused/.test(body))
        return `${p}: couldn't be reached. Check it's running and that the URL in AI Setup is correct.`;
      // Nothing matched — surface the provider's own words rather than a
      // generic shrug. "the AI request failed" tells the GM nothing they can
      // act on, which defeats the whole point of this policy.
      return detail
        ? `${p}: ${detail}${status ? ` (error ${status})` : ""}. Check ACE Engine → AI Setup.`
        : `${p}: the AI request failed${status ? ` (error ${status})` : ""}. Check ACE Engine → AI Setup.`;
    }
  }
}

// De-dupe window so a burst of identical failures shows ONE toast, not ten.
let _lastNotice = { msg: "", at: 0 };

/**
 * Surface an AI failure the safe way and return the AI_FAILED_REPLY sentinel.
 *   • Console: full detail (safe place for the raw text — never player-visible).
 *   • GM only: one friendly, de-duplicated toast. Players never see it — they
 *     get the silent "no response" beat from the caller instead.
 *
 * @param {object} opts
 * @param {string} [opts.provider]  raw provider id (anthropic/openai/…)
 * @param {number} [opts.status]    HTTP status if known
 * @param {string} [opts.rawBody]   provider error body/message (for the console + hint matching)
 * @param {Error}  [opts.error]     caught exception, if any
 * @param {string} [opts.context]   short tag for the console line (e.g. "npc-chat")
 * @returns {string} AI_FAILED_REPLY
 */
/** Turn an internal context tag into something a GM recognises. */
function featureLabel(context) {
  switch (String(context || "")) {
    case "npc-chat":          return "NPC chat";
    case "bio-generator":     return "NPC bio generation";
    case "scene-notes":       return "scene notes";
    case "item-descriptions": return "item descriptions";
    case "loot-generation":   return "loot generation";
    case "faction-naming":    return "faction naming";
    case "session-summary":   return "session summary";
    default:                  return "";
  }
}

export function surfaceAIFailure({ provider = "", status = 0, rawBody = "", error = null, context = "" } = {}) {
  const detail   = rawBody || error?.message || "";
  const friendly = friendlyAIError(status, provider, detail);
  // Name the FEATURE that failed. Without this a bio failure on token-drop
  // reads as an NPC-chat failure and you go hunting in the wrong subsystem —
  // which is exactly what happened live on 2026-07-24.
  const feature  = featureLabel(context);

  // Full detail to console for debugging — this is the ONLY place the raw
  // provider text is allowed to land.
  console.warn(
    `${MODULE_ID} | AI failure${context ? ` [${context}]` : ""}: ${friendly}`,
    { status, body: String(detail).slice(0, 400), error }
  );

  // GM-only, de-duplicated toast.
  try {
    if (game.user?.isGM && ui?.notifications) {
      const now = Date.now();
      // Dedupe on feature+message, not message alone — otherwise a bio failure
      // and a chat failure with the same cause inside 8s show only ONE toast,
      // and you never learn the second feature is broken too.
      const dedupeKey = `${feature}|${friendly}`;
      if (dedupeKey !== _lastNotice.msg || (now - _lastNotice.at) > 8000) {
        ui.notifications.warn(`ACE Engine${feature ? ` (${feature})` : ""} — ${friendly}`);
        _lastNotice = { msg: dedupeKey, at: now };
      }
    }
  } catch (_) { /* notifications not ready — console line above still fired */ }

  return AI_FAILED_REPLY;
}
