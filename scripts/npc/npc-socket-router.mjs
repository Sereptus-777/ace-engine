// ─── ACE: Engine — the NPC socket messages nobody was listening to ──────────
//
// Found 2026-08-06 by auditing every `socket.emit` against every handler in the
// suite. Five NPC-chat messages had been broadcast for months with no receiver
// anywhere. Emitting into the void is not an error and logs nothing, so each of
// these failed in total silence:
//
//   pauseAudio       a player pauses; nobody else's audio pauses
//   stopAudio        a GM stops a conversation; the player keeps hearing it
//   browserTTS       browser-voice speech never reaches the other clients
//   ollamaRequest    ⚠ a PLAYER on a local-AI world gets NO reply at all
//   summarizeSession a player closing a chat never gets it summarised
//
// The Ollama one is the serious one. A player's browser cannot reach the GM's
// localhost:11434, so the code correctly proxies the request to the GM — and
// the GM never answered, because no handler existed. The player's conversation
// simply hung until it timed out. Anyone running Ollama or LM Studio (which is
// Johnny's own stack) had a table where players could not talk to NPCs at all.
//
// ⚠️ ONE GM ANSWERS. Every request-style handler is gated on
// game.users.activeGM — with two GMs connected, both would answer and the
// player would get duplicate replies, duplicate summaries, duplicate audio.
// This is the same single-owner gate the rest of the engine uses for writes.

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Socket";

let _wired = false;

/** True when THIS client is the one GM that answers proxied requests. */
function _isAnsweringGM() {
    try { return game.users?.activeGM === game.user; }
    catch (_) { return !!game.user?.isGM; }
}

/**
 * Authorise a payload that claims to be acting for a player.
 *
 * ⚠️ Foundry attaches NO trusted sender to a module socket, so `userId` is
 * written by whoever sent the message. This establishes only that the claim
 * names a real, connected, NON-GM user — a GM never asks over the socket
 * because a GM does the work locally, so a GM claim is always forged.
 */
function _claimingPlayer(data, label) {
    const id = data?.userId ?? data?.senderId;
    const user = id ? game.users?.get?.(id) : null;
    if (!user)          { console.warn(`${TAG} | ${label} REFUSED — names no real user.`);            return null; }
    if (user.isGM)      { console.warn(`${TAG} | ${label} REFUSED — claims GM "${user.name}".`);      return null; }
    if (!user.active)   { console.warn(`${TAG} | ${label} REFUSED — "${user.name}" is offline.`);     return null; }
    return user;
}

/**
 * Spend limiter for anything that costs the GM money.
 *
 * ⚠️ THIS IS A BILL, NOT JUST A PERMISSION. Relaying AI calls through the GM
 * is the only safe place for the credential, but it also means a player's
 * client decides when the GM's card gets charged. Without a ceiling, a script
 * in a player's console could run the GM's balance to zero in a minute.
 *
 * One in flight per player (a human is waiting on a reply before typing the
 * next line anyway) and 20 per five minutes, which is far above real roleplay
 * and far below abuse.
 */
const _aiSpend = new Map();   // userId -> { inFlight: boolean, stamps: number[] }
const AI_WINDOW_MS = 300_000;
const AI_MAX_PER_WINDOW = 20;

function _maySpendOnAI(user, now) {
    const rec = _aiSpend.get(user.id) ?? { inFlight: false, stamps: [] };
    _aiSpend.set(user.id, rec);
    if (rec.inFlight) {
        console.warn(`${TAG} | AI relay REFUSED — "${user.name}" already has a request in flight.`);
        return false;
    }
    rec.stamps = rec.stamps.filter(t => now - t < AI_WINDOW_MS);
    if (rec.stamps.length >= AI_MAX_PER_WINDOW) {
        console.warn(`${TAG} | AI relay REFUSED — "${user.name}" hit ${AI_MAX_PER_WINDOW} requests in ` +
            `${AI_WINDOW_MS / 60000} minutes. Ignoring until the window clears.`);
        return false;
    }
    rec.stamps.push(now);
    rec.inFlight = true;
    return true;
}

function _doneSpending(user) {
    const rec = _aiSpend.get(user.id);
    if (rec) rec.inFlight = false;
}

/** Is this message addressed to someone else? */
function _notForMe(data) {
    if (data?.exclude && data.exclude === game.user.id) return true;
    if (data?.targetUserId && data.targetUserId !== game.user.id) return true;
    return false;
}

export function wireNpcSocketRouter() {
    if (_wired || !game?.socket) return;
    _wired = true;

    game.socket.on(`module.${MODULE_ID}`, async (data) => {
        const action = data?.action;
        if (!action) return;

        try {
            switch (action) {

                // ── Someone paused or resumed. Follow them. ──────────────
                case "pauseAudio": {
                    if (_notForMe(data) || data.senderId === game.user.id) return;
                    const { ttsEngine } = await import("./tts.mjs");
                    if (data.paused) ttsEngine.pause();
                    else             ttsEngine.resume();
                    return;
                }

                // ── Stop everything. Usually a GM ending a conversation. ──
                // ⚠️ THIS ONLY STOPPED ONE OF SIX THINGS (2026-08-07).
                // It called `ttsEngine.stop()` and nothing else — so the
                // NARRATOR's audio (a bare `new Audio()` that never enters the
                // DOM), a browser speechSynthesis utterance already queued,
                // Sequencer sounds and anything playing through Foundry's own
                // audio helper all carried on. The engine reported itself
                // stopped while the room kept talking, which is exactly why
                // Johnny said "I have a big red button that's supposed to stop
                // narration in its tracks — I doubt it works."
                // ConversationApp.silenceEverything goes after every route.
                case "stopAudio": {
                    if (_notForMe(data)) return;
                    const { ConversationApp } = await import("./conversation-app.mjs");
                    ConversationApp.silenceEverything("stopAudio socket");
                    return;
                }

                // ── Browser-voice speech, mirrored to the other clients. ──
                case "browserTTS": {
                    if (_notForMe(data) || !data.text) return;
                    const { ttsEngine } = await import("./tts.mjs");
                    // ⚠️ broadcast:false is LOAD-BEARING. _speakBrowser defaults
                    // to re-broadcasting, so a receiving client would emit the
                    // same message straight back out — an endless loop across
                    // every connected browser. (My first draft called a
                    // "speakWithBrowser" that does not exist, which optional
                    // chaining would have turned into a silent no-op: the exact
                    // failure this whole file is here to delete.)
                    await ttsEngine._speakBrowser(data.text, data.pitch ?? 1.0, { broadcast: false });
                    return;
                }

                // ── A player cannot reach the GM's local AI. Answer for it. ──
                // ── A PLAYER WALKED UP TO A NAMELESS CREATURE ────────────
                // Token drops are silent, so a goblin nobody expected the party
                // to talk to has no name, no history and no faction until the
                // moment somebody talks to it. That moment usually happens on a
                // PLAYER's client — and a player cannot create an Actor, write
                // a world setting, or rename anything. Foundry refuses, and
                // rightly so.
                //
                // So the player asks and the GM does it. Same code path as the
                // GM's own client and the quill button — never a second
                // implementation.
                case "ensureIdentity": {
                    if (!_isAnsweringGM()) return;
                    const scene = game.scenes?.get(data.sceneId) ?? canvas.scene;
                    const tokenDoc = scene?.tokens?.get(data.tokenId);
                    if (!tokenDoc) {
                        console.warn(`${TAG} | A player asked for an identity for a token that is not on any scene I can see (${data.tokenId}).`);
                        return;
                    }
                    try {
                        const { giveThisOneALife } = await import("./hud-give-a-life.mjs");
                        console.log(`${TAG} | ${game.users?.get(data.senderId)?.name ?? "A player"} started talking to "${tokenDoc.name}", which is nobody yet — giving it a name and a history.`);
                        await giveThisOneALife(tokenDoc);
                    } catch (err) {
                        console.error(`${TAG} | Could not create an identity on a player's behalf:`, err);
                    }
                    return;
                }

                // ── Run an AI call on a player's behalf. ──────────────
                // The player's client has no API key (keys are GM-only), and
                // must never have one. It sends the CONTENT of the request;
                // this side supplies the credential, the endpoint and the model
                // from the GM's own settings.
                case "aiRequest": {
                    if (!_isAnsweringGM()) return;
                    if (!data.requestId) return;
                    const user = _claimingPlayer(data, "AI relay");
                    if (!user) return;
                    if (!_maySpendOnAI(user, Date.now())) {
                        game.socket.emit(`module.${MODULE_ID}`, {
                            action: "aiResponse", requestId: data.requestId,
                            error: "Too many requests in a row — give it a moment.",
                        });
                        return;
                    }
                    let payload;
                    try {
                        const { AIHandler, resolveChatProvider } = await import("./conversation-engine.mjs");
                        // ⚠️ PROVIDER, KEY, URL AND MODEL COME FROM HERE, NEVER
                        // FROM THE PAYLOAD. A player-chosen url would aim the
                        // GM's credential at a server of the player's choosing.
                        // This is the same resolution getResponse does locally,
                        // called rather than re-implemented, so the two cannot
                        // drift apart.
                        const cfg = resolveChatProvider();
                        const text = await AIHandler.callAI(
                            String(data.systemPrompt ?? ""),
                            Array.isArray(data.history) ? data.history : [],
                            String(data.input ?? ""),
                            cfg.provider,
                            cfg.apiKey,
                            Array.isArray(data.images) ? data.images : [],
                            {
                                modelOverride: cfg.modelName,
                                urlOverride:   cfg.apiUrl,
                                context:   typeof data.context === "string" ? data.context : "npc-chat",
                                // Re-capped here: the payload asked, it did not decide.
                                maxTokens: Math.min(Number(data.maxTokens) || 0, 4000) || undefined,
                            }
                        );
                        payload = { action: "aiResponse", requestId: data.requestId, text };
                    } catch (err) {
                        // The player is WAITING. Silence reads as a hung module.
                        console.warn(`${TAG} | AI relay failed for ${user.name}:`, err?.message ?? err);
                        payload = { action: "aiResponse", requestId: data.requestId,
                                    error: String(err?.message ?? err) };
                    } finally {
                        _doneSpending(user);
                    }
                    game.socket.emit(`module.${MODULE_ID}`, payload);
                    return;
                }

                case "ollamaRequest": {
                    if (!_isAnsweringGM()) return;
                    if (!data.requestId || !Array.isArray(data.messages)) return;
                    const { AIHandler } = await import("./conversation-engine.mjs");
                    let payload;
                    try {
                        const text = await AIHandler._fetchOllama(data.messages, data.images ?? []);
                        payload = { action: "ollamaResponse", requestId: data.requestId, text };
                    } catch (err) {
                        // The player is WAITING on this. An error reply is far
                        // better than silence — silence is what it did before,
                        // and the conversation hung until it timed out.
                        console.warn(`${TAG} | Local-AI proxy failed for a player:`, err?.message ?? err);
                        payload = { action: "ollamaResponse", requestId: data.requestId,
                                    error: String(err?.message ?? err) };
                    }
                    game.socket.emit(`module.${MODULE_ID}`, payload);
                    return;
                }

                // ── Summarise a conversation a player just closed. ────────
                case "summarizeSession": {
                    if (!_isAnsweringGM()) return;
                    const actor = game.actors.get(data.actorId);
                    if (!actor || !data.history?.length) return;
                    const { summarizeAndSaveSession } = await import("./memory.mjs");
                    await summarizeAndSaveSession(actor, data.history, data.playerName);
                    console.log(`${TAG} | Summarised a player's conversation with ${actor.name}.`);
                    return;
                }
            }
        } catch (err) {
            // Never let one bad message kill the listener for every other one.
            console.error(`${TAG} | handler for "${action}" threw:`, err);
        }
    });

    console.log(`${TAG} | NPC socket router online — pauseAudio, stopAudio, browserTTS, ollamaRequest, summarizeSession.`);
}
