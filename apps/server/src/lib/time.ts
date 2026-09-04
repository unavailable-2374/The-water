export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** 测试用可推进时钟。 */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | number = Date.UTC(2026, 8, 1, 8, 0, 0)) {
    this.t = typeof start === 'number' ? start : start.getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(d: Date | number): void {
    this.t = typeof d === 'number' ? d : d.getTime();
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function iso(d: Date): string {
  return d.toISOString();
}
export function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}
/** UTC 日期键 YYYY-MM-DD。 */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
