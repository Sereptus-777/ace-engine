// ─── ACE Engine — the numbers on a character's profile ──────────────────────
//
// ⚠️🔴 WHY THESE WERE WRONG FOR MONTHS (2026-08-22).
//
// Johnny, reading Firaxis Greenbeard's PC Profile journal: level 7 when he is
// 9, twenty kills when "that motherfucker has killed way more than that", zero
// fumbles when he has plainly fumbled, and a session count of 1,749.
//
// Three separate faults, and only one of them was in this data:
//
//  1. LEVEL WAS FROZEN BY A `||`. `rec.level = rec.level || extract(actor)`
//     means "only if never set". Captured once at 7, and a truthy 7
//     short-circuits the expression on every load thereafter. Fixed at source.
//
//  2. SESSIONS COUNTED WORLD LOADS. logSession() ran for every PC on every
//     world load. 1,749 is how many times he has opened Foundry.
//
//  3. ⚠️ AND THE REST WAS A CROSS-MODULE BREAK, which is the real lesson.
//     ACE Engine counted hits, misses, crits, fumbles and damage by reading
//     dnd5e's CHAT MESSAGES (`message.flags.dnd5e.roll.type`). ACE QOL then
//     took over the attack pipeline: it intercepts at the hook level, suppresses
//     dnd5e's own cards (`preCreateUsageMessage` → `create:false`) and renders
//     its own instead. So the messages Engine was counting stopped existing,
//     and the counters quietly stalled at whatever slipped through.
//
//     It was ALSO gated on `game.combat?.active`, so nothing outside a formal
//     initiative tracker counted at all.
//
//     ⚠️ THE FIX IS TO STOP SCRAPING THE UI. ACE QOL has been broadcasting
//     `attackComplete`, `damageApplied`, `killLogged` and `healApplied` the
//     whole time — feat-effects.mjs has listened to attackComplete for months.
//     Engine was reading the wallpaper while its sibling announced the event.
//
// ⚠️ ONE CLIENT WRITES. attackComplete fires on the client that rolled and the
// GM relays player attacks, so without a gate a player attack could be counted
// twice.

const MODULE_ID = "ace-engine";
const QOL_ID    = "ace-qol";
const TAG       = "ACE: Engine | PC stats";

/** Is this a player character we keep a profile for? */
function _isPC(actor) {
  return !!actor?.hasPlayerOwner;
}

/** Only one client records, or every number doubles. */
function _mine() {
  return game.users?.activeGM === game.user;
}

export function installPcStats({ memory } = {}) {
  if (!memory) {
    console.warn(`${TAG} | no memory manager — statistics will not be recorded.`);
    return;
  }

  // ── Attacks: hits, misses, crits, fumbles, damage ────────────────────────
  Hooks.on(`${QOL_ID}.attackComplete`, (data) => {
    try {
      if (!_mine()) return;
      const actor = data?.actor;
      if (!_isPC(actor)) return;
      const rows = Array.isArray(data?.results) ? data.results : [];
      if (!rows.length) return;

      const weapon = data?.item?.name ?? null;
      for (const r of rows) {
        // ⚠️ Read the pipeline's OWN verdict. Engine used to guess a hit by
        // comparing a d20 total against an AC it often did not have, with a
        // fallback of "10 or more is probably a hit". ACE QOL has already
        // worked this out properly, with cover, and says so in hitResult.
        const verdict = String(r?.hitResult ?? "").toLowerCase();
        const isCrit   = verdict.includes("crit") && !verdict.includes("fail");
        const isFumble = verdict.includes("fumble") || Number(r?.d20Result) === 1;
        const isHit    = isCrit || (!isFumble && (verdict.includes("hit") || verdict === "success"));

        memory.logAttackResult?.({ actorName: actor.name, hit: isHit, weaponName: weapon });
        if (isCrit || isFumble) {
          memory.logCritFumble?.({
            type: isCrit ? "crit" : "fumble",
            actorName: actor.name,
            weaponName: weapon,
            targetName: r?.name ?? r?.target?.name ?? null,
            scene: canvas?.scene?.name ?? "",
          });
        }
      }
    } catch (err) {
      console.warn(`${TAG} | attackComplete handling failed:`, err);
    }
  });

  // ── Damage actually applied, credited to whoever dealt it ────────────────
  //
  // ⚠️ damageApplied names the TARGET, not the dealer, so the dealer is carried
  // across from the attack that produced it. Engine's old counter read a
  // "damage" chat message and credited whoever spoke it, which is why Firaxis
  // shows 114 total damage across five months of play.
  let _lastDealer = null;
  Hooks.on(`${QOL_ID}.attackComplete`, (data) => {
    if (_isPC(data?.actor)) _lastDealer = { name: data.actor.name, at: Date.now() };
  });

  Hooks.on(`${QOL_ID}.damageApplied`, (data) => {
    try {
      if (!_mine()) return;
      const dealt = Number(data?.hpDelta ?? 0);
      if (dealt <= 0) return;
      // Only credit a dealer we saw resolve an attack moments ago. A trap or an
      // environmental effect has no dealer, and inventing one would be worse
      // than recording none.
      if (!_lastDealer || Date.now() - _lastDealer.at > 15000) return;
      memory.logAttackResult?.({ actorName: _lastDealer.name, hit: true, damage: dealt });
    } catch (err) {
      console.warn(`${TAG} | damageApplied handling failed:`, err);
    }
  });

  // ── Kills ────────────────────────────────────────────────────────────────
  Hooks.on(`${QOL_ID}.killLogged`, (data) => {
    try {
      if (!_mine()) return;
      const victim = data?.victim;
      const killer = data?.attacker;
      if (!victim) return;
      memory.logKill?.({
        victimName: victim.name,
        killerName: killer?.name ?? null,
        scene: canvas?.scene?.name ?? "",
      });
    } catch (err) {
      console.warn(`${TAG} | killLogged handling failed:`, err);
    }
  });

  console.debug(`${TAG} | listening to ACE QOL's own events instead of reading chat messages`);
}
