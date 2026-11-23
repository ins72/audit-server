'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createTrakt } = require('./trakt');
const { createAccounts } = require('./accounts');

const NOW = Date.parse('2026-11-21T12:00:00Z');
const fakeAccounts = () => {
    const records = {};
    return { records, traktRecord: (id) => records[id] || null, setTraktRecord: (id, record) => { records[id] = record; } };
};
const fakeTrakt = (answers = {}) => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const path = url.replace('https://api.trakt.tv', '');
        calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: (init.headers || {}).authorization });
        const answer = answers[path.split('?')[0]];
        if (answer === undefined) return { ok: false, status: 404, json: async () => null };
        return { ok: true, status: 200, json: async () => (typeof answer === 'function' ? answer(JSON.parse(init.body || 'null')) : answer) };
    };
    return { calls, fetchImpl };
};
const options = (extra) => ({ clientId: 'cid', clientSecret: 'secret', publicUrl: 'https://tv.example', now: () => NOW, ...extra });

test('disabled without a Trakt app', () => {
    const trakt = createTrakt({ accounts: fakeAccounts() });
    assert.equal(trakt.enabled, false);
    assert.equal(trakt.startUrl('u1'), null);
});

test('connect: state is single use, tokens kept, refresh token never sent to the app', async () => {
    const accounts = fakeAccounts();
    const { calls, fetchImpl } = fakeTrakt({ '/oauth/token': { access_token: 'A1', refresh_token: 'R1', created_at: NOW / 1000, expires_in: 7776000 } });
    const trakt = createTrakt(options({ accounts, fetchImpl }));
    const url = new URL(trakt.startUrl('u1'));
    assert.equal(url.origin + url.pathname, 'https://trakt.tv/oauth/authorize');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://tv.example/trakt/callback');
    const state = url.searchParams.get('state');
    const app = express();
    app.use('/trakt', trakt.router);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/trakt`;
    try {
        assert.equal((await fetch(`${base}/callback?code=abc&state=wrong`)).status, 400);
        assert.equal((await fetch(`${base}/callback?code=abc&state=${state}`)).status, 200);
        assert.equal((await fetch(`${base}/callback?code=abc&state=${state}`)).status, 400);
        assert.equal(accounts.records.u1.refresh_token, 'R1');
        assert.equal(calls[0].body.grant_type, 'authorization_code');
        assert.equal(calls[0].body.client_secret, 'secret');
    } finally {
        server.close();
    }
});

test('access token is refreshed shortly before it expires', async () => {
    const accounts = fakeAccounts();
    accounts.records.u1 = { access_token: 'OLD', refresh_token: 'R1', created_at: NOW / 1000 - 7776000 + 3600, expires_in: 7776000 };
    const { fetchImpl } = fakeTrakt({ '/oauth/token': { access_token: 'NEW', refresh_token: 'R2', created_at: NOW / 1000, expires_in: 7776000 } });
    const trakt = createTrakt(options({ accounts, fetchImpl }));
    assert.equal(await trakt.accessToken('u1'), 'NEW');
    assert.equal(accounts.records.u1.refresh_token, 'R2');
    const dead = createTrakt(options({ accounts: Object.assign(fakeAccounts(), { records: {} }), fetchImpl: async () => ({ ok: false, status: 401 }) }));
    assert.equal(await dead.accessToken('nobody'), null);
});

test('catalogs: watchlist and recommendations need the link, trending is public, ids are imdb ids', async () => {
    const accounts = fakeAccounts();
    accounts.records.u1 = { access_token: 'A1', refresh_token: 'R1', created_at: NOW / 1000, expires_in: 7776000 };
    const { calls, fetchImpl } = fakeTrakt({
        '/sync/watchlist/movies': [{ type: 'movie', movie: { title: 'Heat', year: 1995, ids: { imdb: 'tt0113277' } } }, { type: 'movie', movie: { title: 'No id', ids: {} } }],
        '/movies/trending': [{ watchers: 9, movie: { title: 'Trendy', year: 2026, ids: { imdb: 'tt9999999' } } }]
    });
    const trakt = createTrakt(options({ accounts, fetchImpl }));
    const app = express();
    app.use('/trakt', trakt.router);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/trakt/addon`;
    try {
        const manifest = await (await fetch(`${base}/u1/manifest.json`)).json();
        assert.equal(manifest.catalogs.length, 6);
        assert.equal((await fetch(`${base}/stranger/manifest.json`)).status, 404);
        const list = await (await fetch(`${base}/u1/catalog/movie/trakt.watchlist.json`)).json();
        assert.deepEqual(list.metas.map((meta) => meta.id), ['tt0113277']);
        assert.equal(calls.find((call) => call.path === '/sync/watchlist/movies').auth, 'Bearer A1');
        const trending = await (await fetch(`${base}/u1/catalog/movie/trakt.trending.json`)).json();
        assert.equal(trending.metas[0].name, 'Trendy');
        assert.equal(calls.find((call) => call.path.startsWith('/movies/trending')).auth, undefined);
        assert.equal((await fetch(`${base}/u1/catalog/movie/trakt.nope.json`)).status, 404);
        assert.equal((await fetch(`${base}/u1/catalog/music/trakt.watchlist.json`)).status, 404);
    } finally {
        server.close();
    }
});

test('history: finished recent titles only, each once, shows as season and episode', async () => {
    const accounts = fakeAccounts();
    accounts.records.u1 = { access_token: 'A1', refresh_token: 'R1', created_at: NOW / 1000, expires_in: 7776000 };
    const { calls, fetchImpl } = fakeTrakt({ '/sync/history': {} });
    const trakt = createTrakt(options({ accounts, fetchImpl }));
    const recent = new Date(NOW - 3600 * 1000).toISOString();
    const state = (offset, extra = {}) => ({ lastWatched: recent, timeOffset: offset, duration: 1000, video_id: 'tt2:1:3', ...extra });
    const items = [
        { _id: 'tt1', type: 'movie', state: state(900) },
        { _id: 'tt3', type: 'movie', state: state(100) }, // barely started
        { _id: 'tt4', type: 'movie', state: state(900, { lastWatched: new Date(NOW - 30 * 24 * 3600 * 1000).toISOString() }) }, // old
        { _id: 'tt2', type: 'series', state: state(950) },
        { _id: 'custom-id', type: 'movie', state: state(950) } // not an imdb title
    ];
    await trakt.onLibraryChange('u1', items);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.movies.map((movie) => movie.ids.imdb), ['tt1']);
    assert.deepEqual(calls[0].body.shows[0], { ids: { imdb: 'tt2' }, seasons: [{ number: 1, episodes: [{ number: 3, watched_at: recent }] }] });
    await trakt.onLibraryChange('u1', items);
    assert.equal(calls.length, 1);
    await trakt.onLibraryChange('nobody', items);
    assert.equal(calls.length, 1);
});

test('accounts: the app only sees a safe Trakt record and can only disconnect it', async () => {
    const accounts = createAccounts({ dataFile: ':memory:' });
    const { authKey, user } = (await accounts.handlers.register({ email: 't@example.com', password: 'password1', gdpr_consent: { tos: true, privacy: true } }, {})).result;
    assert.equal((await accounts.handlers.traktAuthUrl({ authKey })).error.code, 107);
    const revoked = [];
    const { fetchImpl } = fakeTrakt({ '/oauth/revoke': {} });
    const trakt = createTrakt(options({ accounts, fetchImpl: async (url, init) => { revoked.push(url); return fetchImpl(url, init); } }));
    accounts.attachTrakt(trakt);
    assert.match((await accounts.handlers.traktAuthUrl({ authKey })).result.url, /^https:\/\/trakt\.tv\/oauth\/authorize/);
    accounts.setTraktRecord(user._id, { access_token: 'A1', refresh_token: 'SECRET', created_at: 1, expires_in: 2 });
    assert.deepEqual((await accounts.handlers.getUser({ authKey })).result.trakt, { created_at: 1, expires_in: 2, access_token: 'A1' });
    assert.ok(!JSON.stringify((await accounts.handlers.login({ email: 't@example.com', password: 'password1' }, {})).result).includes('SECRET'));
    await accounts.handlers.saveUser({ authKey, trakt: { access_token: 'forged', created_at: 1, expires_in: 99999999999 } });
    assert.equal(accounts.traktRecord(user._id).access_token, 'A1');
    await accounts.handlers.saveUser({ authKey, trakt: null });
    assert.equal(accounts.traktRecord(user._id), null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(revoked.some((url) => url.endsWith('/oauth/revoke')));
});
