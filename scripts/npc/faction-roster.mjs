// ─── ACE: Engine — Faction Roster: who is the chief, and who is a mook ──────
//
// Johnny, 2026-08-07: "not just the faction, but its role in the faction…
// there's going to be a lot more mooks than chiefs, if you know what I mean?
// … the AI has to be smart enough to know, okay, this faction already has a
// chief. These guys are mooks or warriors, and this guy is a goblin rogue."
//
// THE CORE PRINCIPLE: RANK IS READ, NOT ROLLED.
//
// D&D already solved this. The Monster Manual builds hierarchy into statblock
// NAMES — Goblin Boss is the chieftain, Bandit Captain is the captain, Gnoll
// Pack Lord, Orc War Chief, Hobgoblin Warlord, Drow Priestess of Lolth, Cult
// Fanatic against Cultist. That is RAW and it is already sitting in the
// compendium, so almost nothing has to be guessed.
//
// Six rungs, checked in order, first answer wins:
//   1. The GM's explicit choice (the identity popup) — final, never overridden.
//   2. The statblock name.
//   3. Class levels, challenge rating, legendary/lair actions.
//   4. Equipment — a signet ring, a chieftain's totem, a magic weapon, ten
//      times the coin of its neighbours. This is the Eye of Vecna rule applied
//      at group level: gear promotes you regardless of your statblock.
//   5. Token signals — a name the GM typed, a token scaled larger.
//   6. Only now does anything roll, weighted hard toward the rank-and-file.
//
// AND THE ROSTER IS WHAT STOPS THE CONTRADICTION. Slots carry capacity and
// occupancy; a creature cannot claim a slot that is already filled, so four
// goblins produce one patrol leader and three warriors instead of four chiefs.
//
// ⚠️ PRESENT ≠ IN CHARGE. Four goblins in a room does not mean the chieftain
// is in the room. The warband's leadership exists in the world whether or not
// it is standing here; the senior creature PRESENT gets "leads this patrol",
// which is a different thing from being the chieftain and gives the party a
// lead to follow instead of a dead end.

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | Roster";

// ── Rank vocabulary, read off statblock names ────────────────────────────────
// Ordered longest-phrase-first within each tier so "high priest" beats "priest"
// and "pack lord" beats "lord".
const LEADER_WORDS = [
    "high priest", "pack lord", "war chief", "warchief", "eye of", "fang of",
    "chieftain", "chieftess", "warlord", "overlord", "matriarch", "patriarch",
    "commander", "priestess", "princess", "captain", "general", "headman",
    "matron", "marshal", "admiral", "monarch", "emperor", "empress",
    "boss", "chief", "lord", "lady", "king", "queen", "prince", "baron",
    "duke", "elder", "alpha", "master", "mistress", "archmage", "archdruid",
];

const SPECIALIST_WORDS = [
    "standard bearer", "trapmaster", "lieutenant", "berserker", "enforcer",
    "bodyguard", "champion", "sergeant", "assassin", "initiate", "apprentice",
    "acolyte", "fanatic", "veteran", "shaman", "priest", "hexer", "witch",
    "oracle", "herald", "drummer", "tracker", "warlock", "wizard", "sorcerer",
    "sorceress", "druid", "adept", "scout", "archer", "spy", "seer", "mage",
    "bully", "zealot", "knight", "blade", "runner",
];

// Items that mean authority no matter what the statblock says.
const INSIGNIA_WORDS = [
    "signet", "crown", "circlet", "coronet", "totem", "banner", "standard",
    "seal", "insignia", "scepter", "sceptre", "orb of office", "chain of office",
    "war horn", "warhorn", "horn of", "badge", "medallion of", "regalia",
];

const RARITY_WEIGHT = { common: 0, uncommon: 1, rare: 2, veryrare: 3, legendary: 4, artifact: 5 };

/** Rungs, lowest to highest. */
export const RUNGS = ["pool", "specialist", "leader"];
const _rungIndex = (r) => Math.max(0, RUNGS.indexOf(r));

/**
 * Turn a structure string into slots with capacity.
 *
 * The registry writes every structure leader-first, specialists in the middle,
 * rank-and-file last — "chieftain + shaman + warriors", "captain + sergeants +
 * guards", "alpha + pack members". Position gives the rung, so capacities do
 * not have to be hand-authored for forty entries.
 *
 * @param {string} structure  e.g. "chieftain + shaman + warriors"
 * @param {number} groupSize  how many of this creature are on the scene
 */
export function parseStructure(structure, groupSize = 1) {
    const parts = String(structure || "")
        .split("+").map(p => p.trim()).filter(Boolean);

    if (!parts.length) {
        return [{ key: "pool", label: "member", rung: "pool", capacity: Infinity }];
    }
    if (parts.length === 1) {
        return [{ key: "pool", label: parts[0], rung: "pool", capacity: Infinity }];
    }

    const slots = [];
    // First named rung is always singular. A warband has one chieftain.
    slots.push({ key: "leader", label: parts[0], rung: "leader", capacity: 1 });

    // Middle rungs: roughly one specialist per four bodies, minimum one.
    const specialistCap = Math.max(1, Math.floor(Math.max(1, groupSize) / 4));
    for (let i = 1; i < parts.length - 1; i++) {
        slots.push({
            key: `specialist${i}`, label: parts[i], rung: "specialist",
            capacity: specialistCap,
        });
    }

    // Last rung is the unlimited pool.
    slots.push({ key: "pool", label: parts[parts.length - 1], rung: "pool", capacity: Infinity });
    return slots;
}

/** Does this name contain any of these rank words, as whole words? */
function _matchWord(name, words) {
    const n = ` ${String(name || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
    for (const w of words) {
        // `n` is padded with a space at both ends, so this one test already
        // covers a rank word that starts or ends the name.
        if (n.includes(` ${w} `)) return w;
    }
    return null;
}

// ── Rung 2: the statblock name ───────────────────────────────────────────────
export function rankFromStatblock(name) {
    const leader = _matchWord(name, LEADER_WORDS);
    if (leader) return { rung: "leader", evidence: `the statblock says "${leader}"` };
    const spec = _matchWord(name, SPECIALIST_WORDS);
    if (spec) return { rung: "specialist", evidence: `the statblock says "${spec}"` };
    return { rung: "pool", evidence: null };
}

// ── Rung 3: levels, CR, legendary actions ────────────────────────────────────
function _rankFromPower(actor, groupCRs = []) {
    const out = { rung: "pool", evidence: null };
    try {
        // Legendary or lair actions mean this creature RUNS something.
        const legendary = actor.system?.resources?.legact?.max
            ?? actor.system?.resources?.legres?.max ?? 0;
        const lair = actor.system?.resources?.lair?.value ?? actor.system?.resources?.lair?.initiative;
        if (legendary > 0 || lair) {
            return { rung: "leader", evidence: "has legendary or lair actions" };
        }

        // Class levels: a leveled NPC outranks a plain statblock of its kind.
        const levels = (actor.items ?? []).filter?.(i => i.type === "class")
            ?.reduce((n, i) => n + (i.system?.levels ?? 0), 0) ?? 0;
        if (levels >= 10) return { rung: "leader", evidence: `${levels} class levels` };
        if (levels >= 5) return { rung: "specialist", evidence: `${levels} class levels` };

        // Challenge rating well above its companions.
        const cr = Number(actor.system?.details?.cr ?? 0);
        if (cr > 0 && groupCRs.length > 1) {
            const others = groupCRs.filter(c => Number.isFinite(c));
            const median = others.slice().sort((a, b) => a - b)[Math.floor(others.length / 2)] ?? cr;
            if (median > 0 && cr >= median * 2) {
                return { rung: "specialist", evidence: `CR ${cr}, double the group's typical ${median}` };
            }
        }
    } catch (err) {
        console.warn(`${TAG} | Could not read power level:`, err);
    }
    return out;
}

// ── Rung 4: equipment — the Eye of Vecna rule at group level ─────────────────
function _rankFromGear(actor) {
    try {
        const items = actor.items?.contents ?? actor.items ?? [];
        let best = 0;
        let bestItem = "";
        let insignia = null;

        for (const it of items) {
            const nm = it.name || "";
            if (!insignia) {
                const hit = INSIGNIA_WORDS.find(w => nm.toLowerCase().includes(w));
                if (hit) insignia = nm;
            }
            const rarity = String(it.system?.rarity || "").toLowerCase().replace(/[^a-z]/g, "");
            const w = RARITY_WEIGHT[rarity] ?? 0;
            if (w > best) { best = w; bestItem = nm; }
        }

        // A mark of office outranks everything — that IS the chief's totem.
        if (insignia) return { rung: "leader", evidence: `carries a mark of office (${insignia})` };
        if (best >= 4) return { rung: "leader", evidence: `carries ${bestItem}, which is legendary-grade` };
        if (best >= 2) return { rung: "specialist", evidence: `carries ${bestItem}` };
    } catch (err) {
        console.warn(`${TAG} | Could not read equipment:`, err);
    }
    return { rung: "pool", evidence: null };
}

// ── Rung 5: what the GM did to this token by hand ────────────────────────────
function _rankFromTokenSignals(actor, tokenDoc, speciesLabel) {
    try {
        const tokenName = String(tokenDoc?.name || "").trim();
        const label = String(speciesLabel || "").trim().toLowerCase();
        const bare = tokenName.toLowerCase().replace(/\s*[#(]?\s*\d+\s*\)?$/, "").trim();
        // A name the GM typed himself — not "Goblin", not "Goblin 3".
        if (bare && label && bare !== label && !bare.startsWith(label)) {
            return { rung: "specialist", evidence: `the GM named this token "${tokenName}"` };
        }
        // Scaled up on purpose.
        const scale = Number(tokenDoc?.texture?.scaleX ?? 1);
        if (scale >= 1.25) return { rung: "specialist", evidence: `the token is scaled ${scale}×` };
    } catch (_) { /* signals are a bonus, never a blocker */ }
    return { rung: "pool", evidence: null };
}

// ── The roster lives on the faction ──────────────────────────────────────────

/** @returns {{slots:object, byActor:object}} */
export function getRoster(faction) {
    const r = faction?.roster;
    return {
        slots:   (r && typeof r.slots   === "object") ? r.slots   : {},
        byActor: (r && typeof r.byActor === "object") ? r.byActor : {},
        // Officers the world already speaks of who are not standing here:
        // Grik Skullcrusher from the leader field, Zizka the Wise from the lore.
        // { slotKey: [{ name, title }] }
        absent:  (r && typeof r.absent  === "object") ? r.absent  : {},
    };
}

/** Named officers recorded for a post but not present as a token. */
function _absentIn(roster, slotKey) {
    const a = roster.absent?.[slotKey];
    return Array.isArray(a) ? a : [];
}

/**
 * How many hold this post — live creatures AND named officers the world already
 * knows about.
 *
 * ⚠️ Counting the absent ones is the whole point (2026-08-07). Johnny: "if I
 * later drop an actual goblin shaman, the roster will hand it the shaman slot
 * and the AI could name it something other than Zizka." Zizka occupies that
 * post the moment the tribe's lore says he does, whether or not he has a token.
 */
function _occupancy(roster, slotKey) {
    const held = roster.slots[slotKey];
    // A creature whose actor no longer exists has vacated its post — which is
    // also how a dead chieftain's slot opens up for the next in line.
    const live = Array.isArray(held) ? held.filter(id => !!game.actors?.get(id)).length : 0;
    return live + _absentIn(roster, slotKey).length;
}

/** Live token-holders only — used to tell "vacant" from "held by someone absent". */
function _liveOccupancy(roster, slotKey) {
    const held = roster.slots[slotKey];
    return Array.isArray(held) ? held.filter(id => !!game.actors?.get(id)).length : 0;
}

// ── Reading officers out of prose ───────────────────────────────────────────
// A faction records its leader in a field, but every other officer lives in the
// lore text: "Their shaman, Zizka the Wise, communes with the spirits." Nothing
// structured knew about Zizka, so the shaman post read as vacant.

/** "Grik Skullcrusher, Chieftain" → { name: "Grik Skullcrusher", title: "Chieftain" } */
function _splitLeader(leader) {
    const raw = String(leader || "").trim();
    if (!raw) return null;
    // "Name, Title" | "Title Name" | plain "Name"
    const comma = raw.split(/\s*,\s*/);
    if (comma.length > 1) return { name: comma[0].trim(), title: comma.slice(1).join(", ").trim() };
    return { name: raw, title: "" };
}

/**
 * Find officers named in a faction's own text and map them to roster posts.
 *
 * Deliberately conservative: it only accepts a capitalised name sitting right
 * after a post's own label, so ordinary prose does not manufacture officers.
 *
 * @returns {Object<string, Array<{name:string,title:string}>>} keyed by slotKey
 */
export function harvestNamedOfficers(faction, template) {
    const out = {};
    if (!faction) return out;
    const slots = parseStructure(template?.structure);

    // 1. The leader field is structured — take it at face value.
    const lead = _splitLeader(faction.leader);
    if (lead?.name && /[A-Z]/.test(lead.name)) {
        const leaderSlot = slots.find(sl => sl.rung === "leader") ?? slots[0];
        if (leaderSlot) out[leaderSlot.key] = [{ name: lead.name, title: lead.title || leaderSlot.label }];
    }

    // 2. Every other post: look for its label followed by a proper name.
    const prose = [faction.lore, faction.purpose, faction.description].filter(Boolean).join(" ");
    if (prose) {
        for (const slot of slots) {
            if (out[slot.key]) continue;                       // leader already filled
            if (slot.rung === "pool") continue;                // nobody "is" the rank and file
            const label = String(slot.label || "").trim();
            if (label.length < 3) continue;

            // "shaman, Zizka the Wise" / "shaman Zizka the Wise" / "shaman: Zizka"
            //
            // ⚠️ NO "i" FLAG, DELIBERATELY. The capital letters in the name half
            // are the only thing separating a proper name from ordinary prose. With
            // case-insensitivity, "shaman communes with the spirits" happily yields
            // "communes" as an officer of the tribe.
            //
            // The LABEL still has to match either case, so each of its letters gets
            // its own two-case class instead of leaning on the flag.
            const labelPattern = label
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                .replace(/[a-zA-Z]/g, c => `[${c.toLowerCase()}${c.toUpperCase()}]`);
            // \u2019 is written escaped so this file stays plain ASCII.
            const NAME_CHAR = "[\\w'\\u2019-]";
            const re = new RegExp(
                labelPattern +
                `\\s*[,:]?\\s+([A-Z]${NAME_CHAR}+(?:\\s+(?:the\\s+)?[A-Z]${NAME_CHAR}+){0,3})`);
            const m = re.exec(prose);
            if (m?.[1]) {
                const name = m[1].trim();
                // Never mistake the faction's own name for a person.
                if (normalizeName(name) === normalizeName(faction.name)) continue;
                out[slot.key] = [{ name, title: label }];
            }
        }
    }
    return out;
}

const normalizeName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Read the officers out of a faction's text once and persist them on its roster.
 * Idempotent — a post that already has an occupant, live or absent, is skipped.
 */
export async function ensureOfficersHarvested(factionId, template) {
    if (!game.user?.isGM || !factionId) return false;
    try {
        const { getFaction, saveFaction } = await import("./faction-registry.mjs");
        const faction = getFaction(factionId);
        if (!faction) return false;

        const roster = getRoster(faction);
        const found = harvestNamedOfficers(faction, template);

        const absentOut = { ...roster.absent };
        let added = 0;
        for (const [slotKey, people] of Object.entries(found)) {
            if (_liveOccupancy(roster, slotKey) > 0) continue;      // a real creature holds it
            if (_absentIn(roster, slotKey).length) continue;        // already recorded
            absentOut[slotKey] = people;
            added += people.length;
        }
        if (!added) return false;

        await saveFaction({
            ...faction, id: factionId,
            roster: { slots: roster.slots, byActor: roster.byActor, absent: absentOut },
            lastActive: Date.now(),
        });
        const who = Object.values(absentOut).flat().map(p => `${p.name} (${p.title})`).join(", ");
        console.log(`${TAG} | "${faction.name}" already speaks of ${added} officer(s): ${who}. ` +
            `Their posts are now held, so nobody else can claim them — and a creature that turns up for one of those posts BECOMES that person.`);
        return true;
    } catch (err) {
        console.warn(`${TAG} | Could not read named officers out of the faction text:`, err);
        return false;
    }
}

/**
 * Decide this creature's role inside its faction.
 *
 * @param {object}        args
 * @param {Actor}         args.actor
 * @param {TokenDocument} args.tokenDoc
 * @param {object}        args.faction        the faction it belongs to
 * @param {object}        args.template       FACTION_TEMPLATES entry (structure, type)
 * @param {string}        args.speciesLabel   e.g. "goblin"
 * @param {Actor[]}       [args.groupActors]  same-faction creatures on this scene
 * @returns {{slotKey:string, roleLabel:string, rung:string, reasons:string[],
 *            rolled:boolean, leaderPresent:boolean, leadsDetachment:boolean}}
 */
export function decideRole({ actor, tokenDoc, faction, template, speciesLabel = "", groupActors = [] }) {
    const reasons = [];
    const groupSize = Math.max(1, groupActors.length || 1);
    const slots = parseStructure(template?.structure, groupSize);
    const roster = getRoster(faction);

    // ── Rung 1: the GM's explicit choice is final ────────────────────────
    const gmRole = actor?.getFlag?.(MODULE_ID, "factionRole");
    if (gmRole) {
        const match = slots.find(s => s.label.toLowerCase() === String(gmRole).toLowerCase());
        return {
            slotKey: match?.key ?? "pool",
            roleLabel: gmRole,
            rung: match?.rung ?? "pool",
            reasons: ["you chose this role yourself"],
            rolled: false,
            leaderPresent: _occupancy(roster, "leader") > 0,
            leadsDetachment: false,
        };
    }

    // ── Rungs 2–5: read the evidence, keep the highest ───────────────────
    const groupCRs = groupActors.map(a => Number(a?.system?.details?.cr ?? 0)).filter(Number.isFinite);
    const evidence = [
        rankFromStatblock(actor?.name),
        rankFromStatblock(tokenDoc?.name),
        _rankFromPower(actor, groupCRs),
        _rankFromGear(actor),
        _rankFromTokenSignals(actor, tokenDoc, speciesLabel),
    ];

    let claimed = "pool";
    let rolled = true;
    for (const e of evidence) {
        if (!e?.evidence) continue;
        // The actor name and the token name are usually identical, so the same
        // reason arrived twice and the log read `the statblock says "shaman";
        // the statblock says "shaman"`. Same evidence stated once.
        if (!reasons.includes(e.evidence)) reasons.push(e.evidence);
        if (_rungIndex(e.rung) > _rungIndex(claimed)) claimed = e.rung;
        rolled = false;
    }

    // ── Rung 6: nothing said anything. Roll, weighted hard toward mooks ──
    if (rolled) {
        const r = Math.random();
        if (r < 0.10) { claimed = "specialist"; reasons.push("nothing marked this one out; it drew a specialist post"); }
        else          { claimed = "pool";       reasons.push("nothing marked this one out — rank and file"); }
    }

    // ── Occupancy: you cannot take a post that is already held ───────────
    //
    // …with one deliberate exception. A post held only by an ABSENT officer —
    // Zizka the Wise, named in the tribe's lore but with no token — is not
    // vacant, but it is not occupied either. A creature that turns up qualified
    // for that post does not get turned away and it does not invent a rival:
    // it IS that person. Drop a Goblin Shaman into the Amberfang Tribe and he
    // is Zizka, because the tribe has been talking about Zizka all along.
    let slot = null;
    let becomesOfficer = null;
    for (let i = _rungIndex(claimed); i >= 0; i--) {
        const rung = RUNGS[i];
        const candidates = slots.filter(s => s.rung === rung);

        // A genuinely free post — nobody live, nobody named.
        const free = candidates.find(s => _occupancy(roster, s.key) < s.capacity);
        if (free) { slot = free; break; }

        // A post whose only claimant is someone the world merely speaks of.
        const inherit = candidates.find(s =>
            _liveOccupancy(roster, s.key) < s.capacity && _absentIn(roster, s.key).length);
        if (inherit) {
            slot = inherit;
            becomesOfficer = _absentIn(roster, inherit.key)[0] ?? null;
            if (becomesOfficer) {
                reasons.push(`this tribe already speaks of ${becomesOfficer.name} as its ${inherit.label} — this creature is that person`);
            }
            break;
        }

        if (candidates.length) {
            reasons.push(`the ${candidates[0].label} post is already filled`);
        }
    }
    if (!slot) slot = slots[slots.length - 1];   // the pool is unlimited

    // ── Present ≠ in charge ──────────────────────────────────────────────
    // ⚠️ _liveOccupancy, NOT _occupancy (2026-08-07). _occupancy deliberately
    // counts officers the faction merely SPEAKS of, which is right for deciding
    // whether a post is claimable — and exactly wrong here. "Is the chieftain
    // standing in this room?" is a question about bodies. Counting Grik as
    // present because the lore names him is what killed the whole
    // present-is-not-in-charge behaviour: a plain goblin stopped being told its
    // chief was elsewhere, which is the lead the party is supposed to get.
    const leaderPresent = _liveOccupancy(roster, "leader") > 0 || slot.key === "leader";
    const leadsDetachment = !leaderPresent && slot.rung === "specialist";
    if (leadsDetachment) {
        reasons.push(`${faction?.leader || "the leader"} is not here, so this one runs the group present`);
    }

    return {
        slotKey: slot.key,
        roleLabel: slot.label,
        rung: slot.rung,
        reasons,
        rolled,
        leaderPresent,
        leadsDetachment,
        // Set when this creature steps into the shoes of an officer the faction
        // already names. The bio prompt uses it to say "you ARE Zizka" instead
        // of letting a second shaman get invented.
        becomesOfficer,
    };
}

/**
 * Write a creature into the roster and persist it on the faction.
 * Only a GM may write world data; a player client silently no-ops, which is
 * correct — the GM's client is authoritative for the roster.
 */
export async function claimRosterSlot(factionId, slotKey, actorId, roleLabel, officer = null) {
    if (!game.user?.isGM || !factionId || !actorId) return false;
    try {
        const { getFaction, saveFaction } = await import("./faction-registry.mjs");
        const faction = getFaction(factionId);
        if (!faction) return false;

        const roster = getRoster(faction);
        const held = Array.isArray(roster.slots[slotKey]) ? [...roster.slots[slotKey]] : [];
        if (!held.includes(actorId)) held.push(actorId);

        const slotsOut = { ...roster.slots, [slotKey]: held };
        const byActorOut = {
            ...roster.byActor,
            [actorId]: { slotKey, roleLabel, at: Date.now(), ...(officer ? { officerName: officer.name } : {}) },
        };

        // ⚠️ RETIRE THE PLACEHOLDER when a real creature steps into the post.
        // Leaving it would double-count the occupancy — the post would read as
        // held by two, and a genuinely qualified creature arriving later would
        // be pushed down to the rank and file for no reason.
        const absentOut = { ...roster.absent };
        if (officer && Array.isArray(absentOut[slotKey])) {
            const rest = absentOut[slotKey].filter(p => p.name !== officer.name);
            if (rest.length) absentOut[slotKey] = rest;
            else delete absentOut[slotKey];
        }

        await saveFaction({ ...faction, id: factionId, roster: { slots: slotsOut, byActor: byActorOut, absent: absentOut }, lastActive: Date.now() });
        console.log(`${TAG} | ${roleLabel} of "${faction.name}" is now held by ${game.actors?.get(actorId)?.name ?? actorId}.`);
        return true;
    } catch (err) {
        console.warn(`${TAG} | Could not record the roster slot:`, err);
        return false;
    }
}

/**
 * Recall the role already recorded for this creature.
 *
 * ⚠️ READS, never re-decides. decideRole can roll dice at its last rung, so
 * calling it a second time to "find out" what a creature is could hand back a
 * different answer than the one written into the roster — the exact class of
 * bug that makes two goblins name two different chieftains. The verdict is
 * decided once, at faction assignment, and every later consumer reads it.
 *
 * @returns {{slotKey:string, roleLabel:string, rung:string,
 *            leaderPresent:boolean, leadsDetachment:boolean}|null}
 */
export function getRoleForActor(faction, actorId, template, groupSize = 1) {
    if (!faction || !actorId) return null;
    const roster = getRoster(faction);
    const entry = roster.byActor?.[actorId];
    if (!entry) return null;

    const slots = parseStructure(template?.structure, groupSize);
    const slot = slots.find(s => s.key === entry.slotKey) ?? slots[slots.length - 1];

    const leaderHeldBy = Array.isArray(roster.slots?.leader) ? roster.slots.leader : [];
    const leaderPresent = leaderHeldBy.some(id => !!game.actors?.get(id));

    return {
        slotKey: entry.slotKey,
        roleLabel: entry.roleLabel || slot.label,
        rung: slot.rung,
        officerName: entry.officerName ?? null,
        leaderPresent,
        // The senior creature present runs the group here when the real leader
        // is not — which is not the same as leading the whole warband.
        leadsDetachment: !leaderPresent && slot.rung === "specialist",
    };
}

/**
 * A plain-English description of the group for injection into the bio prompt.
 * This is the "one shared record, quoted by all" — every member reads the SAME
 * text rather than guessing from the first sentence of a sibling's biography,
 * which is how four goblins used to end up naming three different chieftains.
 */
export function buildRosterContext(faction, template, myRole, groupSize = 1) {
    if (!faction) return "";
    const roster = getRoster(faction);
    const slots = parseStructure(template?.structure, groupSize);

    const lines = [];
    lines.push(`\n\nTHE GROUP THIS CREATURE BELONGS TO — these facts are FIXED. Quote them; never contradict or reinvent them:`);
    lines.push(`  • Name: ${faction.name}`);
    if (faction.type) lines.push(`  • Kind: ${faction.type}`);
    if (faction.leader) lines.push(`  • Led by: ${faction.leader}`);
    if (faction.headquarters) lines.push(`  • Based at: ${faction.headquarters}`);
    if (faction.purpose) lines.push(`  • Why they are here: ${faction.purpose}`);
    if (faction.lore) lines.push(`  • Shared history every member knows: ${faction.lore}`);

    const filled = slots
        .map(s => {
            const live = (roster.slots[s.key] || [])
                .map(id => game.actors?.get(id)?.name).filter(Boolean).slice(0, 4);
            // Officers the faction speaks of but who are not standing here.
            // Naming them is what stops a second shaman being invented.
            const away = _absentIn(roster, s.key).map(p => `${p.name} (not present)`);
            const all = [...live, ...away];
            if (!all.length) return null;
            return `  • ${s.label}: ${all.join(", ")}`;
        })
        .filter(Boolean);
    if (filled.length) {
        lines.push(`Posts already held — these people EXIST and are NOT this creature. ` +
            `Do not claim their posts and do not reuse their names:\n${filled.join("\n")}`);
    }

    if (myRole) {
        lines.push(`\nTHIS CREATURE'S PLACE IN IT: ${myRole.roleLabel}.`);

        // It stepped into the shoes of somebody the faction already names.
        if (myRole.becomesOfficer?.name || myRole.officerName) {
            const who = myRole.becomesOfficer?.name || myRole.officerName;
            lines.push(`⚠️ THIS CREATURE **IS** ${who}, the ${myRole.roleLabel} this group has always spoken of. ` +
                `That is its NAME — use it exactly and do NOT invent a different one. ` +
                `Everything the group's history already says about ${who} is this creature's own past.`);
        }
        if (myRole.rung === "pool") {
            lines.push(`It is rank and file. It does NOT lead, does not speak for the group, and knows only what someone at its level would know. Its personality, grievances and loyalties are its own — those are where it differs from its fellows, not its rank.`);
        }
        if (myRole.leadsDetachment) {
            lines.push(`⚠️ ${faction.leader || "The leader"} is NOT present. This creature is the senior one here and runs the group standing in this place — which is NOT the same as leading the whole ${faction.type || "group"}. It answers to ${faction.leader || "its leader"}, who is elsewhere.`);
        } else if (!myRole.leaderPresent && myRole.rung === "pool") {
            lines.push(`⚠️ ${faction.leader || "The leader"} is NOT present here. If asked, this creature can say where they are.`);
        }
    }

    return lines.join("\n");
}
