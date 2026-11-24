// Runtime add-on configuration the operator edits from the dashboard.
// Built-in add-ons (moviebox2, houseofmaster) can be toggled on/off, and hidden add-ons
// (stremio manifests the operator adds) stay active for streaming but never appear in the
// viewer's source list. Environment values are the bootstrap defaults; the dashboard
// overrides them live, no restart needed.
'use strict';

const express = require('express');
const { createJsonFile } = require('./jsonFile');

// One https:// manifest address per line, at most 20: hidden add-ons the operator installs.
const urlLines = (value) => {
    if (typeof value !== 'string' || value.length > 4000) return null;
    const lines = value.split(/[\r\n,]+/).map((line) => line.trim()).filter(Boolean);
    return lines.length <= 20 && lines.every((line) => /^https?:\/\//i.test(line)) ? lines.join('\n') : null;
};

const SCHEMA = {
    // Built-in add-on toggles: yes/no the operator can flip for each one.
    enableMoviebox2: { validate: (v) => (v === true || v === false || v === 'true' || v === 'false') ? String(v === true || v === 'true') : null, label: 'Moviebox2 add-on', hint: 'yes → use moviebox2.mewayz.com as a built-in source; no → skip it' },
    enableHouseofmaster: { validate: (v) => (v === true || v === false || v === 'true' || v === 'false') ? String(v === true || v === 'true') : null, label: 'House of Master add-on', hint: 'yes → use stremio.thehouseofthemaster.pt as a built-in source; no → skip it' },
    // Hidden add-on manifest URLs: stremio manifests that provide streams but never show in the viewer's source list.
    hiddenAddonUrls: { validate: urlLines, label: 'Hidden add-ons', hint: 'One manifest.json address per line or comma-separated (https). These serve streams but stay hidden from viewers.' }
};

const PRIVATE_KEYS = ['enableMoviebox2', 'enableHouseofmaster', 'hiddenAddonUrls'];

const createAddons = ({ dataFile = null, defaults = {}, audit = { record() {} } } = {}) => {
    const file = createJsonFile(dataFile, () => ({ values: {} }));
    const base = Object.fromEntries(Object.keys(SCHEMA).map((key) => [key, typeof defaults[key] === 'string' ? defaults[key] : '']));

    const effective = () => {
        const merged = { ...base };
        for (const [key, value] of Object.entries(file.data.values)) {
            if (key in SCHEMA && typeof value === 'string') merged[key] = value;
        }
        return merged;
    };

    // Returns the parsed hidden add-on manifests: each entry is { id, transportUrl, manifest }.
    const hiddenAddons = () => {
        const urls = String(effective().hiddenAddonUrls || '').split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
        return urls.map((url) => {
            // Each hidden add-on gets a stable id from its host; the manifest is fetched on demand by the client.
            const host = new URL(url).hostname.replace(/^www\./, '');
            return { id: `hidden:${host}`, transportUrl: url, manifest: null };
        });
    };

    // Is a built-in add-on enabled? Defaults to true when never configured.
    const isEnabled = (addonId) => {
        const key = `enable${addonId.charAt(0).toUpperCase() + addonId.slice(1)}`;
        const value = effective()[key];
        return value === '' || value === null || value === undefined ? true : value === 'true';
    };

    // patch: { key: value }; '' or null resets the key. Returns { ok: true, addons } or { ok: false, error, key }.
    const update = (patch, who = 'operator') => {
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'invalid_body' };
        const cleaned = {};
        for (const [key, value] of Object.entries(patch)) {
            if (!(key in SCHEMA)) return { ok: false, error: 'unknown_addon', key };
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
        audit.record('addons', { by: who, changed: cleaned });
        return { ok: true, addons: effective() };
    };

    const get = () => effective();

    const publicConfig = () => {
        // Only expose what the client needs: which built-ins are on, and the hidden add-on ids/urls (no manifests).
        const values = effective();
        return {
            enableMoviebox2: isEnabled('moviebox2'),
            enableHouseofmaster: isEnabled('houseofmaster'),
            hiddenAddons: hiddenAddons().map(({ id, transportUrl }) => ({ id, transportUrl }))
        };
    };

    const adminRouter = (guard) => {
        const router = express.Router();
        router.use(guard);
        router.use(express.json({ limit: '8kb' }));
        router.get('/', (_req, res) => {
            res.set('cache-control', 'no-store');
            const values = effective();
            res.json({
                addons: {
                    enableMoviebox2: isEnabled('moviebox2'),
                    enableHouseofmaster: isEnabled('houseofmaster'),
                    hiddenAddonUrls: values.hiddenAddonUrls || ''
                },
                defaults: base,
                overridden: Object.keys(file.data.values).filter((key) => key in SCHEMA),
                fields: Object.fromEntries(Object.entries(SCHEMA).map(([key, { label, hint }]) => [key, { label, hint }])),
                hidden: hiddenAddons()
            });
        });
        router.put('/', (req, res) => {
            const result = update(req.body);
            if (!result.ok) {
                res.status(result.error === 'storage_unavailable' ? 500 : 400).json({ error: result.error, key: result.key });
                return;
            }
            res.json({ addons: result.addons, hidden: hiddenAddons() });
        });
        return router;
    };

    return { get, update, publicConfig, publicRouter: null, adminRouter, flush: file.flush, isHealthy: file.isHealthy, SCHEMA, hiddenAddons };
};

module.exports = { createAddons, SCHEMA };
