#!/usr/bin/env node
'use strict';
// Compatibility check for the account service: does a server answer the calls an app built for the stock Stremio API makes,
// in the same shapes? Run it against any base address (your own server before you point apps at it):
//   node tools/compat/check.js https://tv.example.com
// It signs up a throw-away account, uses every route, and deletes the account again. Exit code 1 when anything fails.

const run = async (base) => {
    const root = base.replace(/\/+$/, '');
    const results = [];
    const check = async (name, work) => {
        try {
            const detail = await work();
            results.push({ name, ok: true, detail: detail || '' });
        } catch (e) {
            results.push({ name, ok: false, detail: e.message });
        }
    };
    const expect = (condition, message) => { if (!condition) throw new Error(message); };
    const post = async (name, body) => {
        const response = await fetch(`${root}/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: name, ...body }) });
        expect(response.status === 200, `HTTP ${response.status}`);
        return response.json();
    };
    const ok = (reply) => { expect(reply && reply.result !== undefined && !reply.error, `expected a result, got ${JSON.stringify(reply).slice(0, 120)}`); return reply.result; };
    const failed = (reply) => { expect(reply && reply.error && typeof reply.error.message === 'string' && typeof reply.error.code === 'number', `expected {error:{message,code}}, got ${JSON.stringify(reply).slice(0, 120)}`); return reply.error; };

    const email = `compat-${Date.now().toString(36)}@example.com`;
    const password = 'compat-check-password';
    const consent = { tos: true, privacy: true, marketing: false, from: 'compat' };
    let authKey = '';
    let userId = '';
    const iso = '2026-01-01T00:00:00.000Z';
    const item = { _id: 'tt0000001', name: 'Compat Check', type: 'movie', poster: null, posterShape: 'poster', removed: false, temp: false, _ctime: iso, _mtime: iso, state: { lastWatched: iso, timeWatched: 1, timeOffset: 1, overallTimeWatched: 1, timesWatched: 0, flaggedWatched: 0, duration: 100, video_id: null, watched: null, noNotif: false }, behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false } };

    await check('register returns authKey and user with consent', async () => {
        const result = ok(await post('register', { email, password, gdpr_consent: consent }));
        expect(typeof result.authKey === 'string' && result.authKey.length > 10, 'no authKey');
        expect(result.user && typeof result.user._id === 'string' && result.user.email === email, 'user shape');
        expect(result.user.gdpr_consent && result.user.gdpr_consent.tos === true, 'gdpr_consent missing');
        authKey = result.authKey;
        userId = result.user._id;
    });
    await check('register twice with one email is an error', async () => `code ${failed(await post('register', { email, password, gdpr_consent: consent })).code}`);
    await check('login with a wrong password is an error', async () => `code ${failed(await post('login', { email, password: 'not-the-password' })).code}`);
    await check('login returns authKey and user', async () => { const result = ok(await post('login', { email, password })); expect(typeof result.authKey === 'string' && result.user._id === userId, 'shape'); });
    await check('getUser', async () => { expect(ok(await post('getUser', { authKey }))._id === userId, 'wrong user'); });
    await check('getUser with a bad key is an error', async () => `code ${failed(await post('getUser', { authKey: 'bad-key-bad-key-bad-key-bad' })).code}`);
    await check('saveUser', async () => { expect(ok(await post('saveUser', { authKey, avatar: null, gdpr_consent: consent })).success === true, 'no success'); });
    await check('addonCollectionGet', async () => { const result = ok(await post('addonCollectionGet', { authKey, update: true })); expect(Array.isArray(result.addons) && typeof result.lastModified === 'string', 'shape'); });
    await check('addonCollectionSet then Get', async () => {
        const addon = { manifest: { id: 'compat.addon', version: '1.0.0', name: 'Compat', resources: ['catalog'], types: ['movie'], catalogs: [] }, transportUrl: 'https://example.com/manifest.json', flags: { official: false, protected: false } };
        expect(ok(await post('addonCollectionSet', { authKey, addons: [addon] })).success === true, 'no success');
        const back = ok(await post('addonCollectionGet', { authKey, update: false }));
        expect(back.addons.length === 1 && back.addons[0].transportUrl === addon.transportUrl, 'not stored');
    });
    await check('datastorePut / Meta / Get (libraryItem)', async () => {
        expect(ok(await post('datastorePut', { authKey, collection: 'libraryItem', changes: [item] })).success === true, 'put');
        const meta = ok(await post('datastoreMeta', { authKey, collection: 'libraryItem' }));
        expect(Array.isArray(meta) && meta.some((pair) => pair[0] === item._id && typeof pair[1] === 'number'), 'meta');
        const got = ok(await post('datastoreGet', { authKey, collection: 'libraryItem', ids: [item._id], all: false }));
        expect(Array.isArray(got) && got[0] && got[0].name === item.name, 'get');
        expect(ok(await post('datastoreGet', { authKey, collection: 'libraryItem', ids: [], all: true })).length === 1, 'get all');
    });
    await check('events, seekLog, configEvents, getSkipGaps, getModal, getGeo are accepted', async () => {
        for (const name of ['events', 'seekLog', 'configEvents', 'getSkipGaps', 'getModal', 'getGeo']) {
            const reply = await post(name, { authKey, events: [], platform: 'compat', itemId: 'tt1', videoId: 'tt1', from: 1, to: 2 });
            expect(reply && (reply.result !== undefined || reply.error), `${name}: no result`);
        }
    });
    await check('unknown route answers in the error shape', async () => `code ${failed(await post('doesNotExist', {})).code}`);
    await check('CORS preflight on /api', async () => {
        const response = await fetch(`${root}/api/login`, { method: 'OPTIONS', headers: { origin: 'https://other.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
        expect(response.status === 204 && response.headers.get('access-control-allow-origin') === '*', `status ${response.status}`);
    });
    await check('remote config (GET /config)', async () => {
        const config = await (await fetch(`${root}/config`)).json();
        expect(config && typeof config === 'object' && 'notifications' in config && 'client' in config, 'shape');
    });
    await check('ratings: send then get_status', async () => {
        const sent = await (await fetch(`${root}/likes/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authToken: authKey, mediaId: 'tt0000001', mediaType: 'movie', status: 'liked' }) })).json();
        expect(sent.rating && sent.rating.status === 'liked', 'send');
        const status = await (await fetch(`${root}/likes/api/get_status?authToken=${authKey}&mediaId=tt0000001&mediaType=movie`)).json();
        expect(status.status === 'liked', 'get_status');
    });
    await check('link sign-in: create gives code, link and QR; read waits', async () => {
        const created = ok(await (await fetch(`${root}/v2/create?type=Create`)).json());
        expect(created.code && created.link.includes(created.code) && created.qrcode.startsWith('data:image/svg+xml'), 'create shape');
        failed(await (await fetch(`${root}/v2/read?type=Read&code=${created.code}`)).json());
    });
    await check('loginWithToken', async () => { expect(ok(await post('loginWithToken', { token: authKey })).user._id === userId, 'shape'); });
    await check('dataExport gives an address that downloads', async () => {
        const { exportId } = ok(await post('dataExport', { authKey }));
        const data = await (await fetch(`${root}/data-export/${exportId}/export.json`)).json();
        expect(data.user && data.user.email === email && Array.isArray(data.library), 'export shape');
    });
    await check('logout ends the key', async () => {
        const second = ok(await post('login', { email, password })).authKey;
        expect(ok(await post('logout', { authKey: second })).success === true, 'logout');
        failed(await post('getUser', { authKey: second }));
    });
    await check('deleteUser removes the account', async () => {
        failed(await post('deleteUser', { authKey, password: 'wrong-password' }));
        expect(ok(await post('deleteUser', { authKey, password })).success === true, 'delete');
        failed(await post('login', { email, password }));
    });
    return results;
};

module.exports = { run };

if (require.main === module) {
    const base = process.argv[2];
    if (!base) { console.error('Usage: node tools/compat/check.js <base address, e.g. https://tv.example.com>'); process.exit(2); }
    run(base).then((results) => {
        results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`));
        const failures = results.filter((r) => !r.ok).length;
        console.log(`\n${results.length - failures}/${results.length} passed`);
        process.exit(failures ? 1 : 0);
    });
}
