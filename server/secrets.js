'use strict';

// Operator-entered secrets (Stripe secret key + webhook signing secret), kept apart from the public settings.
//
// These are the only secrets the dashboard writes. They are stored in their own file, are NEVER included in the
// public config, and the dashboard only ever sees a masked hint (the last few characters) — the full value goes in
// once and cannot be read back out. Environment variables of the same name remain the bootstrap default; a value
// saved here overrides them and applies at once (the server rebuilds its Stripe client / billing on save).

const express = require('express');
const { createJsonFile } = require('./jsonFile');

const STRIPE_KEY = /^sk_(test|live)_[A-Za-z0-9_]{5,200}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9_]{5,200}$/;

const createSecrets = ({ dataFile = null, audit = { record() {} }, onChange = null } = {}) => {
    const file = createJsonFile(dataFile, () => ({ values: {} }));
    const value = (key) => (typeof file.data.values[key] === 'string' ? file.data.values[key] : '');
    const hint = (secret) => (secret ? `…${secret.slice(-4)}` : '');

    // A masked view: whether each secret is set and a short hint, never the secret itself.
    const view = () => ({
        stripe: { configured: Boolean(value('stripeSecretKey')), hint: hint(value('stripeSecretKey')) },
        webhook: { configured: Boolean(value('stripeWebhookSecret')), hint: hint(value('stripeWebhookSecret')) }
    });

    // patch: { stripeSecretKey?, stripeWebhookSecret? }; '' removes a secret (falls back to the env default).
    const update = (patch, who = 'operator') => {
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'invalid_body' };
        const cleaned = {};
        for (const [key, raw] of Object.entries(patch)) {
            if (key !== 'stripeSecretKey' && key !== 'stripeWebhookSecret') return { ok: false, error: 'unknown_key', key };
            if (raw === '' || raw === null) { cleaned[key] = null; continue; }
            if (typeof raw !== 'string') return { ok: false, error: 'invalid_value', key };
            const trimmed = raw.trim();
            const valid = key === 'stripeSecretKey' ? STRIPE_KEY.test(trimmed) : WEBHOOK_SECRET.test(trimmed);
            if (!valid) return { ok: false, error: 'invalid_value', key };
            cleaned[key] = trimmed;
        }
        const previous = { ...file.data.values };
        for (const [key, secret] of Object.entries(cleaned)) {
            if (secret === null) delete file.data.values[key]; else file.data.values[key] = secret;
        }
        if (!file.flush()) { file.data.values = previous; return { ok: false, error: 'storage_unavailable' }; }
        audit.record('payment-keys', { by: who, changed: Object.fromEntries(Object.keys(cleaned).map((key) => [key, cleaned[key] === null ? 'cleared' : 'set'])) });
        // Let the server rebuild its Stripe client / billing with the new keys (or fall back to the env default).
        if (typeof onChange === 'function') {
            try { onChange(view()); } catch (e) { console.error('Rebuilding payments after a key change failed:', e.message); }
        }
        return { ok: true };
    };

    const adminRouter = (guard) => {
        const router = express.Router();
        router.use(guard);
        router.use(express.json({ limit: '4kb' }));
        router.use((_req, res, next) => { res.set('cache-control', 'no-store'); next(); });
        router.get('/', (_req, res) => res.json(view()));
        router.put('/', (req, res) => {
            const result = update(req.body);
            if (!result.ok) {
                res.status(result.error === 'storage_unavailable' ? 500 : 400).json({ error: result.error, key: result.key });
                return;
            }
            res.json(view());
        });
        return router;
    };

    return {
        get: () => ({ stripeSecretKey: value('stripeSecretKey'), stripeWebhookSecret: value('stripeWebhookSecret') }),
        // Whether each secret is configured (used by the health panel and the dashboard)
        stripeConfigured: () => Boolean(value('stripeSecretKey')),
        webhookConfigured: () => Boolean(value('stripeWebhookSecret')),
        view,
        update,
        adminRouter,
        flush: file.flush,
        isHealthy: file.isHealthy
    };
};

module.exports = { createSecrets };