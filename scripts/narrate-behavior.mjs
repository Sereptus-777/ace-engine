// ─── A REGION THAT NARRATES WHEN THE PARTY WALKS IN ──────────────────────────
//
// Johnny, 2026-10-15: "whether it's a tile that I click on, the fucking scene,
// and the narration begins." Draw a region over the doorway, add this
// behaviour, type the title of a narration saved on this scene, and the first
// player token through plays it: chat card, narrator voice, every player hears.
//
// It plays once and then switches itself off, so a whole party walking through
// the same door does not hear it five times. Switch it back on in the region to
// use it again.
//
// ⚠️ ONLY THE ACTIVE GM PLAYS IT. Region events reach every connected screen,
// and only the GM's browser holds the ElevenLabs key.
//
// ⚠️ TOKEN_ENTER, NOT TOKEN_MOVE_IN (the same reason as Forge's Ground Level):
// the move variants fire only for a token's own movement, so a party teleported
// INTO a region (the blue portal's arrival at Ravenloft) would never set it off.
//
// ⚠️ KEEP EVERY LABEL UNDER ~18 CHARACTERS. Foundry wraps a longer label onto a
// second line in the region form (Johnny, 2026-08-13). Wording goes in the hint.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-engine";
const LOG = `${MODULE_ID} | narrate region`;
const { REGION_EVENTS } = globalThis.CONST ?? {};

export class NarrateBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["ACE.REGIONBEHAVIORS.NARRATE"];

  static defineSchema() {
    const fields = foundry.data.fields;
    return {
      narration: new fields.StringField({
        required: true, blank: true, initial: "",
        label: "Narration",
        hint: "The title of a narration saved on this scene in ACE Engine's Narration tab, for example: X5 entry. "
          + "It plays once, the first time a token walks in, then this behaviour switches itself off.",
      }),
      playersOnly: new fields.BooleanField({
        initial: true,
        label: "Players only",
        hint: "Only a token a player owns sets it off. A monster you move through the doorway does nothing.",
      }),
    };
  }

  /** Behaviours already set off this session, so a party arriving together plays it once. */
  static #fired = new Set();

  static async #onEnter(event) {
    // SILENT-OK: every connected screen hears the region event; only the active GM plays it
    if (game.users?.activeGM !== game.user) return;
    const behavior = this.parent;
    const token = event?.data?.token ?? null;
    const title = String(this.narration ?? "").trim();
    if (!title) {
      ui.notifications?.warn(`ACE: the "${behavior?.name || "Narrate"}" region on ${this.scene?.name} has no narration title, so nothing played.`);
      return;
    }
    if (this.playersOnly && !token?.actor?.hasPlayerOwner) {
      console.debug(`${LOG} | ${token?.name ?? "a token"} walked into the "${title}" region and is not a player's, so it did not play.`);
      return;
    }
    if (!behavior?.uuid || NarrateBehaviorType.#fired.has(behavior.uuid)) return; // SILENT-OK: already playing for this party
    NarrateBehaviorType.#fired.add(behavior.uuid);

    const api = game.modules.get(MODULE_ID)?.api;
    if (typeof api?.playNarration !== "function") {
      NarrateBehaviorType.#fired.delete(behavior.uuid);
      ui.notifications?.error(`ACE: "${title}" could not play: ACE Engine's narration is not loaded.`);
      return;
    }
    console.log(`${LOG} | ${token?.name ?? "A token"} walked in: playing "${title}" on ${this.scene?.name}.`);
    const played = await api.playNarration(title, { scene: this.scene });
    if (!played) {
      NarrateBehaviorType.#fired.delete(behavior.uuid);   // it said why; leave it switched on
      return;
    }
    try {
      await behavior.update({ disabled: true });
      // Switched off now, so it hears nothing more; switching it back on plays it again.
      NarrateBehaviorType.#fired.delete(behavior.uuid);
    } catch (err) {
      console.warn(`${LOG} | "${title}" played, but the region could not switch itself off, so it stays quiet until a reload:`, err);
    }
  }

  static events = {
    [REGION_EVENTS?.TOKEN_ENTER ?? "tokenEnter"]: NarrateBehaviorType.#onEnter,
  };
}
