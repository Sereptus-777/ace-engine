// ============================================================
// ACE — AI Campaign Engine — Vault Engine
// Handles persistent cross-campaign archival storage.
//
// Three responsibilities:
// 1. Vault Snapshots — full backup of all stores to ace-engine-vault/
// 2. Legacy Ledger — curated AI-generated campaign summaries
// 3. Provides data for VaultSearch (cross-campaign queries)
// ============================================================

const MODULE_ID  = "ace-engine";
const VAULT_ROOT = "ace-engine-vault";

// v13-safe FilePicker access
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ??
  globalThis.FilePicker;

/** Upload a file silently — suppresses Foundry notification toast. */
let _silentDepth = 0;
let _origNotifyInfo = null;
async function _silentUpload(source, dir, file) {
  try {
    if (ui.notifications) {
      if (_silentDepth === 0) _origNotifyInfo = ui.notifications.info;
      _silentDepth++;
      ui.notifications.info = () => {};
    }
    await _FP().upload(source, dir, file, {}, { notify: false });
  } finally {
    if (ui.notifications && --_silentDepth === 0 && _origNotifyInfo) {
      ui.notifications.info = _origNotifyInfo;
      _origNotifyInfo = null;
    }
  }
}

// ── VaultEngine ──────────────────────────────────────────────

export class VaultEngine {
  /**
   * @param {import("./memory-manager.mjs").MemoryManager} memoryManager
   */
  constructor(memoryManager) {
    this._mm = memoryManager;
  }

  // ── Directory Setup ────────────────────────────────────────

  async _ensureVaultDirs(worldId) {
    const mk = async (path) => {
      try { await _FP().createDirectory("data", path); } catch { /* exists */ }
    };
    await mk(VAULT_ROOT);
    await mk(`${VAULT_ROOT}/${worldId}`);
    await mk(`${VAULT_ROOT}/${worldId}/latest`);
  }

  // ── Snapshot ───────────────────────────────────────────────

  /**
   * Create a complete vault snapshot of all category stores.
   * Writes to both `latest/` (overwritten) and a dated folder (permanent).
   *
   * @param {string} [worldId] - Override world ID (defaults to current)
   * @returns {Promise<boolean>}
   */
  async createSnapshot(worldId = null) {
    const wid = worldId ?? this._mm._worldId;
    if (!wid) return false;

    try {
      // Ensure all dirty stores are flushed first
      await this._mm.saveAll();

      await this._ensureVaultDirs(wid);

      // Create dated snapshot folder
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const datedDir = `${VAULT_ROOT}/${wid}/${timestamp}`;
      try { await _FP().createDirectory("data", datedDir); } catch { /* exists */ }

      // Build manifest
      const manifest = {
        version: 1,
        worldId: wid,
        worldName: game.world?.title ?? wid,
        snapshotAt: new Date().toISOString(),
        sessionCount: this._mm.world?._data?.sessions?.length ?? 0,
        deedCount: this._mm.deeds?._data?.deeds?.length ?? 0,
        npcCount: Object.keys(this._mm.npcs?._data?.npcs ?? {}).length,
        pcCount: Object.keys(this._mm.pcs?._data?.pcs ?? {}).length,
        eventCount: this._mm.history?._data?.events?.length ?? 0,
      };

      // Serialize all category stores (except documents — metadata only)
      const storeFiles = {};
      const storeNames = ["items", "tiles", "pcs", "npcs", "scenes", "world", "history", "deeds"];

      for (const name of storeNames) {
        const store = this._mm._stores.get(name);
        if (store?._serialize) {
          storeFiles[`ace-${name}.json`] = JSON.stringify(store._serialize(), null, 0);
        }
      }

      // Document store: save metadata only (no chunks/embeddings — too large)
      const docStore = this._mm.documents;
      if (docStore) {
        const docMeta = {
          version: 1,
          worldId: wid,
          documents: {},
        };
        for (const doc of (docStore.getEnabled?.() ?? [])) {
          docMeta.documents[doc.id] = {
            id: doc.id,
            fileName: doc.fileName,
            displayName: doc.displayName,
            type: doc.type,
            fileSize: doc.fileSize,
            chunkCount: doc.chunks?.length ?? 0,
            hasEmbeddings: !!doc.embeddings,
            tags: doc.tags ?? [],
          };
        }
        storeFiles["ace-documents-meta.json"] = JSON.stringify(docMeta, null, 2);
      }

      // Add manifest
      storeFiles["vault-manifest.json"] = JSON.stringify(manifest, null, 2);

      // Write all files to both latest/ and dated folder
      const latestDir = `${VAULT_ROOT}/${wid}/latest`;
      for (const [fileName, content] of Object.entries(storeFiles)) {
        const blob = new Blob([content], { type: "application/json" });
        const file = new File([blob], fileName, { type: "application/json" });
        // Write to latest (overwrite)
        await _silentUpload("data", latestDir, file);
        // Write to dated folder (permanent)
        const datedFile = new File([blob], fileName, { type: "application/json" });
        await _silentUpload("data", datedDir, datedFile);
      }

      console.log(`${MODULE_ID} | Vault snapshot created: ${datedDir} (${Object.keys(storeFiles).length} files)`);
      return true;

    } catch (err) {
      console.error(`${MODULE_ID} | Vault snapshot failed:`, err);
      return false;
    }
  }

  // ── Legacy Ledger ──────────────────────────────────────────

  /**
   * Load the legacy ledger (cross-campaign summaries).
   * Caches the result in memory — only fetches from disk once per session.
   * Call `_invalidateLedgerCache()` after saving a new ledger entry.
   * @returns {Promise<Object>}
   */
  async loadLedger() {
    if (this._ledgerCache) return this._ledgerCache;
    try {
      const res = await fetch(`${VAULT_ROOT}/legacy-ledger.json`);
      if (!res.ok) {
        this._ledgerCache = { version: 1, campaigns: [] };
        return this._ledgerCache;
      }
      this._ledgerCache = await res.json();
      return this._ledgerCache;
    } catch {
      this._ledgerCache = { version: 1, campaigns: [] };
      return this._ledgerCache;
    }
  }

  /**
   * Save a campaign entry to the legacy ledger.
   * @param {Object} campaignEntry
   * @returns {Promise<boolean>}
   */
  async saveLedger(ledger) {
    try {
      await this._ensureVaultDirs(this._mm._worldId ?? "default");
      const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: "application/json" });
      const file = new File([blob], "legacy-ledger.json", { type: "application/json" });
      await _silentUpload("data", VAULT_ROOT, file);
      this._ledgerCache = ledger;  // update cache
      return true;
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to save legacy ledger:`, err);
      return false;
    }
  }

  /**
   * Close a campaign — AI generates a summary, saves to ledger + final vault snapshot.
   *
   * @param {Function} aiStreamFn - Function that takes (systemPrompt, userPrompt) and returns AI text
   * @returns {Promise<Object|null>} The campaign entry, or null on failure
   */
  async closeCampaign(aiStreamFn) {
    const mm = this._mm;
    const wid = mm._worldId;

    // Gather all campaign data for the AI to summarize
    const npcs = Object.values(mm.npcs?._data?.npcs ?? {});
    const pcs = Object.values(mm.pcs?._data?.pcs ?? {});
    const deeds = mm.deeds?._data?.deeds ?? [];
    const sessions = mm.world?._data?.sessions ?? [];
    const worldNotes = mm.world?._data?.worldNotes ?? [];
    const factions = mm.world?._data?.factions ?? {};

    // Build the AI prompt
    const dataDump = [
      `## Campaign: ${game.world?.title ?? wid}`,
      `Sessions: ${sessions.length}`,
      `\n### Player Characters`,
      ...pcs.map(pc => `- **${pc.displayName}** (${pc.class ?? "unknown"} L${pc.level ?? "?"}) — ${pc.kills ?? 0} kills, ${pc.crits ?? 0} crits, ${pc.sessions ?? 0} sessions`),
      `\n### Major Deeds (${deeds.length})`,
      ...deeds.slice(0, 50).map(d => `- [${d.magnitude}] ${d.text} (Session ${d.session ?? "?"})`),
      `\n### Notable NPCs (${npcs.length})`,
      ...npcs.filter(n => n.met >= 2 || n.killed).slice(0, 40).map(n =>
        `- **${n.displayName}** — met ${n.met}x${n.killed ? " [KILLED]" : ""}, scenes: ${(n.scenes ?? []).slice(0, 3).join(", ")}`
      ),
      `\n### Session Summaries`,
      ...sessions.slice(-20).map(s => `- Session ${s.num}: ${s.summary ?? "(no summary)"}`),
      `\n### World Notes (${worldNotes.length})`,
      ...worldNotes.slice(-20).map(n => `- [${n.category ?? "note"}] ${n.txt}`),
      `\n### Factions`,
      ...Object.values(factions).map(f => `- **${f.name}** — ${f.relationship ?? "neutral"}`),
    ].join("\n");

    const systemPrompt = `You are an expert D&D campaign historian. You will receive raw data from a completed campaign. Generate a structured summary that captures the essence of this adventure for posterity. Include:

1. A 2-3 paragraph narrative summary of the campaign arc
2. A list of the party's 5-10 most significant deeds
3. Key allies and enemies
4. How the world changed because of the party's actions
5. 3-5 tavern rumors that NPCs in future campaigns might tell about these adventurers

Write in past tense. Be specific — use names, locations, and events from the data. This summary will be used to create continuity across future campaigns.`;

    try {
      const summary = await aiStreamFn(systemPrompt, dataDump);
      if (!summary) return null;

      // Parse the summary into a structured entry
      const entry = {
        worldId: wid,
        worldName: game.world?.title ?? wid,
        closedAt: new Date().toISOString(),
        sessionCount: sessions.length,
        dayCount: mm.world?._data?.calendar?.dayCounter ?? 0,
        party: pcs.map(pc => ({
          name: pc.displayName,
          class: pc.class ?? "unknown",
          level: pc.level ?? 1,
          kills: pc.kills ?? 0,
          crits: pc.crits ?? 0,
        })),
        majorDeeds: deeds
          .filter(d => ["regional", "major", "legendary"].includes(d.magnitude))
          .slice(0, 20)
          .map(d => d.text),
        notableNpcs: npcs
          .filter(n => n.met >= 3 || n.killed)
          .slice(0, 30)
          .map(n => ({
            name: n.displayName,
            met: n.met,
            killed: n.killed,
            relationship: n.relationships ?? {},
          })),
        factions: Object.values(factions).map(f => ({
          name: f.name,
          relationship: f.relationship ?? "neutral",
        })),
        summary, // The full AI-generated narrative
      };

      // Save to ledger
      const ledger = await this.loadLedger();
      // Remove any existing entry for this world (re-closing)
      ledger.campaigns = ledger.campaigns.filter(c => c.worldId !== wid);
      ledger.campaigns.push(entry);
      await this.saveLedger(ledger);

      // Final vault snapshot
      await this.createSnapshot(wid);

      console.log(`${MODULE_ID} | Campaign "${entry.worldName}" archived to Legacy Ledger`);
      return entry;

    } catch (err) {
      console.error(`${MODULE_ID} | Campaign close failed:`, err);
      return null;
    }
  }

  /**
   * Build a compact context string from the Legacy Ledger for AI injection.
   * @param {number} [maxChars=800]
   * @returns {Promise<string>}
   */
  async getLedgerContext(maxChars = 800) {
    const ledger = await this.loadLedger();
    if (!ledger.campaigns?.length) return "";

    let ctx = "### Legacy Campaigns\n";
    let used = ctx.length;

    for (const c of ledger.campaigns) {
      // Skip current world — that's already in live context
      if (c.worldId === this._mm._worldId) continue;

      const line = `- **${c.worldName}** (${c.sessionCount} sessions, closed ${new Date(c.closedAt).toLocaleDateString()}): ` +
        `Party: ${c.party?.map(p => p.name).join(", ") ?? "unknown"}. ` +
        `${c.majorDeeds?.slice(0, 3).join("; ") ?? "No major deeds recorded."}\n`;

      if (used + line.length > maxChars) break;
      ctx += line;
      used += line.length;
    }

    return used > 30 ? ctx : "";
  }
}
