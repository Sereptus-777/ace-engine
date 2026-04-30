// ─── ACE: Engine — Digest Recovery ────────────────────────────────────────
// Scans WIP files and backup snapshots on disk to recover digest data that
// got lost when the original digest run crashed or hit save errors mid-way
// (e.g. the upload-permission warnings we saw earlier — those silently
// failed every save attempt while the AI extraction was running).
//
// Uses the digest engine's existing _mergePartials() to collapse a partial
// run's batches back into a usable digest, then registers it via the
// engine's standard saveDigest / saveIndex path so it shows up in the
// Library exactly like a fresh digest would.

const MODULE_ID = "ace-engine";
const { ApplicationV2 } = foundry.applications.api;

const _FP = () =>
    foundry.applications?.apps?.FilePicker?.implementation ??
    globalThis.FilePicker;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Scan disk + current state to identify recoverable digest data.
 *
 * @param {AcePanel} panel
 * @returns {Promise<{
 *   orphanDocs: Array<{
 *     doc: object,
 *     wipPath: string|null,
 *     wipStats: { partials: number, npcs: number, locations: number, factions: number, items: number, totalBatches: number, completedUpTo: number } | null,
 *     backupMatches: Array<{ backupFile: string, digestId: string, sourceFile: string, npcs: number, locations: number }>,
 *   }>,
 *   summary: { totalDocs: number, totalDigests: number, orphans: number, withWip: number, withBackup: number }
 * }>}
 */
export async function scanRecoverable(panel) {
    const store = panel?._documentEngine?._mm?.documents;
    const eng   = panel?._digestEngine;
    if (!store || !eng) {
        throw new Error("Recovery scan: panel.documentEngine / digestEngine not available.");
    }

    const docs    = store.getAll() ?? [];
    const digests = eng.getAllDigests?.() ?? [];

    // 1. Build a fast lookup: "fileName has a digest?"
    const hasDigest = new Set(digests.map(d => d.sourceFile));

    // 2. Collect orphan docs
    const orphanDocs = docs.filter(d => d.status === "ready" && !hasDigest.has(d.fileName));

    // 3. List every WIP file in the digests directory
    const wipFiles = await _listFiles("ace-engine-library/digests", /^_wip_/);

    // 4. List every backup file (we only deeply inspect the few most recent
    //    to keep this fast — full inspection of 553 files would be slow).
    const backupFiles = await _listFiles("ace-engine-library/digest-backups", /\.json$/);
    backupFiles.sort();
    const RECENT_BACKUP_COUNT = 10;
    const recentBackups = backupFiles.slice(-RECENT_BACKUP_COUNT);

    // 5. Read recent backups once and build a {sourceFile: [{backupFile, digestId, payload}]} index
    const backupIndex = await _buildBackupIndex(recentBackups);

    // 6. For each orphan, check WIP + backup
    const reports = [];
    for (const doc of orphanDocs) {
        const wipPath = wipFiles.find(p => p.includes(`_wip_${doc.id}.json`)) ?? null;
        const wipStats = wipPath ? await _wipStats(wipPath) : null;

        // Backup matches keyed by sourceFile (typical) OR by digest's stored doc id
        const fromSource = backupIndex.get(doc.fileName) ?? [];
        // Some digests may also have a docId match — check that too
        const fromDocId = [];
        for (const [_, list] of backupIndex.entries()) {
            for (const m of list) {
                if (m.docId && m.docId === doc.id && !fromSource.includes(m)) fromDocId.push(m);
            }
        }
        const backupMatches = [...fromSource, ...fromDocId].map(m => ({
            backupFile: m.backupFile,
            digestId:   m.digestId,
            sourceFile: m.sourceFile,
            npcs:       m.npcs,
            locations:  m.locations,
        }));

        reports.push({ doc, wipPath, wipStats, backupMatches });
    }

    const summary = {
        totalDocs:   docs.length,
        totalDigests: digests.length,
        orphans:     orphanDocs.length,
        withWip:     reports.filter(r => r.wipStats && r.wipStats.partials > 0).length,
        withBackup:  reports.filter(r => r.backupMatches.length > 0).length,
    };

    return { orphanDocs: reports, summary };
}

/**
 * Recover a digest from a WIP file. Loads the WIP, merges its partials
 * via the engine's own _mergePartials, saves as a real digest, registers
 * in the index. Single transaction — either fully succeeds or throws.
 *
 * @param {AcePanel} panel
 * @param {object}   doc — the document this WIP belongs to
 * @param {string}   wipPath — full path to the WIP file
 * @returns {Promise<{ digestId: string, npcs: number, locations: number, factions: number }>}
 */
export async function recoverFromWip(panel, doc, wipPath) {
    const eng = panel._digestEngine;
    if (!eng) throw new Error("digestEngine not available.");

    const wip = await _readJSON(wipPath);
    if (!wip?.partials?.length) throw new Error("WIP file is empty or unreadable.");

    // Use the engine's own merge function — it handles dedup + the seven categories.
    const merged = typeof eng._mergePartials === "function"
        ? eng._mergePartials(wip.partials)
        : _fallbackMergePartials(wip.partials);

    if (!merged) throw new Error("Failed to merge WIP partials.");

    // Manufacture a stub summary since the AI-generated one was never written.
    if (!merged.summary || merged.summary.length < 10) {
        const docName = doc.displayName ?? wip.docDisplayName ?? "Unknown source";
        const pages   = doc.pageCount ?? "?";
        const batches = wip.completedUpTo != null ? `${wip.completedUpTo + 1}/${wip.totalBatches} batches` : "partial run";
        merged.summary = `Recovered from interrupted digest of "${docName}" — ${pages} pages, ${batches}. AI summary was not generated; entity data below was extracted before the interruption.`;
    }

    // Pick a stable id and write it
    const digestId = `recovered_${doc.id}_${Date.now().toString(36)}`;
    const payload = {
        displayName: doc.displayName ?? wip.docDisplayName ?? doc.fileName,
        generatedAt: wip.savedAt ?? new Date().toISOString(),
        digest:      merged,
    };

    // Save the digest file. saveDigest signature is (id, payload).
    await eng.saveDigest(digestId, payload);

    // Update the index with metadata that mirrors a normal entry
    const meta = {
        id:           digestId,
        displayName:  payload.displayName,
        sourceFile:   doc.fileName,
        pageCount:    doc.pageCount,
        digestedAt:   payload.generatedAt,
        recovered:    true,
        recoveredFrom: "wip",
        categories: {
            npcs:       merged.npcs?.length ?? 0,
            locations:  merged.locations?.length ?? 0,
            factions:   merged.factions?.length ?? 0,
            items:      merged.items?.length ?? 0,
            encounters: merged.encounters?.length ?? 0,
            plotHooks:  merged.plotHooks?.length ?? 0,
            lore:       merged.lore?.length ?? 0,
        },
    };
    if (typeof eng.updateIndex === "function") eng.updateIndex(digestId, meta);
    else if (eng._index?.digests) eng._index.digests[digestId] = meta;
    if (typeof eng.saveIndex === "function") await eng.saveIndex();

    // Tombstone the WIP so it's not re-recovered
    if (typeof eng._deleteWip === "function" && doc.id) {
        try { await eng._deleteWip(doc.id); } catch (_) { /* non-fatal */ }
    }

    // Activate this digest for the current world so chat/context can use it
    const docStore = panel._documentEngine?._mm?.documents;
    if (docStore?.toggleDigest) {
        docStore.toggleDigest(digestId, true);
        panel._saveDocuments?.();
    }

    // Rebuild the world graph with the new digest
    if (docStore?.getActiveDigests && typeof eng.rebuildWorldGraph === "function") {
        eng.rebuildWorldGraph(docStore.getActiveDigests()).catch(err =>
            console.warn(`${MODULE_ID} | World graph rebuild after recovery failed:`, err)
        );
    }

    return {
        digestId,
        npcs:      meta.categories.npcs,
        locations: meta.categories.locations,
        factions:  meta.categories.factions,
        items:     meta.categories.items,
        encounters: meta.categories.encounters,
        plotHooks: meta.categories.plotHooks,
        lore:      meta.categories.lore,
    };
}

/**
 * Recover a single digest from a backup file. Reads the backup, extracts
 * the requested digestId's payload, saves it as a fresh digest with a new
 * id (so it doesn't collide with anything else), updates the index.
 *
 * @param {AcePanel} panel
 * @param {object}   doc — the document the digest will be linked to
 * @param {string}   backupPath
 * @param {string}   originalDigestId — id within the backup bundle
 */
export async function recoverFromBackup(panel, doc, backupPath, originalDigestId) {
    const eng = panel._digestEngine;
    if (!eng) throw new Error("digestEngine not available.");

    const bundle = await _readJSON(backupPath);
    if (bundle?._backup?.type !== "digest-backup") {
        throw new Error("Selected file isn't a valid digest backup.");
    }

    const orig = bundle.digests?.[originalDigestId];
    if (!orig) throw new Error(`Digest "${originalDigestId}" not found in backup.`);

    // The original payload may be either {displayName, generatedAt, digest:{…}}
    // or the bare digest content. Normalize.
    let merged = orig.digest ?? orig;
    if (!merged || typeof merged !== "object") throw new Error("Backup digest payload is corrupt.");

    const newId = `recovered_${doc.id}_${Date.now().toString(36)}`;
    const payload = {
        displayName: orig.displayName ?? doc.displayName ?? doc.fileName,
        generatedAt: orig.generatedAt ?? new Date().toISOString(),
        digest:      merged,
    };
    await eng.saveDigest(newId, payload);

    const origMeta = bundle.index?.digests?.[originalDigestId] ?? {};
    const meta = {
        ...origMeta,
        id:            newId,
        displayName:   payload.displayName,
        sourceFile:    doc.fileName,
        pageCount:     doc.pageCount ?? origMeta.pageCount,
        digestedAt:    payload.generatedAt,
        recovered:     true,
        recoveredFrom: "backup",
        categories:    origMeta.categories ?? {
            npcs:       merged.npcs?.length ?? 0,
            locations:  merged.locations?.length ?? 0,
            factions:   merged.factions?.length ?? 0,
            items:      merged.items?.length ?? 0,
            encounters: merged.encounters?.length ?? 0,
            plotHooks:  merged.plotHooks?.length ?? 0,
            lore:       merged.lore?.length ?? 0,
        },
    };
    if (typeof eng.updateIndex === "function") eng.updateIndex(newId, meta);
    else if (eng._index?.digests) eng._index.digests[newId] = meta;
    if (typeof eng.saveIndex === "function") await eng.saveIndex();

    const docStore = panel._documentEngine?._mm?.documents;
    if (docStore?.toggleDigest) {
        docStore.toggleDigest(newId, true);
        panel._saveDocuments?.();
    }
    if (docStore?.getActiveDigests && typeof eng.rebuildWorldGraph === "function") {
        eng.rebuildWorldGraph(docStore.getActiveDigests()).catch(err =>
            console.warn(`${MODULE_ID} | World graph rebuild after backup recovery failed:`, err)
        );
    }

    return {
        digestId: newId,
        ...meta.categories,
    };
}

// ─── Internals ────────────────────────────────────────────────────────────

async function _listFiles(dir, filterRx = null) {
    try {
        const r = await _FP().browse("data", dir);
        const files = r.files ?? [];
        return filterRx ? files.filter(f => filterRx.test(f.split("/").pop())) : files;
    } catch (_) {
        return [];
    }
}

async function _readJSON(path) {
    const resp = await fetch(`/${path}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} reading ${path}`);
    return await resp.json();
}

async function _wipStats(wipPath) {
    try {
        const wip = await _readJSON(wipPath);
        if (!wip?.partials?.length) return { partials: 0, npcs: 0, locations: 0, factions: 0, items: 0, totalBatches: wip?.totalBatches ?? 0, completedUpTo: wip?.completedUpTo ?? -1 };
        let npcs = 0, locations = 0, factions = 0, items = 0;
        for (const p of wip.partials) {
            npcs      += p.npcs?.length      ?? 0;
            locations += p.locations?.length ?? 0;
            factions  += p.factions?.length  ?? 0;
            items     += p.items?.length     ?? 0;
        }
        return {
            partials:      wip.partials.length,
            npcs, locations, factions, items,
            totalBatches:  wip.totalBatches ?? 0,
            completedUpTo: wip.completedUpTo ?? -1,
        };
    } catch (_) {
        return null;
    }
}

/**
 * Read recent backup files and index them by sourceFile. Each entry maps
 * sourceFile → list of { backupFile, digestId, sourceFile, docId, npcs, locations }.
 */
async function _buildBackupIndex(backupFiles) {
    const idx = new Map();
    for (const path of backupFiles) {
        try {
            const bundle = await _readJSON(path);
            const digests = bundle?.digests ?? {};
            const indexMeta = bundle?.index?.digests ?? {};
            for (const [digestId, payload] of Object.entries(digests)) {
                const meta = indexMeta[digestId] ?? {};
                const inner = payload?.digest ?? payload;
                const sourceFile = meta.sourceFile ?? payload?.sourceFile ?? "";
                const docId = meta.docId ?? payload?.docId ?? "";
                if (!sourceFile && !docId) continue;
                const entry = {
                    backupFile: path,
                    digestId,
                    sourceFile,
                    docId,
                    npcs:       inner?.npcs?.length ?? 0,
                    locations:  inner?.locations?.length ?? 0,
                };
                if (sourceFile) {
                    if (!idx.has(sourceFile)) idx.set(sourceFile, []);
                    idx.get(sourceFile).push(entry);
                } else if (docId) {
                    if (!idx.has(`__docId__${docId}`)) idx.set(`__docId__${docId}`, []);
                    idx.get(`__docId__${docId}`).push(entry);
                }
            }
        } catch (_) { /* skip unreadable backup */ }
    }
    return idx;
}

// ─── Recovery Dialog (UI) ─────────────────────────────────────────────────

export class RecoveryDialog extends ApplicationV2 {

    static DEFAULT_OPTIONS = {
        id:      "ace-recovery-dialog",
        classes: ["ace-recovery-dialog"],
        tag:     "div",
        window: {
            title:       "ACE — Digest Recovery",
            icon:        "fa-solid fa-wrench",
            resizable:   true,
            minimizable: true,
        },
        position: {
            width:  860,
            height: 680,
        },
        actions: {
            recoverWip:    function(e, t) { return this._recoverWip(e, t); },
            recoverBackup: function(e, t) { return this._recoverBackup(e, t); },
            rescan:        function(e, t) { return this._rescan(e, t); },
        },
    };

    constructor(panel, options = {}) {
        super(options);
        this._panel = panel;
        this._scanResult = null;        // populated after _scan()
        this._scanError  = null;
        this._busy       = false;
    }

    // ─── Render lifecycle ────────────────────────────────────────────────

    async _renderHTML(_context, _options) {
        if (!this._scanResult && !this._scanError) {
            try {
                this._scanResult = await scanRecoverable(this._panel);
            } catch (err) {
                this._scanError = err.message ?? String(err);
            }
        }
        return this._buildHTML();
    }

    _replaceHTML(result, content, _options) {
        content.innerHTML = result;
    }

    _buildHTML() {
        if (this._scanError) {
            return `<div class="ace-rec-root">
                <div class="ace-rec-error">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <strong>Scan failed:</strong> ${this._esc(this._scanError)}
                </div>
            </div>`;
        }
        if (!this._scanResult) {
            return `<div class="ace-rec-root">
                <div class="ace-rec-loading">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                    Scanning disk for recoverable digest data…
                </div>
            </div>`;
        }

        const { orphanDocs, summary } = this._scanResult;

        const summaryHtml = `
            <header class="ace-rec-header">
                <div class="ace-rec-summary">
                    <div class="ace-rec-summary-row">
                        <span class="ace-rec-stat"><strong>${summary.totalDocs}</strong> docs</span>
                        <span class="ace-rec-stat"><strong>${summary.totalDigests}</strong> registered digests</span>
                        <span class="ace-rec-stat ace-rec-stat-orphans"><strong>${summary.orphans}</strong> orphan${summary.orphans === 1 ? "" : "s"}</span>
                        <span class="ace-rec-stat ace-rec-stat-recoverable"><strong>${summary.withWip + summary.withBackup}</strong> recoverable</span>
                    </div>
                    <p class="ace-rec-summary-blurb">
                        An "orphan" is a document that's been uploaded but has no associated digest entry — usually because the original digest run crashed or hit save errors. Recovery promotes any leftover WIP file or backup snapshot back into a real digest, so you don't have to redo the work.
                    </p>
                </div>
                <button type="button" class="ace-rec-rescan" data-action="rescan" title="Rescan disk">
                    <i class="fa-solid fa-rotate"></i> Rescan
                </button>
            </header>
        `;

        if (orphanDocs.length === 0) {
            return `<div class="ace-rec-root">
                ${summaryHtml}
                <div class="ace-rec-empty">
                    <i class="fa-solid fa-circle-check"></i>
                    <h2>Everything looks good</h2>
                    <p>No orphan documents found. Every uploaded source has a registered digest entry.</p>
                </div>
            </div>`;
        }

        const recoverableFirst = [...orphanDocs].sort((a, b) => {
            const aHas = (a.wipStats?.partials > 0 ? 1 : 0) + (a.backupMatches.length > 0 ? 1 : 0);
            const bHas = (b.wipStats?.partials > 0 ? 1 : 0) + (b.backupMatches.length > 0 ? 1 : 0);
            return bHas - aHas;
        });

        const orphanCards = recoverableFirst.map((r, idx) => this._buildOrphanCard(r, idx)).join("");

        return `<div class="ace-rec-root">
            ${summaryHtml}
            <div class="ace-rec-list">${orphanCards}</div>
        </div>`;
    }

    _buildOrphanCard(report, idx) {
        const { doc, wipPath, wipStats, backupMatches } = report;

        const wipBlock = wipStats && wipStats.partials > 0 ? `
            <div class="ace-rec-source ace-rec-source-wip">
                <div class="ace-rec-source-title">
                    <i class="fa-solid fa-hourglass-half"></i> Crash-Resume File
                </div>
                <div class="ace-rec-source-stats">
                    <strong>${wipStats.partials}</strong> batch${wipStats.partials === 1 ? "" : "es"} saved ·
                    <strong>${wipStats.npcs}</strong> NPCs ·
                    <strong>${wipStats.locations}</strong> locations ·
                    <strong>${wipStats.factions}</strong> factions ·
                    <strong>${wipStats.items}</strong> items
                    ${wipStats.totalBatches > 0 ? ` · <em>${wipStats.completedUpTo + 1}/${wipStats.totalBatches} batches completed</em>` : ""}
                </div>
                <button type="button" class="ace-rec-action" data-action="recoverWip" data-doc-id="${this._esc(doc.id)}" data-wip-path="${this._esc(wipPath)}" data-orphan-idx="${idx}">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> Recover from WIP
                </button>
            </div>
        ` : (wipStats ? `
            <div class="ace-rec-source ace-rec-source-empty">
                <div class="ace-rec-source-title">
                    <i class="fa-solid fa-circle-xmark"></i> Crash-Resume File: empty
                </div>
                <div class="ace-rec-source-stats">A WIP file exists but contains no extracted entities. Nothing to recover from this source.</div>
            </div>
        ` : "");

        const backupBlocks = backupMatches.length > 0 ? backupMatches.map(b => `
            <div class="ace-rec-source ace-rec-source-backup">
                <div class="ace-rec-source-title">
                    <i class="fa-solid fa-floppy-disk"></i> Backup snapshot
                </div>
                <div class="ace-rec-source-stats">
                    <strong>${b.npcs}</strong> NPCs · <strong>${b.locations}</strong> locations
                    · <code>${this._esc(b.backupFile.split("/").pop())}</code>
                </div>
                <button type="button" class="ace-rec-action" data-action="recoverBackup"
                        data-doc-id="${this._esc(doc.id)}"
                        data-backup-path="${this._esc(b.backupFile)}"
                        data-digest-id="${this._esc(b.digestId)}"
                        data-orphan-idx="${idx}">
                    <i class="fa-solid fa-cloud-arrow-down"></i> Recover from this Backup
                </button>
            </div>
        `).join("") : "";

        const noRecovery = !wipStats?.partials && backupMatches.length === 0;

        return `
            <article class="ace-rec-orphan ${noRecovery ? "ace-rec-orphan-empty" : ""}" data-orphan-idx="${idx}">
                <header class="ace-rec-orphan-head">
                    <div class="ace-rec-orphan-name">${this._esc(doc.displayName ?? doc.fileName)}</div>
                    <div class="ace-rec-orphan-meta">
                        <code>${this._esc(doc.fileName)}</code>
                        ${doc.pageCount ? ` · ${doc.pageCount} pages` : ""}
                        · doc id: <code>${this._esc(doc.id)}</code>
                    </div>
                </header>
                <div class="ace-rec-sources">
                    ${wipBlock}
                    ${backupBlocks}
                    ${noRecovery ? `
                        <div class="ace-rec-source ace-rec-source-none">
                            <i class="fa-solid fa-circle-info"></i>
                            No WIP file or recent backup contains data for this document. Re-digesting from scratch is the only path. (With the recent permission-error fix, the next run should save cleanly.)
                        </div>
                    ` : ""}
                </div>
            </article>
        `;
    }

    // ─── Action handlers ─────────────────────────────────────────────────

    async _rescan() {
        this._scanResult = null;
        this._scanError = null;
        await this.render(false);
    }

    async _recoverWip(_event, target) {
        if (this._busy) return;
        const docId   = target.dataset.docId;
        const wipPath = target.dataset.wipPath;
        const idx     = parseInt(target.dataset.orphanIdx, 10);
        const orphan  = this._scanResult?.orphanDocs?.[idx];
        if (!orphan || !docId || !wipPath) {
            ui.notifications?.error("Recovery: missing data on action button.");
            return;
        }
        await this._runRecovery(target, async () => {
            const r = await recoverFromWip(this._panel, orphan.doc, wipPath);
            const totals = (r.npcs ?? 0) + (r.locations ?? 0) + (r.factions ?? 0) + (r.items ?? 0);
            ui.notifications?.info(`ACE: Recovered "${orphan.doc.displayName}" — ${totals} entities restored.`);
        });
    }

    async _recoverBackup(_event, target) {
        if (this._busy) return;
        const docId      = target.dataset.docId;
        const backupPath = target.dataset.backupPath;
        const digestId   = target.dataset.digestId;
        const idx        = parseInt(target.dataset.orphanIdx, 10);
        const orphan     = this._scanResult?.orphanDocs?.[idx];
        if (!orphan || !docId || !backupPath || !digestId) {
            ui.notifications?.error("Recovery: missing data on action button.");
            return;
        }
        await this._runRecovery(target, async () => {
            const r = await recoverFromBackup(this._panel, orphan.doc, backupPath, digestId);
            const totals = (r.npcs ?? 0) + (r.locations ?? 0) + (r.factions ?? 0) + (r.items ?? 0);
            ui.notifications?.info(`ACE: Recovered "${orphan.doc.displayName}" from backup — ${totals} entities restored.`);
        });
    }

    /** Wraps a recovery action with busy state, error handling, and a rescan on success. */
    async _runRecovery(triggerBtn, fn) {
        this._busy = true;
        const originalLabel = triggerBtn.innerHTML;
        triggerBtn.disabled = true;
        triggerBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Recovering…`;
        try {
            await fn();
            // Force a fresh scan + re-render so the recovered doc disappears from the list
            this._scanResult = null;
            this._scanError = null;
            // Also refresh the LibraryWindow if it's open
            if (this._panel?._libraryWindow?.rendered) this._panel._libraryWindow.render(false);
            await this.render(false);
        } catch (err) {
            console.error(`${MODULE_ID} | Recovery failed:`, err);
            ui.notifications?.error(`ACE: Recovery failed — ${err.message?.slice(0, 200) ?? "unknown error"}`);
            triggerBtn.disabled = false;
            triggerBtn.innerHTML = originalLabel;
        } finally {
            this._busy = false;
        }
    }

    _esc(s) {
        return String(s ?? "")
            .replace(/&/g,  "&amp;")
            .replace(/</g,  "&lt;")
            .replace(/>/g,  "&gt;")
            .replace(/"/g,  "&quot;")
            .replace(/'/g,  "&#39;");
    }
}

/** Open the Recovery dialog for the given panel. */
export function openRecoveryDialog(panel) {
    new RecoveryDialog(panel).render(true);
}

/**
 * Fallback merger if the engine doesn't expose _mergePartials. Mirrors the
 * standard logic: concat each category, dedup by primary name field.
 */
function _fallbackMergePartials(partials) {
    const merged = { summary: "", npcs: [], locations: [], factions: [], plotHooks: [], encounters: [], items: [], lore: [] };
    const dedupKeys = { npcs: "name", locations: "name", factions: "name", plotHooks: "title", encounters: "name", items: "name", lore: "topic" };
    for (const cat of Object.keys(dedupKeys)) {
        const seen = new Set();
        for (const p of partials) {
            for (const entry of (p[cat] ?? [])) {
                const k = String(entry?.[dedupKeys[cat]] ?? "").trim().toLowerCase();
                if (!k) continue;
                if (seen.has(k)) continue;
                seen.add(k);
                merged[cat].push(entry);
            }
        }
    }
    return merged;
}
