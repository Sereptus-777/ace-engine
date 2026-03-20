// ============================================================
// ACE — AI Campaign Engine — World Bible Engine
// Generates and stores a comprehensive world reference bible
// via chunked AI calls. Supports pause/resume/cancel, WIP saves,
// and double backup (world dir + global library).
// ============================================================

const MODULE_ID = "ace-engine";
const GLOBAL_BIBLE_DIR = "ace-engine-library/world-bibles";
const BIBLE_FILENAME = "ace-world-bible.json";

// v13-safe FilePicker access
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ??
  globalThis.FilePicker;

/** Silent upload — suppresses Foundry notification toast. */
let _silentDepth = 0;
let _origNotifyInfo = null;
async function _silentUpload(source, dir, file) {
  try {
    if (ui.notifications) {
      if (_silentDepth === 0) _origNotifyInfo = ui.notifications.info;
      _silentDepth++;
      ui.notifications.info = () => {};
    }
    return await _FP().upload(source, dir, file, { notify: false });
  } finally {
    if (ui.notifications && _silentDepth > 0) {
      _silentDepth--;
      if (_silentDepth === 0 && _origNotifyInfo) {
        ui.notifications.info = _origNotifyInfo;
        _origNotifyInfo = null;
      }
    }
  }
}

// ── Region Definitions ─────────────────────────────────────────
// Each region becomes one AI call. Prompt hints ensure thorough coverage.

const FAERUN_REGIONS = [
  {
    id: "the_north",
    name: "The North & Icewind Dale",
    hints: "Cover: Luskan (pirate city), Mirabar (mining), Icewind Dale & Ten Towns, Spine of the World, Silverymoon (Gem of the North), Sundabar, Citadel Adbar (dwarven), Mithral Hall (dwarven), Everlund, the Silver Marches/Luruar confederation, Helm's Hold, Gauntlgrym. Include: Arcane Brotherhood (Luskan), Knights in Silver (Silverymoon), Uthgardt barbarian tribes, frost giants, orc hordes of Many-Arrows (post-Obould)."
  },
  {
    id: "sword_coast",
    name: "The Sword Coast",
    hints: "Cover: Waterdeep (City of Splendors — Masked Lords, guilds, Skullport), Neverwinter (rebuilding post-eruption of Mount Hotenow), Baldur's Gate (Flaming Fist, Parliament of Peers, Lower/Upper city divide), Daggerford, Leilon, the Mere of Dead Men, Thornhold, Mintarn. Include: Lords' Alliance presence, Shadow Thieves, various guilds, pirate activity."
  },
  {
    id: "western_heartlands",
    name: "The Western Heartlands",
    hints: "Cover: Elturgard & Elturel (Companions, paladins), Berdusk, Iriaebor (City of a Thousand Spires), Scornubel (Caravan City), Darkhold (Zhentarim fortress), Red Larch, Triboar, Yartar, Fields of the Dead, Serpent Hills, Reaching Woods. Include: Zhentarim trade operations, Order of the Gauntlet presence, caravan trade routes (Trade Way, Long Road)."
  },
  {
    id: "cormyr",
    name: "Cormyr & the Dragon Coast",
    hints: "Cover: Suzail (capital, Royal Palace), Marsember (port city), Arabel, Eveningstar, Tilverton (destroyed ruins), High Horn, Castle Crag, Proskur, Westgate (Dragon Coast). Include: Purple Dragons (army), War Wizards, the Obarskyr dynasty, Crown politics, Cormyr's strict adventurer charter laws, nobility, Forest Kingdom traditions, Storm Horns, King's Forest, Hullack Forest."
  },
  {
    id: "sembia_the_vast",
    name: "Sembia & the Vast",
    hints: "Cover: Selgaunt, Saerloon, Ordulin (rebuilt), Daerlun, Urmlaspyr, Ravens Bluff (the Vast), Procampur, Tsurlagol. Include: Sembian merchant oligarchy, rivalry with Cormyr, Netherese influence aftermath, trade politics, Vast trading houses, mercantile culture, Sembian coin-worship mentality."
  },
  {
    id: "dalelands",
    name: "The Dalelands & Cormanthor",
    hints: "Cover: Shadowdale (famous for Elminster), Mistledale, Battledale, Deepingdale, Featherdale, Tasseldale, Scardale, Archendale, Daggerdale, Myth Drannor (restored elven city), Cormanthor Forest, Elven Court. Include: The Dales Compact (elves and humans), Zhentarim incursions, Harper presence, independent dale governance, Elminster's legacy, Standing Stone."
  },
  {
    id: "moonsea",
    name: "The Moonsea Region",
    hints: "Cover: Zhentil Keep (rebuilt), Hillsfar (arena, anti-non-human laws), Phlan (frontier town, pool of radiance), Mulmaster (Blades, tharchions), Melvaunt, Thentia, Yulash (ruins), Voonlar, Teshwave, Citadel of the Raven, the Dragonspine Mountains. Include: Zhentarim dominance, Bane worship resurgence, Moonsea's harsh politics, Red Plumes of Hillsfar."
  },
  {
    id: "damara_vaasa",
    name: "Damara, Vaasa & Impiltur",
    hints: "Cover: Bloodstone Pass, Heliogabalus (capital of Damara), Garcastle, Castle Perilous (Vaasa), Zhengyi the Witch-King's legacy, Impiltur (Lyrabar capital), Sarshel, the Earthfast Mountains, the Great Glacier edge, Firward Gate. Include: Damaran royalty, Warlock Knights of Vaasa, Impilturan demon-fighting history, Bloodstone Lands."
  },
  {
    id: "thay_aglarond_rashemen",
    name: "Thay, Aglarond & Rashemen",
    hints: "Cover: Thay (Szass Tam's undead nation, tharch system, Eltabbar, Bezantur, Thaymount), Aglarond (Simbul's legacy, Velprintalar, Yuirwood, half-elven nation), Rashemen (berserkers, hathrans/witches, Immilmar, spirits of the land, Rashemi tradition). Include: Red Wizards abroad (enclaves/trade), Thayan undead army, Aglarond-Thay tensions, Rashemi lodge traditions."
  },
  {
    id: "mulhorand_unther_chessenta",
    name: "Mulhorand, Unther & Chessenta",
    hints: "Cover: Mulhorand (god-kings returned, Skuld, Gheldaneth, Egyptian-styled culture), Unther (restored, Mesopotamian-styled, Unthalass), Chessenta (warrior city-states, Cimbar, Luthcheq, Akanax, Soorenar), Tchazzar the dragon, Chessentan gladiatorial culture. Include: Mulhorandi pantheon (Horus-Re, Isis, Thoth), Untheric rebuilding, Chessentan independence and rivalry."
  },
  {
    id: "calimshan_south",
    name: "Calimshan, Tethyr, Amn & the Shining South",
    hints: "Cover: Calimshan (Calimport, Memnon, genasi influence, Calim Desert, djinn/efreeti history), Tethyr (restored monarchy, Darromar), Amn (Athkatla, Council of Six, merchant nation, shadow thieves), Lake of Steam region, Border Kingdoms, Lapaliiya, Halruaa (mageocracy, post-Spellplague). Include: Amnian greed/merchant culture, Tethyrian civil war aftermath, Calishite social castes."
  },
  {
    id: "anauroch",
    name: "Anauroch & the Fallen Netheril",
    hints: "Cover: Anauroch (the Great Desert — former Netherese heartland), Shade Enclave (fell from sky, destroyed), Bedine nomads, the Buried Realms, Netherese ruins, phaerimm legacy, Zhentarim caravan routes through the desert, the Columns of the Sky, oases, ancient Netherese floating cities (now ruins). Include: Post-Shade Enclave politics, desert dangers, lingering Netherese magic."
  },
  {
    id: "the_east",
    name: "The East — Thesk, the Hordelands & the Desert of Desolation",
    hints: "Cover: Thesk (Two Stars, Phsant, Tammar — Tuigan horde aftermath, rebuilt trade), the Golden Way trade route, Narfell (ancient demon-pact empire ruins), Raurin (Desert of Desolation — ancient Imaskari ruins, buried tombs, sandstorm dangers), the Hordelands/Endless Wastes, Kara-Tur border regions, Semphar, Murghôm. Include: Tuigan invasion legacy, Imaskari history, Raurin adventure hooks, eastern trade connections."
  }
];

// ── Generation Prompts ─────────────────────────────────────────

function buildRegionPrompt(region) {
  return `You are generating a structured World Bible entry for a Forgotten Realms (Faerûn) campaign set in the POST-SUNDERING era (5th Edition D&D, circa 1489-1496 DR). Use ONLY canonical 5e lore (post-Sundering timeline). Where 5e sources are silent, use the most recent canonical information available.

Generate comprehensive data for: **${region.name}**
${region.hints}

Return ONLY valid JSON with this exact structure:
{
  "nations": [
    {
      "id": "snake_case_unique_id",
      "name": "Full Name",
      "type": "empire|kingdom|city-state|theocracy|magocracy|tribal_confederation|confederation|republic",
      "region": "${region.id}",
      "ruler": "Name and Title",
      "government": "Type of government",
      "capital": "Capital city name",
      "population": "Approximate (e.g. '1.4 million')",
      "description": "2-3 sentences covering history, character, and current state",
      "culture": "1-2 sentences on customs, attitudes, daily life",
      "economy": "Primary industries and trade goods",
      "military": "Notable military forces and strength",
      "allies": ["other_nation_or_faction_ids"],
      "enemies": ["other_nation_or_faction_ids"],
      "tensions": "Current political tensions or conflicts (1-2 sentences)"
    }
  ],
  "cities": [
    {
      "id": "snake_case_unique_id",
      "name": "Full Name",
      "nation": "nation_id or 'independent'",
      "region": "${region.id}",
      "type": "capital|major_city|city|town|fortress|port|ruins",
      "population": "Approximate or 'unknown'",
      "description": "2-3 sentences",
      "notable": "Key landmarks, districts, or features",
      "localFactions": ["faction_ids_present_here"],
      "religions": ["deity_ids_worshipped_here"],
      "rumors": "1-2 current rumors, local concerns, or adventure hooks"
    }
  ],
  "factions": [
    {
      "id": "snake_case_unique_id",
      "name": "Full Name",
      "type": "military|arcane|religious|criminal|mercantile|political|secret_society|guild|tribal|knightly_order",
      "scope": "local|national|regional|continental",
      "nation": "nation_id or null if multi-national",
      "headquarters": "city_id or general location",
      "leader": "Name and Title",
      "purpose": "1 sentence core mission/goal",
      "description": "2-3 sentences covering history, methods, reputation",
      "allies": ["faction_or_nation_ids"],
      "enemies": ["faction_or_nation_ids"],
      "presence": ["city_ids_where_active"]
    }
  ],
  "religions": [
    {
      "id": "snake_case_deity_id",
      "deity": "Deity Name",
      "title": "Full title (e.g. 'Goddess of Magic')",
      "domains": ["Cleric Domain names"],
      "alignment": "Two-axis alignment",
      "strongholds": ["city_ids_with_major_temples"],
      "worshippers": "Who typically worships this deity in this region",
      "description": "1-2 sentences on the faith's character and practices"
    }
  ],
  "geography": [
    {
      "id": "snake_case_id",
      "name": "Full Name",
      "type": "mountain_range|forest|desert|river|lake|sea|swamp|plains|glacier|island",
      "description": "1-2 sentences covering character and dangers",
      "notable": "Key features, ruins, or inhabitants"
    }
  ]
}

Rules:
- Be THOROUGH — include every named settlement, faction, and deity relevant to this region
- IDs must be snake_case, unique, and descriptive (e.g. "purple_dragons" not "faction_1")
- Cross-reference IDs should be consistent (if Cormyr's id is "cormyr", reference it as "cormyr" everywhere)
- For factions that span multiple regions, include them with their LOCAL presence in this region
- Include geography entries for all notable terrain features
- Return ONLY the JSON — no explanation, no markdown fences, no comments`;
}

const GLOBAL_FACTIONS_PROMPT = `You are generating the CONTINENT-WIDE FACTIONS and FULL PANTHEON for a Forgotten Realms (Faerûn) World Bible, POST-SUNDERING era (5e D&D, circa 1489-1496 DR).

These are organizations and deities that operate across ALL of Faerûn, not limited to one region.

Return ONLY valid JSON:
{
  "globalFactions": [
    {
      "id": "snake_case_id",
      "name": "Full Name",
      "type": "secret_society|mercenary|criminal|religious|political|mercantile|knightly_order|arcane",
      "scope": "continental",
      "headquarters": "Primary base city or 'decentralized'",
      "leader": "Name and Title (current, post-Sundering)",
      "purpose": "1 sentence core mission",
      "description": "3-4 sentences — history, methods, reputation, current activities",
      "allies": ["faction_ids"],
      "enemies": ["faction_ids"],
      "presence": ["major city_ids where they operate"],
      "playerRelevance": "How adventurers typically encounter or interact with this faction"
    }
  ],
  "pantheon": [
    {
      "id": "snake_case_deity_id",
      "deity": "Deity Name",
      "title": "Full title",
      "portfolio": "What they are god/goddess of",
      "domains": ["5e Cleric Domains"],
      "alignment": "Two-axis alignment",
      "symbol": "Holy symbol description",
      "worshippers": "Typical worshippers",
      "description": "2-3 sentences on the faith, practices, and current state post-Sundering"
    }
  ]
}

Include these factions (and any others of continental importance):
- The Harpers (secret society opposing tyranny)
- The Zhentarim / Black Network (mercenary/criminal trade)
- The Lords' Alliance (political coalition of cities)
- The Emerald Enclave (nature preservation)
- The Order of the Gauntlet (holy warriors against evil)
- The Red Wizards of Thay (abroad, not in Thay — their trade enclaves)
- The Cult of the Dragon (dracolich → Tiamat worshippers post-Tyranny of Dragons)
- The Arcane Brotherhood (Luskan-based wizards)
- Shadow Thieves (Amnian crime syndicate)
- The Church of Shar (Nightsinger's faithful)
- The Xanathar Guild (Waterdeep/Skullport beholder crime lord)

For the Pantheon, include ALL major Faerûnian deities (the full post-Sundering pantheon — typically 30+ deities). Include dead/dormant gods only if they have lasting impact.

Rules:
- Use ONLY canonical 5e post-Sundering lore
- IDs must be snake_case and consistent with region entries
- Return ONLY JSON — no explanation, no markdown`;


// ── WorldBibleEngine ─────────────────────────────────────────

export class WorldBibleEngine {
  constructor() {
    this._bible = null;           // The loaded world bible data
    this._loaded = false;
    this._dirty = false;

    // Generation state
    this._running = false;
    this._paused = false;
    this._cancelled = false;
    this._pauseResolve = null;
  }

  /** Check if a bible is loaded and has content. */
  get hasData() {
    return this._bible && this._bible.regions && Object.keys(this._bible.regions).length > 0;
  }

  /** Get the loaded bible data (or null). */
  get data() { return this._bible; }

  /** Whether generation is currently in progress. */
  get isRunning() { return this._running; }

  // ── Pause / Resume / Cancel ────────────────────────────────

  pauseGeneration() {
    this._paused = true;
    console.log(`${MODULE_ID} | World Bible generation paused.`);
  }

  resumeGeneration() {
    this._paused = false;
    if (this._pauseResolve) {
      this._pauseResolve();
      this._pauseResolve = null;
    }
    console.log(`${MODULE_ID} | World Bible generation resumed.`);
  }

  cancelGeneration() {
    this._cancelled = true;
    this.resumeGeneration(); // unblock if paused
    console.log(`${MODULE_ID} | World Bible generation cancelled.`);
  }

  /** @private */
  async _waitIfPaused() {
    if (!this._paused) return;
    return new Promise(resolve => { this._pauseResolve = resolve; });
  }

  // ── File I/O ───────────────────────────────────────────────

  /** Primary file path in the world directory. */
  _primaryPath(worldId) {
    return `worlds/${worldId}/ace-engine/${BIBLE_FILENAME}`;
  }

  /** Ensure directories exist. */
  async _ensureDirectories(worldId) {
    const dirs = [
      `worlds/${worldId}/ace-engine`,
      `worlds/${worldId}/ace-engine/backups`,
      "ace-engine-library",
      GLOBAL_BIBLE_DIR,
    ];
    for (const dir of dirs) {
      try { await _FP().createDirectory("data", dir); }
      catch (e) {
        if (!e.message?.includes("EEXIST") && !e.message?.includes("already exists")) {
          // Directory creation failed for non-exists reason — log but continue
          console.debug(`${MODULE_ID} | Dir ${dir}:`, e.message);
        }
      }
    }
  }

  /**
   * Load the world bible from disk.
   * @param {string} worldId
   */
  async load(worldId) {
    const dir = `worlds/${worldId}/ace-engine`;
    try {
      let exists = false;
      try {
        const listing = await _FP().browse("data", dir);
        exists = (listing?.files ?? []).some(f => f.endsWith(BIBLE_FILENAME));
      } catch (_) { /* dir doesn't exist yet */ }

      if (!exists) {
        console.log(`${MODULE_ID} | World Bible: no file found, starting fresh.`);
        this._loaded = true;
        return;
      }

      const resp = await fetch(this._primaryPath(worldId), { cache: "no-store" });
      if (!resp.ok) {
        console.log(`${MODULE_ID} | World Bible: could not read file, starting fresh.`);
        this._loaded = true;
        return;
      }

      this._bible = await resp.json();
      console.log(`${MODULE_ID} | World Bible: loaded ("${this._bible?.meta?.setting ?? "unknown"}", ${Object.keys(this._bible?.regions ?? {}).length} regions).`);
    } catch (err) {
      console.warn(`${MODULE_ID} | World Bible: load failed (${err.message}). Starting fresh.`);
    }
    this._loaded = true;
  }

  /**
   * Save the world bible to the primary location.
   * @param {string} worldId
   */
  async save(worldId) {
    if (!this._bible || !game.user?.isGM) return;
    await this._ensureDirectories(worldId);

    this._bible.meta.savedAt = new Date().toISOString();
    const payload = JSON.stringify(this._bible, null, 2);
    const file = new File([payload], BIBLE_FILENAME, { type: "application/json" });

    try {
      await _silentUpload("data", `worlds/${worldId}/ace-engine`, file);
      this._dirty = false;
      console.log(`${MODULE_ID} | World Bible: saved (${(payload.length / 1024).toFixed(1)} KB).`);
    } catch (err) {
      console.error(`${MODULE_ID} | World Bible: save failed:`, err);
    }
  }

  /**
   * Create DOUBLE backup:
   * 1) Timestamped copy in worlds/{worldId}/ace-engine/backups/
   * 2) Global copy in ace-engine-library/world-bibles/
   * @param {string} worldId
   */
  async backup(worldId) {
    if (!this._bible || !game.user?.isGM) return;
    await this._ensureDirectories(worldId);

    const ts = new Date().toISOString().replace(/:/g, "-");
    const payload = JSON.stringify(this._bible, null, 2);

    // Backup 1: World directory (timestamped)
    const bkName1 = `ace-world-bible.${ts}.json`;
    const file1 = new File([payload], bkName1, { type: "application/json" });
    try {
      await _silentUpload("data", `worlds/${worldId}/ace-engine/backups`, file1);
      console.log(`${MODULE_ID} | World Bible: backup 1 created (${bkName1}).`);
    } catch (err) {
      console.error(`${MODULE_ID} | World Bible: backup 1 failed:`, err);
    }

    // Backup 2: Global library directory
    const setting = (this._bible.meta?.setting ?? "unknown").replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    const bkName2 = `${setting}-${ts}.json`;
    const file2 = new File([payload], bkName2, { type: "application/json" });
    try {
      await _silentUpload("data", GLOBAL_BIBLE_DIR, file2);
      console.log(`${MODULE_ID} | World Bible: backup 2 created (${bkName2}).`);
    } catch (err) {
      console.error(`${MODULE_ID} | World Bible: backup 2 failed:`, err);
    }
  }

  // ── WIP (Work-in-Progress) Saves ──────────────────────────

  async _saveWip(worldId, wipData) {
    await this._ensureDirectories(worldId);
    const payload = JSON.stringify(wipData, null, 2);
    const file = new File([payload], "_wip_world-bible.json", { type: "application/json" });
    try {
      await _silentUpload("data", `worlds/${worldId}/ace-engine`, file);
    } catch (err) {
      console.warn(`${MODULE_ID} | World Bible: WIP save failed:`, err);
    }
  }

  async _loadWip(worldId) {
    try {
      const dir = `worlds/${worldId}/ace-engine`;
      const listing = await _FP().browse("data", dir);
      const hasWip = (listing?.files ?? []).some(f => f.endsWith("_wip_world-bible.json"));
      if (!hasWip) return null;

      const resp = await fetch(`${dir}/_wip_world-bible.json`, { cache: "no-store" });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (_) {
      return null;
    }
  }

  async _clearWip(worldId) {
    // Overwrite WIP with empty marker (Foundry has no delete API)
    try {
      const file = new File(["{}"], "_wip_world-bible.json", { type: "application/json" });
      await _silentUpload("data", `worlds/${worldId}/ace-engine`, file);
    } catch (_) { /* best effort */ }
  }

  // ── Generation ─────────────────────────────────────────────

  /**
   * Generate a full World Bible.
   * @param {string} setting - e.g. "Forgotten Realms — Faerûn"
   * @param {string} era - e.g. "Post-Sundering (5e, ~1489-1496 DR)"
   * @param {Object} aiProvider - AiProvider instance with .chat()
   * @param {string} worldId - game.world.id
   * @param {function} onProgress - (step, totalSteps, regionName, phase) callback
   * @returns {Promise<Object>} The complete bible object
   */
  async generate(setting, era, aiProvider, worldId, onProgress = () => {}) {
    if (this._running) {
      throw new Error("World Bible generation already in progress.");
    }
    this._running = true;
    this._paused = false;
    this._cancelled = false;

    try {
      return await this._runGeneration(setting, era, aiProvider, worldId, onProgress);
    } finally {
      this._running = false;
      this._paused = false;
      this._cancelled = false;
      this._pauseResolve = null;
    }
  }

  /** @private Main generation loop. */
  async _runGeneration(setting, era, aiProvider, worldId, onProgress) {
    const totalSteps = FAERUN_REGIONS.length + 1; // regions + global factions/pantheon

    // Log provider info for debugging
    const providerInfo = aiProvider.config || {};
    console.log(`${MODULE_ID} | World Bible: starting generation — provider: ${providerInfo.provider}, model: ${providerInfo.modelName}, maxTokens override: 16000`);

    // ── Check for WIP from a previous interrupted run ──
    let completedRegions = {};
    let globalData = null;
    let startStep = 0;

    const wip = await this._loadWip(worldId);
    if (wip && wip.setting === setting && wip.completedRegions) {
      completedRegions = wip.completedRegions;
      globalData = wip.globalData ?? null;
      startStep = Object.keys(completedRegions).length + (globalData ? 1 : 0);
      if (startStep > 0) {
        console.log(`${MODULE_ID} | World Bible: resuming from step ${startStep + 1}/${totalSteps} (${Object.keys(completedRegions).length} regions cached).`);
        onProgress(startStep, totalSteps, "Resuming...", "resuming");
      }
    }

    // ── Phase 1: Generate each region ──
    let consecutiveFailures = 0;
    for (let i = 0; i < FAERUN_REGIONS.length; i++) {
      const region = FAERUN_REGIONS[i];

      // Skip already-completed regions (from WIP)
      if (completedRegions[region.id]) continue;

      // ── Check cancel ──
      if (this._cancelled) {
        await this._saveWip(worldId, { setting, completedRegions, globalData, totalSteps });
        throw new Error("World Bible generation cancelled — progress saved. Run again to resume.");
      }

      // ── Wait while paused ──
      if (this._paused) {
        onProgress(i + 1, totalSteps, region.name, "paused");
        await this._saveWip(worldId, { setting, completedRegions, globalData, totalSteps });
        await this._waitIfPaused();
        if (this._cancelled) {
          throw new Error("World Bible generation cancelled — progress saved.");
        }
      }

      onProgress(i + 1, totalSteps, region.name, "generating");
      console.log(`${MODULE_ID} | World Bible: generating region ${i + 1}/${FAERUN_REGIONS.length} — ${region.name}...`);

      try {
        const prompt = buildRegionPrompt(region);
        const response = await aiProvider.chat(prompt, "", "", [], [], { maxTokens: 16000, timeout: 300_000 });

        if (!response || response.trim().length < 50) {
          consecutiveFailures++;
          console.warn(`${MODULE_ID} | World Bible: ✗ ${region.name} — empty or too-short response (${response?.length ?? 0} chars).`);
          continue;
        }

        const parsed = this._parseJSON(response);

        if (parsed) {
          completedRegions[region.id] = {
            name: region.name,
            ...parsed,
          };
          consecutiveFailures = 0;
          console.log(`${MODULE_ID} | World Bible: ✓ ${region.name} — ${parsed.nations?.length ?? 0} nations, ${parsed.cities?.length ?? 0} cities, ${parsed.factions?.length ?? 0} factions.`);
        } else {
          consecutiveFailures++;
          console.warn(`${MODULE_ID} | World Bible: ✗ ${region.name} — failed to parse JSON response. First 200 chars:`, response?.slice(0, 200));
        }
      } catch (err) {
        consecutiveFailures++;
        console.error(`${MODULE_ID} | World Bible: ✗ ${region.name} — API error:`, err.message || err);
      }

      // Save WIP after each successful region
      await this._saveWip(worldId, { setting, completedRegions, globalData, totalSteps });

      // Safety: abort if 3 consecutive failures (likely an API issue)
      if (consecutiveFailures >= 3) {
        throw new Error(`World Bible generation aborted — 3 consecutive failures. Progress saved (${Object.keys(completedRegions).length} regions). Check your AI provider settings and try again.`);
      }
    }

    // ── Phase 2: Global factions & pantheon ──
    if (!globalData) {
      if (this._cancelled) {
        await this._saveWip(worldId, { setting, completedRegions, globalData, totalSteps });
        throw new Error("World Bible generation cancelled — progress saved.");
      }

      onProgress(totalSteps, totalSteps, "Global Factions & Pantheon", "generating");
      console.log(`${MODULE_ID} | World Bible: generating global factions & pantheon...`);

      try {
        const response = await aiProvider.chat(GLOBAL_FACTIONS_PROMPT, "", "", [], [], { maxTokens: 16000, timeout: 300_000 });
        globalData = this._parseJSON(response);
        if (globalData) {
          console.log(`${MODULE_ID} | World Bible: ✓ Global — ${globalData.globalFactions?.length ?? 0} factions, ${globalData.pantheon?.length ?? 0} deities.`);
        } else {
          console.warn(`${MODULE_ID} | World Bible: ✗ Global factions — failed to parse JSON. First 200 chars:`, response?.slice(0, 200));
          globalData = { globalFactions: [], pantheon: [] };
        }
      } catch (err) {
        console.error(`${MODULE_ID} | World Bible: ✗ Global factions — API error:`, err.message || err);
        globalData = { globalFactions: [], pantheon: [] };
      }
    }

    // ── Phase 3: Assemble the final bible ──
    onProgress(totalSteps, totalSteps, "Assembling...", "assembling");

    this._bible = {
      meta: {
        setting,
        era,
        version: 1,
        generatedAt: new Date().toISOString(),
        savedAt: null,
        regionCount: Object.keys(completedRegions).length,
        generator: `ace-engine/${game.modules?.get(MODULE_ID)?.version ?? "unknown"}`,
      },
      regions: completedRegions,
      globalFactions: globalData?.globalFactions ?? [],
      pantheon: globalData?.pantheon ?? [],
    };

    // Build lookup indexes for fast context retrieval
    this._buildIndexes();

    // Save primary + double backup
    await this.save(worldId);
    await this.backup(worldId);

    // Clear WIP
    await this._clearWip(worldId);

    console.log(`${MODULE_ID} | World Bible: COMPLETE — ${this._bible.meta.regionCount} regions, ${this._bible.globalFactions.length} global factions, ${this._bible.pantheon.length} deities.`);
    onProgress(totalSteps, totalSteps, "Complete!", "complete");

    return this._bible;
  }

  // ── JSON Parsing (tolerant) ────────────────────────────────

  _parseJSON(text) {
    if (!text || typeof text !== "string") return null;
    text = text.trim();

    // Try direct parse
    try { return JSON.parse(text); } catch (_) {}

    // Try extracting from markdown fences
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      try { return JSON.parse(fenceMatch[1].trim()); } catch (_) {}
    }

    // Try finding first { to last }
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try { return JSON.parse(text.slice(first, last + 1)); } catch (_) {}
    }

    return null;
  }

  // ── Lookup Indexes ─────────────────────────────────────────
  // Built after load/generation for fast context retrieval.

  _buildIndexes() {
    if (!this._bible) return;

    // Flat maps: id → object (with regionId attached)
    this._nationIndex = new Map();
    this._cityIndex = new Map();
    this._factionIndex = new Map();
    this._religionIndex = new Map();
    this._geoIndex = new Map();

    // Also build a name → id map for fuzzy lookups
    this._nameToId = new Map();

    for (const [regionId, region] of Object.entries(this._bible.regions ?? {})) {
      for (const nation of region.nations ?? []) {
        nation._regionId = regionId;
        this._nationIndex.set(nation.id, nation);
        this._nameToId.set(nation.name.toLowerCase(), { type: "nation", id: nation.id });
      }
      for (const city of region.cities ?? []) {
        city._regionId = regionId;
        this._cityIndex.set(city.id, city);
        this._nameToId.set(city.name.toLowerCase(), { type: "city", id: city.id });
      }
      for (const faction of region.factions ?? []) {
        faction._regionId = regionId;
        this._factionIndex.set(faction.id, faction);
        this._nameToId.set(faction.name.toLowerCase(), { type: "faction", id: faction.id });
      }
      for (const religion of region.religions ?? []) {
        religion._regionId = regionId;
        this._religionIndex.set(religion.id, religion);
        this._nameToId.set(religion.deity.toLowerCase(), { type: "religion", id: religion.id });
      }
      for (const geo of region.geography ?? []) {
        geo._regionId = regionId;
        this._geoIndex.set(geo.id, geo);
        this._nameToId.set(geo.name.toLowerCase(), { type: "geography", id: geo.id });
      }
    }

    // Global factions
    for (const gf of this._bible.globalFactions ?? []) {
      this._factionIndex.set(gf.id, { ...gf, _regionId: "global" });
      this._nameToId.set(gf.name.toLowerCase(), { type: "faction", id: gf.id });
    }

    // Pantheon
    for (const deity of this._bible.pantheon ?? []) {
      this._religionIndex.set(deity.id, { ...deity, _regionId: "global" });
      this._nameToId.set(deity.deity.toLowerCase(), { type: "religion", id: deity.id });
    }

    console.log(`${MODULE_ID} | World Bible: indexes built — ${this._nationIndex.size} nations, ${this._cityIndex.size} cities, ${this._factionIndex.size} factions, ${this._religionIndex.size} deities, ${this._geoIndex.size} geography.`);
  }

  // ── Context Retrieval (for bio-generator, conversation, etc.) ──

  /**
   * Look up an entity by name (case-insensitive).
   * @param {string} name
   * @returns {{ type: string, id: string, data: object }|null}
   */
  findByName(name) {
    if (!name || !this._nameToId) return null;
    const entry = this._nameToId.get(name.toLowerCase());
    if (!entry) return null;

    let data;
    switch (entry.type) {
      case "nation": data = this._nationIndex.get(entry.id); break;
      case "city": data = this._cityIndex.get(entry.id); break;
      case "faction": data = this._factionIndex.get(entry.id); break;
      case "religion": data = this._religionIndex.get(entry.id); break;
      case "geography": data = this._geoIndex.get(entry.id); break;
    }
    return data ? { type: entry.type, id: entry.id, data } : null;
  }

  /**
   * Get full context for a city — includes the city, its nation, local factions,
   * local religions, and nearby geography. Formatted for AI prompt injection.
   * @param {string} cityIdOrName
   * @returns {string} Formatted context block or ""
   */
  getCityContext(cityIdOrName) {
    if (!this._bible || !this._cityIndex) return "";

    // Try by ID first, then by name
    let city = this._cityIndex.get(cityIdOrName);
    if (!city) {
      const found = this.findByName(cityIdOrName);
      if (found?.type === "city") city = found.data;
    }
    if (!city) return "";

    const lines = [`\n## WORLD BIBLE — ${city.name}`];

    // City info
    lines.push(`${city.name} (${city.type}) — ${city.description}`);
    if (city.notable) lines.push(`Notable: ${city.notable}`);
    if (city.population) lines.push(`Population: ${city.population}`);
    if (city.rumors) lines.push(`Current rumors: ${city.rumors}`);

    // Nation
    const nation = this._nationIndex.get(city.nation);
    if (nation) {
      lines.push(`\n### Nation: ${nation.name}`);
      lines.push(`${nation.description}`);
      lines.push(`Ruler: ${nation.ruler} | Government: ${nation.government}`);
      if (nation.culture) lines.push(`Culture: ${nation.culture}`);
      if (nation.tensions) lines.push(`Tensions: ${nation.tensions}`);
    }

    // Local factions
    const localFactions = (city.localFactions ?? [])
      .map(fid => this._factionIndex.get(fid))
      .filter(Boolean);
    if (localFactions.length) {
      lines.push(`\n### Local Factions`);
      for (const f of localFactions) {
        lines.push(`- **${f.name}** (${f.type}): ${f.purpose}${f.leader ? ` Led by ${f.leader}.` : ""}`);
      }
    }

    // Local religions
    const localReligions = (city.religions ?? [])
      .map(rid => this._religionIndex.get(rid))
      .filter(Boolean);
    if (localReligions.length) {
      lines.push(`\n### Local Religions`);
      for (const r of localReligions) {
        lines.push(`- **${r.deity}** — ${r.title}. ${r.description ?? ""}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Get context for a region — high-level overview with all nations.
   * @param {string} regionId
   * @returns {string}
   */
  getRegionContext(regionId) {
    if (!this._bible?.regions?.[regionId]) return "";

    const region = this._bible.regions[regionId];
    const lines = [`\n## WORLD BIBLE — Region: ${region.name}`];

    for (const nation of region.nations ?? []) {
      lines.push(`\n### ${nation.name} (${nation.type})`);
      lines.push(`${nation.description}`);
      lines.push(`Ruler: ${nation.ruler} | Capital: ${nation.capital}`);
    }

    return lines.join("\n");
  }

  /**
   * Get a faction's full details.
   * @param {string} factionIdOrName
   * @returns {string}
   */
  getFactionContext(factionIdOrName) {
    if (!this._factionIndex) return "";

    let faction = this._factionIndex.get(factionIdOrName);
    if (!faction) {
      const found = this.findByName(factionIdOrName);
      if (found?.type === "faction") faction = found.data;
    }
    if (!faction) return "";

    const lines = [`**${faction.name}** (${faction.type}, ${faction.scope})`];
    lines.push(faction.description);
    if (faction.leader) lines.push(`Leader: ${faction.leader}`);
    if (faction.purpose) lines.push(`Purpose: ${faction.purpose}`);
    if (faction.allies?.length) lines.push(`Allies: ${faction.allies.join(", ")}`);
    if (faction.enemies?.length) lines.push(`Enemies: ${faction.enemies.join(", ")}`);

    return lines.join("\n");
  }

  /**
   * Search the bible for any entity matching a query string.
   * Returns formatted context for the best matches.
   * @param {string} query
   * @param {number} [maxResults=5]
   * @returns {string}
   */
  search(query, maxResults = 5) {
    if (!this._nameToId || !query) return "";
    const q = query.toLowerCase();
    const matches = [];

    for (const [name, ref] of this._nameToId) {
      if (name.includes(q)) {
        matches.push({ name, ...ref, score: name === q ? 100 : name.startsWith(q) ? 50 : 10 });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    const top = matches.slice(0, maxResults);

    if (!top.length) return "";

    const lines = [`\n## WORLD BIBLE — Search: "${query}"`];
    for (const m of top) {
      switch (m.type) {
        case "city":
          lines.push(this.getCityContext(m.id));
          break;
        case "nation": {
          const n = this._nationIndex.get(m.id);
          if (n) lines.push(`**${n.name}** (${n.type}): ${n.description}`);
          break;
        }
        case "faction":
          lines.push(this.getFactionContext(m.id));
          break;
        case "religion": {
          const r = this._religionIndex.get(m.id);
          if (r) lines.push(`**${r.deity}** — ${r.title}. ${r.description ?? ""}`);
          break;
        }
        case "geography": {
          const g = this._geoIndex.get(m.id);
          if (g) lines.push(`**${g.name}** (${g.type}): ${g.description}`);
          break;
        }
      }
    }

    return lines.join("\n");
  }

  // ── Auto-Resolve: AI lookup for unknown scene/location names ──

  /**
   * Resolve an unknown location name by asking the AI where it is in the
   * campaign setting. The result is cached permanently in the Bible so
   * subsequent lookups are free.
   *
   * @param {string} locationName - The scene or location name to resolve
   * @param {object} aiProvider   - The AI provider instance (from ace-engine)
   * @param {string} worldId      - Current world ID (for saving)
   * @returns {Promise<string>}   - Formatted context block, or "" if resolution failed
   */
  async resolveLocation(locationName, aiProvider, worldId) {
    if (!locationName || !aiProvider || !this._bible) return "";

    // Already known? Return immediately.
    const existing = this.getCityContext(locationName) || this.search(locationName, 1);
    if (existing) return existing;

    // Check the resolution cache to avoid repeat failures
    if (!this._resolveCache) this._resolveCache = new Map();
    const cacheKey = locationName.toLowerCase().trim();
    if (this._resolveCache.has(cacheKey)) {
      const cached = this._resolveCache.get(cacheKey);
      if (cached === null) return "";  // Previously failed — don't retry
      return this.getCityContext(cached) || this.search(cached, 1) || "";
    }

    // ── Ask the AI ──
    const setting = this._bible.meta?.setting ?? "Forgotten Realms";
    const prompt = `You are a D&D lore expert. A GM's scene is named "${locationName}".

Identify where this location is in official D&D lore (any setting — ${setting}, Ravenloft/Barovia, Greyhawk, Eberron, Dragonlance, Spelljammer, etc.). Return ONLY valid JSON:
{
  "resolvedName": "The canonical name of this location",
  "type": "city|town|fortress|ruins|temple|dungeon|landmark|region|wilderness",
  "region": "Which broad region of ${setting} this is in",
  "nation": "Which nation/kingdom this belongs to, or 'independent'/'wilderness'",
  "description": "2-3 sentences about this location — what it is, why adventurers go there, key dangers or features",
  "notable": "Key landmarks, inhabitants, or features",
  "localFactions": "Comma-separated list of factions/groups present here",
  "religions": "Comma-separated list of deities commonly worshipped here",
  "rumors": "1-2 current adventure hooks or local concerns"
}

If this location does not exist in official D&D lore, return: {"resolvedName": null}
Return ONLY the JSON — no explanation, no markdown fences.`;

    try {
      console.log(`${MODULE_ID} | World Bible: auto-resolving "${locationName}"...`);
      const response = await aiProvider.chat(prompt, "", "", [], [], { maxTokens: 1000, timeout: 30_000 });
      const parsed = this._parseJSON(response);

      if (!parsed || !parsed.resolvedName) {
        console.log(`${MODULE_ID} | World Bible: "${locationName}" — not found in lore, caching as unknown.`);
        this._resolveCache.set(cacheKey, null);
        return "";
      }

      // ── Inject into Bible as a resolved location ──
      const id = parsed.resolvedName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

      // Don't duplicate if it already exists under a different name
      if (this._cityIndex.has(id) || this._nameToId.has(parsed.resolvedName.toLowerCase())) {
        // Already in Bible under canonical name — just cache the alias
        this._resolveCache.set(cacheKey, parsed.resolvedName);
        this._nameToId.set(cacheKey, this._nameToId.get(parsed.resolvedName.toLowerCase()) ?? { type: "city", id });
        console.log(`${MODULE_ID} | World Bible: "${locationName}" → "${parsed.resolvedName}" (alias cached).`);
        return this.getCityContext(parsed.resolvedName) || this.search(parsed.resolvedName, 1) || "";
      }

      // Build a new city entry
      const newCity = {
        id,
        name: parsed.resolvedName,
        nation: parsed.nation?.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "independent",
        region: "resolved",
        type: parsed.type || "landmark",
        population: "unknown",
        description: parsed.description || `Resolved from scene name "${locationName}".`,
        notable: parsed.notable || "",
        localFactions: parsed.localFactions ? parsed.localFactions.split(",").map(s => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")) : [],
        religions: parsed.religions ? parsed.religions.split(",").map(s => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")) : [],
        rumors: parsed.rumors || "",
        _resolved: true,
        _resolvedFrom: locationName,
        _resolvedAt: new Date().toISOString(),
      };

      // Ensure the "resolved" region bucket exists
      if (!this._bible.regions.resolved) {
        this._bible.regions.resolved = { name: "Auto-Resolved Locations", nations: [], cities: [], factions: [], religions: [], geography: [] };
      }
      this._bible.regions.resolved.cities.push(newCity);

      // Update indexes
      newCity._regionId = "resolved";
      this._cityIndex.set(id, newCity);
      this._nameToId.set(parsed.resolvedName.toLowerCase(), { type: "city", id });
      this._nameToId.set(cacheKey, { type: "city", id });
      this._resolveCache.set(cacheKey, parsed.resolvedName);

      // Save to disk (non-blocking)
      this.save(worldId).catch(e => console.warn(`${MODULE_ID} | World Bible: auto-save after resolve failed:`, e));

      console.log(`${MODULE_ID} | World Bible: ✓ Resolved "${locationName}" → "${parsed.resolvedName}" (${parsed.type}, ${parsed.nation}). Saved to Bible.`);
      return this.getCityContext(id) || `\n## WORLD BIBLE — ${parsed.resolvedName}\n${parsed.description}\nNotable: ${parsed.notable}\nRumors: ${parsed.rumors}`;

    } catch (err) {
      console.warn(`${MODULE_ID} | World Bible: auto-resolve failed for "${locationName}":`, err.message || err);
      this._resolveCache.set(cacheKey, null);
      return "";
    }
  }

  // ── Digest-to-Bible Merge ─────────────────────────────────────

  /**
   * Merge a digest's extracted data into the World Bible via AI-assisted
   * category-based passes. Each category (locations, factions, NPCs, religions,
   * geography) gets a focused AI call that produces Bible-format entries.
   *
   * Book data always wins — existing entries get enriched, not overwritten.
   * A _sources array tracks where each entry came from.
   *
   * @param {object} digestData    - The full digest ({ summary, npcs, locations, factions, ... })
   * @param {string} sourceName    - Display name of the source (e.g. "Curse of Strahd")
   * @param {string} sourceFile    - Filename (e.g. "curse_of_strahd.pdf")
   * @param {object} aiProvider    - The AI provider instance
   * @param {string} worldId       - Current world ID (for saving)
   * @param {function} onProgress  - (step, total, category, phase) callback
   * @param {number|null} publishedYear - Publication year of the source (for authority ranking)
   * @returns {Promise<{ merged: number, updated: number, skipped: number, errors: string[] }>}
   */
  async mergeFromDigest(digestData, sourceName, sourceFile, aiProvider, worldId, onProgress = () => {}, publishedYear = null) {
    if (!this._bible || !aiProvider || !digestData) {
      throw new Error("World Bible, AI provider, and digest data are all required.");
    }

    const sourceTag = `digest:${sourceFile}`;
    const setting = this._bible.meta?.setting ?? "Forgotten Realms";
    const results = { merged: 0, updated: 0, skipped: 0, errors: [] };
    const totalSteps = 5;
    let step = 0;

    // ── Publication year authority ─────────────────────────────────
    // The original Bible generation counts as 2024 (current 5e training data).
    // Newer sources can overwrite existing entries. Older sources can only ADD
    // new entries — they cannot overwrite descriptions, rulers, or faction details.
    const BIBLE_BASE_YEAR = 2024;  // original AI generation = current era
    const srcYear = publishedYear ?? 0;  // 0 = unknown = conservative (supplement only)
    const canOverwrite = srcYear >= BIBLE_BASE_YEAR;
    if (!canOverwrite && srcYear > 0) {
      console.log(`${MODULE_ID} | World Bible merge: "${sourceName}" (${srcYear}) is older than Bible base (${BIBLE_BASE_YEAR}) — new entries only, no overwrites.`);
    } else if (srcYear === 0) {
      console.log(`${MODULE_ID} | World Bible merge: "${sourceName}" has no publication year set — supplement only, no overwrites.`);
    }

    // Build a summary of existing Bible entries so the AI can update rather than duplicate
    const existingNames = [];
    for (const [name] of this._nameToId ?? []) existingNames.push(name);
    const existingHint = existingNames.length
      ? `\n\nThe World Bible already contains these entries (DO NOT duplicate — update/enrich if you have more detail):\n${existingNames.slice(0, 200).join(", ")}`
      : "";

    // ── Category prompts ─────────────────────────────────────────
    const categories = [
      {
        name: "Locations",
        key: "cities",
        digestFields: ["locations"],
        prompt: `You are extracting LOCATIONS from a D&D adventure module to add to a World Bible.

SOURCE: "${sourceName}"
DIGEST DATA:
${JSON.stringify(digestData.locations ?? [], null, 1)}

ADDITIONAL CONTEXT:
${digestData.summary ?? ""}
${existingHint}

Convert EVERY location into this exact JSON format. Use the EXACT names from the source — do NOT paraphrase or rename anything:
{
  "cities": [
    {
      "id": "snake_case_unique_id",
      "name": "Exact Name from Source",
      "nation": "parent_nation_or_region_id or 'independent'",
      "region": "digest_${sourceFile.replace(/[^a-z0-9]/gi, "_").toLowerCase()}",
      "type": "capital|major_city|city|town|fortress|port|ruins|temple|dungeon|landmark|village|wilderness",
      "population": "if known, else 'unknown'",
      "description": "2-3 sentences using the EXACT details from the source material",
      "notable": "Key landmarks, districts, or features FROM THE SOURCE",
      "localFactions": ["faction_ids_present_here"],
      "religions": ["deity_ids_worshipped_here"],
      "rumors": "Adventure hooks or local concerns from the source"
    }
  ]
}

Rules:
- Include EVERY location mentioned in the digest, no matter how small
- Use exact names, titles, and details from the source — this is canon
- IDs must be snake_case and unique
- Return ONLY the JSON — no explanation`,
      },
      {
        name: "Factions & Organizations",
        key: "factions",
        digestFields: ["factions"],
        prompt: `You are extracting FACTIONS AND ORGANIZATIONS from a D&D adventure module to add to a World Bible.

SOURCE: "${sourceName}"
DIGEST DATA:
${JSON.stringify(digestData.factions ?? [], null, 1)}

NPC DATA (for leader/member references):
${JSON.stringify((digestData.npcs ?? []).slice(0, 30), null, 1)}

ADDITIONAL CONTEXT:
${digestData.summary ?? ""}
${existingHint}

Convert EVERY faction/organization into this exact JSON format:
{
  "factions": [
    {
      "id": "snake_case_unique_id",
      "name": "Exact Name from Source",
      "type": "military|arcane|religious|criminal|mercantile|political|secret_society|guild|tribal|knightly_order|undead|cult",
      "scope": "local|national|regional|continental",
      "nation": "nation_or_region_id or null",
      "headquarters": "city_id or location description",
      "leader": "Name and Title (exact from source)",
      "purpose": "1 sentence core mission/goal",
      "description": "2-3 sentences using EXACT details from the source",
      "allies": ["faction_or_nation_ids"],
      "enemies": ["faction_or_nation_ids"],
      "presence": ["city_ids_where_active"]
    }
  ]
}

Rules:
- Include EVERY faction, group, cult, or organization mentioned
- Use exact names and leader titles from the source
- Return ONLY the JSON`,
      },
      {
        name: "Key NPCs",
        key: "npcs",
        digestFields: ["npcs"],
        prompt: `You are extracting KEY NPCs from a D&D adventure module to add to a World Bible.

SOURCE: "${sourceName}"
DIGEST DATA:
${JSON.stringify(digestData.npcs ?? [], null, 1)}

LOCATION DATA (for placement references):
${JSON.stringify((digestData.locations ?? []).slice(0, 30), null, 1)}

ADDITIONAL CONTEXT:
${digestData.summary ?? ""}
${existingHint}

Convert KEY NPCs (named characters important to the story) into this JSON format. Skip generic unnamed NPCs or random encounter creatures:
{
  "npcs": [
    {
      "id": "snake_case_unique_id",
      "name": "Exact Name from Source",
      "title": "Title or role (e.g. 'Burgomaster of Vallaki')",
      "location": "city_id where they are primarily found",
      "faction": "faction_id they belong to, or null",
      "race": "Race/species if known",
      "role": "ally|villain|quest-giver|merchant|ruler|priest|guard|neutral",
      "description": "2-3 sentences — who they are, what they want, how adventurers encounter them. Use EXACT source details.",
      "secrets": "Hidden knowledge or motivations, if any (from the source)"
    }
  ]
}

Rules:
- Only include NAMED, important NPCs — not generic guards or random monsters
- Use exact names, titles, and details from the source
- Return ONLY the JSON`,
      },
      {
        name: "Religions & Deities",
        key: "religions",
        digestFields: ["lore", "factions"],
        prompt: `You are extracting RELIGIONS AND DEITIES referenced in a D&D adventure module to add to a World Bible.

SOURCE: "${sourceName}"
LORE DATA:
${JSON.stringify(digestData.lore ?? [], null, 1)}

FACTION DATA (religious factions):
${JSON.stringify((digestData.factions ?? []).filter(f => /relig|church|temple|cult|faith|priest/i.test(JSON.stringify(f))), null, 1)}

NPC DATA (priests, clerics, religious figures):
${JSON.stringify((digestData.npcs ?? []).filter(n => /priest|cleric|paladin|acolyte|bishop|abbot|church|temple|faith/i.test(JSON.stringify(n))), null, 1)}

ADDITIONAL CONTEXT:
${digestData.summary ?? ""}
${existingHint}

Extract all deities, faiths, and religious practices referenced in this adventure:
{
  "religions": [
    {
      "id": "snake_case_deity_id",
      "deity": "Deity Name (exact from source)",
      "title": "Full title (e.g. 'The Morninglord')",
      "domains": ["Cleric Domains if mentioned"],
      "alignment": "If mentioned",
      "strongholds": ["city_ids_with_temples"],
      "worshippers": "Who worships this deity in this adventure",
      "description": "1-2 sentences on the faith's role in this adventure"
    }
  ]
}

Rules:
- Include every deity or faith mentioned, even briefly
- Use exact names and titles from the source
- Return ONLY the JSON`,
      },
      {
        name: "Geography",
        key: "geography",
        digestFields: ["locations", "lore"],
        prompt: `You are extracting GEOGRAPHIC FEATURES from a D&D adventure module to add to a World Bible.

SOURCE: "${sourceName}"
LOCATION DATA:
${JSON.stringify(digestData.locations ?? [], null, 1)}

LORE DATA:
${JSON.stringify(digestData.lore ?? [], null, 1)}

ADDITIONAL CONTEXT:
${digestData.summary ?? ""}
${existingHint}

Extract all geographic features (mountains, rivers, forests, deserts, etc.) — NOT cities or buildings:
{
  "geography": [
    {
      "id": "snake_case_id",
      "name": "Exact Name from Source",
      "type": "mountain_range|forest|desert|river|lake|sea|swamp|plains|glacier|island|valley|pass|mist",
      "description": "1-2 sentences from the source about this feature",
      "notable": "Key features, dangers, or inhabitants"
    }
  ]
}

Rules:
- Only geographic/natural features — not buildings, towns, or dungeons
- Use exact names from the source
- Return ONLY the JSON`,
      },
    ];

    // ── Run each category pass ───────────────────────────────────
    const regionId = `digest_${sourceFile.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;

    // Ensure region bucket exists
    if (!this._bible.regions[regionId]) {
      this._bible.regions[regionId] = {
        name: sourceName,
        _source: sourceTag,
        nations: [],
        cities: [],
        factions: [],
        religions: [],
        geography: [],
      };
    }
    const region = this._bible.regions[regionId];

    for (const cat of categories) {
      step++;
      onProgress(step, totalSteps, cat.name, "generating");
      console.log(`${MODULE_ID} | World Bible merge: [${step}/${totalSteps}] ${cat.name} from "${sourceName}"...`);

      // Skip if digest has no data for this category
      const hasData = cat.digestFields.some(f => (digestData[f]?.length ?? 0) > 0);
      if (!hasData) {
        console.log(`${MODULE_ID} | World Bible merge: skipping ${cat.name} — no digest data.`);
        continue;
      }

      try {
        const response = await aiProvider.chat(cat.prompt, "", "", [], [], { maxTokens: 16000, timeout: 300_000 });
        const parsed = this._parseJSON(response);

        if (!parsed) {
          results.errors.push(`${cat.name}: failed to parse AI response`);
          console.warn(`${MODULE_ID} | World Bible merge: ✗ ${cat.name} — JSON parse failed. First 200 chars:`, response?.slice(0, 200));
          continue;
        }

        // ── Merge results into Bible ──
        const entries = parsed[cat.key] ?? parsed.npcs ?? parsed.cities ?? parsed.factions ?? parsed.religions ?? parsed.geography ?? [];

        for (const entry of entries) {
          if (!entry.id || !entry.name) continue;

          // Tag with source
          entry._sources = [sourceTag];
          entry._regionId = regionId;

          // Check for existing entry by ID or name
          const existingByName = this._nameToId?.get(entry.name?.toLowerCase());
          const existingId = existingByName?.id;

          if (existingId) {
            // Existing entry found — decide whether to overwrite or supplement
            let existingEntry;
            switch (cat.key) {
              case "cities": existingEntry = this._cityIndex.get(existingId); break;
              case "factions": existingEntry = this._factionIndex.get(existingId); break;
              case "religions": existingEntry = this._religionIndex.get(existingId); break;
              case "geography": existingEntry = this._geoIndex.get(existingId); break;
            }

            if (existingEntry) {
              const prevSources = existingEntry._sources ?? [];
              if (!prevSources.includes(sourceTag)) prevSources.push(sourceTag);

              if (canOverwrite) {
                // Newer/equal source → full overwrite (book data wins)
                Object.assign(existingEntry, entry, { _sources: prevSources });
                results.updated++;
              } else {
                // Older source → supplement only: add source tag but do NOT
                // overwrite descriptions, rulers, or key details. Only fill
                // in fields that are currently empty/missing.
                for (const [k, v] of Object.entries(entry)) {
                  if (k.startsWith("_")) continue;  // skip internal fields
                  if (k === "id" || k === "name") continue;  // never overwrite identity
                  const existing = existingEntry[k];
                  if (!existing || existing === "unknown" || existing === "") {
                    existingEntry[k] = v;  // fill empty field
                  }
                }
                existingEntry._sources = prevSources;
                results.updated++;
              }
              continue;
            }
          }

          // New entry — add to region
          switch (cat.key) {
            case "cities": region.cities.push(entry); break;
            case "factions": region.factions.push(entry); break;
            case "npcs":
              // NPCs stored as a special array on the region
              if (!region.npcs) region.npcs = [];
              region.npcs.push(entry);
              break;
            case "religions": region.religions.push(entry); break;
            case "geography": region.geography.push(entry); break;
          }
          results.merged++;
        }

        console.log(`${MODULE_ID} | World Bible merge: ✓ ${cat.name} — ${entries.length} entries processed.`);

      } catch (err) {
        results.errors.push(`${cat.name}: ${err.message}`);
        console.error(`${MODULE_ID} | World Bible merge: ✗ ${cat.name} — error:`, err.message || err);
      }
    }

    // ── Rebuild indexes and save ──
    this._buildIndexes();
    await this.save(worldId);
    await this.backup(worldId);

    const total = results.merged + results.updated;
    console.log(`${MODULE_ID} | World Bible merge: COMPLETE — ${results.merged} new, ${results.updated} updated, ${results.errors.length} errors. Source: "${sourceName}".`);
    onProgress(totalSteps, totalSteps, "Complete!", "complete");

    return results;
  }

  // ── Learning Cache: extract world knowledge from AI responses ──

  /**
   * Extract locations, NPCs, and factions from an AI chat response
   * and inject new entries into the World Bible. Skips anything
   * already known. Runs as a single lightweight AI call.
   *
   * @param {string} text       - The AI response text to learn from
   * @param {object} aiProvider - The AI provider instance
   * @param {string} worldId    - Current world ID (for saving)
   * @returns {Promise<{learned: number, skipped: number}>}
   */
  async learnFromText(text, aiProvider, worldId) {
    if (!this._bible || !aiProvider || !text) return { learned: 0, skipped: 0 };

    const LEARN_PROMPT = `You are a structured data extractor for a D&D campaign knowledge base.

Analyze the following text and extract ANY specific world knowledge mentioned. Return a JSON object with these arrays (all optional — omit empty arrays):

{
  "locations": [{ "name": "...", "type": "city|town|village|temple|fortress|landmark|region", "description": "one sentence", "parent": "larger region if mentioned" }],
  "npcs": [{ "name": "...", "role": "title or occupation", "location": "where they are", "description": "one sentence" }],
  "factions": [{ "name": "...", "type": "guild|order|government|cult|military|merchant|criminal", "description": "one sentence", "base": "location if mentioned" }]
}

Rules:
- ONLY extract SPECIFIC named entities with proper nouns (no generic "the tavern" or "a guard")
- ONLY extract entities from the D&D campaign world — skip rules, mechanics, meta-discussion, and player advice
- Keep descriptions factual and concise — one sentence max
- If the text contains NO extractable world knowledge, return: {"empty": true}
- Return ONLY valid JSON, no commentary`;

    try {
      const response = await aiProvider.chat(
        `Extract world knowledge from this AI response:\n\n${text.slice(0, 4000)}`,
        "", "", [],
        [], { maxTokens: 2000, timeout: 30000 }
      );

      // Parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { learned: 0, skipped: 0 };

      const data = JSON.parse(jsonMatch[0]);
      if (data.empty) return { learned: 0, skipped: 0 };

      let learned = 0;
      let skipped = 0;

      // Ensure "learned" region bucket exists
      if (!this._bible.regions.learned) {
        this._bible.regions.learned = {
          name: "Learned from Conversations",
          _source: "auto-learn",
          nations: [], cities: [], factions: [], religions: [], geography: [],
        };
      }
      const region = this._bible.regions.learned;

      // Inject locations
      for (const loc of data.locations ?? []) {
        if (!loc.name) continue;
        // Skip if already known
        const existing = this.findByName(loc.name);
        if (existing) { skipped++; continue; }

        const id = loc.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        region.cities.push({
          id,
          name: loc.name,
          type: loc.type || "settlement",
          description: loc.description || "",
          parent: loc.parent || "",
          _source: "learned:chat",
          _learnedAt: new Date().toISOString(),
        });
        learned++;
      }

      // Inject NPCs (as cities with type "npc" — lightweight, searchable)
      for (const npc of data.npcs ?? []) {
        if (!npc.name) continue;
        const existing = this.findByName(npc.name);
        if (existing) { skipped++; continue; }

        const id = npc.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        region.cities.push({
          id,
          name: npc.name,
          type: "npc",
          description: `${npc.role ? npc.role + ". " : ""}${npc.description || ""}`.trim(),
          parent: npc.location || "",
          _source: "learned:chat",
          _learnedAt: new Date().toISOString(),
        });
        learned++;
      }

      // Inject factions
      for (const fac of data.factions ?? []) {
        if (!fac.name) continue;
        const existing = this.findByName(fac.name);
        if (existing) { skipped++; continue; }

        const id = fac.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        region.factions.push({
          id,
          name: fac.name,
          type: fac.type || "organization",
          description: fac.description || "",
          base: fac.base || "",
          _source: "learned:chat",
          _learnedAt: new Date().toISOString(),
        });
        learned++;
      }

      if (learned > 0) {
        this._buildIndexes();
        // Debounced save — don't save on every single message
        this._dirty = true;
        if (!this._learnSaveTimer) {
          this._learnSaveTimer = setTimeout(async () => {
            this._learnSaveTimer = null;
            if (this._dirty) {
              await this.save(worldId);
              console.log(`${MODULE_ID} | World Bible: auto-learn save complete.`);
            }
          }, 30000); // Save at most every 30s
        }
        console.log(`${MODULE_ID} | World Bible learn: +${learned} new, ${skipped} already known.`);
      }

      return { learned, skipped };

    } catch (err) {
      console.warn(`${MODULE_ID} | World Bible learn failed:`, err);
      return { learned: 0, skipped: 0 };
    }
  }

  /**
   * Get summary stats about the loaded bible.
   * @returns {{ setting, regionCount, nationCount, cityCount, factionCount, deityCount, geoCount }}
   */
  getStats() {
    if (!this._bible) return null;
    return {
      setting: this._bible.meta?.setting ?? "None",
      era: this._bible.meta?.era ?? "Unknown",
      generatedAt: this._bible.meta?.generatedAt ?? null,
      regionCount: Object.keys(this._bible.regions ?? {}).length,
      nationCount: this._nationIndex?.size ?? 0,
      cityCount: this._cityIndex?.size ?? 0,
      factionCount: this._factionIndex?.size ?? 0,
      deityCount: this._religionIndex?.size ?? 0,
      geoCount: this._geoIndex?.size ?? 0,
    };
  }
}
