// ─── ACE: Engine — NPC Profile Journal API ────────────────────────────────────
// High-level wrapper around memory-manager's NPC store + journal writer.
// Exposes a clean API for the bio-generator's Two-Part Bio System:
//
//   ensureProfile(actor, tokenDoc?)        → guarantee profile exists, returns record
//   shouldGenerateForScene(actor, sceneId) → date-gap check (true → spend API call)
//   addSceneAppearance(actor, scene, text) → write dated entry, sync journal page
//   getLatestSceneAppearance(actor, sceneId) → last entry for this scene/NPC
//   markDeceased(actor, killerName)        → flip Status, page stays forever
//
// Design source: session_april1_2026.md "Two-Part Bio System" — was designed
// Apr 1 but never built. Built 2026-06-08 after Aldric Thorne's bio was
// overwritten in testing. Architecture:
//   • Actor sheet biography = STATIC after first write (the "core" — MM canon,
//     hand-written, or one-time AI generation)
//   • NPC Profile journal = LIVING document. Scene appearances are dated
//     entries (chronological log per scene). Re-dropping in same scene on
//     a different day = fresh entry (the NPC came BACK for a reason).
//
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-engine";
const TAG = `ACE: Engine | NPC Profile`;

/**
 * Compare two timestamps (seconds since epoch) and report whether they fall
 * on the same calendar day in the user's local timezone. Used by the
 * date-gap rule — same scene + same day = reuse; same scene + new day = regen.
 */
function _isSameDay(t1, t2) {
    if (!t1 || !t2) return false;
    const d1 = new Date(t1 * 1000);
    const d2 = new Date(t2 * 1000);
    return d1.getFullYear() === d2.getFullYear()
        && d1.getMonth()    === d2.getMonth()
        && d1.getDate()     === d2.getDate();
}

/**
 * Return the configured minimum days between scene-context regens.
 * 0 = any new calendar day triggers regen (default).
 * 7 = once per week max (for GMs running multiple sessions per week).
 */
function _minDaysBetweenRegens() {
    try {
        const v = Number(game.settings.get(MODULE_ID, "sceneContextMinDays"));
        return Number.isFinite(v) && v >= 0 ? v : 0;
    } catch (_) { return 0; }
}

/**
 * Resolve the live memory-manager instance. Returns null if engine isn't
 * fully initialized yet (e.g. very early hook firings).
 */
function _getMemoryManager() {
    return game.modules?.get?.(MODULE_ID)?.api?.memoryManager
        ?? globalThis.aceEngineMemoryManager
        ?? null;
}

/**
 * Guarantee an NPC record exists for the actor + anchor its UUID for rename
 * safety. Idempotent — call as many times as you want. Returns the record
 * (with the new sceneAppearances field present).
 *
 * Does NOT generate a bio. Does NOT write to the journal page. Use
 * addSceneAppearance() to add content + sync the page.
 *
 * @param {Actor} actor
 * @param {TokenDocument} [tokenDoc] — optional, used to infer scene context
 * @returns {object|null} the NpcStore record, or null on failure
 */
export function ensureProfile(actor, tokenDoc = null) {
    if (!actor?.name) return null;
    const mm = _getMemoryManager();
    if (!mm?.npcs) return null;

    try {
        // touchNpc creates the record if missing (with new fields), or returns
        // the existing one + lazy-backfills new fields on legacy records.
        const sceneName = tokenDoc?.parent?.name ?? canvas.scene?.name ?? null;
        const rec = mm.npcs.touchNpc(actor.name, sceneName);
        if (!rec) return null;

        // Anchor UUID for rename safety the first time we see it
        if (!rec.actorUuid && actor.uuid) {
            rec.actorUuid = actor.uuid;
            mm.npcs._dirty = true;
        }
        return rec;
    } catch (err) {
        console.warn(`${TAG} | ensureProfile failed for ${actor.name}:`, err);
        return null;
    }
}

/**
 * Date-gap rule check — should we spend an API call to generate fresh scene
 * context for this NPC dropping on this scene?
 *
 * Rules:
 *   - No prior appearance on this scene → YES, generate fresh
 *   - Prior appearance was on SAME calendar day → NO, reuse it
 *   - Prior appearance was on EARLIER day, but within the
 *     "sceneContextMinDays" setting window → NO, reuse it
 *   - Prior appearance was older than the window → YES, generate fresh
 *
 * @param {Actor} actor
 * @param {string} sceneId
 * @returns {boolean}
 */
export function shouldGenerateForScene(actor, sceneId) {
    if (!actor?.name || !sceneId) return false;
    const mm = _getMemoryManager();
    if (!mm?.npcs) return false;

    try {
        const latest = mm.npcs.getLatestSceneAppearance(actor.name, sceneId);
        if (!latest) return true;                       // never been here → generate

        const now = Math.floor(Date.now() / 1000);
        if (_isSameDay(latest.t, now)) return false;    // same day → reuse

        const minDays = _minDaysBetweenRegens();
        if (minDays > 0) {
            const elapsedDays = (now - latest.t) / 86400;
            if (elapsedDays < minDays) return false;    // within window → reuse
        }

        return true;  // earlier day (and outside any window) → fresh entry
    } catch (err) {
        console.warn(`${TAG} | shouldGenerateForScene failed:`, err);
        return false;  // safe default — don't spend API call on error
    }
}

// ─── Page Pagination Constants ──────────────────────────────────────────
// Append-only architecture: each "Appearances — Page N" journal page holds
// MAX_ENTRIES_PER_PAGE entries before being marked closed. New entries
// append to the active page; once closed, no code path ever modifies
// the page again. (Architecture locked by Johnny 2026-06-09 — "I want the
// bios untouched. Code never fixes an old bio.")
const MAX_ENTRIES_PER_PAGE = 20;
const APPEARANCE_PAGE_PREFIX = "Appearances — Page";

/**
 * Find the NPC's journal entry by name. Returns null if missing.
 * Doesn't create one — that's writeNpcJournal's responsibility.
 */
function _findJournal(npcName) {
    if (!npcName) return null;
    return game.journal?.find?.(j => j.name === npcName) ?? null;
}

/**
 * Find the active (non-closed) appearance page on this journal, or null.
 * "Active" = the highest-numbered Appearances page that doesn't have
 * `flags.ace-engine.closed = true`.
 */
function _findActiveAppearancePage(journal) {
    if (!journal?.pages) return null;
    const pages = journal.pages.contents
        .filter(p => p.name?.startsWith(APPEARANCE_PAGE_PREFIX))
        .filter(p => !p.flags?.[MODULE_ID]?.closed)
        .sort((a, b) => _parsePageNumber(a.name) - _parsePageNumber(b.name));
    return pages[pages.length - 1] ?? null;
}

/**
 * Get the highest page number currently used (closed or active).
 * Returns 0 if no appearance pages exist yet.
 */
function _maxPageNumber(journal) {
    if (!journal?.pages) return 0;
    let max = 0;
    for (const p of journal.pages.contents) {
        if (p.name?.startsWith(APPEARANCE_PAGE_PREFIX)) {
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

/**
 * Count appearance entries on a page by scanning for our entry-marker tag.
 * Each entry rendered by _renderAppearanceEntry includes a sentinel
 * `<div class="ace-appearance-entry" ...>` so we can count them reliably.
 */
function _countEntriesOnPage(page) {
    const text = page?.text?.content ?? "";
    const matches = text.match(/class="ace-appearance-entry"/g);
    return matches?.length ?? 0;
}

/**
 * Render a single appearance entry as immutable HTML.
 * Date is prominently displayed at the top of each entry.
 */
function _renderAppearanceEntry(entry) {
    const date = new Date((entry.t ?? 0) * 1000);
    const dateStr = date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    const timeStr = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const sceneName = String(entry.sceneName ?? "Unknown scene")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const ctx = String(entry.contextText ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\n\n+/g, "</p><p>")
        .replace(/\n/g, "<br>");
    return `
<div class="ace-appearance-entry" style="margin-bottom:18px;padding:10px 14px;border-left:3px solid #8b6f47;background:rgba(139,111,71,0.08);border-radius:0 4px 4px 0;">
  <div style="font-size:0.85em;color:#8b6f47;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:4px;">
    ${dateStr} <span style="opacity:0.6;font-weight:400;">· ${timeStr}</span>
  </div>
  <div style="font-size:1.05em;font-weight:600;color:#c9a76b;margin-bottom:6px;">
    📍 ${sceneName}
  </div>
  <div style="line-height:1.5;color:#e8d49a;"><p>${ctx}</p></div>
</div>`;
}

/**
 * Get-or-create the active appearance page on this journal. If the latest
 * page is full (>= MAX_ENTRIES_PER_PAGE), mark it closed and create a new
 * one. Returns the writable page.
 */
async function _getOrCreateActivePage(journal) {
    const active = _findActiveAppearancePage(journal);
    if (active) {
        const count = _countEntriesOnPage(active);
        if (count < MAX_ENTRIES_PER_PAGE) return active;
        // Close the full page — set flag so the code never touches it again.
        try {
            await active.update({ [`flags.${MODULE_ID}.closed`]: true });
            console.log(`${TAG} | Closed full appearance page "${active.name}" (${count} entries) — appending to a new page from now on.`);
        } catch (err) {
            console.warn(`${TAG} | Failed to mark page closed (non-fatal):`, err);
        }
    }
    // Create a new page numbered N+1 (existing max + 1)
    const newNum = _maxPageNumber(journal) + 1;
    const newName = `${APPEARANCE_PAGE_PREFIX} ${newNum}`;
    try {
        const [created] = await journal.createEmbeddedDocuments("JournalEntryPage", [{
            name: newName,
            type: "text",
            text: { content: `<h2>${newName}</h2><p><em>Appearances logged on this page — each entry is timestamped and append-only. The GM is the only one who can edit or delete entries here.</em></p>`, format: 1 },
            sort: newNum * 1000,
            flags: { [MODULE_ID]: { closed: false, created: Math.floor(Date.now() / 1000) } },
        }]);
        console.log(`${TAG} | Created new appearance page "${newName}".`);
        return created;
    } catch (err) {
        console.error(`${TAG} | Failed to create new appearance page:`, err);
        return null;
    }
}

/**
 * Append a dated scene-appearance entry to the NPC's profile journal.
 *
 * v0.7.21 architecture:
 *   • Store entry is the source of truth (append-only)
 *   • Journal page receives an APPENDED entry (existing content untouched)
 *   • Active page closes at MAX_ENTRIES_PER_PAGE — code never touches it again
 *   • New page automatically created when active fills up
 *   • Memory page (summary + last-5) is the ONLY page that gets regenerated
 *   • Hand-edits by the GM on ANY page are preserved
 *
 * @param {Actor} actor
 * @param {Scene} scene
 * @param {string} contextText — AI-generated 5-10 line "why is he here NOW"
 * @returns {Promise<object|null>}  the inserted appearance object, or null
 */
export async function addSceneAppearance(actor, scene, contextText) {
    if (!actor?.name || !scene?.id) return null;
    const mm = _getMemoryManager();
    if (!mm?.npcs) return null;

    try {
        // 1. Profile + UUID anchor (no journal write yet)
        ensureProfile(actor);

        // 2. Store the entry first — the canonical source-of-truth log.
        //    If the journal write fails below, the store still has it and
        //    the next addSceneAppearance pass will see a healthy state.
        const entry = mm.npcs.addSceneAppearance(actor.name, {
            sceneId:     scene.id,
            sceneName:   scene.name ?? "",
            contextText: contextText ?? "",
            actorUuid:   actor.uuid ?? null,
            generatedBy: "ai",
        });
        if (!entry) return null;

        // 3. Ensure journal entry exists + Memory page is current. The Memory
        //    page is the ONLY page we regenerate from the store; appearance
        //    pages are append-only.
        try {
            await mm.writeNpcJournal(actor.name);
        } catch (writeErr) {
            console.warn(`${TAG} | Memory page sync failed for ${actor.name}:`, writeErr);
        }

        // 4. Append the new entry to the active appearance page (creates a
        //    new page if needed). NEVER modifies past pages.
        try {
            const journal = _findJournal(actor.name);
            if (!journal) {
                console.warn(`${TAG} | Journal "${actor.name}" not found after writeNpcJournal — appearance not written to journal.`);
                return entry;
            }
            const page = await _getOrCreateActivePage(journal);
            if (!page) {
                console.warn(`${TAG} | Could not get/create active appearance page for ${actor.name}.`);
                return entry;
            }
            const existing = page.text?.content ?? "";
            const newHtml = existing + _renderAppearanceEntry(entry);
            await page.update({ "text.content": newHtml });
            console.log(`${TAG} | Appended appearance for ${actor.name} on "${scene.name}" to "${page.name}" (${_countEntriesOnPage({ text: { content: newHtml } })} entries on page).`);
        } catch (appendErr) {
            console.warn(`${TAG} | Appearance page append failed for ${actor.name} (entry still in store):`, appendErr);
        }

        // 5. Step 5 (Cross-Reference) — mirror the appearance into the
        //    World Library / <scene name> journal so the scene has its
        //    own NPC-encounter log too. Independent failure mode — the
        //    NPC profile journal isn't blocked on this.
        try {
            const { recordSceneNpcAppearance } = await import("./cross-reference-journal.mjs");
            await recordSceneNpcAppearance(actor, scene, contextText);
        } catch (xrefErr) {
            console.warn(`${TAG} | Cross-reference write to World Library failed (non-fatal):`, xrefErr);
        }

        return entry;
    } catch (err) {
        console.warn(`${TAG} | addSceneAppearance failed:`, err);
        return null;
    }
}

/**
 * Most recent dated entry for (actor, scene). Null if none.
 */
export function getLatestSceneAppearance(actor, sceneId) {
    if (!actor?.name || !sceneId) return null;
    const mm = _getMemoryManager();
    if (!mm?.npcs) return null;
    try {
        return mm.npcs.getLatestSceneAppearance(actor.name, sceneId);
    } catch (_) {
        return null;
    }
}

/**
 * Flip an NPC's status to deceased + record the killer + sync journal.
 * Idempotent — calling twice is harmless. NPC Profile page stays forever
 * (deceased NPCs are not deleted, just marked).
 */
export async function markDeceased(actor, killerName = null) {
    if (!actor?.name) return;
    const mm = _getMemoryManager();
    if (!mm?.npcs) return;
    try {
        mm.npcs.markKilled(actor.name, killerName);
        await mm.writeNpcJournal(actor.name);
        console.log(`${TAG} | Marked ${actor.name} deceased${killerName ? ` (killed by ${killerName})` : ""}.`);
    } catch (err) {
        console.warn(`${TAG} | markDeceased failed:`, err);
    }
}

// ─── Default export bundle so consumers can `import npcProfileJournal from ...` ───
export default {
    ensureProfile,
    shouldGenerateForScene,
    addSceneAppearance,
    getLatestSceneAppearance,
    markDeceased,
};
