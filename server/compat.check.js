'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createAccounts } = require('./accounts');
const { configFor } = require('./announcement');
const { run } = require('../tools/compat/check');
const { encode } = require('./qr');

test('an app made for the stock API finds every call it uses (tools/compat/check.js)', async () => {
    const accounts = createAccounts({ dataFile: ':memory:' });
    const app = express();
    app.use('/api', accounts.router);
    app.use('/likes', accounts.ratingsRouter);
    app.use('/v2', accounts.linkRouter);
    app.use('/data-export', accounts.exportRouter);
    app.get('/config', (_req, res) => res.json(configFor({})));
    const server = app.listen(0);
    try {
        const results = await run(`http://127.0.0.1:${server.address().port}`);
        const failures = results.filter((r) => !r.ok);
        assert.deepEqual(failures, []);
        assert.ok(results.length >= 18);
    } finally {
        server.close();
    }
});

test('link sign-in: the device collects the key only after the person confirms', async () => {
    const accounts = createAccounts({ dataFile: ':memory:' });
    const app = express();
    app.use('/v2', accounts.linkRouter);
    app.use('/account', accounts.pageRouter);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await accounts.handlers.register({ email: 'tv@example.com', password: 'password1', gdpr_consent: { tos: true, privacy: true } }, {});
        const { code, link } = (await (await fetch(`${base}/v2/create`)).json()).result;
        assert.equal(link, `${base}/account/link?code=${code}`);
        assert.equal((await (await fetch(`${base}/v2/read?code=${code}`)).json()).error.code, 101);
        const confirm = (body) => fetch(`${base}/account/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal((await confirm({ code, email: 'tv@example.com', password: 'wrong-password' })).status, 401);
        assert.equal((await confirm({ code: 'NOPE00', email: 'tv@example.com', password: 'password1' })).status, 404);
        assert.equal((await confirm({ code: code.toLowerCase(), email: 'tv@example.com', password: 'password1' })).status, 200);
        const read = (await (await fetch(`${base}/v2/read?code=${code}`)).json()).result;
        assert.ok(accounts.lookup(read.authKey));
        assert.equal((await (await fetch(`${base}/v2/read?code=${code}`)).json()).error.code, 101); // used once
        assert.match(await (await fetch(`${base}/account/link?code=${code}`)).text(), /Sign in a device/);
    } finally {
        server.close();
    }
});

test('QR encoder: right size per version, finder patterns in three corners, refuses too much text', () => {
    const small = encode('A');
    assert.equal(small.size, 21);
    const link = encode('https://tv.example/account/link?code=ABCD2345');
    assert.ok(link.size > 21 && (link.size - 17) % 4 === 0);
    for (const [x, y] of [[0, 0], [link.size - 7, 0], [0, link.size - 7]]) {
        assert.ok(link.matrix[y][x] && link.matrix[y][x + 6] && link.matrix[y + 6][x] && !link.matrix[y + 1][x + 1] && link.matrix[y + 3][x + 3]);
    }
    assert.throws(() => encode('x'.repeat(200)), /too long/);
});
