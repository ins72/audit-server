#!/usr/bin/env node
'use strict';
// Drives the production build in headless Chromium against a stubbed Stremio API and saves screenshots
// to docs/screenshots/. Needs `pnpm build` first and Playwright (`npm i -g playwright` or a local install).
// Usage: node tools/e2e/capture.js [only-scenario-name]   (E2E_SCALE=2 for marketing-grade 2x images, E2E_DEBUG=1 to log core requests)
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const ADMIN = 'e2e-admin-token';
const only = process.argv[2];

const USER = { _id: 'u-demo', email: 'demo@example.com', fbId: null, appleId: null, avatar: null, lastModified: new Date().toISOString(), dateRegistered: '2024-01-01T00:00:00.000Z', premium_expire: null, trakt: null, gdpr_consent: { tos: true, privacy: true, marketing: false, from: 'web' } };
const ISO = '2026-11-01T10:00:00.000Z';
const poster = (hue, label) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="hsl(${hue},55%,35%)"/><text x="150" y="225" font-size="30" fill="white" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`);
const DEMO_LIBRARY = [['tt0000001', 'Demo Movie One', 'movie', 260], ['tt0000002', 'Demo Series Two', 'series', 20], ['tt0000003', 'Demo Movie Three', 'movie', 150]].map(([id, name, type, hue], i) => ({
    _id: id, name, type, poster: poster(hue, name), posterShape: 'poster', removed: false, temp: false, _ctime: ISO, _mtime: ISO,
    state: { lastWatched: ISO, timeWatched: 600000 * (i + 1), timeOffset: 600000 * (i + 1), overallTimeWatched: 600000 * (i + 1), timesWatched: 0, flaggedWatched: 0, duration: 7200000, video_id: id, watched: null, noNotif: false }, behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false }
}));
// A fake catalog add-on served by the stub itself, so the Home board has titles without any network access.
let stubPort = 0;
const DEMO_METAS = (type) => [['Demo Movie One', 260], ['Demo Movie Three', 150], ['Night Train', 330], ['Harbour Lights', 40], ['The Quiet Valley', 190], ['Paper Moons', 300], ['Last Signal', 10], ['Golden Hour', 55]].map(([name, hue], i) => ({
    id: `tt10000${i}${type === 'movie' ? 'm' : 's'}`, type, name: type === 'series' ? name.replace(/^The /, '') + ' (series)' : name, poster: poster(hue, name), posterShape: 'poster', releaseInfo: String(2015 + i), imdbRating: String(6 + (i % 4) + 0.5), genres: ['Drama']
}));
const ADDON_MANIFEST = () => ({
    id: 'org.example.demo', version: '1.0.0', name: 'Demo Catalog', description: 'Offline demo catalog used for screenshots', types: ['movie', 'series'], resources: ['catalog'], idPrefixes: ['tt'],
    catalogs: [{ type: 'movie', id: 'top', name: 'Popular' }, { type: 'series', id: 'top', name: 'Popular' }]
});
const demoAddons = () => [{
    manifest: ADDON_MANIFEST(), transportUrl: `http://127.0.0.1:${stubPort}/addon/manifest.json`, flags: { official: false, protected: false }
}];
const json = (res, body) => { res.setHeader('content-type', 'application/json'); res.setHeader('access-control-allow-origin', '*'); res.end(JSON.stringify(body)); };
const stremioReply = (apiPath, body) => {
    switch (apiPath) {
        case 'login': case 'register': case 'loginWithToken': return { result: { authKey: 'demo-key', user: USER } };
        case 'getUser': {
            // authKeys like "seed-anna" sign in as anna@example.com so the operator panel can be shown with a crowd
            let key = '';
            try { key = JSON.parse(body || '{}').authKey || ''; } catch (_e) { /* ignore */ }
            return { result: key.startsWith('seed-') ? { ...USER, _id: `u-${key}`, email: `${key.slice(5)}@example.com` } : USER };
        }
        case 'addonCollectionGet': return { result: { addons: demoAddons(), lastModified: new Date().toISOString() } };
        case 'datastoreMeta': return { result: [] };
        case 'datastoreGet': return { result: DEMO_LIBRARY };
        case 'getModal': case 'getGeo': return { result: null };
        default: return { result: {} };
    }
};

const freePort = () => new Promise((resolve) => { const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

const startStub = async () => {
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            if (req.method === 'OPTIONS') { res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*'); res.end(); return; }
            const url = req.url.split('?')[0];
            if (url === '/addon/manifest.json') { json(res, ADDON_MANIFEST()); return; }
            const catalog = url.match(/^\/addon\/catalog\/(movie|series)\/top(?:\/.*)?\.json$/);
            if (catalog) { json(res, { metas: DEMO_METAS(catalog[1]) }); return; }
            json(res, stremioReply(url.replace(/^\/api\//, ''), raw));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    stubPort = server.address().port;
    return server;
};

const startApp = async (stubPort, extraEnv = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
    const port = await freePort();
    const child = spawn('node', [path.join(ROOT, 'http_server.js')], {
        cwd: ROOT, stdio: 'ignore',
        env: {
            ...process.env, PORT: String(port), SESSION_SECRET: 'e'.repeat(40), ADMIN_TOKEN: ADMIN,
            STREMIO_API_URL: `http://127.0.0.1:${stubPort}`, SUPPORT_EMAIL: 'support@example.com',
            USERS_FILE: path.join(dir, 'u.json'), BILLING_FILE: path.join(dir, 'b.json'),
            STATS_FILE: path.join(dir, 's.json'), AUDIT_FILE: path.join(dir, 'a.log'),
            SETTINGS_FILE: path.join(dir, 'settings.json'), PLANS_FILE: path.join(dir, 'plans.json'), ...extraEnv
        }
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i += 1) {
        if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    const stop = async () => { const done = new Promise((r) => child.once('exit', r)); child.kill(); await done; fs.rmSync(dir, { recursive: true, force: true }); };
    return { base, stop };
};

const admin = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` }, body: JSON.stringify(body) });

const newPage = async (browser, width = 1280, height = 800) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: Number(process.env.E2E_SCALE || 1) });
    // The Stremio core talks to the real api.strem.io from the browser; answer those calls with the stub and
    // block every other external host so runs are offline and repeatable. (One handler: later routes win.)
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (/^(api|link)\.strem\.io$/.test(url.hostname)) {
            return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(stremioReply(url.pathname.replace(/^\/api\//, ''), request.postData())) });
        }
        return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('  pageerror:', e.message));
    if (process.env.E2E_DEBUG) { context.on('request', (r) => { if (/strem/.test(r.url())) console.log('  ->', r.method(), r.url(), (r.postData() || '').slice(0, 120).replace(/"password":"[^"]*"/, '"password":"***"')); }); context.on('requestfailed', (r) => console.log('  xx', r.url(), r.failure() && r.failure().errorText)); }
    return page;
};

const shot = async (page, name) => { await page.waitForTimeout(1200); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log('  saved', name); };

const login = async (page, base) => {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Log in', { timeout: 30000 });
    // The intro shows sign-up first; "Log in" switches the form, and the same button then submits it.
    await page.getByText('Log in', { exact: true }).click();
    await page.waitForSelector('text=Forgot password?');
    await page.fill('input[type=email]', 'demo@example.com');
    await page.fill('input[type=password]', 'demo-password');
    await page.getByText('Log in', { exact: true }).click();
};

const dismissBanners = async (page) => {
    for (const label of ["Don't show again", 'Later']) {
        await page.getByText(label, { exact: true }).first().click({ timeout: 1500 }).catch(() => {});
    }
    await page.locator('[class*=toast] [class*=close], [class*=toast] svg').first().click({ timeout: 800 }).catch(() => {});
};

// Minimal Stripe double: only POST /v1/prices, enough to show creating a price from the panel with the real SDK.
const startFakeStripe = async () => {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(req.method === 'POST' && req.url === '/v1/prices' ? { id: `price_e2e${Date.now()}`, object: 'price' } : { error: { message: 'not mocked' } }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
};

const paywallEnv = {
    PAYWALL_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_e2e', STRIPE_WEBHOOK_SECRET: 'whsec_e2e', PUBLIC_URL: 'http://localhost',
    PLANS: JSON.stringify([{ id: 'solo', name: 'Solo', priceId: 'price_solo', seats: 0, description: 'Just you', priceLabel: '$9 / month' }, { id: 'family', name: 'Family', priceId: 'price_family', seats: 4, description: 'You plus 4 people', priceLabel: '$19 / month' }])
};

const CROWD = ['anna', 'annabel', 'bob', 'carla', 'dave', 'elena', 'farid', 'gianna', 'hana', 'ivan', 'joanna', 'kenji', 'lucia', 'mateo', 'nina', 'omar', 'priya', 'quinn', 'rosa', 'stefan'];

const scenarios = {
    // The same app after the operator has renamed it and uploaded their own logo and icons (all from the dashboard's API).
    async brand(ctx) {
        const app = await startApp(ctx.stub, {});
        try {
            const auth = { authorization: `Bearer ${ADMIN}` };
            await fetch(`${app.base}/admin/settings`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
                body: JSON.stringify({ productName: 'Acme TV', tagline: 'Everything you watch, in one place', loginHeadline: 'Your whole night in', loginSubtitle: 'Movies, series and live TV from every source, in one app' }) });
            for (const slot of ['logo', 'symbol', 'icon']) {
                const response = await fetch(`${app.base}/admin/brand/${slot}`, { method: 'PUT', headers: { ...auth, 'content-type': 'image/png' }, body: fs.readFileSync(path.join(__dirname, '..', 'demo', 'brand', `${slot}.png`)) });
                if (!response.ok) throw new Error(`brand upload ${slot} failed: ${response.status}`);
            }
            const page = await newPage(ctx.browser);
            await page.goto(`${app.base}/`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('text=Your whole night in', { timeout: 30000 });
            console.log(`  tab title: ${await page.title()}`);
            await shot(page, '18-branded-login');
            const home = await newPage(ctx.browser);
            await login(home, app.base);
            await home.waitForSelector('text=Search or paste link', { timeout: 30000 });
            await home.waitForTimeout(1500);
            await shot(home, '19-branded-app');
            const panel = await newPage(ctx.browser);
            await panel.goto(`${app.base}/operator/#/settings`, { waitUntil: 'domcontentloaded' });
            await panel.locator('#token').fill(ADMIN);
            await panel.locator('#load').click();
            await panel.waitForSelector('#brand .brand-card');
            await panel.waitForTimeout(800);
            await shot(panel, '20-operator-logo-and-icons');
        } finally { await app.stop(); }
    },
    async intro(ctx) {
        const page = await newPage(ctx.browser);
        await page.goto(`${ctx.open.base}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('text=Log in', { timeout: 30000 });
        await shot(page, '01-login-only-intro');
        await page.getByText('Log in', { exact: true }).click();
        await shot(page, '02-login-form');
    },
    async app(ctx) {
        const page = await newPage(ctx.browser);
        await login(page, ctx.open.base);
        await page.waitForSelector('text=Search or paste link', { timeout: 30000 });
        await page.getByText('Popular').first().waitFor({ timeout: 20000 }).catch(() => console.log('  home catalogs did NOT render'));
        await dismissBanners(page);
        await shot(page, '03-app-after-login-no-paywall');
    },
    async library(ctx) {
        const page = await newPage(ctx.browser);
        await login(page, ctx.open.base);
        await page.waitForSelector('text=Search or paste link', { timeout: 30000 });
        await page.goto(`${ctx.open.base}/#/library`, { waitUntil: 'domcontentloaded' });
        await page.getByText('Demo Movie One').first().waitFor({ timeout: 20000 }).catch(() => console.log('  library items did NOT render'));
        await dismissBanners(page);
        await shot(page, '08-library');
    },
    async paywall(ctx) {
        const fakeStripe = await startFakeStripe();
        const app = await startApp(ctx.stub, { ...paywallEnv, STRIPE_MOCK_URL: `http://127.0.0.1:${fakeStripe.address().port}` });
        try {
            // The operator adds a third plan from the dashboard while the app is running: no restart.
            const panel = await newPage(ctx.browser, 1280, 1000);
            await panel.goto(`${app.base}/operator/#/plans`, { waitUntil: 'domcontentloaded' });
            await panel.locator('#token').fill(ADMIN);
            await panel.locator('#load').click();
            await panel.waitForSelector('text=Family (family)', { timeout: 15000 });
            await panel.locator('#planId').fill('team');
            await panel.locator('#planName').fill('Team');
            await panel.locator('#planSeats').fill('10');
            await panel.locator('#planDescription').fill('Your whole household or office');
            // The Stripe price is created from the panel (fake Stripe here), which also fills the price text.
            await panel.locator('#priceAmount').fill('49');
            await panel.locator('#priceCreate').click();
            await panel.waitForFunction(() => document.getElementById('planStripe').value.startsWith('price_'), null, { timeout: 10000 });
            await panel.locator('#planSave').click();
            await panel.waitForSelector('text=Team (team)', { timeout: 15000 });
            await shot(panel, '11-operator-plans');
            // Branding set in the dashboard shows on the paywall without a rebuild or restart.
            await fetch(`${app.base}/admin/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
                body: JSON.stringify({ productName: 'Acme TV', tagline: 'Everything you watch, in one place', termsUrl: 'https://acme-tv.example/terms', privacyUrl: 'https://acme-tv.example/privacy' }) });
            const page = await newPage(ctx.browser);
            await login(page, app.base);
            await page.waitForSelector('text=Team', { timeout: 30000 });
            await shot(page, '04-paywall-plans');
            // Operator gives complimentary access: the next heartbeat or reload lets the person in.
            await admin(app.base, '/admin/grants', { email: 'demo@example.com', note: 'e2e demo' });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForSelector('text=Search or paste link', { timeout: 30000 });
            await dismissBanners(page);
            await page.goto(`${app.base}/#/settings`, { waitUntil: 'domcontentloaded' });
            await page.getByText('Subscription', { exact: true }).first().click({ timeout: 15000 }).catch(() => {});
            await shot(page, '05-settings-subscription');
        } finally { await app.stop(); fakeStripe.close(); }
    },
    async blocked(ctx) {
        const app = await startApp(ctx.stub);
        try {
            const page = await newPage(ctx.browser);
            await admin(app.base, '/admin/ban', { email: 'demo@example.com', note: 'e2e' });
            await login(page, app.base);
            await page.waitForSelector('text=support@example.com', { timeout: 30000 }).catch(() => {});
            await shot(page, '06-blocked-account');
        } finally { await app.stop(); }
    },
    async operator(ctx) {
        // Seed one session so the panel has a row, then open the panel with the token.
        const page0 = await newPage(ctx.browser);
        await login(page0, ctx.open.base);
        await page0.waitForSelector('text=Search or paste link', { timeout: 30000 });
        const crowd = CROWD;
        for (const name of crowd) {
            await fetch(`${ctx.open.base}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey: `seed-${name}` }) });
        }
        const page = await newPage(ctx.browser, 1280, 1100);
        await page.goto(`${ctx.open.base}/operator/`, { waitUntil: 'domcontentloaded' });
        await page.locator('#token').fill(ADMIN);
        await page.locator('#load').click();
        await page.waitForSelector('text=online of', { timeout: 15000 }).catch(() => {});
        await shot(page, '07-operator-panel');
        // Health and setup lives on the Overview page.
        await page.screenshot({ path: path.join(OUT, '13-operator-health.png'), fullPage: true });
        console.log('  saved 13-operator-health');
        // Jump box: find a person from anywhere.
        await page.locator('#jump').fill('farid');
        await page.waitForSelector('#jumpResults a', { timeout: 5000 });
        await shot(page, '17-operator-jump-search');
        await page.locator('#jump').fill('');
        await page.keyboard.press('Escape');
        // Each section is its own page, reached from the side navigation.
        await page.locator('#nav a[data-nav=people]').click();
        await page.locator('#userSearch').fill('ann');
        await page.waitForSelector('text=Showing 1-4 of 4', { timeout: 10000 }).catch(() => console.log('  search result text not found'));
        await page.waitForTimeout(1000);
        await shot(page, '12-operator-people-search');
        await page.locator('#users a', { hasText: 'anna@example.com' }).first().click();
        await page.waitForSelector('#personAccess', { state: 'visible' });
        await page.locator('#personNote').fill('Pays by bank transfer every January. Asked for an invoice with VAT number.');
        await page.locator('#personNoteSave').click();
        await page.waitForSelector('text=Note saved', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(800);
        await shot(page, '16-operator-person');
        await page.locator('#nav a[data-nav=people]').click();
        await page.locator('#nav a[data-nav=statistics]').click();
        await shot(page, '14-operator-statistics');
        await page.locator('#nav a[data-nav=content]').click();
        await shot(page, '15-operator-content-playback');
        await page.locator('#nav a[data-nav=settings]').click();
        // Change the support email and product name from the dashboard, then show the blocked screen using it live.
        await page.locator('#setting-supportEmail').fill('help@acme-tv.example');
        await page.locator('#setting-productName').fill('Acme TV');
        await page.locator('#setting-tagline').fill('Everything you watch, in one place');
        await page.getByText('Save settings').click();
        await page.waitForSelector('text=Settings saved', { timeout: 10000 }).catch(() => {});
        await shot(page, '09-operator-settings');
        await admin(ctx.open.base, '/admin/ban', { email: 'demo@example.com', note: 'e2e' });
        const blockedPage = await newPage(ctx.browser);
        await login(blockedPage, ctx.open.base);
        await blockedPage.waitForSelector('text=help@acme-tv.example', { timeout: 20000 }).catch(() => console.log('  live support email NOT shown'));
        await shot(blockedPage, '10-blocked-live-support-email');
    }
};

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const stubServer = await startStub();
    const stub = stubServer.address().port;
    // The shared app starts with 30 days of demo history for the crowd below, so the dashboard charts are not empty.
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-seed-'));
    const seedFile = path.join(seedDir, 'stats.json');
    require('../demo/seed-stats').seedStats(seedFile, CROWD.map((name) => `u-seed-${name}`));
    const open = await startApp(stub, { STATS_FILE: seedFile });
    const browser = await chromium.launch();
    try {
        for (const [name, fn] of Object.entries(scenarios)) {
            if (only && only !== name) continue;
            console.log(name);
            await fn({ browser, stub, open });
        }
    } finally {
        await browser.close(); await open.stop(); stubServer.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
