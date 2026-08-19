// ============================================================
// ACE — AI Campaign Engine — Settings Registration
// ============================================================

import { MODULE_ID }      from "./ace-engine.mjs";
import { AceConfigPanel } from "./config-panel.mjs";
import { AceLanguageTable } from "./npc/language-table.mjs";

// ── First-page settings visibility ──────────────────────────
// Settings whose keys are in this set stay visible on Foundry's standard
// Configure Settings page. Everything else lives in the popup config panel.
//
// As of the 2026-05-01 settings cleanup, AI provider / API key / URL / model
// are EDITABLE only inside the popup config panel — the main page just
// displays the active provider + model (read-only) and a Test Connection
// button. This was a deliberate choice to stop edits in two places from
// fighting each other (e.g. switching provider → URL/key auto-sync running
// twice and corrupting state). The main-page UI is injected by
// AceSettings.injectMainPageStatus() further down — see that hook.
const VISIBLE_IN_MAIN_CONFIG = new Set([
    "moduleEnabled",   // master on/off — quick reach, only editable thing on main page
    "gameRulesEdition", // 5e ruleset toggle (2014 / 2024 / Auto) — strategic launch setting
]);

const DEFAULT_SYSTEM_PROMPT = `You are ACE, an expert AI Game Master assistant for tabletop RPGs running in Foundry VTT.

Your role:
- Help the GM run the game in real time
- Give answers grounded in the current scene context (tokens, HP/wounds, conditions, initiative)
- Reference NPC memory and history when available
- Suggest dramatic moments, consequences, and narrative beats
- Answer rules questions accurately for the game system in use
- Evaluate encounter difficulty and suggest adjustments
- Stay in-world and atmospheric — match the tone of the campaign
- Be concise but evocative. The GM is mid-session and needs quick, actionable answers.

When given scene context, USE IT. Reference specific characters by name, note their conditions, and factor in the tactical situation.

## REFERENCE DATA
- REFERENCE LIBRARY and STRUCTURED REFERENCE DATA sections contain content already extracted from the GM's documents. Use it directly — NEVER say "let me retrieve the file" or "give me a moment to access the PDF."
- For published content (official modules, adventures), also use your training knowledge to fill gaps.
- If neither reference data nor your training covers the question, say so honestly.

## EDITION CONFLICTS
- When sources contain conflicting stats or rules from different editions (e.g. AD&D THAC0 vs 5E attack bonuses, descending AC vs ascending AC), ALWAYS use the newest edition (5th Edition / 5E) stats.
- GM session notes and campaign-specific content ALWAYS override published sourcebooks.
- If you notice an edition conflict, briefly mention it so the GM can decide.

## RESPONSE FORMAT — Narration vs GM Notes
When your response includes atmospheric prose the GM might want to read aloud to players, separate it clearly:

**[NARRATION]**
Write vivid, player-facing prose here — second person, present tense, sensory detail. This is what the GM speaks at the table. No mechanics, no meta-commentary. Keep it 2-4 sentences.
**[/NARRATION]**

Everything outside the [NARRATION] tags is your GM-only advice: tactical suggestions, rules references, options to consider, consequences to prepare for. Keep this concise and actionable.

Not every response needs a [NARRATION] block — only include one when the GM's question naturally calls for read-aloud text (scene descriptions, transitions, NPC dialogue, atmosphere). For pure rules questions, tactical advice, or meta-discussion, skip the tags entirely.

Format responses with light markdown for readability. Use bold for key terms, names, and rules. Keep responses focused — a few paragraphs max unless the GM asks for detail.

## FORMATTING RULES
- Use COMPACT spacing — no extra blank lines between headers, bullets, or paragraphs.
- One blank line before a heading, zero blank lines between a heading and its first bullet/paragraph.
- Bullet lists should have NO blank lines between items.
- Keep the response dense and readable — screen space is precious in a game panel.`;

export class AceSettings {
  static register() {
    // Default config:false — only the keys in VISIBLE_IN_MAIN_CONFIG show up on
    // Foundry's standard Configure Settings page. Settings can still override
    // this via explicit `config: ...` in their own data block (used for
    // hidden internal stores like factionRegistry, voiceLibraryCache, etc.).
    const s = (key, data) =>
      game.settings.register(MODULE_ID, key, {
        scope: "world",
        config: VISIBLE_IN_MAIN_CONFIG.has(key),
        ...data,
      });

    // ══════════════════════════════════════════════════════════════════════
    //  🔴 SECRETS ARE CLIENT-SCOPED. THE WORLD-SCOPED ONES LEAK (2026-08-18)
    //
    //  The `s()` helper above defaults every setting to scope:"world" — and a
    //  world-scoped setting is PUSHED TO EVERY CONNECTED CLIENT. So `apiKey`,
    //  `chatApiKey`, `digestApiKey` and `apiKeysByProvider` were all readable
    //  by any player, from their own console, with one line:
    //
    //      game.settings.get("ace-engine", "apiKey")
    //
    //  A paying GM's Anthropic or OpenAI balance was spendable by anyone at
    //  their table. The ElevenLabs key was already client-scoped for exactly
    //  this reason (see the note further down) — the cloud keys were missed.
    //
    //  ⚠️ WHY NEW KEY NAMES INSTEAD OF FLIPPING `scope`. Flipping the scope on
    //  the existing name leaves the old VALUE sitting in the world settings
    //  database, where Foundry keeps broadcasting it whether we still register
    //  it or not. The only way to stop the leak is to keep the world-scoped
    //  registration alive so we can BLANK it, and put the live secret under a
    //  new client-scoped name. Migration below does exactly that, once, GM-side.
    // ══════════════════════════════════════════════════════════════════════
    for (const secure of ["apiKeySecure", "chatApiKeySecure", "digestApiKeySecure"]) {
      game.settings.register(MODULE_ID, secure, {
        scope: "client", config: false, type: String, default: "",
      });
    }
    game.settings.register(MODULE_ID, "apiKeysByProviderSecure", {
      scope: "client", config: false, type: Object, default: {},
    });

    // ── "Open Configuration" menu button ──────────────────────────
    // Sits at the top of the module's settings section, opens the popup
    // config panel where every other setting lives.
    game.settings.registerMenu(MODULE_ID, "openConfigPanel", {
      name:       "ACE Engine — Configuration Panel",
      label:      "Open Configuration",
      hint:       "Open the full configuration panel — AI provider, voice, NPC chat, combat, memory, documents, and more.",
      icon:       "fas fa-sliders-h",
      type:       AceConfigPanel,
      restricted: true,
    });

    // ── SPOKEN LANGUAGE SUBSTITUTION ────────────────────────
    // Polyglot scrambles TEXT; nothing scrambles AUDIO. Without this, an NPC
    // speaking a tongue the party cannot follow still had the line read aloud
    // in plain English and the barrier leaked through their ears.
    s("spokenLanguageSubstitution", {
      name: "ACE Engine — Speak foreign tongues aloud",
      hint: "When an NPC speaks a language the listener does not know, the voice says it in a real-world stand-in language (Elvish sounds like Finnish, and so on) instead of reading it aloud in English. The chat log still carries the English meaning, so a character who genuinely knows the language can read it.",
      type: Boolean,
      default: true,
    });
    // The GM's edits, laid over the shipped defaults. Object rather than a
    // string so a partial map is legal — an unedited tongue keeps its default.
    s("spokenLanguageMap", { scope: "world", config: false, type: Object, default: {} });

    // ── RE-VOICE THE GM'S PUPPET LINES ──────────────────────────────────
    s("revoicePuppetLines", {
      name: "ACE Engine — Re-voice my NPC lines",
      hint: "When you speak as an NPC, run your line through the AI first so it is delivered in that character's rhythm and tone. Your meaning and length are kept — it re-voices, it does not rewrite. Start a line with a quote mark (\") to say it exactly as typed, with no AI and no delay.",
      type: Boolean,
      default: true,
    });

    game.settings.registerMenu(MODULE_ID, "openLanguageTable", {
      name:       "ACE Engine — Spoken Language Table",
      label:      "Edit Language Sounds",
      hint:       "Choose which real-world language each fantasy tongue sounds like when spoken aloud.",
      icon:       "fas fa-language",
      type:       AceLanguageTable,
      restricted: true,
    });

    // ── Module Master Switch ────────────────────────────────
    s("moduleEnabled", {
      name: "ACE Engine — Enabled",
      hint: "Master on/off switch for the entire module. When OFF, Engine's panel, AI calls, digest/vault/reputation engines, and all subsystems are skipped. Requires a world reload to take effect.",
      type: Boolean,
      default: true,
    });

    // ── Game Rules Edition (mirror of ace-qol's same setting) ──
    // Strategic launch toggle that drives every edition-aware feature
    // (class abilities, magic items, feats with different mechanics in
    // 2014 vs 2024 5e). ace-qol is the source of truth for combat
    // mechanics; ace-engine registers its own copy so the user sees the
    // toggle when they open ACE Engine settings too. Both default to
    // "auto" so a fresh install picks the right edition automatically
    // from each actor's class items.
    s("gameRulesEdition", {
      name: "D&D 5e Rules Edition",
      hint: "Which 5e ruleset ACE should follow for narration, NPC behavior, and rules references. Default: Auto — detect per-actor from class items. Mirror this with the same setting in ACE QOL for full consistency.",
      type: String,
      choices: {
        auto:   "Auto — detect per actor from their class items (recommended)",
        "2014": "2014 Rules (original 5e Player's Handbook)",
        "2024": "2024 Rules (new Player's Handbook / One D&D)",
      },
      default: "auto",
    });

    // ── AI Provider ─────────────────────────────────────────
    s("aiProvider", {
      name: "AI Provider",
      hint: "Which AI service ACE talks to. 🆓 = local + free, 💰 = cloud paid, 💰🆓 = cloud with free tier or free models. Setting this picks the matching default URL and model below.",
      type: String,
      choices: {
        ollama:     "🆓 Ollama — Local, FREE (requires install)",
        lmstudio:   "🆓 LM Studio — Local, FREE (requires install)",
        openrouter: "💰🆓 OpenRouter — many models, free + paid",
        openai:     "💰🆓 OpenAI / ChatGPT — paid, free tier available",
        anthropic:  "💰 Anthropic (Claude) — paid",
        custom:     "⚙ Custom OpenAI-Compatible endpoint",
      },
      default: "ollama",
      // Auto-sync URL + Model to the new provider's defaults. Fires whenever
      // the provider value is saved — main page, panel, console, doesn't
      // matter. Customized URLs/models (anything NOT in the known-defaults
      // list) are preserved so power users don't get clobbered.
      onChange: async (newProvider) => {
        try {
          const defaults = AceSettings.PROVIDER_DEFAULTS[newProvider];
          if (!defaults) return;

          // Known defaults across all providers — any current value matching
          // these is treated as "unedited", safe to swap.
          const knownUrls   = Object.values(AceSettings.PROVIDER_DEFAULTS).map(d => d.apiUrl);
          const knownModels = Object.values(AceSettings.PROVIDER_DEFAULTS).map(d => d.modelName);

          const currentUrl   = game.settings.get(MODULE_ID, "apiUrl") || "";
          const currentModel = game.settings.get(MODULE_ID, "modelName") || "";

          const updates = [];
          if (!currentUrl || knownUrls.includes(currentUrl)) {
            await game.settings.set(MODULE_ID, "apiUrl", defaults.apiUrl);
            updates.push(`URL → ${defaults.apiUrl}`);
          }
          if (!currentModel || knownModels.includes(currentModel)) {
            await game.settings.set(MODULE_ID, "modelName", defaults.modelName);
            updates.push(`Model → ${defaults.modelName}`);
          }

          // ── Also retarget the digest extraction model ──────────────────
          // Digest is a separate model setting (cheap/fast extractor). When
          // the user switches to a local provider, the previously-configured
          // cloud digest will silently fail (wrong key/route). Auto-retarget
          // to a same-provider default — but ONLY if current is a known
          // default we recognize. Custom digest selections are preserved.
          const KNOWN_DIGEST_DEFAULTS = new Set([
            "",  // empty = use main, always safe to retarget
            "openai:gpt-4o-mini",
            "openai:gpt-4.1-nano",
            "openai:gpt-4.1-mini",
            "openai:gpt-4o",
            "anthropic:claude-haiku-4-5-20251001",
            "anthropic:claude-sonnet-4-20250514",
            "ollama:qwen2.5-coder:32b",
            "ollama:qwen2.5:14b",
            "ollama:llama3.1",
          ]);
          const currentDigest = game.settings.get(MODULE_ID, "digestModel") || "";
          if (KNOWN_DIGEST_DEFAULTS.has(currentDigest)) {
            const newDigestByProvider = {
              openai:     "openai:gpt-4o-mini",
              anthropic:  "anthropic:claude-haiku-4-5-20251001",
              openrouter: "openai:gpt-4o-mini",  // OR has GPT-4o Mini; cheapest cross-provider digest
              ollama:     "ollama:llama3.1",
              lmstudio:   "",                    // LM Studio uses main
              custom:     "",
            };
            const newDigest = newDigestByProvider[newProvider] ?? "";
            if (newDigest !== currentDigest) {
              await game.settings.set(MODULE_ID, "digestModel", newDigest);
              updates.push(`Digest → ${newDigest || "(use main)"}`);
            }
          }

          if (updates.length) {
            ui.notifications?.info(`ACE Engine — provider changed to ${newProvider}: ${updates.join(", ")}`);
          }
        } catch (err) {
          console.warn("ACE: Engine | aiProvider onChange auto-sync failed:", err);
        }
      },
    });

    s("apiKey", {
      name: "API Key",
      hint: "Your provider's API key. Required for cloud providers (OpenAI, Anthropic, OpenRouter). Leave blank for local models (Ollama, LM Studio). Stored as a password and only visible to the GM.",
      type: String,
      default: "",
    });

    // Per-provider API key vault (Phase: settings cleanup, 2026-05-01).
    //
    // Maps providerId → API key, e.g. { anthropic: "sk-ant-...", openai: "sk-..." }.
    // The visible API Key field in the config panel always shows the key for
    // the CURRENTLY-SELECTED provider. When the GM switches provider in the
    // panel, the previous provider's key is stashed here and the new one's
    // key is loaded into the field. This stops "I just switched provider but
    // the field still has the old key" confusion.
    //
    // The single `apiKey` setting above is still the source of truth for
    // every consumer (testConnection, getProviderConfig, ai-provider.mjs etc.)
    // — they all read `apiKey`, which always equals the active provider's
    // key. This map is supplementary storage for the panel's swap logic.
    //
    // First-open migration (one-time, silent): if this map is empty but
    // `apiKey` is set, seed the map with `apiKeysByProvider[currentProvider]
    // = apiKey` so existing setups don't lose their saved key on upgrade.
    game.settings.register(MODULE_ID, "apiKeysByProvider", {
      scope:  "world",
      config: false,
      type:   Object,
      default: {},
    });

    s("apiUrl", {
      name: "API Endpoint URL",
      hint: "The HTTP endpoint your AI provider listens on. Pick from the dropdown for standard hosts, or set to your own server's address if you're running a local model on a custom port.",
      type: String,
      choices: {
        "https://api.openai.com":      "OpenAI (api.openai.com)",
        "https://api.anthropic.com":   "Anthropic (api.anthropic.com)",
        "https://openrouter.ai/api":   "OpenRouter (openrouter.ai)",
        "http://localhost:11434":      "Ollama Local (localhost:11434)",
        "http://localhost:1234":       "LM Studio Local (localhost:1234)",
      },
      default: "https://api.openai.com",
    });

    // ── User Hardware Profile ─────────────────────────────────────────────
    // GM picks their GPU's VRAM tier; the model list below uses this hint
    // (in the label text) to mark which models will run well on what hardware.
    // Local Ollama models are ALWAYS FREE — no API cost — but require enough
    // VRAM to fit. Paid cloud providers (Claude, OpenAI, OpenRouter) work on
    // any hardware but charge per-token. Pick the tier that matches your GPU.
    s("userGpuVram", {
      name: "Your GPU VRAM (for local-model recommendations)",
      hint: "How much VRAM your GPU has. The AI Model dropdown below uses this hint to mark which local (FREE) models will run well on your hardware. Skip if you're using a cloud provider (Claude / OpenAI / OpenRouter) — those work regardless. Check Task Manager → Performance → GPU → 'Dedicated GPU memory' if unsure.",
      type: String,
      choices: {
        "unknown": "(I don't know / cloud provider only)",
        "<4gb":    "Less than 4 GB (integrated GPU, old laptop)",
        "4-6gb":   "4–6 GB (older or mid-range GPU)",
        "6-10gb":  "6–10 GB (RTX 3060, RTX 4060, etc.)",
        "10-16gb": "10–16 GB (RTX 4070, RTX 3080, etc.)",
        "16-24gb": "16–24 GB (RTX 4080, RTX 3090, etc.)",
        "24gb+":   "24 GB+ (RTX 4090, A6000, etc.)",
      },
      default: "unknown",
    });

    s("modelName", {
      name: "AI Model — Quality / Default (session summaries, bios, lore)",
      hint: "Your QUALITY tier model — used for session summaries, NPC bio generation, long-form lore writing, and any other slow-but-important AI call. Used for NPC chat too unless you override it below with a faster Chat Model. ⭐ = best fit for your VRAM tier. FREE = local Ollama. $/$$ = paid cloud. Match VRAM hint to your GPU — going over what fits will be very slow.",
      type: String,
      choices: {
        // ── Cloud: Anthropic (top narrative quality) ──
        "claude-sonnet-4-20250514":  "$$ ⭐ Claude Sonnet 4 — best narrative (cloud, paid)",
        "claude-haiku-4-5-20251001": "$ Claude Haiku 4.5 — fast + cheap (cloud, paid)",
        // ── Cloud: OpenAI ──
        "gpt-4o":         "$$ GPT-4o — top quality (cloud, paid)",
        "gpt-4o-mini":    "$ ⭐ GPT-4o Mini — fast sweet-spot (cloud, paid)",
        "gpt-4.1":        "$$ GPT-4.1 — latest (cloud, paid)",
        "gpt-4.1-mini":   "$ GPT-4.1 Mini — latest mini (cloud, paid)",
        "gpt-4.1-nano":   "$ GPT-4.1 Nano — cheapest (cloud, paid)",
        // ── Local: Ollama (FREE — runs on your machine) ──
        "llama3.3:70b":       "FREE Llama 3.3 (70B) — needs 40+ GB VRAM (dual GPU or Apple M-series unified)",
        "qwen2.5:32b":        "FREE ⭐ Qwen 2.5 (32B) — needs 20+ GB VRAM — best 24 GB sweet spot",
        "deepseek-r1:32b":    "FREE DeepSeek R1 (32B) — needs 20+ GB VRAM — best reasoning",
        "mistral-nemo:12b":   "FREE ⭐ Mistral Nemo (12B) — needs 10+ GB VRAM — long context, good prose",
        "qwen2.5:14b":        "FREE Qwen 2.5 (14B) — needs 10+ GB VRAM — good balance",
        "deepseek-r1:14b":    "FREE DeepSeek R1 (14B) — needs 10+ GB VRAM — reasoning",
        "llama3.1:8b":        "FREE ⭐ Llama 3.1 (8B) — needs 6+ GB VRAM — sweet spot for mid-range GPUs",
        "gemma2:9b":          "FREE Gemma 2 (9B) — needs 6+ GB VRAM — fast, poetic prose",
        "mistral":            "FREE Mistral (7B) — needs 5+ GB VRAM — classic fast option",
        "llama3.2:3b":        "FREE ⭐ Llama 3.2 (3B) — needs <4 GB VRAM — works on any hardware",
        // ── Local: code-tuned (NOT recommended for narrative) ──
        "qwen2.5-coder:32b":  "FREE Qwen 2.5 Coder (32B) — code-tuned, stiff for narrative — use qwen2.5:32b instead",
        // ── OpenRouter (pay per token, no API key juggling) ──
        "openai/gpt-4o":                       "OpenRouter → GPT-4o",
        "openai/gpt-4o-mini":                  "OpenRouter → GPT-4o Mini",
        "anthropic/claude-sonnet-4-20250514":  "OpenRouter → Claude Sonnet 4",
        "google/gemini-2.0-flash-001":         "OpenRouter → Gemini 2.0 Flash (fast)",
        "meta-llama/llama-3.1-70b-instruct":   "OpenRouter → Llama 3.1 70B",
      },
      default: "gpt-4o-mini",
    });

    // ── Chat Model (separate, FASTER model for NPC conversations) ──
    // v1.6.11: three-tier model split — Chat (this), Quality (modelName
    // above), and Digest (digestModel below). Each tier can use its own
    // model so a GM can run e.g. dolphin3:8b for snappy tavern banter
    // while still using qwen2.5:32b for the meaty session summary.
    s("chatApiKey", {
      name: "Chat API Key (if different provider)",
      hint: "If your Chat Model uses a different provider than your main Quality model (e.g., Quality = Claude Sonnet, Chat = local Ollama), enter that provider's API key here (or leave blank for Ollama since local doesn't need a key). Leave blank to use your main API key. Stored as a password.",
      type: String,
      default: "",
    });

    // Chat model: "provider:model" format so we know which API to call.
    // Empty string = use main provider + Quality model (no override).
    // Parsed by AIHandler.getResponse via _resolveChatProvider().
    s("chatModel", {
      name: "Chat Model — NPC Conversations (speed-tier)",
      hint: "Optional FAST model dedicated to real-time NPC chat. Empty = use your main Quality model for chat too. The Chat tier should prioritize SPEED over depth — sub-2-second responses feel natural in dialogue; 30-second waits don't. Set a smaller / faster model here while keeping your Quality model untouched for session summaries.",
      type: String,
      choices: {
        "":                                                            "— Same as main Quality model —",
        // ── OpenRouter free tier (no credit card, rate-limited) ──
        "openrouter:meta-llama/llama-3.3-70b-instruct:free":           "⭐ OpenRouter: Llama 3.3 70B (FREE, strong narrative)",
        "openrouter:deepseek/deepseek-chat-v3:free":                   "OpenRouter: DeepSeek V3 (FREE, strong reasoning)",
        "openrouter:google/gemma-3-27b-it:free":                       "OpenRouter: Gemma 3 27B (FREE, Google open-source)",
        // ── OpenRouter paid premium ──
        "openrouter:anthropic/claude-haiku-4-5":                       "OpenRouter: Claude Haiku 4.5 (paid, premium)",
        "openrouter:openai/gpt-4o-mini":                               "OpenRouter: GPT-4o Mini (paid, cheap)",
        // ── Local Ollama (FREE, runs on your GPU) ──
        "ollama:dolphin3:8b":                                          "Ollama: Dolphin 3 8B (free, uncensored, slow on most hardware)",
        "ollama:llama3.1:8b":                                          "Ollama: Llama 3.1 8B (free, family-friendly)",
        "ollama:mistral-nemo:12b":                                     "Ollama: Mistral Nemo 12B (free, richer prose)",
        "ollama:llama3.2:3b":                                          "Ollama: Llama 3.2 3B (free, smallest)",
        // ── Cloud Anthropic ──
        "anthropic:claude-haiku-4-5-20251001":                         "⭐ Anthropic: Claude Haiku 4.5 (paid, sub-second, premium)",
        // ── Cloud OpenAI ──
        "openai:gpt-4o-mini":                                          "OpenAI: GPT-4o Mini (paid, fast + cheap)",
        "openai:gpt-4.1-nano":                                         "OpenAI: GPT-4.1 Nano (paid, cheapest)",
      },
      default: "",
    });

    // ── Digest Model (separate, cheaper model for bulk extraction) ──
    // ── Secondary API Key (for digest extraction on a different provider) ──
    s("digestApiKey", {
      name: "Digest API Key (if different provider)",
      hint: "If your digest model uses a different provider than your main AI (e.g., main=Anthropic, digest=OpenAI), enter that provider's API key here. Leave blank to use your main API key.",
      type: String,
      default: "",
    });

    // Digest model: "provider:model" format so we know which API to call.
    // Empty string = use main provider + model. Parsed by DigestEngine.
    s("digestModel", {
      name: "Digest Extraction Model",
      hint: "Model used for AI digest extraction (bulk structured data). Use a cheap/fast model here — GPT-4o Mini is ideal (~$0.50 per book). Requires a valid API key for the chosen provider.",
      type: String,
      choices: {
        "":                                                            "— Same as main model —",
        // ── OpenRouter free tier (no card, ~$0/book) ──
        "openrouter:meta-llama/llama-3.3-70b-instruct:free":           "⭐ OpenRouter: Llama 3.3 70B (FREE)",
        "openrouter:deepseek/deepseek-chat-v3:free":                   "OpenRouter: DeepSeek V3 (FREE)",
        // ── OpenAI (cheapest paid for extraction) ──
        "openai:gpt-4o-mini":                                          "⭐ OpenAI: GPT-4o Mini (~$0.50/book) — Best Value",
        "openai:gpt-4.1-nano":                                         "OpenAI: GPT-4.1 Nano (cheapest paid)",
        "openai:gpt-4.1-mini":                                         "OpenAI: GPT-4.1 Mini",
        "openai:gpt-4o":                                               "OpenAI: GPT-4o ($$)",
        // ── Anthropic ──
        "anthropic:claude-haiku-4-5-20251001":                         "Anthropic: Claude Haiku 4.5 (~$4/book)",
        "anthropic:claude-sonnet-4-20250514":                          "Anthropic: Claude Sonnet 4 ($$$)",
        // ── Local (free) ──
        "ollama:qwen2.5-coder:32b":                                    "Ollama: Qwen 2.5 Coder 32B (free)",
        "ollama:qwen2.5:14b":                                          "Ollama: Qwen 2.5 14B (free)",
        "ollama:llama3.1":                                             "Ollama: Llama 3.1 8B (free)",
      },
      default: "",
    });

    // "useEnvoyKeys" removed — sync direction is now Envoy → reads from Engine
    // (see ace-envoy "useAceEngineSettings" toggle instead)

    // ── Game System ─────────────────────────────────────────
    s("gameSystem", {
      name: "Game System",
      hint: "Which TTRPG system this world uses. Leave on Auto-detect to read it from Foundry's installed game system. Pick a specific entry to override (useful for generic/custom systems where you want the AI to assume a familiar ruleset).",
      type: String,
      choices: {
        auto: "Auto-detect from Foundry",
        dnd5e: "D&D 5th Edition",
        pf2e: "Pathfinder 2e",
        pf1e: "Pathfinder 1e",
        dnd4e: "D&D 4th Edition",
        "13a": "13th Age",
        swade: "Savage Worlds",
        coc7e: "Call of Cthulhu 7e",
        wfrp4e: "Warhammer Fantasy 4e",
        fate: "Fate Core / Accelerated",
        pbta: "Powered by the Apocalypse",
        bitd: "Blades in the Dark",
        sw5e: "SW5e (Star Wars 5e)",
        cyberpunkred: "Cyberpunk RED",
        shadowrun: "Shadowrun",
        gurps: "GURPS",
        other: "Other (describe in system prompt)",
      },
      default: "auto",
    });

    // ── Prompt & Behavior ───────────────────────────────────
    s("systemPrompt", {
      name: "System Prompt",
      hint: "The instructions ACE sends to the AI before every conversation. Sets tone, response style, and what role the AI is playing. Edit to customize ACE's voice — keep the [NARRATION] block rules intact for the read-aloud feature to work.",
      type: String,
      default: DEFAULT_SYSTEM_PROMPT,
    });

    s("autoSuggestions", {
      name: "Auto Story Suggestions",
      hint: "When ON, ACE periodically generates story ideas and tactical hints in the background and posts them to the panel's Ideas tab. When OFF, the Ideas tab only fills when you click 'Generate'.",
      type: Boolean,
      default: false,
    });

    s("suggestionInterval", {
      name: "Suggestion Interval (seconds)",
      hint: "How often ACE generates a fresh story idea when Auto Story Suggestions is ON. Default 120 seconds (2 minutes). Lower = more ideas + higher API cost. Only used when Auto Story Suggestions is enabled.",
      type: Number,
      default: 120,
      range: { min: 30, max: 600, step: 10 },
      onChange: () => {
        // Restart subtle roll detection with new interval (no restart needed)
        const mod = game.modules.get(MODULE_ID);
        mod?.api?.getSubtleRolls?.()?.restartAutoDetect?.();
      },
    });

    s("maxContextTokens", {
      name: "Max Context Tokens",
      hint: "How much conversation history rides along with each AI request. Higher = the AI remembers more of a long conversation, but each message costs a little more and takes slightly longer. 7000 matches ACE's long-standing behaviour; raise it for better memory, lower it if you hit rate limits or context errors.",
      type: Number,
      default: 7000,
      range: { min: 500, max: 16000, step: 500 },
    });

    s("maxResponseTokens", {
      name: "Max Response Tokens",
      hint: "Upper limit on how long an AI reply can be. Higher = the AI can write longer narration and more detailed answers; lower = forces concise responses. Default 2048 fits most table-side use.",
      type: Number,
      default: 2048,
      range: { min: 256, max: 8192, step: 256 },
    });

    // ── Feature Toggles ────────────────────────────────────
    s("enableCritFumble", {
      name: "Crit & Fumble Tables",
      hint: "When ON, natural 20s and natural 1s on attack rolls automatically post a flavor message from ACE's crit/fumble tables. When OFF, the dnd5e default behavior is used.",
      type: Boolean,
      default: true,
    });

    s("enableSurvivalTracker", {
      name: "Survival Tracker",
      hint: "When ON, ACE tracks meals consumed and rests taken across the campaign and surfaces this on the panel. Helpful for hexcrawl / wilderness games. When OFF, the survival pane is hidden.",
      type: Boolean,
      default: true,
    });

    s("enableStoryNotes", {
      name: "Story Notes & Memory Log",
      hint: "When ON, ACE keeps a persistent campaign log (kills, crits, scene changes, key narrations) and uses it as memory for future AI calls. Disable only if you want a stateless assistant.",
      type: Boolean,
      default: true,
    });

    s("enableFameSystem", {
      name: "Fame & Reputation",
      hint: "When ON, ACE tracks a fame/reputation score for the party and adjusts NPC reactions, prices, and faction stance accordingly. When OFF, all NPCs treat the party as strangers each time.",
      type: Boolean,
      default: true,
    });

    s("enableNarrativeTime", {
      name: "Narrative Time Advancement",
      hint: "When ON, ACE advances in-world time based on actions taken (rests, travel, scene transitions) and surfaces it on the panel. Useful for tracking timed events. When OFF, time only moves when you set it manually.",
      type: Boolean,
      default: true,
    });

    s("syncSimpleCalendar", {
      name: "Sync with Simple Calendar",
      hint: "When ON and the Simple Calendar module is installed, ACE reads/writes the in-world date through Simple Calendar instead of its own internal clock. Only enable if you use Simple Calendar.",
      type: Boolean,
      default: false,
    });

    // ── Document Library ────────────────────────────────────
    s("enableDocumentLibrary", {
      name: "Document Library",
      hint: "When ON, ACE indexes uploaded PDFs / sourcebooks / notes and makes their content searchable so the AI can quote and reference them in answers. When OFF, the Library tab is hidden and the AI relies on training knowledge only.",
      type: Boolean,
      default: true,
    });

    // docContextBudget is registered once, in the Search Engine section below
    // (default 16000). A duplicate registration here (default 4000) was removed
    // 2026-06-28 — last-registration-wins made this one dead and confusing.

    s("enableVisionImages", {
      name: "Vision Image Captioning",
      hint: "When ON, ACE sends images from your documents to a vision-capable AI model to extract text, tables, and diagram content. Costs extra API credits per page and only works on providers with vision support (GPT-4o, Claude Sonnet 4). Leave OFF for text-only documents.",
      type: Boolean,
      default: false,
    });

    s("autoMergeDigests", {
      name: "Auto-Merge Digests into World Bible",
      hint: "When enabled, digests automatically merge into the World Bible after generation. When disabled, use the manual 'Merge into Bible' button on digested documents. Costs ~$0.50–1.00 per digest in API credits.",
      type: Boolean,
      default: false,
    });

    s("autoLearnToBible", {
      name: "Auto-Learn to World Bible",
      hint: "When enabled, the AI silently extracts locations, NPCs, and factions from every chat response and adds them to the World Bible. This roughly doubles per-message API cost (~$0.01–0.03 extra per message, ~$1–2 per 3-hour session). Disable to save credits and use the manual 'Learn' button on individual messages instead.",
      type: Boolean,
      default: false,
    });

    // Auto Token Art settings moved to module "ace-token-art" (1.0.0+).
    // Settings remain registered briefly below as no-ops so that legacy
    // migration in ace-token-art's init can read them once and copy
    // values over; remove on a future version once everyone has migrated.
    s("tokenArtEnabled",        { scope: "world", config: false, type: Boolean, default: true });
    s("tokenArtFolders",        { scope: "world", config: false, type: Array,   default: ["NPCs", "assets/srd5e/img/bestiary/tokens/MM"] });
    s("tokenArtAutoRename",     { scope: "world", config: false, type: Boolean, default: true });
    s("tokenArtRecentChoices",  { scope: "world", config: false, type: Object,  default: {} });

    // ── ElevenLabs Narration (client-scoped) ────────────────
    // ⚠️ CLIENT SCOPE = BROWSER LOCAL STORAGE, AND NOTHING ELSE (2026-08-06).
    // This is deliberate — world-scoped settings are sent to every connected
    // client, so a world-scoped key would be readable by any player from the
    // console. But it means this box is the ONLY copy, it is per-world (not
    // "all worlds" as the hint used to claim), and it dies with browser
    // storage — taking NPC voices down to robotic browser TTS silently.
    // That is the bug Johnny chased eleven times. The durable answer is
    // modules/ace-engine/config.local.json, which lives on the server, wins
    // over this setting, and is gitignored. The hint now says so.
    // ── Which microphone NPC-chat voice input listens to (client-scoped) ──
    // Set from the dropdown beside the mic button in the conversation window;
    // stored per browser because the device list is per machine. Empty = the
    // system default. Johnny 2026-08-06: his default was an Elgato Wave Link
    // VIRTUAL channel carrying no audio (measured peak 2 of 128), so the
    // recogniser listened to silence and looked broken. Anyone with Voicemeeter,
    // OBS or NVIDIA Broadcast can hit the same thing.
    // ── Speaking-portrait listing, same pattern as the sounds (2026-08-07) ──
    // The old probe created an <img> per candidate and let it 404, which put
    // three red errors in every player's console every time a conversation
    // opened. Foundry forbids players from listing files, so they cannot check
    // first — the GM publishes the folder's contents here and everyone reads it.
    s("speakingWebpIndex", {
      scope: "world",
      config: false,
      type: Object,
      default: {},
    });

    // ── The creature-sound index, resolved ONCE and shared (2026-08-07) ──
    // Foundry forbids players from listing files at all:
    //   "You do not have permission to browse the host file system!"
    // So every player heard silence, and asking the GM to resolve it at play
    // time only worked when a GM happened to be connected. The GM now walks the
    // folders once and stores the result here, in WORLD data, which every
    // client can read instantly with no permission and no round-trip.
    s("creatureSoundIndex", {
      scope: "world",
      config: false,
      type: Object,
      default: {},
    });

    s("micDeviceId", {
      scope: "client",
      config: false,
      type: String,
      default: "",
    });

    s("elevenLabsApiKey", {
      scope: "client",
      name: "ElevenLabs API Key",
      // ⚠️ DO NOT recommend config.local.json here again. Foundry serves that
      // file over plain HTTP to every connected client, so a key placed in it
      // is readable by any player with a console. This box is client storage:
      // it stays in the GM's browser and is never sent to anyone else.
      hint: "API key from elevenlabs.io. Stored in THIS browser only, for THIS world — clearing browser data erases it and NPC voices drop to browser TTS. Keep it here: it is never sent to your players.",
      type: String,
      default: "",
    });

    s("elevenLabsVoiceId", {
      scope: "client",
      name: "Narrator Voice (Male)",
      hint: "ElevenLabs voice for narration and male NPC speech. Pick a recommended voice or paste a custom Voice ID from elevenlabs.io.",
      type: String,
      choices: {
        "o3hzbFqcuIw2MRzP8rQf": "⭐ Default Narrator (deep, dramatic) — Recommended",
        "j9jfwdrw7BRfcR43Qohk": "Narrator Alt (warm, authoritative)",
        "pNInz6obpgDQGcFmaJgB": "Adam (clear, neutral male)",
        "nPczCjzI2devNBz1zQrb": "Brian (British male)",
        "IKne3meq5aSn9XLyUdCD": "Charlie (casual Australian)",
        "onwK4e9ZLuTAKqWW03F9": "Daniel (deep British)",
        "TX3LPaxmHKxFdv7VOQHJ": "Liam (young American)",
        "JBFqnCBsd6RMkjVDRZzb": "George (warm British)",
      },
      default: "o3hzbFqcuIw2MRzP8rQf",
    });

    s("elevenLabsFemaleVoiceId", {
      scope: "client",
      name: "Narrator Voice (Female)",
      hint: "ElevenLabs voice for female NPC speech. Leave blank to always use the male narrator voice.",
      type: String,
      choices: {
        "":                          "— Use Male Narrator Voice —",
        "EXAVITQu4vr4xnSDxMaL":    "⭐ Sarah (warm, expressive) — Recommended",
        "Xb7hH8MSUJpSbSDYk0k2":    "Alice (British, gentle)",
        "cgSgspJ2msm6clMCkdW9":    "Jessica (American, confident)",
        "pFZP5JQG7iQjIQuC4Bku":    "Lily (British, young)",
      },
      default: "",
    });

    s("narratorVoiceOverrideEnabled", {
      scope: "client",
      name: "Use Custom Narrator Voice ID",
      hint: "Enable this to override the dropdown above with a custom ElevenLabs Voice ID for all narration.",
      type: Boolean,
      default: false,
    });

    s("narratorVoiceOverrideId", {
      scope: "client",
      name: "Custom Narrator Voice ID",
      hint: "Paste any ElevenLabs Voice ID here. Only used when the checkbox above is enabled.",
      type: String,
      default: "",
    });

    s("elevenLabsModel", {
      scope: "client",
      name: "ElevenLabs Model",
      hint: "eleven_multilingual_v2 gives the best quality. eleven_turbo_v2_5 is faster.",
      type: String,
      choices: {
        eleven_multilingual_v2: "Multilingual v2 (best quality)",
        eleven_v3: "v3 (newest — best quality, stability clamped to 0/0.5/1)",
        eleven_turbo_v2_5: "Turbo v2.5 (fast, great quality)",
        eleven_flash_v2_5: "Flash v2.5 (fastest, lowest latency)",
        eleven_monolingual_v1: "Monolingual v1 (English only, classic)",
      },
      default: "eleven_multilingual_v2",
    });

    // ── Narration Volume (client-scoped — players control this) ──
    s("narrationVolume", {
      scope: "client",
      name: "Narration Audio Volume",
      hint: "Volume of narration audio from the GM. Each player sets their own level. 0 = muted, 1.0 = full volume.",
      type: Number,
      default: 0.8,
      range: { min: 0, max: 1, step: 0.05 },
    });

    // ── Voice Provider (NPC chat — moved from ACE: Envoy) ──
    s("voiceProvider", {
      scope: "client",
      name: "NPC Voice Provider",
      hint: "Choose which voice engine to use for NPC speech. ElevenLabs gives premium voices — players don't need their own key; the GM's client generates the audio and streams it to all players. Browser TTS is free, robotic, and offline-only — use it only if no GM is online.",
      type: String,
      choices: {
        elevenlabs: "ElevenLabs (Recommended — GM proxies audio to players)",
        browser:    "Browser TTS (Free, robotic)",
      },
      default: "elevenlabs",
    });

    // ── Browser TTS (client-scoped) ─────────────────────────
    s("browserVoiceName", {
      scope: "client",
      name: "Browser Narrator Voice (Male)",
      hint: "Voice used when ElevenLabs is not configured. Type the exact voice name from your OS. Leave blank for auto-detect.",
      type: String,
      default: "",
    });

    s("browserFemaleVoiceName", {
      scope: "client",
      name: "Browser Narrator Voice (Female)",
      hint: "Female voice for browser TTS. Leave blank for auto-detect (picks best available female voice).",
      type: String,
      default: "",
    });

    s("browserVoiceRate", {
      scope: "client",
      name: "Browser Voice Speed",
      hint: "Narration speed for browser TTS. 1.0 = natural, 1.1 = slightly faster.",
      type: Number,
      default: 1.0,
      range: { min: 0.6, max: 1.5, step: 0.05 },
    });

    s("browserVoicePitch", {
      scope: "client",
      name: "Browser Voice Pitch",
      hint: "Narration pitch for browser TTS. 0.8 = deeper, 1.0 = natural, 1.2 = higher.",
      type: Number,
      default: 0.95,
      range: { min: 0.5, max: 1.5, step: 0.05 },
    });

    // ── Profanity Filter ───────────────────────────────────
    s("profanityFilter", {
      name: "Fantasy Profanity Filter",
      hint: "Replace real-world profanity with fantasy equivalents (xork, skullhole, hag, etc.) and teach the AI to use creative in-world swearing with deity/regional flavor.",
      type: Boolean,
      default: true,
    });

    // ── Debug (client-scoped) ───────────────────────────────
    s("debugMode", {
      scope: "client",
      config: false,
      name: "Debug Mode",
      hint: "When ON, ACE writes detailed logs to the browser console (F12). Useful for troubleshooting and bug reports — leave OFF for normal play.",
      type: Boolean,
      default: false,
    });

    // ── Reputation System ──────────────────────────────────
    s("enableReputation", {
      name: "Enable Reputation / Word-of-Mouth",
      hint: "When enabled, NPCs of the same faction type share information about PC encounters. A goblin that fought the party will warn other goblins.",
      type: Boolean,
      default: true,
    });

    s("enableDispositionTags", {
      name: "AI Disposition Auto-Update",
      hint: "When enabled, if the AI determines an NPC's attitude changes during conversation, the token's disposition ring will update automatically.",
      type: Boolean,
      default: true,
    });

    // ── Subtle Rolls ────────────────────────────────────────
    s("enableSubtleRolls", {
      name: "Subtle Rolls",
      hint: "When ON, certain skill checks (Insight, History, Arcana, etc.) are rolled silently and the result is delivered as AI narration instead of dice numbers. Preserves mystery — players don't know if they rolled a 2 or a 20 on Insight. Disable to use vanilla dnd5e rolls.",
      type: Boolean,
      default: true,
    });

    s("subtleRollSkills", {
      name: "Subtle Roll Skills",
      hint: "Comma-separated list of skill keys (dnd5e short codes) that should trigger a subtle roll instead of a public one. Defaults cover Insight, History, Arcana, Religion, Nature, Perception, Investigation, Survival, Medicine.",
      type: String,
      default: "ins,his,arc,rel,nat,prc,inv,sur,med",
    });

    s("subtleRollAutoDetect", {
      name: "Auto-Detect Subtle Rolls",
      hint: "When ON, ACE watches chat messages for skill checks that match the Subtle Roll Skills list and converts them into narration automatically. When OFF, you must explicitly request a subtle roll from the panel.",
      type: Boolean,
      default: false,
    });

    s("subtleNarrationLength", {
      name: "Subtle Roll Narration Length",
      hint: "How verbose the AI narration is for subtle roll results. Short = 1 sentence, Medium = 2 sentences, Long = 3-5 sentences.",
      type: String,
      choices: { short: "Short (1 sentence)", medium: "Medium (2 sentences)", long: "Long (3-5 sentences)" },
      default: "short",
    });

    // ── Search Engine ──────────────────────────────────────
    s("docContextBudget", {
      name: "Document Context Budget",
      hint: "Maximum characters of document context sent to the AI per query. Higher = more detail but slower/costlier. Default 16000 (~4500 tokens).",
      type: Number,
      default: 16000,
      range: { min: 4000, max: 64000, step: 2000 },
    });

    // ── Internal (hidden) ───────────────────────────────────
    game.settings.register(MODULE_ID, "chatHistory", {
      scope: "client",
      config: false,
      type: Array,
      default: [],
    });

    game.settings.register(MODULE_ID, "setupComplete", {
      scope: "world",
      config: false,
      type: Boolean,
      default: false,
    });

    // Faction intelligence networks — stored as JSON object { factionKey: "none"|"informants"|"extensive"|"omniscient" }
    game.settings.register(MODULE_ID, "factionIntelNetworks", {
      scope: "world",
      config: false,
      type: Object,
      default: {},
    });

    // ── Visual Aids ──────────────────────────────────────────
    s("pcGlow", {
      scope: "client",
      name: "PC Token Glow",
      hint: "Add a subtle colored glow around player character tokens using each player's chosen color. Personal setting — each user controls their own.",
      type: Boolean,
      default: true,
      onChange: () => {
        import("./canvas-highlight.mjs").then(({ CanvasHighlight }) => {
          CanvasHighlight.refreshAllPcGlows?.();
        }).catch(() => {});
      },
    });

    s("attunementPromptEnabled", {
      scope: "world",
      name: "Auto-Prompt for Item Attunement",
      hint: "When a magic item that requires attunement is added to a PC's inventory (drag from compendium, loot, etc.), pop up a dialog offering to attune the item immediately. Honors the RAW 3-item attunement limit. Skips items that don't need attunement, NPCs, and unidentified items.",
      type: Boolean,
      default: true,
    });

    s("pcGlowSize", {
      scope: "client",
      name: "PC Glow Size",
      hint: "Scale the PC token glow disc. 1.00 = slightly larger than the token (default — peeks out as a ring). Drop to 0.50 to make it small enough to fit inside the token's own square. Personal setting — each user controls their own.",
      type: Number,
      default: 1.0,
      range: { min: 0.3, max: 1.5, step: 0.05 },
      onChange: () => {
        import("./canvas-highlight.mjs").then(({ CanvasHighlight }) => {
          CanvasHighlight.refreshAllPcGlows?.();
        }).catch(() => {});
      },
    });

    s("pcGlowOpacity", {
      scope: "client",
      name: "PC Glow Opacity",
      hint: "How visible the PC token glow is. 1.00 = fully opaque (current default). Drop to 0.40 for a subtle hint.",
      type: Number,
      default: 0.85,
      range: { min: 0.1, max: 1.0, step: 0.05 },
      onChange: () => {
        import("./canvas-highlight.mjs").then(({ CanvasHighlight }) => {
          CanvasHighlight.refreshAllPcGlows?.();
        }).catch(() => {});
      },
    });

    s("pcGlowStyle", {
      scope: "client",
      name: "PC Glow Style",
      hint: "Visual style for the under-token PC glow. Soft Disc = filled circle with dark outline (current default). Solid Ring = hollow circle outline only. Soft Glow = wider falloff halo. Pulse = breathing disc.",
      type: String,
      default: "soft_disc",
      choices: {
        "soft_disc": "Soft Disc (filled circle + dark outline)",
        "solid_ring": "Solid Ring (hollow outline only)",
        "soft_glow": "Soft Glow (wider halo, no outline)",
        "pulse": "Pulse (disc that breathes in and out)",
      },
      onChange: () => {
        import("./canvas-highlight.mjs").then(({ CanvasHighlight }) => {
          CanvasHighlight.refreshAllPcGlows?.();
        }).catch(() => {});
      },
    });

    s("pcGlowColorMode", {
      scope: "client",
      name: "PC Glow Color Source",
      hint: "Where the glow color comes from. Player's chosen color (default — each player's Foundry color) or a single custom color applied to all PCs.",
      type: String,
      default: "player",
      choices: {
        "player": "Each player's chosen color (Foundry user color)",
        "custom": "Custom color (applied to all PCs uniformly)",
      },
      onChange: () => {
        import("./canvas-highlight.mjs").then(({ CanvasHighlight }) => {
          CanvasHighlight.refreshAllPcGlows?.();
        }).catch(() => {});
      },
    });

    s("pcGlowCustomColor", {
      scope: "client",
      name: "PC Glow Custom Color",
      hint: "Hex color used when Color Source is set to 'Custom'. Default is gold (#d4af37).",
      type: String,
      default: "#d4af37",
      onChange: () => {
        import("./canvas-highlight.mjs").then(({ CanvasHighlight }) => {
          CanvasHighlight.refreshAllPcGlows?.();
        }).catch(() => {});
      },
    });

    // ── Combat (moved from ACE: Envoy — merger Phase 1A) ────
    s("initiativeReorder", {
      name: "Initiative Reorder Arrows",
      hint: "Add up/down arrow buttons to the combat tracker so the GM can rearrange initiative order with a click.",
      type: Boolean,
      default: true,
    });

    s("autoDistributeXP", {
      name: "Auto-distribute XP on Kill",
      hint: "When an NPC dies, automatically divide its XP among all PCs in the encounter and post the award to chat.",
      type: Boolean,
      default: true,
    });

    s("autoCleanupDead", {
      name: "Auto-Move Dead NPCs to X ☠ Fallen Folder",
      hint: "When a persistent (linked) NPC dies, automatically move their actor from the sidebar into a \"X ☠ Fallen\" folder under ACE NPCs. Keeps your Actors sidebar clean.",
      type: Boolean,
      default: true,
    });

    // ── NPC Chat — moved from ACE: Envoy (merger Phase 2) ───
    // These settings control bio generation, NPC conversations, and the
    // Living World Faction System. Code is registered but dormant until
    // the NPC chat subsystem is wired into engine init/ready hooks.

    s("npcWebpFolder", {
      name: "NPC Conversation WebP Folder",
      hint: "Foundry-data-relative path to a folder of animated portraits (.webp) for NPCs. Lookup cascade: token name → actor name → creature subtype → creature type, then falls back to the static portrait / token image. Plays only during dialogue (not narrator emotes). Recipe: 512×512, 8-10 fps, 2-4 sec loop, q75-80, <500KB per file. Type/subtype names are lowercase (goblinoid.webp, humanoid.webp, beast.webp, undead.webp, etc.).",
      type: String,
      default: "NPCs/webps/",
    });

    s("npcChatEnabled", {
      name: "Enable NPC Chat (FaceTime-style conversations)",
      hint: "Master toggle for the NPC chat subsystem (bio generation, conversation UI, voice, faction memory). When OFF, none of the NPC chat hooks fire even if engine is enabled.",
      type: Boolean,
      default: false,  // dormant by default — flipped true after migration verified
    });

    s("enableSocialProfiles", {
      name: "NPC Social Profiles",
      hint: "Generate a 6-dimension social profile (hierarchy, loyalty, disposition, standing, wealth, circumstances) per NPC during bio generation. Rule-based — no extra API calls.",
      type: Boolean,
      default: true,
    });

    s("enableAutoLink", {
      name: "Auto-Save NPCs as Persistent Actors",
      hint: "OFF by default — dropped tokens keep their REAL name (the sheet + every mechanic reads it) and only get a display-only flavor name on the nameplate, which dies with the token. Turn ON only if you want every dropped NPC converted into a new persistent linked actor in your Actors sidebar.",
      type: Boolean,
      default: false,
    });

    s("autoGenerateBio", {
      name: "Auto-generate NPC Biographies",
      hint: "When a GM drags an NPC token onto a scene, AI generates a backstory based on creature Intelligence. Linked actors save to the actor sheet; unlinked tokens get unique per-instance bios.",
      type: Boolean,
      default: true,
    });

    s("tokenDropAI", {
      name: "Token Drop AI Level",
      hint: "What happens when you drag an NPC onto a scene. Silent (recommended) = the token just appears — no dialog, no wait, no AI call, nothing your players can see. It is given a name and a history the first time somebody actually talks to it, or whenever you click the quill under its token. Drop nine goblins instantly; the eight that die in combat never cost a thing. Full = faction popup + bio + name + items on every single drop. Bio Only = bio + name, no faction popup. Faction Only = faction popup, no bio or items. Off = vanilla drop, nothing at all.",
      type: String,
      choices: {
        "silent":       "Silent (instant drop — identity when someone talks to it)",
        "full":         "Full (faction + bio + items on every drop)",
        "bio-only":     "Bio Only (bio + name, no faction)",
        "faction-only": "Faction Only (faction popup, no bio)",
        "off":          "Off (vanilla drop, no AI)",
      },
      // Johnny, 2026-08-07, choosing between drop behaviours: "Nothing —
      // instant, silent." Nine goblins mid-session used to mean nine AI calls,
      // nine waits and nine dialogs in front of the players, which also tipped
      // them off that something was coming. Identity is now created lazily on
      // first contact, which costs nothing for the creatures nobody talks to.
      default: "silent",
    });

    s("sceneContextMinDays", {
      name: "Scene Context — Min Days Between Regens",
      hint: "When a linked NPC re-appears on a scene they've been on before, ACE generates a fresh 'why is this NPC here NOW' entry in their journal. This setting controls how recent the last entry has to be to be reused vs regenerated. 0 = any new calendar day triggers a fresh entry (default — works for most groups). 7 = once per week max (good for groups running multiple sessions per week). Set higher to reduce API spend. Same-day re-drops always reuse the existing entry regardless of this value.",
      type: Number,
      default: 0,
      range: { min: 0, max: 90, step: 1 },
    });

    // ─── Triple-Backup Memory Sync Engine ──────────────────────
    s("memorySyncEnabled", {
      name: "Backups — Enable Triple-Backup System",
      hint: "ACE's Memory Sync Engine automatically mirrors all campaign-affecting data (NPC profiles, factions, journals, world graph, world bible) to a backup folder and takes snapshots at session start / end. Default backup folder is D:/FoundryVTT/Data/ace-backups/ — point Google Drive Desktop or OneDrive at it for cloud backup. Disable only if you handle your own backups via another tool.",
      type: Boolean,
      default: true,
    });

    s("memorySyncExternalPath", {
      name: "Backups — External Mirror Instructions",
      hint: "READ-ONLY informational field. To enable cloud backup: (1) Open Google Drive Desktop. (2) Settings → Preferences → Folders from your computer → Add Folder. (3) Pick D:/FoundryVTT/Data/ace-backups/. (4) Set destination to your preferred Google Drive folder (suggested: ACE Suite/ACE World Backups). OneDrive/Dropbox/NAS sync tools work the same way. Once configured, every snapshot is auto-mirrored to the cloud.",
      type: String,
      default: "",
    });

    s("alwaysRunItemAndLoot", {
      name: "Always Check Items & Loot on Token Drop",
      hint: "When ON, every dropped NPC gets item flavor text and loot generation regardless of whether you generated a bio. Pick 'Off' on the drop popup (or set Token Drop AI Level to 'Off') to skip everything for a specific NPC. When OFF, items + loot only run when the bio runs (legacy behavior — quieter worlds, less to interact with). Existing creature rules still apply: beasts/oozes/plants/mindless creatures don't carry items regardless.",
      type: Boolean,
      default: true,
    });

    // ── Auto-Generate on Drop ─────────────────────────────────
    // When ON, the smart-setup popup is skipped and the AI's top
    // faction recommendation is auto-accepted. Bio generates in
    // the background. Comes with guardrails (rate limit, batch
    // confirmation, post-generation whisper card for review/revert)
    // so you don't burn AI credits on runaway batch drops.
    s("autoGenerateOnDrop", {
      name: "Auto-Generate Bio & Faction on Token Drop",
      hint: "When ON, the smart-setup popup is SKIPPED on every NPC drop. The AI's #1 faction suggestion is auto-accepted and a bio writes in the background. Defaults to OFF because the popup serves as a sanity check — turn ON only if you want speed over review. Guardrails apply automatically: rate-limit of N generations per minute (see below), single confirmation popup for big batches (>N tokens), and a whispered chat card after each auto-generation with a Revert button so you can roll back bad AI calls. Respects the Token Drop AI Level setting — if that's set to Off, nothing runs regardless of this toggle.",
      type: Boolean,
      default: false,
    });
    s("autoGenerateBatchConfirmThreshold", {
      name: "Auto-Gen — Batch Confirm Threshold",
      hint: "When auto-generate is ON and MORE than this many tokens drop within 2 seconds, ONE confirmation popup appears asking 'Auto-generate bios for N creatures? (~$X estimated)' before any AI calls fire. Lower = catches smaller batches; higher = quieter. Set to 0 to disable the confirmation entirely (not recommended — runaway scripts can burn credits fast).",
      type: Number,
      default: 5,
      range: { min: 0, max: 50, step: 1 },
    });
    s("autoGenerateCapPerMinute", {
      name: "Auto-Gen — Max Generations Per 60s",
      hint: "Rolling rate-limit. When auto-generate is ON, no more than this many bio+faction generations will fire in any 60-second window. Hits to the cap are skipped with a toast (the tokens still drop, just without auto AI work — you can still manually generate later). Protects against batch drops blowing through your AI credit budget.",
      type: Number,
      default: 10,
      range: { min: 1, max: 60, step: 1 },
    });

    s("skipBioForSummons", {
      name: "Skip Bio for Summoned Creatures",
      hint: "When ON (default), creatures summoned by ACE Forge traps (Mimic Chest, Summoning Rune) and other modules that mark spawns with the shared 'summonedByTrap' flag don't trigger automatic bio generation, voice assignment, or items/loot. Summons are usually generic disposable creatures — bios on them clutter the world. Turn OFF if you want every summon (including transient conjured beasts) to get the full NPC treatment.",
      type: Boolean,
      default: true,
    });

    s("autoLinkSummons", {
      name: "Auto-Link Summoned Creatures (Steel Defender, Conjure Animals, etc.)",
      hint: "When ON (default), any token spawned by the dnd5e Summon activity is automatically linked to its summoner. The system grants the summoning player OWNER permission on the summon's token, slots it into combat at the summoner's initiative -0.01 (with multi-summon stacking: -0.01, -0.02, -0.03), and skips auto-bio. Zero setup required — works for Steel Defender, Iron Defender, familiars, Conjure Animals, anything that goes through the system Summon activity. Turn OFF only if you want to handle ownership and initiative manually, or if you only want the manual 'Link as companion' right-click path to drive behavior.",
      type: Boolean,
      default: true,
    });

    s("npcKnowledgeBudget", {
      name: "NPC Knowledge Budget (Base)",
      hint: "Base character budget for world knowledge injected into NPC conversation prompts. The budget for an average INT 10 commoner. Higher = NPCs know more about the world but responses may be slower.",
      type: Number,
      default: 2000,
      range: { min: 500, max: 20000, step: 500 },
    });

    s("npcIntelligenceScaling", {
      name: "NPC Intelligence Scaling",
      hint: "When enabled, an NPC's Intelligence score scales their knowledge budget. High-INT NPCs (sages, wizards, ancient dragons) receive more world knowledge; low-INT creatures (beasts, zombies) receive less.",
      type: Boolean,
      default: true,
    });

    s("npcKnowledgeCap", {
      name: "NPC Knowledge Cap",
      hint: "Absolute maximum characters of world knowledge any single NPC can receive, regardless of Intelligence. Safety valve to prevent very high-INT NPCs from getting enormous prompts.",
      type: Number,
      default: 12000,
      range: { min: 2000, max: 50000, step: 1000 },
    });

    s("enableFactions", {
      name: "Living World Factions",
      hint: "Every NPC dropped onto a scene is assigned to a named faction — gangs, tribes, garrisons, guilds, settlements, etc. The AI generates faction identity (name, leader, purpose, shared lore) and injects it into both biographies and conversations.",
      type: Boolean,
      default: true,
    });

    s("factionPropagation", {
      name: "Faction Propagation (Living World)",
      hint: "When ON, a PC killing a faction member ripples through the connection web — the victim's faction, its kin (other tribes of the same kind), and its allies grow more hostile toward the party, while its enemies warm to them. Scaled by how notable the kill was.",
      type: Boolean,
      default: true,
    });

    s("factionDispositionOnDrop", {
      name: "Faction Disposition on Token Drop",
      hint: "When ON, a token dropped onto a scene inherits its faction's standing toward the party as its starting disposition — an angered faction arrives hostile, a revered one arrives friendly. Neutral factions keep the token's default disposition.",
      type: Boolean,
      default: true,
    });

    s("factionSpyChance", {
      name: "Spy/Deserter Chance (1 in N)",
      hint: "When assigning faction, there is a 1-in-N chance the NPC is secretly from a DIFFERENT faction (spy, deserter, captured, or turncoat). Set to 0 to disable. Does not apply to constructs, undead, or beasts.",
      type: Number,
      default: 200,
      range: { min: 0, max: 1000, step: 10 },
    });

    s("factionWildcardChance", {
      name: "Wild Card Outsider Chance (1 in N)",
      hint: "1-in-N chance a dropped NPC is a far-flung outsider from a completely different region of the world — a Calishite merchant in Barovia, a dwarf wandering north. Set to 0 to disable.",
      type: Number,
      default: 200,
      range: { min: 0, max: 1000, step: 10 },
    });

    s("defaultVoiceRegion", {
      name: "Default Voice Region",
      hint: "Default regional accent pool for NPCs when no scene-specific region is set. Affects commoners, humans, and races without a fixed accent.",
      type: String,
      choices: {
        "default":      "Sword Coast / Generic (British)",
        "barovia":      "Barovia / Ravenloft (Eastern European)",
        "calimshan":    "Calimshan (Middle Eastern)",
        "chult":        "Chult (African)",
        "kara_tur":     "Kara-Tur (East Asian)",
        "icewind_dale": "Icewind Dale / Nordic (Scandinavian)",
        "underdark":    "Underdark (Scandinavian/German)",
      },
      default: "default",
    });

    // ── NPC Chat — Hidden internal data stores ──────────────

    s("factionRegistry", {
      scope: "world", config: false, type: Object, default: {},
    });

    s("factionMemory", {
      scope: "world", config: false, type: Object, default: {},
    });

    s("voiceLibraryCache", {
      scope: "world", config: false, type: Object, default: {},
    });

    s("partyFace", {
      scope: "world", config: false, type: String, default: "",
    });

    // ── Migration tracking — true once migrateFromEnvoy() has run ────
    s("envoyMigrated", {
      scope: "world", config: false, type: Boolean, default: false,
    });

    // ── Folder consolidation — true once legacy "🎙 ACE Envoy" journal
    //    folder has been merged into "📖 ACE Engine". One-time per world.
    s("envoyJournalsConsolidated", {
      scope: "world", config: false, type: Boolean, default: false,
    });

    // ── Model catalog cache (live-fetched provider model lists) ──────
    // Populated by model-catalog.mjs; structure: { [provider]: { models: [...], fetchedAt: number } }
    // 24h TTL. Refreshed on demand via the "Refresh Model List" button.
    game.settings.register(MODULE_ID, "modelCatalogCache", {
      scope: "world", config: false, type: Object, default: {},
    });

    // ── Remote catalog (GitHub-hosted, daily background fetch) ────────
    // The bundled model-catalog.json ships with the module as a floor;
    // remote-catalog.mjs refreshes it from a JSON file on the ACE repo
    // once a day so new models / deprecation warnings reach users without
    // requiring a module release. Cache stores the fetched object +
    // timestamp; the toggle lets paranoid users opt out of the background
    // network call.
    s("autoUpdateCatalog", {
      name: "Auto-update Model Catalog",
      hint: "When ON, ACE checks the central catalog file on GitHub once a day in the background and pulls down any new models, label updates, or deprecation warnings. When OFF, you only get model-catalog updates when ACE itself updates. Recommended ON — there's no data sent, only a small JSON download.",
      type: Boolean,
      default: true,
    });
    game.settings.register(MODULE_ID, "remoteCatalogCache", {
      scope: "world", config: false, type: Object, default: {},
    });
    // Per-world dismissed-deprecations log: once the user dismisses a
    // sunset banner for a specific model, we don't nag them again.
    // Structure: { [modelId]: { dismissedAt: number } }
    game.settings.register(MODULE_ID, "dismissedDeprecations", {
      scope: "world", config: false, type: Object, default: {},
    });
  }

  /** Signup / API key URLs per provider */
  static PROVIDER_SIGNUP = {
    openai:     { label: "Get OpenAI key (free tier)",   url: "https://platform.openai.com/api-keys" },
    anthropic:  { label: "Get Anthropic key",            url: "https://console.anthropic.com/settings/keys" },
    ollama:     { label: "Download Ollama (free)",       url: "https://ollama.com/download" },
    lmstudio:   { label: "Download LM Studio (free)",   url: "https://lmstudio.ai/" },
    openrouter: { label: "Get OpenRouter key",           url: "https://openrouter.ai/keys" },
    custom:     { label: "Documentation",                url: "" },
  };

  /** Recommended defaults per provider */
  static PROVIDER_DEFAULTS = {
    openai:     { apiUrl: "https://api.openai.com",              modelName: "gpt-4o-mini" },
    anthropic:  { apiUrl: "https://api.anthropic.com",           modelName: "claude-sonnet-4-20250514" },
    ollama:     { apiUrl: "http://localhost:11434",               modelName: "llama3.2" },
    lmstudio:   { apiUrl: "http://localhost:1234",               modelName: "default" },
    openrouter: { apiUrl: "https://openrouter.ai/api",           modelName: "openai/gpt-4o-mini" },
    custom:     { apiUrl: "http://localhost:8080",               modelName: "default" },
  };

  /** Popular models per provider (shown in dropdown) */
  static PROVIDER_MODELS = {
    openai: [
      { value: "gpt-4o-mini",    label: "GPT-4o Mini — Fast · Free tier available" },
      { value: "gpt-4o",         label: "GPT-4o — Best Quality · ~$5/M tokens" },
      { value: "gpt-4-turbo",    label: "GPT-4 Turbo — High Quality · ~$10/M tokens" },
      { value: "gpt-3.5-turbo",  label: "GPT-3.5 Turbo — Budget · ~$0.50/M tokens" },
      { value: "o3-mini",        label: "o3-mini — Reasoning · ~$1/M tokens" },
    ],
    anthropic: [
      { value: "claude-sonnet-4-20250514",  label: "Claude Sonnet 4 — Recommended · ~$3/M tokens" },
      { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — Fast & Cheap · ~$0.80/M tokens" },
      { value: "claude-opus-4-20250514",    label: "Claude Opus 4 — Most Capable · ~$15/M tokens" },
    ],
    ollama: [
      // Sorted high-VRAM → low-VRAM. ⭐ marks best-in-tier for each VRAM bracket.
      // `free: true` makes the dropdown prepend 🆓 to the label automatically.
      { value: "llama3.3:70b",         label: "Llama 3.3 70B — Top narrative · needs 40+ GB VRAM (dual GPU / Apple M-series)", free: true },
      { value: "qwen2.5:32b",          label: "⭐ Qwen 2.5 32B — Best 24 GB sweet spot · ~20GB VRAM", free: true },
      { value: "deepseek-r1:32b",      label: "DeepSeek R1 32B — Best reasoning · ~20GB VRAM", free: true },
      { value: "mistral-nemo:12b",     label: "⭐ Mistral Nemo 12B — Long context, great prose · ~10GB VRAM", free: true },
      { value: "qwen2.5:14b",          label: "Qwen 2.5 14B — Balanced · ~10GB VRAM", free: true },
      { value: "deepseek-r1:14b",      label: "DeepSeek R1 14B — Reasoning · ~10GB VRAM", free: true },
      { value: "llama3.1:8b",          label: "⭐ Llama 3.1 8B — Mid-range GPU sweet spot · ~6GB VRAM", free: true },
      { value: "gemma2:9b",            label: "Gemma 2 9B — Fast, poetic prose · ~6GB VRAM", free: true },
      { value: "dolphin3:8b",          label: "Dolphin 3 8B — Uncensored (dark campaigns) · ~5GB VRAM", free: true },
      { value: "mistral",              label: "Mistral 7B — Fast classic · ~5GB VRAM", free: true },
      { value: "llama3.2:3b",          label: "⭐ Llama 3.2 3B — Tiny, runs on any GPU · ~2GB VRAM", free: true },
      { value: "qwen2.5-coder:32b",    label: "Qwen 2.5 Coder 32B — CODE-tuned, NOT for narrative · ~20GB VRAM", free: true },
    ],
    lmstudio: [
      { value: "default",  label: "Default (auto-detect loaded model)" },
    ],
    openrouter: [
      { value: "openai/gpt-4o-mini",             label: "GPT-4o Mini" },
      { value: "openai/gpt-4o",                  label: "GPT-4o" },
      { value: "anthropic/claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { value: "google/gemini-2.0-flash-001",    label: "Gemini 2.0 Flash" },
      { value: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
    ],
    custom: [
      { value: "default",  label: "Default" },
    ],
  };

  /**
   * Inject a compact AI status block on the main Configure Settings page.
   *
   * Phase: settings cleanup (2026-05-01) — removed all editable AI fields
   * from the main page. Edits happen ONLY in the popup config panel. The
   * main page now just shows what's currently configured + a Test
   * Connection button so the user can verify at a glance.
   *
   * Layout (read-only):
   *   ┌────────────────────────────────────────────┐
   *   │ AI Provider:  Anthropic                    │
   *   │ Model:        claude-sonnet-4-20250514     │
   *   │ [ Test Connection ]                        │
   *   └────────────────────────────────────────────┘
   *
   * The popup config panel ("Open Configuration" menu button) is where
   * provider / API key / URL / model are actually edited.
   */
  /**
   * Update the live Provider/Model spans inside any currently-rendered
   * status block. Called when the underlying aiProvider / modelName
   * settings change (e.g. after Save Changes in Open Configuration) so
   * the main Game Settings page reflects the new values immediately,
   * without needing the user to close and reopen the dialog.
   */
  static _refreshMainPageStatusBlock() {
    const blocks = document.querySelectorAll(".ace-settings-main-status");
    if (!blocks.length) return;
    let providerVal = "", modelVal = "";
    try { providerVal = game.settings.get(MODULE_ID, "aiProvider") || ""; } catch (_) {}
    try { modelVal    = game.settings.get(MODULE_ID, "modelName")  || ""; } catch (_) {}
    const providerLabel = AceSettings.PROVIDER_DEFAULTS[providerVal]?.label
                       ?? (providerVal ? providerVal[0].toUpperCase() + providerVal.slice(1) : "(not configured)");
    const modelLabel    = modelVal || "(not configured)";
    for (const block of blocks) {
      const provSpan  = block.querySelector('[data-ace-status="provider"]');
      const modelSpan = block.querySelector('[data-ace-status="model"]');
      if (provSpan)  provSpan.textContent  = providerLabel;
      if (modelSpan) modelSpan.textContent = modelLabel;
    }
  }

  static maskSecretFields() {
    // Multiple render hooks fire for V12's renderSettingsConfig and V13's
    // CategoryBrowser-based settings UI. tryInject is idempotent (skips if
    // the status block is already in place) so listening to all variants is
    // safe. In practice the V12 hook still fires under V13 for backward
    // compat — the other two are belt-and-suspenders.
    const tryInject = (rootArg) => {
      const root = rootArg instanceof HTMLElement
        ? rootArg
        : (rootArg?.[0] ?? rootArg ?? document.body);
      if (!root?.querySelector) return;

      // Find ace-engine's section. We use moduleEnabled as the anchor (only
      // AI-adjacent thing still visible on this page) and inject our status
      // block right above it so it's the first thing the user sees.
      let enabledInput = root.querySelector(`[name="${MODULE_ID}.moduleEnabled"]`);
      // Document-scope fallback for cases where the hook's html arg scopes
      // to a sub-tree that excludes the actual category content.
      if (!enabledInput) enabledInput = document.querySelector(`[name="${MODULE_ID}.moduleEnabled"]`);
      if (!enabledInput) return;
      const enabledGroup = enabledInput.closest(".form-group") ?? enabledInput.parentElement;
      if (!enabledGroup) return;
      // Idempotency — skip if we've already injected for this render
      if (enabledGroup.parentElement?.querySelector(".ace-settings-main-status")) return;
      AceSettings._buildAndInjectStatusBlock(enabledGroup);
    };
    Hooks.on("renderSettingsConfig",  (_app, html) => tryInject(html));
    Hooks.on("renderCategoryBrowser", (_app, html) => tryInject(html));
    // V13 catch-all — fires for every ApplicationV2 render. We only care
    // about the settings dialog, identified by class name.
    Hooks.on("renderApplicationV2", (app, html) => {
      const name = app?.constructor?.name ?? "";
      if (!name.includes("Settings") && !name.includes("CategoryBrowser")) return;
      tryInject(html);
    });

    // Live-refresh the status block whenever aiProvider or modelName
    // changes — e.g. after Save Changes in Open Configuration. Without
    // this, the parent Game Settings dialog would still show the previous
    // provider/model until the user closes and reopens it.
    Hooks.on("updateSetting", (setting) => {
      const key = setting?.key ?? "";
      if (key !== `${MODULE_ID}.aiProvider` && key !== `${MODULE_ID}.modelName`) return;
      AceSettings._refreshMainPageStatusBlock();
    });
  }

  /** Build and insert the read-only Provider+Model + Test Connection block
   *  above the given anchor (the moduleEnabled form-group). Internal helper
   *  for the renderSettingsConfig / renderCategoryBrowser path above. */
  static _buildAndInjectStatusBlock(enabledGroup) {
    const _trueRoot = enabledGroup.parentElement;
    if (!_trueRoot) return;

      // Resolve current provider + model labels from saved settings.
      let providerVal = "";
      let modelVal    = "";
      try { providerVal = game.settings.get(MODULE_ID, "aiProvider") || ""; } catch (_) {}
      try { modelVal    = game.settings.get(MODULE_ID, "modelName")  || ""; } catch (_) {}
      const providerLabel = AceSettings.PROVIDER_DEFAULTS[providerVal]?.label
                         ?? (providerVal ? providerVal[0].toUpperCase() + providerVal.slice(1) : "(not configured)");
      const modelLabel    = modelVal || "(not configured)";

      // Build the status block.
      const status = document.createElement("div");
      status.className = "ace-settings-main-status";
      status.style.cssText = [
        "margin: 4px 0 12px 0",
        "padding: 10px 14px",
        "background: linear-gradient(180deg, #15171c, #1f2127)",
        "border: 1px solid rgba(201, 168, 76, 0.4)",
        "border-radius: 4px",
        "color: #e8e6e0",
        "font-size: 0.9em",
      ].join(";");
      status.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;">
          <div><span style="color:#c9a84c;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;font-size:0.75em;">AI Provider:</span>
               <span style="margin-left:8px;font-weight:600;" data-ace-status="provider">${foundry.utils.escapeHTML(providerLabel)}</span></div>
          <div><span style="color:#c9a84c;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;font-size:0.75em;">Model:</span>
               <span style="margin-left:8px;font-family:monospace;" data-ace-status="model">${foundry.utils.escapeHTML(modelLabel)}</span></div>
        </div>
        <button type="button" class="ace-settings-main-test-btn"
                style="padding:6px 16px;background:#1a1a1e;border:1px solid #c9a84c;border-radius:4px;color:#c9a84c;cursor:pointer;font-size:0.85em;transition:all 0.2s;">
          <i class="fa-solid fa-plug"></i> Test Connection
        </button>
        <div style="margin-top:6px;font-size:0.78em;color:#888;font-style:italic;">
          Edit AI provider, API key, URL, and model in the
          <strong style="color:#c9a84c;">Open Configuration</strong> panel above.
        </div>
      `;

      // Hover affordance for the test button
      const testBtn = status.querySelector(".ace-settings-main-test-btn");
      testBtn.addEventListener("mouseenter", () => {
        testBtn.style.background = "#2a2a2e";
        testBtn.style.boxShadow = "0 0 6px rgba(212,175,55,0.3)";
      });
      testBtn.addEventListener("mouseleave", () => {
        testBtn.style.background = "#1a1a1e";
        testBtn.style.boxShadow = "none";
      });

      // Click — pulls the current saved settings (no edit fields on this
      // page anymore) and runs testConnection against them.
      testBtn.addEventListener("click", async () => {
        testBtn.disabled = true;
        testBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing…';
        let result;
        try {
          const provider = game.settings.get(MODULE_ID, "aiProvider") || "";
          const apiKey   = getSecret("apiKey");   // ⚠️ not the world name
          const apiUrl   = game.settings.get(MODULE_ID, "apiUrl")     || "";
          const model    = game.settings.get(MODULE_ID, "modelName")  || "";
          result = await AceSettings.testConnection(provider, apiKey, apiUrl, model);
        } catch (err) {
          result = { ok: false, error: err?.message ?? String(err) };
        }
        if (result?.ok) {
          testBtn.innerHTML = '<i class="fa-solid fa-check" style="color:#5db88a;"></i> Connected!';
          testBtn.style.borderColor = "#5db88a";
          ui.notifications?.info(`ACE: Connection successful — ${result.model ?? "OK"} responded.`);
        } else {
          testBtn.innerHTML = '<i class="fa-solid fa-times" style="color:#c43b3b;"></i> Failed';
          testBtn.style.borderColor = "#c43b3b";
          ui.notifications?.error(`ACE: ${result?.error ?? "Connection failed"}`);
        }
        setTimeout(() => {
          testBtn.innerHTML = '<i class="fa-solid fa-plug"></i> Test Connection';
          testBtn.style.borderColor = "#c9a84c";
          testBtn.disabled = false;
        }, 4000);
      });

      // Inject above the moduleEnabled toggle
      enabledGroup.parentElement?.insertBefore(status, enabledGroup);
  }

  /**
   * Test the AI connection with a minimal request.
   * Returns { ok: boolean, model?: string, error?: string }
   */
  static async testConnection(provider, apiKey, apiUrl, modelName) {
    const testMessage = [
      { role: "system", content: "Respond with exactly: OK" },
      { role: "user", content: "Test" },
    ];

    try {
      switch (provider) {
        case "ollama": {
          const url = `${apiUrl}/api/chat`;
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: modelName, messages: testMessage, stream: false }),
          });
          if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);
          const data = await resp.json();
          return { ok: true, model: data.model ?? modelName };
        }

        case "anthropic": {
          // Always use Anthropic's URL — don't inherit apiUrl which may be set to another provider
          const anthropicUrl = "https://api.anthropic.com";
          const resp = await fetch(`${anthropicUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "anthropic-dangerous-direct-browser-access": "true",
            },
            body: JSON.stringify({
              model: modelName || "claude-sonnet-4-20250514",
              max_tokens: 10,
              system: "Respond with exactly: OK",
              messages: [{ role: "user", content: "Test" }],
            }),
          });
          if (!resp.ok) {
            const txt = await resp.text();
            if (resp.status === 401) throw new Error("Invalid API key — check your Anthropic key.");
            throw new Error(`Anthropic error ${resp.status}: ${txt}`);
          }
          return { ok: true, model: modelName };
        }

        case "openai":
        case "lmstudio":
        case "openrouter":
        case "custom": {
          const url = provider === "openai"
            ? "https://api.openai.com/v1/chat/completions"
            : provider === "openrouter"
              ? "https://openrouter.ai/api/v1/chat/completions"
              : `${apiUrl}/v1/chat/completions`;

          const headers = { "Content-Type": "application/json" };
          if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

          const resp = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: modelName, messages: testMessage,
              stream: false, max_tokens: 10,
            }),
          });
          if (!resp.ok) {
            const txt = await resp.text();
            if (resp.status === 401) throw new Error("Invalid API key — check your key and try again.");
            if (resp.status === 429) throw new Error("Rate limited — wait a moment and try again.");
            throw new Error(`API error ${resp.status}: ${txt.slice(0, 200)}`);
          }
          const data = await resp.json();
          return { ok: true, model: data.model ?? modelName };
        }

        default:
          return { ok: false, error: `Unknown provider: ${provider}` };
      }
    } catch (err) {
      // Detect CORS / unreachable specifically — message tailored to provider
      if (err instanceof TypeError && err.message.includes("Failed to fetch")) {
        if (/localhost|127\.0\.0\.1/.test(apiUrl)) {
          let fix;
          switch (provider) {
            case "ollama":
              fix = "Set OLLAMA_ORIGINS=* (Machine env var), then quit Ollama from the tray and restart Foundry.";
              break;
            case "lmstudio":
              fix = "Open LM Studio → Local Server tab → click 'Start Server', and make sure 'Cross-Origin Resource Sharing (CORS)' is enabled.";
              break;
            case "custom":
              fix = "Make sure your server is running and its CORS policy allows requests from " + window.location.origin + ".";
              break;
            default:
              fix = "Make sure the local server is running and its CORS policy allows browser requests.";
          }
          return { ok: false, error: `Cannot reach ${apiUrl} — ${fix}` };
        }
        return { ok: false, error: `Cannot reach server — check URL and network.` };
      }
      return { ok: false, error: err.message || "Connection failed." };
    }
  }

  /**
   * Show the first-run setup wizard.
   * Walks the GM through: pick a provider → paste API key → test → done.
   */
  static async showSetupWizard() {
    const providers = [
      { id: "openai",     icon: "fa-robot",        name: "OpenAI / ChatGPT",  desc: "Free tier available — get started in 60 seconds", badge: "FREE TIER" },
      { id: "anthropic",  icon: "fa-brain",        name: "Anthropic (Claude)", desc: "High-quality responses, pay-per-use",              badge: "PAID" },
      { id: "ollama",     icon: "fa-server",       name: "Ollama (Local)",     desc: "100% free, runs on your machine — requires install", badge: "FREE" },
      { id: "lmstudio",   icon: "fa-microchip",    name: "LM Studio (Local)", desc: "Free local AI — download at lmstudio.ai",          badge: "FREE" },
      { id: "openrouter", icon: "fa-network-wired", name: "OpenRouter",        desc: "Access to many models, pay-per-use",               badge: "PAID" },
    ];

    const providerCards = providers.map(p => `
      <div class="ace-wiz-provider" data-provider="${p.id}">
        <div class="ace-wiz-provider-icon"><i class="fas ${p.icon}"></i></div>
        <div class="ace-wiz-provider-info">
          <strong>${p.name}</strong>
          <span class="ace-wiz-badge ace-wiz-badge-${p.badge === "FREE TIER" ? "free" : p.badge === "FREE" ? "free" : "paid"}">${p.badge}</span>
          <div class="ace-wiz-provider-desc">${p.desc}</div>
        </div>
      </div>
    `).join("");

    const wizardHtml = `
      <div class="ace-setup-wizard">

        <!-- STEP 1: Choose provider -->
        <div class="ace-wiz-step ace-wiz-step-1 active">
          <div class="ace-wiz-header">
            <div class="ace-wiz-header-rule"></div>
            <h2 class="ace-wiz-title">SELECT YOUR AI PROVIDER</h2>
            <p class="ace-wiz-subtitle">Choose a provider below to get started. This takes about 60 seconds.</p>
          </div>
          <div class="ace-wiz-providers">${providerCards}</div>
        </div>

        <!-- STEP 2: Enter API key -->
        <div class="ace-wiz-step ace-wiz-step-2">
          <div class="ace-wiz-header">
            <div class="ace-wiz-header-rule"></div>
            <h2 class="ace-wiz-title"><i class="fas fa-key"></i> ENTER YOUR API KEY</h2>
            <p class="ace-wiz-key-instructions"></p>
          </div>
          <a class="ace-wiz-signup-link" href="#" target="_blank" rel="noopener">
            <i class="fas fa-external-link-alt"></i> <span>Get your API key</span>
          </a>
          <div class="ace-wiz-key-field">
            <input type="password" class="ace-wiz-key-input" placeholder="Paste your API key here\u2026"
                   autocomplete="off" spellcheck="false" />
          </div>
          <p class="ace-wiz-local-hint">
            <i class="fas fa-info-circle"></i> No API key needed for local providers \u2014 just make sure the service is running.
          </p>
          <div class="ace-wiz-ollama-tips" style="display:none; margin-top:10px; padding:10px 14px; background:rgba(212,175,55,0.06); border:1px solid rgba(212,175,55,0.25); border-radius:5px; font-size:11.5px; color:#c8c0b0; line-height:1.55;">
            <div style="color:#d4af37; font-weight:700; margin-bottom:6px; letter-spacing:0.04em;"><i class="fas fa-lightbulb"></i> OLLAMA QUICK START</div>
            <div style="margin-bottom:4px;">1. Install Ollama and run <code style="background:rgba(0,0,0,0.4);padding:1px 6px;border-radius:3px;color:#d4af37;">ollama serve</code></div>
            <div style="margin-bottom:4px;">2. Pull a starter model: <code style="background:rgba(0,0,0,0.4);padding:1px 6px;border-radius:3px;color:#d4af37;">ollama pull llama3.2</code></div>
            <div style="margin-bottom:4px;">3. <strong>For NPC portrait reading</strong>, also: <code style="background:rgba(0,0,0,0.4);padding:1px 6px;border-radius:3px;color:#d4af37;">ollama pull llama3.2-vision</code></div>
            <div style="margin-bottom:0;">4. Set environment variable <code style="background:rgba(0,0,0,0.4);padding:1px 6px;border-radius:3px;color:#d4af37;">OLLAMA_ORIGINS=*</code> at the system level (Windows: System Properties \u2192 Advanced \u2192 Environment Variables) and restart Ollama AND Foundry, otherwise the browser blocks the connection (CORS).</div>
          </div>
          <div class="ace-wiz-actions">
            <button class="ace-wiz-btn ace-wiz-back" type="button"><i class="fas fa-arrow-left"></i> Back</button>
            <button class="ace-wiz-btn ace-wiz-btn-gold ace-wiz-test" type="button"><i class="fas fa-plug"></i> Test Connection</button>
          </div>
          <div class="ace-wiz-test-result"></div>
        </div>

        <!-- STEP 3: Success -->
        <div class="ace-wiz-step ace-wiz-step-3">
          <div class="ace-wiz-success">
            <div class="ace-wiz-success-icon">
              <i class="fas fa-crown"></i>
            </div>
            <h2 class="ace-wiz-title ace-wiz-title-success">CONNECTION ESTABLISHED</h2>
            <p class="ace-wiz-subtitle">ACE is connected and ready to assist your game.</p>
            <div class="ace-wiz-success-hint">
              <span class="ace-wiz-hotkey">Ctrl + Shift + L</span>
              <span class="ace-wiz-hint-text">to open ACE at any time</span>
            </div>
          </div>
        </div>

      </div>
    `;

    const wizardStyle = `
      <style>
        /* ═══════════════════════════════════════════════════════
           ACE Quick Setup — Gold & Black Luxury Theme
           ═══════════════════════════════════════════════════════ */

        /* ── Outer Dialog Shell ─────────────────────────────── */
        .ace-setup-dialog {
          background: #0a0a0c !important;
          border: 2px solid #d4af37 !important;
          border-radius: 8px !important;
          box-shadow:
            0 0 30px rgba(212, 175, 55, 0.15),
            0 8px 40px rgba(0, 0, 0, 0.7),
            inset 0 1px 0 rgba(212, 175, 55, 0.1) !important;
          overflow: hidden;
        }
        .ace-setup-dialog .window-header {
          background: linear-gradient(180deg,
            rgba(212, 175, 55, 0.25) 0%,
            rgba(212, 175, 55, 0.08) 60%,
            rgba(10, 10, 12, 0.95) 100%) !important;
          border-bottom: 1px solid rgba(212, 175, 55, 0.4) !important;
          padding: 8px 12px !important;
        }
        .ace-setup-dialog .window-header .window-title {
          font-family: 'Cinzel Decorative', 'Cinzel', serif !important;
          font-size: 14px !important;
          color: #d4af37 !important;
          text-transform: uppercase !important;
          letter-spacing: 0.12em !important;
          text-shadow: 0 0 8px rgba(212, 175, 55, 0.3) !important;
        }
        .ace-setup-dialog .window-header a.close {
          color: rgba(212, 175, 55, 0.6) !important;
        }
        .ace-setup-dialog .window-header a.close:hover {
          color: #d4af37 !important;
          text-shadow: 0 0 6px rgba(212, 175, 55, 0.4) !important;
        }
        .ace-setup-dialog .dialog-content {
          background: #0a0a0c !important;
          padding: 0 !important;
        }
        .ace-setup-dialog .dialog-buttons {
          background: linear-gradient(0deg,
            rgba(212, 175, 55, 0.06) 0%,
            transparent 100%) !important;
          border-top: 1px solid rgba(212, 175, 55, 0.15) !important;
          padding: 10px 16px !important;
          gap: 8px !important;
        }
        .ace-setup-dialog .dialog-buttons button {
          font-family: 'Rajdhani', sans-serif !important;
          font-weight: 600 !important;
          font-size: 12px !important;
          text-transform: uppercase !important;
          letter-spacing: 0.08em !important;
          padding: 8px 20px !important;
          border-radius: 4px !important;
          cursor: pointer !important;
          transition: all 0.25s ease !important;
          background: linear-gradient(180deg, #141418 0%, #0e0e12 100%) !important;
          border: 1px solid rgba(212, 175, 55, 0.25) !important;
          color: rgba(212, 175, 55, 0.7) !important;
        }
        .ace-setup-dialog .dialog-buttons button:hover {
          border-color: #d4af37 !important;
          color: #d4af37 !important;
          box-shadow: 0 0 12px rgba(212, 175, 55, 0.2),
                      inset 0 0 12px rgba(212, 175, 55, 0.05) !important;
          background: linear-gradient(180deg, #1a1a20 0%, #111116 100%) !important;
        }
        .ace-setup-dialog .dialog-buttons button i {
          color: inherit !important;
        }

        /* ── Wizard Body ───────────────────────────────────── */
        .ace-setup-wizard {
          font-family: 'Rajdhani', sans-serif;
          color: #c8c0b0;
          padding: 20px 22px 14px;
        }
        .ace-wiz-step { display: none; }
        .ace-wiz-step.active { display: block; animation: aceWizFade 0.35s ease; }
        @keyframes aceWizFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

        /* ── Header Block ──────────────────────────────────── */
        .ace-wiz-header {
          margin-bottom: 16px;
        }
        .ace-wiz-header-rule {
          height: 2px;
          background: linear-gradient(90deg,
            transparent 0%,
            rgba(212, 175, 55, 0.5) 20%,
            #d4af37 50%,
            rgba(212, 175, 55, 0.5) 80%,
            transparent 100%);
          margin-bottom: 14px;
          border-radius: 1px;
        }
        .ace-wiz-title {
          font-family: 'Orbitron', 'Rajdhani', sans-serif;
          font-size: 14px;
          font-weight: 700;
          color: #d4af37;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          margin: 0 0 6px;
          text-shadow: 0 0 10px rgba(212, 175, 55, 0.2);
        }
        .ace-wiz-title i {
          margin-right: 6px;
          font-size: 13px;
        }
        .ace-wiz-title-success {
          color: #d4af37;
          font-size: 16px;
          margin-top: 12px;
        }
        .ace-wiz-subtitle {
          font-size: 13px;
          color: #8a8478;
          margin: 0;
          letter-spacing: 0.02em;
        }

        /* ── Provider Cards ────────────────────────────────── */
        .ace-wiz-providers {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .ace-wiz-provider {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 11px 16px;
          border: 1px solid rgba(212, 175, 55, 0.12);
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.25s ease;
          background: linear-gradient(135deg,
            rgba(20, 20, 26, 0.9) 0%,
            rgba(14, 14, 18, 0.95) 100%);
          position: relative;
          overflow: hidden;
        }
        .ace-wiz-provider::before {
          content: "";
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          background: linear-gradient(135deg,
            rgba(212, 175, 55, 0.05) 0%,
            transparent 60%);
          opacity: 0;
          transition: opacity 0.25s ease;
          pointer-events: none;
        }
        .ace-wiz-provider:hover {
          border-color: rgba(212, 175, 55, 0.5);
          box-shadow: 0 0 16px rgba(212, 175, 55, 0.1),
                      inset 0 0 20px rgba(212, 175, 55, 0.03);
          transform: translateX(3px);
        }
        .ace-wiz-provider:hover::before { opacity: 1; }
        .ace-wiz-provider-icon {
          font-size: 20px;
          color: #d4af37;
          width: 32px;
          text-align: center;
          flex-shrink: 0;
          filter: drop-shadow(0 0 4px rgba(212, 175, 55, 0.3));
        }
        .ace-wiz-provider-info {
          flex: 1;
          min-width: 0;
        }
        .ace-wiz-provider-info strong {
          font-family: 'Rajdhani', sans-serif;
          font-size: 14px;
          font-weight: 700;
          color: #e8e0d4;
          letter-spacing: 0.03em;
        }
        .ace-wiz-provider-desc {
          font-size: 11.5px;
          color: #6a6358;
          margin-top: 2px;
          letter-spacing: 0.01em;
        }
        .ace-wiz-badge {
          display: inline-block;
          padding: 1px 7px;
          border-radius: 3px;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          vertical-align: middle;
          margin-left: 8px;
        }
        .ace-wiz-badge-free {
          background: rgba(93, 184, 138, 0.12);
          color: #5db88a;
          border: 1px solid rgba(93, 184, 138, 0.25);
        }
        .ace-wiz-badge-paid {
          background: rgba(212, 175, 55, 0.1);
          color: #d4af37;
          border: 1px solid rgba(212, 175, 55, 0.25);
        }

        /* ── Step 2: API Key ───────────────────────────────── */
        .ace-wiz-key-instructions {
          font-size: 13px;
          color: #8a8478;
          margin: 0;
        }
        .ace-wiz-signup-link {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          margin: 10px 0;
          color: #d4af37;
          font-size: 12px;
          font-weight: 600;
          text-decoration: none;
          letter-spacing: 0.04em;
          transition: all 0.2s;
          padding: 4px 0;
        }
        .ace-wiz-signup-link:hover {
          color: #e8c84a;
          text-shadow: 0 0 8px rgba(212, 175, 55, 0.3);
        }
        .ace-wiz-signup-link i { font-size: 10px; }
        .ace-wiz-key-field {
          display: flex;
          gap: 6px;
          align-items: center;
        }
        .ace-wiz-key-input {
          flex: 1;
          padding: 10px 14px;
          background: linear-gradient(180deg, #08080a 0%, #0c0c0f 100%);
          border: 1px solid rgba(212, 175, 55, 0.2);
          border-radius: 5px;
          color: #e8e0d4;
          font-family: 'Rajdhani', monospace;
          font-size: 13px;
          letter-spacing: 0.02em;
          transition: all 0.25s ease;
          outline: none;
        }
        .ace-wiz-key-input::placeholder {
          color: #4a4640;
          font-style: italic;
        }
        .ace-wiz-key-input:focus {
          border-color: #d4af37;
          box-shadow: 0 0 12px rgba(212, 175, 55, 0.15),
                      inset 0 0 6px rgba(212, 175, 55, 0.05);
        }
        .ace-wiz-local-hint {
          display: none;
          font-size: 11.5px;
          color: #6a6358;
          margin-top: 8px;
          padding: 8px 12px;
          background: rgba(212, 175, 55, 0.04);
          border: 1px solid rgba(212, 175, 55, 0.1);
          border-radius: 4px;
        }
        .ace-wiz-local-hint i {
          color: #d4af37;
          margin-right: 4px;
        }

        /* ── Action Buttons ────────────────────────────────── */
        .ace-wiz-actions {
          display: flex;
          gap: 8px;
          margin-top: 16px;
        }
        .ace-wiz-btn {
          padding: 9px 20px;
          border-radius: 4px;
          cursor: pointer;
          font-family: 'Rajdhani', sans-serif;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          border: 1px solid rgba(212, 175, 55, 0.2);
          color: #8a8478;
          background: linear-gradient(180deg, #141418 0%, #0e0e12 100%);
          transition: all 0.25s ease;
        }
        .ace-wiz-btn:hover {
          border-color: rgba(212, 175, 55, 0.5);
          color: #d4af37;
          box-shadow: 0 0 10px rgba(212, 175, 55, 0.1);
        }
        .ace-wiz-btn i { margin-right: 4px; }
        .ace-wiz-btn-gold {
          background: linear-gradient(180deg,
            rgba(212, 175, 55, 0.15) 0%,
            rgba(212, 175, 55, 0.05) 100%);
          border: 1px solid rgba(212, 175, 55, 0.4);
          color: #d4af37;
        }
        .ace-wiz-btn-gold:hover {
          border-color: #d4af37;
          background: linear-gradient(180deg,
            rgba(212, 175, 55, 0.25) 0%,
            rgba(212, 175, 55, 0.1) 100%);
          box-shadow: 0 0 16px rgba(212, 175, 55, 0.2),
                      inset 0 0 12px rgba(212, 175, 55, 0.05);
          color: #e8c84a;
          text-shadow: 0 0 6px rgba(212, 175, 55, 0.3);
        }
        .ace-wiz-btn:disabled {
          opacity: 0.5;
          cursor: wait;
        }

        /* ── Test Result ───────────────────────────────────── */
        .ace-wiz-test-result {
          margin-top: 12px;
          padding: 10px 14px;
          border-radius: 5px;
          display: none;
          font-size: 12.5px;
          font-weight: 600;
          letter-spacing: 0.02em;
        }
        .ace-wiz-test-result i { margin-right: 5px; }
        .ace-wiz-test-result.success {
          background: linear-gradient(135deg, rgba(93, 184, 138, 0.08) 0%, rgba(93, 184, 138, 0.03) 100%);
          border: 1px solid rgba(93, 184, 138, 0.35);
          color: #5db88a;
        }
        .ace-wiz-test-result.fail {
          background: linear-gradient(135deg, rgba(200, 60, 60, 0.08) 0%, rgba(200, 60, 60, 0.03) 100%);
          border: 1px solid rgba(200, 60, 60, 0.35);
          color: #e87070;
        }

        /* ── Step 3: Success ───────────────────────────────── */
        .ace-wiz-success {
          text-align: center;
          padding: 24px 0 10px;
        }
        .ace-wiz-success-icon {
          width: 64px;
          height: 64px;
          margin: 0 auto 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: radial-gradient(circle at 40% 35%,
            rgba(212, 175, 55, 0.2) 0%,
            rgba(212, 175, 55, 0.05) 70%,
            transparent 100%);
          border: 2px solid rgba(212, 175, 55, 0.35);
          animation: aceWizGlow 2s ease-in-out infinite alternate;
        }
        @keyframes aceWizGlow {
          from { box-shadow: 0 0 12px rgba(212, 175, 55, 0.15); }
          to   { box-shadow: 0 0 24px rgba(212, 175, 55, 0.3), 0 0 40px rgba(212, 175, 55, 0.1); }
        }
        .ace-wiz-success-icon i {
          font-size: 28px;
          color: #d4af37;
          filter: drop-shadow(0 0 6px rgba(212, 175, 55, 0.4));
        }
        .ace-wiz-success-hint {
          margin-top: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
        }
        .ace-wiz-hotkey {
          display: inline-block;
          padding: 4px 12px;
          background: rgba(212, 175, 55, 0.08);
          border: 1px solid rgba(212, 175, 55, 0.3);
          border-radius: 4px;
          font-family: 'Orbitron', 'Rajdhani', monospace;
          font-size: 11px;
          font-weight: 600;
          color: #d4af37;
          letter-spacing: 0.06em;
        }
        .ace-wiz-hint-text {
          font-size: 12px;
          color: #6a6358;
        }
      </style>
    `;

    // Use Foundry's Dialog
    return new Promise((resolve) => {
      const dlg = new Dialog({
        title: "ACE \u2014 AI Campaign Engine",
        content: wizardStyle + wizardHtml,
        buttons: {
          skip: {
            icon: '<i class="fas fa-forward"></i>',
            label: "Skip Setup",
            callback: () => {
              game.settings.set(MODULE_ID, "setupComplete", true);
              resolve(false);
            },
          },
          done: {
            icon: '<i class="fas fa-crown"></i>',
            label: "Done",
            callback: () => {
              game.settings.set(MODULE_ID, "setupComplete", true);
              resolve(true);
            },
          },
        },
        default: "done",
        render: (html) => {
          const root = html instanceof HTMLElement ? html : html[0] ?? html;
          let selectedProvider = null;

          const step1 = root.querySelector(".ace-wiz-step-1");
          const step2 = root.querySelector(".ace-wiz-step-2");
          const step3 = root.querySelector(".ace-wiz-step-3");
          const keyInput = root.querySelector(".ace-wiz-key-input");
          const keyInstructions = root.querySelector(".ace-wiz-key-instructions");
          const signupLink = root.querySelector(".ace-wiz-signup-link");
          const localHint = root.querySelector(".ace-wiz-local-hint");
          const testResult = root.querySelector(".ace-wiz-test-result");

          const goToStep = (n) => {
            step1.classList.toggle("active", n === 1);
            step2.classList.toggle("active", n === 2);
            step3.classList.toggle("active", n === 3);
          };

          // Step 1: provider cards
          root.querySelectorAll(".ace-wiz-provider").forEach(card => {
            card.addEventListener("click", () => {
              selectedProvider = card.dataset.provider;
              const isLocal = (selectedProvider === "ollama" || selectedProvider === "lmstudio");
              const signup = AceSettings.PROVIDER_SIGNUP[selectedProvider];
              const defaults = AceSettings.PROVIDER_DEFAULTS[selectedProvider];

              // Ollama-specific quick-start tip box (vision model + OLLAMA_ORIGINS)
              const ollamaTips = root.querySelector(".ace-wiz-ollama-tips");
              if (ollamaTips) {
                ollamaTips.style.display = (selectedProvider === "ollama") ? "block" : "none";
              }

              if (isLocal) {
                keyInput.style.display = "none";
                localHint.style.display = "block";
                keyInstructions.textContent = `${selectedProvider === "ollama" ? "Ollama" : "LM Studio"} runs locally — no API key needed.`;
              } else {
                keyInput.style.display = "";
                localHint.style.display = "none";
                keyInput.value = "";
                keyInstructions.textContent = `Paste your ${providers.find(p => p.id === selectedProvider)?.name ?? ""} API key below.`;
              }

              if (signup?.url) {
                signupLink.href = signup.url;
                signupLink.innerHTML = `<i class="fas fa-external-link-alt"></i> <span>${signup.label}</span>`;
                signupLink.style.display = "inline-flex";
              } else {
                signupLink.style.display = "none";
              }

              testResult.style.display = "none";
              goToStep(2);
            });
          });

          // Step 2: back button
          root.querySelector(".ace-wiz-back")?.addEventListener("click", () => goToStep(1));

          // Step 2: test button
          root.querySelector(".ace-wiz-test")?.addEventListener("click", async () => {
            const testBtn = root.querySelector(".ace-wiz-test");
            testBtn.disabled = true;
            testBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> TESTING\u2026';
            testResult.style.display = "none";

            const defaults = AceSettings.PROVIDER_DEFAULTS[selectedProvider] ?? {};
            const apiKey = keyInput.value.trim();
            const apiUrl = defaults.apiUrl ?? "";
            const modelName = defaults.modelName ?? "";

            const result = await AceSettings.testConnection(selectedProvider, apiKey, apiUrl, modelName);

            testResult.style.display = "block";
            if (result.ok) {
              testResult.className = "ace-wiz-test-result success";
              testResult.innerHTML = `<i class="fas fa-check-circle"></i> Connected to <strong>${result.model}</strong> \u2014 saving settings\u2026`;
              testBtn.innerHTML = '<i class="fas fa-crown"></i> CONNECTED';

              // Save the settings
              try {
                await game.settings.set(MODULE_ID, "aiProvider", selectedProvider);
                await game.settings.set(MODULE_ID, "apiUrl", apiUrl);
                await game.settings.set(MODULE_ID, "modelName", modelName);
                // ⚠️ setSecret, NOT settings.set. This line is what re-leaked
                // the key after a clean migration — see setSecret's note.
                if (apiKey) await setSecret("apiKey", apiKey);
                await game.settings.set(MODULE_ID, "setupComplete", true);
              } catch (err) {
                console.error(`${MODULE_ID} | Wizard: failed to save settings`, err);
              }

              // Transition to step 3 after a beat
              setTimeout(() => goToStep(3), 1200);
            } else {
              testResult.className = "ace-wiz-test-result fail";
              testResult.innerHTML = `<i class="fas fa-exclamation-triangle"></i> ${result.error}`;
              testBtn.innerHTML = '<i class="fas fa-plug"></i> TRY AGAIN';
              testBtn.disabled = false;
            }
          });
        },
        close: () => {
          game.settings.set(MODULE_ID, "setupComplete", true);
          resolve(false);
        },
      }, {
        width: 460,
        height: "auto",
        resizable: true,
        classes: ["ace-setup-dialog"],
      });
      dlg.render(true);
    });
  }

  /** Get the active game system name for context injection */
  static getGameSystemName() {
    const setting = game.settings.get(MODULE_ID, "gameSystem");
    if (setting === "auto") {
      const systemTitle = game.system?.title ?? "";
      const systemId = game.system?.id ?? "";
      return systemTitle || systemId || "Unknown System";
    }
    const choices = {
      dnd5e: "D&D 5th Edition",
      pf2e: "Pathfinder 2e",
      pf1e: "Pathfinder 1e",
      dnd4e: "D&D 4th Edition",
      "13a": "13th Age",
      swade: "Savage Worlds",
      coc7e: "Call of Cthulhu 7e",
      wfrp4e: "Warhammer Fantasy 4e",
      fate: "Fate Core / Accelerated",
      pbta: "Powered by the Apocalypse",
      bitd: "Blades in the Dark",
      sw5e: "SW5e (Star Wars 5e)",
      cyberpunkred: "Cyberpunk RED",
      shadowrun: "Shadowrun",
      gurps: "GURPS",
      other: "Other",
    };
    return choices[setting] ?? setting;
  }

  /** Get ACE Engine's AI provider config. Engine is always the source of truth. */
  static getProviderConfig() {
    const provider  = game.settings.get(MODULE_ID, "aiProvider");
    const defaults  = AceSettings.PROVIDER_DEFAULTS[provider] ?? {};
    return {
      provider,
      // ⚠️ getSecret, NOT the world name. This is THE read every AI call goes
      // through (ai-provider.mjs constructs from it), so leaving it on the
      // world setting meant the "fixed" read path was bypassed by the one
      // consumer that matters.
      apiKey:    getSecret("apiKey"),
      apiUrl:    game.settings.get(MODULE_ID, "apiUrl")   || defaults.apiUrl   || "https://api.openai.com",
      modelName: game.settings.get(MODULE_ID, "modelName") || defaults.modelName || "gpt-4o-mini",
    };
  }
}


/**
 * Write an AI secret. ALWAYS client-scoped, never the world name.
 *
 * ⚠️🔴 THE READ PATH WAS FIXED AND THE WRITE PATH UNDID IT (Brock audit,
 * 2026-08-19). 1.7.80 added getSecret() and a boot migration that blanks the
 * world copy — and then the setup wizard and config panel kept calling
 * `game.settings.set(MODULE_ID, "apiKey", …)` directly. So a GM whose world was
 * cleanly migrated re-leaked their key to every connected player the first time
 * they pressed Save. The audit comment describing that exact failure sat 2,100
 * lines above the wizard that caused it.
 *
 * A read-side fix to a leak is not a fix. The value has to STOP ARRIVING in
 * world scope, which means every write goes through here and the world names
 * are only ever blanked.
 */
export async function setSecret(name, value) {
  const map = {
    apiKey: "apiKeySecure",
    chatApiKey: "chatApiKeySecure",
    digestApiKey: "digestApiKeySecure",
  };
  const secure = map[name] ?? name;
  await game.settings.set(MODULE_ID, secure, value ?? "");
  // ⚠️ Blank the legacy world name on every write, not just at migration.
  // Anything that wrote it before this release, or any older client still
  // running, gets cleaned up the next time the GM saves.
  if (map[name]) {
    try {
      if (game.settings.get(MODULE_ID, name)) await game.settings.set(MODULE_ID, name, "");
    } catch (_) { /* not registered on this build — fine */ }
  }
}

/** Write the per-provider vault. Client-scoped, world copy blanked. */
export async function setSecretVault(vault) {
  await game.settings.set(MODULE_ID, "apiKeysByProviderSecure", vault ?? {});
  try {
    const legacy = game.settings.get(MODULE_ID, "apiKeysByProvider");
    if (legacy && Object.keys(legacy).length) await game.settings.set(MODULE_ID, "apiKeysByProvider", {});
  } catch (_) { /* fine */ }
}

/** Is this setting key a secret? Used to route generic config-panel writes. */
export function isSecretKey(name) {
  return ["apiKey", "chatApiKey", "digestApiKey", "apiKeySecure", "chatApiKeySecure", "digestApiKeySecure"].includes(name);
}

/**
 * Read an AI secret. Client-scoped first; legacy world value only as a
 * fallback so a GM who has not migrated yet still works.
 *
 * ⚠️ Never read the legacy names directly anywhere else.
 */
export function getSecret(name) {
  const map = {
    apiKey: "apiKeySecure",
    chatApiKey: "chatApiKeySecure",
    digestApiKey: "digestApiKeySecure",
  };
  const secure = map[name];
  try {
    if (secure) {
      const v = game.settings.get(MODULE_ID, secure);
      if (v) return v;
    }
    return game.settings.get(MODULE_ID, name) || "";
  } catch (_) { return ""; }
}

/** Per-provider vault, client-scoped, with legacy fallback. */
export function getSecretVault() {
  try {
    const v = game.settings.get(MODULE_ID, "apiKeysByProviderSecure");
    if (v && Object.keys(v).length) return v;
    return game.settings.get(MODULE_ID, "apiKeysByProvider") || {};
  } catch (_) { return {}; }
}

/**
 * Move any world-scoped secret into client scope and BLANK the world copy.
 * GM only, idempotent, runs once per client at ready.
 */
export async function migrateSecretsToClientScope() {
  if (!game.user?.isGM) return;
  const pairs = [
    ["apiKey", "apiKeySecure"],
    ["chatApiKey", "chatApiKeySecure"],
    ["digestApiKey", "digestApiKeySecure"],
  ];
  let moved = 0;
  for (const [legacy, secure] of pairs) {
    try {
      const old = game.settings.get(MODULE_ID, legacy);
      if (!old) continue;
      if (!game.settings.get(MODULE_ID, secure)) {
        await game.settings.set(MODULE_ID, secure, old);
      }
      await game.settings.set(MODULE_ID, legacy, "");   // stop broadcasting it
      moved++;
    } catch (err) {
      console.warn(`${MODULE_ID} | secret migration failed for "${legacy}":`, err);
    }
  }
  try {
    const oldVault = game.settings.get(MODULE_ID, "apiKeysByProvider") || {};
    if (Object.keys(oldVault).length) {
      const cur = game.settings.get(MODULE_ID, "apiKeysByProviderSecure") || {};
      if (!Object.keys(cur).length) {
        await game.settings.set(MODULE_ID, "apiKeysByProviderSecure", oldVault);
      }
      await game.settings.set(MODULE_ID, "apiKeysByProvider", {});
      moved++;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | secret vault migration failed:`, err);
  }
  if (moved) {
    console.log(`${MODULE_ID} | Moved ${moved} secret(s) out of world scope into this client. Players can no longer read them.`);
    ui.notifications?.info(`ACE Engine: ${moved} API key(s) moved to GM-only storage. They were previously readable by any player.`);
  }
}
