#!/usr/bin/env node

require('dotenv').config();

// Copyright (C) 2017-2023 Smart code 203358507

const ASSETS_CACHE = 2629744;
const HTTP_PORT = Number(process.env.PORT) || 8080;
const SHUTDOWN_TIMEOUT_MS = 10000;
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const path = require('path');
const { createAuth } = require('./server/auth');
const { createAccounts } = require('./server/accounts');
const { createCalendar } = require('./server/calendar');
const { configFor } = require('./server/announcement');
const { createTrakt } = require('./server/trakt');
const { createBilling } = require('./server/billing');
const { createSecrets } = require('./server/secrets');
const { createAudit } = require('./server/audit');
const { createSettings } = require('./server/settings');
const { createAddons } = require('./server/addons');
const { createBrand, renderIndex, renderManifest } = require('./server/brand');
const { createPlans } = require('./server/plans');
const { createTtlCache } = require('./server/ttlCache');
const { createHealth } = require('./server/health');
const { createStats } = require('./server/stats');
const { createMailer } = require('./server/mailer');
const { originGuard, securityHeaders, jsonErrorHandler } = require('./server/security');

const build_path = path.resolve(__dirname, 'build');
const index_path = path.join(build_path, 'index.html');

const intFromEnv = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

let secret = process.env.SESSION_SECRET;
if (typeof secret !== 'string' || secret.length < 32) {
    if (process.env.NODE_ENV === 'production') {
        console.error('SESSION_SECRET (32+ chars) is required in production');
        process.exit(1);
    }
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET not set: using a random secret, sessions reset on restart');
}

// Paywall: an account is gated whenever a plan is on offer, or when PAYWALL_ENABLED=true. Stripe keys may come from
// the environment or the operator dashboard (server/secrets.js); if neither is set, checkout is simply unavailable.
const paywallEnabled = process.env.PAYWALL_ENABLED === 'true';
if (paywallEnabled && !process.env.STRIPE_SECRET_KEY && !process.env.PUBLIC_URL) {
    console.error('PAYWALL_ENABLED=true but PUBLIC_URL is not set: set it so payment links and the webhook can reach this server');
    process.exit(1);
}

// PLANS (optional JSON): [{"id":"solo","name":"Solo","priceId":"price_..","seats":0,"description":".."}]
let plans = null;
if (process.env.PLANS) {
    try {
        plans = JSON.parse(process.env.PLANS);
        const valid = Array.isArray(plans) && plans.length > 0 && new Set(plans.map((plan) => plan && plan.id)).size === plans.length &&
            plans.every((plan) => plan && /^[\w-]{1,40}$/.test(plan.id) && typeof plan.name === 'string' && plan.name &&
                typeof plan.priceId === 'string' && plan.priceId && Number.isInteger(plan.seats) && plan.seats >= 0 && plan.seats <= 50);
        if (!valid) throw new Error('each plan needs a unique id, name, priceId and an integer seats (0-50)');
    } catch (e) {
        console.error(`PLANS is invalid: ${e.message}`);
        process.exit(1);
    }
}

const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
let publicOrigin = null;
if (publicUrl) {
    try {
        publicOrigin = new URL(publicUrl).origin;
    } catch (_e) {
        console.error(`PUBLIC_URL is not a valid URL: ${publicUrl}`);
        process.exit(1);
    }
}

const cookieSecure = process.env.COOKIE_SECURE === 'true';
if (process.env.NODE_ENV === 'production' && !cookieSecure) {
    console.warn('COOKIE_SECURE is not "true": session cookies will be sent over plain HTTP. Set it when serving over HTTPS.');
}

const audit = createAudit(process.env.AUDIT_FILE || path.resolve(__dirname, 'data', 'audit.log'));
// Plans live in a store the operator edits from the dashboard; PLANS only seeds an empty store.
// STRIPE_MOCK_URL (e.g. http://127.0.0.1:12111) points the Stripe SDK at stripe-mock or a test double; never set it in production.
const stripeMock = process.env.STRIPE_MOCK_URL ? new URL(process.env.STRIPE_MOCK_URL) : null;
// Stripe keys come from the environment (bootstrap default) or from the operator dashboard (server/secrets.js, overrides
// env). stripeClient and billing are (re)built by rebuildPayments() below, and again whenever the operator saves keys.
let stripeClient = null;
const secrets = createSecrets({
    dataFile: process.env.SECRETS_FILE || path.resolve(__dirname, 'data', 'secrets.json'),
    audit,
    onChange: () => rebuildPayments()
});
const planStore = createPlans({
    dataFile: process.env.PLANS_FILE || path.resolve(__dirname, 'data', 'plans.json'), seed: plans, audit,
    // Uses whichever Stripe client is current, so a plan's price can be created right after the operator adds keys.
    createPrice: async ({ name, currency, interval, unitAmount }) => {
        if (!stripeClient) throw new Error('stripe_unavailable');
        return (await stripeClient.prices.create({ currency, unit_amount: unitAmount, recurring: { interval }, product_data: { name } })).id;
    },
    canCreatePrice: () => Boolean(stripeClient)
});

// Operator-editable settings (D31). Environment values are the defaults; the dashboard overrides them live.
const settings = createSettings({
    dataFile: process.env.SETTINGS_FILE || path.resolve(__dirname, 'data', 'settings.json'),
    defaults: { supportEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.SUPPORT_EMAIL || '') ? process.env.SUPPORT_EMAIL : '' },
    audit
});
const addons = createAddons({
    dataFile: process.env.ADDONS_FILE || path.resolve(__dirname, 'data', 'addons.json'),
    defaults: { enableMoviebox2: 'false', enableHouseofmaster: 'true', hiddenAddonUrls: '' },
    audit
});

// Usage statistics (logins, activity, player-reported watch time). WATCH_STATS=false turns the collection off.
let authRef = null;
const stats = createStats({
    dataFile: process.env.STATS_FILE || path.resolve(__dirname, 'data', 'stats.json'),
    enabled: process.env.WATCH_STATS !== 'false',
    listUsers: () => authRef.store.list()
});

const ownAccounts = process.env.OWN_ACCOUNTS === 'true';
let accounts = null;
let trakt = null;
let resetMailer = null;
// Resolved lazily: billing is created after auth but auth reports entitlements.
let billing = null;
const auth = createAuth({
    secret,
    stremioApiUrl: process.env.STREMIO_API_URL || 'https://api.strem.io',
    verifyKey: ownAccounts ? async (authKey) => accounts.lookup(authKey) : null,
    onErase: ownAccounts ? (email) => accounts.eraseByEmail(email) : null,
    // Every registered account, so the operator's People list shows sign-ups that never opened a session.
    accountsList: ownAccounts ? () => accounts.listAll() : null,
    adminToken: process.env.ADMIN_TOKEN || null,
    dataFile: process.env.USERS_FILE || path.resolve(__dirname, 'data', 'users.json'),
    cookieSecure,
    maxDevices: intFromEnv('MAX_DEVICES', 0, { min: 0, max: 20 }),
    audit,
    stats,
    supportEmail: () => settings.get().supportEmail,
    entitlementFor: (user) => billing.entitlementFor(user),
    onSignout: ownAccounts ? (email) => accounts.revokeKeys(email) : null // ban/signout must kill the app's own authKeys
});
authRef = auth;

// Optional invite emails: both variables are needed, and the invite link points at PUBLIC_URL
const confirmInvites = process.env.INVITE_CONFIRM === 'true';
let sendInviteEmail = null;
let sendNotice = null;
if (process.env.RESEND_API_KEY && process.env.MAIL_FROM && publicUrl) {
    const mailer = createMailer({ apiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM, publicUrl, productName: () => settings.get().productName });
    sendInviteEmail = (details) => mailer.sendInvite(details);
    sendNotice = (details) => mailer.sendNotice(details);
    resetMailer = (details) => mailer.sendReset(details);
} else if (process.env.RESEND_API_KEY || process.env.MAIL_FROM) {
    console.warn('Invite emails are disabled: RESEND_API_KEY, MAIL_FROM and PUBLIC_URL must all be set');
}

// Our own account service (OWN_ACCOUNTS=true): the sign-up, sign-in, library and add-on storage the browser app normally gets
// from api.strem.io. Cinemeta and other add-ons stay public services; only the people and their data live here.
accounts = ownAccounts ? createAccounts({
    publicUrl,
    productName: () => settings.get().productName,
    sendResetEmail: resetMailer,
    dataFile: process.env.ACCOUNTS_FILE || path.resolve(__dirname, 'data', 'accounts.db'),
    audit,
    registrationOpen: () => settings.get().registration !== 'closed',
    defaultAddonUrls: () => {
        // The operator's list may be one-per-line or comma-separated; accept both, keep only http(s) manifest
        // addresses, and fall back to the standard catalogs when none are valid so a new account is never empty.
        const own = settings.get().defaultAddons;
        const parsed = String(own || '').split(/[\n,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
        return parsed.length ? parsed : ['https://v3-cinemeta.strem.io/manifest.json', 'https://opensubtitles-v3.strem.io/manifest.json'];
    }
}) : null;

// A blocked account's key must stop working on the native app (which never carries the cookie session).
if (ownAccounts) accounts.setBlockChecker((email) => auth.isBanned(email));


if (confirmInvites && sendInviteEmail === null) {
    console.error('INVITE_CONFIRM=true needs invite emails: set RESEND_API_KEY, MAIL_FROM and PUBLIC_URL (otherwise nobody could ever confirm)');
    process.exit(1);
}

// Builds the Stripe client from the environment or the operator's saved keys. Called at startup and again whenever
// the operator saves/clears payment keys (no restart needed). Billing is created once and reads the Stripe client,
// the paywall switch and the webhook secret live through getters, so every route always uses the current config.
function rebuildPayments() {
    const secretKey = process.env.STRIPE_SECRET_KEY || secrets.get().stripeSecretKey;
    stripeClient = secretKey ? new (require('stripe'))(secretKey, stripeMock ? {
        host: stripeMock.hostname, port: Number(stripeMock.port), protocol: stripeMock.protocol.replace(':', '')
    } : undefined) : null;
}
rebuildPayments();

billing = createBilling({
    stripe: () => stripeClient,
    enabled: () => Boolean(stripeClient),
    priceId: process.env.STRIPE_PRICE_ID,
    plans: () => planStore.list(),
    webhookSecret: () => process.env.STRIPE_WEBHOOK_SECRET || secrets.get().stripeWebhookSecret,
    publicUrl,
    maxInvites: intFromEnv('INVITE_SEATS', 2, { min: 1, max: 50 }),
    pastDueGraceMs: intFromEnv('PAST_DUE_GRACE_DAYS', 3, { min: 0, max: 30 }) * 24 * 60 * 60 * 1000,
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,
    sendInviteEmail,
    confirmInvites,
    sendNotice,
    inviteExpiryMs: intFromEnv('INVITE_EXPIRY_DAYS', 30, { min: 0, max: 365 }) * 24 * 60 * 60 * 1000,
    dataFile: process.env.BILLING_FILE || path.resolve(__dirname, 'data', 'billing.json'),
    audit,
    automaticTax: process.env.STRIPE_AUTOMATIC_TAX === 'true',
    // Dev/test: "Pay on web" opens a local test page (reachable on the LAN) whose button unlocks the account.
    // The account is encoded in the URL PATH (not the query string) so it survives being opened in a browser.
    mockCheckout: stripeMock ? (user, plan) => `${publicUrl}/mock-checkout/${encodeURIComponent(user.id + '.' + plan.id)}` : null,
    requireSession: auth.requireSession,
    adminGuard: auth.adminGuard
});

// The household's shared profile list is stored under the owner's account, so every member's device reads and writes the
// same list (the whole family's profiles stay in step). Billing knows who the owner is for any caller.
if (ownAccounts && billing && typeof accounts.setHouseholdResolver === 'function') {
    accounts.setHouseholdResolver((user) => billing.householdOwnerId(user));
}

// Fail fast if the data directory is not writable: a paid webhook could otherwise never be recorded.
if (!(auth.store.flush() && billing.flush() && stats.flush() && settings.flush() && secrets.flush() && planStore.flush()) && process.env.NODE_ENV === 'production') {
    console.error('Data files are not writable (check USERS_FILE / BILLING_FILE and the volume permissions)');
    process.exit(1);
}

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
    // e.g. TRUST_PROXY=1 when running behind nginx / a load balancer
    app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
} else {
    let warned = false;
    app.use((req, _res, next) => {
        if (!warned && req.headers['x-forwarded-for']) {
            warned = true;
            console.warn('Requests carry X-Forwarded-For but TRUST_PROXY is not set: every client looks like the proxy IP. Set TRUST_PROXY=1 behind one reverse proxy.');
        }
        next();
    });
}

app.use(securityHeaders({ hsts: cookieSecure }));

// For load balancers / uptime checks / Docker HEALTHCHECK
app.get('/healthz', (_req, res) => {
    res.set('cache-control', 'no-store');
    // 503 while the last disk write failed, so an orchestrator can restart/alert instead of silently losing paid events
    const storage = auth.store.isHealthy() && billing.isHealthy() && stats.isHealthy();
    res.status(storage ? 200 : 503).json({ ok: storage, storage, uptime: Math.round(process.uptime()) });
});

// Stripe webhook. It needs the raw body for signature verification, so it is registered before any JSON parser, and
// it is always present (Stripe must reach it the moment keys are saved in the dashboard). It delegates to the current
// billing, which verifies with the current webhook secret and links the payment to the paying account.
app.post('/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    if (!billing || !stripeClient) {
        res.status(503).json({ error: 'billing_not_configured' });
        return;
    }
    billing.webhook(req, res);
});

// Operator panel: static files only, it holds no data and every call it makes needs ADMIN_TOKEN.
app.use('/operator', (_req, res, next) => {
    res.set('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.set('cache-control', 'no-store');
    next();
}, express.static(path.join(__dirname, 'server', 'operator')));

app.use(['/auth', '/billing'], originGuard(publicOrigin ? [publicOrigin] : []));
app.use('/auth', auth.router);
app.use('/auth', stats.router(auth.requireSession));

// "Download my data": the signed-in person's own records, as a JSON file (no erasure: that stays an operator action)
app.get('/auth/my-data', auth.requireSession, (req, res) => {
    res.set('cache-control', 'no-store');
    res.set('content-disposition', 'attachment; filename="my-data.json"');
    res.json({
        exportedAt: new Date().toISOString(),
        account: auth.exportEmail(req.session.email),
        billing: billing.exportEmail(req.session.email)
    });
});
app.use('/billing', billing.router);

// Dev/test only (STRIPE_MOCK_URL set): a local checkout page so "Pay on web" works end to end without a real Stripe
// account. It is served by THIS server, so the phone can reach it, and its button unlocks the account at once.
if (stripeMock) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const page = (plan, userId) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Test checkout</title><style>body{font-family:system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}` +
        `h1{font-size:1.4rem}.card{border:1px solid #ddd;border-radius:12px;padding:1.2rem;margin:1.2rem 0}.price{font-size:1.6rem;font-weight:700}` +
        `button{font:inherit;font-size:1.1rem;background:#635bff;color:#fff;border:0;border-radius:10px;padding:.9rem 1.2rem;width:100%;cursor:pointer}` +
        `.muted{color:#666;font-size:.9rem}#msg{margin-top:1rem}</style></head><body>` +
        `<h1>Test checkout</h1><p class="muted">This is a local test page (no real payment is taken). In production this is Stripe's hosted checkout.</p>` +
        `<div class="card"><div><b>${esc(plan.name)}</b>${plan.description ? ` — ${esc(plan.description)}` : ''}</div>` +
        `<div class="price">${esc(plan.priceLabel || '')}</div></div>` +
        `<button id="pay">Pay (test) — unlock</button><div id="msg" class="muted"></div>` +
        `<script>document.getElementById('pay').onclick=async function(){this.disabled=true;this.textContent='Processing…';` +
        `try{const r=await fetch('/mock-checkout/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:${JSON.stringify(userId)},planId:${JSON.stringify(plan.id)}})});` +
        `const j=await r.json();if(!r.ok||!j.ok){throw new Error(j.error||'failed');}` +
        `document.getElementById('msg').textContent='Payment complete (test). Your account is unlocked — go back to Alder and play again.';this.textContent='Paid ✓';` +
        `}catch(e){document.getElementById('msg').textContent='Could not complete: '+e.message;this.disabled=false;this.textContent='Try again';}};<\/script>` +
        `</body></html>`;
    // The Pay button posts here (JSON), using the account embedded in the page.
    app.post('/mock-checkout/complete', express.json({ limit: '4kb' }), (req, res) => {
        console.log('[mock-checkout] complete', req.body && req.body.userId, req.body && req.body.planId);
        const userId = req.body && req.body.userId;
        const planId = req.body && req.body.planId;
        if (typeof userId !== 'string' || !userId) { res.status(400).json({ ok: false, error: 'invalid_user' }); return; }
        const result = billing.mockActivate(userId, typeof planId === 'string' ? planId : undefined);
        res.status(result.ok ? 200 : 400).json(result);
    });
    // Bare page (no account): tell the user to open it from the app's "Pay on web" button.
    app.get('/mock-checkout', (_req, res) => {
        res.set('content-type', 'text/html; charset=utf-8');
        res.end('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">' +
            '<body style="font-family:system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem">' +
            '<h1>Test checkout</h1><p>Open this page from Alder: start a movie, tap <b>Pay on web</b>, then tap Pay here. ' +
            'Opening the address by hand has no account to unlock.</p></body>');
    });
    // Account page: the id is encoded in the path, e.g. /mock-checkout/<userId>.<planId>
    app.get('/mock-checkout/:token', (req, res) => {
        const token = req.params.token || '';
        const dot = token.indexOf('.');
        const userId = dot > 0 ? token.slice(0, dot) : token;
        const planId = dot > 0 ? token.slice(dot + 1) : '';
        console.log('[mock-checkout] page userId=', userId, 'planId=', planId);
        const plan = planStore.list().find((p) => p.id === planId);
        if (!userId || !plan) { res.status(400).send('Missing user or plan'); return; }
        res.set('cache-control', 'no-store');
        res.set('content-type', 'text/html; charset=utf-8');
        res.end(page(plan, userId));
    });
}
app.get('/config', (_req, res) => res.set('cache-control', 'no-store')
    .json({ ...configFor(settings.get()), settings: settings.publicConfig(), addons: addons.publicConfig() }));
const brand = createBrand({ dir: process.env.BRAND_DIR || path.resolve(__dirname, 'data', 'brand'), audit });
app.use('/admin/brand', brand.adminRouter(auth.adminGuard));
// Paywall status for account-key clients (Alder, mobile): they have no cookie session, so the signed-in identity comes
// from their own account key (accounts.lookup) — the same id billing keys owners by — and a payment made on the web for
// that account is reported here. Registered before the accounts API so it is not swallowed by POST /api/:name.
if (accounts) {
    app.post('/api/billingStatus', express.json({ limit: '4kb' }), (req, res) => {
        res.set('cache-control', 'no-store');
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) {
            res.json({ error: { message: 'Session expired', code: 1 } });
            return;
        }
        res.json({ result: billing.statusFor(user) });
    });
    // "Pay on web" for an account-key client: create a Stripe Checkout Session for this account and hand back its URL,
    // so the browser goes straight to payment (the auth key never leaves the app / enters a URL). The payment is linked
    // to the account by client_reference_id, exactly like the cookie flow.
    app.post('/api/billingCheckout', express.json({ limit: '4kb' }), async (req, res) => {
        res.set('cache-control', 'no-store');
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) {
            res.json({ error: { message: 'Session expired', code: 1 } });
            return;
        }
        try {
            const out = await billing.startCheckout(user, req.body && req.body.planId);
            console.log('[billingCheckout] user=', user && user.id, '-> url=', out.url || ('error:' + out.error));
            res.json({ result: out.url ? { url: out.url } : { error: out.error } });
        } catch (e) {
            console.error('Stripe checkout failed:', e.message);
            res.json({ result: { error: 'stripe_unavailable' } });
        }
    });
    // Family-plan sharing for account-key clients: the signed-in account is the owner (or a member) of a shared plan.
    // household reports the group and seat usage; the invite endpoints let an owner/manager invite, remove or change the
    // role of the people who share their plan. Same rules as the cookie routes; the app shows them on the TV / phone.
    const inviteResult = (res, out) => res.json({ result: out && out.error ? { ok: false, error: out.error, max: out.max } : out });
    app.post('/api/billingHousehold', express.json({ limit: '4kb' }), (req, res) => {
        res.set('cache-control', 'no-store');
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        res.json({ result: billing.householdFor(user) });
    });
    app.post('/api/billingInvites', express.json({ limit: '4kb' }), (req, res) => {
        res.set('cache-control', 'no-store');
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        inviteResult(res, billing.accountInviteList(user));
    });
    app.post('/api/billingInviteCreate', express.json({ limit: '4kb' }), async (req, res) => {
        res.set('cache-control', 'no-store');
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        const body = req.body || {};
        inviteResult(res, await billing.accountInviteCreate(user, { email: body.email, role: body.role }));
    });
    app.post('/api/billingInviteRemove', express.json({ limit: '4kb' }), (req, res) => {
        res.set('cache-control', 'no-store');
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        inviteResult(res, billing.accountInviteRemove(user, (req.body || {}).email));
    });
    app.post('/api/billingInviteRole', express.json({ limit: '4kb' }), (req, res) => {
        res.set('cache-control', 'no-store');
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        const body = req.body || {};
        inviteResult(res, billing.accountInviteRole(user, body.email, body.role));
    });
    app.post('/api/billingInviteUpdate', express.json({ limit: '4kb' }), (req, res) => {
        res.set('cache-control', 'no-store');
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        const body = req.body || {};
        inviteResult(res, billing.accountInviteUpdate(user, body.email, { name: body.name, color: body.color }));
    });
    app.post('/api/billingInviteResend', express.json({ limit: '4kb' }), async (req, res) => {
        res.set('cache-control', 'no-store');
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        inviteResult(res, await billing.accountInviteResend(user, (req.body || {}).email));
    });
    app.post('/api/billingInviteTransfer', express.json({ limit: '4kb' }), (req, res) => {
        res.set('cache-control', 'no-store');
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        inviteResult(res, billing.accountInviteTransfer(user, (req.body || {}).email));
    });
    app.post('/api/billingLeave', express.json({ limit: '4kb' }), (req, res) => {
        res.set('cache-control', 'no-store');
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        inviteResult(res, billing.accountLeave(user));
    });
}

// Playback reports from the native app, which has no cookie session: authenticated by the Stremio authKey instead.
// Feeds the same usage stats the web player reports through /auth/activity.
app.post('/api/statsActivity', express.json({ limit: '2kb' }), (req, res) => {
    res.set('cache-control', 'no-store');
    const body = req.body || {};
    const authKey = typeof body.authKey === 'string' ? body.authKey : '';
    const user = authKey && accounts ? accounts.lookup(authKey) : null;
    const clean = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    if (user && stats) {
        const type = clean(body.type, 30) || 'unknown';
        const contentId = clean(body.id, 120);
        const source = clean(body.source, 40) || null;
        const addon = /^[a-z0-9.-]{1,100}$/i.test(body.addon || '') ? String(body.addon).toLowerCase() : null;
        // A previously-blocked viewer who is now entitled counts as a conversion (they saw the modal, then upgraded).
        const noteConversion = () => {
            if (!billing || !stats.hasSeenUpgrade(user.id)) return;
            const ent = billing.entitlementFor(user);
            if (ent && ent.active) stats.markUpgradeConverted(user.id);
        };
        if (body.event === 'upgrade_shown') {
            stats.recordUpgradeSeen(user.id);
            noteConversion();
        } else if (body.event === 'error') {
            stats.recordError(user.id, { code: clean(body.code, 40) || 'unknown', critical: body.critical === true, type, contentId, source, addon });
        } else {
            const seconds = Number(body.seconds);
            if (Number.isFinite(seconds) && seconds > 0) {
                stats.recordWatch(user.id, {
                    seconds: Math.min(Math.round(seconds), 36000), type, contentId,
                    title: clean(body.title, 200), start: body.start === true,
                    source, addon, completed: body.completed === true
                });
                noteConversion();
            }
        }
    }
    res.status(204).end();
});
if (accounts) {
    app.use('/api/v2', accounts.linkRouter); // apps that point their link address at <base>/api/ (Alder) land here
    app.use('/api', accounts.router);
    app.use('/account', accounts.pageRouter);
    app.use('/likes', accounts.ratingsRouter);
    app.use('/v2', accounts.linkRouter);
    app.use('/data-export', accounts.exportRouter);
    app.use('/admin/accounts', accounts.adminRouter(auth.adminGuard));
    // Trakt (optional): needs a Trakt API app, see docs/ACCOUNTS_API.md
    trakt = createTrakt({ api: process.env.TRAKT_API_URL || undefined, site: process.env.TRAKT_SITE_URL || undefined, clientId: process.env.TRAKT_CLIENT_ID || '', clientSecret: process.env.TRAKT_CLIENT_SECRET || '', publicUrl: publicOrigin || '', accounts, productName: () => settings.get().productName });
    accounts.attachTrakt(trakt);
    app.use('/trakt', trakt.router);
    // "You are leaving" page for links the app does not trust (replaces the stock site's /warning)
    app.get('/warning', (_req, res) => {
        res.set({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'" });
        res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Leaving</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c0b11;color:#f2f2f5;font:16px system-ui,sans-serif}main{width:min(420px,90vw)}h1{font-size:22px}
p{color:#a9a8b3;line-height:1.5;word-break:break-all}a{display:block;text-align:center;padding:14px;border-radius:12px;background:#f2f2f5;color:#0c0b11;font-weight:600;text-decoration:none;margin-top:16px}</style></head><body><main>
<h1>You are leaving this app</h1><p>This link goes to another website. Only continue if you trust it:</p><p id="u"></p><a id="go" rel="noopener noreferrer" hidden>Continue</a><p id="bad" hidden>This link cannot be opened.</p>
<script>try{var t=decodeURIComponent(location.hash.slice(1)),x=new URL(t);if(x.protocol!=='https:'&&x.protocol!=='http:')throw 0;u.textContent=x.href;go.href=x.href;go.hidden=false}catch(e){document.getElementById('bad').hidden=false}</script></main></body></html>`);
    });
    // Calendar feed of upcoming episodes: the secret address is the only credential, so keep it out of caches and referrers
    const calendar = createCalendar({ seriesFor: accounts.calendarSeries, productName: () => settings.get().productName, host: publicOrigin ? new URL(publicOrigin).host : 'localhost' });
    app.get('/calendar/:file', async (req, res) => {
        const match = /^([A-Za-z0-9_-]{20,100})\.ics$/.exec(req.params.file);
        const text = match ? await calendar.feed(match[1]).catch(() => null) : null;
        if (text === null) { res.status(404).type('text').send('Not found'); return; }
        res.set({ 'cache-control': 'private, max-age=900', 'referrer-policy': 'no-referrer', 'content-disposition': 'inline; filename="episodes.ics"' }).type('text/calendar; charset=utf-8').send(text);
    });
}
app.use('/admin/settings', settings.adminRouter(auth.adminGuard));
app.use('/admin/plans', planStore.adminRouter(auth.adminGuard));
app.use('/admin/payments', secrets.adminRouter(auth.adminGuard));
app.use('/admin/addons', addons.adminRouter(auth.adminGuard));
app.use('/admin', auth.admin);
app.use('/admin', billing.admin);
// One person: profile fields, recent sign-in times and watch totals
app.get('/admin/stats/user', auth.adminGuard, (req, res) => {
    res.set('cache-control', 'no-store');
    const matches = auth.store.findByEmail(req.query.email);
    if (matches.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
    }
    res.json({
        users: matches.map((user) => ({
            email: user.email, firstSeen: user.firstSeen, lastSeen: user.lastSeen, logins: user.logins, note: user.note || '',
            ...stats.userDetail(user.id)
        }))
    });
});

const statsCache = createTtlCache(30000);
const dataFiles = {
    users: process.env.USERS_FILE || path.resolve(__dirname, 'data', 'users.json'),
    billing: process.env.BILLING_FILE || path.resolve(__dirname, 'data', 'billing.json'),
    stats: process.env.STATS_FILE || path.resolve(__dirname, 'data', 'stats.json')
};
const health = createHealth({
    files: dataFiles,
    storageHealthy: () => auth.store.isHealthy() && billing.isHealthy() && stats.isHealthy(),
    lastWebhookAt: () => billing.lastWebhookAt(),
    plans: () => planStore.list().filter((plan) => !plan.archived),
    settings: () => settings.get(),
    mailConfigured: sendInviteEmail !== null,
    trakt: () => !!(trakt && trakt.enabled),
    accounts: accounts ? () => {
        try { return { healthy: true, count: accounts.count() }; } catch (_e) { return { healthy: false, count: 0 }; }
    } : null,
    // The paywall is effectively on when it is forced by env, when a plan is on offer, or when Stripe is configured.
    paywallEnabled: paywallEnabled || Boolean(stripeClient) || planStore.list().some((plan) => !plan.archived),
    version: require('./package.json').version
});
app.get('/admin/health', auth.adminGuard, (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json(health.report());
});

app.get('/admin/stats', auth.adminGuard, (req, res) => {
    res.set('cache-control', 'no-store');
    const days = Math.min(120, Math.max(1, Number(req.query.days) || 30));
    // Walking every user is slow at scale (about 1.4 s for 100,000 users), so reuse the result for 30 s; ?fresh=1 skips it.
    const summary = statsCache.get(days, () => stats.summary(days, (user) => {
        try {
            return billing.entitlementFor({ id: user.id, email: user.email }).role;
        } catch (_e) {
            return null;
        }
    }), { fresh: req.query.fresh === '1' });
    if (req.query.format !== 'csv') {
        res.json(summary);
        return;
    }
    // Daily series for spreadsheets (all values are numbers or ISO dates: nothing user-controlled)
    const header = 'day,new_users,logins,active_users,watching_users,hours_watched';
    const rows = summary.daily.map((d) => [d.day, d.newUsers, d.logins, d.activeUsers, d.watchers, d.hoursWatched].join(','));
    res.set('content-type', 'text/csv; charset=utf-8');
    res.set('content-disposition', 'attachment; filename="stats.csv"');
    res.send([header, ...rows].join('\n') + '\n');
});
app.use(['/auth', '/billing', '/admin', '/config'], (_req, res) => {
    res.status(404).json({ error: 'not_found' });
});

// The built page and manifest are rewritten on the way out with the operator's name; uploaded logos answer the stock image addresses.
const readFresh = (() => {
    const cache = new Map();
    return (file) => {
        const mtime = fs.statSync(file).mtimeMs;
        const hit = cache.get(file);
        if (hit && hit.mtime === mtime) return hit.text;
        const text = fs.readFileSync(file, 'utf8');
        cache.set(file, { mtime, text });
        return text;
    };
})();
// With own accounts and no name set yet, the app calls itself by the address it is served from, never by another company's name
const withDefaultName = (config, req) => (accounts && !config.productName ? { ...config, productName: publicOrigin ? new URL(publicOrigin).host : String(req.hostname || 'this site') } : config);
app.get(['/', '/index.html'], (req, res, next) => {
    try {
        res.set('cache-control', 'no-cache');
        res.type('html').send(renderIndex(readFresh(index_path), { ...withDefaultName(settings.publicConfig(), req), ...(accounts ? { ownAccounts: true, trakt: !!(trakt && trakt.enabled) } : {}) }));
    } catch (_e) {
        next(); // no build yet: fall through to the static handler and its 404
    }
});
app.get('/manifest.json', (req, res, next) => {
    try {
        res.set('cache-control', 'no-cache');
        res.type('application/manifest+json').send(JSON.stringify(renderManifest(JSON.parse(readFresh(path.join(build_path, 'manifest.json'))), withDefaultName(settings.publicConfig(), req))));
    } catch (_e) {
        next();
    }
});
app.use(brand.middleware);
app.use(express.static(build_path, {
    setHeaders: (res, path) => {
        // index.html must revalidate so a deploy (new paywall/client code) is picked up immediately; hashed assets may be cached.
        if (path === index_path) res.set('cache-control', 'no-cache');
        else res.set('cache-control', `public, max-age=${ASSETS_CACHE}`);
    }
}));

app.all('*', (_req, res) => {
    // TODO: better 404 page
    res.status(404).send('<h1>404! Page not found</h1>');
});

app.use(jsonErrorHandler);

const server = app.listen(HTTP_PORT, () => console.info(`Server listening on port: ${HTTP_PORT}`));
// Slow or stalled clients must not pin sockets (slowloris); keep-alive slightly above typical proxy idle timeouts.
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 65000;

// Catch up on anything Stripe told us while we were down (no-op until Stripe is configured)
{
    const startupReconcile = setTimeout(() => {
        billing.reconcile().catch((e) => console.error('Reconcile failed:', e));
    }, 5000);
    startupReconcile.unref();
}

let shuttingDown = false;
const shutdown = (reason, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Shutting down (${reason})`);
    const force = setTimeout(() => process.exit(exitCode || 1), SHUTDOWN_TIMEOUT_MS);
    force.unref();
    server.close(() => {
        auth.store.flush();
        billing.flush();
        stats.flush();
        settings.flush();
        planStore.flush();
        process.exit(exitCode);
    });
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    shutdown('uncaughtException', 1);
});
