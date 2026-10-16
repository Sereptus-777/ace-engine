// ─── SAVED NARRATIONS, KEPT ON THEIR SCENE ───────────────────────────────────
//
// Johnny, 2026-10-15, the night before the Amber Temple battle: "in Ace Engine,
// I don't have any narration files stored... I need something like that that
// says X5 entry, and then that's where the players are entering and what they
// see." Engine could speak a narration in the narrator voice, but only one
// typed into the box that moment; nothing was ever kept.
//
// Each scene now carries its own list: a title ("X5 entry") and the words. The
// Narration tab shows the list for the scene you are on, each with a Play
// button, and a region drawn on the map can play one when a token walks in
// (narrate-behavior.mjs). Play goes through the one narration path the box
// already uses: the chat card, the narrator voice, every player hears it.
//
// ⚠️ KEPT WHERE THE GM SCENE NOTES ARE: a flag on the scene. Nothing in Foundry
// is hidden from a determined player with a console, and that is as true of
// these as of the notes already stored there.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-engine";
const KEY = "narrations";

/** Titles compare without case or extra spaces: "X5  Entry" is "x5 entry". */
export function sameTitle(a, b) {
  const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return !!norm(a) && norm(a) === norm(b);
}

/** This scene's saved narrations, in the order they were saved. */
export function narrationsOf(scene) {
  const list = scene?.flags?.[MODULE_ID]?.[KEY];
  return Array.isArray(list) ? list.filter(n => n?.id && typeof n.text === "string" && n.text.trim()) : [];
}

/** One saved narration, by its id or its title. */
export function findNarration(scene, which) {
  const list = narrationsOf(scene);
  return list.find(n => n.id === which) ?? list.find(n => sameTitle(n.title, which)) ?? null;
}

/** A scene from a Scene, its id, or its name. */
export function sceneFrom(which) {
  if (!which) return globalThis.canvas?.scene ?? null;
  if (typeof which === "object" && which.documentName === "Scene") return which;
  return game.scenes?.get?.(which) ?? game.scenes?.find?.(s => sameTitle(s.name, which)) ?? null;
}

/**
 * Save a narration on a scene. The same title replaces the words already
 * saved under it, so a corrected line never leaves its old copy behind.
 * @returns {Promise<{entry:object, replaced:boolean}>}
 */
export async function saveNarration(scene, { title, text }) {
  if (!game.user?.isGM) throw new Error("only a GM can save a narration on a scene");
  if (!scene) throw new Error("there is no scene to save it on");
  const t = String(title ?? "").trim();
  const words = String(text ?? "").trim();
  if (!t) throw new Error("a narration needs a title");
  if (!words) throw new Error(`"${t}" has no words to save`);
  const list = narrationsOf(scene).map(n => ({ ...n }));
  const old = list.find(n => sameTitle(n.title, t));
  if (old) {
    // New words need a new recording: the old one says the old words.
    if (old.text !== words) { old.audio = null; old.audioKey = null; }
    old.title = t; old.text = words; old.played = false;
  }
  else list.push({ id: foundry.utils.randomID(), title: t, text: words, played: false });
  await scene.setFlag(MODULE_ID, KEY, list);
  return { entry: old ?? list.at(-1), replaced: !!old };
}

/** Take one off its scene. */
export async function deleteNarration(scene, id) {
  if (!game.user?.isGM || !scene) return false;
  const list = narrationsOf(scene);
  const left = list.filter(n => n.id !== id);
  if (left.length === list.length) return false;
  await scene.setFlag(MODULE_ID, KEY, left);
  return true;
}

/** Remember the recording made for one, and what it was made from. */
export async function setNarrationAudio(scene, id, { audio, audioKey }) {
  if (!game.user?.isGM || !scene) return;
  const list = narrationsOf(scene);
  if (!list.some(n => n.id === id)) return;
  await scene.setFlag(MODULE_ID, KEY, list.map(n => (n.id === id ? { ...n, audio, audioKey } : n)));
}

/** Mark one as played, so the list shows what the table has already heard. */
export async function markPlayed(scene, id) {
  if (!game.user?.isGM || !scene) return;
  const list = narrationsOf(scene);
  const one = list.find(n => n.id === id);
  if (!one || one.played) return;
  await scene.setFlag(MODULE_ID, KEY, list.map(n => (n.id === id ? { ...n, played: true } : n)));
}
