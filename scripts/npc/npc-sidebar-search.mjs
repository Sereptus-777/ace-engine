// ─── ACE: Engine — find an NPC by WHAT it is, not just what it's called ─────
//
// Johnny, 2026-08-06: a named NPC's sidebar row now says "Thalgar Stonehide"
// rather than "Ogre" — which is the whole point, because a row called "Ogre"
// is unfindable five sessions later. But:
//
//   "I do, however, want it indicated in the search. I should be able to find
//    Ogre, because what if I don't remember its name… I should be able to just
//    look up, and it'll still find it, but it should come up as its name."
//
// So the row shows the NAME and the search matches the SPECIES too. Typing
// "ogre" finds Thalgar; the list still reads "Thalgar Stonehide".
//
// The rename stamps two flags for exactly this: `species` ("ogre") and
// `originalName` (the statblock's own name, e.g. "Ogre" or "Ogre Chieftain").
//
// ⚠️ FEATURE-DETECTED, DELIBERATELY. This wraps a Foundry directory internal,
// and I could not read the V13 source on this machine to confirm its shape —
// so it is not assumed. If the method isn't there, we log it plainly and do
// nothing; the rename still works, only species-search is missing. Guessing at
// an API we cannot see is exactly how `canvas.walls.checkCollision` silently
// disabled wall checks twice (2026-08-06) — never again.

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Sidebar";

/** Everything this actor should be findable by, besides its own name. */
function searchAliases(actor) {
  const out = [];
  try {
    const sp = actor?.getFlag?.(MODULE_ID, "species");
    const orig = actor?.getFlag?.(MODULE_ID, "originalName");
    if (sp) out.push(String(sp).toLowerCase());
    if (orig) out.push(String(orig).toLowerCase());
    // The creature-type fields, so even NPCs we never renamed are findable
    // by kind — "fiend", "cambion", whatever the sheet actually says.
    const t = actor?.system?.details?.type ?? {};
    for (const v of [t.value, t.subtype, t.custom]) {
      if (v) out.push(String(v).toLowerCase());
    }
  } catch (_) { /* never break the sidebar over a search alias */ }
  return out;
}

function matchesAlias(actor, query) {
  const q = String(query ?? "").toLowerCase().trim();
  if (!q) return false;
  return searchAliases(actor).some(a => a.includes(q));
}

/**
 * Wrap the actor directory's search matcher so species/original-name also hit.
 * Returns true when the wrap was installed.
 */
export function installNpcSidebarSearch() {
  try {
    const cls = foundry.applications?.sidebar?.tabs?.ActorDirectory
             ?? globalThis.ActorDirectory
             ?? null;
    if (!cls) {
      console.warn(`${TAG} | ActorDirectory class not found — species search unavailable (renaming still works).`);
      return false;
    }

    const proto = cls.prototype;
    const FN = "_matchSearchEntries";
    if (typeof proto?.[FN] !== "function") {
      console.warn(`${TAG} | ${cls.name}#${FN} is not a function on this Foundry build — species search unavailable (renaming still works). Nothing was patched.`);
      return false;
    }
    if (proto[FN].__aceWrapped) return true;      // never double-wrap

    const original = proto[FN];
    function wrapped(query, entryIds, folderIds, autoExpandIds, ...rest) {
      // Let Foundry do its normal name matching first — we only ever ADD.
      const result = original.call(this, query, entryIds, folderIds, autoExpandIds, ...rest);
      try {
        const rx = query instanceof RegExp ? query : null;
        const text = rx ? rx.source.replace(/\\/g, "") : String(query ?? "");
        if (!text.trim()) return result;

        for (const actor of (this.documents ?? game.actors ?? [])) {
          if (!actor || entryIds?.has?.(actor.id)) continue;
          if (!matchesAlias(actor, text)) continue;
          entryIds?.add?.(actor.id);
          // Open the folders needed to reveal it, exactly as Foundry does.
          let f = actor.folder;
          while (f) { folderIds?.add?.(f.id); autoExpandIds?.add?.(f.id); f = f.folder; }
        }
      } catch (err) {
        console.warn(`${TAG} | species search pass failed (name search unaffected):`, err);
      }
      return result;
    }
    wrapped.__aceWrapped = true;
    proto[FN] = wrapped;
    console.log(`${TAG} | Species search installed — typing a creature type also finds renamed NPCs.`);
    return true;
  } catch (err) {
    console.warn(`${TAG} | Could not install species search (renaming still works):`, err);
    return false;
  }
}
