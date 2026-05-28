import type { Request, Response, NextFunction } from 'express';

// ---- IP helpers ----

// Returns the client IP as resolved by Express. When `app.set('trust proxy', …)`
// is configured, `req.ip` honors X-Forwarded-For from trusted hops only and is
// not spoofable by direct callers. If trust proxy is off, `req.ip` falls back
// to the socket peer address.
export function getClientIp(req: Request): string {
    return req.ip ?? req.socket.remoteAddress ?? 'unknown';
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
    // TODO: remove once the ROFL proxy setup is verified.
    console.log(
        `[ip] ${req.method} ${req.originalUrl} ip=${ip} socket=${req.socket.remoteAddress} xff=${req.headers['x-forwarded-for'] ?? '-'}`,
    );
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
