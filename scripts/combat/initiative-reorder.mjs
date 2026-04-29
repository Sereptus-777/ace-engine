// ─── ACE: Engine — Initiative Reorder ─────────────────────────────────────
// Adds up/down arrow buttons to combat tracker entries so the GM can
// rearrange initiative order with a single click. Initiative values
// auto-adjust to maintain the new order.
//
// Moved from ace-envoy/src/combat/initiative-reorder.js as part of the
// Envoy → Engine merger. CSS classes renamed ace-envoy-init-* → ace-engine-init-*.

import { MODULE_ID } from "../ace-engine.mjs";

const TAG = "ACE: Engine | Initiative";

/**
 * Called from the renderCombatTracker hook in ace-engine.mjs.
 * Injects reorder arrows into each combatant row.
 * @param {CombatTracker} tracker
 * @param {HTMLElement|jQuery} html
 */
export function injectReorderButtons(tracker, html) {
    if (!game.user.isGM) return;
    if (!game.combat) return;

    try {
        if (!game.settings.get(MODULE_ID, "initiativeReorder")) return;
    } catch (_) { return; }

    const el = html instanceof HTMLElement ? html : html[0] ?? html;

    // Find all combatant entries — works across Foundry v11-v13
    const entries = el.querySelectorAll(".combatant, li[data-combatant-id]");
    if (!entries.length) return;

    for (const entry of entries) {
        // Avoid double-injecting (check both old envoy class and new engine class
        // during the migration window where both modules may be installed)
        if (entry.querySelector(".ace-engine-init-arrows, .ace-envoy-init-arrows")) continue;

        const combatantId = entry.dataset.combatantId;
        if (!combatantId) continue;

        // Create arrow container
        const arrows = document.createElement("div");
        arrows.className = "ace-engine-init-arrows";

        const upBtn = document.createElement("button");
        upBtn.className = "ace-engine-init-up";
        upBtn.innerHTML = `<i class="fas fa-caret-up"></i>`;
        upBtn.title = "Move up in initiative";
        upBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            _moveUp(combatantId);
        });

        const downBtn = document.createElement("button");
        downBtn.className = "ace-engine-init-down";
        downBtn.innerHTML = `<i class="fas fa-caret-down"></i>`;
        downBtn.title = "Move down in initiative";
        downBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            _moveDown(combatantId);
        });

        arrows.appendChild(upBtn);
        arrows.appendChild(downBtn);

        // Insert arrows before the initiative value or at the start of controls
        const initDisplay = entry.querySelector(".token-initiative, .combatant-control, .initiative");
        if (initDisplay) {
            initDisplay.parentNode.insertBefore(arrows, initDisplay);
        } else {
            entry.appendChild(arrows);
        }
    }
}

// ─── MOVE LOGIC ─────────────────────────────────────────────────────────────

async function _moveUp(combatantId) {
    const combat = game.combat;
    if (!combat) return;

    const sorted = combat.turns; // already sorted by initiative (descending)
    const idx = sorted.findIndex(c => c.id === combatantId);
    if (idx <= 0) return; // already first

    const target = sorted[idx];
    const above  = sorted[idx - 1];

    // Set target's initiative to be slightly above the one above it
    const aboveInit = above.initiative ?? 0;
    const furtherAbove = idx >= 2 ? (sorted[idx - 2]?.initiative ?? aboveInit + 2) : aboveInit + 2;
    const newInit = (aboveInit + furtherAbove) / 2;

    await target.update({ initiative: _round(newInit) });
    console.log(`${TAG} | Moved ${target.name} up: initiative ${target.initiative} → ${_round(newInit)}`);
}

async function _moveDown(combatantId) {
    const combat = game.combat;
    if (!combat) return;

    const sorted = combat.turns;
    const idx = sorted.findIndex(c => c.id === combatantId);
    if (idx < 0 || idx >= sorted.length - 1) return; // already last

    const target = sorted[idx];
    const below  = sorted[idx + 1];

    // Set target's initiative to be slightly below the one below it
    const belowInit = below.initiative ?? 0;
    const furtherBelow = idx + 2 < sorted.length ? (sorted[idx + 2]?.initiative ?? belowInit - 2) : belowInit - 2;
    const newInit = (belowInit + furtherBelow) / 2;

    await target.update({ initiative: _round(newInit) });
    console.log(`${TAG} | Moved ${target.name} down: initiative ${target.initiative} → ${_round(newInit)}`);
}

function _round(n) {
    return Math.round(n * 100) / 100;
}
