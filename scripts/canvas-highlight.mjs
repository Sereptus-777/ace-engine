// ============================================================
// ACE — AI Campaign Engine — Canvas Highlight System
// Applies a glow/outline to canvas objects when hovered
// in the Select Scene Elements panel
// ============================================================

export class CanvasHighlight {

  static #activeHighlights = new Map();

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

    const { obj } = entry;
    if (obj._aceOrigFilters) {
      const target = obj.mesh ?? obj;
      target.filters = obj._aceOrigFilters;
      delete obj._aceOrigFilters;
    }
    if (obj._aceAnim) {
      cancelAnimationFrame(obj._aceAnim);
      delete obj._aceAnim;
      const target = obj.mesh ?? obj;
      target.alpha = 1;
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
}
