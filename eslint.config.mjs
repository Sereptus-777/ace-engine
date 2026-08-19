// Minimal ESLint config — ONE job: catch identifiers that don't exist.
//
// `node --check` validates SYNTAX only. A reference to an undeclared variable is
// perfectly valid syntax and throws only when that line actually runs. Added to
// ace-engine 2026-08-06 after the voice-input rebuild shipped two references to
// `ACEConversationApp` — a class that does not exist; the real name is
// `ConversationApp`. node --check passed it happily. It would have thrown a
// ReferenceError the first time a player pressed the mic. This caught it.
//
// Mirrors ace-qol/eslint.config.mjs deliberately: same rule, same reasoning,
// same warning about the globals list.
//
//   npx --yes eslint@9 "scripts/**/*.mjs"

const FOUNDRY_GLOBALS = [
  // Foundry core
  "game", "canvas", "ui", "CONFIG", "CONST", "Hooks", "foundry",
  "Roll", "ChatMessage", "Actor", "Item", "ActiveEffect", "Macro", "Folder",
  "JournalEntry", "JournalEntryPage", "RollTable", "Playlist", "PlaylistSound",
  "Token", "TokenDocument", "Scene", "Combat", "Combatant", "CombatTracker",
  "User", "Users", "Dialog", "DialogV2", "Application", "FormApplication",
  "DocumentSheetConfig", "FilePicker", "ImageHelper", "AudioHelper", "Color",
  "SceneNavigation", "renderTemplate", "loadTemplates", "TextEditor", "Handlebars",
  "fromUuid", "fromUuidSync", "duplicate", "mergeObject", "getProperty",
  "setProperty", "randomID", "jQuery", "$", "Actors", "Items", "Journal",
  "ChatLog", "SettingsConfig", "KeybindingsConfig", "Tour", "ProseMirror",
  "SearchFilter", "ContextMenu", "DragDrop", "Hotbar",
  // ⚠️ NEVER add a name here just to silence no-undef. Verify it is a real
  // global FIRST. In ace-qol, a false `Ray` entry turned this lint from a safety
  // net into a blindfold and hid two live wall-checking bugs — `Ray` is not a
  // global in V13, it lives at foundry.canvas.geometry.Ray. The same trap
  // applies to anything you are tempted to add without checking.
  // Third-party modules ACE talks to
  "Sequence", "Sequencer", "PIXI", "TokenMagic", "warpgate", "socketlib", "libWrapper",
  // `SimpleCalendar` is a THIRD-PARTY global — it exists only when the Simple
  // Calendar module is installed and active, so whitelisting it could in theory
  // hide a real ReferenceError. VERIFIED 2026-08-06 before adding: every one of
  // the 15 references in simple-calendar-bridge.mjs is either behind
  // `isAvailable()` (which checks game.modules.get("foundryvtt-simple-calendar")
  // is active) / `this._active`, or inside a try/catch that returns null. Nothing
  // touches it on a world without the module. Re-verify if that file changes.
  "SimpleCalendar",
  // Browser / platform
  "console", "window", "document", "fetch", "URL", "URLSearchParams", "Blob",
  "FileReader", "File", "FormData", "Headers", "Request", "Response", "WebSocket",
  "localStorage", "sessionStorage", "requestAnimationFrame", "cancelAnimationFrame",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "structuredClone", "AbortController", "AbortSignal", "TextDecoder", "TextEncoder",
  "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "PointerEvent",
  "HTMLElement", "HTMLImageElement", "HTMLCanvasElement", "Node", "NodeList",
  "HTMLInputElement", "HTMLVideoElement", "HTMLSelectElement", "HTMLTextAreaElement",
  "customElements", "DOMParser", "XMLSerializer", "globalThis", "process",
  "Image", "Audio", "performance", "navigator", "location", "alert", "confirm",
  "prompt", "CSS", "CompressionStream", "DecompressionStream",
  "atob", "btoa", "crypto", "getComputedStyle", "MutationObserver", "ResizeObserver",
  // Audio / speech — the NPC voice stack lives on these
  "AudioContext", "webkitAudioContext", "SpeechSynthesisUtterance",
  "SpeechRecognition", "webkitSpeechRecognition", "MediaRecorder", "MediaStream",
  "Uint8Array", "ArrayBuffer", "DataView",
];

const globals = Object.fromEntries(FOUNDRY_GLOBALS.map(g => [g, "readonly"]));

export default [
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals },
    rules: {
      // THE rule. Any error here is a guaranteed runtime ReferenceError.
      // Keep this at zero.
      "no-undef": "error",
      // ⚠️ THE RULE THAT WOULD HAVE CAUGHT HASTE. A duplicate key in an object
      // literal is silently resolved by JavaScript in favour of the LAST one:
      // Haste's live copy granted only +2 AC for months because the definition
      // holding the speed doubling and the Dex-save advantage sat above a second
      // one with the same key. Added 2026-08-19 after a hand-rolled scanner
      // produced 26 false positives and 2 real hits - a real parser does this
      // correctly and for free. Keep at error.
      "no-dupe-keys": "error",
      "no-dupe-else-if": "error",
      "no-unsafe-negation": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      "no-constant-condition": "error",
      // WARN, not error: it also flags the legal pattern of a callback
      // referencing a const declared further down the same scope (hook cleanup,
      // drag handlers) — those run after initialisation and are fine. Kept on
      // because it DOES catch the dangerous version: a const read inside its own
      // temporal dead zone. If the count moves, read the new one.
      "no-use-before-define": ["warn", { functions: false, classes: false, variables: true }],
    },
  },
];
