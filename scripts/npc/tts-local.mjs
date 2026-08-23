// ─── Local / self-hosted speech, and the reason it usually breaks ────────────
//
// ⚠️🔴 THE FAILURE THIS FILE EXISTS TO PREVENT. Johnny, 2026-08-23: "I don't
// want some guy that bought ACE Engine to set up his game, get everything
// working, get the voice provider picked, and then it works on his machine but
// doesn't work when the clients connect."
//
// That is not a hypothetical. It is the DEFAULT outcome of naively pointing a
// Foundry module at a local speech server, for two reasons that both fail
// silently:
//
//   1. "localhost" MEANS A DIFFERENT MACHINE ON EVERY CLIENT. The GM sets
//      http://localhost:8080 and it works perfectly in his window, because the
//      server is on his machine. A player's browser resolves that to the
//      PLAYER'S machine, where there is nothing — or worse, something else
//      entirely listening on that port.
//
//   2. AN HTTPS PAGE CANNOT FETCH A PLAIN-HTTP LAN ADDRESS. Browsers treat
//      localhost and 127.0.0.1 as trustworthy and allow them even from an https
//      page. A LAN address like http://192.168.1.50:8080 is NOT trustworthy and
//      is blocked as mixed content — with a console message and NO exception
//      the page can catch usefully. So the GM "fixes" the localhost problem by
//      switching to his LAN IP, it still works for him (he is on http, or he is
//      the origin), and it silently dies for every player on an https-served
//      world. That is precisely the "works on his machine" bug, and it is
//      almost impossible to diagnose from the table.
//
// So this module never ASSUMES a client can reach the server. It PROVES it,
// per client, and anything that cannot reach it is routed through the GM relay
// that already carries ElevenLabs audio — the audio is broadcast as bytes, so
// a player never needs to reach the server at all.
//
// ⚠️ AND THE GM CAN CHECK EVERY CONNECTED CLIENT BEFORE THE SESSION, not after
// somebody says "I can't hear anything". See checkEveryClient() below.
const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | TTS local";

/** How long a client waits for the server before calling it unreachable. */
const PROBE_TIMEOUT_MS = 4000;
const SPEAK_TIMEOUT_MS = 45000;

let _probeCache = null;     // { ok, reason, url, at }

export function localServerUrl() {
    try { return String(game.settings.get(MODULE_ID, "localTtsUrl") || "").trim().replace(/\/+$/, ""); }
    catch (_) { return ""; }
}

/**
 * Can THIS browser, on THIS page, legally reach that URL at all?
 *
 * ⚠️ THIS CHECK RUNS BEFORE ANY NETWORK CALL, because a mixed-content block is
 * not a network error. The fetch rejects with a generic TypeError that reads
 * exactly like "server is down", and a GM chasing a dead server will never find
 * the real cause. Naming it here is the difference between a five-minute fix
 * and an evening lost.
 */
export function reachabilityVerdict(url) {
    if (!url) return { ok: false, code: "nourl", reason: "no local speech server address is set" };

    let parsed;
    try { parsed = new URL(url); }
    catch (_) { return { ok: false, code: "badurl", reason: `"${url}" is not a valid address` }; }

    const pageIsHttps = location.protocol === "https:";
    const targetIsHttp = parsed.protocol === "http:";
    const host = parsed.hostname.toLowerCase();
    // Browsers treat these as trustworthy origins and allow them from an https
    // page. Everything else on plain http is blocked.
    const trustworthy = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");

    if (pageIsHttps && targetIsHttp && !trustworthy) {
        return {
            ok: false, code: "mixed",
            reason: `this world is served over HTTPS, and browsers block a plain http:// address like ${parsed.host}. `
                  + `Use https:// for the speech server, or leave this client on the GM relay.`,
        };
    }

    // ⚠️ "localhost" IS NOT WRONG — IT IS RIGHT FOR EXACTLY ONE MACHINE. Said
    // plainly, because the natural fix (switch to a LAN IP) walks straight into
    // the mixed-content wall above.
    if (trustworthy && !game.user?.isGM) {
        return {
            ok: false, code: "localhost-elsewhere",
            reason: `${parsed.host} means THIS computer, not the GM's. This client will use the GM relay instead, which is correct.`,
        };
    }

    return { ok: true, code: "ok", reason: "" };
}

/**
 * Is the server actually answering, on this client, right now?
 *
 * Cached per session per URL: a probe on every spoken line would add a round
 * trip to every sentence. Cleared whenever the address changes.
 */
export async function probe({ force = false } = {}) {
    const url = localServerUrl();
    if (_probeCache && !force && _probeCache.url === url) return _probeCache;

    const verdict = reachabilityVerdict(url);
    if (!verdict.ok) {
        _probeCache = { ...verdict, url, at: Date.now() };
        return _probeCache;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        // ⚠️ DIFFERENT SERVERS ANNOUNCE THEMSELVES DIFFERENTLY, and a probe that
        // only knows one path calls a perfectly healthy server dead. An
        // OpenAI-compatible server has /v1/models; the reference server and most
        // hand-rolled ones have /health; some have only a root page. Any answer
        // at all proves what the probe is actually asking — CAN THIS CLIENT
        // REACH IT — which is the whole question. Whether it can speak is
        // established by the first real request.
        let res = null;
        let lastStatus = 0;
        for (const path of ["/health", "/v1/models", "/"]) {
            try {
                const r = await fetch(`${url}${path}`, { method: "GET", signal: controller.signal });
                lastStatus = r.status;
                if (r.ok) { res = r; break; }
            } catch (inner) {
                // A transport failure on the FIRST path is the real answer;
                // rethrow so the caller reports "unreachable" rather than a
                // misleading 404 from a path that was never going to exist.
                if (path === "/health") throw inner;
            }
        }
        clearTimeout(timer);

        if (!res) {
            _probeCache = { ok: false, code: "status",
                            reason: `the speech server is answering (${lastStatus || "no status"}) but has no /health or /v1/models endpoint`,
                            url, at: Date.now() };
            return _probeCache;
        }
        let info = null;
        try { info = await res.json(); } catch (_) { /* a bare 200 is still alive */ }
        _probeCache = { ok: true, code: "ok", reason: "", url, at: Date.now(), info };
        return _probeCache;
    } catch (err) {
        clearTimeout(timer);
        // ⚠️ NAME THE TWO CAUSES SEPARATELY. "Failed to fetch" covers both a
        // dead server and a blocked request, and telling a GM the wrong one
        // sends them to fix the wrong thing.
        const aborted = err?.name === "AbortError";
        _probeCache = {
            ok: false, code: aborted ? "timeout" : "unreachable",
            reason: aborted
                ? `the speech server at ${url} did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds`
                : `nothing answered at ${url} — the server may not be running, or the browser blocked the request`,
            url, at: Date.now(),
        };
        return _probeCache;
    }
}

/** Forget the cached probe, e.g. after the address is changed in settings. */
export function forgetProbe() { _probeCache = null; }

/**
 * Turn text into audio bytes using the local server.
 *
 * Returns the same shape the ElevenLabs path returns, so the player, the
 * broadcast, the pitch handling and the GM relay are all untouched. The whole
 * point of the existing design is that everything past this point is
 * provider-agnostic; nothing downstream should learn a new shape.
 *
 * @returns {Promise<{status: string, arrayBuffer?: ArrayBuffer, detail?: string}>}
 */
// ⚠️🔴 SPEAK THE PROTOCOL THE SERVERS ALREADY SPEAK (researched 2026-08-23).
//
// I first designed a bespoke POST /speak for this. That was a mistake, and the
// research is what caught it: the ready-made self-hosted servers for the models
// worth using — Chatterbox, Kokoro and the rest — all expose an OPENAI-COMPATIBLE
// TTS endpoint, because that shape has become the de facto standard for local
// speech. A custom protocol would have meant every customer writing glue before
// ACE could say a word.
//
// So the OpenAI shape is tried FIRST and the simple one is the fallback. A GM can
// point ACE at an off-the-shelf server and it works with nothing in between; the
// reference server in tools/local-tts-server still works too.
//
// Which one answered is remembered for the session so it costs one extra request,
// once, and never again.
let _dialect = null;   // "openai" | "simple"

const DIALECTS = {
    openai: {
        path: "/v1/audio/speech",
        body: (text, voice, s) => ({
            // `model` is required by the shape and ignored by most local
            // servers, which serve whatever they have loaded.
            model: "tts-1",
            input: text,
            voice: voice || "alloy",
            response_format: "mp3",
            speed: s.speed ?? 1.0,
        }),
    },
    simple: {
        path: "/speak",
        body: (text, voice, s) => ({
            text,
            voice: voice || "",
            speed:     s.speed     ?? 1.0,
            stability: s.stability ?? undefined,
            style:     s.style     ?? undefined,
        }),
    },
};

async function _post(url, dialect, text, voice, settings, signal) {
    const spec = DIALECTS[dialect];
    return fetch(`${url}${spec.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "audio/mpeg, audio/wav, */*" },
        signal,
        body: JSON.stringify(spec.body(text, voice, settings)),
    });
}

export async function synthesize(text, voiceId, voiceSettings = {}) {
    const url = localServerUrl();
    const ready = await probe();
    if (!ready.ok) return { status: "error", detail: ready.reason };

    // ── ⚠️🔴 TRANSLATE THE VOICE HERE, AND ONLY HERE ─────────────────────
    //
    // Every NPC in an existing world carries an ElevenLabs voice id, and it
    // means nothing to a local engine. Six different files read that id and pass
    // it along; changing all six would be six chances to miss one, and the one
    // missed would go silent with no error. This function is the single point
    // every local synthesis passes through — the GM relay for players comes
    // through here too — so the translation belongs here and nowhere else.
    //
    // ⚠️ THE ORIGINAL ID IS NEVER MODIFIED. Nothing is written to any actor.
    // The ElevenLabs id stays on the creature, and switching the provider back
    // restores every voice instantly because none of them ever moved.
    let localVoice = voiceId;
    try {
        const { localVoiceFor } = await import("./voice-map.mjs");
        localVoice = localVoiceFor(voiceId, voiceSettings.gender || "");
    } catch (err) {
        console.warn(`${TAG} | Voice map unavailable, passing the id through unchanged:`, err);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SPEAK_TIMEOUT_MS);
    try {
        // Known dialect first; otherwise try OpenAI, then the simple one.
        const order = _dialect ? [_dialect] : ["openai", "simple"];
        let res = null;
        let lastDetail = "";

        for (const dialect of order) {
            res = await _post(url, dialect, text, localVoice, voiceSettings, controller.signal);
            if (res.ok) {
                if (_dialect !== dialect) {
                    _dialect = dialect;
                    console.log(`${TAG} | The speech server speaks the ${dialect === "openai" ? "OpenAI-compatible" : "simple"} protocol.`);
                }
                break;
            }
            // ⚠️ ONLY "THIS PATH DOES NOT EXIST" JUSTIFIES TRYING THE OTHER ONE.
            // A 500 means the right endpoint failed, and retrying a different
            // shape would bury the real error under a second, misleading one.
            if (res.status !== 404 && res.status !== 405) break;
            lastDetail = `no ${DIALECTS[dialect].path} endpoint`;
            res = null;
        }
        clearTimeout(timer);

        if (!res) {
            return { status: "error",
                     detail: `the speech server has neither /v1/audio/speech nor /speak (${lastDetail})` };
        }
        if (!res.ok) {
            let detail = `the speech server answered ${res.status}`;
            try {
                const body = await res.text();
                if (body) detail += ` — ${body.slice(0, 200)}`;
            } catch (_) { /* body unreadable; the status is enough */ }
            return { status: "error", detail };
        }

        const arrayBuffer = await res.arrayBuffer();
        if (!arrayBuffer?.byteLength) {
            return { status: "error", detail: "the speech server returned an empty response" };
        }
        return { status: "ok", arrayBuffer };
    } catch (err) {
        clearTimeout(timer);
        forgetProbe();   // something changed; re-prove it next time
        const aborted = err?.name === "AbortError";
        return {
            status: "error",
            detail: aborted
                ? `the speech server took longer than ${SPEAK_TIMEOUT_MS / 1000} seconds`
                : `the speech request failed: ${err?.message ?? err}`,
        };
    }
}

// ─── The pre-session check ───────────────────────────────────────────────────

/**
 * What this client can and cannot do, in plain words.
 *
 * ⚠️ IT REPORTS THE AUDIO CONTEXT TOO. A browser will not play sound until the
 * user has clicked something on the page. A player who joins and immediately
 * sits still hears nothing, and it looks exactly like a broken voice server.
 * That is a different fault with a different fix ("click anywhere"), so it must
 * not be reported as the same thing.
 */
export async function selfTest() {
    const url = localServerUrl();
    const verdict = await probe({ force: true });

    let audioUnlocked = false;
    try {
        const { ttsEngine } = await import("./tts.mjs");
        audioUnlocked = ttsEngine?.audioContext?.state === "running";
    } catch (_) { /* engine not loaded yet on this client */ }

    return {
        userId:   game.user?.id ?? "",
        userName: game.user?.name ?? "unknown",
        isGM:     !!game.user?.isGM,
        pageProtocol: location.protocol,
        serverUrl: url,
        canReachServer: verdict.ok,
        reachReason: verdict.reason,
        reachCode: verdict.code,
        audioUnlocked,
        // What this client will ACTUALLY do when an NPC speaks. This is the line
        // that matters, and it is computed the same way speak() computes it.
        willUse: verdict.ok ? "generates locally"
               : (game.users?.some?.(u => u.isGM && u.active) ? "plays audio relayed from the GM" : "NOTHING — no GM is connected to relay it"),
    };
}

/**
 * Ask every connected client to self-test and report back.
 *
 * ⚠️ THIS IS THE ANSWER TO "IT WORKS ON MY MACHINE". Run it before a session
 * and the GM sees, per person, whether they will hear voices and why not. It
 * costs one socket round trip and it converts the single most expensive class
 * of support problem into a table.
 *
 * @param {number} waitMs how long to collect replies
 */
export async function checkEveryClient(waitMs = 4000) {
    if (!game.user?.isGM) {
        ui.notifications?.warn("Only the GM can check every client.");
        return [];
    }

    const requestId = foundry.utils.randomID();
    const reports = new Map();

    // ⚠️ THE GM COUNTS AS A CLIENT. A check that silently excludes the machine
    // running the server would pass while the GM's own audio was broken.
    reports.set(game.user.id, await selfTest());

    const listener = (data) => {
        if (data?.action !== "ttsReadinessReport" || data.requestId !== requestId) return;
        if (data.report?.userId) reports.set(data.report.userId, data.report);
    };
    game.socket.on(`module.${MODULE_ID}`, listener);
    game.socket.emit(`module.${MODULE_ID}`, { action: "ttsReadinessRequest", requestId });

    await new Promise(r => setTimeout(r, waitMs));
    game.socket.off(`module.${MODULE_ID}`, listener);

    // ⚠️ A CLIENT THAT NEVER ANSWERED IS A RESULT, NOT AN ABSENCE. Silence
    // usually means an old version of the module or a client that is wedged,
    // and reporting only the ones that replied would quietly show a clean sheet.
    const rows = [];
    for (const user of (game.users ?? [])) {
        if (!user.active) continue;
        const report = reports.get(user.id);
        rows.push(report ?? {
            userId: user.id, userName: user.name, isGM: user.isGM,
            canReachServer: false, audioUnlocked: false,
            reachReason: "this client did not answer — it may be running an older ACE Engine, or its window is asleep",
            reachCode: "noreply",
            willUse: "unknown",
        });
    }

    console.log(`${TAG} | Readiness across ${rows.length} connected client(s):`);
    for (const r of rows) {
        console.log(`   ${r.isGM ? "GM " : "   "}${String(r.userName).padEnd(18)} ${r.willUse}`
            + (r.reachReason ? `  (${r.reachReason})` : "")
            + (r.audioUnlocked ? "" : "  ⚠️ audio not unlocked — this client must click the page once"));
    }
    return rows;
}

/**
 * Answer a readiness request from the GM. Every client runs this.
 */
export function installReadinessResponder() {
    game.socket.on(`module.${MODULE_ID}`, async (data) => {
        if (data?.action !== "ttsReadinessRequest" || !data.requestId) return;
        // ⚠️ The GM's own row is filled in directly by checkEveryClient, so
        // answering here as well would just duplicate it.
        if (game.user?.isGM) return;
        try {
            const report = await selfTest();
            game.socket.emit(`module.${MODULE_ID}`, {
                action: "ttsReadinessReport", requestId: data.requestId, report,
            });
        } catch (err) {
            console.warn(`${TAG} | Could not answer the readiness check:`, err);
        }
    });
    console.log(`${TAG} | Ready to answer the GM's voice readiness check.`);
}
