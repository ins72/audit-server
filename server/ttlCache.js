// Remembers a computed value for a short time. Used for the operator statistics summary, which walks every user and
// took about 1.4 s (blocking the server) at 100,000 users when measured on 2026-11-20 (docs/PREMORTEM.md).
const createTtlCache = (ttlMs, now = Date.now) => {
    const entries = new Map();
    return {
        get(key, compute, { fresh = false } = {}) {
            const hit = entries.get(key);
            if (!fresh && hit && now() - hit.at < ttlMs) return hit.value;
            const value = compute();
            entries.set(key, { at: now(), value });
            if (entries.size > 50) entries.delete(entries.keys().next().value); // keys are few (days 1-120); cap anyway
            return value;
        },
        clear: () => entries.clear()
    };
};

module.exports = { createTtlCache };
