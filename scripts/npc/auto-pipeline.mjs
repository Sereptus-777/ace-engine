// ─── ACE: Engine — Auto-Pipeline on Token Drop ─────────────────────────────
//
// When the `autoGenerateOnDrop` setting is ON, the smart-setup popup is
// skipped on every NPC drop. The AI's #1 faction recommendation is
// auto-accepted; bio + items + loot generate in the background.
//
// Five guardrails prevent runaway behavior:
//
//   1. BATCH WINDOW (2s)   — drops within a 2-second window are gathered
//                            into one batch instead of firing in parallel.
//   2. RATE LIMIT (per-min) — hard cap on auto-generations per rolling 60s
//                            window. Hits to the cap are skipped with a
//                            toast.
//   3. BATCH CONFIRMATION   — when a batch is >= N tokens (configurable,
//                            default 5), ONE popup asks "Auto-generate
//                            bios for N creatures? (~$X estimated)" before
//                            any AI calls fire.
//   4. SERIAL PROCESSING    — within a batch, tokens are processed ONE AT
//                            A TIME with a small progress indicator.
//                            Prevents AI rate-limit hits, race conditions
//                            on disk writes, and concurrent memory writes.
//   5. REVIEW + REVERT      — after each auto-generation, a whispered chat
//                            card is posted to the GM listing what was
//                            generated, with [Open Sheet] and [Revert]
//                            buttons. Bad AI calls are 1-click recoverable.

import { MODULE_ID } from "../ace-engine.mjs";
import { appendToBiography } from "../bio-writer.mjs";

const TAG = "ACE: Engine | Auto-Pipeline";

const BATCH_WINDOW_MS = 2000;       // gather drops happening within this window into one batch
const RATE_LIMIT_WINDOW_MS = 60000;  // rolling 60s window for the cap

// ─── In-memory state ───────────────────────────────────────────────────────
let _batchBuffer = [];          // tokens dropped within the current batch window
let _batchTimer = null;          // timer that fires flushBatch when the window expires
let _processing = false;         // true while flushBatch is mid-loop (serial processing)
const _recentGenerations = [];   // {at: ms, actorName} entries within the rate-limit window
let _progressBanner = null;      // DOM element for the "Generating N of M..." indicator

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Called from the createToken hook when auto-generate is enabled. Adds
 * the token to the batch buffer and (re)starts the 2-second flush timer.
 * Multiple tokens dropping in quick succession all land in the same batch.
 */
export function enqueueAutoGeneration(tokenDoc) {
    if (!tokenDoc?.actor) return;
    _batchBuffer.push({ tokenDoc, droppedAt: Date.now() });
    if (_batchTimer) clearTimeout(_batchTimer);
    _batchTimer = setTimeout(() => _flushBatch().catch(err =>
        console.error(`${TAG} | flushBatch crashed:`, err)
    ), BATCH_WINDOW_MS);
}

// ─── Rate limit helpers ────────────────────────────────────────────────────

function _pruneOldEntries() {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    while (_recentGenerations.length && _recentGenerations[0].at < cutoff) {
        _recentGenerations.shift();
    }
}

function _capPerMinute() {
    try { return game.settings.get(MODULE_ID, "autoGenerateCapPerMinute") || 10; }
    catch (_) { return 10; }
}

function _batchConfirmThreshold() {
    try { return game.settings.get(MODULE_ID, "autoGenerateBatchConfirmThreshold") ?? 5; }
    catch (_) { return 5; }
}

// ─── Confirmation dialog ───────────────────────────────────────────────────

async function _confirmBatch(tokens) {
    const names = tokens.map(t => t.tokenDoc.actor?.name ?? "?").slice(0, 10);
    const extra = tokens.length > 10 ? `\n…and ${tokens.length - 10} more` : "";
    // Rough cost guess — most modern providers charge $0.01-$0.03 per
    // bio+faction generation. Show a range.
    const lo = (tokens.length * 0.01).toFixed(2);
    const hi = (tokens.length * 0.03).toFixed(2);

    return new Promise(resolve => {
        new Dialog({
            title: `ACE: Auto-Generate ${tokens.length} NPCs?`,
            content: `
                <div style="font-family:sans-serif;padding:6px;">
                    <p style="font-size:14px;color:#222;margin:0 0 8px;">
                        <strong>${tokens.length}</strong> tokens dropped in this batch.
                        Auto-generate bio + faction for all of them?
                    </p>
                    <p style="font-size:13px;color:#555;margin:0 0 8px;line-height:1.5;">
                        ${names.join(", ")}${extra}
                    </p>
                    <p style="font-size:12px;color:#777;margin:0;">
                        Estimated AI cost: <strong>$${lo} — $${hi}</strong>
                        (varies by provider). Processed one at a time.
                    </p>
                </div>
            `,
            buttons: {
                yes: {
                    icon: '<i class="fas fa-check"></i>',
                    label: "Generate All",
                    callback: () => resolve(true),
                },
                pickEach: {
                    icon: '<i class="fas fa-list"></i>',
                    label: "Show Popup For Each",
                    callback: () => resolve("popup"),
                },
                skip: {
                    icon: '<i class="fas fa-forward"></i>',
                    label: "Skip All",
                    callback: () => resolve(false),
                },
            },
            default: "yes",
            close: () => resolve(false),
        }, { width: 460 }).render(true);
    });
}

// ─── Progress indicator ────────────────────────────────────────────────────

function _showProgress(current, total, name) {
    if (!_progressBanner) {
        _progressBanner = document.createElement("div");
        _progressBanner.className = "ace-auto-progress";
        _progressBanner.style.cssText = `
            position: fixed; top: 60px; right: 16px; z-index: 9998;
            min-width: 280px; padding: 10px 14px;
            background: linear-gradient(135deg, rgba(20,20,24,0.95), rgba(12,12,16,0.95));
            border: 2px solid rgba(212,175,55,0.7);
            border-radius: 8px;
            color: #f0e4c0;
            font-family: 'Orbitron','Rajdhani',sans-serif;
            font-size: 13px; font-weight: 600;
            box-shadow: 0 0 20px rgba(212,175,55,0.4), 0 4px 12px rgba(0,0,0,0.5);
        `;
        document.body.appendChild(_progressBanner);
    }
    _progressBanner.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
            <i class="fas fa-cog fa-spin" style="color:#d4af37;font-size:18px;"></i>
            <div>
                <div style="text-transform:uppercase;letter-spacing:0.5px;font-size:11px;color:#b8a78a;">Auto-Generating</div>
                <div style="font-size:13px;">${current} of ${total} — ${name ?? "…"}</div>
            </div>
        </div>
    `;
}

function _hideProgress() {
    if (_progressBanner?.parentNode) {
        try { _progressBanner.parentNode.removeChild(_progressBanner); } catch (_) {}
    }
    _progressBanner = null;
}

// ─── Batch flush — runs after the 2s window expires ────────────────────────

async function _flushBatch() {
    if (_processing) {
        // A previous batch is still draining. Append this one's contents
        // to the next round by leaving them in _batchBuffer (the next
        // _processing=false moment will pick them up via re-scheduling).
        // Simplest: defer by rescheduling.
        _batchTimer = setTimeout(() => _flushBatch().catch(() => {}), 500);
        return;
    }
    const batch = _batchBuffer.slice();
    _batchBuffer = [];
    _batchTimer = null;
    if (!batch.length) return;

    _processing = true;
    try {
        // ── Rate limit pruning + check ─────────────────────────────────
        _pruneOldEntries();
        const cap = _capPerMinute();
        const slotsLeft = Math.max(0, cap - _recentGenerations.length);
        let toProcess = batch;
        if (batch.length > slotsLeft) {
            ui.notifications?.warn(
                `ACE: Auto-gen rate limit (${cap}/min) — processing ${slotsLeft} of ${batch.length}, ` +
                `${batch.length - slotsLeft} skipped. Drop these later or generate manually via the sheet.`
            );
            toProcess = batch.slice(0, slotsLeft);
        }
        if (!toProcess.length) {
            _processing = false;
            return;
        }

        // ── Batch confirmation ─────────────────────────────────────────
        const threshold = _batchConfirmThreshold();
        let popupFallback = false;
        if (threshold > 0 && toProcess.length >= threshold) {
            const decision = await _confirmBatch(toProcess);
            if (!decision) {
                ui.notifications?.info(`ACE: Skipped auto-generation for ${toProcess.length} NPC${toProcess.length !== 1 ? "s" : ""}.`);
                _processing = false;
                return;
            }
            if (decision === "popup") {
                popupFallback = true; // run each token through the normal popup flow
            }
        }

        // ── Serial processing ─────────────────────────────────────────
        const { queueBioGeneration } = await import("./bio-generator.mjs");
        for (let i = 0; i < toProcess.length; i++) {
            const { tokenDoc } = toProcess[i];
            const actor = tokenDoc.actor;
            if (!actor) continue;

            _showProgress(i + 1, toProcess.length, actor.name);

            // Flag the tokenDoc so the smart-setup dialog auto-accepts
            // instead of opening. If user chose "Show popup for each"
            // in the confirmation, we DON'T set the flag — they get
            // the normal interactive flow.
            if (!popupFallback) {
                tokenDoc._aceAutoAccept = true;
            }
            tokenDoc._aceManualDrop = true;

            try {
                // queueBioGeneration internally awaits the dialog (which
                // resolves instantly when _aceAutoAccept is set) and runs
                // through bio + items + loot. We await its completion
                // before moving to the next token.
                await _processSingle(tokenDoc, queueBioGeneration);
                _recentGenerations.push({ at: Date.now(), actorName: actor.name });
                if (!popupFallback) {
                    await _postReviewCard(tokenDoc);
                }
            } catch (err) {
                console.warn(`${TAG} | Auto-gen failed for ${actor.name}:`, err);
            }

            // Small gap between iterations so we don't hammer the AI back-to-back
            if (i < toProcess.length - 1) {
                await new Promise(r => setTimeout(r, 350));
            }
        }
    } finally {
        _hideProgress();
        _processing = false;
        // If new items arrived while we were processing, fire another flush
        if (_batchBuffer.length) {
            _batchTimer = setTimeout(() => _flushBatch().catch(() => {}), 100);
        }
    }
}

/**
 * Run queueBioGeneration and resolve only when the bio pipeline completes
 * (via the ace-engine.bioComplete hook). This ensures _postReviewCard is
 * posted AFTER the bio has actually been written, not 200ms after it started.
 * A 30s safety timeout prevents indefinite hanging if the hook never fires
 * (e.g., token had bio disabled, was already generated, or pipeline errored).
 */
async function _processSingle(tokenDoc, queueBioGeneration) {
    return new Promise((resolve) => {
        let settled = false;
        const settle = () => { if (!settled) { settled = true; resolve(); } };

        const hookId = Hooks.on("ace-engine.bioComplete", (data) => {
            if (data.tokenDoc?.id !== tokenDoc.id) return;
            Hooks.off("ace-engine.bioComplete", hookId);
            settle();
        });

        // Safety fallback — resolves if bioComplete never fires (bio skipped, etc.)
        setTimeout(() => {
            Hooks.off("ace-engine.bioComplete", hookId);
            settle();
        }, 30_000);

        queueBioGeneration(tokenDoc);
    });
}

// ─── Review/revert chat card ───────────────────────────────────────────────

async function _postReviewCard(tokenDoc) {
    const actor = tokenDoc.actor;
    if (!actor) return;
    try {
        const cardHtml = `
            <div style="border-left:4px solid #d4af37;padding:8px 10px;background:rgba(212,175,55,0.06);border-radius:0 4px 4px 0;font-family:'Rajdhani',sans-serif;">
                <div style="font-size:11px;color:#d4af37;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">
                    <i class="fas fa-cog"></i> Auto-Generated
                </div>
                <div style="color:#f0e4c0;font-size:13px;font-weight:600;margin-bottom:6px;">
                    ${_escapeHtml(actor.name)}
                </div>
                <div style="display:flex;gap:6px;">
                    <button class="ace-chat-btn" data-ace-btn="autoReviewOpen" data-actor-id="${actor.id}"
                            style="flex:1;padding:6px 10px;background:rgba(212,175,55,0.18);border:1px solid rgba(212,175,55,0.5);border-radius:4px;color:#f0e4c0;cursor:pointer;font-size:12px;font-weight:600;">
                        <i class="fas fa-eye"></i> Open Sheet
                    </button>
                    <button class="ace-chat-btn" data-ace-btn="autoReviewRevert" data-actor-id="${actor.id}"
                            style="flex:1;padding:6px 10px;background:rgba(180,40,40,0.18);border:1px solid rgba(220,60,60,0.5);border-radius:4px;color:#ffb0b0;cursor:pointer;font-size:12px;font-weight:600;">
                        <i class="fas fa-undo"></i> Revert Bio
                    </button>
                </div>
            </div>
        `;
        await ChatMessage.create({
            content: cardHtml,
            speaker: { alias: "ACE" },
            whisper: ChatMessage.getWhisperRecipients?.("GM")?.map(u => u.id) ?? [game.user.id],
            flags: { [MODULE_ID]: { autoReviewCard: true, actorId: actor.id } },
        });
    } catch (err) {
        console.warn(`${TAG} | Review card post failed:`, err);
    }
}

function _escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s ?? "";
    return div.innerHTML;
}

// ─── Chat-card button handlers ─────────────────────────────────────────────

/**
 * Hook handler that runs when the GM clicks "Open Sheet" or "Revert Bio"
 * on an auto-generation review card. Registered from activateAutoPipeline.
 */
function _onRenderChatMessage(message, html) {
    const root = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!root) return;
    const openBtn = root.querySelector?.('[data-ace-btn="autoReviewOpen"]');
    const revertBtn = root.querySelector?.('[data-ace-btn="autoReviewRevert"]');
    if (openBtn) {
        openBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            const actorId = openBtn.dataset.actorId;
            const actor = game.actors?.get(actorId);
            if (actor) actor.sheet?.render(true);
        });
    }
    if (revertBtn) {
        revertBtn.addEventListener("click", async (ev) => {
            ev.preventDefault();
            const actorId = revertBtn.dataset.actorId;
            const actor = game.actors?.get(actorId);
            if (!actor) return;
            const confirmed = await Dialog.confirm({
                title: `Revert auto-generated bio?`,
                content: `<p>Strip the ACE-generated bio section from <strong>${_escapeHtml(actor.name)}</strong>?</p>
                          <p style="font-size:12px;color:#888;">Removes the auto-written paragraph. Faction assignment and items stay — you can clear those manually if needed.</p>`,
            });
            if (!confirmed) return;
            try {
                // Read-modify-write via bio-writer so concurrent regen /
                // story-note appends don't stomp on this strip (v1.6.3).
                await appendToBiography(actor, (bio) => {
                    const stripped = bio.replace(
                        /<section\s+class="ace-engine-bio"[\s\S]*?<\/section>/gi, ""
                    ).trim();
                    return stripped === bio ? null : stripped;
                }, "auto-pipeline:revert");
                await actor.unsetFlag(MODULE_ID, "bioSceneId");
                ui.notifications?.info(`ACE: Reverted bio for ${actor.name}.`);
                revertBtn.disabled = true;
                revertBtn.innerHTML = '<i class="fas fa-check"></i> Reverted';
                revertBtn.style.opacity = "0.6";
            } catch (err) {
                console.warn(`${TAG} | Revert failed:`, err);
                ui.notifications?.error(`ACE: Revert failed — see console.`);
            }
        });
    }
}

// ─── Activation ────────────────────────────────────────────────────────────

let _activated = false;

export function activateAutoPipeline() {
    if (_activated) return;
    if (!game.user.isGM) return;
    _activated = true;
    Hooks.on("renderChatMessage", _onRenderChatMessage);       // V12
    Hooks.on("renderChatMessageHTML", _onRenderChatMessage);   // V13 (was missing → inert on V13)
    console.log(`${TAG} | Auto-pipeline active (gated by autoGenerateOnDrop setting).`);
}

/** Check whether auto-generate-on-drop is enabled in settings. */
export function isAutoGenerateEnabled() {
    try { return !!game.settings.get(MODULE_ID, "autoGenerateOnDrop"); }
    catch (_) { return false; }
}
