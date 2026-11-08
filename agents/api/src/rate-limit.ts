import type { Context, MiddlewareHandler } from "hono";

export type RateLimitOptions = { windowMs: number; max: number };

/**
 * True when the request presents the configured API token in
 * `Authorization: Bearer <token>`; such requests skip rate limiting.
 */
export const isAuthorized = (c: Context): boolean => {
  const token = process.env.API_TOKEN;
  if (!token) return false;
  const auth = c.req.header("authorization");
  return auth === `Bearer ${token}`;
};

/**
 * Fixed-window rate limiter, one counter per client key (IP from
 * `x-forwarded-for`, the only accessor we can rely on behind a proxy).
 * Bearer-token clients bypass limiting entirely.
 */
export const rateLimiter =
  (opts: RateLimitOptions): MiddlewareHandler =>
  async (c, next) => {
    if (isAuthorized(c)) {
      await next();
      return;
    }

    const key =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "ip-unknown";
    const now = Date.now();

    // Lazy cleanup to keep the map bounded under churn.
    if (counters.size > 10_000) {
      for (const [k, v] of counters) if (v.resetAt <= now) counters.delete(k);
    }

    let entry = counters.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      counters.set(key, entry);
    }

    const remaining = Math.max(opts.max - entry.count, 0);
    c.header("X-RateLimit-Limit", String(opts.max));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(entry.resetAt));

    if (entry.count >= opts.max) {
      const retryAfterMs = entry.resetAt - now;
      c.header("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      return c.json(
        { error: "rate limit exceeded", retryAfterMs },
        429,
      );
    }

    entry.count += 1;
    await next();
  };

const counters = new Map<string, { count: number; resetAt: number }>();
