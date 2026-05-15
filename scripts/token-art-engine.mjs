// ─── ACE: Engine — Auto Token Art ──────────────────────────────────────────
// Scans user-defined folders for token art on world load, then auto-matches
// each freshly created token to a file in the index. Match logic:
//
//   • Exact full-name match (actor "Goblin Archer" → "Goblin - Archer.webp"
//                                                  or "Goblin Archer.webp")
//   • Base-name match (actor "Goblin" → all files whose base is "Goblin")
//   • Substring fallback
//
// If there's exactly one match, the token's image is silently swapped.
// If there are multiple matches, a lightweight floating chooser pops up
// near the dropped token — click a thumbnail, hit Enter/1-9 for keyboard
// shortcuts, R for random, Esc to dismiss with default. Pre-highlights the
// most recently used variant for this creature so repeat-drops are fast.
//
// Tokens whose image is already inside one of the user's folders are
// considered "already good" and left alone — no overwrite, no popup.
//
// Filename convention:
//   <BaseName> - <Variant>.webp     (e.g. "Goblin - Archer.webp")
//   <BaseName>.webp                 (no variant, used when actor name is the base)
//   The " - " (space-hyphen-space) is the variant separator.

import { MODULE_ID } from "./ace-engine.mjs";

const TAG = "ACE: Engine | Token Art";
const IMG_EXT_RE = /\.(webp|png|jpg|jpeg|svg|gif|avif)$/i;
const VARIANT_SEP = / - /;          // " - " — what splits base from variant
const CHOOSER_TIMEOUT_MS = 4000;     // auto-dismiss after this many ms

// ─── In-memory index ───────────────────────────────────────────────────────
// Built on world load + on demand via rescan. Cleared and re-built atomically.
const _index = {
    /** Map<baseNameLower, Entry[]>  — for "Goblin" → all Goblin variants */
    byBase: new Map(),
    /** Map<fullNameLower, Entry>    — for "Goblin Archer" → exact entry */
    byFullName: new Map(),
    /** Map<keyTokenString, Entry[]> — for fuzzy word-set matching. Lets
     *  "Air Elemental" match files keyed as "air elemental" regardless
     *  of size adjectives, numeric suffixes, underscores, etc. */
    byKey: new Map(),
    /** All entries, in scan order. */
    all: [],
    /** Whether the index has been built at least once. */
    ready: false,
};

// Active chooser DOM element — tracked so we can dismiss the previous one
// before a new spawn pops a new chooser on top of it.
let _activeChooser = null;

// Folder names that are "generic containers" — when a token file lives
// inside one of these, we DON'T treat the folder name as the creature
// name (it's just an organizational bucket). Anything else becomes the
// creature-name source of truth, so e.g. `MM/Air Elemental/Air_01.png`
// uses "Air Elemental" as the base regardless of what's in the filename.
const GENERIC_FOLDERS = new Set([
    "npcs", "tokens", "token", "bestiary", "monsters", "monster",
    "creatures", "creature", "portraits", "portrait",
    "art", "artwork", "images", "img",
    "mm", "phb", "vgm", "mtof", "mpmm", "tcoe", "ftod", "boem",
    "srd", "srd5e", "system", "systems", "good", "pngs", "png",
    "monster png-good only", "monster-png-good-only",
]);

// Words to ignore when computing a creature's "key signature" — sizes,
// numeric tokens, "v01"-style variant markers, and the common modifier
// prefixes already in STRIP_TOKENS. Used to make
//   "Air_Large_Elemental_01"  match
//   "Air Elemental"           (after stripping Large + 01).
const SIZE_TOKENS = new Set(["tiny", "small", "medium", "large", "huge", "gargantuan"]);
const NUMERIC_RE  = /^\d+$|^v\d+$|^\(\d+\)$/i;

/** Normalize underscores → spaces, collapse whitespace. */
function _normalizeFilename(s) {
    return (s || "")
        .replace(/[_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Compute the "key signature" of a name — sorted, lowercased, dedup'd
 *  word set with sizes / numbers / modifier prefixes stripped. Used for
 *  fuzzy matching by word set. */
function _keyTokensOf(name) {
    const words = _normalizeFilename(name).toLowerCase().split(" ");
    const kept = words.filter(w =>
        w && !SIZE_TOKENS.has(w) && !STRIP_TOKENS.has(w) && !NUMERIC_RE.test(w)
    );
    // Dedup + sort for stable signature
    const uniq = [...new Set(kept)].sort();
    return uniq.join(" ");
}

/** Plain entry shape. */
function _makeEntry({ path, displayBase, displayVariant, fullName }) {
    return {
        path,
        displayBase,
        displayVariant: displayVariant || null,
        fullName,
        baseLower: displayBase.toLowerCase().trim(),
        fullLower: fullName.toLowerCase().trim(),
        variantLower: displayVariant ? displayVariant.toLowerCase().trim() : null,
        keyTokens:    _keyTokensOf(fullName),
    };
}

/**
 * Parse a token-art file path → entry.
 *
 * Naming logic:
 *  1. If the file lives inside a non-generic subfolder, USE THE FOLDER
 *     NAME as the creature's base. The filename becomes a variant. This
 *     handles "MM/Air Elemental/Air_Large_Elemental_01.png" properly —
 *     base "Air Elemental", variant "Large 01".
 *  2. Otherwise, fall back to filename parsing with " - " separator.
 *
 * @param {string} path        e.g. "NPCs/Goblin/Goblin Boss.webp"
 * @param {Set<string>} scanRoots  Lower-cased set of scan-root paths so
 *                                 we know which folder names to ignore.
 */
function _parsePath(path, scanRoots) {
    const parts = path.split("/");
    const filenameRaw = parts.pop().replace(/\.[^.]+$/, "");
    const filename = _normalizeFilename(filenameRaw);

    // Walk up from the file looking for the deepest non-generic folder.
    // Stop at any directory whose path matches one of the scan roots.
    let creatureFolder = null;
    for (let i = parts.length - 1; i >= 0; i--) {
        const folderName = _normalizeFilename(parts[i]);
        const lower = folderName.toLowerCase();
        // Stop if we hit a scan-root boundary
        const pathSoFar = parts.slice(0, i + 1).join("/").toLowerCase();
        if (scanRoots.has(pathSoFar)) break;
        // Skip generic container names
        if (GENERIC_FOLDERS.has(lower)) continue;
        // Skip empty / unusable
        if (!folderName) continue;
        // Found the deepest meaningful folder
        creatureFolder = folderName;
        break;
    }

    let displayBase, displayVariant;
    if (creatureFolder) {
        // ── Use folder name as base ────────────────────────────────
        displayBase = creatureFolder;
        // Variant: strip the folder's words out of the filename (case-
        // insensitive, ignoring word order). Whatever's left is the
        // distinguishing variant info ("Large 01", "Boss", etc.).
        const baseWordSet = new Set(
            creatureFolder.toLowerCase().split(" ").filter(Boolean)
        );
        const filenameWords = filename.split(" ");
        const variantWords = filenameWords.filter(w => !baseWordSet.has(w.toLowerCase()));
        const variantText = variantWords.join(" ").trim();
        displayVariant = variantText || null;
    } else {
        // ── Fall back to "BaseName - Variant.ext" filename parsing ──
        const split = filename.split(VARIANT_SEP);
        displayBase = split[0].trim();
        displayVariant = split.length > 1 ? split.slice(1).join(" - ").trim() : null;
    }

    const fullName = displayVariant ? `${displayBase} ${displayVariant}` : displayBase;
    return _makeEntry({ path, displayBase, displayVariant, fullName });
}

// ─── Folder scanning ───────────────────────────────────────────────────────

/** Walk a folder recursively, return all image file paths (relative to data root). */
async function _scanFolder(rootPath) {
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const found = [];
    const queue = [rootPath];
    const visited = new Set();

    while (queue.length) {
        const dir = queue.shift();
        if (visited.has(dir)) continue;
        visited.add(dir);

        let result;
        try {
            result = await FP.browse("data", dir);
        } catch (err) {
            console.warn(`${TAG} | Can't browse "${dir}":`, err?.message ?? err);
            continue;
        }
        for (const file of result.files ?? []) {
            if (IMG_EXT_RE.test(file)) found.push(file);
        }
        for (const sub of result.dirs ?? []) {
            queue.push(sub);
        }
    }
    return found;
}

/**
 * (Re)build the in-memory token-art index from the user's configured folders.
 * Call after the GM changes the folder setting or clicks "Rescan Folders".
 */
export async function rebuildTokenArtIndex() {
    const folders = (() => {
        try {
            const raw = game.settings.get(MODULE_ID, "tokenArtFolders");
            return Array.isArray(raw) ? raw : [];
        } catch (_) { return []; }
    })();

    if (!folders.length) {
        console.log(`${TAG} | No folders configured — index empty.`);
        _index.byBase.clear();
        _index.byFullName.clear();
        _index.all = [];
        _index.ready = true;
        return { fileCount: 0, baseCount: 0 };
    }

    console.log(`${TAG} | Scanning ${folders.length} folder(s)…`);
    const t0 = performance.now();

    const allPaths = [];
    for (const folder of folders) {
        const files = await _scanFolder(folder);
        for (const f of files) allPaths.push(f);
    }
    // Dedupe by path
    const uniquePaths = [...new Set(allPaths)];

    // Set of scan-root paths (lowercased, no trailing slash) so _parsePath
    // knows where to stop when walking up looking for a creature folder.
    const scanRoots = new Set(folders.map(f => f.toLowerCase().replace(/\/+$/, "")));

    // Build maps
    const byBase = new Map();
    const byFullName = new Map();
    const byKey = new Map();
    const all = [];
    for (const p of uniquePaths) {
        const entry = _parsePath(p, scanRoots);
        all.push(entry);
        // Full-name lookup
        if (!byFullName.has(entry.fullLower)) byFullName.set(entry.fullLower, entry);
        // Base lookup → list of variants
        const baseArr = byBase.get(entry.baseLower);
        if (baseArr) baseArr.push(entry);
        else byBase.set(entry.baseLower, [entry]);
        // Key-token lookup → list of variants by normalized word set
        if (entry.keyTokens) {
            const keyArr = byKey.get(entry.keyTokens);
            if (keyArr) keyArr.push(entry);
            else byKey.set(entry.keyTokens, [entry]);
        }
    }

    _index.byBase = byBase;
    _index.byFullName = byFullName;
    _index.byKey = byKey;
    _index.all = all;
    _index.ready = true;

    const ms = (performance.now() - t0).toFixed(0);
    console.log(`${TAG} | Index built in ${ms}ms — ${all.length} files, ${byBase.size} unique base names, ${byKey.size} key signatures.`);

    return { fileCount: all.length, baseCount: byBase.size };
}

/** Get the live index (for settings UI / debugging). */
export function getTokenArtIndex() { return _index; }

// ─── Matching ──────────────────────────────────────────────────────────────

/**
 * Common modifier prefixes (and adjectives elsewhere) we strip out so a
 * summoned/conjured/spectral version of a creature still matches the
 * base creature's art. Spell-summoned creatures get prefixes like
 * "Conjured Air Elemental" or "Summoned Wolf"; resurrection effects
 * produce things like "Skeletal Ogre"; etc.
 */
const STRIP_TOKENS = new Set([
    "conjured", "summoned", "spectral", "phantasmal", "phantom", "ghostly",
    "skeletal", "zombified", "possessed", "shadow", "spirit", "young",
    "adult", "ancient", "wyrmling", "elder", "greater", "lesser", "dire",
    "giant", "swarm",
]);

/**
 * Build a normalized lookup string from the actor name by stripping
 * one or more leading modifier words. Returns the stripped form.
 *   "Conjured Air Elemental"  → "air elemental"
 *   "Adult Red Dragon"        → "red dragon"
 *   "Goblin Boss"             → "goblin boss"  (no leading modifier)
 *   "Summoned Spectral Wolf"  → "wolf"          (two strips)
 */
function _stripModifierPrefixes(lower) {
    let words = lower.split(/\s+/);
    let changed = true;
    while (changed && words.length > 1) {
        changed = false;
        if (STRIP_TOKENS.has(words[0])) {
            words = words.slice(1);
            changed = true;
        }
    }
    return words.join(" ").trim();
}

/**
 * Find candidate art for an actor by name.
 * Returns { matches: Entry[], reason: "exact" | "base" | "stripped" | "key" | "substring" | "none" }
 */
function _findMatches(actorName) {
    const lower = (actorName || "").toLowerCase().trim();
    if (!lower) return { matches: [], reason: "none" };

    // 1. Exact full-name match — "Goblin Archer" hits "Goblin - Archer.webp"
    //    OR a single file literally named "Goblin Archer.webp"
    const exact = _index.byFullName.get(lower);
    if (exact) return { matches: [exact], reason: "exact" };

    // 2. Base-name match — "Goblin" hits all Goblin variants
    const baseHits = _index.byBase.get(lower);
    if (baseHits?.length) return { matches: baseHits.slice(), reason: "base" };

    // 3. Strip modifier prefixes (Conjured/Summoned/Adult/...) and retry
    //    exact + base lookups. Most useful for spell-summoned creatures
    //    like "Conjured Air Elemental" → "Air Elemental".
    const stripped = _stripModifierPrefixes(lower);
    if (stripped && stripped !== lower) {
        const strippedExact = _index.byFullName.get(stripped);
        if (strippedExact) return { matches: [strippedExact], reason: "stripped" };
        const strippedBase = _index.byBase.get(stripped);
        if (strippedBase?.length) return { matches: strippedBase.slice(), reason: "stripped" };
    }

    // 4. Key-token match — normalize underscores/sizes/numbers and look
    //    up by sorted word set. Catches the user's SRD-pack layout:
    //      actor "Air Elemental"            → key "air elemental"
    //      files "Air_Large_Elemental_01..." → also key "air elemental"
    //    All 9 numbered variants resolve to the same actor.
    //    Try the original name first, then the modifier-stripped name.
    for (const candidate of [lower, stripped].filter(Boolean)) {
        const key = _keyTokensOf(candidate);
        if (!key) continue;
        const keyHits = _index.byKey.get(key);
        if (keyHits?.length) return { matches: keyHits.slice(), reason: "key" };
    }

    // 5. Substring fallback — actor "Goblin Boss" might match base "Goblin"
    //    if no "Goblin Boss.webp" exists. Picks the LONGEST matching base.
    //    Also catches cases the prefix-strip missed.
    let bestBase = null;
    for (const [base, entries] of _index.byBase.entries()) {
        if (lower.includes(base) && (!bestBase || base.length > bestBase.length)) {
            bestBase = base;
        }
    }
    if (bestBase) {
        const hits = _index.byBase.get(bestBase);
        return { matches: hits.slice(), reason: "substring" };
    }

    return { matches: [], reason: "none" };
}

/** Is this image path already inside one of the user's folders? */
function _imageIsInUserFolders(imgPath) {
    if (!imgPath) return false;
    let folders;
    try { folders = game.settings.get(MODULE_ID, "tokenArtFolders") ?? []; }
    catch (_) { return false; }
    return folders.some(f => f && imgPath.startsWith(f));
}

// ─── Recent-choices memory (so repeated drops pre-highlight last pick) ─────

function _getRecentChoices() {
    try { return game.settings.get(MODULE_ID, "tokenArtRecentChoices") ?? {}; }
    catch (_) { return {}; }
}

async function _setRecentChoice(actorName, path) {
    if (!game.user.isGM) return;
    const key = (actorName || "").toLowerCase().trim();
    if (!key) return;
    const recent = _getRecentChoices();
    recent[key] = path;
    try { await game.settings.set(MODULE_ID, "tokenArtRecentChoices", recent); } catch (_) {}
}

// ─── Token swap (also handles auto-rename if enabled) ──────────────────────

async function _applyArt(tokenDoc, entry, { renameSuffix = null } = {}) {
    if (!tokenDoc?.update) return;
    const update = { "texture.src": entry.path };
    // Auto-rename only when caller passes a non-null renameSuffix AND the
    // tokenDoc currently has the BASE name (so we don't clobber a hand-picked
    // name like "Strahd").
    if (renameSuffix) {
        const autoRename = (() => {
            try { return !!game.settings.get(MODULE_ID, "tokenArtAutoRename"); }
            catch (_) { return false; }
        })();
        if (autoRename) {
            const newName = `${tokenDoc.name} ${renameSuffix}`.trim();
            if (newName !== tokenDoc.name) update.name = newName;
        }
    }
    try { await tokenDoc.update(update); }
    catch (err) { console.warn(`${TAG} | Token update failed:`, err); }
}

// ─── Inline floating chooser ───────────────────────────────────────────────

function _dismissActiveChooser() {
    if (_activeChooser?.parentNode) {
        try { _activeChooser.parentNode.removeChild(_activeChooser); } catch (_) {}
    }
    _activeChooser = null;
}

/**
 * Pop a lightweight thumbnail chooser near the placed token. Resolves with
 * the chosen Entry, or null if dismissed without a choice (in which case the
 * pre-highlighted variant is used as the default).
 */
function _showChooser(tokenDoc, matches, { actorName } = {}) {
    return new Promise((resolve) => {
        _dismissActiveChooser();

        // Resolve screen position from token's canvas position
        const placed = canvas?.tokens?.placeables?.find(t => t.id === tokenDoc.id);
        let left = window.innerWidth / 2 - 220, top = window.innerHeight / 2 - 140;
        if (placed && canvas?.stage) {
            try {
                const worldX = placed.center?.x ?? (placed.x + placed.w / 2);
                const worldY = placed.center?.y ?? (placed.y + placed.h / 2);
                const screen = canvas.stage.toGlobal({ x: worldX, y: worldY });
                const rect = canvas.app.view.getBoundingClientRect();
                left = rect.left + screen.x - 220; // center the panel on the token
                top  = rect.top + screen.y - 240;  // float above the token
                // Keep on-screen
                left = Math.max(8, Math.min(left, window.innerWidth - 460));
                top  = Math.max(8, Math.min(top,  window.innerHeight - 280));
            } catch (_) { /* fallback to center */ }
        }

        // Determine highlight index from recent-choices memory
        const recent = _getRecentChoices();
        const lastPath = recent[(actorName || "").toLowerCase().trim()] ?? null;
        let highlightIdx = matches.findIndex(m => m.path === lastPath);
        if (highlightIdx < 0) highlightIdx = 0;

        // Build DOM
        const root = document.createElement("div");
        root.className = "ace-token-art-chooser";
        root.style.left = `${left}px`;
        root.style.top  = `${top}px`;
        root.tabIndex = 0;

        const header = document.createElement("div");
        header.className = "ace-tap-header";
        header.innerHTML = `<i class="fas fa-image"></i> <strong>${actorName ?? "Token"}</strong> — pick variant <span class="ace-tap-hint">(Enter • 1-9 • R random • Esc)</span>`;
        root.appendChild(header);

        const grid = document.createElement("div");
        grid.className = "ace-tap-grid";
        matches.forEach((m, i) => {
            const thumb = document.createElement("div");
            thumb.className = "ace-tap-thumb" + (i === highlightIdx ? " is-highlight" : "");
            thumb.dataset.idx = String(i);
            thumb.tabIndex = 0;
            thumb.innerHTML = `
                <img src="${m.path}" alt="${m.displayBase}${m.displayVariant ? " — " + m.displayVariant : ""}" />
                <div class="ace-tap-thumb-label">${m.displayVariant ?? "Base"}</div>
                ${i < 9 ? `<div class="ace-tap-thumb-key">${i + 1}</div>` : ""}
            `;
            thumb.addEventListener("click", (ev) => {
                ev.stopPropagation();
                finish(m);
            });
            thumb.addEventListener("mouseenter", () => {
                grid.querySelectorAll(".ace-tap-thumb").forEach(t => t.classList.remove("is-highlight"));
                thumb.classList.add("is-highlight");
                highlightIdx = i;
            });
            grid.appendChild(thumb);
        });
        root.appendChild(grid);

        // Footer hint
        const footer = document.createElement("div");
        footer.className = "ace-tap-footer";
        footer.textContent = `Auto-uses "${matches[highlightIdx]?.displayVariant ?? "Base"}" in 4s`;
        root.appendChild(footer);

        document.body.appendChild(root);
        _activeChooser = root;
        root.focus();

        let settled = false;
        let timeoutId = null;
        let countdownId = null;
        const startTime = Date.now();

        const finish = (entry) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(entry ?? matches[highlightIdx] ?? matches[0] ?? null);
        };

        const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId);
            if (countdownId) clearInterval(countdownId);
            document.removeEventListener("keydown", onKey, true);
            document.removeEventListener("mousedown", onOutsideClick, true);
            _dismissActiveChooser();
        };

        const onKey = (e) => {
            if (e.key === "Enter")            { e.preventDefault(); e.stopPropagation(); finish(matches[highlightIdx]); }
            else if (e.key === "Escape")      { e.preventDefault(); e.stopPropagation(); finish(matches[highlightIdx]); }
            else if (e.key.toLowerCase() === "r") {
                e.preventDefault(); e.stopPropagation();
                const random = matches[Math.floor(Math.random() * matches.length)];
                finish(random);
            }
            else if (/^[1-9]$/.test(e.key)) {
                const idx = parseInt(e.key, 10) - 1;
                if (matches[idx]) { e.preventDefault(); e.stopPropagation(); finish(matches[idx]); }
            }
            else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                let next = highlightIdx;
                if (e.key === "ArrowLeft" || e.key === "ArrowUp")    next = Math.max(0, highlightIdx - 1);
                else                                                  next = Math.min(matches.length - 1, highlightIdx + 1);
                highlightIdx = next;
                grid.querySelectorAll(".ace-tap-thumb").forEach((t, i) =>
                    t.classList.toggle("is-highlight", i === highlightIdx));
                footer.textContent = `Auto-uses "${matches[highlightIdx]?.displayVariant ?? "Base"}" in 4s`;
            }
        };
        document.addEventListener("keydown", onKey, true);

        const onOutsideClick = (e) => {
            if (!root.contains(e.target)) finish(matches[highlightIdx]);
        };
        document.addEventListener("mousedown", onOutsideClick, true);

        // Auto-dismiss countdown
        timeoutId = setTimeout(() => finish(matches[highlightIdx]), CHOOSER_TIMEOUT_MS);
        countdownId = setInterval(() => {
            const left = Math.max(0, CHOOSER_TIMEOUT_MS - (Date.now() - startTime));
            const sec = Math.ceil(left / 1000);
            footer.textContent = `Auto-uses "${matches[highlightIdx]?.displayVariant ?? "Base"}" in ${sec}s`;
        }, 250);
    });
}

// ─── createToken hook handler ──────────────────────────────────────────────

async function _onTokenCreated(tokenDoc, options, userId) {
    if (!game.user.isGM) return;
    if (userId !== game.user.id) return;
    let enabled = true;
    try { enabled = !!game.settings.get(MODULE_ID, "tokenArtEnabled"); } catch (_) {}
    if (!enabled) return;

    const actor = tokenDoc.actor;
    if (!actor) return;

    // Skip flag — actor explicitly opted out
    try {
        if (actor.getFlag(MODULE_ID, "skipAutoArt")) return;
    } catch (_) {}

    // Already user art — leave alone
    const currentImg = tokenDoc.texture?.src ?? "";
    if (_imageIsInUserFolders(currentImg)) return;

    // Wait for index to be ready (build it if not)
    if (!_index.ready) {
        try { await rebuildTokenArtIndex(); } catch (err) { console.warn(`${TAG} | Initial index build failed:`, err); }
    }

    const { matches, reason } = _findMatches(actor.name);

    if (matches.length === 0) {
        // Toast — once per actor name per session to avoid spam.
        // Also include the prefix-stripped form so the GM knows what
        // filename to drop in (e.g. "Conjured Air Elemental" → tried
        // "air elemental"; drop "Air Elemental.webp" to fix).
        const lower = (actor.name || "").toLowerCase().trim();
        const stripped = _stripModifierPrefixes(lower);
        _notifyMissing(actor.name, stripped !== lower ? stripped : null);
        return;
    }

    if (matches.length === 1) {
        // Silent swap; save as recent choice. No rename (no variant to add).
        const only = matches[0];
        const renameSuffix = (reason === "exact" || !only.displayVariant) ? null : only.displayVariant;
        await _applyArt(tokenDoc, only, { renameSuffix });
        await _setRecentChoice(actor.name, only.path);
        return;
    }

    // Multiple matches — pop the chooser
    const chosen = await _showChooser(tokenDoc, matches, { actorName: actor.name });
    if (!chosen) return;
    // Only suggest a rename if the chosen variant differs from the actor's
    // current name (e.g. actor "Goblin" picks "Archer" → "Goblin Archer";
    // actor "Goblin Archer" already exact-matched and never reached here).
    const renameSuffix = chosen.displayVariant && !tokenDoc.name.toLowerCase().includes(chosen.variantLower)
        ? chosen.displayVariant
        : null;
    await _applyArt(tokenDoc, chosen, { renameSuffix });
    await _setRecentChoice(actor.name, chosen.path);
}

// Throttle "no art" toasts to once per actor name per session so a swarm
// of identical missing-art creatures doesn't drown the screen.
const _missingNotified = new Set();
function _notifyMissing(actorName, strippedName = null) {
    const key = (actorName || "").toLowerCase().trim();
    if (_missingNotified.has(key)) return;
    _missingNotified.add(key);
    const suggestion = strippedName
        ? ` Tried "${strippedName}" too — drop "${strippedName.replace(/\b\w/g, c => c.toUpperCase())}.webp" in your folder, or art for "${actorName}" specifically.`
        : ` Drop "${actorName}.webp" in your folder.`;
    ui.notifications?.warn(`ACE: No token art for "${actorName}".${suggestion} Then run game.modules.get("ace-engine").api.rescanTokenArt() in the console.`);
    console.warn(`${TAG} | No match for "${actorName}"${strippedName ? ` (stripped: "${strippedName}")` : ""}. Add art to one of the configured folders and rescan.`);
}

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Activate the auto-token-art subsystem. Called from ace-engine.mjs ready hook.
 * GM-only. Idempotent — safe to call more than once.
 */
let _activated = false;
export function activateTokenArtEngine() {
    if (_activated) return;
    if (!game.user.isGM) return;
    _activated = true;

    // Build the index in the background after world load so first-spawn
    // doesn't pay the scan cost. createToken will await readiness if needed.
    rebuildTokenArtIndex().catch(err =>
        console.warn(`${TAG} | Initial index build failed:`, err)
    );

    Hooks.on("createToken", _onTokenCreated);
    console.log(`${TAG} | Auto Token Art active.`);
}
