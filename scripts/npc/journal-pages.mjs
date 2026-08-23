// ─── ACE Engine — journals that read like a campaign, not a log file ────────
//
// ⚠️ WHAT WAS ACTUALLY WRONG. Johnny suspected the storage format. It is not
// the format, it is that none of it was ever used. Across all 578 journals:
//
//     cross-links between journals ......... 0
//     portraits or any image ............... 0
//     more than one page ................... 69 of 578
//     ownership control .................... 0
//
// Foundry hands you a linked, multi-page, permission-controlled document and
// ACE was writing a flat stat dump into a single page called "Memory". It read
// like a log file because it was one.
//
// So a person now gets four pages that match how a GM actually uses somebody at
// the table, and every name inside them is a click through to that person, that
// faction or that place. That last part is the whole difference between 578
// loose pages and a campaign you can walk.
//
// ⚠️ JOURNALS, NOT A CUSTOM PANEL, AND THE REASON MATTERS. This is a product
// people will pay for. If ACE is uninstalled, breaks on a Foundry update, or
// they stop subscribing, journals are still sitting there: readable, searchable,
// exportable, forever. A bespoke ACE browser dies with the module and takes
// five years of somebody's campaign with it.

import { baseName, speciesOf, classLineOf, backgroundOf } from "./journal-identity.mjs";

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | journal pages";

export const PERSON_PAGES = ["Who They Are", "What They Want", "Between Us", "Where They Stand"];
export const BESTIARY_PAGES = ["The Tally", "What We Know"];

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const dateOf = (t) => {
  if (!t) return "";
  const ms = Number(t) > 1e11 ? Number(t) : Number(t) * 1000;
  const d = new Date(ms);
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
};

// ── Cross-linking ───────────────────────────────────────────────────────────
//
// ⚠️ NEVER LINK INSIDE MARKUP. A naive replace across raw HTML rewrites the
// inside of tags and the inside of links already placed, and produces a page
// that renders as garbled text with visible bracket syntax. Text is linked only
// between tags, and only on whole words.

/**
 * Build the name-to-document map used for linking.
 * @returns {Map<string,string>} lower-cased name -> uuid
 */
export function buildLinkIndex() {
  const index = new Map();
  const add = (name, uuid) => {
    const clean = baseName(name);
    // Two-letter names and bare numbers would match everywhere.
    if (!clean || clean.length < 4 || !uuid) return;
    const key = clean.toLowerCase();
    if (!index.has(key)) index.set(key, uuid);
  };
  for (const j of (game.journal ?? [])) add(j.name, j.uuid);
  for (const a of (game.actors ?? [])) add(a.name, a.uuid);
  for (const s of (game.scenes ?? [])) add(s.name, s.uuid);
  return index;
}

/**
 * Turn every known name in a fragment of HTML into a link.
 * @param {string} html
 * @param {Map<string,string>} index
 * @param {string} [selfName] never link a document to itself
 */
export function linkify(html, index, selfName = "") {
  if (!html || !index?.size) return html;
  const self = baseName(selfName).toLowerCase();

  // Longest first, so "Kasimir Velikov" wins over "Kasimir".
  const names = [...index.keys()]
    .filter(n => n !== self)
    .sort((a, b) => b.length - a.length);
  if (!names.length) return html;

  const pattern = new RegExp(
    "\\b(" + names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
    "gi");

  // Walk the string, leaving anything inside a tag untouched.
  let out = "";
  let cursor = 0;
  const tagOrLink = /<[^>]*>|@UUID\[[^\]]*\](?:\{[^}]*\})?/g;
  let m;
  while ((m = tagOrLink.exec(html)) !== null) {
    out += _linkText(html.slice(cursor, m.index), pattern, index);
    out += m[0];
    cursor = m.index + m[0].length;
  }
  out += _linkText(html.slice(cursor), pattern, index);
  return out;
}

function _linkText(text, pattern, index) {
  if (!text) return text;
  return text.replace(pattern, (match) => {
    const uuid = index.get(match.toLowerCase());
    return uuid ? `@UUID[${uuid}]{${match}}` : match;
  });
}

// ── A person ────────────────────────────────────────────────────────────────

/**
 * The four pages of somebody's dossier.
 * @returns {{name:string, html:string}[]}
 */
export function buildPersonPages(rec, { actor = null, faction = null, standing = null } = {}) {
  const name = baseName(rec?.displayName ?? actor?.name ?? "Unknown");
  return [
    { name: "Who They Are",     html: _whoTheyAre(rec, actor, name) },
    { name: "What They Want",   html: _whatTheyWant(rec, actor) },
    { name: "Between Us",       html: _betweenUs(rec, name) },
    { name: "Where They Stand", html: _whereTheyStand(rec, actor, faction, standing) },
  ];
}

/**
 * The paragraph you read aloud when the party walks in.
 *
 * ⚠️ NOTHING IS INVENTED HERE. Where no description exists the page says so
 * plainly and names what will fill it. A journal that quietly makes somebody up
 * is worse than an empty one, because it cannot be told from a remembered fact.
 */
function _whoTheyAre(rec, actor, name) {
  const bits = [];
  const portrait = actor?.img && !/mystery-man|blank|default/i.test(actor.img) ? actor.img : null;
  if (portrait) {
    bits.push(`<figure style="float:right;margin:0 0 10px 14px;max-width:180px;">
      <img src="${esc(portrait)}" alt="${esc(name)}" style="width:100%;border-radius:6px;">
    </figure>`);
  }
  bits.push(`<h2>${esc(name)}</h2>`);

  const kind = [rec?.race, rec?.class].filter(Boolean).join(", ")
    || actor?.system?.details?.type?.value || "";
  const cr = actor?.system?.details?.cr;
  const line = [kind, cr !== undefined && cr !== null ? `CR ${cr}` : ""].filter(Boolean).join(" · ");
  if (line) bits.push(`<p><em>${esc(line)}</em></p>`);

  const bio = _firstProse([
    rec?.bio, rec?.description, rec?.appearance,
    _stripHtml(actor?.system?.details?.biography?.value),
    _stripHtml(actor?.system?.details?.biography?.public),
    rec?.sceneAppearances?.find?.(a => (a?.contextText ?? "").length > 120)?.contextText,
  ]);
  if (bio) {
    bits.push(`<p>${esc(bio)}</p>`);
  } else {
    bits.push(`<p><em>Nothing has been written about ${esc(name)} yet. ACE fills this in
      the first time the party has a real conversation with them.</em></p>`);
  }
  bits.push(`<p style="clear:both;"></p>`);
  return `<div>${bits.join("\n")}</div>`;
}

/** Goal, secret, leverage. GM eyes. */
function _whatTheyWant(rec, actor) {
  const bits = [];
  const want = _firstProse([rec?.goal, rec?.wants, rec?.motivation, rec?.purpose]);
  if (want) bits.push(`<p>${esc(want)}</p>`);

  const secret = _firstProse([rec?.secret, _stripHtml(actor?.system?.details?.biography?.value)]);
  if (secret && secret !== want) {
    bits.push(`<h3>Held back</h3><p>${esc(secret)}</p>`);
  }
  if (!bits.length) {
    bits.push(`<p><em>Unwritten. What this creature wants is the single most useful thing
      to know about them, and it is the first thing ACE asks the model for when they
      next speak.</em></p>`);
  }
  return `<div>${bits.join("\n")}</div>`;
}

/**
 * What has actually passed between this creature and the party, in sentences.
 *
 * ⚠️ THIS REPLACES "Encounters: 2203". A count is not a memory. What belongs
 * here is the moment: who killed them, where, and what was said.
 */
function _betweenUs(rec, name) {
  const moments = [];

  if (rec?.killed) {
    const by = rec.killedBy ? ` by ${rec.killedBy}` : "";
    const at = rec.killedAt ? ` on ${dateOf(rec.killedAt)}` : "";
    moments.push({ t: rec.killedAt ?? 0, html: `<strong>Killed${esc(by)}${esc(at)}.</strong>` });
  }
  for (const n of (rec?.notes ?? [])) {
    if (!n?.txt) continue;
    moments.push({ t: n.t ?? 0, html: esc(n.txt) });
  }
  for (const a of (rec?.sceneAppearances ?? [])) {
    const text = (a?.contextText ?? "").trim();
    if (text.length < 60) continue;
    const where = a.sceneName ? ` <em>at ${esc(a.sceneName)}</em>` : "";
    moments.push({ t: a.t ?? 0, html: `${esc(text)}${where}` });
  }
  for (const [who, info] of Object.entries(rec?.relationships ?? {})) {
    const reason = info && typeof info === "object" ? info.reason : null;
    if (!reason) continue;
    moments.push({ t: info.lastUpdated ?? 0, html: `<strong>${esc(who)}:</strong> ${esc(reason)}` });
  }

  if (!moments.length) {
    const met = Number(rec?.met ?? 0);
    return `<div><p><em>The party has crossed paths with ${esc(name)}
      ${met ? `${met} time${met === 1 ? "" : "s"}` : ""} and nothing was written down.
      Anything said from here forward lands on this page.</em></p></div>`;
  }

  moments.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));   // newest first
  const rows = moments.map(m =>
    `<li>${m.t ? `<strong>${esc(dateOf(m.t))}</strong> — ` : ""}${m.html}</li>`).join("\n");
  return `<div><ul>${rows}</ul></div>`;
}

/** Faction, standing, and who they answer to. */
function _whereTheyStand(rec, actor, faction, standing) {
  const bits = [];
  if (faction?.name) {
    bits.push(`<p><strong>Belongs to:</strong> ${esc(faction.name)}</p>`);
    if (faction.leader) bits.push(`<p><strong>Answers to:</strong> ${esc(faction.leader)}</p>`);
    if (faction.purpose) bits.push(`<p>${esc(faction.purpose)}</p>`);
  } else {
    bits.push(`<p><em>No faction recorded.</em></p>`);
  }
  if (standing) {
    bits.push(`<p><strong>Their faction's view of the party:</strong> ${esc(standing)}</p>`);
  }
  const first = rec?.firstSeen ? dateOf(rec.firstSeen) : "";
  const last = rec?.lastSeen ? dateOf(rec.lastSeen) : "";
  const met = Number(rec?.met ?? 0);
  const footer = [
    first ? `first seen ${first}` : "",
    last && last !== first ? `last seen ${last}` : "",
    met ? `${met} sighting${met === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
  if (footer) {
    bits.push(`<hr><p style="font-size:0.85em;opacity:0.7;">${esc(footer)}</p>`);
  }
  return `<div>${bits.join("\n")}</div>`;
}

// ── A kind of creature ──────────────────────────────────────────────────────

/**
 * The bestiary entry: how many, how they went, and who among them earned a name.
 *
 * Johnny: "Maybe we should somehow group how many specters or goblins we've
 * killed. It's even a metric, really, when you think of it that way."
 */
export function buildBestiaryPages(typeName, { records = [], named = [], kills = 0, losses = 0 } = {}) {
  const met = records.reduce((n, r) => n + Number(r?.met ?? 0), 0);
  const fallen = records.filter(r => r?.killed).length || kills;

  const tally = [];
  tally.push(`<h2>${esc(typeName)}</h2>`);
  tally.push(`<table style="width:100%;">
    <tr><td><strong>Encountered</strong></td><td style="text-align:right;">${met}</td></tr>
    <tr><td><strong>Killed by the party</strong></td><td style="text-align:right;">${fallen}</td></tr>
    ${losses ? `<tr><td><strong>Party members they have killed</strong></td>
                <td style="text-align:right;">${losses}</td></tr>` : ""}
  </table>`);

  const places = [...new Set(records.flatMap(r => r?.scenes ?? []).filter(Boolean))];
  if (places.length) {
    tally.push(`<h3>Where they turn up</h3><ul>${
      places.map(p => `<li>${esc(p)}</li>`).join("")}</ul>`);
  }

  if (named.length) {
    tally.push(`<h3>Ones that earned a name</h3><ul>${
      named.map(n => `<li>${esc(n)}</li>`).join("")}</ul>`);
  }

  const learned = [];
  const facts = records.flatMap(r => (r?.notes ?? []).map(n => n?.txt)).filter(Boolean);
  if (facts.length) {
    learned.push(`<ul>${[...new Set(facts)].map(f => `<li>${esc(f)}</li>`).join("")}</ul>`);
  } else {
    learned.push(`<p><em>Nothing recorded yet about how these fight, what hurts them, or
      what does not. ACE adds to this page as the party discovers it.</em></p>`);
  }

  return [
    { name: "The Tally",    html: `<div>${tally.join("\n")}</div>` },
    { name: "What We Know", html: `<div>${learned.join("\n")}</div>` },
  ];
}

// ── A player character ──────────────────────────────────────────────────────

export const PC_PAGES = ["Who They Are", "Deeds", "The Record"];

/**
 * A hero's record: who they are first, what they have done second, and the
 * numbers last, where numbers belong.
 *
 * ⚠️ THE OLD PAGE OPENED WITH A SCOREBOARD. Class, level, hits, misses,
 * accuracy percentage, damage dealt, highest single hit, kills, crits, fumbles,
 * times knocked out, death saves and a session count, before a single word
 * about the person. Firaxis Greenbeard's read "Class: Paladin 7 | Level: 7" for
 * a 9th-level character, "Sessions: 1552" because it was counting world loads,
 * and "Damage Dealt: 114 HP" across five months of play.
 */
export function buildPcPages(rec, { actor = null } = {}) {
  const name = baseName(actor?.name ?? rec?.displayName ?? "Unknown");
  return [
    { name: "Who They Are", html: _pcWhoTheyAre(rec, actor, name) },
    { name: "Deeds",        html: _pcDeeds(rec, name) },
    { name: "The Record",   html: _pcRecord(rec, actor) },
  ];
}

function _pcWhoTheyAre(rec, actor, name) {
  const bits = [];
  const portrait = actor?.img && !/mystery-man|blank|default/i.test(actor.img) ? actor.img : null;
  if (portrait) {
    bits.push(`<figure style="float:right;margin:0 0 10px 14px;max-width:200px;">
      <img src="${esc(portrait)}" alt="${esc(name)}" style="width:100%;border-radius:6px;">
    </figure>`);
  }
  bits.push(`<h2>${esc(name)}</h2>`);

  // ⚠️ Read live. A level copied into a journal drifts from the day it is
  // written, and for a multiclass the total is the SUM of the class levels.
  const species = speciesOf(actor);
  const { line: classLine, level } = classLineOf(actor);
  const background = backgroundOf(actor);
  const header = [
    species,
    classLine || rec?.class || "",
    level ? `${_ordinal(level)} level` : "",
    background,
  ].filter(Boolean).join(" · ");
  if (header) bits.push(`<p><em>${esc(header)}</em></p>`);

  const bio = _firstProse([
    rec?.bio, rec?.description,
    _stripHtml(actor?.system?.details?.biography?.value),
    _stripHtml(actor?.system?.details?.biography?.public),
  ]);
  bits.push(bio
    ? `<p>${esc(bio)}</p>`
    : `<p><em>Nothing has been written about ${esc(name)} yet. Anything put in the
       character's biography on the sheet appears here.</em></p>`);

  const traits = actor?.system?.details ?? {};
  const rows = [["Ideal", traits.ideal], ["Bond", traits.bond], ["Flaw", traits.flaw],
                ["Trait", traits.trait], ["Alignment", traits.alignment]];
  const written = rows.filter(([, v]) => _stripHtml(v).length > 2);
  if (written.length) {
    bits.push("<h3>Traits</h3><ul>"
      + written.map(([k, v]) => `<li><strong>${k}:</strong> ${esc(_stripHtml(v))}</li>`).join("")
      + "</ul>");
  }
  bits.push(`<p style="clear:both;"></p>`);
  return `<div>${bits.join("\n")}</div>`;
}

/** What they have actually done, in sentences, newest first. */
function _pcDeeds(rec, name) {
  const moments = [];
  for (const m of (rec?.milestones ?? [])) {
    if (m?.txt || m?.type) moments.push({ t: m.t ?? 0, html: esc(m.txt ?? m.type) });
  }
  for (const n of (rec?.notes ?? [])) {
    if (n?.txt) moments.push({ t: n.t ?? 0, html: esc(n.txt) });
  }
  for (const k of (rec?.killLog ?? [])) {
    const who = k?.victimName ?? k?.tgt ?? "";
    if (!who) continue;
    const where = k?.scene ? ` at ${k.scene}` : "";
    moments.push({ t: k.t ?? 0, html: `Killed <strong>${esc(who)}</strong>${esc(where)}.` });
  }
  if (!moments.length) {
    return `<div><p><em>Nothing has been written down about what ${esc(name)} has done.
      Kills, milestones and notable moments land here as they happen.</em></p></div>`;
  }
  moments.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  return `<div><ul>${moments.map(m =>
    `<li>${m.t ? `<strong>${esc(dateOf(m.t))}</strong> — ` : ""}${m.html}</li>`).join("")}</ul></div>`;
}

/** The numbers, on their own page, with the ones we cannot trust marked. */
function _pcRecord(rec, actor) {
  const hits = Number(rec?.hits ?? 0);
  const misses = Number(rec?.misses ?? 0);
  const swings = hits + misses;
  const row = (label, value) =>
    `<tr><td>${label}</td><td style="text-align:right;">${value}</td></tr>`;

  const bits = ["<table style='width:100%;'>"];
  bits.push(row("Attacks landed", hits));
  bits.push(row("Attacks missed", misses));
  if (swings) bits.push(row("Accuracy", `${Math.round((hits / swings) * 100)}%`));
  bits.push(row("Critical hits", Number(rec?.crits ?? 0)));
  bits.push(row("Fumbles", Number(rec?.fumbles ?? 0)));
  bits.push(row("Kills", Number(rec?.kills ?? 0)));
  bits.push(row("Damage dealt", `${Number(rec?.damageDealt ?? 0)} HP`));
  bits.push(row("Hardest single blow", `${Number(rec?.highestHit ?? 0)} HP`));
  bits.push(row("Damage taken", `${Number(rec?.damageTaken ?? 0)} HP`));
  bits.push(row("Healing given", `${Number(rec?.healingDone ?? 0)} HP`));
  bits.push(row("Knocked out", Number(rec?.timesKO ?? 0)));
  bits.push(row("Deaths", Number(rec?.deaths ?? 0)));
  bits.push("</table>");

  const first = rec?.firstSeen ? dateOf(rec.firstSeen) : "";
  const last = rec?.lastSeen ? dateOf(rec.lastSeen) : "";
  if (first) {
    bits.push(`<p style="font-size:0.85em;opacity:0.75;">First seen ${esc(first)}`
      + (last && last !== first ? `, last seen ${esc(last)}` : "") + ".</p>");
  }

  // ⚠️ SAY WHICH NUMBERS ARE WRONG RATHER THAN PRINTING THEM STRAIGHT-FACED.
  // ACE counted attacks by reading dnd5e's chat messages; ACE QOL then took
  // over the attack pipeline and suppresses those messages, so the counters
  // stalled at whatever slipped past. Anything before 22 August 2026 undercounts.
  bits.push(`<hr><p style="font-size:0.85em;opacity:0.7;">These counts begin from
    22 August 2026, when ACE started reading the combat pipeline directly instead of
    the chat log. Anything earlier is undercounted, and the old session tally
    was really a count of world loads.</p>`);
  return `<div>${bits.join("\n")}</div>`;
}

const _ORDINALS = ["0th", "1st", "2nd", "3rd"];
function _ordinal(n) {
  const v = Number(n) || 0;
  if (v % 100 >= 11 && v % 100 <= 13) return `${v}th`;
  return _ORDINALS[v % 10] ? `${v}${_ORDINALS[v % 10].replace(/^\d+/, "")}` : `${v}th`;
}

// ── Writing them out ────────────────────────────────────────────────────────

/**
 * Replace a journal's pages with the given set, in order, linking as we go.
 *
 * ⚠️ Pages are matched by NAME and updated in place rather than deleted and
 * recreated, so a page the GM has opened, bookmarked or shared keeps its id.
 */
export async function writePages(journal, pages, linkIndex) {
  const existing = new Map((journal.pages ?? []).map(p => [p.name, p]));
  const creates = [];
  const updates = [];

  pages.forEach((page, sort) => {
    const html = linkIndex ? linkify(page.html, linkIndex, journal.name) : page.html;
    const current = existing.get(page.name);
    if (current) {
      updates.push({ _id: current.id, "text.content": html, sort: sort * 100 });
      existing.delete(page.name);
    } else {
      creates.push({ name: page.name, type: "text", sort: sort * 100, text: { content: html } });
    }
  });

  // ⚠️ The old single "Memory" page is superseded by these four. Leaving it in
  // place would show the reader a stat dump beside the real pages and there
  // would be no way to tell which one was current.
  const stale = [...existing.values()]
    .filter(p => p.name === "Memory" || /^Appearances — Page \d+$/.test(p.name))
    .map(p => p.id);

  if (updates.length) await journal.updateEmbeddedDocuments("JournalEntryPage", updates);
  if (creates.length) await journal.createEmbeddedDocuments("JournalEntryPage", creates);
  if (stale.length)   await journal.deleteEmbeddedDocuments("JournalEntryPage", stale);
  return { created: creates.length, updated: updates.length, removed: stale.length };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function _stripHtml(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The first candidate that is real prose rather than a stub or an error.
 *
 * ⚠️ THREE OF HIS BIOGRAPHIES CONTAIN AN OPENROUTER BILLING ERROR, written
 * there on 11 July before the failure guard existed. Anything that reads like a
 * provider complaining is not a description of a person.
 */
const PROVIDER_ERROR = new RegExp([
  "requires more credits", "can only afford", "openrouter\\.ai",
  "rate.?limit", "invalid.?api.?key", "__ACE_AI_FAILED__",
  "I'm sorry, but I need more information",
].join("|"), "i");

function _firstProse(candidates) {
  for (const c of candidates) {
    const text = _stripHtml(c);
    if (text.length < 40) continue;
    if (PROVIDER_ERROR.test(text)) continue;
    return text;
  }
  return "";
}
