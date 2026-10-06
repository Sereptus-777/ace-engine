/* ─── TAKE THE TILE LINES OUT OF THE HISTORY, FOR GOOD ────────────────────────
 *
 * His call, 2026-10-05: "Go ahead and also fucking erase all those hundreds of
 * tile lines from the memory. Those are absolute crap. I don't need them, and I
 * never will."
 *
 * There are 561 of them in 1,775 events: a third of the record of this campaign
 * is scenery being moved, and it buries the kills, the deeds and the notes under
 * it in the close dialog and in every recap written off that log.
 *
 * ⚠️ IT GOES THROUGH THE STORE, NOT THE FILE. `ace-history.json` is loaded in
 * memory and would be written back over any edit made behind Foundry's back, so
 * this calls the purge on the live memory manager and lets it save the way every
 * other write saves. It also prints a count before and after, because a purge
 * that reports nothing is indistinguishable from one that did nothing.
 *
 * Run it from the console:
 *   (async () => { const r = await fetch(`/modules/ace-engine/tools/purge-tile-lines.js?v=${Date.now()}`); eval(await r.text()); })();
 * ────────────────────────────────────────────────────────────────────────── */
(async () => {
  if (!game.user.isGM) return ui.notifications.warn("ACE: this is a GM job.");

  const api = game.modules.get("ace-engine")?.api;
  const mem = api?.getMemoryManager?.();
  if (!mem) {
    console.error("ACE | the memory manager is not on ace-engine's API, so nothing was touched. "
      + "Open ACE Engine once and run this again.");
    return ui.notifications.error("ACE: the memory manager is not available. Nothing was changed.");
  }
  if (typeof mem.purgeHistoryKinds !== "function") {
    console.error("ACE | this ace-engine does not carry purgeHistoryKinds, so nothing was touched. "
      + "Reload the world to pick up the new module code, then run this again.");
    return ui.notifications.error("ACE: reload the world first, then run this again.");
  }

  const KINDS = ["tile_placed", "tile_removed"];
  const events = mem.history?.events ?? [];
  const before = events.length;
  const counts = {};
  for (const e of events) counts[e?.k ?? "?"] = (counts[e?.k ?? "?"] ?? 0) + 1;

  console.log("%cACE | the history before the purge", "font-weight:700;font-size:14px");
  console.log(`  ${before} event(s) in total. By kind, the ten biggest:`);
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`     ${String(n).padStart(5)}  ${k}${KINDS.includes(k) ? "   <-- going" : ""}`);
  }

  const res = mem.purgeHistoryKinds(KINDS);

  // Read it back: the only proof.
  const after = mem.history?.events ?? [];
  const left = after.filter(e => KINDS.includes(e?.k)).length;
  console.log("%cACE | after the purge", "font-weight:700;font-size:14px");
  console.log(`  removed ${res.removed}, ${after.length} event(s) left, and ${left} tile line(s) `
    + `remain (it should be 0).`);
  console.log("  The save is scheduled through the store, so ace-history.json is rewritten the way "
    + "every other write is. Nothing was edited behind Foundry's back.");

  if (left === 0 && res.removed > 0) {
    ui.notifications.info(`ACE: ${res.removed} tile line(s) erased from the memory. `
      + `${after.length} real event(s) left. They will not come back: the hooks do not write them `
      + `any more.`);
  } else if (res.removed === 0) {
    ui.notifications.info("ACE: there were no tile lines left to erase.");
  } else {
    ui.notifications.warn(`ACE: ${res.removed} erased but ${left} are still there. The console has `
      + `the counts.`);
  }
})();
