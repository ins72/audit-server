#!/usr/bin/env node
'use strict';
// End-to-end proof that the unmodified app signs up, signs in and stays signed in against OUR account service
// (OWN_ACCOUNTS=true), with nothing stubbed and no request to api.strem.io. Needs `webpack --mode production` first.
// Usage: node tools/e2e/accounts.js   (saves docs/screenshots/21-own-accounts-signup.png)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const freePort = () => new Promise((resolve) => { const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-own-'));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    // A product name set in the operator settings, as an operator would; everything else uses temporary files
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ values: { productName: 'Acme TV' } }));
    // A stand-in for Trakt: sign-in page that sends the person straight back, token exchange, one watchlist entry
    const http = require('http');
    const traktMock = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/oauth/authorize') {
            res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=mock-code&state=${url.searchParams.get('state')}` }).end();
        } else if (url.pathname === '/oauth/token') {
            res.setHeader('content-type', 'application/json').end(JSON.stringify({ access_token: 'mock-access', refresh_token: 'mock-refresh', created_at: Math.floor(Date.now() / 1000), expires_in: 7776000 }));
        } else if (url.pathname === '/sync/watchlist/movies') {
            res.setHeader('content-type', 'application/json').end(JSON.stringify([{ type: 'movie', movie: { title: 'Harbour Lights', year: 2024, ids: { imdb: 'tt0000101' } } }]));
        } else { res.setHeader('content-type', 'application/json').end('[]'); }
    });
    await new Promise((resolve) => traktMock.listen(0, '127.0.0.1', resolve));
    const traktBase = `http://127.0.0.1:${traktMock.address().port}`;
    const child = spawn('node', [path.join(ROOT, 'http_server.js')], {
        cwd: ROOT, stdio: 'ignore',
        env: {
            ...process.env, PORT: String(port), SESSION_SECRET: 'e'.repeat(40), ADMIN_TOKEN: 'x'.repeat(20), OWN_ACCOUNTS: 'true',
            ACCOUNTS_FILE: path.join(dir, 'accounts.db'), USERS_FILE: path.join(dir, 'u.json'), BILLING_FILE: path.join(dir, 'b.json'),
            STATS_FILE: path.join(dir, 's.json'), AUDIT_FILE: path.join(dir, 'a.log'), SETTINGS_FILE: path.join(dir, 'settings.json'), PLANS_FILE: path.join(dir, 'plans.json'), BRAND_DIR: path.join(dir, 'brand'),
            PUBLIC_URL: base, TRAKT_CLIENT_ID: 'cid', TRAKT_CLIENT_SECRET: 'secret', TRAKT_API_URL: traktBase, TRAKT_SITE_URL: traktBase
        }
    });
    for (let i = 0; i < 100; i += 1) {
        if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    const browser = await chromium.launch();
    let failed = null;
    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const seen = [];
        context.on('request', (r) => seen.push(r.url()));
        // An operator-written announcement (Settings in the operator panel) reaches the app as its remote config
        const saved = await fetch(`${base}/admin/settings`, { method: 'PUT', headers: { authorization: `Bearer ${'x'.repeat(20)}`, 'content-type': 'application/json' },
            body: JSON.stringify({ announcementTitle: 'New season is here', announcementBody: 'Fresh episodes land every Friday.', announcementButton: 'Great' }) });
        if (!saved.ok) throw new Error(`announcement not saved: ${saved.status}`);
        const remoteConfig = await (await fetch(`${base}/config`)).json();
        if (remoteConfig.notifications.items.length !== 1) throw new Error('remote config has no announcement');
        const page = await context.newPage();
        let authKey = null;
        context.on('response', async (r) => {
            if (r.url() === `${base}/api/register`) authKey = (await r.json().catch(() => ({}))).result?.authKey || authKey;
        });
        if (process.env.E2E_DEBUG) context.on('response', async (r) => { if (r.url().startsWith(`${base}/api/`)) console.log(r.request().method(), r.url(), r.status(), (await r.text().catch(() => '')).slice(0, 200)); });
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('text=Log in', { timeout: 30000 });
        await page.fill('input[type=email]', 'new.person@example.com');
        const passwords = page.locator('input[type=password]');
        await passwords.nth(0).fill('a-long-password');
        await passwords.nth(1).fill('a-long-password');
        // The boxes are custom controls: clicking the left edge of each label row toggles it (the links sit further right)
        for (const label of ['I have read and agree with the', 'I have read and agree with the']) { void label; }
        const rows = page.getByText('I have read and agree with the');
        for (let i = 0; i < await rows.count(); i += 1) await rows.nth(i).click({ position: { x: 4, y: 4 } });
        if (await page.getByText('Continue with Facebook').count() || await page.getByText('Continue with Apple').count()) throw new Error('social sign-in buttons still shown');
        await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshots', '21-own-accounts-signup.png') });
        await page.getByText('Sign up', { exact: true }).last().click();
        await page.waitForTimeout(3000);
        await page.screenshot({ path: '/tmp/own-after.png' });
        page.on('console', () => {});
        if (process.env.E2E_DEBUG) console.log('requests', seen.filter((u) => !u.startsWith('data:')).slice(-8));
        await page.waitForFunction(() => !document.querySelector('input[type=password]'), null, { timeout: 30000 });
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(path.join(dir, 'accounts.db'), { readOnly: true });
        const accountRows = db.prepare('SELECT email, password_hash FROM users').all();
        db.close();
        if (!accountRows.some((u) => u.email === 'new.person@example.com')) throw new Error(`account not stored: ${accountRows.map((u) => u.email)}`);
        if (accountRows.some((u) => u.password_hash.includes('a-long-password')) || !accountRows[0].password_hash.startsWith('scrypt$')) throw new Error('password not hashed');
        const stock = seen.filter((u) => /api\.strem\.io/.test(u));
        if (stock.length) throw new Error(`calls to the stock API: ${stock.slice(0, 3)}`);
        if (!seen.some((u) => u.startsWith(`${base}/api/`))) throw new Error('no call reached our /api');
        // Library and Continue Watching come from our database: put titles in through the API, reload, and they must show up
        const ISO = '2026-11-01T10:00:00.000Z';
        const item = (id, name, minutes) => ({
            _id: id, name, type: 'movie', poster: null, posterShape: 'poster', removed: false, temp: false, _ctime: ISO, _mtime: ISO,
            state: { lastWatched: ISO, timeWatched: minutes * 60000, timeOffset: minutes * 60000, overallTimeWatched: minutes * 60000, timesWatched: 0, flaggedWatched: 0, duration: 7200000, video_id: id, watched: null, noNotif: false },
            behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false }
        });
        const put = await fetch(`${base}/api/datastorePut`, { method: 'POST', body: JSON.stringify({ authKey, collection: 'libraryItem', changes: [item('tt0000101', 'Harbour Lights', 20), item('tt0000102', 'Night Train', 55)] }) });
        if (!(await put.json()).result?.success) throw new Error('library put failed');
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('text=Continue Watching', { timeout: 30000 });
        await page.waitForSelector('text=New season is here', { timeout: 20000 });
        await page.waitForTimeout(2000); // let the prompt finish fading in
        await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshots', '30-operator-announcement-in-app.png') });
        await page.getByText('Great', { exact: true }).click().catch(() => {});
        await page.waitForSelector('text=Harbour Lights', { timeout: 15000 });
        await page.waitForSelector('text=Night Train', { timeout: 15000 });
        await page.getByText('Later', { exact: true }).click({ timeout: 3000 }).catch(() => {}); // streaming-server banner: not part of this picture
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(ROOT, 'docs', 'screenshots', '26-continue-watching-own-library.png') });
        // Review pictures: the reset page (email is not configured here, so it says so) and the operator's account block
        const shots = path.join(ROOT, 'docs', 'screenshots');
        const reset = await context.newPage();
        await reset.goto(`${base}/account/reset?email=new.person@example.com`);
        await reset.getByText('Send link').click();
        await reset.waitForSelector('text=not set up');
        await reset.screenshot({ path: path.join(shots, '22-password-reset-page.png') });
        const manage = await context.newPage();
        await manage.goto(`${base}/account/manage`);
        await manage.fill('#e', 'new.person@example.com');
        await manage.fill('#p', 'wrong-password');
        await manage.getByText('Download my data').click();
        await manage.waitForSelector('text=Wrong email or password');
        await manage.screenshot({ path: path.join(shots, '24-account-manage-page.png') });
        // Settings: Integrations still exists (our calendar feed) but without Trakt; the feed address works
        await page.goto(`${base}/#/settings`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('text=Interface', { timeout: 20000 });
        if (!(await page.getByText('Integrations', { exact: true }).count())) throw new Error('Integrations page missing');
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(shots, '25-settings-own-accounts.png') });
        const calPath = (await (await fetch(`${base}/api/calendarToken`, { method: 'POST', body: JSON.stringify({ authKey }) })).json()).result.path;
        const feed = await fetch(`${base}${calPath}`);
        if (!feed.ok || !(await feed.text()).startsWith('BEGIN:VCALENDAR')) throw new Error('calendar feed not served');
        if ((await fetch(`${base}/calendar/${'a'.repeat(32)}.ics`)).status !== 404) throw new Error('unknown calendar token should be 404');
        await page.goto(`${base}/#/settings/integrations`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('text=Subscribe', { timeout: 20000 });
        await page.waitForSelector('text=Trakt');
        await page.screenshot({ path: path.join(shots, '27-integrations-own-calendar.png') });
        // Connect Trakt through our server: the app asks us for the sign-in address, the (fake) Trakt sends the person back
        const popupPromise = context.waitForEvent('page', { timeout: 15000 });
        await page.getByText('Authenticate', { exact: false }).first().click();
        const popup = await popupPromise;
        if (process.env.E2E_DEBUG) { popup.on('requestfailed', (r) => console.log('FAILED', r.url(), r.failure() && r.failure().errorText)); popup.on('response', (r) => console.log('RESP', r.status(), r.url())); }
        await popup.waitForLoadState('domcontentloaded');
        await popup.waitForTimeout(1500);
        if (process.env.E2E_DEBUG) console.log('popup', popup.url(), (await popup.innerText('body').catch(() => '')).slice(0, 200));
        await popup.waitForSelector('text=Trakt connected', { timeout: 15000 });
        await popup.close();
        await page.bringToFront();
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.waitForSelector('text=Disconnect', { timeout: 20000 });
        await page.screenshot({ path: path.join(shots, '28-trakt-connected.png') });
        // The Trakt add-on installs from our server and its watchlist shows on the board
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('text=Trakt watchlist', { timeout: 30000 });
        await page.getByText('Later', { exact: true }).click({ timeout: 3000 }).catch(() => {});
        await page.evaluate(() => document.querySelector('[class*="board"], main')?.scrollBy?.(0, 0));
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(shots, '29-trakt-catalog-on-board.png') });
        // Every link on the main screens must be free of Stremio hosts (own accounts, with a product name set)
        const offenders = [];
        for (const route of ['', '#/discover', '#/library', '#/calendar', '#/addons', '#/settings', '#/settings/player', '#/settings/streaming', '#/settings/account', '#/settings/help', '#/settings/subscription', '#/settings/shortcuts']) {
            await page.goto(`${base}/${route}`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1200);
            const hrefs = await page.$$eval('a[href]', (links) => links.map((link) => link.href));
            hrefs.filter((href) => /(strem\.io|stremio\.com|stremio\.zendesk)/i.test(href) && !/cinemeta/.test(href) && !/trakt%2Faddon/.test(href)).forEach((href) => offenders.push(`${route || '/'} -> ${href}`));
        }
        if (offenders.length) throw new Error(`Stremio links still visible:\n${[...new Set(offenders)].join('\n')}`);
        const stockAfter = seen.filter((u) => /\/\/(api|www)\.(strem\.io|stremio\.com)/.test(u));
        if (stockAfter.length) throw new Error(`calls to the stock site: ${stockAfter.slice(0, 3)}`);
        // Compatibility report: every call an app built for the stock API uses, against this server (tools/compat/check.js)
        const { run: compat } = require('./../compat/check');
        const report = await compat(base);
        const failedChecks = report.filter((r) => !r.ok);
        if (failedChecks.length) throw new Error(`compat check failed: ${JSON.stringify(failedChecks)}`);
        const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const reportPage = await context.newPage();
        await reportPage.setViewportSize({ width: 1100, height: 720 });
        await reportPage.setContent(`<body style="margin:0;background:#0c0b11;color:#f2f2f5;font:15px system-ui,sans-serif;padding:32px"><h1 style="margin:0 0 4px;font-size:24px">Stock API compatibility</h1>
<p style="color:#a9a8b3;margin:0 0 20px">${report.length}/${report.length} calls an app built for the Stremio API uses are answered in the same shape by this server. Only the address changes.</p>
${report.map((r) => `<div style="padding:7px 0;border-top:1px solid #23222b"><span style="color:#4ade80;font-weight:700;display:inline-block;width:56px">PASS</span>${esc(r.name)}</div>`).join('')}</body>`);
        await reportPage.screenshot({ path: path.join(shots, '31-stock-api-compatibility.png') });
        // The device side of link sign-in: a code and a QR to scan, the person confirms on their phone
        const created = (await (await fetch(`${base}/v2/create?type=Create`)).json()).result;
        const devicePage = await context.newPage();
        await devicePage.setViewportSize({ width: 900, height: 600 });
        await devicePage.setContent(`<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c0b11;color:#f2f2f5;font:18px system-ui,sans-serif;text-align:center">
<main><h1 style="font-size:28px;margin:0 0 8px">Sign in with your phone</h1><p style="color:#a9a8b3;margin:0 0 24px">Scan the code, or open the address and enter <b style="color:#f2f2f5;letter-spacing:3px">${created.code}</b></p>
<img src="${created.qrcode}" width="260" height="260" style="border-radius:12px"><p style="color:#a9a8b3;font-size:14px">${esc(created.link)}</p></main></body>`);
        await devicePage.screenshot({ path: path.join(shots, '32-link-signin-qr.png') });
        const confirmPage = await context.newPage();
        await confirmPage.goto(created.link);
        await confirmPage.locator('#other').click(); // signed in here: the password form is behind "Use another account"
        await confirmPage.fill('#e', 'new.person@example.com');
        await confirmPage.fill('#p', 'a-long-password');
        await confirmPage.getByRole('button', { name: 'Sign in the device', exact: true }).click();
        await confirmPage.waitForSelector('text=The device is signed in');
        const collected = await (await fetch(`${base}/v2/read?type=Read&code=${created.code}`)).json();
        if (!collected.result || !collected.result.authKey) throw new Error('device did not receive a key after confirmation');
        // QR sign-in inside the app itself: a "TV" browser with no session shows the code, the phone (already signed in here)
        // approves with one tap, and the TV signs in by itself. Everything must stay on our own address.
        const tv = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const tvSeen = [];
        tv.on('request', (r) => tvSeen.push(r.url()));
        const tvPage = await tv.newPage();
        await tvPage.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await tvPage.waitForSelector('text=Log in', { timeout: 30000 });
        await tvPage.getByText('Log in', { exact: true }).last().click();
        await tvPage.getByText('Sign in with QR code').click();
        await tvPage.waitForSelector('img[src^="data:image/svg+xml"]', { timeout: 15000 });
        const shownCode = (await tvPage.locator('text=/^[A-Z0-9]{6}$/').first().innerText()).trim();
        await tvPage.screenshot({ path: path.join(shots, '34-app-qr-login-code.png') });
        const phone = await context.newPage();
        await phone.setViewportSize({ width: 390, height: 700 });
        await phone.goto(`${base}/account/link?code=${shownCode}`);
        await phone.waitForSelector('#go:visible', { timeout: 10000 });
        const who = await phone.locator('#who').innerText();
        if (who !== 'new.person@example.com') throw new Error(`phone page shows ${who}`);
        await phone.screenshot({ path: path.join(shots, '35-phone-one-tap-approve.png') });
        await phone.locator('#go').click();
        await phone.waitForSelector('text=The device is signed in');
        await tvPage.waitForFunction(() => !/intro/.test(location.hash), null, { timeout: 30000 });
        await tvPage.waitForTimeout(1500);
        await tvPage.getByRole('button', { name: 'Great' }).click({ timeout: 3000 }).catch(() => {});
        await tvPage.waitForTimeout(800);
        await tvPage.screenshot({ path: path.join(shots, '36-app-signed-in-by-qr.png') });
        const tvStock = tvSeen.filter((u) => /strem\.io|stremio\.com/.test(u) && !/cinemeta|metahub/.test(u));
        if (tvStock.length) throw new Error(`QR sign-in touched the stock services: ${tvStock.slice(0, 3)}`);
        if (!tvSeen.some((u) => u.includes('/api/v2/create')) || !tvSeen.some((u) => u.includes('/api/loginWithToken'))) throw new Error('QR sign-in did not use our link service and loginWithToken');
        await tv.close();
        const panel = await context.newPage();
        await panel.setViewportSize({ width: 1280, height: 1000 });
        await panel.goto(`${base}/operator/#/person/new.person%40example.com`, { waitUntil: 'domcontentloaded' });
        await panel.locator('#token').fill('x'.repeat(20));
        await panel.locator('#load').click();
        await panel.waitForSelector('text=Account on our service', { timeout: 15000 });
        await panel.waitForTimeout(500);
        await panel.screenshot({ path: path.join(shots, '23-operator-person-account.png') });
        console.log('OK: signed up through our own /api, no api.strem.io traffic');
    } catch (e) {
        failed = e;
        if (process.env.E2E_DEBUG) console.log(await (await browser.contexts()[0].pages()[0]).innerText('body').catch(() => ''));
    } finally {
        await browser.close();
        const exited = new Promise((r) => child.once('exit', r));
        child.kill();
        traktMock.close();
        await exited;
        fs.rmSync(dir, { recursive: true, force: true });
    }
    if (failed) { console.error('FAIL:', failed.message); process.exit(1); }
})();
