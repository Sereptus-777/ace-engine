// ─── ACE Engine — where everybody stands ────────────────────────────────────
//
// Johnny, 2026-08-22: "I'd also like to know where my player characters stand,
// or even NPCs. How do I see that easily? I want to know what faction they
// belong to and what they are regarding the group as, as GM only, of course."
//
// There was no answer to that question anywhere. Faction standing lived in a
// JSON file, faction membership lived in an actor flag with no interface, and
// the only way to read either was the console. A reputation system nobody can
// look at is a reputation system nobody can use.
//
// ⚠️ GM ONLY, ALWAYS. This is the whole shape of the party's political
// position, including who quietly despises them. A player seeing it would know
// things their character cannot possibly know. It never renders for a player
// and it is never sent to one.

import { bandFor, fameBandFor } from "./reputation-scale.mjs";
import { getAllFactions } from "./npc/faction-registry.mjs";
import { classify } from "./npc/journal-identity.mjs";

const MODULE_ID = "ace-engine";

const BAND_COLOUR = {
  revered:  "#4fd977", friendly: "#7fd06a", cordial: "#b9cf5a",
  neutral:  "#c9a84c",
  wary:     "#e0a13a", hostile:  "#e06c3a", hated:   "#d94f4f",
};

/**
 * Actors that exist to test the module, not to be in the story.
 *
 * ⚠️ A DISPLAY FILTER, DELIBERATELY, AND NOT PART OF journal-identity. Teaching
 * the shared classifier that these are "things" would make the journal rebuild
 * DELETE them, and Johnny has said plainly of Hammer the Test Fighter: "don't
 * delete this guy or the features on this guy." He keeps them on purpose. They
 * simply do not belong on a screen about who his party is.
 *
 * ⚠️ WRITTEN WITH A CHARACTER CLASS, NOT A WORD BOUNDARY. The first version of
 * this line had four word-boundary escapes and every one of them was eaten on
 * the way to disk, leaving literal backspace bytes that no name will ever
 * contain. That is the fourth time today; the checker in ace-qol/tools caught
 * it, which is the entire reason it exists.
 */
const TEST_ACTOR = /test dummy|test fighter|(^|[^a-z])test([^a-z]|$).*(actor|npc|pc)|\(King\) Original/i;

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export class AceStandingsPanel extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "ace-standings-panel",
    classes: ["ace-engine", "ace-standings"],
    tag: "div",
    window: { title: "ACE — Where Everybody Stands", icon: "fa-solid fa-scale-balanced", resizable: true },
    // ⚠️ 780 WIDE WAS NOT ENOUGH FOR ITS OWN COLUMNS. At the old size the
    // member-count column ran off the right edge and the numbers beside it were
    // clipped mid-digit. Widened to fit the grid below at readable type.
    position: { width: 1180, height: 860 },
  };

  async _renderHTML() { return this._build(); }
  _replaceHTML(result, content) { content.innerHTML = result; this._wire(content); }

  _api() { return game.modules.get(MODULE_ID)?.api ?? null; }

  /** Every creature that has a faction, grouped by it. */
  /**
   * Is this actor somebody a player actually plays?
   *
   * ⚠️🔴 `hasPlayerOwner` IS A PERMISSION, NOT AN IDENTITY (2026-08-22).
   *
   * Johnny, looking at his own "Player characters" list: "I don't remember
   * adding a group map marker to my player character list." Neither did he add
   * a Bat, a Bear, three Fey Spirits, an ACE Test Dummy, an "Adventure Party",
   * two Hammer the Test Fighters, or a token called "download".
   *
   * Every one of them is there because a player has ownership on it. Summons,
   * wild-shape forms, map markers, party tokens and test actors all carry
   * player ownership, and none of them is a character.
   *
   * The definitive answer is the one Foundry already stores: a User has a
   * `character`. That is a deliberate assignment by the GM and it cannot be
   * confused with a permission. Companions the party fights alongside — King
   * the spectral wolf, Virric's Steel Defender — are not assigned to a user,
   * so they are listed separately rather than pretended into the party or
   * dropped out of it.
   */
  _playerCharacterIds() {
    const ids = new Set();
    for (const u of (game.users ?? [])) {
      if (u?.character?.id) ids.add(u.character.id);
    }
    return ids;
  }

  _cast() {
    const byFaction = new Map();
    const players = [];
    const companions = [];
    const assigned = this._playerCharacterIds();

    for (const a of (game.actors ?? [])) {
      let fid = "";
      try { fid = a.getFlag(MODULE_ID, "factionId") || ""; } catch (_) {}
      const isPlayer = assigned.has(a.id);
      const row = { name: a.name, id: a.id, isPC: isPlayer };

      if (fid) {
        if (!byFaction.has(fid)) byFaction.set(fid, []);
        byFaction.get(fid).push(row);
        continue;
      }
      if (isPlayer) { players.push(row); continue; }

      // A companion: owned by a player, has class levels, and is not scenery.
      // ⚠️ Reuses the journal classifier rather than guessing again — it already
      // knows a map marker from a creature, and it was written against this
      // exact world.
      if (!a.hasPlayerOwner) continue;
      if (a.type !== "character") continue;
      if (TEST_ACTOR.test(a.name)) continue;
      // ⚠️ NO CLASS-LEVEL REQUIREMENT. Requiring one dropped the Steel Defender,
      // which is a genuine member of the company, while happily keeping an "ACE
      // Test Dummy (Fighter 20)". Class levels measure a character sheet, not
      // whether something fights beside the party.
      try {
        if (classify(a.name, null).kind === "thing") continue;
      } catch (_) { /* the classifier is a refinement, never a gate */ }
      companions.push(row);
    }
    return { byFaction, players, companions };
  }

  _build() {
    const api = this._api();
    const all = getAllFactions() ?? {};
    const { byFaction, players, companions } = this._cast();

    // ⚠️ Only factions that MEAN something to this table: ones the party has a
    // reading on, or ones with creatures in them. 453 rows of untouched
    // neutrals is not an answer to "where does everybody stand".
    const rows = [];
    for (const [id, f] of Object.entries(all)) {
      if (!f || typeof f !== "object") continue;
      const score = api?.getFactionScore?.(id) ?? 0;
      const members = byFaction.get(id) ?? [];
      if (!score && !members.length) continue;
      rows.push({ id, name: f.name || id, score, band: bandFor(score), members });
    }
    rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const fame = api?.getFameScore?.() ?? 0;
    const fameBand = fameBandFor(fame);

    const bar = (score) => {
      const pct = Math.round(((score + 100) / 200) * 100);
      const col = BAND_COLOUR[bandFor(score).key] ?? "#c9a84c";
      return `<div class="ace-st-bar"><div class="ace-st-fill" style="left:50%;width:0;"></div>
        <div class="ace-st-fill" style="${score >= 0 ? `left:50%;width:${pct - 50}%` : `left:${pct}%;width:${50 - pct}%`};background:${col}"></div>
        <div class="ace-st-mid"></div></div>`;
    };

    const factionHtml = rows.map(r => `
      <details class="ace-st-faction">
        <summary>
          <span class="ace-st-name">${esc(r.name)}</span>
          ${bar(r.score)}
          <span class="ace-st-band" style="color:${BAND_COLOUR[r.band.key]}">${esc(r.band.label)}</span>
          <span class="ace-st-score">${r.score > 0 ? "+" : ""}${r.score}</span>
          <span class="ace-st-count">${r.members.length || ""}</span>
        </summary>
        <div class="ace-st-members">${
          r.members.length
            ? r.members.map(m => `<span class="ace-st-member${m.isPC ? " pc" : ""}">${esc(m.name)}</span>`).join("")
            : `<em>Nobody in your world belongs to them yet.</em>`
        }</div>
      </details>`).join("");



    return `
      <style>
        /* ⚠️ THE FIRST LETTER OF EVERY LINE WAS BEING CUT OFF, including the "Y"
           of "Your party" and the "F" of "Factions". There was no padding
           anywhere: content started at x=0 and the window frame ate the first
           few pixels of every glyph. This wrapper is the fix, and it is also
           what makes the list scroll instead of running off the bottom. */
        /* ⚠️ THE SCROLL BOX NEEDS A PARENT THAT WILL NOT GROW. ApplicationV2's
           window-content pads and sizes itself, so a child asking for height:100%
           and overflow:auto gets neither: the content just runs past the bottom
           of the window with no bar. Zero the padding, stop it scrolling, and let
           the wrapper take the remaining space. */
        .ace-standings .window-content {
          padding: 0; overflow: hidden; display: flex; flex-direction: column;
        }
        .ace-standings .ace-st-scroll {
          flex: 1 1 auto; min-height: 0;
          padding: 22px 30px 30px 30px;
          overflow-y: auto; overflow-x: hidden;
          box-sizing: border-box;
        }
        /* A visible scrollbar, because an invisible one on a dark panel reads as
           "the list ends here". */
        .ace-standings .ace-st-scroll::-webkit-scrollbar { width: 14px; }
        .ace-standings .ace-st-scroll::-webkit-scrollbar-track {
          background: rgba(0,0,0,.35); border-radius: 7px; }
        .ace-standings .ace-st-scroll::-webkit-scrollbar-thumb {
          background: #8a6f22; border-radius: 7px; border: 3px solid rgba(0,0,0,.35); }
        .ace-standings .ace-st-scroll::-webkit-scrollbar-thumb:hover { background: #d4af37; }

        /* ⚠️ EVERYTHING ROUGHLY DOUBLED. Johnny, reading the old panel: "The
           numbers aren't big enough, and nothing is big enough. Twice the size
           for everything. I can't even read that." Body was 14px, the band was
           13px and the member count 12px, on a dark panel, in a small window. */
        .ace-standings .ace-st-head { display:flex; gap:20px; align-items:baseline;
          margin:0 0 20px; flex-wrap:wrap; }
        .ace-standings h2 { color:#d4af37; font-size:26px; letter-spacing:.05em;
          margin:30px 0 12px; }
        .ace-standings .ace-st-faction { border-bottom:1px solid rgba(212,175,55,.18); }
        .ace-standings summary { display:grid;
          grid-template-columns: minmax(0,1fr) 230px 140px 96px 64px;
          gap:16px; align-items:center; padding:13px 6px; cursor:pointer;
          font-size:22px; line-height:1.35; }
        .ace-standings summary:hover { background:rgba(212,175,55,.07); }
        .ace-standings summary::-webkit-details-marker { display:none; }
        .ace-standings .ace-st-name { color:#e8dcb8; overflow:hidden;
          text-overflow:ellipsis; white-space:nowrap; }
        .ace-standings .ace-st-band { font-size:20px; text-align:right; }
        .ace-standings .ace-st-score { text-align:right; color:#cfc4a6; font-size:22px;
          font-weight:600; font-variant-numeric:tabular-nums; }
        .ace-standings .ace-st-count { text-align:right; color:#9a9384; font-size:18px;
          font-variant-numeric:tabular-nums; }
        .ace-standings .ace-st-bar { position:relative; height:14px; border-radius:7px;
          background:rgba(255,255,255,.07); overflow:hidden; }
        .ace-standings .ace-st-fill { position:absolute; top:0; height:100%; }
        .ace-standings .ace-st-mid { position:absolute; left:50%; top:0; width:2px; height:100%;
          background:rgba(255,255,255,.30); }
        .ace-standings .ace-st-members { padding:8px 10px 20px; display:flex;
          flex-wrap:wrap; gap:10px; }
        .ace-standings .ace-st-member { background:rgba(212,175,55,.10);
          border:1px solid rgba(212,175,55,.25); border-radius:6px; padding:6px 14px;
          font-size:19px; color:#cfc4a6; }
        .ace-standings .ace-st-member.pc { border-color:#7fd06a; color:#cfe6c0; }
        .ace-standings .ace-st-note { color:#b0a894; font-size:18px; margin:12px 0 0;
          line-height:1.5; }
        .ace-standings .ace-st-legend { display:grid;
          grid-template-columns: minmax(0,1fr) 230px 140px 96px 64px;
          gap:16px; padding:0 6px 8px; font-size:16px; color:#8a7f68;
          letter-spacing:.06em; text-transform:uppercase;
          border-bottom:1px solid rgba(212,175,55,.30); }
        .ace-standings .ace-st-legend span:not(:first-child) { text-align:right; }
      </style>
      <div class="ace-st-scroll">
      <div class="ace-st-head">
        <strong style="color:#d4af37; font-size:30px;">Your party is ${esc(fameBand.label)}</strong>
        <span style="color:#b0a894; font-size:20px;">renown ${fame}/100</span>
      </div>

      <h2>Factions that have an opinion</h2>
      ${rows.length ? `<div class="ace-st-legend">
        <span>Faction</span><span>Against you &nbsp;·&nbsp; For you</span>
        <span>Standing</span><span>Score</span><span>Members</span>
      </div>` : ""}
      ${rows.length ? factionHtml : `<p class="ace-st-note">No faction has formed a view of your party yet, and nobody has been assigned to one.</p>`}

      <h2>Player characters</h2>
      <div class="ace-st-members">${
        players.length
          ? players.map(p => `<span class="ace-st-member pc">${esc(p.name)}</span>`).join("")
          : `<em>Nobody is assigned to a player. Set each player's character in User Management
             and they will appear here.</em>`}</div>
      ${companions.length ? `
      <h2>Companions</h2>
      <div class="ace-st-members">${
        companions.map(p => `<span class="ace-st-member">${esc(p.name)}</span>`).join("")}</div>
      <p class="ace-st-note">Fights alongside the party but is not somebody's assigned character.</p>` : ""}
      <p class="ace-st-note">A player character has no standing of their own — the party is what factions
      form a view of. Their individual record is in the campaign chronicle.</p>

      <p class="ace-st-note">⚠️ GM only. This is the shape of your party's political position, including who
      quietly despises them, and a player seeing it would know things their character cannot.</p>
      </div>
    `;
  }

  _wire(content) {
    for (const el of content.querySelectorAll(".ace-st-member")) {
      el.addEventListener("click", () => {
        const actor = game.actors?.getName?.(el.textContent.trim());
        actor?.sheet?.render(true);
      });
      el.style.cursor = "pointer";
    }
  }
}

/** Open it. GM only, and it says so rather than failing quietly. */
export function openStandings() {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Where Everybody Stands is GM only.");
    return null;
  }
  const app = new AceStandingsPanel();
  app.render(true);
  return app;
}
