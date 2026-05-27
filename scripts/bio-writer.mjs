// ─── ACE: Engine — Serialized Biography Writer ────────────────────────────
//
// Centralized helper to prevent lost biography updates when multiple paths
// mutate the same actor concurrently.
//
// THE PROBLEM (Grok cross-module audit, MED 7):
//   ace-engine writes to system.details.biography.value from 7+ different
//   call sites — bio-generator (AI), auto-pipeline, npc-config-dialog
//   (pronoun swap), ui-hooks (reset), panel (manual generate), ace-engine
//   (story notes), and any other future writer. All of them previously
//   used direct `actor.update({...})` calls with NO locking. A concurrent
//   write — most realistically AI bio-generation running while a GM
//   manually edits the actor sheet — last-writer-wins, losing whichever
//   write committed first.
//
// THE FIX:
//   Route every biography write through this helper. Per-actor promise
//   chain serializes writes so each one reads fresh post-previous-write
//   state before applying its own update. Cross-actor writes still run
//   in parallel.
//
// Two entry points:
//   writeBiography(actor, newBio, label)      — full replacement
//   appendToBiography(actor, transformFn, label) — read-modify-write
//                                                  (transformFn receives
//                                                  current bio, returns new)
//
// Both return Promises that resolve when the write is committed. The
// internal queue handles failure isolation (a failed write doesn't block
// subsequent writes).
// ───────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-engine";
const TAG = "ACE: Engine | BioWriter";

// actor.id → Promise chain. Cleaned up when the last queued write resolves.
const _bioWriteQueue = new Map();

/**
 * Queue and serialize a biography write per actor.
 *
 * @param {Actor} actor — target actor (Actor or ActorDelta on unlinked tokens)
 * @param {Function} work — async function that performs the actual write
 * @returns {Promise<void>}
 * @private
 */
function _enqueue(actor, work) {
  if (!actor?.id) return Promise.resolve();
  const actorId = actor.id;
  const prev = _bioWriteQueue.get(actorId) ?? Promise.resolve();
  // .catch on the previous link so an earlier failure doesn't poison our turn
  const next = prev.catch(() => {}).then(work);
  _bioWriteQueue.set(actorId, next);

  // Cleanup: if our write is still the last in line when it resolves
  // (no one else queued behind us), free the map entry.
  next.finally(() => {
    if (_bioWriteQueue.get(actorId) === next) {
      _bioWriteQueue.delete(actorId);
    }
  });

  return next;
}

/**
 * Replace an actor's biography with a fully-rendered HTML string.
 * Use this when the caller has already composed the complete new biography
 * (e.g. bio-generator produces a full bio from scratch).
 *
 * @param {Actor}  actor   — target actor
 * @param {string} newBio  — full replacement HTML
 * @param {string} [label] — diagnostic label for logs ("bio-generator", etc.)
 * @returns {Promise<void>} resolves once the actor.update is committed
 */
export function writeBiography(actor, newBio, label = "bio") {
  return _enqueue(actor, async () => {
    if (newBio === undefined || newBio === null) return;
    // Re-read current under lock; if it already matches, skip a redundant write.
    const currentBio = actor.system?.details?.biography?.value ?? "";
    if (newBio === currentBio) return;
    await actor.update({ "system.details.biography.value": newBio });
    console.log(`${TAG} | [${label}] committed for ${actor.name}`);
  }).catch(err => {
    console.warn(`${TAG} | [${label}] write failed for ${actor.name}:`, err);
  });
}

/**
 * Read-modify-write a biography. The transform function is called WITH the
 * CURRENT biography (read fresh inside the lock) and should return the new
 * value (or undefined/null to abort the write).
 *
 * Use this for append-style updates (story notes, archive prepending,
 * pronoun swap on an unknown current state, etc.) where the new bio
 * depends on the current bio. The fresh read ensures you don't miss
 * concurrent writes that landed while you were composing.
 *
 * @param {Actor}    actor       — target actor
 * @param {Function} transformFn — `(currentBio) => string | null | undefined`
 *                                 Return null/undefined to abort the write.
 * @param {string}   [label]     — diagnostic label
 * @returns {Promise<void>}
 */
export function appendToBiography(actor, transformFn, label = "bio-append") {
  return _enqueue(actor, async () => {
    const currentBio = actor.system?.details?.biography?.value ?? "";
    let newBio;
    try {
      newBio = await transformFn(currentBio);
    } catch (err) {
      console.warn(`${TAG} | [${label}] transform threw for ${actor.name}:`, err);
      return;
    }
    if (newBio === undefined || newBio === null) return; // writer aborted
    if (newBio === currentBio) return; // no-op
    await actor.update({ "system.details.biography.value": newBio });
    console.log(`${TAG} | [${label}] committed for ${actor.name}`);
  }).catch(err => {
    console.warn(`${TAG} | [${label}] write failed for ${actor.name}:`, err);
  });
}
