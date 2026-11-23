// Small shared request guards: rate limiting, CSRF origin check, security headers, JSON errors.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Fixed-window limiter keyed by client IP.
// countOnlyFailures: only responses with status >= 400 use up the budget, so legitimate users who
// share an IP (office, CGNAT, or a reverse proxy without TRUST_PROXY) are not locked out by each other.
// isFailure(req, res) decides what counts as a failure (default: any response with status >= 400, except 429).
const defaultIsFailure = (_req, res) => res.statusCode >= 400 && res.statusCode !== 429;

const MAX_TRACKED_KEYS = 50000; // hard cap so a flood of spoofed IPs cannot grow memory without bound

const createRateLimiter = ({ max, windowMs = 60 * 1000, countOnlyFailures = false, isFailure = defaultIsFailure, keyFn = (req) => req.ip, now = Date.now }) => {
    const hits = new Map();

    const sweep = setInterval(() => {
        const current = now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= current) hits.delete(key);
        }
    }, windowMs);
    sweep.unref();

    return (req, res, next) => {
        const key = keyFn(req);
        const current = now();
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= current) {
            if (!entry && hits.size >= MAX_TRACKED_KEYS) hits.delete(hits.keys().next().value);
            entry = { count: 0, resetAt: current + windowMs };
            hits.set(key, entry);
        }
        if (entry.count >= max) {
            res.set('retry-after', String(Math.max(1, Math.ceil((entry.resetAt - current) / 1000))));
            res.status(429).json({ error: 'rate_limited' });
            return;
        }
        if (countOnlyFailures) {
            res.on('finish', () => {
                if (isFailure(req, res)) entry.count += 1;
            });
        } else {
            entry.count += 1;
        }
        next();
    };
};

// Defense in depth on top of SameSite=Lax: reject state-changing browser requests whose Origin is not ours.
// Disabled (no-op) unless the operator declared the canonical origin(s), because a reverse proxy that rewrites
// the Host header would otherwise make every POST look cross-site.
const originGuard = (allowedOrigins) => {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
        return (_req, _res, next) => next();
    }
    return (req, res, next) => {
        if (SAFE_METHODS.has(req.method)) {
            next();
            return;
        }
        const origin = req.headers.origin;
        if (!origin) {
            // Non-browser clients (and Stripe webhooks) send no Origin; they cannot ride a user's cookie.
            next();
            return;
        }
        let parsed;
        try {
            parsed = new URL(origin);
        } catch (_e) {
            res.status(403).json({ error: 'bad_origin' });
            return;
        }
        const sameHost = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).includes(parsed.host);
        if (allowedOrigins.includes(parsed.origin) || sameHost) {
            next();
            return;
        }
        res.status(403).json({ error: 'bad_origin' });
    };
};

const securityHeaders = ({ hsts = false } = {}) => (_req, res, next) => {
    res.set({
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
        'referrer-policy': 'strict-origin-when-cross-origin'
    });
    if (hsts) res.set('strict-transport-security', 'max-age=15552000');
    next();
};

// Never leak stack traces or HTML error pages from the API.
// eslint-disable-next-line no-unused-vars
const jsonErrorHandler = (err, _req, res, next) => {
    if (res.headersSent) {
        next(err);
        return;
    }
    const status = Number(err?.status ?? err?.statusCode);
    const code = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
    if (code >= 500) console.error('Request failed:', err);
    res.status(code).json({ error: code === 413 ? 'payload_too_large' : code < 500 ? 'bad_request' : 'internal_error' });
};

module.exports = { createRateLimiter, originGuard, securityHeaders, jsonErrorHandler };
