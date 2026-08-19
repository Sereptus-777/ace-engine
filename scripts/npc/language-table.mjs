/**
 * ACE: Engine — SPOKEN LANGUAGE TABLE
 * ─────────────────────────────────────────────────────────────────────────────
 * One row per fantasy tongue: which real-world language it SOUNDS like when an
 * NPC speaks it aloud to someone who cannot understand it.
 *
 * Editable because the shipped defaults deliberately take no position on
 * anyone — Abyssal, Infernal, Orc and Deep Speech default to INVENTED sounds
 * rather than a living nation's language. A GM who wants Abyssal to sound like
 * Spanish can set it here: their world, their call, and the module is not
 * making that statement on their behalf. (Johnny 2026-08-07.)
 *
 * ⚠️ DARK PANEL, LIGHT TEXT. Foundry's default form background is light
 * parchment, on which ACE's cream (#f0e4c0) is invisible. Everything below sits
 * inside an explicitly dark container so the brand colours work. Body text is
 * 16px minimum — this pops over Foundry's own chrome, where the suite's
 * standing rule is that anything smaller is not shippable.
 */

import * as Lang from "./language-barrier.mjs";

const MODULE_ID = "ace-engine";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class AceLanguageTable extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "ace-language-table",
        tag: "form",
        window: {
            title: "ACE — What Foreign Tongues Sound Like",
            icon: "fas fa-language",
            resizable: true,
        },
        position: { width: 620, height: 720 },
        form: {
            handler: AceLanguageTable.#onSubmit,
            closeOnSubmit: true,
        },
        actions: {
            resetAll: AceLanguageTable.#onResetAll,
        },
    };

    static PARTS = {
        body: { template: "modules/ace-engine/templates/language-table.html" },
    };

    async _prepareContext() {
        const map = Lang.spokenMap();
        const options = Object.entries(Lang.TTS_LANGUAGES)
            .map(([key, label]) => ({ key, label }));

        const rows = Lang.mappableLanguages().map(l => {
            const current = map[l.key] ?? "invented";
            return {
                key: l.key,
                label: l.label,
                isDefault: current === (Lang.DEFAULT_SPOKEN_MAP[l.key] ?? "invented"),
                options: options.map(o => ({ ...o, selected: o.key === current })),
            };
        });

        return {
            rows,
            enabled: Lang.substitutionEnabled(),
            ttsNote: "Your voice engine speaks these 28 languages. Anything set to "
                   + "“Invented” is spoken as consistent made-up words instead.",
        };
    }

    /** Save only what DIFFERS from the shipped default, so the defaults can be
     *  improved later without silently overriding a GM who never touched a row. */
    static async #onSubmit(_event, _form, formData) {
        const data = formData.object ?? {};
        const out = {};
        for (const [key, value] of Object.entries(data)) {
            if (!key.startsWith("lang.")) continue;
            const langKey = key.slice(5);
            const chosen = String(value || "invented");
            if (chosen !== (Lang.DEFAULT_SPOKEN_MAP[langKey] ?? "invented")) out[langKey] = chosen;
        }
        await game.settings.set(MODULE_ID, "spokenLanguageMap", out);
        const n = Object.keys(out).length;
        ui.notifications?.info(n
            ? `ACE: ${n} language sound${n === 1 ? "" : "s"} customised.`
            : "ACE: language sounds back to the shipped defaults.");
    }

    static async #onResetAll() {
        await game.settings.set(MODULE_ID, "spokenLanguageMap", {});
        ui.notifications?.info("ACE: language sounds reset to defaults.");
        this.render();
    }
}
