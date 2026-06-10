// ─── ACE: Engine — Cross-Reference Journal API ─────────────────────────────
// Builds the network of cross-linked journals that make NPC and scene history
// discoverable and redundant. Same append-only architecture as the Two-Part
// Bio System (npc-profile-journal.mjs) — entries are immutable, pages close
// at MAX_ENTRIES_PER_PAGE, GM is the only editor.
//
// Three journal types managed here:
//
//   1. Factions journals  — "Factions / <faction name>"
//      Records faction member assignments, status changes, history.
//      Hook point: faction-registry.mjs.assignToFaction()
//
//   2. World Library      — "World Library / <scene name>"
//      Records every NPC encountered on a scene, with dates.
//      Hook point: npc-profile-journal.addSceneAppearance() cross-call
//
//   3. PC Kill Log        — appended to existing PC profile journals
//      Records unlinked-NPC kills (mooks killed by the party).
//      Hook point: death/damage pipeline (TBD wiring).
//
// All three share: append-only, 20-entries-per-page pagination, GM-editable,
// no code path ever modifies past entries.
// ──────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | CrossRef";

const FACTIONS_FOLDER     = "Factions";
const WORLD_LIBRARY_FOLDER = "World Library";
const PC_PROFILES_FOLDER  = "PC Profiles";

const MAX_ENTRIES_PER_PAGE = 20;

// ─── Folder + journal helpers ──────────────────────────────────────────────

function _getMemoryManager() {
    return game.modules?.get?.(MODULE_ID)?.api?.memoryManager ?? null;
}

// v0.7.21: cross-ref folders nest INSIDE the 📖 ACE Engine parent so they
// sit beside NPC Profiles / PC Profiles / Session Logs / World Lore in the
// sidebar — matches the cleaned-up structure Johnny finalized 2026-06-09.
const ACE_PARENT_FOLDER_NAME = "\u{1F4D6} ACE Engine";  // 📖 ACE Engine

/**
 * Find or create the 📖 ACE Engine parent journal folder.
 * Idempotent. Mirrors the pattern memory-manager._getAceFolder uses so the
 * same parent is shared by all ACE journal subfolders.
 */
async function _getAceParentFolder() {
    let folder = game.folders?.find(f =>
        f.type === "JournalEntry" && f.name === ACE_PARENT_FOLDER_NAME && !f.folder
    );
    if (folder) return folder;
    try {
        folder = await Folder.create({
            name: ACE_PARENT_FOLDER_NAME,
            type: "JournalEntry",
            color: "#c9a84c",
        });
        console.log(`${TAG} | Created parent folder "${ACE_PARENT_FOLDER_NAME}"`);
        return folder;
    } catch (err) {
        console.warn(`${TAG} | Parent folder create failed:`, err);
        return null;
    }
}

/**
 * Get or create a SUBFOLDER inside the 📖 ACE Engine parent.
 * Idempotent. Same pattern memory-manager._getAceSubfolder uses, so
 * Factions / World Library land next to NPC Profiles in the sidebar.
 */
async function _getOrCreateFolder(name, color = "#6b4c9a") {
    const parent = await _getAceParentFolder();
    if (!parent) return null;
    let folder = game.folders?.find(f =>
        f.type === "JournalEntry" && f.name === name && f.folder?.id === parent.id
    );
    if (folder) return folder;
    try {
        folder = await Folder.create({
            name, type: "JournalEntry", folder: parent.id, color,
        });
        console.log(`${TAG} | Created folder "${name}" inside "${ACE_PARENT_FOLDER_NAME}"`);
        return folder;
    } catch (err) {
        console.warn(`${TAG} | Folder create for "${name}" failed:`, err);
        return null;
    }
}

/**
 * v0.7.21 — One-time pre-creation pass so the Factions and World Library
 * folders exist in the sidebar from world-load onward, even before any
 * entry is written. Reassures the GM that the structure is in place.
 * Called from the engine's ready hook. Idempotent — safe to call multiple
 * times.
 */
export async function ensureCrossRefFolders() {
    try {
        await _getOrCreateFolder(FACTIONS_FOLDER,      "#9c6cb8");
        await _getOrCreateFolder(WORLD_LIBRARY_FOLDER, "#6b9a4c");
        // PC Profiles parent already exists (created by memory-manager) —
        // don't pre-create it here, just touch on first kill-log write.
        console.log(`${TAG} | Cross-reference folders pre-created.`);
    } catch (err) {
        console.warn(`${TAG} | ensureCrossRefFolders failed (non-fatal):`, err);
    }
}

/**
 * Get or create a journal entry inside a folder. Idempotent.
 */
async function _getOrCreateJournal(folderName, journalName, headerHtml = "") {
    if (!folderName || !journalName) return null;
    const folder = await _getOrCreateFolder(folderName);
    if (!folder) return null;

    let journal = game.journal?.find(j => j.folder?.id === folder.id && j.name === journalName);
    if (journal) return journal;

    try {
        journal = await JournalEntry.create({
            name: journalName,
            folder: folder.id,
        });
        // Seed with a Memory page (regenerable summary).
        if (headerHtml) {
            await journal.createEmbeddedDocuments("JournalEntryPage", [{
                name: "Memory",
                type: "text",
                text: { content: headerHtml, format: 1 },
                sort: 0,
            }]);
        }
        console.log(`${TAG} | Created journal "${journalName}" in "${folderName}"`);
        return journal;
    } catch (err) {
        console.warn(`${TAG} | Journal create for "${journalName}" failed:`, err);
        return null;
    }
}

/** Find the active (non-closed) appearance page on a journal. */
function _findActivePage(journal, pagePrefix = "Log — Page") {
    if (!journal?.pages) return null;
    const pages = journal.pages.contents
        .filter(p => p.name?.startsWith(pagePrefix))
        .filter(p => !p.flags?.[MODULE_ID]?.closed)
        .sort((a, b) => _parsePageNumber(a.name) - _parsePageNumber(b.name));
    return pages[pages.length - 1] ?? null;
}

function _maxPageNumber(journal, pagePrefix = "Log — Page") {
    if (!journal?.pages) return 0;
    let max = 0;
    for (const p of journal.pages.contents) {
        if (p.name?.startsWith(pagePrefix)) {
            const n = _parsePageNumber(p.name);
            if (n > max) max = n;
        }
    }
    return max;
}

function _parsePageNumber(name) {
    const m = String(name ?? "").match(/Page\s*(\d+)/i);
    return m ? Number(m[1]) : 0;
}

function _countEntriesOnPage(page) {
    const text = page?.text?.content ?? "";
    return (text.match(/class="ace-log-entry"/g) ?? []).length;
}

/**
 * Get or create the active log page on a journal.
 * Closes the full page when it hits MAX_ENTRIES_PER_PAGE, opens a new one.
 */
async function _getOrCreateActiveLogPage(journal, pagePrefix = "Log — Page") {
    const active = _findActivePage(journal, pagePrefix);
    if (active) {
        const count = _countEntriesOnPage(active);
        if (count < MAX_ENTRIES_PER_PAGE) return active;
        try {
            await active.update({ [`flags.${MODULE_ID}.closed`]: true });
            console.log(`${TAG} | Closed full page "${active.name}" (${count} entries)`);
        } catch (err) {
            console.warn(`${TAG} | Failed to close page:`, err);
        }
    }
    const newNum = _maxPageNumber(journal, pagePrefix) + 1;
    const newName = `${pagePrefix} ${newNum}`;
    try {
        const [created] = await journal.createEmbeddedDocuments("JournalEntryPage", [{
            name: newName,
            type: "text",
            text: { content: `<h2>${newName}</h2><p><em>Append-only log. Each entry is timestamped and the GM is the only one who can edit or delete entries.</em></p>`, format: 1 },
            sort: newNum * 1000,
            flags: { [MODULE_ID]: { closed: false, created: Math.floor(Date.now() / 1000) } },
        }]);
        return created;
    } catch (err) {
        console.error(`${TAG} | Failed to create log page:`, err);
        return null;
    }
}

function _esc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Render a generic timestamped entry. */
function _renderLogEntry({ dateMs, title, body, accent = "#8b6f47" }) {
    const date = new Date(dateMs ?? Date.now());
    const dateStr = date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    const timeStr = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `
<div class="ace-log-entry" style="margin-bottom:14px;padding:10px 14px;border-left:3px solid ${accent};background:rgba(139,111,71,0.08);border-radius:0 4px 4px 0;">
  <div style="font-size:0.85em;color:${accent};font-weight:600;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:4px;">
    ${dateStr} <span style="opacity:0.6;font-weight:400;">· ${timeStr}</span>
  </div>
  <div style="font-size:1.05em;font-weight:600;color:#c9a76b;margin-bottom:4px;">${_esc(title)}</div>
  <div style="line-height:1.5;color:#e8d49a;">${body}</div>
</div>`;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Record a faction member assignment in the faction's journal.
 * Idempotent — appends only on FIRST assignment per (actor, faction) pair.
 * Hook from faction-registry.mjs:assignToFaction.
 */
export async function recordFactionMember(actor, faction, role = "") {
    if (!actor?.name || !faction?.name) return;
    try {
        const headerHtml = `<h2>${_esc(faction.name)}</h2>
            <p><strong>Type:</strong> ${_esc(faction.type ?? "unknown")}</p>
            <p><strong>Alignment:</strong> ${_esc(faction.alignment ?? "unknown")}</p>
            <p><strong>Region:</strong> ${_esc(faction.region ?? "unknown")}</p>
            <p><em>Member roster and assignment history below.</em></p>`;
        const journal = await _getOrCreateJournal(FACTIONS_FOLDER, faction.name, headerHtml);
        if (!journal) return;

        // Idempotency check — has this member been recorded on this journal?
        const existingContent = journal.pages.contents.map(p => p.text?.content ?? "").join("");
        const memberMarker = `data-member-id="${actor.uuid}"`;
        if (existingContent.includes(memberMarker)) {
            return;  // already recorded
        }

        const body = `Joined as <strong>${_esc(role || "member")}</strong>. ${actor.type === "character" ? "Player Character." : "NPC."} <span ${memberMarker} style="display:none;"></span>`;
        const title = actor.name;
        const html = _renderLogEntry({
            dateMs: Date.now(),
            title,
            body,
            accent: "#9c6cb8",
        });

        const page = await _getOrCreateActiveLogPage(journal);
        if (!page) return;
        const existing = page.text?.content ?? "";
        await page.update({ "text.content": existing + html });
        console.log(`${TAG} | Faction journal: recorded ${actor.name} → ${faction.name}${role ? ` (${role})` : ""}`);
    } catch (err) {
        console.warn(`${TAG} | recordFactionMember failed:`, err);
    }
}

/**
 * Record an NPC's appearance on a scene in the World Library journal.
 * Cross-reference write — called from npc-profile-journal.addSceneAppearance
 * AFTER the NPC's own profile journal is updated, so each scene-level entry
 * mirrors the NPC-level entry.
 */
export async function recordSceneNpcAppearance(actor, scene, contextText) {
    if (!actor?.name || !scene?.name) return;
    try {
        const headerHtml = `<h2>${_esc(scene.name)}</h2>
            <p><em>NPC appearances on this scene, in chronological order. Each entry is timestamped and append-only.</em></p>`;
        const journal = await _getOrCreateJournal(WORLD_LIBRARY_FOLDER, scene.name, headerHtml);
        if (!journal) return;

        const body = contextText
            ? _esc(contextText).replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br>")
            : "<em>(no context recorded)</em>";

        const title = `${actor.name} — ${actor.type === "character" ? "PC" : "NPC"}`;
        const html = _renderLogEntry({
            dateMs: Date.now(),
            title,
            body: `<p>${body}</p>`,
            accent: "#6b9a4c",
        });

        const page = await _getOrCreateActiveLogPage(journal);
        if (!page) return;
        const existing = page.text?.content ?? "";
        await page.update({ "text.content": existing + html });
        console.log(`${TAG} | World Library: recorded ${actor.name} appearance on "${scene.name}"`);
    } catch (err) {
        console.warn(`${TAG} | recordSceneNpcAppearance failed:`, err);
    }
}

/**
 * Append an unlinked-NPC kill to the killer's PC journal entry.
 * Used for mook tracking — full NPC Profile is NOT created for these;
 * the kill is just a tally on the PC's record.
 *
 * For LINKED NPC kills, the npc-profile-journal handles them as full
 * profile entries (with markDeceased). This function is for unlinked only.
 */
export async function recordUnlinkedKill(victimName, killerActor, scene) {
    if (!victimName || !killerActor?.name) return;
    try {
        const headerHtml = `<h2>${_esc(killerActor.name)}</h2><p><em>Combat statistics + unlinked NPC kill log.</em></p>`;
        const journal = await _getOrCreateJournal(PC_PROFILES_FOLDER, killerActor.name, headerHtml);
        if (!journal) return;

        const sceneName = scene?.name ?? canvas.scene?.name ?? "an unknown scene";
        const html = _renderLogEntry({
            dateMs: Date.now(),
            title: `Killed: ${victimName}`,
            body: `On ${_esc(sceneName)}.`,
            accent: "#9a4c4c",
        });

        // Kill log gets its own page prefix so it doesn't mix with other PC logs
        const page = await _getOrCreateActiveLogPage(journal, "Kill Log — Page");
        if (!page) return;
        const existing = page.text?.content ?? "";
        await page.update({ "text.content": existing + html });
        console.log(`${TAG} | PC kill log: ${killerActor.name} killed "${victimName}" on ${sceneName}`);
    } catch (err) {
        console.warn(`${TAG} | recordUnlinkedKill failed:`, err);
    }
}

// ─── Default export bundle ─────────────────────────────────────────────────
export default {
    ensureCrossRefFolders,
    recordFactionMember,
    recordSceneNpcAppearance,
    recordUnlinkedKill,
};
