// ─── ACE: Engine — Living World Dashboard (ApplicationV2) ────────────────────
// A GM panel that makes the living-world machinery visible: the party's
// notoriety + recent world events, and every faction's standing toward the
// party WITH the events that earned it. Searchable + filterable by stance.

import { getAllFactions } from "./npc/faction-registry.mjs";

const MODULE_ID = "ace-engine";

const STANDING_COLOR = {
  revered:    "#54d676",
  friendly:   "#9ccc4a",
  neutral:    "#b9ab86",
  suspicious: "#f0b71f",
  hostile:    "#ff8a4a",
  hated:      "#ff5a4a",
};
const STANDING_WEIGHT = { hated: 6, hostile: 5, suspicious: 4, revered: 3, friendly: 2, neutral: 0 };
// Which filter group a standing belongs to.
const STANDING_GROUP = {
  hated: "against", hostile: "against", suspicious: "against",
  revered: "with", friendly: "with", neutral: "neutral",
};

const MAG_COLOR = {
  trivial: "#b9ab86", local: "#9ccc4a", regional: "#f0b71f",
  national: "#ff9a45", continental: "#ff8a4a", legendary: "#ff5a4a",
};

function _esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function _timeAgo(ts) {
  if (!ts) return "";
  const diff = Math.floor(Date.now() / 1000) - Number(ts);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export class LivingWorldDashboard extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "ace-living-world",
    classes: ["ace-living-world"],
    tag: "div",
    window: { title: "ACE — Living World", icon: "fas fa-globe", resizable: true, minimizable: true },
    position: { width: 840, height: 760 },
  };

  constructor(...args) {
    super(...args);
    this._search = "";
    this._filter = "all";   // all | against | neutral | with
  }

  _api() { return game.modules.get(MODULE_ID)?.api ?? null; }

  async _renderHTML(context, options) {
    const html = document.createElement("div");
    html.classList.add("ace-lw-wrapper");
    html.innerHTML = this._buildHTML();
    return html;
  }
  _replaceHTML(result, content, options) { content.replaceChildren(result); }

  // ── Data ──────────────────────────────────────────────────
  _gather() {
    const api = this._api();
    const registry = getAllFactions() || {};
    const factions = Object.entries(registry).map(([id, f]) => {
      const standing = api?.getFactionStanding?.(id) ?? "neutral";
      const events   = api?.getWorldEventsByFaction?.(id) ?? [];
      return {
        id,
        name: f.name || "(unnamed faction)",
        creatureBase: f.creatureBase || "",
        standing,
        events,
        members: Array.isArray(f.members) ? f.members.length : 0,
        allies:  (f.allies  || []).length,
        enemies: (f.enemies || []).length,
      };
    });
    factions.sort((a, b) => {
      const w = (STANDING_WEIGHT[b.standing] ?? 0) - (STANDING_WEIGHT[a.standing] ?? 0);
      if (w !== 0) return w;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    const repStats     = api?.getReputationStats?.() ?? null;
    const recentEvents = api?.getRecentWorldEvents?.(8) ?? [];
    const withOpinion  = factions.filter(f => f.standing !== "neutral").length;
    return { factions, repStats, recentEvents, withOpinion };
  }

  // ── HTML ──────────────────────────────────────────────────
  _buildHTML() {
    const { factions, repStats, recentEvents, withOpinion } = this._gather();
    const notoriety = repStats?.notoriety || "unknown";
    const titles    = Array.isArray(repStats?.titles) ? repStats.titles : [];

    const eventLines = recentEvents.length
      ? [...recentEvents].reverse().map(e => `
          <div class="ace-lw-evt">
            <span class="ace-lw-mag" style="background:${MAG_COLOR[e.magnitude] || "#b9ab86"}">${_esc(e.magnitude || "local")}</span>
            <span class="ace-lw-evt-txt">${_esc(e.summary || "")}</span>
            <span class="ace-lw-evt-when">${_timeAgo(e.ts)}</span>
          </div>`).join("")
      : `<div class="ace-lw-empty">No world events recorded yet — they appear as the party makes their mark.</div>`;

    const rows = factions.map(f => this._factionRow(f)).join("");

    return `
      <style>${this._css()}</style>
      <div class="ace-lw">
        <div class="ace-lw-header">
          <div class="ace-lw-noto">Party notoriety: <b>${_esc(notoriety.toUpperCase())}</b></div>
          ${titles.length ? `<div class="ace-lw-titles">${titles.map(t => `<span class="ace-lw-title">${_esc(t)}</span>`).join("")}</div>` : ""}
          <button type="button" class="ace-lw-refresh" title="Refresh"><i class="fas fa-rotate"></i></button>
        </div>

        <div class="ace-lw-section-label">Recent world events</div>
        <div class="ace-lw-events">${eventLines}</div>

        <div class="ace-lw-controls">
          <input type="text" class="ace-lw-search" placeholder="Search ${factions.length} factions…" />
          <div class="ace-lw-chips">
            <button type="button" class="ace-lw-chip active" data-filter="all">All</button>
            <button type="button" class="ace-lw-chip" data-filter="against" style="--c:#ff5a4a">Against us</button>
            <button type="button" class="ace-lw-chip" data-filter="with" style="--c:#54d676">With us</button>
            <button type="button" class="ace-lw-chip" data-filter="neutral" style="--c:#b9ab86">Neutral</button>
          </div>
        </div>
        <div class="ace-lw-section-label">
          <b>${withOpinion}</b> of <b>${factions.length}</b> factions have an opinion of the party · click a faction to see why
        </div>
        <div class="ace-lw-list">${rows || `<div class="ace-lw-empty">No factions in the registry yet.</div>`}</div>
      </div>
    `;
  }

  _factionRow(f) {
    const color   = STANDING_COLOR[f.standing] || "#b9ab86";
    const kind    = f.creatureBase ? `<span class="ace-lw-kind">${_esc(f.creatureBase)}</span>` : "";
    const search  = `${f.name} ${f.creatureBase}`.toLowerCase();
    const group   = STANDING_GROUP[f.standing] || "neutral";
    const nonNeutral = f.standing !== "neutral";

    const whyHeader = nonNeutral
      ? `<div class="ace-lw-why">Why they're <b style="color:${color}">${_esc(f.standing)}</b> toward the party:</div>`
      : "";
    const evRows = f.events.length
      ? [...f.events].slice(-8).reverse().map(e => `
          <div class="ace-lw-evt">
            <span class="ace-lw-mag" style="background:${MAG_COLOR[e.magnitude] || "#b9ab86"}">${_esc(e.magnitude || "local")}</span>
            <span class="ace-lw-evt-txt">${_esc(e.summary || "")}</span>
            <span class="ace-lw-evt-when">${_timeAgo(e.ts)}</span>
          </div>`).join("")
      : `<div class="ace-lw-empty">No interactions with the party yet.</div>`;

    return `
      <div class="ace-lw-row" data-standing="${f.standing}" data-group="${group}" data-search="${_esc(search)}" style="border-left-color:${color}">
        <div class="ace-lw-rowhead">
          <span class="ace-lw-name">${_esc(f.name)}</span>
          ${kind}
          <span class="ace-lw-spacer"></span>
          <span class="ace-lw-standing" style="color:${color};border-color:${color}">${_esc(f.standing)}</span>
          ${f.events.length ? `<span class="ace-lw-evtcount" style="color:${color}">${f.events.length} ${f.events.length === 1 ? "event" : "events"}</span>` : ""}
        </div>
        <div class="ace-lw-detail">
          ${whyHeader}
          ${evRows}
          <div class="ace-lw-rel">Members in play: <b>${f.members}</b> &nbsp;·&nbsp; Allies: <b>${f.allies}</b> &nbsp;·&nbsp; Enemies: <b>${f.enemies}</b></div>
        </div>
      </div>
    `;
  }

  _css() {
    return `
      .ace-living-world .window-content { padding:0 !important; overflow:hidden; }
      .ace-lw { display:flex; flex-direction:column; height:100%; background:#14110c; color:#efe4c6;
                font-family:'Rajdhani','Segoe UI',sans-serif; font-size:16px; }
      .ace-lw b { color:#f0d98a; }
      .ace-lw-header { display:flex; align-items:center; gap:12px; flex:0 0 auto;
                       padding:12px 16px; border-bottom:2px solid #4a3f22; background:#211c14; }
      .ace-lw-noto { font-size:19px; color:#efe4c6; }
      .ace-lw-noto b { color:#e8b923; }
      .ace-lw-titles { flex:1 1 auto; }
      .ace-lw-title { display:inline-block; background:#2e2716; color:#f0d98a; border:1px solid #5a4c28;
                      border-radius:4px; padding:2px 9px; margin:0 4px 0 0; font-size:14px; }
      .ace-lw-refresh { margin-left:auto; background:#2e2716; color:#e8b923; border:1px solid #5a4c28;
                        border-radius:6px; width:38px; height:34px; cursor:pointer; font-size:16px; }
      .ace-lw-refresh:hover { background:#3e3420; }
      .ace-lw-section-label { flex:0 0 auto; padding:10px 16px 5px; font-size:15px; font-weight:600;
                              letter-spacing:.03em; color:#cdbd92; }
      .ace-lw-section-label b { color:#e8b923; }
      .ace-lw-events { flex:0 0 auto; max-height:175px; overflow-y:auto; padding:0 16px 8px; }
      .ace-lw-evt { display:flex; align-items:baseline; gap:9px; padding:6px 0; border-bottom:1px solid #2a2418; }
      .ace-lw-mag { color:#14110c; font-weight:800; font-size:12px; text-transform:uppercase;
                    border-radius:4px; padding:2px 7px; flex:0 0 auto; }
      .ace-lw-evt-txt { flex:1 1 auto; color:#efe4c6; font-size:16px; line-height:1.3; }
      .ace-lw-evt-when { flex:0 0 auto; color:#cdbd92; font-size:14px; }
      .ace-lw-controls { flex:0 0 auto; display:flex; align-items:center; gap:12px; padding:9px 16px;
                         background:#211c14; border-top:2px solid #4a3f22; border-bottom:2px solid #4a3f22; }
      .ace-lw-search { flex:1 1 auto; background:#0c0a06; color:#efe4c6; border:1px solid #5a4c28;
                       border-radius:6px; padding:9px 12px; font-size:16px; }
      .ace-lw-search::placeholder { color:#9a8c6a; }
      .ace-lw-chips { display:flex; gap:6px; flex:0 0 auto; }
      .ace-lw-chip { background:#2a2418; color:#efe4c6; border:2px solid #5a4c28; border-radius:16px;
                     padding:5px 13px; font-size:15px; font-weight:600; cursor:pointer; }
      .ace-lw-chip:hover { border-color:#7a6838; }
      .ace-lw-chip.active { background:var(--c,#e8b923); color:#14110c; border-color:var(--c,#e8b923); }
      .ace-lw-list { flex:1 1 auto; overflow-y:auto; min-height:0; padding:6px 10px 14px; }
      .ace-lw-row { border:1px solid #2e2718; border-left:5px solid #b9ab86; border-radius:7px;
                    margin:6px 0; background:#1c1812; cursor:pointer; }
      .ace-lw-row:hover { background:#241e16; border-color:#5a4c28; }
      .ace-lw-rowhead { display:flex; align-items:center; gap:11px; padding:11px 13px; }
      .ace-lw-name { font-weight:700; color:#f6ecce; font-size:19px; }
      .ace-lw-kind { color:#cdbd92; font-size:15px; text-transform:capitalize; }
      .ace-lw-spacer { flex:1 1 auto; }
      .ace-lw-standing { font-size:15px; font-weight:700; text-transform:uppercase; border:2px solid;
                         border-radius:5px; padding:2px 10px; flex:0 0 auto; }
      .ace-lw-evtcount { font-size:15px; font-weight:600; flex:0 0 auto; }
      .ace-lw-detail { display:none; padding:6px 14px 13px 18px; border-top:1px solid #2a2418; }
      .ace-lw-row.expanded .ace-lw-detail { display:block; }
      .ace-lw-why { color:#efe4c6; font-size:16px; margin:6px 0 8px; }
      .ace-lw-rel { margin-top:9px; color:#cdbd92; font-size:15px; }
      .ace-lw-rel b { color:#f0d98a; }
      .ace-lw-empty { color:#cdbd92; font-style:italic; padding:8px 2px; font-size:15px; }
    `;
  }

  // ── Interactions (client-side filter; no re-render so search keeps focus) ──
  _onRender(context, options) {
    const root = this.element;
    if (!root) return;

    const applyFilter = () => {
      const q = (this._search || "").toLowerCase().trim();
      root.querySelectorAll(".ace-lw-row").forEach(row => {
        const hay = row.dataset.search || "";
        const matchSearch = !q || hay.includes(q);
        const matchFilter = this._filter === "all" || row.dataset.group === this._filter;
        row.style.display = (matchSearch && matchFilter) ? "" : "none";
      });
    };

    const search = root.querySelector(".ace-lw-search");
    if (search) {
      search.value = this._search;
      search.addEventListener("input", (e) => { this._search = e.target.value; applyFilter(); });
    }
    root.querySelectorAll(".ace-lw-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        this._filter = chip.dataset.filter;
        root.querySelectorAll(".ace-lw-chip").forEach(c => c.classList.toggle("active", c === chip));
        applyFilter();
      });
    });
    const refresh = root.querySelector(".ace-lw-refresh");
    if (refresh) refresh.addEventListener("click", () => this.render());

    root.querySelectorAll(".ace-lw-row").forEach(row => {
      row.addEventListener("click", (ev) => {
        if (ev.target.closest(".ace-lw-search, .ace-lw-chip")) return;
        row.classList.toggle("expanded");
      });
    });

    applyFilter();
  }
}
