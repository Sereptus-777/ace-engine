// ─── The listening panel ────────────────────────────────────────────────────
//
// ⚠️ WHAT THIS GUARDS. Johnny, 2026-09-06: *"build the panel, make sure I can
// pop it out so I can put it on a different screen. I don't need it blocking my
// map."* The panel is a real browser window driven from the Foundry page, and
// the rules that matter are not about layout:
//
//   • a dropped item disappears and never reaches the journal
//   • the send button counts what it is actually about to write
//   • an item the extractor was unsure about SAYS so
//   • a speaker keeps the same colour all night
//   • when the service is down it says which address failed, not "no data"
//   • the polling loop stops itself when he closes the window
//
// Run:  node tools/ears-panel-selftest.mjs

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

// ── The smallest document that lets the renderer run and be read back ──
const makeWin = () => {
  const root = { id: "ace-ears-root", innerHTML: "" };
  return {
    closed: false,
    alert: () => {},
    document: {
      getElementById: (id) => (id === "ace-ears-root" ? root : null),
      querySelectorAll: () => [],
    },
    _html: () => root.innerHTML,
  };
};

globalThis.canvas = { scene: { name: "Amber Temple: Lower" }, tokens: { placeables: [] } };
globalThis.game = {
  user: { isGM: true },
  settings: { get: () => "http://127.0.0.1:7867", register: () => {} },
  actors: [], scenes: [], journal: [],
  modules: { get: () => ({ api: {} }) },
};
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {} };

const { EarsPanel } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-engine/scripts/ears-panel.mjs");

const session = ({ flagged = [], heard = [], paused = false, errors = [] } = {}) => ({
  started: "2026-09-06T21:00:00+00:00",
  paused, speakers: ["Aaron", "Johnny", "Sudy"], audioSeconds: 754,
  heard, flagged, errors,
  counts: { heard: heard.length, flagged: flagged.length,
            kept: flagged.filter(f => f.decision === "keep").length,
            undecided: flagged.filter(f => !f.decision).length },
});
const item = (o) => ({ id: "i1", kind: "deal", speaker: "Aaron", confidence: "high",
                       text: "Firaxis spared Vilnius for the location of the relics.",
                       quote: "I will take the deal.", ...o });

console.log("\nWHAT IT SHOWS");
{
  const win = makeWin();
  EarsPanel._render(win, session({
    heard: [{ id: "h1", speaker: "Sudy", text: "is anyone else getting pizza" }],
    flagged: [item({})],
  }));
  const html = win._html();
  check("the transcript line is shown verbatim", /getting pizza/.test(html), true);
  check("the flagged item is shown", /spared Vilnius/.test(html), true);
  check("with the quote that justifies it", /I will take the deal/.test(html), true);
  check("and the speaker is named", /Aaron/.test(html), true);
  // ⚠️ The pizza line must be in the transcript and NOT in the flagged column.
  // That gap is the entire feature.
  check("the table talk was not flagged", /class="card"[\s\S]*pizza/.test(html), false);
}

console.log("\nUNSURE IS SAID OUT LOUD");
{
  // ⚠️🔴 A guess presented with the same weight as a certainty is how a journal
  // fills up with things nobody said.
  const win = makeWin();
  EarsPanel._render(win, session({ flagged: [item({ confidence: "low" })] }));
  check("a low-confidence item is marked unsure", /unsure/.test(win._html()), true);
  const sure = makeWin();
  EarsPanel._render(sure, session({ flagged: [item({ confidence: "high" })] }));
  check("a confident one is not", /unsure/.test(sure._html()), false);
}

console.log("\nDROPPED MEANS GONE");
{
  // The service already withholds dropped items, and the panel must not
  // resurrect one that arrives anyway.
  const win = makeWin();
  EarsPanel._render(win, session({ flagged: [item({ decision: "keep" })] }));
  check("a kept item is marked kept", /· kept/.test(win._html()), true);
}

console.log("\nTHE BUTTON COUNTS WHAT IT WILL WRITE");
{
  // ⚠️🔴 THE ONE THAT MUST NOT LIE. He is about to write to his campaign log and
  // the number on the button is his only warning of how much.
  const win = makeWin();
  EarsPanel._render(win, session({ flagged: [
    item({ id: "a", decision: "keep" }), item({ id: "b", decision: "keep" }),
    item({ id: "c" }), item({ id: "d", confidence: "low" }),
  ] }));
  check("two kept, so the button says two", /Send 2 kept to journal/.test(win._html()), true);
  check("and two still need a decision", /2 to review/.test(win._html()), true);
}
{
  const win = makeWin();
  EarsPanel._render(win, session({ flagged: [item({})] }));
  check("nothing kept says zero", /Send 0 kept to journal/.test(win._html()), true);
}

console.log("\nA SPEAKER KEEPS ONE COLOUR");
{
  const a1 = EarsPanel.colourFor("Aaron");
  EarsPanel.colourFor("Johnny");
  EarsPanel.colourFor("Sudy");
  check("Aaron is the same colour later", EarsPanel.colourFor("Aaron"), a1);
  check("and a different one from Johnny",
    EarsPanel.colourFor("Johnny") !== a1, true);
}

console.log("\nWHEN THE SERVICE IS DOWN IT SAYS WHICH ADDRESS");
{
  // ⚠️ "No data" is the message that wastes an evening. Name the address and
  // give the command that starts it.
  const win = makeWin();
  EarsPanel._renderOffline(win, new Error("Failed to fetch"));
  const html = win._html();
  check("it names the address it tried", /127\.0\.0\.1:7867/.test(html), true);
  check("it shows the underlying error", /Failed to fetch/.test(html), true);
  check("and it gives the command to start it", /python server\.py/.test(html), true);
}

console.log("\nCLOSING THE WINDOW STOPS THE POLLING");
{
  // ⚠️ He will close that window on the other screen and never think about it
  // again. A timer left polling a dead document is a leak nobody would notice.
  let cleared = 0;
  globalThis.clearInterval = () => { cleared++; };
  EarsPanel._timer = 1;
  EarsPanel._win = { closed: true };
  await EarsPanel._tick();
  check("the timer was cleared", cleared, 1);
  check("and forgotten", EarsPanel._timer, null);
}

console.log("\nAND ESCAPING, BECAUSE PLAYERS TYPE ANYTHING");
{
  const win = makeWin();
  EarsPanel._render(win, session({
    heard: [{ id: "h1", speaker: "Sudy", text: '<img src=x onerror="alert(1)">' }],
  }));
  const html = win._html();
  check("markup in a transcript is escaped", /&lt;img/.test(html), true);
  check("and never rendered live", /<img src=x/.test(html), false);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
