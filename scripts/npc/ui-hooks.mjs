// ─── ACE: Engine — NPC Chat UI Hooks ───────────────────────────────────────
// Token HUD button, sheet AI Setup tab, scene voice region, player overlay
// management, party face diamond. Registered by activate.mjs when the
// npcChatEnabled gate is true.
//
// Moved from ace-envoy/src/main.js (renderTokenHUD, renderSceneConfig, the
// canvas overlay-hiding hooks, party-face refresh, AI Setup tab on NPC
// sheets, player right-click HUD trigger, and orphaned conversation
// cleanup) as part of the Envoy → Engine merger.

import { onRenderSceneConfig } from "./voice-engine.mjs";
import { ConversationApp }     from "./conversation-app.mjs";
import { AIConfigDialog }      from "./npc-config-dialog.mjs";
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
                        <img src="modules/ace-engine/assets/chat-icon.png"
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
                    <img src="modules/ace-engine/assets/chat-icon.png"
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
                    <img src="modules/ace-engine/assets/chat-icon.png"
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
                     src="modules/ace-engine/assets/chat-icon.png"
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

        // ── GM view: chat + AI Setup icons ─────────────────────────────
        jHtml.find(".ai-token-controls").remove();
        const controlsHtml = `
        <div class="ai-token-controls"
             style="position:absolute; top:-65px; left:50%; transform:translateX(-50%);
                    display:flex; gap:16px; pointer-events:all; z-index:70; width:max-content;">
            <img class="ace-engine-trigger"
                 src="modules/${MODULE_ID}/assets/chat-icon.png"
                 title="Start NPC Chat"
                 style="width:46px; height:46px; cursor:pointer; filter:drop-shadow(0 0 6px black);" />
            <img class="setup-trigger"
                 src="modules/${MODULE_ID}/assets/robot-icon.png"
                 title="AI Setup"
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

        controls.find(".setup-trigger").on("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            new AIConfigDialog(token.actor).render(true);
        });

        jHtml.append(controls);
    });

    // ── Player right-click on NPC tokens → force Token HUD ──────────────
    // By default Foundry may not show Token HUD for unowned NPC tokens.
    // We intercept right-clicks on NPC tokens so players can access the chat icon.
    //
    // Run BOTH immediately (canvas is typically already drawn by the time
    // registerUiHooks is invoked from activateNpcChat — initial canvasReady
    // has already fired and won't fire again until scene switch) AND on
    // future canvasReady fires (handles scene switches and the rare case
    // where the canvas isn't drawn yet at invocation time).
    const _attachPlayerRightClick = () => {
        if (game.user.isGM) return;

        const board = document.getElementById("board");
        if (!board || board._aceEngineRightClick) return;
        board._aceEngineRightClick = true;

        board.addEventListener("contextmenu", (ev) => {
            const point = canvas.app.renderer.events.pointer?.getLocalPosition(canvas.stage);
            if (!point) return;

            // Foundry's hover state knows which token is visually on top
            let clickedToken = canvas.tokens?.placeables?.find(t => t.hover);

            if (!clickedToken) {
                // Manual fallback: sort by Pixi children order (last = on top)
                const sorted = [...(canvas.tokens?.placeables ?? [])].sort((a, b) => {
                    const ia = a.parent?.children?.indexOf(a) ?? 0;
                    const ib = b.parent?.children?.indexOf(b) ?? 0;
                    return ib - ia;
                });
                for (const t of sorted) {
                    const { x, y, width, height } = t.document;
                    const tw = width  * canvas.grid.size;
                    const th = height * canvas.grid.size;
                    if (point.x >= x && point.x <= x + tw && point.y >= y && point.y <= y + th) {
                        clickedToken = t;
                        break;
                    }
                }
            }
            if (!clickedToken) return;

            const actor = clickedToken.document?.actor ?? clickedToken.actor;
            if (!actor || actor.type !== "npc") return;

            // Skip if GM disabled chat or creature is mindless
            if (_getFlag(actor, MODULE_ID, "chatDisabled")) return;
            if (_isMindless(actor)) return;

            ev.preventDefault();
            ev.stopPropagation();
            canvas.hud.token.bind(clickedToken);
        }, true);
    };
    _attachPlayerRightClick();                       // handle current canvas (initial boot)
    Hooks.on("canvasReady", _attachPlayerRightClick); // handle future scene switches

    // ── Orphaned spectator window cleanup on scene change ───────────────
    Hooks.on("canvasReady", async () => {
        for (const [convoKey, app] of openConversations.entries()) {
            const isOwner = app._isOwner;
            if (!isOwner) {
                const tokenExists = canvas.tokens?.placeables?.some(t => {
                    const a = t.document?.actor ?? t.actor;
                    return a?.id === app.actor?.id;
                });
                if (!tokenExists) {
                    try {
                        const { ttsEngine } = await import("./tts.mjs");
                        ttsEngine?.stop();
                    } catch (_) {}
                    app._gmForced = true;
                    app.close().catch(() => {});
                    openConversations.delete(convoKey);
                    console.log(`${TAG} | Spectator changed scene — closing orphaned window`);
                }
            }
        }
    });

    // ── AI Setup tab on NPC actor sheets (V2) ───────────────────────────
    Hooks.on("renderActorSheetV2", (sheet, html, data) => {
        if (!game.user.isGM) return;
        const actor = sheet.actor ?? sheet.object;
        if (!actor || actor.type !== "npc") return;

        const win = sheet.element instanceof HTMLElement ? sheet.element
                  : sheet.element?.[0] instanceof HTMLElement ? sheet.element[0]
                  : null;
        if (!win) { console.warn(`${TAG} | Could not find sheet window element`); return; }

        const form = (html instanceof HTMLElement) ? html
                   : html?.[0] instanceof HTMLElement ? html[0]
                   : win.querySelector("form");

        const wasActive = win.querySelector(".ace-engine-tab-content.active") !== null;
        win.querySelector(".ace-engine-tab-btn")?.remove();
        win.querySelector(".ace-engine-tab-content")?.remove();

        const chatDisabled = _getFlag(actor, MODULE_ID, "chatDisabled") || false;
        const voiceId      = actor.getFlag(MODULE_ID, "voiceId") || actor.flags?.npclink?.voiceId || "";

        const tabNav = win.querySelector("nav.tabs.tabs-right")
                    ?? win.querySelector(".tabs[data-group='primary']")
                    ?? win.querySelector("nav.tabs")
                    ?? win.querySelector(".sheet-tabs");

        const tabBody = win.querySelector(".tab-body")
                     ?? win.querySelector(".sheet-body")
                     ?? win.querySelector("[data-group='primary']")?.parentElement
                     ?? form;

        const tabBtn = document.createElement("a");
        tabBtn.className   = "item control ace-engine-tab-btn";
        tabBtn.dataset.tab = "ace-engine";
        tabBtn.dataset.group = "primary";
        tabBtn.title       = "ACE: Engine";
        tabBtn.setAttribute("aria-label", "ACE: Engine");
        tabBtn.innerHTML   = `<i class="fas fa-robot" style="color:#7fbf9f;"></i>`;
        tabBtn.style.cssText = "cursor:pointer;";

        const tabContent = document.createElement("div");
        tabContent.className        = "tab ace-engine-tab-content";
        tabContent.dataset.tab      = "ace-engine";
        tabContent.dataset.group    = "primary";
        tabContent.style.cssText    = `
            display: none; flex-direction: column; gap: 10px;
            padding: 12px; overflow-y: auto; height: 100%;
            background: rgba(0,0,0,0.15); box-sizing: border-box;`;

        tabContent.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;
                        background:${chatDisabled ? "rgba(120,30,30,0.2)" : "rgba(0,80,40,0.2)"};
                        border:1px solid ${chatDisabled ? "rgba(200,60,60,0.3)" : "rgba(0,150,70,0.3)"};
                        border-radius:6px;padding:8px 10px;">
                <input type="checkbox" id="ace-engine-disabled-${actor.id}"
                       ${chatDisabled ? "checked" : ""}
                       style="width:16px;height:16px;cursor:pointer;flex-shrink:0;" />
                <label for="ace-engine-disabled-${actor.id}"
                       style="cursor:pointer;color:${chatDisabled ? "#cf6060" : "#7fbf9f"};margin:0;
                              font-weight:bold;font-size:0.9em;user-select:none;">
                    ${chatDisabled ? "🚫 Chat Disabled — players cannot talk to this NPC" : "💬 Chat Enabled — players can right-click to talk"}
                </label>
            </div>

            <div style="display:flex;flex-direction:column;gap:4px;">
                <label style="color:#aaa;font-size:0.8em;font-weight:bold;">ELEVENLABS VOICE ID</label>
                <div style="display:flex;gap:4px;align-items:center;">
                    <input type="text" id="ace-engine-voice-id-${actor.id}"
                           value="${voiceId}"
                           placeholder="Paste Voice ID, or blank for auto-detect"
                           autocomplete="off" data-lpignore="true" data-1p-ignore="true"
                           style="flex:1;background:#1a1a2e;border:1px solid #444;
                                  border-radius:4px;color:#ccc;padding:4px 8px;font-size:0.85em;" />
                    <button type="button" id="ace-engine-test-${actor.id}"
                            style="padding:4px 10px;background:#0056b3;color:#fff;
                                   border:1px solid #0056b3;border-radius:4px;
                                   cursor:pointer;white-space:nowrap;font-size:0.85em;">
                        <i class="fas fa-play"></i> Test
                    </button>
                    <button type="button" id="ace-engine-stop-${actor.id}"
                            style="padding:4px 8px;background:#444;color:#fff;
                                   border:1px solid #555;border-radius:4px;cursor:pointer;font-size:0.85em;">
                        <i class="fas fa-stop"></i>
                    </button>
                    <button type="button" id="ace-engine-save-voice-${actor.id}"
                            style="padding:4px 10px;background:#2a6a3a;color:#fff;
                                   border:1px solid #3a8a4a;border-radius:4px;
                                   cursor:pointer;white-space:nowrap;font-size:0.85em;">
                        <i class="fas fa-save"></i> Save
                    </button>
                </div>
                <input type="text" id="ace-engine-phrase-${actor.id}"
                       placeholder='Test phrase, e.g. "I am ${actor.name}..."'
                       autocomplete="off" data-lpignore="true" data-1p-ignore="true"
                       style="background:#1a1a2e;border:1px solid #444;border-radius:4px;
                              color:#ccc;padding:4px 8px;font-size:0.85em;" />
                <p style="color:#666;font-size:0.75em;margin:0;font-style:italic;">
                    Leave blank for gender auto-detection.
                    Find voices at elevenlabs.io/voice-library
                </p>
            </div>

            <div style="border-top:1px solid #333;padding-top:10px;">
                <button type="button" id="ace-engine-open-config-${actor.id}"
                        style="width:100%;padding:6px;background:#1a2a3a;color:#9fc;
                               border:1px solid #2a4a5a;border-radius:4px;cursor:pointer;
                               font-size:0.85em;">
                    <i class="fas fa-robot"></i> Open Full NPC Config (Personality, Lore, Memory…)
                </button>
            </div>`;

        // ── Per-actor "Reset ACE Bio" button ─────────────────────────
        try {
            const bioSection = win.querySelector("section.ace-engine-bio");
            if (bioSection) {
                const header = bioSection.querySelector(".ace-bio-header");
                if (header && !header.querySelector(".ace-bio-btn-group")) {
                    const btnGroup = document.createElement("div");
                    btnGroup.className = "ace-bio-btn-group";

                    const copyBtn = document.createElement("button");
                    copyBtn.type = "button";
                    copyBtn.className = "ace-bio-copy";
                    copyBtn.title = "Copy biography text to clipboard";
                    copyBtn.innerHTML = `<i class="fas fa-copy"></i> Copy`;
                    copyBtn.addEventListener("click", async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const paragraphs = bioSection.querySelectorAll("p");
                        const bioText = Array.from(paragraphs)
                            .map(p => p.innerText.trim())
                            .filter(t => t.length > 0)
                            .join("\n\n");
                        try {
                            await navigator.clipboard.writeText(bioText);
                            copyBtn.innerHTML = `<i class="fas fa-check"></i> Copied`;
                            setTimeout(() => { copyBtn.innerHTML = `<i class="fas fa-copy"></i> Copy`; }, 1500);
                        } catch (err) {
                            console.warn(`${TAG} | clipboard copy failed:`, err);
                            ui.notifications.warn("Could not copy to clipboard.");
                        }
                    });
                    btnGroup.appendChild(copyBtn);

                    const resetBtn = document.createElement("button");
                    resetBtn.type = "button";
                    resetBtn.className = "ace-bio-reset";
                    resetBtn.title = "Reset ACE Biography — removes generated bio and allows regeneration";
                    resetBtn.innerHTML = `<i class="fas fa-trash-alt"></i> Reset`;
                    resetBtn.addEventListener("click", async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const confirmed = await Dialog.confirm({
                            title: "Reset ACE Biography",
                            content: `<p>Remove the ACE-generated biography for <strong>${actor.name}</strong>?</p>
                                      <p style="color:#999;font-size:0.85em;">Original module content will be preserved. The biography will regenerate next time this NPC's token is dropped onto a scene.</p>`,
                            yes: () => true,
                            no: () => false,
                            defaultYes: false,
                        });
                        if (!confirmed) return;
                        const currentBio = actor.system?.details?.biography?.value || "";
                        const cleanedBio = currentBio
                            .replace(/<section class="ace-engine-bio">[\s\S]*?<\/section>\s*/gi, "")
                            .replace(/^<hr\s*\/?>\s*/i, "")
                            .trim();
                        await actor.update({ "system.details.biography.value": cleanedBio });
                        await actor.unsetFlag(MODULE_ID, "bioGenerated");
                        ui.notifications.info(`ACE biography reset for ${actor.name}.`);
                        sheet.render(false);
                    });
                    btnGroup.appendChild(resetBtn);

                    header.appendChild(btnGroup);
                }
            }
        } catch (e) { console.warn(`${TAG} | Error injecting bio reset button:`, e); }

        // ── Wire up tab content events ───────────────────────────────
        tabContent.querySelector(`#ace-engine-disabled-${actor.id}`)
            .addEventListener("change", async (e) => {
                await actor.update({ [`flags.${MODULE_ID}.chatDisabled`]: e.target.checked });
            });

        tabContent.querySelector(`#ace-engine-save-voice-${actor.id}`)
            .addEventListener("click", async () => {
                const vid = tabContent.querySelector(`#ace-engine-voice-id-${actor.id}`).value.trim();
                await actor.setFlag(MODULE_ID, "voiceId", vid);
                ui.notifications.info(`Voice ID saved for ${actor.name}`);
            });

        tabContent.querySelector(`#ace-engine-test-${actor.id}`)
            .addEventListener("click", async () => {
                const vid    = tabContent.querySelector(`#ace-engine-voice-id-${actor.id}`).value.trim();
                const phrase = tabContent.querySelector(`#ace-engine-phrase-${actor.id}`).value.trim()
                            || `I am ${actor.name}. Beware.`;
                if (!vid) { ui.notifications.warn("Enter a Voice ID first."); return; }
                const btn = tabContent.querySelector(`#ace-engine-test-${actor.id}`);
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
                try {
                    const { ttsEngine } = await import("./tts.mjs");
                    const result = await ttsEngine.speak(phrase, vid);
                    if (result === "invalid") ui.notifications.error("Voice ID not found on ElevenLabs.");
                    else if (result === "nokey") ui.notifications.error("No ElevenLabs API key in Settings.");
                } catch (e) {
                    console.error(`${TAG} | Voice test:`, e);
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-play"></i> Test';
                }
            });

        tabContent.querySelector(`#ace-engine-stop-${actor.id}`)
            .addEventListener("click", async () => {
                const { ttsEngine } = await import("./tts.mjs");
                ttsEngine.stop();
            });

        tabContent.querySelector(`#ace-engine-open-config-${actor.id}`)
            .addEventListener("click", () => {
                new AIConfigDialog(actor).render(true);
            });

        // ── Tab switching logic ──────────────────────────────────────
        tabBtn.addEventListener("click", () => {
            const isAlreadyActive = tabBtn.classList.contains("active");
            if (isAlreadyActive) {
                tabContent.style.display = "none";
                tabBtn.classList.remove("active");
                const firstNativeBtn = win.querySelector("nav.tabs .item:not(.ace-engine-tab-btn)");
                firstNativeBtn?.click();
            } else {
                win.querySelectorAll(".tab[data-group='primary']").forEach(t => {
                    if (!t.classList.contains("ace-engine-tab-content")) {
                        t.style.display = "";
                        t.classList.remove("active");
                    }
                });
                win.querySelectorAll("nav.tabs .item").forEach(b => b.classList.remove("active"));
                tabContent.style.display = "flex";
                tabContent.classList.add("active");
                tabBtn.classList.add("active");
            }
        });

        win.querySelectorAll("nav.tabs .item:not(.ace-engine-tab-btn)").forEach(btn => {
            btn.addEventListener("click", () => {
                tabContent.style.display = "none";
                tabBtn.classList.remove("active");
            });
        });

        // ── Inject into DOM ──────────────────────────────────────────
        if (tabNav) {
            tabNav.appendChild(tabBtn);
        } else {
            tabBtn.style.cssText += `
                position:absolute;top:4px;right:40px;z-index:100;
                background:#1a2a1a;border:1px solid #3a6a3a;
                border-radius:4px;padding:4px 8px;`;
            win.appendChild(tabBtn);
        }

        const existingTab = win.querySelector(".tab[data-group='primary']");
        const tabParent   = existingTab?.parentElement ?? tabBody;
        tabParent.appendChild(tabContent);

        if (wasActive) {
            const tabBody2 = win.querySelector(".tab[data-group='primary']")?.parentElement;
            if (tabBody2) tabBody2.style.visibility = "hidden";

            requestAnimationFrame(() => {
                if (tabBody2) tabBody2.style.visibility = "";
                win.querySelectorAll(".tab[data-group='primary']").forEach(t => {
                    if (!t.classList.contains("ace-engine-tab-content")) {
                        t.style.display = "none";
                        t.classList.remove("active");
                    }
                });
                win.querySelectorAll("nav.tabs .item").forEach(b => b.classList.remove("active"));
                tabContent.style.display = "flex";
                tabContent.classList.add("active");
                tabBtn.classList.add("active");
            });
        } else {
            tabContent.style.display = "none";
        }
    });
}
