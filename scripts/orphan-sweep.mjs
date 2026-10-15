// ─── ACE Engine — clean up after a module that is no longer installed ───────
//
// ⚠️ WHY THIS HAS TO EXIST. ACE Envoy was a shim that held API keys in WORLD
// settings. The plan was: it migrates them into client storage, tells the GM it
// is finished, and only then gets deleted. Johnny deleted the folder before
// that ran - entirely reasonably, since the module had been "about to be
// removed" for weeks and nothing had ever confirmed it was done.
//
// The consequence is the one thing that made the ordering matter: Foundry keeps
// a Setting document for any setting that was ever written, whether or not a
// module still claims it, and it ships every one of them to every connected
// client. So an orphaned key is STILL readable by any player, and there is no
// longer a module that could clear it. `game.settings.get("ace-envoy", …)`
// throws now - the setting is unregistered - so the only way to reach it is the
// raw storage collection.
//
// ⚠️ THIS DELETES SETTINGS, so it is deliberately narrow: only the exact key
// names Envoy is known to have stored secrets in, only when a value is actually
// present, only on the GM's client, and it says what it removed. It never
// touches a namespace that is still installed.

const MODULE_ID = "ace-engine";
const LOG = "ace-engine | Orphans";

// Exactly the three names Envoy stored secrets under. Nothing else - a wildcard
// sweep of "ace-envoy.*" would take NPC data somebody may still want migrated.
const ORPHANED_SECRETS = [
  "ace-envoy.openAiKey",
  "ace-envoy.elevenLabsKey",
  "ace-envoy.googleKey",
];

export async function sweepOrphanedEnvoyKeys() {
  if (!game.user?.isGM) return;
  // Only sweep if Envoy is genuinely gone. While it is installed it owns these.
  if (game.modules?.get?.("ace-envoy")) return;

  let store;
  try {
    store = game.settings?.storage?.get?.("world");
  } catch (_) { return; }
  if (!store) return;

  const removed = [];
  const moved = [];
  for (const name of ORPHANED_SECRETS) {
    try {
      const doc = [...store].find(s => s?.key === name);
      if (!doc) continue;
      let val = doc.value;
      try { val = JSON.parse(val); } catch (_) { /* stored as plain text */ }
      val = typeof val === "string" ? val.trim() : "";
      if (!val) {                       // already blank: drop the empty record quietly
        await doc.delete();
        continue;
      }
      // ⚠️ MOVED BEFORE IT IS DELETED (his rule, 2026-10-13: "move it into the
      // client setting on the computer that has it and delete the world copy").
      // Into this computer's own Engine key, and never over one already saved
      // here. Nothing in ACE uses a Google key, so that one has nowhere to go.
      const where = await _moveIntoThisComputer(name, val);
      if (where) moved.push(`${name} → ${where}`);
      await doc.delete();
      removed.push(name.split(".").pop());
    } catch (err) {
      console.warn(`${LOG} | could not remove "${name}":`, err);
    }
  }
  if (moved.length) console.log(`${LOG} | moved into this computer's own settings: ${moved.join("; ")}.`);

  if (!removed.length) {
    console.log(`${LOG} | nothing left over from ACE Envoy.`);
    return;
  }

  // ⚠️ SAY IT, and say what it means. A key that sat in world storage was
  // readable by every player at the table for as long as it was there, and the
  // GM is the only person who can decide whether to rotate it.
  ui.notifications?.warn(
    `ACE Engine removed ${removed.length} leftover API key${removed.length === 1 ? "" : "s"} ` +
    `(${removed.join(", ")}) from ACE Envoy, which was deleted before it could clean up after itself. ` +
    `Those keys were stored where any player could read them, so treat them as exposed and replace them ` +
    `at the provider.`, { permanent: true });
  console.warn(`${LOG} | removed leftover Envoy secrets: ${removed.join(", ")}. Rotate them.`);
}

/**
 * Put an old Envoy key where ACE Engine keeps that key on this computer, unless
 * one is already saved there. Says where it went by name; never the key.
 * @returns {Promise<string|null>} the place it went, or null when it was not moved
 */
async function _moveIntoThisComputer(name, value) {
  try {
    if (name === "ace-envoy.elevenLabsKey") {
      const has = String(game.settings.get(MODULE_ID, "elevenLabsApiKey") ?? "").trim();
      if (has) return null;
      await game.settings.set(MODULE_ID, "elevenLabsApiKey", value);
      return "ace-engine.elevenLabsApiKey (this computer)";
    }
    if (name === "ace-envoy.openAiKey") {
      const { getSecretVault, setSecretVault } = await import("./settings.mjs");
      const vault = { ...(getSecretVault() ?? {}) };
      if (String(vault.openai ?? "").trim()) return null;
      vault.openai = value;
      await setSecretVault(vault);
      return "ace-engine's OpenAI key (this computer)";
    }
  } catch (err) {
    console.warn(`${LOG} | could not move "${name}" into this computer's settings; it is removed from the world anyway:`, err);
  }
  return null;
}
