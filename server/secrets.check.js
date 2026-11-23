'use strict';

// The operator-entered Stripe keys: validated, stored, masked on read, cleared, and applied live (onChange).
// Run with: pnpm run test:server

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { createSecrets } = require('./secrets');

const adminGuard = (req, res, next) => { if (req.headers.authorization === 'Bearer letmein') return next(); res.status(401).json({ error: 'unauthorized' }); };

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('secrets: masked on read, validated on write, applied live, never leaked', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
    let changes = 0;
    const store = createSecrets({ dataFile: path.join(dir, 'secrets.json'), onChange: () => { changes++; } });
    t.after(() => { store.flush(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

    // Nothing set yet; the view shows no hint and no full secret.
    assert.deepEqual(store.get(), { stripeSecretKey: '', stripeWebhookSecret: '' });
    assert.equal(store.view().stripe.configured, false);

    // Wrong formats are refused.
    assert.equal(store.update({ stripeSecretKey: 'nope' }).error, 'invalid_value');
    assert.equal(store.update({ stripeWebhookSecret: 'nope' }).error, 'invalid_value');
    assert.equal(store.update({ unknown: 'x' }).error, 'unknown_key');
    assert.equal(store.stripeConfigured(), false);

    // A valid key is stored and reported only as a masked hint (never the whole value).
    const sk = 'sk_test_51H8xABCDEFghij';
    assert.equal(store.update({ stripeSecretKey: sk }).ok, true);
    assert.equal(store.stripeConfigured(), true);
    assert.equal(store.view().stripe.hint, '…ghij');
    assert.equal(JSON.stringify(store.view()).includes(sk.slice(0, 12)), false, 'the secret must not appear in the view');
    assert.equal(changes, 1, 'onChange fires on save');

    const wh = 'whsec_9f8e7d6c5b4a';
    assert.equal(store.update({ stripeWebhookSecret: wh }).ok, true);
    assert.equal(store.view().webhook.hint, `…${wh.slice(-4)}`);

    // Clearing falls back (no secrets set).
    assert.equal(store.update({ stripeSecretKey: '', stripeWebhookSecret: '' }).ok, true);
    assert.equal(store.stripeConfigured(), false);
    assert.equal(store.view().webhook.configured, false);

    // Over HTTP: admin-only, never returns the full secret.
    const app = express();
    app.use('/admin/payments', store.adminRouter(adminGuard));
    const server = http.createServer(app);
    const port = await listen(server);
    t.after(() => server.close());
    const put = (body, auth = true) => fetch(`http://127.0.0.1:${port}/admin/payments`, {
        method: 'PUT', headers: { authorization: auth ? 'Bearer letmein' : 'Bearer wrong', 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal((await put({ stripeSecretKey: sk })).status, 200);
    assert.equal((await put({ stripeSecretKey: 'bad' })).status, 400);
    assert.equal((await put({ stripeSecretKey: sk }, false)).status, 401);
    const view = await (await fetch(`http://127.0.0.1:${port}/admin/payments`, { headers: { authorization: 'Bearer letmein' } })).json();
    assert.equal(view.stripe.configured, true);
    assert.equal(JSON.stringify(view).includes(sk), false);
});