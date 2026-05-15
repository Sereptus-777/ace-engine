// ─── ACE: Engine — NPC → PC Converter ──────────────────────────────────────
//
// One-click conversion of an NPC statblock into a proper PC character actor.
// Use case: an NPC (Varek the Archmage, a hired sellsword, the BBG's
// turncoat lieutenant) becomes a permanent party member. NPCs are static
// statblocks in dnd5e; punching the CR or level field on the sheet does
// NOTHING to slot counts, spell list, HP, or anything else. PCs have the
// full class/level/progression machinery. So if an NPC is sticking around
// long-term, you want them as a PC.
//
// What this preserves:
//   • Name, portrait, prototype token, biography
//   • Ability scores
//   • Skill proficiencies / expertise
//   • Save proficiencies (derived from NPC's existing save bonuses)
//   • AC value (set as flat override; user can rebuild via armor later)
//   • Movement speeds + senses
//   • Damage resistances/immunities/vulnerabilities + condition immunities
//   • Size, languages, alignment
//   • ALL inventory items (weapons, armor, equipment, spells, features)
//   • HP max (kept as-is; user can re-roll via hit dice if they want)
//
// What this ADDS:
//   • A class item at the user-chosen target level — this is what makes
//     spell slots, hit dice, class features all start working as a PC.
//   • Optionally a subclass, background, race item (whatever the user picks).
//
// What this OPTIONALLY does:
//   • Delete the original NPC actor after conversion (checkbox).
//   • Place a new PC token on the canvas where the NPC's token was.

import { MODULE_ID } from "../ace-engine.mjs";

const TAG = "ACE: Engine | NPC→PC";

// ─── Compendium class lookup ───────────────────────────────────────────────

/**
 * Browse known dnd5e Item compendiums for a class with the given name.
 * Returns the Item document (a clone we can modify) or null.
 */
async function _findClassItem(className) {
    const lower = className.toLowerCase().trim();
    for (const pack of game.packs) {
        if (pack.documentName !== "Item") continue;
        // Most dnd5e class items live in the system's "classes" compendium
        // (id "dnd5e.classes") but third-party content can ship their own.
        try {
            const index = await pack.getIndex({ fields: ["type"] });
            for (const entry of index) {
                if (entry.type === "class" && entry.name?.toLowerCase() === lower) {
                    const doc = await pack.getDocument(entry._id);
                    return doc;
                }
            }
        } catch (err) {
            // skip packs we can't browse
        }
    }
    return null;
}

/** List available class names across all compendiums (for the dropdown). */
async function listAvailableClasses() {
    const seen = new Set();
    const classes = [];
    for (const pack of game.packs) {
        if (pack.documentName !== "Item") continue;
        try {
            const index = await pack.getIndex({ fields: ["type"] });
            for (const entry of index) {
                if (entry.type !== "class") continue;
                const key = entry.name?.toLowerCase();
                if (!key || seen.has(key)) continue;
                seen.add(key);
                classes.push(entry.name);
            }
        } catch (_) { /* skip */ }
    }
    return classes.sort();
}

// ─── Race / Subclass / Background helpers (best-effort) ────────────────────

async function _findItem(itemName, type) {
    if (!itemName) return null;
    const lower = itemName.toLowerCase().trim();
    for (const pack of game.packs) {
        if (pack.documentName !== "Item") continue;
        try {
            const index = await pack.getIndex({ fields: ["type"] });
            for (const entry of index) {
                if (entry.type === type && entry.name?.toLowerCase() === lower) {
                    return await pack.getDocument(entry._id);
                }
            }
        } catch (_) { /* skip */ }
    }
    return null;
}

// ─── Race-name extraction from NPC (handles all dnd5e shapes) ──────────────

function _extractRaceName(npc) {
    const raceField = npc.system?.details?.race;
    if (typeof raceField === "string" && raceField.trim()) return raceField.trim();
    if (typeof raceField?.name === "string") return raceField.name;
    if (typeof raceField?.value === "string") return raceField.value;
    // Fall back to creature subtype if available ("Goblinoid", "Elf, Drow" etc.)
    const sub = npc.system?.details?.type?.subtype;
    if (typeof sub === "string" && sub.trim()) return sub.trim();
    return "";
}

// ─── The conversion itself ─────────────────────────────────────────────────

/**
 * Build the data object for a new PC actor based on an NPC's stats.
 * Preserves what carries over, leaves blanks for what the class item will fill.
 */
function _buildPcData(npc) {
    const sys = npc.system ?? {};
    const abilities = {};
    for (const abl of ["str", "dex", "con", "int", "wis", "cha"]) {
        const nAbl = sys.abilities?.[abl] ?? {};
        const saveValue = (() => {
            const s = nAbl.save;
            if (typeof s === "number") return s;
            if (typeof s?.value === "number") return s.value;
            return 0;
        })();
        const abilityMod = Math.floor(((nAbl.value ?? 10) - 10) / 2);
        // NPC save is proficient if save > ability mod (the difference
        // implies prof bonus was added). Conservative heuristic.
        const proficient = saveValue > abilityMod ? 1 : 0;
        abilities[abl] = {
            value: nAbl.value ?? 10,
            proficient,
            bonuses: { check: "", save: "" },
        };
    }

    // Skills — copy the proficiency values (0=none, 1=prof, 2=expert)
    const skills = {};
    const SKILL_KEYS = ["acr","ani","arc","ath","dec","his","ins","itm","inv","med","nat","prc","prf","per","rel","slt","ste","sur"];
    for (const skl of SKILL_KEYS) {
        const nSkl = sys.skills?.[skl] ?? {};
        skills[skl] = {
            value: nSkl.value ?? 0,
            ability: nSkl.ability ?? undefined,
            bonuses: { check: "", passive: "" },
        };
    }

    return {
        type: "character",
        name: npc.name,
        img: npc.img,
        prototypeToken: foundry.utils.deepClone(npc.prototypeToken?.toObject?.() ?? npc.prototypeToken ?? {}),
        system: {
            abilities,
            skills,
            attributes: {
                hp: {
                    value: sys.attributes?.hp?.value ?? 10,
                    max:   sys.attributes?.hp?.max   ?? 10,
                    temp:  sys.attributes?.hp?.temp  ?? 0,
                    tempmax: sys.attributes?.hp?.tempmax ?? 0,
                },
                ac: {
                    // Flat override — preserves the NPC's AC even if they
                    // don't have armor items. User can swap to "default"
                    // calculation later once they equip armor on the PC.
                    flat: sys.attributes?.ac?.value ?? sys.attributes?.ac?.flat ?? 10,
                    calc: "flat",
                },
                movement: foundry.utils.deepClone(sys.attributes?.movement ?? {}),
                senses:   foundry.utils.deepClone(sys.attributes?.senses ?? {}),
                init:     { bonus: "" },
                hd:       {}, // class item provides the hit-die pool
                spellcasting: sys.attributes?.spellcasting ?? "",
            },
            details: {
                biography: foundry.utils.deepClone(sys.details?.biography ?? { value: "", public: "" }),
                alignment: sys.details?.alignment ?? "",
                appearance: sys.details?.appearance ?? "",
                trait: sys.details?.trait ?? "",
                ideal: sys.details?.ideal ?? "",
                bond:  sys.details?.bond ?? "",
                flaw:  sys.details?.flaw ?? "",
            },
            traits: {
                size: sys.traits?.size ?? "med",
                di:   foundry.utils.deepClone(sys.traits?.di ?? {}),  // immunities
                dr:   foundry.utils.deepClone(sys.traits?.dr ?? {}),  // resistances
                dv:   foundry.utils.deepClone(sys.traits?.dv ?? {}),  // vulnerabilities
                ci:   foundry.utils.deepClone(sys.traits?.ci ?? {}),  // condition immunities
                languages: foundry.utils.deepClone(sys.traits?.languages ?? {}),
            },
            currency: foundry.utils.deepClone(sys.currency ?? { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }),
        },
        flags: {
            // Preserve ACE flags so chat/memory/voice etc. keep working
            "ace-engine": foundry.utils.deepClone(npc.flags?.["ace-engine"] ?? {}),
            "ace-suite":  foundry.utils.deepClone(npc.flags?.["ace-suite"] ?? {}),
            // Mark this PC as having been converted from an NPC — handy for
            // debugging and for future tooling to detect.
            [MODULE_ID]: {
                ...(npc.flags?.[MODULE_ID] ?? {}),
                convertedFromNpc: {
                    originalActorId: npc.id,
                    originalName: npc.name,
                    convertedAt: new Date().toISOString(),
                },
            },
        },
    };
}

/**
 * The full conversion pipeline. Creates the PC actor, transfers items,
 * optionally adds class/subclass/background/race, optionally deletes NPC.
 */
export async function convertNpcToPc(npc, opts = {}) {
    const {
        className     = "Wizard",
        targetLevel   = 1,
        subclassName  = null,
        backgroundName = null,
        raceName      = null,
        deleteOriginal = false,
    } = opts;

    if (!npc || npc.type !== "npc") throw new Error("convertNpcToPc: actor is not an NPC.");
    if (!game.user.isGM) throw new Error("convertNpcToPc: GM only.");

    console.log(`${TAG} | Converting "${npc.name}" → ${className} ${targetLevel}`);

    // 1. Build PC data
    const pcData = _buildPcData(npc);

    // 2. Find class item from compendiums
    const classItem = await _findClassItem(className);
    if (!classItem) {
        ui.notifications?.warn(`ACE: Couldn't find class "${className}" in compendiums — creating PC without class. Add it manually after.`);
    }

    // 3. Find optional race / background / subclass items
    const raceItem       = raceName       ? await _findItem(raceName, "race") : null;
    const backgroundItem = backgroundName ? await _findItem(backgroundName, "background") : null;
    const subclassItem   = subclassName   ? await _findItem(subclassName, "subclass") : null;

    // 4. Create the PC actor (no items yet — we add them in a separate step
    //    so embedded class hit-die rolling doesn't fight us)
    let pc;
    try {
        pc = await Actor.create(pcData);
    } catch (err) {
        console.error(`${TAG} | Actor create failed:`, err);
        throw err;
    }
    if (!pc) throw new Error("Actor.create returned null");

    // 5. Transfer ALL items from NPC → PC. We deep-clone toObject() so we
    //    don't accidentally mutate the NPC's items. Filter out anything
    //    null/invalid defensively.
    const itemData = (npc.items ?? []).map(i => {
        const obj = i.toObject();
        delete obj._id;       // let Foundry mint fresh IDs
        return obj;
    }).filter(Boolean);

    // 6. Append class item (with target level) + race/background/subclass
    if (classItem) {
        const classObj = classItem.toObject();
        delete classObj._id;
        classObj.system = classObj.system ?? {};
        classObj.system.levels = Math.max(1, Math.min(20, Number(targetLevel) || 1));
        itemData.push(classObj);
    }
    if (subclassItem) {
        const subObj = subclassItem.toObject();
        delete subObj._id;
        itemData.push(subObj);
    }
    if (backgroundItem) {
        const bgObj = backgroundItem.toObject();
        delete bgObj._id;
        itemData.push(bgObj);
    }
    if (raceItem) {
        const raceObj = raceItem.toObject();
        delete raceObj._id;
        itemData.push(raceObj);
    }

    if (itemData.length) {
        try {
            await pc.createEmbeddedDocuments("Item", itemData);
        } catch (err) {
            console.warn(`${TAG} | Bulk item transfer hit an error — falling back to one-by-one:`, err);
            // Fallback: try one at a time so a single bad item doesn't kill all
            for (const data of itemData) {
                try { await pc.createEmbeddedDocuments("Item", [data]); }
                catch (e) { console.warn(`${TAG} | Skipped item "${data.name}":`, e?.message ?? e); }
            }
        }
    }

    // 7. Force-restore HP max because adding a class item triggers a HP recalc
    //    that nukes the value we preserved in pcData.
    try {
        await pc.update({
            "system.attributes.hp.max":   pcData.system.attributes.hp.max,
            "system.attributes.hp.value": pcData.system.attributes.hp.value,
        });
    } catch (err) {
        console.warn(`${TAG} | HP restore failed (PC may show class-default HP):`, err);
    }

    // 8. Optional — delete original NPC. Skip if requested otherwise.
    if (deleteOriginal) {
        try { await npc.delete(); }
        catch (err) {
            console.warn(`${TAG} | Original NPC delete failed (you can remove it manually):`, err);
        }
    }

    console.log(`${TAG} | Done. New PC actor id=${pc.id}`);
    return pc;
}

// ─── Dialog UI ─────────────────────────────────────────────────────────────

/**
 * Show the conversion dialog for an NPC. User picks class + level + optional
 * extras, confirms, and we run the conversion.
 */
export async function openConvertDialog(npc) {
    if (!npc || npc.type !== "npc") {
        ui.notifications?.warn("ACE: Selected actor is not an NPC.");
        return;
    }
    if (!game.user.isGM) {
        ui.notifications?.warn("ACE: GM only.");
        return;
    }

    // Resolve available classes from compendiums
    const classes = await listAvailableClasses();
    const classOptions = classes.length
        ? classes.map(c => `<option value="${c}">${c}</option>`).join("")
        : `<option value="Wizard">Wizard</option><option value="Sorcerer">Sorcerer</option><option value="Cleric">Cleric</option><option value="Druid">Druid</option><option value="Fighter">Fighter</option><option value="Rogue">Rogue</option><option value="Bard">Bard</option><option value="Paladin">Paladin</option><option value="Ranger">Ranger</option><option value="Warlock">Warlock</option><option value="Monk">Monk</option><option value="Barbarian">Barbarian</option>`;

    // Best guess at class from NPC name (e.g. "Archmage" → Wizard, "Priest" → Cleric)
    const guessClass = _guessClassFromName(npc.name);

    const guessedRace = _extractRaceName(npc);

    const content = `
        <div class="ace-npc2pc-form" style="display:flex;flex-direction:column;gap:10px;padding:6px;font-family:'Rajdhani',sans-serif;">
            <div style="background:rgba(212,175,55,0.10);border-left:3px solid #d4af37;padding:8px 10px;border-radius:0 4px 4px 0;">
                <strong style="color:#f0e4c0;">Converting NPC → PC:</strong>
                <span style="color:#d4af37;font-weight:700;">${_escape(npc.name)}</span>
                <p style="margin:6px 0 0;font-size:12px;color:#c0b288;line-height:1.4;">
                  Creates a new player-character actor with the chosen class at the chosen level.
                  All items, spells, abilities, AC, HP, and biography transfer over. The NPC's
                  static statblock becomes a real PC — slots and progression work as expected.
                </p>
            </div>

            <label style="display:flex;flex-direction:column;gap:4px;">
                <span style="color:#f0e4c0;font-weight:600;">Class</span>
                <select name="className" style="padding:6px 8px;background:#1a1a1f;border:1px solid #444;border-radius:4px;color:#f0e4c0;font-size:14px;">
                    ${classOptions}
                </select>
            </label>

            <label style="display:flex;flex-direction:column;gap:4px;">
                <span style="color:#f0e4c0;font-weight:600;">Target Level (1-20)</span>
                <input type="number" name="targetLevel" value="1" min="1" max="20" step="1"
                       style="padding:6px 8px;background:#1a1a1f;border:1px solid #444;border-radius:4px;color:#f0e4c0;font-size:16px;font-weight:700;text-align:center;" />
            </label>

            <label style="display:flex;flex-direction:column;gap:4px;">
                <span style="color:#f0e4c0;font-weight:600;">Subclass <span style="color:#888;font-weight:400;font-size:11px;">(optional — exact compendium name)</span></span>
                <input type="text" name="subclassName" placeholder="e.g. School of Evocation"
                       style="padding:6px 8px;background:#1a1a1f;border:1px solid #444;border-radius:4px;color:#f0e4c0;font-size:13px;" />
            </label>

            <label style="display:flex;flex-direction:column;gap:4px;">
                <span style="color:#f0e4c0;font-weight:600;">Background <span style="color:#888;font-weight:400;font-size:11px;">(optional)</span></span>
                <input type="text" name="backgroundName" placeholder="e.g. Sage, Soldier"
                       style="padding:6px 8px;background:#1a1a1f;border:1px solid #444;border-radius:4px;color:#f0e4c0;font-size:13px;" />
            </label>

            <label style="display:flex;flex-direction:column;gap:4px;">
                <span style="color:#f0e4c0;font-weight:600;">Race <span style="color:#888;font-weight:400;font-size:11px;">(optional)</span></span>
                <input type="text" name="raceName" value="${_escape(guessedRace)}" placeholder="e.g. Human, Elf"
                       style="padding:6px 8px;background:#1a1a1f;border:1px solid #444;border-radius:4px;color:#f0e4c0;font-size:13px;" />
            </label>

            <label style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(180,40,40,0.12);border:1px solid rgba(220,60,60,0.35);border-radius:4px;cursor:pointer;">
                <input type="checkbox" name="deleteOriginal" style="width:16px;height:16px;cursor:pointer;" />
                <span style="color:#ffb0b0;font-weight:600;">Delete original NPC after conversion</span>
            </label>
        </div>
        <style>
            .ace-npc2pc-form select option { background: #1a1a1f; color: #f0e4c0; }
        </style>
    `;

    return new Promise((resolve) => {
        new Dialog({
            title: `Convert NPC → PC: ${npc.name}`,
            content,
            buttons: {
                convert: {
                    icon:  '<i class="fas fa-arrow-right"></i>',
                    label: "Convert",
                    callback: async (html) => {
                        const form = html[0]?.querySelector(".ace-npc2pc-form") ?? html.find(".ace-npc2pc-form")[0];
                        const className      = form.querySelector('[name="className"]')?.value || "Wizard";
                        const targetLevel    = parseInt(form.querySelector('[name="targetLevel"]')?.value, 10) || 1;
                        const subclassName   = form.querySelector('[name="subclassName"]')?.value?.trim() || null;
                        const backgroundName = form.querySelector('[name="backgroundName"]')?.value?.trim() || null;
                        const raceName       = form.querySelector('[name="raceName"]')?.value?.trim() || null;
                        const deleteOriginal = !!form.querySelector('[name="deleteOriginal"]')?.checked;

                        try {
                            const pc = await convertNpcToPc(npc, {
                                className, targetLevel,
                                subclassName, backgroundName, raceName,
                                deleteOriginal,
                            });
                            ui.notifications?.info(`ACE: Converted "${npc.name}" → ${className} ${targetLevel}. Opening new PC sheet…`);
                            try { pc?.sheet?.render(true); } catch (_) {}
                            resolve(pc);
                        } catch (err) {
                            console.error(`${TAG} | Conversion failed:`, err);
                            ui.notifications?.error(`ACE: Conversion failed — ${err.message ?? err}`);
                            resolve(null);
                        }
                    },
                },
                cancel: {
                    icon:  '<i class="fas fa-times"></i>',
                    label: "Cancel",
                    callback: () => resolve(null),
                },
            },
            default: "convert",
            render: (html) => {
                // Pre-select guessed class
                if (guessClass) {
                    const sel = html[0]?.querySelector('[name="className"]') ?? html.find('[name="className"]')[0];
                    if (sel) {
                        const opt = [...sel.options].find(o => o.value.toLowerCase() === guessClass.toLowerCase());
                        if (opt) sel.value = opt.value;
                    }
                }
            },
        }, {
            width: 460,
            height: "auto",
            classes: ["ace-engine", "ace-npc2pc-dialog"],
        }).render(true);
    });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _escape(s) {
    const div = document.createElement("div");
    div.textContent = s ?? "";
    return div.innerHTML;
}

function _guessClassFromName(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    const map = [
        [/(archmage|mage|wizard|sorcerer|sorceress|magus)/, "Wizard"],
        [/(priest|cleric|acolyte|monk of|paladin|inquisitor)/, "Cleric"],
        [/(druid|shaman|witch doctor)/, "Druid"],
        [/(bard|skald|minstrel)/, "Bard"],
        [/(warlock|cultist|invoker)/, "Warlock"],
        [/(paladin|knight templar|inquisitor)/, "Paladin"],
        [/(ranger|scout|tracker|huntmaster)/, "Ranger"],
        [/(rogue|thief|assassin|spy|bandit captain)/, "Rogue"],
        [/(barbarian|berserker|reaver)/, "Barbarian"],
        [/(monk|martial artist)/, "Monk"],
        [/(fighter|warrior|soldier|guard|veteran|knight|champion)/, "Fighter"],
    ];
    for (const [re, cls] of map) {
        if (re.test(lower)) return cls;
    }
    return null;
}

// ─── Activation — actor directory context menu + NPC sheet button ─────────

let _activated = false;

export function activateNpcToPcConverter() {
    if (_activated) return;
    if (!game.user.isGM) return;
    _activated = true;

    // ── Actor directory right-click → "Convert NPC to PC..." ─────────────
    Hooks.on("getActorDirectoryEntryContext", (html, options) => {
        options.push({
            name: "ACE: Convert NPC to PC…",
            icon: '<i class="fa-solid fa-user-plus"></i>',
            condition: (li) => {
                const id = li.data?.("entryId") ?? li.dataset?.entryId ?? li[0]?.dataset?.entryId;
                const actor = game.actors?.get(id);
                return !!actor && actor.type === "npc" && game.user.isGM;
            },
            callback: (li) => {
                const id = li.data?.("entryId") ?? li.dataset?.entryId ?? li[0]?.dataset?.entryId;
                const actor = game.actors?.get(id);
                if (!actor) return;
                openConvertDialog(actor);
            },
        });
    });

    // Same for the Foundry V13 directory hook variant
    Hooks.on("getActorContextOptions", (sheet, options) => {
        options.push({
            name: "ACE: Convert NPC to PC…",
            icon: '<i class="fa-solid fa-user-plus"></i>',
            condition: (li) => {
                const id = li?.dataset?.entryId ?? li?.dataset?.documentId;
                const actor = game.actors?.get(id);
                return !!actor && actor.type === "npc" && game.user.isGM;
            },
            callback: (li) => {
                const id = li?.dataset?.entryId ?? li?.dataset?.documentId;
                const actor = game.actors?.get(id);
                if (actor) openConvertDialog(actor);
            },
        });
    });

    console.log(`${TAG} | NPC → PC converter active.`);
}
