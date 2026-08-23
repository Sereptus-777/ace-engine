// ─── "Will the whole table actually hear this?" ──────────────────────────────
//
// ⚠️ WHY THIS SCREEN EXISTS. Johnny, 2026-08-23: "I don't want some guy that
// bought ACE Engine to set up his game, get everything working, get the voice
// provider picked, and then it doesn't work. It works on his machine but doesn't
// work when the clients connect."
//
// Voice is the one feature where the GM cannot see the fault. Their own machine
// makes the audio, so it always sounds right to them; the failure is entirely on
// the other side of the socket. Every other diagnostic in ACE reports what THIS
// client can see. This one asks everybody.
//
// It is deliberately a screen and not a console command. A GM checking before a
// session should not have to know an API call exists.
const MODULE_ID = "ace-engine";

/** Dark wrapper. Foundry's Dialog body is light parchment, so light text on it
 *  is invisible — the standing UI rule for every ACE dialog. Minimum 16px body
 *  text on top of Foundry's chrome. */
const CSS = `
<style>
  .ace-vr { background:#0f0f11; border:1px solid #6b5a2a; border-radius:6px;
            padding:14px; color:#e8e0cc; font-size:16px; line-height:1.5; }
  .ace-vr h3 { font-size:19px; color:#d4af37; margin:0 0 4px; letter-spacing:0.02em; }
  .ace-vr .sub { font-size:14px; color:#b8a78a; margin:0 0 12px; }
  .ace-vr table { width:100%; border-collapse:collapse; }
  .ace-vr th { text-align:left; font-size:14px; text-transform:uppercase;
               letter-spacing:0.05em; color:#b8a78a; border-bottom:1px solid #3a3320;
               padding:6px 8px; }
  .ace-vr td { padding:8px; border-bottom:1px solid #26221a; vertical-align:top; font-size:16px; }
  .ace-vr .who { font-weight:bold; color:#f0e4c0; white-space:nowrap; }
  .ace-vr .gmtag { font-size:12px; color:#0f0f11; background:#d4af37;
                   border-radius:3px; padding:1px 5px; margin-left:6px; vertical-align:middle; }
  .ace-vr .good { color:#7fd18a; font-weight:bold; }
  .ace-vr .warn { color:#e8c96a; font-weight:bold; }
  .ace-vr .bad  { color:#f08a8a; font-weight:bold; }
  .ace-vr .why  { display:block; font-size:14px; color:#c0b288; margin-top:3px; }
  .ace-vr .foot { margin-top:12px; font-size:14px; color:#b8a78a; }
</style>`;

function verdictFor(row) {
    // ⚠️ AUDIO NOT UNLOCKED IS A DIFFERENT FAULT WITH A DIFFERENT FIX. A browser
    // plays no sound until the person has clicked something on the page. That
    // client is configured perfectly and will still hear silence, and reporting
    // it as a server problem sends the GM to fix the wrong thing entirely.
    if (row.reachCode === "noreply") {
        return { cls: "bad", label: "Did not answer",
                 why: row.reachReason };
    }
    if (!row.audioUnlocked) {
        return { cls: "warn", label: "Needs one click",
                 why: `This browser will not play sound until ${row.isGM ? "you click" : "they click"} anywhere on the page. `
                    + `Everything else is fine: ${row.willUse}.` };
    }
    if (row.canReachServer) {
        return { cls: "good", label: "Makes its own audio", why: row.willUse };
    }
    if (String(row.willUse).startsWith("plays audio relayed")) {
        return { cls: "good", label: "Hears the GM's audio",
                 why: row.reachCode === "localhost-elsewhere" || row.reachCode === "nourl"
                    ? "Correct: only the GM's machine talks to the speech server, and the finished audio is sent to this client."
                    : row.reachReason };
    }
    return { cls: "bad", label: "Will hear nothing", why: row.reachReason || row.willUse };
}

export async function openVoiceReadiness() {
    if (!game.user?.isGM) {
        ui.notifications?.warn("Only the GM can run the voice readiness check.");
        return;
    }

    ui.notifications?.info("Asking every connected client… this takes a few seconds.");
    const { checkEveryClient, localServerUrl } = await import("./tts-local.mjs");
    const rows = await checkEveryClient();

    let provider = "elevenlabs";
    try { provider = game.settings.get(MODULE_ID, "voiceProvider") || "elevenlabs"; } catch (_) { /* default */ }

    const bad  = rows.filter(r => verdictFor(r).cls === "bad").length;
    const warn = rows.filter(r => verdictFor(r).cls === "warn").length;

    const body = rows.map(r => {
        const v = verdictFor(r);
        return `<tr>
            <td class="who">${foundry.utils.escapeHTML(r.userName)}${r.isGM ? '<span class="gmtag">GM</span>' : ""}</td>
            <td><span class="${v.cls}">${v.label}</span><span class="why">${foundry.utils.escapeHTML(v.why || "")}</span></td>
        </tr>`;
    }).join("");

    const headline = bad
        ? `<span class="bad">${bad} ${bad === 1 ? "person" : "people"} will not hear voices.</span>`
        : warn
        ? `<span class="warn">Everyone is set up correctly. ${warn} ${warn === 1 ? "client needs" : "clients need"} a single click to unmute the browser.</span>`
        : `<span class="good">Every connected client will hear NPC voices.</span>`;

    const content = `${CSS}
    <div class="ace-vr">
      <h3>Will the table hear it?</h3>
      <p class="sub">Voice provider: <strong>${foundry.utils.escapeHTML(provider)}</strong>${
        provider === "localserver" ? ` &middot; server: <strong>${foundry.utils.escapeHTML(localServerUrl() || "not set")}</strong>` : ""
      }</p>
      <p style="margin:0 0 12px;">${headline}</p>
      <table>
        <thead><tr><th>Who</th><th>What happens when an NPC speaks</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <p class="foot">
        Only the GM's machine talks to a local speech server. Players are sent the finished
        audio over Foundry's own connection, so they need nothing installed and nothing open.
        A player shown as "hears the GM's audio" is correctly set up.
      </p>
    </div>`;

    new Dialog({
        title: "ACE Engine — Voice Readiness",
        content,
        buttons: {
            again: {
                icon: '<i class="fas fa-rotate"></i>',
                label: "Check Again",
                callback: () => openVoiceReadiness(),
            },
            close: { icon: '<i class="fas fa-check"></i>', label: "Done" },
        },
        default: "close",
    }, { width: 620 }).render(true);
}
