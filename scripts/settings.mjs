// ============================================================
// ACE — AI Campaign Engine — Settings Registration
// ============================================================

import { MODULE_ID } from "./ace-engine.mjs";

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
    const s = (key, data) =>
      game.settings.register(MODULE_ID, key, {
        scope: "world",
        config: true,
        ...data,
      });

    // ── AI Provider ─────────────────────────────────────────
    s("aiProvider", {
      name: "ACE.Settings.AiProvider.Name",
      hint: "ACE.Settings.AiProvider.Hint",
      type: String,
      choices: {
        openai: "OpenAI / ChatGPT (free tier available)",
        anthropic: "Anthropic (Claude)",
        ollama: "Ollama (Local — free, requires install)",
        lmstudio: "LM Studio (Local — free, requires install)",
        openrouter: "OpenRouter (many models, pay-per-use)",
        custom: "Custom OpenAI-Compatible endpoint",
      },
      default: "ollama",
    });

    s("apiKey", {
      name: "ACE.Settings.ApiKey.Name",
      hint: "ACE.Settings.ApiKey.Hint",
      type: String,
      default: "",
    });

    s("apiUrl", {
      name: "ACE.Settings.ApiUrl.Name",
      hint: "ACE.Settings.ApiUrl.Hint",
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

    s("modelName", {
      name: "ACE.Settings.ModelName.Name",
      hint: "ACE.Settings.ModelName.Hint",
      type: String,
      choices: {
        // ── Cloud: OpenAI ──
        "gpt-4o":                "GPT-4o (best quality, $$)",
        "gpt-4o-mini":           "⭐ GPT-4o Mini (fast + great quality, $) — Recommended",
        "gpt-4.1":              "GPT-4.1 (latest, $$)",
        "gpt-4.1-mini":         "GPT-4.1 Mini (latest mini, $)",
        "gpt-4.1-nano":         "GPT-4.1 Nano (blazing fast, cheapest)",
        // ── Cloud: Anthropic ──
        "claude-sonnet-4-20250514":  "Claude Sonnet 4 (excellent RP, $$)",
        "claude-haiku-4-5-20251001": "Claude Haiku 4.5 (blazing fast, $)",
        // ── Local: Ollama / LM Studio ──
        "llama3.2":              "Llama 3.2 (8B — blazing fast)",
        "llama3.1":              "Llama 3.1 (8B — balanced)",
        "llama3.1:70b":          "Llama 3.1 (70B — best local, slow)",
        "mistral":               "Mistral (7B — blazing fast)",
        "mixtral":               "Mixtral (8x7B — great quality)",
        "qwen2.5-coder:32b":    "⭐ Qwen 2.5 Coder (32B — best local RP) — Recommended",
        "qwen2.5:14b":           "Qwen 2.5 (14B — good balance)",
        "qwen2.5:32b":           "Qwen 2.5 (32B — excellent)",
        "deepseek-r1:14b":       "DeepSeek R1 (14B — reasoning)",
        "deepseek-r1:32b":       "DeepSeek R1 (32B — strong reasoning)",
        "gemma2":                "Gemma 2 (9B — blazing fast)",
        "nous-hermes2":          "Nous Hermes 2 (great RP)",
        // ── OpenRouter ──
        "openai/gpt-4o":         "OpenRouter → GPT-4o",
        "openai/gpt-4o-mini":    "OpenRouter → GPT-4o Mini",
        "anthropic/claude-sonnet-4-20250514": "OpenRouter → Claude Sonnet 4",
        "google/gemini-2.0-flash-001": "OpenRouter → Gemini 2.0 Flash (blazing fast)",
        "meta-llama/llama-3.1-70b-instruct": "OpenRouter → Llama 3.1 70B",
      },
      default: "gpt-4o-mini",
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
        "":                                       "— Same as main model —",
        // ── OpenAI (cheapest for extraction) ──
        "openai:gpt-4o-mini":                     "⭐ OpenAI: GPT-4o Mini (~$0.50/book) — Best Value",
        "openai:gpt-4.1-nano":                    "OpenAI: GPT-4.1 Nano (cheapest)",
        "openai:gpt-4.1-mini":                    "OpenAI: GPT-4.1 Mini",
        "openai:gpt-4o":                          "OpenAI: GPT-4o ($$)",
        // ── Anthropic ──
        "anthropic:claude-haiku-4-5-20251001":    "Anthropic: Claude Haiku 4.5 (~$4/book)",
        "anthropic:claude-sonnet-4-20250514":     "Anthropic: Claude Sonnet 4 ($$$)",
        // ── Local (free) ──
        "ollama:qwen2.5-coder:32b":              "Ollama: Qwen 2.5 Coder 32B (free)",
        "ollama:qwen2.5:14b":                    "Ollama: Qwen 2.5 14B (free)",
        "ollama:llama3.1":                       "Ollama: Llama 3.1 8B (free)",
      },
      default: "",
    });

    // "useEnvoyKeys" removed — sync direction is now Envoy → reads from Engine
    // (see ace-envoy "useAceEngineSettings" toggle instead)

    // ── Game System ─────────────────────────────────────────
    s("gameSystem", {
      name: "ACE.Settings.GameSystem.Name",
      hint: "ACE.Settings.GameSystem.Hint",
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
      name: "ACE.Settings.SystemPrompt.Name",
      hint: "ACE.Settings.SystemPrompt.Hint",
      type: String,
      default: DEFAULT_SYSTEM_PROMPT,
    });

    s("autoSuggestions", {
      name: "ACE.Settings.AutoSuggestions.Name",
      hint: "ACE.Settings.AutoSuggestions.Hint",
      type: Boolean,
      default: false,
    });

    s("suggestionInterval", {
      name: "ACE.Settings.SuggestionInterval.Name",
      hint: "ACE.Settings.SuggestionInterval.Hint",
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
      name: "ACE.Settings.MaxContextTokens.Name",
      hint: "ACE.Settings.MaxContextTokens.Hint",
      type: Number,
      default: 4000,
      range: { min: 500, max: 16000, step: 500 },
    });

    s("maxResponseTokens", {
      name: "ACE.Settings.MaxResponseTokens.Name",
      hint: "ACE.Settings.MaxResponseTokens.Hint",
      type: Number,
      default: 2048,
      range: { min: 256, max: 8192, step: 256 },
    });

    // ── Feature Toggles ────────────────────────────────────
    s("enableCritFumble", {
      name: "ACE.Settings.EnableCritFumble.Name",
      hint: "ACE.Settings.EnableCritFumble.Hint",
      type: Boolean,
      default: true,
    });

    s("enableSurvivalTracker", {
      name: "ACE.Settings.EnableSurvivalTracker.Name",
      hint: "ACE.Settings.EnableSurvivalTracker.Hint",
      type: Boolean,
      default: true,
    });

    s("enableStoryNotes", {
      name: "ACE.Settings.EnableStoryNotes.Name",
      hint: "ACE.Settings.EnableStoryNotes.Hint",
      type: Boolean,
      default: true,
    });

    s("enableFameSystem", {
      name: "ACE.Settings.EnableFameSystem.Name",
      hint: "ACE.Settings.EnableFameSystem.Hint",
      type: Boolean,
      default: true,
    });

    s("enableNarrativeTime", {
      name: "ACE.Settings.EnableNarrativeTime.Name",
      hint: "ACE.Settings.EnableNarrativeTime.Hint",
      type: Boolean,
      default: true,
    });

    s("syncSimpleCalendar", {
      name: "ACE.Settings.SyncSimpleCalendar.Name",
      hint: "ACE.Settings.SyncSimpleCalendar.Hint",
      type: Boolean,
      default: false,
    });

    // ── Document Library ────────────────────────────────────
    s("enableDocumentLibrary", {
      name: "ACE.Settings.EnableDocumentLibrary.Name",
      hint: "ACE.Settings.EnableDocumentLibrary.Hint",
      type: Boolean,
      default: true,
    });

    s("docContextBudget", {
      name: "ACE.Settings.DocContextBudget.Name",
      hint: "ACE.Settings.DocContextBudget.Hint",
      type: Number,
      default: 4000,
      range: { min: 0, max: 50000, step: 500 },
    });

    s("enableVisionImages", {
      name: "ACE.Settings.EnableVisionImages.Name",
      hint: "ACE.Settings.EnableVisionImages.Hint",
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

    // ── ElevenLabs Narration (client-scoped) ────────────────
    s("elevenLabsApiKey", {
      scope: "client",
      name: "ElevenLabs API Key",
      hint: "API key from elevenlabs.io. Set once — works across all worlds in this browser.",
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
      name: "ACE.Settings.DebugMode.Name",
      hint: "ACE.Settings.DebugMode.Hint",
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
      name: "ACE.Settings.EnableSubtleRolls.Name",
      hint: "ACE.Settings.EnableSubtleRolls.Hint",
      type: Boolean,
      default: true,
    });

    s("subtleRollSkills", {
      name: "ACE.Settings.SubtleRollSkills.Name",
      hint: "ACE.Settings.SubtleRollSkills.Hint",
      type: String,
      default: "ins,his,arc,rel,nat,prc,inv,sur,med",
    });

    s("subtleRollAutoDetect", {
      name: "ACE.Settings.SubtleRollAutoDetect.Name",
      hint: "ACE.Settings.SubtleRollAutoDetect.Hint",
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
      { value: "llama3.2",             label: "Llama 3.2 — Fast · ~4GB VRAM" },
      { value: "mistral",              label: "Mistral — Fast · ~5GB VRAM" },
      { value: "qwen2.5-coder:7b",    label: "Qwen 2.5 Coder 7B — Fast · ~6GB VRAM" },
      { value: "qwen2.5-coder:14b",   label: "Qwen 2.5 Coder 14B — Balanced · ~10GB VRAM" },
      { value: "qwen2.5-coder:32b",   label: "Qwen 2.5 Coder 32B — Best Quality · ~20GB VRAM" },
      { value: "deepseek-r1",          label: "DeepSeek R1 — Reasoning · varies" },
      { value: "gemma2",               label: "Gemma 2 — Fast · ~6GB VRAM" },
      { value: "phi3",                 label: "Phi-3 — Fast · ~4GB VRAM" },
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

  /** Mask API keys + replace model input with dynamic dropdown */
  static maskSecretFields() {
    Hooks.on("renderSettingsConfig", (_app, html) => {
      const root = html instanceof HTMLElement ? html : html[0];
      if (!root) return;

      // Mask API key fields as password inputs
      for (const key of ["apiKey", "digestApiKey", "elevenLabsApiKey"]) {
        const input = root.querySelector(`[name="${MODULE_ID}.${key}"]`);
        if (input && input.type !== "password") {
          input.type = "password";
          input.autocomplete = "off";
        }
      }

      const providerSelect = root.querySelector(`[name="${MODULE_ID}.aiProvider"]`);
      const urlInput       = root.querySelector(`[name="${MODULE_ID}.apiUrl"]`);
      const modelInput     = root.querySelector(`[name="${MODULE_ID}.modelName"]`);
      if (!providerSelect || !urlInput || !modelInput) return;

      // Replace the model text input with a <select> dropdown
      const modelSelect = document.createElement("select");
      modelSelect.name = modelInput.name;
      modelSelect.style.cssText = modelInput.style.cssText;
      const savedValue = modelInput.value;
      modelInput.replaceWith(modelSelect);

      /** Add options to the model select element */
      const _fillSelect = (models, currentValue) => {
        modelSelect.innerHTML = "";
        let hasCurrentValue = false;
        for (const m of models) {
          const opt = document.createElement("option");
          opt.value = m.value;
          opt.textContent = m.label;
          if (m.value === currentValue) {
            opt.selected = true;
            hasCurrentValue = true;
          }
          modelSelect.appendChild(opt);
        }
        // If current saved value isn't in the list, add it at the top so it's not lost
        if (currentValue && !hasCurrentValue) {
          const custom = document.createElement("option");
          custom.value = currentValue;
          custom.textContent = `${currentValue} (custom)`;
          custom.selected = true;
          modelSelect.prepend(custom);
        }
      };

      /** Populate model dropdown — queries Ollama/LM Studio live, static list for others */
      const populateModels = async (provider, currentValue) => {
        // Start with static list immediately (no flash of empty dropdown)
        const staticModels = AceSettings.PROVIDER_MODELS[provider] ?? [];
        _fillSelect(staticModels, currentValue);

        // For local providers, query the actual API for installed models
        if (provider === "ollama" || provider === "lmstudio") {
          const localUrl = urlInput.value || AceSettings.PROVIDER_DEFAULTS[provider]?.apiUrl || "http://localhost:11434";
          try {
            const endpoint = provider === "ollama" ? `${localUrl}/api/tags` : `${localUrl}/v1/models`;
            const resp = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
              const data = await resp.json();
              const installed = (provider === "ollama")
                ? (data.models ?? []).map(m => ({ value: m.name, label: `${m.name} (${_formatSize(m.size)})` }))
                : (data.data ?? []).map(m => ({ value: m.id, label: m.id }));

              if (installed.length) {
                // Sort alphabetically, put current value first
                installed.sort((a, b) => a.value.localeCompare(b.value));
                _fillSelect(installed, currentValue);
                console.log(`${MODULE_ID} | Detected ${installed.length} installed ${provider} models`);
              }
            }
          } catch (_) { /* API unreachable — static list is fine */ }
        }
      };

      /** Format byte size to human-readable (e.g., 19234567890 → "17.9 GB") */
      const _formatSize = (bytes) => {
        if (!bytes) return "?";
        const gb = bytes / (1024 ** 3);
        return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
      };

      // Initial population
      populateModels(providerSelect.value, savedValue);

      // ── "Get API Key" link — changes with provider ─────────
      const signupLink = document.createElement("a");
      signupLink.className = "ace-settings-signup-link";
      signupLink.target = "_blank";
      signupLink.rel = "noopener";
      signupLink.style.cssText = "display:inline-block;margin-top:4px;font-size:0.85em;color:#c9a84c;text-decoration:underline;cursor:pointer;";
      const updateSignupLink = (provider) => {
        const info = AceSettings.PROVIDER_SIGNUP[provider];
        if (info?.url) {
          signupLink.href = info.url;
          signupLink.textContent = `🔗 ${info.label}`;
          signupLink.style.display = "inline-block";
        } else {
          signupLink.style.display = "none";
        }
      };
      updateSignupLink(providerSelect.value);
      // Insert the link after the API key field's parent form-group
      const apiKeyInput = root.querySelector(`[name="${MODULE_ID}.apiKey"]`);
      if (apiKeyInput) {
        const keyGroup = apiKeyInput.closest(".form-group") ?? apiKeyInput.parentElement;
        keyGroup?.appendChild(signupLink);
      }

      // ── Test Connection button ──────────────────────────────
      const testBtn = document.createElement("button");
      testBtn.type = "button";
      testBtn.className = "ace-test-connection-btn";
      testBtn.innerHTML = '<i class="fas fa-plug"></i> Test Connection';
      testBtn.style.cssText = "margin-top:8px;padding:5px 14px;background:#1a1a1e;border:1px solid #c9a84c;border-radius:4px;color:#c9a84c;cursor:pointer;font-size:0.85em;transition:all 0.2s;";
      testBtn.addEventListener("mouseenter", () => { testBtn.style.background = "#2a2a2e"; testBtn.style.boxShadow = "0 0 6px rgba(212,175,55,0.3)"; });
      testBtn.addEventListener("mouseleave", () => { testBtn.style.background = "#1a1a1e"; testBtn.style.boxShadow = "none"; });
      testBtn.addEventListener("click", async () => {
        testBtn.disabled = true;
        testBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing…';
        const result = await AceSettings.testConnection(
          providerSelect.value,
          apiKeyInput?.value ?? "",
          urlInput.value,
          modelSelect.value,
        );
        if (result.ok) {
          testBtn.innerHTML = '<i class="fas fa-check" style="color:#5db88a;"></i> Connected!';
          testBtn.style.borderColor = "#5db88a";
          ui.notifications?.info(`ACE: Connection successful — ${result.model} responded.`);
        } else {
          testBtn.innerHTML = '<i class="fas fa-times" style="color:#c43b3b;"></i> Failed';
          testBtn.style.borderColor = "#c43b3b";
          ui.notifications?.error(`ACE: ${result.error}`);
        }
        setTimeout(() => {
          testBtn.innerHTML = '<i class="fas fa-plug"></i> Test Connection';
          testBtn.style.borderColor = "#c9a84c";
          testBtn.disabled = false;
        }, 4000);
      });

      // Insert test button after the model dropdown's form-group
      const modelGroup = modelSelect.closest(".form-group") ?? modelSelect.parentElement;
      if (modelGroup) modelGroup.appendChild(testBtn);

      // When provider changes: update URL, update model dropdown, select default
      providerSelect.addEventListener("change", () => {
        const newProvider = providerSelect.value;
        const defaults = AceSettings.PROVIDER_DEFAULTS[newProvider];
        if (!defaults) return;

        // Auto-fill URL if it's a known default (don't overwrite custom URLs)
        const knownUrls = Object.values(AceSettings.PROVIDER_DEFAULTS).map(d => d.apiUrl);
        if (!urlInput.value || knownUrls.includes(urlInput.value)) {
          urlInput.value = defaults.apiUrl;
        }

        // Repopulate model dropdown and select the default for this provider
        populateModels(newProvider, defaults.modelName);

        // Update signup link
        updateSignupLink(newProvider);
      });
    });
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
      // Detect CORS specifically
      if (err instanceof TypeError && err.message.includes("Failed to fetch")) {
        if (/localhost|127\.0\.0\.1/.test(apiUrl)) {
          return { ok: false, error: `Cannot reach ${apiUrl} — CORS issue. Set OLLAMA_ORIGINS=* and restart.` };
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
                if (apiKey) await game.settings.set(MODULE_ID, "apiKey", apiKey);
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
      apiKey:    game.settings.get(MODULE_ID, "apiKey"),
      apiUrl:    game.settings.get(MODULE_ID, "apiUrl")   || defaults.apiUrl   || "https://api.openai.com",
      modelName: game.settings.get(MODULE_ID, "modelName") || defaults.modelName || "gpt-4o-mini",
    };
  }
}
