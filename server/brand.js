'use strict';

// Operator branding that is not plain text: logo, symbol and app icon (uploaded PNGs), the web app manifest and the page
// title. The built client is never rewritten: the server answers the usual image addresses with the operator's file when
// one is uploaded, and rewrites index.html and manifest.json on the way out. Nothing uploaded means stock files.

const fs = require('fs');
const path = require('path');
const express = require('express');

const MAX_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// slot -> what it replaces. square: width must equal height. Addresses are those the built client already asks for.
const SLOTS = {
    logo: { label: 'Logo (wide)', hint: 'Shown on the login screen. Any shape, PNG, at most 1 MB, up to 2000 px wide.', square: false, min: 16, max: 2000,
        urls: ['/images/logo.png'] },
    symbol: { label: 'Symbol (square)', hint: 'Small mark in the top bar and loading screens. Square PNG, 64 to 1024 px.', square: true, min: 64, max: 1024,
        urls: ['/images/stremio_symbol.png'] },
    icon: { label: 'App icon (square)', hint: 'Home-screen icon and browser tab icon. Square PNG, 192 to 1024 px, ideally 512.', square: true, min: 192, max: 1024,
        urls: ['/images/icon.png', '/images/icon_196x196.png', '/images/icon_512x512.png', '/images/maskable_icon.png', '/images/maskable_icon_196x196.png',
            '/images/maskable_icon_512x512.png', '/images/monochrome_icon_512x512.png', '/favicons/favicon.ico'] }
};

const URL_TO_SLOT = new Map(Object.entries(SLOTS).flatMap(([slot, def]) => def.urls.map((url) => [url, slot])));

// Returns { width, height } for a PNG buffer, or null when it is not one.
const readPng = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// config: the public settings ({ productName, tagline, ... }). Adds the config for the client and, when a name is set,
// the page title. The client reads window.__BRAND__ before first paint, so there is no flash of the old name.
const renderIndex = (html, config = {}) => {
    const name = config.productName || '';
    let out = html;
    if (name) {
        const title = config.tagline ? `${name} - ${config.tagline}` : name;
        out = out.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
            .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${escapeHtml(name)}$2`);
    }
    const script = `<script>window.__BRAND__=${JSON.stringify(config).replace(/</g, '\\u003c')};</script>`;
    return out.replace('</head>', `${script}</head>`);
};

const renderManifest = (manifest, config = {}) => {
    const name = config.productName || '';
    if (!name) return manifest;
    const swap = (value) => (typeof value === 'string' ? value.replace(/Stremio/g, name) : value);
    return {
        ...manifest,
        name,
        short_name: name.length > 12 ? name.slice(0, 12).trim() : name,
        description: config.tagline || manifest.description,
        shortcuts: Array.isArray(manifest.shortcuts) ? manifest.shortcuts.map((shortcut) => ({ ...shortcut, name: swap(shortcut.name) })) : manifest.shortcuts,
        screenshots: Array.isArray(manifest.screenshots) ? manifest.screenshots.map((shot) => ({ ...shot, label: swap(shot.label) })) : manifest.screenshots
    };
};

const createBrand = ({ dir, audit = { record() {} } } = {}) => {
    const fileOf = (slot) => (dir ? path.join(dir, `${slot}.png`) : null);

    const status = () => Object.fromEntries(Object.entries(SLOTS).map(([slot, def]) => {
        let info = { custom: false };
        try {
            const buffer = fs.readFileSync(fileOf(slot));
            info = { custom: true, bytes: buffer.length, ...readPng(buffer), updatedAt: fs.statSync(fileOf(slot)).mtimeMs };
        } catch (_e) { /* not uploaded */ }
        return [slot, { label: def.label, hint: def.hint, ...info }];
    }));

    // Returns { ok: true } or { ok: false, error, key }.
    const save = (slot, buffer) => {
        if (!(slot in SLOTS)) return { ok: false, error: 'not_found' };
        if (!dir) return { ok: false, error: 'storage_unavailable' };
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, error: 'invalid_image' };
        if (buffer.length > MAX_BYTES) return { ok: false, error: 'image_too_large' };
        const size = readPng(buffer);
        if (!size) return { ok: false, error: 'invalid_image' };
        const def = SLOTS[slot];
        if (size.width < def.min || size.width > def.max || size.height < 1 || size.height > def.max || (def.square && size.width !== size.height)) {
            return { ok: false, error: 'invalid_dimensions' };
        }
        try {
            fs.mkdirSync(dir, { recursive: true });
            const tmp = `${fileOf(slot)}.tmp`;
            fs.writeFileSync(tmp, buffer, { mode: 0o600 });
            fs.renameSync(tmp, fileOf(slot));
        } catch (e) {
            console.error('Saving the brand image failed:', e.message);
            return { ok: false, error: 'storage_unavailable' };
        }
        audit.record('brand-image', { slot, change: 'set', bytes: buffer.length });
        return { ok: true };
    };

    const reset = (slot) => {
        if (!(slot in SLOTS)) return { ok: false, error: 'not_found' };
        try {
            fs.unlinkSync(fileOf(slot));
        } catch (e) {
            if (e.code === 'ENOENT') return { ok: false, error: 'not_found' };
            return { ok: false, error: 'storage_unavailable' };
        }
        audit.record('brand-image', { slot, change: 'reset' });
        return { ok: true };
    };

    // Express middleware, placed before the static files: answers the stock image addresses with the operator's upload.
    const middleware = (req, res, next) => {
        if ((req.method !== 'GET' && req.method !== 'HEAD') || !dir) return next();
        const slot = URL_TO_SLOT.get(req.path);
        if (!slot) return next();
        const file = fileOf(slot);
        if (!fs.existsSync(file)) return next();
        res.set('cache-control', 'no-cache');
        res.type('image/png');
        return res.sendFile(file, { dotfiles: 'allow' }, (error) => { if (error && !res.headersSent) next(); });
    };

    const adminRouter = (guard) => {
        const router = express.Router();
        router.use(guard);
        router.get('/', (_req, res) => {
            res.set('cache-control', 'no-store');
            res.json({ slots: status() });
        });
        router.put('/:slot', express.raw({ type: 'image/png', limit: MAX_BYTES + 1 }), (req, res) => {
            const result = save(req.params.slot, req.body);
            if (result.ok) res.json({ slots: status() });
            else res.status(result.error === 'not_found' ? 404 : result.error === 'storage_unavailable' ? 500 : result.error === 'image_too_large' ? 413 : 400).json({ error: result.error });
        });
        router.delete('/:slot', (req, res) => {
            const result = reset(req.params.slot);
            if (result.ok) res.json({ slots: status() });
            else res.status(result.error === 'storage_unavailable' ? 500 : 404).json({ error: result.error });
        });
        return router;
    };

    return { status, save, reset, middleware, adminRouter };
};

module.exports = { createBrand, renderIndex, renderManifest, readPng, SLOTS };
