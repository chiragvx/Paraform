/**
 * Tab-cycle helper for stacked picks.
 *
 * When the user hovers a stack of overlapping entities the raycaster returns
 * them sorted by distance. Pressing Tab (without modifiers) walks deeper
 * into the stack. Any mouse movement (mousemove) or Esc resets the cycle.
 *
 * Usage:
 *   const cycle = createPickCycle();
 *   onMouseMove((evt) => {
 *       const hits = rankHits(raycaster.intersectObjects(...), { preferredKind });
 *       cycle.setHits(hits);              // resets index to 0
 *       const current = cycle.current();
 *       overlay.setHover(current?.ref);
 *   });
 *   onKeyDown((evt) => {
 *       if (evt.key === 'Tab' && !evt.ctrlKey && !evt.shiftKey && !evt.altKey && !evt.metaKey) {
 *           if (cycle.length() > 1) {
 *               evt.preventDefault();
 *               cycle.next();
 *               overlay.setHover(cycle.current()?.ref);
 *           }
 *       } else if (evt.key === 'Escape') {
 *           cycle.reset();
 *           overlay.clearHover();
 *       }
 *   });
 *   onClick(() => {
 *       const pick = cycle.current();
 *       if (pick) selection.toggle(pick.ref);
 *   });
 */

export function createPickCycle() {
    let hits = [];
    let index = 0;

    return {
        /** Replace the stack of hits and reset the index to the topmost. */
        setHits(newHits) {
            hits = Array.isArray(newHits) ? newHits.slice() : [];
            index = 0;
        },

        /** Number of hits in the current stack. */
        length() { return hits.length; },

        /** Currently selected hit (or null). */
        current() {
            return hits.length > 0 ? hits[index] : null;
        },

        /** Advance to the next hit in the stack (wraps). */
        next() {
            if (hits.length === 0) return null;
            index = (index + 1) % hits.length;
            return hits[index];
        },

        /** Previous hit in the stack (Shift+Tab support, wraps). */
        prev() {
            if (hits.length === 0) return null;
            index = (index - 1 + hits.length) % hits.length;
            return hits[index];
        },

        /** Reset to topmost hit (without clearing the stack). */
        resetIndex() { index = 0; },

        /** Clear the stack entirely. */
        reset() {
            hits = [];
            index = 0;
        },

        /** Current index, for debugging / UI. */
        indexOf() { return index; },
    };
}
