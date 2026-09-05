interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private nextSweepAt = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly maxBuckets = 1_000,
    private readonly sweepIntervalMs = Math.min(windowMs, 60_000),
  ) {}

  isRateLimited(key: string, now = Date.now()): boolean {
    if (now >= this.nextSweepAt) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(bucketKey);
      }
      this.nextSweepAt = now + this.sweepIntervalMs;
    }

    const current = this.buckets.get(key);
    if (current && current.resetAt > now) {
      if (current.count >= this.maxRequests) return true;
      current.count += 1;
      return false;
    }

    if (current) this.buckets.delete(key);
    if (this.buckets.size >= this.maxBuckets) return true;

    this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    return false;
  }

  get bucketCount(): number {
    return this.buckets.size;
  }
}
