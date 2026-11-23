// Run with: pnpm run test:server   (uses node:test; named .check.js so jest ignores it)

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { createAuth, COOKIE_NAME } = require('./auth');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const setup = async () => {
    const stremio = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(JSON.parse(body).authKey === 'good'
                ? { result: { _id: 'u1', email: 'a@example.com' } }
                : { error: { message: 'no session', code: 1 } }));
        });
    });
    await new Promise((resolve) => stremio.listen(0, '127.0.0.1', resolve));

    const auth = createAuth({ secret: 's'.repeat(40), stremioApiUrl: `http://127.0.0.1:${stremio.address().port}` });
    const app = express();
    app.use('/auth', auth.router);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { auth, base, close: () => { server.close(); stremio.close(); } };
};

const cookieFor = (auth, payload) => `${COOKIE_NAME}=${auth.sign({ u: 'u1', e: 'a@example.com', ...payload })}`;
const me = (s, cookie) => fetch(`${s.base}/auth/me`, { headers: { cookie } });

test('session cookie lifecycle', async (t) => {
    const s = await setup();
    t.after(s.close);
    const now = Date.now();

    await t.test('login sets an HttpOnly SameSite cookie and never returns the auth key', async () => {
        const response = await fetch(`${s.base}/auth/session`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey: 'good' })
        });
        assert.equal(response.status, 200);
        const cookie = response.headers.get('set-cookie');
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Lax/);
        assert.doesNotMatch(await response.text(), /good/);
    });

    await t.test('input validation', async () => {
        const post = (body) => fetch(`${s.base}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal((await post({})).status, 400);
        assert.equal((await post({ authKey: 123 })).status, 400);
        assert.equal((await post({ authKey: 'x'.repeat(513) })).status, 400);
        assert.equal((await post({ authKey: 'wrong' })).status, 401);
    });

    await t.test('a fresh cookie is not renewed; an expired or tampered one is rejected', async () => {
        const fresh = await me(s, cookieFor(s.auth, { iat: now, exp: now + 11 * HOUR }));
        assert.equal(fresh.status, 200);
        assert.equal(fresh.headers.get('set-cookie'), null);
        assert.equal((await me(s, cookieFor(s.auth, { iat: now - DAY, exp: now - 1000 }))).status, 401);
        assert.equal((await me(s, `${cookieFor(s.auth, { iat: now, exp: now + HOUR })}x`)).status, 401);
        assert.equal((await me(s, '')).status, 401);
    });

    await t.test('a cookie past half its life is renewed, keeping its original issue time', async () => {
        const iat = now - 7 * HOUR;
        const response = await me(s, cookieFor(s.auth, { iat, exp: now + 5 * HOUR }));
        assert.equal(response.status, 200);
        const renewed = response.headers.get('set-cookie');
        assert.ok(renewed, 'expected a renewed cookie');
        const token = renewed.split(';')[0].slice(COOKIE_NAME.length + 1);
        const verified = s.auth.verify(token);
        assert.equal(verified.iat, iat);
        assert.ok(verified.exp > now + 11 * HOUR);
    });

    await t.test('renewal stops at the 7 day cap so a revoked Stremio session cannot live on', async () => {
        const iat = now - (7 * DAY - HOUR);
        const response = await me(s, cookieFor(s.auth, { iat, exp: iat + 7 * DAY }));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('set-cookie'), null);
    });

    await t.test('logout clears the cookie', async () => {
        const response = await fetch(`${s.base}/auth/logout`, { method: 'POST' });
        assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    });
});

test('createAuth refuses a short secret', () => {
    assert.throws(() => createAuth({ secret: 'short' }), /SESSION_SECRET/);
});

test('logout revokes tokens issued before it, and a correct admin token is never locked out', async (t) => {
    const { createAuth } = require('./auth');
    const http = require('http');
    const express = require('express');
    const mock = http.createServer((_req, res) => res.end(JSON.stringify({ result: { _id: 'u1', email: 'u@example.com' } })));
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    const auth = createAuth({ secret: 'x'.repeat(40), adminToken: 'tok', stremioApiUrl: `http://127.0.0.1:${mock.address().port}` });
    const app = express();
    app.use('/auth', auth.router);
    app.use('/admin', auth.admin);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.close(); mock.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const login = await fetch(`${base}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey: 'k' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/auth/me`, { headers: { cookie } })).status, 200);
    await new Promise((r) => setTimeout(r, 5));
    await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal((await fetch(`${base}/auth/me`, { headers: { cookie } })).status, 401, 'copied cookie is dead after logout');

    for (let i = 0; i < 15; i += 1) await fetch(`${base}/admin/sessions`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal((await fetch(`${base}/admin/sessions`, { headers: { authorization: 'Bearer wrong' } })).status, 429);
    assert.equal((await fetch(`${base}/admin/sessions`, { headers: { authorization: 'Bearer tok' } })).status, 200);
});

test('identical authKeys in flight share one Stremio call; upstream calls are capped', async (t) => {
    const { createAuth } = require('./auth');
    const http = require('http');
    const express = require('express');
    let upstream = 0;
    const mock = http.createServer((_req, res) => {
        upstream += 1;
        setTimeout(() => res.end(JSON.stringify({ result: { _id: 'u1', email: 'u@example.com' } })), 150);
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    const auth = createAuth({ secret: 'x'.repeat(40), stremioApiUrl: `http://127.0.0.1:${mock.address().port}` });
    const app = express();
    app.use('/auth', auth.router);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.close(); mock.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (authKey) => fetch(`${base}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey }) });

    const same = await Promise.all(Array.from({ length: 20 }, () => post('same-key')));
    assert.ok(same.every((r) => r.status === 200));
    assert.equal(upstream, 1, '20 concurrent logins with one key = one upstream call');

    upstream = 0;
    let peak = 0;
    mock.on('request', () => { peak = Math.max(peak, upstream); });
    const many = await Promise.all(Array.from({ length: 120 }, (_, i) => post(`key-${i}`)));
    assert.ok(many.every((r) => r.status === 200), 'bursts queue instead of failing');
    assert.equal(upstream, 120);
});

test('blocked login tells the user whom to contact', async (t) => {
    const stremio = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => res.end(JSON.stringify({ result: { _id: 'u9', email: 'bad@example.com' } })));
    });
    await new Promise((resolve) => stremio.listen(0, '127.0.0.1', resolve));
    const auth = createAuth({ secret: 's'.repeat(40), stremioApiUrl: `http://127.0.0.1:${stremio.address().port}`, supportEmail: 'help@example.com' });
    auth.store.ban('bad@example.com', 'test');
    const app = express();
    app.use('/auth', auth.router);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.close(); stremio.close(); });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/auth/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey: 'k' })
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'banned', support: 'help@example.com' });
});

test('operator can sign a person out everywhere without blocking them (P1-01)', async (t) => {
    const stremio = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => res.end(JSON.stringify({ result: { _id: 'u7', email: 'Sam@example.com' } })));
    });
    await new Promise((resolve) => stremio.listen(0, '127.0.0.1', resolve));
    const auth = createAuth({ secret: 's'.repeat(40), adminToken: 'tok', stremioApiUrl: `http://127.0.0.1:${stremio.address().port}` });
    const app = express();
    app.use('/auth', auth.router);
    app.use('/admin', auth.admin);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.close(); stremio.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const admin = (body, token = 'tok') => fetch(`${base}/admin/signout`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body)
    });

    const login = await fetch(`${base}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey: 'k' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/auth/me`, { headers: { cookie } })).status, 200);

    assert.equal((await admin({ email: 'sam@example.com' }, 'wrong')).status, 404, 'needs the admin token');
    assert.equal((await admin({ email: 'nobody@example.com' })).status, 404);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await admin({ email: 'SAM@example.com' });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ok: true, users: 1 });

    assert.equal((await fetch(`${base}/auth/me`, { headers: { cookie } })).status, 401, 'old cookie is dead');
    assert.equal(auth.store.isBanned('sam@example.com'), false, 'not blocked');
    const again = await fetch(`${base}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey: 'k' }) });
    assert.equal(again.status, 200, 'can sign in again');
});

test('operator people list can be searched and paged without loading everyone (P2-12)', async (t) => {
    const stremio = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const key = JSON.parse(body || '{}').authKey;
            res.end(JSON.stringify({ result: { _id: `id-${key}`, email: `${key}@Example.com` } }));
        });
    });
    await new Promise((resolve) => stremio.listen(0, '127.0.0.1', resolve));
    const auth = createAuth({ secret: 's'.repeat(40), adminToken: 'tok', stremioApiUrl: `http://127.0.0.1:${stremio.address().port}` });
    const app = express();
    app.use('/auth', auth.router);
    app.use('/admin', auth.admin);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.close(); stremio.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const names = ['anna', 'bob', 'carla', 'annabel', 'dave'];
    for (const name of names) {
        await fetch(`${base}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey: name }) });
        await new Promise((resolve) => setTimeout(resolve, 5)); // distinct lastSeen so the order is stable
    }
    const list = async (query = '') => (await fetch(`${base}/admin/sessions${query}`, { headers: { authorization: 'Bearer tok' } })).json();

    const all = await list();
    assert.equal(all.total, 5);
    assert.equal(all.matched, 5);
    assert.deepEqual(all.users.map((u) => u.email.split('@')[0]), ['dave', 'annabel', 'carla', 'bob', 'anna'].map((n) => n.toLowerCase()), 'newest activity first');

    const found = await list('?q=ANNA');
    assert.deepEqual(found.users.map((u) => u.email.split('@')[0]).sort(), ['anna', 'annabel'], 'case-insensitive substring');
    assert.equal(found.matched, 2);
    assert.equal(found.total, 5, 'total still counts everyone');

    const page = await list('?limit=2&offset=2');
    assert.equal(page.users.length, 2);
    assert.equal(page.matched, 5);
    assert.equal(page.offset, 2);
    assert.equal((await list('?limit=0')).limit, 100, 'bad limit falls back');
    assert.equal((await list('?limit=99999')).limit, 500, 'limit is capped');
    assert.equal((await list('?q=nobody@nowhere')).matched, 0);
});

test('operator note: set, shown, exported, cleared and erased with the person', async (t) => {
    const entries = [];
    const stremio = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => res.end(JSON.stringify({ result: { _id: 'u9', email: 'Pat@example.com' } })));
    });
    await new Promise((resolve) => stremio.listen(0, '127.0.0.1', resolve));
    const auth = createAuth({ secret: 's'.repeat(40), adminToken: 'tok', stremioApiUrl: `http://127.0.0.1:${stremio.address().port}`, audit: { record: (action, details) => entries.push({ action, ...details }), recent: () => entries } });
    const app = express();
    app.use('/auth', auth.router);
    app.use('/admin', auth.admin);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.close(); stremio.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey: 'k' }) });
    const call = (route, body) => fetch(`${base}/admin${route}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const email = 'pat@example.com';

    assert.equal((await call('/note', { email: 'nobody@example.com', note: 'x' })).status, 404);
    assert.equal((await call('/note', { email, note: 'x'.repeat(501) })).status, 400);
    assert.equal((await call('/note', { email, note: 5 })).status, 400);
    assert.equal((await call('/note', { email, note: '  pays by bank transfer  ' })).status, 200);
    assert.equal((await (await call(`/users/export?email=${email}`)).json()).users[0].note, 'pays by bank transfer');
    assert.ok(entries.some((entry) => entry.action === 'note' && entry.change === 'set'));
    assert.ok(!JSON.stringify(entries).includes('bank transfer'), 'the note text stays out of the audit log');
    assert.equal((await call('/note', { email, note: '' })).status, 200);
    assert.equal((await (await call(`/users/export?email=${email}`)).json()).users[0].note, undefined);
    await call('/note', { email, note: 'again' });
    assert.equal((await call('/users/erase', { email })).status, 200);
    assert.equal((await call('/note', { email, note: 'x' })).status, 404, 'an erased person has no record left to attach a note to');
});
