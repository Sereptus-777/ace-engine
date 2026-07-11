// ============================================================
// ACE — AI Campaign Engine — Canvas Highlight System
// Applies a glow/outline to canvas objects when hovered
// in the Select Scene Elements panel.
// Also provides a persistent subtle glow on PC tokens so
// the GM can quickly spot them on complex maps.
// ============================================================

export class CanvasHighlight {

  static #activeHighlights = new Map();
  static #pcGlowFilters    = new Map();   // tokenId → filter

  static highlight(id, type) {
    const obj = this._getCanvasObject(id, type);
    if (!obj) return;

    try {
      // v13+: namespaced under foundry.canvas.rendering.filters; v12: global OutlineOverlayFilter
      const FilterClass = foundry?.canvas?.rendering?.filters?.OutlineOverlayFilter
                       ?? globalThis.OutlineOverlayFilter
                       ?? null;
      if (FilterClass) {
        const outline = new FilterClass({
          outlineColor: [0.79, 0.66, 0.30, 1],
          thickness: 3,
          wave: true,
        });
        const target = obj.mesh ?? obj;
        const filters = target.filters ?? [];
        obj._aceOrigFilters = [...filters];
        target.filters = [...filters, outline];
        this.#activeHighlights.set(id, { obj, filter: outline, type });
        return;
      }
    } catch (_) { /* fall through */ }

    this._applyFallbackHighlight(obj, id, type);
  }

  static unhighlight(id, type) {
    const entry = this.#activeHighlights.get(id);
    if (!entry) return;

    const { obj, filter } = entry;
    try {
      const target = obj.mesh ?? obj;

      // Remove the specific ACE filter if it's still in the array
      if (filter && target.filters) {
        const idx = target.filters.indexOf(filter);
        if (idx >= 0) {
          const cleaned = [...target.filters];
          cleaned.splice(idx, 1);
          target.filters = cleaned.length ? cleaned : null;
        }
      } else if (obj._aceOrigFilters) {
        target.filters = obj._aceOrigFilters;
      }
      delete obj._aceOrigFilters;

      // Stop fallback animation
      if (obj._aceAnim) {
        cancelAnimationFrame(obj._aceAnim);
        delete obj._aceAnim;
        target.alpha = 1;
      }
    } catch (e) {
      // Object may have been destroyed — just clean up tracking
    }
    this.#activeHighlights.delete(id);
  }

  static clearAll() {
    for (const [id, entry] of this.#activeHighlights) {
      this.unhighlight(id, entry.type);
    }
  }

  static _getCanvasObject(id, type) {
    if (!canvas?.ready) return null;
    if (type === "tile") return canvas.tiles?.get(id) ?? null;
    if (type === "player") return canvas.tokens?.placeables.find((t) => t.actor?.id === id) ?? null;
    return canvas.tokens?.get(id) ?? null;
  }

  static _applyFallbackHighlight(obj, id, type) {
    const target = obj.mesh ?? obj;
    let time = 0;
    const animate = () => {
      time += 0.05;
      target.alpha = 0.7 + 0.3 * Math.sin(time * 4);
      obj._aceAnim = requestAnimationFrame(animate);
    };
    obj._aceAnim = requestAnimationFrame(animate);
    this.#activeHighlights.set(id, { obj, type });
  }

  // ── Persistent PC Glow ─────────────────────────────────────
  // Soft colored drop shadow beneath PC tokens so the GM can
  // spot them easily on busy maps. Uses the owning player's
  // chosen color. Called from refreshToken hook.

  /**
   * Apply or refresh a soft colored drop-shadow glow beneath a token
   * if it belongs to a PC. Safe to call on every refreshToken — skips
   * non-PC tokens and avoids duplicate shadows.
   */
  static applyPcGlow(token) {
    if (!token?.actor?.hasPlayerOwner || token.actor.type !== "character") return;

    // Already has a disc — skip unless lost to a re-render
    if (this.#pcGlowFilters.has(token.id)) {
      const entry = this.#pcGlowFilters.get(token.id);
      if (entry?.shadow && token.children?.includes(entry.shadow)) return;
      this.removePcGlow(token);
    }

    // ── Color resolution ──
    let hexColor = "#e51c1c"; // fallback red
    let colorMode = "player";
    try { colorMode = game.settings.get("ace-engine", "pcGlowColorMode") ?? "player"; }
    catch (_) {}
    if (colorMode === "custom") {
      try { hexColor = game.settings.get("ace-engine", "pcGlowCustomColor") ?? "#d4af37"; }
      catch (_) { hexColor = "#d4af37"; }
    } else {
      const owner = game.users?.find(u => !u.isGM && token.actor.testUserPermission(u, "OWNER"));
      hexColor = owner?.color?.toString?.() ?? owner?.color ?? "#e51c1c";
    }
    const hexInt = parseInt(String(hexColor).replace("#", ""), 16);

    // ── Geometry ──
    const size = Math.max(token.w ?? 100, token.h ?? 100);
    let sizeScale = 1.0;
    let opacity = 0.85;
    let style = "soft_disc";
    try { const v = game.settings.get("ace-engine", "pcGlowSize");    if (Number.isFinite(v) && v > 0) sizeScale = v; } catch (_) {}
    try { const v = game.settings.get("ace-engine", "pcGlowOpacity"); if (Number.isFinite(v) && v > 0) opacity = v; } catch (_) {}
    try { style = game.settings.get("ace-engine", "pcGlowStyle") ?? "soft_disc"; } catch (_) {}

    const radius = size * 0.55 * sizeScale;
    const center = size / 2;

    // ── Draw based on style ──
    const disc = new PIXI.Graphics();
    // Provably inert: never intercept pointer/hit-testing, never participate in
    // anything but its own draw. (The glow has never patched Sequencer or hooks,
    // so it can't mechanically block an animation's sound — but this guarantees
    // it stays a pure decoration that nothing else has to step around.)
    disc.eventMode = "none";
    disc.interactiveChildren = false;
    if (style === "solid_ring") {
      // Hollow circle outline only — no fill
      disc.lineStyle(4, hexInt, opacity);
      disc.drawCircle(center, center, radius);
    } else if (style === "soft_glow") {
      // Wider falloff halo — thicker line + lower opacity inner fill
      disc.lineStyle(2, hexInt, opacity * 0.5);
      disc.beginFill(hexInt, opacity * 0.4);
      disc.drawCircle(center, center, radius * 1.15);
      disc.endFill();
    } else {
      // soft_disc (default) + pulse use the same draw
      disc.lineStyle(3, 0x000000, opacity * 0.65);
      disc.beginFill(hexInt, opacity);
      disc.drawCircle(center, center, radius);
      disc.endFill();
    }

    // Render BEHIND the token art
    try { token.addChildAt(disc, 0); }
    catch (_) { token.addChild(disc); }

    // ── Pulse animation (only for "pulse" style) ──
    let animFrameId = null;
    if (style === "pulse") {
      const start = performance.now();
      const animate = (now) => {
        if (!disc.parent) return; // destroyed
        const elapsed = (now - start) / 1000;
        // Sine wave 0.85 → 1.15 scale, period ~2s
        const scale = 1 + 0.15 * Math.sin(elapsed * Math.PI);
        disc.scale.set(scale);
        disc.position.set(-(center * (scale - 1)), -(center * (scale - 1)));
        animFrameId = requestAnimationFrame(animate);
      };
      animFrameId = requestAnimationFrame(animate);
    }

    this.#pcGlowFilters.set(token.id, { shadow: disc, animFrameId });
  }

  /** Convert hex color string to [r, g, b] floats (0–1). */
  static _hexToRgb(hex) {
    const h = hex.replace("#", "");
    const bigint = parseInt(h.length === 3
      ? h.split("").map(c => c + c).join("")
      : h, 16);
    return [(bigint >> 16 & 255) / 255, (bigint >> 8 & 255) / 255, (bigint & 255) / 255];
  }

  /** Remove the PC glow from a specific token. */
  static removePcGlow(token) {
    if (!token) return;

    // Stop legacy breathing animation
    if (token._acePcGlowAnim) {
      cancelAnimationFrame(token._acePcGlowAnim);
      delete token._acePcGlowAnim;
    }

    // Stop v0.7.20+ pulse animation (stored on the entry)
    const entryForAnim = this.#pcGlowFilters.get(token.id);
    if (entryForAnim?.animFrameId) {
      cancelAnimationFrame(entryForAnim.animFrameId);
    }

    const entry = this.#pcGlowFilters.get(token.id);
    // Remove shadow sprite
    if (entry?.shadow) {
      try {
        token.removeChild(entry.shadow);
        entry.shadow.destroy({ children: true });
      } catch (_) {}
    }
    // Legacy: remove filter-based glow if present (from old code)
    if (entry?.filter) {
      const target = token.mesh ?? token;
      if (target?.filters) {
        target.filters = target.filters.filter(f => f !== entry.filter);
        if (!target.filters.length) target.filters = null;
      }
    }
    // Legacy: remove ring if present (from old code)
    if (token._acePcRing) {
      try {
        token.removeChild(token._acePcRing);
        token._acePcRing.destroy();
      } catch (_) {}
      delete token._acePcRing;
    }
    this.#pcGlowFilters.delete(token.id);
  }

  /** Refresh PC glow on all tokens in the current scene. */
  static refreshAllPcGlows() {
    if (!canvas?.tokens?.placeables) return;
    for (const token of canvas.tokens.placeables) {
      this.applyPcGlow(token);
    }
  }

  /** Remove all PC glows (e.g. when setting is toggled off). */
  static clearAllPcGlows() {
    for (const [tokenId] of this.#pcGlowFilters) {
      const token = canvas.tokens?.get(tokenId);
      if (token) this.removePcGlow(token);
    }
    this.#pcGlowFilters.clear();
  }
}
