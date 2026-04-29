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

    // Owner's chosen color — falls back to a default red if no owner found.
    const owner = game.users?.find(u => !u.isGM && token.actor.testUserPermission(u, "OWNER"));
    const hexColor = owner?.color?.toString?.() ?? owner?.color ?? "#e51c1c";
    const hexInt = parseInt(hexColor.replace("#", ""), 16);

    const size = Math.max(token.w ?? 100, token.h ?? 100);
    const radius = size * 0.55;   // slightly larger than the token so it peeks out as a ring
    const center = size / 2;

    // Solid disc underneath the token — static, no blur, no pulse.
    // Filled body + darker outline for contrast against varied map backgrounds.
    const disc = new PIXI.Graphics();
    disc.lineStyle(3, 0x000000, 0.55);      // thin dark outline for contrast
    disc.beginFill(hexInt, 0.85);
    disc.drawCircle(center, center, radius);
    disc.endFill();

    // Render BEHIND the token art
    try { token.addChildAt(disc, 0); }
    catch (_) { token.addChild(disc); }

    this.#pcGlowFilters.set(token.id, { shadow: disc });
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

    // Stop breathing animation
    if (token._acePcGlowAnim) {
      cancelAnimationFrame(token._acePcGlowAnim);
      delete token._acePcGlowAnim;
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
