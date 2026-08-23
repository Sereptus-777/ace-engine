// ─── The dead stay dead ──────────────────────────────────────────────────────
//
// ⚠️ WHY THIS EXISTS. Johnny, 2026-08-23: "this Fallen Actors folder underneath
// the actors sidebar there is just going to be trouble... I can't have it
// opening, man. It just fucks me up every time. I'm pulling dead guys back onto
// the scene. They're fallen, they're dead."
//
// ACE sweeps every killed NPC into "X ☠ Fallen". That folder then sits in the
// Actors sidebar full of corpses that look exactly like living creatures, and a
// GM reaching for a goblin grabs a dead one. The folder was already renamed once
// (2026-08-07) to stop it sorting to the top; that helped and did not fix it,
// because the problem is not WHERE it sits, it is that its contents are draggable.
//
// ⚠️ COLLAPSING IT IS NOT THE FIX. A collapsed folder still opens on a click and
// still opens itself when the sidebar filters for a search. Hiding a hazard is
// not the same as removing it. So the drop itself is refused: a fallen actor
// dragged onto the canvas is stopped at `preCreateToken`, which is the last gate
// before the token exists and the one place nothing can route around.
//
// ⚠️ AND IT STAYS SEARCHABLE. Johnny asked whether it should only open when he
// searches. It does not need to be hidden at all once the drag is inert — he can
// still find, open, read and edit a dead NPC, resurrect one deliberately, or
// drag one out of the folder. The only thing that stops is the accident.
const MODULE_ID = "ace-engine";
const TAG       = "ACE: Engine | Fallen";

const FALLEN_FOLDER        = "X ☠ Fallen";
const LEGACY_FALLEN_FOLDER = "☠ Fallen";

/** The Fallen folder, whichever name it currently carries. */
function fallenFolder() {
    return game.folders?.find(f => f.type === "Actor"
        && (f.name === FALLEN_FOLDER || f.name === LEGACY_FALLEN_FOLDER)) ?? null;
}

/**
 * Is this actor filed as dead?
 *
 * ⚠️ THE FOLDER IS THE TEST, NOT THE HIT POINTS. A corpse that was healed back
 * to full in the sidebar is still filed under Fallen and is still not what the
 * GM meant to grab; equally a living NPC at 0 HP in a normal folder is a
 * creature mid-fight, not a mistake. Where the GM filed it is the intent.
 * Sub-folders count, because he sorts his dead.
 */
export function isFallen(actor) {
    const folder = fallenFolder();
    if (!folder || !actor) return false;
    let f = actor.folder;
    for (let depth = 0; f && depth < 12; depth++) {
        if (f.id === folder.id) return true;
        f = f.folder;
    }
    return false;
}

/**
 * Refuse to place a fallen creature, and say why.
 *
 * ⚠️ IT MUST NOT BLOCK A DELIBERATE ONE. Holding ALT while dropping places it
 * anyway — a raised corpse, a body found in a crypt, a mistake being undone.
 * A guard with no override becomes the next thing to fight.
 */
function guardTokenCreate(tokenDoc, _data, _options, _userId) {
    try {
        const actor = tokenDoc.actor ?? game.actors?.get(tokenDoc.actorId);
        if (!isFallen(actor)) return true;

        // ALT held: the GM means it.
        //
        // ⚠️ NOT `isModifierActive?.(...)`. Optional-call on a method that no
        // longer exists returns undefined instead of throwing, which here would
        // read as "ALT is not held" and quietly make the override impossible —
        // a guard nobody can get past, with no error to explain it. That exact
        // shape cost months on the save engine (platform API drift, 08-12). So
        // the method's absence is detected and reported, and the drop is allowed
        // rather than blocked, because a broken check must not trap the GM.
        // ace-qol passes the plain string "Shift"; "Alt" is the same form.
        if (typeof game.keyboard?.isModifierActive !== "function") {
            console.warn(`${TAG} | game.keyboard.isModifierActive is missing on this Foundry build, `
                + `so the ALT override cannot be read. Allowing the drop rather than blocking with no way past.`);
            return true;
        }
        if (game.keyboard.isModifierActive("Alt")) {
            console.log(`${TAG} | "${actor.name}" is filed under ${FALLEN_FOLDER}, placed anyway (ALT held).`);
            ui.notifications?.info(`${actor.name} is a fallen creature — placed because you held ALT.`);
            return true;
        }

        ui.notifications?.warn(
            `${actor.name} is in the ${FALLEN_FOLDER} folder — that creature is dead. `
            + `Nothing was placed. Hold ALT while dropping if you meant to bring it back.`);
        console.log(`${TAG} | Blocked a drop of the fallen "${actor.name}". Hold ALT to place one deliberately.`);
        return false;   // false cancels the creation
    } catch (err) {
        // ⚠️ A BROKEN GUARD MUST NOT BLOCK THE WORLD. If this throws, allow the
        // drop: refusing every token because a check failed would be far worse
        // than the accident it exists to prevent.
        console.warn(`${TAG} | Fallen check failed, allowing the drop:`, err);
        return true;
    }
}

/**
 * Keep the folder shut in the sidebar.
 *
 * Cosmetic, and deliberately secondary to the drop guard. It stops the folder
 * hanging open across a re-render; it cannot stop a click, and it is not what
 * makes this safe.
 */
async function collapseFallen() {
    const folder = fallenFolder();
    if (!folder || !game.user?.isGM) return;
    try {
        if (folder.expanded === false) return;
        await folder.update({ expanded: false });
    } catch (_) { /* purely cosmetic */ }
}

/**
 * Mark every row inside the folder so a corpse reads as a corpse at a glance.
 * Styling only — the refusal above is what actually prevents the accident.
 */
function markFallenRows(html) {
    const folder = fallenFolder();
    if (!folder) return;
    const root = html?.[0] ?? html;
    if (!root?.querySelectorAll) return;
    try {
        for (const li of root.querySelectorAll(`.folder[data-folder-id="${folder.id}"] .directory-item.actor`)) {
            li.classList.add("ace-fallen-row");
            li.title = "This creature is dead. Dropping it is blocked — hold ALT to place it anyway.";
        }
    } catch (_) { /* sidebar shape changed; the guard still holds */ }
}

export function installFallenGuard() {
    // ⚠️ preCreateToken IS THE GATE. Blocking a dragstart in the sidebar is
    // decoration: the sidebar is redrawn constantly, other modules re-bind it,
    // and a token can arrive by routes that never touch a drag at all. Returning
    // false from preCreateToken stops the document being made, whatever brought
    // it. One gate, not a scattering of listeners.
    Hooks.on("preCreateToken", guardTokenCreate);

    Hooks.on("renderActorDirectory", (_app, html) => markFallenRows(html));

    // ⚠️ ready-INSIDE-ready NEVER FIRES. This module is started from the entry
    // file's own ready handler, so waiting on `ready` waits on an event already
    // in progress and nothing would ever run. Proven live 2026-08-12.
    if (game.ready) collapseFallen();
    else Hooks.once("ready", collapseFallen);

    console.log(`${TAG} | Fallen creatures cannot be dropped onto a scene. Hold ALT to override.`);
}
