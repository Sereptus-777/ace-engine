// ─── ACE: Engine — NPC AI Setup Dialog ─────────────────────────────────────
// The "robot" GM panel: per-NPC voice, personality, secret lore, GM notes,
// accent override, conversation range, chat disable, memory log/wipe, voice
// test, gender toggle (with bio-pronoun auto-swap on switch).
//
// Moved from ace-envoy/src/main.js (AIConfigDialog class + _swapBioGender)
// as part of the Envoy → Engine merger.

import { assignVoice } from "./voice-engine.mjs";
import { ttsEngine }   from "./tts.mjs";
import { writeBiography } from "../bio-writer.mjs";

const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | Setup";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Safe flag reader. */
function _getFlag(doc, scope, key) {
    try { return doc.getFlag(scope, key); } catch (_) {}
    try { return foundry.utils.getProperty(doc.flags?.[scope] ?? {}, key); } catch (_) {}
    return undefined;
}

export class AIConfigDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(actor) { super(); this.actor = actor; }

    static DEFAULT_OPTIONS = {
        id:     "ace-engine-config",
        classes: ["ace-engine", "ace-npc-config-dialog"],
        window: { title: "AI Setup", resizable: true },
        position: { width: 480, height: "auto" },
    };

    static PARTS = { main: { template: `modules/${MODULE_ID}/templates/npc-config.html` } };

    get title() { return `AI Setup: ${this.actor?.name ?? "NPC"}`; }

    async _prepareContext(options) {
        const memory = this.actor.getFlag(MODULE_ID, "memoryLog")
                    || this.actor.flags?.npclink?.memoryLog || [];
        const voiceGender = (this.actor.getFlag(MODULE_ID, "voiceGender") || "").toLowerCase();
        return {
            isGM:              game.user.isGM,
            chatDisabled:      _getFlag(this.actor, MODULE_ID, "chatDisabled") || false,
            personality:       this.actor.getFlag(MODULE_ID, "personality")    || this.actor.flags?.npclink?.personality    || "",
            secretLore:        this.actor.getFlag(MODULE_ID, "secretLore")     || this.actor.flags?.npclink?.secretLore     || "",
            voiceId:           this.actor.getFlag(MODULE_ID, "voiceId")        || this.actor.flags?.npclink?.voiceId        || "",
            voiceAccent:       this.actor.getFlag(MODULE_ID, "voiceAccent")    || "",
            voiceGender,
            isMale:            voiceGender === "male",
            isFemale:          voiceGender === "female",
            isNone:            !voiceGender || (voiceGender !== "male" && voiceGender !== "female"),
            accentOverride:    this.actor.getFlag(MODULE_ID, "accentOverride") || "",
            conversationRange: this.actor.getFlag(MODULE_ID, "conversationRange") || this.actor.flags?.npclink?.conversationRange || 30,
            memoryText:        memory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n"),
        };
    }

    _onRender(context, options) {
        const el   = this.element;
        const form = el.querySelector("form");
        if (!form) return;

        // Render GM Notes list
        const notes = this.actor.getFlag(MODULE_ID, "gmNotes") || [];
        this._renderNotesList(el, notes);

        // Add Note button
        el.querySelector("#ace-add-note")?.addEventListener("click", async () => {
            const input = el.querySelector("#ace-note-input");
            const text = input?.value?.trim();
            if (!text) return;
            const existing = this.actor.getFlag(MODULE_ID, "gmNotes") || [];
            existing.push(text);
            await this.actor.setFlag(MODULE_ID, "gmNotes", existing);
            input.value = "";
            this._renderNotesList(el, existing);
            ui.notifications.info("Note added.");
        });

        // Enter key on note input
        el.querySelector("#ace-note-input")?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                el.querySelector("#ace-add-note")?.click();
            }
        });

        // Gender toggle
        el.querySelectorAll(".ace-gender-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                const newGender = btn.dataset.gender || "";
                el.querySelectorAll(".ace-gender-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                await this.actor.setFlag(MODULE_ID, "voiceGender", newGender);

                if (!newGender) {
                    // None = mute (construct, ooze, non-speaking)
                    await this.actor.update({
                        [`flags.${MODULE_ID}.-=voiceId`]:       null,
                        [`flags.${MODULE_ID}.-=voiceSettings`]:  null,
                        [`flags.${MODULE_ID}.voiceMuted`]:       true,
                    });
                    const voiceCode = el.querySelector(".ace-npc-voice-id");
                    if (voiceCode) voiceCode.innerHTML = '<span class="ace-muted">Muted — no voice</span>';
                    const voiceInput = el.querySelector("#ai-voice-id-input");
                    if (voiceInput) voiceInput.value = "";
                    ui.notifications.info("Voice muted — this NPC will not speak.");
                } else {
                    // Male/Female: reassign voice with forced gender, preserve accent
                    try {
                        await this.actor.update({
                            [`flags.${MODULE_ID}.-=voiceId`]:       null,
                            [`flags.${MODULE_ID}.-=voiceSettings`]: null,
                            [`flags.${MODULE_ID}.-=voiceMuted`]:    null,
                        });
                        const existingAccent = this.actor.getFlag(MODULE_ID, "voiceAccent") || "";
                        const result = await assignVoice(this.actor, newGender, existingAccent || undefined);
                        if (result) {
                            await this.actor.update({
                                [`flags.${MODULE_ID}.voiceId`]:       result.voiceId,
                                [`flags.${MODULE_ID}.voiceSettings`]: result.voiceSettings,
                                [`flags.${MODULE_ID}.voiceAccent`]:   result.accent,
                                [`flags.${MODULE_ID}.voiceGender`]:   newGender,
                            });
                            const voiceCode = el.querySelector(".ace-npc-voice-id");
                            if (voiceCode) voiceCode.textContent = result.voiceId;
                            const voiceInput = el.querySelector("#ai-voice-id-input");
                            if (voiceInput) voiceInput.value = result.voiceId;
                            const accentBadge = el.querySelector(".ace-badge-accent");
                            if (accentBadge) accentBadge.innerHTML = `<i class="fas fa-globe"></i> ${result.accent}`;
                            ui.notifications.info(`Voice reassigned (${newGender}) — ${result.accent} accent`);
                            _swapBioGender(this.actor, newGender);
                        }
                    } catch (e) {
                        console.warn(`${TAG} | Gender switch voice reassign failed:`, e);
                    }
                }
            });
        });

        // Populate accent override dropdown
        const accentSelect = el.querySelector("#ai-accent-override");
        if (accentSelect) {
            const current = this.actor.getFlag(MODULE_ID, "accentOverride") || "";
            const currentAccent = this.actor.getFlag(MODULE_ID, "voiceAccent") || "region default";
            const accents = [
                ["", `— Auto (${currentAccent}) —`],
                ["british", "British"], ["irish", "Irish"], ["scottish", "Scottish"], ["welsh", "Welsh"],
                ["french", "French"], ["german", "German"], ["italian", "Italian"], ["dutch", "Dutch"],
                ["swedish", "Swedish"], ["norwegian", "Norwegian"], ["danish", "Danish"],
                ["romanian", "Romanian"], ["russian", "Russian"], ["ukrainian", "Ukrainian"], ["polish", "Polish"],
                ["middle eastern", "Middle Eastern"], ["indian", "Indian"],
                ["african", "African"], ["nigerian", "Nigerian"],
                ["australian", "Australian"], ["brazilian", "Brazilian"],
                ["korean", "Korean"], ["japanese", "Japanese"], ["chinese", "Chinese"],
            ];
            accentSelect.innerHTML = accents.map(([val, label]) =>
                `<option value="${val}" ${val === current ? "selected" : ""}>${label}</option>`
            ).join("");
        }

        // Voice Test button
        el.querySelector("#ai-test-voice")?.addEventListener("click", async () => {
            const voiceId  = el.querySelector("#ai-voice-id-input")?.value?.trim()
                          || this.actor.getFlag(MODULE_ID, "voiceId") || "";
            const testText = el.querySelector("#ai-test-text")?.value?.trim()
                          || `Hello, I am ${this.actor.name}. How can I help you?`;
            const testBtn  = el.querySelector("#ai-test-voice");

            if (!voiceId) {
                ui.notifications.warn("No voice assigned. Drop token on a scene or paste a Voice ID.");
                return;
            }

            testBtn.disabled = true;
            testBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';

            try {
                const result = await ttsEngine.speak(testText, voiceId);
                if (result === "invalid") ui.notifications.error("Voice ID not found on ElevenLabs — check the ID.");
                else if (result === "nokey") ui.notifications.warn("No ElevenLabs key — add one in ACE Engine → AI Setup to preview premium voices.");
            } catch (e) {
                ui.notifications.error("Test failed — check console.");
                console.error(`${TAG} | Voice test error:`, e);
            } finally {
                testBtn.disabled = false;
                testBtn.innerHTML = '<i class="fas fa-play"></i>';
            }
        });

        el.querySelector("#ai-stop-voice")?.addEventListener("click", () => {
            ttsEngine.stop();
        });

        // Form submit
        form.addEventListener("submit", async (ev) => {
            ev.preventDefault();
            const fd = new FormData(form);
            await this.actor.setFlag(MODULE_ID, "personality",       fd.get("personality") || "");
            await this.actor.setFlag(MODULE_ID, "secretLore",        fd.get("secretLore")  || "");
            await this.actor.setFlag(MODULE_ID, "voiceId",           fd.get("voiceId")     || "");
            await this.actor.setFlag(MODULE_ID, "conversationRange", parseInt(fd.get("conversationRange")) || 30);
            await this.actor.setFlag(MODULE_ID, "chatDisabled",      fd.get("chatDisabled") === "on");
            await this.actor.setFlag(MODULE_ID, "accentOverride",    fd.get("accentOverride") || "");

            if (fd.get("clearMemory") === "on") {
                await this.actor.setFlag(MODULE_ID, "memoryLog", []);
                ui.notifications.info(`Memory wiped for ${this.actor.name}`);
            } else {
                ui.notifications.info(`AI Profile updated for ${this.actor.name}`);
            }
            this.close();
        });
    }

    _renderNotesList(el, notes) {
        const list = el.querySelector("#ace-notes-list");
        if (!list) return;

        if (!notes.length) {
            list.innerHTML = '<div class="ace-muted" style="padding:4px 0; font-size:0.9em;">No notes yet — add knowledge the AI will use in conversations.</div>';
            return;
        }

        list.innerHTML = notes.map((note, i) =>
            `<div class="ace-note-item">
                <span class="ace-note-text">${note.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>
                <button type="button" class="ace-note-delete" data-index="${i}" title="Remove note"><i class="fas fa-times"></i></button>
            </div>`
        ).join("");

        list.querySelectorAll(".ace-note-delete").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                const idx = parseInt(e.currentTarget.dataset.index);
                const current = this.actor.getFlag(MODULE_ID, "gmNotes") || [];
                current.splice(idx, 1);
                await this.actor.setFlag(MODULE_ID, "gmNotes", current);
                this._renderNotesList(el, current);
            });
        });
    }
}

// ─── BIO GENDER PRONOUN AUTO-SWAP ──────────────────────────────────────────

/** Swap pronouns + gendered nouns in the actor's bio HTML when gender changes.
 *  Only edits text nodes (skips HTML tags). */
async function _swapBioGender(actor, newGender) {
    const bioHtml = actor.system?.details?.biography?.value || "";
    if (!bioHtml.trim()) return;

    const MALE_TO_FEMALE = [
        [/\bHe\b/g,  "She"],  [/\bhe\b/g,  "she"],
        [/\bHim\b/g, "Her"],  [/\bhim\b/g, "her"],
        [/\bHis\b/g, "Her"],  [/\bhis\b/g, "her"],
        [/\bHimself\b/g, "Herself"], [/\bhimself\b/g, "herself"],
        [/\bKing\b/g, "Queen"],     [/\bking\b/g, "queen"],
        [/\bLord\b/g, "Lady"],      [/\blord\b/g, "lady"],
        [/\bPrince\b/g, "Princess"],[/\bprince\b/g, "princess"],
        [/\bDuke\b/g, "Duchess"],   [/\bduke\b/g, "duchess"],
        [/\bCount\b/g, "Countess"], [/\bcount\b/g, "countess"],
        [/\bBaron\b/g, "Baroness"], [/\bbaron\b/g, "baroness"],
        [/\bEmperor\b/g, "Empress"],[/\bemperor\b/g, "empress"],
        [/\bPriest\b/g, "Priestess"],[/\bpriest\b/g, "priestess"],
        [/\bFather\b/g, "Mother"],  [/\bfather\b/g, "mother"],
        [/\bBrother\b/g, "Sister"], [/\bbrother\b/g, "sister"],
        [/\bSon\b/g, "Daughter"],   [/\bson\b/g, "daughter"],
        [/\bMan\b/g, "Woman"],      [/\bman\b/g, "woman"],
        [/\bBoy\b/g, "Girl"],       [/\bboy\b/g, "girl"],
    ];

    const FEMALE_TO_MALE = [
        [/\bHerself\b/g, "Himself"], [/\bherself\b/g, "himself"],
        [/\bHers\b/g, "His"],  [/\bhers\b/g, "his"],
        [/\bShe\b/g,  "He"],   [/\bshe\b/g,  "he"],
        [/\bHer(?=\s+\w)/g, "His"],  [/\bher(?=\s+\w)/g, "his"],
        [/\bHer\b/g, "Him"],   [/\bher\b/g, "him"],
        [/\bQueen\b/g, "King"],     [/\bqueen\b/g, "king"],
        [/\bLady\b/g, "Lord"],      [/\blady\b/g, "lord"],
        [/\bPrincess\b/g, "Prince"],[/\bprincess\b/g, "prince"],
        [/\bDuchess\b/g, "Duke"],   [/\bduchess\b/g, "duke"],
        [/\bCountess\b/g, "Count"], [/\bcountess\b/g, "count"],
        [/\bBaroness\b/g, "Baron"], [/\bbaroness\b/g, "baron"],
        [/\bEmpress\b/g, "Emperor"],[/\bempress\b/g, "emperor"],
        [/\bPriestess\b/g, "Priest"],[/\bpriestess\b/g, "priest"],
        [/\bMother\b/g, "Father"],  [/\bmother\b/g, "father"],
        [/\bSister\b/g, "Brother"], [/\bsister\b/g, "brother"],
        [/\bDaughter\b/g, "Son"],   [/\bdaughter\b/g, "son"],
        [/\bWoman\b/g, "Man"],      [/\bwoman\b/g, "man"],
        [/\bGirl\b/g, "Boy"],       [/\bgirl\b/g, "boy"],
    ];

    const swaps = newGender === "female" ? MALE_TO_FEMALE : FEMALE_TO_MALE;

    const parts = bioHtml.split(/(<[^>]+>)/);
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].startsWith("<")) continue;
        for (const [pattern, replacement] of swaps) {
            parts[i] = parts[i].replace(pattern, replacement);
        }
    }
    const newBio = parts.join("");

    if (newBio !== bioHtml) {
        // Serialized via bio-writer (v1.6.3) so a concurrent regen or
        // story-note append doesn't lose the pronoun swap.
        await writeBiography(actor, newBio, `pronoun-swap:${newGender}`);
        console.log(`${TAG} | Swapped bio pronouns to ${newGender} for ${actor.name}`);
    }
}
