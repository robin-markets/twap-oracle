import type { Request, Response, NextFunction } from 'express';

// ---- IP helpers ----

export function getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress ?? 'unknown';
}

// ---- In-memory rate limiter ----

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 30; // requests per window

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const ip = getClientIp(req);
    const now = Date.now();

    let entry = store.get(ip);
    if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + WINDOW_MS };
        store.set(ip, entry);
    }

    entry.count++;

    res.setHeader('X-RateLimit-Limit', MAX_REQUESTS);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, MAX_REQUESTS - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    if (entry.count > MAX_REQUESTS) {
        res.status(429).json({ error: 'Too many requests, please try again later' });
        return;
    }

    next();
}
