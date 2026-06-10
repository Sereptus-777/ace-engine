// ─── ACE: Engine — Shared silent file uploader ──────────────────────────────
// ONE uploader that suppresses Foundry's upload notifications, replacing five
// copy-pasted `_silentUpload` helpers (category-store, digest-engine,
// document-engine, memory-manager, memory-sync-engine).
//
// THE BUG IT FIXES: each copy patched `ui.notifications` independently with its
// own save/restore. When two uploads overlapped — easy, since the memory-sync
// engine saves on a timer alongside digest/category saves — the second copy
// captured the FIRST copy's already-patched `warn`/`error` as its "original."
// The restore logic then left `ui.notifications.warn` pointing at a wrapper
// whose captured original had been nulled, so every later warning threw
// "_origNotifyWarn is not a function" — breaking notifications suite-wide.
//
// THE FIX: patch `ui.notifications` EXACTLY ONCE (true originals captured a
// single time), install permanent wrappers that just consult a shared depth
// counter, and NEVER un-patch. Overlapping uploads simply inc/dec the counter,
// so corruption is impossible. While depth > 0 we mute "info" toasts and drop
// only the spurious permission-denied warning; everything else passes straight
// through to the real notification, so normal warnings always work.
// ──────────────────────────────────────────────────────────────────────────────

// v13-safe FilePicker access (global removed in v13, namespaced under foundry.applications)
const _FP = () =>
  foundry.applications?.apps?.FilePicker?.implementation ?? // v13+
  globalThis.FilePicker;                                     // v12 fallback

const _PERM_RX = /does not have permission to upload/i;

let _depth   = 0;
let _patched = false;
let _trueInfo = null, _trueWarn = null, _trueErr = null;

/** Install the notification wrappers once. Idempotent. */
function _ensurePatched() {
  if (_patched) return;
  const n = globalThis.ui?.notifications;
  if (!n) return; // notifications not ready yet — try again on the next upload
  _trueInfo = n.info.bind(n);
  _trueWarn = n.warn.bind(n);
  _trueErr  = n.error.bind(n);
  n.info  = (...a)      => (_depth > 0) ? undefined : _trueInfo(...a);
  n.warn  = (msg, ...r) => (_depth > 0 && typeof msg === "string" && _PERM_RX.test(msg)) ? undefined : _trueWarn(msg, ...r);
  n.error = (msg, ...r) => (_depth > 0 && typeof msg === "string" && _PERM_RX.test(msg)) ? undefined : _trueErr(msg, ...r);
  _patched = true;
}

/**
 * Upload a file with Foundry's notification toasts suppressed. Safe to call
 * concurrently from anywhere — all callers share one depth counter, and the
 * notification patch is installed once and never removed (so it can't corrupt).
 * @param {string} source  e.g. "data"
 * @param {string} dir      target directory
 * @param {File}   file     the File to upload
 */
export async function silentUpload(source, dir, file) {
  _ensurePatched();
  _depth++;
  try {
    // Correct FilePicker.upload signature is (source, path, file, body, options)
    // — notify belongs in OPTIONS (5th arg). The manual muting above is the
    // primary suppressor; this makes the option apply too, as a belt-and-suspenders.
    return await _FP().upload(source, dir, file, {}, { notify: false });
  } finally {
    if (_depth > 0) _depth--;
  }
}
