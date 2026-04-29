// ─── ACE: Engine — NPC Chat UI Hooks ───────────────────────────────────────
// Token HUD button, sheet AI Setup tab, scene voice region, player overlay
// management, party face diamond. Registered by activate.mjs when the
// npcChatEnabled gate is true.
//
// Moved from ace-envoy/src/main.js (renderTokenHUD, renderSceneConfig, the
// canvas overlay-hiding hooks, and party-face refresh) as part of the
// Envoy → Engine merger.
//
// DEFERRED to a future commit (~800 lines, AIConfigDialog class):
//   - GM "AI Setup" icon (the robot button next to chat)
//   - renderActorSheetV2 hook (AI Setup tab on NPC sheets)
//   - canvasReady right-click handler (forces HUD on NPC tokens for players)
//   - canvasReady orphaned-conversation cleanup

import { onRenderSceneConfig } from "./voice-engine.mjs";
import { ConversationApp }     from "./conversation-app.mjs";
import { npcChatState }        from "./activate.mjs";

const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | UI";
const PARTY_FACE_CHILD_NAME = "aceEnginePartyFaceDiamond";
const MIN_CHAT_INT = 3;

const { openConversations, npcLocks } = npcChatState;

// ─── HELPERS ───────────────────────────────────────────────────────────────

function _isMindless(actor) {
    const int = actor?.system?.abilities?.int?.value;
    return (typeof int === "number" && int < MIN_CHAT_INT);
}

function _getFlag(doc, scope, key) {
    try { return doc.getFlag(scope, key); } catch (_) {}
    try { return foundry.utils.getProperty(doc.flags?.[scope] ?? {}, key); } catch (_) {}
    return undefined;
}

function _convoKey(actorId, tokenDoc) {
    return (tokenDoc && !tokenDoc.actorLink) ? `tok:${tokenDoc.id}` : actorId;
}

function getPlayerToken() {
    if (game.user.isGM) return null;
    const charId = game.user.character?.id;
    if (!charId) return null;
    return canvas.tokens?.placeables?.find(t => t.document?.actorId === charId) ?? null;
}

function tokenDistanceFt(tokenA, tokenB) {
    const gridSizePx = canvas.grid.size;
    const gridFt     = canvas.grid.distance;
    const a = tokenA.center;
    const b = tokenB.center;
    const distPx = Math.hypot(b.x - a.x, b.y - a.y);
    return (distPx / gridSizePx) * gridFt;
}

function hasLOS(tokenA, tokenB) {
    try {
        const origin = tokenA.center;
        const dest   = tokenB.center;
        const blocked = CONFIG.Canvas.polygonBackends.sight.testCollision(
            origin, dest, { type: "sight", mode: "any" }
        );
        return !blocked;
    } catch (e) {
        console.warn(`${TAG} | LOS check failed:`, e);
        return true;
    }
}

function isLockedByMe(actorId) { return npcLocks.get(actorId)?.userId === game.user.id; }

async function _resolveSpeakerToken(npcActorId) {
    const candidates = (canvas.tokens?.controlled ?? []).filter(t => {
        const a = t.actor;
        if (!a || a.id === npcActorId) return false;
        return a.type === "character" || a.hasPlayerOwner;
    });
    if (candidates.length <= 1) return candidates[0] || null;
    return new Promise((resolve) => {
        const buttons = {};
        for (const tok of candidates) {
            buttons[tok.id] = {
                icon: `<img src="${tok.document.texture?.src || tok.actor.img}" style="width:24px;height:24px;border:0;border-radius:50%;vertical-align:middle;" />`,
                label: tok.document.name || tok.actor.name,
                callback: () => resolve(tok),
            };
        }
        buttons._cancel = { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => resolve(false) };
        new Dialog({
            title: "Who Is Speaking?",
            content: `<p style="margin-bottom:8px;">Multiple characters are selected. Which one is starting this conversation?</p>`,
            buttons,
            default: candidates[0].id,
            close: () => resolve(false),
        }).render(true);
    });
}

// ─── PLAYER HUD OVERLAY HIDING ─────────────────────────────────────────────

function _forceHideHudChildren(hudEl) {
    if (!hudEl) return;
    const _hide = (el, depth) => {
        for (const child of el.children) {
            if (child.classList?.contains("ai-token-controls")) continue;
            child.style.setProperty("display", "none", "important");
            child.style.setProperty("visibility", "hidden", "important");
            child.style.pointerEvents = "none";
            if (depth < 4 && child.children?.length) _hide(child, depth + 1);
        }
    };
    _hide(hudEl, 0);
    for (const el of hudEl.querySelectorAll(
        '[data-palette="movementActions"], [data-action="toggleMovement"], ' +
        '[data-action="togglePalette"][data-palette="movementActions"], ' +
        '.palette.movement-actions, .movement-action-control, ' +
        '[data-action="elevation"], .elevation'
    )) {
        if (el.closest(".ai-token-controls")) continue;
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("visibility", "hidden", "important");
        el.style.pointerEvents = "none";
    }
}

let _hideRefCount = 0;
function _addHideOverlays() {
    if (game.user.isGM) return;
    _hideRefCount++;
    document.body.classList.add("ace-engine-hide-tah");
}
function _removeHideOverlays() {
    if (game.user.isGM) return;
    _hideRefCount = Math.max(0, _hideRefCount - 1);
    if (_hideRefCount === 0) document.body.classList.remove("ace-engine-hide-tah");
}

function _hideCanvasOverlays(token) {
    if (!token?.children) return;
    const keep = new Set();
    for (const prop of ["mesh", "icon", "border", "bars", "effects", "nameplate",
                         "tooltip", "target", "voidMesh", "ring", "detectionFilter"]) {
        if (token[prop]) keep.add(token[prop]);
    }
    for (const child of token.children) {
        if (keep.has(child)) continue;
        if (child.visible !== false) {
            try { child.visible = false; }
            catch (_) { try { child.renderable = false; } catch (_2) {} }
        }
    }
}

let _hudSweepInterval = null;
let _hudObserver = null;
function _ensureHudObserver() {
    if (game.user.isGM) return;
    const hudEl = document.getElementById("token-hud");
    if (!hudEl) return;
    if (_hudObserver) { try { _hudObserver.disconnect(); } catch (_) {} }
    _hudObserver = new MutationObserver(() => {
        if (!hudEl.classList.contains("ace-engine-player-hud")) return;
        _forceHideHudChildren(hudEl);
    });
    _hudObserver.observe(hudEl, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "display"] });
}

function _refreshPartyFaceIndicator() {
    for (const token of canvas.tokens?.placeables ?? []) {
        token.refresh();
    }
}

// ─── HOOK REGISTRATION ─────────────────────────────────────────────────────

export function registerUiHooks() {

    // ── Voice Region dropdown on Scene Config ────────────────────────────
    Hooks.on("renderSceneConfig", (app, html, data) => {
        onRenderSceneConfig(app, html);
    });

    // ── HUD Mutation Observer (player view only) ─────────────────────────
    Hooks.once("canvasReady", _ensureHudObserver);

    // ── Hide canvas overlays for players when NPC token selected/refreshed/hovered
    Hooks.on("controlToken", (token, controlled) => {
        if (game.user.isGM) return;
        if (controlled && token.actor?.type === "npc") {
            _addHideOverlays();
        } else if (!controlled) {
            const anyNPC = canvas.tokens?.controlled?.some(t => t.actor?.type === "npc");
            if (!anyNPC) _removeHideOverlays();
        }
    });

    Hooks.on("refreshToken", (token) => {
        if (game.user.isGM) return;
        if (token.actor?.type !== "npc") return;
        _hideCanvasOverlays(token);
    });

    Hooks.on("hoverToken", (token, hovered) => {
        if (game.user.isGM || !hovered) return;
        if (token.actor?.type !== "npc") return;
        _hideCanvasOverlays(token);
        setTimeout(() => _hideCanvasOverlays(token), 50);
    });

    // ── Party Face diamond indicator on owner's token ────────────────────
    Hooks.on("refreshToken", (token) => {
        const existing = token.children?.find(c => c.name === PARTY_FACE_CHILD_NAME);
        if (existing) { token.removeChild(existing); existing.destroy(); }

        const faceUserId = (() => {
            try { return game.settings.get(MODULE_ID, "partyFace") || ""; }
            catch (_) { return ""; }
        })();
        if (!faceUserId) return;
        const faceUser = game.users.get(faceUserId);
        if (!faceUser) return;

        const tokenActor = token.actor ?? token.document?.actor;
        if (!tokenActor?.hasPlayerOwner) return;
        if (!tokenActor.testUserPermission(faceUser, "OWNER")) return;

        const gridPx = canvas.grid?.size ?? 100;
        const tokenW = token.w ?? (token.document?.width ?? 1) * gridPx;
        const size = Math.max(8, Math.round(tokenW * 0.1));

        const g = new PIXI.Graphics();
        g.name = PARTY_FACE_CHILD_NAME;
        g.zIndex = 999;
        g.lineStyle(2, 0x000000, 0.6);
        g.beginFill(0xd4af37, 0.95);
        g.moveTo(0, -size);
        g.lineTo(size, 0);
        g.lineTo(0, size);
        g.lineTo(-size, 0);
        g.closePath();
        g.endFill();
        g.lineStyle(1, 0xffd700, 0.5);
        const inner = size * 0.5;
        g.moveTo(0, -inner);
        g.lineTo(inner, 0);
        g.lineTo(0, inner);
        g.lineTo(-inner, 0);
        g.closePath();
        g.x = tokenW - size - 2;
        g.y = size + 2;

        token.addChild(g);
        if (token.sortChildren) token.sortChildren();
    });

    // ── The big one: Token HUD chat button + party face controls ─────────
    Hooks.on("renderTokenHUD", (app, html, data) => {
        const token = canvas.tokens.get(data._id);
        if (!token?.actor) return;

        // ── GM: Party Face toggle on player character tokens ──────────
        if (game.user.isGM && token.actor.type === "character" && token.actor.hasPlayerOwner) {
            const jHtml = $(html);
            jHtml.find(".ace-engine-party-face-control").remove();

            const ownerUser = game.users.find(u => !u.isGM && token.actor.testUserPermission(u, "OWNER"));
            if (!ownerUser) return;

            const currentFace = (() => {
                try { return game.settings.get(MODULE_ID, "partyFace") || ""; }
                catch (_) { return ""; }
            })();
            const isThisFace  = currentFace === ownerUser.id;
            const charName    = token.actor.name;
            const diamondTip  = isThisFace
                ? `${charName} is the Party Face (click to remove)`
                : `Set ${charName} as Party Face`;
            const diamondFilter = isThisFace
                ? "drop-shadow(0 0 6px rgba(212,175,55,0.9)) drop-shadow(0 0 3px black)"
                : "drop-shadow(0 0 6px black) grayscale(0.6) opacity(0.5)";

            const faceHtml = `
            <div class="ace-engine-party-face-control"
                 style="position:absolute; top:-48px; left:50%; transform:translateX(-50%);
                        pointer-events:all; z-index:70; text-align:center;">
                <i class="fas fa-gem ace-engine-face-toggle"
                   title="${diamondTip}"
                   style="font-size:30px; cursor:pointer;
                          color:${isThisFace ? "#d4af37" : "#888"};
                          filter:${diamondFilter};
                          transition: filter 0.15s, color 0.15s;
                          text-shadow: 0 0 4px rgba(0,0,0,0.8);"></i>
            </div>`;
            const faceBtn = $(faceHtml);
            faceBtn.find(".ace-engine-face-toggle").on("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (isThisFace) {
                    game.settings.set(MODULE_ID, "partyFace", "");
                    ui.notifications.info(`Party Face disabled — any player can initiate conversations.`);
                } else {
                    game.settings.set(MODULE_ID, "partyFace", ownerUser.id);
                    ui.notifications.info(`${charName} is now the Party Face — only they can initiate NPC conversations.`);
                }
                _refreshPartyFaceIndicator();
                canvas.hud.token.clear();
            }).on("mouseenter", function() {
                this.style.color  = "#ffd700";
                this.style.filter = "drop-shadow(0 0 8px rgba(212,175,55,1)) drop-shadow(0 0 4px black)";
            }).on("mouseleave", function() {
                this.style.color  = isThisFace ? "#d4af37" : "#888";
                this.style.filter = diamondFilter;
            });
            jHtml.append(faceBtn);
            return;
        }

        if (token.actor.type !== "npc") return;

        const actor  = token.actor;
        const isGM   = game.user.isGM;
        const jHtml  = $(html);

        // ── Player view: ONLY show chat bubble — hide ALL default HUD elements ──
        if (!isGM) {
            const rawEl = jHtml[0] ?? jHtml;
            if (rawEl?.classList) rawEl.classList.add("ace-engine-player-hud");
            else jHtml.addClass("ace-engine-player-hud");

            const tokenHudEl = document.getElementById("token-hud");
            if (tokenHudEl) tokenHudEl.classList.add("ace-engine-player-hud");

            _ensureHudObserver();

            _forceHideHudChildren(tokenHudEl);
            setTimeout(() => _forceHideHudChildren(tokenHudEl), 50);
            setTimeout(() => _forceHideHudChildren(tokenHudEl), 150);
            setTimeout(() => _forceHideHudChildren(tokenHudEl), 400);
            setTimeout(() => _forceHideHudChildren(tokenHudEl), 800);

            if (_hudSweepInterval) clearInterval(_hudSweepInterval);
            _hudSweepInterval = setInterval(() => {
                const h = document.getElementById("token-hud");
                if (!h || !h.classList.contains("ace-engine-player-hud")) {
                    clearInterval(_hudSweepInterval);
                    _hudSweepInterval = null;
                    return;
                }
                _forceHideHudChildren(h);
            }, 500);

            _addHideOverlays();

            const _restoreHook = Hooks.on("closeTokenHUD", () => {
                _removeHideOverlays();
                if (_hudSweepInterval) { clearInterval(_hudSweepInterval); _hudSweepInterval = null; }
                const thEl = document.getElementById("token-hud");
                if (thEl) thEl.classList.remove("ace-engine-player-hud");
                Hooks.off("closeTokenHUD", _restoreHook);
            });

            // Skip chat bubble injection if GM disabled chat or creature is mindless
            if (_getFlag(actor, MODULE_ID, "chatDisabled")) return;
            if (_isMindless(actor)) return;

            // Range + LoS checks for players
            const playerToken = getPlayerToken();
            if (playerToken) {
                const maxRange = actor.getFlag(MODULE_ID, "conversationRange")
                              || actor.flags?.npclink?.conversationRange || 30;
                const dist = tokenDistanceFt(playerToken, token);
                if (dist > maxRange) {
                    jHtml.find(".ai-token-controls").remove();
                    const hintHtml = `
                    <div class="ai-token-controls"
                         style="position:absolute; top:-55px; left:50%; transform:translateX(-50%);
                                pointer-events:all; z-index:70; text-align:center;">
                        <img src="modules/ace-envoy/assets/chat-icon.png"
                             style="width:36px; height:36px; opacity:0.35; filter:grayscale(1) drop-shadow(0 0 3px black);
                                    cursor:default;" title="${actor.name} — get closer to talk" />
                    </div>`;
                    jHtml.append($(hintHtml));
                    return;
                }
                if (!hasLOS(playerToken, token)) {
                    return;
                }
            }

            // Party Face check
            const partyFaceId = (() => {
                try { return game.settings.get(MODULE_ID, "partyFace") || ""; }
                catch (_) { return ""; }
            })();
            if (partyFaceId && game.user.id !== partyFaceId) {
                const faceUser = game.users.get(partyFaceId);
                const faceName = faceUser?.character?.name || faceUser?.name || "Party Face";
                jHtml.find(".ai-token-controls").remove();
                const faceHtml = `
                <div class="ai-token-controls"
                     style="position:absolute; top:-55px; left:50%; transform:translateX(-50%);
                            pointer-events:all; z-index:70; text-align:center;">
                    <img src="modules/ace-envoy/assets/chat-icon.png"
                         style="width:36px; height:36px; opacity:0.3; filter:sepia(1) saturate(0.5) brightness(1.2) drop-shadow(0 0 3px black);
                                cursor:default;" title="${faceName} is the party spokesperson" />
                </div>`;
                jHtml.append($(faceHtml));
                return;
            }

            // Lock check
            const anyLocked = npcLocks.size > 0;
            if (anyLocked && !isLockedByMe(actor.id)) {
                jHtml.find(".ai-token-controls").remove();
                const lockedHtml = `
                <div class="ai-token-controls"
                     style="position:absolute; top:-55px; left:50%; transform:translateX(-50%);
                            pointer-events:all; z-index:70; text-align:center;">
                    <img src="modules/ace-envoy/assets/chat-icon.png"
                         style="width:36px; height:36px; opacity:0.3; filter:sepia(1) saturate(3) hue-rotate(-20deg) drop-shadow(0 0 3px black);
                                cursor:default;" title="Someone is already in conversation" />
                </div>`;
                jHtml.append($(lockedHtml));
                return;
            }

            // Player can talk! Show chat icon
            jHtml.find(".ai-token-controls").remove();
            const chatHtml = `
            <div class="ai-token-controls"
                 style="position:absolute; top:-55px; left:50%; transform:translateX(-50%);
                        pointer-events:all; z-index:70; text-align:center;">
                <img class="ace-engine-trigger ace-engine-player-chat"
                     src="modules/ace-envoy/assets/chat-icon.png"
                     title="Talk to ${actor.name}"
                     style="width:46px; height:46px; cursor:pointer;
                            filter:drop-shadow(0 0 6px rgba(201,168,76,0.8)) drop-shadow(0 0 3px black);
                            transition: transform 0.15s, filter 0.15s;" />
            </div>`;

            const chatControls = $(chatHtml);
            const tokenDoc = token.document;
            const playerConvoKey = _convoKey(actor.id, tokenDoc);
            const capturedPlayerToken = canvas.tokens?.controlled?.find(t => {
                const a = t.actor;
                return a && a.id !== actor.id && (a.type === "character" || a.hasPlayerOwner);
            }) || null;

            chatControls.find(".ace-engine-trigger").on("click", async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const existing = openConversations.get(playerConvoKey);
                if (existing) { existing.render(true); return; }
                const convoApp = new ConversationApp(actor, { isOwner: true, tokenDocument: tokenDoc, speakerToken: capturedPlayerToken || undefined });
                openConversations.set(playerConvoKey, convoApp);
                convoApp.render(true);
                canvas.hud.token.clear();
            });
            chatControls.find(".ace-engine-trigger").on("mouseenter", function() {
                this.style.transform = "scale(1.15)";
                this.style.filter = "drop-shadow(0 0 10px rgba(201,168,76,1)) drop-shadow(0 0 4px black)";
            }).on("mouseleave", function() {
                this.style.transform = "scale(1)";
                this.style.filter = "drop-shadow(0 0 6px rgba(201,168,76,0.8)) drop-shadow(0 0 3px black)";
            });
            jHtml.append(chatControls);
            return;
        }

        // ── GM view: chat icon (AI Setup icon deferred — needs AIConfigDialog port)
        jHtml.find(".ai-token-controls").remove();
        const controlsHtml = `
        <div class="ai-token-controls"
             style="position:absolute; top:-65px; left:50%; transform:translateX(-50%);
                    display:flex; gap:16px; pointer-events:all; z-index:70; width:max-content;">
            <img class="ace-engine-trigger"
                 src="modules/ace-envoy/assets/chat-icon.png"
                 title="Start NPC Chat"
                 style="width:46px; height:46px; cursor:pointer; filter:drop-shadow(0 0 6px black);" />
        </div>`;

        const controls = $(controlsHtml);
        const gmTokenDoc = token.document;
        const gmConvoKey = _convoKey(actor.id, gmTokenDoc);
        controls.find(".ace-engine-trigger").on("click", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const existing = openConversations.get(gmConvoKey);
            if (existing) {
                if (existing.readOnly) {
                    existing.readOnly = false;
                    existing._isOwner = true;
                    if (typeof existing._setUILocked === "function") existing._setUILocked(false);
                }
                existing.render(true);
                return;
            }
            const speakerToken = await _resolveSpeakerToken(actor.id);
            if (speakerToken === false) return;
            const convoApp = new ConversationApp(actor, { isOwner: true, tokenDocument: gmTokenDoc, speakerToken: speakerToken || undefined });
            openConversations.set(gmConvoKey, convoApp);
            convoApp.render(true);
        });

        jHtml.append(controls);
    });
}
