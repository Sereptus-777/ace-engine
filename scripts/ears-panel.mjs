// ─── ACE Engine — the listening panel ───────────────────────────────────────
//
// Johnny, 2026-09-06: *"build the panel, make sure I can pop it out so I can put
// it on a different screen. I don't need it blocking my map."*
//
// WHAT IT IS
//     A GM-only view of what ACE Ears heard and what it thinks matters. Left
//     column is the transcript, right column is what was flagged, and the only
//     door into his world is the button at the bottom.
//
// ⚠️🔴 THE POP-OUT IS A REAL BROWSER WINDOW, NOT A FLOATING DIV. He plays on
// more than one screen and the map is the thing he is actually looking at.
// A Foundry application, however draggable, still lives inside the same page:
// it can be moved but never off the monitor. `window.open` gives him a window
// the operating system owns, which he can throw at the second screen and forget
// about.
//
// ⚠️ AND THE CHILD WINDOW IS A DUMB SURFACE. Everything is driven from THIS
// page: the polling, the rendering and the click handlers all run here and
// write into the child's document. Nothing is injected into the child as a
// script, so there is no second copy of this logic to keep in step, no
// script-source rules to satisfy, and closing the child cannot leave a timer
// running: the loop notices `closed` and stops itself.
//
// ⚠️ IT NEVER WRITES ON ITS OWN. Keep and drop only mark an item. The journal
// is written by one button, by him, with a count of exactly what it is about
// to write. This is phase one: it watches, it does not act.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-engine";
const LOG = `${MODULE_ID} | ears`;
const POLL_MS = 2500;

const KIND_COLOUR = {
  decision: "#7F77DD", deal: "#7F77DD", promise: "#EF9F27",
  name: "#1D9E75", place: "#1D9E75", lore: "#1D9E75",
  threat: "#D85A30", question: "#888780",
};

const SPEAKER_COLOURS = ["#7F77DD", "#1D9E75", "#D85A30", "#ED93B1", "#378ADD", "#BA7517"];

export class EarsPanel {

  static _win = null;
  static _timer = null;
  static _speakerColour = new Map();

  static serviceUrl() {
    let url = "http://127.0.0.1:7867";
    try { url = game.settings.get(MODULE_ID, "earsServiceUrl") || url; } catch (_) { /* pre-registration */ }
    return String(url).replace(/\/+$/, "");
  }

  static colourFor(speaker) {
    if (!EarsPanel._speakerColour.has(speaker)) {
      const i = EarsPanel._speakerColour.size % SPEAKER_COLOURS.length;
      EarsPanel._speakerColour.set(speaker, SPEAKER_COLOURS[i]);
    }
    return EarsPanel._speakerColour.get(speaker);
  }

  /* ── Talking to the service ────────────────────────────────────────────── */

  static async _get(route) {
    const res = await fetch(`${EarsPanel.serviceUrl()}${route}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${route} answered ${res.status}`);
    return res.json();
  }

  static async _post(route, body) {
    const res = await fetch(`${EarsPanel.serviceUrl()}${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`${route} answered ${res.status}`);
    return res.json();
  }

  /**
   * Send the campaign's own proper nouns to the transcriber.
   *
   * ⚠️ THE WORLD ALREADY KNOWS THEM. Whisper wrote "extender" for "Exethanter"
   * because it has never heard of this campaign, and it takes a vocabulary hint
   * that fixes exactly that. Foundry holds every actor, scene and journal name,
   * so a hand-kept list here would be a second copy that goes stale.
   *
   * ⚠️ THE ONES ON THE BOARD GO FIRST. Whisper only reads the tail of the hint,
   * so the creatures actually in tonight's scene matter more than the 1,900
   * monsters sitting in the sidebar.
   */
  static async pushVocabulary() {
    try {
      const onScene = [];
      for (const t of (canvas?.tokens?.placeables ?? [])) {
        if (t?.name) onScene.push(t.name);
        if (t?.actor?.name) onScene.push(t.actor.name);
      }
      const players = (game.actors ?? []).filter(a => a.hasPlayerOwner).map(a => a.name);
      const scenes = (game.scenes ?? []).map(s => s.name);
      const journals = (game.journal ?? []).map(j => j.name);
      const words = [...new Set([...onScene, ...players, ...scenes, ...journals])]
        .filter(w => typeof w === "string" && w.length > 2 && w.length < 40);
      const out = await EarsPanel._post("/vocabulary", { words });
      console.log(`${LOG} | sent ${out.count} name(s) to the transcriber`);
      return out.count;
    } catch (err) {
      console.warn(`${LOG} | could not send the vocabulary:`, err);
      return 0;
    }
  }

  /* ── Writing to his world ──────────────────────────────────────────────── */

  /**
   * Everything he kept becomes a real ACE event, exactly like a kill or a crit,
   * so the session summary and the journals already know how to use it.
   */
  static async sendKept(kept) {
    const memory = game.modules.get(MODULE_ID)?.api?.memoryManager;
    if (!memory) {
      ui.notifications?.error("ACE: the memory manager is not available, so nothing was written.");
      return 0;
    }
    let written = 0;
    for (const item of kept) {
      try {
        memory.history?.push({
          k: "heard", a: item.speaker || "", txt: item.text,
          s: canvas?.scene?.name ?? "", d: { kind: item.kind, quote: item.quote },
        });
        memory.world?.addWorldNote?.(item.text, canvas?.scene?.name ?? "", item.kind);
        written += 1;
      } catch (err) {
        console.warn(`${LOG} | could not record "${item.text?.slice(0, 40)}":`, err);
      }
    }
    try { await memory.saveAll?.(); } catch (_) { /* it also saves on its own schedule */ }
    ui.notifications?.info(`ACE: ${written} item(s) written to the campaign log.`);
    return written;
  }

  /* ── The window ────────────────────────────────────────────────────────── */

  static open() {
    if (!game.user?.isGM) {
      return ui.notifications?.warn("The listening panel is GM only.");
    }
    if (EarsPanel._win && !EarsPanel._win.closed) {
      EarsPanel._win.focus();
      return EarsPanel._win;
    }
    const win = window.open("", "ace-ears-panel",
      "width=620,height=940,menubar=no,toolbar=no,location=no,status=no");
    if (!win) {
      return ui.notifications?.error(
        "ACE: the browser blocked the pop-out. Allow pop-ups for this site and try again.");
    }
    EarsPanel._win = win;
    win.document.title = "ACE — listening";
    win.document.body.innerHTML = "";
    win.document.head.innerHTML = `<meta charset="utf-8"><style>
      body{margin:0;background:#15110d;color:#f0e4c0;
           font-family:Signika,'Helvetica Neue',sans-serif;font-size:15px;}
      .bar{display:flex;align-items:center;gap:10px;padding:10px 14px;
           border-bottom:1px solid #6b5a2e;position:sticky;top:0;background:#15110d;}
      .pill{font-size:12px;padding:3px 10px;border-radius:8px;}
      .cols{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:12px 14px 90px;}
      .h{font-size:13px;color:#b3a888;margin-bottom:8px;}
      .line{border-left:2px solid #888;padding-left:10px;margin-bottom:10px;}
      .who{font-size:12px;color:#8d8069;}
      .card{background:#1c150e;border:1px solid #3a3020;border-radius:10px;
            padding:10px 12px;margin-bottom:10px;}
      .kind{font-size:12px;padding:2px 8px;border-radius:6px;color:#15110d;}
      .quote{font-size:12px;color:#8d8069;font-style:italic;margin:6px 0 8px;}
      button{background:#2a2118;color:#ffd970;border:1px solid #d4af37;border-radius:6px;
             padding:4px 10px;font-size:13px;cursor:pointer;font-family:inherit;}
      button:hover{background:#3a2e20;}
      button.off{color:#c9a; border-color:#6b4a4a;}
      .foot{position:fixed;left:0;right:0;bottom:0;background:#15110d;
            border-top:1px solid #6b5a2e;padding:10px 14px;display:flex;
            align-items:center;gap:10px;font-size:13px;color:#b3a888;}
      .err{color:#e06060;font-size:12px;padding:0 14px 8px;}
    </style>`;
    const root = win.document.createElement("div");
    root.id = "ace-ears-root";
    win.document.body.appendChild(root);

    win.addEventListener("beforeunload", () => EarsPanel.stop());

    EarsPanel.pushVocabulary();
    EarsPanel._tick();
    EarsPanel._timer = setInterval(() => EarsPanel._tick(), POLL_MS);
    console.log(`${LOG} | panel open, polling ${EarsPanel.serviceUrl()}`);
    return win;
  }

  static stop() {
    if (EarsPanel._timer) clearInterval(EarsPanel._timer);
    EarsPanel._timer = null;
  }

  static async _tick() {
    const win = EarsPanel._win;
    // ⚠️ THE LOOP STOPS ITSELF. He will close that window on the other screen
    // and never think about it again; a timer left polling a dead document is
    // a leak nobody would ever notice.
    if (!win || win.closed) return EarsPanel.stop();
    try {
      const data = await EarsPanel._get("/session");
      EarsPanel._render(win, data);
    } catch (err) {
      EarsPanel._renderOffline(win, err);
    }
  }

  static _renderOffline(win, err) {
    const root = win.document.getElementById("ace-ears-root");
    if (!root) return;
    root.innerHTML = `
      <div class="bar"><strong>ACE is not hearing anything</strong></div>
      <div style="padding:16px;line-height:1.6;">
        <p>The listening service is not answering at
           <code>${EarsPanel.serviceUrl()}</code>.</p>
        <p style="color:#8d8069;font-size:13px;">${String(err?.message ?? err)}</p>
        <p>Start it with:</p>
        <pre style="background:#0c0a08;padding:10px;border-radius:6px;overflow:auto;">cd "D:/FoundryVTT/Data/AI CODING/ace-ears"
python server.py</pre>
      </div>`;
  }

  static _render(win, data) {
    const doc = win.document;
    const root = doc.getElementById("ace-ears-root");
    if (!root) return;
    const esc = (v) => String(v ?? "").replace(/[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

    const mins = Math.round((data.audioSeconds ?? 0) / 60);
    const undecided = data.flagged.filter(f => !f.decision);
    const kept = data.flagged.filter(f => f.decision === "keep");

    const heardHtml = (data.heard ?? []).slice(-40).reverse().map(h => `
      <div class="line" style="border-left-color:${EarsPanel.colourFor(h.speaker)};">
        <div class="who">${esc(h.speaker)}</div>
        <div>${esc(h.text)}</div>
      </div>`).join("") || `<div class="who">Nothing yet.</div>`;

    const cardHtml = (f) => `
      <div class="card" data-id="${esc(f.id)}">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <span class="kind" style="background:${KIND_COLOUR[f.kind] ?? "#888780"};">${esc(f.kind)}</span>
          <span class="who">${esc(f.speaker || "unattributed")}${
            f.confidence === "low" ? " · unsure" : ""}</span>
          ${f.decision === "keep" ? `<span class="who" style="color:#9FE1CB;">· kept</span>` : ""}
        </div>
        <div>${esc(f.text)}</div>
        ${f.quote ? `<div class="quote">“${esc(f.quote)}”</div>` : ""}
        <div style="display:flex;gap:6px;">
          <button data-act="keep">Keep</button>
          <button data-act="drop" class="off">Drop</button>
        </div>
      </div>`;

    const flaggedHtml = (data.flagged ?? []).slice().reverse().map(cardHtml).join("")
      || `<div class="who">Nothing flagged yet.</div>`;

    root.innerHTML = `
      <div class="bar">
        <strong>ACE is listening</strong>
        <span class="pill" style="background:${data.paused ? "#4a3a1a" : "#0F6E56"};color:#e6fff4;">
          ${data.paused ? "Paused" : "Recording"} · ${mins}m of speech</span>
        <span style="flex:1"></span>
        <span class="who">${(data.speakers ?? []).length} speaker(s)</span>
        <button data-act="pause">${data.paused ? "Resume" : "Pause"}</button>
      </div>
      ${(data.errors ?? []).length
        ? `<div class="err">${esc(data.errors[data.errors.length - 1])}</div>` : ""}
      <div class="cols">
        <div><div class="h">Heard · ${data.counts?.heard ?? 0}</div>${heardHtml}</div>
        <div><div class="h">Worth keeping · ${undecided.length} to review</div>${flaggedHtml}</div>
      </div>
      <div class="foot">
        <span>Nothing reaches the journal until you send it. GM only.</span>
        <span style="flex:1"></span>
        <button data-act="send">Send ${kept.length} kept to journal</button>
      </div>`;

    // ⚠️ HANDLERS BOUND FROM HERE, over the child's elements. The child holds no
    // script of its own, so this page stays the only place the logic lives.
    for (const btn of doc.querySelectorAll("[data-act]")) {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const act = btn.dataset.act;
        try {
          if (act === "pause") { await EarsPanel._post("/pause"); return EarsPanel._tick(); }
          if (act === "send") {
            if (!kept.length) return win.alert("Nothing is marked to keep yet.");
            await EarsPanel.sendKept(kept);
            for (const k of kept) await EarsPanel._post("/decide", { id: k.id, keep: false });
            return EarsPanel._tick();
          }
          const id = btn.closest("[data-id]")?.dataset?.id;
          if (!id) return;
          await EarsPanel._post("/decide", { id, keep: act === "keep" });
          EarsPanel._tick();
        } catch (err) {
          console.error(`${LOG} | ${act} failed:`, err);
          win.alert(`That did not work: ${err.message}`);
        }
      });
    }
  }

  /* ── Wiring ────────────────────────────────────────────────────────────── */

  static register() {
    try {
      game.settings.register(MODULE_ID, "earsServiceUrl", {
        name: "ACE Ears service address",
        hint: "Where the local listening service is running. Leave this alone unless you moved it.",
        scope: "client", config: true, type: String,
        default: "http://127.0.0.1:7867",
      });
    } catch (_) { /* already registered */ }

    // A button on the journal sidebar, where he already goes for the campaign log.
    Hooks.on("renderJournalDirectory", (app, html) => {
      try {
        if (!game.user?.isGM) return;
        const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
        const header = root?.querySelector(".header-actions") ?? root?.querySelector(".directory-header");
        if (!header || header.querySelector(".ace-ears-open")) return;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ace-ears-open";
        b.style.cssText = "flex:0 0 auto;margin-left:4px;";
        b.innerHTML = `<i class="fas fa-ear-listen"></i> Listening`;
        b.addEventListener("click", (ev) => { ev.preventDefault(); EarsPanel.open(); });
        header.appendChild(b);
      } catch (err) {
        console.warn(`${LOG} | could not add the sidebar button:`, err);
      }
    });

    console.log(`${LOG} | ready — open it from the journal sidebar, or `
      + `game.modules.get("${MODULE_ID}").api.openEars()`);
  }
}
