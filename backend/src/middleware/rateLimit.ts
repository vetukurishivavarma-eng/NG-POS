import type { NextFunction, Request, Response } from 'express';

import { tooManyRequests } from '../lib/errors.js';

interface Bucket {
  count: number;
  resetAt: number;
  /** Cleared on success, so a staff member who mistypes once isn't punished. */
}

/**
 * A small fixed-window limiter, in memory.
 *
 * In memory is the honest choice for a single container: a shared store would
 * be better across replicas, but pretending to have one while running Redis-less
 * would be worse than saying so. If this is ever scaled out, move the map to
 * Redis — the shape does not change.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  /** What counts as "the same caller". Defaults to the client IP. */
  key?: (req: Request) => string;
  message?: string;
}) {
  const buckets = new Map<string, Bucket>();

  // Unbounded growth would be a slow leak on a long-lived process.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, options.windowMs);
  sweep.unref();

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const key = options.key ? options.key(req) : (req.ip ?? 'unknown');
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return next(
        tooManyRequests(
          options.message ?? `Too many attempts. Try again in ${retryAfter} second(s).`
        )
      );
    }

    // A successful response clears the count, so ordinary use never trips it.
    res.on('finish', () => {
      if (res.statusCode < 400) buckets.delete(key);
    });

    next();
  };

  return middleware;
}
