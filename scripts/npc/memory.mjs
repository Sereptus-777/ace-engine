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

const MODULE_ID       = "ace-engine";
const JOURNAL_PREFIX  = "[AI Memory]";
const FOLDER_NAME     = "\u{1F4AC} ACE Engine";
const FOLDER_LEGACY   = ["ACE: NPC Memories", "AI NPC Memories", "\u{1F4AC} ACE Envoy"];

/** Read engine's AI config — replaces envoy's getEnvoyAIConfig. */
function getEnvoyAIConfig() {
    try {
        return {
            provider: game.settings.get(MODULE_ID, "aiProvider") || "ollama",
            apiKey:   game.settings.get(MODULE_ID, "apiKey")     || "",
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

        const summaryPrompt = `You are writing a brief campaign journal entry about a conversation between ${playerName} (a player character) and ${actor.name} (an NPC) in a tabletop RPG campaign.

PART 1 — DIARY ENTRY:
Write 2-4 sentences in past tense, third person, like a campaign chronicle or diary entry. Cover: what was discussed, any deals or promises made, how the interaction ended, and any important revelations or turning points. Be vivid but concise. Do NOT include direct dialogue quotes, game stats, or mechanical details.

PART 2 — DEED EXTRACTION:
If any notable commitments, discoveries, quest acceptances, alliances, betrayals, or significant agreements were made during this conversation, list them. Only include genuinely significant narrative events — NOT small talk, routine transactions, or pleasantries.

Format your response EXACTLY like this:
DIARY:
[Your narrative summary here]

DEEDS:
- DEED: "[description in past tense]" | MAGNITUDE: [local/regional/major/legendary]

If no notable deeds occurred, write:
DEEDS:
NONE

TRANSCRIPT:
${transcript}`;

        const rawResponse = await AIHandler.callAI("You are a campaign chronicler.", [], summaryPrompt, provider, apiKey);
        if (!rawResponse || rawResponse.includes("magic is unset")) return;

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
