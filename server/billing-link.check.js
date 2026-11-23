'use strict';

// Proves a Stripe payment is linked to the account that paid, and that an account-key client (Alder/mobile,
// which has no cookie session) sees its own entitlement and nobody else's. Run with: pnpm run test:server

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');
const Stripe = require('stripe');
const { createAuth } = require('./auth');
const { createAccounts } = require('./accounts');
const { createBilling } = require('./billing');
const { createAudit } = require('./audit');

const WEBHOOK_SECRET = 'whsec_test_secret';
const consent = { tos: true, privacy: true, marketing: false, from: 'web' };

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const setup = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billink-'));
    const audit = createAudit();

    // Our own accounts: the account id a key resolves to is the id billing keys owners by.
    const accounts = createAccounts({ dataFile: path.join(dir, 'accounts.db'), audit });
    const stripe = new Stripe('sk_test_123');
    stripe.checkout.sessions.create = async (params) => ({ url: 'https://checkout.stripe.test/session', params });
    stripe.billingPortal.sessions.create = async () => ({ url: 'https://portal.stripe.test/x' });
    stripe.subscriptions.update = async () => ({});

    let billing = null;
    const auth = createAuth({
        secret: 'x'.repeat(40),
        verifyKey: (authKey) => accounts.lookup(authKey), // login resolves identity through the account store
        entitlementFor: (user) => billing.entitlementFor(user),
        dataFile: path.join(dir, 'users.json'),
        audit
    });
    billing = createBilling({
        stripe,
        enabled: true,
        plans: () => [{ id: 'family', name: 'Family', priceId: 'price_family', seats: 2, priceLabel: '$9 / month' }],
        webhookSecret: WEBHOOK_SECRET,
        publicUrl: 'https://example.test',
        dataFile: path.join(dir, 'billing.json'),
        audit,
        sendInviteEmail: async () => {}, // a no-op mailer so invite emails (create/resend) are "sent"
        requireSession: auth.requireSession,
        adminGuard: auth.adminGuard
    });

    const app = express();
    app.post('/billing/webhook', express.raw({ type: 'application/json' }), billing.webhook);
    app.use('/auth', auth.router);
    app.use('/billing', billing.router);
    // The endpoint http_server.js exposes for account-key clients (mirrored here so the test does not boot the full server).
    app.post('/api/billingStatus', express.json({ limit: '4kb' }), (req, res) => {
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        res.json({ result: billing.statusFor(user) });
    });
    app.get('/paid', billing.requireEntitlement, (req, res) => res.json({ ok: true, role: req.entitlement.role }));
    const inviteResult = (res, out) => res.json({ result: out && out.error ? { ok: false, error: out.error, max: out.max } : out });
    app.post('/api/billingHousehold', express.json({ limit: '4kb' }), (req, res) => {
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        res.json({ result: billing.householdFor(user) });
    });
    app.post('/api/billingInvites', express.json({ limit: '4kb' }), (req, res) => {
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        inviteResult(res, billing.accountInviteList(user));
    });
    app.post('/api/billingInviteCreate', express.json({ limit: '4kb' }), async (req, res) => {
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        const body = req.body || {};
        inviteResult(res, await billing.accountInviteCreate(user, { email: body.email, role: body.role }));
    });
    app.post('/api/billingInviteRemove', express.json({ limit: '4kb' }), (req, res) => {
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        inviteResult(res, billing.accountInviteRemove(user, (req.body || {}).email));
    });
    app.post('/api/billingInviteRole', express.json({ limit: '4kb' }), (req, res) => {
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        const body = req.body || {};
        inviteResult(res, billing.accountInviteRole(user, body.email, body.role));
    });
    app.post('/api/billingInviteUpdate', express.json({ limit: '4kb' }), (req, res) => {
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        const body = req.body || {};
        inviteResult(res, billing.accountInviteUpdate(user, body.email, { name: body.name, color: body.color }));
    });
    app.post('/api/billingInviteResend', express.json({ limit: '4kb' }), async (req, res) => {
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        inviteResult(res, await billing.accountInviteResend(user, (req.body || {}).email));
    });
    app.post('/api/billingInviteTransfer', express.json({ limit: '4kb' }), (req, res) => {
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        inviteResult(res, billing.accountInviteTransfer(user, (req.body || {}).email));
    });
    app.post('/api/billingLeave', express.json({ limit: '4kb' }), (req, res) => {
        const user = accounts.lookup(req.body && req.body.authKey);
        if (!user) { res.json({ error: { message: 'Session expired', code: 1 } }); return; }
        inviteResult(res, billing.accountLeave(user));
    });

    const server = http.createServer(app);
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    const signup = async (email) => (await accounts.handlers.register({ email, password: 'password1', gdpr_consent: consent }, {})).result;
    const login = async (authKey) => {
        const response = await fetch(`${base}/auth/session`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey })
        });
        return { cookie: (response.headers.get('set-cookie') || '').split(';')[0], body: await response.json() };
    };
    const status = (authKey) => fetch(`${base}/api/billingStatus`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey })
    }).then((r) => r.json());
    // Account-key family sharing (the endpoints http_server.js exposes; mirrored here).
    const call = (route, authKey, extra = {}) => fetch(`${base}/api/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authKey, ...extra })
    }).then((r) => r.json());
    let eventCounter = 0;
    const sendEvent = (type, object, created = Math.floor(Date.now() / 1000)) => {
        const payload = JSON.stringify({ id: `evt_${++eventCounter}`, object: 'event', type, created, data: { object } });
        const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
        return fetch(`${base}/billing/webhook`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload
        }).then((r) => r.json());
    };
    const subscription = (userId, overrides = {}) => ({
        id: 'sub_1', customer: 'cus_1', status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        metadata: { userId }, ...overrides
    });

    const close = () => {
        server.close();
        billing.flush();
        auth.store.flush();
        accounts.close(); // close the account db so its files can be removed
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    };
    return { base, accounts, signup, login, status, call, sendEvent, subscription, close };
};

test('a payment made on the web is linked to the paying account and visible to its own auth key only', async (t) => {
    const s = await setup();
    t.after(s.close);

    // Two separate accounts, each with its own key.
    const alice = await s.signup('alice@example.com');
    const bob = await s.signup('bob@example.com');
    const aliceId = s.accounts.lookup(alice.authKey).id;
    const bobId = s.accounts.lookup(bob.authKey).id;
    assert.notEqual(aliceId, bobId);

    // Before paying, neither key is entitled.
    assert.equal((await s.status(alice.authKey)).result.entitlement.active, false);
    assert.equal((await s.status(alice.authKey)).result.entitlement.role, 'none');
    assert.equal((await s.status('not-a-real-key')).error.code, 1);

    // Alice starts checkout from a browser (cookie session), then her card is charged: Stripe reports it.
    const session = await s.login(alice.authKey);
    assert.equal(session.body.entitlement.active, false);
    await s.sendEvent('customer.subscription.created', s.subscription(aliceId));

    // The payment is now linked to Alice's account: her auth key (on the phone) sees owner + active.
    const aliceStatus = (await s.status(alice.authKey)).result;
    assert.equal(aliceStatus.paywallEnabled, true);
    assert.equal(aliceStatus.entitlement.active, true);
    assert.equal(aliceStatus.entitlement.role, 'owner');
    assert.deepEqual(aliceStatus.plans.map((p) => p.id), ['family']);
    assert.equal(aliceStatus.webUrl, 'https://example.test');
    assert.equal(JSON.stringify(aliceStatus.plans).includes('price_'), false, 'price ids never leave the server');

    // Bob did not pay: his key stays locked even though Alice's did.
    const bobStatus = (await s.status(bob.authKey)).result;
    assert.equal(bobStatus.entitlement.active, false);
    assert.equal(bobStatus.entitlement.role, 'none');

    // The web cookie and the phone key resolve to the same account id, so they cannot diverge.
    assert.equal(session.body.user.id, aliceId);
});

// Family sharing over the account-key endpoints: an owner invites by email, a member joins and sees who shared, and
// only an owner (not a member) can appoint a manager or remove someone. Mirrors the cookie rules on /billing/invites.
test('account-key family sharing: invite, roles and seat list', async (t) => {
    const s = await setup();
    t.after(() => s.close());
    const { accounts } = s;

    const alice = await s.signup('alice-house@example.test');
    const bob = await s.signup('bob-house@example.test');
    const carol = await s.signup('carol-house@example.test');
    const aliceId = (await accounts.lookup(alice.authKey)).id;

    // Activate Alice's owner plan through the Stripe mock (same path the browser uses).
    await s.sendEvent('customer.subscription.created', s.subscription(aliceId));

    // Owner sees her household: owner role, seats from the plan, no invites yet.
    const household = (await s.call('billingHousehold', alice.authKey)).result;
    assert.equal(household.role, 'owner');
    assert.equal(household.canManage, true);
    assert.equal(household.seats > 1, true, 'family plan has seats to share');
    assert.deepEqual(household.members, []);

    // Invite Bob by email: server records a pending invite in Alice's seat list.
    const created = (await s.call('billingInviteCreate', alice.authKey, { email: 'bob-house@example.test' })).result;
    assert.equal(created.ok, true);
    const bobInvite = created.invites.find((m) => m.email === 'bob-house@example.test');
    assert.equal(bobInvite !== undefined, true, 'Bob is now a pending invite');
    assert.equal(bobInvite.acceptedAt, null, 'Bob has not joined yet');

    // The owner's household view reflects the pending invite too.
    const afterInvite = (await s.call('billingHousehold', alice.authKey)).result;
    assert.equal(afterInvite.members.some((m) => m.email === 'bob-house@example.test' && m.joined === false), true);

    // Duplicate invite is rejected (no second seat consumed).
    const dup = (await s.call('billingInviteCreate', alice.authKey, { email: 'bob-house@example.test' })).result;
    assert.equal(dup.ok, false);
    assert.equal(dup.error, 'already_invited');

    // A non-owner member cannot invite: Bob has not accepted, so he is not a manager.
    const bobInvite2 = (await s.call('billingInviteCreate', bob.authKey, { email: 'carol-house@example.test' })).result;
    assert.equal(bobInvite2.ok, false);

    // Owner promotes Bob's pending invite to manager, then back down to member.
    const promoted = (await s.call('billingInviteRole', alice.authKey, { email: 'bob-house@example.test', role: 'manager' })).result;
    assert.equal(promoted.ok, true);
    assert.equal(promoted.invites.find((m) => m.email === 'bob-house@example.test').role, 'manager');
    const demoted = (await s.call('billingInviteRole', alice.authKey, { email: 'bob-house@example.test', role: 'member' })).result;
    assert.equal(demoted.ok, true);
    assert.equal(demoted.invites.find((m) => m.email === 'bob-house@example.test').role, 'member');

    // Remove Bob's invite: it disappears from the seat list.
    const removed = (await s.call('billingInviteRemove', alice.authKey, { email: 'bob-house@example.test' })).result;
    assert.equal(removed.ok, true);
    assert.equal(removed.invites.some((m) => m.email === 'bob-house@example.test'), false);

    // Unknown auth key is refused at the door, never reaching billing.
    assert.equal((await s.call('billingHousehold', 'not-a-real-key')).error.code, 1);
});

// The remaining account-key management: resend a pending invite, transfer ownership to a joined member, and leave.
test('account-key family sharing: resend, transfer and leave', async (t) => {
    const s = await setup();
    t.after(() => s.close());
    const { accounts } = s;

    const alice = await s.signup('alice-house2@example.test');
    const bob = await s.signup('bob-house2@example.test');
    const aliceId = (await accounts.lookup(alice.authKey)).id;
    await s.sendEvent('customer.subscription.created', s.subscription(aliceId));

    // Invite Bob (pending) and resend: resend only works while still pending.
    await s.call('billingInviteCreate', alice.authKey, { email: 'bob-house2@example.test' });
    const resent = (await s.call('billingInviteResend', alice.authKey, { email: 'bob-house2@example.test' })).result;
    assert.equal(resent.ok, true);

    // Bob's own status call accepts the invite (lazy acceptance), making him a joined member.
    await s.status(bob.authKey);
    const bobHouse = (await s.call('billingHousehold', bob.authKey)).result;
    assert.equal(bobHouse.role, 'member');
    assert.equal(bobHouse.sharedBy, 'alice-house2@example.test');

    // Resending a joined member's invite is refused.
    const resent2 = (await s.call('billingInviteResend', alice.authKey, { email: 'bob-house2@example.test' })).result;
    assert.equal(resent2.ok, false);
    assert.equal(resent2.error, 'already_joined');

    // Transfer ownership to Bob (owner only, and he must be joined). Alice stays on as a manager.
    const transferred = (await s.call('billingInviteTransfer', alice.authKey, { email: 'bob-house2@example.test' })).result;
    assert.equal(transferred.ok, true);
    const bobOwner = (await s.call('billingHousehold', bob.authKey)).result;
    assert.equal(bobOwner.role, 'owner');
    const aliceMember = (await s.call('billingHousehold', alice.authKey)).result;
    assert.equal(aliceMember.role, 'member');
    assert.equal(aliceMember.memberRole, 'manager', 'the previous owner stays on as a manager');

    // A non-owner cannot transfer: Alice (now a manager, not owner) is refused.
    assert.equal((await s.call('billingInviteTransfer', alice.authKey, { email: 'bob-house2@example.test' })).result.ok, false);

    // Alice leaves the plan she was transferred into; her seat is removed.
    const left = (await s.call('billingLeave', alice.authKey)).result;
    assert.equal(left.ok, true);
    assert.equal((await s.call('billingHousehold', bob.authKey)).result.members.some((m) => m.email === 'alice-house2@example.test'), false);
});