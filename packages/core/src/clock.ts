/** Injectable clock so gates and reducers are deterministic in tests. */
export interface Clock {
  now(): number; // epoch ms
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  #t: number;
  constructor(start = 0) { this.#t = start; }
  now(): number { return this.#t; }
  advance(ms: number): void { this.#t += ms; }
  set(ms: number): void { this.#t = ms; }
}
