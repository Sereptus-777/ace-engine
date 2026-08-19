/**
 * ACE: Engine — SCENE PERCEPTION
 * ─────────────────────────────────────────────────────────────────────────────
 * What can this creature ACTUALLY perceive, right now, and what does it make of
 * it? Read fresh before every single reply.
 *
 * Johnny 2026-08-07: "The NPC isn't going to know what's going on down the
 * hallway or in a different part of the dungeon, which we've mistakenly done
 * before." He is describing the old `buildNearbyActorsSummary`, which listed
 * every token within 60 feet with NO line-of-sight test at all — so an NPC knew
 * about a fight through a stone wall, in a sealed room, around a corner.
 *
 * Three layers, in this order, because each depends on the last:
 *
 *   1. DETECTION  — can it be sensed at all? Sight uses the real wall geometry;
 *      hearing uses Foundry's SEPARATE sound walls (a wooden door muffles, a
 *      stone wall stops); smell only for creatures that actually have it.
 *   2. RECOGNITION — what does it make of what it sensed? Gated on Intelligence,
 *      so a dull creature reports "that one is standing very still" where a
 *      learned one says "that is Hold Person". It describes what it PERCEIVES,
 *      never what the game system knows.
 *   3. CHANGE     — what is different since it last spoke. "King was fine a
 *      moment ago and is bleeding now" is what makes a character react instead
 *      of narrate.
 *
 * ⚠️ EVERYTHING HERE IS A LOCAL READ. No AI call, no network. A busy dungeon
 * scene costs single-digit milliseconds against an AI call of 1.5–2 seconds.
 */

const MODULE_ID = "ace-engine";

/** Nothing beyond this is considered at all — keeps the sweep cheap. */
const MAX_SENSE_FEET = 120;
/** Normal speech carries about this far; beyond it you hear noise, not words. */
const CONVERSATION_EARSHOT_FEET = 30;

// ═══════════════════════════════════════════════════════════════════════════
//  LAYER 1 — DETECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Straight-line distance between two tokens, in feet.
 *
 * ⚠️ PREFER ace-qol's EDGE-TO-EDGE MEASUREMENT. Centre-to-centre is correct
 * between two MEDIUM tokens and wrong for anything bigger: a Large creature's
 * centre sits a full square from its edge, so an ogre standing right next to
 * you reads as 10 ft away instead of 5, and every perception and earshot gate
 * here is one square too tight for it.
 *
 * ⚠️ ace-engine has been calling `game.aceQol.distanceFt` since it was written
 * and silently taking the fallback EVERY time, because ace-qol never exposed
 * it (fixed 2026-08-11). If you see a "correct path" guarded by a typeof check,
 * verify the other end actually exists — a dead branch looks exactly like a
 * working one.
 */
function distanceFeet(a, b) {
    try {
        const proper = game.aceQol?.distanceFt;
        if (typeof proper === "function") return Math.round(proper(a, b));
        const grid = canvas?.grid;
        const px = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);
        return Math.round((px / (grid?.size || 100)) * (grid?.distance || 5));
    } catch (_) { return 999; }
}

/**
 * Is there a clear line of SIGHT? Uses the same call the chat icon already
 * relies on, so wall behaviour is identical across the module.
 * Fails OPEN (visible) — never blind a creature because a lookup threw.
 */
function canSee(from, to) {
    try {
        return !CONFIG.Canvas.polygonBackends.sight.testCollision(
            from.center, to.center, { type: "sight", mode: "any" }
        );
    } catch (err) {
        console.warn(`${MODULE_ID} | sight check failed — assuming visible:`, err);
        return true;
    }
}

/**
 * Can SOUND reach? Foundry keeps a separate sound-wall layer, which is what
 * makes "I hear fighting round the corner but cannot see it" possible — the
 * thing that turns a scan into a scene.
 */
function canHear(from, to) {
    try {
        return !CONFIG.Canvas.polygonBackends.sound.testCollision(
            from.center, to.center, { type: "sound", mode: "any" }
        );
    } catch (err) {
        console.warn(`${MODULE_ID} | sound check failed — assuming audible:`, err);
        return true;
    }
}

/** Does this creature have a nose worth modelling? Read, never assumed. */
function hasKeenSmell(actor) {
    try {
        const hay = [
            ...(actor?.items ?? []).map(i => i.name ?? ""),
            actor?.system?.details?.type?.subtype ?? "",
        ].join(" ").toLowerCase();
        return /keen smell|keen senses|scent|blindsight|tremorsense/.test(hay);
    } catch (_) { return false; }
}

/** How far this creature can see in the dark, in feet. 0 = needs light. */
function darkvisionFeet(actor, tokenDoc) {
    try {
        const sys = Number(actor?.system?.attributes?.senses?.darkvision ?? 0);
        const tok = Number(tokenDoc?.sight?.range ?? 0);
        return Math.max(sys, tok) || 0;
    } catch (_) { return 0; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  LAYER 2 — RECOGNITION (what an observer of THIS mind makes of it)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The same condition, described four ways.
 *
 * ⚠️ This is the heart of Johnny's Hold Person example. The observer reports
 * what it SEES. A creature with Intelligence 5 has no word for "paralysed" —
 * it sees a person standing wrong. Handing the model the game term would let a
 * boar diagnose a spell.
 *
 * Tiers: crude (INT ≤7) · plain (8–11) · informed (12–14) · expert (15+ or any
 * spellcaster, who has seen magic before and knows it when they see it).
 */
const CONDITION_TIERS = {
    paralyzed:    ["is standing very still, wrong, like a statue", "has gone rigid and cannot move", "is held fast — that is not natural", "is paralysed, held by magic"],
    stunned:      ["is swaying, not right in the head", "is dazed and reeling", "has been stunned senseless", "is stunned"],
    unconscious:  ["is lying down and not moving", "is out cold on the ground", "is unconscious", "is unconscious and dying"],
    prone:        ["is on the ground", "has fallen down", "is prone", "is prone"],
    restrained:   ["is stuck, thrashing", "is caught and cannot get free", "is restrained", "is restrained"],
    grappled:     ["is being held by another", "is grappled", "is grappled", "is grappled"],
    frightened:   ["looks scared", "is badly frightened", "is frightened of something", "is magically frightened"],
    charmed:      ["is acting oddly friendly", "is behaving strangely toward someone", "is charmed", "is charmed — magic"],
    poisoned:     ["looks sick", "looks poisoned and unwell", "is poisoned", "is poisoned"],
    blinded:      ["is groping about, eyes wrong", "cannot see", "is blinded", "is blinded"],
    deafened:     ["is not answering when spoken to", "cannot hear", "is deafened", "is deafened"],
    petrified:    ["has turned to stone", "has been turned to stone", "is petrified", "is petrified — magic"],
    incapacitated:["is not doing anything at all", "cannot act", "is incapacitated", "is incapacitated"],
    invisible:    ["is not there any more", "has vanished from sight", "has turned invisible", "is invisible — magic"],
    exhaustion:   ["looks worn out", "is exhausted", "is suffering exhaustion", "is suffering exhaustion"],
    concentrating:["is muttering and staring", "is concentrating hard on something", "is concentrating on a spell", "is concentrating on a spell"],
};

/** Which tier of understanding this observer gets. */
function recognitionTier(actor) {
    try {
        const int = Number(actor?.system?.abilities?.int?.value ?? 10);
        const caster = !!(actor?.system?.attributes?.spellcasting
                       || (actor?.items ?? []).some(i => i.type === "spell"));
        if (caster && int >= 12) return 3;   // has seen magic and knows the words
        if (int >= 15) return 3;
        if (int >= 12) return 2;
        if (int >= 8)  return 1;
        return 0;
    } catch (_) { return 1; }
}

/** Describe one condition at this observer's level. */
function describeCondition(key, tier) {
    const row = CONDITION_TIERS[String(key).toLowerCase()];
    if (!row) return null;
    return row[Math.max(0, Math.min(3, tier))];
}

/** How hurt something LOOKS. Nobody sees hit points; they see blood. */
function describeHealth(actor, tier) {
    try {
        const hp = actor?.system?.attributes?.hp;
        const cur = Number(hp?.value ?? 0), max = Number(hp?.max ?? 0);
        if (!max) return null;
        if (cur <= 0)         return tier >= 2 ? "is down and dying" : "has fallen and is not moving";
        const pct = cur / max;
        if (pct <= 0.25)      return tier >= 2 ? "is gravely wounded" : "is bleeding badly";
        if (pct <= 0.5)       return tier >= 2 ? "is bloodied" : "is hurt and bleeding";
        if (pct < 1)          return tier >= 2 ? "has taken some hurt" : "has a few cuts";
        return null;                                   // unhurt is not worth saying
    } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE SCAN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Everything this creature can perceive right now.
 * @returns {{creatures:Array, environment:object, tier:number}}
 */
export function perceive(npcToken, npcActor) {
    const out = { creatures: [], environment: {}, tier: recognitionTier(npcActor) };
    if (!npcToken || !canvas?.tokens) return out;

    const tier   = out.tier;
    const smell  = hasKeenSmell(npcActor);
    const dvFeet = darkvisionFeet(npcActor, npcToken.document);
    const dark   = Number(canvas.scene?.environment?.darknessLevel ?? canvas.scene?.darkness ?? 0);
    const isDark = dark >= 0.75;

    out.environment = {
        darkness: dark,
        isDark,
        weather:  canvas.scene?.weather || canvas.scene?.getFlag?.(MODULE_ID, "weather") || "",
        location: canvas.scene?.getFlag?.(MODULE_ID, "locationDescription") || "",
        inCombat: !!game.combat?.started,
    };

    for (const t of canvas.tokens.placeables) {
        if (!t?.actor || t.id === npcToken.id) continue;
        if (t.document.hidden) continue;                      // GM-hidden is not in the world

        const feet = distanceFeet(npcToken, t);
        if (feet > MAX_SENSE_FEET) continue;                  // cheap reject before any sweep

        // ── Which senses reach it ──
        let sight = canSee(npcToken, t);
        if (sight && isDark && dvFeet > 0 && feet > dvFeet) sight = false;   // beyond darkvision
        if (sight && isDark && dvFeet === 0) sight = false;                  // no darkvision at all
        if (sight && t.actor.statuses?.has?.("invisible")) sight = false;

        const hearing = canHear(npcToken, t) && feet <= MAX_SENSE_FEET;
        const scent   = smell && feet <= 30;                  // noses do not need line of sight

        if (!sight && !hearing && !scent) continue;           // genuinely unaware of it

        // ── What it makes of it ──
        const conditions = [];
        try {
            for (const st of (t.actor.statuses ?? [])) {
                const d = describeCondition(st, tier);
                if (d) conditions.push(d);
            }
        } catch (_) { /* statuses unavailable */ }
        const health = sight ? describeHealth(t.actor, tier) : null;   // you must SEE blood

        out.creatures.push({
            id:        t.id,
            name:      t.name,
            feet,
            sight, hearing, scent,
            disposition: Number(t.document.disposition ?? 0),
            isPC:      t.actor.hasPlayerOwner === true,
            conditions,
            health,
            hpPct:     (() => { const h = t.actor.system?.attributes?.hp; const m = Number(h?.max ?? 0); return m ? Number(h?.value ?? 0) / m : null; })(),
        });
    }

    out.creatures.sort((a, b) => a.feet - b.feet);
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LAYER 3 — CHANGE, and the words handed to the model
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What is different since the last reply. The deltas are what make a character
 * REACT — a static list produces "as you can see, I am wounded", a change
 * produces "you were whole a moment ago".
 */
export function diff(previous, current) {
    const changes = [];
    if (!previous) return changes;
    const was = new Map((previous.creatures ?? []).map(c => [c.id, c]));

    for (const c of current.creatures ?? []) {
        const p = was.get(c.id);
        if (!p) { changes.push(`${c.name} has just arrived within your senses.`); continue; }
        if (p.hpPct != null && c.hpPct != null && c.hpPct < p.hpPct - 0.05)
            changes.push(`${c.name} has been wounded since you last spoke${c.health ? ` and ${c.health}` : ""}.`);
        if (p.hpPct != null && c.hpPct != null && c.hpPct > p.hpPct + 0.05)
            changes.push(`${c.name}'s wounds have closed since you last spoke.`);
        const gained = c.conditions.filter(x => !p.conditions.includes(x));
        for (const g of gained) changes.push(`${c.name} ${g} — that is new.`);
        if (p.sight && !c.sight) changes.push(`${c.name} is no longer in your sight.`);
    }
    for (const [id, p] of was) {
        if (!(current.creatures ?? []).some(c => c.id === id)) changes.push(`${p.name} is gone from your senses.`);
    }

    if (previous.environment?.weather !== current.environment?.weather && current.environment?.weather)
        changes.push(`The weather has turned: ${current.environment.weather}.`);
    if (!previous.environment?.inCombat && current.environment?.inCombat)
        changes.push(`Fighting has broken out.`);
    return changes;
}

/** The block handed to the AI. Perception only — never the game's own words. */
export function toPrompt(scan, changes) {
    const L = [];
    const env = scan.environment ?? {};
    const bits = [];
    if (env.weather)  bits.push(env.weather);
    if (env.location) bits.push(env.location);
    if (env.isDark)   bits.push("it is dark here");
    if (env.inCombat) bits.push("a fight is under way");
    if (bits.length) L.push(`AROUND YOU: ${bits.join("; ")}.`);

    if (!scan.creatures?.length) {
        L.push("WHAT YOU CAN SENSE: nobody else is within your senses.");
    } else {
        L.push("WHAT YOU CAN SENSE RIGHT NOW (this is ALL you know — you cannot see through walls or into other rooms):");
        for (const c of scan.creatures) {
            const how = c.sight ? "you can see" : (c.hearing ? "you cannot see but you can HEAR" : "you cannot see but you can SMELL");
            const side = c.disposition > 0 ? "friendly" : c.disposition < 0 ? "hostile" : "neutral";
            const state = [c.health, ...c.conditions].filter(Boolean).join("; ");
            L.push(`- ${c.name} (${side}), about ${c.feet} feet away — ${how} them${state ? `. They ${state}` : ""}.`);
        }
    }
    if (changes?.length) {
        L.push("WHAT HAS CHANGED SINCE YOU LAST SPOKE — react to this before anything else:");
        for (const ch of changes) L.push(`- ${ch}`);
    }
    L.push("Describe only what you PERCEIVE. Never name a game rule, spell or number you could not know.");
    return L.join("\n");
}

/** One compact line for the GM's own window. Never shown to a player. */
export function toGmLine(scan, changes) {
    const env = scan.environment ?? {};
    const seen  = scan.creatures.filter(c => c.sight).length;
    const heard = scan.creatures.filter(c => !c.sight && c.hearing).length;
    const bits = [`sees ${seen}`];
    if (heard) bits.push(`hears ${heard}`);
    const hurt = scan.creatures.filter(c => c.health).map(c => c.name);
    if (hurt.length) bits.push(`hurt: ${hurt.slice(0, 3).join(", ")}`);
    if (env.isDark)   bits.push("dark");
    if (env.weather)  bits.push(env.weather);
    if (env.inCombat) bits.push("combat");
    if (changes?.length) bits.push(`${changes.length} change${changes.length === 1 ? "" : "s"}`);
    const TIER = ["crude", "plain", "informed", "expert"];
    bits.push(`understanding: ${TIER[scan.tier] ?? "plain"}`);
    return bits.join(" · ");
}
