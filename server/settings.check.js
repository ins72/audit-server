// Run with: pnpm run test:server   (uses node:test)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createSettings } = require('./settings');

const setup = async (defaults = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
    const file = path.join(dir, 'settings.json');
    const entries = [];
    const settings = createSettings({ dataFile: file, defaults, audit: { record: (action, details) => entries.push({ action, details }) } });
    const guard = (req, res, next) => (req.headers.authorization === 'Bearer tok' ? next() : res.status(404).end());
    const app = express();
    app.use('/config', settings.publicRouter);
    app.use('/admin/settings', settings.adminRouter(guard));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { settings, file, entries, base, dir, close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};
const put = (s, body, token = 'tok') => fetch(`${s.base}/admin/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test('settings: defaults, overrides, reset and validation', async (t) => {
    const s = await setup({ supportEmail: 'env@example.com' });
    t.after(s.close);

    assert.equal(s.settings.get().supportEmail, 'env@example.com', 'environment value is the default');
    assert.equal(s.settings.update({ supportEmail: 'help@example.com', productName: '  Acme TV ' }).ok, true);
    assert.equal(s.settings.get().supportEmail, 'help@example.com', 'override applies live');
    assert.equal(s.settings.get().productName, 'Acme TV', 'values are trimmed');

    assert.deepEqual(s.settings.update({ supportEmail: 'not-an-email' }), { ok: false, error: 'invalid_value', key: 'supportEmail' });
    assert.equal(s.settings.update({ termsUrl: 'http://insecure.example.com' }).ok, false, 'links must be https');
    assert.equal(s.settings.update({ termsUrl: 'javascript:alert(1)' }).ok, false);
    assert.equal(s.settings.update({ tagline: 'x'.repeat(121) }).ok, false, 'length is capped');
    assert.deepEqual(s.settings.update({ stripeSecret: 'sk_live' }), { ok: false, error: 'unknown_setting', key: 'stripeSecret' });
    assert.equal(s.settings.update([]).ok, false);
    assert.equal(s.settings.get().supportEmail, 'help@example.com', 'a refused patch changes nothing');

    s.settings.update({ supportEmail: '' });
    assert.equal(s.settings.get().supportEmail, 'env@example.com', 'empty value resets to the default');
});

test('settings: persisted across restarts and audited', async (t) => {
    const s = await setup();
    t.after(s.close);
    s.settings.update({ tagline: 'Watch together' });
    assert.equal(s.entries.at(-1).action, 'settings');
    assert.deepEqual(s.entries.at(-1).details.changed, { tagline: 'Watch together' });
    const again = createSettings({ dataFile: s.file });
    assert.equal(again.get().tagline, 'Watch together');
});

test('settings: public config shows only set values; admin API needs the token', async (t) => {
    const s = await setup();
    t.after(s.close);
    assert.deepEqual(await (await fetch(`${s.base}/config/public`)).json(), {}, 'nothing configured, nothing exposed');

    assert.equal((await put(s, { productName: 'Acme' }, 'wrong')).status, 404, 'hidden without the token');
    assert.equal((await fetch(`${s.base}/admin/settings`)).status, 404);

    assert.equal((await put(s, { productName: 'Acme', privacyUrl: 'https://acme.example/privacy' })).status, 200);
    assert.deepEqual(await (await fetch(`${s.base}/config/public`)).json(), { productName: 'Acme', privacyUrl: 'https://acme.example/privacy' });

    const bad = await put(s, { supportEmail: 'nope' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_value', key: 'supportEmail' });

    const admin = await (await fetch(`${s.base}/admin/settings`, { headers: { authorization: 'Bearer tok' } })).json();
    assert.deepEqual(admin.overridden.sort(), ['privacyUrl', 'productName']);
    assert.equal(admin.fields.productName.label, 'Product name');
});

test('settings: a failed disk write rolls back and reports storage_unavailable', async (t) => {
    const s = await setup();
    t.after(s.close);
    s.settings.update({ productName: 'Before' });
    fs.rmSync(s.dir, { recursive: true, force: true }); // make the next write fail
    fs.writeFileSync(s.dir, 'now a file, not a directory');
    const result = s.settings.update({ productName: 'After' });
    assert.deepEqual(result, { ok: false, error: 'storage_unavailable' });
    assert.equal(s.settings.get().productName, 'Before');
    fs.rmSync(s.dir, { force: true });
});
