// Runtime settings the operator edits from the dashboard (decision D31, task P1-11).
//
// Environment variables stay the bootstrap defaults and the home of secrets; a value saved here overrides the
// default and applies immediately, without a restart. Every key is validated, unknown keys are refused, and an
// empty value resets a key to its default. Everything here is safe to show to any visitor (GET /config/public),
// so never add a secret to SCHEMA.

const express = require('express');
const { createJsonFile } = require('./jsonFile');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const text = (max) => (value) => (typeof value === 'string' && value.trim().length <= max ? value.trim() : null);
const email = (value) => (typeof value === 'string' && (value.trim() === '' || (EMAIL.test(value.trim()) && value.trim().length <= 200)) ? value.trim() : null);
const httpsUrl = (value) => {
    if (typeof value !== 'string' || value.trim().length > 500) return null;
    try {
        return new URL(value.trim()).protocol === 'https:' ? value.trim() : null;
    } catch (_e) {
        return null;
    }
};

const oneOf = (...options) => (value) => (typeof value === 'string' && options.includes(value.trim()) ? value.trim() : null);
// One https:// address per line, at most 10: the add-ons a new account starts with (own accounts only)
const urlLines = (value) => {
    if (typeof value !== 'string' || value.length > 2000) return null;
    const lines = value.split(/[\r\n,]+/).map((line) => line.trim()).filter(Boolean);
    return lines.length <= 10 && lines.every((line) => httpsUrl(line) !== null) ? lines.join('\n') : null;
};
// Settings only the server reads: never sent to browsers
const PRIVATE_KEYS = ['registration', 'defaultAddons', 'announcementTitle', 'announcementBody', 'announcementButton', 'announcementLink', 'announcementEnds'];

const isoDate = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) && Number.isFinite(Date.parse(value.trim())) ? value.trim() : null);

// key -> { validate(value) -> cleaned value or null when invalid, label, hint }
const SCHEMA = {
    productName: { validate: text(60), label: 'Product name', hint: 'Browser tab title, paywall heading and email signature' },
    tagline: { validate: text(120), label: 'Tagline', hint: 'Short line under the paywall heading' },
    loginHeadline: { validate: text(80), label: 'Login headline', hint: 'Large line on the login screen (standard: Freedom to Stream)' },
    loginSubtitle: { validate: text(160), label: 'Login subtitle', hint: 'Line under it (standard: All the video content you enjoy in one place)' },
    supportEmail: { validate: email, label: 'Support email', hint: 'Shown to blocked users' },
    termsUrl: { validate: httpsUrl, label: 'Terms link', hint: 'https:// address of your terms, linked on the paywall' },
    registration: { validate: oneOf('open', 'closed'), label: 'New sign-ups', hint: 'open or closed. Closed stops new accounts on our own account service; existing people can still sign in' },
    defaultAddons: { validate: urlLines, label: 'Starting add-ons', hint: 'One manifest.json address per line or comma-separated (https), installed for every new account. Empty: the standard Cinemeta catalog' },
    announcementTitle: { validate: text(80), label: 'Announcement title', hint: 'A message shown once to everyone in the app (own account service). Empty: no announcement. Changing any of the announcement fields shows it again to people who closed the old one' },
    announcementBody: { validate: text(400), label: 'Announcement text', hint: 'Optional longer text under the title' },
    announcementButton: { validate: text(24), label: 'Announcement button', hint: 'Button label. Empty: "Got it"' },
    announcementLink: { validate: httpsUrl, label: 'Announcement link', hint: 'Optional https:// address the button opens' },
    announcementEnds: { validate: isoDate, label: 'Announcement last day', hint: 'YYYY-MM-DD. Empty: stays for 30 days from each visit' },
    sourceUrl: { validate: httpsUrl, label: 'Source code link', hint: 'https:// address of the source code of this build, shown on the Help page (the licence requires offering it). Empty: the upstream project' },
    serverDownloadUrl: { validate: httpsUrl, label: 'Streaming server download link', hint: 'https:// address where people get the streaming server app. Empty: the "Install" button is hidden on our own account service' },
    privacyUrl: { validate: httpsUrl, label: 'Privacy link', hint: 'https:// address of your privacy policy, linked on the paywall' }
};

const createSettings = ({ dataFile = null, defaults = {}, audit = { record() {} } } = {}) => {
    const file = createJsonFile(dataFile, () => ({ values: {} }));
    const base = Object.fromEntries(Object.keys(SCHEMA).map((key) => [key, typeof defaults[key] === 'string' ? defaults[key] : '']));

    const effective = () => {
        const merged = { ...base };
        for (const [key, value] of Object.entries(file.data.values)) {
            if (key in SCHEMA && typeof value === 'string') merged[key] = value;
        }
        return merged;
    };

    // patch: { key: value }; '' or null resets the key. Returns { ok: true, settings } or { ok: false, error, key }.
    const update = (patch, who = 'operator') => {
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'invalid_body' };
        const cleaned = {};
        for (const [key, value] of Object.entries(patch)) {
            if (!(key in SCHEMA)) return { ok: false, error: 'unknown_setting', key };
            if (value === null || value === '') {
                cleaned[key] = null;
                continue;
            }
            const valid = SCHEMA[key].validate(value);
            if (valid === null) return { ok: false, error: 'invalid_value', key };
            cleaned[key] = valid;
        }
        const previous = { ...file.data.values };
        for (const [key, value] of Object.entries(cleaned)) {
            if (value === null) delete file.data.values[key]; else file.data.values[key] = value;
        }
        if (!file.flush()) {
            file.data.values = previous;
            return { ok: false, error: 'storage_unavailable' };
        }
        audit.record('settings', { by: who, changed: cleaned });
        return { ok: true, settings: effective() };
    };

    // Read live by other modules, e.g. supportEmail: () => settings.get().supportEmail
    const get = () => effective();
    const publicConfig = () => {
        const { ...values } = effective();
        return Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== '' && !PRIVATE_KEYS.includes(key)));
    };

    const publicRouter = express.Router();
    publicRouter.get('/public', (_req, res) => {
        res.set('cache-control', 'no-cache');
        res.json(publicConfig());
    });

    const adminRouter = (guard) => {
        const router = express.Router();
        router.use(guard);
        router.use(express.json({ limit: '8kb' }));
        router.get('/', (_req, res) => {
            res.set('cache-control', 'no-store');
            const values = effective();
            res.json({
                settings: values,
                defaults: base,
                overridden: Object.keys(file.data.values).filter((key) => key in SCHEMA),
                fields: Object.fromEntries(Object.entries(SCHEMA).map(([key, { label, hint }]) => [key, { label, hint }]))
            });
        });
        router.put('/', (req, res) => {
            const result = update(req.body);
            if (!result.ok) {
                res.status(result.error === 'storage_unavailable' ? 500 : 400).json({ error: result.error, key: result.key });
                return;
            }
            res.json({ settings: result.settings });
        });
        return router;
    };

    return { get, update, publicConfig, publicRouter, adminRouter, flush: file.flush, isHealthy: file.isHealthy, SCHEMA };
};

module.exports = { createSettings };
