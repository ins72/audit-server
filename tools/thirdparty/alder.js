#!/usr/bin/env node
'use strict';
// Replays the exact calls Alder (Android TV client for Stremio accounts, github.com/aradhyas8/Alder, Stremio.kt) makes,
// with its two base addresses switched to ours: API = <base>/api/, LINK = <base>/api/v2/. Usage: node tools/thirdparty/alder.js <base>
const base = (process.argv[2] || 'http://localhost:8080').replace(/\/+$/, '');
const API = base + '/api/', LINK = base + '/api/v2/';
let fails = 0;
const step = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const post = async (m, body) => (await fetch(API + m, { method: 'POST', body: JSON.stringify(body) })).json(); // Alder sends no content-type
const get = async (u) => (await fetch(u)).json();
(async () => {
    const email = `alder-${Date.now().toString(36)}@example.com`, password = 'alder-test-password';
    const reg = await post('register', { type: 'Register', email, password, gdpr_consent: { tos: true, privacy: true, marketing: false, from: 'web' } });
    const authKey = reg.result && reg.result.authKey;
    step('account for the test (sign-up on our page)', !!authKey);
    // TV sign-in
    const c = await get(LINK + 'create?type=Create');
    step('createLink: result.code + result.link', c.result && c.result.code && c.result.link, c.result && c.result.link);
    const w = await get(LINK + 'read?type=Read&code=' + encodeURIComponent(c.result.code));
    step('readLink while waiting answers error code 101 (Alder treats as "not yet")', w.error && w.error.code === 101);
    // confirm on the phone page (same call the page makes)
    const conf = await fetch(new URL(c.result.link).pathname.replace(/^\/?/, base + '/') + '', { redirect: 'manual' }).catch(() => null);
    step('link page opens', conf && conf.status === 200);
    const k = await (await fetch(base + '/account/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.result.code, email, password }) })).json().catch(() => ({}));
    const r = await get(LINK + 'read?type=Read&code=' + encodeURIComponent(c.result.code));
    step('readLink after approval gives result.authKey', r.result && typeof r.result.authKey === 'string', JSON.stringify(k).slice(0, 60));
    const key = (r.result && r.result.authKey) || authKey;
    // addons
    let a = await post('addonCollectionGet', { type: 'AddonCollectionGet', authKey: key, update: true });
    if (a.result && a.result.addons.length === 0) {
        console.log('NOTE  no default add-ons on this server (operator setting "defaultAddons"); seeding two for the test');
        const d = (n) => ({ transportUrl: `https://${n}.example.com/manifest.json`, transportName: 'http', flags: {}, manifest: { id: n, version: '1.0.0', name: n, resources: ['catalog'], types: ['movie'], catalogs: [] } });
        await post('addonCollectionSet', { type: 'AddonCollectionSet', authKey: key, addons: [d('one'), d('two')] });
        a = await post('addonCollectionGet', { type: 'AddonCollectionGet', authKey: key, update: true });
    }
    step('addonCollectionGet: result.addons[] with descriptors', a.result && Array.isArray(a.result.addons) && a.result.addons.length > 0 && a.result.addons[0].transportUrl && a.result.addons[0].manifest, `${a.result && a.result.addons.length} add-ons`);
    const s = await post('addonCollectionSet', { type: 'AddonCollectionSet', authKey: key, addons: a.result.addons.slice().reverse() });
    const a2 = await post('addonCollectionGet', { type: 'AddonCollectionGet', authKey: key, update: true });
    step('addonCollectionSet keeps the new order', a2.result.addons[0].transportUrl === a.result.addons[a.result.addons.length - 1].transportUrl && !s.error);
    // library
    const iso = new Date().toISOString();
    const item = { _id: 'tt0111161', name: 'Test', type: 'movie', poster: null, posterShape: 'poster', removed: false, temp: false, _ctime: iso, _mtime: iso, state: { lastWatched: iso, timeWatched: 600, timeOffset: 600, overallTimeWatched: 600, timesWatched: 0, flaggedWatched: 0, duration: 7200, video_id: null, watched: null, noNotif: false }, behaviorHints: {} };
    const put = await post('datastorePut', { authKey: key, collection: 'libraryItem', changes: [item] });
    step('datastorePut (changes)', !put.error);
    const all = await post('datastoreGet', { authKey: key, collection: 'libraryItem', ids: [], all: true });
    step('datastoreGet all:true returns the item', Array.isArray(all.result) && all.result.some((x) => x._id === 'tt0111161' && x.state.timeOffset === 600));
    const one = await post('datastoreGet', { authKey: key, collection: 'libraryItem', ids: ['tt0111161'], all: false });
    step('datastoreGet by ids', Array.isArray(one.result) && one.result.length === 1);
    const none = await post('datastoreGet', { authKey: key, collection: 'libraryItem', ids: ['tt9999999'], all: false });
    step('datastoreGet unknown id gives empty list', Array.isArray(none.result) && none.result.length === 0);
    // identity and sign-out
    const u = await post('getUser', { type: 'GetUser', authKey: key });
    step('getUser result._id', u.result && typeof u.result._id === 'string');
    await post('logout', { type: 'Logout', authKey: key });
    const gone = await post('getUser', { type: 'GetUser', authKey: key });
    step('after logout getUser answers error code 1 (Alder NO_SESSION)', gone.error && gone.error.code === 1, gone.error && String(gone.error.code));
    await post('deleteUser', { authKey, password });
    console.log(fails ? `\n${fails} step(s) differ` : '\nAll steps behave as Alder expects');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
