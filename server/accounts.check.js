'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createAccounts } = require('./accounts');

const make = (opts = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
    return Object.assign(createAccounts({ dataFile: path.join(dir, 'accounts.db'), ...opts }), { _dir: dir });
};
const consent = { tos: true, privacy: true, marketing: false, from: 'web' };
const signup = async (a, email = 'a@example.com') => (await a.handlers.register({ email, password: 'password1', gdpr_consent: consent }, {})).result;

test('register validates input and rejects duplicates', async () => {
    const a = make();
    assert.equal((await a.handlers.register({ email: 'nope', password: 'password1', gdpr_consent: consent }, {})).error.code, 101);
    assert.equal((await a.handlers.register({ email: 'a@b.co', password: 'short', gdpr_consent: consent }, {})).error.code, 102);
    assert.equal((await a.handlers.register({ email: 'a@b.co', password: 'password1' }, {})).error.code, 103);
    const ok = await signup(a);
    assert.ok(ok.authKey && ok.user.gdpr_consent.tos === true);
    assert.equal((await a.handlers.register({ email: 'A@Example.com', password: 'password1', gdpr_consent: consent }, {})).error.code, 104);
    assert.equal(a.count(), 1);
});

test('registration can be closed', async () => {
    const a = make({ registrationOpen: () => false });
    assert.equal((await a.handlers.register({ email: 'a@b.co', password: 'password1', gdpr_consent: consent }, {})).error.code, 105);
});

test('login, key lookup, logout', async () => {
    const a = make();
    await signup(a);
    assert.equal((await a.handlers.login({ email: 'a@example.com', password: 'wrongpass1' }, {})).error.code, 2);
    assert.equal((await a.handlers.login({ email: 'x@example.com', password: 'password1' }, {})).error.code, 1);
    const { authKey, user } = (await a.handlers.login({ email: 'A@example.com', password: 'password1' }, {})).result;
    assert.deepEqual(a.lookup(authKey), { id: user._id, email: 'a@example.com' });
    assert.equal(a.lookup('x'.repeat(30)), null);
    a.handlers.logout({ authKey });
    assert.equal(a.lookup(authKey), null);
});

test('login is rate limited per ip and email', async () => {
    const a = make();
    await signup(a);
    let last;
    for (let i = 0; i < 9; i++) last = await a.handlers.login({ email: 'a@example.com', password: 'badbadbad' }, { ip: '1.1.1.1' });
    assert.equal(last.error.code, 106);
    assert.ok((await a.handlers.login({ email: 'a@example.com', password: 'password1' }, { ip: '2.2.2.2' })).result);
});

test('add-ons: defaults then saved collection', async () => {
    const manifest = { id: 'org.cinemeta', name: 'Cinemeta', version: '1' };
    const a = make({ defaultAddonUrls: () => ['https://v3-cinemeta.strem.io/manifest.json'], fetchImpl: async () => ({ ok: true, json: async () => manifest }) });
    const { authKey } = await signup(a);
    const first = (await a.handlers.addonCollectionGet({ authKey })).result;
    assert.equal(first.addons.length, 1);
    assert.deepEqual(first.addons[0].flags, { official: true, protected: true });
    const mine = [{ manifest, transportUrl: 'https://x.test/manifest.json', flags: {} }];
    assert.ok((await a.handlers.addonCollectionSet({ authKey, addons: mine })).result.success);
    assert.deepEqual((await a.handlers.addonCollectionGet({ authKey })).result.addons, mine);
    assert.equal((await a.handlers.addonCollectionSet({ authKey, addons: 'x' })).error.code, 108);
});

test('library sync keeps the newest version of each item', async () => {
    const a = make();
    const { authKey } = await signup(a);
    const item = (id, mtime, name) => ({ _id: id, _mtime: mtime, name });
    await a.handlers.datastorePut({ authKey, collection: 'libraryItem', changes: [item('tt1', '2026-01-02T00:00:00Z', 'new')] });
    await a.handlers.datastorePut({ authKey, collection: 'libraryItem', changes: [item('tt1', '2026-01-01T00:00:00Z', 'old'), item('tt2', '2026-01-01T00:00:00Z', 'two')] });
    const meta = (await a.handlers.datastoreMeta({ authKey, collection: 'libraryItem' })).result;
    assert.equal(meta.length, 2);
    const got = (await a.handlers.datastoreGet({ authKey, collection: 'libraryItem', ids: ['tt1'], all: false })).result;
    assert.equal(got[0].name, 'new');
    assert.equal((await a.handlers.datastoreGet({ authKey, collection: 'libraryItem', all: true })).result.length, 2);
    assert.equal((await a.handlers.datastorePut({ authKey, collection: 'libraryItem', changes: [{ _id: 'x' }] })).error.code, 108);
    assert.equal((await a.handlers.datastoreMeta({ authKey: 'z'.repeat(30), collection: 'libraryItem' })).error.code, 1);
});

test('app settings sync saves and loads a profile\'s player choices', async () => {
    const a = make();
    const { authKey } = await signup(a);
    // Empty until first save.
    assert.deepEqual((await a.handlers.appSettingsGet({ authKey })).result.settings, {});
    const settings = { maxHeight: 720, dubbed: 'mine', audioLang: 'hi', subLang: 'en', subPref: 'on', uiScale: false };
    assert.ok((await a.handlers.appSettingsSet({ authKey, settings })).result.success);
    assert.deepEqual((await a.handlers.appSettingsGet({ authKey })).result.settings, settings);
    // Overwrite replaces the whole map.
    assert.ok((await a.handlers.appSettingsSet({ authKey, settings: { maxHeight: 1080 } })).result.success);
    assert.deepEqual((await a.handlers.appSettingsGet({ authKey })).result.settings, { maxHeight: 1080 });
    // Bad input refused; unknown key rejected.
    assert.equal((await a.handlers.appSettingsSet({ authKey, settings: 'x' })).error.code, 108);
    assert.equal((await a.handlers.appSettingsSet({ authKey, settings: { 'bad key!': 'x' } })).error.code, 108);
    assert.equal((await a.handlers.appSettingsGet({ authKey: 'z'.repeat(30) })).error.code, 1);
});

test('profiles sync: list and active selection round-trip, with validation', async () => {
    const a = make();
    const { authKey } = await signup(a);
    // Empty until first save.
    assert.deepEqual((await a.handlers.profilesGet({ authKey })).result.list, []);
    const list = [
        { id: '1', name: 'Me', color: -100000, authKey: 'key-one', pin: null },
        { id: '2', name: 'Sam', color: 10, authKey: 'key-two', pin: '1234' }
    ];
    assert.ok((await a.handlers.profilesSet({ authKey, list, active: '2' })).result.success);
    const got = (await a.handlers.profilesGet({ authKey })).result;
    assert.equal(got.active, '2');
    assert.deepEqual(got.list.map((p) => p.id), ['1', '2']);
    assert.equal(got.list[1].pin, '1234');
    // A profile without a key is dropped; duplicate ids collapse.
    const messy = await a.handlers.profilesSet({ authKey, list: [{ id: '1', name: 'X', authKey: '' }, { id: '1', name: 'Y', authKey: 'k' }] });
    assert.ok(messy.result.success);
    assert.deepEqual((await a.handlers.profilesGet({ authKey })).result.list.map((p) => p.id), ['1']);
    // Too many profiles refused; unknown key rejected.
    assert.equal((await a.handlers.profilesSet({ authKey, list: Array.from({ length: 9 }, (_, i) => ({ id: String(i), authKey: 'k' })) })).error.code, 109);
    assert.equal((await a.handlers.profilesGet({ authKey: 'z'.repeat(30) })).error.code, 1);
    // Per-profile mod and tombstones round-trip (the client merges by mod; a deleted row carries no key).
    const merged = await a.handlers.profilesSet({
        authKey,
        list: [
            { id: '1', name: 'Renamed', authKey: 'k1', pin: null, mod: 200 },
            { id: '2', deleted: true, mod: 300 }
        ]
    });
    assert.ok(merged.result.success);
    const after = (await a.handlers.profilesGet({ authKey })).result;
    assert.deepEqual(after.list.map((p) => p.id), ['1', '2']);
    assert.equal(after.list[0].name, 'Renamed');
    assert.equal(after.list[0].mod, 200);
    assert.equal(after.list[1].deleted, true);
    assert.equal(after.list[1].mod, 300);
    assert.equal(after.active, '1'); // active points only at a live profile, never a tombstone
});

test('profiles: a household member reads and writes the owner\'s shared list', async () => {
    const a = make();
    const owner = await signup(a, 'owner@example.com');
    const member = await signup(a, 'member@example.com');
    // Stand in for billing: the member shares the owner's household, so both resolve to the owner's list.
    a.setHouseholdResolver((user) => (user.email === 'member@example.com' ? owner.user._id : null));
    const set = await a.handlers.profilesSet({
        authKey: member.authKey,
        list: [{ id: '1', name: 'Family', authKey: 'k1' }, { id: '2', name: 'Kid', authKey: 'k2' }],
        active: '1'
    });
    assert.ok(set.result.success);
    // The list is stored under the owner, so the owner and the member both see the same profiles.
    const ownerView = (await a.handlers.profilesGet({ authKey: owner.authKey })).result;
    assert.deepEqual(ownerView.list.map((p) => p.name), ['Family', 'Kid']);
    const memberView = (await a.handlers.profilesGet({ authKey: member.authKey })).result;
    assert.deepEqual(memberView.list.map((p) => p.id), ['1', '2']);
});

test('app settings survive restart', async () => {
    const a = make();
    const dir = a._dir;
    const { authKey } = await signup(a);
    await a.handlers.appSettingsSet({ authKey, settings: { maxHeight: 480, audioLang: 'fr' } });
    a.flush();
    const again = createAccounts({ dataFile: path.join(dir, 'accounts.db') });
    assert.deepEqual((await again.handlers.appSettingsGet({ authKey })).result.settings, { maxHeight: 480, audioLang: 'fr' });
});

test('data survives restart; delete and erase remove everything', async () => {
    const a = make();
    const dir = a._dir;
    const { authKey } = await signup(a);
    await a.handlers.datastorePut({ authKey, collection: 'libraryItem', changes: [{ _id: 't', _mtime: '2026-01-01T00:00:00Z' }] });
    a.flush();
    const again = createAccounts({ dataFile: path.join(dir, 'accounts.db') });
    assert.ok(again.lookup(authKey));
    assert.equal((await again.handlers.deleteUser({ authKey, password: 'nope-nope' })).error.code, 2);
    assert.ok((await again.handlers.deleteUser({ authKey, password: 'password1' })).result.success);
    assert.equal(again.lookup(authKey), null);
    assert.equal(again.hasAccount('a@example.com'), false);
    const b = make();
    await signup(b, 'b@example.com');
    assert.equal(b.eraseByEmail('B@example.com'), true);
    assert.equal(b.eraseByEmail('b@example.com'), false);
});

test('unsupported and unknown calls answer in the core error shape', async () => {
    const a = make();
    assert.equal((await a.handlers.authWithFacebook({})).error.code, 107);
    assert.equal(Object.hasOwn(a.handlers, 'constructor'), false);
});

test('password reset: token works once, signs out everywhere, never reveals who is registered', async () => {
    const sent = [];
    const a = make({ sendResetEmail: async (mail) => { sent.push(mail); }, publicUrl: 'https://tv.example' });
    const { authKey } = await signup(a);
    assert.deepEqual(await a.requestReset('nobody@example.com', { ip: '1' }), { sent: true });
    assert.equal(sent.length, 0);
    assert.deepEqual(await a.requestReset('A@example.com', { ip: '1' }), { sent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'a@example.com');
    const token = new URL(sent[0].resetUrl).searchParams.get('token');
    assert.match(sent[0].resetUrl, /^https:\/\/tv\.example\/account\/reset\?token=/);
    assert.equal((await a.resetPassword({ token, password: 'short' })).error, 'weak_password');
    assert.equal((await a.resetPassword({ token: 'x'.repeat(30), password: 'new-password-1' })).error, 'invalid_token');
    assert.equal((await a.resetPassword({ token, password: 'new-password-1' })).ok, true);
    assert.equal((await a.resetPassword({ token, password: 'another-pass-1' })).error, 'invalid_token');
    assert.equal(a.lookup(authKey), null);
    assert.equal((await a.handlers.login({ email: 'a@example.com', password: 'password1' }, {})).error.code, 2);
    assert.ok((await a.handlers.login({ email: 'a@example.com', password: 'new-password-1' }, {})).result);
});

test('password reset: expires, is rate limited, and says so when email is not set up', async () => {
    let time = 1000000;
    const sent = [];
    const a = make({ sendResetEmail: async (mail) => { sent.push(mail); }, publicUrl: 'https://tv.example', now: () => time });
    await signup(a);
    await a.requestReset('a@example.com', { ip: '1' });
    const token = new URL(sent[0].resetUrl).searchParams.get('token');
    time += 61 * 60 * 1000;
    assert.equal((await a.resetPassword({ token, password: 'new-password-1' })).error, 'invalid_token');
    for (let i = 0; i < 3; i += 1) await a.requestReset('a@example.com', { ip: '1' });
    assert.equal((await a.requestReset('a@example.com', { ip: '1' })).reason, 'too_many');
    assert.equal((await make().requestReset('a@example.com', {})).reason, 'mail_off');
});

test('operator routes: info, export and sign-out need the guard and leak no secrets', async () => {
    const express = require('express');
    const a = make();
    await signup(a);
    const app = express();
    app.use('/admin/accounts', a.adminRouter((req, res, next) => (req.get('x-op') === 'yes' ? next() : res.status(401).json({ error: 'no' }))));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/admin/accounts`;
    try {
        assert.equal((await fetch(`${base}/info?email=a@example.com`)).status, 401);
        const info = await (await fetch(`${base}/info?email=A@example.com`, { headers: { 'x-op': 'yes' } })).json();
        assert.equal(info.devices, 1);
        assert.equal((await fetch(`${base}/info?email=zz@example.com`, { headers: { 'x-op': 'yes' } })).status, 404);
        const dump = await (await fetch(`${base}/export?email=a@example.com`, { headers: { 'x-op': 'yes' } })).text();
        assert.ok(!/passwordHash|scrypt|keys/.test(dump));
        await fetch(`${base}/signout`, { method: 'POST', headers: { 'x-op': 'yes', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com' }) });
        assert.equal((await (await fetch(`${base}/info?email=a@example.com`, { headers: { 'x-op': 'yes' } })).json()).devices, 0);
    } finally {
        server.close();
    }
});

test('database: key cap, all-or-nothing library writes, cascade delete, racing sign-ups, daily backup', async () => {
    const { createAccountsStore } = require('./accountsStore');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-db-'));
    const file = path.join(dir, 'accounts.db');
    const store = createAccountsStore(file);
    const a = createAccounts({ store });
    // two sign-ups for one email at the same moment: exactly one wins
    const [one, two] = await Promise.all([1, 2].map(() => a.handlers.register({ email: 'race@example.com', password: 'password1', gdpr_consent: consent }, {})));
    assert.equal([one, two].filter((r) => r.result).length, 1);
    assert.equal(store.count(), 1);
    // at most 20 keys per person: the oldest are dropped
    let first = null;
    for (let i = 0; i < 25; i += 1) {
        const { result } = await a.handlers.login({ email: 'race@example.com', password: 'password1' }, { ip: `ip${i}` });
        first = first || result.authKey;
    }
    const user = store.userByEmail('RACE@example.com');
    assert.equal(store.keyCount(user.id), 20);
    // a batch with one item over the limit changes nothing
    const items = [{ _id: 'a', _mtime: '2026-01-01T00:00:00Z' }, { _id: 'b', _mtime: '2026-01-01T00:00:00Z' }];
    assert.throws(() => store.libraryPut(user.id, items.map((item) => ({ item, mtime: Date.parse(item._mtime) })), 1), /too large/);
    assert.equal(store.libraryCount(user.id), 0);
    store.libraryPut(user.id, items.map((item) => ({ item, mtime: Date.parse(item._mtime) })), 10);
    store.startBackups(() => Date.parse('2026-03-05T10:00:00Z'));
    assert.ok(fs.existsSync(`${file}.bak-2026-03-05`));
    // deleting the person removes keys and library with them
    assert.equal(a.eraseByEmail('race@example.com'), true);
    assert.equal(store.keyCount(user.id), 0);
    assert.equal(store.libraryCount(user.id), 0);
    store.close();
});

test('owner pages: export and delete need the password, share the failure limit', async () => {
    const express = require('express');
    const a = make();
    const { authKey } = await signup(a);
    await a.handlers.datastorePut({ authKey, collection: 'libraryItem', changes: [{ _id: 'tt1', _mtime: '2026-01-01T00:00:00Z' }] });
    const app = express();
    app.use('/account', a.pageRouter);
    const server = app.listen(0);
    const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/account/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
        assert.equal((await post('export', { email: 'a@example.com', password: 'wrong-pass-1' })).status, 401);
        assert.equal((await post('delete', { email: 'nobody@example.com', password: 'password1' })).status, 401);
        const dump = await (await post('export', { email: 'A@example.com', password: 'password1' })).text();
        assert.ok(JSON.parse(dump).library.length === 1 && !/scrypt|passwordHash/.test(dump));
        assert.equal(a.hasAccount('a@example.com'), true);
        assert.equal((await post('delete', { email: 'a@example.com', password: 'password1' })).status, 200);
        assert.equal(a.hasAccount('a@example.com'), false);
        const page = await (await fetch(`http://127.0.0.1:${server.address().port}/account/manage`)).text();
        assert.match(page, /Download my data/);
    } finally {
        server.close();
    }
});

test('calendar token: stable per person, unknown tokens find nothing, older databases are migrated', async () => {
    const a = make();
    const { authKey } = await signup(a);
    const first = (await a.handlers.calendarToken({ authKey })).result.path;
    assert.match(first, /^\/calendar\/[\w-]{20,}\.ics$/);
    assert.equal((await a.handlers.calendarToken({ authKey })).result.path, first);
    await a.handlers.datastorePut({ authKey, collection: 'libraryItem', changes: [{ _id: 'tt1', _mtime: '2026-01-01T00:00:00Z', type: 'series' }] });
    assert.equal(a.calendarSeries(first.slice(10, -4)).length, 1);
    assert.equal(a.calendarSeries('z'.repeat(30)), null);
    assert.equal((await a.handlers.calendarToken({ authKey: 'x'.repeat(30) })).error.code, 1);
    // a database made before the column existed
    const { DatabaseSync } = require('node:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-old-'));
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, date_registered INTEGER NOT NULL, last_modified INTEGER NOT NULL, gdpr TEXT NOT NULL, avatar TEXT, trakt TEXT, addons TEXT, addons_modified INTEGER, reset_hash TEXT, reset_expires INTEGER)');
    old.close();
    const { createAccountsStore } = require('./accountsStore');
    const migrated = createAccountsStore(file);
    assert.equal(migrated.userIdByCalendarToken('nothing'), null);
    migrated.close();
});

test('ratings service and in-app data export', async () => {
    const express = require('express');
    const a = make();
    const { authKey } = await signup(a);
    const app = express();
    app.use('/likes', a.ratingsRouter);
    app.use('/data-export', a.exportRouter);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (body) => fetch(`${base}/likes/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const status = async (key, id = 'tt1') => (await fetch(`${base}/likes/api/get_status?authToken=${key}&mediaId=${id}&mediaType=movie`)).json();
    try {
        assert.deepEqual(await status(authKey), { status: null });
        assert.equal((await send({ authToken: authKey, mediaId: 'tt1', mediaType: 'movie', status: 'loved' })).status, 200);
        assert.deepEqual(await status(authKey), { status: 'loved' });
        assert.equal((await send({ authToken: authKey, mediaId: 'tt1', mediaType: 'movie', status: 'meh' })).status, 400);
        assert.equal((await send({ authToken: 'x'.repeat(30), mediaId: 'tt1', mediaType: 'movie', status: 'liked' })).status, 401);
        assert.equal((await fetch(`${base}/likes/api/get_status?authToken=bad&mediaId=tt1&mediaType=movie`)).status, 401);
        const exportId = (await a.handlers.dataExport({ authKey })).result.exportId;
        const dump = await (await fetch(`${base}/data-export/${exportId}/export.json`)).json();
        assert.deepEqual(dump.ratings, [{ type: 'movie', id: 'tt1', status: 'loved' }]);
        assert.equal((await fetch(`${base}/data-export/nope/export.json`)).status, 404);
        assert.equal((await send({ authToken: authKey, mediaId: 'tt1', mediaType: 'movie', status: null })).status, 200);
        assert.deepEqual(await status(authKey), { status: null });
        assert.equal((await a.handlers.dataExport({ authKey: 'x'.repeat(30) })).error.code, 1);
    } finally {
        server.close();
    }
    // erasing the person removes their ratings with them
    await send; 
    assert.equal(a.eraseByEmail('a@example.com'), true);
});

test('default add-ons fall back to the last good copy and the built-in Cinemeta when their host is unreachable', async () => {
    const { createAccounts } = require('./accounts');
    const down = async () => { throw new Error('offline'); };
    const a = createAccounts({ dataFile: ':memory:', fetchImpl: down, defaultAddonUrls: () => ['https://v3-cinemeta.strem.io/manifest.json', 'https://other.example.com/manifest.json'], registrationOpen: () => true });
    const reg = await a.handlers.register({ email: 'fb@example.com', password: 'a-long-password', gdpr_consent: { tos: true, privacy: true } });
    const list = (await a.handlers.addonCollectionGet({ authKey: reg.result.authKey })).result.addons;
    assert.equal(list.length, 1);
    assert.equal(list[0].manifest.id, 'com.linvo.cinemeta');
    a.close();
});

test('API answers in the stock shape for odd requests: bad JSON, form bodies, wrong method, ratings on the same address', async () => {
    const express = require('express');
    const a = createAccounts({ dataFile: ':memory:', fetchImpl: async () => { throw new Error('offline'); }, defaultAddonUrls: () => [], registrationOpen: () => true });
    const app = express();
    app.use('/api', a.router);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    try {
        const bad = await fetch(`${base}/login`, { method: 'POST', body: '{bad' });
        assert.equal(bad.status, 200);
        assert.equal((await bad.json()).error.code, 108);
        const get = await fetch(`${base}/getUser`);
        assert.equal(get.status, 200);
        assert.equal((await get.json()).error.code, 108);
        const reg = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=form%40example.com&password=a-long-password&gdpr_consent=1' })).json();
        assert.ok(reg.error, 'form body is read, and refused for the missing consent object rather than crashing');
        const labelled = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: JSON.stringify({ email: 'j@example.com', password: 'a-long-password', gdpr_consent: { tos: true, privacy: true } }) })).json();
        assert.ok(labelled.result && labelled.result.authKey, 'JSON labelled as a form is still read as JSON');
        const ok = await (await fetch(`${base}/register`, { method: 'POST', body: JSON.stringify({ email: 'o@example.com', password: 'a-long-password', gdpr_consent: { tos: true, privacy: true } }) })).json();
        const key = ok.result.authKey;
        const sent = await (await fetch(`${base}/send`, { method: 'POST', body: JSON.stringify({ authToken: key, mediaId: 'tt1', mediaType: 'movie', status: 'liked' }) })).json();
        assert.equal(sent.rating && sent.rating.status, 'liked', JSON.stringify(sent));
        const st = await (await fetch(`${base}/get_status?authToken=${key}&mediaId=tt1&mediaType=movie`)).json();
        assert.equal(st.status, 'liked');
    } finally { server.close(); a.close(); }
});

test('QR sign-in: the address in the code is our own (PUBLIC_URL, or the forwarded host behind a proxy), the page and code image name no Stremio host', async () => {
    const express = require('express');
    const build = async (publicUrl) => {
        const a = createAccounts({ dataFile: ':memory:', fetchImpl: async () => { throw new Error('offline'); }, defaultAddonUrls: () => [], registrationOpen: () => true, publicUrl });
        const app = express();
        app.set('trust proxy', true);
        app.use('/api/v2', a.linkRouter);
        app.use('/v2', a.linkRouter);
        app.use('/account', a.pageRouter);
        const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
        return { a, server, base: `http://127.0.0.1:${server.address().port}` };
    };
    const stock = /strem\.io|stremio\.com|stremio\.net/i;
    let t = await build('https://tv.example');
    try {
        const made = (await (await fetch(`${t.base}/api/v2/create?type=Create`)).json()).result;
        assert.ok(made.link.startsWith('https://tv.example/account/link?code='), made.link);
        assert.ok(!stock.test(made.link) && !stock.test(Buffer.from(made.qrcode.split(',')[1], made.qrcode.includes('base64') ? 'base64' : 'utf8').toString()));
        const page = await (await fetch(`${t.base}/account/link?code=${made.code}`)).text();
        assert.ok(!stock.test(page), 'confirm page has no stock host');
        assert.equal((await (await fetch(`${t.base}/v2/create`)).json()).result.link.startsWith('https://tv.example/'), true);
    } finally { t.server.close(); t.a.close(); }
    t = await build('');
    try {
        const made = (await (await fetch(`${t.base}/api/v2/create`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'box.example' } })).json()).result;
        assert.ok(made.link.startsWith('https://box.example/account/link?code='), made.link);
    } finally { t.server.close(); t.a.close(); }
});

test('addonCollectionGet with update:true refreshes installed add-ons from public hosts only', async () => {
    const calls = [];
    const manifestV2 = { id: 'org.example.one', version: '2.0.0', name: 'One', resources: ['catalog'], types: ['movie'], catalogs: [{ type: 'movie', id: 'new' }] };
    const fetchImpl = async (url, init) => {
        calls.push(url);
        assert.equal(init.redirect, 'manual');
        return { ok: true, json: async () => (url.includes('one.example.com') ? manifestV2 : { id: 'wrong', name: 'x', version: '1' }) };
    };
    const resolveHost = async (host) => (host === 'internal.example.com' ? ['10.0.0.5'] : ['93.184.216.34']);
    let time = Date.now();
    const a = createAccounts({ dataFile: ':memory:', fetchImpl, resolveHost, defaultAddonUrls: () => [], registrationOpen: () => true, now: () => time });
    const reg = await a.handlers.register({ email: 'up@example.com', password: 'a-long-password', gdpr_consent: { tos: true, privacy: true } });
    const authKey = reg.result.authKey;
    const d = (host, id, version) => ({ transportUrl: `https://${host}/manifest.json`, transportName: 'http', flags: {}, manifest: { id, version, name: id, resources: ['catalog'], types: ['movie'], catalogs: [] } });
    await a.handlers.addonCollectionSet({ authKey, addons: [d('one.example.com', 'org.example.one', '1.0.0'), d('internal.example.com', 'org.example.int', '1.0.0'), d('two.example.com', 'org.example.two', '1.0.0'), { ...d('official.example.com', 'org.example.off', '1.0.0'), flags: { protected: true } }, { transportUrl: 'http://127.0.0.1:9/manifest.json', flags: {}, manifest: { id: 'loop', version: '1', name: 'loop' } }] });
    const before = (await a.handlers.addonCollectionGet({ authKey })).result;
    assert.equal(before.addons[0].manifest.version, '1.0.0', 'no refresh without update');
    time += 5000;
    const after = (await a.handlers.addonCollectionGet({ authKey, update: true })).result;
    assert.equal(after.addons[0].manifest.version, '2.0.0', 'newer manifest taken');
    assert.equal(after.addons[1].manifest.version, '1.0.0', 'private host never read');
    assert.equal(after.addons[2].manifest.version, '1.0.0', 'a manifest with a different id is refused');
    assert.equal(after.addons.length, 5);
    assert.ok(!calls.some((url) => url.includes('internal.example.com') || url.includes('127.0.0.1') || url.includes('official.example.com')), calls.join(' '));
    assert.ok(after.lastModified > before.lastModified, 'collection marked modified so apps pick it up');
    a.close();
});

test('a phone that is already signed in approves a device with its session key, no password; a wrong key is refused', async () => {
    const express = require('express');
    const a = createAccounts({ dataFile: ':memory:', fetchImpl: async () => { throw new Error('offline'); }, defaultAddonUrls: () => [], registrationOpen: () => true });
    const app = express();
    app.use('/api/v2', a.linkRouter);
    app.use('/account', a.pageRouter);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const reg = await a.handlers.register({ email: 'phone@example.com', password: 'a-long-password', gdpr_consent: { tos: true, privacy: true } });
        const phoneKey = reg.result.authKey;
        const post = (body) => fetch(`${base}/account/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const made = (await (await fetch(`${base}/api/v2/create`)).json()).result;
        assert.equal((await post({ code: made.code, authKey: 'z'.repeat(40) })).status, 401);
        assert.equal((await post({ code: 'NOSUCH', authKey: phoneKey })).status, 404);
        assert.equal((await post({ code: made.code, authKey: phoneKey })).status, 200);
        const read = (await (await fetch(`${base}/api/v2/read?code=${made.code}`)).json()).result;
        assert.ok(read.authKey && read.authKey !== phoneKey, 'the device gets its own key, not the phone key');
        const user = await a.handlers.getUser({ authKey: read.authKey });
        assert.equal(user.result.email, 'phone@example.com');
        assert.equal((await post({ code: made.code, authKey: phoneKey })).status, 404, 'a code works once');
        const page = await (await fetch(`${base}/account/link?code=${made.code}`)).text();
        assert.ok(page.includes('id="go"') && page.includes('id="other"') && page.includes("getItem('profile')"));
    } finally { server.close(); a.close(); }
});

test('link sign-in: a new person can register from the device page, and only a live code lets them', async () => {
    const express = require('express');
    const a = createAccounts({ dataFile: ':memory:', fetchImpl: async () => { throw new Error('offline'); }, defaultAddonUrls: () => [], registrationOpen: () => true });
    const app = express();
    app.use('/api/v2', a.linkRouter);
    app.use('/account', a.pageRouter);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const post = (body) => fetch(`${base}/account/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const makeCode = async () => (await (await fetch(`${base}/api/v2/create`)).json()).result;
        // A dead code never creates an account.
        assert.equal((await post({ code: 'NOSUCH', register: true, email: 'new@example.com', password: 'a-long-password', consent: true })).status, 404);
        // Register with consent -> the device is linked and collects a key.
        const made = await makeCode();
        assert.equal((await post({ code: made.code, register: true, email: 'new@example.com', password: 'a-long-password', consent: true })).status, 200);
        const read = (await (await fetch(`${base}/api/v2/read?code=${made.code}`)).json()).result;
        assert.ok(read.authKey, 'the device is signed in after registering');
        assert.equal((await a.handlers.getUser({ authKey: read.authKey })).result.email, 'new@example.com');
        // Without consent the account is not created.
        const made2 = await makeCode();
        assert.equal((await post({ code: made2.code, register: true, email: 'no@example.com', password: 'a-long-password', consent: false })).status, 400);
        // A duplicate email is refused.
        const made3 = await makeCode();
        assert.equal((await post({ code: made3.code, register: true, email: 'new@example.com', password: 'a-long-password', consent: true })).status, 409);
        // The page offers registration.
        const page = await (await fetch(`${base}/account/link?code=${made3.code}`)).text();
        assert.ok(page.includes('id="toggle"') && page.includes('Create an account'), 'the device page lets people register');
    } finally { server.close(); a.close(); }
});
