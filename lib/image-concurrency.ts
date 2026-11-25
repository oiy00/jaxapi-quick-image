/** How many image requests one page may have waiting on the upstream at once. */
export const MAX_CONCURRENT_IMAGES = 5;

/**
 * Tracks image requests that are in flight on this page.
 *
 * Cost is worked out from the account balance before and after a request. When two
 * requests overlap, or anything else moves the balance meanwhile (a video job), the
 * difference mixes several charges, so the tracker remembers which requests saw
 * overlap and their per-request cost is left unknown instead of being misattributed.
 */
export class ImageRequestTracker {
  private readonly active = new Set<string>();
  private readonly overlapped = new Set<string>();
  private readonly limit: number;

  constructor(limit = MAX_CONCURRENT_IMAGES) {
    this.limit = limit;
  }

  get size(): number {
    return this.active.size;
  }

  ids(): string[] {
    return [...this.active];
  }

  canStart(): boolean {
    return this.active.size < this.limit;
  }

  /** Returns false when the page is already at the limit. */
  start(id: string): boolean {
    if (this.active.has(id)) return true;
    if (!this.canStart()) return false;
    if (this.active.size > 0) {
      this.overlapped.add(id);
      for (const other of this.active) this.overlapped.add(other);
    }
    this.active.add(id);
    return true;
  }

  /** Something outside these requests changed the balance; every active request loses its own cost. */
  markBalanceMoved(): void {
    for (const id of this.active) this.overlapped.add(id);
  }

  /** Ends a request and reports whether its balance difference can be trusted as its own cost. */
  finish(id: string): { overlapped: boolean } {
    const overlapped = this.overlapped.has(id);
    this.active.delete(id);
    this.overlapped.delete(id);
    return { overlapped };
  }
}

/**
 * Balance reads finish out of order when several requests end close together.
 * Each read takes a ticket when it starts; only a read newer than the last applied one may update the page.
 */
export class BalanceSequencer {
  private issued = 0;
  private applied = 0;

  ticket(): number {
    this.issued += 1;
    return this.issued;
  }

  accept(ticket: number): boolean {
    if (ticket <= this.applied) return false;
    this.applied = ticket;
    return true;
  }
}

export const OVERLAP_COST_NOTE = "和其他请求同时进行，无法单独算出这张的扣费，请在「使用记录」核对";
