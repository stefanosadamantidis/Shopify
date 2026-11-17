/**
 * Fixed-window, in-memory rate limiter for the public pixel collector.
 * Per-instance only: put an edge/WAF limit in front of multi-instance
 * deployments (see IMPORTANT DOC/SETUP.md).
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Returns true when the request is allowed. */
  hit(key: string, now: number = Date.now()): boolean {
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.sweep(now);
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }

  private sweep(now: number) {
    for (const [key, value] of this.windows) {
      if (value.resetAt <= now) this.windows.delete(key);
    }
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }

  reset() {
    this.windows.clear();
  }
}
