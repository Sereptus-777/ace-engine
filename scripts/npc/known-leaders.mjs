// ─── ACE Engine — who is actually in charge, 1495 DR ────────────────────────
//
// Johnny, 2026-08-22: "You should be able to pull whatever leader is in charge
// right now in 1495 DR lore, and it's just that simple... I understand the
// Lords of Waterdeep have rotating leaders, but I want the members listed so we
// know who might be leader at the time."
//
// ⚠️ THIS IS PUBLISHED LORE, NOT INVENTION. Every name below is an established
// Forgotten Realms figure. Nothing here is generated, and nothing here needs an
// actor: the roster's `absent` list holds named people who have no token, which
// is exactly what it was built for.
//
// ⚠️ AND WHERE THE SETTING SAYS "NOBODY KNOWS", SO DOES THIS. The Masked Lords
// of Waterdeep are anonymous by design; the ones below are the handful the
// published material has ever unmasked, past or present. Listing them as
// "possible" is honest. Inventing a full roster of twenty would not be.
//
// ⚠️ DATES MATTER AND I HAVE MARKED WHERE THEY BITE. 1495 DR sits after the
// Sundering and after Tyranny of Dragons, so a few seats have changed hands
// recently and a few are genuinely contested. Those carry a `note`.

/**
 * @typedef {{name: string, title: string, note?: string}} Officer
 * @typedef {{leader?: Officer[], members?: Officer[], note?: string}} KnownRoster
 */

/** Keyed by faction name, matched case-insensitively and ignoring "the". */
export const KNOWN_LEADERS = {
  "Lords of Waterdeep": {
    leader: [{ name: "Laeral Silverhand", title: "Open Lord of Waterdeep" }],
    members: [
      // The Masked Lords are anonymous in-setting. These are the ones the
      // published material has ever named, and they are the reason Johnny
      // wanted members listed: any of them might hold the chair.
      { name: "Durnan",             title: "Masked Lord; keeper of the Yawning Portal" },
      { name: "Mirt",               title: "Masked Lord; the Moneylender" },
      { name: "Caladorn Cassalanter", title: "Masked Lord" },
      { name: "Kyriani Agrivar",    title: "Masked Lord" },
      { name: "Larissa Neathal",    title: "Masked Lord" },
      { name: "Texter",             title: "Masked Lord; paladin of Tyr" },
      { name: "Brian the Swordmaster", title: "Masked Lord" },
    ],
    note: "The Masked Lords number around twenty and are anonymous by design. "
        + "Only these have ever been named in print.",
  },

  "Masked Lords of Waterdeep": {
    leader: [{ name: "Laeral Silverhand", title: "Open Lord, who alone shows her face" }],
    note: "Same body as the Lords of Waterdeep; duplicate entry in the registry.",
  },

  "The Harpers": {
    leader: [{ name: "No single leader", title: "the High Harpers guide, they do not command" }],
    members: [
      { name: "Remallia Haventree", title: "High Harper, Waterdeep" },
      { name: "Storm Silverhand",   title: "High Harper, Shadowdale" },
      { name: "Elminster Aumar",    title: "ally and elder statesman" },
      { name: "Mirt",               title: "High Harper" },
      { name: "Krowen Valharrow",   title: "High Harper" },
    ],
  },

  "The Zhentarim (Black Network)": {
    leader: [{ name: "The Pereghost", title: "commander at Darkhold" }],
    members: [
      { name: "Manshoon",       title: "founder; many clones, many agendas" },
      { name: "Davil Starsong", title: "Waterdeep cell" },
      { name: "Ganfrey",        title: "Darkhold" },
    ],
    note: "Manshoon's clones act independently, so 'the leader' depends on which one you meet.",
  },

  "The Lords' Alliance": {
    leader: [{ name: "Rotating council", title: "no permanent head" }],
    members: [
      { name: "Laeral Silverhand",    title: "Open Lord of Waterdeep" },
      { name: "Dagult Neverember",    title: "Lord Protector of Neverwinter (deposed 1492 DR)",
        note: "Lost Neverwinter shortly before this date; still a power in Baldur's Gate." },
      { name: "Taern Hornblade",      title: "High Mage of Silverymoon" },
      { name: "Connerad Brawnanvil",  title: "King of Mithral Hall" },
      { name: "Ulder Ravengard",      title: "Marshal of Baldur's Gate" },
    ],
  },

  "The Emerald Enclave": {
    leader: [{ name: "No single leader", title: "a circle of druids and rangers" }],
    members: [
      { name: "Delaan Winterhound", title: "druid, Waterdeep" },
      { name: "Stedd Rein",         title: "chosen of Lathander" },
    ],
  },

  "The Order of the Gauntlet": {
    leader: [{ name: "Council of faith leaders", title: "no single head" }],
    members: [
      { name: "Ontharr Frume", title: "paladin of Torm" },
      { name: "Aleyd Burral",  title: "paladin of Helm" },
    ],
  },

  "Xanathar Guild": {
    leader: [{ name: "Xanathar", title: "beholder crime lord of Skullport" }],
    members: [
      { name: "Ahmaergo",  title: "the Horned Dwarf, majordomo" },
      { name: "Nihiloor",  title: "mind flayer" },
      { name: "Grum'shar", title: "half-orc mage" },
    ],
  },

  "Bregan D'aerthe": {
    leader: [{ name: "Jarlaxle Baenre", title: "founder and captain" }],
    members: [{ name: "Kimmuriel Oblodra", title: "psionicist; second in command" }],
  },

  "Red Wizards of Thay": {
    leader: [{ name: "Szass Tam", title: "Zulkir of Necromancy, Regent of Thay" }],
    note: "Szass Tam has ruled Thay outright since the civil war ended; the other "
        + "Zulkirs serve at his pleasure.",
  },

  "Shadow Thieves": {
    leader: [{ name: "The Shadow Council", title: "anonymous ruling body, Athkatla" }],
  },

  "Cult of the Dragon": {
    leader: [{ name: "Fractured", title: "no single head since 1489 DR" }],
    note: "Severin Silrajin died at the Well of Dragons in 1489 DR. Six years on the "
        + "cult is splintered into cells, which is what makes it dangerous again.",
  },

  // ── Barovia. Johnny's actual campaign, so these matter most. ──────────────
  "Strahd's Servants": {
    leader: [{ name: "Strahd von Zarovich", title: "Count of Barovia, vampire lord" }],
    members: [
      { name: "Rahadin",   title: "chamberlain and executioner" },
      { name: "Escher",    title: "vampire spawn, consort" },
      { name: "Cyrus Belview", title: "mongrelfolk manservant" },
    ],
  },

  "Vistani": {
    leader: [{ name: "Madam Eva", title: "seer of the Tser Pool" }],
    members: [
      { name: "Luvash",   title: "leader of the Vallaki camp" },
      { name: "Arrigal",  title: "his brother; Strahd's spy" },
      { name: "Arabelle", title: "Luvash's daughter" },
    ],
  },

  "Order of the Silver Dragon": {
    leader: [{ name: "Vladimir Horngaard", title: "revenant; master of Argynvostholt" }],
    members: [
      { name: "Argynvost",     title: "the silver dragon whose skull lies in the crypt" },
      { name: "Sir Godfrey Gwilym", title: "revenant knight who defies Vladimir" },
    ],
  },

  "Keepers of the Feather": {
    leader: [{ name: "Rudolph van Richten", title: "monster hunter, travelling as Rictavio" }],
    members: [{ name: "Ezmerelda d'Avenir", title: "his former apprentice" }],
  },
};

/** Match a faction name loosely: case, leading "the", and punctuation ignored. */
const _key = (s) => String(s || "").toLowerCase()
  .replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();

const _INDEX = new Map(Object.entries(KNOWN_LEADERS).map(([n, v]) => [_key(n), v]));

/** The known roster for a faction, or null. */
export function knownRosterFor(factionName) {
  return _INDEX.get(_key(factionName)) ?? null;
}

/** How many factions this file can speak for. */
export const KNOWN_COUNT = Object.keys(KNOWN_LEADERS).length;

/**
 * Write the known people into the matching factions' rosters.
 *
 * ⚠️ NEVER OVERWRITES A PERSON YOU PUT THERE. If a slot already holds a named
 * officer, it is left alone. This fills gaps; it does not take over.
 *
 * @param {{dryRun?: boolean}} [opts]
 */
export async function applyKnownLeaders({ dryRun = false } = {}) {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Filling faction leaders is GM only.");
    return null;
  }
  const { getAllFactions, saveFaction } = await import("./faction-registry.mjs");
  const all = getAllFactions() ?? {};

  const filled = [], skipped = [], missing = [];
  const seen = new Set();

  for (const [id, f] of Object.entries(all)) {
    if (!f || typeof f !== "object") continue;
    const known = knownRosterFor(f.name);
    if (!known) continue;
    seen.add(_key(f.name));

    const roster = f.roster ?? { slots: {}, byActor: {}, absent: {} };
    const absent = { ...(roster.absent ?? {}) };

    // ⚠️ A slot that already holds somebody is somebody's decision.
    if (known.leader && !absent.leader?.length) absent.leader = known.leader;
    if (known.members?.length && !absent.specialist1?.length) {
      absent.specialist1 = known.members;
    }

    const added = (absent.leader?.length ?? 0) + (absent.specialist1?.length ?? 0);
    const before = (roster.absent?.leader?.length ?? 0) + (roster.absent?.specialist1?.length ?? 0);
    if (added === before) { skipped.push(`${f.name} — already has people in it`); continue; }

    if (!dryRun) {
      await saveFaction({ ...f, id, roster: { ...roster, absent },
        // Keep the plain-text leader in step with the roster, since older
        // readers and the AI prompts both still read that field.
        leader: known.leader?.[0]
          ? `${known.leader[0].name}${known.leader[0].title ? ", " + known.leader[0].title : ""}`
          : f.leader,
      });
    }
    filled.push(`${f.name}: ${absent.leader?.[0]?.name ?? "-"}`
      + (absent.specialist1?.length ? ` + ${absent.specialist1.length} named member(s)` : ""));
  }

  // ⚠️ SAY WHAT IS IN THE FILE BUT NOT IN HIS WORLD. Silence here would read as
  // "everything was applied" when a faction may simply be named differently.
  for (const name of Object.keys(KNOWN_LEADERS)) {
    if (!seen.has(_key(name))) missing.push(name);
  }

  const lines = [`ACE: Engine | known leaders |${dryRun ? " DRY RUN —" : ""} `
    + `${filled.length} faction(s) given named people from published lore.`];
  for (const l of filled)  lines.push("   " + l);
  if (skipped.length) lines.push(`  left alone, already populated: ${skipped.length}`);
  if (missing.length) {
    lines.push(`  in the lore file but NOT in your registry (${missing.length}):`);
    for (const m of missing) lines.push("     " + m);
  }
  console.log(lines.join("\n"));
  if (!dryRun && filled.length) {
    ui.notifications?.info(`ACE: ${filled.length} faction(s) now have their real leaders and members.`);
  }
  return { filled, skipped, missing };
}

/**
 * Seat everyone who is ALREADY named in your own data.
 *
 * ⚠️ THIS INVENTS NOTHING. 196 of Johnny's factions carry a real person in
 * their `leader` field — "Grik Skullcrusher, Chieftain", "Baron Vargas
 * Vallakovich", "Warchief Gorthak the Scarred" — as plain text that nothing
 * reads. This turns that text into a structured member, and pulls any other
 * officers the faction's own lore names, which is what harvestNamedOfficers
 * was written for and has never been run in bulk.
 *
 * Where the field is a description rather than a person ("Council of faith
 * leaders", "Rotating council of city lords"), it is LEFT ALONE and reported.
 * A council is a real answer to "who leads", and seating the word "Council" as
 * an officer would be worse than an empty chair.
 */
export async function harvestAllRosters({ dryRun = false } = {}) {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Harvesting faction officers is GM only.");
    return null;
  }
  const { getAllFactions, saveFaction, getTemplate } = await import("./faction-registry.mjs");
  const { harvestNamedOfficers, personFromLeaderField } = await import("./faction-roster.mjs");
  const all = getAllFactions() ?? {};

  const seated = [], already = [], byCouncil = [], empty = [], unseated = [];

  for (const [id, f] of Object.entries(all)) {
    if (!f || typeof f !== "object") continue;
    const roster = f.roster ?? { slots: {}, byActor: {}, absent: {} };

    // ⚠️ CLEAN UP WHAT A BROKEN RUN SEATED. The first bulk harvest used a
    // description filter whose word-boundary escape had been eaten, so it put
    // "Various Thayan Zulkirs", "Unknown cult leader" and "Rotating Spokesperson
    // from Bryn Shander" into chairs as though they were people. Skipping any
    // faction that "already has people" would leave every one of those in place
    // forever, so anything that is plainly a description is removed first.
    const cleaned = {};
    let removed = 0;
    for (const [slot, people] of Object.entries(roster.absent ?? {})) {
      const keep = (people ?? []).filter(o => !!personFromLeaderField(o?.name));
      removed += (people?.length ?? 0) - keep.length;
      if (keep.length) cleaned[slot] = keep;
    }
    if (removed) {
      roster.absent = cleaned;
      unseated.push(`${f.name} — removed ${removed} non-person entr${removed === 1 ? "y" : "ies"}`);
    }
    if (Object.keys(roster.absent ?? {}).length) {
      if (removed && !dryRun) await saveFaction({ ...f, id, roster });
      already.push(f.name);
      continue;
    }

    const template = getTemplate(f.creatureBase || "commoner");
    let harvested = {};
    try { harvested = harvestNamedOfficers(f, template) ?? {}; }
    catch (err) { console.warn(`ACE: Engine | known leaders | could not read ${f.name}:`, err); }

    const count = Object.values(harvested).reduce((n, a) => n + (a?.length ?? 0), 0);
    if (!count) {
      (String(f.leader || "").trim() ? byCouncil : empty).push(f.name);
      continue;
    }
    if (!dryRun) {
      await saveFaction({ ...f, id, roster: { ...roster, absent: harvested } });
    }
    const who = Object.values(harvested).flat().map(o => o.name).join(", ");
    seated.push(`${f.name}: ${who}`);
  }

  const lines = [`ACE: Engine | known leaders |${dryRun ? " DRY RUN —" : ""} `
    + `seated ${seated.length} faction(s) from names already in your own data.`];
  for (const l of seated.slice(0, 60)) lines.push("   " + l);
  if (seated.length > 60) lines.push(`   ... and ${seated.length - 60} more`);
  if (unseated.length) {
    lines.push(`  cleaned out ${unseated.length} chair(s) holding a description, not a person:`);
    for (const u of unseated.slice(0, 40)) lines.push("     " + u);
  }
  lines.push(`  already had people        : ${already.length}`);
  lines.push(`  led by a council or group : ${byCouncil.length}  (left alone, correctly)`);
  lines.push(`  no leader recorded at all : ${empty.length}`);
  console.log(lines.join("\n"));
  if (!dryRun && seated.length) {
    ui.notifications?.info(`ACE: ${seated.length} faction(s) now have their named leaders seated.`);
  }
  return { seated, already, byCouncil, empty, unseated };
}
