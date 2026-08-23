// ─── ACE Engine — forget the dealt opinions, then earn them back ────────────
//
// Johnny, 2026-08-22, on being shown that 82 real deeds had moved nothing and
// that 233 of 236 faction scores were an artifact of a starting roll he never
// asked for: "yes, green light on all four."
//
// This does the fourth thing. It wipes every faction's OPINION of the party,
// then walks the recorded deeds back through the now-working pipeline so that
// every number in the world is one the party earned at the table.
//
// ⚠️ WIPING IS SAFE AND WIPING IS NARROW. Membership is a flag on the creature
// and the faction registry is a separate file; neither is touched. Vladimir
// stays in the Order of the Silver Dragon, Varek stays in the Amber Collective.
// What is forgotten is only what those factions THINK of the party.
//
// ⚠️ AND IT MUST NOT DOUBLE-COUNT. Replaying with the propagation hook still
// live would apply each deed twice, once from the replay and once from the
// re-record. Nothing here re-records: it reads the stored deeds and calls the
// propagation directly.

import { enrichDeed } from "./deed-valence.mjs";
import { propagateDeed } from "./deed-propagation.mjs";
import { getAllFactions } from "./npc/faction-registry.mjs";
import { bandFor } from "./reputation-scale.mjs";

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | deed replay";

/**
 * Every deed we have on record, from whichever store actually holds them.
 *
 * ⚠️ SAY WHICH SOURCE ANSWERED. ACE has moved deeds between a DeedStore and a
 * world-event ledger, and a reader that silently picks the empty one looks
 * exactly like a world with no history. If none of them answer, that is
 * reported as a failure rather than as "nothing to do".
 */
export function collectDeeds(memory) {
  const tries = [
    ["deed store getAll",  () => memory?.deeds?.getAll?.()],
    ["deed store all",     () => memory?.deeds?.all?.()],
    ["deed store data",    () => memory?.deeds?._data?.deeds],
    ["world-event ledger", () => memory?._ledger?._data?.events],
    ["ledger getEvents",   () => memory?._ledger?.getEvents?.()],
  ];
  for (const [label, get] of tries) {
    let rows = null;
    try { rows = get(); } catch (_) { continue; }
    if (Array.isArray(rows) && rows.length) {
      console.log(`${TAG} | reading ${rows.length} deeds from the ${label}.`);
      return { rows, label };
    }
  }
  return { rows: [], label: "nothing answered" };
}

/** Normalise whichever shape the store gave us into what the pipeline wants. */
function asDeed(row) {
  return {
    text:      row.text ?? row.summary ?? row.txt ?? "",
    magnitude: row.magnitude ?? "local",
    scene:     row.scene ?? row.s ?? "",
    source:    row.source ?? "",
    pcs:       row.pcs ?? row.nouns?.actors ?? [],
    factions:  row.factions ?? row.nouns?.factions ?? [],
    factionId: row.factionId ?? "",
    valence:   row.valence ?? "",
    timestamp: row.timestamp ?? row.ts ?? row.t ?? 0,
  };
}

/**
 * Wipe and replay.
 *
 * @param {{wipe?:boolean, dryRun?:boolean}} [opts]
 *   dryRun reports exactly what it would do and changes nothing.
 */
export async function replayDeeds({ wipe = true, dryRun = false } = {}) {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Replaying deeds is GM only.");
    return null;
  }
  if (game.users?.activeGM !== game.user) {
    console.warn(`${TAG} | another GM is the active one; not replaying here.`);
    return null;
  }

  const api = game.modules.get(MODULE_ID)?.api;
  if (!api?.adjustFactionScore) {
    console.error(`${TAG} | the reputation API is not up. Nothing replayed.`);
    ui.notifications?.error("ACE: reputation engine not ready. Nothing was changed.");
    return null;
  }

  // ⚠️ `memoryManager`, NOT `memory`. There is no `api.memory` and there never
  // was; the getter is `get memoryManager()`. Every read was optional-chained,
  // so nothing threw, the deed collector found no store, and this reported
  // "no deeds found" as though the world had no history. Three other files in
  // this module had the correct name the whole time.
  const memory = api.memoryManager;
  const { rows, label } = collectDeeds(memory);
  if (!rows.length) {
    console.error(`${TAG} | no deeds found (${label}). Nothing replayed.`);
    return null;
  }

  // ── Judge them all first, so the report is honest before anything moves ──
  const judged = [];
  const skipped = { travel: 0, neutral: 0, noFaction: 0, trivial: 0 };
  const all = getAllFactions() ?? {};

  for (const row of rows) {
    const deed = asDeed(row);
    if (!deed.text) continue;
    if (deed.source === "auto:travel") { skipped.travel++; continue; }
    enrichDeed(deed);
    if (deed.valence === "neutral") { skipped.neutral++; continue; }
    if (String(deed.magnitude).toLowerCase() === "trivial") { skipped.trivial++; continue; }
    if (!deed.factionId || !all[deed.factionId]) { skipped.noFaction++; continue; }
    judged.push(deed);
  }

  console.log(`${TAG} | ${rows.length} on record · ${judged.length} will move a faction`);
  console.log(`${TAG} | set aside: ${skipped.travel} travel, ${skipped.trivial} trivial, `
    + `${skipped.neutral} nothing-moving, ${skipped.noFaction} with nobody to blame`);

  if (dryRun) {
    return { total: rows.length, wouldMove: judged.length, skipped, dryRun: true };
  }

  // ── Forget the dealt opinions ────────────────────────────────────────────
  let cleared = 0;
  if (wipe) {
    const res = await api.resetAllStandings?.(game.world?.id);
    cleared = res?.cleared ?? 0;
    if (!res) {
      console.error(`${TAG} | resetAllStandings is missing from the API. Stopping rather `
        + `than replaying on top of the rolled scores.`);
      return null;
    }
  }

  // ── Earn them back ───────────────────────────────────────────────────────
  let applied = 0;
  for (const deed of judged) {
    const res = await propagateDeed(deed);
    if (res) applied++;
  }

  const scores = api.getAllFactionScores?.() ?? null;
  const moved = scores
    ? Object.entries(scores).filter(([, v]) => v).length
    : judged.reduce((n, d) => n + 1, 0);

  console.log(`${TAG} | done. ${cleared} opinions forgotten, ${applied} deeds applied, `
    + `${moved} factions now hold a view the party earned.`);
  ui.notifications?.info(
    `ACE: reputation rebuilt from ${applied} real deeds. ${cleared} dealt opinions cleared.`);

  return { total: rows.length, applied, cleared, skipped, source: label };
}

/**
 * Run once per version, automatically.
 *
 * ⚠️ `Hooks.once("ready")` from inside `ready` never fires. Everything in ACE
 * starts from the entry file's own ready handler, so a registration that waits
 * on ready waits on an event already in progress, silently.
 */
export function installDeedReplay() {
  const run = async () => {
    try {
      if (!game.user?.isGM) return;
      if (game.users?.activeGM !== game.user) return;
      const current = game.modules.get(MODULE_ID)?.version ?? "";
      const last = game.settings.get(MODULE_ID, "deedReplayVersion");
      if (last === current) return;

      // ⚠️ Wait for the reputation API rather than reading it once and giving
      // up. Reading it too early is what stopped an earlier faction repair from
      // resetting a single standing, while reporting itself as done.
      let api = game.modules.get(MODULE_ID)?.api;
      for (let waited = 0; !api?.adjustFactionScore && waited < 20000; waited += 250) {
        await new Promise(r => setTimeout(r, 250));
        api = game.modules.get(MODULE_ID)?.api;
      }
      if (!api?.adjustFactionScore) {
        console.warn(`${TAG} | reputation API never came up; not marking this done.`);
        return;
      }

      // ⚠️ FACTIONS FIRST, DEEDS SECOND. A deed can only land on somebody who
      // exists, and 12 of the 18 creatures this party has killed belonged to
      // nothing at all. Replaying before the sweep would apply 82 deeds against
      // an almost empty world, mark itself done, and never run again.
      try {
        const { assignFactionsToExisting } = await import("./npc/faction-assign-existing.mjs");
        const sweep = await assignFactionsToExisting({
          // ⚠️ NEVER INVENTS A FACTION. Everything must find a home among the
          // 461 that already exist. See faction-assign-existing.mjs.
          memory: api.memoryManager, force: true, foundTribes: false,
        });
        if (sweep) {
          console.log(`${TAG} | ${sweep.assigned?.length ?? 0} creature(s) given a faction `
            + `before replaying deeds.`);
        }
      } catch (err) {
        console.warn(`${TAG} | the faction sweep failed; replaying against what exists:`, err);
      }

      const res = await replayDeeds();
      // ⚠️ Only mark it done if it actually did something. Marking a failed run
      // as complete is how a repair pass gets silently skipped forever.
      if (res?.applied !== undefined) {
        await game.settings.set(MODULE_ID, "deedReplayVersion", current);
      }
    } catch (err) {
      console.error(`${TAG} | replay failed:`, err);
    }
  };
  if (game.ready) run();
  else Hooks.once("ready", run);
}
