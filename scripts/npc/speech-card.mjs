// ─── A SPOKEN LINE IS A BLACK CARD WITH A NAME ON IT ─────────────────────────
//
// His rule, 2026-10-05: "Every speaker gets a name. The construct's lines are
// bare quotes, so nobody can tell who is talking. Use the black ACE card, not
// the default Foundry one. The words are that speaker's color. A player
// character uses the color of the player who owns him: Firaxis Greenbeard is
// green. When I am the one talking, the text is red. Anyone who is not a player
// character and not me is white."
//
// ⚠️🔴 WHY THE NAME WAS MISSING, AND IT WAS OUR OWN DOING. These lines posted as
// a bare paragraph and leaned on Foundry's speaker strip to say who spoke. Every
// ACE card hides that strip (the chrome law, and chat-render-utils stamps any
// message carrying an ace flag), and a conversation line carries one. So the
// strip went, the name went with it, and what was left was a quote from nobody on
// Foundry's parchment. The name is inside the card now, where nothing can take it
// off, and the card brings its own black ground.
//
// A LEAF: imports nothing, so the panel and the conversation window can both ask
// it instead of each drawing a line its own way.
// ──────────────────────────────────────────────────────────────────────────────

/** A user's own colour, whatever shape Foundry hands it over in. */
function userColour(user) {
  const c = user?.color;
  if (!c) return null;
  if (typeof c === "string") return c;
  return c.css ?? c.toString?.() ?? null;
}

/**
 * The same colour, lifted until it reads on ACE's black ground.
 *
 * ⚠️🔴 A PLAYER'S COLOUR IS CHOSEN AGAINST FOUNDRY'S PARCHMENT (his rule,
 * 2026-10-05: "all of these have to be a little bit brighter because it's on a
 * black background"). A dark green or a navy blue is a perfectly good name
 * colour on cream and nearly invisible on #14100c. The hue and the saturation
 * are his player's own; only the lightness is raised, and only when it is too
 * low, so green stays green and red stays red.
 *
 * @param {string|null} hex   #rgb or #rrggbb
 * @param {number} floor      the lightness it must reach, 0 to 1
 * @returns {string|null}
 */
function brighten(hex, floor = 0.66) {
  if (!hex) return null;
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return hex;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (l >= floor) return `#${h}`;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  // Back out of HSL with the lightness raised and the hue and saturation kept.
  const c = (1 - Math.abs(2 * floor - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = floor - c / 2;
  const [rr, gg, bb] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0]
    : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const two = (v) => Math.round(Math.min(1, Math.max(0, v + m)) * 255)
    .toString(16).padStart(2, "0");
  return `#${two(rr)}${two(gg)}${two(bb)}`;
}

/**
 * The colour a line is spoken in.
 *
 *   me, and that includes a line I put in a construct's mouth -> red
 *   a player character  -> the colour of the player who owns him, brightened
 *   anybody else        -> white
 *
 * ⚠️ MY PUPPET LINES ARE RED TOO (his correction, 2026-10-05). The first version
 * said the speaker was the construct, so a line the GM typed came out white. He
 * wants to see which lines are his, whoever's mouth they came out of. A line the
 * AI wrote stays the construct's colour, because he did not type it: the caller
 * passes the user only when a person typed that line.
 *
 * @param {{actor?: Actor|null, user?: User|null}} who
 * @returns {string} a CSS colour
 */
export function speechColour({ actor = null, user = null } = {}) {
  if (user?.isGM) return "#ff6b6b";          // already bright enough on black
  if (actor?.hasPlayerOwner) {
    const owner = game.users?.find(u => !u.isGM && actor.testUserPermission?.(u, "OWNER"));
    const hex = brighten(userColour(owner));
    if (hex) return hex;
  }
  if (user && !user.isGM) {
    const hex = brighten(userColour(user));
    if (hex) return hex;
  }
  return "#ffffff";
}

/**
 * The card: black, the speaker's name, and the words in their colour.
 *
 * @param {string} name      who is talking
 * @param {string} bodyHtml  what they said, already escaped by the caller
 * @param {string} colour    from `speechColour`
 * @returns {string} HTML
 */
export function speechCard(name, bodyHtml, colour) {
  const who = String(name ?? "Someone");
  return `<div class="ace-speech" style="background:#14100c;border-left:4px solid ${colour};`
    + `border-radius:4px;padding:9px 12px;line-height:1.55;">`
    + `<div style="color:${colour};font-weight:700;font-size:15px;letter-spacing:.03em;`
    + `margin-bottom:3px;">${who}</div>`
    + `<div style="color:${colour};font-size:16px;">${bodyHtml}</div></div>`;
}
