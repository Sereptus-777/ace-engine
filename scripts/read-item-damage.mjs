// ─── ACE: Engine — what damage does this item deal, in words ─────────────────
//
// ⚠️🔴 TWO PROMPTS ASKED FOR A FIELD DND5E DELETED (2026-09-25). The creature
// prompt and the item prompt both read `item.system.damage.parts`. dnd5e 5.3.3
// keeps a weapon's damage in `damage: { base, versatile }` — its own migration
// lifts the old `parts[0]` into `base` and discards the list — and a SPELL has
// no `system.damage` field at all. Of the 3,185 weapons in his world, none
// carries `parts`.
//
// So the model has been describing every creature's attacks and every magic
// weapon with the damage line blank, and never said so: one site guarded the
// read with `?? ""`, the other with a ternary. A thin description is the only
// symptom, and a thin description looks like a thin model.
//
// ⚠️ `types` IS A SET ON A LIVE ITEM and an array in compendium JSON, so
// `types[0]` reads undefined live.
//
// ⚠️ THIS FILE IMPORTS NOTHING, so it is safe from anywhere, and it asks no
// sibling module: ACE Engine runs on a bare Foundry with dnd5e and nothing else.
// ──────────────────────────────────────────────────────────────────────────────

const types = (v) => (v instanceof Set ? [...v] : Array.isArray(v) ? v : (v ? [v] : []))
  .map(t => String(t ?? "").trim().toLowerCase()).filter(Boolean);

const dice = (d) => {
  if (!d) return "";
  if (d.custom?.enabled) return String(d.custom.formula ?? "").trim();
  let f = (d.number && d.denomination) ? `${d.number}d${d.denomination}` : "";
  const bonus = String(d.bonus ?? "").trim();
  if (bonus) f = f ? `${f} + ${bonus}` : bonus;
  return f;
};

const phrase = (d) => {
  const f = dice(d);
  if (!f) return "";
  const t = types(d?.types).join(" or ");
  return t ? `${f} ${t}` : f;
};

/**
 * Every damage line an item deals, as readable phrases ("1d8 slashing").
 * The weapon's own base and versatile dice, then whatever its activities add.
 *
 * @param {Item|object} item
 * @returns {string[]}
 */
export function damagePhrases(item) {
  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  try {
    const sys = item?.system ?? {};
    push(phrase(sys.damage?.base));
    const v = phrase(sys.damage?.versatile);
    if (v) push(`${v} two-handed`);

    // `system.activities` is an ActivityCollection (a Map), so Object.values on
    // it returns [] every time. All four shapes appear: Collection, plain object
    // from toObject(), array, and whatever a stub hands over.
    const acts = sys.activities ?? null;
    const list = !acts ? []
      : (typeof acts.values === "function" ? [...acts.values()]
        : Array.isArray(acts) ? acts : Object.values(acts));
    for (const a of list) {
      for (const p of (Array.isArray(a?.damage?.parts) ? a.damage.parts : [])) {
        // A live attack already carries the weapon's base at the front of its
        // parts, marked `base` (AttackActivityData#prepareFinalData) — it is
        // read from the item above, so skip it or a longsword reads 1d8 twice.
        if (p?.base) continue;
        if (Array.isArray(p)) { push([p[0], p[1]].filter(Boolean).join(" ")); continue; }
        push(phrase(p));
      }
      const h = a?.healing;
      if (h) { const f = dice(h) || String(h.formula ?? "").trim(); if (f) push(`${f} healing`); }
    }
  } catch (err) {
    console.warn(`ace-engine | could not read the damage on "${item?.name ?? "an item"}":`, err);
  }
  return out;
}

/** The same, as one phrase for a prompt line, or "" when the item deals none. */
export function damageLine(item) {
  return damagePhrases(item).join(", ");
}
