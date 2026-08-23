// ─── ACE Engine — rebuild the journal folder into something readable ───────
//
// One pass over the NPC Profiles folder that does three things:
//
//   1. Deletes what is not a creature. Furniture, map templates, stray image
//      imports. Johnny, asked whether he wanted them listed for veto first:
//      "just delete them".
//
//   2. Rebuilds every person as four linked pages instead of one stat dump.
//
//   3. Collects everything that is a KIND of creature into a Bestiary, one
//      entry per kind, carrying the tally that used to masquerade as a
//      character sheet. "Specter, Status: Killed by Kasimir Velikov" across
//      2,203 encounters becomes "Specter: 2,203 encountered, 31 killed".
//
// ⚠️ THE DATA IS NOT AT RISK. Every one of the 578 journals is already written
// out in full, verbatim, in `05 - THE JOURNALS.pdf` in his Downloads and in the
// markdown beside it, built earlier today. The creature records themselves live
// in ace-npcs.json and are never touched by this. Deleting a journal here
// deletes a rendering, not a record.
//
// ⚠️ TWO PASSES, DELIBERATELY. Links can only point at documents that exist, so
// nothing is linked until every journal has been created or deleted. Writing
// pages during the first pass would produce links to journals that were about
// to be removed, and miss every one created after.

import { classify, loadStatblockNames, baseName } from "./journal-identity.mjs";
import { buildPersonPages, buildBestiaryPages, buildPcPages, buildLinkIndex, writePages } from "./journal-pages.mjs";
import { getAllFactions } from "./faction-registry.mjs";
import { bandFor } from "../reputation-scale.mjs";

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | journals";
const NPC_FOLDER = "NPC Profiles";
const BESTIARY_FOLDER = "Bestiary";

/** Find or make a folder under the ACE journal tree. */
async function _folder(name) {
  let folder = game.folders?.find(f => f.type === "JournalEntry" && f.name === name);
  if (folder) return folder;
  const parent = game.folders?.find(f => f.type === "JournalEntry" && f.name === NPC_FOLDER)?.folder ?? null;
  folder = await Folder.create({ name, type: "JournalEntry", folder: parent?.id ?? null });
  return folder;
}

/**
 * Rebuild the journal folder.
 * @param {{dryRun?:boolean}} [opts] dryRun reports what it would do and changes nothing
 */
export async function rebuildJournals({ dryRun = false } = {}) {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Rebuilding journals is GM only.");
    return null;
  }

  const api = game.modules.get(MODULE_ID)?.api ?? null;
  // ⚠️ `memoryManager`. With the wrong name this rebuilt all 347 NPC journals
  // from a null store: every "Between Us" page came out empty and the pass
  // reported success.
  const memory = api?.memoryManager ?? null;
  const npcStore = memory?.npcs ?? null;

  await loadStatblockNames();

  const folder = game.folders?.find(f => f.type === "JournalEntry" && f.name === NPC_FOLDER);
  if (!folder) {
    console.warn(`${TAG} | no "${NPC_FOLDER}" folder — nothing to rebuild.`);
    return null;
  }
  const journals = (game.journal ?? []).filter(j => j.folder?.id === folder.id);
  console.log(`${TAG} | examining ${journals.length} journals${dryRun ? " (dry run)" : ""}…`);

  // ── Pass one: decide, delete, and gather ────────────────────────────────
  const people = [];
  const kinds = new Map();      // kind name -> {records, journals, named}
  const doomed = [];

  for (const journal of journals) {
    const name = baseName(journal.name);
    let rec = null;
    try { rec = npcStore?.getRecord?.(name) ?? npcStore?.getRecord?.(journal.name) ?? null; } catch (_) {}
    const verdict = classify(journal.name, rec);

    if (verdict.kind === "thing") {
      doomed.push({ journal, why: verdict.why });
      continue;
    }
    if (verdict.kind === "creature") {
      if (!kinds.has(name)) kinds.set(name, { records: [], journals: [], named: [] });
      const bucket = kinds.get(name);
      if (rec) bucket.records.push(rec);
      bucket.journals.push(journal);
      continue;
    }
    people.push({ journal, rec, verdict });
  }

  // A named individual belongs under its own kind in the bestiary, so the two
  // are connected rather than sitting in separate folders pretending not to be.
  for (const p of people) {
    const kind = p.verdict.actor?.system?.details?.type?.value
      || p.rec?.class || p.rec?.race || "";
    const bucket = kinds.get(baseName(kind));
    if (bucket) bucket.named.push(baseName(p.journal.name));
  }

  console.log(`${TAG} | ${people.length} people · ${kinds.size} kinds of creature · `
    + `${doomed.length} not creatures at all`);

  if (dryRun) {
    console.log(`${TAG} | would delete:`, doomed.map(d => `${d.journal.name} (${d.why})`));
    return { people: people.length, kinds: kinds.size, deleted: doomed.length, dryRun: true };
  }

  // ── Delete what is not a creature ───────────────────────────────────────
  let deleted = 0;
  if (doomed.length) {
    const ids = doomed.map(d => d.journal.id);
    try {
      await JournalEntry.deleteDocuments(ids);
      deleted = ids.length;
    } catch (err) {
      console.error(`${TAG} | bulk delete failed, falling back one at a time:`, err);
      for (const d of doomed) {
        try { await d.journal.delete(); deleted++; } catch (e) {
          console.warn(`${TAG} | could not delete "${d.journal.name}":`, e);
        }
      }
    }
  }

  // ── Fold each kind into one bestiary entry ──────────────────────────────
  const bestiaryFolder = kinds.size ? await _folder(BESTIARY_FOLDER) : null;
  const bestiary = [];
  for (const [kind, bucket] of kinds) {
    // Keep the first journal as the entry, move it, and drop the duplicates.
    const keep = bucket.journals[0];
    const extras = bucket.journals.slice(1);
    try {
      if (keep.folder?.id !== bestiaryFolder.id) {
        await keep.update({ folder: bestiaryFolder.id });
      }
      if (extras.length) {
        await JournalEntry.deleteDocuments(extras.map(j => j.id));
        deleted += extras.length;
      }
      bestiary.push({ journal: keep, kind, bucket });
    } catch (err) {
      console.warn(`${TAG} | could not fold "${kind}" into the bestiary:`, err);
    }
  }

  // ── Pass two: everything exists, so now it can be linked ────────────────
  const linkIndex = buildLinkIndex();
  console.debug(`${TAG} | link index holds ${linkIndex.size} names.`);

  // ⚠️ 475 journals at four pages each is roughly 1,900 document writes, and
  // every one broadcasts to connected clients. Done in a tight loop with no
  // yield, Foundry's interface locks solid and the only thing the GM can see is
  // an application that has stopped responding. Progress is announced, the loop
  // yields, and the notification says what is happening before it starts.
  ui.notifications?.info(`ACE is rewriting ${people.length} character journals. `
    + `This takes a minute; the world stays usable.`);

  let rebuilt = 0;
  for (const p of people) {
    if (rebuilt && rebuilt % 50 === 0) {
      console.log(`${TAG} | ${rebuilt}/${people.length} rewritten…`);
      await new Promise(r => setTimeout(r, 0));   // let the interface breathe
    }
    try {
      const faction = _factionOf(p.verdict.actor);
      // ⚠️ api.getFactionScore returns a NUMBER. There is no label method on the
      // API, and reaching for one with `?.` would have returned undefined
      // forever without ever throwing. The band names live in reputation-scale.
      const standing = faction?.id
        ? (bandFor(api?.getFactionScore?.(faction.id) ?? 0)?.label ?? null)
        : null;
      const pages = buildPersonPages(p.rec, { actor: p.verdict.actor, faction, standing });
      await writePages(p.journal, pages, linkIndex);
      rebuilt++;
    } catch (err) {
      console.warn(`${TAG} | could not rebuild "${p.journal.name}":`, err);
    }
  }

  let tallied = 0;
  for (const b of bestiary) {
    try {
      const pages = buildBestiaryPages(b.kind, {
        records: b.bucket.records,
        named: b.bucket.named,
      });
      await writePages(b.journal, pages, linkIndex);
      tallied++;
    } catch (err) {
      console.warn(`${TAG} | could not tally "${b.kind}":`, err);
    }
  }

  // ── The player characters ───────────────────────────────────────────────
  //
  // ⚠️ THESE WERE STALE AND NOBODY COULD SEE WHY. Johnny: "in the journals it's
  // not showing up what level they are at." Chudd is 9th and his page said 7th,
  // Firaxis the same, and Syrax showed 7th when he is Warlock 7 / Paladin 2,
  // which is 9th. The page was printing a level COPIED into the store months
  // ago. It now reads the character, and totals the class levels.
  const pcs = await rebuildPcJournals(linkIndex);

  const summary = { people: rebuilt, bestiary: tallied, deleted, pcs };
  console.log(`${TAG} | done. ${rebuilt} people rewritten, ${tallied} bestiary entries, `
    + `${pcs} player characters, ${deleted} non-creatures removed.`);
  ui.notifications?.info(
    `ACE journals rebuilt: ${rebuilt} characters, ${tallied} bestiary entries, `
    + `${pcs} player characters, ${deleted} removed.`);
  return summary;
}

/**
 * Rewrite the PC Profiles folder as three pages each: who they are, what they
 * have done, and the numbers.
 */
export async function rebuildPcJournals(linkIndex = null) {
  const api = game.modules.get(MODULE_ID)?.api ?? null;
  const store = api?.memoryManager?.pcs ?? null;

  const folder = game.folders?.find(f => f.type === "JournalEntry" && f.name === "PC Profiles");
  if (!folder) {
    console.warn(`${TAG} | no "PC Profiles" folder.`);
    return 0;
  }
  const index = linkIndex ?? buildLinkIndex();
  let done = 0;

  for (const journal of (game.journal ?? []).filter(j => j.folder?.id === folder.id)) {
    const name = baseName(journal.name);
    const actor = (game.actors ?? []).find(a => baseName(a.name) === name) ?? null;

    // ⚠️ Only creatures somebody actually plays. The folder has picked up a
    // token called "download", an "ACE Test Dummy" and a "Group Map Token".
    if (!actor || !(actor.hasPlayerOwner || actor.type === "character")) {
      const verdict = classify(journal.name, null);
      if (verdict.kind === "thing") {
        try { await journal.delete(); } catch (_) { /* already gone */ }
      }
      continue;
    }
    let rec = null;
    try { rec = store?.getRecord?.(actor.id) ?? store?.getRecord?.(name) ?? null; } catch (_) {}

    try {
      await writePages(journal, buildPcPages(rec, { actor }), index);
      done++;
    } catch (err) {
      console.warn(`${TAG} | could not rewrite "${journal.name}":`, err);
    }
  }
  return done;
}

/** The faction record an actor belongs to, if any. */
function _factionOf(actor) {
  if (!actor) return null;
  let id = "";
  try { id = actor.getFlag(MODULE_ID, "factionId") || ""; } catch (_) { return null; }
  if (!id) return null;
  const f = (getAllFactions() ?? {})[id];
  return f ? { id, ...f } : null;
}

/**
 * Run once, automatically, the first time this version loads.
 *
 * ⚠️ `Hooks.once("ready")` FROM INSIDE `ready` NEVER FIRES. Every ACE subsystem
 * starts from the entry file's own ready handler, so a registration that waits
 * on ready is waiting on an event already in progress. Nothing throws and
 * nothing logs; the pass simply never runs. Proven live on 2026-08-12 when 13
 * condition ghosts survived every load.
 */
export function installJournalRebuild() {
  const run = async () => {
    try {
      if (!game.user?.isGM) return;
      if (game.users?.activeGM !== game.user) return;   // one client writes
      const current = game.modules.get(MODULE_ID)?.version ?? "";
      const last = game.settings.get(MODULE_ID, "journalRebuildVersion");
      if (last === current) return;
      await rebuildJournals();
      await game.settings.set(MODULE_ID, "journalRebuildVersion", current);
    } catch (err) {
      console.error(`${TAG} | one-shot rebuild failed:`, err);
    }
  };
  if (game.ready) run();
  else Hooks.once("ready", run);
}
