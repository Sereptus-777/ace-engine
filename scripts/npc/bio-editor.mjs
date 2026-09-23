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

                const written = String(actor.system?.details?.biography?.value ?? "").trim().length > 0;
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
     */
    static open(target) {
        try {
            if (!game.user?.isGM) { ui.notifications?.warn("Only the GM can edit a biography."); return; }
            const { actor, tokenDoc } = _resolve(target);
            if (!actor) { ui.notifications?.warn("ACE: there is no creature to write a biography for."); return; }
            BiographyEditor.close();
            BiographyEditor._render(actor, tokenDoc);
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

    static _render(actor, tokenDoc) {
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
        body.innerHTML = String(actor.system?.details?.biography?.value ?? "");
        if (!body.innerHTML.trim()) {
            body.innerHTML = `<p style="color:#7a6a48;">Nothing written yet. Type here, paste something in, or press "Write one with the AI".</p>`;
        }
        // ⚠️ Declared before the listener that calls it: an input event cannot
        // fire during this render, but a binding read before its declaration is
        // a trap the next edit falls into.
        let syncState = () => {};
        body.addEventListener("input", () => { BiographyEditor._dirty = true; syncState(); });

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
        const discardBtn = mkBtn("Discard", "fa-rotate-left", false);
        const saveBtn = mkBtn("Save", "fa-floppy-disk", true);

        syncState = () => {
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
            if (BiographyEditor._dirty && !(await _confirm("Replace what is in this window with a new AI biography?"))) return;
            const held = aiBtn.innerHTML;
            aiBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Writing…`;
            aiBtn.disabled = true;
            try {
                const { queueBioGeneration } = await import("./bio-generator.mjs");
                const res = await queueBioGeneration(tokenDoc, { force: true });
                const fresh = String(actor.system?.details?.biography?.value ?? "");
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
                aiBtn.innerHTML = held;
                aiBtn.disabled = false;
            }
        });

        discardBtn.addEventListener("click", () => {
            body.innerHTML = String(actor.system?.details?.biography?.value ?? "");
            BiographyEditor._dirty = false;
            syncState();
        });

        saveBtn.addEventListener("click", async () => {
            const html = body.innerHTML.trim();
            try {
                const { writeBiography } = await import("../bio-writer.mjs");
                await writeBiography(actor, html, "bio-editor");
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
