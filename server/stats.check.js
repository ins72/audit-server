const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { createAuth } = require('./auth');
const { createStats } = require('./stats');

const DAY = 24 * 60 * 60 * 1000;

const setup = async (statsOptions = {}) => {
    const stremio = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const key = JSON.parse(body).authKey;
            res.end(JSON.stringify({ result: { _id: `id-${key}`, email: `${key}@example.com` } }));
        });
    });
    await new Promise((resolve) => stremio.listen(0, '127.0.0.1', resolve));
    let authRef;
    const stats = createStats({ listUsers: () => authRef.store.list(), ...statsOptions });
    const auth = createAuth({ secret: 's'.repeat(40), stremioApiUrl: `http://127.0.0.1:${stremio.address().port}`, adminToken: 'admintoken', stats });
    authRef = auth;
    const app = express();
    app.use('/auth', auth.router);
    app.use('/auth', stats.router(auth.requireSession));
    app.use('/admin', auth.admin);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = async (key, headers = {}) => {
        const response = await fetch(`${base}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ authKey: key }) });
        return response.headers.get('set-cookie').split(';')[0];
    };
    const report = (cookie, body) => fetch(`${base}/auth/activity`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    return { auth, stats, base, login, report, close: () => { server.close(); stremio.close(); } };
};

test('usage statistics', async (t) => {
    const s = await setup();
    t.after(s.close);

    const a = await s.login('a');
    await s.login('b');
    await s.login('a'); // same user from a second browser: a new login, still one active user

    await t.test('requires a session and always answers 204', async () => {
        assert.equal((await fetch(`${s.base}/auth/activity`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
        assert.equal((await s.report(a, { seconds: 'nope' })).status, 204);
    });

    await t.test('records watch time per user and per title, capping a single report', async () => {
        assert.equal((await s.report(a, { seconds: 60, type: 'movie', id: 'tt1', title: 'Film', start: true })).status, 204);
        assert.equal((await s.report(a, { seconds: 100000, type: 'movie', id: 'tt1', title: 'Film' })).status, 204);
        const summary = s.stats.summary(7);
        assert.equal(summary.totals.users, 2);
        assert.equal(summary.totals.everWatched, 1);
        assert.equal(summary.topUsers[0].email, 'a@example.com');
        assert.equal(summary.topUsers[0].hours, Math.round((60 + 120) / 36) / 100);
        assert.equal(summary.topContent[0].title, 'Film');
        assert.equal(summary.topContent[0].plays, 1);
        const today = summary.daily[summary.daily.length - 1];
        assert.equal(today.activeUsers, 2);
        assert.equal(today.logins, 3); // three sign-ins without a cookie (a, b, a on a new browser)
        assert.equal(today.watchers, 1);
    });

    await t.test('series episodes count towards one title', async () => {
        await s.report(a, { seconds: 30, type: 'series', id: 'tt9:1:1', title: 'Show', start: true });
        await s.report(a, { seconds: 30, type: 'series', id: 'tt9:1:2', title: 'Show' });
        const rows = s.stats.summary(1).topContent.filter((entry) => entry.id === 'tt9');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].hours, Math.round(60 / 36) / 100);
    });

    await t.test('strips control characters and bounds text', async () => {
        await s.report(a, { seconds: 5, type: 'movie', id: 'tt2', title: `Bad\u0000\nTitle${'x'.repeat(500)}` });
        const item = s.stats.summary(1).topContent.find((entry) => entry.id === 'tt2');
        assert.ok(item.title.startsWith('BadTitle'));
        assert.ok(item.title.length <= 200);
    });

    await t.test('bounce list: signed in over a day ago and never watched', async () => {
        const record = s.auth.store.list().find((user) => user.email === 'b@example.com');
        record.firstSeen -= 2 * DAY;
        const bounce = s.stats.summary(7).neverWatched;
        assert.deepEqual(bounce.map((row) => row.email), ['b@example.com']);
    });

    await t.test('derived metrics', async () => {
        const summary = s.stats.summary(7);
        assert.equal(summary.totals.activationPercent, 50);
        assert.equal(summary.totals.activeLast7d, 2);
        assert.equal(summary.byType[0].type, 'movie');
        assert.equal(summary.hoursOfDayUtc.length, 24);
        assert.ok(summary.daily[summary.daily.length - 1].newUsers >= 0);
        assert.ok(summary.totals.avgMinutesPerPlay >= 0);
    });

    await t.test('watch depth buckets', async () => {
        assert.deepEqual(s.stats.summary(1).watchDepth, { under1h: 1, from1to5h: 0, from5to20h: 0, over20h: 0 });
    });

    await t.test('commercial roles, conversion and stickiness', async () => {
        const summary = s.stats.summary(7, (user) => (user.email === 'a@example.com' ? 'owner' : 'none'));
        assert.deepEqual(summary.roles, { owner: 1, none: 1 });
        assert.equal(summary.conversionPercent, 50);
        assert.equal(summary.totals.activeLast30d, 2);
        assert.equal(summary.totals.stickinessPercent, 100);
        assert.equal(s.stats.summary(7).conversionPercent, null);
    });

    await t.test('keeps recent sign-in times per person', async () => {
        const detail = s.stats.userDetail('id-a');
        assert.equal(detail.recentLogins.length, 2);
        assert.ok(detail.recentLogins[0] >= detail.recentLogins[1], 'newest first');
        assert.ok(detail.watch.seconds > 0);
        assert.deepEqual(s.stats.userDetail('nobody'), { recentLogins: [], watch: null });
    });

    await t.test('rate limits floods from one user', async () => {
        let limited = 0;
        for (let i = 0; i < 30; i += 1) {
            if ((await s.report(a, { seconds: 1, type: 'movie', id: 'tt1' })).status === 429) limited += 1;
        }
        assert.ok(limited > 0);
    });

    await t.test('export includes watch stats and erase removes them', async () => {
        const headers = { authorization: 'Bearer admintoken', 'content-type': 'application/json' };
        const exported = await (await fetch(`${s.base}/admin/users/export?email=a@example.com`, { headers })).json();
        assert.equal(exported.watchStats.length, 1);
        assert.ok(exported.watchStats[0].seconds >= 180);
        const erased = await fetch(`${s.base}/admin/users/erase`, { method: 'POST', headers, body: JSON.stringify({ email: 'a@example.com' }) });
        assert.equal(erased.status, 200);
        assert.equal(s.stats.exportFor('id-a'), null);
        assert.equal(s.stats.data.days[Object.keys(s.stats.data.days)[0]].watchers.includes(s.stats.shortId('id-a')), false);
        assert.equal(s.stats.summary(7).daily.at(-1).activeUsers, 1, 'only b remains after erasing a');
    });
});

test('WATCH_STATS=false stores nothing', async (t) => {
    const s = await setup({ enabled: false });
    t.after(s.close);
    const cookie = await s.login('a');
    assert.equal((await s.report(cookie, { seconds: 30, type: 'movie', id: 'tt1', title: 'Film' })).status, 204);
    assert.equal(s.stats.summary(7).enabled, false);
    assert.equal(s.stats.summary(7).totals.hoursWatched, 0);
});

test('old days are compacted to counts and keep reporting', async () => {
    let clock = Date.parse('2026-01-01T12:00:00Z');
    const stats = createStats({ now: () => clock });
    stats.recordActive('x');
    stats.recordWatch('x', { seconds: 10, type: 'movie', contentId: 'tt1', title: 'F', start: true });
    clock += 40 * DAY;
    stats.recordActive('y'); // creating a new day compacts the old ones
    const first = stats.data.days['2026-01-01'];
    assert.equal(first.active, undefined);
    assert.equal(first.activeCount, 1);
    assert.equal(first.watchersCount, 1);
    const series = stats.summary(60).daily;
    assert.equal(series.find((entry) => entry.day === '2026-01-01').activeUsers, 1);
    assert.equal(series.find((entry) => entry.day === '2026-01-01').watchers, 1);
    assert.equal(stats.erase('x'), true); // erasing must not trip over compacted days
});

test('day-N retention and at-risk payers', async () => {
    const start = Date.parse('2026-03-01T12:00:00Z');
    let clock = start;
    const users = [
        { id: 'r', email: 'r@example.com', firstSeen: start, lastSeen: start + 8 * DAY, logins: 2 },
        { id: 'g', email: 'g@example.com', firstSeen: start, lastSeen: start, logins: 1 },
        { id: 'p', email: 'p@example.com', firstSeen: start, lastSeen: start, logins: 1 }
    ];
    const stats = createStats({ now: () => clock, listUsers: () => users });
    ['r', 'g', 'p'].forEach((id) => stats.recordActive(id, { login: true }));
    clock = start + DAY;
    stats.recordActive('r'); // returned on day 1; g and p did not
    clock = start + 20 * DAY;
    const summary = stats.summary(30, (user) => (user.id === 'p' ? 'owner' : 'none'));
    assert.deepEqual(summary.retention.day1, { eligible: 3, returned: 1, percent: 33 });
    assert.equal(summary.retention.day7.returned, 0);
    assert.deepEqual(summary.atRisk.map((row) => [row.email, row.role]), [['p@example.com', 'owner']]);
});

test('week-over-week trends', async () => {
    let clock = Date.parse('2026-03-20T12:00:00Z');
    const base = clock;
    const stats = createStats({ now: () => clock, listUsers: () => [] });
    stats.recordWatch('a', { seconds: 3600, type: 'movie', contentId: 'tt1', title: 'F', start: true }); // today
    clock = base - 8 * DAY;
    stats.recordWatch('a', { seconds: 1800, type: 'movie', contentId: 'tt1', title: 'F' }); // previous week
    stats.recordActive('a', { login: true });
    clock = base;
    const { trends } = stats.summary(7);
    assert.deepEqual(trends.hoursWatched, [1, 0.5, 100]);
    assert.deepEqual(trends.logins, [0, 1, -100]);
    assert.equal(trends.newUsers[2], null);
});

test('device profile, playback quality, sources and add-ons', async (t) => {
    const s = await setup();
    t.after(s.close);
    const phone = await s.login('p', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'accept-language': 'th-TH,th;q=0.9' });
    await s.login('d', { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120', 'accept-language': 'en-US' });
    await s.login('t', { 'user-agent': 'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 Chrome/94 TV Safari/537.36' });

    await s.report(phone, { seconds: 60, type: 'movie', id: 'tt1', title: 'F', start: true, source: 'torrent', addon: 'Addon.Example.com' });
    await s.report(phone, { seconds: 60, type: 'movie', id: 'tt1', title: 'F', completed: true, source: 'torrent', addon: 'addon.example.com' });
    await s.report(phone, { seconds: 60, type: 'movie', id: 'tt1', title: 'F', start: true, source: 'http', addon: 'https://evil.example/path?token=secret' }); // not a bare host: ignored
    await s.report(phone, { event: 'error', code: 'StreamFailed', critical: true, type: 'movie', id: 'tt1', source: 'torrent', addon: 'addon.example.com' });
    await s.report(phone, { event: 'error', code: 'Other', type: 'movie', id: 'tt1', source: 'bogus' });

    const summary = s.stats.summary(7);
    const names = (list) => list.map((entry) => `${entry.name}:${entry.count}`).sort();
    assert.deepEqual(names(summary.devices.os), ['Linux:1', 'Windows:1', 'iOS:1']);
    assert.deepEqual(names(summary.devices.form), ['desktop:1', 'phone:1', 'tv:1']);
    assert.ok(names(summary.devices.browser).includes('Edge:1'));
    assert.deepEqual(names(summary.devices.language), ['en:1', 'th:1', 'unknown:1']);
    assert.equal(summary.playback.plays, 2);
    assert.equal(summary.playback.completions, 1);
    assert.equal(summary.playback.completionPercent, 50);
    assert.equal(summary.playback.errors, 2);
    assert.equal(summary.playback.criticalErrors, 1);
    assert.equal(summary.playback.errorsPer100Plays, 100);
    assert.deepEqual(summary.bySource.map((e) => [e.name, e.plays, e.errors]), [['torrent', 1, 1], ['http', 1, 0]]);
    assert.equal(summary.byAddon.length, 1, 'only the bare host was accepted, lowercased');
    assert.equal(summary.byAddon[0].name, 'addon.example.com');
    assert.equal(summary.byAddon[0].errors, 1);
    assert.deepEqual(summary.errorCodes.map((e) => e.code).sort(), ['Other', 'StreamFailed']);
    assert.equal(summary.topContent[0].completionPercent, 50);
    assert.equal(summary.topContent[0].errors, 2);
    assert.equal(JSON.stringify(s.stats.data).includes('secret'), false, 'add-on paths and tokens are never stored');
});

test('upgrade funnel counts distinct viewers and repeat views', () => {
    const stats = createStats({ listUsers: () => [] });
    const funnel = () => stats.summary(7).upgrade;
    assert.deepEqual(funnel(), { seen: 0, converted: 0, views: 0, conversionPercent: null });
    // One person sees the dialog three times: still one viewer, three views.
    stats.recordUpgradeSeen('u1');
    stats.recordUpgradeSeen('u1');
    stats.recordUpgradeSeen('u1');
    stats.recordUpgradeSeen('u2'); // a second person sees it once
    const mid = funnel();
    assert.equal(mid.seen, 2, 'distinct viewers');
    assert.equal(mid.views, 4, 'total views, including repeats');
    assert.equal(mid.converted, 0);
    assert.equal(mid.conversionPercent, 0);
    // Only a viewer who later upgrades counts as converted.
    stats.markUpgradeConverted('u1');
    const done = funnel();
    assert.equal(done.converted, 1);
    assert.equal(done.conversionPercent, 50, '1 of 2 viewers upgraded');
});
