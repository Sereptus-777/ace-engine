// ─── ACE: Engine — NPC Memory & Journal System ─────────────────────────────
// Per-NPC narrative diary stored as Foundry Journal entries. Summarizes
// conversations into prose chronicle entries and pushes deeds into the
// engine's fame/reputation pipeline.
//
// Moved from ace-envoy/src/ai/memory.js as part of the Envoy → Engine merger.
// EngineBridge calls replaced with direct game.modules.get(MODULE_ID).api.*
// (engine reaches its own API by module id; no envoy bridge needed).

import { AIHandler }       from "./conversation-engine.mjs";
import { logFactionEvent } from "./faction-memory.mjs";
import { isAIFailure }     from "./ai-failure.mjs";
import { getSecret, getSecretVault } from "../settings.mjs";

const MODULE_ID       = "ace-engine";
const JOURNAL_PREFIX  = "[AI Memory]";
const FOLDER_NAME     = "\u{1F4AC} ACE Engine";
const FOLDER_LEGACY   = ["ACE: NPC Memories", "AI NPC Memories", "\u{1F4AC} ACE Envoy"];

/** Read engine's AI config — replaces envoy's getEnvoyAIConfig. */
function getEnvoyAIConfig() {
    try {
        return {
            provider: game.settings.get(MODULE_ID, "aiProvider") || "ollama",
            apiKey:   getSecret("apiKey")     || "",
            apiUrl:   game.settings.get(MODULE_ID, "apiUrl")     || "",
            modelName: game.settings.get(MODULE_ID, "modelName") || "",
        };
    } catch (_) {
        return { provider: "ollama", apiKey: "", apiUrl: "", modelName: "" };
    }
}

/** Reach engine's own public API (used to log notes, deeds, conversation events). */
function _engineApi() {
    try { return game.modules.get(MODULE_ID)?.api ?? null; }
    catch (_) { return null; }
}

// ── Get or create the memory folder ─────────────────────────────────────────
async function getOrCreateFolder() {
    let folder = game.folders.find(f => f.name === FOLDER_NAME && f.type === "JournalEntry");
    if (!folder) {
        // Check for legacy folder names and rename if found
        for (const oldName of FOLDER_LEGACY) {
            folder = game.folders.find(f => f.name === oldName && f.type === "JournalEntry");
            if (folder) {
                await folder.update({ name: FOLDER_NAME });
                console.log(`ACE: Engine | Renamed journal folder "${oldName}" → "${FOLDER_NAME}"`);
                break;
            }
        }
        if (!folder) {
            folder = await Folder.create({ name: FOLDER_NAME, type: "JournalEntry", parent: null, color: "#c9a84c" });
            console.log(`ACE: Engine | Created journal folder "${FOLDER_NAME}"`);
        }
    }
    return folder;
}

// ── Get or create the memory journal for an NPC ─────────────────────────────
export async function getOrCreateJournal(actor) {
    const name = `${JOURNAL_PREFIX} ${actor.name}`;
    let journal = game.journal.find(j => j.name === name);
    if (!journal) {
        const folder = await getOrCreateFolder();
        journal = await JournalEntry.create({
            name,
            folder: folder.id,
            ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
            flags: { "ace-engine": { actorId: actor.id } }
        });
        // Create a single "Chronicle" page — narrative diary entries
        await journal.createEmbeddedDocuments("JournalEntryPage", [
            {
                name: "Chronicle",
                type: "text",
                text: { content: `<h2>${actor.name} — Chronicle</h2>\n<p><em>No encounters recorded yet.</em></p>\n`, format: 1 }
            }
        ]);
        console.log(`ACE: Engine | Created memory journal for ${actor.name}`);
    }

    // Move to folder if it exists but isn't in the folder yet
    const folder = await getOrCreateFolder();
    if (journal.folder?.id !== folder.id) {
        await journal.update({ folder: folder.id });
    }

    return journal;
}

// ── Legacy: appendExchangeToLog (kept for socket handler compat) ─────────────
// No longer called per-exchange. Raw data is preserved in actor flags + ACE Engine.
export async function appendExchangeToLog(actor, playerName, playerText, npcResponse) {
    // No-op — raw transcripts are no longer written to journals.
    // Full conversation history is saved to actor.flags["ace-engine"]["memoryLog"]
    // and pushed to ACE Engine on conversation close.
    return;
}

// ── Summarize conversation and append narrative diary entry to Chronicle ──────
export async function summarizeAndSaveSession(actor, history, playerName) {
    if (!game.user.isGM) {
        game.socket.emit("module.ace-engine", {
            action:     "summarizeSession",
            userId:     game.user.id,   // ⚠️ required: the GM refuses a request that names nobody
            actorId:    actor.id,
            actorName:  actor.name,
            history,
            playerName
        });
        return;
    }
    if (!history?.length) return;

    try {
        const { provider, apiKey } = getEnvoyAIConfig();

        const transcript = history.map(m =>
            `${m.role === "user" ? playerName : actor.name}: ${m.content}`
        ).join("\n");

        const summaryPrompt = `You are a STRICTLY FACTUAL transcript summarizer. Your job is to summarize what was LITERALLY SAID in a conversation between ${playerName} (player character) and ${actor.name} (NPC) — NOTHING ELSE.

ABSOLUTE RULES (violating these is the worst possible failure):
- Do NOT invent characters, items, locations, events, motivations, deals, alliances, betrayals, artifacts, quests, revelations, or any narrative content not LITERALLY spoken in the transcript.
- Do NOT embellish, elaborate, dramatize, or "make the story interesting." A boring conversation gets a boring summary.
- Do NOT use words like "delving into," "confronted," "uneasy bargain," "darkness," "balance of power," "revelations" UNLESS those exact concepts appear in the transcript.
- If the transcript is a greeting and farewell with no substance, write ONE sentence: "${playerName} greeted ${actor.name}, and they exchanged brief words." That is the ENTIRE summary. Nothing more.
- If only one party spoke meaningfully, say so plainly.
- Past tense, third person, no quoted dialogue, no game mechanics.

PART 1 — DIARY ENTRY (1-4 sentences, strictly grounded in transcript):
${transcript.length < 200 ? "The transcript is short — your summary should be at most 1 sentence summarizing whatever brief exchange occurred. Do NOT invent context to fill space." : "Summarize ONLY what was discussed. If only small talk happened, say so."}

PART 2 — DEED EXTRACTION (be RUTHLESS):
A deed is a SPECIFIC COMMITMENT, AGREEMENT, REVELATION, or DECLARATION that is QUOTED OR PARAPHRASED FROM THE TRANSCRIPT. If you can't point to a specific line in the transcript that contains the deed, IT IS NOT A DEED.

Greetings, small talk, dismissals, refusals to talk, and pleasantries are NEVER deeds.

If the transcript contains no clear specific commitment/agreement/revelation/declaration, you MUST output:
DEEDS:
NONE

Do not invent deeds. Do not "find" deeds that aren't there. When in doubt, output NONE.

OUTPUT FORMAT (exact):
DIARY:
[Your strictly factual summary]

DEEDS:
- DEED: "[description, in past tense, traceable to a specific line in the transcript]" | MAGNITUDE: [local/regional/major/legendary]

OR if no deeds:
DEEDS:
NONE

TRANSCRIPT:
${transcript}

FINAL REMINDER: If you fabricate ANY detail not in the transcript, you fail. A short transcript means a short summary. NONE deeds is correct most of the time.`;

        const rawResponse = await AIHandler.callAI("You are a campaign chronicler.", [], summaryPrompt, provider, apiKey, [], { context: "session-summary" });
        if (!rawResponse || isAIFailure(rawResponse) || rawResponse.includes("magic is unset")) return;

        // ── Parse response: separate diary from deeds ────────────────
        let summary = rawResponse;
        let extractedDeeds = [];

        try {
            // Split on "DEEDS:" line
            const deedsSplit = rawResponse.split(/^DEEDS:\s*$/m);
            if (deedsSplit.length >= 2) {
                // Diary part: strip "DIARY:" prefix
                summary = deedsSplit[0].replace(/^DIARY:\s*/mi, "").trim();

                // Parse deed lines
                const deedsPart = deedsSplit[1];
                if (deedsPart && !deedsPart.trim().toUpperCase().startsWith("NONE")) {
                    const deedRegex = /- DEED:\s*"([^"]+)"\s*\|\s*MAGNITUDE:\s*(\w+)/gi;
                    let match;
                    while ((match = deedRegex.exec(deedsPart)) !== null) {
                        const magnitude = match[2].toLowerCase();
                        if (["local", "regional", "major", "legendary"].includes(magnitude)) {
                            extractedDeeds.push({ text: match[1], magnitude });
                        }
                    }
                }
            } else {
                // Fallback: no DEEDS section found, use whole response as summary
                summary = rawResponse.replace(/^DIARY:\s*/mi, "").trim();
            }
        } catch (parseErr) {
            console.warn("ACE: Engine | Deed parsing failed, using raw summary:", parseErr);
            summary = rawResponse.replace(/^DIARY:\s*/mi, "").replace(/^DEEDS:[\s\S]*$/mi, "").trim();
        }

        if (!summary) return;

        const journal = await getOrCreateJournal(actor);
        // Find Chronicle page, fall back to legacy "Memory Summary" name
        const chroniclePage = journal.pages.find(p => p.name === "Chronicle")
                           ?? journal.pages.find(p => p.name === "Memory Summary")
                           ?? journal.pages.contents[0];

        let targetPage = chroniclePage;
        if (!targetPage) {
            console.warn("ACE: Engine | Chronicle page missing — recreating");
            try {
                const created = await journal.createEmbeddedDocuments("JournalEntryPage", [{
                    name: "Chronicle",
                    type: "text",
                    text: { content: `<h2>${actor.name} — Chronicle</h2>\n`, format: 1 }
                }]);
                targetPage = created?.[0] ?? journal.pages.find(p => p.name === "Chronicle");
            } catch (e) {
                console.error("ACE: Engine | Failed to create Chronicle page:", e);
                return;
            }
            if (!targetPage) { console.error("ACE: Engine | Chronicle page still missing after creation"); return; }
        }

        const existing = targetPage.text?.content
                      ?? targetPage.system?.text?.content
                      ?? targetPage.data?.text?.content
                      ?? "";
        const cleaned  = existing
            .replace("<p><em>No encounters recorded yet.</em></p>", "")
            .replace("<p><em>No sessions recorded yet.</em></p>", "");  // legacy placeholder
        const date     = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

        // HTML-escape AI output and player name to prevent XSS in journal pages
        const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const safeSummary    = esc(summary).replace(/\n/g, "<br>");
        const safePlayerName = esc(playerName);

        await targetPage.update({
            "text.content": cleaned + `\n<h3>${date} — Conversation with ${safePlayerName}</h3>\n<p>${safeSummary}</p>`
        });

        console.log(`ACE: Engine | Chronicle entry saved for ${actor.name}`);
        if (extractedDeeds.length) {
            console.log(`ACE: Engine | Extracted ${extractedDeeds.length} deed(s) from conversation`);
        }
        ui.notifications.info(`ACE: Engine — Conversation with ${actor.name} saved to journal.`);

        // ── Cross-module: Push to ACE Engine if available ────────────────
        _pushToAceEngine(actor, history, playerName, summary, extractedDeeds);

        // ── Faction Memory: store narrative event for same-faction NPCs ──
        try {
            await logFactionEvent(actor, {
                kind:       "conversation",
                summary,
                npcName:    actor.name,
                playerName,
                scene:      canvas?.scene?.name ?? "",
            });
        } catch (factionErr) {
            console.warn("ACE: Engine | Faction memory write failed:", factionErr);
        }

    } catch(e) {
        console.error("ACE: Engine | Failed to summarize session:", e);
    }
}

// ── Read journal context for system prompt ──────────────────────────────────
export function getJournalContext(actor) {
    const journal = game.journal.find(j => j.name === `${JOURNAL_PREFIX} ${actor.name}`);
    if (!journal) return "";
    // Find Chronicle page, fall back to legacy "Memory Summary" name
    const chroniclePage = journal.pages.find(p => p.name === "Chronicle")
                       ?? journal.pages.find(p => p.name === "Memory Summary")
                       ?? journal.pages.contents[0];
    const text = (chroniclePage?.text?.content || "").replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!text || text.includes("No encounters recorded yet") || text.includes("No sessions recorded yet")) return "";
    return text;
}

// ── Push conversation data into engine's fame/reputation pipeline ──────────
// In envoy this called via EngineBridge; in engine we reach our own API by id.
function _pushToAceEngine(actor, history, playerName, summary, extractedDeeds = []) {
    try {
        const api = _engineApi();
        if (!api) return;

        const scene = canvas?.scene?.name ?? "";
        const brief = (summary ?? "").slice(0, 200);
        api.logNote?.(`[NPC Conversation] ${playerName} spoke with ${actor.name}${scene ? ` at ${scene}` : ""}. ${brief}`);

        api.logConversationEncounter?.({
            actor,
            playerName,
            summary: (summary ?? "").slice(0, 300),
            history
        });
        console.log(`ACE: Engine | Logged conversation data for ${actor.name}`);

        if (extractedDeeds.length) {
            for (const deed of extractedDeeds) {
                api.logDeed?.({
                    text:      deed.text,
                    magnitude: deed.magnitude,
                    scene,
                    pcs:       [playerName],
                    source:    "auto:conversation",
                });
            }
            console.log(`ACE: Engine | Logged ${extractedDeeds.length} deed(s) for ${actor.name}`);
        }
    } catch(e) {
        console.warn("ACE: Engine | Conversation data push failed:", e);
    }
}
