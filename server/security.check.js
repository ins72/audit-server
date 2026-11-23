// Run with: pnpm run test:server   (uses node:test; named .check.js so jest ignores it)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createRateLimiter, originGuard, securityHeaders, jsonErrorHandler } = require('./security');
const { createJsonFile } = require('./jsonFile');

const serve = async (configure) => {
    const app = express();
    configure(app);
    app.use(jsonErrorHandler);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
};

test('rate limiter: failures-only mode leaves successful requests alone and blocks after the budget', async (t) => {
    let clock = 1000;
    const s = await serve((app) => {
        app.get('/try', createRateLimiter({ max: 3, windowMs: 60000, countOnlyFailures: true, now: () => clock }),
            (req, res) => res.status(req.query.ok ? 200 : 401).json({}));
    });
    t.after(s.close);
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${s.base}/try?ok=1`)).status, 200);
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${s.base}/try`)).status, 401);
    const blocked = await fetch(`${s.base}/try?ok=1`);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    clock += 61000;
    assert.equal((await fetch(`${s.base}/try?ok=1`)).status, 200, 'budget resets after the window');
});

test('rate limiter: normal mode counts every request', async (t) => {
    const s = await serve((app) => {
        app.get('/x', createRateLimiter({ max: 2 }), (_req, res) => res.json({}));
    });
    t.after(s.close);
    assert.equal((await fetch(`${s.base}/x`)).status, 200);
    assert.equal((await fetch(`${s.base}/x`)).status, 200);
    assert.equal((await fetch(`${s.base}/x`)).status, 429);
});

test('origin guard: blocks foreign origins on POST, allows ours, GETs and origin-less clients', async (t) => {
    const s = await serve((app) => {
        app.use(originGuard(['https://app.example.test']));
        app.all('/x', (_req, res) => res.json({ ok: true }));
    });
    t.after(s.close);
    const post = (headers) => fetch(`${s.base}/x`, { method: 'POST', headers });
    assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ origin: 'not a url' })).status, 403);
    assert.equal((await post({ origin: 'https://app.example.test' })).status, 200);
    assert.equal((await post({})).status, 200);
    assert.equal((await fetch(`${s.base}/x`, { headers: { origin: 'https://evil.example' } })).status, 200);
});

test('origin guard is a no-op when no origin is configured', async (t) => {
    const s = await serve((app) => {
        app.use(originGuard([]));
        app.post('/x', (_req, res) => res.json({ ok: true }));
    });
    t.after(s.close);
    assert.equal((await fetch(`${s.base}/x`, { method: 'POST', headers: { origin: 'https://anything.example' } })).status, 200);
});

test('security headers and JSON errors (no stack traces, no HTML)', async (t) => {
    const s = await serve((app) => {
        app.use(securityHeaders({ hsts: true }));
        app.use(express.json({ limit: '10b' }));
        app.post('/x', (_req, res) => res.json({ ok: true }));
        app.get('/boom', () => { throw new Error('secret internals'); });
    });
    t.after(s.close);
    const ok = await fetch(`${s.base}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(ok.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(ok.headers.get('strict-transport-security'), /max-age/);
    const bad = await fetch(`${s.base}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'bad_request' });
    const big = await fetch(`${s.base}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(100) }) });
    assert.equal(big.status, 413);
    const originalError = console.error;
    console.error = () => { };
    const boom = await fetch(`${s.base}/boom`);
    console.error = originalError;
    assert.equal(boom.status, 500);
    assert.deepEqual(await boom.json(), { error: 'internal_error' });
});

test('json file: round trips, and a corrupt file is preserved instead of overwritten', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonfile-'));
    const file = path.join(dir, 'state.json');

    const first = createJsonFile(file, () => ({ items: [] }));
    first.data.items.push('a');
    first.flush();
    assert.deepEqual(createJsonFile(file, () => ({ items: [] })).data.items, ['a']);

    fs.writeFileSync(file, '{ this is not json');
    const originalError = console.error;
    console.error = () => { };
    const recovered = createJsonFile(file, () => ({ items: [] }));
    console.error = originalError;
    assert.deepEqual(recovered.data.items, []);
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{ this is not json');

    recovered.data.items.push('b');
    recovered.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items, ['b']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('rate limiter: a custom isFailure decides what uses up the budget', async (t) => {
    const s = await serve((app) => {
        app.get('/x', createRateLimiter({ max: 2, countOnlyFailures: true, isFailure: (req) => req.query.bad === '1' }),
            (_req, res) => res.status(400).json({}));
    });
    t.after(s.close);
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${s.base}/x`)).status, 400, 'not counted');
    assert.equal((await fetch(`${s.base}/x?bad=1`)).status, 400);
    assert.equal((await fetch(`${s.base}/x?bad=1`)).status, 400);
    assert.equal((await fetch(`${s.base}/x?bad=1`)).status, 429);
});

test('rate limiter memory is bounded under a flood of distinct keys', () => {
    const { createRateLimiter } = require('./security');
    const limiter = createRateLimiter({ max: 5, keyFn: (req) => req.key });
    const res = { set() {}, status() { return { json() {} }; }, on() {} };
    for (let i = 0; i < 60000; i += 1) limiter({ key: `ip-${i}` }, res, () => {});
    // still functional afterwards
    let passed = false;
    limiter({ key: 'fresh' }, res, () => { passed = true; });
    assert.equal(passed, true);
});

test('json files get a daily backup and only the newest 7 are kept', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { createJsonFile } = require('./jsonFile');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-'));
    const file = path.join(dir, 'data.json');
    fs.writeFileSync(file, JSON.stringify({ keep: 'me' }));
    for (let day = 1; day <= 9; day += 1) fs.writeFileSync(`${file}.bak-2020-01-0${day}`, '{}');
    const { data } = createJsonFile(file, () => ({}));
    assert.equal(data.keep, 'me');
    const backups = fs.readdirSync(dir).filter((name) => name.includes('.bak-')).sort();
    assert.equal(backups.length, 7);
    assert.ok(backups.at(-1).startsWith('data.json.bak-20') && backups.some((name) => name === `data.json.bak-${new Date().toISOString().slice(0, 10)}`));
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak-${new Date().toISOString().slice(0, 10)}`, 'utf8')), { keep: 'me' });
    fs.rmSync(dir, { recursive: true, force: true });
});

test('json file reports unhealthy after a failed write and recovers', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { createJsonFile } = require('./jsonFile');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-'));
    const file = createJsonFile(path.join(dir, 'sub', 'd.json'), () => ({}));
    assert.equal(file.isHealthy(), true);
    fs.writeFileSync(path.join(dir, 'sub'), 'blocker');
    assert.equal(file.flush(), false);
    assert.equal(file.isHealthy(), false);
    fs.rmSync(path.join(dir, 'sub'));
    assert.equal(file.flush(), true);
    assert.equal(file.isHealthy(), true);
    fs.rmSync(dir, { recursive: true, force: true });
});
