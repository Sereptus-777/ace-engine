// ─── The voice map, on screen ────────────────────────────────────────────────
//
// One row per voice your world actually uses, showing who speaks with it and
// which local voice stands in. The GM changes any of them and saves.
//
// ⚠️ IT SHOWS WHO USES EACH VOICE, not just an opaque id. A row reading
// "o3hzbFqcuIw2MRzP8rQf -> am_adam" is unreviewable; a row reading "Strahd,
// Rahadin, Escher" is a decision somebody can actually make.
const MODULE_ID = "ace-engine";

const CSS = `
<style>
  .ace-vm { background:#0f0f11; border:1px solid #6b5a2a; border-radius:6px;
            padding:14px; color:#e8e0cc; font-size:16px; line-height:1.5;
            max-height:60vh; overflow-y:auto; }
  .ace-vm h3 { font-size:19px; color:#d4af37; margin:0 0 4px; }
  .ace-vm .sub { font-size:14px; color:#b8a78a; margin:0 0 12px; }
  .ace-vm table { width:100%; border-collapse:collapse; }
  .ace-vm th { text-align:left; font-size:14px; text-transform:uppercase;
               letter-spacing:0.05em; color:#b8a78a; border-bottom:1px solid #3a3320;
               padding:6px 8px; position:sticky; top:0; background:#0f0f11; }
  .ace-vm td { padding:8px; border-bottom:1px solid #26221a; vertical-align:middle; font-size:16px; }
  .ace-vm .who { color:#f0e4c0; }
  .ace-vm .idc { font-size:13px; color:#8f8570; }
  .ace-vm select { width:100%; padding:6px 8px; background:#fff; color:#222;
                   border:1px solid #bbb; border-radius:4px; font-size:15px; }
  .ace-vm .g { font-size:13px; color:#b8a78a; }
  .ace-vm .none { color:#e8c96a; }
</style>`;

export async function openVoiceMap() {
    if (!game.user?.isGM) {
        ui.notifications?.warn("Only the GM can edit the voice map.");
        return;
    }

    const { proposeMap, availableVoices, setMapping, autoMap } = await import("./voice-map.mjs");
    const rows = await proposeMap();
    const { names, source } = await availableVoices();

    if (!rows.length) {
        ui.notifications?.info("No creature in this world has a voice assigned yet, so there is nothing to map.");
        return;
    }

    const options = (selected) => names.map(n =>
        `<option value="${foundry.utils.escapeHTML(n)}"${n === selected ? " selected" : ""}>${foundry.utils.escapeHTML(n)}</option>`
    ).join("");

    const body = rows.map(r => `
        <tr>
          <td>
            <div class="who">${r.users.length ? foundry.utils.escapeHTML(r.users.join(", ")) : '<span class="none">nobody is using it</span>'}</div>
            <div class="idc">${foundry.utils.escapeHTML(r.voiceId)} &middot; <span class="g">${r.gender}</span></div>
          </td>
          <td style="width:220px;">
            <select data-voice-id="${foundry.utils.escapeHTML(r.voiceId)}">
              ${options(r.current || r.proposed)}
            </select>
          </td>
        </tr>`).join("");

    const content = `${CSS}
    <div class="ace-vm">
      <h3>Voice Map</h3>
      <p class="sub">
        Which local voice stands in for each of your ElevenLabs voices.
        Your ElevenLabs ids are never changed &mdash; switch the provider back and every
        original voice returns. Voice list from ${foundry.utils.escapeHTML(source)}.
      </p>
      <table>
        <thead><tr><th>Who speaks with it</th><th>Local voice</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;

    new Dialog({
        title: "ACE Engine — Voice Map",
        content,
        buttons: {
            auto: {
                icon: '<i class="fas fa-wand-magic-sparkles"></i>',
                label: "Fill the blanks",
                // ⚠️ Fills only what has no choice yet. A GM who hand-picked a
                // voice for Strahd must be able to press this after adding NPCs
                // without losing it, or they will never press it twice.
                callback: async () => { await autoMap(); openVoiceMap(); },
            },
            save: {
                icon: '<i class="fas fa-floppy-disk"></i>',
                label: "Save",
                callback: async (html) => {
                    const root = html?.[0] ?? html;
                    let saved = 0;
                    for (const sel of root.querySelectorAll("select[data-voice-id]")) {
                        if (await setMapping(sel.dataset.voiceId, sel.value)) saved++;
                    }
                    ui.notifications?.info(`ACE: saved ${saved} voice mapping(s).`);
                },
            },
            close: { icon: '<i class="fas fa-xmark"></i>', label: "Cancel" },
        },
        default: "save",
    }, { width: 640 }).render(true);
}
