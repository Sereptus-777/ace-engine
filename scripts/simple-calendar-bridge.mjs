// ============================================================
// ACE — AI Campaign Engine — Simple Calendar Bridge
// Optional two-way sync between ACE narrative time and the
// Simple Calendar module (foundryvtt-simple-calendar).
//
// Design:
//  • ACE time changes → push to Simple Calendar
//  • Simple Calendar changes → update ACE's day counter / time
//  • Graceful no-op when SC is absent or setting is off
//  • Never a hard dependency — purely opt-in enhancement
// ============================================================

import { MODULE_ID } from "./ace-engine.mjs";

// ── Time-of-day → hour mapping ──────────────────────────────
// ACE uses 5 named periods; SC uses 24-hour clock.
const TIME_TO_HOUR = {
  morning:   7,   // 7 AM
  midday:    12,  // noon
  afternoon: 15,  // 3 PM
  evening:   19,  // 7 PM
  night:     22,  // 10 PM
};

const HOUR_TO_TIME = [
  [5,  "morning"],    // 5 AM – 10:59
  [11, "midday"],     // 11 AM – 13:59
  [14, "afternoon"],  // 2 PM – 17:59
  [18, "evening"],    // 6 PM – 20:59
  [21, "night"],      // 9 PM – 4:59 (wraps)
];

/**
 * Convert a 0-23 hour to an ACE time-of-day string.
 * @param {number} hour
 * @returns {string}
 */
function hourToTimePeriod(hour) {
  // Walk backward through thresholds
  for (let i = HOUR_TO_TIME.length - 1; i >= 0; i--) {
    if (hour >= HOUR_TO_TIME[i][0]) return HOUR_TO_TIME[i][1];
  }
  return "night";  // 0–4 AM = still night
}

/**
 * SimpleCalendarBridge — thin adapter between ACE's narrative time
 * and the Simple Calendar module (if installed & active).
 *
 * Lifecycle:
 *   const bridge = new SimpleCalendarBridge(memoryManager);
 *   bridge.activate();    // start listening
 *   bridge.deactivate();  // stop listening (optional cleanup)
 */
export class SimpleCalendarBridge {
  /** @param {MemoryManager} mm */
  constructor(mm) {
    this._mm      = mm;
    this._active  = false;
    this._hookId  = null;

    // Guard against re-entrant loops: when ACE pushes a change to SC,
    // SC fires its hook, which could push back to ACE, etc.  This flag
    // suppresses the SC→ACE direction during an ACE→SC push.
    this._pushing = false;

    // Cache last SC day we saw so we can calculate day deltas.
    this._lastScDay = null;
  }

  // ── Public API ──────────────────────────────────────────────

  /** Is Simple Calendar installed and active? */
  static isAvailable() {
    return !!game.modules.get("foundryvtt-simple-calendar")?.active;
  }

  /** Is the sync setting currently enabled? */
  static isEnabled() {
    try {
      return game.settings.get(MODULE_ID, "syncSimpleCalendar") ?? false;
    } catch (err) { console.debug("ace-engine | SimpleCalendarBridge isEnabled setting read failed:", err); return false; }
  }

  /** Convenience: available AND enabled. */
  static shouldSync() {
    return SimpleCalendarBridge.isAvailable() && SimpleCalendarBridge.isEnabled();
  }

  /**
   * Start listening for Simple Calendar date/time changes.
   * Safe to call multiple times — only registers once.
   */
  activate() {
    if (this._active) return;
    if (!SimpleCalendarBridge.isAvailable()) {
      console.debug(`${MODULE_ID} | Simple Calendar bridge: module not installed — bridge inactive.`);
      return;
    }
    if (!SimpleCalendarBridge.isEnabled()) {
      console.debug(`${MODULE_ID} | Simple Calendar bridge: sync disabled in settings — bridge inactive.`);
      return;
    }

    // Listen for SC date/time changes
    try {
      this._hookId = Hooks.on(SimpleCalendar.Hooks.DateTimeChange, (data) => {
        this._onScDateTimeChange(data);
      });

      // Snapshot current SC day for delta tracking
      this._snapshotScDay();

      this._active = true;
      console.log(`${MODULE_ID} | Simple Calendar bridge activated (SC day baseline: ${this._lastScDay}).`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Simple Calendar bridge failed to activate:`, err);
    }
  }

  /** Stop listening. */
  deactivate() {
    if (!this._active) return;
    if (this._hookId !== null) {
      try { Hooks.off(SimpleCalendar.Hooks.DateTimeChange, this._hookId); }
      catch { /* already unregistered */ }
      this._hookId = null;
    }
    this._active  = false;
    this._pushing = false;
    console.log(`${MODULE_ID} | Simple Calendar bridge deactivated.`);
  }

  // ── ACE → Simple Calendar pushes ────────────────────────────

  /**
   * Push an ACE day advance to Simple Calendar.
   * Called from memory-manager / panel when a rest or narration advances the day.
   * @param {number} days — number of days to advance (usually 1)
   * @param {string} [timeOfDay] — ACE time period to set (optional)
   */
  pushDayAdvance(days = 1, timeOfDay) {
    if (!this._active || this._pushing) return;
    try {
      this._pushing = true;
      SimpleCalendar.api.changeDate({ day: days });
      if (timeOfDay && TIME_TO_HOUR[timeOfDay] !== undefined) {
        const dt = SimpleCalendar.api.currentDateTime();
        SimpleCalendar.api.setDate({
          year:   dt.year,
          month:  dt.month,
          day:    dt.day,
          hour:   TIME_TO_HOUR[timeOfDay],
          minute: 0,
          second: 0,
        });
      }
      // Update baseline
      this._snapshotScDay();
      console.log(`${MODULE_ID} | SC bridge: pushed +${days} day(s)${timeOfDay ? `, time → ${timeOfDay}` : ""}`);
    } catch (err) {
      console.warn(`${MODULE_ID} | SC bridge: failed to push day advance:`, err);
    } finally {
      // Release the guard after a tick so the SC hook has time to fire and be ignored
      setTimeout(() => { this._pushing = false; }, 200);
    }
  }

  /**
   * Push an ACE time-of-day change to Simple Calendar.
   * @param {string} timeOfDay — ACE time period name
   */
  pushTimeChange(timeOfDay) {
    if (!this._active || this._pushing) return;
    if (!TIME_TO_HOUR[timeOfDay]) return;
    try {
      this._pushing = true;
      const dt = SimpleCalendar.api.currentDateTime();
      SimpleCalendar.api.setDate({
        year:   dt.year,
        month:  dt.month,
        day:    dt.day,
        hour:   TIME_TO_HOUR[timeOfDay],
        minute: 0,
        second: 0,
      });
      console.log(`${MODULE_ID} | SC bridge: pushed time → ${timeOfDay} (hour ${TIME_TO_HOUR[timeOfDay]})`);
    } catch (err) {
      console.warn(`${MODULE_ID} | SC bridge: failed to push time change:`, err);
    } finally {
      setTimeout(() => { this._pushing = false; }, 200);
    }
  }

  /**
   * Push a manual day-counter set (prev/next buttons) to Simple Calendar.
   * @param {number} targetDay — the ACE day counter to set to
   * @param {string} [timeOfDay] — current ACE time period
   */
  pushDaySet(targetDay, timeOfDay) {
    if (!this._active || this._pushing) return;
    try {
      this._pushing = true;
      // Calculate delta from our last known SC day
      const currentScDay = this._getScDayNumber();
      const delta = targetDay - (currentScDay ?? targetDay);
      if (delta !== 0) {
        SimpleCalendar.api.changeDate({ day: delta });
      }
      if (timeOfDay && TIME_TO_HOUR[timeOfDay] !== undefined) {
        const dt = SimpleCalendar.api.currentDateTime();
        SimpleCalendar.api.setDate({
          year:   dt.year,
          month:  dt.month,
          day:    dt.day,
          hour:   TIME_TO_HOUR[timeOfDay],
          minute: 0,
          second: 0,
        });
      }
      this._snapshotScDay();
      console.log(`${MODULE_ID} | SC bridge: pushed day set → Day ${targetDay}`);
    } catch (err) {
      console.warn(`${MODULE_ID} | SC bridge: failed to push day set:`, err);
    } finally {
      setTimeout(() => { this._pushing = false; }, 200);
    }
  }

  // ── Simple Calendar → ACE listener ──────────────────────────

  /**
   * Callback when Simple Calendar fires a date/time change.
   * Updates ACE's internal day counter and time-of-day.
   * @param {object} data — SC hook data
   */
  _onScDateTimeChange(data) {
    if (this._pushing) return;  // We caused this change — ignore
    if (!this._mm) return;

    try {
      const dt   = data?.date ?? SimpleCalendar.api.currentDateTime();
      const hour = dt?.hour ?? 0;
      const newTime = hourToTimePeriod(hour);

      // Detect day change: compare with our baseline
      const scDay = this._getScDayNumber();
      if (scDay !== null && this._lastScDay !== null) {
        const dayDelta = scDay - this._lastScDay;
        if (dayDelta !== 0) {
          // Apply delta to ACE's day counter
          const currentAceDay = this._mm.getDayCounter();
          const newAceDay = Math.max(1, currentAceDay + dayDelta);
          this._mm.world._data.calendar.dayCounter = newAceDay;
          this._mm.world._dirty = true;
          console.log(`${MODULE_ID} | SC bridge: SC day change detected (delta ${dayDelta}) → ACE Day ${newAceDay}`);
        }
      }

      // Always sync time-of-day from SC hour
      const currentTime = this._mm.getTimeOfDay();
      if (newTime !== currentTime) {
        this._mm.world.setTimeOfDay(newTime);
        console.log(`${MODULE_ID} | SC bridge: SC time → ${newTime} (hour ${hour})`);
      }

      // Save ACE state
      this._mm._scheduleSave?.("world");

      // Update baseline
      this._lastScDay = scDay;

      // Notify panel to refresh the day chip UI
      Hooks.callAll(`${MODULE_ID}.timeSync`);
    } catch (err) {
      console.warn(`${MODULE_ID} | SC bridge: failed to process SC change:`, err);
    }
  }

  // ── Display string helpers ──────────────────────────────────

  /**
   * Get a rich date/time display string from Simple Calendar.
   * Returns something like "15th of Mirtul, 1492 DR" or null if SC unavailable.
   * @returns {string|null}
   */
  getDisplayDate() {
    if (!this._active) return null;
    try {
      const display = SimpleCalendar.api.currentDateTimeDisplay();
      if (!display) return null;
      // display.date is usually "Month Day, Year" format
      // display.time is "HH:MM:SS" format
      return display.date || null;
    } catch (err) { console.debug("ace-engine | SimpleCalendarBridge getDisplayDate failed:", err); return null; }
  }

  /**
   * Get display time string from Simple Calendar.
   * Returns something like "3:00 PM" or null.
   * @returns {string|null}
   */
  getDisplayTime() {
    if (!this._active) return null;
    try {
      const display = SimpleCalendar.api.currentDateTimeDisplay();
      return display?.time || null;
    } catch (err) { console.debug("ace-engine | SimpleCalendarBridge getDisplayTime failed:", err); return null; }
  }

  /**
   * Get a full formatted string suitable for AI context injection.
   * Returns "15th of Mirtul, 1492 DR — Afternoon (3:00 PM)" or null.
   * @returns {string|null}
   */
  getFormattedDateTime() {
    if (!this._active) return null;
    try {
      const display = SimpleCalendar.api.currentDateTimeDisplay();
      if (!display?.date) return null;
      const parts = [display.date];
      if (display.time) parts.push(display.time);
      return parts.join(" — ");
    } catch (err) { console.debug("ace-engine | SimpleCalendarBridge getFormattedDateTime failed:", err); return null; }
  }

  // ── Internal helpers ────────────────────────────────────────

  /** Get the SC "day number" (day-of-year from the SC timestamp). */
  _getScDayNumber() {
    try {
      const dt = SimpleCalendar.api.currentDateTime();
      // We track a sequential day number by composing year*1000 + day-of-year
      // This handles year transitions and arbitrary calendar systems.
      const dayOfYear = dt.day ?? 0;
      const year = dt.year ?? 0;
      const month = dt.month ?? 0;
      // Approximate: SC months have variable lengths, so we use a simple sum
      // of (month * 30 + day) as a relative offset.  The absolute value
      // doesn't matter — we only need deltas.
      return year * 400 + month * 32 + dayOfYear;
    } catch (err) { console.debug("ace-engine | SimpleCalendarBridge _getScDayNumber failed:", err); return null; }
  }

  /** Cache the current SC day for delta tracking. */
  _snapshotScDay() {
    this._lastScDay = this._getScDayNumber();
  }
}
