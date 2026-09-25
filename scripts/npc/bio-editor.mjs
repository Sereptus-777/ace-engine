// ═══════════════════════════════════════════════════════════════════════════
//  ACE: Engine — the Biography window
// ───────────────────────────────────────────────────────────────────────────
//  Johnny, 2026-09-23: "I think I want a button where you press it, and it
//  opens up a whole thing about the biography or whatever, a whole new window
//  with the editable whatever... It's got to have the option to make an AI bio,
//  or one I want to copy and paste, or something I just want to put in there.
//  How about 'Edit Bio'? Also, I've got to be able to add to bio if I want to."
//
//  ⚠️ WHY A WINDOW AND NOT A TICK. A tick can only ever mean "replace what is
//  there with an AI one". Three of the four things he asked for are not that.
//  An editable window is all four at once: the AI writes into it, he pastes
//  into it, he types into it, and he adds to the end of it.
//
//  ⚠️ ONE BIOGRAPHY SURFACE. This window is the only place a biography is
//  edited by hand, and it is reachable from the token HUD, from the NPC setup
//  dialog and from the API. It writes through the same bio-writer queue the
//  generator uses, so a hand edit and an AI write can never stomp each other.
// ═══════════════════════════════════════════════════════════════════════════

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Biography";

/** The actor behind whatever was handed in, plus a token document if there is one. */
function _resolve(target) {
    const doc = target?.document ?? target;
    if (doc?.documentName === "Token") return { actor: doc.actor ?? null, tokenDoc: doc };
    if (doc?.documentName === "Actor") {
        // A token on this scene lets the AI write with scene context; without
        // one it can still be edited by hand.
        const tok = canvas.tokens?.placeables?.find(t => t.actor?.id === doc.id)?.document ?? null;
        return { actor: doc, tokenDoc: tok };
    }
    return { actor: doc?.actor ?? null, tokenDoc: doc?.update ? doc : null };
}

/**
 * What is actually written about this creature, and which box it is in.
 *
 * ⚠️🔴 dnd5e KEEPS TWO (2026-09-24). `value` is the GM's biography and `public`
 * is the one players can read, and this window read only the first — so Aryel,
 * whose history was in the other box, opened as "Nothing written yet" while the
 * sheet plainly had one. It reads both now, and SAVES BACK TO THE ONE IT READ,
 * because quietly moving his text from the public box into the private one
 * would hide it from his table.
 */
function _readBiography(actor) {
    const bio = actor?.system?.details?.biography ?? {};
    const value = String(bio.value ?? "");
    const shared = String(bio.public ?? "");
    if (value.trim()) return { html: value, field: "system.details.biography.value", where: "the GM biography" };
    if (shared.trim()) return { html: shared, field: "system.details.biography.public", where: "the public biography" };
    return { html: "", field: "system.details.biography.value", where: "" };
}

export class BiographyEditor {

    static _el = null;
    static _dirty = false;
    static _registered = false;

    // ── The token HUD button ────────────────────────────────────────────
    // His words, 2026-09-23: "There's going to have to be a new bio button on
    // this list, which opens a different pop-up." Beside the quill, which
    // WRITES one, and the flag, which handles identity.
    /**
     * ⚠️ NOT ON THE HUD ANY MORE (2026-09-23), same call as the faction flag:
     * one button on the token HUD, the quill, and the biography is reached by a
     * button inside the popup it opens. This window is unchanged; only the way
     * in moved.
     */
    static register() {
        console.log(`${TAG} | the book is not drawn on the token HUD: the setup popup has a Biography button instead (2026-09-23).`);
        return;
    }

    /** The book as it was, for a table that wants it back. Nothing calls this. */
    static registerHudBook() {
        if (BiographyEditor._registered) return;
        BiographyEditor._registered = true;

        Hooks.on("renderTokenHUD", (app, root, data) => {
            try {
                if (!game.user?.isGM) return;

                // V13 hands a plain element where V12 handed jQuery.
                const el = root?.jquery ? root[0] : (root instanceof HTMLElement ? root : app?.element);
                if (!el) return;

                const token = canvas.tokens?.get(data?._id ?? app?.object?.id);
                const actor = token?.actor;
                if (!actor || (actor.type !== "npc" && actor.type !== "character")) return;

                el.querySelectorAll(".ace-engine-biography").forEach(n => n.remove());

                const col = el.querySelector(".col.right") ?? el.querySelector(".col.left");
                if (!col) {
                    // ⚠️ SAY IT. A button that silently fails to appear looks
                    // exactly like a feature nobody built.
                    console.warn(`${TAG} | the token HUD has no control column, so the biography button cannot be shown. `
                        + `Use game.modules.get("${MODULE_ID}").api.editBiography(token.document) instead.`);
                    return;
                }

                const written = _readBiography(actor).html.trim().length > 0;
                const btn = document.createElement("div");
                btn.classList.add("control-icon", "ace-engine-biography");
                if (written) btn.classList.add("active");
                btn.dataset.action = `${MODULE_ID}.biography`;
                btn.setAttribute("data-tooltip", written
                    ? `Biography for ${token.document.name || actor.name} — read it, change it, or add to it`
                    : `${token.document.name || actor.name} has no biography — write one, or paste your own`);
                btn.innerHTML = `<i class="fas fa-book-open" style="color:${written ? "#c9a84c" : "#ffd76a"};"></i>`;
                btn.addEventListener("click", (ev) => {
                    ev.preventDefault(); ev.stopPropagation();
                    BiographyEditor.open(token.document);
                });
                col.appendChild(btn);
            } catch (err) {
                console.error(`${TAG} | the biography HUD button failed to draw:`, err);
            }
        });

        console.log(`${TAG} | biography button ready on the token HUD.`);
    }

    /**
     * @param {Actor|Token|TokenDocument} target
     * @param {object} [opts]
     * @param {string} [opts.renamedFrom]  the display name it had a moment ago
     * @param {string} [opts.renamedTo]    the display name it has now
     *   Together those draw the bar across the top: a rename is the one moment
     *   a biography is guaranteed to be talking about somebody who no longer
     *   exists (2026-09-23).
     */
    static open(target, opts = {}) {
        try {
            if (!game.user?.isGM) { ui.notifications?.warn("Only the GM can edit a biography."); return; }
            const { actor, tokenDoc } = _resolve(target);
            if (!actor) { ui.notifications?.warn("ACE: there is no creature to write a biography for."); return; }
            BiographyEditor.close();
            BiographyEditor._render(actor, tokenDoc, opts);
        } catch (err) {
            console.error(`${TAG} | could not open the biography window:`, err);
            ui.notifications?.error("ACE: the biography window could not open — see the console.");
        }
    }

    static close() {
        try { BiographyEditor._el?.remove(); } catch (_) {}
        BiographyEditor._el = null;
        BiographyEditor._dirty = false;
        try { document.removeEventListener("keydown", BiographyEditor._onKey, true); } catch (_) {}
    }

    static _onKey(ev) {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        BiographyEditor._tryClose();
    }

    // ⚠️ AN EDIT IS NOT THROWN AWAY BY A STRAY KEY. Escape and the backdrop
    // close a window he has not touched, and refuse one he has.
    static _tryClose() {
        if (!BiographyEditor._dirty) { BiographyEditor.close(); return; }
        ui.notifications?.warn("You have changes in the biography. Press Save, or Discard to throw them away.");
    }

    static _render(actor, tokenDoc, opts = {}) {
        const backdrop = document.createElement("div");
        Object.assign(backdrop.style, {
            position: "fixed", inset: "0", zIndex: "100001",
            background: "rgba(0,0,0,0.6)", display: "flex",
            alignItems: "center", justifyContent: "center",
        });
        backdrop.addEventListener("mousedown", (ev) => { if (ev.target === backdrop) BiographyEditor._tryClose(); });

        const panel = document.createElement("div");
        Object.assign(panel.style, {
            width: "min(94vw, 1000px)", height: "min(88vh, 820px)",
            display: "flex", flexDirection: "column",
            background: "linear-gradient(180deg,#15110d 0%,#0c0a08 100%)",
            border: "2px solid #d4af37", borderRadius: "10px",
            boxShadow: "0 12px 44px rgba(0,0,0,0.72)", color: "#f0e4c0",
            fontFamily: "'Signika','Helvetica Neue',sans-serif", overflow: "hidden",
        });
        panel.addEventListener("mousedown", (ev) => ev.stopPropagation());

        // ── Header ──
        const header = document.createElement("div");
        Object.assign(header.style, {
            flex: "0 0 auto", display: "flex", alignItems: "center", gap: "12px",
            padding: "14px 16px", borderBottom: "1px solid #4a3a28",
            background: "linear-gradient(180deg,#1d1710,#15110d)",
        });
        const shown = String(actor.getFlag?.(MODULE_ID, "flavorName") || tokenDoc?.name || actor.name || "");
        header.innerHTML = `<i class="fas fa-feather-pointed" style="color:#d4af37;font-size:20px;"></i>
          <div style="font-size:18px;font-weight:700;color:#d4af37;letter-spacing:.5px;">BIOGRAPHY</div>
          <div style="font-size:15px;color:#c9b48a;">${foundry.utils.escapeHTML(shown)}${
            shown !== actor.name ? ` <span style="color:#7a6a48;">(sheet: ${foundry.utils.escapeHTML(String(actor.name))})</span>` : ""}</div>`;

        const closeBtn = document.createElement("button");
        closeBtn.type = "button"; closeBtn.innerHTML = `<i class="fas fa-times"></i>`;
        Object.assign(closeBtn.style, {
            marginLeft: "auto", fontSize: "17px", background: "transparent", border: "none",
            color: "#c9b48a", cursor: "pointer", padding: "4px 8px",
        });
        closeBtn.addEventListener("click", () => BiographyEditor._tryClose());
        header.appendChild(closeBtn);

        // ── The biography itself, editable ──
        // contenteditable rather than a textarea: the biography is HTML, and he
        // must be able to paste a paragraph from anywhere without it arriving
        // as a wall of tags.
        const body = document.createElement("div");
        body.contentEditable = "true";
        body.spellcheck = true;
        Object.assign(body.style, {
            flex: "1", overflowY: "auto", padding: "18px 20px",
            fontSize: "16px", lineHeight: "1.6", color: "#f0e4c0",
            background: "#0c0a08", outline: "none",
        });
        const _held = _readBiography(actor);
        body.innerHTML = _held.html;
        if (_held.where === "the public biography") {
            console.log(`${TAG} | ${actor.name}: this history is in the public biography, so that is the box it is saved back to.`);
        }
        if (!body.innerHTML.trim()) {
            body.innerHTML = `<p style="color:#7a6a48;">Nothing written yet. Type here, paste something in, or press "Write one with the AI".</p>`;
        }
        // ⚠️ Declared before the listener that calls it: an input event cannot
        // fire during this render, but a binding read before its declaration is
        // a trap the next edit falls into.
        let syncState = () => {};
        body.addEventListener("input", () => { BiographyEditor._dirty = true; syncState(); });

        // ── The rename bar ──────────────────────────────────────────────
        // ⚠️ HIS CASE, 2026-09-23: "I've changed the name on this token, and I
        // looked at the biography, and it still says all the same shit under the
        // old name." The silent swap only fires when it HAD a display name to
        // replace; a creature showing its sheet name has none, which is the
        // common case. So the rename says so, counts the places out loud, and
        // lets him press once.
        const from = String(opts.renamedFrom ?? "").trim();
        const to   = String(opts.renamedTo ?? "").trim();
        let renameBar = null;
        if (to && to !== from) {
            renameBar = document.createElement("div");
            Object.assign(renameBar.style, {
                flex: "0 0 auto", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap",
                padding: "12px 16px", borderBottom: "1px solid #4a3a28",
                background: "linear-gradient(180deg,#1a2414,#111a0e)",
            });

            const current = _readBiography(actor).html;
            // Every spelling it might be using, and how many times each appears.
            const candidates = _nameCandidates(from, actor)
                .filter(n => n.toLowerCase() !== to.toLowerCase())
                .map(n => ({ name: n, n: _countName(current, n) }))
                .filter(c => c.n > 0);
            const hits = candidates.reduce((sum, c) => sum + c.n, 0);
            // What to call it in the button: whichever spelling appears most.
            const worst = candidates.slice().sort((a, b) => b.n - a.n)[0]?.name ?? from;

            const said = document.createElement("div");
            Object.assign(said.style, { fontSize: "15px", color: "#e9dcb0", marginRight: "auto", lineHeight: "1.45" });
            said.innerHTML = !current.trim()
                ? `This one is now called <strong style="color:#ffe75a;">${foundry.utils.escapeHTML(to)}</strong>. There is no biography yet.`
                : (hits
                    ? `This one is now called <strong style="color:#ffe75a;">${foundry.utils.escapeHTML(to)}</strong>. The biography still says <strong style="color:#ffb4b4;">${
                        foundry.utils.escapeHTML(candidates.map(c => c.name).join("&rdquo;, &ldquo;"))}</strong>.`
                    : `This one is now called <strong style="color:#ffe75a;">${foundry.utils.escapeHTML(to)}</strong>. The biography does not name it, so there is nothing to swap. Edit it here, or have the AI write a new one.`);
            renameBar.appendChild(said);

            if (hits) {
                const swap = document.createElement("button");
                swap.type = "button";
                swap.innerHTML = `<i class="fas fa-right-left"></i> Replace "${foundry.utils.escapeHTML(worst)}" with "${foundry.utils.escapeHTML(to)}" (${hits} place${hits === 1 ? "" : "s"})`;
                Object.assign(swap.style, {
                    fontSize: "15px", fontWeight: "700", padding: "9px 16px", borderRadius: "6px", cursor: "pointer",
                    border: "2px solid #7bd88f", background: "linear-gradient(180deg,#1f8a45,#116030)", color: "#f4ffe9",
                });
                swap.addEventListener("click", () => {
                    // ⚠️ IN THE WINDOW, NOT ON THE SHEET. Nothing is written
                    // until Save, so a swap he did not mean is one Discard away.
                    // Longest spelling first: see _nameCandidates.
                    let next = body.innerHTML;
                    for (const c of candidates) next = _swapName(next, c.name, to);
                    body.innerHTML = next;
                    BiographyEditor._dirty = true;
                    syncState();
                    swap.disabled = true;
                    swap.style.opacity = "0.5";
                    said.innerHTML = `Swapped. <strong style="color:#ffe75a;">Press Save</strong> to keep it, or Discard to put it back.`;
                });
                renameBar.appendChild(swap);
            }
        }

        // ── Footer ──
        const footer = document.createElement("div");
        Object.assign(footer.style, {
            flex: "0 0 auto", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
            padding: "12px 16px", borderTop: "1px solid #4a3a28",
            background: "linear-gradient(180deg,#1d1710,#15110d)",
        });

        const hint = document.createElement("div");
        Object.assign(hint.style, { fontSize: "14px", color: "#9b8a62", marginRight: "auto" });
        hint.textContent = "Type, paste, or add to the end. Nothing is saved until you press Save.";

        const mkBtn = (label, icon, primary) => {
            const b = document.createElement("button");
            b.type = "button";
            b.innerHTML = `<i class="fas ${icon}"></i> ${label}`;
            Object.assign(b.style, {
                fontSize: "15px", fontWeight: "600", padding: "9px 16px", borderRadius: "6px",
                cursor: "pointer", display: "flex", alignItems: "center", gap: "8px",
                border: primary ? "2px solid #d4af37" : "1px solid #6b5530",
                background: primary ? "#d4af37" : "#0c0a08",
                color: primary ? "#15110d" : "#e9dcb0",
            });
            return b;
        };

        const aiBtn = mkBtn("Write one with the AI", "fa-wand-magic-sparkles", false);
        // ⚠️ SAY WHICH IT IS. "Write one" and "add to the one I have" are two
        // different promises, and the window knows which one it can keep.
        const _syncAiLabel = () => {
            const has = body.innerHTML.replace(/<[^>]*>/g, "").trim().length > 0;
            aiBtn.innerHTML = has
                ? `<i class="fas fa-wand-magic-sparkles"></i> Build on this with the AI`
                : `<i class="fas fa-wand-magic-sparkles"></i> Write one with the AI`;
        };
        const discardBtn = mkBtn("Discard", "fa-rotate-left", false);
        const saveBtn = mkBtn("Save", "fa-floppy-disk", true);

        syncState = () => {
            _syncAiLabel();
            discardBtn.style.opacity = BiographyEditor._dirty ? "1" : "0.45";
            saveBtn.style.opacity    = BiographyEditor._dirty ? "1" : "0.45";
        };
        syncState();

        // ⚠️ THE AI WRITES THROUGH THE ONE GENERATOR, not a second prompt built
        // here. It writes to the creature and then this window reloads from it,
        // so what he is looking at is what is actually on the sheet.
        aiBtn.addEventListener("click", async () => {
            if (!tokenDoc) {
                ui.notifications?.warn("ACE: put a token for this creature on the scene first, then the AI can write with the scene in mind.");
                return;
            }
            // ⚠️ IT ALWAYS READS WHAT IS THERE FIRST (his rule, 2026-09-24:
            // "It always has to look at what's already on there and then
            // create."). Whatever is in this window right now, including an
            // edit he has not saved yet, is handed to the writer as history to
            // carry forward rather than something to replace.
            const _carry = body.innerHTML.replace(/<[^>]*>/g, "").trim() ? body.innerHTML : "";

            aiBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${_carry ? "Adding to it…" : "Writing…"}`;
            aiBtn.disabled = true;
            try {
                const { queueBioGeneration } = await import("./bio-generator.mjs");
                const res = await queueBioGeneration(tokenDoc, { force: true, buildOn: _carry });
                const fresh = _readBiography(actor).html;
                if (fresh.trim()) {
                    body.innerHTML = fresh;
                    BiographyEditor._dirty = false;
                    syncState();
                    ui.notifications?.info(`ACE wrote a new biography for ${actor.name}.`);
                } else {
                    ui.notifications?.warn(`ACE wrote nothing for ${actor.name}${res?.skipped ? `: ${res.skipped}` : ""}.`);
                }
            } catch (err) {
                console.error(`${TAG} | the AI write failed for ${actor.name}:`, err);
                ui.notifications?.error("ACE: the AI could not write a biography — see the console.");
            } finally {
                _syncAiLabel();
                aiBtn.disabled = false;
            }
        });

        discardBtn.addEventListener("click", () => {
            body.innerHTML = _readBiography(actor).html;
            BiographyEditor._dirty = false;
            syncState();
        });

        saveBtn.addEventListener("click", async () => {
            const html = body.innerHTML.trim();
            try {
                const { writeBiography } = await import("../bio-writer.mjs");
                if (_held.field === "system.details.biography.public") {
                    await actor.update({ [_held.field]: html });
                } else {
                    await writeBiography(actor, html, "bio-editor");
                }
                BiographyEditor._dirty = false;
                ui.notifications?.info(`Biography saved for ${actor.name}.`);
                BiographyEditor.close();
            } catch (err) {
                console.error(`${TAG} | saving the biography failed for ${actor.name}:`, err);
                ui.notifications?.error("ACE: the biography could not be saved — see the console.");
            }
        });

        footer.appendChild(hint);
        footer.appendChild(aiBtn);
        footer.appendChild(discardBtn);
        footer.appendChild(saveBtn);

        panel.appendChild(header);
        if (renameBar) panel.appendChild(renameBar);
        panel.appendChild(body);
        panel.appendChild(footer);
        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);

        BiographyEditor._el = backdrop;
        BiographyEditor._dirty = false;
        document.addEventListener("keydown", BiographyEditor._onKey, true);
        body.focus();
        console.log(`${TAG} | biography window open for ${actor.name}.`);
    }
}

/**
 * One boundary rule for both counting and swapping.
 *
 * ⚠️ Proven against "Grizzle's axe" (renamed), "Grizzled veteran" (left alone),
 * "O'Grizzle" (left alone) and "(Grizzle)" (renamed). An apostrophe is barred
 * BEFORE the name and allowed after it; that one difference is the whole rule.
 */
function _nameRe(name) {
    const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w'])${esc}(?![\\w])`, "g");
}

/**
 * Every spelling of "the name it had" that a biography might really contain.
 *
 * ⚠️🔴 HIS TABLE, 2026-09-24. The bar said the biography did not use "Carrion
 * Ogre (1)" anywhere, which was true and useless: the token label carries
 * Foundry's duplicate counter and the prose says "Carrion Ogre". So the one
 * button he needed never appeared, on the one job he wanted done.
 *
 * Longest first, so "Carrion Ogre (1)" is swapped before "Carrion Ogre" and a
 * half-replaced label cannot be left behind.
 *
 * ⚠️ CASE MATTERS, deliberately. "Carrion Ogre" capitalised is the creature
 * being named; "carrion ogre" in the middle of a sentence is the species being
 * described, and turning that into "the Gromm the Unyielding stalks the halls"
 * would wreck the sentence it was trying to fix.
 */
function _nameCandidates(previous, actor) {
    const strip = (n) => String(n ?? "")
        .replace(/\s*\((?:\d+|copy|\d+\s*of\s*\d+)\)\s*$/i, "")   // "(1)", "(copy)"
        .replace(/\s*#?\d+\s*$/, "")                                   // "Goblin 2", "Goblin #2"
        .trim();

    let original = "";
    try { original = String(actor?.getFlag?.(MODULE_ID, "originalName") ?? "").trim(); } catch (_) { original = ""; }

    const raw = [previous, strip(previous), actor?.name, strip(actor?.name), original, strip(original)];
    const seen = new Set();
    const out = [];
    for (const n of raw) {
        const name = String(n ?? "").trim();
        if (name.length < 3) continue;          // "a", "1" — never worth swapping
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(name);
    }
    return out.sort((a, b) => b.length - a.length);
}

function _countName(html, name) {
    if (!html || !name) return 0;
    return (html.match(_nameRe(name)) ?? []).length;
}

function _swapName(html, from, to) {
    if (!html || !from) return html;
    return html.replace(_nameRe(from), to);
}

/** A yes/no the GM actually sees, rather than a silent assumption. */
async function _confirm(question) {
    try {
        return await Dialog.confirm({
            title: "ACE",
            content: `<p style="font-size:16px;">${foundry.utils.escapeHTML(question)}</p>`,
            defaultYes: false,
        });
    } catch (_) { return false; }
}
