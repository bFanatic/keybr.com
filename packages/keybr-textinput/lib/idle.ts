/**
 * Site-wide behaviour when a student stops typing or leaves the window.
 *
 * By default nothing is reset: a student can pause, switch windows and
 * continue where they left off. Long pauses are excluded from the typing
 * time instead, so they do not ruin the speed statistics.
 */
export const idleSettings = {
  /** Restart the current lesson when the window or text area loses focus. */
  resetOnBlur: false,
  /** Restart the current lesson after this many ms without input, 0 = never. */
  resetTimeout: 0,
  /** A pause longer than this many ms only counts as this many ms. */
  maxPause: 3000,
} as const;

/**
 * Shifts event timestamps so that pauses longer than `maxPause`
 * are not counted in the typing time.
 */
export class PauseCompensator {
  readonly #maxPause: number;
  #offset = 0;
  #last: number | null = null;

  constructor(maxPause: number = idleSettings.maxPause) {
    this.#maxPause = maxPause;
  }

  adjust<T extends { readonly timeStamp: number }>(event: T): T {
    const { timeStamp } = event;
    if (this.#last != null) {
      const gap = timeStamp - this.#last;
      if (gap > this.#maxPause) {
        this.#offset += gap - this.#maxPause;
      }
    }
    this.#last = timeStamp;
    const adjusted = { ...event, timeStamp: timeStamp - this.#offset };
    if ("timeToType" in adjusted && typeof adjusted.timeToType === "number") {
      return {
        ...adjusted,
        timeToType: Math.min(adjusted.timeToType, this.#maxPause),
      };
    }
    return adjusted;
  }
}
