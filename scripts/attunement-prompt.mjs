// ─── ACE: Engine — Attunement Prompt ──────────────────────────────────────────
// When a magic item that REQUIRES attunement is added to a player character's
// inventory, pop up a dialog explaining attunement + offering to either
// auto-attune (treats as 1-hour focus during current/next short rest) or
// dismiss.
//
// Trigger: dnd5e item.system.attunement === 1 (REQUIRES — not yet attuned)
// Skips:   attunement === 0 (no attunement needed)
//          attunement === 2 (already attuned)
//          NPCs (only PCs benefit from this UX)
//          unidentified items (attunement should wait for identification)
//
// RAW reference: PHB p.138 — attunement requires 1 hour focus during a short
// rest, max 3 attuned items per creature.
//
// Setting: `attunementPromptEnabled` (default ON, world-scope, GM controls)
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-engine";

export class AttunementPrompt {

  /**
   * Install the createItem hook. Called once from ace-engine.mjs ready hook.
   */
  static register() {
    Hooks.on("createItem", (item, _options, userId) => {
      try {
        // Only the user who created the item handles the prompt — avoids
        // GM + player both popping the dialog when item drops onto a PC
        // owned by both.
        if (userId !== game.user.id) return;

        // Setting gate — opt-out for tables that prefer manual attunement
        try {
          if (game.settings.get(MODULE_ID, "attunementPromptEnabled") === false) return;
        } catch (_) { return; }

        const actor = item.parent;
        if (!actor || actor.documentName !== "Actor") return;
        if (actor.type !== "character") return; // PCs only — NPCs use NPC item logic

        // Attunement state check — dnd5e 5.x data model:
        //   system.attunement: "" | "required" | "optional"  (string!)
        //   system.attuned:    boolean (true = currently attuned)
        // OLDER dnd5e versions used numeric attunement (0/1/2). Defense-in-depth
        // for both: trigger if attunement is "required" (string) OR === 1 (legacy)
        // AND not yet attuned.
        const att = item.system?.attunement;
        const isRequired = att === "required" || att === 1 || att === "1";
        if (!isRequired) return;
        const isAttuned = item.system?.attuned === true || item.system?.attunement === 2;
        if (isAttuned) return;

        // Identified check — don't prompt on unidentified items (the player
        // doesn't know it's magical yet from the in-fiction perspective)
        if (item.system?.identified === false) return;

        // Owner check — only prompt if the running user owns the actor
        if (!actor.isOwner) return;

        // Defer to next tick so the item finishes creating before the dialog opens
        setTimeout(() => {
          AttunementPrompt._showDialog(actor, item).catch(err =>
            console.warn(`${MODULE_ID} | AttunementPrompt dialog threw:`, err)
          );
        }, 0);
      } catch (err) {
        console.warn(`${MODULE_ID} | AttunementPrompt.createItem hook threw:`, err);
      }
    });

    console.debug(`${MODULE_ID} | AttunementPrompt registered`);
  }

  // ─── Dialog ────────────────────────────────────────────────────────────────

  static async _showDialog(actor, item) {
    // Count currently-attuned items on the actor (RAW max = 3)
    // dnd5e 5.x uses `system.attuned` boolean; older versions used `attunement === 2`.
    let currentAttunedCount = 0;
    for (const it of actor.items ?? []) {
      if (it.system?.attuned === true || it.system?.attunement === 2) currentAttunedCount++;
    }
    const atMax = currentAttunedCount >= 3;

    const accent = "#d4af37";
    const itemImg = item.img || "icons/svg/item-bag.svg";
    const itemName = item.name || "this item";
    const slotsRemaining = Math.max(0, 3 - currentAttunedCount);
    const slotsText = atMax
      ? `<strong style="color:#e08a5b;">You're at the 3-item attunement limit — drop another item's attunement first.</strong>`
      : `<span style="color:#c0b288;">Currently attuned to <strong>${currentAttunedCount}</strong> of 3 items (${slotsRemaining} slot${slotsRemaining === 1 ? "" : "s"} free).</span>`;

    const content = `
      <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                  border:2px solid ${accent};
                  border-radius:6px;
                  padding:16px;
                  color:#f0e4c0;
                  font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="display:flex;align-items:center;gap:12px;
                    border-bottom:1px solid #4a3a28;padding-bottom:10px;margin-bottom:12px;">
          <img src="${itemImg}" alt="${itemName}"
               style="width:56px;height:56px;border-radius:4px;border:1px solid #6b5230;object-fit:cover;flex-shrink:0;" />
          <div>
            <div style="font-size:18px;font-weight:700;color:${accent};
                        text-transform:uppercase;letter-spacing:0.5px;">
              <i class="fas fa-link" style="margin-right:6px;"></i>Attunement Required
            </div>
            <div style="font-size:15px;color:#e8d49a;margin-top:4px;">
              <strong>${itemName}</strong> needs attunement before its magical properties activate.
            </div>
          </div>
        </div>

        <div style="font-size:14px;line-height:1.55;color:#f0e4c0;margin-bottom:10px;">
          Attuning requires <strong>1 hour of focus</strong> during a short or long rest
          (e.g., meditation, weapon practice, or close study of the item).
        </div>

        <div style="background:rgba(212,175,55,0.08);border:1px solid #4a3a28;
                    border-radius:4px;padding:8px 12px;margin-bottom:12px;font-size:13px;">
          ${slotsText}
        </div>

        <div style="font-size:13px;color:#8a7a5a;font-style:italic;text-align:center;">
          Accept to attune immediately (treated as having spent the focus time during your next rest).
        </div>
      </div>
    `;

    const buttons = atMax
      ? [{
          action: "dismiss",
          label: "Got It",
          icon: "fas fa-check",
          default: true,
          callback: () => null,
        }]
      : [
          {
            action: "attune",
            label: "Attune Now",
            icon: "fas fa-link",
            default: true,
            callback: async () => {
              try {
                // dnd5e 5.x: set system.attuned = true (boolean)
                // Legacy: also write attunement = 2 for older dnd5e versions.
                await item.update({
                  "system.attuned": true,
                  "system.attunement": item.system?.attunement === "required" ? "required" : 2,
                });
                ui.notifications?.info(`${actor.name} attuned to ${itemName}.`);
              } catch (err) {
                console.error(`${MODULE_ID} | AttunementPrompt: attune update failed:`, err);
                ui.notifications?.error(`Could not attune ${itemName} — check console.`);
              }
            },
          },
          {
            action: "later",
            label: "Attune Later",
            icon: "fas fa-clock",
            callback: () => null,
          },
        ];

    try {
      await foundry.applications.api.DialogV2.wait({
        window: { title: `Attunement — ${itemName}`, icon: "fas fa-link" },
        position: { width: 520, height: "auto" },
        content,
        buttons,
        rejectClose: false,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | AttunementPrompt dialog wait threw:`, err);
    }
  }
}
