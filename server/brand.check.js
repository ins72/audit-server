'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const zlib = require('zlib');
const { createBrand, renderIndex, renderManifest, readPng } = require('./brand');
const { rebrandText, rebrandResources } = require('../src/common/rebrand');

// Smallest valid PNG header with the given size (enough for validation; not for decoding).
const png = (width, height) => {
    const buffer = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
};

test('rebrandText renames the bare word only and keeps addresses, files and compounds', () => {
    assert.equal(rebrandText('Welcome to Stremio!', 'Acme TV'), 'Welcome to Acme TV!');
    assert.equal(rebrandText("Stremio's library", 'Acme TV'), "Acme TV's library");
    assert.equal(rebrandText('STREMIO PREMIUM', 'Acme TV'), 'ACME TV PREMIUM');
    assert.equal(rebrandText('Visit https://www.stremio.com/help or www.Stremio.com', 'Acme'), 'Visit https://www.stremio.com/help or www.Stremio.com');
    assert.equal(rebrandText('Write to help@stremio.com', 'Acme'), 'Write to help@stremio.com');
    assert.equal(rebrandText('stremio-core and Stremio-web', 'Acme'), 'stremio-core and Stremio-web');
    assert.equal(rebrandText('Open stremio:///detail', 'Acme'), 'Open stremio:///detail');
    assert.equal(rebrandText('Stremio', ''), 'Stremio', 'no name set: nothing changes');
    assert.equal(rebrandText(42, 'Acme'), 42);
    const resources = { 'en-US': { translation: { A: 'About Stremio', B: 'No brand' } } };
    assert.deepEqual(rebrandResources(resources, 'Acme'), { 'en-US': { translation: { A: 'About Acme', B: 'No brand' } } });
    assert.equal(rebrandResources(resources, ''), resources);
    const withOwn = rebrandResources({ 'de-DE': { translation: { SLOGAN: 'Freiheit', X: 'Stremio' } } }, '', { SLOGAN: 'Mein Spruch', EMPTY: '', NOPE: 5 });
    assert.deepEqual(withOwn, { 'de-DE': { translation: { SLOGAN: 'Mein Spruch', X: 'Stremio' } } }, 'own wording wins; empty and non-text overrides are ignored');
});

test('renderIndex sets the title and hands the config to the page; nothing changes without a name', () => {
    const html = '<html><head><meta name="apple-mobile-web-app-title" content="Stremio"><title>Stremio - Freedom to Stream</title></head><body></body></html>';
    const branded = renderIndex(html, { productName: 'Acme <TV>', tagline: 'All in "one" place' });
    assert.match(branded, /<title>Acme &lt;TV&gt; - All in &quot;one&quot; place<\/title>/);
    assert.match(branded, /content="Acme &lt;TV&gt;"/);
    assert.match(branded, /window\.__BRAND__=\{"productName":"Acme \\u003cTV>"/, 'the config cannot close the script tag');
    const plain = renderIndex(html, {});
    assert.match(plain, /<title>Stremio - Freedom to Stream<\/title>/);
    assert.match(plain, /window\.__BRAND__=\{\}/);
});

test('renderManifest renames the installed app', () => {
    const manifest = { name: 'Stremio Web', short_name: 'Stremio', description: 'Freedom To Stream', shortcuts: [{ name: 'Search' }], screenshots: [{ label: 'Homescreen of Stremio' }] };
    const out = renderManifest(manifest, { productName: 'Acme Television Network', tagline: 'Watch more' });
    assert.equal(out.name, 'Acme Television Network');
    assert.equal(out.short_name, 'Acme Televis');
    assert.equal(out.description, 'Watch more');
    assert.equal(out.screenshots[0].label, 'Homescreen of Acme Television Network');
    assert.deepEqual(renderManifest(manifest, {}), manifest);
});

test('readPng accepts PNG headers only', () => {
    assert.deepEqual(readPng(png(512, 256)), { width: 512, height: 256 });
    assert.equal(readPng(Buffer.from('GIF89a......................................')), null);
    assert.equal(readPng(Buffer.alloc(10)), null);
    assert.equal(readPng('x'), null);
});

const startApp = async (t, dir, entries = []) => {
    const brand = createBrand({ dir, audit: { record: (action, details) => entries.push({ action, ...details }) } });
    const app = express();
    app.use('/admin/brand', brand.adminRouter((req, res, next) => (req.get('authorization') === 'Bearer tok' ? next() : res.status(404).json({ error: 'not_found' }))));
    app.use(brand.middleware);
    app.get('/images/logo.png', (_req, res) => res.send('stock-logo'));
    app.get('/images/icon.png', (_req, res) => res.send('stock-icon'));
    app.get('/images/other.png', (_req, res) => res.send('other'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return { base: `http://127.0.0.1:${server.address().port}`, brand };
};

test('upload, serve in place of the stock image, and reset', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const entries = [];
    const { base } = await startApp(t, dir, entries);
    const put = (slot, body, auth = 'tok', type = 'image/png') => fetch(`${base}/admin/brand/${slot}`, { method: 'PUT', headers: { authorization: `Bearer ${auth}`, 'content-type': type }, body });

    assert.equal(await (await fetch(`${base}/images/logo.png`)).text(), 'stock-logo');
    assert.equal((await put('logo', png(670, 195), 'wrong')).status, 404, 'operator token required');
    assert.equal((await put('nope', png(670, 195))).status, 404);
    assert.equal((await put('logo', Buffer.from('not a png at all, just text bytes here....'))).status, 400);
    assert.equal((await put('logo', png(670, 195), 'tok', 'text/plain')).status, 400);
    assert.equal((await put('icon', png(512, 300))).status, 400, 'icons must be square');
    assert.equal((await put('icon', png(100, 100))).status, 400, 'too small');
    assert.equal((await put('logo', Buffer.concat([png(670, 195), Buffer.alloc(1024 * 1024)]))).status, 413);

    assert.equal((await put('logo', png(670, 195))).status, 200);
    const served = await fetch(`${base}/images/logo.png`);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('cache-control'), 'no-cache');
    assert.deepEqual(readPng(Buffer.from(await served.arrayBuffer())), { width: 670, height: 195 });
    assert.equal(await (await fetch(`${base}/images/other.png`)).text(), 'other', 'other images are untouched');
    assert.equal(await (await fetch(`${base}/images/icon.png`)).text(), 'stock-icon', 'an empty slot serves the stock file');

    const status = await (await fetch(`${base}/admin/brand`, { headers: { authorization: 'Bearer tok' } })).json();
    assert.equal(status.slots.logo.custom, true);
    assert.equal(status.slots.logo.width, 670);
    assert.equal(status.slots.icon.custom, false);

    assert.equal((await fetch(`${base}/admin/brand/logo`, { method: 'DELETE', headers: { authorization: 'Bearer tok' } })).status, 200);
    assert.equal((await fetch(`${base}/admin/brand/logo`, { method: 'DELETE', headers: { authorization: 'Bearer tok' } })).status, 404);
    assert.equal(await (await fetch(`${base}/images/logo.png`)).text(), 'stock-logo');
    assert.deepEqual(entries.map((entry) => `${entry.slot}:${entry.change}`), ['logo:set', 'logo:reset']);
});
