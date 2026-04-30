// ─── ACE: Engine — Connection-Failure Dialog ──────────────────────────────
// When an AI call fails with a network/CORS error, show a friendly dialog
// with action buttons instead of a scary red banner.
//
// The dialog only fires once per session — repeated failures bump a quiet
// chat-only notification rather than re-popping the modal. This prevents the
// user from getting spammed mid-bio if 30 NPCs are queued.

const MODULE_ID = "ace-engine";

let _ollamaDownShownThisSession = false;
let _genericDownShownThisSession = false;

/**
 * Show the friendly Ollama-down dialog with action buttons.
 *
 * @param {object} opts
 * @param {string} opts.message — preformatted error to show in the dialog body
 * @param {string} [opts.url]   — the URL that failed, for diagnostics
 */
export function showOllamaDownDialog({ message, url } = {}) {
    if (_ollamaDownShownThisSession) {
        ui.notifications?.warn(`Ollama still unreachable at ${url || "configured URL"} — see the dialog from earlier this session.`);
        return;
    }
    _ollamaDownShownThisSession = true;

    const origin = window.location.origin;

    const content = `
        <style>
            .ace-down-dialog .down-body { padding: 6px 4px 12px; line-height: 1.55; color: #d8cdb6; }
            .ace-down-dialog .down-headline { color: #e5b94a; font-weight: 700; font-size: 15px; margin: 0 0 8px; }
            .ace-down-dialog .down-error { background: rgba(200, 60, 60, 0.10); border: 1px solid rgba(200, 60, 60, 0.40); color: #e87070; padding: 8px 12px; border-radius: 4px; font-family: "Rajdhani", monospace; font-size: 12px; margin: 8px 0; white-space: pre-wrap; }
            .ace-down-dialog .down-section { margin: 12px 0 4px; }
            .ace-down-dialog .down-section-title { color: #ffd878; font-weight: 700; font-size: 13px; margin-bottom: 4px; letter-spacing: 0.05em; text-transform: uppercase; }
            .ace-down-dialog .down-section ul { margin: 4px 0 0; padding-left: 18px; }
            .ace-down-dialog .down-section li { margin: 4px 0; color: #c9b890; font-size: 13px; }
            .ace-down-dialog code { background: rgba(0, 0, 0, 0.4); padding: 1px 6px; border-radius: 3px; color: #ffd878; font-size: 12px; }
        </style>
        <div class="ace-down-dialog">
            <div class="down-body">
                <p class="down-headline"><i class="fa-solid fa-plug-circle-xmark"></i> Ollama isn't responding</p>
                <p>ACE tried to reach your local Ollama server and got no response. Pick the action below that matches your situation — or click <strong>Open Settings</strong> to switch to a cloud provider.</p>
                <div class="down-error">${_esc(message || "Connection failed.")}</div>

                <div class="down-section">
                    <div class="down-section-title">Common causes</div>
                    <ul>
                        <li><strong>Ollama isn't running</strong> — open the Ollama app from Start menu, or run <code>ollama serve</code> in a terminal</li>
                        <li><strong>CORS blocking</strong> — set environment variable <code>OLLAMA_ORIGINS=${_esc(origin)}</code> (or <code>OLLAMA_ORIGINS=*</code>) at the system level, then restart Ollama AND Foundry</li>
                        <li><strong>Model not pulled</strong> — run <code>ollama pull llama3.2</code> (or whatever model you've configured)</li>
                        <li><strong>Wrong URL in settings</strong> — should be <code>http://localhost:11434</code> unless you've moved Ollama elsewhere</li>
                    </ul>
                </div>
            </div>
        </div>
    `;

    const buttons = {
        install: {
            icon: '<i class="fa-solid fa-download"></i>',
            label: "Install Ollama",
            callback: () => {
                window.open("https://ollama.com/download", "_blank", "noopener,noreferrer");
                _ollamaDownShownThisSession = false;  // let user retry after install
            },
        },
        settings: {
            icon: '<i class="fa-solid fa-sliders"></i>',
            label: "Open Settings",
            callback: async () => {
                try {
                    const { AceConfigPanel } = await import("./config-panel.mjs");
                    new AceConfigPanel().render(true);
                } catch (e) {
                    console.warn(`${MODULE_ID} | Couldn't open config panel:`, e);
                    // Fallback: open Foundry's standard settings
                    if (game.settings?.sheet) game.settings.sheet.render(true);
                }
                _ollamaDownShownThisSession = false;
            },
        },
        retry: {
            icon: '<i class="fa-solid fa-rotate-right"></i>',
            label: "Try Again Later",
            callback: () => {
                _ollamaDownShownThisSession = false;
            },
        },
    };

    new Dialog({
        title: "ACE Engine — Ollama Connection Failed",
        content,
        buttons,
        default: "settings",
        close: () => { /* user dismissed — keep one-shot guard active for this session */ },
    }, {
        width: 540,
        resizable: false,
        classes: ["ace-engine", "ace-setup-dialog"],
    }).render(true);
}

/**
 * Show a generic connection-failure toast for non-Ollama providers (OpenAI,
 * Anthropic, etc.). Cloud providers usually fail because of an invalid key
 * or rate limit, both of which the underlying error message already explains.
 */
export function showCloudProviderFailureToast(providerName, message) {
    if (_genericDownShownThisSession) {
        // Throttle: don't spam if multiple bios fire in a row
        return;
    }
    _genericDownShownThisSession = true;
    setTimeout(() => { _genericDownShownThisSession = false; }, 30_000);

    ui.notifications?.error(`ACE Engine — ${providerName}: ${message}. Open module settings to check your API key and model.`, { permanent: false });
}

/**
 * Reset the once-per-session guard. Called when the user successfully tests
 * a connection or saves settings — so a future failure can re-show the
 * dialog instead of being suppressed.
 */
export function resetConnectionDialogGuards() {
    _ollamaDownShownThisSession = false;
    _genericDownShownThisSession = false;
}

function _esc(s) {
    return String(s ?? "")
        .replace(/&/g,  "&amp;")
        .replace(/</g,  "&lt;")
        .replace(/>/g,  "&gt;")
        .replace(/"/g,  "&quot;")
        .replace(/'/g,  "&#39;");
}
