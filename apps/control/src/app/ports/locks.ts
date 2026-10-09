/**
 * Mutual exclusion that holds across every control-plane process: api and worker may run on
 * separate machines and still take turns.
 */
export interface Locks {
  /** Runs `work` while holding `key`. Waits at most `waitMs` for it, then throws `LockBusy`. */
  hold<T>(key: string, waitMs: number, work: () => Promise<T>): Promise<T>
}

export class LockBusy extends Error {
  constructor(key: string) {
    super(`${key} stayed busy`)
    this.name = 'LockBusy'
  }
}
