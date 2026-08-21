// ─── ACE — a slider should not move because you scrolled past it ────────────
//
// Johnny, twice now: "if you're mousing around, next thing you know a slider is
// scrolling. I hope you fix that where you actually have to mouse over it and
// move it."
//
// ⚠️ THIS IS DEFAULT BROWSER BEHAVIOUR, NOT A BUG WE WROTE - which is exactly
// why looking at our own code never found it. Every browser changes an
// <input type="range"> value on a mouse wheel while the pointer is over it. In
// a settings panel that scrolls, dragging the mouse down the list silently
// rewrites any slider the pointer crosses. The GM never touched it and has no
// idea it changed.
//
// The rule: the wheel scrolls the panel, always. A slider changes only when you
// drag it, use the arrow keys, or click into it first and then scroll - focus
// being the opt-in, because someone who has clicked a slider and then scrolls
// plainly means the slider.
//
// ⚠️ preventDefault ALONE IS NOT THE FIX, and my first attempt at this got it
// wrong twice over. Blurring the input after the event does nothing - the value
// has already changed. And preventDefault on its own stops the value change but
// ALSO eats the scroll, so the panel sits still while the user spins the wheel,
// which is a worse bug than the one being fixed. The event has to be cancelled
// AND the scroll handed on to whatever was going to scroll.

const LOG = "ace-qol | Sliders";

let _installed = false;

/** Nearest ancestor that can actually scroll vertically. */
function _scrollableAncestor(el) {
  let n = el?.parentElement;
  while (n && n !== document.body) {
    const s = getComputedStyle(n);
    const scrolls = /(auto|scroll|overlay)/.test(s.overflowY);
    if (scrolls && n.scrollHeight > n.clientHeight) return n;
    n = n.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

export function installSliderGuard() {
  if (_installed) return;
  _installed = true;

  // Capture phase so this runs before the control's own handling.
  // `passive: false` is required or preventDefault is ignored outright.
  document.addEventListener("wheel", (ev) => {
    const el = ev.target;
    if (!(el instanceof HTMLInputElement) || el.type !== "range") return;
    if (document.activeElement === el) return;      // they clicked in: they mean it

    ev.preventDefault();                            // the value does not move
    const sc = _scrollableAncestor(el);
    if (sc) sc.scrollTop += ev.deltaY;              // but the panel still does
  }, { capture: true, passive: false });

  console.debug(`${LOG} | wheel scrolls the panel instead of editing sliders you pass over`);
}
